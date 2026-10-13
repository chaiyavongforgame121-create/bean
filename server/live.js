// LiveLayer — a SIMULATED exchange where "bots" mirror beans with real-looking bookkeeping.
//
// Nothing here talks to a real venue: these are PAPER trades. Fills are computed locally from the market price
// (with real prices, that is the real Hyperliquid mid — still never a real order). The layer talks to the
// engine only through (the optional members are feature-detected, so a minimal engine double still works):
//   engine.population.row(id)     → BeanRow (side, units, equity, coin, leverage, position_size, busted)
//   engine.market.mid(coin)       → last BAR close (tick reconciliation mirrors at the bean's price)
//   engine.market.livePx?(coin)   → live mid ≤ 15 s old, else the last close (out-of-tick fills and marks)
//   engine.market.coinInfo(coin)  → { max_leverage, sz_decimals } | null (unlisted)
//   engine.market.timeMs          → market time of the last bar
//   engine.market.clockMs?()      → stamp of an out-of-tick fill (real: wall clock; sim: market time)
//   engine.market.tickTimeMs?()   → stamp of a tick/replay fill (real: the bar close; sim: market time)
//   engine.market.isStale?(coin)  → the coin's price is not live: its bots are FROZEN (no mirror, no liquidation)
//   engine.canOpen?(coin)         → reason new exposure must wait (prices down, catching up, stale coin) | null
//   engine.prices                 → 'real' | 'sim'
// main.js registers `afterTick` as an engine onTick hook, `markLive` as an onMarks hook (every ~5 s with real
// prices: marks + liquidation on the live mid) and `venue` as the population venue hook.
//
// Mirror rule (SPEC §2.6): target_sz = bean.side × floor_to(|bean.units| × capital/1000, sz_decimals).
// When |target − szi| × mid ≥ min_order_usd (or target is 0 while holding) the bot takes an IOC fill at
// mid ± 1.5 bp paying a 4.5 bp taker fee. Crossing zero (a flip) is one order and two fills. The notional
// cap only gates new exposure: if it blocks a flip's opening leg, the closing leg still executes.
//
// Liquidation (our addition, same model as the paper beans in population.js): once mid crosses
// liquidation_px the venue takes the position at that price and the bot loses its WHOLE initial margin
// (closed_pnl = −margin, no taker fee — the last 5 % is the venue's liquidation penalty), then it pauses.
//
// Clocks: lifecycle stamps (created/updated/closed/reconcile/error/halted/as_of/mark) are wall-clock ms so the
// UI can show "updated 4 s ago". Fill/order `time_ms`: real prices → wall clock for out-of-tick fills and the
// bar close for tick/replay fills (so replayed fills are recognisably old); sim → market time (lines up with
// bean trades).
//
// ---- Accounts mode (PLATFORM §7.1) ----------------------------------------------------------------------------
// One LiveLayer is one player's GARDEN. Everything below is opt-in through constructor options; with none of them
// (none mode, every existing test) every code path, payload, event and the JSON state are exactly as before.
//   owner   {uid, username}: the garden's player. Requires `journal` to be that player's facade
//           (journal.forUser(uid): scoped, uid-bound) — anything else THROWS (fail-closed isolation, §7.1 #7).
//   repo    GardenRepo (server/garden/repo.js): write-through persistence of the garden row, bots, fills, orders.
//           Reads of fills/orders come from the DB (the in-memory rings keep only `logKeep` records).
//   testnet TestnetVenue (server/garden/testnet-venue.js): bots with venue 'testnet' trade real IOC orders on
//           Hyperliquid TESTNET through it. Without it `venue:'testnet'` is refused (503 testnet_disabled).
// Paper bots keep the SPEC §2.6 semantics bit for bit (#mirror/#execute/#fill/#liquidate/#mark run only for
// paper). Testnet bots are driven by the venue: it plans targets, reconciles against the exchange on the
// player's serial lane, and reports back through the callbacks applyExchangeFill, confirmFills,
// applyExchangeSnapshot, applyTestnetAccount, setSync, orderUpdate, exchangeError, flattenDone,
// pauseFromExchange, closeConfirmed and closeInBooks. Aggregates are split by venue: the existing ledger keys
// describe PAPER only; the testnet ledger is the exchange's account plus our per-bot attribution.
// Accounts mode also persists the halt (lifted by rearm(), §8.4) and keeps paper SEASONS (resetSeason(), §7.6).
//
// REPLAY GUARD (accounts mode): the `gardens` row's last_tick is a WATERMARK — every bar up to it is reflected in the
// garden's rows (gardenFields() writes the engine's current tick, never an older one). With cloud persistence on an
// ephemeral host (server/cloudsync.js) the DB can be restored NEWER than the engine state next to it (DB every
// minute, engine state hourly): the restored engine then replays bars this garden already mirrored. A garden loaded
// with last_tick ahead of a RESTORED engine skips afterTick for every tick ≤ that watermark (marks, mirror and
// liquidation all happened before the restart); the first newer bar reconciles as usual. Bars between the last
// write and the DB snapshot are no-ops on replay (no fill happened in them, and the replay is deterministic). A
// fresh engine (no restore) or a gap above REPLAY_GUARD_MAX_BARS never arms the guard.

import { RingBuffer } from './journal.js';

/** The replay guard (accounts mode) arms only when the stored watermark is at most this many bars ahead of the engine. */
export const REPLAY_GUARD_MAX_BARS = 2880;

/** Paper capital of every bean; bot size = bean size × capital_usd / CAPITAL_PER_BEAN. */
export const CAPITAL_PER_BEAN = 1000;

/** Defaults for the LiveLayer `config` (SPEC §2.6). */
export const LIVE_DEFAULTS = Object.freeze({
  accountUsd: 10_000,
  maxBots: 10,
  maxBotCapitalUsd: 1000,
  minCapitalUsd: 20,
  maxTotalNotionalUsd: 10_000,
  minOrderUsd: 10,
});

/** Simulated execution costs: taker pays spread + impact on price and a fee on notional. */
export const SIM_COSTS = Object.freeze({ spread: 0.0001, impact: 0.00005, takerFee: 0.00045 });

/** Isolated-margin liquidation once the adverse move reaches 95 % of 1/leverage (same as paper beans). */
export const LIQUIDATION_FRACTION = 0.95;

/** Fill and order logs keep this many records each. */
export const LOG_KEEP = 2000;

/** Why a bean cannot be bound right now (`venue_reason`). 'halted' is our addition for the kill switch. */
export const VENUE_REASONS = Object.freeze(['unlisted', 'busted', 'bean_bound', 'coin_bound', 'leverage', 'halted']);

/** Accounts mode: in-memory fill/order ring size per garden (the DB holds the rest, PLATFORM §7.1). */
export const ACCOUNTS_LOG_KEEP = 200;

/** Testnet caps per player (PLATFORM §7.3); admin-adjustable. */
export const TESTNET_CAP_DEFAULTS = Object.freeze({
  maxBots: 3,
  minCapitalUsd: 20,
  maxBotCapitalUsd: 500,
  maxTotalNotionalUsd: 3000,
});

/** A burned field can be re-armed this long after the halt (PLATFORM §7.6). */
export const REARM_AFTER_MS = 60_000;
/** A paper season can be reset at most once per this window (PLATFORM §8.4). */
export const RESET_EVERY_MS = 24 * 60 * 60 * 1000;
/** Testnet commands await their first lane job this long before answering with the pending row (§6.11). */
export const COMMAND_AWAIT_MS = 8000;
/** Estimated taker fee of a provisional testnet fill (4.5 bp × notional, §6.11), replaced by the fills sweep. */
export const TESTNET_FEE_EST = 0.00045;

const SLIPPAGE = SIM_COSTS.spread + SIM_COSTS.impact;
const BOT_STATES = new Set(['active', 'paused', 'closed']);
const DETAIL_LOG_LIMIT = 200;
const FILL_STATES = new Set(['in_sync', 'partial', 'unfilled', 'waiting_bean']);
/** Paper error situations → the published machine code of their `live_error` (accounts mode, §8.9). */
const PAPER_ERROR_CODES = Object.freeze({ notional_cap: 'caps', no_price: 'stale', plan_failed: 'conflict' });

/**
 * HTTP-mapped error: http.js turns it into `{ error, status }` with the same status code. Accounts mode adds a
 * machine `code` (PLATFORM §8.9) and sometimes extra fields (`retry_after_s`, `positions`, …): both are
 * additive, and none-mode errors carry neither, so their payloads are unchanged.
 */
export class ApiError extends Error {
  constructor(status, message, code = null, extra = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (code) this.code = code;
    if (extra && typeof extra === 'object') this.extra = extra;
  }

  toJSON() {
    const out = { error: this.message, status: this.status };
    if (this.code) out.code = this.code;
    if (this.extra) for (const [k, v] of Object.entries(this.extra)) if (!(k in out)) out[k] = v;
    return out;
  }
}

/**
 * Await `promise` for at most `ms`, then give up waiting (the work itself keeps running). Never rejects: the
 * command answers with the bot's current row either way; later progress arrives as events (J3).
 */
export async function awaitWithin(promise, ms) {
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve(promise).catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- small numeric helpers ---------------------------------------------------------------------

const isPrice = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;
const zeroNegZero = (x) => x + 0; // turns -0 into 0

/** Round to `d` decimals, normalising float noise and -0. */
function roundTo(x, d) {
  const f = 10 ** d;
  return zeroNegZero(Number((Math.round(x * f) / f).toFixed(d)));
}

/** Floor a non-negative size to `d` decimals, tolerating float noise like 4.4299999999. */
function floorTo(x, d) {
  const f = 10 ** d;
  return zeroNegZero(Number((Math.floor(x * f + 1e-9) / f).toFixed(d)));
}

/** Money: 6 decimals (matches the precision brood reports). */
const usd = (x) => roundTo(x, 6);

/** Prices: 10 significant digits (keeps sub-cent coins like PUMP precise). */
const px10 = (x) => (x == null || !Number.isFinite(x) ? null : zeroNegZero(Number(x.toPrecision(10))));

/** `limit` param of the log queries: integer 0..LOG_KEEP, default 100. */
function logLimit(limit) {
  const n = Number(limit);
  if (limit == null || limit === "" || !Number.isFinite(n)) return 100;
  return Math.min(LOG_KEEP, Math.max(0, Math.trunc(n)));
}

const botId = (index) => `bot-${String(index).padStart(4, '0')}`;

/** Positive finite number from config, else the default. */
function positive(value, dflt) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** A bot's venue: bots persisted before venues existed (and every none-mode bot) are paper. */
export const venueOf = (bot) => (bot?.venue === 'testnet' ? 'testnet' : 'paper');

/** `0x1234…abcd` (the only form of an address that admin views and live_status show, §5.4). */
export function truncAddr(addr) {
  return typeof addr === 'string' && addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr ?? null;
}

/** Leverage the bean's entries imply relative to its paper capital (what the venue must allow). */
export function requiredLeverage(row) {
  return ((Number(row.position_size) || 0) * (Number(row.leverage) || 0) * (Number(row.equity) || 0)) / CAPITAL_PER_BEAN;
}

/** Notional (USD) one entry of `row` would have for a bot with `capitalUsd` of water. */
export function entryNotional(row, capitalUsd) {
  return requiredLeverage(row) * capitalUsd;
}

/**
 * Notional (USD) a NEW bot on `row` opens right away: a positioned bean is mirrored at once from its
 * existing `units` (sized at the bean's entry equity), |units| × capital/1000 × px — not the next-entry size
 * of entryNotional(). A flat bean opens nothing now; its first entry is entryNotional(). (GAME-DESIGN §6.5)
 */
export function openingNotional(row, capitalUsd, px) {
  const units = Math.abs(Number(row?.units) || 0);
  if (beanSide(row) !== 0 && units > 0 && isPrice(px)) return (units * capitalUsd * px) / CAPITAL_PER_BEAN;
  return entryNotional(row, capitalUsd);
}

/** Bean direction −1/0/1 from a BeanRow (falls back to `in_position` text). */
export function beanSide(row) {
  if (Number.isFinite(row.side)) return Math.sign(row.side);
  if (row.in_position === 'long') return 1;
  if (row.in_position === 'short') return -1;
  return 0;
}

/** Isolated initial margin a bot's position has posted (|szi| × entry / leverage); 0 when flat. */
function initialMargin(bot) {
  const { szi, entry_px } = bot.real;
  return szi && isPrice(entry_px) && bot.leverage > 0 ? (Math.abs(szi) * entry_px) / bot.leverage : 0;
}

/** Isolated liquidation price of a position, or null when flat. */
function liquidationPx(szi, entryPx, leverage) {
  if (!szi || !isPrice(entryPx) || !(leverage > 0)) return null;
  return entryPx * (1 - (Math.sign(szi) * LIQUIDATION_FRACTION) / leverage);
}

/** Paper caps from a config object (camelCase) — the same defaults as the constructor. */
function paperCaps(config) {
  const c = config || {};
  return {
    accountUsd: positive(c.accountUsd, LIVE_DEFAULTS.accountUsd),
    maxBots: Math.floor(positive(c.maxBots, LIVE_DEFAULTS.maxBots)),
    maxBotCapitalUsd: positive(c.maxBotCapitalUsd, LIVE_DEFAULTS.maxBotCapitalUsd),
    minCapitalUsd: positive(c.minCapitalUsd, LIVE_DEFAULTS.minCapitalUsd),
    maxTotalNotionalUsd: positive(c.maxTotalNotionalUsd, LIVE_DEFAULTS.maxTotalNotionalUsd),
    minOrderUsd: positive(c.minOrderUsd, LIVE_DEFAULTS.minOrderUsd),
  };
}

/** Testnet caps (camelCase) with the §7.3 defaults. */
function testnetCapsOf(c) {
  const t = c || {};
  return {
    maxBots: Math.floor(positive(t.maxBots, TESTNET_CAP_DEFAULTS.maxBots)),
    minCapitalUsd: positive(t.minCapitalUsd, TESTNET_CAP_DEFAULTS.minCapitalUsd),
    maxBotCapitalUsd: positive(t.maxBotCapitalUsd, TESTNET_CAP_DEFAULTS.maxBotCapitalUsd),
    maxTotalNotionalUsd: positive(t.maxTotalNotionalUsd, TESTNET_CAP_DEFAULTS.maxTotalNotionalUsd),
  };
}

// ---- the layer -----------------------------------------------------------------------------------

export class LiveLayer {
  /**
   * @param {object} opts
   * @param {object} [opts.config]  { accountUsd, maxBots, maxBotCapitalUsd, minCapitalUsd, maxTotalNotionalUsd, minOrderUsd }
   * @param {object} opts.engine    see file header for the members used
   * @param {object} [opts.journal] Journal (emit) — optional; with `owner`, REQUIRED to be journal.forUser(owner.uid)
   * @param {() => number} [opts.now] wall clock (injectable for tests)
   * @param {object} [opts.owner]   accounts mode: { uid, username }
   * @param {object} [opts.repo]    accounts mode: GardenRepo (write-through persistence)
   * @param {object} [opts.testnet] accounts mode: this player's TestnetVenue (null → testnet refused)
   * @param {number} [opts.logKeep] in-memory fill/order ring size (accounts mode: ACCOUNTS_LOG_KEEP)
   * @param {object} [opts.testnetCaps] { maxBots, minCapitalUsd, maxBotCapitalUsd, maxTotalNotionalUsd }
   * @param {object} [opts.garden]  accounts mode: the `gardens` row (season, halt, next index, …)
   * @param {object} [opts.hooks]   accounts mode: { changed(garden) } — open-bot membership changed (Gardens)
   */
  constructor({
    config, engine, journal = null, now = Date.now, log = console.warn,
    owner = null, repo = null, testnet = null, logKeep = LOG_KEEP, testnetCaps = null, garden = null, hooks = null,
    paperOnlyAggregates = true,
  } = {}) {
    if (!engine) throw new TypeError('LiveLayer needs an engine');
    config = config || {};
    if (owner !== null && owner !== undefined) {
      // Fail-closed isolation (PLATFORM §7.1 #7): a garden can only ever emit through ITS player's facade.
      if (!Number.isSafeInteger(owner.uid) || owner.uid < 0) throw new TypeError('LiveLayer owner needs a uid');
      if (!journal || journal.scoped !== true || journal.uid !== owner.uid || typeof journal.emit !== 'function') {
        throw new TypeError('LiveLayer with an owner needs journal.forUser(owner.uid) (a scoped, uid-bound facade)');
      }
    }
    this.engine = engine;
    this.journal = journal && typeof journal.emit === 'function' ? journal : { emit() {} };
    this.now = now;
    this.log = log;
    this.cfg = paperCaps(config);
    // Accounts mode (all null/false in none mode).
    this.owner = owner ? Object.freeze({ uid: owner.uid, username: owner.username ?? null }) : null;
    this.accounts = this.owner !== null;
    this.repo = this.accounts && repo ? repo : null;
    this.testnet = this.accounts && testnet ? testnet : null;
    this.tcfg = testnetCapsOf(testnetCaps);
    this.hooks = hooks && typeof hooks === 'object' ? hooks : null;
    this.paperOnlyAggregates = paperOnlyAggregates !== false; // accepted for §2.4 #3; aggregates are always split
    this.logKeep = Math.max(1, Math.min(LOG_KEEP, Math.trunc(Number(logKeep)) || LOG_KEEP));
    this.startedMs = this.now();
    this.#reset();
    if (this.accounts && garden) this.#loadGarden(garden);
    if (this.testnet && typeof this.testnet.attach === 'function') this.testnet.attach(this);
  }

  #reset() {
    this.botList = []; // every bot ever created, by index
    this.byId = new Map();
    this.openByBean = new Map(); // bean id → open (active|paused) bot
    this.openByCoin = new Map(); // coin → open bot
    this.fillLog = new RingBuffer(this.logKeep ?? LOG_KEEP);
    this.orderLog = new RingBuffer(this.logKeep ?? LOG_KEEP);
    this.fillsLogged = 0;
    this.nextIndex = 0;
    this.halted = false;
    this.haltedMs = null;
    this.lastError = null;
    this.lastErrorMs = null;
    this.lastErrorKey = null; // `${bot}|${situation}` behind lastError (see #setError)
    this.lastReconcileMs = null;
    this.lastTick = null;
    this.replayGuardTick = null; // accounts mode: ticks ≤ this were mirrored before a restart (see the file header)
    this.replaySkipped = 0;
    this.universeCoins = null;
    this.inTick = false;
    // accounts mode
    this.season = 1;
    this.seasonStartedMs = this.startedMs ?? null;
    this.lastResetMs = null;
    this.epoch = null;
    this.testnetAccountSnap = null;
  }

  // ---- engine hooks ------------------------------------------------------------------------------

  /** onTick hook: re-mirror every active bot, refresh marks of paused ones, auto-pause on bust. */
  afterTick(summary) {
    if (this.replayGuardTick !== null) {
      // Accounts mode: a bar this garden already mirrored before the restart (its DB is newer than the engine state).
      if (Number.isFinite(summary?.tick) && summary.tick <= this.replayGuardTick) {
        this.replaySkipped += 1;
        return;
      }
      if (this.replaySkipped > 0) {
        this.log(`[live] garden ${this.owner?.uid}: skipped ${this.replaySkipped} replayed bar(s) already mirrored before the restart`);
      }
      this.replayGuardTick = null;
    }
    if (Number.isFinite(summary?.tick)) this.lastTick = summary.tick;
    this.inTick = true; // prices = bar closes, fill stamps = tick time
    let testnetOpen = 0;
    try {
      for (const bot of this.botList) {
        if (bot.state === 'closed') continue;
        if (venueOf(bot) === 'testnet') {
          testnetOpen++;
          try {
            this.#planTestnet(bot);
          } catch (err) {
            this.#setError(bot, `plan failed: ${err?.message || err}`, 'plan_failed');
          }
          continue;
        }
        try {
          this.#reconcile(bot, 'tick');
        } catch (err) {
          this.#setError(bot, `reconcile failed: ${err?.message || err}`);
        }
      }
    } finally {
      this.inTick = false;
    }
    this.lastReconcileMs = this.now();
    // The account-level error line clears once every open bot is healthy again.
    if (this.lastError && !this.botList.some((b) => b.state !== 'closed' && b.last_error)) {
      this.lastError = null;
      this.lastErrorMs = null;
      this.lastErrorKey = null;
    }
    // Testnet bots cannot trade replayed bars (§6.11): one sync runs after the catch-up ends (Gardens).
    if (testnetOpen > 0 && this.testnet && !this.#replaying()) this.testnet.requestSync('tick');
    // The garden row changes per tick only through fills and errors; the tick/reconcile stamps alone are not worth a
    // write per garden per bar (they are refreshed whenever the row is written for another reason).
    if (this.repo && (this.fillsLogged !== this.persistedFills || this.lastError !== this.persistedError)) this.#persistGarden();
  }

  /** Population venue hook → { tradeable, venue_max_leverage, venue_reason, bot }. O(1). */
  venue(row) {
    if (!row) return { tradeable: false, venue_max_leverage: null, venue_reason: 'unlisted', bot: null };
    const info = this.#coinInfo(row.coin);
    const reason = this.#unavailableReason(row, info, null);
    const bound = this.openByBean.get(row.id);
    return {
      tradeable: reason === null,
      venue_max_leverage: info ? info.max_leverage : null,
      venue_reason: reason,
      bot: bound ? bound.id : null,
    };
  }

  /**
   * Live marks (engine onMarks hook; every ~5 s with real prices, and after every tick). For each open bot whose
   * coin is not stale: liquidation is checked against the LIVE price (a cross liquidates now, not at the next
   * bar), then the position is marked (mark_px, unrealized, margin, notional, as_of). Bots on a stale coin are
   * frozen: flagged `price_stale`, marks stay at the last real price.
   * Each mark is stamped with the time of the price behind it (`px_ms[coin]`, else `t`), never "now".
   * Testnet bots are marked at the TESTNET mid instead (an estimate; no local liquidation, §7.5).
   * @param {{px?: Object<string, number>, px_ms?: Object<string, number>, stale?: string[], t?: number}} marks
   */
  markLive({ px = {}, px_ms: pxMs = {}, stale = [], t } = {}) {
    const at = Number.isFinite(t) ? t : this.now();
    const staleSet = new Set(Array.isArray(stale) ? stale : []);
    for (const bot of this.botList) {
      if (bot.state === 'closed') continue;
      if (venueOf(bot) === 'testnet') {
        this.#markTestnet(bot);
        continue;
      }
      if (staleSet.has(bot.coin)) {
        bot.price_stale = true;
        continue;
      }
      const p = Number(px?.[bot.coin]);
      if (!isPrice(p)) continue;
      bot.price_stale = false;
      try {
        if (bot.state === 'active' && this.#liquidationHit(bot, p)) this.#liquidate(bot);
      } catch (err) {
        this.#setError(bot, `liquidation failed: ${err?.message || err}`);
      }
      const coinAt = Number(pxMs?.[bot.coin]);
      this.#mark(bot, p, Number.isFinite(coinAt) && coinAt > 0 ? coinAt : at);
    }
  }

  /**
   * The bot and account part of a `mids` pulse frame (GAME-DESIGN §10.7): open bots only. Accounts mode adds
   * `venue` (and `est` on testnet bots) per bot, and `testnet_account` (the testnet ledger) — this payload is
   * attached per subscriber by the SSE writer (Gardens.marksFor), never put in the shared frame (§7.5).
   */
  marksPayload() {
    const bots = {};
    for (const b of this.botList) {
      if (b.state === 'closed') continue;
      const r = b.real;
      const m = {
        szi: r.szi,
        entry_px: px10(r.entry_px),
        mark_px: px10(b.mark_px),
        unrealized_pnl: usd(r.unrealized_pnl),
        realized_pnl: usd(b.realized_pnl),
        margin_used: usd(r.margin_used),
        liquidation_px: px10(r.liquidation_px),
        notional_usd: usd(b.notional_usd),
        price_stale: this.#priceStale(b),
        as_of_ms: r.as_of_ms,
      };
      if (this.accounts) {
        m.venue = venueOf(b);
        if (m.venue === 'testnet') {
          m.est = r.szi ? (r.margin_est ? ['unrealized_pnl', 'margin_used'] : ['unrealized_pnl']) : null;
          m.funding = usd((b.funding_realized || 0) + (b.exchange?.funding_since_open || 0));
        }
      }
      bots[b.id] = m;
    }
    const a = this.#account();
    const out = {
      bots,
      account: {
        account_value: usd(a.accountValue),
        unrealized_pnl: usd(a.unrealized),
        realized_pnl: usd(a.realized),
        available_usd: usd(a.available),
        deployed_usd: usd(a.deployed),
        open_notional_usd: usd(a.notional),
      },
    };
    if (this.accounts) out.testnet_account = this.testnet ? this.#testnetLedgerMarks() : null;
    return out;
  }

  // ---- queries -----------------------------------------------------------------------------------

  /** live_status payload (SPEC §4) plus `account_usd` and `available_usd`; accounts mode adds §8.4 keys. */
  status() {
    const acct = this.#account();
    const counts = this.accounts ? this.#counts() : acct;
    const out = {
      mode: 'sim',
      network: 'sim',
      dry_run: false,
      armed: !this.halted,
      halted: this.halted,
      halted_ms: this.haltedMs,
      disabled_reason: this.halted
        ? (this.accounts ? 'halted by bots_halt — re-arm the field to plant again' : 'halted by bots_halt — restart to re-arm')
        : null,
      bots: this.accounts ? counts.total : this.botList.length,
      active: counts.active,
      paused: counts.paused,
      closed: counts.closed,
      deployed_usd: usd(acct.deployed),
      open_notional_usd: usd(acct.notional),
      realized_pnl: usd(acct.realized),
      unrealized_pnl: usd(acct.unrealized),
      last_reconcile_ms: this.lastReconcileMs,
      last_error: this.lastError,
      last_error_ms: this.lastErrorMs,
      fills_logged: this.fillsLogged,
      exchange_stops: false,
      caps: {
        max_bots: this.cfg.maxBots,
        max_bot_capital_usd: this.cfg.maxBotCapitalUsd,
        min_capital_usd: this.cfg.minCapitalUsd,
        max_total_notional_usd: this.cfg.maxTotalNotionalUsd,
      },
      account_state: {
        account_value: usd(acct.accountValue),
        withdrawable: usd(acct.accountValue - acct.margin),
        total_margin_used: usd(acct.margin),
        total_ntl_pos: usd(acct.notional),
        // The time of the OLDEST price behind these numbers (unrealized P&L is marked per open position), not
        // the request time: a request never makes minutes-old marks look fresh. No position → exact → now.
        as_of_ms: this.#marksAsOf(),
      },
      universe: { coins: this.#universeCount(), fetched_ms: this.startedMs },
      account_usd: this.cfg.accountUsd,
      available_usd: usd(acct.available),
      prices: this.#prices(),
      paper: true,
      stale_coins: this.#staleCoins(),
    };
    if (!this.accounts) return out;
    const now = this.now();
    out.user = { id: this.owner.uid, username: this.owner.username };
    out.rearm_after_ms = this.halted && Number.isFinite(this.haltedMs) ? this.haltedMs + REARM_AFTER_MS : null;
    out.season = this.season;
    out.season_started_ms = this.seasonStartedMs;
    out.reset_after_ms = Number.isFinite(this.lastResetMs) && this.lastResetMs + RESET_EVERY_MS > now
      ? this.lastResetMs + RESET_EVERY_MS : null;
    out.venues = {
      paper: {
        account_usd: this.cfg.accountUsd,
        account_value: usd(acct.accountValue),
        available_usd: usd(acct.available),
        deployed_usd: usd(acct.deployed),
        open_notional_usd: usd(acct.notional),
        realized_pnl: usd(acct.realized),
        unrealized_pnl: usd(acct.unrealized),
        bots_open: acct.active + acct.paused,
      },
      testnet: this.testnet ? this.#testnetLedger() : null,
    };
    return out;
  }

  /**
   * bots op: `state` = active|paused|closed|open (active+paused)|all (default). Ordered by index. Accounts mode
   * lists the current paper season (or `season`) plus every testnet bot.
   */
  bots({ state = null, season = null } = {}) {
    const want = state == null || state === '' || state === 'all' ? null : String(state);
    if (want !== null && want !== 'open' && !BOT_STATES.has(want)) {
      throw new ApiError(400, `state must be one of active, paused, closed, open, all (got ${want})`, this.#code('bad_request'));
    }
    const s = this.#seasonParam(season);
    const rows = this.botList
      .filter((b) => want === null || (want === 'open' ? b.state !== 'closed' : b.state === want))
      .filter((b) => !this.accounts || venueOf(b) === 'testnet' || b.state !== 'closed' || (b.season ?? 1) === s)
      .map((b) => this.#toRow(b));
    return { rows, total: rows.length, mode: 'sim' };
  }

  /** bot_detail op → { bot, bean, fills, orders } (logs newest first); 404 for an unknown id. */
  botDetail(id) {
    const bot = this.#find(id);
    if (this.repo) {
      const season = bot.season ?? this.season;
      return {
        bot: this.#toRow(bot),
        bean: this.#beanRow(bot.bean),
        fills: this.repo.fills(this.owner.uid, { bot: bot.id, limit: DETAIL_LOG_LIMIT, season }).rows,
        orders: this.repo.orders(this.owner.uid, { bot: bot.id, limit: DETAIL_LOG_LIMIT, season }).rows,
      };
    }
    return {
      bot: this.#toRow(bot),
      bean: this.#beanRow(bot.bean),
      fills: this.#logRows(this.fillLog, bot.id, DETAIL_LOG_LIMIT).rows,
      orders: this.#logRows(this.orderLog, bot.id, DETAIL_LOG_LIMIT).rows,
    };
  }

  /** live_fills op → { rows (newest first), total (matching fills still held) }. Accounts mode reads the DB. */
  fills({ bot = null, limit = 100, season = null } = {}) {
    const id = bot == null || bot === '' ? null : this.#find(bot).id;
    const lim = logLimit(limit);
    if (this.repo) return this.repo.fills(this.owner.uid, { bot: id, limit: lim, season: this.#seasonParam(season) });
    return this.#logRows(this.fillLog, id, lim);
  }

  /** Recent order records (newest first) — not an op in SPEC, handy for debugging/tests. */
  orders({ bot = null, limit = 100, season = null } = {}) {
    const id = bot == null || bot === '' ? null : this.#find(bot).id;
    const lim = logLimit(limit);
    if (this.repo) return this.repo.orders(this.owner.uid, { bot: id, limit: lim, season: this.#seasonParam(season) });
    return this.#logRows(this.orderLog, id, lim);
  }

  /** Open bots of this garden (both venues). */
  openCount() {
    let n = 0;
    for (const b of this.botList) if (b.state !== 'closed') n++;
    return n;
  }

  /** Open testnet bots (and bots with an unfinished flatten intent): what makes a player "active" on testnet. */
  testnetOpenCount() {
    let n = 0;
    for (const b of this.botList) if (b.state !== 'closed' && venueOf(b) === 'testnet') n++;
    return n;
  }

  /** Whether this garden counts as an ACTIVE testnet player (glossary; TESTNET_MAX_ACTIVE_USERS). */
  testnetActive() {
    return this.botList.some((b) => venueOf(b) === 'testnet' && b.state !== 'closed'
      && (b.state === 'active' || b.closing || b.exchange_sync?.op === 'flatten'));
  }

  /** The live bot object of `id` (venue callbacks and Gardens; never sent to clients as-is). */
  botById(id) {
    return this.byId.get(String(id)) ?? null;
  }

  /** testnet_quote (§8.3) for this garden — cache only (the venue's checks 1–15, quote facts). */
  testnetQuote({ bean, capital_usd } = {}) {
    if (!this.testnet) {
      // No venue for this garden (testnet off): a refusing quote, never invented numbers.
      return { ok: false, reason: 'testnet_disabled', venue_ok: false, venue_reason: 'testnet_disabled' };
    }
    const beanId = typeof bean === 'string' && bean.trim() !== '' ? Number(bean) : bean;
    if (!Number.isInteger(beanId) || beanId < 0) throw new ApiError(400, 'bean must be a non-negative integer', 'bad_request');
    const capital = typeof capital_usd === 'string' && capital_usd.trim() !== '' ? Number(capital_usd) : capital_usd;
    if (typeof capital !== 'number' || !Number.isFinite(capital) || capital <= 0) {
      throw new ApiError(400, 'capital_usd must be a positive number', 'bad_request');
    }
    const row = this.#beanRow(beanId);
    if (!row) throw new ApiError(404, `unknown bean ${beanId}`, 'not_found');
    return this.testnet.quoteFor({ row, capital });
  }

  /** testnet_status (§8.3) for this garden — cache only. */
  testnetStatus() {
    if (!this.testnet) return null;
    return this.testnet.status();
  }

  /** BotRow of one bot (the venue's quote/status helpers use it). */
  rowOf(id) {
    return this.#toRow(this.#find(id));
  }

  // ---- commands ----------------------------------------------------------------------------------

  /**
   * bot_create: bind `bean` to `capital_usd` of simulated cash and mirror immediately → BotRow.
   * Accounts mode: `venue:'testnet'` (with `confirm:'testnet'`) returns a Promise of the BotRow (awaits the first
   * lane job ≤ 8 s, §6.11). The paper path stays synchronous.
   */
  create({ bean, capital_usd, confirm, venue = null, ack_divergence = false } = {}) {
    void confirm; // accepted for brood compatibility; meaningless in the simulator (paper)
    const v = venue == null || venue === '' ? 'paper' : String(venue);
    if (v !== 'paper' && v !== 'testnet') throw new ApiError(400, `venue must be paper or testnet (got ${v})`, this.#code('bad_request'));
    if (v === 'testnet' && !this.accounts) {
      throw new ApiError(409, 'the testnet venue needs accounts mode (--auth accounts)', 'testnet_needs_accounts');
    }
    const beanId = typeof bean === 'string' && bean.trim() !== '' ? Number(bean) : bean;
    if (!Number.isInteger(beanId) || beanId < 0) throw new ApiError(400, 'bean must be a non-negative integer', this.#code('bad_request'));
    const capital = typeof capital_usd === 'string' && capital_usd.trim() !== '' ? Number(capital_usd) : capital_usd;
    if (v === 'testnet') return this.#createTestnet({ beanId, capital, confirm, ackDivergence: ack_divergence === true || ack_divergence === 'true' });

    const { minCapitalUsd, maxBotCapitalUsd, maxBots, maxTotalNotionalUsd } = this.cfg;
    if (typeof capital !== 'number' || !Number.isFinite(capital) || capital < minCapitalUsd || capital > maxBotCapitalUsd) {
      throw new ApiError(400, `capital_usd must be a number between ${minCapitalUsd} and ${maxBotCapitalUsd}`, this.#code('bad_request'));
    }
    if (this.halted) {
      throw new ApiError(409, this.accounts ? 'your field is burned (bots_halt) — re-arm it to plant again'
        : 'live layer is halted (bots_halt) — restart to plant again', this.#code('halted'));
    }

    const row = this.#beanRow(beanId);
    if (!row) throw new ApiError(404, `unknown bean ${beanId}`, this.#code('not_found'));
    const info = this.#coinInfo(row.coin);
    const reason = this.#unavailableReason(row, info, null);
    if (reason) {
      throw new ApiError(409, `bean ${beanId} is not tradeable (${reason}): ${this.#explain(reason, row, info)}`,
        this.#code(reason === 'unlisted' ? 'not_tradeable' : reason));
    }
    this.#assertCanOpen(row.coin);

    const acct = this.#account();
    const open = this.accounts ? this.openCount() : acct.active + acct.paused;
    if (open >= maxBots) throw new ApiError(409, `bot cap reached (${maxBots} open bots)`, this.#code('caps'));
    if (capital > acct.available + 1e-9) {
      throw new ApiError(409, `not enough cash: $${acct.available.toFixed(2)} available, $${capital} requested`, this.#code('caps'));
    }
    // A positioned bean is mirrored at once from its units; a flat one opens its next entry later.
    const opensNow = beanSide(row) !== 0 && Math.abs(Number(row.units) || 0) > 0;
    const projected = openingNotional(row, capital, this.#mid(row.coin));
    if (acct.notional + projected > maxTotalNotionalUsd + 1e-9) {
      throw new ApiError(
        409,
        `notional cap: $${acct.notional.toFixed(2)} open + ~$${projected.toFixed(2)} ${opensNow ? 'now' : 'per entry'} exceeds $${maxTotalNotionalUsd}`,
        this.#code('caps'),
      );
    }

    const bot = this.#newBot(row, info, capital);
    this.journal.emit('bot_created', this.accounts
      ? { bot: bot.id, bean: bot.bean, coin: bot.coin, capital_usd: bot.capital_usd, leverage: bot.leverage, venue: 'paper' }
      : { bot: bot.id, bean: bot.bean, coin: bot.coin, capital_usd: bot.capital_usd, leverage: bot.leverage });
    this.#reconcile(bot, 'create'); // mirror now, not on the next tick
    this.#touch(bot);
    this.#committed();
    return this.#toRow(bot);
  }

  /** bot_pause: flatten and stop mirroring (idempotent for an already paused bot). Testnet: awaits ≤ 8 s. */
  pause({ id } = {}) {
    const bot = this.#find(id);
    if (bot.state === 'closed') throw new ApiError(409, `${bot.id} is closed`, this.#code('conflict'));
    if (venueOf(bot) === 'testnet') return this.#pauseTestnetCmd(bot);
    if (bot.state === 'active') this.#pauseBot(bot, 'manual', null, 'pause');
    this.#committed();
    return this.#toRow(bot);
  }

  /** bot_resume: back to active and mirror now (idempotent for an active bot). Testnet: awaits ≤ 8 s. */
  resume({ id } = {}) {
    const bot = this.#find(id);
    if (this.halted) {
      throw new ApiError(409, this.accounts ? 'your field is burned (bots_halt) — re-arm it to resume bots'
        : 'live layer is halted (bots_halt) — restart to resume bots', this.#code('halted'));
    }
    if (bot.state === 'closed') throw new ApiError(409, `${bot.id} is closed`, this.#code('conflict'));
    if (venueOf(bot) === 'testnet') return this.#resumeTestnetCmd(bot);
    if (bot.state === 'active') return this.#toRow(bot);
    const row = this.#beanRow(bot.bean);
    if (!row) throw new ApiError(404, `unknown bean ${bot.bean}`, this.#code('not_found'));
    const info = this.#coinInfo(bot.coin);
    const reason = this.#unavailableReason(row, info, bot);
    if (reason) {
      throw new ApiError(409, `cannot resume ${bot.id} (${reason}): ${this.#explain(reason, row, info)}`,
        this.#code(reason === 'unlisted' ? 'not_tradeable' : reason));
    }
    this.#assertCanOpen(bot.coin);
    bot.state = 'active';
    bot.note = null;
    if (this.accounts) {
      bot.note_code = null;
      bot.note_vars = null;
    }
    this.journal.emit('bot_resumed', { bot: bot.id });
    this.#reconcile(bot, 'resume');
    this.#touch(bot);
    this.#committed();
    return this.#toRow(bot);
  }

  /**
   * bot_close: flatten and retire; the coin and bean can be bound again. 409 when already closed. A testnet bot
   * that is already closing returns its row and sends nothing (idempotent, §8.4).
   */
  close({ id } = {}) {
    const bot = this.#find(id);
    if (bot.state === 'closed') throw new ApiError(409, `${bot.id} is already closed`, this.#code('conflict'));
    if (venueOf(bot) === 'testnet') return this.#closeTestnetCmd(bot);
    this.#closeBot(bot, 'close');
    this.#committed();
    return this.#toRow(bot);
  }

  /**
   * bots_halt: kill switch — close every open bot and refuse create/resume until restart (none mode) or until the
   * player re-arms (accounts mode: persisted). Paper bots close synchronously; testnet bots flatten and close
   * asynchronously and are listed in `closing` (accounts mode only).
   */
  halt() {
    const closed = [];
    const closing = [];
    let realized = 0;
    for (const bot of this.botList) {
      if (bot.state === 'closed') continue;
      if (venueOf(bot) === 'testnet') {
        if (!bot.closing) this.#beginTestnetClose(bot, 'halt');
        closing.push(bot.id);
        continue;
      }
      this.#closeBot(bot, 'halt');
      bot.note = 'halted';
      this.#touch(bot);
      closed.push(bot.id);
      realized += bot.realized_pnl;
    }
    if (!this.halted) {
      this.halted = true;
      this.haltedMs = this.now();
    }
    this.journal.emit('live_halted', this.accounts ? { closed, closing } : { closed });
    this.#persistGarden();
    this.#committed();
    if (this.accounts) return { halted: true, closed, closing, realized_pnl: usd(realized) };
    return { halted: true, closed, realized_pnl: usd(realized) };
  }

  /** garden_rearm (accounts mode, §8.4): lift a persisted halt ≥ 60 s after it, with confirm 'REARM'. */
  rearm({ confirm } = {}) {
    this.#accountsOnly('garden_rearm');
    if (confirm !== 'REARM') throw new ApiError(400, 'confirm must be "REARM"', 'confirm_required');
    if (!this.halted) return { halted: false };
    const wait = (this.haltedMs ?? 0) + REARM_AFTER_MS - this.now();
    if (wait > 0) {
      const retry = Math.ceil(wait / 1000);
      throw new ApiError(409, `the field can be re-armed in ${retry} s`, 'too_soon', { retry_after_s: retry });
    }
    this.halted = false;
    this.haltedMs = null;
    this.journal.emit('garden_rearmed', {});
    this.#persistGarden();
    this.#committed();
    return { halted: false };
  }

  /**
   * garden_reset (accounts mode, §7.6/§8.4): a new PAPER season. Paper bots close at market (synchronously), the
   * season number increments, `account_usd` restarts at `accountUsd` (the current paper cap), old paper fills and
   * orders keep their old season. Testnet bots, fills and the credential are untouched. Once per 24 h; refused
   * while the field is burned.
   */
  resetSeason({ confirm, accountUsd = null } = {}) {
    this.#accountsOnly('garden_reset');
    if (confirm !== 'RESET') throw new ApiError(400, 'confirm must be "RESET"', 'confirm_required');
    if (this.halted) throw new ApiError(409, 'your field is burned — re-arm it before starting a new season', 'halted');
    const now = this.now();
    if (Number.isFinite(this.lastResetMs) && this.lastResetMs + RESET_EVERY_MS > now) {
      const retry = Math.ceil((this.lastResetMs + RESET_EVERY_MS - now) / 1000);
      throw new ApiError(409, 'a new season can start once per 24 hours', 'too_soon', { retry_after_s: retry });
    }
    const closed = [];
    let realized = 0;
    for (const bot of this.botList) {
      if (bot.state === 'closed' || venueOf(bot) !== 'paper') continue;
      this.#closeBot(bot, 'reset');
      this.#touch(bot);
      closed.push(bot.id);
      realized += bot.realized_pnl;
    }
    this.season += 1;
    this.seasonStartedMs = now;
    this.lastResetMs = now;
    if (isPrice(accountUsd)) this.cfg.accountUsd = accountUsd;
    this.journal.emit('garden_reset', { season: this.season, closed, realized_pnl: usd(realized) });
    this.#persistGarden();
    this.#committed();
    return { season: this.season, closed, realized_pnl: usd(realized), account_usd: this.cfg.accountUsd };
  }

  /** Apply new caps to FUTURE bots (admin_caps, §7.3). `paper` / `testnet` are camelCase cap objects. */
  setCaps({ paper = null, testnet = null } = {}) {
    if (paper) {
      const next = paperCaps({ ...this.cfg, ...paper, accountUsd: this.cfg.accountUsd });
      Object.assign(this.cfg, next, { accountUsd: this.cfg.accountUsd });
    }
    if (testnet) this.tcfg = testnetCapsOf({ ...this.tcfg, ...testnet });
  }

  /** Current caps: { paper, testnet } (snake_case, as live_status shows them). */
  caps() {
    return {
      paper: {
        account_usd: this.cfg.accountUsd,
        max_bots: this.cfg.maxBots,
        min_capital_usd: this.cfg.minCapitalUsd,
        max_bot_capital_usd: this.cfg.maxBotCapitalUsd,
        max_total_notional_usd: this.cfg.maxTotalNotionalUsd,
      },
      testnet: {
        max_bots: this.tcfg.maxBots,
        min_capital_usd: this.tcfg.minCapitalUsd,
        max_bot_capital_usd: this.tcfg.maxBotCapitalUsd,
        max_total_notional_usd: this.tcfg.maxTotalNotionalUsd,
      },
    };
  }

  // ---- persistence -------------------------------------------------------------------------------

  /** Plain-JSON state. `halted` is deliberately not persisted: a halt lasts until restart. */
  serialize() {
    return {
      v: 1,
      account_usd: this.cfg.accountUsd,
      next_index: this.nextIndex,
      bots: this.botList.map((b) => structuredClone(b)),
      fills: this.fillLog.toArray(),
      orders: this.orderLog.toArray(),
      fills_logged: this.fillsLogged,
      last_error: this.lastError,
      last_error_ms: this.lastErrorMs,
      last_reconcile_ms: this.lastReconcileMs,
      last_tick: this.lastTick,
    };
  }

  /** Restore from serialize(); invalid input leaves a fresh layer. @returns {boolean} restored */
  restore(obj) {
    this.#reset();
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.bots)) return false;
    try {
      for (const raw of obj.bots) {
        const bot = sanitizeBot(raw);
        if (!bot || this.byId.has(bot.id)) continue;
        this.botList.push(bot);
        this.byId.set(bot.id, bot);
        if (bot.state !== 'closed') this.#bind(bot);
      }
      this.botList.sort((a, b) => a.index - b.index);
      const maxIndex = this.botList.reduce((m, b) => Math.max(m, b.index), -1);
      this.nextIndex = Math.max(Number.isInteger(obj.next_index) ? obj.next_index : 0, maxIndex + 1);
      for (const f of Array.isArray(obj.fills) ? obj.fills.slice(-LOG_KEEP) : []) if (f && typeof f === 'object') this.fillLog.push(f);
      for (const o of Array.isArray(obj.orders) ? obj.orders.slice(-LOG_KEEP) : []) if (o && typeof o === 'object') this.orderLog.push(o);
      this.fillsLogged = Number.isFinite(obj.fills_logged) ? obj.fills_logged : this.fillLog.length;
      this.lastError = typeof obj.last_error === 'string' ? obj.last_error : null;
      this.lastErrorMs = Number.isFinite(obj.last_error_ms) ? obj.last_error_ms : null;
      this.lastReconcileMs = Number.isFinite(obj.last_reconcile_ms) ? obj.last_reconcile_ms : null;
      this.lastTick = Number.isFinite(obj.last_tick) ? obj.last_tick : null;
      return true;
    } catch (err) {
      this.log(`[live] restore failed (${err?.message || err}) — starting with no bots`);
      this.#reset();
      return false;
    }
  }

  /**
   * Accounts mode: load the garden from the DB (the `gardens` row is given to the constructor; bots come from the
   * repo). Marks are recomputed from mids after a restart (§3.5), never read back.
   */
  #loadGarden(garden) {
    this.season = Number.isSafeInteger(garden.season) ? garden.season : 1;
    this.seasonStartedMs = Number.isFinite(garden.season_started_ms) ? garden.season_started_ms : this.startedMs;
    this.lastResetMs = Number.isFinite(garden.last_reset_ms) ? garden.last_reset_ms : null;
    this.epoch = typeof garden.epoch === 'string' ? garden.epoch : null;
    if (isPrice(garden.account_usd)) this.cfg.accountUsd = garden.account_usd;
    this.halted = garden.halted === 1 || garden.halted === true;
    this.haltedMs = this.halted && Number.isFinite(garden.halted_ms) ? garden.halted_ms : null;
    this.fillsLogged = Number.isFinite(garden.fills_logged) ? garden.fills_logged : 0;
    this.lastError = typeof garden.last_error === 'string' ? garden.last_error : null;
    this.lastErrorMs = Number.isFinite(garden.last_error_ms) ? garden.last_error_ms : null;
    this.lastReconcileMs = Number.isFinite(garden.last_reconcile_ms) ? garden.last_reconcile_ms : null;
    this.lastTick = Number.isFinite(garden.last_tick) ? garden.last_tick : null;
    this.replayGuardTick = this.#replayGuardFor(garden.last_tick);
    const raws = this.repo ? this.repo.loadBots(this.owner.uid) : [];
    for (const raw of raws) {
      const bot = sanitizeBot(raw, { accounts: true });
      if (!bot || this.byId.has(bot.id)) {
        this.log(`[live] garden ${this.owner.uid}: dropped an unreadable bot row (${raw?.id ?? '?'})`);
        continue;
      }
      this.botList.push(bot);
      this.byId.set(bot.id, bot);
      if (bot.state !== 'closed') this.#bind(bot);
    }
    this.botList.sort((a, b) => a.index - b.index);
    const maxIndex = this.botList.reduce((m, b) => Math.max(m, b.index), -1);
    this.nextIndex = Math.max(Number.isInteger(garden.next_bot_index) ? garden.next_bot_index : 0, maxIndex + 1);
  }

  /**
   * Accounts mode: the stored watermark when it is AHEAD of a restored engine (the DB is newer than the engine state),
   * else null. Bounded: a gap above REPLAY_GUARD_MAX_BARS means the two do not belong together (no guard, logged).
   */
  #replayGuardFor(stored) {
    const restored = this.engine?.restoredTick;
    const current = this.engine?.ticks;
    if (!Number.isSafeInteger(stored) || !Number.isSafeInteger(restored) || !Number.isSafeInteger(current)) return null;
    if (stored <= current) return null;
    if (stored - current > REPLAY_GUARD_MAX_BARS) {
      this.log(`[live] garden ${this.owner?.uid}: stored tick ${stored} is ${stored - current} bars ahead of the engine; no replay guard`);
      return null;
    }
    return stored;
  }

  /** The tick every row of this garden reflects (gardens.last_tick): never lower than the engine's or the guard's. */
  #watermark() {
    let t = Number.isSafeInteger(this.lastTick) ? this.lastTick : null;
    const e = this.engine?.ticks;
    if (Number.isSafeInteger(e) && (t === null || e > t)) t = e;
    if (this.replayGuardTick !== null && (t === null || this.replayGuardTick > t)) t = this.replayGuardTick;
    return t;
  }

  /** The `gardens` row fields this layer owns (Gardens/repo write them). */
  gardenFields() {
    return {
      season: this.season,
      season_started_ms: Math.trunc(this.seasonStartedMs ?? this.now()),
      last_reset_ms: this.lastResetMs,
      account_usd: this.cfg.accountUsd,
      next_bot_index: this.nextIndex,
      halted: this.halted,
      halted_ms: this.haltedMs,
      fills_logged: this.fillsLogged,
      last_error: this.lastError,
      last_error_ms: this.lastErrorMs,
      last_reconcile_ms: Number.isFinite(this.lastReconcileMs) ? Math.trunc(this.lastReconcileMs) : null,
      last_tick: this.#watermark(),
    };
  }

  #persistGarden() {
    if (!this.repo) return;
    this.persistedFills = this.fillsLogged;
    this.persistedError = this.lastError;
    this.repo.saveGarden(this.owner.uid, this.gardenFields());
  }

  /** Queue a bot row write (accounts mode). */
  #touch(bot) {
    if (this.repo) this.repo.saveBot(this.owner.uid, bot);
  }

  /** End of a command: flush the buffered writes now (§3.5) and tell Gardens the open set may have changed. */
  #committed() {
    if (!this.accounts) return;
    this.#persistGarden();
    try {
      this.repo?.flush();
    } catch (err) {
      this.log(`[live] garden ${this.owner.uid}: flush failed (${err?.message || err}) — retried later`);
    }
    this.notifyChanged();
  }

  /** Tell Gardens that the open-bot membership (open / testnetActive sets) may have changed. */
  notifyChanged() {
    try {
      this.hooks?.changed?.(this);
    } catch (err) {
      this.log(`[live] changed hook failed: ${err?.message || err}`);
    }
  }

  // ---- reconcile / mirror --------------------------------------------------------------------------

  /** Refresh one open bot from its bean: bust/liquidation checks, mirror (active only), mark-to-market. */
  #reconcile(bot, reason) {
    const now = this.now();
    const row = this.#beanRow(bot.bean);
    if (!row) {
      this.#setError(bot, `bean ${bot.bean} not found`);
      return;
    }
    bot.bean_side = beanSide(row);
    bot.bean_units = Number(row.units) || 0;
    bot.bean_equity = Number(row.equity) || 0;
    // A stale coin (no live price) freezes its bot: no mirror, no liquidation check, the mark stays put.
    bot.price_stale = this.#isStale(bot.coin);
    if (bot.price_stale) {
      bot.last_reconcile_ms = now;
      return;
    }
    const mid = this.#mid(bot.coin);

    if (bot.state === 'active') {
      if (row.busted) this.#pauseBot(bot, 'bean busted', mid, 'bean_busted');
      else if (this.#liquidationHit(bot, mid)) this.#liquidate(bot);
      else this.#mirror(bot, row, mid, reason);
    }
    this.#mark(bot, mid);
    bot.last_reconcile_ms = now;
    bot.updated_ms = now;
  }

  /** Bring the bot's position to the scaled bean target (SPEC §2.6 mirror rule). */
  #mirror(bot, row, mid, reason) {
    const d = bot.sz_decimals;
    const scale = bot.capital_usd / CAPITAL_PER_BEAN;
    const side = beanSide(row);
    const rawTarget = side * Math.abs(bot.bean_units) * scale;
    const target = side === 0 ? 0 : side * floorTo(Math.abs(bot.bean_units) * scale, d);
    if (this.repo && target !== bot.target_sz) this.#touch(bot);
    bot.target_sz = target;
    const szi = bot.real.szi;
    const delta = roundTo(target - szi, d);

    if (!isPrice(mid)) {
      // Only an error when a trade is actually blocked; an in-sync bot just keeps its last mark.
      if (delta !== 0) {
        this.#skip(bot, rawTarget - szi, null, 'no_price');
        this.#setError(bot, `no price for ${bot.coin}`, 'no_price');
      }
      return;
    }
    if (delta === 0) {
      // In sync — unless the bean is positioned but its scaled size rounds to zero.
      if (side !== 0 && target === 0) this.#skip(bot, rawTarget - szi, mid, 'below_min_order');
      else bot.skip_key = null;
      this.#clearError(bot);
      return;
    }
    if (target !== 0 && Math.abs(delta) * mid < this.cfg.minOrderUsd) {
      this.#skip(bot, delta, mid, 'below_min_order');
      this.#clearError(bot);
      return;
    }
    // The notional cap only gates NEW exposure: growing on the same side, or the opening leg of a flip
    // that ends up bigger than the position it replaces. Reducing/closing is never blocked.
    const flip = szi !== 0 && target !== 0 && Math.sign(target) !== Math.sign(szi);
    if (Math.abs(target) > Math.abs(szi)) {
      const after = this.#openNotional(bot) + Math.abs(target) * mid;
      if (after > this.cfg.maxTotalNotionalUsd + 1e-9) {
        // A blocked flip still closes the side the bean has left; only the opening leg waits.
        if (flip) this.#execute(bot, -szi, this.#takerPx(mid, -szi), 'mirror', reason);
        this.#skip(bot, target - bot.real.szi, mid, 'notional_cap');
        this.#setError(bot, `notional cap: $${after.toFixed(2)} would exceed $${this.cfg.maxTotalNotionalUsd}`, 'notional_cap');
        return;
      }
    }
    this.#execute(bot, delta, this.#takerPx(mid, delta), 'mirror', reason);
    this.#clearError(bot);
  }

  /** Close the whole position at mid (fallback: last mark, then entry). No-op when flat. */
  #flatten(bot, mid, reason) {
    const szi = bot.real.szi;
    if (!szi) return;
    const ref = isPrice(mid) ? mid : isPrice(bot.mark_px) ? bot.mark_px : bot.real.entry_px;
    this.#execute(bot, -szi, this.#takerPx(ref, -szi), 'flatten', reason);
  }

  #liquidationHit(bot, mid) {
    const { szi, entry_px } = bot.real;
    const liq = liquidationPx(szi, entry_px, bot.leverage);
    if (liq === null || !isPrice(mid)) return false;
    return szi > 0 ? mid <= liq : mid >= liq;
  }

  /**
   * The venue takes the position at the liquidation price and keeps the whole isolated margin — the same
   * outcome as a paper bean's liquidation (pnl = −margin, no fee) — then the bot pauses.
   */
  #liquidate(bot) {
    const { szi, entry_px } = bot.real;
    this.#execute(bot, -szi, liquidationPx(szi, entry_px, bot.leverage), 'flatten', 'liquidation', { liquidation: true });
    this.#pauseBot(bot, 'liquidated', null, 'liquidation');
  }

  /** Flatten + paused. `note` is user-visible ('bean busted', 'liquidated'; null for a manual pause). */
  #pauseBot(bot, why, mid, flattenReason) {
    const price = mid ?? this.#mid(bot.coin);
    this.#flatten(bot, price, flattenReason);
    bot.state = 'paused';
    bot.note = why === 'manual' ? null : why;
    bot.target_sz = 0;
    bot.skip_key = null;
    this.#clearError(bot);
    this.#mark(bot, price);
    bot.updated_ms = this.now();
    this.#touch(bot);
    this.journal.emit('bot_paused', this.#replaying() ? { bot: bot.id, reason: why, replay: true } : { bot: bot.id, reason: why });
  }

  #closeBot(bot, reason) {
    const mid = this.#mid(bot.coin);
    this.#flatten(bot, mid, reason);
    const now = this.now();
    bot.state = 'closed';
    bot.closed_ms = now;
    bot.updated_ms = now;
    bot.target_sz = 0;
    bot.skip_key = null;
    this.#clearError(bot);
    this.#mark(bot, mid);
    this.#unbind(bot);
    this.#touch(bot);
    this.journal.emit('bot_closed', this.accounts
      ? { bot: bot.id, realized_pnl: usd(bot.realized_pnl), venue: 'paper', confirmed: true }
      : { bot: bot.id, realized_pnl: usd(bot.realized_pnl) });
  }

  /**
   * Fill a signed size change `delta` at `px` as ONE order. Reducing/closing comes first; whatever is
   * left opens (or extends) in the new direction, so a flip yields Close + Open fills.
   * `liquidation`: the closing fill realizes −initial margin of the closed size and pays no fee.
   */
  #execute(bot, delta, px, kind, reason, { liquidation = false } = {}) {
    const d = bot.sz_decimals;
    const r = bot.real;
    const tick = this.#tick();
    const timeMs = this.#fillTime();
    const fillPx = px10(px);
    const order = { bot: bot.id, coin: bot.coin, kind, sz: delta, px: fillPx, status: 'filled', reason, time_ms: timeMs, tick };
    this.#logOrder(bot, order);

    const dir = Math.sign(delta);
    const side = dir > 0 ? 'B' : 'A';
    let remaining = Math.abs(delta);
    let szi = r.szi;

    if (szi !== 0 && Math.sign(szi) !== dir) {
      const closeSz = roundTo(Math.min(remaining, Math.abs(szi)), d);
      const closedPnl = liquidation
        ? usd(-(closeSz * r.entry_px) / bot.leverage)
        : usd((fillPx - r.entry_px) * closeSz * Math.sign(szi));
      const feeRate = liquidation ? 0 : SIM_COSTS.takerFee;
      this.#fill(bot, szi > 0 ? 'Close Long' : 'Close Short', side, closeSz, fillPx, closedPnl, timeMs, tick, feeRate, liquidation);
      szi = roundTo(szi + dir * closeSz, d);
      remaining = roundTo(remaining - closeSz, d);
      if (szi === 0) r.entry_px = null;
    }
    if (remaining > 0) {
      const held = Math.abs(szi);
      r.entry_px = held === 0 ? fillPx : (held * r.entry_px + remaining * fillPx) / (held + remaining);
      szi = roundTo(szi + dir * remaining, d);
      this.#fill(bot, dir > 0 ? 'Open Long' : 'Open Short', side, remaining, fillPx, 0, timeMs, tick);
    }
    r.szi = szi;
    bot.skip_key = null;
    this.#touch(bot);
  }

  #fill(bot, dir, side, sz, px, closedPnl, timeMs, tick, feeRate = SIM_COSTS.takerFee, liquidation = false) {
    const fee = usd(sz * px * feeRate);
    const fill = { bot: bot.id, coin: bot.coin, dir, side, sz, px, fee, closed_pnl: closedPnl, time_ms: timeMs, tick };
    bot.fills += 1;
    bot.fees += fee;
    bot.volume += sz * px;
    bot.realized_pnl += closedPnl - fee;
    this.fillLog.push(fill);
    this.fillsLogged += 1;
    if (this.repo) {
      this.repo.addFill(this.owner.uid, {
        ...fill, venue: 'paper', season: bot.season ?? this.season, liquidation, replay: this.#replaying(),
      });
    }
    const event = { bot: bot.id, coin: bot.coin, dir, sz, px, fee, closed_pnl: closedPnl, time_ms: timeMs, tick };
    if (liquidation) event.liquidation = true;
    if (this.#replaying()) event.replay = true; // a missed minute being caught up: the client applies it, no animation
    if (this.accounts) event.venue = 'paper';
    this.journal.emit('bot_fill', event);
  }

  /** Record a skipped order once per distinct situation (no spam while nothing changes). */
  #skip(bot, sz, mid, why) {
    const key = `${why}|${bot.target_sz}|${bot.real.szi}`;
    if (bot.skip_key === key) return;
    bot.skip_key = key;
    const order = {
      bot: bot.id,
      coin: bot.coin,
      kind: 'mirror',
      sz: zeroNegZero(Number(sz.toPrecision(8))),
      px: isPrice(mid) ? px10(mid) : null,
      status: 'skipped',
      reason: why,
      time_ms: this.#fillTime(),
      tick: this.#tick(),
    };
    this.#logOrder(bot, order);
  }

  /**
   * Store an order and publish `bot_order`. SPEC lists the event as {bot, coin, kind, sz, px, status}, but a
   * journal record's own `kind` is the event name ('bot_order', also the SSE `event:`), so the order kind
   * (mirror|flatten) travels as `order_kind`. The stored Order record keeps `kind`.
   */
  #logOrder(bot, order) {
    bot.orders += 1;
    this.orderLog.push(order);
    if (this.repo) {
      this.repo.addOrder(this.owner.uid, { ...order, venue: 'paper', season: bot.season ?? this.season, replay: this.#replaying() });
      this.#touch(bot);
    }
    this.journal.emit('bot_order', {
      bot: order.bot,
      coin: order.coin,
      order_kind: order.kind,
      sz: order.sz,
      px: order.px,
      status: order.status,
      reason: order.reason,
      ...(this.#replaying() ? { replay: true } : {}),
      ...(this.accounts ? { venue: 'paper' } : {}),
    });
  }

  /** Mark the position to `mid` (or the last good mark) and refresh margin/liquidation figures. */
  #mark(bot, mid, at = this.#priceMs(bot.coin)) {
    const r = bot.real;
    if (isPrice(mid)) {
      bot.mark_px = mid;
      bot.mark_ms = at;
    }
    const px = isPrice(bot.mark_px) ? bot.mark_px : r.entry_px;
    if (!r.szi || !isPrice(px)) {
      r.entry_px = r.szi ? r.entry_px : null;
      r.unrealized_pnl = 0;
      r.margin_used = 0;
      r.liquidation_px = null;
      bot.notional_usd = 0;
    } else {
      r.unrealized_pnl = r.szi * (px - r.entry_px);
      // Isolated margin as the venue reports it: initial margin plus unrealized PnL.
      r.margin_used = Math.max(0, (Math.abs(r.szi) * r.entry_px) / bot.leverage + r.unrealized_pnl);
      r.liquidation_px = liquidationPx(r.szi, r.entry_px, bot.leverage);
      bot.notional_usd = Math.abs(r.szi) * px;
    }
    r.leverage = bot.leverage;
    r.as_of_ms = at;
  }

  // ---- testnet bots (accounts mode; the venue does the exchange work, PLATFORM §6.11) -----------------------------

  async #createTestnet({ beanId, capital, confirm, ackDivergence }) {
    if (!this.testnet) throw new ApiError(503, 'the testnet venue is not enabled on this server', 'testnet_disabled');
    if (confirm !== 'testnet') throw new ApiError(400, 'confirm must be "testnet" to plant a testnet bot', 'confirm_required');
    if (typeof capital !== 'number' || !Number.isFinite(capital) || capital <= 0) {
      throw new ApiError(400, `capital_usd must be a number between ${this.tcfg.minCapitalUsd} and ${this.tcfg.maxBotCapitalUsd}`, 'bad_request');
    }
    const row = this.#beanRow(beanId);
    if (!row) throw new ApiError(404, `unknown bean ${beanId}`, 'not_found');
    // The §7.3 checks, in order (the first failure wins). The venue owns the exchange-side facts.
    const verdict = this.testnet.checkCreate({ row, capital, ackDivergence });
    if (!verdict.ok) throw verdict.error;
    const bot = this.#newBot(row, verdict.info, capital, 'testnet', verdict);
    bot.exchange_sync = { op: 'leverage', state: 'pending', since_ms: this.now(), attempts: 0, code: null, error: null };
    this.journal.emit('bot_created', {
      bot: bot.id, bean: bot.bean, coin: bot.coin, capital_usd: bot.capital_usd, leverage: bot.leverage, venue: 'testnet',
    });
    this.#touch(bot);
    this.#committed();
    await awaitWithin(this.testnet.onCreate(bot), COMMAND_AWAIT_MS);
    return this.#toRow(bot);
  }

  async #pauseTestnetCmd(bot) {
    if (bot.state === 'active') {
      bot.state = 'paused';
      bot.note = null;
      bot.note_code = null;
      bot.note_vars = null;
      bot.target_szi = 0;
      bot.updated_ms = this.now();
      this.#touch(bot);
      this.#committed();
      await awaitWithin(this.testnet?.requestFlatten(bot, 'pause'), COMMAND_AWAIT_MS);
    }
    return this.#toRow(bot);
  }

  async #resumeTestnetCmd(bot) {
    if (!this.testnet) throw new ApiError(503, 'the testnet venue is not enabled on this server', 'testnet_disabled');
    if (bot.closing) throw new ApiError(409, `${bot.id} is closing`, 'conflict');
    if (bot.state === 'active') return this.#toRow(bot);
    const row = this.#beanRow(bot.bean);
    if (!row) throw new ApiError(404, `unknown bean ${bot.bean}`, 'not_found');
    const verdict = this.testnet.checkResume({ bot, row });
    if (!verdict.ok) throw verdict.error;
    // A drift-paused bot ADOPTS the exchange size (§6.11 step 4): expected := exch.szi, then mirror from there.
    const adopt = bot.note_code === 'position_drift' || bot.note_code === 'external_close'
      || bot.note_code === 'liquidated_testnet';
    if (adopt && bot.exchange && Number.isFinite(bot.exchange.szi)) {
      bot.real.szi = bot.exchange.szi;
      bot.real.entry_px = bot.exchange.szi ? (bot.exchange.entry_px ?? bot.real.entry_px) : null;
    }
    bot.state = 'active';
    bot.note = null;
    bot.note_code = null;
    bot.note_vars = null;
    bot.dust = null;
    // Resume WITHDRAWS an unfinished flatten (a pause or kill switch whose flatten is still retrying): the intent lives
    // in exchange_sync (boot() re-issues op 'flatten'), so it is cleared here, and the venue cancels the retry
    // (onResume → withdrawFlatten). Otherwise a stale retry would flatten the now-active bot.
    if (bot.exchange_sync?.op === 'flatten') bot.exchange_sync = null;
    bot.updated_ms = this.now();
    this.journal.emit('bot_resumed', { bot: bot.id });
    this.#touch(bot);
    this.#committed();
    await awaitWithin(this.testnet.onResume(bot, { adopt }), COMMAND_AWAIT_MS);
    return this.#toRow(bot);
  }

  async #closeTestnetCmd(bot) {
    if (bot.closing) return this.#toRow(bot); // idempotent while closing: no new order (§8.4)
    const p = this.#beginTestnetClose(bot, 'close');
    this.#committed();
    await awaitWithin(p, COMMAND_AWAIT_MS);
    return this.#toRow(bot);
  }

  /** Close = pause + retire: `closing` until flat, then the venue confirms (closeConfirmed). */
  #beginTestnetClose(bot, reason) {
    bot.closing = true;
    if (bot.state === 'active') bot.state = 'paused';
    bot.target_szi = 0;
    bot.updated_ms = this.now();
    this.#touch(bot);
    if (!this.testnet) {
      // The venue is gone (testnet disabled after a restart): nothing can be sent; close in our books.
      this.closeInBooks(bot.id, 'testnet_disabled');
      return Promise.resolve();
    }
    return this.testnet.requestFlatten(bot, reason);
  }

  /** afterTick for one testnet bot: refresh the bean fields, pause on bust, plan the target (§6.11 sizing). */
  #planTestnet(bot) {
    const row = this.#beanRow(bot.bean);
    if (!row) return;
    bot.bean_side = beanSide(row);
    bot.bean_units = Number(row.units) || 0;
    bot.bean_equity = Number(row.equity) || 0;
    if (bot.state !== 'active' || this.#replaying() || !this.testnet) return;
    if (row.busted) {
      this.#pauseTestnetInternal(bot, 'bean busted', null, null);
      return;
    }
    this.testnet.planTarget(bot, row);
  }

  /** Pause a testnet bot from inside (bust, kill switch, expiry, inactivity): flatten, note it, notify. */
  #pauseTestnetInternal(bot, why, noteCode, vars) {
    if (bot.state === 'closed') return;
    bot.state = 'paused';
    bot.note = why;
    bot.note_code = noteCode;
    bot.note_vars = vars ?? null;
    bot.target_szi = 0;
    bot.updated_ms = this.now();
    this.#touch(bot);
    this.testnet?.requestFlatten(bot, noteCode ?? 'pause');
  }

  /**
   * Flatten-and-pause every open testnet bot with `noteCode` (kill switch, API-wallet expiry, inactivity, mainnet
   * key hit, operator reset). Returns the ids it paused. Closing bots keep closing.
   */
  pauseTestnetBots(noteCode, why = noteCode, vars = null) {
    const ids = [];
    for (const bot of this.botList) {
      if (bot.state === 'closed' || venueOf(bot) !== 'testnet') continue;
      if (bot.closing) {
        ids.push(bot.id);
        continue;
      }
      if (bot.state === 'active' || bot.real.szi !== 0 || (bot.exchange?.szi ?? 0) !== 0) {
        this.#pauseTestnetInternal(bot, why, noteCode, vars);
        ids.push(bot.id);
      } else {
        bot.note_code = noteCode;
        bot.note = why;
        this.#touch(bot);
      }
    }
    this.#committed();
    return ids;
  }

  /** Mark one testnet bot at the testnet mid (an estimate, §7.5). A missing/old mid flags price_stale. */
  #markTestnet(bot) {
    const q = this.testnet?.quote?.(bot.coin) ?? null;
    const r = bot.real;
    const fresh = q && isPrice(q.px) && (q.stale !== true);
    bot.price_stale = !fresh;
    if (fresh) {
      bot.mark_px = q.px;
      bot.mark_ms = Number.isFinite(q.ms) ? q.ms : this.now();
    }
    const px = isPrice(bot.mark_px) ? bot.mark_px : r.entry_px;
    if (!r.szi || !isPrice(px) || !isPrice(r.entry_px)) {
      r.unrealized_pnl = 0;
      bot.notional_usd = 0;
      if (!r.szi) {
        r.entry_px = null;
        r.margin_used = 0;
        r.margin_est = false;
        r.liquidation_px = null;
      }
    } else {
      r.unrealized_pnl = r.szi * (px - r.entry_px);
      bot.notional_usd = Math.abs(r.szi) * px;
      // The exchange's margin and liquidation price describe the position of the LAST reconcile. Right after a fill
      // (the reconcile ran before the order) or while drift-paused, that is not the position our books hold: then the
      // margin is our estimate (flagged `margin_est`, shown with ≈) and the liquidation price is unknown — never the
      // pre-trade snapshot's $0.00 / — presented as exchange numbers (§9.6 J1/J7).
      const ex = bot.exchange;
      const lot = 10 ** -(bot.sz_decimals ?? 0);
      const covers = Boolean(ex) && ex.szi !== 0 && Math.abs(ex.szi - r.szi) < lot / 2;
      if (covers && Number.isFinite(ex.margin_used)) {
        r.margin_used = ex.margin_used;
        r.margin_est = false;
      } else {
        r.margin_used = Math.max(0, (Math.abs(r.szi) * r.entry_px) / bot.leverage + r.unrealized_pnl);
        r.margin_est = true;
      }
      r.liquidation_px = covers ? ex.liquidation_px ?? null : null; // the exchange's own (§6.11 Liquidation)
    }
    r.leverage = bot.leverage;
    if (Number.isFinite(bot.mark_ms)) r.as_of_ms = bot.mark_ms;
  }

  #requireTestnetBot(botId) {
    const bot = this.byId.get(String(botId));
    if (!bot || venueOf(bot) !== 'testnet') return null;
    return bot;
  }

  /**
   * Venue → garden: one (provisional) fill from an order response (§6.11 step 6). `delta` is the signed filled
   * size; the accounting is the paper one (close part first, then the open part at the weighted entry); the fee
   * is estimated at 4.5 bp until the fills sweep replaces it. Inserts the fill row(s) and emits bot_fill.
   * @param {object} f { delta, px, oid, order_id, time_ms, liquidation?, provisional? (default true), start_position? }
   */
  applyExchangeFill(botId, f) {
    const bot = this.#requireTestnetBot(botId);
    if (!bot || !(Number(f?.delta) !== 0) || !isPrice(Number(f?.px))) return null;
    const d = bot.sz_decimals;
    const r = bot.real;
    const px = px10(Number(f.px));
    const delta = roundTo(Number(f.delta), d);
    const timeMs = Number.isFinite(f.time_ms) ? f.time_ms : this.now();
    const provisional = f.provisional !== false;
    const dir = Math.sign(delta);
    const side = dir > 0 ? 'B' : 'A';
    if (f.exact && typeof f.exact === 'object') return this.#applyExactFill(bot, f, { delta, px, timeMs, dir });
    let remaining = Math.abs(delta);
    let szi = r.szi;
    const parts = [];
    if (szi !== 0 && Math.sign(szi) !== dir) {
      const closeSz = roundTo(Math.min(remaining, Math.abs(szi)), d);
      const closedPnl = isPrice(r.entry_px) ? usd((px - r.entry_px) * closeSz * Math.sign(szi)) : 0;
      parts.push({ dir: szi > 0 ? 'Close Long' : 'Close Short', sz: closeSz, closed_pnl: closedPnl, start: szi });
      szi = roundTo(szi + dir * closeSz, d);
      remaining = roundTo(remaining - closeSz, d);
      if (szi === 0) r.entry_px = null;
    }
    if (remaining > 0) {
      const held = Math.abs(szi);
      parts.push({ dir: dir > 0 ? 'Open Long' : 'Open Short', sz: remaining, closed_pnl: 0, start: szi });
      r.entry_px = held === 0 || !isPrice(r.entry_px) ? px : (held * r.entry_px + remaining * px) / (held + remaining);
      szi = roundTo(szi + dir * remaining, d);
    }
    r.szi = szi;
    for (const p of parts) {
      const fee = usd(p.sz * px * TESTNET_FEE_EST);
      const row = {
        bot: bot.id, coin: bot.coin, dir: p.dir, side, sz: p.sz, px, fee, closed_pnl: p.closed_pnl, time_ms: timeMs,
        tick: this.#tick(), venue: 'testnet', season: bot.season ?? this.season, oid: f.oid ?? null,
        order_id: f.order_id ?? null, provisional, start_position: p.start, liquidation: Boolean(f.liquidation),
      };
      try {
        this.repo?.insertFillNow(this.owner.uid, row);
      } catch (err) {
        this.log(`[live] garden ${this.owner.uid}: provisional fill not stored: ${err?.message || err}`);
      }
      bot.fills += 1;
      bot.fees += fee;
      bot.volume += p.sz * px;
      bot.realized_pnl += p.closed_pnl - fee;
      this.fillLog.push(row);
      this.fillsLogged += 1;
      this.journal.emit('bot_fill', {
        bot: bot.id, coin: bot.coin, dir: p.dir, sz: p.sz, px, fee, closed_pnl: p.closed_pnl, time_ms: timeMs,
        tick: row.tick, venue: 'testnet', provisional, oid: f.oid ?? null,
      });
    }
    if (provisional) bot.fees_estimated = true;
    if (szi === 0 && bot.exchange) {
      // The position episode ended: bank its funding (§6.11 Funding).
      bot.funding_realized = usd((bot.funding_realized || 0) + (bot.exchange.funding_since_open || 0));
      bot.exchange = { ...bot.exchange, funding_since_open: 0 };
    }
    bot.updated_ms = this.now();
    this.#markTestnet(bot);
    this.#touch(bot);
    this.#persistGarden();
    this.repo?.scheduleFlush();
    return bot.real.szi;
  }

  /**
   * One EXCHANGE fill that had no provisional counterpart (an order resolved by orderStatus after a transport failure
   * or a restart, or the exchange's own liquidation): the position moves by `delta` (weighted entry on adds), and the
   * fill row carries the exchange's fee, closed P&L, tid and raw dir — never estimates.
   */
  #applyExactFill(bot, f, { delta, px, timeMs, dir }) {
    const d = bot.sz_decimals;
    const r = bot.real;
    const x = f.exact;
    const before = r.szi;
    const after = roundTo(before + delta, d);
    if (before === 0 || Math.sign(before) === dir) {
      const held = Math.abs(before);
      r.entry_px = held === 0 || !isPrice(r.entry_px) ? px : (held * r.entry_px + Math.abs(delta) * px) / (held + Math.abs(delta));
    } else if (after === 0) {
      r.entry_px = null;
    } else if (Math.sign(after) !== Math.sign(before)) {
      r.entry_px = px; // flipped through zero: the new side opened at this fill's price
    }
    r.szi = after;
    const fee = Number(x.fee) || 0;
    const closedPnl = Number(x.closed_pnl) || 0;
    const row = {
      ...x, bot: bot.id, coin: bot.coin, sz: Math.abs(delta), px, fee, closed_pnl: closedPnl, time_ms: timeMs,
      venue: 'testnet', season: bot.season ?? this.season, order_id: f.order_id ?? null, provisional: false,
      liquidation: Boolean(f.liquidation || x.liquidation),
    };
    try {
      this.repo?.insertFillNow(this.owner.uid, row);
    } catch (err) {
      this.log(`[live] garden ${this.owner.uid}: exchange fill not stored: ${err?.message || err}`);
    }
    bot.fills += 1;
    bot.fees += fee;
    bot.volume += Math.abs(delta) * px;
    bot.realized_pnl += closedPnl - fee;
    this.fillLog.push(row);
    this.fillsLogged += 1;
    const ev = {
      bot: bot.id, coin: bot.coin, dir: row.dir, sz: row.sz, px, fee, closed_pnl: closedPnl, time_ms: timeMs,
      tick: this.#tick(), venue: 'testnet', provisional: false, oid: f.oid ?? null,
    };
    if (row.liquidation) ev.liquidation = true;
    this.journal.emit('bot_fill', ev);
    if (after === 0 && bot.exchange?.funding_since_open) {
      bot.funding_realized = usd((bot.funding_realized || 0) + bot.exchange.funding_since_open);
      bot.exchange = { ...bot.exchange, funding_since_open: 0 };
    }
    bot.updated_ms = this.now();
    this.#markTestnet(bot);
    this.#touch(bot);
    this.#persistGarden();
    this.repo?.scheduleFlush();
    return r.szi;
  }

  /** Pause ONE testnet bot from the venue with a flatten (insufficient_margin_repeat, leverage_rejected). */
  pauseTestnetBot(botId, why, noteCode, vars = null) {
    const bot = this.#requireTestnetBot(botId);
    if (!bot || bot.state !== 'active') return;
    this.#pauseTestnetInternal(bot, why, noteCode, vars);
    this.repo?.scheduleFlush();
    this.notifyChanged();
  }

  /**
   * Venue → garden: the fills sweep replaced provisional fills with exchange fills (already stored by the venue).
   * Recompute realized P&L, fees and volume from the DB rows (§6.11 sweep step 4) and emit bot_fill_confirmed
   * for each confirmed order. `confirmed` = [{ oid, sz, px, fee, closed_pnl, tids }].
   */
  confirmFills(botId, confirmed = [], { beyondHorizon = false } = {}) {
    const bot = this.#requireTestnetBot(botId);
    if (!bot) return;
    if (this.repo) {
      const rows = this.repo.botFills(this.owner.uid, bot.id);
      let realized = 0;
      let fees = 0;
      let volume = 0;
      let provisional = 0;
      for (const f of rows) {
        realized += f.closed_pnl - f.fee;
        fees += f.fee;
        volume += f.sz * f.px;
        if (f.provisional === 1) provisional++;
      }
      bot.realized_pnl = realized;
      bot.fees = fees;
      bot.volume = volume;
      bot.fills = rows.length;
      bot.fees_estimated = provisional > 0;
    }
    if (beyondHorizon) {
      bot.fees_estimated = true;
      if (!bot.note_code) {
        bot.note_code = 'fills_beyond_horizon';
        bot.note_vars = { coin: bot.coin };
      }
    }
    for (const c of confirmed) {
      this.journal.emit('bot_fill_confirmed', {
        bot: bot.id, coin: bot.coin, oid: c.oid ?? null, sz: c.sz, px: c.px, fee: usd(c.fee), closed_pnl: usd(c.closed_pnl),
        tids: Array.isArray(c.tids) ? c.tids : [],
      });
    }
    bot.updated_ms = this.now();
    this.#touch(bot);
    this.repo?.scheduleFlush();
  }

  /**
   * Venue → garden: the last `clearinghouseState` position of this bot's coin (§6.11 reconcile step 1).
   * `exch` = { szi, entry_px, unrealized_pnl, liquidation_px, margin_used, leverage, leverage_type, position_value,
   * funding_since_open } (numbers; funding_since_open already in P&L sign). Also derives `fill_state`.
   */
  applyExchangeSnapshot(botId, exch, { asOfMs = this.now(), lotSize = null } = {}) {
    const bot = this.#requireTestnetBot(botId);
    if (!bot || !exch) return;
    const prev = bot.exchange;
    bot.exchange = {
      as_of_ms: asOfMs,
      szi: Number(exch.szi) || 0,
      entry_px: isPrice(exch.entry_px) ? exch.entry_px : null,
      unrealized_pnl: Number(exch.unrealized_pnl) || 0,
      margin_used: Number(exch.margin_used) || 0,
      liquidation_px: isPrice(exch.liquidation_px) ? exch.liquidation_px : null,
      position_value: Number(exch.position_value) || 0,
      leverage: Number.isFinite(exch.leverage) ? exch.leverage : null,
      leverage_type: typeof exch.leverage_type === 'string' ? exch.leverage_type : null,
      funding_since_open: Number(exch.funding_since_open) || 0,
    };
    // A position that went flat (or flipped) between reconciles banks the last funding we saw (§6.11 Funding).
    if (prev && prev.szi !== 0 && (bot.exchange.szi === 0 || Math.sign(bot.exchange.szi) !== Math.sign(prev.szi))) {
      if (prev.funding_since_open) bot.funding_realized = usd((bot.funding_realized || 0) + prev.funding_since_open);
    }
    const lot = isPrice(lotSize) ? lotSize : 10 ** -bot.sz_decimals;
    // Our entry follows the exchange's once the books agree (more exact than our weighted provisional entry).
    if (Math.abs(bot.exchange.szi - bot.real.szi) < lot / 2 && bot.exchange.entry_px) bot.real.entry_px = bot.exchange.entry_px;
    bot.fill_state = this.#fillState(bot, lot);
    bot.updated_ms = this.now();
    this.#markTestnet(bot);
    this.#touch(bot);
  }

  #fillState(bot, lot) {
    const target = Number(bot.target_szi) || 0;
    const szi = bot.exchange ? bot.exchange.szi : bot.real.szi;
    const mid = isPrice(bot.mark_px) ? bot.mark_px : null;
    if (target === 0 && Math.abs(szi) < lot / 2) return 'waiting_bean';
    const gap = Math.abs(target - szi);
    if (gap < lot - 1e-12 || (mid !== null && gap * mid < this.cfg.minOrderUsd)) return 'in_sync';
    if (target !== 0 && Math.abs(szi) < lot / 2) return 'unfilled';
    if (szi !== 0 && Math.sign(szi) === Math.sign(target)) return 'partial';
    return 'partial';
  }

  /** Venue → garden: the account snapshot after a reconcile; emits `testnet_account` (§8.7). */
  applyTestnetAccount(account) {
    if (!account) return;
    this.testnetAccountSnap = { ...account };
    this.journal.emit('testnet_account', {
      account_value: account.account_value ?? null,
      account_value_est: Boolean(account.account_value_est),
      free: account.free ?? null,
      total_margin_used: account.total_margin_used ?? null,
      as_of_ms: account.as_of_ms ?? this.now(),
    });
  }

  /**
   * Venue → garden: progress of the bot's exchange work. `sync` = { op, state: 'pending'|'failed'|'done',
   * attempts, code?, error? }; 'done' clears exchange_sync. Emits `bot_sync`.
   */
  setSync(botId, sync) {
    const bot = this.#requireTestnetBot(botId);
    if (!bot || !sync) return;
    const now = this.now();
    if (sync.state === 'done') {
      this.#syncTries(bot, sync);
      bot.exchange_sync = null;
    } else {
      const same = bot.exchange_sync && bot.exchange_sync.op === sync.op;
      bot.exchange_sync = {
        op: sync.op,
        state: sync.state,
        since_ms: same ? bot.exchange_sync.since_ms : now,
        attempts: Number.isSafeInteger(sync.attempts) ? sync.attempts : this.#syncTries(bot, sync),
        code: sync.code ?? null,
        error: typeof sync.error === 'string' ? sync.error.slice(0, 300) : null,
      };
    }
    if (sync.fill_state && FILL_STATES.has(sync.fill_state)) bot.fill_state = sync.fill_state;
    bot.updated_ms = now;
    this.#touch(bot);
    const ev = { bot: bot.id, op: sync.op, state: sync.state, attempts: bot.exchange_sync?.attempts ?? sync.attempts ?? 0 };
    if (sync.code) ev.code = sync.code;
    if (sync.error) ev.error = String(sync.error).slice(0, 300);
    if (bot.fill_state) ev.fill_state = bot.fill_state;
    this.journal.emit('bot_sync', ev);
    this.repo?.scheduleFlush();
  }

  /**
   * Failed tries of each exchange op since it last succeeded (exchange_sync.attempts when the venue sends no count).
   * A retry runs `leverage → mirror` again from flat, so the count is kept per op and survives the op switching in
   * between; `done` for an op clears it (a done mirror or flatten also clears leverage). The client plays one dust
   * puff per failed attempt and shows "retrying" with the count (J3). Transient: a restart starts again at 0.
   */
  #syncTries(bot, sync) {
    const tries = bot.sync_tries && typeof bot.sync_tries === 'object' ? bot.sync_tries : (bot.sync_tries = {});
    if (sync.state === 'failed') tries[sync.op] = (tries[sync.op] ?? 0) + 1;
    if (sync.state === 'done') {
      delete tries[sync.op];
      if (sync.op !== 'leverage') delete tries.leverage;
    }
    return tries[sync.op] ?? 0;
  }

  /**
   * Venue → garden: an order row was written or changed (write-ahead insert, sent, outcome). Emits `bot_order`
   * with the venue fields; `inserted` counts it in bot.orders once.
   */
  orderUpdate(botId, order, { inserted = false } = {}) {
    const bot = this.#requireTestnetBot(botId);
    if (!bot || !order) return;
    if (inserted) {
      bot.orders += 1;
      this.orderLog.push(order);
      this.#touch(bot);
    }
    const ev = {
      bot: bot.id, coin: bot.coin, order_kind: order.kind, sz: order.sz, px: order.px ?? null, status: order.status,
      reason: order.reason ?? null, venue: 'testnet', cloid: order.cloid ?? null,
    };
    if (order.code) ev.code = order.code;
    this.journal.emit('bot_order', ev);
  }

  /** Venue → garden: an exchange error on one bot (keyed per situation, §6.9 rule 2): live_error with `code`. */
  exchangeError(botId, code, message, vars = null) {
    const bot = this.#requireTestnetBot(botId);
    if (!bot) {
      // Account-level (no bot): one line per situation.
      const key = `-|${code}`;
      if (this.lastErrorKey !== key) {
        this.lastError = message;
        this.lastErrorMs = this.now();
        this.lastErrorKey = key;
        this.journal.emit('live_error', { bot: null, error: message, code, ...(vars ? { vars } : {}) });
      }
      return;
    }
    this.#setError(bot, message, code, { code, vars });
    this.#touch(bot);
  }

  /** Venue → garden: clear a bot's exchange error once its situation is resolved. */
  clearExchangeError(botId) {
    const bot = this.#requireTestnetBot(botId);
    if (bot && bot.last_error) {
      this.#clearError(bot);
      this.#touch(bot);
    }
  }

  /**
   * Venue → garden: the flatten of a PAUSING bot completed (the exchange position on its coin is flat). Emits
   * `bot_paused` with the note code. A CLOSING bot is completed by closeConfirmed() after the completion sweep.
   */
  flattenDone(botId) {
    const bot = this.#requireTestnetBot(botId);
    // Only a PAUSED (or closing) bot completes a flatten: a bot the player resumed meanwhile is active, and must
    // never be announced as paused. `dust` is the venue's to clear (it stays shown while the exchange holds it).
    if (!bot || bot.state === 'closed' || (bot.state !== 'paused' && !bot.closing)) return;
    bot.exchange_sync = null;
    bot.updated_ms = this.now();
    this.#touch(bot);
    if (bot.closing) return;
    const ev = { bot: bot.id, reason: bot.note ?? 'manual' };
    if (bot.note_code) ev.note_code = bot.note_code;
    if (bot.note_vars) ev.note_vars = bot.note_vars;
    this.journal.emit('bot_paused', ev);
    this.repo?.scheduleFlush();
    this.notifyChanged();
  }

  /**
   * Venue → garden: pause WITHOUT any order (drift, external close, liquidation, revoked credential, §6.11 step 4):
   * whose position it is cannot be told, so nothing is sent. The player resumes (adopt) or closes.
   */
  pauseFromExchange(botId, noteCode, vars = null, { why = null } = {}) {
    const bot = this.#requireTestnetBot(botId);
    if (!bot || bot.state === 'closed') return;
    bot.state = 'paused';
    bot.note_code = noteCode;
    bot.note_vars = vars;
    bot.note = why ?? noteCode.replace(/_/g, ' ');
    bot.target_szi = 0;
    bot.exchange_sync = null;
    bot.updated_ms = this.now();
    this.#touch(bot);
    const ev = { bot: bot.id, reason: bot.note, note_code: noteCode };
    if (vars) ev.note_vars = vars;
    if (noteCode === 'liquidated_testnet') ev.liquidation = true;
    this.journal.emit('bot_paused', ev);
    this.repo?.scheduleFlush();
    this.notifyChanged();
  }

  /**
   * Venue → garden: a closing bot is flat and the completion sweep ran (`confirmed`) or failed (`confirmed:false`,
   * provisional numbers). The bot retires: closed, coin and bean unbound, `bot_closed` (§6.11 Close).
   */
  closeConfirmed(botId, { confirmed = true } = {}) {
    const bot = this.#requireTestnetBot(botId);
    if (!bot || bot.state === 'closed') return;
    this.#retireTestnet(bot, { confirmed });
  }

  /** Close a testnet bot in our books only (no orders): take-over of its account (account_moved), forced deletes. */
  closeInBooks(botId, noteCode = null) {
    const bot = this.#requireTestnetBot(botId);
    if (!bot || bot.state === 'closed') return;
    if (noteCode) {
      bot.note_code = noteCode;
      bot.note = noteCode.replace(/_/g, ' ');
    }
    this.#retireTestnet(bot, { confirmed: false, noteCode });
  }

  #retireTestnet(bot, { confirmed, noteCode = null }) {
    const now = this.now();
    if (bot.exchange?.funding_since_open) {
      bot.funding_realized = usd((bot.funding_realized || 0) + bot.exchange.funding_since_open);
      bot.exchange = { ...bot.exchange, funding_since_open: 0 };
    }
    bot.state = 'closed';
    bot.closing = false;
    bot.closed_ms = now;
    bot.updated_ms = now;
    bot.target_szi = 0;
    bot.exchange_sync = null;
    // A closed bot holds nothing: its exchange position was flattened (or closed outside the garden).
    Object.assign(bot.real, { szi: 0, entry_px: null, unrealized_pnl: 0, margin_used: 0, liquidation_px: null });
    bot.notional_usd = 0;
    this.#clearError(bot);
    this.#unbind(bot);
    this.#touch(bot);
    const ev = {
      bot: bot.id, realized_pnl: usd(bot.realized_pnl), venue: 'testnet', funding: usd(bot.funding_realized || 0), confirmed,
    };
    if (noteCode) ev.note_code = noteCode;
    this.journal.emit('bot_closed', ev);
    this.#persistGarden();
    this.repo?.scheduleFlush();
    this.notifyChanged();
  }

  /** Testnet ledger part of `mids` (garden part, per subscriber). */
  #testnetLedgerMarks() {
    const l = this.#testnetLedger();
    return {
      account_value: l.account_value,
      account_value_est: l.account_value_est,
      free: l.free,
      total_margin_used: l.total_margin_used,
      open_notional_usd: l.open_notional_usd,
      unrealized_pnl_est: l.unrealized_pnl_est,
      as_of_ms: l.as_of_ms,
    };
  }

  /** venues.testnet of live_status (§8.4): the exchange's account (cached) plus our attribution. */
  #testnetLedger() {
    let notional = 0;
    let realized = 0;
    let funding = 0;
    let unrealized = 0;
    let open = 0;
    for (const b of this.botList) {
      if (venueOf(b) !== 'testnet') continue;
      realized += b.realized_pnl;
      funding += (b.funding_realized || 0) + (b.state !== 'closed' ? b.exchange?.funding_since_open || 0 : 0);
      if (b.state === 'closed') continue;
      open++;
      notional += b.notional_usd;
      unrealized += b.real.unrealized_pnl;
    }
    const v = this.testnet;
    const link = v?.link?.() ?? null;
    const acct = this.testnetAccountSnap ?? v?.account?.() ?? null;
    return {
      enabled: true,
      connected: Boolean(link && (link.status === 'verified' || link.status === 'pending')),
      state: v?.state?.() ?? 'disabled',
      credential_status: link?.status ?? null,
      kill_switch: v?.killSwitch?.() ?? { on: false, reason: null, since_ms: null },
      account_address: truncAddr(link?.account_address ?? null),
      abstraction: link?.abstraction ?? null,
      account_value: acct?.account_value ?? null,
      account_value_est: Boolean(acct?.account_value_est),
      balance: acct?.balance ?? null,
      free: acct?.free ?? null,
      value_at_connect: link?.value_at_connect ?? null,
      connected_ms: link?.verified_ms ?? link?.connected_ms ?? null,
      total_margin_used: acct?.total_margin_used ?? null,
      open_notional_usd: usd(notional),
      as_of_ms: acct?.as_of_ms ?? null,
      realized_pnl: usd(realized),
      funding: usd(funding),
      unrealized_pnl_est: usd(unrealized),
      bots_open: open,
      caps: this.caps().testnet,
    };
  }

  // ---- errors ------------------------------------------------------------------------------------

  /**
   * Record an error on `bot`. `key` names the SITUATION (e.g. 'notional_cap'): the message may carry live
   * numbers that move with every price, so only a new key (or a fresh error) stamps `last_error_ms` and emits
   * `live_error`; while the same situation persists the text is refreshed quietly. Defaults to the message.
   * Accounts mode adds the machine `code` (the key, or `extra.code`) to the event.
   */
  #setError(bot, message, key = message, extra = null) {
    const now = this.now();
    const isNew = bot.last_error == null || bot.error_key !== key;
    bot.last_error = message;
    bot.error_key = key;
    if (isNew || bot.last_error_ms == null) bot.last_error_ms = now;

    // Account line: the most recent NEW error; its own text keeps refreshing, other bots don't overwrite it.
    const acctKey = `${bot.id}|${key}`;
    if (isNew || this.lastError == null || this.lastErrorKey === acctKey) {
      if (isNew || this.lastErrorKey !== acctKey || this.lastErrorMs == null) this.lastErrorMs = now;
      this.lastError = `${bot.id}: ${message}`;
      this.lastErrorKey = acctKey;
    }
    if (this.accounts) {
      // the machine code rides the BotRow too (§8.5 additive `last_error_code`), so a client that reloads can still
      // localize the error without the live_error event (§9.5)
      bot.error_code = extra?.code ?? PAPER_ERROR_CODES[key] ?? 'conflict';
      bot.error_vars = extra?.vars && typeof extra.vars === 'object' ? { ...extra.vars } : null;
    }
    if (isNew) {
      if (this.accounts) {
        const ev = { bot: bot.id, error: message, code: bot.error_code, venue: venueOf(bot) };
        if (extra?.vars) ev.vars = extra.vars;
        this.journal.emit('live_error', ev);
        this.#touch(bot);
      } else {
        this.journal.emit('live_error', { bot: bot.id, error: message });
      }
    }
  }

  #clearError(bot) {
    if (this.repo && bot.last_error != null) this.#touch(bot);
    bot.last_error = null;
    bot.last_error_ms = null;
    bot.error_key = null;
    if (this.accounts) {
      bot.error_code = null;
      bot.error_vars = null;
    }
  }

  // ---- eligibility -------------------------------------------------------------------------------

  /** First reason `row` cannot be bound (ignoring bindings held by `self`), or null when it can. */
  #unavailableReason(row, info, self) {
    if (this.halted) return 'halted';
    if (!info) return 'unlisted';
    if (row.busted) return 'busted';
    const beanBot = this.openByBean.get(row.id);
    if (beanBot && beanBot !== self) return 'bean_bound';
    const coinBot = this.openByCoin.get(row.coin);
    if (coinBot && coinBot !== self) return 'coin_bound';
    if (requiredLeverage(row) > info.max_leverage + 1e-9) return 'leverage';
    return null;
  }

  /** Binding conflicts only (bean/coin, across venues) — the testnet checks use this for §7.3 check 9. */
  bindingConflict(row, self = null) {
    const beanBot = this.openByBean.get(row.id);
    if (beanBot && beanBot !== self) return { reason: 'bean_bound', bot: beanBot.id };
    const coinBot = this.openByCoin.get(row.coin);
    if (coinBot && coinBot !== self) return { reason: 'coin_bound', bot: coinBot.id };
    return null;
  }

  #explain(reason, row, info) {
    switch (reason) {
      case 'halted':
        return this.accounts ? 'your field is burned' : 'the live layer is halted';
      case 'unlisted':
        return `${row.coin} is not listed on the sim venue`;
      case 'busted':
        return `bean ${row.id} is busted`;
      case 'bean_bound':
        return `bean ${row.id} is already bound to ${this.openByBean.get(row.id)?.id}`;
      case 'coin_bound':
        return `${row.coin} is already bound to ${this.openByCoin.get(row.coin)?.id} (one bot per coin)`;
      case 'leverage':
        return `sizes entries at ${requiredLeverage(row).toFixed(1)}× equity; ${row.coin} allows ${info.max_leverage}×`;
      default:
        return reason;
    }
  }

  // ---- bookkeeping -------------------------------------------------------------------------------

  /**
   * A new bot. None mode keeps today's exact field set (and so today's JSON state); accounts mode adds the venue
   * fields of §7.1 #1. `tn` (testnet) carries the venue's verdict: {info, leverage, asset}.
   */
  #newBot(row, info, capital, venue = 'paper', tn = null) {
    const index = this.nextIndex++;
    const now = this.now();
    const leverage = venue === 'testnet' && Number.isFinite(tn?.leverage)
      ? tn.leverage
      : Math.min(Number(row.leverage) || 1, info.max_leverage);
    const perEntry = entryNotional(row, capital);
    const bot = {
      id: botId(index),
      index,
      bean: row.id,
      coin: row.coin,
      capital_usd: capital,
      leverage,
      state: 'active',
      created_ms: now,
      updated_ms: now,
      closed_ms: null,
      bean_side: beanSide(row),
      bean_units: Number(row.units) || 0,
      bean_equity: Number(row.equity) || 0,
      target_sz: 0,
      sz_decimals: Number.isInteger(info.sz_decimals) ? info.sz_decimals : 0,
      // testnet: the TESTNET listing's cap (it can differ from mainnet's), so the UI never shows the mainnet one
      ...(venue === 'testnet' ? { venue_max_leverage: Number(info.max_leverage) || null } : {}),
      fills: 0,
      orders: 0,
      volume: 0,
      fees: 0,
      realized_pnl: 0,
      notional_usd: 0,
      last_error: null,
      last_error_ms: null,
      last_reconcile_ms: null,
      note:
        venue === 'paper' && perEntry < this.cfg.minOrderUsd
          ? `entries ≈ $${perEntry.toFixed(2)} are below the $${this.cfg.minOrderUsd} minimum order — more water needed`
          : null,
      real: { szi: 0, entry_px: null, unrealized_pnl: 0, margin_used: 0, liquidation_px: null, leverage, as_of_ms: now },
      // internal (not part of BotRow)
      mark_px: null,
      mark_ms: null,
      price_stale: false,
      skip_key: null,
      error_key: null, // situation behind last_error (see #setError)
    };
    if (this.accounts) {
      Object.assign(bot, {
        venue,
        season: this.season,
        asset: venue === 'testnet' && Number.isInteger(tn?.asset) ? tn.asset : null,
        size_ratio: null,
        exchange: null,
        exchange_sync: null,
        closing: false,
        fees_estimated: false,
        target_szi: venue === 'testnet' ? 0 : null,
        fill_state: null,
        funding_realized: 0,
        note_code: null,
        note_vars: null,
        dust: null,
      });
    }
    this.botList.push(bot);
    this.byId.set(bot.id, bot);
    this.#bind(bot);
    this.#persistGarden();
    return bot;
  }

  #bind(bot) {
    this.openByBean.set(bot.bean, bot);
    this.openByCoin.set(bot.coin, bot);
  }

  #unbind(bot) {
    if (this.openByBean.get(bot.bean) === bot) this.openByBean.delete(bot.bean);
    if (this.openByCoin.get(bot.coin) === bot) this.openByCoin.delete(bot.coin);
  }

  /** Bots in the PAPER ledger: paper bots of the current season (and any open paper bot). */
  #inPaperLedger(b) {
    if (venueOf(b) !== 'paper') return false;
    return !this.accounts || b.state !== 'closed' || (b.season ?? 1) === this.season;
  }

  /** Bot counts of the garden (accounts mode: both venues; closed counts the current season + testnet). */
  #counts() {
    let active = 0;
    let paused = 0;
    let closed = 0;
    let total = 0;
    for (const b of this.botList) {
      if (b.state === 'closed' && venueOf(b) === 'paper' && (b.season ?? 1) !== this.season) continue;
      total++;
      if (b.state === 'active') active++;
      else if (b.state === 'paused') paused++;
      else closed++;
    }
    return { active, paused, closed, total };
  }

  /**
   * Account aggregates (raw numbers) of the PAPER ledger. account_value = start + Σ realized + Σ unrealized.
   * `available` (cash a new bot may take) = account_value − Σ max(water, initial margin) over open bots:
   * water scales the bean's paper size, it does not cap it, so a bean whose equity has grown past
   * 1000 / position_size makes the bot post MORE isolated margin than its water — that cash is tied up too.
   * With paper-only gardens (none mode) these are exactly today's numbers.
   */
  #account() {
    let active = 0;
    let paused = 0;
    let closed = 0;
    let deployed = 0;
    let reserved = 0;
    let notional = 0;
    let realized = 0;
    let unrealized = 0;
    let margin = 0;
    for (const b of this.botList) {
      if (!this.#inPaperLedger(b)) continue;
      realized += b.realized_pnl;
      if (b.state === 'closed') {
        closed++;
        continue;
      }
      if (b.state === 'active') active++;
      else paused++;
      deployed += b.capital_usd;
      reserved += Math.max(b.capital_usd, initialMargin(b));
      notional += b.notional_usd;
      unrealized += b.real.unrealized_pnl;
      margin += b.real.margin_used;
    }
    const accountValue = this.cfg.accountUsd + realized + unrealized;
    const available = Math.max(0, accountValue - reserved);
    return { active, paused, closed, deployed, notional, realized, unrealized, margin, accountValue, available };
  }

  /** Σ open notional of every open PAPER bot except `except` (last marks). */
  #openNotional(except) {
    let sum = 0;
    for (const b of this.openByCoin.values()) if (b !== except && venueOf(b) === 'paper') sum += b.notional_usd;
    return sum;
  }

  /** Σ open notional of the testnet bots (at testnet mids) — the testnet notional cap (§7.3). */
  testnetNotional(except = null) {
    let sum = 0;
    for (const b of this.openByCoin.values()) if (b !== except && venueOf(b) === 'testnet') sum += b.notional_usd;
    return sum;
  }

  #find(id) {
    if (id == null || id === '') throw new ApiError(400, 'id is required', this.#code('bad_request'));
    const text = String(id).trim();
    const bot = /^\d+$/.test(text) ? this.byId.get(botId(Number(text))) : this.byId.get(text);
    if (!bot) throw new ApiError(404, `unknown bot ${text}`, this.#code('not_found'));
    return bot;
  }

  /** Newest-first rows of a log, optionally for one bot. */
  #logRows(ring, botFilter, limit) {
    const rows = [];
    let total = 0;
    for (const rec of ring.newestFirst()) {
      if (botFilter && rec.bot !== botFilter) continue;
      if (rows.length < limit) rows.push(rec);
      total++;
    }
    return { rows, total };
  }

  #toRow(b) {
    const r = b.real;
    const row = {
      id: b.id,
      index: b.index,
      bean: b.bean,
      coin: b.coin,
      capital_usd: b.capital_usd,
      leverage: b.leverage,
      state: b.state,
      created_ms: b.created_ms,
      updated_ms: b.updated_ms,
      closed_ms: b.closed_ms,
      bean_side: b.bean_side,
      bean_units: b.bean_units,
      bean_equity: b.bean_equity,
      target_sz: b.target_sz,
      sz_decimals: b.sz_decimals,
      fills: b.fills,
      orders: b.orders,
      volume: usd(b.volume),
      fees: usd(b.fees),
      realized_pnl: usd(b.realized_pnl),
      notional_usd: usd(b.notional_usd),
      last_error: b.last_error,
      last_error_ms: b.last_error_ms,
      last_reconcile_ms: b.last_reconcile_ms,
      note: b.note,
      mark_px: px10(b.mark_px),
      mark_ms: b.mark_ms ?? null,
      price_stale: this.#priceStale(b),
      real: {
        szi: r.szi,
        entry_px: px10(r.entry_px),
        unrealized_pnl: usd(r.unrealized_pnl),
        margin_used: usd(r.margin_used),
        liquidation_px: px10(r.liquidation_px),
        leverage: r.leverage,
        as_of_ms: r.as_of_ms,
      },
    };
    if (!this.accounts) return row;
    // PLATFORM §8.5 additions (accounts mode only; none mode rows are byte-identical).
    const tn = venueOf(b) === 'testnet';
    row.venue = venueOf(b);
    row.price_source = tn ? 'hyperliquid-testnet' : this.#prices() === 'real' ? 'hyperliquid' : 'sim';
    row.asset = tn && Number.isInteger(b.asset) ? b.asset : null;
    row.venue_max_leverage = tn && Number.isFinite(b.venue_max_leverage) ? b.venue_max_leverage : null;
    row.closing = Boolean(b.closing);
    row.exchange_sync = b.exchange_sync ? { ...b.exchange_sync } : null;
    row.exchange = tn && b.exchange ? { ...b.exchange } : null;
    row.size_ratio = tn && b.size_ratio
      ? { k: b.size_ratio.k, mainnet_px: b.size_ratio.mainnet_px, testnet_px: b.size_ratio.testnet_px, at_ms: b.size_ratio.at_ms }
      : null;
    row.target_szi = tn ? (Number.isFinite(b.target_szi) ? b.target_szi : 0) : null;
    row.fill_state = tn ? b.fill_state ?? null : null;
    row.funding_realized = tn ? usd(b.funding_realized || 0) : 0;
    row.fees_estimated = Boolean(b.fees_estimated);
    row.est = tn && r.szi ? (r.margin_est ? ['unrealized_pnl', 'margin_used'] : ['unrealized_pnl']) : null;
    row.dust = tn && b.dust ? { szi: b.dust.szi } : null;
    row.note_code = b.note_code ?? null;
    row.note_vars = b.note_vars ?? null;
    row.last_error_code = b.last_error != null ? b.error_code ?? null : null;
    row.last_error_vars = b.last_error != null && b.error_vars ? { ...b.error_vars } : null;
    row.season = b.season ?? this.season;
    return row;
  }

  // ---- engine access (defensive) -------------------------------------------------------------------

  #beanRow(id) {
    return this.engine.population?.row(id) ?? null;
  }

  #coinInfo(coin) {
    if (typeof coin !== 'string' || !coin) return null;
    const info = this.engine.market?.coinInfo(coin);
    return info && Number(info.max_leverage) > 0 ? info : null;
  }

  /** Price to trade/mark at: the bar close inside a tick; the live price (≤ 15 s old mid) outside one. */
  #mid(coin) {
    const m = this.engine.market;
    const mid = !this.inTick && typeof m?.livePx === 'function' ? m.livePx(coin) : m?.mid(coin);
    return isPrice(mid) ? mid : null;
  }

  /** The MAINNET mid of a coin (bar close inside a tick, live mid outside) — the venue's sizing input. */
  mainnetMid(coin) {
    return this.#mid(coin);
  }

  /** True while the engine replays missed minutes (catch-up after an outage or a restart). */
  #replaying() {
    return Boolean(this.engine?.catchingUp);
  }

  /**
   * Is the coin's price unusable right now (its bots freeze)? Inside a tick or a catch-up replay the answer
   * comes from the bar being applied (flat = stale; candle or mids = live): the wall-clock age of the last mid
   * says nothing about a replayed bar, and judging by it would skip every bot during a replay. Outside a tick
   * it is the market's live staleness (flat last bar, or no mid for > 60 s).
   */
  #isStale(coin) {
    const m = this.engine.market;
    if (this.inTick && typeof m?.isBarStale === 'function') return Boolean(m.isBarStale(coin));
    return typeof m?.isStale === 'function' ? Boolean(m.isStale(coin)) : false;
  }

  /** Mainnet staleness of a coin (a stale mainnet coin freezes the bean, so a testnet target holds, §6.11). */
  mainnetStale(coin) {
    return this.#isStale(coin);
  }

  /**
   * When the price #mid(coin) returns is from: the bar close inside a tick (real), the mid's receive time or
   * the last bar close outside one (market.liveQuote). Marks carry this, never "now", so an old price is
   * never shown (or merged) as a fresh one. Falls back to now for markets without the accessors (sim/tests).
   */
  #priceMs(coin) {
    const m = this.engine.market;
    const now = this.now();
    if (this.inTick) {
      const t = m?.real && typeof m.tickTimeMs === 'function' ? m.tickTimeMs() : null;
      return Number.isFinite(t) ? Math.min(t, now) : now;
    }
    const q = typeof m?.liveQuote === 'function' ? m.liveQuote(coin) : null;
    return Number.isFinite(q?.ms) ? Math.min(q.ms, now) : now;
  }

  /**
   * BotRow/marks `price_stale`, computed at read time: the stored flag only changes inside markLive/reconcile,
   * and neither runs during an outage (no mids, ticks held), so an open bot on a coin that is stale NOW is
   * flagged even before the next mark (SPEC: a bot on a stale coin reports price_stale: true).
   */
  #priceStale(b) {
    if (b.state === 'closed') return false;
    if (venueOf(b) === 'testnet') return Boolean(b.price_stale);
    return Boolean(b.price_stale) || (!this.inTick && this.#isStale(b.coin));
  }

  /** Oldest mark time among open positioned bots (what account_state.as_of_ms reports); now when none. */
  #marksAsOf() {
    let oldest = null;
    for (const b of this.botList) {
      if (b.state === 'closed' || !b.real?.szi || venueOf(b) !== 'paper') continue;
      const t = Number(b.real.as_of_ms);
      if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
    }
    return oldest ?? this.now();
  }

  #staleCoins() {
    const m = this.engine.market;
    try {
      return typeof m?.staleCoins === 'function' ? m.staleCoins() : [];
    } catch {
      return [];
    }
  }

  #prices() {
    const p = this.engine.prices;
    if (p === 'real' || p === 'sim') return p;
    return this.engine.market?.source === 'hyperliquid' ? 'real' : 'sim';
  }

  /** 409 when the engine says new exposure must wait (real prices down, catching up, stale coin). */
  #assertCanOpen(coin) {
    const why = typeof this.engine.canOpen === 'function' ? this.engine.canOpen(coin) : null;
    if (why) throw new ApiError(409, why, this.#code('stale'));
  }

  /** Why the engine refuses new exposure on `coin` right now (null = it may open) — testnet check 10. */
  canOpenReason(coin) {
    return typeof this.engine.canOpen === 'function' ? this.engine.canOpen(coin) : null;
  }

  /** The machine code of an error in accounts mode; none mode errors carry no code (byte-identical payloads). */
  #code(code) {
    return this.accounts ? code : null;
  }

  #accountsOnly(op) {
    if (!this.accounts) throw new ApiError(404, `${op} exists only in accounts mode`, 'accounts_disabled');
  }

  /** The `season` param of paper queries: the current season unless a valid older one is asked for. */
  #seasonParam(season) {
    const n = Number(season);
    if (season == null || season === '' || !Number.isSafeInteger(n) || n < 1 || n > this.season) return this.season;
    return n;
  }

  #takerPx(mid, delta) {
    return mid * (1 + Math.sign(delta) * SLIPPAGE);
  }

  /** Fill/order stamp: tick time inside a tick, the market clock outside (see the file header). */
  #fillTime() {
    const m = this.engine.market;
    const fn = this.inTick ? m?.tickTimeMs : m?.clockMs;
    const t = typeof fn === 'function' ? fn.call(m) : m?.timeMs;
    return Number.isFinite(t) ? t : this.now();
  }

  /** Tick of the last afterTick; else whatever counter the engine exposes (a method is ignored). */
  #tick() {
    if (Number.isFinite(this.lastTick)) return this.lastTick;
    const e = this.engine;
    for (const v of [e.tickCount, e.ticks, e.tick]) if (Number.isFinite(v)) return v;
    return null;
  }

  #universeCount() {
    if (this.universeCoins == null) {
      const m = this.engine.market;
      try {
        const snap = typeof m?.snapshot === 'function' ? m.snapshot() : null;
        if (Array.isArray(snap)) this.universeCoins = snap.length;
        else if (Array.isArray(m?.coins)) this.universeCoins = m.coins.length;
      } catch {
        /* unknown universe size: report null */
      }
    }
    return this.universeCoins;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate/normalise one persisted bot; null when unusable. `accounts` keeps (and validates) the venue fields of
 * PLATFORM §7.1 #1; a missing venue means 'paper'. Without it (none mode) the result is exactly today's shape.
 */
function sanitizeBot(raw, { accounts = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const { index, bean, coin, state } = raw;
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(bean) || typeof coin !== 'string' || !BOT_STATES.has(state)) return null;
  const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
  const orNull = (v) => (Number.isFinite(v) ? v : null);
  const real = raw.real && typeof raw.real === 'object' ? raw.real : {};
  const leverage = num(raw.leverage, 1) || 1;
  // A position is only meaningful with an entry price; closed bots hold nothing.
  const szi = state !== 'closed' && isPrice(real.entry_px) ? num(real.szi) : 0;
  const bot = {
    id: botId(index),
    index,
    bean,
    coin,
    capital_usd: num(raw.capital_usd),
    leverage,
    state,
    created_ms: orNull(raw.created_ms),
    updated_ms: orNull(raw.updated_ms),
    closed_ms: orNull(raw.closed_ms),
    bean_side: num(raw.bean_side),
    bean_units: num(raw.bean_units),
    bean_equity: num(raw.bean_equity),
    target_sz: num(raw.target_sz),
    sz_decimals: Number.isInteger(raw.sz_decimals) ? raw.sz_decimals : 0,
    fills: num(raw.fills),
    orders: num(raw.orders),
    volume: num(raw.volume),
    fees: num(raw.fees),
    realized_pnl: num(raw.realized_pnl),
    notional_usd: num(raw.notional_usd),
    last_error: typeof raw.last_error === 'string' ? raw.last_error : null,
    last_error_ms: orNull(raw.last_error_ms),
    last_reconcile_ms: orNull(raw.last_reconcile_ms),
    note: typeof raw.note === 'string' ? raw.note : null,
    real: {
      szi,
      entry_px: szi ? real.entry_px : null,
      unrealized_pnl: num(real.unrealized_pnl),
      margin_used: num(real.margin_used),
      liquidation_px: orNull(real.liquidation_px),
      leverage,
      as_of_ms: orNull(real.as_of_ms),
    },
    mark_px: orNull(raw.mark_px),
    mark_ms: orNull(raw.mark_ms),
    price_stale: raw.price_stale === true,
    skip_key: null,
    error_key: typeof raw.last_error === 'string' && typeof raw.error_key === 'string' ? raw.error_key : null,
  };
  if (!accounts) return bot;
  const venue = raw.venue === 'testnet' ? 'testnet' : 'paper';
  const tn = venue === 'testnet';
  // A testnet bot's expected position may be non-zero without a known entry (adopted from the exchange): keep it.
  if (tn && state !== 'closed' && Number.isFinite(real.szi)) {
    bot.real.szi = real.szi;
    bot.real.entry_px = isPrice(real.entry_px) ? real.entry_px : null;
  }
  const sync = isObj(raw.exchange_sync) && ['leverage', 'mirror', 'flatten'].includes(raw.exchange_sync.op)
    ? {
      op: raw.exchange_sync.op,
      state: raw.exchange_sync.state === 'failed' ? 'failed' : 'pending',
      since_ms: orNull(raw.exchange_sync.since_ms),
      attempts: Number.isSafeInteger(raw.exchange_sync.attempts) ? raw.exchange_sync.attempts : 0,
      code: typeof raw.exchange_sync.code === 'string' ? raw.exchange_sync.code : null,
      error: typeof raw.exchange_sync.error === 'string' ? raw.exchange_sync.error : null,
    }
    : null;
  Object.assign(bot, {
    venue,
    season: Number.isSafeInteger(raw.season) && raw.season >= 1 ? raw.season : 1,
    asset: tn && Number.isInteger(raw.asset) ? raw.asset : null,
    size_ratio: tn && isObj(raw.size_ratio) && isPrice(raw.size_ratio.k) ? { ...raw.size_ratio } : null,
    exchange: tn && isObj(raw.exchange) ? { ...raw.exchange } : null,
    exchange_sync: tn ? sync : null,
    closing: tn && raw.closing === true && state !== 'closed',
    fees_estimated: raw.fees_estimated === true,
    target_szi: tn ? num(raw.target_szi) : null,
    fill_state: tn && FILL_STATES.has(raw.fill_state) ? raw.fill_state : null,
    funding_realized: num(raw.funding_realized),
    note_code: typeof raw.note_code === 'string' ? raw.note_code : null,
    note_vars: isObj(raw.note_vars) ? { ...raw.note_vars } : null,
    error_code: typeof raw.last_error === 'string' && typeof raw.error_code === 'string' ? raw.error_code : null,
    error_vars: typeof raw.last_error === 'string' && isObj(raw.error_vars) ? { ...raw.error_vars } : null,
    // `target` (internal) keeps "not retried until the target changes" true across a restart (§6.11 step 5).
    dust: tn && isObj(raw.dust) && Number.isFinite(raw.dust.szi)
      ? (Number.isFinite(raw.dust.target) ? { szi: raw.dust.szi, target: raw.dust.target } : { szi: raw.dust.szi })
      : null,
  });
  return bot;
}

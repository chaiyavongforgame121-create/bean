// server/garden/testnet-venue.js — one player's Hyperliquid TESTNET venue (PLATFORM §6.11, §7.1 #3–4, §7.3).
//
// A TestnetVenue drives the testnet bots of ONE garden (LiveLayer). It never touches mainnet: every order goes through
// WP2's exchange client, whose URL is frozen to the testnet and whose signer hard-codes the testnet source.
//
// Work runs on the player's SERIAL LANE (WP2 HlScheduler.lane(uid, epoch)): nonces are strictly increasing and never
// concurrent, and every job captures the garden epoch — after teardown(uid) the lane is cancelled and any job or
// retry timer of the old garden aborts (LaneAbortError) before it touches a credential or a bot (§2.2, §7.2).
//
//   planTarget(bot, row)   afterTick (not while catching up): the dollar-matched target with a frozen k (sizing)
//   requestSync()          one sync job per bar: reconcile → resolve unresolved orders → fills sweep when needed →
//                          drift check → mirror (§6.11 Sync)
//   requestFlatten(bot)    pause / close / halt / kill / expiry / inactivity: reduce-only IOC at P0 with widening
//                          slippage (1% → 2.5% → 5%, then every 15 s at 5%); a closing bot is retired only after the
//                          completion sweep (closeConfirmed {confirmed})
//   onCreate / onResume    leverage (before every open from flat) and the opening IOC
//   boot()                 restart: resolve pending/sent/unknown orders by cloid, reconcile, re-issue flatten intents
//   checkCreate / quote    the §7.3 checks in order (the plant dialog uses the stake-independent 1–11)
//
// Results reach the garden only through its venue callbacks (applyExchangeFill, confirmFills, applyExchangeSnapshot,
// applyTestnetAccount, setSync, orderUpdate, exchangeError, flattenDone, pauseFromExchange, closeConfirmed), which
// persist through the repo and emit through the player's journal facade — never the global journal.
//
// Dependencies (injected; PLATFORM §12.2):
//   hl   = createTestnet() → { scheduler, info, market, exchange }   (WP2)
//   lib  = { wire, format, errors, constants }                        (WP2 server/hl/* modules)
//   credentials (this package: withSigner), repo (this package), gardens (kill switch, signing halt, capacity)
//
// Sign convention (pinned by the reconciliation test, runbook R6): Hyperliquid's `cumFunding.sinceOpen` is funding
// PAID (positive = cost), so a bot's funding P&L is −sinceOpen; `userFunding[].delta.usdc` is already P&L-signed.

import {
  ApiError, beanSide, entryNotional, requiredLeverage, venueOf, CAPITAL_PER_BEAN, LIQUIDATION_FRACTION,
} from '../live.js';

export const FAUCET_URL = 'https://app.hyperliquid-testnet.xyz/drip';
/** A testnet mid older than this freezes mirroring for its coin (§6.11 Stale prices). */
export const TESTNET_MID_MAX_AGE_MS = 60_000;
/** Flatten retry cadence once the slippage steps are used up, and for impossible flattens (§6.11 Pause). */
export const FLATTEN_RETRY_MS = 15_000;
/** ioc_no_match retry spacing for flattens (§6.9). */
export const IOC_RETRY_MS = 2_000;
/** An order still answering unknownOid this long after it was sent never reached the book (§6.11 step 2). */
export const UNKNOWN_OID_CANCEL_MS = 60_000;
/**
 * Fills sweep cadence in bars (§6.8): every 5 bars while provisional fills exist, otherwise every 30. Degradation step 1
 * STRETCHES the provisional cadence to 10 bars under weight pressure (the idle cadence stays 30, never shorter).
 */
export const SWEEP_EVERY = Object.freeze({ provisional: 5, idle: 30, degraded: 10 });
/** A cadence sweep that cannot START within this long is skipped and retried next bar (orders never wait on it). */
export const SWEEP_MAX_WAIT_MS = 10_000;
/** userFunding pages read at close completion (500 rows each); beyond this the reconciled funding is kept (≈). */
export const FUNDING_MAX_PAGES = 6;
/** Testnet creates/resumes are refused while the API wallet expires within this window (§6.11, §7.3 check 6). */
export const AGENT_EXPIRY_REFUSE_MS = 24 * 3600_000;
/** Divergence above which the plant needs `ack_divergence` (§7.3 check 15). */
export const DIVERGENCE_ACK = 0.2;
/** Stake ≤ this share of free collateral at create (§7.3 check 13). */
export const FREE_SHARE = 0.9;
const MIN_ORDER_USD_DEFAULT = 10;
const FEE_RATE_DEFAULT = 0.00045;
const MARGIN_STREAK_PAUSE = 3;
/** Below this many requests left on the address budget, bots stop opening (closing is still allowed, §6.8). */
const ADDRESS_BUDGET_STOP = 50;
const RATE_LIMIT_EVERY_MS = 3600_000;

const PRIO_DEFAULT = Object.freeze({
  FLATTEN: 0, MIDS: 1, MIRROR: 2, RECONCILE: 3, ORDER_STATUS: 4, FILLS: 5, BACKGROUND: 6, VERIFY: 7,
});

const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const isPrice = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;
const roundTo = (x, d) => {
  const f = 10 ** d;
  return Number((Math.round(x * f) / f).toFixed(d)) + 0;
};
const usd6 = (x) => roundTo(x, 6);
const isLaneAbort = (err) => err?.code === 'lane_aborted' || err?.name === 'LaneAbortError';

/**
 * A flatten is still wanted: the bot is pausing or closing. A resume withdraws the intent (§6.11 Pause), so every
 * flatten step re-checks this after each await and before it sends anything — a stale retry must never flatten an
 * ACTIVE bot, nor announce it as paused.
 */
const wantsFlatten = (bot) => Boolean(bot) && bot.state !== 'closed' && (bot.closing === true || bot.state === 'paused');
/** Mirror work (leverage, opening/growing/reducing IOCs) may act only for an active bot that is not closing. */
const mayMirror = (bot) => Boolean(bot) && bot.state === 'active' && !bot.closing;

/** A small stable per-player offset (FNV-1a of the uid) that staggers the bar-cadenced work of many gardens (§6.8). */
function stagger(uid, mod) {
  let h = 0x811c9dc5;
  for (const ch of String(uid)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % mod;
}

/** Hyperliquid order-status strings that mean "rejected at placement" (vs canceled), §6.6 resolution. */
const REJECTED_STATUSES = /rejected$/i;

/** Parse `clearinghouseState.assetPositions` → Map coin → exchange snapshot (numbers; funding in P&L sign). */
export function parsePositions(ch) {
  const out = new Map();
  for (const ap of Array.isArray(ch?.assetPositions) ? ch.assetPositions : []) {
    const p = ap?.position ?? ap;
    if (!p || typeof p.coin !== 'string') continue;
    const szi = num(p.szi) ?? 0;
    const lev = p.leverage && typeof p.leverage === 'object' ? p.leverage : null;
    out.set(p.coin, {
      szi,
      entry_px: num(p.entryPx),
      unrealized_pnl: num(p.unrealizedPnl) ?? 0,
      liquidation_px: num(p.liquidationPx),
      margin_used: num(p.marginUsed) ?? 0,
      position_value: num(p.positionValue) ?? 0,
      leverage: num(lev?.value),
      leverage_type: typeof lev?.type === 'string' ? lev.type : null,
      funding_since_open: -(num(p.cumFunding?.sinceOpen) ?? 0),
    });
  }
  return out;
}

/** Flat snapshot for a coin with no position. */
const FLAT = Object.freeze({
  szi: 0, entry_px: null, unrealized_pnl: 0, liquidation_px: null, margin_used: 0, position_value: 0,
  leverage: null, leverage_type: null, funding_since_open: 0,
});

/**
 * The account snapshot (§6.7 step 7): standard accounts from clearinghouseState; unified accounts from the spot USDC
 * balance (`total`, `total − hold`) with account_value = total + Σ uPnL, flagged as an estimate (risk K1).
 */
export function parseAccount(ch, spot, abstraction, asOfMs) {
  const ms = ch?.marginSummary ?? {};
  const upnl = [...parsePositions(ch).values()].reduce((s, p) => s + p.unrealized_pnl, 0);
  if (abstraction === 'unifiedAccount' && spot) {
    const usdc = (Array.isArray(spot.balances) ? spot.balances : []).find((b) => b?.coin === 'USDC');
    const total = num(usdc?.total) ?? 0;
    const hold = num(usdc?.hold) ?? 0;
    return {
      account_value: usd6(total + upnl), account_value_est: true, balance: usd6(total), free: usd6(Math.max(0, total - hold)),
      withdrawable: usd6(Math.max(0, total - hold)), total_margin_used: num(ms.totalMarginUsed) ?? 0,
      total_ntl_pos: num(ms.totalNtlPos) ?? 0, as_of_ms: asOfMs,
    };
  }
  const value = num(ms.accountValue) ?? 0;
  const withdrawable = num(ch?.withdrawable) ?? 0;
  return {
    account_value: usd6(value), account_value_est: false, balance: usd6(value - upnl), free: usd6(withdrawable),
    withdrawable: usd6(withdrawable), total_margin_used: num(ms.totalMarginUsed) ?? 0,
    total_ntl_pos: num(ms.totalNtlPos) ?? 0, as_of_ms: asOfMs,
  };
}

export class TestnetVenue {
  /**
   * @param {object} o
   * @param {number} o.uid
   * @param {string} o.epoch           the garden epoch (16 hex) captured by every lane job
   * @param {object} o.hl              createTestnet() → { scheduler, info, market, exchange }
   * @param {object} o.lib             { wire, format, errors, constants } (WP2 modules)
   * @param {object} o.credentials     Credentials (withSigner, link, setStatus, …)
   * @param {object} o.repo            GardenRepo
   * @param {object} o.gardens         Gardens (killSwitchState, signingHalted, haltSigning, testnetCapacityOk, audit, journalFor)
   * @param {object} [o.journal]       the player's journal facade (credential_status)
   * @param {() => number} [o.now]
   * @param {(line: string) => void} [o.log]
   */
  constructor({ uid, epoch, hl, lib, credentials, repo, gardens, journal = null, now = Date.now, log = console.warn }) {
    this.uid = uid;
    this.epoch = epoch;
    this.hl = hl;
    this.lib = lib ?? {};
    this.credentials = credentials;
    this.repo = repo;
    this.gardens = gardens;
    this.journal = journal && typeof journal.emit === 'function' ? journal : { emit() {} };
    this.now = now;
    this.log = log;
    this.garden = null;
    this.cancelled = false;
    const k = this.lib.constants ?? {};
    this.P = { ...PRIO_DEFAULT, ...(k.PRIORITY ?? {}) };
    this.minOrderUsd = k.MIN_ORDER_USD ?? MIN_ORDER_USD_DEFAULT;
    this.feeRate = k.PROVISIONAL_FEE_RATE ?? FEE_RATE_DEFAULT;
    this.iocSlippage = k.IOC_SLIPPAGE ?? 0.01;
    this.lane = hl.scheduler.lane(uid, epoch);
    // Cached exchange facts (the last reconcile): user GETs read only these (§6.8 "user GETs never spend weight").
    this.acct = null;
    this.positions = new Map();
    this.positionsMs = null;
    this.requests = null;
    // Every garden loaded at boot is built in the same pass: without a per-player offset, all of them would read
    // userRateLimit (20 weight) in the same minute and sweep fills (≥ 20) in the same bar — 40 players × 20 is the
    // whole TESTNET_BUDGET (§6.8). The offsets spread the hourly read over the first 10 minutes and the sweeps over
    // the 30-bar cadence.
    this.requestsMs = this.now() - RATE_LIMIT_EVERY_MS + stagger(uid, 600) * 1000;
    this.abstraction = null;
    // Sync bookkeeping
    this.syncQueued = null; // promise of a queued (not yet started) sync job
    this.flattens = new Map(); // botId → promise of the queued/running flatten
    this.flattenWaiters = new Map(); // botId → [resolve]
    this.retryTimers = new Map(); // botId → {cancel}
    this.bars = stagger(uid, SWEEP_EVERY.idle);
    this.sweepDue = false; // a cadence sweep was skipped (budget): run it at the next bar
    this.reconciledBar = 0; // the last bar whose sync reconciled (degradation step 4)
    this.lastSweepMs = null;
    this.unexplained = new Map(); // coin → [fills with an oid that is not ours]
    this.marginStreak = new Map(); // botId → consecutive insufficient_margin
    this.addrBackoffUntil = 0;
    this.addrBackoffN = 0;
    this.noDeposit = false;
    this.errorOnce = new Set();
  }

  /** Bind the garden this venue serves (LiveLayer calls it from its constructor). */
  attach(garden) {
    this.garden = garden;
  }

  // ---- views (cache only; no Hyperliquid weight) ----------------------------------------------------------------

  link() {
    try {
      return this.credentials?.link(this.uid) ?? null;
    } catch {
      return null;
    }
  }

  account() {
    return this.acct;
  }

  /** 'live' | 'delayed' | 'down' | 'disabled' — down while signing is halted (§6.9 signature_mismatch). */
  state() {
    if (this.gardens?.signingHalted?.()) return 'down';
    try {
      return this.hl.market?.state?.() ?? 'live';
    } catch {
      return 'down';
    }
  }

  killSwitch() {
    return this.gardens?.killSwitchState?.() ?? { on: false, reason: null, since_ms: null };
  }

  coinInfo(coin) {
    try {
      const i = this.hl.market?.coinInfo?.(coin);
      if (!i) return null;
      const index = Number.isInteger(i.index) ? i.index : Number.isInteger(i.asset) ? i.asset : null;
      if (index === null) return null;
      return {
        index,
        sz_decimals: Number.isInteger(i.sz_decimals) ? i.sz_decimals : Number.isInteger(i.szDecimals) ? i.szDecimals : 0,
        max_leverage: num(i.max_leverage ?? i.maxLeverage) ?? 1,
        delisted: Boolean(i.delisted ?? i.isDelisted),
        only_isolated: Boolean(i.only_isolated ?? i.onlyIsolated),
      };
    } catch {
      return null;
    }
  }

  /** The testnet mid of a coin: {px, ms, stale} (stale when older than 60 s), or null. */
  quote(coin) {
    let q = null;
    try {
      q = this.hl.market?.quote?.(coin) ?? null;
    } catch {
      q = null;
    }
    const px = num(q?.px);
    if (!isPrice(px)) return null;
    const ms = num(q.ms) ?? this.now();
    return { px, ms, stale: this.now() - ms > TESTNET_MID_MAX_AGE_MS };
  }

  /** Positions of the last reconcile, for testnet_status (§8.3). */
  positionsList() {
    const out = [];
    for (const [coin, p] of this.positions) {
      if (!p.szi) continue;
      const bot = this.garden?.openByCoin?.get(coin);
      out.push({
        coin, szi: p.szi, entry_px: p.entry_px, unrealized_pnl: p.unrealized_pnl, liquidation_px: p.liquidation_px,
        leverage: p.leverage, funding_since_open: p.funding_since_open,
        bot: bot && venueOf(bot) === 'testnet' ? bot.id : null,
      });
    }
    return out;
  }

  /** testnet_status payload (§8.3), cache only. */
  status() {
    const link = this.link();
    const now = this.now();
    const until = link?.valid_until_ms ?? null;
    let warn = null;
    if (Number.isFinite(until)) {
      if (until - now < 86_400_000) warn = '1d';
      else if (until - now < 7 * 86_400_000) warn = '7d';
    }
    return {
      link,
      state: this.state(),
      account: this.acct ? { ...this.acct } : null,
      positions: this.positionsList(),
      requests: this.requests ? { ...this.requests } : null,
      expiry: { valid_until_ms: until, warn },
      caps: this.garden?.caps?.().testnet ?? null,
    };
  }

  // ---- the §7.3 checks -------------------------------------------------------------------------------------------

  /**
   * Run the testnet create checks in order; the first failure wins. `stakeIndependent` stops after check 11 (the
   * plant dialog's venue enable rule). Returns `{ error: ApiError|null, facts }`.
   */
  #checks({ row, capital = null, ackDivergence = false, self = null, stakeIndependent = false, resume = false }) {
    const g = this.garden;
    const facts = { info: null, leverage: null, asset: null, mid: null, mainnetMid: null, k: null, targetSz: null,
      notional: null, free: null, book: null, opensNow: false };
    const fail = (status, code, message, extra = null) => ({ error: new ApiError(status, message, code, extra), facts });
    // 1. testnet_disabled
    if (!this.hl || this.state() === 'disabled') return fail(503, 'testnet_disabled', 'the testnet venue is not enabled on this server');
    // 2. kill_switch
    if (this.killSwitch().on) return fail(503, 'kill_switch', 'testnet planting is stopped by the operator (kill switch)');
    // 3. halted
    if (g?.halted) return fail(409, 'halted', 'your field is burned — re-arm it to plant again');
    // 4. not_connected / credential_revoked
    const link = this.link();
    if (!link) return fail(409, 'not_connected', 'connect a Hyperliquid testnet API wallet first');
    if (link.status === 'revoked' || link.status === 'error') {
      return fail(409, 'credential_revoked', 'your testnet API wallet is no longer valid — reconnect it');
    }
    // 5. testnet_down (also while signing is halted)
    const st = this.state();
    if (st === 'down' || st === 'delayed') return fail(503, 'testnet_down', 'the Hyperliquid testnet is not answering right now');
    // 6. agent_expiring
    if (Number.isFinite(link.valid_until_ms) && link.valid_until_ms < this.now() + AGENT_EXPIRY_REFUSE_MS) {
      return fail(409, 'agent_expiring', 'your testnet API wallet expires within 24 hours — replace it first',
        { valid_until_ms: link.valid_until_ms });
    }
    // 7. testnet_capacity
    if (this.gardens?.testnetCapacityOk && !this.gardens.testnetCapacityOk(this.uid)) {
      return fail(503, 'testnet_capacity', 'the testnet is at capacity for this server — try again later');
    }
    // 8. unlisted_testnet / delisted_testnet
    const info = this.coinInfo(row.coin);
    if (!info) return fail(409, 'unlisted_testnet', `${row.coin} is not listed on the Hyperliquid testnet`);
    if (info.delisted) return fail(409, 'delisted_testnet', `${row.coin} is delisted on the Hyperliquid testnet`);
    facts.info = { max_leverage: info.max_leverage, sz_decimals: info.sz_decimals, index: info.index };
    facts.asset = info.index;
    facts.leverage = Math.max(1, Math.min(Math.floor(Number(row.leverage) || 1), Math.floor(info.max_leverage)));
    // 9. busted, bean_bound, coin_bound, leverage
    if (row.busted) return fail(409, 'busted', `bean ${row.id} is busted`);
    if (!resume) {
      const conflict = g?.bindingConflict?.(row, self);
      if (conflict) {
        return fail(409, conflict.reason, conflict.reason === 'bean_bound'
          ? `bean ${row.id} is already bound to ${conflict.bot}` : `${row.coin} is already bound to ${conflict.bot} (one bot per coin)`);
      }
    }
    if (requiredLeverage(row) > info.max_leverage + 1e-9) {
      return fail(409, 'leverage', `sizes entries at ${requiredLeverage(row).toFixed(1)}× equity; ${row.coin} allows ${info.max_leverage}× on testnet`);
    }
    // 10. no_testnet_price, stale
    const q = this.quote(row.coin);
    if (!q || q.stale) return fail(409, 'no_testnet_price', `no fresh testnet price for ${row.coin}`);
    facts.mid = q.px;
    const why = g?.canOpenReason?.(row.coin) ?? null;
    if (why) return fail(409, 'stale', why);
    const mainnetMid = g?.mainnetMid?.(row.coin) ?? null;
    facts.mainnetMid = isPrice(mainnetMid) ? mainnetMid : null;
    // 11. insufficient_testnet_balance (free < min stake, or the account has no deposit)
    const caps = g?.caps?.().testnet ?? { max_bots: 3, min_capital_usd: 20, max_bot_capital_usd: 500, max_total_notional_usd: 3000 };
    const free = this.acct ? num(this.acct.free) : null;
    facts.free = free;
    if (this.noDeposit || (free !== null && free < caps.min_capital_usd)) {
      return fail(409, 'insufficient_testnet_balance', 'not enough test USDC on the testnet account — claim it from the faucet',
        { faucet: FAUCET_URL });
    }
    // Sizing facts (also what the quote shows).
    const d = info.sz_decimals;
    const k = facts.mainnetMid && facts.mid ? facts.mainnetMid / facts.mid : null;
    facts.k = k;
    const side = beanSide(row);
    const units = Math.abs(Number(row.units) || 0);
    const stake = Number(capital) || 0;
    if (side !== 0 && units > 0 && k) {
      const raw = units * (stake / CAPITAL_PER_BEAN) * k;
      facts.targetSz = side * this.#floorSz(raw, d);
      facts.notional = Math.abs(facts.targetSz) * facts.mid;
      facts.opensNow = facts.targetSz !== 0;
    } else {
      facts.targetSz = 0;
      facts.notional = entryNotional(row, stake);
    }
    if (stakeIndependent) return { error: null, facts };
    // 12. testnet_caps (bots / stake / notional)
    const openTestnet = g ? g.botList.filter((b) => b.state !== 'closed' && venueOf(b) === 'testnet' && b !== self).length : 0;
    const openAll = g ? g.openCount() - (self ? 1 : 0) : 0;
    if (!resume) {
      if (openTestnet >= caps.max_bots) return fail(409, 'testnet_caps', `testnet bot cap reached (${caps.max_bots} open testnet bots)`);
      if (openAll >= (g?.cfg?.maxBots ?? 10)) return fail(409, 'testnet_caps', `bot cap reached (${g?.cfg?.maxBots ?? 10} open bots)`);
      if (!(stake >= caps.min_capital_usd && stake <= caps.max_bot_capital_usd)) {
        return fail(409, 'testnet_caps', `testnet stake must be between ${caps.min_capital_usd} and ${caps.max_bot_capital_usd}`);
      }
      const open = g?.testnetNotional?.(self) ?? 0;
      if (open + (facts.opensNow ? facts.notional : 0) > caps.max_total_notional_usd + 1e-9) {
        return fail(409, 'testnet_caps', `testnet notional cap: $${open.toFixed(2)} open + ~$${facts.notional.toFixed(2)} exceeds $${caps.max_total_notional_usd}`);
      }
      // 13. insufficient_testnet_balance for this stake
      if (free !== null && stake > FREE_SHARE * free + 1e-9) {
        return fail(409, 'insufficient_testnet_balance', `the stake is more than ${Math.round(FREE_SHARE * 100)}% of your free test USDC ($${free.toFixed(2)})`,
          { faucet: FAUCET_URL });
      }
      // 14. thin_book
      const book = this.#book(row.coin);
      facts.book = book;
      if (facts.opensNow && book) {
        const depth = side > 0 ? book.buy : book.sell;
        if (Number.isFinite(depth) && depth < facts.notional) {
          return fail(409, 'thin_book', `the testnet book holds only $${depth.toFixed(0)} within 1% — less than this bot would open`);
        }
      }
      // 15. divergence_ack
      if (k && Math.abs(facts.mid / facts.mainnetMid - 1) > DIVERGENCE_ACK && !ackDivergence) {
        return fail(409, 'divergence_ack', 'the testnet price is more than 20% away from the real price — confirm to plant anyway');
      }
    }
    return { error: null, facts };
  }

  #book(coin) {
    try {
      const b = this.hl.market?.book?.(coin);
      if (!b) return null;
      return { buy: num(b.depth_buy_usd_1pct), sell: num(b.depth_sell_usd_1pct), ms: num(b.ms) };
    } catch {
      return null;
    }
  }

  #floorSz(sz, d) {
    if (this.lib.format?.floorSz) return Math.abs(this.lib.format.floorSz(Math.abs(sz), d));
    const f = 10 ** d;
    return Number((Math.floor(Math.abs(sz) * f + 1e-9) / f).toFixed(d));
  }

  /** bot_create {venue:'testnet'} checks → { ok, error?, info, leverage, asset }. */
  checkCreate({ row, capital, ackDivergence = false }) {
    const { error, facts } = this.#checks({ row, capital, ackDivergence });
    if (error) return { ok: false, error };
    return { ok: true, info: facts.info, leverage: facts.leverage, asset: facts.asset };
  }

  /** bot_resume of a testnet bot re-runs checks 1–8 (§7.3). */
  checkResume({ bot, row }) {
    const { error } = this.#checks({ row, capital: bot.capital_usd, self: bot, stakeIndependent: true, resume: true });
    if (error && ['testnet_disabled', 'kill_switch', 'halted', 'not_connected', 'credential_revoked', 'testnet_down',
      'agent_expiring', 'testnet_capacity', 'unlisted_testnet', 'delisted_testnet'].includes(error.code)) {
      return { ok: false, error };
    }
    return { ok: true };
  }

  /** testnet_quote (§8.3), cache only. */
  quoteFor({ row, capital }) {
    const stake = Number(capital) || 0;
    const venue = this.#checks({ row, capital: stake, stakeIndependent: true });
    const all = venue.error ? venue : this.#checks({ row, capital: stake, ackDivergence: true });
    // Divergence needs an explicit ack in the dialog: report it as the reason, but `ok` ignores it (the dialog asks).
    const full = this.#checks({ row, capital: stake, ackDivergence: false });
    const f = { ...venue.facts, ...(all.facts ?? {}) };
    const lev = f.leverage ?? 1;
    const notional = Number.isFinite(f.notional) ? f.notional : 0;
    const book = f.book ?? this.#book(row.coin);
    const side = beanSide(row);
    const depth = book ? (side >= 0 ? book.buy : book.sell) : null;
    const room = (this.garden?.caps?.().testnet.max_total_notional_usd ?? 3000) - (this.garden?.testnetNotional?.() ?? 0);
    const q = this.quote(row.coin);
    return {
      ok: !full.error,
      reason: full.error?.code ?? null,
      venue_ok: !venue.error,
      venue_reason: venue.error?.code ?? null,
      coin: row.coin,
      asset: f.asset ?? null,
      sz_decimals: f.info?.sz_decimals ?? null,
      leverage: f.leverage ?? null,
      // the 'leverage' refusal's two numbers (additive): what the bean's entries need vs what testnet allows
      need_leverage: Number.isFinite(requiredLeverage(row)) ? Number(requiredLeverage(row).toFixed(2)) : null,
      max_leverage: f.info?.max_leverage ?? null,
      testnet_mid: q?.px ?? null,
      testnet_mid_ms: q?.ms ?? null,
      mainnet_mid: f.mainnetMid ?? null,
      divergence: q?.px && f.mainnetMid ? usd6(q.px / f.mainnetMid - 1) : null,
      k: f.k ? Number(f.k.toPrecision(8)) : null,
      target_sz: f.targetSz ?? null,
      notional_usd: usd6(notional),
      margin_usd: usd6(notional / lev),
      liq_move_pct: usd6((LIQUIDATION_FRACTION / lev) * 100),
      // The dialog says "fees ≈ … to open and close": the ROUND TRIP (taker fee on both sides), as the paper quote does.
      // One side alone is fee_open_usd (additive).
      fees_est_usd: usd6(2 * notional * this.feeRate),
      fee_open_usd: usd6(notional * this.feeRate),
      slippage_max_usd: usd6(0.01 * notional),
      flatten_slippage_max_usd: usd6(0.05 * notional),
      book_ok: depth === null || !Number.isFinite(depth) ? null : depth >= notional,
      depth_usd: Number.isFinite(depth) ? usd6(depth) : null,
      book_ms: book?.ms ?? null,
      funding_1h: num(this.#ctx(row.coin)?.funding_1h),
      opens_now: Boolean(f.opensNow),
      room_usd: usd6(Math.max(0, room)),
      free_usd: f.free ?? null,
    };
  }

  #ctx(coin) {
    try {
      return this.hl.market?.ctx?.(coin) ?? null;
    } catch {
      return null;
    }
  }

  // ---- planning (afterTick, synchronous) -------------------------------------------------------------------------

  /**
   * The dollar-matched target (§6.11 Sizing): target = sign(side) × floorSz(|units| × capital/1000 × k, d), with
   * k = mainnetMid / testnetMid frozen per bean position episode (side | entry_px | |units|), so the target holds
   * still while the bean holds. Flat bean → 0. A missing mid → no change this bar (no_price); a stale mainnet coin
   * freezes the bean (no change).
   */
  planTarget(bot, row) {
    const g = this.garden;
    if (g?.mainnetStale?.(bot.coin)) return;
    const side = beanSide(row);
    const units = Math.abs(Number(row.units) || 0);
    if (side === 0 || units === 0) {
      bot.target_szi = 0;
      return;
    }
    const episode = `${side}|${row.entry_px}|${units}`;
    if (!bot.size_ratio || bot.size_ratio.episode !== episode) {
      const mainMid = g?.mainnetMid?.(bot.coin);
      const q = this.quote(bot.coin);
      if (!isPrice(mainMid) || !q || q.stale) return; // no_price: keep the last target this bar
      bot.size_ratio = { k: mainMid / q.px, mainnet_px: mainMid, testnet_px: q.px, at_ms: this.now(), episode };
    }
    const raw = units * (bot.capital_usd / CAPITAL_PER_BEAN) * bot.size_ratio.k;
    bot.target_szi = side * this.#floorSz(raw, bot.sz_decimals);
  }

  // ---- lane plumbing ---------------------------------------------------------------------------------------------

  /** True while this venue may act (not torn down, same garden epoch). */
  alive() {
    if (this.cancelled) return false;
    try {
      return this.lane.alive();
    } catch {
      return false;
    }
  }

  #run(priority, label, fn) {
    if (!this.alive()) return Promise.resolve(null);
    return this.lane.run(priority, async (ctx) => fn(ctx), { label }).catch((err) => {
      if (isLaneAbort(err) || err?.code === 'draining') return null;
      this.log(`[testnet] garden ${this.uid}: ${label} failed (${err?.code || err?.name || 'error'}: ${String(err?.message || '').slice(0, 200)})`);
      return null;
    });
  }

  #later(ms, priority, label, fn) {
    if (!this.alive()) return { cancel() {} };
    try {
      return this.lane.later(ms, priority, async (ctx) => {
        try {
          return await fn(ctx);
        } catch (err) {
          if (!isLaneAbort(err)) this.log(`[testnet] garden ${this.uid}: ${label} failed (${err?.code || err?.name || 'error'})`);
          return null;
        }
      }, { label });
    } catch {
      return { cancel() {} };
    }
  }

  /** Teardown (§7.2): cancel the lane, queued jobs and retry timers; resolve every waiter. */
  cancel() {
    this.cancelled = true;
    for (const t of this.retryTimers.values()) t.cancel?.();
    this.retryTimers.clear();
    try {
      this.hl.scheduler?.cancelLane?.(this.uid);
    } catch {
      /* already gone */
    }
    for (const list of this.flattenWaiters.values()) for (const r of list) r();
    this.flattenWaiters.clear();
    this.flattens.clear();
  }

  /** Whether orders may be sent now: not halted for signing, not torn down, testnet not delayed/down. */
  #canSend() {
    if (this.gardens?.signingHalted?.()) return false;
    const st = this.state();
    return st === 'live';
  }

  #info() {
    return this.hl.info;
  }

  #accountAddr() {
    return this.link()?.account_address ?? null;
  }

  // ---- reconcile -------------------------------------------------------------------------------------------------

  /** clearinghouseState (+ spot for unified accounts) → positions, account snapshot, per-bot exchange view. */
  async #reconcile(ctx, priority = this.P.RECONCILE) {
    const link = this.link();
    const addr = link?.account_address;
    if (!addr) return null;
    const ch = await this.#info().clearinghouseState(addr, { ctx, priority });
    let spot = null;
    if (link.abstraction === 'unifiedAccount') spot = await this.#info().spotClearinghouseState(addr, { ctx, priority });
    ctx?.assertAlive?.();
    const asOf = this.now();
    this.abstraction = link.abstraction ?? null;
    this.positions = parsePositions(ch);
    this.positionsMs = asOf;
    this.acct = parseAccount(ch, spot, link.abstraction, asOf);
    if (this.noDeposit && this.acct.account_value > 0) this.noDeposit = false;
    const g = this.garden;
    if (g) {
      for (const bot of g.botList) {
        if (bot.state === 'closed' || venueOf(bot) !== 'testnet') continue;
        g.applyExchangeSnapshot(bot.id, this.positions.get(bot.coin) ?? FLAT, { asOfMs: asOf });
      }
      g.applyTestnetAccount(this.acct);
    }
    return this.positions;
  }

  #pos(coin) {
    return this.positions.get(coin) ?? FLAT;
  }

  // ---- resolution of unresolved orders (§6.6, §6.11 step 2) --------------------------------------------------------

  /**
   * Resolve pending/sent/unknown orders by cloid (status and filled size only; prices and fees come from the fills
   * sweep). Returns { resolvedWithFills, stillOpenCoins:Set, oldestMs }.
   */
  async #resolveOrders(ctx, { boot = false } = {}) {
    const rows = this.repo.unresolvedOrders(this.uid);
    const out = { resolvedWithFills: false, stillOpen: new Set(), oldestMs: null };
    if (!rows.length) return out;
    const addr = this.#accountAddr();
    if (!addr) return out;
    for (const o of rows) {
      out.oldestMs = out.oldestMs === null ? o.time_ms : Math.min(out.oldestMs, o.time_ms);
      if (o.kind === 'leverage' || !o.cloid) {
        // Leverage has no cloid and no fill: the next "open from flat" sends it again (idempotent).
        this.repo.updateOrder(this.uid, o.id, { status: 'canceled', done_ms: this.now(), error: 'leverage outcome unknown (resent before the next open)' });
        continue;
      }
      let st = null;
      try {
        st = await this.#info().orderStatus(addr, o.cloid, { ctx, priority: this.P.ORDER_STATUS });
      } catch (err) {
        if (isLaneAbort(err)) throw err;
        out.stillOpen.add(o.coin);
        continue;
      }
      ctx?.assertAlive?.();
      if (st?.status === 'unknownOid') {
        const age = this.now() - (o.sent_ms ?? o.time_ms);
        if (age >= UNKNOWN_OID_CANCEL_MS || (boot && o.status !== 'unknown' && age >= 0 && o.status === 'pending' && !o.sent_ms)) {
          this.repo.updateOrder(this.uid, o.id, { status: 'canceled', done_ms: this.now(), error: 'never reached the book (unknownOid)' });
          this.#emitOrder(o, 'canceled');
        } else {
          out.stillOpen.add(o.coin);
        }
        continue;
      }
      const inner = st?.order?.order ?? {};
      const exStatus = String(st?.order?.status ?? '');
      const origSz = num(inner.origSz) ?? Math.abs(o.sz);
      const left = num(inner.sz) ?? 0;
      const filled = Math.max(0, roundTo(origSz - left, 10));
      const oid = Number.isSafeInteger(inner.oid) ? inner.oid : num(inner.oid);
      let status;
      if (exStatus === 'filled') status = 'filled';
      else if (exStatus === 'open' || exStatus === 'triggered') status = 'sent';
      else if (filled > 0) status = 'partial';
      else status = REJECTED_STATUSES.test(exStatus) ? 'rejected' : 'canceled';
      this.repo.updateOrder(this.uid, o.id, {
        status, oid: Number.isSafeInteger(oid) ? oid : null, filled_sz: filled,
        done_ms: status === 'sent' ? null : this.now(), error: status === 'filled' ? null : exStatus || null,
      });
      this.#emitOrder({ ...o, oid }, status);
      if (status === 'sent') out.stillOpen.add(o.coin);
      if (filled > 0) out.resolvedWithFills = true;
    }
    return out;
  }

  #emitOrder(o, status) {
    this.garden?.orderUpdate(o.bot_id ?? o.bot, {
      kind: o.kind, sz: o.sz, px: o.px ?? null, status, reason: o.reason ?? null, cloid: o.cloid ?? null, code: o.code ?? null,
    });
  }

  // ---- fills sweep (§6.11) -----------------------------------------------------------------------------------------

  /**
   * userFillsByTime(account, since) → attribute by oid. Provisional fills of our orders are REPLACED by the exchange
   * fills; orders without provisional fills (resolved after a transport failure or a restart) are applied as exact
   * fills. Fills with an oid that is not ours are kept per coin for the drift logic. Returns { ok, unexplained }.
   */
  async #sweep(ctx, sinceMs, { priority = this.P.FILLS, maxWaitMs = undefined } = {}) {
    const addr = this.#accountAddr();
    if (!addr) return { ok: false };
    const since = Math.max(0, Math.trunc(sinceMs));
    let fills;
    try {
      fills = await this.#info().userFillsByTime(addr, since, null, { ctx, priority, ...(maxWaitMs ? { maxWaitMs } : {}) });
    } catch (err) {
      if (isLaneAbort(err)) throw err;
      return { ok: false, skipped: Boolean(err?.skipped) };
    }
    ctx?.assertAlive?.();
    const horizon = Boolean(fills?.meta?.horizon);
    const byOid = new Map();
    const foreign = new Map();
    for (const f of Array.isArray(fills) ? fills : []) {
      const oid = num(f.oid);
      const order = oid !== null ? this.repo.orderByOid(this.uid, oid) : null;
      if (order) {
        if (!byOid.has(oid)) byOid.set(oid, { order, fills: [] });
        byOid.get(oid).fills.push(f);
      } else if (typeof f.coin === 'string') {
        if (!foreign.has(f.coin)) foreign.set(f.coin, []);
        foreign.get(f.coin).push(f);
      }
    }
    const g = this.garden;
    const confirmedByBot = new Map();
    const known = this.repo.knownTids(this.uid, 'testnet', since - 1);
    for (const [oid, { order, fills: list }] of byOid) {
      const fresh = list.filter((f) => !known.has(num(f.tid)));
      const rows = list.map((f) => this.#fillRow(order, f));
      const provisional = this.repo.botFills(this.uid, order.bot_id).some((r) => r.order_id === order.id && r.provisional === 1);
      if (provisional) {
        this.repo.replaceProvisional(this.uid, order.id, rows);
      } else if (fresh.length) {
        // Not applied yet (no provisional fill): apply each exchange fill to the bot's books exactly.
        for (const f of fresh) {
          const sz = num(f.sz) ?? 0;
          g?.applyExchangeFill(order.bot_id, {
            delta: f.side === 'B' ? sz : -sz, px: num(f.px), oid, order_id: order.id, time_ms: num(f.time) ?? this.now(),
            provisional: false, exact: this.#fillRow(order, f),
          });
        }
      }
      if (!fresh.length && !provisional) continue;
      let sz = 0;
      let px = 0;
      let fee = 0;
      let pnl = 0;
      for (const r of rows) {
        sz += r.sz;
        px += r.sz * r.px;
        fee += r.fee;
        pnl += r.closed_pnl;
      }
      if (sz > 0) {
        this.repo.updateOrder(this.uid, order.id, { avg_px: px / sz, filled_sz: roundTo(sz, 10) });
        if (!confirmedByBot.has(order.bot_id)) confirmedByBot.set(order.bot_id, []);
        confirmedByBot.get(order.bot_id).push({ oid, sz: roundTo(sz, 10), px: px / sz, fee, closed_pnl: pnl, tids: rows.map((r) => r.tid) });
      }
    }
    if (g) {
      const provisionalLeft = this.repo.provisionalCount(this.uid) > 0;
      for (const bot of g.botList) {
        if (venueOf(bot) !== 'testnet') continue;
        const list = confirmedByBot.get(bot.id);
        if (list || (horizon && provisionalLeft && bot.fees_estimated)) {
          g.confirmFills(bot.id, list ?? [], { beyondHorizon: horizon && provisionalLeft && bot.fees_estimated });
        }
      }
    }
    for (const [coin, list] of foreign) {
      const prev = this.unexplained.get(coin) ?? [];
      const seen = new Set(prev.map((f) => f.tid));
      this.unexplained.set(coin, [...prev, ...list.filter((f) => !seen.has(f.tid))].slice(-200));
    }
    this.lastSweepMs = this.now();
    return { ok: true, horizon };
  }

  /** An exchange fill as a `fills` row (raw dir ≤ 64 chars; open/close logic never reads dir). */
  #fillRow(order, f) {
    const liq = f.liquidation && typeof f.liquidation === 'object';
    return {
      bot: order.bot_id, coin: String(f.coin ?? order.coin), dir: String(f.dir ?? '').slice(0, 64) || '?',
      side: f.side === 'B' ? 'B' : 'A', sz: num(f.sz) ?? 0, px: num(f.px) ?? 0, fee: num(f.fee) ?? 0,
      closed_pnl: num(f.closedPnl) ?? 0, time_ms: num(f.time) ?? this.now(), tick: null, venue: 'testnet',
      season: order.season ?? 1, oid: num(f.oid), tid: num(f.tid), hash: typeof f.hash === 'string' ? f.hash : null,
      start_position: num(f.startPosition), liquidation: Boolean(liq),
    };
  }

  /** Earliest time a sweep must cover: the oldest provisional fill / unresolved order / last sweep, minus 5 s. */
  #sweepSince(extraMs = null) {
    const g = this.garden;
    let t = this.lastSweepMs;
    const oldestProv = this.repo.oldestProvisionalMs(this.uid);
    for (const v of [oldestProv, extraMs]) if (Number.isFinite(v)) t = t === null ? v : Math.min(t, v);
    if (t === null && g) {
      for (const b of g.botList) if (venueOf(b) === 'testnet' && b.state !== 'closed') t = t === null ? b.created_ms : Math.min(t, b.created_ms);
    }
    return (t ?? this.now()) - 5000;
  }

  // ---- the per-bar sync (§6.11 Sync) ----------------------------------------------------------------------------------

  /** Queue one sync job (de-duplicated while one is waiting to start). */
  requestSync(reason = 'tick') {
    if (!this.alive() || this.syncQueued) return this.syncQueued ?? Promise.resolve(null);
    const p = this.#run(this.P.MIRROR, `sync:${reason}`, async (ctx) => {
      this.syncQueued = null;
      return this.#syncJob(ctx, reason);
    });
    this.syncQueued = p;
    p.finally(() => {
      if (this.syncQueued === p) this.syncQueued = null;
    });
    return p;
  }

  async #syncJob(ctx, reason, { onlyBot = null, leverageFirst = false } = {}) {
    const g = this.garden;
    if (!g) return null;
    const bots = g.botList.filter((b) => b.state !== 'closed' && venueOf(b) === 'testnet' && (!onlyBot || b === onlyBot));
    if (!bots.length) return null;
    const link = this.link();
    if (!link || link.status !== 'verified') return null;
    const state = this.state();
    if (state !== 'live') return null; // delayed/down: mirror jobs are dropped (re-planned next bar)
    const degraded = Boolean(this.hl.scheduler?.degraded?.());
    if (reason === 'tick') {
      this.bars++;
      // Degradation step 4 (§6.8): under weight pressure, a player with nothing to send reconciles only every 2nd bar.
      if (degraded && this.bars - this.reconciledBar < 2 && this.#idle(bots)) return true;
      this.reconciledBar = this.bars;
    }
    // 1. Reconcile.
    await this.#reconcile(ctx);
    // 2. Resolve unresolved orders first.
    const res = await this.#resolveOrders(ctx);
    // 3. Fills sweep when NEEDED for attribution (an order resolved with fills). The cadence sweep (§6.8: provisional
    //    fills every 5 bars, stretched to 10 under pressure; otherwise every 30) runs AFTER the mirror below, so this
    //    player's orders never wait behind its own low-priority (P5) sweep.
    let swept = false;
    if (res.resolvedWithFills) {
      await this.#sweep(ctx, this.#sweepSince(res.oldestMs));
      swept = true;
      await this.#reconcile(ctx);
    }
    this.#refreshRequests(ctx);
    // 4. Drift check, then 5. mirror, per bot.
    for (const bot of bots) {
      ctx.assertAlive();
      if (bot.state === 'closed') continue;
      if (bot.closing) {
        this.#closingWithDust(bot);
        continue;
      }
      if (res.stillOpen.has(bot.coin)) continue; // pending attribution: neither drift nor a new order
      if (bot.state === 'active') {
        const drift = await this.#driftCheck(ctx, bot, { swept });
        if (drift) continue;
      }
      if (!mayMirror(bot)) continue;
      try {
        await this.#mirrorBot(ctx, bot, { leverageFirst });
      } catch (err) {
        if (isLaneAbort(err)) throw err;
        g.exchangeError(bot.id, 'rejected_other', `mirror failed: ${String(err?.message || err).slice(0, 200)}`);
      }
    }
    // 6. The cadence sweep, after every order of this bar went out. It may not wait long for budget: when it cannot
    //    start within SWEEP_MAX_WAIT_MS it is skipped and runs at the next bar instead.
    if (reason === 'tick' && !swept) {
      const provisional = this.repo.provisionalCount(this.uid) > 0;
      const every = provisional ? (degraded ? SWEEP_EVERY.degraded : SWEEP_EVERY.provisional) : SWEEP_EVERY.idle;
      if (this.sweepDue || this.bars % every === 0) {
        const sw = await this.#sweep(ctx, this.#sweepSince(), { maxWaitMs: SWEEP_MAX_WAIT_MS });
        this.sweepDue = !sw.ok;
      }
    }
    return true;
  }

  /**
   * Nothing to send for this player (degradation step 4): no unresolved order, no flatten or closing bot, and every
   * active bot's books already sit at its target (within a lot).
   */
  #idle(bots) {
    if (this.repo.unresolvedOrders(this.uid).length) return false;
    for (const bot of bots) {
      if (bot.closing || this.flattens.has(bot.id) || this.retryTimers.has(bot.id)) return false;
      if (bot.state !== 'active') continue;
      if (bot.exchange_sync && bot.exchange_sync.state !== 'done') return false;
      const lot = 10 ** -bot.sz_decimals;
      if (Math.abs((Number(bot.target_szi) || 0) - (Number(bot.real?.szi) || 0)) >= lot / 2) return false;
    }
    return true;
  }

  /**
   * A CLOSING bot whose reduce-only remainder the exchange refused as below the $10 minimum (dust, risk K2) stays
   * closing and shows the dust — it is never retired while the exchange still holds the position (§6.11 Close). Each
   * bar's reconcile looks again: flat (the player closed it on the testnet site) → the close completes; worth ≥ $10
   * again (the price moved) → one more flatten. No order is resent otherwise.
   */
  #closingWithDust(bot) {
    if (!bot.dust || this.flattens.has(bot.id) || this.retryTimers.has(bot.id)) return;
    const lot = 10 ** -bot.sz_decimals;
    const exch = this.#pos(bot.coin);
    const q = this.quote(bot.coin);
    if (Math.abs(exch.szi) < lot / 2 || (q && !q.stale && Math.abs(exch.szi) * q.px >= this.minOrderUsd)) {
      this.requestFlatten(bot, 'close');
    }
  }

  /** Hourly userRateLimit (the address budget, §6.8), skipped under weight pressure. Fire and forget. */
  #refreshRequests(ctx) {
    if (this.now() - this.requestsMs < RATE_LIMIT_EVERY_MS || this.hl.scheduler?.degraded?.()) return;
    const addr = this.#accountAddr();
    if (!addr || typeof this.#info().userRateLimit !== 'function') return;
    this.requestsMs = this.now();
    this.#info().userRateLimit(addr, { ctx, priority: this.P.BACKGROUND }).then((r) => {
      const used = num(r?.nRequestsUsed);
      const cap = num(r?.nRequestsCap);
      if (used === null || cap === null) return;
      this.requests = { used, cap, as_of_ms: this.now() };
      if (cap - used < 200) this.garden?.exchangeError(null, 'address_budget_low', `testnet address budget low: ${cap - used} requests left`);
    }).catch(() => {});
  }

  /**
   * §6.11 step 4: expected = bot.real.szi; in sync within half a lot. Otherwise classify by the unexplained fills:
   * a liquidation object → liquidated_testnet; exchange flat → external_close; else position_drift. A drift pause
   * NEVER sends an order. Returns true when the bot was paused.
   */
  async #driftCheck(ctx, bot, { swept }) {
    const lot = 10 ** -bot.sz_decimals;
    const exch = this.#pos(bot.coin);
    const expected = bot.real.szi;
    if (Math.abs(exch.szi - expected) < lot / 2) return false;
    if (!swept) {
      await this.#sweep(ctx, this.#sweepSince());
      // The sweep may have applied exact fills of our own orders: re-check against the books.
      if (Math.abs(exch.szi - bot.real.szi) < lot / 2) return false;
    }
    const g = this.garden;
    const addr = this.#accountAddr();
    const foreign = (this.unexplained.get(bot.coin) ?? []).filter((f) => num(f.time) >= (bot.created_ms ?? 0) - 5000);
    const liq = foreign.filter((f) => f.liquidation && typeof f.liquidation === 'object'
      && (!f.liquidation.liquidatedUser || String(f.liquidation.liquidatedUser).toLowerCase() === addr));
    const liqByDir = liq.length === 0 ? foreign.filter((f) => /liquidat/i.test(String(f.dir ?? ''))) : [];
    const vars = { exch: exch.szi, exp: expected, coin: bot.coin };
    if (liq.length || liqByDir.length) {
      // The exchange's own liquidation: realized P&L from the exchange fills.
      for (const f of [...liq, ...liqByDir]) {
        const sz = num(f.sz) ?? 0;
        const fakeOrder = { bot_id: bot.id, coin: bot.coin, season: bot.season ?? 1 };
        g.applyExchangeFill(bot.id, {
          delta: f.side === 'B' ? sz : -sz, px: num(f.px), oid: num(f.oid), order_id: null, time_ms: num(f.time) ?? this.now(),
          provisional: false, liquidation: true, exact: this.#fillRow(fakeOrder, f),
        });
      }
      this.#consumeUnexplained(bot.coin, [...liq, ...liqByDir]);
      bot.real.szi = exch.szi;
      g.pauseFromExchange(bot.id, 'liquidated_testnet', vars, { why: 'liquidated on testnet' });
      return true;
    }
    if (exch.szi === 0) {
      this.#settleExternalFlat(bot); // the books follow the exchange: no phantom size on a paused bot
      g.pauseFromExchange(bot.id, 'external_close', vars, { why: 'closed outside the garden' });
      return true;
    }
    g.pauseFromExchange(bot.id, 'position_drift', vars, { why: 'position changed outside the garden' });
    return true;
  }

  #consumeUnexplained(coin, used) {
    const tids = new Set(used.map((f) => f.tid));
    this.unexplained.set(coin, (this.unexplained.get(coin) ?? []).filter((f) => !tids.has(f.tid)));
  }

  /** §6.11 step 5 for one active, in-sync bot. */
  async #mirrorBot(ctx, bot, { leverageFirst = false } = {}) {
    const g = this.garden;
    const info = this.coinInfo(bot.coin);
    if (!info || info.delisted) {
      g.exchangeError(bot.id, 'rejected_other', `${bot.coin} is no longer tradeable on testnet`);
      return;
    }
    if (Number.isInteger(info.index) && info.index !== bot.asset) {
      this.log(`[testnet] garden ${this.uid}: ${bot.coin} asset index moved ${bot.asset} → ${info.index}`);
      bot.asset = info.index;
    }
    const d = bot.sz_decimals;
    const lot = 10 ** -d;
    const target = Number(bot.target_szi) || 0;
    let szi = this.#pos(bot.coin).szi;
    if (Math.abs(szi - bot.real.szi) < lot / 2) szi = bot.real.szi;
    const q = this.quote(bot.coin);
    if (!q || q.stale) return; // a testnet mid older than 60 s freezes mirroring
    const mid = q.px;
    // Pause / close / halt / kill set state, `closing` and target_szi synchronously while this job awaits the exchange:
    // after every await the plan is re-validated, so an opening order is never sent for a bot that stopped meanwhile.
    const stillWanted = () => mayMirror(bot) && (Number(bot.target_szi) || 0) === target;
    if (leverageFirst && Math.abs(szi) < lot / 2) {
      if (!(await this.#leverage(ctx, bot))) return;
      if (!stillWanted()) return;
      leverageFirst = 'done';
    }
    let delta = roundTo(target - szi, d);
    if (Math.abs(delta) < lot / 2) {
      g.setSync(bot.id, { op: 'mirror', state: 'done', fill_state: this.#fillState(bot, target, szi, mid) });
      g.clearExchangeError(bot.id);
      return;
    }
    if (bot.dust && bot.dust.target === target) return; // a remainder below $10: not retried until the target changes
    if (bot.dust && bot.dust.target !== target) bot.dust = null;
    if (target !== 0 && Math.abs(delta) * mid < this.minOrderUsd) {
      this.#skip(bot, delta, mid, 'below_min_order');
      g.setSync(bot.id, { op: 'mirror', state: 'done', fill_state: this.#fillState(bot, target, szi, mid) });
      return;
    }
    if (this.now() < this.addrBackoffUntil) return;
    const flip = szi !== 0 && target !== 0 && Math.sign(target) !== Math.sign(szi);
    const reducing = !flip && (target === 0 || (Math.sign(target) === Math.sign(szi) && Math.abs(target) < Math.abs(szi)));
    if (reducing) {
      await this.#order(ctx, bot, { delta, reduceOnly: true, kind: 'mirror', reason: 'tick', target });
      return;
    }
    if (flip) {
      // First close |szi| reduce-only; only after that fills, leverage and the opening leg.
      const r = await this.#order(ctx, bot, { delta: roundTo(-szi, d), reduceOnly: true, kind: 'mirror', reason: 'flip', target });
      if (!r || r.filledSz < Math.abs(szi) - lot / 2) return;
      if (!stillWanted()) return; // the closing leg stands; the opening leg is re-planned (or never sent)
      szi = 0;
      delta = roundTo(target, d);
    }
    // Growing on the same side, or opening from flat: the address budget (§6.8) and the notional cap gate new exposure.
    if (this.requests && this.requests.cap - this.requests.used < ADDRESS_BUDGET_STOP) {
      this.#skip(bot, delta, mid, 'address_budget_low');
      g.exchangeError(bot.id, 'address_budget_low', 'testnet address budget nearly used up: only closing orders are sent');
      return;
    }
    const caps = g.caps().testnet;
    const after = g.testnetNotional(bot) + Math.abs(target) * mid;
    if (after > caps.max_total_notional_usd + 1e-9) {
      this.#skip(bot, delta, mid, 'notional_cap');
      g.exchangeError(bot.id, 'testnet_caps', `testnet notional cap: $${after.toFixed(2)} would exceed $${caps.max_total_notional_usd}`);
      return;
    }
    if (Math.abs(szi) < lot / 2 && leverageFirst !== 'done') {
      if (!(await this.#leverage(ctx, bot))) return; // updateLeverage before EVERY open from flat (§6.11 Leverage)
      if (!stillWanted()) return;
    }
    await this.#order(ctx, bot, { delta, reduceOnly: false, kind: 'mirror', reason: flip ? 'flip' : 'tick', target });
  }

  #fillState(bot, target, szi, mid) {
    const lot = 10 ** -bot.sz_decimals;
    if (target === 0 && Math.abs(szi) < lot / 2) return 'waiting_bean';
    const gap = Math.abs(target - szi);
    if (gap < lot / 2 || (isPrice(mid) && gap * mid < this.minOrderUsd)) return 'in_sync';
    if (Math.abs(szi) < lot / 2) return 'unfilled';
    return 'partial';
  }

  /** Record a skipped testnet order once per situation (no nonce, never sent). */
  #skip(bot, delta, mid, why) {
    const key = `${why}|${bot.target_szi}|${bot.real.szi}`;
    if (bot.skip_key === key) return;
    bot.skip_key = key;
    const order = {
      bot: bot.id, coin: bot.coin, kind: 'mirror', sz: Number(Number(delta).toPrecision(8)), px: isPrice(mid) ? mid : null,
      status: 'skipped', reason: why, time_ms: this.now(), tick: this.garden?.lastTick ?? null, venue: 'testnet',
      season: bot.season ?? 1,
    };
    try {
      this.repo.insertOrderNow(this.uid, order);
    } catch (err) {
      this.log(`[testnet] garden ${this.uid}: skipped order not stored (${err?.message || err})`);
    }
    this.garden?.orderUpdate(bot.id, order, { inserted: true });
  }

  // ---- sending (§6.6 idempotency, §6.9 taxonomy) ---------------------------------------------------------------------

  /**
   * Submit one signed action through WP2's §6.6 state machine (exchange.submit): the write-ahead row and its first
   * nonce are already committed; identical bytes are resent after a transport failure (≤ 2 in 10 s); ONE fresh-nonce
   * re-sign only after a first-transmission nonce error without any transport failure (the fresh nonce is persisted
   * with the order row first); otherwise an unknown outcome is resolved by orderStatus(cloid) — never re-signed.
   * The key is decrypted only inside withSigner and zeroed when submit returns.
   * @returns {object} submit()'s result, or {outcome:'skipped'|'rejected', code, credential?} when nothing was sent
   */
  async #submit(ctx, action, orderId, firstNonce, priority) {
    const link = this.link();
    try {
      return await this.credentials.withSigner(this.uid, (signer) => this.hl.exchange.submit({
        action,
        signer,
        accountAddress: link?.account_address ?? null,
        priority,
        ctx,
        resolve: true,
        reserveNonce: ({ resign }) => (resign ? this.repo.renonce(this.uid, orderId) : firstNonce),
        onTransmit: (t) => {
          this.repo.updateOrder(this.uid, orderId, {
            status: 'sent', attempts: t.transmission, nonce: t.nonce, transport_failed: t.transport_failed, sent_ms: this.now(),
          });
        },
      }));
    } catch (err) {
      if (isLaneAbort(err)) throw err;
      if (err?.code === 'not_connected' || err?.code === 'key_unavailable') {
        return { outcome: 'skipped', code: 'not_connected', credential: true, error: 'credential unavailable' };
      }
      // An ExchangeRefusal (a disallowed action, a bad signer) is a programming error: never sent.
      this.log(`[testnet] ALERT garden ${this.uid}: ${action.type} refused before sending (${err?.code || err?.name || 'error'})`);
      return { outcome: 'rejected', code: 'rejected_other', error: String(err?.message || 'refused').slice(0, 300), refused: true };
    }
  }

  /** Persist a submit() result on the order row (status, oid, filled size, codes) and return the row status. */
  #recordOutcome(orderId, r, { kind }) {
    const now = this.now();
    let status;
    switch (r.outcome) {
      case 'filled': status = 'filled'; break;
      case 'partial': status = 'partial'; break;
      case 'done': status = 'filled'; break; // updateLeverage
      case 'resting': status = 'sent'; break; // an IOC must not rest: unresolved until reconcile
      case 'canceled': status = 'canceled'; break;
      case 'unknown': status = 'unknown'; break;
      case 'skipped':
      case 'halted': status = 'canceled'; break; // nothing reached the exchange
      case 'rejected':
        status = r.code === 'min_notional' && kind !== 'leverage' ? 'skipped' : 'rejected';
        break;
      default: status = 'rejected';
    }
    this.repo.updateOrder(this.uid, orderId, {
      status,
      code: r.code ?? null,
      error: r.error ?? r.resolution?.exchange_status ?? null,
      oid: Number.isSafeInteger(r.oid) ? r.oid : null,
      filled_sz: Number.isFinite(r.filled_sz) ? r.filled_sz : null,
      avg_px: Number.isFinite(r.avg_px) ? r.avg_px : null,
      transport_failed: Boolean(r.transport_failed),
      done_ms: status === 'sent' || status === 'unknown' ? null : now,
    });
    return status;
  }

  /** updateLeverage({asset, isCross:false, leverage:L}) — before every open from flat (write-ahead, nonce). */
  async #leverage(ctx, bot) {
    const g = this.garden;
    const wire = this.lib.wire;
    if (!wire || !this.#canSend()) return false;
    if (!mayMirror(bot)) return false; // paused / closing meanwhile: no leverage for an open that will not happen
    const L = Math.max(1, Math.floor(bot.leverage));
    g.setSync(bot.id, { op: 'leverage', state: 'pending' });
    let action;
    try {
      action = wire.updateLeverageAction(bot.asset, L);
    } catch (err) {
      g.setSync(bot.id, { op: 'leverage', state: 'failed', code: 'rejected_other', error: String(err?.message || err) });
      return false;
    }
    const { id, nonce } = this.repo.writeAhead(this.uid, {
      bot: bot.id, kind: 'leverage', coin: bot.coin, sz: 0, px: null, reduce_only: false, reason: 'open', leverage: L,
      time_ms: this.now(), tick: g.lastTick ?? null, season: bot.season ?? 1,
    });
    const r = await this.#submit(ctx, action, id, nonce, this.P.MIRROR);
    ctx.assertAlive();
    this.#recordOutcome(id, r, { kind: 'leverage' });
    if (r.outcome === 'done') return true;
    await this.#onError(ctx, bot, r, { kind: 'leverage' });
    return false;
  }

  /**
   * One IOC order for a signed size change `delta` (write-ahead row + nonce committed first). Applies the outcome:
   * a (partial) fill from the order response becomes a provisional fill in the bot's books; an outcome resolved by
   * orderStatus (no price) triggers a fills sweep at once, whose exchange fills move the books exactly.
   * Returns { status, filledSz, code } or null when nothing was attempted.
   */
  async #order(ctx, bot, { delta, reduceOnly, kind, reason, target = null, slippage = null, priority = null }) {
    const g = this.garden;
    const { wire, format } = this.lib;
    if (!wire || !format) return null;
    const op = kind === 'flatten' ? 'flatten' : 'mirror';
    if (!this.#canSend()) {
      g.setSync(bot.id, { op, state: 'failed', code: 'testnet_down', error: 'the testnet is not answering' });
      return { status: 'skipped', filledSz: 0, code: this.gardens?.signingHalted?.() ? 'signature_mismatch' : 'testnet_down' };
    }
    const d = bot.sz_decimals;
    const isBuy = delta > 0;
    let szStr;
    try {
      szStr = format.fmtSzWire(Math.abs(delta), d);
    } catch {
      return null; // below one lot
    }
    let q = this.quote(bot.coin);
    if ((!q || q.stale) && kind === 'flatten') q = await this.#freshMid(ctx, bot.coin);
    if (!q || (q.stale && kind !== 'flatten')) return null;
    // The last check before the write-ahead row and the nonce: the bot must still want THIS kind of order (a resume
    // withdraws a flatten; a pause or close stops mirror orders), whatever happened during the awaits before it.
    if (kind === 'flatten' ? !wantsFlatten(bot) : !mayMirror(bot)) return null;
    const slip = slippage ?? this.iocSlippage;
    let pxStr;
    let action;
    const cloid = wire.newCloid();
    try {
      pxStr = format.iocPx ? format.iocPx(q.px, isBuy, slip, d) : format.fmtPxWire(q.px * (1 + (isBuy ? 1 : -1) * slip), d);
      action = wire.orderAction([wire.orderWire({ asset: bot.asset, isBuy, px: pxStr, sz: szStr, reduceOnly, tif: 'Ioc', cloid })]);
    } catch (err) {
      g.exchangeError(bot.id, 'tick', `could not format the order (${String(err?.message || err).slice(0, 100)})`);
      return null;
    }
    const signedSz = (isBuy ? 1 : -1) * Number(szStr);
    g.setSync(bot.id, { op, state: 'pending' });
    const { id, nonce } = this.repo.writeAhead(this.uid, {
      bot: bot.id, kind, coin: bot.coin, sz: signedSz, px: Number(pxStr), reduce_only: reduceOnly, reason, cloid,
      time_ms: this.now(), tick: g.lastTick ?? null, season: bot.season ?? 1,
    });
    const orderEv = { kind, sz: signedSz, px: Number(pxStr), reason, cloid };
    g.orderUpdate(bot.id, { ...orderEv, status: 'pending' }, { inserted: true });
    const r = await this.#submit(ctx, action, id, nonce, priority ?? (kind === 'flatten' ? this.P.FLATTEN : this.P.MIRROR));
    ctx.assertAlive();
    const status = this.#recordOutcome(id, r, { kind });
    g.orderUpdate(bot.id, { ...orderEv, status, code: r.code ?? null });
    const filled = Number.isFinite(r.filled_sz) ? r.filled_sz : 0;
    if ((r.outcome === 'filled' || r.outcome === 'partial') && filled > 0) {
      if (isPrice(r.avg_px)) {
        // The order response carries the fill: one provisional fill (fee estimated) until the sweep confirms it.
        g.applyExchangeFill(bot.id, { delta: (isBuy ? 1 : -1) * filled, px: r.avg_px, oid: r.oid, order_id: id, time_ms: this.now() });
      } else {
        // Resolved by orderStatus after an unknown outcome: prices and fees come ONLY from the fills (§6.6).
        await this.#sweep(ctx, this.#sweepSince(this.now() - 60_000));
      }
      const fillState = r.outcome === 'partial' ? 'partial' : this.#fillState(bot, Number(bot.target_szi) || 0, bot.real.szi, q.px);
      g.setSync(bot.id, { op, state: 'done', fill_state: fillState });
      this.marginStreak.delete(bot.id);
      g.clearExchangeError(bot.id);
      return { status, filledSz: filled, code: null };
    }
    if (r.outcome === 'resting') {
      this.log(`[testnet] ALERT garden ${this.uid}: an IOC order rested on the book (cloid ${cloid})`);
      return { status, filledSz: 0, code: null };
    }
    if (r.outcome === 'canceled' && !r.code) {
      // Resolved after an unknown outcome as canceled (e.g. IOC could not match): nothing happened.
      g.setSync(bot.id, { op, state: kind === 'flatten' ? 'pending' : 'done' });
      return { status, filledSz: 0, code: 'ioc_no_match' };
    }
    if (r.outcome === 'waiting') r.code = 'rejected_other';
    await this.#onError(ctx, bot, { ...r, unknown: r.outcome === 'unknown' }, { kind, reduceOnly, target, delta: signedSz });
    return { status, filledSz: 0, code: r.code ?? 'rejected_other' };
  }

  /** A fresh testnet mid for a flatten when the shared one is old (§6.11 Stale prices: flatten fetches its own). */
  async #freshMid(ctx, coin) {
    try {
      const mids = await this.#info().allMids({ ctx, priority: this.P.FLATTEN });
      const px = num(mids?.[coin]);
      return isPrice(px) ? { px, ms: this.now(), stale: false } : null;
    } catch (err) {
      if (isLaneAbort(err)) throw err;
      return null;
    }
  }

  /** The bot effect of an exchange error (§6.9 table). */
  async #onError(ctx, bot, out, { kind, reduceOnly = false, target = null, delta = 0 } = {}) {
    const g = this.garden;
    const code = out.code ?? 'rejected_other';
    const text = String(out.error ?? code).slice(0, 300);
    const op = kind === 'flatten' ? 'flatten' : kind === 'leverage' ? 'leverage' : 'mirror';
    if (out.credential) {
      g.setSync(bot.id, { op, state: 'failed', code: 'not_connected', error: 'testnet credential unavailable' });
      return;
    }
    if (out.outcome === 'skipped' && code !== 'address_rate_limited') {
      // Never transmitted (weight budget / back-off deadline / draining): planned again next bar.
      g.setSync(bot.id, { op, state: 'failed', code: code === 'ip_rate_limited' ? code : 'testnet_down', error: 'not sent (testnet busy)' });
      return;
    }
    switch (code) {
      case 'signature_mismatch':
        this.gardens?.haltSigning?.({ uid: this.uid, sample: text });
        g.setSync(bot.id, { op, state: 'failed', code, error: text });
        g.exchangeError(bot.id, code, 'testnet signing is halted for everyone (signature mismatch) — the operator has been alerted');
        return;
      case 'agent_unknown':
        g.setSync(bot.id, { op, state: 'failed', code, error: text });
        await this.#confirmAgent(ctx, code);
        return;
      case 'no_deposit':
        this.noDeposit = true;
        g.setSync(bot.id, { op, state: 'failed', code, error: text });
        if (!this.errorOnce.has('no_deposit')) {
          this.errorOnce.add('no_deposit');
          g.exchangeError(bot.id, code, 'the testnet account has no deposit — claim test USDC from the faucet', { faucet: FAUCET_URL });
        }
        await this.#confirmAgent(ctx, code);
        return;
      case 'min_notional':
        if (reduceOnly) bot.dust = { szi: Math.abs(delta), target };
        g.setSync(bot.id, { op, state: 'done' });
        return;
      case 'insufficient_margin': {
        const n = (this.marginStreak.get(bot.id) ?? 0) + 1;
        this.marginStreak.set(bot.id, n);
        g.setSync(bot.id, { op, state: 'failed', code, error: text });
        g.exchangeError(bot.id, code, 'insufficient margin on the testnet account');
        if (n >= MARGIN_STREAK_PAUSE) {
          this.marginStreak.delete(bot.id);
          g.pauseTestnetBot?.(bot.id, 'insufficient margin', 'insufficient_margin_repeat');
        }
        return;
      }
      case 'leverage_rejected':
        g.setSync(bot.id, { op, state: 'failed', code, error: text });
        g.exchangeError(bot.id, code, 'the testnet refused the leverage');
        g.pauseTestnetBot?.(bot.id, 'leverage rejected', 'leverage_rejected');
        return;
      case 'reduce_only':
        g.setSync(bot.id, { op, state: 'failed', code, error: text });
        this.requestSync('reconcile_now');
        return;
      case 'address_rate_limited':
        this.addrBackoffN++;
        this.addrBackoffUntil = this.now() + (this.lib.errors?.addressBackoffMs?.(this.addrBackoffN) ?? 10_000 * this.addrBackoffN);
        g.setSync(bot.id, { op, state: 'failed', code, error: text });
        g.exchangeError(bot.id, code, 'too many testnet requests for this address — slowing down');
        return;
      case 'ioc_no_match':
        g.setSync(bot.id, { op, state: kind === 'flatten' ? 'pending' : 'failed', code, error: text });
        if (!this.errorOnce.has(`ioc|${bot.id}|${target}`)) {
          this.errorOnce.add(`ioc|${bot.id}|${target}`);
          g.exchangeError(bot.id, code, 'the testnet book could not fill the order right now');
        }
        return;
      case 'client_error':
      case 'tick':
        this.log(`[testnet] ALERT garden ${this.uid}: ${code} on ${kind} (${text.slice(0, 120)})`);
        g.setSync(bot.id, { op, state: 'failed', code, error: text });
        g.exchangeError(bot.id, code, `the testnet refused the order (${code})`);
        return;
      default:
        g.setSync(bot.id, { op, state: 'failed', code, error: text });
        if (!out.unknown) g.exchangeError(bot.id, code, `the testnet refused the order (${code})`);
    }
  }

  /**
   * agent_unknown / no_deposit: confirm with testnet userRole(agent) (P4) before touching the credential. Missing, or
   * no longer an agent of this account → revoked: every testnet bot pauses (credential_revoked; no flatten is
   * possible) and credential_status is emitted. Still the account's agent → keep it (rejected_other + alert).
   */
  async #confirmAgent(ctx, cause) {
    const link = this.link();
    if (!link) return;
    let verdict = 'unavailable';
    try {
      if (typeof this.hl.verify?.confirmAgentRole === 'function') {
        verdict = await this.hl.verify.confirmAgentRole(link.agent_address, link.account_address, { ctx });
      } else {
        const role = await this.#info().userRole(link.agent_address, { ctx, priority: this.P.ORDER_STATUS });
        const user = typeof role?.data?.user === 'string' ? role.data.user.toLowerCase() : null;
        verdict = role?.role === 'agent' && user === link.account_address ? 'agent' : 'revoked';
      }
    } catch (err) {
      if (isLaneAbort(err)) throw err;
      return;
    }
    if (verdict === 'agent') {
      if (cause === 'agent_unknown') this.log(`[testnet] ALERT garden ${this.uid}: agent_unknown but userRole says the agent is live`);
      return;
    }
    if (verdict === 'revoked') this.markRevoked('agent_unknown');
  }

  /** The credential is gone (revoked on the exchange, mainnet hit, …): pause every testnet bot without orders. */
  markRevoked(reason, { status = 'revoked', noteCode = 'credential_revoked' } = {}) {
    try {
      this.credentials.setStatus(this.uid, status, reason);
    } catch {
      /* the row may already be gone */
    }
    const g = this.garden;
    if (g) {
      for (const bot of g.botList) {
        if (bot.state === 'closed' || venueOf(bot) !== 'testnet') continue;
        if (bot.closing) {
          g.setSync(bot.id, { op: 'flatten', state: 'failed', code: 'credential_revoked', error: 'the API wallet is no longer valid' });
          continue;
        }
        g.pauseFromExchange(bot.id, noteCode, { coin: bot.coin }, { why: 'testnet API wallet revoked' });
      }
    }
    this.journal.emit('credential_status', { status, reason });
    this.gardens?.audit?.({ user_id: this.uid, actor: 'system', action: 'testnet_revoked_detected', ok: true, detail: { reason } });
  }

  // ---- flatten (§6.11 Pause / Close) -----------------------------------------------------------------------------------

  /**
   * Flatten the WHOLE exchange position on the bot's coin (reduce-only IOC at P0, widening slippage). Resolves when
   * the flatten completed, or after its first attempt failed (the retry keeps running every 15 s).
   */
  requestFlatten(bot, reason = 'pause') {
    const g = this.garden;
    if (!bot || venueOf(bot) !== 'testnet') return Promise.resolve();
    g?.setSync(bot.id, { op: 'flatten', state: 'pending' });
    const waiter = new Promise((resolve) => {
      if (!this.flattenWaiters.has(bot.id)) this.flattenWaiters.set(bot.id, []);
      this.flattenWaiters.get(bot.id).push(resolve);
    });
    if (!this.flattens.has(bot.id)) {
      const p = this.#run(this.P.FLATTEN, `flatten:${reason}`, (ctx) => this.#flattenJob(ctx, bot.id, 0));
      this.flattens.set(bot.id, p);
      p.finally(() => {
        if (this.flattens.get(bot.id) === p) this.flattens.delete(bot.id);
      });
    }
    return waiter;
  }

  #resolveFlatten(botId) {
    const list = this.flattenWaiters.get(botId);
    this.flattenWaiters.delete(botId);
    if (list) for (const r of list) r();
  }

  #retryFlatten(botId, ms, attempt) {
    this.retryTimers.get(botId)?.cancel?.();
    const t = this.#later(ms, this.P.FLATTEN, `flatten-retry:${botId}`, (ctx) => {
      this.retryTimers.delete(botId);
      return this.#flattenJob(ctx, botId, attempt);
    });
    this.retryTimers.set(botId, t);
  }

  /** The flatten intent of a bot was withdrawn (a resume) or is moot: stop its retry timer and release its waiters. */
  #flattenWithdrawn(botId) {
    this.retryTimers.get(botId)?.cancel?.();
    this.retryTimers.delete(botId);
    this.#resolveFlatten(botId);
  }

  /**
   * Resume withdraws the flatten intent (§6.11 Pause): the pending retry timer is cancelled and the waiters released.
   * A flatten job still queued on the lane, or one in the middle of its awaits, re-checks wantsFlatten() before it
   * sends anything and stops, so a stale retry can neither flatten the now-active bot nor announce it as paused.
   */
  withdrawFlatten(bot) {
    if (!bot) return;
    this.#flattenWithdrawn(bot.id);
  }

  async #flattenJob(ctx, botId, attempt) {
    const g = this.garden;
    const bot = g?.botById(botId);
    if (!bot || bot.state === 'closed' || venueOf(bot) !== 'testnet') {
      this.#resolveFlatten(botId);
      return;
    }
    if (!wantsFlatten(bot)) {
      this.#flattenWithdrawn(botId); // a queued job or retry of an intent the player withdrew (resume)
      return;
    }
    const link = this.link();
    if (!link || link.status !== 'verified') {
      // Nothing can sign (disconnected / revoked / key unavailable): the intent stays in bot state (exchange_sync), and
      // a reconnect (Replace API wallet) or a restart re-issues it; retrying here could never succeed.
      g.setSync(bot.id, { op: 'flatten', state: 'failed', code: 'not_connected', error: 'no usable testnet credential' });
      this.#resolveFlatten(botId);
      return;
    }
    if (this.gardens?.signingHalted?.()) {
      // Not while signing is halted: the intent stays in the bot (exchange_sync) and resumes after the admin fix.
      g.setSync(bot.id, { op: 'flatten', state: 'failed', code: 'signature_mismatch', error: 'testnet signing is halted' });
      this.#resolveFlatten(botId);
      return;
    }
    let positions = null;
    try {
      positions = await this.#reconcile(ctx, this.P.FLATTEN);
    } catch (err) {
      if (isLaneAbort(err)) throw err;
    }
    if (!wantsFlatten(bot)) {
      this.#flattenWithdrawn(botId); // resumed while the reconcile was in flight
      return;
    }
    if (!positions) {
      g.setSync(bot.id, { op: 'flatten', state: 'failed', code: 'testnet_down', error: 'the testnet is not answering' });
      this.#resolveFlatten(botId);
      this.#retryFlatten(botId, FLATTEN_RETRY_MS, attempt);
      return;
    }
    const lot = 10 ** -bot.sz_decimals;
    const exch = this.#pos(bot.coin);
    if (Math.abs(exch.szi) < lot / 2) {
      // Already flat on the exchange: a size our books still hold was closed outside the garden.
      this.#settleExternalFlat(bot);
      await this.#flattenComplete(ctx, bot);
      return;
    }
    // The whole coin position is flattened: adopt it first so the fill accounting closes exactly that.
    if (Math.abs(exch.szi - bot.real.szi) >= lot / 2) {
      bot.real.szi = exch.szi;
      bot.real.entry_px = exch.entry_px ?? bot.real.entry_px;
    }
    const slip = this.lib.format?.flattenSlippage ? this.lib.format.flattenSlippage(attempt) : [0.01, 0.025, 0.05][Math.min(2, attempt)];
    const r = await this.#order(ctx, bot, { delta: roundTo(-exch.szi, bot.sz_decimals), reduceOnly: true, kind: 'flatten', reason: 'pause', slippage: slip, priority: this.P.FLATTEN });
    ctx.assertAlive();
    if (!(r?.filledSz > 0) && !wantsFlatten(bot)) {
      this.#flattenWithdrawn(botId); // resumed before the order was sent (#order checks it last) or it filled nothing
      return;
    }
    if (r && r.filledSz >= Math.abs(exch.szi) - lot / 2) {
      // Flat by our books: confirm with the exchange (clearinghouseState, weight 2) so the bot's exchange snapshot is
      // fresh, not the pre-flatten position. A coin that is still not flat (an external trade meanwhile) is flattened
      // again at once; an unanswered reconcile completes on our books (the next bar's reconcile catches up).
      let after = null;
      try {
        after = await this.#reconcile(ctx, this.P.FLATTEN);
      } catch (err) {
        if (isLaneAbort(err)) throw err;
      }
      ctx.assertAlive();
      if (after && Math.abs(this.#pos(bot.coin).szi) >= lot / 2) {
        this.#retryFlatten(botId, attempt < 2 ? 0 : FLATTEN_RETRY_MS, Math.min(attempt + 1, 2));
        this.#resolveFlatten(botId);
        return;
      }
      if (!after) this.positions.set(bot.coin, FLAT);
      await this.#flattenComplete(ctx, bot);
      return;
    }
    if (r && r.filledSz > 0) {
      // Partial: retried at once (§6.9) at the same slippage.
      this.#retryFlatten(botId, 0, attempt);
      this.#resolveFlatten(botId);
      return;
    }
    const code = r?.code ?? 'rejected_other';
    if (code === 'min_notional') {
      this.#flattenStuckOnDust(bot);
      return;
    }
    this.#resolveFlatten(botId);
    if (code === 'signature_mismatch' || code === 'agent_unknown' || code === 'credential_revoked') return;
    if (code === 'ioc_no_match' && attempt < 2) {
      this.#retryFlatten(botId, IOC_RETRY_MS, attempt + 1);
      return;
    }
    g.setSync(bot.id, { op: 'flatten', state: 'failed', code, error: `flatten retrying every ${FLATTEN_RETRY_MS / 1000} s` });
    this.#retryFlatten(botId, FLATTEN_RETRY_MS, Math.min(attempt + 1, 2));
  }

  /**
   * The exchange refused the reduce-only remainder as below the $10 minimum (risk K2; runbook R7 records the real
   * behaviour). `bot.dust` was recorded by #onError and stays visible. A PAUSING bot is paused (bot_paused) with its
   * dust shown. A CLOSING bot stays closing — it is never retired, nor its coin unbound, while the exchange still holds
   * a position (§6.11 Close); #closingWithDust looks again at every bar's reconcile. No retry timer: resending the
   * same order would be refused the same way.
   */
  #flattenStuckOnDust(bot) {
    const g = this.garden;
    this.retryTimers.get(bot.id)?.cancel?.();
    this.retryTimers.delete(bot.id);
    if (bot.closing) {
      g.setSync(bot.id, { op: 'flatten', state: 'failed', code: 'min_notional', error: 'the remainder is below the $10 minimum order' });
    } else if (bot.state === 'paused') {
      g.flattenDone(bot.id);
    }
    this.#resolveFlatten(bot.id);
  }

  /**
   * The exchange is flat on the bot's coin while our books still hold a size, and no order of ours on that coin is
   * unresolved: the position was closed outside the garden (by hand on the testnet site, for example). The foreign
   * fills are booked when they explain it exactly (realized P&L from the exchange, as for a liquidation); otherwise
   * the books are zeroed. Either way a position that no longer exists is never shown as held.
   */
  #settleExternalFlat(bot) {
    const lot = 10 ** -bot.sz_decimals;
    if (Math.abs(bot.real.szi) < lot / 2) return;
    if (this.repo.unresolvedOrders(this.uid).some((o) => o.coin === bot.coin)) return; // our own fill may still land
    const g = this.garden;
    const foreign = (this.unexplained.get(bot.coin) ?? []).filter((f) => num(f.time) >= (bot.created_ms ?? 0) - 5000);
    const net = foreign.reduce((s, f) => s + (f.side === 'B' ? 1 : -1) * (num(f.sz) ?? 0), 0);
    if (foreign.length && Math.abs(bot.real.szi + net) < lot / 2) {
      const fakeOrder = { bot_id: bot.id, coin: bot.coin, season: bot.season ?? 1 };
      for (const f of foreign) {
        const sz = num(f.sz) ?? 0;
        g.applyExchangeFill(bot.id, {
          delta: f.side === 'B' ? sz : -sz, px: num(f.px), oid: num(f.oid), order_id: null, time_ms: num(f.time) ?? this.now(),
          provisional: false, exact: this.#fillRow(fakeOrder, f),
        });
      }
      this.#consumeUnexplained(bot.coin, foreign);
    }
    bot.real.szi = 0;
    bot.real.entry_px = null;
    bot.real.unrealized_pnl = 0;
    bot.real.margin_used = 0;
    bot.real.liquidation_px = null;
  }

  /**
   * The bot is flat. Pausing → flattenDone (bot_paused). Closing → the completion fills sweep and the paginated
   * userFunding read make the numbers exact, then closeConfirmed({confirmed}) retires the bot; a failed sweep (or a
   * funding history too long to read whole) → confirmed:false, and a later bot_fill_confirmed corrects the fills
   * (§6.11 Close). A bot the player resumed while the flatten order was already on its way is NOT paused: it stays
   * active and its mirror re-plans from flat at the next bar (never a bot_paused for an active bot).
   */
  async #flattenComplete(ctx, bot) {
    const g = this.garden;
    this.retryTimers.get(bot.id)?.cancel?.();
    this.retryTimers.delete(bot.id);
    bot.dust = null;
    if (!bot.closing) {
      if (bot.state === 'paused') {
        g.flattenDone(bot.id);
        g.setSync(bot.id, { op: 'flatten', state: 'done' });
      }
      this.#resolveFlatten(bot.id);
      return;
    }
    let confirmed = false;
    try {
      const sw = await this.#sweep(ctx, this.#sweepSince(), { priority: this.P.FLATTEN });
      confirmed = Boolean(sw?.ok);
      if (confirmed) confirmed = (await this.#fundingExact(ctx, bot)) && confirmed;
    } catch (err) {
      if (isLaneAbort(err)) throw err;
      confirmed = false;
    }
    g.closeConfirmed(bot.id, { confirmed });
    this.#resolveFlatten(bot.id);
    if (!confirmed) this.#scheduleConfirmSweep(0);
  }

  /**
   * A close whose completion sweep failed was announced with confirmed:false (provisional numbers, ≈). Keep sweeping on
   * the lane (30 s, 60 s, … up to 10 tries) until no provisional fill is left; each success emits bot_fill_confirmed.
   */
  #scheduleConfirmSweep(attempt) {
    if (attempt >= 10) return;
    this.#later(30_000 * (attempt + 1), this.P.FILLS, 'confirm-sweep', async (ctx) => {
      if (this.repo.provisionalCount(this.uid) === 0) return;
      const sw = await this.#sweep(ctx, this.#sweepSince());
      if (!sw?.ok || this.repo.provisionalCount(this.uid) > 0) this.#scheduleConfirmSweep(attempt + 1);
    });
  }

  /**
   * userFunding(account, open_ms), paginated (§6.11 Funding): with the WHOLE history since the bot opened, its funding
   * becomes exact. Rows accrue per open position per hour across the account (other bots, manual positions), so a long
   * history can exceed FUNDING_MAX_PAGES × 500 rows: a partial sum would then be wrong, so the reconciled value
   * (banked + since-open, settled by the garden's retire) is kept and false is returned (the close is not confirmed).
   */
  async #fundingExact(ctx, bot) {
    const addr = this.#accountAddr();
    if (!addr || typeof this.#info().userFunding !== 'function') return false;
    try {
      const rows = await this.#info().userFunding(addr, Math.max(0, Math.trunc((bot.created_ms ?? this.now()) - 5000)), null,
        { ctx, priority: this.P.FLATTEN, maxPages: FUNDING_MAX_PAGES });
      if (rows?.meta?.complete === false) return false;
      let total = 0;
      for (const r of Array.isArray(rows) ? rows : []) {
        if (r?.delta?.coin !== bot.coin) continue;
        if (num(r.time) < (bot.created_ms ?? 0)) continue;
        total += num(r.delta.usdc) ?? 0;
      }
      bot.funding_realized = usd6(total);
      if (bot.exchange) bot.exchange = { ...bot.exchange, funding_since_open: 0 };
      return true;
    } catch (err) {
      if (isLaneAbort(err)) throw err;
      return false;
    }
  }

  // ---- create / resume / boot ---------------------------------------------------------------------------------------

  /** bot_create: leverage, then (bean positioned) the opening IOC — one lane job (§6.11 Create). */
  onCreate(bot) {
    const row = this.garden?.engine?.population?.row?.(bot.bean) ?? null;
    if (row) this.planTarget(bot, row);
    return this.#run(this.P.MIRROR, 'create', async (ctx) => {
      const ok = await this.#syncJob(ctx, 'create', { onlyBot: bot, leverageFirst: true });
      if (!ok) this.garden?.setSync(bot.id, { op: 'leverage', state: 'failed', code: this.state() === 'live' ? 'rejected_other' : 'testnet_down', error: 'not sent yet' });
      return ok;
    });
  }

  /**
   * bot_resume: withdraw any pending flatten intent (its retry timer and waiters; a queued or running flatten job
   * stops at its next check), then re-plan and mirror now (leverage is resent before an open from flat).
   */
  onResume(bot) {
    this.withdrawFlatten(bot);
    const row = this.garden?.engine?.population?.row?.(bot.bean) ?? null;
    bot.size_ratio = null; // a new episode: k is recomputed from current mids
    if (row) this.planTarget(bot, row);
    return this.#run(this.P.MIRROR, 'resume', (ctx) => this.#syncJob(ctx, 'resume', { onlyBot: bot }));
  }

  /**
   * Restart (§6.11): resolve pending/sent/unknown orders by cloid (unknownOid → canceled), reconcile before the first
   * mirror, sweep fills when orders resolved with fills, then re-issue every unfinished flatten intent that still
   * holds a position (closing, or exchange_sync.op = 'flatten'). Drift-paused bots are never flattened here.
   */
  boot() {
    return this.#run(this.P.FLATTEN, 'boot', async (ctx) => {
      const link = this.link();
      if (!link || link.status !== 'verified') return false;
      const res = await this.#resolveOrders(ctx, { boot: true });
      await this.#reconcile(ctx);
      if (res.resolvedWithFills || this.repo.provisionalCount(this.uid) > 0) {
        await this.#sweep(ctx, this.#sweepSince(res.oldestMs));
        await this.#reconcile(ctx);
      }
      const g = this.garden;
      for (const bot of g?.botList ?? []) {
        if (bot.state === 'closed' || venueOf(bot) !== 'testnet') continue;
        const intent = bot.closing || bot.exchange_sync?.op === 'flatten';
        if (!intent) continue;
        const drift = bot.note_code === 'position_drift' || bot.note_code === 'external_close';
        if (drift && !bot.closing) continue;
        this.requestFlatten(bot, bot.closing ? 'close' : 'resume_intent');
      }
      return true;
    });
  }

  /** After the admin clears a signing halt: resume every flatten intent (they were kept in bot state). */
  resumeIntents() {
    for (const bot of this.garden?.botList ?? []) {
      if (bot.state === 'closed' || venueOf(bot) !== 'testnet') continue;
      if (bot.closing || bot.exchange_sync?.op === 'flatten') this.requestFlatten(bot, 'resume_intent');
    }
  }

  /** Run `fn` on the player's lane after in-flight jobs finish (Replace API wallet, §6.7 step 8). */
  runExclusive(fn, priority = this.P.MIRROR) {
    if (!this.alive()) return Promise.resolve(fn());
    return this.lane.run(priority, async () => fn(), { label: 'exclusive' }).catch((err) => {
      if (isLaneAbort(err)) return null;
      throw err;
    });
  }

  /** A fresh reconcile on the lane (testnet_verify / connect refresh the cached account). */
  refresh() {
    return this.#run(this.P.RECONCILE, 'refresh', (ctx) => this.#reconcile(ctx));
  }
}

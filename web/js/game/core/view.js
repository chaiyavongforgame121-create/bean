/**
 * core/view.js — PURE derivations from server data to what the 3D page shows (GAME-DESIGN §9.3).
 *
 *   plotView(bot, slot, ctx)          → PlotView: everything the field, chips, dock and inspector need for a slot
 *   assignSlots(open, prev, opts)     → stable bot → slot map (+ hidden bots beyond the drawn plots)
 *   slotCountOf(live, openBots)       → number of drawn plots (§2.3)
 *   slotXZ(i, count)                  → plot centre on the island (§2.3), shared with the placeholder field
 *   liqInfo({szi, mark, entry, liq})  → distance to liquidation (thermometer)
 *   ageTag(ms, nowMs)                 → 'fresh' | 'delayed' | 'stale'
 *   feedOf(status, health)            → store.feed (normalised from the status/health payloads)
 *   feedBadge({status, marks, net, nowMs}) → the mode badge truth table (§6.3)
 *   moneyView(live, marks)            → barn / pond / tower / growing / harvested numbers (+ landmark fills)
 *   closedTotals(bots)                → crates (gains) and compost (losses) totals
 *   sceneSummary(views)               → the screen-reader scene sentence
 *   viewsOf(state, nowMs)             → {[slot]: PlotView} for every drawn open bot (main.js recomputes on data)
 *
 * Honesty (Juice Contract J1): numbers are the server's. A newer server mark (`mids` pulse) replaces the
 * BotRow numbers only when it is NEWER; when only a raw price is newer, the client estimate
 * unrealized ≈ szi·(px − entry) is used and the view says so (`est: true`, shown with "≈").
 *
 * "now": ages are measured on the SERVER clock — client Date.now() + net.skewMs. Functions taking `skewMs`
 * add it themselves; the others expect an already server-relative nowMs.
 * Slots are 0-based everywhere in code; labels show slot + 1 ("Plot 01").
 *
 * Pure module: no DOM, no three.js, no side effects at import.
 */

import { stage } from '../../plant.js';
import { familyOf, COSTS } from '../../model.js';
import { clamp, isNum } from '../../format.js';

// ------------------------------------------------------------------ constants

/** Coins with their own crop (§3.1); anything else is the beanstalk 'other'. */
export const CROP_COINS = Object.freeze(['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE', 'AVAX', 'LINK', 'SUI', 'NEAR', 'ARB', 'TIA', 'ZEC', 'WIF', 'PUMP', 'VVV']);

/** Number-age thresholds (§6.12 / §6.13 rule 5). */
export const AGE = Object.freeze({ freshMs: 15_000, delayedMs: 60_000 });

/** Drawn plots: at least 10, at most 15 (§2.3). */
export const SLOTS = Object.freeze({ min: 10, max: 15, perRow: 5, pitch: 4.4 });

/** Liquidation thermometer bands (§3.2): d > 0.6 ok, > 0.3 warn, else danger. */
export const LIQ_BANDS = Object.freeze({ ok: 0.6, warn: 0.3 });

const num = (x) => (isNum(x) ? Number(x) : NaN);
const fin = (x) => Number.isFinite(x);
const or = (...xs) => {
  for (const x of xs) if (isNum(x)) return Number(x);
  return null;
};

/** i18n suffix of the crop name: `g.crop.${cropKey(coin)}`. */
export function cropKey(coin) {
  return CROP_COINS.includes(String(coin)) ? String(coin) : 'other';
}

/** Server-style liquidation price: entry × (1 ∓ 0.95 / lev) for long (+szi) / short (−szi). */
export function liqPrice(entry, lev, side) {
  const e = num(entry);
  const l = num(lev);
  const s = Math.sign(num(side));
  if (!fin(e) || !(l > 0) || !s) return null;
  return e * (1 - (s * COSTS.liqFraction) / l);
}

// ------------------------------------------------------------------ liquidation distance

/**
 * Distance to liquidation of a position.
 *   movePct = |mark − liq| / mark  (the price move that liquidates, as a fraction; 0 once crossed)
 *   d       = clamp(|mark − liq| / |entry − liq|, 0, 1)  (thermometer fill)
 *   dir     = 'fall' (long) | 'rise' (short)
 *   band    = d > 0.6 'ok' · d > 0.3 'warn' · else 'danger'
 * → null when flat or a number is missing.
 */
export function liqInfo({ szi, mark, entry, liq } = {}) {
  const s = Math.sign(num(szi));
  const m = num(mark);
  const e = num(entry);
  const l = num(liq);
  if (!s || !fin(m) || !fin(e) || !fin(l) || m <= 0) return null;
  // signed room: positive while the price is still on the safe side of the liquidation price
  const room = s > 0 ? m - l : l - m;
  const span = Math.abs(e - l);
  const movePct = Math.max(0, room) / m;
  const d = span > 0 ? clamp(Math.max(0, room) / span, 0, 1) : 0;
  const band = d > LIQ_BANDS.ok ? 'ok' : d > LIQ_BANDS.warn ? 'warn' : 'danger';
  return { d, movePct, dir: s > 0 ? 'fall' : 'rise', band };
}

// ------------------------------------------------------------------ ages

/** 'fresh' (≤ 15 s) | 'delayed' (≤ 60 s) | 'stale' (older, or unknown). */
export function ageTag(ms, nowMs) {
  const t = num(ms);
  const now = num(nowMs);
  if (!fin(t) || !fin(now)) return 'stale';
  const age = now - t;
  if (age <= AGE.freshMs) return 'fresh';
  if (age <= AGE.delayedMs) return 'delayed';
  return 'stale';
}

/** Compact, language-neutral age: 45000 → '45 s', 125000 → '2 min', 7200000 → '2 h'. */
export function fmtAge(ms) {
  const a = num(ms);
  if (!fin(a)) return '—';
  const s = Math.max(0, Math.round(a / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}

/** Local wall-clock 'HH:MM' for "since 12:03" texts; '—' when unknown. */
export function hhmm(ms) {
  const t = num(ms);
  if (!fin(t) || t <= 0) return '—';
  const d = new Date(t);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ------------------------------------------------------------------ marks merging

/** coin → CoinRow from either a map or an array (market.coins / meta.coins). */
function coinRow(coins, coin) {
  if (!coins) return null;
  if (Array.isArray(coins)) return coins.find((c) => c && c.coin === coin) || null;
  return coins[coin] || null;
}

/**
 * Merge the newest server numbers into a BotRow (§9.3 "How the marks are merged").
 * → { bot: merged BotRow, est, markPx, markMs, markEst, source: 'marks'|'estimate'|'bot' }
 *   - marks.bots[bot.id] newer than bot.real.as_of_ms → its numbers replace the row's (server values);
 *   - else marks.px[coin] newer and the bot holds a position → unrealized ≈ szi·(px − entry), est = true;
 *   - else the row as-is (the mark falls back to BotRow.mark_px, then the market mid with markEst = true).
 * Closed bots are never re-marked.
 */
export function mergeMarks(bot, marks, coins) {
  // A testnet bot (PLATFORM §7.5, §9.6) is marked at the TESTNET mid: the mainnet `px` of the mids frame and the
  // mainnet market rows never price it. Its server marks (marks.bots[id]) already come at the testnet mid.
  if (bot?.venue === 'testnet') return mergeTestnet(bot, marks);
  const real = bot?.real || {};
  const botAsOf = or(real.as_of_ms, bot?.mark_ms, bot?.updated_ms) ?? 0;
  const open = bot && bot.state !== 'closed';
  const m = open ? marks?.bots?.[bot.id] : null;
  const staleCoin = Array.isArray(marks?.stale) && marks.stale.includes(bot?.coin);

  if (m && num(m.as_of_ms) > botAsOf) {
    const merged = {
      ...bot,
      realized_pnl: or(m.realized_pnl, bot.realized_pnl),
      mark_px: or(m.mark_px, bot.mark_px),
      notional_usd: or(m.notional_usd, bot.notional_usd),
      price_stale: m.price_stale ?? bot.price_stale,
      real: {
        ...real,
        szi: or(m.szi, real.szi),
        entry_px: m.entry_px === null ? null : or(m.entry_px, real.entry_px),
        unrealized_pnl: or(m.unrealized_pnl, real.unrealized_pnl),
        margin_used: or(m.margin_used, real.margin_used),
        liquidation_px: m.liquidation_px === null ? null : or(m.liquidation_px, real.liquidation_px),
        as_of_ms: num(m.as_of_ms),
      },
    };
    return { bot: merged, est: false, markPx: or(m.mark_px), markMs: num(m.as_of_ms), markEst: false, source: 'marks' };
  }

  const szi = num(real.szi);
  const entry = num(real.entry_px);
  const px = num(marks?.px?.[bot?.coin]);
  if (open && !staleCoin && fin(px) && num(marks?.t) > botAsOf && szi && fin(entry)) {
    const merged = { ...bot, real: { ...real, unrealized_pnl: szi * (px - entry) } };
    return { bot: merged, est: true, markPx: px, markMs: num(marks.t), markEst: false, source: 'estimate' };
  }

  let markPx = or(bot?.mark_px);
  let markEst = false;
  if (markPx === null && open) {
    const c = coinRow(coins, bot?.coin);
    markPx = or(c?.px, c?.mid);
    markEst = markPx !== null;
  }
  const markMs = or(bot?.mark_ms, real.as_of_ms);
  return { bot, est: false, markPx, markMs, markEst, source: 'bot' };
}

/**
 * Testnet mid for a coin from the `testnet` part of a mids frame (PLATFORM §7.5), whatever its exact layout:
 * { px: {coin: n}, t } · { mids: {coin: n}, mids_ms } · { coins: [{coin, mid, mid_ms}] } · { [coin]: {mid, mid_ms} }.
 * → { px, ms } (nulls when unknown). Never falls back to a mainnet price.
 */
export function testnetPx(marks, coin) {
  const tn = marks?.testnet;
  if (!tn || typeof tn !== 'object' || !coin) return { px: null, ms: null };
  const at = or(tn.t, tn.mids_ms, tn.as_of_ms, marks?.t);
  if (tn.px && typeof tn.px === 'object' && isNum(tn.px[coin])) return { px: Number(tn.px[coin]), ms: at };
  if (tn.mids && typeof tn.mids === 'object' && isNum(tn.mids[coin])) return { px: Number(tn.mids[coin]), ms: at };
  if (Array.isArray(tn.coins)) {
    const r = tn.coins.find((c) => c && c.coin === coin);
    if (r && isNum(r.mid)) return { px: Number(r.mid), ms: or(r.mid_ms, at) };
  }
  const r = tn[coin];
  if (r && typeof r === 'object' && isNum(r.mid)) return { px: Number(r.mid), ms: or(r.mid_ms, at) };
  return { px: null, ms: null };
}

/**
 * The marks merge for a testnet bot: the server's own mark (marks.bots[id], computed at the testnet mid and
 * flagged est by the server) when newer; else the testnet mid from the frame, with unrealized ≈ szi·(mid − entry)
 * (always an estimate, §9.6 J1); else the row as-is. `est` is also true when the row says so (`est` array).
 */
function mergeTestnet(bot, marks) {
  const real = bot?.real || {};
  const botAsOf = or(real.as_of_ms, bot?.mark_ms, bot?.updated_ms) ?? 0;
  const open = bot && bot.state !== 'closed';
  const rowEst = Array.isArray(bot?.est) && bot.est.includes('unrealized_pnl');
  const m = open ? marks?.bots?.[bot.id] : null;
  if (m && num(m.as_of_ms) > botAsOf) {
    const merged = {
      ...bot,
      realized_pnl: or(m.realized_pnl, bot.realized_pnl),
      mark_px: or(m.mark_px, bot.mark_px),
      notional_usd: or(m.notional_usd, bot.notional_usd),
      price_stale: m.price_stale ?? bot.price_stale,
      // which numbers are estimates now (e.g. margin_used right after a fill, before the exchange reports it)
      est: Array.isArray(m.est) || m.est === null ? m.est : bot.est,
      real: {
        ...real,
        szi: or(m.szi, real.szi),
        entry_px: m.entry_px === null ? null : or(m.entry_px, real.entry_px),
        unrealized_pnl: or(m.unrealized_pnl, real.unrealized_pnl),
        margin_used: or(m.margin_used, real.margin_used),
        // the exchange's liquidationPx only (never invented, J7)
        liquidation_px: m.liquidation_px === null ? null : or(m.liquidation_px, real.liquidation_px),
        as_of_ms: num(m.as_of_ms),
      },
    };
    const est = m.est === true || (Array.isArray(m.est) && m.est.includes('unrealized_pnl')) || rowEst;
    return { bot: merged, est, markPx: or(m.mark_px), markMs: num(m.as_of_ms), markEst: false, source: 'marks' };
  }
  const szi = num(real.szi);
  const entry = num(real.entry_px);
  const q = testnetPx(marks, bot?.coin);
  if (open && fin(q.px) && (q.ms ?? 0) > botAsOf && szi && fin(entry)) {
    const merged = { ...bot, mark_px: q.px, real: { ...real, unrealized_pnl: szi * (q.px - entry) } };
    return { bot: merged, est: true, markPx: q.px, markMs: q.ms, markEst: false, source: 'estimate' };
  }
  const markPx = or(bot?.mark_px) ?? (open ? q.px : null);
  const markEst = or(bot?.mark_px) === null && markPx !== null;
  return { bot, est: rowEst, markPx, markMs: or(bot?.mark_ms, real.as_of_ms, q.ms), markEst, source: 'bot' };
}

// ------------------------------------------------------------------ plot view

/**
 * PlotView for one slot (§9.3). `ctx` = { marks, coins, nowMs, skewMs, bean (BeanRow|undefined), halted,
 * staleCoins }. Ages use nowMs + skewMs − markMs: pass the client clock plus `net.skewMs` (or a server-relative
 * nowMs and no skew).
 *
 * PlotView = {
 *   slot, botId, beanId, coin, crop, family, archetype, strategy,
 *   state: 'waiting'|'entering'|'growing'|'paused'|'closed', phase, note, error, beanSide,
 *   side: 1|-1|0, lev, beanLev, venueMaxLev, szDecimals,
 *   water, realized, unrealized, fees, fills, usd, frac, pct,   // money: server numbers (frac of water; pct = frac×100)
 *   size, health, fruit, flower, seed, caption, ripe,          // = stage(merged bot) exactly
 *   szi, entry, mark, notional, margin, marginEst, liq,        // position (marginEst: testnet ≈ margin)
 *   liqInfo, markMs, ageTag, est, markEst,                     // est: unrealized is a client ≈ estimate
 *   stale, frozen, halted, updatedMs }
 */
export function plotView(bot, slot, { marks = null, coins = null, nowMs = Date.now(), skewMs = 0, bean = null, halted = false, staleCoins = [] } = {}) {
  const now = (Number(nowMs) || 0) + (Number(skewMs) || 0); // server-relative "now" (§9.3)
  const merge = mergeMarks(bot, marks, coins);
  const b = merge.bot;
  const vf = venueFields(b);
  // testnet: Total P&L = realized + funding (realized and since open) + unrealized (§6.11); the plant grows from it
  const s = stage(vf.funding ? { ...b, realized_pnl: (or(b.realized_pnl) ?? 0) + vf.funding } : b);
  const real = b.real || {};
  const szi = num(real.szi) || 0;
  const side = Math.sign(szi);
  const c = coinRow(coins, b.coin);
  const szDecimals = or(b.sz_decimals, c?.sz_decimals) ?? 0;

  let state;
  if (s.phase === 'closed') state = 'closed';
  else if (s.phase === 'paused') state = 'paused';
  else if (side !== 0) state = 'growing';
  else state = num(b.bean_side) ? 'entering' : 'waiting';

  const mark = merge.markPx;
  const entry = or(real.entry_px);
  const lev = or(b.leverage, real.leverage) ?? 1;
  const testnet = b.venue === 'testnet';
  // testnet: only the exchange's liquidationPx, "—" until the first reconcile (§9.6 J7); paper: the server rule
  let liq = or(real.liquidation_px, testnet ? b.exchange?.liquidation_px : null);
  if (liq === null && side && !testnet) liq = liqPrice(entry, lev, side);
  const notional = side && mark !== null ? Math.abs(szi) * mark : or(b.notional_usd) ?? 0;

  const stale = !!(
    b.price_stale ||
    (Array.isArray(marks?.stale) && marks.stale.includes(b.coin)) ||
    (Array.isArray(staleCoins) && staleCoins.includes(b.coin))
  );
  const tag = ageTag(merge.markMs, now);
  // A flat plot has nothing to mark: only a held position can be "frozen" by an old price.
  const frozen = state !== 'closed' && (stale || (side !== 0 && tag === 'stale'));

  return {
    slot,
    botId: b.id,
    beanId: or(b.bean),
    coin: b.coin,
    crop: cropKey(b.coin),
    family: familyOf(bean?.archetype),
    archetype: bean?.archetype ?? null,
    strategy: bean?.strategy ?? null,
    state,
    phase: s.phase,
    note: b.note ?? null,
    error: b.last_error ?? null,
    beanSide: Math.sign(num(b.bean_side) || 0),
    side,
    lev,
    beanLev: or(bean?.leverage),
    // testnet bots: only the testnet listing's cap (from the BotRow); never the mainnet one, which can differ
    venueMaxLev: testnet ? or(b.venue_max_leverage) : or(bean?.venue_max_leverage, c?.max_leverage),
    szDecimals,
    water: or(b.capital_usd) ?? 0,
    realized: or(b.realized_pnl) ?? 0,
    unrealized: or(real.unrealized_pnl) ?? 0,
    fees: or(b.fees) ?? 0,
    fills: or(b.fills) ?? 0,
    usd: s.usd,
    frac: s.frac,
    pct: s.frac * 100,
    size: s.size,
    health: s.health,
    fruit: s.fruit,
    flower: s.flower,
    seed: s.seed,
    caption: s.caption,
    ripe: s.caption === 'ripe',
    szi,
    entry,
    mark,
    notional,
    margin: or(real.margin_used),
    // testnet: the margin is our ≈ estimate until the exchange reports the position we hold (§9.6 J1)
    marginEst: testnet && Array.isArray(b.est) && b.est.includes('margin_used'),
    liq,
    liqInfo: liqInfo({ szi, mark, entry, liq }),
    markMs: merge.markMs,
    ageTag: tag,
    est: merge.est,
    markEst: merge.markEst,
    stale,
    frozen,
    halted: !!halted,
    updatedMs: or(b.updated_ms),
    ...vf,
  };
}

/**
 * The venue part of a PlotView (PLATFORM §8.5, §9.4). Paper bots (and every none-mode bot) get
 * `{ venue: 'paper' }` plus nulls, so paper views only gain keys, never change.
 *   venue, closing (close requested, flatten pending), sync (exchange_sync {op, state, since_ms, attempts, code}),
 *   fillState ('in_sync'|'partial'|'unfilled'|'waiting_bean'), targetSzi, exchange (last clearinghouseState
 *   numbers), sizeRatio ({k, …}), funding (realized + since open), feesEst (provisional fees), dust ({szi}),
 *   noteCode / noteVars (the machine code of a pause note).
 */
export function venueFields(b) {
  const testnet = b?.venue === 'testnet';
  const ex = testnet && b.exchange && typeof b.exchange === 'object' ? b.exchange : null;
  const sync = testnet && b.exchange_sync && typeof b.exchange_sync === 'object' ? b.exchange_sync : null;
  const fundingRealized = or(b?.funding_realized);
  const fundingOpen = or(ex?.funding_since_open);
  return {
    venue: testnet ? 'testnet' : 'paper',
    closing: testnet && (!!b.closing || sync?.op === 'flatten'),
    sync,
    fillState: testnet ? b.fill_state ?? null : null,
    targetSzi: testnet ? or(b.target_szi) : null,
    exchange: ex,
    sizeRatio: testnet && b.size_ratio && typeof b.size_ratio === 'object' ? b.size_ratio : null,
    funding: testnet && (fundingRealized !== null || fundingOpen !== null) ? (fundingRealized ?? 0) + (fundingOpen ?? 0) : null,
    feesEst: testnet && !!b.fees_estimated,
    dust: testnet && b.dust && typeof b.dust === 'object' ? b.dust : null,
    noteCode: typeof b?.note_code === 'string' ? b.note_code : null,
    noteVars: b?.note_vars && typeof b.note_vars === 'object' ? b.note_vars : null,
    // accounts mode: the machine code of last_error (BotRow `last_error_code`), so a reload still localizes it
    errorCode: typeof b?.last_error_code === 'string' ? b.last_error_code : null,
    errorVars: b?.last_error_vars && typeof b.last_error_vars === 'object' ? b.last_error_vars : null,
  };
}

/** The merged bot behind a view's numbers (for closeQuote and the inspector). */
export function viewBot(bot, marks, coins) {
  return mergeMarks(bot, marks, coins).bot;
}

// ------------------------------------------------------------------ slots

/** Drawn plots: clamp(max(10, caps.max_bots, open bots), 10, 15) (§2.3). */
export function slotCountOf(live, openBots) {
  const open = Array.isArray(openBots) ? openBots.length : Number(openBots) || 0;
  const cap = num(live?.caps?.max_bots);
  return clamp(Math.max(SLOTS.min, fin(cap) ? cap : 0, open), SLOTS.min, SLOTS.max);
}

/** Plot centre (x, z) in world units for slot i of `count` (§2.3): 5 per row, pitch 4.4, grid recentred. */
export function slotXZ(i, count = SLOTS.min) {
  const rows = Math.ceil(clamp(count, 1, SLOTS.max) / SLOTS.perRow);
  const r = Math.floor(i / SLOTS.perRow);
  const c = i % SLOTS.perRow;
  return { x: -8.8 + c * SLOTS.pitch, z: -(rows - 1) * 2.2 + r * SLOTS.pitch };
}

/**
 * Stable bot → slot assignment (§9.3):
 *   1. still-open bots keep their previous slot (if it is still drawn and not taken);
 *   2. a bot whose bean has a `wanted` slot (from the plant dialog) gets it if free;
 *   3. the rest take the lowest free slot, in the given (server) order;
 *   4. bots that do not fit are `hidden` (dock / list only).
 * → { map: {botId: slot}, hidden: [botId] }
 */
export function assignSlots(openBots, prevMap = {}, { slotCount = SLOTS.min, wanted = {} } = {}) {
  const bots = (openBots || []).filter((b) => b && b.id !== undefined && b.state !== 'closed');
  const map = {};
  const taken = new Set();
  const valid = (s) => Number.isInteger(s) && s >= 0 && s < slotCount && !taken.has(s);

  for (const b of bots) {
    const s = prevMap?.[b.id];
    if (valid(s)) {
      map[b.id] = s;
      taken.add(s);
    }
  }
  for (const b of bots) {
    if (b.id in map) continue;
    const s = wanted?.[b.bean];
    if (valid(s)) {
      map[b.id] = s;
      taken.add(s);
    }
  }
  const hidden = [];
  for (const b of bots) {
    if (b.id in map) continue;
    let s = 0;
    while (s < slotCount && taken.has(s)) s++;
    if (s < slotCount) {
      map[b.id] = s;
      taken.add(s);
    } else hidden.push(b.id);
  }
  return { map, hidden };
}

/** Lowest free slot given a bot → slot map, or null when the field is full. */
export function firstFreeSlot(map, slotCount = SLOTS.min, wanted = {}) {
  const taken = new Set([...Object.values(map || {}), ...Object.values(wanted || {})]);
  for (let s = 0; s < slotCount; s++) if (!taken.has(s)) return s;
  return null;
}

// ------------------------------------------------------------------ feed + badge

/**
 * store.feed from the raw `status` (+ `health`) payloads. Tolerates the pre-real-feed backend (no `state`,
 * `prices`, …): prices then follow the source name and the state is inferred.
 */
export function feedOf(status, health) {
  const f = status?.feed && typeof status.feed === 'object' ? status.feed : {};
  const source = f.source ?? (typeof health?.feed === 'string' ? health.feed : null) ?? (typeof status?.feed === 'string' ? status.feed : null);
  let prices;
  if (typeof f.real === 'boolean') prices = f.real ? 'real' : 'sim';
  else if (health?.prices === 'real' || health?.prices === 'sim') prices = health.prices;
  else if (status?.prices === 'real' || status?.prices === 'sim') prices = status.prices;
  else prices = source === 'hyperliquid' ? 'real' : 'sim';
  const known = ['live', 'delayed', 'down', 'sim'];
  let state = known.includes(f.state) ? f.state : known.includes(health?.feed_state) ? health.feed_state : null;
  if (!state) state = prices === 'sim' ? 'sim' : f.ok === false ? 'delayed' : 'live';
  const staleCoins = Array.isArray(f.stale_coins) ? f.stale_coins.filter((c) => typeof c === 'string') : [];
  const daemon = health?.daemon || status?.daemon || {};
  return {
    source,
    prices,
    state,
    staleCoins,
    fallback: f.fallback ?? null,
    realAvailable: typeof f.real_available === 'boolean' ? f.real_available : null,
    nextTickMs: or(f.next_tick_ms, daemon.next_tick_ms),
    lastBarCloseMs: or(f.last_bar_close_ms),
    lagBars: or(f.lag_bars) ?? 0,
    tickMs: or(daemon.tick_ms),
    midsMs: or(f.mids_ms),
    midsAgeMs: or(f.mids_age_ms),
  };
}

const isFeedShape = (x) => !!x && typeof x === 'object' && (x.prices === 'real' || x.prices === 'sim') && 'state' in x && 'staleCoins' in x;

/**
 * Mode badge truth table (§6.3). `status` is the raw status payload or an already-normalised store.feed;
 * the marks age is nowMs + skewMs − marks.t (pass a server-relative nowMs, or the client clock + skewMs).
 * → { key, tone: 'real'|'warn'|'off'|'sim', vars, short }
 *   offline (client cannot reach the API) › sim › down › delayed (state, or marks older than 15 s)
 *   › real with stale coins › real.
 */
export function feedBadge({ status, marks = null, net = null, nowMs = Date.now(), skewMs = 0 } = {}) {
  const f = isFeedShape(status) ? status : feedOf(status);
  nowMs = (Number(nowMs) || 0) + (Number(skewMs) || 0);
  const short = f.prices === 'sim' ? 'g.badge.short.sim' : 'g.badge.short.real';
  if (net && net.ok === false) {
    return { key: 'g.badge.offline', tone: 'off', vars: { time: hhmm(net.lastOkMs) }, short };
  }
  if (f.prices === 'sim') return { key: 'g.badge.sim', tone: 'sim', vars: {}, short };
  if (f.state === 'down') {
    return { key: 'g.badge.down', tone: 'off', vars: { time: hhmm(or(f.midsMs, marks?.t, f.lastBarCloseMs)) }, short };
  }
  const t = or(marks?.t, f.midsMs);
  const ageMs = t !== null ? Math.max(0, nowMs - t) : or(f.midsAgeMs);
  if (f.state === 'delayed' || (ageMs !== null && ageMs > AGE.freshMs)) {
    return { key: 'g.badge.delayed', tone: 'warn', vars: { age: fmtAge(ageMs), ageMs }, short };
  }
  const stale = new Set([...(f.staleCoins || []), ...(Array.isArray(marks?.stale) ? marks.stale : [])]);
  if (stale.size) return { key: 'g.badge.realPartial', tone: 'warn', vars: { n: stale.size, coins: [...stale].join(', ') }, short };
  return { key: 'g.badge.real', tone: 'real', vars: {}, short };
}

// ------------------------------------------------------------------ money

/**
 * HUD money and landmark levels (§1.5 fields). Newer `mids` account numbers replace the live_status ones.
 * → { barn, start, vsStartPct, pond, tower, growing, harvested, plants, active, maxPlants,
 *     openNotional, notionalCap, room, fills: {tower, pond, silo}, ages: {ms, source} }
 * `fills` are 0..1 levels for World.setMoney (silo: account_value / (2·start), start line at 0.5).
 */
export function moneyView(live, marks) {
  const acct = live?.account_state || {};
  const ma = marks?.account;
  const useMarks = !!ma && num(marks?.t) > (or(acct.as_of_ms) ?? 0);
  const pick = (k, v) => (useMarks && isNum(ma[k]) ? Number(ma[k]) : or(v));
  const barn = pick('account_value', acct.account_value);
  const start = or(live?.account_usd);
  const pond = pick('available_usd', live?.available_usd);
  const tower = pick('deployed_usd', live?.deployed_usd);
  const openNotional = pick('open_notional_usd', live?.open_notional_usd);
  const notionalCap = or(live?.caps?.max_total_notional_usd);
  const lvl = (a, b) => (a !== null && b > 0 ? clamp(a / b, 0, 1) : 0);
  return {
    barn,
    start,
    vsStartPct: barn !== null && start > 0 ? barn / start - 1 : null,
    pond,
    tower,
    growing: pick('unrealized_pnl', live?.unrealized_pnl),
    harvested: pick('realized_pnl', live?.realized_pnl),
    plants: live ? (or(live.active) ?? 0) + (or(live.paused) ?? 0) : null,
    active: or(live?.active),
    maxPlants: or(live?.caps?.max_bots),
    openNotional,
    notionalCap,
    room: notionalCap !== null && openNotional !== null ? Math.max(0, notionalCap - openNotional) : null,
    fills: { tower: lvl(tower, barn), pond: lvl(pond, start), silo: start > 0 && barn !== null ? clamp(barn / (2 * start), 0, 1) : 0 },
    ages: { ms: moneyAsOf(live, marks, useMarks, openNotional), source: useMarks ? 'marks' : 'live' },
  };
}

/**
 * The age the money numbers carry is the age of the PRICES behind them (J1, §6.13 rule 5), never the time a
 * payload was fetched: the oldest of the marks frame and every positioned bot's mark in it; on the
 * live_status path its `account_state.as_of_ms` (the server's oldest open mark), capped by the marks frame
 * when positions are open (live_status is re-fetched every 20 s, its prices are only as new as the marks).
 */
function moneyAsOf(live, marks, useMarks, openNotional) {
  const times = [];
  const t = num(marks?.t);
  if (useMarks) {
    times.push(t);
    for (const b of Object.values(marks?.bots || {})) {
      if (b && num(b.szi) && fin(num(b.as_of_ms))) times.push(num(b.as_of_ms));
    }
  } else {
    times.push(or(live?.account_state?.as_of_ms));
    if (fin(t) && (openNotional ?? 0) > 0) times.push(t);
  }
  const ok = times.filter((x) => fin(x));
  return ok.length ? Math.min(...ok) : null;
}

/** Closed bots: crates (realized ≥ 0) and compost (realized < 0), counts and dollar totals. */
export function closedTotals(bots) {
  const out = { crates: { n: 0, usd: 0 }, compost: { n: 0, usd: 0 } };
  for (const b of bots || []) {
    if (!b || b.state !== 'closed') continue;
    const r = num(b.realized_pnl) || 0;
    const box = r >= 0 ? out.crates : out.compost;
    box.n += 1;
    box.usd += r;
  }
  return out;
}

/** Screen-reader scene summary: { key: 'g.a11y.scene'|'g.a11y.sceneEmpty', vars: {n, up, down} }. */
export function sceneSummary(views) {
  const list = Object.values(views || {}).filter((v) => v && v.botId !== undefined && v.state !== 'closed');
  if (!list.length) return { key: 'g.a11y.sceneEmpty', vars: { n: 0, up: 0, down: 0 } };
  const up = list.filter((v) => v.usd > 0).length;
  const down = list.filter((v) => v.usd < 0).length;
  return { key: 'g.a11y.scene', vars: { n: list.length, up, down } };
}

/** Server-relative age of the newest marks (ms), or null without marks. */
export function marksAge(marks, nowMs) {
  const t = num(marks?.t);
  return fin(t) ? Math.max(0, nowMs - t) : null;
}

/**
 * Every drawn plot's view from the store state (§9.6 step 3): open bots that have a slot. `nowMs` is the
 * client clock; the state's `net.skewMs` makes ages server-relative.
 */
export function viewsOf(state, nowMs = Date.now()) {
  const out = {};
  const map = state?.slots?.map || {};
  const ctx = {
    marks: state?.marks ?? null,
    coins: state?.market?.coins ?? null,
    nowMs,
    skewMs: state?.net?.skewMs || 0,
    halted: !!state?.live?.halted,
    staleCoins: state?.feed?.staleCoins || [],
  };
  for (const bot of state?.bots || []) {
    if (!bot || bot.state === 'closed') continue;
    const slot = map[bot.id];
    if (!Number.isInteger(slot)) continue;
    out[slot] = plotView(bot, slot, { ...ctx, bean: state?.beans?.[bot.bean] ?? null });
  }
  return out;
}

/**
 * model.js — pure trading/garden helpers shared by the classic 2D page (garden.js) and the 3D game.
 *
 * No DOM, no three.js, no side effects at import: everything here runs under `node --test`.
 * The first block moved here from garden.js unchanged (garden.js re-exports it, so the classic page and
 * test/web.test.js keep working); the second block is new for the 3D page (GAME-DESIGN §9.2).
 *
 * Honesty rule (Juice Contract J1): these functions only ever turn SERVER numbers into display numbers or
 * clearly-labelled estimates (the caller prefixes estimates with "≈"). Nothing here invents a price.
 */

import { isNum } from './format.js';

// ------------------------------------------------------------------ moved from garden.js (unchanged)

/** Seed-shelf size: the top beans, one per coin. */
export const SHELF_SIZE = 5;

/** Water (stake) slider: dollars. */
export const WATER = Object.freeze({ min: 20, max: 1000, step: 10, def: 100 });

/** Planter / packet trim per archetype family (carried over from the 2D page into the 3D boxes). */
export const FAMILY_TINT = Object.freeze({ standard: '#9fb3c8', hyper: '#f0883e', degen: '#c084fc', swarm: '#39c5cf' });

/** Shelf query (SPEC §5): top 5 tradeable beans, one per coin; `tradeable` dropped when the field is burned. */
export function shelfQuery({ sort = '-total_return', archetype = '', sproutingOnly = true, halted = false } = {}) {
  const q = { distinct_coin: true, busted: false, trades_min: 1, limit: SHELF_SIZE, sort };
  if (!halted) q.tradeable = true;
  if (archetype) q.archetype = archetype;
  if (sproutingOnly) q.in_position = true;
  return q;
}

/** Weather from market coins: mean change_24h → sunny (> 1%) / mild (> −1%) / rainy (> −3%) / storm. */
export function weatherOf(coins) {
  const ch = (coins || []).map((c) => c && c.change_24h).filter(isNum).map(Number);
  if (!ch.length) return null;
  const mean = ch.reduce((a, b) => a + b, 0) / ch.length;
  const key = mean > 0.01 ? 'sunny' : mean > -0.01 ? 'mild' : mean > -0.03 ? 'rainy' : 'storm';
  return { key, mean };
}

/** Modal math: the bot mirrors stake/1000 of the bean ≈ position_size × leverage × equity × stake/1000 per entry. */
export function mirrorNote(bean, stake) {
  const share = stake / 1000;
  const notional = Number(bean?.position_size || 0) * Number(bean?.leverage || 1) * Number(bean?.equity || 1000) * share;
  return { pct: share * 100, notional };
}

/**
 * Most water the field has room for on `bean` (SPEC §2.6 caps, as bot_create checks them):
 * open notional + entry notional ≤ max_total_notional_usd, and water ≤ available cash.
 * → { maxStake (dollars, may be < WATER.min), cap } or null when the live status lacks the numbers.
 */
export function stakeRoom(bean, live, px) {
  const cap = Number(live?.caps?.max_total_notional_usd);
  const open = Number(live?.open_notional_usd);
  if (!Number.isFinite(cap) || !Number.isFinite(open)) return null;
  // notional per $1 of water: what the bot opens right away (positioned bean + a live price, see
  // openingNotional), else the per-entry size; the classic page passes no price and keeps the per-entry rule
  const perDollar = openingNotional(bean, 1, px);
  let maxStake = perDollar > 0 ? (cap - open) / perDollar : Infinity;
  const cash = Number(live?.available_usd);
  if (Number.isFinite(cash)) maxStake = Math.min(maxStake, cash);
  maxStake = Math.max(0, Math.floor(Math.min(maxStake, WATER.max) / WATER.step) * WATER.step);
  return { maxStake, cap };
}

/**
 * Isolated margin a bot would post per entry: notional / min(bean leverage, venue max). Above the water
 * when the bean has grown past 1000 / position_size — water scales the bean, it is not a loss cap.
 */
export function entryMargin(bean, stake) {
  const lev = Math.min(Number(bean?.leverage) || 1, Number(bean?.venue_max_leverage) || Infinity);
  return mirrorNote(bean, stake).notional / lev;
}

/** Server fill direction → i18n key ('Open Long' → 'dir.openLong'); unknown values → null. */
export function dirKey(dir) {
  const m = /^(Open|Close) (Long|Short)$/.exec(String(dir ?? ''));
  return m ? `dir.${m[1].toLowerCase()}${m[2]}` : null;
}

/** Archetype → family: hyper* / degen* / swarm* / standard. */
export function familyOf(archetype) {
  const a = String(archetype || '');
  if (a.startsWith('hyper')) return 'hyper';
  if (a.startsWith('degen')) return 'degen';
  if (a.startsWith('swarm')) return 'swarm';
  return 'standard';
}

// ------------------------------------------------------------------ new for the 3D page (GAME-DESIGN §9.2)

/** Bean direction −1/0/1 from a BeanRow (`side`, else the `in_position` text) — as the server mirrors it. */
export function beanSideOf(bean) {
  const s = Number(bean?.side);
  if (Number.isFinite(s) && s !== 0) return Math.sign(s);
  if (bean?.in_position === 'long') return 1;
  if (bean?.in_position === 'short') return -1;
  return 0;
}

/**
 * Notional a new bot opens RIGHT AWAY on `bean` with `stake` of water (the server's create rule): a positioned
 * bean is mirrored at once from its existing units, |units| × stake/1000 × px — those units were sized at the
 * bean's ENTRY equity, so mirrorNote() (the next entry, at today's equity) can be far off. Without a price or a
 * position this is the per-entry size, mirrorNote().notional.
 */
export function openingNotional(bean, stake, px) {
  const units = Math.abs(Number(bean?.units) || 0);
  const p = Number(px);
  if (beanSideOf(bean) !== 0 && units > 0 && Number.isFinite(p) && p > 0) return (units * (Number(stake) || 0) * p) / 1000;
  return mirrorNote(bean, stake).notional;
}

/**
 * Paper-fill costs used for ESTIMATES only (the server applies the real ones):
 * taker fee 4.5 bp, slippage 1.5 bp (spread 1 bp + impact 0.5 bp), liquidation at 95% of the margin.
 */
export const COSTS = Object.freeze({ fee: 0.00045, slip: 0.00015, liqFraction: 0.95 });

const DASH = '—';
const num = (x) => (isNum(x) ? Number(x) : NaN);
const szDec = (d) => (isNum(d) ? Math.max(0, Math.min(6, Math.floor(Number(d)))) : 0);

/**
 * Price decimals in the venue style: 6 significant figures, never more than (6 − szDecimals) decimals.
 *   min(6 − szDecimals, max(0, 6 − (floor(log10|px|) + 1)))
 */
export function pxDecimals(px, szDecimals) {
  const cap = 6 - szDec(szDecimals);
  const v = Math.abs(num(px));
  if (!Number.isFinite(v)) return Math.min(cap, 2);
  if (v === 0) return Math.min(cap, 2);
  const intDigits = Math.floor(Math.log10(v)) + 1;
  return Math.max(0, Math.min(cap, Math.max(0, 6 - intDigits)));
}

/** '$82,980.5' — en-US grouping with pxDecimals(); '—' when not finite. Prices are never signed. */
export function fmtPx(px, szDecimals) {
  const v = num(px);
  if (!Number.isFinite(v)) return DASH;
  const d = pxDecimals(v, szDecimals);
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Coin size with the venue's size decimals: |sz|.toFixed(szDecimals) ('0.00500'); '—' when not finite. */
export function fmtSz(sz, szDecimals) {
  const v = num(sz);
  if (!Number.isFinite(v)) return DASH;
  return Math.abs(v).toFixed(szDec(szDecimals));
}

/**
 * Everything the plant dialog shows before planting (GAME-DESIGN §6.5). All values are ≈ estimates.
 * `px` is the live price: with it, a positioned bean's quote is for the position the bot takes RIGHT AWAY
 * (openingNotional, basis 'now'); otherwise for one future entry (mirrorNote, basis 'entry').
 * → { notional, perEntry, basis, lev, margin, liqMovePct, fees, worst, exceedsWater, room }
 *   lev        = min(bean.leverage, venue_max_leverage)
 *   liqMovePct = 0.95 / lev (fraction: 0.095 = "9.5%")
 *   fees       = notional × (fee + slip) × 2 (open and close)
 *   worst      = margin (the whole isolated margin), which can exceed the water
 *   room       = stakeRoom(bean, live) (null when the live status lacks the caps)
 */
export function plantQuote(bean, stake, live, px) {
  const water = Number(stake) || 0;
  const perEntry = mirrorNote(bean, water).notional;
  const notional = openingNotional(bean, water, px);
  const basis = beanSideOf(bean) !== 0 && Math.abs(Number(bean?.units) || 0) > 0 && Number(px) > 0 ? 'now' : 'entry';
  const beanLev = Number(bean?.leverage) || 1;
  const venue = Number(bean?.venue_max_leverage);
  const lev = Math.max(1, Number.isFinite(venue) && venue > 0 ? Math.min(beanLev, venue) : beanLev);
  const margin = notional / lev;
  return {
    notional,
    perEntry,
    basis,
    lev,
    margin,
    liqMovePct: COSTS.liqFraction / lev,
    fees: notional * (COSTS.fee + COSTS.slip) * 2,
    worst: margin,
    exceedsWater: margin > water * 1.005,
    room: stakeRoom(bean, live, px),
  };
}

/**
 * ≈ outcome of closing `bot` now at `mark` (GAME-DESIGN §6.7):
 *   estTotal = realized + unrealized − |szi|·mark·(fee + slip)
 * `bot` should be the merged bot of the plot view (newest server marks). → { estTotal, fee, slip, notional, pct }
 * `pct` is estTotal as a fraction of the water (capital_usd), or null when the water is unknown.
 */
export function closeQuote(bot, mark) {
  const real = bot?.real || {};
  const szi = Math.abs(num(real.szi)) || 0;
  let px = num(mark);
  if (!Number.isFinite(px)) px = num(bot?.mark_px);
  if (!Number.isFinite(px)) px = num(real.entry_px);
  const notional = szi && Number.isFinite(px) ? szi * px : 0;
  const fee = notional * COSTS.fee;
  const slip = notional * COSTS.slip;
  const realized = num(bot?.realized_pnl) || 0;
  const unrealized = num(real.unrealized_pnl) || 0;
  const estTotal = realized + unrealized - fee - slip;
  const water = num(bot?.capital_usd);
  return { estTotal, fee, slip, notional, pct: water > 0 ? estTotal / water : null };
}

/** Market wind levels from the mean |1 h change| (volatility, never direction). */
export const WIND_LEVELS = Object.freeze([
  { key: 'calm', below: 0.003, factor: 0.6 },
  { key: 'breezy', below: 0.008, factor: 1.0 },
  { key: 'windy', below: 0.015, factor: 1.6 },
  { key: 'gale', below: Infinity, factor: 2.4 },
]);

/** Wind from market coins: mean |change_1h| → { key: calm|breezy|windy|gale, factor, mean } | null. */
export function windOf(coins) {
  const ch = (coins || []).map((c) => c && c.change_1h).filter(isNum).map((x) => Math.abs(Number(x)));
  if (!ch.length) return null;
  const mean = ch.reduce((a, b) => a + b, 0) / ch.length;
  const lvl = WIND_LEVELS.find((l) => mean < l.below) || WIND_LEVELS[WIND_LEVELS.length - 1];
  return { key: lvl.key, factor: lvl.factor, mean };
}

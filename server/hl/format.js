// server/hl/format.js — perp price and size wire strings (PLATFORM §6.5, Hyperliquid "tick and lot size").
//
// Rules: a price has ≤ 5 significant figures AND ≤ 6 − szDecimals decimals (integer prices are always allowed); a
// size is a whole number of lots (10^−szDecimals) and is FLOORED, never rounded up. Trailing zeros are removed,
// because the exchange re-serializes the action and a different string changes the signed hash (§6.4).

import { FLATTEN_SLIPPAGE_STEPS } from './constants.js';

/** "83130.000000" → "83130"; "0.084785" stays; "2.50" → "2.5"; integers are left alone. */
export function stripZeros(s) {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

function checkDecimals(d) {
  if (!Number.isInteger(d) || d < 0 || d > 8) throw new RangeError('szDecimals must be an integer in [0, 8]');
}

/**
 * Perp limit-price wire string: 5 significant figures, at most 6 − d decimals, no trailing zeros.
 * @param {number} px  > 0, finite
 * @param {number} d   testnet szDecimals of the coin
 */
export function fmtPxWire(px, d) {
  checkDecimals(d);
  if (typeof px !== 'number' || !Number.isFinite(px) || px <= 0) throw new RangeError('price must be a positive finite number');
  if (px >= 1e15) throw new RangeError('price out of range');
  const maxDec = Math.max(0, 6 - d);
  let x = Number(px.toPrecision(5)); // 5 significant figures
  x = Number(x.toFixed(maxDec)); // ≤ 6 − szDecimals decimals
  const out = stripZeros(x.toFixed(maxDec));
  if (!(Number(out) > 0)) throw new RangeError('price rounds to zero at this precision');
  return out;
}

/** Number of whole lots in |sz| (floored; the 1e-9 absorbs float noise such as 0.1 × 10^4 = 1000.0000000000001). */
function lotsOf(sz, d) {
  return Math.floor(Math.abs(sz) * 10 ** d + 1e-9);
}

/**
 * Size wire string: floor(|sz|) to whole lots, no trailing zeros. Throws below one lot (never sends "0").
 * @param {number} sz  > 0 (the sign is the order side, carried separately)
 * @param {number} d   testnet szDecimals
 */
export function fmtSzWire(sz, d) {
  checkDecimals(d);
  if (typeof sz !== 'number' || !Number.isFinite(sz) || sz === 0) throw new RangeError('size must be a non-zero finite number');
  const lots = lotsOf(sz, d);
  if (lots === 0) throw new RangeError('size below one lot');
  return stripZeros((lots / 10 ** d).toFixed(d));
}

/**
 * Floor a (signed) size toward zero to whole lots. Returns a number with the sign kept; 0 below one lot.
 * Used for targets (§6.11): `target_sz = sign × floorSz(|units| × scale × k, d)`.
 */
export function floorSz(sz, d) {
  checkDecimals(d);
  if (typeof sz !== 'number' || !Number.isFinite(sz)) throw new RangeError('size must be finite');
  const lots = lotsOf(sz, d);
  if (lots === 0) return 0;
  const v = Number((lots / 10 ** d).toFixed(d));
  return sz < 0 ? -v : v;
}

/** Significant digits of a canonical decimal string (leading zeros do not count). */
function sigFigs(str) {
  const digits = str.replace('.', '').replace(/^0+/, '');
  return digits.length;
}

/**
 * True when `str` is a valid perp price wire string for szDecimals `d`: canonical decimal (no sign, exponent, leading
 * or trailing zeros), > 0, ≤ 6 − d decimals, and ≤ 5 significant figures unless it is an integer.
 */
export function isWirePx(str, d) {
  if (typeof str !== 'string' || !/^(0|[1-9]\d*)(\.\d*[1-9])?$/.test(str)) return false;
  if (!Number.isInteger(d) || d < 0 || d > 8) return false;
  if (!(Number(str) > 0)) return false;
  const dot = str.indexOf('.');
  if (dot < 0) return true; // integer prices are always allowed
  const decimals = str.length - dot - 1;
  if (decimals > Math.max(0, 6 - d)) return false;
  return sigFigs(str) <= 5;
}

/** True when `str` is a valid size wire string for szDecimals `d` (canonical, > 0, ≤ d decimals). */
export function isWireSz(str, d) {
  if (typeof str !== 'string' || !/^(0|[1-9]\d*)(\.\d*[1-9])?$/.test(str)) return false;
  if (!Number.isInteger(d) || d < 0 || d > 8) return false;
  if (!(Number(str) > 0)) return false;
  const dot = str.indexOf('.');
  return dot < 0 || str.length - dot - 1 <= d;
}

/**
 * IOC limit price for a testnet mid: buys above the mid, sells below (§6.5).
 * @param {number} mid       testnet mid
 * @param {boolean} isBuy
 * @param {number} slippage  e.g. IOC_SLIPPAGE (0.01) or a FLATTEN_SLIPPAGE_STEPS entry
 * @param {number} d         szDecimals
 */
export function iocPx(mid, isBuy, slippage, d) {
  if (!(slippage >= 0 && slippage < 1)) throw new RangeError('slippage must be in [0, 1)');
  return fmtPxWire(mid * (1 + (isBuy ? 1 : -1) * slippage), d);
}

/** Flatten slippage for retry `attempt` (0-based): 1% → 2.5% → 5%, then 5% forever (§6.5, §6.11). */
export function flattenSlippage(attempt) {
  const i = Math.max(0, Math.min(FLATTEN_SLIPPAGE_STEPS.length - 1, Math.floor(Number(attempt) || 0)));
  return FLATTEN_SLIPPAGE_STEPS[i];
}

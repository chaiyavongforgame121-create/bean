/**
 * format.js — tiny, pure formatting helpers shared by the garden page.
 *
 * Every function tolerates null / undefined / NaN and returns "—" for
 * "no value" so a half-loaded panel never prints "NaN" or "undefined".
 * Numbers are always rendered with the en-US locale (digits and separators
 * stay the same whichever UI language is active).
 */

const DASH = '—';
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Is `x` a usable finite number? (strings like "1.5" count, null/""/NaN do not) */
export function isNum(x) {
  return x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));
}

/** Clamp `x` into [lo, hi]. */
export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/** HTML-escape any value for safe interpolation into markup (text or a quoted attribute). */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Plain number with thousands separators and at most `d` decimals. */
export function fmt(n, d = 0) {
  if (!isNum(n)) return DASH;
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
}

/** Fraction → signed percentage: 0.0123 → "+1.23%". */
export function pct(x, d = 2) {
  if (!isNum(x)) return DASH;
  const v = Number(x) * 100;
  // avoid "-0.00%" for tiny negatives that round to zero
  const s = v.toFixed(d);
  const zero = Number(s) === 0;
  return (v >= 0 || zero ? '+' : '-') + Math.abs(Number(s)).toFixed(d) + '%';
}

/**
 * Dollars: usd(1234.5) → "$1,234.50", usd(-3, 0) → "-$3".
 * With `sign = true` positive values get a "+" (for PnL figures).
 */
export function usd(x, d = 2, sign = false) {
  if (!isNum(x)) return DASH;
  const v = Number(x);
  const body = '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  // a value that rounds to zero prints as "$0.00" (never "-$0.00" / "+$0.00")
  if (Number(Math.abs(v).toFixed(d)) === 0) return body;
  return (v < 0 ? '-' : sign ? '+' : '') + body;
}

/** CSS class for a signed value: "up" | "down" | "". */
export function signClass(x) {
  if (!isNum(x)) return '';
  const v = Number(x);
  return v > 0 ? 'up' : v < 0 ? 'down' : '';
}

/** A price with sensible precision for anything from BTC to PUMP. */
export function price(x) {
  if (!isNum(x)) return DASH;
  const v = Math.abs(Number(x));
  if (v >= 1000) return fmt(x, 1);
  if (v >= 1) return fmt(x, 3);
  if (v === 0) return '0';
  // < 1: keep 4 significant digits (0.006123 → 0.006123, 0.4512 → 0.4512)
  return Number(Number(x).toPrecision(4)).toString();
}

/** Coin size (units) — up to 6 decimals, no trailing zeros. */
export function size(x) {
  return fmt(x, 6);
}

/**
 * Compact "time since": ago(ms) → "12s" | "4m" | "3h" | "2d".
 * `units` lets the i18n layer swap the suffixes; `now` makes it testable.
 */
export function ago(ms, now = Date.now(), units = { s: 's', m: 'm', h: 'h', d: 'd' }) {
  if (!isNum(ms) || Number(ms) <= 0) return DASH;
  const s = Math.max(0, (now - Number(ms)) / 1000);
  if (s < 60) return Math.round(s) + units.s;
  if (s < 3600) return Math.round(s / 60) + units.m;
  if (s < 86400) return Math.round(s / 3600) + units.h;
  return Math.round(s / 86400) + units.d;
}

/** Local wall-clock time "14:03:22" for diary lines and error stamps. */
export function clock(ms = Date.now()) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

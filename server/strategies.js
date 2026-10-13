// server/strategies.js — signal functions (SPEC §2.4). Each returns -1 | 0 | +1 on a bar close.
//
// ── The `series` object ─────────────────────────────────────────────────────────────────────
// Population keeps ONE series per coin and updates it once per bar with pushClose(series, close).
// Because every lookback L is in 2..60, all window statistics a strategy can ask for are
// precomputed per coin per bar for every L in one O(60) pass. A bean's signal is then an O(1)
// table lookup, independent of L — this is what keeps 3000 beans × 2880 warmup bars fast
// (it plays the role of the per-coin prefix sums the spec suggests, without their float drift).
//
//   series = {
//     n        number of closes pushed so far
//     ready    true once n ≥ WINDOW (61): every L in 2..60 and σ have a full window
//     close    c[t], the latest close
//     sigma    σ_1bar: sample stdev of the last 60 one-bar log returns
//     win      Float64Array(WINDOW) ring of the last 61 closes;  head = next write slot
//     back     Float64Array(WINDOW) scratch: back[j] = c[t−j] (newest first)
//     — per-lookback tables, index L = 1..60 (index 0 unused) —
//     mom[L]   c[t] / c[t−L] − 1
//     sma[L]   mean of c[t−L+1..t]
//     mrz[L]   (c[t] − SMA_L) / SD_L   (population SD; 0 when SD is ~0)
//     hi[L]    max(c[t−L..t−1])        lo[L]  min(c[t−L..t−1])
//     rsi[L]   simple (Cutler) RSI over the last L one-bar changes, 0..100 (50 when no movement)
//   }
// Signals are 0 until `ready`.

export const STRATEGY_NAMES = Object.freeze(['momentum', 'mean_reversion', 'breakout', 'ma_cross', 'rsi_reversal']);
export const MAX_LOOKBACK = 60;
export const SIGMA_BARS = 60;
/** Closes needed before any signal fires (60 log returns for σ, and L+1 closes for L = 60). */
export const WINDOW = MAX_LOOKBACK + 1;

const STRATEGY_INDEX = new Map(STRATEGY_NAMES.map((n, i) => [n, i]));
const SQRT = Float64Array.from({ length: WINDOW }, (_, L) => Math.sqrt(L));
const FAST = Uint8Array.from({ length: WINDOW }, (_, L) => Math.max(1, Math.ceil(L / 3)));

/** Index of a strategy name in STRATEGY_NAMES, or -1. */
export function strategyIndex(name) {
  const i = STRATEGY_INDEX.get(name);
  return i === undefined ? -1 : i;
}

/** A fresh, empty per-coin series. */
export function createSeries() {
  return {
    n: 0,
    ready: false,
    close: NaN,
    sigma: 0,
    head: 0,
    win: new Float64Array(WINDOW),
    back: new Float64Array(WINDOW),
    mom: new Float64Array(WINDOW),
    sma: new Float64Array(WINDOW),
    mrz: new Float64Array(WINDOW),
    hi: new Float64Array(WINDOW),
    lo: new Float64Array(WINDOW),
    rsi: new Float64Array(WINDOW),
  };
}

/** Append one bar close and refresh the tables. */
export function pushClose(s, close) {
  s.win[s.head] = close;
  s.head = (s.head + 1) % WINDOW;
  s.n++;
  s.close = close;
  if (s.n >= WINDOW) {
    s.ready = true;
    recompute(s);
  }
}

/** Rebuild every table from the ring (also used after restore). */
export function recompute(s) {
  const w = s.back;
  for (let j = 0; j < WINDOW; j++) w[j] = s.win[(s.head - 1 - j + 2 * WINDOW) % WINDOW];
  const c0 = w[0];
  s.close = c0;

  // σ_1bar over the last 60 one-bar log returns (sample stdev)
  let sum = 0, sq = 0;
  for (let j = 0; j < SIGMA_BARS; j++) {
    const r = Math.log(w[j] / w[j + 1]);
    sum += r; sq += r * r;
  }
  const mean = sum / SIGMA_BARS;
  const v = (sq - SIGMA_BARS * mean * mean) / (SIGMA_BARS - 1);
  s.sigma = v > 0 ? Math.sqrt(v) : 0;

  // Per-lookback tables in one pass. Deviations are taken relative to c[t] (values near 0),
  // so the variance never suffers from cancellation whatever the coin's price level.
  let s1 = 0, s2 = 0, gain = 0, loss = 0, hi = -Infinity, lo = Infinity;
  for (let L = 1; L < WINDOW; L++) {
    const d = w[L - 1] / c0 - 1; // newest L closes: c[t-L+1..t]
    s1 += d; s2 += d * d;
    const m = s1 / L;
    const varD = s2 / L - m * m;
    s.sma[L] = c0 * (1 + m);
    s.mrz[L] = varD > 1e-18 ? -m / Math.sqrt(varD) : 0;

    const prev = w[L];           // c[t-L]
    if (prev > hi) hi = prev;
    if (prev < lo) lo = prev;
    s.hi[L] = hi;
    s.lo[L] = lo;
    s.mom[L] = c0 / prev - 1;

    const delta = w[L - 1] - prev; // the L-th most recent one-bar change
    if (delta > 0) gain += delta; else loss -= delta;
    s.rsi[L] = gain + loss > 0 ? (100 * gain) / (gain + loss) : 50;
  }
}

/**
 * Fast path used by Population: strategy by index.
 * @param {number} si index into STRATEGY_NAMES
 * @param {object} s series (see header)
 * @param {number} L lookback 2..60
 * @param {number} k entry_threshold
 * @returns {-1|0|1}
 */
export function signalIdx(si, s, L, k) {
  if (!s.ready) return 0;
  const sigma = s.sigma;
  switch (si) {
    case 0: { // momentum: z = (c[t]/c[t−L] − 1) / (σ·√L)
      if (!(sigma > 0)) return 0;
      const z = s.mom[L] / (sigma * SQRT[L]);
      return z > k ? 1 : z < -k ? -1 : 0;
    }
    case 1: { // mean_reversion: z = (c[t] − SMA_L) / SD_L ; fade it
      const z = s.mrz[L];
      return z < -k ? 1 : z > k ? -1 : 0;
    }
    case 2: { // breakout beyond the prior L-bar range by k·σ
      const c = s.close;
      if (c > s.hi[L] * (1 + k * sigma)) return 1;
      if (c < s.lo[L] * (1 - k * sigma)) return -1;
      return 0;
    }
    case 3: { // ma_cross: SMA_⌈L/3⌉ vs SMA_L
      const d = s.sma[FAST[L]] / s.sma[L] - 1;
      const band = k * sigma;
      return d > band ? 1 : d < -band ? -1 : 0;
    }
    case 4: { // rsi_reversal: buy oversold, sell overbought (thresholds clamped to 5..95)
      const r = s.rsi[L];
      const low = Math.max(5, 50 - 10 * k);
      const high = Math.min(95, 50 + 10 * k);
      return r < low ? 1 : r > high ? -1 : 0;
    }
    default:
      return 0;
  }
}

/**
 * Public form: signal by strategy name.
 * @param {string} name one of STRATEGY_NAMES
 * @param {object} series per-coin series (see header)
 * @param {{lookback:number, entry_threshold:number}} params
 * @returns {-1|0|1}
 */
export function signal(name, series, params) {
  const si = strategyIndex(name);
  if (si < 0) throw new Error(`unknown strategy '${name}'`);
  const L = Math.min(MAX_LOOKBACK, Math.max(2, params.lookback | 0));
  return signalIdx(si, series, L, Number(params.entry_threshold));
}

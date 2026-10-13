// server/market.js — the venue listing (COINS) and the MarketFeed that produces one 1-minute bar
// per coin per tick.
//
// Two sources (GAME-DESIGN §10):
//
//   'sim'          synthetic, fully deterministic from `seed` (used by every engine/api test and by
//                  `npm run sim` / `npm run dev`). Bars come from the GBM model below, one per tick.
//
//   'hyperliquid'  REAL prices, READ-ONLY (POST https://api.hyperliquid.xyz/info through
//                  server/hyperliquid.js: no keys, no signing, no exchange endpoint, ever).
//                  • init(): coin metadata from `metaAndAssetCtxs` (szDecimals, maxLeverage, day stats),
//                    live mids from `allMids`, then `warmupBars` 1-minute candles per coin
//                    (`candleSnapshot`) ending at the last CLOSED minute, so bar index ↔ wall-clock minute.
//                  • Bars are produced on real minutes only, from STAGED frames (`stage()`): the engine's
//                    scheduler fetches the just-closed candle (`fetchClosed`) or a missed range
//                    (`fetchRange`) and stages it before calling tick(). Per coin, a bar is the HL candle,
//                    else a bar built from that minute's ~5 s mid samples, else a FLAT bar at the previous
//                    close with the coin marked stale. A synthetic price is never invented in real mode.
//                  • Live mids every ~5 s (`pollMids` → `setLiveMids`) give `livePx()` (marks, out-of-tick
//                    fills) and the per-minute sample buffer.
//
// Synthetic model (SPEC §2.2), per coin, on 1-minute bars:
//   σ_min = vol / √525600
//   log-return per bar = μ_regime + σ_min·(ρ·z_market + √(1−ρ²)·z_coin)  (+ rare jump)
//   • μ_regime re-drawn with probability 1/720 per bar (mean duration ~720 bars), μ ~ N(0, 0.03·σ_min)
//   • jumps with p = 0.0005 per bar, size N(0, 8·σ_min)
//   • common market factor: BTC loads fully on z_market, every other coin with ρ = 0.4
//     (so corr(alt, BTC) ≈ 0.4)
//   • each bar is simulated as 4 sub-steps; h/l are the path extremes, o = previous close.

import { makeRng, deriveSeed, typedToB64, b64ToTyped } from './rng.js';
import { HyperliquidClient, BOOT_BUDGET } from './hyperliquid.js';

export const BAR_MS = 60_000;
export const BARS_PER_YEAR = 525_600;
/** Bars of close history kept per coin (14 days). */
export const HISTORY_KEEP = 20_160;
const HISTORY_CAP = HISTORY_KEEP + 1_440; // slack so compaction (a copyWithin) happens once a day

const SUBSTEPS = 4;
const REGIME_MEAN_BARS = 720;
const REGIME_DRIFT = 0.03;   // μ ~ N(0, 0.03·σ_min)
const JUMP_P = 0.0005;
const JUMP_SIZE = 8;         // jump ~ N(0, 8·σ_min)
const MARKET_RHO = 0.4;
const DAY_BARS = 1_440;
const HOUR_BARS = 60;

// ---- real-feed constants (GAME-DESIGN §10.3–§10.6) ------------------------------------------------

/** livePx() uses the latest mid while it is at most this old; else the last bar close. */
export const LIVE_MAX_AGE_MS = 15_000;
/** A coin whose last mid is older than this (or whose last bar was flat) is STALE: its bots freeze. */
export const STALE_AFTER_MS = 60_000;
/** Warm-up fails (→ fallback to sim) when fewer coins than this return candles. */
export const MIN_REAL_COINS = 8;
/** fetchClosed(): coins whose closed candle is missing are retried at +5 s and +10 s… */
export const CLOSE_RETRY_MS = Object.freeze([5_000, 10_000]);
/** …up to this deadline after the first attempt. */
export const CLOSE_DEADLINE_MS = 15_000;
/** Concurrent candle requests (politeness; the weight ledger is what actually limits us). */
export const HL_CONCURRENCY = 4;
/** Minutes of 5 s mid samples kept (mid-built bars need the minute that just closed). */
const SAMPLE_MINUTES = 10;
/** Candle catch-up/warm-up requests may queue this long for the weight budget. */
const RANGE_DEADLINE_MS = 75_000;
/** A range is "covered" when a coin's first candle is at most this many bars after the range start. */
const COVER_SLACK_BARS = 5;

// coin, start px, annualised vol, max leverage, size decimals (SPEC §2.2)
const LISTING = [
  ['BTC', 82000, 0.55, 40, 5],
  ['ETH', 3200, 0.70, 25, 4],
  ['SOL', 180, 0.95, 20, 2],
  ['HYPE', 42, 1.20, 10, 2],
  ['XRP', 2.4, 0.90, 20, 0],
  ['DOGE', 0.18, 1.10, 10, 0],
  ['AVAX', 28, 1.00, 10, 2],
  ['LINK', 18, 0.95, 10, 1],
  ['SUI', 3.6, 1.20, 10, 1],
  ['NEAR', 3.1, 1.10, 10, 1],
  ['ARB', 0.45, 1.10, 10, 1],
  ['TIA', 4.2, 1.30, 5, 1],
  ['ZEC', 220, 1.40, 10, 2],
  ['WIF', 1.1, 1.60, 5, 0],
  ['PUMP', 0.006, 1.80, 5, 0],
  ['VVV', 21, 1.70, 3, 2],
];

/** The simulated venue listing: [{coin, px, vol, max_leverage, sz_decimals}] (frozen). */
export const COINS = Object.freeze(LISTING.map(([coin, px, vol, max_leverage, sz_decimals]) =>
  Object.freeze({ coin, px, vol, max_leverage, sz_decimals })));

/** Open time of the last fully closed 1-minute bar at wall time `ms`. */
export function lastClosedMinute(ms) {
  return Math.floor(ms / BAR_MS) * BAR_MS - BAR_MS;
}

/** Run `fn(item)` over `items` with at most `limit` in flight. `stop()` → true skips what is left. */
async function mapLimit(items, limit, fn, stop = () => false) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      if (stop()) continue;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** A network-level failure (timeout, refused, DNS): no HTTP status and not a self-imposed skip. */
const isNetworkError = (err) => err && !err.skipped && (err.status === null || err.status === undefined);

const finiteOrNull = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

export class MarketFeed {
  /**
   * @param {object} opts
   * @param {number} [opts.seed=42]
   * @param {'sim'|'hyperliquid'} [opts.source='sim']
   * @param {Array} [opts.coins=COINS] listing (sim: simulated; hyperliquid: the coins we follow on HL)
   * @param {Function} [opts.log=console.log]
   * @param {number} [opts.startMs] market time of bar 0 (sim default: current minute; hyperliquid: set by
   *   init() so that the warm-up ends at the last closed minute)
   * @param {number} [opts.warmupBars=2880] candles to preload in hyperliquid mode
   * @param {HyperliquidClient} [opts.hl] shared read-only client (default: one built from fetch/now/sleep)
   * @param {typeof fetch} [opts.fetch] injectable fetch for the default client (tests)
   * @param {() => number} [opts.now=Date.now] wall clock (tests inject one)
   * @param {(ms:number) => Promise<void>} [opts.sleep] used between fetchClosed retries
   */
  constructor({ seed = 42, source = 'sim', coins = COINS, log = console.log, startMs, warmupBars = 2880,
    hl = null, fetch: fetchImpl, now = Date.now, sleep } = {}) {
    if (source !== 'sim' && source !== 'hyperliquid') throw new Error(`market: unknown source '${source}'`);
    if (!Array.isArray(coins) || coins.length === 0) throw new Error('market: coins must be a non-empty array');
    this._seed = seed >>> 0;
    this._source = source;
    this._coins = coins;
    this._log = typeof log === 'function' ? log : () => {};
    this._now = typeof now === 'function' ? now : Date.now;
    this._startMs = Number.isFinite(startMs) ? startMs : Math.floor(this._now() / BAR_MS) * BAR_MS;
    this._warmupBars = Math.max(0, warmupBars | 0);

    const K = coins.length;
    this._index = new Map(coins.map((c, i) => [c.coin, i]));
    this._names = coins.map((c) => c.coin);
    const btc = this._index.get('BTC');
    this._anchor = btc === undefined ? 0 : btc; // the coin that *is* the market factor

    this._rng = makeRng(deriveSeed(this._seed, 'market'));
    this._sig = Float64Array.from(coins, (c) => c.vol / Math.sqrt(BARS_PER_YEAR));
    this._px = Float64Array.from(coins, (c) => (source === 'sim' ? c.px : 0)); // real: no price until HL gives one
    this._mu = new Float64Array(K);
    for (let i = 0; i < K; i++) this._mu[i] = this._rng.normal() * REGIME_DRIFT * this._sig[i];
    this._last = new Float64Array(K * 4); // o,h,l,c of the last bar per coin
    for (let i = 0; i < K; i++) this._last.fill(this._px[i], i * 4, i * 4 + 4);
    this._hist = coins.map(() => new Float64Array(HISTORY_CAP));
    this._len = 0;      // closes stored per coin (same for every coin)
    this._barIdx = -1;
    this._zm = new Float64Array(SUBSTEPS); // scratch: market-factor shocks of the current bar
    this._stale = new Uint8Array(K);       // 1 = the coin's last bar was flat (no candle, no mids)
    this._lastBarWallMs = null;            // wall time the last bar was produced

    // ---- hyperliquid state (unused in sim mode) ----
    this._hl = source === 'hyperliquid'
      ? (hl ?? new HyperliquidClient({ fetch: fetchImpl, now: this._now, sleep, log: this._log }))
      : null;
    this._sleep = typeof sleep === 'function' ? sleep : (ms) => new Promise((r) => { const t = setTimeout(r, Math.max(0, ms)); t.unref?.(); });
    // venue info per coin; real mode replaces it from metaAndAssetCtxs (persisted, so a restart without HL keeps it)
    this._info = coins.map((c) => ({ listed: source === 'sim', max_leverage: c.max_leverage, sz_decimals: c.sz_decimals }));
    this._ctx = coins.map(() => null);     // HL day stats per coin (prev_day_px, funding_1h, …)
    this._ctxMs = 0;
    this._mid = new Float64Array(K);       // latest live mid per coin (0 = none)
    this._midMs = new Float64Array(K);     // when that mid was received
    this._midsMs = 0;                      // last successful allMids
    this._samples = new Map();             // minute open ms → { h, l, c: Float64Array(K), n: Uint16Array(K) }
    this._segments = [];                   // staged bars: [{ openMs, len, pos, ohlc: (Float64Array|null)[], src: string[] }]
    this._src = coins.map(() => (source === 'sim' ? 'sim' : null)); // source of each coin's last bar
    this._barSources = { candle: 0, mids: 0, flat: 0 };
    this._error = null;
    this._errLogged = false;
  }

  // -------------------------------------------------------------------------------------------
  // accessors

  get source() { return this._source; }
  get real() { return this._source === 'hyperliquid'; }
  get barIdx() { return this._barIdx; }
  /** Market time (bar open time) of the last produced bar. */
  get timeMs() { return this._startMs + this._barIdx * BAR_MS; }
  get startMs() { return this._startMs; }
  /** The read-only Hyperliquid client (null in sim mode). */
  get hl() { return this._hl; }
  /** Bars staged and not yet consumed by nextSync(). */
  get staged() { return this._segments.reduce((n, s) => n + (s.len - s.pos), 0); }
  /** Time of the last successful allMids (0 = never). */
  get midsMs() { return this._midsMs; }
  /** Per-coin sources of the last bar: { candle, mids, flat } (sim: all zero). */
  get barSources() { return { ...this._barSources }; }

  /**
   * The venue listing [{coin, px, vol, max_leverage, sz_decimals}]. Sim: the static table. Hyperliquid: limits
   * from HL `universe` and `px` = the last real close (null before the first bar).
   */
  get coins() {
    if (!this.real) return this._coins;
    return this._coins.map((c, i) => ({
      coin: c.coin,
      px: this._px[i] > 0 ? this._px[i] : null,
      vol: c.vol,
      max_leverage: this._info[i].max_leverage,
      sz_decimals: this._info[i].sz_decimals,
    }));
  }

  /** Closes oldest→newest (a copy; up to HISTORY_KEEP+ bars). Empty for unlisted coins. */
  closes(coin) {
    const i = this._index.get(coin);
    if (i === undefined) return new Float64Array(0);
    return this._hist[i].slice(0, this._len);
  }

  /** Last BAR close (or start price before the first bar); null if unknown. Tick reconciliation uses it. */
  mid(coin) {
    const i = this._index.get(coin);
    if (i === undefined) return null;
    return this._px[i] > 0 ? this._px[i] : null;
  }

  /**
   * The price to fill/mark at OUTSIDE a tick: the latest live mid while it is ≤ 15 s old, else the last bar
   * close. Sim: the last close.
   */
  livePx(coin) {
    const i = this._index.get(coin);
    if (i === undefined) return null;
    if (this.real && this._mid[i] > 0 && this._now() - this._midMs[i] <= LIVE_MAX_AGE_MS) return this._mid[i];
    return this._px[i] > 0 ? this._px[i] : null;
  }

  /**
   * What `livePx` returns plus the time that price is from: `{ px, ms, live }`. `live` is true when the price
   * is a fresh mid (≤ 15 s); otherwise it is the last bar close and `ms` is that bar's close time, so marks and
   * fills never present an old price as fresh. Sim: the last close, stamped now (synthetic prices are current).
   */
  liveQuote(coin) {
    const i = this._index.get(coin);
    if (i === undefined) return { px: null, ms: null, live: false };
    const now = this._now();
    if (!this.real) return { px: this._px[i] > 0 ? this._px[i] : null, ms: now, live: true };
    if (this._mid[i] > 0 && now - this._midMs[i] <= LIVE_MAX_AGE_MS) return { px: this._mid[i], ms: this._midMs[i], live: true };
    const closeMs = this._barIdx >= 0 ? this.timeMs + BAR_MS : null;
    return { px: this._px[i] > 0 ? this._px[i] : null, ms: closeMs, live: false };
  }

  /** True when `livePx(coin)` is a fresh mid (real), i.e. a fill now would be at a live price. Sim: always. */
  hasLivePx(coin) {
    return this.liveQuote(coin).live && this.livePx(coin) !== null;
  }

  /** The latest live mid and when it arrived (any age), else the last close at bar-close time. */
  quote(coin) {
    const i = this._index.get(coin);
    if (i === undefined) return { px: null, ms: null };
    if (this.real && this._mid[i] > 0) return { px: this._mid[i], ms: this._midMs[i] };
    const closeMs = this._barIdx >= 0 ? (this.real ? this.timeMs + BAR_MS : this._lastBarWallMs) : null;
    return { px: this._px[i] > 0 ? this._px[i] : null, ms: closeMs };
  }

  /** Timestamp for an out-of-tick fill: wall clock (real) or market time (sim, as before). */
  clockMs() {
    return this.real ? this._now() : this.timeMs;
  }

  /** Timestamp for a fill made inside a tick (or a replayed bar): the bar CLOSE (real) or market time (sim). */
  tickTimeMs() {
    return this.real ? this.timeMs + BAR_MS : this.timeMs;
  }

  /** close / close 1440 bars ago − 1 (vs the first kept bar when younger); null if < 2 bars or unknown. */
  change24h(coin) {
    const i = this._index.get(coin);
    if (i === undefined) return null;
    if (this.real) {
      const prev = this._ctx[i]?.prev_day_px;
      const q = this.quote(coin).px;
      if (prev > 0 && q > 0) return q / prev - 1; // the Hyperliquid definition
    }
    return this._barChange(i, DAY_BARS);
  }

  /** close / close 60 bars ago − 1 (vs the first kept bar when younger); null if < 2 bars. */
  change1h(coin) {
    const i = this._index.get(coin);
    return i === undefined ? null : this._barChange(i, HOUR_BARS);
  }

  _barChange(i, back) {
    if (this._len < 2) return null;
    const h = this._hist[i];
    const j = this._len - 1 - back;
    const base = h[j >= 0 ? j : 0];
    const last = h[this._len - 1];
    return base > 0 && last > 0 ? last / base - 1 : null;
  }

  /** { coin, index, max_leverage, sz_decimals } or null when the venue does not list the coin. */
  coinInfo(coin) {
    const i = this._index.get(coin);
    if (i === undefined) return null;
    const info = this._info[i];
    if (!info.listed && this.real) return null;
    return { coin, index: i, max_leverage: info.max_leverage, sz_decimals: info.sz_decimals };
  }

  /** True when the coin's price is not live: its last bar was flat, or (real) its last mid is > 60 s old. */
  isStale(coin) {
    const i = this._index.get(coin);
    return i === undefined ? true : this._isStale(i);
  }

  _isStale(i) {
    if (!this.real) return false; // synthetic prices are always current
    if (this._stale[i] === 1) return true;
    return !(this._mid[i] > 0 && this._now() - this._midMs[i] <= STALE_AFTER_MS);
  }

  /**
   * Staleness of the coin's LAST BAR only (no wall-clock mid age): true when that bar was flat (no candle, no
   * mids). Inside a tick — and above all inside a catch-up replay, where every mid is minutes old by the wall
   * clock — this is the question that matters: bots mirror and liquidate at a bar built from real data
   * (GAME-DESIGN §10.6 "bots mirror and liquidate per bar"). Sim: never stale.
   */
  isBarStale(coin) {
    const i = this._index.get(coin);
    if (i === undefined) return true;
    if (!this.real) return false;
    return this._stale[i] === 1 || !(this._px[i] > 0);
  }

  /** Names of the stale coins (sim: none). */
  staleCoins() {
    const out = [];
    for (let i = 0; i < this._names.length; i++) if (this._isStale(i)) out.push(this._names[i]);
    return out;
  }

  /** `market` op rows (GAME-DESIGN §10.5); the engine adds per-coin bean counts. */
  snapshot() {
    return this._coins.map((c, i) => {
      const q = this.quote(c.coin);
      const ctx = this.real ? this._ctx[i] : null;
      const close = this._px[i] > 0 ? this._px[i] : null;
      return {
        coin: c.coin,
        index: i,
        mid: q.px,
        change_24h: this.change24h(c.coin),
        bars: this._barIdx + 1,
        stale: this._isStale(i),
        max_leverage: this._info[i].max_leverage,
        sz_decimals: this._info[i].sz_decimals,
        px: q.px,
        px_ms: q.ms,
        close,
        change_1h: this.change1h(c.coin),
        prev_day_px: ctx?.prev_day_px ?? null,
        funding_1h: ctx?.funding_1h ?? null,
        mark_px: ctx?.mark_px ?? null,
        oracle_px: ctx?.oracle_px ?? null,
        open_interest: ctx?.open_interest ?? null,
        day_ntl_vlm: ctx?.day_ntl_vlm ?? null,
        source: this._source,
      };
    });
  }

  /** { source, coins, ok, error, stale } — `stale` is a count (SPEC); the engine adds the §10.5 fields. */
  status() {
    let stale = 0;
    for (let i = 0; i < this._names.length; i++) stale += this._isStale(i) ? 1 : 0;
    if (!this.real) return { source: this._source, coins: this._coins.length, ok: true, error: null, stale };
    const s = this._hl.stats;
    const ok = s.last_ok_ms > 0 && this._now() - s.last_ok_ms <= STALE_AFTER_MS;
    const error = s.last_error_ms > s.last_ok_ms ? s.last_error : null;
    return { source: this._source, coins: this._coins.length, ok, error, stale };
  }

  // -------------------------------------------------------------------------------------------
  // bar production

  /**
   * Prepare the feed. Sim: nothing to do. Hyperliquid: coin metadata + live mids, then (fresh start only) the
   * warm-up candles, staged as one segment ending at the last closed minute. Never throws.
   * @returns {Promise<{ok:boolean, reason?:string, coins?:number}>} ok:false → the caller falls back / holds
   */
  async init() {
    if (!this.real) return { ok: true };
    try {
      this._applyMeta(await this._hl.metaAndAssetCtxs());
    } catch (err) {
      this._noteError(err);
      return { ok: false, reason: `metaAndAssetCtxs: ${err.message}` };
    }
    try {
      this.setLiveMids(await this._hl.allMids(), this._now());
    } catch (err) {
      this._noteError(err);
      return { ok: false, reason: `allMids: ${err.message}` };
    }
    if (this._barIdx >= 0) return { ok: true, coins: this._listedCount() }; // restored: the engine fills the gap

    // Fresh warm-up: bars [startMs, lastClosed], so bar index ↔ wall-clock minute exactly.
    const len = this._warmupBars;
    const lastClosed = lastClosedMinute(this._now());
    this._startMs = lastClosed - (len - 1) * BAR_MS;
    if (len === 0) return { ok: true, coins: this._listedCount() };
    const seg = await this._fetchSegment(this._startMs, len, { prevClose: false });
    if (!seg) return { ok: false, reason: 'candleSnapshot: Hyperliquid unreachable' };
    if (seg.withCandles < MIN_REAL_COINS) {
      return { ok: false, reason: `only ${seg.withCandles} coins returned candles (need ${MIN_REAL_COINS})` };
    }
    // A coin without candles but with a live mid warms up flat at that real price (stale until it trades).
    for (let i = 0; i < this._names.length; i++) {
      if (seg.ohlc[i] || !(this._mid[i] > 0)) continue;
      seg.ohlc[i] = new Float64Array(len * 4).fill(this._mid[i]);
      seg.src[i] = 'flat';
    }
    this._segments = [{ ...seg, pos: 0 }];
    return { ok: true, coins: seg.withCandles };
  }

  /** Advance ONE bar for every coin (async form kept for SPEC compatibility). */
  async next() {
    return this.nextSync();
  }

  /**
   * Advance ONE bar for every coin, synchronously. Sim: one synthetic step. Hyperliquid: consumes the next
   * staged bar (throws a 409-status error when nothing is staged — real bars only exist once the minute closed).
   * @returns {{barIdx:number, timeMs:number, bars:Object<string,{o:number,h:number,l:number,c:number}>}}
   */
  nextSync() {
    const b = this._barIdx + 1;
    if (this.real) this._applyStaged(b);
    else this._simStep();
    this._barIdx = b;
    this._lastBarWallMs = this._now();
    this._pushHistory();
    const bars = {};
    const L = this._last;
    for (let i = 0; i < this._names.length; i++) {
      const k = i * 4;
      if (L[k + 3] > 0) bars[this._names[i]] = { o: L[k], h: L[k + 1], l: L[k + 2], c: L[k + 3] };
    }
    return { barIdx: b, timeMs: this._startMs + b * BAR_MS, bars };
  }

  /** One synthetic bar for every coin, written into this._last and this._px. */
  _simStep() {
    const rng = this._rng;
    const zm = this._zm;
    for (let s = 0; s < SUBSTEPS; s++) zm[s] = rng.normal();
    const idio = Math.sqrt(1 - MARKET_RHO * MARKET_RHO);
    const switchP = 1 / REGIME_MEAN_BARS;
    for (let i = 0; i < this._names.length; i++) {
      const sig = this._sig[i];
      if (rng.next() < switchP) this._mu[i] = rng.normal() * REGIME_DRIFT * sig;
      let jump = 0, jumpAt = -1;
      if (rng.next() < JUMP_P) { jump = rng.normal() * JUMP_SIZE * sig; jumpAt = rng.int(0, SUBSTEPS - 1); }
      const isAnchor = i === this._anchor;
      const rho = isAnchor ? 1 : MARKET_RHO;
      const w = isAnchor ? 0 : idio;
      const sSub = sig / Math.sqrt(SUBSTEPS);
      const muSub = this._mu[i] / SUBSTEPS - 0.5 * sSub * sSub; // Itô correction keeps E[price] driftless at μ=0
      let p = this._px[i];
      const o = p;
      let h = p, l = p;
      for (let s = 0; s < SUBSTEPS; s++) {
        const z = rho * zm[s] + w * rng.normal();
        p *= Math.exp(muSub + sSub * z + (s === jumpAt ? jump : 0));
        if (p > h) h = p;
        if (p < l) l = p;
      }
      const k = i * 4;
      this._last[k] = o; this._last[k + 1] = h; this._last[k + 2] = l; this._last[k + 3] = p;
      this._px[i] = p;
    }
  }

  _pushHistory() {
    if (this._len === HISTORY_CAP) {
      const drop = HISTORY_CAP - HISTORY_KEEP;
      for (const h of this._hist) h.copyWithin(0, drop, HISTORY_CAP);
      this._len = HISTORY_KEEP;
    }
    for (let i = 0; i < this._hist.length; i++) this._hist[i][this._len] = this._px[i];
    this._len++;
  }

  _setBar(i, o, h, l, c) {
    const k = i * 4;
    this._last[k] = o; this._last[k + 1] = Math.max(h, o, c); this._last[k + 2] = Math.min(l, o, c); this._last[k + 3] = c;
    this._px[i] = c;
  }

  // -------------------------------------------------------------------------------------------
  // Hyperliquid: staging

  /**
   * Queue real bars for nextSync(). `seg` = { openMs, len, ohlc: per-coin Float64Array(len·4) | null,
   * src: per-coin 'candle'|'mids'|'flat'|'none' }. Segments must continue the bar grid without gaps.
   */
  stage(seg) {
    if (!this.real) throw new Error('market.stage: only the hyperliquid feed stages bars');
    const expect = this._segments.length
      ? this._segments.at(-1).openMs + this._segments.at(-1).len * BAR_MS
      : this._startMs + (this._barIdx + 1) * BAR_MS;
    if (seg.openMs !== expect) {
      throw new Error(`market.stage: segment starts at ${new Date(seg.openMs).toISOString()}, expected ${new Date(expect).toISOString()}`);
    }
    this._segments.push({ ...seg, pos: 0 });
  }

  /** Drop staged bars (e.g. a hold discards a frame that will be re-fetched). */
  clearStaged() {
    this._segments = [];
  }

  /** Consume staged bar `b` into _last/_px (+ per-coin source and staleness). */
  _applyStaged(b) {
    const openMs = this._startMs + b * BAR_MS;
    const seg = this._segments[0];
    if (!seg || seg.openMs + seg.pos * BAR_MS !== openMs) {
      const err = new Error(`no closed bar staged for ${new Date(openMs).toISOString()} — real bars tick on real minutes`);
      err.status = 409;
      throw err;
    }
    const k = seg.pos;
    const counts = { candle: 0, mids: 0, flat: 0 };
    for (let i = 0; i < this._names.length; i++) {
      const a = seg.ohlc[i];
      let src = seg.src[i] ?? 'none';
      if (a) {
        this._setBar(i, a[k * 4], a[k * 4 + 1], a[k * 4 + 2], a[k * 4 + 3]);
      } else if (this._px[i] > 0) {
        const p = this._px[i];
        this._setBar(i, p, p, p, p);
        src = 'flat';
      } else {
        this._last.fill(0, i * 4, i * 4 + 4); // no real price for this coin yet: no bar at all
        src = 'none';
      }
      this._src[i] = src;
      if (src === 'candle') counts.candle++;
      else if (src === 'mids') counts.mids++;
      else counts.flat++;
      this._stale[i] = src === 'flat' || src === 'none' ? 1 : 0;
    }
    this._barSources = counts;
    seg.pos++;
    if (seg.pos >= seg.len) this._segments.shift();
  }

  // -------------------------------------------------------------------------------------------
  // Hyperliquid: requests

  /** allMids (skip mode) → setLiveMids. @returns {Promise<boolean>} */
  async pollMids() {
    if (!this.real) return false;
    try {
      this.setLiveMids(await this._hl.allMids(), this._now());
      return true;
    } catch (err) {
      this._noteError(err);
      return false;
    }
  }

  /**
   * Record live mids (from allMids): the latest price per coin and a sample in the minute buffer that
   * mid-built bars use. A coin that gets a fresh mid is no longer stale.
   * @param {Object<string, number>} pxByCoin
   * @param {number} tMs receive time
   */
  setLiveMids(pxByCoin, tMs) {
    if (!pxByCoin || typeof pxByCoin !== 'object') return;
    const minute = Math.floor(tMs / BAR_MS) * BAR_MS;
    let buf = this._samples.get(minute);
    let got = 0;
    for (let i = 0; i < this._names.length; i++) {
      const px = Number(pxByCoin[this._names[i]]);
      if (!(Number.isFinite(px) && px > 0)) continue;
      got++;
      this._mid[i] = px;
      this._midMs[i] = tMs;
      this._stale[i] = 0;
      if (!buf) {
        const K = this._names.length;
        buf = { h: new Float64Array(K), l: new Float64Array(K), c: new Float64Array(K), n: new Uint16Array(K) };
        this._samples.set(minute, buf);
      }
      if (buf.n[i] === 0) { buf.h[i] = px; buf.l[i] = px; } else { buf.h[i] = Math.max(buf.h[i], px); buf.l[i] = Math.min(buf.l[i], px); }
      buf.c[i] = px;
      buf.n[i]++;
    }
    if (got > 0) this._midsMs = Math.max(this._midsMs, tMs);
    for (const m of this._samples.keys()) if (m < minute - SAMPLE_MINUTES * BAR_MS) this._samples.delete(m);
  }

  /** metaAndAssetCtxs (skip mode) → coin limits + day stats. @returns {Promise<boolean>} */
  async refreshMeta() {
    if (!this.real) return false;
    try {
      this._applyMeta(await this._hl.metaAndAssetCtxs());
      return true;
    } catch (err) {
      this._noteError(err);
      return false;
    }
  }

  _applyMeta(byCoin) {
    for (let i = 0; i < this._names.length; i++) {
      const m = byCoin?.[this._names[i]];
      const info = this._info[i];
      if (!m || m.delisted) {
        info.listed = false;
        this._ctx[i] = null;
        continue;
      }
      info.listed = true;
      if (Number.isInteger(m.sz_decimals)) info.sz_decimals = m.sz_decimals;
      if (m.max_leverage > 0) info.max_leverage = m.max_leverage;
      this._ctx[i] = {
        prev_day_px: finiteOrNull(m.prev_day_px),
        funding_1h: finiteOrNull(m.funding_1h),
        mark_px: finiteOrNull(m.mark_px),
        oracle_px: finiteOrNull(m.oracle_px),
        open_interest: finiteOrNull(m.open_interest),
        day_ntl_vlm: finiteOrNull(m.day_ntl_vlm),
      };
    }
    this._ctxMs = this._now();
  }

  _listedIndexes() {
    const out = [];
    for (let i = 0; i < this._names.length; i++) if (this._info[i].listed) out.push(i);
    return out;
  }

  _listedCount() {
    return this._listedIndexes().length;
  }

  /**
   * The bar that closed at `openMs + 60 s`, per coin by priority: (a) the HL candle (missing ones retried at
   * +5 s and +10 s, until the 15 s deadline); (b) a bar from that minute's mid samples (`o` = previous close,
   * `h/l` = extremes of samples and `o`, `c` = last sample); (c) a flat bar at the previous close (stale).
   * Nothing is staged here.
   * @returns {Promise<{openMs, len:1, ohlc, src, counts:{candle,mids,flat}, allFlat:boolean}>}
   */
  async fetchClosed(openMs, { deadlineMs } = {}) {
    const t0 = this._now();
    const deadline = deadlineMs ?? t0 + CLOSE_DEADLINE_MS;
    const K = this._names.length;
    const candle = new Array(K).fill(null);
    let pending = this._listedIndexes();
    for (let attempt = 0; pending.length > 0; attempt++) {
      let netDown = false; // one network failure ends this attempt (HL is down; don't stack 8 s timeouts)
      await mapLimit(pending, HL_CONCURRENCY, async (i) => {
        try {
          const rows = await this._hl.candles(this._names[i], openMs, openMs + BAR_MS - 1, { deadlineMs: deadline });
          const k = rows.find((r) => r.t === openMs);
          if (k) candle[i] = k;
        } catch (err) {
          this._noteError(err);
          if (isNetworkError(err)) netDown = true;
        }
      }, () => netDown);
      pending = pending.filter((i) => !candle[i]);
      if (pending.length === 0 || attempt >= CLOSE_RETRY_MS.length) break;
      const at = t0 + CLOSE_RETRY_MS[attempt];
      if (at >= deadline) break;
      const wait = at - this._now();
      if (wait > 0) await this._sleep(wait);
    }

    const samples = this._samples.get(openMs);
    const ohlc = new Array(K).fill(null);
    const src = new Array(K).fill('none');
    const counts = { candle: 0, mids: 0, flat: 0 };
    for (let i = 0; i < K; i++) {
      const k = candle[i];
      if (k) {
        ohlc[i] = Float64Array.of(k.o, Math.max(k.h, k.o, k.c), Math.min(k.l, k.o, k.c), k.c);
        src[i] = 'candle';
        counts.candle++;
      } else if (samples && samples.n[i] > 0) {
        const o = this._px[i] > 0 ? this._px[i] : samples.c[i];
        ohlc[i] = Float64Array.of(o, Math.max(o, samples.h[i]), Math.min(o, samples.l[i]), samples.c[i]);
        src[i] = 'mids';
        counts.mids++;
      } else {
        src[i] = this._px[i] > 0 ? 'flat' : 'none'; // nextSync() writes the flat bar at the previous close
        counts.flat++;
      }
    }
    return { openMs, len: 1, ohlc, src, counts, allFlat: counts.candle + counts.mids === 0 };
  }

  /**
   * Candles for the closed bars [fromOpenMs, toOpenMs] (catch-up / restart replay), forward-filled from the
   * previous close. Coins that fail or return nothing get flat bars (stale).
   * @returns {Promise<null | {openMs, len, ohlc, src, withCandles, covered:boolean}>} null = HL unreachable
   */
  async fetchRange(fromOpenMs, toOpenMs) {
    const len = Math.round((toOpenMs - fromOpenMs) / BAR_MS) + 1;
    if (!(len >= 1)) throw new Error('market.fetchRange: empty range');
    return this._fetchSegment(fromOpenMs, len, { prevClose: true });
  }

  async _fetchSegment(fromOpenMs, len, { prevClose }) {
    const K = this._names.length;
    const ohlc = new Array(K).fill(null);
    const src = new Array(K).fill('none');
    const first = new Array(K).fill(-1);
    const deadlineMs = this._now() + RANGE_DEADLINE_MS;
    let answered = 0;
    let netDown = false;
    await mapLimit(this._listedIndexes(), HL_CONCURRENCY, async (i) => {
      try {
        const rows = await this._hl.candles(this._names[i], fromOpenMs, fromOpenMs + len * BAR_MS - 1, { budget: BOOT_BUDGET, deadlineMs });
        answered++;
        const aligned = alignCandles(rows, fromOpenMs, len, prevClose && this._px[i] > 0 ? this._px[i] : null);
        if (aligned) {
          ohlc[i] = aligned.ohlc;
          first[i] = aligned.first;
          src[i] = 'candle';
        }
      } catch (err) {
        this._noteError(err);
        if (isNetworkError(err)) netDown = true;
      }
    }, () => netDown);
    if (answered === 0) return null;
    let withCandles = 0;
    let covered = 0;
    for (let i = 0; i < K; i++) {
      if (!ohlc[i]) {
        if (this._px[i] > 0) src[i] = 'flat';
        continue;
      }
      withCandles++;
      if (first[i] <= COVER_SLACK_BARS) covered++;
    }
    return {
      openMs: fromOpenMs, len, ohlc, src, withCandles,
      covered: covered >= Math.min(MIN_REAL_COINS, Math.max(1, withCandles)),
    };
  }

  _noteError(err) {
    if (err?.skipped) return; // a request we chose not to send is not an HL failure
    this._error = String(err?.message ?? err);
    if (!this._errLogged) {
      this._errLogged = true;
      this._log(`[market] hyperliquid request failed: ${this._error}`);
    }
  }

  /** Diagnostics for status.feed: mids time, weight in the last 60 s, request counters. */
  feedInfo() {
    if (!this.real) return { mids_ms: null, weight_60s: 0, requests: null, last_ok_ms: null, backoff: false };
    const s = this._hl.stats;
    if (s.last_ok_ms > s.last_error_ms) this._errLogged = false; // recovered: log the next outage once again
    return {
      mids_ms: this._midsMs || null,
      weight_60s: this._hl.weight60s(),
      requests: this._hl.snapshot(),
      last_ok_ms: s.last_ok_ms || null,
      backoff: this._hl.inBackoff(),
    };
  }

  // -------------------------------------------------------------------------------------------
  // persistence

  /** Full deterministic state (JSON-safe). Staged bars, mids and samples are not kept (they go stale). */
  serialize() {
    return {
      v: 1,
      source: this._source,
      seed: this._seed,
      start_ms: this._startMs,
      bar_idx: this._barIdx,
      coins: this._names.slice(),
      rng: this._rng.state(),
      px: Array.from(this._px),
      mu: Array.from(this._mu),
      last: Array.from(this._last),
      stale: Array.from(this._stale),
      info: this._info.map((x) => ({ ...x })),
      len: this._len,
      hist: this._hist.map((h) => typedToB64(h.subarray(0, this._len))),
    };
  }


  restore(obj) {
    if (!obj || obj.v !== 1) throw new Error('market.restore: unsupported state');
    const K = this._names.length;
    if (!Array.isArray(obj.coins) || obj.coins.join(',') !== this._names.join(',')) {
      throw new Error('market.restore: coin listing differs from the saved state');
    }
    if (obj.source && obj.source !== this._source) {
      throw new Error(`market.restore: saved feed is ${obj.source}, this feed is ${this._source}`);
    }
    this._seed = obj.seed >>> 0;
    this._startMs = obj.start_ms;
    this._barIdx = obj.bar_idx;
    this._rng.setState(obj.rng);
    this._px = Float64Array.from(obj.px);
    this._mu = Float64Array.from(obj.mu);
    this._last = Float64Array.from(obj.last);
    this._stale = Uint8Array.from(obj.stale ?? new Array(K).fill(0));
    if (this._px.length !== K || this._mu.length !== K || this._last.length !== K * 4) {
      throw new Error('market.restore: state arrays do not match the coin listing');
    }
    if (Array.isArray(obj.info) && obj.info.length === K) {
      this._info = obj.info.map((x, i) => ({
        listed: x?.listed === true || (!this.real && x?.listed !== false),
        max_leverage: x?.max_leverage > 0 ? x.max_leverage : this._coins[i].max_leverage,
        sz_decimals: Number.isInteger(x?.sz_decimals) ? x.sz_decimals : this._coins[i].sz_decimals,
      }));
    }
    this._len = obj.len;
    this._hist = obj.hist.map((b64) => {
      const h = new Float64Array(HISTORY_CAP);
      h.set(b64ToTyped(b64, Float64Array, obj.len));
      return h;
    });
    this._segments = [];
    return this;
  }
}

/**
 * Align HL candles ([{t,o,h,l,c}], numbers or numeric strings) onto our minute grid starting at startMs.
 * Missing minutes are forward-filled as flat bars. Leading gaps are filled with `prevClose` when given (a
 * catch-up continues from the last known close), else back-filled from the first candle (warm-up).
 * @returns {{ohlc: Float64Array, first: number, n: number} | null} len·4 packed o,h,l,c; `first` = bar index
 *   of the first real candle; null when no candle falls on the grid
 */
export function alignCandles(candles, startMs, len, prevClose = null) {
  if (!Array.isArray(candles) || candles.length === 0 || !(len > 0)) return null;
  const out = new Float64Array(len * 4);
  const seen = new Uint8Array(len);
  let n = 0;
  for (const k of candles) {
    const b = Math.round((Number(k.t) - startMs) / BAR_MS);
    if (!(b >= 0 && b < len)) continue;
    const o = Number(k.o), h = Number(k.h), l = Number(k.l), c = Number(k.c);
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    out.set([o, Math.max(h, o, c), Math.min(l, o, c), c], b * 4);
    if (!seen[b]) n++;
    seen[b] = 1;
  }
  if (n === 0) return null;
  const first = seen.indexOf(1);
  const lead = prevClose > 0 ? prevClose : out[first * 4];
  let prevC = lead;
  for (let b = 0; b < len; b++) {
    if (seen[b]) { prevC = out[b * 4 + 3]; continue; }
    const px = b < first ? lead : prevC;
    out.set([px, px, px, px], b * 4);
  }
  return { ohlc: out, first, n };
}

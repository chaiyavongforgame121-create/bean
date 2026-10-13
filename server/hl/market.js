// server/hl/market.js — the shared TESTNET market cache (PLATFORM §6.1, §6.3, §6.8, §7.5).
//
//   allMids           every 5 s (P1)                       → quote(coin), snapshot() for the `mids` frame
//   metaAndAssetCtxs  at boot and every 5 min (P6)          → coinInfo(coin) (index, szDecimals, maxLeverage,
//                                                             delisted, onlyIsolated), ctx(coin) (funding, mark)
//   exchangeStatus    at boot and every 10 min (P6)         → clock skew (> 5 s warn, > 60 s state 'down')
//   l2Book            per coin ON DEMAND, ≤ once per 30 s per coin (120 s while degraded), de-duplicated and shared
//                     by every player                      → book(coin) depth within 1 % of the mid
//
// User-triggered GETs (testnet_status / testnet_quote / testnet_market / me) read ONLY this cache. The single
// exception is book(): a stale entry schedules one de-duplicated refresh for that coin, whoever asks, so its cost is
// bounded by coins, not users (§6.8, review S20).
//
// The listing (asset index = position in the testnet universe) is re-read at runtime; nothing here hard-codes
// testnet indices, decimals or leverage (T-LIST). Eligibility: listed AND isDelisted !== true.

import { COINS } from '../market.js';
import {
  BOOK_TTL_DEGRADED_MS, BOOK_TTL_MS, CLOCK_POLL_MS, DELAYED_AFTER_MS, DOWN_AFTER_MS, META_POLL_MS, MIDS_POLL_MS,
  SKEW_DOWN_MS, SKEW_WARN_MS,
} from './constants.js';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * [meta, ctxs] → Map coin → {index, sz_decimals, max_leverage, delisted, only_isolated, margin_mode, ctx}.
 * The asset index is the position in `meta.universe` (aligned with `ctxs`).
 */
export function parseTestnetMeta(raw) {
  const out = new Map();
  if (!Array.isArray(raw) || !Array.isArray(raw[0]?.universe)) return out;
  const ctxs = Array.isArray(raw[1]) ? raw[1] : [];
  raw[0].universe.forEach((u, index) => {
    if (!u || typeof u.name !== 'string') return;
    const c = ctxs[index] ?? {};
    out.set(u.name, {
      index,
      sz_decimals: Number.isInteger(u.szDecimals) ? u.szDecimals : null,
      max_leverage: Number.isFinite(u.maxLeverage) && u.maxLeverage > 0 ? u.maxLeverage : null,
      delisted: u.isDelisted === true,
      only_isolated: u.onlyIsolated === true,
      margin_mode: typeof u.marginMode === 'string' ? u.marginMode : null,
      ctx: { funding_1h: num(c.funding), mark_px: num(c.markPx), mid_px: num(c.midPx), oracle_px: num(c.oraclePx) },
    });
  });
  return out;
}

/** Book depth within ±1 % of the book mid: USD a buy (asks) / a sell (bids) can take. */
export function bookDepth(raw, pct = 0.01) {
  const bids = Array.isArray(raw?.levels?.[0]) ? raw.levels[0] : [];
  const asks = Array.isArray(raw?.levels?.[1]) ? raw.levels[1] : [];
  const bestBid = num(bids[0]?.px);
  const bestAsk = num(asks[0]?.px);
  let mid = null;
  if (bestBid > 0 && bestAsk > 0) mid = (bestBid + bestAsk) / 2;
  else mid = bestBid > 0 ? bestBid : (bestAsk > 0 ? bestAsk : null);
  let buy = 0;
  let sell = 0;
  if (mid !== null) {
    for (const l of asks) {
      const px = num(l?.px);
      const sz = num(l?.sz);
      if (px > 0 && sz > 0 && px <= mid * (1 + pct)) buy += px * sz;
    }
    for (const l of bids) {
      const px = num(l?.px);
      const sz = num(l?.sz);
      if (px > 0 && sz > 0 && px >= mid * (1 - pct)) sell += px * sz;
    }
  }
  return { mid, best_bid: bestBid, best_ask: bestAsk, depth_buy_usd_1pct: buy, depth_sell_usd_1pct: sell };
}

export class TestnetMarket {
  /**
   * @param {object} opts
   * @param {import('./info.js').TestnetInfo} opts.info
   * @param {import('./scheduler.js').HlScheduler} [opts.scheduler]  for degradation (book TTL)
   * @param {() => number} [opts.now]
   * @param {(line: string) => void} [opts.log]
   * @param {string[]} [opts.coins]          our coins (default: the 16 engine coins)
   * @param {boolean} [opts.enabled=true]    false → state 'disabled', no requests
   * @param {() => boolean} [opts.signingHalted]  signature_mismatch halt → state 'down' / reason 'signing'
   * @param {{setTimeout: Function, clearTimeout: Function}} [opts.timers]
   */
  constructor({ info, scheduler = null, now = Date.now, log, coins = COINS.map((c) => c.coin), enabled = true,
    signingHalted = () => false, timers = { setTimeout, clearTimeout }, midsPollMs = MIDS_POLL_MS,
    metaPollMs = META_POLL_MS, clockPollMs = CLOCK_POLL_MS } = {}) {
    if (!info) throw new TypeError('TestnetMarket needs info');
    this.info = info;
    this.scheduler = scheduler;
    this.now = now;
    this.log = typeof log === 'function' ? log : () => {};
    this.coins = Object.freeze([...coins]);
    this.enabled = enabled !== false;
    this.signingHalted = typeof signingHalted === 'function' ? signingHalted : () => false;
    this.timers = timers;
    this.cadence = { mids: midsPollMs, meta: metaPollMs, clock: clockPollMs };

    this.listingMap = new Map(); // coin → parsed meta row (all testnet coins)
    this.metaMs = 0;
    this.mids = new Map(); // coin → {px, ms}
    this.midsMs = 0;
    this.books = new Map(); // coin → {…depth, ms}
    this.bookInflight = new Map(); // coin → Promise
    this.skewMs = null;
    this.clockMs = 0;
    this.startedMs = 0;
    this.running = false;
    this.handles = new Set();
    this.listeners = new Set();
    this.lastState = null;
    this.lastError = null;
  }

  // ---- lifecycle ------------------------------------------------------------------------------------------------

  /** Boot reads (meta, mids, clock), then the polling loops. Never throws (failures show in state()). */
  async start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.startedMs = this.now();
    await Promise.allSettled([this.refreshMeta(), this.pollMids(), this.checkClock()]);
    if (!this.running) return;
    this.#loop(() => this.pollMids(), this.cadence.mids);
    this.#loop(() => this.refreshMeta(), this.cadence.meta);
    this.#loop(() => this.checkClock(), this.cadence.clock);
    this.#evaluate();
  }

  stop() {
    this.running = false;
    for (const h of this.handles) this.timers.clearTimeout(h);
    this.handles.clear();
  }

  #loop(fn, everyMs) {
    const tick = () => {
      if (!this.running) return;
      const h = this.timers.setTimeout(async () => {
        this.handles.delete(h);
        try {
          await fn();
        } catch { /* recorded in state */ }
        tick();
      }, everyMs);
      h?.unref?.();
      this.handles.add(h);
    };
    tick();
  }

  // ---- polls ----------------------------------------------------------------------------------------------------

  /** One allMids read (skipped rather than queued behind the budget for more than one cadence). */
  async pollMids() {
    if (!this.enabled) return;
    try {
      const mids = await this.info.allMids({ maxWaitMs: Math.max(1_000, this.cadence.mids - 500) });
      const ms = this.now();
      for (const coin of this.coins) {
        const px = mids[coin];
        if (px > 0) this.mids.set(coin, { px, ms });
      }
      this.midsMs = ms;
      this.lastError = null;
    } catch (err) {
      this.lastError = err?.code ?? 'error';
    } finally {
      this.#evaluate();
    }
  }

  /** Re-read the listing and asset contexts (funding, mark). */
  async refreshMeta() {
    if (!this.enabled) return;
    try {
      const raw = await this.info.metaAndAssetCtxs();
      const parsed = parseTestnetMeta(raw);
      if (parsed.size) {
        this.listingMap = parsed;
        this.metaMs = this.now();
      }
    } catch (err) {
      this.lastError = err?.code ?? 'error';
    } finally {
      this.#evaluate();
    }
  }

  /** exchangeStatus → skew = server − Hyperliquid (§6.6). */
  async checkClock() {
    if (!this.enabled) return;
    try {
      const raw = await this.info.exchangeStatus();
      const skew = this.now() - Number(raw.time);
      this.skewMs = skew;
      this.clockMs = this.now();
      if (Math.abs(skew) > SKEW_WARN_MS) this.log(`[hl] testnet clock skew ${Math.round(skew / 1000)} s (server − Hyperliquid)`);
    } catch (err) {
      this.lastError = err?.code ?? 'error';
    } finally {
      this.#evaluate();
    }
  }

  // ---- reads (cache only) ---------------------------------------------------------------------------------------

  /** {index, sz_decimals, max_leverage, delisted, only_isolated, margin_mode} | null (unlisted or no listing yet). */
  coinInfo(coin) {
    const r = this.listingMap.get(coin);
    if (!r) return null;
    const { index, sz_decimals, max_leverage, delisted, only_isolated, margin_mode } = r;
    return { index, sz_decimals, max_leverage, delisted, only_isolated, margin_mode };
  }

  /** True when listed and not delisted (the testnet venue eligibility, §6.3). */
  tradeable(coin) {
    const r = this.listingMap.get(coin);
    return Boolean(r) && !r.delisted;
  }

  /** Testnet mid {px, ms} | null. */
  quote(coin) {
    const q = this.mids.get(coin);
    return q ? { px: q.px, ms: q.ms } : null;
  }

  /** Testnet funding / mark {funding_1h, mark_px, ms} | null. */
  ctx(coin) {
    const r = this.listingMap.get(coin);
    if (!r) return null;
    return { funding_1h: r.ctx.funding_1h, mark_px: r.ctx.mark_px, ms: this.metaMs };
  }

  #bookTtl() {
    return this.scheduler?.degraded?.() ? BOOK_TTL_DEGRADED_MS : BOOK_TTL_MS;
  }

  /**
   * Cached depth {depth_buy_usd_1pct, depth_sell_usd_1pct, mid, ms} | null. A missing or stale entry schedules ONE
   * shared, de-duplicated refresh for that coin; the caller still gets the cached value (or null) at once.
   */
  book(coin) {
    if (!this.enabled || !this.listingMap.has(coin)) return null;
    const b = this.books.get(coin) ?? null;
    if (!b || this.now() - b.ms > this.#bookTtl()) this.refreshBook(coin).catch(() => {});
    return b ? { ...b } : null;
  }

  /** Refresh one coin's book (de-duplicated: concurrent callers share one request). */
  refreshBook(coin) {
    if (!this.enabled || !this.listingMap.has(coin)) return Promise.resolve(null);
    const pending = this.bookInflight.get(coin);
    if (pending) return pending;
    const p = (async () => {
      try {
        const raw = await this.info.l2Book(coin);
        const depth = bookDepth(raw);
        const entry = { ...depth, ms: this.now() };
        this.books.set(coin, entry);
        return { ...entry };
      } finally {
        this.bookInflight.delete(coin);
      }
    })();
    this.bookInflight.set(coin, p);
    return p;
  }

  // ---- state ----------------------------------------------------------------------------------------------------

  /** {state, reason}: 'disabled' | 'down' (signing, clock_skew, unreachable, not_started) | 'delayed' | 'live'. */
  status() {
    if (!this.enabled) return { state: 'disabled', reason: null };
    if (this.signingHalted()) return { state: 'down', reason: 'signing' };
    if (this.skewMs !== null && Math.abs(this.skewMs) > SKEW_DOWN_MS) return { state: 'down', reason: 'clock_skew' };
    const now = this.now();
    const lastOk = this.info.lastOkMs || 0;
    if (!this.startedMs && !lastOk) return { state: 'down', reason: 'not_started' };
    const since = lastOk ? now - lastOk : now - this.startedMs;
    if (since > DOWN_AFTER_MS) return { state: 'down', reason: 'unreachable' };
    if (since > DELAYED_AFTER_MS || !lastOk) return { state: 'delayed', reason: lastOk ? 'stale' : 'starting' };
    return { state: 'live', reason: null };
  }

  state() {
    return this.status().state;
  }

  stateReason() {
    return this.status().reason;
  }

  /** Subscribe to state changes: fn({state, prev, reason, error}). Returns an unsubscribe function. */
  onStateChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Re-evaluate the state now (also called after every poll); notifies listeners on a change. */
  #evaluate() {
    const { state, reason } = this.status();
    const key = `${state}|${reason ?? ''}`;
    if (this.lastState === null) {
      this.lastState = key;
      return;
    }
    if (key === this.lastState) return;
    const prev = this.lastState.split('|')[0];
    this.lastState = key;
    for (const fn of this.listeners) {
      try {
        fn({ state, prev, reason, error: this.lastError });
      } catch (err) {
        this.log(`[hl] testnet state listener failed: ${err?.message ?? err}`);
      }
    }
  }

  /** Public re-check hook (e.g. after a signing halt is set or cleared). */
  evaluate() {
    this.#evaluate();
  }

  /** The testnet part of the `mids` frame (§7.5): compact, our coins only. */
  snapshot() {
    const { state, reason } = this.status();
    const mids = {};
    const marks = {};
    const funding = {};
    for (const coin of this.coins) {
      const q = this.mids.get(coin);
      if (q) mids[coin] = q.px;
      const r = this.listingMap.get(coin);
      if (r?.ctx.mark_px !== null && r?.ctx.mark_px !== undefined) marks[coin] = r.ctx.mark_px;
      if (r?.ctx.funding_1h !== null && r?.ctx.funding_1h !== undefined) funding[coin] = r.ctx.funding_1h;
    }
    return { state, state_reason: reason, mids_ms: this.midsMs || null, ctx_ms: this.metaMs || null, mids, marks, funding_1h: funding };
  }

  /** Rows for `testnet_market` (§8.3): every one of our coins; unlisted ones carry index:null, tradeable:false. */
  listing() {
    return this.coins.map((coin) => {
      const r = this.listingMap.get(coin);
      const q = this.mids.get(coin);
      return {
        coin,
        index: r ? r.index : null,
        sz_decimals: r ? r.sz_decimals : null,
        max_leverage: r ? r.max_leverage : null,
        delisted: r ? r.delisted : false,
        only_isolated: r ? r.only_isolated : false,
        margin_mode: r ? r.margin_mode : null,
        mid: q ? q.px : null,
        mid_ms: q ? q.ms : null,
        mark_px: r ? r.ctx.mark_px : null,
        funding_1h: r ? r.ctx.funding_1h : null,
        tradeable: Boolean(r) && !r.delisted,
      };
    });
  }

  stats() {
    const { state, reason } = this.status();
    return { state, state_reason: reason, mids_ms: this.midsMs || null, ctx_ms: this.metaMs || null, skew_ms: this.skewMs,
      clock_ms: this.clockMs || null, listed: this.listingMap.size, books: this.books.size };
  }
}

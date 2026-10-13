// server/engine.js — orchestrates the market feed and the bean population: warm-up, the tick loop,
// fast-forward (sim), the real-minute scheduler (hyperliquid), live marks, gap fill / re-warm, the
// feed state machine, health/status payloads and whole-engine persistence.
//
// One tick = one bar (one minute):
//   market.nextSync() → population.step() → journal 'busted' (per newly busted bean)
//   → onTick hooks (the live layer mirrors here) → journal 'tick_completed' → onMarks hooks.
// tick() is synchronous and never waits on the network.
//
// Feeds (GAME-DESIGN §10):
//   sim          setInterval(tickMs) ticks; after each tick a marks pulse is published from the closes,
//                so the client has one code path. `tick n` (fast-forward) works.
//   hyperliquid  REAL prices, paper trades. One bar per real minute: a timer at the next minute boundary
//                + 2 s fetches the closed candles (market.fetchClosed) and ticks. Every ~5 s allMids marks
//                the bots (liquidation checked on the live mid) and publishes `mids`. HL down → hold, never
//                invent a price; when it returns, replay the missed minutes (≤ 2880) or re-warm. `tick` is
//                refused (409): real prices run at market speed.

import { performance } from 'node:perf_hooks';
import { MarketFeed, BAR_MS, lastClosedMinute, LIVE_MAX_AGE_MS } from './market.js';
import { Population } from './population.js';
import { HyperliquidClient } from './hyperliquid.js';

export const ENGINE_VERSION = '0.2.0';
export const DEFAULT_CONFIG = Object.freeze({ seed: 42, beans: 3000, feed: 'sim', warmupBars: 2880, tickMs: 5000 });

/** Real feed: one bar per wall-clock minute. */
export const REAL_TICK_MS = 60_000;
/** The minute timer fires this long after each boundary (HL publishes the closed candle). */
export const TICK_GRACE_MS = 2_000;
/** allMids cadence. */
export const MIDS_EVERY_MS = 5_000;
/** While holding (HL unreachable), retry this often. */
export const HOLD_RETRY_MS = 15_000;
/** No successful HL request for this long → feed state `down`. */
export const DOWN_AFTER_MS = 60_000;
/** Longest gap replayed bar by bar; longer gaps re-warm. */
export const MAX_REPLAY_BARS = 2880;
/** Sim fallback: probe allMids this often (→ status.feed.real_available). */
export const PROBE_EVERY_MS = 60_000;
/** Refused `tick` in real mode (http.js uses the same words). */
export const REAL_TICK_REFUSAL = 'tick is only available with the sim feed — real prices run at market speed';

const YIELD_EVERY = 20;          // advance(n) / replay yield to the event loop every N ticks
const REWARM_YIELD_EVERY = 250;  // re-warm builds the new population off to the side, yielding now and then
const NULL_JOURNAL = Object.freeze({ emit() { return null; } });

const yieldNow = () => new Promise((resolve) => setImmediate(resolve));

/** Error with an HTTP-ish status for the API layer. */
function statusError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Real feed could not warm up on a fresh start (main.js falls back to the sim feed). */
export class FeedUnavailableError extends Error {
  constructor(reason) {
    super(`hyperliquid feed unavailable: ${reason}`);
    this.name = 'FeedUnavailableError';
    this.reason = reason;
  }
}

export class Engine {
  /**
   * @param {object} opts
   * @param {object} [opts.config] { seed=42, beans=3000, feed='sim'|'hyperliquid', warmupBars=2880, tickMs=5000 (sim),
   *   startMs? (sim: market time of bar 0; default now − warmupBars minutes), version?, log?,
   *   fallback? ({from:'hyperliquid', reason, since_ms} when this sim engine replaces a real one that could not start),
   *   — injectables (tests) — now?, fetch?, hl? (HyperliquidClient), sleep?, timers? ({setTimeout, clearTimeout,
   *   setInterval, clearInterval}), maxReplayBars? }
   * @param {{emit(kind:string, data:object):any}} [opts.journal] anything with emit(kind, data)
   */
  constructor({ config = {}, journal = null } = {}) {
    const cfg = { ...DEFAULT_CONFIG };
    for (const [k, v] of Object.entries(config ?? {})) if (v !== undefined && v !== null) cfg[k] = v;
    cfg.seed = Number(cfg.seed) >>> 0;
    cfg.beans = Math.floor(Number(cfg.beans));
    cfg.warmupBars = Math.floor(Number(cfg.warmupBars));
    cfg.tickMs = Number(cfg.tickMs);
    if (!(cfg.beans >= 1)) throw new Error('engine: beans must be ≥ 1');
    if (!(cfg.warmupBars >= 0)) throw new Error('engine: warmupBars must be ≥ 0');
    if (!(cfg.tickMs >= 10)) throw new Error('engine: tickMs must be ≥ 10');
    if (cfg.feed !== 'sim' && cfg.feed !== 'hyperliquid') throw new Error(`engine: unknown feed '${cfg.feed}'`);
    this._real = cfg.feed === 'hyperliquid';
    if (this._real) cfg.tickMs = REAL_TICK_MS;

    this._now = typeof cfg.now === 'function' ? cfg.now : Date.now;
    if (!Number.isFinite(cfg.startMs)) cfg.startMs = Math.floor(this._now() / BAR_MS) * BAR_MS - cfg.warmupBars * BAR_MS;
    this._timers = cfg.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
    this._sleep = typeof cfg.sleep === 'function' ? cfg.sleep : undefined;
    this._maxReplay = Number.isInteger(cfg.maxReplayBars) && cfg.maxReplayBars >= 1 ? cfg.maxReplayBars : MAX_REPLAY_BARS;
    this._fallback = !this._real && cfg.fallback && typeof cfg.fallback === 'object' ? { ...cfg.fallback } : null;

    this._config = cfg;
    this._journal = journal && typeof journal.emit === 'function' ? journal : NULL_JOURNAL;
    this._log = typeof cfg.log === 'function' ? cfg.log : console.log;
    this._version = cfg.version ?? ENGINE_VERSION;
    // One read-only HL client per engine (shared across re-warms so the weight ledger stays continuous).
    this._hl = cfg.hl ?? (this._real || this._fallback
      ? new HyperliquidClient({ fetch: cfg.fetch, now: this._now, sleep: this._sleep, log: this._log })
      : null);
    this._market = this._makeMarket(cfg.startMs);
    this._population = new Population({ seed: cfg.seed, total: cfg.beans, coins: this._market.coins });
    this._venueHook = null;
    this._hooks = [];
    this._markHooks = [];
    this._ticks = 0;            // bars processed, warm-up included (sim: tick = bar_idx + 1)
    this._restored = false;
    this._restoredTick = null;  // the tick of the restored snapshot (null: a fresh start)
    this._started = false;
    this._busy = false;
    this._lastSummary = null;
    this._lastTickDurMs = null;
    this._lastTickWallMs = null;
    this._warmup = null;        // { bars, ms } once warmed up
    this._createdMs = this._now();

    // loop / scheduler state
    this._running = false;
    this._simTimer = null;
    this._minuteTimer = null;
    this._midsTimer = null;
    this._probeTimer = null;
    this._nextTickAt = null;    // real: when the minute timer fires next
    this._minuteBusy = null;    // promise of the scheduler step in flight
    this._barsSinceStart = 0;   // real bars ticked after start() (gap reason: restart vs outage)
    this._lagBars = 0;          // closed minutes not ticked yet because we are holding
    this._holdSinceMs = null;
    this._catchingUp = false;   // replay / re-warm in progress (marks and new exposure wait)
    this._lastGap = null;       // { bars, mode, from_ms, to_ms, at_ms }
    this._realAvailable = null; // sim fallback: result of the last allMids probe
    this._feedSeen = null;      // last feed_status emitted: { state, stale }
  }

  _makeMarket(startMs) {
    const c = this._config;
    return new MarketFeed({
      seed: c.seed, source: c.feed, log: this._log, startMs, warmupBars: c.warmupBars,
      hl: this._hl, now: this._now, sleep: this._sleep,
    });
  }

  get market() { return this._market; }
  get population() { return this._population; }
  get config() { return this._config; }
  /** Bars processed so far (warm-up included). */
  get ticks() { return this._ticks; }
  get running() { return this._running; }
  get started() { return this._started; }
  get lastSummary() { return this._lastSummary; }
  /** True while missed minutes are replayed or the market re-warms. */
  get catchingUp() { return this._catchingUp; }
  /**
   * The tick of the snapshot restore() loaded, or null after a fresh start. Accounts-mode gardens compare it with
   * their stored watermark: a DB newer than the engine state must not re-mirror bars it already traded (live.js).
   */
  get restoredTick() { return this._restoredTick; }
  /** 'real' | 'sim' (what the UI badge says). */
  get prices() { return this._real ? 'real' : 'sim'; }
  /** The read-only mainnet HyperliquidClient (null with the sim feed): its queued userRole is the mainnet guard (PLATFORM §6.7). */
  get hl() { return this._hl; }

  // -------------------------------------------------------------------------------------------
  // start / warm-up

  /**
   * Prepare the market and the population.
   *   sim: warm up `warmupBars` synthetic bars synchronously (unless restored) → 'warmup_finished'.
   *   hyperliquid, fresh: metadata + mids + real warm-up candles; FeedUnavailableError when that fails (main.js
   *     then falls back to sim). Restored: metadata + mids, then replay / re-warm the minutes missed while we
   *     were stopped ('feed_gap', reason 'restart'); HL unreachable → hold (state down) and catch up later.
   * @returns {Promise<{restored:boolean, warmup:{bars:number, ms:number}|null}>}
   */
  async start() {
    if (this._started) return { restored: this._restored, warmup: this._warmup };
    const res = await this._market.init();
    if (!this._restored) {
      if (this._real && !res.ok) throw new FeedUnavailableError(res.reason ?? 'unknown');
      const t0 = performance.now();
      const bars = this._config.warmupBars;
      for (let b = 0; b < bars; b++) this._advanceBar();
      const ms = Math.round(performance.now() - t0);
      this._warmup = { bars, ms };
      this._journal.emit('warmup_finished', { bars, ms });
    } else if (this._real) {
      if (res.ok) await this._fillGap('restart');
      else this._hold(this._gapBars(this._now()));
    }
    this._started = true;
    if (this._real || this._fallback) this._checkFeed();
    return { restored: this._restored, warmup: this._warmup };
  }

  /** One bar through market and population (no hooks, no events). */
  _advanceBar() {
    const frame = this._market.nextSync();
    const result = this._population.step(frame);
    this._ticks++;
    return { frame, result };
  }

  // -------------------------------------------------------------------------------------------
  // ticks

  /**
   * Run one tick. Synchronous; throws (status 409) if called re-entrantly from inside a hook, or (real feed)
   * when no closed bar is staged.
   * @param {object} [opts]
   * @param {boolean} [opts.quiet=false]  no 'tick_completed' (replayed bars, except the last)
   * @param {boolean} [opts.marks]        run the marks hooks afterwards (default: !quiet)
   * @returns {{tick:number, bar:number, time_ms:number, dur_ms:number, fills:number, busted:number,
   *            exits:{liquidation:number,stop:number,target:number,max_hold:number,signal:number},
   *            closed_ms:number, next_tick_ms:number|null, source:string, busted_ids:number[]}}
   */
  tick({ quiet = false, marks = !quiet } = {}) {
    if (this._busy) throw statusError(409, 'tick already in progress');
    this._busy = true;
    let summary;
    try {
      const t0 = performance.now();
      const { frame, result } = this._advanceBar();
      for (const id of result.busted) {
        const b = this._population.brief(id);
        const ev = { bean: id, archetype: b.archetype, coin: b.coin, equity: b.equity };
        if (this._catchingUp) ev.replay = true; // a replayed missed minute: applied by clients without animation
        this._journal.emit('busted', ev);
      }
      summary = {
        tick: this._ticks,
        bar: frame.barIdx,
        time_ms: frame.timeMs,
        dur_ms: 0,
        fills: result.fills,
        busted: result.busted.length,
        exits: result.exits,
        closed_ms: frame.timeMs + BAR_MS,
        next_tick_ms: null,
        source: this._market.source,
        busted_ids: result.busted,
      };
      for (const fn of this._hooks) {
        try {
          fn(summary, this);
        } catch (err) {
          this._log(`[engine] onTick hook failed: ${err?.stack ?? err}`);
        }
      }
      summary.dur_ms = Math.round((performance.now() - t0) * 100) / 100;
      this._lastTickDurMs = summary.dur_ms;
      this._lastTickWallMs = this._now();
      // Real: the next bar closes one minute after this one (+ grace). Sim: one interval from now, if looping.
      summary.next_tick_ms = this._real
        ? summary.closed_ms + BAR_MS + TICK_GRACE_MS
        : (this._simTimer ? this._lastTickWallMs + this._config.tickMs : null);
      this._lastSummary = summary;
      if (this._real) this._barsSinceStart++;
      const { busted_ids: _ids, ...event } = summary;
      if (!quiet) this._journal.emit('tick_completed', event);
    } finally {
      this._busy = false;
    }
    if (marks) this._emitMarks();
    return summary;
  }

  /** Sim fast-forward: run n ticks back-to-back (yielding now and then). Refused (409) with real prices. */
  async advance(n = 1) {
    if (this._real) throw statusError(409, REAL_TICK_REFUSAL);
    const count = Math.floor(Number(n));
    if (!(count >= 1)) throw statusError(400, 'n must be a positive integer');
    let last = null;
    for (let i = 0; i < count; i++) {
      last = this.tick({ marks: i === count - 1 });
      if ((i + 1) % YIELD_EVERY === 0 && i + 1 < count) await yieldNow();
    }
    return last;
  }

  /**
   * Start the loop. Sim: one tick every tickMs (+ the real-feed probe when this is a fallback). Real: the minute
   * scheduler (boundary + 2 s) and the ~5 s allMids poller. Idempotent.
   */
  run() {
    if (this._running) return this;
    this._running = true;
    const t = this._timers;
    if (!this._real) {
      this._simTimer = t.setInterval(() => {
        try {
          this.tick();
        } catch (err) {
          if (err?.status !== 409) this._log(`[engine] tick failed: ${err?.stack ?? err}`);
        }
      }, this._config.tickMs);
      if (this._fallback && this._hl) this._scheduleProbe(0);
      return this;
    }
    const now = this._now();
    const g = this._gapBars(now);
    const boundary = Math.floor(now / BAR_MS) * BAR_MS;
    let at = boundary + BAR_MS + TICK_GRACE_MS;
    if (this._lagBars > 0) at = now + HOLD_RETRY_MS;
    else if (g >= 1) at = Math.max(now, boundary + TICK_GRACE_MS);
    this._scheduleMinute(at);
    this._scheduleMids(MIDS_EVERY_MS);
    return this;
  }

  stop() {
    const t = this._timers;
    if (this._simTimer) t.clearInterval(this._simTimer);
    for (const k of ['_minuteTimer', '_midsTimer', '_probeTimer']) if (this[k]) t.clearTimeout(this[k]);
    this._simTimer = this._minuteTimer = this._midsTimer = this._probeTimer = null;
    this._nextTickAt = null;
    this._running = false;
    return this;
  }

  /** Register fn(summary, engine), called after each tick BEFORE 'tick_completed'. Returns an unsubscribe. */
  onTick(fn) {
    if (typeof fn !== 'function') throw new TypeError('onTick: function expected');
    this._hooks.push(fn);
    return () => { this._hooks = this._hooks.filter((h) => h !== fn); };
  }

  /**
   * Register fn(marks, engine) for live marks: after each successful allMids (~5 s, real) and after every tick
   * (both feeds). marks = { t, source, prices, px: {coin: livePx}, stale: [coins], bar: {tick, time_ms,
   * next_tick_ms} }. main.js runs live.markLive(marks) and publishes the `mids` pulse here. Returns an unsubscribe.
   */
  onMarks(fn) {
    if (typeof fn !== 'function') throw new TypeError('onMarks: function expected');
    this._markHooks.push(fn);
    return () => { this._markHooks = this._markHooks.filter((h) => h !== fn); };
  }

  /** Population venue hook (kept across re-warms, which rebuild the population). */
  setVenueHook(fn) {
    this._venueHook = typeof fn === 'function' ? fn : null;
    this._population.setVenueHook(this._venueHook);
  }

  /** The current marks frame (also what onMarks hooks receive). */
  marks() {
    const m = this._market;
    const now = this._now();
    const px = {};
    const pxMs = {};
    let oldest = null;
    for (const c of m.coins) {
      const q = typeof m.liveQuote === 'function' ? m.liveQuote(c.coin) : { px: m.livePx(c.coin), ms: now };
      if (!(q.px > 0)) continue;
      px[c.coin] = q.px;
      const ms = Number.isFinite(q.ms) ? Math.min(q.ms, now) : now;
      pxMs[c.coin] = ms;
      if (oldest === null || ms < oldest) oldest = ms;
    }
    // `t` is the time of the prices in this frame, never "now": the last allMids while it is fresh, else the
    // last bar close that livePx fell back to (sim: now). A frame built from old prices therefore looks old,
    // so the client's age tags and its "no planting on old marks" rule see the truth.
    let t = now;
    if (this._real) {
      const fresh = m.midsMs > 0 && now - m.midsMs <= LIVE_MAX_AGE_MS;
      t = fresh ? m.midsMs : (oldest ?? (m.barIdx >= 0 ? m.timeMs + BAR_MS : now));
    }
    return {
      t,
      source: m.source,
      prices: this.prices,
      px,
      px_ms: pxMs,
      stale: m.staleCoins(),
      bar: { tick: this._ticks, time_ms: m.barIdx >= 0 ? m.timeMs : null, next_tick_ms: this.nextTickMs() },
    };
  }

  _emitMarks() {
    if (this._markHooks.length === 0) return;
    const marks = this.marks();
    for (const fn of this._markHooks) {
      try {
        fn(marks, this);
      } catch (err) {
        this._log(`[engine] onMarks hook failed: ${err?.stack ?? err}`);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // real feed: scheduler, mids, gap fill, re-warm

  /** Closed minutes the market is behind wall time. */
  _gapBars(now) {
    return Math.max(0, Math.round((lastClosedMinute(now) - this._market.timeMs) / BAR_MS));
  }

  _scheduleMinute(at) {
    const t = this._timers;
    if (this._minuteTimer) t.clearTimeout(this._minuteTimer);
    this._nextTickAt = at;
    this._minuteTimer = t.setTimeout(() => this._onMinuteTimer(), Math.max(0, at - this._now()));
    this._minuteTimer?.unref?.();
  }

  async _onMinuteTimer() {
    this._minuteTimer = null;
    let outcome;
    try {
      outcome = await this.runMinute();
    } catch (err) {
      this._log(`[engine] minute step failed: ${err?.stack ?? err}`);
      outcome = { kind: 'error' };
    }
    if (!this._running) return;
    const now = this._now();
    const retry = outcome.kind === 'hold' || outcome.kind === 'error';
    const at = retry ? now + HOLD_RETRY_MS : Math.floor(now / BAR_MS) * BAR_MS + BAR_MS + TICK_GRACE_MS;
    this._scheduleMinute(at);
  }

  /**
   * One scheduler step (what the minute timer runs; public for tests). Never overlaps itself.
   *   gap 0 → idle; gap 1 → fetchClosed + tick (or hold when every coin would be flat);
   *   gap ≥ 2 → replay the missed bars (≤ maxReplayBars) or re-warm.
   * @returns {Promise<{kind:'idle'|'tick'|'hold'|'replay'|'rewarm', bars?:number, sources?:object}>}
   */
  runMinute() {
    if (!this._real) return Promise.resolve({ kind: 'idle' });
    if (!this._minuteBusy) {
      this._minuteBusy = this._runMinute().finally(() => { this._minuteBusy = null; });
    }
    return this._minuteBusy;
  }

  async _runMinute() {
    const g = this._gapBars(this._now());
    if (g === 0) {
      this._checkFeed();
      return { kind: 'idle', bars: 0 };
    }
    if (g >= 2) return this._fillGap(this._barsSinceStart === 0 ? 'restart' : 'outage');
    const openMs = this._market.timeMs + BAR_MS;
    const frame = await this._market.fetchClosed(openMs);
    if (frame.allFlat) {
      this._hold(1);
      return { kind: 'hold', bars: 0 };
    }
    this._market.clearStaged();
    this._market.stage(frame);
    this._settle();
    this.tick();
    this._afterRealTick();
    return { kind: 'tick', bars: 1, sources: frame.counts };
  }

  /** Fill the gap since the last bar: replay (≤ maxReplayBars, candles cover it) or re-warm. */
  async _fillGap(reason) {
    const g = this._gapBars(this._now());
    if (g === 0) return { kind: 'idle', bars: 0 };
    if (g > this._maxReplay) return this.rewarm(reason, g);
    const from = this._market.timeMs + BAR_MS;
    const to = from + (g - 1) * BAR_MS;
    const seg = await this._market.fetchRange(from, to);
    if (!seg) {
      this._hold(g);
      return { kind: 'hold', bars: 0 };
    }
    if (!seg.covered) return this.rewarm(reason, g);
    this._market.clearStaged();
    this._market.stage(seg);
    this._catchingUp = true;
    try {
      for (let i = 0; i < g; i++) {
        const last = i === g - 1;
        if (last) {
          this._lastGap = { bars: g, mode: 'replay', from_ms: from, to_ms: to + BAR_MS, at_ms: this._now() };
          this._journal.emit('feed_gap', { from_ms: from, to_ms: to + BAR_MS, bars: g, mode: 'replay', reason });
          this._settle();
        }
        // Bots mirror and liquidate per bar (fills stamped with each bar's close); one tick_completed at the end.
        this.tick({ quiet: !last, marks: false });
        if (!last && (i + 1) % YIELD_EVERY === 0) await yieldNow();
      }
    } finally {
      this._catchingUp = false;
    }
    this._emitMarks();
    this._afterRealTick();
    this._checkFeed();
    return { kind: 'replay', bars: g };
  }

  /**
   * Re-warm in place: a fresh real warm-up ending now rebuilds MarketFeed and Population (same seed, same
   * genomes) off to the side, then swaps them in. The live layer and the journal are kept; open bots reconcile
   * on the next bar and are marked to livePx right away (liquidation checked).
   * @returns {Promise<{kind:'rewarm'|'hold', bars:number}>}
   */
  async rewarm(reason = 'outage', gapBars = null) {
    if (!this._real) throw new Error('engine.rewarm: only the hyperliquid feed re-warms');
    const t0 = performance.now();
    const g = gapBars ?? this._gapBars(this._now());
    const from = this._market.timeMs + BAR_MS;
    this._catchingUp = true;
    try {
      const fresh = this._makeMarket(undefined);
      const res = await fresh.init();
      if (!res.ok) {
        this._log(`[engine] re-warm failed (${res.reason}) — holding`);
        this._hold(g);
        return { kind: 'hold', bars: 0 };
      }
      const pop = new Population({ seed: this._config.seed, total: this._population.size, coins: fresh.coins });
      const bars = this._config.warmupBars;
      for (let b = 0; b < bars; b++) {
        pop.step(fresh.nextSync());
        if ((b + 1) % REWARM_YIELD_EVERY === 0) await yieldNow();
      }
      this._market = fresh;
      this._population = pop;
      if (this._venueHook) pop.setVenueHook(this._venueHook);
      this._ticks += Math.max(1, g); // the tick counter stays monotonic: one per real minute that passed
      const ms = Math.round(performance.now() - t0);
      this._warmup = { bars, ms };
      const toMs = fresh.timeMs + BAR_MS;
      this._lastGap = { bars: g, mode: 'rewarm', from_ms: from, to_ms: toMs, at_ms: this._now() };
      this._settle();
      this._journal.emit('feed_gap', { from_ms: from, to_ms: toMs, bars: g, mode: 'rewarm', reason });
      this._journal.emit('warmup_finished', { bars, ms });
    } finally {
      this._catchingUp = false;
    }
    this._emitMarks();
    this._checkFeed();
    return { kind: 'rewarm', bars: g };
  }

  /** Stop holding: the gap is filled. */
  _settle() {
    this._lagBars = 0;
    this._holdSinceMs = null;
  }

  /** Hold: no bar for `g` closed minutes (HL unreachable). Retried by the scheduler. */
  _hold(g) {
    this._market.clearStaged();
    this._lagBars = Math.max(1, g);
    if (this._holdSinceMs === null) this._holdSinceMs = this._now();
    this._checkFeed();
  }

  /** After a real tick: refresh day stats / limits once per minute (skipped when over budget). */
  _afterRealTick() {
    this._market.refreshMeta().catch(() => {});
  }

  /** One allMids poll (what the ~5 s timer runs; public for tests): marks + `mids` pulse on success. */
  async pollMids() {
    if (!this._real) return false;
    const ok = await this._market.pollMids();
    if (ok && !this._catchingUp) this._emitMarks();
    this._checkFeed();
    return ok;
  }

  _scheduleMids(delay) {
    const t = this._timers;
    this._midsTimer = t.setTimeout(async () => {
      this._midsTimer = null;
      const t0 = this._now();
      try {
        await this.pollMids();
      } catch (err) {
        this._log(`[engine] mids poll failed: ${err?.stack ?? err}`);
      }
      if (this._running) this._scheduleMids(Math.max(250, MIDS_EVERY_MS - (this._now() - t0)));
    }, delay);
    this._midsTimer?.unref?.();
  }

  /** Sim fallback: is the real feed reachable again? (allMids probe; the UI suggests a restart.) */
  async probeReal() {
    if (!this._hl) return null;
    let ok = false;
    try {
      await this._hl.allMids();
      ok = true;
    } catch {
      ok = false;
    }
    const changed = this._realAvailable !== ok;
    this._realAvailable = ok;
    if (changed && this._started) this._checkFeed(true);
    return ok;
  }

  _scheduleProbe(delay) {
    const t = this._timers;
    this._probeTimer = t.setTimeout(async () => {
      this._probeTimer = null;
      await this.probeReal().catch(() => {});
      if (this._running) this._scheduleProbe(PROBE_EVERY_MS);
    }, delay);
    this._probeTimer?.unref?.();
  }

  // -------------------------------------------------------------------------------------------
  // feed state (GAME-DESIGN §10.5 state rules)

  /** { state: 'live'|'delayed'|'down'|'sim', stale_coins, error } right now. */
  feedState() {
    if (!this._real) return { state: 'sim', stale_coins: [], error: null };
    const now = this._now();
    const st = this._market.status();
    const info = this._market.feedInfo();
    let state;
    if (!(info.last_ok_ms > 0) || now - info.last_ok_ms > DOWN_AFTER_MS) state = 'down';
    else if (info.backoff || !(info.mids_ms > 0) || now - info.mids_ms > LIVE_MAX_AGE_MS || this._lagBars >= 1) state = 'delayed';
    else state = 'live';
    return { state, stale_coins: this._market.staleCoins(), error: st.error };
  }

  /** Journal 'feed_status' when the state or the stale-coin set changed (or `force`). */
  _checkFeed(force = false) {
    const f = this.feedState();
    const staleKey = f.stale_coins.join(',');
    const prev = this._feedSeen;
    if (!force && prev && prev.state === f.state && prev.stale === staleKey) return f;
    this._feedSeen = { state: f.state, stale: staleKey };
    this._journal.emit('feed_status', {
      state: f.state,
      prev: prev?.state ?? null,
      source: this._market.source,
      stale_coins: f.stale_coins,
      lag_bars: this._lagBars,
      error: f.error,
      fallback: this._fallback,
    });
    if (prev && prev.state !== f.state) this._log(`[feed] ${prev.state} → ${f.state}${f.error ? ` (${f.error})` : ''}`);
    return f;
  }

  /**
   * Why new exposure (bot_create / bot_resume) must wait, or null. Real feed only: prices down, a catch-up in
   * progress, or a stale coin (the fill would be at an old price). Pause and close are always allowed.
   */
  canOpen(coin) {
    if (!this._real) return null;
    if (this._catchingUp) return 'catching up on missed minutes — try again in a moment';
    if (this.feedState().state === 'down') return 'prices are down (Hyperliquid unreachable) — new plants and resumes wait for live prices';
    if (coin && this._market.isStale(coin)) return `${coin} price is delayed — this waits for a live price`;
    // The fill would use livePx, which falls back to the last bar close once the mid is > 15 s old: refuse
    // rather than open a paper position at an old price presented as current.
    if (coin && typeof this._market.hasLivePx === 'function' && !this._market.hasLivePx(coin)) {
      return `${coin} price is delayed — this waits for a live price`;
    }
    return null;
  }

  /** Wall time of the next bar: the scheduled timer (real), the nominal close + grace, or (sim) the next interval. */
  nextTickMs() {
    if (!this._real) return this._simTimer && this._lastTickWallMs ? this._lastTickWallMs + this._config.tickMs : null;
    // A pending timer (boundary + grace, or a hold retry); once it has fired, the nominal next close + grace.
    if (this._running && this._nextTickAt > this._now()) return this._nextTickAt;
    return this._market.timeMs + 2 * BAR_MS + TICK_GRACE_MS;
  }

  // -------------------------------------------------------------------------------------------
  // payloads

  health() {
    const m = this._market;
    const now = this._now();
    return {
      ok: this._started,
      version: this._version,
      tick: this._ticks,
      bar_idx: m.barIdx,
      beans: this._population.size,
      now_ms: now,
      market_time_ms: m.barIdx >= 0 ? m.timeMs : null,
      uptime_s: Math.floor((now - this._createdMs) / 1000),
      feed: m.source,
      prices: this.prices,
      paper: true,
      feed_state: this.feedState().state,
      daemon: { running: this.running, tick_ms: this._config.tickMs, aligned: this._real, next_tick_ms: this.nextTickMs() },
    };
  }

  /** status.feed (GAME-DESIGN §10.5): the SPEC fields + real/state/fallback/mids/bar/lag/weight/gap. */
  feedStatus() {
    const m = this._market;
    const now = this._now();
    const info = m.feedInfo();
    const f = this.feedState();
    return {
      ...m.status(),
      real: this._real,
      state: f.state,
      stale_coins: f.stale_coins,
      fallback: this._fallback,
      real_available: this._fallback ? this._realAvailable : null,
      mids_ms: info.mids_ms,
      mids_age_ms: info.mids_ms ? now - info.mids_ms : null,
      last_bar_close_ms: m.barIdx >= 0 ? m.timeMs + BAR_MS : null,
      next_tick_ms: this.nextTickMs(),
      lag_bars: this._lagBars,
      bar_sources: m.barSources,
      weight_60s: info.weight_60s,
      last_gap: this._lastGap,
      requests: info.requests,
    };
  }

  status() {
    return {
      ...this.health(),
      from_snapshot: this._restored,
      last_tick_duration_ms: this._lastTickDurMs,
      last_tick_ms: this._lastTickWallMs,
      feed: this.feedStatus(),
      population: this._population.stats(),
    };
  }

  /** `market` op payload: { market_time_ms, feed_ok, coins: snapshot() + {beans, positioned} }. */
  marketView() {
    const counts = this._population.coinStats();
    const m = this._market;
    return {
      market_time_ms: m.barIdx >= 0 ? m.timeMs : null,
      feed_ok: m.status().ok,
      coins: m.snapshot().map((c) => ({ ...c, ...(counts[c.coin] ?? { beans: 0, positioned: 0 }) })),
    };
  }

  // -------------------------------------------------------------------------------------------
  // persistence

  serialize() {
    const c = this._config;
    return {
      v: 1,
      version: this._version,
      config: { seed: c.seed, beans: this._population.size, feed: c.feed, warmupBars: c.warmupBars, tickMs: c.tickMs, startMs: this._market.startMs },
      tick: this._ticks,
      warmup: this._warmup,
      last_summary: this._lastSummary,
      last_gap: this._lastGap,
      market: this._market.serialize(),
      population: this._population.serialize(),
    };
  }

  /**
   * Restore a serialize() snapshot (call before start(); start() then skips warm-up — and, with real prices,
   * fills the gap since the saved bar). The saved state wins over the constructor config for seed, bean count
   * and market time. A snapshot of the other feed is refused.
   */
  restore(obj) {
    if (!obj || obj.v !== 1 || !obj.market || !obj.population) throw new Error('engine.restore: unsupported state');
    if (this._busy) throw statusError(409, 'cannot restore during a tick');
    this._market.restore(obj.market);
    this._population.restore(obj.population);
    this._ticks = obj.tick | 0;
    this._restoredTick = this._ticks;
    this._warmup = obj.warmup ?? null;
    this._lastSummary = obj.last_summary ?? null;
    this._lastGap = obj.last_gap ?? null;
    this._restored = true;
    return this;
  }
}

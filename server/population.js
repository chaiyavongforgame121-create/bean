// server/population.js — the beans: genomes, isolated-margin paper trading, metrics and queries.
//
// Layout: struct-of-arrays. Every per-bean field is a typed array indexed by bean id (0..N-1), so
// one bar for 3000 beans is a tight loop with no allocations except on fills. Signals come from
// the per-coin `series` tables in strategies.js (O(1) per bean).
//
// Paper execution (SPEC §2.5), per bean, $1000 start:
//   entry (flat, cooldown elapsed, signal ≠ 0, at the bar close):
//     margin = equity × position_size   (capped so margin + open fee ≤ equity; only binds near size 1)
//     notional = margin × leverage, fill = close × (1 ± 1.5bp) against the trader, units = notional / fill
//     fee = 4.5bp × notional, paid from cash.
//   exits, checked each later bar in this order using the bar's h/l:
//     liquidation  adverse move ≥ 0.95/leverage from entry → lose the whole margin (no extra fee)
//     stop         adverse move ≥ stop_loss → fill at the stop (or the open if it gapped through)
//     target       favourable move ≥ take_profit (short: capped at 0.9) → fill at the target (or open)
//     max_hold     bars held ≥ max_hold_bars → close at the close
//     signal       opposite signal once bars held ≥ min_hold_bars → close at the close
//   Every non-liquidation fill pays 1.5bp slippage against the trader and the 4.5bp taker fee.
//   Loss on a trade is floored at −margin and cash at 0 (isolated margin).
//   A closed trade's pnl is net of BOTH fees (so win_rate counts trades that really made money).
//   Re-entry: never on the bar of an exit; afterwards when bars since exit ≥ max(1, cooldown_bars).
//   busted: flat and equity × position_size × leverage < $10 → never trades again (frozen).
//
// Metrics: per-bar equity returns r (marked at the close) feed running Σr, Σr² → sharpe
// (annualised √525600, population sd) and ann_return (mean × 525600). max_dd from the running peak.
// The hourly curve (one point every 60 bars, plus h=0 at birth) is shared-timeline ring storage.

import { makeRng, deriveSeed, typedToB64, b64ToTyped } from './rng.js';
import { COINS, BARS_PER_YEAR, BAR_MS } from './market.js';
import { STRATEGY_NAMES, WINDOW, createSeries, pushClose, recompute, signalIdx, strategyIndex } from './strategies.js';

export const CAPITAL = 1000;
export const TAKER_FEE = 0.00045;   // 4.5 bp of notional per fill
export const SPREAD = 0.0001;       // 1 bp
export const IMPACT = 0.00005;      // 0.5 bp
export const SLIPPAGE = SPREAD + IMPACT;
export const LIQ_FRACTION = 0.95;   // liquidation at an adverse move of 0.95 / leverage
export const SHORT_TP_CAP = 0.9;
export const MIN_ORDER_USD = 10;
export const BARS_PER_HOUR = 60;
export const CURVE_KEEP = 336;      // hourly points (14 days)
export const TRADES_KEEP = 50;      // trades remembered per bean for bean_detail
export const EXIT_REASONS = Object.freeze(['liquidation', 'stop', 'target', 'max_hold', 'signal']);

const R_LIQ = 0, R_STOP = 1, R_TARGET = 2, R_MAXHOLD = 3, R_SIGNAL = 4;
const ANN = Math.sqrt(BARS_PER_YEAR);
const NEVER = -1_000_000_000; // "no exit yet" sentinel for lastExit

// ---------------------------------------------------------------------------------------------
// Archetypes (SPEC §2.3)

const CLASSIC = Object.freeze(['momentum', 'mean_reversion', 'breakout']);
const COMMON_BOUNDS = Object.freeze({
  lookback: Object.freeze([2, 60]),
  entry_threshold: Object.freeze([0.1, 3]),
  cooldown_bars: Object.freeze([0, 48]),
  min_hold_bars: Object.freeze([0, 96]),
  max_hold_bars: Object.freeze([60, 4320]),
});
const FAMILY_LIMITS = {
  standard: { max_drawdown: 0.30, ruin_floor: 0.5 },
  hyper: { max_drawdown: 0.60, ruin_floor: 0.25 },
  degen: { max_drawdown: 0.85, ruin_floor: 0.10 },
  swarm: { max_drawdown: 0.30, ruin_floor: 0.5 },
};
const FITNESS_TEXT = { sharpe: 'sharpe - max_dd', return: 'ann_return - max_dd', return_dd2: 'ann_return - max_dd/2' };

function archetype(name, family, leverage, position_size, stop_loss, take_profit, scale, count) {
  return Object.freeze({
    name,
    family,
    mode: 'algo',
    scale,
    fitness: FITNESS_TEXT[scale],
    leverage: Object.freeze(leverage),
    position_size: Object.freeze(position_size),
    stop_loss: Object.freeze(stop_loss),
    take_profit: Object.freeze(take_profit),
    ...COMMON_BOUNDS,
    strategies: family === 'swarm' ? STRATEGY_NAMES : CLASSIC,
    count,
    ...FAMILY_LIMITS[family],
  });
}

const SW = [[0.05, 0.35], [0.01, 0.2], [0.01, 0.4]]; // swarm position_size, stop_loss, take_profit

export const ARCHETYPES = Object.freeze([
  archetype('standard', 'standard', [1, 1], [0.05, 1.0], [0.01, 0.2], [0.01, 0.4], 'sharpe', 400),
  archetype('hyper_algo', 'hyper', [2, 10], [0.25, 1.0], [0.02, 0.5], [0.05, 1.5], 'return', 400),
  archetype('degen_algo', 'degen', [10, 25], [0.5, 1.0], [0.02, 0.5], [0.1, 3.0], 'return_dd2', 400),
  archetype('swarm', 'swarm', [1, 1], ...SW, 'sharpe', 300),
  archetype('swarm_5x', 'swarm', [5, 5], ...SW, 'sharpe', 300),
  archetype('swarm_10x', 'swarm', [10, 10], ...SW, 'sharpe', 300),
  archetype('swarm_25x', 'swarm', [25, 25], ...SW, 'sharpe', 300),
  archetype('swarm_50x', 'swarm', [50, 50], ...SW, 'sharpe', 300),
  archetype('swarm_100x', 'swarm', [100, 100], ...SW, 'sharpe', 300),
]);
const ARCH_INDEX = new Map(ARCHETYPES.map((a, i) => [a.name, i]));
const DEFAULT_TOTAL = ARCHETYPES.reduce((s, a) => s + a.count, 0); // 3000

/**
 * Scale the default archetype counts to `total` beans (largest-remainder rounding, ties in
 * table order) so the counts always sum to exactly `total`.
 */
export function scaleCounts(total) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  const exact = ARCHETYPES.map((a) => (a.count * n) / DEFAULT_TOTAL);
  const counts = exact.map(Math.floor);
  let left = n - counts.reduce((s, c) => s + c, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((p, q) => q[0] - p[0] || p[1] - q[1]);
  for (let j = 0; left > 0; j = (j + 1) % order.length, left--) counts[order[j][1]]++;
  return counts;
}

// ---------------------------------------------------------------------------------------------
// Per-bean storage descriptors (drive allocation and (de)serialisation)

const GENOME_FIELDS = [
  ['arch', Uint8Array], ['coin', Uint8Array], ['strat', Uint8Array],
  ['lev', Float64Array], ['ps', Float64Array], ['sl', Float64Array], ['tp', Float64Array], ['thr', Float64Array],
  ['lookback', Uint8Array], ['cooldown', Uint16Array], ['minHold', Uint16Array], ['maxHold', Uint16Array],
];
const STATE_FIELDS = [
  ['cash', Float64Array], ['equity', Float64Array], ['side', Int8Array], ['units', Float64Array],
  ['entry', Float64Array], ['margin', Float64Array], ['openFee', Float64Array], ['opened', Int32Array],
  ['lastExit', Int32Array], ['stopPx', Float64Array], ['targetPx', Float64Array], ['liqPx', Float64Array],
  ['busted', Uint8Array], ['fills', Uint32Array], ['closedN', Uint32Array], ['wins', Uint32Array],
  ['peak', Float64Array], ['maxDD', Float64Array], ['rSum', Float64Array], ['rSq', Float64Array],
  ['rN', Uint32Array], ['fees', Float64Array], ['volume', Float64Array],
  ['tCount', Uint8Array], ['tHead', Uint8Array],
];
// Trade log ring, TRADES_KEEP slots per bean (display only → float32 payload keeps snapshots small).
// tCode packs action (bit 0: 0 open / 1 close), side (bit 1: long) and reason (bits 2+).
const TRADE_FIELDS = [
  ['tBar', Int32Array], ['tCode', Uint8Array], ['tPx', Float32Array], ['tUnits', Float32Array], ['tPnl', Float32Array],
];
/** Display rounding for float32-stored values (7 significant digits ≈ float32 precision). */
const f32 = (x) => (x === 0 || !Number.isFinite(x) ? x : Number(x.toPrecision(7)));

const round4 = (x) => Math.round(x * 1e4) / 1e4;

/** Error carrying an HTTP-ish status (the API layer maps `.status`). */
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// ---------------------------------------------------------------------------------------------

export class Population {
  /**
   * @param {object} opts
   * @param {number} [opts.seed=42]
   * @param {number} [opts.total=3000] beans; default archetype counts are scaled proportionally
   * @param {Array}  [opts.coins=COINS] venue listing (must match the MarketFeed's)
   * @param {Array}  [opts.genomes] explicit genomes (tests / hand-built scenarios): each
   *   `{archetype, coin?, strategy?, leverage?, position_size?, stop_loss?, take_profit?, lookback?,
   *   entry_threshold?, cooldown_bars?, min_hold_bars?, max_hold_bars?}`; missing fields are drawn
   *   at random within the archetype bounds. Overrides `total`.
   */
  constructor({ seed = 42, total = 3000, coins = COINS, genomes = null } = {}) {
    this._seed = seed >>> 0;
    this._coins = coins;
    this._names = coins.map((c) => c.coin);
    this._coinIndex = new Map(this._names.map((n, i) => [n, i]));
    if (this._names.length > 255) throw new Error('population: at most 255 coins');
    this._venueHook = null;

    const plan = genomes
      ? genomes.map((g) => {
        const ai = ARCH_INDEX.get(g?.archetype);
        if (ai === undefined) throw new Error(`population: unknown archetype '${g?.archetype}'`);
        return ai;
      })
      : scaleCounts(total).flatMap((count, ai) => new Array(count).fill(ai));
    this._alloc(plan.length);
    this._generate(plan, genomes);
    this._initState();
  }

  get size() { return this._n; }

  /** fn(row) → { tradeable, venue_max_leverage, venue_reason, bot }; set by main from LiveLayer. */
  setVenueHook(fn) {
    this._venueHook = typeof fn === 'function' ? fn : null;
  }

  // -------------------------------------------------------------------------------------------
  // construction

  _alloc(n) {
    this._n = n;
    for (const [name, Ctor] of GENOME_FIELDS) this[`_${name}`] = new Ctor(n);
    for (const [name, Ctor] of STATE_FIELDS) this[`_${name}`] = new Ctor(n);
    // hourly curve (display/ret windows only → float32); all beans share one timeline
    this._curve = new Float32Array(n * CURVE_KEEP);
    for (const [name, Ctor] of TRADE_FIELDS) this[`_${name}`] = new Ctor(n * TRADES_KEEP);
    const K = this._names.length;
    this._series = this._names.map(() => createSeries());
    this._has = new Uint8Array(K);
    this._o = new Float64Array(K);
    this._h = new Float64Array(K);
    this._l = new Float64Array(K);
    this._c = new Float64Array(K);
  }

  _generate(plan, overrides) {
    const rng = makeRng(deriveSeed(this._seed, 'population'));
    const K = this._names.length;
    for (let i = 0; i < plan.length; i++) {
      const a = ARCHETYPES[plan[i]];
      // Fixed draw order — changing it changes every genome for a given seed.
      const g = {
        strategy: rng.pick(a.strategies),
        coin: this._names[rng.int(0, K - 1)],
        leverage: rng.int(a.leverage[0], a.leverage[1]),
        position_size: round4(rng.range(a.position_size[0], a.position_size[1])),
        stop_loss: round4(rng.range(a.stop_loss[0], a.stop_loss[1])),
        take_profit: round4(rng.range(a.take_profit[0], a.take_profit[1])),
        lookback: rng.int(a.lookback[0], a.lookback[1]),
        entry_threshold: round4(rng.range(a.entry_threshold[0], a.entry_threshold[1])),
        cooldown_bars: rng.int(a.cooldown_bars[0], a.cooldown_bars[1]),
        min_hold_bars: rng.int(a.min_hold_bars[0], a.min_hold_bars[1]),
        max_hold_bars: rng.int(a.max_hold_bars[0], a.max_hold_bars[1]),
      };
      if (overrides) {
        for (const key of Object.keys(g)) if (overrides[i][key] !== undefined) g[key] = overrides[i][key];
      }
      const ci = this._coinIndex.get(g.coin);
      const si = strategyIndex(g.strategy);
      if (ci === undefined) throw new Error(`population: unknown coin '${g.coin}'`);
      if (si < 0) throw new Error(`population: unknown strategy '${g.strategy}'`);
      this._arch[i] = plan[i];
      this._coin[i] = ci;
      this._strat[i] = si;
      this._lev[i] = Math.max(1, Number(g.leverage));
      this._ps[i] = Number(g.position_size);
      this._sl[i] = Number(g.stop_loss);
      this._tp[i] = Number(g.take_profit);
      this._thr[i] = Number(g.entry_threshold);
      this._lookback[i] = Math.min(60, Math.max(2, g.lookback | 0));
      this._cooldown[i] = g.cooldown_bars | 0;
      this._minHold[i] = g.min_hold_bars | 0;
      this._maxHold[i] = Math.max(1, g.max_hold_bars | 0);
    }
  }

  _initState() {
    this._cash.fill(CAPITAL);
    this._equity.fill(CAPITAL);
    this._peak.fill(CAPITAL);
    this._lastExit.fill(NEVER);
    // hourly curve starts with {h: 0, equity: 1000}
    for (let i = 0; i < this._n; i++) this._curve[i * CURVE_KEEP] = CAPITAL;
    this._curveCount = 1;
    this._curveHead = 1 % CURVE_KEEP;
    this._curveLastH = 0;
    this._lastBar = -1;
    this._lastTimeMs = null;
    this._timeBase = null; // market time of bar 0 (learned from the first frame) → trade time_ms
  }

  // -------------------------------------------------------------------------------------------
  // simulation

  /**
   * Paper-trade every bean one bar.
   * @param {{barIdx:number, timeMs:number, bars:Object<string,{o,h,l,c}>}} frame (`market` is accepted and ignored)
   * @returns {{fills:number, exits:{liquidation:number,stop:number,target:number,max_hold:number,signal:number}, busted:number[]}}
   */
  step({ barIdx, timeMs, bars }) {
    const K = this._names.length;
    if (this._timeBase === null && Number.isFinite(timeMs)) this._timeBase = timeMs - barIdx * BAR_MS;
    const has = this._has, O = this._o, H = this._h, Lw = this._l, C = this._c, series = this._series;
    for (let k = 0; k < K; k++) {
      const b = bars ? bars[this._names[k]] : undefined;
      if (b && b.c > 0) {
        const c = b.c;
        const o = b.o > 0 ? b.o : c;
        has[k] = 1;
        O[k] = o;
        H[k] = Math.max(b.h > 0 ? b.h : c, o, c);
        Lw[k] = Math.min(b.l > 0 ? b.l : c, o, c);
        C[k] = c;
        pushClose(series[k], c);
      } else {
        has[k] = 0; // no data for this coin this bar: its beans sit the bar out
      }
    }

    const n = this._n;
    const busted = this._busted, coin = this._coin, side = this._side, cash = this._cash, units = this._units;
    const entry = this._entry, equity = this._equity, peak = this._peak, maxDD = this._maxDD;
    const rSum = this._rSum, rSq = this._rSq, rN = this._rN, ps = this._ps, lev = this._lev;
    const strat = this._strat, lookback = this._lookback, thr = this._thr, opened = this._opened;
    const maxHold = this._maxHold, minHold = this._minHold, lastExit = this._lastExit, cooldown = this._cooldown;
    const liqPx = this._liqPx, stopPx = this._stopPx, targetPx = this._targetPx;
    const exits = [0, 0, 0, 0, 0];
    const newlyBusted = [];
    let fills = 0;

    for (let i = 0; i < n; i++) {
      if (busted[i] === 1) continue;
      const k = coin[i];
      if (has[k] === 0) continue;
      const c = C[k];
      let s = side[i];

      if (s !== 0) {
        // ---- in position: intrabar exits first (liquidation → stop → target)
        const o = O[k], h = H[k], l = Lw[k];
        let reason = -1, px = 0;
        if (s > 0) {
          if (l <= liqPx[i]) { reason = R_LIQ; px = liqPx[i]; }
          else if (l <= stopPx[i]) { reason = R_STOP; px = Math.min(stopPx[i], o) * (1 - SLIPPAGE); }
          else if (h >= targetPx[i]) { reason = R_TARGET; px = Math.max(targetPx[i], o) * (1 - SLIPPAGE); }
        } else {
          if (h >= liqPx[i]) { reason = R_LIQ; px = liqPx[i]; }
          else if (h >= stopPx[i]) { reason = R_STOP; px = Math.max(stopPx[i], o) * (1 + SLIPPAGE); }
          else if (l <= targetPx[i]) { reason = R_TARGET; px = Math.min(targetPx[i], o) * (1 + SLIPPAGE); }
        }
        if (reason < 0) {
          // ---- then close-of-bar exits (max hold → signal flip)
          const held = barIdx - opened[i];
          if (held >= maxHold[i]) {
            reason = R_MAXHOLD; px = c * (1 - s * SLIPPAGE);
          } else if (held >= minHold[i] && signalIdx(strat[i], series[k], lookback[i], thr[i]) === -s) {
            reason = R_SIGNAL; px = c * (1 - s * SLIPPAGE);
          }
        }
        if (reason >= 0) {
          this._close(i, px, reason, barIdx, timeMs);
          exits[reason]++;
          fills++;
          s = 0;
        }
      } else if (barIdx - lastExit[i] >= (cooldown[i] > 1 ? cooldown[i] : 1)) {
        // ---- flat: entry on the close if the signal fires
        const sig = signalIdx(strat[i], series[k], lookback[i], thr[i]);
        if (sig !== 0 && this._open(i, sig, c, barIdx, timeMs)) {
          fills++;
          s = sig;
        }
      }

      // ---- mark to market at the close, update return stats and drawdown
      const eq = s === 0 ? cash[i] : cash[i] + s * units[i] * (c - entry[i]);
      const prev = equity[i];
      const r = prev > 0 ? eq / prev - 1 : 0;
      rSum[i] += r;
      rSq[i] += r * r;
      rN[i]++;
      equity[i] = eq;
      if (eq > peak[i]) peak[i] = eq;
      else if (peak[i] > 0) {
        const dd = 1 - eq / peak[i];
        if (dd > maxDD[i]) maxDD[i] = dd;
      }

      // ---- the only death: flat and cannot open a $10 order any more
      if (s === 0 && eq * ps[i] * lev[i] < MIN_ORDER_USD) {
        busted[i] = 1;
        newlyBusted.push(i);
      }
    }

    if ((barIdx + 1) % BARS_PER_HOUR === 0) this._recordCurve((barIdx + 1) / BARS_PER_HOUR);
    this._lastBar = barIdx;
    this._lastTimeMs = timeMs;
    return {
      fills,
      exits: { liquidation: exits[0], stop: exits[1], target: exits[2], max_hold: exits[3], signal: exits[4] },
      busted: newlyBusted,
    };
  }

  /** Open a position at `close` (side ±1). Returns false if the order would be under $10. */
  _open(i, sd, close, bar, timeMs) {
    const eq = this._cash[i];
    const L = this._lev[i];
    let margin = eq * this._ps[i];
    const cap = eq / (1 + L * TAKER_FEE); // margin + open fee must fit in equity
    if (margin > cap) margin = cap;
    const notional = margin * L;
    if (notional < MIN_ORDER_USD) return false;
    const px = close * (1 + sd * SLIPPAGE);
    const units = notional / px;
    const fee = notional * TAKER_FEE;
    this._cash[i] = eq - fee;
    this._side[i] = sd;
    this._units[i] = units;
    this._entry[i] = px;
    this._margin[i] = margin;
    this._openFee[i] = fee;
    this._opened[i] = bar;
    const liqMove = LIQ_FRACTION / L;
    if (sd > 0) {
      this._liqPx[i] = px * (1 - liqMove);
      this._stopPx[i] = px * (1 - this._sl[i]);
      this._targetPx[i] = px * (1 + this._tp[i]);
    } else {
      this._liqPx[i] = px * (1 + liqMove);
      this._stopPx[i] = px * (1 + this._sl[i]);
      this._targetPx[i] = px * (1 - Math.min(this._tp[i], SHORT_TP_CAP));
    }
    this._fills[i]++;
    this._fees[i] += fee;
    this._volume[i] += notional;
    this._logTrade(i, bar, timeMs, 0, sd, px, units, 0, R_SIGNAL);
    return true;
  }

  /** Close the open position at `px` for `reason`. */
  _close(i, px, reason, bar, timeMs) {
    const s = this._side[i];
    const units = this._units[i];
    const margin = this._margin[i];
    let pnl, fee;
    if (reason === R_LIQ) {
      pnl = -margin; // isolated margin: the whole margin is gone, nothing more
      fee = 0;
    } else {
      pnl = s * units * (px - this._entry[i]);
      if (pnl < -margin) pnl = -margin;
      fee = units * px * TAKER_FEE;
    }
    const cash = this._cash[i] + pnl - fee;
    this._cash[i] = cash > 0 ? cash : 0;
    const net = pnl - fee - this._openFee[i];
    this._closedN[i]++;
    if (net > 0) this._wins[i]++;
    this._fills[i]++;
    this._fees[i] += fee;
    this._volume[i] += units * px;
    this._side[i] = 0;
    this._units[i] = 0;
    this._entry[i] = 0;
    this._margin[i] = 0;
    this._openFee[i] = 0;
    this._liqPx[i] = 0;
    this._stopPx[i] = 0;
    this._targetPx[i] = 0;
    this._lastExit[i] = bar;
    this._logTrade(i, bar, timeMs, 1, s, px, units, net, reason);
  }

  /** Remember a trade in the bean's ring (no allocation). */
  _logTrade(i, bar, timeMs, action, sd, px, units, pnl, reason) {
    const head = this._tHead[i];
    const slot = i * TRADES_KEEP + head;
    this._tBar[slot] = bar;
    this._tCode[slot] = action | (sd > 0 ? 2 : 0) | (reason << 2);
    this._tPx[slot] = px;
    this._tUnits[slot] = units;
    this._tPnl[slot] = pnl;
    this._tHead[i] = (head + 1) % TRADES_KEEP;
    if (this._tCount[i] < TRADES_KEEP) this._tCount[i]++;
  }

  /** Trades of bean i, newest first. */
  _tradesOf(i) {
    const out = [];
    for (let j = 0; j < this._tCount[i]; j++) {
      const slot = i * TRADES_KEEP + ((this._tHead[i] - 1 - j + TRADES_KEEP) % TRADES_KEEP);
      const code = this._tCode[slot];
      const bar = this._tBar[slot];
      out.push({
        bar,
        time_ms: this._timeBase === null ? null : this._timeBase + bar * BAR_MS,
        action: (code & 1) === 0 ? 'open' : 'close',
        side: (code & 2) !== 0 ? 'long' : 'short',
        px: f32(this._tPx[slot]),
        units: f32(this._tUnits[slot]),
        pnl: f32(this._tPnl[slot]),
        reason: EXIT_REASONS[code >> 2],
      });
    }
    return out;
  }

  _recordCurve(h) {
    const head = this._curveHead;
    const eq = this._equity;
    for (let i = 0; i < this._n; i++) this._curve[i * CURVE_KEEP + head] = eq[i];
    this._curveHead = (head + 1) % CURVE_KEEP;
    if (this._curveCount < CURVE_KEEP) this._curveCount++;
    this._curveLastH = h;
  }

  /** Equity of curve point j (0 = oldest kept). */
  _curveAt(i, j) {
    const slot = (this._curveHead - this._curveCount + j + CURVE_KEEP) % CURVE_KEEP;
    return this._curve[i * CURVE_KEEP + slot];
  }

  // -------------------------------------------------------------------------------------------
  // read side

  _index(id) {
    const i = typeof id === 'number' ? id : Number(id);
    return Number.isInteger(i) && i >= 0 && i < this._n ? i : -1;
  }

  /** Return vs the hourly curve `back` points before the latest one (or the oldest kept). */
  _retBack(i, back) {
    const j = this._curveCount - 1 - back;
    const ref = this._curveAt(i, j >= 0 ? j : 0);
    // compare at the curve's float32 precision so an unchanged equity gives exactly 0
    return ref > 0 ? Math.fround(this._equity[i]) / ref - 1 : 0;
  }

  _metrics(i) {
    const n = this._rN[i];
    const mean = n > 0 ? this._rSum[i] / n : 0;
    const variance = n > 0 ? this._rSq[i] / n - mean * mean : 0;
    const sd = variance > 0 ? Math.sqrt(variance) : 0;
    const sharpe = sd > 1e-12 ? (mean / sd) * ANN : 0;
    const annReturn = mean * BARS_PER_YEAR;
    const maxDd = this._maxDD[i];
    const scale = ARCHETYPES[this._arch[i]].scale;
    const fitness = scale === 'sharpe' ? sharpe - maxDd
      : scale === 'return' ? annReturn - maxDd
        : annReturn - maxDd / 2;
    return { sharpe, annReturn, maxDd, fitness };
  }

  /** Light identity for events: {id, archetype, coin, equity} or null. */
  brief(id) {
    const i = this._index(id);
    if (i < 0) return null;
    return { id: i, archetype: ARCHETYPES[this._arch[i]].name, coin: this._names[this._coin[i]], equity: this._equity[i] };
  }

  /**
   * BeanRow (SPEC §4) or null. Venue fields come from `venue` when given (a per-player verdict function,
   * PLATFORM §7.4: gardens.venueFor(uid)), else from the installed venue hook (or a no-bots default).
   */
  row(id, venue = null) {
    const i = this._index(id);
    if (i < 0) return null;
    const a = ARCHETYPES[this._arch[i]];
    const eq = this._equity[i];
    const m = this._metrics(i);
    const s = this._side[i];
    const closed = this._closedN[i];
    const row = {
      id: i,
      archetype: a.name,
      family: a.family,
      mode: 'algo',
      strategy: STRATEGY_NAMES[this._strat[i]],
      coin: this._names[this._coin[i]],
      leverage: this._lev[i],
      position_size: this._ps[i],
      lookback: this._lookback[i],
      entry_threshold: this._thr[i],
      stop_loss: this._sl[i],
      take_profit: this._tp[i],
      cooldown_bars: this._cooldown[i],
      min_hold_bars: this._minHold[i],
      max_hold_bars: this._maxHold[i],
      equity: eq,
      total_return: eq / CAPITAL - 1,
      ret_1h: this._retBack(i, 1),
      ret_1d: this._retBack(i, 24),
      ret_7d: this._retBack(i, 168),
      sharpe: m.sharpe,
      max_dd: m.maxDd,
      trades: this._fills[i],
      win_rate: closed > 0 ? this._wins[i] / closed : 0,
      fitness: m.fitness,
      busted: this._busted[i] === 1,
      breached: (m.maxDd >= a.max_drawdown ? 1 : 0) | (eq <= a.ruin_floor * CAPITAL ? 2 : 0),
      in_position: s > 0 ? 'long' : s < 0 ? 'short' : 'flat',
      side: s,
      units: s * this._units[i],
      entry_px: s !== 0 ? this._entry[i] : null,
      tradeable: false,
      venue_max_leverage: null,
      venue_reason: null,
      bot: null,
    };
    const hook = typeof venue === 'function' ? venue : this._venueHook;
    const verdict = hook ? hook(row) : this._defaultVenue(row);
    if (verdict) {
      row.tradeable = !!verdict.tradeable;
      row.venue_max_leverage = verdict.venue_max_leverage ?? null;
      row.venue_reason = verdict.venue_reason ?? null;
      row.bot = verdict.bot ?? null;
    }
    return row;
  }

  /** Venue verdict when no live layer is attached (no bots, so nothing is bound). */
  _defaultVenue(row) {
    const ci = this._coinIndex.get(row.coin);
    if (ci === undefined) return { tradeable: false, venue_max_leverage: null, venue_reason: 'unlisted', bot: null };
    const max = this._coins[ci].max_leverage;
    let reason = null;
    if (row.busted) reason = 'busted';
    else if ((row.position_size * row.leverage * row.equity) / CAPITAL > max) reason = 'leverage';
    return { tradeable: reason === null, venue_max_leverage: max, venue_reason: reason, bot: null };
  }

  /**
   * `beans` op. Filters AND together, then sort, then (optionally) one-best-per-coin, then page.
   * Accepts already-coerced params or raw strings (booleans: 1|true|yes|on / 0|false|no|off,
   * ids: array, CSV or JSON array).
   */
  query(params = {}, { venue = null } = {}) {
    const p = normalizeQuery(params);
    const archIdx = p.archetype === undefined ? -1 : (ARCH_INDEX.get(p.archetype) ?? -2);
    const coinIdx = p.coin === undefined ? -1 : (this._coinIndex.get(p.coin) ?? -2);
    const stratIdx = p.strategy === undefined ? -1 : strategyIndex(p.strategy) >= 0 ? strategyIndex(p.strategy) : -2;
    const candidates = p.ids ?? null;

    const rows = [];
    const consider = (i) => {
      if (archIdx !== -1 && this._arch[i] !== archIdx) return;
      if (coinIdx !== -1 && this._coin[i] !== coinIdx) return;
      if (stratIdx !== -1 && this._strat[i] !== stratIdx) return;
      if (p.busted !== undefined && (this._busted[i] === 1) !== p.busted) return;
      if (p.in_position !== undefined && (this._side[i] !== 0) !== p.in_position) return;
      if (p.trades_min !== undefined && this._fills[i] < p.trades_min) return;
      const row = this.row(i, venue);
      if (p.tradeable !== undefined && row.tradeable !== p.tradeable) return;
      rows.push(row);
    };
    if (candidates) {
      const seen = new Set();
      for (const id of candidates) {
        const i = this._index(id);
        if (i >= 0 && !seen.has(i)) { seen.add(i); consider(i); }
      }
    } else {
      for (let i = 0; i < this._n; i++) consider(i);
    }

    const { key, dir } = p.sort;
    rows.sort((x, y) => {
      const a = x[key], b = y[key];
      if (a !== b) return a < b ? -dir : dir;
      return x.id - y.id;
    });
    let list = rows;
    if (p.distinct_coin) {
      const seenCoin = new Set();
      list = rows.filter((r) => (seenCoin.has(r.coin) ? false : (seenCoin.add(r.coin), true)));
    }
    return {
      rows: list.slice(p.offset, p.offset + p.limit),
      total: list.length,
      limit: p.limit,
      offset: p.offset,
      sort: p.sortText,
      venue: { known: true, network: 'sim' },
    };
  }

  /** `bean_detail` payload or null. `venue`: optional per-player verdict function (see row()). */
  detail(id, { venue = null } = {}) {
    const i = this._index(id);
    if (i < 0) return null;
    return {
      bean: this.row(i, venue),
      genome: this._genome(i),
      describe: this._describe(i),
      curve: this._curveOf(i),
      trades: this._tradesOf(i),
    };
  }

  _genome(i) {
    const a = ARCHETYPES[this._arch[i]];
    return {
      archetype: a.name,
      family: a.family,
      mode: 'algo',
      strategy: STRATEGY_NAMES[this._strat[i]],
      coin: this._names[this._coin[i]],
      leverage: this._lev[i],
      position_size: this._ps[i],
      lookback: this._lookback[i],
      entry_threshold: this._thr[i],
      stop_loss: this._sl[i],
      take_profit: this._tp[i],
      cooldown_bars: this._cooldown[i],
      min_hold_bars: this._minHold[i],
      max_hold_bars: this._maxHold[i],
    };
  }

  _describe(i) {
    const g = this._genome(i);
    return `[${g.archetype} algo ${g.leverage}x] ${g.strategy}@${g.coin} lb=${g.lookback} thr=${g.entry_threshold.toFixed(2)}`
      + ` size=${g.position_size.toFixed(2)} sl=${g.stop_loss.toFixed(3)} tp=${g.take_profit.toFixed(3)}`
      + ` hold=${g.cooldown_bars}/${g.min_hold_bars}/${g.max_hold_bars}`;
  }

  _curveOf(i) {
    const out = new Array(this._curveCount);
    const firstH = this._curveLastH - (this._curveCount - 1);
    for (let j = 0; j < this._curveCount; j++) out[j] = { h: firstH + j, equity: f32(this._curveAt(i, j)) };
    return out;
  }

  /** `equity_curves` core: { [id]: [{h, equity}] } for up to 50 valid ids (others are skipped). */
  curves(ids) {
    const out = {};
    const list = toIdList(ids) ?? [];
    for (const id of list.slice(0, 50)) {
      const i = this._index(id);
      if (i >= 0) out[String(i)] = this._curveOf(i);
    }
    return out;
  }

  stats() {
    const by = ARCHETYPES.map((a) => ({
      archetype: a.name, count: 0, busted: 0, positioned: 0, traded: 0, best_return: null, mean_return: null, _sum: 0,
    }));
    for (let i = 0; i < this._n; i++) {
      const r = by[this._arch[i]];
      const ret = this._equity[i] / CAPITAL - 1;
      r.count++;
      r.busted += this._busted[i];
      if (this._side[i] !== 0) r.positioned++;
      if (this._fills[i] > 0) r.traded++;
      if (r.best_return === null || ret > r.best_return) r.best_return = ret;
      r._sum += ret;
    }
    for (const r of by) {
      r.mean_return = r.count > 0 ? r._sum / r.count : null;
      delete r._sum;
    }
    return { beans: this._n, by_archetype: by };
  }

  /** Per-coin counts for the `market` op: { [coin]: { beans, positioned } }. */
  coinStats() {
    const out = {};
    for (const name of this._names) out[name] = { beans: 0, positioned: 0 };
    for (let i = 0; i < this._n; i++) {
      const r = out[this._names[this._coin[i]]];
      r.beans++;
      if (this._side[i] !== 0) r.positioned++;
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // persistence

  serialize() {
    const enc = (fields) => Object.fromEntries(fields.map(([name]) => [name, typedToB64(this[`_${name}`])]));
    const curve = new Float32Array(this._n * this._curveCount);
    for (let i = 0; i < this._n; i++) {
      for (let j = 0; j < this._curveCount; j++) curve[i * this._curveCount + j] = this._curveAt(i, j);
    }
    return {
      v: 1,
      seed: this._seed,
      size: this._n,
      coins: this._names.slice(),
      genome: enc(GENOME_FIELDS),
      state: enc(STATE_FIELDS),
      curve: { count: this._curveCount, last_h: this._curveLastH, data: typedToB64(curve) },
      series: this._series.map((s) => ({ n: s.n, head: s.head, win: Array.from(s.win) })),
      trades: enc(TRADE_FIELDS),
      time_base: this._timeBase,
      last_bar: this._lastBar,
      last_time_ms: this._lastTimeMs,
    };
  }

  restore(obj) {
    if (!obj || obj.v !== 1) throw new Error('population.restore: unsupported state');
    if (!Array.isArray(obj.coins) || obj.coins.join(',') !== this._names.join(',')) {
      throw new Error('population.restore: coin listing differs from the saved state');
    }
    const n = obj.size | 0;
    this._alloc(n);
    for (const [name, Ctor] of GENOME_FIELDS) this[`_${name}`] = b64ToTyped(obj.genome[name], Ctor, n);
    for (const [name, Ctor] of STATE_FIELDS) this[`_${name}`] = b64ToTyped(obj.state[name], Ctor, n);
    this._seed = obj.seed >>> 0;

    const count = obj.curve.count | 0;
    const data = b64ToTyped(obj.curve.data, Float32Array, n * count);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < count; j++) this._curve[i * CURVE_KEEP + j] = data[i * count + j];
    }
    this._curveCount = count;
    this._curveHead = count % CURVE_KEEP;
    this._curveLastH = obj.curve.last_h;

    obj.series.forEach((saved, k) => {
      const s = this._series[k];
      s.win.set(saved.win);
      s.head = saved.head;
      s.n = saved.n;
      s.ready = s.n >= WINDOW;
      if (s.ready) recompute(s);
      else if (s.n > 0) s.close = s.win[(s.head - 1 + WINDOW) % WINDOW];
    });
    for (const [name, Ctor] of TRADE_FIELDS) this[`_${name}`] = b64ToTyped(obj.trades[name], Ctor, n * TRADES_KEEP);
    this._timeBase = obj.time_base ?? null;
    this._lastBar = obj.last_bar;
    this._lastTimeMs = obj.last_time_ms;
    return this;
  }
}

// ---------------------------------------------------------------------------------------------
// query parameter normalisation (tolerant: the API layer usually coerces already)

const SORT_KEYS = new Set(['fitness', 'total_return', 'ret_7d', 'ret_1d', 'ret_1h', 'sharpe', 'trades', 'equity', 'max_dd', 'id']);

function toBool(v, name) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw badRequest(`${name}: expected a boolean`);
}

function toInt(v, name, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isInteger(n)) throw badRequest(`${name}: expected an integer`);
  return n;
}

/** ids from an array, a CSV string or a JSON array string → integer array (or undefined). */
function toIdList(v) {
  if (v === undefined || v === null || v === '') return undefined;
  let list = v;
  if (typeof v === 'string') {
    const s = v.trim();
    try {
      list = s.startsWith('[') ? JSON.parse(s) : s.split(',');
    } catch {
      throw badRequest('ids: expected a list of integers');
    }
  } else if (typeof v === 'number') {
    list = [v];
  }
  if (!Array.isArray(list)) throw badRequest('ids: expected a list of integers');
  return list.map((x) => {
    const n = typeof x === 'number' ? x : Number(String(x).trim());
    if (!Number.isInteger(n)) throw badRequest('ids: expected a list of integers');
    return n;
  });
}

function normalizeQuery(params) {
  const sortText = params.sort === undefined || params.sort === null || params.sort === '' ? '-fitness' : String(params.sort).trim();
  const desc = sortText.startsWith('-');
  const key = sortText.replace(/^[-+]/, '');
  if (!SORT_KEYS.has(key)) throw badRequest(`sort: unknown column '${key}'`);
  const str = (v) => (v === undefined || v === null || v === '' ? undefined : String(v).trim());
  const coin = str(params.coin);
  return {
    archetype: str(params.archetype),
    coin: coin === undefined ? undefined : coin.toUpperCase(),
    strategy: str(params.strategy),
    busted: toBool(params.busted, 'busted'),
    in_position: toBool(params.in_position, 'in_position'),
    tradeable: toBool(params.tradeable, 'tradeable'),
    distinct_coin: toBool(params.distinct_coin, 'distinct_coin') === true,
    trades_min: toInt(params.trades_min, 'trades_min', undefined),
    ids: toIdList(params.ids),
    sort: { key, dir: desc ? -1 : 1 },
    sortText: desc ? `-${key}` : key,
    limit: Math.min(1000, Math.max(0, toInt(params.limit, 'limit', 100))),
    offset: Math.max(0, toInt(params.offset, 'offset', 0)),
  };
}

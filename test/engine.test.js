// test/engine.test.js — rng, market, strategies, population (paper execution + queries) and engine.
// Offline only: everything runs on the deterministic synthetic feed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { makeRng, deriveSeed, typedToB64, b64ToTyped } from '../server/rng.js';
import { COINS, MarketFeed, HISTORY_KEEP, BAR_MS } from '../server/market.js';
import {
  STRATEGY_NAMES, createSeries, pushClose, signal, signalIdx, WINDOW,
} from '../server/strategies.js';
import {
  ARCHETYPES, Population, scaleCounts, TAKER_FEE, SLIPPAGE, CAPITAL, CURVE_KEEP,
} from '../server/population.js';
import { Engine } from '../server/engine.js';

const T0 = 1_700_000_000_000;
const quiet = () => {};

/** Relative/absolute closeness. */
function near(actual, expected, tol = 1e-9, msg = '') {
  const scale = Math.max(1, Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tol * scale, `${msg} expected ${expected}, got ${actual}`);
}

function recorder() {
  const records = [];
  return { records, emit(kind, data) { const r = { kind, ...data }; records.push(r); return r; } };
}

/** Engine state minus wall-clock fields, as a string for exact comparison. */
function simState(engine) {
  const s = engine.serialize();
  return JSON.stringify({ tick: s.tick, market: s.market, population: s.population });
}

// =============================================================================================
describe('rng', () => {
  test('same seed → same stream; different seeds differ', () => {
    const a = makeRng(123), b = makeRng(123), c = makeRng(124);
    const xa = Array.from({ length: 50 }, () => a.next());
    const xb = Array.from({ length: 50 }, () => b.next());
    const xc = Array.from({ length: 50 }, () => c.next());
    assert.deepEqual(xa, xb);
    assert.notDeepEqual(xa, xc);
    assert.ok(xa.every((x) => x >= 0 && x < 1));
  });

  test('state()/setState() round-trips exactly, including the cached normal', () => {
    const r = makeRng(9);
    r.normal(); // leaves a cached spare
    const saved = JSON.parse(JSON.stringify(r.state()));
    const seqA = [r.normal(), r.next(), r.normal(), r.int(1, 6)];
    const r2 = makeRng(0);
    r2.setState(saved);
    const seqB = [r2.normal(), r2.next(), r2.normal(), r2.int(1, 6)];
    assert.deepEqual(seqA, seqB);
  });

  test('int is inclusive, range is bounded, pick covers the array, normal is ~N(0,1)', () => {
    const r = makeRng(5);
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(2, 5);
      assert.ok(Number.isInteger(v) && v >= 2 && v <= 5);
      seen.add(v);
      const x = r.range(-1, 3);
      assert.ok(x >= -1 && x < 3);
    }
    assert.deepEqual([...seen].sort(), [2, 3, 4, 5]);
    const picks = new Set(Array.from({ length: 200 }, () => r.pick(['a', 'b', 'c'])));
    assert.equal(picks.size, 3);
    let s = 0, s2 = 0;
    const n = 40000;
    for (let i = 0; i < n; i++) { const z = r.normal(); s += z; s2 += z * z; }
    const mean = s / n, sd = Math.sqrt(s2 / n - mean * mean);
    assert.ok(Math.abs(mean) < 0.03, `mean ${mean}`);
    assert.ok(Math.abs(sd - 1) < 0.03, `sd ${sd}`);
  });

  test('deriveSeed separates streams; typed arrays survive base64', () => {
    assert.notEqual(deriveSeed(1, 'market'), deriveSeed(1, 'population'));
    assert.equal(deriveSeed(1, 'market'), deriveSeed(1, 'market'));
    const f = Float64Array.from([Math.PI, -0, 1e-300, 123456.789]);
    assert.deepEqual(b64ToTyped(typedToB64(f), Float64Array), f);
    assert.throws(() => b64ToTyped(typedToB64(f), Float64Array, 3));
  });
});

// =============================================================================================
describe('market', () => {
  test('COINS listing per SPEC §2.2 (frozen)', () => {
    assert.equal(COINS.length, 16);
    assert.ok(Object.isFrozen(COINS) && Object.isFrozen(COINS[0]));
    assert.deepEqual(COINS[0], { coin: 'BTC', px: 82000, vol: 0.55, max_leverage: 40, sz_decimals: 5 });
    assert.deepEqual(COINS.at(-1), { coin: 'VVV', px: 21, vol: 1.7, max_leverage: 3, sz_decimals: 2 });
    assert.deepEqual(COINS.map((c) => c.coin), ['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE', 'AVAX', 'LINK', 'SUI', 'NEAR', 'ARB', 'TIA', 'ZEC', 'WIF', 'PUMP', 'VVV']);
  });

  test('deterministic from seed; bars are well-formed and chained', () => {
    const a = new MarketFeed({ seed: 11, startMs: T0 });
    const b = new MarketFeed({ seed: 11, startMs: T0 });
    const c = new MarketFeed({ seed: 12, startMs: T0 });
    assert.equal(a.barIdx, -1);
    let prev = null;
    for (let i = 0; i < 400; i++) {
      const fa = a.nextSync(), fb = b.nextSync(), fc = c.nextSync();
      assert.deepEqual(fa, fb);
      if (i === 399) assert.notDeepEqual(fa.bars, fc.bars);
      assert.equal(fa.barIdx, i);
      assert.equal(fa.timeMs, T0 + i * BAR_MS);
      for (const coin of COINS) {
        const { o, h, l, c: cl } = fa.bars[coin.coin];
        assert.ok(l <= Math.min(o, cl) && h >= Math.max(o, cl) && l > 0, `${coin.coin} ohlc`);
        if (prev) assert.equal(o, prev.bars[coin.coin].c, 'open = previous close');
      }
      prev = fa;
    }
    assert.equal(a.mid('BTC'), prev.bars.BTC.c);
    assert.equal(a.closes('ETH').length, 400);
    assert.equal(a.closes('ETH').at(-1), prev.bars.ETH.c);
  });

  test('async next() equals nextSync() in sim mode; init() is a no-op', async () => {
    const a = new MarketFeed({ seed: 3, startMs: T0 });
    const b = new MarketFeed({ seed: 3, startMs: T0 });
    await a.init();
    assert.deepEqual(a.status(), { source: 'sim', coins: 16, ok: true, error: null, stale: 0 });
    for (let i = 0; i < 20; i++) assert.deepEqual(await a.next(), b.nextSync());
  });

  test('change24h, coinInfo, snapshot', () => {
    const m = new MarketFeed({ seed: 4, startMs: T0 });
    assert.equal(m.change24h('BTC'), null);
    m.nextSync();
    assert.equal(m.change24h('BTC'), null);
    m.nextSync();
    const cl = m.closes('BTC');
    near(m.change24h('BTC'), cl[1] / cl[0] - 1);
    for (let i = 0; i < 1500; i++) m.nextSync();
    const all = m.closes('SOL');
    near(m.change24h('SOL'), all.at(-1) / all[all.length - 1 - 1440] - 1);
    assert.equal(m.change24h('NOPE'), null);
    assert.equal(m.coinInfo('NOPE'), null);
    assert.deepEqual(m.coinInfo('SOL'), { coin: 'SOL', index: 2, max_leverage: 20, sz_decimals: 2 });
    const snap = m.snapshot();
    assert.equal(snap.length, 16);
    assert.deepEqual(Object.keys(snap[0]).sort(), [
      'bars', 'change_1h', 'change_24h', 'close', 'coin', 'day_ntl_vlm', 'funding_1h', 'index', 'mark_px', 'max_leverage',
      'mid', 'open_interest', 'oracle_px', 'prev_day_px', 'px', 'px_ms', 'source', 'stale', 'sz_decimals',
    ]);
    assert.equal(snap[0].bars, 1502);
    // sim: px = mid = close; the Hyperliquid day stats are null; nothing is stale
    assert.equal(snap[0].px, snap[0].mid);
    assert.equal(snap[0].close, snap[0].mid);
    assert.equal(snap[0].source, 'sim');
    for (const k of ['prev_day_px', 'funding_1h', 'mark_px', 'oracle_px', 'open_interest', 'day_ntl_vlm']) assert.equal(snap[0][k], null, k);
    assert.ok(snap.every((c) => c.stale === false));
    const sol = m.closes('SOL');
    near(snap[2].change_1h, sol.at(-1) / sol.at(-61) - 1);
  });

  test('serialize/restore continues the stream exactly (through JSON)', () => {
    const a = new MarketFeed({ seed: 21, startMs: T0 });
    for (let i = 0; i < 250; i++) a.nextSync();
    const saved = JSON.parse(JSON.stringify(a.serialize()));
    const b = new MarketFeed({ seed: 999, startMs: 0 }).restore(saved);
    assert.equal(b.barIdx, 249);
    assert.equal(b.timeMs, a.timeMs);
    assert.deepEqual(b.closes('DOGE'), a.closes('DOGE'));
    for (let i = 0; i < 300; i++) assert.deepEqual(b.nextSync(), a.nextSync());
  });

  test('keeps ≥ 14 days of history', () => {
    const m = new MarketFeed({ seed: 2, startMs: T0, coins: COINS.slice(0, 2) });
    for (let i = 0; i < HISTORY_KEEP + 3000; i++) m.nextSync();
    const cl = m.closes('ETH');
    assert.ok(cl.length >= HISTORY_KEEP);
    assert.equal(cl.at(-1), m.mid('ETH'));
  });

  test('realistic statistics: per-bar vol ≈ σ_min and corr(alt, BTC) ≈ 0.4', () => {
    const m = new MarketFeed({ seed: 8, startMs: T0 });
    const n = 20000;
    const ret = COINS.map(() => new Float64Array(n));
    let prev = COINS.map((c) => c.px);
    for (let t = 0; t < n; t++) {
      const { bars } = m.nextSync();
      COINS.forEach((c, i) => { ret[i][t] = Math.log(bars[c.coin].c / prev[i]); prev[i] = bars[c.coin].c; });
    }
    const sd = (x) => { const mu = x.reduce((a, b) => a + b, 0) / x.length; return Math.sqrt(x.reduce((a, b) => a + (b - mu) ** 2, 0) / x.length); };
    const corr = (x, y) => {
      const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
      return sxy / Math.sqrt(sxx * syy);
    };
    COINS.forEach((c, i) => {
      const expect = c.vol / Math.sqrt(525600);
      const ratio = sd(ret[i]) / expect;
      assert.ok(ratio > 0.85 && ratio < 1.35, `${c.coin} vol ratio ${ratio}`); // jumps add a little
    });
    const cs = COINS.slice(1).map((_, j) => corr(ret[0], ret[j + 1]));
    const meanCorr = cs.reduce((a, b) => a + b, 0) / cs.length;
    assert.ok(meanCorr > 0.3 && meanCorr < 0.5, `mean corr ${meanCorr}`);
  });
});

// =============================================================================================
describe('strategies', () => {
  const feedSeries = (closes) => { const s = createSeries(); for (const c of closes) pushClose(s, c); return s; };
  const params = (lookback, entry_threshold) => ({ lookback, entry_threshold });

  test('no signal until the window is full', () => {
    const s = feedSeries(Array.from({ length: WINDOW - 1 }, (_, i) => 100 + i));
    assert.equal(s.ready, false);
    for (const name of STRATEGY_NAMES) assert.equal(signal(name, s, params(5, 0.1)), 0);
  });

  test('tables match brute-force window statistics', () => {
    const r = makeRng(77);
    const closes = [100];
    for (let i = 1; i < 130; i++) closes.push(closes[i - 1] * Math.exp(0.002 * r.normal()));
    const s = feedSeries(closes);
    const t = closes.length - 1;
    const c = (j) => closes[t - j];
    const lr = Array.from({ length: 60 }, (_, j) => Math.log(c(j) / c(j + 1)));
    const lm = lr.reduce((a, b) => a + b, 0) / 60;
    near(s.sigma, Math.sqrt(lr.reduce((a, b) => a + (b - lm) ** 2, 0) / 59), 1e-9, 'sigma');
    for (const L of [2, 3, 7, 20, 41, 60]) {
      const win = Array.from({ length: L }, (_, j) => c(j));
      const sma = win.reduce((a, b) => a + b, 0) / L;
      const sdv = Math.sqrt(win.reduce((a, b) => a + (b - sma) ** 2, 0) / L);
      near(s.sma[L], sma, 1e-12, `sma ${L}`);
      near(s.mrz[L], (c(0) - sma) / sdv, 1e-7, `mrz ${L}`);
      near(s.mom[L], c(0) / c(L) - 1, 1e-12, `mom ${L}`);
      const prior = Array.from({ length: L }, (_, j) => c(j + 1));
      assert.equal(s.hi[L], Math.max(...prior));
      assert.equal(s.lo[L], Math.min(...prior));
      let g = 0, l = 0;
      for (let j = 0; j < L; j++) { const d = c(j) - c(j + 1); if (d > 0) g += d; else l -= d; }
      near(s.rsi[L], (100 * g) / (g + l), 1e-9, `rsi ${L}`);
    }
  });

  test('uptrend / downtrend / flat give the expected signs', () => {
    // sawtooth trend: +2, −1, +2, −1 … so σ > 0 and RSI is well defined
    const up = [100];
    for (let i = 1; i < 90; i++) up.push(up[i - 1] + (i % 2 ? 2 : -1));
    const down = up.map((x) => 400 - x);
    const su = feedSeries(up), sd = feedSeries(down), sf = feedSeries(new Array(90).fill(50));
    const p = params(20, 0.5);
    const expectUp = { momentum: 1, mean_reversion: -1, breakout: 1, ma_cross: 1, rsi_reversal: -1 };
    for (const name of STRATEGY_NAMES) {
      const lb = name === 'breakout' ? params(2, 0.1) : p; // the sawtooth's last step is up: a fresh 2-bar high
      assert.equal(signal(name, su, lb), expectUp[name], `${name} up`);
      assert.equal(signal(name, sf, p), 0, `${name} flat`);
    }
    // downtrend: last step of the mirrored sawtooth is down
    assert.equal(signal('momentum', sd, p), -1);
    assert.equal(signal('mean_reversion', sd, p), 1);
    assert.equal(signal('breakout', sd, params(2, 0.1)), -1);
    assert.equal(signal('ma_cross', sd, p), -1);
    assert.equal(signal('rsi_reversal', sd, p), 1);
  });

  test('signal(name) matches signalIdx; unknown name throws', () => {
    const s = feedSeries(Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 4 + i * 0.1));
    STRATEGY_NAMES.forEach((name, si) => {
      for (const L of [2, 9, 60]) for (const k of [0.1, 1, 2.5]) assert.equal(signal(name, s, params(L, k)), signalIdx(si, s, L, k));
    });
    assert.throws(() => signal('astrology', s, params(5, 1)));
  });
});

// =============================================================================================
// Hand-built paper-trading scenarios on a single test coin.

const TST = Object.freeze([Object.freeze({ coin: 'TST', px: 100, vol: 1, max_leverage: 50, sz_decimals: 2 })]);
const BASE_GENOME = {
  archetype: 'hyper_algo', coin: 'TST', strategy: 'breakout', lookback: 2, entry_threshold: 0.1,
  leverage: 5, position_size: 0.5, stop_loss: 0.05, take_profit: 0.02,
  cooldown_bars: 0, min_hold_bars: 96, max_hold_bars: 4320,
};

/** A one-bean population plus a bar driver. `warm()` feeds 61 oscillating bars (no signals). */
function scenario(genome = {}, extra = []) {
  const pop = new Population({ seed: 1, coins: TST, genomes: [{ ...BASE_GENOME, ...genome }, ...extra] });
  let bar = 0;
  const step = (b) => {
    const bars = { TST: typeof b === 'number' ? { o: b, h: b, l: b, c: b } : b };
    const res = pop.step({ barIdx: bar, timeMs: T0 + bar * BAR_MS, bars });
    bar++;
    return res;
  };
  const warm = () => {
    for (let i = 0; i < 61; i++) assert.equal(step(i % 2 ? 100.1 : 100).fills, 0, 'warm bars must not trade');
  };
  return { pop, step, warm, bar: () => bar };
}

describe('population: paper execution', () => {
  test('long entry fills at close + slippage with 4.5bp fee; target exit math', () => {
    const { pop, step, warm } = scenario();
    warm();
    const r1 = step(101); // fresh 2-bar high → long
    assert.equal(r1.fills, 1);
    const fill = 101 * (1 + SLIPPAGE);
    const notional = 1000 * 0.5 * 5;
    const units = notional / fill;
    const openFee = notional * TAKER_FEE;
    let row = pop.row(0);
    assert.equal(row.side, 1);
    assert.equal(row.in_position, 'long');
    near(row.entry_px, fill);
    near(row.units, units);
    near(row.equity, 1000 - openFee + units * (101 - fill));
    assert.equal(row.trades, 1);
    near(openFee, 1.125);

    const r2 = step({ o: 101, h: 103.5, l: 100.9, c: 103.2 }); // h crosses the +2% target
    assert.deepEqual(r2.exits, { liquidation: 0, stop: 0, target: 1, max_hold: 0, signal: 0 });
    const exit = fill * 1.02 * (1 - SLIPPAGE);
    const pnl = units * (exit - fill);
    const closeFee = units * exit * TAKER_FEE;
    row = pop.row(0);
    assert.equal(row.side, 0);
    assert.equal(row.entry_px, null);
    near(row.equity, 1000 - openFee + pnl - closeFee);
    near(row.total_return, row.equity / 1000 - 1);
    assert.equal(row.trades, 2);
    assert.equal(row.win_rate, 1);
    const d = pop.detail(0);
    assert.equal(d.trades.length, 2);
    assert.deepEqual(d.trades.map((t) => [t.action, t.side, t.reason]), [['close', 'long', 'target'], ['open', 'long', 'signal']]);
    near(d.trades[0].pnl, pnl - closeFee - openFee, 1e-6);
    near(d.trades[0].px, exit, 1e-6);
    assert.equal(d.trades[0].bar, 62);
    assert.equal(d.trades[0].time_ms, T0 + 62 * BAR_MS);
  });

  test('short entry and stop-loss fill (adverse move ≥ stop_loss)', () => {
    const { pop, step, warm } = scenario({ leverage: 2 });
    warm();
    step(99); // fresh 2-bar low → short
    const fill = 99 * (1 - SLIPPAGE);
    const units = (1000 * 0.5 * 2) / fill;
    assert.equal(pop.row(0).side, -1);
    near(pop.row(0).units, -units);
    const res = step({ o: 99, h: 104.5, l: 98.9, c: 104 });
    assert.equal(res.exits.stop, 1);
    const exit = fill * 1.05 * (1 + SLIPPAGE);
    const pnl = -units * (exit - fill);
    const fees = (units * fill + units * exit) * TAKER_FEE;
    near(pop.row(0).equity, 1000 + pnl - fees);
    assert.equal(pop.row(0).win_rate, 0);
  });

  test('stop gapped through fills at the open (still above liquidation)', () => {
    const { pop, step, warm } = scenario({ leverage: 5, stop_loss: 0.05 });
    warm();
    step(101);
    const fill = 101 * (1 + SLIPPAGE);
    const units = 2500 / fill;
    step({ o: 90, h: 91, l: 89, c: 90 }); // opens below the stop (95.96), liquidation is at ~81.8
    const exit = 90 * (1 - SLIPPAGE);
    near(pop.row(0).equity, 1000 - 2500 * TAKER_FEE + units * (exit - fill) - units * exit * TAKER_FEE);
    assert.equal(pop.detail(0).trades[0].reason, 'stop');
  });

  test('liquidation is checked first and loses exactly the margin', () => {
    const { pop, step, warm } = scenario({ leverage: 10, stop_loss: 0.2 });
    warm();
    step(101);
    const fill = 101 * (1 + SLIPPAGE);
    // adverse move 25%: crosses both liquidation (9.5%) and the 20% stop → liquidation wins
    const res = step({ o: 101, h: 101, l: fill * 0.75, c: fill * 0.8 });
    assert.deepEqual(res.exits, { liquidation: 1, stop: 0, target: 0, max_hold: 0, signal: 0 });
    const margin = 500;
    near(pop.row(0).equity, 1000 - 5000 * TAKER_FEE - margin);
    const t = pop.detail(0).trades[0];
    assert.equal(t.reason, 'liquidation');
    near(t.px, fill * (1 - 0.95 / 10), 1e-6);
    near(t.pnl, -margin - 5000 * TAKER_FEE, 1e-6);
  });

  test('short take-profit is capped at 0.9', () => {
    const { pop, step, warm } = scenario({ take_profit: 1.4, leverage: 2, stop_loss: 0.5 });
    warm();
    step(99);
    const fill = 99 * (1 - SLIPPAGE);
    const res = step({ o: 99, h: 99, l: fill * 0.099, c: fill * 0.2 }); // −90.1% low reaches the capped target
    assert.equal(res.exits.target, 1);
    near(pop.detail(0).trades[0].px, fill * 0.1 * (1 + SLIPPAGE), 1e-6);
  });

  test('max_hold_bars closes at the close', () => {
    const { pop, step, warm } = scenario({ max_hold_bars: 3 });
    warm();
    step(101); // open at bar 61
    assert.equal(step(101).fills, 0);
    assert.equal(step(101).fills, 0);
    const res = step(101); // held 3 bars
    assert.equal(res.exits.max_hold, 1);
    assert.equal(pop.row(0).side, 0);
    near(pop.detail(0).trades[0].px, 101 * (1 - SLIPPAGE), 1e-6); // trade log stores float32
  });

  test('signal flip after min_hold closes; re-entry only from the next bar', () => {
    const { pop, step, warm } = scenario({ min_hold_bars: 0 });
    warm();
    step(101); // long
    const flip = step(99); // fresh 2-bar low → opposite signal → close, no same-bar entry
    assert.equal(flip.exits.signal, 1);
    assert.equal(flip.fills, 1);
    assert.equal(pop.row(0).side, 0);
    const again = step(97); // still breaking down → short now
    assert.equal(again.fills, 1);
    assert.equal(pop.row(0).side, -1);
    assert.deepEqual(pop.detail(0).trades.map((t) => `${t.action}:${t.side}:${t.reason}`),
      ['open:short:signal', 'close:long:signal', 'open:long:signal']);
  });

  test('cooldown_bars delays re-entry', () => {
    const { pop, step, warm, bar } = scenario({ min_hold_bars: 0, cooldown_bars: 5, take_profit: 0.4 });
    warm();
    step(101);
    step(99); // exit at bar 62
    const exitBar = bar() - 1;
    let px = 99;
    const entries = [];
    for (let i = 0; i < 8; i++) {
      px -= 2; // a fresh low every bar keeps the short signal on
      if (step(px).fills > 0) entries.push(bar() - 1);
    }
    assert.deepEqual(entries, [exitBar + 5]);
    assert.equal(pop.row(0).side, -1);
  });

  test('busted: flat and cannot open $10 → frozen forever, reported once; breached flags', () => {
    const { pop, step, warm } = scenario({ archetype: 'degen_algo', leverage: 25, position_size: 1, stop_loss: 0.5 });
    warm();
    step(101);
    const fill = 101 * (1 + SLIPPAGE);
    // margin is capped so margin + fee ≤ equity → a liquidation leaves exactly 0
    near(pop.row(0).equity + 0, 1000 - (1000 / (1 + 25 * TAKER_FEE)) * 25 * TAKER_FEE + (2.5e4 / (1 + 25 * TAKER_FEE)) / fill * (101 - fill));
    const res = step({ o: 101, h: 101, l: fill * 0.9, c: fill * 0.95 });
    assert.equal(res.exits.liquidation, 1);
    assert.deepEqual(res.busted, [0]);
    const row = pop.row(0);
    assert.equal(row.busted, true);
    assert.ok(row.equity >= 0 && row.equity < 1e-6);
    assert.equal(row.breached, 3);
    assert.equal(row.venue_reason, 'busted');
    assert.equal(row.tradeable, false);
    const fills = row.trades;
    for (const px of [110, 120, 130, 140]) assert.deepEqual(step(px).busted, []);
    assert.equal(pop.row(0).trades, fills, 'a busted bean never trades again');
    assert.equal(pop.stats().by_archetype.find((a) => a.archetype === 'degen_algo').busted, 1);
  });

  test('beans on a coin without a bar sit the bar out', () => {
    const { pop } = scenario();
    const res = pop.step({ barIdx: 0, timeMs: T0, bars: {} });
    assert.equal(res.fills, 0);
    assert.equal(pop.row(0).equity, CAPITAL);
  });

  test('metrics: sharpe, ann_return/fitness, max_dd, ret windows and curve vs recomputation', () => {
    const { pop, step, warm } = scenario({ min_hold_bars: 0, lookback: 3, max_hold_bars: 40 });
    warm();
    const rng = makeRng(31);
    const equities = Array(61).fill(1000);
    let px = 100;
    for (let i = 0; i < 240; i++) {
      const o = px;
      px *= Math.exp(0.004 * rng.normal());
      step({ o, h: Math.max(o, px) * 1.001, l: Math.min(o, px) * 0.999, c: px });
      equities.push(pop.row(0).equity);
    }
    const row = pop.row(0);
    assert.ok(row.trades >= 4, `scenario should trade (got ${row.trades})`);
    // independent recomputation from the equity path
    const rets = [];
    let prev = 1000, peak = 1000, mdd = 0;
    for (const e of equities) {
      rets.push(e / prev - 1);
      prev = e;
      peak = Math.max(peak, e);
      mdd = Math.max(mdd, 1 - e / peak);
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + b * b, 0) / rets.length - mean * mean);
    near(row.sharpe, (mean / sd) * Math.sqrt(525600), 1e-6, 'sharpe');
    near(row.max_dd, mdd, 1e-9, 'max_dd');
    near(row.fitness, mean * 525600 - mdd, 1e-6, 'fitness (return scale)');
    // 301 bars → hourly points at h = 0..5 (bars 59, 119, …, 299)
    const curve = pop.detail(0).curve;
    assert.deepEqual(curve.map((p) => p.h), [0, 1, 2, 3, 4, 5]);
    assert.equal(curve[0].equity, 1000);
    for (let h = 1; h <= 5; h++) near(curve[h].equity, equities[h * 60 - 1], 1e-6, `curve h=${h}`);
    near(row.ret_1h, row.equity / equities[4 * 60 - 1] - 1, 1e-6, 'ret_1h');
    near(row.ret_1d, row.equity / 1000 - 1, 1e-6, 'ret_1d falls back to the start');
    near(row.ret_7d, row.total_return, 1e-6, 'ret_7d');
  });
});

// =============================================================================================
describe('population: archetypes, genomes, persistence', () => {
  test('ARCHETYPES and scaleCounts per SPEC §2.3', () => {
    assert.deepEqual(ARCHETYPES.map((a) => [a.name, a.count]), [
      ['standard', 400], ['hyper_algo', 400], ['degen_algo', 400], ['swarm', 300], ['swarm_5x', 300],
      ['swarm_10x', 300], ['swarm_25x', 300], ['swarm_50x', 300], ['swarm_100x', 300]]);
    const degen = ARCHETYPES[2];
    assert.equal(degen.scale, 'return_dd2');
    assert.equal(degen.max_drawdown, 0.85);
    assert.equal(degen.ruin_floor, 0.10);
    assert.deepEqual(degen.strategies, ['momentum', 'mean_reversion', 'breakout']);
    assert.deepEqual(ARCHETYPES[8].strategies, STRATEGY_NAMES);
    assert.ok(ARCHETYPES.every((a) => a.mode === 'algo'));
    assert.deepEqual(scaleCounts(3000), ARCHETYPES.map((a) => a.count));
    for (const n of [1, 7, 30, 299, 1001]) assert.equal(scaleCounts(n).reduce((a, b) => a + b, 0), n);
    assert.deepEqual(scaleCounts(300), [40, 40, 40, 30, 30, 30, 30, 30, 30]);
  });

  test('genomes are deterministic, in table order and within bounds', () => {
    const a = new Population({ seed: 5, total: 300 });
    const b = new Population({ seed: 5, total: 300 });
    const c = new Population({ seed: 6, total: 300 });
    assert.equal(a.size, 300);
    const g = (p) => Array.from({ length: p.size }, (_, i) => p.detail(i).genome);
    assert.deepEqual(g(a), g(b));
    assert.notDeepEqual(g(a), g(c));
    const counts = scaleCounts(300);
    let id = 0;
    ARCHETYPES.forEach((arch, ai) => {
      for (let j = 0; j < counts[ai]; j++, id++) {
        const ge = a.detail(id).genome;
        assert.equal(ge.archetype, arch.name);
        assert.ok(ge.leverage >= arch.leverage[0] && ge.leverage <= arch.leverage[1]);
        assert.ok(ge.position_size >= arch.position_size[0] && ge.position_size <= arch.position_size[1]);
        assert.ok(ge.stop_loss >= arch.stop_loss[0] && ge.stop_loss <= arch.stop_loss[1]);
        assert.ok(ge.take_profit >= arch.take_profit[0] && ge.take_profit <= arch.take_profit[1]);
        assert.ok(ge.lookback >= 2 && ge.lookback <= 60);
        assert.ok(ge.entry_threshold >= 0.1 && ge.entry_threshold <= 3);
        assert.ok(ge.cooldown_bars <= 48 && ge.min_hold_bars <= 96);
        assert.ok(ge.max_hold_bars >= 60 && ge.max_hold_bars <= 4320);
        assert.ok(arch.strategies.includes(ge.strategy));
        assert.ok(COINS.some((x) => x.coin === ge.coin));
      }
    });
  });

  test('serialize/restore round-trips and continues identically', () => {
    const m = new MarketFeed({ seed: 13, startMs: T0 });
    const a = new Population({ seed: 13, total: 200 });
    for (let i = 0; i < 400; i++) a.step(m.nextSync());
    const saved = JSON.parse(JSON.stringify(a.serialize()));
    const b = new Population({ seed: 0, total: 5 }).restore(saved);
    assert.equal(b.size, 200);
    assert.deepEqual(b.query({ limit: 1000 }), a.query({ limit: 1000 }));
    assert.deepEqual(b.detail(17), a.detail(17));
    for (let i = 0; i < 300; i++) {
      const f = m.nextSync();
      assert.deepEqual(b.step(f), a.step(f));
    }
    assert.equal(JSON.stringify(b.serialize()), JSON.stringify(a.serialize()));
  });
});

// =============================================================================================
describe('engine', () => {
  const cfg = (over = {}) => ({ seed: 7, beans: 300, warmupBars: 600, tickMs: 5000, startMs: T0, log: quiet, ...over });

  test('start() warms up synchronously and emits one warmup_finished', async () => {
    const j = recorder();
    const e = new Engine({ config: cfg(), journal: j });
    assert.equal(e.health().ok, false);
    const res = await e.start();
    assert.equal(res.restored, false);
    assert.equal(e.ticks, 600);
    assert.equal(e.market.barIdx, 599);
    assert.deepEqual(j.records.map((r) => r.kind), ['warmup_finished']);
    assert.equal(j.records[0].bars, 600);
    assert.ok(Number.isFinite(j.records[0].ms));
    assert.equal(e.health().ok, true);
  });

  test('same seed → identical engines; different seed → different', async () => {
    const a = new Engine({ config: cfg() });
    const b = new Engine({ config: cfg() });
    const c = new Engine({ config: cfg({ seed: 8 }) });
    await Promise.all([a.start(), b.start(), c.start()]);
    await a.advance(30);
    await b.advance(30);
    await c.advance(30);
    assert.equal(simState(a), simState(b));
    assert.notEqual(simState(a), simState(c));
    assert.deepEqual(a.population.query({ limit: 50 }), b.population.query({ limit: 50 }));
  });

  test('serialize → restore → continue is identical to never stopping', async () => {
    const a = new Engine({ config: cfg() });
    await a.start();
    await a.advance(25);
    const snap = JSON.parse(JSON.stringify(a.serialize()));
    const j = recorder();
    const b = new Engine({ config: cfg({ seed: 1, beans: 10, startMs: 0 }), journal: j });
    b.restore(snap);
    const res = await b.start();
    assert.equal(res.restored, true);
    assert.equal(j.records.length, 0, 'no warmup after restore');
    assert.equal(b.ticks, a.ticks);
    assert.equal(b.status().from_snapshot, true);
    await a.advance(45);
    await b.advance(45);
    assert.equal(simState(b), simState(a));
    assert.deepEqual(b.population.query({ sort: 'id', limit: 1000 }), a.population.query({ sort: 'id', limit: 1000 }));
  });

  test('tick(): busted events, hooks before tick_completed, exact event shapes', async () => {
    const j = recorder();
    const e = new Engine({ config: cfg({ beans: 600, warmupBars: 100 }), journal: j });
    await e.start();
    const order = [];
    e.onTick((summary, eng) => {
      order.push(`hook:${summary.tick}`);
      assert.equal(eng, e);
      assert.equal(j.records.filter((r) => r.kind === 'tick_completed' && r.tick === summary.tick).length, 0);
    });
    const origEmit = j.emit;
    j.emit = (kind, data) => { if (kind === 'tick_completed') order.push(`event:${data.tick}`); return origEmit.call(j, kind, data); };
    let summedBusted = 0;
    for (let i = 0; i < 400; i++) {
      const s = e.tick();
      summedBusted += s.busted;
      assert.equal(s.busted, s.busted_ids.length);
    }
    assert.deepEqual(order.slice(0, 4), ['hook:101', 'event:101', 'hook:102', 'event:102']);
    const ticks = j.records.filter((r) => r.kind === 'tick_completed');
    assert.equal(ticks.length, 400);
    assert.deepEqual(Object.keys(ticks[0]).sort(),
      ['bar', 'busted', 'closed_ms', 'dur_ms', 'exits', 'fills', 'kind', 'next_tick_ms', 'source', 'tick', 'time_ms']);
    assert.equal(ticks[0].closed_ms, ticks[0].time_ms + BAR_MS);
    assert.equal(ticks[0].next_tick_ms, null, 'sim, not looping');
    assert.equal(ticks[0].source, 'sim');
    assert.deepEqual(Object.keys(ticks[0].exits).sort(), ['liquidation', 'max_hold', 'signal', 'stop', 'target']);
    assert.equal(ticks.at(-1).tick, 500);
    assert.equal(ticks.at(-1).bar, 499);
    assert.equal(ticks.at(-1).time_ms, T0 + 499 * BAR_MS);
    const bustedEvents = j.records.filter((r) => r.kind === 'busted');
    assert.equal(bustedEvents.length, summedBusted);
    for (const ev of bustedEvents) {
      assert.deepEqual(Object.keys(ev).sort(), ['archetype', 'bean', 'coin', 'equity', 'kind']);
      const row = e.population.row(ev.bean);
      assert.equal(row.busted, true);
      assert.equal(row.archetype, ev.archetype);
      assert.equal(row.coin, ev.coin);
    }
    assert.ok(ticks.some((t) => t.fills > 0), 'beans trade');
  });

  test('re-entrant tick() from a hook is refused (409); advance(n) and run()/stop()', async () => {
    const e = new Engine({ config: cfg({ beans: 50, warmupBars: 70, tickMs: 10 }) });
    await e.start();
    let inner = null;
    const off = e.onTick(() => { try { e.tick(); } catch (err) { inner = err; } });
    e.tick();
    assert.equal(inner?.status, 409);
    off();
    const last = await e.advance(45);
    assert.equal(last.tick, 70 + 1 + 45);
    assert.equal(e.ticks, 116);
    await assert.rejects(e.advance(0));
    assert.equal(e.health().daemon.running, false);
    e.run();
    e.run(); // idempotent
    assert.equal(e.health().daemon.running, true);
    await new Promise((r) => setTimeout(r, 120));
    e.stop();
    assert.ok(e.ticks > 116, 'the interval loop ticks');
    assert.equal(e.health().daemon.running, false);
  });

  test('health / status / marketView payload shapes', async () => {
    const e = new Engine({ config: cfg({ beans: 90, warmupBars: 120 }) });
    await e.start();
    e.tick();
    const h = e.health();
    assert.deepEqual(Object.keys(h).sort(),
      ['bar_idx', 'beans', 'daemon', 'feed', 'feed_state', 'market_time_ms', 'now_ms', 'ok', 'paper', 'prices', 'tick', 'uptime_s', 'version'].sort());
    assert.equal(h.prices, 'sim');
    assert.equal(h.paper, true);
    assert.equal(h.feed_state, 'sim');
    assert.equal(h.tick, 121);
    assert.equal(h.bar_idx, 120);
    assert.equal(h.beans, 90);
    assert.equal(h.feed, 'sim');
    assert.equal(h.market_time_ms, T0 + 120 * BAR_MS);
    assert.deepEqual(h.daemon, { running: false, tick_ms: 5000, aligned: false, next_tick_ms: null });
    const s = e.status();
    assert.ok(Number.isFinite(s.last_tick_duration_ms));
    const { source, coins, ok, error, stale, ...more } = s.feed;
    assert.deepEqual({ source, coins, ok, error, stale }, { source: 'sim', coins: 16, ok: true, error: null, stale: 0 });
    assert.deepEqual(more, {
      real: false, state: 'sim', stale_coins: [], fallback: null, real_available: null, mids_ms: null, mids_age_ms: null,
      last_bar_close_ms: T0 + 121 * BAR_MS, next_tick_ms: null, lag_bars: 0, bar_sources: { candle: 0, mids: 0, flat: 0 },
      weight_60s: 0, last_gap: null, requests: null,
    });
    assert.equal(s.population.beans, 90);
    assert.equal(s.population.by_archetype.length, 9);
    assert.deepEqual(Object.keys(s.population.by_archetype[0]).sort(),
      ['archetype', 'best_return', 'busted', 'count', 'mean_return', 'positioned', 'traded']);
    assert.equal(s.population.by_archetype.reduce((a, r) => a + r.count, 0), 90);
    const mv = e.marketView();
    assert.equal(mv.coins.length, 16);
    assert.equal(mv.coins.reduce((a, c) => a + c.beans, 0), 90);
    assert.ok(mv.coins.every((c) => c.positioned <= c.beans));
  });
});

// =============================================================================================
describe('queries (beans / bean_detail / equity_curves / stats)', async () => {
  const e = new Engine({ config: { seed: 3, beans: 450, warmupBars: 900, startMs: T0, log: quiet } });
  await e.start();
  const pop = e.population;
  const all = pop.query({ sort: 'id', limit: 1000 }).rows;
  const ROW_KEYS = ['id', 'archetype', 'family', 'mode', 'strategy', 'coin', 'leverage', 'position_size', 'lookback',
    'entry_threshold', 'stop_loss', 'take_profit', 'cooldown_bars', 'min_hold_bars', 'max_hold_bars', 'equity',
    'total_return', 'ret_1h', 'ret_1d', 'ret_7d', 'sharpe', 'max_dd', 'trades', 'win_rate', 'fitness', 'busted',
    'breached', 'in_position', 'side', 'units', 'entry_px', 'tradeable', 'venue_max_leverage', 'venue_reason', 'bot'];

  test('BeanRow has exactly the SPEC fields', () => {
    assert.equal(all.length, 450);
    assert.deepEqual(Object.keys(all[0]), ROW_KEYS);
    for (const r of all) {
      assert.equal(r.in_position, r.side > 0 ? 'long' : r.side < 0 ? 'short' : 'flat');
      assert.equal(Math.sign(r.units), r.side);
      assert.equal(r.entry_px === null, r.side === 0);
      for (const k of ['equity', 'total_return', 'ret_1h', 'ret_1d', 'ret_7d', 'sharpe', 'max_dd', 'fitness', 'win_rate']) {
        assert.ok(Number.isFinite(r[k]), `${k} finite for bean ${r.id}`);
      }
    }
    assert.ok(all.some((r) => r.trades > 0) && all.some((r) => r.side !== 0));
  });

  test('default sort is -fitness with id tie-break; ascending sorts; envelope', () => {
    const q = pop.query({});
    assert.equal(q.sort, '-fitness');
    assert.equal(q.limit, 100);
    assert.equal(q.offset, 0);
    assert.equal(q.total, 450);
    assert.equal(q.rows.length, 100);
    assert.deepEqual(q.venue, { known: true, network: 'sim' });
    for (let i = 1; i < q.rows.length; i++) {
      const a = q.rows[i - 1], b = q.rows[i];
      assert.ok(a.fitness > b.fitness || (a.fitness === b.fitness && a.id < b.id));
    }
    for (const key of ['total_return', 'ret_7d', 'ret_1d', 'ret_1h', 'sharpe', 'trades', 'equity', 'max_dd', 'id']) {
      const asc = pop.query({ sort: key, limit: 1000 }).rows;
      for (let i = 1; i < asc.length; i++) assert.ok(asc[i - 1][key] <= asc[i][key], `${key} ascending`);
      const desc = pop.query({ sort: `-${key}`, limit: 5 }).rows;
      assert.equal(desc[0][key], Math.max(...all.map((r) => r[key])));
    }
    assert.throws(() => pop.query({ sort: 'vibes' }), (err) => err.status === 400);
    assert.throws(() => pop.query({ busted: 'maybe' }), (err) => err.status === 400);
  });

  test('filters AND together (typed or string params)', () => {
    const check = (params, pred) => {
      const q = pop.query({ ...params, limit: 1000 });
      const expected = all.filter(pred);
      assert.equal(q.total, expected.length, JSON.stringify(params));
      assert.deepEqual(new Set(q.rows.map((r) => r.id)), new Set(expected.map((r) => r.id)));
    };
    check({ archetype: 'swarm_25x' }, (r) => r.archetype === 'swarm_25x');
    check({ coin: 'ETH' }, (r) => r.coin === 'ETH');
    check({ coin: 'eth' }, (r) => r.coin === 'ETH');
    check({ strategy: 'momentum' }, (r) => r.strategy === 'momentum');
    check({ busted: false }, (r) => !r.busted);
    check({ busted: 'true' }, (r) => r.busted);
    check({ in_position: true }, (r) => r.side !== 0);
    check({ in_position: 'off' }, (r) => r.side === 0);
    check({ trades_min: 10 }, (r) => r.trades >= 10);
    check({ trades_min: '1', archetype: 'degen_algo', in_position: 'yes' }, (r) => r.trades >= 1 && r.archetype === 'degen_algo' && r.side !== 0);
    check({ ids: [5, 9, 9, 449, 450, -1] }, (r) => [5, 9, 449].includes(r.id));
    check({ ids: '3,4, 7' }, (r) => [3, 4, 7].includes(r.id));
    check({ ids: '[11,12]' }, (r) => [11, 12].includes(r.id));
    check({ archetype: 'nope' }, () => false);
    check({ coin: 'NOPE' }, () => false);
  });

  test('distinct_coin keeps the best bean per coin by sort, then pages', () => {
    const q = pop.query({ distinct_coin: true, sort: '-total_return', limit: 1000 });
    const coins = q.rows.map((r) => r.coin);
    assert.equal(new Set(coins).size, coins.length);
    assert.equal(q.total, new Set(all.map((r) => r.coin)).size);
    for (const r of q.rows) {
      const best = pop.query({ coin: r.coin, sort: '-total_return', limit: 1 }).rows[0];
      assert.equal(r.id, best.id);
    }
    for (let i = 1; i < q.rows.length; i++) assert.ok(q.rows[i - 1].total_return >= q.rows[i].total_return);
    const page = pop.query({ distinct_coin: 'true', sort: '-total_return', limit: 5, offset: 2 });
    assert.equal(page.total, q.total);
    assert.deepEqual(page.rows.map((r) => r.id), q.rows.slice(2, 7).map((r) => r.id));
  });

  test('paging: pages concatenate to the full list; limit clamps', () => {
    const full = pop.query({ sort: '-sharpe', limit: 1000 }).rows.map((r) => r.id);
    const pages = [];
    for (let off = 0; off < 450; off += 37) pages.push(...pop.query({ sort: '-sharpe', limit: 37, offset: off }).rows.map((r) => r.id));
    assert.deepEqual(pages, full);
    assert.equal(pop.query({ limit: 5000 }).limit, 1000);
    const zero = pop.query({ limit: 0 });
    assert.equal(zero.rows.length, 0);
    assert.equal(zero.total, 450);
    assert.equal(pop.query({ offset: 10000 }).rows.length, 0);
  });

  test('default venue verdict (no live layer) and the venue hook', () => {
    for (const r of all) {
      const max = COINS.find((c) => c.coin === r.coin).max_leverage;
      const required = (r.position_size * r.leverage * r.equity) / 1000;
      const reason = r.busted ? 'busted' : required > max ? 'leverage' : null;
      assert.equal(r.venue_reason, reason);
      assert.equal(r.tradeable, reason === null);
      assert.equal(r.venue_max_leverage, max);
      assert.equal(r.bot, null);
    }
    assert.ok(all.some((r) => r.venue_reason === 'leverage'), 'some high-leverage beans exceed venue limits');
    pop.setVenueHook((row) => ({
      tradeable: row.id % 3 === 0, venue_max_leverage: 7, venue_reason: row.id % 3 === 0 ? null : 'coin_bound', bot: row.id === 3 ? 'bot-0001' : null,
    }));
    try {
      const q = pop.query({ tradeable: true, limit: 1000 });
      assert.ok(q.rows.length > 0 && q.rows.every((r) => r.id % 3 === 0 && r.venue_max_leverage === 7));
      assert.equal(q.total, Math.ceil(450 / 3));
      assert.equal(pop.row(3).bot, 'bot-0001');
      assert.equal(pop.row(4).venue_reason, 'coin_bound');
      assert.equal(pop.query({ tradeable: false, limit: 1000 }).total, 450 - 150);
    } finally {
      pop.setVenueHook(null);
    }
  });

  test('bean_detail payload', () => {
    const traded = all.find((r) => r.trades >= 3);
    const d = pop.detail(traded.id);
    assert.deepEqual(Object.keys(d), ['bean', 'genome', 'describe', 'curve', 'trades']);
    assert.deepEqual(d.bean, pop.row(traded.id));
    assert.deepEqual(Object.keys(d.genome).sort(), ['archetype', 'coin', 'cooldown_bars', 'entry_threshold', 'family', 'leverage',
      'lookback', 'max_hold_bars', 'min_hold_bars', 'mode', 'position_size', 'stop_loss', 'strategy', 'take_profit']);
    assert.match(d.describe, /^\[\w+ algo \d+x\] \w+@\w+ lb=\d+/);
    assert.ok(d.trades.length >= 1 && d.trades.length <= 50);
    assert.deepEqual(Object.keys(d.trades[0]), ['bar', 'time_ms', 'action', 'side', 'px', 'units', 'pnl', 'reason']);
    for (let i = 1; i < d.trades.length; i++) assert.ok(d.trades[i - 1].bar >= d.trades[i].bar, 'newest first');
    for (const t of d.trades) {
      assert.equal(t.time_ms, T0 + t.bar * BAR_MS);
      assert.ok(['open', 'close'].includes(t.action) && ['long', 'short'].includes(t.side));
      assert.ok(['liquidation', 'stop', 'target', 'max_hold', 'signal'].includes(t.reason));
    }
    const busiest = all.reduce((a, b) => (b.trades > a.trades ? b : a));
    if (busiest.trades > 50) assert.equal(pop.detail(busiest.id).trades.length, 50);
    assert.equal(pop.detail(-1), null);
    assert.equal(pop.detail(450), null);
    assert.equal(pop.detail('abc'), null);
    assert.equal(pop.row(450), null);
  });

  test('equity_curves: hourly {h, equity}, starts at 1000, ≤ 50 ids', () => {
    const c = pop.curves([0, 1, '2', 9999]);
    assert.deepEqual(Object.keys(c), ['0', '1', '2']);
    const expectedPoints = Math.floor(900 / 60) + 1; // h = 0..15
    for (const curve of Object.values(c)) {
      assert.equal(curve.length, expectedPoints);
      assert.deepEqual(curve.map((p) => p.h), Array.from({ length: expectedPoints }, (_, h) => h));
      assert.equal(curve[0].equity, 1000);
      assert.deepEqual(Object.keys(curve[0]), ['h', 'equity']);
    }
    near(c['1'].at(-1).equity, pop.row(1).equity, 1e-6); // bar 899 closes hour 15
    assert.equal(Object.keys(pop.curves('0,1,2')).length, 3);
    assert.equal(Object.keys(pop.curves(Array.from({ length: 80 }, (_, i) => i))).length, 50);
    assert.deepEqual(pop.curves([]), {});
    assert.ok(CURVE_KEEP === 336);
  });

  test('stats() aggregates per archetype', () => {
    const s = pop.stats();
    assert.equal(s.beans, 450);
    assert.deepEqual(s.by_archetype.map((r) => r.archetype), ARCHETYPES.map((a) => a.name));
    for (const r of s.by_archetype) {
      const rows = all.filter((x) => x.archetype === r.archetype);
      assert.equal(r.count, rows.length);
      assert.equal(r.busted, rows.filter((x) => x.busted).length);
      assert.equal(r.positioned, rows.filter((x) => x.side !== 0).length);
      assert.equal(r.traded, rows.filter((x) => x.trades > 0).length);
      near(r.best_return, Math.max(...rows.map((x) => x.total_return)));
      near(r.mean_return, rows.reduce((a, x) => a + x.total_return, 0) / rows.length);
    }
  });
});

// =============================================================================================
describe('market realism (population outcome)', async () => {
  test('some beans profit, the median bean loses a little', async () => {
    const e = new Engine({ config: { seed: 42, beans: 1500, warmupBars: 2880, startMs: T0, log: quiet } });
    await e.start();
    const rets = e.population.query({ sort: 'total_return', limit: 1000 }).rows.map((r) => r.total_return);
    const more = e.population.query({ sort: 'total_return', limit: 1000, offset: 1000 }).rows.map((r) => r.total_return);
    const all = rets.concat(more);
    const median = all[Math.floor(all.length / 2)];
    const winners = all.filter((r) => r > 0).length / all.length;
    assert.ok(median < 0 && median > -0.15, `median ${median}`);
    assert.ok(winners > 0.1 && winners < 0.5, `winners ${winners}`);
    assert.ok(all.at(-1) > 0.2, 'someone did well');
  });
});

// =============================================================================================
describe('performance (SPEC §2.1 budget)', () => {
  test('default population: warmup 2880 bars ≤ 8 s, one tick ≤ 50 ms', async () => {
    const j = recorder();
    const e = new Engine({ config: { seed: 42, startMs: T0, log: quiet }, journal: j }); // 3000 beans, 2880 bars
    const t0 = performance.now();
    await e.start();
    const warm = performance.now() - t0;
    const durs = [];
    for (let i = 0; i < 60; i++) {
      const t = performance.now();
      e.tick();
      durs.push(performance.now() - t);
    }
    durs.sort((a, b) => a - b);
    const worst = durs.at(-1);
    console.log(`# perf: warmup ${warm.toFixed(0)} ms (3000 beans × 2880 bars), tick p50 ${durs[30].toFixed(2)} ms, max ${worst.toFixed(2)} ms`);
    assert.equal(e.population.size, 3000);
    assert.ok(warm <= 8000, `warmup ${warm} ms`);
    assert.ok(worst <= 50, `tick ${worst} ms`);
  });
});

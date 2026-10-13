// Tests for the live builder's modules: server/journal.js, server/live.js, server/store.js.
// The LiveLayer is driven by a FAKE engine (population.row / market.mid / market.coinInfo / market.timeMs),
// so these tests need neither the real engine nor the network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Journal, RingBuffer } from '../server/journal.js';
import { LiveLayer, ApiError, SIM_COSTS, LIVE_DEFAULTS, LOG_KEEP, requiredLeverage } from '../server/live.js';
import { saveState, loadState } from '../server/store.js';

// ---- helpers -------------------------------------------------------------------------------------

const SLIP = SIM_COSTS.spread + SIM_COSTS.impact; // 1.5 bp
const FEE = SIM_COSTS.takerFee; // 4.5 bp

/** assert |a − b| ≤ eps */
function near(actual, expected, eps = 1e-6, msg = '') {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg} expected ${expected}, got ${actual}`);
}

/** Expect fn() to throw an ApiError with `status` (and optionally a message matching `re`). */
function rejects(fn, status, re) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ApiError, `expected ApiError, got ${err}`);
    assert.equal(err.status, status, `status for "${err.message}"`);
    if (re) assert.match(err.message, re);
    return true;
  });
}

const VENUE = {
  BTC: { max_leverage: 40, sz_decimals: 5 },
  ETH: { max_leverage: 25, sz_decimals: 4 },
  SOL: { max_leverage: 20, sz_decimals: 2 },
  XRP: { max_leverage: 20, sz_decimals: 0 },
  VVV: { max_leverage: 3, sz_decimals: 2 },
};

/** Minimal engine double exposing exactly what LiveLayer uses. */
function makeEngine() {
  const beans = new Map();
  let hook = null;
  const market = {
    timeMs: 1_800_000_000_000,
    prices: { BTC: 80_000, ETH: 3_000, SOL: 100, XRP: 2, VVV: 20 },
    mid(coin) {
      return this.prices[coin] ?? null;
    },
    coinInfo(coin) {
      const v = VENUE[coin];
      return v ? { coin, index: Object.keys(VENUE).indexOf(coin), ...v } : null;
    },
    snapshot() {
      return Object.keys(VENUE).map((coin) => ({ coin }));
    },
  };
  const population = {
    row(id) {
      const b = beans.get(id);
      if (!b) return null;
      const row = { ...b };
      if (hook) Object.assign(row, hook(row));
      return row;
    },
    setVenueHook(fn) {
      hook = fn;
    },
  };
  return {
    market,
    population,
    addBean(id, fields = {}) {
      beans.set(id, { id, archetype: 'standard', coin: 'BTC', leverage: 1, position_size: 1, equity: 1000, side: 0, units: 0, busted: false, ...fields });
    },
    setBean(id, patch) {
      Object.assign(beans.get(id), patch);
    },
  };
}

/** A LiveLayer wired to a fake engine, an in-memory journal and a manual wall clock. */
function setup(config = {}) {
  const engine = makeEngine();
  const journal = new Journal({ keep: 5000 });
  const clock = { ms: 1_000_000 };
  const live = new LiveLayer({ config, engine, journal, now: () => clock.ms, log: () => {} });
  engine.population.setVenueHook((row) => live.venue(row));
  let tickNo = 0;
  return {
    engine,
    journal,
    live,
    clock,
    /** Advance one engine tick: market time +1 min, wall +5 s, then the live hook. */
    tick() {
      tickNo++;
      engine.market.timeMs += 60_000;
      clock.ms += 5_000;
      live.afterTick({ tick: tickNo, bar: tickNo });
      return tickNo;
    },
    events(kind) {
      return journal.query({ kind, limit: 5000 }).rows.reverse();
    },
  };
}

/** Bean 1: BTC long, 1× — 0.0125 BTC ($1000 at 80k). With $100 of water the bot holds 0.00125 BTC. */
function btcLong(env, id = 1) {
  env.engine.addBean(id, { coin: 'BTC', leverage: 1, position_size: 1, side: 1, units: 0.0125 });
}

const BOT_ROW_KEYS = [
  'id', 'index', 'bean', 'coin', 'capital_usd', 'leverage', 'state', 'created_ms', 'updated_ms', 'closed_ms',
  'bean_side', 'bean_units', 'bean_equity', 'target_sz', 'sz_decimals', 'fills', 'orders', 'volume', 'fees',
  'realized_pnl', 'notional_usd', 'last_error', 'last_error_ms', 'last_reconcile_ms', 'note',
  'mark_px', 'mark_ms', 'price_stale', // GAME-DESIGN §10.5
  'real',
];
const REAL_KEYS = ['szi', 'entry_px', 'unrealized_pnl', 'margin_used', 'liquidation_px', 'leverage', 'as_of_ms'];

// ---- Journal -------------------------------------------------------------------------------------

describe('RingBuffer', () => {
  test('keeps the newest N, oldest first', () => {
    const r = new RingBuffer(3);
    for (let i = 1; i <= 5; i++) r.push(i);
    assert.equal(r.length, 3);
    assert.deepEqual(r.toArray(), [3, 4, 5]);
    assert.deepEqual([...r.newestFirst()], [5, 4, 3]);
    assert.equal(r.at(0), 3);
    assert.equal(r.last(), 5);
    assert.equal(r.at(3), undefined);
    assert.throws(() => new RingBuffer(0), RangeError);
  });
});

describe('Journal', () => {
  test('emit builds { seq, t, kind, ...data } with increasing seq; data cannot override seq/t/kind', () => {
    const j = new Journal();
    const before = Date.now();
    const a = j.emit('tick_completed', { tick: 1, bar: 0 });
    const b = j.emit('busted', { bean: 7, seq: 999, kind: 'nope', t: -1 });
    assert.deepEqual(Object.keys(a).slice(0, 3), ['seq', 't', 'kind']);
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.equal(b.kind, 'busted');
    assert.ok(b.t >= before);
    assert.equal(b.bean, 7);
    assert.equal(j.lastSeq, 2);
    assert.throws(() => j.emit(''), TypeError);
  });

  test('ring buffer keeps N records; since(seq) replays for Last-Event-ID', () => {
    const j = new Journal({ keep: 5 });
    for (let i = 0; i < 12; i++) j.emit('x', { i });
    assert.equal(j.size, 5);
    assert.deepEqual(j.since(0).map((r) => r.seq), [8, 9, 10, 11, 12]); // older than buffer → all buffered
    assert.deepEqual(j.since(9).map((r) => r.seq), [10, 11, 12]);
    assert.deepEqual(j.since(12), []);
    assert.deepEqual(j.since(50), []);
    assert.deepEqual(j.since('abc'), []);
    assert.deepEqual(j.since('10').map((r) => r.seq), [11, 12]);
  });

  test('subscribe / unsubscribe; a throwing subscriber does not break emit', () => {
    const logs = [];
    const j = new Journal({ log: (m) => logs.push(m) });
    const got = [];
    const unsub = j.subscribe((r) => got.push(r.seq));
    j.subscribe(() => {
      throw new Error('boom');
    });
    j.emit('a');
    j.emit('b');
    unsub();
    j.emit('c');
    assert.deepEqual(got, [1, 2]);
    assert.equal(logs.length, 3);
    assert.match(logs[0], /boom/);
  });

  test('query: newest first, kind filter (single or CSV), paging, total', () => {
    const j = new Journal();
    for (const k of ['a', 'b', 'a', 'b', 'a', 'c']) j.emit(k);
    const all = j.query();
    assert.equal(all.total, 6);
    assert.deepEqual(all.rows.map((r) => r.seq), [6, 5, 4, 3, 2, 1]);
    const a = j.query({ kind: 'a', limit: 2, offset: 1 });
    assert.equal(a.total, 3);
    assert.deepEqual(a.rows.map((r) => r.seq), [3, 1]);
    const ab = j.query({ kind: 'a,b', limit: 3 });
    assert.equal(ab.total, 5);
    assert.deepEqual(ab.rows.map((r) => r.seq), [5, 4, 3]);
    assert.deepEqual(j.query({ limit: 0 }).rows, []);
    assert.equal(j.query({ kind: 'zzz' }).total, 0);
    assert.equal(j.query({ offset: 10 }).rows.length, 0);
  });

  test('appends jsonl to a file (creating the dir) and rotates past maxFileBytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bean-journal-'));
    try {
      const file = path.join(dir, 'nested', 'journal.jsonl');
      const j = new Journal({ file });
      j.emit('a', { n: 1 });
      j.emit('b', { n: 2 });
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(lines.map((l) => [l.seq, l.kind, l.n]), [[1, 'a', 1], [2, 'b', 2]]);

      const small = new Journal({ file: path.join(dir, 'small.jsonl'), maxFileBytes: 200 });
      for (let i = 0; i < 10; i++) small.emit('pad', { text: 'x'.repeat(40) });
      assert.ok(fs.existsSync(path.join(dir, 'small.jsonl.1')), 'rotated generation exists');
      assert.ok(fs.statSync(path.join(dir, 'small.jsonl')).size <= 200);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unwritable file logs once and the journal keeps working in memory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bean-journal-'));
    try {
      const logs = [];
      const j = new Journal({ file: dir /* a directory: append fails */, log: (m) => logs.push(m) });
      j.emit('a');
      j.emit('b');
      assert.equal(j.size, 2);
      assert.equal(logs.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reopening a jsonl that is ahead of the saved state continues after its newest seq (crash recovery)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bean-journal-'));
    try {
      const file = path.join(dir, 'journal.jsonl');
      const before = new Journal({ file });
      for (let i = 0; i < 5; i++) before.emit('k', { i });
      const saved = JSON.parse(JSON.stringify(before.serialize())); // state saved at seq 5 …
      for (let i = 0; i < 3; i++) before.emit('k', { i }); // … then 3 more records reach the file before a crash
      fs.appendFileSync(file, '{"seq":9,"t":1,"kind":"torn'); // a torn last line is ignored

      const after = new Journal({ file });
      after.restore(saved);
      assert.equal(after.emit('next').seq, 9, 'numbering continues after the file, not after the saved state');
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      assert.equal(lines.at(-1), '', 'file ends with a newline');
      assert.equal(lines.at(-3), '{"seq":9,"t":1,"kind":"torn', 'the torn line is left alone');
      const seqs = lines.flatMap((l) => {
        try { return [JSON.parse(l).seq]; } catch { return []; }
      });
      assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9], 'the new record starts on its own line; no duplicate seq');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('serialize / restore continues seq and trims to keep', () => {
    const j = new Journal();
    for (let i = 0; i < 8; i++) j.emit('k', { i });
    const saved = JSON.parse(JSON.stringify(j.serialize()));
    const k = new Journal({ keep: 3 });
    assert.equal(k.restore(saved), true);
    assert.equal(k.size, 3);
    assert.deepEqual(k.query().rows.map((r) => r.seq), [8, 7, 6]);
    assert.equal(k.emit('next').seq, 9);
    assert.deepEqual(k.since(7).map((r) => r.seq), [8, 9]);
    assert.equal(k.restore(null), false);
  });
});

// ---- store ---------------------------------------------------------------------------------------

describe('store', () => {
  const withDir = (fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bean-store-'));
    try {
      return fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const quiet = { log: () => {} };

  test('atomic round trip, creates the directory, overwrites, leaves no temp files', () =>
    withDir((dir) => {
      const file = path.join(dir, 'a', 'b', 'state.json');
      const state = { v: 1, bots: [{ id: 'bot-0000', real: { szi: -4.43 } }], text: 'ไทย ✓' };
      const bytes = saveState(file, state);
      assert.ok(bytes > 0);
      assert.deepEqual(loadState(file, quiet), state);
      saveState(file, { v: 2 }); // rename over an existing file
      assert.deepEqual(loadState(file, quiet), { v: 2 });
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
    }));

  test('saving while the target is open for reading still replaces it', () =>
    withDir((dir) => {
      const file = path.join(dir, 'state.json');
      saveState(file, { v: 1 });
      const fd = fs.openSync(file, 'r');
      try {
        saveState(file, { v: 2 });
      } finally {
        fs.closeSync(fd);
      }
      assert.deepEqual(loadState(file, quiet), { v: 2 });
    }));

  test('retries transient EPERM on rename, then falls back to a .bak swap', () =>
    withDir((dir) => {
      const file = path.join(dir, 'state.json');
      saveState(file, { v: 1 });
      const realRename = fs.renameSync;
      try {
        let failures = 2;
        fs.renameSync = (src, dst) => {
          if (failures-- > 0) throw Object.assign(new Error('EPERM: busy'), { code: 'EPERM' });
          return realRename(src, dst);
        };
        saveState(file, { v: 2 });
        assert.deepEqual(loadState(file, quiet), { v: 2 });

        // The target can never be replaced in place (held without share-delete): swap via .bak.
        fs.renameSync = (src, dst) => {
          if (String(src).endsWith('.tmp') && fs.existsSync(dst)) throw Object.assign(new Error('EPERM: locked'), { code: 'EPERM' });
          return realRename(src, dst);
        };
        saveState(file, { v: 3 });
      } finally {
        fs.renameSync = realRename;
      }
      assert.deepEqual(loadState(file, quiet), { v: 3 });
      assert.deepEqual(fs.readdirSync(dir), ['state.json']);
    }));

  test('missing → null, corrupt → null (logged), corrupt main falls back to .bak', () =>
    withDir((dir) => {
      const logs = [];
      const log = (m) => logs.push(m);
      assert.equal(loadState(path.join(dir, 'nope.json'), { log }), null);
      const file = path.join(dir, 'state.json');
      fs.writeFileSync(file, '{"half": ');
      assert.equal(loadState(file, { log }), null);
      assert.ok(logs.some((m) => /corrupt/.test(m)));
      fs.writeFileSync(`${file}.bak`, JSON.stringify({ from: 'bak' }));
      assert.deepEqual(loadState(file, { log }), { from: 'bak' });
    }));

  test('non-serialisable input throws and writes nothing', () =>
    withDir((dir) => {
      const file = path.join(dir, 's.json');
      assert.throws(() => saveState(file, undefined), TypeError);
      const cyclic = {};
      cyclic.self = cyclic;
      assert.throws(() => saveState(file, cyclic));
      assert.deepEqual(fs.readdirSync(dir), []);
    }));
});

// ---- LiveLayer: create ---------------------------------------------------------------------------

describe('LiveLayer create', () => {
  test('mirrors immediately: one Open Long fill at mid + 1.5 bp with a 4.5 bp fee', () => {
    const env = setup();
    btcLong(env);
    const row = env.live.create({ bean: 1, capital_usd: 100, confirm: 'ignored' });

    assert.deepEqual(Object.keys(row), BOT_ROW_KEYS);
    assert.deepEqual(Object.keys(row.real), REAL_KEYS);
    assert.equal(row.id, 'bot-0000');
    assert.equal(row.index, 0);
    assert.equal(row.state, 'active');
    assert.equal(row.leverage, 1);
    assert.equal(row.sz_decimals, 5);
    assert.equal(row.target_sz, 0.00125);
    assert.equal(row.real.szi, 0.00125);
    assert.equal(row.fills, 1);
    assert.equal(row.orders, 1);
    assert.equal(row.created_ms, 1_000_000);
    assert.equal(row.last_reconcile_ms, 1_000_000);
    assert.equal(row.note, null);

    const px = 80_000 * (1 + SLIP);
    near(row.real.entry_px, px);
    const fee = 0.00125 * px * FEE;
    near(row.fees, fee);
    near(row.realized_pnl, -fee);
    near(row.volume, 0.00125 * px);
    near(row.notional_usd, 0.00125 * 80_000);
    near(row.real.unrealized_pnl, 0.00125 * (80_000 - px));

    const [fill] = env.live.fills().rows;
    assert.deepEqual(Object.keys(fill), ['bot', 'coin', 'dir', 'side', 'sz', 'px', 'fee', 'closed_pnl', 'time_ms', 'tick']);
    assert.equal(fill.dir, 'Open Long');
    assert.equal(fill.side, 'B');
    assert.equal(fill.sz, 0.00125);
    assert.equal(fill.closed_pnl, 0);
    assert.equal(fill.time_ms, env.engine.market.timeMs, 'fills carry market time');
    assert.equal(fill.tick, null, 'no tick has run yet');

    const [order] = env.live.orders().rows;
    assert.deepEqual(order, { bot: 'bot-0000', coin: 'BTC', kind: 'mirror', sz: 0.00125, px: fill.px, status: 'filled', reason: 'create', time_ms: fill.time_ms, tick: null });
  });

  test('emits bot_created, bot_order, bot_fill with the SPEC fields', () => {
    const env = setup();
    btcLong(env);
    env.live.create({ bean: 1, capital_usd: 100 });
    const recs = env.events();
    assert.deepEqual(recs.map((r) => r.kind), ['bot_created', 'bot_order', 'bot_fill']);
    const strip = ({ seq, t, kind, ...rest }) => rest;
    assert.deepEqual(strip(recs[0]), { bot: 'bot-0000', bean: 1, coin: 'BTC', capital_usd: 100, leverage: 1 });
    // The order kind cannot use `kind` (that is the record/SSE event name) → `order_kind`.
    assert.equal(recs[1].kind, 'bot_order');
    assert.deepEqual(Object.keys(strip(recs[1])), ['bot', 'coin', 'order_kind', 'sz', 'px', 'status', 'reason']);
    assert.equal(recs[1].order_kind, 'mirror');
    assert.equal(recs[1].reason, 'create');
    assert.deepEqual(Object.keys(strip(recs[2])), ['bot', 'coin', 'dir', 'sz', 'px', 'fee', 'closed_pnl', 'time_ms', 'tick']);
    assert.equal(recs[2].dir, 'Open Long');
    assert.equal(recs[2].time_ms, env.engine.market.timeMs, 'bot_fill carries the fill time');
    assert.equal(recs[2].tick, null);
    assert.ok(!('liquidation' in recs[2]), 'liquidation: true only on liquidation fills');
  });

  test('flat bean: bot created, nothing to mirror yet', () => {
    const env = setup();
    env.engine.addBean(1, { coin: 'ETH' });
    const row = env.live.create({ bean: 1, capital_usd: 50 });
    assert.equal(row.real.szi, 0);
    assert.equal(row.fills, 0);
    assert.equal(row.orders, 0);
    assert.equal(row.real.entry_px, null);
    assert.equal(row.real.liquidation_px, null);
  });

  test('leverage = min(bean leverage, venue max) and sizes floor to sz_decimals', () => {
    const env = setup();
    // SOL max 20×: bean at 25× with position_size 0.5 needs 12.5× ≤ 20 → allowed, bot runs 20×.
    env.engine.addBean(1, { coin: 'SOL', leverage: 25, position_size: 0.5, side: -1, units: -123.456 });
    const sol = env.live.create({ bean: 1, capital_usd: 50 });
    assert.equal(sol.leverage, 20);
    assert.equal(sol.real.leverage, 20);
    assert.equal(sol.target_sz, -6.17); // 123.456 × 0.05 = 6.1728 → 6.17, short
    assert.equal(sol.real.szi, -6.17);
    assert.equal(env.live.fills().rows[0].dir, 'Open Short');
    assert.equal(env.live.fills().rows[0].side, 'A');

    // XRP has 0 size decimals: 4321.9 × 0.03 = 129.657 → 129.
    env.engine.addBean(2, { coin: 'XRP', leverage: 3, position_size: 0.5, side: 1, units: 4321.9 });
    const xrp = env.live.create({ bean: 2, capital_usd: 30 });
    assert.equal(xrp.leverage, 3);
    assert.equal(xrp.real.szi, 129);
  });

  test('below min order: skipped once (no spam), no fill; note warns when entries are too small', () => {
    const env = setup();
    // ETH long 0.1 → $20 of water mirrors 0.002 ETH ≈ $6 < $10 minimum.
    env.engine.addBean(1, { coin: 'ETH', position_size: 0.3, side: 1, units: 0.1 });
    const row = env.live.create({ bean: 1, capital_usd: 20 });
    assert.equal(row.fills, 0);
    assert.equal(row.orders, 1);
    assert.equal(row.real.szi, 0);
    assert.equal(row.target_sz, 0.002);
    assert.match(row.note, /below the \$10 minimum/);
    assert.equal(row.last_error, null, 'a skipped tiny order is not an error');
    const [order] = env.live.orders().rows;
    assert.equal(order.status, 'skipped');
    assert.equal(order.reason, 'below_min_order');
    env.tick();
    env.tick();
    assert.equal(env.live.botDetail('bot-0000').bot.orders, 1, 'same situation is not re-logged');

    // Scaled size rounding to zero while the bean is positioned is also a (single) skip.
    env.engine.addBean(2, { coin: 'BTC', position_size: 0.01, side: 1, units: 0.0001 });
    const tiny = env.live.create({ bean: 2, capital_usd: 20 }); // 0.000002 BTC → 0
    assert.equal(tiny.target_sz, 0);
    assert.equal(tiny.orders, 1);
    env.tick();
    assert.equal(env.live.botDetail('bot-0001').bot.orders, 1);
  });

  test('numeric strings are accepted for bean and capital_usd', () => {
    const env = setup();
    btcLong(env);
    assert.equal(env.live.create({ bean: '1', capital_usd: '100' }).capital_usd, 100);
  });
});

// ---- LiveLayer: rejections -------------------------------------------------------------------------

describe('LiveLayer rejections', () => {
  test('400 for bad bean / capital, 404 unknown bean', () => {
    const env = setup();
    btcLong(env);
    rejects(() => env.live.create({ bean: 1.5, capital_usd: 100 }), 400, /bean/);
    rejects(() => env.live.create({ bean: 'x', capital_usd: 100 }), 400);
    rejects(() => env.live.create({ bean: -1, capital_usd: 100 }), 400);
    rejects(() => env.live.create({ capital_usd: 100 }), 400);
    for (const c of [NaN, 19.99, 1000.01, 'abc', null, Infinity]) rejects(() => env.live.create({ bean: 1, capital_usd: c }), 400, /capital_usd/);
    rejects(() => env.live.create({ bean: 99, capital_usd: 100 }), 404, /unknown bean 99/);
    assert.equal(env.live.create({ bean: 1, capital_usd: 20 }).capital_usd, 20, 'bounds are inclusive');
  });

  test('409 not tradeable: busted, bean_bound, coin_bound, leverage, unlisted', () => {
    const env = setup();
    btcLong(env, 1);
    env.engine.addBean(2, { coin: 'BTC' });
    env.engine.addBean(3, { coin: 'ETH', busted: true });
    env.engine.addBean(4, { coin: 'VVV', leverage: 10, position_size: 0.5 }); // needs 5× > 3×
    env.engine.addBean(5, { coin: 'NOPE' });
    env.live.create({ bean: 1, capital_usd: 100 });
    rejects(() => env.live.create({ bean: 1, capital_usd: 100 }), 409, /bean_bound/);
    rejects(() => env.live.create({ bean: 2, capital_usd: 100 }), 409, /coin_bound.*bot-0000/);
    rejects(() => env.live.create({ bean: 3, capital_usd: 100 }), 409, /busted/);
    rejects(() => env.live.create({ bean: 4, capital_usd: 100 }), 409, /leverage.*5\.0×.*3×/);
    rejects(() => env.live.create({ bean: 5, capital_usd: 100 }), 409, /unlisted/);
  });

  test('409 when open bots reach max_bots (closed bots do not count)', () => {
    const env = setup({ maxBots: 2 });
    ['BTC', 'ETH', 'SOL'].forEach((coin, i) => env.engine.addBean(i, { coin }));
    env.live.create({ bean: 0, capital_usd: 50 });
    env.live.create({ bean: 1, capital_usd: 50 });
    rejects(() => env.live.create({ bean: 2, capital_usd: 50 }), 409, /bot cap/);
    env.live.pause({ id: 'bot-0001' });
    rejects(() => env.live.create({ bean: 2, capital_usd: 50 }), 409, /bot cap/, 'paused bots are still open');
    env.live.close({ id: 'bot-0001' });
    assert.equal(env.live.create({ bean: 2, capital_usd: 50 }).id, 'bot-0002');
  });

  test('409 when capital exceeds available cash (account value − deployed)', () => {
    const env = setup({ accountUsd: 150 });
    btcLong(env, 1);
    env.engine.addBean(2, { coin: 'ETH' });
    env.live.create({ bean: 1, capital_usd: 100 }); // pays a fee → slightly < $50 left
    rejects(() => env.live.create({ bean: 2, capital_usd: 50 }), 409, /not enough cash/);
    assert.ok(env.live.status().available_usd < 50);
    assert.equal(env.live.create({ bean: 2, capital_usd: 49 }).state, 'active');
  });

  test('409 when open notional + projected entry would exceed max_total_notional_usd', () => {
    const env = setup({ maxTotalNotionalUsd: 500 });
    env.engine.addBean(1, { coin: 'SOL', leverage: 10, position_size: 1 }); // 10× of $100 → $1000 per entry
    rejects(() => env.live.create({ bean: 1, capital_usd: 100 }), 409, /notional cap/);
    assert.equal(env.live.create({ bean: 1, capital_usd: 40 }).capital_usd, 40); // $400 fits
  });

  test('the create-time cap uses what a POSITIONED bean opens right away: |units| × capital/1000 × price', () => {
    // per-entry size at today's equity would be 1 × 1 × 4000 × 0.1 = $400 (fits $500), but the bot mirrors the
    // bean's existing 0.25 BTC at once: 0.25 × 0.1 × 80 000 = $2 000 → refused
    const env = setup({ maxTotalNotionalUsd: 500 });
    env.engine.addBean(1, { coin: 'BTC', leverage: 1, position_size: 1, equity: 4000, side: 1, units: 0.25 });
    rejects(() => env.live.create({ bean: 1, capital_usd: 100 }), 409, /notional cap: .*~\$2000\.00 now/);
    // and the opposite: a big per-entry figure but a small held position is allowed
    env.engine.addBean(2, { coin: 'ETH', leverage: 10, position_size: 1, equity: 1000, side: -1, units: -0.5 });
    assert.equal(env.live.create({ bean: 2, capital_usd: 100 }).state, 'active'); // 0.5 × 0.1 × 3000 = $150
  });

  test('404 unknown bot, 400 missing id, 400 bad state filter', () => {
    const env = setup();
    for (const fn of ['pause', 'resume', 'close']) rejects(() => env.live[fn]({ id: 'bot-0042' }), 404, /unknown bot/);
    rejects(() => env.live.pause({}), 400);
    rejects(() => env.live.botDetail('bot-0001'), 404);
    rejects(() => env.live.fills({ bot: 'bot-0001' }), 404);
    rejects(() => env.live.bots({ state: 'weird' }), 400);
  });

  test('ApiError serialises as { error, status }', () => {
    const err = new ApiError(409, 'nope');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'ApiError');
    assert.deepEqual(JSON.parse(JSON.stringify(err)), { error: 'nope', status: 409 });
  });
});

// ---- LiveLayer: tick mirroring ---------------------------------------------------------------------

describe('LiveLayer tick mirroring', () => {
  test('flip long → short is one order with two fills (close then open); PnL and fees add up', () => {
    const env = setup();
    btcLong(env);
    env.live.create({ bean: 1, capital_usd: 100 });
    env.engine.market.prices.BTC = 82_000;
    env.engine.setBean(1, { side: -1, units: -0.0125 });
    const tick = env.tick();

    const fills = env.live.fills({ bot: 'bot-0000' }).rows; // newest first
    assert.equal(fills.length, 3);
    const [open, close] = fills;
    const buyPx = 80_000 * (1 + SLIP);
    const sellPx = 82_000 * (1 - SLIP);
    assert.equal(close.dir, 'Close Long');
    assert.equal(close.side, 'A');
    assert.equal(close.sz, 0.00125);
    near(close.px, sellPx);
    near(close.closed_pnl, (sellPx - buyPx) * 0.00125);
    assert.equal(open.dir, 'Open Short');
    assert.equal(open.side, 'A');
    assert.equal(open.sz, 0.00125);
    assert.equal(open.tick, tick);
    assert.equal(open.time_ms, env.engine.market.timeMs);

    const orders = env.live.orders({ bot: 'bot-0000' }).rows;
    assert.equal(orders.length, 2);
    assert.equal(orders[0].sz, -0.0025);
    assert.equal(orders[0].reason, 'tick');

    const bot = env.live.botDetail('bot-0000').bot;
    assert.equal(bot.real.szi, -0.00125);
    near(bot.real.entry_px, sellPx);
    assert.equal(bot.bean_side, -1);
    assert.equal(bot.fills, 3);
    assert.equal(bot.orders, 2);
    const totalFees = fills.reduce((s, f) => s + f.fee, 0);
    const totalClosed = fills.reduce((s, f) => s + f.closed_pnl, 0);
    near(bot.fees, totalFees);
    near(bot.realized_pnl, totalClosed - totalFees, 2e-6);
    near(bot.volume, 0.00125 * buyPx + 2 * 0.00125 * sellPx, 1e-5);

    // Bean goes flat → close the short (target 0 always closes, whatever the size).
    env.engine.setBean(1, { side: 0, units: 0 });
    env.tick();
    const last = env.live.fills({ bot: 'bot-0000', limit: 1 }).rows[0];
    assert.equal(last.dir, 'Close Short');
    assert.equal(last.side, 'B');
    assert.equal(env.live.botDetail('bot-0000').bot.real.szi, 0);
  });

  test('unchanged bean → no orders; growth past min order → increase keeps a weighted entry', () => {
    const env = setup();
    btcLong(env);
    env.live.create({ bean: 1, capital_usd: 100 });
    env.tick();
    env.tick();
    assert.equal(env.live.botDetail('bot-0000').bot.orders, 1);

    env.engine.market.prices.BTC = 90_000;
    env.engine.setBean(1, { units: 0.025 }); // doubled → +0.00125 BTC ($112) to buy
    env.tick();
    const bot = env.live.botDetail('bot-0000').bot;
    assert.equal(bot.real.szi, 0.0025);
    near(bot.real.entry_px, (80_000 * (1 + SLIP) + 90_000 * (1 + SLIP)) / 2, 1e-4);
    assert.equal(env.live.fills({ limit: 1 }).rows[0].dir, 'Open Long');

    env.engine.setBean(1, { units: 0.0125 }); // partial reduce
    env.tick();
    const r = env.live.botDetail('bot-0000').bot;
    assert.equal(r.real.szi, 0.00125);
    near(r.real.entry_px, bot.real.entry_px, 1e-4, 'reducing keeps the entry price');
    assert.equal(env.live.fills({ limit: 1 }).rows[0].dir, 'Close Long');
  });

  test('afterTick refreshes bean snapshot, last_reconcile_ms and marks', () => {
    const env = setup();
    btcLong(env);
    env.live.create({ bean: 1, capital_usd: 100 });
    env.engine.setBean(1, { equity: 1100 });
    env.engine.market.prices.BTC = 84_000;
    env.tick();
    const bot = env.live.botDetail('bot-0000').bot;
    assert.equal(bot.bean_equity, 1100);
    assert.equal(bot.last_reconcile_ms, env.clock.ms);
    assert.equal(bot.updated_ms, env.clock.ms);
    assert.equal(bot.real.as_of_ms, env.clock.ms);
    near(bot.real.unrealized_pnl, 0.00125 * (84_000 - 80_000 * (1 + SLIP)));
    assert.equal(env.live.status().last_reconcile_ms, env.clock.ms);
  });

  test('notional cap at mirror time: skipped + error once, cleared when back in sync', () => {
    const env = setup({ maxTotalNotionalUsd: 500 });
    env.engine.addBean(1, { coin: 'BTC', position_size: 0.1 }); // projected $10 per entry
    env.live.create({ bean: 1, capital_usd: 100 });
    env.engine.setBean(1, { side: 1, units: 0.1 }); // ×0.1 → 0.01 BTC = $800 > $500
    env.tick();
    env.tick();
    let bot = env.live.botDetail('bot-0000').bot;
    assert.equal(bot.real.szi, 0);
    assert.match(bot.last_error, /notional cap/);
    assert.equal(bot.orders, 1, 'one skipped order, not one per tick');
    assert.equal(env.events('live_error').length, 1);
    assert.match(env.live.status().last_error, /bot-0000: notional cap/);
    assert.equal(env.live.orders().rows[0].reason, 'notional_cap');

    env.engine.setBean(1, { side: 0, units: 0 });
    env.tick();
    bot = env.live.botDetail('bot-0000').bot;
    assert.equal(bot.last_error, null);
    assert.equal(bot.last_error_ms, null);
    assert.equal(env.live.status().last_error, null);
  });

  test('missing price → error (once) and no trade; recovers when the price returns', () => {
    const env = setup();
    btcLong(env);
    env.live.create({ bean: 1, capital_usd: 100 });
    env.engine.market.prices.BTC = null;
    env.engine.setBean(1, { side: 0, units: 0 });
    env.tick();
    env.tick();
    let bot = env.live.botDetail('bot-0000').bot;
    assert.equal(bot.real.szi, 0.00125, 'cannot trade without a price');
    assert.equal(bot.last_error, 'no price for BTC');
    assert.equal(env.events('live_error').length, 1);
    near(bot.notional_usd, 0.00125 * 80_000, 1e-6, 'marks keep the last good price');
    env.engine.market.prices.BTC = 81_000;
    env.tick();
    bot = env.live.botDetail('bot-0000').bot;
    assert.equal(bot.real.szi, 0);
    assert.equal(bot.last_error, null);
  });

  test('liquidation: adverse move past liquidation_px closes at that price and pauses the bot', () => {
    const env = setup();
    // 10× long: 0.125 BTC ($10k) for the bean → 0.0125 BTC for $100 of water.
    env.engine.addBean(1, { coin: 'BTC', leverage: 10, position_size: 1, side: 1, units: 0.125 });
    const row = env.live.create({ bean: 1, capital_usd: 100 });
    const entry = 80_000 * (1 + SLIP);
    const liq = entry * (1 - 0.95 / 10);
    near(row.real.liquidation_px, liq, 1e-4);
    near(row.real.margin_used, (0.0125 * entry) / 10 + row.real.unrealized_pnl, 1e-6);

    env.engine.market.prices.BTC = 72_000; // the bean (bought earlier) still holds
    env.tick();
    const bot = env.live.botDetail('bot-0000').bot;
    assert.equal(bot.state, 'paused');
    assert.equal(bot.note, 'liquidated');
    assert.equal(bot.real.szi, 0);
    const fill = env.live.fills({ limit: 1 }).rows[0];
    assert.equal(fill.dir, 'Close Long');
    near(fill.px, liq, 1e-4);
    // Same model as a paper bean: the whole initial margin is lost and no taker fee is charged.
    const margin = (0.0125 * entry) / 10;
    near(fill.closed_pnl, -margin, 1e-5);
    assert.equal(fill.fee, 0);
    near(bot.realized_pnl, -margin - 0.0125 * entry * FEE, 2e-6, 'open fee + whole margin');
    assert.equal(env.live.orders({ limit: 1 }).rows[0].reason, 'liquidation');
    const paused = env.events('bot_paused');
    assert.equal(paused.at(-1).reason, 'liquidated');
    const ev = env.events('bot_fill').at(-1);
    assert.equal(ev.liquidation, true);
    assert.equal(ev.time_ms, env.engine.market.timeMs);
    assert.equal(ev.tick, 1);
  });

  test('notional cap with moving prices: one live_error and one skip, last_error_ms stays at the start', () => {
    const env = setup({ maxTotalNotionalUsd: 500 });
    env.engine.addBean(1, { coin: 'BTC', position_size: 0.1 });
    env.live.create({ bean: 1, capital_usd: 100 });
    env.engine.setBean(1, { side: 1, units: 0.1 }); // 0.01 BTC ≈ $800 > $500
    env.tick();
    const startedMs = env.clock.ms;
    const firstText = env.live.botDetail('bot-0000').bot.last_error;
    for (let i = 1; i <= 10; i++) {
      env.engine.market.prices.BTC = 80_000 + 7 * i; // the blocked notional changes every tick
      env.tick();
    }
    const bot = env.live.botDetail('bot-0000').bot;
    assert.equal(env.events('live_error').length, 1, 'no live_error per tick');
    assert.equal(bot.orders, 1, 'one skipped order');
    assert.equal(bot.last_error_ms, startedMs, 'last_error_ms marks when the block started');
    assert.notEqual(bot.last_error, firstText, 'the text still tracks the current numbers');
    assert.match(bot.last_error, /\$800\.70 would exceed/);
    assert.equal(env.live.status().last_error_ms, startedMs);
  });

  test('a flip blocked by the notional cap still closes the old side; the open leg waits', () => {
    const env = setup({ maxTotalNotionalUsd: 1000 });
    env.engine.addBean(1, { coin: 'BTC', position_size: 0.1, side: 1, units: 0.1 }); // bot: 0.01 BTC = $800
    env.live.create({ bean: 1, capital_usd: 100 });
    assert.equal(env.live.botDetail('bot-0000').bot.real.szi, 0.01);

    env.engine.setBean(1, { side: -1, units: -0.15 }); // target −0.015 BTC = $1200 > $1000
    env.tick();
    let bot = env.live.botDetail('bot-0000').bot;
    assert.equal(bot.real.szi, 0, 'never left holding the side the bean has left');
    assert.equal(bot.bean_side, -1);
    assert.match(bot.last_error, /notional cap/);
    const [skip, close] = env.live.orders({ bot: 'bot-0000' }).rows;
    assert.equal(close.status, 'filled');
    assert.equal(close.sz, -0.01);
    assert.equal(skip.status, 'skipped');
    assert.equal(skip.reason, 'notional_cap');
    assert.equal(skip.sz, -0.015);
    assert.equal(env.live.fills({ limit: 1 }).rows[0].dir, 'Close Long');

    env.engine.market.prices.BTC = 80_050;
    env.tick();
    bot = env.live.botDetail('bot-0000').bot;
    assert.equal(bot.orders, 3, 'the blocked open leg is not re-logged');
    assert.equal(env.events('live_error').length, 1);

    env.engine.setBean(1, { units: -0.1 }); // −0.01 BTC fits → opens short, error clears
    env.tick();
    bot = env.live.botDetail('bot-0000').bot;
    assert.equal(bot.real.szi, -0.01);
    assert.equal(bot.last_error, null);
  });

  test('a grown bean makes the bot post more margin than its water; available cash reserves it', () => {
    // Equity 2000, 10× at full size → 2× its paper capital per entry (needs 20× ≤ BTC 40×).
    const env = setup({ accountUsd: 300 });
    env.engine.addBean(1, { coin: 'BTC', leverage: 10, position_size: 1, equity: 2000, side: 1, units: 0.25 });
    env.engine.addBean(2, { coin: 'ETH' });
    const row = env.live.create({ bean: 1, capital_usd: 100 });
    assert.equal(row.leverage, 10, 'leverage stays min(bean, venue) — SPEC §2.6');
    near(row.notional_usd, 2000);
    const initialMargin = (0.025 * 80_000 * (1 + SLIP)) / 10;
    assert.ok(initialMargin > 100, 'water scales the bean, it is not a loss cap');
    const st = env.live.status();
    assert.equal(st.deployed_usd, 100);
    near(st.available_usd, 300 + row.realized_pnl + row.real.unrealized_pnl - initialMargin, 1e-5);
    rejects(() => env.live.create({ bean: 2, capital_usd: 100 }), 409, /not enough cash/);
  });
});

// ---- LiveLayer: lifecycle ---------------------------------------------------------------------------

describe('LiveLayer pause / resume / close / bust / halt', () => {
  test('pause flattens and stops mirroring; resume mirrors now; close retires; repeated close → 409', () => {
    const env = setup();
    btcLong(env);
    env.live.create({ bean: 1, capital_usd: 100 });

    const paused = env.live.pause({ id: 'bot-0000' });
    assert.equal(paused.state, 'paused');
    assert.equal(paused.real.szi, 0);
    assert.equal(paused.target_sz, 0);
    assert.equal(paused.note, null);
    assert.equal(env.live.fills({ limit: 1 }).rows[0].dir, 'Close Long');
    assert.equal(env.live.orders({ limit: 1 }).rows[0].kind, 'flatten');
    assert.equal(env.events('bot_paused').at(-1).reason, 'manual');

    env.engine.setBean(1, { units: 0.025 });
    env.tick();
    assert.equal(env.live.botDetail('bot-0000').bot.real.szi, 0, 'paused bots do not mirror');
    assert.equal(env.live.botDetail('bot-0000').bot.bean_units, 0.025, 'but still show the bean');
    assert.equal(env.live.pause({ id: 'bot-0000' }).fills, 2, 'pausing again is a no-op');

    const resumed = env.live.resume({ id: 'bot-0000' });
    assert.equal(resumed.state, 'active');
    assert.equal(resumed.real.szi, 0.0025, 'mirrored immediately on resume');
    assert.equal(env.live.orders({ limit: 1 }).rows[0].reason, 'resume');
    assert.equal(env.live.resume({ id: 'bot-0000' }).fills, 3, 'resuming an active bot is a no-op');

    env.clock.ms += 1234;
    const closed = env.live.close({ id: 'bot-0000' });
    assert.equal(closed.state, 'closed');
    assert.equal(closed.closed_ms, env.clock.ms);
    assert.equal(closed.real.szi, 0);
    assert.equal(closed.fills, 4);
    const ev = env.events('bot_closed').at(-1);
    assert.equal(ev.bot, 'bot-0000');
    assert.equal(ev.realized_pnl, closed.realized_pnl);
    rejects(() => env.live.close({ id: 'bot-0000' }), 409, /already closed/);
    rejects(() => env.live.pause({ id: 'bot-0000' }), 409);
    rejects(() => env.live.resume({ id: 'bot-0000' }), 409);

    env.tick();
    assert.equal(env.live.botDetail('bot-0000').bot.fills, 4, 'closed bots are frozen');
    // Coin and bean are free again.
    assert.equal(env.live.create({ bean: 1, capital_usd: 100 }).id, 'bot-0001');
    assert.deepEqual(env.events().filter((r) => r.kind.startsWith('bot_') && r.kind !== 'bot_order' && r.kind !== 'bot_fill').map((r) => r.kind), [
      'bot_created', 'bot_paused', 'bot_resumed', 'bot_closed', 'bot_created',
    ]);
  });

  test('bean busts → active bot auto-paused + flattened with note "bean busted"; resume refused', () => {
    const env = setup();
    btcLong(env);
    env.live.create({ bean: 1, capital_usd: 100 });
    env.engine.setBean(1, { busted: true, side: 0, units: 0, equity: 5 });
    env.tick();
    const bot = env.live.botDetail('bot-0000').bot;
    assert.equal(bot.state, 'paused');
    assert.equal(bot.note, 'bean busted');
    assert.equal(bot.real.szi, 0);
    assert.equal(env.live.orders({ limit: 1 }).rows[0].reason, 'bean_busted');
    const ev = env.events('bot_paused').at(-1);
    assert.deepEqual([ev.bot, ev.reason], ['bot-0000', 'bean busted']);
    rejects(() => env.live.resume({ id: 'bot-0000' }), 409, /busted/);
    env.tick();
    assert.equal(env.events('bot_paused').length, 1, 'paused once');
  });

  test('halt closes every open bot, reports, and blocks create/resume until restart', () => {
    const env = setup();
    btcLong(env, 1);
    env.engine.addBean(2, { coin: 'SOL', side: -1, units: -5 });
    env.engine.addBean(3, { coin: 'ETH' });
    env.live.create({ bean: 1, capital_usd: 100 });
    env.live.create({ bean: 2, capital_usd: 200 });
    env.live.pause({ id: 'bot-0001' });

    env.clock.ms += 10;
    const out = env.live.halt();
    assert.equal(out.halted, true);
    assert.deepEqual(out.closed, ['bot-0000', 'bot-0001']);
    const rows = env.live.bots().rows;
    near(out.realized_pnl, rows[0].realized_pnl + rows[1].realized_pnl);
    assert.ok(rows.every((r) => r.state === 'closed' && r.real.szi === 0 && r.note === 'halted'));
    assert.deepEqual(env.events('live_halted').at(-1).closed, ['bot-0000', 'bot-0001']);
    assert.equal(env.events('bot_closed').length, 2);

    const st = env.live.status();
    assert.equal(st.halted, true);
    assert.equal(st.armed, false);
    assert.equal(st.halted_ms, env.clock.ms);
    assert.ok(st.disabled_reason);
    rejects(() => env.live.create({ bean: 3, capital_usd: 50 }), 409, /halted/);
    rejects(() => env.live.resume({ id: 'bot-0001' }), 409, /halted/);
    assert.deepEqual(env.live.venue(env.engine.population.row(3)), { tradeable: false, venue_max_leverage: 25, venue_reason: 'halted', bot: null });

    const again = env.live.halt();
    assert.deepEqual(again, { halted: true, closed: [], realized_pnl: 0 });
  });
});

// ---- LiveLayer: queries & accounting ---------------------------------------------------------------

describe('LiveLayer accounting and queries', () => {
  test('account_value = start + realized + unrealized; deployed, margin, withdrawable, available', () => {
    const env = setup();
    btcLong(env, 1);
    env.engine.addBean(2, { coin: 'ETH' });
    env.live.create({ bean: 1, capital_usd: 100 });
    env.live.create({ bean: 2, capital_usd: 250 });
    env.engine.market.prices.BTC = 84_000;
    env.tick();

    const entry = 80_000 * (1 + SLIP);
    const fee = 0.00125 * entry * FEE;
    const upnl = 0.00125 * (84_000 - entry);
    const margin = 0.00125 * entry + upnl; // 1× isolated: initial margin + uPnL
    const st = env.live.status();
    near(st.realized_pnl, -fee);
    near(st.unrealized_pnl, upnl);
    near(st.account_state.account_value, 10_000 - fee + upnl);
    near(st.account_state.total_margin_used, margin);
    near(st.account_state.withdrawable, 10_000 - fee + upnl - margin);
    near(st.account_state.total_ntl_pos, 0.00125 * 84_000);
    near(st.open_notional_usd, 0.00125 * 84_000);
    assert.equal(st.deployed_usd, 350);
    // available reserves max(water, initial margin) per open bot; slippage puts this 1× entry a hair above $100.
    near(st.available_usd, 10_000 - fee + upnl - Math.max(100, 0.00125 * entry) - 250);
    assert.equal(st.fills_logged, 1);
    assert.deepEqual([st.bots, st.active, st.paused, st.closed], [2, 2, 0, 0]);

    // Closing realizes: unrealized → realized, deployed shrinks, account value unchanged but for exit costs.
    env.live.close({ id: 'bot-0000' });
    const after = env.live.status();
    const exitPx = 84_000 * (1 - SLIP);
    const realized = (exitPx - entry) * 0.00125 - fee - 0.00125 * exitPx * FEE;
    near(after.realized_pnl, realized, 2e-6);
    assert.equal(after.unrealized_pnl, 0);
    near(after.account_state.account_value, 10_000 + realized, 2e-6);
    assert.equal(after.deployed_usd, 250);
    assert.equal(after.closed, 1);
  });

  test('live_status has every SPEC field with sim constants', () => {
    const env = setup();
    const st = env.live.status();
    for (const k of [
      'mode', 'network', 'dry_run', 'armed', 'halted', 'halted_ms', 'disabled_reason', 'bots', 'active', 'paused', 'closed',
      'deployed_usd', 'open_notional_usd', 'realized_pnl', 'unrealized_pnl', 'last_reconcile_ms', 'last_error', 'last_error_ms',
      'fills_logged', 'exchange_stops', 'caps', 'account_state', 'universe',
    ]) assert.ok(k in st, `live_status.${k}`);
    assert.deepEqual([st.mode, st.network, st.dry_run, st.armed, st.halted, st.exchange_stops], ['sim', 'sim', false, true, false, false]);
    assert.deepEqual(st.caps, { max_bots: 10, max_bot_capital_usd: 1000, min_capital_usd: 20, max_total_notional_usd: 10_000 });
    assert.deepEqual(Object.keys(st.account_state), ['account_value', 'withdrawable', 'total_margin_used', 'total_ntl_pos', 'as_of_ms']);
    assert.equal(st.account_state.account_value, LIVE_DEFAULTS.accountUsd);
    assert.deepEqual(st.universe, { coins: Object.keys(VENUE).length, fetched_ms: 1_000_000 });
    assert.equal(st.disabled_reason, null);
    // GAME-DESIGN §10.5: prices, paper, stale_coins (a minimal engine without them reads as sim / none)
    assert.equal(st.prices, 'sim');
    assert.equal(st.paper, true);
    assert.deepEqual(st.stale_coins, []);
  });

  test('venue(row): tradeable flags, reasons, max leverage and bound bot', () => {
    const env = setup();
    btcLong(env, 1);
    env.engine.addBean(2, { coin: 'BTC' });
    env.engine.addBean(3, { coin: 'ETH', busted: true });
    env.engine.addBean(4, { coin: 'VVV', leverage: 10, position_size: 0.5, equity: 1000 });
    env.engine.addBean(5, { coin: 'NOPE' });
    env.engine.addBean(6, { coin: 'VVV', leverage: 10, position_size: 0.3, equity: 1000 }); // exactly 3×
    const v = (id) => env.live.venue(env.engine.population.row(id));
    assert.deepEqual(v(1), { tradeable: true, venue_max_leverage: 40, venue_reason: null, bot: null });
    env.live.create({ bean: 1, capital_usd: 100 });
    assert.deepEqual(v(1), { tradeable: false, venue_max_leverage: 40, venue_reason: 'bean_bound', bot: 'bot-0000' });
    assert.equal(v(2).venue_reason, 'coin_bound');
    assert.equal(v(3).venue_reason, 'busted');
    assert.equal(v(4).venue_reason, 'leverage');
    assert.equal(v(4).venue_max_leverage, 3);
    assert.deepEqual(v(5), { tradeable: false, venue_max_leverage: null, venue_reason: 'unlisted', bot: null });
    assert.equal(v(6).tradeable, true, 'required leverage equal to the venue max is allowed');
    near(requiredLeverage(env.engine.population.row(6)), 3);

    // Through the population hook, BeanRows carry the venue fields.
    const row = env.engine.population.row(1);
    assert.equal(row.tradeable, false);
    assert.equal(row.bot, 'bot-0000');
    env.live.close({ id: 'bot-0000' });
    assert.deepEqual(v(1), { tradeable: true, venue_max_leverage: 40, venue_reason: null, bot: null });
    assert.equal(v(2).tradeable, true);
  });

  test('bots({state}) filters; botDetail bundles bean + logs; fills() newest first with bot filter and limit', () => {
    const env = setup();
    btcLong(env, 1);
    env.engine.addBean(2, { coin: 'SOL', side: 1, units: 10 });
    env.engine.addBean(3, { coin: 'ETH' });
    env.live.create({ bean: 1, capital_usd: 100 });
    env.live.create({ bean: 2, capital_usd: 100 });
    env.live.create({ bean: 3, capital_usd: 100 });
    env.live.pause({ id: 'bot-0001' });
    env.live.close({ id: 'bot-0002' });

    assert.equal(env.live.bots().total, 3);
    assert.equal(env.live.bots({}).mode, 'sim');
    assert.deepEqual(env.live.bots({ state: 'active' }).rows.map((r) => r.id), ['bot-0000']);
    assert.deepEqual(env.live.bots({ state: 'paused' }).rows.map((r) => r.id), ['bot-0001']);
    assert.deepEqual(env.live.bots({ state: 'closed' }).rows.map((r) => r.id), ['bot-0002']);
    assert.deepEqual(env.live.bots({ state: 'open' }).rows.map((r) => r.id), ['bot-0000', 'bot-0001']);
    assert.equal(env.live.bots({ state: 'all' }).total, 3);

    const detail = env.live.botDetail('bot-0001');
    assert.deepEqual(Object.keys(detail), ['bot', 'bean', 'fills', 'orders']);
    assert.equal(detail.bot.id, 'bot-0001');
    assert.equal(detail.bean.id, 2);
    assert.equal(detail.bean.bot, 'bot-0001');
    assert.deepEqual(detail.fills.map((f) => f.dir), ['Close Long', 'Open Long']);
    assert.deepEqual(detail.orders.map((o) => o.kind), ['flatten', 'mirror']);
    assert.equal(env.live.botDetail(1).bot.id, 'bot-0001', 'numeric index accepted');

    const all = env.live.fills();
    assert.equal(all.total, 3);
    assert.deepEqual(all.rows.map((f) => [f.bot, f.dir]), [['bot-0001', 'Close Long'], ['bot-0001', 'Open Long'], ['bot-0000', 'Open Long']]);
    assert.deepEqual(env.live.fills({ bot: 'bot-0000' }).rows.length, 1);
    const one = env.live.fills({ limit: 1 });
    assert.equal(one.rows.length, 1);
    assert.equal(one.total, 3);
    assert.deepEqual(env.live.fills({ limit: 0 }), { rows: [], total: 3 });
  });

  test('fill/order logs keep the last LOG_KEEP records; fills_logged counts all', () => {
    const env = setup();
    btcLong(env);
    env.live.create({ bean: 1, capital_usd: 100 });
    // Flip every tick: 2 fills and 1 order per tick.
    const ticks = Math.ceil(LOG_KEEP / 2) + 10;
    for (let i = 0; i < ticks; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      env.engine.setBean(1, { side, units: side * 0.0125 });
      env.tick();
    }
    const st = env.live.status();
    assert.equal(st.fills_logged, 1 + 2 * ticks);
    assert.equal(env.live.fills({ limit: 5000 }).total, LOG_KEEP);
    assert.equal(env.live.orders({ limit: 5000 }).total, Math.min(LOG_KEEP, 1 + ticks));
    assert.equal(env.live.botDetail('bot-0000').bot.fills, 1 + 2 * ticks);
  });

  test('tick stamp falls back to an engine tick counter before the first afterTick', () => {
    const env = setup();
    env.engine.tickCount = 41;
    env.engine.tick = () => {}; // the real engine's tick() is a method — must be ignored
    btcLong(env);
    env.live.create({ bean: 1, capital_usd: 100 });
    assert.equal(env.live.fills().rows[0].tick, 41);
  });
});

// ---- LiveLayer: persistence -------------------------------------------------------------------------

describe('LiveLayer serialize / restore', () => {
  test('round trip keeps bots, positions, bindings, logs and id sequence; halt resets on restart', () => {
    const env = setup();
    btcLong(env, 1);
    env.engine.addBean(2, { coin: 'SOL', side: -1, units: -5 });
    env.engine.addBean(3, { coin: 'BTC' });
    env.engine.addBean(4, { coin: 'ETH' });
    env.live.create({ bean: 1, capital_usd: 100 });
    env.live.create({ bean: 2, capital_usd: 100 });
    env.live.close({ id: 'bot-0001' });
    env.tick();
    const before = env.live.bots().rows;
    const statusBefore = env.live.status();
    const saved = JSON.parse(JSON.stringify(env.live.serialize()));

    const live2 = new LiveLayer({ config: {}, engine: env.engine, journal: env.journal, now: () => env.clock.ms, log: () => {} });
    assert.equal(live2.restore(saved), true);
    assert.deepEqual(live2.bots().rows, before);
    assert.equal(live2.status().realized_pnl, statusBefore.realized_pnl);
    assert.equal(live2.status().fills_logged, statusBefore.fills_logged);
    assert.equal(live2.fills().total, env.live.fills().total);
    rejects(() => live2.create({ bean: 3, capital_usd: 50 }), 409, /coin_bound/);
    assert.equal(live2.create({ bean: 4, capital_usd: 50 }).id, 'bot-0002');

    // Halt is not persisted: a restart re-arms.
    live2.halt();
    const live3 = new LiveLayer({ engine: env.engine, now: () => env.clock.ms, log: () => {} });
    live3.restore(JSON.parse(JSON.stringify(live2.serialize())));
    assert.equal(live3.status().halted, false);
    assert.equal(live3.status().armed, true);
  });

  test('restore ignores garbage and drops unusable bots', () => {
    const env = setup();
    const live = env.live;
    assert.equal(live.restore(null), false);
    assert.equal(live.restore({ bots: 'nope' }), false);
    assert.equal(live.restore({ bots: [null, { index: 'x' }, { index: 0, bean: 1, coin: 'BTC', state: 'active', real: { szi: 1 } }] }), true);
    const rows = live.bots().rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'bot-0000');
    assert.equal(rows[0].real.szi, 0, 'a position without an entry price is dropped');
  });
});

// ---- integration with a real Journal subscriber (SSE-like) --------------------------------------------

describe('Journal + LiveLayer', () => {
  test('a subscriber sees the live events in order with increasing seq', () => {
    const env = setup();
    const seen = [];
    env.journal.subscribe((r) => seen.push(r));
    btcLong(env);
    env.live.create({ bean: 1, capital_usd: 100 });
    env.live.close({ id: 'bot-0000' });
    assert.deepEqual(seen.map((r) => r.kind), ['bot_created', 'bot_order', 'bot_fill', 'bot_order', 'bot_fill', 'bot_closed']);
    for (let i = 1; i < seen.length; i++) assert.equal(seen[i].seq, seen[i - 1].seq + 1);
    assert.deepEqual(env.journal.since(seen[3].seq).map((r) => r.kind), ['bot_fill', 'bot_closed']);
  });
});

// ---- real prices: live marks, frozen coins, wall-clock fills (GAME-DESIGN §10.4) ------------------------

/**
 * setup() with a market that behaves like the hyperliquid feed: a live mid (livePx) that differs from the bar
 * close, wall-clock out-of-tick stamps, bar-close tick stamps, stale coins and a canOpen() gate.
 */
function setupReal() {
  const env = setup();
  const m = env.engine.market;
  m.source = 'hyperliquid';
  m.live = {};
  m.stale = new Set();
  m.livePx = function livePx(coin) { return this.live[coin] ?? this.prices[coin] ?? null; };
  m.clockMs = () => env.clock.ms;
  m.tickTimeMs = function tickTimeMs() { return this.timeMs + 60_000; };
  m.isStale = function isStale(coin) { return this.stale.has(coin); };
  m.staleCoins = function staleCoins() { return [...this.stale]; };
  env.engine.prices = 'real';
  env.gate = null;
  env.engine.canOpen = (coin) => env.gate ?? (m.stale.has(coin) ? `${coin} price is delayed` : null);
  return env;
}

describe('LiveLayer with real prices', () => {
  test('out-of-tick fills use the live mid and the wall clock; tick fills use the bar close and its close time', () => {
    const env = setupReal();
    btcLong(env);
    env.engine.market.live.BTC = 81_000; // the live mid moved since the last bar close (80 000)
    env.clock.ms = 1_234_567;
    const row = env.live.create({ bean: 1, capital_usd: 100 });
    const open = env.live.fills({ limit: 1 }).rows[0];
    near(open.px, 81_000 * (1 + SLIP), 1e-6);
    assert.equal(open.time_ms, 1_234_567, 'wall clock');
    assert.equal(env.events('bot_fill').at(-1).time_ms, 1_234_567);
    assert.equal(row.mark_px, 81_000);
    assert.equal(row.mark_ms, 1_234_567);
    assert.equal(row.price_stale, false);

    // a tick: the bean flattens → the bot closes at the BAR close, stamped with the bar's close time
    env.engine.setBean(1, { side: 0, units: 0 });
    env.tick();
    const close = env.live.fills({ limit: 1 }).rows[0];
    assert.equal(close.dir, 'Close Long');
    near(close.px, 80_000 * (1 - SLIP), 1e-6);
    assert.equal(close.time_ms, env.engine.market.timeMs + 60_000);
    assert.equal(close.tick, 1);
    const st = env.live.status();
    assert.equal(st.prices, 'real');
    assert.equal(st.paper, true);
  });

  test('markLive marks unrealized at the live mid; a cross of liquidation_px liquidates immediately', () => {
    const env = setupReal();
    env.engine.addBean(1, { coin: 'BTC', leverage: 10, position_size: 1, side: 1, units: 0.125 });
    const row = env.live.create({ bean: 1, capital_usd: 100 });
    const entry = row.real.entry_px;
    env.clock.ms += 5000;
    env.live.markLive({ px: { BTC: 80_800 }, stale: [], t: env.clock.ms });
    let bot = env.live.botDetail('bot-0000').bot;
    near(bot.real.unrealized_pnl, 0.0125 * (80_800 - entry), 1e-6);
    assert.equal(bot.mark_px, 80_800);
    assert.equal(bot.mark_ms, env.clock.ms);
    assert.equal(bot.real.as_of_ms, env.clock.ms);
    const payload = env.live.marksPayload();
    assert.deepEqual(Object.keys(payload.bots['bot-0000']),
      ['szi', 'entry_px', 'mark_px', 'unrealized_pnl', 'realized_pnl', 'margin_used', 'liquidation_px', 'notional_usd', 'price_stale', 'as_of_ms']);
    assert.deepEqual(Object.keys(payload.account),
      ['account_value', 'unrealized_pnl', 'realized_pnl', 'available_usd', 'deployed_usd', 'open_notional_usd']);
    near(payload.account.account_value, 10_000 + bot.realized_pnl + bot.real.unrealized_pnl, 1e-5);
    assert.equal(env.live.status().unrealized_pnl, payload.account.unrealized_pnl, 'one source of truth');

    // the live mid crosses the liquidation price between bars
    const liq = bot.real.liquidation_px;
    env.clock.ms += 5000;
    env.live.markLive({ px: { BTC: liq - 1 }, stale: [], t: env.clock.ms });
    bot = env.live.botDetail('bot-0000').bot;
    assert.equal(bot.state, 'paused');
    assert.equal(bot.note, 'liquidated');
    assert.equal(bot.real.szi, 0);
    const fill = env.events('bot_fill').at(-1);
    assert.equal(fill.liquidation, true);
    near(fill.px, liq, 1e-4);
    assert.equal(fill.fee, 0);
    assert.equal(fill.time_ms, env.clock.ms, 'liquidated now, stamped with the wall clock');
    assert.equal(env.events('bot_paused').at(-1).reason, 'liquidated');
    assert.equal(env.live.marksPayload().bots['bot-0000'].szi, 0, 'paused bots stay in the marks');
  });

  test('a stale coin freezes its bots: no mirror on ticks, no liquidation on marks, price_stale; resume/create wait', () => {
    const env = setupReal();
    env.engine.addBean(1, { coin: 'BTC', leverage: 10, position_size: 1, side: 1, units: 0.125 });
    env.live.create({ bean: 1, capital_usd: 100 });
    const before = env.live.botDetail('bot-0000').bot;
    env.engine.market.stale.add('BTC');
    // the bean flips and the price crashes, but the coin has no live price: nothing happens to the bot
    env.engine.setBean(1, { side: -1, units: -0.125 });
    env.engine.market.prices.BTC = 60_000;
    env.tick();
    env.live.markLive({ px: { BTC: 60_000 }, stale: ['BTC'], t: env.clock.ms });
    const frozen = env.live.botDetail('bot-0000').bot;
    assert.equal(frozen.price_stale, true);
    assert.equal(frozen.state, 'active');
    assert.equal(frozen.real.szi, before.real.szi);
    assert.equal(frozen.fills, before.fills);
    assert.equal(frozen.mark_px, before.mark_px, 'marks stay at the last real price');
    assert.equal(env.live.marksPayload().bots['bot-0000'].price_stale, true);
    assert.deepEqual(env.live.status().stale_coins, ['BTC']);
    // pause is allowed (flattens at the last price); resume waits for a live price
    env.live.pause({ id: 'bot-0000' });
    rejects(() => env.live.resume({ id: 'bot-0000' }), 409, /delayed/);
    env.engine.addBean(2, { coin: 'ETH', side: 1, units: 0.3 });
    env.gate = 'prices are down';
    rejects(() => env.live.create({ bean: 2, capital_usd: 100 }), 409, /prices are down/);
    env.gate = null;
    env.engine.market.stale.delete('BTC');
    env.engine.market.prices.BTC = 80_000;
    assert.equal(env.live.resume({ id: 'bot-0000' }).state, 'active');
    assert.equal(env.live.botDetail('bot-0000').bot.price_stale, false);
  });

  test('serialize/restore keeps mark_px, mark_ms and price_stale', () => {
    const env = setupReal();
    btcLong(env);
    env.live.create({ bean: 1, capital_usd: 100 });
    env.live.markLive({ px: { BTC: 80_500 }, t: 4242 });
    const saved = JSON.parse(JSON.stringify(env.live.serialize()));
    const again = setupReal();
    again.live.restore(saved);
    const bot = again.live.botDetail('bot-0000').bot;
    assert.equal(bot.mark_px, 80_500);
    assert.equal(bot.mark_ms, 4242);
    assert.equal(bot.price_stale, false);
  });
});

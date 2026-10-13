// The testnet venue lifecycle against the WP2 Hyperliquid TESTNET double (PLATFORM §6.11, §11.2 testnet-live; WP3).
//
// Offline: the double (test/fixtures/hl-testnet-double.js) is injected as `fetch` into WP2's createTestnet(), so every
// request goes through the real scheduler, info, exchange (signing, §6.6 state machine) and verify modules, and the
// double re-encodes and RECOVERS every signature independently. Time is a manual clock: scheduler sleeps, lane retry
// timers and resend delays only advance when a test runs the clock, so 15 s retries cost microseconds.
//
// The engine is a small fake (beans and mainnet mids under test control), so each scenario is deterministic.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Journal, GLOBAL_KINDS, recordUid } from '../server/journal.js';
import { ApiError } from '../server/live.js';
import { openDb, MIGRATIONS_DIR } from '../server/db/db.js';
import { migrate } from '../server/db/migrate.js';
import { Secrets, wipeCredentials } from '../server/secrets.js';
import * as hl from '../server/hl/index.js';
import { Gardens } from '../server/garden/gardens.js';
import { Credentials } from '../server/garden/credentials.js';
import { makeTestnetDouble } from './fixtures/hl-testnet-double.js';
import { secp256k1 } from '@noble/curves/secp256k1';

const quiet = () => {};
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);

/** Mainnet venue facts of the fake engine (what LiveLayer's paper side would use; testnet uses its own listing). */
const MAINNET = {
  BTC: { max_leverage: 40, sz_decimals: 5, mid: 82306.5 },
  ETH: { max_leverage: 25, sz_decimals: 4, mid: 2492.45 },
  SOL: { max_leverage: 20, sz_decimals: 2, mid: 108.91 },
  HYPE: { max_leverage: 10, sz_decimals: 2, mid: 84.7915 },
  AVAX: { max_leverage: 10, sz_decimals: 2, mid: 10.307 },
};

/** A controllable clock: sleeps resolve only when run() advances fake time. */
class ManualClock {
  constructor(ms) {
    this.ms = ms;
    this.sleeps = [];
    this.now = () => this.ms;
    this.sleep = (ms) => new Promise((resolve) => this.sleeps.push({ at: this.ms + Math.max(0, ms), resolve }));
  }

  async settle(rounds = 40) {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
  }

  /** Run pending sleeps for up to `maxMs` of fake time (in order); stop early when nothing is pending. */
  async run(maxMs = 3000) {
    const until = this.ms + maxMs;
    for (let i = 0; i < 20_000; i++) {
      await this.settle();
      if (!this.sleeps.length) {
        await this.settle();
        if (!this.sleeps.length) return;
      }
      this.sleeps.sort((a, b) => a.at - b.at);
      if (this.sleeps[0].at > until) return;
      const next = this.sleeps.shift();
      if (next.at > this.ms) this.ms = next.at;
      next.resolve();
    }
  }
}

function fakeEngine() {
  const beans = new Map();
  const mids = Object.fromEntries(Object.entries(MAINNET).map(([c, v]) => [c, v.mid]));
  return {
    catchingUp: false,
    prices: 'real',
    canOpen: () => null,
    mids,
    population: {
      row: (id) => {
        const b = beans.get(id);
        return b ? { ...b, in_position: b.side > 0 ? 'long' : b.side < 0 ? 'short' : 'flat' } : null;
      },
      query: () => ({ rows: [] }),
    },
    market: {
      coins: Object.keys(MAINNET).map((coin) => ({ coin })),
      mid: (c) => mids[c] ?? null,
      livePx: (c) => mids[c] ?? null,
      coinInfo: (c) => (MAINNET[c] ? { coin: c, max_leverage: MAINNET[c].max_leverage, sz_decimals: MAINNET[c].sz_decimals } : null),
      isStale: () => false,
    },
    setBean(id, fields) {
      const cur = beans.get(id) ?? { id, coin: 'ETH', leverage: 3, position_size: 0.5, equity: 1000, side: 0, units: 0, entry_px: null, busted: false };
      beans.set(id, { ...cur, ...fields, id });
    },
  };
}

function addUser(db, name, now) {
  const r = db.prepare('INSERT INTO users (username, pw_hash, created_ms, updated_ms, pw_changed_ms) VALUES (?, ?, ?, ?, ?)')
    .run(name, 'scrypt$test', now, now, now);
  return Number(r.lastInsertRowid);
}

const LIB = {
  wire: hl, format: hl, errors: hl, constants: hl, signing: hl, addr: hl,
  verify: { parseAgentKey: hl.parseAgentKey, mainnetRecheck: hl.mainnetRecheck },
};

/** One isolated world: DB, double, testnet stack, scoped journal, Gardens. */
async function world({ reduceOnlyMinNotional = false, dir = null, db = null, double = null, clock = null, engine = null,
  masterKey = null } = {}) {
  const h = {};
  h.dir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bean-tnlive-'));
  h.ownDb = !db;
  if (!db) {
    db = openDb({ file: path.join(h.dir, 'bean.db') });
    migrate(db, MIGRATIONS_DIR, { backupDir: path.join(h.dir, 'backups') });
  }
  h.db = db;
  h.clock = clock ?? new ManualClock(T0);
  h.double = double ?? makeTestnetDouble({ now: h.clock.now, reduceOnlyMinNotional });
  h.engine = engine ?? fakeEngine();
  h.testnet = hl.createTestnet({
    fetch: h.double.fetch, now: h.clock.now, sleep: h.clock.sleep, log: quiet, mainnetClient: h.double.mainnetInfo,
    coins: Object.keys(MAINNET), timers: { setTimeout: () => null, clearTimeout() {} },
  });
  await h.testnet.market.refreshMeta();
  await h.testnet.market.pollMids();
  h.journal = new Journal({ scoped: true, globalKinds: GLOBAL_KINDS, keep: 5000, log: quiet });
  h.events = [];
  h.journal.subscribe((r) => h.events.push(r));
  h.masterKey = masterKey ?? crypto.randomBytes(32);
  h.credentials = new Credentials({
    db, secrets: new Secrets({ masterKey: h.masterKey }), makeSigner: hl.makeSigner, wipeCredentials, now: h.clock.now, log: quiet,
  });
  h.gardens = new Gardens({
    engine: h.engine, journal: h.journal, db, testnet: h.testnet, lib: LIB, credentials: h.credentials, now: h.clock.now,
    log: quiet, mainnetInfo: h.double.mainnetInfo,
  });
  await h.gardens.init();
  h.tick = 0;
  h.user = (name) => addUser(db, name, h.clock.now());
  h.connect = async (uid, { usd = 2000, validUntil, abstraction = 'default', name = 'bean-garden' } = {}) => {
    const a = h.double.addAccount({ usd, abstraction });
    const ag = h.double.addAgent(a.address, { name, ...(validUntil ? { validUntil } : {}) });
    const p = h.gardens.testnetConnect(uid, { account_address: a.address, agent_key: ag.key });
    await h.clock.run(5000);
    const res = await p;
    await h.clock.run(1000);
    return { account: a.address, agent: ag.address, agentKey: ag.key, res };
  };
  /** Run a command promise while driving the clock. */
  h.drive = async (promiseOrValue, ms = 5000) => {
    const p = Promise.resolve(promiseOrValue);
    p.catch(() => {}); // handled by the caller after the clock ran
    await h.clock.run(ms);
    return p;
  };
  /** One bar: fresh testnet mids, the engine's onTick hook, and the lane work it queues. */
  h.bar = async (ms = 3000) => {
    await h.testnet.market.pollMids();
    h.gardens.afterTick({ tick: ++h.tick });
    await h.clock.run(ms);
  };
  h.of = (uid, kind) => h.events.filter((r) => recordUid(r) === uid && (!kind || r.kind === kind));
  h.exch = (type) => h.double.requestsOf('exchange', type);
  h.orders = (uid) => db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id').all(uid);
  h.fills = (uid) => db.prepare('SELECT * FROM fills WHERE user_id = ? ORDER BY id').all(uid);
  h.pos = (account, coin = 'ETH') => h.double.position(account, coin)?.szi ?? 0;
  h.close = async () => {
    await h.gardens.shutdown({ drainMs: 0 });
    if (h.ownDb) {
      db.close();
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  };
  return h;
}

/** A user with a connected testnet account and one ETH bean (long 0.4, entry 2490). */
async function plantedWorld(opts = {}) {
  const h = await world(opts);
  h.engine.setBean(1, { coin: 'ETH', side: 1, units: 0.4, entry_px: 2490, leverage: 3, position_size: 0.5 });
  h.uid = h.user('nok');
  h.link = await h.connect(h.uid, opts.connect ?? {});
  h.g = h.gardens.get(h.uid);
  return h;
}

async function plant(h, { bean = 1, capital = 200, ack = false } = {}) {
  return h.drive(h.g.create({ bean, capital_usd: capital, venue: 'testnet', confirm: 'testnet', ack_divergence: ack }));
}

describe('testnet venue: lifecycle against the double (§6.11)', () => {
  let h;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it('create → leverage → IOC → provisional fill → sweep confirms (fee replaced) → reduce-only → flip → pause (widening) → resume → close', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    assert.equal(row.venue, 'testnet');
    assert.equal(row.price_source, 'hyperliquid-testnet');
    assert.equal(row.asset, 4, 'the testnet asset index of ETH');
    assert.equal(row.leverage, 3);
    // updateLeverage first, then the opening IOC.
    assert.deepEqual(h.double.executed.map((e) => e.type), ['updateLeverage', 'order']);
    const lev = h.double.position(h.link.account, 'ETH').leverage;
    assert.deepEqual(lev, { type: 'isolated', value: 3 });
    assert.equal(h.pos(h.link.account), 0.08);
    let bot = h.g.botById(row.id);
    assert.equal(bot.real.szi, 0.08);
    assert.equal(bot.target_szi, 0.08);
    assert.equal(bot.fees_estimated, true);
    assert.equal(bot.size_ratio.k, 1);
    const prov = h.fills(h.uid);
    assert.ok(prov.length >= 1 && prov.every((f) => f.provisional === 1 && f.venue === 'testnet'));
    const estFee = prov.reduce((s, f) => s + f.fee, 0);
    assert.ok(h.of(h.uid, 'bot_fill').some((e) => e.provisional === true && e.venue === 'testnet'));
    assert.ok(h.of(h.uid, 'bot_created').some((e) => e.venue === 'testnet'));
    assert.ok(h.of(h.uid, 'bot_order').some((e) => e.status === 'filled' && /^0x[0-9a-f]{32}$/.test(e.cloid)));

    // Bars: with provisional fills the sweep runs every 5 bars and replaces them with the exchange fills.
    for (let i = 0; i < 5; i++) await h.bar();
    bot = h.g.botById(row.id);
    assert.equal(bot.fees_estimated, false);
    const confirmed = h.fills(h.uid);
    assert.ok(confirmed.every((f) => f.provisional === 0 && Number.isInteger(f.tid) && f.hash));
    const fee = confirmed.reduce((s, f) => s + f.fee, 0);
    assert.ok(Math.abs(fee - estFee) < 0.01, 'the exchange fee replaced the estimate');
    assert.ok(h.of(h.uid, 'bot_fill_confirmed').length >= 1);
    assert.equal(h.g.rowOf(row.id).fill_state, 'in_sync');

    // The bean reduces: one reduce-only IOC for the difference.
    h.engine.setBean(1, { units: 0.2 });
    await h.bar();
    assert.equal(h.pos(h.link.account), 0.04);
    const reduce = h.orders(h.uid).filter((o) => o.kind === 'mirror').at(-1);
    assert.equal(reduce.reduce_only, 1);
    assert.equal(reduce.sz, -0.04);

    // Flip: close reduce-only, then leverage, then open the other side.
    const before = h.double.executed.length;
    h.engine.setBean(1, { side: -1, units: 0.3, entry_px: 2400 });
    await h.bar();
    const seq = h.double.executed.slice(before).map((e) => e.type);
    assert.deepEqual(seq, ['order', 'updateLeverage', 'order']);
    assert.equal(h.pos(h.link.account), -0.06);
    assert.equal(h.g.botById(row.id).real.szi, -0.06);

    // Pause: the first flatten IOC cannot match; the retry 2 s later widens the slippage (1% → 2.5%).
    h.double.fault({ kind: 'error', code: 'ioc_no_match', path: 'exchange', type: 'order', times: 1 });
    const paused = await h.drive(h.g.pause({ id: row.id }), 10_000);
    assert.equal(paused.state, 'paused');
    await h.clock.run(10_000);
    assert.equal(h.pos(h.link.account), 0);
    const flat = h.orders(h.uid).filter((o) => o.kind === 'flatten');
    assert.equal(flat.length, 2);
    assert.equal(flat[0].status, 'rejected');
    assert.equal(flat[0].code, 'ioc_no_match');
    assert.ok(flat[1].px > flat[0].px, 'a buy flatten retries at a wider price');
    assert.ok(Math.abs(flat[1].px / flat[0].px - 1.025 / 1.01) < 0.002);
    assert.ok(h.of(h.uid, 'bot_paused').length >= 1);
    assert.equal(h.g.botById(row.id).exchange_sync, null);
    // The flatten is confirmed against the exchange: the bot's exchange snapshot shows the flat position, not the old one.
    assert.equal(h.g.botById(row.id).exchange.szi, 0);
    assert.equal(h.g.rowOf(row.id).exchange.szi, 0);

    // Resume from flat: leverage is resent, then the opening IOC.
    const before2 = h.double.executed.length;
    await h.drive(h.g.resume({ id: row.id }));
    assert.deepEqual(h.double.executed.slice(before2).map((e) => e.type), ['updateLeverage', 'order']);
    assert.equal(h.pos(h.link.account), -0.06);

    // Close: closing until flat; a second close while closing sends nothing; bot_closed only after the sweep.
    h.double.fault({ kind: 'timeout', path: 'exchange', type: 'order', times: 1 });
    const c1 = h.g.close({ id: row.id });
    await h.clock.settle();
    const sent = h.exch('order').length;
    const again = await h.g.close({ id: row.id });
    assert.equal(again.closing, true);
    assert.equal(h.exch('order').length, sent, 'bot_close while closing sends nothing');
    assert.equal(h.of(h.uid, 'bot_closed').length, 0, 'no bot_closed before the flatten completed');
    await h.drive(c1, 30_000);
    await h.clock.run(30_000);
    const closed = h.of(h.uid, 'bot_closed');
    assert.equal(closed.length, 1);
    assert.equal(closed[0].confirmed, true);
    assert.equal(closed[0].venue, 'testnet');
    assert.equal(h.g.botById(row.id).state, 'closed');
    assert.equal(h.pos(h.link.account), 0);
    assert.equal(h.double.ordersFor(h.link.account).filter((o) => o.status === 'open').length, 0, 'no IOC left resting');
  });

  it('a failed completion sweep closes with confirmed:false, then bot_fill_confirmed corrects the numbers', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    h.double.fault({ kind: 'timeout', path: 'info', type: 'userFillsByTime', times: 1 });
    await h.drive(h.g.close({ id: row.id }), 20_000);
    await h.clock.run(5_000);
    const closed = h.of(h.uid, 'bot_closed');
    assert.equal(closed.length, 1);
    assert.equal(closed[0].confirmed, false, 'provisional numbers (≈)');
    assert.equal(h.g.botById(row.id).fees_estimated, true);
    await h.clock.run(120_000); // the deferred confirmation sweep
    assert.ok(h.of(h.uid, 'bot_fill_confirmed').length >= 1);
    assert.equal(h.g.botById(row.id).fees_estimated, false);
    assert.equal(h.fills(h.uid).filter((f) => f.provisional === 1).length, 0);
  });

  it('partial fill: order partial, fill_state partial; the rest is bought next bar', async () => {
    h = await plantedWorld();
    h.double.fault({ kind: 'partial', fraction: 0.5, path: 'exchange', type: 'order', times: 1 });
    const row = await plant(h);
    assert.equal(h.pos(h.link.account), 0.04);
    assert.equal(h.g.rowOf(row.id).fill_state, 'partial');
    const o = h.orders(h.uid).find((x) => x.kind === 'mirror');
    assert.equal(o.status, 'partial');
    assert.equal(o.filled_sz, 0.04);
    await h.bar();
    assert.equal(h.pos(h.link.account), 0.08);
    assert.equal(h.g.rowOf(row.id).fill_state, 'in_sync');
  });

  it('min-notional dust: a reduce-only close below $10 is refused once and not retried until the target changes', async () => {
    h = await plantedWorld({ reduceOnlyMinNotional: true });
    h.engine.setBean(1, { units: 0.25, leverage: 1, position_size: 1 }); // 0.25 × 20/1000 → 0.005 ETH ≈ $12.5
    const row = await plant(h, { capital: 20 });
    assert.equal(h.pos(h.link.account), 0.005);
    // The price falls 40 %: the position is now worth ≈ $7.5; the bean goes flat.
    h.double.setMid('ETH', 1500);
    h.engine.mids.ETH = 1500;
    h.engine.setBean(1, { side: 0, units: 0 });
    await h.bar();
    const bot = h.g.botById(row.id);
    assert.deepEqual(bot.dust, { szi: 0.005, target: 0 });
    assert.deepEqual(h.g.rowOf(row.id).dust, { szi: 0.005 });
    const n = h.exch('order').length;
    await h.bar();
    await h.bar();
    assert.equal(h.exch('order').length, n, 'not retried while the target is unchanged');
  });

  it('unresolved order + its fill → pending attribution (no drift pause); resolved by orderStatus, exactly one order', async () => {
    h = await plantedWorld();
    h.double.fault({ kind: 'execute_then_timeout', path: 'exchange', type: 'order', times: 1 });
    h.double.fault({ kind: 'unknown_oid', path: 'info', type: 'orderStatus', times: 2 });
    const row = await plant(h);
    assert.equal(h.pos(h.link.account), 0.08, 'the order executed on the exchange');
    let bot = h.g.botById(row.id);
    assert.equal(bot.real.szi, 0, 'but we never learnt it');
    const unk = h.orders(h.uid).find((o) => o.kind === 'mirror');
    assert.equal(unk.status, 'unknown');
    assert.equal(unk.transport_failed, 1);
    // Next bar: orderStatus still unknown (< 60 s) → pending attribution: no drift pause, no new order.
    const n = h.exch('order').length;
    await h.bar();
    bot = h.g.botById(row.id);
    assert.equal(bot.state, 'active');
    assert.equal(bot.note_code, null);
    assert.equal(h.exch('order').length, n);
    // Next bar: resolved (filled) → the fills sweep applies the exchange fills exactly.
    await h.bar();
    bot = h.g.botById(row.id);
    assert.equal(bot.real.szi, 0.08);
    assert.equal(bot.state, 'active');
    assert.equal(h.orders(h.uid).find((o) => o.id === unk.id).status, 'filled');
    assert.equal(h.double.ordersFor(h.link.account).length, 1, 'never re-signed: exactly one order exists');
    assert.ok(h.fills(h.uid).every((f) => f.provisional === 0 && f.order_id === unk.id));
  });

  it('drift → pause with position_drift and NO order; resume adopts the exchange size, then mirrors from there', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    h.double.externalTrade(h.link.account, 'ETH', 0.01);
    const n = h.exch('order').length;
    await h.bar();
    const bot = h.g.botById(row.id);
    assert.equal(bot.state, 'paused');
    assert.equal(bot.note_code, 'position_drift');
    assert.deepEqual(bot.note_vars, { exch: 0.09, exp: 0.08, coin: 'ETH' });
    assert.equal(h.exch('order').length, n, 'a drift pause never sends an order');
    const ev = h.of(h.uid, 'bot_paused').at(-1);
    assert.equal(ev.note_code, 'position_drift');
    await h.drive(h.g.resume({ id: row.id }));
    assert.equal(h.pos(h.link.account), 0.08, 'adopted 0.09, then reduced to the target 0.08');
    assert.equal(h.g.botById(row.id).real.szi, 0.08);
  });

  it('external close → pause with external_close', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    h.double.externalTrade(h.link.account, 'ETH', -0.08);
    await h.bar();
    assert.equal(h.g.botById(row.id).note_code, 'external_close');
  });

  it('liquidation is detected by the `liquidation` object (an unusual dir string inserts fine); P&L from the exchange fill', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    for (let i = 0; i < 5; i++) await h.bar(); // confirm the opening fills first
    const fill = h.double.liquidate(h.link.account, 'ETH');
    assert.match(fill.dir, /^Liquidated Isolated Long$/);
    await h.bar();
    const bot = h.g.botById(row.id);
    assert.equal(bot.state, 'paused');
    assert.equal(bot.note_code, 'liquidated_testnet');
    assert.equal(bot.real.szi, 0);
    const liq = h.fills(h.uid).find((f) => f.liquidation === 1);
    assert.ok(liq, 'the liquidation fill is stored');
    assert.equal(liq.dir, 'Liquidated Isolated Long');
    assert.ok(Math.abs(liq.closed_pnl - Number(fill.closedPnl)) < 1e-9);
    assert.ok(h.of(h.uid, 'bot_paused').at(-1).liquidation === true);
  });

  it('fills sweep paginates beyond 500 fills; fills beyond the 10,000 horizon keep fees_estimated (+ note)', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    h.clock.ms += 30_000;
    h.double.addFills(h.link.account, 1200, { coin: 'BTC', stepMs: 1 });
    const pagesBefore = h.double.requestsOf('info', 'userFillsByTime').length;
    for (let i = 0; i < 5; i++) await h.bar(60_000);
    const pages = h.double.requestsOf('info', 'userFillsByTime').length - pagesBefore;
    assert.ok(pages >= 3, `paginated (${pages} pages)`);
    assert.equal(h.g.botById(row.id).fees_estimated, false, 'our fills were found among > 500');

    // A second bot whose provisional fill falls out of the 10,000 most recent fills.
    h.engine.setBean(2, { coin: 'SOL', side: 1, units: 5, entry_px: 108, leverage: 2, position_size: 0.5 });
    const r2 = await plant(h, { bean: 2, capital: 100 });
    assert.equal(h.g.botById(r2.id).fees_estimated, true);
    h.clock.ms += 30_000;
    h.double.addFills(h.link.account, 10_000, { coin: 'BTC', stepMs: 1 });
    for (let i = 0; i < 5; i++) await h.bar(120_000);
    const b2 = h.g.botById(r2.id);
    assert.equal(b2.fees_estimated, true, 'beyond the horizon the estimate stays');
    assert.equal(b2.note_code, 'fills_beyond_horizon');
    assert.ok(h.fills(h.uid).some((f) => f.bot_id === r2.id && f.provisional === 1));
  });

  it('funding: Σ bot totals (realized + funding) reconcile to Δ account value', async () => {
    h = await plantedWorld();
    const before = h.double.accountValue(h.link.account);
    const row = await plant(h);
    await h.bar();
    h.double.applyFunding('ETH', 0.0005);
    await h.bar();
    const mid = h.g.botById(row.id);
    assert.ok(mid.exchange.funding_since_open < 0, 'funding paid by a long is a cost (−cumFunding.sinceOpen)');
    await h.drive(h.g.close({ id: row.id }), 30_000);
    await h.clock.run(10_000);
    const bot = h.g.botById(row.id);
    assert.equal(bot.state, 'closed');
    const after = h.double.accountValue(h.link.account);
    const total = bot.realized_pnl + bot.funding_realized;
    assert.ok(Math.abs(total - (after - before)) < 1e-6, `Σ bot ${total} vs Δ account ${after - before}`);
    assert.ok(bot.funding_realized < 0);
    assert.equal(h.of(h.uid, 'bot_closed')[0].funding, Number(bot.funding_realized.toFixed(6)));
  });

  it('agent revoked → every testnet bot pauses (credential_revoked) and credential_status revoked is emitted', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    h.double.revokeAgent(h.link.agent);
    h.engine.setBean(1, { units: 0.2 }); // forces an order
    await h.bar();
    const bot = h.g.botById(row.id);
    assert.equal(bot.state, 'paused');
    assert.equal(bot.note_code, 'credential_revoked');
    assert.equal(h.credentials.link(h.uid).status, 'revoked');
    const cs = h.of(h.uid, 'credential_status').at(-1);
    assert.deepEqual({ status: cs.status, reason: cs.reason }, { status: 'revoked', reason: 'agent_unknown' });
    await assert.rejects(h.drive(h.g.resume({ id: row.id })), (err) => err.code === 'credential_revoked');
  });

  it('no_deposit → the credential stays verified, one live_error, new testnet plants are refused (faucet)', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    h.double.fault({ kind: 'must_deposit', path: 'exchange', type: 'order', times: 1 });
    h.engine.setBean(1, { units: 0.2 });
    await h.bar();
    assert.equal(h.credentials.link(h.uid).status, 'verified');
    assert.equal(h.g.botById(row.id).state, 'active', 'no bot is paused for it alone');
    const errs = h.of(h.uid, 'live_error').filter((e) => e.code === 'no_deposit');
    assert.equal(errs.length, 1);
    h.engine.setBean(3, { coin: 'SOL', side: 1, units: 5, entry_px: 108, leverage: 2, position_size: 0.5 });
    await assert.rejects(plant(h, { bean: 3, capital: 50 }), (err) => err.code === 'insufficient_testnet_balance' && /drip/.test(err.extra.faucet));
  });

  it('API-wallet expiry: warnings at −7 d and −1 d (once each), create refused within 24 h, flatten + pause at −30 min', async () => {
    h = await plantedWorld({ connect: { validUntil: T0 + 8 * DAY } });
    const row = await plant(h);
    h.clock.ms += 1.2 * DAY;
    await h.testnet.market.pollMids();
    h.gardens.expirySweep();
    h.gardens.expirySweep();
    let warns = h.of(h.uid, 'live_error').filter((e) => e.code === 'agent_expiring');
    assert.equal(warns.length, 1);
    assert.equal(warns[0].vars.warn, '7d');
    h.clock.ms += 6 * DAY;
    await h.testnet.market.pollMids();
    h.gardens.expirySweep();
    warns = h.of(h.uid, 'live_error').filter((e) => e.code === 'agent_expiring');
    assert.equal(warns.length, 2);
    assert.equal(warns[1].vars.warn, '1d');
    h.engine.setBean(4, { coin: 'SOL', side: 1, units: 5, entry_px: 108, leverage: 2, position_size: 0.5 });
    await assert.rejects(plant(h, { bean: 4, capital: 50 }), (err) => err.code === 'agent_expiring');
    h.clock.ms = T0 + 8 * DAY - 20 * 60_000;
    await h.testnet.market.pollMids();
    h.gardens.expirySweep();
    await h.clock.run(10_000);
    const bot = h.g.botById(row.id);
    assert.equal(bot.state, 'paused');
    assert.equal(bot.note_code, 'agent_expiring');
    assert.equal(h.pos(h.link.account), 0, 'flattened while the agent could still sign');
  });

  it('Replace API wallet (same account) keeps the bots; the next orders are signed by the new agent', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    const ag2 = h.double.addAgent(h.link.account, { name: 'bean-garden-2' });
    const p = h.gardens.testnetConnect(h.uid, { account_address: h.link.account, agent_key: ag2.key });
    const res = await h.drive(p);
    assert.equal(res.replaced, true);
    assert.equal(h.credentials.link(h.uid).agent_address, ag2.address);
    assert.equal(h.g.botById(row.id).state, 'active');
    h.engine.setBean(1, { units: 0.2 });
    await h.bar();
    assert.equal(h.pos(h.link.account), 0.04);
    assert.equal(h.double.executed.at(-1).signer, ag2.address);
  });

  it('inactivity: 14 days without activity flatten and pause the testnet bots (note inactive)', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    h.db.prepare('UPDATE gardens SET last_active_ms = ? WHERE user_id = ?').run(h.clock.now() - 15 * DAY, h.uid);
    const out = h.gardens.inactivitySweep();
    assert.equal(out.paused[0].user_id, h.uid);
    await h.clock.run(10_000);
    assert.equal(h.g.botById(row.id).note_code, 'inactive');
    assert.equal(h.pos(h.link.account), 0);
  });

  it('kill switch: every player\'s testnet bots flatten and pause; creates and resumes answer 503 kill_switch', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    const uid2 = h.user('lek');
    const link2 = await h.connect(uid2);
    h.engine.setBean(5, { coin: 'SOL', side: 1, units: 5, entry_px: 108, leverage: 2, position_size: 0.5 });
    const g2 = h.gardens.get(uid2);
    const r2 = await h.drive(g2.create({ bean: 5, capital_usd: 100, venue: 'testnet', confirm: 'testnet' }));
    const res = h.gardens.killSwitch({ on: true, reason: 'drill' });
    assert.equal(res.flattening.length, 2);
    await h.clock.run(10_000);
    assert.equal(h.pos(h.link.account), 0);
    assert.equal(h.pos(link2.account, 'SOL'), 0);
    assert.equal(h.g.botById(row.id).note_code, 'kill_switch');
    assert.equal(g2.botById(r2.id).note_code, 'kill_switch');
    await assert.rejects(h.drive(h.g.resume({ id: row.id })), (err) => err.status === 503 && err.code === 'kill_switch');
    await assert.rejects(plant(h, { bean: 1 }), (err) => err.code === 'kill_switch');
    const ks = h.events.filter((e) => e.kind === 'kill_switch');
    assert.ok(ks.length >= 1 && recordUid(ks[0]) === null, 'a global record');
    h.gardens.killSwitch({ on: false });
    await h.bar();
    assert.equal(h.g.botById(row.id).state, 'paused', 'turning it off resumes nothing');
  });

  it('catch-up: replayed bars never trade; one sync runs after the catch-up ends', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    h.engine.catchingUp = true;
    h.engine.setBean(1, { units: 0.2 });
    const n = h.exch('order').length;
    await h.bar();
    await h.bar();
    assert.equal(h.exch('order').length, n, 'no order while replaying');
    assert.equal(h.g.botById(row.id).real.szi, 0.08);
    h.engine.catchingUp = false;
    h.gardens.markLive({ px: {}, t: h.clock.now() });
    await h.clock.run(3000);
    assert.equal(h.exch('order').length, n + 1);
    assert.equal(h.pos(h.link.account), 0.04);
  });

  it('frozen-ratio sizing (HYPE): 10 units × 0.1 × k(2.058) → 2.05; k holds within an episode', async () => {
    h = await world();
    h.engine.setBean(9, { coin: 'HYPE', side: 1, units: 10, entry_px: 84, leverage: 1, position_size: 0.1 });
    h.uid = h.user('hype');
    h.link = await h.connect(h.uid);
    h.g = h.gardens.get(h.uid);
    await assert.rejects(plant(h, { bean: 9, capital: 100 }), (err) => err.code === 'divergence_ack');
    const q = h.g.testnetQuote({ bean: 9, capital_usd: 100 });
    assert.equal(q.reason, 'divergence_ack');
    assert.equal(q.venue_ok, true, 'the stake-independent checks pass');
    assert.ok(Math.abs(q.divergence - (41.199 / 84.7915 - 1)) < 1e-6);
    assert.equal(q.target_sz, 2.05);
    const row = await plant(h, { bean: 9, capital: 100, ack: true });
    const bot = h.g.botById(row.id);
    assert.ok(Math.abs(bot.size_ratio.k - 84.7915 / 41.199) < 1e-9);
    assert.equal(bot.target_szi, 2.05);
    assert.equal(h.pos(h.link.account, 'HYPE'), 2.05);
    // Mainnet moves within the same episode: the target holds (no churn).
    h.engine.mids.HYPE = 100;
    await h.bar();
    assert.equal(h.g.botById(row.id).target_szi, 2.05);
    assert.equal(h.pos(h.link.account, 'HYPE'), 2.05);
    // A new episode (the bean re-entered): k is recomputed from current mids (100 / 41.199 → 2.4272 → 2.42).
    h.engine.setBean(9, { entry_px: 99 });
    await h.bar();
    assert.equal(h.g.botById(row.id).target_szi, 2.42);
    assert.equal(h.pos(h.link.account, 'HYPE'), 2.42);
  });
});

describe('testnet venue: intents, guards, funding, dust and budget (review fixes)', () => {
  let h;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it('resume withdraws a retrying flatten: no flatten order after the resume, no bot_paused, no intent left for a restart', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    // The flatten cannot match at 1 %, 2.5 % or 5 %: a 15 s retry is scheduled.
    h.double.fault({ kind: 'error', code: 'ioc_no_match', path: 'exchange', type: 'order', times: 3 });
    await h.drive(h.g.pause({ id: row.id }), 6_000);
    assert.equal(h.g.botById(row.id).exchange_sync?.op, 'flatten');
    const resumed = await h.drive(h.g.resume({ id: row.id }), 1_000);
    assert.equal(resumed.state, 'active');
    assert.equal(h.g.botById(row.id).exchange_sync?.op === 'flatten', false, 'the flatten intent is withdrawn (boot would re-issue it)');
    const flattensBefore = h.orders(h.uid).filter((o) => o.kind === 'flatten').length;
    const pausedBefore = h.of(h.uid, 'bot_paused').length;
    await h.clock.run(30_000); // the old retry timer would fire here
    await h.bar();
    const bot = h.g.botById(row.id);
    assert.equal(bot.state, 'active');
    assert.equal(h.orders(h.uid).filter((o) => o.kind === 'flatten').length, flattensBefore, 'no flatten order after the resume');
    assert.equal(h.of(h.uid, 'bot_paused').length, pausedBefore, 'no bot_paused for an active bot');
    assert.equal(h.pos(h.link.account), 0.08, 'the position the bot holds was never flattened');
    assert.equal(bot.real.szi, 0.08);
  });

  it('pause during a slow updateLeverage at create: the opening IOC is never sent for the paused bot', async () => {
    h = await plantedWorld();
    // The leverage request times out once: its identical resend sleeps, and the player pauses in that window.
    h.double.fault({ kind: 'timeout', path: 'exchange', type: 'updateLeverage', times: 1 });
    const c = h.g.create({ bean: 1, capital_usd: 200, venue: 'testnet', confirm: 'testnet' });
    c.catch(() => {});
    await h.clock.settle();
    const botId = h.g.botList.at(-1).id;
    const p = h.g.pause({ id: botId });
    p.catch(() => {});
    await h.clock.settle();
    assert.equal(h.g.botById(botId).state, 'paused');
    await h.clock.run(20_000);
    await c;
    await p;
    assert.deepEqual(h.double.executed.map((e) => e.type).filter((t) => t === 'order'), [], 'no order at all');
    assert.equal(h.orders(h.uid).filter((o) => o.kind === 'mirror').length, 0);
    assert.equal(h.pos(h.link.account), 0);
    assert.equal(h.g.botById(botId).state, 'paused');
  });

  it('a closing bot is never mirrored: a close during the flip leg sends no opening order', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    // The bean flips short; the reduce-only closing leg is slow (its first transmission times out, the identical resend
    // fills), and the player closes in that window.
    h.engine.setBean(1, { side: -1, units: 0.3, entry_px: 2495 });
    h.double.fault({ kind: 'timeout', path: 'exchange', type: 'order', times: 1 });
    await h.testnet.market.pollMids();
    h.gardens.afterTick({ tick: ++h.tick });
    await h.clock.settle();
    const cl = h.g.close({ id: row.id });
    cl.catch(() => {});
    await h.clock.run(60_000);
    await cl;
    await h.clock.run(30_000);
    const opens = h.orders(h.uid).filter((o) => o.kind === 'mirror' && o.reduce_only === 0 && o.reason === 'flip');
    assert.equal(opens.length, 0, 'no opening leg for a closing bot');
    assert.equal(h.orders(h.uid).filter((o) => o.kind === 'leverage').length, 1, 'no leverage for an open that will not happen');
    assert.equal(h.pos(h.link.account), 0);
    assert.equal(h.g.botById(row.id).state, 'closed');
  });

  it('funding at close is read in full (paginated past 500 rows) and matches Δ account value', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    for (let i = 0; i < 5; i++) await h.bar();
    let truth = 0;
    for (let i = 0; i < 600; i++) {
      h.clock.ms += 3600_000;
      const before = h.double.accountValue(h.link.account);
      h.double.applyFunding('ETH', 0.0001);
      truth += h.double.accountValue(h.link.account) - before;
    }
    await h.bar();
    await h.drive(h.g.close({ id: row.id }), 30_000);
    await h.clock.run(30_000);
    const ev = h.of(h.uid, 'bot_closed').at(-1);
    assert.equal(ev.confirmed, true);
    assert.ok(Math.abs(ev.funding - truth) < 1e-4, `funding ${ev.funding} = truth ${truth}`);
    assert.ok(h.double.requestsOf('info', 'userFunding').length >= 2, 'more than one page');
  });

  it('a funding history too long to read whole keeps the reconciled value and closes with confirmed:false', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    for (let i = 0; i < 5; i++) await h.bar();
    // Funding rows accrue per open position per hour across the whole account: four positions opened by hand on the
    // testnet site plus the bot's make 5 rows an hour, so 26 days exceed FUNDING_MAX_PAGES × 500 rows.
    for (const coin of ['BTC', 'SOL', 'AVAX', 'HYPE']) h.double.externalTrade(h.link.account, coin, coin === 'BTC' ? 0.001 : 1);
    let truth = 0;
    for (let i = 0; i < 624; i++) {
      h.clock.ms += 3600_000;
      const before = h.double.accountValue(h.link.account);
      h.double.applyFunding('ETH', 0.00001);
      truth += h.double.accountValue(h.link.account) - before;
      for (const coin of ['BTC', 'SOL', 'AVAX', 'HYPE']) h.double.applyFunding(coin, 0.00001);
    }
    await h.testnet.market.pollMids();
    await h.bar();
    await h.drive(h.g.close({ id: row.id }), 30_000);
    await h.clock.run(30_000);
    const ev = h.of(h.uid, 'bot_closed').at(-1);
    assert.equal(ev.confirmed, false, 'a partial sum is never reported as exact');
    assert.ok(Math.abs(ev.funding - truth) < 1e-3, `the reconciled funding ${ev.funding} ≈ truth ${truth}`);
  });

  it('dust on close: the bot stays closing (coin still bound) while the exchange holds it; flat later → it retires', async () => {
    h = await plantedWorld({ reduceOnlyMinNotional: true });
    h.engine.setBean(1, { units: 0.25, leverage: 1, position_size: 1 });
    const row = await plant(h, { capital: 20 });
    h.double.setMid('ETH', 1500);
    h.engine.mids.ETH = 1500;
    await h.bar();
    await h.drive(h.g.close({ id: row.id }), 30_000);
    await h.clock.run(30_000);
    let bot = h.g.botById(row.id);
    assert.equal(bot.state, 'paused');
    assert.equal(bot.closing, true, 'never retired while the exchange holds the position');
    assert.deepEqual(h.g.rowOf(row.id).dust, { szi: 0.005 });
    assert.equal(bot.exchange_sync?.code, 'min_notional');
    assert.equal(h.of(h.uid, 'bot_closed').length, 0);
    const n = h.exch('order').length;
    await h.bar();
    await h.bar();
    assert.equal(h.exch('order').length, n, 'the refused remainder is not resent every bar');
    // The player closes the dust on the testnet site: the next bar completes the close.
    h.double.externalTrade(h.link.account, 'ETH', -0.005);
    await h.bar(30_000);
    bot = h.g.botById(row.id);
    assert.equal(bot.state, 'closed');
    assert.equal(bot.real.szi, 0);
    assert.equal(h.of(h.uid, 'bot_closed').length, 1);
  });

  it('external close: the books follow the exchange (no phantom size), and the outside fills are booked', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    for (let i = 0; i < 5; i++) await h.bar();
    h.double.externalTrade(h.link.account, 'ETH', -0.08);
    await h.bar();
    const bot = h.g.botById(row.id);
    assert.equal(bot.note_code, 'external_close');
    assert.deepEqual(bot.note_vars, { exch: 0, exp: 0.08, coin: 'ETH' });
    assert.equal(bot.real.szi, 0);
    assert.equal(bot.real.unrealized_pnl, 0);
    assert.ok(h.fills(h.uid).some((f) => f.bot_id === row.id && f.side === 'A' && f.provisional === 0), 'the outside close is booked');
    await h.drive(h.g.close({ id: row.id }), 20_000);
    const closed = h.g.botById(row.id);
    assert.equal(closed.state, 'closed');
    assert.equal(closed.real.szi, 0);
  });

  it('budget: the cadence sweep runs after the bar\'s orders; degradation stretches (never shortens) it and skips idle reconciles', async () => {
    h = await plantedWorld();
    const row = await plant(h);
    for (let i = 0; i < 6; i++) await h.bar(); // provisional fills confirmed
    // A flip on a sweep bar: the orders go out before the sweep of that bar.
    const v = h.gardens.get(h.uid).testnet;
    while ((v.bars + 1) % 30 !== 0) await h.bar();
    h.engine.setBean(1, { side: -1, units: 0.4, entry_px: 2491 });
    const rq = h.double.requests.length;
    await h.bar();
    const seq = h.double.requests.slice(rq).map((r) => r.type).filter((t) => t === 'order' || t === 'userFillsByTime');
    assert.ok(seq.includes('userFillsByTime') && seq.indexOf('order') < seq.indexOf('userFillsByTime'), `orders first: ${seq}`);
    // Degraded: idle sweeps stay at 30 bars (never every 10), and reconciles of an idle player run every 2nd bar.
    h.testnet.scheduler.degraded = () => true;
    const s0 = h.double.requestsOf('info', 'userFillsByTime').length;
    const c0 = h.double.requestsOf('info', 'clearinghouseState').length;
    for (let i = 0; i < 30; i++) await h.bar();
    assert.equal(h.double.requestsOf('info', 'userFillsByTime').length - s0, 1, 'one idle sweep in 30 bars');
    const recs = h.double.requestsOf('info', 'clearinghouseState').length - c0;
    assert.ok(recs >= 14 && recs <= 16, `reconciles every 2nd bar (${recs} in 30)`);
    assert.equal(h.g.botById(row.id).state, 'active');
  });

  it('stagger: gardens built in the same pass do not share their sweep bar or their userRateLimit minute', async () => {
    h = await world();
    const bars = new Set();
    const req = new Set();
    for (let i = 0; i < 8; i++) {
      const uid = h.user(`player${i}`);
      const v = h.gardens.get(uid).testnet;
      bars.add(v.bars % 30);
      req.add(Math.floor(v.requestsMs / 60_000));
    }
    assert.ok(bars.size >= 5, `sweep phases spread (${[...bars]})`);
    assert.ok(req.size >= 4, `userRateLimit minutes spread (${req.size})`);
  });
});

describe('testnet venue: restart resolves in-flight orders by cloid before the first mirror', () => {
  it('a pending row unknown to the exchange → canceled; an executed-but-unknown order → applied from the fills', async () => {
    const h = await plantedWorld();
    try {
      // An order that executed while we lost the answer (it stays `unknown`).
      h.double.fault({ kind: 'execute_then_timeout', path: 'exchange', type: 'order', times: 1 });
      h.double.fault({ kind: 'unknown_oid', path: 'info', type: 'orderStatus', times: 1 });
      const row = await plant(h);
      assert.equal(h.pos(h.link.account), 0.08);
      // A write-ahead row that never reached the exchange (crash between commit and POST).
      const ghost = h.gardens.repo.writeAhead(h.uid, {
        bot: row.id, kind: 'mirror', coin: 'ETH', sz: 0.01, px: 2500, reduce_only: false, reason: 'tick',
        cloid: hl.newCloid(), time_ms: h.clock.now() - 120_000, season: 1,
      });
      h.gardens.flush();
      // "Restart": a new testnet stack and Gardens on the same DB, double and master key.
      await h.gardens.shutdown({ drainMs: 0 });
      const h2 = await world({ db: h.db, dir: h.dir, double: h.double, clock: h.clock, engine: h.engine, masterKey: h.masterKey });
      await h.clock.run(10_000);
      const orders = h.db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id').all(h.uid);
      assert.equal(orders.find((o) => o.id === ghost.id).status, 'canceled');
      const real = orders.find((o) => o.kind === 'mirror' && o.id !== ghost.id);
      assert.equal(real.status, 'filled');
      const g = h2.gardens.get(h.uid);
      assert.equal(g.botById(row.id).real.szi, 0.08, 'applied from the exchange fills');
      assert.equal(g.botById(row.id).state, 'active');
      assert.equal(h.double.ordersFor(h.link.account).length, 1, 'nothing was sent twice');
      await h2.gardens.shutdown({ drainMs: 0 });
    } finally {
      h.db.close();
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  });
});

describe('testnet venue: browser-wallet approveAgent (P1, §6.10)', () => {
  let h;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  /** What the player's wallet does in the browser: EIP-712 sign the frozen-constant typed data (testnet chain). */
  function walletSign(keyHex, { agent_address: agentAddress, agent_name: agentName, nonce }, chainId = 421614) {
    const message = { hyperliquidChain: hl.HYPERLIQUID_CHAIN, agentAddress, agentName, nonce };
    const digest = hl.userSignedDigest(hl.APPROVE_AGENT_PRIMARY_TYPE, hl.APPROVE_AGENT_FIELDS, message, chainId);
    const sig = secp256k1.sign(digest, Buffer.from(keyHex, 'hex'), { lowS: true });
    return `0x${sig.r.toString(16).padStart(64, '0')}${sig.s.toString(16).padStart(64, '0')}${(27 + sig.recovery).toString(16)}`;
  }

  it('prepare → wallet signs → approve: relayed once, verified with the mainnet guard, then the agent trades', async () => {
    h = await world();
    h.engine.setBean(1, { coin: 'ETH', side: 1, units: 0.4, entry_px: 2490, leverage: 3, position_size: 0.5 });
    const uid = h.user('wallet');
    const acct = h.double.addAccount({ usd: 2000 });
    const prep = h.gardens.testnetAgentPrepare(uid);
    assert.deepEqual(Object.keys(prep).sort(), ['agent_address', 'agent_name', 'nonce'], 'only the public facts leave the server');
    assert.match(prep.agent_address, /^0x[0-9a-f]{40}$/);
    assert.match(prep.agent_name, /^bean-garden valid_until \d{13}$/);
    assert.equal(prep.nonce, h.clock.now());
    const until = Number(prep.agent_name.split(' ').pop());
    assert.equal(until - h.clock.now(), 90 * DAY);
    // A signature by another wallet is refused locally (422 signer_mismatch) and nothing is relayed.
    const other = h.double.addAccount({ usd: 10 });
    await assert.rejects(h.drive(h.gardens.testnetAgentApprove(uid, {
      accountAddress: acct.address, signature: walletSign(other.key, prep), nonce: prep.nonce, chainId: 421614,
    })), (err) => err instanceof ApiError && err.status === 422 && err.code === 'signer_mismatch');
    assert.equal(h.exch('approveAgent').length, 0);
    await assert.rejects(h.drive(h.gardens.testnetAgentApprove(uid, {
      accountAddress: acct.address, signature: walletSign(acct.key, prep), nonce: prep.nonce + 1, chainId: 421614,
    })), (err) => err instanceof ApiError && err.status === 400 && err.code === 'bad_request');
    // The right wallet: relayed once, then §6.7 verification (incl. the mainnet guard) and the sealed store.
    const mainnetBefore = h.double.mainnet.calls;
    const out = await h.drive(h.gardens.testnetAgentApprove(uid, {
      accountAddress: acct.address.toUpperCase().replace('0X', '0x'), signature: walletSign(acct.key, prep), nonce: prep.nonce, chainId: 421614,
    }), 10_000);
    assert.equal(h.exch('approveAgent').length, 1);
    assert.equal(out.testnet.status, 'verified');
    assert.equal(out.testnet.account_address, acct.address);
    assert.equal(out.testnet.agent_address, prep.agent_address);
    assert.equal(out.testnet.agent_name, 'bean-garden');
    assert.ok(h.double.mainnet.calls > mainnetBefore, 'the fail-closed mainnet guard ran');
    assert.equal(h.credentials.pendingAgent(uid), null, 'the prepared key is dropped once stored');
    // The generated agent signs real orders (the double recovers it as the account's approved agent).
    const g = h.gardens.get(uid);
    const row = await h.drive(g.create({ bean: 1, capital_usd: 200, venue: 'testnet', confirm: 'testnet' }));
    assert.equal(row.venue, 'testnet');
    assert.deepEqual(h.double.executed.map((e) => e.type), ['updateLeverage', 'order']);
    assert.equal(h.pos(acct.address), 0.08);
    // A second approve without a prepare: 404; an expired prepare: 404.
    await assert.rejects(h.gardens.testnetAgentApprove(uid, { accountAddress: acct.address, signature: walletSign(acct.key, prep), nonce: prep.nonce, chainId: 421614 }),
      (err) => err.status === 404 && err.code === 'not_found');
    const uid2 = h.user('slowpoke');
    const prep2 = h.gardens.testnetAgentPrepare(uid2);
    h.clock.ms += 10 * 60_000 + 1;
    await assert.rejects(h.gardens.testnetAgentApprove(uid2, { accountAddress: other.address, signature: walletSign(other.key, prep2), nonce: prep2.nonce, chainId: 421614 }),
      (err) => err.status === 404 && err.code === 'not_found');
  });

  it('approve checks the §6.7 step 8 conflicts BEFORE relaying (account already connected elsewhere)', async () => {
    h = await world();
    const owner = h.user('owner');
    const link = await h.connect(owner);
    const uid = h.user('intruder');
    const prep = h.gardens.testnetAgentPrepare(uid);
    const acctKey = h.double.accounts.get(link.account).key;
    await assert.rejects(h.drive(h.gardens.testnetAgentApprove(uid, {
      accountAddress: link.account, signature: walletSign(acctKey, prep), nonce: prep.nonce, chainId: 421614,
    })), (err) => err.status === 409 && err.code === 'account_in_use');
    assert.equal(h.exch('approveAgent').length, 0, 'nothing relayed');
  });
});

describe('testnet venue: refusals that never reach the exchange', () => {
  let h;
  beforeEach(async () => {
    h = await plantedWorld();
  });
  afterEach(async () => {
    await h.close();
  });

  it('confirm:"testnet" is required; unlisted / delisted coins; one bot per coin across venues; caps', async () => {
    await assert.rejects(h.drive(h.g.create({ bean: 1, capital_usd: 100, venue: 'testnet' })), (err) => err.code === 'confirm_required');
    await plant(h);
    // The same coin on paper is refused (one bot per coin across venues).
    assert.throws(() => h.g.create({ bean: 1, capital_usd: 100 }), (err) => err instanceof ApiError && err.code === 'bean_bound');
    h.engine.setBean(6, { coin: 'ETH', side: 1, units: 0.1, entry_px: 2400 });
    await assert.rejects(plant(h, { bean: 6 }), (err) => err.code === 'coin_bound');
    h.engine.setBean(7, { coin: 'AVAX', side: 1, units: 10, entry_px: 10, leverage: 2, position_size: 0.5 });
    await assert.rejects(plant(h, { bean: 7, capital: 600 }), (err) => err.code === 'testnet_caps');
    const q = h.g.testnetQuote({ bean: 7, capital_usd: 50 });
    assert.equal(q.ok, true);
    assert.equal(q.coin, 'AVAX');
    assert.ok(q.slippage_max_usd > 0 && q.flatten_slippage_max_usd === Number((0.05 * q.notional_usd).toFixed(6)));
    // "Fees ≈ … to open and close": the round trip (both taker sides), like the paper quote's fee line — never one side
    // (the paper line, fee + spread on both sides, is the same order of magnitude for the same notional).
    assert.ok(Math.abs(q.fees_est_usd - 2 * 0.00045 * q.notional_usd) < 1e-5, `round trip ${q.fees_est_usd}`);
    assert.ok(Math.abs(q.fee_open_usd - 0.00045 * q.notional_usd) < 1e-5);
    const paperFees = q.notional_usd * (0.00045 + 0.00015) * 2;
    assert.ok(q.fees_est_usd / paperFees > 0.7 && q.fees_est_usd <= paperFees, 'testnet and paper fee lines agree in size');
    await h.bar(); // the cache shows what the last reconcile saw
    const status = h.g.testnetStatus();
    assert.equal(status.state, 'live');
    assert.equal(status.positions[0].coin, 'ETH');
    assert.equal(status.positions[0].bot, 'bot-0000');
    const live = h.g.status();
    assert.equal(live.venues.testnet.connected, true);
    assert.equal(live.venues.testnet.bots_open, 1);
    assert.match(live.venues.testnet.account_address, /^0x[0-9a-f]{4}…[0-9a-f]{4}$/);
  });

  it('halt: paper bots close at once, testnet bots are listed as closing and flatten', async () => {
    const row = await plant(h);
    const out = h.g.halt();
    assert.deepEqual(out.closing, [row.id]);
    await h.clock.run(10_000);
    assert.equal(h.pos(h.link.account), 0);
    assert.equal(h.g.botById(row.id).state, 'closed');
    assert.ok(h.of(h.uid, 'live_halted')[0].closing.includes(row.id));
  });

  it('a mainnet re-check HIT flattens, wipes the key, pauses with mainnet_key and emits credential_status', async () => {
    const row = await plant(h);
    h.double.mainnet.roles.set(h.link.agent, { role: 'user' });
    h.db.prepare("UPDATE credentials SET mainnet_checked_ms = ? WHERE user_id = ?").run(h.clock.now() - 2 * DAY, h.uid);
    const p = h.gardens.mainnetRecheckSweep();
    await h.clock.run(30_000);
    const r = await p;
    assert.equal(r.hit, true);
    assert.equal(h.pos(h.link.account), 0, 'flattened before the wipe');
    assert.equal(h.credentials.link(h.uid), null, 'the key is wiped');
    assert.equal(h.g.botById(row.id).note_code, 'mainnet_key');
    assert.equal(h.of(h.uid, 'credential_status').at(-1).reason, 'mainnet_key');
  });
});

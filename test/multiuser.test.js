// Multi-tenant gardens on one engine (PLATFORM §7, §8.7, §11.2 multiuser; WP3).
//
// Two or three players share ONE real engine (sim feed, small population) and ONE SQLite DB (WP1 openDb + migrate).
// Covered: fail-closed isolation (an owner garden refuses the raw journal; an unscoped user emit throws and is never
// stored or broadcast; the scoped pulse refuses garden keys; wireAccounts' shared frames carry none), per-player bots /
// live_status / live_fills / events / marks, the same bean and coin across players, one bot per coin and bean within
// a garden, per-player venue verdicts, halt + re-arm, seasons (garden_reset), Last-Event-ID replay merging global and
// user records, restart from the DB, per-garden SAVEPOINT flushes, and teardown + epoch: a deleted player's pending
// flatten retry never runs against a later garden (with the WP2 testnet double, offline).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Engine } from '../server/engine.js';
import { Journal, GLOBAL_KINDS, recordUid } from '../server/journal.js';
import { LiveLayer, ApiError, REARM_AFTER_MS, RESET_EVERY_MS } from '../server/live.js';
import { Pulse, GARDEN_KEYS } from '../server/pulse.js';
import { wireAccounts } from '../server/main.js';
import { openDb, MIGRATIONS_DIR } from '../server/db/db.js';
import { migrate } from '../server/db/migrate.js';
import { Gardens } from '../server/garden/gardens.js';

const quiet = () => {};

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bean-${tag}-`));
}

function openTestDb(dir) {
  const db = openDb({ file: path.join(dir, 'bean-sim.db') });
  migrate(db, MIGRATIONS_DIR, { backupDir: path.join(dir, 'backups') });
  return db;
}

/** A user row (the test owns the DB; WP1's Users would hash a password first). */
function addUser(db, name, { id = null, now = Date.now() } = {}) {
  const sql = id === null
    ? 'INSERT INTO users (username, pw_hash, created_ms, updated_ms, pw_changed_ms) VALUES (?, ?, ?, ?, ?)'
    : 'INSERT INTO users (id, username, pw_hash, created_ms, updated_ms, pw_changed_ms) VALUES (?, ?, ?, ?, ?, ?)';
  const args = [name, 'scrypt$test', now, now, now];
  const res = id === null ? db.prepare(sql).run(...args) : db.prepare(sql).run(id, ...args);
  return Number(res.lastInsertRowid);
}

function rejects(fn, status, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ApiError, `expected ApiError, got ${err}`);
    assert.equal(err.status, status, err.message);
    if (code) assert.equal(err.code, code, err.message);
    return true;
  });
}

/** Positioned, tradeable beans on distinct coins (for planting). */
function positionedBeans(engine, n) {
  const out = [];
  const coins = new Set();
  const { rows } = engine.population.query({ in_position: true, busted: false, sort: 'fitness', limit: 3000 });
  for (const r of rows) {
    if (coins.has(r.coin) || r.venue_reason) continue;
    coins.add(r.coin);
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

describe('multiuser: many gardens on one engine (accounts mode)', () => {
  let dir;
  let db;
  let engine;
  let journal;
  let pulse;
  let gardens;
  const clock = { ms: Date.now() };
  const now = () => clock.ms;
  let alice;
  let bob;
  let carol;
  const records = [];
  const frames = [];

  before(async () => {
    dir = tmpDir('multiuser');
    db = openTestDb(dir);
    journal = new Journal({ scoped: true, globalKinds: GLOBAL_KINDS, keep: 200, log: quiet });
    journal.subscribe((r) => records.push(r));
    pulse = new Pulse({ scoped: true, log: quiet });
    pulse.subscribe((m) => frames.push(m));
    engine = new Engine({ config: { seed: 42, beans: 300, warmupBars: 300, tickMs: 60_000, log: quiet }, journal });
    gardens = new Gardens({ engine, journal, db, now, log: quiet });
    await gardens.init();
    wireAccounts({ engine, gardens, pulse });
    await engine.start();
    alice = addUser(db, 'alice');
    bob = addUser(db, 'bob');
    carol = addUser(db, 'carol');
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a garden with an owner refuses the raw journal and another player\'s facade (fail-closed, §7.1 #7)', () => {
    const base = { config: {}, engine, now, log: quiet, owner: { uid: alice, username: 'alice' } };
    assert.throws(() => new LiveLayer({ ...base, journal }), /forUser/);
    assert.throws(() => new LiveLayer({ ...base, journal: journal.forUser(bob) }), /forUser/);
    assert.throws(() => new LiveLayer({ ...base, journal: null }), /forUser/);
    // The right facade works (and is frozen).
    const facade = journal.forUser(alice);
    assert.ok(Object.isFrozen(facade));
    assert.doesNotThrow(() => new LiveLayer({ ...base, journal: facade }));
  });

  it('an unscoped user emit throws and is never stored or broadcast; global kinds still flow (§8.7)', () => {
    const seq = journal.lastSeq;
    const n = records.length;
    assert.throws(() => journal.emit('bot_fill', { bot: 'bot-0000' }), (err) => err.code === 'unscoped_user_event');
    assert.equal(journal.lastSeq, seq, 'no seq was consumed');
    assert.equal(records.length, n, 'never broadcast');
    assert.equal(journal.query({ kind: 'bot_fill' }).total, 0, 'never in the global ring');
    const g = journal.emit('feed_status', { state: 'sim' });
    assert.equal(recordUid(g), null);
    const u = journal.emit('bot_fill', { bot: 'bot-0000' }, { uid: alice });
    assert.equal(recordUid(u), alice);
    assert.ok(!('uid' in JSON.parse(JSON.stringify(u))), 'the owner uid never serializes');
  });

  it('the scoped pulse refuses garden keys; wireAccounts frames carry none (spectator mids)', () => {
    for (const key of GARDEN_KEYS) {
      assert.throws(() => pulse.publish('mids', { t: 1, [key]: {} }), (err) => err.code === 'garden_key_in_shared_frame');
    }
    frames.length = 0;
    engine.tick();
    const mids = frames.filter((f) => f.kind === 'mids');
    assert.ok(mids.length >= 1, 'a mids frame was published');
    for (const f of mids) for (const key of GARDEN_KEYS) assert.ok(!(key in f), `shared frame has no ${key}`);
    assert.throws(() => wireAccounts({ engine: { setVenueHook() {}, onTick() {}, onMarks() {} }, gardens, pulse: new Pulse() }), /scoped Pulse/);
  });

  it('the same bean and coin can be planted by two players; within one garden one bot per coin and per bean', () => {
    const [b1, b2] = positionedBeans(engine, 2);
    const ga = gardens.get(alice);
    const gb = gardens.get(bob);
    const ra = ga.create({ bean: b1.id, capital_usd: 200 });
    const rb = gb.create({ bean: b1.id, capital_usd: 300 });
    assert.equal(ra.id, 'bot-0000');
    assert.equal(rb.id, 'bot-0000', 'bot ids are numbered per garden');
    assert.equal(ra.venue, 'paper');
    assert.equal(ra.bean, rb.bean);
    rejects(() => ga.create({ bean: b1.id, capital_usd: 100 }), 409, 'bean_bound');
    // Another bean on the same coin: coin_bound within the garden.
    const sameCoin = engine.population.query({ coin: b1.coin, busted: false, limit: 50 }).rows.find((r) => r.id !== b1.id && !r.venue_reason);
    if (sameCoin) rejects(() => ga.create({ bean: sameCoin.id, capital_usd: 100 }), 409, 'coin_bound');
    const r2 = ga.create({ bean: b2.id, capital_usd: 150 });
    assert.equal(r2.id, 'bot-0001');
    // Accounts mode rows carry the §8.5 additions.
    for (const k of ['venue', 'price_source', 'closing', 'exchange_sync', 'exchange', 'size_ratio', 'target_szi', 'fill_state',
      'funding_realized', 'fees_estimated', 'est', 'dust', 'note_code', 'note_vars']) assert.ok(k in ra, `BotRow.${k}`);
    assert.equal(ra.price_source, 'sim');
  });

  it('bots, live_status, live_fills and events are isolated per player', () => {
    const ga = gardens.get(alice);
    const gb = gardens.get(bob);
    const gc = gardens.get(carol);
    assert.equal(ga.bots().total, 2);
    assert.equal(gb.bots().total, 1);
    assert.equal(gc.bots().total, 0);
    const sa = ga.status();
    const sb = gb.status();
    assert.deepEqual(sa.user, { id: alice, username: 'alice' });
    assert.deepEqual(sb.user, { id: bob, username: 'bob' });
    assert.equal(sa.venues.paper.bots_open, 2);
    assert.equal(sb.venues.paper.bots_open, 1);
    assert.equal(sa.venues.testnet, null, 'testnet disabled server-wide → null');
    assert.equal(sa.season, 1);
    // Fills come from the DB, only the player's own.
    const fa = ga.fills({ limit: 100 });
    const fb = gb.fills({ limit: 100 });
    assert.ok(fa.total >= 1 && fb.total >= 1, 'both mirrored their positioned bean at once');
    assert.ok(fa.rows.every((f) => f.venue === 'paper' && f.season === 1));
    const detail = ga.botDetail('bot-0000');
    assert.ok(detail.fills.length >= 1 && detail.orders.length >= 1);
    // Events: each player sees only its own user records (+ global).
    const ea = journal.queryFor(alice, { limit: 1000 }).rows;
    const eb = journal.queryFor(bob, { limit: 1000 }).rows;
    const es = journal.queryFor(null, { limit: 1000 }).rows;
    assert.ok(ea.some((r) => r.kind === 'bot_created'));
    assert.ok(ea.every((r) => recordUid(r) === null || recordUid(r) === alice));
    assert.ok(eb.every((r) => recordUid(r) === null || recordUid(r) === bob));
    assert.ok(es.every((r) => recordUid(r) === null && GLOBAL_KINDS.includes(r.kind)), 'spectators: global only');
    const createdA = ea.filter((r) => r.kind === 'bot_created').length;
    const createdB = eb.filter((r) => r.kind === 'bot_created').length;
    assert.equal(createdA, 2);
    assert.equal(createdB, 1);
  });

  it('stream delivery: a subscriber gets its own user records and global ones; a spectator global only', () => {
    const forA = [];
    const forSpectator = [];
    const off = journal.subscribe((r) => {
      if (journal.visibleTo(r, alice)) forA.push(r);
      if (journal.visibleTo(r, null)) forSpectator.push(r);
    });
    try {
      engine.tick();
      gardens.get(bob).pause({ id: 'bot-0000' });
      gardens.get(alice).pause({ id: 'bot-0001' });
    } finally {
      off();
    }
    assert.ok(forA.some((r) => r.kind === 'tick_completed'));
    assert.ok(forA.some((r) => r.kind === 'bot_paused' && recordUid(r) === alice));
    assert.ok(!forA.some((r) => recordUid(r) === bob), 'A never receives B\'s bot_* records');
    assert.ok(forSpectator.every((r) => recordUid(r) === null));
    assert.ok(forSpectator.some((r) => r.kind === 'tick_completed'));
  });

  it('mids: marksFor is per player and memoized per frame; spectators and unloaded gardens get null', () => {
    engine.tick();
    const pa = gardens.marksFor(alice);
    const pb = gardens.marksFor(bob);
    assert.ok(pa && pb);
    assert.deepEqual(Object.keys(pa), ['bots', 'account', 'testnet_account']);
    assert.ok(Object.keys(pa.bots).length >= 1);
    assert.equal(pa.testnet_account, null);
    assert.equal(gardens.marksFor(alice), pa, 'memoized within one frame');
    assert.equal(gardens.marksFor(null), null);
    assert.equal(gardens.marksFor(999_999), null);
    engine.tick();
    assert.notEqual(gardens.marksFor(alice), pa, 'a new frame rebuilds');
  });

  it('Last-Event-ID replay merges global and user records in seq order; too old → resync', () => {
    const from = journal.lastSeq;
    engine.tick();
    gardens.get(alice).resume({ id: 'bot-0001' });
    gardens.get(bob).resume({ id: 'bot-0000' });
    engine.tick();
    gardens.flush();
    const replay = journal.sinceFor(alice, from);
    assert.ok(Array.isArray(replay) && replay.length >= 3);
    for (let i = 1; i < replay.length; i++) assert.ok(replay[i].seq > replay[i - 1].seq, 'ascending seq');
    assert.ok(replay.some((r) => r.kind === 'tick_completed'));
    assert.ok(replay.some((r) => r.kind === 'bot_resumed' && recordUid(r) === alice));
    assert.ok(replay.every((r) => recordUid(r) === null || recordUid(r) === alice));
    const spect = journal.sinceFor(null, from);
    assert.ok(spect.every((r) => recordUid(r) === null));
    // Older than the global ring (keep 200): resync.
    for (let i = 0; i < 220; i++) journal.emit('feed_status', { state: 'sim', i });
    assert.deepEqual(journal.sinceFor(alice, from), { resync: true });
  });

  it('beans.tradeable is the player\'s own paper verdict (venueFor); spectators get the default', () => {
    const bean = gardens.get(alice).botById('bot-0000').bean;
    const forAlice = engine.population.row(bean, gardens.venueFor(alice));
    const forCarol = engine.population.row(bean, gardens.venueFor(carol));
    const spectator = engine.population.row(bean);
    assert.equal(forAlice.tradeable, false);
    assert.equal(forAlice.venue_reason, 'bean_bound');
    assert.equal(forAlice.bot, 'bot-0000');
    assert.equal(forCarol.bot, null);
    assert.equal(forCarol.venue_reason === 'bean_bound', false);
    assert.equal(spectator.bot, null, 'the engine default never shows a player\'s bot');
    const q = engine.population.query({ ids: [bean] }, { venue: gardens.venueFor(alice) });
    assert.equal(q.rows[0].bot, 'bot-0000');
  });

  it('halt is per player and persisted; re-arm needs REARM and 60 s; other players keep planting', () => {
    const gc = gardens.get(carol);
    const [bean] = positionedBeans(engine, 1);
    gc.create({ bean: bean.id, capital_usd: 100 });
    const out = gc.halt();
    assert.equal(out.halted, true);
    assert.deepEqual(out.closing, []);
    assert.equal(out.closed.length, 1);
    rejects(() => gc.create({ bean: bean.id, capital_usd: 100 }), 409, 'halted');
    assert.match(gc.status().disabled_reason, /re-arm/);
    assert.doesNotMatch(gc.status().disabled_reason, /restart/i, 'accounts mode never says restart (U4)');
    assert.equal(gc.status().rearm_after_ms, gc.haltedMs + REARM_AFTER_MS);
    // Bob is not halted.
    assert.equal(gardens.get(bob).halted, false);
    rejects(() => gc.rearm({ confirm: 'yes' }), 400, 'confirm_required');
    assert.throws(() => gc.rearm({ confirm: 'REARM' }), (err) => err.code === 'too_soon' && err.extra.retry_after_s > 0);
    clock.ms += REARM_AFTER_MS + 1;
    assert.deepEqual(gc.rearm({ confirm: 'REARM' }), { halted: false });
    assert.ok(journal.queryFor(carol, { kind: 'garden_rearmed' }).total >= 1);
    assert.doesNotThrow(() => gc.create({ bean: bean.id, capital_usd: 100 }));
  });

  it('garden_reset: a new paper season; once per 24 h; refused while burned; the old season stays queryable', () => {
    const gb = gardens.get(bob);
    const before = gb.fills({ limit: 1000 }).total;
    assert.ok(before > 0);
    const open = gb.bots({ state: 'open' }).rows.map((r) => r.id);
    const res = gardens.resetSeason(bob, { confirm: 'RESET' });
    assert.equal(res.season, 2);
    assert.deepEqual(res.closed, open);
    assert.equal(res.account_usd, 10_000);
    const st = gb.status();
    assert.equal(st.season, 2);
    assert.equal(st.realized_pnl, 0, 'the new season starts clean');
    assert.equal(st.account_state.account_value, 10_000);
    assert.equal(gb.bots().total, 0, 'old-season closed paper bots are not listed by default');
    assert.equal(gb.bots({ season: 1 }).total, 1);
    assert.equal(gb.fills({ limit: 1000 }).total, 0, 'paper queries default to the current season');
    assert.equal(gb.fills({ limit: 1000, season: 1 }).total, before + 1, 'the old season is kept (+ the reset close fill)');
    assert.ok(journal.queryFor(bob, { kind: 'garden_reset' }).rows[0].season === 2);
    assert.throws(() => gardens.resetSeason(bob, { confirm: 'RESET' }), (err) => err.code === 'too_soon' && err.extra.retry_after_s > 0);
    clock.ms += RESET_EVERY_MS + 1;
    gb.halt();
    rejects(() => gardens.resetSeason(bob, { confirm: 'RESET' }), 409, 'halted');
    rejects(() => gardens.resetSeason(bob, { confirm: 'reset' }), 400, 'confirm_required');
    // A bot id is never reused across seasons.
    clock.ms += REARM_AFTER_MS + 1;
    gb.rearm({ confirm: 'REARM' });
    const [bean] = positionedBeans(engine, 1);
    assert.equal(gb.create({ bean: bean.id, capital_usd: 50 }).id, 'bot-0001');
  });

  it('restart: a new Gardens on the same DB restores bots, season and halt; seq never regresses', () => {
    gardens.flush();
    const maxSeq = journal.lastSeq;
    const j2 = new Journal({ scoped: true, globalKinds: GLOBAL_KINDS, log: quiet });
    const g2 = new Gardens({ engine: { ...engine, population: engine.population, market: engine.market, catchingUp: false, prices: 'sim', setVenueHook() {}, onTick() {}, onMarks() {} }, journal: j2, db, now, log: quiet });
    assert.ok(j2.lastSeq >= Math.min(maxSeq, db.prepare('SELECT max(seq) AS m FROM events').get().m), 'seq jumps past the stored user records');
    const a1 = gardens.get(alice).bots().rows.map((r) => [r.id, r.state, r.bean, r.capital_usd]);
    const a2 = g2.get(alice).bots().rows.map((r) => [r.id, r.state, r.bean, r.capital_usd]);
    assert.deepEqual(a2, a1);
    assert.equal(g2.get(bob).season, 2);
    assert.equal(g2.get(alice).botById('bot-0000').real.szi, gardens.get(alice).botById('bot-0000').real.szi);
    const halted = gardens.get(carol).halted;
    assert.equal(g2.get(carol).halted, halted);
  });

  it('flush: one garden\'s bad row rolls back only its own SAVEPOINT; the others commit', () => {
    const repo = gardens.repo;
    gardens.flush();
    const t = now();
    repo.addFill(carol, { bot: 'bot-0000', coin: 'BTC', dir: 'Open Long', side: 'B', sz: 0, px: 1, fee: 0, closed_pnl: 0, time_ms: t, venue: 'paper', season: 1 });
    const okRecord = journal.emit('garden_rearmed', { probe: 'flush' }, { uid: alice });
    const res = repo.flush();
    assert.deepEqual(res.failed, [carol]);
    const stored = db.prepare('SELECT count(*) AS n FROM events WHERE seq = ?').get(okRecord.seq).n;
    assert.equal(stored, 1, 'alice\'s write committed');
    repo.forget(carol); // drop the poisoned row (it would be retried forever otherwise)
  });

  it('kill switch: a global record; paper bots are untouched', () => {
    const openBefore = gardens.get(alice).bots({ state: 'open' }).total;
    const res = gardens.killSwitch({ on: true, reason: 'drill' });
    assert.equal(res.kill_switch.on, true);
    assert.deepEqual(res.flattening, []);
    const rec = journal.query({ kind: 'kill_switch' }).rows[0];
    assert.equal(recordUid(rec), null);
    assert.equal(rec.reason, 'drill');
    assert.equal(gardens.get(alice).bots({ state: 'open' }).total, openBefore);
    gardens.killSwitch({ on: false });
    assert.equal(gardens.killSwitchState().on, false);
  });
});

// ---- composition (main.js accounts mode) -------------------------------------------------------------------------------

describe('multiuser: main.js composition in accounts mode', () => {
  it('startRuntime + buildAccounts wire the gardens before the engine starts; `live: null` state resumes only in accounts mode', async () => {
    const { parseConfig, startRuntime, buildAccounts, stateFiles } = await import('../server/main.js');
    const { saveState } = await import('../server/store.js');
    const dir = tmpDir('compose');
    const args = ['--feed', 'sim', '--data', dir, '--beans', '300', '--warmup', '300', '--port', '0'];
    const accountsCfg = parseConfig(['--auth', 'accounts', '--public-origin', 'http://localhost:8463', ...args], {});
    assert.equal(accountsCfg.auth, 'accounts');
    let acct = null;
    try {
      const { runtime } = await startRuntime({
        config: accountsCfg, version: 'test', log: quiet,
        beforeStart: async (rt, cfg) => {
          acct = await buildAccounts({ config: cfg, runtime: rt, log: quiet });
        },
      });
      assert.equal(runtime.live, null, 'no shared LiveLayer in accounts mode');
      assert.equal(runtime.journal.scoped, true);
      assert.equal(runtime.pulse.scoped, true);
      assert.ok(acct.gardens && acct.bag.users && acct.bag.sessions && acct.bag.gardens === acct.gardens);
      assert.equal(acct.testnet, null, 'no testnet with the sim feed');
      // A player plants; the tick hook mirrors through Gardens (wired before engine.start()).
      const uid = addUser(acct.platform.db, 'compose');
      const g = acct.gardens.get(uid);
      const bean = positionedBeans(runtime.engine, 1)[0];
      const row = g.create({ bean: bean.id, capital_usd: 100 });
      runtime.engine.tick();
      assert.ok(g.botById(row.id).last_reconcile_ms !== null);
      // The JSON state of accounts mode holds no garden (`live: null`).
      const { stateFile } = stateFiles(accountsCfg.dataDir, 'sim');
      saveState(stateFile, {
        version: 1, seed: accountsCfg.seed, beans: accountsCfg.beans, feed: 'sim', saved_ms: Date.now(),
        engine: runtime.engine.serialize(), live: null, journal: runtime.journal.serialize(),
      });
      runtime.engine.stop();
      await acct.close();
      acct = null;
      // Accounts mode resumes it …
      const again = await startRuntime({
        config: accountsCfg, version: 'test', log: quiet,
        beforeStart: async (rt, cfg) => {
          acct = await buildAccounts({ config: cfg, runtime: rt, log: quiet });
        },
      });
      assert.equal(again.runtime.restored, true);
      assert.equal(acct.gardens.get(uid).botById(row.id).state, 'active', 'the garden came back from the DB');
      again.runtime.engine.stop();
      await acct.close();
      acct = null;
      // … none mode refuses a state without its garden (§2.4 #8) and starts fresh.
      const lines = [];
      const none = await startRuntime({ config: parseConfig(args, {}), version: 'test', log: (l) => lines.push(l) });
      assert.equal(none.runtime.restored, false);
      assert.ok(lines.some((l) => /incomplete state/.test(l)));
      none.runtime.engine.stop();
    } finally {
      if (acct) await acct.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('multiuser: main.js composition with --testnet-double (§11.1, T-GUARD j)', () => {
  it('buildAccounts wires the in-process double: connect + a testnet plant work, and zero requests reach any real host', async () => {
    const { parseConfig, startRuntime, buildAccounts } = await import('../server/main.js');
    const { makeHL } = await import('./fixtures/hl-double.js');
    const dir = tmpDir('tndouble');
    const realFetch = globalThis.fetch;
    const real = [];
    // Anything that would leave the process through the global fetch is recorded and refused.
    globalThis.fetch = async (url) => {
      real.push(String(url?.url ?? url));
      throw new Error('real network reached');
    };
    let acct = null;
    let runtime = null;
    try {
      const config = parseConfig(['--auth', 'accounts', '--public-origin', 'http://localhost:8463', '--testnet-double',
        '--data', dir, '--beans', '300', '--warmup', '90', '--port', '0'], {});
      assert.equal(config.testnetDouble, true);
      assert.equal(config.feed, 'hyperliquid', 'the testnet venue needs the real feed');
      // The mainnet feed is the offline mainnet double (tests only; the CLI never sets `fetch`). Mutated in place: the
      // config's non-enumerable `secrets` (the ephemeral dev master key) must survive.
      config.fetch = makeHL({ get ms() { return Date.now(); } }).fetch;
      ({ runtime } = await startRuntime({
        config, version: 'test', log: quiet,
        beforeStart: async (rt, cfg) => {
          acct = await buildAccounts({ config: cfg, runtime: rt, log: quiet });
        },
      }));
      assert.ok(acct.testnet && acct.double, 'the testnet venue is the in-process double');
      assert.ok(acct.bag.devDouble && acct.bag.testnetLink, 'dev_double and the testnet link service are in the platform bag');
      assert.equal(acct.gardens.testnetMarket().state, 'live');
      const uid = addUser(acct.platform.db, 'doubler');
      const na = acct.double.script('new_account', { usd: 3000 });
      const conn = await acct.gardens.testnetConnect(uid, { account_address: na.account_address, agent_key: na.agent_key });
      assert.equal(conn.testnet.status, 'verified');
      assert.ok(acct.double.mainnet.calls >= 1, 'the mainnet userRole guard was answered by the double');
      // A positioned bean on a coin listed on testnet, planted on the testnet venue (ack: the double's prices diverge).
      const g = acct.gardens.get(uid);
      const { rows } = runtime.engine.population.query({ in_position: true, busted: false, sort: 'fitness', limit: 3000 });
      const bean = rows.find((r) => ['ETH', 'SOL', 'BTC', 'AVAX'].includes(r.coin) && !r.venue_reason
        && g.testnetQuote({ bean: r.id, capital_usd: 100 }).ok);
      assert.ok(bean, 'a plantable bean');
      const row = await g.create({ bean: bean.id, capital_usd: 100, venue: 'testnet', confirm: 'testnet', ack_divergence: true });
      assert.equal(row.venue, 'testnet');
      assert.deepEqual(acct.double.executed.map((e) => e.type).slice(0, 2), ['updateLeverage', 'order']);
      assert.notEqual(g.botById(row.id).real.szi, 0, 'the opening IOC filled on the double');
      assert.deepEqual(real, [], 'zero requests to any real host');
      assert.deepEqual(acct.double.violations, []);
    } finally {
      runtime?.engine.stop();
      if (acct) await acct.close();
      globalThis.fetch = realFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- teardown + epoch with the testnet double ------------------------------------------------------------------------

/** A controllable clock: sleeps resolve only when run() advances time (scheduler sleeps, lane timers, resends). */
class ManualClock {
  constructor(ms) {
    this.ms = ms;
    this.sleeps = [];
    this.now = () => this.ms;
    this.sleep = (ms) => new Promise((resolve) => this.sleeps.push({ at: this.ms + Math.max(0, ms), resolve }));
  }

  async settle(rounds = 30) {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
  }

  /** Advance through pending sleeps for up to `maxMs` of fake time. */
  async run(maxMs = 1000) {
    const until = this.ms + maxMs;
    for (let i = 0; i < 5000; i++) {
      await this.settle();
      if (!this.sleeps.length) return;
      this.sleeps.sort((a, b) => a.at - b.at);
      if (this.sleeps[0].at > until) {
        this.ms = until;
        return;
      }
      const next = this.sleeps.shift();
      if (next.at > this.ms) this.ms = next.at;
      next.resolve();
    }
  }
}

describe('multiuser: teardown + epoch (a deleted player\'s pending work never touches a later garden)', () => {
  let hl;
  let dbl;
  let dir;
  let db;

  before(async () => {
    hl = await import('../server/hl/index.js');
    ({ makeTestnetDouble: dbl } = await import('./fixtures/hl-testnet-double.js'));
    dir = tmpDir('epoch');
    db = openTestDb(dir);
  });

  after(() => {
    db?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('delete the max-uid player while a flatten retry is pending; neither a new uid nor a reused uid sees it', async () => {
    const { Secrets, wipeCredentials } = await import('../server/secrets.js');
    const { Credentials } = await import('../server/garden/credentials.js');
    const clock = new ManualClock(Date.now());
    const double = dbl({ now: clock.now });
    const testnet = hl.createTestnet({
      fetch: double.fetch, now: clock.now, sleep: clock.sleep, log: quiet, mainnetClient: double.mainnetInfo,
      coins: ['ETH', 'BTC'], timers: { setTimeout: () => null, clearTimeout() {} },
    });
    await testnet.market.refreshMeta();
    await testnet.market.pollMids();
    // A fake engine: one ETH bean we control; mainnet mid = testnet mid (k = 1).
    const bean = { id: 7, coin: 'ETH', leverage: 3, position_size: 0.5, equity: 1000, side: 1, units: 0.4, entry_px: 2490, busted: false };
    const engine = {
      population: { row: (id) => (id === 7 ? { ...bean } : null) },
      market: {
        coins: [{ coin: 'ETH' }, { coin: 'BTC' }],
        mid: () => 2492.45, livePx: () => 2492.45,
        coinInfo: (c) => (c === 'ETH' ? { coin: 'ETH', max_leverage: 25, sz_decimals: 4 } : null),
      },
      catchingUp: false, prices: 'real', canOpen: () => null,
    };
    const journal = new Journal({ scoped: true, globalKinds: GLOBAL_KINDS, log: quiet });
    const lib = { wire: hl, format: hl, errors: hl, constants: hl, signing: hl, addr: hl, verify: { parseAgentKey: hl.parseAgentKey } };
    const credentials = new Credentials({ db, secrets: new Secrets({ masterKey: crypto.randomBytes(32) }), makeSigner: hl.makeSigner, wipeCredentials, now: clock.now, log: quiet });
    const gardens = new Gardens({ engine, journal, db, testnet, lib, credentials, now: clock.now, log: quiet, mainnetInfo: double.mainnetInfo });
    await gardens.init();

    const uid = addUser(db, 'dora', { now: clock.now() });
    const acct = double.addAccount({ usd: 2000 });
    const agent = double.addAgent(acct.address);
    const connect = gardens.testnetConnect(uid, { account_address: acct.address, agent_key: agent.key });
    await clock.run(5000);
    const link = await connect;
    assert.equal(link.testnet.status, 'verified');
    const g = gardens.get(uid);
    const created = g.create({ bean: 7, capital_usd: 200, venue: 'testnet', confirm: 'testnet', ack_divergence: true });
    await clock.run(5000);
    const row = await created;
    assert.equal(row.venue, 'testnet');
    assert.ok(Math.abs(double.position(acct.address, 'ETH')?.szi ?? 0) > 0, 'the opening IOC filled on the double');

    // Make every exchange request time out, then pause: the flatten fails and schedules its 15 s retry.
    double.fault({ kind: 'timeout', path: 'exchange', times: 1000 });
    const paused = g.pause({ id: row.id });
    await clock.run(20_000);
    await paused;
    const epochBefore = gardens.epochOf(uid);
    assert.ok(clock.sleeps.length > 0, 'a flatten retry is pending on the fake clock');

    // Delete (force): the halt's close flattens once more (and fails); teardown then cancels the lane, its queued jobs
    // and its retry timers; the user row is deleted (cascade). Only a little fake time passes: the 15 s retry that the
    // failed flatten scheduled is still PENDING when the garden is torn down.
    const deleting = gardens.deleteUser(uid, { force: true, remove: (id) => db.prepare('DELETE FROM users WHERE id = ?').run(id) });
    await clock.run(2_000);
    const del = await deleting;
    assert.equal(del.deleted, true);
    assert.equal(gardens.peek(uid), null);
    assert.equal(gardens.epochOf(uid), null, 'a torn-down uid has no epoch any more');
    assert.ok(clock.sleeps.some((s) => s.at > clock.ms), 'the retry timer was still pending at teardown');
    const exchBefore = double.requestsOf('exchange').length;
    const infoBefore = double.requests.filter((r) => r.path === 'info' && r.user === acct.address).length;

    // A later sign-up gets a NEW uid (AUTOINCREMENT) …
    const next = addUser(db, 'eve', { now: clock.now() });
    assert.ok(next > uid, 'uids are never reused');
    // … and even a deliberately REUSED uid gets a fresh garden with a NEW epoch.
    addUser(db, 'dora2', { id: uid, now: clock.now() });
    const reborn = gardens.get(uid);
    assert.equal(reborn.botList.length, 0);
    assert.notEqual(gardens.epochOf(uid), epochBefore);
    double.clearFaults();
    await clock.run(120_000); // any surviving retry would fire here
    assert.equal(double.requestsOf('exchange').length, exchBefore, 'no exchange request of the old garden ran after teardown');
    assert.equal(double.requests.filter((r) => r.path === 'info' && r.user === acct.address).length, infoBefore,
      'no info request for the old account either');
    assert.equal(reborn.botList.length, 0, 'nothing was applied to the new garden');
    assert.equal(db.prepare('SELECT count(*) AS n FROM orders WHERE user_id = ?').get(uid).n, 0);
    await gardens.shutdown({ drainMs: 0 });
  });
});

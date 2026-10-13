// Integration fixes across work packages (PLATFORM §12.2; the integrator's checks after the M1–M3 gates).
//
// Offline. Covers what the live gate runs found between packages:
//   - exchange_sync.attempts counts failed tries (WP3 live.js), and the BotRow carries `last_error_code` /
//     `last_error_vars` so the inspector (WP5) can localize an error after a reload, also across a restart (repo);
//   - the testnet double's dev faults `mainnet_role` / `mainnet_down` drive the fail-closed mainnet guard (§6.7 step 4)
//     end to end through Gardens.testnetConnect, and `idBase` keeps a restarted double from reusing oids/tids;
//   - Gardens.stats().mainnet feeds admin_status.mainnet (rechecks due);
//   - the client side: view.venueFields maps last_error_code and botErrorInfo localizes it without a live_error event.

import { describe, it, afterEach } from 'node:test';
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
import { makeTestnetDouble, DEV_FAULTS } from './fixtures/hl-testnet-double.js';

const quiet = () => {};
const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);
const MAINNET = {
  ETH: { max_leverage: 25, sz_decimals: 4, mid: 2492.45 },
  SOL: { max_leverage: 20, sz_decimals: 2, mid: 108.91 },
};

/** Fake time: scheduler sleeps resolve only when run() advances it. */
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

const LIB = {
  wire: hl, format: hl, errors: hl, constants: hl, signing: hl, addr: hl,
  verify: { parseAgentKey: hl.parseAgentKey, mainnetRecheck: hl.mainnetRecheck },
};

/** One world (DB, double, testnet stack, scoped journal, Gardens); pass `from` to reopen the same DB and double. */
async function world({ from = null } = {}) {
  const h = {};
  h.dir = from?.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bean-integ-'));
  if (from) h.db = from.db;
  else {
    h.db = openDb({ file: path.join(h.dir, 'bean.db') });
    migrate(h.db, MIGRATIONS_DIR, { backupDir: path.join(h.dir, 'backups') });
  }
  h.clock = from?.clock ?? new ManualClock(T0);
  h.double = from?.double ?? makeTestnetDouble({ now: h.clock.now });
  h.engine = from?.engine ?? fakeEngine();
  h.testnet = hl.createTestnet({
    fetch: h.double.fetch, now: h.clock.now, sleep: h.clock.sleep, log: quiet, mainnetClient: h.double.mainnetInfo,
    coins: Object.keys(MAINNET), timers: { setTimeout: () => null, clearTimeout() {} },
  });
  await h.testnet.market.refreshMeta();
  await h.testnet.market.pollMids();
  h.journal = new Journal({ scoped: true, globalKinds: GLOBAL_KINDS, keep: 5000, log: quiet });
  h.events = [];
  h.journal.subscribe((r) => h.events.push(r));
  h.masterKey = from?.masterKey ?? crypto.randomBytes(32);
  h.credentials = new Credentials({
    db: h.db, secrets: new Secrets({ masterKey: h.masterKey }), makeSigner: hl.makeSigner, wipeCredentials, now: h.clock.now, log: quiet,
  });
  h.gardens = new Gardens({
    engine: h.engine, journal: h.journal, db: h.db, testnet: h.testnet, lib: LIB, credentials: h.credentials,
    now: h.clock.now, log: quiet, mainnetInfo: h.double.mainnetInfo,
  });
  await h.gardens.init();
  h.tick = 0;
  h.drive = async (promiseOrValue, ms = 5000) => {
    const p = Promise.resolve(promiseOrValue);
    p.catch(() => {});
    await h.clock.run(ms);
    return p;
  };
  h.bar = async (ms = 3000) => {
    await h.testnet.market.pollMids();
    h.gardens.afterTick({ tick: ++h.tick });
    await h.clock.run(ms);
  };
  h.of = (uid, kind) => h.events.filter((r) => recordUid(r) === uid && (!kind || r.kind === kind));
  h.close = async ({ keepDb = false } = {}) => {
    await h.gardens.shutdown({ drainMs: 0 });
    if (!keepDb) {
      h.db.close();
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  };
  return h;
}

function addUser(db, name, now) {
  const r = db.prepare('INSERT INTO users (username, pw_hash, created_ms, updated_ms, pw_changed_ms) VALUES (?, ?, ?, ?, ?)')
    .run(name, 'scrypt$test', now, now, now);
  return Number(r.lastInsertRowid);
}

/** A double account + agent made by the dev script (what the dev panel does), connected through Gardens. */
async function connectViaScript(h, uid, args = {}) {
  const acct = h.double.script('new_account', { usd: 2000, ...args });
  const res = await h.drive(h.gardens.testnetConnect(uid, { account_address: acct.account_address, agent_key: acct.agent_key }));
  return { acct, res };
}

describe('integration: exchange_sync attempts and last_error_code (WP3 ↔ WP5)', () => {
  let h;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it('failed tries count up, bot_sync carries the count, and the BotRow keeps the error code across a restart', async () => {
    h = await world();
    h.engine.setBean(1, { coin: 'ETH', side: 1, units: 0.4, entry_px: 2490, leverage: 3, position_size: 0.5 });
    const uid = addUser(h.db, 'nok', h.clock.now());
    await connectViaScript(h, uid);
    const g = h.gardens.get(uid);
    // Every opening IOC fails for a while: the first try and the next bar's retry.
    h.double.script('error', { code: 'ioc_no_match', type: 'order', times: 2 });
    const row = await h.drive(g.create({ bean: 1, capital_usd: 200, venue: 'testnet', confirm: 'testnet' }), 10_000);
    let bot = g.rowOf(row.id);
    assert.equal(bot.exchange_sync?.state, 'failed');
    assert.equal(bot.exchange_sync.code, 'ioc_no_match');
    assert.equal(bot.exchange_sync.attempts, 1, 'the first failure is attempt 1');
    assert.equal(bot.last_error_code, 'ioc_no_match', 'the BotRow carries the machine code of last_error');
    await h.bar();
    bot = g.rowOf(row.id);
    assert.equal(bot.exchange_sync?.attempts, 2, 'the retry that failed again is attempt 2');
    const fails = h.of(uid, 'bot_sync').filter((r) => r.state === 'failed').map((r) => r.attempts);
    assert.deepEqual(fails, [1, 2], 'bot_sync carries the count (the client plays one dust puff per failed attempt)');

    // A restart (same DB, same double): the code survives in the bot's persisted data.
    await h.gardens.flush?.();
    await h.gardens.shutdown({ drainMs: 0 });
    h = await world({ from: h });
    const reloaded = h.gardens.get(uid).rowOf(row.id);
    assert.equal(reloaded.last_error_code, 'ioc_no_match');
    // The fault is used up: the next bar fills, the sync clears and the error (and its code) go away.
    await h.bar();
    const ok = h.gardens.get(uid).rowOf(row.id);
    assert.equal(ok.exchange_sync, null);
    assert.equal(ok.fill_state, 'in_sync');
    assert.equal(ok.last_error, null);
    assert.equal(ok.last_error_code, null);
  });
});

describe('integration: the double dev faults drive the fail-closed mainnet guard (WP2 double ↔ WP3 connect)', () => {
  let h;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it('mainnet_role → 422 mainnet_key; mainnet_down → 503 mainnet_check_unavailable; clear → connects; nothing stored before', async () => {
    h = await world();
    const uid = addUser(h.db, 'mai', h.clock.now());
    const acct = h.double.script('new_account', { usd: 1500 });
    const hit = h.double.script('mainnet_role', { role: 'agent' });
    assert.equal(hit.address, acct.agent_address.toLowerCase(), 'defaults to the newest agent of the first account');
    const params = { account_address: acct.account_address, agent_key: acct.agent_key };
    const refused = await h.drive(h.gardens.testnetConnect(uid, params).then(() => null, (e) => e));
    assert.ok(refused instanceof ApiError, String(refused));
    assert.equal(refused.status, 422);
    assert.equal(refused.code, 'mainnet_key');
    assert.equal(refused.extra?.sub_reason ?? refused.sub_reason, 'mainnet_agent');
    assert.equal(h.credentials.link(uid), null, 'nothing stored on a mainnet hit');

    // the mainnet userRole client serves at most 2 connects a minute (§6.8): let a minute pass between tries
    h.clock.ms += 61_000;
    h.double.script('mainnet_role', { role: 'missing' });
    h.double.script('mainnet_down', {});
    const down = await h.drive(h.gardens.testnetConnect(uid, params).then(() => null, (e) => e), 60_000);
    assert.ok(down instanceof ApiError, String(down));
    assert.equal(down.status, 503);
    assert.equal(down.code, 'mainnet_check_unavailable');
    assert.equal(h.credentials.link(uid), null, 'fail-closed: nothing stored when mainnet cannot answer');

    h.clock.ms += 61_000;
    h.double.script('clear', {});
    const ok = await h.drive(h.gardens.testnetConnect(uid, params));
    assert.equal(ok.testnet.status, 'verified');

    // admin_status.mainnet: a verified credential is re-checked every 24 h (§6.7)
    assert.equal(h.gardens.stats().mainnet.rechecks_due, 0);
    h.clock.ms += 25 * 3600_000;
    assert.equal(h.gardens.stats().mainnet.rechecks_due, 1);
  });

  it('the dev fault list is closed: the new names refuse bad input with a 400, never a 500', () => {
    const dbl = makeTestnetDouble();
    assert.ok(DEV_FAULTS.includes('mainnet_role') && DEV_FAULTS.includes('mainnet_down'));
    assert.throws(() => dbl.script('mainnet_role', {}), (e) => e.status === 400 && e.code === 'bad_request', 'no account yet');
    dbl.script('new_account', {});
    assert.throws(() => dbl.script('mainnet_role', { role: 'admin' }), (e) => e.status === 400);
    assert.throws(() => dbl.script('mainnet_role', { address: 'nope' }), (e) => e.status === 400);
    assert.deepEqual(dbl.script('mainnet_down', { mode: 'timeout' }), { ok: true });
    assert.equal(dbl.mainnet.fault, 'timeout');
    dbl.script('clear', {});
    assert.equal(dbl.mainnet.fault, null, 'clear also restores the mainnet answer');
  });

  it('idBase: a restarted double (the --testnet-double dev server) never reuses an oid or a tid', () => {
    const a = makeTestnetDouble();
    assert.equal(a.nextOid, 1_000_000, 'tests keep the old ids');
    const base = T0;
    const b = makeTestnetDouble({ idBase: base });
    assert.equal(b.nextOid, 1_000_000 + base);
    assert.equal(b.nextTid, 5_000_000 + base);
    assert.equal(makeTestnetDouble({ idBase: -1 }).nextOid, 1_000_000, 'a bad base is ignored');
    const main = fs.readFileSync(new URL('../server/main.js', import.meta.url), 'utf8');
    assert.match(main, /makeTestnetDouble\(\{ idBase: Date\.now\(\) \}\)/, 'the dev server seeds the ids from the boot time');
  });
});

describe('integration: the client reads last_error_code (WP4 payload ↔ WP5 inspector)', () => {
  it('venueFields maps it and botErrorInfo localizes it with no live_error event (after a reload)', async () => {
    const mem = new Map();
    globalThis.localStorage ??= { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
    const V = await import('../web/js/game/core/view.js');
    const IN = await import('../web/js/game/ui/inspector.js');
    const I = await import('../web/js/i18n.js');
    const row = { venue: 'paper', last_error: 'notional cap: $5,100.00 would exceed $5000', last_error_code: 'caps', last_error_vars: null };
    const vf = V.venueFields(row);
    assert.equal(vf.errorCode, 'caps');
    assert.equal(vf.errorVars, null);
    assert.equal(V.venueFields({ venue: 'paper' }).errorCode, null, 'none mode rows have no code');
    I.setLang('en');
    const info = IN.botErrorInfo({ venue: 'paper', coin: 'BTC', error: row.last_error, ...vf }, { accounts: true });
    assert.notEqual(info.text, I.STRINGS.en['g.err.unknown'], 'localized by the row code, not the generic line');
    assert.equal(info.detail, row.last_error);
    // the newest live_error with the same text still wins (it may carry vars)
    const ev = IN.botErrorInfo({ venue: 'paper', coin: 'BTC', error: row.last_error, ...vf }, { accounts: true, lastEvent: { code: 'caps', error: row.last_error } });
    assert.equal(ev.text, info.text);
  });
});

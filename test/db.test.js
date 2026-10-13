// test/db.test.js — WP1 database layer (PLATFORM.md §3, §10.5, §11.2 db): connection PRAGMAs, migrations
// (from empty, no-op re-run, checksum refusal, pre-migration backup, rollback on error, gaps), cascades,
// secure_delete, AUTOINCREMENT, partial credential indexes, batched retention, online backups, and the SQL binding
// scan of server/**. Offline; every DB lives in a fresh temp directory.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { openDb, dbFileFor, MIGRATIONS_DIR } from '../server/db/db.js';
import { migrate, MigrationError, listMigrations, migrationChecksum } from '../server/db/migrate.js';
import { Retention } from '../server/db/retention.js';
import { backupDb, Backups } from '../server/db/backup.js';
import { Users } from '../server/auth/users.js';
import { PasswordHasher } from '../server/auth/passwords.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAST = { N: 1024, r: 8, p: 1 }; // test-only scrypt cost; production parameters are asserted in auth.test.js
const PW = 'plenty-long-passphrase';

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bean-db-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A migrated DB in a fresh dir. */
function freshDb() {
  const dir = tmpDir();
  const db = openDb({ file: path.join(dir, 'bean.db') });
  migrate(db, MIGRATIONS_DIR);
  return { db, dir };
}

async function makeUsers(db) {
  const hasher = await new PasswordHasher({ params: FAST }).init();
  return new Users(db, { hasher });
}

/** Insert a garden's worth of child rows for `uid`. */
function seedChildren(db, uid, { botState = 'closed', botId = 'bot-0001', coin = 'BTC', bean = 1 } = {}) {
  const t = Date.now();
  db.prepare(`INSERT INTO bots (user_id, id, idx, venue, bean, coin, capital_usd, leverage, state, created_ms, updated_ms, data_json)
    VALUES (?, ?, ?, 'paper', ?, ?, 100, 1, ?, ?, ?, '{}')`).run(uid, botId, Number(botId.slice(4)), bean, coin, botState, t, t);
  const order = db.prepare(`INSERT INTO orders (user_id, bot_id, venue, kind, coin, sz, px, status, time_ms)
    VALUES (?, ?, 'paper', 'mirror', ?, 1, 100, 'filled', ?)`).run(uid, botId, coin, t);
  db.prepare(`INSERT INTO fills (user_id, bot_id, venue, coin, dir, side, sz, px, fee, closed_pnl, time_ms, order_id)
    VALUES (?, ?, 'paper', ?, 'Open Long', 'B', 1, 100, 0.01, 0, ?, ?)`).run(uid, botId, coin, t, order.lastInsertRowid);
  return Number(order.lastInsertRowid);
}

// ---------------------------------------------------------------------------------------------

describe('connection settings (§3.2)', () => {
  test('WAL, synchronous NORMAL, foreign keys, busy timeout, secure_delete, temp_store MEMORY, autocheckpoint', () => {
    const { db } = freshDb();
    const p = (name) => Object.values(db.prepare(`PRAGMA ${name}`).get())[0]; // sql-scan: test file, constant names
    assert.equal(p('journal_mode'), 'wal');
    assert.equal(p('synchronous'), 1, 'NORMAL');
    assert.equal(p('foreign_keys'), 1);
    assert.equal(p('busy_timeout'), 5000);
    assert.equal(p('secure_delete'), 1);
    assert.equal(p('temp_store'), 2, 'MEMORY');
    assert.equal(p('wal_autocheckpoint'), 1000);
    db.close();
  });

  test('one DB per feed: bean.db (real) and bean-sim.db (sim)', () => {
    assert.equal(path.basename(dbFileFor('/data', 'hyperliquid')), 'bean.db');
    assert.equal(path.basename(dbFileFor('/data', 'sim')), 'bean-sim.db');
  });

  test('tx() commits, rolls back on throw, nests as savepoints and refuses async callbacks', () => {
    const { db } = freshDb();
    const put = (k) => db.prepare("INSERT INTO admin_state (key, value_json, updated_ms) VALUES (?, '1', 0)").run(k);
    const has = (k) => Boolean(db.prepare('SELECT 1 AS ok FROM admin_state WHERE key = ?').get(k));
    db.tx(() => put('a'));
    assert.ok(has('a'));
    assert.throws(() => db.tx(() => {
      put('b');
      throw new Error('boom');
    }), /boom/);
    assert.ok(!has('b'), 'rolled back');
    // A failing inner savepoint (one garden) does not roll back the outer transaction (other gardens).
    db.tx(() => {
      put('c');
      assert.throws(() => db.savepoint(() => {
        put('d');
        throw new Error('bad row');
      }));
      put('e');
    });
    assert.deepEqual(['c', 'd', 'e'].map(has), [true, false, true]);
    assert.throws(() => db.tx(async () => put('f')), /synchronous/);
    assert.ok(!has('f'));
    assert.ok(!db.inTransaction);
    db.close();
  });
});

describe('migrations (§3.4)', () => {
  test('from empty: every §3.3 table exists, all STRICT; recorded with checksum; user_version set', () => {
    const dir = tmpDir();
    const db = openDb({ file: path.join(dir, 'bean.db') });
    const r = migrate(db, MIGRATIONS_DIR);
    assert.deepEqual([r.from, r.to, r.backup], [0, 1, null], 'a new DB needs no pre-migration backup');
    const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const names = tables.map((t) => t.name);
    for (const want of ['schema_migrations', 'users', 'retired_usernames', 'sessions', 'credentials', 'gardens', 'bots', 'orders',
      'fills', 'events', 'audit_log', 'admin_state', 'invites']) {
      assert.ok(names.includes(want), `table ${want}`);
    }
    for (const t of tables) assert.match(t.sql, /\)\s*STRICT\s*$/, `${t.name} is STRICT`);
    const row = db.prepare('SELECT version, name, checksum FROM schema_migrations').get();
    const file = listMigrations(MIGRATIONS_DIR)[0];
    assert.deepEqual({ ...row }, { version: 1, name: '0001_init.sql', checksum: file.checksum });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    db.close();
  });

  test('re-running is a no-op', () => {
    const { db } = freshDb();
    assert.deepEqual(migrate(db, MIGRATIONS_DIR), { from: 1, to: 1, backup: null });
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 1);
    db.close();
  });

  test('checksums ignore CRLF vs LF (a Windows checkout hashes like the Linux image)', () => {
    assert.equal(migrationChecksum('a\r\nb\r\n'), migrationChecksum('a\nb\n'));
    assert.notEqual(migrationChecksum('a\nb\n'), migrationChecksum('a\nc\n'));
  });

  test('an edited migration refuses to start (MigrationError, exit code 3)', () => {
    const dir = tmpDir();
    const mdir = path.join(dir, 'migrations');
    fs.mkdirSync(mdir);
    fs.copyFileSync(path.join(MIGRATIONS_DIR, '0001_init.sql'), path.join(mdir, '0001_init.sql'));
    const db = openDb({ file: path.join(dir, 'bean.db') });
    migrate(db, mdir);
    fs.appendFileSync(path.join(mdir, '0001_init.sql'), '\n-- edited after release\n');
    assert.throws(() => migrate(db, mdir), (err) => err instanceof MigrationError && err.exitCode === 3 && /checksum mismatch/.test(err.message));
    db.close();
  });

  test('a pending migration on a non-empty DB takes a VACUUM INTO pre-migration backup first', () => {
    const dir = tmpDir();
    const mdir = path.join(dir, 'migrations');
    fs.mkdirSync(mdir);
    fs.copyFileSync(path.join(MIGRATIONS_DIR, '0001_init.sql'), path.join(mdir, '0001_init.sql'));
    const db = openDb({ file: path.join(dir, 'bean.db') });
    migrate(db, mdir);
    db.prepare("INSERT INTO admin_state (key, value_json, updated_ms) VALUES ('marker', '\"before\"', 1)").run();
    fs.writeFileSync(path.join(mdir, '0002_extra.sql'), 'CREATE TABLE extra (id INTEGER PRIMARY KEY) STRICT;\n');
    const backupDir = path.join(dir, 'backups');
    const r = migrate(db, mdir, { backupDir, now: () => Date.UTC(2026, 9, 11, 14, 32) });
    assert.deepEqual([r.from, r.to], [1, 2]);
    assert.equal(path.basename(r.backup), 'pre-migration-1-2-20261011T1432Z.db');
    const copy = new DatabaseSync(r.backup, { readOnly: true });
    assert.equal(copy.prepare("SELECT value_json FROM admin_state WHERE key = 'marker'").get().value_json, '"before"');
    assert.equal(copy.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'extra'").get().n, 0, 'taken before 0002');
    copy.close();
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    db.close();
  });

  test('a failing migration rolls back completely and throws MigrationError', () => {
    const dir = tmpDir();
    const mdir = path.join(dir, 'migrations');
    fs.mkdirSync(mdir);
    fs.copyFileSync(path.join(MIGRATIONS_DIR, '0001_init.sql'), path.join(mdir, '0001_init.sql'));
    fs.writeFileSync(path.join(mdir, '0002_broken.sql'), 'CREATE TABLE half (id INTEGER PRIMARY KEY) STRICT;\nTHIS IS NOT SQL;\n');
    const db = openDb({ file: path.join(dir, 'bean.db') });
    assert.throws(() => migrate(db, mdir), (err) => err instanceof MigrationError && err.exitCode === 3 && /0002_broken\.sql/.test(err.message));
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'half'").get().n, 0, 'no partial table');
    assert.deepEqual(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version), [1]);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    db.close();
  });

  test('versions must run 1, 2, 3… without gaps; bad names refuse', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(dir, '0003_c.sql'), 'SELECT 1;');
    assert.throws(() => listMigrations(dir), (err) => err instanceof MigrationError && /without gaps/.test(err.message));
    fs.rmSync(path.join(dir, '0003_c.sql'));
    fs.writeFileSync(path.join(dir, '2_bad.sql'), 'SELECT 1;');
    assert.throws(() => listMigrations(dir), /bad migration file name/);
  });
});

describe('integrity rules (§3.3)', () => {
  test('deleting a user cascades to sessions, credentials, garden, bots, orders, fills and events; audit rows survive', async () => {
    const { db } = freshDb();
    const users = await makeUsers(db);
    const u = await users.create({ username: 'cascade_me', password: PW });
    seedChildren(db, u.id);
    const t = Date.now();
    db.prepare(`INSERT INTO sessions (public_id, user_id, token_hash, created_ms, rotated_ms, last_seen_ms, expires_ms)
      VALUES (?, ?, randomblob(32), ?, ?, ?, ?)`).run('A'.repeat(22), u.id, t, t, t, t + 1000);
    db.prepare(`INSERT INTO credentials (user_id, venue, account_address, agent_address, key_ct, key_iv, key_tag, key_id, status, created_ms, updated_ms)
      VALUES (?, 'hl_testnet', ?, ?, randomblob(32), randomblob(12), randomblob(16), 'abcdef0123456789', 'verified', ?, ?)`)
      .run(u.id, `0x${'1'.repeat(40)}`, `0x${'2'.repeat(40)}`, t, t);
    db.prepare("INSERT INTO events (seq, user_id, t, kind, data_json) VALUES (1, ?, ?, 'bot_fill', '{}')").run(u.id, t);
    db.prepare("INSERT INTO audit_log (at_ms, user_id, actor, action, ok) VALUES (?, ?, 'user', 'signup', 1)").run(t, u.id);
    assert.ok(users.remove(u.id));
    for (const table of ['users', 'sessions', 'credentials', 'gardens', 'bots', 'orders', 'fills', 'events']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${table} emptied`); // sql-scan: test, constant names
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_log WHERE user_id = ?').get(u.id).n, 1, 'audit keeps the uid');
    assert.ok(users.isRetired('cascade_me'), 'the name is retired in the same transaction');
    assert.equal(users.remove(u.id), false, 'idempotent');
    db.close();
  });

  test('secure_delete + checkpoint: a deleted row\'s text is gone from the DB file and the WAL', async () => {
    const { db, dir } = freshDb();
    const users = await makeUsers(db);
    const u = await users.create({ username: 'erase_me', password: PW });
    const marker = `MARKER-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db.prepare('UPDATE gardens SET last_error = ? WHERE user_id = ?').run(marker, u.id);
    db.checkpoint();
    assert.ok(fs.readFileSync(path.join(dir, 'bean.db')).includes(marker), 'precondition: the marker is on disk');
    users.remove(u.id); // ends with wal_checkpoint(TRUNCATE)
    const main = fs.readFileSync(path.join(dir, 'bean.db'));
    const wal = fs.existsSync(path.join(dir, 'bean.db-wal')) ? fs.readFileSync(path.join(dir, 'bean.db-wal')) : Buffer.alloc(0);
    assert.ok(!main.includes(marker), 'secure_delete zeroed the freed page');
    assert.ok(!wal.includes(marker), 'the WAL was checkpointed and truncated');
    db.close();
  });

  test('AUTOINCREMENT: deleting the newest user never hands its uid to the next sign-up; order ids never repeat', async () => {
    const { db } = freshDb();
    const users = await makeUsers(db);
    await users.create({ username: 'first_one', password: PW });
    const newest = await users.create({ username: 'newest_one', password: PW });
    const orderId = seedChildren(db, newest.id);
    users.remove(newest.id);
    const next = await users.create({ username: 'next_one', password: PW });
    assert.ok(next.id > newest.id, `uid ${next.id} must exceed the deleted ${newest.id}`);
    const nextOrder = seedChildren(db, next.id);
    assert.ok(nextOrder > orderId, 'orders.id continues past the deleted maximum');
    db.close();
  });

  test('partial UNIQUE credential indexes: one live agent/account per garden; revoked or error rows never block', async () => {
    const { db } = freshDb();
    const users = await makeUsers(db);
    const a = await users.create({ username: 'cred_a', password: PW });
    const b = await users.create({ username: 'cred_b', password: PW });
    const agent = `0x${'a'.repeat(40)}`;
    const account = `0x${'b'.repeat(40)}`;
    const insert = (uid, status) => db.prepare(`INSERT INTO credentials (user_id, venue, account_address, agent_address,
      key_ct, key_iv, key_tag, key_id, status, created_ms, updated_ms)
      VALUES (?, 'hl_testnet', ?, ?, zeroblob(32), zeroblob(12), zeroblob(16), '0123456789abcdef', ?, 1, 1)`).run(uid, account, agent, status);
    insert(a.id, 'verified');
    assert.throws(() => insert(b.id, 'pending'), /UNIQUE constraint failed/);
    db.prepare("UPDATE credentials SET status = 'revoked' WHERE user_id = ?").run(a.id);
    insert(b.id, 'verified'); // the revoked row of A no longer blocks
    db.prepare("UPDATE credentials SET status = 'error' WHERE user_id = ?").run(b.id);
    db.prepare('DELETE FROM credentials WHERE user_id = ?').run(a.id);
    insert(a.id, 'pending');
    assert.equal(db.prepare("SELECT count(*) AS n FROM credentials WHERE status IN ('pending','verified')").get().n, 1);
    // Address CHECKs: lower-case 0x + 40 hex only.
    assert.throws(() => db.prepare(`INSERT INTO credentials (user_id, venue, account_address, agent_address, key_ct, key_iv, key_tag,
      key_id, status, created_ms, updated_ms) VALUES (?, 'hl_testnet', ?, ?, zeroblob(32), zeroblob(12), zeroblob(16), '0123456789abcdef',
      'revoked', 1, 1)`).run(b.id, `0x${'B'.repeat(40)}`, agent), /CHECK constraint failed/);
    db.close();
  });

  test('one open bot per coin and per bean per garden; fills.dir is raw text ≤ 64 chars', async () => {
    const { db } = freshDb();
    const users = await makeUsers(db);
    const u = await users.create({ username: 'bots_rule', password: PW });
    seedChildren(db, u.id, { botState: 'active', botId: 'bot-0001', coin: 'BTC', bean: 7 });
    assert.throws(() => seedChildren(db, u.id, { botState: 'active', botId: 'bot-0002', coin: 'BTC', bean: 8 }), /UNIQUE/);
    assert.throws(() => seedChildren(db, u.id, { botState: 'active', botId: 'bot-0003', coin: 'ETH', bean: 7 }), /UNIQUE/);
    seedChildren(db, u.id, { botState: 'closed', botId: 'bot-0004', coin: 'BTC', bean: 7 }); // closed rows never block
    db.prepare(`INSERT INTO fills (user_id, bot_id, venue, coin, dir, side, sz, px, fee, closed_pnl, time_ms)
      VALUES (?, 'bot-0001', 'testnet', 'BTC', 'Auto-Deleveraging', 'A', 1, 1, 0, 0, 1)`).run(u.id);
    db.close();
  });
});

describe('retention (§3.4)', () => {
  test('events, fills and orders are trimmed per user in ≤ 1,000-row slices; open bots keep every row', async () => {
    const { db } = freshDb();
    const users = await makeUsers(db);
    const u = await users.create({ username: 'trim_me', password: PW });
    const t = Date.now();
    db.tx(() => {
      for (let i = 1; i <= 2600; i += 1) {
        db.prepare("INSERT INTO events (seq, user_id, t, kind, data_json) VALUES (?, ?, ?, 'bot_fill', '{}')").run(i, u.id, t);
      }
      db.prepare(`INSERT INTO bots (user_id, id, idx, venue, bean, coin, capital_usd, leverage, state, created_ms, updated_ms, data_json)
        VALUES (?, 'bot-0001', 1, 'paper', 1, 'BTC', 100, 1, 'closed', 1, 1, '{}'), (?, 'bot-0002', 2, 'paper', 2, 'ETH', 100, 1, 'active', 1, 1, '{}')`)
        .run(u.id, u.id);
      // 30 rows of the OPEN bot first (oldest), then 2,500 of the closed one.
      for (let i = 0; i < 2530; i += 1) {
        const bot = i < 30 ? 'bot-0002' : 'bot-0001';
        db.prepare(`INSERT INTO orders (user_id, bot_id, venue, kind, coin, sz, px, status, time_ms)
          VALUES (?, ?, 'paper', 'mirror', 'BTC', 1, 1, 'filled', ?)`).run(u.id, bot, t);
        db.prepare(`INSERT INTO fills (user_id, bot_id, venue, coin, dir, side, sz, px, fee, closed_pnl, time_ms)
          VALUES (?, ?, 'paper', 'BTC', 'Open Long', 'B', 1, 1, 0, 0, ?)`).run(u.id, bot, t);
      }
    });
    const retention = new Retention({ db, limits: { eventsPerUser: 100, rowsPerUser: 200 } });
    let yielded = 0;
    const spin = () => {
      yielded += 1;
      if (retention.running) setImmediate(spin);
    };
    const pass = retention.runOnce();
    setImmediate(spin);
    const counts = await pass;
    assert.ok(retention.maxBatchSeen <= 1000 && retention.maxBatchSeen > 0, `largest single DELETE ${retention.maxBatchSeen}`);
    assert.ok(yielded >= 3, `the pass yielded to the event loop between slices (${yielded})`);
    assert.equal(counts.events, 2500);
    const ev = db.prepare('SELECT min(seq) AS lo, max(seq) AS hi, count(*) AS n FROM events WHERE user_id = ?').get(u.id);
    assert.deepEqual({ ...ev }, { lo: 2501, hi: 2600, n: 100 }, 'the newest 100 kept');
    const openFills = db.prepare("SELECT count(*) AS n FROM fills WHERE bot_id = 'bot-0002'").get().n;
    const openOrders = db.prepare("SELECT count(*) AS n FROM orders WHERE bot_id = 'bot-0002'").get().n;
    assert.deepEqual([openFills, openOrders], [30, 30], 'rows of an open bot are never deleted');
    assert.equal(db.prepare("SELECT count(*) AS n FROM fills WHERE bot_id = 'bot-0001'").get().n, 200);
    assert.equal(db.prepare("SELECT count(*) AS n FROM orders WHERE bot_id = 'bot-0001'").get().n, 200);
    db.close();
  });

  test('sessions expired or revoked > 30 days and audit rows > 180 days are deleted', async () => {
    const { db } = freshDb();
    const users = await makeUsers(db);
    const u = await users.create({ username: 'old_rows', password: PW });
    const now = Date.UTC(2026, 9, 11);
    const day = 86_400_000;
    const sess = (pid, expires, revoked) => db.prepare(`INSERT INTO sessions (public_id, user_id, token_hash, created_ms, rotated_ms,
      last_seen_ms, expires_ms, revoked_ms) VALUES (?, ?, randomblob(32), 0, 0, 0, ?, ?)`).run(pid.padEnd(22, 'x'), u.id, expires, revoked);
    sess('expired_long_ago', now - 31 * day, null);
    sess('expired_recently', now - 29 * day, null);
    sess('revoked_long_ago', now + 10 * day, now - 31 * day);
    sess('revoked_recently', now + 10 * day, now - 1 * day);
    sess('live', now + 10 * day, null);
    for (const [age, n] of [[181, 1500], [10, 3]]) {
      for (let i = 0; i < n; i += 1) {
        db.prepare("INSERT INTO audit_log (at_ms, user_id, actor, action, ok) VALUES (?, ?, 'user', 'login_ok', 1)").run(now - age * day, u.id);
      }
    }
    const counts = await new Retention({ db, now: () => now }).runOnce();
    assert.equal(counts.sessions, 2);
    assert.deepEqual(db.prepare('SELECT public_id FROM sessions ORDER BY public_id').all().map((r) => r.public_id.replace(/x+$/, '')),
      ['expired_recently', 'live', 'revoked_recently']);
    assert.equal(counts.audit, 1500);
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_log').get().n, 3);
    db.close();
  });
});

describe('backups (§10.5)', () => {
  test('backupDb: an online, page-stepped copy that opens as a valid database', async () => {
    const { db, dir } = freshDb();
    db.prepare("INSERT INTO admin_state (key, value_json, updated_ms) VALUES ('k', '\"v\"', 1)").run();
    const file = path.join(dir, 'backups', 'one.db');
    const r = await backupDb(db, file, { rate: 4 });
    assert.ok(r.bytes > 0 && r.pages > 0);
    assert.ok(!fs.existsSync(`${file}.partial`), 'no partial file left behind');
    const copy = new DatabaseSync(file, { readOnly: true });
    assert.equal(copy.prepare("SELECT value_json FROM admin_state WHERE key = 'k'").get().value_json, '"v"');
    assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 1);
    copy.close();
    db.close();
  });

  test('Backups: named bean-<UTC>.db with the state JSON beside it, newest BACKUP_KEEP kept, manual ≤ 1 / 10 min', async () => {
    const { db, dir } = freshDb();
    const stateFile = path.join(dir, 'state-real.json');
    fs.writeFileSync(stateFile, '{"v":1}');
    let now = Date.UTC(2026, 9, 11, 8, 0);
    const backups = new Backups({ db, dir: path.join(dir, 'backups'), stateFile, keep: 2, now: () => now });
    const first = await backups.runNow({ manual: true });
    assert.equal(first.file, 'bean-20261011T0800Z.db');
    assert.ok(fs.existsSync(path.join(dir, 'backups', 'bean-20261011T0800Z.state.json')));
    await assert.rejects(backups.runNow({ manual: true }), (err) => err.status === 429 && err.code === 'rate_limited' && err.extra.retry_after_s === 600);
    now += 11 * 60_000;
    await backups.runNow({ manual: true });
    now += 60 * 60_000;
    await backups.runNow(); // scheduled backups are not rate-limited
    const files = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('.db')).sort();
    assert.deepEqual(files, ['bean-20261011T0811Z.db', 'bean-20261011T0911Z.db'], 'pruned to the newest 2');
    assert.equal(backups.last().last_backup_file, 'bean-20261011T0911Z.db');
    db.close();
  });
});

// ---------------------------------------------------------------------------------------------
// The SQL binding scan (§3.2): no prepare()/exec() argument may be built with `${…}` or `+`.

/** Source files under server/. */
function serverFiles(dir = path.join(ROOT, 'server')) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...serverFiles(p));
    else if (/\.(m?js)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/**
 * Scan the argument list that starts after `open` (index of '(') to its matching ')', skipping strings, template
 * literal text and comments. → {end, interp, plus}
 */
function scanArgs(src, open) {
  let depth = 0;
  let interp = false;
  let plus = false;
  const stack = []; // template nesting: 'tpl' while inside a template literal's text
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (top === 'tpl') {
      if (c === '\\') i += 1;
      else if (c === '`') stack.pop();
      else if (c === '$' && src[i + 1] === '{') {
        interp = true;
        stack.push('expr');
        i += 1;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i) + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      for (i += 1; i < src.length && src[i] !== c; i += 1) if (src[i] === '\\') i += 1;
      continue;
    }
    if (c === '`') {
      stack.push('tpl');
      continue;
    }
    if (top === 'expr' && c === '}') {
      stack.pop();
      continue;
    }
    if (c === '+') plus = true;
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return { end: i, interp, plus };
    }
  }
  return { end: src.length, interp, plus };
}

test('SQL binding scan: no prepare()/exec() argument in server/** is built with ${…} or + (one allowlisted line)', () => {
  const hits = [];
  let calls = 0;
  for (const file of serverFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const re = /\.(prepare|exec)\s*\(/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const before = src.slice(Math.max(0, m.index - 80), m.index);
      // RegExp#exec (a regex literal or a *_RE / *Re / regex / pattern receiver) is not SQL.
      if (m[1] === 'exec' && (/\/[gimsuyd]*\s*$/.test(before) || /(?:RE|Re|_re|regex|Regex|REGEX|pattern|Pattern|PATTERN)\s*$/.test(before))) continue;
      const open = m.index + m[0].length - 1;
      const { interp, plus } = scanArgs(src, open);
      calls += 1;
      if (!interp && !plus) continue;
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
      const lineNo = src.slice(0, m.index).split('\n').length;
      if (rel === 'server/db/migrate.js' && /PRAGMA user_version = \$\{mig\.version\}/.test(line)) continue; // the §3.2 exception
      hits.push(`${rel}:${lineNo}: ${line.trim()}`);
    }
  }
  assert.ok(calls >= 40, `the scan saw the DB calls (${calls})`);
  assert.deepEqual(hits, [], `SQL built from strings:\n${hits.join('\n')}`);
});

test('the scanner itself catches concatenation and interpolation (and ignores literal text)', () => {
  const probe = (code) => {
    const open = code.indexOf('(');
    const { interp, plus } = scanArgs(code, open);
    return interp || plus;
  };
  assert.equal(probe("db.prepare('SELECT * FROM t WHERE a = ' + x)"), true);
  assert.equal(probe('db.prepare(`SELECT ${col} FROM t`)'), true);
  assert.equal(probe('db.exec(`PRAGMA a = 1` + more)'), true);
  assert.equal(probe("db.prepare('SELECT a + 1 FROM t WHERE b = ?')"), false, '+ inside the SQL text is fine');
  assert.equal(probe('db.prepare(`SELECT 1\n  FROM t -- a ${x} looking comment? no: plain text`)'), true, 'any ${ in a template counts');
  assert.equal(probe('db.prepare(SQL.byId)'), false);
});

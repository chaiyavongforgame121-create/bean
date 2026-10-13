// test/secrets.test.js — T-SECRETS for WP1 (PLATFORM.md §5, §10.3, §11.2): AES-256-GCM sealing with row-bound AAD,
// tamper and wrong-key failures, the kid and HKDF derivations, P0/P1 master-key rotation, secret env vars deleted
// after reading, config errors that never echo values, the key absent from every DB text column and from the DB/WAL
// bytes, the log sanitizer (hex, base64, decimal, seed phrases), the sensitive-op 500 line, and the WAL checkpoint
// after every wipe. Offline; throwaway random keys only.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

import {
  Secrets, parseMasterKey, keyId, credentialAad, loadAuditSalt, wipeCredentials, sanitizeLogLine, makeSafeLogger, sensitiveErrorLine,
} from '../server/secrets.js';
import { parsePlatformConfig, readSecret, PlatformConfigError, SECRET_VARS } from '../server/config.js';
import { openDb, MIGRATIONS_DIR } from '../server/db/db.js';
import { migrate } from '../server/db/migrate.js';
import { Users } from '../server/auth/users.js';
import { PasswordHasher } from '../server/auth/passwords.js';

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bean-secrets-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const ACCOUNT = `0x${'ab'.repeat(20)}`;
const AGENT = `0x${'cd'.repeat(20)}`;
const newKey = () => new Uint8Array(crypto.randomBytes(32));
const hex = (bytes) => Buffer.from(bytes).toString('hex');

function freshDb() {
  const dir = tmpDir();
  const db = openDb({ file: path.join(dir, 'bean.db') });
  migrate(db, MIGRATIONS_DIR);
  return { db, dir };
}

/** Insert a user + a sealed credential row; returns {uid, key}. */
async function storeCredential(db, secrets, username = 'keyholder') {
  const hasher = await new PasswordHasher({ params: { N: 1024, r: 8, p: 1 } }).init();
  const users = new Users(db, { hasher });
  const user = await users.create({ username, password: 'long-enough-passphrase' });
  const key = newKey();
  const sealed = secrets.seal(user.id, ACCOUNT, AGENT, key);
  db.prepare(`INSERT INTO credentials (user_id, venue, account_address, agent_address, key_ct, key_iv, key_tag, key_id, enc_version,
    status, created_ms, updated_ms) VALUES (?, 'hl_testnet', ?, ?, ?, ?, ?, ?, ?, 'verified', 1, 1)`)
    .run(user.id, ACCOUNT, AGENT, sealed.key_ct, sealed.key_iv, sealed.key_tag, sealed.key_id, sealed.enc_version);
  return { uid: user.id, key, users };
}

const rowOf = (db, uid) => db.prepare('SELECT * FROM credentials WHERE user_id = ?').get(uid);

describe('sealing (§5.1)', () => {
  const master = crypto.randomBytes(32);
  const secrets = new Secrets({ masterKey: master });

  test('seal/open round trip; a fresh iv per seal; sizes match the schema', () => {
    const key = newKey();
    const a = secrets.seal(7, ACCOUNT, AGENT, key);
    const b = secrets.seal(7, ACCOUNT, AGENT, key);
    assert.deepEqual([a.key_ct.length, a.key_iv.length, a.key_tag.length, a.key_id.length, a.enc_version], [32, 12, 16, 16, 1]);
    assert.ok(!a.key_iv.equals(b.key_iv) && !a.key_ct.equals(b.key_ct), 'a new iv on every seal');
    const opened = secrets.open({ user_id: 7, account_address: ACCOUNT, agent_address: AGENT, ...a });
    assert.ok(opened instanceof Uint8Array && !(opened instanceof Buffer) ? true : opened instanceof Uint8Array);
    assert.equal(hex(opened), hex(key));
  });

  test('the AAD binds the ciphertext to its row: another user or address fails', () => {
    const sealed = secrets.seal(7, ACCOUNT, AGENT, newKey());
    const row = { user_id: 7, account_address: ACCOUNT, agent_address: AGENT, ...sealed };
    for (const moved of [{ user_id: 8 }, { account_address: `0x${'ef'.repeat(20)}` }, { agent_address: `0x${'01'.repeat(20)}` }]) {
      assert.throws(() => secrets.open({ ...row, ...moved }), (err) => err.code === 'key_unavailable', JSON.stringify(moved));
    }
    assert.equal(credentialAad(7, ACCOUNT, AGENT).toString(), `cred|v1|7|hl_testnet|${ACCOUNT}|${AGENT}`);
  });

  test('tampering with ciphertext, tag or iv fails', () => {
    const sealed = secrets.seal(7, ACCOUNT, AGENT, newKey());
    const row = { user_id: 7, account_address: ACCOUNT, agent_address: AGENT, ...sealed };
    for (const field of ['key_ct', 'key_tag', 'key_iv']) {
      const bad = Buffer.from(row[field]);
      bad[0] ^= 1;
      assert.throws(() => secrets.open({ ...row, [field]: bad }), /authentication/, field);
    }
  });

  test('the wrong master key fails (a DB copied off the server reveals nothing)', () => {
    const sealed = secrets.seal(7, ACCOUNT, AGENT, newKey());
    const row = { user_id: 7, account_address: ACCOUNT, agent_address: AGENT, ...sealed };
    const other = new Secrets({ masterKey: crypto.randomBytes(32) });
    assert.throws(() => other.open(row), (err) => err.code === 'key_unavailable');
    assert.throws(() => other.open({ ...row, key_id: other.kid }), /authentication/, 'same kid label, wrong key bytes');
    const noKey = new Secrets({ auditSalt: crypto.randomBytes(32) });
    assert.equal(noKey.canSeal, false);
    assert.throws(() => noKey.seal(1, ACCOUNT, AGENT, newKey()), /no master key/);
    assert.throws(() => noKey.open(row), (err) => err.code === 'key_unavailable');
  });

  test('kid and HKDF derivations are exactly §5.1 (an independent decrypt with the derived K_cred works)', () => {
    const want = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('bean-garden kid v1'), master])).digest('hex').slice(0, 16);
    assert.equal(keyId(master), want);
    assert.equal(secrets.kid, want);
    const kCred = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('bean-garden/v1'), Buffer.from('credentials/hl_testnet'), 32));
    const key = newKey();
    const s = secrets.seal(3, ACCOUNT, AGENT, key);
    const d = crypto.createDecipheriv('aes-256-gcm', kCred, s.key_iv);
    d.setAAD(credentialAad(3, ACCOUNT, AGENT));
    d.setAuthTag(s.key_tag);
    assert.equal(Buffer.concat([d.update(s.key_ct), d.final()]).toString('hex'), hex(key));
    const kName = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('bean-garden/v1'), Buffer.from('audit/name'), 32));
    assert.equal(secrets.hmacName('nok'), crypto.createHmac('sha256', kName).update('nok').digest('hex').slice(0, 16));
    const kIp = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('bean-garden/v1'), Buffer.from('audit/ip'), 32));
    assert.equal(secrets.hmacIp('203.0.113.0/24'), crypto.createHmac('sha256', kIp).update('203.0.113.0/24').digest('hex').slice(0, 16));
    const kDev = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('bean-garden/v1'), Buffer.from('auth/device'), 32));
    assert.ok(secrets.deviceKey.equals(kDev));
  });

  test('withKey zeroes the bytes after the callback (also when it throws); the object never shows key material', async () => {
    const sealed = secrets.seal(7, ACCOUNT, AGENT, newKey());
    const row = { user_id: 7, account_address: ACCOUNT, agent_address: AGENT, ...sealed };
    let seen = null;
    await secrets.withKey(row, (bytes) => {
      seen = bytes;
      assert.ok(bytes.some((b) => b !== 0));
    });
    assert.ok(seen.every((b) => b === 0), 'zeroed after use');
    await assert.rejects(secrets.withKey(row, (bytes) => {
      seen = bytes;
      throw new Error('signer failed');
    }), /signer failed/);
    assert.ok(seen.every((b) => b === 0), 'zeroed on throw');
    const shown = JSON.stringify(secrets) + util.inspect(secrets, { depth: 5 });
    assert.ok(!shown.includes(master.toString('base64')) && !shown.includes(master.toString('hex')));
    assert.ok(!shown.includes(secrets.deviceKey.toString('hex')), 'derived keys are not enumerable');
  });

  test('master keys: base64 or base64url of exactly 32 bytes; errors never contain the value', () => {
    const key = crypto.randomBytes(32);
    assert.ok(parseMasterKey(key.toString('base64')).equals(key));
    assert.ok(parseMasterKey(key.toString('base64url')).equals(key));
    assert.ok(parseMasterKey(`  ${key.toString('base64')}\n`).equals(key));
    for (const bad of [crypto.randomBytes(31).toString('base64'), crypto.randomBytes(33).toString('base64'), key.toString('hex'),
      `${key.toString('base64').slice(0, 20)}!!${key.toString('base64').slice(22)}`, '']) {
      assert.throws(() => parseMasterKey(bad), (err) => !bad || !err.message.includes(bad), 'no echo');
    }
  });
});

describe('rotation (§5.2)', () => {
  test('P0: rows sealed under a foreign kid are marked key_unavailable at boot', async () => {
    const { db } = freshDb();
    const oldSecrets = new Secrets({ masterKey: crypto.randomBytes(32) });
    const { uid } = await storeCredential(db, oldSecrets);
    const logs = [];
    const r = new Secrets({ masterKey: crypto.randomBytes(32) }).applyRotation(db, { log: (l) => logs.push(l) });
    assert.deepEqual(r, { resealed: 0, unavailable: 1 });
    const row = rowOf(db, uid);
    assert.deepEqual([row.status, row.status_reason], ['error', 'key_unavailable']);
    assert.ok(logs.every((l) => !/[0-9a-f]{64}/i.test(l)), 'counts only');
    db.close();
  });

  test('P1: with the old key supplied, rows are re-sealed under the new kid with fresh ivs, in one transaction', async () => {
    const { db } = freshDb();
    const oldMaster = crypto.randomBytes(32);
    const { uid, key } = await storeCredential(db, new Secrets({ masterKey: oldMaster }));
    const before = rowOf(db, uid);
    const next = new Secrets({ masterKey: crypto.randomBytes(32), oldKeys: [oldMaster] });
    const logs = [];
    assert.deepEqual(next.applyRotation(db, { log: (l) => logs.push(l) }), { resealed: 1, unavailable: 0 });
    const row = rowOf(db, uid);
    assert.equal(row.key_id, next.kid);
    assert.equal(row.status, 'verified');
    assert.ok(!Buffer.from(row.key_iv).equals(Buffer.from(before.key_iv)), 'a new iv');
    assert.equal(hex(next.open(row)), hex(key));
    assert.match(logs.join('\n'), /re-sealed 1 credential\(s\) under kid [0-9a-f]{16}/);
    assert.deepEqual(next.applyRotation(db), { resealed: 0, unavailable: 0 }, 'idempotent');
    db.close();
  });

  test('without a master key, rotation leaves rows untouched (testnet is off; the key may come back)', async () => {
    const { db } = freshDb();
    const { uid } = await storeCredential(db, new Secrets({ masterKey: crypto.randomBytes(32) }));
    assert.deepEqual(new Secrets({ auditSalt: crypto.randomBytes(32) }).applyRotation(db), { resealed: 0, unavailable: 0 });
    assert.equal(rowOf(db, uid).status, 'verified');
    db.close();
  });

  test('the audit salt is created once and reused (stable pseudonyms without a master key)', () => {
    const { db } = freshDb();
    const a = loadAuditSalt(db);
    const b = loadAuditSalt(db);
    assert.equal(a.length, 32);
    assert.ok(a.equals(b));
    const s1 = new Secrets({ auditSalt: a });
    const s2 = new Secrets({ auditSalt: b });
    assert.equal(s1.hmacIp('1.2.3.0/24'), s2.hmacIp('1.2.3.0/24'));
    db.close();
  });
});

describe('the key at rest and after a wipe (§5.3 rules 6 and 9)', () => {
  test('the key appears in no DB text column and not in the DB or WAL bytes', async () => {
    const { db, dir } = freshDb();
    const secrets = new Secrets({ masterKey: crypto.randomBytes(32) });
    const { key } = await storeCredential(db, secrets);
    const keyHex = hex(key);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    for (const table of tables) {
      for (const row of db.prepare(`SELECT * FROM ${table}`).all()) { // sql-scan: test, table names from sqlite_schema
        for (const [col, value] of Object.entries(row)) {
          if (typeof value === 'string') assert.ok(!value.toLowerCase().includes(keyHex), `${table}.${col}`);
          if (value instanceof Uint8Array) assert.ok(!Buffer.from(value).equals(Buffer.from(key)), `${table}.${col} raw`);
        }
      }
    }
    db.checkpoint();
    const bytes = Buffer.concat([fs.readFileSync(path.join(dir, 'bean.db')),
      fs.existsSync(path.join(dir, 'bean.db-wal')) ? fs.readFileSync(path.join(dir, 'bean.db-wal')) : Buffer.alloc(0)]);
    assert.ok(!bytes.includes(Buffer.from(key)), 'raw key bytes absent');
    assert.ok(!bytes.includes(Buffer.from(keyHex)), 'hex key absent');
    db.close();
  });

  test('wipeCredentials overwrites, deletes and checkpoints: the ciphertext leaves both files at once', async () => {
    const { db, dir } = freshDb();
    const secrets = new Secrets({ masterKey: crypto.randomBytes(32) });
    const { uid } = await storeCredential(db, secrets);
    const ct = Buffer.from(rowOf(db, uid).key_ct);
    db.checkpoint();
    assert.ok(fs.readFileSync(path.join(dir, 'bean.db')).includes(ct), 'precondition: the ciphertext is on disk');
    db.prepare('UPDATE gardens SET updated_ms = updated_ms + 1 WHERE user_id = ?').run(uid); // something in the WAL
    assert.equal(wipeCredentials(db, uid), 1);
    assert.equal(rowOf(db, uid), undefined);
    const walFile = path.join(dir, 'bean.db-wal');
    assert.equal(fs.existsSync(walFile) ? fs.statSync(walFile).size : 0, 0, 'WAL truncated by the checkpoint');
    assert.ok(!fs.readFileSync(path.join(dir, 'bean.db')).includes(ct), 'secure_delete + checkpoint removed the ciphertext');
    db.close();
  });

  test('a wipe that keeps the row (revoked) zeroes the key columns', async () => {
    const { db } = freshDb();
    const secrets = new Secrets({ masterKey: crypto.randomBytes(32) });
    const { uid } = await storeCredential(db, secrets);
    wipeCredentials(db, uid, { keepRow: true, reason: 'mainnet_key' });
    const row = rowOf(db, uid);
    assert.deepEqual([row.status, row.status_reason], ['revoked', 'mainnet_key']);
    for (const col of ['key_ct', 'key_iv', 'key_tag']) assert.ok(Buffer.from(row[col]).every((b) => b === 0), col);
    assert.throws(() => secrets.open(row));
    db.close();
  });

  test('account deletion (Users.remove) zeroes the key and checkpoints too', async () => {
    const { db, dir } = freshDb();
    const secrets = new Secrets({ masterKey: crypto.randomBytes(32) });
    const { uid, users } = await storeCredential(db, secrets, 'leaving_now');
    const ct = Buffer.from(rowOf(db, uid).key_ct);
    users.remove(uid);
    const walFile = path.join(dir, 'bean.db-wal');
    assert.equal(fs.existsSync(walFile) ? fs.statSync(walFile).size : 0, 0);
    assert.ok(!fs.readFileSync(path.join(dir, 'bean.db')).includes(ct));
    db.close();
  });
});

describe('log redaction (§5.3 rules 1 and 4)', () => {
  const key = crypto.randomBytes(32);
  const keyHex = key.toString('hex');

  test('64-hex keys (with or without 0x), base64 master keys, 43-char tokens and decimal keys are redacted', () => {
    // Deterministic samples that contain a digit, an upper- and a lower-case letter (the b64 rule's precondition).
    const b64Master = 'Q2xhdWRlIGlzIG5vdCBhIGtleSBidXQgaXQgaXMgMzI=';
    const token = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9f';
    assert.equal(token.length, 43);
    const decimal = BigInt(`0x${keyHex}`).toString(10); // ~77 digits: already caught by the 64+ hex-digit rule
    const decimal62 = '7'.repeat(62); // a 60–63-digit run is the decimal rule's own case
    const line = `key=${keyHex} 0x${keyHex.toUpperCase()} master ${b64Master} sid ${token} as int ${decimal} short ${decimal62}`;
    const out = sanitizeLogLine(line);
    for (const secret of [keyHex, keyHex.toUpperCase(), b64Master, token, decimal, decimal62]) {
      assert.ok(!out.includes(secret), secret.slice(0, 10));
    }
    assert.match(out, /\[hex64\].*\[hex64\].*\[b64\].*\[b64\].*\[hex64\].*\[dec\]/);
  });

  test('a capitalised, numbered or punctuated seed phrase is redacted', () => {
    const words = ['Abandon', 'Ability', 'Able', 'About', 'Above', 'Absent', 'Absorb', 'Abstract', 'Absurd', 'Abuse', 'Access', 'Accident'];
    for (const phrase of [words.join(' '), words.map((w, i) => `${i + 1}. ${w}`).join(' '), words.join(', '), words.join('-').toUpperCase(),
      [...words, ...words].join(' ')]) {
      const out = sanitizeLogLine(`[api] testnet_connect agent_key="${phrase}"`);
      assert.ok(!out.includes('Absorb') && !out.includes('ABSORB'), phrase);
      assert.match(out, /\[words\]/);
    }
  });

  test('kept: lower-case addresses, hash / cloid / oid values, file paths and stack frames, ordinary sentences', () => {
    const txHash = `0x${crypto.randomBytes(32).toString('hex')}`;
    const cloid = `0x${crypto.randomBytes(16).toString('hex')}`;
    const lines = [
      `[hl] order filled agent ${AGENT} account ${ACCOUNT}`,
      `{"hash":"${txHash}","cloid":"${cloid}","oid":123456789012}`,
      `fill hash=${txHash} oid=42`,
      '    at createServer (file:///D:/Projects/bean/server/http.js:153:60)',
      '    at async TestHook.run (node:internal/test_runner/test:1389:7) /home/node/app/server/garden/testnet-venue.js',
      'warming up 2880 bars (real Hyperliquid candles)…',
    ];
    for (const line of lines) assert.equal(sanitizeLogLine(line), line);
  });

  test('a sensitive op\'s internal error logs only op, err.name and a code — even when the message holds the key', () => {
    const err = Object.assign(new TypeError(`cannot parse ${keyHex} / ${key.toString('base64')}`), { code: 'bad_scalar' });
    err.stack = `TypeError: ${err.message}\n    at parse (secret ${keyHex})`;
    const line = sensitiveErrorLine('testnet_connect', err);
    assert.equal(line, '[api] testnet_connect → 500 internal error (TypeError, bad_scalar)');
    const weird = sensitiveErrorLine('auth_login', { name: `x ${keyHex}`, code: keyHex.slice(0, 50) });
    assert.ok(!weird.includes(keyHex.slice(0, 40)), 'odd names / codes are replaced, not echoed');
    const logs = [];
    makeSafeLogger((l) => logs.push(l))(`[api] internal error: ${err.stack}`); // even the old path would be redacted
    assert.ok(!logs[0].includes(keyHex));
  });

  test('makeSafeLogger sanitizes text and JSON (LOG_FORMAT=json) lines, fields included', () => {
    const out = [];
    const log = makeSafeLogger((l) => out.push(l), { format: 'json', now: () => Date.UTC(2026, 9, 11) });
    log(`[api] auth_login token ${keyHex}`, { op: 'auth_login', detail: `k=${keyHex}`, status: 401 });
    const rec = JSON.parse(out[0]);
    assert.equal(rec.t, '2026-10-11T00:00:00.000Z');
    assert.equal(rec.level, 'info');
    assert.equal(rec.op, 'auth_login');
    assert.equal(rec.status, 401);
    assert.ok(!out[0].includes(keyHex));
    const text = [];
    makeSafeLogger((l) => text.push(l))(`seed ${keyHex}`);
    assert.equal(text[0], 'seed [hex64]');
  });
});

describe('secret env vars and config errors (§5.1, §10.3)', () => {
  test('every secret variable (and its _FILE twin) is deleted from the env after it is read', () => {
    const dir = tmpDir();
    const master = crypto.randomBytes(32).toString('base64');
    const tokenFile = path.join(dir, 'admin_token');
    fs.writeFileSync(tokenFile, `${'A1b2C3d4'.repeat(5)}\n`);
    const env = {
      BEAN_AUTH: 'accounts', PUBLIC_ORIGIN: 'https://bean.example.com', TESTNET_ENABLED: '1',
      BEAN_MASTER_KEY: master, BEAN_MASTER_KEYS_OLD: crypto.randomBytes(32).toString('base64url'),
      ADMIN_TOKEN_FILE: tokenFile, ADMIN_BOOTSTRAP_CODE: 'BOOTSTRAP-CODE-42',
    };
    const cfg = parsePlatformConfig({ values: {}, env });
    for (const name of SECRET_VARS) {
      assert.ok(!(name in env) && !(`${name}_FILE` in env), `${name} deleted`);
    }
    assert.ok(cfg.secrets.masterKey.equals(Buffer.from(master, 'base64')));
    assert.equal(cfg.secrets.oldKeys.length, 1);
    assert.equal(cfg.secrets.adminToken, 'A1b2C3d4'.repeat(5));
    assert.equal(cfg.secrets.bootstrapCode, 'BOOTSTRAP-CODE-42');
    const shown = JSON.stringify(cfg) + util.inspect(cfg);
    for (const s of [master, 'A1b2C3d4A1b2', 'BOOTSTRAP-CODE-42']) assert.ok(!shown.includes(s), 'secrets are not enumerable');
    assert.equal(cfg.testnetEnabled, true);
  });

  test('config errors name the variable, never its value', () => {
    const cases = [
      [{ BEAN_MASTER_KEY: 'c2VjcmV0LXZhbHVlLXRoYXQtaXMtbm90LTMyLWJ5dGVz' }, 'BEAN_MASTER_KEY', 'c2VjcmV0LXZhbHVl'],
      [{ ADMIN_TOKEN: 'short-secret-token-xyz' }, 'ADMIN_TOKEN', 'short-secret-token-xyz'],
      [{ ADMIN_BOOTSTRAP_CODE: 'tiny-code' }, 'ADMIN_BOOTSTRAP_CODE', 'tiny-code'],
      [{ ADMIN_TOKEN: 'x', ADMIN_TOKEN_FILE: '/no/such/file' }, 'ADMIN_TOKEN', '/no/such/file'],
      [{ ADMIN_TOKEN_FILE: path.join(os.tmpdir(), 'missing-secret-file-xyz') }, 'ADMIN_TOKEN_FILE', 'missing-secret-file-xyz'],
      [{ PUBLIC_ORIGIN: 'https://bean.example.com/secret-path?k=v' }, 'PUBLIC_ORIGIN', 'secret-path'],
      [{ TRUST_PROXY: 'lots-of-hops' }, 'TRUST_PROXY', 'lots-of-hops'],
    ];
    for (const [extra, name, value] of cases) {
      const env = { BEAN_AUTH: 'accounts', PUBLIC_ORIGIN: 'https://bean.example.com', ...extra };
      assert.throws(() => parsePlatformConfig({ values: {}, env }), (err) => {
        assert.ok(err instanceof PlatformConfigError, err.message);
        assert.equal(err.exitCode, 2);
        assert.ok(err.message.includes(name), `names ${name}: ${err.message}`);
        assert.ok(!err.message.includes(value), `never echoes the value: ${err.message}`);
        return true;
      });
      for (const s of ['BEAN_MASTER_KEY', 'ADMIN_TOKEN', 'ADMIN_BOOTSTRAP_CODE']) {
        assert.ok(!(s in env), `${s} deleted even when the config is refused`);
      }
    }
  });

  test('readSecret: _FILE preferred, trimmed, both set refused, empty refused', () => {
    const dir = tmpDir();
    const file = path.join(dir, 's');
    fs.writeFileSync(file, '  value-from-file \n');
    const env = { X_FILE: file };
    assert.equal(readSecret(env, 'X'), 'value-from-file');
    assert.deepEqual(env, {});
    assert.throws(() => readSecret({ X: '' }, 'X'), /set but empty/);
    fs.writeFileSync(file, '\n');
    assert.throws(() => readSecret({ X_FILE: file }, 'X'), /empty/);
    assert.equal(readSecret({}, 'X'), null);
  });
});

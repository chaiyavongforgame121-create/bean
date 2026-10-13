// test/cloud.test.js — cloud persistence for Render free (server/cloudstore.js, server/cloudsync.js, the config, the
// egress allowance, the gardens' replay guard and the Render specifics). deploy/render/README.md is the operator's side.
//
// OFFLINE: every Storage call goes to a local fake of the Supabase Storage REST API (node:http on 127.0.0.1) that
// checks both auth headers, emulates Supabase's 400-"not found" quirk, folder listings, upserts and server-side copies,
// and can inject failures (status codes, connection resets, delays, bodies that stall or break after the headers) — or
// to an in-memory store (test/fixtures/mem-storage.js; the 24-hour egress simulations live in cloud-egress.test.js).
// Never the real Supabase project, never Render. The key is a
// random test-only string generated here; the suite asserts it never reaches a log line, an error or status(), and
// that every log line survives the secrets sanitizer unchanged.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

import { createCloudStore, checkObjectPath, normalizePrefix, CloudStoreError } from '../server/cloudstore.js';
import {
  cloudFiles, restoreFromCloud, startCloudSync, CloudSyncError, hourKey, parseLease, LEASE_PATH, BOOTSTRAP_REMOTE,
  HISTORY_KEEP, EGRESS_BUDGET_BYTES, STANDBY_ALERT_MS,
} from '../server/cloudsync.js';
import { openDb, MIGRATIONS_DIR } from '../server/db/db.js';
import { migrate } from '../server/db/migrate.js';
import { parsePlatformConfig, PlatformConfigError, SECRET_VARS, ACCOUNTS_ONLY_VARS } from '../server/config.js';
import { EGRESS_ALLOW, installEgressGuard, isAllowedEgress, isAllowedStorageEgress } from '../server/hl/egress.js';
import { hostOk } from '../server/auth/csrf.js';
import { createClientIp } from '../server/auth/clientip.js';
import { sanitizeLogLine } from '../server/secrets.js';
import { Engine, FeedUnavailableError } from '../server/engine.js';
import { Journal, GLOBAL_KINDS } from '../server/journal.js';
import { Pulse } from '../server/pulse.js';
import { Gardens } from '../server/garden/gardens.js';
import { REPLAY_GUARD_MAX_BARS } from '../server/live.js';
import { makeHL } from './fixtures/hl-double.js';
import { memStore } from './fixtures/mem-storage.js';

const KEY = `test-only-key-${crypto.randomBytes(24).toString('hex')}`;
const BUCKET = 'bean-garden';
const ALL_LOGS = []; // every log line of every store / sync below (scanned for the key and the sanitizer at the end)
const realFetch = globalThis.fetch;
const quiet = () => {};

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bean-cloud-'));
  tmpDirs.push(dir);
  return dir;
}
const servers = [];
after(async () => {
  globalThis.fetch = realFetch;
  for (const s of servers) await s.close();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function logger() {
  const lines = [];
  const log = (line) => {
    lines.push(String(line));
    ALL_LOGS.push(String(line));
  };
  log.lines = lines;
  return log;
}

// ---------------------------------------------------------------------------------------------
// A fake Supabase Storage server

async function fakeStorage({ bucketExists = true, bucketPublic = false, notFound = 400, copyUpsert = true } = {}) {
  const objects = new Map(); // "<bucket>/<path>" → {bytes, type}
  const buckets = new Map();
  if (bucketExists) buckets.set(BUCKET, { public: bucketPublic });
  const requests = [];
  const faults = [];
  const notFoundBody = JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' });

  const send = (res, status, body, type = 'application/json') => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'content-type': type, 'content-length': data.length });
    res.end(data);
  };
  const missing = (res) => (notFound === 404 ? send(res, 404, { statusCode: '404', error: 'not_found', message: 'Object not found' }) : send(res, 400, notFoundBody));
  const duplicate = (res) => send(res, 400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    requests.push({ method: req.method, path: p, headers: req.headers, bytes: body.length });
    const fault = faults.find((f) => f.times > 0 && (!f.method || f.method === req.method) && p.startsWith(f.path ?? ''));
    if (fault) {
      fault.times -= 1;
      if (fault.kind === 'reset') return req.socket.destroy();
      if (fault.kind === 'cut' || fault.kind === 'trickle') {
        // 200 + the headers at once, then the body breaks off (cut) or arrives slowly (trickle).
        const data = fault.body ?? Buffer.alloc(64 * 1024, 7);
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': data.length });
        if (fault.kind === 'cut') {
          res.write(data.subarray(0, data.length >> 1));
          setTimeout(() => req.socket.destroy(), 20);
          return undefined;
        }
        const step = fault.chunk ?? 1024;
        let off = 0;
        const t = setInterval(() => {
          if (off >= data.length || res.destroyed) {
            clearInterval(t);
            res.end();
            return;
          }
          res.write(data.subarray(off, off + step));
          off += step;
        }, fault.every ?? 20);
        res.on('close', () => clearInterval(t));
        return undefined;
      }
      if (fault.kind === 'delay') await new Promise((r) => setTimeout(r, fault.ms));
      else return send(res, fault.status, fault.body ?? { statusCode: String(fault.status), error: 'fault', message: 'injected' });
    }
    if (req.headers.authorization !== `Bearer ${KEY}` || req.headers.apikey !== KEY) {
      // Echo what we got: the client must scrub it from its errors.
      return send(res, 403, { statusCode: '403', error: 'Unauthorized', message: `invalid key ${req.headers.apikey}` });
    }
    let m;
    if ((m = /^\/storage\/v1\/bucket\/([^/]+)$/.exec(p)) && req.method === 'GET') {
      const b = buckets.get(m[1]);
      return b ? send(res, 200, { id: m[1], name: m[1], public: b.public }) : send(res, 400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
    }
    if (p === '/storage/v1/bucket' && req.method === 'POST') {
      const { id, public: pub } = JSON.parse(body.toString('utf8'));
      if (buckets.has(id)) return send(res, 409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      buckets.set(id, { public: pub === true });
      return send(res, 200, { name: id });
    }
    if (p === '/storage/v1/object/copy' && req.method === 'POST') {
      const { bucketId, sourceKey, destinationKey } = JSON.parse(body.toString('utf8'));
      const src = objects.get(`${bucketId}/${sourceKey}`);
      if (!src) return missing(res);
      const dest = `${bucketId}/${destinationKey}`;
      if (objects.has(dest) && !(copyUpsert && req.headers['x-upsert'] === 'true')) return duplicate(res);
      objects.set(dest, { bytes: src.bytes, type: src.type });
      return send(res, 200, { Key: dest });
    }
    if ((m = /^\/storage\/v1\/object\/list\/([^/]+)$/.exec(p)) && req.method === 'POST') {
      const { prefix = '', limit = 100, offset = 0 } = JSON.parse(body.toString('utf8'));
      const base = `${m[1]}/${prefix ? `${prefix}/` : ''}`;
      const seen = new Map();
      for (const [k, v] of objects) {
        if (!k.startsWith(base)) continue;
        const rest = k.slice(base.length).split('/');
        if (rest.length > 1) seen.set(rest[0], { name: rest[0], id: null, metadata: null });
        else seen.set(rest[0], { name: rest[0], id: crypto.randomUUID(), metadata: { size: v.bytes.length }, updated_at: new Date().toISOString() });
      }
      const rows = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(offset, offset + limit);
      return send(res, 200, rows);
    }
    if ((m = /^\/storage\/v1\/object\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
      const { prefixes } = JSON.parse(body.toString('utf8'));
      const gone = [];
      for (const k of prefixes) if (objects.delete(`${m[1]}/${k}`)) gone.push({ name: k });
      return send(res, 200, gone);
    }
    if ((m = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(p))) {
      if (!buckets.has(m[1])) return send(res, 400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
      const k = `${m[1]}/${m[2]}`;
      if (req.method === 'GET') {
        const o = objects.get(k);
        return o ? send(res, 200, o.bytes, o.type) : missing(res);
      }
      if (req.method === 'POST') {
        if (objects.has(k) && req.headers['x-upsert'] !== 'true') return duplicate(res);
        objects.set(k, { bytes: body, type: req.headers['content-type'] });
        return send(res, 200, { Key: k });
      }
    }
    return send(res, 400, { statusCode: '400', error: 'bad route', message: `${req.method} ${p}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const objectPrefix = `/storage/v1/object/${BUCKET}/`;
  const fake = {
    base, objects, buckets, requests, faults,
    fail: (f) => faults.push({ times: 1, ...f }),
    put: (p, bytes, type = 'application/gzip') => objects.set(`${BUCKET}/${p}`, { bytes: Buffer.from(bytes), type }),
    get: (p) => objects.get(`${BUCKET}/${p}`)?.bytes ?? null,
    has: (p) => objects.has(`${BUCKET}/${p}`),
    /** Object uploads (POST with a body), lease.json heartbeats excluded. */
    uploads: () => requests.filter((r) => r.method === 'POST' && r.path.startsWith(objectPrefix)).map((r) => r.path.slice(objectPrefix.length)).filter((x) => x !== LEASE_PATH),
    copies: () => requests.filter((r) => r.method === 'POST' && r.path === '/storage/v1/object/copy'),
    gets: (p) => requests.filter((r) => r.method === 'GET' && r.path === `${objectPrefix}${p}`).length,
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
  servers.push(fake);
  return fake;
}

const storeFor = (fake, extra = {}) => createCloudStore({ url: fake.base, key: KEY, bucket: BUCKET, log: logger(), backoffMs: 1, ...extra });
const gz = (text) => zlib.gzipSync(Buffer.from(text));
const gunz = (buf) => zlib.gunzipSync(buf);
const lease = (fake) => parseLease(fake.get(LEASE_PATH));

/** A small real SQLite DB file (bytes). */
function sqliteBytes(rows = 1) {
  const dir = tmpDir();
  const file = path.join(dir, 'x.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE t (x INTEGER)');
  for (let i = 0; i < rows; i++) db.prepare('INSERT INTO t VALUES (?)').run(i + 1);
  db.close();
  return fs.readFileSync(file);
}

/** The rows of table t in a gzipped DB object of the fake bucket. */
function cloudRows(fake, p = 'db/bean.db.gz') {
  const file = path.join(tmpDir(), 'rows.db');
  fs.writeFileSync(file, gunz(fake.get(p)));
  const h = new DatabaseSync(file);
  try {
    return h.prepare('SELECT x FROM t ORDER BY x').all().map((r) => r.x);
  } finally {
    h.close();
  }
}

/** The data dir of one instance: an open DB with a table, a state JSON, the managed files. */
function instanceDir() {
  const dir = tmpDir();
  const db = openDb({ file: path.join(dir, 'bean.db') });
  db.exec('CREATE TABLE IF NOT EXISTS t (x INTEGER)');
  db.prepare('INSERT INTO t VALUES (?)').run(1);
  const stateFile = path.join(dir, 'state-real.json');
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, engine: { tick: 1 } }));
  const files = cloudFiles({ dbFile: path.join(dir, 'bean.db'), stateFile, bootstrapFile: path.join(dir, 'admin-bootstrap.txt') });
  const add = (x) => db.prepare('INSERT INTO t VALUES (?)').run(x);
  return { dir, db, stateFile, files, add };
}

function clock(start = Date.UTC(2026, 9, 14, 5, 0, 0)) {
  const c = { ms: start, now: () => c.ms, advance: (ms) => { c.ms += ms; } };
  return c;
}

/** A store whose next upload of `remote` waits at a gate the test opens (a deterministic TOCTOU window). */
function gatedStore(store, remote) {
  let gate = null;
  const wrapped = {
    ...store,
    async upload(p, bytes, opts) {
      if (p === remote && gate) {
        const g = gate;
        gate = null;
        g.enter();
        await g.released;
      }
      return store.upload(p, bytes, opts);
    },
  };
  return {
    store: wrapped,
    arm() {
      let enter;
      let release;
      const entered = new Promise((r) => { enter = r; });
      const released = new Promise((r) => { release = r; });
      gate = { enter, released };
      return { entered, release };
    },
  };
}

// ---------------------------------------------------------------------------------------------

describe('cloud store: the Supabase Storage REST client (server/cloudstore.js)', () => {
  it('round trip with both auth headers, upsert, "not found" (400 quirk and 404) → null, folder listing, remove', async () => {
    for (const notFound of [400, 404]) {
      const fake = await fakeStorage({ notFound });
      const store = storeFor(fake, { prefix: '/prod/' });
      assert.equal(store.enabled, true);
      assert.equal(await store.download('db/bean.db.gz'), null, `not found (${notFound}) is null`);
      await store.upload('db/bean.db.gz', Buffer.from('one'));
      await store.upload('db/bean.db.gz', Buffer.from('two')); // x-upsert: true replaces
      assert.equal((await store.download('db/bean.db.gz')).toString(), 'two');
      assert.ok(fake.objects.has(`${BUCKET}/prod/db/bean.db.gz`), 'the prefix is applied');
      const up = fake.requests.find((r) => r.method === 'POST' && r.path.endsWith('/bean.db.gz'));
      assert.equal(up.headers.authorization, `Bearer ${KEY}`);
      assert.equal(up.headers.apikey, KEY);
      assert.equal(up.headers['x-upsert'], 'true');
      await store.upload('history/2026101405/bean.db.gz', Buffer.from('h'));
      await store.upload('history/2026101406/bean.db.gz', Buffer.from('h'));
      const top = await store.list('');
      assert.deepEqual(top.map((e) => [e.name, e.folder]), [['db', true], ['history', true]]);
      const hours = await store.list('history');
      assert.deepEqual(hours.map((e) => e.name), ['2026101405', '2026101406']);
      assert.ok(hours.every((e) => e.folder));
      assert.deepEqual((await store.list('history/2026101405')).map((e) => [e.name, e.folder, e.size]), [['bean.db.gz', false, 1]]);
      assert.equal(await store.remove(['history/2026101405/bean.db.gz']), 1);
      assert.equal(await store.download('history/2026101405/bean.db.gz'), null);
      assert.deepEqual(store.describe(), { enabled: true, host: new URL(fake.base).host, bucket: BUCKET, prefix: 'prod/' });
      assert.ok(fake.requests.every((r) => r.path.startsWith('/storage/v1/')), 'only /storage/v1/ paths');
    }
  });

  it('retries 5xx / 429 / connection resets with backoff; other 4xx fail at once; errors carry status + a short body, never the key', async () => {
    const fake = await fakeStorage();
    const sleeps = [];
    const store = storeFor(fake, { sleep: async (ms) => { sleeps.push(ms); }, backoffMs: 100 });
    fake.fail({ method: 'POST', status: 503, times: 2 });
    await store.upload('a.gz', Buffer.from('x'));
    assert.deepEqual(sleeps, [100, 300], 'bounded backoff');
    fake.fail({ method: 'GET', kind: 'reset', times: 1 });
    fake.fail({ method: 'GET', status: 429, times: 1 });
    assert.equal((await store.download('a.gz')).toString(), 'x');
    fake.fail({ method: 'POST', status: 500, times: 5 });
    await assert.rejects(store.upload('b.gz', Buffer.from('x')), (err) => err instanceof CloudStoreError && err.status === 500 && err.retryable);
    fake.faults.length = 0;
    // A 4xx is not retried; Supabase's error body (here echoing the key) is shortened and scrubbed.
    const before = fake.requests.length;
    const wrong = createCloudStore({ url: fake.base, key: `${KEY}-wrong`, bucket: BUCKET, log: logger(), backoffMs: 1 });
    await assert.rejects(wrong.download('a.gz'), (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, 'unauthorized');
      assert.match(err.message, /HTTP 403/);
      assert.ok(!err.message.includes(KEY), 'the key never appears in an error');
      assert.match(err.message, /\[key\]/, 'the echoed key is replaced');
      return true;
    });
    assert.equal(fake.requests.length - before, 1, 'no retry on 403');
    fake.fail({ method: 'GET', status: 500, times: 3, body: `boom ${KEY} ${'x'.repeat(400)}` });
    await assert.rejects(store.download('a.gz'), (err) => !err.message.includes(KEY) && err.message.length < 300);
  });

  it('a per-attempt timeout turns a hung request into a network error', async () => {
    const fake = await fakeStorage();
    const store = storeFor(fake, { timeoutMs: 80, retries: 0 });
    fake.fail({ method: 'GET', kind: 'delay', ms: 600, times: 1 });
    const t0 = Date.now();
    await assert.rejects(store.download('slow.gz'), (err) => err.code === 'network' && /timeout after 80 ms/.test(err.message));
    assert.ok(Date.now() - t0 < 500);
  });

  it('a body that breaks off or stalls AFTER the headers is retried; a big object gets a size-aware time limit', async () => {
    const fake = await fakeStorage();
    const blob = crypto.randomBytes(64 * 1024);
    fake.put('db/bean.db.gz', blob);
    const store = storeFor(fake, { timeoutMs: 300, retries: 2 });
    // Headers, half the body, then the connection dies → retried (the old client gave up at once: exit 4 at boot).
    fake.fail({ method: 'GET', path: `/storage/v1/object/${BUCKET}/db/`, kind: 'cut', body: blob });
    assert.ok((await store.download('db/bean.db.gz')).equals(blob));
    assert.equal(fake.gets('db/bean.db.gz'), 2);
    // Headers, then a body slower than the attempt's limit → the attempt times out mid-body and is retried.
    fake.fail({ method: 'GET', path: `/storage/v1/object/${BUCKET}/db/`, kind: 'trickle', body: blob, chunk: 1024, every: 20 });
    const t0 = Date.now();
    assert.ok((await store.download('db/bean.db.gz')).equals(blob));
    assert.equal(fake.gets('db/bean.db.gz'), 4);
    assert.ok(Date.now() - t0 < 2_000);
    // A 2 MB object that takes ~0.5 s: 100 ms + 2 × 2000 ms per MB — one attempt, no timeout.
    const big = crypto.randomBytes(2 * 1024 * 1024);
    fake.put('state/state-real.json.gz', big);
    const sized = storeFor(fake, { timeoutMs: 100, perMbMs: 2_000, retries: 0 });
    fake.fail({ method: 'GET', path: `/storage/v1/object/${BUCKET}/state/`, kind: 'trickle', body: big, chunk: 256 * 1024, every: 50 });
    assert.ok((await sized.download('state/state-real.json.gz')).equals(big));
    assert.equal(fake.gets('state/state-real.json.gz'), 1);
    // The worst case of one call (the takeover grace): every attempt at its size-aware limit, plus the backoff.
    const s = storeFor(fake, { timeoutMs: 15_000, perMbMs: 5_000, retries: 2, backoffMs: 500 });
    assert.equal(s.maxCallMs(0), 3 * 15_000 + 500 + 1_500);
    assert.equal(s.maxCallMs(3 * 1024 * 1024), 3 * (15_000 + 15_000) + 2_000);
  });

  it('copy is server-side (no object bytes sent) and replaces an existing destination, also without upsert-on-copy', async () => {
    for (const copyUpsert of [true, false]) {
      const fake = await fakeStorage({ copyUpsert });
      const store = storeFor(fake, { prefix: 'prod' });
      await store.upload('db/bean.db.gz', Buffer.from('v1'));
      await store.copy('db/bean.db.gz', 'history/2026101405/bean.db.gz');
      await store.upload('db/bean.db.gz', Buffer.from('v2'));
      await store.copy('db/bean.db.gz', 'history/2026101405/bean.db.gz'); // same hour again (a restart)
      assert.equal((await store.download('history/2026101405/bean.db.gz')).toString(), 'v2');
      const copies = fake.copies();
      assert.ok(copies.length >= 2 && copies.every((r) => r.bytes < 200 && r.headers['x-upsert'] === 'true'), 'a small JSON body each');
      assert.ok(fake.has('prod/history/2026101405/bean.db.gz'), 'the prefix applies to both keys');
      await assert.rejects(store.copy('db/missing.gz', 'history/x.gz'), CloudStoreError);
    }
  });

  it('object paths are validated; without url + key the store is disabled', async () => {
    for (const bad of ['', '../x', 'a/../b', 'a//b', '/a', 'a/', 'a b', 'a?b', 'a%2fb']) assert.throws(() => checkObjectPath(bad), CloudStoreError, bad);
    assert.equal(checkObjectPath('history/2026101405/bean.db.gz'), 'history/2026101405/bean.db.gz');
    assert.equal(normalizePrefix(''), '');
    assert.equal(normalizePrefix('/bean/prod/'), 'bean/prod/');
    assert.throws(() => normalizePrefix('bean/../x'), CloudStoreError);
    const off = createCloudStore({ url: '', key: '', bucket: BUCKET });
    assert.equal(off.enabled, false);
    await assert.rejects(off.download('x'), (err) => err.code === 'disabled');
    await assert.rejects(off.copy('x', 'y'), (err) => err.code === 'disabled');
    assert.throws(() => createCloudStore({ url: 'https://x.supabase.co', key: KEY, bucket: 'Bad Bucket' }), (err) => err.code === 'bad_bucket');
  });

  it('ensurePrivateBucket: creates a missing bucket PRIVATE, accepts a private one, refuses a public one', async () => {
    const empty = await fakeStorage({ bucketExists: false });
    const log = logger();
    assert.equal(await storeFor(empty, { log }).ensurePrivateBucket(), 'created');
    assert.deepEqual(empty.buckets.get(BUCKET), { public: false });
    assert.ok(log.lines.some((l) => /created the PRIVATE bucket/.test(l)));
    assert.equal(await storeFor(empty).ensurePrivateBucket(), 'exists');
    const pub = await fakeStorage({ bucketPublic: true });
    await assert.rejects(storeFor(pub).ensurePrivateBucket(), (err) => err.code === 'bucket_public' && /PUBLIC/.test(err.message));
  });
});

describe('cloud restore at boot (before the DB is opened)', () => {
  const filesIn = (dir) => cloudFiles({ dbFile: path.join(dir, 'bean.db'), stateFile: path.join(dir, 'state-real.json'), bootstrapFile: path.join(dir, 'admin-bootstrap.txt') });

  it('an empty bucket → a fresh start: nothing is written', async () => {
    const fake = await fakeStorage();
    const dir = tmpDir();
    const log = logger();
    const r = await restoreFromCloud({ store: storeFor(fake), files: filesIn(dir), log });
    assert.equal(r.fresh, true);
    assert.deepEqual(r.restored, []);
    assert.equal(r.lease, null);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.ok(log.lines.some((l) => /first boot/.test(l)));
  });

  it('objects present → every missing file is written atomically (gunzipped, owner-only, no temp files); stale -wal/-shm go; local files are kept', async () => {
    const fake = await fakeStorage();
    const db = sqliteBytes(3);
    fake.put('db/bean.db.gz', zlib.gzipSync(db));
    fake.put('state/state-real.json.gz', gz('{"version":1,"engine":{"tick":7}}'));
    fake.put(BOOTSTRAP_REMOTE, Buffer.from('ABCDEFGHJKLM\n'), 'text/plain');
    fake.put(LEASE_PATH, Buffer.from(JSON.stringify({ v: 2, instance: 'prev-instance', seq: 123, synced: true })), 'application/json');
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'bean.db-wal'), 'stale wal of another db');
    fs.writeFileSync(path.join(dir, 'bean.db-shm'), 'stale shm');
    const files = filesIn(dir);
    const r = await restoreFromCloud({ store: storeFor(fake), files, log: logger() });
    assert.deepEqual(r.restored.sort(), ['admin-bootstrap.txt', 'bean.db', 'state-real.json']);
    assert.equal(r.fresh, false);
    assert.equal(r.lease.seq, 123, 'the previous owner\'s lease comes back (journal seq floor, egress meter)');
    assert.ok(fs.readFileSync(path.join(dir, 'bean.db')).equals(db));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state-real.json'), 'utf8')).engine.tick, 7);
    assert.equal(fs.readFileSync(path.join(dir, 'admin-bootstrap.txt'), 'utf8'), 'ABCDEFGHJKLM\n');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['admin-bootstrap.txt', 'bean.db', 'state-real.json'], 'no -wal/-shm, no .tmp left');
    const opened = new DatabaseSync(path.join(dir, 'bean.db'));
    assert.equal(opened.prepare('SELECT COUNT(*) AS n FROM t').get().n, 3);
    opened.close();
    // A second boot with the files present keeps them (a persistent disk holds the newer copy): only lease.json is read.
    fs.writeFileSync(path.join(dir, 'state-real.json'), '{"version":1,"engine":{"tick":8}}');
    const gets = fake.requests.length;
    const again = await restoreFromCloud({ store: storeFor(fake), files, log: logger() });
    assert.deepEqual(again.kept.sort(), ['admin-bootstrap.txt', 'bean.db', 'state-real.json']);
    assert.equal(fake.requests.length, gets + 1);
    assert.equal(fake.requests.at(-1).path, `/storage/v1/object/${BUCKET}/${LEASE_PATH}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state-real.json'), 'utf8')).engine.tick, 8);
  });

  it('a download error other than "not found" refuses to start (exit 4) and writes nothing', async () => {
    const fake = await fakeStorage();
    fake.put('db/bean.db.gz', zlib.gzipSync(sqliteBytes()));
    fake.fail({ method: 'GET', path: '/storage/v1/object/bean-garden/state', status: 500, times: 10 });
    const dir = tmpDir();
    const files = cloudFiles({ dbFile: path.join(dir, 'bean.db'), stateFile: path.join(dir, 'state-real.json') });
    await assert.rejects(restoreFromCloud({ store: storeFor(fake), files, log: logger() }), (err) => {
      assert.ok(err instanceof CloudSyncError);
      assert.equal(err.exitCode, 4);
      assert.match(err.message, /cannot download state\/state-real\.json\.gz .*HTTP 500.*Refusing to start/);
      assert.ok(!err.message.includes(KEY));
      return true;
    });
    assert.deepEqual(fs.readdirSync(dir), [], 'not even the DB that did download');
    // The wrong key (401/403) refuses too: it must never look like an empty bucket.
    const wrong = createCloudStore({ url: fake.base, key: 'wrong-key-0123456789abcdef', bucket: BUCKET, backoffMs: 1 });
    await assert.rejects(restoreFromCloud({ store: wrong, files: cloudFiles({ dbFile: path.join(tmpDir(), 'bean.db'), stateFile: path.join(tmpDir(), 's.json') }) }), CloudSyncError);
  });

  it('a corrupt or mislabelled object refuses to start', async () => {
    for (const [remote, bytes] of [['db/bean.db.gz', Buffer.from('not gzip')], ['db/bean.db.gz', gz('not sqlite at all')], ['state/state-real.json.gz', gz('{oops')]]) {
      const fake = await fakeStorage();
      fake.put(remote, bytes);
      const dir = tmpDir();
      const files = cloudFiles({ dbFile: path.join(dir, 'bean.db'), stateFile: path.join(dir, 'state-real.json') });
      await assert.rejects(restoreFromCloud({ store: storeFor(fake), files }), (err) => err instanceof CloudSyncError && /history/.test(err.message), remote);
      assert.deepEqual(fs.readdirSync(dir), []);
    }
  });

  it('a "not found" DB or state in a bucket already in use refuses to start (exit 4, nothing written) unless CLOUD_ALLOW_FRESH=1', async () => {
    // A long-running instance left good data: rows 1..50, the lease, history.
    const fake = await fakeStorage();
    const c = clock();
    const a = instanceDir();
    for (let i = 2; i <= 50; i++) a.add(i);
    const aSync = startCloudSync({ store: storeFor(fake), db: a.db, files: a.files, intervalMs: 3_600_000, now: c.now, log: logger() });
    assert.equal((await aSync.start()).ok, true);
    aSync.stop();
    a.db.close();
    assert.equal(cloudRows(fake).length, 50);
    assert.equal(lease(fake).synced, true);
    const hourCopy = `history/${hourKey(c.ms)}/bean.db.gz`;
    assert.ok(fake.has(hourCopy));

    // Restart on a fresh disk; Storage answers ONE spurious 400 "not found" for the DB object.
    const notFoundOnce = { method: 'GET', path: '/storage/v1/object/bean-garden/db/bean.db.gz', status: 400, body: { statusCode: '404', error: 'not_found', message: 'Object not found' } };
    fake.fail(notFoundOnce);
    const dir = tmpDir();
    await assert.rejects(restoreFromCloud({ store: storeFor(fake), files: filesIn(dir), log: logger() }), (err) => {
      assert.ok(err instanceof CloudSyncError);
      assert.equal(err.exitCode, 4);
      assert.match(err.message, /db\/bean\.db\.gz not found although the bucket was in use \(lease\.json says a database was synced\)/);
      assert.match(err.message, /CLOUD_ALLOW_FRESH=1/);
      return true;
    });
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing written: not even the state that did download');
    assert.equal(cloudRows(fake).length, 50, 'the good copy is untouched');
    assert.equal(cloudRows(fake, hourCopy).length, 50, 'and so is this hour\'s history');
    // Render restarts the service: the next boot restores everything.
    const ok = await restoreFromCloud({ store: storeFor(fake), files: filesIn(dir), log: logger() });
    assert.deepEqual(ok.restored.sort(), ['bean.db', 'state-real.json']);

    // Other evidence: history hours (no lease), or the other core object.
    const f2 = await fakeStorage();
    f2.put('history/2026101404/bean.db.gz', gz('x'));
    f2.put('db/bean.db.gz', zlib.gzipSync(sqliteBytes(2)));
    await assert.rejects(restoreFromCloud({ store: storeFor(f2), files: filesIn(tmpDir()) }), /state\/state-real\.json\.gz not found .*bean\.db is in the bucket/);
    const f3 = await fakeStorage();
    f3.put('history/2026101404/state-real.json.gz', gz('{}'));
    await assert.rejects(restoreFromCloud({ store: storeFor(f3), files: filesIn(tmpDir()) }), /history\/ has 1 hour/);
    // A lease written before the first DB upload (a crash in the first seconds of the first boot) is not evidence.
    const f4 = await fakeStorage();
    f4.put(LEASE_PATH, Buffer.from(JSON.stringify({ instance: 'x', synced: false })), 'application/json');
    assert.equal((await restoreFromCloud({ store: storeFor(f4), files: filesIn(tmpDir()) })).fresh, true);

    // CLOUD_ALLOW_FRESH=1: the operator starts over on purpose (logged).
    fake.fail(notFoundOnce);
    const log = logger();
    const dir2 = tmpDir();
    const fresh = await restoreFromCloud({ store: storeFor(fake), files: filesIn(dir2), allowFresh: true, log });
    assert.ok(fresh.missing.includes('bean.db') && fresh.restored.includes('state-real.json'));
    assert.ok(log.lines.some((l) => /CLOUD_ALLOW_FRESH=1: starting without db\/bean\.db\.gz/.test(l)));
  });
});

describe('cloud sync while running (lease, change detection, history, shutdown)', () => {
  it('the first sync takes the lease and uploads db + state + this hour\'s history (server-side copies); then only what changed', async () => {
    const fake = await fakeStorage();
    const inst = instanceDir();
    const c = clock();
    const log = logger();
    const sync = startCloudSync({ store: storeFor(fake), db: inst.db, files: inst.files, intervalMs: 3_600_000, now: c.now, log, seq: () => 41 });
    const first = await sync.start();
    assert.equal(first.ok, true);
    const l = lease(fake);
    assert.equal(typeof l.instance, 'string');
    assert.equal(l.started_ms, c.ms);
    assert.equal(l.renewed_ms, c.ms);
    assert.equal(l.seq, 41);
    assert.equal(l.synced, true);
    const hour = hourKey(c.ms);
    assert.equal(hour, '2026101405');
    assert.deepEqual(fake.uploads().sort(), ['db/bean.db.gz', 'state/state-real.json.gz']);
    assert.equal(fake.copies().length, 2, 'history is copied inside Storage, not uploaded again');
    for (const p of [`history/${hour}/bean.db.gz`, `history/${hour}/state-real.json.gz`]) assert.ok(fake.has(p), p);
    assert.ok(fake.get(`history/${hour}/bean.db.gz`).equals(fake.get('db/bean.db.gz')));
    // The uploaded DB is a consistent copy with the row.
    assert.deepEqual(cloudRows(fake), [1]);
    assert.deepEqual(fs.readdirSync(inst.dir).filter((n) => n.startsWith('.cloud')), [], 'the snapshot temp file is removed');

    // Nothing changed → nothing uploaded (the lease is read and renewed: the heartbeat).
    let ups = fake.uploads().length;
    c.advance(60_000);
    assert.deepEqual((await sync.syncNow('interval')).uploaded, []);
    assert.equal(fake.uploads().length, ups);
    assert.equal(lease(fake).renewed_ms, c.ms, 'heartbeat');
    // A DB write → only the DB.
    inst.add(2);
    c.advance(60_000);
    assert.deepEqual((await sync.syncNow('interval')).uploaded, ['db/bean.db.gz']);
    ups = fake.uploads().length;
    // The state changed: not after 10 minutes, not with the next hour's history copy (it goes every 2 hours) …
    fs.writeFileSync(inst.stateFile, JSON.stringify({ version: 1, engine: { tick: 2 } }));
    c.advance(10 * 60_000);
    assert.deepEqual((await sync.syncNow('interval')).uploaded, []);
    c.ms = Date.UTC(2026, 9, 14, 6, 0, 30);
    let r = await sync.syncNow('interval');
    assert.deepEqual(r.uploaded, ['history/2026101406/']);
    assert.equal(JSON.parse(gunz(fake.get('history/2026101406/state-real.json.gz'))).engine.tick, 1, 'a copy of the newest state/ object');
    assert.deepEqual(cloudRows(fake, 'history/2026101406/bean.db.gz'), [1, 2], 'the newest db/ copy, not re-uploaded');
    // … but 2 hours after the last one.
    c.ms = Date.UTC(2026, 9, 14, 7, 0, 30);
    r = await sync.syncNow('interval');
    assert.deepEqual(r.uploaded, ['state/state-real.json.gz', 'history/2026101407/']);
    assert.equal(JSON.parse(gunz(fake.get('state/state-real.json.gz'))).engine.tick, 2);
    assert.equal(JSON.parse(gunz(fake.get('history/2026101407/state-real.json.gz'))).engine.tick, 2);
    c.advance(10 * 60_000);
    assert.deepEqual((await sync.syncNow('interval')).uploaded, [], 'unchanged state is not re-uploaded');
    const st = sync.status();
    assert.equal(st.lease, 'owned');
    assert.equal(st.lease_owner, true);
    assert.equal(st.failures, 0);
    assert.equal(st.month, '202610');
    assert.ok(st.month_bytes >= st.bytes_uploaded && st.egress_budget_bytes === EGRESS_BUDGET_BYTES && st.over_pace === false);
    assert.ok(st.last_ok_ms && st.uploads >= 4 && st.bytes_uploaded > 0 && st.db_bytes > 0 && st.state_bytes > 0);
    sync.stop();
    inst.db.close();
  });

  it('syncs are serialized: two concurrent syncNow calls never upload at the same time', async () => {
    const fake = await fakeStorage();
    const inst = instanceDir();
    let active = 0;
    let peak = 0;
    const store = storeFor(fake);
    const slow = {
      ...store,
      async upload(...a) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        try {
          return await store.upload(...a);
        } finally {
          active -= 1;
        }
      },
    };
    const sync = startCloudSync({ store: slow, db: inst.db, files: inst.files, intervalMs: 3_600_000, log: logger() });
    await Promise.all([sync.syncNow('a', { force: true }), sync.syncNow('b', { force: true }), sync.syncNow('c', { force: true })]);
    assert.equal(peak, 1);
    inst.db.close();
  });

  it('lease takeover (zero-downtime deploy): the new instance takes it, uploads its full lineage after the grace; the old one stands by', async () => {
    const fake = await fakeStorage();
    const c = clock();
    const oldInst = instanceDir();
    const oldLog = logger();
    const oldSync = startCloudSync({ store: storeFor(fake), db: oldInst.db, files: oldInst.files, intervalMs: 3_600_000, now: c.now, log: oldLog });
    await oldSync.start();
    c.advance(5_000);
    const newInst = instanceDir();
    newInst.add(500);
    const newLog = logger();
    const newSync = startCloudSync({ store: storeFor(fake), db: newInst.db, files: newInst.files, intervalMs: 3_600_000, graceMs: 90_000, now: c.now, log: newLog });
    const first = await newSync.start();
    assert.deepEqual(first, { ok: true, uploaded: [], deferred: true }, 'nothing but the lease until the old instance\'s last upload cannot land');
    assert.equal(lease(fake).instance.slice(0, 8), newSync.status().instance);
    assert.ok(newLog.lines.some((l) => /took the lease from .* first full upload in 90 s/.test(l)));
    const ups = fake.uploads().length;
    oldInst.add(99);
    const r = await oldSync.syncNow('interval');
    assert.deepEqual(r, { ok: false, skipped: 'lease_standby', uploaded: [] });
    assert.equal((await oldSync.syncNow('interval')).skipped, 'lease_standby');
    const fin = await oldSync.syncNow('shutdown', { force: true, deadlineMs: 2_000 });
    assert.equal(fin.skipped, 'lease_standby');
    assert.equal(fake.uploads().length, ups, 'the old instance uploaded nothing after the takeover');
    assert.equal(oldLog.lines.filter((l) => /stops uploading and stands by/.test(l)).length, 1, 'logged once');
    assert.equal(oldSync.status().lease_owner, false);
    assert.equal(oldSync.status().lease, 'standby');
    assert.equal(oldSync.status().lease_other, newSync.status().instance);
    // The grace passes → the new instance's full lineage (DB and state), then only what changes.
    c.advance(60_000);
    assert.equal((await newSync.syncNow('interval')).deferred, true);
    c.advance(31_000);
    const full = await newSync.syncNow('interval');
    assert.ok(full.uploaded.includes('db/bean.db.gz') && full.uploaded.includes('state/state-real.json.gz'));
    assert.deepEqual(cloudRows(fake), [1, 500]);
    newInst.add(5);
    c.advance(60_000);
    assert.deepEqual((await newSync.syncNow('interval')).uploaded, ['db/bean.db.gz']);
    oldInst.db.close();
    newInst.db.close();
  });

  it('an older instance whose first sync is late never takes a newer instance\'s lease (it stands by)', async () => {
    const fake = await fakeStorage();
    const c = clock();
    const a = instanceDir();
    const older = startCloudSync({ store: storeFor(fake), db: a.db, files: a.files, intervalMs: 3_600_000, now: c.now, log: logger() });
    c.advance(1_000);
    const b = instanceDir();
    const newer = startCloudSync({ store: storeFor(fake), db: b.db, files: b.files, intervalMs: 3_600_000, now: c.now, log: logger() });
    await newer.start();
    const r = await older.start();
    assert.equal(r.skipped, 'lease_standby');
    assert.equal(lease(fake).instance.slice(0, 8), newer.status().instance);
    assert.equal(older.status().lease, 'standby');
    older.stop();
    newer.stop();
    a.db.close();
    b.db.close();
  });

  it('one spurious "not found" for lease.json is a retried failure, never a takeover; a lease deleted for real is written again', async () => {
    const fake = await fakeStorage();
    const c = clock();
    const inst = instanceDir();
    const log = logger();
    const sync = startCloudSync({ store: storeFor(fake), db: inst.db, files: inst.files, intervalMs: 3_600_000, now: c.now, log });
    assert.equal((await sync.start()).ok, true);
    fake.fail({ method: 'GET', path: `/storage/v1/object/${BUCKET}/${LEASE_PATH}`, status: 404 });
    inst.add(2);
    c.advance(60_000);
    const r1 = await sync.syncNow('interval');
    assert.equal(r1.ok, false);
    assert.match(r1.error, /lease\.json was not found; retrying/);
    assert.equal(sync.status().lease, 'owned', 'still the owner');
    c.advance(60_000);
    assert.deepEqual((await sync.syncNow('interval')).uploaded, ['db/bean.db.gz']);
    assert.deepEqual(cloudRows(fake), [1, 2]);
    // lease.json deleted (an operator in the dashboard): one retry, then written again by the owner.
    fake.objects.delete(`${BUCKET}/${LEASE_PATH}`);
    inst.add(3);
    c.advance(60_000);
    assert.equal((await sync.syncNow('interval')).ok, false);
    c.advance(60_000);
    assert.equal((await sync.syncNow('interval')).ok, true);
    assert.equal(lease(fake).instance.slice(0, 8), sync.status().instance);
    assert.ok(log.lines.some((l) => /missing twice in a row: writing it again/.test(l)));
    assert.deepEqual(cloudRows(fake), [1, 2, 3]);
    // … and the shutdown sync still runs.
    inst.add(4);
    sync.stop();
    assert.equal((await sync.syncNow('shutdown', { force: true, deadlineMs: 5_000 })).ok, true);
    assert.deepEqual(cloudRows(fake), [1, 2, 3, 4]);
    inst.db.close();
  });

  it('a deploy that takes the lease and dies never silences the instance that keeps serving: it takes the lease back', async () => {
    const fake = await fakeStorage();
    const c = clock();
    const live = instanceDir();
    const liveLog = logger();
    const liveSync = startCloudSync({ store: storeFor(fake), db: live.db, files: live.files, intervalMs: 3_600_000, staleMs: 240_000, graceMs: 90_000, now: c.now, log: liveLog });
    await liveSync.start();
    c.advance(30 * 60_000);
    // Deploy C boots, listens, takes the lease, then crashes / is cancelled. Render keeps `live` serving.
    const dead = instanceDir();
    const deadSync = startCloudSync({ store: storeFor(fake), db: dead.db, files: dead.files, intervalMs: 3_600_000, graceMs: 90_000, now: c.now, log: logger() });
    await deadSync.start();
    deadSync.stop();
    dead.db.close();
    live.add(100);
    c.advance(60_000);
    assert.equal((await liveSync.syncNow('interval')).skipped, 'lease_standby');
    c.advance(120_000);
    assert.equal((await liveSync.syncNow('interval')).skipped, 'lease_standby', 'the owner may only be slow');
    c.advance(150_000); // lease.json unchanged for 270 s > 240 s on THIS clock → the owner is gone
    const back = await liveSync.syncNow('interval');
    assert.equal(back.ok, true);
    assert.equal(back.deferred, true);
    assert.equal(liveSync.status().lease, 'owned');
    assert.ok(liveLog.lines.some((l) => /took the lease from .* stopped renewing/.test(l)));
    live.add(101);
    c.advance(91_000);
    const full = await liveSync.syncNow('interval');
    assert.ok(full.uploaded.includes('db/bean.db.gz') && full.uploaded.includes('state/state-real.json.gz'));
    assert.deepEqual(cloudRows(fake), [1, 100, 101]);
    live.add(102);
    assert.equal((await liveSync.syncNow('shutdown', { force: true, deadlineMs: 5_000 })).ok, true);
    assert.deepEqual(cloudRows(fake), [1, 100, 101, 102]);
    live.db.close();
  });

  it('TOCTOU: an old instance\'s authorized upload that lands after the takeover is overwritten by the owner\'s full lineage', async () => {
    const fake = await fakeStorage();
    const c = clock();
    const a = instanceDir();
    const gated = gatedStore(storeFor(fake), 'db/bean.db.gz');
    const aSync = startCloudSync({ store: gated.store, db: a.db, files: a.files, intervalMs: 3_600_000, now: c.now, log: logger() });
    await aSync.start();
    c.advance(60_000);
    a.add(7);
    const gate = gated.arm();
    const aRun = aSync.syncNow('interval');
    await gate.entered; // A passed its lease check and is inside its DB upload
    c.advance(1_000);
    const b = instanceDir();
    b.add(555);
    const bSync = startCloudSync({ store: storeFor(fake), db: b.db, files: b.files, intervalMs: 3_600_000, graceMs: 90_000, now: c.now, log: logger() });
    assert.equal((await bSync.start()).deferred, true);
    gate.release();
    // A's upload was authorized before the takeover and lands late; A then sees the new owner and never writes its
    // heartbeat over B's lease.
    assert.equal((await aRun).skipped, 'lease_standby');
    assert.deepEqual(cloudRows(fake), [1, 7], 'for now the bucket holds A\'s lineage');
    assert.equal(lease(fake).instance.slice(0, 8), bSync.status().instance, 'B still owns the lease');
    c.advance(60_000);
    assert.equal((await aSync.syncNow('interval')).skipped, 'lease_standby');
    c.advance(31_000);
    const full = await bSync.syncNow('interval');
    assert.ok(full.uploaded.includes('db/bean.db.gz'));
    assert.deepEqual(cloudRows(fake), [1, 555], 'the owner\'s full upload after the grace wins');
    a.db.close();
    b.db.close();
  });

  it('clock skew: a lease from the future is not trusted; a skewed-but-plausible one is taken over once its owner stops', async () => {
    // (a) The old instance's clock is 10 min ahead: the new deploy takes the lease (no cross-host trust).
    const fake = await fakeStorage();
    const base = Date.UTC(2026, 9, 14, 5, 0, 0);
    const old = instanceDir();
    const oc = clock(base + 10 * 60_000);
    const oldSync = startCloudSync({ store: storeFor(fake), db: old.db, files: old.files, intervalMs: 3_600_000, now: oc.now, log: logger() });
    await oldSync.start();
    const nc = clock(base + 2 * 60_000);
    const neu = instanceDir();
    neu.add(321);
    const newSync = startCloudSync({ store: storeFor(fake), db: neu.db, files: neu.files, intervalMs: 3_600_000, graceMs: 30_000, now: nc.now, log: logger() });
    assert.equal((await newSync.start()).deferred, true);
    assert.equal((await oldSync.syncNow('shutdown', { force: true, deadlineMs: 2_000 })).skipped, 'lease_standby');
    nc.advance(31_000);
    assert.ok((await newSync.syncNow('interval')).uploaded.includes('db/bean.db.gz'));
    assert.deepEqual(cloudRows(fake), [1, 321]);
    old.db.close();
    neu.db.close();

    // (b) 3 min ahead (within the tolerance): the new deploy stands by while the old one renews, then takes over.
    const f2 = await fakeStorage();
    const o2 = instanceDir();
    const oc2 = clock(base + 3 * 60_000);
    const old2 = startCloudSync({ store: storeFor(f2), db: o2.db, files: o2.files, intervalMs: 3_600_000, now: oc2.now, log: logger() });
    await old2.start();
    const nc2 = clock(base + 60_000);
    const n2 = instanceDir();
    n2.add(654);
    const new2 = startCloudSync({ store: storeFor(f2), db: n2.db, files: n2.files, intervalMs: 3_600_000, staleMs: 240_000, graceMs: 30_000, now: nc2.now, log: logger() });
    assert.equal((await new2.start()).skipped, 'lease_standby');
    oc2.advance(60_000);
    o2.add(77);
    assert.equal((await old2.syncNow('shutdown', { force: true, deadlineMs: 5_000 })).ok, true, 'the old owner\'s final sync');
    nc2.advance(60_000);
    assert.equal((await new2.syncNow('interval')).skipped, 'lease_standby');
    nc2.advance(250_000);
    assert.equal((await new2.syncNow('interval')).deferred, true, 'the old lease stayed unchanged: taken over');
    nc2.advance(31_000);
    assert.ok((await new2.syncNow('interval')).uploaded.includes('db/bean.db.gz'));
    assert.deepEqual(cloudRows(f2), [1, 654]);
    o2.db.close();
    n2.db.close();
  });

  it('a standby that lasts (two live instances on one bucket) logs an ALERT every 10 minutes', async () => {
    const store = memStore();
    const c = clock();
    const a = instanceDir();
    const aLog = logger();
    const aSync = startCloudSync({ store, db: a.db, files: a.files, intervalMs: 3_600_000, now: c.now, log: aLog });
    await aSync.start();
    c.advance(1_000);
    const b = instanceDir();
    const bSync = startCloudSync({ store, db: b.db, files: b.files, intervalMs: 3_600_000, graceMs: 0, now: c.now, log: logger() });
    await bSync.start();
    for (let m = 0; m < 25; m++) {
      c.advance(60_000);
      await bSync.syncNow('interval'); // B renews
      assert.equal((await aSync.syncNow('interval')).skipped, 'lease_standby');
    }
    assert.equal(STANDBY_ALERT_MS, 10 * 60_000);
    assert.equal(aLog.lines.filter((l) => /ALERT standby for \d+ min/.test(l)).length, 2);
    assert.ok(aSync.status().standby_since_ms > 0);
    a.db.close();
    b.db.close();
  });

  it('shutdown: the final sync uploads the checkpointed, CLOSED DB and the state; a hung store hits the deadline in time', async () => {
    const fake = await fakeStorage();
    const inst = instanceDir();
    const sync = startCloudSync({ store: storeFor(fake), db: inst.db, files: inst.files, intervalMs: 3_600_000, log: logger() });
    await sync.start();
    inst.add(42);
    fs.writeFileSync(inst.stateFile, JSON.stringify({ version: 1, engine: { tick: 42 } }));
    sync.stop();
    await sync.idle();
    inst.db.checkpoint();
    inst.db.close(); // main.js: gardens flush → state save → checkpoint + close → final sync
    const r = await sync.syncNow('shutdown', { force: true, deadlineMs: 5_000 });
    assert.equal(r.ok, true);
    assert.ok(r.uploaded.includes('db/bean.db.gz') && r.uploaded.includes('state/state-real.json.gz'));
    assert.deepEqual(cloudRows(fake), [1, 42], 'the last write is in the final copy');
    assert.equal(JSON.parse(gunz(fake.get('state/state-real.json.gz'))).engine.tick, 42);

    // A store that hangs: the shutdown sync resolves at its deadline (Render would SIGKILL at ~30 s).
    const hung = await fakeStorage();
    const inst2 = instanceDir();
    const sync2 = startCloudSync({ store: storeFor(hung, { timeoutMs: 10_000, retries: 0 }), db: inst2.db, files: inst2.files, intervalMs: 3_600_000, log: logger() });
    await sync2.start();
    hung.fail({ method: 'GET', kind: 'delay', ms: 1_200, times: 1 });
    const t0 = Date.now();
    const late = await sync2.syncNow('shutdown', { force: true, deadlineMs: 150 });
    assert.deepEqual(late, { ok: false, timedOut: true });
    assert.ok(Date.now() - t0 < 800, 'resolved at the deadline');
    await sync2.idle(5_000); // (the process would have exited here; the test lets the late job finish)
    inst2.db.close();
  });

  it(`hourly history is pruned to the newest ${HISTORY_KEEP} hours`, async () => {
    const fake = await fakeStorage();
    // 50 older hours already in the bucket (each with two files).
    const base = Date.UTC(2026, 9, 10, 0);
    const old = [];
    for (let i = 0; i < 50; i++) {
      const h = hourKey(base + i * 3_600_000);
      old.push(h);
      fake.put(`history/${h}/bean.db.gz`, gz('x'));
      fake.put(`history/${h}/state-real.json.gz`, gz('{}'));
    }
    const inst = instanceDir();
    const c = clock(Date.UTC(2026, 9, 14, 5, 30));
    const log = logger();
    const sync = startCloudSync({ store: storeFor(fake), db: inst.db, files: inst.files, intervalMs: 3_600_000, now: c.now, log });
    await sync.start(); // 51 hours now → the 3 oldest go
    const hours = [...new Set([...fake.objects.keys()].filter((k) => k.startsWith(`${BUCKET}/history/`)).map((k) => k.split('/')[2]))].sort();
    assert.equal(hours.length, HISTORY_KEEP);
    assert.deepEqual(hours.slice(0, 2), old.slice(3, 5));
    assert.equal(hours.at(-1), '2026101405');
    for (const h of old.slice(0, 3)) assert.ok(!fake.has(`history/${h}/bean.db.gz`) && !fake.has(`history/${h}/state-real.json.gz`), h);
    assert.ok(log.lines.some((l) => /pruned 3 old hour/.test(l)));
    // Same hour again → no new history copy, no pruning.
    c.advance(60_000);
    inst.add(3);
    assert.deepEqual((await sync.syncNow('interval')).uploaded, ['db/bean.db.gz']);
    inst.db.close();
  });

  it('the admin bootstrap code: uploaded while no admin exists, deleted once one does; never when ADMIN_BOOTSTRAP_CODE is configured', async () => {
    const fake = await fakeStorage();
    const inst = instanceDir();
    fs.writeFileSync(inst.files.bootstrap.local, 'ABCDEFGHJKLM\n');
    let admin = false;
    const log = logger();
    const sync = startCloudSync({ store: storeFor(fake), db: inst.db, files: inst.files, intervalMs: 3_600_000, adminExists: () => admin, log });
    await sync.start();
    assert.equal(fake.get(BOOTSTRAP_REMOTE).toString(), 'ABCDEFGHJKLM\n');
    assert.ok(log.lines.some((l) => /bootstrap code is in the PRIVATE bucket/.test(l)));
    assert.ok(log.lines.every((l) => !l.includes('ABCDEFGHJKLM')), 'the code itself is never logged');
    assert.equal(sync.status().bootstrap_in_bucket, true);
    admin = true; // the first admin signed up
    await sync.syncNow('interval');
    assert.equal(fake.has(BOOTSTRAP_REMOTE), false);
    assert.equal(sync.status().bootstrap_in_bucket, false);
    assert.ok(log.lines.some((l) => /deleted the admin bootstrap code/.test(l)));
    inst.db.close();

    const fake2 = await fakeStorage();
    fake2.put(BOOTSTRAP_REMOTE, Buffer.from('OLDCODE00000\n'), 'text/plain');
    const inst2 = instanceDir();
    fs.writeFileSync(inst2.files.bootstrap.local, 'ABCDEFGHJKLM\n');
    const sync2 = startCloudSync({ store: storeFor(fake2), db: inst2.db, files: inst2.files, intervalMs: 3_600_000, bootstrapConfigured: true, log: logger() });
    await sync2.start();
    assert.equal(fake2.has(BOOTSTRAP_REMOTE), false, 'a configured code removes any stale generated one');
    inst2.db.close();
  });

  it('failures are logged once per streak (rate-limited), recovered, and reported by status(); the key never shows', async () => {
    const fake = await fakeStorage();
    const inst = instanceDir();
    const c = clock();
    const log = logger();
    const sync = startCloudSync({ store: storeFor(fake, { retries: 0 }), db: inst.db, files: inst.files, intervalMs: 3_600_000, now: c.now, log });
    await sync.start();
    fake.fail({ method: 'GET', path: `/storage/v1/object/${BUCKET}/${LEASE_PATH}`, status: 502, times: 3, body: `upstream ${KEY}` });
    for (let i = 0; i < 3; i++) {
      c.advance(60_000);
      const r = await sync.syncNow('interval');
      assert.equal(r.ok, false);
    }
    assert.equal(log.lines.filter((l) => /ALERT sync failed/.test(l)).length, 1, 'one line for the streak within 10 minutes');
    c.advance(11 * 60_000);
    fake.fail({ method: 'GET', path: `/storage/v1/object/${BUCKET}/${LEASE_PATH}`, status: 502, times: 1 });
    await sync.syncNow('interval');
    assert.equal(log.lines.filter((l) => /ALERT sync failed/.test(l)).length, 2, 'then again after 10 minutes');
    const st = sync.status();
    assert.equal(st.failures, 4);
    assert.match(st.last_error, /HTTP 502/);
    c.advance(60_000);
    assert.equal((await sync.syncNow('interval')).ok, true);
    assert.ok(log.lines.some((l) => /recovered after 4 failure/.test(l)));
    const shown = JSON.stringify(sync.status());
    assert.ok(!shown.includes(KEY) && !shown.includes(fake.base), 'status() carries no key and no URL');
    inst.db.close();
  });

  it('a bucket made PUBLIC later stops every upload (ALERT, re-checked every sync) until it is private again', async () => {
    const fake = await fakeStorage();
    const inst = instanceDir();
    const c = clock();
    const log = logger();
    const sync = startCloudSync({ store: storeFor(fake), db: inst.db, files: inst.files, intervalMs: 3_600_000, now: c.now, log });
    await sync.start();
    fake.buckets.get(BUCKET).public = true; // someone flips the switch in the dashboard
    inst.add(2);
    c.ms = Date.UTC(2026, 9, 14, 6, 0, 30); // the hourly re-check
    const ups = fake.uploads().length;
    assert.deepEqual(await sync.syncNow('interval'), { ok: false, skipped: 'bucket_public', uploaded: [] });
    c.advance(60_000);
    assert.equal((await sync.syncNow('interval')).skipped, 'bucket_public', 're-checked every sync while public');
    assert.equal(fake.uploads().length, ups, 'nothing uploaded into a public bucket');
    assert.equal(sync.status().bucket_public, true);
    assert.equal(log.lines.filter((l) => /ALERT .* is PUBLIC: uploads are stopped/.test(l)).length, 1);
    fake.buckets.get(BUCKET).public = false;
    c.advance(60_000);
    const r = await sync.syncNow('interval');
    assert.ok(r.uploaded.includes('db/bean.db.gz'));
    assert.deepEqual(cloudRows(fake), [1, 2]);
    assert.ok(log.lines.some((l) => /is private again: uploads resume/.test(l)));
    inst.db.close();
  });
});

// ---------------------------------------------------------------------------------------------
// The replay guard: a DB restored NEWER than the engine state never re-mirrors bars the bots already traded.

describe('restore skew: engine state older than the gardens (DB every minute, state hourly)', () => {
  const cfg = { seed: 7, beans: 300, warmupBars: 300, tickMs: 60_000, log: quiet };

  async function app(dir, saved = null) {
    const db = openDb({ file: path.join(dir, 'bean-sim.db') });
    migrate(db, MIGRATIONS_DIR, { backupDir: path.join(dir, 'backups') });
    const journal = new Journal({ scoped: true, globalKinds: GLOBAL_KINDS, keep: 200, log: quiet });
    const engine = new Engine({ config: cfg, journal });
    if (saved) {
      journal.restore(saved.journal);
      engine.restore(saved.engine);
    }
    // The gardens' [live] lines join the sanitizer check below.
    const gardens = new Gardens({ engine, journal, db, log: (l) => { if (String(l).startsWith('[live]')) ALL_LOGS.push(String(l)); } });
    await gardens.init();
    const { wireAccounts } = await import('../server/main.js');
    wireAccounts({ engine, gardens, pulse: new Pulse({ scoped: true, log: quiet }) });
    await engine.start();
    return { db, journal, engine, gardens };
  }
  const fills = (db) => db.prepare('SELECT count(*) AS n FROM fills').get().n;
  const positions = (a, uids) => uids.map((u) => a.gardens.get(u, { touch: false }).bots({ state: 'all', limit: 100 }).rows
    .map((b) => [b.id, b.real?.szi, Math.round((b.realized_pnl ?? 0) * 1e6)]));

  it('replaying bars the DB already reflects adds no fill; the next bar matches the continuous run', async () => {
    const a = await app(tmpDir());
    const now = Date.now();
    const uids = ['alice', 'bob'].map((name) => Number(a.db.prepare('INSERT INTO users (username, pw_hash, created_ms, updated_ms, pw_changed_ms) VALUES (?, ?, ?, ?, ?)')
      .run(name, 'scrypt$test', now, now, now).lastInsertRowid));
    const { rows } = a.engine.population.query({ busted: false, sort: 'fitness', limit: 3000 });
    for (const uid of uids) {
      const g = a.gardens.get(uid);
      const coins = new Set();
      for (const r of rows) {
        if (coins.has(r.coin) || r.venue_reason) continue;
        try {
          g.create({ bean: r.id, capital_usd: 1000 });
          coins.add(r.coin);
        } catch {
          // a bean the caps refuse: take the next one
        }
        if (coins.size >= 10) break;
      }
    }
    a.engine.tick();
    a.gardens.flush();
    const stateAtS = structuredClone({ engine: a.engine.serialize(), journal: a.journal.serialize() }); // state/ (hourly)
    const f0 = fills(a.db);
    const K = 30;
    for (let i = 0; i < K; i++) a.engine.tick();
    a.gardens.flush();
    const fK = fills(a.db);
    assert.ok(fK > f0, `the bots traded in the skew window (${fK - f0} fills)`);
    const dirB = tmpDir();
    const { backupDb } = await import('../server/db/backup.js');
    await backupDb(a.db, path.join(dirB, 'bean-sim.db')); // db/ (every minute): the gardens at S+K
    a.engine.tick();
    a.gardens.flush();
    const continuous = positions(a, uids);

    // Restore: engine@S + DB@S+K. The engine replays S+1..S+K; the gardens must not trade them again.
    const S = stateAtS.engine.tick;
    const b = await app(dirB, stateAtS);
    assert.equal(b.engine.restoredTick, S);
    const gs = uids.map((u) => b.gardens.get(u, { touch: false }));
    const guards = gs.map((g) => g.replayGuardTick);
    // Armed at each garden's stored watermark (its last write: a fill, an error or a command), never beyond S+K.
    assert.ok(guards.some((t) => t !== null), `at least one garden is ahead of the engine (${guards})`);
    assert.ok(guards.every((t) => t === null || (t > S && t <= S + K)), String(guards));
    const before = fills(b.db);
    assert.equal(before, fK);
    for (let i = 0; i < K; i++) b.engine.tick();
    b.gardens.flush();
    assert.equal(fills(b.db), before, 'no phantom fill for the replayed bars');
    b.engine.tick();
    b.gardens.flush();
    gs.forEach((g, i) => {
      assert.equal(g.replayGuardTick, null, 'the first newer bar disarms the guard');
      assert.equal(g.replaySkipped, guards[i] === null ? 0 : guards[i] - S);
    });
    assert.deepEqual(positions(b, uids), continuous, 'positions and realized P&L equal the continuous run');

    // A fresh engine (no restore) never arms the guard, whatever the DB says.
    const dirC = tmpDir();
    await backupDb(b.db, path.join(dirC, 'bean-sim.db'));
    const fresh = await app(dirC);
    assert.equal(fresh.engine.restoredTick, null);
    assert.equal(fresh.gardens.get(uids[0], { touch: false }).replayGuardTick, null);
    for (const x of [a, b, fresh]) x.db.close();
    assert.ok(REPLAY_GUARD_MAX_BARS >= 2 * 60);
  });

  it('the watermark is the engine\'s tick even for a garden loaded later (a command never writes an older tick)', async () => {
    const a = await app(tmpDir());
    for (let i = 0; i < 12; i++) a.engine.tick();
    const now = Date.now();
    const uid = Number(a.db.prepare('INSERT INTO users (username, pw_hash, created_ms, updated_ms, pw_changed_ms) VALUES (?, ?, ?, ?, ?)')
      .run('carol', 'scrypt$test', now, now, now).lastInsertRowid);
    const g = a.gardens.get(uid);
    const bean = a.engine.population.query({ in_position: true, busted: false, sort: 'fitness', limit: 50 }).rows.find((r) => !r.venue_reason);
    g.create({ bean: bean.id, capital_usd: 1000 });
    a.gardens.flush();
    assert.equal(a.db.prepare('SELECT last_tick FROM gardens WHERE user_id = ?').get(uid).last_tick, a.engine.ticks);
    a.db.close();
  });
});

describe('cloud config (server/config.js)', () => {
  const ACC = { BEAN_AUTH: 'accounts', PUBLIC_ORIGIN: 'https://bean-garden.onrender.com' };
  const URL_OK = 'https://abcdefghijklmnop.supabase.co';
  const ok = (env) => parsePlatformConfig({ values: {}, env });
  const refused = (env, re) => assert.throws(() => parsePlatformConfig({ values: {}, env }),
    (err) => err instanceof PlatformConfigError && err.exitCode === 2 && re.test(err.message) && !err.message.includes(KEY), String(re));

  it('both SUPABASE_URL and the key → enabled with the defaults; the key is read once, deleted from env, never enumerable', () => {
    const env = { ...ACC, SUPABASE_URL: `${URL_OK}/`, SUPABASE_SERVICE_ROLE_KEY: KEY };
    const cfg = ok(env);
    assert.deepEqual(cfg.cloud, { url: URL_OK, bucket: 'bean-garden', prefix: '', syncSeconds: 60, allowFresh: false, egressBudgetMb: 3072 });
    assert.equal(cfg.secrets.cloudKey, KEY);
    assert.ok(!('SUPABASE_SERVICE_ROLE_KEY' in env), 'deleted from the env');
    assert.ok(SECRET_VARS.includes('SUPABASE_SERVICE_ROLE_KEY'));
    assert.ok(!JSON.stringify(cfg).includes(KEY), 'not enumerable');
    const file = path.join(tmpDir(), 'supabase_key');
    fs.writeFileSync(file, `${KEY}\n`);
    const env2 = {
      ...ACC, SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY_FILE: file, CLOUD_STORE_BUCKET: 'my.bucket_1', CLOUD_STORE_PREFIX: '/bean/prod/',
      CLOUD_SYNC_SECONDS: '15', CLOUD_ALLOW_FRESH: '1', CLOUD_EGRESS_BUDGET_MB: '4500',
    };
    const cfg2 = ok(env2);
    assert.deepEqual(cfg2.cloud, { url: URL_OK, bucket: 'my.bucket_1', prefix: 'bean/prod/', syncSeconds: 15, allowFresh: true, egressBudgetMb: 4500 });
    assert.equal(cfg2.secrets.cloudKey, KEY);
    assert.ok(!('SUPABASE_SERVICE_ROLE_KEY_FILE' in env2));
    assert.equal(ok({ ...ACC }).cloud, null, 'not configured → null');
    assert.equal(ok({ ...ACC }).secrets.cloudKey, null);
  });

  it('partial or invalid configuration is refused (exit 2), naming the variable and never the value', () => {
    refused({ ...ACC, SUPABASE_URL: URL_OK }, /half configured: SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY/);
    refused({ ...ACC, SUPABASE_SERVICE_ROLE_KEY: KEY }, /half configured: SUPABASE_SERVICE_ROLE_KEY is set but SUPABASE_URL/);
    refused({ ...ACC, CLOUD_STORE_BUCKET: 'bean-garden' }, /CLOUD_STORE_BUCKET needs cloud persistence/);
    refused({ ...ACC, CLOUD_SYNC_SECONDS: '60' }, /CLOUD_SYNC_SECONDS needs cloud persistence/);
    refused({ ...ACC, CLOUD_ALLOW_FRESH: '1' }, /CLOUD_ALLOW_FRESH needs cloud persistence/);
    refused({ ...ACC, CLOUD_EGRESS_BUDGET_MB: '3072' }, /CLOUD_EGRESS_BUDGET_MB needs cloud persistence/);
    for (const bad of ['http://abc.supabase.co', 'https://abc.supabase.co/rest/v1', 'https://abc.supabase.co?x=1', 'https://u:p@abc.supabase.co', 'abc.supabase.co', '']) {
      refused({ ...ACC, SUPABASE_URL: bad, SUPABASE_SERVICE_ROLE_KEY: KEY }, /SUPABASE_URL/);
    }
    refused({ ...ACC, SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: 'short' }, /SUPABASE_SERVICE_ROLE_KEY must be/);
    refused({ ...ACC, SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: '' }, /SUPABASE_SERVICE_ROLE_KEY is set but empty/);
    refused({ ...ACC, SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: KEY, SUPABASE_SERVICE_ROLE_KEY_FILE: '/x' }, /set only one/);
    refused({ ...ACC, SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: KEY, CLOUD_STORE_BUCKET: 'Bad Name' }, /CLOUD_STORE_BUCKET/);
    refused({ ...ACC, SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: KEY, CLOUD_STORE_PREFIX: 'a/../b' }, /CLOUD_STORE_PREFIX/);
    refused({ ...ACC, SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: KEY, CLOUD_SYNC_SECONDS: '5' }, /CLOUD_SYNC_SECONDS must be an integer between 15 and 3600/);
    refused({ ...ACC, SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: KEY, CLOUD_ALLOW_FRESH: 'yes' }, /CLOUD_ALLOW_FRESH must be 0 or 1/);
    refused({ ...ACC, SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: KEY, CLOUD_EGRESS_BUDGET_MB: '10' }, /CLOUD_EGRESS_BUDGET_MB must be an integer between 100/);
    const env = { ...ACC, SUPABASE_URL: 'http://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY };
    assert.throws(() => parsePlatformConfig({ values: {}, env }));
    assert.ok(!('SUPABASE_SERVICE_ROLE_KEY' in env), 'deleted even when the config is refused');
  });

  it('none mode refuses every cloud variable (accounts-only); RENDER_EXTERNAL_URL is never refused', () => {
    for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY_FILE', 'CLOUD_STORE_BUCKET', 'CLOUD_STORE_PREFIX',
      'CLOUD_SYNC_SECONDS', 'CLOUD_ALLOW_FRESH', 'CLOUD_EGRESS_BUDGET_MB']) {
      assert.ok(ACCOUNTS_ONLY_VARS.includes(name), name);
      refused({ [name]: 'x' }, new RegExp(`${name} is an accounts-mode setting`));
    }
    assert.deepEqual(ok({ RENDER_EXTERNAL_URL: 'https://bean-garden.onrender.com' }), { auth: 'none' });
  });

  it('Render: its injected PORT wins over the image default; HOST=0.0.0.0 is read; RENDER_EXTERNAL_URL is the default public origin', async () => {
    const { parseConfig } = await import('../server/main.js');
    const cfg = parseConfig(['--auth', 'accounts'], { ...ACC, PORT: '10000', HOST: '0.0.0.0', BEAN_FEED: 'hyperliquid', TESTNET_ENABLED: '0', SIGNUP_MODE: 'closed', TRUST_PROXY: '1' });
    assert.equal(cfg.port, 10000);
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.signupMode, 'closed');
    assert.equal(cfg.trustProxy, 1);
    assert.equal(cfg.testnetEnabled, false);
    assert.equal(cfg.cloud, null);
    const withBoot = parseConfig(['--auth', 'accounts'], { ...ACC, ADMIN_BOOTSTRAP_CODE: 'my-first-admin-code-42', SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: KEY });
    assert.equal(withBoot.secrets.bootstrapCode, 'my-first-admin-code-42', 'Render has no shell: the operator sets the bootstrap code');
    assert.equal(withBoot.cloud.url, URL_OK);
    // No PUBLIC_ORIGIN: Render's own URL for the service (a renamed service never answers 421 everywhere).
    const viaRender = parseConfig(['--auth', 'accounts'], { BEAN_AUTH: 'accounts', RENDER_EXTERNAL_URL: 'https://bean-garden-x1y2.onrender.com' });
    assert.equal(viaRender.publicOrigin, 'https://bean-garden-x1y2.onrender.com');
    const both = parseConfig(['--auth', 'accounts'], { ...ACC, RENDER_EXTERNAL_URL: 'https://bean-garden-x1y2.onrender.com' });
    assert.equal(both.publicOrigin, 'https://bean-garden.onrender.com', 'an explicit PUBLIC_ORIGIN wins (main() logs the mismatch)');
    assert.throws(() => parseConfig(['--auth', 'accounts'], { BEAN_AUTH: 'accounts', RENDER_EXTERNAL_URL: 'http://evil.example' }), /RENDER_EXTERNAL_URL may use http: only for localhost/);
  });

  it('with cloud persistence a fresh real start that cannot warm up does NOT fall back to sim (its accounts would live in bean-sim.db)', async () => {
    const { parseConfig, startWithFallback } = await import('../server/main.js');
    const dir = tmpDir();
    const hl = makeHL({ ms: Date.now() });
    hl.down = true;
    const config = { ...parseConfig(['--data', dir, '--beans', '60', '--warmup', '90'], {}), fetch: hl.fetch };
    await assert.rejects(startWithFallback({ config, version: 't', log: quiet, fallback: false }), (err) => err instanceof FeedUnavailableError);
    assert.ok(!fs.existsSync(path.join(dir, 'state.json')), 'nothing of the sim feed was created');
  });
});

describe('egress guard: the Supabase Storage allowance (T-GUARD unchanged)', () => {
  const ORIGIN = 'https://abcdefghijklmnop.supabase.co';

  it('only GET/POST/DELETE to <SUPABASE_URL>/storage/v1/… — other Supabase paths, hosts, schemes and tricks stay blocked', () => {
    assert.equal(EGRESS_ALLOW.length, 3, 'the Hyperliquid list is unchanged');
    for (const [u, m] of [
      [`${ORIGIN}/storage/v1/object/bean-garden/db/bean.db.gz`, 'GET'],
      [`${ORIGIN}/storage/v1/object/bean-garden/db/bean.db.gz`, 'POST'],
      [`${ORIGIN}/storage/v1/object/list/bean-garden`, 'POST'],
      [`${ORIGIN}/storage/v1/object/copy`, 'POST'],
      [`${ORIGIN}/storage/v1/object/bean-garden`, 'DELETE'],
      [`${ORIGIN}/storage/v1/bucket/bean-garden`, 'get'],
    ]) {
      assert.equal(isAllowedEgress(u, m, { storageOrigin: ORIGIN }), true, `${m} ${u}`);
      assert.equal(isAllowedEgress(u, m), false, `without the option: ${m} ${u}`);
    }
    for (const [u, m] of [
      [`${ORIGIN}/storage/v1/object/bean-garden/x`, 'PUT'],
      [`${ORIGIN}/storage/v1/object/bean-garden/x`, 'PATCH'],
      [`${ORIGIN}/storage/v1/object/bean-garden/x`, undefined],
      [`${ORIGIN}/rest/v1/users`, 'GET'],
      [`${ORIGIN}/auth/v1/admin/users`, 'GET'],
      [`${ORIGIN}/functions/v1/x`, 'POST'],
      [`${ORIGIN}/storage/v1/`, 'GET'],
      [`${ORIGIN}/storage/v2/object/x`, 'GET'],
      [`${ORIGIN}/storage/v1/../rest/v1/users`, 'GET'],
      [`${ORIGIN}/storage/v1/%2e%2e/rest/v1/users`, 'GET'],
      [`${ORIGIN}/storage/v1/object/a%2fb`, 'GET'],
      [`${ORIGIN}/storage/v1/object/x?token=abc`, 'GET'],
      [`${ORIGIN}/storage/v1/object/x#frag`, 'GET'],
      [`${ORIGIN}/storage/v1\\object\\x`, 'GET'],
      [`http://abcdefghijklmnop.supabase.co/storage/v1/object/x`, 'GET'],
      [`https://other.supabase.co/storage/v1/object/x`, 'GET'],
      [`https://abcdefghijklmnop.supabase.co.evil.example/storage/v1/object/x`, 'GET'],
      [`https://user:pw@abcdefghijklmnop.supabase.co/storage/v1/object/x`, 'GET'],
      [`https://abcdefghijklmnop.supabase.co:8443/storage/v1/object/x`, 'GET'],
      ['https://example.com/storage/v1/object/x', 'POST'],
    ]) assert.equal(isAllowedEgress(u, m, { storageOrigin: ORIGIN }), false, `${m} ${u}`);
    assert.equal(isAllowedStorageEgress(`${ORIGIN}/storage/v1/object/x`, 'GET', null), false);
    // The Hyperliquid rules are unchanged with the option set.
    for (const u of EGRESS_ALLOW) {
      assert.equal(isAllowedEgress(u, 'POST', { storageOrigin: ORIGIN }), true);
      assert.equal(isAllowedEgress(u, 'GET', { storageOrigin: ORIGIN }), false);
    }
    assert.equal(isAllowedEgress(['https://api.hyperliquid', '.xyz', '/exchange'].join(''), 'POST', { storageOrigin: ORIGIN }), false);
  });

  it('installEgressGuard({storageOrigin}) lets the store through (redirect:"error" forced) and nothing more; a bad origin is refused', async () => {
    assert.throws(() => installEgressGuard({ storageOrigin: 'http://abc.supabase.co' }), TypeError);
    assert.throws(() => installEgressGuard({ storageOrigin: `${ORIGIN}/storage` }), TypeError);
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push([String(input), init]);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const logs = [];
    const uninstall = installEgressGuard({ log: (l) => logs.push(l), storageOrigin: ORIGIN });
    try {
      assert.equal(installEgressGuard({ storageOrigin: 'https://evil.supabase.co' }), uninstall, 'idempotent: the first origin stays');
      const store = createCloudStore({ url: ORIGIN, key: KEY, bucket: BUCKET, backoffMs: 1 });
      assert.deepEqual(await store.list('history'), []);
      await store.copy('db/bean.db.gz', 'history/2026101405/bean.db.gz');
      assert.equal(calls.length, 2);
      assert.ok(calls.every(([, init]) => init.redirect === 'error'));
      assert.equal(calls[1][0], `${ORIGIN}/storage/v1/object/copy`);
      await assert.rejects(fetch(`${ORIGIN}/rest/v1/users`), (err) => err.code === 'egress_denied');
      await assert.rejects(fetch('https://evil.supabase.co/storage/v1/object/x'), (err) => err.code === 'egress_denied');
      const evil = createCloudStore({ url: 'https://evil.supabase.co', key: KEY, bucket: BUCKET, backoffMs: 1, retries: 3 });
      await assert.rejects(evil.download('x'), (err) => err.code === 'network' && /egress_denied/.test(err.message));
      assert.equal(calls.length, 2, 'denied requests never reached the network (and are not retried)');
      assert.ok(logs.every((l) => !l.includes(KEY)));
    } finally {
      uninstall();
      globalThis.fetch = realFetch;
    }
  });
});

describe('Render specifics', () => {
  it('GET /healthz answers any Host (Render\'s checker uses an internal one); /readyz and the API keep the Host check', () => {
    const ORIGIN = 'https://bean-garden.onrender.com';
    const at = (pathname, host, method = 'GET') => hostOk({ method, headers: { host } }, { publicOrigin: ORIGIN, port: 10000, pathname });
    assert.equal(at('/healthz', '10.214.3.7:10000'), null);
    assert.equal(at('/healthz', 'srv-abc123:10000', 'HEAD'), null);
    assert.equal(at('/healthz', 'evil.example', 'POST')?.status, 421);
    assert.equal(at('/readyz', 'srv-abc123:10000')?.status, 421);
    assert.equal(at('/api/v1/health', 'evil.example')?.status, 421);
    assert.equal(at('/api/v1/beans', 'bean-garden.onrender.com'), null);
  });

  it('behind a proxy, ONE diagnose line describes the first forwarded request (counts and header names, never an address)', () => {
    const all = [];
    const logs = [];
    const resolve = createClientIp({ trustProxy: 1, log: (l) => { all.push(l); ALL_LOGS.push(l); if (/first request through a trusted proxy/.test(l)) logs.push(l); }, diagnose: true });
    const at = (peer, headers) => ({ headers, socket: { remoteAddress: peer } });
    resolve(at('10.0.0.5', {})); // a health check: nothing forwarded → no diagnose line (only the existing short-XFF note)
    assert.equal(logs.length, 0);
    assert.equal(all.length, 1);
    assert.match(all[0], /fewer than TRUST_PROXY=1/);
    const r = resolve(at('10.0.0.5', { 'x-forwarded-for': '198.51.100.23', 'true-client-ip': '198.51.100.23', 'cf-connecting-ip': '198.51.100.23' }));
    assert.deepEqual([r.ip, r.source], ['198.51.100.23', 'xff']);
    resolve(at('10.0.0.5', { 'x-forwarded-for': '203.0.113.9, 172.70.1.2' }));
    assert.equal(logs.length, 1, 'once');
    assert.match(logs[0], /X-Forwarded-For has 1 entry; client IP taken from X-Forwarded-For entry 1 from the right \(TRUST_PROXY=1\)/);
    assert.match(logs[0], /cf-connecting-ip \(same as the chosen address\), true-client-ip \(same as the chosen address\)/);
    assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(logs[0]), 'no address is logged');
    // A chain where the rightmost entry is an edge hop: the line says the edge header DIFFERS → fix TRUST_PROXY.
    const logs2 = [];
    createClientIp({ trustProxy: 1, log: (l) => logs2.push(l), diagnose: true })(at('10.0.0.5', { 'x-forwarded-for': '198.51.100.23, 172.70.1.2', 'cf-connecting-ip': '198.51.100.23' }));
    assert.match(logs2[0], /has 2 entries.*cf-connecting-ip \(DIFFERENT from the chosen address\)/);
    // Without `diagnose` (the default) nothing new is logged.
    const quietLog = [];
    createClientIp({ trustProxy: 1, log: (l) => quietLog.push(l) })(at('10.0.0.5', { 'x-forwarded-for': '198.51.100.23' }));
    assert.deepEqual(quietLog, []);
  });

  it('a proxy peer OUTSIDE TRUSTED_PROXY_CIDRS (e.g. 100.64.0.0/10) is reported once, without addresses: its X-Forwarded-For is ignored', () => {
    const lines = [];
    const resolve = createClientIp({ trustProxy: 1, log: (l) => { lines.push(l); ALL_LOGS.push(l); }, diagnose: true });
    const at = (peer, headers) => ({ headers, socket: { remoteAddress: peer } });
    const r = resolve(at('100.64.12.7', { 'x-forwarded-for': '198.51.100.23' }));
    assert.deepEqual([r.ip, r.source], ['100.64.12.7', 'socket'], 'the forwarded address is ignored');
    resolve(at('100.64.12.8', { 'x-forwarded-for': '203.0.113.9' }));
    const warned = lines.filter((l) => /proxy peer not in TRUSTED_PROXY_CIDRS/.test(l));
    assert.equal(warned.length, 1, 'once');
    assert.match(warned[0], /IPv4 socket address.*every client shares that address/);
    assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(warned[0]), 'no address is logged');
    // With the range trusted, the client address is used.
    const fixed = createClientIp({ trustProxy: 1, trustedCidrs: ['100.64.0.0/10'], log: quiet, diagnose: true });
    assert.equal(fixed(at('100.64.12.7', { 'x-forwarded-for': '198.51.100.23' })).ip, '198.51.100.23');
    // TRUST_PROXY=0 (no proxy configured): nothing to report.
    const none = [];
    createClientIp({ trustProxy: 0, log: (l) => none.push(l), diagnose: true })(at('100.64.12.7', { 'x-forwarded-for': '1.2.3.4' }));
    assert.deepEqual(none, []);
  });

  it('prepareCloud (main.js composition): checks the bucket, restores into the data dir before the DB is opened, and continues the journal seq', async () => {
    const fake = await fakeStorage({ bucketExists: false });
    const { parseConfig, prepareCloud, CLOUD_SEQ_MARGIN } = await import('../server/main.js');
    const dir = tmpDir();
    const config = parseConfig(['--auth', 'accounts', '--data', dir], {
      BEAN_AUTH: 'accounts', PUBLIC_ORIGIN: 'https://bean-garden.onrender.com', SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY,
    });
    // Point the https origin at the local fake (tests only).
    const viaFake = (url, init) => realFetch(String(url).replace('https://abcdefghijklmnop.supabase.co', fake.base), init);
    const first = await prepareCloud({ config, log: logger(), fetch: viaFake });
    assert.deepEqual(fake.buckets.get(BUCKET), { public: false }, 'created private');
    assert.deepEqual(fs.readdirSync(dir), [], 'first boot: nothing to restore');
    assert.equal(first.seqFloor, null);
    assert.equal(first.filesFor(config).db.remote, 'db/bean.db.gz');
    assert.equal(first.filesFor({ ...config, feed: 'sim' }).state.remote, 'state/state.json.gz');
    fake.put('db/bean.db.gz', zlib.gzipSync(sqliteBytes(2)));
    fake.put('state/state-real.json.gz', gz('{"version":1}'));
    fake.put(LEASE_PATH, Buffer.from(JSON.stringify({ v: 2, instance: 'previous', seq: 5000, synced: true })), 'application/json');
    const second = await prepareCloud({ config, log: logger(), fetch: viaFake });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['bean.db', 'state-real.json']);
    assert.equal(second.seqFloor, 5000 + CLOUD_SEQ_MARGIN);
    // The journal jumps past it: a seq the previous instance may have sent is never reused; older Last-Event-IDs resync.
    const j = new Journal({ log: quiet });
    j.restore({ seq: 4900, records: [{ seq: 4900, kind: 'tick_completed' }] });
    assert.equal(j.advanceSeq(second.seqFloor), 15_000);
    assert.equal(j.emit('feed_status', { state: 'live' }).seq, 15_001);
    assert.deepEqual(j.sinceFor(null, 4950), { resync: true });
    assert.equal(j.advanceSeq(10), 15_001, 'never backwards');
    // A configured bootstrap code: an old generated one in the bucket is not brought back.
    fake.put(BOOTSTRAP_REMOTE, Buffer.from('OLDCODE00000\n'), 'text/plain');
    const dir2 = tmpDir();
    const cfg2 = parseConfig(['--auth', 'accounts', '--data', dir2], {
      BEAN_AUTH: 'accounts', PUBLIC_ORIGIN: 'https://bean-garden.onrender.com', SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: KEY, ADMIN_BOOTSTRAP_CODE: 'my-first-admin-code-42',
    });
    await prepareCloud({ config: cfg2, log: logger(), fetch: viaFake });
    assert.ok(!fs.existsSync(path.join(dir2, 'admin-bootstrap.txt')));
  });
});

describe('log lines stay readable (the secrets sanitizer must not blank an operator line)', () => {
  it('every cloud / clientip / live / shutdown / config line of this suite passes sanitizeLogLine unchanged', async () => {
    const { cloudShutdownLine, publicOriginAlert } = await import('../server/main.js');
    assert.ok(ALL_LOGS.some((l) => /^\[live\] garden \d+: skipped \d+ replayed bar\(s\) already mirrored before the restart$/.test(l)));
    const lines = [
      ...ALL_LOGS,
      publicOriginAlert('https://bean-garden.onrender.com', 'https://bean-garden-x1y2.onrender.com'),
      cloudShutdownLine({ ok: true, uploaded: ['db/bean.db.gz', 'state/state-real.json.gz'] }),
      cloudShutdownLine({ ok: false, timedOut: true }),
      cloudShutdownLine({ ok: false, skipped: 'lease_standby' }),
      cloudShutdownLine({ ok: false, skipped: 'bucket_public' }),
      cloudShutdownLine({ ok: false, error: 'cloud upload bean-garden/db/bean.db.gz: HTTP 503 upstream unavailable' }),
    ];
    assert.ok(lines.length > 40);
    for (const line of lines) assert.equal(sanitizeLogLine(line), line, line);
    assert.match(cloudShutdownLine({ timedOut: true }), /ALERT final_sync deadline_hit/);
    // The old wording was blanked to "[words]" by the seed-phrase rule: that is what this test guards against.
    assert.match(sanitizeLogLine('[cloud] ALERT final sync hit its deadline: the bucket keeps the previous sync (at most one interval old)'), /\[words\]/);
  });
});

describe('secrets', () => {
  it('the key never appeared in any log line of this suite', () => {
    assert.ok(ALL_LOGS.length > 10, 'the suite logged');
    for (const line of ALL_LOGS) assert.ok(!line.includes(KEY), line);
  });
});

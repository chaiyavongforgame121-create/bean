// test/api-accounts.test.js — the accounts-mode HTTP API (PLATFORM §4.4, §4.5, §8, §10.4) and the none-mode
// additions (§8.8), against the REAL engine, scoped journal and pulse, and the REAL WP1 platform modules (SQLite DB,
// migrations, Users, Sessions, request guard, rate limiter, client IP, stream slots, Admin, Secrets).
//
// Gardens: WP3's server/garden/gardens.js is wired by main.js; this file uses a small in-test Gardens built from real
// LiveLayer instances (one per player, each with its journal.forUser(uid) facade), which is exactly the §7.2 surface
// http.js calls. Testnet: a fake TestnetMarket / verifier that COUNTS any Hyperliquid call, so "cache only" is proven.
//
// Everything is offline: requests go to 127.0.0.1 with an explicit Host header (the public origin is
// http://localhost:8464, so the Host check runs as in production).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { Engine } from '../server/engine.js';
import { Journal, GLOBAL_KINDS } from '../server/journal.js';
import { LiveLayer } from '../server/live.js';
import { Pulse } from '../server/pulse.js';
import { createServer, parseAgentKey, bucketKeyFor, TokenBuckets, RATE_LIMITS } from '../server/http.js';
import { OPS, ERROR_CODES, NONE_MODE_CODES, findOp } from '../server/catalog.js';
import { openDb, MIGRATIONS_DIR } from '../server/db/db.js';
import { migrate } from '../server/db/migrate.js';
import { PasswordHasher } from '../server/auth/passwords.js';
import { Users } from '../server/auth/users.js';
import { Sessions } from '../server/auth/sessions.js';
import { createRequestGuard } from '../server/auth/csrf.js';
import { RateLimiter, StreamSlots } from '../server/auth/ratelimit.js';
import { createClientIp } from '../server/auth/clientip.js';
import { Secrets } from '../server/secrets.js';
import { Admin } from '../server/admin.js';
import { Credentials } from '../server/garden/credentials.js';
import { AuthService } from '../server/auth/service.js';

const quiet = () => {};
const PORT_NAME = 8464;
const ORIGIN = `http://localhost:${PORT_NAME}`;
const HOST = `localhost:${PORT_NAME}`;
const ADMIN_TOKEN = 'a'.repeat(20) + crypto.randomBytes(16).toString('hex'); // ≥ 32 chars, test-only
const BOOT_CODE = 'BOOTSTRAP-CODE-0001';
const PW = 'correct horse battery 42';
const seenCodes = new Set();

// ---------------------------------------------------------------------------------------------
// HTTP helpers

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (/json/.test(res.headers['content-type'] ?? '')) {
          try { json = JSON.parse(text); } catch { /* leave null */ }
        }
        if (res.statusCode >= 400 && json && typeof json.code === 'string') seenCodes.add(json.code);
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** A browser-like client: same-origin Origin on POSTs, JSON bodies, and a cookie jar fed by Set-Cookie. */
function client(port, { host = HOST, origin = ORIGIN } = {}) {
  const jar = new Map();
  const c = {
    jar,
    cookieHeader: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    async req({ method = 'GET', path: p, body, headers = {} }) {
      const h = { Host: host, ...headers };
      if (jar.size && h.Cookie === undefined) h.Cookie = c.cookieHeader();
      if (method === 'POST') {
        if (h.Origin === undefined && origin) h.Origin = origin;
        if (h['Content-Type'] === undefined) h['Content-Type'] = 'application/json';
      }
      for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
      const r = await request(port, { method, path: p, headers: h, body });
      for (const sc of [].concat(r.headers['set-cookie'] ?? [])) {
        const [pair] = sc.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        if (/max-age=0\b/i.test(sc) || value === '') jar.delete(name);
        else jar.set(name, value);
      }
      return r;
    },
    get: (op, headers) => c.req({ path: `/api/v1/${op}`, headers }),
    post: (op, body = {}, headers) => c.req({ method: 'POST', path: `/api/v1/${op}`, body, headers }),
  };
  return c;
}

/** Open the SSE stream with full header control; the handle accumulates text and can wait for a predicate. */
function openStream(port, { headers = {}, query = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/api/v1/events/stream${query}`, headers: { Host: HOST, ...headers }, agent: false }, (res) => {
      res.setEncoding('utf8');
      const s = { res, req, text: '', ended: false, waiters: new Set() };
      res.on('data', (chunk) => {
        s.text += chunk;
        for (const w of [...s.waiters]) w();
      });
      res.on('end', () => {
        s.ended = true;
        for (const w of [...s.waiters]) w();
      });
      res.on('error', () => {});
      s.until = (pred, ms = 4000) => new Promise((ok, fail) => {
        const check = () => {
          if (!pred(s)) return;
          done();
          ok(s.text);
        };
        const timer = setTimeout(() => {
          done();
          fail(new Error(`SSE wait timed out; received:\n${s.text.slice(-600)}`));
        }, ms);
        const done = () => {
          clearTimeout(timer);
          s.waiters.delete(check);
        };
        s.waiters.add(check);
        check();
      });
      s.close = () => req.destroy();
      resolve(s);
    });
    req.on('error', reject);
  });
}

function sseFrames(text) {
  const frames = [];
  for (const block of text.split('\n\n')) {
    const f = {};
    for (const line of block.split('\n')) {
      const m = /^(id|event|data): (.*)$/.exec(line);
      if (m) f[m[1]] = m[1] === 'data' ? JSON.parse(m[2]) : m[2];
    }
    if (f.event) frames.push(f);
  }
  return frames;
}
const framesOf = (s, kind) => sseFrames(s.text).filter((f) => f.event === kind);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// The platform: real WP1 modules + a minimal Gardens over real LiveLayers

/** In-memory user-record store for the scoped journal (the DB `events` table in production). */
function memUserStore() {
  const rows = [];
  const match = (uid, kinds) => (r) => r.uid === uid && (!kinds || kinds.includes(r.kind));
  return {
    rows,
    add: (record) => rows.push(record),
    since: (uid, after, limit) => rows.filter((r) => r.uid === uid && r.seq > after).slice(0, limit),
    query: (uid, { kinds = null, limit = 100 } = {}) => rows.filter(match(uid, kinds)).slice(-limit).reverse(),
    count: (uid, kinds = null) => rows.filter(match(uid, kinds)).length,
    maxSeq: () => (rows.length ? rows[rows.length - 1].seq : 0),
  };
}

/** The §7.2 surface http.js uses, over real LiveLayers (each with its player's journal facade). */
class TestGardens {
  constructor({ engine, journal, now }) {
    this.engine = engine;
    this.journal = journal;
    this.now = now;
    this.map = new Map();
    this.closeStreams = null;
  }

  get(uid) {
    let g = this.map.get(uid);
    if (!g) {
      g = new LiveLayer({ config: { accountUsd: 10_000 }, engine: this.engine, journal: this.journal.forUser(uid), owner: { uid }, now: this.now, logKeep: 200, log: quiet });
      this.map.set(uid, g);
    }
    return g;
  }

  peek(uid) {
    return this.map.get(uid) ?? null;
  }

  venueFor(uid) {
    const g = this.get(uid);
    return (row) => g.venue(row);
  }

  marksFor(uid) {
    const g = this.peek(uid);
    if (!g) return null;
    const { bots, account } = g.marksPayload();
    return { bots, account };
  }

  resetSeason(uid, { confirm } = {}) {
    return this.get(uid).resetSeason({ confirm });
  }

  teardown(uid) {
    this.map.delete(uid);
    this.closeStreams?.({ uid, reason: 'deleted' });
  }

  afterTick(summary) {
    for (const g of this.map.values()) g.afterTick(summary);
  }

  markLive(marks) {
    for (const g of this.map.values()) g.markLive(marks);
  }

  stats() {
    let paper = 0;
    for (const g of this.map.values()) paper += g.bots({ state: 'open' }).rows.length;
    return { gardens_loaded: this.map.size, paper_open: paper, testnet_open: 0 };
  }
}

/** Build a full accounts-mode app on a fresh temp DB. `opts` tweaks the platform for one suite. */
async function buildApp({ limiterScopes = {}, slots = {}, testnet = null, credentials = false, authService = false, config = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bean-accounts-'));
  const logs = [];
  const log = (line) => logs.push(String(line));
  const db = openDb({ file: path.join(dir, 'bean-sim.db'), log });
  migrate(db, MIGRATIONS_DIR, { log });
  const masterKey = crypto.randomBytes(32);
  const secrets = new Secrets({ masterKey });
  const hasher = new PasswordHasher({ params: { N: 1024, r: 8, p: 1 } });
  await hasher.init();
  let skewMs = 0;
  const now = () => Date.now() + skewMs;
  const users = new Users(db, { hasher, now });
  users.bootstrap({ dataDir: dir, configuredCode: BOOT_CODE });
  const sessions = new Sessions(db, { publicOrigin: ORIGIN, secrets, now });
  const limiter = new RateLimiter({ scopes: limiterScopes });
  const admin = new Admin(db, { secrets, users, sessions, hasher, now });
  const guard = createRequestGuard({ publicOrigin: ORIGIN, adminToken: ADMIN_TOKEN, limiter, audit: (e) => admin.audit(e) });
  const clientIp = createClientIp({});
  const streamSlots = new StreamSlots(slots);

  const journal = new Journal({ keep: 600, log: quiet, scoped: true, globalKinds: GLOBAL_KINDS, userStore: memUserStore() });
  const engine = new Engine({ config: { seed: 42, beans: 300, warmupBars: 300, tickMs: 60_000, log: quiet }, journal });
  const gardens = new TestGardens({ engine, journal, now });
  const pulse = new Pulse({ log: quiet, scoped: true });
  engine.onTick((s) => gardens.afterTick(s));
  engine.onMarks((marks) => {
    gardens.markLive(marks);
    pulse.publish('mids', { ...marks }); // the SHARED part only; http.js attaches each player's own garden part
  });
  await engine.start();

  const platform = {
    db, users, sessions, guard, limiter, clientIp, streamSlots, admin, secrets, gardens,
    // production composes WP1's AuthService (server/auth/index.js); without it http.js runs its built-in flows
    ...(authService ? { auth: new AuthService({ users, sessions, hasher, limiter, admin, secrets, log }) } : {}),
    ...(testnet ? { testnet } : {}),
    ...(credentials ? { credentials: new Credentials({ db, secrets, now }) } : {}),
  };
  const server = createServer({
    engine, journal, pulse, platform,
    config: { auth: 'accounts', publicOrigin: ORIGIN, version: '0.0.0-test', log, dataDir: dir, ...config },
  });
  gardens.closeStreams = server.closeStreamsFor;
  const port = await listen(server);
  return {
    dir, logs, db, users, sessions, admin, limiter, journal, engine, gardens, pulse, server, port, platform,
    skew: (ms) => { skewMs += ms; },
    async close() {
      await closeServer(server);
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A positioned, tradeable bean whose scaled entries fit $1000 of water (deterministic for seed 42). */
async function pickBean(c, exclude = []) {
  const r = await c.get('beans?in_position=true&tradeable=true&busted=false&limit=1000&sort=-total_return');
  assert.equal(r.status, 200, r.text);
  const ok = r.json.rows.filter((b) => {
    const lev = (b.position_size * b.leverage * b.equity) / 1000;
    return lev >= 0.2 && lev <= 9 && !exclude.includes(b.coin);
  });
  assert.ok(ok.length > 0, 'a suitable positioned bean exists');
  return ok[0];
}

const expectCode = (r, status, code) => {
  assert.equal(r.status, status, r.text);
  assert.equal(r.json?.status, status, r.text);
  assert.equal(r.json?.code, code, r.text);
  assert.equal(typeof r.json?.error, 'string');
};

// =============================================================================================

for (const variant of ['WP1 AuthService', 'built-in auth flows']) describe(`accounts mode (${variant}): pipeline, auth, isolation, SSE, admin`, () => {
  let app;
  let alice;
  let bob;
  let spectator;

  before(async () => {
    app = await buildApp({
      authService: variant === 'WP1 AuthService',
      // generous creation budgets for the many sign-ups below (the default 3/h per IP is tested on its own app)
      limiterScopes: {
        signup_create_ip: { capacity: 100, perS: 1 }, signup_attempt_ip: { capacity: 100, perS: 1 }, login_ip: { capacity: 100, perS: 1 },
        queries_ip: { capacity: 10_000, perS: 1000 },
      },
    });
    alice = client(app.port);
    bob = client(app.port);
    spectator = client(app.port);
  });

  after(async () => {
    await app.close();
  });

  // ------------------------------------------------------------------ index, headers, host

  it('GET /api/v1: auth accounts, session policy, public origin; CORS only on public GETs', async () => {
    const r = await spectator.get('');
    assert.equal(r.status, 200);
    assert.equal(r.json.auth, 'accounts');
    assert.equal(r.json.command_policy, 'session');
    assert.equal(r.json.public_origin, ORIGIN);
    assert.deepEqual(r.json.testnet, { enabled: false });
    assert.deepEqual(r.json.operations.map((o) => o.name), OPS.map((o) => o.name));
    for (const op of r.json.operations) {
      assert.ok(['public', 'user', 'admin'].includes(op.auth), op.name);
      assert.equal(typeof op.sensitive, 'boolean');
      assert.ok(Array.isArray(op.modes) && op.modes.includes('accounts'));
    }
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal((await spectator.get('health')).headers['access-control-allow-origin'], '*', 'public query');
    const me = await spectator.get('me');
    assert.equal(me.headers['access-control-allow-origin'], undefined, 'user-scoped GET: no CORS');
    const pre = await spectator.req({ method: 'OPTIONS', path: '/api/v1/auth_login', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], undefined, 'no CORS preflight for commands');
  });

  it('security headers on static and API responses; CSP connect-src is self only', async () => {
    for (const p of ['/', '/api/v1/health', '/js/brood-api.js']) {
      const r = await spectator.req({ path: p });
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin', p);
      assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin', p);
      assert.match(r.headers['permissions-policy'], /camera=\(\)/, p);
      assert.equal(r.headers['strict-transport-security'], undefined, 'no HSTS on an http origin');
    }
    const page = await spectator.req({ path: '/' });
    assert.match(page.headers['content-security-policy'], /connect-src 'self';/);
    assert.doesNotMatch(page.headers['content-security-policy'], /connect-src 'self' http:/);
  });

  it('421 misdirected for a foreign Host; /healthz, /readyz and GET health also answer on 127.0.0.1:<port>', async () => {
    const evil = client(app.port, { host: 'evil.example' });
    expectCode(await evil.get('health'), 421, 'misdirected');
    expectCode(await evil.req({ path: '/' }), 421, 'misdirected');
    expectCode(await evil.post('auth_login', { username: 'x', password: 'y' }), 421, 'misdirected');
    expectCode(await evil.req({ path: '/readyz' }), 421, 'misdirected');
    // Liveness answers any Host (constant body; Render's health checker uses an internal Host name).
    const live = await client(app.port, { host: 'srv-internal:10000' }).req({ path: '/healthz' });
    assert.equal(live.status, 200);
    assert.deepEqual(live.json, { ok: true });
    const local = client(app.port, { host: `127.0.0.1:${app.port}` });
    assert.equal((await local.req({ path: '/healthz' })).status, 200);
    const ready = await local.req({ path: '/readyz' });
    assert.equal(ready.status, 200, ready.text);
    assert.deepEqual(ready.json, { ok: true });
    assert.equal((await local.get('health')).status, 200);
    expectCode(await local.get('status'), 421, 'misdirected');
  });

  it('a POST with a query string is refused BEFORE its body is read, and nothing secret is logged', async () => {
    const before = app.logs.length;
    // Content-Length promises a body that never comes: the 400 must arrive anyway.
    const r = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: app.port, method: 'POST', path: '/api/v1/auth_login?password=hunter2-SECRET',
        headers: { Host: HOST, Origin: ORIGIN, 'Content-Type': 'application/json', 'Content-Length': '500' }, agent: false,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.write('{"username":"a');
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'query_params_not_allowed');
    seenCodes.add(r.json.code);
    assert.ok(!app.logs.slice(before).some((l) => l.includes('hunter2')), 'the query never reaches a log line');
    const t = await alice.post('testnet_connect?agent_key=00', {});
    expectCode(t, 400, 'query_params_not_allowed');
  });

  it('CSRF: foreign Origin → 403, cross-site fetch without Origin → 403, form content types → 415', async () => {
    expectCode(await spectator.post('auth_login', { username: 'nobody1', password: PW }, { Origin: 'https://evil.example' }), 403, 'csrf');
    expectCode(await spectator.post('auth_login', { username: 'nobody1', password: PW }, { Origin: 'null' }), 403, 'csrf');
    expectCode(await spectator.post('auth_login', { username: 'nobody1', password: PW }, { Origin: null, 'Sec-Fetch-Site': 'cross-site' }), 403, 'csrf');
    expectCode(await spectator.post('auth_login', 'username=a&password=b', { 'Content-Type': 'application/x-www-form-urlencoded' }), 415, 'unsupported_media_type');
    expectCode(await spectator.post('auth_login', '{}', { 'Content-Type': 'text/plain' }), 415, 'unsupported_media_type');
    // no Origin but Sec-Fetch-Site: same-origin passes the CSRF check (then fails on the credentials)
    expectCode(await spectator.post('auth_login', { username: 'nobody1', password: PW }, { Origin: null, 'Sec-Fetch-Site': 'same-origin' }), 401, 'bad_credentials');
  });

  // ------------------------------------------------------------------ sign-up, sign-in, me

  it('spectators: me is 200 with user:null; user queries answer 401 auth_required; public queries work', async () => {
    const me = await spectator.get('me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.json, { mode: 'accounts', user: null, session: null, signup: 'open', testnet: null });
    for (const op of ['bots', 'live_status', 'live_fills', 'testnet_status', 'sessions']) expectCode(await spectator.get(op), 401, 'auth_required');
    expectCode(await spectator.get('bot_detail?id=bot-0000'), 401, 'auth_required');
    expectCode(await spectator.post('bot_create', { bean: 1, capital_usd: 100 }), 401, 'auth_required');
    assert.equal((await spectator.get('beans?limit=3')).status, 200);
    assert.equal((await spectator.get('market')).status, 200);
    const tm = await spectator.get('testnet_market');
    assert.equal(tm.status, 200);
    assert.equal(tm.json.enabled, false);
    assert.equal(tm.json.coins.length, 16);
  });

  it('auth_signup: validation codes, the session and known-device cookies, then me', async () => {
    expectCode(await alice.post('auth_signup', { username: 'A!', password: PW }), 400, 'bad_username');
    expectCode(await alice.post('auth_signup', { username: 'alice', password: 'short' }), 400, 'weak_password');
    expectCode(await alice.post('auth_signup', { username: 'admin', password: PW }), 409, 'username_unavailable');
    const r = await alice.post('auth_signup', { username: 'Alice', password: PW, lang: 'th' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json.user).sort(), ['created_ms', 'id', 'lang', 'role', 'username']);
    assert.equal(r.json.user.username, 'alice');
    assert.equal(r.json.user.role, 'player');
    const cookies = [].concat(r.headers['set-cookie']);
    const sid = cookies.find((c) => c.startsWith('bean_sid='));
    assert.ok(sid, 'http origin → the plain bean_sid name');
    assert.match(sid, /HttpOnly/);
    assert.match(sid, /SameSite=Lax/);
    assert.doesNotMatch(sid, /Domain=/i);
    assert.ok(cookies.some((c) => c.startsWith('bean_kd=')), 'known-device cookie');
    expectCode(await bob.post('auth_signup', { username: 'alice', password: PW }), 409, 'username_unavailable');
    const me = await alice.get('me');
    assert.equal(me.status, 200);
    assert.equal(me.json.user.username, 'alice');
    assert.equal(me.json.user.lang, 'th');
    assert.ok(me.json.session.expires_ms > Date.now());
    assert.equal(me.json.testnet, null);
    assert.equal((await bob.post('auth_signup', { username: 'bob', password: PW })).status, 200);
  });

  it('auth_login: one generic 401 for a wrong password or an unknown user; a stale cookie → session_expired + cleared', async () => {
    const c = client(app.port);
    const wrong = await c.post('auth_login', { username: 'alice', password: 'wrong password 123' });
    const unknown = await c.post('auth_login', { username: 'nobody2', password: PW });
    expectCode(wrong, 401, 'bad_credentials');
    expectCode(unknown, 401, 'bad_credentials');
    assert.equal(wrong.json.error, unknown.json.error);
    const ok = await c.post('auth_login', { username: 'ALICE', password: PW });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.user.username, 'alice');
    // a well-formed but unknown token is anonymous: user ops answer session_expired and clear the cookie
    const stale = client(app.port);
    stale.jar.set('bean_sid', crypto.randomBytes(32).toString('base64url'));
    const r = await stale.get('bots');
    expectCode(r, 401, 'session_expired');
    assert.ok([].concat(r.headers['set-cookie']).some((x) => /^bean_sid=;.*Max-Age=0/.test(x)));
    stale.jar.set('bean_sid', crypto.randomBytes(32).toString('base64url'));
    const me = await stale.get('me');
    assert.equal(me.status, 200);
    assert.equal(me.json.user, null);
    assert.equal(stale.jar.has('bean_sid'), false, 'me clears a stale cookie too');
    const login = app.logs.filter((l) => l.startsWith('[api] auth_login'));
    assert.ok(login.length >= 3 && login.every((l) => l.includes('<redacted>') && !l.includes(PW)), 'sensitive params never logged');
  });

  // ------------------------------------------------------------------ isolation

  let aliceBot;
  let bobBot;
  let bean;

  it('players are isolated: bots, live_status, live_fills, events and bean verdicts are per player', async () => {
    bean = await pickBean(alice);
    const a = await alice.post('bot_create', { bean: bean.id, capital_usd: 1000 });
    assert.equal(a.status, 200, a.text);
    aliceBot = a.json;
    // the same bean in another garden is allowed (gardens are private, beans are shared)
    const b = await bob.post('bot_create', { bean: bean.id, capital_usd: 500, venue: 'paper' });
    assert.equal(b.status, 200, b.text);
    bobBot = b.json;
    const ab = await alice.get('bots');
    assert.deepEqual(ab.json.rows.map((r) => r.capital_usd), [1000]);
    const bb = await bob.get('bots');
    assert.deepEqual(bb.json.rows.map((r) => r.capital_usd), [500]);
    expectCode(await alice.get(`bot_detail?id=${bobBot.id}x`), 404, 'not_found');
    // live_status describes the caller's own paper ledger
    assert.equal((await alice.get('live_status')).json.deployed_usd, 1000);
    assert.equal((await bob.get('live_status')).json.deployed_usd, 500);
    // fills
    const af = await alice.get('live_fills');
    assert.ok(af.json.rows.every((f) => f.bot === aliceBot.id));
    // events: alice sees her own bot_created only; spectators see none
    const ae = await alice.get('events?kind=bot_created');
    assert.deepEqual(ae.json.rows.map((r) => r.capital_usd), [1000]);
    assert.equal(ae.json.rows[0].uid, undefined, 'the internal uid never leaves the server');
    const se = await spectator.get('events?kind=bot_created');
    assert.deepEqual(se.json.rows, []);
    assert.ok((await spectator.get('events?limit=50')).json.rows.every((r) => GLOBAL_KINDS.includes(r.kind)));
    // beans: `bot` is the caller's own verdict
    const mine = await alice.get(`bean_detail?id=${bean.id}`);
    assert.equal(mine.json.bean.bot, aliceBot.id);
    const theirs = await bob.get(`bean_detail?id=${bean.id}`);
    assert.equal(theirs.json.bean.bot, bobBot.id);
    const spec = await spectator.get(`bean_detail?id=${bean.id}`);
    assert.equal(spec.json.bean.bot, null);
  });

  it('SSE: each stream gets global records + its own; mids carry only the subscriber\'s garden', async () => {
    const as = await openStream(app.port, { headers: { Cookie: alice.cookieHeader() } });
    const bs = await openStream(app.port, { headers: { Cookie: bob.cookieHeader() } });
    const ss = await openStream(app.port);
    try {
      for (const s of [as, bs, ss]) {
        await s.until((x) => x.text.includes(': hello'));
        assert.equal(s.res.headers['access-control-allow-origin'], undefined, 'no CORS on the stream');
      }
      const tick = app.engine.tick();
      for (const s of [as, bs, ss]) await s.until((x) => framesOf(x, 'tick_completed').length >= 1 && framesOf(x, 'mids').length >= 1);
      const pause = await alice.post('bot_pause', { id: aliceBot.id });
      assert.equal(pause.status, 200, pause.text);
      await as.until((x) => framesOf(x, 'bot_paused').length >= 1);
      await sleep(100);
      assert.equal(framesOf(bs, 'bot_paused').length, 0, 'bob never sees alice\'s records');
      assert.equal(framesOf(ss, 'bot_paused').length, 0, 'spectators never see a player\'s records');
      for (const s of [as, bs, ss]) assert.equal(framesOf(s, 'tick_completed')[0].data.tick, tick.tick);
      const am = framesOf(as, 'mids').at(-1).data;
      assert.deepEqual(Object.keys(am.bots), [aliceBot.id]);
      assert.ok(am.account && typeof am.account === 'object');
      const bm = framesOf(bs, 'mids').at(-1).data;
      assert.deepEqual(Object.keys(bm.bots), [bobBot.id]);
      const sm = framesOf(ss, 'mids').at(-1).data;
      for (const k of ['bots', 'account', 'testnet_account']) assert.equal(Object.hasOwn(sm, k), false, `spectator mids has no ${k}`);
      assert.ok(Object.keys(sm.px).length === 16);
      for (const f of sseFrames(as.text)) if (f.data && f.id) assert.equal(f.data.uid, undefined);
      assert.ok(await alice.post('bot_resume', { id: aliceBot.id }).then((r) => r.status === 200));
    } finally {
      as.close();
      bs.close();
      ss.close();
    }
  });

  it('Last-Event-ID replays global records merged with the player\'s own, in seq order', async () => {
    const last = app.journal.lastSeq;
    app.engine.tick();
    await alice.post('bot_pause', { id: aliceBot.id });
    await bob.post('bot_pause', { id: bobBot.id });
    app.engine.tick();
    const s = await openStream(app.port, { headers: { Cookie: alice.cookieHeader(), 'Last-Event-ID': String(last) } });
    try {
      await s.until((x) => framesOf(x, 'tick_completed').length >= 2);
      await s.until((x) => framesOf(x, 'bot_paused').length >= 1);
      const ids = sseFrames(s.text).filter((f) => f.id).map((f) => Number(f.id));
      assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
      assert.ok(ids[0] > last);
      assert.deepEqual(framesOf(s, 'bot_paused').map((f) => f.data.bot), [aliceBot.id]);
    } finally {
      s.close();
    }
    await alice.post('bot_resume', { id: aliceBot.id });
    await bob.post('bot_resume', { id: bobBot.id });
  });

  // ------------------------------------------------------------------ sessions and revocation

  it('logout ends exactly that session\'s streams in the same tick; logout_all ends the rest', async () => {
    const second = client(app.port);
    assert.equal((await second.post('auth_login', { username: 'alice', password: PW })).status, 200);
    const s1 = await openStream(app.port, { headers: { Cookie: alice.cookieHeader() } });
    const s2 = await openStream(app.port, { headers: { Cookie: second.cookieHeader() } });
    try {
      await s1.until((x) => x.text.includes(': hello'));
      await s2.until((x) => x.text.includes(': hello'));
      const out = await second.post('auth_logout');
      assert.deepEqual(out.json, { ok: true });
      assert.equal(second.jar.has('bean_sid'), false, 'cookie cleared');
      await s2.until((x) => x.ended);
      assert.deepEqual(framesOf(s2, 'session_ended').map((f) => f.data.reason), ['logout']);
      assert.equal(framesOf(s2, 'session_ended')[0].id, undefined, 'stream-only: no id line');
      assert.equal(s1.ended, false, 'the other session\'s stream stays open');
      expectCode(await second.get('bots'), 401, 'auth_required');
      // sessions (P1): the current one is flagged; another player cannot revoke it (404, IDOR-safe)
      const list = await alice.get('sessions');
      assert.equal(list.status, 200);
      const current = list.json.rows.find((r) => r.current);
      assert.ok(current && typeof current.id === 'string' && current.id.length === 22);
      expectCode(await bob.post('session_revoke', { id: current.id }), 404, 'not_found');
      assert.equal((await alice.get('bots')).status, 200, 'alice\'s session survives');
      expectCode(await alice.post('session_revoke', { id: 'x'.repeat(22) }), 404, 'not_found');
      // logout everywhere
      const third = client(app.port);
      assert.equal((await third.post('auth_login', { username: 'alice', password: PW })).status, 200);
      const all = await third.post('auth_logout_all');
      assert.equal(all.status, 200);
      assert.ok(all.json.revoked >= 2);
      await s1.until((x) => x.ended);
      assert.deepEqual(framesOf(s1, 'session_ended').map((f) => f.data.reason), ['logout_all']);
      expectCode(await alice.get('bots'), 401, 'session_expired');
    } finally {
      s1.close();
      s2.close();
    }
    alice = client(app.port);
    assert.equal((await alice.post('auth_login', { username: 'alice', password: PW })).status, 200);
  });

  it('account_password: wrong current → 401, weak → 400; success revokes the old sessions and issues a new one', async () => {
    const other = client(app.port);
    assert.equal((await other.post('auth_login', { username: 'bob', password: PW })).status, 200);
    expectCode(await bob.post('account_password', { current_password: 'not it at all', new_password: 'another long password 7' }), 401, 'bad_credentials');
    expectCode(await bob.post('account_password', { current_password: PW, new_password: 'bob' }), 400, 'weak_password');
    const s = await openStream(app.port, { headers: { Cookie: other.cookieHeader() } });
    try {
      await s.until((x) => x.text.includes(': hello'));
      const r = await bob.post('account_password', { current_password: PW, new_password: 'another long password 7' });
      assert.equal(r.status, 200, r.text);
      await s.until((x) => x.ended);
      assert.deepEqual(framesOf(s, 'session_ended').map((f) => f.data.reason), ['password_changed']);
    } finally {
      s.close();
    }
    expectCode(await other.get('bots'), 401, 'session_expired');
    assert.equal((await bob.get('bots')).status, 200, 'the caller got a fresh session');
    expectCode(await client(app.port).post('auth_login', { username: 'bob', password: PW }), 401, 'bad_credentials');
  });

  // ------------------------------------------------------------------ garden ops

  it('bot_create venue rules: testnet needs confirm and an enabled testnet; paper is the default', async () => {
    expectCode(await alice.post('bot_create', { bean: bean.id, capital_usd: 100, venue: 'testnet' }), 400, 'confirm_required');
    expectCode(await alice.post('bot_create', { bean: bean.id, capital_usd: 100, venue: 'testnet', confirm: 'testnet' }), 503, 'testnet_disabled');
    expectCode(await alice.post('bot_create', { bean: bean.id, capital_usd: 100, venue: 'moon' }), 400, 'bad_request');
    const dup = await alice.post('bot_create', { bean: bean.id, capital_usd: 100 });
    assert.equal(dup.status, 409, 'one bot per bean per player');
    assert.equal(dup.json.code, 'bean_bound');
  });

  it('bots_halt → garden_rearm (REARM, ≥ 60 s after) → planting again', async () => {
    const h = await alice.post('bots_halt');
    assert.equal(h.status, 200, h.text);
    assert.equal(h.json.halted, true);
    assert.deepEqual(h.json.closed, [aliceBot.id]);
    assert.deepEqual(h.json.closing, []);
    const refused = await alice.post('bot_create', { bean: bean.id, capital_usd: 100 });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, 'halted');
    expectCode(await alice.post('garden_rearm', { confirm: 'rearm' }), 400, 'confirm_required');
    expectCode(await alice.post('garden_rearm', {}), 400, 'confirm_required');
    const soon = await alice.post('garden_rearm', { confirm: 'REARM' });
    expectCode(soon, 409, 'too_soon');
    app.skew(61_000);
    const ok = await alice.post('garden_rearm', { confirm: 'REARM' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.halted, false);
    assert.equal((await bob.get('live_status')).json.halted, false, 'a halt is per player');
    const again = await alice.post('bot_create', { bean: bean.id, capital_usd: 200 });
    assert.equal(again.status, 200, again.text);
    aliceBot = again.json;
  });

  it('garden_reset: RESET starts a new paper season once per 24 h', async () => {
    expectCode(await alice.post('garden_reset', { confirm: 'reset' }), 400, 'confirm_required');
    const r = await alice.post('garden_reset', { confirm: 'RESET' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.season, 2);
    assert.deepEqual(r.json.closed, [aliceBot.id]);
    assert.equal(r.json.account_usd, 10_000);
    const again = await alice.post('garden_reset', { confirm: 'RESET' });
    expectCode(again, 409, 'too_soon');
    assert.ok(again.json.retry_after_s > 80_000);
    assert.equal(again.headers['retry-after'], undefined, 'Retry-After only on 429/503');
    assert.equal((await bob.get('bots?state=open')).json.rows.length, 1, 'bob is untouched');
  });

  it('tick is admin only in accounts mode', async () => {
    expectCode(await alice.post('tick', { n: 1 }), 403, 'forbidden');
  });

  // ------------------------------------------------------------------ admin

  let root;

  it('the first admin signs up with the bootstrap code; admin ops are refused to players', async () => {
    root = client(app.port);
    expectCode(await root.post('auth_signup', { username: 'gardener', password: PW, bootstrap_code: 'WRONG-CODE-0000' }), 403, 'forbidden');
    const r = await root.post('auth_signup', { username: 'gardener', password: PW, bootstrap_code: BOOT_CODE });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.user.role, 'admin');
    expectCode(await alice.get('admin_status'), 403, 'forbidden');
    expectCode(await spectator.get('admin_status'), 401, 'auth_required');
    const t = await root.post('tick', { n: 1 });
    assert.equal(t.status, 200, t.text);
  });

  it('every op enforces its access class: spectators 401 on user/admin ops, players 403 on admin ops (catalog-driven)', async () => {
    const call = (c, op) => (op.kind === 'query' ? c.get(op.name) : c.post(op.name, {}));
    for (const op of OPS) {
      assert.ok(op.modes.includes('accounts'), `${op.name} runs in accounts mode`);
      const s = await call(spectator, op);
      if (op.auth === 'public') {
        assert.ok(s.status !== 401 && s.status !== 403, `${op.name} is public (got ${s.status} ${s.text.slice(0, 80)})`);
      } else if (op.name === 'me') {
        assert.equal(s.status, 200, 'me answers spectators with user:null');
        assert.equal(s.json.user, null);
      } else {
        expectCode(s, 401, 'auth_required');
      }
      if (op.auth === 'admin') expectCode(await call(alice, op), 403, 'forbidden');
    }
  });

  it('admin_status, admin_users (truncated, LIKE-escaped), admin_audit', async () => {
    const s = await root.get('admin_status');
    assert.equal(s.status, 200, s.text);
    for (const k of ['version', 'uptime_s', 'users', 'sessions_active', 'sse_streams', 'gardens_loaded', 'bots', 'testnet', 'mainnet', 'client_ip', 'db', 'event_loop_p99_ms']) {
      assert.ok(Object.hasOwn(s.json, k), k);
    }
    assert.equal(s.json.users, 3);
    assert.equal(s.json.client_ip.source, 'socket');
    assert.ok(s.json.client_ip.buckets_1h >= 1);
    assert.ok(s.json.db.size_bytes > 0);
    const u = await root.get('admin_users?q=ali');
    assert.equal(u.status, 200, u.text);
    assert.deepEqual(u.json.rows.map((r) => r.username), ['alice']);
    assert.equal((await root.get('admin_users?q=%25')).json.rows.length, 0, '% is matched literally');
    const a = await root.get('admin_audit?action=signup');
    assert.equal(a.status, 200, a.text);
    assert.ok(a.json.rows.length >= 3);
    const fails = (await root.get('admin_audit?action=login_fail')).json.rows;
    assert.ok(fails.length >= 1);
    for (const row of fails) assert.ok(row.target === null || /^h:[0-9a-f]{16}$/.test(row.target), 'never a typed username');
  });

  it('Bearer ADMIN_TOKEN: admin ops from direct loopback only; never player ops; never role changes; failures audited', async () => {
    const cli = client(app.port, { host: `127.0.0.1:${app.port}`, origin: null });
    const bearer = { Authorization: `Bearer ${ADMIN_TOKEN}` };
    const st = await cli.get('admin_status', bearer);
    assert.equal(st.status, 200, st.text);
    const ks = await cli.post('admin_kill_switch', { on: true, reason: 'drill' }, bearer);
    assert.equal(ks.status, 200, ks.text);
    assert.equal(ks.json.kill_switch.on, true);
    assert.equal((await spectator.get('testnet_market')).json.kill_switch.on, false, 'disabled testnet reports no kill switch');
    assert.equal((await cli.post('admin_kill_switch', { on: false }, bearer)).json.kill_switch.on, false);
    expectCode(await cli.post('bot_pause', { id: 'bot-0000' }, bearer), 421, 'misdirected'); // the Host check comes first
    const viaPublicHost = client(app.port, { origin: null });
    expectCode(await viaPublicHost.post('bot_pause', { id: 'bot-0000' }, bearer), 401, 'auth_required'); // never a player op
    // through a proxy (the public Host, X-Forwarded-For): refused unless ADMIN_TOKEN_REMOTE=1
    expectCode(await viaPublicHost.get('admin_status', { ...bearer, 'X-Forwarded-For': '203.0.113.9' }), 403, 'forbidden');
    expectCode(await cli.post('admin_user', { username: 'alice', action: 'make_admin', password: PW }, bearer), 403, 'session_required');
    expectCode(await cli.get('admin_status', { Authorization: 'Bearer wrong-token-wrong-token-wrong-token' }), 401, 'auth_required');
    const audit = (await root.get('admin_audit?action=admin_token_fail')).json.rows;
    assert.ok(audit.length >= 1);
    // the kill switch record is global: it is in everyone's events
    assert.ok((await spectator.get('events?kind=kill_switch')).json.rows.length >= 2);
  });

  it('admin_user: disable (403 after a correct password), enable, reset_password → auth_reset works once', async () => {
    const d = await root.post('admin_user', { username: 'bob', action: 'disable' });
    assert.equal(d.status, 200, d.text);
    assert.equal(d.json.user.status, 'disabled');
    expectCode(await bob.get('bots'), 401, 'session_expired');
    expectCode(await client(app.port).post('auth_login', { username: 'bob', password: 'another long password 7' }), 403, 'account_disabled');
    expectCode(await client(app.port).post('auth_login', { username: 'bob', password: 'not his password' }), 401, 'bad_credentials');
    assert.equal((await root.post('admin_user', { username: 'bob', action: 'enable' })).status, 200);
    const reset = await root.post('admin_user', { username: 'bob', action: 'reset_password' });
    assert.equal(reset.status, 200, reset.text);
    assert.match(reset.json.code, /^[A-Z2-9]{12}$/);
    assert.ok(reset.json.expires_ms > Date.now());
    bob = client(app.port);
    expectCode(await bob.post('auth_reset', { username: 'bob', code: 'ABCDEFGHJKLM', new_password: 'third password here 1' }), 401, 'bad_credentials');
    const ok = await bob.post('auth_reset', { username: 'bob', code: reset.json.code, new_password: 'third password here 1' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.user.username, 'bob');
    assert.equal((await bob.get('bots')).status, 200);
    expectCode(await client(app.port).post('auth_reset', { username: 'bob', code: reset.json.code, new_password: 'fourth password here 1' }), 401, 'bad_credentials');
    const diary = await bob.get('events?kind=password_reset');
    assert.equal(diary.json.rows.length, 1, 'one diary line for the player');
    expectCode(await root.post('admin_user', { username: 'nobody9', action: 'enable' }), 404, 'not_found');
    expectCode(await root.post('admin_user', { username: 'alice', action: 'make_admin' }), 401, 'bad_credentials');
  });

  it('admin_caps validates and applies; admin_backup is not wired here (internal error, no message)', async () => {
    const c = await root.post('admin_caps', { paper: { max_bots: 8 } });
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.caps.paper.max_bots, 8);
    expectCode(await root.post('admin_caps', { paper: { warp: 1 } }), 400, 'bad_request');
    expectCode(await root.post('admin_caps', {}), 400, 'bad_request');
    const b = await root.post('admin_backup');
    assert.equal(b.status, 500);
    assert.deepEqual(b.json, { error: 'internal error', status: 500 });
  });

  // ------------------------------------------------------------------ sensitive ops, limits

  it('sensitive ops: invalid JSON answers without the V8 snippet; a 500 logs only the op and the error name', async () => {
    const r = await alice.post('auth_login', '{"password":"SECRET-PASTE-12345"');
    expectCode(r, 400, 'invalid_json');
    assert.equal(r.json.error, 'invalid JSON body');
    const original = app.users.verify;
    app.users.verify = async () => {
      throw new TypeError('boom with SECRET-IN-MESSAGE');
    };
    const before = app.logs.length;
    try {
      const e = await client(app.port).post('auth_login', { username: 'alice', password: PW });
      assert.equal(e.status, 500);
      assert.deepEqual(e.json, { error: 'internal error', status: 500 });
    } finally {
      app.users.verify = original;
    }
    const lines = app.logs.slice(before).join('\n');
    assert.match(lines, /auth_login → 500 internal error \(TypeError, internal\)/);
    assert.doesNotMatch(lines, /SECRET-IN-MESSAGE|at .*http\.js/);
    expectCode(await alice.post('auth_login', JSON.stringify({ username: 'a', password: 'x'.repeat(5000) })), 413, 'body_too_large');
  });

  it('SSE limits: ≤ 5 concurrent streams per player', async () => {
    const streams = [];
    try {
      for (let i = 0; i < 5; i++) streams.push(await openStream(app.port, { headers: { Cookie: alice.cookieHeader() } }));
      for (const s of streams) assert.equal(s.res.statusCode, 200);
      const sixth = await openStream(app.port, { headers: { Cookie: alice.cookieHeader() } });
      sixth.close();
      assert.equal(sixth.res.statusCode, 429);
      assert.ok(Number(sixth.res.headers['retry-after']) >= 1);
    } finally {
      for (const s of streams) s.close();
    }
  });

  it('account_delete: DELETE + password; streams end; the name is retired', async () => {
    const victim = client(app.port);
    assert.equal((await victim.post('auth_signup', { username: 'carol', password: PW })).status, 200);
    const b = await pickBean(victim);
    assert.equal((await victim.post('bot_create', { bean: b.id, capital_usd: 100 })).status, 200);
    expectCode(await victim.post('account_delete', { password: PW, confirm: 'delete' }), 400, 'confirm_required');
    expectCode(await victim.post('account_delete', { password: 'wrong wrong wrong', confirm: 'DELETE' }), 401, 'bad_credentials');
    const s = await openStream(app.port, { headers: { Cookie: victim.cookieHeader() } });
    try {
      await s.until((x) => x.text.includes(': hello'));
      const r = await victim.post('account_delete', { password: PW, confirm: 'DELETE' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.deleted, true);
      assert.equal(r.json.closed.length, 1);
      assert.deepEqual(r.json.testnet_left_open, []);
      await s.until((x) => x.ended);
      assert.ok(framesOf(s, 'session_ended').length >= 1);
    } finally {
      s.close();
    }
    expectCode(await client(app.port).post('auth_signup', { username: 'carol', password: PW }), 409, 'username_unavailable');
    expectCode(await client(app.port).post('auth_login', { username: 'carol', password: PW }), 401, 'bad_credentials');
  });

  it('Last-Event-ID older than the ring answers event: resync (no id)', async () => {
    for (let i = 0; i < 700; i++) app.journal.emit('feed_gap', { from_ms: i, to_ms: i, bars: 0, mode: 'replay', reason: 'restart' });
    const s = await openStream(app.port, { headers: { 'Last-Event-ID': '1' } });
    try {
      await s.until((x) => framesOf(x, 'resync').length === 1);
      assert.equal(framesOf(s, 'resync')[0].id, undefined);
      assert.equal(framesOf(s, 'feed_gap').length, 0, 'nothing is replayed after a resync');
    } finally {
      s.close();
    }
  });

  it('SSE buffering budget: a stream that stops reading is dropped (never grows without bound)', async () => {
    const s = await openStream(app.port, { headers: { Cookie: alice.cookieHeader() } });
    await s.until((x) => x.text.includes(': hello'));
    s.res.pause();
    s.req.socket.pause();
    const pad = 'x'.repeat(16 * 1024);
    let dropped = false;
    for (let i = 0; i < 4000 && !dropped; i++) {
      app.journal.emit('feed_status', { state: 'sim', prev: 'sim', pad });
      if (i % 50 === 49) {
        await sleep(5);
        dropped = app.server.streamStats().total === 0;
      }
    }
    s.close();
    assert.ok(dropped, 'the stalled stream was dropped by the 128 KB budget');
  });

  it('beginShutdown: commands 503 server_restarting, /readyz 503, streams get server_restart', async () => {
    const s = await openStream(app.port);
    await s.until((x) => x.text.includes(': hello'));
    app.server.beginShutdown();
    await s.until((x) => x.ended);
    assert.equal(framesOf(s, 'server_restart').length, 1);
    expectCode(await alice.post('bot_pause', { id: aliceBot.id }), 503, 'server_restarting');
    const ready = await client(app.port, { host: `127.0.0.1:${app.port}` }).req({ path: '/readyz' });
    assert.equal(ready.status, 503);
    assert.deepEqual(ready.json, { ok: false, why: 'shutting_down' });
    s.close();
  });
});

// =============================================================================================

for (const variant of ['WP1 AuthService', 'built-in auth flows']) describe(`accounts mode (${variant}): rate limits with the default §4.5 budgets`, () => {
  let app;
  const authService = variant === 'WP1 AuthService';

  before(async () => {
    app = await buildApp({ authService });
  });
  after(async () => {
    await app.close();
  });

  it('auth_login: 10 per IP, then 429 rate_limited with retry_after_s and Retry-After', async () => {
    const c = client(app.port);
    for (let i = 0; i < 10; i++) expectCode(await c.post('auth_login', { username: `ghost${i}x`, password: PW }), 401, 'bad_credentials');
    const r = await c.post('auth_login', { username: 'ghostzz', password: PW });
    expectCode(r, 429, 'rate_limited');
    assert.ok(r.json.retry_after_s >= 1);
    assert.equal(r.headers['retry-after'], String(r.json.retry_after_s));
  });

  it('auth_signup: 3 successful creations per IP per hour; failures do not consume them', async () => {
    const c = client(app.port);
    expectCode(await c.post('auth_signup', { username: 'dup_name', password: 'x' }), 400, 'weak_password');
    for (const name of ['first_one', 'second_one', 'third_one']) assert.equal((await client(app.port).post('auth_signup', { username: name, password: PW })).status, 200);
    const r = await client(app.port).post('auth_signup', { username: 'fourth_one', password: PW });
    expectCode(r, 429, 'rate_limited');
  });

  it('per-username lockout after 5 failures answers the generic 429; a known-device cookie still signs in', async () => {
    const app2 = await buildApp({ authService, limiterScopes: { login_ip: { capacity: 100, perS: 1 } } });
    try {
      const me = client(app2.port);
      assert.equal((await me.post('auth_signup', { username: 'dora', password: PW })).status, 200);
      const kd = me.jar.get('bean_kd');
      assert.ok(kd);
      const attacker = client(app2.port);
      for (let i = 0; i < 5; i++) expectCode(await attacker.post('auth_login', { username: 'dora', password: `guess number ${i}` }), 401, 'bad_credentials');
      expectCode(await attacker.post('auth_login', { username: 'dora', password: PW }), 429, 'rate_limited');
      const device = client(app2.port);
      device.jar.set('bean_kd', kd);
      const ok = await device.post('auth_login', { username: 'dora', password: PW });
      assert.equal(ok.status, 200, ok.text);
    } finally {
      await app2.close();
    }
  });
});

// =============================================================================================

describe('accounts mode: testnet ops spend no Hyperliquid weight; connect format refusals are free', () => {
  let app;
  let hlCalls = 0;
  let verifyCalls = 0;
  let verifyAnswer = null;
  const ACCOUNT = '0x' + 'ab'.repeat(20);
  const KEY = '0x' + '11'.repeat(32);

  before(async () => {
    const tripwire = (name) => () => {
      hlCalls++;
      throw new Error(`Hyperliquid call ${name} on a cache-only path`);
    };
    const listingRow = (coin, i) => ({
      coin, index: i, sz_decimals: 2, max_leverage: 20, delisted: false, only_isolated: false, margin_mode: null,
      mid: 100 + i, mid_ms: Date.now(), mark_px: 100 + i, funding_1h: 0.0000125, tradeable: true,
    });
    const market = {
      status: () => ({ state: 'live', reason: null }),
      state: () => 'live',
      snapshot: () => ({ state: 'live', state_reason: null, mids_ms: 123, ctx_ms: 456, mids: {}, marks: {}, funding_1h: {} }),
      listing: () => ['BTC', 'ETH'].map(listingRow),
      book: tripwire('l2Book'),
      refreshBook: tripwire('l2Book'),
    };
    const testnet = {
      market,
      info: new Proxy({}, { get: (_t, name) => tripwire(String(name)) }),
      scheduler: { stats: () => ({ weight_60s: 0, budget: 800 }), run: tripwire('scheduler.run') },
      verify: {
        async verifyAgent({ accountAddress, agentKeyBytes }) {
          verifyCalls++;
          assert.ok(agentKeyBytes instanceof Uint8Array && agentKeyBytes.length === 32);
          if (verifyAnswer) return verifyAnswer;
          return {
            ok: true, account_address: accountAddress, agent_address: '0x' + 'cd'.repeat(20), agent_name: 'bean-garden',
            valid_until_ms: Date.now() + 3 * 86_400_000, abstraction: 'default', account_value: 1000, account_value_est: false,
            withdrawable: 950, warnings: [{ code: 'agent_expiring_soon', valid_until_ms: Date.now() + 3 * 86_400_000 }],
            mainnet_checked_ms: Date.now(), verified_ms: Date.now(),
          };
        },
      },
    };
    app = await buildApp({
      testnet, credentials: true, config: { testnetEnabled: true },
      limiterScopes: { queries_ip: { capacity: 1e6, perS: 1e6 }, signup_create_ip: { capacity: 100, perS: 1 }, signup_attempt_ip: { capacity: 100, perS: 1 } },
    });
  });
  after(async () => {
    await app.close();
  });

  it('testnet_market, testnet_status, testnet_quote and me: 1,000 calls each, zero Hyperliquid requests', async () => {
    const c = client(app.port);
    assert.equal((await c.post('auth_signup', { username: 'erin', password: PW })).status, 200);
    const idx = await c.get('');
    assert.deepEqual(idx.json.testnet, { enabled: true });
    const m = await c.get('testnet_market');
    assert.equal(m.status, 200, m.text);
    assert.equal(m.json.enabled, true);
    assert.equal(m.json.state, 'live');
    assert.equal(m.json.mids_ms, 123);
    assert.deepEqual(m.json.coins.map((x) => x.coin), ['BTC', 'ETH']);
    const ops = ['testnet_market', 'testnet_status', 'testnet_quote?bean=1&capital_usd=50', 'me'];
    const rounds = 250;
    for (let i = 0; i < rounds; i++) {
      const rs = await Promise.all(ops.flatMap((op) => [c.get(op), c.get(op), c.get(op), c.get(op)]));
      for (const r of rs) assert.equal(r.status, 200, r.text);
    }
    assert.equal(hlCalls, 0, 'no user-triggered GET spends Hyperliquid weight');
    const q = await c.get('testnet_quote?bean=1&capital_usd=50');
    assert.equal(q.json.ok, false, 'without the garden quote (WP3) the quote refuses rather than invent numbers');
  });

  it('testnet_connect: format refusals never count; only verifier-reaching attempts use the 5/h budget', async () => {
    const c = client(app.port);
    assert.equal((await c.post('auth_signup', { username: 'frank', password: PW })).status, 200);
    expectCode(await c.post('testnet_connect', { account_address: '0x12', agent_key: KEY }), 400, 'bad_address');
    expectCode(await c.post('testnet_connect', { account_address: ACCOUNT, agent_key: 'abandon '.repeat(11) + 'about' }), 422, 'seed_phrase');
    expectCode(await c.post('testnet_connect', { account_address: ACCOUNT, agent_key: 'Abandon, 2. Ability; 3 able | about above absent absorb abstract absurd abuse access accident' }), 422, 'seed_phrase');
    expectCode(await c.post('testnet_connect', { account_address: ACCOUNT, agent_key: '0x' + '00'.repeat(32) }), 400, 'bad_key_format');
    expectCode(await c.post('testnet_connect', { account_address: ACCOUNT, agent_key: 'zz'.repeat(32) }), 400, 'bad_key_format');
    assert.equal(verifyCalls, 0, 'nothing reached the verifier');
    verifyAnswer = { ok: false, status: 422, code: 'not_agent', counts: true };
    for (let i = 0; i < 5; i++) expectCode(await c.post('testnet_connect', { account_address: ACCOUNT, agent_key: KEY }), 422, 'not_agent');
    expectCode(await c.post('testnet_connect', { account_address: ACCOUNT, agent_key: KEY }), 429, 'rate_limited');
    assert.equal(verifyCalls, 5);
    verifyAnswer = null;
  });

  it('testnet_connect → me.testnet → Replace API wallet → disconnect; the key never appears in a response or log', async () => {
    const c = client(app.port);
    assert.equal((await c.post('auth_signup', { username: 'gina', password: PW })).status, 200);
    const mainnet = await (async () => {
      verifyAnswer = { ok: false, status: 422, code: 'mainnet_key', sub_reason: 'mainnet_user', counts: true };
      const r = await c.post('testnet_connect', { account_address: ACCOUNT, agent_key: KEY });
      verifyAnswer = null;
      return r;
    })();
    expectCode(mainnet, 422, 'mainnet_key');
    assert.equal(mainnet.json.sub_reason, 'mainnet_user');
    const r = await c.post('testnet_connect', { account_address: ACCOUNT.toUpperCase().replace('0X', '0x'), agent_key: KEY });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.replaced, false);
    assert.equal(r.json.testnet.status, 'verified');
    assert.equal(r.json.testnet.account_address, ACCOUNT, 'addresses are lower-cased');
    assert.deepEqual(r.json.warnings.map((w) => w.code), ['agent_expiring_soon']);
    assert.equal(r.json.account.account_value, 1000);
    const me = await c.get('me');
    assert.equal(me.json.testnet.agent_name, 'bean-garden');
    const st = await c.get('testnet_status');
    assert.equal(st.json.link.status, 'verified');
    assert.equal(st.json.expiry.warn, '7d');
    const again = await c.post('testnet_connect', { account_address: ACCOUNT, agent_key: '0x' + '22'.repeat(32) });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.replaced, true, 'same garden, same account: Replace API wallet');
    // another garden cannot attach the same live account
    const other = client(app.port);
    assert.equal((await other.post('auth_signup', { username: 'hank', password: PW })).status, 200);
    expectCode(await other.post('testnet_connect', { account_address: ACCOUNT, agent_key: '0x' + '33'.repeat(32) }), 409, 'agent_in_use');
    const d = await c.post('testnet_disconnect', {});
    assert.equal(d.status, 200, d.text);
    assert.deepEqual(d.json, { disconnected: true, closed: [], left_open: [] });
    assert.equal((await c.get('me')).json.testnet, null);
    for (const text of [r.text, again.text, me.text, st.text, ...app.logs]) {
      assert.ok(!text.includes('11'.repeat(32)) && !text.includes('22'.repeat(32)), 'no key material anywhere');
    }
    const v = await c.post('testnet_verify', {});
    assert.equal(v.status, 500, 'testnet_verify needs the WP3 credentials service (not wired in this app)');
  });
});

// =============================================================================================

describe('none mode additions (PLATFORM §8.8) and shared pieces', () => {
  let server;
  let port;
  let journal;

  before(async () => {
    journal = new Journal({ keep: 500, log: quiet });
    const engine = new Engine({ config: { seed: 7, beans: 120, warmupBars: 200, tickMs: 60_000, log: quiet }, journal });
    const live = new LiveLayer({ config: { accountUsd: 10_000 }, engine, journal, log: quiet });
    engine.setVenueHook((row) => live.venue(row));
    engine.onTick((s) => live.afterTick(s));
    await engine.start();
    server = createServer({ engine, live, journal, config: { version: '0.0.0-test', log: quiet } });
    port = await listen(server);
  });
  after(async () => {
    await closeServer(server);
  });

  const get = (p) => request(port, { path: `/api/v1/${p}` });
  const post = (op, body) => request(port, { method: 'POST', path: `/api/v1/${op}`, body, headers: { 'Content-Type': 'application/json' } });

  it('the index adds auth:"none" and testnet.enabled:false; me answers the implicit local player', async () => {
    const r = await get('');
    assert.equal(r.json.auth, 'none');
    assert.deepEqual(r.json.testnet, { enabled: false });
    assert.equal(r.json.command_policy, 'loopback');
    assert.equal(Object.hasOwn(r.json, 'public_origin'), false);
    const me = await get('me');
    assert.deepEqual(me.json, { mode: 'none', user: { id: 0, username: 'local', role: 'admin', created_ms: null, lang: null }, session: null, signup: 'closed', testnet: null });
  });

  it('accounts-only ops answer 404 accounts_disabled; testnet venue → 409 testnet_needs_accounts; paper is accepted', async () => {
    for (const op of OPS.filter((o) => !o.modes.includes('none'))) {
      const r = op.kind === 'query' ? await get(op.name) : await post(op.name, {});
      assert.equal(r.status, 404, op.name);
      assert.deepEqual(Object.keys(r.json).sort(), ['code', 'error', 'status'], op.name);
      assert.equal(r.json.code, 'accounts_disabled');
    }
    const t = await post('bot_create', { bean: 1, capital_usd: 100, venue: 'testnet', confirm: 'testnet' });
    assert.equal(t.status, 409);
    assert.equal(t.json.code, 'testnet_needs_accounts');
    // other none-mode errors stay {error, status} (byte-identical)
    const bad = await post('bot_create', { bean: 'one', capital_usd: 100 });
    assert.deepEqual(Object.keys(bad.json).sort(), ['error', 'status']);
    const paper = await post('bot_create', { bean: 999999, capital_usd: 100, venue: 'paper' });
    assert.notEqual(paper.json.code, 'testnet_needs_accounts', 'venue paper is accepted and ignored');
    assert.deepEqual(Object.keys(paper.json).sort(), ['error', 'status']);
  });

  it('testnet queries in none mode: disabled shapes, no testnet anywhere', async () => {
    const m = await get('testnet_market');
    assert.equal(m.status, 200);
    assert.equal(m.json.enabled, false);
    assert.equal(m.json.state, 'disabled');
    assert.equal(m.json.coins.length, 16);
    assert.ok(m.json.coins.every((c) => c.index === null && c.tradeable === false));
    const s = await get('testnet_status');
    assert.equal(s.json.link, null);
    assert.equal(s.json.state, 'disabled');
    const q = await get('testnet_quote?bean=1&capital_usd=50');
    assert.equal(q.json.ok, false);
    assert.equal(q.json.venue_reason, 'testnet_needs_accounts');
    for (const k of ['divergence', 'k', 'slippage_max_usd', 'flatten_slippage_max_usd', 'book_ok', 'room_usd', 'free_usd']) assert.ok(Object.hasOwn(q.json, k), k);
  });

  it('meta keeps the none-mode event lists; /healthz and /readyz answer', async () => {
    const meta = await get('meta');
    assert.ok(!meta.json.events.includes('bot_sync'));
    assert.deepEqual(meta.json.stream_only_events, ['mids']);
    assert.deepEqual((await request(port, { path: '/healthz' })).json, { ok: true });
    assert.deepEqual((await request(port, { path: '/readyz' })).json, { ok: true });
  });

  it('accounts mode refuses to start without its platform bag or public origin', () => {
    const engine = { health: () => ({ ok: true }) };
    assert.throws(() => createServer({ engine, journal, config: { auth: 'accounts', publicOrigin: ORIGIN } }), /platform\.users/);
    assert.throws(() => createServer({ engine, journal, platform: { users: {}, sessions: {}, gardens: {} }, config: { auth: 'accounts' } }), /publicOrigin/);
  });

  it('pure helpers: agent key parsing, IPv6 bucketing, built-in token buckets', () => {
    assert.equal(parseAgentKey('0x' + 'ab'.repeat(32)).length, 32);
    assert.equal(parseAgentKey(' ' + 'AB'.repeat(32) + ' ')[0], 0xab);
    assert.throws(() => parseAgentKey('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'), (e) => e.code === 'bad_key_format', 'n itself is out of range');
    assert.throws(() => parseAgentKey('0x' + '00'.repeat(32)), (e) => e.code === 'bad_key_format');
    assert.throws(() => parseAgentKey('abandon '.repeat(12)), (e) => e.code === 'seed_phrase' && !e.message.includes('abandon'));
    assert.equal(bucketKeyFor('203.0.113.7', 'login'), '203.0.113.7');
    assert.equal(bucketKeyFor('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(bucketKeyFor('2001:db8:aaaa:bb12:1::1', 'login'), '2001:db8:aaaa:bb00::/56');
    assert.equal(bucketKeyFor('2001:db8:aaaa:bb12:1::1', 'signup48'), '2001:db8:aaaa::/48');
    assert.equal(bucketKeyFor('2001:db8:aaaa:bb12:1::1'), '2001:db8:aaaa:bb12::/64');
    let t = 0;
    const b = new TokenBuckets(RATE_LIMITS, { now: () => t });
    for (let i = 0; i < 10; i++) assert.equal(b.take('login_ip', 'k').ok, true);
    const no = b.take('login_ip', 'k');
    assert.equal(no.ok, false);
    assert.equal(no.retryAfterS, 90);
    assert.equal(b.check('login_ip', 'k').ok, false);
    t += 90_000;
    assert.equal(b.take('login_ip', 'k').ok, true);
    assert.throws(() => b.take('nope', 'k'), /unknown scope/);
  });

  it('no state-changing GET: every command is POST, every op is a query or a command', () => {
    for (const op of OPS) {
      assert.ok(op.kind === 'query' || op.kind === 'command', op.name);
      assert.equal(op.method, op.kind === 'query' ? 'GET' : 'POST', op.name);
    }
    for (const name of ['auth_logout', 'auth_logout_all', 'garden_reset', 'admin_kill_switch', 'testnet_disconnect']) assert.equal(findOp(name).kind, 'command');
    for (const name of ['auth_signup', 'auth_login', 'auth_reset', 'account_password', 'account_delete', 'testnet_connect', 'testnet_agent_approve', 'admin_user']) {
      assert.equal(findOp(name).sensitive, true, `${name} is sensitive (§5.3)`);
    }
  });

  it('every machine code the server sent during this run is published in ERROR_CODES', () => {
    assert.ok(seenCodes.size >= 25, `codes seen: ${[...seenCodes].join(', ')}`);
    for (const code of seenCodes) assert.ok(ERROR_CODES.includes(code), `${code} is in ERROR_CODES`);
    for (const code of NONE_MODE_CODES) assert.ok(ERROR_CODES.includes(code));
  });
});

// =============================================================================================

describe('strict --auth parsing and the none-mode refusals (server/main.js parseConfig, PLATFORM §2.3, §10.3)', async () => {
  const { parseConfig } = await import('../server/main.js');
  const refused = (argv, env, re) => {
    let err = null;
    try {
      parseConfig(argv, env);
    } catch (e) {
      err = e;
    }
    assert.ok(err, `refused: ${argv.join(' ')} ${JSON.stringify(Object.keys(env))}`);
    if (re) assert.match(err.message, re);
    return err;
  };
  const ORIGIN_OK = ['--public-origin', 'http://localhost:8464', '--feed', 'sim'];

  it('none is the default; a set-but-empty or unknown --auth / BEAN_AUTH is refused', () => {
    assert.equal(parseConfig([], {}).auth, 'none');
    refused(['--auth', 'bogus'], {});
    refused([], { BEAN_AUTH: '' });
    refused([], { BEAN_AUTH: 'Accounts!' });
  });

  it('none mode refuses accounts-only settings and a non-loopback HOST env (never echoing values)', () => {
    const e = refused([], { PUBLIC_ORIGIN: 'https://secret-host.example' }, /PUBLIC_ORIGIN/);
    assert.doesNotMatch(e.message, /secret-host/);
    refused([], { BEAN_AUTH: 'none', TESTNET_ENABLED: '1' }, /TESTNET_ENABLED/);
    refused([], { BEAN_AUTH: 'none', HOST: '0.0.0.0' }, /HOST/);
    assert.equal(parseConfig([], { BEAN_AUTH: 'none', HOST: '127.0.0.1' }).auth, 'none');
    refused(['--testnet-double'], {});
  });

  it('accounts mode: PUBLIC_ORIGIN required and well-formed; --token / BEAN_API_TOKEN refused', () => {
    refused(['--auth', 'accounts', '--feed', 'sim'], {}, /PUBLIC_ORIGIN|public-origin/);
    refused(['--auth', 'accounts', '--public-origin', 'http://bean.example.com'], {});
    refused(['--auth', 'accounts', '--public-origin', 'https://bean.example.com/garden'], {});
    refused(['--auth', 'accounts', ...ORIGIN_OK, '--token', 'x'.repeat(24)], {}, /ADMIN_TOKEN/);
    refused(['--auth', 'accounts', ...ORIGIN_OK], { BEAN_API_TOKEN: 'y'.repeat(24) });
    const c = parseConfig(['--auth', 'accounts', ...ORIGIN_OK], {});
    assert.equal(c.auth, 'accounts');
    assert.equal(c.publicOrigin, 'http://localhost:8464');
    assert.equal(c.token, null);
  });

  it('--testnet-double: only on a local http origin, never with TESTNET_ENABLED=1 or NODE_ENV=production', () => {
    // the testnet venue (the double included) needs real prices; parsing never touches the network
    const REAL = ['--public-origin', 'http://localhost:8464', '--feed', 'hyperliquid'];
    refused(['--auth', 'accounts', ...ORIGIN_OK, '--testnet-double'], {}, /real prices/);
    refused(['--auth', 'accounts', '--public-origin', 'https://bean.example.com', '--feed', 'hyperliquid', '--testnet-double'], {}, /localhost/);
    refused(['--auth', 'accounts', ...REAL, '--testnet-double'], { TESTNET_ENABLED: '1', BEAN_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') }, /exclusive/);
    refused(['--auth', 'accounts', ...REAL, '--testnet-double'], { NODE_ENV: 'production' }, /production/);
    assert.equal(parseConfig(['--auth', 'accounts', ...REAL, '--testnet-double'], {}).testnetDouble, true);
  });

  it('secret variables are deleted from the env once read', () => {
    const env = { BEAN_AUTH: 'accounts', PUBLIC_ORIGIN: 'http://localhost:8464', BEAN_FEED: 'sim', ADMIN_TOKEN: 'k'.repeat(40) };
    parseConfig([], env);
    assert.equal(env.ADMIN_TOKEN, undefined);
  });
});

describe('accounts mode: opening an SSE stream costs 10 query tokens (§4.5)', () => {
  let app;
  before(async () => {
    app = await buildApp();
  });
  after(async () => {
    await app.close();
  });

  it('12 opens drain the 120-token bucket; the 13th answers 429 before any stream starts', async () => {
    const opened = [];
    try {
      for (let i = 0; i < 12; i++) {
        const s = await openStream(app.port);
        opened.push(s);
        assert.equal(s.res.statusCode, 200, `open ${i + 1}`);
      }
      const last = await openStream(app.port);
      opened.push(last);
      assert.equal(last.res.statusCode, 429);
      assert.equal(last.res.headers['content-type'], 'application/json; charset=utf-8');
    } finally {
      for (const s of opened) s.close();
    }
  });
});

// =============================================================================================
// The REAL composition over HTTP: main.js buildAccounts() (WP1 platform, WP3 Gardens + Credentials, WP2 testnet
// stack) with the in-process testnet double (--testnet-double) and the offline mainnet double. This is exactly the
// platform bag main.js hands to createServer(); nothing leaves the process (global fetch is refused).

describe('accounts mode: the real composition (buildAccounts + the in-process testnet double) over HTTP', () => {
  let runtime = null;
  let acct = null;
  let server = null;
  let port = 0;
  let dir = null;
  let realFetch = null;
  const realHits = [];
  const logs = [];
  const BOOT = `boot-${crypto.randomBytes(8).toString('hex')}`;

  before(async () => {
    const { parseConfig, startRuntime, buildAccounts } = await import('../server/main.js');
    const { makeHL } = await import('./fixtures/hl-double.js');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bean-composed-'));
    realFetch = globalThis.fetch;
    // the test talks to the server through node:http; anything through the global fetch would be a real host
    globalThis.fetch = async (url) => {
      realHits.push(String(url?.url ?? url));
      throw new Error('real network reached');
    };
    const config = parseConfig(['--auth', 'accounts', '--public-origin', ORIGIN, '--testnet-double', '--data', dir,
      '--beans', '300', '--warmup', '90', '--port', '0'], { ADMIN_BOOTSTRAP_CODE: BOOT });
    config.fetch = makeHL({ get ms() { return Date.now(); } }).fetch; // the offline MAINNET double (tests only)
    ({ runtime } = await startRuntime({
      config, version: 'test', log: quiet,
      beforeStart: async (rt, cfg) => {
        acct = await buildAccounts({ config: cfg, runtime: rt, log: quiet });
      },
    }));
    // exactly main.js's createServer() call for accounts mode
    server = createServer({
      engine: runtime.engine, journal: runtime.journal, pulse: runtime.pulse, platform: acct.bag,
      config: {
        auth: 'accounts', publicOrigin: config.publicOrigin, version: 'test', feed: config.feed, log: (l) => logs.push(String(l)),
        signupMode: config.signupMode, adminTokenRemote: config.adminTokenRemote, testnetEnabled: false, testnetDouble: true,
      },
    });
    acct.gardens.setHttp(server);
    port = await listen(server);
  });

  after(async () => {
    if (server) await closeServer(server);
    runtime?.engine.stop();
    if (acct) await acct.close();
    globalThis.fetch = realFetch;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('connect → me / testnet_status / testnet_quote → testnet plant → disconnect rules → kill switch, all over HTTP', async () => {
    const spectator = client(port);
    const root = client(port);
    const nok = client(port);
    const index = await spectator.get('');
    assert.deepEqual(index.json.testnet, { enabled: true });
    const tm = await spectator.get('testnet_market');
    assert.equal(tm.status, 200, tm.text);
    assert.equal(tm.json.enabled, true);
    assert.equal(tm.json.state, 'live');
    assert.equal(tm.json.coins.length, 16);

    assert.equal((await root.post('auth_signup', { username: 'operator1', password: PW, bootstrap_code: BOOT })).json.user.role, 'admin');
    assert.equal((await nok.post('auth_signup', { username: 'nok', password: PW })).status, 200);
    expectCode(await nok.post('dev_double', { fault: 'new_account' }), 403, 'forbidden');
    const na = await root.post('dev_double', { fault: 'new_account', args: { usd: 3000 } });
    assert.equal(na.status, 200, na.text);
    const keyHex = na.json.agent_key.replace(/^0x/, '');

    const conn = await nok.post('testnet_connect', { account_address: na.json.account_address, agent_key: na.json.agent_key });
    assert.equal(conn.status, 200, conn.text);
    assert.equal(conn.json.testnet.status, 'verified');
    assert.equal(conn.json.replaced, false);
    assert.ok(Array.isArray(conn.json.warnings));
    const me = await nok.get('me');
    assert.equal(me.json.testnet.status, 'verified');
    assert.equal(me.json.testnet.account_address, na.json.account_address.toLowerCase());
    const st = await nok.get('testnet_status');
    assert.equal(st.status, 200, st.text);
    assert.equal(st.json.link.status, 'verified');
    expectCode(await spectator.get('testnet_status'), 401, 'auth_required');
    const ver = await nok.post('testnet_verify', {});
    assert.equal(ver.status, 200, ver.text);
    assert.equal(ver.json.testnet.status, 'verified');

    // a bean the quote accepts (the double's prices diverge from the sim feed: ack_divergence)
    const beans = await nok.get('beans?in_position=true&busted=false&limit=1000&sort=-fitness');
    let bean = null;
    for (const b of beans.json.rows.filter((r) => ['ETH', 'SOL', 'BTC', 'AVAX'].includes(r.coin) && !r.venue_reason).slice(0, 40)) {
      const q = await nok.get(`testnet_quote?bean=${b.id}&capital_usd=100`);
      assert.equal(q.status, 200, q.text);
      if (q.json.ok) {
        bean = b;
        break;
      }
    }
    assert.ok(bean, 'a plantable bean on testnet');
    expectCode(await nok.post('bot_create', { bean: bean.id, capital_usd: 100, venue: 'testnet' }), 400, 'confirm_required');
    const nokStream = await openStream(port, { headers: { Cookie: nok.cookieHeader() } });
    const watcher = await openStream(port);
    const bot = await nok.post('bot_create', { bean: bean.id, capital_usd: 100, venue: 'testnet', confirm: 'testnet', ack_divergence: true });
    assert.equal(bot.status, 200, bot.text);
    assert.equal(bot.json.venue, 'testnet');
    const listed = await nok.get('bots?state=open');
    assert.deepEqual(listed.json.rows.map((r) => r.venue), ['testnet']);
    // the player's stream carries their testnet records; a spectator's carries none of them
    await nokStream.until((x) => framesOf(x, 'bot_created').length >= 1);
    assert.equal(framesOf(nokStream, 'bot_created')[0].data.venue, 'testnet');
    await sleep(200);
    assert.equal(framesOf(watcher, 'bot_created').length + framesOf(watcher, 'bot_fill').length + framesOf(watcher, 'bot_sync').length, 0);
    nokStream.close();
    watcher.close();
    const ops = await root.get('admin_status');
    assert.equal(ops.status, 200, ops.text);
    assert.equal(ops.json.testnet.enabled, true);
    assert.equal(ops.json.testnet.state, 'live');
    assert.equal(ops.json.testnet.max_active_users, 40);
    assert.equal(typeof ops.json.testnet.budget, 'number');
    assert.deepEqual(ops.json.bots, { paper_open: 0, testnet_open: 1 });
    assert.ok(ops.json.db.size_bytes > 0);

    expectCode(await nok.post('testnet_disconnect', {}), 409, 'has_open_testnet_bots');
    const ks = await root.post('admin_kill_switch', { on: true, reason: 'drill' });
    assert.equal(ks.status, 200, ks.text);
    assert.equal(ks.json.kill_switch.on, true);
    assert.equal((await spectator.get('testnet_market')).json.kill_switch.on, true);
    assert.equal((await root.post('admin_kill_switch', { on: false })).json.kill_switch.on, false);

    const off = await nok.post('testnet_disconnect', { close_bots: true });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.disconnected, true);
    assert.equal((await nok.get('me')).json.testnet, null);

    for (const text of [conn.text, me.text, st.text, off.text, ...logs]) assert.ok(!text.includes(keyHex), 'the agent key never comes back');
    assert.deepEqual(realHits, [], 'zero requests to any real host');
    assert.deepEqual(acct.double.violations, []);
  });
});

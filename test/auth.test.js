// test/auth.test.js — WP1 auth (PLATFORM.md §4, §11.2 auth): usernames and password policy, scrypt format and
// parameters, the hasher's queue (one hash per IP, global semaphore, 503 busy), sign-up / sign-in / sign-out flows
// with their check orders, cookies, rotation and expiry, lockout (persisted, flood-proof, known-device exempt),
// sign-up budgets, admin bootstrap rules, retired names, session public ids, synchronous stream closing on every
// revocation path, operator reset, login_fail pseudonyms and disabled accounts.
// Offline. Flows use cheap scrypt parameters (FAST); the production parameters are asserted on their own.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPlatform } from '../server/auth/index.js';
import { parsePlatformConfig, parseAuthMode, applyEnvDefaults, PlatformConfigError } from '../server/config.js';
import {
  PasswordHasher, SCRYPT_PARAMS, hashPassword, verifyPassword, parseHash, canonicalUsername, passwordProblem, RESERVED_USERNAMES,
} from '../server/auth/passwords.js';
import { Sessions } from '../server/auth/sessions.js';
import { Secrets } from '../server/secrets.js';
import { lockoutMs, UnknownNameLockouts, RateLimiter, StreamSlots } from '../server/auth/ratelimit.js';
import { BOOTSTRAP_FILE } from '../server/auth/users.js';
import { openDb, MIGRATIONS_DIR } from '../server/db/db.js';
import { migrate } from '../server/db/migrate.js';

const FAST = { N: 1024, r: 8, p: 1 };
const PW = 'correct-horse-battery';
const PW2 = 'another-long-passphrase';
const MIN = 60_000;
const DAY = 86_400_000;

const tmpDirs = [];
const platforms = [];
after(async () => {
  for (const p of platforms) await p.close().catch(() => {});
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh accounts-mode platform on a mutable clock. */
async function boot({ env = {}, origin = 'http://localhost:8461', start = Date.UTC(2026, 9, 11, 12), dataDir = null } = {}) {
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bean-auth-'));
  if (!dataDir) tmpDirs.push(dir);
  const clock = { t: start };
  const logs = [];
  const config = { ...parsePlatformConfig({ values: {}, env: { BEAN_AUTH: 'accounts', PUBLIC_ORIGIN: origin, ...env } }), port: 8461 };
  const p = await createPlatform({ config, dataDir: dir, feed: 'sim', log: (l) => logs.push(l), now: () => clock.t, hasherParams: FAST });
  platforms.push(p);
  const closed = [];
  p.setHooks({
    closeStreams: ({ uid, sessionIds }) => closed.push({ uid, sessionIds: sessionIds ?? null, stillValid: (sessionIds ?? []).map((id) => p.sessions.stillValid(id)) }),
  });
  return { p, clock, logs, dir, closed };
}

/** A fake request: cookies from Set-Cookie strings, a peer address, extra headers. */
function req({ cookies = [], ip = '198.51.100.10', headers = {} } = {}) {
  const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
  return { headers: { 'user-agent': 'test-agent', ...(cookie ? { cookie } : {}), ...headers }, socket: { remoteAddress: ip } };
}

/** The request context the auth service expects. */
const rq = (p, opts) => p.requestContext(req(opts));

async function signup(p, username, { ip, password = PW, ...rest } = {}) {
  return p.auth.signup(rq(p, { ip }), { username, password, ...rest });
}

async function expectApi(promiseOrFn, status, code) {
  const run = typeof promiseOrFn === 'function' ? promiseOrFn : () => promiseOrFn;
  let err;
  try {
    await run();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `expected ${status} ${code}, got success`);
  assert.equal(`${err.status} ${err.code}`, `${status} ${code}`, err.message);
  return err;
}

const bootstrapCode = (dir) => fs.readFileSync(path.join(dir, BOOTSTRAP_FILE), 'utf8').trim();

// ---------------------------------------------------------------------------------------------

describe('usernames and passwords (§4.1)', () => {
  test('canonical usernames: NFKC, trimmed, lower-case, ^[a-z0-9_]{3,24}$', () => {
    assert.equal(canonicalUsername('  Nok_01 '), 'nok_01');
    assert.equal(canonicalUsername('ＮＯＫ＿０１'), 'nok_01', 'full-width forms fold under NFKC');
    for (const bad of ['ab', 'a'.repeat(25), 'nok!', 'nök', 'no k', '', null, 42]) assert.equal(canonicalUsername(bad), null, String(bad));
    for (const name of ['admin', 'root', 'hyperliquid', 'me', 'you', 'local', 'testnet']) assert.ok(RESERVED_USERNAMES.has(name));
  });

  test('password policy: 10–128 code points, ≤ 512 bytes, no username inside, not common', () => {
    assert.equal(passwordProblem('short-pw', 'nok'), 'too_short');
    assert.equal(passwordProblem('ก'.repeat(9), 'nok'), 'too_short', 'code points, not bytes');
    assert.equal(passwordProblem('ก'.repeat(10), 'nok'), null);
    assert.equal(passwordProblem('x'.repeat(129), 'nok'), 'too_long');
    assert.equal(passwordProblem('😀'.repeat(128), 'nok'), null, '128 code points = 512 bytes is allowed');
    assert.equal(passwordProblem(`${'😀'.repeat(127)}ab`, 'nok'), 'too_long', '> 512 UTF-8 bytes');
    assert.equal(passwordProblem('my-name-is-NOKK-ok', 'nokk'), 'contains_username');
    assert.equal(passwordProblem('my-name-is-nok-ok', 'nok'), null, 'a 3-char name may appear');
    assert.equal(passwordProblem('Password123', 'nok'), 'common', 'case-insensitive');
    assert.equal(passwordProblem('qwertyuiop', 'nok'), 'common');
    assert.equal(passwordProblem(PW, 'nok'), null);
  });

  test('scrypt: N=32768, r=8, p=3, 16-byte salt, 64-byte key, "scrypt$v=1$…" encoding; old hashes re-hash on login', async () => {
    assert.deepEqual({ ...SCRYPT_PARAMS }, { N: 32768, r: 8, p: 3 });
    const stored = await hashPassword(PW);
    assert.match(stored, /^scrypt\$v=1\$N=32768,r=8,p=3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    const parsed = parseHash(stored);
    assert.deepEqual([parsed.salt.length, parsed.dk.length], [16, 64]);
    assert.deepEqual(await verifyPassword(PW, stored), { ok: true, needsRehash: false });
    assert.deepEqual(await verifyPassword('wrong-password-x', stored), { ok: false, needsRehash: false });
    const weak = await hashPassword(PW, { N: 16384, r: 8, p: 1 });
    assert.deepEqual(await verifyPassword(PW, weak), { ok: true, needsRehash: true });
    assert.equal(parseHash('scrypt$v=1$N=3,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA'), null, 'N must be a power of two');

    // Through the service: a user whose stored hash is older is re-hashed with the current parameters.
    const { p } = await boot();
    await signup(p, 'rehash_me');
    const user = p.users.byName('rehash_me');
    p.db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(await hashPassword(PW, { N: 512, r: 4, p: 1 }), user.id);
    await p.auth.login(rq(p), { username: 'rehash_me', password: PW });
    assert.match(p.users.get(user.id).pw_hash, /^scrypt\$v=1\$N=1024,r=8,p=1\$/, 'now at the current (here: test) parameters');
  });
});

describe('the hasher queue (§4.1)', () => {
  test('unknown usernames still pay one scrypt against DUMMY_HASH', async () => {
    const { p } = await boot();
    await signup(p, 'known_one');
    const before = { ...p.hasher.calls };
    await expectApi(p.auth.login(rq(p), { username: 'nobody_here', password: PW }), 401, 'bad_credentials');
    assert.equal(p.hasher.calls.verify - before.verify, 1);
    assert.equal(p.hasher.calls.dummy - before.dummy, 1, 'the dummy hash was used');
    await expectApi(p.auth.login(rq(p), { username: 'known_one', password: 'wrong-password-here' }), 401, 'bad_credentials');
    assert.equal(p.hasher.calls.verify - before.verify, 2, 'a known user also pays exactly one');
    assert.equal(p.hasher.calls.dummy - before.dummy, 1);
  });

  test('one hash in flight per IP; different IPs run in parallel; > maxWaiting queued → 503 busy', async () => {
    const hasher = await new PasswordHasher({ params: { N: 8192, r: 8, p: 1 } }).init();
    const stored = await hashPassword(PW, { N: 8192, r: 8, p: 1 });
    let maxActive = 0;
    let watching = true;
    const watch = () => {
      maxActive = Math.max(maxActive, hasher.stats().active);
      if (watching) setImmediate(watch);
    };
    watch();
    await Promise.all([1, 2, 3].map(() => hasher.verify(PW, stored, { ipKey: 'same-ip' })));
    assert.equal(maxActive, 1, 'serialised per IP');
    maxActive = 0;
    await Promise.all(['a', 'b', 'c'].map((ip) => hasher.verify(PW, stored, { ipKey: ip })));
    watching = false;
    assert.ok(maxActive >= 2, `different IPs overlap (${maxActive})`);

    const tiny = await new PasswordHasher({ params: { N: 8192, r: 8, p: 1 }, maxConcurrent: 1, maxWaiting: 1 }).init();
    const runs = ['x', 'y', 'z'].map((ip) => tiny.verify(PW, stored, { ipKey: ip }).then(() => 'ok', (e) => `${e.status} ${e.code}`));
    assert.deepEqual(await Promise.all(runs), ['ok', 'ok', '503 busy']);
  });
});

describe('sign-up, sign-in, sign-out (§4.6 steps 1, 3, 4)', () => {
  test('sign-up creates the user and the garden in one go, a session and the cookies; audit signup', async () => {
    const { p } = await boot();
    const r = await signup(p, 'Nok_Garden', { lang: 'th' });
    assert.deepEqual(Object.keys(r.payload.user).sort(), ['created_ms', 'id', 'lang', 'role', 'username']);
    assert.deepEqual([r.payload.user.username, r.payload.user.role, r.payload.user.lang], ['nok_garden', 'player', 'th']);
    const garden = p.db.prepare('SELECT * FROM gardens WHERE user_id = ?').get(r.payload.user.id);
    assert.deepEqual([garden.season, garden.account_usd, garden.epoch.length], [1, 10_000, 16]);
    assert.equal(r.cookies.length, 2);
    const me = p.auth.me(rq(p, { cookies: r.cookies }));
    assert.equal(me.user.username, 'nok_garden');
    assert.deepEqual(Object.keys(me).sort(), ['mode', 'session', 'signup', 'testnet', 'user']);
    assert.equal(p.auth.me(rq(p)).user, null, 'spectators get user:null (200)');
    assert.deepEqual(p.admin.auditQuery({ action: 'signup' }).rows.map((a) => a.user_id), [r.payload.user.id]);
  });

  test('sign-up refusals: bad_username, weak_password (with reason), username_unavailable for taken / reserved / retired', async () => {
    const { p } = await boot();
    await expectApi(signup(p, 'x!'), 400, 'bad_username');
    const weak = await expectApi(signup(p, 'some_one', { password: 'qwertyuiop' }), 400, 'weak_password');
    assert.equal(weak.extra.reason, 'common');
    await signup(p, 'taken_name');
    await expectApi(signup(p, 'TAKEN_NAME'), 409, 'username_unavailable');
    await expectApi(signup(p, 'admin'), 409, 'username_unavailable');
    const gone = await signup(p, 'gone_soon');
    p.users.remove(gone.payload.user.id);
    await expectApi(signup(p, 'gone_soon'), 409, 'username_unavailable');
  });

  test('sign-in: generic 401 for a wrong password and an unknown name; success resets failures and sets both cookies', async () => {
    const { p } = await boot();
    await signup(p, 'sign_me_in');
    const a = await expectApi(p.auth.login(rq(p), { username: 'sign_me_in', password: 'wrong-password-1' }), 401, 'bad_credentials');
    const b = await expectApi(p.auth.login(rq(p), { username: 'no_such_user', password: 'wrong-password-1' }), 401, 'bad_credentials');
    assert.equal(a.message, b.message, 'identical responses for known and unknown names');
    assert.equal(p.users.byName('sign_me_in').failed_logins, 1);
    const ok = await p.auth.login(rq(p), { username: 'Sign_Me_In', password: PW });
    assert.equal(ok.payload.user.username, 'sign_me_in');
    assert.equal(p.users.byName('sign_me_in').failed_logins, 0);
    assert.ok(p.users.byName('sign_me_in').last_login_ms);
    assert.match(ok.cookies[0], /^bean_sid=[A-Za-z0-9_-]{43};/);
    assert.match(ok.cookies[1], /^bean_kd=\d+\.\d+\.[A-Za-z0-9_-]{43};/);
  });

  test('sign-out revokes the current session and clears the cookie; works without a session too', async () => {
    const { p, closed } = await boot();
    const r = await signup(p, 'logout_me');
    const ctx = rq(p, { cookies: r.cookies });
    const out = p.auth.logout(ctx);
    assert.deepEqual(out.payload, { ok: true });
    assert.equal(out.cookies[0], 'bean_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    assert.equal(p.sessions.authenticate(req({ cookies: r.cookies })), null);
    assert.deepEqual(closed.at(-1), { uid: r.payload.user.id, sessionIds: [ctx.auth.session.publicId], stillValid: [false] });
    assert.deepEqual(p.auth.logout(rq(p)).payload, { ok: true });
  });

  test('a stale session cookie on a user op → 401 session_expired and a clearing Set-Cookie', async () => {
    const { p } = await boot();
    const ctx = p.requestContext(req({ headers: { cookie: `bean_sid=${'A'.repeat(43)}` } }));
    const err = await expectApi(() => p.auth.requireUser(ctx), 401, 'session_expired');
    assert.match(err.setCookies[0], /Max-Age=0/);
    await expectApi(() => p.auth.requireUser(rq(p)), 401, 'auth_required');
  });
});

describe('cookies and sessions (§4.2)', () => {
  test('https: __Host- names with Secure; http (localhost): plain names; never a Domain; 30 / 90 days', async () => {
    const { p } = await boot({ origin: 'https://bean.example.com' });
    const r = await signup(p, 'cookie_https');
    assert.match(r.cookies[0], /^__Host-bean_sid=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    assert.match(r.cookies[1], /^__Host-bean_kd=\d+\.\d{13}\.[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=7776000$/);
    assert.equal(p.sessions.clearCookie(), '__Host-bean_sid=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
    const local = await boot();
    const l = await signup(local.p, 'cookie_http');
    assert.match(l.cookies[0], /^bean_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    for (const c of [...r.cookies, ...l.cookies]) assert.ok(!/domain=/i.test(c));
    assert.ok(!/Secure/.test(l.cookies[0]));
  });

  test('only SHA-256(token) is stored; a malformed cookie value is ignored', async () => {
    const { p } = await boot();
    const r = await signup(p, 'hash_only');
    const token = r.cookies[0].split(';')[0].split('=')[1];
    const row = p.db.prepare('SELECT token_hash, public_id FROM sessions').get();
    assert.ok(Buffer.from(row.token_hash).equals(crypto.createHash('sha256').update(Buffer.from(token, 'base64url')).digest()));
    assert.equal(row.public_id.length, 22);
    const dump = JSON.stringify(p.db.prepare('SELECT * FROM sessions').all().map((s) => ({ ...s, token_hash: Buffer.from(s.token_hash).toString('base64url') })));
    assert.ok(!dump.includes(token));
    for (const bad of [`${token}x`, token.slice(1), `${token.slice(0, 42)}!`]) {
      assert.equal(p.sessions.authenticate(req({ headers: { cookie: `bean_sid=${bad}` } })), null);
    }
  });

  test('rotation after 24 h with a 60 s grace for the previous token', async () => {
    const { p, clock } = await boot();
    const r = await signup(p, 'rotate_me');
    clock.t += DAY - 1000;
    assert.equal(p.sessions.authenticate(req({ cookies: r.cookies })).setCookie, undefined, 'not yet');
    clock.t += 2000;
    const rotated = p.sessions.authenticate(req({ cookies: r.cookies }));
    assert.match(rotated.setCookie, /^bean_sid=[A-Za-z0-9_-]{43}; /);
    assert.notEqual(rotated.setCookie.split(';')[0], r.cookies[0].split(';')[0]);
    clock.t += 59_000;
    const grace = p.sessions.authenticate(req({ cookies: r.cookies }));
    assert.ok(grace && !grace.setCookie, 'the old token works inside the grace and does not rotate again');
    assert.ok(p.sessions.authenticate(req({ cookies: [rotated.setCookie] })), 'the new token works');
    clock.t += 2000;
    assert.equal(p.sessions.authenticate(req({ cookies: r.cookies })), null, 'the old token is dead after 60 s');
    assert.ok(p.sessions.authenticate(req({ cookies: [rotated.setCookie] })));
  });

  test('idle (7 days) and absolute (30 days) expiry; last_seen is written at most every 5 min', async () => {
    const { p, clock } = await boot();
    const r = await signup(p, 'expire_me');
    const seen = () => p.db.prepare('SELECT last_seen_ms FROM sessions').get().last_seen_ms;
    const t0 = seen();
    clock.t += 4 * MIN;
    p.sessions.authenticate(req({ cookies: r.cookies }));
    assert.equal(seen(), t0, 'no write within 5 min');
    clock.t += 2 * MIN;
    p.sessions.authenticate(req({ cookies: r.cookies }));
    assert.equal(seen(), clock.t);
    clock.t += 7 * DAY + 1;
    assert.equal(p.sessions.authenticate(req({ cookies: r.cookies })), null, 'idle for 7 days');

    const s = await signup(p, 'absolute_me');
    let cookies = s.cookies;
    for (let day = 0; day < 31; day += 1) {
      clock.t += DAY;
      const a = p.sessions.authenticate(req({ cookies }));
      if (day < 29) {
        assert.ok(a, `alive on day ${day + 1}`);
        if (a.setCookie) cookies = [a.setCookie];
      } else {
        assert.equal(a, null, `dead on day ${day + 1} (absolute 30 days)`);
      }
    }
  });

  test('at most 20 live sessions per user: the 21st revokes the oldest (and closes its streams)', async () => {
    const { p, clock, closed } = await boot();
    const first = await signup(p, 'many_tabs');
    const firstId = p.sessions.authenticate(req({ cookies: first.cookies })).session.publicId;
    for (let i = 0; i < 20; i += 1) {
      clock.t += 1000;
      await p.auth.login(rq(p, { ip: `198.51.100.${i + 20}` }), { username: 'many_tabs', password: PW });
    }
    assert.equal(p.sessions.authenticate(req({ cookies: first.cookies })), null, 'the oldest was revoked');
    assert.equal(p.sessions.list(first.payload.user.id).length, 20);
    assert.ok(closed.some((c) => c.sessionIds?.includes(firstId)));
  });

  test('player A revoking B\'s session public_id gets 404 and B\'s session survives; own sessions list and revoke', async () => {
    const { p } = await boot();
    const a = await signup(p, 'player_a', { ip: '198.51.100.1' });
    const b = await signup(p, 'player_b', { ip: '198.51.100.2' });
    const bCtx = rq(p, { cookies: b.cookies });
    const aCtx = rq(p, { cookies: a.cookies });
    const bId = bCtx.auth.session.publicId;
    await expectApi(() => p.auth.revokeSession(aCtx, { id: bId }), 404, 'not_found');
    assert.ok(p.sessions.authenticate(req({ cookies: b.cookies })), 'B survives');
    await expectApi(() => p.auth.revokeSession(aCtx, { id: 'not-a-real-id' }), 404, 'not_found');
    const listed = p.auth.listSessions(bCtx).rows;
    assert.deepEqual(listed.map((r) => [r.id, r.current, r.user_agent, r.ip_prefix]), [[bId, true, 'test-agent', '198.51.100.0/24']]);
    assert.ok(!('token_hash' in listed[0]) && !Number.isInteger(listed[0].id), 'only the opaque public id leaves');
    assert.deepEqual(p.auth.revokeSession(bCtx, { id: bId }).payload, { ok: true });
    assert.equal(p.sessions.authenticate(req({ cookies: b.cookies })), null);
  });
});

describe('lockout and IP limits (§4.5)', () => {
  test('lockout formula: from the 5th consecutive failure, 2^(f−5) min, capped at 60', () => {
    assert.deepEqual([4, 5, 6, 7, 8, 10, 11, 12, 30].map((f) => lockoutMs(f) / MIN), [0, 1, 2, 4, 8, 32, 60, 60, 60]);
  });

  test('5 failures lock the name (persisted); the right password then gets the same generic 429; unlock after the delay', async () => {
    const { p, clock } = await boot();
    await signup(p, 'lock_me');
    for (let i = 0; i < 5; i += 1) {
      await expectApi(p.auth.login(rq(p, { ip: `203.0.113.${i}` }), { username: 'lock_me', password: 'wrong-password-x' }), 401, 'bad_credentials');
    }
    const row = p.users.byName('lock_me');
    assert.equal(row.failed_logins, 5);
    assert.equal(row.locked_until_ms, clock.t + MIN);
    const before = p.hasher.calls.verify;
    const locked = await expectApi(p.auth.login(rq(p, { ip: '203.0.113.50' }), { username: 'lock_me', password: PW }), 429, 'rate_limited');
    assert.ok(locked.extra.retry_after_s >= 1 && locked.headers['Retry-After']);
    assert.equal(p.hasher.calls.verify, before, 'a locked name never reaches scrypt');
    clock.t += MIN + 1;
    await expectApi(p.auth.login(rq(p, { ip: '203.0.113.51' }), { username: 'lock_me', password: 'wrong-password-x' }), 401, 'bad_credentials');
    assert.equal(p.users.byName('lock_me').locked_until_ms, clock.t + 2 * MIN, 'the 6th failure locks for 2 min');
    clock.t += 2 * MIN + 1;
    assert.ok((await p.auth.login(rq(p, { ip: '203.0.113.52' }), { username: 'lock_me', password: PW })).payload.user);
    assert.equal(p.users.byName('lock_me').failed_logins, 0, 'reset on success');
  });

  test('unknown usernames lock too (same answer), from a bounded store that answers "locked" when full', async () => {
    const { p } = await boot();
    for (let i = 0; i < 5; i += 1) {
      await expectApi(p.auth.login(rq(p, { ip: `203.0.113.${i}` }), { username: 'ghost_user', password: 'wrong-password-x' }), 401, 'bad_credentials');
    }
    await expectApi(p.auth.login(rq(p, { ip: '203.0.113.99' }), { username: 'ghost_user', password: 'wrong-password-x' }), 429, 'rate_limited');
    const store = new UnknownNameLockouts({ maxKeys: 3 });
    for (const n of ['a1', 'a2', 'a3']) store.recordFailure(n);
    assert.equal(store.isLocked('a4').locked, true, 'full: a new unknown name is answered as locked');
    assert.equal(store.isLocked('a1').locked, false, 'existing entries are not evicted');
    assert.equal(store.size, 3);
  });

  test('the per-IP login bucket (10, refill 1 / 90 s) refuses before lockout and scrypt', async () => {
    const { p, clock } = await boot();
    await signup(p, 'ip_limited');
    const ip = '192.0.2.77';
    for (let i = 0; i < 10; i += 1) {
      await expectApi(p.auth.login(rq(p, { ip }), { username: `nobody_${i}`, password: 'wrong-password-x' }), 401, 'bad_credentials');
    }
    const before = p.hasher.calls.verify;
    await expectApi(p.auth.login(rq(p, { ip }), { username: 'ip_limited', password: PW }), 429, 'rate_limited');
    assert.equal(p.hasher.calls.verify, before, 'refused before scrypt');
    assert.equal(p.users.byName('ip_limited').failed_logins, 0, 'and before the lockout counter');
    clock.t += 90_000;
    assert.ok((await p.auth.login(rq(p, { ip }), { username: 'ip_limited', password: PW })).payload.user, 'one token refilled');
  });

  test('flooding 60,000 distinct IP keys does not reset a locked username', async () => {
    const { p } = await boot();
    await signup(p, 'flood_target');
    for (let i = 0; i < 5; i += 1) {
      await expectApi(p.auth.login(rq(p, { ip: `203.0.113.${i}` }), { username: 'flood_target', password: 'wrong-password-x' }), 401, 'bad_credentials');
    }
    for (let i = 0; i < 60_000; i += 1) p.limiter.take('login_ip', `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    for (let i = 0; i < 1000; i += 1) p.lockouts.recordFailure(`flood_${i}`);
    assert.ok(p.limiter.sizes().login_ip <= 50_000, 'the IP store stays bounded');
    await expectApi(p.auth.login(rq(p, { ip: '198.18.0.1' }), { username: 'flood_target', password: PW }), 429, 'rate_limited');
  });

  test('a known-device cookie bypasses the lockout for its own user only; a password change invalidates it', async () => {
    const { p } = await boot();
    const a = await signup(p, 'device_owner');
    const b = await signup(p, 'other_owner', { ip: '198.51.100.99' });
    const kdA = a.cookies[1];
    const kdB = b.cookies[1];
    for (let i = 0; i < 5; i += 1) {
      await expectApi(p.auth.login(rq(p, { ip: `203.0.113.${i}` }), { username: 'device_owner', password: 'wrong-password-x' }), 401, 'bad_credentials');
    }
    await expectApi(p.auth.login(rq(p, { ip: '203.0.113.60', cookies: [kdB] }), { username: 'device_owner', password: PW }), 429, 'rate_limited');
    const ok = await p.auth.login(rq(p, { ip: '203.0.113.61', cookies: [kdA] }), { username: 'device_owner', password: PW });
    assert.equal(ok.payload.user.username, 'device_owner');
    // Password change: every known-device cookie of the user stops matching (pw_changed_ms is in the MAC).
    const user = p.users.byName('device_owner');
    assert.ok(p.sessions.checkKnownDevice(req({ cookies: [kdA] }), user));
    const ctx = rq(p, { cookies: ok.cookies });
    await p.auth.changePassword(ctx, { current_password: PW, new_password: PW2 });
    assert.equal(p.sessions.checkKnownDevice(req({ cookies: [kdA] }), p.users.byName('device_owner')), false);
    // Forged / tampered cookies fail.
    const [uid, exp, mac] = kdA.split(';')[0].split('=')[1].split('.');
    assert.equal(p.sessions.checkKnownDevice(req({ headers: { cookie: `bean_kd=${uid}.${Number(exp) + 1}.${mac}` } }), user), false);
  });
});

describe('sign-up budgets (§4.5)', () => {
  test('the enumeration bucket counts every attempt (409s included): 10 per hour per IP', async () => {
    const { p } = await boot();
    await signup(p, 'exists_already', { ip: '198.51.100.200' });
    const ip = '192.0.2.10';
    for (let i = 0; i < 10; i += 1) await expectApi(signup(p, 'exists_already', { ip }), 409, 'username_unavailable');
    await expectApi(signup(p, 'fresh_name', { ip }), 429, 'rate_limited');
  });

  test('creations: 3 per hour per IP, 10 per /48, global SIGNUP_MAX_PER_HOUR → 503 signup_busy; failures cost no budget', async () => {
    const { p, clock } = await boot({ env: { SIGNUP_MAX_PER_HOUR: '14' } });
    for (let i = 0; i < 3; i += 1) await signup(p, `same_ip_${i}`, { ip: '192.0.2.20' });
    const perIp = await expectApi(signup(p, 'same_ip_3', { ip: '192.0.2.20' }), 429, 'rate_limited');
    assert.ok(perIp.extra.retry_after_s > 0);
    // Ten /56s inside one /48: the per-/48 budget stops the 11th.
    for (let i = 0; i < 10; i += 1) await signup(p, `prefix_${i}`, { ip: `2001:db8:77:${(i * 256).toString(16)}::1` });
    await expectApi(signup(p, 'prefix_10', { ip: '2001:db8:77:a00::1' }), 429, 'rate_limited');
    // 13 created so far; junk attempts never consume the global cap.
    for (let i = 0; i < 5; i += 1) await expectApi(signup(p, 'x', { ip: `192.0.2.${100 + i}` }), 400, 'bad_username');
    await signup(p, 'number_14', { ip: '192.0.2.30' });
    const busy = await expectApi(signup(p, 'number_15', { ip: '192.0.2.31' }), 503, 'signup_busy');
    assert.ok(busy.extra.retry_after_s > 0 && busy.headers['Retry-After']);
    assert.equal(p.users.count(), 14);
    clock.t += 3_600_000;
    await signup(p, 'number_15', { ip: '192.0.2.31' });
  });

  test('a creation refused after the budgets were taken gives them back', async () => {
    const limiter = new RateLimiter({ signupMaxPerHour: 1 });
    limiter.enforce('signup_global', 'global');
    assert.equal(limiter.take('signup_global', 'global').ok, false);
    limiter.refund('signup_global', 'global');
    assert.equal(limiter.take('signup_global', 'global').ok, true);
  });

  test('SIGNUP_MODE closed → 403 signup_closed (the bootstrap code still works); invite needs a valid code (P1)', async () => {
    const closed = await boot({ env: { SIGNUP_MODE: 'closed' } });
    await expectApi(signup(closed.p, 'cannot_join'), 403, 'signup_closed');
    const first = await signup(closed.p, 'first_admin', { bootstrap_code: bootstrapCode(closed.dir) });
    assert.equal(first.payload.user.role, 'admin');
    const inv = await boot({ env: { SIGNUP_MODE: 'invite' } });
    await expectApi(signup(inv.p, 'no_invite'), 403, 'signup_closed');
    await expectApi(signup(inv.p, 'bad_invite', { invite: 'NOPE-NOPE-NOPE' }), 403, 'signup_closed');
    const { code } = inv.p.users.createInvite({});
    assert.equal((await signup(inv.p, 'invited_one', { invite: code.toLowerCase() })).payload.user.username, 'invited_one');
    await expectApi(signup(inv.p, 'invited_two', { invite: code, ip: '198.51.100.77' }), 403, 'signup_closed', 'single use');
  });
});

describe('admin bootstrap and roles (§4.6 step 2)', () => {
  test('the generated code is written to a 0600 file, never logged, and deleted once an admin exists', async () => {
    const { p, dir, logs } = await boot();
    const file = path.join(dir, BOOTSTRAP_FILE);
    const code = bootstrapCode(dir);
    assert.match(code, /^[A-HJ-NP-Z2-9]{12}$/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(logs.some((l) => l.includes(`admin bootstrap code written to ${file}`)));
    assert.ok(!logs.join('\n').includes(code), 'never logged');
    await expectApi(signup(p, 'wrong_code', { bootstrap_code: 'AAAAAAAAAAAA' }), 403, 'forbidden');
    const admin = await signup(p, 'the_admin', { bootstrap_code: code.toLowerCase() });
    assert.equal(admin.payload.user.role, 'admin');
    assert.ok(!fs.existsSync(file), 'deleted');
    assert.equal(p.db.prepare("SELECT count(*) AS n FROM admin_state WHERE key = 'bootstrap_used'").get().n, 1);
    await expectApi(signup(p, 'second_try', { bootstrap_code: code }), 403, 'forbidden', 'the code is dead once an admin exists');
    assert.deepEqual(p.admin.auditQuery({ action: 'admin_bootstrap' }).rows.map((r) => r.user_id), [admin.payload.user.id]);
    assert.ok(!logs.join('\n').includes(code));
  });

  test('signing up as a name in ADMIN_USERNAMES without the bootstrap code gives 409 and no admin', async () => {
    const { p, dir } = await boot({ env: { ADMIN_USERNAMES: 'boss_name, other_boss' } });
    await expectApi(signup(p, 'boss_name'), 409, 'username_unavailable');
    await expectApi(signup(p, 'BOSS_NAME', { bootstrap_code: 'WRONGWRONG22' }), 403, 'forbidden');
    assert.equal(p.users.countAdmins(), 0);
    const boss = await signup(p, 'boss_name', { bootstrap_code: bootstrapCode(dir) });
    assert.equal(boss.payload.user.role, 'admin');
  });

  test('ADMIN_USERNAMES promotes EXISTING users at boot only, and never creates one', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bean-auth-'));
    tmpDirs.push(dataDir);
    const first = await boot({ dataDir });
    await signup(first.p, 'carol_now');
    await first.p.close();
    const second = await boot({ dataDir, env: { ADMIN_USERNAMES: 'carol_now,dave_later' } });
    assert.equal(second.p.users.byName('carol_now').role, 'admin');
    assert.equal(second.p.users.byName('dave_later'), null, 'not created');
    assert.ok(second.logs.some((l) => /promoted existing user\(s\): carol_now/.test(l)));
    assert.ok(!fs.existsSync(path.join(dataDir, BOOTSTRAP_FILE)), 'an admin exists: no bootstrap file');
    await expectApi(signup(second.p, 'dave_later'), 409, 'username_unavailable', 'a listed name still needs the code');
  });

  test('a deleted admin\'s name can never be re-registered', async () => {
    const { p, dir } = await boot();
    const admin = await signup(p, 'old_admin', { bootstrap_code: bootstrapCode(dir) });
    p.users.remove(admin.payload.user.id);
    await expectApi(signup(p, 'old_admin'), 409, 'username_unavailable');
    await expectApi(signup(p, 'Old_Admin'), 409, 'username_unavailable');
  });

  test('role changes need an admin session + the admin\'s password, never the Bearer token; the last admin stays', async () => {
    const { p, dir, closed } = await boot();
    const admin = await signup(p, 'root_like', { bootstrap_code: bootstrapCode(dir) });
    const player = await signup(p, 'promote_me', { ip: '198.51.100.3' });
    const actor = { id: admin.payload.user.id };
    await expectApi(p.admin.userAction({ actor: null, viaBearer: true, username: 'promote_me', action: 'make_admin' }), 403, 'session_required');
    await expectApi(p.admin.userAction({ actor, username: 'promote_me', action: 'make_admin', password: 'wrong-password-x' }), 401, 'bad_credentials');
    const r = await p.admin.userAction({ actor, username: 'promote_me', action: 'make_admin', password: PW });
    assert.equal(r.user.role, 'admin');
    assert.equal(p.sessions.authenticate(req({ cookies: player.cookies })), null, 'role changes revoke the target\'s sessions');
    assert.equal(closed.at(-1).uid, player.payload.user.id);
    await p.admin.userAction({ actor, username: 'promote_me', action: 'remove_admin', password: PW });
    await expectApi(p.admin.userAction({ actor, username: 'root_like', action: 'remove_admin', password: PW }), 409, 'conflict');
  });
});

describe('revocation paths close streams in the same tick (§4.2)', () => {
  test('logout_all, password change, session_revoke, admin revoke_sessions / disable / role change, reset, deletion', async () => {
    const { p, dir, closed } = await boot();
    const admin = await signup(p, 'ops_admin', { bootstrap_code: bootstrapCode(dir) });
    const actor = { id: admin.payload.user.id };
    const fresh = async (name, ip) => {
      const r = await signup(p, name, { ip });
      const ctx = rq(p, { cookies: r.cookies, ip });
      return { r, ctx, uid: r.payload.user.id, sid: ctx.auth.session.publicId };
    };
    const lastFor = (uid) => closed.filter((c) => c.uid === uid).at(-1);
    const assertClosed = (uid, sid, label) => {
      const c = lastFor(uid);
      assert.ok(c, `${label}: streams closed`);
      if (sid) {
        assert.ok(c.sessionIds.includes(sid), `${label}: the session id`);
        assert.ok(c.stillValid.every((v) => v === false), `${label}: revoked BEFORE the streams were closed`);
      }
    };

    let u = await fresh('path_logout_all', '198.51.100.31');
    assert.equal(p.auth.logoutAll(u.ctx).payload.revoked, 1);
    assertClosed(u.uid, u.sid, 'logout_all');

    u = await fresh('path_password', '198.51.100.32');
    const changed = await p.auth.changePassword(u.ctx, { current_password: PW, new_password: PW2 });
    assertClosed(u.uid, u.sid, 'password change');
    assert.equal(p.sessions.authenticate(req({ cookies: u.r.cookies })), null);
    assert.ok(p.sessions.authenticate(req({ cookies: changed.cookies })), 'the caller gets a fresh session');
    await expectApi(p.auth.changePassword(rq(p, { cookies: changed.cookies }), { current_password: 'wrong-password-x', new_password: PW }), 401, 'bad_credentials');

    u = await fresh('path_revoke', '198.51.100.33');
    p.auth.revokeSession(u.ctx, { id: u.sid });
    assertClosed(u.uid, u.sid, 'session_revoke');

    u = await fresh('path_admin_revoke', '198.51.100.34');
    await p.admin.userAction({ actor, username: 'path_admin_revoke', action: 'revoke_sessions' });
    assertClosed(u.uid, u.sid, 'admin revoke_sessions');

    u = await fresh('path_disable', '198.51.100.35');
    const torn = [];
    p.setHooks({ teardown: (uid) => torn.push(uid), haltGarden: async () => ({}) });
    await p.admin.userAction({ actor, username: 'path_disable', action: 'disable' });
    assertClosed(u.uid, u.sid, 'disable');
    assert.deepEqual(torn, [u.uid], 'teardown after the halt');

    u = await fresh('path_role', '198.51.100.36');
    await p.admin.userAction({ actor, username: 'path_role', action: 'make_admin', password: PW });
    assertClosed(u.uid, u.sid, 'role change');

    u = await fresh('path_reset', '198.51.100.37');
    const { code } = await p.admin.userAction({ actor, username: 'path_reset', action: 'reset_password' });
    await p.auth.reset(rq(p, { ip: '198.51.100.38' }), { username: 'path_reset', code, new_password: PW2 });
    assertClosed(u.uid, u.sid, 'password reset');

    u = await fresh('path_delete', '198.51.100.39');
    await p.auth.deleteAccount(u.ctx, { password: PW, confirm: 'DELETE' });
    assert.equal(lastFor(u.uid).uid, u.uid, 'account deletion closes the uid\'s streams');
    assert.equal(p.users.get(u.uid), null);
  });
});

describe('account deletion (§4.6 step 6)', () => {
  test('needs confirm DELETE and the password; runs the garden hook before the DELETE; clears the cookie; audited', async () => {
    const { p } = await boot();
    const r = await signup(p, 'delete_flow');
    const uid = r.payload.user.id;
    const ctx = rq(p, { cookies: r.cookies });
    await expectApi(p.auth.deleteAccount(ctx, { password: PW, confirm: 'delete' }), 400, 'confirm_required');
    await expectApi(p.auth.deleteAccount(ctx, { password: 'wrong-password-x', confirm: 'DELETE' }), 401, 'bad_credentials');
    // The garden hook may refuse (testnet positions open) — nothing is deleted then.
    p.setHooks({
      deleteGarden: async (id, { force }) => {
        assert.ok(p.users.get(id), 'the user still exists while the garden halts');
        if (!force) throw Object.assign(new Error('positions'), { status: 409, code: 'testnet_positions_open' });
        return { closed: ['bot-0001'], testnet_left_open: [{ coin: 'BTC', szi: 0.01 }] };
      },
    });
    await expectApi(p.auth.deleteAccount(ctx, { password: PW, confirm: 'DELETE' }), 409, 'testnet_positions_open');
    assert.ok(p.users.get(uid));
    const out = await p.auth.deleteAccount(ctx, { password: PW, confirm: 'DELETE', force: true });
    assert.deepEqual(out.payload, { deleted: true, closed: ['bot-0001'], testnet_left_open: [{ coin: 'BTC', szi: 0.01 }] });
    assert.match(out.cookies[0], /Max-Age=0/);
    assert.equal(p.users.get(uid), null);
    assert.equal(p.admin.auditQuery({ action: 'account_deleted' }).rows[0].user_id, uid);
  });

  test('account_password / account_delete: 5 per 15 min per user', async () => {
    const { p } = await boot();
    const r = await signup(p, 'slow_down');
    const ctx = rq(p, { cookies: r.cookies });
    for (let i = 0; i < 5; i += 1) {
      await expectApi(p.auth.deleteAccount(ctx, { password: 'wrong-password-x', confirm: 'DELETE' }), 401, 'bad_credentials');
    }
    await expectApi(p.auth.changePassword(ctx, { current_password: PW, new_password: PW2 }), 429, 'rate_limited');
  });
});

describe('operator password reset (§4.6 step 8)', () => {
  test('the code is shown once, wipes the testnet credential first, works once and expires after 24 h', async () => {
    const { p, dir, clock } = await boot();
    const admin = await signup(p, 'reset_admin', { bootstrap_code: bootstrapCode(dir) });
    const actor = { id: admin.payload.user.id };
    const player = await signup(p, 'forgetful', { ip: '198.51.100.40' });
    const uid = player.payload.user.id;
    p.db.prepare(`INSERT INTO credentials (user_id, venue, account_address, agent_address, key_ct, key_iv, key_tag, key_id, status, created_ms, updated_ms)
      VALUES (?, 'hl_testnet', ?, ?, randomblob(32), randomblob(12), randomblob(16), '0123456789abcdef', 'verified', 1, 1)`)
      .run(uid, `0x${'1'.repeat(40)}`, `0x${'2'.repeat(40)}`);
    const order = [];
    const notified = [];
    p.setHooks({
      disconnectTestnet: async (id, { reason }) => {
        order.push(`wipe:${reason}`);
        p.db.prepare('DELETE FROM credentials WHERE user_id = ?').run(id);
      },
      notifyUser: (id, kind) => notified.push([id, kind]),
    });
    const issued = await p.admin.userAction({ actor, username: 'forgetful', action: 'reset_password' });
    order.push('issued');
    assert.deepEqual(order, ['wipe:password_reset', 'issued']);
    assert.match(issued.code, /^[A-HJ-NP-Z2-9]{12}$/);
    assert.equal(issued.expires_ms, clock.t + DAY);
    assert.equal(p.db.prepare('SELECT count(*) AS n FROM credentials WHERE user_id = ?').get(uid).n, 0);
    assert.deepEqual(notified, [[uid, 'password_reset']]);
    const stored = p.users.get(uid);
    assert.equal(Buffer.from(stored.reset_hash).length, 32, 'only SHA-256(code) is stored');
    assert.ok(!JSON.stringify(p.db.prepare('SELECT * FROM audit_log').all()).includes(issued.code), 'never audited');
    // The next sign-in (old password) shows the notice.
    assert.equal((await p.auth.login(rq(p, { ip: '198.51.100.41' }), { username: 'forgetful', password: PW })).payload.notice, 'password_reset');
    // Redeem: weak password refused first; then works once.
    await expectApi(p.auth.reset(rq(p, { ip: '198.51.100.42' }), { username: 'forgetful', code: issued.code, new_password: 'short' }), 400, 'weak_password');
    const used = await p.auth.reset(rq(p, { ip: '198.51.100.42' }), { username: 'forgetful', code: issued.code, new_password: PW2 });
    assert.equal(used.payload.user.username, 'forgetful');
    assert.equal(p.sessions.authenticate(req({ cookies: player.cookies })), null, 'old sessions revoked');
    await expectApi(p.auth.reset(rq(p, { ip: '198.51.100.43' }), { username: 'forgetful', code: issued.code, new_password: PW }), 401, 'bad_credentials');
    assert.ok((await p.auth.login(rq(p, { ip: '198.51.100.44' }), { username: 'forgetful', password: PW2 })).payload.user);
    // Expiry.
    const second = await p.admin.userAction({ actor, username: 'forgetful', action: 'reset_password' });
    clock.t += DAY + 1;
    await expectApi(p.auth.reset(rq(p, { ip: '198.51.100.45' }), { username: 'forgetful', code: second.code, new_password: PW }), 401, 'bad_credentials');
    assert.deepEqual(p.admin.auditQuery({ action: 'password_reset_issued' }).rows.length, 2);
    assert.deepEqual(p.admin.auditQuery({ action: 'password_reset_used' }).rows.length, 1);
  });

  test('a wrong reset code counts as a login failure for that name', async () => {
    const { p } = await boot();
    await signup(p, 'reset_victim');
    for (let i = 0; i < 5; i += 1) {
      await expectApi(p.auth.reset(rq(p, { ip: `203.0.113.${i}` }), { username: 'reset_victim', code: 'ABCDEFGHJKLM', new_password: PW2 }), 401, 'bad_credentials');
    }
    assert.equal(p.users.byName('reset_victim').failed_logins, 5);
    await expectApi(p.auth.login(rq(p, { ip: '203.0.113.90' }), { username: 'reset_victim', password: PW }), 429, 'rate_limited');
  });
});

describe('audit and disabled accounts (§4.6 steps 3 and 7)', () => {
  test('login_fail rows never contain a typed unknown username (only h:<hmac>), and IPs only as hashes', async () => {
    const { p } = await boot();
    const typed = 'MyPasswordTypedHere123';
    await expectApi(p.auth.login(rq(p, { ip: '198.51.100.50' }), { username: typed, password: 'whatever-long' }), 401, 'bad_credentials');
    await expectApi(p.auth.login(rq(p, { ip: '198.51.100.50' }), { username: 'nobody_xyz', password: 'whatever-long' }), 401, 'bad_credentials');
    const rows = p.db.prepare("SELECT * FROM audit_log WHERE action = 'login_fail' ORDER BY id").all();
    assert.equal(rows.length, 2);
    const dump = JSON.stringify(rows);
    assert.ok(!dump.toLowerCase().includes(typed.toLowerCase()) && !dump.includes('nobody_xyz'));
    for (const row of rows) {
      assert.match(row.target, /^h:[0-9a-f]{16}$/);
      assert.match(row.ip_hash, /^[0-9a-f]{16}$/);
      assert.equal(row.user_id, null);
    }
    assert.equal(rows[1].target, `h:${p.secrets.hmacName('nobody_xyz')}`, 'correlatable across attempts');
    assert.ok(!dump.includes('198.51.100'));
    assert.throws(() => p.admin.audit({ action: 'made_up_action' }), /allowlist/);
    p.admin.audit({ action: 'garden_halt', userId: 1, detail: { reason: 'x', password: 'nope', coin: 'BTC' } });
    assert.deepEqual(p.admin.auditQuery({ action: 'garden_halt' }).rows[0].detail, { reason: 'x', coin: 'BTC' }, 'detail allowlist');
  });

  test('disabled: sessions revoked; sign-in answers 403 account_disabled only after a correct password; enable restores', async () => {
    const { p, dir } = await boot();
    const admin = await signup(p, 'the_operator', { bootstrap_code: bootstrapCode(dir) });
    const u = await signup(p, 'bad_actor', { ip: '198.51.100.60' });
    await p.admin.userAction({ actor: { id: admin.payload.user.id }, username: 'bad_actor', action: 'disable' });
    assert.equal(p.sessions.authenticate(req({ cookies: u.cookies })), null);
    await expectApi(p.auth.login(rq(p, { ip: '198.51.100.61' }), { username: 'bad_actor', password: 'wrong-password-x' }), 401, 'bad_credentials');
    await expectApi(p.auth.login(rq(p, { ip: '198.51.100.61' }), { username: 'bad_actor', password: PW }), 403, 'account_disabled');
    await p.admin.userAction({ actor: { id: admin.payload.user.id }, username: 'bad_actor', action: 'enable' });
    assert.ok((await p.auth.login(rq(p, { ip: '198.51.100.62' }), { username: 'bad_actor', password: PW })).payload.user);
    await expectApi(p.admin.userAction({ actor: { id: admin.payload.user.id }, username: 'the_operator', action: 'disable' }), 409, 'conflict');
  });
});

describe('admin service (§8.6)', () => {
  test('kill switch, signing halt and caps persist in admin_state and are audited; caps are validated', async () => {
    const { p, dir } = await boot();
    const ks = p.admin.setKillSwitch(true, 'incident', null);
    assert.deepEqual([ks.on, ks.reason, typeof ks.since_ms], [true, 'incident', 'number']);
    assert.deepEqual(p.admin.setKillSwitch(false), { on: false, reason: null, since_ms: null });
    assert.equal(p.admin.setSigningHalt(true, 'User or API Wallet 0xabc does not exist.').halted, true);
    assert.equal(p.admin.getSigningHalt().halted, true);
    p.admin.setSigningHalt(false);
    assert.deepEqual(p.admin.getCaps().testnet, { max_bots: 3, min_capital_usd: 20, max_bot_capital_usd: 500, max_total_notional_usd: 3000 });
    const caps = p.admin.setCaps({ testnet: { max_bots: 2 } });
    assert.equal(caps.testnet.max_bots, 2);
    for (const bad of [{ testnet: { max_bots: 2.5 } }, { testnet: { max_bots: 11 } }, { paper: { nope: 1 } }, { live: {} },
      { testnet: { min_capital_usd: 600 } }, { paper: { account_usd: -1 } }]) {
      await expectApi(() => p.admin.setCaps(bad), 400, 'bad_request');
    }
    const actions = p.admin.auditQuery({}).rows.map((r) => r.action);
    for (const a of ['admin_kill_switch', 'testnet_signing_halted', 'admin_caps']) assert.ok(actions.includes(a), a);
    // admin_users: LIKE wildcards in q are escaped; addresses truncated; q ≤ 24 chars.
    await signup(p, 'under_score', { bootstrap_code: bootstrapCode(dir) });
    await signup(p, 'underxscore', { ip: '198.51.100.70' });
    assert.deepEqual(p.admin.listUsers({ q: 'under_' }).rows.map((r) => r.username), ['under_score']);
    assert.deepEqual(p.admin.listUsers({ q: '%' }).rows, []);
    await expectApi(() => p.admin.listUsers({ q: 'x'.repeat(25) }), 400, 'bad_request');
    assert.equal(p.admin.listUsers({}).total_capped, 2);
  });

  test('StreamSlots: ≤ 5 per user, ≤ 20 per IP, spectators ≤ their share of the total', () => {
    const slots = new StreamSlots({ perUser: 2, perIp: 3, total: 4, spectators: 2 });
    const a = slots.acquire({ uid: 1, ipKey: 'ip1' });
    slots.acquire({ uid: 1, ipKey: 'ip1' });
    assert.deepEqual(slots.acquire({ uid: 1, ipKey: 'ip2' }), { ok: false, reason: 'user' });
    slots.acquire({ uid: null, ipKey: 'ip1' });
    assert.deepEqual(slots.acquire({ uid: 2, ipKey: 'ip1' }), { ok: false, reason: 'ip' });
    assert.deepEqual(slots.acquire({ uid: null, ipKey: 'ip9' }).ok, true);
    assert.deepEqual(slots.acquire({ uid: null, ipKey: 'ip8' }), { ok: false, reason: 'total' });
    a.release();
    a.release();
    assert.deepEqual(slots.stats(), { total: 3, spectators: 2 });
    assert.deepEqual(slots.acquire({ uid: null, ipKey: 'ip7' }), { ok: false, reason: 'spectators' });
    assert.equal(slots.acquire({ uid: 3, ipKey: 'ip7' }).ok, true, 'a signed-in player still connects');
  });
});

test('Sessions refuses to work without secrets; the DB keeps only public ids for clients', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bean-auth-'));
  tmpDirs.push(dir);
  const db = openDb({ file: path.join(dir, 'bean.db') });
  migrate(db, MIGRATIONS_DIR);
  assert.throws(() => new Sessions(db, { publicOrigin: 'http://localhost:1' }), /secrets/);
  const s = new Sessions(db, { publicOrigin: 'http://localhost:1', secrets: new Secrets({ auditSalt: crypto.randomBytes(32) }) });
  assert.deepEqual(s.names, { sid: 'bean_sid', kd: 'bean_kd' });
  db.close();
});

describe('config: strict --auth and the mode refusals (§2.3, §10.3)', () => {
  const ok = (env, values = {}) => parsePlatformConfig({ values, env: { ...env } });
  const refused = (env, values, re) => assert.throws(() => parsePlatformConfig({ values, env: { ...env } }),
    (err) => err instanceof PlatformConfigError && err.exitCode === 2 && re.test(err.message), String(re));
  const ACC = { BEAN_AUTH: 'accounts', PUBLIC_ORIGIN: 'https://bean.example.com' };

  test('BEAN_AUTH / --auth must be exactly none or accounts; set-but-empty exits 2; the flag wins', () => {
    assert.deepEqual(ok({}), { auth: 'none' });
    assert.deepEqual(ok({ BEAN_AUTH: 'none' }), { auth: 'none' });
    for (const bad of ['', 'Accounts', 'account', ' none', 'true']) refused({ BEAN_AUTH: bad }, {}, /BEAN_AUTH/);
    refused({}, { auth: '' }, /--auth/);
    refused({}, { auth: 'ACCOUNTS' }, /--auth/);
    assert.equal(ok({ BEAN_AUTH: 'none', PUBLIC_ORIGIN: 'https://x.example' }, { auth: 'accounts' }).auth, 'accounts');
    assert.equal(parseAuthMode({}, {}).explicit, false);
  });

  test('none mode refuses accounts-only settings, the platform flags and a non-loopback HOST env', () => {
    for (const name of ['PUBLIC_ORIGIN', 'TRUST_PROXY', 'TRUSTED_PROXY_CIDRS', 'CLIENT_IP_HEADER', 'BEAN_MASTER_KEY', 'BEAN_MASTER_KEY_FILE',
      'TESTNET_ENABLED', 'ADMIN_TOKEN', 'ADMIN_TOKEN_FILE', 'ADMIN_USERNAMES', 'ADMIN_BOOTSTRAP_CODE', 'SIGNUP_MODE', 'INACTIVITY_DAYS']) {
      refused({ [name]: 'x' }, {}, new RegExp(name));
    }
    for (const flag of ['public-origin', 'trust-proxy']) refused({}, { [flag]: 'x' }, new RegExp(`--${flag}`));
    refused({}, { 'testnet-double': true }, /--testnet-double/);
    refused({ HOST: '0.0.0.0' }, {}, /HOST/);
    refused({ HOST: '192.168.1.5' }, {}, /HOST/);
    for (const host of ['127.0.0.1', 'localhost', '::1', '']) assert.deepEqual(ok({ HOST: host }), { auth: 'none' }, host);
    assert.deepEqual(ok({ BEAN_API_TOKEN: 'x'.repeat(20), PORT: '9000', LOG_FORMAT: 'json' }), { auth: 'none' }, 'none-mode settings pass');
    // HOST is never read in none mode; BEAN_FEED / BEAN_DATA_DIR fill absent flags in both modes.
    assert.deepEqual(applyEnvDefaults({}, { HOST: '127.0.0.1', BEAN_FEED: 'sim', BEAN_DATA_DIR: '/data' }, 'none'), { feed: 'sim', data: '/data' });
    assert.deepEqual(applyEnvDefaults({ feed: 'hyperliquid' }, { HOST: '0.0.0.0', BEAN_FEED: 'sim' }, 'accounts'), { feed: 'hyperliquid', host: '0.0.0.0' });
    assert.deepEqual(applyEnvDefaults({ host: '127.0.0.1' }, { HOST: '0.0.0.0' }, 'accounts'), { host: '127.0.0.1' }, 'the flag wins');
  });

  test('accounts mode: PUBLIC_ORIGIN required and origin-only; http only for localhost; --token / BEAN_API_TOKEN refused', () => {
    refused({ BEAN_AUTH: 'accounts' }, {}, /PUBLIC_ORIGIN is required/);
    for (const origin of ['https://bean.example.com/app', 'https://bean.example.com/?x=1', 'https://u:p@bean.example.com', 'ftp://bean.example.com',
      'bean.example.com', 'http://bean.example.com', 'https://bean.example.com#frag']) {
      refused({ BEAN_AUTH: 'accounts', PUBLIC_ORIGIN: origin }, {}, /PUBLIC_ORIGIN/);
    }
    for (const [origin, want] of [['https://Bean.Example.com/', 'https://bean.example.com'], ['http://localhost:8420', 'http://localhost:8420'],
      ['http://127.0.0.1:8461', 'http://127.0.0.1:8461'], ['https://bean.example.com:8443', 'https://bean.example.com:8443']]) {
      assert.equal(ok({ BEAN_AUTH: 'accounts', PUBLIC_ORIGIN: origin }).publicOrigin, want);
    }
    assert.equal(ok({ BEAN_AUTH: 'accounts' }, { 'public-origin': 'http://localhost:8420' }).publicOrigin, 'http://localhost:8420');
    refused(ACC, { token: 'x'.repeat(20) }, /--token \/ BEAN_API_TOKEN are refused/);
    const env = { ...ACC, BEAN_API_TOKEN: 'y'.repeat(20) };
    assert.throws(() => parsePlatformConfig({ values: {}, env }), /use ADMIN_TOKEN_FILE/);
    assert.ok(!('BEAN_API_TOKEN' in env), 'deleted');
    refused(ACC, { 'no-loopback-commands': true }, /meaningless/);
  });

  test('accounts mode defaults and validation of the numeric / enum settings', () => {
    const cfg = ok(ACC);
    assert.deepEqual({
      trustProxy: cfg.trustProxy, clientIpHeader: cfg.clientIpHeader, testnetEnabled: cfg.testnetEnabled, testnetMaxActiveUsers: cfg.testnetMaxActiveUsers,
      testnetBudget: cfg.testnetBudget, inactivityDays: cfg.inactivityDays, signupMode: cfg.signupMode, signupMaxPerHour: cfg.signupMaxPerHour,
      sessionDays: cfg.sessionDays, sessionIdleDays: cfg.sessionIdleDays, backupIntervalH: cfg.backupIntervalH, backupKeep: cfg.backupKeep,
      logFormat: cfg.logFormat, adminTokenRemote: cfg.adminTokenRemote,
    }, {
      trustProxy: 0, clientIpHeader: null, testnetEnabled: false, testnetMaxActiveUsers: 40, testnetBudget: 800, inactivityDays: 14,
      signupMode: 'open', signupMaxPerHour: 60, sessionDays: 30, sessionIdleDays: 7, backupIntervalH: 6, backupKeep: 28, logFormat: 'text',
      adminTokenRemote: false,
    });
    assert.equal(cfg.trustedProxyCidrs.length, 7);
    assert.equal(ok({ ...ACC, TRUST_PROXY: '1' }).trustProxy, 1);
    assert.equal(ok(ACC, { 'trust-proxy': '2' }).trustProxy, 2);
    refused({ ...ACC, TRUST_PROXY: '-1' }, {}, /TRUST_PROXY/);
    refused({ ...ACC, TRUSTED_PROXY_CIDRS: '10.0.0.0/8,banana' }, {}, /TRUSTED_PROXY_CIDRS/);
    refused({ ...ACC, CLIENT_IP_HEADER: 'X-Forwarded-For' }, {}, /single-IP header/);
    assert.equal(ok({ ...ACC, CLIENT_IP_HEADER: 'Fly-Client-IP' }).clientIpHeader, 'fly-client-ip');
    refused({ ...ACC, SIGNUP_MODE: 'public' }, {}, /SIGNUP_MODE/);
    refused({ ...ACC, TESTNET_ENABLED: 'yes' }, {}, /TESTNET_ENABLED must be 0 or 1/);
    refused({ ...ACC, SESSION_DAYS: '5', SESSION_IDLE_DAYS: '7' }, {}, /SESSION_IDLE_DAYS/);
    refused({ ...ACC, ADMIN_USERNAMES: 'ok_name,not ok!' }, {}, /ADMIN_USERNAMES/);
    assert.deepEqual(ok({ ...ACC, ADMIN_USERNAMES: ' Alice , bob_2 ' }).adminUsernames, ['alice', 'bob_2']);
    refused({ ...ACC, LOG_FORMAT: 'xml' }, {}, /LOG_FORMAT/);
  });

  test('testnet: TESTNET_ENABLED=1 needs the master key and real prices; --testnet-double rules', () => {
    const key = crypto.randomBytes(32).toString('base64');
    refused({ ...ACC, TESTNET_ENABLED: '1' }, {}, /needs BEAN_MASTER_KEY_FILE/);
    assert.equal(ok({ ...ACC, TESTNET_ENABLED: '1', BEAN_MASTER_KEY: key }).testnetEnabled, true);
    refused({ ...ACC, TESTNET_ENABLED: '1', BEAN_MASTER_KEY: key }, { feed: 'sim' }, /real prices/);
    const LOCAL = { BEAN_AUTH: 'accounts', PUBLIC_ORIGIN: 'http://localhost:8420' };
    const dbl = ok(LOCAL, { 'testnet-double': true });
    assert.equal(dbl.testnetDouble, true);
    assert.equal(dbl.secrets.masterKey.length, 32);
    assert.equal(dbl.secrets.masterKeyEphemeral, true, 'an ephemeral in-memory key without a master key');
    refused({ ...LOCAL, NODE_ENV: 'production' }, { 'testnet-double': true }, /NODE_ENV=production/);
    refused(ACC, { 'testnet-double': true }, /http:\/\/localhost/);
    refused({ ...LOCAL, TESTNET_ENABLED: '1', BEAN_MASTER_KEY: key }, { 'testnet-double': true }, /exclusive/);
    refused(LOCAL, { 'testnet-double': true, feed: 'sim' }, /real prices/);
  });
});

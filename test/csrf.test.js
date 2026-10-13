// test/csrf.test.js — WP1 request guard (PLATFORM.md §4.4, §4.5 client IP, §11.2 csrf): Origin / Sec-Fetch-Site,
// media types, Host, the POST query-string refusal, the Bearer admin token rules (direct loopback only, never for
// user ops or role changes, failures limited and audited), client-IP resolution (XFF and single-IP headers believed
// only from TRUSTED_PROXY_CIDRS, short XFF → socket, IPv6 buckets), and "no state-changing GET" over the catalog.
// Offline: fake requests, plus one tiny local HTTP server that wires the guard the way the router must.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { checkCsrf, createRequestGuard, directLoopback, hostOk, checkBearerParams, PROXY_HEADERS, bearerOf } from '../server/auth/csrf.js';
import { createClientIp, parseIp, bucketKeyOf, ipPrefix, parseCidrs, cidrContains, DEFAULT_TRUSTED_PROXY_CIDRS } from '../server/auth/clientip.js';
import { RateLimiter } from '../server/auth/ratelimit.js';
import { OPS, findOp } from '../server/catalog.js';

const ORIGIN = 'https://bean.example.com';
const PORT = 8420;
const TOKEN = 'T'.repeat(16) + 'okenOK-0123456789abcdef';

/** A fake IncomingMessage. */
function req({ method = 'POST', url = '/api/v1/bot_create', host = 'bean.example.com', peer = '203.0.113.9', headers = {} } = {}) {
  return {
    method,
    url,
    headers: { host, 'content-type': 'application/json', origin: ORIGIN, ...headers },
    socket: { remoteAddress: peer },
  };
}

function csrf(r, opts = {}) {
  const url = new URL(r.url, 'http://x');
  const op = findOp(url.pathname.split('/').pop()) ?? null;
  return checkCsrf(r, {
    publicOrigin: ORIGIN, op, bearerPresent: bearerOf(r).present, directLoopback: directLoopback(r), sessionCookieUsed: true,
    adminTokenRemote: false, url, port: PORT, ...opts,
  });
}

const codeOf = (err) => (err ? `${err.status} ${err.code}` : null);

describe('Origin and Sec-Fetch-Site (§4.4)', () => {
  test('a same-origin JSON POST passes', () => {
    assert.equal(csrf(req()), null);
  });

  test('Origin mismatch, opaque "null" and junk origins → 403 csrf', () => {
    for (const origin of ['https://evil.example', 'http://bean.example.com', 'https://bean.example.com:444', 'null', 'not a url']) {
      assert.equal(codeOf(csrf(req({ headers: { origin } }))), '403 csrf', origin);
    }
  });

  test('missing Origin: only Sec-Fetch-Site: same-origin passes', () => {
    const noOrigin = (site) => {
      const r = req();
      delete r.headers.origin;
      if (site) r.headers['sec-fetch-site'] = site;
      return csrf(r);
    };
    assert.equal(noOrigin('same-origin'), null);
    for (const site of ['cross-site', 'same-site', 'none', undefined]) assert.equal(codeOf(noOrigin(site)), '403 csrf', String(site));
  });

  test('form and text content types → 415 (blocks HTML form posts); JSON with a charset passes', () => {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '', 'application/jsonx']) {
      assert.equal(codeOf(csrf(req({ headers: { 'content-type': ct } }))), '415 unsupported_media_type', ct);
    }
    assert.equal(csrf(req({ headers: { 'content-type': 'Application/JSON; charset=utf-8' } })), null);
  });

  test('GET, HEAD and OPTIONS carry no CSRF check (cross-site reads of public data are fine)', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(csrf(req({ method, url: '/api/v1/beans', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' } })), null, method);
    }
  });
});

describe('Host (§4.4)', () => {
  test('a Host other than PUBLIC_ORIGIN\'s → 421 misdirected', () => {
    for (const host of ['evil.example', 'bean.example.com:8443', '127.0.0.1:8420', '', 'localhost']) {
      assert.equal(codeOf(csrf(req({ host }))), '421 misdirected', host);
    }
  });

  test('health paths also accept 127.0.0.1:<PORT> / localhost:<PORT>; other paths do not', () => {
    const at = (url, host, method = 'GET') => hostOk({ method, headers: { host } }, { publicOrigin: ORIGIN, port: PORT, pathname: url });
    assert.equal(at('/readyz', '127.0.0.1:8420'), null);
    assert.equal(at('/healthz', 'localhost:8420'), null);
    assert.equal(at('/api/v1/health', '127.0.0.1:8420'), null);
    assert.equal(codeOf(at('/api/v1/health', '127.0.0.1:8420', 'POST')), '421 misdirected');
    assert.equal(codeOf(at('/readyz', '127.0.0.1:9999')), '421 misdirected', 'only our own port');
    assert.equal(codeOf(at('/api/v1/beans', '127.0.0.1:8420')), '421 misdirected');
    assert.equal(at('/api/v1/beans', 'BEAN.example.com'), null, 'case-insensitive');
  });
});

describe('query strings on POST (§4.4, §5.3 rule 2)', () => {
  test('a POST with a query string → 400 query_params_not_allowed (secrets never sit in a request line)', () => {
    for (const url of ['/api/v1/auth_login?password=hunter2-hunter2', '/api/v1/testnet_connect?agent_key=0xabc', '/api/v1/bot_create?']) {
      const err = csrf(req({ url }));
      if (url.endsWith('?')) {
        assert.equal(err, null, 'a bare "?" has an empty search');
        continue;
      }
      assert.equal(codeOf(err), '400 query_params_not_allowed', url);
      assert.ok(!err.message.includes('hunter2') && !err.message.includes('0xabc'), 'the refusal never echoes the query');
    }
  });

  test('over HTTP: refused before the body is read, nothing logged, no echo', async () => {
    const limiter = new RateLimiter();
    let guard = null; // built once the port is known (fetch always sends Host 127.0.0.1:<port>)
    const logs = [];
    let bodyReads = 0;
    const server = http.createServer((rq, res) => {
      const url = new URL(rq.url, 'http://x');
      const op = findOp(url.pathname.split('/').pop());
      const { error } = guard.check(rq, { url, op, sessionCookieUsed: false, ip: createClientIp()(rq) });
      if (error) {
        res.writeHead(error.status, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify(error.toJSON()));
        return; // the body is never consumed (the connection closes)
      }
      bodyReads += 1;
      let body = '';
      rq.on('data', (c) => { body += c; });
      rq.on('end', () => {
        logs.push(`[api] ${op.name} body ${body.length} bytes`);
        res.end('{}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    guard = createRequestGuard({ publicOrigin: `http://127.0.0.1:${port}`, port, adminToken: TOKEN, limiter });
    try {
      const secret = 'correct-horse-battery-staple';
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/auth_login?password=${secret}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({ username: 'nok', password: secret }),
      });
      const text = await r.text();
      assert.equal(r.status, 400);
      assert.equal(JSON.parse(text).code, 'query_params_not_allowed');
      assert.ok(!text.includes(secret));
      assert.equal(bodyReads, 0, 'the body was never read');
      assert.deepEqual(logs, [], 'nothing was logged');
    } finally {
      server.close();
    }
  });
});

describe('Bearer admin token (§4.4, §8.6)', () => {
  const adminPost = ({ headers = {}, ...rest } = {}) => req({ url: '/api/v1/admin_kill_switch', host: '127.0.0.1:8420', peer: '127.0.0.1',
    ...rest, headers: { authorization: `Bearer ${TOKEN}`, origin: undefined, ...headers } });

  function makeGuard(extra = {}) {
    const audits = [];
    const limiter = new RateLimiter();
    const guard = createRequestGuard({ publicOrigin: ORIGIN, port: PORT, adminToken: TOKEN, limiter, audit: (e) => audits.push(e), ...extra });
    const run = (r) => {
      for (const k of Object.keys(r.headers)) if (r.headers[k] === undefined) delete r.headers[k];
      const url = new URL(r.url, 'http://x');
      return guard.check(r, { url, op: findOp(url.pathname.split('/').pop()), sessionCookieUsed: Boolean(r.headers.cookie), ip: createClientIp()(r) });
    };
    return { run, audits };
  }

  test('accepted from a direct loopback peer without proxy headers (admin-cli; Host check exempt)', () => {
    const { run } = makeGuard();
    const out = run(adminPost());
    assert.deepEqual([out.error, out.viaBearer], [null, true]);
    const getStatus = run(req({ method: 'GET', url: '/api/v1/admin_status', host: '127.0.0.1:8420', peer: '::1',
      headers: { authorization: `Bearer ${TOKEN}`, origin: undefined, 'content-type': undefined } }));
    assert.deepEqual([getStatus.error, getStatus.viaBearer], [null, true]);
  });

  test('refused through a proxy (any proxy header) or from a non-loopback peer, unless ADMIN_TOKEN_REMOTE=1', () => {
    const { run } = makeGuard();
    for (const h of PROXY_HEADERS) {
      const out = run(adminPost({ host: 'bean.example.com', headers: { [h]: '198.51.100.1' } }));
      assert.equal(codeOf(out.error), '403 forbidden', h);
    }
    assert.equal(codeOf(run(adminPost({ host: 'bean.example.com', peer: '10.0.0.5' })).error), '403 forbidden');
    const remote = makeGuard({ adminTokenRemote: true });
    const viaProxy = remote.run(adminPost({ host: 'bean.example.com', peer: '10.0.0.5', headers: { 'x-forwarded-for': '198.51.100.1' } }));
    assert.deepEqual([viaProxy.error, viaProxy.viaBearer], [null, true]);
  });

  test('never unlocks user or auth ops (401 auth_required), nor make_admin / remove_admin (403 session_required)', () => {
    const { run } = makeGuard();
    for (const name of ['bot_create', 'auth_login', 'account_delete', 'garden_reset', 'testnet_connect']) {
      const out = run(adminPost({ url: `/api/v1/${name}`, host: 'bean.example.com' }));
      assert.equal(codeOf(out.error), '401 auth_required', name);
    }
    const userOp = run(req({ method: 'GET', url: '/api/v1/bots', host: '127.0.0.1:8420', peer: '127.0.0.1',
      headers: { authorization: `Bearer ${TOKEN}`, origin: undefined } }));
    assert.equal(codeOf(userOp.error), '421 misdirected', 'only ADMIN ops get the loopback Host exemption (§4.4)');
    const userOpRightHost = run(req({ method: 'POST', url: '/api/v1/bot_pause', host: 'bean.example.com', peer: '127.0.0.1',
      headers: { authorization: `Bearer ${TOKEN}`, origin: undefined } }));
    assert.equal(codeOf(userOpRightHost.error), '401 auth_required', 'with the public Host: the Bearer never unlocks a user op');
    const remoteUserOp = run(req({ method: 'GET', url: '/api/v1/bots', host: 'evil.example', peer: '203.0.113.9',
      headers: { authorization: `Bearer ${TOKEN}`, origin: undefined } }));
    assert.equal(codeOf(remoteUserOp.error), '421 misdirected', 'no exemption away from loopback');
    const op = findOp('admin_user');
    for (const action of ['make_admin', 'remove_admin']) {
      assert.equal(codeOf(checkBearerParams(op, { username: 'x', action }, { viaBearer: true })), '403 session_required');
      assert.equal(checkBearerParams(op, { username: 'x', action }, { viaBearer: false }), null, 'a session may');
    }
    assert.equal(checkBearerParams(op, { username: 'x', action: 'disable' }, { viaBearer: true }), null);
  });

  test('a wrong token → 401, audited as admin_token_fail, and limited to 5 per 15 min per IP', () => {
    const { run, audits } = makeGuard();
    const wrong = () => run(adminPost({ headers: { authorization: 'Bearer wrong-token-wrong-token-wrong-token' } }));
    for (let i = 0; i < 5; i += 1) assert.equal(codeOf(wrong().error), '401 auth_required');
    const sixth = wrong();
    assert.equal(codeOf(sixth.error), '429 rate_limited');
    assert.ok(sixth.error.extra.retry_after_s > 0);
    assert.equal(audits.length, 6);
    assert.ok(audits.every((a) => a.action === 'admin_token_fail' && a.ok === false));
    assert.ok(!JSON.stringify(audits).includes('wrong-token'), 'the presented token is never audited');
    assert.equal(codeOf(run(adminPost({ headers: { authorization: 'Bearer' } })).error), '429 rate_limited', 'an empty Bearer counts too');
  });

  test('a Bearer request that also carries a session cookie still needs a same-origin Origin', () => {
    const { run } = makeGuard();
    const withCookie = run(adminPost({ headers: { cookie: 'bean_sid=x', origin: 'https://evil.example' } }));
    assert.equal(codeOf(withCookie.error), '403 csrf');
  });

  test('directLoopback: 127.0.0.1 / ::1 / ::ffff:127.0.0.1 without any proxy header', () => {
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.ok(directLoopback({ headers: {}, socket: { remoteAddress: peer } }), peer);
    for (const peer of ['127.0.0.2', '10.0.0.1', '::2']) assert.ok(!directLoopback({ headers: {}, socket: { remoteAddress: peer } }), peer);
    assert.ok(!directLoopback({ headers: { 'fly-client-ip': '1.2.3.4' }, socket: { remoteAddress: '127.0.0.1' } }));
    assert.ok(!directLoopback({ headers: { 'true-client-ip': '1.2.3.4' }, socket: { remoteAddress: '::1' } }));
  });
});

describe('client IP (§4.5)', () => {
  const at = (peer, headers = {}) => ({ headers, socket: { remoteAddress: peer } });

  test('the socket peer is the client unless the peer is a trusted proxy: a spoofed XFF from a direct peer is ignored', () => {
    const resolve = createClientIp({ trustProxy: 1 });
    const direct = resolve(at('203.0.113.5', { 'x-forwarded-for': '1.2.3.4' }));
    assert.deepEqual([direct.ip, direct.source], ['203.0.113.5', 'socket']);
    const viaCaddy = resolve(at('172.18.0.3', { 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }));
    assert.deepEqual([viaCaddy.ip, viaCaddy.source], ['198.51.100.7', 'xff'], 'the rightmost hop with TRUST_PROXY=1');
    const two = createClientIp({ trustProxy: 2 })(at('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }));
    assert.equal(two.ip, '1.2.3.4');
    const none = createClientIp({ trustProxy: 0 })(at('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }));
    assert.deepEqual([none.ip, none.source], ['127.0.0.1', 'socket'], 'TRUST_PROXY=0 never reads XFF');
  });

  test('a short XFF falls back to the socket address and warns once', () => {
    const logs = [];
    const resolve = createClientIp({ trustProxy: 2, log: (l) => logs.push(l) });
    for (let i = 0; i < 3; i += 1) {
      const r = resolve(at('10.1.2.3', { 'x-forwarded-for': '198.51.100.7' }));
      assert.deepEqual([r.ip, r.source], ['10.1.2.3', 'socket']);
    }
    const garbage = resolve(at('10.1.2.3', { 'x-forwarded-for': 'not-an-ip, also-not' }));
    assert.equal(garbage.source, 'socket');
    assert.equal(logs.length, 1);
  });

  test('CLIENT_IP_HEADER is honoured only from a trusted peer', () => {
    const resolve = createClientIp({ header: 'fly-client-ip' });
    const fromFly = resolve(at('fdaa:0:1:a7b::2', { 'fly-client-ip': '198.51.100.20', 'x-forwarded-for': '9.9.9.9' }));
    assert.deepEqual([fromFly.ip, fromFly.source], ['198.51.100.20', 'header']);
    const spoofed = resolve(at('198.51.100.66', { 'fly-client-ip': '1.1.1.1' }));
    assert.deepEqual([spoofed.ip, spoofed.source], ['198.51.100.66', 'socket']);
    const junk = resolve(at('fdaa::2', { 'fly-client-ip': 'junk' }));
    assert.equal(junk.source, 'socket');
  });

  test('IPv6 buckets: /56 for login, sign-up and SSE; /48 for the per-prefix sign-up budget; /64 elsewhere', () => {
    const r = createClientIp()(at('2001:db8:1:2ff:3:4:5:6'));
    assert.equal(r.bucketKey('login'), '2001:db8:1:200::/56');
    assert.equal(r.bucketKey('signup'), '2001:db8:1:200::/56');
    assert.equal(r.bucketKey('sse'), '2001:db8:1:200::/56');
    assert.equal(r.bucketKey('signup48'), '2001:db8:1::/48');
    assert.equal(r.bucketKey('queries'), '2001:db8:1:2ff::/64');
    const v4 = createClientIp()(at('::ffff:203.0.113.5'));
    assert.equal(v4.ip, '203.0.113.5', 'IPv4-mapped addresses are IPv4');
    assert.equal(v4.bucketKey('login'), '203.0.113.5');
    assert.equal(ipPrefix('203.0.113.77'), '203.0.113.0/24');
    assert.equal(ipPrefix('2001:db8:abcd:12:1::1'), '2001:db8:abcd::/48');
    assert.equal(bucketKeyOf(parseIp('[fe80::1%eth0]'), 'x'), 'fe80::/64');
  });

  test('CIDR parsing and matching (the default trusted list)', () => {
    const cidrs = parseCidrs(DEFAULT_TRUSTED_PROXY_CIDRS);
    const trusted = (a) => cidrs.some((c) => cidrContains(c, parseIp(a)));
    for (const a of ['127.0.0.1', '::1', '10.255.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', 'fc00::1', 'fdaa::9']) assert.ok(trusted(a), a);
    for (const a of ['172.32.0.1', '8.8.8.8', '2001:db8::1', '::2', '11.0.0.1']) assert.ok(!trusted(a), a);
    assert.throws(() => parseCidrs('10.0.0.0/33'));
    assert.throws(() => parseCidrs('nonsense'));
  });

  test('distinct buckets are counted for admin_status.client_ip.buckets_1h', () => {
    const resolve = createClientIp();
    for (const peer of ['198.51.100.1', '198.51.100.2', '198.51.100.2', '2001:db8::1', '2001:db8::2']) resolve(at(peer));
    assert.equal(resolve.stats.count(), 3, 'two v4 hosts + one v6 /64');
    assert.equal(resolve.source, 'socket');
  });
});

test('no state-changing GET exists (enumerates OPS): every mutation is a POST command', () => {
  const MUTATING = /(create|delete|close|pause|resume|halt|rearm|reset|signup|login|logout|password|connect|verify|revoke|kill|caps|backup|tick|approve|prepare|signing|double|user$)/;
  const queries = OPS.filter((op) => op.kind === 'query');
  const commands = OPS.filter((op) => op.kind === 'command');
  assert.ok(queries.length > 5 && commands.length > 5);
  for (const op of queries) {
    if (op.name === 'admin_users') continue; // a read-only listing whose name ends in "users"
    assert.ok(!MUTATING.test(op.name), `GET op '${op.name}' looks state-changing`);
  }
  for (const name of ['auth_signup', 'auth_login', 'auth_logout', 'auth_logout_all', 'auth_reset', 'account_password', 'account_delete',
    'session_revoke', 'admin_kill_switch', 'admin_caps', 'admin_user', 'admin_backup', 'bot_create', 'garden_reset']) {
    assert.equal(findOp(name)?.kind, 'command', `${name} must be a POST command`);
  }
  for (const op of OPS) assert.ok(op.kind === 'query' || op.kind === 'command', op.name);
});

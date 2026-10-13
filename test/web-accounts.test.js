// test/web-accounts.test.js — the accounts-mode client transport (PLATFORM §9.5, §12.2): web/js/brood-api.js
// (mode discovery, same-origin lock, inert tokens, cookies, auth:required, retry_after_s, the auth wrappers,
// restream) and web/js/game/core/data.js + store.js (mode / user / testnet / venues / season slices, spectator
// rules, per-player slots, the new SSE kinds, sign-in / sign-out transitions). No DOM, no network: browser globals
// are stubbed, fetch is a fake, timers are fake.

import test from 'node:test';
import assert from 'node:assert/strict';

const WEB = new URL('../web/js/', import.meta.url);
const imp = (f) => import(new URL(f, WEB).href);

// ---- browser-ish globals
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};
function setLocation(href) {
  const u = new URL(href);
  globalThis.location = { href: u.href, origin: u.origin, search: u.search, pathname: u.pathname, hash: u.hash };
}
globalThis.history = { state: null, replaceState: (_s, _t, url) => setLocation(new URL(url, globalThis.location.href).href) };
setLocation('https://bean.example.com/');

const A = await imp('brood-api.js');
const storeMod = await imp('game/core/store.js');
const busMod = await imp('game/core/bus.js');
const data = await imp('game/core/data.js');

// ---- a fake fetch: routes by URL; records every call
const calls = [];
let routes = {};
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  calls.push({ url: u, init, body: init.body ? JSON.parse(init.body) : null });
  const key = `${u.origin}${u.pathname}`;
  const handler = routes[key] ?? routes[u.pathname];
  if (!handler) return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/html' } });
  const out = await handler(u, init);
  const { status = 200, body = {}, headers = {} } = out;
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
};

const ACCOUNTS_INDEX = { name: 'bean-garden API', api_version: 1, auth: 'accounts', command_policy: 'session', testnet: { enabled: true }, public_origin: 'https://bean.example.com', operations: [] };
const NONE_INDEX = { name: 'bean-garden API', api_version: 1, auth: 'none', command_policy: 'loopback', testnet: { enabled: false }, operations: [] };

function reset({ href = 'https://bean.example.com/', index = ACCOUNTS_INDEX } = {}) {
  A.resetMode();
  ls.clear();
  calls.length = 0;
  setLocation(href);
  routes = { '/api/v1': () => ({ body: index }) };
}

// =============================================================================================
// brood-api.js

test('api: getMode asks the page origin first; accounts mode locks the API to that origin (?api= ignored)', async () => {
  reset({ href: 'https://bean.example.com/?api=https://evil.example' });
  routes['https://evil.example/api/v1'] = () => ({ body: NONE_INDEX });
  const notices = [];
  const info = console.info;
  console.info = (m) => notices.push(String(m));
  try {
    const mode = await A.getMode();
    assert.deepEqual({ ...mode, testnet: { ...mode.testnet } }, { auth: 'accounts', testnet: { enabled: true }, public_origin: 'https://bean.example.com', command_policy: 'session' });
    assert.equal(A.isAccountsMode(), true);
    assert.equal(A.currentMode(), mode);
    assert.equal(await A.getMode(), mode, 'cached');
  } finally {
    console.info = info;
  }
  assert.ok(calls.every((c) => c.url.origin === 'https://bean.example.com'), 'the foreign base was never asked');
  assert.equal(A.getBase(), '', 'the foreign ?api= is refused');
  assert.equal(A.cleanBase('https://evil.example'), null);
  assert.equal(A.cleanBase('https://bean.example.com/x'), 'https://bean.example.com/x');
  assert.equal(A.apiUrl('health'), 'https://bean.example.com/api/v1/health');
  assert.ok(notices.some((n) => n.includes('ignored')), 'a console notice says why');
});

test('api: before the mode is known, a crafted ?api= link never receives the first requests of a page load', async () => {
  reset({ href: 'https://bean.example.com/?api=https://evil.example' });
  routes['https://evil.example/api/v1/health'] = () => ({ body: { spoofed: true } });
  routes['https://bean.example.com/api/v1/health'] = () => ({ body: { ok: true } });
  routes['https://bean.example.com/api/v1/bots_halt'] = () => ({ body: { halted: true } });
  const info = console.info;
  console.info = () => {};
  try {
    // no getMode() first: query() and command() learn the mode before they talk to another origin
    const [h, c] = await Promise.all([A.query('health'), A.command('bots_halt', {})]);
    assert.deepEqual(h, { ok: true });
    assert.deepEqual(c, { halted: true });
  } finally {
    console.info = info;
  }
  assert.ok(calls.every((x) => x.url.origin === 'https://bean.example.com'), calls.map((x) => x.url.href).join(' '));
  // a same-origin page never waits for the index
  reset();
  routes['/api/v1/health'] = () => ({ body: { ok: true } });
  await A.query('health');
  assert.deepEqual(calls.map((x) => x.url.pathname), ['/api/v1/health']);
});

test('api: a page without its own API uses the configured base (none mode stays as before)', async () => {
  reset({ href: 'https://static.example.net/garden.html?api=https://lan.example:8420' });
  routes = { 'https://lan.example:8420/api/v1': () => ({ body: NONE_INDEX }) };
  const mode = await A.getMode();
  assert.equal(mode.auth, 'none');
  assert.equal(A.getBase(), 'https://lan.example:8420');
  // none mode: the token still works exactly as before (for its own origin slot)
  setLocation('https://static.example.net/garden.html');
  A.setBase('https://lan.example:8420');
  assert.equal(A.setToken('LAN-TOKEN-123'), true);
  assert.equal(A.getToken(), 'LAN-TOKEN-123');
  A.setBase(null);
});

test('api: accounts mode — tokens are inert, commands carry no Authorization, fetches send same-origin cookies', async () => {
  reset();
  ls.set('brood.token', 'OLD-TOKEN-FROM-NONE-MODE');
  await A.getMode();
  assert.equal(A.getToken(), null);
  assert.equal(A.hasToken(), false);
  assert.equal(A.setToken('NEW-TOKEN'), false);
  assert.equal(ls.get('brood.token'), 'OLD-TOKEN-FROM-NONE-MODE', 'nothing stored or changed');
  setLocation('https://bean.example.com/?token=SECRET&nostream=1');
  assert.deepEqual(A.adoptUrlParams(), { token: false, ignored: 'accounts' });
  assert.equal(globalThis.location.search, '?nostream=1', 'still stripped from the address bar');
  routes['/api/v1/bot_pause'] = () => ({ body: { id: 'bot-0001', state: 'paused' } });
  routes['/api/v1/health'] = () => ({ body: { ok: true } });
  const out = await A.command('bot_pause', { id: 'bot-0001' });
  assert.equal(out.state, 'paused');
  const post = calls.at(-1);
  assert.deepEqual(Object.keys(post.init.headers).sort(), ['Accept', 'Content-Type']);
  assert.equal(post.init.credentials, 'same-origin');
  assert.equal(post.url.search, '', 'params never in the URL');
  await A.query('health');
  assert.equal(calls.at(-1).init.credentials, 'same-origin');
});

test('api: a 401 auth_required / session_expired dispatches auth:required (once per burst); codes and bodies are exposed', async () => {
  reset();
  await A.getMode();
  const bus = busMod.createBus();
  const seen = [];
  bus.on('auth:required', (p) => seen.push(p));
  A.attachBus(bus);
  routes['/api/v1/bots'] = () => ({ status: 401, body: { error: 'sign in to do that', status: 401, code: 'auth_required' } });
  routes['/api/v1/live_status'] = () => ({ status: 401, body: { error: 'sign in to do that', status: 401, code: 'auth_required' } });
  await assert.rejects(A.query('bots'), (e) => e.status === 401 && e.code === 'auth_required' && e.body.code === 'auth_required');
  await assert.rejects(A.query('live_status'), (e) => e.code === 'auth_required');
  assert.equal(seen.length, 1, 'tend() asks two user queries: one notice');
  assert.equal(seen[0].code, 'auth_required');
  routes['/api/v1/bot_close'] = () => ({ status: 401, body: { error: 'your session has ended', status: 401, code: 'session_expired' } });
  const body = await A.command('bot_close', { id: 'bot-0001' });
  assert.deepEqual(body, { error: 'your session has ended', status: 401, code: 'session_expired' });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].code, 'session_expired');
  // other 401s (a wrong password) are not "signed out"
  routes['/api/v1/auth_login'] = () => ({ status: 401, body: { error: 'wrong username or password', status: 401, code: 'bad_credentials' } });
  assert.equal((await A.login({ username: 'a', password: 'b' })).code, 'bad_credentials');
  assert.equal(seen.length, 2);
});

test('api: 429 exposes retry_after_s (body first, else the Retry-After header)', async () => {
  reset();
  await A.getMode();
  routes['/api/v1/testnet_market'] = () => ({ status: 429, body: { error: 'too many requests', status: 429, code: 'rate_limited', retry_after_s: 7 } });
  await assert.rejects(A.query('testnet_market'), (e) => e.status === 429 && e.retry_after_s === 7 && e.code === 'rate_limited');
  routes['/api/v1/testnet_connect'] = () => ({ status: 429, body: { error: 'slow down', status: 429, code: 'rate_limited' }, headers: { 'Retry-After': '42' } });
  const r = await A.command('testnet_connect', { account_address: '0x' + '1'.repeat(40), agent_key: 'x' });
  assert.equal(r.retry_after_s, 42);
  assert.equal(r.code, 'rate_limited');
});

test('api: a 401 for a request that carried the old cookie while a session-changing command ran is not reported', async () => {
  reset();
  await A.getMode();
  const bus = busMod.createBus();
  const seen = [];
  bus.on('auth:required', (p) => seen.push(p));
  A.attachBus(bus);
  assert.ok(A.SESSION_CHANGING_OPS.includes('account_password') && A.SESSION_CHANGING_OPS.includes('auth_login'));
  let answerPw = null;
  routes['/api/v1/account_password'] = () => new Promise((resolve) => {
    answerPw = () => resolve({ body: { ok: true } });
  });
  routes['/api/v1/bots'] = () => ({ status: 401, body: { error: 'your session has ended', status: 401, code: 'session_expired' } });
  const pw = A.command('account_password', { current_password: 'old password 1', new_password: 'new password 2' });
  while (!answerPw) await new Promise((r) => setImmediate(r));
  let settled = false;
  A.authSettled().then(() => {
    settled = true;
  });
  // tend() polled while the password change was on its way: its old cookie was revoked → stale, not reported
  await assert.rejects(A.query('bots'), (e) => e.status === 401 && e.code === 'session_expired');
  assert.equal(seen.length, 0);
  assert.equal(settled, false, 'the change is still in flight');
  // a query sent before the change settled but answered after it: stale as well
  let answerBots = null;
  routes['/api/v1/bots'] = () => new Promise((resolve) => {
    answerBots = () => resolve({ status: 401, body: { error: 'your session has ended', status: 401, code: 'session_expired' } });
  });
  const late = A.query('bots');
  while (!answerBots) await new Promise((r) => setImmediate(r));
  answerPw();
  assert.deepEqual(await pw, { ok: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, true, 'authSettled() resolves once the change answered');
  answerBots();
  await assert.rejects(late, (e) => e.code === 'session_expired');
  assert.equal(seen.length, 0);
  // a request sent after the change with a cookie that is really dead: reported
  routes['/api/v1/bots'] = () => ({ status: 401, body: { error: 'sign in to do that', status: 401, code: 'auth_required' } });
  await assert.rejects(A.query('bots'));
  assert.deepEqual(seen.map((p) => p.code), ['auth_required']);
  // an unknown op name is still an answer, never a throw (and counts nothing)
  assert.equal((await A.command('Not-An-Op', {})).status, 0);
  assert.equal(await Promise.race([A.authSettled().then(() => 'settled'), new Promise((r) => setTimeout(() => r('stuck'), 50))]), 'settled');
});

test('api: signup / login / logout / logoutAll / resetPassword — one params object, known fields only, JSON body', async () => {
  reset();
  await A.getMode();
  for (const fn of ['signup', 'login', 'logout', 'logoutAll', 'resetPassword']) assert.ok(A[fn].length <= 1, `${fn} takes one params object`);
  routes['/api/v1/auth_signup'] = () => ({ body: { user: { id: 7, username: 'nok' } } });
  routes['/api/v1/auth_login'] = () => ({ body: { user: { id: 7, username: 'nok' }, notice: 'password_reset' } });
  routes['/api/v1/auth_logout'] = () => ({ body: { ok: true } });
  routes['/api/v1/auth_logout_all'] = () => ({ body: { ok: true, revoked: 3 } });
  routes['/api/v1/auth_reset'] = () => ({ body: { user: { id: 7, username: 'nok' } } });
  assert.equal((await A.signup({ username: 'nok', password: 'pw pw pw pw', bootstrap_code: '', lang: 'th', extra: 'dropped' })).user.id, 7);
  assert.deepEqual(calls.at(-1).body, { username: 'nok', password: 'pw pw pw pw', lang: 'th' });
  assert.equal((await A.login({ username: 'nok', password: 'pw pw pw pw', remember: true })).notice, 'password_reset');
  assert.deepEqual(calls.at(-1).body, { username: 'nok', password: 'pw pw pw pw' });
  assert.deepEqual(await A.logout(), { ok: true });
  assert.deepEqual(calls.at(-1).body, {});
  assert.equal((await A.logoutAll()).revoked, 3);
  await A.resetPassword({ username: 'nok', code: 'ABCD-EFGH-JKLM', new_password: 'new pw new pw' });
  assert.deepEqual(calls.at(-1).body, { username: 'nok', code: 'ABCD-EFGH-JKLM', new_password: 'new pw new pw' });
  for (const c of calls.filter((x) => x.init.method === 'POST')) {
    assert.equal(c.url.search, '', 'secrets never in a URL');
    assert.equal(c.init.headers.Authorization, undefined);
  }
});

test('api: EVENT_KINDS lists the accounts kinds; restream() reopens (or asks the stream owner to)', async () => {
  for (const k of ['bot_sync', 'bot_fill_confirmed', 'testnet_account', 'credential_status', 'garden_rearmed', 'garden_reset', 'password_reset', 'kill_switch', 'testnet_feed', 'session_ended', 'resync', 'server_restart']) {
    assert.ok(A.EVENT_KINDS.includes(k), k);
  }
  reset();
  const opened = [];
  globalThis.EventSource = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = {};
      opened.push(this);
    }
    addEventListener(k, fn) {
      (this.listeners[k] ??= []).push(fn);
    }
    close() {
      this.readyState = 2;
    }
  };
  try {
    const got = [];
    const es1 = A.stream((kind, rec) => got.push([kind, rec]), {});
    assert.equal(opened.length, 1);
    es1.listeners.session_ended[0]({ data: JSON.stringify({ kind: 'session_ended', reason: 'logout' }) });
    assert.deepEqual(got, [['session_ended', { kind: 'session_ended', reason: 'logout' }]]);
    const es2 = A.restream();
    assert.equal(es1.readyState, 2, 'the old stream is closed');
    assert.notEqual(es2, es1);
    assert.equal(opened.length, 2);
    // an owner that tracks its stream (core/data.js) gets the restart instead
    let restarted = 0;
    A.stream(() => {}, { restart: () => ++restarted });
    A.restream();
    assert.equal(restarted, 1);
    assert.equal(opened.length, 3, 'no extra stream behind the owner\'s back');
  } finally {
    delete globalThis.EventSource;
  }
});

// =============================================================================================
// core/data.js + store.js

function fakeTimers() {
  let t = 1_000_000;
  let id = 0;
  const q = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const i = ++id;
      q.set(i, { at: t + Math.max(0, ms), fn });
      return i;
    },
    clearTimeout(i) {
      q.delete(i);
    },
    async advance(ms) {
      await flush(); // let pending continuations register their timers first
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [i, x] of q) if (x.at <= end && (!next || x.at < next[1].at)) next = [i, x];
        if (!next) break;
        q.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

const BOT = { id: 'bot-0003', bean: 612, coin: 'SOL', state: 'active', capital_usd: 100, venue: 'paper' };
const LIVE = {
  caps: { max_bots: 10 }, halted: false, account_usd: 10_000, season: 2, season_started_ms: 5, reset_after_ms: 99,
  venues: { paper: { account_usd: 10_000, account_value: 10_010 }, testnet: { enabled: true, connected: true, account_value: 1000, as_of_ms: 1 } },
};

/** A fake api for data.js: an accounts server; `me` decides the player. Records every query. */
function fakeApi({ mode = { auth: 'accounts', testnet: { enabled: true } }, me = { mode: 'accounts', user: null, session: null, signup: 'open', testnet: null } } = {}) {
  const api = {
    EVENT_KINDS: A.EVENT_KINDS,
    streamDisabled: () => false,
    calls: [],
    me,
    streams: 0,
    restarts: 0,
    bus: null,
    getMode: async () => mode,
    attachBus(b) {
      api.bus = b;
    },
    async query(name) {
      api.calls.push(name);
      switch (name) {
        case 'me':
          return api.me;
        case 'bots':
          return { rows: [{ ...BOT }] };
        case 'live_status':
          return { ...LIVE };
        case 'testnet_status':
          return { link: { status: 'verified' }, state: 'live', account: { account_value: 1000 } };
        case 'testnet_market':
          return { enabled: true, state: 'live', kill_switch: { on: false, reason: null, since_ms: null }, coins: [] };
        case 'beans':
          return { rows: [] };
        case 'health':
          return { ok: true, now_ms: 1_000_000 };
        case 'status':
          return { feed: { source: 'sim', state: 'sim' } };
        default:
          return {};
      }
    },
    async command(op, params) {
      api.calls.push(`cmd:${op}`);
      return op === 'bot_create' ? { id: 'bot-0009', bean: params.bean } : { ok: true };
    },
    stream(onEvent, opts) {
      api.streams++;
      api.onEvent = onEvent;
      api.opts = opts;
      return { readyState: 1, close() {} };
    },
  };
  return api;
}

async function boot(over) {
  const timers = fakeTimers();
  const store = storeMod.createStore(storeMod.initialState());
  const bus = busMod.createBus();
  const api = fakeApi(over);
  const storage = memStorage();
  const events = [];
  for (const type of ['game:event', 'cmd:pending', 'cmd:done', 'data:resync', 'data:server_restart', 'data:player', 'auth:required']) bus.on(type, (p) => events.push([type, p]));
  const d = data.startData({ store, bus, api, now: timers.now, timers, storage, search: '' });
  await flush();
  return { timers, store, bus, api, storage, events, d };
}

test('store: the accounts slices exist and start empty', () => {
  const s = storeMod.initialState();
  assert.equal(s.mode, null);
  assert.equal(s.user, null);
  assert.equal(s.me, null);
  assert.deepEqual(s.testnet, { market: null, status: null, marketMs: 0, statusMs: 0 });
  assert.equal(s.venues, null);
  assert.equal(s.season, null);
});

test('data: a spectator never calls a user query (QA-13); public data still loads; the stream opens', async () => {
  const { store, api, d } = await boot();
  const s = store.get();
  assert.equal(s.mode.auth, 'accounts');
  assert.equal(s.user, null);
  assert.equal(s.me.signup, 'open');
  for (const q of ['bots', 'live_status', 'testnet_status', 'bot_detail']) assert.ok(!api.calls.includes(q), `${q} not asked`);
  for (const q of ['me', 'meta', 'health', 'market', 'beans', 'testnet_market']) assert.ok(api.calls.includes(q), `${q} asked`);
  assert.deepEqual(s.bots, []);
  assert.equal(api.streams, 1);
  assert.equal(await d.loadDetail('bot-0001'), null);
  assert.ok(!api.calls.includes('bot_detail'));
  assert.equal(api.bus !== null, true, 'brood-api got the bus for auth:required');
  d.stop();
});

test('data: a signed-in player — bots, live_status, venues, season, testnet slices; slots stored per player', async () => {
  const { store, api, storage, timers, d } = await boot({ me: { mode: 'accounts', user: { id: 7, username: 'nok', role: 'player' }, session: {}, signup: 'open', testnet: null } });
  const s = store.get();
  assert.equal(s.user.username, 'nok');
  assert.deepEqual(s.bots.map((b) => b.id), ['bot-0003']);
  assert.equal(s.venues.testnet.account_value, 1000);
  assert.deepEqual(s.season, { season: 2, season_started_ms: 5, reset_after_ms: 99 });
  assert.equal(s.testnet.status.link.status, 'verified');
  assert.equal(s.testnet.market.state, 'live');
  assert.ok(storage.m.has(data.slotsKeyFor(7)), 'slots under bean.game.slots.v1:7');
  assert.equal(storage.m.has(data.SLOTS_KEY), false, 'never the none-mode key');
  const before = api.calls.filter((c) => c === 'testnet_market').length;
  await timers.advance(60_000);
  assert.ok(api.calls.filter((c) => c === 'testnet_market').length > before, 'testnet_market refreshes every 60 s');
  d.stop();
});

test('data: auth:required and session_ended clear the player (bots, live, diary, slots, own echoes)', async () => {
  const { store, bus, api, events, timers, d } = await boot({ me: { mode: 'accounts', user: { id: 7, username: 'nok', role: 'player' }, session: {}, signup: 'open', testnet: null } });
  store.set({ diary: [{ text: 'a private line' }], detail: { 'bot-0003': {} } });
  bus.emit('auth:required', { code: 'session_expired' });
  let s = store.get();
  assert.equal(s.user, null);
  assert.deepEqual(s.bots, []);
  assert.equal(s.live, null);
  assert.deepEqual(s.diary, []);
  assert.deepEqual(s.detail, {});
  assert.deepEqual(s.slots.map, {});
  assert.equal(s.venues, null);
  assert.equal(events.filter(([t]) => t === 'data:player').at(-1)[1].user, null, 'the player change is announced');
  // a new player signs in: their own state, one stream restart even when the UI also calls api.restream()
  const streamsBefore = api.streams;
  const pim = { id: 8, username: 'pim', role: 'player' };
  api.me = { mode: 'accounts', user: pim, session: {}, signup: 'open', testnet: null };
  d.signedIn(pim);
  api.opts.restart(); // what brood-api.restream() does for us
  await flush();
  assert.equal(api.streams, streamsBefore + 1, 'one new stream, not two');
  assert.equal(store.get().user.username, 'pim');
  // the SSE session_ended frame does the same once `me` confirms nobody is signed in, and becomes a game event for
  // the gate / diary
  api.me = { mode: 'accounts', user: null, session: null, signup: 'open', testnet: null };
  api.onEvent('session_ended', { kind: 'session_ended', reason: 'logout_all' });
  assert.equal(store.get().user.username, 'pim', 'not before me answered');
  await timers.advance(data.CADENCE.sessionSettleMs + 10);
  s = store.get();
  assert.equal(s.user, null);
  assert.ok(events.some(([t, ev]) => t === 'game:event' && ev.type === 'sessionEnded' && ev.reason === 'logout_all'));
  d.stop();
});

test('data: a session_ended frame whose player is still signed in (password change) keeps the player', async () => {
  const user = { id: 7, username: 'nok', role: 'player' };
  const { store, bus, api, events, timers, d } = await boot({ me: { mode: 'accounts', user, session: {}, signup: 'open', testnet: null } });
  store.set({ diary: [{ text: 'a private line' }] });
  // the password change is still in flight when its frame arrives: the check waits for it to settle
  let settle;
  api.authSettled = () => new Promise((resolve) => {
    settle = resolve;
  });
  const streams = api.streams;
  api.calls.length = 0;
  api.onEvent('session_ended', { kind: 'session_ended', reason: 'password_changed' });
  await timers.advance(5_000);
  assert.ok(!api.calls.includes('me'), 'me waits until the session-changing command settled');
  settle();
  await flush();
  await timers.advance(data.CADENCE.sessionSettleMs + 10);
  assert.ok(api.calls.includes('me'));
  const s = store.get();
  assert.equal(s.user.username, 'nok', 'still signed in with the fresh cookie');
  assert.deepEqual(s.diary, [{ text: 'a private line' }], 'nothing cleared');
  assert.equal(api.streams, streams + 1, 'the stream reopens with the new cookie');
  assert.ok(!events.some(([t, ev]) => t === 'game:event' && ev.type === 'sessionEnded'), 'no "session ended" for the gate');
  // another player signed in in this browser meanwhile: switch to them, no "session ended" either
  delete api.authSettled;
  api.me = { mode: 'accounts', user: { id: 9, username: 'mali', role: 'player' }, session: {}, signup: 'open', testnet: null };
  api.onEvent('session_ended', { kind: 'session_ended', reason: 'revoked' });
  await timers.advance(data.CADENCE.sessionSettleMs + 10);
  assert.equal(store.get().user.username, 'mali');
  assert.deepEqual(store.get().diary, [], 'the previous player\'s diary is gone');
  assert.ok(!events.some(([t, ev]) => t === 'game:event' && ev.type === 'sessionEnded'));
  // a sign-out of our own ran first: the late frame changes nothing and announces nothing
  d.signedOut({ reason: 'logout' });
  api.onEvent('session_ended', { kind: 'session_ended', reason: 'logout' });
  await timers.advance(data.CADENCE.sessionSettleMs + 10);
  assert.ok(!events.some(([t, ev]) => t === 'game:event' && ev.type === 'sessionEnded'));
  // a poll's 401 ended the session before the check ran: the 401 cleared the player, the event still goes out once
  api.me = { mode: 'accounts', user, session: {}, signup: 'open', testnet: null };
  d.signedIn(user);
  await flush();
  api.onEvent('session_ended', { kind: 'session_ended', reason: 'revoked' });
  bus.emit('auth:required', { code: 'session_expired' });
  assert.equal(store.get().user, null);
  await timers.advance(data.CADENCE.sessionSettleMs + 10);
  assert.deepEqual(events.filter(([t, ev]) => t === 'game:event' && ev.type === 'sessionEnded').map(([, ev]) => ev.reason), ['revoked']);
  d.stop();
});

test('data: resync → full refresh; server_restart → announced; kill_switch / testnet_account patch the slices', async () => {
  const { store, api, events, timers, d } = await boot({ me: { mode: 'accounts', user: { id: 7, username: 'nok', role: 'player' }, session: {}, signup: 'open', testnet: null } });
  api.calls.length = 0;
  api.onEvent('resync', { kind: 'resync' });
  await timers.advance(500);
  for (const q of ['bots', 'live_status', 'market', 'health', 'status', 'beans', 'testnet_market']) assert.ok(api.calls.includes(q), `${q} refreshed`);
  assert.ok(events.some(([t]) => t === 'data:resync'));
  api.onEvent('server_restart', { kind: 'server_restart' });
  assert.ok(events.some(([t]) => t === 'data:server_restart'));
  api.onEvent('kill_switch', { seq: 9, kind: 'kill_switch', on: true, reason: 'drill', since_ms: 42 });
  assert.deepEqual(store.get().testnet.market.kill_switch, { on: true, reason: 'drill', since_ms: 42 });
  api.onEvent('testnet_account', { seq: 10, kind: 'testnet_account', account_value: 1003.7, account_value_est: true, free: 912.4, total_margin_used: 42.1, as_of_ms: 77 });
  assert.equal(store.get().venues.testnet.account_value, 1003.7);
  assert.equal(store.get().venues.testnet.account_value_est, true);
  assert.equal(store.get().venues.testnet.as_of_ms, 77);
  d.stop();
});

test('data: normalizeEvent covers every new kind and keeps venue fields; cmd:pending carries the venue', async () => {
  const ctx = { slots: { map: { 'bot-0003': 2 }, wanted: {}, count: 10 }, bots: [{ ...BOT, venue: 'testnet' }], receivedMs: 1 };
  const kinds = {
    bot_sync: 'sync', bot_fill_confirmed: 'fillConfirmed', testnet_account: 'testnetAccount', credential_status: 'credential',
    kill_switch: 'killSwitch', testnet_feed: 'testnetFeed', garden_rearmed: 'rearmed', garden_reset: 'seasonReset',
    password_reset: 'passwordReset', session_ended: 'sessionEnded', resync: 'resync', server_restart: 'serverRestart',
  };
  for (const [kind, type] of Object.entries(kinds)) {
    const ev = data.normalizeEvent(kind, { bot: 'bot-0003', kind }, ctx);
    assert.equal(ev?.type, type, kind);
  }
  const sync = data.normalizeEvent('bot_sync', { bot: 'bot-0003', op: 'flatten', state: 'failed', attempts: 2, code: 'ioc_no_match', fill_state: 'partial' }, ctx);
  assert.deepEqual([sync.slot, sync.op, sync.state, sync.code, sync.fill_state], [2, 'flatten', 'failed', 'ioc_no_match', 'partial']);
  const paused = data.normalizeEvent('bot_paused', { bot: 'bot-0003', reason: 'drift', note_code: 'position_drift', note_vars: { exch: 1, exp: 2, coin: 'SOL' }, venue: 'testnet' }, ctx);
  assert.equal(paused.note_code, 'position_drift');
  assert.equal(paused.venue, 'testnet');
  const closed = data.normalizeEvent('bot_closed', { bot: 'bot-0003', realized_pnl: 1, venue: 'testnet', funding: -0.03, confirmed: false }, ctx);
  assert.deepEqual([closed.funding, closed.confirmed], [-0.03, false]);
  const err = data.normalizeEvent('live_error', { bot: 'bot-0003', error: 'x', code: 'insufficient_margin' }, ctx);
  assert.equal(err.code, 'insufficient_margin');
  const halted = data.normalizeEvent('live_halted', { closed: [], closing: ['bot-0003'] }, ctx);
  assert.deepEqual(halted.closing, [{ bot: 'bot-0003', slot: 2, coin: 'SOL' }]);
  assert.equal(data.normalizeEvent('nope', {}, ctx), null);
  // marks: the testnet part of a mids frame
  const m = data.marksFromMids({ px: { BTC: 1 }, testnet: { mids: { BTC: 0.9 } }, testnet_account: { account_value: 5 } }, 1);
  assert.deepEqual(m.testnet, { mids: { BTC: 0.9 } });
  assert.equal(m.testnet_account.account_value, 5);
  assert.equal(data.seasonOfLive({ season: 3, season_started_ms: 1 }).season, 3);
  assert.equal(data.seasonOfLive({}), null);
  // cmd:pending / cmd:done carry the venue
  const { events, d } = await boot({ me: { mode: 'accounts', user: { id: 7, username: 'nok', role: 'player' }, session: {}, signup: 'open', testnet: null } });
  await d.command('bot_create', { bean: 612, capital_usd: 50, venue: 'testnet', confirm: 'testnet' }, { slot: 4 });
  await d.command('bot_pause', { id: 'bot-0003' });
  const pend = events.filter(([t]) => t === 'cmd:pending').map(([, p]) => p.venue);
  assert.deepEqual(pend, ['testnet', 'paper']);
  d.stop();
});

test('data: none mode through getMode keeps today\'s behaviour (user queries, the plain slots key)', async () => {
  const { store, api, storage, d } = await boot({ mode: { auth: 'none', testnet: { enabled: false } } });
  assert.equal(store.get().mode.auth, 'none');
  assert.equal(store.get().user, null, 'the implicit local player is not a store user');
  assert.ok(api.calls.includes('bots') && api.calls.includes('live_status'));
  assert.ok(!api.calls.includes('me') && !api.calls.includes('testnet_market') && !api.calls.includes('testnet_status'));
  assert.ok(storage.m.has(data.SLOTS_KEY));
  assert.equal(store.get().venues, null, 'no accounts slices in none mode');
  d.stop();
});

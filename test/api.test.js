// test/api.test.js — integration tests of the HTTP API against the REAL engine, live layer and journal.
//
// The app is wired exactly like server/main.js (main.js `wire`: venue hook, onTick hook, onMarks → live marks +
// the ephemeral `mids` pulse), but with a small population and no loop: the tests drive time themselves with
// engine.tick() / the `tick` command. The real-price suite runs the hyperliquid feed against an offline double
// (test/fixtures/hl-double.js) on an injected clock.
// Requests go through node:http (not fetch) so the tests control every header, including Host,
// Origin and the proxy headers that the command-auth rules look at. No network beyond 127.0.0.1.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import { Engine } from '../server/engine.js';
import { Journal } from '../server/journal.js';
import { LiveLayer } from '../server/live.js';
import { createServer } from '../server/http.js';
import { OPS, EVENT_KINDS } from '../server/catalog.js';
import { parseConfig, commandPolicyLines, wire, stateFiles } from '../server/main.js';
import { Pulse } from '../server/pulse.js';
import { BAR_MS } from '../server/market.js';
import { makeHL, fixture, T0 } from './fixtures/hl-double.js';

const quiet = () => {};
const TOKEN = 'test-token-0123456789';
const AUTH_DENIED = 'command needs a token (or a same-origin request from loopback)';
const SHELF = 'beans?tradeable=true&distinct_coin=true&busted=false&trades_min=1&limit=5&sort=-total_return';

// SPEC §4 shapes
const BEAN_ROW_KEYS = [
  'id', 'archetype', 'family', 'mode', 'strategy', 'coin', 'leverage', 'position_size', 'lookback', 'entry_threshold',
  'stop_loss', 'take_profit', 'cooldown_bars', 'min_hold_bars', 'max_hold_bars', 'equity', 'total_return', 'ret_1h',
  'ret_1d', 'ret_7d', 'sharpe', 'max_dd', 'trades', 'win_rate', 'fitness', 'busted', 'breached', 'in_position', 'side',
  'units', 'entry_px', 'tradeable', 'venue_max_leverage', 'venue_reason', 'bot',
];
const BOT_ROW_KEYS = [
  'id', 'index', 'bean', 'coin', 'capital_usd', 'leverage', 'state', 'created_ms', 'updated_ms', 'closed_ms', 'bean_side',
  'bean_units', 'bean_equity', 'target_sz', 'sz_decimals', 'fills', 'orders', 'volume', 'fees', 'realized_pnl',
  'notional_usd', 'last_error', 'last_error_ms', 'last_reconcile_ms', 'note', 'real',
  'mark_px', 'mark_ms', 'price_stale', // GAME-DESIGN §10.5
];
const REAL_KEYS = ['szi', 'entry_px', 'unrealized_pnl', 'margin_used', 'liquidation_px', 'leverage', 'as_of_ms'];
const FILL_KEYS = ['bot', 'coin', 'dir', 'side', 'sz', 'px', 'fee', 'closed_pnl', 'time_ms', 'tick'];
const LIVE_STATUS_KEYS = [
  'mode', 'network', 'dry_run', 'armed', 'halted', 'halted_ms', 'disabled_reason', 'bots', 'active', 'paused', 'closed',
  'deployed_usd', 'open_notional_usd', 'realized_pnl', 'unrealized_pnl', 'last_reconcile_ms', 'last_error',
  'last_error_ms', 'fills_logged', 'exchange_stops', 'caps', 'account_state', 'universe',
  'account_usd', 'available_usd', 'prices', 'paper', 'stale_coins', // GAME-DESIGN §10.5
];
const HEALTH_KEYS = [
  'ok', 'version', 'tick', 'bar_idx', 'beans', 'now_ms', 'market_time_ms', 'uptime_s', 'feed', 'daemon',
  'prices', 'paper', 'feed_state', // GAME-DESIGN §10.5
];
/** The shapes other packages code against (test/fixtures/*.json) must match what the server sends. */
const STATUS_REAL = fixture('status-real.json');
const MARKET_REAL = fixture('market-real.json');
const MIDS_FRAME = fixture('mids.json');
const sortedKeys = (o) => Object.keys(o).sort();

function hasKeys(obj, keys, what) {
  assert.ok(obj && typeof obj === 'object', `${what} is an object`);
  for (const k of keys) assert.ok(Object.hasOwn(obj, k), `${what} has '${k}'`);
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------------------------
// HTTP helpers

/**
 * One request with full header control. `body` (object or string) is sent as JSON.
 * @returns {Promise<{status:number, headers:object, text:string, json:any}>}
 */
function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers };
    if (payload !== undefined && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) {
      h['Content-Type'] = 'application/json';
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (/json/.test(res.headers['content-type'] ?? '')) {
          try { json = JSON.parse(text); } catch { /* leave null */ }
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const getJson = (port, path, headers) => request(port, { path: `/api/v1/${path}`, headers });
const postJson = (port, op, body = {}, headers) => request(port, { method: 'POST', path: `/api/v1/${op}`, body, headers });

/** Open the SSE stream; the returned handle accumulates text and can wait for a predicate. */
function openStream(port, { headers = {}, query = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/api/v1/events/stream${query}`, headers, agent: false }, (res) => {
      res.setEncoding('utf8');
      const s = { res, text: '', waiters: new Set() };
      res.on('data', (chunk) => {
        s.text += chunk;
        for (const w of [...s.waiters]) w();
      });
      res.on('error', () => {});
      s.until = (pred, ms = 3000) => new Promise((ok, fail) => {
        const check = () => {
          if (!pred(s.text)) return;
          done();
          ok(s.text);
        };
        const timer = setTimeout(() => {
          done();
          fail(new Error(`SSE wait timed out; received:\n${s.text.slice(-800)}`));
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

/** Parse SSE text into frames [{id, event, data}] (comments and retry lines skipped). */
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

const countEvents = (text, kind) => sseFrames(text).filter((f) => f.event === kind).length;

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

// ---------------------------------------------------------------------------------------------

describe('HTTP API (real engine, small population)', () => {
  let journal, engine, live, pulse, server, port, tokenServer, tokenPort;

  before(async () => {
    journal = new Journal({ keep: 5000, log: quiet });
    engine = new Engine({ config: { seed: 42, beans: 300, warmupBars: 300, tickMs: 60_000, log: quiet }, journal });
    live = new LiveLayer({ config: { accountUsd: 10_000 }, engine, journal, log: quiet });
    pulse = new Pulse({ log: quiet });
    wire({ engine, live, pulse }); // exactly as in main.js
    await engine.start();

    server = createServer({ engine, live, journal, pulse, config: { version: '0.0.0-test', log: quiet } });
    port = await listen(server);
    // a second door onto the same app, with a command token configured
    tokenServer = createServer({ engine, live, journal, pulse, config: { token: TOKEN, version: '0.0.0-test', log: quiet } });
    tokenPort = await listen(tokenServer);
  });

  after(async () => {
    await closeServer(server);
    await closeServer(tokenServer);
  });

  // ------------------------------------------------------------------ discovery + basic queries

  describe('queries', () => {
    it('GET /api/v1 publishes the operation index', async () => {
      const r = await getJson(port, '');
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['access-control-allow-origin'], '*');
      assert.equal(r.json.name, 'bean-garden API');
      assert.equal(r.json.api_version, 1);
      assert.equal(r.json.version, '0.0.0-test');
      assert.equal(r.json.command_policy, 'loopback');
      assert.deepEqual(r.json.operations.map((o) => o.name), OPS.map((o) => o.name));
      for (const op of r.json.operations) {
        assert.ok(op.kind === 'query' || op.kind === 'command');
        assert.equal(op.method, op.kind === 'query' ? 'GET' : 'POST');
        assert.equal(op.path, `/api/v1/${op.name}`);
      }
      const t = await getJson(tokenPort, '');
      assert.equal(t.json.command_policy, 'token');
    });

    it('health and status', async () => {
      const h = await getJson(port, 'health');
      assert.equal(h.status, 200);
      hasKeys(h.json, HEALTH_KEYS, 'health');
      assert.equal(h.json.ok, true);
      assert.equal(h.json.beans, 300);
      assert.equal(h.json.tick, h.json.bar_idx + 1);
      assert.ok(h.json.tick >= 300);
      assert.equal(h.json.feed, 'sim');
      assert.equal(h.json.prices, 'sim');
      assert.equal(h.json.paper, true);
      assert.equal(h.json.feed_state, 'sim');
      assert.deepEqual(h.json.daemon, { running: false, tick_ms: 60_000, aligned: false, next_tick_ms: null });

      const s = await getJson(port, 'status');
      assert.equal(s.status, 200);
      hasKeys(s.json, [...HEALTH_KEYS, 'last_tick_duration_ms', 'population'], 'status');
      hasKeys(s.json.feed, ['source', 'coins', 'ok', 'error', 'stale'], 'status.feed');
      assert.deepEqual(sortedKeys(s.json.feed), sortedKeys(STATUS_REAL.feed), 'status.feed has the §10.5 fields');
      assert.equal(s.json.feed.source, 'sim');
      assert.equal(s.json.feed.coins, 16);
      assert.equal(s.json.feed.real, false);
      assert.equal(s.json.feed.state, 'sim');
      assert.deepEqual(s.json.feed.stale_coins, []);
      assert.equal(s.json.feed.fallback, null);
      assert.equal(s.json.population.beans, 300);
      assert.equal(s.json.population.by_archetype.reduce((n, a) => n + a.count, 0), 300);
    });

    it('meta and market', async () => {
      const m = await getJson(port, 'meta');
      assert.equal(m.status, 200);
      assert.equal(m.json.archetypes.length, 9);
      assert.deepEqual(m.json.strategies, ['momentum', 'mean_reversion', 'breakout', 'ma_cross', 'rsi_reversal']);
      assert.equal(m.json.coins.length, 16);
      assert.deepEqual(m.json.events, [...EVENT_KINDS]);
      assert.ok(m.json.events.includes('feed_status') && m.json.events.includes('feed_gap'));
      assert.deepEqual(m.json.stream_only_events, ['mids']);
      hasKeys(m.json.scales, ['sharpe', 'return', 'return_dd2'], 'meta.scales');
      hasKeys(m.json.columns, BEAN_ROW_KEYS, 'meta.columns');

      const k = await getJson(port, 'market');
      assert.equal(k.status, 200);
      assert.equal(k.json.feed_ok, true);
      assert.equal(typeof k.json.market_time_ms, 'number');
      assert.equal(k.json.coins.length, 16);
      for (const c of k.json.coins) {
        hasKeys(c, ['coin', 'index', 'mid', 'change_24h', 'bars', 'stale', 'max_leverage', 'sz_decimals', 'beans', 'positioned'], `market ${c.coin}`);
        assert.deepEqual(sortedKeys(c), sortedKeys(MARKET_REAL.coins[0]), 'market coins carry the §10.5 fields');
        assert.ok(c.mid > 0);
        assert.equal(c.px, c.mid);
        assert.equal(c.close, c.mid);
        assert.equal(c.source, 'sim');
        assert.equal(c.prev_day_px, null, 'Hyperliquid day stats are null in sim');
        assert.equal(c.funding_1h, null);
      }
      assert.equal(k.json.coins.reduce((n, c) => n + c.beans, 0), 300);
    });

    it('beans with the garden shelf params: top 5 tradeable, one per coin, sorted by return', async () => {
      const r = await getJson(port, SHELF);
      assert.equal(r.status, 200);
      const { rows } = r.json;
      assert.ok(rows.length > 0 && rows.length <= 5, `rows: ${rows.length}`);
      assert.equal(r.json.limit, 5);
      assert.equal(r.json.offset, 0);
      assert.equal(r.json.sort, '-total_return');
      assert.deepEqual(r.json.venue, { known: true, network: 'sim' });
      assert.ok(r.json.total >= rows.length);
      assert.equal(new Set(rows.map((b) => b.coin)).size, rows.length, 'one bean per coin');
      for (const b of rows) {
        hasKeys(b, BEAN_ROW_KEYS, `bean ${b.id}`);
        assert.equal(b.tradeable, true);
        assert.equal(b.busted, false);
        assert.equal(b.venue_reason, null);
        assert.equal(b.bot, null);
        assert.ok(b.trades >= 1);
      }
      for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].total_return >= rows[i].total_return, 'sorted descending');
    });

    it('beans with in_position=true ("sprouting now") only returns positioned beans', async () => {
      const r = await getJson(port, `${SHELF}&in_position=true`);
      assert.equal(r.status, 200);
      assert.ok(r.json.rows.length > 0);
      for (const b of r.json.rows) {
        assert.notEqual(b.side, 0);
        assert.ok(b.in_position === 'long' || b.in_position === 'short');
        assert.ok(b.entry_px > 0);
        assert.equal(Math.sign(b.units), b.side);
      }
    });

    it('bean_detail and equity_curves', async () => {
      const shelf = (await getJson(port, SHELF)).json.rows;
      const id = shelf[0].id;
      const d = await getJson(port, `bean_detail?id=${id}`);
      assert.equal(d.status, 200);
      assert.equal(d.json.bean.id, id);
      hasKeys(d.json.genome, ['archetype', 'strategy', 'coin', 'leverage', 'position_size', 'lookback', 'entry_threshold', 'stop_loss', 'take_profit', 'cooldown_bars', 'min_hold_bars', 'max_hold_bars'], 'genome');
      assert.equal(typeof d.json.describe, 'string');
      assert.ok(Array.isArray(d.json.curve) && d.json.curve.length >= 2);
      assert.deepEqual(d.json.curve[0], { h: 0, equity: 1000 });
      assert.ok(d.json.trades.length >= 1 && d.json.trades.length <= 50);
      hasKeys(d.json.trades[0], ['bar', 'time_ms', 'action', 'side', 'px', 'units', 'pnl', 'reason'], 'trade');

      assert.equal((await getJson(port, 'bean_detail?id=999999')).status, 404);

      const ids = shelf.map((b) => b.id);
      const c = await getJson(port, `equity_curves?ids=${ids.join(',')}`);
      assert.equal(c.status, 200);
      assert.equal(c.json.capital, 1000);
      assert.deepEqual(Object.keys(c.json.curves).sort(), ids.map(String).sort());
      for (const curve of Object.values(c.json.curves)) {
        assert.equal(curve.length, d.json.curve.length, 'every bean shares the hourly timeline');
        assert.deepEqual(curve[0], { h: 0, equity: 1000 });
      }
      assert.deepEqual(c.json.curves[String(id)], d.json.curve);
      // JSON-array form works too
      const j = await getJson(port, `equity_curves?ids=${encodeURIComponent(JSON.stringify(ids.slice(0, 2)))}`);
      assert.equal(Object.keys(j.json.curves).length, 2);
    });

    it('bots, live_status, live_fills and events on a fresh layer', async () => {
      const b = await getJson(port, 'bots');
      assert.deepEqual(b.json, { rows: [], total: 0, mode: 'sim' });

      const s = await getJson(port, 'live_status');
      assert.equal(s.status, 200);
      hasKeys(s.json, LIVE_STATUS_KEYS, 'live_status');
      hasKeys(s.json.caps, ['max_bots', 'max_bot_capital_usd', 'min_capital_usd', 'max_total_notional_usd'], 'caps');
      hasKeys(s.json.account_state, ['account_value', 'withdrawable', 'total_margin_used', 'total_ntl_pos', 'as_of_ms'], 'account_state');
      hasKeys(s.json.universe, ['coins', 'fetched_ms'], 'universe');
      assert.equal(s.json.mode, 'sim');
      assert.equal(s.json.network, 'sim');
      assert.equal(s.json.dry_run, false);
      assert.equal(s.json.armed, true);
      assert.equal(s.json.halted, false);
      assert.equal(s.json.exchange_stops, false);
      assert.equal(s.json.account_state.account_value, 10_000);
      assert.equal(s.json.universe.coins, 16);
      assert.equal(s.json.prices, 'sim');
      assert.equal(s.json.paper, true);
      assert.deepEqual(s.json.stale_coins, []);

      const f = await getJson(port, 'live_fills');
      assert.deepEqual(f.json, { rows: [], total: 0 });

      const e = await getJson(port, 'events?limit=3');
      assert.equal(e.status, 200);
      assert.ok(e.json.total >= 1);
      assert.ok(e.json.rows.length >= 1 && e.json.rows.length <= 3);
      for (const r of e.json.rows) hasKeys(r, ['seq', 't', 'kind'], 'journal record');
      const w = await getJson(port, 'events?kind=warmup_finished');
      assert.equal(w.json.total, 1);
      assert.equal(w.json.rows[0].bars, 300);
      assert.ok(Number.isFinite(w.json.rows[0].ms));
    });

    it('events are newest first and filter by kind', async () => {
      engine.tick();
      engine.tick();
      const e = await getJson(port, 'events?kind=tick_completed&limit=2');
      assert.equal(e.status, 200);
      assert.equal(e.json.rows.length, 2);
      assert.ok(e.json.rows[0].seq > e.json.rows[1].seq, 'newest first');
      for (const r of e.json.rows) {
        assert.equal(r.kind, 'tick_completed');
        hasKeys(r, ['seq', 't', 'kind', 'tick', 'bar', 'time_ms', 'dur_ms', 'fills', 'busted', 'exits', 'closed_ms', 'next_tick_ms', 'source'], 'tick_completed');
        assert.equal(r.bar, r.tick - 1);
        assert.equal(r.closed_ms, r.time_ms + BAR_MS);
        assert.equal(r.source, 'sim');
        assert.equal(Object.hasOwn(r, 'busted_ids'), false, 'engine-internal busted_ids stays out of the journal');
      }
      const paged = await getJson(port, 'events?kind=tick_completed&limit=1&offset=1');
      assert.equal(paged.json.rows[0].seq, e.json.rows[1].seq);
    });
  });

  // ------------------------------------------------------------------ errors

  describe('validation and routing errors', () => {
    const expectError = (r, status, re) => {
      assert.equal(r.status, status, r.text);
      assert.equal(r.json.status, status);
      assert.equal(typeof r.json.error, 'string');
      if (re) assert.match(r.json.error, re);
    };

    it('400 on unknown parameter, bad type, enum miss, out of range and missing required', async () => {
      expectError(await getJson(port, 'beans?bogus=1'), 400, /unknown parameter 'bogus'/);
      expectError(await getJson(port, 'beans?limit=abc'), 400, /limit/);
      expectError(await getJson(port, 'beans?limit=1.5'), 400, /integer/);
      expectError(await getJson(port, 'beans?busted=maybe'), 400, /boolean/);
      expectError(await getJson(port, 'beans?sort=-nope'), 400, /sort/);
      expectError(await getJson(port, 'beans?limit=5000'), 400, /limit/);
      expectError(await getJson(port, 'bean_detail'), 400, /missing required parameter 'id'/);
      expectError(await getJson(port, 'equity_curves?ids=1,x'), 400, /integer/);
      expectError(await postJson(port, 'bot_create', {}), 400, /missing required parameter 'bean'/);
      expectError(await postJson(port, 'bot_create', { bean: 'one', capital_usd: 100 }), 400, /integer/);
      expectError(await postJson(port, 'bot_create', { bean: 1, capital_usd: 100, extra: true }), 400, /unknown parameter 'extra'/);
      expectError(await postJson(port, 'tick', { n: 0 }), 400, /n/);
      expectError(await postJson(port, 'tick', { n: 1441 }), 400, /n/);
      expectError(await postJson(port, 'tick', '{not json'), 400, /invalid JSON/);
      expectError(await postJson(port, 'tick', '[1,2]'), 400, /object/);
    });

    it('an explicitly empty ids list matches nothing (not "no filter"); ∞ is printed as Infinity', async () => {
      for (const q of ['ids=', 'ids=,,,', `ids=${encodeURIComponent('[]')}`]) {
        const r = await getJson(port, `beans?${q}`);
        assert.equal(r.status, 200, r.text);
        assert.deepEqual([r.json.rows.length, r.json.total], [0, 0], q);
      }
      assert.equal((await getJson(port, 'beans?limit=3')).json.rows.length, 3, 'a missing key is still "no filter"');
      expectError(await getJson(port, 'equity_curves?ids=,'), 400, /at least 1/);
      expectError(await postJson(port, 'tick', '{"n":1e400}'), 400, /got Infinity/);
      expectError(await postJson(port, 'bot_create', '{"bean":1,"capital_usd":-1e400}'), 400, /finite number \(got -Infinity\)/);
    });

    it('booleans accept 1|yes|on and 0|no|off; arrays accept CSV and JSON', async () => {
      const a = await getJson(port, 'beans?busted=no&in_position=on&limit=3');
      const b = await getJson(port, 'beans?busted=0&in_position=1&limit=3');
      assert.equal(a.status, 200);
      assert.deepEqual(a.json.rows.map((r) => r.id), b.json.rows.map((r) => r.id));
      const c = await getJson(port, `beans?ids=${encodeURIComponent('[3,1,2]')}&sort=id`);
      assert.deepEqual(c.json.rows.map((r) => r.id), [1, 2, 3]);
    });

    it('404 for unknown operations and paths, 405 for the wrong method', async () => {
      expectError(await getJson(port, 'nope'), 404, /unknown operation 'nope'/);
      expectError(await postJson(port, 'nope', {}), 404);
      expectError(await request(port, { path: '/api/v2/health' }), 404);
      const p = await postJson(port, 'health', {});
      expectError(p, 405);
      assert.equal(p.headers.allow, 'GET');
      const g = await getJson(port, 'bot_create');
      expectError(g, 405);
      assert.equal(g.headers.allow, 'POST');
      expectError(await request(port, { method: 'DELETE', path: '/api/v1/beans' }), 405);
    });

    it('413 for a command body over 64 KB', async () => {
      const r = await postJson(port, 'tick', JSON.stringify({ n: 1, pad: 'x'.repeat(70 * 1024) }));
      expectError(r, 413);
    });
  });

  // ------------------------------------------------------------------ command auth

  describe('command auth', () => {
    // `tick {n:1}` is a harmless command: 200 means "auth passed", 401 means "refused".
    const tick = (p, headers) => postJson(p, 'tick', { n: 1 }, headers);
    const allowed = (r) => assert.equal(r.status, 200, r.text);
    const denied = (r) => {
      assert.equal(r.status, 401, r.text);
      assert.deepEqual(r.json, { error: AUTH_DENIED, status: 401 });
    };

    it('no token configured: loopback with no Origin, or its own Origin, is allowed', async () => {
      allowed(await tick(port));
      allowed(await tick(port, { Origin: `http://127.0.0.1:${port}` }));
      allowed(await tick(port, { Host: `localhost:${port}`, Origin: `http://localhost:${port}` }));
      allowed(await tick(port, { Host: 'localhost' }));
    });

    it('loopback with a foreign Origin is refused (CSRF)', async () => {
      denied(await tick(port, { Origin: 'http://evil.com' }));
      denied(await tick(port, { Origin: 'null' }));
      denied(await tick(port, { Origin: `http://127.0.0.1:${port + 1}` }));
      denied(await tick(port, { Origin: `https://127.0.0.1:${port}` }));
    });

    it('a non-loopback Host header is refused (DNS rebinding)', async () => {
      denied(await tick(port, { Host: 'evil.com' }));
      denied(await tick(port, { Host: `evil.com:${port}` }));
      denied(await tick(port, { Host: `127.0.0.1.evil.com:${port}` }));
    });

    it('any proxy header is refused (the peer is not really loopback)', async () => {
      for (const [h, v] of [
        ['X-Forwarded-For', '203.0.113.7'],
        ['CF-Connecting-IP', '203.0.113.7'],
        ['X-Real-IP', '203.0.113.7'],
        ['Forwarded', 'for=203.0.113.7'],
      ]) {
        denied(await tick(port, { [h]: v }));
      }
    });

    it('queries never need a token, whatever the Origin or Host', async () => {
      const r = await getJson(port, 'health', { Origin: 'http://evil.com', Host: 'evil.com', 'X-Forwarded-For': '203.0.113.7' });
      assert.equal(r.status, 200);
      assert.equal(r.headers['access-control-allow-origin'], '*');
    });

    it('token configured: a valid Bearer or X-Brood-Token works from "anywhere"; missing or wrong is refused', async () => {
      const remote = { 'X-Forwarded-For': '203.0.113.7', Origin: 'https://some.app.example' };
      denied(await tick(tokenPort, remote));
      denied(await tick(tokenPort, { ...remote, Authorization: 'Bearer wrong-token' }));
      denied(await tick(tokenPort, { ...remote, Authorization: `Bearer ${TOKEN}x` }));
      denied(await tick(tokenPort, { ...remote, Authorization: TOKEN })); // no Bearer scheme
      denied(await tick(tokenPort, { ...remote, 'X-Brood-Token': 'wrong' }));
      allowed(await tick(tokenPort, { ...remote, Authorization: `Bearer ${TOKEN}` }));
      allowed(await tick(tokenPort, { ...remote, 'X-Brood-Token': TOKEN }));
      allowed(await tick(tokenPort, { Host: 'evil.com', Authorization: `bearer ${TOKEN}` }));
      // the loopback rule still applies alongside the token (SPEC §4 rule 2)
      allowed(await tick(tokenPort));
    });

    it('a wrong Bearer (e.g. injected by a proxy) does not hide a valid X-Brood-Token, and vice versa', async () => {
      const remote = { 'X-Forwarded-For': '203.0.113.7' };
      allowed(await tick(tokenPort, { ...remote, Authorization: 'Bearer proxy-credential', 'X-Brood-Token': TOKEN }));
      allowed(await tick(tokenPort, { ...remote, Authorization: `Bearer ${TOKEN}`, 'X-Brood-Token': 'stale' }));
      denied(await tick(tokenPort, { ...remote, Authorization: 'Bearer nope', 'X-Brood-Token': 'nope' }));
    });

    it('loopbackCommands: false (--no-loopback-commands) makes the token mandatory, even from loopback', async () => {
      const strict = createServer({ engine, live, journal, config: { token: TOKEN, loopbackCommands: false, version: '0.0.0-test', log: quiet } });
      const strictPort = await listen(strict);
      try {
        denied(await tick(strictPort)); // same-origin loopback, e.g. a request arriving through ssh -R / socat
        denied(await tick(strictPort, { Host: 'localhost', Origin: `http://localhost:${strictPort}` }));
        allowed(await tick(strictPort, { Authorization: `Bearer ${TOKEN}` }));
        assert.equal((await getJson(strictPort, 'health')).status, 200, 'queries stay open');
      } finally {
        await closeServer(strict);
      }
      // without a token the flag cannot apply (nothing could ever run a command)
      const lax = createServer({ engine, live, journal, config: { loopbackCommands: false, version: '0.0.0-test', log: quiet } });
      const laxPort = await listen(lax);
      try {
        allowed(await tick(laxPort));
      } finally {
        await closeServer(lax);
      }
    });

    it('CORS preflight allows the token headers', async () => {
      const r = await request(port, {
        method: 'OPTIONS',
        path: '/api/v1/bot_create',
        headers: { Origin: 'https://some.app.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' },
      });
      assert.equal(r.status, 204);
      assert.equal(r.headers['access-control-allow-origin'], '*');
      assert.match(r.headers['access-control-allow-methods'], /POST/);
      const allowedHeaders = r.headers['access-control-allow-headers'].toLowerCase();
      for (const h of ['authorization', 'x-brood-token', 'content-type']) assert.ok(allowedHeaders.includes(h), h);
    });
  });

  // ------------------------------------------------------------------ SSE

  describe('event stream', () => {
    it('flushes retry + hello at once, then streams journal records', async () => {
      const s = await openStream(port);
      try {
        assert.equal(s.res.statusCode, 200);
        assert.match(s.res.headers['content-type'], /^text\/event-stream/);
        assert.equal(s.res.headers['cache-control'], 'no-cache, no-transform');
        assert.equal(s.res.headers['x-accel-buffering'], 'no');
        await s.until((t) => t.includes(': hello'));
        assert.ok(s.text.startsWith('retry: 3000\n: hello\n\n'), JSON.stringify(s.text.slice(0, 40)));
        assert.equal(countEvents(s.text, 'tick_completed'), 0, 'no replay without Last-Event-ID');

        const summary = engine.tick();
        await s.until((t) => countEvents(t, 'tick_completed') >= 1);
        const frame = sseFrames(s.text).find((f) => f.event === 'tick_completed');
        assert.equal(Number(frame.id), frame.data.seq);
        assert.equal(frame.data.kind, 'tick_completed');
        assert.equal(frame.data.tick, summary.tick);
      } finally {
        s.close();
      }
    });

    it('ephemeral `mids` frames: after every tick, NO id line, never in `events`, never replayed', async () => {
      const s = await openStream(port);
      try {
        await s.until((t) => t.includes(': hello'));
        const lastSeq = journal.lastSeq;
        const summary = engine.tick();
        await s.until((t) => countEvents(t, 'mids') >= 1 && countEvents(t, 'tick_completed') >= 1);
        const block = s.text.split('\n\n').find((b) => b.includes('event: mids'));
        assert.ok(!/^id:/m.test(block), `no id line: ${block.slice(0, 80)}`);
        const frame = sseFrames(s.text).find((f) => f.event === 'mids');
        assert.equal(frame.id, undefined);
        const m = frame.data;
        assert.deepEqual(Object.keys(m), Object.keys(MIDS_FRAME), 'same shape as test/fixtures/mids.json');
        assert.equal(m.kind, 'mids');
        assert.equal(m.prices, 'sim');
        assert.equal(m.source, 'sim');
        assert.equal(Object.keys(m.px).length, 16);
        assert.equal(m.px.BTC, engine.market.mid('BTC'));
        assert.equal(m.bar.tick, summary.tick);
        assert.deepEqual(sortedKeys(m.account), sortedKeys(MIDS_FRAME.account));
        // the journal and its seq never see a pulse
        assert.equal(journal.lastSeq, lastSeq + countEvents(s.text, 'tick_completed') + journal.query({ kind: 'busted' }).rows.filter((r) => r.seq > lastSeq).length);
        assert.equal((await getJson(port, 'events?kind=mids')).json.total, 0);
        const tc = sseFrames(s.text).find((f) => f.event === 'tick_completed');
        assert.equal(Number(tc.id), tc.data.seq, 'journal frames keep their id');
      } finally {
        s.close();
      }
      // a reconnect with Last-Event-ID replays journal records only
      const r = await openStream(port, { headers: { 'Last-Event-ID': '0' } });
      try {
        await r.until((t) => countEvents(t, 'warmup_finished') >= 1);
        assert.equal(countEvents(r.text, 'mids'), 0);
      } finally {
        r.close();
      }
    });

    it('replays missed records after Last-Event-ID (header or ?lastEventId=)', async () => {
      const last = journal.lastSeq;
      const ticks = [engine.tick().tick, engine.tick().tick, engine.tick().tick];
      for (const variant of [{ headers: { 'Last-Event-ID': String(last) } }, { query: `?lastEventId=${last}` }]) {
        const s = await openStream(port, variant);
        try {
          await s.until((t) => countEvents(t, 'tick_completed') >= 3);
          const frames = sseFrames(s.text);
          assert.equal(Number(frames[0].id), last + 1, 'replay starts right after Last-Event-ID');
          const ids = frames.map((f) => Number(f.id));
          assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'in order');
          assert.equal(new Set(ids).size, ids.length, 'no duplicates');
          assert.deepEqual(frames.filter((f) => f.event === 'tick_completed').map((f) => f.data.tick), ticks);
        } finally {
          s.close();
        }
      }
    });
  });

  // ------------------------------------------------------------------ static + docs

  describe('static files and docs', () => {
    it('/ serves the garden page; assets get the right content types', async () => {
      const r = await request(port, { path: '/' });
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(r.headers['cache-control'], 'no-cache');
      assert.match(r.text, /<title>Bean Garden<\/title>/);
      const js = await request(port, { path: '/js/garden.js' });
      assert.equal(js.status, 200);
      assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
      const css = await request(port, { path: '/css/garden.css' });
      assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
      assert.equal((await request(port, { path: '/js/nope.js' })).status, 404);
      const classic = await request(port, { path: '/classic.html' });
      assert.equal(classic.status, 200);
      assert.equal(classic.headers['content-type'], 'text/html; charset=utf-8');
      assert.match(classic.text, /<title>Bean Garden<\/title>/);
    });

    it('text assets are gzip-encoded for clients that accept it (same bytes once decoded), plain otherwise', async () => {
      const zlib = await import('node:zlib');
      const raw = (headers) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/js/garden.js', headers, agent: false }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        }).on('error', reject);
      });
      const plain = await raw({});
      assert.equal(plain.headers['content-encoding'], undefined);
      assert.equal(plain.headers.vary, 'Accept-Encoding');
      const gz = await raw({ 'Accept-Encoding': 'gzip, deflate' });
      assert.equal(gz.headers['content-encoding'], 'gzip');
      assert.equal(Number(gz.headers['content-length']), gz.body.length);
      assert.ok(gz.body.length < plain.body.length / 2, `${gz.body.length} vs ${plain.body.length}`);
      assert.ok(zlib.gunzipSync(gz.body).equals(plain.body));
      assert.match(gz.headers['content-security-policy'], /script-src 'self'/, 'same static headers');
    });

    it('path traversal is blocked (plain, encoded and backslash variants)', async () => {
      for (const path of [
        '/../package.json',
        '/%2e%2e/package.json',
        '/..%2fpackage.json',
        '/%2e%2e%2fpackage.json',
        '/js/..%2f..%2fpackage.json',
        '/..%5cpackage.json',
        '/js/%2e%2e%5c%2e%2e%5cpackage.json',
        '/js/../../server/main.js',
        '/%2e%2e/server/main.js',
        '/.%2e/SPEC.md',
        '/C:%5cWindows%5cwin.ini',
        '/.gitignore',
        '/ENV~1',
        '/GITIGN~1',
      ]) {
        const r = await request(port, { path });
        assert.equal(r.status, 404, `${path} → ${r.status}`);
        assert.ok(!r.text.includes('"bean-garden"') && !r.text.includes('import '), `${path} leaked a file`);
      }
    });

    it('static pages carry a script-restricting CSP (/ = the 3D page, /classic.html = the 2D garden)', async () => {
      for (const page of ['/', '/classic.html']) {
        const r = await request(port, { path: page });
        assert.equal(r.status, 200, page);
        const csp = r.headers['content-security-policy'];
        for (const d of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
          assert.ok(csp.includes(d), `${page}: CSP has ${d}: ${csp}`);
        }
        assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), page);
        assert.match(csp, /img-src 'self' data:/, 'the inline favicon is a data: URI');
        assert.doesNotMatch(r.text, /<script(?![^>]*\bsrc=)/i, `${page}: no inline <script> (and so no import map)`);
        assert.doesNotMatch(r.text, /\sstyle=|\son[a-z]+=/i, `${page}: no inline style or handler attributes`);
        assert.equal(r.headers['x-frame-options'], 'DENY');
        assert.equal(r.headers['x-content-type-options'], 'nosniff');
      }
    });

    it('/vendor/three/ serves exactly the allow-listed three.js files (GAME-DESIGN §10.8)', async () => {
      const min = await request(port, { path: '/vendor/three/build/three.module.min.js' });
      assert.equal(min.status, 200);
      assert.equal(min.headers['content-type'], 'text/javascript; charset=utf-8');
      assert.equal(min.headers['cache-control'], 'no-cache');
      assert.equal(min.headers['x-content-type-options'], 'nosniff');
      assert.equal(min.headers['x-frame-options'], 'DENY');
      assert.match(min.headers['content-security-policy'], /script-src 'self'/);
      assert.ok(min.headers['last-modified']);
      assert.ok(/Three\.js Authors/.test(min.text.slice(0, 200)) && min.text.slice(0, 300).includes('"169"'), 'the three r169 build');
      const full = await request(port, { path: '/vendor/three/build/three.module.js' });
      assert.equal(full.status, 200);
      assert.equal(full.headers['content-type'], 'text/javascript; charset=utf-8');
      const lic = await request(port, { path: '/vendor/three/LICENSE' });
      assert.equal(lic.status, 200);
      assert.equal(lic.headers['content-type'], 'text/plain; charset=utf-8');
      assert.match(lic.text, /MIT/);
      const head = await request(port, { method: 'HEAD', path: '/vendor/three/build/three.module.min.js' });
      assert.equal(head.status, 200);
      assert.equal(head.text, '');
      const cached = await request(port, { path: '/vendor/three/build/three.module.min.js', headers: { 'If-Modified-Since': min.headers['last-modified'] } });
      assert.equal(cached.status, 304);
      assert.equal((await request(port, { method: 'POST', path: '/vendor/three/LICENSE' })).status, 405);
      for (const path of [
        '/vendor/three/package.json',
        '/vendor/three/README.md',
        '/vendor/three/build/three.cjs',
        '/vendor/three/build/three.webgpu.js',
        '/vendor/three/src/Three.js',
        '/vendor/three/examples/jsm/controls/OrbitControls.js',
        '/vendor/three/BUILD/three.module.min.js',
        '/vendor/three/build/../package.json',
        '/vendor/three/build/%2e%2e/package.json',
        '/vendor/three/%2e%2e/%2e%2e/package.json',
        '/vendor/three/build%2fthree.module.min.js',
        '/vendor/three/build%5cthree.module.min.js',
        '/vendor/three/..%5c..%5cpackage.json',
        '/vendor/three/build/three.module.min.js%00',
        '/vendor/three/build/three.module.min.js/',
        '/vendor/three/.bin',
        '/vendor/three/',
        '/vendor/three',
        '/vendor/',
        '/vendor/other/three.module.min.js',
        '/vendor/three/build/three.module.min.js::$DATA',
      ]) {
        const r = await request(port, { path });
        assert.equal(r.status, 404, `${path} → ${r.status}`);
        assert.ok(!r.text.includes('"name": "three"') && !r.text.includes('"bean-garden"'), `${path} leaked a file`);
      }
      // a missing file is a 404 too (e.g. npm install not run)
      const empty = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bean-three-'));
      const srv = createServer({ engine, live, journal, config: { threeDir: empty, version: '0.0.0-test', log: quiet } });
      const p = await listen(srv);
      try {
        assert.equal((await request(p, { path: '/vendor/three/build/three.module.min.js' })).status, 404);
      } finally {
        await closeServer(srv);
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });

    it('dotfiles stay hidden behind Windows 8.3 short names (ENV~1 → .env)', async () => {
      // A scratch web root on the temp drive (usually C:, where 8.3 names are on by default).
      const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bean-web-'));
      fs.writeFileSync(nodePath.join(root, 'index.html'), '<!doctype html><title>t</title>');
      fs.writeFileSync(nodePath.join(root, '.env'), 'SECRET=from-dotfile');
      fs.mkdirSync(nodePath.join(root, '.hidden'));
      fs.writeFileSync(nodePath.join(root, '.hidden', 'key.txt'), 'SECRET=inside-dot-dir');
      const srv = createServer({ engine, live, journal, config: { webDir: root, version: '0.0.0-test', log: quiet } });
      const p = await listen(srv);
      try {
        assert.equal((await request(p, { path: '/' })).status, 200);
        for (const path of ['/.env', '/.hidden/key.txt', '/ENV~1', '/HIDDEN~1/key.txt']) {
          const r = await request(p, { path });
          assert.equal(r.status, 404, `${path} → ${r.status}`);
          assert.ok(!r.text.includes('SECRET'), `${path} leaked a dotfile`);
        }
        if (!fs.existsSync(nodePath.join(root, 'ENV~1'))) {
          console.log('# note: 8.3 short names are off on this volume — the alias case was not exercised');
        }
      } finally {
        await closeServer(srv);
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('/docs is markdown generated from the catalogue', async () => {
      const r = await request(port, { path: '/docs' });
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'text/markdown; charset=utf-8');
      assert.match(r.text, /^# bean-garden API v0\.0\.0-test/);
      for (const op of OPS) assert.ok(r.text.includes(`### \`${op.name}\``), op.name);
      assert.match(r.text, /`bot_order` \| bot, coin, order_kind/);
      assert.match(r.text, /`feed_status` \| state/);
      assert.match(r.text, /`feed_gap` \| from_ms/);
      assert.match(r.text, /Ephemeral stream-only events/);
      assert.match(r.text, /`mids` \| kind, t, source, prices/);
    });
  });

  // ------------------------------------------------------------------ the garden loop: plant → tend → harvest → burn

  describe('commands: bot lifecycle', () => {
    let bean;
    let bot;

    /**
     * A positioned, tradeable bean whose scaled entries clear the $10 minimum and the notional cap with
     * $1000 of water (deterministic for seed 42).
     */
    async function pickBean(excludeCoins = []) {
      const r = await getJson(port, 'beans?in_position=true&tradeable=true&busted=false&limit=1000&sort=-total_return');
      const ok = r.json.rows.filter((b) => {
        // required leverage: a bot with $1000 of water opens ≈ this × $1000 of notional per entry
        const lev = (b.position_size * b.leverage * b.equity) / 1000;
        return lev >= 0.2 && lev <= 9 && !excludeCoins.includes(b.coin);
      });
      assert.ok(ok.length > 0, 'a suitable positioned bean exists');
      return ok[0];
    }

    it('bot_create mirrors the bean immediately', async () => {
      bean = await pickBean();
      const r = await postJson(port, 'bot_create', { bean: bean.id, capital_usd: 1000 });
      assert.equal(r.status, 200, r.text);
      bot = r.json;
      hasKeys(bot, BOT_ROW_KEYS, 'BotRow');
      hasKeys(bot.real, REAL_KEYS, 'BotRow.real');
      assert.equal(bot.price_stale, false);
      assert.ok(bot.mark_px > 0);
      assert.ok(bot.mark_ms > 0);
      assert.equal(bot.id, 'bot-0000');
      assert.equal(bot.index, 0);
      assert.equal(bot.bean, bean.id);
      assert.equal(bot.coin, bean.coin);
      assert.equal(bot.state, 'active');
      assert.equal(bot.capital_usd, 1000);
      assert.equal(bot.leverage, Math.min(bean.leverage, bean.venue_max_leverage));
      // mirrored now, not on the next tick
      assert.equal(bot.bean_side, bean.side);
      assert.notEqual(bot.real.szi, 0);
      assert.equal(Math.sign(bot.real.szi), bean.side);
      assert.equal(bot.real.szi, bot.target_sz);
      assert.ok(Math.abs(bot.real.szi) <= Math.abs(bean.units) + 1e-12, 'floored, never larger than the bean');
      assert.equal(bot.fills, 1);
      assert.ok(bot.real.entry_px > 0 && bot.real.liquidation_px > 0);
      assert.ok(bot.notional_usd >= 10);

      // the shelf now hides the bean and its coin
      const shelf = await getJson(port, SHELF);
      assert.ok(shelf.json.rows.every((b) => b.coin !== bean.coin));
      const row = (await getJson(port, `beans?ids=${bean.id}`)).json.rows[0];
      assert.equal(row.bot, bot.id);
      assert.equal(row.tradeable, false);
      assert.equal(row.venue_reason, 'bean_bound');
    });

    it('bots, bot_detail, live_fills and the journal show the new bot', async () => {
      const b = await getJson(port, 'bots');
      assert.equal(b.json.total, 1);
      assert.equal(b.json.mode, 'sim');
      assert.equal(b.json.rows[0].id, bot.id);
      assert.equal(b.json.rows[0].state, 'active');

      const d = await getJson(port, `bot_detail?id=${bot.id}`);
      assert.equal(d.status, 200);
      assert.equal(d.json.bot.id, bot.id);
      assert.equal(d.json.bean.id, bean.id);
      assert.equal(d.json.fills.length, 1);
      assert.equal(d.json.orders[0].kind, 'mirror');
      assert.equal(d.json.orders[0].status, 'filled');
      assert.equal((await getJson(port, 'bot_detail?id=bot-9999')).status, 404);

      const f = await getJson(port, `live_fills?bot=${bot.id}`);
      assert.equal(f.json.total, 1);
      const fill = f.json.rows[0];
      hasKeys(fill, FILL_KEYS, 'fill');
      assert.equal(fill.dir, bean.side > 0 ? 'Open Long' : 'Open Short');
      assert.equal(fill.side, bean.side > 0 ? 'B' : 'A');
      assert.equal(fill.closed_pnl, 0);
      assert.ok(fill.fee > 0);

      const created = (await getJson(port, 'events?kind=bot_created')).json.rows[0];
      assert.deepEqual(
        { bot: created.bot, bean: created.bean, coin: created.coin, capital_usd: created.capital_usd },
        { bot: bot.id, bean: bean.id, coin: bean.coin, capital_usd: 1000 },
      );
      const order = (await getJson(port, 'events?kind=bot_order')).json.rows[0];
      assert.equal(order.order_kind, 'mirror');
      assert.equal(order.status, 'filled');

      const s = (await getJson(port, 'live_status')).json;
      assert.equal(s.active, 1);
      assert.equal(s.deployed_usd, 1000);
      assert.ok(s.open_notional_usd > 0);
    });

    it('rejects a second bot on the same bean or coin (409) and bad capital (400)', async () => {
      const again = await postJson(port, 'bot_create', { bean: bean.id, capital_usd: 100 });
      assert.equal(again.status, 409);
      assert.match(again.json.error, /bean_bound/);
      assert.equal((await postJson(port, 'bot_create', { bean: bean.id, capital_usd: 5 })).status, 400);
      assert.equal((await postJson(port, 'bot_create', { bean: bean.id, capital_usd: 5000 })).status, 400);
      assert.equal((await postJson(port, 'bot_create', { bean: 999999, capital_usd: 100 })).status, 404);
    });

    it('bot_pause flattens; bot_resume mirrors again at once', async () => {
      const p = await postJson(port, 'bot_pause', { id: bot.id });
      assert.equal(p.status, 200, p.text);
      assert.equal(p.json.state, 'paused');
      assert.equal(p.json.real.szi, 0);
      assert.equal(p.json.fills, 2, 'open + close');
      assert.equal(p.json.real.unrealized_pnl, 0);

      const r = await postJson(port, 'bot_resume', { id: bot.id });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.state, 'active');
      assert.equal(Math.sign(r.json.real.szi), bean.side, 'the bean has not moved: mirrored straight back in');
      assert.equal(r.json.fills, 3);

      const kinds = (await getJson(port, 'events?limit=20')).json.rows.map((e) => e.kind);
      assert.ok(kinds.includes('bot_paused') && kinds.includes('bot_resumed'));
    });

    it('tick n=5 fast-forwards and the bot keeps mirroring', async () => {
      const before = engine.ticks;
      const r = await postJson(port, 'tick', { n: 5 });
      assert.equal(r.status, 200, r.text);
      hasKeys(r.json, ['tick', 'bar', 'time_ms', 'dur_ms', 'fills', 'busted', 'exits', 'closed_ms', 'next_tick_ms', 'source'], 'tick summary');
      assert.equal(r.json.source, 'sim');
      assert.equal(r.json.tick, before + 5);
      assert.equal(r.json.bar, r.json.tick - 1);
      const b = (await getJson(port, 'bots')).json.rows[0];
      const beanNow = (await getJson(port, `beans?ids=${bean.id}`)).json.rows[0];
      assert.equal(b.bean_side, beanNow.side);
      if (b.state === 'active' && beanNow.side === 0) assert.equal(b.real.szi, 0, 'flat bean → flat bot');
      assert.ok(b.last_reconcile_ms > 0);
    });

    it('bot_close flattens and banks the realized pnl (net of fees)', async () => {
      const r = await postJson(port, 'bot_close', { id: bot.id });
      assert.equal(r.status, 200, r.text);
      const closed = r.json;
      assert.equal(closed.state, 'closed');
      assert.ok(closed.closed_ms > 0);
      assert.equal(closed.real.szi, 0);
      assert.equal(closed.real.unrealized_pnl, 0);
      assert.ok(Number.isFinite(closed.realized_pnl));

      const fills = (await getJson(port, `live_fills?bot=${bot.id}&limit=2000`)).json.rows;
      assert.equal(fills.length, closed.fills);
      const net = fills.reduce((s, f) => s + f.closed_pnl - f.fee, 0);
      assert.ok(near(closed.realized_pnl, net, 1e-4), `realized ${closed.realized_pnl} vs fills ${net}`);
      const fees = fills.reduce((s, f) => s + f.fee, 0);
      assert.ok(near(closed.fees, fees, 1e-4));

      const s = (await getJson(port, 'live_status')).json;
      assert.equal(s.active, 0);
      assert.equal(s.closed, 1);
      assert.equal(s.deployed_usd, 0);
      assert.equal(s.unrealized_pnl, 0);
      assert.ok(near(s.realized_pnl, closed.realized_pnl, 1e-5));
      assert.ok(near(s.account_state.account_value, 10_000 + closed.realized_pnl, 1e-5));

      const ev = (await getJson(port, 'events?kind=bot_closed')).json.rows[0];
      assert.equal(ev.bot, bot.id);
      assert.ok(near(ev.realized_pnl, closed.realized_pnl, 1e-6));

      const again = await postJson(port, 'bot_close', { id: bot.id });
      assert.equal(again.status, 409);
      assert.equal((await postJson(port, 'bot_pause', { id: bot.id })).status, 409);
      // coin and bean are free again
      const row = (await getJson(port, `beans?ids=${bean.id}`)).json.rows[0];
      assert.equal(row.bot, null);
    });

    it('bots_halt closes every open bot, then bot_create is refused (409) and the shelf loses `tradeable`', async () => {
      const second = await pickBean([bean.coin]);
      const c = await postJson(port, 'bot_create', { bean: second.id, capital_usd: 200 });
      assert.equal(c.status, 200, c.text);
      assert.equal(c.json.id, 'bot-0001');

      const h = await postJson(port, 'bots_halt', {});
      assert.equal(h.status, 200, h.text);
      assert.equal(h.json.halted, true);
      assert.deepEqual(h.json.closed, ['bot-0001']);
      assert.ok(Number.isFinite(h.json.realized_pnl));

      const s = (await getJson(port, 'live_status')).json;
      assert.equal(s.halted, true);
      assert.equal(s.armed, false);
      assert.ok(s.halted_ms > 0);
      assert.equal(s.active + s.paused, 0);

      const refused = await postJson(port, 'bot_create', { bean: second.id, capital_usd: 100 });
      assert.equal(refused.status, 409);
      assert.match(refused.json.error, /halted/);
      assert.equal((await postJson(port, 'bot_resume', { id: 'bot-0001' })).status, 409);

      const shelf = await getJson(port, SHELF);
      assert.equal(shelf.json.total, 0, 'nothing is tradeable while halted');
      const withoutTradeable = await getJson(port, 'beans?distinct_coin=true&busted=false&trades_min=1&limit=5&sort=-total_return');
      assert.ok(withoutTradeable.json.rows.length > 0);
      assert.ok(withoutTradeable.json.rows.every((b) => b.venue_reason === 'halted'));

      const halted = (await getJson(port, 'events?kind=live_halted')).json.rows[0];
      assert.deepEqual(halted.closed, ['bot-0001']);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('CLI config (server/main.js)', () => {
  it('a command token must be 16+ visible ASCII characters', () => {
    for (const bad of ['x', 'short-token', 'a b c d e f g h i j', 'โทเค็นโทเค็นโทเค็นโทเค็น', 'tab\tinside-the-token-xx']) {
      assert.throws(() => parseConfig(['--token', bad], {}), /command token/, JSON.stringify(bad));
    }
    assert.throws(() => parseConfig([], { BEAN_API_TOKEN: 'tiny' }), /at least 16/);
    assert.equal(parseConfig(['--token', '  0123456789abcdef  '], {}).token, '0123456789abcdef');
    assert.equal(parseConfig([], {}).token, null);
  });

  it('--no-loopback-commands needs a token; the startup lines warn about tunnels', () => {
    assert.throws(() => parseConfig(['--no-loopback-commands'], {}), /needs --token/);
    const strict = parseConfig(['--no-loopback-commands', '--token', TOKEN], {});
    assert.equal(strict.loopbackCommands, false);
    assert.equal(parseConfig([], {}).loopbackCommands, true);
    assert.ok(commandPolicyLines({ token: null }).some((l) => /tunnel or port-forward/.test(l)));
    assert.ok(!commandPolicyLines(strict).some((l) => /tunnel or port-forward/.test(l)));
    assert.ok(commandPolicyLines(strict).some((l) => /token required for every command/.test(l)));
  });

  it('--feed defaults to hyperliquid; --tick-ms is sim only; --warmup ≤ 5000 with real prices', () => {
    const d = parseConfig([], {});
    assert.equal(d.feed, 'hyperliquid');
    assert.equal(d.tickMs, 60_000, 'one bar per real minute');
    assert.equal(d.warmupBars, 2880);
    assert.throws(() => parseConfig(['--tick-ms', '2000'], {}), /real prices run at market speed: one bar per real minute/);
    assert.throws(() => parseConfig(['--feed', 'hyperliquid', '--tick-ms', '3000'], {}), /only for --feed sim/);
    assert.throws(() => parseConfig(['--warmup', '6000'], {}), /at most 5000.*newest 5000 candles/);
    assert.equal(parseConfig(['--warmup', '5000'], {}).warmupBars, 5000);
    const sim = parseConfig(['--feed', 'sim', '--tick-ms', '2000', '--warmup', '6000'], {});
    assert.deepEqual([sim.feed, sim.tickMs, sim.warmupBars], ['sim', 2000, 6000]);
    assert.equal(parseConfig(['--feed', 'sim'], {}).tickMs, 5000);
    assert.throws(() => parseConfig(['--feed', 'binance'], {}), /hyperliquid or sim/);
  });

  it('every npm script parses: start = real prices, sim/dev = the sim feed', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const argsOf = (script) => script.split(/\s+/).slice(2); // drop "node server/main.js"
    for (const name of ['start', 'sim', 'dev', 'fresh']) assert.match(pkg.scripts[name], /^node server\/main\.js/, name);
    assert.equal(parseConfig(argsOf(pkg.scripts.start), {}).feed, 'hyperliquid');
    assert.equal(parseConfig(argsOf(pkg.scripts.fresh), {}).fresh, true);
    assert.equal(parseConfig(argsOf(pkg.scripts.sim), {}).feed, 'sim');
    const dev = parseConfig(argsOf(pkg.scripts.dev), {});
    assert.deepEqual([dev.feed, dev.tickMs], ['sim', 2000]);
    assert.equal(pkg.dependencies.three, '0.169.0', 'three is pinned exactly (browser asset only)');
  });

  it('state files per feed: sim keeps the legacy names, hyperliquid gets -real', () => {
    const dir = nodePath.resolve('some-data');
    assert.deepEqual(stateFiles(dir, 'sim'), { stateFile: nodePath.join(dir, 'state.json'), journalFile: nodePath.join(dir, 'journal.jsonl') });
    assert.deepEqual(stateFiles(dir, 'hyperliquid'), { stateFile: nodePath.join(dir, 'state-real.json'), journalFile: nodePath.join(dir, 'journal-real.jsonl') });
  });
});

// ---------------------------------------------------------------------------------------------

describe('HTTP API with REAL prices (offline Hyperliquid double, injected clock)', () => {
  let clock, hl, journal, engine, live, pulse, server, port;

  before(async () => {
    clock = { ms: T0 };
    hl = makeHL(clock);
    journal = new Journal({ keep: 5000, log: quiet });
    engine = new Engine({
      config: {
        seed: 42, beans: 300, warmupBars: 180, feed: 'hyperliquid', log: quiet,
        now: () => clock.ms, fetch: hl.fetch, sleep: async (ms) => { clock.ms += ms; },
      },
      journal,
    });
    live = new LiveLayer({ config: { accountUsd: 10_000 }, engine, journal, now: () => clock.ms, log: quiet });
    pulse = new Pulse({ log: quiet });
    wire({ engine, live, pulse });
    await engine.start();
    server = createServer({ engine, live, journal, pulse, config: { version: '0.0.0-test', feed: 'hyperliquid', log: quiet } });
    port = await listen(server);
  });

  after(async () => {
    await closeServer(server);
  });

  it('tick is always 409 with real prices (n = 1 too): real prices run at market speed', async () => {
    for (const n of [1, 60]) {
      const r = await postJson(port, 'tick', { n });
      assert.equal(r.status, 409, r.text);
      assert.equal(r.json.error, 'tick is only available with the sim feed — real prices run at market speed');
    }
  });

  it('health, status.feed and market match the fixtures other packages code against', async () => {
    const h = (await getJson(port, 'health')).json;
    hasKeys(h, HEALTH_KEYS, 'health');
    assert.equal(h.feed, 'hyperliquid');
    assert.equal(h.prices, 'real');
    assert.equal(h.paper, true);
    assert.equal(h.feed_state, 'live');
    assert.equal(h.now_ms, clock.ms, 'the server clock (clients compute skew from it)');
    assert.deepEqual(sortedKeys(h.daemon), sortedKeys(STATUS_REAL.daemon));
    assert.equal(h.daemon.tick_ms, 60_000);
    assert.equal(h.daemon.aligned, true);

    const s = (await getJson(port, 'status')).json;
    assert.deepEqual(sortedKeys(s), sortedKeys(STATUS_REAL));
    assert.deepEqual(sortedKeys(s.feed), sortedKeys(STATUS_REAL.feed));
    assert.equal(s.feed.real, true);
    assert.equal(s.feed.state, 'live');
    assert.equal(s.feed.mids_ms, T0);
    assert.equal(s.feed.next_tick_ms, s.market_time_ms + 2 * BAR_MS + 2000);

    const k = (await getJson(port, 'market')).json;
    assert.deepEqual(sortedKeys(k), sortedKeys(MARKET_REAL));
    assert.equal(k.coins.length, 16);
    for (const c of k.coins) {
      assert.deepEqual(sortedKeys(c), sortedKeys(MARKET_REAL.coins[0]), c.coin);
      assert.equal(c.source, 'hyperliquid');
      assert.equal(c.mid, c.px);
      assert.ok(Math.abs(c.px - hl.pxAt(c.coin, T0)) < 1e-9 * c.px, `${c.coin} is the real (double) mid`);
      assert.ok(c.prev_day_px > 0);
      assert.ok(Math.abs(c.change_24h - (c.px / c.prev_day_px - 1)) < 1e-12);
    }
    const meta = (await getJson(port, 'meta')).json;
    const pump = meta.coins.find((c) => c.coin === 'PUMP');
    assert.equal(pump.max_leverage, 10, 'venue limits from Hyperliquid universe');
    assert.equal(k.coins.find((c) => c.coin === 'PUMP').max_leverage, 10);

    const ls = (await getJson(port, 'live_status')).json;
    assert.equal(ls.prices, 'real');
    assert.equal(ls.paper, true);
    assert.deepEqual(ls.stale_coins, []);
  });

  it('a paper bot planted from loopback fills at the live mid with a wall-clock stamp; mids frames mark it every poll', async () => {
    const rows = (await getJson(port, 'beans?in_position=true&tradeable=true&busted=false&limit=1000&sort=-total_return')).json.rows;
    const bean = rows.find((b) => {
      const lev = (b.position_size * b.leverage * b.equity) / 1000;
      return lev >= 0.2 && lev <= 9;
    });
    assert.ok(bean, 'a positioned tradeable bean');
    clock.ms += 3000;
    const r = await postJson(port, 'bot_create', { bean: bean.id, capital_usd: 500 });
    assert.equal(r.status, 200, r.text);
    const bot = r.json;
    // the live price = the latest allMids (polled at T0, 3 s ago: ≤ 15 s old), not the bar close
    const mid = engine.market.livePx(bean.coin);
    assert.ok(Math.abs(mid - hl.pxAt(bean.coin, T0)) < 1e-12 * mid);
    assert.notEqual(mid, engine.market.mid(bean.coin), 'the live mid differs from the last bar close');
    const fill = (await getJson(port, `live_fills?bot=${bot.id}`)).json.rows[0];
    assert.ok(Math.abs(fill.px - mid * (1 + Math.sign(bot.real.szi) * 0.00015)) < 1e-6 * mid, `fill ${fill.px} vs live mid ${mid}`);
    assert.equal(fill.time_ms, clock.ms, 'out-of-tick fill = wall clock');
    assert.equal(bot.mark_ms, T0, 'the mark carries the time of the mid behind it (polled at T0), never "now"');
    assert.equal(bot.real.as_of_ms, T0);
    assert.equal(bot.price_stale, false);

    const s = await openStream(port);
    try {
      await s.until((t) => t.includes(': hello'));
      clock.ms += 5000;
      assert.equal(await engine.pollMids(), true);
      await s.until((t) => countEvents(t, 'mids') >= 1);
      const frame = sseFrames(s.text).find((f) => f.event === 'mids');
      assert.equal(frame.id, undefined);
      const m = frame.data;
      assert.deepEqual(Object.keys(m), Object.keys(MIDS_FRAME));
      assert.equal(m.prices, 'real');
      assert.equal(m.source, 'hyperliquid');
      assert.equal(m.t, clock.ms);
      assert.equal(m.px_ms[bean.coin], clock.ms, 'per-coin price time = this allMids');
      assert.deepEqual(sortedKeys(m.bots[bot.id]), sortedKeys(MIDS_FRAME.bots['bot-0003']));
      const now = hl.pxAt(bean.coin, clock.ms);
      assert.ok(Math.abs(m.bots[bot.id].mark_px - now) < 1e-6 * now);
      assert.equal(m.bots[bot.id].as_of_ms, clock.ms);
      assert.equal((await getJson(port, 'events?kind=mids')).json.total, 0);
    } finally {
      s.close();
    }
  });

  it('a real minute closes → one bar from the candles, tick_completed with closed_ms / next_tick_ms', async () => {
    const before = engine.ticks;
    clock.ms = engine.market.timeMs + 2 * BAR_MS + 2000;
    const out = await engine.runMinute();
    assert.equal(out.kind, 'tick');
    assert.equal(engine.ticks, before + 1);
    const ev = (await getJson(port, 'events?kind=tick_completed&limit=1')).json.rows[0];
    assert.equal(ev.source, 'hyperliquid');
    assert.equal(ev.closed_ms, ev.time_ms + BAR_MS);
    assert.equal(ev.next_tick_ms, ev.closed_ms + BAR_MS + 2000);
    const st = (await getJson(port, 'status')).json.feed;
    assert.deepEqual(st.bar_sources, { candle: 16, mids: 0, flat: 0 });
  });
});

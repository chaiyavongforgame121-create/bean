// test/fixtures/hl-double.js — an offline, deterministic stand-in for Hyperliquid's public info endpoint.
//
// Used by test/feed.test.js and test/api.test.js through an injected `fetch` (Engine config `fetch`), so the
// real-price code paths run without any network. It also guards the read-only contract: only
// POST https://api.hyperliquid.xyz/info with allMids | metaAndAssetCtxs | candleSnapshot, no credentials.
//
// Prices: BASE (from hl-all-mids.json) × (1 + 0.003·sin(minute/7 + coinIndex)) × bump[coin]; `mid[coin]` pins the
// allMids price. Switches on the returned object: `down` (network failure), `status` (HTTP status, e.g. 429),
// `noMids` (coins absent from allMids), `noCandles` (coins without any candle), `noCandleAt` (`${coin}@${openMs}`),
// `meta` (the metaAndAssetCtxs reply; edit it to delist a coin). `calls` counts the requests that were answered.
//
// Mainnet userRole (PLATFORM §11.1; additive, for the fail-closed mainnet guard of §6.7): `roles` maps a lower-case
// address to the reply (default {role:'missing'}; `setRole(addr, role, data?)` is a shortcut); `roleFault` is
// 'fail' (network error) | 'timeout' (hangs until the request's AbortSignal fires) | 'http500' | 'bad' (malformed
// reply) | null; `roleCalls` counts userRole requests. It is kept out of `calls`, whose shape existing tests compare.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COINS, BAR_MS } from '../../server/market.js';
import { HL_INFO_URL } from '../../server/hyperliquid.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));

export const META = fixture('hl-meta-and-asset-ctxs.json');
export const ALL_MIDS = fixture('hl-all-mids.json');
export const NAMES = COINS.map((c) => c.coin);
export const BASE = Object.fromEntries(NAMES.map((c) => [c, Number(ALL_MIDS[c])]));
const SPOT = Object.fromEntries(Object.entries(ALL_MIDS).filter(([k]) => k.startsWith('@')).slice(0, 20));

/** 2026-10-10, 17.3 s into a minute (the fixtures' time). */
export const T0 = 1_791_650_477_332;

/**
 * @param {{ms:number}} clock  the test clock (an object with a readable `ms`)
 */
export function makeHL(clock) {
  const st = {
    down: false, status: null, noMids: new Set(), noCandles: new Set(), noCandleAt: new Set(), mid: {}, bump: {},
    meta: structuredClone(META),
    calls: { allMids: 0, metaAndAssetCtxs: 0, candleSnapshot: 0 },
    failures: 0,
    roles: new Map(), roleFault: null, roleCalls: 0,
  };
  st.setRole = (addr, role, data) => st.roles.set(String(addr).toLowerCase(), data === undefined ? { role } : { role, data });
  const pxAt = (coin, t) => BASE[coin] * (1 + 0.003 * Math.sin(t / BAR_MS / 7 + NAMES.indexOf(coin))) * (st.bump[coin] ?? 1);
  const reply = (data) => ({ ok: true, status: 200, json: async () => structuredClone(data) });
  st.pxAt = pxAt;
  st.fetch = async (url, init) => {
    assert.equal(url, HL_INFO_URL, 'only the public info endpoint');
    assert.equal(init.method, 'POST');
    assert.ok(!('authorization' in (init.headers ?? {})), 'no credentials');
    const body = JSON.parse(init.body);
    assert.ok(['allMids', 'metaAndAssetCtxs', 'candleSnapshot', 'userRole'].includes(body.type), `read-only type (${body.type})`);
    if (st.down) {
      st.failures++;
      throw new TypeError('fetch failed');
    }
    if (st.status) return { ok: false, status: st.status, json: async () => ({}) };
    if (body.type === 'userRole') return answerRole(st, body, init);
    st.calls[body.type]++;
    const now = clock.ms;
    if (body.type === 'metaAndAssetCtxs') return reply(st.meta);
    if (body.type === 'allMids') {
      const out = { ...SPOT };
      for (const c of NAMES) if (!st.noMids.has(c)) out[c] = String(st.mid[c] ?? pxAt(c, now));
      return reply(out);
    }
    const { coin, interval, startTime, endTime } = body.req;
    assert.equal(interval, '1m');
    const rows = [];
    if (!st.noCandles.has(coin)) {
      const oldest = Math.floor(now / BAR_MS) * BAR_MS - 4999 * BAR_MS; // HL keeps the newest 5000
      for (let t = Math.ceil(startTime / BAR_MS) * BAR_MS; t <= endTime && t <= now; t += BAR_MS) {
        if (t < oldest || st.noCandleAt.has(`${coin}@${t}`)) continue;
        const o = pxAt(coin, t);
        const c = pxAt(coin, Math.min(t + BAR_MS, now));
        rows.push({ t, T: t + BAR_MS - 1, s: coin, i: '1m', o: String(o), c: String(c), h: String(Math.max(o, c) * 1.0004), l: String(Math.min(o, c) * 0.9996), v: '1.5', n: 7 });
      }
    }
    return reply(rows);
  };
  return st;
}

/** Mainnet userRole answers and faults (see the header). */
async function answerRole(st, body, init) {
  st.roleCalls++;
  assert.match(body.user, /^0x[0-9a-f]{40}$/, 'userRole user is a lower-case address');
  assert.equal(init.redirect, 'error', 'every Hyperliquid fetch refuses redirects');
  if (st.roleFault === 'fail') throw new TypeError('fetch failed');
  if (st.roleFault === 'timeout') {
    return new Promise((_, reject) => {
      const sig = init.signal;
      const abort = () => reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
      if (sig?.aborted) abort();
      else sig?.addEventListener?.('abort', abort, { once: true });
    });
  }
  if (st.roleFault === 'http500') return { ok: false, status: 500, json: async () => ({}) };
  if (st.roleFault === 'bad') return { ok: true, status: 200, json: async () => ({ nope: true }) };
  const reply = st.roles.get(body.user) ?? { role: 'missing' };
  return { ok: true, status: 200, json: async () => structuredClone(reply) };
}

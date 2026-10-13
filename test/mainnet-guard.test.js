// test/mainnet-guard.test.js — T-GUARD: mainnet orders are impossible by construction (PLATFORM §1.2, §11.2).
//
//   (a) no "api.hyperliquid.xyz/exchange" anywhere in server/ or web/
//   (b) api.hyperliquid.xyz appears in code only in server/hyperliquid.js and server/hl/egress.js, and only as /info
//   (c) the exchange URL constant is the testnet one and cannot be changed
//   (d) a fetch spy over a whole integration run: every /exchange request goes to api.hyperliquid-testnet.xyz
//   (e) the action allowlist refuses withdraw3 / usdSend / … before anything is signed or sent
//   (f) signL1 takes exactly (action, nonce); source "b" is baked in (KAT-2 testnet passes, mainnet does not)
//   (g) the egress guard refuses a runtime-concatenated mainnet /exchange URL, any non-POST and any other host
//   (h) a redirecting double is refused because every Hyperliquid fetch uses redirect:'error'
//   (i) HyperliquidClient refuses a non-HL_INFO_URL url without an injected fetch
//   (j) with the testnet double, zero requests reach any real Hyperliquid host

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HL_INFO_URL, HyperliquidClient } from '../server/hyperliquid.js';
import * as constants from '../server/hl/constants.js';
import { EGRESS_ALLOW, egressGuardInstalled, installEgressGuard, isAllowedEgress } from '../server/hl/egress.js';
import * as exchangeModule from '../server/hl/exchange.js';
import { iocPx, fmtSzWire } from '../server/hl/format.js';
import { createTestnet } from '../server/hl/index.js';
import * as signing from '../server/hl/signing.js';
import { newCloid, orderAction, orderWire, updateLeverageAction, cancelByCloidAction } from '../server/hl/wire.js';
import { makeHL } from './fixtures/hl-double.js';
import { makeTestnetDouble } from './fixtures/hl-testnet-double.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAINNET_HOST = ['api', 'hyperliquid', 'xyz'].join('.'); // built at run time so this file is not a false hit
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.json', '.md', '.txt', '.sql', '.svg', '.webmanifest']);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (TEXT_EXT.has(path.extname(ent.name))) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const SOURCES = [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'web'))];

/** Source text without // line comments and /* block comments (rough, but strings with "//" are URLs we keep). */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

const KEY_HEX = '0123456789012345678901234567890123456789012345678901234567890123';
const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

describe('T-GUARD static checks', () => {
  it('(a) the mainnet /exchange URL occurs nowhere in server/ or web/', () => {
    assert.ok(SOURCES.length > 20, 'the walk found the sources');
    const needle = `${MAINNET_HOST}/exchange`;
    const hits = SOURCES.filter((f) => fs.readFileSync(f, 'utf8').includes(needle)).map(rel);
    assert.deepEqual(hits, []);
  });

  it('(b) api.hyperliquid.xyz only as /info, and in code only in hyperliquid.js and hl/egress.js', () => {
    const re = new RegExp(`${MAINNET_HOST.replace(/\./g, '\\.')}(\\S{0,5})`, 'g');
    const codeFiles = new Set();
    for (const f of SOURCES) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(re)) assert.ok(m[1].startsWith('/info'), `${rel(f)}: ${m[0]}`);
      if (codeOnly(text).includes(MAINNET_HOST)) codeFiles.add(rel(f));
    }
    assert.deepEqual([...codeFiles].sort(), ['server/hl/egress.js', 'server/hyperliquid.js']);
  });

  it('(c) the exchange URL is the frozen testnet constant; there is no URL option or env override', async () => {
    assert.equal(exchangeModule.TESTNET_EXCHANGE_URL, 'https://api.hyperliquid-testnet.xyz/exchange');
    assert.equal(constants.TESTNET_EXCHANGE_URL, exchangeModule.TESTNET_EXCHANGE_URL);
    assert.throws(() => {
      exchangeModule.TESTNET_EXCHANGE_URL = 'https://example.invalid/exchange';
    }, TypeError, 'module bindings are read-only');
    assert.equal(exchangeModule.TESTNET_EXCHANGE_URL, 'https://api.hyperliquid-testnet.xyz/exchange');
    assert.throws(() => exchangeModule.assertTestnetExchangeUrl(`https://${MAINNET_HOST}/exchange`), /non-testnet/);
    assert.throws(() => exchangeModule.assertTestnetExchangeUrl('https://api.hyperliquid-testnet.xyz/exchange?x=1'), /non-testnet/);
    const src = fs.readFileSync(path.join(ROOT, 'server/hl/exchange.js'), 'utf8');
    assert.ok(!/process\.env/.test(src), 'no environment override');
    // A `url` option is ignored: the request still goes to the testnet (the double refuses anything else).
    const dbl = makeTestnetDouble();
    const tn = createTestnet({ fetch: dbl.fetch });
    const { TestnetExchange } = exchangeModule;
    const ex = new TestnetExchange({ scheduler: tn.scheduler, fetch: dbl.fetch, url: 'https://example.invalid/exchange' });
    const a = dbl.addAccount();
    const ag = dbl.addAgent(a.address);
    const res = await ex.post(updateLeverageAction(4, 2), signing.makeSigner(ag.keyBytes), Date.now());
    assert.equal(res.ok, true);
    assert.deepEqual(dbl.violations, []);
    assert.equal(dbl.requests[0].url, 'https://api.hyperliquid-testnet.xyz/exchange');
  });

  it('(e) the action allowlist refuses transfers and withdrawals before signing or sending', async () => {
    assert.deepEqual([...constants.ALLOWED_ACTIONS], ['order', 'cancelByCloid', 'updateLeverage', 'approveAgent']);
    assert.ok(Object.isFrozen(constants.ALLOWED_ACTIONS));
    const dbl = makeTestnetDouble();
    const tn = createTestnet({ fetch: dbl.fetch });
    const signer = signing.makeSigner(Uint8Array.from(Buffer.from(KEY_HEX, 'hex')));
    for (const type of ['withdraw3', 'usdSend', 'spotSend', 'usdClassTransfer', 'sendAsset', 'vaultTransfer', 'subAccountTransfer', 'approveBuilderFee', 'createSubAccount', 'tokenDelegate']) {
      await assert.rejects(tn.exchange.post({ type, destination: '0x0000000000000000000000000000000000000001', amount: '1' }, signer, Date.now()),
        (err) => err.code === 'action_not_allowed', type);
      assert.throws(() => exchangeModule.assertAllowedAction({ type }), (err) => err.code === 'action_not_allowed');
    }
    assert.equal(dbl.requests.length, 0);
  });

  it('(f) signL1(action, nonce) only; source "b" is baked in; nothing in server/hl takes a network flag', () => {
    const signer = signing.makeSigner(Uint8Array.from(Buffer.from(KEY_HEX, 'hex')));
    assert.equal(signer.signL1.length, 2);
    assert.equal(constants.PHANTOM_SOURCE, 'b');
    const sig = signer.signL1({ type: 'dummy', num: 100000000000 }, 0);
    assert.equal(BigInt(sig.r), BigInt('0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510'), 'KAT-2 testnet passes');
    assert.notEqual(BigInt(sig.r), BigInt('0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298'), 'KAT-2 mainnet does not');
    for (const [name, fn] of Object.entries(signing)) {
      if (typeof fn !== 'function') continue;
      const params = /^[^(]*\(([^)]*)\)/.exec(fn.toString())?.[1] ?? '';
      assert.doesNotMatch(params, /mainnet|network|source|testnet/i, `${name}(${params})`);
    }
    for (const f of fs.readdirSync(path.join(ROOT, 'server/hl'))) {
      const code = codeOnly(fs.readFileSync(path.join(ROOT, 'server/hl', f), 'utf8'));
      assert.doesNotMatch(code, /isMainnet|is_mainnet|source:\s*['"]a['"]/, f);
    }
  });
});

describe('T-GUARD runtime checks', () => {
  it('(g) isAllowedEgress: POST to exactly three URLs, nothing else', () => {
    assert.deepEqual([...EGRESS_ALLOW], [`https://${MAINNET_HOST}/info`, 'https://api.hyperliquid-testnet.xyz/info', 'https://api.hyperliquid-testnet.xyz/exchange']);
    for (const u of EGRESS_ALLOW) assert.equal(isAllowedEgress(u, 'POST'), true, u);
    assert.equal(isAllowedEgress('https://api.hyperliquid-testnet.xyz/exchange', 'post'), true);
    const concatenated = 'https://api.hyperliquid' + '.xyz' + '/exchange'; // eslint-disable-line no-useless-concat
    for (const [u, m] of [
      [concatenated, 'POST'],
      [`https://${MAINNET_HOST}/info`, 'GET'],
      [`https://${MAINNET_HOST}/info`, undefined],
      [`https://${MAINNET_HOST}/info?x=1`, 'POST'],
      [`https://${MAINNET_HOST}/info/`, 'POST'],
      [`http://${MAINNET_HOST}/info`, 'POST'],
      [`https://API.hyperliquid.xyz/info`, 'POST'],
      [`https://${MAINNET_HOST}.evil.example/info`, 'POST'],
      ['https://example.com/', 'POST'],
      ['https://api.hyperliquid-testnet.xyz/exchange#x', 'POST'],
      [null, 'POST'],
    ]) assert.equal(isAllowedEgress(u, m), false, `${m} ${u}`);
  });

  it('(g) installEgressGuard wraps globalThis.fetch: denies with an alert, forces redirect:"error", uninstalls', async () => {
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push([typeof input === 'string' ? input : input.url ?? String(input), init]);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const logs = [];
    const uninstall = installEgressGuard({ log: (l) => logs.push(l) });
    try {
      assert.equal(egressGuardInstalled(), true);
      assert.equal(installEgressGuard({ log: () => {} }), uninstall, 'idempotent');
      const concatenated = ['https://api.hyperliquid', '.xyz', '/exchange'].join('');
      await assert.rejects(fetch(concatenated, { method: 'POST', body: '{}' }), (err) => err.code === 'egress_denied');
      await assert.rejects(fetch(`https://${MAINNET_HOST}/info`, { method: 'GET' }), (err) => err.code === 'egress_denied');
      await assert.rejects(fetch(`https://${MAINNET_HOST}/info`), (err) => err.code === 'egress_denied', 'default method GET');
      await assert.rejects(fetch('https://example.com/collect?token=secret', { method: 'POST' }), (err) => err.code === 'egress_denied');
      await assert.rejects(fetch(new URL('https://example.com/'), { method: 'POST' }), (err) => err.code === 'egress_denied');
      await assert.rejects(fetch(new Request('https://example.com/', { method: 'POST' })), (err) => err.code === 'egress_denied');
      assert.equal(calls.length, 0, 'nothing denied reached the network');
      assert.ok(logs.some((l) => /ALERT denied POST https:\/\/api\.hyperliquid\.xyz\/exchange/.test(l)));
      assert.ok(logs.every((l) => !/token=secret/.test(l)), 'query strings are never logged');
      await fetch('https://api.hyperliquid-testnet.xyz/info', { method: 'POST', body: '{}', redirect: 'follow' });
      await fetch(new URL(`https://${MAINNET_HOST}/info`), { method: 'POST', body: '{}' });
      assert.equal(calls.length, 2);
      assert.ok(calls.every(([, init]) => init.redirect === 'error'), 'redirects are always refused');
    } finally {
      uninstall();
    }
    assert.equal(egressGuardInstalled(), false);
    globalThis.fetch = realFetch;
  });

  it('(h) a redirecting double is refused: redirect:"error" on every Hyperliquid fetch, never followed', async () => {
    const dbl = makeTestnetDouble();
    const tn = createTestnet({ fetch: dbl.fetch, sleep: async () => {} });
    const a = dbl.addAccount();
    const ag = dbl.addAgent(a.address);
    dbl.fault({ kind: 'redirect', path: '*', times: 2 });
    const res = await tn.exchange.post(updateLeverageAction(4, 3), signing.makeSigner(ag.keyBytes), Date.now(), { accountAddress: a.address });
    assert.equal(res.code, 'client_error');
    assert.equal(res.redirect, true);
    await assert.rejects(tn.info.allMids(), (err) => err.code === 'client_error' && err.redirect === true);
    assert.deepEqual(dbl.violations, [], 'no request ever followed the redirect');
    assert.ok(dbl.requests.length === 2 && dbl.requests.every((r) => r.redirect === 'error'));
    // The mainnet client also refuses redirects.
    const clock = { ms: Date.now() };
    const hl = makeHL(clock);
    const seen = [];
    const client = new HyperliquidClient({ fetch: async (u, init) => {
      seen.push(init.redirect);
      return hl.fetch(u, init);
    }, now: () => clock.ms });
    await client.allMids();
    await client.userRole('0x14791697260e4c9a71f18484c9f997b308e59325');
    assert.deepEqual(seen, ['error', 'error']);
  });

  it('(i) HyperliquidClient refuses a non-HL_INFO_URL url without an injected fetch', async () => {
    const spy = [];
    globalThis.fetch = async (...args) => {
      spy.push(args);
      throw new Error('no network in tests');
    };
    try {
      assert.throws(() => new HyperliquidClient({ url: `https://${MAINNET_HOST}/exchange` }), /HL_INFO_URL/);
      assert.throws(() => new HyperliquidClient({ url: 'https://api.hyperliquid-testnet.xyz/info' }), /HL_INFO_URL/);
      const ok = new HyperliquidClient({ url: 'https://test.invalid/info', fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
      assert.deepEqual(await ok.allMids(), {}, 'an injected fetch may target anything (tests)');
      const c = new HyperliquidClient();
      assert.equal(c.url, HL_INFO_URL);
      c.url = `https://${MAINNET_HOST}/exchange`; // a mutation at run time is caught before the fetch
      await assert.rejects(c.allMids(), /non-HL_INFO_URL/);
      assert.equal(spy.length, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('(d) + (j) a whole integration run on the double: every /exchange goes to the testnet host, zero requests reach a real host', async () => {
    const real = [];
    globalThis.fetch = async (...args) => {
      real.push(String(args[0]?.url ?? args[0]));
      throw new Error('real network reached');
    };
    try {
      const dbl = makeTestnetDouble();
      const seen = [];
      const spy = async (url, init) => {
        seen.push({ url, method: init.method, redirect: init.redirect });
        return dbl.fetch(url, init);
      };
      const tn = createTestnet({ fetch: spy, mainnetClient: dbl.mainnetInfo, sleep: async () => {}, timers: { setTimeout: () => null, clearTimeout: () => {} } });
      const a = dbl.addAccount({ usd: 2_000 });
      const ag = dbl.addAgent(a.address);
      await tn.market.start();
      const v = await tn.verify.verifyAgent({ accountAddress: a.address, agentKeyBytes: ag.keyBytes });
      assert.equal(v.ok, true);
      const signer = signing.makeSigner(ag.keyBytes);
      let last = 0;
      const reserveNonce = () => (last = Math.max(Date.now(), last + 1));
      const lane = tn.scheduler.lane(1, 'epoch');
      const mid = tn.market.quote('ETH').px;
      const { index, sz_decimals: d } = tn.market.coinInfo('ETH');
      const order = (isBuy, reduceOnly, cloid = newCloid()) => orderAction([orderWire({ asset: index, isBuy, px: iocPx(mid, isBuy, 0.01, d), sz: fmtSzWire(0.02, d), reduceOnly, cloid })]);
      await lane.run(2, (ctx) => tn.exchange.submit({ action: updateLeverageAction(index, 3), signer, accountAddress: a.address, reserveNonce, ctx }));
      const open = await lane.run(2, (ctx) => tn.exchange.submit({ action: order(true, false), signer, accountAddress: a.address, reserveNonce, ctx }));
      assert.equal(open.outcome, 'filled');
      await tn.info.clearinghouseState(a.address);
      await tn.info.userFillsByTime(a.address, 0);
      await tn.market.refreshBook('ETH');
      const flat = await lane.run(0, (ctx) => tn.exchange.submit({ action: order(false, true), signer, accountAddress: a.address, reserveNonce, ctx, priority: 0 }));
      assert.equal(flat.outcome, 'filled');
      await tn.exchange.post(cancelByCloidAction(index, newCloid()), signer, reserveNonce(), { accountAddress: a.address });
      tn.market.stop();
      assert.ok(seen.length > 10);
      for (const r of seen) {
        const u = new URL(r.url);
        if (u.pathname.endsWith('/exchange')) assert.equal(u.host, 'api.hyperliquid-testnet.xyz', r.url);
        assert.equal(r.method, 'POST');
        assert.equal(r.redirect, 'error');
      }
      assert.ok(seen.some((r) => r.url.endsWith('/exchange')));
      assert.deepEqual(real, [], 'zero requests to any real host');
      assert.deepEqual(dbl.violations, []);
      assert.ok(dbl.mainnet.calls >= 1, 'the mainnet guard was answered by the double');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

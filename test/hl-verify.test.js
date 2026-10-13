// test/hl-verify.test.js — credential verification, every §6.7 branch in order, the fail-closed mainnet guard and its
// periodic re-check. Testnet answers come from the testnet double; the mainnet userRole comes from the existing mainnet
// double (test/fixtures/hl-double.js) through the REAL HyperliquidClient.userRole queue. Offline.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HyperliquidClient, USER_ROLE_PER_MIN } from '../server/hyperliquid.js';
import { truncAddr } from '../server/hl/addr.js';
import { INFO_WEIGHT } from '../server/hl/constants.js';
import { createTestnet } from '../server/hl/index.js';
import { addressOf } from '../server/hl/signing.js';
import {
  MainnetRechecker, checkAddress, mainnetRecheck, parseAgentKey, planUpsert, verifyAgent,
} from '../server/hl/verify.js';
import { makeHL } from './fixtures/hl-double.js';
import { checksum, makeTestnetDouble, randomKey } from './fixtures/hl-testnet-double.js';

const T0 = 1_791_700_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const keyBytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));

function rig({ usd = 1000, abstraction = 'default', agent = {} } = {}) {
  const clock = { ms: T0 };
  const now = () => clock.ms;
  const sleep = async (ms) => {
    clock.ms += ms;
  };
  const dbl = makeTestnetDouble({ now });
  const hl = makeHL(clock);
  const mainnet = new HyperliquidClient({ fetch: hl.fetch, now, sleep });
  const tn = createTestnet({ fetch: dbl.fetch, now, sleep, mainnetClient: mainnet, timers: { setTimeout: () => null, clearTimeout: () => {} } });
  const acct = dbl.addAccount({ usd, abstraction });
  const ag = dbl.addAgent(acct.address, agent);
  const verify = (over = {}) => verifyAgent({ accountAddress: acct.address, agentKeyBytes: ag.keyBytes, info: tn.info, mainnetInfo: mainnet, now, ...over });
  return { clock, now, sleep, dbl, hl, mainnet, tn, acct, ag, verify };
}

describe('§6.7 step 1: formats (no network, not counted against the connect limit)', () => {
  it('bad addresses', () => {
    for (const a of ['', '0x123', '1234567890123456789012345678901234567890', `0x${'g'.repeat(40)}`, null, 42]) {
      assert.deepEqual(checkAddress(a), { ok: false, status: 400, code: 'bad_address', counts: false });
    }
    assert.deepEqual(checkAddress(` ${checksum('0x14791697260e4c9a71f18484c9f997b308e59325')} `), { ok: true, address: '0x14791697260e4c9a71f18484c9f997b308e59325' });
  });

  it('agent keys: 64 hex with a valid scalar; seed phrases refused; nothing echoed', () => {
    const k = randomKey();
    for (const s of [k, `0x${k}`, `  ${k.toUpperCase()}\n`]) {
      const p = parseAgentKey(s);
      assert.equal(p.ok, true);
      assert.equal(Buffer.from(p.bytes).toString('hex'), k);
    }
    for (const s of ['', 'xyz', k.slice(1), `${k}00`, '0'.repeat(64), 'f'.repeat(64), `0x${k}z`, 'z'.repeat(64)]) {
      const p = parseAgentKey(s);
      assert.deepEqual(p, { ok: false, status: 400, code: 'bad_key_format', counts: false }, s);
    }
    const seeds = [
      'abandon ability able about above absent absorb abstract absurd abuse access accident',
      'Abandon, Ability; Able - About above ABSENT absorb abstract absurd abuse access accident acid acoustic',
      '1. abandon 2. ability 3. able 4. about 5. above 6. absent 7. absorb 8. abstract 9. absurd 10. abuse 11. access 12. accident',
      'abandon\nability\nable\nabout\nabove\nabsent\nabsorb\nabstract\nabsurd\nabuse\naccess\naccident\nacid\nacoustic\nacquire\nacross\nact\naction\nactor\nactress\nactual\nadapt\nadd\naddict',
    ];
    for (const s of seeds) {
      const p = parseAgentKey(s);
      assert.deepEqual(p, { ok: false, status: 422, code: 'seed_phrase', counts: false });
      assert.ok(!JSON.stringify(p).includes('abandon'));
    }
    assert.equal(parseAgentKey('abandon ability able').code, 'bad_key_format', 'fewer than 12 words');
  });

  it('verifyAgent refuses bad formats before any request', async () => {
    const r = rig();
    assert.equal((await r.verify({ accountAddress: '0xnope' })).code, 'bad_address');
    assert.equal((await r.verify({ agentKeyBytes: new Uint8Array(32) })).code, 'bad_key_format');
    assert.equal(r.dbl.requests.length, 0);
    assert.equal(r.hl.roleCalls, 0);
  });
});

describe('§6.7 steps 2–3: master key, testnet role', () => {
  it('the account’s own key → 422 master_key (no network)', async () => {
    const r = rig();
    const res = await r.verify({ agentKeyBytes: keyBytes(r.acct.key) });
    assert.equal(res.code, 'master_key');
    assert.equal(res.status, 422);
    assert.equal(r.dbl.requests.length, 0);
  });

  it('a key whose testnet role is `user` → master_key', async () => {
    const r = rig();
    const other = r.dbl.addAccount();
    const res = await r.verify({ agentKeyBytes: keyBytes(other.key) });
    assert.equal(res.code, 'master_key');
    assert.equal(r.hl.roleCalls, 0, 'never reaches the mainnet check');
  });

  it('a random well-formed key → not_agent, and it never spends mainnet weight', async () => {
    const r = rig();
    const res = await r.verify({ agentKeyBytes: keyBytes(randomKey()) });
    assert.equal(res.code, 'not_agent');
    assert.equal(r.hl.roleCalls, 0);
    assert.equal(r.mainnet.weight60s(), 0);
  });

  it('another account’s agent → agent_mismatch naming the (truncated) owner', async () => {
    const r = rig();
    const b = r.dbl.addAccount();
    const bAgent = r.dbl.addAgent(b.address);
    const res = await r.verify({ agentKeyBytes: bAgent.keyBytes });
    assert.equal(res.code, 'agent_mismatch');
    assert.equal(res.vars.belongs_to, truncAddr(b.address));
  });

  it('a mixed-case (or upper-case) data.user still matches', async () => {
    const r = rig();
    const ok = await r.verify();
    assert.equal(ok.ok, true, JSON.stringify(ok));
    r.dbl.setRole(r.ag.address, { role: 'agent', data: { user: `0x${r.acct.address.slice(2).toUpperCase()}` } });
    assert.equal((await r.verify()).ok, true);
  });
});

describe('§6.7 step 4: the mainnet guard fails closed', () => {
  for (const role of ['user', 'agent', 'vault', 'subAccount', 'somethingNew']) {
    it(`mainnet role ${role} → 422 mainnet_key (sub_reason mainnet_${role}); nothing returned to store`, async () => {
      const r = rig();
      r.hl.setRole(r.ag.address, role, role === 'agent' ? { user: '0x5555555555555555555555555555555555555555' } : undefined);
      const res = await r.verify();
      assert.equal(res.ok, false);
      assert.equal(res.status, 422);
      assert.equal(res.code, 'mainnet_key');
      assert.equal(res.sub_reason, `mainnet_${role}`);
      assert.equal(res.audit, 'mainnet_key_detected');
      assert.equal(res.counts, true);
      assert.ok(!('abstraction' in res) && !('account_value' in res));
      assert.equal(r.dbl.requestsOf('info', 'extraAgents').length, 0, 'stops at the guard');
    });
  }

  for (const fault of ['fail', 'http500', 'bad']) {
    it(`mainnet ${fault} → 503 mainnet_check_unavailable after one retry`, async () => {
      const r = rig();
      r.hl.roleFault = fault;
      const res = await r.verify();
      assert.deepEqual([res.status, res.code, res.counts], [503, 'mainnet_check_unavailable', true]);
      assert.equal(r.hl.roleCalls, 2, 'one retry');
    });
  }

  it('mainnet timeout → unavailable within the deadline', async () => {
    const r = rig();
    r.hl.roleFault = 'timeout';
    const started = Date.now();
    const res = await mainnetRecheck(r.ag.address, r.mainnet, { timeoutMs: 300, now: Date.now });
    assert.equal(res, 'unavailable');
    assert.ok(Date.now() - started < 2_000);
  });

  it('a failure then an answer: the retry succeeds', async () => {
    let calls = 0;
    const flaky = { async userRole() {
      calls++;
      if (calls === 1) throw new Error('reset');
      return { role: 'missing' };
    } };
    assert.equal(await mainnetRecheck('0x14791697260e4c9a71f18484c9f997b308e59325', flaky), 'missing');
    assert.equal(calls, 2);
    assert.equal(await mainnetRecheck('0x14791697260e4c9a71f18484c9f997b308e59325', null), 'unavailable');
  });

  it('HyperliquidClient.userRole: ≤ 2 per minute shared by connects and re-checks, connects first', async () => {
    const clock = { ms: T0 };
    const waits = [];
    const sleep = (ms) => new Promise((resolve) => waits.push({ at: clock.ms + ms, resolve }));
    const hl = makeHL(clock);
    const order = [];
    const spy = async (url, init) => {
      order.push(JSON.parse(init.body).user);
      return hl.fetch(url, init);
    };
    const client = new HyperliquidClient({ fetch: spy, now: () => clock.ms, sleep });
    const addr = (n) => `0x${String(n).repeat(40)}`;
    const jobs = [1, 2, 3, 4].map((n) => client.userRole(addr(n), { kind: 'recheck', timeoutMs: 600_000 }));
    jobs.push(client.userRole(addr(9), { kind: 'connect', timeoutMs: 600_000 }));
    const tick = async (ms) => {
      clock.ms += ms;
      for (const w of waits.splice(0)) w.resolve();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    };
    await tick(0);
    assert.deepEqual(order, [addr(1), addr(2)]);
    assert.equal(USER_ROLE_PER_MIN, 2);
    await tick(30_000);
    assert.equal(order.length, 2);
    await tick(31_000);
    assert.deepEqual(order.slice(2), [addr(9), addr(3)], 'the connect jumps the re-check queue');
    await tick(61_000);
    await Promise.all(jobs);
    assert.deepEqual(order.slice(4), [addr(4)]);
    assert.equal(client.roleSnapshot().requests, 5);
  });

  it('HyperliquidClient.userRole gives up (skipped) when no slot opens before its deadline', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const client = new HyperliquidClient({ fetch: hl.fetch, now: () => clock.ms, sleep: async (ms) => {
      clock.ms += ms;
    } });
    await client.userRole(`0x${'1'.repeat(40)}`);
    await client.userRole(`0x${'2'.repeat(40)}`);
    await assert.rejects(client.userRole(`0x${'3'.repeat(40)}`, { timeoutMs: 5_000 }), (err) => err.skipped === true);
  });
});

describe('§6.7 steps 5–7: expiry, abstraction, balances', () => {
  it('a fully valid named agent: the result shape', async () => {
    const r = rig();
    const res = await r.verify();
    assert.equal(res.ok, true);
    assert.equal(res.account_address, r.acct.address);
    assert.equal(res.agent_address, r.ag.address);
    assert.equal(res.agent_name, 'bean-garden');
    assert.equal(res.valid_until_ms, T0 + 90 * DAY);
    assert.equal(res.abstraction, 'default');
    assert.equal(res.account_value, 1000);
    assert.equal(res.account_value_est, false);
    assert.deepEqual(res.warnings, []);
    assert.equal(res.mainnet_checked_ms, T0);
    assert.equal(addressOf(r.ag.keyBytes), res.agent_address);
    assert.ok(!JSON.stringify(res).includes(r.ag.key), 'no key material in the result');
  });

  it('expired (< 1 h) → 422 agent_expired; expiring (< 7 d) → warning; unnamed → warning', async () => {
    const exp = rig({ agent: { validUntil: T0 + 30 * 60_000 } });
    assert.equal((await exp.verify()).code, 'agent_expired');
    const soon = rig({ agent: { validUntil: T0 + 3 * DAY } });
    const s = await soon.verify();
    assert.equal(s.ok, true);
    assert.deepEqual(s.warnings, [{ code: 'agent_expiring_soon', valid_until_ms: T0 + 3 * DAY }]);
    const un = rig({ agent: { unnamed: true } });
    const u = await un.verify();
    assert.equal(u.ok, true);
    assert.equal(u.valid_until_ms, null);
    assert.equal(u.agent_name, null);
    assert.deepEqual(u.warnings, [{ code: 'unnamed_agent' }]);
  });

  for (const abstraction of ['portfolioMargin', 'dexAbstraction']) {
    it(`${abstraction} → 422 abstraction_unsupported`, async () => {
      const r = rig({ abstraction });
      const res = await r.verify();
      assert.equal(res.code, 'abstraction_unsupported');
      assert.equal(r.dbl.requestsOf('info', 'clearinghouseState').length, 0);
    });
  }

  it('standard accounts (default/disabled) read clearinghouseState; unified reads spot balances (≈)', async () => {
    for (const abstraction of ['default', 'disabled']) {
      const r = rig({ abstraction });
      const res = await r.verify();
      assert.equal(res.ok, true);
      assert.equal(res.abstraction, abstraction);
      assert.equal(r.dbl.requestsOf('info', 'spotClearinghouseState').length, 0);
    }
    const u = rig({ abstraction: 'unifiedAccount', usd: 800 });
    const res = await u.verify();
    assert.equal(res.ok, true);
    assert.equal(res.abstraction, 'unifiedAccount');
    assert.equal(res.account_value_est, true);
    assert.equal(res.balance, 800);
    assert.equal(res.free, 800);
    assert.equal(res.account_value, 800);
    assert.equal(u.dbl.requestsOf('info', 'spotClearinghouseState').length, 1);
  });

  it('zero value → 422 no_testnet_funds; a low value → no_funds warning; our-coin positions → warning', async () => {
    assert.equal((await rig({ usd: 0 }).verify()).code, 'no_testnet_funds');
    const low = await rig({ usd: 10 }).verify();
    assert.equal(low.ok, true);
    assert.deepEqual(low.warnings, [{ code: 'no_funds', account_value: 10 }]);
    const r = rig();
    r.dbl.externalTrade(r.acct.address, 'ETH', 0.02);
    r.dbl.externalTrade(r.acct.address, 'APT', 5, { px: 4 }); // not one of our coins
    const res = await r.verify();
    assert.equal(res.ok, true);
    assert.deepEqual(res.warnings, [{ code: 'existing_positions', coins: ['ETH'] }]);
    assert.equal(res.positions.length, 2);
  });

  it('a testnet outage → 503 testnet_down (not counted)', async () => {
    const r = rig();
    r.dbl.fault({ kind: 'network', path: 'info', type: 'userRole', times: 1 });
    const res = await r.verify();
    assert.deepEqual([res.status, res.code, res.counts], [503, 'testnet_down', false]);
  });

  it('weight: ≈ 102 testnet (+2 unified) and 60 mainnet', async () => {
    const r = rig();
    await r.verify();
    assert.equal(r.tn.scheduler.weight60s(), INFO_WEIGHT.userRole + INFO_WEIGHT.extraAgents + INFO_WEIGHT.userAbstraction + INFO_WEIGHT.clearinghouseState);
    assert.equal(r.mainnet.weight60s(), 60);
    const u = rig({ abstraction: 'unifiedAccount' });
    await u.verify();
    assert.equal(u.tn.scheduler.weight60s(), 104);
  });

  it('the bound verifier limits connects to 2 starts per minute (busy, not counted, when it cannot start)', async () => {
    const r = rig();
    const a = r.tn.verify;
    const p = (q) => a.verifyAgent({ accountAddress: r.acct.address, agentKeyBytes: r.ag.keyBytes, ...q });
    assert.equal((await p()).ok, true);
    assert.equal((await p()).ok, true);
    // the third start would wait ~60 s, longer than the 30 s queue: 503 busy, not counted, nothing sent
    const before = r.dbl.requests.length;
    assert.deepEqual(await p(), { ok: false, status: 503, code: 'busy', counts: false });
    assert.equal(r.dbl.requests.length, before);
    r.clock.ms += 60_001;
    assert.equal((await p()).ok, true, 'a slot opens once the minute has passed');
    const fmt = await a.verifyAgent({ accountAddress: 'bad', agentKeyBytes: r.ag.keyBytes });
    assert.equal(fmt.code, 'bad_address', 'format errors never wait for a slot');
  });
});

describe('§6.7 step 8 decision: planUpsert', () => {
  const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const G1 = '0x1111111111111111111111111111111111111111';
  const G2 = '0x2222222222222222222222222222222222222222';
  const row = (user_id, account_address, agent_address, status) => ({ user_id, account_address, agent_address, status });

  it('new, replace (same garden, same account), already_connected, agent_in_use, account_in_use, take-over', () => {
    assert.deepEqual(planUpsert({ uid: 1, account: A, agent: G1, rows: [] }), { kind: 'new', takeover: [] });
    assert.deepEqual(planUpsert({ uid: 1, account: A, agent: G2, rows: [row(1, A, G1, 'verified')] }), { kind: 'replace', takeover: [] });
    assert.deepEqual(planUpsert({ uid: 1, account: checksum(A), agent: G2, rows: [row(1, A, G1, 'verified')] }).kind, 'replace', 'case-insensitive');
    assert.deepEqual(planUpsert({ uid: 1, account: B, agent: G2, rows: [row(1, A, G1, 'verified')] }), { kind: 'conflict', status: 409, code: 'already_connected' });
    assert.deepEqual(planUpsert({ uid: 1, account: A, agent: G1, rows: [row(2, B, G1, 'verified')] }), { kind: 'conflict', status: 409, code: 'agent_in_use' });
    assert.deepEqual(planUpsert({ uid: 1, account: A, agent: G1, rows: [row(2, A, G2, 'pending')] }), { kind: 'conflict', status: 409, code: 'account_in_use' });
    assert.deepEqual(planUpsert({ uid: 1, account: A, agent: G1, rows: [row(2, A, G2, 'revoked'), row(3, A, G2, 'error')] }), { kind: 'new', takeover: [2, 3] });
    assert.deepEqual(planUpsert({ uid: 1, account: A, agent: G1, rows: [row(1, B, G2, 'revoked')] }), { kind: 'new', takeover: [] }, 'own revoked row is overwritten');
  });
});

describe('the periodic mainnet re-check', () => {
  it('checks only due credentials (never checked, or > 24 h); a hit runs the WP3 effects; unavailable changes nothing', async () => {
    const clock = { ms: T0 };
    const roles = new Map();
    const mainnetInfo = { calls: 0, async userRole(addr) {
      this.calls++;
      const r = roles.get(addr);
      if (r === 'fail') throw new Error('down');
      return { role: r ?? 'missing' };
    } };
    const cred = (uid, n, checked) => ({ uid, agent_address: `0x${String(n).repeat(40)}`, mainnet_checked_ms: checked, status: 'verified', bots: ['bot-0001'] });
    const creds = [cred(1, 1, null), cred(2, 2, T0 - 25 * HOUR), cred(3, 3, T0 - 2 * HOUR), cred(4, 4, T0 - 30 * HOUR)];
    roles.set(creds[1].agent_address, 'vault');
    roles.set(creds[3].agent_address, 'fail');
    const effects = [];
    const rc = new MainnetRechecker({
      mainnetInfo,
      now: () => clock.ms,
      listDue: () => creds.filter((c) => c.status === 'verified'),
      onResult: async ({ uid, result, hit }) => {
        const c = creds.find((x) => x.uid === uid);
        if (result === 'missing') c.mainnet_checked_ms = clock.ms;
        if (hit) {
          // The WP3 contract (§6.7): flatten at P0 (≤ 60 s) → wipe → pause (mainnet_key) → emit → audit.
          effects.push(['flatten', uid, c.bots]);
          effects.push(['wipe', uid]);
          c.status = 'revoked';
          effects.push(['pause', uid, 'mainnet_key']);
          effects.push(['emit', uid, { kind: 'credential_status', status: 'revoked', reason: 'mainnet_key' }]);
          effects.push(['audit', uid, 'mainnet_key_detected']);
        }
      },
    });
    assert.deepEqual(rc.due(creds).map((c) => c.uid), [1, 4, 2], 'oldest first; the 2-hour-old one is not due');
    assert.equal(await rc.tick(), 3);
    assert.equal(mainnetInfo.calls, 1 + 1 + 2, 'the failing one retried once');
    assert.equal(creds[0].mainnet_checked_ms, T0);
    assert.equal(creds[3].mainnet_checked_ms, T0 - 30 * HOUR, 'unavailable: unchanged, retried next pass');
    assert.equal(creds[3].status, 'verified');
    assert.equal(creds[1].status, 'revoked');
    assert.deepEqual(effects.map((e) => e[0]), ['flatten', 'wipe', 'pause', 'emit', 'audit']);
    assert.deepEqual(rc.counts, { checked: 3, hits: 1, unavailable: 1 });
    clock.ms += 25 * HOUR;
    roles.delete(creds[3].agent_address);
    assert.deepEqual(rc.due(creds.filter((c) => c.status === 'verified')).map((c) => c.uid), [4, 3, 1]);
  });

  it('start()/stop() run a boot pass and then poll', async () => {
    let passes = 0;
    const timers = { pending: null, setTimeout(fn) {
      this.pending = fn;
      return 1;
    }, clearTimeout() {
      this.pending = null;
    } };
    const rc = new MainnetRechecker({ mainnetInfo: { userRole: async () => ({ role: 'missing' }) }, listDue: () => {
      passes++;
      return [];
    }, onResult: () => {}, timers });
    rc.start();
    await new Promise((r) => setImmediate(r));
    assert.equal(passes, 1);
    assert.ok(timers.pending);
    rc.stop();
    assert.equal(timers.pending, null);
  });
});

describe('the testnet double’s mainnet answers (for --testnet-double)', () => {
  it('dbl.mainnetInfo answers userRole without any network', async () => {
    const dbl = makeTestnetDouble();
    dbl.mainnet.roles.set('0x1111111111111111111111111111111111111111', { role: 'user' });
    assert.equal(await mainnetRecheck('0x1111111111111111111111111111111111111111', dbl.mainnetInfo), 'user');
    assert.equal(await mainnetRecheck('0x2222222222222222222222222222222222222222', dbl.mainnetInfo), 'missing');
    dbl.mainnet.fault = 'timeout';
    assert.equal(await mainnetRecheck('0x2222222222222222222222222222222222222222', dbl.mainnetInfo, { timeoutMs: 100 }), 'unavailable');
  });
});

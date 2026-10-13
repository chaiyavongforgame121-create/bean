// test/hl-exchange.test.js — scheduler, exchange idempotency (§6.6), error taxonomy (§6.9), info pagination and the
// testnet market cache (§6.8), all against the offline testnet double (test/fixtures/hl-testnet-double.js).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encode } from '@msgpack/msgpack';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

import { APPROVE_AGENT_FIELDS, APPROVE_AGENT_PRIMARY_TYPE, INFO_WEIGHT, PRIORITY } from '../server/hl/constants.js';
import { EXCHANGE_CODES, NOTE_CODES, RETRY, classify, classifyText, nextStep } from '../server/hl/errors.js';
import { ExchangeRefusal, mapOrderStatus, parseStatus } from '../server/hl/exchange.js';
import { iocPx, fmtSzWire } from '../server/hl/format.js';
import { createTestnet } from '../server/hl/index.js';
import { parseTestnetMeta } from '../server/hl/market.js';
import { HlScheduler, LaneAbortError, isLaneAbort } from '../server/hl/scheduler.js';
import { agentDigest, makeSigner, userSignedDigest } from '../server/hl/signing.js';
import { TestnetError } from '../server/hl/transport.js';
import { cancelByCloidAction, newCloid, orderAction, orderWire, updateLeverageAction } from '../server/hl/wire.js';
import { DEV_FAULTS, HL_TEXT, TESTNET_META, checksum, makeTestnetDouble, randomKey } from './fixtures/hl-testnet-double.js';

const T0 = 1_791_700_000_000;
const flush = () => new Promise((r) => setImmediate(r));

/** A manual clock: sleeps resolve only when advance() passes their time. */
function manualTime(start = T0) {
  const clock = { ms: start };
  const waits = [];
  const now = () => clock.ms;
  const sleep = (ms) => new Promise((resolve) => waits.push({ at: clock.ms + Math.max(0, ms), resolve }));
  async function advance(ms) {
    const target = clock.ms + ms;
    await flush();
    for (;;) {
      waits.sort((a, b) => a.at - b.at);
      if (!waits.length || waits[0].at > target) break;
      const w = waits.shift();
      clock.ms = Math.max(clock.ms, w.at);
      w.resolve();
      await flush();
      await flush();
    }
    clock.ms = target;
    await flush();
  }
  return { clock, now, sleep, advance };
}

/** The standard rig: an auto-advancing clock (sleep moves time forward), the double, one funded account + agent. */
function rig({ usd = 1000, budget, abstraction = 'default' } = {}) {
  const clock = { ms: T0 };
  const now = () => clock.ms;
  const sleep = async (ms) => {
    clock.ms += ms;
  };
  const dbl = makeTestnetDouble({ now });
  const logs = [];
  const tn = createTestnet({ fetch: dbl.fetch, now, sleep, log: (l) => logs.push(l), budget, mainnetClient: dbl.mainnetInfo, timers: { setTimeout: () => null, clearTimeout: () => {} } });
  const acct = dbl.addAccount({ usd, abstraction });
  const ag = dbl.addAgent(acct.address);
  const signer = makeSigner(ag.keyBytes);
  let last = 0;
  const nonces = [];
  const reserveNonce = () => {
    last = Math.max(now(), last + 1);
    nonces.push(last);
    return last;
  };
  return { clock, now, sleep, dbl, tn, acct, ag, signer, reserveNonce, nonces, logs };
}

const ETH = { index: 4, d: 4 };
function ethOrder(r, { isBuy = true, sz = 0.02, reduceOnly = false, slip = 0.01, cloid = newCloid(), px } = {}) {
  const mid = r.dbl.mids.get('ETH');
  return orderAction([orderWire({
    asset: ETH.index, isBuy, px: px ?? iocPx(mid, isBuy, slip, ETH.d), sz: fmtSzWire(sz, ETH.d), reduceOnly, cloid,
  })]);
}
const submit = (r, action, extra = {}) => r.tn.exchange.submit({ action, signer: r.signer, accountAddress: r.acct.address, reserveNonce: r.reserveNonce, ...extra });

// ---------------------------------------------------------------------------------------------------------------------

describe('HlScheduler: weights, priorities, lanes', () => {
  it('charges weight at start and keeps the rolling 60 s under the budget', async () => {
    const t = manualTime();
    const s = new HlScheduler({ budget: 10, burst: 12, now: t.now, sleep: t.sleep });
    const starts = [];
    const jobs = Array.from({ length: 6 }, (_, i) => s.run(PRIORITY.RECONCILE, 2, async () => {
      starts.push([i, t.now()]);
    }));
    await t.advance(0);
    assert.equal(starts.length, 5, '5 × 2 = 10 fits; the 6th waits');
    assert.equal(s.weight60s(), 10);
    await t.advance(59_000);
    assert.equal(starts.length, 5);
    await t.advance(1_100);
    await Promise.all(jobs);
    assert.equal(starts.length, 6);
    assert.ok(starts[5][1] >= T0 + 60_000, 'the 6th started once the window rolled');
  });

  it('serves the highest priority first; P0 flattens may use the burst ceiling', async () => {
    const t = manualTime();
    const s = new HlScheduler({ budget: 4, burst: 6, now: t.now, sleep: t.sleep });
    const order = [];
    const job = (p, w) => s.run(p, w, async () => order.push(p));
    const all = [job(PRIORITY.BACKGROUND, 4)];
    await t.advance(0);
    all.push(job(PRIORITY.FILLS, 1), job(PRIORITY.VERIFY, 1), job(PRIORITY.MIRROR, 1), job(PRIORITY.FLATTEN, 1));
    await t.advance(0);
    assert.deepEqual(order, [PRIORITY.BACKGROUND, PRIORITY.FLATTEN], 'only the flatten fits (burst 6)');
    await t.advance(61_000);
    await Promise.all(all);
    assert.deepEqual(order, [PRIORITY.BACKGROUND, PRIORITY.FLATTEN, PRIORITY.MIRROR, PRIORITY.FILLS, PRIORITY.VERIFY]);
  });

  it('round-robins across players within one priority', async () => {
    const s = new HlScheduler({ budget: 1000, maxInFlight: 1 });
    const seen = [];
    const job = (key, name) => s.run(PRIORITY.RECONCILE, 1, async () => {
      seen.push(name);
    }, { key });
    await Promise.all([job('A', 'a1'), job('A', 'a2'), job('A', 'a3'), job('B', 'b1'), job('B', 'b2')]);
    assert.deepEqual(seen, ['a1', 'a2', 'b1', 'a3', 'b2']);
  });

  it('HTTP 429: 15 s host back-off, the job stays queued (front) and nothing else starts meanwhile', async () => {
    const t = manualTime();
    const logs = [];
    const s = new HlScheduler({ budget: 800, now: t.now, sleep: t.sleep, log: (l) => logs.push(l) });
    const tries = [];
    const x = s.run(PRIORITY.MIRROR, 1, async () => {
      tries.push(['x', t.now()]);
      if (tries.length === 1) throw new TestnetError('HTTP 429', { code: 'ip_rate_limited', requeue: true });
      return 'ok';
    });
    await t.advance(0);
    const y = s.run(PRIORITY.BACKGROUND, 2, async () => tries.push(['y', t.now()]));
    await t.advance(14_000);
    assert.equal(tries.length, 1, 'nothing runs inside the back-off');
    assert.ok(s.inBackoff());
    await t.advance(1_500);
    assert.equal(await x, 'ok');
    await y;
    assert.deepEqual(tries.map((e) => e[0]), ['x', 'x', 'y']);
    assert.ok(tries[1][1] >= T0 + 15_000);
    assert.ok(logs.some((l) => /back-off 15 s/.test(l)));
    assert.equal(s.stats().requeued, 1);
  });

  it('skips a request that cannot start within maxWaitMs', async () => {
    const t = manualTime();
    const s = new HlScheduler({ budget: 2, now: t.now, sleep: t.sleep });
    await s.run(PRIORITY.MIDS, 2, async () => {});
    const p = s.run(PRIORITY.MIDS, 2, async () => {}, { maxWaitMs: 4_000 });
    await assert.rejects(p, (err) => err.skipped === true && err.code === 'skipped');
  });

  it('lanes run one job at a time, highest priority first, FIFO within a priority', async () => {
    const s = new HlScheduler({ budget: 800 });
    const lane = s.lane(7, 'epoch-a');
    let running = 0;
    let maxRunning = 0;
    const order = [];
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const job = (p, name, wait) => lane.run(p, async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      order.push(name);
      if (wait) await wait;
      await flush();
      running--;
    });
    const all = [job(PRIORITY.FILLS, 'sweep', gate), job(PRIORITY.MIRROR, 'mirror1'), job(PRIORITY.FILLS, 'sweep2'), job(PRIORITY.FLATTEN, 'flatten'), job(PRIORITY.MIRROR, 'mirror2')];
    await flush();
    release();
    await Promise.all(all);
    assert.equal(maxRunning, 1, 'serial');
    assert.deepEqual(order, ['sweep', 'flatten', 'mirror1', 'mirror2', 'sweep2']);
    assert.equal(s.lane(7, 'epoch-a'), lane, 'one canonical lane per uid');
  });

  it('cancelLane: queued jobs, queued requests and retry timers abort; the running job sees alive() === false', async () => {
    const t = manualTime();
    const s = new HlScheduler({ budget: 2, now: t.now, sleep: t.sleep });
    await s.run(PRIORITY.BACKGROUND, 2, async () => {}); // exhaust the budget so lane requests queue
    const lane = s.lane(9, 'e9');
    let ctxSeen;
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const running = lane.run(PRIORITY.MIRROR, async (ctx) => {
      ctxSeen = ctx;
      const req = ctx.request(PRIORITY.MIRROR, 1, async () => 'sent');
      await gate;
      return req;
    });
    const queued = lane.run(PRIORITY.MIRROR, async () => 'never');
    let timerRan = false;
    lane.later(15_000, PRIORITY.FLATTEN, async () => {
      timerRan = true;
    });
    await t.advance(0);
    assert.ok(ctxSeen.alive());
    const n = s.cancelLane(9);
    assert.ok(n >= 3, `cancelled ${n}`);
    assert.equal(ctxSeen.alive(), false);
    release();
    await assert.rejects(running, isLaneAbort, 'its queued request aborted');
    await assert.rejects(queued, isLaneAbort);
    await t.advance(20_000);
    assert.equal(timerRan, false, 'the retry timer never fires');
    await assert.rejects(lane.run(PRIORITY.MIRROR, async () => 1), isLaneAbort, 'a stale handle stays dead');
    const fresh = s.lane(9, 'e9');
    assert.notEqual(fresh, lane);
    assert.equal(await fresh.run(PRIORITY.MIRROR, async () => 42), 42);
  });

  it('epoch abort: a job whose garden epoch changed never runs', async () => {
    const epochs = new Map([[3, 'old']]);
    const s = new HlScheduler({ budget: 800, epochOf: (uid) => epochs.get(uid) });
    const lane = s.lane(3, 'old');
    assert.equal(await lane.run(PRIORITY.MIRROR, async () => 'ran'), 'ran');
    epochs.set(3, 'new');
    let ran = false;
    await assert.rejects(lane.run(PRIORITY.MIRROR, async () => {
      ran = true;
    }), LaneAbortError);
    assert.equal(ran, false);
    const stale = s.lane(3, 'old');
    await assert.rejects(stale.run(PRIORITY.MIRROR, async () => 1), isLaneAbort, 'a stale caller gets a dead handle');
    assert.equal(await s.lane(3, 'new').run(PRIORITY.MIRROR, async () => 'new garden'), 'new garden');
  });

  it('drain: queued work is dropped, in-flight requests finish', async () => {
    const t = manualTime();
    const s = new HlScheduler({ budget: 2, now: t.now, sleep: t.sleep });
    let release;
    const inflight = s.run(PRIORITY.MIRROR, 2, () => new Promise((r) => {
      release = r;
    }));
    const queued = s.run(PRIORITY.MIRROR, 2, async () => 'never');
    await t.advance(0);
    const drained = s.drain(5_000);
    await assert.rejects(queued, (err) => err.code === 'draining');
    release('done');
    assert.equal(await inflight, 'done');
    assert.deepEqual(await drained, { drained: true, inflight: 0 });
    await assert.rejects(s.run(PRIORITY.MIRROR, 1, async () => 1), (err) => err.code === 'draining');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('exchange: the §6.6 idempotency rules against the double', () => {
  it('a plain IOC: leverage first (isolated), then a filled order with a provisional result', async () => {
    const r = rig();
    const lev = await submit(r, updateLeverageAction(ETH.index, 5));
    assert.equal(lev.outcome, 'done');
    const res = await submit(r, ethOrder(r));
    assert.equal(res.outcome, 'filled');
    assert.equal(res.filled_sz, 0.02);
    assert.ok(res.avg_px > 0);
    assert.equal(res.transmissions, 1);
    const pos = r.dbl.position(r.acct.address, 'ETH');
    assert.equal(pos.szi, 0.02);
    assert.deepEqual(pos.leverage, { type: 'isolated', value: 5 });
  });

  it('new positions default to CROSS unless updateLeverage was sent', async () => {
    const r = rig();
    await submit(r, ethOrder(r));
    assert.equal(r.dbl.position(r.acct.address, 'ETH').leverage.type, 'cross');
  });

  it('a timeout resends the IDENTICAL bytes (same nonce, same cloid)', async () => {
    const r = rig();
    r.dbl.fault({ kind: 'timeout', path: 'exchange', type: 'order', times: 1 });
    const res = await submit(r, ethOrder(r));
    assert.equal(res.outcome, 'filled');
    assert.equal(res.transmissions, 2);
    assert.equal(res.resends, 1);
    assert.equal(res.transport_failed, true);
    assert.equal(r.nonces.length, 1, 'no new nonce reserved');
    const sent = r.dbl.requestsOf('exchange', 'order');
    assert.equal(sent.length, 2);
    assert.equal(sent[0].body, sent[1].body, 'byte-identical resend');
  });

  it('the double executes, then times out; the resend meets a nonce error; exactly one order exists (no re-sign)', async () => {
    const r = rig();
    r.dbl.fault({ kind: 'execute_then_timeout', path: 'exchange', type: 'order', times: 1 });
    const action = ethOrder(r);
    const res = await submit(r, action);
    const sent = r.dbl.requestsOf('exchange', 'order');
    assert.equal(sent.length, 2);
    assert.equal(sent[0].body, sent[1].body, 'never re-signed');
    assert.equal(r.nonces.length, 1);
    assert.equal(res.resigned, false);
    assert.equal(res.outcome, 'filled', 'resolved by orderStatus(cloid)');
    assert.equal(res.code, 'nonce');
    assert.equal(res.filled_sz, 0.02, 'filled size from orderStatus');
    assert.equal(res.avg_px, null, 'price comes only from the fills sweep');
    assert.equal(res.resolution.exchange_status, 'filled');
    assert.equal(r.dbl.ordersFor(r.acct.address).length, 1, 'exactly one order');
    assert.equal(r.dbl.position(r.acct.address, 'ETH').szi, 0.02, 'not doubled');
    assert.equal(r.dbl.requestsOf('info', 'orderStatus').length, 1);
  });

  it('a first-transmission nonce error gets exactly ONE fresh-nonce attempt with the same cloid', async () => {
    const r = rig();
    r.dbl.fault({ kind: 'error', code: 'nonce', path: 'exchange', type: 'order', times: 1 });
    const action = ethOrder(r);
    const res = await submit(r, action);
    assert.equal(res.outcome, 'filled');
    assert.equal(res.resigned, true);
    const sent = r.dbl.requestsOf('exchange', 'order');
    assert.equal(sent.length, 2);
    assert.notEqual(sent[0].nonce, sent[1].nonce);
    assert.deepEqual(sent[0].cloids, sent[1].cloids, 'same cloid');
    assert.equal(r.nonces.length, 2);

    const r2 = rig();
    r2.dbl.fault({ kind: 'error', code: 'nonce', path: 'exchange', type: 'order', times: 2 });
    const res2 = await submit(r2, ethOrder(r2));
    assert.equal(res2.outcome, 'rejected');
    assert.equal(res2.code, 'nonce');
    assert.equal(r2.dbl.requestsOf('exchange', 'order').length, 2, 'never a third attempt');
  });

  it('three transport failures: two resends within 10 s, then unknown → orderStatus (unknownOid stays unknown)', async () => {
    const r = rig();
    r.dbl.fault({ kind: 'timeout', path: 'exchange', type: 'order', times: 3 });
    const res = await submit(r, ethOrder(r));
    assert.equal(res.transmissions, 3);
    assert.equal(res.outcome, 'unknown');
    assert.equal(res.resolution.unknownOid, true);
    assert.equal(r.dbl.ordersFor(r.acct.address).length, 0);
    assert.ok(r.now() - T0 < 10_000, 'resends stay inside the 10 s window');
  });

  it('HTTP 5xx is transport (resent); HTTP 400 plain text is client_error (never resent, alert)', async () => {
    const r = rig();
    r.dbl.fault({ kind: 'http', status: 502, path: 'exchange', times: 1 });
    const ok = await submit(r, ethOrder(r));
    assert.equal(ok.outcome, 'filled');
    assert.equal(ok.transmissions, 2);

    const b = rig();
    b.dbl.fault({ kind: 'http', status: 400, text: 'Bad Request: invalid order shape', path: 'exchange', times: 1 });
    const bad = await submit(b, ethOrder(b));
    assert.equal(bad.outcome, 'rejected');
    assert.equal(bad.code, 'client_error');
    assert.equal(bad.result.http, 400);
    assert.match(bad.error, /invalid order shape/);
    assert.equal(b.dbl.requestsOf('exchange').length, 1, 'never resent');
    assert.ok(b.logs.some((l) => /ALERT.*client error/.test(l)));
  });

  it('a 307 redirect is refused (redirect:"error") and classified client_error; nothing is re-POSTed elsewhere', async () => {
    const r = rig();
    r.dbl.fault({ kind: 'redirect', path: 'exchange', times: 1 });
    const res = await submit(r, ethOrder(r));
    assert.equal(res.outcome, 'rejected');
    assert.equal(res.code, 'client_error');
    assert.equal(res.result.redirect, true);
    assert.deepEqual(r.dbl.violations, []);
    assert.ok(r.dbl.requests.every((q) => q.redirect === 'error'));
  });

  it('HTTP 429 on the exchange: re-queued after the host back-off, then sent', async () => {
    const r = rig();
    r.dbl.fault({ kind: 'http', status: 429, path: 'exchange', times: 1 });
    const res = await submit(r, ethOrder(r));
    assert.equal(res.outcome, 'filled');
    const sent = r.dbl.requestsOf('exchange', 'order');
    assert.equal(sent.length, 2);
    assert.ok(sent[1].t - sent[0].t >= 15_000, 'not retried inside the back-off');
    assert.equal(sent[0].body, sent[1].body);
  });

  it('string statuses: "waitingForFill" → waiting, an unexpected string → rejected_other, "success" → done', async () => {
    const r = rig();
    r.dbl.fault({ kind: 'status', value: 'waitingForFill', path: 'exchange', type: 'order', times: 1 });
    assert.equal((await submit(r, ethOrder(r))).outcome, 'waiting');
    r.dbl.fault({ kind: 'status', value: 'somethingNew', path: 'exchange', type: 'order', times: 1 });
    const odd = await submit(r, ethOrder(r));
    assert.equal(odd.outcome, 'rejected');
    assert.equal(odd.code, 'rejected_other');
    assert.equal(odd.error, 'somethingNew');
    // "success": cancel a (resting) order by cloid
    r.dbl.fault({ kind: 'resting', path: 'exchange', type: 'order', times: 1 });
    const cloid = newCloid();
    const rest = await submit(r, ethOrder(r, { cloid }));
    assert.equal(rest.outcome, 'resting');
    assert.ok(r.logs.some((l) => /anomaly/.test(l)));
    const cancel = await submit(r, cancelByCloidAction(ETH.index, cloid));
    assert.equal(cancel.outcome, 'done');
    assert.deepEqual(cancel.status, { kind: 'success' });
  });

  it('a partial IOC fill reports the filled part; orderStatus maps it to partial', async () => {
    const r = rig();
    r.dbl.fault({ kind: 'partial', fraction: 0.5, path: 'exchange', type: 'order', times: 1 });
    const cloid = newCloid();
    const res = await submit(r, ethOrder(r, { cloid, sz: 0.04 }));
    assert.equal(res.outcome, 'partial');
    assert.equal(res.filled_sz, 0.02);
    const m = mapOrderStatus(await r.tn.info.orderStatus(r.acct.address, cloid));
    assert.equal(m.status, 'partial');
    assert.equal(m.filled_sz, 0.02);
  });

  it('per-user lanes keep each signer’s nonces strictly increasing under concurrency', async () => {
    const r = rig();
    const users = [];
    for (let u = 0; u < 3; u++) {
      const acct = r.dbl.addAccount({ usd: 5_000 });
      const ag = r.dbl.addAgent(acct.address);
      let last = 0;
      users.push({ uid: u + 1, acct, signer: makeSigner(ag.keyBytes), reserve: () => (last = Math.max(r.now(), last + 1)) });
    }
    const jobs = [];
    for (let k = 0; k < 6; k++) {
      for (const u of users) {
        const lane = r.tn.scheduler.lane(u.uid, `epoch-${u.uid}`);
        jobs.push(lane.run(PRIORITY.MIRROR, (ctx) => r.tn.exchange.submit({
          action: ethOrder(r, { isBuy: k % 2 === 0 }), signer: u.signer, accountAddress: u.acct.address, reserveNonce: u.reserve, ctx,
        })));
      }
    }
    const results = await Promise.all(jobs);
    assert.ok(results.every((x) => x.outcome === 'filled'), JSON.stringify(results.map((x) => x.code)));
    for (const u of users) {
      const seq = r.dbl.executed.filter((e) => e.signer === u.signer.address).map((e) => e.nonce);
      assert.equal(seq.length, 6);
      for (let i = 1; i < seq.length; i++) assert.ok(seq[i] > seq[i - 1], 'strictly increasing in execution order');
    }
  });

  it('a lane cancelled before its submit runs sends nothing', async () => {
    const r = rig();
    const lane = r.tn.scheduler.lane(5, 'e5');
    let release;
    const gate = new Promise((x) => {
      release = x;
    });
    const first = lane.run(PRIORITY.MIRROR, () => gate);
    const second = lane.run(PRIORITY.MIRROR, (ctx) => submit(r, ethOrder(r), { ctx }));
    const secondDone = assert.rejects(second, isLaneAbort);
    await flush(); // the first job is running now
    r.tn.scheduler.cancelLane(5);
    release();
    await first;
    await secondDone;
    assert.equal(r.dbl.requestsOf('exchange').length, 0);
  });

  it('the allowlist refuses every other action type before signing or sending', async () => {
    const r = rig();
    for (const type of ['withdraw3', 'usdSend', 'spotSend', 'usdClassTransfer', 'sendAsset', 'vaultTransfer', 'subAccountTransfer', 'approveBuilderFee', 'scheduleCancel']) {
      await assert.rejects(r.tn.exchange.post({ type, amount: '1' }, r.signer, r.now()), ExchangeRefusal, type);
      await assert.rejects(submit(r, { type, amount: '1' }), ExchangeRefusal, type);
    }
    assert.throws(() => r.tn.exchange.prepare({ type: 'approveAgent' }, r.signer, 1), ExchangeRefusal, 'approveAgent only through the relay');
    assert.equal(r.dbl.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('exchange: address-bearing errors and the signing halt (§6.9)', () => {
  it('a foreign address in "does not exist" → signature_mismatch: signing halts for everyone, credentials untouched', async () => {
    const r = rig();
    const halts = [];
    r.tn.exchange.onSigningHalt((h) => halts.push(h));
    r.dbl.fault({ kind: 'signature_mismatch', path: 'exchange', type: 'order', times: 1 });
    const res = await submit(r, ethOrder(r));
    assert.equal(res.code, 'signature_mismatch');
    assert.equal(r.tn.exchange.signingHalted, true);
    assert.equal(halts.length, 1);
    assert.equal(r.tn.market.status().reason, 'signing');
    assert.ok(r.logs.some((l) => /ALERT testnet signing HALTED/.test(l)));
    const before = r.dbl.requests.length;
    const blocked = await submit(r, ethOrder(r));
    assert.equal(blocked.outcome, 'halted');
    assert.equal(r.dbl.requests.length, before, 'no further sends, flattens included');
    const blockedFlatten = await submit(r, ethOrder(r, { isBuy: false, reduceOnly: true }), { priority: PRIORITY.FLATTEN });
    assert.equal(blockedFlatten.outcome, 'halted');
    r.tn.exchange.setSigningHalt(false); // admin_testnet_signing {resume:true}
    assert.equal((await submit(r, ethOrder(r))).outcome, 'filled');
  });

  it('the double re-encodes independently: a key-order or trailing-zero payload bug recovers a foreign address', async () => {
    for (const mutate of [
      (w) => ({ a: w.a, b: w.b, s: w.s, p: w.p, r: w.r, t: w.t, c: w.c }), // s before p
      (w) => ({ ...w, p: `${w.p}0` }), // "2517.40"
    ]) {
      const r = rig();
      const wire = mutate(ethOrder(r).orders[0]);
      const action = { type: 'order', orders: [wire], grouping: 'na' };
      const nonce = r.reserveNonce();
      // Sign the BUGGY bytes exactly as a buggy signer would (test-local hashing; packAction would refuse them).
      const hash = keccak_256(Uint8Array.from(Buffer.concat([Buffer.from(encode(action)), Buffer.from(nonce.toString(16).padStart(16, '0'), 'hex'), Buffer.from([0])])));
      const sig = secp256k1.sign(agentDigest(hash), r.ag.keyBytes, { lowS: true });
      const signature = { r: `0x${sig.r.toString(16).padStart(64, '0')}`, s: `0x${sig.s.toString(16).padStart(64, '0')}`, v: 27 + sig.recovery };
      const prepared = Object.freeze({ type: 'order', action, nonce, agent: r.signer.address, weight: 1, body: JSON.stringify({ action, nonce, signature, vaultAddress: null, expiresAfter: null }) });
      const res = await r.tn.exchange.send(prepared, { accountAddress: r.acct.address });
      assert.equal(res.code, 'signature_mismatch', res.error);
      assert.match(res.error, /does not exist/);
      assert.equal(r.tn.exchange.signingHalted, true);
      assert.equal(r.dbl.ordersFor(r.acct.address).length, 0);
    }
  });

  it('our agent named in "does not exist" → agent_unknown (confirmed by userRole before revoking)', async () => {
    const r = rig();
    r.dbl.fault({ kind: 'error', code: 'agent_unknown', path: 'exchange', type: 'order', times: 1 });
    const res = await submit(r, ethOrder(r));
    assert.equal(res.code, 'agent_unknown');
    assert.equal(r.tn.exchange.signingHalted, false);
    assert.equal(await r.tn.verify.confirmAgentRole(r.signer.address, r.acct.address), 'agent', 'still the account’s agent: never revoke');
    r.dbl.revokeAgent(r.ag.address);
    const after = await submit(r, ethOrder(r));
    assert.equal(after.code, 'agent_unknown');
    assert.equal(await r.tn.verify.confirmAgentRole(r.signer.address, r.acct.address), 'revoked');
  });

  it('"Must deposit … User: <account>" → no_deposit; the halt is untouched (credential stays verified)', async () => {
    const r = rig();
    r.dbl.fault({ kind: 'must_deposit', path: 'exchange', type: 'order', times: 1 });
    const res = await submit(r, ethOrder(r));
    assert.equal(res.code, 'no_deposit');
    assert.equal(r.tn.exchange.signingHalted, false);
    const empty = rig({ usd: 0 });
    const res2 = await submit(empty, ethOrder(empty));
    assert.equal(res2.code, 'no_deposit', 'a real unfunded account');
    assert.match(res2.error, new RegExp(checksum(empty.acct.address).slice(2, 10)), 'the text names the (checksummed) account');
  });

  it('order-level rejections from the double’s real rules', async () => {
    const r = rig({ usd: 1000 });
    const minN = await submit(r, ethOrder(r, { sz: 0.001 }));
    assert.equal(minN.code, 'min_notional');
    const noMatch = await submit(r, ethOrder(r, { px: '2000' }));
    assert.equal(noMatch.code, 'ioc_no_match');
    const ro = await submit(r, ethOrder(r, { isBuy: false, reduceOnly: true }));
    assert.equal(ro.code, 'reduce_only');
    await submit(r, updateLeverageAction(ETH.index, 1));
    const margin = await submit(r, ethOrder(r, { sz: 0.5 }));
    assert.equal(margin.code, 'insufficient_margin');
    const lev = await submit(r, updateLeverageAction(ETH.index, 50));
    assert.equal(lev.code, 'leverage_rejected');
    for (const code of ['price_band', 'tick', 'oi_cap', 'rejected_other']) {
      r.dbl.fault({ kind: 'error', code, path: 'exchange', type: 'order', times: 1 });
      assert.equal((await submit(r, ethOrder(r))).code, code);
    }
    assert.equal(r.tn.exchange.signingHalted, false);
  });

  it('address_rate_limited: per-player back-off 10 s → 20 s, nothing sent meanwhile', async () => {
    const r = rig();
    r.dbl.accounts.get(r.acct.address).capOverride = 0;
    const first = await submit(r, ethOrder(r));
    assert.equal(first.code, 'address_rate_limited');
    const n = r.dbl.requests.length;
    const skipped = await submit(r, ethOrder(r));
    assert.equal(skipped.outcome, 'skipped');
    assert.ok(skipped.backoff_ms > 9_000 && skipped.backoff_ms <= 10_000);
    assert.equal(r.dbl.requests.length, n);
    r.clock.ms += 10_500;
    const again = await submit(r, ethOrder(r));
    assert.equal(again.code, 'address_rate_limited');
    const skipped2 = await submit(r, ethOrder(r));
    assert.ok(skipped2.backoff_ms > 19_000, 'the back-off doubled');
  });
});

describe('error taxonomy (§6.9)', () => {
  const agent = '0x1111111111111111111111111111111111111111';
  const account = '0x2222222222222222222222222222222222222222';
  const foreign = '0x3333333333333333333333333333333333333333';
  const ctx = { agentAddress: agent, accountAddress: account };

  it('classifies every double text to its code', () => {
    const cases = [
      [HL_TEXT.nonceDuplicate, 'nonce'],
      [HL_TEXT.nonceLow, 'nonce'],
      [HL_TEXT.nonceWindow, 'nonce'],
      [HL_TEXT.addressRateLimited, 'address_rate_limited'],
      [HL_TEXT.minNotional(4), 'min_notional'],
      [HL_TEXT.insufficientMargin(4), 'insufficient_margin'],
      [HL_TEXT.iocNoMatch(4), 'ioc_no_match'],
      [HL_TEXT.reduceOnly(4), 'reduce_only'],
      [HL_TEXT.priceBand(), 'price_band'],
      [HL_TEXT.tick(4), 'tick'],
      [HL_TEXT.oiCap(4), 'oi_cap'],
      [HL_TEXT.other, 'rejected_other'],
      [HL_TEXT.doesNotExist(agent), 'agent_unknown'],
      [HL_TEXT.doesNotExist(checksum(agent).toUpperCase().replace('0X', '0x')), 'agent_unknown'],
      [HL_TEXT.doesNotExist(foreign), 'signature_mismatch'],
      [HL_TEXT.mustDeposit(checksum(account)), 'no_deposit'],
      [HL_TEXT.mustDeposit(agent), 'no_deposit'],
      [HL_TEXT.mustDeposit(foreign), 'signature_mismatch'],
      ['Too far from the oracle price', 'price_band'],
      ['Invalid price', 'tick'],
      ['rate limit exceeded', 'address_rate_limited'],
      ['', 'rejected_other'],
    ];
    for (const [text, code] of cases) assert.equal(classifyText(text, ctx), code, text);
    assert.equal(classifyText(HL_TEXT.leverage(), { ...ctx, actionType: 'updateLeverage' }), 'leverage_rejected');
    assert.equal(classifyText(HL_TEXT.leverage(), { ...ctx, actionType: 'order' }), 'rejected_other');
  });

  it('HTTP first: 429, other 4xx, redirects, ≥ 500 and transport objects', () => {
    assert.equal(classify(429, ctx), 'ip_rate_limited');
    for (const s of [400, 404, 422]) assert.equal(classify(s, ctx), 'client_error');
    assert.equal(classify(307, ctx), 'client_error');
    for (const s of [500, 502, 503]) assert.equal(classify(s, ctx), 'transport');
    assert.equal(classify({ transport: true }, ctx), 'transport');
    assert.equal(classify({ redirect: true }, ctx), 'client_error');
    assert.equal(classify({ status: 'err', response: HL_TEXT.doesNotExist(foreign) }, ctx), 'signature_mismatch');
    assert.equal(classify({ error: HL_TEXT.iocNoMatch(1) }, ctx), 'ioc_no_match');
    assert.equal(classify('waitingForSomething', ctx), 'rejected_other');
    assert.equal(classify({ status: 'ok' }, ctx), null);
    assert.equal(classify(200, ctx), null);
  });

  it('bare-string and object statuses parse with the string test first', () => {
    assert.deepEqual(parseStatus('success'), { kind: 'success' });
    assert.deepEqual(parseStatus('waitingForTrigger'), { kind: 'waiting', status: 'waitingForTrigger' });
    assert.equal(parseStatus('weird').code, 'rejected_other');
    assert.equal(parseStatus({ filled: { totalSz: '0.02', avgPx: '1891.4', oid: 77747314 } }).total_sz, 0.02);
    assert.equal(parseStatus({ resting: { oid: 1 } }).kind, 'resting');
    assert.equal(parseStatus({ error: HL_TEXT.minNotional(4) }).code, 'min_notional');
  });

  it('nextStep encodes "never re-sign after an unknown outcome"', () => {
    assert.equal(nextStep('transport', { resends: 0, sinceFirstMs: 100 }), 'resend_identical');
    assert.equal(nextStep('transport', { resends: 2, sinceFirstMs: 100 }), 'resolve_order_status');
    assert.equal(nextStep('transport', { resends: 0, sinceFirstMs: 10_001 }), 'resolve_order_status');
    assert.equal(nextStep('nonce', { attempt: 1, hadTransportFailure: false }), 'resign_fresh_nonce');
    assert.equal(nextStep('nonce', { attempt: 1, hadTransportFailure: false, resigned: true }), 'rejected');
    assert.equal(nextStep('nonce', { attempt: 2, hadTransportFailure: false }), 'resolve_order_status');
    assert.equal(nextStep('nonce', { attempt: 1, hadTransportFailure: true }), 'resolve_order_status');
    assert.equal(nextStep('ip_rate_limited'), 'requeue');
  });

  it('mapOrderStatus: status and filled size only', () => {
    const o = (status, origSz, sz) => ({ status: 'order', order: { order: { oid: 9, origSz, sz, limitPx: '9999' }, status, statusTimestamp: 1 } });
    assert.deepEqual(
      [o('filled', '0.02', '0.0'), o('canceled', '0.04', '0.02'), o('iocCancelRejected', '0.02', '0.02'), o('marginCanceled', '0.02', '0.02'),
        o('reduceOnlyRejected', '1', '1'), o('perpMarginRejected', '1', '1'), o('minTradeNtlRejected', '1', '1'), o('open', '1', '1')]
        .map((x) => mapOrderStatus(x).status),
      ['filled', 'partial', 'rejected', 'canceled', 'rejected', 'rejected', 'rejected', 'resting'],
    );
    assert.equal(mapOrderStatus(o('canceled', '0.04', '0.01')).filled_sz, 0.03);
    assert.ok(!('avg_px' in mapOrderStatus(o('filled', '1', '0'))), 'no price from limitPx');
    assert.equal(mapOrderStatus({ status: 'unknownOid' }).unknownOid, true);
  });

  it('every code has a retry rule or is a warning; note codes are exported', () => {
    for (const code of EXCHANGE_CODES.slice(0, 17)) assert.ok(RETRY[code], code);
    assert.equal(new Set(EXCHANGE_CODES).size, EXCHANGE_CODES.length);
    assert.ok(EXCHANGE_CODES.includes('below_min_order') && EXCHANGE_CODES.includes('address_budget_low'));
    assert.equal(NOTE_CODES.length, 13);
    assert.ok(Object.isFrozen(EXCHANGE_CODES) && Object.isFrozen(NOTE_CODES) && Object.isFrozen(RETRY));
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('info: weights and pagination', () => {
  it('each call is charged its documented weight', async () => {
    const r = rig();
    const w = () => r.tn.scheduler.weight60s();
    const cases = [
      ['allMids', () => r.tn.info.allMids()],
      ['clearinghouseState', () => r.tn.info.clearinghouseState(r.acct.address)],
      ['spotClearinghouseState', () => r.tn.info.spotClearinghouseState(r.acct.address)],
      ['exchangeStatus', () => r.tn.info.exchangeStatus()],
      ['l2Book', () => r.tn.info.l2Book('ETH')],
      ['metaAndAssetCtxs', () => r.tn.info.metaAndAssetCtxs()],
      ['extraAgents', () => r.tn.info.extraAgents(r.acct.address)],
      ['userAbstraction', () => r.tn.info.userAbstraction(r.acct.address)],
      ['userRateLimit', () => r.tn.info.userRateLimit(r.acct.address)],
      ['userRole', () => r.tn.info.userRole(r.ag.address)],
    ];
    for (const [name, call] of cases) {
      const before = w();
      await call();
      assert.equal(w() - before, INFO_WEIGHT[name], name);
    }
  });

  it('userFillsByTime paginates at 500 (startTime = last time), de-duplicates by tid, charges per page', async () => {
    const r = rig();
    r.dbl.addFills(r.acct.address, 1200, { stepMs: 10 });
    const before = r.tn.scheduler.weight60s();
    const fills = await r.tn.info.userFillsByTime(r.acct.address, 0);
    assert.equal(fills.length, 1200);
    assert.equal(new Set(fills.map((f) => f.tid)).size, 1200);
    assert.equal(fills.meta.pages, 3);
    assert.equal(fills.meta.horizon, false);
    const pages = r.dbl.requestsOf('info', 'userFillsByTime');
    assert.equal(pages.length, 3);
    // 3 × 20 + floor(500/20) + floor(500/20) + floor(202/20): page 2 and 3 start at the last time (one overlap each)
    assert.equal(r.tn.scheduler.weight60s() - before, 60 + 25 + 25 + 10);
    for (let i = 1; i < fills.length; i++) assert.ok(fills[i].time >= fills[i - 1].time);
    assert.ok(fills.every((f) => !('cloid' in f)), 'exchange fills carry no cloid');
  });

  it('the 10,000-fill horizon is reported', async () => {
    const r = rig();
    r.dbl.addFills(r.acct.address, 10_050, { stepMs: 1 });
    const fills = await r.tn.info.userFillsByTime(r.acct.address, 0);
    assert.equal(fills.length, 10_000);
    assert.equal(fills.meta.horizon, true);
  });
});

describe('TestnetMarket: listing, cache-only reads, shared book cache, state', () => {
  it('reads the listing at runtime (§6.3 snapshot): indices, decimals, leverage, delisted, unlisted', async () => {
    const r = rig();
    await r.tn.market.refreshMeta();
    await r.tn.market.pollMids();
    const ci = (c) => r.tn.market.coinInfo(c);
    assert.deepEqual(ci('BTC'), { index: 3, sz_decimals: 5, max_leverage: 40, delisted: false, only_isolated: false, margin_mode: null });
    assert.equal(ci('SOL').index, 0);
    assert.equal(ci('SOL').max_leverage, 10);
    assert.deepEqual(ci('HYPE'), { index: 135, sz_decimals: 2, max_leverage: 10, delisted: false, only_isolated: true, margin_mode: 'strictIsolated' });
    assert.equal(ci('ZEC').delisted, true);
    assert.equal(r.tn.market.tradeable('ZEC'), false);
    assert.equal(ci('XRP'), null);
    assert.equal(ci('LINK'), null);
    const rows = r.tn.market.listing();
    assert.equal(rows.length, 16);
    assert.equal(rows.filter((x) => x.tradeable).length, 13);
    assert.deepEqual(rows.find((x) => x.coin === 'XRP'), { coin: 'XRP', index: null, sz_decimals: null, max_leverage: null, delisted: false, only_isolated: false, margin_mode: null, mid: null, mid_ms: null, mark_px: null, funding_1h: null, tradeable: false });
    assert.equal(r.tn.market.quote('ETH').px, 2492.45);
    const snap = r.tn.market.snapshot();
    assert.equal(snap.state, 'live');
    assert.equal(snap.mids.BTC, 82306.5);
    assert.ok(!('XRP' in snap.mids));
    assert.ok(!('bots' in snap) && !('account' in snap));
  });

  it('T-LIST: nothing is hard-coded — a reshuffled universe changes every index', () => {
    const meta = structuredClone(TESTNET_META);
    meta[0].universe.reverse();
    meta[1].reverse();
    const parsed = parseTestnetMeta(meta);
    const n = meta[0].universe.length;
    assert.equal(parsed.get('SOL').index, n - 1);
    assert.equal(parsed.get('BTC').index, n - 4);
    assert.equal(parsed.get('HYPE').index, n - 136);
    assert.equal(parsed.get('SOL').ctx.mid_px, 108.91, 'contexts stay aligned');
  });

  it('cache-only reads spend no weight (1,000 calls); book() schedules ONE shared refresh per stale coin', async () => {
    const r = rig();
    await r.tn.market.refreshMeta();
    await r.tn.market.pollMids();
    const before = r.tn.scheduler.weight60s();
    const reqs = r.dbl.requests.length;
    for (let i = 0; i < 1_000; i++) {
      r.tn.market.quote('ETH');
      r.tn.market.ctx('ETH');
      r.tn.market.coinInfo('BTC');
      r.tn.market.listing();
      r.tn.market.snapshot();
      r.tn.market.state();
    }
    assert.equal(r.tn.scheduler.weight60s(), before);
    assert.equal(r.dbl.requests.length, reqs);
    // 50 players ask for the ETH book at once: one l2Book request
    const answers = Array.from({ length: 50 }, () => r.tn.market.book('ETH'));
    assert.ok(answers.every((a) => a === null), 'cache miss answers null at once');
    await flush();
    await flush();
    assert.equal(r.dbl.requestsOf('info', 'l2Book').length, 1);
    const b = r.tn.market.book('ETH');
    assert.ok(b.depth_buy_usd_1pct > 0 && b.depth_sell_usd_1pct > 0);
    assert.equal(r.tn.market.book('XRP'), null, 'unlisted coins never fetch');
    r.clock.ms += 20_000;
    r.tn.market.book('ETH');
    await flush();
    assert.equal(r.dbl.requestsOf('info', 'l2Book').length, 1, 'fresh for 30 s');
    r.clock.ms += 11_000;
    r.tn.market.book('ETH');
    r.tn.market.book('ETH');
    await flush();
    await flush();
    assert.equal(r.dbl.requestsOf('info', 'l2Book').length, 2, 'one refresh after 30 s');
  });

  it('a thin book shows in the depth', async () => {
    const r = rig();
    await r.tn.market.refreshMeta();
    r.dbl.setBook('ETH', { levelUsd: 5 });
    const b = await r.tn.market.refreshBook('ETH');
    assert.ok(b.depth_buy_usd_1pct < 100);
  });

  it('state: live → delayed (> 15 s) → down (> 60 s); signing halt and clock skew force down', async () => {
    const r = rig();
    const changes = [];
    r.tn.market.onStateChange((c) => changes.push(c));
    await r.tn.market.start();
    assert.equal(r.tn.market.state(), 'live');
    r.clock.ms += 16_000;
    r.tn.market.evaluate();
    assert.equal(r.tn.market.state(), 'delayed');
    r.dbl.fault({ kind: 'network', path: 'info', type: 'allMids', times: 1 });
    r.clock.ms += 50_000;
    await r.tn.market.pollMids();
    assert.deepEqual(r.tn.market.status(), { state: 'down', reason: 'unreachable' });
    await r.tn.market.pollMids();
    assert.equal(r.tn.market.state(), 'live');
    r.dbl.skewMs = 90_000;
    await r.tn.market.checkClock();
    assert.deepEqual(r.tn.market.status(), { state: 'down', reason: 'clock_skew' });
    r.dbl.skewMs = 0;
    await r.tn.market.checkClock();
    assert.equal(r.tn.market.state(), 'live');
    assert.deepEqual(changes.map((c) => c.state), ['delayed', 'down', 'live', 'down', 'live']);
    r.tn.market.stop();
  });

  it('a disabled market is "disabled" and sends nothing', async () => {
    const dbl = makeTestnetDouble();
    const tn = createTestnet({ fetch: dbl.fetch, enabled: false, timers: { setTimeout: () => null, clearTimeout: () => {} } });
    await tn.market.start();
    assert.equal(tn.market.state(), 'disabled');
    assert.equal(tn.market.book('ETH'), null);
    assert.equal(dbl.requests.length, 0);
  });
});

describe('the double itself', () => {
  it('refuses any URL but the two testnet ones, and records it', async () => {
    const dbl = makeTestnetDouble();
    await assert.rejects(dbl.fetch('https://api.hyperliquid-testnet.xyz/other', { method: 'POST', body: '{}' }));
    assert.equal(dbl.violations.length, 1);
  });

  it('answers userRole with a mixed-case data.user, and enforces the nonce window', async () => {
    const dbl = makeTestnetDouble();
    const a = dbl.addAccount();
    const ag = dbl.addAgent(a.address);
    const res = await (await dbl.fetch('https://api.hyperliquid-testnet.xyz/info', { method: 'POST', body: JSON.stringify({ type: 'userRole', user: ag.address }) })).json();
    assert.equal(res.role, 'agent');
    assert.notEqual(res.data.user, a.address, 'mixed case');
    assert.equal(res.data.user.toLowerCase(), a.address);
    const signer = makeSigner(ag.keyBytes);
    const action = updateLeverageAction(4, 3);
    const old = Date.now() - 3 * 86_400_000;
    const body = JSON.stringify({ action, nonce: old, signature: signer.signL1(action, old), vaultAddress: null, expiresAfter: null });
    const out = await (await dbl.fetch('https://api.hyperliquid-testnet.xyz/exchange', { method: 'POST', body })).json();
    assert.equal(out.status, 'err');
    assert.match(out.response, /nonce/i);
    assert.ok(randomKey().length === 64);
  });
});

describe('P1: the wallet-signed approveAgent relay (§6.10)', () => {
  const walletSign = (keyHex, message, chainId) => {
    const sig = secp256k1.sign(userSignedDigest(APPROVE_AGENT_PRIMARY_TYPE, APPROVE_AGENT_FIELDS, message, chainId), Buffer.from(keyHex, 'hex'), { lowS: true });
    return `0x${sig.r.toString(16).padStart(64, '0')}${sig.s.toString(16).padStart(64, '0')}${(27 + sig.recovery).toString(16)}`;
  };

  it('recovers the account from the wallet signature (Testnet literal), relays it, and the agent becomes usable', async () => {
    const r = rig();
    const agentKey = randomKey();
    const agentAddress = makeSigner(Uint8Array.from(Buffer.from(agentKey, 'hex'))).address;
    const nonce = r.now();
    const agentName = `bean-garden valid_until ${r.now() + 90 * 86_400_000}`;
    const chainId = 421614;
    const signature = walletSign(r.acct.key, { hyperliquidChain: 'Testnet', agentAddress, agentName, nonce }, chainId);
    const res = await r.tn.exchange.relayApproveAgent({ accountAddress: checksum(r.acct.address), agentAddress, agentName, nonce, chainId, signature });
    assert.equal(res.ok, true, JSON.stringify(res));
    const sent = JSON.parse(r.dbl.requestsOf('exchange', 'approveAgent')[0].body);
    assert.deepEqual(Object.keys(sent.action), ['type', 'signatureChainId', 'hyperliquidChain', 'agentAddress', 'agentName', 'nonce']);
    assert.equal(sent.action.signatureChainId, '0x66eee');
    assert.equal(sent.action.hyperliquidChain, 'Testnet');
    assert.equal(sent.expiresAfter, null);
    const role = await r.tn.info.userRole(agentAddress);
    assert.equal(role.role, 'agent');
    assert.equal(role.data.user.toLowerCase(), r.acct.address);
  });

  it('a signature by anyone else, or over a Mainnet message, is signer_mismatch and nothing is sent', async () => {
    const r = rig();
    const agentAddress = makeSigner(Uint8Array.from(Buffer.from(randomKey(), 'hex'))).address;
    const nonce = r.now();
    const agentName = 'bean-garden';
    const other = walletSign(randomKey(), { hyperliquidChain: 'Testnet', agentAddress, agentName, nonce }, 421614);
    assert.equal((await r.tn.exchange.relayApproveAgent({ accountAddress: r.acct.address, agentAddress, agentName, nonce, chainId: 421614, signature: other })).code, 'signer_mismatch');
    const mainnetMsg = walletSign(r.acct.key, { hyperliquidChain: 'Mainnet', agentAddress, agentName, nonce }, 421614);
    assert.equal((await r.tn.exchange.relayApproveAgent({ accountAddress: r.acct.address, agentAddress, agentName, nonce, chainId: 421614, signature: mainnetMsg })).code, 'signer_mismatch');
    assert.equal((await r.tn.exchange.relayApproveAgent({ accountAddress: 'nope', agentAddress, agentName, nonce, chainId: 421614, signature: other })).code, 'bad_request');
    assert.equal(r.dbl.requests.length, 0);
  });
});

describe('the double’s dev script (dev_double, §8.6)', () => {
  it('accepts every documented fault with sensible args and refuses anything else with a 400', async () => {
    const dbl = makeTestnetDouble();
    const created = dbl.script('new_account', { usd: 500 });
    assert.match(created.agent_key, /^0x[0-9a-f]{64}$/);
    const args = {
      faucet: { usd: 10 }, error: { code: 'ioc_no_match' }, drift: { coin: 'ETH', sz: 0.01 }, liquidation: { coin: 'ETH' },
      clock_skew: { ms: 1000 }, set_mid: { coin: 'ETH', px: 2500 }, thin_book: { coin: 'ETH' }, funding: { coin: 'ETH', rate: 0.0001 },
      abstraction: { value: 'unifiedAccount' }, partial: { fraction: 0.5 }, bare_string: { value: 'odd' },
    };
    for (const name of DEV_FAULTS) dbl.script(name, args[name] ?? {});
    for (const [name, a] of [['nope', {}], ['set_mid', { px: -1 }], ['drift', { account: '0x0000000000000000000000000000000000000001' }], ['error', null]]) {
      assert.throws(() => dbl.script(name, a), (err) => err.status === 400 && err.code === 'bad_request', name);
    }
  });
});

// T-PERF for the gardens (PLATFORM §7.6, §6.8, §11.2 perf-gardens; WP3). Runs only with PERF=1:
//
//   PERF=1 node --test test/perf-gardens.test.js
//
//   1. 1,000 gardens × 10 open paper bots on one engine: afterTick ≤ 40 ms (without the flush), markLive ≤ 20 ms,
//      flush ≤ 60 ms (medians over the measured bars; the maxima are printed).
//   2. 40 testnet players on the WP2 double answering in 50 ms: every testnet sync of a bar is done ≤ 20 s after the
//      bar, and the weight ledger never exceeds TESTNET_BUDGET over a simulated hour (60 bars). Budget waits are
//      scheduler sleeps on the FAKE clock (they cost no wall time), so the latency that matters is measured there too:
//      bar close → the last exchange action of that bar on the double ≤ 20 s of fake time.
// (The SSE-stream, backup and retention parts of T-PERF belong to WP4/WP1.)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Journal, GLOBAL_KINDS } from '../server/journal.js';
import { openDb, MIGRATIONS_DIR } from '../server/db/db.js';
import { migrate } from '../server/db/migrate.js';
import { Gardens } from '../server/garden/gardens.js';

const PERF = process.env.PERF === '1';
const quiet = () => {};

const COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE', 'AVAX', 'LINK', 'SUI', 'NEAR', 'ARB', 'TIA', 'ZEC', 'WIF', 'PUMP', 'VVV'];
const PX = { BTC: 82000, ETH: 2500, SOL: 110, HYPE: 40, XRP: 2.2, DOGE: 0.2, AVAX: 25, LINK: 15, SUI: 3, NEAR: 5, ARB: 0.4, TIA: 4, ZEC: 140, WIF: 1, PUMP: 0.005, VVV: 22 };
const SZ = { BTC: 5, ETH: 4, SOL: 2, HYPE: 2, XRP: 0, DOGE: 0, AVAX: 2, LINK: 1, SUI: 1, NEAR: 1, ARB: 1, TIA: 1, ZEC: 2, WIF: 0, PUMP: 0, VVV: 2 };

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** A fast fake engine: `perCoin` beans per coin, positioned; flip() moves a share of them every bar. */
function fakeEngine({ perCoin = 20 } = {}) {
  const beans = [];
  for (let i = 0; i < COINS.length * perCoin; i++) {
    const coin = COINS[i % COINS.length];
    const side = i % 3 === 0 ? -1 : 1;
    beans.push({ id: i, coin, leverage: 2, position_size: 0.5, equity: 1000, side, units: side ? (500 / PX[coin]) : 0, entry_px: PX[coin], busted: false });
  }
  const mids = { ...PX };
  let n = 0;
  return {
    catchingUp: false,
    prices: 'sim',
    canOpen: () => null,
    mids,
    population: { row: (id) => (beans[id] ? { ...beans[id] } : null) },
    market: {
      coins: COINS.map((coin) => ({ coin })),
      mid: (c) => mids[c] ?? null,
      livePx: (c) => mids[c] ?? null,
      coinInfo: (c) => (PX[c] ? { coin: c, max_leverage: 20, sz_decimals: SZ[c] } : null),
      isStale: () => false,
    },
    beans,
    /** Flip ~2 % of the beans and wiggle prices (mirror work for the next bar; a busy real minute). */
    flip() {
      n++;
      for (let i = n % 50; i < beans.length; i += 50) {
        const b = beans[i];
        b.side = b.side === 0 ? 1 : -b.side;
        b.entry_px = mids[b.coin];
      }
      for (const c of COINS) mids[c] = PX[c] * (1 + 0.002 * Math.sin(n + c.length));
    },
  };
}

function tmp({ memory = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bean-perf-'));
  const db = openDb({ file: memory ? ':memory:' : path.join(dir, 'bean.db') });
  migrate(db, MIGRATIONS_DIR, { backupDir: path.join(dir, 'backups') });
  return { dir, db };
}

/**
 * 1,000 gardens × 10 open paper bots; 12 bars. → per-bar timings (the first two bars warm the JIT and the statement
 * cache and are dropped).
 */
async function paperRun({ memory }) {
  const { dir, db } = tmp({ memory });
  try {
    const engine = fakeEngine({ perCoin: 20 });
    const journal = new Journal({ scoped: true, globalKinds: GLOBAL_KINDS, keep: 5000, log: quiet });
    const gardens = new Gardens({ engine, journal, db, log: quiet });
    await gardens.init();
    const now = Date.now();
    const ins = db.prepare('INSERT INTO users (username, pw_hash, created_ms, updated_ms, pw_changed_ms) VALUES (?, ?, ?, ?, ?)');
    const uids = [];
    db.tx(() => {
      for (let i = 0; i < 1000; i++) uids.push(Number(ins.run(`p${String(i).padStart(4, '0')}`, 'scrypt$x', now, now, now).lastInsertRowid));
    });
    const t0 = performance.now();
    for (const [k, uid] of uids.entries()) {
      const g = gardens.get(uid);
      for (let j = 0; j < 10; j++) {
        const coinIdx = (k + j * 3) % COINS.length;
        g.create({ bean: coinIdx + COINS.length * ((k + j) % 20), capital_usd: 50 });
      }
    }
    const setupS = (performance.now() - t0) / 1000;
    assert.equal(gardens.open.size, 1000);
    const after = [];
    const marks = [];
    const flushes = [];
    for (let bar = 1; bar <= 12; bar++) {
      engine.flip();
      const a0 = performance.now();
      gardens.afterTick({ tick: bar });
      const total = performance.now() - a0;
      flushes.push(gardens.repo.stats.lastFlushMs);
      after.push(total - gardens.repo.stats.lastFlushMs);
      const m0 = performance.now();
      gardens.markLive({ px: engine.mids, t: Date.now() });
      marks.push(performance.now() - m0);
      await new Promise((r) => setImmediate(r));
    }
    await gardens.shutdown({ drainMs: 0 });
    return { setupS, after: after.slice(2), marks: marks.slice(2), flushes: flushes.slice(2) };
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('T-PERF gardens (PERF=1)', { skip: !PERF && 'set PERF=1 to run the performance budgets' }, () => {
  it('1,000 gardens × 10 paper bots: afterTick ≤ 40 ms, markLive ≤ 20 ms, flush ≤ 60 ms', async () => {
    // The budgets are asserted on an in-memory DB (CPU cost, reproducible on any machine). The same run on disk is
    // printed: commit latency is the host's I/O (WAL append), e.g. slow on a Windows temp dir under an AV scanner.
    const mem = await paperRun({ memory: true });
    const disk = await paperRun({ memory: false });
    const fmt = (xs) => `p50 ${median(xs).toFixed(1)} ms (max ${Math.max(...xs).toFixed(1)})`;
    console.log(`# T-PERF paper (memory DB): setup ${mem.setupS.toFixed(1)} s for 10,000 bots; afterTick ${fmt(mem.after)}, markLive ${fmt(mem.marks)}, flush ${fmt(mem.flushes)}`);
    console.log(`# T-PERF paper (disk DB, info): setup ${disk.setupS.toFixed(1)} s; afterTick ${fmt(disk.after)}, markLive ${fmt(disk.marks)}, flush ${fmt(disk.flushes)}`);
    assert.ok(median(mem.after) <= 40, `afterTick ${median(mem.after).toFixed(1)} ms ≤ 40 ms`);
    assert.ok(median(mem.marks) <= 20, `markLive ${median(mem.marks).toFixed(1)} ms ≤ 20 ms`);
    assert.ok(median(mem.flushes) <= 60, `flush ${median(mem.flushes).toFixed(1)} ms ≤ 60 ms`);
  });

  it('40 testnet players on the double (50 ms answers): syncs done ≤ 20 s after each bar; weight ≤ budget over an hour', async () => {
    const hl = await import('../server/hl/index.js');
    const { makeTestnetDouble } = await import('./fixtures/hl-testnet-double.js');
    const { Secrets, wipeCredentials } = await import('../server/secrets.js');
    const { Credentials } = await import('../server/garden/credentials.js');
    const { dir, db } = tmp();
    try {
      const clock = { ms: Date.UTC(2026, 9, 11, 12) };
      const now = () => clock.ms;
      const double = makeTestnetDouble({ now });
      const slow = (url, init) => new Promise((resolve, reject) => {
        setTimeout(() => double.fetch(url, init).then(resolve, reject), 50);
      });
      const testnet = hl.createTestnet({
        fetch: slow, now, log: quiet, mainnetClient: double.mainnetInfo, coins: ['ETH', 'SOL', 'AVAX'],
        sleep: async (ms) => {
          clock.ms += ms;
          await new Promise((r) => setImmediate(r));
        },
        timers: { setTimeout: () => null, clearTimeout() {} },
      });
      await testnet.market.refreshMeta();
      await testnet.market.pollMids();
      const engine = fakeEngine({ perCoin: 4 });
      engine.market.mid = (c) => ({ ETH: 2492.45, SOL: 108.91, AVAX: 10.307 }[c] ?? PX[c]);
      engine.market.livePx = engine.market.mid;
      const journal = new Journal({ scoped: true, globalKinds: GLOBAL_KINDS, log: quiet });
      const lib = { wire: hl, format: hl, errors: hl, constants: hl, signing: hl, addr: hl, verify: { parseAgentKey: hl.parseAgentKey } };
      const credentials = new Credentials({ db, secrets: new Secrets({ masterKey: crypto.randomBytes(32) }), makeSigner: hl.makeSigner, wipeCredentials, now, log: quiet });
      const gardens = new Gardens({ engine, journal, db, testnet, lib, credentials, now, log: quiet, mainnetInfo: double.mainnetInfo });
      await gardens.init();
      const ins = db.prepare('INSERT INTO users (username, pw_hash, created_ms, updated_ms, pw_changed_ms) VALUES (?, ?, ?, ?, ?)');
      const players = [];
      for (let i = 0; i < 40; i++) {
        const uid = Number(ins.run(`t${String(i).padStart(3, '0')}`, 'scrypt$x', now(), now(), now()).lastInsertRowid);
        const acct = double.addAccount({ usd: 5000 });
        const ag = double.addAgent(acct.address);
        await gardens.testnetConnect(uid, { account_address: acct.address, agent_key: ag.key });
        clock.ms += 31_000; // connects are limited to 2 per minute (§6.7)
        players.push({ uid, account: acct.address });
      }
      await testnet.market.pollMids();
      // One testnet bot per player on ETH / SOL / AVAX (positioned beans).
      const ethBeans = engine.beans.filter((b) => b.coin === 'ETH' && b.side !== 0);
      engine.beans.forEach((b) => {
        if (b.coin === 'ETH') b.units = (b.side || 1) * 0.2;
      });
      for (const [i, p] of players.entries()) {
        const bean = ethBeans[i % ethBeans.length];
        const g = gardens.get(p.uid);
        await testnet.market.pollMids();
        await g.create({ bean: bean.id, capital_usd: 100, venue: 'testnet', confirm: 'testnet', ack_divergence: true });
      }
      let maxWeight = 0;
      const durations = [];
      const orderLag = []; // fake ms from the bar to its last exchange action (budget waits included)
      for (let bar = 1; bar <= 60; bar++) {
        clock.ms += 60_000;
        await testnet.market.pollMids();
        if (bar % 7 === 0) for (const b of engine.beans) if (b.coin === 'ETH') b.side = -b.side;
        const t0 = performance.now();
        const f0 = clock.ms;
        const ex0 = double.executed.length;
        gardens.afterTick({ tick: bar });
        for (let i = 0; i < 2000; i++) {
          await new Promise((r) => setTimeout(r, 5));
          const s = testnet.scheduler.stats();
          if (s.lanes_busy === 0 && s.inflight === 0 && s.queued === 0) break;
        }
        durations.push(performance.now() - t0);
        const ex = double.executed.slice(ex0);
        if (ex.length) orderLag.push(Math.max(...ex.map((e) => e.t)) - f0);
        maxWeight = Math.max(maxWeight, testnet.scheduler.weight60s());
      }
      const worst = Math.max(...durations);
      const worstLag = orderLag.length ? Math.max(...orderLag) : 0;
      console.log(`# T-PERF testnet: 40 players, 60 bars; sync p50 ${median(durations).toFixed(0)} ms, max ${worst.toFixed(0)} ms; ` +
        `orders ≤ ${(worstLag / 1000).toFixed(1)} s (fake clock) after the bar; max weight_60s ${maxWeight} / ${testnet.scheduler.budget}`);
      assert.ok(worst <= 20_000, `all syncs done ≤ 20 s after the bar (worst ${worst.toFixed(0)} ms)`);
      assert.ok(orderLag.length > 0, 'the flips sent orders');
      assert.ok(worstLag <= 20_000, `every bar's orders went out ≤ 20 s (fake clock) after it (worst ${worstLag} ms)`);
      assert.ok(maxWeight <= testnet.scheduler.budget, `weight ${maxWeight} ≤ budget ${testnet.scheduler.budget}`);
      await gardens.shutdown({ drainMs: 1000 });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

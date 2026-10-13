// test/cloud-egress.test.js — the cloud sync's monthly upload budget (server/cloudsync.js EGRESS PACE).
//
// Render's Hobby workspace includes 5 GB of outbound traffic a month; above it (without a card) the services are
// suspended until the next month, and the players' own traffic (pages, SSE streams) shares that allowance. These
// tests run the REAL startCloudSync for simulated hours on a fake clock against an in-memory store
// (test/fixtures/mem-storage.js): with a realistic engine state (≈ 2.3–2.6 MB gzipped, like data-prod/state-real.json)
// the projected month stays under the default budget, the hourly history costs no egress (server-side copies), and a
// big busy DB is paced to the budget instead of breaking it. Offline: no network, no Supabase, no Render.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cloudFiles, startCloudSync, monthFraction, LEASE_PATH, EGRESS_BUDGET_BYTES, PACE_SLACK, STATE_MAX_AGE_MS } from '../server/cloudsync.js';
import { sanitizeLogLine } from '../server/secrets.js';
import { memStore } from './fixtures/mem-storage.js';

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bean-egress-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const ALL_LOGS = [];
function logger() {
  const lines = [];
  const log = (line) => {
    lines.push(String(line));
    ALL_LOGS.push(String(line));
  };
  log.lines = lines;
  return log;
}

function clock(start) {
  const c = { ms: start, now: () => c.ms, advance: (ms) => { c.ms += ms; } };
  return c;
}

/** A float-heavy engine state JSON like data-prod/state-real.json (≈ 5 MB → ≈ 2.3–2.6 MB gzipped). */
function bigStateFile(dir, numbers = 450_000) {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const values = new Array(numbers);
  for (let i = 0; i < numbers; i++) values[i] = Math.round((rnd() * 2000 - 1000) * 1e6) / 1e6;
  const file = path.join(dir, 'state-real.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, engine: { population: values } }));
  return file;
}

describe('egress budget (Render Hobby: 5 GB/month outbound)', () => {
  it('24 h with players active every minute: the projected month stays under the budget; history costs no egress', async () => {
    const dir = tmpDir();
    const stateFile = bigStateFile(dir);
    const files = cloudFiles({ dbFile: path.join(dir, 'bean.db'), stateFile });
    const c = clock(Date.UTC(2026, 10, 1, 0, 0, 30)); // a month starts: the projection is this day × 30
    const store = memStore();
    // The DB changes every minute (a fill per minute); its gzip copy is ~24 KB (an accounts DB with a few players).
    let changes = 0;
    const db = { closed: false, prepare: () => ({ get: () => ({ n: changes }) }) };
    const dbCopy = crypto.randomBytes(24 * 1024);
    const log = logger();
    const sync = startCloudSync({ store, db, files, intervalMs: 60_000, now: c.now, log, snapshot: async () => dbCopy });
    await sync.start();
    for (let m = 0; m < 1440; m++) {
      c.advance(60_000);
      changes += 1;
      fs.utimesSync(stateFile, c.ms / 1000, c.ms / 1000); // the engine saves its state every bar
      await sync.syncNow('interval');
    }
    const st = sync.status();
    assert.ok(st.state_bytes > 2_000_000, `a realistic state (${st.state_bytes} bytes gzipped)`);
    assert.equal(st.held, 0, 'nothing had to wait for the pace');
    assert.ok(st.month_projected_bytes < EGRESS_BUDGET_BYTES, `projected ${st.month_projected_bytes} < ${EGRESS_BUDGET_BYTES}`);
    assert.ok(EGRESS_BUDGET_BYTES < 5e9 * 0.7, 'the budget leaves part of Render\'s 5 GB to the players\' own traffic');
    assert.equal(store.ops.copy, 2 * 25, 'the hourly history copies (25 UTC hours touched) are server-side');
    assert.ok(store.ops.upload < 1440 + 30 + 1500, 'one DB copy per changed minute, the state hourly, the lease heartbeat');
    assert.ok(log.lines.every((l) => !/ALERT/.test(l)));
  });

  it('a big, busy DB is PACED: the month stays within budget + 5 %, the DB still reaches the bucket regularly (DB before state)', async () => {
    // Scaled 1:10 to keep the test fast — a 300 MiB budget, a 60 KB-gzip DB that changes every minute (86 MB/day
    // unpaced, 29× the pace) and a ~100 KB-gzip state — the same ratios as 3 GiB, 600 KB and 1 MB.
    const budget = 300 * 1024 * 1024;
    const dir = tmpDir();
    const stateFile = bigStateFile(dir, 20_000);
    const files = cloudFiles({ dbFile: path.join(dir, 'bean.db'), stateFile });
    const t0 = Date.UTC(2026, 10, 16, 0, 0, 0);
    const c = clock(t0);
    const store = memStore();
    // The previous instance already used the month's pace exactly (lease.json carries the meter).
    const atPace = Math.round(budget * monthFraction(t0));
    store.objects.set(LEASE_PATH, Buffer.from(JSON.stringify({
      v: 2, instance: 'previous', started_ms: t0 - 86_400_000, renewed_ms: t0 - 120_000, month: '202611', month_bytes: atPace, synced: true,
    })));
    let changes = 0;
    const db = { closed: false, prepare: () => ({ get: () => ({ n: changes }) }) };
    const dbCopy = crypto.randomBytes(60 * 1024);
    const log = logger();
    const sync = startCloudSync({ store, db, files, intervalMs: 60_000, graceMs: 0, egressBudgetBytes: budget, now: c.now, log, snapshot: async () => dbCopy });
    await sync.start();
    assert.equal(sync.status().month_bytes > atPace, true, 'the meter continues from lease.json');
    const dbTimes = [];
    const stateTimes = [];
    let lastDb = null;
    let lastState = null;
    let at6h = null;
    for (let m = 1; m <= 12 * 60; m++) {
      c.advance(60_000);
      changes += 1;
      fs.utimesSync(stateFile, c.ms / 1000, c.ms / 1000);
      await sync.syncNow('interval');
      const st = sync.status();
      if (st.db_uploaded_ms !== lastDb) dbTimes.push((lastDb = st.db_uploaded_ms));
      if (st.state_uploaded_ms !== lastState) stateTimes.push((lastState = st.state_uploaded_ms));
      if (m === 6 * 60) at6h = { bytes: st.month_bytes, t: c.ms };
    }
    const st = sync.status();
    // Never above the pace allowance (+ one upload): over a month that is the budget + 5 %.
    const allowedEnd = budget * (monthFraction(c.ms) + PACE_SLACK);
    assert.ok(st.month_bytes <= allowedEnd + dbCopy.length + 16 * 1024, `${st.month_bytes} ≤ the pace allowance ${allowedEnd}`);
    // Once the 5 % slack is spent (first hours), the rate is the budget's pace: budget / days in the month.
    const steady = st.month_bytes - at6h.bytes;
    const pace = budget * (monthFraction(c.ms) - monthFraction(at6h.t));
    assert.ok(steady <= pace + dbCopy.length + 16 * 1024, `last 6 h: ${steady} bytes vs the pace ${Math.round(pace)}`);
    assert.ok(st.held > 0 && st.over_pace === true);
    const gaps = dbTimes.slice(1).map((t, i) => t - dbTimes[i]);
    assert.ok(dbTimes.length >= 40, `the DB still went up ${dbTimes.length} times in 12 h`);
    assert.ok(Math.max(...gaps) <= 30 * 60_000, `largest gap ${Math.max(...gaps) / 60_000} min`);
    assert.ok(stateTimes.length >= 1 && STATE_MAX_AGE_MS === 12 * 3_600_000);
    assert.ok(log.lines.every((l) => !/ALERT/.test(l) || /ALERT egress: .* the bucket copy of the database is \d+ min behind/.test(l)));
    // A forced sync (shutdown) is never paced.
    const fin = await sync.syncNow('shutdown', { force: true });
    assert.ok(fin.uploaded.includes('db/bean.db.gz') && fin.uploaded.includes('state/state-real.json.gz'));
  });
});

describe('egress ALERT', () => {
  it('when the pace holds the DB copy back for 15+ minutes the operator is told (hourly), and the copy still goes later', async () => {
    const dir = tmpDir();
    const stateFile = path.join(dir, 'state-real.json');
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, engine: { tick: 1 } }));
    const files = cloudFiles({ dbFile: path.join(dir, 'bean.db'), stateFile });
    const c = clock(Date.UTC(2026, 10, 1, 0, 0, 30)); // a month starts: the allowance is the 5 % slack
    const store = memStore();
    let changes = 0;
    const db = { closed: false, prepare: () => ({ get: () => ({ n: changes }) }) };
    const log = logger();
    // A tiny budget (2 MiB/month) against a 64 KB DB copy: after the first upload the pace holds every later one.
    const sync = startCloudSync({
      store, db, files, intervalMs: 60_000, egressBudgetBytes: 2 * 1024 * 1024, now: c.now, log, snapshot: async () => crypto.randomBytes(64 * 1024),
    });
    await sync.start();
    for (let m = 0; m < 20; m++) {
      c.advance(60_000);
      changes += 1;
      await sync.syncNow('interval');
    }
    const alerts = log.lines.filter((l) => /^\[cloud\] ALERT egress: .* the bucket copy of the database is \d+ min behind/.test(l));
    assert.equal(alerts.length, 1, 'once (then at most hourly)');
    assert.ok(sync.status().db_held_since_ms !== null && sync.status().held > 0);
    // A forced sync (shutdown) still uploads it.
    assert.ok((await sync.syncNow('shutdown', { force: true })).uploaded.includes('db/bean.db.gz'));
  });
});

describe('egress log lines', () => {
  it('every line the simulations logged passes the secrets sanitizer unchanged', () => {
    for (const line of ALL_LOGS) assert.equal(sanitizeLogLine(line), line, line);
  });
});

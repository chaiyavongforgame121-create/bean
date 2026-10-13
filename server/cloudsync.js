// server/cloudsync.js — durable accounts-mode state on an EPHEMERAL host (Render free) via a private Supabase
// Storage bucket (server/cloudstore.js). deploy/render/README.md is the operator's guide.
//
// What lives in the bucket (under CLOUD_STORE_PREFIX; the .gz objects are gzip):
//   db/bean.db.gz                    the accounts DB (a consistent online-backup copy, never the live file)
//   state/state-real.json.gz         the engine state JSON (the market, the beans, the global journal)
//   history/YYYYMMDDHH/<file>.gz     one copy of both per UTC hour (server-side copies), newest 48 kept
//   lease.json                       the ONE instance allowed to upload, renewed by it on every sync (a heartbeat:
//                                    {instance, started_ms, renewed_ms, interval_s, seq, month, month_bytes, synced})
//   admin/admin-bootstrap.txt        the generated first-admin code (plain text) while no admin exists (no shell)
// (The journal jsonl is not synced: the engine restores the global journal from the state JSON and user records live in
// the DB; main.js continues the journal seq past lease.json's `seq`, so a restart never reuses a seq.)
//
// Boot (main.js, before the DB is opened and before the engine state is loaded): restoreFromCloud() downloads every
// managed file that is MISSING locally (written tmp + fsync + rename; a restored DB's stale -wal/-shm are removed
// first). An empty bucket → a fresh start. Any other download failure, a corrupt gzip or a file that is not what it
// claims to be → CloudSyncError (exit 4): starting empty would later OVERWRITE the good cloud copy. The same refusal
// when the DB or the state is "not found" although the bucket shows a previous deployment (lease.json says a DB was
// synced, history/ has hours, or the other file is there): a spurious not-found must never start an empty garden —
// unless the operator sets CLOUD_ALLOW_FRESH=1 for one boot.
//
// Running (startCloudSync, after the server listens):
//   * LEASE — Render's zero-downtime deploys run the old and the new instance side by side for a while. The new one
//     takes the lease once it listens (unless lease.json names an instance that started later and is still renewing)
//     and renews it on every sync. Every upload of the DB or the state, and every renewal, is preceded by a lease read
//     (an instance whose run outlasted a takeover never writes its name back); an instance that
//     sees another owner stops uploading and STANDS BY: it re-checks every interval and takes the lease back once
//     the owner stops renewing (its lease.json unchanged for 3 intervals + 1 min, measured on the standby's own clock
//     — no cross-host clock comparison), so a deploy that took the lease and then died never silences the instance
//     that keeps serving. A standby that lasts over 10 min logs an ALERT every 10 min (two live instances on one
//     bucket). A missing lease.json while owning it is retried once, then written again — never a takeover.
//   * every acquisition is followed by a FULL upload (DB + state). After a TAKEOVER it waits until the previous owner's
//     last upload can no longer land (store.maxCallMs: every attempt + backoff; the lineage fix): a stale instance's
//     late upload is always overwritten by the owner.
//   * every CLOUD_SYNC_SECONDS: if the DB changed (SQLite total_changes() of the one connection) an online backup
//     (server/db/backup.js) into a temp file → gzip → db/<file>.gz. The engine state (≈ 2–3 MB gzipped, the biggest
//     upload) goes EVERY 2 HOURS when it changed and at every forced sync (shutdown, takeover): uploads leave Render's
//     monthly outbound allowance (Hobby: 5 GB, then the services are suspended), and an older engine state is
//     harmless — the gardens' replay guard (server/live.js) never re-mirrors a bar the DB already reflects; it only
//     makes the restart replay longer.
//   * hourly: history/<UTC hour>/ gets server-side copies of db/ and state/ (no egress), history is pruned to the
//     newest 48 hours, and the bucket's privacy is re-checked (a bucket made public stops every upload, ALERT).
//   * EGRESS PACE: bytes sent this calendar month are metered (continued across restarts through lease.json). Render's
//     allowance also has to carry the players' own traffic (pages, SSE streams), so the sync keeps to a budget
//     (CLOUD_EGRESS_BUDGET_MB, 3072 MB/month): a non-forced upload goes only while the month stays within the
//     budget's pace (+5 %); the DB goes first, the state at least every 12 h whatever the pace; a held upload goes
//     at a later sync (ALERT when the DB copy is over 15 min behind, hourly). Forced syncs (shutdown, takeover) always
//     run. A bigger DB therefore means a wider data-loss window, never a suspended service. status() shows the
//     month's bytes and the projection. (Simulated in test/cloud-egress.test.js: 24 h with a realistic state and a DB
//     that changes every minute.)
//   * the admin bootstrap code: uploaded while no admin exists and ADMIN_BOOTSTRAP_CODE is not set; deleted from the
//     bucket as soon as an admin exists (or when a code is configured).
//   * failures are logged (the first of a streak, then at most every 10 min, and the recovery); status() feeds
//     admin_status.cloud. Every log line stays readable through the secrets sanitizer (test/cloud.test.js).
// Shutdown (main.js, after gardens flush → state save → WAL checkpoint + close): syncNow('shutdown', {force, deadline})
// uploads the final DB and state copies within a hard deadline (Render sends SIGKILL ~30 s after SIGTERM).

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';

import { backupDb } from './db/backup.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const LEASE_PATH = 'lease.json';
export const BOOTSTRAP_REMOTE = 'admin/admin-bootstrap.txt';
export const HISTORY_DIR = 'history';
export const HISTORY_KEEP = 48;
/** The engine state is uploaded at most this often when it changed (plus every forced sync). */
export const STATE_EVERY_MS = 2 * 60 * 60_000;
/** Default deadline of the shutdown sync (Render: SIGKILL ~30 s after SIGTERM; main.js caps it further). */
export const SHUTDOWN_SYNC_MS = 20_000;
/**
 * Monthly upload budget of the sync. Render Hobby includes 5 GB of outbound traffic per month (above it, without a card,
 * the workspace's services are suspended until the next month) and the players' traffic needs the rest.
 */
export const EGRESS_BUDGET_BYTES = 3 * 1024 ** 3;
/** A non-forced upload must keep the month's bytes within budget × (elapsed fraction of the month + this). */
export const PACE_SLACK = 0.05;
/** The engine state is uploaded at least this often (when it changed), whatever the egress pace. */
export const STATE_MAX_AGE_MS = 12 * 60 * 60_000;
/** The pacing holding the DB back longer than this logs an ALERT (then hourly). */
export const DB_HELD_ALERT_MS = 15 * 60_000;
/** Bytes counted per Storage request on top of its body (headers, TLS framing): the meter is an estimate. */
export const REQUEST_OVERHEAD_BYTES = 1024;
/** A standby longer than this logs an ALERT (then every 10 min). */
export const STANDBY_ALERT_MS = 10 * 60_000;
const FAIL_LOG_EVERY_MS = 10 * 60_000;
const PACE_ALERT_EVERY_MS = 60 * 60_000;
/** A lease.json whose started_ms is further ahead of this clock is not trusted as "a newer instance". */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');
const HOUR_RE = /^\d{10}$/;

/** A restore problem that must stop the boot (exit 4). Messages never contain secrets. */
export class CloudSyncError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CloudSyncError';
    this.exitCode = 4;
  }
}

/**
 * The managed files of one feed. `remote` is relative to the bucket prefix.
 * @param {{dbFile: string, stateFile: string, bootstrapFile?: string|null}} o
 */
export function cloudFiles({ dbFile, stateFile, bootstrapFile = null }) {
  const out = {
    db: { kind: 'db', local: dbFile, name: path.basename(dbFile), remote: `db/${path.basename(dbFile)}.gz` },
    state: { kind: 'state', local: stateFile, name: path.basename(stateFile), remote: `state/${path.basename(stateFile)}.gz` },
  };
  if (bootstrapFile) out.bootstrap = { kind: 'bootstrap', local: bootstrapFile, name: path.basename(bootstrapFile), remote: BOOTSTRAP_REMOTE };
  return out;
}

/** UTC hour key YYYYMMDDHH. */
export function hourKey(ms) {
  return new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, '');
}

/** UTC month key YYYYMM. */
export function monthKey(ms) {
  return new Date(ms).toISOString().slice(0, 7).replace('-', '');
}

/** The fraction of the UTC calendar month `ms` falls in that has passed (0..1). */
export function monthFraction(ms) {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.min(1, Math.max(0, (ms - start) / (end - start)));
}

const shortId = (id) => String(id ?? '').slice(0, 8);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

/** Non-empty regular file? */
function present(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Write `bytes` to `file` atomically: tmp + fsync + rename (owner-only mode). */
export async function writeAtomic(file, bytes) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.cloud-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fsp.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Is `bytes` plausibly the file `kind` claims to be? → null or the reason. */
function invalid(kind, bytes) {
  if (kind === 'db') return bytes.length >= 512 && bytes.subarray(0, 16).equals(SQLITE_MAGIC) ? null : 'not a SQLite database';
  if (kind === 'state') {
    try {
      const obj = JSON.parse(bytes.toString('utf8'));
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? null : 'not a JSON object';
    } catch {
      return 'not valid JSON';
    }
  }
  if (kind === 'bootstrap') return bytes.length > 0 && bytes.length <= 256 ? null : 'unexpected size';
  return null;
}

/** lease.json bytes → the lease object, or null (absent or unreadable). */
export function parseLease(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(Buffer.from(raw).toString('utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.instance === 'string' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Download every managed file that is missing locally (main.js, BEFORE the DB is opened and the state is loaded).
 * A file present locally is kept (a host with a persistent disk; it is the newer copy).
 * @param {object} o
 * @param {ReturnType<import('./cloudstore.js').createCloudStore>} o.store
 * @param {ReturnType<typeof cloudFiles>} o.files
 * @param {boolean} [o.allowFresh]  CLOUD_ALLOW_FRESH=1: start empty even though the bucket shows a previous deployment
 * @param {(line: string) => void} [o.log]
 * @returns {Promise<{restored: string[], missing: string[], kept: string[], fresh: boolean, lease: object|null}>}
 *   `lease` is the previous owner's lease.json (journal seq floor, egress meter), or null
 * @throws {CloudSyncError} on any failure other than "not found", and on "not found" in a bucket already in use
 */
export async function restoreFromCloud({ store, files, allowFresh = false, log = () => {} }) {
  const found = []; // [{f, bytes}] downloaded and checked; written only once the whole restore is accepted
  const missing = [];
  const kept = [];
  const refuse = (what, err) => new CloudSyncError(`cloud restore: cannot download ${what} (${err?.message || err}). Refusing to start: ` +
    'an empty garden would later overwrite the cloud copy. Check SUPABASE_URL, the service key and the Supabase status; the service retries on its next restart');
  for (const f of Object.values(files)) {
    if (present(f.local)) {
      kept.push(f.name);
      continue;
    }
    let gz;
    try {
      gz = await store.download(f.remote);
    } catch (err) {
      throw refuse(f.remote, err);
    }
    if (gz === null) {
      missing.push(f);
      continue;
    }
    let bytes = gz;
    if (f.remote.endsWith('.gz')) {
      try {
        bytes = await gunzip(gz);
      } catch {
        throw new CloudSyncError(`cloud restore: ${f.remote} is not a valid gzip file. Restore an older copy from ${HISTORY_DIR}/ (deploy/render/README.md)`);
      }
    }
    const why = invalid(f.kind, bytes);
    if (why) throw new CloudSyncError(`cloud restore: ${f.remote} is ${why}. Restore an older copy from ${HISTORY_DIR}/ (deploy/render/README.md)`);
    found.push({ f, bytes });
  }
  const restored = found.map(({ f }) => f.name);

  let lease = null;
  try {
    lease = parseLease(await store.download(LEASE_PATH));
  } catch (err) {
    throw refuse(LEASE_PATH, err);
  }

  // A DB or state that is "not found" in a bucket that already served a deployment: a spurious answer (or an operator
  // mid-restore) must never start an empty garden whose first sync would overwrite the good copy.
  const core = missing.filter((f) => f.kind === 'db' || f.kind === 'state');
  if (core.length) {
    let evidence = null;
    if (lease?.synced === true) evidence = `${LEASE_PATH} says a database was synced`;
    else if (restored.length) evidence = `${restored.join(', ')} ${restored.length > 1 ? 'are' : 'is'} in the bucket`;
    else {
      let hours = [];
      try {
        hours = (await store.list(HISTORY_DIR)).filter((e) => e.folder && HOUR_RE.test(e.name));
      } catch (err) {
        throw refuse(`${HISTORY_DIR}/ (listing)`, err);
      }
      if (hours.length) evidence = `${HISTORY_DIR}/ has ${hours.length} hour(s)`;
    }
    const names = core.map((f) => f.remote).join(', ');
    if (evidence && !allowFresh) {
      throw new CloudSyncError(`cloud restore: ${names} not found although the bucket was in use (${evidence}). Refusing to start with an ` +
        `empty ${core.map((f) => f.name).join(' and ')}: restore the file(s) from ${HISTORY_DIR}/ (deploy/render/README.md section 5), ` +
        'or set CLOUD_ALLOW_FRESH=1 for ONE boot to start over on purpose');
    }
    if (evidence) log(`[cloud] CLOUD_ALLOW_FRESH=1: starting without ${names} although the bucket was in use (${evidence}); remove the variable again`);
  }

  // Accepted: write every downloaded file (atomically).
  for (const { f, bytes } of found) {
    if (f.kind === 'db') {
      // A stale WAL next to a restored DB would be replayed into it: never keep one.
      for (const ext of ['-wal', '-shm', '-journal']) await fsp.rm(`${f.local}${ext}`, { force: true });
    }
    await writeAtomic(f.local, bytes);
  }

  const missingNames = missing.map((f) => f.name);
  const fresh = restored.length === 0 && kept.length === 0;
  if (fresh) log('[cloud] the bucket has no saved data yet (first boot): starting fresh');
  else if (restored.length) log(`[cloud] restored ${restored.join(', ')} from the bucket${missingNames.length ? ` (not in the bucket: ${missingNames.join(', ')})` : ''}`);
  return { restored, missing: missingNames, kept, fresh, lease };
}

/**
 * Snapshot the DB into `tmp` → bytes. The open DB: an online backup (consistent while it is being written). A closed
 * DB (the shutdown sync runs after the checkpoint + close): the file itself when no WAL is left, else a backup
 * through a short-lived connection.
 */
async function snapshotDb(db, file, tmp) {
  if (db && !db.closed) {
    await backupDb(db, tmp);
    return fsp.readFile(tmp);
  }
  let walBytes = 0;
  try {
    walBytes = fs.statSync(`${file}-wal`).size;
  } catch {
    walBytes = 0;
  }
  if (walBytes === 0) return fsp.readFile(file);
  const handle = new DatabaseSync(file);
  try {
    await fsp.rm(tmp, { force: true });
    await sqliteBackup(handle, tmp);
  } finally {
    handle.close();
  }
  return fsp.readFile(tmp);
}

/** Thrown inside a sync when the lease turned out to belong to another instance (the run ends as a standby skip). */
class LeaseMoved extends Error {}

/**
 * Start the periodic sync. Never throws: failures are logged and kept in status(). Call start() after the server
 * listens (it takes the lease and runs the first sync).
 * @param {object} o
 * @param {ReturnType<import('./cloudstore.js').createCloudStore>} o.store
 * @param {import('./db/db.js').Db} o.db
 * @param {ReturnType<typeof cloudFiles>} o.files
 * @param {number} [o.intervalMs]        CLOUD_SYNC_SECONDS × 1000 (60 s)
 * @param {number} [o.stateEveryMs]      (2 h)
 * @param {number} [o.historyKeep]       (48)
 * @param {number} [o.egressBudgetBytes] monthly upload budget (3 GiB)
 * @param {number|null} [o.staleMs]      a standby takes over when lease.json stays unchanged this long (3 intervals + 1 min)
 * @param {number|null} [o.graceMs]      after a takeover, the first full upload waits this long (store.maxCallMs)
 * @param {() => boolean} [o.adminExists]
 * @param {boolean} [o.bootstrapConfigured]  ADMIN_BOOTSTRAP_CODE is set (never upload a generated file then)
 * @param {() => number|null} [o.seq]    the journal's last seq (written into lease.json: the next boot continues past it)
 * @param {string} [o.instance]          (random)
 * @param {string} [o.tmpDir]            where DB snapshots are made (default: beside the DB)
 * @param {(db: object, file: string, tmp: string) => Promise<Buffer>} [o.snapshot]  tests: the DB copy (online backup)
 * @param {() => number} [o.now]
 * @param {(line: string) => void} [o.log]
 */
export function startCloudSync({
  store, db, files, intervalMs = 60_000, stateEveryMs = STATE_EVERY_MS, historyKeep = HISTORY_KEEP,
  egressBudgetBytes = EGRESS_BUDGET_BYTES, staleMs = null, graceMs = null, adminExists = () => false,
  bootstrapConfigured = false, seq = () => null, instance = crypto.randomUUID(), tmpDir = null, snapshot = snapshotDb,
  now = Date.now, log = () => {},
} = {}) {
  const snapDir = tmpDir ?? path.dirname(files.db.local);
  const snapFile = path.join(snapDir, `.cloud-snapshot-${process.pid}.db`);
  const bootMs = now(); // this instance's place in the deploy order (lease.started_ms)
  let lease = 'pending'; // pending → owned ⇄ standby
  let leaseOther = null;
  let standbySinceMs = null;
  let lastStandbyAlertMs = null;
  let watch = { key: null, sinceMs: 0 }; // standby: the owner's lease.json content and since when it is unchanged
  let leaseMisses = 0;
  let lineageDueMs = null; // after a takeover: the first full upload waits until then
  let synced = false; // a DB copy of this deployment exists in the bucket (lease.json `synced`)
  let timer = null;
  let stopped = false;
  let chain = Promise.resolve();
  let inFlight = 0;
  let lastChanges = null;
  let lastDbUploadMs = -Infinity;
  let lastStateSig = null;
  let lastStateUploadMs = -Infinity;
  let lastHistoryHour = null;
  let bootstrapRemote = 'unknown'; // unknown | uploaded | absent
  let bucketPublic = false;
  let lastPublicAlertMs = -Infinity;
  let failStreak = 0;
  let lastFailLogMs = -Infinity;
  let lastPaceAlertMs = -Infinity;
  let dbHeldSinceMs = null;
  const meter = { month: monthKey(bootMs), bytes: 0 };
  const st = {
    last_sync_ms: null, last_ok_ms: null, last_error: null, last_error_ms: null, failures: 0, uploads: 0,
    bytes_uploaded: 0, db_bytes: null, state_bytes: null, db_uploaded_ms: null, state_uploaded_ms: null, held: 0,
  };

  function dbChanges() {
    if (!db || db.closed) return null;
    try {
      return Number(db.prepare('SELECT total_changes() AS n').get().n);
    } catch {
      return null;
    }
  }

  /** Count `bytes` (+ the request overhead) against this month's egress. */
  function count(bytes) {
    const m = monthKey(now());
    if (m !== meter.month) {
      meter.month = m;
      meter.bytes = 0;
    }
    meter.bytes += bytes + REQUEST_OVERHEAD_BYTES;
  }

  /** Continue the month's meter from another instance's lease (the larger count wins). */
  function adoptMeter(other) {
    if (other && other.month === monthKey(now()) && Number.isFinite(other.month_bytes) && other.month_bytes > meter.bytes) {
      meter.month = other.month;
      meter.bytes = other.month_bytes;
    }
  }

  function projected(t = now()) {
    const f = monthFraction(t);
    return f >= 0.01 ? Math.round(meter.bytes / f) : null;
  }

  /** Has the month gone past the budget's straight pace (status)? */
  function overPace(t) {
    return meter.bytes > egressBudgetBytes * monthFraction(t);
  }

  async function readLease() {
    count(0);
    const raw = await store.download(LEASE_PATH);
    return { raw, obj: parseLease(raw) };
  }

  async function put(remote, bytes, contentType) {
    await store.upload(remote, bytes, { contentType });
    count(bytes.length);
    st.uploads += 1;
    st.bytes_uploaded += bytes.length;
  }

  function leaseBody() {
    let s = null;
    try {
      s = seq();
    } catch {
      s = null;
    }
    return Buffer.from(JSON.stringify({
      v: 2, instance, started_ms: bootMs, renewed_ms: now(), host: os.hostname().slice(0, 64),
      interval_s: Math.round(intervalMs / 1000), seq: Number.isSafeInteger(s) ? s : null,
      month: meter.month, month_bytes: meter.bytes, synced,
    }));
  }

  async function writeLease() {
    const body = leaseBody();
    await store.upload(LEASE_PATH, body, { contentType: 'application/json' });
    count(body.length);
  }

  function describe() {
    const d = store.describe?.() ?? {};
    return `bucket "${d.bucket ?? '?'}"${d.prefix ? ` prefix "${d.prefix}"` : ''}`;
  }

  /** The largest object this deployment uploads, for the takeover grace. */
  function largestBytes() {
    return Math.max(st.db_bytes ?? 0, st.state_bytes ?? 0, sizeOf(files.db.local), sizeOf(files.state.local));
  }

  /** Take (or retake) the lease. `cur` is what lease.json held. */
  async function acquire(cur, why) {
    adoptMeter(cur);
    if (cur?.synced === true) synced = true;
    const takeover = Boolean(cur && cur.instance !== instance);
    await writeLease();
    lease = 'owned';
    leaseOther = null;
    leaseMisses = 0;
    standbySinceMs = null;
    lastStandbyAlertMs = null;
    // Every (re)acquisition is followed by a FULL upload of this instance's lineage: at once, or — after a takeover —
    // once the previous owner's last upload can no longer land.
    if (takeover) {
      const grace = graceMs ?? Math.max(intervalMs, store.maxCallMs?.(largestBytes()) ?? 60_000) + 5_000;
      lineageDueMs = now() + grace;
      log(`[cloud] this instance (${shortId(instance)}) took the lease from ${shortId(cur.instance)} (${why}); ` +
        `first full upload in ${Math.round(grace / 1000)} s, then every ${Math.round(intervalMs / 1000)} s to ${describe()}`);
    } else {
      lineageDueMs = now();
      log(`[cloud] this instance (${shortId(instance)}) holds the lease (${why}): syncing ${files.db.name} every ${Math.round(intervalMs / 1000)} s to ${describe()}`);
    }
  }

  function standby(cur) {
    const was = lease;
    lease = 'standby';
    leaseOther = cur?.instance ?? null;
    if (standbySinceMs === null) standbySinceMs = now();
    watch = { key: leaseKey(cur), sinceMs: now() };
    if (was !== 'standby') {
      log(`[cloud] instance ${shortId(leaseOther)} holds the lease: this instance (${shortId(instance)}) stops uploading and stands by ` +
        '(it takes over if that instance stops renewing the lease)');
    }
  }

  function leaseKey(cur) {
    return cur ? `${cur.instance}|${cur.started_ms}|${cur.renewed_ms}` : 'none';
  }

  /** Standby: has the owner's lease.json stayed unchanged long enough (on THIS clock) to call it dead? */
  function ownerStale(cur) {
    const key = leaseKey(cur);
    const t = now();
    if (watch.key !== key) {
      watch = { key, sinceMs: t };
      return false;
    }
    const theirs = Number(cur?.interval_s) > 0 ? Number(cur.interval_s) * 1000 : 0;
    const limit = staleMs ?? 3 * Math.max(intervalMs, theirs) + 60_000;
    return t - watch.sinceMs >= limit;
  }

  function alertStandby() {
    const t = now();
    if (standbySinceMs === null || t - standbySinceMs < STANDBY_ALERT_MS) return;
    if (lastStandbyAlertMs !== null && t - lastStandbyAlertMs < STANDBY_ALERT_MS) return;
    lastStandbyAlertMs = t;
    log(`[cloud] ALERT standby for ${Math.round((t - standbySinceMs) / 60_000)} min: instance ${shortId(leaseOther)} keeps renewing the lease, ` +
      'so THIS instance uploads nothing. Two instances share the bucket? (deploy/render/README.md section 8)');
  }

  /** Re-read the lease right before an upload; another owner → LeaseMoved (the run ends, this instance stands by). */
  async function ensureOwner() {
    const { obj } = await readLease();
    if (obj && obj.instance !== instance) {
      standby(obj);
      throw new LeaseMoved();
    }
  }

  async function bootstrapHousekeeping() {
    if (!files.bootstrap) return;
    let admin = false;
    try {
      admin = Boolean(adminExists());
    } catch {
      admin = false;
    }
    if (admin || bootstrapConfigured) {
      if (bootstrapRemote === 'absent') return;
      await store.remove([BOOTSTRAP_REMOTE]);
      count(0);
      if (bootstrapRemote === 'uploaded') log('[cloud] an admin exists: deleted the admin bootstrap code from the bucket');
      bootstrapRemote = 'absent';
      return;
    }
    if (bootstrapRemote === 'uploaded' || !present(files.bootstrap.local)) return;
    await put(BOOTSTRAP_REMOTE, await fsp.readFile(files.bootstrap.local), 'text/plain; charset=utf-8');
    bootstrapRemote = 'uploaded';
    log(`[cloud] no admin yet: the admin bootstrap code is in the PRIVATE bucket at ${store.describe?.().prefix ?? ''}${BOOTSTRAP_REMOTE} ` +
      '(Supabase dashboard → Storage); sign up with it to become admin');
  }

  async function pruneHistory() {
    count(0);
    const hours = (await store.list(HISTORY_DIR)).filter((e) => e.folder && HOUR_RE.test(e.name)).map((e) => e.name).sort();
    const drop = hours.slice(0, Math.max(0, hours.length - historyKeep));
    for (const h of drop) {
      count(0);
      const inside = (await store.list(`${HISTORY_DIR}/${h}`)).filter((e) => !e.folder).map((e) => `${HISTORY_DIR}/${h}/${e.name}`);
      if (inside.length) {
        await store.remove(inside);
        count(0);
      }
    }
    return drop.length;
  }

  /** The bucket must still be private (re-checked hourly, and every sync while it is public). → true when private */
  async function bucketPrivate() {
    count(0);
    const b = await store.getBucket();
    if (!b) throw new Error(`the bucket is gone (${describe()})`);
    const t = now();
    if (b.public) {
      if (!bucketPublic || t - lastPublicAlertMs >= FAIL_LOG_EVERY_MS) {
        lastPublicAlertMs = t;
        log(`[cloud] ALERT ${describe()} is PUBLIC: uploads are stopped until it is private again (Supabase → Storage → bucket → Edit)`);
      }
      bucketPublic = true;
      return false;
    }
    if (bucketPublic) log(`[cloud] ${describe()} is private again: uploads resume`);
    bucketPublic = false;
    return true;
  }

  /** One sync. Throws on failure (the caller records it). */
  async function run(reason, callerForce) {
    let force = callerForce;

    // ---- the lease
    const { obj: cur } = await readLease();
    if (lease === 'pending') {
      const newer = cur && cur.instance !== instance && Number(cur.started_ms) > bootMs && Number(cur.started_ms) <= now() + FUTURE_TOLERANCE_MS;
      if (newer) {
        standby(cur);
        return { ok: false, skipped: 'lease_standby', uploaded: [] };
      }
      await acquire(cur, cur ? 'deploy' : 'first boot');
    } else if (lease === 'standby') {
      if (cur && cur.instance === instance) {
        await acquire(cur, 'lease names this instance');
      } else if (ownerStale(cur)) {
        await acquire(cur, cur ? `instance ${shortId(cur.instance)} stopped renewing` : 'lease.json stayed missing');
      } else {
        alertStandby();
        return { ok: false, skipped: 'lease_standby', uploaded: [] };
      }
    } else if (!cur) {
      leaseMisses += 1;
      if (leaseMisses < 2) throw new Error(`${LEASE_PATH} was not found; retrying before writing it again`);
      log(`[cloud] ${LEASE_PATH} was missing twice in a row: writing it again (this instance keeps the lease)`);
      await writeLease();
      leaseMisses = 0;
    } else if (cur.instance !== instance) {
      standby(cur);
      return { ok: false, skipped: 'lease_standby', uploaded: [] };
    } else {
      leaseMisses = 0;
    }

    // ---- after taking the lease: a full upload; after a TAKEOVER nothing but the lease until the previous owner's
    // last upload can no longer land
    if (lineageDueMs !== null) {
      if (!callerForce && now() < lineageDueMs) {
        await writeLease();
        return { ok: true, uploaded: [], deferred: true };
      }
      lineageDueMs = null;
      force = true;
    }

    if (bucketPublic && !(await bucketPrivate())) return { ok: false, skipped: 'bucket_public', uploaded: [] };
    const t = now();
    const hour = hourKey(t);
    const history = hour !== lastHistoryHour;
    if (history && !bucketPublic && !(await bucketPrivate())) return { ok: false, skipped: 'bucket_public', uploaded: [] };
    const uploaded = [];
    const held = []; // uploads the egress pace postpones this time
    // A non-forced upload goes only while the month stays within the budget's pace (5 % slack); the DB goes first.
    const allowance = egressBudgetBytes * (monthFraction(t) + PACE_SLACK);
    const fits = (estimate) => force || meter.bytes + estimate <= allowance;

    // ---- the DB: only when it changed (total_changes is read BEFORE the snapshot: later writes are caught next time)
    const changes = dbChanges();
    let dbDue = force || changes === null || changes !== lastChanges;
    if (dbDue && !fits(st.db_bytes ?? 0)) {
      dbDue = false;
      held.push(files.db.remote);
    }
    if (dbDue) {
      let dbGz;
      try {
        dbGz = await gzip(await snapshot(db, files.db.local, snapFile));
      } finally {
        await fsp.rm(snapFile, { force: true }).catch(() => {});
        await fsp.rm(`${snapFile}.partial`, { force: true }).catch(() => {});
      }
      await ensureOwner();
      await put(files.db.remote, dbGz, 'application/gzip');
      lastChanges = changes;
      lastDbUploadMs = t;
      synced = true;
      st.db_bytes = dbGz.length;
      st.db_uploaded_ms = now();
      uploaded.push(files.db.remote);
    }

    // ---- the engine state: every 2 h when it changed, and always at a forced sync
    let sig = null;
    try {
      const s = fs.statSync(files.state.local);
      sig = `${s.size}:${s.mtimeMs}`;
    } catch {
      sig = null;
    }
    const sinceState = t - lastStateUploadMs;
    let stateDue = false;
    if (sig !== null) {
      if (force) stateDue = true;
      else if (sig !== lastStateSig && sinceState >= STATE_MAX_AGE_MS) stateDue = true; // even over the pace
      else if (sig !== lastStateSig && sinceState >= stateEveryMs) {
        if (fits(st.state_bytes ?? 0)) stateDue = true;
        else held.push(files.state.remote);
      }
    }
    if (stateDue) {
      let raw = null;
      try {
        raw = await fsp.readFile(files.state.local);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      // saveState() replaces the file atomically, so a read sees a whole file; a cheap shape check is enough here.
      if (raw && raw.length > 1 && raw[0] === 0x7b) {
        const stateGz = await gzip(raw);
        await ensureOwner();
        await put(files.state.remote, stateGz, 'application/gzip');
        lastStateSig = sig;
        lastStateUploadMs = t;
        st.state_bytes = stateGz.length;
        st.state_uploaded_ms = now();
        uploaded.push(files.state.remote);
      }
    }

    if (held.length) st.held += 1;
    if (!held.includes(files.db.remote)) dbHeldSinceMs = null;
    else if (dbHeldSinceMs === null) dbHeldSinceMs = t;
    // Holding the DB a few minutes is the pacing working; for longer, the operator should know (hourly).
    if (dbHeldSinceMs !== null && t - dbHeldSinceMs >= DB_HELD_ALERT_MS && t - lastPaceAlertMs >= PACE_ALERT_EVERY_MS) {
      lastPaceAlertMs = t;
      log(`[cloud] ALERT egress: ${mb(meter.bytes)} sent this month, on pace for ${mb(projected(t) ?? meter.bytes)} ` +
        `against a ${mb(egressBudgetBytes)} budget: the bucket copy of the database is ${Math.round((t - dbHeldSinceMs) / 60_000)} min ` +
        'behind (pacing; deploy/render/README.md section 2)');
    }

    // ---- hourly history: server-side copies of the newest db/ and state/ objects (no egress), then prune
    if (history && lastDbUploadMs > -Infinity) {
      await store.copy(files.db.remote, `${HISTORY_DIR}/${hour}/${files.db.name}.gz`);
      count(0);
      if (lastStateUploadMs > -Infinity) {
        await store.copy(files.state.remote, `${HISTORY_DIR}/${hour}/${files.state.name}.gz`);
        count(0);
      }
      lastHistoryHour = hour;
      uploaded.push(`${HISTORY_DIR}/${hour}/`);
      const pruned = await pruneHistory();
      if (pruned) log(`[cloud] history ${hour} saved; pruned ${pruned} old hour(s) (keeping ${historyKeep})`);
    }

    await bootstrapHousekeeping();
    // The heartbeat (and the month's meter, the journal seq) — only while the lease is still ours: an instance whose
    // run outlasted a takeover must never write its name back over the new owner's.
    await ensureOwner();
    await writeLease();
    return { ok: true, uploaded };
  }

  function recordFailure(reason, err) {
    const msg = String(err?.message || err).slice(0, 300);
    failStreak += 1;
    st.failures += 1;
    st.last_error = msg;
    st.last_error_ms = now();
    if (failStreak === 1 || now() - lastFailLogMs >= FAIL_LOG_EVERY_MS) {
      lastFailLogMs = now();
      log(`[cloud] ALERT sync failed (${reason}): ${msg}${failStreak > 1 ? ` (${failStreak} failures in a row)` : ''}`);
    }
  }

  /**
   * Run a sync now (serialized after any running one). Never throws.
   * @param {string} reason
   * @param {{force?: boolean, deadlineMs?: number|null}} [opts]  deadline → resolves {ok:false, timedOut:true} in time
   * @returns {Promise<{ok: boolean, uploaded?: string[], skipped?: string, deferred?: boolean, error?: string, timedOut?: boolean}>}
   */
  function syncNow(reason = 'manual', { force = false, deadlineMs = null } = {}) {
    inFlight += 1;
    const job = chain.then(async () => {
      st.last_sync_ms = now();
      try {
        const r = await run(reason, force);
        if (r.ok) {
          st.last_ok_ms = now();
          if (failStreak > 0) log(`[cloud] sync recovered after ${failStreak} failure(s)`);
          failStreak = 0;
        }
        return r;
      } catch (err) {
        if (err instanceof LeaseMoved) return { ok: false, skipped: 'lease_standby', uploaded: [] };
        recordFailure(reason, err);
        return { ok: false, error: st.last_error };
      } finally {
        inFlight -= 1;
      }
    });
    chain = job.catch(() => {});
    if (!deadlineMs) return job;
    let to;
    const timeout = new Promise((resolve) => {
      to = setTimeout(() => resolve({ ok: false, timedOut: true }), deadlineMs);
      to.unref?.();
    });
    return Promise.race([job, timeout]).finally(() => clearTimeout(to));
  }

  return {
    /** Take the lease, run the first sync, start the interval. Resolves when the first sync is done. */
    async start() {
      const first = await syncNow('start');
      if (!stopped) {
        timer = setInterval(() => {
          if (!stopped && inFlight === 0) syncNow('interval');
        }, intervalMs);
        timer.unref?.();
      }
      return first;
    },
    syncNow,
    /** Stop the interval (syncNow still works: the shutdown sync). */
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Resolves when no sync is running (bounded by `maxMs`). */
    async idle(maxMs = 10_000) {
      let to;
      await Promise.race([chain, new Promise((r) => { to = setTimeout(r, maxMs); to.unref?.(); })]);
      clearTimeout(to);
    },
    /** admin_status.cloud (never the key; the Storage host, bucket and prefix are shown to admins). */
    status() {
      const t = now();
      return {
        enabled: true,
        ...(store.describe?.() ?? {}),
        interval_s: Math.round(intervalMs / 1000),
        instance: shortId(instance),
        lease,
        lease_owner: lease === 'owned',
        lease_other: leaseOther ? shortId(leaseOther) : null,
        standby_since_ms: standbySinceMs,
        first_full_upload_ms: lineageDueMs,
        last_history_hour: lastHistoryHour,
        bootstrap_in_bucket: bootstrapRemote === 'uploaded',
        bucket_public: bucketPublic,
        month: meter.month,
        month_bytes: meter.bytes,
        month_projected_bytes: projected(t),
        egress_budget_bytes: egressBudgetBytes,
        db_held_since_ms: dbHeldSinceMs,
        over_pace: overPace(t),
        ...st,
      };
    },
  };
}

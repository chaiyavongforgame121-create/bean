// server/db/backup.js — online backups of the accounts-mode DB (PLATFORM.md §10.5).
//
// `backupDb()` uses node:sqlite's asynchronous, page-stepped `backup()` (Node >= 22.16): it copies `rate` pages per
// step and yields to the event loop between steps, so a backup of a large DB never stalls ticks or SSE.
// `Backups` schedules them: every BACKUP_INTERVAL_H, one at the first boot of each UTC day, and on demand
// (`admin_backup`, at most once per 10 min). Each backup also copies the feed's state JSON beside it. The newest
// BACKUP_KEEP are kept. (The synchronous `VACUUM INTO` is used only by migrate.js, before serving.)
//
// What a backup means for wiped keys: a backup holds sealed credentials as they were at backup time; a key wiped
// later stays (encrypted) in up to BACKUP_KEEP × BACKUP_INTERVAL_H of backups. The UI states this (§9.2, §9.3).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { backup as sqliteBackup } from 'node:sqlite';

import { ApiError } from '../live.js';
import { utcStamp } from './migrate.js';

const HOUR_MS = 3_600_000;
const MANUAL_MIN_INTERVAL_MS = 10 * 60_000; // admin_backup: at most once per 10 min (global, §4.5)
const NAME_RE = /^bean-(\d{8}T\d{4}Z)(?:-\d+)?\.db$/;

/**
 * One online backup of `db` into `file` (a new file; an existing one is replaced).
 * @param {import('./db.js').Db} db
 * @param {string} file
 * @param {{rate?: number}} [opts]  pages per step (default 64)
 * @returns {Promise<{bytes: number, ms: number, pages: number}>}
 */
export async function backupDb(db, file, { rate = 64 } = {}) {
  if (!Number.isInteger(rate) || rate < 1) throw new TypeError('backupDb: rate must be a positive integer');
  const started = performance.now();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.partial`;
  await fsp.rm(tmp, { force: true });
  let pages;
  try {
    pages = await sqliteBackup(db.handle, tmp, { rate });
    await fsp.rename(tmp, file); // never leave a half-written file under the final name
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  try {
    await fsp.chmod(file, 0o600);
  } catch {
    // Best effort (Windows); /data is owner-only in the image.
  }
  const { size } = await fsp.stat(file);
  return { bytes: size, ms: Math.round(performance.now() - started), pages };
}

export class Backups {
  /**
   * @param {object} opts
   * @param {import('./db.js').Db} opts.db
   * @param {string} opts.dir           <data>/backups
   * @param {string|null} [opts.stateFile]  the feed's state JSON, copied beside each backup when present
   * @param {number} [opts.intervalH]   BACKUP_INTERVAL_H (6)
   * @param {number} [opts.keep]        BACKUP_KEEP (28)
   * @param {number} [opts.rate]        pages per step (64)
   * @param {() => number} [opts.now]
   * @param {(line: string) => void} [opts.log]
   */
  constructor({ db, dir, stateFile = null, intervalH = 6, keep = 28, rate = 64, now = Date.now, log = () => {} }) {
    this.db = db;
    this.dir = dir;
    this.stateFile = stateFile;
    this.intervalMs = intervalH * HOUR_MS;
    this.keep = keep;
    this.rate = rate;
    this.now = now;
    this.log = log;
    this.timer = null;
    this.running = null; // the in-flight backup promise (one at a time)
    this.lastManualMs = -Infinity;
    this.lastResult = this.#newestOnDisk();
  }

  /** {ms, file} of the newest backup (from disk at construction, then from runs), or nulls. */
  last() {
    return { last_backup_ms: this.lastResult?.ms ?? null, last_backup_file: this.lastResult?.file ?? null };
  }

  /** Start the schedule: a backup now when none exists for today (UTC), then every interval. */
  start() {
    if (this.timer) return;
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const lastDay = this.lastResult ? new Date(this.lastResult.ms).toISOString().slice(0, 10) : null;
    if (lastDay !== today) this.#scheduled('first boot of the day');
    this.timer = setInterval(() => this.#scheduled('interval'), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves when the in-flight backup (if any) is done; used by shutdown before db.close(). */
  async idle() {
    if (this.running) await this.running.catch(() => {});
  }

  /**
   * Run a backup now. `manual: true` (admin_backup) is limited to one per 10 min → 429 rate_limited.
   * @returns {Promise<{file: string, bytes: number, ms: number}>}
   */
  async runNow({ manual = false } = {}) {
    if (manual) {
      const wait = this.lastManualMs + MANUAL_MIN_INTERVAL_MS - this.now();
      if (wait > 0) {
        const retry = Math.ceil(wait / 1000);
        throw Object.assign(new ApiError(429, 'a backup was taken less than 10 minutes ago', 'rate_limited', { retry_after_s: retry }),
          { headers: { 'Retry-After': String(retry) } });
      }
      this.lastManualMs = this.now();
    }
    if (this.running) return this.running;
    this.running = this.#run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async #run() {
    const at = this.now();
    let file = path.join(this.dir, `bean-${utcStamp(at)}.db`);
    for (let i = 2; fs.existsSync(file); i += 1) file = path.join(this.dir, `bean-${utcStamp(at)}-${i}.db`);
    const { bytes, ms } = await backupDb(this.db, file, { rate: this.rate });
    if (this.stateFile) {
      try {
        await fsp.copyFile(this.stateFile, file.replace(/\.db$/, '.state.json'));
      } catch (err) {
        if (err.code !== 'ENOENT') this.log(`[backup] state copy failed (${err.code ?? err.name})`);
      }
    }
    this.lastResult = { ms: at, file: path.basename(file) };
    await this.#prune();
    this.log(`[backup] ${path.basename(file)} (${bytes} bytes, ${ms} ms)`);
    return { file: path.basename(file), bytes, ms };
  }

  #scheduled(why) {
    this.runNow().catch((err) => this.log(`[backup] ${why} backup failed (${err.code ?? err.name})`));
  }

  /** Keep the newest `keep` backups (and their state copies); pre-migration backups are never pruned here. */
  async #prune() {
    const names = this.#listBackups();
    for (const name of names.slice(0, Math.max(0, names.length - this.keep))) {
      await fsp.rm(path.join(this.dir, name), { force: true });
      await fsp.rm(path.join(this.dir, name.replace(/\.db$/, '.state.json')), { force: true });
    }
  }

  /** Backup file names, oldest first. */
  #listBackups() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => NAME_RE.test(n));
    } catch {
      return [];
    }
    return names.sort((a, b) => {
      const ka = NAME_RE.exec(a)[1];
      const kb = NAME_RE.exec(b)[1];
      return ka === kb ? a.length - b.length || a.localeCompare(b) : ka.localeCompare(kb);
    });
  }

  #newestOnDisk() {
    const names = this.#listBackups();
    const newest = names[names.length - 1];
    if (!newest) return null;
    try {
      return { ms: fs.statSync(path.join(this.dir, newest)).mtimeMs, file: newest };
    } catch {
      return null;
    }
  }
}

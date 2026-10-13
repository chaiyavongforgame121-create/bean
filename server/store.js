// Atomic JSON persistence for the daemon state.
//
// saveState writes `<file>.<pid>.<n>.tmp`, flushes it to disk, then renames it over `<file>`. A crash
// at any point leaves either the old or the new file intact, never a half-written one.
//
// Windows notes: fs.renameSync maps to MoveFileEx(REPLACE_EXISTING), which replaces an existing file
// — but it fails with EPERM/EACCES/EBUSY while another process (antivirus, indexer, an editor) holds
// the target open. We retry a few times with a short back-off, then fall back to swapping through a
// `<file>.bak` copy. loadState reads `<file>.bak` if the main file is missing or corrupt, which covers
// a crash in the middle of that fallback swap.

import fs from 'node:fs';
import path from 'node:path';

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);
const RENAME_ATTEMPTS = 6;
let tmpCounter = 0;

/** Synchronous sleep without spinning the CPU (only used between rename retries). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write `data` to `file` and fsync it, so the rename publishes fully written bytes. */
function writeDurable(file, data) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** rename(src → dst) replacing dst, retrying transient Windows sharing errors. */
function renameReplacing(src, dst) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (err) {
      if (!RETRY_CODES.has(err.code)) throw err;
      if (attempt >= RENAME_ATTEMPTS) return swapViaBackup(src, dst, err);
      sleepSync(15 * attempt);
    }
  }
}

/**
 * Last resort when the target cannot be replaced in place: move the old file aside, move the new
 * one in, then drop the backup. If moving in fails, put the old file back and rethrow.
 */
function swapViaBackup(src, dst, cause) {
  const bak = `${dst}.bak`;
  fs.rmSync(bak, { force: true });
  if (fs.existsSync(dst)) fs.renameSync(dst, bak);
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (fs.existsSync(bak) && !fs.existsSync(dst)) fs.renameSync(bak, dst);
    err.message = `${err.message} (after ${cause.code} replacing ${dst})`;
    throw err;
  }
  fs.rmSync(bak, { force: true });
}

/**
 * Atomically save `obj` as JSON to `file` (creating the directory).
 * @returns {number} bytes written
 */
export function saveState(file, obj) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const data = JSON.stringify(obj);
  if (data === undefined) throw new TypeError('saveState: value is not JSON-serialisable');
  const tmp = `${target}.${process.pid}.${++tmpCounter}.tmp`;
  try {
    writeDurable(tmp, data);
    renameReplacing(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return Buffer.byteLength(data);
}

/** Parse one JSON file → { obj } or { error } ('missing' when it does not exist). */
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { error: err.code === 'ENOENT' ? 'missing' : err.message };
  }
  try {
    return { obj: JSON.parse(text) };
  } catch (err) {
    return { error: `corrupt JSON (${err.message})` };
  }
}

/**
 * Load JSON state saved by saveState. Never throws.
 * @param {string} file
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {any|null} the parsed value, or null when missing/corrupt (logged)
 */
export function loadState(file, { log = console.warn } = {}) {
  const target = path.resolve(file);
  const main = readJson(target);
  if (!main.error) return main.obj;

  const backup = readJson(`${target}.bak`);
  if (!backup.error) {
    log(`[store] ${target}: ${main.error}; using ${target}.bak`);
    return backup.obj;
  }
  if (main.error === 'missing') log(`[store] no saved state at ${target} (fresh start)`);
  else log(`[store] cannot load ${target}: ${main.error} — starting fresh`);
  return null;
}

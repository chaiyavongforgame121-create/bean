// server/db/db.js — the one SQLite connection of accounts mode (PLATFORM.md §3.2).
//
// None mode never opens SQLite (§2.4 rule 6). In accounts mode there is exactly ONE connection per process,
// opened here with the §3.2 PRAGMAs. All SQL takes values only through `?` bindings: `exec()` runs migration
// files and constant PRAGMA strings only, and test/db.test.js scans server/** for `prepare(` / `exec(` calls whose
// argument is built with `${…}` or `+` (the one allowlisted line is `PRAGMA user_version` in migrate.js).
//
// Everything here is synchronous (node:sqlite DatabaseSync): each call costs µs–ms on the event loop. Transactions
// therefore never span an `await` — `tx(fn)` refuses a callback that returns a promise.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** The migration files shipped with the server (§3.4). */
export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Connection PRAGMAs, in the order of §3.2 (constant strings: allowed through exec). */
const CONNECTION_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA secure_delete = ON',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA wal_autocheckpoint = 1000',
];

/** Prepared statements are cached by SQL text; the SQL set is static, so this stays small. */
const STATEMENT_CACHE_MAX = 512;

/**
 * The DB file of a feed (§3.1, §6.14 R7): real prices → bean.db, sim → bean-sim.db. Sim-priced paper positions
 * never mix with real-priced ones (GAME-DESIGN §10.1).
 */
export function dbFileFor(dataDir, feed) {
  return path.join(dataDir, feed === 'sim' ? 'bean-sim.db' : 'bean.db');
}

export class Db {
  /**
   * @param {DatabaseSync} handle
   * @param {string} file
   * @param {(line: string) => void} log
   */
  constructor(handle, file, log) {
    /** The raw node:sqlite handle: only backup.js uses it (sqlite.backup needs the DatabaseSync). */
    Object.defineProperty(this, 'handle', { value: handle, enumerable: false });
    this.file = file;
    this.log = log;
    this.statements = new Map();
    this.txDepth = 0;
    this.closed = false;
  }

  /** A cached prepared statement. Values go ONLY through `?` bindings (§3.2). */
  prepare(sql) {
    let statement = this.statements.get(sql);
    if (statement) {
      // LRU touch: re-insert at the end.
      this.statements.delete(sql);
      this.statements.set(sql, statement);
      return statement;
    }
    statement = this.handle.prepare(sql);
    this.statements.set(sql, statement);
    if (this.statements.size > STATEMENT_CACHE_MAX) {
      this.statements.delete(this.statements.keys().next().value);
    }
    return statement;
  }

  /** Migration files and constant PRAGMA strings ONLY (§3.2). Never pass user data here. */
  exec(sql) {
    this.handle.exec(sql);
  }

  /** True while a transaction (or savepoint) opened by this wrapper is running. */
  get inTransaction() {
    return this.txDepth > 0;
  }

  /**
   * Run `fn(db)` in a write transaction (`BEGIN IMMEDIATE` … `COMMIT`), rolling back when it throws.
   * Nested calls become savepoints, so a helper that uses `tx()` composes inside a caller's transaction.
   * `fn` must be synchronous: a transaction held across an `await` would block every other writer.
   * @template T
   * @param {(db: Db) => T} fn
   * @returns {T}
   */
  tx(fn) {
    if (this.txDepth > 0) return this.savepoint(fn);
    this.handle.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    let result;
    try {
      result = fn(this);
      if (result && typeof result.then === 'function') {
        throw new TypeError('db.tx(fn): fn must be synchronous (a transaction never spans an await)');
      }
    } catch (err) {
      this.txDepth = 0;
      this.#rollback();
      throw err;
    }
    try {
      this.handle.exec('COMMIT');
    } catch (err) {
      this.txDepth = 0;
      this.#rollback();
      throw err;
    }
    this.txDepth = 0;
    return result;
  }

  /**
   * Run `fn(db)` inside a SAVEPOINT (§3.5: one savepoint per garden in a flush, so one bad row rolls back only
   * that garden). Outside a transaction it opens one (`BEGIN IMMEDIATE`). The savepoint name is constant: SQLite
   * resolves RELEASE / ROLLBACK TO to the innermost savepoint of that name, so nesting is safe.
   * @template T
   * @param {(db: Db) => T} fn
   * @returns {T}
   */
  savepoint(fn) {
    if (this.txDepth === 0) return this.tx(fn);
    this.handle.exec('SAVEPOINT bean_sp');
    this.txDepth += 1;
    try {
      const result = fn(this);
      if (result && typeof result.then === 'function') {
        throw new TypeError('db.savepoint(fn): fn must be synchronous');
      }
      this.handle.exec('RELEASE bean_sp');
      return result;
    } catch (err) {
      try {
        this.handle.exec('ROLLBACK TO bean_sp');
        this.handle.exec('RELEASE bean_sp');
      } catch {
        // The outer transaction is gone (SQLite rolled it back itself); the outer tx() reports the error.
      }
      throw err;
    } finally {
      this.txDepth -= 1;
    }
  }

  /**
   * `PRAGMA wal_checkpoint(TRUNCATE)`: move the WAL into the DB file and truncate it, so overwritten credential
   * pages do not linger in bean.db-wal (§5.3 rule 9). Returns SQLite's `{busy, log, checkpointed}`.
   */
  checkpoint() {
    return { ...this.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() };
  }

  /** `SELECT 1` for /readyz (§10.4). Throws when the DB does not answer. */
  ping() {
    return this.prepare('SELECT 1 AS ok').get().ok === 1;
  }

  /** Bytes of the DB file and its WAL (admin_status.db). */
  sizes() {
    const size = (file) => {
      try {
        return fs.statSync(file).size;
      } catch {
        return 0;
      }
    };
    return { size_bytes: size(this.file), wal_bytes: size(`${this.file}-wal`) };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.handle.close();
  }

  #rollback() {
    try {
      this.handle.exec('ROLLBACK');
    } catch {
      // Already rolled back by SQLite (e.g. SQLITE_FULL); nothing more to do.
    }
  }
}

/**
 * Open (creating when missing) the accounts-mode database with the §3.2 PRAGMAs.
 * @param {object} opts
 * @param {string} opts.file   absolute path (use dbFileFor(dataDir, feed)); ':memory:' is allowed for tests
 * @param {(line: string) => void} [opts.log]
 * @returns {Db}
 */
export function openDb({ file, log = () => {} }) {
  if (typeof file !== 'string' || !file) throw new TypeError('openDb: file is required');
  const memory = file === ':memory:';
  if (!memory) fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new DatabaseSync(file, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
  try {
    for (const pragma of CONNECTION_PRAGMAS) handle.exec(pragma);
  } catch (err) {
    handle.close();
    throw err;
  }
  if (!memory) restrictMode(file);
  return new Db(handle, file, log);
}

/** The DB holds password hashes and sealed keys: owner-only (best effort; Windows ignores modes). */
function restrictMode(file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      fs.chmodSync(f, 0o600);
    } catch {
      // The -wal/-shm files may not exist yet; the directory (/data, owner node) is the real boundary.
    }
  }
}

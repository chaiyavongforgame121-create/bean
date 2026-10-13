// server/db/migrate.js — forward-only schema migrations (PLATFORM.md §3.4).
//
// Files: server/db/migrations/NNNN_name.sql, versions 1, 2, 3… with no gaps. A file is never edited after release:
// its checksum is recorded in schema_migrations and a mismatch refuses to start. At boot, migrate():
//   1. reads the applied versions;
//   2. if anything is pending and the DB is not new, takes `VACUUM INTO` backups/pre-migration-<from>-<to>-<ts>.db
//      (synchronous, before the server accepts connections — the only VACUUM INTO in the code base, §10.5);
//   3. applies each pending file in its own BEGIN IMMEDIATE transaction, records it, sets PRAGMA user_version;
//   4. on any error rolls that migration back and throws MigrationError (exitCode 3; main() exits with it).
// Data migrations that need JS (key re-seal, §5.2) are separate boot steps, not SQL migrations.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Raised for every refusal to migrate; main() exits with `exitCode` (3, §3.4). */
export class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationError';
    this.exitCode = 3;
  }
}

/**
 * sha256 hex of the migration text. Line endings are normalised to LF first so a Windows checkout (CRLF) and the
 * Linux image hash the same released file identically (a deviation from "the file text", documented in the WP1
 * notes: without it, a git autocrlf checkout alone would refuse to start).
 */
export function migrationChecksum(text) {
  return crypto.createHash('sha256').update(String(text).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * The migration files of `dir`, sorted, validated (contiguous from 1).
 * @returns {{version: number, name: string, file: string, sql: string, checksum: string}[]}
 */
export function listMigrations(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    throw new MigrationError(`cannot read the migrations directory (${err.code ?? err.message})`);
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.sql')) continue;
    const m = FILE_RE.exec(name);
    if (!m) throw new MigrationError(`bad migration file name '${name}' (expected NNNN_name.sql)`);
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    out.push({ version: Number(m[1]), name, file: path.join(dir, name), sql, checksum: migrationChecksum(sql) });
  }
  out.sort((a, b) => a.version - b.version);
  out.forEach((mig, i) => {
    if (mig.version !== i + 1) {
      throw new MigrationError(`migration versions must run 1, 2, 3… without gaps (found ${mig.name} at position ${i + 1})`);
    }
  });
  return out;
}

/** True when the database has no tables at all (a fresh file: no pre-migration backup is needed). */
function isNewDatabase(db) {
  return db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().n === 0;
}

function appliedMigrations(db) {
  const exists = db.prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!exists) return new Map();
  const rows = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
  return new Map(rows.map((r) => [r.version, r]));
}

/** UTC timestamp for backup names: 20261011T1432Z. */
export function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace(/(\d{8}T\d{4})\d{2}Z$/, '$1Z');
}

/**
 * Bring the schema up to date.
 * @param {import('./db.js').Db} db
 * @param {string} dir  migrations directory (MIGRATIONS_DIR)
 * @param {object} [opts]
 * @param {string} [opts.backupDir]  where the pre-migration backup goes (default: <db dir>/backups)
 * @param {(line: string) => void} [opts.log]
 * @param {() => number} [opts.now]
 * @returns {{from: number, to: number, backup: string|null}}
 */
export function migrate(db, dir, { backupDir = null, log = () => {}, now = Date.now } = {}) {
  const files = listMigrations(dir);
  const applied = appliedMigrations(db);

  // Every applied migration must still exist, unchanged.
  for (const [version, row] of applied) {
    const mig = files[version - 1];
    if (!mig) {
      throw new MigrationError(`the database has migration ${version} (${row.name}) that this server does not know: refusing to start (downgrade?)`);
    }
    if (mig.checksum !== row.checksum) {
      throw new MigrationError(`migration ${mig.name} was edited after it was applied (checksum mismatch): refusing to start`);
    }
  }

  const from = applied.size === 0 ? 0 : Math.max(...applied.keys());
  const pending = files.filter((m) => !applied.has(m.version));
  if (pending.length === 0) return { from, to: from, backup: null };
  const to = pending[pending.length - 1].version;

  // Backup before touching a non-empty database.
  let backup = null;
  if (!isNewDatabase(db)) {
    if (db.file === ':memory:') throw new MigrationError('cannot back up an in-memory database before migrating');
    const dirOut = backupDir ?? path.join(path.dirname(db.file), 'backups');
    fs.mkdirSync(dirOut, { recursive: true });
    backup = path.join(dirOut, `pre-migration-${from}-${to}-${utcStamp(now())}.db`);
    try {
      fs.rmSync(backup, { force: true });
      db.prepare('VACUUM INTO ?').run(backup);
    } catch (err) {
      throw new MigrationError(`pre-migration backup failed (${err.message}): refusing to migrate`);
    }
    log(`[db] pre-migration backup ${path.basename(backup)}`);
  }

  for (const mig of pending) {
    try {
      db.tx(() => {
        db.exec(mig.sql);
        db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_ms) VALUES (?, ?, ?, ?)')
          .run(mig.version, mig.name, mig.checksum, now());
        if (!Number.isInteger(mig.version) || mig.version < 1) throw new MigrationError(`bad migration version ${mig.version}`);
        db.exec(`PRAGMA user_version = ${mig.version}`); // sql-scan: allow (Number.isInteger checked above)
      });
    } catch (err) {
      if (err instanceof MigrationError) throw err;
      throw new MigrationError(`migration ${mig.name} failed and was rolled back: ${err.message}`);
    }
    log(`[db] applied migration ${mig.name}`);
  }
  return { from, to, backup };
}

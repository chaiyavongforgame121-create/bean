// server/auth/users.js — players, lockout, admin bootstrap, operator reset (PLATFORM.md §3.3, §4.1, §4.5, §4.6).
//
// Rules that make admin impossible for a stranger (§4.6 step 2):
//   * ADMIN_USERNAMES only PROMOTES users that already exist, at boot. It never grants admin at sign-up; a listed
//     name that does not exist yet can only be registered together with a valid bootstrap code (else the ordinary
//     409 username_unavailable).
//   * While no admin exists, a sign-up carrying the bootstrap code (constant-time compare) becomes admin. The code
//     comes from ADMIN_BOOTSTRAP_CODE(_FILE) or is GENERATED at boot into <data>/admin-bootstrap.txt (0600). It is
//     never printed. The file is deleted as soon as an admin exists, and admin_state.bootstrap_used is set.
//   * Deleted names go to retired_usernames in the delete transaction and can never be registered again.
// Lockout (§4.5): existing users' consecutive failures persist in users.failed_logins / locked_until_ms (a flood of
// other keys can never evict them); unknown names use the bounded UnknownNameLockouts store.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ApiError } from '../live.js';
import { canonicalUsername, lockoutKey, RESERVED_USERNAMES, assertPasswordPolicy } from './passwords.js';
import { lockoutMs, UnknownNameLockouts } from './ratelimit.js';

export const BOOTSTRAP_FILE = 'admin-bootstrap.txt';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no I/O/0/1
const CODE_LEN = 12; // 60 bits
const RESET_TTL_MS = 24 * 3_600_000;

/** A random 12-character code from an unambiguous alphabet (bootstrap and reset codes). */
export function randomCode(len = CODE_LEN) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b & 31];
  return out;
}

/** Normalise a typed code: trim, drop spaces/dashes, upper-case. */
export function normalizeCode(code) {
  return String(code ?? '').normalize('NFKC').replace(/[\s-]/g, '').toUpperCase().slice(0, 128);
}

/** Constant-time string equality (hash both sides first: equal lengths, length hidden). */
export function codesEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Constant SQL (values only through `?` bindings, §3.2). */
const SQL = Object.freeze({
  byId: `SELECT id, username, pw_hash, role, status, lang, created_ms, updated_ms, pw_changed_ms, last_login_ms,
    failed_logins, locked_until_ms, reset_hash, reset_expires_ms FROM users WHERE id = ?`,
  byName: `SELECT id, username, pw_hash, role, status, lang, created_ms, updated_ms, pw_changed_ms, last_login_ms,
    failed_logins, locked_until_ms, reset_hash, reset_expires_ms FROM users WHERE username = ?`,
  insertUser: `INSERT INTO users (username, pw_hash, role, status, lang, created_ms, updated_ms, pw_changed_ms)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
  insertGarden: `INSERT INTO gardens (user_id, epoch, season, season_started_ms, last_active_ms, account_usd, created_ms, updated_ms)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
  wipeKeys: `UPDATE credentials SET key_ct = zeroblob(32), key_iv = zeroblob(12), key_tag = zeroblob(16), updated_ms = ?
    WHERE user_id = ?`,
  bootstrapUsed: `INSERT INTO admin_state (key, value_json, updated_ms, updated_by) VALUES ('bootstrap_used', ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_ms = excluded.updated_ms, updated_by = excluded.updated_by`,
  setPassword: `UPDATE users SET pw_hash = ?, pw_changed_ms = ?, updated_ms = ?, failed_logins = 0, locked_until_ms = NULL
    WHERE id = ?`,
  inviteValid: 'SELECT 1 AS ok FROM invites WHERE code_hash = ? AND used_by IS NULL AND expires_ms > ?',
  inviteUse: 'UPDATE invites SET used_by = ?, used_ms = ? WHERE code_hash = ? AND used_by IS NULL AND expires_ms > ?',
  inviteInsert: 'INSERT INTO invites (code_hash, created_by, created_ms, expires_ms) VALUES (?, ?, ?, ?)',
  clearFailures: `UPDATE users SET failed_logins = 0, locked_until_ms = NULL
    WHERE id = ? AND (failed_logins <> 0 OR locked_until_ms IS NOT NULL)`,
});

/** The §8.2 `User` shape sent to clients. */
export function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role, created_ms: user.created_ms, lang: user.lang ?? null };
}

export class Users {
  /**
   * @param {import('../db/db.js').Db} db
   * @param {object} opts
   * @param {import('./passwords.js').PasswordHasher} opts.hasher
   * @param {UnknownNameLockouts} [opts.lockouts]     unknown-name failure store
   * @param {string[]} [opts.adminUsernames]          ADMIN_USERNAMES (canonical)
   * @param {() => number} [opts.accountUsd]          the current paper start for new gardens (caps.paper.account_usd)
   * @param {() => number} [opts.now]
   * @param {(line: string) => void} [opts.log]
   */
  constructor(db, { hasher, lockouts = null, adminUsernames = [], accountUsd = () => 10_000, now = Date.now, log = () => {} }) {
    if (!hasher) throw new TypeError('Users: hasher is required');
    this.db = db;
    this.hasher = hasher;
    this.now = now;
    this.lockouts = lockouts ?? new UnknownNameLockouts({ now });
    this.adminUsernames = new Set(adminUsernames.map((n) => canonicalUsername(n)).filter(Boolean));
    this.accountUsd = accountUsd;
    this.log = log;
    Object.defineProperty(this, 'bootstrapCode', { value: null, writable: true, enumerable: false });
    this.bootstrapFile = null;
  }

  // -------------------------------------------------------------------------------------------
  // Reads

  get(id) {
    return this.db.prepare(SQL.byId).get(id) ?? null;
  }

  /** By any spelling: the name is canonicalised first. */
  byName(name) {
    const canonical = canonicalUsername(name);
    if (!canonical) return null;
    return this.db.prepare(SQL.byName).get(canonical) ?? null;
  }

  count() {
    return this.db.prepare('SELECT count(*) AS n FROM users').get().n;
  }

  countAdmins() {
    return this.db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin'").get().n;
  }

  adminExists() {
    return Boolean(this.db.prepare("SELECT 1 AS ok FROM users WHERE role = 'admin' LIMIT 1").get());
  }

  isRetired(canonical) {
    return Boolean(this.db.prepare('SELECT 1 AS ok FROM retired_usernames WHERE username = ?').get(canonical));
  }

  // -------------------------------------------------------------------------------------------
  // Sign-up

  /**
   * Validate a sign-up before any budget or scrypt is spent (§4.5 order). Throws 400 bad_username / weak_password,
   * 403 forbidden (bootstrap code not accepted), 409 username_unavailable. → {canonical, role}.
   */
  checkSignup({ username, password, bootstrapCode = null }) {
    const canonical = canonicalUsername(username);
    if (!canonical) {
      throw new ApiError(400, 'username must be 3–24 characters: a–z, 0–9 or _', 'bad_username');
    }
    assertPasswordPolicy(password, canonical);
    const hasCode = bootstrapCode !== null && bootstrapCode !== undefined && String(bootstrapCode).trim() !== '';
    const codeOk = hasCode && this.#bootstrapCodeOk(bootstrapCode);
    if (hasCode && !codeOk) throw new ApiError(403, 'bootstrap code not accepted', 'forbidden');
    if (!this.#available(canonical, { bootstrapOk: codeOk })) {
      throw new ApiError(409, 'that username is not available', 'username_unavailable');
    }
    return { canonical, role: codeOk ? 'admin' : 'player' };
  }

  /**
   * Create a player (or the first admin, with the bootstrap code): users + gardens rows in ONE transaction
   * (§4.6 step 1.4). Re-validates inside the transaction (races), hashes through the queue.
   * @returns {Promise<object>} the user row
   */
  async create({ username, password, bootstrapCode = null, invite = null, lang = null, ipKey = null }) {
    const { canonical, role } = this.checkSignup({ username, password, bootstrapCode });
    const pwHash = await this.hasher.hash(password, { ipKey });
    const t = this.now();
    const langValue = lang === 'en' || lang === 'th' ? lang : null;
    let id;
    try {
      id = this.db.tx(() => {
        // Re-check after the await: another request may have taken the name or become admin meanwhile.
        const stillAdmin = role === 'admin' && this.#bootstrapCodeOk(bootstrapCode);
        if (role === 'admin' && !stillAdmin) throw new ApiError(403, 'bootstrap code not accepted', 'forbidden');
        if (!this.#available(canonical, { bootstrapOk: role === 'admin' })) {
          throw new ApiError(409, 'that username is not available', 'username_unavailable');
        }
        const r = this.db.prepare(SQL.insertUser).run(canonical, pwHash, role, langValue, t, t, t);
        const uid = Number(r.lastInsertRowid);
        if (invite !== null) {
          const used = this.db.prepare(SQL.inviteUse).run(uid, t, sha256(normalizeCode(invite)), t);
          if (Number(used.changes) !== 1) throw new ApiError(403, 'that invite code is not valid', 'signup_closed');
        }
        this.db.prepare(SQL.insertGarden).run(uid, crypto.randomBytes(8).toString('hex'), t, t, Number(this.accountUsd()) || 10_000, t, t);
        if (role === 'admin') this.#markBootstrapUsed(uid, t);
        return uid;
      });
    } catch (err) {
      if (/UNIQUE constraint failed: users\.username/.test(err?.message ?? '')) {
        throw new ApiError(409, 'that username is not available', 'username_unavailable');
      }
      throw err;
    }
    if (role === 'admin') this.onAdminExists(); // forget the code, delete the file
    return this.get(id);
  }

  /** SIGNUP_MODE=invite (P1): is this invite code unused and unexpired? */
  inviteValid(code) {
    return Boolean(this.db.prepare(SQL.inviteValid).get(sha256(normalizeCode(code)), this.now()));
  }

  /** Create an invite code (P1); only its SHA-256 is stored. → {code, expiresMs} */
  createInvite({ by = null, ttlDays = 14 } = {}) {
    const code = randomCode();
    const t = this.now();
    const expiresMs = t + Math.max(1, Math.min(365, ttlDays)) * 86_400_000;
    this.db.prepare(SQL.inviteInsert).run(sha256(normalizeCode(code)), by, t, expiresMs);
    return { code, expiresMs };
  }

  // -------------------------------------------------------------------------------------------
  // Sign-in

  /**
   * Check a password (§4.1 order: the caller already took the per-IP bucket). Lockout first (429, unless the
   * caller vouches a valid known-device cookie for this user), then exactly one scrypt (DUMMY_HASH for unknown
   * names). A failure is recorded; success clears the counter and re-hashes outdated parameters.
   * @returns {Promise<object|null>} the user row (any status — the caller refuses 'disabled'), or null
   */
  async verify(username, password, { knownDevice = false, ipKey = null } = {}) {
    const key = lockoutKey(username);
    const user = this.byName(username);
    const lock = this.isLocked(key, user);
    if (lock.locked && !(knownDevice && user)) {
      throw Object.assign(new ApiError(429, 'too many requests: slow down and retry later', 'rate_limited', { retry_after_s: lock.retryAfterS }),
        { headers: { 'Retry-After': String(lock.retryAfterS) } });
    }
    const { ok, needsRehash } = await this.hasher.verify(typeof password === 'string' ? password : '', user ? user.pw_hash : null, { ipKey });
    if (!ok || !user) {
      this.recordFailure(key, user);
      return null;
    }
    this.clearFailures(user.id);
    if (needsRehash) {
      try {
        const fresh = await this.hasher.hash(password, { ipKey });
        this.db.prepare('UPDATE users SET pw_hash = ?, updated_ms = ? WHERE id = ? AND pw_hash = ?').run(fresh, this.now(), user.id, user.pw_hash);
      } catch (err) {
        this.log(`[auth] re-hash skipped (${err.code ?? err.name})`);
      }
    }
    return this.get(user.id);
  }

  /**
   * Lockout state of a name (§4.5). Existing users: the persisted columns. Unknown names: the bounded store, which
   * answers "locked" for a new name when it is full.
   * @returns {{locked: boolean, retryAfterS: number}}
   */
  isLocked(name, user = undefined) {
    const row = user === undefined ? this.byName(name) : user;
    if (row) {
      const t = this.now();
      if (row.locked_until_ms && row.locked_until_ms > t) {
        return { locked: true, retryAfterS: Math.ceil((row.locked_until_ms - t) / 1000) };
      }
      return { locked: false, retryAfterS: 0 };
    }
    return this.lockouts.isLocked(lockoutKey(name));
  }

  /** Count one failed login for `name` (existing user → persisted; unknown → bounded store). */
  recordFailure(name, user = undefined) {
    const row = user === undefined ? this.byName(name) : user;
    if (!row) {
      this.lockouts.recordFailure(lockoutKey(name));
      return;
    }
    const t = this.now();
    this.db.tx(() => {
      const cur = this.db.prepare('SELECT failed_logins FROM users WHERE id = ?').get(row.id);
      if (!cur) return;
      const failures = cur.failed_logins + 1;
      const lock = lockoutMs(failures);
      this.db.prepare('UPDATE users SET failed_logins = ?, locked_until_ms = ? WHERE id = ?')
        .run(failures, lock ? t + lock : null, row.id);
    });
  }

  clearFailures(id) {
    this.db.prepare(SQL.clearFailures).run(id);
  }

  touchLogin(id) {
    this.db.prepare('UPDATE users SET last_login_ms = ? WHERE id = ?').run(this.now(), id);
  }

  // -------------------------------------------------------------------------------------------
  // Changes

  /** Set a new password (policy-checked) and pw_changed_ms (invalidates known-device cookies, §4.2). */
  async setPassword(id, password, { ipKey = null } = {}) {
    const user = this.get(id);
    if (!user) throw new ApiError(404, 'no such user', 'not_found');
    assertPasswordPolicy(password, user.username);
    const pwHash = await this.hasher.hash(password, { ipKey });
    const t = Math.max(this.now(), user.pw_changed_ms + 1); // strictly increases: old device MACs never match again
    this.db.prepare(SQL.setPassword).run(pwHash, t, t, id);
    return this.get(id);
  }

  setRole(id, role) {
    if (role !== 'player' && role !== 'admin') throw new ApiError(400, 'role must be player or admin', 'bad_request');
    this.db.prepare('UPDATE users SET role = ?, updated_ms = ? WHERE id = ?').run(role, this.now(), id);
    if (role === 'admin') this.onAdminExists();
    return this.get(id);
  }

  setStatus(id, status) {
    if (status !== 'active' && status !== 'disabled') throw new ApiError(400, 'status must be active or disabled', 'bad_request');
    this.db.prepare('UPDATE users SET status = ?, updated_ms = ? WHERE id = ?').run(status, this.now(), id);
    return this.get(id);
  }

  setLang(id, lang) {
    this.db.prepare('UPDATE users SET lang = ?, updated_ms = ? WHERE id = ?').run(lang === 'en' || lang === 'th' ? lang : null, this.now(), id);
  }

  /**
   * Delete an account (§4.6 step 6.5–6.6): in ONE transaction overwrite the sealed key with zero bytes, retire the
   * name, DELETE the user (cascades: sessions, credentials, gardens → bots/orders/fills, events). Then
   * `wal_checkpoint(TRUNCATE)` so the old credential pages leave the WAL at once. Idempotent.
   * The caller runs the garden halt and `gardens.teardown(uid)` BEFORE this (§2.2).
   * @returns {boolean} whether a row was deleted
   */
  remove(id) {
    const user = this.get(id);
    if (!user) return false;
    const t = this.now();
    this.db.tx(() => {
      this.db.prepare(SQL.wipeKeys).run(t, id);
      this.db.prepare('INSERT INTO retired_usernames (username, retired_ms) VALUES (?, ?) ON CONFLICT(username) DO NOTHING').run(user.username, t);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
    if (!this.db.inTransaction) this.db.checkpoint();
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Operator password reset (§4.6 step 8)

  /**
   * Issue a one-time reset code: only SHA-256(code) is stored, valid 24 h, single use. The caller (admin service)
   * must wipe the player's testnet credential FIRST (§6.14 R14) and audit `password_reset_issued`.
   * @returns {{code: string, expiresMs: number}}  the code is returned ONCE and never stored or logged
   */
  issueReset(id) {
    const code = randomCode();
    const expiresMs = this.now() + RESET_TTL_MS;
    const r = this.db.prepare('UPDATE users SET reset_hash = ?, reset_expires_ms = ?, updated_ms = ? WHERE id = ?')
      .run(sha256(normalizeCode(code)), expiresMs, this.now(), id);
    if (Number(r.changes) !== 1) throw new ApiError(404, 'no such user', 'not_found');
    return { code, expiresMs };
  }

  /**
   * Redeem a reset code (auth_reset): a matching, unexpired code sets the new password and clears the code. A wrong,
   * used or expired code counts as a login failure for that name and returns null (the caller answers the generic
   * 401). Lockout applies (429). The new password is policy-checked (400 weak_password) before the code.
   * @returns {Promise<object|null>}
   */
  async redeemReset(username, code, newPassword, { ipKey = null } = {}) {
    const key = lockoutKey(username);
    const user = this.byName(username);
    const lock = this.isLocked(key, user);
    if (lock.locked) {
      throw Object.assign(new ApiError(429, 'too many requests: slow down and retry later', 'rate_limited', { retry_after_s: lock.retryAfterS }),
        { headers: { 'Retry-After': String(lock.retryAfterS) } });
    }
    assertPasswordPolicy(newPassword, user ? user.username : canonicalUsername(username));
    const presented = sha256(normalizeCode(code));
    const stored = user?.reset_hash ? Buffer.from(user.reset_hash) : crypto.randomBytes(32); // same compare either way
    const match = crypto.timingSafeEqual(presented, stored);
    if (!user || !match || !user.reset_expires_ms || user.reset_expires_ms <= this.now()) {
      this.recordFailure(key, user);
      return null;
    }
    // Consume the code before the (async) hash so a parallel redeem of the same code cannot also succeed.
    const consumed = this.db.prepare('UPDATE users SET reset_hash = NULL, reset_expires_ms = NULL WHERE id = ? AND reset_hash = ?')
      .run(user.id, user.reset_hash);
    if (Number(consumed.changes) !== 1) {
      this.recordFailure(key, user);
      return null;
    }
    return this.setPassword(user.id, newPassword, { ipKey });
  }

  // -------------------------------------------------------------------------------------------
  // Boot: admin promotion and the bootstrap code (§4.6 step 2)

  /**
   * Run once at boot, after migrations:
   *  1. promote EXISTING users named in ADMIN_USERNAMES (never creates one);
   *  2. if an admin exists → delete the bootstrap file, set bootstrap_used;
   *  3. else arm the bootstrap code: the configured one, or a generated one written to <data>/admin-bootstrap.txt
   *     (0600). The code itself is never logged.
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {string|null} [opts.configuredCode]  ADMIN_BOOTSTRAP_CODE(_FILE)
   * @returns {{promoted: string[], bootstrap: 'used'|'configured'|'generated'|'reused'}}
   */
  bootstrap({ dataDir, configuredCode = null }) {
    this.bootstrapFile = path.join(dataDir, BOOTSTRAP_FILE);
    const promoted = [];
    for (const name of this.adminUsernames) {
      const r = this.db.prepare("UPDATE users SET role = 'admin', updated_ms = ? WHERE username = ? AND role <> 'admin'").run(this.now(), name);
      if (Number(r.changes) === 1) promoted.push(name);
    }
    if (promoted.length) this.log(`[auth] ADMIN_USERNAMES promoted existing user(s): ${promoted.join(', ')}`);

    if (this.adminExists()) {
      this.onAdminExists();
      return { promoted, bootstrap: 'used' };
    }
    if (configuredCode) {
      this.bootstrapCode = normalizeCode(configuredCode);
      this.log('[auth] no admin yet: the admin bootstrap code is configured (ADMIN_BOOTSTRAP_CODE or ADMIN_BOOTSTRAP_CODE_FILE); sign up with it to become admin');
      return { promoted, bootstrap: 'configured' };
    }
    let mode = 'generated';
    let code = null;
    try {
      const existing = normalizeCode(fs.readFileSync(this.bootstrapFile, 'utf8'));
      if (existing.length === CODE_LEN && [...existing].every((c) => CODE_ALPHABET.includes(c))) {
        code = existing;
        mode = 'reused';
      }
    } catch {
      // No file yet.
    }
    if (!code) {
      code = randomCode();
      fs.mkdirSync(dataDir, { recursive: true });
      fs.rmSync(this.bootstrapFile, { force: true });
      fs.writeFileSync(this.bootstrapFile, `${code}\n`, { mode: 0o600, flag: 'wx' });
    }
    try {
      fs.chmodSync(this.bootstrapFile, 0o600);
    } catch {
      // Windows: modes are not enforced; the data dir is the boundary.
    }
    this.bootstrapCode = code;
    this.log(`admin bootstrap code written to ${this.bootstrapFile} (read it with docker compose exec / fly ssh console; ` +
      'with cloud persistence it is also copied to the private bucket)');
    return { promoted, bootstrap: mode };
  }

  /** Called whenever an admin comes to exist: forget the code, delete the file, persist bootstrap_used. */
  onAdminExists() {
    this.bootstrapCode = null;
    this.#deleteBootstrapFile();
    const used = this.db.prepare("SELECT 1 AS ok FROM admin_state WHERE key = 'bootstrap_used'").get();
    if (!used) this.#markBootstrapUsed(null, this.now());
  }

  // -------------------------------------------------------------------------------------------

  #bootstrapCodeOk(code) {
    if (!this.bootstrapCode || this.adminExists()) return false;
    return codesEqual(normalizeCode(code), this.bootstrapCode);
  }

  /** Reserved, retired, taken, or a configured admin name without a valid bootstrap code → unavailable. */
  #available(canonical, { bootstrapOk }) {
    if (RESERVED_USERNAMES.has(canonical)) return false;
    if (this.isRetired(canonical)) return false;
    if (this.db.prepare('SELECT 1 AS ok FROM users WHERE username = ?').get(canonical)) return false;
    if (this.adminUsernames.has(canonical) && !bootstrapOk) return false;
    return true;
  }

  #markBootstrapUsed(uid, t) {
    this.db.prepare(SQL.bootstrapUsed).run(JSON.stringify({ used: true, at_ms: t }), t, uid);
  }

  #deleteBootstrapFile() {
    if (!this.bootstrapFile) return;
    try {
      fs.rmSync(this.bootstrapFile, { force: true });
    } catch (err) {
      this.log(`[auth] could not delete ${BOOTSTRAP_FILE} (${err.code ?? err.name}): delete it by hand`);
    }
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest();
}

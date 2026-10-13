// server/auth/sessions.js — sessions and cookies (PLATFORM.md §4.2).
//
// Token: 32 random bytes, sent as base64url (43 chars); the server stores only SHA-256(token bytes). A cookie value
// that is not ^[A-Za-z0-9_-]{43}$ is ignored. Lifetimes: absolute 30 days (SESSION_DAYS), idle 7 days
// (SESSION_IDLE_DAYS). Rotation on the first authenticated request more than 24 h after rotated_ms, with a 60 s
// grace for the previous token (parallel requests still carrying it keep working). Sign-in, sign-up and password
// change always create a NEW row. At most 20 live sessions per user: the 21st revokes the oldest.
//
// Ids: the integer rowid never leaves the server. Clients — and SSE streams, and http.closeStreamsFor() — see the
// opaque `public_id` (16 random bytes, base64url). Every revoke* returns the revoked public ids so the caller can
// close the matching streams in the same tick (§4.2, §8.7).
//
// Known-device cookie (anti-lockout): "<uid>.<expires_ms>.<b64url HMAC-SHA256(K_dev, uid|expires_ms|pw_changed_ms)>",
// 90 days. A password change invalidates every one (pw_changed_ms is in the MAC).

import crypto from 'node:crypto';

import { ipPrefix } from './clientip.js';

const DAY_MS = 86_400_000;
const ROTATE_AFTER_MS = DAY_MS;
const ROTATE_GRACE_MS = 60_000;
const SEEN_WRITE_EVERY_MS = 5 * 60_000;
const KNOWN_DEVICE_DAYS = 90;
export const MAX_SESSIONS_PER_USER = 20;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const KD_RE = /^(\d{1,15})\.(\d{13,15})\.([A-Za-z0-9_-]{43})$/;

const SQL = Object.freeze({
  insert: `INSERT INTO sessions (public_id, user_id, token_hash, created_ms, rotated_ms, last_seen_ms, expires_ms, user_agent, ip_prefix)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  live: `SELECT id, public_id FROM sessions WHERE user_id = ? AND revoked_ms IS NULL AND expires_ms > ?
    ORDER BY created_ms DESC, id DESC`,
  lookup: `SELECT s.id, s.public_id, s.user_id, s.token_hash, s.prev_hash, s.prev_valid_ms, s.created_ms, s.rotated_ms,
      s.last_seen_ms, s.expires_ms, s.revoked_ms,
      u.username, u.role, u.status, u.lang, u.created_ms AS user_created_ms, u.pw_changed_ms
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? OR (s.prev_hash = ? AND s.prev_valid_ms > ?)`,
  rotate: `UPDATE sessions SET prev_hash = token_hash, prev_valid_ms = ?, token_hash = ?, rotated_ms = ?, last_seen_ms = ?
    WHERE id = ? AND token_hash = ?`,
  seen: 'UPDATE sessions SET last_seen_ms = ? WHERE id = ?',
  revokeOne: 'UPDATE sessions SET revoked_ms = ? WHERE public_id = ? AND user_id = ? AND revoked_ms IS NULL',
  revokeById: 'UPDATE sessions SET revoked_ms = ? WHERE id = ? AND revoked_ms IS NULL',
  liveIds: 'SELECT public_id FROM sessions WHERE user_id = ? AND revoked_ms IS NULL',
  revokeAll: 'UPDATE sessions SET revoked_ms = ? WHERE user_id = ? AND revoked_ms IS NULL',
  list: `SELECT public_id, created_ms, last_seen_ms, user_agent, ip_prefix FROM sessions
    WHERE user_id = ? AND revoked_ms IS NULL AND expires_ms > ? AND last_seen_ms > ? ORDER BY last_seen_ms DESC LIMIT 50`,
  stillValid: `SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.public_id = ? AND s.revoked_ms IS NULL AND s.expires_ms > ? AND s.last_seen_ms > ? AND u.status = 'active'`,
  countActive: 'SELECT count(*) AS n FROM sessions WHERE revoked_ms IS NULL AND expires_ms > ? AND last_seen_ms > ?',
});

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

/**
 * Cookie values of `name` from a Cookie header (all occurrences, first first; a browser can send duplicates).
 * @returns {string[]}
 */
export function cookieValues(req, name) {
  const header = req?.headers?.cookie;
  const text = Array.isArray(header) ? header.join('; ') : typeof header === 'string' ? header : '';
  if (!text) return [];
  const out = [];
  for (const part of text.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out.push(value);
    if (out.length >= 4) break;
  }
  return out;
}

export class Sessions {
  /**
   * @param {import('../db/db.js').Db} db
   * @param {object} cfg
   * @param {string} cfg.publicOrigin      decides https (`__Host-`, Secure) vs http (local dev) cookies
   * @param {import('../secrets.js').Secrets} cfg.secrets  K_dev for the known-device cookie
   * @param {number} [cfg.sessionDays]     30
   * @param {number} [cfg.idleDays]        7
   * @param {number} [cfg.maxPerUser]      20
   * @param {() => number} [cfg.now]
   */
  constructor(db, { publicOrigin, secrets, sessionDays = 30, idleDays = 7, maxPerUser = MAX_SESSIONS_PER_USER, now = Date.now }) {
    if (!secrets) throw new TypeError('Sessions: secrets is required');
    const https = new URL(publicOrigin).protocol === 'https:';
    this.db = db;
    this.secrets = secrets;
    this.now = now;
    this.https = https;
    this.absoluteMs = sessionDays * DAY_MS;
    this.idleMs = idleDays * DAY_MS;
    this.maxPerUser = maxPerUser;
    this.names = { sid: https ? '__Host-bean_sid' : 'bean_sid', kd: https ? '__Host-bean_kd' : 'bean_kd' };
    this.attrs = https ? 'Path=/; Secure; HttpOnly; SameSite=Lax' : 'Path=/; HttpOnly; SameSite=Lax';
  }

  // -------------------------------------------------------------------------------------------
  // Cookies

  #sessionCookie(token) {
    return `${this.names.sid}=${token}; ${this.attrs}; Max-Age=${Math.floor(this.absoluteMs / 1000)}`;
  }

  /** Set-Cookie that clears the session cookie (same name and attributes, Max-Age=0; never a Domain). */
  clearCookie() {
    return `${this.names.sid}=; ${this.attrs}; Max-Age=0`;
  }

  /** True when the request carries a session cookie at all (valid or not): lets the caller answer session_expired. */
  presented(req) {
    return cookieValues(req, this.names.sid).length > 0;
  }

  // -------------------------------------------------------------------------------------------
  // Create / authenticate

  /**
   * Create a new session row for `uid` (sign-in, sign-up, password change, reset).
   * @param {number} uid
   * @param {{userAgent?: string, ip?: string}} [meta]
   * @returns {{token: string, cookie: string, publicId: string, revoked: string[]}}  `revoked`: public ids evicted by
   *   the 20-session cap (close their streams)
   */
  create(uid, { userAgent = null, ip = null } = {}) {
    const tokenBytes = crypto.randomBytes(32);
    const token = tokenBytes.toString('base64url');
    const publicId = crypto.randomBytes(16).toString('base64url');
    const t = this.now();
    const ua = typeof userAgent === 'string' && userAgent ? userAgent.slice(0, 200) : null;
    const prefix = ip ? ipPrefix(ip) : null;
    const revoked = [];
    this.db.tx(() => {
      this.db.prepare(SQL.insert).run(publicId, uid, sha256(tokenBytes), t, t, t, t + this.absoluteMs, ua, prefix);
      const live = this.db.prepare(SQL.live).all(uid, t);
      for (const row of live.slice(this.maxPerUser)) {
        this.db.prepare(SQL.revokeById).run(t, row.id);
        revoked.push(row.public_id);
      }
    });
    tokenBytes.fill(0);
    return { token, cookie: this.#sessionCookie(token), publicId, revoked };
  }

  /**
   * Validate the session cookie of a request (§4.2): token or (previous token within its 60 s grace), not revoked,
   * not past absolute or idle expiry, user active. Rotates after 24 h (→ setCookie). Writes last_seen_ms at most
   * every 5 min.
   * @returns {{user: object, session: {publicId: string, createdMs: number, expiresMs: number, lastSeenMs: number},
   *           setCookie?: string} | null}  null = anonymous (no cookie, or an invalid one: see presented())
   */
  authenticate(req) {
    const t = this.now();
    for (const value of cookieValues(req, this.names.sid)) {
      if (!TOKEN_RE.test(value)) continue;
      const tokenBytes = Buffer.from(value, 'base64url');
      if (tokenBytes.length !== 32) continue;
      const hash = sha256(tokenBytes);
      const row = this.db.prepare(SQL.lookup).get(hash, hash, t);
      if (!row) continue;
      if (row.revoked_ms !== null || row.expires_ms <= t || row.last_seen_ms + this.idleMs <= t || row.status !== 'active') continue;
      const viaCurrent = Buffer.from(row.token_hash).equals(hash);
      let setCookie;
      let lastSeen = row.last_seen_ms;
      if (viaCurrent && t - row.rotated_ms > ROTATE_AFTER_MS) {
        const fresh = crypto.randomBytes(32);
        const r = this.db.prepare(SQL.rotate).run(t + ROTATE_GRACE_MS, sha256(fresh), t, t, row.id, hash);
        if (Number(r.changes) === 1) {
          setCookie = this.#sessionCookie(fresh.toString('base64url'));
          lastSeen = t;
        }
        fresh.fill(0);
      } else if (t - row.last_seen_ms > SEEN_WRITE_EVERY_MS) {
        this.db.prepare(SQL.seen).run(t, row.id);
        lastSeen = t;
      }
      const user = {
        id: row.user_id,
        username: row.username,
        role: row.role,
        status: row.status,
        lang: row.lang,
        created_ms: row.user_created_ms,
        pw_changed_ms: row.pw_changed_ms,
      };
      const session = { publicId: row.public_id, createdMs: row.created_ms, expiresMs: row.expires_ms, lastSeenMs: lastSeen };
      return setCookie ? { user, session, setCookie } : { user, session };
    }
    return null;
  }

  /** The SSE 60 s backstop (§4.2): is this public session id still valid? */
  stillValid(publicId) {
    const t = this.now();
    return Boolean(this.db.prepare(SQL.stillValid).get(String(publicId), t, t - this.idleMs));
  }

  // -------------------------------------------------------------------------------------------
  // Revocation (every path returns what it revoked, so the caller closes streams in the same tick)

  /**
   * Revoke one of `uid`'s sessions by public id. Only that user's row can match (owner-checked UPDATE), so another
   * player's id answers false → 404 not_found.
   * @returns {boolean}
   */
  revoke(uid, publicId) {
    if (typeof publicId !== 'string' || publicId.length !== 22) return false;
    return Number(this.db.prepare(SQL.revokeOne).run(this.now(), publicId, uid).changes) === 1;
  }

  /** Revoke every live session of `uid` → their public ids. */
  revokeAll(uid) {
    let ids = [];
    this.db.tx(() => {
      ids = this.db.prepare(SQL.liveIds).all(uid).map((r) => r.public_id);
      this.db.prepare(SQL.revokeAll).run(this.now(), uid);
    });
    return ids;
  }

  /** P1 `sessions`: the user's live sessions, newest activity first. */
  list(uid, currentPublicId = null) {
    const t = this.now();
    return this.db.prepare(SQL.list).all(uid, t, t - this.idleMs).map((r) => ({
      id: r.public_id,
      created_ms: r.created_ms,
      last_seen_ms: r.last_seen_ms,
      user_agent: r.user_agent,
      ip_prefix: r.ip_prefix,
      current: r.public_id === currentPublicId,
    }));
  }

  /** Live (not revoked, not expired, not idle) sessions across all users (admin_status.sessions_active). */
  countActive() {
    const t = this.now();
    return this.db.prepare(SQL.countActive).get(t, t - this.idleMs).n;
  }

  // -------------------------------------------------------------------------------------------
  // Known-device cookie (§4.2)

  /** Set-Cookie for the known-device cookie of `user` (needs id and pw_changed_ms). */
  knownDeviceCookie(user) {
    const expires = this.now() + KNOWN_DEVICE_DAYS * DAY_MS;
    const mac = this.secrets.deviceMac(user.id, expires, user.pw_changed_ms);
    return `${this.names.kd}=${user.id}.${expires}.${mac}; ${this.attrs}; Max-Age=${KNOWN_DEVICE_DAYS * 86_400}`;
  }

  /** True when the request presents a valid, unexpired known-device cookie FOR THIS user (and password epoch). */
  checkKnownDevice(req, user) {
    if (!user) return false;
    const t = this.now();
    for (const value of cookieValues(req, this.names.kd)) {
      const m = KD_RE.exec(value);
      if (!m) continue;
      const uid = Number(m[1]);
      const expires = Number(m[2]);
      if (uid !== user.id || expires <= t) continue;
      const want = Buffer.from(this.secrets.deviceMac(uid, expires, user.pw_changed_ms));
      const got = Buffer.from(m[3]);
      if (want.length === got.length && crypto.timingSafeEqual(want, got)) return true;
    }
    return false;
  }
}

// server/admin.js — the admin service: persisted switches, caps, audit, and the admin ops' data side
// (PLATFORM.md §5.4, §7.3, §8.6).
//
// What admins can do: see usernames, roles, status, open-bot counts by venue, testnet connection status and
// TRUNCATED addresses; toggle the kill switch; set caps; disable / enable users; revoke sessions; force-disconnect
// a credential; issue a password reset code (which wipes the player's testnet credential first).
// What admins can never do: read a key, sign for a user, plant or close a user's bots, read a user's events or fills.
// No method here exists for any of those.
//
// admin_state keys: kill_switch {on, reason, since_ms} · caps {paper, testnet} · signup_mode · testnet_signing
// {halted, since_ms, sample} · audit_salt (secrets.js) · bootstrap_used (users.js).
// Garden-side effects (flatten, halt, teardown, stream closing) are hooks supplied by WP3/WP4 (setHooks), so this
// module never reaches into a garden.

import { ApiError } from './live.js';
import { wipeCredentials } from './secrets.js';
import { publicUser } from './auth/users.js';

/** §5.4 audit action allowlist. */
export const AUDIT_ACTIONS = Object.freeze(new Set([
  'signup', 'login_ok', 'login_fail', 'logout', 'logout_all', 'password_changed', 'account_deleted',
  'password_reset_issued', 'password_reset_used',
  'testnet_connected', 'testnet_verify', 'testnet_disconnected', 'testnet_revoked_detected', 'testnet_agent_replaced',
  'mainnet_key_detected', 'testnet_signing_halted',
  'garden_halt', 'garden_rearm', 'garden_reset', 'inactivity_pause',
  'admin_kill_switch', 'admin_caps', 'admin_user', 'admin_backup', 'admin_bootstrap', 'admin_token_fail',
  'keys_resealed',
]));
/** §5.3 rule 8: audit_log.detail_json keeps these fields only. */
export const AUDIT_DETAIL_KEYS = Object.freeze(['venue', 'coin', 'bot', 'count', 'code', 'reason', 'caps']);
const AUDIT_ACTORS = new Set(['user', 'admin', 'system', 'ops']);

/** Default caps (§7.3). Paper defaults come from the CLI options (--account, --max-bots, --max-bot-capital). */
export const DEFAULT_CAPS = Object.freeze({
  paper: Object.freeze({ account_usd: 10_000, max_bots: 10, min_capital_usd: 20, max_bot_capital_usd: 1000, max_total_notional_usd: 10_000 }),
  testnet: Object.freeze({ max_bots: 3, min_capital_usd: 20, max_bot_capital_usd: 500, max_total_notional_usd: 3000 }),
});
const CAP_LIMITS = {
  account_usd: [1, 1e9, false],
  max_bots: [1, 100, true],
  min_capital_usd: [10, 1e6, false],
  max_bot_capital_usd: [10, 1e7, false],
  max_total_notional_usd: [10, 1e9, false],
};

export const USER_ACTIONS = Object.freeze(['disable', 'enable', 'halt', 'revoke_sessions', 'disconnect_testnet', 'reset_password',
  'make_admin', 'remove_admin']);
export const SIGNUP_MODES = Object.freeze(['open', 'invite', 'closed']);
const TOTAL_CAP = 10_001;

const SQL = Object.freeze({
  stateGet: 'SELECT value_json FROM admin_state WHERE key = ?',
  stateSet: `INSERT INTO admin_state (key, value_json, updated_ms, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_ms = excluded.updated_ms,
    updated_by = excluded.updated_by`,
  auditInsert: `INSERT INTO audit_log (at_ms, user_id, actor, action, target, ip_hash, ok, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  usersPage: `SELECT u.id, u.username, u.role, u.status, u.created_ms, u.last_login_ms,
      (SELECT count(*) FROM bots b WHERE b.user_id = u.id AND b.state <> 'closed' AND b.venue = 'paper') AS paper_open,
      (SELECT count(*) FROM bots b WHERE b.user_id = u.id AND b.state <> 'closed' AND b.venue = 'testnet') AS testnet_open,
      c.status AS cred_status, c.account_address
    FROM users u LEFT JOIN credentials c ON c.user_id = u.id AND c.venue = 'hl_testnet'
    WHERE (? IS NULL OR u.username LIKE ? ESCAPE '\\')
    ORDER BY u.id LIMIT ? OFFSET ?`,
  usersTotal: `SELECT count(*) AS n FROM (SELECT 1 FROM users u WHERE (? IS NULL OR u.username LIKE ? ESCAPE '\\') LIMIT ?)`,
  auditPage: `SELECT a.id, a.at_ms, a.user_id, u.username, a.actor, a.action, a.target, a.ip_hash, a.ok, a.detail_json
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE (? IS NULL OR a.user_id = ?) AND (? IS NULL OR a.action = ?)
    ORDER BY a.id DESC LIMIT ? OFFSET ?`,
  auditTotal: `SELECT count(*) AS n FROM (SELECT 1 FROM audit_log a
    WHERE (? IS NULL OR a.user_id = ?) AND (? IS NULL OR a.action = ?) LIMIT ?)`,
  userCapsGet: 'SELECT caps_json FROM gardens WHERE user_id = ?',
  userCapsSet: 'UPDATE gardens SET caps_json = ?, updated_ms = ? WHERE user_id = ?',
  countUsers: 'SELECT count(*) AS n FROM users',
});

/** `0x1234…abcd` (admins only ever see truncated addresses). */
export function truncateAddress(addr) {
  if (typeof addr !== 'string' || addr.length < 12) return null;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Escape LIKE wildcards (%, _ and the escape char \) in user input. */
export function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class Admin {
  /**
   * @param {import('./db/db.js').Db} db
   * @param {object} [opts]
   * @param {() => number} [opts.now]
   * @param {(line: string) => void} [opts.log]
   * @param {import('./secrets.js').Secrets} [opts.secrets]  for audit ip hashes
   * @param {import('./auth/users.js').Users} [opts.users]
   * @param {import('./auth/sessions.js').Sessions} [opts.sessions]
   * @param {import('./auth/passwords.js').PasswordHasher} [opts.hasher]
   * @param {{paper?: object, testnet?: object}} [opts.defaultCaps]
   * @param {string} [opts.signupMode]  SIGNUP_MODE (the default until an admin changes it)
   */
  constructor(db, { now = Date.now, log = () => {}, secrets = null, users = null, sessions = null, hasher = null,
    defaultCaps = {}, signupMode = 'open' } = {}) {
    this.db = db;
    this.now = now;
    this.log = log;
    this.secrets = secrets;
    this.users = users;
    this.sessions = sessions;
    this.hasher = hasher;
    this.defaults = {
      caps: {
        paper: { ...DEFAULT_CAPS.paper, ...(defaultCaps.paper ?? {}) },
        testnet: { ...DEFAULT_CAPS.testnet, ...(defaultCaps.testnet ?? {}) },
      },
      signupMode: SIGNUP_MODES.includes(signupMode) ? signupMode : 'open',
    };
    this.cache = new Map();
    /** Garden/stream side effects, wired by the composition root (WP3/WP4). All optional. */
    this.hooks = {
      closeStreams: null, // ({uid, sessionIds?}) => void   — synchronous (http.closeStreamsFor)
      haltGarden: null, // async (uid, {reason}) => {closed, closing}  — flattens testnet bots, awaited
      teardown: null, // (uid) => void                    — gardens.teardown
      disconnectTestnet: null, // async (uid, {reason}) => {closed, left_open}  — flatten + wipe
      notifyUser: null, // (uid, kind, data) => void       — a user-scoped journal record (diary)
    };
  }

  setHooks(hooks) {
    Object.assign(this.hooks, hooks);
    return this;
  }

  // -------------------------------------------------------------------------------------------
  // admin_state

  #get(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    const row = this.db.prepare(SQL.stateGet).get(key);
    const value = row ? JSON.parse(row.value_json) : null;
    this.cache.set(key, value);
    return value;
  }

  #set(key, value, by = null) {
    this.db.prepare(SQL.stateSet).run(key, JSON.stringify(value), this.now(), by);
    this.cache.set(key, value);
    return value;
  }

  /** {on, reason, since_ms} — the global testnet kill switch (§1.3). */
  getKillSwitch() {
    const v = this.#get('kill_switch');
    return { on: Boolean(v?.on), reason: v?.reason ?? null, since_ms: v?.on ? v.since_ms ?? null : null };
  }

  /**
   * Persist the kill switch and audit it. The flatten of every testnet bot is Gardens.killSwitch's job (WP3), which
   * calls this; the `kill_switch` journal record is emitted by the caller too.
   */
  setKillSwitch(on, reason = null, by = null) {
    const prev = this.getKillSwitch();
    const value = {
      on: Boolean(on),
      reason: on ? clip(reason, 200) : null,
      since_ms: on ? (prev.on ? prev.since_ms : this.now()) : null,
    };
    this.#set('kill_switch', value, by);
    this.audit({ action: 'admin_kill_switch', actor: by ? 'admin' : 'ops', userId: by, ok: true, detail: { reason: value.on ? 'on' : 'off' } });
    return this.getKillSwitch();
  }

  /** {halted, since_ms, sample} — testnet signing halted by a signature_mismatch (§6.9). */
  getSigningHalt() {
    const v = this.#get('testnet_signing');
    return { halted: Boolean(v?.halted), since_ms: v?.halted ? v.since_ms ?? null : null, sample: v?.halted ? v.sample ?? null : null };
  }

  /** Halt (system, with an error sample) or resume (admin_testnet_signing) testnet signing for everyone. */
  setSigningHalt(halted, sample = null, by = null) {
    const prev = this.getSigningHalt();
    const value = halted
      ? { halted: true, since_ms: prev.halted ? prev.since_ms : this.now(), sample: clip(sample, 300) }
      : { halted: false, since_ms: null, sample: null };
    this.#set('testnet_signing', value, by);
    this.audit({
      action: 'testnet_signing_halted', actor: halted ? 'system' : (by ? 'admin' : 'ops'), userId: by, ok: true,
      detail: { reason: halted ? 'signature_mismatch' : 'resumed' },
    });
    return this.getSigningHalt();
  }

  /** 'open' | 'invite' | 'closed' (admin_state overrides SIGNUP_MODE once set). */
  getSignupMode() {
    const v = this.#get('signup_mode');
    return SIGNUP_MODES.includes(v) ? v : this.defaults.signupMode;
  }

  setSignupMode(mode, by = null) {
    if (!SIGNUP_MODES.includes(mode)) throw new ApiError(400, 'signup mode must be open, invite or closed', 'bad_request');
    this.#set('signup_mode', mode, by);
    return mode;
  }

  // -------------------------------------------------------------------------------------------
  // Caps (§7.3)

  /** {paper, testnet} — defaults merged with the persisted admin overrides. */
  getCaps() {
    const v = this.#get('caps') ?? {};
    return {
      paper: { ...this.defaults.caps.paper, ...(v.paper ?? {}) },
      testnet: { ...this.defaults.caps.testnet, ...(v.testnet ?? {}) },
    };
  }

  /**
   * Patch the global caps (they apply to NEW bots). Validated: known keys only, finite numbers in range, integer
   * max_bots, min ≤ max stake, testnet max_bots ≤ paper max_bots. Audited (admin_caps).
   * @param {{paper?: object, testnet?: object}} patch
   */
  setCaps(patch, by = null) {
    const merged = mergeCaps(this.getCaps(), patch);
    const stored = this.#get('caps') ?? {};
    const next = {
      paper: { ...(stored.paper ?? {}), ...(patch?.paper ?? {}) },
      testnet: { ...(stored.testnet ?? {}), ...(patch?.testnet ?? {}) },
    };
    this.#set('caps', next, by);
    this.audit({ action: 'admin_caps', actor: by ? 'admin' : 'ops', userId: by, ok: true, detail: { caps: merged } });
    return merged;
  }

  /** Per-user override (P1): gardens.caps_json, merged over the global caps. */
  getUserCaps(uid) {
    const row = this.db.prepare(SQL.userCapsGet).get(uid);
    const own = row?.caps_json ? JSON.parse(row.caps_json) : {};
    const global = this.getCaps();
    return { paper: { ...global.paper, ...(own.paper ?? {}) }, testnet: { ...global.testnet, ...(own.testnet ?? {}) } };
  }

  setUserCaps(uid, patch, by = null) {
    const row = this.db.prepare(SQL.userCapsGet).get(uid);
    if (!row) throw new ApiError(404, 'that player has no garden yet', 'not_found');
    const own = row.caps_json ? JSON.parse(row.caps_json) : {};
    const next = { paper: { ...(own.paper ?? {}), ...(patch?.paper ?? {}) }, testnet: { ...(own.testnet ?? {}), ...(patch?.testnet ?? {}) } };
    const merged = mergeCaps(this.getCaps(), next);
    this.db.prepare(SQL.userCapsSet).run(JSON.stringify(next), this.now(), uid);
    this.audit({ action: 'admin_caps', actor: by ? 'admin' : 'ops', userId: uid, ok: true, detail: { caps: merged } });
    return merged;
  }

  // -------------------------------------------------------------------------------------------
  // Audit (§5.4)

  /**
   * Append one audit row. Unknown actions throw (a wiring mistake must fail loudly). `detail` keeps only the
   * allowlisted fields; `ip` is an IP prefix that is stored only as HMAC(K_ip, prefix)[0..16].
   * @param {{action: string, actor?: string, userId?: number|null, target?: string|null, ip?: string|null,
   *          ipHash?: string|null, ok?: boolean, detail?: object}} entry
   */
  audit({ action, actor = 'system', userId = null, target = null, ip = null, ipHash = null, ok = true, detail = null }) {
    if (!AUDIT_ACTIONS.has(action)) throw new Error(`audit: action '${action}' is not in the allowlist`);
    if (!AUDIT_ACTORS.has(actor)) throw new Error(`audit: bad actor '${actor}'`);
    const hash = ipHash ?? (ip && this.secrets ? this.secrets.hmacIp(ip) : null);
    const clean = cleanDetail(detail);
    this.db.prepare(SQL.auditInsert).run(this.now(), Number.isInteger(userId) ? userId : null, actor, action,
      target === null || target === undefined ? null : clip(String(target), 64), hash, ok ? 1 : 0, clean ? JSON.stringify(clean) : null);
  }

  /** admin_audit: newest first; `user` is a username (or a numeric uid for deleted players). */
  auditQuery({ user = null, action = null, limit = 100, offset = 0 } = {}) {
    const lim = clampInt(limit, 1, 1000, 100);
    const off = clampInt(offset, 0, 1e9, 0);
    let uid = null;
    if (user !== null && user !== undefined && user !== '') {
      if (/^\d+$/.test(String(user))) uid = Number(user);
      else {
        const row = this.users?.byName(String(user));
        if (!row) return { rows: [], total_capped: 0 };
        uid = row.id;
      }
    }
    const act = action === null || action === undefined || action === '' ? null : String(action);
    const rows = this.db.prepare(SQL.auditPage).all(uid, uid, act, act, lim, off).map((r) => ({
      id: r.id,
      at_ms: r.at_ms,
      user_id: r.user_id,
      username: r.username ?? null,
      actor: r.actor,
      action: r.action,
      target: r.target,
      ip_hash: r.ip_hash,
      ok: r.ok === 1,
      detail: r.detail_json ? JSON.parse(r.detail_json) : null,
    }));
    const total = this.db.prepare(SQL.auditTotal).get(uid, uid, act, act, TOTAL_CAP).n;
    return { rows, total_capped: total };
  }

  /** admin_users: `q` ≤ 24 chars, LIKE-escaped; addresses truncated. */
  listUsers({ q = null, limit = 50, offset = 0 } = {}) {
    if (q !== null && q !== undefined && String(q).length > 24) throw new ApiError(400, 'q must be at most 24 characters', 'bad_request');
    const lim = clampInt(limit, 1, 500, 50);
    const off = clampInt(offset, 0, 1e9, 0);
    const pattern = q === null || q === undefined || q === '' ? null : `%${escapeLike(String(q).toLowerCase())}%`;
    const rows = this.db.prepare(SQL.usersPage).all(pattern, pattern, lim, off).map((r) => ({
      id: r.id,
      username: r.username,
      role: r.role,
      status: r.status,
      created_ms: r.created_ms,
      last_login_ms: r.last_login_ms,
      bots_open: { paper: r.paper_open, testnet: r.testnet_open },
      testnet: r.cred_status ? { status: r.cred_status, account: truncateAddress(r.account_address) } : null,
    }));
    const total = this.db.prepare(SQL.usersTotal).get(pattern, pattern, TOTAL_CAP).n;
    return { rows, total_capped: total };
  }

  // -------------------------------------------------------------------------------------------
  // admin_user (§8.6)

  /**
   * One admin action on a player. Role changes need an admin SESSION (never the Bearer token) plus re-entry of the
   * calling admin's own password. Role changes, disable and revoke_sessions close the target's streams in the same
   * tick. reset_password wipes the player's testnet credential BEFORE issuing the code (§6.14 R14).
   * @param {object} a
   * @param {{id: number}|null} a.actor        the calling admin (null = Bearer / ops)
   * @param {boolean} a.viaBearer
   * @param {string} a.username
   * @param {string} a.action
   * @param {string} [a.password]              the calling admin's password (make_admin / remove_admin)
   * @param {string} [a.ipKey]                 for the hasher's per-IP lane
   * @param {string} [a.ip]                    ip prefix for the audit row
   * @returns {Promise<{user: object, code?: string, expires_ms?: number}>}
   */
  async userAction({ actor = null, viaBearer = false, username, action, password = null, ipKey = null, ip = null }) {
    if (!this.users || !this.sessions) throw new Error('admin.userAction needs users and sessions');
    if (!USER_ACTIONS.includes(action)) throw new ApiError(400, `action must be one of ${USER_ACTIONS.join(', ')}`, 'bad_request');
    const target = this.users.byName(username);
    if (!target) throw new ApiError(404, 'no such player', 'not_found');
    const by = actor?.id ?? null;
    const actorKind = by ? 'admin' : 'ops';
    const out = {};

    const revokeAndClose = () => {
      const ids = this.sessions.revokeAll(target.id);
      this.hooks.closeStreams?.({ uid: target.id, sessionIds: ids });
      return ids.length;
    };

    switch (action) {
      case 'make_admin':
      case 'remove_admin': {
        if (viaBearer || !actor) throw new ApiError(403, 'role changes need an admin session and password, not the admin token', 'session_required');
        const me = this.users.get(actor.id);
        if (!me || me.role !== 'admin' || me.status !== 'active') throw new ApiError(403, 'admins only', 'forbidden');
        const { ok } = await this.hasher.verify(typeof password === 'string' ? password : '', me.pw_hash, { ipKey });
        if (!ok) throw new ApiError(401, 'wrong username or password', 'bad_credentials');
        if (action === 'remove_admin' && target.role === 'admin' && this.users.countAdmins() <= 1) {
          throw new ApiError(409, 'cannot remove the last admin', 'conflict');
        }
        this.users.setRole(target.id, action === 'make_admin' ? 'admin' : 'player');
        revokeAndClose();
        break;
      }
      case 'disable': {
        if (by && target.id === by) throw new ApiError(409, 'you cannot disable yourself', 'conflict');
        this.users.setStatus(target.id, 'disabled');
        revokeAndClose();
        if (this.hooks.haltGarden) await this.hooks.haltGarden(target.id, { reason: 'disabled' });
        this.hooks.teardown?.(target.id); // after the flatten finished (§2.2)
        break;
      }
      case 'enable':
        this.users.setStatus(target.id, 'active');
        break;
      case 'halt':
        if (!this.hooks.haltGarden) throw new ApiError(503, 'gardens are not available', 'busy');
        await this.hooks.haltGarden(target.id, { reason: 'admin' });
        break;
      case 'revoke_sessions':
        out.revoked = revokeAndClose();
        break;
      case 'disconnect_testnet':
        await this.#wipeTestnet(target.id, 'admin_disconnect');
        break;
      case 'reset_password': {
        // The reset protects testnet keys from the operator: flatten + wipe FIRST, then issue the code.
        await this.#wipeTestnet(target.id, 'password_reset');
        const { code, expiresMs } = this.users.issueReset(target.id);
        this.audit({ action: 'password_reset_issued', actor: actorKind, userId: target.id, target: target.username, ip, ok: true });
        this.hooks.notifyUser?.(target.id, 'password_reset', {});
        out.code = code;
        out.expires_ms = expiresMs;
        break;
      }
      default:
        break;
    }
    this.audit({ action: 'admin_user', actor: actorKind, userId: target.id, target: target.username, ip, ok: true, detail: { reason: action } });
    const fresh = this.users.get(target.id);
    return { user: { ...publicUser(fresh), status: fresh.status }, ...out };
  }

  async #wipeTestnet(uid, reason) {
    if (this.hooks.disconnectTestnet) {
      await this.hooks.disconnectTestnet(uid, { reason });
      return;
    }
    // No gardens wired (or no testnet): wiping the stored key is still possible and is what matters for safety.
    wipeCredentials(this.db, uid, { now: this.now });
  }

  // -------------------------------------------------------------------------------------------
  // Status pieces (admin_status is assembled by WP4)

  /** {users, sessions_active, db:{size_bytes, wal_bytes}} */
  dbStatus() {
    return {
      users: this.db.prepare(SQL.countUsers).get().n,
      sessions_active: this.sessions ? this.sessions.countActive() : null,
      db: this.db.sizes(),
    };
  }
}

// ---------------------------------------------------------------------------------------------

function mergeCaps(current, patch) {
  if (patch !== null && patch !== undefined && (typeof patch !== 'object' || Array.isArray(patch))) {
    throw new ApiError(400, 'caps must be an object', 'bad_request');
  }
  const out = { paper: { ...current.paper }, testnet: { ...current.testnet } };
  for (const venue of Object.keys(patch ?? {})) {
    if (venue !== 'paper' && venue !== 'testnet') throw new ApiError(400, `unknown caps section '${clip(venue, 20)}'`, 'bad_request');
    const section = patch[venue];
    if (section === null || typeof section !== 'object' || Array.isArray(section)) {
      throw new ApiError(400, `caps.${venue} must be an object`, 'bad_request');
    }
    for (const [key, value] of Object.entries(section)) {
      const lim = CAP_LIMITS[key];
      if (!lim || !(key in DEFAULT_CAPS[venue])) throw new ApiError(400, `unknown cap '${venue}.${clip(key, 40)}'`, 'bad_request');
      const [min, max, integer] = lim;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
        throw new ApiError(400, `cap ${venue}.${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`, 'bad_request');
      }
      out[venue][key] = value;
    }
  }
  for (const venue of ['paper', 'testnet']) {
    if (out[venue].min_capital_usd > out[venue].max_bot_capital_usd) {
      throw new ApiError(400, `caps.${venue}: min_capital_usd must not exceed max_bot_capital_usd`, 'bad_request');
    }
  }
  if (out.testnet.max_bots > out.paper.max_bots) {
    throw new ApiError(400, 'caps.testnet.max_bots must not exceed caps.paper.max_bots (one plot per bot)', 'bad_request');
  }
  return out;
}

function cleanDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  for (const key of AUDIT_DETAIL_KEYS) {
    if (!(key in detail)) continue;
    const v = detail[key];
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string') out[key] = clip(v, 120);
    else if (key === 'caps' && typeof v === 'object') out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

function clip(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

function clampInt(value, min, max, dflt) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// server/auth/service.js — the auth and account ops as one service (PLATFORM.md §4.3, §4.6, §8.2).
//
// This composes Users, Sessions, PasswordHasher, RateLimiter and the audit log in the exact orders the contract
// fixes, so the HTTP layer (WP4) stays thin: each method takes a request context `rq` and the op's params, and
// returns `{payload, cookies}` (Set-Cookie strings to send) or throws an ApiError carrying `code` (and, for 429,
// `extra.retry_after_s` plus `headers['Retry-After']`; for a stale session cookie, `setCookies` to clear it).
//
//   rq = { ip: clientIp(req) result, userAgent: string|null, req: IncomingMessage, auth: sessions.authenticate(req) }
//
// Order of checks (§4.1, §4.5): login — per-IP bucket → per-username lockout (known-device exempt) → scrypt;
// sign-up — enumeration bucket → username/password validity and availability → per-IP, per-/48 and global creation
// budgets → scrypt → insert. A request refused by a limit never reaches scrypt.
// Every revocation path closes the matching SSE streams synchronously through hooks.closeStreams (§4.2).

import { ApiError } from '../live.js';
import { canonicalUsername, lockoutKey } from './passwords.js';
import { publicUser } from './users.js';

const BAD_CREDENTIALS = 'wrong username or password';

export class AuthService {
  /**
   * @param {object} deps
   * @param {import('./users.js').Users} deps.users
   * @param {import('./sessions.js').Sessions} deps.sessions
   * @param {import('./passwords.js').PasswordHasher} deps.hasher
   * @param {import('./ratelimit.js').RateLimiter} deps.limiter
   * @param {import('../admin.js').Admin} deps.admin            audit + signup mode
   * @param {import('../secrets.js').Secrets} deps.secrets     hmacName for unknown login_fail targets
   * @param {(line: string) => void} [deps.log]
   */
  constructor({ users, sessions, hasher, limiter, admin, secrets, log = () => {} }) {
    this.users = users;
    this.sessions = sessions;
    this.hasher = hasher;
    this.limiter = limiter;
    this.admin = admin;
    this.secrets = secrets;
    this.log = log;
    this.hooks = {
      closeStreams: null, // ({uid, sessionIds?}) => void — http.closeStreamsFor, synchronous
      deleteGarden: null, // async (uid, {force}) => {closed, testnet_left_open} — halt, flatten (≤ 15 s), teardown; may throw 409
      testnetLink: null, // (uid) => TestnetLink | null — cached, never spends HL weight
    };
  }

  setHooks(hooks) {
    Object.assign(this.hooks, hooks);
    return this;
  }

  // -------------------------------------------------------------------------------------------
  // Session helpers for the router

  /** The signed-in user, or 401 (session_expired + clear cookie when a stale cookie was sent, else auth_required). */
  requireUser(rq) {
    if (rq.auth?.user) return rq.auth.user;
    if (rq.req && this.sessions.presented(rq.req)) {
      throw Object.assign(new ApiError(401, 'your session has expired: please sign in again', 'session_expired'),
        { setCookies: [this.sessions.clearCookie()] });
    }
    throw new ApiError(401, 'sign in to do this', 'auth_required');
  }

  /** The signed-in admin, or 401 / 403 forbidden. */
  requireAdmin(rq) {
    const user = this.requireUser(rq);
    if (user.role !== 'admin') throw new ApiError(403, 'admins only', 'forbidden');
    return user;
  }

  // -------------------------------------------------------------------------------------------
  // auth_signup

  async signup(rq, { username, password, bootstrap_code = null, invite = null, lang = null } = {}) {
    const mode = this.admin.getSignupMode();
    const ipLogin = rq.ip.bucketKey('signup');
    const ip48 = rq.ip.bucketKey('signup48');
    const hasBootstrap = bootstrap_code !== null && bootstrap_code !== undefined && String(bootstrap_code).trim() !== '';
    // The first admin can always sign up with the operator's code, even while sign-ups are closed.
    if (mode === 'closed' && !hasBootstrap) throw new ApiError(403, 'sign-ups are closed', 'signup_closed');
    if (mode === 'invite' && !hasBootstrap && !invite) throw new ApiError(403, 'sign-ups need an invite code', 'signup_closed');

    // 1. the enumeration bucket: every attempt, including 409s
    this.limiter.enforce('signup_attempt_ip', ipLogin);
    // 2. validity and availability (400 / 403 / 409), before any budget or scrypt
    const { canonical, role } = this.users.checkSignup({ username, password, bootstrapCode: bootstrap_code });
    const inviteCode = mode === 'invite' && role !== 'admin' ? invite : null;
    if (inviteCode !== null && !this.users.inviteValid(inviteCode)) throw new ApiError(403, 'that invite code is not valid', 'signup_closed');
    // 3. creation budgets (refunded when the account is not created)
    const taken = [];
    try {
      this.limiter.enforce('signup_create_ip', ipLogin);
      taken.push(['signup_create_ip', ipLogin]);
      this.limiter.enforce('signup_create_48', ip48);
      taken.push(['signup_create_48', ip48]);
      this.limiter.enforce('signup_global', 'global', 1, { status: 503, code: 'signup_busy', message: 'too many new gardens right now: try again soon' });
      taken.push(['signup_global', 'global']);
    } catch (err) {
      for (const [scope, key] of taken) this.limiter.refund(scope, key);
      throw err;
    }
    // 4. scrypt + insert (users + gardens in one transaction)
    let user;
    try {
      user = await this.users.create({ username: canonical, password, bootstrapCode: bootstrap_code, invite: inviteCode, lang, ipKey: ipLogin });
    } catch (err) {
      for (const [scope, key] of taken) this.limiter.refund(scope, key);
      throw err;
    }
    // 5. session + cookies, 6. audit
    const s = this.sessions.create(user.id, { userAgent: rq.userAgent, ip: rq.ip.ip });
    this.#closeEvicted(user.id, s.revoked);
    this.#audit('signup', { userId: user.id, actor: 'user', rq });
    if (user.role === 'admin') this.#audit('admin_bootstrap', { userId: user.id, actor: 'user', rq, detail: { reason: 'bootstrap_code' } });
    return { payload: { user: publicUser(user) }, cookies: [s.cookie, this.sessions.knownDeviceCookie(user)] };
  }

  // -------------------------------------------------------------------------------------------
  // auth_login

  async login(rq, { username, password } = {}) {
    // 1. per-IP bucket (cheapest first)
    this.limiter.enforce('login_ip', rq.ip.bucketKey('login'));
    // 2. lockout (inside verify; a valid known-device cookie for THIS user is exempt), 3. one scrypt
    const candidate = this.users.byName(username);
    const knownDevice = candidate ? this.sessions.checkKnownDevice(rq.req, candidate) : false;
    const user = await this.users.verify(username, password, { knownDevice, ipKey: rq.ip.bucketKey('login') });
    if (!user) {
      this.#loginFail(rq, username, candidate);
      throw new ApiError(401, BAD_CREDENTIALS, 'bad_credentials');
    }
    if (user.status !== 'active') {
      this.#audit('login_fail', { userId: user.id, actor: 'user', rq, ok: false, detail: { reason: 'disabled' } });
      throw new ApiError(403, 'this account is disabled', 'account_disabled');
    }
    this.users.touchLogin(user.id);
    const s = this.sessions.create(user.id, { userAgent: rq.userAgent, ip: rq.ip.ip });
    this.#closeEvicted(user.id, s.revoked);
    this.#audit('login_ok', { userId: user.id, actor: 'user', rq });
    const payload = { user: publicUser(user) };
    // A pending operator reset is shown at the next sign-in (§4.6 step 8): "your password was reset by the operator".
    if (user.reset_hash) payload.notice = 'password_reset';
    return { payload, cookies: [s.cookie, this.sessions.knownDeviceCookie(user)] };
  }

  // -------------------------------------------------------------------------------------------
  // auth_logout / auth_logout_all

  logout(rq) {
    const auth = rq.auth;
    if (auth?.user) {
      const ok = this.sessions.revoke(auth.user.id, auth.session.publicId);
      if (ok) this.hooks.closeStreams?.({ uid: auth.user.id, sessionIds: [auth.session.publicId] });
      this.#audit('logout', { userId: auth.user.id, actor: 'user', rq });
    }
    return { payload: { ok: true }, cookies: [this.sessions.clearCookie()] };
  }

  logoutAll(rq) {
    const user = this.requireUser(rq);
    const ids = this.sessions.revokeAll(user.id);
    this.hooks.closeStreams?.({ uid: user.id, sessionIds: ids });
    this.#audit('logout_all', { userId: user.id, actor: 'user', rq, detail: { count: ids.length } });
    return { payload: { ok: true, revoked: ids.length }, cookies: [this.sessions.clearCookie()] };
  }

  // -------------------------------------------------------------------------------------------
  // me (200 for spectators)

  me(rq) {
    const auth = rq.auth;
    const user = auth?.user ?? null;
    return {
      mode: 'accounts',
      user: user ? publicUser(user) : null,
      session: user ? { created_ms: auth.session.createdMs, expires_ms: auth.session.expiresMs } : null,
      signup: this.admin.getSignupMode(),
      testnet: user && this.hooks.testnetLink ? this.hooks.testnetLink(user.id) ?? null : null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // account_password

  async changePassword(rq, { current_password, new_password } = {}) {
    const me = this.requireUser(rq);
    this.limiter.enforce('account_user', me.id);
    const row = this.users.get(me.id);
    const { ok } = await this.hasher.verify(typeof current_password === 'string' ? current_password : '', row.pw_hash,
      { ipKey: rq.ip.bucketKey('login') });
    if (!ok) throw new ApiError(401, BAD_CREDENTIALS, 'bad_credentials');
    const user = await this.users.setPassword(me.id, new_password, { ipKey: rq.ip.bucketKey('login') }); // 400 weak_password
    const ids = this.sessions.revokeAll(me.id);
    this.hooks.closeStreams?.({ uid: me.id, sessionIds: ids });
    const s = this.sessions.create(me.id, { userAgent: rq.userAgent, ip: rq.ip.ip });
    this.#audit('password_changed', { userId: me.id, actor: 'user', rq });
    return { payload: { ok: true }, cookies: [s.cookie, this.sessions.knownDeviceCookie(user)] };
  }

  // -------------------------------------------------------------------------------------------
  // account_delete

  async deleteAccount(rq, { password, confirm, force = false } = {}) {
    const me = this.requireUser(rq);
    this.limiter.enforce('account_user', me.id);
    if (confirm !== 'DELETE') throw new ApiError(400, "type DELETE to confirm", 'confirm_required');
    const row = this.users.get(me.id);
    const { ok } = await this.hasher.verify(typeof password === 'string' ? password : '', row.pw_hash, { ipKey: rq.ip.bucketKey('login') });
    if (!ok) throw new ApiError(401, BAD_CREDENTIALS, 'bad_credentials');
    // Garden halt (paper closes, testnet flattens ≤ 15 s), 409 testnet_positions_open without force, teardown —
    // all before the DELETE commits (§4.6 step 6, §2.2).
    let result = { closed: [], testnet_left_open: [] };
    if (this.hooks.deleteGarden) result = { ...result, ...(await this.hooks.deleteGarden(me.id, { force: force === true })) };
    this.users.remove(me.id); // wipe + retire + DELETE (cascade) + WAL checkpoint; idempotent
    this.hooks.closeStreams?.({ uid: me.id });
    this.#audit('account_deleted', { userId: me.id, actor: 'user', rq });
    return {
      payload: { deleted: true, closed: result.closed ?? [], testnet_left_open: result.testnet_left_open ?? [] },
      cookies: [this.sessions.clearCookie()],
    };
  }

  // -------------------------------------------------------------------------------------------
  // auth_reset (operator-issued code, §4.6 step 8)

  async reset(rq, { username, code, new_password } = {}) {
    this.limiter.enforce('reset_ip', rq.ip.bucketKey('login'));
    this.limiter.enforce('reset_user', lockoutKey(username));
    const user = await this.users.redeemReset(username, code, new_password, { ipKey: rq.ip.bucketKey('login') });
    if (!user) {
      this.#loginFail(rq, username, this.users.byName(username), 'reset_code');
      throw new ApiError(401, BAD_CREDENTIALS, 'bad_credentials');
    }
    const ids = this.sessions.revokeAll(user.id);
    this.hooks.closeStreams?.({ uid: user.id, sessionIds: ids });
    this.#audit('password_reset_used', { userId: user.id, actor: 'user', rq });
    // A disabled account can set its password (the code was right) but gets no session, as at sign-in.
    if (user.status !== 'active') throw new ApiError(403, 'this account is disabled', 'account_disabled');
    const s = this.sessions.create(user.id, { userAgent: rq.userAgent, ip: rq.ip.ip });
    return { payload: { user: publicUser(user) }, cookies: [s.cookie, this.sessions.knownDeviceCookie(user)] };
  }

  // -------------------------------------------------------------------------------------------
  // sessions / session_revoke (P1)

  listSessions(rq) {
    const me = this.requireUser(rq);
    return { rows: this.sessions.list(me.id, rq.auth.session.publicId) };
  }

  revokeSession(rq, { id } = {}) {
    const me = this.requireUser(rq);
    if (!this.sessions.revoke(me.id, typeof id === 'string' ? id : '')) {
      throw new ApiError(404, 'no such session', 'not_found');
    }
    this.hooks.closeStreams?.({ uid: me.id, sessionIds: [id] });
    const current = id === rq.auth.session.publicId;
    return { payload: { ok: true }, cookies: current ? [this.sessions.clearCookie()] : [] };
  }

  // -------------------------------------------------------------------------------------------

  /** login_fail audit: user_id for known names; for unknown ones only "h:" + HMAC(K_name, canonical)[0..16]. */
  #loginFail(rq, typed, user, reason = null) {
    const detail = reason ? { reason } : null;
    if (user) {
      this.#audit('login_fail', { userId: user.id, actor: 'user', rq, ok: false, detail });
      return;
    }
    const key = canonicalUsername(typed) ?? lockoutKey(typed);
    this.#audit('login_fail', { userId: null, actor: 'user', rq, ok: false, target: `h:${this.secrets.hmacName(key)}`, detail });
  }

  #closeEvicted(uid, revoked) {
    if (revoked?.length) this.hooks.closeStreams?.({ uid, sessionIds: revoked });
  }

  #audit(action, { userId = null, actor = 'user', rq = null, ok = true, target = null, detail = null }) {
    try {
      this.admin.audit({ action, actor, userId, target, ip: rq?.ip?.prefix?.() ?? null, ok, detail });
    } catch (err) {
      this.log(`[audit] write failed (${err.code ?? err.name})`);
    }
  }
}

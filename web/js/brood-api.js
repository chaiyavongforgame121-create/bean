/**
 * brood-api.js — the ONLY module that knows how to talk to the backend.
 *
 *   getMode()              GET /api/v1 → {auth: 'none'|'accounts', testnet: {enabled}, public_origin, command_policy}
 *   query(name, params)    GET  /api/v1/<name>?…   → parsed JSON, throws Error(server message) with .status/.code
 *   command(name, params)  POST /api/v1/<name>      → body, EVEN on error ({error, status, code?}); never throws
 *   stream(onEvent)        EventSource /api/v1/events/stream → onEvent(kind, record)
 *   restream()             close and reopen the stream (cookies apply when a stream connects)
 *   signup / login / logout / logoutAll / resetPassword     thin command() wrappers (accounts mode, PLATFORM §9.5)
 *   attachBus(bus)         where `auth:required` is dispatched (a 401 auth_required / session_expired)
 *   authSettled()          resolves once no session-changing command (SESSION_CHANGING_OPS) is in flight
 *
 * TWO SERVER MODES (PLATFORM §2.3), learned from GET /api/v1 by getMode():
 *   none      (local, single player) — everything below, exactly as before: an optional command token, and the
 *             base URL rules (`?api=` may point the page at another backend).
 *   accounts  (internet) — the page and the API share ONE origin: `?api=` / a stored base / <meta> pointing
 *             elsewhere are refused (console notice); the token functions are inert (the session cookie is the
 *             credential); fetches send cookies same-origin and commands carry only Content-Type + Accept.
 *
 * Backend base URL (none mode), first match wins:
 *   1. ?api=<url>                    (this page load only; an empty `?api=` resets to same origin
 *                                     and forgets a remembered base)
 *   2. localStorage["brood.api"]     (set explicitly with setBase())
 *   3. <meta name="brood-api" content="…">
 *   4. ""                            same origin (the server serves this page)
 *
 * Command token (none mode): one slot PER API ORIGIN — localStorage["brood.token"] for the page's own
 * origin (the usual same-origin garden), localStorage["brood.token@<origin>"] for any other.
 * `?token=…` is adopted once by adoptUrlParams() and then REMOVED from the address bar
 * (history.replaceState) so it does not linger in history, bookmarks or screenshots.
 * Hardening vs the studied client:
 *   - `?api=` is not persisted and only http(s) bases (or same-origin paths) are accepted;
 *   - a saved token is only ever sent to the origin it was saved for, and saving one for
 *     origin A can never overwrite the token of origin B;
 *   - an API chosen by a `?api=` link to ANOTHER origin is "untrusted": `?token=` in such a
 *     link is ignored, and setToken() refuses to save a typed token for it unless the caller
 *     passes { trustApi: true } after the user confirmed the host (the garden asks).
 *
 * Secrets (passwords, reset codes, API-wallet keys) only ever travel in a POST JSON body: never in a URL, never
 * logged, never stored. No side effects at import time: callers run adoptUrlParams() once at boot.
 */

/** Journal / SSE event kinds served by the backend (SPEC §4) — named listeners are attached for each. */
export const EVENT_KINDS = Object.freeze([
  'warmup_finished', 'tick_completed', 'busted',
  'bot_created', 'bot_order', 'bot_fill', 'bot_paused', 'bot_resumed', 'bot_closed',
  'live_error', 'live_halted', 'daemon_started',
  // accounts mode (PLATFORM §8.7): new global and per-player kinds, and the stream-only control frames
  'bot_sync', 'bot_fill_confirmed', 'testnet_account', 'credential_status', 'garden_rearmed', 'garden_reset',
  'password_reset', 'kill_switch', 'testnet_feed', 'session_ended', 'resync', 'server_restart',
]);

export const QUERY_TIMEOUT_MS = 30_000;
/** Commands get longer: `tick {n:60}` runs sixty engine bars back to back. */
export const COMMAND_TIMEOUT_MS = 120_000;

/** 401 codes that mean "this browser is not (or no longer) signed in" → `auth:required` (PLATFORM §9.5). */
export const AUTH_REQUIRED_CODES = Object.freeze(['auth_required', 'session_expired']);

const KEY_API = 'brood.api';
const KEY_TOKEN = 'brood.token';
/** Legacy (single-slot clients): which origin "brood.token" was bound to — migrated on first use. */
const KEY_TOKEN_ORIGIN = 'brood.token.origin';
/** What a header can carry: visible ASCII, no whitespace (the server enforces the same). */
const TOKEN_CHARS = /^[\x21-\x7e]+$/;

// ---------------------------------------------------------------- server mode

/** {auth, testnet, public_origin, command_policy} once getMode() answered; null before. */
let modeInfo = null;
let modePending = null;
let modeNoticeShown = false;

/** The server mode learned by getMode(), or null when not asked yet. */
export function currentMode() {
  return modeInfo;
}

/** True once the server said it runs with accounts. */
export function isAccountsMode() {
  return modeInfo?.auth === 'accounts';
}

/** For tests: forget the cached mode (and the injected bus with its burst memory). */
export function resetMode() {
  modeInfo = null;
  modePending = null;
  modeNoticeShown = false;
  bus = null;
  lastAuthRequired = { code: null, at: 0 };
}

function normMode(body) {
  return Object.freeze({
    auth: body?.auth === 'accounts' ? 'accounts' : 'none',
    testnet: Object.freeze({ enabled: body?.testnet?.enabled === true }),
    public_origin: typeof body?.public_origin === 'string' ? body.public_origin : null,
    command_policy: typeof body?.command_policy === 'string' ? body.command_policy : null,
  });
}

async function fetchIndex(base, timeoutMs) {
  const url = new URL(`${base}/api/v1`, pageHref()).toString();
  const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: timeoutSignal(timeoutMs) });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body || typeof body !== 'object' || body.api_version === undefined) throw apiError(`index: HTTP ${r.status}`, r.status);
  return body;
}

/**
 * Ask the server which mode it runs (PLATFORM §9.1 boot step 1), cached. The page's OWN origin is asked first: an
 * accounts server serves the page and the API together, and then any other base (`?api=`, stored, <meta>) is
 * refused. Only when the page's origin has no API (or runs none mode) does the configured base decide.
 * Throws like query() when no index answers.
 */
export async function getMode({ refresh = false, timeoutMs = QUERY_TIMEOUT_MS } = {}) {
  if (modeInfo && !refresh) return modeInfo;
  if (modePending && !refresh) return modePending;
  modePending = (async () => {
    const configured = rawBaseInfo(); // read before the mode is known (accounts mode refuses foreign bases)
    let own = null;
    let ownErr = null;
    try {
      own = await fetchIndex('', timeoutMs);
    } catch (e) {
      ownErr = e;
    }
    if (own?.auth === 'accounts') {
      modeInfo = normMode(own);
      noticeIgnoredBase(configured);
      return modeInfo;
    }
    const base = configured.base;
    if (own && (!base || sameOriginBase(base))) {
      modeInfo = normMode(own);
      return modeInfo;
    }
    if (base && !sameOriginBase(base)) {
      try {
        modeInfo = normMode(await fetchIndex(base, timeoutMs));
        return modeInfo;
      } catch (e) {
        throw isTimeout(e) ? apiError('index: timed out', 0) : e?.status !== undefined ? e : apiError(`index: ${e?.message || e}`, 0);
      }
    }
    throw ownErr?.status !== undefined ? ownErr : apiError(isTimeout(ownErr) ? 'index: timed out' : `index: ${ownErr?.message || ownErr}`, 0);
  })();
  try {
    return await modePending;
  } finally {
    modePending = null;
  }
}

/**
 * Before the server mode is known, a request to ANOTHER origin first waits for getMode(): an accounts server locks
 * the API to the page's own origin, so a crafted `?api=` link must not receive even the first public queries of a
 * page load (fail closed). Same-origin pages — the usual case — pay nothing. When the mode cannot be learned, the
 * none-mode base rules apply as before.
 */
async function modeGate() {
  if (modeInfo) return;
  const { base } = rawBaseInfo();
  if (!base || sameOriginBase(base)) return;
  try {
    await getMode();
  } catch {
    /* unknown mode: none-mode rules (as before the platform upgrade) */
  }
}

function noticeIgnoredBase(info) {
  if (modeNoticeShown) return;
  if (info.base && !sameOriginBase(info.base)) {
    modeNoticeShown = true;
    globalThis.console?.info?.(`[bean] this server runs with accounts: the page and its API share one origin, so the ${info.source} API base ${info.base} is ignored`);
  }
}

// ---------------------------------------------------------------- the injected bus (auth:required)

let bus = null;
let lastAuthRequired = { code: null, at: 0 };

/** Inject the page bus: a 401 auth_required / session_expired is dispatched on it as `auth:required` (§9.5). */
export function attachBus(b) {
  bus = b && typeof b.emit === 'function' ? b : null;
}

// ---------------------------------------------------------------- session-changing commands
//
// These commands replace or clear the session cookie (Set-Cookie on their answer). A request that was sent with the
// OLD cookie while one of them ran can come back `401 session_expired` although the browser is signed in again by
// then (a password change revokes every old session and issues a fresh one). Such a 401 is stale: it is not
// reported as `auth:required` — the next poll asks again with the current cookie. `authSettled()` lets the data
// layer wait until the cookie is final before it decides that a `session_ended` frame really ended the session.

/** Commands whose answer sets or clears the session cookie (PLATFORM §4.2, §8.2). */
export const SESSION_CHANGING_OPS = Object.freeze([
  'auth_signup', 'auth_login', 'auth_reset', 'auth_logout', 'auth_logout_all', 'account_password', 'account_delete',
]);

let authInFlight = 0;
/** Bumps whenever a session-changing command settles (the cookie may have changed). */
let authEpoch = 0;
let settleWaiters = [];

function authBegin() {
  authInFlight++;
}

function authEnd() {
  authInFlight = Math.max(0, authInFlight - 1);
  authEpoch++;
  if (authInFlight === 0) {
    const waiters = settleWaiters;
    settleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** Resolves once no session-changing command is in flight (at once when none is). */
export function authSettled() {
  return authInFlight === 0 ? Promise.resolve() : new Promise((resolve) => settleWaiters.push(resolve));
}

/**
 * Was the cookie a request carried still the current one when its answer came? (`self` = 1 when the request is
 * itself a session-changing command, which counts as in flight.)
 */
function cookieStillCurrent(epochAtStart, self = 0) {
  return authInFlight === self && authEpoch === epochAtStart;
}

function notifyAuthRequired(code, op) {
  if (!bus || !AUTH_REQUIRED_CODES.includes(code)) return;
  // tend() asks two user queries at once: one notice per burst is enough
  const now = Date.now();
  if (lastAuthRequired.code === code && now - lastAuthRequired.at < 1000) return;
  lastAuthRequired = { code, at: now };
  try {
    bus.emit('auth:required', { code, op });
  } catch (e) {
    globalThis.console?.error?.('auth:required handler failed', e);
  }
}

// ---------------------------------------------------------------- storage

/** localStorage read that never throws (private mode, blocked storage, Node). */
export function recall(key) {
  try {
    return globalThis.localStorage ? globalThis.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

/** localStorage write; null / "" removes the key. Never throws. */
export function remember(key, value) {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return;
    if (value === null || value === undefined || value === '') ls.removeItem(key);
    else ls.setItem(key, String(value));
  } catch {
    /* storage unavailable — the page still works, it just forgets */
  }
}

// ---------------------------------------------------------------- base URL

const pageHref = () => globalThis.location?.href || 'http://localhost/';

/** Origin of this page ("" when unknown). */
export function pageOrigin() {
  try {
    return new URL(pageHref()).origin;
  } catch {
    return '';
  }
}

function sameOriginBase(base) {
  try {
    return new URL(base || '/', pageHref()).origin === pageOrigin();
  } catch {
    return false;
  }
}

/**
 * Normalise a candidate base: "" (same origin), an absolute path ("/brood"),
 * or an absolute http(s) URL; trailing slashes stripped. Anything else → null.
 * A backslash is refused outright: URL parsing treats "\" like "/", so "/\evil.example"
 * would really be the protocol-relative "//evil.example". A path must stay on this origin.
 * In accounts mode only the page's own origin is accepted (PLATFORM §9.5).
 */
export function cleanBase(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/\/+$/, '');
  if (s === '') return '';
  if (s.includes('\\')) return null;
  if (s.startsWith('/')) {
    try {
      return new URL(s, pageHref()).origin === pageOrigin() ? s : null;
    } catch {
      return null;
    }
  }
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      if (isAccountsMode() && u.origin !== pageOrigin()) return null;
      return u.origin + u.pathname.replace(/\/+$/, '');
    }
  } catch {
    /* not a URL */
  }
  return null;
}

/**
 * Pure base resolution (exported for tests): ?api= → stored → meta → "".
 * → { base, source } with source 'url' | 'stored' | 'meta' | 'same'.
 */
export function resolveBaseInfo({ search = '', stored = null, meta = null } = {}) {
  const qs = new URLSearchParams(search);
  if (qs.has('api')) {
    const b = cleanBase(qs.get('api'));
    if (b !== null) return { base: b, source: b ? 'url' : 'same' }; // "" = explicit same origin
  }
  const fromStore = cleanBase(stored);
  if (fromStore) return { base: fromStore, source: 'stored' };
  const fromMeta = cleanBase(meta);
  if (fromMeta) return { base: fromMeta, source: 'meta' };
  return { base: '', source: 'same' };
}

/** Pure base resolution → the base string only. */
export function resolveBase(opts) {
  return resolveBaseInfo(opts).base;
}

function rawBaseInfo() {
  const meta = globalThis.document?.querySelector?.('meta[name="brood-api"]')?.getAttribute('content') ?? null;
  return resolveBaseInfo({ search: globalThis.location?.search || '', stored: recall(KEY_API), meta });
}

/** The effective base: cleanBase() already refuses other origins once accounts mode is known. */
const baseInfo = () => rawBaseInfo();

/** The backend base URL for this page ("" = same origin). */
export function getBase() {
  return baseInfo().base;
}

/** Remember a backend base for future visits (null / "" forgets it). */
export function setBase(url) {
  const b = cleanBase(url);
  remember(KEY_API, b || null);
  return getBase();
}

/** Origin the API lives on (used to bind the token). */
export function apiOrigin() {
  try {
    return new URL(getBase() || '/', pageHref()).origin;
  } catch {
    return '';
  }
}

/** True when the page talks to an API on another origin than its own (shown next to the 🔑). */
export function apiIsCrossOrigin() {
  return apiOrigin() !== pageOrigin();
}

/**
 * True when that other origin was chosen by a `?api=` link on THIS page load (not by the user's
 * setBase() or the page's own <meta>): anyone can craft such a link, so it gets no token silently.
 */
export function apiUntrusted() {
  return baseInfo().source === 'url' && apiIsCrossOrigin();
}

/** Absolute URL for an op: apiUrl('beans', {limit: 5}). Op names are snake_case only. */
export function apiUrl(name, params) {
  if (!/^[a-z][a-z0-9_]*$/.test(String(name))) throw new Error('invalid op name: ' + name);
  return urlFor(name, params);
}

function urlFor(path, params) {
  const u = new URL(getBase() + '/api/v1/' + path, pageHref());
  buildParams(params).forEach((v, k) => u.searchParams.set(k, v));
  return u.toString();
}

/**
 * Query-string params: undefined / null / "" are skipped, false and 0 are kept,
 * arrays become CSV (`ids=1,2,3`).
 */
export function buildParams(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return sp;
}

// ---------------------------------------------------------------- token (none mode only)

/** localStorage key of the token for API `origin`: the SPEC slot for our own origin, a keyed slot otherwise. */
export function tokenKey(origin = apiOrigin()) {
  return origin === pageOrigin() ? KEY_TOKEN : `${KEY_TOKEN}@${origin}`;
}

/** One-time move of a legacy single-slot token bound to another origin into that origin's own slot. */
function migrateLegacyToken() {
  const bound = recall(KEY_TOKEN_ORIGIN);
  if (!bound) return;
  remember(KEY_TOKEN_ORIGIN, null);
  if (bound === pageOrigin()) return; // already in the right slot
  const tok = recall(KEY_TOKEN);
  remember(KEY_TOKEN, null);
  if (tok && !recall(tokenKey(bound))) remember(tokenKey(bound), tok);
}

/** Why `token` cannot be used, or null: 'chars' = not visible ASCII / has whitespace (a header can't carry it). */
export function tokenProblem(token) {
  const tok = String(token ?? '').trim();
  return tok && !TOKEN_CHARS.test(tok) ? 'chars' : null;
}

function tokenError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Save (or with "" clear) the command token for the current API origin → true saved / false cleared.
 * Throws Error with `code`: 'chars' (unusable characters) or 'untrusted_api' (the API came from a
 * `?api=` link to another origin — pass { trustApi: true } only after the user confirmed that host).
 * Accounts mode: inert (→ false; nothing is stored) — the session cookie is the credential.
 */
export function setToken(token, { trustApi = false } = {}) {
  if (isAccountsMode()) return false;
  migrateLegacyToken();
  const tok = String(token ?? '').trim();
  const key = tokenKey();
  if (!tok) {
    remember(key, null);
    return false;
  }
  if (tokenProblem(tok)) throw tokenError('chars', 'a command token is visible ASCII without spaces');
  if (apiUntrusted() && !trustApi) throw tokenError('untrusted_api', `refusing to send a token to ${apiOrigin()} (set by a ?api= link)`);
  remember(key, tok);
  return true;
}

/** The token saved for the API origin we talk to now (never another origin's). Accounts mode: always null. */
export function getToken() {
  if (isAccountsMode()) return null;
  migrateLegacyToken();
  return recall(tokenKey()) || null;
}

export function hasToken() {
  return !!getToken();
}

/**
 * Boot-time URL handling: `?token=T` → saved, then stripped from the address
 * bar; `?token=` (empty) clears it; `?api=` (empty) forgets a remembered base.
 * A `?token=` that comes with a `?api=` pointing at another origin (or with unusable
 * characters) is stripped but NOT adopted: a crafted link must not plant or swap tokens.
 * Returns { token: boolean } — whether a token param was adopted — plus
 * `ignored: 'untrusted_api' | 'chars' | 'accounts'` when one was dropped.
 */
export function adoptUrlParams() {
  const loc = globalThis.location;
  if (!loc) return { token: false };
  let url;
  try {
    url = new URL(loc.href);
  } catch {
    return { token: false };
  }
  if (url.searchParams.has('api') && !url.searchParams.get('api')) remember(KEY_API, null);
  if (!url.searchParams.has('token')) return { token: false };
  let result = { token: true };
  if (isAccountsMode()) {
    result = { token: false, ignored: 'accounts' };
  } else if (apiUntrusted()) {
    result = { token: false, ignored: 'untrusted_api' };
  } else {
    try {
      setToken(url.searchParams.get('token') || '');
    } catch (e) {
      result = { token: false, ignored: e.code || 'chars' };
    }
  }
  url.searchParams.delete('token');
  try {
    globalThis.history?.replaceState(globalThis.history.state, '', url.pathname + url.search + url.hash);
  } catch {
    /* sandboxed frame: nothing more we can do */
  }
  return result;
}

// ---------------------------------------------------------------- HTTP

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function isTimeout(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

/** Error with an HTTP status attached (0 = network / timeout). */
function apiError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Seconds to wait from a 429/503 body (`retry_after_s`) or its Retry-After header, or null. */
function retryAfterOf(body, r) {
  const fromBody = Number(body?.retry_after_s);
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody;
  const fromHeader = Number(r?.headers?.get?.('Retry-After'));
  return Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : null;
}

/**
 * GET a query. Resolves to JSON; throws Error(server message) with `.status` (0 = unreachable) and, when the server
 * sent them, `.code`, `.retry_after_s` and `.body` (for localized errors, PLATFORM §9.5).
 */
export async function query(name, params = {}, { timeoutMs = QUERY_TIMEOUT_MS } = {}) {
  await modeGate();
  const epoch = authEpoch;
  let r;
  try {
    r = await fetch(apiUrl(name, params), {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: timeoutSignal(timeoutMs),
    });
  } catch (e) {
    throw apiError(isTimeout(e) ? `${name}: timed out` : `${name}: ${e?.message || e}`, 0);
  }
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const e = apiError((body && body.error) || `HTTP ${r.status}`, r.status);
    if (body && typeof body === 'object') {
      e.body = body;
      if (typeof body.code === 'string') e.code = body.code;
    }
    const retry = retryAfterOf(body, r);
    if (retry !== null && (r.status === 429 || r.status === 503)) e.retry_after_s = retry;
    if (r.status === 401 && cookieStillCurrent(epoch)) notifyAuthRequired(e.code, name);
    throw e;
  }
  if (body === null || typeof body !== 'object') throw apiError(`${name}: unexpected response`, r.status);
  return body;
}

/**
 * POST a command with a JSON body. Never throws: resolves to the response body, or to
 * `{error, status}` (plus the server's `code`, `retry_after_s`, …) on HTTP errors, network failures (status 0)
 * and timeouts. None mode adds the Bearer token when one is saved for this API; accounts mode sends only
 * Content-Type + Accept (the session cookie travels same-origin).
 */
export async function command(name, params = {}, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  await modeGate();
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const tok = getToken();
  if (tok) headers.Authorization = 'Bearer ' + tok;
  let url;
  try {
    url = apiUrl(name); // validates the op name before anything is counted
  } catch (e) {
    return { error: `${name}: ${e?.message || e}`, status: 0 };
  }
  const changesSession = SESSION_CHANGING_OPS.includes(name);
  const epoch = authEpoch;
  if (changesSession) authBegin();
  try {
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(params ?? {}),
        cache: 'no-store',
        credentials: 'same-origin',
        signal: timeoutSignal(timeoutMs),
      });
    } catch (e) {
      return { error: isTimeout(e) ? `${name}: timed out` : `${name}: ${e?.message || e}`, status: 0 };
    }
    const body = await r.json().catch(() => null);
    if (!r.ok) {
      const extra = body && typeof body === 'object' ? body : {};
      const out = { ...extra, error: extra.error || `HTTP ${r.status}`, status: extra.status || r.status };
      const retry = retryAfterOf(body, r);
      if (retry !== null && (r.status === 429 || r.status === 503) && out.retry_after_s === undefined) out.retry_after_s = retry;
      if (r.status === 401 && cookieStillCurrent(epoch, changesSession ? 1 : 0)) notifyAuthRequired(out.code, name);
      return out;
    }
    return body && typeof body === 'object' ? body : {};
  } finally {
    if (changesSession) authEnd();
  }
}

// ---------------------------------------------------------------- accounts: thin auth wrappers (PLATFORM §9.5)

/** Keep only the named fields that are present: an unknown field would be refused (400), and nothing is logged. */
function pick(params, names) {
  const out = {};
  for (const k of names) if (params?.[k] !== undefined && params[k] !== null && params[k] !== '') out[k] = params[k];
  return out;
}

/** auth_signup {username, password, bootstrap_code?, invite?, lang?} → {user} | {error, status, code}. */
export function signup(params) {
  return command('auth_signup', pick(params, ['username', 'password', 'bootstrap_code', 'invite', 'lang']));
}

/** auth_login {username, password} → {user, notice?} | {error, status, code}. */
export function login(params) {
  return command('auth_login', pick(params, ['username', 'password']));
}

/** auth_logout → {ok:true} (also without a session); the server clears the cookie. */
export function logout(params) {
  void params;
  return command('auth_logout', {});
}

/** auth_logout_all → {ok:true, revoked}. */
export function logoutAll(params) {
  void params;
  return command('auth_logout_all', {});
}

/** auth_reset {username, code, new_password} (an operator-issued reset code) → {user} | {error, status, code}. */
export function resetPassword(params) {
  return command('auth_reset', pick(params, ['username', 'code', 'new_password']));
}

// ---------------------------------------------------------------- SSE

/** `?nostream=1` disables the live stream (headless renders, flaky proxies). */
export function streamDisabled(search = globalThis.location?.search || '') {
  return new URLSearchParams(search).get('nostream') === '1';
}

/** The stream opened last: { es, onEvent, opts } (restream() reopens it). */
let current = null;

/**
 * Subscribe to the journal: onEvent(kind, record) for every EVENT_KINDS event
 * (and unnamed messages, keyed by record.kind). Returns the EventSource so the
 * caller can watch open/error and close it — or null when streaming is
 * disabled / unsupported. Reconnection is EventSource's own (server sends
 * `retry: 3000` and honours Last-Event-ID).
 * `opts.restart` (optional): the owner's own "reopen" routine; restream() calls it instead of reopening here,
 * so an owner that tracks its EventSource (core/data.js) never ends up with two.
 */
export function stream(onEvent, opts = {}) {
  const { onOpen, onError, kinds = EVENT_KINDS } = opts;
  if (streamDisabled() || typeof EventSource !== 'function') return null;
  let es;
  try {
    es = new EventSource(urlFor('events/stream'));
  } catch {
    return null;
  }
  const deliver = (name) => (msg) => {
    let rec;
    try {
      rec = JSON.parse(msg.data);
    } catch {
      return; // keep-alives and junk are ignored
    }
    if (!rec || typeof rec !== 'object') return;
    const kind = name || (typeof rec.kind === 'string' ? rec.kind : 'message');
    try {
      onEvent(kind, rec);
    } catch (e) {
      console.error('stream handler failed', e);
    }
  };
  for (const k of kinds) es.addEventListener(k, deliver(k));
  es.onmessage = deliver(null);
  if (onOpen) es.addEventListener('open', onOpen);
  if (onError) es.addEventListener('error', onError);
  current = { es, onEvent, opts };
  return es;
}

/**
 * Close and reopen the stream (PLATFORM §9.5): needed after sign-in / sign-out because the session cookie applies
 * when a stream connects. Delegates to the owner's `restart` when it gave one. → the new EventSource (or null).
 */
export function restream() {
  if (!current) return null;
  const { es, onEvent, opts } = current;
  if (typeof opts.restart === 'function') return opts.restart();
  try {
    es?.close();
  } catch {
    /* already closed */
  }
  return stream(onEvent, opts);
}

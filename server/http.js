// server/http.js — the HTTP door (SPEC §4; PLATFORM §2.3, §4.4, §4.5, §8, §10.4).
//
//   GET  /api/v1                 operation index (from catalog OPS)
//   GET  /api/v1/<query>?…       JSON query
//   POST /api/v1/<command>       JSON command
//   GET  /api/v1/events/stream   Server-Sent Events: journal records (with id:, Last-Event-ID replay) and
//                                ephemeral pulse frames such as `mids` (no id:, never replayed)
//   GET  /healthz  /readyz       process liveness / readiness (PLATFORM §10.4)
//   GET  /docs                   markdown reference generated from OPS
//   GET  /vendor/three/<path>    three.js browser build from node_modules (an exact allow-list; GAME-DESIGN §10.8)
//   GET  /…                      static files from web/
//
// TWO MODES, chosen once at the composition root (PLATFORM §2.3, §2.4):
//
//   none (default)  `createServer({engine, live, journal, pulse, config})` — exactly the SPEC §4 server: one implicit
//                   player, commands need the token or a same-origin loopback request (commandAuth), CORS `*`, query
//                   string and JSON body merged. Additive only: `auth`/`testnet` in the index, `me` and the testnet
//                   queries answer the local player, accounts-only ops answer 404 {code:'accounts_disabled'},
//                   `bot_create {venue:'testnet'}` answers 409 {code:'testnet_needs_accounts'}.
//
//   accounts        `createServer({engine, journal, pulse, platform, config: {auth:'accounts', publicOrigin, …}})`.
//                   Every request: security headers + Host check (421). Commands: query string refused (400) before
//                   the body is read → CSRF + Bearer rules (WP1 request guard, or the built-in §4.4 copy) → session
//                   (cookie) → access class (public | user | admin) → rate limits → JSON body (4 KB for sensitive
//                   ops) → handler. Errors always carry a machine `code` (catalog ERROR_CODES). The SSE stream is
//                   scoped per player with buffering budgets; closeStreamsFor() ends a revoked session's streams in
//                   the same tick.
//
// THE PLATFORM BAG (accounts mode; objects built by main.js; members marked ? are optional and have a fallback):
//   users         WP1 Users        checkSignup / create / verify (lockout inside) / get / byName / touchLogin /
//                                  setPassword / remove / redeemReset / adminExists
//   sessions      WP1 Sessions     create → {cookie, publicId, revoked} / authenticate / presented / stillValid /
//                                  revoke / revokeAll → public ids / list / countActive / clearCookie /
//                                  knownDeviceCookie / checkKnownDevice
//   gardens       WP3 Gardens      get / peek / venueFor / marksFor / resetSeason / deleteUser / teardown / killSwitch /
//                                  setCaps / setUserCaps / stats   (LiveLayer: bots / botDetail / status / fills / create /
//                                  pause / resume / close / halt / rearm / closeInBooks / testnetQuote? / testnetStatus?)
//   auth?         WP1 AuthService: signup / login / reset / logout / logoutAll / changePassword / deleteAccount /
//                                  listSessions / revokeSession (rq, params) → {payload, cookies}  (preferred; the
//                                  built-in flows below follow the same §4 orders and are used without it)
//   guard?        WP1 createRequestGuard(): check(req, {url, op, sessionCookieUsed, ip}) → {error, viaBearer}
//   checkCsrf?    WP1 checkCsrf(req, {publicOrigin, op, bearerPresent, directLoopback}) (used when no guard)
//   limiter?      WP1 RateLimiter take / check / refund with the RATE_LIMITS scope names (built-in buckets if absent)
//   clientIp?     WP1 createClientIp() resolver: (req) → {ip, source, bucketKey(scope), prefix()} (+ .stats.count())
//   streamSlots?  WP1 StreamSlots: acquire({uid, ipKey}) → {ok, release, reason}  (built-in counters if absent)
//   admin?        WP1 Admin        getKillSwitch / setKillSwitch / getSigningHalt / setSigningHalt / getSignupMode /
//                                  setCaps / setUserCaps / getCaps / audit / auditQuery / listUsers / userAction /
//                                  dbStatus / setHooks
//   secrets?      WP1 Secrets      hmacName (login_fail targets for unknown names)
//   db?           WP1 Db           ping() for /readyz; read-only fallbacks (bound constant SQL)
//   testnet?      WP2 createTestnet() → {market (cache reads only), verify, exchange, scheduler}
//   credentials?  WP3 Credentials  link / store / wipe        (testnet_connect / disconnect building blocks)
//   testnetLink?  a higher-level service, preferred when present: link / connect / verify / disconnect /
//                                  prepareAgent / approveAgent
//   backup?       async () → {file, bytes, ms}            (admin_backup)
//   backups?      WP1 Backups: last() → {last_backup_ms, last_backup_file}   (admin_status.db; else <data>/backups)
//   (the data dir — /readyz "writable" check, backups — is config.dataDir, else the directory of platform.db.file)
//   devDouble?    {fault(name, args)}                      (dev_double, only with --testnet-double)
//   adminStatus?  () → object merged into admin_status   (extra operator numbers)
//   readiness?    () → {ok, why}                          (an extra /readyz condition)
//
// createServer() only builds the node:http Server; the caller decides when and where to listen. The returned server
// also carries closeStreamsFor({uid, sessionIds?, reason?}), beginShutdown() and streamStats().

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  OPS, findOp, opInMode, coerceParams, docsMarkdown, SCALES, COLUMNS, SORT_KEYS, EVENT_KINDS, STREAM_ONLY_KINDS,
  ACCOUNTS_EVENT_KINDS, ACCOUNTS_STREAM_ONLY_KINDS, VENUES, isErrorCode, DEFAULT_CODE_BY_STATUS, NONE_MODE_CODES,
} from './catalog.js';
import { ApiError, awaitWithin } from './live.js';
import { GLOBAL_KINDS } from './journal.js';
import { ARCHETYPES } from './population.js';
import { STRATEGY_NAMES } from './strategies.js';
import { COINS } from './market.js';
import { REAL_TICK_REFUSAL } from './engine.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WEB_DIR = path.join(PROJECT_ROOT, 'web');
const DEFAULT_THREE_DIR = path.join(PROJECT_ROOT, 'node_modules', 'three');

/**
 * The ONLY files /vendor/three/ serves (relative to node_modules/three), with their content types. The page imports
 * three exclusively through web/js/game/three.js → /vendor/three/build/three.module.min.js (no import map, so the
 * CSP stays script-src 'self').
 */
const VENDOR_PREFIX = '/vendor/three/';
const VENDOR_FILES = new Map([
  ['build/three.module.min.js', 'text/javascript; charset=utf-8'],
  ['build/three.module.js', 'text/javascript; charset=utf-8'],
  ['LICENSE', 'text/plain; charset=utf-8'],
]);

const API_PREFIX = '/api/v1';
const STREAM_PATH = `${API_PREFIX}/events/stream`;
const OP_PATH_RE = /^\/api\/v1\/([A-Za-z0-9_]+)$/;
const MAX_BODY_BYTES = 64 * 1024;
/** Auth and credential ops (the sensitive ones) take at most 4 KB (PLATFORM §4.5). */
const MAX_SENSITIVE_BODY_BYTES = 4 * 1024;
const SSE_PING_MS = 15_000;
const SSE_MAX_BUFFERED = 1 << 20; // none mode: drop a stream whose client stopped reading (1 MB queued)
const CAPITAL_PER_BEAN = 1000;

/**
 * Accounts-mode SSE limits (PLATFORM §4.5). Tests may override any of them with `config.sse`.
 *   perUser / perIp / total / spectators   concurrent streams (the IP is bucketed at /56 for IPv6)
 *   streamBytes   bytes queued on one stream before it is dropped (none mode keeps 1 MB)
 *   globalBytes   bytes queued across all streams; above it the stream with the most queued bytes is dropped
 *   openCost      query tokens an open costs (a reconnect with Last-Event-ID runs a replay query)
 *   recheckMs     backstop re-check of the session (expiry, disabled user); revocations close streams at once
 */
export const SSE_LIMITS = Object.freeze({
  perUser: 5, perIp: 20, total: 2000, spectators: 1000,
  streamBytes: 128 * 1024, globalBytes: 64 * 1024 * 1024, openCost: 10, recheckMs: 60_000,
});

const HOUR_S = 3600;
/**
 * The rate-limit scopes this module uses (PLATFORM §4.5), with WP1's names (server/auth/ratelimit.js
 * DEFAULT_SCOPES): a platform limiter is asked with exactly these names; the built-in buckets implement the same
 * table when there is none. Keys: per IP → the client-IP bucket; per user → `u:<uid>`; reset_user → the typed name.
 */
export const RATE_LIMITS = Object.freeze({
  queries_ip: { capacity: 120, perS: 10 }, //                every query; an SSE open costs 10
  commands_user: { capacity: 60, perS: 1 }, //               every command per user (per IP for anonymous ones)
  bot_create_user: { capacity: 10, perS: 10 / 60 }, //       bot_create per user
  login_ip: { capacity: 10, perS: 1 / 90 }, //               auth_login per IP (/56)
  signup_attempt_ip: { capacity: 10, perS: 10 / HOUR_S }, // EVERY sign-up attempt per IP (/56): the enumeration bucket
  signup_create_ip: { capacity: 3, perS: 3 / HOUR_S }, //    successful creations per IP (/56)
  signup_create_48: { capacity: 10, perS: 10 / HOUR_S }, //  successful creations per /48
  signup_global: { capacity: 60, perS: 60 / HOUR_S }, //     SIGNUP_MAX_PER_HOUR → 503 signup_busy
  reset_ip: { capacity: 5, perS: 5 / HOUR_S }, //            auth_reset per IP
  reset_user: { capacity: 5, perS: 5 / HOUR_S }, //          auth_reset per username
  account_user: { capacity: 5, perS: 5 / 900 }, //           account_password / account_delete per user
  testnet_connect_user: { capacity: 5, perS: 5 / HOUR_S }, // connects / verifies that reach Hyperliquid
  admin_token_ip: { capacity: 5, perS: 5 / 900 }, //         failed Bearer admin tokens per IP
  admin_backup: { capacity: 1, perS: 1 / 600 }, //           global
});

const AUTH_DENIED = 'command needs a token (or a same-origin request from loopback)';

/** Headers that mean "a proxy is in between" — such requests never get the none-mode loopback exemption. */
const PROXY_HEADERS = ['x-forwarded-for', 'cf-connecting-ip', 'x-real-ip', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto'];
/** Accounts mode's directLoopback() also refuses the edge headers of Fly and other CDNs (PLATFORM §4.4). */
const ACCOUNTS_PROXY_HEADERS = [...PROXY_HEADERS, 'fly-client-ip', 'true-client-ip'];

/** Host header allowlist for tokenless commands (anti DNS-rebinding): name + optional port. */
const LOOPBACK_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

/** Session cookie names (PLATFORM §4.2): `__Host-` over https, the plain name on http localhost. */
const SESSION_COOKIES = ['__Host-bean_sid', 'bean_sid'];

/** Reserved usernames (PLATFORM §4.1): a cheap pre-check only when Users has no checkSignup(). */
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'system', 'operator', 'support', 'bean', 'beans', 'garden', 'api', 'local', 'null',
  'undefined', 'testnet', 'mainnet', 'hyperliquid', 'me', 'you',
]);
const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

/** secp256k1 group order n: an agent key must be a scalar in [1, n−1] (checked here, before any library, §5.3). */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Testnet caps (PLATFORM §7.3) as published when no garden reports its own. */
const TESTNET_CAPS_DEFAULT = Object.freeze({ max_bots: 3, min_capital_usd: 20, max_bot_capital_usd: 500, max_total_notional_usd: 3000 });
const KILL_SWITCH_OFF = Object.freeze({ on: false, reason: null, since_ms: null });
/** Codes of a testnet_connect refusal that never count against the 5-per-hour connect limit (§4.5, §6.7). */
const UNCOUNTED_CONNECT_CODES = new Set(['bad_address', 'bad_key_format', 'seed_phrase', 'busy', 'testnet_down', 'testnet_disabled']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/**
 * CSP for static pages. The garden is same-origin with the API and may run tokenless loopback commands,
 * so script injection would mean command control: only our own files may run (no inline script, no eval).
 * connect-src stays open to http(s) in none mode because `?api=` / <meta name="brood-api"> may point at another
 * backend; accounts mode serves page and API from ONE origin, so it is `'self'` there (PLATFORM §10.4).
 * img-src allows data: for the inline favicon.
 */
const cspWith = (connectSrc) => [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  `connect-src ${connectSrc}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const STATIC_CSP = cspWith("'self' http: https:");
const ACCOUNTS_STATIC_CSP = cspWith("'self'");

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
};

/** Error helper: an ApiError with a machine code (PLATFORM §8.9) and optional extra body fields. */
function apiError(status, message, code = null, extra = null) {
  const err = new ApiError(status, message);
  if (code) err.code = code;
  if (extra && typeof extra === 'object') err.extra = { ...(err.extra || {}), ...extra };
  return err;
}

function rateLimited(retryAfterS, message = 'too many requests; slow down and retry later') {
  const s = Math.max(1, Math.ceil(Number(retryAfterS) || 1));
  return apiError(429, message, 'rate_limited', { retry_after_s: s });
}

// ---------------------------------------------------------------------------------------------
// Public entry point

/**
 * Build the HTTP server.
 *
 * @param {object} deps
 * @param {import('./engine.js').Engine} deps.engine
 * @param {import('./live.js').LiveLayer} [deps.live]  none mode: the one garden (accounts mode uses platform.gardens)
 * @param {import('./journal.js').Journal} deps.journal
 * @param {import('./pulse.js').Pulse} [deps.pulse]  ephemeral stream-only frames (`mids`); optional
 * @param {object} [deps.platform]  accounts mode only: the platform bag (see the file header)
 * @param {object} [deps.config]
 * @param {'none'|'accounts'} [deps.config.auth]  'accounts' selects the accounts pipeline; anything else = none mode
 * @param {string|null} [deps.config.token]   none mode: command token (null/'' = none → command_policy "loopback")
 * @param {boolean} [deps.config.loopbackCommands] none mode: false = token only, no tokenless loopback rule
 * @param {string} [deps.config.publicOrigin]  accounts mode (required): e.g. https://bean.example.com
 * @param {string|null} [deps.config.adminToken] accounts mode, built-in guard only: the Bearer ADMIN_TOKEN (≥ 32 chars)
 * @param {boolean} [deps.config.adminTokenRemote] accounts mode, built-in guard only: also accept it through a proxy
 * @param {'open'|'invite'|'closed'} [deps.config.signupMode] accounts mode (default 'open'; admin_state overrides)
 * @param {boolean} [deps.config.testnetEnabled] accounts mode: TESTNET_ENABLED=1 (real feed, master key present)
 * @param {boolean} [deps.config.testnetDouble] accounts mode: --testnet-double (the in-process double is the testnet)
 * @param {number} [deps.config.testnetMaxActiveUsers] reported by admin_status
 * @param {string} [deps.config.dataDir]       /readyz checks it is writable; admin_status looks for backups in it
 * @param {object} [deps.config.sse]           overrides of SSE_LIMITS (tests)
 * @param {string} [deps.config.version]      reported by the index and /docs (default: package.json)
 * @param {string} [deps.config.feed]         'sim' | 'hyperliquid' — fallback when the engine has no market source
 * @param {string} [deps.config.webDir]       static root (default <project>/web)
 * @param {string} [deps.config.threeDir]     three.js package dir for /vendor/three (default <project>/node_modules/three)
 * @param {number} [deps.config.ssePingMs]    keep-alive comment interval (default 15000)
 * @param {(line: string) => void} [deps.config.log]
 * @returns {http.Server} not listening yet. Its close() also ends open event streams.
 */
export function createServer({ engine, live = null, journal, pulse = null, platform = null, config = {} }) {
  const mode = config.auth === 'accounts' ? 'accounts' : 'none';
  const token = typeof config.token === 'string' && config.token.length > 0 ? config.token : null;
  // Rule 2 (tokenless same-origin loopback) can only be switched off when a token exists — otherwise
  // nothing could ever run a command.
  const loopbackCommands = config.loopbackCommands !== false || !token;
  const ctx = {
    mode,
    engine,
    live,
    journal,
    pulse: pulse && typeof pulse.subscribe === 'function' ? pulse : null,
    platform: platform ?? {},
    config,
    token: mode === 'none' ? token : null, // accounts mode never accepts the none-mode token (§2.3)
    loopbackCommands,
    feed: config.feed ?? 'sim',
    version: config.version ?? packageVersion(),
    webDir: path.resolve(config.webDir ?? DEFAULT_WEB_DIR),
    webDirReal: null, // realpath of webDir, resolved on first static request
    threeDir: path.resolve(config.threeDir ?? DEFAULT_THREE_DIR),
    ssePingMs: config.ssePingMs ?? SSE_PING_MS,
    log: config.log ?? console.log,
    streams: new Set(), // open SSE streams: { cleanup, res, uid, publicId, ipKey, spectator, queued, … }
    coinCountCache: { key: null, counts: null },
    staticCsp: STATIC_CSP,
    startedMs: Date.now(),
    shuttingDown: false,
    timers: [],
    warned: new Set(),
  };
  if (mode === 'accounts') setupAccounts(ctx);
  ctx.handlers = mode === 'accounts' ? makeAccountsHandlers(ctx) : makeHandlers(ctx);

  // Fail fast if the catalogue and the dispatch table ever disagree.
  for (const op of OPS) {
    if (opInMode(op, mode) && typeof ctx.handlers[op.name] !== 'function') throw new Error(`http: no handler for op '${op.name}'`);
  }

  const server = http.createServer((req, res) => {
    const call = newCall(ctx, req, res);
    route(ctx, call).catch((err) => sendError(ctx, call, err));
  });

  // Event streams never end on their own, so close() would wait forever: end them first.
  const close = server.close.bind(server);
  server.close = (callback) => {
    for (const s of [...ctx.streams]) {
      s.cleanup();
      s.res.destroy();
    }
    for (const t of ctx.timers) clearInterval(t);
    ctx.loopDelay?.disable();
    return close(callback);
  };
  /** End the streams of one player (all, or only those of `sessionIds`) with `event: session_ended` (§8.7). */
  server.closeStreamsFor = (opts) => closeStreamsFor(ctx, opts);
  /** Graceful shutdown steps 1–2 (§10.4): commands answer 503, /readyz 503, streams get `server_restart` and end. */
  server.beginShutdown = () => beginShutdown(ctx);
  server.streamStats = () => sseStats(ctx);
  server.apiMode = mode;
  return server;
}

/** Per-request state shared by the router, the gate, the handlers and the error path. */
function newCall(ctx, req, res) {
  return {
    req, res, url: null,
    op: null, sensitive: false,
    user: null, session: null, uid: null, staleCookie: false, sessionResolved: false,
    bearer: false, // a valid admin Bearer token was presented (accounts mode)
    cors: ctx.mode === 'none', // accounts mode: only public GET queries carry ACAO *
    ipInfo: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Accounts-mode setup

function setupAccounts(ctx) {
  const { platform: P, config } = ctx;
  const missing = ['users', 'sessions', 'gardens'].filter((k) => !P[k]);
  if (missing.length) throw new TypeError(`http: accounts mode needs platform.${missing.join(', platform.')}`);
  let publicUrl;
  try {
    publicUrl = new URL(String(config.publicOrigin ?? ''));
  } catch {
    throw new TypeError('http: accounts mode needs config.publicOrigin (an absolute http(s) origin)');
  }
  if (publicUrl.protocol !== 'https:' && publicUrl.protocol !== 'http:') throw new TypeError('http: publicOrigin must be http(s)');
  ctx.publicOrigin = publicUrl.origin;
  ctx.publicHost = publicUrl.host.toLowerCase();
  ctx.https = publicUrl.protocol === 'https:';
  ctx.adminToken = typeof config.adminToken === 'string' && config.adminToken.length >= 32 ? config.adminToken : null;
  ctx.adminTokenRemote = config.adminTokenRemote === true;
  ctx.testnetEnabled = config.testnetEnabled === true || config.testnetDouble === true;
  ctx.staticCsp = ACCOUNTS_STATIC_CSP;
  ctx.securityHeaders = [
    ['Cross-Origin-Opener-Policy', 'same-origin'],
    ['Cross-Origin-Resource-Policy', 'same-origin'],
    ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
  ];
  if (ctx.https) ctx.securityHeaders.push(['Strict-Transport-Security', 'max-age=31536000; includeSubDomains']);
  ctx.sseCfg = { ...SSE_LIMITS, ...(config.sse || {}) };
  ctx.sse = { byUser: new Map(), byIp: new Map(), spectators: 0, buffered: 0 };
  const signupMax = Number(config.signupMaxPerHour) > 0 ? Number(config.signupMaxPerHour) : 60;
  ctx.builtinLimiter = new TokenBuckets({ ...RATE_LIMITS, signup_global: { capacity: signupMax, perS: signupMax / HOUR_S } });
  ctx.limiterFallback = new Set(); // scopes the platform limiter refused (logged once each)
  ctx.lastIpSource = 'socket';
  ctx.ipSeen = new Map(); // fallback for admin_status.client_ip.buckets_1h when clientIp has no stats
  ctx.midsMemo = { msg: null, shared: null, byUid: new Map() };
  ctx.recordText = new WeakMap(); // journal record → its SSE frame (shared by every stream)
  try {
    ctx.loopDelay = monitorEventLoopDelay({ resolution: 20 });
    ctx.loopDelay.enable();
    const t = setInterval(() => {
      ctx.loopP99 = ctx.loopDelay.percentile(99) / 1e6;
      ctx.loopDelay.reset();
    }, 60_000);
    t.unref?.();
    ctx.timers.push(t);
  } catch {
    ctx.loopDelay = null;
  }
  wireAdminHooks(ctx);
  wireAuthHooks(ctx);
}

/**
 * WP1's Admin service performs the admin_user actions and needs garden/stream side effects as hooks. Fill in the
 * ones the composition root has not set: closing streams is this module's job, the rest map onto the bag.
 */
function wireAdminHooks(ctx) {
  const P = ctx.platform;
  const hooks = P.admin?.hooks;
  if (typeof P.admin?.setHooks !== 'function' || !hooks) return;
  const add = {};
  if (!hooks.closeStreams) add.closeStreams = (o) => closeStreamsFor(ctx, { reason: 'revoked', ...o });
  if (!hooks.notifyUser) add.notifyUser = (uid, kind, data) => ctx.journal.emit(kind, data ?? {}, { uid });
  if (!hooks.haltGarden) {
    add.haltGarden = async (uid, { reason = 'admin' } = {}) => {
      if (typeof P.gardens.haltAndWait === 'function') return P.gardens.haltAndWait(uid, { reason });
      const g = P.gardens.get(uid);
      return typeof g?.halt === 'function' ? g.halt() : null;
    };
  }
  if (!hooks.teardown && typeof P.gardens.teardown === 'function') add.teardown = (uid) => P.gardens.teardown(uid);
  if (!hooks.disconnectTestnet && (P.testnetLink?.disconnect || P.credentials?.wipe)) {
    add.disconnectTestnet = (uid, { reason } = {}) => disconnectFlow(ctx, uid, { closeBots: true, force: true, by: 'admin', reason });
  }
  if (Object.keys(add).length) P.admin.setHooks(add);
}

/**
 * WP1's AuthService needs the garden side of account deletion and the testnet link for `me` as hooks. Fill the
 * missing ones. (Its closeStreams hook is left alone: http.js ends the streams itself after every revocation.)
 */
function wireAuthHooks(ctx) {
  const P = ctx.platform;
  const hooks = P.auth?.hooks;
  if (typeof P.auth?.setHooks !== 'function' || !hooks) return;
  const add = {};
  if (!hooks.deleteGarden) {
    add.deleteGarden = (uid, { force = false } = {}) => (typeof P.gardens.deleteUser === 'function'
      ? P.gardens.deleteUser(uid, { force, remove: () => {} }) // the service runs Users.remove itself
      : haltForDelete(ctx, uid, force));
  }
  if (!hooks.testnetLink && (P.testnetLink?.link || P.credentials?.link)) {
    add.testnetLink = (uid) => (P.testnetLink?.link ?? P.credentials.link).call(P.testnetLink?.link ? P.testnetLink : P.credentials, uid);
  }
  if (Object.keys(add).length) P.auth.setHooks(add);
}

/** Log a message once per key (integration gaps, unknown codes) instead of on every request. */
function warnOnce(ctx, key, line) {
  if (ctx.warned.has(key)) return;
  ctx.warned.add(key);
  ctx.log(line);
}

// ---------------------------------------------------------------------------------------------
// Dispatch tables: op name → (typed params, call) => payload (or a promise of one)

/** Engine queries shared by both modes (public, never user-scoped). */
function engineQueries(ctx) {
  const { engine } = ctx;
  const population = () => engine.population;
  return {
    health: () => engine.health(),
    status: () => engine.status(),
    // Engine.marketView() uses the population's per-coin counters; fall back to a cached row scan.
    market: () => (typeof engine.marketView === 'function' ? engine.marketView() : marketPayload(ctx)),
    bean_detail: ({ id }, call) => {
      const venue = call?.uid != null ? ctx.platform.gardens?.venueFor?.(call.uid) : null;
      const detail = venue ? population().detail(id, { venue }) : population().detail(id);
      if (!detail) throw new ApiError(404, `bean ${id} not found`);
      return detail;
    },
    equity_curves: ({ ids }) => ({ capital: CAPITAL_PER_BEAN, curves: population().curves(ids) }),
  };
}

function metaPayload(ctx) {
  const accounts = ctx.mode === 'accounts';
  return {
    archetypes: ARCHETYPES,
    strategies: STRATEGY_NAMES,
    // the live listing: with real prices, Hyperliquid's szDecimals / maxLeverage (same as coinInfo and the caps)
    coins: ctx.engine.market?.coins ?? COINS,
    scales: SCALES,
    columns: COLUMNS,
    sort_keys: SORT_KEYS,
    events: accounts ? [...EVENT_KINDS, ...ACCOUNTS_EVENT_KINDS] : EVENT_KINDS,
    stream_only_events: accounts ? [...STREAM_ONLY_KINDS, ...ACCOUNTS_STREAM_ONLY_KINDS] : STREAM_ONLY_KINDS,
    ...(accounts ? { venues: VENUES } : {}),
  };
}

/** None mode: the SPEC §4 table (one LiveLayer), plus the additive local-player answers of PLATFORM §8.8. */
function makeHandlers(ctx) {
  const { engine, live, journal } = ctx;
  const population = () => engine.population;

  return {
    // queries
    ...engineQueries(ctx),
    meta: () => metaPayload(ctx),
    beans: (p) => ({ ...population().query(p), venue: { known: true, network: 'sim' } }),
    bots: ({ state }) => live.bots({ state }),
    bot_detail: ({ id }) => live.botDetail(id),
    live_status: () => live.status(),
    live_fills: ({ bot, limit }) => live.fills({ bot, limit }), // `season` is accounts-only: ignored here
    events: ({ kind, limit, offset }) => journal.query({ kind, limit, offset }),
    me: () => LOCAL_ME,
    testnet_market: () => disabledTestnetMarket(ctx, 'needs_accounts'),
    testnet_status: () => disabledTestnetStatus(),
    testnet_quote: () => disabledQuote('testnet_needs_accounts'),

    // commands
    bot_create: ({ venue, ack_divergence: _ack, ...rest }) => {
      // PLATFORM §8.8: testnet needs accounts; `venue: 'paper'` is accepted and ignored.
      if (venue === 'testnet') {
        throw apiError(409, 'testnet bots need a server with accounts (--auth accounts)', 'testnet_needs_accounts');
      }
      return live.create(rest); // { bean, capital_usd, confirm? }
    },
    bot_pause: ({ id }) => live.pause({ id }),
    bot_resume: ({ id }) => live.resume({ id }),
    bot_close: ({ id }) => live.close({ id }),
    bots_halt: () => live.halt(),
    tick: ({ n }) => tickOp(ctx, n),
  };
}

/** `tick`: sim only. Real prices run at market speed: one bar per real minute (refused outright, not just n > 1). */
function tickOp(ctx, n) {
  const source = ctx.engine.market?.source ?? ctx.feed;
  if (source !== 'sim') throw new ApiError(409, REAL_TICK_REFUSAL);
  return ctx.engine.advance(n);
}

/** None mode `me` (PLATFORM §8.2): the implicit local player, so the frontend runs one code path. */
const LOCAL_ME = Object.freeze({
  mode: 'none',
  user: Object.freeze({ id: 0, username: 'local', role: 'admin', created_ms: null, lang: null }),
  session: null,
  signup: 'closed',
  testnet: null,
});

/** `market` payload: the feed snapshot plus how many beans trade / are positioned on each coin. */
function marketPayload(ctx) {
  const market = ctx.engine.market;
  const counts = coinCounts(ctx);
  const status = market.status();
  return {
    market_time_ms: market.timeMs,
    feed_ok: Boolean(status?.ok),
    coins: market.snapshot().map((c) => {
      const n = counts.get(c.coin);
      return { ...c, beans: n?.beans ?? 0, positioned: n?.positioned ?? 0 };
    }),
  };
}

/** Per-coin {beans, positioned}. Scans the population once per bar (cached on the bar index). */
function coinCounts(ctx) {
  const population = ctx.engine.population;
  const key = `${ctx.engine.market.barIdx}`;
  const cache = ctx.coinCountCache;
  if (cache.counts && cache.key === key && cache.population === population) return cache.counts;

  const counts = new Map();
  for (let id = 0; id < population.size; id++) {
    const row = population.row(id);
    if (!row) continue;
    let c = counts.get(row.coin);
    if (!c) counts.set(row.coin, (c = { beans: 0, positioned: 0 }));
    c.beans++;
    if (row.side) c.positioned++;
  }
  Object.assign(cache, { key, population, counts });
  return counts;
}

// ---- testnet payloads that need no testnet (none mode, or the testnet disabled server-wide) ----

/** Our 16 coin names, in listing order. */
function coinNames(ctx) {
  const list = ctx.engine.market?.coins ?? COINS;
  return list.map((c) => (typeof c === 'string' ? c : c.coin)).filter((c) => typeof c === 'string');
}

function disabledTestnetMarket(ctx, reason) {
  return {
    enabled: false,
    state: 'disabled',
    state_reason: reason,
    kill_switch: { ...KILL_SWITCH_OFF }, // a disabled venue has no switch to show players (admin_status reports it)
    mids_ms: null,
    ctx_ms: null,
    coins: coinNames(ctx).map((coin) => ({
      coin, index: null, sz_decimals: null, max_leverage: null, delisted: false, only_isolated: false,
      mid: null, mid_ms: null, mark_px: null, funding_1h: null, tradeable: false,
    })),
  };
}

function disabledTestnetStatus(link = null) {
  return {
    link,
    state: 'disabled',
    account: null,
    positions: [],
    requests: null,
    expiry: { valid_until_ms: link?.valid_until_ms ?? null, warn: null },
    caps: { ...TESTNET_CAPS_DEFAULT },
  };
}

/** A testnet quote that refuses with `reason` (every §8.3 key present, numbers null). */
function disabledQuote(reason) {
  return {
    ok: false, reason, venue_ok: false, venue_reason: reason,
    coin: null, asset: null, sz_decimals: null, leverage: null, testnet_mid: null, testnet_mid_ms: null, mainnet_mid: null,
    divergence: null, k: null, target_sz: null, notional_usd: null, margin_usd: null, liq_move_pct: null, fees_est_usd: null, fee_open_usd: null, need_leverage: null, max_leverage: null,
    slippage_max_usd: null, flatten_slippage_max_usd: null, book_ok: false, depth_usd: null, book_ms: null, funding_1h: null,
    opens_now: false, room_usd: null, free_usd: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Accounts mode: dispatch table

function makeAccountsHandlers(ctx) {
  const { engine } = ctx;
  const P = ctx.platform;
  const population = () => engine.population;

  return {
    // ---- public engine queries
    ...engineQueries(ctx),
    meta: () => metaPayload(ctx),
    beans: (p, call) => {
      // A signed-in player sees their own PAPER verdict (tradeable, venue_reason, bot); spectators the engine's.
      const venue = call.uid != null ? P.gardens.venueFor?.(call.uid) : null;
      const res = venue ? population().query(p, { venue }) : population().query(p);
      return { ...res, venue: { known: true, network: 'sim' } };
    },
    events: (p, call) => eventsFor(ctx, call.uid, p),
    testnet_market: () => testnetMarketPayload(ctx),

    // ---- player queries (session required; the gate answers 401 before these run, except `me`)
    me: (p, call) => mePayload(ctx, call),
    bots: ({ state }, call) => gardenOf(ctx, call).bots({ state }),
    bot_detail: ({ id }, call) => gardenOf(ctx, call).botDetail(id),
    live_status: (p, call) => gardenOf(ctx, call).status(),
    live_fills: ({ bot, limit, season }, call) => gardenOf(ctx, call).fills(season === undefined ? { bot, limit } : { bot, limit, season }),
    testnet_status: (p, call) => testnetStatusPayload(ctx, call),
    testnet_quote: (p, call) => testnetQuotePayload(ctx, call, p),
    sessions: async (p, call) => {
      if (typeof P.auth?.listSessions === 'function') return authOp(ctx, call, 'listSessions', {}, null);
      const current = publicIdOf(call.session);
      const rows = (await P.sessions.list(call.uid, current)) ?? [];
      return {
        rows: rows.map((s) => {
          const id = s.public_id ?? s.publicId ?? s.id ?? null;
          return {
            id,
            created_ms: s.created_ms ?? s.createdMs ?? null,
            last_seen_ms: s.last_seen_ms ?? s.lastSeenMs ?? null,
            user_agent: s.user_agent ?? s.userAgent ?? null,
            ip_prefix: s.ip_prefix ?? s.ipPrefix ?? null,
            current: id !== null && id === current,
          };
        }),
      };
    },

    // ---- garden commands
    bot_create: (p, call) => {
      const venue = p.venue ?? 'paper';
      if (venue === 'testnet') {
        if (p.confirm !== 'testnet') throw apiError(400, 'a testnet bot needs confirm: "testnet"', 'confirm_required');
        if (!ctx.testnetEnabled) throw apiError(503, 'testnet trading is not enabled on this server', 'testnet_disabled');
      }
      const params = { bean: p.bean, capital_usd: p.capital_usd, venue };
      if (p.confirm !== undefined) params.confirm = p.confirm;
      if (venue === 'testnet' && p.ack_divergence !== undefined) params.ack_divergence = p.ack_divergence;
      return gardenOf(ctx, call).create(params);
    },
    bot_pause: ({ id }, call) => gardenOf(ctx, call).pause({ id }),
    bot_resume: ({ id }, call) => gardenOf(ctx, call).resume({ id }),
    bot_close: ({ id }, call) => gardenOf(ctx, call).close({ id }),
    bots_halt: (p, call) => (typeof P.gardens.halt === 'function' ? P.gardens.halt(call.uid, { actor: 'user' }) : gardenOf(ctx, call).halt()),
    garden_rearm: (p, call) => {
      requireConfirm(p.confirm, 'REARM');
      if (typeof P.gardens.rearm === 'function') return P.gardens.rearm(call.uid, { confirm: p.confirm });
      const g = gardenOf(ctx, call);
      if (typeof g.rearm === 'function') return g.rearm({ confirm: p.confirm });
      throw notWired(ctx, 'gardens.rearm');
    },
    garden_reset: (p, call) => {
      requireConfirm(p.confirm, 'RESET');
      if (typeof P.gardens.resetSeason === 'function') return P.gardens.resetSeason(call.uid, { confirm: p.confirm });
      const g = gardenOf(ctx, call);
      if (typeof g.resetSeason === 'function') return g.resetSeason({ confirm: p.confirm });
      throw notWired(ctx, 'gardens.resetSeason');
    },
    tick: ({ n }) => tickOp(ctx, n), // admin only in accounts mode (catalog auth: 'admin')

    // ---- auth and account
    // WP1's AuthService when the platform has one, else the built-in flows; every revocation then ends the matching
    // streams here, in the same tick, with its reason (§4.2), whichever implementation revoked.
    auth_signup: (p, call) => authOp(ctx, call, 'signup', p, () => authSignup(ctx, p, call)),
    auth_login: (p, call) => authOp(ctx, call, 'login', p, () => authLogin(ctx, p, call)),
    auth_reset: async (p, call) => {
      const out = await authOp(ctx, call, 'reset', p, () => authReset(ctx, p, call));
      if (out?.user?.id != null) closeStreamsFor(ctx, { uid: out.user.id, reason: 'password_reset' });
      return out;
    },
    auth_logout: async (p, call) => {
      const uid = call.uid;
      const pid = publicIdOf(call.session);
      const out = await authOp(ctx, call, 'logout', {}, () => authLogout(ctx, call));
      if (uid != null && pid) closeStreamsFor(ctx, { uid, sessionIds: [pid], reason: 'logout' });
      return out;
    },
    auth_logout_all: async (p, call) => {
      const out = await authOp(ctx, call, 'logoutAll', {}, () => authLogoutAll(ctx, call));
      closeStreamsFor(ctx, { uid: call.uid, reason: 'logout_all' });
      return out;
    },
    account_password: async (p, call) => {
      const out = await authOp(ctx, call, 'changePassword', p, () => accountPassword(ctx, p, call));
      closeStreamsFor(ctx, { uid: call.uid, reason: 'password_changed' }); // the fresh session has no stream yet
      return out;
    },
    account_delete: async (p, call) => {
      const out = await authOp(ctx, call, 'deleteAccount', p, () => accountDelete(ctx, p, call));
      closeStreamsFor(ctx, { uid: call.uid, reason: 'deleted' });
      return out;
    },
    session_revoke: async (p, call) => {
      const out = await authOp(ctx, call, 'revokeSession', p, () => sessionRevoke(ctx, p, call));
      closeStreamsFor(ctx, { uid: call.uid, sessionIds: [p.id], reason: 'revoked' });
      return out;
    },

    // ---- testnet
    testnet_connect: (p, call) => testnetConnect(ctx, p, call),
    testnet_verify: (p, call) => testnetVerify(ctx, call),
    testnet_disconnect: (p, call) => {
      requireTestnet(ctx);
      return disconnectFlow(ctx, call.uid, { closeBots: p.close_bots === true, force: p.force === true, by: 'user' });
    },
    testnet_agent_prepare: (p, call) => {
      requireTestnet(ctx);
      const svc = ctx.platform.testnetLink;
      if (typeof svc?.prepareAgent !== 'function') throw apiError(404, 'the browser-wallet flow is not available on this server', 'not_found');
      return svc.prepareAgent(call.uid);
    },
    testnet_agent_approve: async (p, call) => {
      requireTestnet(ctx);
      const svc = ctx.platform.testnetLink;
      if (typeof svc?.approveAgent !== 'function') throw apiError(404, 'the browser-wallet flow is not available on this server', 'not_found');
      const accountAddress = normalizeAccountAddress(p.account_address);
      const signature = String(p.signature ?? '').trim();
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw apiError(400, 'the signature is not 65 bytes of 0x hex', 'bad_request');
      return countedConnect(ctx, call, () => svc.approveAgent(call.uid, { accountAddress, signature, nonce: p.nonce, chainId: p.chain_id }));
    },

    // ---- admin
    admin_status: () => adminStatus(ctx),
    admin_users: (p) => adminUsers(ctx, p),
    admin_audit: (p) => adminAudit(ctx, p),
    admin_kill_switch: (p, call) => adminKillSwitch(ctx, p, call),
    admin_testnet_signing: (p, call) => adminTestnetSigning(ctx, p, call),
    admin_caps: (p, call) => adminCaps(ctx, p, call),
    admin_user: (p, call) => adminUser(ctx, p, call),
    admin_backup: (p, call) => adminBackup(ctx, call),
    dev_double: async (p) => {
      if (ctx.config.testnetDouble !== true || typeof P.devDouble?.fault !== 'function') {
        throw apiError(404, 'dev_double exists only under --testnet-double', 'not_found');
      }
      const out = await P.devDouble.fault(p.fault, p.args ?? {});
      return out && typeof out === 'object' ? out : { ok: true, fault: p.fault };
    },
  };
}

/** The caller's garden (loaded on demand and touched, PLATFORM §2.2). */
function gardenOf(ctx, call) {
  const g = ctx.platform.gardens.get(call.uid);
  if (!g) throw new Error(`no garden for uid ${call.uid}`);
  return g;
}

function requireConfirm(value, word) {
  if (value !== word) throw apiError(400, `type ${word} to confirm`, 'confirm_required');
}

/** A platform member the op needs is missing: an integration gap, answered as an internal error (and logged once). */
function notWired(ctx, what) {
  warnOnce(ctx, `wire:${what}`, `[api] ALERT ${what} is not wired into the platform bag`);
  return new Error(`${what} is not available`);
}

// ---- accounts-mode payloads ------------------------------------------------------------------

/** `User` (PLATFORM §8.2): never more than these five fields. */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    role: u.role === 'admin' ? 'admin' : 'player',
    created_ms: u.created_ms ?? u.createdMs ?? null,
    lang: u.lang ?? null,
  };
}

const publicIdOf = (s) => (s ? s.publicId ?? s.public_id ?? null : null);

function signupMode(ctx) {
  const fromAdmin = safeCall(ctx, () => ctx.platform.admin?.getSignupMode?.());
  const m = fromAdmin ?? ctx.config.signupMode ?? 'open';
  return m === 'invite' || m === 'closed' ? m : 'open';
}

async function mePayload(ctx, call) {
  return {
    mode: 'accounts',
    user: publicUser(call.user),
    session: call.session
      ? { created_ms: call.session.createdMs ?? call.session.created_ms ?? null, expires_ms: call.session.expiresMs ?? call.session.expires_ms ?? null }
      : null,
    signup: signupMode(ctx),
    testnet: call.uid != null ? await testnetLink(ctx, call.uid) : null,
  };
}

/** The player's TestnetLink (§8.2): from the credentials service (no key columns are ever read here). */
async function testnetLink(ctx, uid) {
  const P = ctx.platform;
  const src = typeof P.testnetLink?.link === 'function' ? P.testnetLink : typeof P.credentials?.link === 'function' ? P.credentials : null;
  if (src) return (await src.link(uid)) ?? null;
  const row = dbGet(ctx, SQL.credentialLink, uid);
  return row ? { ...row, agent_name: row.agent_name ?? null } : null;
}

function killSwitchOf(ctx) {
  const ks = safeCall(ctx, () => ctx.platform.admin?.getKillSwitch?.());
  if (!ks || typeof ks !== 'object') return { ...KILL_SWITCH_OFF };
  return { on: ks.on === true, reason: ks.reason ?? null, since_ms: ks.since_ms ?? ks.sinceMs ?? null };
}

/** `testnet_market` (§8.3): TestnetMarket's caches only — never a Hyperliquid request on behalf of a caller. */
function testnetMarketPayload(ctx) {
  if (!ctx.testnetEnabled) return disabledTestnetMarket(ctx, 'disabled');
  if (typeof ctx.platform.gardens.testnetMarket === 'function') return ctx.platform.gardens.testnetMarket();
  const market = ctx.platform.testnet?.market;
  if (!market) return disabledTestnetMarket(ctx, 'disabled');
  const snap = safeCall(ctx, () => market.snapshot?.()) ?? {};
  const status = safeCall(ctx, () => market.status?.()) ?? { state: snap.state ?? 'down', reason: snap.state_reason ?? null };
  const coins = typeof market.listing === 'function'
    ? safeCall(ctx, () => market.listing()) ?? []
    : coinNames(ctx).map((coin) => listingRow(ctx, market, coin));
  return {
    enabled: true,
    state: status.state ?? 'down',
    state_reason: status.reason ?? null,
    kill_switch: killSwitchOf(ctx),
    mids_ms: snap.mids_ms ?? null,
    ctx_ms: snap.ctx_ms ?? null,
    coins,
  };
}

/** One §8.3 coin row from the per-coin cache reads (when the market has no listing()). */
function listingRow(ctx, market, coin) {
  const info = safeCall(ctx, () => market.coinInfo?.(coin)) ?? null;
  const q = safeCall(ctx, () => market.quote?.(coin)) ?? null;
  const c = safeCall(ctx, () => market.ctx?.(coin)) ?? null;
  const listed = info != null && info.index != null;
  return {
    coin,
    index: listed ? info.index : null,
    sz_decimals: info?.sz_decimals ?? null,
    max_leverage: info?.max_leverage ?? null,
    delisted: info?.delisted === true,
    only_isolated: info?.only_isolated === true,
    mid: q?.px ?? null,
    mid_ms: q?.ms ?? null,
    mark_px: c?.mark_px ?? null,
    funding_1h: c?.funding_1h ?? null,
    tradeable: listed && info.delisted !== true,
  };
}

/** `testnet_status` (§8.3): the garden's cached snapshot (WP3), else what live_status already knows. Cache only. */
async function testnetStatusPayload(ctx, call) {
  const P = ctx.platform;
  const link = await testnetLink(ctx, call.uid);
  if (!ctx.testnetEnabled) return disabledTestnetStatus(link);
  const g = P.gardens.get(call.uid);
  try {
    let s = null;
    if (typeof P.gardens.testnetStatus === 'function') s = await P.gardens.testnetStatus(call.uid);
    else if (typeof g?.testnetStatus === 'function') s = await g.testnetStatus();
    if (s && typeof s === 'object') return { ...s, link: s.link ?? link, expiry: s.expiry?.valid_until_ms != null ? s.expiry : expiryOf(link) };
  } catch (err) {
    if (err?.code !== 'testnet_disabled') throw err; // this garden has no testnet venue: answer from the caches below
  }
  const v = safeCall(ctx, () => g?.status?.())?.venues?.testnet ?? null;
  const market = ctx.platform.testnet?.market;
  return {
    link,
    state: v?.state ?? safeCall(ctx, () => market?.state?.()) ?? 'down',
    account: v && v.connected
      ? {
        account_value: v.account_value ?? null, account_value_est: v.account_value_est === true, balance: v.balance ?? null,
        free: v.free ?? null, withdrawable: v.withdrawable ?? v.free ?? null, total_margin_used: v.total_margin_used ?? null,
        total_ntl_pos: v.open_notional_usd ?? null, as_of_ms: v.as_of_ms ?? null,
      }
      : null,
    positions: [],
    requests: null,
    expiry: expiryOf(link),
    caps: v?.caps ?? { ...TESTNET_CAPS_DEFAULT },
  };
}

/** API-wallet expiry warning (§8.3): '1d' under a day, '7d' under a week, else null. */
function expiryOf(link) {
  const until = link?.valid_until_ms ?? null;
  if (until == null) return { valid_until_ms: null, warn: null };
  const left = until - Date.now();
  return { valid_until_ms: until, warn: left < 86_400_000 ? '1d' : left < 7 * 86_400_000 ? '7d' : null };
}

/** `testnet_quote` (§8.3): the garden's own checks (WP3 LiveLayer.testnetQuote) — cache only, never a fetch here. */
async function testnetQuotePayload(ctx, call, p) {
  if (!ctx.testnetEnabled) return disabledQuote('testnet_disabled');
  const P = ctx.platform;
  const args = { bean: p.bean, capital_usd: p.capital_usd };
  try {
    if (typeof P.gardens.testnetQuote === 'function') return await P.gardens.testnetQuote(call.uid, args);
    const g = P.gardens.get(call.uid);
    if (typeof g?.testnetQuote === 'function') return await g.testnetQuote(args);
  } catch (err) {
    if (err?.code !== 'testnet_disabled') throw err;
    return disabledQuote('testnet_disabled');
  }
  warnOnce(ctx, 'wire:testnetQuote', '[api] ALERT gardens.testnetQuote is not available: testnet quotes answer testnet_disabled');
  return disabledQuote('testnet_disabled');
}

/** `events`: global records plus the player's own (spectators: global only), re-checked at the edge (§8.7). */
function eventsFor(ctx, uid, { kind, limit, offset }) {
  const { journal } = ctx;
  const res = typeof journal.queryFor === 'function'
    ? journal.queryFor(uid ?? null, { kind, limit, offset })
    : journal.query({ kind, limit, offset });
  return { rows: res.rows.filter((r) => visibleTo(ctx, r, uid)), total: res.total };
}

/** Owner uid of a journal record (user records carry an internal, non-enumerable `uid`), or null for global ones. */
function ownerOf(record) {
  const uid = record?.uid;
  return Number.isSafeInteger(uid) ? uid : null;
}

/** May `record` reach player `uid` (null = spectator)? Uid-less records only when their kind is global (§8.7). */
function visibleTo(ctx, record, uid) {
  if (ctx.mode !== 'accounts') return true;
  const owner = ownerOf(record);
  if (owner === null) return GLOBAL_KINDS.includes(record?.kind);
  return uid != null && owner === uid;
}

// ---------------------------------------------------------------------------------------------
// Router

async function route(ctx, call) {
  const { req, res } = call;
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    throw new ApiError(400, 'malformed request URL');
  }
  call.url = url;
  const pathname = url.pathname;

  if (ctx.mode === 'accounts') {
    for (const [k, v] of ctx.securityHeaders) res.setHeader(k, v);
    checkHost(ctx, call);
  }
  if (pathname === '/healthz' || pathname === '/readyz') return serveHealth(ctx, call, pathname);
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return ctx.mode === 'accounts' ? routeApiAccounts(ctx, call) : routeApi(ctx, call);
  }
  if (pathname === '/docs' || pathname === '/docs/') return serveDocs(ctx, req, res);
  if (pathname === '/vendor' || pathname.startsWith('/vendor/')) return serveVendor(ctx, req, res, pathname);
  return serveStatic(ctx, req, res, pathname);
}

/** None mode: the SPEC §4 API, unchanged, plus `404 accounts_disabled` for accounts-only ops. */
async function routeApi(ctx, call) {
  const { req, res, url } = call;
  if (req.method === 'OPTIONS') return sendPreflight(res);

  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === API_PREFIX) {
    requireMethod(req, 'GET');
    return sendJson(ctx, call, 200, indexPayload(ctx));
  }
  if (pathname === STREAM_PATH) {
    requireMethod(req, 'GET');
    return openStream(ctx, call);
  }

  const match = OP_PATH_RE.exec(pathname);
  const op = match ? findOp(match[1]) : null;
  if (!op) throw new ApiError(404, match ? `unknown operation '${match[1]}'` : `no such endpoint: ${pathname}`);
  if (!opInMode(op, 'none')) {
    throw apiError(404, `'${op.name}' needs a server with accounts (--auth accounts)`, 'accounts_disabled');
  }
  call.op = op;

  if (op.kind === 'query') {
    requireMethod(req, 'GET');
    const params = coerceParams(op, queryRaw(url.searchParams));
    return sendJson(ctx, call, 200, await ctx.handlers[op.name](params, call));
  }

  requireMethod(req, 'POST');
  return runCommand(ctx, call, op);
}

/** None-mode commands: auth → body → params → handler, with exactly one log line per command. */
async function runCommand(ctx, call, op) {
  const { req, url } = call;
  const started = performance.now();
  const auth = commandAuth(ctx, req);
  let status = 500;
  let params = null;
  try {
    if (!auth) throw new ApiError(401, AUTH_DENIED);
    if (ctx.shuttingDown) throw apiError(503, 'the server is restarting; try again in a moment', 'server_restarting');
    const body = parseJsonBody(await readBody(req, MAX_BODY_BYTES));
    params = coerceParams(op, Object.assign(Object.create(null), queryRaw(url.searchParams), body));
    const payload = await ctx.handlers[op.name](params, call);
    status = 200;
    sendJson(ctx, call, 200, payload);
  } catch (err) {
    status = errorStatus(err);
    throw err;
  } finally {
    const ms = (performance.now() - started).toFixed(1);
    const shown = params ? ` ${truncate(JSON.stringify(params), 160)}` : '';
    ctx.log(`[api] ${op.name}${shown} → ${status} (${ms} ms, ${req.socket.remoteAddress ?? '?'}, ${auth ?? 'denied'})`);
  }
}

function requireMethod(req, method) {
  if (req.method !== method) {
    throw Object.assign(new ApiError(405, `method ${req.method} not allowed here; use ${method}`), { allow: method });
  }
}

function indexPayload(ctx) {
  const accounts = ctx.mode === 'accounts';
  return {
    name: 'bean-garden API',
    api_version: 1,
    version: ctx.version,
    command_policy: accounts ? 'session' : ctx.token ? 'token' : 'loopback',
    description: 'Simulated brood-compatible backend for the Bean Garden. Queries are GET /api/v1/<name>; ' +
      'commands are POST /api/v1/<name> with a JSON body. Live journal via GET /api/v1/events/stream (SSE).',
    docs: '/docs',
    stream: STREAM_PATH,
    operations: OPS,
    // additive (PLATFORM §8.1)
    auth: ctx.mode,
    testnet: { enabled: accounts && ctx.testnetEnabled === true },
    ...(accounts ? { public_origin: ctx.publicOrigin } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Accounts mode: the request pipeline (PLATFORM §4.4, §4.5, §8.1)

/** Host check for every request (anti DNS-rebinding, `421 misdirected`), with the §4.4 exceptions. */
function checkHost(ctx, call) {
  const { req, url } = call;
  const host = String(req.headers.host ?? '').trim().toLowerCase();
  if (host && host === ctx.publicHost) return;
  const p = url.pathname.replace(/\/+$/, '') || '/';
  // GET /healthz (liveness) answers ANY Host: its body is the constant {ok:true} (no DB, no engine, no state), so a
  // rebinding page learns nothing, and platform health checkers (Render) call it with an internal Host name.
  if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) return;
  // The admin-cli path: an admin op with a Bearer header from a direct loopback peer.
  const m = OP_PATH_RE.exec(p);
  const op = m ? findOp(m[1]) : null;
  if (op?.auth === 'admin' && bearerToken(req.headers.authorization) && isDirectLoopback(req)) return;
  // Health endpoints also answer on 127.0.0.1:<PORT> / localhost:<PORT> (container health checks).
  const port = req.socket.localPort;
  const local = host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
  if (local && (p === '/healthz' || p === '/readyz' || (p === `${API_PREFIX}/health` && req.method === 'GET'))) return;
  throw apiError(421, 'misdirected request', 'misdirected');
}

/**
 * directLoopback(req) (§4.4): the socket peer is loopback AND no proxy header is present — the operator's admin-cli
 * inside the container. Behind Caddy every request comes from loopback too, but always with X-Forwarded-For.
 */
function isDirectLoopback(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  return !ACCOUNTS_PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
}

async function routeApiAccounts(ctx, call) {
  const { req, url } = call;
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const match = OP_PATH_RE.exec(pathname);
  const op = match ? findOp(match[1]) : null;
  if (req.method === 'OPTIONS') return sendPreflightAccounts(call, pathname, op);
  call.ipInfo = clientIpOf(ctx, req);

  if (pathname === API_PREFIX) {
    requireMethod(req, 'GET');
    call.cors = true;
    await rateQuery(ctx, call);
    return sendJson(ctx, call, 200, indexPayload(ctx));
  }
  if (pathname === STREAM_PATH) {
    requireMethod(req, 'GET');
    return openStreamAccounts(ctx, call);
  }
  if (!op) throw new ApiError(404, match ? `unknown operation '${match[1]}'` : `no such endpoint: ${pathname}`);
  call.op = op;
  call.sensitive = op.sensitive === true;

  if (op.kind === 'query') {
    requireMethod(req, 'GET');
    call.cors = op.auth === 'public';
    await rateQuery(ctx, call);
    if (op.auth === 'admin') await gate(ctx, call, op); // the Bearer rules for the admin-cli's queries
    await authenticate(ctx, call, op);
    const params = coerceParams(op, queryRaw(url.searchParams));
    return sendJson(ctx, call, 200, await ctx.handlers[op.name](params, call));
  }

  requireMethod(req, 'POST');
  return runCommandAccounts(ctx, call, op);
}

/**
 * Accounts-mode commands: query string refused → shutdown → CSRF + Bearer (the gate) → session + access class →
 * rate limit → body (4 KB for sensitive ops) → params (JSON body only) → handler. One log line; sensitive ops never
 * log their params.
 */
async function runCommandAccounts(ctx, call, op) {
  const { req, url } = call;
  const started = performance.now();
  let status = 500;
  let code = null;
  let params = null;
  try {
    // Before the body is read: credentials must never sit in a request line or an access log (§4.4, §5.3 #2).
    if (url.search !== '') {
      throw apiError(400, 'command parameters go in the JSON body, never in the URL', 'query_params_not_allowed');
    }
    if (ctx.shuttingDown) throw apiError(503, 'the server is restarting; try again in a moment', 'server_restarting');
    await gate(ctx, call, op);
    await authenticate(ctx, call, op);
    await rateCommand(ctx, call, op);
    const limit = op.sensitive ? MAX_SENSITIVE_BODY_BYTES : MAX_BODY_BYTES;
    const body = parseJsonBody(await readBody(req, limit), { redact: op.sensitive });
    params = coerceParams(op, body, { redact: op.sensitive });
    if (call.bearer && op.name === 'admin_user' && (params.action === 'make_admin' || params.action === 'remove_admin')) {
      throw apiError(403, 'role changes need an admin session and your password, never the admin token', 'session_required');
    }
    const payload = await ctx.handlers[op.name](params, call);
    status = 200;
    sendJson(ctx, call, 200, payload);
  } catch (err) {
    status = errorStatus(err);
    code = isErrorCode(err?.code) ? err.code : null;
    throw err;
  } finally {
    const ms = (performance.now() - started).toFixed(1);
    const shown = op.sensitive ? ' <redacted>' : params ? ` ${truncate(JSON.stringify(params), 160)}` : '';
    const who = call.bearer ? 'bearer' : call.uid != null ? `u${call.uid}` : 'anon';
    ctx.log(`[api] ${op.name}${shown} → ${status}${code ? ` ${code}` : ''} (${ms} ms, ${who})`);
  }
}

/**
 * CSRF, Host and Bearer rules (§4.4) for a command or an admin query: WP1's request guard when the platform has one,
 * else the built-in copy (checkBearer + checkCsrf). Sets call.bearer when a VALID admin token was presented.
 */
async function gate(ctx, call, op) {
  const { req, url } = call;
  const sessionCookieUsed = sessionPresented(ctx, req);
  const guard = ctx.platform.guard;
  if (typeof guard?.check === 'function') {
    const r = await guard.check(req, { url, op, sessionCookieUsed, ip: call.ipInfo });
    if (r?.error) throw r.error;
    call.bearer = r?.viaBearer === true;
    return;
  }
  await checkBearer(ctx, call, op);
  const csrf = typeof ctx.platform.checkCsrf === 'function' ? ctx.platform.checkCsrf : builtinCheckCsrf;
  const refused = await csrf(req, {
    publicOrigin: ctx.publicOrigin, op, bearerPresent: call.bearer, directLoopback: isDirectLoopback(req), sessionCookieUsed, url,
  });
  if (refused) throw refused;
}

/**
 * The built-in Bearer rules of §4.4: only an admin op accepts it, only from a direct loopback peer (unless
 * ADMIN_TOKEN_REMOTE=1); a wrong token takes one from the per-IP `admin_token_ip` bucket and is audited.
 * A non-Bearer Authorization header is ignored.
 */
async function checkBearer(ctx, call, op) {
  const { req } = call;
  const presented = bearerToken(req.headers.authorization);
  if (!presented) return;
  if (op.auth !== 'admin') throw apiError(401, 'the admin token never unlocks player operations; sign in instead', 'auth_required');
  if (!isDirectLoopback(req) && !ctx.adminTokenRemote) {
    throw apiError(403, 'the admin token is accepted only from the server itself (admin-cli)', 'forbidden');
  }
  if (!ctx.adminToken || !tokensEqual(presented, ctx.adminToken)) {
    const r = await take(ctx, 'admin_token_ip', call.ipInfo.bucketKey());
    audit(ctx, call, { action: 'admin_token_fail', actor: 'ops', ok: false, detail: { code: 'auth_required' } });
    if (!r.ok) throw rateLimited(r.retryAfterS);
    throw apiError(401, 'wrong admin token', 'auth_required');
  }
  call.bearer = true;
}

/**
 * The built-in copy of WP1's checkCsrf (PLATFORM §4.4), used when the platform brings neither a guard nor one.
 * → null | ApiError. (The query-string refusal and the Bearer token check run before it.)
 */
export function builtinCheckCsrf(req, { publicOrigin, op, bearerPresent = false, directLoopback = false, sessionCookieUsed = true } = {}) {
  const pub = new URL(publicOrigin);
  const exempt = bearerPresent && directLoopback && op?.auth === 'admin';
  const host = String(req.headers.host ?? '').trim().toLowerCase();
  if (!exempt && host !== pub.host.toLowerCase()) return apiError(421, 'misdirected request', 'misdirected');
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return null;
  const mediaType = String(firstHeader(req.headers['content-type']) ?? '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') return apiError(415, 'commands take Content-Type: application/json', 'unsupported_media_type');
  if (bearerPresent && !sessionCookieUsed) return null; // no ambient credential to abuse
  const origin = firstHeader(req.headers.origin);
  if (origin !== null) {
    try {
      if (new URL(origin).origin === pub.origin) return null;
    } catch {
      /* "null" and junk origins fall through */
    }
    return apiError(403, 'cross-site request refused', 'csrf');
  }
  return firstHeader(req.headers['sec-fetch-site']) === 'same-origin' ? null : apiError(403, 'cross-site request refused', 'csrf');
}

/** Does the request carry a session cookie at all (valid or not)? */
function sessionPresented(ctx, req) {
  const s = ctx.platform.sessions;
  if (typeof s?.presented === 'function') return s.presented(req) === true;
  const cookies = parseCookies(req.headers.cookie);
  return SESSION_COOKIES.some((name) => cookies.has(name));
}

function parseCookies(header) {
  const out = new Map();
  const text = Array.isArray(header) ? header.join('; ') : String(header ?? '');
  for (const part of text.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !out.has(name)) out.set(name, part.slice(i + 1).trim());
  }
  return out;
}

/** Append a Set-Cookie header (kept across writeHead, so error responses carry it too). */
function addCookie(res, cookie) {
  if (typeof cookie !== 'string' || !cookie) return;
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(prev === undefined ? [] : [].concat(prev)), cookie]);
}

function clearSessionCookie(ctx, res) {
  const cookie = safeCall(ctx, () => ctx.platform.sessions.clearCookie?.());
  if (cookie) addCookie(res, cookie);
}

/**
 * Resolve the session from the cookie (rotation's Set-Cookie included), then enforce the op's access class:
 * public → anyone; user → a session (401 auth_required, or session_expired + cookie cleared for a stale cookie;
 * `me` answers spectators with user:null instead); admin → an admin session or a valid Bearer (403 for players).
 */
async function authenticate(ctx, call, op) {
  await resolveSession(ctx, call);
  if (op.auth === 'public') return;
  if (op.auth === 'admin') {
    if (call.bearer) return;
    if (!call.user) throw sessionRequired(ctx, call);
    if (call.user.role !== 'admin') throw apiError(403, 'only an admin can do that', 'forbidden');
    return;
  }
  if (call.user) return;
  if (op.name === 'me') {
    if (call.staleCookie) clearSessionCookie(ctx, call.res);
    return;
  }
  throw sessionRequired(ctx, call);
}

function sessionRequired(ctx, call) {
  if (call.staleCookie) {
    clearSessionCookie(ctx, call.res);
    return apiError(401, 'your session has ended; sign in again', 'session_expired');
  }
  return apiError(401, 'sign in to do that', 'auth_required');
}

async function resolveSession(ctx, call) {
  if (call.sessionResolved) return;
  call.sessionResolved = true;
  if (!sessionPresented(ctx, call.req)) return;
  const authn = await ctx.platform.sessions.authenticate(call.req);
  if (authn?.user && authn.user.id != null) {
    call.user = authn.user;
    call.session = authn.session ?? null;
    call.uid = authn.user.id;
    if (authn.setCookie) addCookie(call.res, authn.setCookie);
  } else {
    call.staleCookie = true; // present but invalid: the request is anonymous (§4.2)
  }
}

// ---- rate limits -------------------------------------------------------------------------------

/** The limiter to ask for `scope`: the platform's (WP1), unless it refused that scope once. */
function limiterFor(ctx, scope) {
  const lim = ctx.platform.limiter;
  return lim && typeof lim.take === 'function' && !ctx.limiterFallback.has(scope) ? lim : ctx.builtinLimiter;
}

async function useLimiter(ctx, method, scope, key, cost) {
  const lim = limiterFor(ctx, scope);
  if (typeof lim[method] !== 'function') return { ok: true, retryAfterS: 0 }; // e.g. a limiter without check()
  try {
    const r = await lim[method](scope, String(key), cost);
    if (r && typeof r === 'object') return { ok: r.ok !== false, retryAfterS: r.retryAfterS ?? r.retry_after_s ?? 1 };
    return { ok: true, retryAfterS: 0 };
  } catch (err) {
    if (lim === ctx.builtinLimiter) throw err;
    ctx.limiterFallback.add(scope);
    ctx.log(`[api] limiter: scope '${scope}' refused by the platform limiter (${err?.message || err}) — using the built-in bucket`);
    return useLimiter(ctx, method, scope, key, cost);
  }
}

const take = (ctx, scope, key, cost = 1) => useLimiter(ctx, 'take', scope, key, cost);
const peek = (ctx, scope, key, cost = 1) => useLimiter(ctx, 'check', scope, key, cost);

async function limitOrThrow(ctx, scope, key, cost = 1) {
  const r = await take(ctx, scope, key, cost);
  if (!r.ok) throw rateLimited(r.retryAfterS);
}

async function rateQuery(ctx, call, cost = 1) {
  const key = call.ipInfo.bucketKey();
  noteIpBucket(ctx, key, call.ipInfo.source);
  await limitOrThrow(ctx, 'queries_ip', key, cost);
}

async function rateCommand(ctx, call, op) {
  // Auth ops carry their own per-IP / per-username limits (in their handlers); everything else counts per user.
  if (op.name.startsWith('auth_')) return;
  const key = call.uid != null ? `u:${call.uid}` : `ip:${call.ipInfo.bucketKey()}`;
  await limitOrThrow(ctx, 'commands_user', key);
  if (op.name === 'bot_create') await limitOrThrow(ctx, 'bot_create_user', key);
}

/** admin_status.client_ip.buckets_1h fallback (WP1's clientIp keeps its own BucketStats). */
function noteIpBucket(ctx, key, source) {
  ctx.lastIpSource = source ?? 'socket';
  if (ctx.platform.clientIp?.stats) return;
  ctx.ipSeen.delete(key);
  ctx.ipSeen.set(key, Date.now());
  if (ctx.ipSeen.size > 100_000) ctx.ipSeen.delete(ctx.ipSeen.keys().next().value);
}

function bucketsLastHour(ctx) {
  const stats = ctx.platform.clientIp?.stats;
  if (typeof stats?.count === 'function') return stats.count();
  const cutoff = Date.now() - 3_600_000;
  for (const [k, t] of ctx.ipSeen) {
    if (t >= cutoff) break; // insertion order = last-seen order
    ctx.ipSeen.delete(k);
  }
  return ctx.ipSeen.size;
}

/**
 * Client IP (§4.5): WP1's resolver when wired (trusted proxies, XFF, single header), else the socket peer.
 * bucketKey(scope) uses WP1's scope names: 'login' | 'signup' | 'sse' (IPv6 /56), 'signup48' (/48), else /64.
 */
function clientIpOf(ctx, req) {
  const fn = ctx.platform.clientIp;
  if (typeof fn === 'function') {
    try {
      const r = fn(req, { trustProxy: ctx.config.trustProxy ?? 0, header: ctx.config.clientIpHeader ?? null, trustedCidrs: ctx.config.trustedProxyCidrs });
      if (r && typeof r.ip === 'string') {
        return {
          ip: r.ip,
          source: r.source ?? 'socket',
          bucketKey: typeof r.bucketKey === 'function' ? (scope) => String(r.bucketKey(scope)) : (scope) => bucketKeyFor(r.ip, scope),
          prefix: typeof r.prefix === 'function' ? () => r.prefix() : () => r.ip,
        };
      }
    } catch (err) {
      warnOnce(ctx, 'clientIp', `[api] clientIp() failed (${err?.message || err}) — using the socket address`);
    }
  }
  const ip = normalizeAddress(req.socket.remoteAddress);
  return { ip, source: 'socket', bucketKey: (scope) => bucketKeyFor(ip, scope), prefix: () => bucketKeyFor(ip, 'signup48') };
}

function normalizeAddress(address) {
  const a = String(address ?? '').toLowerCase();
  return a.startsWith('::ffff:') && a.includes('.') ? a.slice(7) : a || 'unknown';
}

/** Fallback bucketing (§4.5): IPv4 per address; IPv6 /56 for login, sign-up and SSE, /48 for signup48, else /64. */
export function bucketKeyFor(ip, scope = 'default') {
  const a = normalizeAddress(ip);
  if (!a.includes(':')) return a;
  const bits = scope === 'signup48' ? 48 : scope === 'login' || scope === 'signup' || scope === 'sse' ? 56 : 64;
  const groups = expandIpv6(a);
  if (!groups) return a;
  const words = [];
  for (let i = 0; i < Math.ceil(bits / 16); i++) {
    const keep = Math.min(16, bits - i * 16);
    words.push((groups[i] & ((0xffff << (16 - keep)) & 0xffff)).toString(16));
  }
  return `${words.join(':')}::/${bits}`;
}

/** "2001:db8::1" → eight 16-bit numbers, or null. Zone ids are dropped. */
function expandIpv6(ip) {
  const s = ip.split('%')[0];
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part ? part.split(':') : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array(missing).fill('0'), ...tail].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

// ---- audit -------------------------------------------------------------------------------------

/**
 * Write one audit row through WP1's Admin.audit (§5.4): {action, actor, userId, target, ip (a prefix; stored only as
 * an HMAC), ok, detail}. Never throws: an audit failure must not turn a successful request into an error.
 */
function audit(ctx, call, { action, userId = null, actor = 'user', target = null, ok = true, detail = null }) {
  const admin = ctx.platform.admin;
  if (typeof admin?.audit !== 'function') return;
  try {
    const ip = call?.ipInfo?.prefix?.() ?? null;
    admin.audit({ action, actor, userId, target, ip, ok, detail });
  } catch (err) {
    ctx.log(`[api] audit ${action} failed: ${err?.name ?? 'Error'}`);
  }
}

/** Run a synchronous platform read that must never break a response (cache reads, optional members). */
function safeCall(ctx, fn) {
  try {
    return fn();
  } catch (err) {
    warnOnce(ctx, `safe:${err?.message}`, `[api] platform read failed: ${err?.message || err}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Accounts mode: auth and account ops (PLATFORM §4.1–§4.6, §8.2)

/**
 * One auth / account op through WP1's AuthService when the platform has it: the service takes a request context
 * (client IP, user agent, the request, the resolved session) and answers {payload, cookies}; a refusal may carry
 * `setCookies` (a stale cookie cleared). Without the service, `builtin()` runs the same flow here.
 */
async function authOp(ctx, call, method, params, builtin) {
  const svc = ctx.platform.auth;
  if (typeof svc?.[method] !== 'function') return builtin();
  const ua = firstHeader(call.req.headers['user-agent']);
  const rq = {
    ip: call.ipInfo,
    userAgent: ua ? ua.slice(0, 200) : null,
    req: call.req,
    auth: call.user ? { user: call.user, session: call.session } : null,
  };
  try {
    const out = await svc[method](rq, params);
    for (const c of out?.cookies ?? []) addCookie(call.res, c);
    return out && typeof out === 'object' && Object.hasOwn(out, 'payload') ? out.payload : out;
  } catch (err) {
    for (const c of err?.setCookies ?? []) addCookie(call.res, c);
    throw err;
  }
}

/** Canonical username (§4.1): NFKC, trim, lower-case; null unless it matches ^[a-z0-9_]{3,24}$. */
export function canonicalUsername(raw) {
  if (typeof raw !== 'string') return null;
  const c = raw.normalize('NFKC').trim().toLowerCase();
  return USERNAME_RE.test(c) ? c : null;
}

/** The per-name key of a typed username (malformed names are limited too, under their normalized text). */
function nameKey(raw) {
  return String(raw ?? '').normalize('NFKC').trim().toLowerCase().slice(0, 64);
}

/** Create a session for `user` and set its cookie plus the known-device cookie (§4.2). */
async function issueSession(ctx, call, user) {
  const P = ctx.platform;
  const ua = firstHeader(call.req.headers['user-agent']);
  const s = await P.sessions.create(user.id, { userAgent: ua ? ua.slice(0, 200) : null, ip: call.ipInfo?.ip ?? null });
  addCookie(call.res, s?.cookie);
  // The 21st session evicts the oldest: its streams end in the same tick.
  if (Array.isArray(s?.revoked) && s.revoked.length) closeStreamsFor(ctx, { uid: user.id, sessionIds: s.revoked, reason: 'revoked' });
  const kd = await P.sessions.knownDeviceCookie?.(user);
  if (typeof kd === 'string') addCookie(call.res, kd);
  return s;
}

/** Revoke every session of `uid` and end their streams in the same tick (§4.2). → number revoked. */
async function revokeAllFor(ctx, uid, reason) {
  const out = await ctx.platform.sessions.revokeAll(uid);
  closeStreamsFor(ctx, { uid, reason });
  return Array.isArray(out) ? out.length : Number.isFinite(out) ? out : 0;
}

function adminExists(ctx) {
  const viaUsers = safeCall(ctx, () => ctx.platform.users.adminExists?.());
  if (typeof viaUsers === 'boolean') return viaUsers;
  return Boolean(dbGet(ctx, SQL.anyAdmin));
}

async function authSignup(ctx, p, call) {
  const P = ctx.platform;
  const ip = call.ipInfo;
  const code = typeof p.bootstrap_code === 'string' && p.bootstrap_code.trim() ? p.bootstrap_code.trim() : null;
  const mode = signupMode(ctx);
  // The first admin may always sign up with the bootstrap code (Users checks it), whatever the sign-up mode.
  if (mode !== 'open' && !(code !== null && !adminExists(ctx))) {
    if (mode === 'invite' && typeof P.invites?.check === 'function' && p.invite) {
      if (!(await P.invites.check(p.invite))) throw apiError(403, 'that invite is not valid', 'signup_closed');
    } else {
      throw apiError(403, 'sign-up is closed on this server', 'signup_closed');
    }
  }
  // Order (§4.5): enumeration bucket → name validity and availability → creation budgets → scrypt → insert.
  await limitOrThrow(ctx, 'signup_attempt_ip', ip.bucketKey('signup'));
  if (typeof P.users.checkSignup === 'function') {
    await P.users.checkSignup({ username: p.username, password: p.password, bootstrapCode: code });
  } else {
    const name = canonicalUsername(p.username);
    if (!name) throw apiError(400, 'usernames are 3–24 characters: a–z, 0–9 and _', 'bad_username');
    if (RESERVED_USERNAMES.has(name) || (await P.users.byName(name))) throw apiError(409, 'that username is not available', 'username_unavailable');
  }
  // Creation budgets count successful creations only: check now, take once the insert has happened.
  const budgets = [['signup_create_ip', ip.bucketKey('signup')], ['signup_create_48', ip.bucketKey('signup48')], ['signup_global', '*']];
  for (const [scope, key] of budgets) {
    const r = await peek(ctx, scope, key);
    if (r.ok) continue;
    if (scope === 'signup_global') {
      throw apiError(503, 'many new gardens are being made right now; try again later', 'signup_busy', { retry_after_s: Math.ceil(r.retryAfterS) });
    }
    throw rateLimited(r.retryAfterS);
  }
  const user = await P.users.create({ username: p.username, password: p.password, bootstrapCode: code, lang: p.lang ?? null, ipKey: ip.bucketKey('login') });
  if (!user || user.id == null) throw new Error('Users.create returned no user');
  for (const [scope, key] of budgets) await take(ctx, scope, key);
  P.gardens.get(user.id); // the garden exists from the first second (Users.create inserted its row)
  await issueSession(ctx, call, user);
  audit(ctx, call, { action: 'signup', userId: user.id });
  return { user: publicUser(user) };
}

async function authLogin(ctx, p, call) {
  const P = ctx.platform;
  const ip = call.ipInfo;
  // Order (§4.1): per-IP bucket → per-username lockout → scrypt. Users.verify() runs the lockout (429) and exactly one
  // scrypt (a dummy hash for unknown names), records the failure or clears the counter.
  await limitOrThrow(ctx, 'login_ip', ip.bucketKey('login'));
  const existing = canonicalUsername(p.username) ? await P.users.byName(p.username) : null;
  const knownDevice = Boolean(existing && (await P.sessions.checkKnownDevice?.(call.req, existing)));
  const user = await P.users.verify(p.username, p.password, { knownDevice, ipKey: ip.bucketKey('login') });
  if (!user) {
    audit(ctx, call, { action: 'login_fail', userId: existing?.id ?? null, ok: false, target: existing ? null : nameTag(ctx, p.username) });
    throw apiError(401, 'wrong username or password', 'bad_credentials');
  }
  // Disabled accounts are told so only after a correct password (§4.6 step 7).
  if (user.status && user.status !== 'active') throw apiError(403, 'this account is disabled; contact the operator', 'account_disabled');
  await P.users.touchLogin?.(user.id);
  await issueSession(ctx, call, user);
  audit(ctx, call, { action: 'login_ok', userId: user.id });
  const out = { user: publicUser(user) };
  if (user.notice === 'password_reset') out.notice = 'password_reset';
  return out;
}

/** `login_fail` for an unknown name stores "h:" + HMAC(K_name, name)[0..16], never the typed text (§4.6 step 3). */
function nameTag(ctx, raw) {
  const mac = safeCall(ctx, () => ctx.platform.secrets?.hmacName?.(canonicalUsername(raw) ?? nameKey(raw)));
  return typeof mac === 'string' && mac ? `h:${mac.slice(0, 16)}` : null;
}

async function authReset(ctx, p, call) {
  const P = ctx.platform;
  const ip = call.ipInfo;
  await limitOrThrow(ctx, 'reset_ip', ip.bucketKey('login'));
  await limitOrThrow(ctx, 'reset_user', nameKey(p.username));
  // Users.redeemReset(): lockout (429), password policy (400 weak_password), single-use code; a wrong code counts as
  // a login failure for that name and answers null.
  const user = await P.users.redeemReset(p.username, p.code, p.new_password, { ipKey: ip.bucketKey('login') });
  if (!user) throw apiError(401, 'that reset code is not valid (wrong, used or expired)', 'bad_credentials');
  await revokeAllFor(ctx, user.id, 'password_reset');
  await issueSession(ctx, call, user);
  audit(ctx, call, { action: 'password_reset_used', userId: user.id });
  return { user: publicUser(user) };
}

async function authLogout(ctx, call) {
  const P = ctx.platform;
  if (call.user && call.session) {
    const pid = publicIdOf(call.session);
    await P.sessions.revoke(call.uid, pid);
    closeStreamsFor(ctx, { uid: call.uid, sessionIds: [pid], reason: 'logout' });
    audit(ctx, call, { action: 'logout', userId: call.uid });
  }
  clearSessionCookie(ctx, call.res);
  return { ok: true };
}

async function authLogoutAll(ctx, call) {
  const revoked = await revokeAllFor(ctx, call.uid, 'logout_all');
  clearSessionCookie(ctx, call.res);
  audit(ctx, call, { action: 'logout_all', userId: call.uid, detail: { count: revoked } });
  return { ok: true, revoked };
}

/** Re-check the signed-in player's own password (password change, deletion). Known device: no lockout here. */
async function verifyOwnPassword(ctx, call, password) {
  const user = await ctx.platform.users.verify(call.user.username, password, { knownDevice: true, ipKey: call.ipInfo.bucketKey('login') });
  if (!user || user.id !== call.uid) throw apiError(401, 'wrong password', 'bad_credentials');
  return user;
}

async function accountPassword(ctx, p, call) {
  const P = ctx.platform;
  await limitOrThrow(ctx, 'account_user', `u:${call.uid}`);
  await verifyOwnPassword(ctx, call, p.current_password);
  const changed = await P.users.setPassword(call.uid, p.new_password, { ipKey: call.ipInfo.bucketKey('login') }); // 400 weak_password
  await revokeAllFor(ctx, call.uid, 'password_changed');
  const user = changed && changed.id === call.uid ? changed : (await P.users.get(call.uid)) ?? call.user;
  await issueSession(ctx, call, user); // a fresh session, and a known-device cookie for the new pw_changed_ms
  audit(ctx, call, { action: 'password_changed', userId: call.uid });
  return { ok: true };
}

async function accountDelete(ctx, p, call) {
  const P = ctx.platform;
  await limitOrThrow(ctx, 'account_user', `u:${call.uid}`);
  requireConfirm(p.confirm, 'DELETE');
  await verifyOwnPassword(ctx, call, p.password);
  const uid = call.uid;
  // §4.6 step 6: halt + flatten (≤ 15 s), 409 testnet_positions_open unless force, teardown — then the DELETE.
  const result = typeof P.gardens.deleteUser === 'function'
    ? (await P.gardens.deleteUser(uid, { force: p.force === true, remove: (id) => P.users.remove(id) })) ?? {}
    : await haltForDelete(ctx, uid, p.force === true);
  if (await P.users.get(uid)) await P.users.remove(uid); // wipes keys, retires the name, cascades, checkpoints
  closeStreamsFor(ctx, { uid, reason: 'deleted' });
  clearSessionCookie(ctx, call.res);
  audit(ctx, call, { action: 'account_deleted', userId: uid });
  return {
    deleted: true,
    closed: Array.isArray(result.closed) ? result.closed : [],
    testnet_left_open: Array.isArray(result.testnet_left_open) ? result.testnet_left_open : [],
  };
}

/** Steps 2–4 of §4.6 step 6 when Gardens has no deleteUser(): halt, await the testnet flatten, teardown. */
async function haltForDelete(ctx, uid, force) {
  const P = ctx.platform;
  const g = P.gardens.get(uid);
  const halt = typeof g?.halt === 'function' ? await g.halt() : null;
  const closing = Array.isArray(halt?.closing) ? halt.closing : [];
  const left = closing.length ? await waitFlat(g, closing, 15_000) : [];
  if (left.length && !force) {
    throw apiError(409, 'some testnet positions could not be closed', 'testnet_positions_open', { positions: left });
  }
  await P.gardens.teardown?.(uid);
  return { closed: [...(halt?.closed ?? []), ...closing.filter((id) => !left.some((x) => x.bot === id))], testnet_left_open: left };
}

/** Wait (≤ ms) until the testnet bots `ids` are flat; → [{bot, coin, szi}] still open. */
async function waitFlat(g, ids, ms) {
  const openOnes = () => ids
    .map((id) => safeRow(g, id))
    .filter((b) => b && (b.state !== 'closed' || b.closing) && Math.abs(Number(b.exchange?.szi ?? b.real?.szi ?? 0)) > 0)
    .map((b) => ({ bot: b.id, coin: b.coin, szi: Number(b.exchange?.szi ?? b.real?.szi ?? 0) }));
  const deadline = Date.now() + ms;
  let left = openOnes();
  while (left.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    left = openOnes();
  }
  return left;
}

function safeRow(g, id) {
  try {
    return typeof g.rowOf === 'function' ? g.rowOf(id) : g.botDetail(id)?.bot ?? null;
  } catch {
    return null;
  }
}

async function sessionRevoke(ctx, p, call) {
  const out = await ctx.platform.sessions.revoke(call.uid, p.id);
  if (!out || (Array.isArray(out) && out.length === 0)) {
    throw apiError(404, 'no such session', 'not_found'); // also for another player's session (IDOR-safe)
  }
  closeStreamsFor(ctx, { uid: call.uid, sessionIds: [p.id], reason: 'revoked' });
  audit(ctx, call, { action: 'logout', userId: call.uid, detail: { reason: 'session_revoke' } });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Accounts mode: testnet credential ops (PLATFORM §6.7, §8.3)

function requireTestnet(ctx) {
  if (!ctx.testnetEnabled) throw apiError(503, 'testnet trading is not enabled on this server', 'testnet_disabled');
}

/** §6.7 step 1: `^0x[0-9a-fA-F]{40}$`, lower-cased. */
function normalizeAccountAddress(raw) {
  const s = String(raw ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw apiError(400, 'that is not a 0x… address of 42 characters', 'bad_address');
  return s.toLowerCase();
}

/**
 * §6.7 step 1 for the agent key: 64 hex (optional 0x) with a scalar in [1, n−1] (our own BigInt check, before any
 * library) → the 32 key bytes; 12+ words → 422 seed_phrase; anything else → 400 bad_key_format. Never echoes input.
 */
export function parseAgentKey(raw) {
  const s = String(raw ?? '').trim();
  const hex = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(s);
  if (!hex) {
    const words = s.split(/[^A-Za-z]+/).filter(Boolean);
    if (words.length >= 12) throw apiError(422, 'that looks like a seed phrase: never paste one here', 'seed_phrase');
    throw apiError(400, 'an API wallet key is 64 hex characters (optionally 0x…)', 'bad_key_format');
  }
  const scalar = BigInt(`0x${hex[1]}`);
  if (scalar < 1n || scalar >= SECP256K1_N) throw apiError(400, 'an API wallet key is 64 hex characters (optionally 0x…)', 'bad_key_format');
  return Uint8Array.from(Buffer.from(hex[1], 'hex'));
}

/**
 * The 5-per-hour connect limit counts only requests that reach Hyperliquid (§4.5): check before, take afterwards
 * unless the refusal says it did not count (format, testnet down, connect queue busy).
 */
async function countedConnect(ctx, call, fn) {
  const key = `u:${call.uid}`;
  const before = await peek(ctx, 'testnet_connect_user', key);
  if (!before.ok) throw rateLimited(before.retryAfterS);
  try {
    const out = await fn();
    await take(ctx, 'testnet_connect_user', key);
    return out;
  } catch (err) {
    const counts = err?.counts !== undefined ? err.counts !== false : !UNCOUNTED_CONNECT_CODES.has(err?.code);
    if (counts) await take(ctx, 'testnet_connect_user', key);
    throw err;
  }
}

async function testnetConnect(ctx, p, call) {
  requireTestnet(ctx);
  // Format checks first: no network, so they never count against the connect limit.
  const accountAddress = normalizeAccountAddress(p.account_address);
  const agentKeyBytes = parseAgentKey(p.agent_key);
  p.agent_key = null; // drop our reference to the pasted string at once (§5.1)
  try {
    return await countedConnect(ctx, call, () => connectFlow(ctx, call, { accountAddress, agentKeyBytes }));
  } finally {
    agentKeyBytes.fill(0); // the credential store sealed its own copy; never keep key bytes around
  }
}

/** A verifyAgent() refusal → ApiError (code, sub_reason, vars; `counts` kept for the connect limit). */
function verifyRefusal(r) {
  const extra = {};
  if (r.sub_reason) extra.sub_reason = r.sub_reason;
  if (r.vars && typeof r.vars === 'object') Object.assign(extra, r.vars);
  if (r.valid_until_ms != null) extra.valid_until_ms = r.valid_until_ms;
  if (r.account_value != null) extra.account_value = r.account_value;
  const err = apiError(Number.isInteger(r.status) ? r.status : 502, CONNECT_MESSAGES[r.code] ?? 'the testnet API wallet could not be verified', r.code ?? 'testnet_error', extra);
  err.counts = r.counts !== false;
  return err;
}

const CONNECT_MESSAGES = Object.freeze({
  bad_address: 'that is not a 0x… address of 42 characters',
  bad_key_format: 'an API wallet key is 64 hex characters (optionally 0x…)',
  seed_phrase: 'that looks like a seed phrase: never paste one here',
  master_key: "this is the account's own key, not an API wallet",
  not_agent: 'this key is not an API wallet of any testnet account',
  agent_mismatch: 'this API wallet belongs to another testnet account',
  mainnet_key: 'this key is known on mainnet: refused',
  mainnet_check_unavailable: 'the mainnet safety check could not be completed; nothing was stored — try again',
  agent_expired: 'this API wallet has expired',
  abstraction_unsupported: 'switch the testnet account to Standard or Unified on the testnet site',
  no_testnet_funds: 'this testnet account has no funds',
  testnet_down: 'Hyperliquid testnet is not answering; try again later',
  busy: 'many connects are running; try again in a minute',
});

/**
 * testnet_connect (§6.7): the platform's connect service when present; else verifyAgent (WP2, steps 1–7) →
 * Credentials.store (WP3, step 8: seal + upsert, Replace API wallet, take-over) → the taken-over gardens' testnet bots
 * close in their books (account_moved) → audit.
 */
async function connectFlow(ctx, call, { accountAddress, agentKeyBytes }) {
  const P = ctx.platform;
  const uid = call.uid;
  if (typeof P.testnetLink?.connect === 'function') return P.testnetLink.connect(uid, { accountAddress, agentKeyBytes });
  const verifier = P.testnet?.verify;
  if (typeof verifier?.verifyAgent !== 'function' || typeof P.credentials?.store !== 'function') {
    throw notWired(ctx, 'testnet connect (testnet.verify + credentials)');
  }
  const r = await verifier.verifyAgent({ accountAddress, agentKeyBytes });
  if (!r?.ok) {
    if (r?.code === 'mainnet_key') audit(ctx, call, { action: 'mainnet_key_detected', userId: uid, ok: false, detail: { reason: r.sub_reason ?? null } });
    throw verifyRefusal(r ?? {});
  }
  const stored = await P.credentials.store({
    uid, accountAddress: r.account_address, agentAddress: r.agent_address, agentName: r.agent_name ?? null,
    validUntilMs: r.valid_until_ms ?? null, abstraction: r.abstraction ?? null, valueAtConnect: r.account_value ?? null,
    keyBytes: agentKeyBytes, mainnetCheckedMs: r.mainnet_checked_ms ?? null,
  });
  for (const other of stored?.takeOver ?? []) moveAccountAway(ctx, other);
  audit(ctx, call, { action: stored?.replaced ? 'testnet_agent_replaced' : 'testnet_connected', userId: uid, detail: { venue: 'testnet' } });
  return {
    testnet: stored?.link ?? (await testnetLink(ctx, uid)),
    replaced: stored?.replaced === true,
    account: {
      account_value: r.account_value ?? null,
      account_value_est: r.account_value_est === true,
      withdrawable: r.withdrawable ?? r.free ?? null,
      as_of_ms: r.verified_ms ?? Date.now(),
    },
    warnings: Array.isArray(r.warnings) ? r.warnings : [],
  };
}

/** Take-over (§6.7 step 8): another garden's abandoned row was wiped; its testnet bots close in our books only. */
function moveAccountAway(ctx, otherUid) {
  const P = ctx.platform;
  try {
    if (typeof P.gardens.accountMoved === 'function') {
      P.gardens.accountMoved(otherUid);
      return;
    }
    const g = P.gardens.get(otherUid);
    const rows = g?.bots?.({ state: 'open' })?.rows ?? [];
    for (const b of rows) if (b.venue === 'testnet') g.closeInBooks?.(b.id, 'account_moved');
  } catch (err) {
    ctx.log(`[api] account take-over: closing the previous garden's testnet bots failed (${err?.name ?? 'Error'})`);
  }
}

async function testnetVerify(ctx, call) {
  requireTestnet(ctx);
  const svc = ctx.platform.testnetLink;
  if (typeof svc?.verify !== 'function') throw notWired(ctx, 'testnetLink.verify');
  return countedConnect(ctx, call, () => svc.verify(call.uid));
}

/**
 * testnet_disconnect (§8.3) and the admin disconnect / reset hooks: the platform's service when present; else
 * 409 has_open_testnet_bots unless closeBots → close them (each awaits its flatten ≤ 8 s) → 409
 * testnet_positions_open unless force → wipe the credential (zero, delete, WAL checkpoint) → audit.
 */
async function disconnectFlow(ctx, uid, { closeBots = false, force = false, by = 'user', reason = null } = {}) {
  const P = ctx.platform;
  if (typeof P.testnetLink?.disconnect === 'function') return P.testnetLink.disconnect(uid, { closeBots, force, by, reason });
  if (typeof P.credentials?.wipe !== 'function') throw notWired(ctx, 'credentials.wipe');
  const g = P.gardens.get(uid);
  const open = (g?.bots?.({ state: 'open' })?.rows ?? []).filter((b) => b.venue === 'testnet');
  if (open.length && !closeBots) {
    throw apiError(409, `close your ${open.length} testnet bot(s) first`, 'has_open_testnet_bots', { n: open.length });
  }
  const closed = [];
  for (const b of open) {
    try {
      await awaitWithin(g.close({ id: b.id }), 8000);
      closed.push(b.id);
    } catch (err) {
      ctx.log(`[api] disconnect: closing ${b.id} failed (${err?.code ?? err?.name ?? 'Error'})`);
    }
  }
  const leftOpen = open.length ? await waitFlat(g, open.map((b) => b.id), 15_000) : [];
  if (leftOpen.length && !force) {
    throw apiError(409, 'some testnet positions could not be closed', 'testnet_positions_open', { positions: leftOpen.map(({ coin, szi }) => ({ coin, szi })) });
  }
  // With force, positions stay open on testnet: those bots leave our books (no credential is left to manage them).
  for (const x of leftOpen) safeCall(ctx, () => g.closeInBooks?.(x.bot, 'credential_revoked'));
  P.credentials.wipe(uid, { reason: reason ?? 'disconnected' });
  audit(ctx, null, { action: 'testnet_disconnected', userId: uid, actor: by === 'admin' ? 'admin' : 'user', detail: { reason: reason ?? 'disconnected' } });
  return { disconnected: true, closed: closed.filter((id) => !leftOpen.some((x) => x.bot === id)), left_open: leftOpen.map(({ coin, szi }) => ({ coin, szi })) };
}

// ---------------------------------------------------------------------------------------------
// Accounts mode: admin ops (PLATFORM §5.4, §8.6). WP1's Admin service does the data side; these fill the gaps.

/** Read-only SQL fallbacks for when no platform service covers a read (constant strings, `?` bindings only, §3.2). */
const SQL = Object.freeze({
  select1: 'SELECT 1 AS ok',
  anyAdmin: "SELECT 1 AS ok FROM users WHERE role = 'admin' LIMIT 1",
  countUsers: 'SELECT count(*) AS n FROM users',
  credentialLink: "SELECT status, account_address, agent_address, agent_name, valid_until_ms, verified_ms, status_reason, " +
    "abstraction, value_at_connect, created_ms AS connected_ms FROM credentials WHERE user_id = ? AND venue = 'hl_testnet'",
});

function dbGet(ctx, sql, ...args) {
  const db = ctx.platform.db;
  if (!db || typeof db.prepare !== 'function') return null;
  return db.prepare(sql).get(...args) ?? null;
}

function requireAdminService(ctx, method) {
  const admin = ctx.platform.admin;
  if (typeof admin?.[method] !== 'function') throw notWired(ctx, `admin.${method}`);
  return admin;
}

async function adminStatus(ctx) {
  const P = ctx.platform;
  const g = safeCall(ctx, () => P.gardens.stats?.()) ?? {};
  const sched = safeCall(ctx, () => P.testnet?.scheduler?.stats?.()) ?? {};
  const exch = safeCall(ctx, () => P.testnet?.exchange?.stats?.()) ?? {};
  const market = P.testnet?.market;
  const mstatus = safeCall(ctx, () => market?.status?.()) ?? null;
  const signing = safeCall(ctx, () => P.admin?.getSigningHalt?.());
  const feed = safeCall(ctx, () => ctx.engine.status?.())?.feed ?? {};
  const dbs = safeCall(ctx, () => P.admin?.dbStatus?.()) ?? {};
  const backup = latestBackup(ctx);
  const out = {
    version: ctx.version,
    uptime_s: Math.floor((Date.now() - ctx.startedMs) / 1000),
    users: dbs.users ?? dbGet(ctx, SQL.countUsers)?.n ?? null,
    sessions_active: dbs.sessions_active ?? safeCall(ctx, () => P.sessions.countActive?.()) ?? null,
    sse_streams: sseStats(ctx),
    gardens_loaded: g.gardens_loaded ?? g.loaded ?? null,
    bots: { paper_open: g.bots?.paper_open ?? g.paper_open ?? null, testnet_open: g.bots?.testnet_open ?? g.testnet_open ?? null },
    testnet: {
      enabled: ctx.testnetEnabled === true,
      state: ctx.testnetEnabled ? mstatus?.state ?? g.testnet?.state ?? null : 'disabled',
      state_reason: mstatus?.reason ?? null,
      signing_halted: signing === true || signing?.halted === true || g.testnet?.signing_halted === true,
      kill_switch: killSwitchOf(ctx),
      weight_60s: sched.weight_60s ?? g.testnet?.weight_60s ?? null,
      budget: sched.budget ?? g.testnet?.budget ?? null,
      active_users: g.testnet?.active_users ?? g.testnet_active ?? sched.active_users ?? null,
      max_active_users: g.testnet?.max_active_users ?? ctx.config.testnetMaxActiveUsers ?? null,
      exchange_actions_60s: exch.actions_60s ?? sched.exchange_actions_60s ?? g.testnet?.exchange_actions_60s ?? null,
      errors_60s: exch.errors_60s ?? sched.errors_60s ?? g.testnet?.errors_60s ?? null,
      lanes_busy: sched.lanes_busy ?? g.testnet?.lanes_busy ?? null,
    },
    mainnet: {
      weight_60s: feed.weight_60s ?? null,
      user_role_queue: sched.user_role_queue ?? g.mainnet?.user_role_queue ?? null,
      rechecks_due: g.rechecks_due ?? g.mainnet?.rechecks_due ?? null,
    },
    client_ip: { source: ctx.platform.clientIp?.source ?? ctx.lastIpSource, buckets_1h: bucketsLastHour(ctx) },
    db: {
      size_bytes: dbs.db?.size_bytes ?? null,
      wal_bytes: dbs.db?.wal_bytes ?? null,
      last_backup_ms: dbs.db?.last_backup_ms ?? backup?.ms ?? null,
      last_backup_file: dbs.db?.last_backup_file ?? backup?.file ?? null,
    },
    event_loop_p99_ms: ctx.loopP99 ?? (ctx.loopDelay ? ctx.loopDelay.percentile(99) / 1e6 : null),
  };
  const extra = await P.adminStatus?.();
  return extra && typeof extra === 'object' ? { ...out, ...extra } : out;
}

/**
 * The data directory: `config.dataDir` when the composition root passes it, else (accounts mode) the directory of
 * the open DB file (`platform.db.file`, §12.2 Db), which lives in the data dir (§3.1). null when unknown (none mode
 * without the option, or an in-memory DB).
 */
function dataDirOf(ctx) {
  if (typeof ctx.config.dataDir === 'string' && ctx.config.dataDir) return ctx.config.dataDir;
  const file = ctx.platform?.db?.file;
  return typeof file === 'string' && file && file !== ':memory:' ? path.dirname(file) : null;
}

/**
 * The last backup (§8.6 admin_status.db): WP1's backup scheduler when the bag exposes it (`backups.last()` or
 * `backupStatus()`), else the newest `bean*.db` in <data>/backups (§10.5). → {ms, file} | null
 */
function latestBackup(ctx) {
  const P = ctx.platform;
  const known = safeCall(ctx, () => (typeof P.backups?.last === 'function' ? P.backups.last() : P.backupStatus?.()));
  if (known && typeof known === 'object' && (known.last_backup_ms != null || known.ms != null)) {
    return { ms: known.last_backup_ms ?? known.ms, file: known.last_backup_file ?? known.file ?? null };
  }
  const data = dataDirOf(ctx);
  const dir = data ? path.join(data, 'backups') : null;
  if (!dir) return null;
  try {
    let best = null;
    for (const name of fs.readdirSync(dir)) {
      if (!/^bean.*\.db$/.test(name)) continue;
      const st = fs.statSync(path.join(dir, name));
      if (!best || st.mtimeMs > best.ms) best = { file: name, ms: Math.floor(st.mtimeMs) };
    }
    return best;
  } catch {
    return null;
  }
}

function adminUsers(ctx, { q, limit, offset }) {
  return requireAdminService(ctx, 'listUsers').listUsers({ q: q ?? null, limit, offset });
}

function adminAudit(ctx, { user, action, limit, offset }) {
  return requireAdminService(ctx, 'auditQuery').auditQuery({ user: user ?? null, action: action ?? null, limit, offset });
}

async function adminKillSwitch(ctx, { on, reason }, call) {
  const P = ctx.platform;
  const by = call.uid ?? null;
  let flattening = [];
  if (typeof P.gardens.killSwitch === 'function') {
    // Gardens persists (Admin.setKillSwitch, audited), flattens every testnet bot and emits `kill_switch`.
    const res = await P.gardens.killSwitch({ on, reason: reason ?? null, by });
    if (Array.isArray(res?.flattening)) flattening = res.flattening;
  } else {
    const ks = requireAdminService(ctx, 'setKillSwitch').setKillSwitch(on, reason ?? null, by);
    ctx.journal.emit('kill_switch', { on: ks.on, reason: ks.reason, since_ms: ks.since_ms });
  }
  return { kill_switch: killSwitchOf(ctx), flattening };
}

async function adminTestnetSigning(ctx, { resume }, call) {
  if (resume !== true) throw apiError(400, 'send resume: true to clear the signing halt', 'bad_request');
  const P = ctx.platform;
  if (typeof P.gardens.resumeSigning === 'function') {
    await P.gardens.resumeSigning(call.uid ?? null); // persists through Admin (audited), resumes kept flatten intents
  } else {
    requireAdminService(ctx, 'setSigningHalt').setSigningHalt(false, null, call.uid ?? null); // audited by Admin
    safeCall(ctx, () => P.testnet?.exchange?.setSigningHalt?.(false));
  }
  safeCall(ctx, () => P.testnet?.market?.evaluate?.());
  return { signing_halted: false };
}

async function adminCaps(ctx, p, call) {
  const P = ctx.platform;
  const patch = {};
  if (p.paper !== undefined) patch.paper = p.paper;
  if (p.testnet !== undefined) patch.testnet = p.testnet;
  if (!Object.keys(patch).length) throw apiError(400, 'send paper and/or testnet caps', 'bad_request');
  const by = call.uid ?? null;
  // Admin validates (known keys, ranges, min ≤ max) and audits; Gardens applies the caps to new bots.
  if (p.user) {
    const target = await P.users.byName(p.user);
    if (!target) throw apiError(404, 'no such player', 'not_found');
    if (typeof P.gardens.setUserCaps === 'function') return { caps: await P.gardens.setUserCaps(target.id, patch, by) };
    return { caps: requireAdminService(ctx, 'setUserCaps').setUserCaps(target.id, patch, by) };
  }
  if (typeof P.gardens.setCaps === 'function') return { caps: await P.gardens.setCaps(patch, by) };
  return { caps: requireAdminService(ctx, 'setCaps').setCaps(patch, by) };
}

/** admin_user (§8.6): WP1's Admin.userAction (role changes need a session + the caller's own password). */
async function adminUser(ctx, { username, action, password }, call) {
  const admin = requireAdminService(ctx, 'userAction');
  return admin.userAction({
    actor: call.user ? { id: call.uid } : null,
    viaBearer: call.bearer,
    username,
    action,
    password: password ?? null,
    ipKey: call.ipInfo.bucketKey('login'),
    ip: call.ipInfo.prefix?.() ?? null,
  });
}

async function adminBackup(ctx, call) {
  const P = ctx.platform;
  if (typeof P.backup !== 'function') throw notWired(ctx, 'platform.backup');
  const r0 = await take(ctx, 'admin_backup', '*');
  if (!r0.ok) throw rateLimited(r0.retryAfterS, 'a backup ran less than 10 minutes ago');
  const r = await P.backup();
  audit(ctx, call, { action: 'admin_backup', userId: call.uid ?? null, actor: call.bearer ? 'ops' : 'admin' });
  return { file: r?.file ?? null, bytes: r?.bytes ?? null, ms: r?.ms ?? null };
}

// ---------------------------------------------------------------------------------------------
// Command auth (none mode; SPEC §4 — stricter than brood: no blanket loopback exemption)

/**
 * → 'token' | 'loopback' when the command may run, null otherwise.
 *  1. a valid token in `Authorization: Bearer T` or `X-Brood-Token: T` (constant-time compare), from anywhere;
 *  2. otherwise ALL of: loopback peer, no proxy headers, loopback Host (anti DNS-rebinding),
 *     and no Origin or an Origin equal to the request's own origin (anti CSRF).
 *     Rule 2 trusts the socket peer, so a plain TCP forward (ssh -R, socat) looks local: `loopbackCommands:
 *     false` (CLI --no-loopback-commands) switches it off and makes the token mandatory.
 * Either header may carry the token: a proxy that injects its own `Authorization` must not hide a valid
 * `X-Brood-Token`, so both candidates are checked (each in constant time).
 */
function commandAuth(ctx, req) {
  if (ctx.token) {
    const candidates = [bearerToken(req.headers.authorization), firstHeader(req.headers['x-brood-token'])];
    let valid = false;
    for (const presented of candidates) if (presented && tokensEqual(presented, ctx.token)) valid = true;
    if (valid) return 'token';
  }
  return ctx.loopbackCommands && isSameOriginLoopback(req) ? 'loopback' : null;
}

function bearerToken(header) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(firstHeader(header) ?? '');
  return m ? m[1] : null;
}

function firstHeader(value) {
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Constant-time comparison; hashing first gives equal-length inputs and hides the token length. */
function tokensEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isSameOriginLoopback(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  const host = req.headers.host;
  if (typeof host !== 'string' || !LOOPBACK_HOST_RE.test(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    // URL normalises case and default ports; an opaque origin ("null") fails to parse → refused.
    return new URL(origin).origin === new URL(`http://${host}`).origin;
  } catch {
    return false;
  }
}

function isLoopbackAddress(address) {
  const a = String(address ?? '').toLowerCase();
  return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}

// ---------------------------------------------------------------------------------------------
// Request parsing

/** URLSearchParams → plain raw object; a repeated key becomes an array of its values. */
function queryRaw(searchParams) {
  const raw = Object.create(null);
  for (const [key, value] of searchParams) {
    raw[key] = key in raw ? [].concat(raw[key], value) : value;
  }
  return raw;
}

/** Read the request body as UTF-8 text, refusing more than `limit` bytes (413). */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(apiError(413, `request body exceeds ${limit / 1024} KB`, 'body_too_large'), { closeConnection: true });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return; // over the limit: keep draining, keep nothing
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Empty body → {}; otherwise it must be a JSON object. With `redact` (sensitive ops, PLATFORM §5.3) a parse failure
 * says only 'invalid JSON body': V8's message quotes the text around the error, which can be a pasted key.
 */
function parseJsonBody(text, { redact = false } = {}) {
  if (!text.trim()) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw apiError(400, redact ? 'invalid JSON body' : `invalid JSON body: ${err.message}`, 'invalid_json');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw apiError(400, 'JSON body must be an object', 'bad_request');
  }
  return body;
}

// ---------------------------------------------------------------------------------------------
// Responses

function sendJson(ctx, call, status, payload, extraHeaders = {}) {
  const { res } = call;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(payload ?? null);
  const headers = { ...API_HEADERS, 'Content-Length': Buffer.byteLength(body), ...extraHeaders };
  if (!call.cors) delete headers['Access-Control-Allow-Origin'];
  res.writeHead(status, headers);
  res.end(res.req?.method === 'HEAD' ? undefined : body);
}

function sendPreflight(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, X-Brood-Token, Content-Type',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    'Content-Length': '0',
  });
  res.end();
}

/** Accounts mode (§4.4): CORS only for the public GET queries; every other preflight gets a bare 204. */
function sendPreflightAccounts(call, pathname, op) {
  const publicGet = pathname === API_PREFIX || (op && op.kind === 'query' && op.auth === 'public');
  const headers = { 'Cache-Control': 'no-store', 'Content-Length': '0' };
  if (publicGet) {
    Object.assign(headers, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' });
  }
  call.res.writeHead(204, headers);
  call.res.end();
}

function errorStatus(err) {
  const s = err?.status;
  return Number.isInteger(s) && s >= 400 && s <= 599 ? s : 500;
}

/**
 * Every error leaves as `{error, status}` with the same HTTP status. None mode: exactly as before, plus `code` on the
 * two errors that did not exist before the upgrade. Accounts mode: always a machine `code` (catalog ERROR_CODES;
 * none on a 500), the error's extra fields (`retry_after_s`, `positions`, `sub_reason`, …), `Retry-After` on 429/503,
 * and 500s never echo their message (sensitive ops log only the op, the error's name and a code, §5.3).
 */
function sendError(ctx, call, err) {
  const { res } = call;
  const status = errorStatus(err);
  let message = err?.message || String(err);
  const headers = {};
  let body;
  if (ctx.mode === 'none') {
    if (status === 500 && !(err instanceof ApiError)) {
      ctx.log(`[api] internal error: ${err?.stack || err}`);
      message = `internal error: ${message}`;
    }
    body = { error: message, status };
    if (NONE_MODE_CODES.includes(err?.code)) body.code = err.code;
  } else {
    if (status === 500) {
      const op = String(call.op?.name ?? call.url?.pathname ?? '?').replace(/[^\w/]/g, '');
      if (call.sensitive) ctx.log(`[api] ${op} → 500 internal error (${/^[A-Za-z]{1,40}$/.test(err?.name ?? '') ? err.name : 'Error'}, internal)`);
      else ctx.log(`[api] ${op} internal error: ${err?.stack || err}`);
      message = 'internal error';
    }
    body = { error: message, status };
    let code = null;
    if (isErrorCode(err?.code)) code = err.code;
    else {
      if (typeof err?.code === 'string' && status !== 500) {
        warnOnce(ctx, `code:${err.code}`, `[api] error code '${err.code}' is not in ERROR_CODES — sent as the default for ${status}`);
      }
      code = DEFAULT_CODE_BY_STATUS[status] ?? null;
    }
    if (code) body.code = code;
    const extra = err?.extra && typeof err.extra === 'object' ? err.extra : null;
    if (extra && status !== 500) for (const [k, v] of Object.entries(extra)) if (!(k in body)) body[k] = v;
    const retry = Number(body.retry_after_s ?? err?.retryAfterS);
    if ((status === 429 || status === 503) && Number.isFinite(retry) && retry > 0) {
      body.retry_after_s = Math.ceil(retry);
      headers['Retry-After'] = String(Math.ceil(retry));
    }
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (status === 405 && err.allow) headers.Allow = err.allow;
  if (err?.closeConnection) headers.Connection = 'close';
  try {
    sendJson(ctx, call, status, body, headers);
  } catch {
    res.destroy();
  }
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------------------------------------
// /healthz and /readyz (PLATFORM §10.4)

async function serveHealth(ctx, call, pathname) {
  const { req, res } = call;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw Object.assign(new ApiError(405, `method ${req.method} not allowed here; use GET`), { allow: 'GET, HEAD' });
  }
  let status = 200;
  let payload = { ok: true };
  if (pathname === '/readyz') {
    const why = notReady(ctx);
    if (why) {
      status = 503;
      payload = { ok: false, why };
    }
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Why the process should not receive traffic now, or null (warm, DB answers, not stopping, data dir writable). */
function notReady(ctx) {
  if (ctx.shuttingDown) return 'shutting_down';
  try {
    if (ctx.engine.health?.()?.ok === false) return 'warming_up';
  } catch {
    return 'engine';
  }
  const db = ctx.platform.db;
  if (ctx.mode === 'accounts' && db) {
    try {
      const ok = typeof db.ping === 'function' ? db.ping() : Boolean(dbGet(ctx, SQL.select1));
      if (!ok) return 'db';
    } catch {
      return 'db';
    }
  }
  const dataDir = dataDirOf(ctx);
  if (dataDir) {
    try {
      fs.accessSync(dataDir, fs.constants.W_OK);
    } catch {
      return 'data_dir';
    }
  }
  const extra = safeCall(ctx, () => ctx.platform.readiness?.());
  if (extra && extra.ok === false) return String(extra.why ?? 'platform');
  return null;
}

// ---------------------------------------------------------------------------------------------
// Server-Sent Events

/** Frame one journal record as an SSE message (record kinds never contain newlines; enforce it). */
function sseFrame(record) {
  const kind = String(record.kind).replace(/[\r\n]/g, '');
  return `id: ${record.seq}\nevent: ${kind}\ndata: ${JSON.stringify(record)}\n\n`;
}

/** Frame one ephemeral pulse message: NO id line, so Last-Event-ID never moves and nothing is replayed. */
function ssePulseFrame(msg) {
  const kind = String(msg.kind).replace(/[\r\n]/g, '');
  return `event: ${kind}\ndata: ${JSON.stringify(msg)}\n\n`;
}

function parseLastEventId(value) {
  const text = firstHeader(value);
  if (text === null || !/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

/** None mode: the SPEC §4 stream, unchanged (every record global, 1 MB per-stream buffer, CORS *). */
function openStream(ctx, call) {
  const { req, res, url } = call;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  });
  res.flushHeaders();
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  req.socket.setTimeout(0);

  let lastSent = -Infinity; // highest seq written, so replay and live never duplicate
  const write = (chunk) => {
    if (res.destroyed || res.writableEnded) return;
    res.write(chunk);
    if (res.writableLength > SSE_MAX_BUFFERED) res.destroy(); // client stopped reading
  };
  const send = (record) => {
    if (!record || record.seq <= lastSent) return;
    lastSent = record.seq;
    write(sseFrame(record));
  };

  write('retry: 3000\n: hello\n\n');

  // Replay and subscribe in the same synchronous turn: no record can slip in between.
  const lastId = parseLastEventId(req.headers['last-event-id'] ?? url.searchParams.get('lastEventId'));
  if (lastId !== null) for (const record of ctx.journal.since(lastId)) send(record);
  const unsubscribeJournal = ctx.journal.subscribe(send);
  const unsubscribePulse = ctx.pulse ? ctx.pulse.subscribe((msg) => write(ssePulseFrame(msg))) : () => {};

  const ping = setInterval(() => write(': ping\n\n'), ctx.ssePingMs);
  ping.unref?.();

  const stream = { res, uid: null, spectator: true, queued: 0 };
  let cleaned = false;
  stream.cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(ping);
    unsubscribeJournal();
    unsubscribePulse();
    ctx.streams.delete(stream);
  };
  ctx.streams.add(stream);
  // 'close' on the response fires when the client goes away (or we destroy it). Not req 'close':
  // since Node 16 that can fire as soon as the (empty) request body has been consumed.
  res.on('close', stream.cleanup);
}

/** Take an SSE slot (§4.5): WP1's StreamSlots when wired, else the built-in counters. → release() */
function acquireStreamSlot(ctx, uid, ipKey) {
  const slots = ctx.platform.streamSlots;
  let r;
  if (typeof slots?.acquire === 'function') {
    r = slots.acquire({ uid: uid ?? null, ipKey });
  } else {
    const cfg = ctx.sseCfg;
    const s = ctx.sse;
    if (ctx.streams.size >= cfg.total) r = { ok: false, reason: 'total' };
    else if (uid == null && s.spectators >= cfg.spectators) r = { ok: false, reason: 'spectators' };
    else if ((s.byIp.get(ipKey) ?? 0) >= cfg.perIp) r = { ok: false, reason: 'ip' };
    else if (uid != null && (s.byUser.get(uid) ?? 0) >= cfg.perUser) r = { ok: false, reason: 'user' };
    else {
      if (uid == null) s.spectators++;
      else s.byUser.set(uid, (s.byUser.get(uid) ?? 0) + 1);
      s.byIp.set(ipKey, (s.byIp.get(ipKey) ?? 0) + 1);
      let released = false;
      r = {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          if (uid == null) s.spectators = Math.max(0, s.spectators - 1);
          else decrement(s.byUser, uid);
          decrement(s.byIp, ipKey);
        },
      };
    }
  }
  if (r?.ok) return r.release ?? (() => {});
  if (r?.reason === 'user') throw rateLimited(5, 'too many open streams for this player');
  if (r?.reason === 'ip') throw rateLimited(5, 'too many open streams from this address');
  throw apiError(503, 'the garden is full right now; try again soon', 'busy', { retry_after_s: 10 });
}

function decrement(map, key) {
  const n = (map.get(key) ?? 0) - 1;
  if (n > 0) map.set(key, n);
  else map.delete(key);
}

/**
 * Accounts mode (PLATFORM §8.7): the same framing, scoped per player. A stream opened with a valid session gets the
 * global records plus that player's own; a spectator stream gets global records only. `mids` frames carry the
 * subscriber's own garden part, attached here at write time. The §4.5 limits and buffering budgets apply.
 */
async function openStreamAccounts(ctx, call) {
  const { req, res, url } = call;
  const cfg = ctx.sseCfg;
  if (ctx.shuttingDown) throw apiError(503, 'the server is restarting; try again in a moment', 'server_restarting');
  await rateQuery(ctx, call, cfg.openCost); // an open (and its replay) costs 10 query tokens
  await resolveSession(ctx, call); // a stale cookie simply means a spectator stream
  const uid = call.uid;
  const spectator = uid == null;
  const ipKey = call.ipInfo.bucketKey('sse');
  const release = acquireStreamSlot(ctx, uid, ipKey);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  res.flushHeaders();
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  req.socket.setTimeout(0);

  const stream = {
    res, uid, spectator, ipKey, queued: 0,
    publicId: publicIdOf(call.session),
    expiresMs: call.session?.expiresMs ?? call.session?.expires_ms ?? null,
  };
  ctx.streams.add(stream);

  stream.write = (chunk) => {
    if (res.destroyed || res.writableEnded) return;
    res.write(chunk);
    accountQueued(ctx, stream);
  };
  res.on('drain', () => accountQueued(ctx, stream));

  let lastSent = -Infinity;
  const send = (record) => {
    if (!record || record.seq <= lastSent) return;
    if (!visibleTo(ctx, record, uid)) return; // the edge re-check (§8.7): fail closed
    lastSent = record.seq;
    stream.write(recordFrame(ctx, record));
  };
  stream.write('retry: 3000\n: hello\n\n');

  // Replay and subscribe in the same synchronous turn: no record can slip in between.
  const lastId = parseLastEventId(req.headers['last-event-id'] ?? url.searchParams.get('lastEventId'));
  if (lastId !== null) {
    const replay = typeof ctx.journal.sinceFor === 'function' ? ctx.journal.sinceFor(uid ?? null, lastId) : ctx.journal.since(lastId);
    if (replay && !Array.isArray(replay) && replay.resync) stream.write(ssePulseFrame({ kind: 'resync' }));
    else for (const record of replay ?? []) send(record);
  }
  const unsubscribeJournal = ctx.journal.subscribe(send);
  const unsubscribePulse = ctx.pulse ? ctx.pulse.subscribe((msg) => stream.write(pulseText(ctx, msg, uid))) : () => {};

  const ping = setInterval(() => stream.write(': ping\n\n'), ctx.ssePingMs);
  ping.unref?.();
  // Backstop (§4.2): revocations close streams at once; this catches expiry and disabled or deleted players.
  const recheck = spectator ? null : setInterval(() => recheckStream(ctx, stream), cfg.recheckMs);
  recheck?.unref?.();

  let cleaned = false;
  stream.cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(ping);
    if (recheck) clearInterval(recheck);
    unsubscribeJournal();
    unsubscribePulse();
    ctx.streams.delete(stream);
    ctx.sse.buffered = Math.max(0, ctx.sse.buffered - stream.queued);
    stream.queued = 0;
    release();
  };
  res.on('close', stream.cleanup);
}

/** The SSE text of a journal record, built once and shared by every stream that receives it. */
function recordFrame(ctx, record) {
  let text = ctx.recordText.get(record);
  if (text === undefined) {
    // An internal `uid` is non-enumerable (journal.js), so JSON never carries it; strip it anyway if enumerable.
    const out = Object.prototype.propertyIsEnumerable.call(record, 'uid') ? (({ uid: _u, ...rest }) => rest)(record) : record;
    text = sseFrame(out);
    ctx.recordText.set(record, text);
  }
  return text;
}

/**
 * The SSE text of a pulse message for one subscriber: `mids` gets the subscriber's own garden part
 * (gardens.marksFor(uid) → {bots, account, testnet_account}); everything else, and spectators, the shared frame.
 * Memoized per frame (and per uid), so many streams of one player cost one serialization.
 */
function pulseText(ctx, msg, uid) {
  const memo = ctx.midsMemo;
  if (memo.msg !== msg) {
    memo.msg = msg;
    memo.shared = null;
    memo.byUid.clear();
  }
  if (uid == null || msg.kind !== 'mids' || typeof ctx.platform.gardens.marksFor !== 'function') {
    memo.shared ??= ssePulseFrame(msg);
    return memo.shared;
  }
  let text = memo.byUid.get(uid);
  if (text === undefined) {
    const part = safeCall(ctx, () => ctx.platform.gardens.marksFor(uid));
    if (part && typeof part === 'object') {
      const own = {};
      for (const key of ['bots', 'account', 'testnet_account']) if (part[key] !== undefined) own[key] = part[key];
      text = ssePulseFrame({ ...msg, ...own });
    } else {
      text = memo.shared ??= ssePulseFrame(msg);
    }
    memo.byUid.set(uid, text);
  }
  return text;
}

/**
 * Buffering budgets (§4.5): a stream with more than `streamBytes` queued is dropped; when the queued total of every
 * stream passes `globalBytes`, the stream with the most queued bytes is dropped first.
 */
function accountQueued(ctx, stream) {
  const now = stream.res.writableLength;
  ctx.sse.buffered += now - stream.queued;
  stream.queued = now;
  if (now > ctx.sseCfg.streamBytes) {
    dropStream(stream);
    return;
  }
  while (ctx.sse.buffered > ctx.sseCfg.globalBytes) {
    let worst = null;
    for (const s of ctx.streams) if (!worst || s.queued > worst.queued) worst = s;
    if (!worst || worst.queued === 0) break;
    dropStream(worst);
  }
}

function dropStream(stream) {
  stream.cleanup?.();
  stream.res.destroy();
}

/** End a stream politely: one stream-only frame (no id), then the response ends. */
function endStream(stream, kind, data = {}) {
  if (!stream.res.destroyed && !stream.res.writableEnded) {
    try {
      stream.res.write(ssePulseFrame({ kind, ...data }));
      stream.res.end();
    } catch {
      stream.res.destroy();
    }
  }
  stream.cleanup?.();
}

/**
 * http.closeStreamsFor (PLATFORM §12.2): end every stream of player `uid` — or only those opened by `sessionIds`
 * (public session ids) — with `event: session_ended {reason}`, synchronously. Called by every revocation path here
 * and by gardens.teardown(uid) / Admin hooks. → number of streams ended.
 */
export function closeStreamsFor(ctx, { uid, sessionIds = null, reason = 'revoked' } = {}) {
  if (!ctx.streams || uid == null) return 0;
  const ids = Array.isArray(sessionIds) ? new Set(sessionIds.filter((x) => x != null).map(String)) : null;
  let n = 0;
  for (const s of [...ctx.streams]) {
    if (s.uid == null || s.uid !== uid) continue;
    if (ids && !ids.has(String(s.publicId))) continue;
    endStream(s, 'session_ended', { reason });
    n++;
  }
  return n;
}

/** Backstop re-check of one player's stream: the session (expiry, idle, user status) is still valid. */
async function recheckStream(ctx, stream) {
  try {
    const sessions = ctx.platform.sessions;
    let valid;
    if (typeof sessions?.stillValid === 'function' && stream.publicId) valid = await sessions.stillValid(stream.publicId);
    else {
      const user = await ctx.platform.users.get(stream.uid);
      valid = Boolean(user) && (!user.status || user.status === 'active') && !(stream.expiresMs != null && Date.now() >= stream.expiresMs);
    }
    if (!valid) endStream(stream, 'session_ended', { reason: 'expired' });
  } catch (err) {
    ctx.log(`[api] stream re-check failed: ${err?.name ?? 'Error'}`);
  }
}

/** Graceful shutdown (§10.4 steps 1–2): refuse new commands, fail /readyz, tell every stream and end it. */
function beginShutdown(ctx) {
  ctx.shuttingDown = true;
  if (ctx.mode !== 'accounts') return 0;
  let n = 0;
  for (const s of [...ctx.streams]) {
    endStream(s, 'server_restart', {});
    n++;
  }
  return n;
}

function sseStats(ctx) {
  let spectators = 0;
  let buffered = 0;
  for (const s of ctx.streams) {
    if (s.uid == null) spectators++;
    buffered += s.res.writableLength ?? 0;
  }
  return { total: ctx.streams.size, spectators, buffered_bytes: buffered };
}

// ---------------------------------------------------------------------------------------------
// Built-in rate limiting (used when the platform brings no limiter, or one that does not know a scope)

/** Token buckets per scope (take / check / refund), each an LRU of ≤ 50,000 keys (§4.5). */
export class TokenBuckets {
  constructor(limits, { maxKeys = 50_000, now = () => Date.now() } = {}) {
    this.limits = limits;
    this.maxKeys = maxKeys;
    this.now = now;
    this.stores = new Map();
  }

  #bucket(scope, key) {
    const lim = this.limits[scope];
    if (!lim) throw new Error(`ratelimit: unknown scope '${scope}'`);
    let store = this.stores.get(scope);
    if (!store) this.stores.set(scope, (store = new Map()));
    const t = this.now();
    let b = store.get(key);
    if (b) {
      store.delete(key); // re-insert: most recently used last
      b.tokens = Math.min(lim.capacity, b.tokens + ((t - b.t) / 1000) * lim.perS);
      b.t = t;
    } else {
      b = { tokens: lim.capacity, t };
      if (store.size >= this.maxKeys) store.delete(store.keys().next().value);
    }
    store.set(key, b);
    return { lim, b };
  }

  /** → {ok, retryAfterS}; takes `cost` tokens when they are there (a refused request takes nothing). */
  take(scope, key, cost = 1) {
    const { lim, b } = this.#bucket(scope, String(key));
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, retryAfterS: 0 };
    }
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((cost - b.tokens) / lim.perS)) };
  }

  /** Like take() but consumes nothing. */
  check(scope, key, cost = 1) {
    const { lim, b } = this.#bucket(scope, String(key));
    return b.tokens >= cost ? { ok: true, retryAfterS: 0 } : { ok: false, retryAfterS: Math.max(1, Math.ceil((cost - b.tokens) / lim.perS)) };
  }

  refund(scope, key, cost = 1) {
    const { lim, b } = this.#bucket(scope, String(key));
    b.tokens = Math.min(lim.capacity, b.tokens + cost);
  }
}

// ---------------------------------------------------------------------------------------------
// /docs

function serveDocs(ctx, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw Object.assign(new ApiError(405, `method ${req.method} not allowed here; use GET`), { allow: 'GET, HEAD' });
  }
  const commandPolicy = ctx.mode === 'accounts' ? 'session' : ctx.token ? 'token' : 'loopback';
  const body = docsMarkdown({ version: ctx.version, commandPolicy });
  res.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------------------------------------------------------------------------------------------
// Static files from web/

function isInside(child, root) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** True when any segment of a relative path is hidden (".git", ".env", "..", …). */
const hasDotSegment = (rel) => rel.split(/[\\/]+/).some((s) => s.startsWith('.'));

/** Map a URL path to a file under webDir, or null if it is unsafe (traversal, dotfiles, drive/stream names). */
function resolveStaticPath(webDir, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes('\0') || rel.includes(':')) return null; // NUL, Windows drive letters / alternate data streams
  if (rel.endsWith('/')) rel += 'index.html';
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (hasDotSegment(segments.join('/'))) return null; // "..", ".git", ".env", …
  const resolved = path.resolve(webDir, ...segments);
  return resolved.startsWith(webDir + path.sep) || resolved === webDir ? resolved : null;
}

async function serveStatic(ctx, req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw Object.assign(new ApiError(405, `method ${req.method} not allowed here; use GET`), { allow: 'GET, HEAD' });
  }
  const notFound = () => new ApiError(404, `not found: ${pathname}`);

  let file = resolveStaticPath(ctx.webDir, pathname);
  if (!file) throw notFound();

  let stat = await fsp.stat(file).catch(() => null);
  if (stat?.isDirectory()) {
    file = path.join(file, 'index.html');
    stat = await fsp.stat(file).catch(() => null);
  }
  if (!stat?.isFile()) throw notFound();

  // Defence in depth on the REAL path: a symlink inside web/ must not lead outside it, and the dotfile rule
  // is re-checked on the long names — on NTFS a dotfile also answers to an 8.3 alias (ENV~1 → .env).
  ctx.webDirReal ??= await fsp.realpath(ctx.webDir).catch(() => ctx.webDir);
  const real = await fsp.realpath(file).catch(() => null);
  if (!real || !isInside(real, ctx.webDirReal) || hasDotSegment(path.relative(ctx.webDirReal, real))) throw notFound();

  sendFile(req, res, file, stat, CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', ctx.staticCsp);
}

/**
 * GET|HEAD /vendor/three/<path> → node_modules/three/<path>, for exactly the VENDOR_FILES paths. Anything else —
 * another file, an encoded character (%2e%2e, %2f, %5c, …), a dot segment, a missing file, or a real path that
 * leaves node_modules/three — is a 404. Same headers as static files (CSP, nosniff, no-cache + Last-Modified/304).
 */
async function serveVendor(ctx, req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw Object.assign(new ApiError(405, `method ${req.method} not allowed here; use GET`), { allow: 'GET, HEAD' });
  }
  const notFound = () => new ApiError(404, `not found: ${pathname}`);
  // The URL parser has already resolved literal and %2e dot segments; the allow-list check is on the raw path.
  if (!pathname.startsWith(VENDOR_PREFIX) || pathname.includes('%') || pathname.includes('\\')) throw notFound();
  const rel = pathname.slice(VENDOR_PREFIX.length);
  const type = VENDOR_FILES.get(rel);
  if (!type || hasDotSegment(rel)) throw notFound();
  const file = path.resolve(ctx.threeDir, ...rel.split('/'));
  if (!isInside(file, ctx.threeDir)) throw notFound();
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) throw notFound();
  ctx.threeDirReal ??= await fsp.realpath(ctx.threeDir).catch(() => ctx.threeDir);
  const real = await fsp.realpath(file).catch(() => null);
  if (!real || !isInside(real, ctx.threeDirReal) || hasDotSegment(path.relative(ctx.threeDirReal, real))) throw notFound();
  sendFile(req, res, file, stat, type, ctx.staticCsp);
}

/** Text assets worth gzipping (the 3D page ships ~1.2 MB of our modules + 0.7 MB of three.js uncompressed). */
const GZIP_TYPES = /^(text\/|application\/(json|javascript)|image\/svg)/;
const GZIP_MIN_BYTES = 1024;
const GZIP_CACHE_MAX = 200;
/** file → { key: mtimeMs|size, body: Buffer } — compressed once per file version, then served from memory. */
const gzipCache = new Map();

function gzipped(file, stat) {
  const key = `${stat.mtimeMs}|${stat.size}`;
  const hit = gzipCache.get(file);
  if (hit && hit.key === key) return hit.body;
  let body;
  try {
    body = zlib.gzipSync(fs.readFileSync(file), { level: 6 });
  } catch {
    return null;
  }
  if (gzipCache.size >= GZIP_CACHE_MAX) gzipCache.delete(gzipCache.keys().next().value);
  gzipCache.set(file, { key, body });
  return body;
}

/**
 * Stream one vetted file with the static headers (CSP, nosniff, no-cache + Last-Modified / 304). Text assets go
 * out gzip-encoded when the client accepts it (cached per file version; `Vary: Accept-Encoding`).
 */
function sendFile(req, res, file, stat, contentType, csp = STATIC_CSP) {
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'Last-Modified': stat.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': csp,
  };

  // Revalidation: no-cache means "ask every time"; answer 304 when nothing changed.
  const since = Date.parse(req.headers['if-modified-since'] ?? '');
  if (Number.isFinite(since) && Math.floor(stat.mtimeMs / 1000) * 1000 <= since) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const compressible = GZIP_TYPES.test(contentType) && stat.size >= GZIP_MIN_BYTES;
  if (compressible) headers.Vary = 'Accept-Encoding';
  if (compressible && /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''))) {
    const body = gzipped(file, stat);
    if (body) {
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// ---------------------------------------------------------------------------------------------
// Misc

let cachedVersion = null;

/** Version from package.json (read once, lazily — never at import time). */
export function packageVersion() {
  if (cachedVersion === null) {
    try {
      cachedVersion = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
    } catch {
      cachedVersion = '0.0.0';
    }
  }
  return cachedVersion;
}

// server/auth/csrf.js — CSRF, Host and Bearer checks for accounts mode (PLATFORM.md §4.4).
//
// The exact algorithm, run before any command handler (and the Host + Bearer parts before queries):
//
//   directLoopback(req): socket peer ∈ {127.0.0.1, ::1} AND none of PROXY_HEADERS is present
//   hostOk(req):   Host === new URL(PUBLIC_ORIGIN).host, else 421 misdirected
//                  (exceptions: GET /healthz answers any Host (constant {ok:true}; platform health checkers);
//                   /healthz, /readyz and GET /api/v1/health also accept 127.0.0.1:<PORT> /
//                   localhost:<PORT>; an admin op from directLoopback(req) with a Bearer header — the admin-cli)
//   POST with a query string → 400 query_params_not_allowed (before the body is read)
//   GET / HEAD / OPTIONS → no CSRF check (no state-changing GET exists; db.test/csrf.test enumerate OPS)
//   media type ≠ application/json → 415 unsupported_media_type (blocks HTML form posts)
//   Bearer present: op.auth ≠ 'admin' → 401 auth_required; not directLoopback and ADMIN_TOKEN_REMOTE ≠ 1 → 403
//                   forbidden; make_admin/remove_admin → 403 session_required (needs the body: checkBearerParams);
//                   wrong token → 1 token from the per-IP 'admin_token_ip' bucket, audit admin_token_fail, 401;
//                   no session cookie used → allowed (no ambient credential)
//   Origin present: its origin must equal PUBLIC_ORIGIN's, else 403 csrf
//   no Origin:      Sec-Fetch-Site must be 'same-origin', else 403 csrf
//
// Layered with SameSite=Lax cookies and the absence of credentialed CORS, this defends against CSRF and login-CSRF.

import crypto from 'node:crypto';

import { ApiError } from '../live.js';
import { rateLimited } from './ratelimit.js';

/** Headers that mean "a proxy is in between" (http.js's list plus the single-IP edge headers). */
export const PROXY_HEADERS = Object.freeze([
  'x-forwarded-for', 'cf-connecting-ip', 'x-real-ip', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto',
  'fly-client-ip', 'true-client-ip',
]);

/** Paths whose Host check also accepts the loopback names (container health checks). */
const HEALTH_PATHS = new Set(['/healthz', '/readyz']);
const API_HEALTH = '/api/v1/health';

function isLoopbackPeer(address) {
  const a = String(address ?? '').toLowerCase();
  return a === '::1' || a === '127.0.0.1' || a === '::ffff:127.0.0.1';
}

/** Socket peer is 127.0.0.1 / ::1 AND no proxy header is present (§4.4). */
export function directLoopback(req) {
  if (!isLoopbackPeer(req?.socket?.remoteAddress)) return false;
  return !PROXY_HEADERS.some((h) => req.headers?.[h] !== undefined);
}

/** The Bearer token of a request (Authorization: Bearer …), or null. `present` is true for ANY Bearer header. */
export function bearerOf(req) {
  const raw = Array.isArray(req?.headers?.authorization) ? req.headers.authorization[0] : req?.headers?.authorization;
  if (typeof raw !== 'string' || !/^\s*Bearer(\s|$)/i.test(raw)) return { present: false, token: null };
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(raw);
  return { present: true, token: m ? m[1] : null };
}

/** Lower-cased media type (before ';'). */
export function mediaTypeOf(req) {
  const ct = req?.headers?.['content-type'];
  return String(Array.isArray(ct) ? ct[0] : ct ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * Host check (§4.4). → null or a 421 ApiError.
 * @param {import('node:http').IncomingMessage} req
 * @param {object} o
 * @param {string} o.publicOrigin
 * @param {number} [o.port]           the listening port (health-path exemption)
 * @param {string} [o.pathname]
 * @param {boolean} [o.adminBearerLoopback]  an admin op with a Bearer header from directLoopback (admin-cli)
 */
export function hostOk(req, { publicOrigin, port = null, pathname = null, adminBearerLoopback = false }) {
  if (adminBearerLoopback) return null;
  const host = String(req?.headers?.host ?? '').toLowerCase();
  if (host && host === new URL(publicOrigin).host.toLowerCase()) return null;
  // Liveness only: a constant {ok:true}, nothing to rebind to; Render's checker uses an internal Host (§4.4).
  if (pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) return null;
  const healthPath = pathname !== null && (HEALTH_PATHS.has(pathname) || (pathname === API_HEALTH && req.method === 'GET'));
  if (healthPath && port !== null && (host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`)) return null;
  return new ApiError(421, 'misdirected request', 'misdirected');
}

/**
 * The frozen §12.2 CSRF check for one request. Pure: it does not verify the Bearer token itself (the request guard
 * below does, with its rate limit and audit).
 * → null when the request may proceed, else an ApiError (400 | 401 | 403 | 415 | 421).
 * @param {import('node:http').IncomingMessage} req
 * @param {object} o
 * @param {string} o.publicOrigin
 * @param {{name: string, auth: string}|null} o.op   the catalog op (null for non-API paths)
 * @param {boolean} o.bearerPresent
 * @param {boolean} o.directLoopback
 * @param {boolean} [o.sessionCookieUsed]  a session cookie was presented (ambient credential)
 * @param {boolean} [o.adminTokenRemote]   ADMIN_TOKEN_REMOTE=1
 * @param {URL} [o.url]
 * @param {number} [o.port]
 */
export function checkCsrf(req, { publicOrigin, op, bearerPresent, directLoopback: loopback, sessionCookieUsed = true,
  adminTokenRemote = false, url = null, port = null }) {
  const u = url ?? new URL(req.url ?? '/', 'http://localhost');
  // The admin-cli path: an ADMIN op with a Bearer header from a direct loopback peer skips the Host check (§4.4).
  const hostErr = hostOk(req, { publicOrigin, port, pathname: u.pathname, adminBearerLoopback: Boolean(bearerPresent && loopback && op?.auth === 'admin') });
  if (hostErr) return hostErr;
  const method = String(req.method ?? 'GET').toUpperCase();
  if (method === 'POST' && u.search !== '') {
    return new ApiError(400, 'commands take parameters only from the JSON body', 'query_params_not_allowed');
  }
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    // No CSRF check for safe methods; a Bearer on an admin query still obeys the Bearer rules.
    return bearerPresent ? bearerRules(op, loopback, adminTokenRemote) : null;
  }
  if (mediaTypeOf(req) !== 'application/json') {
    return new ApiError(415, 'commands must be sent as application/json', 'unsupported_media_type');
  }
  if (bearerPresent) {
    const e = bearerRules(op, loopback, adminTokenRemote);
    if (e) return e;
    if (!sessionCookieUsed) return null; // no ambient credential: nothing to forge
  }
  return originCheck(req, publicOrigin);
}

function bearerRules(op, loopback, adminTokenRemote) {
  if (op?.auth !== 'admin') return new ApiError(401, 'sign in to do this', 'auth_required');
  if (!loopback && !adminTokenRemote) return new ApiError(403, 'the admin token is accepted only from this machine (admin-cli)', 'forbidden');
  return null;
}

function originCheck(req, publicOrigin) {
  const origin = Array.isArray(req.headers?.origin) ? req.headers.origin[0] : req.headers?.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).origin === new URL(publicOrigin).origin) return null;
    } catch {
      // "null" (opaque origins) and junk fail to parse → refused below.
    }
    return new ApiError(403, 'cross-site request refused', 'csrf');
  }
  const site = req.headers?.['sec-fetch-site'];
  if ((Array.isArray(site) ? site[0] : site) === 'same-origin') return null;
  return new ApiError(403, 'cross-site request refused', 'csrf');
}

/**
 * After the body is parsed: the Bearer token can never change roles (§4.4, §8.6).
 * → null or 403 session_required.
 */
export function checkBearerParams(op, params, { viaBearer }) {
  if (!viaBearer || op?.name !== 'admin_user') return null;
  const action = params?.action;
  if (action === 'make_admin' || action === 'remove_admin') {
    return new ApiError(403, 'role changes need an admin session and password, not the admin token', 'session_required');
  }
  return null;
}

/** Constant-time token comparison (both sides hashed: equal lengths, length hidden). */
export function tokensEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * The full §4.4 guard for accounts mode, including the Bearer token check with its per-IP failure bucket and audit.
 * WP4's router calls `guard.check(req, {url, op, sessionCookieUsed, ip})` for every API request.
 * @param {object} cfg
 * @param {string} cfg.publicOrigin
 * @param {number} [cfg.port]
 * @param {string|null} [cfg.adminToken]      ADMIN_TOKEN (null → every Bearer is wrong)
 * @param {boolean} [cfg.adminTokenRemote]
 * @param {import('./ratelimit.js').RateLimiter} cfg.limiter
 * @param {(entry: object) => void} [cfg.audit]   Admin.audit
 */
export function createRequestGuard({ publicOrigin, port = null, adminToken = null, adminTokenRemote = false, limiter, audit = () => {} }) {
  // Keep the token out of enumerable state.
  const secret = { token: adminToken };
  return {
    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {object} o
     * @param {URL} o.url
     * @param {object|null} o.op
     * @param {boolean} o.sessionCookieUsed
     * @param {{ip: string, bucketKey: (s?: string) => string, prefix?: () => string|null}} o.ip  clientIp() result
     * @returns {{error: ApiError|null, viaBearer: boolean}}
     */
    check(req, { url, op, sessionCookieUsed, ip }) {
      const { present, token } = bearerOf(req);
      const loopback = directLoopback(req);
      const error = checkCsrf(req, {
        publicOrigin, op, bearerPresent: present, directLoopback: loopback, sessionCookieUsed, adminTokenRemote, url, port,
      });
      if (error) return { error, viaBearer: false };
      if (!present) return { error: null, viaBearer: false };
      if (!secret.token || !token || !tokensEqual(token, secret.token)) {
        const take = limiter.take('admin_token_ip', ip?.bucketKey?.() ?? 'unknown');
        try {
          audit({ action: 'admin_token_fail', actor: 'ops', ok: false, ip: ip?.prefix?.() ?? null, detail: { code: 'auth_required' } });
        } catch {
          // Auditing must never turn a refusal into a 500.
        }
        if (!take.ok) return { error: rateLimited(take.retryAfterS), viaBearer: false };
        return { error: new ApiError(401, 'sign in to do this', 'auth_required'), viaBearer: false };
      }
      return { error: null, viaBearer: true };
    },
  };
}

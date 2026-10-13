// server/hl/egress.js — the process-wide egress guard (PLATFORM §1.2 rules 7–8, review S17).
//
// Rules 1–5 (one module, a frozen URL, an assertion, the "b" source, a grep) can be evaded by building a URL at run
// time. This guard cannot: `installEgressGuard()` wraps globalThis.fetch and checks the FINAL URL string and method at
// the moment of every request. Only POST to exactly these three URLs is allowed:
//
//   https://api.hyperliquid.xyz/info                  mainnet market data (read-only) and the mainnet userRole guard
//   https://api.hyperliquid-testnet.xyz/info          testnet market and account data (read-only)
//   https://api.hyperliquid-testnet.xyz/exchange      testnet orders (server/hl/exchange.js only)
//
// Anything else — another host, another path, a query string, a mainnet /exchange built by concatenation, a GET —
// throws `egress_denied` and logs an alert. Every allowed request is also forced to `redirect: 'error'`, so a 3xx can
// never re-POST a signed body elsewhere. Installed only by `main()` (the CLI entry), never by library code that tests
// import (§2.4 rule 10); `uninstall()` exists for tests.
//
// ONE more destination, only when cloud persistence is configured (SUPABASE_URL, server/cloudsync.js): the private
// Supabase Storage bucket. `installEgressGuard({storageOrigin})` then also allows GET / POST / DELETE to
// `<that exact https origin>/storage/v1/…` — nothing else on that host (no /rest/v1, /auth/v1, /functions/v1, …), no
// query string, no fragment, no credentials, no dot segments or encoded separators (the URL must already be in the
// canonical form `new URL()` would give it). The storage origin is fixed when the guard is installed; nothing can
// widen it afterwards. The Hyperliquid rules above are unchanged by it.

export const EGRESS_ALLOW = Object.freeze([
  'https://api.hyperliquid.xyz/info',
  'https://api.hyperliquid-testnet.xyz/info',
  'https://api.hyperliquid-testnet.xyz/exchange',
]);

const GUARD = Symbol.for('bean-garden.egress-guard');

/** An egress the guard refused. */
export class EgressDenied extends Error {
  constructor() {
    super('egress_denied');
    this.name = 'EgressDenied';
    this.code = 'egress_denied';
  }
}

/** Methods the storage allowance permits (download, upload/list/create bucket, remove). */
export const STORAGE_EGRESS_METHODS = Object.freeze(['GET', 'POST', 'DELETE']);
const STORAGE_PATH_PREFIX = '/storage/v1/';

/**
 * True only for POST to one of the three exact URLs (string comparison of the final URL, no normalization), or — when
 * `storageOrigin` is given — for an allowed storage request (isAllowedStorageEgress).
 * @param {string} url
 * @param {string} method
 * @param {{storageOrigin?: string|null}} [opts]
 */
export function isAllowedEgress(url, method, { storageOrigin = null } = {}) {
  if (typeof url !== 'string') return false;
  if (storageOrigin && isAllowedStorageEgress(url, method, storageOrigin)) return true;
  if (typeof method !== 'string' || method.toUpperCase() !== 'POST') return false;
  return EGRESS_ALLOW.includes(url);
}

/**
 * GET / POST / DELETE to `${storageOrigin}/storage/v1/…` only: https, exactly that origin, no query, fragment or
 * credentials, and the URL string already canonical (`new URL(url).href === url`, so "/storage/v1/../rest/v1" and
 * friends never pass) with no percent-encoded dot, slash or backslash in the path.
 */
export function isAllowedStorageEgress(url, method, storageOrigin) {
  if (typeof url !== 'string' || typeof storageOrigin !== 'string' || !storageOrigin) return false;
  if (typeof method !== 'string' || !STORAGE_EGRESS_METHODS.includes(method.toUpperCase())) return false;
  if (url.includes('?') || url.includes('#') || url.includes('\\')) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.href !== url || u.protocol !== 'https:' || u.origin !== storageOrigin) return false;
  if (u.username || u.password || u.search || u.hash) return false;
  if (!u.pathname.startsWith(STORAGE_PATH_PREFIX) || u.pathname.length <= STORAGE_PATH_PREFIX.length) return false;
  return !/%2e|%2f|%5c/i.test(u.pathname);
}

/** A storage origin for the guard: exactly `https://host[:port]` (what config.js's parseSupabaseUrl returns). */
function checkStorageOrigin(origin) {
  if (origin === null || origin === undefined) return null;
  let u = null;
  try {
    u = new URL(String(origin));
  } catch {
    u = null;
  }
  if (!u || u.protocol !== 'https:' || u.origin !== String(origin)) throw new TypeError('installEgressGuard: storageOrigin must be an https origin');
  return u.origin;
}

/** The URL string and method of a fetch call, for Request objects, URL objects and strings alike. */
function describe(input, init) {
  let url = null;
  if (typeof input === 'string') url = input;
  else if (input instanceof URL) url = input.href;
  else if (input && typeof input.url === 'string') url = input.url;
  const method = init?.method ?? (input && typeof input === 'object' && typeof input.method === 'string' ? input.method : 'GET');
  return { url, method };
}

/** Safe description for the alert log: scheme + host + path only (never query strings or bodies). */
function where(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<unparseable url>';
  }
}

/**
 * Wrap globalThis.fetch. Idempotent: a second call returns the existing uninstaller (and keeps the FIRST call's
 * storage origin: the allowance can never be widened later).
 * @param {object} [opts]
 * @param {(line: string) => void} [opts.log]
 * @param {string|null} [opts.storageOrigin]  SUPABASE_URL's origin when cloud persistence is configured
 * @returns {() => void} uninstall (restores the original fetch)
 */
export function installEgressGuard({ log, storageOrigin = null } = {}) {
  const say = typeof log === 'function' ? log : (line) => console.error(line);
  const current = globalThis.fetch;
  if (current && current[GUARD]) return current[GUARD].uninstall;
  const storage = checkStorageOrigin(storageOrigin);
  const original = current;
  const guarded = async function guardedFetch(input, init) {
    const { url, method } = describe(input, init);
    if (!isAllowedEgress(url, method, { storageOrigin: storage })) {
      say(`[egress] ALERT denied ${String(method).toUpperCase()} ${url ? where(url) : '<no url>'}`);
      throw new EgressDenied();
    }
    if (typeof original !== 'function') throw new EgressDenied();
    return original(input, { ...(init ?? {}), redirect: 'error' });
  };
  const uninstall = () => {
    if (globalThis.fetch === guarded) globalThis.fetch = original;
  };
  Object.defineProperty(guarded, GUARD, { value: { uninstall }, enumerable: false });
  globalThis.fetch = guarded;
  return uninstall;
}

/** True when the guard is installed on globalThis.fetch. */
export function egressGuardInstalled() {
  return Boolean(globalThis.fetch && globalThis.fetch[GUARD]);
}

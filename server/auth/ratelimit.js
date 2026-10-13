// server/auth/ratelimit.js — rate limits (PLATFORM.md §4.5).
//
// Each scope has its OWN bounded store, so a flood in one scope can never evict another scope's state:
//   * RateLimiter       token buckets, one LRU per scope (50,000 keys each). Eviction there only forgets an
//                       attacker's own buckets, which is acceptable: per-username lockout does not live here.
//   * UnknownNameLockouts  failure counters for usernames that do NOT exist (100,000 keys, 60 min expiry). When it
//                       is full, a new unknown name answers "locked" instead of evicting an entry.
//   * Existing users' lockout lives in users.failed_logins / users.locked_until_ms (server/auth/users.js) and
//     cannot be evicted at all.
//   * StreamSlots       concurrent SSE stream caps (per user, per IP /56, total, spectators).
// Buckets reset on restart (accepted), except the persisted per-user state.
// Every refusal is `429 {code:'rate_limited', retry_after_s}` with a Retry-After header (rateLimited()).

import { ApiError } from '../live.js';

const HOUR_S = 3600;

/**
 * Scope → {capacity, perS (refill tokens per second)} (§4.5 table). `signup_global` is set from
 * SIGNUP_MAX_PER_HOUR at construction.
 */
export const DEFAULT_SCOPES = Object.freeze({
  login_ip: { capacity: 10, perS: 1 / 90 },                  // auth_login per IP (/56)
  signup_attempt_ip: { capacity: 10, perS: 10 / HOUR_S },    // every sign-up attempt incl. 409 (enumeration bucket)
  signup_create_ip: { capacity: 3, perS: 3 / HOUR_S },       // successful creations per IP (/56)
  signup_create_48: { capacity: 10, perS: 10 / HOUR_S },     // successful creations per /48
  signup_global: { capacity: 60, perS: 60 / HOUR_S },        // SIGNUP_MAX_PER_HOUR → 503 signup_busy
  reset_ip: { capacity: 5, perS: 5 / HOUR_S },               // auth_reset per IP
  reset_user: { capacity: 5, perS: 5 / HOUR_S },             // auth_reset per username
  account_user: { capacity: 5, perS: 5 / 900 },              // account_password / account_delete per user
  testnet_connect_user: { capacity: 5, perS: 5 / HOUR_S },   // testnet_connect / testnet_verify (only HL-reaching ones)
  admin_token_ip: { capacity: 5, perS: 5 / 900 },            // failed Bearer admin tokens per IP
  garden_reset_user: { capacity: 1, perS: 1 / 86_400 },      // garden_reset per user
  admin_backup: { capacity: 1, perS: 1 / 600 },              // global
  commands_user: { capacity: 60, perS: 1 },                  // every command per user
  bot_create_user: { capacity: 10, perS: 10 / 60 },          // bot_create per user
  queries_ip: { capacity: 120, perS: 10 },                   // GET queries per IP; an SSE open costs 10
});

/** Cost of opening an SSE stream from the per-IP query bucket (a reconnect runs a replay query). */
export const SSE_OPEN_COST = 10;

const DEFAULT_MAX_KEYS = 50_000;

/** A 429 ApiError with `retry_after_s` in the body and a Retry-After header. */
export function rateLimited(retryAfterS, message = 'too many requests: slow down and retry later', code = 'rate_limited', status = 429) {
  const retry = Math.max(1, Math.ceil(retryAfterS));
  const err = new ApiError(status, message, code, { retry_after_s: retry });
  err.headers = { 'Retry-After': String(retry) };
  return err;
}

/** Token buckets with one bounded LRU store per scope. */
export class RateLimiter {
  /**
   * @param {object} [opts]
   * @param {Record<string, {capacity: number, perS: number}>} [opts.scopes]  overrides / additions
   * @param {number} [opts.signupMaxPerHour]  SIGNUP_MAX_PER_HOUR (60)
   * @param {number} [opts.maxKeys]           per-scope LRU size (50,000)
   * @param {() => number} [opts.now]
   */
  constructor({ scopes = {}, signupMaxPerHour = 60, maxKeys = DEFAULT_MAX_KEYS, now = Date.now } = {}) {
    this.now = now;
    this.maxKeys = maxKeys;
    this.config = {
      ...DEFAULT_SCOPES,
      signup_global: { capacity: signupMaxPerHour, perS: signupMaxPerHour / HOUR_S },
      ...scopes,
    };
    /** scope → Map(key → {tokens, at}) in LRU order (oldest first). */
    this.stores = new Map();
    for (const scope of Object.keys(this.config)) this.stores.set(scope, new Map());
  }

  /**
   * Take `cost` tokens. → {ok, retryAfterS} (retryAfterS = 0 when ok).
   * @param {string} scope
   * @param {string|number} key
   * @param {number} [cost]
   */
  take(scope, key, cost = 1) {
    const { cfg, bucket } = this.#bucket(scope, key);
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { ok: true, retryAfterS: 0 };
    }
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((cost - bucket.tokens) / cfg.perS)) };
  }

  /** Like take() but consumes nothing. */
  check(scope, key, cost = 1) {
    const { cfg, bucket } = this.#bucket(scope, key);
    if (bucket.tokens >= cost) return { ok: true, retryAfterS: 0 };
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((cost - bucket.tokens) / cfg.perS)) };
  }

  /** Give back tokens taken for an action that did not happen (e.g. a sign-up whose insert failed). */
  refund(scope, key, cost = 1) {
    const { cfg, bucket } = this.#bucket(scope, key);
    bucket.tokens = Math.min(cfg.capacity, bucket.tokens + cost);
  }

  /** take() that throws the standard 429 (or `status`/`code` override, e.g. 503 signup_busy). */
  enforce(scope, key, cost = 1, { status = 429, code = 'rate_limited', message } = {}) {
    const r = this.take(scope, key, cost);
    if (!r.ok) throw rateLimited(r.retryAfterS, message, code, status);
    return r;
  }

  /** Drop one key's bucket in `scope` (or every scope when scope is null): uid-keyed teardown (§2.2). */
  forget(scope, key) {
    const k = String(key);
    if (scope) {
      this.stores.get(scope)?.delete(k);
      return;
    }
    for (const store of this.stores.values()) store.delete(k);
  }

  /** Keys currently held per scope (tests / admin_status). */
  sizes() {
    return Object.fromEntries([...this.stores].map(([scope, store]) => [scope, store.size]));
  }

  #bucket(scope, key) {
    const cfg = this.config[scope];
    const store = this.stores.get(scope);
    if (!cfg || !store) throw new Error(`ratelimit: unknown scope '${scope}'`);
    const k = String(key);
    const t = this.now();
    let bucket = store.get(k);
    if (bucket) {
      store.delete(k); // LRU touch
      bucket.tokens = Math.min(cfg.capacity, bucket.tokens + ((t - bucket.at) / 1000) * cfg.perS);
      bucket.at = t;
    } else {
      bucket = { tokens: cfg.capacity, at: t };
      if (store.size >= this.maxKeys) store.delete(store.keys().next().value);
    }
    store.set(k, bucket);
    return { cfg, bucket };
  }
}

/** Lockout length after `failures` consecutive failures: 2^(f−5) min from the 5th, capped at 60 min (§4.5). */
export function lockoutMs(failures) {
  if (failures < 5) return 0;
  return Math.min(2 ** (failures - 5), 60) * 60_000;
}

/**
 * Failure counters for usernames that do not exist (§4.5). Bounded (100,000 keys; entries expire 60 min after
 * their last failure). Full → a NEW name is reported as locked rather than evicting someone else's counter.
 */
export class UnknownNameLockouts {
  constructor({ maxKeys = 100_000, ttlMs = 3_600_000, now = Date.now } = {}) {
    this.maxKeys = maxKeys;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map(); // name → {failures, lockedUntil, expires}; insertion order ≈ oldest failure first
  }

  /** @returns {{locked: boolean, retryAfterS: number}} */
  isLocked(name) {
    const t = this.now();
    const entry = this.#live(name, t);
    if (entry) {
      if (entry.lockedUntil > t) return { locked: true, retryAfterS: Math.ceil((entry.lockedUntil - t) / 1000) };
      return { locked: false, retryAfterS: 0 };
    }
    if (this.map.size >= this.maxKeys) {
      this.#sweep(t);
      if (this.map.size >= this.maxKeys) return { locked: true, retryAfterS: 60 };
    }
    return { locked: false, retryAfterS: 0 };
  }

  recordFailure(name) {
    const t = this.now();
    let entry = this.#live(name, t);
    if (!entry) {
      if (this.map.size >= this.maxKeys) this.#sweep(t);
      if (this.map.size >= this.maxKeys) return; // full: isLocked() already answers locked for new names
      entry = { failures: 0, lockedUntil: 0, expires: 0 };
    }
    this.map.delete(name);
    entry.failures += 1;
    entry.expires = t + this.ttlMs;
    const lock = lockoutMs(entry.failures);
    if (lock) entry.lockedUntil = t + lock;
    this.map.set(name, entry);
  }

  get size() {
    return this.map.size;
  }

  #live(name, t) {
    const entry = this.map.get(name);
    if (entry && entry.expires <= t && entry.lockedUntil <= t) {
      this.map.delete(name);
      return null;
    }
    return entry ?? null;
  }

  /** Remove expired entries from the oldest end (bounded work). */
  #sweep(t) {
    let budget = 10_000;
    for (const [name, entry] of this.map) {
      if (budget-- <= 0) break;
      if (entry.expires <= t && entry.lockedUntil <= t) this.map.delete(name);
      else break; // insertion order ≈ expiry order: the rest are newer
    }
  }
}

/**
 * Concurrent SSE stream caps (§4.5): ≤ 5 per user, ≤ 20 per IP (/56), ≤ 2,000 total, of which spectator
 * streams may hold at most 1,000 (a signed-in player can always connect while the total is below 2,000).
 */
export class StreamSlots {
  constructor({ perUser = 5, perIp = 20, total = 2000, spectators = 1000 } = {}) {
    this.limits = { perUser, perIp, total, spectators };
    this.byUser = new Map();
    this.byIp = new Map();
    this.count = 0;
    this.spectatorCount = 0;
  }

  /**
   * @param {{uid: number|null, ipKey: string}} who  ipKey = clientIp.bucketKey('sse')
   * @returns {{ok: true, release: () => void} | {ok: false, reason: 'user'|'ip'|'total'|'spectators'}}
   */
  acquire({ uid = null, ipKey }) {
    const { perUser, perIp, total, spectators } = this.limits;
    if (this.count >= total) return { ok: false, reason: 'total' };
    if (uid === null && this.spectatorCount >= spectators) return { ok: false, reason: 'spectators' };
    if ((this.byIp.get(ipKey) ?? 0) >= perIp) return { ok: false, reason: 'ip' };
    if (uid !== null && (this.byUser.get(uid) ?? 0) >= perUser) return { ok: false, reason: 'user' };
    this.count += 1;
    if (uid === null) this.spectatorCount += 1;
    this.byIp.set(ipKey, (this.byIp.get(ipKey) ?? 0) + 1);
    if (uid !== null) this.byUser.set(uid, (this.byUser.get(uid) ?? 0) + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.count -= 1;
        if (uid === null) this.spectatorCount -= 1;
        dec(this.byIp, ipKey);
        if (uid !== null) dec(this.byUser, uid);
      },
    };
  }

  stats() {
    return { total: this.count, spectators: this.spectatorCount };
  }
}

function dec(map, key) {
  const n = (map.get(key) ?? 0) - 1;
  if (n <= 0) map.delete(key);
  else map.set(key, n);
}

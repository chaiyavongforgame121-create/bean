// server/auth/passwords.js — usernames, password policy and scrypt hashing (PLATFORM.md §4.1).
//
// Hash: crypto.scrypt(pw, salt16, 64, {N: 32768, r: 8, p: 3, maxmem: 64 MiB}) on the libuv threadpool (one of the
// OWASP scrypt configurations; 32 MiB per hash). Stored as "scrypt$v=1$N=32768,r=8,p=3$<b64url salt>$<b64url dk>".
// Verification parses the parameters from the stored string, recomputes and compares with timingSafeEqual; hashes
// below the current parameters are re-hashed on the next successful login (needsRehash).
//
// Concurrency (PasswordHasher): at most 4 hashes run at once; when more than 32 wait, `503 busy`. Each client IP
// bucket has at most ONE hash in flight: a second concurrent login or sign-up from the same bucket waits for the
// first. Unknown usernames still pay one scrypt against DUMMY_HASH (computed at boot by init()), so timing does not
// reveal whether a user exists.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiError } from '../live.js';

export const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 3 });
const KEY_LEN = 64;
const SALT_LEN = 16;
const MAXMEM = 64 * 1024 * 1024;
const HASH_RE = /^scrypt\$v=1\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{16,})$/;

export const PASSWORD_MIN = 10; // code points
export const PASSWORD_MAX = 128; // code points
export const PASSWORD_MAX_BYTES = 512; // UTF-8 bytes

export const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
export const RESERVED_USERNAMES = Object.freeze(new Set([
  'admin', 'administrator', 'root', 'system', 'operator', 'support', 'bean', 'beans', 'garden', 'api', 'local', 'null',
  'undefined', 'testnet', 'mainnet', 'hyperliquid', 'me', 'you',
]));

// ---------------------------------------------------------------------------------------------
// Usernames

/** Canonical username (§4.1): NFKC, trimmed, lower-case, ^[a-z0-9_]{3,24}$. → string, or null when invalid. */
export function canonicalUsername(input) {
  if (typeof input !== 'string' || input.length > 256) return null;
  const s = input.normalize('NFKC').trim().toLowerCase();
  return USERNAME_RE.test(s) ? s : null;
}

/**
 * The key under which login failures of `input` are counted, whether or not it is a valid username: the canonical
 * form when valid, else the normalised text bounded to 64 chars (it is never stored or logged raw).
 */
export function lockoutKey(input) {
  return canonicalUsername(input) ?? String(input ?? '').slice(0, 256).normalize('NFKC').trim().toLowerCase().slice(0, 64);
}

// ---------------------------------------------------------------------------------------------
// Password policy

let commonPasswords = null;

/** The bundled common-password list (lower-case), loaded once. */
export function commonPasswordSet() {
  if (!commonPasswords) {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'common-passwords.txt');
    commonPasswords = new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.normalize('NFKC').toLowerCase()));
  }
  return commonPasswords;
}

/**
 * Check a new password against §4.1. → null when acceptable, else the reason key
 * ('too_short' | 'too_long' | 'contains_username' | 'common').
 * @param {string} password
 * @param {string|null} [username]  canonical username
 */
export function passwordProblem(password, username = null) {
  if (typeof password !== 'string') return 'too_short';
  const pw = password.normalize('NFKC');
  const points = [...pw].length;
  if (points < PASSWORD_MIN) return 'too_short';
  if (points > PASSWORD_MAX || Buffer.byteLength(pw, 'utf8') > PASSWORD_MAX_BYTES) return 'too_long';
  const lower = pw.toLowerCase();
  if (username) {
    const u = String(username).toLowerCase();
    if (lower === u || (u.length >= 4 && lower.includes(u))) return 'contains_username';
  }
  if (commonPasswordSet().has(lower)) return 'common';
  return null;
}

/** Throw `400 weak_password` with the reason key when the password fails the policy. */
export function assertPasswordPolicy(password, username = null) {
  const reason = passwordProblem(password, username);
  if (reason) throw new ApiError(400, `password is too weak (${reason})`, 'weak_password', { reason });
}

// ---------------------------------------------------------------------------------------------
// Hashing primitives

function scryptAsync(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(password.normalize('NFKC'), 'utf8'), salt, KEY_LEN,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM }, (err, dk) => (err ? reject(err) : resolve(dk)));
  });
}

/** Parse a stored hash → {N, r, p, salt, dk} or null. */
export function parseHash(stored) {
  const m = HASH_RE.exec(String(stored ?? ''));
  if (!m) return null;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Bound the parameters a stored string may ask for (a corrupted row must not allocate gigabytes).
  if (!(N >= 2 && N <= 1 << 20 && (N & (N - 1)) === 0 && r >= 1 && r <= 32 && p >= 1 && p <= 16)) return null;
  return { N, r, p, salt: Buffer.from(m[4], 'base64url'), dk: Buffer.from(m[5], 'base64url') };
}

function encodeHash(params, salt, dk) {
  return `scrypt$v=1$N=${params.N},r=${params.r},p=${params.p}$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}

/** Hash with explicit parameters (no queueing). Prefer PasswordHasher.hash(). */
export async function hashPassword(password, params = SCRYPT_PARAMS) {
  const salt = crypto.randomBytes(SALT_LEN);
  return encodeHash(params, salt, await scryptAsync(password, salt, params));
}

/** → {ok, needsRehash} (no queueing). A malformed stored hash verifies false. */
export async function verifyPassword(password, stored, current = SCRYPT_PARAMS) {
  const parsed = parseHash(stored);
  if (!parsed || typeof password !== 'string') return { ok: false, needsRehash: false };
  const dk = await scryptAsync(password, parsed.salt, parsed);
  const ok = dk.length === parsed.dk.length && crypto.timingSafeEqual(dk, parsed.dk);
  const needsRehash = ok && (parsed.N < current.N || parsed.r < current.r || parsed.p < current.p);
  return { ok, needsRehash };
}

// ---------------------------------------------------------------------------------------------
// The queued hasher

export class PasswordHasher {
  /**
   * @param {object} [opts]
   * @param {{N: number, r: number, p: number}} [opts.params]  current parameters (tests may pass cheaper ones)
   * @param {number} [opts.maxConcurrent]  4
   * @param {number} [opts.maxWaiting]     32
   */
  constructor({ params = SCRYPT_PARAMS, maxConcurrent = 4, maxWaiting = 32 } = {}) {
    this.params = Object.freeze({ ...params });
    this.maxConcurrent = maxConcurrent;
    this.maxWaiting = maxWaiting;
    this.active = 0;
    this.waiting = []; // resolvers
    this.perIp = new Map(); // ipKey → tail promise
    this.dummyHash = null;
    this.calls = { hash: 0, verify: 0, dummy: 0 }; // counters (tests assert the unknown-user path pays a hash)
  }

  /** Compute DUMMY_HASH (boot). Idempotent. */
  async init() {
    if (!this.dummyHash) this.dummyHash = await hashPassword(crypto.randomBytes(24).toString('base64url'), this.params);
    return this;
  }

  /** Hash a password through the queue. */
  hash(password, { ipKey = null } = {}) {
    return this.#run(ipKey, () => {
      this.calls.hash += 1;
      return hashPassword(password, this.params);
    });
  }

  /**
   * Verify through the queue. `stored` null/undefined → verified against DUMMY_HASH (always false), so an unknown
   * username costs the same scrypt as a known one.
   * @returns {Promise<{ok: boolean, needsRehash: boolean}>}
   */
  verify(password, stored, { ipKey = null } = {}) {
    return this.#run(ipKey, async () => {
      this.calls.verify += 1;
      if (stored == null) {
        this.calls.dummy += 1;
        if (!this.dummyHash) await this.init();
        await verifyPassword(String(password ?? ''), this.dummyHash, this.params);
        return { ok: false, needsRehash: false };
      }
      return verifyPassword(password, stored, this.params);
    });
  }

  stats() {
    return { active: this.active, waiting: this.waiting.length, ips: this.perIp.size };
  }

  /** Per-IP serial lane, then the global semaphore. */
  #run(ipKey, fn) {
    const job = () => this.#withSlot(fn);
    if (ipKey == null) return job();
    const prev = this.perIp.get(ipKey) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(job);
    this.perIp.set(ipKey, next);
    const cleanup = () => {
      if (this.perIp.get(ipKey) === next) this.perIp.delete(ipKey);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  async #withSlot(fn) {
    if (this.active >= this.maxConcurrent) {
      if (this.waiting.length >= this.maxWaiting) throw new ApiError(503, 'server busy: try again in a moment', 'busy');
      await new Promise((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await fn();
    } finally {
      const nextWaiter = this.waiting.shift();
      if (nextWaiter) nextWaiter(); // hand the slot over (active stays the same)
      else this.active -= 1;
    }
  }
}

// server/cloudstore.js — a zero-dependency Supabase Storage REST client (accounts mode on an ephemeral host).
//
// Render's free web services lose their filesystem on every restart and deploy, so accounts mode can keep its durable
// files (the SQLite DB, the engine state, the admin bootstrap code) in a PRIVATE Supabase Storage bucket instead
// (server/cloudsync.js decides what and when; deploy/render/README.md explains the setup). This module only speaks
// the Storage REST API:
//
//   download(path)            GET    /storage/v1/object/{bucket}/{prefix}{path}         → Buffer | null (not found)
//   upload(path, bytes, opts) POST   /storage/v1/object/{bucket}/{prefix}{path}         x-upsert: true
//   copy(from, to)            POST   /storage/v1/object/copy                           {bucketId, sourceKey, destinationKey}
//                                    (server-side: no object bytes leave this host — the hourly history copies)
//   remove(paths)             DELETE /storage/v1/object/{bucket}                       {prefixes: [...]}
//   list(folder)              POST   /storage/v1/object/list/{bucket}                  {prefix, limit, offset, sortBy}
//   getBucket / createBucket  GET    /storage/v1/bucket/{bucket} · POST /storage/v1/bucket
//   ensurePrivateBucket()     creates the bucket (public: false) when missing; REFUSES a public bucket
//
// Every request carries `Authorization: Bearer <key>` and `apikey: <key>` (the service-role key, or a `sb_secret_…`
// secret key: the official supabase-js client sends both headers for either kind), `redirect: 'error'` and a timeout.
// Network errors — including a body that stalls or resets AFTER the headers arrived — 5xx and 429 are retried a
// bounded number of times with backoff; other statuses fail at once. Timeouts are SIZE-AWARE: each attempt gets
// `timeoutMs` plus `perMbMs` per MB of the request body (uploads) or of the announced Content-Length (downloads: the
// window restarts when the headers arrive), so a database that grows never becomes impossible to restore or upload.
// maxCallMs(bytes) is the worst case of one call (every attempt + the backoff): cloudsync waits that long after taking
// the lease over before its first full upload. Supabase answers a missing object with 404 or with 400
// {"statusCode":"404","error":"not_found"} — both mean "not found".
//
// SECRETS: the key never appears in a log line or an error. Errors carry the operation, the object path (never
// secret), the HTTP status and at most 160 characters of the response body with every occurrence of the key replaced
// by "[key]"; network errors carry only the error name and its code (ECONNRESET, ENOTFOUND, …). The headers object
// is built per request and never logged.
//
// The fetch used is globalThis.fetch at call time (the egress guard in server/hl/egress.js, installed by main(),
// allows only this origin's /storage/v1/ paths); tests inject `fetch` or point `url` at a local fake.

import { setTimeout as delay } from 'node:timers/promises';

/** One object-path segment: URL-safe characters only, so a path never needs (or gets) creative encoding. */
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,200}$/;
/** Supabase bucket ids we accept (a subset of what Supabase allows: lower-case, URL-safe). */
export const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;
/** The only path prefix this client (and the egress guard's storage allowance) ever uses. */
export const STORAGE_API_PREFIX = '/storage/v1/';

const BODY_SNIPPET = 160;
const LIST_PAGE = 1000;
const MB = 1024 * 1024;
const NOT_FOUND = Symbol('not found');

/** A failed Storage call. `status` is the HTTP status (null for network errors); `retryable` as decided above. */
export class CloudStoreError extends Error {
  constructor(message, { status = null, code = 'cloud_error', retryable = false } = {}) {
    super(message);
    this.name = 'CloudStoreError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Validate an object path ("a/b/c.gz"): 1–12 URL-safe segments, never "." or "..". → the path. */
export function checkObjectPath(p) {
  const text = String(p ?? '');
  const parts = text.split('/');
  if (!text || parts.length > 12 || parts.some((s) => !SEGMENT_RE.test(s) || s === '.' || s === '..')) {
    throw new CloudStoreError(`invalid object path "${text.slice(0, 80)}"`, { code: 'bad_path' });
  }
  return text;
}

/** CLOUD_STORE_PREFIX → '' or 'seg/seg/' (leading/trailing slashes trimmed; each segment validated). */
export function normalizePrefix(prefix) {
  const text = String(prefix ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!text) return '';
  checkObjectPath(text);
  return `${text}/`;
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** Read and discard a body (keeps the connection reusable); a failure mid-body is a network error (retried). */
async function drain(res) {
  await res.arrayBuffer();
  return true;
}

/** A JSON body, or null when it is not JSON (the caller reports "unexpected answer"). Read errors still throw. */
async function readJsonOrNull(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 404, or Supabase's 400 {"statusCode":"404", "error":"not_found"|"Bucket not found", …}. */
function isNotFound(status, text) {
  if (status === 404) return true;
  return status === 400 && /"statusCode"\s*:\s*"?404|not[\s_-]?found/i.test(text);
}

function codeForStatus(status) {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'http_error';
}

/** Name + code of a network-level failure, never its message (Undici messages can carry URLs). */
function describeNetworkError(err, timeoutMs) {
  if (err?.name === 'TimeoutError') return `timeout after ${timeoutMs} ms`;
  if (err?.code === 'egress_denied') return 'egress_denied';
  const code = err?.cause?.code ?? err?.code;
  const name = typeof err?.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error';
  return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? `${name} ${code}` : `${name} (network)`;
}

/** A disabled store (cloud persistence not configured): `enabled: false`; every call throws. */
function disabledStore() {
  const off = async () => {
    throw new CloudStoreError('cloud store is not configured', { code: 'disabled' });
  };
  return Object.freeze({
    enabled: false, describe: () => ({ enabled: false }), maxCallMs: () => 0,
    download: off, upload: off, copy: off, remove: off, list: off, getBucket: off, createBucket: off, ensurePrivateBucket: off,
  });
}

/**
 * @param {object} o
 * @param {string} o.url        SUPABASE_URL (an origin; config.js validated https in production)
 * @param {string} o.key        the service-role / secret key (NEVER logged)
 * @param {string} o.bucket
 * @param {string} [o.prefix]   CLOUD_STORE_PREFIX ('' = the bucket root)
 * @param {typeof fetch} [o.fetch]   tests; default: globalThis.fetch at call time (the egress-guarded one)
 * @param {(line: string) => void} [o.log]
 * @param {number} [o.timeoutMs]     per attempt, before the size allowance (15 s)
 * @param {number} [o.perMbMs]       added per MB of the body (uploads) or of the announced Content-Length (5 s)
 * @param {number} [o.retries]       extra attempts on network errors / 5xx / 429 (2)
 * @param {number} [o.backoffMs]     first backoff; then ×3 (500 → 1500)
 * @param {(ms: number) => Promise<void>} [o.sleep]
 */
export function createCloudStore({
  url, key, bucket, prefix = '', fetch: fetchImpl = null, log = () => {}, timeoutMs = 15_000, perMbMs = 5_000, retries = 2,
  backoffMs = 500, sleep = delay,
} = {}) {
  if (!url || !key) return disabledStore();
  const origin = new URL(String(url)).origin;
  const secret = String(key);
  const bucketId = String(bucket ?? '');
  if (!BUCKET_RE.test(bucketId)) throw new CloudStoreError('invalid bucket name (use 2–63 of a–z, 0–9, ".", "_", "-")', { code: 'bad_bucket' });
  const pre = normalizePrefix(prefix);
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (input, init) => globalThis.fetch(input, init);

  /** Any text that leaves this module: the key replaced, control characters dropped, length capped. */
  const scrub = (text, max = BODY_SNIPPET) => {
    let s = String(text ?? '');
    if (secret.length >= 8) s = s.split(secret).join('[key]');
    s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };

  const full = (p) => `${pre}${checkObjectPath(p)}`;
  const objectUrl = (p) => `${origin}${STORAGE_API_PREFIX}object/${encodeURIComponent(bucketId)}/${encodePath(full(p))}`;

  /** One attempt's time limit for `bytes` of payload. */
  const attemptMs = (bytes = 0) => timeoutMs + Math.ceil(Math.max(0, Number(bytes) || 0) / MB) * perMbMs;
  /** Worst case of one call: every attempt timing out, plus the backoff between them. */
  const maxCallMs = (bytes = 0) => {
    let total = (retries + 1) * attemptMs(bytes);
    for (let i = 0; i < retries; i++) total += backoffMs * 3 ** i;
    return total;
  };

  /**
   * One Storage call with bounded retries. `read(res)` consumes a 2xx body INSIDE the attempt, under the attempt's
   * timeout (a stalled or reset body is a network error: retried). → read's result, or NOT_FOUND when `notFoundOk`
   * and the answer means "not found". Throws CloudStoreError.
   */
  async function call(op, method, target, shown, { body = undefined, headers = {}, notFoundOk = false, read = drain } = {}) {
    const sent = body === undefined ? 0 : Buffer.byteLength(body);
    let attempt = 0;
    for (;;) {
      const ctl = new AbortController();
      let timer = null;
      let limit = 0;
      let timedOut = false;
      const arm = (ms) => {
        clearTimeout(timer);
        limit = ms;
        timer = setTimeout(() => {
          timedOut = true;
          ctl.abort();
        }, ms);
        timer.unref?.();
      };
      arm(attemptMs(sent));
      const networkError = (err, what = '') => new CloudStoreError(
        `cloud ${op} ${shown}: ${what}${timedOut ? `timeout after ${limit} ms` : describeNetworkError(err, limit)}`,
        { code: 'network', retryable: err?.code !== 'egress_denied' },
      );
      let failure;
      try {
        let res = null;
        try {
          res = await doFetch(target, {
            method,
            // Built here, per request, and never logged.
            headers: { Authorization: `Bearer ${secret}`, apikey: secret, ...headers },
            body,
            redirect: 'error',
            cache: 'no-store',
            signal: ctl.signal,
          });
        } catch (err) {
          failure = networkError(err);
        }
        if (res && res.ok) {
          // Downloads: the size allowance starts when the headers arrive.
          const announced = Number(res.headers?.get?.('content-length'));
          if (Number.isFinite(announced) && announced > MB) arm(attemptMs(announced));
          try {
            return await read(res);
          } catch (err) {
            failure = networkError(err, 'body ');
          }
        } else if (res) {
          let text = '';
          try {
            text = await res.text();
          } catch {
            // The body is only for the message.
          }
          if (notFoundOk && isNotFound(res.status, text)) return NOT_FOUND;
          const retryable = res.status >= 500 || res.status === 429;
          failure = new CloudStoreError(`cloud ${op} ${shown}: HTTP ${res.status}${text ? ` ${scrub(text)}` : ''}`,
            { status: res.status, code: codeForStatus(res.status), retryable });
        }
      } finally {
        clearTimeout(timer);
      }
      if (!failure.retryable || attempt >= retries) throw failure;
      await sleep(backoffMs * 3 ** attempt);
      attempt += 1;
    }
  }

  const json = (obj) => ({ body: JSON.stringify(obj), headers: { 'content-type': 'application/json' } });

  const store = {
    enabled: true,

    /** Safe description for status output (no key). */
    describe() {
      return { enabled: true, host: new URL(origin).host, bucket: bucketId, prefix: pre };
    },

    /** The worst-case duration of one call carrying `bytes` (every attempt timing out, plus the backoff). */
    maxCallMs,

    /** GET an object → its bytes, or null when it does not exist. A stalled or reset body is retried. */
    async download(p) {
      // no-cache: a CDN in front of Storage must revalidate (lease.json is read before every upload).
      const out = await call('download', 'GET', objectUrl(p), `${bucketId}/${full(p)}`, {
        notFoundOk: true,
        headers: { 'cache-control': 'no-cache' },
        read: async (res) => Buffer.from(await res.arrayBuffer()),
      });
      return out === NOT_FOUND ? null : out;
    },

    /** POST (upsert) an object. → {path, bytes} */
    async upload(p, bytes, { contentType = 'application/octet-stream', cacheControl = 'no-cache' } = {}) {
      const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      await call('upload', 'POST', objectUrl(p), `${bucketId}/${full(p)}`, {
        body: data,
        headers: { 'content-type': contentType, 'x-upsert': 'true', 'cache-control': cacheControl },
      });
      return { path: p, bytes: data.length };
    },

    /**
     * Server-side copy inside the bucket: no object bytes leave this host. An existing destination is replaced
     * (x-upsert; a Storage version that refuses it with "already exists" gets the destination removed, then the
     * copy again). → {from, to}
     */
    async copy(from, to) {
      const shown = `${bucketId}/${full(from)} to ${full(to)}`;
      const once = () => call('copy', 'POST', `${origin}${STORAGE_API_PREFIX}object/copy`, shown, {
        body: JSON.stringify({ bucketId, sourceKey: full(from), destinationKey: full(to) }),
        headers: { 'content-type': 'application/json', 'x-upsert': 'true' },
      });
      try {
        await once();
      } catch (err) {
        const exists = err.status === 409 || (err.status === 400 && /already exists|duplicate|"statusCode"\s*:\s*"?409/i.test(err.message));
        if (!exists) throw err;
        await store.remove([to]);
        await once();
      }
      return { from, to };
    },

    /** DELETE objects (missing ones are ignored by Supabase). → number of paths sent */
    async remove(paths) {
      const list = [...new Set((Array.isArray(paths) ? paths : [paths]).map(full))];
      if (!list.length) return 0;
      for (let i = 0; i < list.length; i += 500) {
        const chunk = list.slice(i, i + 500);
        await call('remove', 'DELETE', `${origin}${STORAGE_API_PREFIX}object/${encodeURIComponent(bucketId)}`,
          `${bucketId}/${chunk[0]}${chunk.length > 1 ? ` (+${chunk.length - 1})` : ''}`, json({ prefixes: chunk }));
      }
      return list.length;
    },

    /**
     * The direct children of a folder ('' = the prefix root). → [{name, folder, size, updated_at}] (all pages).
     * Supabase marks sub-folders with `id: null`.
     */
    async list(folder = '') {
      const where = folder ? full(folder) : pre.replace(/\/$/, '');
      const out = [];
      for (let offset = 0; ; offset += LIST_PAGE) {
        const rows = await call('list', 'POST', `${origin}${STORAGE_API_PREFIX}object/list/${encodeURIComponent(bucketId)}`,
          `${bucketId}/${where}`, { ...json({ prefix: where, limit: LIST_PAGE, offset, sortBy: { column: 'name', order: 'asc' } }), read: readJsonOrNull });
        if (!Array.isArray(rows)) throw new CloudStoreError(`cloud list ${bucketId}/${where}: unexpected answer`, { code: 'bad_answer' });
        for (const r of rows) {
          if (!r || typeof r.name !== 'string') continue;
          out.push({ name: r.name, folder: r.id == null, size: Number(r.metadata?.size ?? r.metadata?.contentLength) || null, updated_at: r.updated_at ?? null });
        }
        if (rows.length < LIST_PAGE) return out;
      }
    },

    /** → {id, name, public} or null when the bucket does not exist. */
    async getBucket() {
      const b = await call('bucket', 'GET', `${origin}${STORAGE_API_PREFIX}bucket/${encodeURIComponent(bucketId)}`, bucketId, { notFoundOk: true, read: readJsonOrNull });
      if (b === NOT_FOUND) return null;
      if (!b || typeof b !== 'object') throw new CloudStoreError(`cloud bucket ${bucketId}: unexpected answer`, { code: 'bad_answer' });
      return { id: b.id ?? bucketId, name: b.name ?? bucketId, public: b.public === true };
    },

    /** Create the bucket, PRIVATE. */
    async createBucket() {
      await call('create bucket', 'POST', `${origin}${STORAGE_API_PREFIX}bucket`, bucketId, json({ id: bucketId, name: bucketId, public: false }));
    },

    /**
     * The bucket must exist and be PRIVATE (it holds password hashes and sessions). Missing → created private.
     * Public → CloudStoreError('bucket_public'): main() refuses to start (cloudsync re-checks it every hour).
     * @returns {Promise<'exists'|'created'>}
     */
    async ensurePrivateBucket() {
      let b = await store.getBucket();
      if (!b) {
        try {
          await store.createBucket();
        } catch (err) {
          if (err.status !== 409 && !/already exists/i.test(err.message)) throw err;
        }
        b = await store.getBucket();
        if (!b) throw new CloudStoreError(`cloud bucket ${bucketId}: could not be created`, { code: 'bad_answer' });
        if (b.public) throw new CloudStoreError(`cloud bucket ${bucketId} is PUBLIC: make it private in the Supabase dashboard (Storage → bucket → Edit)`, { code: 'bucket_public' });
        log(`[cloud] created the PRIVATE bucket "${bucketId}"`);
        return 'created';
      }
      if (b.public) {
        throw new CloudStoreError(`cloud bucket ${bucketId} is PUBLIC: make it private in the Supabase dashboard (Storage → bucket → Edit) — it would expose the database`, { code: 'bucket_public' });
      }
      return 'exists';
    },
  };
  return Object.freeze(store);
}

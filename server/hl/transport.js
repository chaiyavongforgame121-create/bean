// server/hl/transport.js — the one HTTP helper behind every testnet info and exchange request (PLATFORM §6.2).
//
// Every Hyperliquid fetch here:
//   • is a POST with a JSON body and `redirect: 'error'` (§1.2 rule 8: a 3xx can never re-POST a signed body
//     elsewhere; a redirect is classified `client_error`, never followed);
//   • has `AbortSignal.timeout(8000)`;
//   • maps the HTTP outcome onto the §6.9 taxonomy: 429 → ip_rate_limited (re-queued by the scheduler), other 4xx →
//     client_error (the body may be plain text; kept truncated), ≥ 500 / network / timeout / unreadable 2xx →
//     transport.
// Error messages carry a code, an HTTP status and at most 300 chars of the exchange's own text — never the request
// body, a signature or a key (§5.3 rule 5).

import { HL_TIMEOUT_MS } from './constants.js';

export const ERROR_TEXT_MAX = 300;

/** A failed testnet request. `code` is a §6.9 code (or `bad_response` / `skipped` / `lane_aborted` / `draining`). */
export class TestnetError extends Error {
  constructor(message, { code, http = null, transport = false, skipped = false, requeue = false, redirect = false, text = null } = {}) {
    super(message);
    this.name = 'TestnetError';
    this.code = code;
    this.http = http;
    this.transport = transport;
    this.skipped = skipped;
    this.requeue = requeue;
    this.redirect = redirect;
    this.text = text;
  }
}

/** Truncate exchange text for storage and logs. */
export function clip(text, max = ERROR_TEXT_MAX) {
  if (text === null || text === undefined) return null;
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function isRedirectError(err) {
  const msgs = [err?.message, err?.cause?.message, err?.cause?.code].filter((m) => typeof m === 'string');
  return msgs.some((m) => /redirect/i.test(m));
}

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '?';
  }
};

/**
 * POST a JSON body and return the parsed 2xx JSON. Throws TestnetError for everything else.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {string} body        already-serialized JSON (exchange: the exact signed bytes, resent identically)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{json: any, http: number}>}
 */
export async function postJson(fetchImpl, url, body, { timeoutMs = HL_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new TestnetError('fetch is not available', { code: 'transport', transport: true });
  const where = pathOf(url);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isRedirectError(err)) {
      throw new TestnetError(`${where}: redirect refused`, { code: 'client_error', redirect: true });
    }
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new TestnetError(`${where}: ${timedOut ? 'timed out' : 'network error'}`, { code: 'transport', transport: true });
  }
  const status = Number(res?.status) || 0;
  if (status >= 300 && status < 400) {
    throw new TestnetError(`${where}: HTTP ${status} redirect refused`, { code: 'client_error', http: status, redirect: true });
  }
  if (status === 429) {
    throw new TestnetError(`${where}: HTTP 429 (rate limited)`, { code: 'ip_rate_limited', http: 429, requeue: true });
  }
  if (status >= 500 || status === 0) {
    throw new TestnetError(`${where}: HTTP ${status || 'error'}`, { code: 'transport', http: status || null, transport: true });
  }
  let text = null;
  try {
    text = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
  } catch {
    text = null;
  }
  if (status >= 400) {
    // A 4xx is definitive: the exchange refused the request format. Plain-text bodies are common here.
    throw new TestnetError(`${where}: HTTP ${status}`, { code: 'client_error', http: status, text: clip(text) });
  }
  if (text === null) {
    throw new TestnetError(`${where}: unreadable response`, { code: 'transport', http: status, transport: true });
  }
  try {
    return { json: JSON.parse(text), http: status };
  } catch {
    // A 2xx we cannot read: for an exchange POST the outcome is unknown, which the transport rule handles safely.
    throw new TestnetError(`${where}: invalid JSON in a ${status} response`, { code: 'transport', http: status, transport: true, text: clip(text) });
  }
}

// server/hl/errors.js — the exchange error taxonomy and retry rules (PLATFORM §6.9, §6.6).
//
// classify() looks at the HTTP outcome first, then does a case-insensitive substring match on the exchange's text.
// Unknown text → `rejected_other` (the raw text is stored, 300 chars).
//
// ADDRESS-BEARING ERRORS. Hyperliquid answers a WRONG SIGNATURE with the same texts it uses for a missing agent or an
// unfunded user ("User or API Wallet 0x… does not exist." / "Must deposit before performing actions. User: 0x…"),
// naming the address it RECOVERED. So the first 0x…40 address in the text is compared with our credential:
//   • neither our agent nor our account  → `signature_mismatch` (our payload/signing is wrong: halt signing for
//                                            everyone, never revoke a credential for it);
//   • "does not exist" naming our agent  → `agent_unknown` (confirm with testnet userRole before revoking);
//   • "must deposit" naming our account (or agent) → `no_deposit` (the credential stays verified).
// A signing regression (key order, a trailing zero) must never look like a revoked wallet: that would revoke every
// player's credential and pause all their bots.

import { firstAddr, isAddr, normAddr } from './addr.js';

/** Every §6.9 code, plus the warnings that reach players the same way (live_error / bot_sync / orders.code). */
export const EXCHANGE_CODES = Object.freeze([
  'transport', 'ip_rate_limited', 'client_error', 'address_rate_limited', 'nonce', 'signature_mismatch', 'agent_unknown',
  'no_deposit', 'min_notional', 'insufficient_margin', 'ioc_no_match', 'reduce_only', 'price_band', 'tick',
  'leverage_rejected', 'oi_cap', 'rejected_other',
  // not exchange answers, but they travel in live_error.code / orders.reason and have g.err.* keys (§6.8, §6.11):
  'below_min_order', 'address_budget_low', 'agent_expiring',
]);

/** Pause note codes (§8.5 BotRow.note_code, bot_paused.note_code). */
export const NOTE_CODES = Object.freeze([
  'liquidated_testnet', 'external_close', 'position_drift', 'credential_revoked', 'kill_switch', 'leverage_rejected',
  'insufficient_margin_repeat', 'agent_expiring', 'inactive', 'mainnet_key', 'account_moved', 'fills_beyond_horizon',
  'no_deposit',
]);

/**
 * What to do after each code (§6.9 "Retry policy" and "Bot effect" columns). Machine-readable for WP3's venue:
 *   resend         resend the IDENTICAL signed bytes (same nonce, same cloid)
 *   definitive     never resent; the order is rejected
 *   alert          log an operator alert (a format/signing bug)
 *   backoffMs      wait before the next send (host-wide for ip_rate_limited, per player for address_rate_limited)
 *   next           when to try again: 'bar' (next bar), 'target_change', 'reconcile_now', 'admin', 'never'
 *   confirmRole    queue a testnet userRole(agent) confirmation before acting on the credential
 *   haltSigning    stop ALL testnet sends (signature_mismatch)
 *   pause          note code to pause the bot with (immediately, or after `pauseAfter` consecutive errors)
 *   liveError      emit a live_error for the bot (keyed per situation)
 */
export const RETRY = Object.freeze({
  transport: Object.freeze({ resend: true, resendMax: 2, resendWindowMs: 10_000, then: 'order_status', next: 'reconcile', liveError: false }),
  ip_rate_limited: Object.freeze({ backoffMs: 15_000, scope: 'host', requeue: true, next: 'queued', liveError: false }),
  client_error: Object.freeze({ definitive: true, alert: true, next: 'never', liveError: true }),
  address_rate_limited: Object.freeze({ backoffMs: Object.freeze([10_000, 20_000, 40_000, 60_000]), scope: 'player', next: 'backoff', liveError: true }),
  nonce: Object.freeze({ resignOnce: 'first_transmission_without_transport_failure', otherwise: 'unknown_then_order_status', next: 'as_resolved', liveError: false }),
  signature_mismatch: Object.freeze({ haltSigning: true, alert: true, next: 'admin', liveError: true }),
  agent_unknown: Object.freeze({ confirmRole: true, next: 'never', pause: 'credential_revoked', whenConfirmed: true, liveError: true }),
  no_deposit: Object.freeze({ confirmRole: true, keepCredential: true, next: 'bar', liveError: true, liveErrorOnce: true }),
  min_notional: Object.freeze({ next: 'target_change', skipReason: 'below_min_order', liveError: false }),
  insufficient_margin: Object.freeze({ next: 'bar', pause: 'insufficient_margin_repeat', pauseAfter: 3, liveError: true }),
  ioc_no_match: Object.freeze({ next: 'bar', flattenRetryMs: 2_000, liveError: true, liveErrorOnce: true }),
  reduce_only: Object.freeze({ next: 'reconcile_now', liveError: false }),
  price_band: Object.freeze({ next: 'bar', liveError: true }),
  tick: Object.freeze({ definitive: true, alert: true, next: 'never', liveError: true }),
  leverage_rejected: Object.freeze({ definitive: true, pause: 'leverage_rejected', next: 'never', liveError: true }),
  oi_cap: Object.freeze({ next: 'bar', liveError: true }),
  rejected_other: Object.freeze({ next: 'bar', liveError: true }),
});

/** Substring rules in match order (lower-case). Address-bearing texts are handled before these. */
const TEXT_RULES = [
  ['nonce', 'nonce'],
  ['too many cumulative requests', 'address_rate_limited'],
  ['rate limit', 'address_rate_limited'],
  ['minimum value of $10', 'min_notional'],
  ['insufficient margin', 'insufficient_margin'],
  ['could not immediately match', 'ioc_no_match'],
  ['reduce only order would increase', 'reduce_only'],
  ['away from the reference price', 'price_band'],
  ['too far from', 'price_band'],
  ['tick size', 'tick'],
  ['invalid price', 'tick'],
  ['open interest', 'oi_cap'],
];

const lower = (s) => String(s).toLowerCase();
const normOrNull = (a) => (isAddr(a) ? normAddr(a) : null);

/**
 * Classify an exchange error TEXT (a top-level `{"status":"err","response":text}` or a status `{"error":text}`).
 * @param {string} text
 * @param {object} [ctx]
 * @param {string} [ctx.agentAddress]
 * @param {string} [ctx.accountAddress]
 * @param {string} [ctx.actionType]  'updateLeverage' enables the `leverage_rejected` rule
 */
export function classifyText(text, { agentAddress, accountAddress, actionType } = {}) {
  const t = lower(text ?? '');
  if (!t) return 'rejected_other';
  const agent = normOrNull(agentAddress);
  const account = normOrNull(accountAddress);
  const named = firstAddr(String(text));
  const ours = named !== null && (named === agent || named === account);
  if (t.includes('must deposit')) {
    if (named === null || ours) return 'no_deposit';
    return 'signature_mismatch';
  }
  if (t.includes('does not exist')) {
    if (named === null) return 'agent_unknown'; // cannot tell: the userRole confirm decides; never revokes by itself
    if (named === agent || named === account) return 'agent_unknown';
    return 'signature_mismatch';
  }
  for (const [needle, code] of TEXT_RULES) if (t.includes(needle)) return code;
  if (actionType === 'updateLeverage' && t.includes('leverage')) return 'leverage_rejected';
  return 'rejected_other';
}

/**
 * Classify an exchange outcome (§6.9: HTTP status first, then the text).
 * @param {number|string|object|Error|null} responseOrStatus
 *   • a number → an HTTP status;
 *   • a string → an error text (or an unexpected bare-string status → rejected_other);
 *   • `{error: text}` (an order status) / `{status:'err', response: text}` (a top-level failure);
 *   • a thrown TestnetError / an exchange result `{transport, http, code, error}`.
 * @param {object} [ctx]  {agentAddress, accountAddress, attempt, hadTransportFailure, actionType}
 * @returns {string|null}  a code from EXCHANGE_CODES, or null when the input is a success
 */
export function classify(responseOrStatus, ctx = {}) {
  const r = responseOrStatus;
  if (r === null || r === undefined) return 'rejected_other';
  if (typeof r === 'number') return classifyHttp(r);
  if (typeof r === 'string') return classifyText(r, ctx);
  if (typeof r !== 'object') return 'rejected_other';
  if (r.redirect) return 'client_error';
  if (r.transport === true) return 'transport';
  if (typeof r.http === 'number' && (r.http < 200 || r.http >= 300)) return classifyHttp(r.http);
  if (typeof r.code === 'string' && EXCHANGE_CODES.includes(r.code)) return r.code;
  if (typeof r.error === 'string') return classifyText(r.error, ctx);
  if (r.status === 'err') return classifyText(typeof r.response === 'string' ? r.response : JSON.stringify(r.response ?? ''), ctx);
  if (r.status === 'ok') return null;
  return 'rejected_other';
}

function classifyHttp(status) {
  if (status === 429) return 'ip_rate_limited';
  if (status >= 500 || status === 0) return 'transport';
  if (status >= 300 && status < 400) return 'client_error'; // a redirect is never followed (redirect:'error')
  if (status >= 400) return 'client_error';
  return null;
}

/**
 * The §6.6 idempotency decision after an exchange answer, for one order intent.
 * @param {string} code
 * @param {object} s
 * @param {number} s.attempt               transmissions of the CURRENT signed bytes (1 = first)
 * @param {boolean} s.hadTransportFailure  any earlier transmission of this order failed in transport
 * @param {boolean} [s.resigned]           the one fresh-nonce re-sign was already used
 * @param {number} [s.resends]             identical-bytes resends already made
 * @param {number} [s.sinceFirstMs]        ms since the first transmission of the current bytes
 * @returns {'resend_identical'|'resign_fresh_nonce'|'resolve_order_status'|'rejected'|'requeue'}
 */
export function nextStep(code, { attempt = 1, hadTransportFailure = false, resigned = false, resends = 0, sinceFirstMs = 0 } = {}) {
  if (code === 'transport') {
    return resends < RETRY.transport.resendMax && sinceFirstMs < RETRY.transport.resendWindowMs ? 'resend_identical' : 'resolve_order_status';
  }
  if (code === 'nonce') {
    // Only a FIRST transmission without any transport failure is known not to have executed.
    if (attempt <= 1 && !hadTransportFailure) return resigned ? 'rejected' : 'resign_fresh_nonce';
    return 'resolve_order_status'; // probably executed: never re-signed
  }
  if (code === 'ip_rate_limited') return 'requeue';
  return 'rejected';
}

/** Per-player back-off for address_rate_limited: 10 s → 20 → 40 → 60 s (then 60 s). */
export function addressBackoffMs(consecutive) {
  const steps = RETRY.address_rate_limited.backoffMs;
  return steps[Math.max(0, Math.min(steps.length - 1, (consecutive | 0) - 1))];
}

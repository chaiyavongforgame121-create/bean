// server/hl/exchange.js — the ONLY code that POSTs to an /exchange URL (PLATFORM §1.2 rules 1–3, §6.2, §6.6, §6.9).
//
// Hard rules enforced here:
//   • The URL is the frozen constant TESTNET_EXCHANGE_URL. There is no URL parameter, environment override or
//     constructor option, and the URL is asserted (string, scheme, host, path) before every fetch.
//   • An allowlist refuses every action type other than order / cancelByCloid / updateLeverage (signed by the
//     player's testnet agent) and the P1 approveAgent relay (signed by the player's own wallet, re-checked here).
//     There is no code for withdraw3, usdSend, spotSend, usdClassTransfer, sendAsset, vaultTransfer or
//     subAccountTransfer.
//   • Every fetch uses redirect:'error' (transport.js); a redirect is a client_error, never followed.
//   • Error messages carry a code, ≤ 300 chars of the exchange's own text and nothing else: never a request body, a
//     signature or a key (§5.3 rule 5).
//   • signature_mismatch (a foreign address in "does not exist" / "must deposit") halts ALL testnet sends until an
//     admin resumes (§6.9); listeners persist the halt (admin_state.testnet_signing) and audit it.
//
// Two levels of API:
//   post(action, signer, nonce, opts)  sign once and transmit once → {ok, statuses, code, error, transport, http, …}
//   submit({...})                      the §6.6 idempotency state machine for one intent: write-ahead nonce hook,
//                                      identical-bytes resends after a transport failure (≤ 2 within 10 s), one
//                                      fresh-nonce re-sign ONLY after a first-transmission nonce error without any
//                                      transport failure, otherwise `unknown` → orderStatus(cloid) resolution.

import { isAddr, normAddr } from './addr.js';
import {
  ALLOWED_ACTIONS, APPROVE_AGENT_FIELDS, APPROVE_AGENT_PRIMARY_TYPE, HYPERLIQUID_CHAIN, L1_ACTIONS, PRIORITY,
  TESTNET_EXCHANGE_URL, TESTNET_HOST,
} from './constants.js';
import { addressBackoffMs, classifyText, nextStep } from './errors.js';
import { isLaneAbort } from './scheduler.js';
import { recoverUserSigned, splitSignature } from './signing.js';
import { TestnetError, clip, postJson } from './transport.js';
import { actionWeight } from './wire.js';

export { TESTNET_EXCHANGE_URL };

/** A refused send: a programming error (disallowed action, bad signer), never a network outcome. */
export class ExchangeRefusal extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ExchangeRefusal';
    this.code = code;
  }
}

/** Throws unless `url` is exactly the testnet exchange URL (string, scheme, host and path). */
export function assertTestnetExchangeUrl(url) {
  if (url !== TESTNET_EXCHANGE_URL) throw new ExchangeRefusal('exchange_url', 'refusing a non-testnet exchange URL');
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.host !== TESTNET_HOST || u.pathname !== '/exchange' || u.search || u.hash) {
    throw new ExchangeRefusal('exchange_url', 'refusing a non-testnet exchange URL');
  }
}

/** Throws ExchangeRefusal('action_not_allowed') unless the action type is on the allowlist. */
export function assertAllowedAction(action) {
  if (!action || typeof action !== 'object' || !ALLOWED_ACTIONS.includes(action.type)) {
    throw new ExchangeRefusal('action_not_allowed', `action type not allowed: ${typeof action?.type === 'string' ? action.type.slice(0, 40) : '?'}`);
  }
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * One entry of `response.data.statuses` → a tagged object. Statuses may be OBJECTS ({filled}, {resting}, {error})
 * or BARE STRINGS ("success", "waitingForFill", "waitingForTrigger", anything else) — the string test comes first.
 */
export function parseStatus(s, ctx = {}) {
  if (typeof s === 'string') {
    if (s === 'success') return { kind: 'success' };
    if (s === 'waitingForFill' || s === 'waitingForTrigger') return { kind: 'waiting', status: s };
    return { kind: 'error', code: 'rejected_other', error: clip(s), bare: true };
  }
  if (s && typeof s === 'object') {
    if (s.filled && typeof s.filled === 'object') {
      return { kind: 'filled', total_sz: num(s.filled.totalSz), avg_px: num(s.filled.avgPx), oid: num(s.filled.oid), raw: s.filled };
    }
    if (s.resting && typeof s.resting === 'object') return { kind: 'resting', oid: num(s.resting.oid), raw: s.resting };
    if (typeof s.error === 'string') return { kind: 'error', code: classifyText(s.error, ctx), error: clip(s.error) };
  }
  return { kind: 'error', code: 'rejected_other', error: clip(JSON.stringify(s ?? null)) };
}

/** A 2xx exchange JSON body → {ok, type, statuses, code, error}. */
export function parseExchangeResponse(json, ctx = {}) {
  if (json && json.status === 'ok') {
    const resp = json.response ?? null;
    const raw = Array.isArray(resp?.data?.statuses) ? resp.data.statuses : [];
    const statuses = raw.map((s) => parseStatus(s, ctx));
    return { ok: true, type: typeof resp?.type === 'string' ? resp.type : null, statuses, code: null, error: null };
  }
  if (json && json.status === 'err') {
    const text = typeof json.response === 'string' ? json.response : JSON.stringify(json.response ?? '');
    return { ok: false, type: null, statuses: [], code: classifyText(text, ctx), error: clip(text) };
  }
  return { ok: false, type: null, statuses: [], code: 'rejected_other', error: clip(JSON.stringify(json ?? null)) };
}

const FILLED = new Set(['filled']);
const OPEN = new Set(['open', 'triggered']);

/**
 * orderStatus(account, cloid) → our order status (§6.6 resolution). Status and filled size ONLY: price, fee and
 * closed P&L come from the fills sweep, never from `limitPx`.
 * @returns {{status: 'filled'|'partial'|'canceled'|'rejected'|'resting'|'unknown', unknownOid: boolean,
 *   oid: number|null, orig_sz: number|null, remaining_sz: number|null, filled_sz: number, exchange_status: string|null}}
 */
export function mapOrderStatus(raw) {
  if (!raw || raw.status !== 'order' || !raw.order) {
    return { status: 'unknown', unknownOid: raw?.status === 'unknownOid', oid: null, orig_sz: null, remaining_sz: null, filled_sz: 0, exchange_status: raw?.status ?? null };
  }
  const o = raw.order.order ?? {};
  const st = typeof raw.order.status === 'string' ? raw.order.status : '';
  const orig = num(o.origSz);
  const rest = num(o.sz);
  const filled = orig !== null && rest !== null ? Math.max(0, orig - rest) : 0;
  let status;
  if (FILLED.has(st)) status = 'filled';
  else if (OPEN.has(st)) status = 'resting';
  else if (filled > 0) status = 'partial';
  else if (/rejected$/i.test(st)) status = 'rejected';
  else status = 'canceled'; // canceled, marginCanceled, reduceOnlyCanceled, scheduledCancel, …
  return { status, unknownOid: false, oid: num(o.oid), orig_sz: orig, remaining_sz: rest, filled_sz: status === 'filled' ? (orig ?? filled) : filled, exchange_status: st || null };
}

export class TestnetExchange {
  /**
   * @param {object} opts
   * @param {import('./scheduler.js').HlScheduler} opts.scheduler
   * @param {import('./info.js').TestnetInfo} [opts.info]  for orderStatus resolution in submit()
   * @param {typeof fetch} [opts.fetch]                    injectable (tests, --testnet-double)
   * @param {() => number} [opts.now]
   * @param {(ms: number) => Promise<void>} [opts.sleep]
   * @param {(line: string) => void} [opts.log]
   * @param {number[]} [opts.resendDelaysMs]               pauses before identical-bytes resends
   * There is intentionally NO url option.
   */
  constructor({ scheduler, info = null, fetch: fetchImpl, now = Date.now, sleep, log, resendDelaysMs = [300, 1_000] } = {}) {
    if (!scheduler) throw new TypeError('TestnetExchange needs a scheduler');
    this.scheduler = scheduler;
    this.info = info;
    this.fetch = typeof fetchImpl === 'function' ? fetchImpl : (...a) => globalThis.fetch(...a);
    this.now = now;
    this.sleep = typeof sleep === 'function' ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
    this.log = typeof log === 'function' ? log : () => {};
    this.resendDelaysMs = resendDelaysMs;
    this.halted = false;
    this.haltSample = null;
    this.haltListeners = new Set();
    this.addrBackoff = new Map(); // agent address → {until, n}
    this.counts = { sent: 0, ok: 0, errors: 0, transport: 0, refused: 0, by_code: Object.create(null) };
  }

  // ---- the signing halt (signature_mismatch, §6.9) --------------------------------------------------------------

  get signingHalted() {
    return this.halted;
  }

  /** Set/clear the halt (boot: from admin_state.testnet_signing; admin_testnet_signing {resume:true} clears it). */
  setSigningHalt(halted, { sample = null } = {}) {
    this.halted = Boolean(halted);
    this.haltSample = this.halted ? clip(sample) : null;
    if (!this.halted) this.log('[hl] testnet signing resumed');
  }

  /** fn({sample}) is called once when a signature_mismatch halts signing. Returns an unsubscribe function. */
  onSigningHalt(fn) {
    this.haltListeners.add(fn);
    return () => this.haltListeners.delete(fn);
  }

  #haltSigning(sample) {
    if (this.halted) return;
    this.halted = true;
    this.haltSample = clip(sample);
    this.log(`[hl] ALERT testnet signing HALTED for everyone: signature_mismatch (exchange said: ${this.haltSample ?? '?'})`);
    for (const fn of this.haltListeners) {
      try {
        fn({ sample: this.haltSample });
      } catch (err) {
        this.log(`[hl] signing-halt listener failed: ${err?.name ?? 'error'}`);
      }
    }
  }

  // ---- per-signer back-off (address_rate_limited) ----------------------------------------------------------------

  #blockedMs(agent) {
    const b = this.addrBackoff.get(agent);
    if (!b) return 0;
    const left = b.until - this.now();
    return left > 0 ? left : 0;
  }

  #noteAddressLimited(agent) {
    const prev = this.addrBackoff.get(agent);
    const n = (prev?.n ?? 0) + 1;
    const ms = addressBackoffMs(n);
    this.addrBackoff.set(agent, { until: this.now() + ms, n });
    return ms;
  }

  // ---- one transmission ----------------------------------------------------------------------------------------

  /**
   * Sign an L1 action once. The returned object is opaque: resend it with send() to transmit IDENTICAL bytes.
   * @param {object} action  order / cancelByCloid / updateLeverage (wire.js builders)
   * @param {{address: string, signL1: Function}} signer  makeSigner() (testnet only)
   * @param {number} nonce
   */
  prepare(action, signer, nonce) {
    assertAllowedAction(action);
    if (!L1_ACTIONS.includes(action.type)) throw new ExchangeRefusal('action_not_allowed', 'approveAgent is relayed with relayApproveAgent()');
    if (!signer || typeof signer.signL1 !== 'function' || !isAddr(signer.address)) throw new ExchangeRefusal('bad_signer', 'a makeSigner() signer is required');
    const signature = signer.signL1(action, nonce);
    const body = JSON.stringify({ action, nonce, signature, vaultAddress: null, expiresAfter: null });
    return Object.freeze({ type: action.type, action, nonce, agent: normAddr(signer.address), body, weight: actionWeight(action) });
  }

  /**
   * Transmit prepared bytes once (under the scheduler).
   * @returns {Promise<{ok: boolean, sent: boolean, type: string, statuses: object[], code: string|null,
   *   error: string|null, transport: boolean, http: number|null, halted?: boolean, skipped?: boolean,
   *   redirect?: boolean, backoff_ms?: number, response?: any}>}
   */
  async send(prepared, { priority = PRIORITY.MIRROR, ctx = null, maxWaitMs, accountAddress = null } = {}) {
    const base = { ok: false, sent: false, type: prepared.type, statuses: [], code: null, error: null, transport: false, http: null };
    if (this.halted) {
      this.counts.refused++;
      return { ...base, code: 'signature_mismatch', halted: true };
    }
    const blocked = this.#blockedMs(prepared.agent);
    if (blocked > 0) return { ...base, code: 'address_rate_limited', skipped: true, backoff_ms: blocked };
    const account = accountAddress && isAddr(accountAddress) ? normAddr(accountAddress) : null;
    const classifyCtx = { agentAddress: prepared.agent, accountAddress: account, actionType: prepared.type };
    let json;
    try {
      const out = await this.scheduler.run(priority, prepared.weight, async () => {
        if (this.halted) throw new TestnetError('signing halted', { code: 'signature_mismatch', skipped: true });
        const url = TESTNET_EXCHANGE_URL;
        assertTestnetExchangeUrl(url); // asserted before every fetch (§1.2 rule 3)
        this.scheduler.note('exchange');
        this.counts.sent++;
        return postJson(this.fetch, url, prepared.body);
      }, { ctx, maxWaitMs, label: prepared.type });
      json = out.json;
    } catch (err) {
      if (isLaneAbort(err) || err instanceof ExchangeRefusal) throw err;
      if (err?.skipped) {
        // Never transmitted: budget/back-off deadline, draining, or the halt raced in.
        return { ...base, code: err.code === 'signature_mismatch' ? 'signature_mismatch' : (err.code ?? 'skipped'), skipped: true, halted: err.code === 'signature_mismatch' || undefined };
      }
      this.#countError(err?.code ?? 'transport');
      if (err?.code === 'client_error') {
        this.log(`[hl] ALERT exchange ${prepared.type} refused as a client error (HTTP ${err.http ?? 'redirect'}${err.redirect ? ', redirect refused' : ''}): ${err.text ?? ''}`);
        return { ...base, sent: true, code: 'client_error', http: err.http ?? null, redirect: Boolean(err.redirect), error: clip(err.text ?? err.message) };
      }
      if (err?.code === 'ip_rate_limited') {
        return { ...base, sent: true, code: 'ip_rate_limited', http: 429, error: 'HTTP 429' };
      }
      this.counts.transport++;
      return { ...base, sent: true, code: 'transport', transport: true, http: err?.http ?? null, error: clip(err?.message ?? 'transport error') };
    }
    const parsed = parseExchangeResponse(json, classifyCtx);
    const codes = [parsed.code, ...parsed.statuses.map((s) => s.code)].filter(Boolean);
    if (codes.includes('signature_mismatch')) {
      this.#haltSigning(parsed.error ?? parsed.statuses.find((s) => s.code === 'signature_mismatch')?.error);
    }
    if (codes.includes('address_rate_limited')) {
      const ms = this.#noteAddressLimited(prepared.agent);
      this.log(`[hl] testnet address rate limit for ${prepared.agent.slice(0, 8)}…: backing off ${ms / 1000} s`);
    } else if (parsed.ok) {
      this.addrBackoff.delete(prepared.agent);
    }
    for (const c of codes) this.#countError(c);
    if (parsed.ok && !codes.length) this.counts.ok++;
    return { ...base, sent: true, ok: parsed.ok, type: prepared.type, statuses: parsed.statuses, code: parsed.code, error: parsed.error, http: 200, response: json };
  }

  #countError(code) {
    this.counts.errors++;
    this.counts.by_code[code] = (this.counts.by_code[code] ?? 0) + 1;
    this.scheduler.note('error');
  }

  /**
   * Sign and transmit once (§6.1 interface). Refuses (throws) a disallowed action; returns without sending while
   * signing is halted.
   */
  async post(action, signer, nonce, opts = {}) {
    assertAllowedAction(action);
    if (this.halted) {
      this.counts.refused++;
      return { ok: false, sent: false, type: action.type, statuses: [], code: 'signature_mismatch', error: null, transport: false, http: null, halted: true };
    }
    return this.send(this.prepare(action, signer, nonce), opts);
  }

  // ---- one intent (the §6.6 state machine) -----------------------------------------------------------------------

  /**
   * Submit one intent with the idempotency rules of §6.6.
   * @param {object} p
   * @param {object} p.action               order (single wire with a cloid) / updateLeverage / cancelByCloid
   * @param {{address: string, signL1: Function}} p.signer
   * @param {string} [p.accountAddress]     the master account (address-bearing errors; orderStatus resolution)
   * @param {(info: {resign: boolean}) => number|Promise<number>} p.reserveNonce
   *        write-ahead hook: returns the nonce AFTER persisting it (credentials.last_nonce + the pending order row
   *        in one committed transaction, §3.5). Called once, plus once more for the single fresh-nonce re-sign.
   * @param {(t: {transmission: number, attempts: number, nonce: number, transport_failed: boolean, result: object})
   *        => void|Promise<void>} [p.onTransmit]  persistence hook after each transmission (orders.attempts, …)
   * @param {number} [p.priority]           PRIORITY.FLATTEN for flattens, PRIORITY.MIRROR otherwise
   * @param {object} [p.ctx]                the lane job ctx (cancellation)
   * @param {boolean} [p.resolve=true]      resolve an unknown outcome with orderStatus(account, cloid)
   * @returns {Promise<{outcome: 'filled'|'partial'|'resting'|'done'|'waiting'|'rejected'|'canceled'|'unknown'|'skipped'|'halted',
   *   code: string|null, error: string|null, nonce: number|null, cloid: string|null, oid: number|null,
   *   filled_sz: number|null, avg_px: number|null, transmissions: number, attempts: number, resends: number,
   *   transport_failed: boolean, resigned: boolean, status: object|null, resolution: object|null, result: object|null}>}
   */
  async submit({ action, signer, accountAddress = null, reserveNonce, onTransmit = null, priority = PRIORITY.MIRROR, ctx = null, resolve = true }) {
    assertAllowedAction(action);
    if (typeof reserveNonce !== 'function') throw new TypeError('submit needs reserveNonce');
    const cloid = action.type === 'order' && action.orders?.length === 1 ? (action.orders[0].c ?? null) : null;
    const account = accountAddress && isAddr(accountAddress) ? normAddr(accountAddress) : null;
    const out = {
      outcome: null, code: null, error: null, nonce: null, cloid, oid: null, filled_sz: null, avg_px: null,
      transmissions: 0, attempts: 0, resends: 0, transport_failed: false, resigned: false, status: null, resolution: null, result: null,
    };
    if (this.halted) return { ...out, outcome: 'halted', code: 'signature_mismatch' };
    const agent = signer && isAddr(signer.address) ? normAddr(signer.address) : null;
    const blocked = agent ? this.#blockedMs(agent) : 0;
    if (blocked > 0) return { ...out, outcome: 'skipped', code: 'address_rate_limited', backoff_ms: blocked };

    const sleep = (ms) => (ctx?.sleep ? ctx.sleep(ms) : this.sleep(ms));
    out.nonce = await reserveNonce({ resign: false });
    let prepared = this.prepare(action, signer, out.nonce);
    let firstSendMs = null;
    for (;;) {
      ctx?.assertAlive?.();
      out.attempts++;
      out.transmissions++;
      if (firstSendMs === null) firstSendMs = this.now();
      const res = await this.send(prepared, { priority, ctx, accountAddress: account });
      out.result = res;
      if (!res.sent) {
        // Nothing was transmitted this time. If an earlier transmission may have executed, resolve it.
        out.attempts--;
        out.transmissions--;
        if (out.transmissions === 0 && !out.resigned) {
          return { ...out, outcome: res.halted ? 'halted' : 'skipped', code: res.code };
        }
        return this.#unknown(out, { account, ctx, resolve, code: res.code });
      }
      if (res.transport) out.transport_failed = true;
      if (onTransmit) {
        await onTransmit({ transmission: out.transmissions, attempts: out.attempts, nonce: out.nonce, transport_failed: out.transport_failed, result: res });
      }
      const code = res.ok ? null : res.code;
      if (code === 'transport') {
        const step = nextStep('transport', { resends: out.resends, sinceFirstMs: this.now() - firstSendMs });
        if (step === 'resend_identical') {
          out.resends++;
          await sleep(this.resendDelaysMs[Math.min(out.resends - 1, this.resendDelaysMs.length - 1)] ?? 0);
          continue; // the IDENTICAL signed bytes: same nonce, same cloid
        }
        return this.#unknown(out, { account, ctx, resolve, code: 'transport' });
      }
      if (code === 'nonce') {
        const step = nextStep('nonce', { attempt: out.attempts, hadTransportFailure: out.transport_failed, resigned: out.resigned });
        if (step === 'resign_fresh_nonce') {
          // Not executed (first transmission, no transport failure): ONE new attempt, fresh nonce, same cloid.
          out.resigned = true;
          out.nonce = await reserveNonce({ resign: true });
          prepared = this.prepare(action, signer, out.nonce);
          out.attempts = 0;
          out.resends = 0;
          firstSendMs = null;
          continue;
        }
        if (step === 'rejected') return { ...out, outcome: 'rejected', code: 'nonce', error: res.error };
        return this.#unknown(out, { account, ctx, resolve, code: 'nonce', error: res.error }); // never re-signed
      }
      if (code === 'ip_rate_limited') {
        // A 429 was not processed. With an earlier ambiguous transmission the outcome is still unknown.
        if (out.transmissions === 1) return { ...out, outcome: 'skipped', code };
        return this.#unknown(out, { account, ctx, resolve, code });
      }
      if (!res.ok) return { ...out, outcome: 'rejected', code, error: res.error };
      // status: ok
      const st = res.statuses[0];
      out.status = st ?? null;
      if (!st) return { ...out, outcome: 'done' }; // updateLeverage → {"type":"default"}
      switch (st.kind) {
        case 'filled': {
          const want = Number(action.orders?.[0]?.s);
          const partial = Number.isFinite(want) && st.total_sz !== null && st.total_sz < want - 1e-12;
          return { ...out, outcome: partial ? 'partial' : 'filled', oid: st.oid, filled_sz: st.total_sz, avg_px: st.avg_px };
        }
        case 'resting':
          this.log(`[hl] anomaly: an IOC order came back resting (cloid ${cloid ?? '?'})`);
          return { ...out, outcome: 'resting', oid: st.oid };
        case 'success':
          return { ...out, outcome: 'done' };
        case 'waiting':
          return { ...out, outcome: 'waiting' };
        default:
          return { ...out, outcome: 'rejected', code: st.code, error: st.error };
      }
    }
  }

  /** Outcome unknown: resolve by orderStatus(account, cloid) when we can (§6.6); never re-sign. */
  async #unknown(out, { account, ctx, resolve, code, error = null }) {
    const res = { ...out, outcome: 'unknown', code, error };
    if (!resolve || !this.info || !account || !out.cloid) return res;
    try {
      const raw = await this.info.orderStatus(account, out.cloid, { ctx, priority: PRIORITY.ORDER_STATUS });
      const m = mapOrderStatus(raw);
      res.resolution = m;
      if (m.unknownOid) return res; // stays unknown until the next reconcile
      return { ...res, outcome: m.status, oid: m.oid, filled_sz: m.filled_sz };
    } catch (err) {
      if (isLaneAbort(err)) throw err;
      return res;
    }
  }

  // ---- P1: relay a wallet-signed approveAgent (§6.10) ----------------------------------------------------------

  /**
   * Re-check and relay the player's wallet-signed approveAgent. The typed data is rebuilt here with the literal
   * hyperliquidChain "Testnet"; the recovered signer must be the account, otherwise `signer_mismatch` (nothing sent).
   * @param {object} p
   * @param {string} p.accountAddress
   * @param {string} p.agentAddress
   * @param {string} p.agentName
   * @param {number} p.nonce
   * @param {number} p.chainId               the wallet's chain id (integer)
   * @param {string|{r,s,v}} p.signature     65-byte 0x hex, or split
   */
  async relayApproveAgent({ accountAddress, agentAddress, agentName, nonce, chainId, signature, priority = PRIORITY.VERIFY, ctx = null }) {
    const base = { ok: false, sent: false, type: 'approveAgent', statuses: [], code: null, error: null, transport: false, http: null };
    let account;
    let agent;
    let sig;
    try {
      account = normAddr(accountAddress);
      agent = normAddr(agentAddress);
      if (typeof agentName !== 'string' || !agentName || agentName.length > 64) throw new Error('agentName');
      if (!Number.isSafeInteger(nonce) || nonce <= 0) throw new Error('nonce');
      if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('chainId');
      sig = typeof signature === 'string' ? splitSignature(signature) : signature;
    } catch {
      return { ...base, code: 'bad_request' };
    }
    const message = { hyperliquidChain: HYPERLIQUID_CHAIN, agentAddress: agent, agentName, nonce };
    let signer;
    try {
      signer = recoverUserSigned(APPROVE_AGENT_PRIMARY_TYPE, APPROVE_AGENT_FIELDS, message, chainId, sig);
    } catch {
      return { ...base, code: 'signer_mismatch' };
    }
    if (signer !== account) return { ...base, code: 'signer_mismatch' };
    if (this.halted) return { ...base, code: 'signature_mismatch', halted: true };
    const action = {
      type: 'approveAgent', signatureChainId: `0x${chainId.toString(16)}`, hyperliquidChain: HYPERLIQUID_CHAIN,
      agentAddress: agent, agentName, nonce,
    };
    assertAllowedAction(action);
    const pad = (h) => `0x${BigInt(h).toString(16).padStart(64, '0')}`;
    const body = JSON.stringify({ action, nonce, signature: { r: pad(sig.r), s: pad(sig.s), v: sig.v }, vaultAddress: null, expiresAfter: null });
    const prepared = Object.freeze({ type: 'approveAgent', action, nonce, agent: account, body, weight: 1 });
    return this.send(prepared, { priority, ctx, accountAddress: account });
  }

  stats() {
    return {
      signing_halted: this.halted,
      halt_sample: this.haltSample,
      address_backoffs: this.addrBackoff.size,
      ...this.counts,
      by_code: { ...this.counts.by_code },
    };
  }
}

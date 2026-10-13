// server/hl/verify.js — testnet API-wallet verification and the FAIL-CLOSED mainnet guard (PLATFORM §6.7, §1.2).
//
// verifyAgent() runs the §6.7 steps in this order; each failure stops and returns a code:
//   1. format (no network): account `0x…40`; key = 64 hex with a scalar in [1, n−1] (own BigInt check); a seed phrase
//      (12+ words) is refused and nothing about it is logged. Format refusals do not count against the connect limit.
//   2. agent ≠ account (a master key is refused).
//   3. TESTNET userRole(agent) must be {role:'agent', data:{user: <account>}} (mixed case tolerated). Done BEFORE the
//      mainnet check, so a random well-formed key never spends mainnet weight.
//   4. MAINNET userRole(agent) through the engine's HyperliquidClient (lowest priority, one retry, 10 s in total):
//      `missing` → continue; ANY other role → 422 mainnet_key (sub_reason mainnet_<role>); no answer → 503
//      mainnet_check_unavailable. Nothing is stored in either refusal (fail-closed).
//   5. extraAgents(account): name and validUntil (expired < 1 h → refused; < 7 d → warning; unnamed → warning).
//   6. userAbstraction(account): default/disabled = standard, unifiedAccount = unified; others refused.
//   7. balances and positions: standard → clearinghouseState; unified → spotClearinghouseState balances
//      (account_value ≈ total + Σ uPnL, an estimate until runbook R5, risk K1). Zero → 422 no_testnet_funds.
// Step 8 (seal and upsert) needs the DB and the master key: WP3 (credentials.js) does it with planUpsert() below.
//
// Nothing in this module logs or returns key material; results carry addresses and codes only.

import { COINS } from '../market.js';
import { isAddr, normAddr, sameAddr, truncAddr } from './addr.js';
import { PRIORITY } from './constants.js';
import { addressOf, isValidScalar } from './signing.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const MAINNET_CHECK_TIMEOUT_MS = 10_000;
export const MAINNET_RECHECK_EVERY_MS = DAY;
export const MIN_CAPITAL_USD = 20;
const ROLES = new Set(['missing', 'user', 'agent', 'vault', 'subAccount']);
const STANDARD = new Set(['default', 'disabled']);

const fail = (status, code, extra = {}) => ({ ok: false, status, code, ...extra });
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---- step 1: formats --------------------------------------------------------------------------------------------

/** `account_address` → {ok, address} | {ok:false, status:400, code:'bad_address', counts:false}. */
export function checkAddress(s) {
  if (!isAddr(s)) return fail(400, 'bad_address', { counts: false });
  return { ok: true, address: normAddr(s) };
}

/**
 * Parse a pasted agent key. Accepted: `^(0x)?[0-9a-fA-F]{64}$` (trimmed) with a scalar in [1, n−1]. A seed-phrase
 * shape (12+ words of 3–8 letters, any separators or numbering) → `seed_phrase`. Anything else → `bad_key_format`.
 * The caller drops its reference to the string at once; the bytes are zeroed by the caller after use.
 * @returns {{ok: true, bytes: Uint8Array} | {ok: false, status: number, code: string, counts: false}}
 */
export function parseAgentKey(input) {
  if (typeof input !== 'string') return fail(400, 'bad_key_format', { counts: false });
  const t = input.trim();
  const m = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(t);
  if (m) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(m[1].slice(i * 2, i * 2 + 2), 16);
    if (!isValidScalar(bytes)) {
      bytes.fill(0);
      return fail(400, 'bad_key_format', { counts: false });
    }
    return { ok: true, bytes };
  }
  const words = t.split(/[^A-Za-z]+/).filter(Boolean);
  if (words.length >= 12 && words.every((w) => w.length >= 3 && w.length <= 8)) return fail(422, 'seed_phrase', { counts: false });
  return fail(400, 'bad_key_format', { counts: false });
}

// ---- step 4: the mainnet guard ----------------------------------------------------------------------------------

/** Parse a userRole answer → a role string, or null when the answer is unusable. Unknown roles are kept (fail-closed). */
function roleOf(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.role !== 'string' || !raw.role) return null;
  return raw.role;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'timeout' })), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The fail-closed mainnet userRole check (§6.7 step 4; also every 24 h for stored keys).
 * @param {string} agentAddress
 * @param {{userRole: (addr: string, opts?: object) => Promise<{role: string}>}} mainnetInfo  the engine's
 *        HyperliquidClient (its queued userRole shares ≤ 2/min with re-checks, connects first) or a double
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000]  total deadline (one retry inside it)
 * @param {'connect'|'recheck'} [opts.kind='recheck']
 * @param {() => number} [opts.now]
 * @returns {Promise<'missing'|string|'unavailable'>}  'missing', another role (a HIT), or 'unavailable'
 */
export async function mainnetRecheck(agentAddress, mainnetInfo, { timeoutMs = MAINNET_CHECK_TIMEOUT_MS, kind = 'recheck', now = Date.now } = {}) {
  const addr = normAddr(agentAddress);
  if (!mainnetInfo || typeof mainnetInfo.userRole !== 'function') return 'unavailable';
  const deadline = now() + timeoutMs;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = deadline - now();
    if (left <= 0) break;
    try {
      const raw = await withTimeout(Promise.resolve().then(() => mainnetInfo.userRole(addr, { kind, timeoutMs: left })), left);
      const role = roleOf(raw);
      if (role !== null) return role;
    } catch {
      // fall through: one retry inside the deadline, then 'unavailable'
    }
  }
  return 'unavailable';
}

/** mainnetRecheck() → the §6.7 step 4 verdict. */
export function mainnetVerdict(role) {
  if (role === 'missing') return { ok: true };
  if (role === 'unavailable') return fail(503, 'mainnet_check_unavailable', { counts: true });
  return fail(422, 'mainnet_key', { sub_reason: `mainnet_${role}`, counts: true, audit: 'mainnet_key_detected' });
}

// ---- balances ---------------------------------------------------------------------------------------------------

/** Positions from clearinghouseState → [{coin, szi, entry_px, unrealized_pnl, …}] (non-zero only). */
export function parsePositions(ch) {
  const out = [];
  for (const ap of Array.isArray(ch?.assetPositions) ? ch.assetPositions : []) {
    const p = ap?.position;
    const szi = num(p?.szi);
    if (!p || typeof p.coin !== 'string' || !szi) continue;
    out.push({
      coin: p.coin,
      szi,
      entry_px: num(p.entryPx),
      unrealized_pnl: num(p.unrealizedPnl) ?? 0,
      liquidation_px: num(p.liquidationPx),
      margin_used: num(p.marginUsed),
      position_value: num(p.positionValue),
      leverage: num(p.leverage?.value),
      leverage_type: typeof p.leverage?.type === 'string' ? p.leverage.type : null,
      funding_since_open: num(p.cumFunding?.sinceOpen),
    });
  }
  return out;
}

/**
 * Account balances for one abstraction mode (§6.7 step 7).
 * @param {'default'|'disabled'|'unifiedAccount'} abstraction
 * @param {object} ch     clearinghouseState
 * @param {object} [spot] spotClearinghouseState (unified only)
 */
export function accountBalances(abstraction, ch, spot = null) {
  const positions = parsePositions(ch);
  const ms = ch?.marginSummary ?? {};
  if (abstraction === 'unifiedAccount') {
    const usdc = (Array.isArray(spot?.balances) ? spot.balances : []).find((b) => b?.coin === 'USDC') ?? {};
    const total = num(usdc.total) ?? 0;
    const hold = num(usdc.hold) ?? 0;
    const upnl = positions.reduce((s, p) => s + (p.unrealized_pnl ?? 0), 0);
    return {
      positions,
      account_value: total + upnl, // ≈ until runbook R5 (risk K1): does `total` already include uPnL?
      account_value_est: true,
      balance: total,
      free: total - hold,
      withdrawable: total - hold,
      total_margin_used: num(ms.totalMarginUsed),
      total_ntl_pos: num(ms.totalNtlPos),
    };
  }
  const av = num(ms.accountValue) ?? 0;
  const wd = num(ch?.withdrawable) ?? 0;
  return {
    positions,
    account_value: av,
    account_value_est: false,
    balance: av,
    free: wd,
    withdrawable: wd,
    total_margin_used: num(ms.totalMarginUsed),
    total_ntl_pos: num(ms.totalNtlPos),
  };
}

// ---- the whole check --------------------------------------------------------------------------------------------

/**
 * §6.7 steps 1–7.
 * @param {object} p
 * @param {string} p.accountAddress
 * @param {Uint8Array} p.agentKeyBytes   32 bytes (from parseAgentKey, or decrypted for testnet_verify)
 * @param {import('./info.js').TestnetInfo} p.info
 * @param {{userRole: Function}} p.mainnetInfo
 * @param {() => number} [p.now]
 * @param {number} [p.minCapitalUsd=20]
 * @param {string[]} [p.coins]           our coins (existing-positions warning)
 * @param {number} [p.mainnetTimeoutMs=10000]
 * @param {boolean} [p.skipMainnet=false] never set by connect/verify; for the double-only dev path it stays false too
 * @returns {Promise<object>} ok: {ok:true, account_address, agent_address, agent_name, valid_until_ms, abstraction,
 *   account_value, account_value_est, balance, free, withdrawable, total_margin_used, positions, warnings,
 *   mainnet_checked_ms, verified_ms}; failure: {ok:false, status, code, sub_reason?, vars?, counts, audit?}
 */
export async function verifyAgent({ accountAddress, agentKeyBytes, info, mainnetInfo, now = Date.now,
  minCapitalUsd = MIN_CAPITAL_USD, coins = COINS.map((c) => c.coin), mainnetTimeoutMs = MAINNET_CHECK_TIMEOUT_MS,
  priority = PRIORITY.VERIFY } = {}) {
  // 1. formats
  const acct = checkAddress(accountAddress);
  if (!acct.ok) return acct;
  const account = acct.address;
  if (!isValidScalar(agentKeyBytes)) return fail(400, 'bad_key_format', { counts: false });
  // 2. a master key
  const agent = addressOf(agentKeyBytes);
  if (agent === account) return fail(422, 'master_key', { counts: true, agent_address: agent });

  const opts = { priority };
  const testnetDown = () => fail(503, 'testnet_down', { counts: false, agent_address: agent });
  // 3. testnet role
  let role;
  try {
    role = await info.userRole(agent, opts);
  } catch {
    return testnetDown();
  }
  if (role.role === 'user') return fail(422, 'master_key', { counts: true, agent_address: agent });
  if (role.role !== 'agent') return fail(422, 'not_agent', { counts: true, agent_address: agent });
  const owner = role.data && isAddr(role.data.user) ? normAddr(role.data.user) : null;
  if (owner !== account) {
    return fail(422, 'agent_mismatch', { counts: true, agent_address: agent, vars: { belongs_to: owner ? truncAddr(owner) : null } });
  }
  // 4. mainnet guard (fail-closed)
  const mainnetRole = await mainnetRecheck(agent, mainnetInfo, { timeoutMs: mainnetTimeoutMs, kind: 'connect', now });
  const verdict = mainnetVerdict(mainnetRole);
  if (!verdict.ok) return { ...verdict, agent_address: agent };
  const mainnetCheckedMs = now();
  // 5. named agent and expiry
  const warnings = [];
  let agentName = null;
  let validUntil = null;
  let extras;
  try {
    extras = await info.extraAgents(account, opts);
  } catch {
    return testnetDown();
  }
  const entry = extras.find((e) => e && sameAddr(e.address, agent));
  if (entry) {
    agentName = typeof entry.name === 'string' ? entry.name : null;
    validUntil = num(entry.validUntil);
    if (validUntil !== null) {
      if (validUntil < now() + HOUR) return fail(422, 'agent_expired', { counts: true, agent_address: agent, valid_until_ms: validUntil });
      if (validUntil < now() + 7 * DAY) warnings.push({ code: 'agent_expiring_soon', valid_until_ms: validUntil });
    }
  } else {
    warnings.push({ code: 'unnamed_agent' });
  }
  // 6. account abstraction
  let abstraction;
  try {
    abstraction = await info.userAbstraction(account, opts);
  } catch {
    return testnetDown();
  }
  if (!STANDARD.has(abstraction) && abstraction !== 'unifiedAccount') {
    return fail(422, 'abstraction_unsupported', { counts: true, agent_address: agent, vars: { abstraction: String(abstraction).slice(0, 32) } });
  }
  // 7. balances and positions
  let bal;
  try {
    const ch = await info.clearinghouseState(account, opts);
    const spot = abstraction === 'unifiedAccount' ? await info.spotClearinghouseState(account, opts) : null;
    bal = accountBalances(abstraction, ch, spot);
  } catch {
    return testnetDown();
  }
  if (!(bal.account_value > 0)) return fail(422, 'no_testnet_funds', { counts: true, agent_address: agent, account_value: bal.account_value });
  if (bal.account_value < minCapitalUsd) warnings.push({ code: 'no_funds', account_value: bal.account_value });
  const ours = new Set(coins);
  const busy = bal.positions.filter((p) => ours.has(p.coin)).map((p) => p.coin);
  if (busy.length) warnings.push({ code: 'existing_positions', coins: busy });
  return {
    ok: true,
    account_address: account,
    agent_address: agent,
    agent_name: agentName,
    valid_until_ms: validUntil,
    abstraction,
    ...bal,
    warnings,
    mainnet_checked_ms: mainnetCheckedMs,
    verified_ms: now(),
  };
}

/**
 * Confirm an `agent_unknown` / `no_deposit` answer with testnet userRole(agent) (P4) before touching a credential.
 * @returns {Promise<'agent'|'revoked'|'unavailable'>}  'agent' = still the account's agent (do NOT revoke)
 */
export async function confirmAgentRole(info, agentAddress, accountAddress, { ctx = null } = {}) {
  try {
    const r = await info.userRole(agentAddress, { priority: PRIORITY.ORDER_STATUS, ctx });
    if (r.role === 'agent' && sameAddr(r.data?.user, accountAddress)) return 'agent';
    return 'revoked';
  } catch {
    return 'unavailable';
  }
}

/**
 * §6.7 step 8 decision (pure): what a verified connect does to the credential rows.
 * @param {object} p
 * @param {any} p.uid                 the connecting garden
 * @param {string} p.account          normalized account address
 * @param {string} p.agent            normalized agent address
 * @param {{user_id: any, account_address: string, agent_address: string, status: string}[]} p.rows
 *        every credential row whose account OR agent equals these (any garden, any status)
 * @returns {{kind: 'new'|'replace', takeover: any[]} | {kind: 'conflict', status: 409, code: string}}
 *   new      insert (or overwrite this garden's revoked/error row)
 *   replace  same garden, same account: Replace API wallet (bots kept, last_nonce restarts at 0)
 *   takeover the gardens whose revoked/error row for this ACCOUNT must be wiped first (their testnet bots close
 *            in our books only, note code account_moved)
 */
export function planUpsert({ uid, account, agent, rows }) {
  const live = (r) => r.status === 'pending' || r.status === 'verified';
  const mine = rows.find((r) => r.user_id === uid && live(r));
  if (mine && !sameAddr(mine.account_address, account)) return { kind: 'conflict', status: 409, code: 'already_connected' };
  const others = rows.filter((r) => r.user_id !== uid);
  if (others.some((r) => live(r) && sameAddr(r.agent_address, agent))) return { kind: 'conflict', status: 409, code: 'agent_in_use' };
  if (others.some((r) => live(r) && sameAddr(r.account_address, account))) return { kind: 'conflict', status: 409, code: 'account_in_use' };
  const takeover = [...new Set(others.filter((r) => !live(r) && sameAddr(r.account_address, account)).map((r) => r.user_id))];
  return { kind: mine ? 'replace' : 'new', takeover };
}

/**
 * The periodic mainnet re-check (§6.7): at boot and whenever a verified credential's `mainnet_checked_ms` is older than
 * 24 h. Due checks run one at a time through the mainnet client (whose userRole slot is ≤ 2 per minute, connects
 * first), never all at once. The effects belong to WP3 through `onResult`:
 *   'missing'      → update mainnet_checked_ms
 *   'unavailable'  → nothing changes; retried at the next slot
 *   a role (HIT)   → flatten the player's testnet bots at P0 (≤ 60 s), wipe the credential, pause the bots with
 *                    note code mainnet_key, emit credential_status {status:'revoked', reason:'mainnet_key'}, audit
 *                    mainnet_key_detected.
 */
export class MainnetRechecker {
  /**
   * @param {object} p
   * @param {{userRole: Function}} p.mainnetInfo
   * @param {() => Array<{uid: any, agent_address: string, mainnet_checked_ms: number|null}>|Promise<Array>} p.listDue
   *        verified credentials (WP3 may pre-filter; due ones are re-filtered here)
   * @param {(r: {uid: any, agent_address: string, result: string, hit: boolean}) => void|Promise<void>} p.onResult
   */
  constructor({ mainnetInfo, listDue, onResult, now = Date.now, log, everyMs = MAINNET_RECHECK_EVERY_MS,
    timeoutMs = MAINNET_CHECK_TIMEOUT_MS, pollMs = 30_000, timers = { setTimeout, clearTimeout } } = {}) {
    this.mainnetInfo = mainnetInfo;
    this.listDue = listDue;
    this.onResult = onResult;
    this.now = now;
    this.log = typeof log === 'function' ? log : () => {};
    this.everyMs = everyMs;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
    this.timers = timers;
    this.handle = null;
    this.running = false;
    this.busy = false;
    this.stopped = false;
    this.counts = { checked: 0, hits: 0, unavailable: 0 };
  }

  /** Credentials due now (never checked, or checked more than 24 h ago), oldest first. */
  due(rows) {
    const cutoff = this.now() - this.everyMs;
    return rows
      .filter((r) => r && isAddr(r.agent_address) && (r.mainnet_checked_ms === null || r.mainnet_checked_ms === undefined || r.mainnet_checked_ms <= cutoff))
      .sort((a, b) => (a.mainnet_checked_ms ?? 0) - (b.mainnet_checked_ms ?? 0));
  }

  /** Re-check one credential now (also used on testnet_verify). */
  async checkOne(row) {
    const result = await mainnetRecheck(row.agent_address, this.mainnetInfo, { timeoutMs: this.timeoutMs, kind: 'recheck', now: this.now });
    const hit = result !== 'missing' && result !== 'unavailable';
    this.counts.checked++;
    if (hit) this.counts.hits++;
    if (result === 'unavailable') this.counts.unavailable++;
    const uid = row.uid ?? row.user_id;
    if (hit) this.log(`[hl] ALERT mainnet re-check HIT: a stored testnet agent has mainnet role '${result}' (uid ${uid})`);
    await this.onResult({ uid, agent_address: normAddr(row.agent_address), result, hit });
    return result;
  }

  /** Process every due credential, one after another. Returns the number checked. */
  async tick() {
    if (this.busy) return 0;
    this.busy = true;
    let n = 0;
    try {
      const rows = this.due(await this.listDue());
      for (const row of rows) {
        if (this.stopped) break;
        await this.checkOne(row);
        n++;
      }
    } catch (err) {
      this.log(`[hl] mainnet re-check pass failed (${err?.name ?? 'error'})`);
    } finally {
      this.busy = false;
    }
    return n;
  }

  /** Boot pass, then a pass every `pollMs` (each pass checks only due credentials). */
  start() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    const loop = async () => {
      this.handle = null;
      await this.tick();
      if (!this.running) return;
      this.handle = this.timers.setTimeout(loop, this.pollMs);
      this.handle?.unref?.();
    };
    loop();
  }

  stop() {
    this.running = false;
    this.stopped = true;
    if (this.handle) this.timers.clearTimeout(this.handle);
    this.handle = null;
  }
}

/**
 * Bind the verification helpers to one testnet instance (createTestnet). Connects are limited to 2 starts per
 * rolling minute across the process (§6.7: "limited to 2 per minute globally, so they never starve trading"); a connect
 * that cannot start within `queueMs` answers 503 busy (it does not count against the player's limit).
 */
export function createVerifier({ info, mainnetInfo, now = Date.now, log, perMinute = 2, queueMs = 30_000, sleep } = {}) {
  const starts = [];
  const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  async function slot() {
    const deadline = now() + queueMs;
    for (;;) {
      const t = now();
      while (starts.length && starts[0] <= t - 60_000) starts.shift();
      if (starts.length < perMinute) {
        starts.push(t);
        return true;
      }
      const next = starts[0] + 60_000 - t + 1;
      if (t + next > deadline) return false;
      await wait(next);
    }
  }
  return Object.freeze({
    checkAddress,
    parseAgentKey,
    planUpsert,
    accountBalances,
    /** §6.7 steps 1–7 with this instance's info and mainnet client. */
    async verifyAgent(p) {
      // Format checks never wait for a slot and never touch the network.
      const acct = checkAddress(p?.accountAddress);
      if (!acct.ok) return acct;
      if (!isValidScalar(p?.agentKeyBytes)) return fail(400, 'bad_key_format', { counts: false });
      if (!(await slot())) return fail(503, 'busy', { counts: false });
      return verifyAgent({ info, mainnetInfo, now, ...p });
    },
    /** The fail-closed mainnet check for one stored agent ('missing' | role | 'unavailable'). */
    mainnetRecheck(agentAddress, opts = {}) {
      return mainnetRecheck(agentAddress, mainnetInfo, { now, ...opts });
    },
    confirmAgentRole(agentAddress, accountAddress, opts) {
      return confirmAgentRole(info, agentAddress, accountAddress, opts);
    },
    /** A periodic re-checker bound to this mainnet client (WP3 supplies listDue/onResult). */
    rechecker(opts) {
      return new MainnetRechecker({ mainnetInfo, now, log, ...opts });
    },
  });
}

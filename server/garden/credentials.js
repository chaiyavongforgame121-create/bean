// server/garden/credentials.js — the `withSigner` bridge (WP1 secrets + DB → WP2 signer) and the credential row
// operations the gardens need (PLATFORM §5.1, §6.6, §6.7, §6.11).
//
//   withSigner(uid, fn)   the ONLY decrypt path for an agent key: decrypt into a fresh Uint8Array(32), build the
//                         testnet-only signer (makeSigner), run fn(signer), and zero the bytes in `finally`. The key is
//                         never converted to a string, never cached across calls and never returned.
//   link(uid)             the player's TestnetLink (no key material): status, addresses, expiry, abstraction, …
//   store(…)              seal + upsert in ONE transaction (§6.7 step 8): Replace API wallet on the same account,
//                         take-over of another garden's revoked/error row for the same account (its bots are closed
//                         in our books by the caller), 409 for a live conflict.
//   wipe(uid)             zero, delete, WAL checkpoint (WP1 wipeCredentials, §5.3 rule 9).
//   preparePending / withPendingKey / dropPending
//                         the P1 browser-wallet flow (§6.10): a server-generated agent key waits, SEALED and in memory
//                         only, for ≤ 10 min until the player's wallet approves it; then it goes through the normal
//                         connect (verify + store). See the deviation note at PENDING_AGENT_TTL_MS.
//
// SQL rule (§3.2): constant statements, values only through `?` bindings.

import crypto from 'node:crypto';

import { ApiError } from '../live.js';

/**
 * A prepared (not yet approved) browser-wallet agent expires after this long (§6.10 step 1.2).
 *
 * Deviation from §6.10 step 1.2 (documented): the pending key is NOT written to `credentials` as a `pending` row with a
 * placeholder account. (1) `credentials` has one row per player (PK user_id, venue), so a pending row would overwrite a
 * connected player's live key while they approve a replacement; (2) the partial UNIQUE index on account_address covers
 * `pending` rows, so two players preparing at once would collide on the same placeholder address. The key is instead
 * sealed with the master key (AES-256-GCM, the same AAD scheme with a zero placeholder account) and held in memory;
 * it never leaves this module, is zeroed when dropped, and a restart simply forgets it (the player prepares again).
 */
export const PENDING_AGENT_TTL_MS = 10 * 60_000;
const PENDING_AAD_ACCOUNT = `0x${'0'.repeat(40)}`;

const SQL = Object.freeze({
  get: "SELECT * FROM credentials WHERE user_id = ? AND venue = 'hl_testnet'",
  byAccount: "SELECT user_id, status FROM credentials WHERE account_address = ? AND venue = 'hl_testnet'",
  byAgent: "SELECT user_id, status FROM credentials WHERE agent_address = ? AND venue = 'hl_testnet'",
  upsert: `INSERT INTO credentials (user_id, venue, account_address, agent_address, agent_name, valid_until_ms, key_ct,
      key_iv, key_tag, key_id, enc_version, status, status_reason, abstraction, last_nonce, verified_ms,
      mainnet_checked_ms, expiry_flags, value_at_connect, created_ms, updated_ms)
    VALUES (?, 'hl_testnet', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', NULL, ?, 0, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(user_id, venue) DO UPDATE SET account_address = excluded.account_address,
      agent_address = excluded.agent_address, agent_name = excluded.agent_name,
      valid_until_ms = excluded.valid_until_ms, key_ct = excluded.key_ct, key_iv = excluded.key_iv,
      key_tag = excluded.key_tag, key_id = excluded.key_id, enc_version = excluded.enc_version,
      status = 'verified', status_reason = NULL, abstraction = excluded.abstraction, last_nonce = 0,
      verified_ms = excluded.verified_ms, mainnet_checked_ms = excluded.mainnet_checked_ms, expiry_flags = 0,
      value_at_connect = excluded.value_at_connect, updated_ms = excluded.updated_ms`,
  zero: `UPDATE credentials SET key_ct = zeroblob(32), key_iv = zeroblob(12), key_tag = zeroblob(16), updated_ms = ?
    WHERE user_id = ? AND venue = 'hl_testnet'`,
  del: "DELETE FROM credentials WHERE user_id = ? AND venue = 'hl_testnet'",
  setStatus: "UPDATE credentials SET status = ?, status_reason = ?, updated_ms = ? WHERE user_id = ? AND venue = 'hl_testnet'",
  setVerified: `UPDATE credentials SET status = 'verified', status_reason = NULL, verified_ms = ?, valid_until_ms = ?,
      agent_name = ?, abstraction = ?, mainnet_checked_ms = ?, updated_ms = ? WHERE user_id = ? AND venue = 'hl_testnet'`,
  setFlags: "UPDATE credentials SET expiry_flags = ?, updated_ms = ? WHERE user_id = ? AND venue = 'hl_testnet'",
  setMainnet: "UPDATE credentials SET mainnet_checked_ms = ?, updated_ms = ? WHERE user_id = ? AND venue = 'hl_testnet'",
  dueMainnet: `SELECT user_id, agent_address FROM credentials WHERE status = 'verified'
    AND (mainnet_checked_ms IS NULL OR mainnet_checked_ms < ?) ORDER BY mainnet_checked_ms LIMIT ?`,
  expiring: `SELECT user_id, valid_until_ms, expiry_flags FROM credentials WHERE status = 'verified'
    AND valid_until_ms IS NOT NULL AND valid_until_ms < ?`,
  verifiedCount: "SELECT count(*) AS n FROM credentials WHERE status = 'verified'",
  recheckRows: "SELECT user_id, agent_address, mainnet_checked_ms FROM credentials WHERE status = 'verified'",
});

/** TestnetLink (§8.2) of a credentials row — never any key column. */
export function linkOf(row) {
  if (!row) return null;
  return {
    status: row.status,
    account_address: row.account_address,
    agent_address: row.agent_address,
    agent_name: row.agent_name ?? null,
    valid_until_ms: row.valid_until_ms ?? null,
    verified_ms: row.verified_ms ?? null,
    status_reason: row.status_reason ?? null,
    abstraction: row.abstraction ?? null,
    value_at_connect: row.value_at_connect ?? null,
    connected_ms: row.created_ms ?? null,
  };
}

export class Credentials {
  /**
   * @param {object} opts
   * @param {object} opts.db           WP1 Db
   * @param {object} [opts.secrets]    WP1 Secrets ({ seal, open, canSeal }); null → no decrypt (testnet off)
   * @param {Function} [opts.makeSigner]  WP2 signing.makeSigner(keyBytes) → { address, signL1 }
   * @param {Function} [opts.wipeCredentials]  WP1 secrets.wipeCredentials(db, uid, opts) (preferred wipe)
   * @param {() => number} [opts.now]
   * @param {(line: string) => void} [opts.log]
   */
  constructor({ db, secrets = null, makeSigner = null, wipeCredentials = null, now = Date.now, log = console.warn } = {}) {
    if (!db || typeof db.prepare !== 'function') throw new TypeError('Credentials needs a Db');
    this.db = db;
    this.secrets = secrets;
    this.makeSigner = typeof makeSigner === 'function' ? makeSigner : null;
    this.wipeImpl = typeof wipeCredentials === 'function' ? wipeCredentials : null;
    this.now = now;
    this.log = log;
    /** uid → { sealed, agentAddress, agentName, nonce, expiresMs } (P1 wallet flow; see PENDING_AGENT_TTL_MS). */
    this.pendingAgents = new Map();
  }

  // ---- P1 browser-wallet approveAgent (§6.10) -------------------------------------------------------------------

  /**
   * Generate a fresh agent key for `uid` (a valid secp256k1 scalar), seal it in memory and return only its public
   * facts. A second prepare replaces the first. 503 testnet_disabled when no key can be sealed or signed with.
   * @returns {{ agentAddress: string, agentName: string, nonce: number, expiresMs: number }}
   */
  preparePending(uid, { agentName, nonce, ttlMs = PENDING_AGENT_TTL_MS }) {
    if (!this.makeSigner || !this.secrets || typeof this.secrets.seal !== 'function' || this.secrets.canSeal === false) {
      throw new ApiError(503, 'the testnet venue is not enabled on this server', 'testnet_disabled');
    }
    this.#sweepPending();
    this.dropPending(uid);
    let keyBytes = null;
    let agentAddress = null;
    for (let i = 0; i < 4 && !agentAddress; i++) {
      const buf = crypto.randomBytes(32);
      keyBytes = new Uint8Array(32);
      keyBytes.set(buf);
      buf.fill(0);
      try {
        agentAddress = String(this.makeSigner(keyBytes).address).toLowerCase(); // range-checked before any curve call
      } catch {
        keyBytes.fill(0); // out of [1, n−1] (≈ 2^-128): draw again
      }
    }
    if (!agentAddress) throw new ApiError(503, 'could not generate an API wallet', 'busy');
    try {
      const sealed = this.secrets.seal(uid, PENDING_AAD_ACCOUNT, agentAddress, keyBytes);
      const expiresMs = this.now() + ttlMs;
      this.pendingAgents.set(uid, { sealed, agentAddress, agentName, nonce, expiresMs });
      return { agentAddress, agentName, nonce, expiresMs };
    } finally {
      keyBytes.fill(0);
    }
  }

  /** The public facts of `uid`'s prepared agent, or null (none, or expired). */
  pendingAgent(uid) {
    this.#sweepPending();
    const p = this.pendingAgents.get(uid);
    return p ? { agentAddress: p.agentAddress, agentName: p.agentName, nonce: p.nonce, expiresMs: p.expiresMs } : null;
  }

  /** Run `fn(keyBytes)` with the prepared key (fresh bytes, zeroed in finally — the same rule as withSigner). */
  async withPendingKey(uid, fn) {
    this.#sweepPending();
    const p = this.pendingAgents.get(uid);
    if (!p) throw new ApiError(404, 'no API wallet is being prepared — start again', 'not_found');
    const keyBytes = this.secrets.open({
      user_id: uid, account_address: PENDING_AAD_ACCOUNT, agent_address: p.agentAddress, ...p.sealed,
    });
    try {
      return await fn(keyBytes);
    } finally {
      keyBytes.fill(0);
    }
  }

  /** Forget (and zero the sealed copy of) `uid`'s prepared agent. */
  dropPending(uid) {
    const p = this.pendingAgents.get(uid);
    if (!p) return;
    for (const k of ['key_ct', 'key_iv', 'key_tag']) p.sealed[k]?.fill?.(0);
    this.pendingAgents.delete(uid);
  }

  #sweepPending() {
    const t = this.now();
    for (const [uid, p] of this.pendingAgents) if (p.expiresMs <= t) this.dropPending(uid);
  }

  /**
   * The §6.7 step 8 conflicts, checked BEFORE anything irreversible (the wallet flow relays the approval first):
   * 409 already_connected / agent_in_use / account_in_use. A revoked/error row of another garden is no conflict (the
   * store() that follows takes it over).
   */
  assertConnectable(uid, accountAddress, agentAddress) {
    const own = this.#row(uid);
    if (own && (own.status === 'verified' || own.status === 'pending') && own.account_address !== accountAddress) {
      throw new ApiError(409, 'this garden is already connected to another testnet account — disconnect it first', 'already_connected');
    }
    for (const other of this.#st('byAgent').all(agentAddress)) {
      if (other.user_id !== uid && (other.status === 'verified' || other.status === 'pending')) {
        throw new ApiError(409, 'this API wallet is already connected to another garden', 'agent_in_use');
      }
    }
    for (const other of this.#st('byAccount').all(accountAddress)) {
      if (other.user_id !== uid && (other.status === 'verified' || other.status === 'pending')) {
        throw new ApiError(409, 'this testnet account is already connected to another garden', 'account_in_use');
      }
    }
  }

  #st(key) {
    return this.db.prepare(SQL[key]);
  }

  /** The raw row (with ciphertext columns): internal to this module and the repo's nonce statements. */
  #row(uid) {
    return this.#st('get').get(uid) ?? null;
  }

  /** TestnetLink of a player, or null when not connected. */
  link(uid) {
    return linkOf(this.#row(uid));
  }

  /**
   * Run `fn(signer)` with the player's agent signer (§5.1 "Use"). Throws ApiError 409 not_connected when there is no
   * live credential, and an error with code `key_unavailable` when it cannot be decrypted.
   */
  async withSigner(uid, fn) {
    if (!this.makeSigner) throw Object.assign(new Error('testnet signing is not configured'), { code: 'key_unavailable' });
    return this.#withKey(uid, (keyBytes) => fn(this.makeSigner(keyBytes)));
  }

  /**
   * testnet_verify only: WP2's verifyAgent derives the agent address from the key bytes (§6.7 steps 2–7), so the
   * stored key is handed to it for the duration of the call — the SAME single decrypt routine as withSigner
   * (fresh bytes, zeroed in finally, never cached or returned).
   */
  async verifyStored(uid, fn) {
    return this.#withKey(uid, fn);
  }

  /** The one decrypt routine: a fresh Uint8Array(32) for the duration of `fn`, zeroed in `finally` (§5.1). */
  async #withKey(uid, fn) {
    const row = this.#row(uid);
    if (!row || (row.status !== 'verified' && row.status !== 'pending')) {
      throw new ApiError(409, 'no testnet API wallet is connected', 'not_connected');
    }
    if (!this.secrets || typeof this.secrets.open !== 'function') {
      throw Object.assign(new Error('testnet signing is not configured'), { code: 'key_unavailable' });
    }
    const keyBytes = this.secrets.open(row); // a fresh Uint8Array(32)
    try {
      return await fn(keyBytes);
    } finally {
      keyBytes.fill(0);
    }
  }

  /** Verified credentials for WP2's MainnetRechecker: [{uid, agent_address, mainnet_checked_ms}]. */
  recheckRows() {
    return this.#st('recheckRows').all().map((r) => ({ uid: r.user_id, agent_address: r.agent_address, mainnet_checked_ms: r.mainnet_checked_ms ?? null }));
  }

  /**
   * Seal and store a verified agent key (§6.7 step 8), in ONE transaction:
   *   • the same garden on the same account → Replace API wallet (`replaced: true`; last_nonce restarts at 0, which is
   *     safe because nonces are per signer; value_at_connect and the connect time are kept);
   *   • the same garden on another live account → 409 already_connected;
   *   • another garden holds the agent / the account LIVE → 409 agent_in_use / account_in_use;
   *   • another garden holds a revoked/error row for the account → that row is wiped (take-over) and its uid is
   *     returned in `takeOver`, so the caller closes that garden's testnet bots in its books (account_moved).
   * `keyBytes` is sealed here and NOT zeroed (the caller owns it).
   * @returns {{ replaced: boolean, takeOver: number[], link: object }}
   */
  store({ uid, accountAddress, agentAddress, agentName = null, validUntilMs = null, abstraction = null,
    valueAtConnect = null, keyBytes, mainnetCheckedMs = null }) {
    if (!this.secrets || typeof this.secrets.seal !== 'function') {
      throw new ApiError(503, 'the testnet venue is not enabled on this server', 'testnet_disabled');
    }
    const now = this.now();
    const sealed = this.secrets.seal(uid, accountAddress, agentAddress, keyBytes);
    let replaced = false;
    const takeOver = [];
    this.db.tx(() => {
      const own = this.#row(uid);
      const ownLive = own && (own.status === 'verified' || own.status === 'pending');
      if (ownLive && own.account_address !== accountAddress) {
        throw new ApiError(409, 'this garden is already connected to another testnet account — disconnect it first', 'already_connected');
      }
      replaced = Boolean(ownLive && own.account_address === accountAddress);
      for (const other of this.#st('byAgent').all(agentAddress)) {
        if (other.user_id !== uid && (other.status === 'verified' || other.status === 'pending')) {
          throw new ApiError(409, 'this API wallet is already connected to another garden', 'agent_in_use');
        }
      }
      for (const other of this.#st('byAccount').all(accountAddress)) {
        if (other.user_id === uid) continue;
        if (other.status === 'verified' || other.status === 'pending') {
          throw new ApiError(409, 'this testnet account is already connected to another garden', 'account_in_use');
        }
        // An abandoned (revoked/error) row of another garden: take it over so fills are never attributed twice.
        this.#st('zero').run(now, other.user_id);
        this.#st('del').run(other.user_id);
        takeOver.push(other.user_id);
      }
      const keepValue = replaced && Number.isFinite(own.value_at_connect) ? own.value_at_connect : valueAtConnect;
      const createdMs = replaced ? own.created_ms : now;
      this.#st('upsert').run(
        uid, accountAddress, agentAddress, agentName, Number.isFinite(validUntilMs) ? Math.trunc(validUntilMs) : null,
        sealed.key_ct, sealed.key_iv, sealed.key_tag, sealed.key_id, sealed.enc_version ?? 1,
        abstraction, now, Number.isFinite(mainnetCheckedMs) ? Math.trunc(mainnetCheckedMs) : now,
        Number.isFinite(keepValue) ? keepValue : null, createdMs, now,
      );
    });
    if (takeOver.length) this.#checkpoint();
    return { replaced, takeOver, link: this.link(uid) };
  }

  /** Mark the credential revoked/error with a machine reason (the key stays sealed until a wipe). */
  setStatus(uid, status, reason = null) {
    this.#st('setStatus').run(status, reason, this.now(), uid);
  }

  /** testnet_verify refreshed the facts (§6.7 steps 3–7). */
  markVerified(uid, { validUntilMs = null, agentName = null, abstraction = null, mainnetCheckedMs = null } = {}) {
    const now = this.now();
    this.#st('setVerified').run(now, Number.isFinite(validUntilMs) ? Math.trunc(validUntilMs) : null, agentName, abstraction,
      Number.isFinite(mainnetCheckedMs) ? Math.trunc(mainnetCheckedMs) : now, now, uid);
  }

  setExpiryFlags(uid, flags) {
    this.#st('setFlags').run(flags | 0, this.now(), uid);
  }

  setMainnetChecked(uid, ms = this.now()) {
    this.#st('setMainnet').run(Math.trunc(ms), this.now(), uid);
  }

  /** Verified credentials whose mainnet re-check is due (older than `beforeMs`), oldest first. */
  dueMainnet(beforeMs, limit = 1) {
    return this.#st('dueMainnet').all(Math.trunc(beforeMs), Math.max(1, limit | 0));
  }

  /** Verified credentials whose API wallet expires before `untilMs`. */
  expiring(untilMs) {
    return this.#st('expiring').all(Math.trunc(untilMs));
  }

  verifiedCount() {
    return this.#st('verifiedCount').get()?.n ?? 0;
  }

  /**
   * Wipe the player's credential (§5.3 rule 9): zero the key columns, delete the row (or keep it `revoked` with
   * `keepRow`), then `PRAGMA wal_checkpoint(TRUNCATE)`. Uses WP1's wipeCredentials when available.
   * @returns {number} rows wiped
   */
  wipe(uid, { keepRow = false, reason = null } = {}) {
    if (this.wipeImpl) return this.wipeImpl(this.db, uid, { keepRow, reason, now: this.now });
    let n = 0;
    this.db.tx(() => {
      n = Number(this.#st('zero').run(this.now(), uid).changes);
      if (keepRow) this.#st('setStatus').run('revoked', reason, this.now(), uid);
      else this.#st('del').run(uid);
    });
    this.#checkpoint();
    return n;
  }

  #checkpoint() {
    try {
      if (typeof this.db.checkpoint === 'function') this.db.checkpoint();
      else this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } catch (err) {
      this.log(`[credentials] WAL checkpoint failed: ${err?.code || err?.name || 'error'}`);
    }
  }
}

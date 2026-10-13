// server/secrets.js — secrets at rest, derived keys, rotation and log redaction (PLATFORM.md §5).
//
// Master key: 32 random bytes (base64 / base64url), from BEAN_MASTER_KEY_FILE or BEAN_MASTER_KEY (server/config.js
// reads and deletes them). Required for testnet; otherwise the HMAC keys derive from a random 32-byte
// admin_state.audit_salt instead. Derived keys use HKDF-SHA256 (salt 'bean-garden/v1'):
//   credentials/hl_testnet → K_cred (AES-256-GCM, needs the master key)
//   audit/ip               → K_ip   (audit_log.ip_hash)
//   audit/name             → K_name (unknown usernames in login_fail rows)
//   auth/device            → K_dev  (known-device cookie MAC)
// Agent keys are sealed with AES-256-GCM, a fresh 12-byte iv per seal and an AAD that binds the ciphertext to its
// row ("cred|v1|<uid>|hl_testnet|<account>|<agent>"), so a ciphertext copied to another user or address fails.
// open() is the only decrypt path; it returns a fresh Uint8Array that the caller zeroes (withKey() does that).
// The key is never converted to a string here.
//
// Redaction (§5.3): sanitizeLogLine() is applied to every log line by makeSafeLogger(); sensitiveErrorLine() is the
// only thing a sensitive op's 500 may log.

import crypto from 'node:crypto';

const HKDF_SALT = Buffer.from('bean-garden/v1', 'utf8');
const KID_PREFIX = Buffer.from('bean-garden kid v1', 'utf8');
export const ENC_VERSION = 1;
const VENUE = 'hl_testnet';

// ---------------------------------------------------------------------------------------------
// Master keys

/**
 * Parse a master key: base64 or base64url of EXACTLY 32 bytes. Throws an Error that never contains the value.
 * @param {string} text
 * @param {string} [name]  the variable name for the message
 * @returns {Buffer}
 */
export function parseMasterKey(text, name = 'BEAN_MASTER_KEY') {
  const s = String(text ?? '').trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) throw new Error(`${name} must be base64 or base64url of exactly 32 random bytes (npm run keygen)`);
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(std, 'base64');
  // Strict: the text must be the canonical encoding of the bytes (Buffer.from silently skips junk).
  if (buf.length !== 32 || buf.toString('base64').replace(/=+$/, '') !== std.replace(/=+$/, '')) {
    buf.fill(0);
    throw new Error(`${name} must decode to exactly 32 bytes (npm run keygen)`);
  }
  return buf;
}

/** kid = hex(SHA-256("bean-garden kid v1" ‖ master))[0..16] (§5.1). */
export function keyId(master) {
  return crypto.createHash('sha256').update(KID_PREFIX).update(master).digest('hex').slice(0, 16);
}

function hkdf(ikm, info) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, HKDF_SALT, Buffer.from(info, 'utf8'), 32));
}

/** AAD binding a sealed key to its credentials row. Addresses are lower-case (normAddr) before they get here. */
export function credentialAad(uid, accountAddress, agentAddress) {
  return Buffer.from(`cred|v1|${uid}|${VENUE}|${accountAddress}|${agentAddress}`, 'utf8');
}

/**
 * Load (creating on first use) the random 32-byte audit salt in admin_state (§5.1). Without a master key, the HMAC
 * keys derive from it, so pseudonymous audit hashes stay stable across restarts.
 * @param {import('./db/db.js').Db} db
 * @returns {Buffer}
 */
export function loadAuditSalt(db, now = Date.now) {
  const row = db.prepare("SELECT value_json FROM admin_state WHERE key = 'audit_salt'").get();
  if (row) {
    const salt = Buffer.from(JSON.parse(row.value_json), 'base64');
    if (salt.length === 32) return salt;
  }
  const salt = crypto.randomBytes(32);
  db.prepare(`INSERT INTO admin_state (key, value_json, updated_ms, updated_by) VALUES ('audit_salt', ?, ?, NULL)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_ms = excluded.updated_ms`)
    .run(JSON.stringify(salt.toString('base64')), now());
  return salt;
}

export class Secrets {
  /**
   * @param {object} opts
   * @param {Buffer|null} [opts.masterKey]  32 bytes, or null (no testnet; HMACs from auditSalt)
   * @param {Buffer[]} [opts.oldKeys]       previous master keys (P1 re-seal at boot, §5.2)
   * @param {Buffer|null} [opts.auditSalt]  admin_state.audit_salt (required when masterKey is null)
   */
  constructor({ masterKey = null, oldKeys = [], auditSalt = null } = {}) {
    if (masterKey !== null && (!Buffer.isBuffer(masterKey) || masterKey.length !== 32)) {
      throw new TypeError('Secrets: masterKey must be a 32-byte Buffer or null');
    }
    const ikm = masterKey ?? auditSalt;
    if (!ikm || ikm.length !== 32) throw new TypeError('Secrets: an audit salt is required without a master key');
    // Private, non-enumerable state: a stray JSON.stringify / console.log of this object shows nothing.
    const hidden = {
      cred: masterKey ? hkdf(masterKey, 'credentials/hl_testnet') : null,
      ip: hkdf(ikm, 'audit/ip'),
      name: hkdf(ikm, 'audit/name'),
      dev: hkdf(ikm, 'auth/device'),
      old: new Map(oldKeys.map((k) => [keyId(k), hkdf(k, 'credentials/hl_testnet')])),
    };
    Object.defineProperty(this, '_k', { value: hidden, enumerable: false });
    /** kid of the current master key, or null without one. */
    this.kid = masterKey ? keyId(masterKey) : null;
    Object.freeze(this);
  }

  /** True when agent keys can be sealed/opened (a master key is configured). */
  get canSeal() {
    return this._k.cred !== null;
  }

  /**
   * Seal a 32-byte agent key for its row.
   * @returns {{key_ct: Buffer, key_iv: Buffer, key_tag: Buffer, key_id: string, enc_version: number}}
   */
  seal(uid, accountAddress, agentAddress, keyBytes) {
    if (!this._k.cred) throw new Error('secrets: no master key configured (BEAN_MASTER_KEY_FILE)');
    if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) throw new TypeError('secrets: key must be 32 bytes');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._k.cred, iv);
    cipher.setAAD(credentialAad(uid, accountAddress, agentAddress));
    const ct = Buffer.concat([cipher.update(keyBytes), cipher.final()]);
    return { key_ct: ct, key_iv: iv, key_tag: cipher.getAuthTag(), key_id: this.kid, enc_version: ENC_VERSION };
  }

  /**
   * Open a credentials row (needs user_id, account_address, agent_address, key_ct, key_iv, key_tag, key_id).
   * Returns a FRESH Uint8Array(32); the caller must `.fill(0)` it when done (or use withKey()). Throws on a foreign
   * kid ('key_unavailable'), a tampered or moved ciphertext, or a wrong master key.
   * @returns {Uint8Array}
   */
  open(row) {
    const key = row.key_id === this.kid ? this._k.cred : this._k.old.get(row.key_id);
    if (!key) throw Object.assign(new Error('secrets: no key for this credential (key_unavailable)'), { code: 'key_unavailable' });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.key_iv));
    decipher.setAAD(credentialAad(row.user_id, row.account_address, row.agent_address));
    decipher.setAuthTag(Buffer.from(row.key_tag));
    const out = new Uint8Array(32);
    let a;
    let b;
    try {
      a = decipher.update(Buffer.from(row.key_ct));
      b = decipher.final();
    } catch {
      out.fill(0);
      throw Object.assign(new Error('secrets: credential failed authentication'), { code: 'key_unavailable' });
    }
    if (a.length + b.length !== 32) {
      a.fill(0);
      b.fill(0);
      throw Object.assign(new Error('secrets: bad credential length'), { code: 'key_unavailable' });
    }
    out.set(a, 0);
    out.set(b, a.length);
    a.fill(0);
    b.fill(0);
    return out;
  }

  /** Open, run `fn(keyBytes)`, and zero the bytes in `finally` (never cached across calls, §5.1). */
  async withKey(row, fn) {
    const bytes = this.open(row);
    try {
      return await fn(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  /** HMAC(K_name, canonical username) → first 16 hex (login_fail target for unknown names: "h:" + this). */
  hmacName(canonical) {
    return crypto.createHmac('sha256', this._k.name).update(String(canonical), 'utf8').digest('hex').slice(0, 16);
  }

  /** HMAC(K_ip, ip prefix) → first 16 hex (audit_log.ip_hash). */
  hmacIp(prefix) {
    return crypto.createHmac('sha256', this._k.ip).update(String(prefix), 'utf8').digest('hex').slice(0, 16);
  }

  /** K_dev, the known-device cookie MAC key (a copy). */
  get deviceKey() {
    return Buffer.from(this._k.dev);
  }

  /** MAC for the known-device cookie (§4.2): b64url HMAC-SHA256(K_dev, uid ‖ expires_ms ‖ pw_changed_ms). */
  deviceMac(uid, expiresMs, pwChangedMs) {
    return crypto.createHmac('sha256', this._k.dev).update(`${uid}|${expiresMs}|${pwChangedMs}`, 'utf8').digest('base64url');
  }

  /**
   * Boot step for master-key rotation (§5.2): every live credential whose kid is not the current one is re-sealed
   * with the matching old key (P1) or, when none matches, marked status='error', status_reason='key_unavailable'
   * (P0). One transaction. Logs counts only.
   * @returns {{resealed: number, unavailable: number}}
   */
  applyRotation(db, { now = Date.now, log = () => {} } = {}) {
    // Without a master key nothing can be re-sealed, and testnet is off: leave the rows for when the key returns.
    if (!this.kid) return { resealed: 0, unavailable: 0 };
    const rows = db.prepare(`SELECT user_id, venue, account_address, agent_address, key_ct, key_iv, key_tag, key_id FROM credentials
      WHERE status IN ('pending','verified') AND key_id IS NOT ?`).all(this.kid);
    if (rows.length === 0) return { resealed: 0, unavailable: 0 };
    let resealed = 0;
    let unavailable = 0;
    db.tx(() => {
      for (const row of rows) {
        let bytes = null;
        try {
          if (this.canSeal && this._k.old.has(row.key_id)) bytes = this.open(row);
        } catch {
          bytes = null;
        }
        if (bytes) {
          const s = this.seal(row.user_id, row.account_address, row.agent_address, bytes);
          bytes.fill(0);
          db.prepare(`UPDATE credentials SET key_ct = ?, key_iv = ?, key_tag = ?, key_id = ?, enc_version = ?, updated_ms = ?
            WHERE user_id = ? AND venue = ?`).run(s.key_ct, s.key_iv, s.key_tag, s.key_id, s.enc_version, now(), row.user_id, row.venue);
          resealed += 1;
        } else {
          db.prepare("UPDATE credentials SET status = 'error', status_reason = 'key_unavailable', updated_ms = ? WHERE user_id = ? AND venue = ?")
            .run(now(), row.user_id, row.venue);
          unavailable += 1;
        }
      }
    });
    if (resealed) log(`[secrets] re-sealed ${resealed} credential(s) under kid ${this.kid}`);
    if (unavailable) log(`[secrets] ${unavailable} credential(s) sealed under an unknown key: marked key_unavailable (players must reconnect)`);
    return { resealed, unavailable };
  }
}

/**
 * Wipe a user's stored agent key(s) (§5.3 rule 9): overwrite key_ct/iv/tag with zero bytes, then delete the row
 * (or keep it as status 'revoked' with `keepRow`), then `PRAGMA wal_checkpoint(TRUNCATE)` so the old pages leave
 * bean.db-wal at once (`secure_delete` zeroes the freed pages in the DB file). Backups still hold sealed copies for
 * their retention period, which the UI states.
 * @returns {number} rows wiped
 */
export function wipeCredentials(db, uid, { keepRow = false, reason = null, now = Date.now } = {}) {
  let n = 0;
  db.tx(() => {
    n = Number(db.prepare(`UPDATE credentials SET key_ct = zeroblob(32), key_iv = zeroblob(12), key_tag = zeroblob(16),
      updated_ms = ? WHERE user_id = ?`).run(now(), uid).changes);
    if (keepRow) {
      db.prepare("UPDATE credentials SET status = 'revoked', status_reason = ? WHERE user_id = ?").run(reason, uid);
    } else {
      db.prepare('DELETE FROM credentials WHERE user_id = ?').run(uid);
    }
  });
  if (!db.inTransaction) db.checkpoint();
  return n;
}

// ---------------------------------------------------------------------------------------------
// Log redaction (§5.3 rule 4)

/** Allowlisted spans (restored after redaction): lower-case addresses and values of hash / cloid / oid fields. */
const ALLOW_ADDR = /0x[0-9a-f]{40}(?![0-9a-fA-F])/g;
const ALLOW_FIELD = /(\b(?:hash|cloid|oid)\b["']?\s*[:=]\s*["']?)(0x[0-9a-fA-F]+|\d+)/g;

const HEX64 = /\b(0x)?[0-9a-fA-F]{64,}\b/g; // 64+ (a superset of the spec's exactly-64: longer hex runs too)
const B64 = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
const DEC = /\b\d{60,}\b/g;
const WORDS = /\b(?:[a-z]{3,8}[\s,.;:|\-\d]+){11,23}[a-z]{3,8}\b/gi;

function looksB64(run) {
  return run[0] !== '/' && /\d/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run);
}

/**
 * Redact key-shaped substrings from one log line: 64-hex runs → [hex64], base64 runs ≥ 40 chars (with a digit, an
 * upper- and a lower-case letter, not starting with '/') → [b64], decimal runs ≥ 60 digits → [dec], seed-phrase
 * shapes (12–24 words, any case, numbered or punctuated) → [words]. Lower-case 0x addresses and the values of
 * fields named hash / cloid / oid are kept. False positives only redact log text, which is safe.
 */
export function sanitizeLogLine(line) {
  let s = typeof line === 'string' ? line : String(line);
  const kept = [];
  const hold = (m) => {
    kept.push(m);
    return `\u0000${kept.length - 1}\u0000`;
  };
  s = s.replace(ALLOW_FIELD, (_, label, value) => `${label}${hold(value)}`);
  s = s.replace(ALLOW_ADDR, hold);
  s = s.replace(HEX64, '[hex64]');
  s = s.replace(B64, (run) => (looksB64(run) ? '[b64]' : run));
  s = s.replace(DEC, '[dec]');
  s = s.replace(WORDS, '[words]');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
}

/**
 * Wrap a line logger so EVERY line passes the sanitizer (§5.3, §10.6). With format 'json' each line becomes
 * {t, level, msg, ...fields} (LOG_FORMAT=json); `fields` values are sanitized too.
 * @param {(line: string) => void} sink
 * @param {{format?: 'text'|'json', now?: () => number}} [opts]
 * @returns {(line: string, fields?: object) => void}
 */
export function makeSafeLogger(sink, { format = 'text', now = Date.now } = {}) {
  return (line, fields = null) => {
    const msg = sanitizeLogLine(line);
    if (format !== 'json') {
      sink(msg);
      return;
    }
    const level = /^\[?(?:alert|error|fatal)/i.test(msg) || /\balert\b/.test(msg) ? 'error' : 'info';
    const out = { t: new Date(now()).toISOString(), level, msg };
    if (fields && typeof fields === 'object') {
      for (const [k, v] of Object.entries(fields)) {
        if (k in out) continue;
        out[k] = typeof v === 'string' ? sanitizeLogLine(v) : v;
      }
    }
    sink(sanitizeLogLine(JSON.stringify(out)));
  };
}

/**
 * The only line a sensitive op's internal error (500) may log (§5.3 rule 1): the op, err.name and a code — no
 * message, no stack (either could carry a key or a password).
 */
export function sensitiveErrorLine(op, err) {
  const name = typeof err?.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error';
  const code = typeof err?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(err.code) ? err.code : 'internal';
  return `[api] ${String(op).replace(/[^a-z0-9_]/gi, '')} → 500 internal error (${name}, ${code})`;
}

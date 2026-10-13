// server/hl/signing.js — L1 action signing for Hyperliquid TESTNET (PLATFORM §6.4), byte-exact with the official SDK.
//
//   connectionId = keccak256( msgpack(action) ‖ u64be(nonce) ‖ 0x00 )          (no vault, no expiresAfter)
//   phantom agent = { source: "b", connectionId }                                ("b" = testnet, hard-coded)
//   digest = keccak256( 0x19 0x01 ‖ domainSeparator(Exchange, 1, 1337, 0x0) ‖ hashStruct(Agent) )
//   signature = secp256k1 RFC 6979 deterministic, low-s; v = 27 + recovery
//
// There is deliberately NO way to produce a mainnet ("a") signature: `signL1(action, nonce)` takes exactly two
// arguments and no function in this module accepts a network flag (§1.2 rule 4, T-GUARD f).
//
// Key hygiene (§5.1, §5.3): `makeSigner(keyBytes)` keeps a REFERENCE to the caller's Uint8Array — it never copies the
// key, never turns it into a string — so the caller's `keyBytes.fill(0)` in `finally` destroys it (a destroyed signer
// refuses to sign). The scalar range check `isValidScalar` is our own BigInt comparison that runs before any noble
// call, because noble's range errors render the value in decimal.

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

import { L1_DOMAIN, PHANTOM_SOURCE, USER_SIGNED_DOMAIN_NAME } from './constants.js';
import { packAction } from './msgpack.js';

/** secp256k1 group order n. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const enc = new TextEncoder();
const keccak = (bytes) => keccak_256(bytes);
const keccakStr = (s) => keccak_256(enc.encode(s));

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
/** Uint8Array → lower-case hex (no 0x). */
export function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

function hexToBytes(hex) {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new SigningError('bad hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** BigInt → 32-byte big-endian. */
function u256be(x) {
  const v = BigInt(x);
  if (v < 0n || v >= 1n << 256n) throw new SigningError('u256 out of range');
  return hexToBytes(v.toString(16).padStart(64, '0'));
}

/** Safe non-negative integer → 8-byte big-endian. */
export function u64be(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new SigningError('nonce must be a safe non-negative integer');
  return hexToBytes(BigInt(n).toString(16).padStart(16, '0'));
}

const hex64 = (big) => big.toString(16).padStart(64, '0');

/** A signing failure. Messages never contain key material, signatures or request bodies. */
export class SigningError extends Error {
  constructor(message, code = 'signing_error') {
    super(message);
    this.name = 'SigningError';
    this.code = code;
  }
}

// ---- EIP-712 building blocks --------------------------------------------------------------------------------------

const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
const DOMAIN_TYPEHASH = keccakStr(DOMAIN_TYPE);

function domainSeparator(name, version, chainId, verifyingContract) {
  return keccak(concat(
    DOMAIN_TYPEHASH,
    keccakStr(name),
    keccakStr(version),
    u256be(chainId),
    u256be(BigInt(verifyingContract)),
  ));
}

const L1_DOMAIN_SEPARATOR = domainSeparator(L1_DOMAIN.name, L1_DOMAIN.version, L1_DOMAIN.chainId, L1_DOMAIN.verifyingContract);
const AGENT_TYPEHASH = keccakStr('Agent(string source,bytes32 connectionId)');
const SOURCE_HASH = keccakStr(PHANTOM_SOURCE);

/** KAT-D1 / KAT-D2 (hex with 0x), exported for the tests. */
export const L1_DOMAIN_SEPARATOR_HEX = `0x${toHex(L1_DOMAIN_SEPARATOR)}`;
export const AGENT_TYPEHASH_HEX = `0x${toHex(AGENT_TYPEHASH)}`;

const eip712Digest = (separator, structHash) => keccak(concat(new Uint8Array([0x19, 0x01]), separator, structHash));

// ---- L1 actions ---------------------------------------------------------------------------------------------------

/**
 * The action hash (connectionId): keccak256(msgpack(action) ‖ u64be(nonce) ‖ 0x00). Always "no vault" and no
 * expiresAfter — this code never trades for a vault or sub-account.
 * @returns {Uint8Array} 32 bytes
 */
export function actionHash(action, nonce) {
  return keccak(concat(packAction(action), u64be(nonce), new Uint8Array([0x00])));
}

/** EIP-712 digest of the testnet phantom agent {source:"b", connectionId}. */
export function agentDigest(connectionId) {
  if (!(connectionId instanceof Uint8Array) || connectionId.length !== 32) throw new SigningError('connectionId must be 32 bytes');
  const structHash = keccak(concat(AGENT_TYPEHASH, SOURCE_HASH, connectionId));
  return eip712Digest(L1_DOMAIN_SEPARATOR, structHash);
}

/** Own BigInt range check: a 32-byte Uint8Array whose big-endian value is in [1, n−1]. Never calls noble. */
export function isValidScalar(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return false;
  let v = 0n;
  for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(bytes[i]);
  return v >= 1n && v < SECP256K1_N;
}

function addressFromPublicKey(uncompressed) {
  // uncompressed = 0x04 ‖ X(32) ‖ Y(32); address = last 20 bytes of keccak(X ‖ Y)
  return `0x${toHex(keccak(uncompressed.subarray(1)).subarray(12))}`;
}

/** The lower-case 0x address of a private key (checked by isValidScalar first). */
export function addressOf(privKeyBytes) {
  if (!isValidScalar(privKeyBytes)) throw new SigningError('invalid private key', 'bad_key_format');
  return addressFromPublicKey(secp256k1.getPublicKey(privKeyBytes, false));
}

/** Parse `{r, s, v}` (r/s hex strings of any length up to 64 digits, v 27|28) → noble signature + recovery bit. */
function parseSig(sig) {
  if (!sig || typeof sig !== 'object') throw new SigningError('signature must be an object');
  const { r, s, v } = sig;
  const hexRe = /^0x[0-9a-fA-F]{1,64}$/;
  if (typeof r !== 'string' || typeof s !== 'string' || !hexRe.test(r) || !hexRe.test(s)) throw new SigningError('signature r/s must be 0x hex');
  if (v !== 27 && v !== 28) throw new SigningError('signature v must be 27 or 28');
  const rb = BigInt(r);
  const sb = BigInt(s);
  if (rb < 1n || rb >= SECP256K1_N || sb < 1n || sb >= SECP256K1_N) throw new SigningError('signature r/s out of range');
  return new secp256k1.Signature(rb, sb).addRecoveryBit(v - 27);
}

/** Recover the signer address of a 32-byte digest. */
export function recoverDigest(digest, sig) {
  return addressFromPublicKey(parseSig(sig).recoverPublicKey(digest).toRawBytes(false));
}

/** Recover the address that signed an L1 action on TESTNET (source "b"). */
export function recoverL1(action, nonce, sig) {
  return recoverDigest(agentDigest(actionHash(action, nonce)), sig);
}

/**
 * A testnet-only L1 signer over the caller's key bytes (kept by reference, never copied).
 * @param {Uint8Array} privKeyBytes  32 bytes; the caller zeroes it when done (`fill(0)`)
 * @returns {{address: string, signL1: (action: object, nonce: number) => {r: string, s: string, v: number}}}
 */
export function makeSigner(privKeyBytes) {
  const key = privKeyBytes;
  const address = addressOf(key);
  function signL1(action, nonce) {
    // A zeroed (destroyed) key fails the range check; noble is never reached with it.
    if (!isValidScalar(key)) throw new SigningError('signer key is no longer available', 'signer_destroyed');
    const digest = agentDigest(actionHash(action, nonce));
    const sig = secp256k1.sign(digest, key, { lowS: true });
    const out = { r: `0x${hex64(sig.r)}`, s: `0x${hex64(sig.s)}`, v: 27 + sig.recovery };
    // Self-check (§6.4 step 8): guards curve and recovery-bit bugs only — never payload bugs.
    if (recoverDigest(digest, out) !== address) throw new SigningError('signature self-check failed', 'signing_selfcheck');
    return out;
  }
  return Object.freeze({ address, signL1 });
}

// ---- User-signed actions (P1, §6.10; KAT-U1) ---------------------------------------------------------------------

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function encodeField(type, value, name) {
  switch (type) {
    case 'string':
      if (typeof value !== 'string') throw new SigningError(`${name}: expected string`);
      return keccakStr(value);
    case 'address':
      if (typeof value !== 'string' || !ADDR_RE.test(value)) throw new SigningError(`${name}: expected address`);
      return u256be(BigInt(value));
    case 'bool':
      if (typeof value !== 'boolean') throw new SigningError(`${name}: expected bool`);
      return u256be(value ? 1n : 0n);
    case 'bytes32': {
      const b = typeof value === 'string' ? hexToBytes(value) : value;
      if (!(b instanceof Uint8Array) || b.length !== 32) throw new SigningError(`${name}: expected bytes32`);
      return b;
    }
    default: {
      const m = /^uint(\d+)$/.exec(type);
      if (m) {
        const bits = Number(m[1]);
        let v;
        if (typeof value === 'number') {
          if (!Number.isSafeInteger(value) || value < 0) throw new SigningError(`${name}: expected a safe unsigned integer`);
          v = BigInt(value);
        } else if (typeof value === 'bigint') v = value;
        else if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) v = BigInt(value);
        else throw new SigningError(`${name}: expected uint`);
        if (v < 0n || v >= 1n << BigInt(bits)) throw new SigningError(`${name}: out of range`);
        return u256be(v);
      }
      throw new SigningError(`${name}: unsupported EIP-712 type ${type}`);
    }
  }
}

/**
 * EIP-712 digest of a flat user-signed Hyperliquid action in the `HyperliquidSignTransaction` domain.
 * @param {string} primaryType  e.g. 'HyperliquidTransaction:ApproveAgent'
 * @param {{name: string, type: string}[]} types  the struct fields, in order
 * @param {object} message
 * @param {number} chainId  the wallet's chain id as an INTEGER (signatureChainId is its hex string)
 */
export function userSignedDigest(primaryType, types, message, chainId) {
  if (typeof primaryType !== 'string' || !Array.isArray(types) || types.length === 0) throw new SigningError('bad typed data');
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new SigningError('chainId must be a positive integer');
  const typeString = `${primaryType}(${types.map((f) => `${f.type} ${f.name}`).join(',')})`;
  const fields = types.map((f) => encodeField(f.type, message?.[f.name], f.name));
  const structHash = keccak(concat(keccakStr(typeString), ...fields));
  const separator = domainSeparator(USER_SIGNED_DOMAIN_NAME, '1', chainId, '0x0000000000000000000000000000000000000000');
  return eip712Digest(separator, structHash);
}

/** Recover the signer of a user-signed action (P1 approveAgent relay check, §6.10 step 3.2). */
export function recoverUserSigned(primaryType, types, message, chainId, sig) {
  return recoverDigest(userSignedDigest(primaryType, types, message, chainId), sig);
}

/** Split a 65-byte `0x` wallet signature (r ‖ s ‖ v) into `{r, s, v}` with v ∈ {27, 28}. */
export function splitSignature(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(hex)) throw new SigningError('signature must be 65 bytes of 0x hex');
  const r = `0x${hex.slice(2, 66).toLowerCase()}`;
  const s = `0x${hex.slice(66, 130).toLowerCase()}`;
  let v = parseInt(hex.slice(130, 132), 16);
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) throw new SigningError('signature v must be 27 or 28');
  return { r, s, v };
}

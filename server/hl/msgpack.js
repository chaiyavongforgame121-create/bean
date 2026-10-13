// server/hl/msgpack.js — msgpack encoding of L1 actions, with guards (PLATFORM §6.4 step 1).
//
// The action hash is keccak256(msgpack(action) ‖ nonce ‖ vault byte), and Hyperliquid re-serializes the action it
// parsed from our JSON before it recovers the signer. Any difference between what we hash and what the exchange
// hashes — a map key in another order, a float where a string belongs, "1670.10" instead of "1670.1" — recovers a
// different (foreign) address. Local recovery cannot catch that (it re-hashes our own bytes), so the encoder refuses
// every shape that could drift:
//   • `undefined` anywhere (it would silently encode as nil);
//   • non-integer, negative or unsafe numbers, NaN/Infinity, and BigInt (prices and sizes are strings);
//   • anything that is not a plain object, array, string, boolean, null or safe non-negative integer;
//   • for the action types we build (order, updateLeverage, cancelByCloid): the exact key order of §6.2, the value
//     types, and canonical decimal strings (no trailing zeros, no exponent).
// Other action types (the SDK's KAT-only `dummy` / `scheduleCancel`) get the generic value guards only; whether a
// type may be SENT is decided by the allowlist in exchange.js, not here.
//
// Encoding: @msgpack/msgpack@2.8.0 `encode` with its defaults (sortKeys:false, forceFloat32:false,
// ignoreUndefined:false): keys in insertion order, smallest unsigned int forms (fixint, 0xcc/0xcd/0xce/0xcf),
// fixstr/str8, fixarray, fixmap — byte-identical to the Python SDK's `msgpack.packb` for these shapes (KAT-M1/M3).

import { encode } from '@msgpack/msgpack';

/** A shape the encoder refuses. `path` names the offending field (never a value). */
export class PackError extends Error {
  constructor(message, path = '') {
    super(`packAction: ${message}${path ? ` at ${path}` : ''}`);
    this.name = 'PackError';
    this.code = 'pack_guard';
    this.path = path;
  }
}

/** A canonical decimal wire string: no sign, no exponent, no leading zeros, no trailing fractional zeros. */
export const WIRE_DECIMAL_RE = /^(0|[1-9]\d*)(\.\d*[1-9])?$/;
const CLOID_RE = /^0x[0-9a-f]{32}$/;
const TIFS = new Set(['Alo', 'Ioc', 'Gtc']);
const GROUPINGS = new Set(['na', 'normalTpsl', 'positionTpsl']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Generic value guards, recursively. */
function guardValue(v, path) {
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isInteger(v)) throw new PackError('non-integer number (prices and sizes must be strings)', path);
      if (v < 0) throw new PackError('negative integer', path);
      if (v > Number.MAX_SAFE_INTEGER) throw new PackError('integer above MAX_SAFE_INTEGER', path);
      return;
    case 'undefined':
      throw new PackError('undefined value', path);
    case 'bigint':
      throw new PackError('BigInt value', path);
    case 'object':
      if (v === null) return;
      if (Array.isArray(v)) {
        v.forEach((x, i) => guardValue(x, `${path}[${i}]`));
        return;
      }
      if (!isPlainObject(v)) throw new PackError('non-plain object', path);
      for (const k of Object.keys(v)) guardValue(v[k], path ? `${path}.${k}` : k);
      return;
    default:
      throw new PackError(`unsupported ${typeof v}`, path);
  }
}

function keysExactly(obj, keys, path) {
  if (!isPlainObject(obj)) throw new PackError('expected an object', path);
  const got = Object.keys(obj);
  if (got.length !== keys.length || got.some((k, i) => k !== keys[i])) {
    throw new PackError(`key order must be ${keys.join(',')}`, path);
  }
}

const isUInt = (v) => Number.isSafeInteger(v) && v >= 0;

function guardWireDecimal(v, path) {
  if (typeof v !== 'string' || !WIRE_DECIMAL_RE.test(v)) throw new PackError('expected a canonical decimal string', path);
}

function guardOrderType(t, path) {
  if (!isPlainObject(t)) throw new PackError('expected an order type object', path);
  const keys = Object.keys(t);
  if (keys.length === 1 && keys[0] === 'limit') {
    keysExactly(t.limit, ['tif'], `${path}.limit`);
    if (!TIFS.has(t.limit.tif)) throw new PackError('unknown tif', `${path}.limit.tif`);
    return;
  }
  if (keys.length === 1 && keys[0] === 'trigger') {
    // SDK order_type_to_wire: isMarket, triggerPx, tpsl — in this order.
    keysExactly(t.trigger, ['isMarket', 'triggerPx', 'tpsl'], `${path}.trigger`);
    if (typeof t.trigger.isMarket !== 'boolean') throw new PackError('isMarket must be boolean', `${path}.trigger.isMarket`);
    guardWireDecimal(t.trigger.triggerPx, `${path}.trigger.triggerPx`);
    if (t.trigger.tpsl !== 'tp' && t.trigger.tpsl !== 'sl') throw new PackError('tpsl must be tp|sl', `${path}.trigger.tpsl`);
    return;
  }
  throw new PackError('order type must be {limit} or {trigger}', path);
}

function guardOrderWire(o, path) {
  const keys = isPlainObject(o) && 'c' in o ? ['a', 'b', 'p', 's', 'r', 't', 'c'] : ['a', 'b', 'p', 's', 'r', 't'];
  keysExactly(o, keys, path);
  if (!isUInt(o.a)) throw new PackError('asset must be a non-negative integer', `${path}.a`);
  if (typeof o.b !== 'boolean') throw new PackError('b must be boolean', `${path}.b`);
  guardWireDecimal(o.p, `${path}.p`);
  guardWireDecimal(o.s, `${path}.s`);
  if (typeof o.r !== 'boolean') throw new PackError('r must be boolean', `${path}.r`);
  guardOrderType(o.t, `${path}.t`);
  if ('c' in o && (typeof o.c !== 'string' || !CLOID_RE.test(o.c))) throw new PackError('cloid must be 0x + 32 lower-case hex', `${path}.c`);
}

/** Per-type schemas for every action type this code builds (§6.2). */
const SCHEMAS = {
  order(a) {
    keysExactly(a, ['type', 'orders', 'grouping'], '');
    if (!Array.isArray(a.orders) || a.orders.length === 0) throw new PackError('orders must be a non-empty array', 'orders');
    a.orders.forEach((o, i) => guardOrderWire(o, `orders[${i}]`));
    if (!GROUPINGS.has(a.grouping)) throw new PackError('unknown grouping', 'grouping');
  },
  updateLeverage(a) {
    keysExactly(a, ['type', 'asset', 'isCross', 'leverage'], '');
    if (!isUInt(a.asset)) throw new PackError('asset must be a non-negative integer', 'asset');
    if (typeof a.isCross !== 'boolean') throw new PackError('isCross must be boolean', 'isCross');
    if (!isUInt(a.leverage) || a.leverage < 1) throw new PackError('leverage must be an integer ≥ 1', 'leverage');
  },
  cancelByCloid(a) {
    keysExactly(a, ['type', 'cancels'], '');
    if (!Array.isArray(a.cancels) || a.cancels.length === 0) throw new PackError('cancels must be a non-empty array', 'cancels');
    a.cancels.forEach((c, i) => {
      keysExactly(c, ['asset', 'cloid'], `cancels[${i}]`);
      if (!isUInt(c.asset)) throw new PackError('asset must be a non-negative integer', `cancels[${i}].asset`);
      if (typeof c.cloid !== 'string' || !CLOID_RE.test(c.cloid)) throw new PackError('cloid must be 0x + 32 lower-case hex', `cancels[${i}].cloid`);
    });
  },
};

/** True when packAction knows a key-order schema for this action type. */
export function hasSchema(type) {
  return Object.prototype.hasOwnProperty.call(SCHEMAS, type);
}

/**
 * msgpack bytes of an L1 action, after the guards above.
 * @param {object} action  e.g. {type:'order', orders:[…], grouping:'na'}
 * @returns {Uint8Array}
 */
export function packAction(action) {
  if (!isPlainObject(action)) throw new PackError('action must be a plain object');
  if (Object.keys(action)[0] !== 'type' || typeof action.type !== 'string') throw new PackError('the first key must be a string "type"');
  guardValue(action, '');
  if (hasSchema(action.type)) SCHEMAS[action.type](action);
  return encode(action);
}

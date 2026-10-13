// server/hl/wire.js — action builders in the EXACT key order the exchange re-serializes (PLATFORM §6.2, §6.4).
//
// Map keys are emitted by msgpack in JS insertion order, so these builders are the single place that decides it:
//   updateLeverage  {"type","asset","isCross","leverage"}
//   order           {"type","orders":[{"a","b","p","s","r","t":{"limit":{"tif"}},"c"}],"grouping"}
//   cancelByCloid   {"type","cancels":[{"asset","cloid"}]}                               (P1)
//   trigger (P1)    "t":{"trigger":{"isMarket","triggerPx","tpsl"}}, "r":true, grouping "positionTpsl"
// Prices and sizes are wire STRINGS made by format.js (a float in an action is a bug); ints are JSON numbers.

import { randomBytes } from 'node:crypto';

import { WIRE_DECIMAL_RE } from './msgpack.js';

const CLOID_RE = /^0x[0-9a-f]{32}$/;
const TIFS = new Set(['Alo', 'Ioc', 'Gtc']);

/** A builder refused its input (a programming error, never user data). */
export class WireError extends Error {
  constructor(message) {
    super(`wire: ${message}`);
    this.name = 'WireError';
    this.code = 'wire_guard';
  }
}

const isUInt = (v) => Number.isSafeInteger(v) && v >= 0;

/** A fresh client order id: 16 random bytes, lower-case hex (§6.6). Never derived from a row id. */
export function newCloid() {
  return `0x${randomBytes(16).toString('hex')}`;
}

/** True for `0x` + 32 lower-case hex. */
export function isCloid(s) {
  return typeof s === 'string' && CLOID_RE.test(s);
}

/**
 * One order wire.
 * @param {object} o
 * @param {number} o.asset        testnet asset index
 * @param {boolean} o.isBuy
 * @param {string} o.px           wire price (fmtPxWire)
 * @param {string} o.sz           wire size (fmtSzWire)
 * @param {boolean} o.reduceOnly
 * @param {'Ioc'|'Gtc'|'Alo'} [o.tif='Ioc']
 * @param {string} [o.cloid]      0x + 32 hex; every testnet order of ours carries one
 * @param {{isMarket: boolean, triggerPx: string, tpsl: 'tp'|'sl'}} [o.trigger]  P1 TP/SL instead of a limit tif
 */
export function orderWire({ asset, isBuy, px, sz, reduceOnly, tif = 'Ioc', cloid, trigger } = {}) {
  if (!isUInt(asset)) throw new WireError('asset must be a non-negative integer');
  if (typeof isBuy !== 'boolean') throw new WireError('isBuy must be boolean');
  if (typeof px !== 'string' || !WIRE_DECIMAL_RE.test(px) || !(Number(px) > 0)) throw new WireError('px must be a positive canonical wire string');
  if (typeof sz !== 'string' || !WIRE_DECIMAL_RE.test(sz) || !(Number(sz) > 0)) throw new WireError('sz must be a positive canonical wire string');
  if (typeof reduceOnly !== 'boolean') throw new WireError('reduceOnly must be boolean');
  let t;
  if (trigger !== undefined) {
    const { isMarket, triggerPx, tpsl } = trigger ?? {};
    if (typeof isMarket !== 'boolean') throw new WireError('trigger.isMarket must be boolean');
    if (typeof triggerPx !== 'string' || !WIRE_DECIMAL_RE.test(triggerPx)) throw new WireError('trigger.triggerPx must be a wire string');
    if (tpsl !== 'tp' && tpsl !== 'sl') throw new WireError('trigger.tpsl must be tp|sl');
    t = { trigger: { isMarket, triggerPx, tpsl } };
  } else {
    if (!TIFS.has(tif)) throw new WireError('tif must be Ioc|Gtc|Alo');
    t = { limit: { tif } };
  }
  const w = { a: asset, b: isBuy, p: px, s: sz, r: reduceOnly, t };
  if (cloid !== undefined && cloid !== null) {
    if (!isCloid(cloid)) throw new WireError('cloid must be 0x + 32 lower-case hex');
    w.c = cloid;
  }
  return w;
}

/** The order action over one or more wires. */
export function orderAction(wires, grouping = 'na') {
  if (!Array.isArray(wires) || wires.length === 0) throw new WireError('orderAction needs at least one wire');
  if (!['na', 'normalTpsl', 'positionTpsl'].includes(grouping)) throw new WireError('unknown grouping');
  return { type: 'order', orders: wires, grouping };
}

/** Isolated leverage for an asset (sent before every open from flat, §6.11). */
export function updateLeverageAction(asset, leverage) {
  if (!isUInt(asset)) throw new WireError('asset must be a non-negative integer');
  if (!Number.isSafeInteger(leverage) || leverage < 1) throw new WireError('leverage must be an integer ≥ 1');
  return { type: 'updateLeverage', asset, isCross: false, leverage };
}

/** P1: cancel one of our resting (trigger) orders by cloid. */
export function cancelByCloidAction(asset, cloid) {
  if (!isUInt(asset)) throw new WireError('asset must be a non-negative integer');
  if (!isCloid(cloid)) throw new WireError('cloid must be 0x + 32 lower-case hex');
  return { type: 'cancelByCloid', cancels: [{ asset, cloid }] };
}

/** Number of orders / cancels in an action (for the exchange weight 1 + floor(batch / 40)). */
export function batchSize(action) {
  if (Array.isArray(action?.orders)) return action.orders.length;
  if (Array.isArray(action?.cancels)) return action.cancels.length;
  return 1;
}

/** Exchange weight of an action (§6.8). */
export function actionWeight(action) {
  return 1 + Math.floor(batchSize(action) / 40);
}

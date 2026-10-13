// test/fixtures/hl-testnet-double.js — an offline, full-fidelity mock of Hyperliquid TESTNET (PLATFORM §11.1).
//
// Injected as `fetch` (tests, and the server's `--testnet-double` dev mode), it serves exactly two URLs:
//   https://api.hyperliquid-testnet.xyz/info       metaAndAssetCtxs, allMids, l2Book, clearinghouseState,
//                                                  spotClearinghouseState, userFillsByTime (paginated at 500, 10,000-fill
//                                                  horizon, no cloid on fills, optional `liquidation`, raw `dir` strings),
//                                                  userFunding, orderStatus (oid or cloid; real status strings;
//                                                  unknownOid), userRole (mixed-case `data.user`), extraAgents,
//                                                  userAbstraction (all five values), userRateLimit, exchangeStatus
//   https://api.hyperliquid-testnet.xyz/exchange   order / updateLeverage / cancelByCloid / approveAgent (P1)
// Any other URL throws and is recorded in `violations` (T-GUARD d/j: nothing may reach another host through it).
//
// /exchange is verified INDEPENDENTLY of server/hl/: the action is rebuilt in Hyperliquid's canonical key order
// with canonical decimal strings (as the exchange re-serializes it), msgpack-encoded with @msgpack/msgpack, hashed
// with its own u64/EIP-712 code, and the signer is RECOVERED with @noble/curves. A payload bug (key order, "1670.10")
// therefore recovers a FOREIGN address and is answered exactly like Hyperliquid answers it:
// "User or API Wallet 0x<recovered> does not exist." Nonces follow the exchange rules (100 highest per signer,
// window (T − 2 d, T + 1 d)). IOC orders match against a configurable book; positions, entry, isolated/cross margin
// and leverage (new positions default to CROSS unless updateLeverage was sent), fills (tid, fee, closedPnl,
// startPosition, dir), funding and liquidation are modelled.
//
// Funding sign convention of this double (pinned by runbook R6): `cumFunding.sinceOpen` > 0 means the position PAID
// funding; userFunding `delta.usdc` is the signed cash flow (negative = paid).
//
// Scriptable faults (`fault()` / the dev `script()`): timeout, hang, network error, HTTP 5xx / 429 / 400 plain text,
// 307 redirect, execute-then-timeout, every §6.9 error text, "Must deposit … User: <account>", partial fill, resting
// anomaly, bare-string statuses, unknownOid, signature mismatch; plus drift (external trade), liquidation fill, agent
// revocation / expiry, pruning of unfunded accounts' agents, clock skew, mids, thin books and funding.
// Every request is recorded (`requests`) so tests can assert weights and ordering.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encode } from '@msgpack/msgpack';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

import { ApiError } from '../../server/live.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const TESTNET_META = JSON.parse(fs.readFileSync(path.join(DIR, 'hl-testnet-meta.json'), 'utf8'));

// Hard-coded here on purpose (independent of server/hl/constants.js).
export const DOUBLE_INFO_URL = 'https://api.hyperliquid-testnet.xyz/info';
export const DOUBLE_EXCHANGE_URL = 'https://api.hyperliquid-testnet.xyz/exchange';

const DAY = 86_400_000;
const FILLS_PAGE = 500;
const FILLS_HORIZON = 10_000;

/** The exchange's own texts (§6.9 substrings). Exported so tests classify exactly what the double says. */
export const HL_TEXT = Object.freeze({
  nonceDuplicate: 'Invalid nonce: duplicate nonce',
  nonceLow: 'Invalid nonce: nonce too low',
  nonceWindow: 'Invalid nonce: nonce is outside the allowed time window',
  addressRateLimited: 'Too many cumulative requests sent (10001 > 10000) for cumulative volume traded $0.00. Place taker orders to free up 1 request per USDC traded.',
  minNotional: (a) => `Order must have minimum value of $10. asset=${a}`,
  insufficientMargin: (a) => `Insufficient margin to place order. asset=${a}`,
  iocNoMatch: (a) => `Order could not immediately match against any resting orders. asset=${a}`,
  reduceOnly: (a) => `Reduce only order would increase position. asset=${a}`,
  priceBand: () => 'Order price cannot be more than 80% away from the reference price',
  tick: (a) => `Price must be divisible by tick size. asset=${a}`,
  oiCap: (a) => `Cannot increase position when open interest is at cap. asset=${a}`,
  leverage: () => 'Invalid leverage value',
  doesNotExist: (addr) => `User or API Wallet ${addr} does not exist.`,
  mustDeposit: (addr) => `Must deposit before performing actions. User: ${addr}`,
  other: 'Order has an unexpected shape.',
  cancelMissing: (a) => `Order was never placed, already canceled, or filled. asset=${a}`,
});

/** Fault names accepted by script() (the admin-only `dev_double` op, §8.6). */
export const DEV_FAULTS = Object.freeze([
  'new_account', 'faucet', 'timeout', 'http5xx', 'http429', 'http400', 'redirect', 'execute_then_timeout', 'partial',
  'resting', 'waiting_for_fill', 'waiting_for_trigger', 'bare_string', 'unknown_oid', 'signature_mismatch', 'error',
  'must_deposit', 'drift', 'liquidation', 'revoke_agent', 'expire_agent', 'prune_unfunded', 'clock_skew', 'set_mid',
  'thin_book', 'funding', 'abstraction', 'mainnet_role', 'mainnet_down', 'clear',
]);

// ---- independent crypto ---------------------------------------------------------------------------------------------

const utf8 = new TextEncoder();
const kc = (b) => keccak_256(typeof b === 'string' ? utf8.encode(b) : b);
const hex = (b) => Buffer.from(b).toString('hex');
const cat = (...parts) => Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));
const u64 = (n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};
const word = (big) => Uint8Array.from(Buffer.from(BigInt(big).toString(16).padStart(64, '0'), 'hex'));
const DOMAIN_T = kc('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
const domain = (name, chainId) => kc(cat(DOMAIN_T, kc(name), kc('1'), word(chainId), word(0)));
const L1_SEP = domain('Exchange', 1337);
const AGENT_T = kc('Agent(string source,bytes32 connectionId)');

function l1Digest(action, nonce, vault, expiresAfter) {
  const vaultPart = vault ? cat([1], Buffer.from(vault.slice(2), 'hex')) : Uint8Array.of(0);
  const tail = expiresAfter === null || expiresAfter === undefined ? new Uint8Array(0) : cat([0], u64(expiresAfter));
  const connectionId = kc(cat(encode(action), u64(nonce), vaultPart, tail));
  return kc(cat([0x19, 0x01], L1_SEP, kc(cat(AGENT_T, kc('b'), connectionId))));
}

const APPROVE_T = kc('HyperliquidTransaction:ApproveAgent(string hyperliquidChain,address agentAddress,string agentName,uint64 nonce)');
function approveDigest(a, chainId) {
  const struct = kc(cat(APPROVE_T, kc(a.hyperliquidChain), word(BigInt(a.agentAddress)), kc(a.agentName), word(a.nonce)));
  return kc(cat([0x19, 0x01], domain('HyperliquidSignTransaction', chainId), struct));
}

function recover(digest, sig) {
  const sigObj = new secp256k1.Signature(BigInt(sig.r), BigInt(sig.s)).addRecoveryBit(sig.v - 27);
  return `0x${hex(kc(sigObj.recoverPublicKey(digest).toRawBytes(false).subarray(1)).subarray(12))}`;
}

const addrOfKey = (keyHex) => `0x${hex(kc(secp256k1.getPublicKey(Buffer.from(keyHex, 'hex'), false).subarray(1)).subarray(12))}`;

/** EIP-55 mixed-case form (Hyperliquid returns these in places, e.g. userRole.data.user). */
export function checksum(addr) {
  const a = addr.slice(2).toLowerCase();
  const h = hex(kc(a));
  return `0x${[...a].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('')}`;
}

/** A random valid secp256k1 private key (hex, no 0x). Throwaway keys for the double only. */
export function randomKey() {
  for (;;) {
    const k = randomBytes(32);
    if (secp256k1.utils.isValidPrivateKey(k)) return k.toString('hex');
  }
}

// ---- canonical re-serialization (what the exchange hashes) ------------------------------------------------------------

class Deser extends Error {}

function canonNum(s) {
  if (typeof s !== 'string' || !/^\d+(\.\d+)?$/.test(s)) throw new Deser('number string');
  let [i, f = ''] = s.split('.');
  i = i.replace(/^0+(?=\d)/, '');
  f = f.replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}
const int = (v) => {
  if (!Number.isSafeInteger(v) || v < 0) throw new Deser('int');
  return v;
};
const bool = (v) => {
  if (typeof v !== 'boolean') throw new Deser('bool');
  return v;
};
const cloidOf = (v) => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{32}$/.test(v)) throw new Deser('cloid');
  return v.toLowerCase();
};

function canonOrderType(t) {
  if (t && t.limit && typeof t.limit === 'object') {
    if (!['Alo', 'Ioc', 'Gtc'].includes(t.limit.tif)) throw new Deser('tif');
    return { limit: { tif: t.limit.tif } };
  }
  if (t && t.trigger && typeof t.trigger === 'object') {
    if (!['tp', 'sl'].includes(t.trigger.tpsl)) throw new Deser('tpsl');
    return { trigger: { isMarket: bool(t.trigger.isMarket), triggerPx: canonNum(t.trigger.triggerPx), tpsl: t.trigger.tpsl } };
  }
  throw new Deser('order type');
}

/** Rebuild an L1 action in the exchange's canonical form. Throws Deser for shapes the exchange cannot parse. */
function canonical(action) {
  switch (action?.type) {
    case 'order': {
      if (!Array.isArray(action.orders) || !action.orders.length) throw new Deser('orders');
      if (!['na', 'normalTpsl', 'positionTpsl'].includes(action.grouping)) throw new Deser('grouping');
      return {
        type: 'order',
        orders: action.orders.map((o) => {
          const w = { a: int(o.a), b: bool(o.b), p: canonNum(o.p), s: canonNum(o.s), r: bool(o.r), t: canonOrderType(o.t) };
          if (o.c !== undefined && o.c !== null) w.c = cloidOf(o.c);
          return w;
        }),
        grouping: action.grouping,
      };
    }
    case 'updateLeverage':
      return { type: 'updateLeverage', asset: int(action.asset), isCross: bool(action.isCross), leverage: int(action.leverage) };
    case 'cancelByCloid':
      if (!Array.isArray(action.cancels) || !action.cancels.length) throw new Deser('cancels');
      return { type: 'cancelByCloid', cancels: action.cancels.map((c) => ({ asset: int(c.asset), cloid: cloidOf(c.cloid) })) };
    default:
      throw new Deser(`unknown variant ${String(action?.type).slice(0, 30)}`);
  }
}

// ---- helpers ---------------------------------------------------------------------------------------------------------------

const str = (x) => {
  if (x === null || x === undefined) return null;
  if (!Number.isFinite(x)) return '0.0';
  const s = Number(x.toPrecision(12)).toString();
  if (/e/i.test(s)) return x.toFixed(10).replace(/0+$/, '').replace(/\.$/, '.0');
  return s.includes('.') ? s : `${s}.0`;
};
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

function response(status, payload, { text = false, headers = {} } = {}) {
  const body = text ? String(payload) : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/**
 * Build a testnet double.
 * @param {object} [opts]
 * @param {() => number} [opts.now]          clock (ms); default Date.now
 * @param {number} [opts.takerFee=0.00045]
 * @param {boolean} [opts.reduceOnlyMinNotional=false]  true → a reduce-only order below $10 is refused too (runbook R7)
 * @param {number} [opts.idBase=0]  added to the first oid / tid. Real Hyperliquid ids are unique forever; the
 *   `--testnet-double` dev server passes the boot time so a restarted double (fresh in-process state) never reuses
 *   an oid or tid that the persisted garden DB already holds (fills are unique per (user, venue, tid)).
 */
export function makeTestnetDouble({ now = () => Date.now(), takerFee = 0.00045, reduceOnlyMinNotional = false, idBase = 0 } = {}) {
  const base = Number.isSafeInteger(idBase) && idBase >= 0 && idBase < 2 ** 50 ? idBase : 0;
  const meta = structuredClone(TESTNET_META);
  const universe = meta[0].universe;
  const byName = new Map(universe.map((u, i) => [u.name, i]));
  const mids = new Map();
  meta[1].forEach((c, i) => {
    const px = Number(c.midPx ?? NaN);
    if (Number.isFinite(px) && px > 0 && !universe[i].isDelisted) mids.set(universe[i].name, px);
  });

  const dbl = {
    requests: [],
    violations: [],
    faults: [],
    accounts: new Map(), // address → account
    agents: new Map(), // agent address → {account, name, validUntil, key, revoked}
    roleOverrides: new Map(),
    orders: new Map(), // oid → order
    cloids: new Map(), // `${account}|${cloid}` → oid
    nonces: new Map(), // signer → ascending array (≤ 100)
    books: new Map(), // coin → {levels, levelUsd, spreadBps, stepBps}
    executed: [], // processed exchange actions {t, signer, account, type, nonce}
    skewMs: 0,
    pageSize: FILLS_PAGE,
    nextOid: 1_000_000 + base,
    nextTid: 5_000_000 + base,
    mids,
    universe,
    now,
    mainnet: { roles: new Map(), fault: null, calls: 0 },
  };

  // ---- accounts and agents --------------------------------------------------------------------------------------

  dbl.addAccount = ({ usd = 1000, abstraction = 'default', key = randomKey() } = {}) => {
    const address = addrOfKey(key);
    dbl.accounts.set(address, {
      address, key, usd, abstraction, positions: new Map(), leverage: new Map(), fills: [], fundings: [],
      nRequestsUsed: 0, cumVlm: 0, capOverride: null,
    });
    return { address, key };
  };

  dbl.addAgent = (account, { name = 'bean-garden', validUntil = now() + 90 * DAY, key = randomKey(), unnamed = false } = {}) => {
    const acct = dbl.accounts.get(account.toLowerCase());
    if (!acct) throw new Error('addAgent: unknown account');
    const address = addrOfKey(key);
    if (!unnamed) {
      for (const [a, ag] of dbl.agents) if (ag.account === acct.address && ag.name === name) dbl.agents.delete(a); // named re-approval replaces
    } else {
      for (const [a, ag] of dbl.agents) if (ag.account === acct.address && ag.name === null) dbl.agents.delete(a); // one unnamed
    }
    dbl.agents.set(address, { account: acct.address, name: unnamed ? null : name, validUntil: unnamed ? null : validUntil, key, revoked: false });
    return { address, key, keyBytes: Uint8Array.from(Buffer.from(key, 'hex')) };
  };

  const agentValid = (ag) => ag && !ag.revoked && (ag.validUntil === null || ag.validUntil > hlNow());
  dbl.revokeAgent = (addr) => {
    const ag = dbl.agents.get(addr.toLowerCase());
    if (ag) ag.revoked = true;
  };
  dbl.expireAgent = (addr) => {
    const ag = dbl.agents.get(addr.toLowerCase());
    if (ag) ag.validUntil = hlNow() - 1;
  };
  /** Hyperliquid prunes the agents of accounts without funds. */
  dbl.pruneUnfunded = () => {
    for (const [a, ag] of dbl.agents) if (!funded(dbl.accounts.get(ag.account))) dbl.agents.delete(a);
  };
  dbl.setRole = (addr, reply) => dbl.roleOverrides.set(addr.toLowerCase(), reply);
  dbl.faucet = (account, usd = 1000) => {
    dbl.accounts.get(account.toLowerCase()).usd += usd;
  };
  dbl.setAbstraction = (account, abstraction) => {
    dbl.accounts.get(account.toLowerCase()).abstraction = abstraction;
  };

  // ---- market -----------------------------------------------------------------------------------------------------

  const hlNow = () => now() + dbl.skewMs;
  dbl.setMid = (coin, px) => mids.set(coin, px);
  dbl.setBook = (coin, cfg) => dbl.books.set(coin, { ...bookCfg(coin), ...cfg });
  const bookCfg = (coin) => dbl.books.get(coin) ?? { levels: 10, levelUsd: 50_000, spreadBps: 2, stepBps: 10 };
  const coinOf = (asset) => universe[asset] ?? null;
  const lot = (coin) => 10 ** -universe[byName.get(coin)].szDecimals;
  const roundLots = (sz, coin) => {
    const d = universe[byName.get(coin)].szDecimals;
    return Math.floor(sz * 10 ** d + 1e-9) / 10 ** d;
  };

  /** Book levels around the mid: [{px, sz}] asks ascending, bids descending. */
  function levels(coin) {
    const mid = mids.get(coin);
    if (!(mid > 0)) return { bids: [], asks: [] };
    const cfg = bookCfg(coin);
    const asks = [];
    const bids = [];
    for (let i = 0; i < cfg.levels; i++) {
      const off = (cfg.spreadBps / 2 + i * cfg.stepBps) / 10_000;
      const ap = Number((mid * (1 + off)).toPrecision(5));
      const bp = Number((mid * (1 - off)).toPrecision(5));
      const asz = roundLots(cfg.levelUsd / ap, coin);
      const bsz = roundLots(cfg.levelUsd / bp, coin);
      if (asz > 0) asks.push({ px: ap, sz: asz });
      if (bsz > 0) bids.push({ px: bp, sz: bsz });
    }
    return { bids, asks };
  }

  // ---- account math -------------------------------------------------------------------------------------------------

  const markOf = (coin, pos) => mids.get(coin) ?? pos.entryPx;
  function posStats(coin, pos) {
    const mark = markOf(coin, pos);
    const value = Math.abs(pos.szi) * mark;
    const upnl = pos.szi * (mark - pos.entryPx);
    const lev = pos.leverage.value;
    const marginUsed = (Math.abs(pos.szi) * pos.entryPx) / lev; // initial margin at entry (a simplification)
    const liq = pos.szi > 0 ? pos.entryPx * (1 - 0.9 / lev) : pos.entryPx * (1 + 0.9 / lev);
    return { mark, value, upnl, marginUsed, liq };
  }
  function totals(acct) {
    let upnl = 0;
    let margin = 0;
    let ntl = 0;
    for (const [coin, pos] of acct.positions) {
      const s = posStats(coin, pos);
      upnl += s.upnl;
      margin += s.marginUsed;
      ntl += s.value;
    }
    const accountValue = acct.usd + upnl;
    return { upnl, margin, ntl, accountValue, withdrawable: Math.max(0, accountValue - margin) };
  }
  const funded = (acct) => Boolean(acct) && (acct.usd > 0 || acct.positions.size > 0);
  const capOf = (acct) => acct.capOverride ?? 10_000 + Math.floor(acct.cumVlm);

  function dirOf(start, isBuy, end) {
    if (start === 0) return isBuy ? 'Open Long' : 'Open Short';
    if (start > 0) return isBuy ? 'Open Long' : (end >= 0 ? 'Close Long' : 'Long > Short');
    return !isBuy ? 'Open Short' : (end <= 0 ? 'Close Short' : 'Short > Long');
  }

  /** Apply one fill to an account; returns the fill record. */
  function applyFill(acct, coin, isBuy, sz, px, oid, extra = {}) {
    const pos = acct.positions.get(coin) ?? null;
    const start = pos ? pos.szi : 0;
    const signed = isBuy ? sz : -sz;
    const end = Math.round((start + signed) * 1e10) / 1e10;
    let closedPnl = 0;
    if (start !== 0 && Math.sign(signed) !== Math.sign(start)) {
      const closeSz = Math.min(Math.abs(signed), Math.abs(start));
      closedPnl = closeSz * (px - pos.entryPx) * Math.sign(start);
    }
    const fee = extra.fee ?? sz * px * takerFee;
    acct.usd += closedPnl - fee;
    acct.cumVlm += sz * px;
    const info = universe[byName.get(coin)];
    if (end === 0) {
      acct.positions.delete(coin);
    } else if (start === 0 || Math.sign(end) !== Math.sign(start)) {
      // open from flat, or the opening leg of a flip: leverage from the coin setting (default CROSS)
      const set = acct.leverage.get(coin) ?? (info.onlyIsolated ? { type: 'isolated', value: Math.min(10, info.maxLeverage) } : { type: 'cross', value: Math.min(20, info.maxLeverage) });
      acct.positions.set(coin, { szi: end, entryPx: px, leverage: { ...set }, cumFunding: { allTime: pos?.cumFunding.allTime ?? 0, sinceOpen: 0, sinceChange: 0 } });
    } else if (Math.abs(end) > Math.abs(start)) {
      pos.entryPx = (Math.abs(start) * pos.entryPx + sz * px) / Math.abs(end);
      pos.szi = end;
      pos.cumFunding.sinceChange = 0;
    } else {
      pos.szi = end;
      pos.cumFunding.sinceChange = 0;
    }
    const fill = {
      coin, px: str(px), sz: str(sz), side: isBuy ? 'B' : 'A', time: hlNow(), startPosition: str(start),
      dir: extra.dir ?? dirOf(start, isBuy, end), closedPnl: str(closedPnl), hash: `0x${randomBytes(32).toString('hex')}`,
      oid, crossed: true, fee: str(fee), tid: dbl.nextTid++, feeToken: 'USDC',
    };
    if (extra.liquidation) fill.liquidation = extra.liquidation;
    acct.fills.push(fill);
    if (acct.fills.length > FILLS_HORIZON) acct.fills.splice(0, acct.fills.length - FILLS_HORIZON);
    return fill;
  }

  // ---- faults -------------------------------------------------------------------------------------------------------

  /**
   * Script a fault. `kind`: timeout | hang | network | http (status, text) | redirect | execute_then_timeout |
   * error (code) | partial (fraction) | resting | status (value: a bare string) | unknown_oid | signature_mismatch.
   * @param {object} f  {kind, path:'exchange'|'info'|'*', type:'*'|<action or info type>, times:1, ...args}
   */
  dbl.fault = (f) => {
    const entry = { path: '*', type: '*', times: 1, ...f };
    dbl.faults.push(entry);
    return entry;
  };
  dbl.clearFaults = () => {
    dbl.faults.length = 0;
  };
  function takeFault(pathName, type, kinds) {
    const i = dbl.faults.findIndex((f) => (f.path === '*' || f.path === pathName) && (f.type === '*' || f.type === type) && (!kinds || kinds.includes(f.kind)));
    if (i < 0) return null;
    const f = dbl.faults[i];
    if (--f.times <= 0) dbl.faults.splice(i, 1);
    return f;
  }
  const TRANSPORT_KINDS = ['timeout', 'hang', 'network', 'http', 'redirect', 'execute_then_timeout'];

  // ---- fetch --------------------------------------------------------------------------------------------------------

  dbl.fetch = async (url, init = {}) => {
    const t = now();
    const urlStr = typeof url === 'string' ? url : String(url?.url ?? url);
    if (urlStr !== DOUBLE_INFO_URL && urlStr !== DOUBLE_EXCHANGE_URL) {
      dbl.violations.push({ t, url: urlStr, method: init.method });
      throw new TypeError(`hl-testnet-double: refusing ${urlStr} (only the two testnet URLs exist here)`);
    }
    const pathName = urlStr === DOUBLE_EXCHANGE_URL ? 'exchange' : 'info';
    let body;
    try {
      body = JSON.parse(init.body);
    } catch {
      body = null;
    }
    const type = pathName === 'info' ? body?.type : body?.action?.type;
    const rec = { t, url: urlStr, path: pathName, type, method: init.method, redirect: init.redirect };
    if (pathName === 'exchange') {
      rec.body = init.body;
      rec.nonce = body?.nonce;
      rec.cloids = Array.isArray(body?.action?.orders) ? body.action.orders.map((o) => o.c ?? null) : [];
    } else {
      rec.user = body?.user;
    }
    dbl.requests.push(rec);
    if (init.method !== 'POST') return response(405, 'Method Not Allowed', { text: true });

    const f = takeFault(pathName, type, TRANSPORT_KINDS);
    if (f) {
      if (f.kind === 'timeout') throw timeoutError();
      if (f.kind === 'network') throw new TypeError('fetch failed');
      if (f.kind === 'hang') {
        return new Promise((_, reject) => {
          const sig = init.signal;
          if (sig?.aborted) reject(timeoutError());
          else sig?.addEventListener?.('abort', () => reject(timeoutError()), { once: true });
        });
      }
      if (f.kind === 'http') {
        const status = f.status ?? 500;
        return response(status, f.text ?? (status === 429 ? 'Too Many Requests' : status >= 500 ? 'Internal Server Error' : 'Bad Request'), { text: true });
      }
      if (f.kind === 'redirect') {
        rec.redirected = true;
        const location = f.location ?? 'https://api.hyperliquid-testnet.xyz.evil.example/exchange';
        if (init.redirect === 'error') {
          throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
        }
        // A client that does not refuse redirects would now re-POST to `location`: record it as a violation.
        dbl.violations.push({ t, url: location, method: 'POST', followedRedirect: true });
        return response(307, '', { text: true, headers: { location } });
      }
      if (f.kind === 'execute_then_timeout') {
        if (pathName === 'exchange') handleExchange(body, init); // the action IS executed …
        throw timeoutError(); // … and the client never learns it
      }
    }
    if (pathName === 'info') return handleInfo(body);
    return handleExchange(body, init);
  };

  // ---- /info --------------------------------------------------------------------------------------------------------

  function chState(acct) {
    const tt = totals(acct);
    const unified = acct.abstraction === 'unifiedAccount';
    const assetPositions = [];
    for (const [coin, pos] of acct.positions) {
      const s = posStats(coin, pos);
      const info = universe[byName.get(coin)];
      assetPositions.push({
        type: 'oneWay',
        position: {
          coin, szi: str(pos.szi),
          leverage: pos.leverage.type === 'isolated' ? { type: 'isolated', value: pos.leverage.value, rawUsd: str(-pos.szi * pos.entryPx + s.marginUsed) } : { type: 'cross', value: pos.leverage.value },
          entryPx: str(pos.entryPx), positionValue: str(s.value), unrealizedPnl: str(s.upnl),
          returnOnEquity: str(s.marginUsed ? s.upnl / s.marginUsed : 0), liquidationPx: str(s.liq), marginUsed: str(s.marginUsed),
          maxLeverage: info.maxLeverage,
          cumFunding: { allTime: str(pos.cumFunding.allTime), sinceOpen: str(pos.cumFunding.sinceOpen), sinceChange: str(pos.cumFunding.sinceChange) },
        },
      });
    }
    const summary = unified
      ? { accountValue: str(tt.margin + tt.upnl), totalNtlPos: str(tt.ntl), totalRawUsd: str(tt.margin), totalMarginUsed: str(tt.margin) }
      : { accountValue: str(tt.accountValue), totalNtlPos: str(tt.ntl), totalRawUsd: str(acct.usd), totalMarginUsed: str(tt.margin) };
    return {
      marginSummary: summary, crossMarginSummary: summary, crossMaintenanceMarginUsed: str(tt.margin / 2),
      withdrawable: str(unified ? 0 : tt.withdrawable), assetPositions, time: hlNow(),
    };
  }

  function orderStatusOf(o) {
    return {
      status: 'order',
      order: {
        order: {
          coin: o.coin, side: o.side, limitPx: o.limitPx, sz: str(o.remaining), oid: o.oid, timestamp: o.timestamp,
          triggerCondition: 'N/A', isTrigger: false, triggerPx: '0.0', children: [], isPositionTpsl: false,
          reduceOnly: o.reduceOnly, orderType: 'Limit', origSz: o.origSz, tif: o.tif, cloid: o.cloid,
        },
        status: o.status,
        statusTimestamp: o.statusTimestamp,
      },
    };
  }

  function handleInfo(body) {
    const ok = (p) => response(200, p);
    const user = typeof body?.user === 'string' ? body.user.toLowerCase() : null;
    const acct = user ? dbl.accounts.get(user) : null;
    switch (body?.type) {
      case 'allMids': {
        const out = {};
        for (const [coin, px] of mids) out[coin] = str(px);
        return ok(out);
      }
      case 'metaAndAssetCtxs': {
        const m = structuredClone(meta);
        m[1].forEach((c, i) => {
          const px = mids.get(universe[i].name);
          if (px) {
            c.midPx = str(px);
            c.markPx = str(px);
          }
        });
        return ok(m);
      }
      case 'l2Book': {
        if (!byName.has(body.coin)) return ok(null);
        const { bids, asks } = levels(body.coin);
        const lv = (l) => ({ px: str(l.px), sz: str(l.sz), n: 1 });
        return ok({ coin: body.coin, time: hlNow(), levels: [bids.map(lv), asks.map(lv)] });
      }
      case 'exchangeStatus':
        return ok({ time: hlNow(), specialStatuses: null });
      case 'clearinghouseState':
        if (!acct) return ok({ marginSummary: { accountValue: '0.0', totalNtlPos: '0.0', totalRawUsd: '0.0', totalMarginUsed: '0.0' }, crossMarginSummary: { accountValue: '0.0', totalNtlPos: '0.0', totalRawUsd: '0.0', totalMarginUsed: '0.0' }, crossMaintenanceMarginUsed: '0.0', withdrawable: '0.0', assetPositions: [], time: hlNow() });
        return ok(chState(acct));
      case 'spotClearinghouseState': {
        if (!acct) return ok({ balances: [] });
        const tt = totals(acct);
        const unified = acct.abstraction === 'unifiedAccount';
        return ok({ balances: [{ coin: 'USDC', token: 0, hold: str(unified ? tt.margin : 0), total: str(unified ? acct.usd : 0), entryNtl: '0.0' }] });
      }
      case 'userFillsByTime': {
        if (!acct) return ok([]);
        const start = Number(body.startTime ?? 0);
        const end = body.endTime === undefined || body.endTime === null ? Infinity : Number(body.endTime);
        return ok(acct.fills.filter((f) => f.time >= start && f.time <= end).slice(0, dbl.pageSize));
      }
      case 'userFunding': {
        if (!acct) return ok([]);
        const start = Number(body.startTime ?? 0);
        return ok(acct.fundings.filter((x) => x.time >= start).slice(0, FILLS_PAGE));
      }
      case 'orderStatus': {
        if (takeFault('info', 'orderStatus', ['unknown_oid'])) return ok({ status: 'unknownOid' });
        let oid = null;
        if (typeof body.oid === 'number') oid = body.oid;
        else if (typeof body.oid === 'string') oid = dbl.cloids.get(`${user}|${body.oid.toLowerCase()}`) ?? null;
        const o = oid !== null ? dbl.orders.get(oid) : null;
        if (!o || o.user !== user) return ok({ status: 'unknownOid' });
        return ok(orderStatusOf(o));
      }
      case 'userRole': {
        if (dbl.roleOverrides.has(user)) return ok(dbl.roleOverrides.get(user));
        if (dbl.accounts.has(user)) return ok({ role: 'user' });
        const ag = dbl.agents.get(user);
        if (agentValid(ag)) return ok({ role: 'agent', data: { user: checksum(ag.account) } });
        return ok({ role: 'missing' });
      }
      case 'extraAgents': {
        const out = [];
        for (const [a, ag] of dbl.agents) {
          if (ag.account === user && ag.name !== null && !ag.revoked) out.push({ name: ag.name, address: checksum(a), validUntil: ag.validUntil });
        }
        return ok(out);
      }
      case 'userAbstraction':
        return ok(acct ? acct.abstraction : 'default');
      case 'userRateLimit':
        if (!acct) return ok({ cumVlm: '0.0', nRequestsUsed: 0, nRequestsCap: 10_000, nRequestsSurplus: 0 });
        return ok({ cumVlm: str(acct.cumVlm), nRequestsUsed: acct.nRequestsUsed, nRequestsCap: capOf(acct), nRequestsSurplus: 0 });
      default:
        return response(422, 'Failed to deserialize the JSON body into the target type', { text: true });
    }
  }

  // ---- /exchange ----------------------------------------------------------------------------------------------------

  const err = (text) => response(200, { status: 'err', response: text });
  const okRes = (r) => response(200, { status: 'ok', response: r });

  function checkNonce(signer, nonce) {
    const T = hlNow();
    if (!Number.isSafeInteger(nonce) || nonce <= T - 2 * DAY || nonce >= T + DAY) return HL_TEXT.nonceWindow;
    const set = dbl.nonces.get(signer) ?? [];
    if (set.includes(nonce)) return HL_TEXT.nonceDuplicate;
    if (set.length >= 100 && nonce <= set[0]) return HL_TEXT.nonceLow;
    set.push(nonce);
    set.sort((a, b) => a - b);
    if (set.length > 100) set.shift();
    dbl.nonces.set(signer, set);
    return null;
  }

  function errorFaultText(code, acct, signer, asset) {
    switch (code) {
      case 'nonce': return HL_TEXT.nonceDuplicate;
      case 'address_rate_limited': return HL_TEXT.addressRateLimited;
      case 'no_deposit': return HL_TEXT.mustDeposit(checksum(acct.address));
      case 'agent_unknown': return HL_TEXT.doesNotExist(signer);
      case 'signature_mismatch': return HL_TEXT.doesNotExist(addrOfKey(randomKey()));
      case 'leverage_rejected': return HL_TEXT.leverage();
      case 'min_notional': return HL_TEXT.minNotional(asset);
      case 'insufficient_margin': return HL_TEXT.insufficientMargin(asset);
      case 'ioc_no_match': return HL_TEXT.iocNoMatch(asset);
      case 'reduce_only': return HL_TEXT.reduceOnly(asset);
      case 'price_band': return HL_TEXT.priceBand(asset);
      case 'tick': return HL_TEXT.tick(asset);
      case 'oi_cap': return HL_TEXT.oiCap(asset);
      default: return HL_TEXT.other;
    }
  }
  const TOP_LEVEL = new Set(['nonce', 'address_rate_limited', 'no_deposit', 'agent_unknown', 'signature_mismatch', 'leverage_rejected']);

  function handleExchange(body) {
    if (!body || typeof body !== 'object' || !body.action || typeof body.action !== 'object' || !body.signature) {
      return response(422, 'Failed to deserialize the JSON body into the target type', { text: true });
    }
    const { action, nonce, signature, vaultAddress = null, expiresAfter = null } = body;
    if (vaultAddress !== null) return err('Vault trading is not supported by this double');
    if (action.type === 'approveAgent') return handleApproveAgent(action, nonce, signature);
    let canon;
    try {
      canon = canonical(action);
    } catch (e) {
      return response(422, `Failed to deserialize the JSON body into the target type: ${e.message}`, { text: true });
    }
    let signer;
    try {
      signer = recover(l1Digest(canon, nonce, null, expiresAfter), signature);
    } catch {
      return response(422, 'Failed to deserialize the JSON body into the target type: signature', { text: true });
    }
    if (takeFault('exchange', action.type, ['signature_mismatch'])) signer = addrOfKey(randomKey());
    const ag = dbl.agents.get(signer);
    const acct = agentValid(ag) ? dbl.accounts.get(ag.account) : dbl.accounts.get(signer) ?? null;
    if (!acct) return err(HL_TEXT.doesNotExist(signer));
    if (!funded(acct) || takeFault('exchange', action.type, ['must_deposit'])) return err(HL_TEXT.mustDeposit(checksum(acct.address)));
    const fe = takeFault('exchange', action.type, ['error']);
    if (fe && TOP_LEVEL.has(fe.code)) return err(errorFaultText(fe.code, acct, signer, action.orders?.[0]?.a ?? action.asset));
    const nonceErr = checkNonce(signer, nonce);
    if (nonceErr) return err(nonceErr);
    acct.nRequestsUsed++;
    if (acct.nRequestsUsed > capOf(acct)) return err(HL_TEXT.addressRateLimited);
    dbl.executed.push({ t: now(), signer, account: acct.address, type: action.type, nonce });

    if (canon.type === 'updateLeverage') {
      const info = coinOf(canon.asset);
      if (!info) return err('Invalid asset');
      if (canon.leverage > info.maxLeverage || canon.leverage < 1) return err(HL_TEXT.leverage());
      if (canon.isCross && info.onlyIsolated) return err('Cross margin is not allowed for this asset');
      acct.leverage.set(info.name, { type: canon.isCross ? 'cross' : 'isolated', value: canon.leverage });
      return okRes({ type: 'default' });
    }
    if (canon.type === 'cancelByCloid') {
      const statuses = canon.cancels.map((c) => {
        const oid = dbl.cloids.get(`${acct.address}|${c.cloid}`);
        const o = oid !== undefined ? dbl.orders.get(oid) : null;
        if (!o || o.status !== 'open') return { error: HL_TEXT.cancelMissing(c.asset) };
        o.status = 'canceled';
        o.statusTimestamp = hlNow();
        return 'success';
      });
      return okRes({ type: 'cancel', data: { statuses } });
    }
    const statuses = canon.orders.map((w) => placeOrder(acct, w, fe && !TOP_LEVEL.has(fe.code) ? fe : null));
    return okRes({ type: 'order', data: { statuses } });
  }

  function placeOrder(acct, w, statusFault) {
    const info = coinOf(w.a);
    if (!info) return { error: `Invalid asset. asset=${w.a}` };
    if (info.isDelisted) return { error: `Trading is halted for this asset. asset=${w.a}` };
    const coin = info.name;
    const oid = dbl.nextOid++;
    const px = Number(w.p);
    const sz = Number(w.s);
    const ts = hlNow();
    const order = {
      oid, user: acct.address, coin, side: w.b ? 'B' : 'A', limitPx: w.p, origSz: w.s, remaining: sz, timestamp: ts,
      reduceOnly: w.r, tif: w.t.limit?.tif ?? 'Gtc', cloid: w.c ?? null, status: 'open', statusTimestamp: ts,
    };
    dbl.orders.set(oid, order);
    if (order.cloid) dbl.cloids.set(`${acct.address}|${order.cloid}`, oid);
    const reject = (status, text) => {
      order.status = status;
      return { error: text };
    };
    if (statusFault) return reject('rejected', errorFaultText(statusFault.code, acct, null, w.a));
    const bare = takeFault('exchange', 'order', ['status']);
    if (bare) {
      if (bare.value === 'waitingForFill' || bare.value === 'waitingForTrigger') order.status = 'open';
      else order.status = 'rejected';
      return bare.value;
    }
    // tick and lot
    const d = info.szDecimals;
    const dec = (s) => (s.includes('.') ? s.length - s.indexOf('.') - 1 : 0);
    const sig = w.p.replace('.', '').replace(/^0+/, '').length;
    if ((w.p.includes('.') && sig > 5) || dec(w.p) > Math.max(0, 6 - d)) return reject('tickRejected', HL_TEXT.tick(w.a));
    if (dec(w.s) > d || !(sz > 0)) return reject('rejected', `Order has invalid size. asset=${w.a}`);
    const mid = mids.get(coin);
    if (!(mid > 0)) return reject('rejected', HL_TEXT.iocNoMatch(w.a));
    if (Math.abs(px / mid - 1) > 0.8) return reject('rejected', HL_TEXT.priceBand());
    const pos = acct.positions.get(coin);
    const start = pos ? pos.szi : 0;
    let want = sz;
    if (w.r) {
      if (start === 0 || (w.b && start > 0) || (!w.b && start < 0)) return reject('reduceOnlyRejected', HL_TEXT.reduceOnly(w.a));
      want = Math.min(sz, Math.abs(start));
    }
    if ((!w.r || reduceOnlyMinNotional) && want * px < 10) return reject('minTradeNtlRejected', HL_TEXT.minNotional(w.a));
    if (takeFault('exchange', 'order', ['oi_cap_status'])) return reject('openInterestCapCanceled', HL_TEXT.oiCap(w.a));
    // margin for the increasing part
    const end = start + (w.b ? want : -want);
    const increase = Math.sign(end) === Math.sign(start) || start === 0 ? Math.max(0, Math.abs(end) - Math.abs(start)) : Math.abs(end);
    if (increase > 0) {
      const set = acct.leverage.get(coin) ?? { value: Math.min(20, info.maxLeverage) };
      const need = (increase * mid) / set.value;
      const tt = totals(acct);
      if (need > tt.accountValue - tt.margin + 1e-9) return reject('perpMarginRejected', HL_TEXT.insufficientMargin(w.a));
    }
    if (takeFault('exchange', 'order', ['resting'])) return { resting: { oid } };
    // IOC matching against the book
    const { bids, asks } = levels(coin);
    const book = w.b ? asks : bids;
    const pf = takeFault('exchange', 'order', ['partial']);
    let left = pf ? roundLots(want * (pf.fraction ?? 0.5), coin) : want;
    const parts = [];
    for (const l of book) {
      if (left <= 1e-12) break;
      if (w.b ? l.px > px : l.px < px) break;
      const take = Math.min(left, l.sz);
      parts.push({ px: l.px, sz: take });
      left = Math.round((left - take) * 1e10) / 1e10;
    }
    const filled = Math.round(parts.reduce((s, p) => s + p.sz, 0) * 1e10) / 1e10;
    if (filled <= 0 || filled < lot(coin) - 1e-12) return reject('iocCancelRejected', HL_TEXT.iocNoMatch(w.a));
    let notional = 0;
    for (const p of parts) {
      applyFill(acct, coin, w.b, p.sz, p.px, oid);
      notional += p.px * p.sz;
    }
    order.remaining = Math.round((sz - filled) * 1e10) / 1e10;
    order.status = order.remaining > 1e-12 ? 'canceled' : 'filled';
    order.statusTimestamp = hlNow();
    return { filled: { totalSz: str(filled), avgPx: str(notional / filled), oid } };
  }

  function handleApproveAgent(action, nonce, signature) {
    if (action.hyperliquidChain !== 'Testnet') return err('Invalid hyperliquidChain for this network');
    const chainId = parseInt(action.signatureChainId, 16);
    let signer;
    try {
      signer = recover(approveDigest(action, chainId), signature);
    } catch {
      return response(422, 'Failed to deserialize the JSON body into the target type: signature', { text: true });
    }
    const acct = dbl.accounts.get(signer);
    if (!acct) return err(HL_TEXT.doesNotExist(signer));
    const nonceErr = checkNonce(signer, nonce);
    if (nonceErr) return err(nonceErr);
    const agent = String(action.agentAddress).toLowerCase();
    const m = /valid_until (\d{13})$/.exec(action.agentName ?? '');
    const name = action.agentName ? action.agentName.replace(/ valid_until \d{13}$/, '') : null;
    for (const [a, ag] of dbl.agents) if (ag.account === acct.address && ag.name === name) dbl.agents.delete(a);
    dbl.agents.set(agent, { account: acct.address, name, validUntil: m ? Number(m[1]) : null, key: null, revoked: false });
    return okRes({ type: 'default' });
  }

  // ---- scripted market and account events -----------------------------------------------------------------------------

  /** A trade on the account that the garden did not send (drift, §6.11 step 4). Returns the fill. */
  dbl.externalTrade = (account, coin, szDelta, { px = mids.get(coin) } = {}) => {
    const acct = dbl.accounts.get(account.toLowerCase());
    const oid = dbl.nextOid++;
    return applyFill(acct, coin, szDelta > 0, Math.abs(szDelta), px, oid);
  };

  /** Liquidate the account's position on `coin` with a `liquidation` object and an unusual dir string. */
  dbl.liquidate = (account, coin, { px } = {}) => {
    const acct = dbl.accounts.get(account.toLowerCase());
    const pos = acct.positions.get(coin);
    if (!pos) return null;
    const s = posStats(coin, pos);
    const at = px ?? s.liq;
    const oid = dbl.nextOid++;
    return applyFill(acct, coin, pos.szi < 0, Math.abs(pos.szi), at, oid, {
      dir: pos.leverage.type === 'isolated' ? `Liquidated Isolated ${pos.szi > 0 ? 'Long' : 'Short'}` : `Liquidated Cross ${pos.szi > 0 ? 'Long' : 'Short'}`,
      liquidation: { liquidatedUser: account.toLowerCase(), markPx: str(at), method: 'market' },
      fee: 0,
    });
  };

  /** Charge one funding interval on every position in `coin` (rate per hour; positive → longs pay). */
  dbl.applyFunding = (coin, rate) => {
    const mid = mids.get(coin);
    for (const acct of dbl.accounts.values()) {
      const pos = acct.positions.get(coin);
      if (!pos) continue;
      const paid = pos.szi * mid * rate; // > 0: this position paid
      acct.usd -= paid;
      pos.cumFunding.allTime += paid;
      pos.cumFunding.sinceOpen += paid;
      pos.cumFunding.sinceChange += paid;
      acct.fundings.push({ time: hlNow(), hash: `0x${'0'.repeat(64)}`, delta: { type: 'funding', coin, usdc: str(-paid), szi: str(pos.szi), fundingRate: str(rate), nSamples: null } });
    }
  };

  /** Bulk historical fills (pagination tests): `n` fills on `coin`, `stepMs` apart, ending now. */
  dbl.addFills = (account, n, { coin = 'ETH', stepMs = 10, oid = null } = {}) => {
    const acct = dbl.accounts.get(account.toLowerCase());
    const t0 = hlNow() - n * stepMs;
    for (let i = 0; i < n; i++) {
      acct.fills.push({
        coin, px: '2500.0', sz: '0.01', side: i % 2 ? 'A' : 'B', time: t0 + i * stepMs, startPosition: '0.0',
        dir: i % 2 ? 'Close Long' : 'Open Long', closedPnl: '0.0', hash: `0x${'1'.repeat(64)}`, oid: oid ?? dbl.nextOid++,
        crossed: true, fee: '0.01125', tid: dbl.nextTid++, feeToken: 'USDC',
      });
    }
    acct.fills.sort((a, b) => a.time - b.time);
    if (acct.fills.length > FILLS_HORIZON) acct.fills.splice(0, acct.fills.length - FILLS_HORIZON);
  };

  /** Current position on a coin as numbers, or null. */
  dbl.position = (account, coin) => {
    const pos = dbl.accounts.get(account.toLowerCase())?.positions.get(coin);
    return pos ? { szi: pos.szi, entryPx: pos.entryPx, leverage: { ...pos.leverage }, cumFunding: { ...pos.cumFunding } } : null;
  };
  dbl.accountValue = (account) => totals(dbl.accounts.get(account.toLowerCase())).accountValue;
  dbl.ordersFor = (account) => [...dbl.orders.values()].filter((o) => o.user === account.toLowerCase());
  dbl.requestsOf = (pathName, type) => dbl.requests.filter((r) => r.path === pathName && (!type || r.type === type));

  // ---- the mainnet userRole guard for --testnet-double (no network: answered here) -------------------------------------

  dbl.mainnetInfo = Object.freeze({
    async userRole(addr) {
      dbl.mainnet.calls++;
      if (dbl.mainnet.fault === 'fail') throw new TypeError('fetch failed');
      if (dbl.mainnet.fault === 'timeout') return new Promise(() => {});
      if (dbl.mainnet.fault === 'bad') return {};
      return structuredClone(dbl.mainnet.roles.get(String(addr).toLowerCase()) ?? { role: 'missing' });
    },
  });

  // ---- the dev_double op (§8.6) --------------------------------------------------------------------------------------

  /**
   * Script a fault or event from the Operator panel (dev only). Unknown names throw.
   * @param {string} name  one of DEV_FAULTS
   * @param {object} [args]
   */
  dbl.script = (name, args = {}) => {
    // Bad input from the dev panel is a 400 (an ApiError the HTTP layer maps), never a 500.
    if (!DEV_FAULTS.includes(name)) throw new ApiError(400, `unknown double fault (one of: ${DEV_FAULTS.join(', ')})`, 'bad_request');
    if (args === null || typeof args !== 'object') throw new ApiError(400, 'args must be an object', 'bad_request');
    try {
      return runScript(name, args);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(400, `double fault ${name} failed: ${String(err?.message ?? err).slice(0, 120)}`, 'bad_request');
    }
  };

  function runScript(name, args) {
    const pathName = args.path ?? 'exchange';
    const times = Number.isFinite(args.times) ? args.times : 1;
    const firstAccount = () => [...dbl.accounts.keys()][0];
    const account = (args.account ?? firstAccount() ?? '').toLowerCase();
    const coin = String(args.coin ?? 'ETH');
    const needCoin = () => {
      if (!byName.has(coin)) throw new Error('unknown coin');
      return coin;
    };
    const needAccount = () => {
      if (!dbl.accounts.has(account)) throw new Error('unknown account (create one with new_account)');
      return account;
    };
    const positive = (v, what) => {
      const n = Number(v);
      if (!(Number.isFinite(n) && n > 0)) throw new Error(`${what} must be a positive number`);
      return n;
    };
    switch (name) {
      case 'new_account': {
        const a = dbl.addAccount({ usd: Number(args.usd ?? 1000), abstraction: args.abstraction ?? 'default' });
        const ag = dbl.addAgent(a.address, { name: args.name ?? 'bean-garden', unnamed: Boolean(args.unnamed) });
        return { account_address: a.address, agent_address: ag.address, agent_key: `0x${ag.key}` };
      }
      case 'faucet': dbl.faucet(needAccount(), positive(args.usd ?? 1000, 'usd')); return { ok: true };
      case 'timeout': return dbl.fault({ kind: 'timeout', path: pathName, times });
      case 'http5xx': return dbl.fault({ kind: 'http', status: 502, path: pathName, times });
      case 'http429': return dbl.fault({ kind: 'http', status: 429, path: pathName, times });
      case 'http400': return dbl.fault({ kind: 'http', status: 400, text: 'Bad Request: invalid order shape', path: pathName, times });
      case 'redirect': return dbl.fault({ kind: 'redirect', path: pathName, times });
      case 'execute_then_timeout': return dbl.fault({ kind: 'execute_then_timeout', path: 'exchange', times });
      case 'partial': return dbl.fault({ kind: 'partial', fraction: Number(args.fraction ?? 0.5), path: 'exchange', type: 'order', times });
      case 'resting': return dbl.fault({ kind: 'resting', path: 'exchange', type: 'order', times });
      case 'waiting_for_fill': return dbl.fault({ kind: 'status', value: 'waitingForFill', path: 'exchange', type: 'order', times });
      case 'waiting_for_trigger': return dbl.fault({ kind: 'status', value: 'waitingForTrigger', path: 'exchange', type: 'order', times });
      case 'bare_string': return dbl.fault({ kind: 'status', value: String(args.value ?? 'somethingUnexpected'), path: 'exchange', type: 'order', times });
      case 'unknown_oid': return dbl.fault({ kind: 'unknown_oid', path: 'info', type: 'orderStatus', times });
      case 'signature_mismatch': return dbl.fault({ kind: 'signature_mismatch', path: 'exchange', type: args.type ?? '*', times });
      case 'must_deposit': return dbl.fault({ kind: 'must_deposit', path: 'exchange', type: args.type ?? '*', times });
      case 'error': return dbl.fault({ kind: 'error', code: String(args.code ?? 'rejected_other'), path: 'exchange', type: args.type ?? '*', times });
      case 'drift': {
        const sz = Number(args.sz ?? 0.01);
        if (!Number.isFinite(sz) || sz === 0) throw new Error('sz must be a non-zero number');
        return dbl.externalTrade(needAccount(), needCoin(), sz);
      }
      case 'liquidation': return dbl.liquidate(needAccount(), needCoin()) ?? { ok: false, reason: 'no position' };
      case 'revoke_agent': needAccount(); for (const [a, ag] of dbl.agents) if (ag.account === account) dbl.revokeAgent(a); return { ok: true };
      case 'expire_agent': needAccount(); for (const [a, ag] of dbl.agents) if (ag.account === account) dbl.expireAgent(a); return { ok: true };
      case 'prune_unfunded': dbl.pruneUnfunded(); return { ok: true };
      case 'clock_skew': dbl.skewMs = Number(args.ms ?? 90_000); return { ok: true };
      case 'set_mid': dbl.setMid(needCoin(), positive(args.px, 'px')); return { ok: true };
      case 'thin_book': dbl.setBook(needCoin(), { levelUsd: positive(args.level_usd ?? 5, 'level_usd') }); return { ok: true };
      case 'funding': {
        const rate = Number(args.rate ?? 0.0001);
        if (!Number.isFinite(rate) || Math.abs(rate) > 0.05) throw new Error('rate must be a number in [-0.05, 0.05]');
        dbl.applyFunding(needCoin(), rate);
        return { ok: true };
      }
      case 'abstraction': {
        const v = String(args.value ?? 'unifiedAccount');
        if (!['default', 'disabled', 'unifiedAccount', 'portfolioMargin', 'dexAbstraction'].includes(v)) throw new Error('unknown abstraction');
        dbl.setAbstraction(needAccount(), v);
        return { ok: true };
      }
      // The fail-closed mainnet guard (§6.7 step 4) from the dev panel: give an address a mainnet role (default: the
      // newest agent of `account`, role `user`), or make the mainnet userRole answer fail / never arrive.
      case 'mainnet_role': {
        let addr = args.address === undefined ? null : String(args.address).toLowerCase();
        if (addr === null) for (const [a, ag] of dbl.agents) if (ag.account === account) addr = a;
        if (!addr || !/^0x[0-9a-f]{40}$/.test(addr)) throw new Error('address must be a 0x address (or create an account first)');
        const role = String(args.role ?? 'user');
        if (!['missing', 'user', 'agent', 'vault', 'subAccount'].includes(role)) throw new Error('unknown role');
        if (role === 'missing') dbl.mainnet.roles.delete(addr);
        else dbl.mainnet.roles.set(addr, { role });
        return { ok: true, address: addr, role };
      }
      case 'mainnet_down': dbl.mainnet.fault = args.mode === 'timeout' ? 'timeout' : 'fail'; return { ok: true };
      case 'clear': dbl.clearFaults(); dbl.skewMs = 0; dbl.mainnet.fault = null; return { ok: true };
      default: throw new Error('unreachable');
    }
  }

  return dbl;
}

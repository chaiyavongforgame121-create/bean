// server/hl/info.js — read-only TESTNET info client (PLATFORM §6.1, §6.8).
//
// Every call goes through the shared HlScheduler (one weight ledger for the testnet host), with the documented weight
// and default priority, and through postJson() (redirect:'error', 8 s timeout). Responses are returned in
// Hyperliquid's own shapes (string numbers and all), lightly validated; parsing for the game lives with the callers
// (market.js here, the venue adapter in WP3). The URL is the frozen testnet constant: there is no option to change it.
//
// Every method takes an optional last argument `opts`:
//   { priority, ctx /* a lane job ctx: queued requests abort with the lane */, key, maxWaitMs }

import { normAddr } from './addr.js';
import {
  FILLS_HORIZON, FILLS_PAGE, INFO_WEIGHT, PRIORITY, TESTNET_INFO_URL,
} from './constants.js';
import { TestnetError, postJson } from './transport.js';

/** Extra weight of a time-range response: 1 per 20 items returned (§6.8). */
export const itemsWeight = (n) => Math.floor(Math.max(0, n) / 20);

const badResponse = (type) => new TestnetError(`${type}: unexpected response`, { code: 'bad_response' });

const isCloidOrOid = (v) => (typeof v === 'string' && /^0x[0-9a-f]{32}$/.test(v)) || (Number.isSafeInteger(v) && v >= 0);

export class TestnetInfo {
  /**
   * @param {object} opts
   * @param {import('./scheduler.js').HlScheduler} opts.scheduler
   * @param {typeof fetch} [opts.fetch]  injectable (tests and --testnet-double use the double)
   * @param {() => number} [opts.now]
   * @param {(line: string) => void} [opts.log]
   */
  constructor({ scheduler, fetch: fetchImpl, now = Date.now, log } = {}) {
    if (!scheduler) throw new TypeError('TestnetInfo needs a scheduler');
    this.scheduler = scheduler;
    // Resolve the global fetch lazily so the egress guard (installed by main()) always wraps it.
    this.fetch = typeof fetchImpl === 'function' ? fetchImpl : (...a) => globalThis.fetch(...a);
    this.now = now;
    this.log = typeof log === 'function' ? log : () => {};
    this.lastOkMs = 0;
    this.lastErrorMs = 0;
    this.lastError = null;
    this.counts = Object.create(null);
  }

  /**
   * One scheduled info POST.
   * @param {object} body              e.g. {type:'allMids'}
   * @param {number} weight            charged at start
   * @param {number} defaultPriority
   * @param {object} [opts]
   * @param {(json: any, job: object) => void} [extraCharge]  e.g. per-item weight
   */
  async request(body, weight, defaultPriority, opts = {}, extraCharge = null) {
    const { priority = defaultPriority, ctx = null, key, maxWaitMs } = opts ?? {};
    const type = body.type;
    const payload = JSON.stringify(body);
    return this.scheduler.run(priority, weight, async (job) => {
      this.counts[type] = (this.counts[type] ?? 0) + 1;
      try {
        const { json } = await postJson(this.fetch, TESTNET_INFO_URL, payload);
        this.lastOkMs = this.now();
        if (extraCharge) extraCharge(json, job);
        return json;
      } catch (err) {
        this.lastErrorMs = this.now();
        this.lastError = err?.code ?? 'error';
        throw err;
      }
    }, { key, ctx, maxWaitMs, label: type });
  }

  // ---- market data ----------------------------------------------------------------------------------------------

  /** allMids → {coin: number} (positive finite only). P1. */
  async allMids(opts) {
    const raw = await this.request({ type: 'allMids' }, INFO_WEIGHT.allMids, PRIORITY.MIDS, opts);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badResponse('allMids');
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    return out;
  }

  /** metaAndAssetCtxs → [meta, ctxs] (raw; universe index = asset index). P6. */
  async metaAndAssetCtxs(opts) {
    const raw = await this.request({ type: 'metaAndAssetCtxs' }, INFO_WEIGHT.metaAndAssetCtxs, PRIORITY.BACKGROUND, opts);
    if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[0]?.universe) || !Array.isArray(raw[1])) throw badResponse('metaAndAssetCtxs');
    return raw;
  }

  /** l2Book(coin) → {coin, time, levels:[bids, asks]} (raw). P6. */
  async l2Book(coin, opts) {
    if (typeof coin !== 'string' || !coin) throw new TypeError('coin required');
    const raw = await this.request({ type: 'l2Book', coin }, INFO_WEIGHT.l2Book, PRIORITY.BACKGROUND, opts);
    if (!raw || !Array.isArray(raw.levels) || raw.levels.length < 2) throw badResponse('l2Book');
    return raw;
  }

  /** exchangeStatus → {time, …} (the clock check, §6.6). P6. */
  async exchangeStatus(opts) {
    const raw = await this.request({ type: 'exchangeStatus' }, INFO_WEIGHT.exchangeStatus, PRIORITY.BACKGROUND, opts);
    if (!raw || !Number.isFinite(Number(raw.time))) throw badResponse('exchangeStatus');
    return raw;
  }

  // ---- per-user ------------------------------------------------------------------------------------------------

  /** clearinghouseState(user) (raw; positions under assetPositions[].position). P3. */
  async clearinghouseState(user, opts) {
    const raw = await this.request({ type: 'clearinghouseState', user: normAddr(user) }, INFO_WEIGHT.clearinghouseState, PRIORITY.RECONCILE, opts);
    if (!raw || typeof raw !== 'object' || !raw.marginSummary || !Array.isArray(raw.assetPositions)) throw badResponse('clearinghouseState');
    return raw;
  }

  /** spotClearinghouseState(user) (raw; balances[] with total/hold). Unified accounts. P3. */
  async spotClearinghouseState(user, opts) {
    const raw = await this.request({ type: 'spotClearinghouseState', user: normAddr(user) }, INFO_WEIGHT.spotClearinghouseState, PRIORITY.RECONCILE, opts);
    if (!raw || !Array.isArray(raw.balances)) throw badResponse('spotClearinghouseState');
    return raw;
  }

  /**
   * orderStatus(user, cloid | oid) → {status:'order', order:{order, status, statusTimestamp}} | {status:'unknownOid'}. P4.
   */
  async orderStatus(user, cloidOrOid, opts) {
    if (!isCloidOrOid(cloidOrOid)) throw new TypeError('orderStatus needs a cloid (0x + 32 hex) or an oid');
    const raw = await this.request({ type: 'orderStatus', user: normAddr(user), oid: cloidOrOid }, INFO_WEIGHT.orderStatus, PRIORITY.ORDER_STATUS, opts);
    if (!raw || (raw.status !== 'order' && raw.status !== 'unknownOid')) throw badResponse('orderStatus');
    return raw;
  }

  /**
   * userFillsByTime(user, start, end?) — paginated (§6.11): while a page returns ≥ 500 rows, ask again from the last
   * fill's time and de-duplicate by `tid`. Each page is charged 20 + 1 per 20 items. P5. `opts.maxWaitMs` bounds
   * only when the read STARTS (its first page): once started, the remaining pages complete, so a long history is never
   * abandoned half-read (and re-paid) at every attempt.
   * @returns {Promise<object[]>} fills, oldest first. Non-enumerable `.meta = {pages, horizon}`: `horizon` is true
   *   when 10,000 fills came back, so older fills in the range may no longer exist (§6.11 fills_beyond_horizon).
   */
  async userFillsByTime(user, startTime, endTime = null, opts = {}) {
    if (endTime !== null && typeof endTime === 'object') [endTime, opts] = [null, endTime]; // (user, start, opts)
    const addr = normAddr(user);
    if (!Number.isSafeInteger(startTime) || startTime < 0) throw new TypeError('startTime must be ms');
    const byTid = new Map();
    const loose = []; // fills without a tid (should not happen; kept, not de-duplicated)
    let since = startTime;
    let pages = 0;
    const maxPages = Math.ceil(FILLS_HORIZON / FILLS_PAGE) + 5;
    for (;;) {
      const body = { type: 'userFillsByTime', user: addr, startTime: since };
      if (endTime !== null && endTime !== undefined) body.endTime = endTime;
      const pageOpts = pages === 0 ? opts : { ...opts, maxWaitMs: undefined };
      const page = await this.request(body, INFO_WEIGHT.userFillsByTime, PRIORITY.FILLS, pageOpts,
        (json, job) => job.charge(itemsWeight(Array.isArray(json) ? json.length : 0)));
      if (!Array.isArray(page)) throw badResponse('userFillsByTime');
      pages++;
      let added = 0;
      let last = since;
      for (const f of page) {
        if (!f || typeof f !== 'object') continue;
        const t = Number(f.time);
        if (Number.isFinite(t) && t > last) last = t;
        if (f.tid === undefined || f.tid === null) {
          loose.push(f);
          added++;
        } else if (!byTid.has(f.tid)) {
          byTid.set(f.tid, f);
          added++;
        }
      }
      if (page.length < FILLS_PAGE || pages >= maxPages) break;
      // A full page: ask again from the last fill's time (inclusive; duplicates are dropped by tid). If the page added
      // nothing new (≥ 500 fills in one millisecond), step past that millisecond instead of looping.
      since = added === 0 ? last + 1 : last;
    }
    const fills = [...byTid.values(), ...loose].sort((a, b) => Number(a.time) - Number(b.time) || Number(a.tid ?? 0) - Number(b.tid ?? 0));
    Object.defineProperty(fills, 'meta', { value: Object.freeze({ pages, horizon: fills.length >= FILLS_HORIZON }), enumerable: false });
    return fills;
  }

  /**
   * userFunding(user, start, end?) → [{time, hash, delta:{type:'funding', coin, usdc, szi, fundingRate}}]. P5.
   * Paginated like userFillsByTime: a time-range response holds at most 500 rows (ascending from startTime; verified
   * read-only on the real /info), so while a page is full we ask again from its last row's time and de-duplicate by
   * (time, coin, hash) — funding rows carry a zero hash, so one row per coin per funding time. Each page is charged.
   * `opts.maxPages` (default 20) bounds the cost; the result's non-enumerable `.meta = {pages, complete}` says whether
   * the whole range was read (`complete: false` → a partial sum, which callers must never treat as exact).
   */
  async userFunding(user, startTime, endTime = null, opts = {}) {
    if (endTime !== null && typeof endTime === 'object') [endTime, opts] = [null, endTime]; // (user, start, opts)
    if (!Number.isSafeInteger(startTime) || startTime < 0) throw new TypeError('startTime must be ms');
    const maxPages = Number.isSafeInteger(opts?.maxPages) && opts.maxPages > 0 ? opts.maxPages : 20;
    const addr = normAddr(user);
    const seen = new Map();
    let since = startTime;
    let pages = 0;
    let complete = false;
    for (;;) {
      const body = { type: 'userFunding', user: addr, startTime: since };
      if (endTime !== null && endTime !== undefined) body.endTime = endTime;
      const page = await this.request(body, INFO_WEIGHT.userFunding, PRIORITY.FILLS, opts,
        (json, job) => job.charge(itemsWeight(Array.isArray(json) ? json.length : 0)));
      if (!Array.isArray(page)) throw badResponse('userFunding');
      pages++;
      let added = 0;
      let last = since;
      for (const r of page) {
        if (!r || typeof r !== 'object') continue;
        const t = Number(r.time);
        if (Number.isFinite(t) && t > last) last = t;
        const key = `${r.time}|${r.delta?.coin ?? ''}|${r.hash ?? ''}`;
        if (!seen.has(key)) {
          seen.set(key, r);
          added++;
        }
      }
      if (page.length < FILLS_PAGE) {
        complete = true;
        break;
      }
      if (pages >= maxPages) break;
      // A full page: ask again from its last row's time (inclusive; duplicates dropped). A page that added nothing new
      // (≥ 500 rows in one millisecond) steps past that millisecond instead of looping.
      since = added === 0 ? last + 1 : last;
    }
    const rows = [...seen.values()].sort((a, b) => Number(a.time) - Number(b.time));
    Object.defineProperty(rows, 'meta', { value: Object.freeze({ pages, complete }), enumerable: false });
    return rows;
  }

  /** userRole(addr) → {role:'missing'|'user'|'agent'|'vault'|'subAccount', data?} (raw; data.user may be mixed-case). P7. */
  async userRole(addr, opts) {
    const raw = await this.request({ type: 'userRole', user: normAddr(addr) }, INFO_WEIGHT.userRole, PRIORITY.VERIFY, opts);
    if (!raw || typeof raw.role !== 'string') throw badResponse('userRole');
    return raw;
  }

  /** extraAgents(user) → [{name, address, validUntil}] (named agents only). P7. */
  async extraAgents(user, opts) {
    const raw = await this.request({ type: 'extraAgents', user: normAddr(user) }, INFO_WEIGHT.extraAgents, PRIORITY.VERIFY, opts);
    if (!Array.isArray(raw)) throw badResponse('extraAgents');
    return raw;
  }

  /** userAbstraction(user) → 'default'|'disabled'|'unifiedAccount'|'portfolioMargin'|'dexAbstraction'. P7. */
  async userAbstraction(user, opts) {
    const raw = await this.request({ type: 'userAbstraction', user: normAddr(user) }, INFO_WEIGHT.userAbstraction, PRIORITY.VERIFY, opts);
    const v = typeof raw === 'string' ? raw : (raw && typeof raw.abstraction === 'string' ? raw.abstraction : null);
    if (v === null) throw badResponse('userAbstraction');
    return v;
  }

  /** userRateLimit(user) → {cumVlm, nRequestsUsed, nRequestsCap, …} (the address budget, §6.8). P6. */
  async userRateLimit(user, opts) {
    const raw = await this.request({ type: 'userRateLimit', user: normAddr(user) }, INFO_WEIGHT.userRateLimit, PRIORITY.BACKGROUND, opts);
    if (!raw || !Number.isFinite(Number(raw.nRequestsUsed)) || !Number.isFinite(Number(raw.nRequestsCap))) throw badResponse('userRateLimit');
    return raw;
  }

  stats() {
    return { last_ok_ms: this.lastOkMs || null, last_error_ms: this.lastErrorMs || null, last_error: this.lastError, requests: { ...this.counts } };
  }
}

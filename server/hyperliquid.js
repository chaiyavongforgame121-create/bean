// server/hyperliquid.js — a READ-ONLY client for Hyperliquid's public info endpoint (GAME-DESIGN §10.2).
//
// Only `POST https://api.hyperliquid.xyz/info` is ever called, with three public request types:
//   {"type":"allMids"}                                   weight 2     live mid per coin (every ~5 s)
//   {"type":"metaAndAssetCtxs"}                          weight 20    listing (szDecimals, maxLeverage) + day stats
//   {"type":"candleSnapshot","req":{coin,interval,…}}    weight 20 + 1 per 60 candles returned
// No keys, no signing, no exchange endpoint, no orders: there is no code path here that could send one.
//
// Rate limiting (HL allows 1200 weight/min per IP): a rolling 60 s weight ledger with our own budget.
//   • `skip` requests (allMids, metaAndAssetCtxs) are NOT sent when they would exceed the budget, or during
//     a back-off; they fail fast with HlError{skipped:true}.
//   • `queue` requests (candles) wait until the ledger (and any back-off) allows them, up to a deadline.
//   • HTTP 429 → a 15 s back-off for every request.
// Boot-time bursts (warm-up / re-warm / long catch-up candles: 16 × 68 = 1088 weight for 2880 bars) may use
// BOOT_BUDGET instead of LEDGER_BUDGET — still under HL's 1200 — so a fresh start does not stall a minute.
//
// Everything that touches the outside world is injectable (fetch, clock, sleep), so tests run offline.
//
// Platform additions (PLATFORM §1.2 rules 8–9, §6.7 step 4; additive only, none-mode behaviour unchanged):
//   • without an injected `fetch`, the URL must be exactly HL_INFO_URL (asserted in the constructor and before every
//     request), and the global fetch is resolved at call time so the egress guard installed by main() applies;
//   • every request passes `redirect: 'error'`;
//   • `userRole(addr)` — the fail-closed mainnet guard for testnet API wallets. Weight 60, lowest priority (it never
//     uses the BOOT_BUDGET headroom), and a shared slot of ≤ 2 per rolling minute for connects and periodic
//     re-checks, connects first.

export const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
/** userRole weight (Hyperliquid rate-limits page) and the shared mainnet slot (§6.7, §6.8). */
export const USER_ROLE_WEIGHT = 60;
export const USER_ROLE_PER_MIN = 2;
export const HL_TIMEOUT_MS = 8_000;
export const LEDGER_WINDOW_MS = 60_000;
/** Our steady-state budget per rolling minute (HL's own limit is 1200). */
export const LEDGER_BUDGET = 1000;
/** Budget for one-off candle bursts (warm-up, re-warm, long catch-up). Still below HL's 1200. */
export const BOOT_BUDGET = 1150;
export const BACKOFF_MS = 15_000;
/** HL keeps only the newest 5000 candles per coin and interval. */
export const MAX_CANDLES = 5000;
export const WEIGHT = Object.freeze({ allMids: 2, metaAndAssetCtxs: 20, candleSnapshot: 20 });

/** Weight of a candleSnapshot that returns `n` candles: 20 + 1 per 60 candles. */
export function candleWeight(n) {
  return WEIGHT.candleSnapshot + Math.floor(Math.max(0, n) / 60);
}

const defaultSleep = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, Math.max(0, ms));
  t.unref?.();
});

/** A failed or skipped info request. `skipped` = never sent (budget, back-off or deadline). */
export class HlError extends Error {
  constructor(message, { status = null, skipped = false } = {}) {
    super(message);
    this.name = 'HlError';
    this.status = status;
    this.skipped = skipped;
  }
}

/** Rolling-window weight ledger: what we spent on HL in the last `windowMs`. */
export class WeightLedger {
  constructor({ windowMs = LEDGER_WINDOW_MS, budget = LEDGER_BUDGET, now = Date.now } = {}) {
    this.windowMs = windowMs;
    this.budget = budget;
    this.now = now;
    this.entries = []; // [t, weight], oldest first
  }

  #prune(now) {
    const from = now - this.windowMs;
    let k = 0;
    while (k < this.entries.length && this.entries[k][0] <= from) k++;
    if (k) this.entries.splice(0, k);
  }

  /** Weight spent in the window ending at `now`. */
  used(now = this.now()) {
    this.#prune(now);
    let sum = 0;
    for (const [, w] of this.entries) sum += w;
    return sum;
  }

  fits(weight, budget = this.budget, now = this.now()) {
    return this.used(now) + weight <= budget;
  }

  record(weight, now = this.now()) {
    if (weight > 0) this.entries.push([now, weight]);
  }

  /** ms until `weight` fits under `budget` (0 = now; Infinity = never, the weight alone is over budget). */
  waitMs(weight, budget = this.budget, now = this.now()) {
    if (weight > budget) return Infinity;
    let used = this.used(now);
    if (used + weight <= budget) return 0;
    for (const [t, w] of this.entries) {
      used -= w;
      if (used + weight <= budget) return t + this.windowMs - now + 1;
    }
    return this.windowMs;
  }
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export class HyperliquidClient {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetch]   injectable for tests (default: global fetch)
   * @param {() => number} [opts.now]     clock (ms)
   * @param {(ms:number) => Promise<void>} [opts.sleep]
   * @param {number} [opts.budget]        steady-state ledger budget per 60 s
   * @param {number} [opts.timeoutMs]     per-request timeout (AbortSignal.timeout)
   * @param {(line:string) => void} [opts.log]
   */
  constructor({ fetch: fetchImpl, now = Date.now, sleep = defaultSleep, budget = LEDGER_BUDGET,
    timeoutMs = HL_TIMEOUT_MS, url = HL_INFO_URL, log = () => {} } = {}) {
    // An injected fetch (tests, the offline double) may target any URL; the real network may only reach HL_INFO_URL.
    // (An explicit `fetch: null` keeps today's behaviour: requests fail with "fetch is not available".)
    this.injectedFetch = fetchImpl !== undefined;
    if (!this.injectedFetch && url !== HL_INFO_URL) throw new HlError('HyperliquidClient: url must be HL_INFO_URL without an injected fetch');
    this.fetch = this.injectedFetch ? fetchImpl : globalThis.fetch;
    this.now = now;
    this.sleep = sleep;
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.log = typeof log === 'function' ? log : () => {};
    this.ledger = new WeightLedger({ budget, now });
    this.backoffUntil = 0;
    this.stats = {
      requests: { allMids: 0, metaAndAssetCtxs: 0, candleSnapshot: 0 },
      errors: 0,
      rate_limited: 0,
      skipped: 0,
      last_ok_ms: 0,
      last_error_ms: 0,
      last_error: null,
    };
    // userRole slot (mainnet guard): FIFO queues per kind, connects served first; ≤ USER_ROLE_PER_MIN per 60 s.
    this.roleSlots = [];
    this.roleQueue = { connect: [], recheck: [] };
    this.roleTimer = null;
    this.roleStats = { requests: 0, queued_max: 0, skipped: 0 };
  }

  /** True while a 429 back-off is running. */
  inBackoff(now = this.now()) {
    return now < this.backoffUntil;
  }

  /** Weight spent in the last 60 s. */
  weight60s() {
    return this.ledger.used();
  }

  /** Counters for status/diagnostics (copy). */
  snapshot() {
    return { ...this.stats.requests, errors: this.stats.errors, rate_limited: this.stats.rate_limited, skipped: this.stats.skipped };
  }

  /**
   * POST one info request.
   * @param {object} body   e.g. {type:'allMids'}
   * @param {object} opts
   * @param {number} opts.weight          weight charged up front
   * @param {boolean} [opts.queue=false]  wait for budget/back-off (true) or skip (false)
   * @param {number} [opts.budget]        override the ledger budget (boot bursts)
   * @param {number} [opts.deadlineMs]    queue mode: give up (skipped) rather than wait past this time
   */
  async post(body, { weight, queue = false, budget = this.ledger.budget, deadlineMs = Infinity } = {}) {
    const type = body?.type;
    for (;;) {
      const now = this.now();
      const backoff = Math.max(0, this.backoffUntil - now);
      const ledgerWait = this.ledger.waitMs(weight, budget, now);
      const wait = Math.max(backoff, ledgerWait);
      if (wait === 0) break;
      if (!queue || !Number.isFinite(wait) || now + wait > deadlineMs) {
        this.stats.skipped++;
        throw new HlError(`${type}: skipped (${backoff > 0 ? 'rate-limit back-off' : 'weight budget'})`, { skipped: true });
      }
      await this.sleep(wait);
    }
    const fetchImpl = this.injectedFetch ? this.fetch : globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new HlError('fetch is not available');
    if (!this.injectedFetch && this.url !== HL_INFO_URL) throw new HlError('refusing a non-HL_INFO_URL request');
    this.ledger.record(weight);
    if (type in this.stats.requests) this.stats.requests[type]++;
    let res;
    try {
      res = await fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw this.#fail(new HlError(`${type}: ${err?.name === 'TimeoutError' ? 'timed out' : err?.message || err}`));
    }
    if (res.status === 429) {
      this.backoffUntil = this.now() + BACKOFF_MS;
      this.stats.rate_limited++;
      throw this.#fail(new HlError(`${type}: HTTP 429 (rate limited) — backing off ${BACKOFF_MS / 1000} s`, { status: 429 }));
    }
    if (!res.ok) throw this.#fail(new HlError(`${type}: HTTP ${res.status}`, { status: res.status }));
    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw this.#fail(new HlError(`${type}: invalid JSON (${err?.message || err})`));
    }
    this.stats.last_ok_ms = this.now();
    return json;
  }

  #fail(err) {
    this.stats.errors++;
    this.stats.last_error_ms = this.now();
    this.stats.last_error = err.message;
    return err;
  }

  /**
   * allMids → { [coin]: number } (skip mode). It is the ~5 s heartbeat (marks, mid-built bars, feed state) and
   * weighs 2, so it may use the BOOT_BUDGET ceiling (still under HL's 1200): right after a cold-start warm-up burst
   * (~1110) the steady 1000 budget would otherwise silence it for a whole minute.
   */
  async allMids() {
    const raw = await this.post({ type: 'allMids' }, { weight: WEIGHT.allMids, budget: BOOT_BUDGET });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw this.#fail(new HlError('allMids: unexpected response'));
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const n = num(v);
      if (n !== null && n > 0) out[k] = n;
    }
    return out;
  }

  /**
   * metaAndAssetCtxs → { [coin]: { sz_decimals, max_leverage, delisted, mid_px, mark_px, oracle_px, prev_day_px,
   * funding_1h, open_interest, day_ntl_vlm } } — universe[i] and ctxs[i] aligned by index (skip mode).
   */
  async metaAndAssetCtxs() {
    const raw = await this.post({ type: 'metaAndAssetCtxs' }, { weight: WEIGHT.metaAndAssetCtxs });
    return parseMetaAndAssetCtxs(raw, (msg) => { throw this.#fail(new HlError(msg)); });
  }

  /**
   * 1-minute candles with open time in [startTime, endTime] → [{t, T, o, h, l, c, v, n}] (numbers), queue mode.
   * HL also returns the in-progress candle when endTime reaches it; callers pick what they need.
   */
  async candles(coin, startTime, endTime, { budget, deadlineMs } = {}) {
    const expected = Math.min(MAX_CANDLES, Math.max(1, Math.floor((endTime - startTime) / 60_000) + 1));
    const weight = candleWeight(expected);
    const raw = await this.post(
      { type: 'candleSnapshot', req: { coin, interval: '1m', startTime, endTime } },
      { weight, queue: true, budget, deadlineMs },
    );
    if (!Array.isArray(raw)) throw this.#fail(new HlError(`candleSnapshot ${coin}: unexpected response`));
    const extra = candleWeight(raw.length) - weight; // charge what HL actually charged us
    if (extra > 0) this.ledger.record(extra);
    return parseCandles(raw);
  }

  /**
   * MAINNET userRole(addr) → {role: 'missing'|'user'|'agent'|'vault'|'subAccount', data?} — the fail-closed mainnet
   * guard for testnet API wallets (PLATFORM §6.7 step 4). Read-only, weight 60, queue mode at the steady budget (never
   * the boot headroom, so it can never starve allMids), and at most USER_ROLE_PER_MIN per rolling minute shared by
   * connects and periodic re-checks, connects first. Rejects with HlError (skipped) if it cannot start in time.
   * @param {string} addr  0x address (lower-cased before sending)
   * @param {object} [opts]
   * @param {'connect'|'recheck'} [opts.kind='recheck']
   * @param {number} [opts.timeoutMs=10000]  give up if the request cannot START within this time
   */
  async userRole(addr, { kind = 'recheck', timeoutMs = 10_000 } = {}) {
    if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new HlError('userRole: bad address');
    const user = addr.toLowerCase();
    const deadline = this.now() + Math.max(0, timeoutMs);
    await this.#roleSlot(kind === 'connect' ? 'connect' : 'recheck', deadline);
    this.roleStats.requests++;
    const raw = await this.post({ type: 'userRole', user }, { weight: USER_ROLE_WEIGHT, queue: true, deadlineMs: deadline });
    if (!raw || typeof raw !== 'object' || typeof raw.role !== 'string') throw this.#fail(new HlError('userRole: unexpected response'));
    return raw;
  }

  /** Wait for a userRole slot (≤ USER_ROLE_PER_MIN per 60 s), connects before re-checks. */
  #roleSlot(kind, deadline) {
    return new Promise((resolve, reject) => {
      this.roleQueue[kind].push({ resolve, reject, deadline });
      const queued = this.roleQueue.connect.length + this.roleQueue.recheck.length;
      if (queued > this.roleStats.queued_max) this.roleStats.queued_max = queued;
      this.#pumpRoles();
    });
  }

  #pumpRoles() {
    const now = this.now();
    while (this.roleSlots.length && this.roleSlots[0] <= now - LEDGER_WINDOW_MS) this.roleSlots.shift();
    // Drop waiters whose deadline passed (fail-closed upstream: 'unavailable').
    for (const q of [this.roleQueue.connect, this.roleQueue.recheck]) {
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].deadline < now) {
          this.roleStats.skipped++;
          q.splice(i, 1)[0].reject(new HlError('userRole: skipped (slot deadline)', { skipped: true }));
        }
      }
    }
    while (this.roleSlots.length < USER_ROLE_PER_MIN) {
      const next = this.roleQueue.connect.shift() ?? this.roleQueue.recheck.shift();
      if (!next) break;
      this.roleSlots.push(now);
      next.resolve();
    }
    const waiting = this.roleQueue.connect.length + this.roleQueue.recheck.length;
    if (waiting && !this.roleTimer) {
      const wait = Math.max(1, this.roleSlots[0] + LEDGER_WINDOW_MS - now + 1);
      const soonest = Math.min(...[...this.roleQueue.connect, ...this.roleQueue.recheck].map((w) => w.deadline)) - now + 1;
      this.roleTimer = true;
      this.sleep(Math.max(1, Math.min(wait, soonest))).then(() => {
        this.roleTimer = null;
        this.#pumpRoles();
      });
    }
  }

  /** Mainnet userRole queue counters (admin_status.mainnet.user_role_queue). */
  roleSnapshot() {
    return { ...this.roleStats, queued: this.roleQueue.connect.length + this.roleQueue.recheck.length, slots_used_60s: this.roleSlots.length };
  }
}

/** HL candles (string numbers) → numeric candles, dropping malformed ones. */
export function parseCandles(raw) {
  const out = [];
  for (const k of Array.isArray(raw) ? raw : []) {
    const t = num(k?.t), o = num(k?.o), h = num(k?.h), l = num(k?.l), c = num(k?.c);
    if (t === null || !(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    out.push({ t, T: num(k.T) ?? t + 59_999, o, h, l, c, v: num(k.v) ?? 0, n: num(k.n) ?? 0 });
  }
  return out;
}

/** [meta, ctxs] → per-coin listing + day stats (aligned by index). */
export function parseMetaAndAssetCtxs(raw, fail = (msg) => { throw new HlError(msg); }) {
  if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[0]?.universe) || !Array.isArray(raw[1])) {
    return fail('metaAndAssetCtxs: unexpected response');
  }
  const [meta, ctxs] = raw;
  const out = {};
  meta.universe.forEach((u, i) => {
    if (!u || typeof u.name !== 'string') return;
    const c = ctxs[i] ?? {};
    out[u.name] = {
      sz_decimals: Number.isInteger(u.szDecimals) ? u.szDecimals : null,
      max_leverage: Number.isFinite(u.maxLeverage) && u.maxLeverage > 0 ? u.maxLeverage : null,
      delisted: u.isDelisted === true,
      mid_px: num(c.midPx),
      mark_px: num(c.markPx),
      oracle_px: num(c.oraclePx),
      prev_day_px: num(c.prevDayPx),
      funding_1h: num(c.funding), // HL funding is an hourly rate
      open_interest: num(c.openInterest),
      day_ntl_vlm: num(c.dayNtlVlm),
    };
  });
  return out;
}

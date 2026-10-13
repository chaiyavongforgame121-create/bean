// server/garden/repo.js — write-through persistence of the gardens (PLATFORM §3, §3.5, §7.2). Accounts mode only.
//
// One GardenRepo serves every garden of the process: SQLite has one writer and one connection (§3.2), so the repo
// owns the prepared statements and a WRITE BUFFER:
//
//   buffered (paper)      garden rows, bot rows, paper fills and orders, and user events are queued in memory and
//                         written by flush() in ONE transaction, with ONE SAVEPOINT PER GARDEN (§3.5): a row that
//                         throws (a constraint, an unexpected value) rolls back only that garden's savepoint, is
//                         logged as an alert, and that garden is retried at the next flush. Other players' writes
//                         still commit. Gardens.afterTick() and every garden command end with a flush; anything
//                         queued from an async callback is flushed on the next macrotask (scheduleFlush).
//   immediate (testnet)   the write-ahead order row and the nonce (one transaction, committed BEFORE the POST, §6.6),
//                         order outcome updates, and exchange fills. Every immediate write flushes the buffer first,
//                         so rows reach the DB in the order they happened.
//
// Reads (fills, orders, events) flush first, so a query never misses a buffered row.
//
// SQL rule (§3.2, scanned by db.test.js): every statement is a constant string; values only travel through `?`
// bindings. Variable lists use `json_each(?)` instead of building `IN (?, ?, …)` text.
//
// The `db` handle is WP1's `openDb()` result: { tx(fn), prepare(sql), exec(sql), close(), file }. Only tx() and
// prepare() are used here (savepoints are prepared statements, not exec()).

import crypto from 'node:crypto';

import { tagUserRecord } from '../journal.js';

/** Columns of `bots` that are stored as columns; everything else of the in-memory bot goes to data_json. */
const BOT_COLUMNS = new Set(['id', 'index', 'venue', 'bean', 'coin', 'asset', 'capital_usd', 'leverage', 'state',
  'created_ms', 'updated_ms', 'closed_ms']);
/** In-memory bot fields that are never persisted (recomputed after a load). */
const BOT_TRANSIENT = new Set(['skip_key', 'sync_tries']); // in-memory only (live.js); never in data_json

/** Keys a journal record owns; the rest of the record is `events.data_json`. */
const EVENT_OWN_KEYS = new Set(['seq', 't', 'kind']);

/** A garden whose rows fail this many flushes in a row is dropped (alerted), never retried forever. */
export const MAX_FLUSH_FAILURES = 5;

/** Most rows a fills/orders query returns (the in-memory rings hold far fewer in accounts mode). */
export const QUERY_MAX = 2000;

/** Order statuses that are not resolved yet (testnet; §6.6 / §6.11). */
export const UNRESOLVED_ORDER_STATUSES = Object.freeze(['pending', 'sent', 'unknown']);

const bool01 = (v) => (v ? 1 : 0);
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const intOrNull = (v) => (Number.isSafeInteger(v) ? v : null);
const strOrNull = (v) => (typeof v === 'string' ? v : null);
const clampLimit = (v, dflt = 100) => {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return dflt;
  return Math.min(QUERY_MAX, Math.max(0, Math.trunc(n)));
};

/** Random 16-hex garden epoch (§7.2). */
export function newEpoch() {
  return crypto.randomBytes(8).toString('hex');
}

/** JSON.stringify that never throws (a cycle or a BigInt in bot data would otherwise poison a whole flush). */
function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

/**
 * The in-memory bot as a `bots` row: the column fields plus data_json with everything else (minus transients).
 * `leverage` is an INTEGER column (≥ 1) for queries; the exact value lives in data_json.
 */
export function botToRow(uid, bot) {
  const data = {};
  for (const [k, v] of Object.entries(bot)) {
    if (BOT_COLUMNS.has(k) || BOT_TRANSIENT.has(k)) continue;
    data[k] = v;
  }
  data.leverage_exact = bot.leverage;
  return {
    user_id: uid,
    id: bot.id,
    idx: bot.index,
    venue: bot.venue === 'testnet' ? 'testnet' : 'paper',
    bean: bot.bean,
    coin: bot.coin,
    asset: intOrNull(bot.asset),
    capital_usd: bot.capital_usd,
    leverage: Math.max(1, Math.round(Number(bot.leverage) || 1)),
    state: bot.state,
    created_ms: Math.trunc(Number(bot.created_ms) || 0),
    updated_ms: Math.trunc(Number(bot.updated_ms) || 0),
    closed_ms: intOrNull(bot.closed_ms),
    data_json: safeJson(data),
  };
}

/** A `bots` row back to a raw bot object (sanitizeBot in live.js validates it). */
export function rowToBot(row) {
  let data = {};
  try {
    data = JSON.parse(row.data_json) ?? {};
  } catch {
    data = {};
  }
  const leverage = Number.isFinite(data.leverage_exact) ? data.leverage_exact : row.leverage;
  delete data.leverage_exact;
  return {
    ...data,
    id: row.id,
    index: row.idx,
    venue: row.venue,
    bean: row.bean,
    coin: row.coin,
    asset: row.asset ?? null,
    capital_usd: row.capital_usd,
    leverage,
    state: row.state,
    created_ms: row.created_ms,
    updated_ms: row.updated_ms,
    closed_ms: row.closed_ms ?? null,
  };
}

/** A `fills` row as the API Fill (SPEC §4 keys first, then the accounts-mode additions of §8.5). */
export function fillRowToApi(r) {
  return {
    bot: r.bot_id,
    coin: r.coin,
    dir: r.dir,
    side: r.side,
    sz: r.sz,
    px: r.px,
    fee: r.fee,
    closed_pnl: r.closed_pnl,
    time_ms: r.time_ms,
    tick: r.tick ?? null,
    venue: r.venue,
    oid: r.oid ?? null,
    tid: r.tid ?? null,
    hash: r.hash ?? null,
    provisional: r.provisional === 1,
    season: r.season,
    liquidation: r.liquidation === 1,
  };
}

/** An `orders` row as the API Order (SPEC §4 keys first, then §8.5). */
export function orderRowToApi(r) {
  return {
    bot: r.bot_id,
    coin: r.coin,
    kind: r.kind,
    sz: r.sz,
    px: r.px ?? null,
    status: r.status,
    reason: r.reason ?? null,
    time_ms: r.time_ms,
    tick: r.tick ?? null,
    venue: r.venue,
    cloid: r.cloid ?? null,
    oid: r.oid ?? null,
    reduce_only: r.reduce_only === 1,
    code: r.code ?? null,
    error: r.error ?? null,
    filled_sz: r.filled_sz ?? null,
    avg_px: r.avg_px ?? null,
    leverage: r.leverage ?? null,
  };
}

// ---- SQL (constant strings only; §3.2) ---------------------------------------------------------------------------

const SQL = Object.freeze({
  sp: 'SAVEPOINT garden_flush',
  spRelease: 'RELEASE SAVEPOINT garden_flush',
  spRollback: 'ROLLBACK TO SAVEPOINT garden_flush',

  username: 'SELECT username, status, role FROM users WHERE id = ?',
  gardenGet: 'SELECT * FROM gardens WHERE user_id = ?',
  gardenInsert: `INSERT INTO gardens (user_id, epoch, season, season_started_ms, last_active_ms, account_usd,
      next_bot_index, halted, fills_logged, created_ms, updated_ms)
    VALUES (?, ?, 1, ?, ?, ?, 0, 0, 0, ?, ?) ON CONFLICT(user_id) DO NOTHING`,
  gardenUpdate: `UPDATE gardens SET season = ?, season_started_ms = ?, last_reset_ms = ?, account_usd = ?,
      next_bot_index = ?, halted = ?, halted_ms = ?, fills_logged = ?, last_error = ?, last_error_ms = ?,
      last_reconcile_ms = ?, last_tick = ?, updated_ms = ?
    WHERE user_id = ?`,
  gardenTouch: 'UPDATE gardens SET last_active_ms = ? WHERE user_id = ? AND last_active_ms < ?',
  gardenCaps: 'UPDATE gardens SET caps_json = ?, updated_ms = ? WHERE user_id = ?',
  gardensInactive: `SELECT DISTINCT g.user_id AS user_id FROM gardens g
    JOIN bots b ON b.user_id = g.user_id AND b.state <> 'closed' AND b.venue = 'testnet'
    WHERE g.last_active_ms < ?`,

  botsLoad: 'SELECT * FROM bots WHERE user_id = ? ORDER BY idx',
  botUpsert: `INSERT INTO bots (user_id, id, idx, venue, bean, coin, asset, capital_usd, leverage, state, created_ms,
      updated_ms, closed_ms, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET venue = excluded.venue, bean = excluded.bean, coin = excluded.coin,
      asset = excluded.asset, capital_usd = excluded.capital_usd, leverage = excluded.leverage,
      state = excluded.state, updated_ms = excluded.updated_ms, closed_ms = excluded.closed_ms,
      data_json = excluded.data_json`,
  openBotUsers: "SELECT DISTINCT user_id FROM bots WHERE state <> 'closed'",
  openTestnetUsers: "SELECT DISTINCT user_id FROM bots WHERE state <> 'closed' AND venue = 'testnet'",
  openBotCounts: `SELECT venue, count(*) AS n FROM bots WHERE state <> 'closed' GROUP BY venue`,

  fillInsert: `INSERT INTO fills (user_id, bot_id, venue, season, coin, dir, start_position, side, sz, px, fee,
      closed_pnl, time_ms, tick, liquidation, replay, order_id, oid, tid, hash, provisional)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  fillInsertIgnore: `INSERT OR IGNORE INTO fills (user_id, bot_id, venue, season, coin, dir, start_position, side, sz,
      px, fee, closed_pnl, time_ms, tick, liquidation, replay, order_id, oid, tid, hash, provisional)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  fillsDeleteProvisional: 'DELETE FROM fills WHERE user_id = ? AND order_id = ? AND provisional = 1',
  fillsByUser: `SELECT * FROM fills WHERE user_id = ? AND (venue = 'testnet' OR season = ?)
    ORDER BY id DESC LIMIT ?`,
  fillsByBot: `SELECT * FROM fills WHERE user_id = ? AND bot_id = ? AND (venue = 'testnet' OR season = ?)
    ORDER BY id DESC LIMIT ?`,
  fillsCountUser: "SELECT count(*) AS n FROM fills WHERE user_id = ? AND (venue = 'testnet' OR season = ?)",
  fillsCountBot: "SELECT count(*) AS n FROM fills WHERE user_id = ? AND bot_id = ? AND (venue = 'testnet' OR season = ?)",
  fillsBotAll: 'SELECT * FROM fills WHERE user_id = ? AND bot_id = ? ORDER BY id',
  fillsTidsSince: 'SELECT tid FROM fills WHERE user_id = ? AND venue = ? AND tid IS NOT NULL AND time_ms >= ?',
  fillsProvisionalUser: 'SELECT count(*) AS n FROM fills WHERE user_id = ? AND provisional = 1',
  fillsOldestProvisional: 'SELECT min(time_ms) AS t FROM fills WHERE user_id = ? AND provisional = 1',

  orderInsert: `INSERT INTO orders (user_id, bot_id, venue, season, kind, coin, sz, px, reduce_only, status, reason,
      code, error, cloid, oid, nonce, attempts, transport_failed, leverage, filled_sz, avg_px, tick, time_ms,
      sent_ms, done_ms, replay)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  orderUpdate: `UPDATE orders SET status = ?, code = ?, error = ?, oid = ?, nonce = ?, attempts = ?,
      transport_failed = ?, filled_sz = ?, avg_px = ?, sent_ms = ?, done_ms = ?
    WHERE id = ? AND user_id = ?`,
  orderGet: 'SELECT * FROM orders WHERE id = ? AND user_id = ?',
  ordersByUser: `SELECT * FROM orders WHERE user_id = ? AND (venue = 'testnet' OR season = ?)
    ORDER BY id DESC LIMIT ?`,
  ordersByBot: `SELECT * FROM orders WHERE user_id = ? AND bot_id = ? AND (venue = 'testnet' OR season = ?)
    ORDER BY id DESC LIMIT ?`,
  ordersCountUser: "SELECT count(*) AS n FROM orders WHERE user_id = ? AND (venue = 'testnet' OR season = ?)",
  ordersCountBot: "SELECT count(*) AS n FROM orders WHERE user_id = ? AND bot_id = ? AND (venue = 'testnet' OR season = ?)",
  ordersUnresolved: `SELECT * FROM orders WHERE user_id = ? AND venue = 'testnet'
    AND status IN ('pending', 'sent', 'unknown') ORDER BY id`,
  ordersUnresolvedUsers: `SELECT DISTINCT user_id FROM orders WHERE venue = 'testnet'
    AND status IN ('pending', 'sent', 'unknown')`,
  orderByOid: "SELECT * FROM orders WHERE user_id = ? AND venue = 'testnet' AND oid = ?",

  nonceGet: "SELECT last_nonce FROM credentials WHERE user_id = ? AND venue = 'hl_testnet'",
  nonceSet: "UPDATE credentials SET last_nonce = ?, updated_ms = ? WHERE user_id = ? AND venue = 'hl_testnet'",

  eventInsert: 'INSERT OR IGNORE INTO events (seq, user_id, t, kind, data_json) VALUES (?, ?, ?, ?, ?)',
  eventsSince: 'SELECT * FROM events WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?',
  eventsQuery: `SELECT * FROM events WHERE user_id = ?
    AND (? IS NULL OR kind IN (SELECT value FROM json_each(?))) ORDER BY seq DESC LIMIT ?`,
  eventsCount: `SELECT count(*) AS n FROM events WHERE user_id = ?
    AND (? IS NULL OR kind IN (SELECT value FROM json_each(?)))`,
  eventsMax: 'SELECT max(seq) AS m FROM events',

  adminGet: 'SELECT value_json, updated_ms, updated_by FROM admin_state WHERE key = ?',
  adminSet: `INSERT INTO admin_state (key, value_json, updated_ms, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_ms = excluded.updated_ms,
      updated_by = excluded.updated_by`,
  gardensCount: 'SELECT count(*) AS n FROM gardens',
});

// ---- the repo ------------------------------------------------------------------------------------------------------

export class GardenRepo {
  /**
   * @param {object} opts
   * @param {object} opts.db   WP1 Db: { tx(fn), prepare(sql) }
   * @param {() => number} [opts.now]
   * @param {(line: string) => void} [opts.log]
   */
  constructor({ db, now = Date.now, log = console.warn } = {}) {
    if (!db || typeof db.prepare !== 'function' || typeof db.tx !== 'function') {
      throw new TypeError('GardenRepo needs a Db with tx() and prepare() (server/db/db.js openDb)');
    }
    this.db = db;
    this.now = now;
    this.log = log;
    this.stmts = new Map();
    /** uid → { garden: fields|null, bots: Map<id, bot>, fills: [], orders: [], events: [] } */
    this.pending = new Map();
    this.flushScheduled = false;
    this.flushing = false;
    /** uid → consecutive failed flushes (a garden is dropped after MAX_FLUSH_FAILURES, never retried forever). */
    this.failures = new Map();
    this.stats = { flushes: 0, flushMs: 0, rolledBack: 0, lastFlushMs: 0 };
    /** EventStore facade for the journal (Journal.attachUserStore). */
    this.events = Object.freeze({
      add: (record) => this.addEvent(record),
      since: (uid, afterSeq, limit) => this.eventsSince(uid, afterSeq, limit),
      query: (uid, opts) => this.eventsQuery(uid, opts),
      count: (uid, kinds) => this.eventsCount(uid, kinds),
      maxSeq: () => this.eventsMaxSeq(),
    });
  }

  /** A cached prepared statement for one of the constant SQL strings above. */
  #st(key) {
    let st = this.stmts.get(key);
    if (!st) {
      st = this.db.prepare(SQL[key]);
      this.stmts.set(key, st);
    }
    return st;
  }

  #slot(uid) {
    let p = this.pending.get(uid);
    if (!p) {
      p = { garden: null, bots: new Map(), fills: [], orders: [], events: [] };
      this.pending.set(uid, p);
    }
    return p;
  }

  // ---- users and gardens -------------------------------------------------------------------------------------------

  /** `{username, status, role}` of a user, or null when the user does not exist. */
  user(uid) {
    return this.#st('username').get(uid) ?? null;
  }

  /** The gardens row, or null. */
  gardenRow(uid) {
    return this.#st('gardenGet').get(uid) ?? null;
  }

  /**
   * The gardens row of `uid`, created when missing (a random epoch, season 1, `accountUsd` of paper cash). Normally
   * the sign-up transaction creates it (§4.6 step 1.4); this covers users created before a garden existed.
   */
  ensureGarden(uid, { accountUsd }) {
    const existing = this.gardenRow(uid);
    if (existing) return existing;
    const now = this.now();
    this.db.tx(() => {
      this.#st('gardenInsert').run(uid, newEpoch(), now, now, accountUsd, now, now);
    });
    return this.gardenRow(uid);
  }

  /** Queue the mutable garden fields (written at the next flush). */
  saveGarden(uid, fields) {
    this.#slot(uid).garden = { ...fields };
    this.scheduleFlush();
  }

  /** Record authenticated activity (≤ once per `minGapMs`, §4.6 step 9). Immediate, tiny, idempotent. */
  touchGarden(uid, minGapMs = 5 * 60_000) {
    const now = this.now();
    this.#st('gardenTouch').run(now, uid, now - minGapMs);
  }

  setGardenCaps(uid, caps) {
    this.flush();
    this.#st('gardenCaps').run(caps == null ? null : safeJson(caps), this.now(), uid);
  }

  /** uids whose last activity is older than `beforeMs` and who still hold open testnet bots. */
  inactiveTestnetUsers(beforeMs) {
    this.flush();
    return this.#st('gardensInactive').all(beforeMs).map((r) => r.user_id);
  }

  gardensCount() {
    return this.#st('gardensCount').get()?.n ?? 0;
  }

  // ---- bots --------------------------------------------------------------------------------------------------------

  loadBots(uid) {
    this.flush();
    return this.#st('botsLoad').all(uid).map(rowToBot);
  }

  /** Queue a bot upsert. The bot object is serialized at flush time (its latest state wins). */
  saveBot(uid, bot) {
    this.#slot(uid).bots.set(bot.id, bot);
    this.scheduleFlush();
  }

  openBotUsers() {
    this.flush();
    return this.#st('openBotUsers').all().map((r) => r.user_id);
  }

  openTestnetUsers() {
    this.flush();
    return this.#st('openTestnetUsers').all().map((r) => r.user_id);
  }

  openBotCounts() {
    this.flush();
    const out = { paper: 0, testnet: 0 };
    for (const r of this.#st('openBotCounts').all()) out[r.venue] = r.n;
    return out;
  }

  // ---- fills and orders ---------------------------------------------------------------------------------------------

  /** Queue a paper fill (`fill` = the API Fill plus season/venue). */
  addFill(uid, fill) {
    this.#slot(uid).fills.push(fill);
    this.scheduleFlush();
  }

  /** Queue a paper order. */
  addOrder(uid, order) {
    this.#slot(uid).orders.push(order);
    this.scheduleFlush();
  }

  #insertFill(uid, f, { ignore = false } = {}) {
    return this.#st(ignore ? 'fillInsertIgnore' : 'fillInsert').run(
      uid, f.bot, f.venue === 'testnet' ? 'testnet' : 'paper', Number.isSafeInteger(f.season) ? f.season : 1,
      f.coin, String(f.dir ?? '').slice(0, 64) || '?', numOrNull(f.start_position), f.side === 'B' ? 'B' : 'A',
      f.sz, f.px, Number(f.fee) || 0, Number(f.closed_pnl) || 0, Math.trunc(Number(f.time_ms) || 0),
      intOrNull(f.tick), bool01(f.liquidation), bool01(f.replay), intOrNull(f.order_id), intOrNull(f.oid),
      intOrNull(f.tid), strOrNull(f.hash), bool01(f.provisional),
    );
  }

  #insertOrder(uid, o) {
    return this.#st('orderInsert').run(
      uid, o.bot, o.venue === 'testnet' ? 'testnet' : 'paper', Number.isSafeInteger(o.season) ? o.season : 1,
      o.kind, o.coin, Number(o.sz) || 0, numOrNull(o.px), bool01(o.reduce_only), o.status, strOrNull(o.reason),
      strOrNull(o.code), strOrNull(o.error)?.slice(0, 300) ?? null, strOrNull(o.cloid), intOrNull(o.oid),
      intOrNull(o.nonce), Number.isSafeInteger(o.attempts) ? o.attempts : 0, bool01(o.transport_failed),
      intOrNull(o.leverage), numOrNull(o.filled_sz), numOrNull(o.avg_px), intOrNull(o.tick),
      Math.trunc(Number(o.time_ms) || this.now()), intOrNull(o.sent_ms), intOrNull(o.done_ms), bool01(o.replay),
    );
  }

  /**
   * Testnet write-ahead (§3.5, §6.6): allocate the next nonce for the player's credential
   * (max(now, last_nonce + 1)), store it, and insert the `pending` order row — in ONE transaction that commits
   * before the caller POSTs. A `leverage` action has no cloid. Returns `{ id, nonce }`.
   */
  writeAhead(uid, order, { nonceFloor = this.now() } = {}) {
    this.flush();
    return this.db.tx(() => {
      const row = this.#st('nonceGet').get(uid);
      if (!row) throw Object.assign(new Error('no testnet credential'), { code: 'not_connected' });
      const nonce = Math.max(Math.trunc(nonceFloor), Number(row.last_nonce) + 1);
      this.#st('nonceSet').run(nonce, this.now(), uid);
      const res = this.#insertOrder(uid, { ...order, venue: 'testnet', status: 'pending', nonce });
      return { id: Number(res.lastInsertRowid), nonce };
    });
  }

  /**
   * A fresh nonce for re-signing the SAME order intent (the one allowed re-sign of §6.6, after a first-transmission
   * nonce error with no transport failure): stored on the credential and the order row in one transaction.
   */
  renonce(uid, orderId, { nonceFloor = this.now() } = {}) {
    this.flush();
    return this.db.tx(() => {
      const row = this.#st('nonceGet').get(uid);
      if (!row) throw Object.assign(new Error('no testnet credential'), { code: 'not_connected' });
      const nonce = Math.max(Math.trunc(nonceFloor), Number(row.last_nonce) + 1);
      this.#st('nonceSet').run(nonce, this.now(), uid);
      const o = this.#st('orderGet').get(orderId, uid);
      if (o) this.#updateOrderRow(uid, o, { nonce });
      return nonce;
    });
  }

  #updateOrderRow(uid, cur, patch) {
    const next = { ...cur, ...patch };
    this.#st('orderUpdate').run(
      next.status, strOrNull(next.code), strOrNull(next.error)?.slice(0, 300) ?? null, intOrNull(next.oid),
      intOrNull(next.nonce), Number.isSafeInteger(next.attempts) ? next.attempts : 0, bool01(next.transport_failed),
      numOrNull(next.filled_sz), numOrNull(next.avg_px), intOrNull(next.sent_ms), intOrNull(next.done_ms),
      cur.id, uid,
    );
    return next;
  }

  /** Immediate update of a testnet order row; returns the updated row (DB shape) or null. */
  updateOrder(uid, orderId, patch) {
    this.flush();
    return this.db.tx(() => {
      const cur = this.#st('orderGet').get(orderId, uid);
      if (!cur) return null;
      return this.#updateOrderRow(uid, cur, patch);
    });
  }

  getOrder(uid, orderId) {
    this.flush();
    return this.#st('orderGet').get(orderId, uid) ?? null;
  }

  orderByOid(uid, oid) {
    this.flush();
    return this.#st('orderByOid').get(uid, oid) ?? null;
  }

  /** Immediate insert of a testnet order that never needs a nonce (a `skipped` record). Returns its id. */
  insertOrderNow(uid, order) {
    this.flush();
    return this.db.tx(() => Number(this.#insertOrder(uid, order).lastInsertRowid));
  }

  /** Unresolved testnet orders of one player, oldest first (§6.11 sync step 2, Restart). */
  unresolvedOrders(uid) {
    this.flush();
    return this.#st('ordersUnresolved').all(uid);
  }

  /** Players with unresolved testnet orders (boot, §6.11 Restart step 1). */
  unresolvedOrderUsers() {
    this.flush();
    return this.#st('ordersUnresolvedUsers').all().map((r) => r.user_id);
  }

  /** Immediate insert of one testnet fill; returns its id (or null when its tid is already stored). */
  insertFillNow(uid, fill) {
    this.flush();
    return this.db.tx(() => {
      const res = this.#insertFill(uid, fill, { ignore: fill.tid != null });
      return res.changes ? Number(res.lastInsertRowid) : null;
    });
  }

  /**
   * The fills sweep (§6.11): replace the provisional fill(s) of `orderId` with the exchange fills (de-duplicated by
   * tid). One transaction. Returns the number of exchange fills inserted.
   */
  replaceProvisional(uid, orderId, fills) {
    this.flush();
    return this.db.tx(() => {
      if (orderId != null) this.#st('fillsDeleteProvisional').run(uid, orderId);
      let n = 0;
      for (const f of fills) n += this.#insertFill(uid, { ...f, order_id: orderId, provisional: false }, { ignore: true }).changes;
      return n;
    });
  }

  /** Every fill row of one bot, oldest first (realized P&L recomputation, §6.11 sweep step 4). */
  botFills(uid, botId) {
    this.flush();
    return this.#st('fillsBotAll').all(uid, botId);
  }

  /** tids of a player's fills on `venue` since `sinceMs` (de-duplication of the sweep). */
  knownTids(uid, venue, sinceMs) {
    this.flush();
    return new Set(this.#st('fillsTidsSince').all(uid, venue, Math.trunc(sinceMs)).map((r) => r.tid));
  }

  provisionalCount(uid) {
    this.flush();
    return this.#st('fillsProvisionalUser').get(uid)?.n ?? 0;
  }

  oldestProvisionalMs(uid) {
    this.flush();
    return this.#st('fillsOldestProvisional').get(uid)?.t ?? null;
  }

  /** live_fills / bot_detail: newest first, current season for paper (testnet rows always). */
  fills(uid, { bot = null, limit = 100, season = 1 } = {}) {
    this.flush();
    const lim = clampLimit(limit);
    const rows = bot ? this.#st('fillsByBot').all(uid, bot, season, lim) : this.#st('fillsByUser').all(uid, season, lim);
    const total = bot ? this.#st('fillsCountBot').get(uid, bot, season).n : this.#st('fillsCountUser').get(uid, season).n;
    return { rows: rows.map(fillRowToApi), total };
  }

  orders(uid, { bot = null, limit = 100, season = 1 } = {}) {
    this.flush();
    const lim = clampLimit(limit);
    const rows = bot ? this.#st('ordersByBot').all(uid, bot, season, lim) : this.#st('ordersByUser').all(uid, season, lim);
    const total = bot ? this.#st('ordersCountBot').get(uid, bot, season).n : this.#st('ordersCountUser').get(uid, season).n;
    return { rows: rows.map(orderRowToApi), total };
  }

  // ---- events (the journal's user store, §8.7) -----------------------------------------------------------------------

  addEvent(record) {
    const uid = record?.uid;
    if (!Number.isSafeInteger(uid)) throw new TypeError('user event without a uid');
    this.#slot(uid).events.push(record);
    this.scheduleFlush();
  }

  #rowToRecord(row) {
    let data = {};
    try {
      data = JSON.parse(row.data_json) ?? {};
    } catch {
      data = {};
    }
    const rec = { seq: row.seq, t: row.t, kind: row.kind };
    for (const [k, v] of Object.entries(data)) if (!EVENT_OWN_KEYS.has(k) && k !== 'uid') rec[k] = v;
    return tagUserRecord(rec, row.user_id);
  }

  eventsSince(uid, afterSeq, limit = 1000) {
    this.flush();
    const lim = Math.max(1, Math.min(100_000, Math.trunc(Number(limit) || 1000)));
    return this.#st('eventsSince').all(uid, Math.trunc(Number(afterSeq) || 0), lim).map((r) => this.#rowToRecord(r));
  }

  eventsQuery(uid, { kinds = null, limit = 100 } = {}) {
    this.flush();
    const list = Array.isArray(kinds) && kinds.length ? JSON.stringify(kinds.map(String)) : null;
    const lim = Math.max(0, Math.min(100_000, Math.trunc(Number(limit) || 0)));
    return this.#st('eventsQuery').all(uid, list, list, lim).map((r) => this.#rowToRecord(r));
  }

  eventsCount(uid, kinds = null) {
    this.flush();
    const list = Array.isArray(kinds) && kinds.length ? JSON.stringify(kinds.map(String)) : null;
    return this.#st('eventsCount').get(uid, list, list)?.n ?? 0;
  }

  eventsMaxSeq() {
    this.flush();
    return this.#st('eventsMax').get()?.m ?? 0;
  }

  // ---- admin_state (read; WP1's Admin owns writes, this is the fallback when it is absent) -------------------------

  adminState(key) {
    const row = this.#st('adminGet').get(key);
    if (!row) return null;
    try {
      return { value: JSON.parse(row.value_json), updated_ms: row.updated_ms, updated_by: row.updated_by ?? null };
    } catch {
      return null;
    }
  }

  setAdminState(key, value, by = null) {
    this.flush();
    this.#st('adminSet').run(key, safeJson(value), this.now(), Number.isSafeInteger(by) ? by : null);
  }

  // ---- flush ---------------------------------------------------------------------------------------------------------

  /** Flush on the next macrotask (many writes of one tick or command collapse into one transaction). */
  scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      try {
        this.flush();
      } catch (err) {
        this.log(`[repo] ALERT scheduled flush failed: ${err?.message || err}`);
      }
    });
  }

  /** Whether anything is queued. */
  get dirty() {
    return this.pending.size > 0;
  }

  /** Drop everything queued for one player (teardown of a deleted garden: its rows are gone). */
  forget(uid) {
    this.pending.delete(uid);
  }

  /**
   * Write everything queued: ONE transaction, one SAVEPOINT per garden. A garden whose rows throw is rolled back
   * to its savepoint, logged as an alert, and re-queued for the next flush; other gardens commit.
   * @returns {{ gardens: number, failed: number[] }}
   */
  flush() {
    if (this.flushing || this.pending.size === 0) return { gardens: 0, failed: [] };
    this.flushing = true;
    const t0 = performance.now();
    const batch = this.pending;
    this.pending = new Map();
    const failed = [];
    try {
      this.db.tx(() => {
        for (const [uid, p] of batch) {
          try {
            this.#savepoint(() => this.#writeSlot(uid, p));
          } catch (err) {
            failed.push(uid);
            this.stats.rolledBack++;
            this.log(`[repo] ALERT garden ${uid} flush rolled back: ${err?.message || err}`);
          }
        }
      });
    } catch (err) {
      // The whole transaction failed (I/O, busy): put everything back for the next attempt.
      for (const [uid, p] of batch) this.#requeue(uid, p);
      this.log(`[repo] ALERT flush failed: ${err?.message || err}`);
      this.flushing = false;
      throw err;
    }
    // A failed garden keeps only its latest garden/bot state for the retry; its append-only rows (fills, orders,
    // events) are retried too, since the savepoint rolled them back — unless the player is gone (a deleted account:
    // nothing can ever be written for it) or the same garden failed MAX_FLUSH_FAILURES times in a row.
    for (const uid of failed) {
      const n = (this.failures.get(uid) ?? 0) + 1;
      let gone = false;
      try {
        gone = this.user(uid) === null;
      } catch {
        gone = false;
      }
      if (gone || n >= MAX_FLUSH_FAILURES) {
        this.failures.delete(uid);
        this.log(`[repo] ALERT garden ${uid}: dropping its unwritable rows (${gone ? 'the player no longer exists' : `${n} failed flushes`})`);
        continue;
      }
      this.failures.set(uid, n);
      this.#requeue(uid, batch.get(uid));
    }
    for (const uid of batch.keys()) if (!failed.includes(uid)) this.failures.delete(uid);
    this.flushing = false;
    const ms = performance.now() - t0;
    this.stats.flushes++;
    this.stats.flushMs += ms;
    this.stats.lastFlushMs = ms;
    return { gardens: batch.size, failed };
  }

  /**
   * Run `fn` in a SAVEPOINT inside the open transaction; a throw rolls back to it and rethrows. WP1's Db has
   * savepoint() (a constant-named savepoint); a bare Db gets the same through prepared statements.
   */
  #savepoint(fn) {
    if (typeof this.db.savepoint === 'function') return this.db.savepoint(fn);
    this.#st('sp').run();
    try {
      const out = fn();
      this.#st('spRelease').run();
      return out;
    } catch (err) {
      try {
        this.#st('spRollback').run();
        this.#st('spRelease').run();
      } catch {
        /* the transaction itself is gone; the outer tx() reports it */
      }
      throw err;
    }
  }

  #requeue(uid, p) {
    if (!p) return;
    const slot = this.#slot(uid);
    if (!slot.garden && p.garden) slot.garden = p.garden;
    for (const [id, bot] of p.bots) if (!slot.bots.has(id)) slot.bots.set(id, bot);
    slot.fills.unshift(...p.fills);
    slot.orders.unshift(...p.orders);
    slot.events.unshift(...p.events);
  }

  #writeSlot(uid, p) {
    const now = this.now();
    if (p.garden) {
      const g = p.garden;
      this.#st('gardenUpdate').run(
        g.season, g.season_started_ms, intOrNull(g.last_reset_ms), g.account_usd, g.next_bot_index,
        bool01(g.halted), intOrNull(g.halted_ms), Math.trunc(g.fills_logged || 0), strOrNull(g.last_error),
        intOrNull(g.last_error_ms), intOrNull(g.last_reconcile_ms), intOrNull(g.last_tick), now, uid,
      );
    }
    if (p.bots.size) {
      // Index order: a bot closed in this batch frees its coin/bean before a newer bot binds them (partial UNIQUE).
      const bots = [...p.bots.values()].sort((a, b) => a.index - b.index);
      const st = this.#st('botUpsert');
      for (const bot of bots) {
        const r = botToRow(uid, bot);
        st.run(r.user_id, r.id, r.idx, r.venue, r.bean, r.coin, r.asset, r.capital_usd, r.leverage, r.state,
          r.created_ms, r.updated_ms, r.closed_ms, r.data_json);
      }
    }
    for (const o of p.orders) this.#insertOrder(uid, o);
    for (const f of p.fills) this.#insertFill(uid, f);
    if (p.events.length) {
      const st = this.#st('eventInsert');
      for (const rec of p.events) {
        const data = {};
        for (const [k, v] of Object.entries(rec)) if (!EVENT_OWN_KEYS.has(k)) data[k] = v;
        st.run(rec.seq, uid, Math.trunc(rec.t), rec.kind, safeJson(data));
      }
    }
  }
}

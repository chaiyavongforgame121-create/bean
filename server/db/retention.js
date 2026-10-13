// server/db/retention.js — hourly retention of the accounts-mode DB (PLATFORM.md §3.4).
//
//   events          newest 5,000 per user
//   fills, orders   newest 20,000 per user, never a row of an OPEN bot
//   sessions        rows expired or revoked for more than 30 days
//   audit_log       180 days
//
// It never blocks the event loop for long: every DELETE removes at most 1,000 rows (`… WHERE id IN (SELECT …
// LIMIT 1000)`), and the next slice is scheduled with setImmediate, so ticks, SSE and requests interleave. Users are
// visited in id pages; each per-user step is an indexed lookup (the cut-off row by OFFSET on a covering index).

const DAY_MS = 86_400_000;
export const RETENTION = Object.freeze({
  eventsPerUser: 5_000,
  rowsPerUser: 20_000,
  sessionDays: 30,
  auditDays: 180,
  batch: 1_000,
  userPage: 50,
});

const SQL = {
  usersPage: 'SELECT id FROM users WHERE id > ? ORDER BY id LIMIT ?',
  // events: the seq of the (keep+1)-th newest event of the user is the newest row to delete.
  eventsCut: 'SELECT seq FROM events WHERE user_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?',
  eventsDelete: 'DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE user_id = ? AND seq <= ? ORDER BY seq LIMIT ?)',
  fillsCut: 'SELECT id FROM fills WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?',
  fillsDelete: `DELETE FROM fills WHERE id IN (
      SELECT f.id FROM fills f WHERE f.user_id = ? AND f.id <= ?
        AND NOT EXISTS (SELECT 1 FROM bots b WHERE b.user_id = f.user_id AND b.id = f.bot_id AND b.state <> 'closed')
      ORDER BY f.id LIMIT ?)`,
  ordersCut: 'SELECT id FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?',
  ordersDelete: `DELETE FROM orders WHERE id IN (
      SELECT o.id FROM orders o WHERE o.user_id = ? AND o.id <= ?
        AND NOT EXISTS (SELECT 1 FROM bots b WHERE b.user_id = o.user_id AND b.id = o.bot_id AND b.state <> 'closed')
      ORDER BY o.id LIMIT ?)`,
  sessionsExpired: 'DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_ms < ? LIMIT ?)',
  sessionsRevoked: 'DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE revoked_ms IS NOT NULL AND revoked_ms < ? LIMIT ?)',
  auditOld: 'DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at_ms < ? ORDER BY id LIMIT ?)',
};

/** Yield to the event loop between slices. */
const nextSlice = () => new Promise((resolve) => setImmediate(resolve));

export class Retention {
  /**
   * @param {object} opts
   * @param {import('./db.js').Db} opts.db
   * @param {() => number} [opts.now]
   * @param {(line: string) => void} [opts.log]
   * @param {Partial<typeof RETENTION>} [opts.limits]  overrides (tests)
   */
  constructor({ db, now = Date.now, log = () => {}, limits = {} }) {
    this.db = db;
    this.now = now;
    this.log = log;
    this.limits = { ...RETENTION, ...limits };
    this.timer = null;
    this.running = null;
    this.maxBatchSeen = 0; // the largest single DELETE of the last pass (tests assert ≤ batch)
  }

  /** Run every hour (first pass after `firstDelayMs`). */
  start({ intervalMs = 3_600_000, firstDelayMs = 60_000 } = {}) {
    if (this.timer) return;
    const kick = () => {
      this.runOnce().catch((err) => this.log(`[retention] pass failed (${err.code ?? err.name}: ${err.message})`));
    };
    this.first = setTimeout(kick, firstDelayMs);
    this.first.unref?.();
    this.timer = setInterval(kick, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  /** One full pass. Concurrent calls share the running pass. Resolves with the row counts deleted. */
  runOnce() {
    if (!this.running) {
      this.running = this.#pass().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  async #pass() {
    const { batch } = this.limits;
    const counts = { events: 0, fills: 0, orders: 0, sessions: 0, audit: 0 };
    this.maxBatchSeen = 0;
    const del = (sql, ...args) => {
      if (this.db.closed) return 0;
      const n = Number(this.db.prepare(sql).run(...args, batch).changes);
      if (n > this.maxBatchSeen) this.maxBatchSeen = n;
      return n;
    };

    // Per-user tables, one user page at a time.
    let after = 0;
    for (;;) {
      if (this.db.closed) return counts;
      const users = this.db.prepare(SQL.usersPage).all(after, this.limits.userPage);
      if (users.length === 0) break;
      for (const { id } of users) {
        after = id;
        counts.events += await this.#trim(del, SQL.eventsCut, SQL.eventsDelete, id, this.limits.eventsPerUser);
        counts.fills += await this.#trim(del, SQL.fillsCut, SQL.fillsDelete, id, this.limits.rowsPerUser);
        counts.orders += await this.#trim(del, SQL.ordersCut, SQL.ordersDelete, id, this.limits.rowsPerUser);
      }
      await nextSlice();
    }

    // Rows of deleted users cascade with the user; what remains are time-based tables.
    const now = this.now();
    const sessionCut = now - this.limits.sessionDays * DAY_MS;
    for (let n = batch; n === batch; await nextSlice()) counts.sessions += (n = del(SQL.sessionsExpired, sessionCut));
    for (let n = batch; n === batch; await nextSlice()) counts.sessions += (n = del(SQL.sessionsRevoked, sessionCut));
    const auditCut = now - this.limits.auditDays * DAY_MS;
    for (let n = batch; n === batch; await nextSlice()) counts.audit += (n = del(SQL.auditOld, auditCut));

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0) this.log(`[retention] deleted ${JSON.stringify(counts)}`);
    return counts;
  }

  /** Delete one user's rows older than its `keep`-th newest, in ≤ batch slices. */
  async #trim(del, cutSql, deleteSql, uid, keep) {
    if (this.db.closed) return 0;
    const cut = this.db.prepare(cutSql).get(uid, keep);
    if (!cut) return 0;
    const cutId = cut.seq ?? cut.id;
    let total = 0;
    for (;;) {
      const n = del(deleteSql, uid, cutId);
      total += n;
      if (n < this.limits.batch) break;
      await nextSlice();
    }
    return total;
  }
}

// server/hl/scheduler.js — one weight ledger, a priority queue and per-user serial lanes for the testnet host
// (PLATFORM §2.2, §6.6, §6.8).
//
//   run(priority, weight, fn, opts)   one Hyperliquid request. Starts when the rolling-60 s weight fits the budget
//                                     (TESTNET_BUDGET 800; P0 flattens may use the 900 burst ceiling) and no 429
//                                     back-off is running. Highest priority first; round-robin across players (the
//                                     `key`, normally the uid) within one priority. The weight is charged when the
//                                     request starts; `fn(job)` may add more with `job.charge(w)` (time-range pages).
//                                     A request that fails with `requeue` (HTTP 429: it was not processed) sets the
//                                     15 s host back-off and goes back to the FRONT of its queue (the "job stays
//                                     queued" rule), up to `requeueMax` times.
//   lane(uid, epoch)                  a serial lane for one player: lane jobs run one at a time (highest priority
//                                     first, FIFO within a priority), so that player's nonces are strictly increasing
//                                     and never concurrent. A job captures (uid, epoch) and aborts — rejecting with
//                                     LaneAbortError, which callers ignore — when the lane was cancelled or the
//                                     garden epoch no longer matches (§7.2).
//   cancelLane(uid)                   teardown: queued lane jobs, queued requests of that lane and its retry timers
//                                     are cancelled at once; a running job sees ctx.alive() === false and its next
//                                     ctx.request()/ctx.sleep() aborts. In-flight HTTP requests are not torn down.
//   drain(ms)                         shutdown: queued work is dropped, in-flight requests finish (their results
//                                     apply), resolves when idle or at the deadline.
//
// The scheduler knows nothing about Hyperliquid payloads; info.js and exchange.js wrap their fetches in run().

import { WeightLedger } from '../hyperliquid.js';
import {
  BACKOFF_429_MS, DEGRADE_AT, LEDGER_WINDOW_MS, PRIORITY, TESTNET_BUDGET, TESTNET_BURST,
} from './constants.js';
import { TestnetError } from './transport.js';

const LEVELS = 8;

/** A lane job (or a request queued by one) was cancelled: teardown, epoch change or shutdown. Ignore it. */
export class LaneAbortError extends Error {
  constructor(reason = 'lane cancelled') {
    super(`lane aborted: ${reason}`);
    this.name = 'LaneAbortError';
    this.code = 'lane_aborted';
  }
}

export const isLaneAbort = (err) => err?.code === 'lane_aborted';

const draining = () => new TestnetError('scheduler is draining', { code: 'draining', skipped: true });

export class HlScheduler {
  /**
   * @param {object} [opts]
   * @param {number} [opts.budget=800]      weight per rolling 60 s (info + exchange)
   * @param {number} [opts.burst=900]       ceiling for P0 (flatten) requests
   * @param {WeightLedger} [opts.ledger]    injectable ledger
   * @param {() => number} [opts.now]
   * @param {(ms: number) => Promise<void>} [opts.sleep]  injectable (tests); default: real timers
   * @param {(line: string) => void} [opts.log]
   * @param {number} [opts.maxInFlight=16]  concurrent HTTP requests to the testnet host
   * @param {number} [opts.requeueMax=4]    429 re-queues per request before it fails with ip_rate_limited
   * @param {(uid: any) => string|null} [opts.epochOf]  current garden epoch (WP3 Gardens); see setEpochSource()
   */
  constructor({ budget = TESTNET_BUDGET, burst = TESTNET_BURST, ledger, now = Date.now, sleep, log, maxInFlight = 16,
    requeueMax = 4, backoffMs = BACKOFF_429_MS, epochOf = null } = {}) {
    if (!(budget > 0)) throw new RangeError('budget must be > 0');
    this.budget = budget;
    this.burst = Math.max(budget, burst);
    this.now = now;
    this.ledger = ledger ?? new WeightLedger({ windowMs: LEDGER_WINDOW_MS, budget, now });
    this.injectedSleep = typeof sleep === 'function' ? sleep : null;
    this.log = typeof log === 'function' ? log : () => {};
    this.maxInFlight = Math.max(1, maxInFlight);
    this.requeueMax = Math.max(0, requeueMax);
    this.backoffMs = backoffMs;
    this.epochOf = typeof epochOf === 'function' ? epochOf : null;

    this.queues = Array.from({ length: LEVELS }, () => ({ order: [], byKey: new Map() }));
    this.queued = 0;
    this.inFlight = 0;
    this.backoffUntil = 0;
    this.draining = false;
    this.lanes = new Map(); // uid → lane record
    this.wakeAt = 0;
    this.wakeToken = 0;
    this.timer = null;
    this.pumping = false;
    this.idleWaiters = new Set();
    this.marks = { exchange: [], errors: [] }; // timestamps for the 60 s counters (admin_status)
    this.counts = { started: 0, requeued: 0, skipped: 0, aborted: 0 };
  }

  /** Install the garden-epoch source later (Gardens is built after createTestnet). */
  setEpochSource(fn) {
    this.epochOf = typeof fn === 'function' ? fn : null;
  }

  // ---- requests -----------------------------------------------------------------------------------------------

  /**
   * Run one request under the weight budget.
   * @param {number} priority  0 (flatten) … 7 (verification), see PRIORITY
   * @param {number} weight    charged when the request starts
   * @param {(job: {charge: (w:number) => void, priority: number, key: any}) => Promise<any>} fn
   * @param {object} [opts]
   * @param {any} [opts.key='global']   round-robin key (uid); set automatically from a lane ctx
   * @param {object} [opts.ctx]         a lane job context: the request aborts if the lane is cancelled first
   * @param {number} [opts.maxWaitMs]   give up (TestnetError code 'skipped') if it cannot START within this time
   * @param {string} [opts.label]
   */
  run(priority, weight, fn, { key, ctx = null, maxWaitMs = Infinity, label = '' } = {}) {
    if (!Number.isInteger(priority) || priority < 0 || priority >= LEVELS) return Promise.reject(new RangeError('bad priority'));
    if (!(weight >= 0) || !Number.isFinite(weight)) return Promise.reject(new RangeError('bad weight'));
    if (typeof fn !== 'function') return Promise.reject(new TypeError('fn must be a function'));
    if (this.draining) return Promise.reject(draining());
    const lane = ctx?.lane ?? null;
    if (lane && !this.#laneAlive(lane)) return Promise.reject(new LaneAbortError());
    return new Promise((resolve, reject) => {
      const job = {
        priority, weight, fn, label, resolve, reject, lane, requeues: 0,
        key: key ?? (lane ? lane.uid : 'global'),
        deadline: Number.isFinite(maxWaitMs) ? this.now() + Math.max(0, maxWaitMs) : Infinity,
      };
      this.#enqueue(job, false);
      this.#pump();
    });
  }

  /** Host-wide back-off (HTTP 429). */
  backoff(ms = this.backoffMs, reason = 'rate limited') {
    const until = this.now() + ms;
    if (until > this.backoffUntil) {
      this.backoffUntil = until;
      this.log(`[hl] testnet back-off ${Math.round(ms / 1000)} s (${reason})`);
    }
  }

  inBackoff() {
    return this.now() < this.backoffUntil;
  }

  /** Weight spent on the testnet host in the last 60 s. */
  weight60s() {
    return this.ledger.used(this.now());
  }

  /** used / budget (degradation starts above 0.9, §6.8). */
  pressure() {
    return this.weight60s() / this.budget;
  }

  degraded() {
    return this.pressure() > DEGRADE_AT;
  }

  /** Count an exchange action or an exchange error for the 60 s admin counters. */
  note(kind) {
    const list = this.marks[kind === 'error' ? 'errors' : 'exchange'];
    list.push(this.now());
    this.#pruneMarks();
  }

  #pruneMarks() {
    const from = this.now() - LEDGER_WINDOW_MS;
    for (const list of Object.values(this.marks)) {
      while (list.length && list[0] <= from) list.shift();
    }
  }

  #enqueue(job, front) {
    const q = this.queues[job.priority];
    let list = q.byKey.get(job.key);
    if (!list) {
      list = [];
      q.byKey.set(job.key, list);
      if (front) q.order.unshift(job.key);
      else q.order.push(job.key);
    }
    if (front) list.unshift(job);
    else list.push(job);
    this.queued++;
  }

  #peek() {
    for (let p = 0; p < LEVELS; p++) {
      const q = this.queues[p];
      if (q.order.length) return q.byKey.get(q.order[0])[0];
    }
    return null;
  }

  /** Remove the head job of its priority and rotate its key to the back (round-robin). */
  #popHead(job) {
    const q = this.queues[job.priority];
    const key = q.order.shift();
    const list = q.byKey.get(key);
    list.shift();
    if (list.length) q.order.push(key);
    else q.byKey.delete(key);
    this.queued--;
  }

  #remove(job) {
    const q = this.queues[job.priority];
    const list = q.byKey.get(job.key);
    if (!list) return false;
    const i = list.indexOf(job);
    if (i < 0) return false;
    list.splice(i, 1);
    if (!list.length) {
      q.byKey.delete(job.key);
      const k = q.order.indexOf(job.key);
      if (k >= 0) q.order.splice(k, 1);
    }
    this.queued--;
    return true;
  }

  #pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.inFlight < this.maxInFlight) {
        const job = this.#peek();
        if (!job) break;
        const now = this.now();
        if (job.lane && !this.#laneAlive(job.lane)) {
          this.#popHead(job);
          this.counts.aborted++;
          job.reject(new LaneAbortError());
          continue;
        }
        const budget = job.priority === PRIORITY.FLATTEN ? this.burst : this.budget;
        const wait = Math.max(this.backoffUntil - now, this.ledger.waitMs(job.weight, budget, now), 0);
        if (wait > 0) {
          if (!Number.isFinite(wait) || now + wait > job.deadline) {
            this.#popHead(job);
            this.counts.skipped++;
            job.reject(new TestnetError(`${job.label || 'request'}: skipped (${this.backoffUntil > now ? 'rate-limit back-off' : 'weight budget'})`,
              { code: this.backoffUntil > now ? 'ip_rate_limited' : 'skipped', skipped: true }));
            continue;
          }
          this.#wakeIn(wait);
          break;
        }
        this.#popHead(job);
        this.ledger.record(job.weight, now);
        this.inFlight++;
        this.counts.started++;
        this.#start(job);
      }
    } finally {
      this.pumping = false;
    }
    this.#checkIdle();
  }

  #start(job) {
    const handle = {
      priority: job.priority,
      key: job.key,
      label: job.label,
      charge: (w) => {
        if (w > 0 && Number.isFinite(w)) this.ledger.record(w, this.now());
      },
    };
    Promise.resolve()
      .then(() => job.fn(handle))
      .then((value) => {
        this.inFlight--;
        job.resolve(value);
      }, (err) => {
        this.inFlight--;
        if (err?.requeue) this.backoff(this.backoffMs, 'HTTP 429');
        if (err?.requeue && !this.draining && job.requeues < this.requeueMax && this.now() < job.deadline
          && !(job.lane && !this.#laneAlive(job.lane))) {
          job.requeues++;
          this.counts.requeued++;
          this.#enqueue(job, true); // a 429 was not processed: the job stays queued, at the front
        } else {
          job.reject(err);
        }
      })
      .finally(() => this.#pump());
  }

  #wakeIn(ms) {
    const at = this.now() + ms;
    if (this.wakeAt && this.wakeAt <= at) return; // an earlier wake is already pending
    this.wakeAt = at;
    const token = ++this.wakeToken;
    const fire = () => {
      if (token === this.wakeToken) {
        this.wakeAt = 0;
        this.timer = null;
      }
      this.#pump();
    };
    if (this.injectedSleep) {
      this.injectedSleep(ms).then(fire, fire);
    } else {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(fire, Math.max(1, Math.ceil(ms)));
    }
  }

  // ---- lanes --------------------------------------------------------------------------------------------------

  #epochOk(uid, epoch) {
    if (!this.epochOf) return true;
    try {
      const cur = this.epochOf(uid);
      return cur === undefined || cur === epoch;
    } catch {
      return false;
    }
  }

  #laneAlive(rec) {
    return !rec.dead && this.lanes.get(rec.uid) === rec && this.#epochOk(rec.uid, rec.epoch);
  }

  /**
   * The serial lane of one player.
   * @param {any} uid
   * @param {string} epoch  the garden epoch captured by every job of this lane
   * @returns {{uid: any, epoch: string, run: Function, later: Function, alive: () => boolean, busy: boolean, size: number}}
   */
  lane(uid, epoch) {
    let rec = this.lanes.get(uid);
    if (rec && rec.epoch !== epoch) {
      if (this.epochOf && !this.#epochOk(uid, epoch)) {
        // A stale caller (old epoch): give it a dead handle; never cancel the current garden's lane.
        return this.#deadHandle(uid, epoch);
      }
      this.log(`[hl] lane ${uid}: epoch changed, cancelling the old lane`);
      this.cancelLane(uid);
      rec = null;
    }
    if (!rec) {
      rec = { uid, epoch, queue: [], running: null, dead: false, timers: new Set(), seq: 0 };
      rec.handle = this.#handle(rec);
      this.lanes.set(uid, rec);
    }
    return rec.handle;
  }

  #deadHandle(uid, epoch) {
    const rec = { uid, epoch, queue: [], running: null, dead: true, timers: new Set(), seq: 0 };
    return this.#handle(rec);
  }

  #handle(rec) {
    const self = this;
    return Object.freeze({
      uid: rec.uid,
      epoch: rec.epoch,
      /** Queue a serial lane job. `fn(ctx)`; resolves with its result, rejects LaneAbortError when cancelled. */
      run(priority, fn, opts) {
        return self.#laneRun(rec, priority, fn, opts);
      },
      /** Run a lane job after `ms` (a retry timer); cancelled with the lane. Returns {cancel()}. */
      later(ms, priority, fn, opts) {
        return self.#laneLater(rec, ms, priority, fn, opts);
      },
      alive() {
        return self.#laneAlive(rec);
      },
      get busy() {
        return Boolean(rec.running) || rec.queue.length > 0;
      },
      get size() {
        return rec.queue.length + (rec.running ? 1 : 0);
      },
    });
  }

  #laneRun(rec, priority, fn, { label = '' } = {}) {
    if (!Number.isInteger(priority) || priority < 0 || priority >= LEVELS) return Promise.reject(new RangeError('bad priority'));
    if (typeof fn !== 'function') return Promise.reject(new TypeError('fn must be a function'));
    if (this.draining) return Promise.reject(draining());
    if (!this.#laneAlive(rec)) return Promise.reject(new LaneAbortError());
    return new Promise((resolve, reject) => {
      rec.queue.push({ priority, fn, label, resolve, reject, seq: rec.seq++ });
      this.#laneNext(rec);
    });
  }

  #laneNext(rec) {
    if (rec.running || !rec.queue.length) return;
    if (!this.#laneAlive(rec)) {
      this.#abortLaneQueue(rec);
      return;
    }
    let best = 0;
    for (let i = 1; i < rec.queue.length; i++) {
      if (rec.queue[i].priority < rec.queue[best].priority) best = i;
    }
    const job = rec.queue.splice(best, 1)[0];
    rec.running = job;
    const ctx = this.#laneCtx(rec, job);
    Promise.resolve()
      .then(() => {
        ctx.assertAlive();
        return job.fn(ctx);
      })
      .then(job.resolve, job.reject)
      .finally(() => {
        rec.running = null;
        this.#laneNext(rec);
        this.#checkIdle();
      });
  }

  #laneCtx(rec, job) {
    const self = this;
    const ctx = {
      uid: rec.uid,
      epoch: rec.epoch,
      priority: job.priority,
      lane: rec,
      alive: () => self.#laneAlive(rec),
      assertAlive() {
        if (!self.#laneAlive(rec)) throw new LaneAbortError();
      },
      /** A scheduled request on behalf of this lane (key = uid; aborts if the lane is cancelled while queued). */
      request: (priority, weight, fn, opts = {}) => self.run(priority, weight, fn, { ...opts, ctx }),
      /** A sleep that aborts when the lane is cancelled. */
      sleep: (ms) => self.#laneSleep(rec, ms),
    };
    return Object.freeze(ctx);
  }

  #laneSleep(rec, ms) {
    if (!this.#laneAlive(rec)) return Promise.reject(new LaneAbortError());
    return new Promise((resolve, reject) => {
      const entry = { cancel: null };
      let timer = null;
      const done = (fn) => {
        if (!rec.timers.has(entry)) return;
        rec.timers.delete(entry);
        if (timer) clearTimeout(timer);
        fn();
      };
      entry.cancel = () => done(() => reject(new LaneAbortError()));
      rec.timers.add(entry);
      const fire = () => done(() => (this.#laneAlive(rec) ? resolve() : reject(new LaneAbortError())));
      if (this.injectedSleep) this.injectedSleep(ms).then(fire, fire);
      else timer = setTimeout(fire, Math.max(0, ms));
    });
  }

  #laneLater(rec, ms, priority, fn, opts) {
    const entry = { cancel: null, cancelled: false };
    let timer = null;
    entry.cancel = () => {
      entry.cancelled = true;
      rec.timers.delete(entry);
      if (timer) clearTimeout(timer);
    };
    if (!this.#laneAlive(rec)) {
      entry.cancelled = true;
      return { cancel() {} };
    }
    rec.timers.add(entry);
    const fire = () => {
      if (entry.cancelled) return;
      rec.timers.delete(entry);
      this.#laneRun(rec, priority, fn, opts).catch((err) => {
        if (!isLaneAbort(err) && err?.code !== 'draining') this.log(`[hl] lane ${rec.uid}: delayed job failed (${err?.code || err?.name || 'error'})`);
      });
    };
    if (this.injectedSleep) this.injectedSleep(ms).then(fire, fire);
    else {
      timer = setTimeout(fire, Math.max(0, ms));
      timer.unref?.();
    }
    return { cancel: () => entry.cancel() };
  }

  #abortLaneQueue(rec, err = () => new LaneAbortError()) {
    const jobs = rec.queue.splice(0);
    for (const j of jobs) j.reject(err());
    return jobs.length;
  }

  /**
   * Teardown of one player's lane: queued jobs, queued requests and retry timers are cancelled synchronously.
   * @returns {number} how many queued jobs/requests/timers were cancelled
   */
  cancelLane(uid) {
    const rec = this.lanes.get(uid);
    if (!rec) return 0;
    rec.dead = true;
    this.lanes.delete(uid);
    let n = this.#abortLaneQueue(rec);
    for (const t of [...rec.timers]) {
      t.cancel();
      n++;
    }
    for (const q of this.queues) {
      for (const list of [...q.byKey.values()]) {
        for (const job of [...list]) {
          if (job.lane === rec && this.#remove(job)) {
            job.reject(new LaneAbortError());
            n++;
          }
        }
      }
    }
    this.#checkIdle();
    return n;
  }

  // ---- shutdown and stats ---------------------------------------------------------------------------------------

  #isIdle() {
    if (this.inFlight > 0) return false;
    for (const rec of this.lanes.values()) if (rec.running) return false;
    return true;
  }

  #checkIdle() {
    if (!this.idleWaiters.size || !this.#isIdle()) return;
    for (const w of [...this.idleWaiters]) w();
  }

  /**
   * Shutdown: refuse new work, drop queued work, let in-flight requests finish.
   * @param {number} deadlineMs  real-time deadline for in-flight work
   * @returns {Promise<{drained: boolean, inflight: number}>}
   */
  drain(deadlineMs = 10_000) {
    this.draining = true;
    for (const q of this.queues) {
      for (const list of q.byKey.values()) for (const job of list) job.reject(draining());
      q.byKey.clear();
      q.order.length = 0;
    }
    this.queued = 0;
    for (const rec of this.lanes.values()) {
      this.#abortLaneQueue(rec, draining);
      for (const t of [...rec.timers]) t.cancel();
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.#isIdle()) return Promise.resolve({ drained: true, inflight: 0 });
    return new Promise((resolve) => {
      let timer = null;
      const waiter = () => {
        this.idleWaiters.delete(waiter);
        if (timer) clearTimeout(timer);
        resolve({ drained: true, inflight: 0 });
      };
      this.idleWaiters.add(waiter);
      timer = setTimeout(() => {
        this.idleWaiters.delete(waiter);
        resolve({ drained: false, inflight: this.inFlight });
      }, Math.max(0, deadlineMs));
      timer.unref?.();
    });
  }

  /** Snapshot for admin_status (§8.6). */
  stats() {
    this.#pruneMarks();
    const byPriority = this.queues.map((q) => {
      let n = 0;
      for (const list of q.byKey.values()) n += list.length;
      return n;
    });
    let lanesBusy = 0;
    for (const rec of this.lanes.values()) if (rec.running || rec.queue.length) lanesBusy++;
    const now = this.now();
    return {
      budget: this.budget,
      burst: this.burst,
      weight_60s: this.weight60s(),
      degraded: this.degraded(),
      queued: this.queued,
      queued_by_priority: byPriority,
      inflight: this.inFlight,
      backoff_ms: Math.max(0, this.backoffUntil - now),
      lanes: this.lanes.size,
      lanes_busy: lanesBusy,
      exchange_actions_60s: this.marks.exchange.length,
      errors_60s: this.marks.errors.length,
      draining: this.draining,
      ...this.counts,
    };
  }
}

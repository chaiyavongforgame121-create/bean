// Journal — the event bus of Bean Garden.
//
// Every interesting thing (ticks, busts, bot lifecycle, fills, errors) is emitted here as a record
// `{ seq, t, kind, ...data }`. The journal:
//   • keeps the newest `keep` records in memory (ring buffer) for the `events` query and SSE replay,
//   • broadcasts each record to subscribers (the SSE endpoint),
//   • optionally appends each record as one JSON line to `file` (sync append; small records, low rate).
//
// `seq` is strictly increasing across the life of the journal (and across restarts when the
// serialized state is restored), so it doubles as the SSE event id / Last-Event-ID.
//
// SCOPED MODE (accounts mode, PLATFORM §8.7). `new Journal({ scoped: true, globalKinds: GLOBAL_KINDS })`:
//   • emit(kind, data)          kind ∈ GLOBAL_KINDS → a GLOBAL record: ring + jsonl + broadcast (as today);
//   • emit(kind, data, {uid})   any kind → a USER record: the same global seq space, handed to the user store
//                               (the `events` table), NOT put in the ring or jsonl, broadcast with an internal,
//                               NON-ENUMERABLE `uid` (so JSON.stringify can never leak it; read it as record.uid);
//   • emit(userKind, data)      without a uid THROWS `unscoped_user_event` (logged as an alert, never stored or
//                               broadcast): a wiring mistake fails loudly instead of leaking a player's records.
// Gardens hand each player's LiveLayer `journal.forUser(uid)` (a frozen, uid-bound facade). The SSE writer and
// the `events` query re-check with visibleTo(record, uid) at the edge. Without `scoped` the journal behaves
// exactly as before (none mode).

import fs from 'node:fs';
import path from 'node:path';

/** Default cap for the jsonl file before it is rotated to `<file>.1` (one generation kept). */
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Keys owned by the journal; event data may not overwrite them. */
const RESERVED = new Set(['seq', 't', 'kind']);

/**
 * Record kinds that are public (shared by every player) in accounts mode (PLATFORM §8.7). Every other kind is
 * user-scoped and must be emitted with a uid.
 */
export const GLOBAL_KINDS = Object.freeze([
  'warmup_finished', 'tick_completed', 'busted', 'daemon_started', 'feed_status', 'feed_gap',
  'kill_switch', 'testnet_feed',
]);

/** Most records a Last-Event-ID replay may send before it answers `resync` instead (PLATFORM §8.7). */
export const REPLAY_LIMIT = 1000;

/** Thrown by a scoped journal for a user kind emitted without a uid. */
export class JournalScopeError extends Error {
  constructor(kind) {
    super(`unscoped_user_event: '${kind}' must be emitted with a uid (journal.forUser(uid))`);
    this.name = 'JournalScopeError';
    this.code = 'unscoped_user_event';
  }
}

/** A uid is a non-negative safe integer (0 is the implicit none-mode player). */
function checkUid(uid) {
  if (!Number.isSafeInteger(uid) || uid < 0) throw new TypeError(`journal uid must be a non-negative integer (got ${uid})`);
  return uid;
}

/**
 * Attach the owner uid to a user record as a NON-enumerable property: readable as `record.uid`, but absent from
 * JSON.stringify, object spread and Object.keys, so it cannot reach a client by accident.
 */
export function tagUserRecord(record, uid) {
  Object.defineProperty(record, 'uid', { value: uid, enumerable: false, writable: false, configurable: false });
  return record;
}

/** The owner uid of a record, or null for a global record. */
export function recordUid(record) {
  const uid = record?.uid;
  return Number.isSafeInteger(uid) ? uid : null;
}

/**
 * Fixed-capacity FIFO. Pushing beyond capacity drops the oldest item. O(1) push and indexed access.
 * Exported because the live layer reuses it for its fill/order logs.
 */
export class RingBuffer {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('RingBuffer capacity must be a positive integer');
    this.capacity = capacity;
    this.items = new Array(capacity);
    this.start = 0; // index of the oldest item
    this.length = 0;
  }

  push(item) {
    if (this.length < this.capacity) {
      this.items[(this.start + this.length) % this.capacity] = item;
      this.length++;
    } else {
      this.items[this.start] = item; // overwrite the oldest
      this.start = (this.start + 1) % this.capacity;
    }
    return item;
  }

  /** i-th item, oldest first (0 = oldest). */
  at(i) {
    if (i < 0 || i >= this.length) return undefined;
    return this.items[(this.start + i) % this.capacity];
  }

  /** Newest item or undefined. */
  last() {
    return this.length ? this.at(this.length - 1) : undefined;
  }

  /** Iterate newest → oldest. */
  *newestFirst() {
    for (let i = this.length - 1; i >= 0; i--) yield this.at(i);
  }

  /** Copy, oldest first. */
  toArray() {
    const out = new Array(this.length);
    for (let i = 0; i < this.length; i++) out[i] = this.at(i);
    return out;
  }

  clear() {
    this.items = new Array(this.capacity);
    this.start = 0;
    this.length = 0;
  }
}

/**
 * Normalise a `kind` filter: null/'' → null (no filter); 'a,b' or ['a','b'] → Set.
 * Accepting a list is a small convenience on top of SPEC (a single kind still works as before).
 */
function kindFilter(kind) {
  if (kind == null || kind === '') return null;
  const list = Array.isArray(kind) ? kind : String(kind).split(',');
  const set = new Set(list.map((k) => String(k).trim()).filter(Boolean));
  return set.size ? set : null;
}

/** Merge two lists that are each sorted by ascending seq into one ascending list (seqs are unique). */
function mergeBySeq(a, b) {
  const out = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = a[i].seq <= b[j].seq ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

/** Bytes read from the end of an existing jsonl file to find its newest record. */
const TAIL_BYTES = 64 * 1024;

/**
 * Inspect the end of an existing jsonl file → { lastSeq, torn }: the seq of its newest parseable
 * record (0 if none) and whether it ends mid-line (a crash during an append).
 */
function readTail(file, size) {
  const length = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, length, size - length);
  } finally {
    fs.closeSync(fd);
  }
  const torn = buf[length - 1] !== 0x0a; // '\n'
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const seq = JSON.parse(lines[i]).seq;
      if (Number.isSafeInteger(seq) && seq > 0) return { lastSeq: seq, torn };
    } catch {
      /* partial first line of the tail, or a torn last line */
    }
  }
  return { lastSeq: 0, torn };
}

/** Clamp to an integer in [lo, hi], falling back to `dflt` for non-numbers. */
function clampInt(value, lo, hi, dflt) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

export class Journal {
  /**
   * @param {object} [opts]
   * @param {string|null} [opts.file]   jsonl path to append every record to (null = memory only)
   * @param {number} [opts.keep]         records kept in memory
   * @param {number} [opts.maxFileBytes] rotate `file` to `file.1` beyond this size (0 = never)
   * @param {(msg:string)=>void} [opts.log]
   * @param {boolean} [opts.scoped]      accounts mode: user kinds need a uid (see the file header)
   * @param {string[]} [opts.globalKinds] kinds that are global in scoped mode (default GLOBAL_KINDS)
   * @param {object} [opts.userStore]    where user records live (server/garden/repo.js EventStore):
   *   { add(record), since(uid, afterSeq, limit) → records, query(uid, {kinds, limit}) → records (newest first),
   *     count(uid, kinds) → number, maxSeq() → number }. May also be attached later (attachUserStore).
   */
  constructor({
    file = null, keep = 5000, maxFileBytes = DEFAULT_MAX_FILE_BYTES, log = console.warn,
    scoped = false, globalKinds = GLOBAL_KINDS, userStore = null,
  } = {}) {
    this.keep = clampInt(keep, 1, 1e7, 5000);
    this.ring = new RingBuffer(this.keep);
    this.seq = 0; // seq of the last emitted record (0 = none yet)
    this.subscribers = new Set();
    this.log = log;
    this.file = file || null;
    this.maxFileBytes = Number(maxFileBytes) > 0 ? Number(maxFileBytes) : 0;
    this.fileBytes = 0;
    this.fileFailed = false;
    this.tornTail = false; // true when an existing file ends mid-line (crash during an append)
    this.scoped = scoped === true;
    this.globalKinds = new Set(Array.isArray(globalKinds) ? globalKinds : GLOBAL_KINDS);
    this.userStore = null;
    this.droppedSeq = 0; // seq of the newest GLOBAL record that left the ring (replays from before it must resync)
    this.unscopedRefused = 0;
    if (this.file) this.#openFile();
    if (userStore) this.attachUserStore(userStore);
  }

  /**
   * Attach (or replace) the store of user records. The seq counter jumps past the store's newest record so a
   * seq is never reused after a crash (PLATFORM §8.7: journal.seq = max(journal.seq, max(events.seq))).
   */
  attachUserStore(store) {
    this.userStore = store && typeof store.add === 'function' ? store : null;
    const max = Number(this.userStore?.maxSeq?.());
    if (Number.isSafeInteger(max) && max > this.seq) this.seq = max;
    return this;
  }

  /**
   * The per-player facade a garden (LiveLayer, TestnetVenue) is given: a frozen `{uid, scoped: true, emit}` whose
   * emit always carries the uid. LiveLayer refuses an `owner` without a matching facade (PLATFORM §7.1 #7).
   */
  forUser(uid) {
    checkUid(uid);
    return Object.freeze({ uid, scoped: true, emit: (kind, data) => this.emit(kind, data, { uid }) });
  }

  /** Whether `record` may be delivered to a stream / query of player `uid` (null = spectator). */
  visibleTo(record, uid) {
    const owner = recordUid(record);
    if (owner === null) return !this.scoped || this.globalKinds.has(record?.kind);
    return Number.isSafeInteger(uid) && owner === uid;
  }

  /** Seq of the newest record (0 if none). */
  get lastSeq() {
    return this.seq;
  }

  /**
   * Continue numbering at least after `min` (never backwards). Cloud persistence (main.js): the engine state can be
   * older than what the previous instance emitted, so the boot jumps past the seq its lease.json recorded — a gap is
   * harmless, a reused seq is not. Records up to `min` that this process never had cannot be replayed: a
   * Last-Event-ID before it answers `resync`.
   * @returns {number} the seq now
   */
  advanceSeq(min) {
    if (Number.isSafeInteger(min) && min > this.seq) {
      this.seq = min;
      this.droppedSeq = Math.max(this.droppedSeq, min);
    }
    return this.seq;
  }

  /** Number of records currently held in memory. */
  get size() {
    return this.ring.length;
  }

  /**
   * Record and broadcast an event. Never throws because of a subscriber or the file.
   * @returns {object} the record `{ seq, t, kind, ...data }`
   */
  emit(kind, data = {}, scope = undefined) {
    if (typeof kind !== 'string' || !kind) throw new TypeError('journal kind must be a non-empty string');
    const uid = scope?.uid ?? null;
    if (uid !== null) checkUid(uid);
    if (uid === null && this.scoped && !this.globalKinds.has(kind)) {
      // Fail closed: never stored, never broadcast. An alert line names the kind only (never the data).
      this.unscopedRefused++;
      this.log(`[journal] ALERT unscoped_user_event: '${kind}' emitted without a uid — refused`);
      throw new JournalScopeError(kind);
    }
    const record = { seq: ++this.seq, t: Date.now(), kind };
    if (data && typeof data === 'object') {
      for (const key of Object.keys(data)) if (!RESERVED.has(key) && !(this.scoped && key === 'uid')) record[key] = data[key];
    }
    if (uid !== null) {
      tagUserRecord(record, uid);
      try {
        this.userStore?.add(record);
      } catch (err) {
        this.log(`[journal] user record ${record.seq} (${kind}) not stored: ${err?.message || err}`);
      }
    } else {
      if (this.ring.length === this.ring.capacity) this.droppedSeq = this.ring.at(0).seq;
      this.ring.push(record);
      if (this.file && !this.fileFailed) this.#append(record);
    }
    for (const fn of this.subscribers) {
      try {
        fn(record);
      } catch (err) {
        this.log(`[journal] subscriber failed: ${err?.message || err}`);
      }
    }
    return record;
  }

  /** @returns {() => void} unsubscribe */
  subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscriber must be a function');
    this.subscribers.add(fn);
    return () => this.unsubscribe(fn);
  }

  unsubscribe(fn) {
    this.subscribers.delete(fn);
  }

  /**
   * Records with seq > `seq`, oldest first (for SSE Last-Event-ID replay). If `seq` is older than the
   * buffer, everything buffered is returned; if it is not a number, nothing is.
   */
  since(seq) {
    const after = Number(seq);
    if (!Number.isFinite(after) || this.ring.length === 0) return [];
    const firstSeq = this.ring.at(0).seq;
    // seqs in the buffer are contiguous unless restore() loaded a gappy list, so search from the end.
    if (after < firstSeq) return this.ring.toArray();
    const out = [];
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const rec = this.ring.at(i);
      if (rec.seq <= after) break;
      out.push(rec);
    }
    return out.reverse();
  }

  /**
   * Newest first, optionally filtered by kind (a kind, a CSV of kinds or an array).
   * @returns {{ rows: object[], total: number }} total = number of matching records held
   */
  query({ kind = null, limit = 100, offset = 0 } = {}) {
    const lim = clampInt(limit, 0, this.keep, 100);
    const off = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const kinds = kindFilter(kind);
    const rows = [];
    let total = 0;
    for (const rec of this.ring.newestFirst()) {
      if (kinds && !kinds.has(rec.kind)) continue;
      if (total >= off && rows.length < lim) rows.push(rec);
      total++;
    }
    return { rows, total };
  }

  /**
   * Last-Event-ID replay for one stream (PLATFORM §8.7): global records with seq > `seq` merged with the
   * player's own records (none for a spectator, `uid` null), oldest first. Answers `{ resync: true }` when a
   * global record after `seq` has already left the ring, or when more than `limit` records are missing: the
   * client then does a full refresh. A non-numeric `seq` replays nothing.
   * @returns {object[] | {resync: true}}
   */
  sinceFor(uid, seq, limit = REPLAY_LIMIT) {
    const after = Number(seq);
    if (!Number.isFinite(after)) return [];
    const lim = clampInt(limit, 1, 1e6, REPLAY_LIMIT);
    if (after < this.droppedSeq) return { resync: true };
    const global = this.since(after).filter((r) => this.visibleTo(r, null));
    let own = [];
    if (Number.isSafeInteger(uid) && this.userStore && after < this.seq) {
      own = this.userStore.since(uid, after, lim + 1) ?? [];
    }
    if (global.length + own.length > lim) return { resync: true };
    if (own.length === 0) return global;
    return mergeBySeq(global, own.filter((r) => recordUid(r) === uid));
  }

  /**
   * The `events` query for one player (null = spectator: global records only), newest first. Merges the global
   * ring with the player's stored records; `total` counts both.
   * @returns {{ rows: object[], total: number }}
   */
  queryFor(uid, { kind = null, limit = 100, offset = 0 } = {}) {
    if (!Number.isSafeInteger(uid) || !this.userStore) {
      const res = this.query({ kind, limit, offset });
      if (!this.scoped) return res;
      return { rows: res.rows.filter((r) => this.visibleTo(r, null)), total: res.total };
    }
    const lim = clampInt(limit, 0, this.keep, 100);
    const off = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const kinds = kindFilter(kind);
    const need = off + lim;
    const global = [];
    let globalTotal = 0;
    for (const rec of this.ring.newestFirst()) {
      if (kinds && !kinds.has(rec.kind)) continue;
      if (!this.visibleTo(rec, null)) continue;
      if (global.length < need) global.push(rec);
      globalTotal++;
    }
    const kindList = kinds ? [...kinds] : null;
    const own = (this.userStore.query(uid, { kinds: kindList, limit: need }) ?? []).filter((r) => recordUid(r) === uid);
    const ownTotal = Number(this.userStore.count?.(uid, kindList)) || own.length;
    const merged = mergeBySeq(global.slice().reverse(), own.slice().reverse()).reverse();
    return { rows: merged.slice(off, off + lim), total: globalTotal + ownTotal };
  }

  /** In-memory state (the file is not part of it). Global records only: user records live in the DB. */
  serialize() {
    return { seq: this.seq, records: this.ring.toArray() };
  }

  /** Restore memory state; the seq counter never goes backwards. Does not re-append to the file. */
  restore(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const records = Array.isArray(obj.records)
      ? obj.records.filter((r) => r && typeof r === 'object' && Number.isFinite(r.seq) && typeof r.kind === 'string')
      : [];
    records.sort((a, b) => a.seq - b.seq);
    this.ring.clear();
    const kept = records.slice(-this.keep);
    for (const rec of kept) this.ring.push(rec);
    const lastRecordSeq = records.length ? records[records.length - 1].seq : 0;
    this.seq = Math.max(this.seq, Number.isFinite(obj.seq) ? obj.seq : 0, lastRecordSeq);
    // Anything before the oldest restored record is gone: a replay from before it must resync.
    this.droppedSeq = Math.max(this.droppedSeq, kept.length ? kept[0].seq - 1 : this.seq);
    return true;
  }

  // ---- file sink -------------------------------------------------------------------------------

  #openFile() {
    try {
      fs.mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
      const st = fs.existsSync(this.file) ? fs.statSync(this.file) : null;
      this.fileBytes = st ? st.size : 0;
      // After a crash the file can be ahead of the last saved state: continue numbering after its
      // newest record so seq stays unique in the file (and monotonic for SSE Last-Event-ID).
      if (st?.isFile() && st.size > 0) {
        const tail = readTail(this.file, st.size);
        this.seq = Math.max(this.seq, tail.lastSeq);
        this.tornTail = tail.torn; // the next append starts on a fresh line
      }
    } catch (err) {
      this.#fileError(err);
    }
  }

  #append(record) {
    const json = JSON.stringify(record) + '\n';
    try {
      if (this.maxFileBytes && this.fileBytes > 0 && this.fileBytes + Buffer.byteLength(json) > this.maxFileBytes) this.#rotate();
      const line = this.tornTail ? '\n' + json : json;
      fs.appendFileSync(this.file, line);
      this.fileBytes += Buffer.byteLength(line);
      this.tornTail = false;
    } catch (err) {
      this.#fileError(err);
    }
  }

  /** Keep exactly one previous generation: file → file.1 (replacing an older file.1). */
  #rotate() {
    const old = `${this.file}.1`;
    try {
      fs.rmSync(old, { force: true });
    } catch {
      /* ignore: rename below will report a real problem */
    }
    fs.renameSync(this.file, old);
    this.fileBytes = 0;
    this.tornTail = false;
  }

  /** Log once and stop writing; the in-memory journal keeps working. */
  #fileError(err) {
    if (!this.fileFailed) this.log(`[journal] cannot write ${this.file}: ${err?.message || err} — continuing in memory only`);
    this.fileFailed = true;
  }
}

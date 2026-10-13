// server/garden/gardens.js — every player's garden in one process (PLATFORM §7.2, §7.6; accounts mode only).
//
// A garden is one LiveLayer (server/live.js) built with `owner`, the repo and — when the testnet is enabled — the
// player's own TestnetVenue. Gardens are loaded ON DEMAND (a request, or an open bot at boot) and evicted when idle with
// no open bots. Only gardens with ≥ 1 open bot are visited by the engine hooks, so a tick costs O(open bots):
//
//   afterTick(summary)  engine onTick: each OPEN garden mirrors (paper, synchronous) / plans (testnet), the testnet
//                       venues are asked for one sync each (not while the engine replays missed bars), then ONE flush.
//   markLive(marks)     engine onMarks: open gardens only (paper: liquidation + marks at mainnet mids; testnet: marks
//                       at testnet mids).
//   marksFor(uid)       the per-subscriber part of a `mids` frame ({bots, account, testnet_account}), memoized per
//                       frame. It is attached by the SSE writer per stream, never put into the shared frame (§7.5).
//
// Isolation is fail-closed: each garden only ever sees journal.forUser(uid) (its LiveLayer refuses anything else) and
// its own venue; every lane job and retry timer carries the garden epoch; teardown(uid) cancels the lane, its timers,
// its streams and its caches synchronously, so a deleted player's pending work can never touch a later garden (§2.2).
//
// Composition (main.js): new Gardens({engine, journal, db, testnet, lib, credentials, admin, users, config, …}),
// then `await gardens.init()`, then wireAccounts({engine, gardens, pulse}).

import { ApiError, LiveLayer, venueOf, LIVE_DEFAULTS, TESTNET_CAP_DEFAULTS, ACCOUNTS_LOG_KEEP } from '../live.js';
import { GardenRepo } from './repo.js';
import { TestnetVenue, FAUCET_URL } from './testnet-venue.js';

/** Idle gardens (no open bots, no request for this long) are unloaded (§2.2). */
export const IDLE_EVICT_MS = 30 * 60_000;
/** Authenticated activity is written at most this often (§4.6 step 9). */
export const TOUCH_EVERY_MS = 5 * 60_000;
/** Account deletion awaits the testnet flatten this long (§4.6 step 6.2). */
export const DELETE_FLATTEN_MS = 15_000;
/** A mainnet re-check hit flattens within this deadline before the wipe (§6.7, R15). */
export const MAINNET_HIT_FLATTEN_MS = 60_000;
/** API-wallet expiry thresholds (§6.11). */
export const EXPIRY = Object.freeze({ warn7d: 7 * 86_400_000, warn1d: 86_400_000, flatten: 30 * 60_000 });
/** Validity asked for a browser-wallet agent: 90 days (Hyperliquid allows at most 180; §6.10). */
export const AGENT_VALIDITY_MS = 90 * 86_400_000;
/** Periodic mainnet re-check of stored credentials (§6.7). */
export const MAINNET_RECHECK_MS = 24 * 3600_000;

const DEFAULT_CONFIG = Object.freeze({
  testnetMaxActiveUsers: 40,
  inactivityDays: 14,
  minOrderUsd: LIVE_DEFAULTS.minOrderUsd,
});

/** Global caps (snake_case, as admin_caps and live_status show them). */
export function defaultCaps(paper = {}) {
  return {
    paper: {
      account_usd: paper.accountUsd ?? LIVE_DEFAULTS.accountUsd,
      max_bots: paper.maxBots ?? LIVE_DEFAULTS.maxBots,
      min_capital_usd: paper.minCapitalUsd ?? LIVE_DEFAULTS.minCapitalUsd,
      max_bot_capital_usd: paper.maxBotCapitalUsd ?? LIVE_DEFAULTS.maxBotCapitalUsd,
      max_total_notional_usd: paper.maxTotalNotionalUsd ?? LIVE_DEFAULTS.maxTotalNotionalUsd,
    },
    testnet: {
      max_bots: TESTNET_CAP_DEFAULTS.maxBots,
      min_capital_usd: TESTNET_CAP_DEFAULTS.minCapitalUsd,
      max_bot_capital_usd: TESTNET_CAP_DEFAULTS.maxBotCapitalUsd,
      max_total_notional_usd: TESTNET_CAP_DEFAULTS.maxTotalNotionalUsd,
    },
  };
}

const PAPER_KEYS = ['account_usd', 'max_bots', 'min_capital_usd', 'max_bot_capital_usd', 'max_total_notional_usd'];
const TESTNET_KEYS = ['max_bots', 'min_capital_usd', 'max_bot_capital_usd', 'max_total_notional_usd'];

/** Keep only known, positive numeric cap fields (admin input). */
function cleanCaps(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of keys) {
    const n = Number(obj[k]);
    if (Number.isFinite(n) && n > 0) out[k] = k === 'max_bots' ? Math.floor(n) : n;
  }
  return out;
}

const toCamelPaper = (p) => ({
  accountUsd: p.account_usd, maxBots: p.max_bots, minCapitalUsd: p.min_capital_usd,
  maxBotCapitalUsd: p.max_bot_capital_usd, maxTotalNotionalUsd: p.max_total_notional_usd,
});
const toCamelTestnet = (t) => ({
  maxBots: t.max_bots, minCapitalUsd: t.min_capital_usd, maxBotCapitalUsd: t.max_bot_capital_usd,
  maxTotalNotionalUsd: t.max_total_notional_usd,
});

export class Gardens {
  /**
   * @param {object} o
   * @param {object} o.engine        the shared Engine
   * @param {object} o.journal       the global Journal built with {scoped: true, globalKinds: GLOBAL_KINDS}
   * @param {object} o.db            WP1 Db
   * @param {Function} [o.repoFactory]  ({db, now, log}) → GardenRepo (tests); default new GardenRepo
   * @param {object} [o.testnet]     createTestnet() result { scheduler, info, market, exchange, verify } or null
   * @param {object} [o.lib]         WP2 modules { wire, format, errors, constants, signing, verify, addr }
   * @param {object} [o.credentials] Credentials (server/garden/credentials.js)
   * @param {object} [o.caps]        initial global caps (snake_case {paper, testnet}); admin_state 'caps' wins
   * @param {object} [o.admin]       WP1 Admin (kill switch, caps, signing halt, audit) — optional
   * @param {object} [o.users]       WP1 Users (remove on account deletion) — optional
   * @param {object} [o.mainnetInfo] the mainnet userRole source for the guard (HyperliquidClient) — optional
   * @param {object} [o.config]      { testnetMaxActiveUsers, inactivityDays, minOrderUsd }
   */
  constructor({ engine, journal, db, repoFactory = null, testnet = null, lib = null, credentials = null, caps = null,
    admin = null, users = null, mainnetInfo = null, now = Date.now, log = console.warn, config = {} } = {}) {
    if (!engine || !journal || !db) throw new TypeError('Gardens needs engine, journal and db');
    if (journal.scoped !== true || typeof journal.forUser !== 'function') {
      throw new TypeError('Gardens needs the scoped journal (new Journal({scoped: true, globalKinds: GLOBAL_KINDS}))');
    }
    this.engine = engine;
    this.journal = journal;
    this.db = db;
    this.now = now;
    this.log = log;
    this.repo = repoFactory ? repoFactory({ db, now, log }) : new GardenRepo({ db, now, log });
    this.hl = testnet;
    this.lib = lib ?? {};
    this.credentials = credentials;
    this.admin = admin;
    this.users = users;
    this.mainnetInfo = mainnetInfo;
    this.config = { ...DEFAULT_CONFIG, ...(config || {}) };
    this.http = null;
    // uid → { garden: LiveLayer, venue: TestnetVenue|null, epoch, seenMs, touchedMs }
    this.loaded = new Map();
    this.open = new Set(); // LiveLayers with ≥ 1 open bot
    this.testnetActive = new Set(); // uids that count as active testnet players
    this.tornDown = new Set(); // uids torn down in this process (their epoch never matches again)
    this.frame = 0;
    this.memo = new Map(); // uid → { frame, part }
    this.wasCatchingUp = false;
    this.feedState = null;
    this.stopped = false;
    // Persisted global state.
    this.caps = this.#loadCaps(caps);
    this.kill = this.#loadKill();
    this.signing = this.#loadSigning();
    this.journal.attachUserStore(this.repo.events);
    this.hl?.scheduler?.setEpochSource?.((uid) => this.epochOf(uid));
    this.unsubs = [];
    if (this.hl) {
      // The exchange enforces the signing halt; it starts from the persisted state (§6.9).
      if (this.signing.halted) this.hl.exchange?.setSigningHalt?.(true, { sample: null });
      const off1 = this.hl.exchange?.onSigningHalt?.(({ sample } = {}) => this.haltSigning({ sample }));
      // testnet_feed {state, prev, reason, error} is a GLOBAL record (§8.7).
      const off2 = this.hl.market?.onStateChange?.((ev) => this.#feedChanged(ev));
      for (const off of [off1, off2]) if (typeof off === 'function') this.unsubs.push(off);
      this.feedFromMarket = typeof off2 === 'function';
    }
  }

  /** WP4's server, for closeStreamsFor({uid}) on teardown. */
  setHttp(http) {
    this.http = http ?? null;
  }

  get testnetEnabled() {
    return Boolean(this.hl);
  }

  // ---- persisted global state ---------------------------------------------------------------------------------------

  #adminState(key) {
    try {
      return this.repo.adminState(key)?.value ?? null;
    } catch {
      return null;
    }
  }

  #loadCaps(initial) {
    const base = defaultCaps();
    const merge = (src) => {
      if (!src) return;
      Object.assign(base.paper, cleanCaps(src.paper, PAPER_KEYS));
      Object.assign(base.testnet, cleanCaps(src.testnet, TESTNET_KEYS));
    };
    merge(initial);
    let stored = null;
    try {
      stored = typeof this.admin?.getCaps === 'function' ? this.admin.getCaps() : this.#adminState('caps');
    } catch {
      stored = this.#adminState('caps');
    }
    merge(stored);
    return base;
  }

  #loadKill() {
    let k = null;
    try {
      k = typeof this.admin?.getKillSwitch === 'function' ? this.admin.getKillSwitch() : this.#adminState('kill_switch');
    } catch {
      k = this.#adminState('kill_switch');
    }
    return { on: Boolean(k?.on), reason: k?.reason ?? null, since_ms: k?.since_ms ?? null };
  }

  #loadSigning() {
    let s = null;
    try {
      s = typeof this.admin?.getSigningHalt === 'function' ? this.admin.getSigningHalt() : this.#adminState('testnet_signing');
    } catch {
      s = this.#adminState('testnet_signing');
    }
    return { halted: Boolean(s?.halted), since_ms: s?.since_ms ?? null };
  }

  /** Current caps for one player: global caps with the per-user override (gardens.caps_json, P1). */
  capsFor(uid) {
    if (typeof this.admin?.getUserCaps === 'function') {
      try {
        const c = this.admin.getUserCaps(uid);
        return { paper: { ...this.caps.paper, ...cleanCaps(c.paper, PAPER_KEYS) }, testnet: { ...this.caps.testnet, ...cleanCaps(c.testnet, TESTNET_KEYS) } };
      } catch {
        /* fall back to the row */
      }
    }
    const out = { paper: { ...this.caps.paper }, testnet: { ...this.caps.testnet } };
    const row = this.repo.gardenRow(uid);
    if (row?.caps_json) {
      try {
        const o = JSON.parse(row.caps_json);
        Object.assign(out.paper, cleanCaps(o.paper, PAPER_KEYS));
        Object.assign(out.testnet, cleanCaps(o.testnet, TESTNET_KEYS));
      } catch {
        /* a broken override is ignored */
      }
    }
    return out;
  }

  // ---- loading -------------------------------------------------------------------------------------------------------

  /**
   * Boot: load every garden with open bots (and every player with unresolved testnet orders), then run each testnet
   * venue's restart procedure (resolve orders by cloid, reconcile, re-issue flatten intents; §6.11 Restart).
   */
  async init() {
    const uids = new Set(this.repo.openBotUsers());
    if (this.hl) for (const uid of this.repo.unresolvedOrderUsers()) uids.add(uid);
    for (const uid of uids) {
      try {
        this.get(uid, { touch: false });
      } catch (err) {
        this.log(`[gardens] could not load garden ${uid}: ${err?.message || err}`);
      }
    }
    const boots = [];
    for (const rec of this.loaded.values()) if (rec.venue) boots.push(rec.venue.boot());
    // The boot jobs run on the lanes; do not block the server start on the testnet answering.
    Promise.allSettled(boots).then(() => {}, () => {});
    return { loaded: this.loaded.size, open: this.open.size };
  }

  /** The garden epoch of a loaded garden (the scheduler's epoch source); null after teardown. */
  epochOf(uid) {
    const rec = this.loaded.get(uid);
    if (rec) return rec.epoch;
    if (this.tornDown.has(uid)) return null;
    try {
      return this.repo.gardenRow(uid)?.epoch ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The garden of `uid`, loaded on demand (creates the gardens row if missing). `touch` records authenticated
   * activity (at most once per 5 min in the DB).
   * @returns {LiveLayer}
   */
  get(uid, { touch = true } = {}) {
    if (!Number.isSafeInteger(uid) || uid < 1) throw new ApiError(401, 'sign in to use a garden', 'auth_required');
    let rec = this.loaded.get(uid);
    if (!rec) rec = this.#load(uid);
    const now = this.now();
    rec.seenMs = now;
    if (touch && now - rec.touchedMs >= TOUCH_EVERY_MS) {
      rec.touchedMs = now;
      try {
        this.repo.touchGarden(uid, TOUCH_EVERY_MS);
      } catch (err) {
        this.log(`[gardens] touch ${uid} failed: ${err?.message || err}`);
      }
    }
    return rec.garden;
  }

  /** The loaded garden of `uid`, or null (never loads). */
  peek(uid) {
    return this.loaded.get(uid)?.garden ?? null;
  }

  /** The loaded venue of `uid`, or null. */
  venueOf(uid) {
    return this.loaded.get(uid)?.venue ?? null;
  }

  #load(uid) {
    const user = this.repo.user(uid);
    if (!user) throw new ApiError(404, 'no such player', 'not_found');
    this.tornDown.delete(uid);
    const row = this.repo.ensureGarden(uid, { accountUsd: this.caps.paper.account_usd });
    const caps = this.capsFor(uid);
    const facade = this.journal.forUser(uid);
    const venue = this.hl
      ? new TestnetVenue({
        uid, epoch: row.epoch, hl: this.hl, lib: this.lib, credentials: this.credentials, repo: this.repo,
        gardens: this, journal: facade, now: this.now, log: this.log,
      })
      : null;
    const garden = new LiveLayer({
      config: { ...toCamelPaper(caps.paper), accountUsd: row.account_usd, minOrderUsd: this.config.minOrderUsd },
      engine: this.engine,
      journal: facade,
      now: this.now,
      log: this.log,
      owner: { uid, username: user.username },
      repo: this.repo,
      testnet: venue,
      logKeep: ACCOUNTS_LOG_KEEP,
      testnetCaps: toCamelTestnet(caps.testnet),
      garden: row,
      hooks: { changed: (g) => this.#membership(g) },
    });
    const rec = { garden, venue, epoch: row.epoch, seenMs: this.now(), touchedMs: Number(row.last_active_ms) || 0, uid };
    this.loaded.set(uid, rec);
    this.#membership(garden);
    return rec;
  }

  /** Keep `open` / `testnetActive` in step with a garden (called after commands and venue callbacks). */
  #membership(g) {
    const uid = g.owner?.uid;
    if (!this.loaded.has(uid)) return;
    if (g.openCount() > 0) this.open.add(g);
    else this.open.delete(g);
    if (g.testnetActive()) this.testnetActive.add(uid);
    else this.testnetActive.delete(uid);
  }

  // ---- engine hooks (§7.6) ---------------------------------------------------------------------------------------------

  afterTick(summary) {
    for (const g of [...this.open]) {
      try {
        g.afterTick(summary);
      } catch (err) {
        this.log(`[gardens] garden ${g.owner?.uid} afterTick failed: ${err?.message || err}`);
      }
      this.#membership(g);
    }
    this.#catchUpEdge();
    this.flush();
  }

  markLive(marks) {
    this.frame++;
    for (const g of this.open) {
      try {
        g.markLive(marks);
      } catch (err) {
        this.log(`[gardens] garden ${g.owner?.uid} markLive failed: ${err?.message || err}`);
      }
    }
    this.#catchUpEdge();
    this.#watchFeed();
  }

  /** One sync for every testnet player once the engine has finished replaying missed bars (§6.11 catch-up). */
  #catchUpEdge() {
    const catching = Boolean(this.engine.catchingUp);
    if (this.wasCatchingUp && !catching) {
      for (const uid of this.testnetActive) {
        const rec = this.loaded.get(uid);
        if (!rec?.venue) continue;
        for (const bot of rec.garden.botList) {
          if (bot.state !== 'active' || venueOf(bot) !== 'testnet') continue;
          const row = this.engine.population?.row(bot.bean);
          if (row && !row.busted) rec.venue.planTarget(bot, row);
        }
        rec.venue.requestSync('catch_up');
      }
    }
    this.wasCatchingUp = catching;
  }

  #feedChanged({ state, prev, reason = null, error = null } = {}) {
    this.feedState = state;
    this.journal.emit('testnet_feed', { state, prev: prev ?? null, reason: reason ?? null, error: error ?? null });
    if (state !== 'live') return;
    // Back to live (outage over, or an admin cleared the signing halt): kept flatten intents resume, mirrors re-plan.
    if (!this.signingHalted()) this.signing = { halted: false, since_ms: null };
    for (const rec of this.loaded.values()) {
      if (!rec.venue || !rec.garden.testnetOpenCount()) continue;
      rec.venue.resumeIntents();
      rec.venue.requestSync('feed_live');
    }
  }

  /** Emit the global `testnet_feed` record when the testnet state changes (§8.7) — fallback without onStateChange. */
  #watchFeed() {
    if (!this.hl) return;
    if (this.feedFromMarket) {
      this.hl.market?.evaluate?.();
      return;
    }
    let state;
    try {
      state = this.signing.halted ? 'down' : this.hl.market?.state?.() ?? 'live';
    } catch {
      state = 'down';
    }
    if (state === this.feedState) return;
    const prev = this.feedState;
    this.feedState = state;
    if (prev === null) return;
    this.journal.emit('testnet_feed', { state, prev, reason: this.signing.halted ? 'signing' : null, error: null });
  }

  /**
   * The subscriber's own part of a `mids` frame: {bots, account, testnet_account} of a LOADED garden (null for a
   * spectator or a garden that is not loaded). Memoized per frame, so several tabs of one player cost one build.
   */
  marksFor(uid) {
    if (!Number.isSafeInteger(uid)) return null;
    const rec = this.loaded.get(uid);
    if (!rec) return null;
    const m = this.memo.get(uid);
    if (m && m.frame === this.frame) return m.part;
    const p = rec.garden.marksPayload();
    const part = { bots: p.bots, account: p.account, testnet_account: p.testnet_account ?? null };
    this.memo.set(uid, { frame: this.frame, part });
    return part;
  }

  /** The `testnet` part of a `mids` frame (testnet mids), or null when the testnet is disabled. */
  testnetSnapshot() {
    if (!this.hl) return null;
    try {
      return this.hl.market?.snapshot?.() ?? null;
    } catch {
      return null;
    }
  }

  /** Per-player venue verdict for Population.row/query/detail (§7.4): that player's PAPER verdict. */
  venueFor(uid) {
    const g = this.get(uid, { touch: false });
    return (row) => g.venue(row);
  }

  // ---- testnet-wide state ----------------------------------------------------------------------------------------------

  killSwitchState() {
    return { ...this.kill };
  }

  /** The exchange client owns the halt (an admin resume clears it there); without one, our persisted flag. */
  signingHalted() {
    const ex = this.hl?.exchange;
    if (ex && typeof ex.signingHalted === 'boolean') return ex.signingHalted;
    return this.signing.halted;
  }

  /** Active testnet players are below TESTNET_MAX_ACTIVE_USERS, or `uid` is already one of them (§6.8). */
  testnetCapacityOk(uid) {
    if (this.testnetActive.has(uid)) return true;
    return this.testnetActive.size < this.config.testnetMaxActiveUsers;
  }

  /**
   * Audit through WP1's Admin when present (its allowlist and detail filter apply, §5.4); otherwise a log line.
   * Accepts {action, actor, user_id|userId, ok, detail}.
   */
  audit(entry) {
    const e = { action: entry.action, actor: entry.actor ?? 'system', userId: entry.userId ?? entry.user_id ?? null,
      ok: entry.ok !== false, detail: entry.detail ?? null };
    try {
      if (typeof this.admin?.audit === 'function') return this.admin.audit(e);
    } catch (err) {
      this.log(`[gardens] audit failed: ${err?.message || err}`);
      return null;
    }
    this.log(`[audit] ${e.action} user=${e.userId ?? '-'} ok=${e.ok ? 1 : 0}`);
    return null;
  }

  /**
   * signature_mismatch (§6.9): our payload or signing is wrong, so EVERY testnet send stops — for everyone — until an
   * admin resumes. Credentials are untouched; bot intents stay in bot state.
   */
  haltSigning({ uid = null, sample = null } = {}) {
    if (this.signing.halted) return;
    const now = this.now();
    this.signing = { halted: true, since_ms: now };
    try {
      if (this.hl?.exchange && !this.hl.exchange.signingHalted) this.hl.exchange.setSigningHalt?.(true, { sample });
    } catch {
      /* the exchange already halted itself */
    }
    try {
      // WP1's Admin persists AND audits (testnet_signing_halted); without it, persist here and audit.
      if (typeof this.admin?.setSigningHalt === 'function') this.admin.setSigningHalt(true, sample);
      else {
        this.repo.setAdminState('testnet_signing', { halted: true, since_ms: now });
        this.audit({ user_id: uid, actor: 'system', action: 'testnet_signing_halted', ok: true, detail: { code: 'signature_mismatch' } });
      }
    } catch (err) {
      this.log(`[gardens] could not persist the signing halt: ${err?.message || err}`);
    }
    this.log('[testnet] ALERT signature_mismatch: testnet signing HALTED for everyone — page the operator');
    this.#watchFeed();
  }

  /** admin_testnet_signing {resume:true}: clear the halt and resume every kept flatten intent. */
  resumeSigning(by = null) {
    this.signing = { halted: false, since_ms: null };
    try {
      this.hl?.exchange?.setSigningHalt?.(false);
    } catch {
      /* nothing to clear */
    }
    try {
      if (typeof this.admin?.setSigningHalt === 'function') this.admin.setSigningHalt(false, null, by);
      else this.repo.setAdminState('testnet_signing', { halted: false, since_ms: null }, by);
    } catch (err) {
      this.log(`[gardens] could not persist the signing resume: ${err?.message || err}`);
    }
    for (const rec of this.loaded.values()) rec.venue?.resumeIntents();
    this.#watchFeed();
    return { signing_halted: false };
  }

  /**
   * Admin kill switch (§6.11): ON pauses every open testnet bot of every player (note kill_switch) and queues its
   * flatten at P0; testnet creates and resumes answer 503 kill_switch. OFF resumes nothing.
   */
  killSwitch({ on, reason = null, by = null } = {}) {
    const now = this.now();
    const wasOn = this.kill.on;
    this.kill = on ? { on: true, reason: reason ? String(reason).slice(0, 200) : null, since_ms: wasOn ? this.kill.since_ms : now }
      : { on: false, reason: null, since_ms: null };
    try {
      if (typeof this.admin?.setKillSwitch === 'function') this.admin.setKillSwitch(Boolean(on), this.kill.reason, by);
      else this.repo.setAdminState('kill_switch', this.kill, by);
    } catch (err) {
      this.log(`[gardens] could not persist the kill switch: ${err?.message || err}`);
    }
    const flattening = [];
    if (on) {
      // Every garden with open testnet bots is loaded (init() loads every garden with open bots).
      for (const rec of this.loaded.values()) {
        if (!rec.venue) continue;
        const ids = rec.garden.pauseTestnetBots('kill_switch', 'kill switch');
        for (const id of ids) flattening.push({ user_id: rec.uid, bot: id });
      }
    }
    if (on !== wasOn || on) this.journal.emit('kill_switch', { on: this.kill.on, reason: this.kill.reason, since_ms: this.kill.since_ms });
    return { kill_switch: this.killSwitchState(), on: this.kill.on, flattening };
  }

  /**
   * admin_caps (§7.3): global caps (and, with `user`, a per-user override); they apply to NEW bots. The loaded gardens
   * get the new caps at once.
   * @param {{paper?: object, testnet?: object, uid?: number}} patch
   */
  setCaps(patch = {}, by = null) {
    const sections = {};
    if (patch.paper) sections.paper = patch.paper;
    if (patch.testnet) sections.testnet = patch.testnet;
    if (Number.isSafeInteger(patch.uid)) {
      let override;
      if (typeof this.admin?.setUserCaps === 'function') {
        override = this.admin.setUserCaps(patch.uid, sections, by); // validates (400 bad_request), persists, audits
      } else {
        const cur = this.capsFor(patch.uid);
        override = { paper: { ...cur.paper, ...cleanCaps(patch.paper, PAPER_KEYS) },
          testnet: { ...cur.testnet, ...cleanCaps(patch.testnet, TESTNET_KEYS) } };
        this.repo.setGardenCaps(patch.uid, override);
      }
      this.loaded.get(patch.uid)?.garden.setCaps({ paper: toCamelPaper(override.paper), testnet: toCamelTestnet(override.testnet) });
      return override;
    }
    if (typeof this.admin?.setCaps === 'function') {
      const merged = this.admin.setCaps(sections, by); // validates (400 bad_request), persists, audits
      Object.assign(this.caps.paper, cleanCaps(merged.paper, PAPER_KEYS));
      Object.assign(this.caps.testnet, cleanCaps(merged.testnet, TESTNET_KEYS));
    } else {
      Object.assign(this.caps.paper, cleanCaps(patch.paper, PAPER_KEYS));
      Object.assign(this.caps.testnet, cleanCaps(patch.testnet, TESTNET_KEYS));
      this.repo.setAdminState('caps', this.caps, by);
    }
    for (const rec of this.loaded.values()) {
      const c = this.capsFor(rec.uid);
      rec.garden.setCaps({ paper: toCamelPaper(c.paper), testnet: toCamelTestnet(c.testnet) });
    }
    return { paper: { ...this.caps.paper }, testnet: { ...this.caps.testnet } };
  }

  /** admin_caps with `user`: a per-user override (P1) → the merged caps of that player. */
  setUserCaps(uid, patch = {}, by = null) {
    return this.setCaps({ ...patch, uid }, by);
  }

  // ---- seasons, halts ----------------------------------------------------------------------------------------------------

  /** garden_reset (§8.4): a new paper season at the current paper start cap. */
  resetSeason(uid, { confirm } = {}) {
    const g = this.get(uid);
    const out = g.resetSeason({ confirm, accountUsd: this.capsFor(uid).paper.account_usd });
    this.audit({ user_id: uid, actor: 'user', action: 'garden_reset', ok: true, detail: { count: out.closed.length } });
    this.#membership(g);
    return out;
  }

  /** bots_halt for one player (also admin_user halt). */
  halt(uid, { actor = 'user' } = {}) {
    const g = this.get(uid, { touch: actor === 'user' });
    const out = g.halt();
    this.audit({ user_id: uid, actor, action: 'garden_halt', ok: true, detail: { count: out.closed.length + (out.closing?.length ?? 0) } });
    return out;
  }

  rearm(uid, { confirm } = {}) {
    const out = this.get(uid).rearm({ confirm });
    this.audit({ user_id: uid, actor: 'user', action: 'garden_rearm', ok: true });
    return out;
  }

  // ---- teardown, deletion, disable -----------------------------------------------------------------------------------

  /**
   * Synchronous teardown of everything keyed by `uid` (§2.2, §7.2): the venue's lane, queued jobs and retry timers
   * (scheduler.cancelLane), the uid's SSE streams (http.closeStreamsFor), the marks memo, buffered writes, and the
   * loaded garden. Its epoch never matches again in this process.
   */
  teardown(uid, { keepWrites = false } = {}) {
    const rec = this.loaded.get(uid);
    this.tornDown.add(uid);
    if (rec) {
      rec.venue?.cancel();
      this.open.delete(rec.garden);
    }
    try {
      this.hl?.scheduler?.cancelLane?.(uid);
    } catch {
      /* no lane */
    }
    this.testnetActive.delete(uid);
    this.memo.delete(uid);
    if (keepWrites) {
      try {
        this.repo.flush();
      } catch (err) {
        this.log(`[gardens] flush before teardown of ${uid} failed: ${err?.message || err}`);
      }
    } else {
      this.repo.forget(uid);
    }
    this.loaded.delete(uid);
    try {
      this.http?.closeStreamsFor?.({ uid });
    } catch (err) {
      this.log(`[gardens] closeStreamsFor(${uid}) failed: ${err?.message || err}`);
    }
  }

  /**
   * The Admin `haltGarden` hook (disable, admin halt): burn the field and WAIT for the testnet flattens (≤ `ms`), so a
   * following teardown never cancels a flatten in flight (§4.6 step 7, §2.2). → {closed, closing, left_open}
   */
  async haltAndWait(uid, { reason = 'admin', ms = MAINNET_HIT_FLATTEN_MS } = {}) {
    const g = this.get(uid, { touch: false });
    const out = g.halt();
    this.audit({ user_id: uid, actor: 'admin', action: 'garden_halt', ok: true, detail: { reason, count: out.closed.length + (out.closing?.length ?? 0) } });
    const left = this.venueOf(uid) && out.closing?.length ? await this.#flattenAll(uid, ms) : [];
    return { ...out, left_open: left };
  }

  /** Take-over (§6.7 step 8): another garden got this player's abandoned testnet account; close our bots in books. */
  accountMoved(uid) {
    let g = this.peek(uid);
    if (!g) {
      try {
        g = this.get(uid, { touch: false });
      } catch {
        return;
      }
    }
    for (const bot of g.botList) if (bot.state !== 'closed' && venueOf(bot) === 'testnet') g.closeInBooks(bot.id, 'account_moved');
    this.journal.emit('credential_status', { status: 'revoked', reason: 'account_moved' }, { uid });
    this.flush();
  }

  /**
   * The higher-level testnet service http.js prefers (platform.testnetLink): link / connect / verify / disconnect.
   * `connect` receives the already-parsed key bytes (http.js zeroes them afterwards).
   */
  testnetLinkService() {
    return Object.freeze({
      link: (uid) => this.credentials?.link(uid) ?? null,
      connect: (uid, { accountAddress, agentKeyBytes }) => this.testnetConnectBytes(uid, { accountAddress, agentKeyBytes }),
      verify: (uid) => this.testnetVerify(uid),
      disconnect: (uid, { closeBots = false, force = false, by = 'user', reason = null } = {}) =>
        this.testnetDisconnect(uid, { close_bots: closeBots, force, actor: by === 'admin' ? 'admin' : 'user', reason }),
      prepareAgent: (uid) => this.testnetAgentPrepare(uid),
      approveAgent: (uid, { accountAddress, signature, nonce, chainId }) =>
        this.testnetAgentApprove(uid, { accountAddress, signature, nonce, chainId }),
    });
  }

  /**
   * testnet_agent_prepare (P1, §6.10 step 1): a server-generated agent key waits (sealed, in memory, ≤ 10 min) for the
   * player's wallet. Only `{agent_address, nonce, agent_name}` leave the server; the browser builds the typed data from
   * frozen constants (`hyperliquidChain: "Testnet"`).
   */
  testnetAgentPrepare(uid) {
    this.#requireTestnet();
    this.get(uid);
    if (typeof this.hl.exchange?.relayApproveAgent !== 'function') {
      throw new ApiError(404, 'the browser-wallet flow is not available on this server', 'not_found');
    }
    const now = this.now();
    const agentName = `bean-garden valid_until ${now + AGENT_VALIDITY_MS}`;
    const p = this.credentials.preparePending(uid, { agentName, nonce: now });
    return { agent_address: p.agentAddress, nonce: p.nonce, agent_name: p.agentName };
  }

  /**
   * testnet_agent_approve (P1, §6.10 step 3): the conflicts of §6.7 step 8 first (nothing is relayed when the result
   * could not be stored), then WP2's relay (it rebuilds the typed data with the literal "Testnet" and requires the
   * recovered signer to be the account: 422 signer_mismatch, nothing sent), then the normal connect path with the
   * prepared key (§6.7 steps 2–8, including the fail-closed mainnet guard). A transport failure of the relay is not
   * final: the approval may have landed, so verification decides.
   */
  async testnetAgentApprove(uid, { accountAddress, signature, nonce, chainId } = {}) {
    this.#requireTestnet();
    this.get(uid);
    const account = this.#normAddr(accountAddress);
    const pending = this.credentials.pendingAgent(uid);
    if (!pending) throw new ApiError(404, 'no API wallet is being prepared — start again', 'not_found');
    if (Number(nonce) !== pending.nonce) throw new ApiError(400, 'nonce does not match the prepared API wallet', 'bad_request');
    const chain = Number(chainId);
    if (!Number.isSafeInteger(chain) || chain <= 0) throw new ApiError(400, 'chain_id must be a positive integer', 'bad_request');
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw new ApiError(400, 'signature must be 65 bytes of 0x hex', 'bad_request');
    }
    this.credentials.assertConnectable(uid, account, pending.agentAddress);
    const r = await this.hl.exchange.relayApproveAgent({
      accountAddress: account, agentAddress: pending.agentAddress, agentName: pending.agentName, nonce: pending.nonce,
      chainId: chain, signature,
    });
    if (!r?.ok && !r?.transport && r?.code !== 'transport') {
      const code = r?.code ?? 'testnet_error';
      if (code === 'signer_mismatch') {
        throw new ApiError(422, 'the wallet that signed is not this testnet account', 'signer_mismatch');
      }
      if (code === 'bad_request') throw new ApiError(400, 'the approval could not be read', 'bad_request');
      if (code === 'no_deposit') {
        throw new ApiError(422, 'the testnet account has no funds — claim test USDC from the faucet first', 'no_testnet_funds', { faucet: FAUCET_URL });
      }
      if (['signature_mismatch', 'ip_rate_limited', 'skipped', 'address_rate_limited'].includes(code)) {
        throw new ApiError(503, 'the Hyperliquid testnet is not answering right now', 'testnet_down');
      }
      throw new ApiError(502, `the testnet refused the approval (${code})`, 'testnet_error', { exchange_code: code });
    }
    try {
      const out = await this.credentials.withPendingKey(uid, (keyBytes) =>
        this.testnetConnectBytes(uid, { accountAddress: account, agentKeyBytes: keyBytes }));
      this.credentials.dropPending(uid);
      return out;
    } catch (err) {
      // A relay that timed out and an agent the testnet does not know yet: not connected — let the player retry.
      if (err?.code === 'not_agent' && (r?.transport || r?.code === 'transport')) {
        throw new ApiError(503, 'the Hyperliquid testnet did not confirm the approval — try again', 'testnet_down');
      }
      throw err;
    }
  }

  /** Close every testnet bot of `uid` and wait (≤ `ms`) for the flattens; returns the coins still open. */
  async #flattenAll(uid, ms) {
    const g = this.peek(uid) ?? this.get(uid, { touch: false });
    const waits = [];
    for (const bot of g.botList) {
      if (bot.state === 'closed' || venueOf(bot) !== 'testnet') continue;
      if (!bot.closing) waits.push(Promise.resolve(g.close({ id: bot.id })).catch(() => {}));
      else waits.push(new Promise((resolve) => {
        const venue = this.venueOf(uid);
        if (!venue) return resolve();
        return venue.requestFlatten(bot, 'close').then(resolve, resolve);
      }));
    }
    const deadline = new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
    await Promise.race([Promise.allSettled(waits), deadline]);
    const left = [];
    const venue = this.venueOf(uid);
    for (const bot of g.botList) {
      if (bot.state === 'closed' || venueOf(bot) !== 'testnet') continue;
      const szi = venue?.positions?.get(bot.coin)?.szi ?? bot.exchange?.szi ?? bot.real.szi;
      if (szi) left.push({ coin: bot.coin, szi });
    }
    return left;
  }

  /**
   * Account deletion (§4.6 step 6): halt (paper closes now; testnet flattens, awaited ≤ 15 s); 409
   * testnet_positions_open unless `force`; teardown BEFORE the DELETE; then `remove()` (WP1 Users.remove: zero the
   * key, retire the name, DELETE … cascade, WAL checkpoint — in its transaction).
   * @returns {Promise<{deleted: true, closed: string[], testnet_left_open: {coin, szi}[]}>}
   */
  async deleteUser(uid, { force = false, remove = null } = {}) {
    const g = this.get(uid, { touch: false });
    const out = g.halt();
    const left = this.venueOf(uid) ? await this.#flattenAll(uid, DELETE_FLATTEN_MS) : [];
    if (left.length && force !== true) {
      throw new ApiError(409, 'testnet positions are still open — close them, or delete anyway', 'testnet_positions_open', { positions: left });
    }
    // Bots still closing are closed in our books only; their positions stay on testnet (the player was told).
    for (const bot of g.botList) if (bot.state !== 'closed' && venueOf(bot) === 'testnet') g.closeInBooks(bot.id, null);
    this.teardown(uid);
    try {
      this.credentials?.wipe(uid);
    } catch (err) {
      this.log(`[gardens] credential wipe for ${uid} failed: ${err?.code || err?.name || 'error'}`);
    }
    if (typeof remove === 'function') await remove(uid);
    else if (typeof this.users?.remove === 'function') await this.users.remove(uid);
    return { deleted: true, closed: [...out.closed, ...(out.closing ?? [])], testnet_left_open: left };
  }

  /**
   * Admin disable (§4.6 step 7): halt the garden (testnet flattened), then teardown once the flatten has finished
   * (≤ 60 s). Sessions are revoked by the caller (WP4/WP1).
   */
  async disableUser(uid) {
    const g = this.get(uid, { touch: false });
    g.halt();
    if (this.venueOf(uid)) await this.#flattenAll(uid, MAINNET_HIT_FLATTEN_MS);
    this.teardown(uid, { keepWrites: true });
    return { halted: true };
  }

  /**
   * Operator password reset (§4.6 step 8, R14): flatten the player's testnet bots (as disconnect with close_bots),
   * then WIPE the testnet credential, so a reset can never reach a key. A diary line follows.
   */
  async wipeTestnetForReset(uid) {
    if (this.venueOf(uid) || this.credentials?.link(uid)) {
      try {
        await this.testnetDisconnect(uid, { close_bots: true, force: true, actor: 'admin' });
      } catch (err) {
        this.log(`[gardens] reset wipe for ${uid}: ${err?.code || err?.name || 'error'}`);
        this.credentials?.wipe(uid);
      }
    }
    this.journal.emit('password_reset', {}, { uid });
    this.flush();
    return { wiped: true };
  }

  // ---- sweeps ---------------------------------------------------------------------------------------------------------

  /** Daily (§4.6 step 9): inactive players' testnet bots flatten and pause (note `inactive`); paper keeps running. */
  inactivitySweep() {
    if (!this.hl) return { paused: [] };
    const before = this.now() - this.config.inactivityDays * 86_400_000;
    const paused = [];
    for (const uid of this.repo.inactiveTestnetUsers(before)) {
      try {
        const g = this.get(uid, { touch: false });
        const ids = g.pauseTestnetBots('inactive', `inactive for ${this.config.inactivityDays} days`);
        if (ids.length) {
          paused.push({ user_id: uid, bots: ids });
          this.audit({ user_id: uid, actor: 'system', action: 'inactivity_pause', ok: true, detail: { count: ids.length } });
        }
      } catch (err) {
        this.log(`[gardens] inactivity sweep ${uid}: ${err?.message || err}`);
      }
    }
    return { paused };
  }

  /** Every 5 min (§6.11 API-wallet expiry): warnings at −7 d and −1 d (once each), flatten + pause at −30 min. */
  expirySweep() {
    if (!this.hl || !this.credentials) return { warned: [], paused: [] };
    const now = this.now();
    const warned = [];
    const paused = [];
    for (const c of this.credentials.expiring(now + EXPIRY.warn7d)) {
      const left = c.valid_until_ms - now;
      let flags = c.expiry_flags | 0;
      try {
        if (left <= EXPIRY.flatten && !(flags & 4)) {
          const g = this.get(c.user_id, { touch: false });
          const ids = g.pauseTestnetBots('agent_expiring', 'API wallet expiring');
          flags |= 4 | 2 | 1;
          paused.push({ user_id: c.user_id, bots: ids });
        } else if (left <= EXPIRY.warn1d && !(flags & 2)) {
          this.#expiryWarning(c.user_id, c.valid_until_ms, '1d');
          flags |= 2 | 1;
          warned.push({ user_id: c.user_id, warn: '1d' });
        } else if (left <= EXPIRY.warn7d && !(flags & 1)) {
          this.#expiryWarning(c.user_id, c.valid_until_ms, '7d');
          flags |= 1;
          warned.push({ user_id: c.user_id, warn: '7d' });
        }
        if (flags !== (c.expiry_flags | 0)) this.credentials.setExpiryFlags(c.user_id, flags);
      } catch (err) {
        this.log(`[gardens] expiry sweep ${c.user_id}: ${err?.message || err}`);
      }
    }
    this.flush();
    return { warned, paused };
  }

  #expiryWarning(uid, validUntilMs, warn) {
    this.journal.emit('live_error', {
      bot: null, error: `your testnet API wallet expires ${warn === '1d' ? 'within a day' : 'within a week'} — replace it`,
      code: 'agent_expiring', vars: { valid_until_ms: validUntilMs, warn },
    }, { uid });
  }

  /**
   * The periodic fail-closed mainnet re-check (§6.7): at most one due credential per call (main runs it every 30 s,
   * i.e. ≤ 2 per minute, sharing the slot with connects). `missing` → stamp; unavailable → retried next slot; any
   * other role → HIT: flatten (≤ 60 s), wipe, pause with `mainnet_key`, credential_status revoked, audit.
   */
  async mainnetRecheckSweep() {
    if (!this.hl || !this.credentials) return null;
    const due = this.credentials.dueMainnet(this.now() - MAINNET_RECHECK_MS, 1)[0];
    if (!due) return null;
    let role = 'unavailable';
    try {
      if (typeof this.hl.verify?.mainnetRecheck === 'function') role = await this.hl.verify.mainnetRecheck(due.agent_address);
      else if (typeof this.lib.verify?.mainnetRecheck === 'function') role = await this.lib.verify.mainnetRecheck(due.agent_address, this.mainnetInfo);
    } catch {
      role = 'unavailable';
    }
    await this.onRecheckResult({ uid: due.user_id, result: role, hit: role !== 'missing' && role !== 'unavailable' });
    return { user_id: due.user_id, role, hit: role !== 'missing' && role !== 'unavailable' };
  }

  /** WP2 MainnetRechecker onResult: 'missing' → stamp; 'unavailable' → retried next slot; a role → HIT (§6.7). */
  async onRecheckResult({ uid, result, hit }) {
    if (!this.credentials) return;
    if (result === 'missing') this.credentials.setMainnetChecked(uid);
    else if (hit) await this.#mainnetHit(uid, result);
  }

  /**
   * Background sweeps (main.js starts them in accounts mode): API-wallet expiry every 5 min, inactivity daily,
   * idle eviction every 5 min, and WP2's periodic mainnet re-checker (≤ 2/min through the mainnet client).
   */
  startSweeps({ setInterval: si = setInterval, clearInterval: ci = clearInterval } = {}) {
    this.stopSweeps();
    const every = (ms, fn) => {
      const h = si(() => {
        try {
          const r = fn();
          if (r && typeof r.catch === 'function') r.catch((err) => this.log(`[gardens] sweep failed: ${err?.message || err}`));
        } catch (err) {
          this.log(`[gardens] sweep failed: ${err?.message || err}`);
        }
      }, ms);
      h?.unref?.();
      return h;
    };
    this.sweepHandles = [every(5 * 60_000, () => this.expirySweep()), every(24 * 3600_000, () => this.inactivitySweep()),
      every(5 * 60_000, () => this.evictIdle())];
    this.sweepClear = ci;
    if (this.hl && this.credentials && typeof this.hl.verify?.rechecker === 'function') {
      this.rechecker = this.hl.verify.rechecker({
        listDue: () => this.credentials.recheckRows(),
        onResult: (r) => this.onRecheckResult(r),
      });
      this.rechecker.start();
    }
    // Boot passes (expiry and inactivity are cheap; both run once now).
    try {
      this.expirySweep();
      this.inactivitySweep();
    } catch (err) {
      this.log(`[gardens] boot sweep failed: ${err?.message || err}`);
    }
  }

  stopSweeps() {
    for (const h of this.sweepHandles ?? []) (this.sweepClear ?? clearInterval)(h);
    this.sweepHandles = [];
    this.rechecker?.stop?.();
    this.rechecker = null;
  }

  async #mainnetHit(uid, role) {
    this.log(`[testnet] ALERT mainnet re-check hit for user ${uid} (role ${role}): flattening and wiping the key`);
    const g = this.get(uid, { touch: false });
    g.pauseTestnetBots('mainnet_key', 'key known on mainnet');
    if (this.venueOf(uid)) await this.#flattenAll(uid, MAINNET_HIT_FLATTEN_MS);
    this.credentials.wipe(uid);
    for (const bot of g.botList) {
      if (bot.state === 'closed' || venueOf(bot) !== 'testnet') continue;
      if (bot.state === 'active') g.pauseFromExchange(bot.id, 'mainnet_key', { coin: bot.coin });
    }
    this.journal.emit('credential_status', { status: 'revoked', reason: 'mainnet_key' }, { uid });
    this.audit({ user_id: uid, actor: 'system', action: 'mainnet_key_detected', ok: true, detail: { reason: `mainnet_${role}` } });
    this.flush();
  }

  /** Every 5 min: unload gardens with no open bots that saw no request for 30 min (§2.2). */
  evictIdle() {
    const cutoff = this.now() - IDLE_EVICT_MS;
    let evicted = 0;
    for (const [uid, rec] of [...this.loaded]) {
      if (rec.seenMs > cutoff || rec.garden.openCount() > 0) continue;
      if (rec.venue && (rec.venue.lane?.busy || rec.venue.flattens.size)) continue;
      this.repo.flush();
      rec.venue?.cancel();
      this.open.delete(rec.garden);
      this.testnetActive.delete(uid);
      this.memo.delete(uid);
      this.loaded.delete(uid);
      evicted++;
    }
    return evicted;
  }

  /** One transaction for every queued write, one SAVEPOINT per garden (§3.5). */
  flush() {
    try {
      return this.repo.flush();
    } catch (err) {
      this.log(`[gardens] flush failed: ${err?.message || err}`);
      return { gardens: 0, failed: [] };
    }
  }

  /** admin_status parts (§8.6). */
  stats() {
    let paperOpen = 0;
    let testnetOpen = 0;
    for (const g of this.open) {
      for (const b of g.botList) {
        if (b.state === 'closed') continue;
        if (venueOf(b) === 'testnet') testnetOpen++;
        else paperOpen++;
      }
    }
    const sched = this.hl?.scheduler?.stats?.() ?? null;
    return {
      gardens_loaded: this.loaded.size,
      gardens_open: this.open.size,
      bots: { paper_open: paperOpen, testnet_open: testnetOpen },
      testnet: this.hl ? {
        enabled: true,
        state: this.feedState ?? this.hl.market?.state?.() ?? null,
        signing_halted: this.signing.halted,
        kill_switch: this.killSwitchState(),
        weight_60s: sched?.weight_60s ?? null,
        budget: sched?.budget ?? null,
        active_users: this.testnetActive.size,
        max_active_users: this.config.testnetMaxActiveUsers,
        exchange_actions_60s: sched?.exchange_actions_60s ?? null,
        errors_60s: sched?.errors_60s ?? null,
        lanes_busy: sched?.lanes_busy ?? null,
      } : { enabled: false },
      // admin_status.mainnet (§8.6): the mainnet userRole queue of the guard (HyperliquidClient.roleSnapshot) and the
      // verified credentials whose 24 h mainnet re-check is due (capped like the other admin counts)
      mainnet: this.hl ? {
        user_role_queue: this.#safeStat(() => (this.mainnetInfo ?? this.engine?.hl)?.roleSnapshot?.()),
        rechecks_due: this.#safeStat(() => this.credentials?.dueMainnet?.(this.now() - MAINNET_RECHECK_MS, 10_001)?.length),
      } : null,
      repo: { ...this.repo.stats },
    };
  }

  /** A stats read that must never break admin_status: any failure reads as null. */
  #safeStat(fn) {
    try {
      return fn() ?? null;
    } catch {
      return null;
    }
  }

  /** Shutdown (§10.4 steps 3–5): stop the testnet market, drain the scheduler (≤ 10 s), flush. */
  async shutdown({ drainMs = 10_000 } = {}) {
    this.stopped = true;
    this.stopSweeps();
    for (const off of this.unsubs ?? []) off();
    try {
      this.hl?.market?.stop?.();
    } catch {
      /* already stopped */
    }
    try {
      await this.hl?.scheduler?.drain?.(drainMs);
    } catch {
      /* best effort */
    }
    return this.flush();
  }

  // ---- testnet ops (accounts mode, §8.3) -------------------------------------------------------------------------------

  #requireTestnet() {
    if (!this.hl) throw new ApiError(503, 'the testnet venue is not enabled on this server', 'testnet_disabled');
  }

  /** testnet_market (public, cache only). */
  testnetMarket() {
    if (!this.hl) {
      return { enabled: false, state: 'disabled', state_reason: null, kill_switch: this.killSwitchState(), mids_ms: null,
        ctx_ms: null, coins: [] };
    }
    const m = this.hl.market;
    if (typeof m?.listing === 'function' && typeof m?.status === 'function') {
      const st = m.status();
      const sn = typeof m.snapshot === 'function' ? m.snapshot() : {};
      return {
        enabled: st.state !== 'disabled',
        state: this.signingHalted() ? 'down' : st.state,
        state_reason: this.signingHalted() ? 'signing' : st.reason ?? null,
        kill_switch: this.killSwitchState(),
        mids_ms: sn.mids_ms ?? null,
        ctx_ms: sn.ctx_ms ?? null,
        coins: m.listing().map((c) => ({
          coin: c.coin, index: c.index, sz_decimals: c.sz_decimals, max_leverage: c.max_leverage, delisted: c.delisted,
          only_isolated: c.only_isolated, mid: c.mid, mid_ms: c.mid_ms, mark_px: c.mark_px, funding_1h: c.funding_1h,
          tradeable: c.tradeable,
        })),
      };
    }
    const coins = [];
    for (const c of this.engine.market?.coins ?? []) {
      const coin = c.coin ?? c;
      const info = (() => {
        try {
          return m?.coinInfo?.(coin) ?? null;
        } catch {
          return null;
        }
      })();
      const q = m?.quote?.(coin) ?? null;
      const ctx = m?.ctx?.(coin) ?? null;
      coins.push({
        coin,
        index: info ? (info.index ?? null) : null,
        sz_decimals: info?.sz_decimals ?? null,
        max_leverage: info?.max_leverage ?? null,
        delisted: Boolean(info?.delisted),
        only_isolated: Boolean(info?.only_isolated),
        mid: q?.px ?? null,
        mid_ms: q?.ms ?? null,
        mark_px: ctx?.mark_px ?? null,
        funding_1h: ctx?.funding_1h ?? null,
        tradeable: Boolean(info && !info.delisted),
      });
    }
    const state = this.signing.halted ? 'down' : m?.state?.() ?? 'live';
    return {
      enabled: true, state, state_reason: this.signing.halted ? 'signing' : null, kill_switch: this.killSwitchState(),
      mids_ms: m?.midsMs ?? null, ctx_ms: m?.ctxMs ?? null, coins,
    };
  }

  /** testnet_status (cache only). */
  testnetStatus(uid) {
    const g = this.get(uid);
    const venue = this.venueOf(uid);
    if (!venue) {
      return { link: this.credentials?.link(uid) ?? null, state: 'disabled', account: null, positions: [], requests: null,
        expiry: { valid_until_ms: null, warn: null }, caps: g.caps().testnet };
    }
    return venue.status();
  }

  /** testnet_quote (cache only; §8.3). */
  testnetQuote(uid, { bean, capital_usd } = {}) {
    this.#requireTestnet();
    const g = this.get(uid);
    const beanId = typeof bean === 'string' && bean.trim() !== '' ? Number(bean) : bean;
    if (!Number.isInteger(beanId) || beanId < 0) throw new ApiError(400, 'bean must be a non-negative integer', 'bad_request');
    const capital = Number(capital_usd);
    if (!Number.isFinite(capital) || capital <= 0) throw new ApiError(400, 'capital_usd must be a positive number', 'bad_request');
    const row = this.engine.population?.row(beanId) ?? null;
    if (!row) throw new ApiError(404, `unknown bean ${beanId}`, 'not_found');
    return this.venueOf(uid).quoteFor({ row, capital, garden: g });
  }

  /**
   * Parse a pasted agent key (§6.7 step 1, no network): a seed phrase → 422 seed_phrase (nothing logged); 64 hex with a
   * scalar in [1, n−1] (own BigInt check, before any library) → bytes; otherwise 400 bad_key_format.
   */
  #parseAgentKey(text) {
    const parse = this.hl.verify?.parseAgentKey ?? this.lib.verify?.parseAgentKey;
    if (typeof parse === 'function') {
      const r = parse(text);
      if (r?.ok && r.bytes instanceof Uint8Array) return r.bytes;
      if (r?.code === 'seed_phrase') {
        throw new ApiError(422, 'that looks like a seed phrase — never paste it anywhere; paste a testnet API-wallet private key', 'seed_phrase');
      }
      throw new ApiError(400, 'the API-wallet key must be 64 hex characters', 'bad_key_format');
    }
    const t = typeof text === 'string' ? text.trim() : '';
    if (t.split(/[^A-Za-z]+/).filter((w) => /^[A-Za-z]{2,}$/.test(w)).length >= 12) {
      throw new ApiError(422, 'that looks like a seed phrase — never paste it anywhere; paste a testnet API-wallet private key', 'seed_phrase');
    }
    const m = /^(0x)?([0-9a-fA-F]{64})$/.exec(t);
    if (!m) throw new ApiError(400, 'the API-wallet key must be 64 hex characters', 'bad_key_format');
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(m[2].slice(i * 2, i * 2 + 2), 16);
    const valid = this.lib.signing?.isValidScalar ? this.lib.signing.isValidScalar(bytes) : true;
    if (!valid) {
      bytes.fill(0);
      throw new ApiError(400, 'the API-wallet key must be 64 hex characters', 'bad_key_format');
    }
    return bytes;
  }

  #normAddr(text) {
    try {
      if (this.lib.addr?.normAddr) return this.lib.addr.normAddr(text);
    } catch {
      throw new ApiError(400, 'account_address must be 0x followed by 40 hex characters', 'bad_address');
    }
    const t = typeof text === 'string' ? text.trim() : '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw new ApiError(400, 'account_address must be 0x followed by 40 hex characters', 'bad_address');
    return t.toLowerCase();
  }

  /** Map a verifyAgent() failure to the §8.3 ApiError. */
  #verifyError(v) {
    const status = Number.isInteger(v.status) ? v.status : { bad_address: 400, bad_key_format: 400, mainnet_check_unavailable: 503, testnet_down: 503,
      testnet_disabled: 503, busy: 503, agent_in_use: 409, account_in_use: 409, already_connected: 409 }[v.code] ?? 422;
    // The same additive fields as WP4's verifyRefusal (sub_reason, vars, valid_until_ms, account_value; faucet link).
    const extra = {};
    if (v.sub_reason) extra.sub_reason = v.sub_reason;
    if (v.vars && typeof v.vars === 'object') Object.assign(extra, v.vars);
    if (v.valid_until_ms != null) extra.valid_until_ms = v.valid_until_ms;
    if (v.account_value != null) extra.account_value = v.account_value;
    if (v.code === 'no_testnet_funds') extra.faucet = FAUCET_URL;
    const err = new ApiError(status, v.message ?? `testnet API wallet refused (${v.code})`, v.code, Object.keys(extra).length ? extra : null);
    // Whether the refusal counts against the 5-per-hour connect limit (§4.5, §6.7 step 1): WP2 says so per code.
    if (typeof v.counts === 'boolean') err.counts = v.counts;
    return err;
  }

  /**
   * WP2 verifyAgent (§6.7 steps 2–7). At connect it gets the pasted key bytes; at testnet_verify it gets the stored
   * agent address (proven decryptable through withSigner) and no key bytes — no second decrypt path exists (§5.1).
   */
  async #runVerify(accountAddress, keyBytes, agentAddress = null) {
    const verifyAgent = this.lib.verify?.verifyAgent ?? this.hl.verify?.verifyAgent;
    if (typeof verifyAgent !== 'function') throw new ApiError(503, 'testnet verification is not available', 'testnet_disabled');
    const args = { accountAddress };
    if (!this.hl.verify?.verifyAgent) Object.assign(args, { info: this.hl.info, mainnetInfo: this.mainnetInfo, now: this.now });
    if (keyBytes) args.agentKeyBytes = keyBytes;
    if (agentAddress) args.agentAddress = agentAddress;
    return verifyAgent.call(this.hl.verify ?? null, args);
  }

  /**
   * testnet_connect (§6.7, §8.3): verify (testnet role, fail-closed mainnet guard, expiry, abstraction, balances), seal
   * and store. On the same account this is Replace API wallet (runs on the player's lane after in-flight jobs; bots
   * kept). A take-over of an abandoned account closes the other garden's testnet bots in its books (account_moved).
   */
  async testnetConnect(uid, { account_address, agent_key } = {}) {
    this.#requireTestnet();
    const accountAddress = this.#normAddr(account_address);
    const keyBytes = this.#parseAgentKey(agent_key);
    try {
      return await this.testnetConnectBytes(uid, { accountAddress, agentKeyBytes: keyBytes });
    } finally {
      keyBytes.fill(0);
    }
  }

  /** testnet_connect with an already parsed key (`agentKeyBytes` stays the caller's: it zeroes it). */
  async testnetConnectBytes(uid, { accountAddress: rawAddress, agentKeyBytes }) {
    this.#requireTestnet();
    this.get(uid);
    const accountAddress = this.#normAddr(rawAddress);
    const keyBytes = agentKeyBytes;
    const v = await this.#runVerify(accountAddress, keyBytes);
    if (!v?.ok) {
      if (v?.code === 'mainnet_key') this.audit({ user_id: uid, actor: 'user', action: 'mainnet_key_detected', ok: false, detail: { reason: v.sub_reason ?? null } });
      throw this.#verifyError(v ?? { code: 'testnet_error' });
    }
    const store = () => this.credentials.store({
      uid, accountAddress, agentAddress: v.agent_address, agentName: v.agent_name ?? null,
      validUntilMs: v.valid_until_ms ?? null, abstraction: v.abstraction ?? null, valueAtConnect: v.account_value ?? null,
      keyBytes, mainnetCheckedMs: v.mainnet_checked_ms ?? this.now(),
    });
    const venue = this.venueOf(uid);
    const existing = this.credentials.link(uid);
    const replacing = existing && (existing.status === 'verified' || existing.status === 'pending')
      && existing.account_address === accountAddress;
    const res = replacing && venue ? await venue.runExclusive(store) : store();
    for (const other of res.takeOver ?? []) this.accountMoved(other);
    this.audit({ user_id: uid, actor: 'user', action: res.replaced ? 'testnet_agent_replaced' : 'testnet_connected', ok: true });
    this.journal.emit('credential_status', { status: 'verified', reason: res.replaced ? 'replaced' : null }, { uid });
    venue?.refresh();
    venue?.resumeIntents(); // flatten intents kept while no credential could sign (a reconnect re-issues them)
    this.flush();
    return {
      testnet: res.link,
      replaced: res.replaced,
      account: {
        account_value: v.account_value ?? null, account_value_est: v.account_value_est ?? v.abstraction === 'unifiedAccount',
        withdrawable: v.withdrawable ?? v.free ?? null, as_of_ms: v.verified_ms ?? this.now(),
      },
      warnings: Array.isArray(v.warnings) ? v.warnings : [],
    };
  }

  /**
   * testnet_verify: re-check the stored credential (steps 3–7 incl. the mainnet guard) using the stored key through
   * withSigner's decrypt path. A mainnet hit flattens and wipes (as the periodic re-check).
   */
  async testnetVerify(uid) {
    this.#requireTestnet();
    this.get(uid);
    const link = this.credentials?.link(uid);
    if (!link) throw new ApiError(409, 'connect a Hyperliquid testnet API wallet first', 'not_connected');
    let v;
    try {
      v = await this.credentials.verifyStored(uid, (bytes) => this.#runVerify(link.account_address, bytes));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(409, 'your testnet API wallet is no longer valid — reconnect it', 'credential_revoked');
    }
    this.audit({ user_id: uid, actor: 'user', action: 'testnet_verify', ok: Boolean(v?.ok), detail: { code: v?.code ?? null } });
    if (!v?.ok) {
      if (v?.code === 'mainnet_key') {
        await this.#mainnetHit(uid, String(v.sub_reason ?? 'mainnet_user').replace(/^mainnet_/, ''));
      } else if (['not_agent', 'agent_mismatch', 'agent_expired', 'master_key'].includes(v?.code)) {
        this.venueOf(uid)?.markRevoked(v.code);
      }
      throw this.#verifyError(v ?? { code: 'testnet_error' });
    }
    this.credentials.markVerified(uid, {
      validUntilMs: v.valid_until_ms ?? null, agentName: v.agent_name ?? null, abstraction: v.abstraction ?? null,
      mainnetCheckedMs: this.now(),
    });
    this.venueOf(uid)?.refresh();
    this.venueOf(uid)?.resumeIntents();
    return {
      testnet: this.credentials.link(uid),
      replaced: false,
      account: {
        account_value: v.account_value ?? null, account_value_est: v.abstraction === 'unifiedAccount',
        withdrawable: v.withdrawable ?? null, as_of_ms: this.now(),
      },
      warnings: Array.isArray(v.warnings) ? v.warnings : [],
    };
  }

  /**
   * testnet_disconnect (§8.3): 409 has_open_testnet_bots unless close_bots; with close_bots the bots flatten first
   * (≤ 15 s) and a failure answers 409 testnet_positions_open unless force. Then the key is wiped (+ WAL checkpoint).
   */
  async testnetDisconnect(uid, { close_bots = false, force = false, actor = 'user', reason = null } = {}) {
    const g = this.get(uid, { touch: actor === 'user' });
    const open = g.botList.filter((b) => b.state !== 'closed' && venueOf(b) === 'testnet');
    let left = [];
    if (open.length) {
      if (close_bots !== true) {
        throw new ApiError(409, 'close your testnet bots first (or disconnect with close_bots)', 'has_open_testnet_bots',
          { bots: open.map((b) => b.id) });
      }
      left = this.venueOf(uid) ? await this.#flattenAll(uid, DELETE_FLATTEN_MS) : [];
      if (left.length && force !== true) {
        throw new ApiError(409, 'testnet positions are still open — close them, or disconnect anyway', 'testnet_positions_open', { positions: left });
      }
      for (const bot of g.botList) if (bot.state !== 'closed' && venueOf(bot) === 'testnet') g.closeInBooks(bot.id, null);
    }
    const closed = open.map((b) => b.id);
    this.credentials?.wipe(uid);
    this.journal.emit('credential_status', { status: 'revoked', reason: reason ?? 'disconnected' }, { uid });
    this.audit({ user_id: uid, actor, action: 'testnet_disconnected', ok: true, detail: { count: closed.length, reason: reason ?? 'disconnected' } });
    this.flush();
    return { disconnected: true, closed, left_open: left };
  }
}

/**
 * core/data.js — polling + SSE + commands → store / bus (GAME-DESIGN §1.5, §6.12, §9.6; PLATFORM §9.5).
 *
 *   const data = startData({ store, bus, api });     // api = the brood-api.js module (injected for tests)
 *   data.tend()             bots + live_status (every 20 s; debounced 700 ms after tick/live events, 150 ms after bot_*)
 *   data.refreshMarket()    market (every 60 s real / 30 s sim; 10 s with ?nostream=1, which also derives marks)
 *   data.refreshStatus()    health + status (every 30 s and on feed_status) → feed, clock skew
 *   data.restock()          the seed shelf (beans + equity_curves) with store.shelf.filters
 *   data.setFilters(patch)  change shelf filters and restock
 *   data.loadDetail(botId)  bot_detail → store.detail[botId] (inspector; refreshed on that bot's fills)
 *   data.events(limit)      events?limit=… rows (diary backfill; server-scoped to this player in accounts mode)
 *   data.command(op, params, { target|slot }) → Promise<body>   emits cmd:pending / cmd:done, never throws
 *   data.stop()
 *
 * Accounts mode (PLATFORM §9.1, §9.5) — learned from api.getMode() at boot:
 *   store.mode     {auth, testnet: {enabled}, public_origin, command_policy}   (null until the server answered)
 *   store.user     the signed-in User, or null (a spectator; none mode keeps null: the implicit local player)
 *   store.me       the last `me` payload ({session, signup, testnet link})
 *   store.testnet  {market: testnet_market, status: testnet_status, marketMs, statusMs}
 *   store.venues   live_status.venues {paper, testnet}
 *   store.season   {season, season_started_ms, reset_after_ms}
 *   data.signedIn(user) / data.signedOut({reason}) / data.restream() / data.refreshTestnet() / data.refreshMe()
 *   Spectators never call a user query (QA-13): tend() leaves the plots empty. `auth:required` (brood-api, on a 401)
 *   and a `session_ended` frame that `me` confirms clear the player (bots, live, detail, diary, own-echo map, venues,
 *   season, slots); a frame whose player is still signed in (a password change: a fresh cookie) only reopens the stream.
 *   `resync` runs a full refresh; `server_restart` is announced (`data:server_restart`) and the stream reconnects.
 *   Slots persist per player: localStorage["bean.game.slots.v1:<uid>"] (none mode keeps the plain key).
 *
 * Truth (Juice Contract J1/J3): the store only ever receives the server's numbers. Commands never change the
 * store optimistically: outcomes arrive with the HTTP answer or the SSE echo, and a refresh follows.
 *
 * Normalised bus events (`game:event`, payload `{ type, ms, kind, raw, slot?, bot?, coin?, own?, … }`):
 *   fill · created · paused · resumed · closed · halted · error · orderSkipped · tick · busted · feed · gap ·
 *   warmup · daemon — plus gust (from consecutive mids) and weather (from the market mean change_24h).
 *   Accounts mode adds: sync · fillConfirmed · testnetAccount · credential · killSwitch · testnetFeed · rearmed ·
 *   seasonReset · passwordReset · sessionEnded · resync · serverRestart; bot events carry `venue` (+ note_code …).
 *   `own: true` marks the SSE echo of this page's own command (the diary writes one line, not two).
 *   `ms` is the client receive time; `quiet: true` ticks are the fast-forward burst of a time-lapse;
 *   `burn: true` closes/fills belong to a live_halted that follows (the burn sequence resolves them).
 * Also: `data:marks` (a mids pulse landed; `.testnet` = the testnet mids part), `cmd:pending {op,key,slot,bot,bean,venue}`,
 *   `cmd:done {…, ok, body}`, `data:resync`, `data:server_restart`, `data:player {user}` (the player changed).
 *
 * Slots: open bots keep their plot across reloads; the plant dialog's slot wins via `wanted` (bean → slot) until the
 * new bot exists.
 *
 * Pure helpers (exported, tested): coinsMap, marksFromMids, marksFromMarket, skewOf, pushHistory,
 * normalizeEvent, createOwn, loadSlots/saveSlots, slotsKeyFor, seasonOfLive. No DOM, no three; browser globals only
 * when called.
 */

import { shelfQuery, weatherOf, windOf } from '../../model.js';
import { assignSlots, slotCountOf, feedOf, firstFreeSlot } from './view.js';
import { gust as gustOf, barGust, RULES } from './rules.js';

export const CADENCE = Object.freeze({
  tendMs: 20_000,
  tendDebounceMs: 700,
  tendBotMs: 150,
  marketRealMs: 60_000,
  marketSimMs: 30_000,
  nostreamMarksMs: 10_000,
  statusMs: 30_000,
  restockMs: 800,
  beansMs: 60_000, // planted bean rows (archetype, strategy, side) refresh
  streamRetryMs: 15_000,
  backoffMs: Object.freeze([2_000, 4_000, 8_000, 20_000]),
  ownEchoMs: 15_000,
  holdMs: 150, // closing fills / closes wait this long for a live_halted that would absorb them
  historyMax: 120, // price history ring per coin (≈ 10 min of 5 s mids)
  liqFillMs: 5_000,
  testnetMarketMs: 60_000, // testnet_market refresh (PLATFORM §9.5)
  restreamDedupeMs: 500, // a second restart this soon (signedIn + api.restream) reuses the new stream
  // a `session_ended` frame is confirmed with `me` this long after any session-changing command settled, so a
  // Set-Cookie still on its way (password change, a sign-in in another tab) has landed before we ask
  sessionSettleMs: 600,
});

export const SLOTS_KEY = 'bean.game.slots.v1';

/** Slot-layout storage key: one per player in accounts mode (PLATFORM §9.5), the plain key otherwise. */
export const slotsKeyFor = (uid) => (uid === null || uid === undefined ? SLOTS_KEY : `${SLOTS_KEY}:${uid}`);

const num = (x) => (x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
const obj = (x) => (x && typeof x === 'object' ? x : null);

// ------------------------------------------------------------------ pure helpers

/** market.coins[] → { [coin]: CoinRow } */
export function coinsMap(rows) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) if (r && typeof r.coin === 'string') out[r.coin] = r;
  return out;
}

/**
 * A `mids` pulse → store.marks (§9.6 shape + `bar`). Non-finite prices are dropped, never invented.
 * Accounts mode: `testnet` (the testnet mids part, PLATFORM §7.5) and `testnet_account` (the player's own).
 */
export function marksFromMids(rec, receivedMs) {
  const px = {};
  for (const [coin, v] of Object.entries(rec?.px || {})) {
    const n = num(v);
    if (n !== null && n > 0) px[coin] = n;
  }
  return {
    t: num(rec?.t) ?? receivedMs,
    receivedMs,
    source: rec?.source ?? null,
    prices: rec?.prices ?? null,
    px,
    stale: Array.isArray(rec?.stale) ? rec.stale.filter((c) => typeof c === 'string') : [],
    bots: rec?.bots && typeof rec.bots === 'object' ? rec.bots : {},
    account: rec?.account && typeof rec.account === 'object' ? rec.account : {},
    bar: rec?.bar && typeof rec.bar === 'object' ? rec.bar : null,
    testnet: obj(rec?.testnet),
    testnet_account: obj(rec?.testnet_account),
  };
}

/**
 * ?nostream=1 (or a backend without `mids`): prices only, from the market payload. No per-bot numbers, so
 * plot views fall back to the ≈ estimate path (shown with "≈").
 */
export function marksFromMarket(coins, receivedMs, { t = null, prices = null } = {}) {
  const px = {};
  let newest = 0;
  for (const [coin, c] of Object.entries(coins || {})) {
    const p = num(c?.px) ?? num(c?.mid);
    if (p !== null && p > 0) px[coin] = p;
    newest = Math.max(newest, num(c?.px_ms) ?? 0);
  }
  const stale = Object.values(coins || {}).filter((c) => c?.stale).map((c) => c.coin);
  return { t: t ?? (newest || receivedMs), receivedMs, source: 'market', prices, px, stale, bots: {}, account: {}, bar: null };
}

/** Server − client clock offset, using the request midpoint (half the round trip is the best guess). */
export function skewOf(serverMs, sentMs, receivedMs) {
  const s = num(serverMs);
  if (s === null) return null;
  const mid = (Number(sentMs) + Number(receivedMs)) / 2;
  return Math.round(s - mid);
}

/** Append [t, px] per coin to a ring of `max`; only changed coins get new arrays (cheap selectors). */
export function pushHistory(history, px, t, max = CADENCE.historyMax) {
  const out = { ...(history || {}) };
  for (const [coin, p] of Object.entries(px || {})) {
    const n = num(p);
    if (n === null) continue;
    const ring = out[coin] || [];
    const last = ring[ring.length - 1];
    if (last && last[0] >= t) continue; // same pulse twice
    const next = ring.length >= max ? ring.slice(ring.length - max + 1) : ring.slice();
    next.push([t, n]);
    out[coin] = next;
  }
  return out;
}

/** Remembers which events are the echo of this page's own commands (15 s window). */
export function createOwn(now = () => Date.now(), ttl = CADENCE.ownEchoMs) {
  const m = new Map();
  const prune = () => {
    const t = now();
    for (const [k, at] of m) if (t - at >= ttl) m.delete(k);
  };
  return {
    mark(kind, key) {
      prune();
      m.set(`${kind}:${key}`, now());
    },
    unmark(kind, key) {
      m.delete(`${kind}:${key}`);
    },
    /** True (once) when `kind:key` was marked within the window. */
    take(kind, key) {
      const k = `${kind}:${key}`;
      const at = m.get(k);
      if (at === undefined) return false;
      m.delete(k);
      return now() - at < ttl;
    },
    /** True while marked, without consuming (bursts like a time-lapse's many ticks). */
    has(kind, key) {
      const at = m.get(`${kind}:${key}`);
      return at !== undefined && now() - at < ttl;
    },
    /** Forget everything (the player changed: the next player's echoes are not ours). */
    clear() {
      m.clear();
    },
  };
}

/** live_status → store.season ({season, season_started_ms, reset_after_ms}) or null (none mode). */
export function seasonOfLive(live) {
  const season = num(live?.season);
  if (season === null) return null;
  return { season, season_started_ms: num(live?.season_started_ms), reset_after_ms: num(live?.reset_after_ms) };
}

/** sz_decimals of `coin` in a coin listing (store.market.coins map, or the meta.coins array); null if unknown. */
function szDecimalsIn(coins, coin) {
  if (!coins || !coin) return null;
  const row = Array.isArray(coins) ? coins.find((c) => c && c.coin === coin) : coins[coin];
  return num(row?.sz_decimals);
}

/** Venue fields a bot record may carry (accounts mode, PLATFORM §8.7): copied onto the game event when present. */
function venueFields(rec) {
  const out = {};
  if (rec.venue === 'testnet' || rec.venue === 'paper') out.venue = rec.venue;
  for (const k of ['provisional', 'oid', 'note_code', 'note_vars', 'code', 'vars', 'funding', 'confirmed', 'cloid']) {
    if (rec[k] !== undefined) out[k] = rec[k];
  }
  return out;
}

/**
 * SSE record → normalised game event (or null for kinds with nothing to show).
 * ctx = { slots: {map, wanted, count}, bots: BotRow[], shelf: BeanRow[], receivedMs, isOwn(kind, key) }
 */
export function normalizeEvent(kind, rec, ctx = {}) {
  if (!rec || typeof rec !== 'object') return null;
  const ms = ctx.receivedMs ?? Date.now();
  const map = ctx.slots?.map || {};
  const bots = Array.isArray(ctx.bots) ? ctx.bots : [];
  const botRow = (id) => bots.find((b) => b && b.id === id) || null;
  const slotOf = (id) => (Number.isInteger(map[id]) ? map[id] : null);
  const isOwn = typeof ctx.isOwn === 'function' ? ctx.isOwn : () => false;
  const bot = rec.bot ?? null;
  const coin = rec.coin ?? botRow(bot)?.coin ?? null;
  // rec_t: the journal's server wall time of the record (replay detection in sim, where time_ms is market
  // time); replay: the server made it while catching up missed minutes (applied, never animated)
  const base = { ms, kind, raw: rec, rec_t: num(rec.t), replay: rec.replay === true };

  switch (kind) {
    case 'bot_fill':
      return {
        ...base, type: 'fill', bot, slot: slotOf(bot), coin, dir: rec.dir ?? null, sz: num(rec.sz), px: num(rec.px), fee: num(rec.fee),
        closed_pnl: num(rec.closed_pnl), time_ms: num(rec.time_ms), tick: num(rec.tick), liquidation: !!rec.liquidation,
        // size decimals from the coin listing: a new bot's opening fill arrives before its BotRow/PlotView exist
        sz_decimals: num(botRow(bot)?.sz_decimals) ?? szDecimalsIn(ctx.coins, coin),
        ...venueFields(rec),
      };
    case 'bot_created': {
      const bean = num(rec.bean);
      const wanted = ctx.slots?.wanted || {};
      const slot = slotOf(bot) ?? (Number.isInteger(wanted[bean]) ? wanted[bean] : firstFreeSlot(map, ctx.slots?.count ?? 10, wanted));
      return { ...base, type: 'created', bot, bean, coin, slot, capital_usd: num(rec.capital_usd), leverage: num(rec.leverage), own: isOwn('bot_created', `bean:${bean}`), ...venueFields(rec) };
    }
    case 'bot_order':
      if (rec.status !== 'skipped') return null;
      return { ...base, type: 'orderSkipped', bot, slot: slotOf(bot), coin, reason: rec.reason ?? null, sz: num(rec.sz), px: num(rec.px), ...venueFields(rec) };
    case 'bot_paused':
      return { ...base, type: 'paused', bot, slot: slotOf(bot), coin, reason: rec.reason ?? null, own: isOwn('bot_paused', bot), ...venueFields(rec) };
    case 'bot_resumed':
      return { ...base, type: 'resumed', bot, slot: slotOf(bot), coin, own: isOwn('bot_resumed', bot), ...venueFields(rec) };
    case 'bot_closed':
      return { ...base, type: 'closed', bot, slot: slotOf(bot), coin, realized_pnl: num(rec.realized_pnl), own: isOwn('bot_closed', bot), ...venueFields(rec) };
    case 'live_error':
      return { ...base, type: 'error', bot, slot: bot ? slotOf(bot) : null, coin, error: rec.error ?? null, ...venueFields(rec) };
    case 'live_halted': {
      const ids = Array.isArray(rec.closed) ? rec.closed : [];
      const closed = ids.map((id) => ({ bot: id, slot: slotOf(id), coin: botRow(id)?.coin ?? null, realized_pnl: null }));
      const out = { ...base, type: 'halted', closed, own: isOwn('live_halted', '*') };
      if (Array.isArray(rec.closing)) out.closing = rec.closing.map((id) => ({ bot: id, slot: slotOf(id), coin: botRow(id)?.coin ?? null }));
      return out;
    }
    case 'tick_completed':
      return {
        ...base, type: 'tick', tick: num(rec.tick), bar: num(rec.bar), time_ms: num(rec.time_ms), closed_ms: num(rec.closed_ms),
        next_tick_ms: num(rec.next_tick_ms), source: rec.source ?? null, quiet: !!ctx.timelapse,
      };
    case 'busted': {
      const bean = num(rec.bean);
      const planted = bots.find((b) => b && num(b.bean) === bean && b.state !== 'closed') || null;
      const onShelf = (Array.isArray(ctx.shelf) ? ctx.shelf : []).some((b) => num(b?.id) === bean);
      return { ...base, type: 'busted', bean, coin: rec.coin ?? null, archetype: rec.archetype ?? null, onShelf, planted: !!planted, bot: planted?.id ?? null, slot: planted ? slotOf(planted.id) : null };
    }
    case 'feed_status':
      return {
        ...base, type: 'feed', state: rec.state ?? null, prev: rec.prev ?? null, source: rec.source ?? null,
        stale_coins: Array.isArray(rec.stale_coins) ? rec.stale_coins : [], lag_bars: num(rec.lag_bars), error: rec.error ?? null, fallback: rec.fallback ?? null,
      };
    case 'feed_gap':
      return { ...base, type: 'gap', from_ms: num(rec.from_ms), to_ms: num(rec.to_ms), bars: num(rec.bars), mode: rec.mode ?? null, reason: rec.reason ?? null };
    case 'warmup_finished':
      return { ...base, type: 'warmup', bars: num(rec.bars), dur_ms: num(rec.ms) };
    case 'daemon_started':
      return { ...base, type: 'daemon', pid: rec.pid ?? null, version: rec.version ?? null };

    // ---- accounts mode (PLATFORM §8.7)
    case 'bot_sync':
      // drives the pending loop on a testnet plot until `state: 'done'` or a fill (J3)
      return {
        ...base, type: 'sync', bot, slot: slotOf(bot), coin, op: rec.op ?? null, state: rec.state ?? null, attempts: num(rec.attempts),
        code: rec.code ?? null, error: rec.error ?? null, fill_state: rec.fill_state ?? null, venue: 'testnet',
      };
    case 'bot_fill_confirmed':
      return {
        ...base, type: 'fillConfirmed', bot, slot: slotOf(bot), coin, oid: rec.oid ?? null, sz: num(rec.sz), px: num(rec.px), fee: num(rec.fee),
        closed_pnl: num(rec.closed_pnl), tids: Array.isArray(rec.tids) ? rec.tids : [], venue: 'testnet',
      };
    case 'testnet_account':
      return {
        ...base, type: 'testnetAccount', account_value: num(rec.account_value), account_value_est: rec.account_value_est === true,
        free: num(rec.free), total_margin_used: num(rec.total_margin_used), as_of_ms: num(rec.as_of_ms),
      };
    case 'credential_status':
      return { ...base, type: 'credential', status: rec.status ?? null, reason: rec.reason ?? null };
    case 'kill_switch':
      return { ...base, type: 'killSwitch', on: rec.on === true, reason: rec.reason ?? null, since_ms: num(rec.since_ms) };
    case 'testnet_feed':
      return { ...base, type: 'testnetFeed', state: rec.state ?? null, prev: rec.prev ?? null, reason: rec.reason ?? null, error: rec.error ?? null };
    case 'garden_rearmed':
      return { ...base, type: 'rearmed', own: isOwn('garden_rearmed', '*') };
    case 'garden_reset':
      return {
        ...base, type: 'seasonReset', season: num(rec.season), closed: Array.isArray(rec.closed) ? rec.closed : [],
        realized_pnl: num(rec.realized_pnl), own: isOwn('garden_reset', '*'),
      };
    case 'password_reset':
      return { ...base, type: 'passwordReset' };
    case 'session_ended':
      return { ...base, type: 'sessionEnded', reason: rec.reason ?? null };
    case 'resync':
      return { ...base, type: 'resync' };
    case 'server_restart':
      return { ...base, type: 'serverRestart' };
    default:
      return null;
  }
}

/** Persisted slot map: { map: {botId: slot}, wanted: {beanId: slot} } — tolerant of blocked/corrupt storage. */
export function loadSlots(storage, key = SLOTS_KEY) {
  try {
    const raw = storage?.getItem(key);
    const j = raw ? JSON.parse(raw) : null;
    const clean = (o, keyOk) => {
      const out = {};
      for (const [k, v] of Object.entries(o && typeof o === 'object' ? o : {})) if (keyOk(k) && Number.isInteger(v) && v >= 0 && v < 15) out[k] = v;
      return out;
    };
    return { map: clean(j?.map, (k) => !!k), wanted: clean(j?.wanted, (k) => /^\d+$/.test(k)) };
  } catch {
    return { map: {}, wanted: {} };
  }
}

export function saveSlots(storage, { map, wanted }, key = SLOTS_KEY) {
  try {
    storage?.setItem(key, JSON.stringify({ map: map || {}, wanted: wanted || {} }));
    return true;
  } catch {
    return false;
  }
}

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the data layer

export function startData({ store, bus, api, now = () => Date.now(), timers = globalThis, storage, search } = {}) {
  if (!store || !bus || !api) throw new TypeError('startData needs { store, bus, api }');
  const ls = storageOf(storage);
  const qs = search ?? globalThis.location?.search ?? '';
  const nostream = typeof api.streamDisabled === 'function' ? api.streamDisabled(qs) : new URLSearchParams(qs).get('nostream') === '1';
  const setT = (fn, ms) => timers.setTimeout(fn, ms);
  const clearT = (id) => timers.clearTimeout(id);
  const own = createOwn(now);
  const busy = {};
  const again = {};
  const timer = {};
  const due = {};
  const offs = [];
  let stopped = false;
  let es = null;
  let streamSeen = false;
  let lastRestartMs = -Infinity; // restream() dedupe: a second restart this soon reuses the new stream
  let serverLosses = 0; // lostSession() calls (the server ended the session), for confirmSessionEnded()
  let backoffIdx = 0;
  let seq = 0;
  let lastGustMs = -Infinity;
  let beansFetchedMs = 0;
  let beanIdsKey = '';
  let lastMidsMs = 0;
  let pxAtLastTick = null; // mids at the previous bar close (bar-return gusts)
  const lastLiqFill = {}; // bot → { usd, ms } (liquidation loss for the 'paused' event)
  const held = [];

  const S = () => store.get();
  const emit = (type, payload) => {
    try {
      bus.emit(type, payload);
    } catch (e) {
      globalThis.console?.error?.('bus emit failed', type, e);
    }
  };

  // ---------------------------------------------------------------- mode and player

  /** Does this API know about server modes? (an old / test api without getMode is a none-mode backend) */
  const modeAware = typeof api.getMode === 'function';
  const accounts = () => S().mode?.auth === 'accounts';
  const spectator = () => accounts() && !S().user;
  const testnetOn = () => accounts() && S().mode?.testnet?.enabled === true;
  /** Where the slot layout lives: per player in accounts mode, nowhere for a spectator (no bots). */
  const slotsKey = () => (accounts() ? (S().user ? slotsKeyFor(S().user.id) : null) : SLOTS_KEY);

  function persistSlots(slots) {
    const key = slotsKey();
    if (key) saveSlots(ls, slots, key);
  }

  /** Merge the saved layout of the current key into store.slots (in-memory entries win). */
  function restoreSlots() {
    const key = slotsKey();
    if (!key) return;
    const saved = loadSlots(ls, key);
    store.update('slots', (s) => ({ map: { ...saved.map, ...(s?.map || {}) }, wanted: { ...saved.wanted, ...(s?.wanted || {}) } }));
  }

  // none-mode pages (and test apis) restore the layout at once, as before; accounts mode waits for the player
  if (!modeAware) restoreSlots();

  /**
   * Clear everything that belongs to one player (PLATFORM §9.5): bots, live, detail, diary cache, own-echo map,
   * venues, season, testnet status, their marks and slots — so nothing leaks to the next player (QA-12).
   */
  function clearPlayer() {
    own.clear();
    for (const k of Object.keys(lastLiqFill)) delete lastLiqFill[k];
    for (const k of Object.keys(timer)) if (k.startsWith('detail:')) clearT(timer[k]);
    held.length = 0;
    clearT(timer.hold);
    timer.hold = null;
    store.set((s) => ({
      bots: [],
      live: null,
      detail: {},
      diary: [],
      venues: null,
      season: null,
      testnet: { ...(s.testnet || {}), status: null, statusMs: 0 },
      marks: s.marks ? { ...s.marks, bots: {}, account: {}, testnet_account: null } : s.marks,
      slots: { ...(s.slots || {}), map: {}, hidden: [], wanted: {} },
      ui: { ...(s.ui || {}), selectedSlot: null, focusSlot: null, pickBean: null, pending: {}, unread: 0 },
    }));
  }

  /** Switch the store to `user` (null = spectator). A different player first clears the previous one's state. */
  function setPlayer(user, me = undefined) {
    const prev = S().user;
    const next = user && typeof user === 'object' && user.id !== undefined ? user : null;
    const changed = (prev?.id ?? null) !== (next?.id ?? null);
    if (changed) clearPlayer();
    const patch = { user: next };
    if (me !== undefined) patch.me = me;
    else if (changed) patch.me = null;
    store.set(patch);
    if (changed) {
      restoreSlots();
      emit('data:player', { user: next });
    }
    return changed;
  }

  /** `me` → store.user / store.me (accounts mode). → true when it answered. */
  async function refreshMe() {
    if (!accounts()) return false;
    try {
      const me = await api.query('me');
      if (stopped) return false;
      setPlayer(me?.user ?? null, me ?? null);
      return true;
    } catch (e) {
      queryFailed(e, 'me');
      return false;
    }
  }

  let modePending = null;
  /**
   * Learn the server mode once (PLATFORM §9.1 boot steps 1–2). → true when the mode is known (always true for an
   * api without getMode: a none-mode backend). Accounts mode then asks `me` for the player.
   */
  function ensureMode() {
    if (!modeAware || S().mode) return Promise.resolve(true);
    modePending ??= (async () => {
      try {
        const mode = await api.getMode();
        if (stopped) return false;
        store.set({ mode: mode && typeof mode === 'object' ? mode : { auth: 'none', testnet: { enabled: false } } });
        if (accounts()) {
          await refreshMe();
          if (testnetOn()) refreshTestnetMarket();
        } else {
          restoreSlots();
        }
        return true;
      } catch (e) {
        queryFailed(e, 'index');
        return false;
      } finally {
        modePending = null;
      }
    })();
    return modePending;
  }

  /** A 401 auth_required / session_expired (brood-api), or the `session_ended` frame: the player is gone. */
  function lostSession(reason) {
    if (!accounts() || !S().user) return;
    serverLosses++;
    setPlayer(null, S().me ? { ...S().me, user: null, session: null, testnet: null } : null);
    scheduleRestock(200); // the shelf verdicts were this player's
    void reason;
  }

  /**
   * A `session_ended` frame ends the SESSION its stream was opened with — not necessarily this browser's sign-in:
   * a password change revokes every old session (this stream's too) and hands the caller a fresh cookie; a sign-in
   * in another tab replaces the cookie. So the frame is confirmed with `me` once any session-changing command has
   * settled (its Set-Cookie applied):
   *   - `me` answers the same player  → still signed in: keep everything, reopen the stream with the new cookie;
   *   - `me` answers another player   → that player's state and stream (a sign-in elsewhere in this browser);
   *   - `me` answers nobody (or fails) → the player is gone: clear them, and the `sessionEnded` game event goes out
   *     (the gate shows "your session ended", the diary writes its line).
   * A player who already left on their own (sign-out ran first) gets no event at all.
   */
  async function confirmSessionEnded(rec, ev) {
    if (!accounts()) return;
    const uid = S().user?.id ?? null;
    if (uid === null) return; // already a spectator: a sign-out of our own ran first
    const lossesBefore = serverLosses;
    /** The player changed while we waited: our own sign-out (no event), a sign-in elsewhere (no event), or a 401
     *  that already ended this very session (the event still goes out, for the diary and the gate). */
    const changedMeanwhile = () => {
      const now = S().user?.id ?? null;
      if (now === uid) return false;
      if (now === null && serverLosses !== lossesBefore) queueEvent(ev);
      return true;
    };
    try {
      await api.authSettled?.();
    } catch {
      /* an api without the hook */
    }
    await new Promise((resolve) => setT(resolve, CADENCE.sessionSettleMs));
    if (stopped || changedMeanwhile()) return;
    let me = null;
    try {
      me = await api.query('me');
    } catch {
      me = null; // fail closed: treat as ended
    }
    if (stopped || changedMeanwhile()) return;
    const next = me?.user && typeof me.user === 'object' && me.user.id !== undefined ? me.user : null;
    if (next && next.id === uid) {
      store.set({ me });
      restream();
      return;
    }
    if (next) {
      setPlayer(next, me);
      restream();
      scheduleTend(50);
      scheduleRestock(100);
      refreshTestnet();
      return;
    }
    lostSession(rec?.reason ?? 'session_ended');
    queueEvent(ev);
  }

  offs.push(bus.on?.('auth:required', (p) => lostSession(p?.code ?? 'auth_required')) ?? null);
  try {
    api.attachBus?.(bus);
  } catch {
    /* an api without a bus hook */
  }

  // ---------------------------------------------------------------- timers

  function arm(name, ms, fn) {
    clearT(timer[name]);
    due[name] = now() + ms;
    timer[name] = setT(() => {
      timer[name] = null;
      due[name] = null;
      if (!stopped) fn();
    }, ms);
  }

  /** Coalescing schedule: a sooner request pulls an armed timer forward; a later one rides along. */
  function soon(name, ms, fn) {
    const at = now() + ms;
    if (timer[name] && due[name] !== null && due[name] <= at) return;
    arm(name, ms, fn);
  }

  const scheduleTend = (ms = CADENCE.tendDebounceMs) => soon('tendSoon', ms, tend);
  const scheduleRestock = (ms = CADENCE.restockMs) => soon('restock', ms, restock);
  const scheduleStatus = (ms = 300) => soon('statusSoon', ms, refreshStatus);

  // ---------------------------------------------------------------- network state

  function setNet(patch) {
    store.update('net', patch);
  }

  function netOk() {
    const wasDown = S().net.ok === false;
    backoffIdx = 0;
    clearT(timer.retry);
    timer.retry = null;
    setNet({ ok: true, lastOkMs: now(), error: null, retryInMs: 0, retryAtMs: 0 });
    if (wasDown) {
      // back after an outage: refresh everything that may have moved
      refreshStatus();
      refreshMarket();
      scheduleRestock(200);
      if (S().net.stream !== 'live' && !nostream) startStream();
    }
  }

  /** A query failed. status 0 = unreachable → OFFLINE with backoff 2 → 4 → 8 → 20 s; HTTP errors keep `ok`. */
  function queryFailed(e, what) {
    const status = Number(e?.status);
    if (status === 0 || !Number.isFinite(status)) {
      const error = String(e?.message || e || 'unreachable');
      if (timer.retry) {
        setNet({ ok: false, error }); // one retry per outage step, however many queries failed
        return;
      }
      const wait = CADENCE.backoffMs[Math.min(backoffIdx, CADENCE.backoffMs.length - 1)];
      backoffIdx++;
      setNet({ ok: false, error, retryInMs: wait, retryAtMs: now() + wait });
      timer.retry = setT(() => {
        timer.retry = null;
        if (stopped) return;
        tend();
        refreshStatus();
      }, wait);
    } else {
      setNet({ error: `${what}: ${e?.message || e}` });
    }
  }

  // ---------------------------------------------------------------- tend: bots + live_status

  function applyBots(bots, live) {
    const st = S();
    const open = bots.filter((b) => b && b.state !== 'closed');
    const count = slotCountOf(live, open);
    const wanted = { ...(st.slots?.wanted || {}) };
    const { map, hidden } = assignSlots(open, st.slots?.map || {}, { slotCount: count, wanted });
    for (const b of open) if (num(b.bean) !== null && wanted[b.bean] !== undefined && map[b.id] !== undefined) delete wanted[b.bean];
    const patch = { bots, live, slots: { ...st.slots, map, count, hidden, wanted } };
    if (accounts()) {
      patch.venues = obj(live?.venues);
      patch.season = seasonOfLive(live);
    }
    store.set(patch);
    persistSlots({ map, wanted });
    refreshBeans(open);
  }

  async function tend() {
    if (stopped) return;
    if (busy.tend) {
      again.tend = true;
      return;
    }
    busy.tend = true;
    try {
      if (!(await ensureMode())) return;
      if (stopped) return;
      if (spectator()) {
        // QA-13: a spectator never calls a user query; the plots stay empty
        if (S().bots.length || S().live) applyBots([], null);
        return;
      }
      const uid = S().user?.id ?? null;
      const wantTn = testnetOn();
      const [b, live, tn] = await Promise.all([
        api.query('bots'),
        api.query('live_status'),
        wantTn ? api.query('testnet_status').catch(() => null) : null,
      ]);
      if (stopped || (S().user?.id ?? null) !== uid) return; // the player changed meanwhile: these rows are not theirs
      applyBots(Array.isArray(b?.rows) ? b.rows : [], live && typeof live === 'object' ? live : null);
      if (tn && typeof tn === 'object') store.update('testnet', { status: tn, statusMs: now() });
      netOk();
    } catch (e) {
      queryFailed(e, 'bots');
    } finally {
      busy.tend = false;
      if (!stopped) arm('tendPoll', CADENCE.tendMs, tend);
      if (again.tend && !stopped) {
        again.tend = false;
        scheduleTend(CADENCE.tendBotMs);
      }
    }
  }

  /** Planted beans (archetype, strategy, leverage, side) for the plots: on a new set of ids, else every 60 s. */
  async function refreshBeans(open) {
    const ids = [...new Set(open.map((b) => num(b.bean)).filter((x) => x !== null))].sort((a, b) => a - b);
    const key = ids.join(',');
    if (!ids.length) {
      beanIdsKey = '';
      return;
    }
    if (key === beanIdsKey && now() - beansFetchedMs < CADENCE.beansMs) return;
    if (busy.beans) return;
    busy.beans = true;
    beanIdsKey = key;
    beansFetchedMs = now();
    try {
      const res = await api.query('beans', { ids, limit: Math.max(ids.length, 1) });
      const beans = { ...S().beans };
      for (const r of Array.isArray(res?.rows) ? res.rows : []) if (r && num(r.id) !== null) beans[r.id] = r;
      store.set({ beans });
    } catch {
      beanIdsKey = ''; // try again on the next tend
    } finally {
      busy.beans = false;
    }
  }

  // ---------------------------------------------------------------- testnet (accounts mode, cache-only queries)

  async function refreshTestnetMarket() {
    if (stopped || !testnetOn() || busy.tnMarket) return;
    busy.tnMarket = true;
    try {
      const market = await api.query('testnet_market');
      if (!stopped && market && typeof market === 'object') store.update('testnet', { market, marketMs: now() });
    } catch (e) {
      queryFailed(e, 'testnet_market');
    } finally {
      busy.tnMarket = false;
      if (!stopped && testnetOn()) arm('testnetMarket', CADENCE.testnetMarketMs, refreshTestnetMarket);
    }
  }

  /** After a connect / verify / disconnect or a credential_status frame: the testnet slices and me.testnet. */
  async function refreshTestnet() {
    if (stopped || !accounts()) return;
    const jobs = [refreshTestnetMarket()];
    if (S().user) {
      jobs.push(refreshMe());
      if (testnetOn()) {
        jobs.push(api.query('testnet_status').then((status) => {
          if (!stopped && status && typeof status === 'object') store.update('testnet', { status, statusMs: now() });
        }, (e) => queryFailed(e, 'testnet_status')));
      }
    }
    await Promise.all(jobs);
  }

  // ---------------------------------------------------------------- status / health / meta

  async function refreshStatus() {
    if (stopped || busy.status) return;
    busy.status = true;
    try {
      const sent = now();
      const [health, status] = await Promise.all([api.query('health'), api.query('status')]);
      const recv = now();
      if (stopped) return;
      const skew = skewOf(health?.now_ms ?? status?.now_ms, sent, recv);
      const prev = S().feed;
      const feed = { ...prev, ...feedOf(status, health) };
      store.set((s) => ({ health, status, feed, net: { ...s.net, skewMs: skew ?? s.net.skewMs } }));
      // polling-only pages (or a missed SSE frame) still see feed transitions
      if (prev?.source && (prev.state !== feed.state || String(prev.staleCoins) !== String(feed.staleCoins))) {
        emitEvent({ ms: now(), kind: 'status', raw: null, type: 'feed', state: feed.state, prev: prev.state, source: feed.source, stale_coins: feed.staleCoins, polled: true });
      }
      netOk();
    } catch (e) {
      queryFailed(e, 'status');
    } finally {
      busy.status = false;
      if (!stopped) arm('status', CADENCE.statusMs, refreshStatus);
    }
  }

  async function loadMeta() {
    try {
      const meta = await api.query('meta');
      if (!stopped) store.set({ meta });
    } catch (e) {
      queryFailed(e, 'meta');
    }
  }

  // ---------------------------------------------------------------- market

  async function refreshMarket() {
    if (stopped || busy.market) return;
    busy.market = true;
    try {
      const m = await api.query('market');
      if (stopped) return;
      const t = now();
      const coins = coinsMap(m?.coins);
      const list = Object.values(coins);
      const weather = weatherOf(list);
      const wind = windOf(list);
      const prev = S().market;
      const patch = { market: { coins, weather, wind, fetchedMs: t, marketTimeMs: num(m?.market_time_ms) } };
      // no live marks (nostream, or a backend without `mids`): prices-only marks → ≈ estimates
      const noMids = nostream || t - lastMidsMs > 15_000;
      if (noMids) {
        const marks = marksFromMarket(coins, t, { prices: S().feed?.prices ?? null });
        patch.priceHistory = pushHistory(S().priceHistory, marks.px, marks.t);
        if (nostream) patch.marks = marks;
      }
      store.set(patch);
      if (patch.marks) emit('data:marks', patch.marks);
      if (prev?.weather && weather && prev.weather.key !== weather.key) {
        emitEvent({ ms: t, kind: 'market', raw: null, type: 'weather', key: weather.key, prev: prev.weather.key, mean: weather.mean });
      }
      netOk();
    } catch (e) {
      queryFailed(e, 'market');
    } finally {
      busy.market = false;
      if (!stopped) {
        const every = nostream ? CADENCE.nostreamMarksMs : S().feed?.prices === 'real' ? CADENCE.marketRealMs : CADENCE.marketSimMs;
        arm('market', every, refreshMarket);
      }
    }
  }

  // ---------------------------------------------------------------- shelf

  async function restock() {
    if (stopped) return;
    if (busy.restock) {
      again.restock = true;
      return;
    }
    busy.restock = true;
    const filters = S().shelf?.filters || {};
    store.update('shelf', { loading: true });
    try {
      const res = await api.query('beans', shelfQuery({ ...filters, halted: !!S().live?.halted }));
      const rows = Array.isArray(res?.rows) ? res.rows : [];
      let curves = {};
      if (rows.length) {
        try {
          const c = await api.query('equity_curves', { ids: rows.map((r) => r.id) });
          curves = c?.curves && typeof c.curves === 'object' ? c.curves : {};
        } catch {
          curves = S().shelf?.curves || {};
        }
      }
      if (!stopped) store.update('shelf', { rows, curves, loading: false, error: null, fetchedMs: now(), venue: res?.venue ?? null });
    } catch (e) {
      store.update('shelf', { loading: false, error: String(e?.message || e) });
      queryFailed(e, 'beans');
    } finally {
      busy.restock = false;
      if (again.restock && !stopped) {
        again.restock = false;
        scheduleRestock(200);
      }
    }
  }

  function setFilters(patch) {
    store.update('shelf', (s) => ({ filters: { ...(s?.filters || {}), ...(patch || {}) } }));
    return restock();
  }

  // ---------------------------------------------------------------- detail / events

  async function loadDetail(botId) {
    if (botId === null || botId === undefined) return null;
    if (spectator()) return null; // QA-13: no user query without a player
    try {
      const d = await api.query('bot_detail', { id: botId });
      if (stopped) return null;
      const entry = { bot: d?.bot ?? null, bean: d?.bean ?? null, fills: Array.isArray(d?.fills) ? d.fills : [], orders: Array.isArray(d?.orders) ? d.orders : [], fetchedMs: now() };
      store.set((s) => ({ detail: { ...s.detail, [botId]: entry } }));
      return entry;
    } catch (e) {
      queryFailed(e, 'bot_detail');
      return null;
    }
  }

  async function events(limit = 100) {
    try {
      const r = await api.query('events', { limit });
      return Array.isArray(r?.rows) ? r.rows : [];
    } catch (e) {
      queryFailed(e, 'events');
      return [];
    }
  }

  // ---------------------------------------------------------------- commands

  function markOwnFor(op, params, on = true) {
    const m = on ? own.mark : own.unmark;
    if (op === 'bot_create') m('bot_created', `bean:${params.bean}`);
    else if (op === 'bot_close') m('bot_closed', params.id);
    else if (op === 'bot_pause') m('bot_paused', params.id);
    else if (op === 'bot_resume') m('bot_resumed', params.id);
    else if (op === 'tick') m('tick_completed', '*');
    else if (op === 'garden_rearm') m('garden_rearmed', '*');
    else if (op === 'garden_reset') m('garden_reset', '*');
    else if (op === 'bots_halt') {
      m('live_halted', '*');
      for (const b of S().bots || []) if (b && b.state !== 'closed') m('bot_closed', b.id);
    }
  }

  function setWanted(bean, slot) {
    const st = S();
    const wanted = { ...(st.slots?.wanted || {}) };
    if (slot === null) delete wanted[bean];
    else wanted[bean] = slot;
    store.set({ slots: { ...st.slots, wanted } });
    persistSlots({ map: st.slots?.map, wanted });
  }

  const slotOfBot = (id) => {
    const s = S().slots?.map?.[id];
    return Number.isInteger(s) ? s : null;
  };

  /**
   * Send a command. opts.target / opts.slot = the plot it concerns (for the pending loop and the plant
   * slot). Resolves to the server body, or { error, status } — never throws.
   */
  async function command(op, params = {}, opts = {}) {
    const p = params || {};
    const slot = Number.isInteger(opts.slot) ? opts.slot : Number.isInteger(opts.target) ? opts.target : p.id !== undefined ? slotOfBot(p.id) : null;
    const key = `${op}:${p.id ?? p.bean ?? ''}:${++seq}`;
    const botVenue = p.id !== undefined ? (S().bots || []).find((b) => b && b.id === p.id)?.venue : undefined;
    const venue = p.venue === 'testnet' || botVenue === 'testnet' ? 'testnet' : op.startsWith('bot') ? 'paper' : null;
    const pend = { op, key, slot, bot: p.id ?? null, bean: num(p.bean), startedMs: now(), venue };
    store.update('ui', (ui) => ({ pending: { ...(ui?.pending || {}), [key]: pend } }));
    markOwnFor(op, p, true);
    if (op === 'bot_create' && slot !== null && pend.bean !== null) setWanted(pend.bean, slot);
    emit('cmd:pending', pend);

    let body;
    try {
      body = await api.command(op, p);
    } catch (e) {
      body = { error: String(e?.message || e), status: 0 };
    }
    const ok = !!body && typeof body === 'object' && typeof body.error !== 'string';
    if (ok && op === 'bot_create' && body.id !== undefined && slot !== null) {
      const st = S();
      // `wanted` (bean → slot) stays until tend() sees the new bot (applyBots clears it then): a tend that was
      // already in flight without the bot would otherwise drop this entry and lose the chosen plot
      const map = { ...(st.slots?.map || {}), [body.id]: slot };
      store.set({ slots: { ...st.slots, map } });
      persistSlots({ map, wanted: st.slots?.wanted });
    }
    if (!ok) {
      markOwnFor(op, p, false);
      if (op === 'bot_create' && pend.bean !== null) setWanted(pend.bean, null);
    }
    store.update('ui', (ui) => {
      const pending = { ...(ui?.pending || {}) };
      delete pending[key];
      return { pending };
    });
    emit('cmd:done', { ...pend, ok, body: body || {} });

    // without a live stream there is no echo: a burn must still resolve plot by plot
    if (ok && op === 'bots_halt' && S().net.stream !== 'live') {
      const ids = Array.isArray(body.closed) ? body.closed : [];
      emitEvent({ ...normalizeEvent('live_halted', { closed: ids }, ctxFor()), own: true, fromCommand: true });
    }
    if (!stopped) {
      scheduleTend(ok ? 100 : 400);
      if (ok && (op === 'bot_create' || op === 'bot_close' || op === 'bots_halt' || op === 'garden_reset' || op === 'garden_rearm')) scheduleRestock(600);
      if (ok && op === 'tick') {
        refreshMarket();
        scheduleStatus(100);
      }
      if (op.startsWith('testnet_')) refreshTestnet();
    }
    return body;
  }

  // ---------------------------------------------------------------- SSE

  function ctxFor() {
    const st = S();
    return {
      slots: st.slots,
      bots: st.bots,
      coins: st.market?.coins ?? st.meta?.coins ?? null,
      shelf: st.shelf?.rows,
      receivedMs: now(),
      isOwn: (k, key) => own.take(k, key),
      timelapse: Object.values(st.ui?.pending || {}).some((p) => p?.op === 'tick'),
    };
  }

  function emitEvent(ev) {
    if (ev) emit('game:event', ev);
  }

  function flushHeld() {
    clearT(timer.hold);
    timer.hold = null;
    const list = held.splice(0);
    for (const ev of list) emitEvent(ev);
  }

  /**
   * Closing fills and closes wait 150 ms: if a live_halted follows, they become part of the burn sequence
   * (`burn: true`; the halted event carries each bot's realized P&L). Later events queue behind held ones so
   * the order (and flip detection) is preserved.
   */
  function queueEvent(ev) {
    if (!ev) return;
    if (ev.type === 'halted') {
      const ids = new Set(ev.closed.map((c) => c.bot));
      for (const h of held) {
        if (!ids.has(h.bot)) continue;
        if (h.type === 'closed') {
          const c = ev.closed.find((x) => x.bot === h.bot);
          if (c) c.realized_pnl = h.realized_pnl;
          h.burn = true;
        } else if (h.type === 'fill') h.burn = true;
      }
      held.push(ev);
      flushHeld();
      return;
    }
    const holdable = ev.type === 'closed' || (ev.type === 'fill' && /^Close /.test(String(ev.dir || '')));
    if (held.length || holdable) {
      held.push(ev);
      if (!timer.hold) timer.hold = setT(flushHeld, CADENCE.holdMs);
      return;
    }
    emitEvent(ev);
  }

  /** Gust (§4.4): ≤ 1 per 20 s, from a real move — consecutive mids > 0.3% or a bar return > 1%. */
  function maybeGust(g, source) {
    const t = now();
    if (!g || t - lastGustMs < RULES.gustCooldownMs) return;
    lastGustMs = t;
    emitEvent({ ms: t, kind: source, raw: null, type: 'gust', coin: g.coin, pct: g.pct, source });
  }

  function onMids(rec) {
    const t = now();
    lastMidsMs = t;
    const marks = marksFromMids(rec, t);
    const st = S();
    const prevPx = st.marks?.px;
    const feed = { ...st.feed, midsMs: marks.t };
    if (num(marks.bar?.next_tick_ms) !== null) feed.nextTickMs = num(marks.bar.next_tick_ms);
    store.set({ marks, priceHistory: pushHistory(st.priceHistory, marks.px, marks.t), feed });
    emit('data:marks', marks);
    maybeGust(prevPx ? gustOf(prevPx, marks.px) : null, 'mids');
  }

  /** At each bar close: compare the live prices with the previous bar close's (the bar return). */
  function onBarClose() {
    const px = S().marks?.px;
    if (!px) return;
    if (pxAtLastTick) maybeGust(barGust(pxAtLastTick, px), 'bar');
    pxAtLastTick = { ...px };
  }

  /** `resync` (the stream's Last-Event-ID was too old): a full refresh (PLATFORM §9.5). */
  function fullRefresh() {
    scheduleTend(100);
    refreshMarket();
    scheduleStatus(100);
    scheduleRestock(200);
    if (accounts()) refreshTestnet();
    emit('data:resync', { ms: now() });
  }

  /** testnet_market patch from a global frame (kill switch, testnet feed state). */
  function patchTnMarket(patch) {
    store.update('testnet', (t) => (t?.market ? { market: { ...t.market, ...patch } } : {}));
  }

  function onEvent(kind, rec) {
    if (stopped || !rec || typeof rec !== 'object') return;
    if (kind === 'mids') return onMids(rec);
    const ev = normalizeEvent(kind, rec, ctxFor());

    switch (kind) {
      case 'tick_completed':
        if (!ev?.quiet) onBarClose();
        store.update('feed', (f) => ({
          nextTickMs: num(rec.next_tick_ms) ?? f?.nextTickMs ?? null,
          lastBarCloseMs: num(rec.closed_ms) ?? f?.lastBarCloseMs ?? null,
        }));
        scheduleTend(CADENCE.tendDebounceMs);
        break;
      case 'bot_fill':
        if (rec.liquidation) lastLiqFill[rec.bot] = { usd: (num(rec.closed_pnl) ?? 0) - (num(rec.fee) ?? 0), ms: now() };
        if (S().detail?.[rec.bot]) soon(`detail:${rec.bot}`, 400, () => loadDetail(rec.bot));
        scheduleTend(CADENCE.tendBotMs);
        break;
      case 'bot_created':
        // The echo can beat the HTTP answer: pin the new bot to its plot now, so its opening fill (which
        // arrives right behind it) already knows the slot and plays its splash + floater there.
        if (ev && rec.bot && Number.isInteger(ev.slot)) {
          const st = S();
          if (!Number.isInteger(st.slots?.map?.[rec.bot]) && !Object.values(st.slots?.map || {}).includes(ev.slot)) {
            // (`wanted` stays until tend() sees the bot, so a tend already in flight cannot lose the slot)
            const map = { ...(st.slots?.map || {}), [rec.bot]: ev.slot };
            store.set({ slots: { ...st.slots, map } });
            persistSlots({ map, wanted: st.slots?.wanted });
          }
        }
        scheduleTend(CADENCE.tendBotMs);
        scheduleRestock();
        break;
      case 'bot_closed':
        scheduleTend(CADENCE.tendBotMs);
        scheduleRestock();
        break;
      case 'bot_paused': {
        const lf = lastLiqFill[rec.bot];
        if (ev && rec.reason === 'liquidated' && lf && now() - lf.ms < CADENCE.liqFillMs) ev.usd = lf.usd;
        scheduleTend(CADENCE.tendBotMs);
        break;
      }
      case 'bot_resumed':
      case 'bot_sync':
        scheduleTend(CADENCE.tendBotMs);
        break;
      case 'bot_fill_confirmed':
        if (S().detail?.[rec.bot]) soon(`detail:${rec.bot}`, 400, () => loadDetail(rec.bot));
        scheduleTend(CADENCE.tendBotMs);
        break;
      case 'bot_order':
      case 'live_error':
        scheduleTend(CADENCE.tendDebounceMs);
        break;
      case 'live_halted':
        scheduleTend(CADENCE.tendBotMs);
        scheduleRestock();
        break;
      case 'busted':
        if (ev?.onShelf) scheduleRestock();
        if (ev?.planted) scheduleTend(CADENCE.tendBotMs);
        break;
      case 'feed_status':
        store.update('feed', (f) => ({
          state: ['live', 'delayed', 'down', 'sim'].includes(rec.state) ? rec.state : f?.state,
          staleCoins: Array.isArray(rec.stale_coins) ? rec.stale_coins : f?.staleCoins || [],
          fallback: rec.fallback !== undefined ? rec.fallback : f?.fallback ?? null,
          lagBars: num(rec.lag_bars) ?? f?.lagBars ?? 0,
        }));
        scheduleStatus(300);
        break;
      case 'feed_gap':
        scheduleTend(300);
        refreshMarket();
        break;
      case 'warmup_finished':
      case 'daemon_started':
        if (kind === 'daemon_started') loadMeta();
        scheduleTend(200);
        refreshMarket();
        scheduleStatus(200);
        scheduleRestock(400);
        break;

      // ---- accounts mode (PLATFORM §8.7)
      case 'testnet_account':
        store.set((s) => (s.venues?.testnet
          ? { venues: { ...s.venues, testnet: { ...s.venues.testnet, account_value: num(rec.account_value), account_value_est: rec.account_value_est === true, free: num(rec.free), total_margin_used: num(rec.total_margin_used), as_of_ms: num(rec.as_of_ms) } } }
          : {}));
        break;
      case 'credential_status':
        refreshTestnet();
        scheduleTend(CADENCE.tendBotMs);
        break;
      case 'kill_switch':
        patchTnMarket({ kill_switch: { on: rec.on === true, reason: rec.reason ?? null, since_ms: num(rec.since_ms) } });
        scheduleTend(300);
        break;
      case 'testnet_feed':
        patchTnMarket({ state: rec.state ?? null, state_reason: rec.reason ?? null });
        scheduleTend(300);
        break;
      case 'garden_rearmed':
      case 'garden_reset':
        scheduleTend(100);
        scheduleRestock(300);
        break;
      case 'session_ended':
        // confirmed with `me` first (a password change ends this stream but keeps the player signed in); the
        // game event goes out only when the player is really gone
        confirmSessionEnded(rec, ev);
        return;
      case 'resync':
        fullRefresh();
        break;
      case 'server_restart':
        emit('data:server_restart', { ms: now() }); // a toast; the EventSource reconnects with its back-off
        break;
      default:
        break;
    }
    queueEvent(ev);
  }

  function setStream(state) {
    if (S().net.stream !== state) setNet({ stream: state });
  }

  function startStream() {
    if (stopped) return;
    if (es) {
      try {
        es.close();
      } catch {
        /* closed */
      }
      es = null;
    }
    if (nostream || typeof api.stream !== 'function') {
      setStream('polling');
      return;
    }
    const kinds = [...(api.EVENT_KINDS || []), 'feed_status', 'feed_gap', 'mids'];
    const src = api.stream(onEvent, {
      kinds: [...new Set(kinds)],
      // brood-api restream() (after a sign-in / sign-out) comes back here, so there is only ever one stream
      restart: () => restream(),
      onOpen: (evt) => {
        if (evt?.target && es && evt.target !== es) return; // a stream we already replaced
        const wasLive = S().net.stream === 'live';
        setStream('live');
        if (streamSeen && !wasLive) {
          // reconnected: catch up on anything missed
          scheduleTend(100);
          refreshMarket();
          scheduleStatus(100);
        }
        streamSeen = true;
      },
      onError: (evt) => {
        if (!es || (evt?.target && evt.target !== es)) return;
        if (es.readyState === 2) {
          setStream('polling');
          try {
            es.close();
          } catch {
            /* closed */
          }
          es = null;
          arm('stream', CADENCE.streamRetryMs, startStream);
        } else setStream('reconnecting');
      },
    });
    es = src || null;
    if (!es) setStream('polling');
  }

  /**
   * Reopen the stream so the session cookie (or its absence) applies (PLATFORM §9.5). Two restarts in a row (our own
   * signedIn() and the UI's api.restream()) open one stream, not two.
   */
  function restream() {
    if (stopped) return null;
    if (es && es.readyState !== 2 && now() - lastRestartMs < CADENCE.restreamDedupeMs) return es;
    lastRestartMs = now();
    startStream();
    return es;
  }

  /** After auth_login / auth_signup / auth_reset: the new player's state, a fresh stream and a tend (PLATFORM §9.1). */
  function signedIn(user) {
    setPlayer(user);
    restream();
    scheduleTend(50);
    scheduleRestock(100);
    refreshTestnet();
  }

  /** After auth_logout / logout_all / delete: a spectator again, with a spectator stream. */
  function signedOut({ reason = null } = {}) {
    setPlayer(null, S().me ? { ...S().me, user: null, session: null, testnet: null } : null);
    restream();
    scheduleRestock(100);
    void reason;
  }

  // ---------------------------------------------------------------- boot

  loadMeta();
  refreshStatus();
  refreshMarket();
  restock();
  tend(); // learns the mode (and the player) first when the api knows modes
  ensureMode().then((known) => {
    if (!stopped && known) startStream();
  });

  return {
    tend,
    restock,
    setFilters,
    refreshMarket,
    refreshStatus,
    loadDetail,
    loadMeta,
    events,
    command,
    // accounts mode (PLATFORM §9.5)
    signedIn,
    signedOut,
    restream,
    refreshMe,
    refreshTestnet,
    ensureMode,
    /** Server-relative now (client clock + skew). */
    serverNow: () => now() + (S().net?.skewMs || 0),
    get streaming() {
      return S().net.stream === 'live';
    },
    stop() {
      stopped = true;
      for (const k of Object.keys(timer)) clearT(timer[k]);
      held.length = 0;
      for (const off of offs) if (typeof off === 'function') off();
      if (es) {
        try {
          es.close();
        } catch {
          /* closed */
        }
        es = null;
      }
    },
    /** For tests: deliver an SSE record as if it came from the stream. */
    _onEvent: onEvent,
  };
}

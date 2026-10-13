/**
 * core/store.js — the single state container of the 3D page (GAME-DESIGN §9.6).
 *
 *   const store = createStore(initialState());
 *   store.get()                                   current state (treat as read-only)
 *   store.set({ bots })                           shallow top-level merge, notifies selectors
 *   store.set((s) => ({ ui: { ...s.ui, x: 1 } }))  functional form
 *   store.update('ui', { selectedSlot: 3 })       merge into one nested object (convenience)
 *   const off = store.select((s) => s.ui.selectedSlot, (slot, prev) => …)   called on CHANGE only
 *   store.version                                 bumps on every set()
 *
 * Juice Contract J1: every number on screen comes from here, and the data layer only ever writes the
 * server's values into it. Nothing animates a value in the store.
 *
 * Pure module: no side effects at import.
 */

/** The frozen day-1 state shape (§9.6), plus the additive keys documented inline. */
export function initialState(overrides = {}) {
  return {
    boot: { phase: 'loading', error: null },
    net: { ok: true, lastOkMs: 0, error: null, stream: 'off', skewMs: 0, retryInMs: 0, retryAtMs: 0 /* additive */ },
    health: null,
    status: null,
    meta: null,
    feed: {
      source: null,
      prices: 'sim',
      state: 'sim',
      staleCoins: [],
      fallback: null,
      realAvailable: null,
      nextTickMs: null,
      lastBarCloseMs: null,
      lagBars: 0,
      tickMs: null,
      midsMs: null, // additive: server ms of the last allMids
    },
    live: null,
    bots: [],
    /** additive: planted beans by id (beans?ids=…), for archetype/strategy/bean leverage of each plot */
    beans: {},
    detail: {},
    market: { coins: {}, weather: null, wind: null, fetchedMs: 0 },
    marks: null,
    priceHistory: {},
    shelf: { rows: [], curves: {}, loading: false, error: null, filters: { sort: '-total_return', archetype: '', sproutingOnly: true } },
    slots: { map: {}, count: 10, hidden: [], wanted: {} },
    views: {},
    ui: {
      selectedSlot: null,
      focusSlot: null,
      pickBean: null,
      panel: null,
      dialog: null,
      pending: {},
      reduced: false, // additive: resolved reduced motion (setting or system)
      tier: null, // additive: current quality tier name
      unread: 0, // additive: unread diary warnings (mailbox flag)
    },
    diary: [],
    settings: null,
    // ---- accounts mode (PLATFORM §9.5, §12.2), filled by core/data.js; they stay null / empty in none mode ----
    /** GET /api/v1 → {auth: 'none'|'accounts', testnet: {enabled}, public_origin, command_policy}; null = not known yet */
    mode: null,
    /** the signed-in User {id, username, role, created_ms, lang}; null for a spectator (and in none mode) */
    user: null,
    /** the last `me` payload: {mode, user, session, signup, testnet: TestnetLink|null} */
    me: null,
    /** testnet_market (public) and testnet_status (the player's), both cache-only on the server */
    testnet: { market: null, status: null, marketMs: 0, statusMs: 0 },
    /** live_status.venues: {paper, testnet} ledgers */
    venues: null,
    /** the paper season: {season, season_started_ms, reset_after_ms} (live_status) */
    season: null,
    ...overrides,
  };
}

export function createStore(initial = initialState()) {
  let state = initial;
  let version = 0;
  /** @type {Set<{selector: Function, fn: Function, equals: Function, last: any}>} */
  const subs = new Set();
  let notifying = false;
  let again = false;

  function get() {
    return state;
  }

  function notify() {
    // Re-entrant set() calls (a subscriber writing to the store) are folded into one more pass, so every
    // subscriber always ends up seeing the final state, in subscription order.
    if (notifying) {
      again = true;
      return;
    }
    notifying = true;
    try {
      do {
        again = false;
        for (const sub of [...subs]) {
          if (!subs.has(sub)) continue;
          let next;
          try {
            next = sub.selector(state);
          } catch (e) {
            (globalThis.console?.error || (() => {}))('store selector failed', e);
            continue;
          }
          if (sub.equals(next, sub.last)) continue;
          const prev = sub.last;
          sub.last = next;
          try {
            sub.fn(next, prev);
          } catch (e) {
            (globalThis.console?.error || (() => {}))('store subscriber failed', e);
          }
        }
      } while (again);
    } finally {
      notifying = false;
    }
  }

  function set(patchOrFn) {
    const patch = typeof patchOrFn === 'function' ? patchOrFn(state) : patchOrFn;
    if (!patch || typeof patch !== 'object') return state;
    state = { ...state, ...patch };
    version++;
    notify();
    return state;
  }

  /** Merge `patch` into the nested object at top-level `key` (e.g. update('ui', {panel: 'diary'})). */
  function update(key, patch) {
    return set((s) => ({ [key]: { ...(s[key] || {}), ...(typeof patch === 'function' ? patch(s[key]) : patch) } }));
  }

  function select(selector, fn, equals = Object.is) {
    const sub = { selector, fn, equals, last: undefined };
    try {
      sub.last = selector(state);
    } catch {
      sub.last = undefined;
    }
    subs.add(sub);
    return () => subs.delete(sub);
  }

  return {
    get,
    set,
    update,
    select,
    get version() {
      return version;
    },
  };
}

/** Shallow equality for arrays / plain objects (handy as a select() `equals`). */
export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

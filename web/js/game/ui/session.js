/**
 * ui/session.js — the player session as the HUD sees it (PLATFORM §9.1, §9.5; WP5).
 *
 *   authCommand(ctx, op, params)     → body   auth_* / account_* / testnet_* commands: JSON body only, never logged
 *   signedIn(ctx, user, o)           after auth_login / auth_signup / auth_reset: per-player state reset,
 *                                     stream reopened, tend(), first-timer tour, the one-time reset notice
 *   signedOut(ctx, o)                after auth_logout / logout_all / delete / session_ended: clear the player,
 *                                     reopen the stream as a spectator, show the gate (with g.gate.ended if asked)
 *   ensureMode(ctx)                  boot fallback: when the data layer has not filled store.mode / store.user,
 *                                     ask GET /api/v1 and `me` once (WP4's core/data.js normally does this)
 *
 * Transport belongs to WP4 (brood-api.js + core/data.js). This module only CALLS it, defensively, through the
 * names frozen in PLATFORM §12.2 (`api.getMode`, `api.signup/login/logout/resetPassword`, `api.restream`) and the
 * data layer's optional hooks (`data.signedIn(user)`, `data.signedOut()`, `data.refreshTestnet()`); every call
 * has a fallback so the HUD works while the other packages land. Secrets (passwords, codes, keys) are passed
 * straight to the request body and never stored, logged or put in a URL.
 *
 * No three.js, no side effects at import.
 */

import * as brood from '../../brood-api.js';
import * as D from './derive.js';
import { patchUi } from './util.js';
import { emit } from './context.js';

/** The thin wrappers of PLATFORM §9.5 (`api.login(params)` …), by op. */
const WRAPPERS = Object.freeze({ auth_login: 'login', auth_signup: 'signup', auth_logout: 'logout', auth_logout_all: 'logoutAll', auth_reset: 'resetPassword' });

/**
 * One auth / account / testnet command. Uses the brood-api wrapper when it takes the params object (a one-argument
 * function), else brood-api's command(). Resolves to the body ({error, status, code} on failure), never throws.
 */
export async function authCommand(ctx, op, params = {}) {
  const api = ctx.api || brood;
  const name = WRAPPERS[op];
  const fn = name ? api[name] : null;
  try {
    if (typeof fn === 'function' && fn.length <= 1) return normBody(await fn(params));
    if (typeof api.command === 'function') return normBody(await api.command(op, params));
    return normBody(await brood.command(op, params));
  } catch (e) {
    return { error: String(e?.message || e), status: e?.status ?? 0 };
  }
}

function normBody(b) {
  return b && typeof b === 'object' ? b : { error: 'no answer', status: 0 };
}

/** GET a user / public query through the data layer's api (throws like brood-api.query). */
export async function query(ctx, op, params = {}) {
  const api = ctx.api || brood;
  return (api.query || brood.query)(op, params);
}

/** Refresh the testnet slices after a connect / verify / disconnect (WP4's data layer, else a tend). */
export function refreshTestnet(ctx) {
  try {
    if (typeof ctx.data?.refreshTestnet === 'function') return ctx.data.refreshTestnet();
    if (typeof ctx.data?.tend === 'function') return ctx.data.tend();
  } catch {
    /* the next poll catches up */
  }
  return undefined;
}

/** Reopen the SSE so the cookie (or its absence) applies to the stream (§9.5 restream). */
function restream(ctx) {
  const api = ctx.api || brood;
  try {
    if (typeof api.restream === 'function') return api.restream();
    if (typeof ctx.data?.restream === 'function') return ctx.data.restream();
  } catch (e) {
    console.error('[ui] restream failed', e);
  }
  return undefined;
}

/** Per-player slices cleared on every player change (none of them may leak to the next player, QA-12). */
function clearPlayer(store, user) {
  store.set((s) => ({
    user,
    bots: [],
    live: null,
    detail: {},
    diary: [],
    venues: null,
    season: null,
    testnet: s.testnet && typeof s.testnet === 'object' ? { ...s.testnet, status: null, testnet_status: null, link: null } : s.testnet,
    marks: s.marks ? { ...s.marks, bots: {}, account: {}, testnet_account: null } : s.marks,
    slots: { ...(s.slots || {}), map: {}, hidden: [], wanted: {} },
    ui: { ...(s.ui || {}), selectedSlot: null, focusSlot: null, pickBean: null, pending: {}, unread: 0 },
  }));
}

/**
 * After a successful auth_login / auth_signup / auth_reset (PLATFORM §9.1 "After sign-in"):
 * 1. the store resets the per-player state; 2. the SSE is reopened; 3. tend() runs; 4. a new garden gets Pip's tour
 * (with the "your garden is private" step); 5. after an operator reset, a one-time notice card.
 */
export function signedIn(ctx, user, { notice = null, isNew = false } = {}) {
  const { store } = ctx;
  // the data layer (WP4) resets the player, reopens the stream and refreshes; without it, do the same here
  let done = false;
  if (typeof ctx.data?.signedIn === 'function') {
    try {
      ctx.data.signedIn(user);
      done = true;
    } catch (e) {
      console.error('[ui] data.signedIn failed', e);
    }
  }
  if (!done) {
    clearPlayer(store, user);
    restream(ctx);
    for (const fn of ['tend', 'restock', 'refreshMarket']) {
      try {
        ctx.data?.[fn]?.();
      } catch {
        /* polling catches up */
      }
    }
    refreshTestnet(ctx);
  }
  if (D.userOf(store.get())?.id !== user?.id) store.set({ user });
  emit(ctx, 'ui:signedIn', { user, notice, isNew });
  if (notice === 'password_reset') ctx.mods.account?.resetNotice?.();
  if (isNew) setTimeout(() => ctx.mods.tutorial?.start?.({ force: true }), 600);
}

/** After sign-out (or a session that ended): spectator state, reopen the stream, show the gate. */
export function signedOut(ctx, { ended = false, reason = null } = {}) {
  const { store } = ctx;
  // first close the panel the player had open (account menu, testnet panel …): done AFTER the player is cleared,
  // this reset would also close the gate that the player change opens (and remember it as "just looking")
  const open = store.get().ui?.panel ?? null;
  if (open && open !== 'gate') patchUi(store, { panel: null });
  let done = false;
  if (typeof ctx.data?.signedOut === 'function') {
    try {
      ctx.data.signedOut({ reason });
      done = true;
    } catch (e) {
      console.error('[ui] data.signedOut failed', e);
    }
  }
  if (!done) {
    clearPlayer(store, null);
    restream(ctx);
    try {
      ctx.data?.restock?.();
    } catch {
      /* ignore */
    }
  } else if (D.userOf(store.get())) clearPlayer(store, null);
  emit(ctx, 'ui:signedOut', { ended, reason });
  ctx.mods.gate?.open?.({ ended });
}

/**
 * Boot fallback (§9.1 "Boot: GET /api/v1 gives auth; GET me gives user"): normally core/data.js fills store.mode
 * and store.user. If it has not after `waitMs`, ask once here. A none-mode server (or an old one without `auth`)
 * leaves the page exactly as today.
 */
export function ensureMode(ctx, { waitMs = 1200 } = {}) {
  const { store } = ctx;
  setTimeout(async () => {
    if (D.modeKnown(store.get())) return;
    let mode = null;
    try {
      const api = ctx.api || brood;
      if (typeof api.getMode === 'function') mode = await api.getMode();
      else {
        const r = await fetch(`${brood.getBase?.() || ''}/api/v1`, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
        const j = await r.json().catch(() => null);
        if (j && typeof j === 'object') mode = { auth: j.auth === 'accounts' ? 'accounts' : 'none', testnet: j.testnet || { enabled: false }, public_origin: j.public_origin ?? null };
      }
    } catch {
      return; // offline: the data layer's back-off owns the retry
    }
    if (!mode || D.modeKnown(store.get())) return;
    store.set({ mode });
    if (mode.auth !== 'accounts' || D.userOf(store.get())) return;
    try {
      const me = await query(ctx, 'me');
      if (me && typeof me === 'object' && !D.userOf(store.get())) store.set({ user: me.user || null, me });
    } catch {
      /* a spectator stays a spectator */
    }
  }, waitMs);
}

/**
 * field/plotFsm.js — PURE per-plot state machine + view queue (GAME-DESIGN §3.5).
 *
 *   empty → planting → (waiting | entering | growing) ⇄ paused → (harvesting | pulling) → retill → empty
 *
 * Overlay flags (error, frozen, liqDanger, selected, hover) stack on top of any state and live on `flags`.
 * Data updates that arrive while an exit timeline plays (harvesting / pulling / retill) are queued and
 * reconciled when it ends (§3.5 last paragraph).
 *
 * Two grace rules keep the island honest without ever inventing an outcome (J3):
 *   - planting: a `bot_create` in flight digs for at most 10 s; a failure (or the timeout without a bot)
 *     re-flattens the soil;
 *   - closing: when a bot disappears from the views before its `bot_closed` effect arrived (polling saw it
 *     first), the plot keeps its last crop for up to 1.2 s so the harvest/pull can still play; otherwise
 *     the box simply re-tills. Nothing is celebrated without the server's effect.
 *
 * No three.js, no DOM, no clock of its own: callers pass `nowMs`, so tests are deterministic.
 */

export const PLOT_STATES = Object.freeze(['empty', 'planting', 'waiting', 'entering', 'growing', 'paused', 'closing', 'harvesting', 'pulling', 'retill']);
export const OVERLAY_FLAGS = Object.freeze(['error', 'frozen', 'liqDanger', 'selected', 'hover']);

/** States that hold a planted bot (a crop or a sprout is drawn). */
export const PLANTED = Object.freeze(['waiting', 'entering', 'growing', 'paused']);
/** Exit timelines: data waits in the queue until they end. */
export const EXITING = Object.freeze(['harvesting', 'pulling', 'retill']);

export const FSM_TIMING = Object.freeze({
  plantingMaxMs: 10_000, // §4.1 trowel dig loop, max 10 s
  closingGraceMs: 1_200, // wait this long for a late bot_closed effect before re-tilling
  retillMs: 600, // §3.5 "box re-tills (0.6 s) → empty"
});

/** The FSM state a view asks for: 'empty' (no bot, or closed) or the view's own state. */
export function stateOfView(view) {
  if (!view || view.state === 'closed' || view.botId === undefined || view.botId === null) return 'empty';
  return PLANTED.includes(view.state) ? view.state : 'growing';
}

/**
 * createPlotFsm() → fsm
 *   fsm.state, fsm.view (applied view or null), fsm.lastView (last planted view), fsm.queued, fsm.flags
 *   fsm.apply(view, nowMs)        → { state, prev, changed, deferred }
 *   fsm.pending(on, ok, nowMs)    bot_create in flight (on) / answered (ok)
 *   fsm.planted(nowMs)            plantOk arrived before the view: show the sprout right away
 *   fsm.startExit(kind, nowMs)    'harvest' | 'pull' → true when the exit starts
 *   fsm.endExit(nowMs)            exit timeline finished → retill
 *   fsm.tick(nowMs)               timeouts → { state, prev, changed }
 *   fsm.setFlag(name, on)         overlay flags
 */
export function createPlotFsm(timing = {}) {
  const T = { ...FSM_TIMING, ...timing };
  const fsm = {
    state: 'empty',
    since: 0,
    view: null,
    lastView: null,
    queued: undefined, // undefined = nothing queued; null = "empty" queued
    closedIds: new Set(), // bots whose exit already played: their late views count as empty
    flags: { error: false, frozen: false, liqDanger: false, selected: false, hover: false },
    apply,
    pending,
    planted,
    startExit,
    endExit,
    tick,
    setFlag,
    get exiting() {
      return EXITING.includes(fsm.state);
    },
    get planted_() {
      return PLANTED.includes(fsm.state);
    },
  };

  function go(next, nowMs) {
    const prev = fsm.state;
    if (prev !== next) {
      fsm.state = next;
      fsm.since = nowMs ?? fsm.since;
    }
    return { state: fsm.state, prev, changed: prev !== next, deferred: false };
  }

  function apply(view, nowMs = 0) {
    if (fsm.exiting) {
      fsm.queued = view ?? null;
      return { state: fsm.state, prev: fsm.state, changed: false, deferred: true };
    }
    const want = view && fsm.closedIds.has(view.botId) ? 'empty' : stateOfView(view);
    if (want === 'empty') {
      if (PLANTED.includes(fsm.state)) {
        // the bot vanished before its close effect: hold the crop briefly (closing grace)
        fsm.view = null;
        return go('closing', nowMs);
      }
      if (fsm.state === 'planting' || fsm.state === 'closing') {
        fsm.view = null;
        return { state: fsm.state, prev: fsm.state, changed: false, deferred: false };
      }
      fsm.view = null;
      return go('empty', nowMs);
    }
    // a bot is (or is still) here
    if (fsm.lastView && fsm.lastView.botId !== view.botId && (PLANTED.includes(fsm.state) || fsm.state === 'closing')) {
      // a different bot took the slot without an exit (missed events): re-till first, then show it
      fsm.queued = view;
      fsm.view = null;
      return go('retill', nowMs);
    }
    fsm.view = view;
    fsm.lastView = view;
    return go(want, nowMs);
  }

  function pending(on, ok = true, nowMs = 0) {
    if (on) {
      if (fsm.state === 'empty') return go('planting', nowMs);
      return { state: fsm.state, prev: fsm.state, changed: false, deferred: false };
    }
    if (fsm.state === 'planting' && !ok) return go('empty', nowMs);
    return { state: fsm.state, prev: fsm.state, changed: false, deferred: false };
  }

  function planted(nowMs = 0) {
    if (fsm.state === 'planting' || fsm.state === 'empty') return go('waiting', nowMs);
    return { state: fsm.state, prev: fsm.state, changed: false, deferred: false };
  }

  function startExit(kind, nowMs = 0) {
    if (!(PLANTED.includes(fsm.state) || fsm.state === 'closing')) return false;
    const id = fsm.lastView?.botId;
    if (id !== undefined && id !== null) {
      fsm.closedIds.add(id);
      if (fsm.closedIds.size > 32) fsm.closedIds.delete(fsm.closedIds.values().next().value);
    }
    go(kind === 'pull' ? 'pulling' : 'harvesting', nowMs);
    return true;
  }

  function endExit(nowMs = 0) {
    if (fsm.state === 'harvesting' || fsm.state === 'pulling') {
      fsm.view = null;
      fsm.lastView = null;
      return go('retill', nowMs);
    }
    return { state: fsm.state, prev: fsm.state, changed: false, deferred: false };
  }

  function tick(nowMs = 0) {
    const age = nowMs - fsm.since;
    if (fsm.state === 'planting' && age >= T.plantingMaxMs) return go('empty', nowMs);
    if (fsm.state === 'closing' && age >= T.closingGraceMs) {
      fsm.lastView = null;
      return go('retill', nowMs);
    }
    if (fsm.state === 'retill' && age >= T.retillMs) {
      const q = fsm.queued;
      fsm.queued = undefined;
      go('empty', nowMs);
      if (q !== undefined && q !== null) {
        const r = apply(q, nowMs);
        return { ...r, prev: 'retill', changed: true };
      }
      return { state: 'empty', prev: 'retill', changed: true, deferred: false };
    }
    return { state: fsm.state, prev: fsm.state, changed: false, deferred: false };
  }

  function setFlag(name, on) {
    if (!OVERLAY_FLAGS.includes(name)) return false;
    const was = fsm.flags[name];
    fsm.flags[name] = !!on;
    return was !== !!on;
  }

  return fsm;
}

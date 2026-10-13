/**
 * core/bus.js — a tiny synchronous event bus (GAME-DESIGN §9.6).
 *
 *   const bus = createBus();
 *   const off = bus.on('game:event', (ev) => …);
 *   bus.emit('game:event', { type: 'fill', … });
 *
 * Event names used across the game (frozen on day 1, §9.6):
 *   game:event {type, …}            normalised server event (fill | created | paused | resumed | closed | halted |
 *                                   error | orderSkipped | tick | busted | feed | gap | warmup | daemon | gust | weather)
 *   data:marks marks                a `mids` pulse landed in the store
 *   data:views {prev, next}         plot views were recomputed
 *   cmd:pending {op, key, slot}     a command was sent
 *   cmd:done {op, key, slot, ok, body}
 *   ui:select {slot}                select a plot (null clears)        ui:focus {slot}   enter/leave focus (null)
 *   ui:pick {bean}                  enter/leave pick mode (null)        ui:panel {panel}  open/close a panel
 *   settings {settings, reduced}    settings changed                    quality {tier, state, step}
 *   stage:ready {stage}             the 3D stage exists (UI modules that project labels wait for it)
 *
 * Pure module: no side effects at import. A throwing listener is logged and never stops the others.
 */

export function createBus() {
  /** @type {Map<string, Set<Function>>} */
  const map = new Map();

  function on(type, fn) {
    if (typeof fn !== 'function') throw new TypeError('bus.on needs a function');
    let set = map.get(type);
    if (!set) map.set(type, (set = new Set()));
    set.add(fn);
    return () => off(type, fn);
  }

  function off(type, fn) {
    const set = map.get(type);
    if (!set) return;
    set.delete(fn);
    if (!set.size) map.delete(type);
  }

  function once(type, fn) {
    const offOnce = on(type, (payload) => {
      offOnce();
      fn(payload);
    });
    return offOnce;
  }

  /** Synchronous delivery to a snapshot of the listeners; returns how many were called. */
  function emit(type, payload) {
    const set = map.get(type);
    if (!set || !set.size) return 0;
    let n = 0;
    for (const fn of [...set]) {
      try {
        fn(payload);
        n++;
      } catch (e) {
        (globalThis.console?.error || (() => {}))(`bus listener for "${type}" failed`, e);
      }
    }
    return n;
  }

  /** Number of listeners for a type (diagnostics / tests). */
  function count(type) {
    return map.get(type)?.size || 0;
  }

  return { on, off, once, emit, count };
}

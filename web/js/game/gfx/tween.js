/**
 * gfx/tween.js — tweens, springs and timelines with one global motion scale (GAME-DESIGN §4, §7.3, §9.9).
 *
 *   import { tweens, ease, createSpring } from '../gfx/tween.js';
 *
 *   const h = tweens.to(obj, { y: 1, s: 0.5 }, { duration: 450, ease: 'oB', delay: 80 });
 *   await h.done;                          // resolves on finish OR cancel (h.cancelled tells which)
 *   tweens.value(0, 1, { duration: 600, onUpdate: (v) => … });
 *   tweens.timeline([[0, fnA], [120, fnB]]);          // callbacks on tween time (pauses with the loop)
 *   const s = tweens.spring(0.25, { omega: 4 });      // critically damped; s.target = 0.8; read s.value
 *   tweens.setMotionScale(0);                          // reduced motion: durations ≤ 150 ms, springs snap
 *   tweens.update(dtMs);                               // the loop calls this once per frame (stage.js)
 *   tweens.active()                                    // > 0 while anything moves (on-demand loop stays awake)
 *
 * Easings use the §4 short names: oB = easeOutBack(1.70158), iOC = easeInOutCubic, oC = easeOutCubic,
 * iOS = easeInOutSine (plus linear). Durations are milliseconds; springs integrate in seconds.
 *
 * Juice Contract (J2/J5): tweens animate DECORATION only. Never tween or count a money value — numbers are
 * written to the DOM at t = 0 by the UI; rules.assertEffect rejects effects asking for that.
 *
 * Pure module: no three.js, no DOM, no side effects at import (the default manager is a plain object).
 */

/** Reduced-motion ceiling for every tween duration (§7.3). */
export const RM_MAX_MS = 150;

/** §4 easings (t in 0..1). */
export const ease = Object.freeze({
  linear: (t) => t,
  /** easeOutBack(1.70158): overshoots ~10% then settles. */
  oB: (t) => {
    const s = 1.70158;
    const u = t - 1;
    return 1 + (s + 1) * u * u * u + s * u * u;
  },
  /** easeInOutCubic */
  iOC: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  /** easeOutCubic */
  oC: (t) => 1 - Math.pow(1 - t, 3),
  /** easeInOutSine */
  iOS: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  /** easeInCubic (exits, sinks) */
  iC: (t) => t * t * t,
});

const easeOf = (e) => (typeof e === 'function' ? e : ease[e] || ease.iOC);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Critically damped spring (no overshoot), integrated exactly so any dt is stable:
 *   x(t) = target + (x0 + (v0 + ω·x0)·t)·e^(−ω·t)
 * ω = 4 rad/s is the §3.4 crop-scale spring. `snap()` jumps to the target (reduced motion).
 */
export function createSpring(value = 0, { omega = 4, epsilon = 1e-4 } = {}) {
  const s = {
    value: Number(value) || 0,
    target: Number(value) || 0,
    velocity: 0,
    omega,
    /** Advance by dtSec (seconds). → true while still moving. */
    update(dtSec) {
      const dt = Math.max(0, Number(dtSec) || 0);
      const w = s.omega;
      const x0 = s.value - s.target;
      const v0 = s.velocity;
      const e = Math.exp(-w * dt);
      s.value = s.target + (x0 + (v0 + w * x0) * dt) * e;
      s.velocity = (v0 - w * (v0 + w * x0) * dt) * e;
      if (s.atRest()) {
        s.value = s.target;
        s.velocity = 0;
        return false;
      }
      return true;
    },
    /** Jump to `v` (default: the target) and stop. */
    snap(v = s.target) {
      s.value = s.target = Number(v) || 0;
      s.velocity = 0;
    },
    atRest() {
      return Math.abs(s.value - s.target) < epsilon && Math.abs(s.velocity) < epsilon * 10;
    },
  };
  return s;
}

/**
 * A tween/spring/timeline manager. `createTweens()` gives an independent one (tests, isolated systems);
 * most code uses the shared `tweens` instance so one motion scale governs the whole page.
 */
export function createTweens() {
  /** @type {Set<object>} */
  const list = new Set();
  /** @type {Set<object>} */
  const springs = new Set();
  const keyed = new Map();
  let scale = 1;
  let clock = 0; // ms of tween time

  const dur = (ms) => {
    const d = Math.max(0, Number(ms) || 0);
    return scale === 0 ? Math.min(d, RM_MAX_MS) : d;
  };

  function finish(tw, cancelled) {
    if (tw.finished) return;
    tw.finished = true;
    tw.handle.cancelled = cancelled;
    list.delete(tw);
    if (tw.key !== undefined && keyed.get(tw.key) === tw) keyed.delete(tw.key);
    if (!cancelled) {
      try {
        tw.onDone?.();
      } catch (e) {
        globalThis.console?.error?.('tween onDone failed', e);
      }
    }
    tw.resolve(!cancelled);
  }

  function add(tw) {
    if (tw.key !== undefined) {
      const prev = keyed.get(tw.key);
      if (prev) finish(prev, true);
      keyed.set(tw.key, tw);
    }
    list.add(tw);
    return tw.handle;
  }

  function makeHandle(tw) {
    let resolve;
    const done = new Promise((r) => (resolve = r));
    tw.resolve = resolve;
    tw.handle = {
      done,
      cancelled: false,
      cancel: () => finish(tw, true),
      /** Jump to the end state now (onUpdate(1) + onDone). */
      complete: () => {
        if (tw.finished) return;
        tw.step(1);
        finish(tw, false);
      },
      get finished() {
        return tw.finished;
      },
    };
    return tw;
  }

  /**
   * Animate numeric props of `target` to `props`.
   * opts: { duration = 400, ease = 'iOC', delay = 0, onUpdate(k), onDone(), key }
   * A `key` cancels a running tween with the same key (camera flights, per-plot channels).
   */
  function to(target, props, opts = {}) {
    const from = {};
    const keys = Object.keys(props || {}).filter((k) => Number.isFinite(Number(props[k])));
    const tw = makeHandle({
      t: -dur(opts.delay),
      d: dur(opts.duration ?? 400),
      e: easeOf(opts.ease),
      key: opts.key,
      onDone: opts.onDone,
      started: false,
      finished: false,
      step(k) {
        if (!this.started) {
          for (const p of keys) from[p] = Number(target[p]) || 0;
          this.started = true;
        }
        const v = this.e(k);
        for (const p of keys) target[p] = from[p] + (Number(props[p]) - from[p]) * v;
        opts.onUpdate?.(k, v);
      },
    });
    return add(tw);
  }

  /** Animate a plain number: onUpdate(value, k). */
  function value(fromV, toV, opts = {}) {
    const a = Number(fromV) || 0;
    const b = Number(toV) || 0;
    const tw = makeHandle({
      t: -dur(opts.delay),
      d: dur(opts.duration ?? 400),
      e: easeOf(opts.ease),
      key: opts.key,
      onDone: opts.onDone,
      finished: false,
      step(k) {
        opts.onUpdate?.(a + (b - a) * this.e(k), k);
      },
    });
    return add(tw);
  }

  /**
   * Callbacks on tween time: entries [atMs, fn] (atMs is scaled like a delay under reduced motion).
   * → handle; `done` resolves after the last callback.
   */
  function timeline(entries, opts = {}) {
    const items = (entries || [])
      .map((e) => (Array.isArray(e) ? { at: e[0], fn: e[1] } : e))
      .filter((e) => e && typeof e.fn === 'function')
      .map((e) => ({ at: dur(e.at), fn: e.fn, fired: false }))
      .sort((a, b) => a.at - b.at);
    const end = items.length ? items[items.length - 1].at : 0;
    const tw = makeHandle({
      t: 0,
      d: end,
      e: ease.linear,
      key: opts.key,
      onDone: opts.onDone,
      finished: false,
      step() {
        for (const it of items) {
          if (it.fired || it.at > this.t) continue;
          it.fired = true;
          try {
            it.fn();
          } catch (e) {
            globalThis.console?.error?.('timeline step failed', e);
          }
        }
      },
    });
    return add(tw);
  }

  /** Resolve after `ms` of tween time (scaled under reduced motion). */
  function wait(ms) {
    return timeline([[ms, () => {}]]).done;
  }

  /** A spring updated by this manager (`dispose()` to stop updating it). */
  function spring(v, opts) {
    const s = createSpring(v, opts);
    s.dispose = () => springs.delete(s);
    springs.add(s);
    return s;
  }

  /** Advance everything by dtMs. → true while anything is still moving. */
  function update(dtMs) {
    const dt = Math.max(0, Number(dtMs) || 0);
    clock += dt;
    for (const tw of [...list]) {
      if (tw.finished) continue;
      tw.t += dt;
      if (tw.t < 0) continue; // still in its delay
      const k = tw.d > 0 ? clamp01(tw.t / tw.d) : 1;
      try {
        tw.step(k);
      } catch (e) {
        globalThis.console?.error?.('tween step failed', e);
        finish(tw, true);
        continue;
      }
      if (k >= 1) finish(tw, false);
    }
    let moving = list.size > 0;
    for (const s of springs) {
      if (scale === 0) s.snap();
      else if (s.update(dt / 1000)) moving = true;
    }
    return moving;
  }

  return {
    to,
    value,
    timeline,
    wait,
    spring,
    update,
    /** Number of running tweens plus springs not at rest. */
    active() {
      let n = list.size;
      for (const s of springs) if (!s.atRest()) n++;
      return n;
    },
    /** 1 = full motion; 0 = reduced (durations ≤ 150 ms, springs snap). Durations apply to tweens started afterwards. */
    setMotionScale(s) {
      scale = Number(s) > 0 ? 1 : 0;
      if (scale === 0) for (const sp of springs) sp.snap();
    },
    get motionScale() {
      return scale;
    },
    /** Duration after the motion scale (for code that schedules its own timers). */
    scaled: dur,
    get now() {
      return clock;
    },
    /** Cancel everything (springs are kept). */
    clear() {
      for (const tw of [...list]) finish(tw, true);
    },
  };
}

/** The shared manager (one motion scale for the page). stage.js updates it every frame. */
export const tweens = createTweens();

/** Shortcut used by settings / reduced motion wiring. */
export function setMotionScale(s) {
  tweens.setMotionScale(s);
}

/** Linear interpolation helpers shared by gfx code. */
export const lerp = (a, b, k) => a + (b - a) * k;
export const lerpAngleDeg = (a, b, k) => {
  let d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * k;
};

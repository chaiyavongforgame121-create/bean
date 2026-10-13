/**
 * field/anim.js — PURE animation primitives for plots, crops and effects (GAME-DESIGN §3.4, §4, §7.3).
 *
 *   EASE.oB / iOC / oC / iOS / linear / outBack(s) / inCubic / outQuad / inOutQuad   (§4 easing names)
 *   createSpring(x, { omega })   critically damped spring (exact closed form, never overshoots or explodes)
 *   createTween(...)             one value from → to over a duration with an easing
 *   createTimeline({ scale })    staggered steps with onUpdate(k) callbacks and a `done` promise
 *   motionDur(ms, reduced)       reduced motion: every duration ≤ 150 ms (§7.3)
 *
 * No three.js, no DOM, no clock: everything advances by the dt it is given, so Node tests can drive it.
 * Juice Contract: these animate DECORATION only. Nothing here ever receives a money value (J2/J5).
 */

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Reduced motion caps every duration at 150 ms, opacity/colour fades only (§7.3). */
export const RM_MAX_MS = 150;

/** Duration under the motion setting: unchanged, or capped to 150 ms when reduced. */
export function motionDur(ms, reduced) {
  const d = Math.max(0, Number(ms) || 0);
  return reduced ? Math.min(d, RM_MAX_MS) : d;
}

// ------------------------------------------------------------------ easings (§4: oB, iOC, oC, iOS)

/** easeOutBack with overshoot `s` (1.70158 = the classic 10% overshoot). */
export function outBack(s = 1.70158) {
  return (t) => {
    const k = t - 1;
    return 1 + (s + 1) * k * k * k + s * k * k;
  };
}

export const EASE = Object.freeze({
  linear: (t) => t,
  /** easeOutBack(1.70158) */
  oB: outBack(1.70158),
  /** easeInOutCubic */
  iOC: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  /** easeOutCubic */
  oC: (t) => 1 - Math.pow(1 - t, 3),
  /** easeInOutSine */
  iOS: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  inCubic: (t) => t * t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inQuad: (t) => t * t,
});

/** Look an easing up by name or pass a function through (unknown → linear). */
export function easeOf(e) {
  if (typeof e === 'function') return e;
  return EASE[e] || EASE.linear;
}

/** Peak value of easeOutBack(s): 1 + 4s³ / (27(s + 1)²). */
export function outBackPeak(s) {
  return 1 + (4 * s * s * s) / (27 * (s + 1) * (s + 1));
}

const peakCache = new Map();
/** The overshoot `s` whose easeOutBack peaks at `peak` (bisection; 1.15 → s ≈ 2.16). */
export function overshootFor(peak) {
  if (peakCache.has(peak)) return peakCache.get(peak);
  let lo = 0;
  let hi = 12;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (outBackPeak(mid) < peak) lo = mid;
    else hi = mid;
  }
  const s = (lo + hi) / 2;
  peakCache.set(peak, s);
  return s;
}

/** 0 → peak → 1 "pop" (0 → 1.15 → 1 by default) built from easeOutBack, for fruit and sprouts (§4.1/§4.2). */
export function popScale(t, peak = 1.15) {
  return Math.max(0, outBack(overshootFor(peak))(clamp(t, 0, 1)));
}

// ------------------------------------------------------------------ springs (§3.4: ω = 4 rad/s)

/**
 * Critically damped spring toward a target. Closed form, so any dt is stable:
 *   y = x − target;  y(t) = (y0 + (v0 + ω·y0)·t)·e^(−ωt);  v(t) = (v0 − ω·(v0 + ω·y0)·t)·e^(−ωt)
 * `retarget()` keeps the current position and velocity (marks retarget, they never jump — J11).
 */
export function createSpring(x0 = 0, { omega = 4 } = {}) {
  const s = {
    x: Number(x0) || 0,
    v: 0,
    target: Number(x0) || 0,
    omega,
    /** Move the goal; position and velocity carry over. */
    retarget(target) {
      const t = Number(target);
      if (Number.isFinite(t)) s.target = t;
      return s;
    },
    /** Jump to a value (reduced motion, first appearance). */
    snap(value = s.target) {
      const v = Number(value);
      s.x = Number.isFinite(v) ? v : s.target;
      s.target = s.x;
      s.v = 0;
      return s;
    },
    /** Advance by dt seconds; → the new position. */
    step(dt) {
      const h = Math.max(0, Number(dt) || 0);
      if (!h) return s.x;
      const w = s.omega;
      const y0 = s.x - s.target;
      const c = s.v + w * y0;
      const e = Math.exp(-w * h);
      const y = (y0 + c * h) * e;
      s.v = (s.v - w * c * h) * e;
      s.x = s.target + y;
      if (Math.abs(y) < 1e-5 && Math.abs(s.v) < 1e-5) {
        s.x = s.target;
        s.v = 0;
      }
      return s.x;
    },
    /** True while it still moves visibly. */
    get moving() {
      return Math.abs(s.x - s.target) > 1e-4 || Math.abs(s.v) > 1e-4;
    },
  };
  return s;
}

// ------------------------------------------------------------------ tweens

/**
 * A value tween. `value(t)` is pure; `step(dtMs)` advances the internal clock.
 * opts: { from, to, ms, ease, delay }
 */
export function createTween({ from = 0, to = 1, ms = 300, ease = 'linear', delay = 0 } = {}) {
  const tw = {
    easeFn: easeOf(ease),
    from,
    to,
    ms: Math.max(0, ms),
    delay: Math.max(0, delay),
    t: 0,
    /** Retarget from the current value toward a new one, restarting the clock (optionally a new easing). */
    retarget(next, ms2 = tw.ms, ease2 = null) {
      if (ease2) tw.easeFn = easeOf(ease2);
      if (next === tw.to && tw.done) return tw;
      tw.from = tw.value();
      tw.to = next;
      tw.ms = Math.max(0, ms2);
      tw.t = 0;
      tw.delay = 0;
      return tw;
    },
    k() {
      if (tw.t <= tw.delay) return 0;
      if (tw.ms <= 0) return 1;
      return clamp((tw.t - tw.delay) / tw.ms, 0, 1);
    },
    value() {
      const k = tw.k();
      return tw.from + (tw.to - tw.from) * tw.easeFn(k);
    },
    step(dtMs) {
      tw.t += Math.max(0, Number(dtMs) || 0);
      return tw.value();
    },
    get done() {
      return tw.t >= tw.delay + tw.ms;
    },
  };
  return tw;
}

// ------------------------------------------------------------------ timelines

/**
 * A timeline of steps. Each step: { at (ms from start), ms (duration), ease, update(k01, eased), start(), end() }.
 * `scale` multiplies every `at`/`ms` (reduced motion passes durations through motionDur instead, see below).
 * `done` resolves when every step has ended (or when the timeline is cancelled).
 *
 *   const tl = createTimeline({ reduced });
 *   tl.add({ at: 0, ms: 450, ease: 'oB', update: (k, e) => mesh.scale.setScalar(e) });
 *   tl.call(600, () => …);          // a one-shot callback at 600 ms
 *   each frame: tl.step(dtMs)
 */
export function createTimeline({ reduced = false } = {}) {
  const steps = [];
  let t = 0;
  let resolve;
  let finished = false;
  const done = new Promise((r) => (resolve = r));

  function finish() {
    if (finished) return;
    finished = true;
    resolve(true);
  }

  const tl = {
    done,
    reduced,
    /** Add a step; under reduced motion its start is compressed and its length capped (≤ 150 ms). */
    add({ at = 0, ms = 0, ease = 'linear', update = null, start = null, end = null } = {}) {
      const st = {
        at: reduced ? Math.min(at, RM_MAX_MS) : Math.max(0, at),
        ms: motionDur(ms, reduced),
        ease: easeOf(ease),
        update,
        start,
        end,
        state: 0, // 0 waiting, 1 running, 2 ended
      };
      steps.push(st);
      return tl;
    },
    /** One-shot callback at `at` ms. */
    call(at, fn) {
      return tl.add({ at, ms: 0, end: fn });
    },
    /** Total length in ms. */
    get length() {
      let L = 0;
      for (const s of steps) L = Math.max(L, s.at + s.ms);
      return L;
    },
    get finished() {
      return finished;
    },
    /** Advance by dt ms. Returns true while running. */
    step(dtMs) {
      if (finished) return false;
      t += Math.max(0, Number(dtMs) || 0);
      let open = 0;
      for (const s of steps) {
        if (s.state === 2) continue;
        if (t < s.at) {
          open++;
          continue;
        }
        if (s.state === 0) {
          s.state = 1;
          s.start?.();
        }
        const k = s.ms > 0 ? clamp((t - s.at) / s.ms, 0, 1) : 1;
        s.update?.(k, s.ease(k));
        if (k >= 1) {
          s.state = 2;
          s.end?.();
        } else open++;
      }
      if (!open) finish();
      return !finished;
    },
    /** Jump to the end: every pending step runs its update(1) and end(). */
    skip() {
      if (finished) return;
      for (const s of steps) {
        if (s.state === 2) continue;
        if (s.state === 0) s.start?.();
        s.update?.(1, s.ease(1));
        s.end?.();
        s.state = 2;
      }
      finish();
    },
    /** Stop without running the remaining steps. */
    cancel() {
      finish();
    },
  };
  return tl;
}

// ------------------------------------------------------------------ small helpers

/** Smooth 0..1 pulse with a period (s) — e.g. the 2 s ripe glow, the 0.5 Hz danger ring. */
export function pulse(tSec, periodSec) {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * tSec) / Math.max(1e-3, periodSec));
}

/** Deterministic pseudo-random in [0, 1) from an integer seed (stable per plot). */
export function hash01(n) {
  let x = (Number(n) | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Next interval (ms) of an ambient event that repeats every [lo, hi] ms, drawn from a 0..1 source. */
export function nextGap(lo, hi, r = Math.random()) {
  return lo + (hi - lo) * clamp(r, 0, 1);
}

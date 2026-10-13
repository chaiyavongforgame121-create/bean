/**
 * gfx/camera.js — the farm camera rig (GAME-DESIGN §2.5, §4.6, §5.1, §5.2). Own code, no OrbitControls.
 *
 *   const rig = createRig(camera, canvas, { portrait });
 *   rig.resize(cssW, cssH)            canvas size changed (stage.js); picks landscape/portrait lens + range
 *   rig.update(dtMs) → moving          flights, inertia, idle drift (the loop calls it every frame)
 *   rig.focus(groundVec3, opts)        fly to a plot (d 18 / pitch 48°; portrait d 26 / 54°; 700 ms, tour 900 ms)
 *                                      opts: { d, pitch, yaw, lift = 1, duration, tour } → Promise<finished>
 *   rig.back() / rig.reset()           previous view (600 ms) / default view (800 ms) → Promise
 *   rig.setSafeArea({top,right,bottom,left})   HUD-occupied edges (CSS px): projection centre = safe-area centre
 *   rig.panBy(dx, dz) · rig.setYaw(deg) · rig.yawBy(deg) · rig.tiltBy(deg) · rig.zoomBy(factor)   keyboard moves
 *   rig.getState() · rig.onChange(fn) → off · rig.setEnabled(b) · rig.setReduced(b) · rig.setDrift(b) · rig.intro()
 *
 * Model: a target on the ground plane, a distance d, a yaw (clamped ±40°) and a pitch coupled to zoom:
 *   pitch = lerp(40°, 62°, (d − dMin)/(dMax − dMin)) + tilt,  tilt ∈ [−8°, +8°]   (focus uses a fixed pitch)
 * Yaw 0 looks north (−Z) from the south; +X is east. The camera never goes below y = 3.
 *
 * Input (pointer events on the canvas; keyboard is mapped by main.js onto the methods above):
 *   left-drag / 1 finger → grab-pan on the ground · right-drag or Alt+left-drag → yaw + tilt
 *   wheel → zoom toward the cursor (8% per notch) · pinch → zoom · 2-finger twist → yaw · 2-finger vertical → tilt
 * Pan and yaw keep inertia (× 0.9 per 16.7 ms, time-normalised); reduced motion: no inertia, no flights
 * (cuts with a 150 ms crossfade), no idle drift.
 *
 * Safe area: the HUD reports the edges it covers; the rig shifts the projection with camera.setViewOffset so the
 * target sits in the centre of the VISIBLE region (top HUD, bottom dock, desktop inspector, phone sheet).
 *
 * This module does not import three: it drives the PerspectiveCamera it is given (position/lookAt/fov/aspect/
 * setViewOffset) and does its ray maths on the camera's matrices, so the pure helpers are testable in Node.
 */

import { ease, lerp, lerpAngleDeg } from './tween.js';

/** §5.1 rig constants. */
export const RIG = Object.freeze({
  landscape: Object.freeze({ fov: 30, dMin: 16, dMax: 70, d0: 50, focusD: 18, focusPitch: 48 }),
  // portrait (phones): the default view fits the whole FARM — every landmark of §2.4 on screen and tappable at
  // 390 × 844 (PLATFORM QA-01 / QA-06) — instead of GAME-DESIGN's 24 u field fit, which left the stall, the
  // pond and the board outside the view; the farm is centred a little west (the pond's east bank is wider)
  portrait: Object.freeze({ fov: 42, dMin: 22, dMax: 90, d0: null, fitWidth: 36, focusD: 26, focusPitch: 54, target: Object.freeze({ x: -0.5, y: 0.8, z: 1.0 }) }),
  portraitAspect: 0.8,
  pitchMin: 40,
  pitchMax: 62,
  tiltMax: 8,
  yawMax: 40,
  defaultPitch: 52,
  target: Object.freeze({ x: 0, y: 0.8, z: 1.0 }),
  bounds: Object.freeze({ x: [-14, 14], z: [-12, 13] }),
  minCamY: 3,
  near: 0.5,
  far: 300,
  inertia: 0.9, // velocity multiplier per 16.7 ms
  maxPanVel: 0.06, // u/ms (a fling glides at most ~9 u)
  maxYawVel: 0.25, // deg/ms
  zoomPerNotch: 1.08,
  dragPx: 6, // pointer travel before a press becomes a drag (the picker uses the same tap threshold)
  focusLift: 1.0, // focus target = plot + (0, 1, 0)
  flight: Object.freeze({ focus: 700, back: 600, reset: 800, tour: 900, key: 220, intro: 2000, rmFade: 150 }),
  drift: Object.freeze({ idleMs: 30_000, amp: 10, hz: 0.01 }),
});

const DEG = Math.PI / 180;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// ------------------------------------------------------------------ pure helpers (tested)

export function lensOf(aspect) {
  return aspect < RIG.portraitAspect ? 'portrait' : 'landscape';
}

/** Pitch (deg above the horizon) coupled to the zoom distance, plus the user tilt (clamped ±8°). */
export function pitchFor(d, lens = 'landscape', tilt = 0) {
  const L = RIG[lens] || RIG.landscape;
  const k = clamp((d - L.dMin) / (L.dMax - L.dMin), 0, 1);
  return lerp(RIG.pitchMin, RIG.pitchMax, k) + clamp(tilt, -RIG.tiltMax, RIG.tiltMax);
}

/** Distance at which `width` world units fill the canvas width (vertical FOV `fovDeg`, `aspect` = w/h). */
export function fitDistance(width, fovDeg, aspect) {
  const half = Math.tan((fovDeg * DEG) / 2) * Math.max(0.05, aspect);
  return width / 2 / half;
}

/** Camera position for a target, distance, yaw and pitch (deg). */
export function camPosition(target, d, yawDeg, pitchDeg) {
  const p = pitchDeg * DEG;
  const y = yawDeg * DEG;
  return {
    x: target.x + d * Math.cos(p) * Math.sin(y),
    y: target.y + d * Math.sin(p),
    z: target.z + d * Math.cos(p) * Math.cos(y),
  };
}

/** Keep the target over the island (§5.1). */
export function clampTarget(t) {
  return { x: clamp(t.x, RIG.bounds.x[0], RIG.bounds.x[1]), y: t.y, z: clamp(t.z, RIG.bounds.z[0], RIG.bounds.z[1]) };
}

/**
 * setViewOffset numbers that put the projection centre in the middle of the safe area.
 * → null when there is nothing to shift, else { x, y } (offsetX/offsetY for setViewOffset(W, H, x, y, W, H)).
 */
export function safeOffset(W, H, safe) {
  const s = safe || {};
  const top = clamp(Number(s.top) || 0, 0, H * 0.8);
  const bottom = clamp(Number(s.bottom) || 0, 0, H * 0.8);
  const left = clamp(Number(s.left) || 0, 0, W * 0.8);
  const right = clamp(Number(s.right) || 0, 0, W * 0.8);
  // the HUD may never leave less than 40% of the canvas: scale oversized insets down proportionally
  let top2 = top;
  let bottom2 = bottom;
  let left2 = left;
  let right2 = right;
  if (top + bottom > H * 0.6) {
    const k = (H * 0.6) / (top + bottom);
    top2 = top * k;
    bottom2 = bottom * k;
  }
  if (left + right > W * 0.6) {
    const k = (W * 0.6) / (left + right);
    left2 = left * k;
    right2 = right * k;
  }
  return safeCentre(W, H, top2, right2, bottom2, left2);
}

function safeCentre(W, H, top, right, bottom, left) {
  const cx = left + Math.max(1, W - left - right) / 2;
  const cy = top + Math.max(1, H - top - bottom) / 2;
  const x = W / 2 - cx;
  const y = H / 2 - cy;
  return Math.abs(x) < 0.5 && Math.abs(y) < 0.5 ? null : { x, y };
}

/**
 * What the default view must show (§2.5): the whole field, the stall, the barn sign, the tower tank, the pond,
 * and the front of the fire pit and mailbox. Points are (x, y, z) in world units.
 */
export const DEFAULT_FRAME = Object.freeze([
  [-10.6, 0, -4.6], [10.6, 0, -4.6], [-10.6, 0, 4.6], [10.6, 0, 4.6], // field corners
  [-17, 0.5, 0], // seed stall
  [0, 1.5, -12], // barn front
  [13, 2, -8], // water tower legs
  [17.5, 0, 3], // pond east bank
  [8, 0, 11.5], // fire pit (front)
  [-7, 0, 11.2], // mailbox (front)
]);

/** Pitch of the default view at distance d (52°, as far as the ±8° tilt allows). */
function defaultPitchAt(d, lens) {
  const tilt = clamp(RIG.defaultPitch - pitchFor(d, lens, 0), -RIG.tiltMax, RIG.tiltMax);
  return { tilt, pitch: pitchFor(d, lens, tilt) };
}

/**
 * Do `points` project inside the safe rect (margin 2% of the canvas) for a yaw-0 camera at distance d?
 * Pure pinhole maths matching rig.apply(): the safe-area view offset moves the image centre to the safe
 * centre without changing the scale, so each point must sit within half the safe size of that centre.
 */
export function framesPoints(d, { lens = 'landscape', W, H, safe = null, points = DEFAULT_FRAME, target = null } = {}) {
  const L = RIG[lens] || RIG.landscape;
  const s = safe || {};
  const sw = Math.max(1, W - (Number(s.left) || 0) - (Number(s.right) || 0));
  const sh = Math.max(1, H - (Number(s.top) || 0) - (Number(s.bottom) || 0));
  const m = 0.02 * Math.min(W, H);
  const t = target || L.target || RIG.target;
  const { pitch } = defaultPitchAt(d, lens);
  const p = pitch * DEG;
  // camera at yaw 0: position above/south of the target, looking at it
  const cy = t.y + d * Math.sin(p);
  const cz = t.z + d * Math.cos(p);
  // forward f = (0, −sin p, −cos p); up u = (0, cos p, −sin p); right r = (1, 0, 0)
  const tanV = Math.tan((L.fov * DEG) / 2);
  for (const [x, y, z] of points) {
    const vx = x - t.x;
    const vy = y - cy;
    const vz = z - cz;
    const depth = -Math.sin(p) * vy - Math.cos(p) * vz;
    if (!(depth > 0.1)) return false;
    const upC = Math.cos(p) * vy - Math.sin(p) * vz;
    const ndcY = upC / (depth * tanV);
    const ndcX = vx / (depth * tanV * (W / H));
    if (Math.abs(ndcX) * (W / 2) > sw / 2 - m) return false;
    if (Math.abs(ndcY) * (H / 2) > sh / 2 - m) return false;
  }
  return true;
}

/**
 * Default rig state for a lens and canvas aspect (pitch 52° at the default distance).
 * Landscape starts at the §2.5 distance (50) and, when a canvas and its HUD-covered edges are known, backs off
 * just enough that the default view still shows every DEFAULT_FRAME point inside the visible region (a 1024 ×
 * 768 window with the HUD and dock would otherwise crop the stall and the barn). Portrait keeps fitDistance(24 u).
 */
export function defaultState(lens = 'landscape', aspect = 16 / 9, frame = null) {
  const L = RIG[lens] || RIG.landscape;
  let d0 = L.d0 ?? clamp(fitDistance(L.fitWidth, L.fov, aspect), L.dMin, L.dMax);
  if (lens === 'landscape' && frame && frame.W > 0 && frame.H > 0) {
    let d = d0;
    while (d < L.dMax && !framesPoints(d, { lens, ...frame })) d += 1;
    d0 = Math.min(d, L.dMax);
  }
  const { tilt } = defaultPitchAt(d0, lens);
  const T = L.target || RIG.target;
  return { tx: T.x, ty: T.y, tz: T.z, d: d0, yaw: 0, tilt, pitchOverride: null };
}

/** v' = M·(x,y,z,1) with perspective divide (three's column-major `elements`). */
function applyMat4(x, y, z, e) {
  const w = e[3] * x + e[7] * y + e[11] * z + e[15] || 1;
  return {
    x: (e[0] * x + e[4] * y + e[8] * z + e[12]) / w,
    y: (e[1] * x + e[5] * y + e[9] * z + e[13]) / w,
    z: (e[2] * x + e[6] * y + e[10] * z + e[14]) / w,
  };
}

/** World ray through NDC (nx, ny) of a camera whose matrices are current. → { origin, dir } */
export function rayFromCamera(camera, nx, ny) {
  const mw = camera.matrixWorld.elements;
  const origin = { x: mw[12], y: mw[13], z: mw[14] };
  const v = applyMat4(nx, ny, 0.5, camera.projectionMatrixInverse.elements);
  const w = applyMat4(v.x, v.y, v.z, mw);
  let dx = w.x - origin.x;
  let dy = w.y - origin.y;
  let dz = w.z - origin.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len;
  dy /= len;
  dz /= len;
  return { origin, dir: { x: dx, y: dy, z: dz } };
}

/** Intersection of a ray with the horizontal plane y = h (only in front, only when looking down). */
export function rayPlaneY(ray, h) {
  if (!ray || ray.dir.y > -1e-3) return null;
  const t = (h - ray.origin.y) / ray.dir.y;
  if (!(t > 0)) return null;
  return { x: ray.origin.x + ray.dir.x * t, y: h, z: ray.origin.z + ray.dir.z * t };
}

// ------------------------------------------------------------------ the rig

export function createRig(camera, dom, { portrait = false, reduced = false, fadeEl = null, now = () => performance.now() } = {}) {
  let W = Math.max(1, dom?.clientWidth || 1);
  let H = Math.max(1, dom?.clientHeight || 1);
  let lens = portrait ? 'portrait' : 'landscape';
  let st = defaultState(lens, W / H);
  let touched = false; // has the user moved the camera since the last reset (keeps their view on resize)
  let enabled = true;
  let isReduced = !!reduced;
  let drift = false;
  let lastInput = now();
  let driftYaw = 0;
  let focused = false;
  let saved = null; // the view to return to from focus
  let flight = null; // { from, to, t, dur, e, resolve, pFrom, pTo }
  const vel = { x: 0, z: 0, yaw: 0 }; // u/ms, deg/ms
  const listeners = new Set();
  const safeUi = { top: 0, right: 0, bottom: 0, left: 0 };
  const safeAuto = { top: 0, right: 0, bottom: 0, left: 0 };
  let projDirty = true;

  const L = () => RIG[lens];
  /** The default view for the current canvas, fitted inside the HUD-covered edges main.js measured. */
  const defView = () => defaultState(lens, W / H, { W, H, safe: safeAuto });
  const pitchOf = (s) => (s.pitchOverride ?? pitchFor(s.d, lens, s.tilt));

  function clampState(s) {
    const t = clampTarget({ x: s.tx, y: s.ty, z: s.tz });
    s.tx = t.x;
    s.tz = t.z;
    s.d = clamp(s.d, L().dMin, L().dMax);
    s.yaw = clamp(s.yaw, -RIG.yawMax, RIG.yawMax);
    s.tilt = clamp(s.tilt, -RIG.tiltMax, RIG.tiltMax);
    return s;
  }

  function applyProjection() {
    camera.fov = L().fov;
    camera.aspect = W / H;
    camera.near = RIG.near;
    camera.far = RIG.far;
    const off = safeOffset(W, H, getSafeArea());
    if (off && typeof camera.setViewOffset === 'function') camera.setViewOffset(W, H, off.x, off.y, W, H);
    else if (typeof camera.clearViewOffset === 'function') camera.clearViewOffset();
    camera.updateProjectionMatrix?.();
    projDirty = false;
  }

  /** Write the state into the camera (+ projection when dirty). */
  function apply() {
    if (projDirty) applyProjection();
    const target = { x: st.tx, y: st.ty, z: st.tz };
    const pos = camPosition(target, st.d, st.yaw + driftYaw, pitchOf(st));
    if (pos.y < RIG.minCamY) pos.y = RIG.minCamY;
    camera.position.set(pos.x, pos.y, pos.z);
    camera.lookAt(target.x, target.y, target.z);
    camera.updateMatrixWorld?.(true);
  }

  function emit() {
    for (const fn of [...listeners]) {
      try {
        fn(getState());
      } catch (e) {
        globalThis.console?.error?.('rig listener failed', e);
      }
    }
  }

  function changed() {
    apply();
    emit();
  }

  function getState() {
    return {
      target: { x: st.tx, y: st.ty, z: st.tz },
      d: st.d,
      yaw: st.yaw,
      tilt: st.tilt,
      pitch: pitchOf(st),
      lens,
      focused,
      moving: !!flight || Math.abs(vel.x) + Math.abs(vel.z) + Math.abs(vel.yaw) > 1e-6,
    };
  }

  // ---------------------------------------------------------------- flights

  function crossfade() {
    const el = fadeEl || dom;
    try {
      el?.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration: RIG.flight.rmFade, easing: 'ease-out' });
    } catch {
      /* no WAAPI: a plain cut */
    }
  }

  /** Fly to `to` (a full or partial state). Reduced motion → cut + crossfade. → Promise<boolean finished> */
  function fly(to, { duration = RIG.flight.focus, easing = 'iOC', cut = isReduced } = {}) {
    if (flight) flight.resolve(false);
    flight = null;
    vel.x = vel.z = vel.yaw = 0;
    const target = clampState({ ...st, ...to });
    if (cut || duration <= 0) {
      const wasDifferent = Math.abs(target.tx - st.tx) + Math.abs(target.tz - st.tz) + Math.abs(target.d - st.d) + Math.abs(target.yaw - st.yaw) > 0.01;
      st = target;
      if (wasDifferent && cut && duration > 0) crossfade();
      changed();
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      flight = { from: { ...st }, to: target, t: 0, dur: duration, e: ease[easing] || ease.iOC, resolve, pFrom: pitchOf(st), pTo: pitchOf(target) };
    });
  }

  function stepFlight(dt) {
    const f = flight;
    f.t += dt;
    const k = clamp(f.t / f.dur, 0, 1);
    const v = f.e(k);
    st.tx = lerp(f.from.tx, f.to.tx, v);
    st.ty = lerp(f.from.ty, f.to.ty, v);
    st.tz = lerp(f.from.tz, f.to.tz, v);
    st.d = lerp(f.from.d, f.to.d, v);
    st.yaw = lerpAngleDeg(f.from.yaw, f.to.yaw, v);
    st.tilt = f.to.tilt;
    st.pitchOverride = lerp(f.pFrom, f.pTo, v);
    if (k >= 1) {
      st = { ...f.to };
      flight = null;
      f.resolve(true);
    }
  }

  // ---------------------------------------------------------------- public moves

  function focus(v, opts = {}) {
    if (!v) return Promise.resolve(false);
    if (!focused) saved = { ...st };
    focused = true;
    touched = true;
    const lift = opts.lift ?? RIG.focusLift;
    return fly(
      { tx: Number(v.x) || 0, ty: (Number(v.y) || 0) + lift, tz: Number(v.z) || 0, d: opts.d ?? L().focusD, pitchOverride: opts.pitch ?? L().focusPitch, yaw: opts.yaw ?? st.yaw },
      { duration: opts.duration ?? (opts.tour ? RIG.flight.tour : RIG.flight.focus) },
    );
  }

  /** Leave focus to the saved view. A no-op outside focus (UI and main.js may both ask for it). */
  function back() {
    if (!focused) return Promise.resolve(false);
    const to = saved || defView();
    saved = null;
    focused = false;
    return fly({ ...to }, { duration: RIG.flight.back });
  }

  function reset() {
    saved = null;
    focused = false;
    touched = false;
    const p = fly(defView(), { duration: RIG.flight.reset });
    if (flight) flight.toDefault = true;
    return p;
  }

  /**
   * First-load arc: from high and turned, to the default view (2 s; reduced motion: no arc). Skipped when the
   * player (or the tour) already moved or focused the camera — the intro never takes the view away from them.
   */
  function intro(duration = RIG.flight.intro) {
    if (focused || touched || flight) return Promise.resolve(false);
    const def = defView();
    if (isReduced) {
      st = def;
      changed();
      crossfade();
      return Promise.resolve(true);
    }
    st = clampState({ ...def, d: L().dMax, yaw: -30, tilt: RIG.tiltMax, tz: def.tz + 3 });
    changed();
    const p = fly(def, { duration, easing: 'iOC', cut: false });
    if (flight) flight.toDefault = true;
    return p;
  }

  const bumpInput = () => {
    lastInput = now();
    touched = true;
    if (driftYaw) driftYaw = 0;
  };

  /** Move the target in the camera's ground frame: dx = screen right, dz = screen forward (world units). */
  function panBy(dx, dz, { animate = true } = {}) {
    bumpInput();
    const y = st.yaw * DEG;
    const right = { x: Math.cos(y), z: -Math.sin(y) };
    const fwd = { x: -Math.sin(y), z: -Math.cos(y) };
    const to = { tx: st.tx + right.x * dx + fwd.x * dz, tz: st.tz + right.z * dx + fwd.z * dz };
    if (!animate) {
      Object.assign(st, to);
      clampState(st);
      changed();
      return Promise.resolve(true);
    }
    return fly(to, { duration: RIG.flight.key, easing: 'oC' });
  }

  function setYaw(deg, { animate = true } = {}) {
    bumpInput();
    const to = { yaw: clamp(Number(deg) || 0, -RIG.yawMax, RIG.yawMax) };
    if (!animate) {
      Object.assign(st, to);
      changed();
      return Promise.resolve(true);
    }
    return fly(to, { duration: RIG.flight.key + 80, easing: 'oC' });
  }

  const yawBy = (deg, o) => setYaw(st.yaw + deg, o);

  function tiltBy(deg, { animate = true } = {}) {
    bumpInput();
    const to = st.pitchOverride !== null && focused
      ? { pitchOverride: clamp(st.pitchOverride + deg, RIG.pitchMin - RIG.tiltMax, RIG.pitchMax + RIG.tiltMax) }
      : { tilt: clamp(st.tilt + deg, -RIG.tiltMax, RIG.tiltMax), pitchOverride: null };
    if (!animate) {
      Object.assign(st, to);
      changed();
      return Promise.resolve(true);
    }
    return fly(to, { duration: RIG.flight.key, easing: 'oC' });
  }

  /** Zoom by a factor (> 1 = out) about the current target. */
  function zoomBy(factor, { animate = true } = {}) {
    bumpInput();
    const to = { d: clamp(st.d * (Number(factor) || 1), L().dMin, L().dMax) };
    if (!animate) {
      Object.assign(st, to);
      changed();
      return Promise.resolve(true);
    }
    return fly(to, { duration: RIG.flight.key, easing: 'oC' });
  }

  // ---------------------------------------------------------------- pointer input

  const pointers = new Map(); // id → { x, y, sx, sy, type, button, alt }
  let gesture = null; // { kind: 'pan'|'rotate'|'multi', ... }
  let rect = null;

  const local = (e) => {
    const r = rect || dom.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** Ground point under a canvas-local pixel (plane y = target height). */
  function groundAt(px, py) {
    const nx = (px / W) * 2 - 1;
    const ny = -((py / H) * 2 - 1);
    return rayPlaneY(rayFromCamera(camera, nx, ny), st.ty);
  }

  function cancelFlight() {
    if (flight) {
      flight.resolve(false);
      flight = null;
      // freeze at the in-between pose, as a plain (unfocused-pitch) state
      st.tilt = clamp(pitchOf(st) - pitchFor(st.d, lens, 0), -RIG.tiltMax, RIG.tiltMax);
      if (!focused) st.pitchOverride = null;
    }
  }

  function startGesture() {
    const list = [...pointers.values()];
    if (list.length >= 2) {
      const [a, b] = list;
      gesture = { kind: 'multi', dist: Math.hypot(b.x - a.x, b.y - a.y) || 1, angle: Math.atan2(b.y - a.y, b.x - a.x), my: (a.y + b.y) / 2, active: true };
    } else if (list.length === 1) {
      const p = list[0];
      const rotate = p.type === 'mouse' && (p.button === 2 || (p.button === 0 && p.alt));
      gesture = { kind: rotate ? 'rotate' : 'pan', active: false, grab: null, lastT: now(), lx: p.x, ly: p.y };
    } else gesture = null;
  }

  function onDown(e) {
    if (!enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    rect = dom.getBoundingClientRect();
    const p = local(e);
    pointers.set(e.pointerId, { ...p, sx: p.x, sy: p.y, type: e.pointerType, button: e.button, alt: e.altKey });
    try {
      dom.setPointerCapture?.(e.pointerId);
    } catch {
      /* not capturable (synthetic) */
    }
    cancelFlight();
    vel.x = vel.z = vel.yaw = 0;
    startGesture();
  }

  function onMove(e) {
    const p0 = pointers.get(e.pointerId);
    if (!p0 || !gesture || !enabled) return;
    const p = local(e);
    const dxp = p.x - p0.x;
    const dyp = p.y - p0.y;
    p0.x = p.x;
    p0.y = p.y;
    const t = now();

    if (gesture.kind === 'multi') {
      const list = [...pointers.values()];
      if (list.length < 2) return;
      const [a, b] = list;
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const my = (a.y + b.y) / 2;
      let dAng = angle - gesture.angle;
      if (dAng > Math.PI) dAng -= 2 * Math.PI;
      if (dAng < -Math.PI) dAng += 2 * Math.PI;
      st.d = clamp(st.d * (gesture.dist / dist), L().dMin, L().dMax);
      st.yaw = clamp(st.yaw - dAng / DEG, -RIG.yawMax, RIG.yawMax);
      const dTilt = (my - gesture.my) * 0.15;
      if (focused && st.pitchOverride !== null) st.pitchOverride = clamp(st.pitchOverride + dTilt, RIG.pitchMin - RIG.tiltMax, RIG.pitchMax + RIG.tiltMax);
      else st.tilt = clamp(st.tilt + dTilt, -RIG.tiltMax, RIG.tiltMax);
      gesture.dist = dist;
      gesture.angle = angle;
      gesture.my = my;
      bumpInput();
      changed();
      return;
    }

    if (!gesture.active) {
      if (Math.hypot(p.x - p0.sx, p.y - p0.sy) < RIG.dragPx) return;
      gesture.active = true;
      if (gesture.kind === 'pan') gesture.grab = groundAt(p.x - dxp, p.y - dyp);
    }
    bumpInput();
    // a coarse first event (or a synthetic jump) must not become a huge fling: ≥ 16 ms per sample, capped speed
    const dtMs = Math.max(16, t - gesture.lastT);
    gesture.lastT = t;

    if (gesture.kind === 'rotate') {
      const dYaw = -dxp * 0.3;
      st.yaw = clamp(st.yaw + dYaw, -RIG.yawMax, RIG.yawMax);
      if (focused && st.pitchOverride !== null) st.pitchOverride = clamp(st.pitchOverride + dyp * 0.15, RIG.pitchMin - RIG.tiltMax, RIG.pitchMax + RIG.tiltMax);
      else st.tilt = clamp(st.tilt + dyp * 0.15, -RIG.tiltMax, RIG.tiltMax);
      vel.yaw = clamp(lerp(vel.yaw, dYaw / dtMs, 0.5), -RIG.maxYawVel, RIG.maxYawVel);
      changed();
      return;
    }

    // grab-pan: keep the grabbed ground point under the pointer
    const before = { x: st.tx, z: st.tz };
    const now3 = groundAt(p.x, p.y);
    if (gesture.grab && now3) {
      st.tx += gesture.grab.x - now3.x;
      st.tz += gesture.grab.z - now3.z;
    } else {
      // looking at the sky: pixel-scaled fallback
      const wpp = (2 * st.d * Math.tan((L().fov * DEG) / 2)) / H;
      const y = st.yaw * DEG;
      st.tx -= (Math.cos(y) * dxp - Math.sin(y) * dyp) * wpp;
      st.tz -= (-Math.sin(y) * dxp - Math.cos(y) * dyp) * wpp;
    }
    clampState(st);
    vel.x = clamp(lerp(vel.x, (st.tx - before.x) / dtMs, 0.5), -RIG.maxPanVel, RIG.maxPanVel);
    vel.z = clamp(lerp(vel.z, (st.tz - before.z) / dtMs, 0.5), -RIG.maxPanVel, RIG.maxPanVel);
    changed();
  }

  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    try {
      dom.releasePointerCapture?.(e.pointerId);
    } catch {
      /* already released */
    }
    const wasActive = gesture?.active;
    const kind = gesture?.kind;
    // velocity older than ~80 ms means the pointer stopped before release: no fling
    if (!wasActive || isReduced || now() - (gesture?.lastT ?? 0) > 80 || kind === 'multi') vel.x = vel.z = vel.yaw = 0;
    if (pointers.size) {
      // 2 → 1 finger: continue as a fresh pan with the remaining pointer
      for (const p of pointers.values()) {
        p.sx = p.x;
        p.sy = p.y;
      }
      startGesture();
      if (gesture) gesture.active = false;
    } else gesture = null;
  }

  function onWheel(e) {
    if (!enabled) return;
    e.preventDefault();
    cancelFlight();
    bumpInput();
    const unit = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 1 : 1 / 100;
    const notches = clamp(e.deltaY * unit, -5, 5);
    const factor = Math.pow(RIG.zoomPerNotch, notches);
    rect = dom.getBoundingClientRect();
    const p = local(e);
    zoomAt(factor, p.x, p.y);
  }

  /** Zoom by `factor` toward the ground point under canvas pixel (px, py). */
  function zoomAt(factor, px, py) {
    const g = groundAt(px, py);
    const d0 = st.d;
    const d1 = clamp(d0 * factor, L().dMin, L().dMax);
    if (g && !focused) {
      const k = 1 - d1 / d0;
      st.tx += (g.x - st.tx) * k;
      st.tz += (g.z - st.tz) * k;
    }
    st.d = d1;
    clampState(st);
    changed();
  }

  const onContext = (e) => e.preventDefault();

  if (dom?.addEventListener) {
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointercancel', onUp);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('contextmenu', onContext);
    try {
      dom.style.touchAction = 'none';
    } catch {
      /* not an element */
    }
  }

  // ---------------------------------------------------------------- frame update

  /** Advance flights / inertia / drift by dtMs. → true while the camera moves. */
  function update(dtMs) {
    const dt = clamp(Number(dtMs) || 0, 0, 50);
    let moving = false;
    if (flight) {
      stepFlight(dt);
      moving = true;
    } else if (!gesture?.active && !isReduced) {
      const speed = Math.abs(vel.x) + Math.abs(vel.z) + Math.abs(vel.yaw);
      if (speed > 1e-5) {
        st.tx += vel.x * dt;
        st.tz += vel.z * dt;
        st.yaw = clamp(st.yaw + vel.yaw * dt, -RIG.yawMax, RIG.yawMax);
        clampState(st);
        const decay = Math.pow(RIG.inertia, dt / 16.7);
        vel.x *= decay;
        vel.z *= decay;
        vel.yaw *= decay;
        if (Math.abs(vel.x) + Math.abs(vel.z) < 1e-5 && Math.abs(vel.yaw) < 1e-4) vel.x = vel.z = vel.yaw = 0;
        moving = true;
      }
    }
    // idle drift (setting, default off): yaw ±10° at 0.01 Hz after 30 s without input
    let driftNext = 0;
    if (drift && !isReduced && !focused && !flight && now() - lastInput > RIG.drift.idleMs) {
      driftNext = RIG.drift.amp * Math.sin(((now() - lastInput - RIG.drift.idleMs) / 1000) * 2 * Math.PI * RIG.drift.hz);
      moving = true;
    }
    const driftChanged = Math.abs(driftNext - driftYaw) > 1e-6;
    driftYaw = driftNext;
    if (moving || driftChanged || projDirty) changed();
    return moving;
  }

  // ---------------------------------------------------------------- sizing + safe area

  function resize(w, h) {
    const nw = Math.max(1, Math.round(w));
    const nh = Math.max(1, Math.round(h));
    if (nw === W && nh === H && !projDirty) return;
    W = nw;
    H = nh;
    const nextLens = lensOf(W / H);
    if (nextLens !== lens) {
      lens = nextLens;
      if (!touched && !focused) st = defView();
      else if (focused) Object.assign(st, { d: L().focusD, pitchOverride: L().focusPitch });
    } else if (!touched && !focused && !flight) st = defView();
    clampState(st);
    projDirty = true;
    changed();
  }

  function sameRect(a, r) {
    return a.top === r.top && a.right === r.right && a.bottom === r.bottom && a.left === r.left;
  }

  function normRect(r) {
    const n = (x) => Math.max(0, Math.round(Number(x) || 0));
    return { top: n(r?.top), right: n(r?.right), bottom: n(r?.bottom), left: n(r?.left) };
  }

  /** Edges the UI (sheets, inspector) reports as covered, in CSS px. Per edge, the larger of UI and auto wins. */
  function setSafeArea(r) {
    const n = normRect(r);
    if (sameRect(safeUi, n)) return;
    Object.assign(safeUi, n);
    projDirty = true;
    changed();
  }

  /** Edges main.js measures from the HUD/dock layout. */
  /** The effective covered edges (per edge, the larger of UI and auto). */
  function getSafeArea() {
    return {
      top: Math.max(safeUi.top, safeAuto.top),
      right: Math.max(safeUi.right, safeAuto.right),
      bottom: Math.max(safeUi.bottom, safeAuto.bottom),
      left: Math.max(safeUi.left, safeAuto.left),
    };
  }

  function setAutoSafeArea(r) {
    const n = normRect(r);
    if (sameRect(safeAuto, n)) return;
    Object.assign(safeAuto, n);
    // an untouched default view re-fits to the new HUD layout (the player's own view is never changed)
    if (!touched && !focused) {
      if (!flight) st = clampState(defView());
      else if (flight.toDefault) {
        // the intro / reset flight lands on the re-fitted default instead
        flight.to = clampState({ ...flight.to, ...defView() });
        flight.pTo = pitchOf(flight.to);
      }
    }
    projDirty = true;
    changed();
  }

  apply();

  return {
    update,
    focus,
    back,
    reset,
    intro,
    setSafeArea,
    setAutoSafeArea,
    getSafeArea,
    setYaw,
    yawBy,
    tiltBy,
    zoomBy,
    zoomAt,
    panBy,
    resize,
    getState,
    groundAt: (clientX, clientY) => {
      const r = dom.getBoundingClientRect();
      return groundAt(clientX - r.left, clientY - r.top);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setEnabled(b) {
      enabled = !!b;
      if (!enabled) {
        pointers.clear();
        gesture = null;
        vel.x = vel.z = vel.yaw = 0;
      }
    },
    setReduced(b) {
      isReduced = !!b;
      if (isReduced) {
        vel.x = vel.z = vel.yaw = 0;
        driftYaw = 0;
        if (flight) {
          const f = flight;
          flight = null;
          st = { ...f.to };
          f.resolve(true);
          changed();
        }
      }
    },
    setDrift(b) {
      drift = !!b;
      lastInput = now();
    },
    get focused() {
      return focused;
    },
    /** Leave focus bookkeeping without flying (e.g. the plot vanished). */
    clearFocus() {
      focused = false;
      saved = null;
      st.pitchOverride = null;
    },
    isMoving: () => !!flight || Math.abs(vel.x) + Math.abs(vel.z) + Math.abs(vel.yaw) > 1e-6,
    dispose() {
      listeners.clear();
      if (!dom?.removeEventListener) return;
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointercancel', onUp);
      dom.removeEventListener('wheel', onWheel);
      dom.removeEventListener('contextmenu', onContext);
    },
  };
}

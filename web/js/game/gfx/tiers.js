/**
 * gfx/tiers.js — quality tiers and the step-down governor (GAME-DESIGN §7.5, §9.9).
 *
 *   resolveTier(setting, env)        'auto'|'high'|'medium'|'low' → tier name (Auto: High; Medium for a coarse
 *                                    pointer or deviceMemory ≤ 4; Low when WebGL2 only came up in software)
 *   qualityFor(tier, env)            → Quality: the effective knobs every system reads (see QUALITY below)
 *   stepDown(quality)                → { quality, step } | null — the next governor step, in the §7.5 order
 *   createGovernor(opts)             → { sample(frameMs, nowMs, budgetMs) → boolean, reset(nowMs), steps }
 *
 * Quality = { tier, dpr, antialias, shadows: 'soft'|'pcf'|'off', shadowSize, shadowEvery, post, grass,
 *             particles, critters, farmer, outlines: 'hover'|'selected', fps, budget: {draw, casters, tris},
 *             steps: [names of governor steps applied] }
 * World/Field/particles read `grass`, `particles`, `critters`, `farmer`, `outlines`, `shadows` ('off' = blob
 * decals) through their optional setQuality(q) hook (stage.js feature-detects it).
 *
 * The governor only ever steps DOWN during a session (a manual Graphics change in Settings resets it).
 * Pure module: no three.js, no DOM, no side effects at import.
 */

/** §7.5 tier table. `fps` is the target frame rate (budget 16.7 / 33.3 ms). */
export const TIERS = Object.freeze({
  high: Object.freeze({
    tier: 'high', dpr: 2.0, antialias: true, shadows: 'soft', shadowSize: 2048, shadowEvery: 1, post: true,
    grass: 900, particles: 1500, critters: true, farmer: true, outlines: 'hover', fps: 60,
    budget: Object.freeze({ draw: 140, casters: 70, tris: 250_000 }),
  }),
  medium: Object.freeze({
    tier: 'medium', dpr: 1.5, antialias: true, shadows: 'pcf', shadowSize: 1024, shadowEvery: 2, post: false,
    grass: 500, particles: 800, critters: true, farmer: true, outlines: 'selected', fps: 60,
    budget: Object.freeze({ draw: 110, casters: 50, tris: 150_000 }),
  }),
  low: Object.freeze({
    tier: 'low', dpr: 1.0, antialias: false, shadows: 'off', shadowSize: 0, shadowEvery: 0, post: false,
    grass: 200, particles: 300, critters: false, farmer: true, outlines: 'selected', fps: 30,
    budget: Object.freeze({ draw: 80, casters: 0, tris: 80_000 }),
  }),
});

export const TIER_NAMES = Object.freeze(['high', 'medium', 'low']);

/** Governor steps, in order (§7.5). Steps that would change nothing are skipped. */
export const STEPS = Object.freeze(['dpr', 'post', 'shadowsMedium', 'shadowsOff', 'grassHalf', 'particlesHalf', 'low']);

/** Governor constants: rolling window, wait after a step, trigger ratio vs budget. */
export const GOVERNOR = Object.freeze({ windowMs: 3000, waitMs: 5000, ratio: 1.3, minSamples: 20, maxFrameMs: 100, minCoverage: 0.75 });

/**
 * Integrated / mobile GPU from the UNMASKED_RENDERER string (WEBGL_debug_renderer_info): measured on an Intel
 * UHD iGPU, High (MSAA post pass + per-frame shadows) ran ≈ 35 fps against a 55 fps target, Medium ≈ 56 fps.
 */
export function integratedGpu(renderer) {
  return /\b(Intel|UHD|Iris|HD Graphics|Mali|Adreno|PowerVR|Apple GPU|Apple M\d|Vivante|VideoCore)\b/i.test(String(renderer || ''));
}

/** Auto tier from the environment. */
export function autoTier({ coarse = false, deviceMemory = null, software = false, integrated = false } = {}) {
  if (software) return 'low';
  const mem = Number(deviceMemory);
  if (coarse || integrated || (Number.isFinite(mem) && mem > 0 && mem <= 4)) return 'medium';
  return 'high';
}

/** Settings value ('auto'|'high'|'medium'|'low') → tier name. */
export function resolveTier(setting, env = {}) {
  return TIER_NAMES.includes(setting) ? setting : autoTier(env);
}

/**
 * Effective quality for a tier. `env.devicePixelRatio` caps the DPR from below (never upscale past the
 * screen), `env.coarse` drops Medium's target to 30 fps on phones (§7.5 "60 (fine pointer) / 30 (coarse)").
 */
export function qualityFor(tier, { devicePixelRatio = 1, coarse = false } = {}) {
  const base = TIERS[tier] || TIERS.high;
  const screen = Math.max(1, Number(devicePixelRatio) || 1);
  return {
    ...base,
    budget: { ...base.budget },
    dpr: Math.min(base.dpr, screen),
    fps: base.tier === 'medium' && coarse ? 30 : base.fps,
    steps: [],
  };
}

/** Frame budget in ms for a quality (16.7 at 60 fps, 33.3 at 30 fps). */
export function budgetMs(quality) {
  return 1000 / (Number(quality?.fps) || 60);
}

/** Apply one named step. → the new quality, or null when the step changes nothing. */
export function applyStep(q, step) {
  const n = { ...q, budget: { ...q.budget }, steps: [...(q.steps || [])] };
  switch (step) {
    case 'dpr':
      if (q.dpr <= 1) return null;
      n.dpr = Math.max(1, Math.round((q.dpr - 0.25) * 100) / 100);
      break;
    case 'post':
      if (!q.post) return null;
      n.post = false;
      break;
    case 'shadowsMedium':
      if (q.shadows !== 'soft' && !(q.shadows === 'pcf' && q.shadowSize > 1024)) return null;
      n.shadows = 'pcf';
      n.shadowSize = 1024;
      n.shadowEvery = 2;
      break;
    case 'shadowsOff':
      if (q.shadows === 'off') return null;
      n.shadows = 'off';
      n.shadowSize = 0;
      n.shadowEvery = 0;
      break;
    case 'grassHalf':
      if (q.grass <= TIERS.low.grass) return null;
      n.grass = Math.max(TIERS.low.grass, Math.round(q.grass / 2));
      break;
    case 'particlesHalf':
      if (q.particles <= TIERS.low.particles) return null;
      n.particles = Math.max(TIERS.low.particles, Math.round(q.particles / 2));
      break;
    case 'low': {
      if (q.tier === 'low') return null;
      const low = TIERS.low;
      Object.assign(n, {
        tier: 'low', dpr: Math.min(n.dpr, low.dpr), shadows: 'off', shadowSize: 0, shadowEvery: 0, post: false,
        grass: low.grass, particles: low.particles, critters: false, outlines: low.outlines, fps: low.fps,
        budget: { ...low.budget },
      });
      // the context's MSAA cannot be switched off at runtime: keep `antialias` as created
      break;
    }
    default:
      return null;
  }
  n.steps.push(step);
  return n;
}

/** The next applicable governor step after the ones already taken. → { quality, step } | null */
export function stepDown(q) {
  const taken = new Set(q?.steps || []);
  for (const step of STEPS) {
    if (taken.has(step)) continue;
    const n = applyStep(q, step);
    if (n) return { quality: n, step };
    taken.add(step);
  }
  return null;
}

/**
 * Rolling-mean frame-time governor. Feed it the period between RENDERED frames (ms) in continuous mode.
 * `sample()` → true when the 3 s mean exceeds 1.3 × budget (then it waits 5 s before judging again).
 * Periods over 100 ms (tab switches, GC stalls, a browser throttling an unfocused window) are ignored, and a
 * window only counts when the sampled frames cover ≥ 75% of it — throttled timers never lower the quality.
 */
export function createGovernor({ windowMs = GOVERNOR.windowMs, waitMs = GOVERNOR.waitMs, ratio = GOVERNOR.ratio, minSamples = GOVERNOR.minSamples } = {}) {
  let samples = []; // [t, ms]
  let sum = 0;
  let since = null; // when the current window started collecting
  let holdUntil = 0;
  let steps = 0;

  function reset(nowMs = 0) {
    samples = [];
    sum = 0;
    since = null;
    holdUntil = nowMs + waitMs;
  }

  function sample(frameMs, nowMs, budget = 1000 / 60) {
    const ms = Number(frameMs);
    if (nowMs < holdUntil) return false;
    if (since === null) since = nowMs;
    while (samples.length && samples[0][0] < nowMs - windowMs) sum -= samples.shift()[1];
    if (!Number.isFinite(ms) || ms <= 0 || ms > GOVERNOR.maxFrameMs) return false;
    samples.push([nowMs, ms]);
    sum += ms;
    if (nowMs - since < windowMs || samples.length < minSamples) return false;
    if (sum < GOVERNOR.minCoverage * windowMs) return false; // too many ignored frames: not a load signal
    const mean = sum / samples.length;
    if (mean > ratio * budget) {
      steps++;
      reset(nowMs);
      return true;
    }
    return false;
  }

  return {
    sample,
    reset,
    /** Mean of the current window (debug overlay). */
    mean: () => (samples.length ? sum / samples.length : 0),
    get steps() {
      return steps;
    },
  };
}

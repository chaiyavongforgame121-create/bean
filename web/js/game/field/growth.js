/**
 * field/growth.js — PURE mapping from a PlotView to 3D targets (GAME-DESIGN §3.2–§3.5).
 *
 * No three.js, no DOM: Node tests load it. The growth numbers themselves (size, health, fruit, flower, caption)
 * are NEVER computed here: they come from the PlotView, which `core/view.js` fills from `plant.js stage()`.
 * If a view arrives without them (an older/stub view), `growthOf()` calls the imported `stage()` on the same
 * numbers, so the formulas still live in exactly one place (§3.4 "imported, never re-implemented").
 *
 * What this file adds is only the *visual* mapping of §3.4/§3.5: droop, leaf tint, fruit colour, sway,
 * sacks, thermometer band colours, soil wetness, which props are visible.
 */

import { stage, GROWTH } from '../../plant.js';
import { TONE, hexRgb, rgbHex } from '../crops/catalog.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/** GLSL-style smoothstep (edges may be reversed: smoothstep(0.6, 0, h) rises as h falls). */
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ------------------------------------------------------------------ geometry constants (§2.3)

/** Planter box and field grid constants (u). */
export const PLOT = Object.freeze({
  footprint: 3.4, // outer box width/depth
  rim: 0.45, // rim height
  wall: 0.16, // wall thickness
  soilY: 0.36, // soil surface height inside the box
  pitch: 4.4,
  labelY: 2.6, // chip anchor height (§2.3)
  standZ: 2.3, // farmer stand point offset (§2.3)
  maxSlots: 15,
});

/** §2.3 slot position (fallback when the World does not provide `slotPosition`). → {x, y, z} */
export function gridPosition(i, count) {
  const n = clamp(Math.round(num(count, 10)), 1, PLOT.maxSlots);
  const rows = Math.ceil(n / 5);
  const r = Math.floor(i / 5);
  const c = i % 5;
  return { x: -8.8 + c * PLOT.pitch, y: 0, z: -(rows - 1) * 2.2 + r * PLOT.pitch };
}

// ------------------------------------------------------------------ growth (from the shared model)

/**
 * The stage() fields of a view. Uses the view's own numbers (core/view.js already ran stage() on the merged
 * bot); falls back to calling stage() itself on a bot rebuilt from the view's server numbers.
 * → { size, health, fruit, flower, seed, caption, frac, phase }
 */
export function growthOf(view) {
  if (!view) return null;
  if (Number.isFinite(view.size) && Number.isFinite(view.health)) {
    return {
      size: view.size,
      health: view.health,
      fruit: num(view.fruit),
      flower: !!view.flower,
      seed: !!view.seed,
      caption: view.caption ?? null,
      frac: num(view.frac),
      phase: view.phase ?? null,
    };
  }
  const s = stage(botOfView(view));
  return { size: s.size, health: s.health, fruit: s.fruit, flower: s.flower, seed: s.seed, caption: s.caption, frac: s.frac, phase: s.phase };
}

/** Minimal BotRow rebuilt from a PlotView, only so stage() can run on it. */
export function botOfView(view) {
  const state = view.state === 'paused' ? 'paused' : view.state === 'closed' ? 'closed' : 'active';
  return {
    state,
    last_error: view.error || null,
    bean_side: view.state === 'entering' ? 1 : 0,
    capital_usd: num(view.water),
    realized_pnl: num(view.realized),
    real: { szi: num(view.szi), unrealized_pnl: num(view.unrealized) },
  };
}

// ------------------------------------------------------------------ §3.4 visual mapping

/** Droop target: smoothstep(0.6, 0.0, health) · 0.7. */
export function droopOf(health) {
  return smoothstep(0.6, 0.0, num(health, 1)) * 0.7;
}

/**
 * Leaf colour for a health value, with plant.js healthTone()'s thresholds and colours:
 * lush (the crop's leaf hex) at ≥ 0.6, mixing toward sick #C4B048 down to 0.2, then toward dead #805E3C.
 * → [r, g, b] 0..255
 */
export function leafTone(health, lushHex) {
  const lush = hexRgb(lushHex);
  const sick = hexRgb(TONE.sick);
  const dead = hexRgb(TONE.dead);
  const h = clamp(num(health, 1), 0, 1);
  if (h >= 0.6) return lush;
  if (h >= 0.2) return mix(sick, lush, (h - 0.2) / 0.4);
  return mix(dead, sick, (h / 0.2) * 0.35);
}

/** Fruit ripeness 0..1: clamp((f − 2 %) / 3 %) with the thresholds taken from GROWTH. */
export function ripeness(frac) {
  return clamp((num(frac) - GROWTH.fruitMinFrac) / (GROWTH.ripeFrac - GROWTH.fruitMinFrac), 0, 1);
}

/** Fruit colour hex at ripeness k (unripe → ripe). */
export function fruitHex(crop, k) {
  return rgbHex(mix(hexRgb(crop.unripe), hexRgb(crop.ripe), clamp(k, 0, 1)));
}

/** Share of leaves kept: leaf i of N is shown while i < ceil(N·(0.4 + 0.6·health)). */
export function leafKeep(health) {
  return 0.4 + 0.6 * clamp(num(health, 1), 0, 1);
}
export function leafKeepCount(n, health) {
  return Math.ceil(n * leafKeep(health) - 1e-9);
}

/** Mirror of core/rules.js levTier(), used only when that module is unavailable. */
export function levTierLocal(lev) {
  const l = num(lev, 1);
  if (l <= 1) return 0;
  if (l <= 5) return 1;
  if (l <= 10) return 2;
  if (l <= 25) return 3;
  if (l <= 50) return 4;
  return 5;
}

/** Sway amplitude (rad) 0.04 + 0.025·log2(lev); shiver 0.004·log2(lev) at 7 Hz (§3.2). */
export function swayAmp(lev) {
  return 0.04 + 0.025 * Math.log2(Math.max(1, num(lev, 1)));
}
export function shiverAmp(lev) {
  return 0.004 * Math.log2(Math.max(1, num(lev, 1)));
}

// ------------------------------------------------------------------ colour channels (J6)

/** Side colours: blue/violet for LONG/SHORT, grey when flat; the colour-blind palette uses two greys (§7.4). */
export const SIDE_COLORS = Object.freeze({
  std: { up: '#2B6CB0', down: '#7B4FC4', flat: '#8A8F98' },
  cb: { up: '#D9D4C7', down: '#5A5550', flat: '#8A8F98' },
});

/** Thermometer band colours (never green/red, §3.2). */
export const BAND_COLORS = Object.freeze({ ok: '#7FA7B8', warn: '#E0A526', danger: '#E0A526' });

/** Soil palette (§9.10). */
export const SOIL = Object.freeze({ wet: '#7A4E35', dry: '#A7774F', charred: '#3B3330' });

/** Danger ring colour and the inverted-hull outline colour. */
export const RING = '#F59E0B';
export const OUTLINE = '#FFF6E0';

/** Arrow-sign cue: direction and paint for a side (1 long, −1 short, 0 flat). */
export function sideCue(side, palette = 'std') {
  const p = SIDE_COLORS[palette === 'cb' ? 'cb' : 'std'];
  const s = Math.sign(num(side));
  if (s > 0) return { dir: 'up', color: p.up, critter: 'bird' };
  if (s < 0) return { dir: 'down', color: p.down, critter: 'mole' };
  return { dir: 'flat', color: p.flat, critter: null };
}

/** Thermometer look from PlotView.liqInfo; null when there is no position (no thermometer). */
export function thermoOf(liqInfo, side) {
  if (!liqInfo || !num(side)) return null;
  const d = clamp(num(liqInfo.d, 1), 0, 1);
  const band = liqInfo.band === 'danger' || liqInfo.band === 'warn' || liqInfo.band === 'ok' ? liqInfo.band : d > 0.6 ? 'ok' : d > 0.3 ? 'warn' : 'danger';
  return { fill: d, band, color: BAND_COLORS[band], hazard: band === 'danger' };
}

// ------------------------------------------------------------------ §3.5 the whole look of one plot

/**
 * Everything the Plot actor needs to draw a view (§3.5), as plain data.
 * `view` may be null (empty slot). opts: { palette: 'std'|'cb', halted, pick, levTier }
 */
export function plotLook(view, opts = {}) {
  const palette = opts.palette === 'cb' ? 'cb' : 'std';
  const tierOf = typeof opts.levTier === 'function' ? opts.levTier : levTierLocal;
  const halted = !!(opts.halted || view?.halted);

  if (!view || view.state === 'closed') {
    return {
      empty: true,
      soil: halted ? 'charred' : 'dry',
      charStump: halted,
      pickGlow: !!opts.pick && !halted,
    };
  }

  const g = growthOf(view);
  const lev = Math.max(1, num(view.lev, 1));
  const paused = view.state === 'paused';
  const note = view.note ?? null;
  const liquidated = paused && note === 'liquidated';
  const busted = paused && note === 'bean busted';
  const side = Math.sign(num(view.side));
  const thermo = thermoOf(view.liqInfo, side);
  const danger = !!thermo && thermo.band === 'danger';
  const seed = !!g.seed;
  const caption = g.caption;
  const wilting = caption === 'wilting';
  const dying = caption === 'dying';
  const ripe = caption === 'ripe' || (!!view.ripe && !seed);
  const frozen = !!(view.frozen || view.stale);
  const tier = tierOf(lev);

  let soil = 'wet';
  if (halted) soil = 'charred';
  else if (paused) soil = 'dry';
  else if (danger || dying) soil = 'cracked';
  else if (wilting) soil = 'dryish';

  let swayMul = 1;
  if (wilting) swayMul = 0.6;
  if (dying) swayMul = 0.45;

  return {
    empty: false,
    botId: view.botId ?? null,
    coin: view.coin ?? null,
    family: ['standard', 'hyper', 'degen', 'swarm'].includes(view.family) ? view.family : 'standard',
    mode: seed ? 'seed' : 'crop',
    entering: view.state === 'entering' || g.phase === 'entering',
    crop: {
      size: g.size,
      health: g.health,
      droop: droopOf(g.health),
      fruit: seed ? 0 : g.fruit,
      ripe01: ripeness(g.frac),
      flowerOpen: !!g.flower && !seed,
      ripe,
      leafKeep: leafKeep(g.health),
      sat: paused ? 0.7 : 1,
      frost: danger ? 0.6 : 0,
      flatten: liquidated ? 0.15 : 1,
    },
    caption,
    wilting,
    dying,
    ripe,
    side,
    sign: sideCue(side, palette),
    lev,
    sacks: tier,
    hazardSacks: lev >= 25,
    sway: { amp: swayAmp(lev) * swayMul, shiver: shiverAmp(lev), jitter: view.family === 'degen' },
    thermo,
    danger,
    paused,
    parasol: paused,
    busted,
    liquidated,
    valveOpen: !paused && !halted,
    error: !!view.error,
    frozen,
    soil,
    basket: ripe && !paused,
    charStump: false,
    pickGlow: false,
  };
}

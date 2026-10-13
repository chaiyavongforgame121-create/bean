/**
 * gfx/palette.js — scene colour constants and sky keyframes (WP3).
 *
 * PURE DATA: no three import and no side effects, so it can be unit-tested under `node --test`
 * (test/game-world.test.js). Every colour is an sRGB hex number (0xRRGGBB); three's Color converts
 * to the linear working space when the world builds materials.
 *
 * Colour-channel rule (GAME-DESIGN §1.3 J6): green/red belong to MONEY, blue/violet to SIDE and amber to
 * RISK. Scenery therefore avoids saturated red/green signals: grass greens are soft and yellowish,
 * barn red is a dusty terracotta, and the only amber in the world is a warning (mailbox flag).
 */

/** Scene palette (§9.10 "Scene palette" plus the supporting tones the landmarks need). */
export const PAL = Object.freeze({
  // ground
  grass: 0xa8d88e,
  grassDk: 0x84c17a,
  grassTip: 0xd2e89a,
  grassWarm: 0xbcd98a,
  meadow: 0x9fd08a,
  path: 0xf0ddb8,
  pathEdge: 0xd9c49b,
  pebble: 0xc9b79a,
  soilWet: 0x7a4e35,
  soilDry: 0xa7774f,
  soilChar: 0x3b3330,
  mud: 0x8a6a4c,
  sand: 0xe8d5a8,
  // island underside
  rockA: 0xc9b8a6,
  rockB: 0xa8968a,
  rockC: 0x8f7f75,
  rockDk: 0x76665e,
  cliffSoil: 0x9a7556,
  // water
  water: 0x8fd3e8,
  waterDeep: 0x5fb3cf,
  waterFoam: 0xe6f7fb,
  // buildings
  barn: 0xd97a6c,
  barnDk: 0xb85f55,
  roof: 0x7c8fb8,
  roofDk: 0x62749c,
  trim: 0xfff4e2,
  plaster: 0xf3ead9,
  stone: 0xb9b2a6,
  stoneDk: 0x958d82,
  metal: 0x9aa5ad,
  metalDk: 0x6f7a83,
  // wood
  wood: 0xc98a4b,
  woodLt: 0xdcaa6d,
  woodDk: 0x6b4423,
  woodMid: 0x9c6a3c,
  straw: 0xe9c873,
  strawDk: 0xc9a456,
  canvas: 0xf6efe0,
  // accents (decor only; never a money/side signal)
  butter: 0xf2d47a,
  cream: 0xfff6e0,
  peach: 0xf1b38a,
  lavender: 0xc7b6e6,
  teal: 0x6fb7b0,
  mustard: 0xd8a945,
  plum: 0x8e6a9e,
  // signals
  warnAmber: 0xe0a526,   // risk/warning (mailbox flag, cap tag outline)
  capTag: 0xc9483f,      // §1.5 "red cap tag on the tower valve" (spec'd red)
  ember: 0xff9a3c,
  flame: 0xffc75a,
  ash: 0x6d6560,
  // modes (mirrors the CSS tokens of §9.10 for the signpost board)
  real: 0x1d6b5a,
  sim: 0x6b4fa0,
  off: 0x5f6368,
  delayed: 0xf2c14e,
  // critters / farmer
  bluebird: 0x5b8fd6,
  bluebirdBelly: 0xf4e3c3,
  mole: 0x6b5a50,
  moleNose: 0xf2a7a0,
  skin: 0xf1c7a0,
  shirt: 0x7fa6c9,
  overalls: 0x5d7fa8,
  boots: 0x5a4434,
  hat: 0xe9c873,
  // foliage for rim trees / bushes
  leafA: 0x6fb36a,
  leafB: 0x89c46f,
  leafC: 0x5a9e62,
  bark: 0x8a5e3b,
  blossom: 0xf6c9d8,
  // clouds
  cloud: 0xffffff,
  cloudShade: 0xdfe8f2,
});

/** Crop shading tones used by plant.js healthTone() (§3.4): sick yellow and dead brown. */
export const CROP_TONES = Object.freeze({ sick: 0xc4b048, dead: 0x805e3c });

/** Light rig (§9.8). Intensities are tuned for three r169's physically-based light units (see world/sky.js). */
export const LIGHTS = Object.freeze({
  hemiSky: 0xdff1ff,
  hemiGround: 0xe9d9c0,
  hemi: 0.9,
  sun: 0xfff1dc,
  sunI: 1.6,
  fill: 0xbfd6ff,       // cool back fill (no shadows)
  fillI: 0.35,
  moon: 0xb8c8ff,
  moonHemiMin: 0.35,    // §9.8: clock-night keeps at least 0.35 hemisphere
});

/**
 * Market weather (§4.4): sky gradient, cloud count, rain gain and the light multiplier.
 * `top`/`horizon` are the daytime sky colours (§9.10); `light` multiplies sun + hemisphere.
 */
export const WEATHER = Object.freeze({
  // `below` is what the default camera mostly sees behind the island (it looks down 52°): a soft sky blue
  // under a warm horizon haze, so the warm island reads clearly against a cool sky.
  sunny: Object.freeze({ top: 0x9ed3ee, horizon: 0xffe6cf, below: 0xa9d6ec, clouds: 8, rain: 0, light: 1, cool: 0, cloudTint: 0xffffff }),
  mild: Object.freeze({ top: 0xa6cbe2, horizon: 0xf6e5d6, below: 0xb2cfdf, clouds: 16, rain: 0, light: 0.92, cool: 0.15, cloudTint: 0xf7f9fb }),
  rainy: Object.freeze({ top: 0x8fa3b8, horizon: 0xc9cfd6, below: 0x9cabba, clouds: 26, rain: 0.6, light: 0.75, cool: 0.5, cloudTint: 0xd9dfe6 }),
  storm: Object.freeze({ top: 0x5e6b80, horizon: 0x9aa3af, below: 0x67748a, clouds: 34, rain: 1, light: 0.55, cool: 0.8, cloudTint: 0xb3bac4 }),
});

export const WEATHER_KEYS = Object.freeze(['sunny', 'mild', 'rainy', 'storm']);

/**
 * Day keyframes for *Sky = Follow my clock* (§6.9). `h` is the local hour (0..24).
 * `sunEl` is the sun elevation in degrees (negative = below the horizon → moonlight),
 * `sky` multiplies the weather gradient, `tint` is mixed into it by `tintK`, `night` 0..1 drives stars.
 * *Always day* uses DAY_FIXED (a pale late-morning sky, §1.1).
 */
export const DAY_KEYS = Object.freeze([
  Object.freeze({ h: 0, sunEl: -30, light: 0.32, sky: 0.28, tint: 0x1b2a4a, tintK: 0.75, night: 1 }),
  Object.freeze({ h: 4.5, sunEl: -12, light: 0.34, sky: 0.32, tint: 0x24365c, tintK: 0.7, night: 0.9 }),
  Object.freeze({ h: 6, sunEl: 4, light: 0.62, sky: 0.8, tint: 0xffb38a, tintK: 0.45, night: 0.15 }),
  Object.freeze({ h: 7.5, sunEl: 20, light: 0.9, sky: 0.96, tint: 0xffd9b8, tintK: 0.2, night: 0 }),
  Object.freeze({ h: 12, sunEl: 58, light: 1, sky: 1, tint: 0xffffff, tintK: 0, night: 0 }),
  Object.freeze({ h: 16.5, sunEl: 30, light: 0.97, sky: 1, tint: 0xfff0d8, tintK: 0.1, night: 0 }),
  Object.freeze({ h: 18.5, sunEl: 6, light: 0.7, sky: 0.85, tint: 0xff9e7a, tintK: 0.5, night: 0.1 }),
  Object.freeze({ h: 20, sunEl: -8, light: 0.38, sky: 0.42, tint: 0x3a3f6e, tintK: 0.65, night: 0.75 }),
  Object.freeze({ h: 24, sunEl: -30, light: 0.32, sky: 0.28, tint: 0x1b2a4a, tintK: 0.75, night: 1 }),
]);

/** The fixed "always day" look: a pale late-morning sun from the south-west. */
export const DAY_FIXED = Object.freeze({ h: 10.5, sunEl: 42, light: 1, sky: 1, tint: 0xffffff, tintK: 0, night: 0 });

// ------------------------------------------------------------------ tiny colour maths (pure)

/** 0xRRGGBB → [r, g, b] in 0..1 (sRGB, not linearised). */
export function hexToRgb01(hex) {
  const h = Number(hex) >>> 0;
  return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
}

/** [r, g, b] 0..1 → 0xRRGGBB (clamped, rounded). */
export function rgb01ToHex(c) {
  const q = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (q(c[0]) << 16) | (q(c[1]) << 8) | q(c[2]);
}

/** Mix two hex colours in sRGB space (k = 0 → a, 1 → b). */
export function mixHex(a, b, k) {
  const A = hexToRgb01(a);
  const B = hexToRgb01(b);
  const t = Math.max(0, Math.min(1, Number(k) || 0));
  return rgb01ToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

/** Multiply a hex colour's channels by s (brightness), clamped. */
export function scaleHex(a, s) {
  const A = hexToRgb01(a);
  return rgb01ToHex([A[0] * s, A[1] * s, A[2] * s]);
}

/** Relative luminance (sRGB → linear, Rec. 709) of a hex colour; used to bound the lightning flash. */
export function luminance(hex) {
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = hexToRgb01(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Interpolated day keyframe for an hour of the day (0..24, wraps). Returns a plain object with the same
 * fields as DAY_KEYS; colours are mixed in sRGB.
 */
export function dayKeyAt(hour) {
  let h = Number(hour);
  if (!Number.isFinite(h)) h = DAY_FIXED.h;
  h = ((h % 24) + 24) % 24;
  let i = 0;
  while (i < DAY_KEYS.length - 2 && DAY_KEYS[i + 1].h <= h) i++;
  const a = DAY_KEYS[i];
  const b = DAY_KEYS[i + 1];
  const k = b.h > a.h ? (h - a.h) / (b.h - a.h) : 0;
  const L = (x, y) => x + (y - x) * k;
  return {
    h,
    sunEl: L(a.sunEl, b.sunEl),
    light: L(a.light, b.light),
    sky: L(a.sky, b.sky),
    tint: mixHex(a.tint, b.tint, k),
    tintK: L(a.tintK, b.tintK),
    night: L(a.night, b.night),
  };
}

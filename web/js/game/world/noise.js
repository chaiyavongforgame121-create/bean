/**
 * world/noise.js — PURE deterministic noise + PRNG (WP3). No three, no DOM, no side effects beyond building
 * one fixed permutation table at import (pure computation).
 *
 * gfx/geom.js re-exports these (contract name `noise2`), and world/terrain.js uses them directly so the
 * terrain height/colour functions stay testable under `node --test`.
 */

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;

/** GLSL-style smoothstep (edges may be reversed). */
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Deterministic PRNG (mulberry32). `rng(seed)()` → [0, 1). */
export function rng(seed = 1) {
  let a = (Number(seed) * 2654435761) >>> 0 || 1;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap stable hash of two numbers → [0, 1) (per-vertex / per-instance jitter without state). */
export function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

// ------------------------------------------------------------------ Perlin "improved" noise, fixed table

const PERM = (() => {
  const r = rng(1337);
  const a = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = a[i & 255];
  return p;
})();
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function grad2(h, x, y) {
  switch (h & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
}

/** 2D gradient noise, deterministic, roughly in [-1, 1] (0 at integer lattice points). */
export function noise2(x, y) {
  const X = Math.floor(x);
  const Y = Math.floor(y);
  const xf = x - X;
  const yf = y - Y;
  const xi = X & 255;
  const yi = Y & 255;
  const u = fade(xf);
  const v = fade(yf);
  const aa = PERM[PERM[xi] + yi];
  const ab = PERM[PERM[xi] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi];
  const bb = PERM[PERM[xi + 1] + yi + 1];
  const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
  const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
  return clamp(lerp(x1, x2, v), -1, 1);
}

function grad3(h, x, y, z) {
  const k = h & 15;
  const u = k < 8 ? x : y;
  const v = k < 4 ? y : k === 12 || k === 14 ? x : z;
  return ((k & 1) === 0 ? u : -u) + ((k & 2) === 0 ? v : -v);
}

/** 3D gradient noise (Perlin improved), roughly in [-1, 1]. */
export function noise3(x, y, z) {
  const X = Math.floor(x);
  const Y = Math.floor(y);
  const Z = Math.floor(z);
  x -= X; y -= Y; z -= Z;
  const xi = X & 255;
  const yi = Y & 255;
  const zi = Z & 255;
  const u = fade(x);
  const v = fade(y);
  const w = fade(z);
  const A = PERM[xi] + yi;
  const AA = PERM[A] + zi;
  const AB = PERM[A + 1] + zi;
  const B = PERM[xi + 1] + yi;
  const BA = PERM[B] + zi;
  const BB = PERM[B + 1] + zi;
  return clamp(
    lerp(
      lerp(lerp(grad3(PERM[AA], x, y, z), grad3(PERM[BA], x - 1, y, z), u),
        lerp(grad3(PERM[AB], x, y - 1, z), grad3(PERM[BB], x - 1, y - 1, z), u), v),
      lerp(lerp(grad3(PERM[AA + 1], x, y, z - 1), grad3(PERM[BA + 1], x - 1, y, z - 1), u),
        lerp(grad3(PERM[AB + 1], x, y - 1, z - 1), grad3(PERM[BB + 1], x - 1, y - 1, z - 1), u), v),
      w,
    ),
    -1,
    1,
  );
}

/** Fractal 2D noise (octaves of noise2), normalised to roughly [-1, 1]. */
export function fbm2(x, y, octaves = 3, lacunarity = 2, gain = 0.5) {
  let amp = 1;
  let f = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * f + i * 17.3, y * f - i * 9.1);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

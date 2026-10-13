/**
 * world/terrain.js — PURE terrain maths for the floating island (WP3; GAME-DESIGN §2.1–§2.4, §9.10).
 * No three, no DOM, no side effects at import: Node tests load it (test/game-world.test.js).
 *
 *   rimRadius(theta)        island top edge radius (21 u ± 0.6 rim noise)
 *   heightAt(x, z)          ground height (flat field/paths/landmarks, soft mounds, pond bowl, rim lip)
 *   pathNetwork(count)      gravel ring around the field (depends on slot count) + spurs to every landmark
 *   pathInfo(x, z, net)     { d, w } distance to the nearest path centre-line and that path's width
 *   groundColor(x, z, net)  [r, g, b] sRGB 0..1 for the terrain vertex colour
 *   grassDensity(x, z, net) 0..1 tuft density (0 on paths, pond, field, landmark footprints)
 *   POND, MOUNDS, FOOTPRINTS, WEAR, ringRect(count)
 *
 * Coordinates: +X east, +Y up, +Z south (toward the default camera). The island top is y ≈ 0.
 */
import { GRID, ISLAND, LANDMARKS, RING_OFFSET, fieldBounds } from './logic.js';
import { PAL, hexToRgb01 } from '../gfx/palette.js';
import { clamp, fbm2, hash2, lerp, noise2, smoothstep } from './noise.js';

// ------------------------------------------------------------------ island outline

/** Top-edge radius at polar angle theta (radians, atan2(z, x)). Periodic noise on a circle: ±0.6 u. */
export function rimRadius(theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const n = 0.65 * noise2(c * 1.9 + 4.2, s * 1.9 - 2.7) + 0.35 * noise2(c * 4.3 - 1.1, s * 4.3 + 6.4);
  return ISLAND.radius + ISLAND.rimNoise * clamp(n * 2.3, -1, 1);
}

// ------------------------------------------------------------------ fixed features

/** Pond basin (§2.4: centre (15, 3), r 3.2). `depth` is the bowl depth below y = 0 at the centre. */
export const POND = Object.freeze({ x: LANDMARKS.pond.x, z: LANDMARKS.pond.z, r: LANDMARKS.pond.r, bank: 4.4, depth: 0.95 });

/** Water surface height for a fill 0..1 (empty pond still shows a puddle; full is just under the bank). */
export function pondWaterY(fill) {
  return lerp(-0.62, -0.1, clamp(Number(fill) || 0, 0, 1));
}

/** Pond bowl profile: height at distance d from the pond centre (≤ 0 inside the bank). */
export function pondBowl(d) {
  if (d >= POND.bank) return 0;
  const t = clamp(d / POND.r, 0, 1.4);
  if (d <= POND.r) return -POND.depth * Math.pow(1 - t * t, 0.9) - 0.08;
  // bank: from −0.08 at r up to 0 at bank (a tiny raised lip around 3.8 u)
  const k = (d - POND.r) / (POND.bank - POND.r);
  return -0.08 * (1 - smoothstep(0, 0.55, k)) + 0.06 * Math.sin(Math.PI * clamp(k, 0, 1)) * (1 - k);
}

/** Distance from the pond centre at which the bowl reaches height y (for the water's shore radius). */
export function pondShoreRadius(y) {
  let lo = 0;
  let hi = POND.r;
  if (pondBowl(0) >= y) return 0;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (pondBowl(mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The little stream from the pond's east bank over the rim (P2 waterfall, §2.4 "Decor"). */
export const STREAM = Object.freeze([[18.0, 3.55], [19.0, 3.85], [20.0, 4.06], [20.8, 4.2]].map((p) => Object.freeze(p)));

/** Distance from (x, z) to the stream centre-line. */
export function streamDist(x, z) {
  let best = Infinity;
  for (let i = 1; i < STREAM.length; i++) {
    const [ax, az] = STREAM[i - 1];
    const [bx, bz] = STREAM[i];
    best = Math.min(best, segDist(x, z, ax, az, bx, bz));
  }
  return best;
}

/** Soft mounds in the open meadow (x, z, radius, height). Kept clear of paths and landmarks. */
export const MOUNDS = Object.freeze([
  Object.freeze({ x: -17.2, z: 12.4, r: 3.6, h: 0.75 }),
  Object.freeze({ x: 16.4, z: 11.6, r: 3.4, h: 0.6 }),
  Object.freeze({ x: -18.4, z: -6.8, r: 2.8, h: 0.55 }),
  Object.freeze({ x: 10.2, z: -17.0, r: 3.2, h: 0.85 }),
  Object.freeze({ x: -5.6, z: -17.8, r: 3.0, h: 0.7 }),
  Object.freeze({ x: 18.6, z: -3.8, r: 2.2, h: 0.4 }),
  Object.freeze({ x: -11.5, z: 16.8, r: 2.6, h: 0.45 }),
]);

/** Landmark footprints kept perfectly flat (x, z, radius). */
export const FOOTPRINTS = Object.freeze([
  { id: 'stall', x: LANDMARKS.stall.x, z: LANDMARKS.stall.z, r: 2.6 },
  { id: 'barn', x: LANDMARKS.barn.x, z: LANDMARKS.barn.z, r: 4.4 },
  { id: 'silo', x: LANDMARKS.silo.x, z: LANDMARKS.silo.z, r: 1.9 },
  { id: 'crates', x: LANDMARKS.crates.x, z: LANDMARKS.crates.z, r: 1.6 },
  { id: 'compost', x: LANDMARKS.compost.x, z: LANDMARKS.compost.z, r: 1.8 },
  { id: 'tower', x: LANDMARKS.tower.x, z: LANDMARKS.tower.z, r: 2.2 },
  { id: 'pump', x: LANDMARKS.pond.pumpX, z: LANDMARKS.pond.pumpZ, r: 1.0 },
  { id: 'windmill', x: LANDMARKS.windmill.x, z: LANDMARKS.windmill.z, r: 2.7 },
  { id: 'sundial', x: LANDMARKS.sundial.x, z: LANDMARKS.sundial.z, r: 1.2 },
  { id: 'board', x: LANDMARKS.board.x, z: LANDMARKS.board.z, r: 1.8 },
  { id: 'mailbox', x: LANDMARKS.mailbox.x, z: LANDMARKS.mailbox.z, r: 0.9 },
  { id: 'firepit', x: LANDMARKS.firepit.x, z: LANDMARKS.firepit.z, r: 2.4 },
  { id: 'pip', x: LANDMARKS.pip.x, z: LANDMARKS.pip.z, r: 1.0 },
  { id: 'signpost', x: LANDMARKS.signpost.x, z: LANDMARKS.signpost.z, r: 2.6 },
].map(Object.freeze));

/** Worn-earth patches in front of doors, counters and benches (x, z, r). */
export const WEAR = Object.freeze([
  [0, -10.1, 2.0], [-14.5, 0, 1.5], [-4.5, -10.4, 1.4], [5.5, -10.3, 1.5], [8, 12.5, 2.5], [0, 14.4, 1.3],
  [13, 0.7, 1.1], [-14.3, 7.5, 1.0], [-11.3, -9.0, 1.3], [13, -8, 1.9], [-8, -13.2, 1.1], [-6.6, 11.7, 0.8],
].map((a) => Object.freeze({ x: a[0], z: a[1], r: a[2] })));

// ------------------------------------------------------------------ paths

/** The gravel ring rectangle around the field for a slot count (§2.2): field bounds + 1.6 u. */
export function ringRect(count) {
  const b = fieldBounds(count);
  return { x0: b.x0 - RING_OFFSET, x1: b.x1 + RING_OFFSET, z0: b.z0 - RING_OFFSET, z1: b.z1 + RING_OFFSET, rows: b.rows };
}

/** Catmull-Rom resample of a control polyline [[x, z], …] → points every ~step u (endpoints kept). */
export function smoothLine(ctrl, step = 0.6) {
  if (ctrl.length < 3) return ctrl.map((p) => [p[0], p[1]]);
  const out = [];
  const P = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[i + 2];
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push([ctrl[ctrl.length - 1][0], ctrl[ctrl.length - 1][1]]);
  return out;
}

/** Rounded-rectangle loop (closed: last point = first) with corner radius rc. */
function roundedRect(x0, x1, z0, z1, rc, step = 0.6) {
  const pts = [];
  const arc = (cx, cz, a0) => {
    const n = 5;
    for (let i = 0; i <= n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * rc, cz + Math.sin(a) * rc]);
    }
  };
  const edge = (ax, az, bx, bz) => {
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(L / step));
    for (let i = 1; i < n; i++) pts.push([ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n]);
  };
  arc(x1 - rc, z1 - rc, 0); // SE corner, going +z → +x … (angles 0 → 90°: east → south)
  edge(x1 - rc, z1, x0 + rc, z1);
  arc(x0 + rc, z1 - rc, Math.PI / 2); // SW
  edge(x0, z1 - rc, x0, z0 + rc);
  arc(x0 + rc, z0 + rc, Math.PI); // NW
  edge(x0 + rc, z0, x1 - rc, z0);
  arc(x1 - rc, z0 + rc, (3 * Math.PI) / 2); // NE
  edge(x1, z0 + rc, x1, z1 - rc);
  pts.push([pts[0][0], pts[0][1]]);
  return pts;
}

/**
 * Path network for a slot count: the gravel ring (w 1.35) plus spurs (w 0.95–1.3) to the barn, windmill,
 * sundial, stall, market board, signpost, mailbox, fire pit, pump and water tower.
 * → [{ id, pts: [[x, z], …], w, ring?: true }]
 */
export function pathNetwork(count = GRID.minSlots) {
  const R = ringRect(count);
  const { x0, x1, z0, z1 } = R;
  const lines = [
    { id: 'ring', pts: roundedRect(x0, x1, z0, z1, 1.4), w: 1.35, ring: true },
    { id: 'barn', pts: smoothLine([[0, z0], [0.1, -8.6], [0, -10.4]]), w: 1.3 },
    { id: 'sundial', pts: smoothLine([[0, -8.3], [-3.2, -8.1], [-6.4, -9.5], [-7.8, -12.4]]), w: 0.95 },
    { id: 'windmill', pts: smoothLine([[-10.8, z0], [-11.5, Math.min(z0 - 1.2, -7.4)], [-11.35, -8.9]]), w: 1.05 },
    { id: 'stall', pts: smoothLine([[x0, 0.2], [-13.4, 0.05], [-14.6, 0]]), w: 1.25 },
    { id: 'board', pts: smoothLine([[x0 + 0.4, z1 - 0.4], [-13.3, Math.max(z1 + 0.6, 6.7)], [-14.2, 7.5]]), w: 0.95 },
    { id: 'south', pts: smoothLine([[0, z1], [0.15, Math.max(z1 + 2.6, 9.4)], [0, 14.3]]), w: 1.3 },
    { id: 'mailbox', pts: smoothLine([[0, Math.max(z1 + 3.4, 9.8)], [-3.4, 11.1], [-6.2, 11.65]]), w: 0.95 },
    { id: 'firepit', pts: smoothLine([[0, Math.max(z1 + 3.4, 9.8)], [3.6, 11.3], [6.4, 12.0]]), w: 0.95 },
    { id: 'pump', pts: [[x1, 0.6], [12.9, 0.6]], w: 1.0 },
    { id: 'tower', pts: smoothLine([[x1 - 0.5, z0], [12.4, z0 - 0.7], [12.7, -6.9]]), w: 1.0 },
  ];
  for (const l of lines) {
    let bx0 = Infinity;
    let bx1 = -Infinity;
    let bz0 = Infinity;
    let bz1 = -Infinity;
    for (const [x, z] of l.pts) {
      bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z);
    }
    l.box = [bx0, bx1, bz0, bz1];
  }
  return lines;
}

/** Distance from (x, z) to segment a-b. */
function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const L2 = dx * dx + dz * dz || 1e-9;
  const t = clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1);
  return Math.hypot(x - (ax + t * dx), z - (az + t * dz));
}

/**
 * Nearest path: { d, w, id, edge } where `edge` = d − w/2 (≤ 0 means on the gravel).
 * Pass a precomputed `net` (pathNetwork(count)) for speed: segments are pre-baked per line (origin, direction,
 * 1/|d|²) and whole lines are skipped by their bounding box, so a query costs ~1 µs.
 */
export function pathInfo(x, z, net) {
  let bestEdge = Infinity;
  let bestD = Infinity;
  let bestW = 1;
  let bestId = null;
  for (const line of net) {
    const hw = line.w / 2;
    const b = line.box;
    if (b) {
      const lim = bestEdge + hw;
      if (lim < 0) continue;
      const bx = Math.max(b[0] - x, 0, x - b[1]);
      const bz = Math.max(b[2] - z, 0, z - b[3]);
      if (lim !== Infinity && bx * bx + bz * bz > lim * lim) continue;
    }
    const sg = line.seg || bakeSegments(line);
    let min2 = Infinity;
    for (let i = 0; i < sg.length; i += 5) {
      const ax = sg[i];
      const az = sg[i + 1];
      const dx = sg[i + 2];
      const dz = sg[i + 3];
      let t = ((x - ax) * dx + (z - az) * dz) * sg[i + 4];
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - (ax + t * dx);
      const ez = z - (az + t * dz);
      const d2 = ex * ex + ez * ez;
      if (d2 < min2) min2 = d2;
    }
    const d = Math.sqrt(min2);
    const e = d - hw;
    if (e < bestEdge) {
      bestEdge = e;
      bestD = d;
      bestW = line.w;
      bestId = line.id;
    }
  }
  return { d: bestD, w: bestW, id: bestId, edge: bestEdge };
}

/** Pre-bake a line's segments as [ax, az, dx, dz, 1/|d|²]… (cached on the line). */
function bakeSegments(line) {
  const p = line.pts;
  const sg = new Float64Array(Math.max(0, p.length - 1) * 5);
  for (let i = 1; i < p.length; i++) {
    const dx = p[i][0] - p[i - 1][0];
    const dz = p[i][1] - p[i - 1][1];
    const o = (i - 1) * 5;
    sg[o] = p[i - 1][0];
    sg[o + 1] = p[i - 1][1];
    sg[o + 2] = dx;
    sg[o + 3] = dz;
    sg[o + 4] = 1 / (dx * dx + dz * dz || 1e-9);
  }
  line.seg = sg;
  return sg;
}

// ------------------------------------------------------------------ height

/** The 15-slot ring (the largest field) — the flat zone never depends on the current slot count. */
const FLAT_NET = pathNetwork(GRID.maxSlots);
const FLAT_RING = ringRect(GRID.maxSlots);

function bump(t) {
  return t >= 1 ? 0 : (1 - t * t) * (1 - t * t);
}

/** 1 where the ground may undulate, 0 on the field, paths (largest network) and landmark footprints. */
export function freeMask(x, z) {
  const R = FLAT_RING;
  const dx = Math.max(R.x0 - 1.2 - x, 0, x - R.x1 - 1.2);
  const dz = Math.max(R.z0 - 1.2 - z, 0, z - R.z1 - 1.2);
  let m = smoothstep(0, 2.2, Math.hypot(dx, dz));
  if (m <= 0) return 0;
  for (const f of FOOTPRINTS) {
    const d = Math.hypot(x - f.x, z - f.z);
    m = Math.min(m, smoothstep(f.r, f.r + 1.6, d));
    if (m <= 0) return 0;
  }
  const p = pathInfo(x, z, FLAT_NET);
  m = Math.min(m, smoothstep(0.2, 1.8, p.edge));
  return m;
}

/**
 * Ground height at (x, z). 0 on the field, paths and footprints; soft mounds and micro-relief in the
 * meadow; the pond bowl; and a gentle 0.3 u lip falling toward the rim. Outside the rim the height keeps
 * falling (callers clamp to the rim).
 */
export function heightAt(x, z) {
  const free = freeMask(x, z);
  let h = 0;
  if (free > 0) {
    let m = 0;
    for (const b of MOUNDS) m += b.h * bump(Math.hypot(x - b.x, z - b.z) / b.r);
    h += free * (m + 0.14 * fbm2(x * 0.16 + 3.1, z * 0.16 - 1.7, 2));
  }
  const r = Math.hypot(x, z);
  const R = rimRadius(Math.atan2(z, x));
  const lip = smoothstep(R - 1.6, R, r);
  h -= 0.34 * lip * lip;
  const dp = Math.hypot(x - POND.x, z - POND.z);
  if (dp < POND.bank) {
    const k = smoothstep(POND.bank, POND.r, dp);
    // the bank lip never reaches the field walkway west of the pond (the field stays exactly flat)
    const bankMask = dp <= POND.r ? 1 : smoothstep(FLAT_RING.x1 - 1.0, FLAT_RING.x1 - 0.2, x);
    h = lerp(h, 0, k) + pondBowl(dp) * bankMask;
  }
  return h;
}

// ------------------------------------------------------------------ colour

const C = Object.fromEntries(
  ['grass', 'grassDk', 'grassWarm', 'grassTip', 'meadow', 'path', 'pathEdge', 'pebble', 'sand', 'mud', 'soilDry', 'cliffSoil']
    .map((k) => [k, hexToRgb01(PAL[k])]),
);
const mix3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/**
 * Terrain vertex colour (sRGB 0..1) at (x, z) for a path network. Also returns how much of it is gravel
 * via `out.path` when an `out` object is passed (used to skip grass).
 */
export function groundColor(x, z, net, out = null) {
  // meadow: large soft patches between the two grass tones, sun-warm drifts, tiny jitter
  const n1 = fbm2(x * 0.085 + 11.3, z * 0.085 - 4.1, 3);
  let c = mix3(C.grassDk, C.grass, clamp(0.55 + 0.75 * n1, 0, 1));
  const warm = smoothstep(0.2, 0.62, fbm2(x * 0.05 - 7.7, z * 0.05 + 2.9, 2));
  c = mix3(c, C.grassWarm, warm * 0.55);
  const j = (hash2(x * 3.1, z * 2.7) - 0.5) * 0.045;
  c = [c[0] + j, c[1] + j * 1.1, c[2] + j * 0.6];

  // the field lawn inside the ring: mown stripes (subtle, every 2.2 u along x)
  const R = net && net.rect;
  if (R && x > R.x0 && x < R.x1 && z > R.z0 && z < R.z1) {
    const stripe = Math.floor((x + 0.0) / 2.2) & 1;
    const k = stripe ? 1.03 : 0.97;
    c = [c[0] * k, c[1] * k, c[2] * k];
  }

  // sun-bleached rim
  const r = Math.hypot(x, z);
  const Rr = rimRadius(Math.atan2(z, x));
  const rim = smoothstep(Rr - 2.6, Rr, r);
  c = mix3(c, C.grassWarm, rim * 0.45);

  // worn earth in front of doors and counters
  let wear = 0;
  for (const w of WEAR) wear = Math.max(wear, smoothstep(w.r, w.r * 0.45, Math.hypot(x - w.x, z - w.z)));
  const edgeTone = mix3(C.pathEdge, C.grassWarm, 0.35);
  if (wear > 0) c = mix3(c, mix3(edgeTone, C.path, 0.6), wear * 0.85);

  // gravel paths: soft shoulder, then the path tone with pebble speckle
  let pathK = 0;
  if (net) {
    const p = pathInfo(x, z, net.lines || net);
    const shoulder = smoothstep(0.55, 0.0, p.edge); // grass darkens/browns just outside the gravel
    const on = smoothstep(0.12, -0.18, p.edge);
    pathK = on;
    if (shoulder > 0) c = mix3(c, edgeTone, shoulder * 0.55);
    if (on > 0) {
      const speck = hash2(x * 7.3 + 1.1, z * 6.1 - 3.3);
      const g = speck > 0.82 ? C.pebble : speck < 0.12 ? C.pathEdge : C.path;
      const centre = smoothstep(p.w * 0.5, 0, p.d);
      c = mix3(c, mix3(C.pathEdge, g, 0.55 + 0.45 * centre), on);
    }
  }

  // the stream's wet, sandy banks
  const sd = streamDist(x, z);
  if (sd < 1.0) c = mix3(c, mix3(C.sand, C.mud, smoothstep(0.9, 0.2, sd)), smoothstep(1.0, 0.35, sd) * 0.85);

  // pond: sandy bank → mud under water
  const dp = Math.hypot(x - POND.x, z - POND.z);
  if (dp < POND.bank + 0.4) {
    const bank = smoothstep(POND.bank + 0.4, POND.r + 0.2, dp);
    c = mix3(c, C.sand, bank * 0.9);
    const under = smoothstep(POND.r + 0.1, POND.r - 1.2, dp);
    c = mix3(c, C.mud, under);
  }
  if (out) out.path = Math.max(pathK, wear * 0.8);
  return [clamp(c[0], 0, 1), clamp(c[1], 0, 1), clamp(c[2], 0, 1)];
}

/** Bundle a path network with its ring rect (what groundColor/grassDensity want). */
export function pathSet(count = GRID.minSlots) {
  return { count, lines: pathNetwork(count), rect: ringRect(count) };
}

/**
 * Grass tuft density 0..1 at (x, z). Zero on paths, the pond, the field lawn, landmark footprints and past
 * the rim; boosted along path shoulders, fence lines and around landmark bases (the cosy "edge" look).
 */
export function grassDensity(x, z, set) {
  const r = Math.hypot(x, z);
  const R = rimRadius(Math.atan2(z, x));
  if (r > R - 0.5) return 0;
  const rect = set.rect;
  if (x > rect.x0 - 0.4 && x < rect.x1 + 0.4 && z > rect.z0 - 0.4 && z < rect.z1 + 0.4) {
    // inside the ring: only a few tufts at the lawn edge (never between the boxes)
    const fb = fieldBounds(set.count);
    const inField = x > fb.x0 - 0.6 && x < fb.x1 + 0.6 && z > fb.z0 - 0.6 && z < fb.z1 + 0.6;
    if (inField) return 0;
  }
  const p = pathInfo(x, z, set.lines);
  if (p.edge < 0.12) return 0;
  const dp = Math.hypot(x - POND.x, z - POND.z);
  if (dp < POND.r + 0.25) return 0;
  if (streamDist(x, z) < 0.55) return 0;
  let fp = 1;
  let base = 0;
  for (const f of FOOTPRINTS) {
    const d = Math.hypot(x - f.x, z - f.z);
    const core = f.id === 'pip' || f.id === 'mailbox' || f.id === 'sundial' ? f.r * 0.55 : f.r * 0.85;
    if (d < core) return 0;
    fp = Math.min(fp, smoothstep(core, core + 0.5, d));
    base = Math.max(base, smoothstep(core + 1.6, core + 0.3, d));
  }
  for (const w of WEAR) if (Math.hypot(x - w.x, z - w.z) < w.r * 0.7) return 0;
  const shoulder = smoothstep(1.3, 0.25, p.edge);
  const pondEdge = smoothstep(POND.bank + 0.8, POND.r + 0.4, dp);
  const patches = smoothstep(-0.25, 0.45, fbm2(x * 0.12 + 40, z * 0.12 - 13, 2));
  const rimBand = smoothstep(R - 3.2, R - 1.2, r) * 0.6;
  return clamp(fp * (0.06 + 0.42 * patches + 0.75 * shoulder + 0.55 * pondEdge + 0.6 * base + rimBand), 0, 1);
}

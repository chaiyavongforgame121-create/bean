/**
 * world/island.js — the floating island itself (WP3; GAME-DESIGN §2.1, §2.4 "Decor", §4.5 grass, §9.8).
 *
 *   buildIsland({ tier, count }) → Island
 *   Island = {
 *     group,                    // add to the scene (static: the island never bobs)
 *     terrain, underside, grass, // meshes (terrain receives shadows; grass is an InstancedMesh)
 *     blobSpots,                // [{x, z, r}] contact-shadow spots for the Low tier (trees, rocks)
 *     setCount(n),              // slot count changed → recolour the ring path, re-scatter grass and stones
 *     setChar(k),               // 0..1 charcoal over the field lawn (burned field, §3.5)
 *     setGrassCount(n),         // quality governor: show at most n tufts
 *     dispose()
 *   }
 *
 * Everything is procedural: an adaptive polar disc (uniform ~0.45 u spacing, zipper-triangulated rings),
 * a faceted inverted-cone underside with strata, floating rock chunks, rim trees, boulders, fences,
 * a flower border, stepping stones and instanced grass tufts that bend with the shared wind uniforms.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  Vector3,
} from '../three.js';
import { box, cone, cyl, flat, kit, lowpolySphere, merge, paint, xf } from '../gfx/geom.js';
import { foliageMaterial, grassMaterial, propMaterial } from '../gfx/materials.js';
import { PAL, hexToRgb01, mixHex, scaleHex } from '../gfx/palette.js';
import { ISLAND, fieldBounds } from './logic.js';
import { clamp, hash2, lerp, noise2, noise3, rng, smoothstep } from './noise.js';
import { POND, grassDensity, groundColor, heightAt, pathInfo, pathSet, rimRadius } from './terrain.js';

const TAU = Math.PI * 2;

/** Terrain spacing / grass / tree detail per tier. */
const DETAIL = {
  high: { step: 0.5, grass: 900, under: 64, underRows: 13 },
  medium: { step: 0.56, grass: 500, under: 48, underRows: 11 },
  low: { step: 0.72, grass: 200, under: 40, underRows: 9 },
};

// ------------------------------------------------------------------ adaptive polar disc

/**
 * Rings at radius k·step with ~2πr/step vertices each, triangulated ring-to-ring by a zipper walk.
 * Returns { xz: Float32Array (nominal radius R0), index: [], rim: {start, n} } — positions are mapped onto the
 * noisy rim afterwards.
 */
function polarDisc(R0, step) {
  const K = Math.ceil(R0 / step);
  const xz = [0, 0];
  const rings = [{ start: 0, n: 1, off: 0 }];
  for (let k = 1; k <= K; k++) {
    const r = (k / K) * R0;
    const n = Math.max(6, Math.round((TAU * r) / step));
    const off = (k % 2) * 0.5;
    const start = xz.length / 2;
    for (let i = 0; i < n; i++) {
      const a = ((i + off) / n) * TAU;
      xz.push(r * Math.cos(a), r * Math.sin(a));
    }
    rings.push({ start, n, off });
  }
  const idx = [];
  for (let k = 1; k <= K; k++) {
    const A = rings[k - 1];
    const B = rings[k];
    if (A.n === 1) {
      for (let j = 0; j < B.n; j++) idx.push(0, B.start + j, B.start + ((j + 1) % B.n));
      continue;
    }
    zipper(idx, A, B);
  }
  return { xz, idx, rings, rim: rings[K] };
}

/** Zipper-triangulate between two concentric rings {start, n, off} (angles in turns: (i + off) / n). */
function zipper(idx, A, B) {
  let i = 0;
  let j = 0;
  while (i < A.n || j < B.n) {
    const nextA = (i + 1 + A.off) / A.n;
    const nextB = (j + 1 + B.off) / B.n;
    if (j < B.n && (i >= A.n || nextB <= nextA)) {
      idx.push(A.start + (i % A.n), B.start + (j % B.n), B.start + ((j + 1) % B.n));
      j++;
    } else {
      idx.push(A.start + (i % A.n), B.start + (j % B.n), A.start + ((i + 1) % A.n));
      i++;
    }
  }
}

/** Make every triangle face +Y (top surface) or −Y (`down`), using the given positions. */
function orient(idx, pos, down = false) {
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a];
    const uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a];
    const vz = pos[c + 2] - pos[a + 2];
    const ny = uz * vx - ux * vz;
    if (down ? ny > 0 : ny < 0) {
      const tmp = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = tmp;
    }
  }
}

// ------------------------------------------------------------------ terrain top

const CHAR_VERT = /* glsl */ `
attribute float aChar;
varying float vChar;
`;
const CHAR_FRAG_DECL = /* glsl */ `
uniform float uChar;
varying float vChar;
`;
const CHAR_FRAG = /* glsl */ `
#include <color_fragment>
{
  float ck = clamp( vChar * uChar, 0.0, 1.0 );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.045, 0.036, 0.032 ) * ( 0.75 + 0.5 * vChar ), ck );
}
`;

function terrainMaterial(uChar) {
  const m = new MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uChar = uChar;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CHAR_VERT}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvChar = aChar;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CHAR_FRAG_DECL}`)
      .replace('#include <color_fragment>', CHAR_FRAG);
  };
  m.customProgramCacheKey = () => 'bean-terrain-v1';
  return m;
}

function buildTerrain(step) {
  const R0 = ISLAND.radius;
  const disc = polarDisc(R0, step);
  const n = disc.xz.length / 2;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x0 = disc.xz[i * 2];
    const z0 = disc.xz[i * 2 + 1];
    const r = Math.hypot(x0, z0);
    const th = Math.atan2(z0, x0);
    const k = r > 0 ? rimRadius(th) / R0 : 1;
    const x = x0 * k;
    const z = z0 * k;
    pos[i * 3] = x;
    pos[i * 3 + 1] = heightAt(x, z);
    pos[i * 3 + 2] = z;
  }
  orient(disc.idx, pos, false);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aChar', new BufferAttribute(new Float32Array(n), 1));
  g.setIndex(n > 65535 ? new BufferAttribute(new Uint32Array(disc.idx), 1) : new BufferAttribute(new Uint16Array(disc.idx), 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return { geometry: g, rim: disc.rim };
}

const _col = new Color();

/** (Re)paint the terrain colours + charcoal mask for a slot count. */
function paintTerrain(geo, set) {
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  const ch = geo.attributes.aChar;
  const fb = fieldBounds(set.count);
  const rect = set.rect;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const c = groundColor(x, z, set);
    _col.setRGB(c[0], c[1], c[2], 'srgb'); // → linear working space
    // a touch of vertex AO in the pond bowl and on the rim lip
    const y = pos.getY(i);
    const ao = 1 - 0.18 * smoothstep(-0.05, -0.9, y);
    col.setXYZ(i, _col.r * ao, _col.g * ao, _col.b * ao);
    // charcoal mask: the field lawn + the ring (burned field), ragged edge
    const dx = Math.max(rect.x0 - 0.6 - x, 0, x - rect.x1 - 0.6);
    const dz = Math.max(rect.z0 - 0.6 - z, 0, z - rect.z1 - 0.6);
    // solid inside the ring rect, a ragged burnt edge just outside it, light ash speckle everywhere
    const d = Math.hypot(dx, dz) + 0.7 * Math.max(0, noise2(x * 0.7, z * 0.7));
    const inField = x > fb.x0 - 0.3 && x < fb.x1 + 0.3 && z > fb.z0 - 0.3 && z < fb.z1 + 0.3;
    const base = dx === 0 && dz === 0 ? 0.92 : smoothstep(1.2, 0.1, d) * 0.9;
    ch.setX(i, clamp(base * (inField ? 1 : 0.95) * (0.82 + 0.25 * hash2(x * 2.1, z * 1.7)), 0, 1));
  }
  col.needsUpdate = true;
  ch.needsUpdate = true;
}

// ------------------------------------------------------------------ underside (inverted cone with strata)

function buildUnderside(rim, terrainPos, segs, rows) {
  const C = {
    soil: hexToRgb01(PAL.cliffSoil),
    a: hexToRgb01(PAL.rockA),
    b: hexToRgb01(PAL.rockB),
    c: hexToRgb01(PAL.rockC),
    dk: hexToRgb01(PAL.rockDk),
    grass: hexToRgb01(PAL.grassWarm),
  };
  const bottom = ISLAND.bottomY;
  const tip = new Vector3(0.9, bottom, -0.7);
  const pos = [];
  const idx = [];
  // ring 0 = the exact terrain rim vertices (no crack)
  const top = { start: 0, n: rim.n, off: rim.off };
  for (let i = 0; i < rim.n; i++) {
    const v = (rim.start + i) * 3;
    pos.push(terrainPos[v], terrainPos[v + 1], terrainPos[v + 2]);
  }
  // ring 1: just under the grass lip (same coarse angles as below)
  const ringsY = [];
  for (let r = 1; r <= rows; r++) {
    const t = r / (rows + 1);
    ringsY.push(t);
  }
  let prev = top;
  for (let r = 0; r < ringsY.length; r++) {
    const t = ringsY[r];
    const start = pos.length / 3;
    const off = 0;
    for (let i = 0; i < segs; i++) {
      const th = ((i + off) / segs) * TAU;
      const R = rimRadius(th);
      // profile: a short near-vertical cliff band, then a lumpy taper toward the tip
      const y = r === 0 ? -0.95 : lerp(-0.95, bottom + 0.6, Math.pow((t - ringsY[0]) / (1 - ringsY[0]), 0.92));
      const depth = (-y) / -bottom; // 0..1
      let rad = r === 0 ? R - 0.12 : R * Math.pow(1 - depth, 0.78) * (1 - 0.05 * depth);
      const lump = noise3(Math.cos(th) * 2.1, y * 0.32, Math.sin(th) * 2.1);
      rad *= 1 + (r === 0 ? 0.01 : 0.16) * lump;
      rad = Math.max(0.6, rad);
      const cx = lerp(0, tip.x, depth * depth);
      const cz = lerp(0, tip.z, depth * depth);
      const wob = r === 0 ? 0 : 0.35 * noise3(Math.cos(th) * 3.3 + 7, y * 0.5, Math.sin(th) * 3.3);
      pos.push(cx + Math.cos(th) * rad, y + wob, cz + Math.sin(th) * rad);
    }
    const ring = { start, n: segs, off };
    if (prev === top) zipper(idx, prev, ring);
    else {
      for (let i = 0; i < segs; i++) {
        const a = prev.start + i;
        const b = prev.start + ((i + 1) % segs);
        const c = start + i;
        const d = start + ((i + 1) % segs);
        idx.push(a, c, b, b, c, d);
      }
    }
    prev = ring;
  }
  const tipIndex = pos.length / 3;
  pos.push(tip.x, tip.y, tip.z);
  for (let i = 0; i < segs; i++) idx.push(prev.start + i, tipIndex, prev.start + ((i + 1) % segs));
  // outward-facing triangles: flip any whose normal points toward the axis
  const P = pos;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ux = P[b] - P[a];
    const uy = P[b + 1] - P[a + 1];
    const uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a];
    const vy = P[c + 1] - P[a + 1];
    const vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const mx = (P[a] + P[b] + P[c]) / 3;
    const mz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    if (nx * mx + nz * mz + ny * -0.3 < 0) {
      const tmp = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = tmp;
    }
  }
  let g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g = flat(g);
  // strata colours per face (flat geometry: 3 verts per face)
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let f = 0; f < p.count; f += 3) {
    const y = (p.getY(f) + p.getY(f + 1) + p.getY(f + 2)) / 3;
    const x = (p.getX(f) + p.getX(f + 1) + p.getX(f + 2)) / 3;
    const z = (p.getZ(f) + p.getZ(f + 1) + p.getZ(f + 2)) / 3;
    const th = Math.atan2(z, x);
    let c;
    if (y > -0.5) c = C.grass;
    else if (y > -1.25) c = C.soil;
    else {
      const band = (-y + 0.7 * noise2(Math.cos(th) * 2.5, Math.sin(th) * 2.5)) / 1.15;
      const k = Math.floor(band) % 3;
      c = k === 0 ? C.a : k === 1 ? C.b : C.c;
      const dark = smoothstep(-2, ISLAND.bottomY, y);
      c = [lerp(c[0], C.dk[0], dark * 0.75), lerp(c[1], C.dk[1], dark * 0.75), lerp(c[2], C.dk[2], dark * 0.75)];
    }
    const j = (hash2(x * 1.3, z * 1.7 + y) - 0.5) * 0.06;
    _col.setRGB(clamp(c[0] + j, 0, 1), clamp(c[1] + j, 0, 1), clamp(c[2] + j * 0.8, 0, 1), 'srgb');
    for (let k = 0; k < 3; k++) {
      col[(f + k) * 3] = _col.r;
      col[(f + k) * 3 + 1] = _col.g;
      col[(f + k) * 3 + 2] = _col.b;
    }
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
  return g;
}

/** Floating rock chunks under the island (static). */
function rockChunks(k, r) {
  const spots = [
    [-9.5, -4.2, 8.2, 1.5], [10.5, -3.6, 9.5, 1.2], [13.8, -5.4, -4.5, 1.0], [-12.6, -6.0, -6.4, 1.3],
    [3.8, -10.6, 3.2, 0.9], [-4.4, -8.4, -11.2, 1.1],
  ];
  for (const [x, y, z, s] of spots) {
    const rock = lowpolySphere(s, 1, { jitter: 0.28, seed: x * 3 + z, squash: [1, 0.8, 1] });
    const tipG = cone(s * 0.72, s * 1.9, 6, null, { p: [0, -s * 0.55, 0], r: [Math.PI, r() * 3, 0] });
    const g = merge([rock, flat(tipG)], { dispose: true });
    paint(g, (px, py) => mixHex(PAL.rockA, PAL.rockDk, clamp(-py / (s * 2.2), 0, 1) * 0.8));
    k.add(g, null, { p: [x, y, z], r: [0, r() * TAU, 0] });
    // grassy cap on the bigger chunks
    if (s >= 1.1) k.add(lowpolySphere(s * 0.82, 1, { jitter: 0.15, seed: z, squash: [1, 0.28, 1] }), PAL.grassWarm, { p: [x, y + s * 0.62, z] });
  }
}

// ------------------------------------------------------------------ decor: trees, rocks, fence, flowers

/** Rim trees (§2.4: 6) plus two blossom bushes in the south (kept low so they never hide the field). */
export const TREES = Object.freeze([
  { x: -18.6, z: -6.2, kind: 'round', s: 1.15 },
  { x: -7.6, z: -17.6, kind: 'pine', s: 1.0 },
  { x: -3.6, z: -18.9, kind: 'pine', s: 0.8 },
  { x: 10.8, z: -16.8, kind: 'round', s: 1.05 },
  { x: 17.8, z: -10.2, kind: 'pine', s: 1.05 },
  { x: -19.2, z: 4.0, kind: 'round', s: 0.9 },
  { x: 18.9, z: -2.4, kind: 'pine', s: 0.75 },
  { x: 16.9, z: 11.2, kind: 'blossom', s: 0.85 },
  { x: -17.2, z: 12.6, kind: 'blossom', s: 0.95 },
].map(Object.freeze));

/** Add one tree: trunk → static kit, canopy → foliage kit (with aH for the wind). */
function addTree(ks, kf, t, r, lo = false) {
  const y0 = heightAt(t.x, t.z);
  const s = t.s;
  const trunkH = t.kind === 'pine' ? 1.3 * s : t.kind === 'blossom' ? 0.8 * s : 2.0 * s;
  ks.add(flat(cyl(0.16 * s, 0.3 * s, trunkH + 0.4, 6)), PAL.bark, { p: [t.x, y0 - 0.2, t.z], r: [0, r() * TAU, 0] });
  // root flare stones / roots
  ks.add(lowpolySphere(0.32 * s, 0, { jitter: 0.2, seed: t.x }), PAL.woodDk, { p: [t.x + 0.25 * s, y0 + 0.05, t.z + 0.1], s: [1, 0.45, 1] });
  const top = y0 + trunkH;
  const H = t.kind === 'pine' ? 4.6 * s : t.kind === 'blossom' ? 2.0 * s : 3.6 * s;
  const parts = [];
  if (t.kind === 'pine') {
    const tiers = 3;
    for (let i = 0; i < tiers; i++) {
      const rr = (1.75 - i * 0.42) * s;
      const hh = (1.9 - i * 0.25) * s;
      const g = flat(cone(rr, hh, 7, null, { p: [0, (i * 1.15 - 0.3) * s, 0], r: [0, r() * TAU, 0] }));
      paint(g, i % 2 ? PAL.leafC : mixHex(PAL.leafC, PAL.leafA, 0.35));
      parts.push(g);
    }
  } else {
    const n = t.kind === 'blossom' ? 3 : 4;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + r();
      const rad = (t.kind === 'blossom' ? 0.95 : 1.25) * s * (0.85 + 0.3 * r());
      const off = i === 0 ? 0 : 0.75 * s;
      // Low tier: icosahedra instead of subdivided spheres (decor decimates on Low, PLATFORM QA-07)
      const g = lowpolySphere(rad, lo ? 0 : 1, { jitter: 0.16, seed: t.x * 7 + i });
      const base = t.kind === 'blossom' ? PAL.blossom : [PAL.leafA, PAL.leafB, PAL.leafC][i % 3];
      paint(g, (px, py) => mixHex(base, scaleHex(base, 1.12), clamp(py / rad * 0.5 + 0.5, 0, 1)));
      xf(g, { p: [Math.cos(a) * off, (i === 0 ? 1.0 : 0.55 + 0.4 * r()) * s * 1.2, Math.sin(a) * off] });
      parts.push(g);
    }
    if (t.kind === 'blossom') {
      // a few leaves peeking through the blossom
      const g = lowpolySphere(0.7 * s, 0, { jitter: 0.2, seed: t.z });
      paint(g, PAL.leafB);
      xf(g, { p: [0.4 * s, 0.4 * s, -0.3 * s] });
      parts.push(g);
    }
  }
  const canopy = merge(parts, { dispose: true });
  xf(canopy, { p: [t.x, top, t.z] });
  // aH: 0 at the trunk top → 1 at the crown (sway grows toward the top)
  const p = canopy.attributes.position;
  const aH = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) aH[i] = clamp((p.getY(i) - top + 0.6) / (H + 0.6), 0, 1) * 0.8;
  canopy.setAttribute('aH', new BufferAttribute(aH, 1));
  kf.add(canopy);
  return { x: t.x, z: t.z, r: (t.kind === 'pine' ? 1.6 : 1.9) * s };
}

/** Boulders (merged, static). */
const BOULDERS = [
  [18.6, 5.9, 0.6], [17.2, 0.4, 0.45], [12.2, 5.6, 0.38], [-19.6, -1.6, 0.7], [-15.8, -12.6, 0.55], [6.8, -18.6, 0.6],
  [-14.6, 15.2, 0.5], [13.6, 15.4, 0.55], [-10.4, -16.4, 0.42], [19.2, 8.4, 0.4], [-2.8, 19.4, 0.38], [3.8, 19.6, 0.32],
];

function addBoulders(k, lo = false) {
  const spots = [];
  for (const [x, z, s] of BOULDERS) {
    const y = heightAt(x, z);
    const g = lowpolySphere(s, lo ? 0 : 1, { jitter: 0.25, seed: x + z * 3, squash: [1.15, 0.72, 1] });
    paint(g, (px, py) => mixHex(PAL.rockB, PAL.rockA, clamp(py / s + 0.5, 0, 1)));
    k.add(g, null, { p: [x, y + s * 0.25, z], r: [0, x * 1.7, 0] });
    if (s > 0.45) k.add(lowpolySphere(s * 0.45, 0, { jitter: 0.2, seed: x }), PAL.rockA, { p: [x + s * 0.9, y + 0.05, z + s * 0.4], s: [1, 0.7, 1] });
    spots.push({ x, z, r: s * 1.4 });
  }
  return spots;
}

/** Rustic fence arcs along the south rim (behind the mailbox and the fire pit; open at the signpost). */
function addFences(k) {
  const arcs = [[100, 142], [38, 80], [196, 214]];
  for (const [a0, a1] of arcs) {
    const n = Math.max(2, Math.round(((a1 - a0) / 360) * TAU * 19 / 1.7));
    let prev = null;
    for (let i = 0; i <= n; i++) {
      const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
      const R = rimRadius(a) - 1.35;
      const x = Math.cos(a) * R;
      const z = Math.sin(a) * R;
      const y = heightAt(x, z);
      const lean = (hash2(x, z) - 0.5) * 0.12;
      k.add(box(0.16, 0.95, 0.16), PAL.woodMid, { p: [x, y - 0.1, z], r: [lean, -a, lean * 0.5] });
      k.add(box(0.2, 0.06, 0.2), PAL.woodDk, { p: [x, y + 0.85, z], r: [0, -a, 0] });
      if (prev) {
        const mx = (x + prev.x) / 2;
        const mz = (z + prev.z) / 2;
        const my = (y + prev.y) / 2;
        const len = Math.hypot(x - prev.x, z - prev.z);
        const yaw = Math.atan2(-(z - prev.z), x - prev.x);
        for (const h of [0.38, 0.7]) {
          k.add(box(len + 0.1, 0.09, 0.07), PAL.wood, { p: [mx, my + h, mz], r: [0, yaw, (hash2(mx, h) - 0.5) * 0.06] });
        }
      }
      prev = { x, y, z };
    }
  }
}

/** Flower clusters: along path shoulders, the plazas, fences and the pond bank. Foliage kit (sways). */
function addFlowers(kf, set, r, count) {
  const tones = [PAL.butter, PAL.cream, PAL.lavender, PAL.peach, PAL.blossom, 0xffffff, PAL.lavender];
  let placed = 0;
  let guard = 0;
  while (placed < count && guard++ < count * 40) {
    const a = r() * TAU;
    const rr = Math.sqrt(r()) * 19.5;
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    const p = pathInfo(x, z, set.lines);
    const nearPath = p.edge > 0.15 && p.edge < 0.75;
    const dp = Math.hypot(x - POND.x, z - POND.z);
    const nearPond = dp > POND.bank - 0.2 && dp < POND.bank + 0.9;
    const nearRim = rr > rimRadius(a) - 2.4 && rr < rimRadius(a) - 0.9 && (a > 0.6 && a < 2.6);
    if (!(nearPath || nearPond || nearRim)) continue;
    if (grassDensity(x, z, set) <= 0) continue;
    if (r() > 0.55) continue;
    const y = heightAt(x, z);
    const cluster = 2 + Math.floor(r() * 3);
    const tone = tones[Math.floor(r() * tones.length)];
    for (let i = 0; i < cluster; i++) {
      const fx = x + (r() - 0.5) * 0.5;
      const fz = z + (r() - 0.5) * 0.5;
      const h = 0.22 + r() * 0.2;
      // ~30 triangles per flower: a 3-sided stem, a faceted head, a leaf on every other one
      const stem = flat(cone(0.025, h, 3, PAL.leafC));
      const head = lowpolySphere(0.07 + r() * 0.04, 0, { jitter: 0.1, seed: i + placed });
      paint(head, i % 3 === 0 ? mixHex(tone, 0xffffff, 0.25) : tone);
      xf(head, { p: [0, h, 0], s: [1, 0.7, 1] });
      const parts = [stem, head];
      if (i % 2 === 0) parts.push(flat(cone(0.05, 0.14, 3, PAL.leafB, { p: [0.03, h * 0.3, 0], r: [0, 0, -1.1] })));
      const g = merge(parts, { dispose: true });
      const pp = g.attributes.position;
      const aH = new Float32Array(pp.count);
      for (let v = 0; v < pp.count; v++) aH[v] = clamp(pp.getY(v) / (h + 0.05), 0, 1);
      g.setAttribute('aH', new BufferAttribute(aH, 1));
      xf(g, { p: [fx, y - 0.02, fz], r: [0, r() * TAU, 0] });
      kf.add(g);
    }
    placed++;
  }
}

/** Reeds and lily pads around the pond (foliage kit; pads are flat and rigid). */
function addPondPlants(kf, ks, r) {
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU + r() * 0.3;
    if (a > 2.7 && a < 4.0) continue; // keep the pump side (west) open
    if (a < 0.4 || a > Math.PI * 2 - 0.25) continue; // and the stream outlet (east)
    const d = POND.r + 0.05 + r() * 0.5;
    const x = POND.x + Math.cos(a) * d;
    const z = POND.z + Math.sin(a) * d;
    const y = heightAt(x, z);
    const n = 3 + Math.floor(r() * 3);
    for (let j = 0; j < n; j++) {
      const h = 0.7 + r() * 0.7;
      const blade = flat(cone(0.045, h, 3, PAL.leafC));
      const parts = [blade];
      if (j === 0 && r() > 0.4) parts.push(cyl(0.055, 0.055, 0.22, 5, PAL.woodDk, { p: [0, h * 0.72, 0] }));
      const g = merge(parts, { dispose: true });
      const pp = g.attributes.position;
      const aH = new Float32Array(pp.count);
      for (let v = 0; v < pp.count; v++) aH[v] = clamp(pp.getY(v) / h, 0, 1);
      g.setAttribute('aH', new BufferAttribute(aH, 1));
      xf(g, { p: [x + (r() - 0.5) * 0.35, y - 0.05, z + (r() - 0.5) * 0.35], r: [(r() - 0.5) * 0.25, 0, (r() - 0.5) * 0.25] });
      kf.add(g);
    }
  }
}

// ------------------------------------------------------------------ path stones + pebbles (rebuilt per slot count)

function buildPathStones(set, { pebbles = true } = {}) {
  const r = rng(77);
  const k = kit();
  for (const line of set.lines) {
    const p = line.pts;
    const stepping = line.w < 1.1; // narrow spurs get stepping stones
    let acc = 0;
    for (let i = 1; i < p.length; i++) {
      const ax = p[i - 1][0];
      const az = p[i - 1][1];
      const bx = p[i][0];
      const bz = p[i][1];
      const L = Math.hypot(bx - ax, bz - az);
      const nx = -(bz - az) / (L || 1);
      const nz = (bx - ax) / (L || 1);
      let s = acc;
      while (s < L) {
        const t = s / L;
        const cx = lerp(ax, bx, t);
        const cz = lerp(az, bz, t);
        if (stepping) {
          const side = (Math.floor((s + i * 7) / 0.8) % 2 ? 1 : -1) * 0.16;
          const sx = cx + nx * side;
          const sz = cz + nz * side;
          const rad = 0.24 + r() * 0.1;
          const g = flat(cyl(rad, rad * 1.08, 0.08, 7));
          paint(g, mixHex(0xdcd2c2, 0xc4b9a8, r()));
          k.add(g, null, { p: [sx, heightAt(sx, sz) - 0.01, sz], r: [0, r() * 3, 0], s: [1, 1, 0.75 + r() * 0.3] });
        }
        // pebbles along both edges (none on Low: decor decimates, PLATFORM QA-07)
        for (const sd of [-1, 1]) {
          if (r() > 0.55 || !pebbles) continue;
          const off = (line.w / 2 + 0.05 + r() * 0.12) * sd;
          const px = cx + nx * off;
          const pz = cz + nz * off;
          const g = lowpolySphere(0.07 + r() * 0.07, 0, { jitter: 0.25, seed: px * 9 + pz });
          paint(g, mixHex(PAL.pebble, 0xe9e2d6, r()));
          k.add(g, null, { p: [px, heightAt(px, pz) + 0.01, pz], s: [1, 0.55, 1] });
        }
        s += stepping ? 0.78 : 0.95;
      }
      acc = s - L;
    }
  }
  return k.build();
}

// ------------------------------------------------------------------ grass tufts

function tuftGeometry() {
  // 8 bent blades (3 tris each), up-facing normals so tufts shade like the ground under them
  const pos = [];
  const col = [];
  const aH = [];
  const r = rng(5);
  // multipliers of the per-instance ground colour (sRGB-ish factors, linearised below): darker roots, sunlit tips
  const base = [0.72, 0.8, 0.6];
  const tip = [1.12, 1.12, 0.9];
  for (let b = 0; b < 8; b++) {
    const a = (b / 8) * TAU + r() * 0.5;
    const lean = 0.08 + r() * 0.16;
    const h = 0.32 + r() * 0.26;
    const w = 0.05 + r() * 0.03;
    const ox = Math.cos(a) * 0.07;
    const oz = Math.sin(a) * 0.07;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const px = -dz * w;
    const pz = dx * w;
    // blade: 5 verts (two side pairs + tip) → 3 triangles
    const v = [
      [ox - px, 0, oz - pz, 0], [ox + px, 0, oz + pz, 0],
      [ox + dx * lean * 0.45 - px * 0.6, h * 0.55, oz + dz * lean * 0.45 - pz * 0.6, 0.55],
      [ox + dx * lean * 0.45 + px * 0.6, h * 0.55, oz + dz * lean * 0.45 + pz * 0.6, 0.55],
      [ox + dx * lean, h, oz + dz * lean, 1],
    ];
    const tri = (i0, i1, i2) => {
      for (const i of [i0, i1, i2]) {
        pos.push(v[i][0], v[i][1], v[i][2]);
        const k = v[i][3];
        col.push(lerp(base[0], tip[0], k), lerp(base[1], tip[1], k), lerp(base[2], tip[2], k));
        aH.push(k);
      }
    };
    tri(0, 1, 2);
    tri(1, 3, 2);
    tri(2, 3, 4);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  g.setAttribute('normal', new BufferAttribute(nor, 3));
  // linearise the vertex colours (they are sRGB factors)
  const lin = col.map((c) => Math.pow(c, 2.2));
  g.setAttribute('color', new BufferAttribute(new Float32Array(lin), 3));
  g.setAttribute('aH', new BufferAttribute(new Float32Array(aH), 1));
  return g;
}

function scatterGrass(mesh, set, max, seed = 11) {
  const r = rng(seed);
  const m = new Matrix4();
  const o = new Object3D();
  let n = 0;
  let guard = 0;
  while (n < max && guard++ < max * 30) {
    const a = r() * TAU;
    const rr = Math.sqrt(r()) * 20.8;
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    const d = grassDensity(x, z, set);
    if (d <= 0 || r() > d) continue;
    const y = heightAt(x, z);
    o.position.set(x, y - 0.03, z);
    o.rotation.set((r() - 0.5) * 0.12, r() * TAU, (r() - 0.5) * 0.12);
    const s = 0.62 + r() * 0.5 + 0.3 * d;
    o.scale.set(s, s * (0.85 + r() * 0.35), s);
    o.updateMatrix();
    mesh.setMatrixAt(n, m.copy(o.matrix));
    const c = groundColor(x, z, set);
    _col.setRGB(c[0], c[1], c[2], 'srgb');
    mesh.setColorAt(n, _col);
    n++;
  }
  mesh.count = n;
  mesh.userData.placed = n;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere?.();
  return n;
}

// ------------------------------------------------------------------ public builder

export function buildIsland({ tier = 'high', count = 10, uChar = { value: 0 } } = {}) {
  const D = DETAIL[tier] || DETAIL.high;
  const group = new Group();
  group.name = 'island';
  const disposables = [];
  const r = rng(2024);

  // terrain top
  let set = pathSet(count);
  const { geometry: tGeo, rim } = buildTerrain(D.step);
  paintTerrain(tGeo, set);
  const tMat = terrainMaterial(uChar);
  const terrain = new Mesh(tGeo, tMat);
  terrain.name = 'terrain';
  terrain.receiveShadow = true;
  group.add(terrain);
  disposables.push(tGeo, tMat);

  // underside + floating chunks (one mesh, flat-shaded strata)
  const kRock = kit();
  rockChunks(kRock, r);
  const chunks = kRock.build();
  const under = buildUnderside(rim, tGeo.attributes.position.array, D.under, D.underRows);
  const underGeo = merge([under, chunks], { dispose: true });
  const underMat = propMaterial({ vertexColors: true, flat: true });
  const underside = new Mesh(underGeo, underMat);
  underside.name = 'underside';
  group.add(underside);
  disposables.push(underGeo);

  // static decor: trunks, boulders, fences
  const ks = kit();
  const kf = kit();
  const blobSpots = [];
  const lo = tier === 'low';
  for (const t of TREES) blobSpots.push(addTree(ks, kf, t, r, lo));
  blobSpots.push(...addBoulders(ks, lo));
  addFences(ks);
  addPondPlants(kf, ks, r);
  addFlowers(kf, set, rng(91), tier === 'low' ? 36 : tier === 'medium' ? 60 : 90);
  const decoGeo = ks.build({ ao: false });
  const decor = new Mesh(decoGeo, propMaterial({ vertexColors: true, toon: true }));
  decor.name = 'decor';
  decor.castShadow = true;
  decor.receiveShadow = true;
  group.add(decor);
  disposables.push(decoGeo);

  const folGeo = kf.build();
  const foliage = new Mesh(folGeo, foliageMaterial({ bend: 0.1, vertexColors: true, toon: true, side: DoubleSide }));
  foliage.name = 'foliage';
  foliage.castShadow = true;
  foliage.receiveShadow = true;
  group.add(foliage);
  disposables.push(folGeo);

  // stepping stones + pebbles (depends on the slot count)
  let stonesGeo = buildPathStones(set, { pebbles: !lo });
  const stones = new Mesh(stonesGeo, propMaterial({ vertexColors: true, toon: true }));
  stones.name = 'pathStones';
  stones.receiveShadow = true;
  group.add(stones);

  // grass
  const tuft = tuftGeometry();
  const grass = new InstancedMesh(tuft, grassMaterial(), D.grass);
  grass.instanceColor = new InstancedBufferAttribute(new Float32Array(D.grass * 3), 3);
  grass.name = 'grass';
  grass.receiveShadow = true;
  grass.frustumCulled = false;
  scatterGrass(grass, set, D.grass);
  group.add(grass);
  disposables.push(tuft);
  let grassMax = D.grass;

  function setCount(n) {
    const c = Math.max(10, Math.min(15, Math.round(Number(n) || 10)));
    if (c === set.count) return false;
    set = pathSet(c);
    paintTerrain(tGeo, set);
    stonesGeo.dispose();
    stonesGeo = buildPathStones(set, { pebbles: !lo });
    stones.geometry = stonesGeo;
    scatterGrass(grass, set, D.grass);
    grass.count = Math.min(grass.userData.placed, grassMax);
    return true;
  }

  return {
    group,
    terrain,
    underside,
    grass,
    decor,
    foliage,
    blobSpots,
    get set() {
      return set;
    },
    setCount,
    setChar(k) {
      uChar.value = clamp(Number(k) || 0, 0, 1);
    },
    setGrassCount(n) {
      grassMax = Math.max(0, Math.min(D.grass, Math.floor(Number(n) || 0)));
      grass.count = Math.min(grass.userData.placed || 0, grassMax);
    },
    dispose() {
      for (const d of disposables) d.dispose?.();
      stonesGeo.dispose();
      group.removeFromParent();
    },
  };
}

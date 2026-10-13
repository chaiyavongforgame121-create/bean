/**
 * gfx/geom.js — procedural geometry utilities (WP3; GAME-DESIGN §9.7, §9.8).
 *
 * Contract exports (§9.7): lathe, tubeAlong, leafStrip, lowpolySphere, merge, vertexAO, noise2, displaceRadial.
 * Extra helpers (stable, documented below): rng, noise3, fbm2, hash2, paint, xf, box, cyl, cone, flat, fillAttr,
 * heightAttr, kit, colorLinear, clamp, lerp, smoothstep, prism, ribbon.
 *
 * Conventions
 * - Every builder returns a fresh THREE.BufferGeometry the caller owns (dispose it when done).
 * - Colours: pass sRGB hex (0xRRGGBB) or a THREE.Color. Vertex colours are written in three's LINEAR working
 *   space (via `new Color(hex)`), which is what `vertexColors: true` materials expect.
 * - `merge()` fills a missing `color` with white and any other missing attribute with 0, so geometries with
 *   and without `aLeaf`/`aH` can be merged safely.
 * - Builders never touch the scene, the DOM or the renderer; nothing runs at import time.
 */
import {
  BufferAttribute,
  BufferGeometry,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  IcosahedronGeometry,
  LatheGeometry,
  Matrix4,
  Quaternion,
  Vector2,
  Vector3,
} from '../three.js';

// ------------------------------------------------------------------ scalar helpers + noise (pure, shared)

// The noise/PRNG lives in world/noise.js (no three import) so terrain maths can be unit-tested in Node.
import { clamp, lerp, smoothstep, rng, noise2, noise3, fbm2, hash2 } from '../world/noise.js';

export { clamp, lerp, smoothstep, rng, noise2, noise3, fbm2, hash2 };

// ------------------------------------------------------------------ colour + attribute helpers

const _c = new Color();

/** sRGB hex / Color / css string → a NEW THREE.Color in the linear working space. */
export function colorLinear(c) {
  return c && c.isColor ? c.clone() : new Color(c);
}

/**
 * Paint a vertex-colour attribute.
 * `color` is a hex / Color, or a function (x, y, z, i) → hex|Color for gradients.
 */
export function paint(geo, color) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const arr = new Float32Array(n * 3);
  if (typeof color === 'function') {
    for (let i = 0; i < n; i++) {
      const v = color(pos.getX(i), pos.getY(i), pos.getZ(i), i);
      if (v && v.isColor) _c.copy(v); else _c.set(v);
      arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b;
    }
  } else {
    if (color && color.isColor) _c.copy(color); else _c.set(color ?? 0xffffff);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b;
    }
  }
  geo.setAttribute('color', new BufferAttribute(arr, 3));
  return geo;
}

/** Fill a float attribute with a constant (e.g. `fillAttr(g, 'aLeaf', 1)`). */
export function fillAttr(geo, name, value = 0, itemSize = 1) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * itemSize);
  if (value) arr.fill(value);
  geo.setAttribute(name, new BufferAttribute(arr, itemSize));
  return geo;
}

/**
 * Normalised-height attribute (default `aH`): clamp((y − y0) / height, 0, 1). `height` defaults to the
 * geometry's max y. The crop shader bends with w = aH² (§3.4).
 */
export function heightAttr(geo, { name = 'aH', height = 0, y0 = 0 } = {}) {
  const pos = geo.attributes.position;
  let h = height;
  if (!(h > 0)) {
    h = 1e-6;
    for (let i = 0; i < pos.count; i++) h = Math.max(h, pos.getY(i) - y0);
  }
  const arr = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) arr[i] = clamp((pos.getY(i) - y0) / h, 0, 1);
  geo.setAttribute(name, new BufferAttribute(arr, 1));
  return geo;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3();

/**
 * Transform a geometry in place. `p` = [x, y, z] translation, `r` = [rx, ry, rz] Euler XYZ radians,
 * `s` = number | [sx, sy, sz]. Order: scale → rotate → translate. Returns the geometry.
 */
export function xf(geo, { p, r, s } = {}) {
  _p.set(0, 0, 0);
  if (p) _p.set(p[0] || 0, p[1] || 0, p[2] || 0);
  _e.set(r ? r[0] || 0 : 0, r ? r[1] || 0 : 0, r ? r[2] || 0 : 0);
  _q.setFromEuler(_e);
  if (s == null) _s.set(1, 1, 1);
  else if (typeof s === 'number') _s.set(s, s, s);
  else _s.set(s[0] ?? 1, s[1] ?? 1, s[2] ?? 1);
  _m.compose(_p, _q, _s);
  geo.applyMatrix4(_m);
  return geo;
}

/** Non-indexed copy with face normals (chunky low-poly faceting). Disposes nothing. */
export function flat(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

/**
 * Vertex ambient occlusion baked at build time (§9.8): colour ×= min + (1 − min)·smoothstep(0, top, y − y0).
 * Creates a white `color` attribute when there is none.
 */
export function vertexAO(geo, { min = 0.78, top = 0.6, y0 = 0 } = {}) {
  if (!geo.attributes.color) paint(geo, 0xffffff);
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const k = min + (1 - min) * smoothstep(0, top, pos.getY(i) - y0);
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  col.needsUpdate = true;
  return geo;
}

// ------------------------------------------------------------------ primitives (painted, optionally transformed)

function finish(geo, color, t) {
  if (t) xf(geo, t);
  if (color != null) paint(geo, color);
  return geo;
}

/** Box (w × h × d) sitting on y = 0 unless `centered`. */
export function box(w, h, d, color, t, { centered = false } = {}) {
  const g = new BoxGeometry(w, h, d);
  if (!centered) g.translate(0, h / 2, 0);
  return finish(g, color, t);
}

/** Cylinder from y = 0 to h (radiusTop, radiusBottom, height, radial segments). */
export function cyl(rt, rb, h, seg = 8, color, t, { open = false, centered = false } = {}) {
  const g = new CylinderGeometry(rt, rb, h, seg, 1, open);
  if (!centered) g.translate(0, h / 2, 0);
  return finish(g, color, t);
}

/** Cone from y = 0 to h. */
export function cone(r, h, seg = 8, color, t, { centered = false } = {}) {
  const g = new ConeGeometry(r, h, seg, 1);
  if (!centered) g.translate(0, h / 2, 0);
  return finish(g, color, t);
}

/**
 * Extrude a CONVEX polygon drawn in the XY plane along Z (centred on z = 0). Flat-shaded, non-indexed.
 * Used for gables, sign boards, arrow plaques and roof slabs.
 * @param {Array<[number, number]>} pts  polygon (either winding; it is normalised to CCW)
 * @param {number} depth  extrusion length along Z
 */
export function prism(pts, depth = 0.1, color, t) {
  let P = pts.map((p) => [p[0], p[1]]);
  let area = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (area < 0) P = P.reverse();
  const hz = depth / 2;
  const pos = [];
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  // caps (fan)
  for (let i = 1; i < P.length - 1; i++) {
    tri([P[0][0], P[0][1], hz], [P[i][0], P[i][1], hz], [P[i + 1][0], P[i + 1][1], hz]);
    tri([P[0][0], P[0][1], -hz], [P[i + 1][0], P[i + 1][1], -hz], [P[i][0], P[i][1], -hz]);
  }
  // sides
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    tri([a[0], a[1], hz], [a[0], a[1], -hz], [b[0], b[1], -hz]);
    tri([a[0], a[1], hz], [b[0], b[1], -hz], [b[0], b[1], hz]);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return finish(g, color, t);
}

// ------------------------------------------------------------------ contract builders

/**
 * Lathe a profile around +Y.
 * @param {Array<[number, number]>|Vector2[]} profile  [[radius, y], …] bottom → top
 * @param {number} segments  radial segments (default 8)
 * @param {{color?, flat?: boolean, phiStart?: number, phiLength?: number, t?: object}} opts
 */
export function lathe(profile, segments = 8, { color, flat: isFlat = false, phiStart = 0, phiLength = Math.PI * 2, t } = {}) {
  const pts = profile.map((p) => (p.isVector2 ? p.clone() : new Vector2(Math.max(0, p[0]), p[1])));
  let g = new LatheGeometry(pts, segments, phiStart, phiLength);
  if (isFlat) g = flat(g);
  return finish(g, color, t);
}

/**
 * Tube along a polyline (parallel-transport frames, so it never twists).
 * @param {Array<Vector3|[number, number, number]>} points  ≥ 2 points
 * @param {number|((t: number) => number)} radius  constant or a function of t ∈ [0, 1]
 * @param {number} radialSegments  default 5
 * @param {{color?, caps?: boolean, t?: object}} opts
 */
export function tubeAlong(points, radius = 0.05, radialSegments = 5, { color, caps = true, t } = {}) {
  const P = points.map((p) => (p.isVector3 ? p.clone() : new Vector3(p[0], p[1], p[2])));
  if (P.length < 2) P.push(P[0].clone().add(new Vector3(0, 0.01, 0)));
  const n = P.length;
  const rad = typeof radius === 'function' ? radius : () => radius;
  // cumulative length for t
  const len = [0];
  for (let i = 1; i < n; i++) len.push(len[i - 1] + P[i].distanceTo(P[i - 1]));
  const total = len[n - 1] || 1;
  // tangents
  const T = P.map((_, i) => {
    const a = P[Math.max(0, i - 1)];
    const b = P[Math.min(n - 1, i + 1)];
    return b.clone().sub(a).normalize();
  });
  // initial normal: any vector not parallel to T0
  const N = [];
  const up = Math.abs(T[0].y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  N[0] = new Vector3().crossVectors(T[0], up).normalize();
  for (let i = 1; i < n; i++) {
    const axis = new Vector3().crossVectors(T[i - 1], T[i]);
    const s = axis.length();
    N[i] = N[i - 1].clone();
    if (s > 1e-6) {
      axis.divideScalar(s);
      const ang = Math.acos(clamp(T[i - 1].dot(T[i]), -1, 1));
      N[i].applyAxisAngle(axis, ang);
    }
  }
  const segs = Math.max(3, radialSegments | 0);
  const pos = [];
  const nor = [];
  const uv = [];
  const idx = [];
  const B = new Vector3();
  for (let i = 0; i < n; i++) {
    B.crossVectors(T[i], N[i]).normalize();
    const r = rad(len[i] / total);
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const cx = Math.cos(a);
      const sx = Math.sin(a);
      const nx = N[i].x * cx + B.x * sx;
      const ny = N[i].y * cx + B.y * sx;
      const nz = N[i].z * cx + B.z * sx;
      pos.push(P[i].x + nx * r, P[i].y + ny * r, P[i].z + nz * r);
      nor.push(nx, ny, nz);
      uv.push(len[i] / total, j / segs);
    }
  }
  const ring = segs + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * ring + j;
      const b = (i + 1) * ring + j;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  if (caps) {
    for (const [i, dir] of [[0, -1], [n - 1, 1]]) {
      const c = pos.length / 3;
      pos.push(P[i].x, P[i].y, P[i].z);
      nor.push(T[i].x * dir, T[i].y * dir, T[i].z * dir);
      uv.push(i ? 1 : 0, 0.5);
      for (let j = 0; j < segs; j++) {
        const a = i * ring + j;
        if (dir < 0) idx.push(c, a + 1, a);
        else idx.push(c, a, a + 1);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  return finish(g, color, t);
}

/**
 * A leaf blade. The base sits at the origin and the blade runs along +Z, width along X, with a V fold
 * along the midrib and a downward curl toward the tip. Render with `side: DoubleSide` (cropMaterial does).
 * @param {{length?, width?, segments?, curl?, fold?, tip?: number, color?, t?}} o
 *   curl: tip drop as a fraction of length; fold: edge lift as a fraction of half-width; tip: 0 pointed, 1 blunt.
 */
export function leafStrip({ length = 1, width = 0.35, segments = 4, curl = 0.25, fold = 0.35, tip = 0, color, t } = {}) {
  const segs = Math.max(1, segments | 0);
  const pos = [];
  const uv = [];
  const idx = [];
  for (let i = 0; i <= segs; i++) {
    const s = i / segs;
    const z = s * length;
    const y = -curl * length * s * s;
    const shape = Math.pow(Math.sin(Math.PI * Math.min(1, s * (1 - tip * 0.5) + tip * 0.0)), 0.75);
    const hw = 0.5 * width * (i === segs && tip <= 0 ? 0 : Math.max(shape, i === 0 ? 0.08 : 0));
    const lift = fold * hw;
    pos.push(-hw, y + lift, z, 0, y, z, hw, y + lift, z);
    uv.push(0, s, 0.5, s, 1, s);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 3;
    const b = a + 3;
    idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return finish(g, color, t);
}

/**
 * Faceted low-poly sphere (icosphere) with coherent vertex jitter (shared corners move together, so the
 * mesh never cracks). Non-indexed, flat normals.
 * @param {number} radius
 * @param {number} detail  0..2 (0 = 20 faces, 1 = 80, 2 = 320)
 * @param {{jitter?: number, seed?: number, squash?: number[], color?, t?}} o  jitter is relative to radius
 */
export function lowpolySphere(radius = 1, detail = 1, { jitter = 0.12, seed = 1, squash, color, t } = {}) {
  const g = new IcosahedronGeometry(radius, detail);
  const pos = g.attributes.position;
  if (jitter > 0) {
    const f = 1.7 / Math.max(radius, 1e-3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const k = 1 + jitter * noise3(x * f + seed * 7.13, y * f - seed * 3.7, z * f + seed * 1.9);
      pos.setXYZ(i, x * k, y * k, z * k);
    }
  }
  if (squash) for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i) * squash[0], pos.getY(i) * squash[1], pos.getZ(i) * squash[2]);
  const out = flat(g);
  return finish(out, color, t);
}

/**
 * Push vertices along their direction from `center` by noise3(p·freq)·amount (rocks, clouds, cliffs).
 * Coherent: vertices at the same position get the same offset. Recomputes normals (flat when non-indexed).
 */
export function displaceRadial(geo, amount = 0.2, { seed = 0, freq = 1.5, center = [0, 0, 0], axisScale = [1, 1, 1] } = {}) {
  const pos = geo.attributes.position;
  const c = new Vector3(center[0], center[1], center[2]);
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const n = noise3(v.x * freq + seed * 3.1, v.y * freq + seed * 1.7, v.z * freq - seed * 2.3);
    const d = v.clone().sub(c);
    const L = d.length();
    if (L < 1e-6) continue;
    d.divideScalar(L);
    v.x += d.x * n * amount * axisScale[0];
    v.y += d.y * n * amount * axisScale[1];
    v.z += d.z * n * amount * axisScale[2];
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Merge geometries into one (static batching, §9.8). Attributes are unioned: a missing `color` becomes white,
 * any other missing attribute becomes 0. If every input is indexed the result is indexed, otherwise all are
 * de-indexed. Groups are dropped. Inputs are left untouched unless `{dispose: true}`.
 */
export function merge(geos, { dispose = false } = {}) {
  const list0 = (geos || []).filter(Boolean);
  if (!list0.length) return new BufferGeometry();
  const allIndexed = list0.every((g) => g.index);
  const list = allIndexed ? list0 : list0.map((g) => (g.index ? g.toNonIndexed() : g));
  const sizes = new Map();
  for (const g of list) {
    for (const [name, a] of Object.entries(g.attributes)) {
      if (!sizes.has(name)) sizes.set(name, a.itemSize);
    }
  }
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const out = new BufferGeometry();
  for (const [name, size] of sizes) {
    const arr = new Float32Array(total * size);
    let off = 0;
    for (const g of list) {
      const a = g.attributes[name];
      const count = g.attributes.position.count;
      if (a && a.itemSize === size) {
        if (!a.isInterleavedBufferAttribute && !a.normalized && a.array.length === count * size) arr.set(a.array, off);
        else for (let i = 0; i < count; i++) for (let k = 0; k < size; k++) arr[off + i * size + k] = a.getComponent(i, k);
      } else if (name === 'color') {
        arr.fill(1, off, off + count * size);
      }
      off += count * size;
    }
    out.setAttribute(name, new BufferAttribute(arr, size));
  }
  if (allIndexed) {
    let icount = 0;
    for (const g of list) icount += g.index.count;
    const I = total > 65535 ? new Uint32Array(icount) : new Uint16Array(icount);
    let o = 0;
    let base = 0;
    for (const g of list) {
      const src = g.index.array;
      for (let i = 0; i < g.index.count; i++) I[o++] = src[i] + base;
      base += g.attributes.position.count;
    }
    out.setIndex(new BufferAttribute(I, 1));
  }
  if (dispose) {
    for (const g of list0) g.dispose();
    if (!allIndexed) for (const g of list) if (!list0.includes(g)) g.dispose();
  } else if (!allIndexed) {
    for (const g of list) if (!list0.includes(g)) g.dispose();
  }
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/**
 * A small static-batching kit: collect painted primitives, then `build()` one merged geometry.
 *   const k = kit(); k.add(box(1,1,1), 0xff0000, {p:[0,0,0]}); const geo = k.build({ ao: true });
 * `add(geo, color?, transform?)` paints (if color given) and transforms the geometry before collecting it.
 */
export function kit() {
  const parts = [];
  return {
    parts,
    add(geo, color, t) {
      if (t) xf(geo, t);
      if (color != null) paint(geo, color);
      parts.push(geo);
      return geo;
    },
    build({ ao = false, aoMin = 0.78, aoTop = 0.6, flatShade = false } = {}) {
      let g = merge(parts, { dispose: true });
      parts.length = 0;
      if (flatShade) g = flat(g);
      if (ao) vertexAO(g, { min: aoMin, top: aoTop });
      return g;
    },
  };
}

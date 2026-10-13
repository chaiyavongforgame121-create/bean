/**
 * crops/builders.js — the 9 parametric crop builders and the CropMesh actor (GAME-DESIGN §3.1, §3.4, §9.7, §9.8).
 *
 *   buildParts(coin, { tier }) → { stemLeaves, fruitGeo, flowerGeo, fruitAnchors[6], flowerAnchors[≤6], height, … }
 *   buildCrop(coin, { tier })  → CropMesh
 *     CropMesh = { group, crop, setGrowth({ size, health, fruit, flower, ripe, frac, seed, shaded, frost, frozen, … }),
 *                  setSway(amp, shiver, windFactor), fruitWorld(i) → Vector3, update(dt, t), dispose(),
 *                  // extras used by field/plot.js:
 *                  popFruit(i, quiet), dropFruit(i), bounce(), setMotion({ reduced }), setDim(k), onLeafFall,
 *                  flowerWorld(i), topWorld(), leafWorld(i), busy() }
 *
 * Builders: tree, stalk, vine, bush, hangingBush, groundRosette, rootCrop, grassClump, fungus (catalog.BUILDERS).
 * Each builds, in LOCAL units at size 1 (crop origin = soil surface centre, +Y up, +Z toward the camera):
 *   - stemLeaves: ONE geometry (stems/solids first, then hideable leaves in order) with attributes
 *     position, normal, color (linear, lush colours), aLeaf (1 leaf / 0 stem), aH (0..1 height);
 *   - fruitGeo: one fruit, white-ish vertex shading; instance colour = unripe → ripe (§3.4);
 *   - flowerGeo: one flower with absolute vertex colours (sunflower: white petals tinted per instance);
 *   - anchors: { p: Vector3, q: Quaternion, s: number } — fruit anchors are filled in a FIXED order (§3.4).
 *
 * Rendering (§9.8): each crop is 1 stem/leaves Mesh (gfx/materials cropMaterial: bend, droop, sway, shiver,
 * tint, frost, desaturate in one shader; its depth twin is the customDepthMaterial so shadows bend too)
 * + one fruit InstancedMesh (6 hanging + 6 dropped) + one flower InstancedMesh. Fruit and flowers follow the
 * shader's bend through a CPU mirror of the same maths (`bendPoint`).
 *
 * Growth numbers are NEVER computed here. setGrowth() receives stage()'s size/health/fruit/flower from the
 * PlotView (field/growth.js maps them to droop/tint/ripeness with the shared formulas) — §3.4.
 * Leaf thinning (§3.4 "Leaf count"): leaves with index ≥ ceil(N·(0.4 + 0.6·health)) are hidden through the
 * geometry draw range after `onLeafFall(worldPos)` lets the plot drop a falling-leaf particle.
 */

import {
  BackSide,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  Quaternion,
  TorusGeometry,
  Vector3,
} from '../three.js';
import { lathe, tubeAlong, leafStrip, lowpolySphere, merge, paint, fillAttr, heightAttr, vertexAO, flat, rng, noise3, cone } from '../gfx/geom.js';
import { cropMaterial, toonGradient, sharedUniforms, propMaterial } from '../gfx/materials.js';
import { cropFor, BUILDERS, CROPS } from './catalog.js';
import { createSpring, createTween, popScale, EASE, pulse, hash01 } from '../field/anim.js';
import { droopOf, leafKeepCount, ripeness } from '../field/growth.js';

// ------------------------------------------------------------------ small maths + colour helpers

const TAU = Math.PI * 2;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const lerp = (a, b, k) => a + (b - a) * k;
const V = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
const WHITE = new Color(1, 1, 1);
const BLACK = new Color(0, 0, 0);
const _m = new Matrix4();
const _m2 = new Matrix4();
const _c = new Color();
const _c2 = new Color();

/** sRGB hex string/number → linear Color (new). */
const col = (hex) => new Color(hex);
/** Lighten (k > 0) or darken (k < 0) a colour. Returns a NEW Color. */
function shade(hex, k) {
  const c = col(hex);
  return k >= 0 ? c.lerp(WHITE, k) : c.lerp(BLACK, -k);
}
/** Mix two colours (new). */
function mixc(a, b, k) {
  return col(a).lerp(col(b), clamp(k, 0, 1));
}
const hexNum = (h) => (typeof h === 'number' ? h : parseInt(String(h).slice(1), 16));

/**
 * Place a geometry: scale → roll (Z) → pitch (X) → yaw (Y) → translate. A leaf built along +Z with
 * `pitch = −elevation` and `yaw = θ` points outward at angle θ (from +Z, counter-clockwise from above).
 */
function place(geo, { s = 1, roll = 0, pitch = 0, yaw = 0, p = [0, 0, 0] } = {}) {
  const S = typeof s === 'number' ? [s, s, s] : s;
  _m.makeScale(S[0], S[1], S[2]);
  if (roll) _m.premultiply(_m2.makeRotationZ(roll));
  if (pitch) _m.premultiply(_m2.makeRotationX(pitch));
  if (yaw) _m.premultiply(_m2.makeRotationY(yaw));
  const P = p.isVector3 ? [p.x, p.y, p.z] : p;
  _m.premultiply(_m2.makeTranslation(P[0], P[1], P[2]));
  geo.applyMatrix4(_m);
  return geo;
}

/** Unit direction for a yaw (around +Y, from +Z) and an elevation above the horizontal. */
function dirOf(yaw, elev) {
  return V(Math.sin(yaw) * Math.cos(elev), Math.sin(elev), Math.cos(yaw) * Math.cos(elev));
}

/** Quaternion turning +Z onto `n` (flowers / facing fruits). */
function faceQ(n) {
  return new Quaternion().setFromUnitVectors(V(0, 0, 1), n.clone().normalize());
}
const yawQ = (a) => new Quaternion().setFromAxisAngle(V(0, 1, 0), a);

/** Non-indexed copy with position/normal/color only (+ given aLeaf). */
function prep(geo, leaf) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.color) paint(g, 0xffffff);
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(name)) g.deleteAttribute(name);
  fillAttr(g, 'aLeaf', leaf);
  return g;
}

/** Paint with a function of the local position; returns the geometry. */
function paintFn(geo, fn) {
  return paint(geo, (x, y, z, i) => fn(x, y, z, i));
}

// ------------------------------------------------------------------ assembly (stems first, leaves last)

/**
 * Collects crop parts in draw order: `stem()` / `solid()` parts are always drawn; `leaf()` parts can be
 * thinned from the end (leaf N−1 first). `build()` merges them and adds aH + vertex AO.
 */
function assembler(height) {
  const prefix = [];
  const leaves = [];
  return {
    height,
    /** Stem/trunk/pole/log (aLeaf 0: browns at half strength). */
    stem(geo, color) {
      if (color !== undefined) typeof color === 'function' ? paintFn(geo, color) : paint(geo, color);
      prefix.push(prep(geo, 0));
    },
    /** Always-drawn foliage mass (canopy blobs, bush body): tinted like leaves, never thinned. */
    solid(geo, color, leaf = 1) {
      if (color !== undefined) typeof color === 'function' ? paintFn(geo, color) : paint(geo, color);
      prefix.push(prep(geo, leaf));
    },
    /** One hideable leaf; `base` is its attachment point (falling-leaf particles start there). */
    leaf(geo, base, color) {
      if (color !== undefined) typeof color === 'function' ? paintFn(geo, color) : paint(geo, color);
      leaves.push({ g: prep(geo, 1), base: base.clone() });
    },
    get leafCount() {
      return leaves.length;
    },
    build() {
      const list = [...prefix, ...leaves.map((l) => l.g)];
      let leafStart = 0;
      for (const g of prefix) leafStart += g.attributes.position.count;
      const leafEnds = [];
      let acc = leafStart;
      for (const l of leaves) {
        acc += l.g.attributes.position.count;
        leafEnds.push(acc);
      }
      const geo = merge(list, { dispose: true });
      heightAttr(geo, { height });
      vertexAO(geo, { min: 0.74, top: Math.min(0.5, height * 0.4) });
      geo.computeBoundingSphere();
      return { geo, leafStart, leafEnds, leafBases: leaves.map((l) => l.base) };
    },
  };
}

// ------------------------------------------------------------------ part makers

/** A leaf blade along +Z, painted dark at the base → light at the tip, then placed. */
function bladeLeaf({ len = 0.5, width = 0.25, curl = 0.25, fold = 0.35, tip = 0, seg = 4, color, yaw = 0, elev = 0.3, roll = 0, at }) {
  const g = leafStrip({ length: len, width, segments: seg, curl, fold, tip });
  const base = shade(color, -0.18);
  const top = shade(color, 0.12);
  paintFn(g, (x, y, z) => _c.copy(base).lerp(top, clamp(z / len, 0, 1)));
  return place(g, { roll, pitch: -elev, yaw, p: at });
}

/** A smooth stem tube through points with a radius taper r0 → r1. */
function stemTube(points, r0, r1, seg = 5, caps = true) {
  return tubeAlong(points, (t) => lerp(r0, r1, t), seg, { caps });
}

/** Sample n points of a quadratic Bézier a → c with control b. */
function bez(a, b, c, n = 6) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push(V(u * u * a.x + 2 * u * t * b.x + t * t * c.x, u * u * a.y + 2 * u * t * b.y + t * t * c.y, u * u * a.z + 2 * u * t * b.z + t * t * c.z));
  }
  return out;
}

/** Point at parameter t of a polyline (by index, good enough for evenly sampled curves). */
function along(pts, t) {
  const f = clamp(t, 0, 1) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(f));
  return pts[i].clone().lerp(pts[i + 1], f - i);
}

/** Helix around +Y: radius r, `turns`, from y0 to y1, phase ph, wobble. */
function helix(r, turns, y0, y1, ph = 0, n = 28, wobble = 0, seed = 1) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = ph + t * turns * TAU;
    const rr = r * (1 + wobble * noise3(t * 4, seed, 0));
    out.push(V(Math.cos(a) * rr, lerp(y0, y1, t), Math.sin(a) * rr));
  }
  return out;
}

/** A small 5-ish petal blossom facing +Z (petals `color`, centre `center`). */
function blossom({ petals = 5, len = 0.09, width = 0.07, color = '#FFFFFF', center = '#F4D35E', cup = 0.25, centerR = 0.03 }) {
  const parts = [];
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * TAU;
    const g = leafStrip({ length: len, width, segments: 2, curl: -cup * 0.4, fold: 0.15, tip: 0.6 });
    paint(g, shade(color, 0.05));
    // petal along +Z → rotate so it lies in the XY plane, pointing outward at angle a, cupped toward +Z
    place(g, { pitch: Math.PI / 2 - cup, p: [0, 0, 0] });
    place(g, { roll: a });
    parts.push(g);
  }
  const c = lowpolySphere(centerR, 0, { jitter: 0.05 });
  paint(c, center);
  place(c, { s: [1, 1, 0.6], p: [0, 0, 0.01] });
  parts.push(c);
  return merge(parts.map((g) => prep(g, 0)), { dispose: true });
}

/** Clean up a fruit/flower geometry to position/normal/color. */
function cleanGeo(g) {
  const out = prep(g, 0);
  out.deleteAttribute('aLeaf');
  out.computeBoundingSphere();
  return out;
}

/** Merge a list of painted parts into one clean geometry. */
function mergeClean(parts) {
  const g = merge(parts.map((p) => prep(p, 0)), { dispose: true });
  return cleanGeo(g);
}

const A = (p, q = new Quaternion(), s = 1) => ({ p, q, s });

// ------------------------------------------------------------------ fruits (white-ish shading; instance colour = unripe → ripe)

/**
 * True while buildParts() builds a Medium- or Low-tier crop: the clustered and lathed fruits (grapes, berries,
 * pumpkin) use coarser spheres / fewer segments there, so ten grown crops stay within the tier's triangle budget
 * (PLATFORM QA-07). High keeps the full detail.
 * Builds are synchronous, so a module flag is safe.
 */
let FRUIT_LO = false;

const FRUIT = {
  /** BTC: icosphere r 0.18 hanging under its anchor, with a tiny dark stalk. */
  orange() {
    const s = lowpolySphere(0.18, 1, { jitter: 0.05, seed: 3 });
    paintFn(s, (x, y) => _c.setScalar(1).lerp(_c2.setScalar(0.86), clamp(-y / 0.18, 0, 1) * 0.6));
    place(s, { p: [0, -0.17, 0] });
    const nub = cone(0.03, 0.07, 5);
    paint(nub, 0x3a3a3a);
    place(nub, { p: [0, -0.04, 0] });
    return mergeClean([s, nub]);
  },
  /** ETH: 8-seg lathe teardrop, flat-shaded, with a dark calyx. */
  teardrop() {
    const prof = [[0.0, 0], [0.035, -0.02], [0.065, -0.07], [0.095, -0.16], [0.115, -0.26], [0.11, -0.34], [0.075, -0.4], [0.03, -0.425], [0, -0.43]];
    const g = lathe(prof, 8, { flat: true });
    paintFn(g, (x, y) => _c.setScalar(lerp(0.96, 1.08, clamp((-y - 0.1) / 0.3, 0, 1))));
    const cal = cone(0.07, 0.08, 6);
    place(cal, { pitch: Math.PI, p: [0, 0.02, 0] });
    paint(cal, 0x2c2c2c);
    return mergeClean([g, cal]);
  },
  /** SOL: a side mini-head facing +Z (dark centre + petal ring), tinted per instance. */
  miniHead() {
    const parts = [];
    const disc = new CylinderGeometry(0.1, 0.1, 0.04, 10);
    place(disc, { pitch: Math.PI / 2 });
    paintFn(disc, (x, y, z) => (z > 0.015 ? _c.setScalar(0.42) : _c.setScalar(0.75)));
    parts.push(disc);
    for (let i = 0; i < 9; i++) {
      const g = leafStrip({ length: 0.1, width: 0.06, segments: 2, curl: 0.05, fold: 0.1, tip: 0.5 });
      paint(g, 0xffffff);
      place(g, { pitch: -Math.PI / 2 + 0.1 }); // along +Z → pointing +Y in the XY plane
      g.translate(0, 0.085, 0); // out to the rim
      place(g, { roll: (i / 9) * TAU });
      parts.push(g);
    }
    return mergeClean(parts);
  },
  /** HYPE: hop cone = stacked cones hanging down. */
  hopCone() {
    const parts = [];
    for (let i = 0; i < 4; i++) {
      const r = 0.075 - i * 0.012;
      const c = cone(r, 0.07, 6);
      place(c, { pitch: Math.PI, yaw: i * 0.5, p: [0, -0.02 - i * 0.045, 0] });
      paint(c, i % 2 ? 0xf2f2f2 : 0xffffff);
      parts.push(c);
    }
    const st = stemTube([V(0, 0.02, 0), V(0, -0.03, 0)], 0.008, 0.008, 4);
    paint(st, 0x404040);
    parts.push(st);
    return mergeClean(parts);
  },
  /** XRP: a bent grain chain drooping from a blade tip. */
  grainChain() {
    const parts = [];
    const pts = bez(V(0, 0, 0), V(0.0, 0.06, 0.12), V(0, -0.12, 0.22), 7);
    const st = tubeAlong(pts, 0.006, 3, { caps: false });
    paint(st, 0x9a9a7a);
    parts.push(st);
    for (let i = 1; i < pts.length; i++) {
      const g = lowpolySphere(0.022, 0, { jitter: 0.08, seed: i, squash: [0.8, 1.3, 0.8] });
      paint(g, i % 2 ? 0xffffff : 0xf0f0e8);
      place(g, { p: pts[i].clone().add(V(i % 2 ? 0.018 : -0.018, -0.01, 0)) });
      parts.push(g);
    }
    return mergeClean(parts);
  },
  /** DOGE: husked cob tilted along +Y, kernels bumpy, dark husk at the base. */
  cob() {
    const prof = [[0, -0.02], [0.05, 0], [0.075, 0.08], [0.08, 0.2], [0.07, 0.3], [0.045, 0.37], [0, 0.4]];
    const g = lathe(prof, 9, { flat: true });
    paintFn(g, (x, y, z, i) => _c.setScalar(0.88 + 0.12 * ((i * 7) % 3 === 0 ? 1 : 0.6)));
    const parts = [g];
    for (let k = 0; k < 3; k++) {
      const h = leafStrip({ length: 0.3, width: 0.09, segments: 3, curl: -0.15, fold: 0.4, tip: 0 });
      paint(h, 0x5a6a3a);
      place(h, { pitch: -1.35, yaw: (k / 3) * TAU, p: [0, 0, 0] });
      h.translate(Math.sin((k / 3) * TAU) * 0.05, 0, Math.cos((k / 3) * TAU) * 0.05);
      parts.push(h);
    }
    return mergeClean(parts);
  },
  /** AVAX: a curved hanging cone (chili) with a calyx. */
  chili() {
    const pts = bez(V(0, 0, 0), V(0.0, -0.12, 0.02), V(0.06, -0.24, 0.0), 7);
    const g = tubeAlong(pts, (t) => lerp(0.04, 0.006, Math.pow(t, 1.3)), 6, { caps: true });
    paint(g, 0xffffff);
    const cal = cone(0.045, 0.05, 6);
    place(cal, { pitch: Math.PI, p: [0, 0.03, 0] });
    paint(cal, 0x2f3a2a);
    return mergeClean([g, cal]);
  },
  /** LINK: pea pod = capsule + 4 bumps, hanging diagonally. */
  pod() {
    const prof = [[0, -0.15], [0.03, -0.14], [0.042, -0.08], [0.045, 0], [0.042, 0.08], [0.03, 0.14], [0, 0.15]];
    const g = lathe(prof, 7, { flat: true });
    paint(g, 0xffffff);
    const parts = [g];
    for (let i = 0; i < 4; i++) {
      const b = lowpolySphere(0.034, 0, { jitter: 0.05, seed: i + 2 });
      paint(b, 0xf2f2f2);
      place(b, { p: [0.012, -0.1 + i * 0.066, 0.012] });
      parts.push(b);
    }
    const out = mergeClean(parts);
    place(out, { roll: 0.5, p: [0.03, -0.15, 0] });
    return out;
  },
  /** SUI: striped ellipsoid lying on the soil (stripes along its long axis). */
  melon() {
    // an oblong melon (1.75 : 0.82): it must not read as the round pumpkin from the default camera (QA-05)
    const g = lowpolySphere(0.24, 1, { jitter: 0.04, seed: 5, squash: [1.75, 0.82, 0.95] });
    paintFn(g, (x, y, z) => {
      const a = Math.atan2(z, y);
      return _c.setScalar(Math.sin(a * 5 + x * 6) > 0.35 ? 0.66 : 1);
    });
    place(g, { p: [0, 0.2, 0] });
    return cleanGeo(g);
  },
  /** ZEC: zucchini capsule lying along X with a dark stem end. */
  zucchini() {
    const prof = [[0, -0.26], [0.045, -0.24], [0.07, -0.15], [0.078, 0], [0.072, 0.15], [0.055, 0.24], [0.02, 0.27], [0.012, 0.31]];
    const g = lathe(prof, 8, { flat: true });
    paintFn(g, (x, y, z, i) => _c.setScalar(y > 0.25 ? 0.4 : 0.92 + 0.08 * Math.sin(Math.atan2(z, x) * 4)));
    place(g, { roll: Math.PI / 2 - 0.05, p: [0, 0.075, 0] });
    return cleanGeo(g);
  },
  /** PUMP: 8-rib lathe pumpkin with a curly dark stem. */
  pumpkin() {
    const prof = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const a = -Math.PI / 2 + t * Math.PI;
      prof.push([Math.max(0.0001, Math.cos(a) * 0.25), Math.sin(a) * 0.17 + 0.17]);
    }
    const g = lathe(prof, FRUIT_LO ? 12 : 24, { flat: false });
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const r = Math.hypot(x, z);
      if (r < 1e-4) continue;
      const k = 1 - 0.09 * Math.pow(Math.abs(Math.cos(Math.atan2(z, x) * 4)), 0.5);
      pos.setX(i, x * k);
      pos.setZ(i, z * k);
    }
    g.computeVertexNormals();
    paintFn(g, (x, y, z) => _c.setScalar(0.86 + 0.14 * Math.abs(Math.sin(Math.atan2(z, x) * 4))));
    const stem = tubeAlong(helix(0.03, 0.9, 0.32, 0.43, 0, 8), 0.016, 4, { caps: true });
    paint(stem, 0x3b4a2a);
    return mergeClean([g, stem]);
  },
  /** NEAR: orange shoulders poking out of the soil (cone pointing down). */
  shoulder() {
    const g = cone(0.09, 0.42, 8);
    place(g, { pitch: Math.PI, p: [0, 0.1, 0] });
    paintFn(g, (x, y) => _c.setScalar(y > 0.0 ? 1 : 0.8));
    const top = lowpolySphere(0.088, 0, { jitter: 0.03, squash: [1, 0.35, 1] });
    paint(top, 0xf4f4f4);
    place(top, { p: [0, 0.1, 0] });
    return mergeClean([g, top]);
  },
  /** ARB: 5-berry cluster. */
  berries() {
    const parts = [];
    const pos = [[0, -0.05, 0], [0.06, -0.06, 0.02], [-0.055, -0.065, 0.025], [0.02, -0.11, 0.03], [-0.02, -0.08, -0.05]];
    pos.forEach((p, i) => {
      const b = lowpolySphere(0.05, FRUIT_LO ? 0 : 1, { jitter: 0.04, seed: i + 7 });
      paintFn(b, (x, y) => _c.setScalar(y > 0.03 ? 0.78 : 1));
      place(b, { p });
      parts.push(b);
    });
    return mergeClean(parts);
  },
  /** TIA: lavender bloom bundle. */
  bloomBundle() {
    const parts = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      const b = lowpolySphere(0.04, 0, { jitter: 0.08, seed: i + 11 });
      paint(b, i % 2 ? 0xffffff : 0xeeeeee);
      place(b, { p: [Math.cos(a) * 0.05, -0.03 - (i % 3) * 0.03, Math.sin(a) * 0.05] });
      parts.push(b);
    }
    const st = stemTube([V(0, 0.02, 0), V(0, -0.06, 0)], 0.008, 0.006, 4);
    paint(st, 0x557a4a);
    parts.push(st);
    return mergeClean(parts);
  },
  /** VVV: 9-sphere cone cluster (4 + 3 + 2) hanging. */
  grapes() {
    const parts = [];
    const rows = [4, 3, 2];
    let k = 0;
    rows.forEach((n, r) => {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + r * 0.6;
        const rr = 0.055 * (n - 1) * 0.55;
        const b = lowpolySphere(0.052, FRUIT_LO ? 0 : 1, { jitter: 0.03, seed: ++k });
        paintFn(b, (x, y) => _c.setScalar(y > 0.025 ? 0.8 : 1));
        place(b, { p: [Math.cos(a) * rr, -0.05 - r * 0.075, Math.sin(a) * rr] });
        parts.push(b);
      }
    });
    const st = stemTube([V(0, 0.02, 0), V(0, -0.05, 0)], 0.01, 0.008, 4);
    paint(st, 0x5a4a3a);
    parts.push(st);
    return mergeClean(parts);
  },
  /** WIF: baby mushroom (short stalk + dotted cap). */
  babyMushroom() {
    const stalk = cone(0.035, 0.1, 6);
    paint(stalk, 0xf6f0e6);
    const cap = lathe([[0.0001, 0.16], [0.04, 0.155], [0.07, 0.13], [0.085, 0.1], [0.06, 0.09], [0.0001, 0.095]], 9, { flat: true });
    paintFn(cap, (x, y, z, i) => _c.setScalar(noise3(x * 40, y * 40, z * 40) > 0.35 && y > 0.12 ? 1.25 : 0.86));
    return mergeClean([stalk, cap]);
  },
  /** fallback beanstalk: long green bean pod, hanging and curved. */
  beanPod() {
    const pts = bez(V(0, 0, 0), V(0.04, -0.14, 0.01), V(0.0, -0.32, 0.03), 8);
    const g = tubeAlong(pts, (t) => 0.03 * Math.sin(Math.PI * clamp(t * 0.95 + 0.04, 0, 1)) + 0.004, 6, { caps: true });
    paint(g, 0xffffff);
    return cleanGeo(g);
  },
};

// ------------------------------------------------------------------ flowers (absolute vertex colours)

const FLOWER = {
  blossom: (crop, o = {}) => cleanGeo(blossom({ color: crop.flower, center: crop.accent && /^#F/i.test(crop.accent) ? crop.accent : '#F4D35E', ...o })),
  star: (crop) => cleanGeo(blossom({ petals: 5, len: 0.1, width: 0.05, color: crop.flower, center: '#F2D24B', cup: 0.1 })),
  bell: (crop) => {
    const g = lathe([[0.0001, 0.0], [0.03, -0.01], [0.045, -0.05], [0.05, -0.09], [0.06, -0.1]], 7, { flat: true });
    paint(g, crop.flower);
    place(g, { pitch: -Math.PI / 2 });
    return cleanGeo(g);
  },
  trumpet: (crop) => {
    const g = lathe([[0.0001, 0], [0.02, 0.01], [0.03, 0.06], [0.06, 0.11], [0.11, 0.14]], 10, { flat: true });
    paintFn(g, (x, y) => mixc(crop.flower, '#E8A33A', clamp(1 - y / 0.1, 0, 1) * 0.45));
    place(g, { pitch: Math.PI / 2 });
    return cleanGeo(g);
  },
  tassel: (crop) => {
    const parts = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      const pts = bez(V(0, 0, 0), V(Math.cos(a) * 0.05, 0.1, Math.sin(a) * 0.05), V(Math.cos(a) * 0.14, 0.12, Math.sin(a) * 0.14), 4);
      const t = tubeAlong(pts, 0.008, 3, { caps: false });
      paint(t, crop.flower);
      parts.push(t);
    }
    const c = stemTube([V(0, 0, 0), V(0, 0.2, 0)], 0.01, 0.006, 3);
    paint(c, crop.flower);
    parts.push(c);
    const g = mergeClean(parts);
    place(g, { pitch: Math.PI / 2 });
    return g;
  },
  petalRing: () => {
    // sunflower head petals (white: tinted per instance unripe → ripe), facing +Z, around a 0.42 disc
    const parts = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const g = leafStrip({ length: 0.3, width: 0.13, segments: 3, curl: 0.12, fold: 0.18, tip: 0.2 });
      paint(g, 0xffffff);
      // along +Z → lay into the XY plane pointing +Y, then roll around Z
      place(g, { pitch: -Math.PI / 2 + 0.12 });
      g.translate(0, 0.38, 0);
      place(g, { roll: a });
      parts.push(g);
    }
    return mergeClean(parts);
  },
  umbel: (crop) => {
    const parts = [];
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU;
      const r = i === 0 ? 0 : 0.06;
      const d = lowpolySphere(0.026, 0, { jitter: 0.05, seed: i });
      paint(d, crop.flower);
      place(d, { s: [1, 1, 0.5], p: [Math.cos(a) * r, Math.sin(a) * r, 0] });
      parts.push(d);
    }
    return mergeClean(parts);
  },
  puff: (crop) => {
    const parts = [];
    for (let i = 0; i < 4; i++) {
      const d = lowpolySphere(0.03, 0, { jitter: 0.1, seed: i + 3 });
      paint(d, crop.flower);
      place(d, { p: [(i % 2 ? 1 : -1) * 0.025, Math.floor(i / 2) * 0.03, 0] });
      parts.push(d);
    }
    return mergeClean(parts);
  },
};

// ------------------------------------------------------------------ the 9 builders

/** Detail multipliers by tier (leaf count / segments). */
const DETAIL = { high: 1, medium: 0.85, low: 0.6 };
const cnt = (n, d) => Math.max(2, Math.round(n * d));

/** Spread n anchors over a canopy blob surface (front/side hemisphere). */
function canopyAnchors(blobs, n, r, { hang = true, minY = -0.3, maxY = 0.5, s = 1 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = blobs[i % blobs.length];
    const yaw = -1.2 + ((i * 0.618) % 1) * 2.4 + (i % 2 ? 0.2 : -0.1);
    const el = lerp(minY, maxY, ((i * 0.37 + 0.2) % 1));
    const d = dirOf(yaw, el);
    const p = b.c.clone().addScaledVector(d, b.r * (hang ? 0.95 : 0.98));
    out.push(A(p, hang ? yawQ(r() * TAU) : faceQ(d), s));
  }
  return out;
}

const BUILD = {
  /** BTC orange tree: tapered trunk; canopy of 3 jittered icospheres (detail 1). */
  tree(crop, { r, d }) {
    const H = crop.height;
    const asm = assembler(H);
    const trunkPts = bez(V(0, -0.05, 0), V(0.08, 0.8, -0.02), V(0.02, 1.75, 0.02), 6);
    asm.stem(stemTube(trunkPts, 0.17, 0.08, 7), (x, y) => mixc(shade(crop.stem, -0.25), crop.stem, clamp(y / 0.8, 0, 1)));
    const blobs = [
      { c: V(-0.48, 2.05, 0.08), r: 0.74 },
      { c: V(0.5, 2.0, -0.04), r: 0.7 },
      { c: V(0.02, 2.48, -0.12), r: 0.7 },
    ];
    for (const b of blobs) {
      const br = bez(V(0.03, 1.45, 0), V(b.c.x * 0.5, 1.75, b.c.z * 0.5), b.c.clone().multiplyScalar(0.85).setY(b.c.y - 0.2), 4);
      asm.stem(stemTube(br, 0.07, 0.04, 5), crop.stem);
    }
    blobs.forEach((b, i) => {
      const s = lowpolySphere(b.r, 1, { jitter: 0.2, seed: 11 + i });
      place(s, { p: b.c });
      const lo = shade(crop.leaf, -0.3);
      const hi = shade(crop.leaf, 0.04);
      asm.solid(s, (x, y) => _c.copy(lo).lerp(hi, clamp((y - b.c.y + b.r) / (2 * b.r), 0, 1)));
    });
    const nLeaves = cnt(12, d);
    for (let i = 0; i < nLeaves; i++) {
      const b = blobs[i % 3];
      const yaw = (i / nLeaves) * TAU * 1.7 + r() * 0.4;
      const el = lerp(-0.35, 0.75, r());
      const dir = dirOf(yaw, el);
      const at = b.c.clone().addScaledVector(dir, b.r * 0.92);
      asm.leaf(bladeLeaf({ len: 0.34, width: 0.2, curl: 0.15, color: crop.leaf, yaw, elev: el * 0.6, at }), at);
    }
    const fruitAnchors = canopyAnchors(blobs, 6, r, { minY: -0.35, maxY: 0.35 });
    const flowerAnchors = canopyAnchors(blobs, 5, r, { hang: false, minY: 0.0, maxY: 0.7 }).map((a, i) => {
      a.p.addScaledVector(a.p.clone().sub(blobs[i % 3].c).normalize(), 0.05);
      return a;
    });
    return { asm, fruitGeo: FRUIT.orange(), flowerGeo: FLOWER.blossom(crop, { len: 0.1, width: 0.08 }), fruitAnchors, flowerAnchors };
  },

  /** SOL sunflower (tall stem, 2 big leaves, disc head + 12 petals) and DOGE corn (2–3 strap-leaf stalks). */
  stalk(crop, { r, d }) {
    const H = crop.height;
    const asm = assembler(H);
    if (crop.variant === 'sunflower') {
      const pts = bez(V(0, -0.05, 0), V(0.18, 1.3, 0.05), V(0.05, 2.4, 0.18), 8);
      asm.stem(stemTube(pts, 0.075, 0.05, 6), (x, y) => mixc(shade(crop.stem, -0.2), crop.stem, clamp(y / 1.2, 0, 1)));
      const top = pts[pts.length - 1];
      const n = dirOf(0.12, 0.62); // head turned up and toward the camera (the sun is high in the south)
      // domed seed head: concentric seed rings on the face, green bracts on the back
      const head = lathe([[0.0001, 0.07], [0.08, 0.075], [0.16, 0.07], [0.24, 0.06], [0.32, 0.045], [0.4, 0.02], [0.42, -0.01], [0.36, -0.05], [0.18, -0.07], [0.0001, -0.075]], 18, { flat: true });
      place(head, { pitch: Math.PI / 2 });
      const centre = shade(crop.accent, -0.25);
      const back = col(crop.stem);
      const ringC = col('#8E5F2C');
      const rim = col('#C99A3A');
      paintFn(head, (x, y, z) => {
        if (z < 0.0) return _c.copy(back);
        const rr = Math.hypot(x, y);
        if (rr > 0.36) return _c.copy(rim);
        return Math.floor(rr / 0.07) % 2 ? _c.copy(centre) : _c.copy(ringC);
      });
      const hq = faceQ(n);
      head.applyQuaternion(hq);
      head.translate(top.x, top.y, top.z);
      asm.solid(head, undefined, 0);
      // leaves: 2 big first (kept longest), then smaller ones (thinned first)
      const leafSpec = [
        { t: 0.38, len: 0.95, w: 0.55, yaw: 1.3 },
        { t: 0.55, len: 0.85, w: 0.5, yaw: -1.6 },
        { t: 0.25, len: 0.55, w: 0.34, yaw: -0.6 },
        { t: 0.7, len: 0.5, w: 0.3, yaw: 0.6 },
        { t: 0.15, len: 0.42, w: 0.26, yaw: 2.4 },
        { t: 0.82, len: 0.38, w: 0.22, yaw: -2.6 },
      ].slice(0, cnt(6, d));
      for (const L of leafSpec) {
        const at = along(pts, L.t);
        asm.leaf(bladeLeaf({ len: L.len, width: L.w, curl: 0.4, fold: 0.3, color: crop.leaf, yaw: L.yaw, elev: 0.35, at }), at);
      }
      const fruitAnchors = [];
      for (let i = 0; i < 6; i++) {
        const t = 0.3 + i * 0.09;
        const p = along(pts, t);
        const yaw = (i % 2 ? 1 : -1) * (0.9 + 0.25 * i) + 0.2;
        const dir = dirOf(yaw, 0.1);
        fruitAnchors.push(A(p.clone().addScaledVector(dir, 0.12), faceQ(dir.clone().add(V(0, 0, 0.6))), 1));
      }
      const flowerAnchors = [A(top.clone().addScaledVector(n, 0.06), hq.clone(), 1)];
      return { asm, fruitGeo: FRUIT.miniHead(), flowerGeo: FLOWER.petalRing(), fruitAnchors, flowerAnchors, flowerTint: 'ripe' };
    }
    // corn
    const stalks = [
      { b: V(-0.32, 0, 0.05), h: 2.35, lean: V(-0.1, 0, 0) },
      { b: V(0.3, 0, -0.12), h: 2.15, lean: V(0.12, 0, -0.05) },
      { b: V(0.02, 0, 0.38), h: 1.85, lean: V(0.02, 0, 0.12) },
    ].slice(0, d < 0.7 ? 2 : 3);
    const curves = stalks.map((s) => bez(s.b, s.b.clone().add(V(0, s.h * 0.5, 0)), s.b.clone().add(s.lean).setY(s.h), 7));
    curves.forEach((pts) => asm.stem(stemTube(pts, 0.065, 0.03, 6), (x, y) => mixc(shade(crop.stem, -0.15), shade(crop.stem, 0.08), clamp(y / 2, 0, 1))));
    const per = cnt(4, d);
    const leafList = [];
    curves.forEach((pts, si) => {
      for (let i = 0; i < per; i++) {
        const t = 0.18 + i * 0.17;
        leafList.push({ at: along(pts, t), yaw: si * 2.1 + i * 2.4 + r() * 0.5, len: 0.95 - i * 0.12, order: i });
      }
    });
    leafList.sort((a, b) => a.order - b.order); // upper leaves last → thinned first
    for (const L of leafList) {
      asm.leaf(bladeLeaf({ len: L.len, width: 0.15, curl: 0.55, fold: 0.45, color: crop.leaf, yaw: L.yaw, elev: 0.55, at: L.at }), L.at);
    }
    const fruitAnchors = [];
    for (let i = 0; i < 6; i++) {
      const pts = curves[i % curves.length];
      const t = 0.36 + Math.floor(i / curves.length) * 0.14;
      const p = along(pts, t);
      const yaw = (i * 2.3 + 0.4) % TAU;
      const out = dirOf(yaw, 0);
      const q = new Quaternion().setFromAxisAngle(V(out.z, 0, -out.x).normalize(), 0.45);
      fruitAnchors.push(A(p.clone().addScaledVector(out, 0.07), q, 1));
    }
    const flowerAnchors = curves.map((pts) => A(pts[pts.length - 1].clone(), new Quaternion().setFromAxisAngle(V(1, 0, 0), -Math.PI / 2), 1));
    return { asm, fruitGeo: FRUIT.cob(), flowerGeo: FLOWER.tassel(crop), fruitAnchors, flowerAnchors };
  },

  /** HYPE hops (pole + spiral vine), LINK peas (cane), VVV grapes (V trellis), fallback beanstalk. */
  vine(crop, { r, d }) {
    const H = crop.height;
    const asm = assembler(H);
    const v = crop.variant;
    const vines = [];
    if (v === 'hops' || v === 'peas') {
      const poleH = v === 'hops' ? H : H * 0.98;
      const poleR = v === 'hops' ? 0.05 : 0.028;
      asm.stem(stemTube([V(0, -0.1, -0.05), V(0, poleH, -0.05)], poleR, poleR * 0.8, 6), (x, y, z, i) => (v === 'peas' && Math.abs((y * 3) % 1) < 0.06 ? shade(crop.accent, -0.3) : col(crop.accent)));
      const turns = v === 'hops' ? 2.3 : 3.2;
      vines.push(helix(v === 'hops' ? 0.13 : 0.09, turns, 0.02, poleH * 0.96, 0.4, 36, 0.35, 3).map((p) => p.add(V(0, 0, -0.05))));
    } else if (v === 'grapes') {
      for (const sx of [-1, 1]) {
        asm.stem(stemTube([V(sx * 0.14, -0.1, -0.1), V(sx * 1.0, H * 0.96, -0.2)], 0.045, 0.035, 6), crop.accent);
        const base = V(sx * 0.14, 0, -0.1);
        const tip = V(sx * 1.0, H * 0.94, -0.2);
        const pts = [];
        for (let i = 0; i <= 24; i++) {
          const t = i / 24;
          const p = base.clone().lerp(tip, t);
          p.x += Math.sin(t * 18 + sx) * 0.06;
          p.z += Math.cos(t * 18 + sx) * 0.06 + 0.04;
          pts.push(p);
        }
        vines.push(pts);
      }
      asm.stem(stemTube([V(-0.62, 1.4, -0.16), V(0.62, 1.4, -0.16)], 0.012, 0.012, 4), 0x9a9a9a);
    } else {
      // beanstalk: a thick twisting stalk, no pole
      const pts = [];
      for (let i = 0; i <= 30; i++) {
        const t = i / 30;
        pts.push(V(Math.sin(t * 7) * 0.16 * (0.4 + t), t * H * 0.97, Math.cos(t * 7) * 0.12 * (0.4 + t)));
      }
      vines.push(pts);
    }
    const vineR = v === 'beanstalk' ? 0.075 : v === 'grapes' ? 0.03 : 0.024;
    vines.forEach((pts) => asm.stem(stemTube(pts, vineR, vineR * 0.55, 5), crop.stem));
    // curly tendrils (peas, beanstalk)
    if (v === 'peas' || v === 'beanstalk') {
      for (let i = 0; i < 4; i++) {
        const at = along(vines[0], 0.25 + i * 0.18);
        const t = helix(0.045, 1.6, 0, 0.12, i, 10).map((p) => p.add(at).add(V(0.06, 0, 0.04)));
        asm.stem(tubeAlong(t, 0.008, 3, { caps: false }), shade(crop.stem, 0.1));
      }
    }
    // leaves along the vines (bottom ones last: thinned first)
    const nLeaves = cnt(v === 'beanstalk' ? 16 : v === 'grapes' ? 12 : 18, d);
    const ls = [];
    for (let i = 0; i < nLeaves; i++) {
      const pts = vines[i % vines.length];
      const t = 0.12 + (0.84 * ((i * 0.618 + 0.3) % 1));
      const at = along(pts, t);
      const out = Math.atan2(at.x, at.z + 0.05) + (r() - 0.5) * 0.8;
      ls.push({ at, yaw: out, t });
    }
    ls.sort((a, b) => b.t - a.t); // upper leaves first (kept), lower leaves last (fall first)
    const big = v === 'grapes' ? 0.55 : v === 'beanstalk' ? 0.48 : v === 'hops' ? 0.46 : 0.36;
    for (const L of ls) {
      asm.leaf(bladeLeaf({ len: big, width: big * (v === 'peas' ? 0.6 : 0.85), curl: 0.3, fold: 0.25, tip: v === 'peas' ? 0.7 : 0, color: crop.leaf, yaw: L.yaw, elev: 0.15, at: L.at }), L.at);
    }
    // anchors
    const fruitAnchors = [];
    for (let i = 0; i < 6; i++) {
      const pts = vines[i % vines.length];
      const t = 0.28 + ((i * 0.37 + 0.11) % 1) * 0.6;
      const p = along(pts, t);
      const out = V(p.x, 0, p.z + 0.08).normalize();
      fruitAnchors.push(A(p.clone().addScaledVector(out, v === 'grapes' ? 0.14 : 0.1), yawQ(r() * TAU), v === 'grapes' ? 1.3 : 1.45));
    }
    const flowerAnchors = [];
    for (let i = 0; i < 4; i++) {
      const pts = vines[i % vines.length];
      const p = along(pts, 0.5 + i * 0.12);
      const out = V(p.x + 0.01, 0.2, p.z + 0.12).normalize();
      flowerAnchors.push(A(p.clone().addScaledVector(out, 0.07), faceQ(out), 1));
    }
    const fruitGeo = v === 'hops' ? FRUIT.hopCone() : v === 'peas' ? FRUIT.pod() : v === 'grapes' ? FRUIT.grapes() : FRUIT.beanPod();
    const flowerGeo = v === 'hops' ? FLOWER.puff(crop) : v === 'grapes' ? FLOWER.puff(crop) : FLOWER.blossom(crop, { petals: v === 'peas' ? 3 : 5, len: 0.08, width: 0.08, cup: 0.5 });
    return { asm, fruitGeo, flowerGeo, fruitAnchors, flowerAnchors };
  },

  /** ARB blueberry (round bush, 5-berry clusters) and TIA tea (glossy round bush, lavender bundles). */
  bush(crop, { r, d }) {
    const H = crop.height;
    const asm = assembler(H);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      asm.stem(stemTube([V(0, -0.05, 0), V(Math.cos(a) * 0.2, 0.35, Math.sin(a) * 0.2)], 0.05, 0.03, 5), crop.stem);
    }
    const glossy = crop.variant === 'tea';
    const blobs = [
      { c: V(0, 0.72, 0), r: 0.5 },
      { c: V(-0.38, 0.58, 0.12), r: 0.38 },
      { c: V(0.4, 0.6, 0.05), r: 0.38 },
      { c: V(0.05, 0.62, 0.36), r: 0.34 },
      { c: V(0.02, 1.02, -0.05), r: 0.32 },
    ];
    blobs.forEach((b, i) => {
      const s = lowpolySphere(b.r, 1, { jitter: glossy ? 0.1 : 0.2, seed: 21 + i });
      place(s, { p: b.c });
      const lo = shade(crop.leaf, -0.36);
      const hi = shade(crop.leaf, glossy ? 0.06 : -0.02);
      asm.solid(s, (x, y, z) => {
        const k = clamp((y - b.c.y + b.r) / (2 * b.r), 0, 1);
        const gl = glossy && y - b.c.y > b.r * 0.62 && z > 0 && noise3(x * 9, y * 9, z * 9) > 0.2 ? 0.3 : 0;
        return _c.copy(lo).lerp(hi, k).lerp(WHITE, gl);
      });
    });
    const nLeaves = cnt(22, d);
    for (let i = 0; i < nLeaves; i++) {
      const b = blobs[i % blobs.length];
      const yaw = r() * TAU;
      const el = lerp(-0.25, 1.0, r());
      const dir = dirOf(yaw, el);
      const at = b.c.clone().addScaledVector(dir, b.r * 0.86);
      asm.leaf(bladeLeaf({ len: 0.3, width: 0.17, curl: 0.2, fold: 0.4, color: shade(crop.leaf, (r() - 0.5) * 0.2), yaw, elev: el * 0.8, at }), at);
    }
    const fruitAnchors = canopyAnchors(blobs.slice(0, 4), 6, r, { minY: -0.1, maxY: 0.45, s: 1.45 }).map((a) => {
      a.p.y += 0.02;
      return a;
    });
    const flowerAnchors = canopyAnchors(blobs, 5, r, { hang: false, minY: 0.2, maxY: 0.8 });
    const fruitGeo = glossy ? FRUIT.bloomBundle() : FRUIT.berries();
    const flowerGeo = glossy ? FLOWER.blossom(crop, { len: 0.07, width: 0.07 }) : FLOWER.bell(crop);
    return { asm, fruitGeo, flowerGeo, fruitAnchors, flowerAnchors };
  },

  /** ETH eggplant (broad leaves on 2 stems, hanging teardrops) and AVAX chili (low bush, hanging cones). */
  hangingBush(crop, { r, d }) {
    const H = crop.height;
    const asm = assembler(H);
    const egg = crop.variant === 'eggplant';
    const stems = egg
      ? [bez(V(-0.05, -0.05, 0), V(-0.25, 0.7, 0.05), V(-0.35, 1.45, 0.0), 7), bez(V(0.05, -0.05, 0), V(0.25, 0.6, -0.05), V(0.38, 1.3, 0.1), 7)]
      : [bez(V(0, -0.05, 0), V(-0.1, 0.4, 0.05), V(-0.35, 0.95, 0.1), 6), bez(V(0, -0.05, 0), V(0.12, 0.45, -0.05), V(0.36, 1.0, 0.02), 6), bez(V(0, -0.05, 0), V(0.02, 0.5, 0.15), V(0.05, 1.1, 0.3), 6)];
    stems.forEach((pts) => asm.stem(stemTube(pts, egg ? 0.06 : 0.04, egg ? 0.03 : 0.02, 5), shade(crop.stem, -0.05)));
    const nLeaves = cnt(egg ? 9 : 13, d);
    const ls = [];
    for (let i = 0; i < nLeaves; i++) {
      const pts = stems[i % stems.length];
      const t = 0.3 + 0.65 * ((i * 0.618 + 0.17) % 1);
      ls.push({ at: along(pts, t), yaw: r() * TAU, t });
    }
    ls.sort((a, b) => b.t - a.t);
    for (const L of ls) {
      asm.leaf(
        bladeLeaf({ len: egg ? 0.58 : 0.3, width: egg ? 0.42 : 0.16, curl: egg ? 0.45 : 0.25, fold: 0.3, color: crop.leaf, yaw: L.yaw, elev: egg ? 0.1 : 0.3, at: L.at }),
        L.at,
      );
    }
    const fruitAnchors = [];
    for (let i = 0; i < 6; i++) {
      const pts = stems[i % stems.length];
      const t = 0.45 + ((i * 0.43 + 0.1) % 1) * 0.45;
      const p = along(pts, t);
      const out = V(p.x, 0, p.z + 0.15).normalize();
      fruitAnchors.push(A(p.clone().addScaledVector(out, 0.12), yawQ(r() * TAU), egg ? 1.4 : 1.5));
    }
    const flowerAnchors = [];
    for (let i = 0; i < 4; i++) {
      const pts = stems[i % stems.length];
      const p = along(pts, 0.7 + i * 0.06);
      const out = V(p.x, 0.3, p.z + 0.2).normalize();
      flowerAnchors.push(A(p.clone().addScaledVector(out, 0.08), faceQ(out), 1));
    }
    return { asm, fruitGeo: egg ? FRUIT.teardrop() : FRUIT.chili(), flowerGeo: egg ? FLOWER.star(crop) : FLOWER.blossom(crop, { len: 0.06, width: 0.05 }), fruitAnchors, flowerAnchors };
  },

  /** SUI watermelon, ZEC zucchini, PUMP pumpkin: sprawling ground vines with big leaves. */
  groundRosette(crop, { r, d }) {
    const H = crop.height;
    const asm = assembler(H);
    const zuc = crop.variant === 'zucchini';
    const nVines = zuc ? 0 : 5;
    const vines = [];
    for (let i = 0; i < nVines; i++) {
      const a = (i / nVines) * TAU + 0.3;
      const L = 1.1 + r() * 0.3;
      const pts = [];
      for (let k = 0; k <= 10; k++) {
        const t = k / 10;
        const rr = t * L;
        const aa = a + Math.sin(t * 5 + i) * 0.25;
        pts.push(V(Math.sin(aa) * rr, 0.05 + 0.08 * Math.sin(t * Math.PI), Math.cos(aa) * rr * 0.85));
      }
      vines.push(pts);
      asm.stem(stemTube(pts, 0.04, 0.02, 5), crop.stem);
      // curly tendril at the tip
      const tip = pts[pts.length - 1];
      const cur = helix(0.05, 1.5, 0.02, 0.14, a, 10).map((p) => p.add(tip));
      asm.stem(tubeAlong(cur, 0.009, 3, { caps: false }), shade(crop.stem, 0.12));
    }
    // central crown
    asm.stem(stemTube([V(0, -0.02, 0), V(0, 0.18, 0)], 0.09, 0.07, 6), crop.stem);
    const nLeaves = cnt(zuc ? 6 : 10, d);
    const ls = [];
    for (let i = 0; i < nLeaves; i++) {
      const yaw = (i / nLeaves) * TAU * (zuc ? 1 : 1.618) + r() * 0.4;
      let at;
      if (zuc || !vines.length) at = V(0, 0.16, 0);
      else at = along(vines[i % vines.length], 0.25 + ((i * 0.31) % 0.7));
      ls.push({ at, yaw, k: i });
    }
    ls.reverse();
    for (const L of ls) {
      const len = zuc ? 0.72 : crop.variant === 'pumpkin' ? 0.55 : 0.42;
      asm.leaf(bladeLeaf({ len, width: len * (zuc ? 0.7 : 0.8), curl: zuc ? 0.4 : 0.3, fold: 0.3, tip: 0.3, color: shade(crop.leaf, (r() - 0.5) * 0.16), yaw: L.yaw, elev: zuc ? 0.95 : 0.55, at: L.at }), L.at);
    }
    const fruitAnchors = [];
    const ring = zuc ? 0.78 : 0.98;
    for (let i = 0; i < 6; i++) {
      const a = -1.25 + i * 0.5 + (i % 2) * 0.1;
      const rr = ring * (i % 2 ? 0.86 : 1);
      fruitAnchors.push(A(V(Math.sin(a) * rr, 0, Math.cos(a) * rr * 0.9), yawQ(a + Math.PI / 2 + (r() - 0.5) * 0.4), 1));
    }
    const flowerAnchors = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.8;
      const p = V(Math.sin(a) * 0.45, 0.25, Math.cos(a) * 0.42);
      flowerAnchors.push(A(p, faceQ(V(Math.sin(a) * 0.4, 1, Math.cos(a) * 0.4)), 1));
    }
    const fruitGeo = crop.variant === 'watermelon' ? FRUIT.melon() : zuc ? FRUIT.zucchini() : FRUIT.pumpkin();
    return { asm, fruitGeo, flowerGeo: FLOWER.trumpet(crop), fruitAnchors, flowerAnchors };
  },

  /** NEAR carrot: feathery fronds; orange shoulders in the soil are the fruit. */
  rootCrop(crop, { r, d }) {
    const H = crop.height;
    const asm = assembler(H);
    const n = cnt(12, d);
    const fronds = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + r() * 0.3;
      const tilt = 0.25 + r() * 0.35;
      const h = H * (0.75 + r() * 0.2);
      const tip = V(Math.sin(a) * h * tilt, h, Math.cos(a) * h * tilt);
      const pts = bez(V(0, 0, 0), V(tip.x * 0.2, h * 0.55, tip.z * 0.2), tip, 6);
      fronds.push({ pts, a, h });
    }
    fronds.forEach((f) => asm.stem(stemTube(f.pts, 0.018, 0.008, 4, false), crop.stem));
    // leaflets on each frond: one hideable "leaf" per frond (merged feathery leaflets)
    const order = fronds.map((f, i) => ({ f, i })).sort((a, b) => b.f.h - a.f.h);
    for (const { f } of order) {
      const parts = [];
      for (let k = 0; k < 5; k++) {
        const t = 0.35 + k * 0.13;
        const at = along(f.pts, t);
        for (const side of [-1, 1]) {
          const g = leafStrip({ length: 0.2 - k * 0.02, width: 0.07, segments: 2, curl: 0.15, fold: 0.5, tip: 0 });
          const base = shade(crop.leaf, -0.12);
          const tp = shade(crop.leaf, 0.15);
          paintFn(g, (x, y, z) => _c.copy(base).lerp(tp, clamp(z / 0.2, 0, 1)));
          place(g, { pitch: -0.5, yaw: f.a + side * 1.1, p: at });
          parts.push(prep(g, 1));
        }
      }
      const g = merge(parts, { dispose: true });
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(name)) g.deleteAttribute(name);
      asm.leaf(g, along(f.pts, 0.6));
    }
    const fruitAnchors = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.5;
      const rr = i === 0 ? 0.12 : 0.36 + (i % 2) * 0.12;
      fruitAnchors.push(A(V(Math.sin(a) * rr, -0.02, Math.cos(a) * rr), yawQ(r() * TAU), 1));
    }
    const flowerAnchors = fronds.slice(0, 3).map((f) => A(f.pts[f.pts.length - 1].clone().add(V(0, 0.03, 0)), new Quaternion().setFromAxisAngle(V(1, 0, 0), -Math.PI / 2), 1));
    return { asm, fruitGeo: FRUIT.shoulder(), flowerGeo: FLOWER.umbel(crop), fruitAnchors, flowerAnchors };
  },

  /** XRP rice: 24 blades in a shallow paddy (the water disc is an extra mesh, see paddyMesh). */
  grassClump(crop, { r, d }) {
    const H = crop.height;
    const asm = assembler(H);
    const n = cnt(24, d);
    const blades = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU * 2.618 + r() * 0.5;
      const rr = 0.08 + r() * 0.42;
      const base = V(Math.sin(a) * rr, 0, Math.cos(a) * rr);
      const len = H * (0.7 + r() * 0.28);
      blades.push({ base, a, len, elev: 1.05 + r() * 0.35 });
    }
    blades.sort((x, y) => y.len - x.len);
    for (const b of blades) {
      asm.leaf(bladeLeaf({ len: b.len, width: 0.06, curl: 0.22, fold: 0.5, seg: 4, color: crop.leaf, yaw: b.a, elev: b.elev, at: b.base }), b.base);
    }
    // tips of the 6 tallest blades carry the grain chains
    const fruitAnchors = [];
    for (let i = 0; i < 6; i++) {
      const b = blades[i];
      const dir = dirOf(b.a, b.elev);
      const tip = b.base.clone().addScaledVector(dir, b.len * 0.85);
      tip.y -= 0.22 * b.len * 0.85 * 0.3;
      fruitAnchors.push(A(tip, yawQ(b.a), 1.35));
    }
    const flowerAnchors = fruitAnchors.slice(0, 3).map((a) => A(a.p.clone().add(V(0, 0.02, 0)), faceQ(V(0, 1, 0.3)), 1));
    return { asm, fruitGeo: FRUIT.grainChain(), flowerGeo: FLOWER.puff(crop), fruitAnchors, flowerAnchors, paddy: true };
  },

  /** WIF: a mushroom in a knit hat on a mossy log; baby mushrooms are the fruit. */
  fungus(crop, { r, d }) {
    const H = crop.height;
    const asm = assembler(H);
    // the log
    const log = new CylinderGeometry(0.24, 0.27, 1.5, 9, 1, false);
    place(log, { roll: Math.PI / 2, yaw: 0.25, p: [0, 0.2, -0.05] });
    paintFn(log, (x, y, z) => {
      const ring = Math.abs(x) > 0.7 ? 0.25 : 0;
      return shade('#8A6448', -0.15 + 0.2 * noise3(x * 6, y * 6, z * 6)).lerp(col('#D9B98F'), ring);
    });
    asm.stem(log);
    // stalk (lathe) + knitted cap (vertex-noise ribs) + brim + pom-pom
    const stalk = lathe([[0.11, 0.3], [0.12, 0.42], [0.1, 0.6], [0.09, 0.78], [0.1, 0.86]], 9, { flat: false });
    paint(stalk, crop.stem);
    asm.stem(stalk);
    const capProf = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      capProf.push([Math.max(0.0001, Math.cos(t * Math.PI * 0.5) * 0.36), 0.84 + Math.sin(t * Math.PI * 0.5) * 0.36]);
    }
    const cap = lathe(capProf, 22, { flat: false });
    const pos = cap.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const k = 1 + 0.05 * Math.cos(Math.atan2(z, x) * 11); // knitted ribs
      pos.setX(i, x * k);
      pos.setZ(i, z * k);
    }
    cap.computeVertexNormals();
    const knit = col(crop.ripe);
    const dots = col('#FFF4E2');
    paintFn(cap, (x, y, z) => (noise3(x * 14, y * 14, z * 14) > 0.42 ? _c.copy(dots) : _c.copy(knit).multiplyScalar(0.92 + 0.08 * Math.cos(Math.atan2(z, x) * 11))));
    asm.solid(cap, undefined, 0);
    const brim = new TorusGeometry(0.34, 0.06, 6, 18);
    place(brim, { pitch: Math.PI / 2, p: [0, 0.86, 0] });
    paint(brim, '#F3E6D2');
    asm.solid(brim, undefined, 0);
    const pom = lowpolySphere(0.11, 1, { jitter: 0.25, seed: 4 });
    place(pom, { p: [0, 1.24, 0] });
    paint(pom, crop.accent);
    asm.solid(pom, undefined, 0);
    // moss tufts on the log (hideable "leaves")
    const n = cnt(10, d);
    for (let i = 0; i < n; i++) {
      const t = (i / n - 0.5) * 1.3;
      const at = V(Math.cos(0.25) * t, 0.42, -0.05 - Math.sin(0.25) * t + (r() - 0.5) * 0.15);
      const g = lowpolySphere(0.09 + r() * 0.05, 0, { jitter: 0.3, seed: 40 + i, squash: [1.2, 0.55, 1] });
      place(g, { p: at });
      asm.leaf(g, at, (x, y) => shade(crop.leaf, y > at.y ? 0.08 : -0.12));
    }
    const fruitAnchors = [];
    const spots = [[-0.55, 0.38, 0.12], [0.45, 0.4, 0.05], [-0.3, 0.0, 0.42], [0.55, 0.0, 0.38], [0.2, 0.0, 0.55], [-0.7, 0.0, 0.25]];
    spots.forEach((s, i) => fruitAnchors.push(A(V(s[0], s[1], s[2]), yawQ(r() * TAU), 0.9 + (i % 2) * 0.25)));
    const flowerAnchors = [];
    for (let i = 0; i < 4; i++) {
      const t = (i / 4 - 0.4) * 1.1;
      flowerAnchors.push(A(V(Math.cos(0.25) * t, 0.46, -Math.sin(0.25) * t + 0.12), faceQ(V(0, 1, 0.5)), 1));
    }
    return { asm, fruitGeo: FRUIT.babyMushroom(), flowerGeo: FLOWER.blossom(crop, { petals: 4, len: 0.05, width: 0.05 }), fruitAnchors, flowerAnchors };
  },
};

// ------------------------------------------------------------------ the shared seed sprout (§3.5 waiting/entering)

/** A 2-leaf sprout in the crop's own colours, ~2.1 u tall at scale 1 (≈ 0.5 u at size 0.25). */
function buildSprout(crop) {
  const asm = assembler(crop.height);
  const pts = bez(V(0, -0.02, 0), V(0.08, 0.9, 0), V(0, 1.75, 0.05), 6);
  asm.stem(stemTube(pts, 0.1, 0.07, 5), crop.stem);
  const top = pts[pts.length - 1];
  for (const side of [-1, 1]) {
    asm.leaf(bladeLeaf({ len: 0.85, width: 0.6, curl: 0.25, fold: 0.3, tip: 0.5, color: crop.leaf, yaw: side * 1.45 + 0.2, elev: 0.45, at: top }), top);
  }
  return asm.build().geo;
}

// ------------------------------------------------------------------ public: parts

/** Every builder name used by the catalogue (tests: ⊆ BUILDERS). */
export const BUILDER_FNS = Object.freeze(Object.keys(BUILD));

const tierName = (tier) => (typeof tier === 'string' ? tier : tier?.tier || tier?.name || 'high');

/**
 * Build the parts of a coin's crop (not cached; buildCrop() caches per coin + tier).
 * → { crop, stemLeaves, leafStart, leafEnds, leafBases, fruitGeo, flowerGeo, fruitAnchors (6), flowerAnchors (≤ 6),
 *     height, sprout, flowerTint, paddy }
 */
/**
 * The size of a fruit that is visible from any side: the MIDDLE side of its bounding box (an elongated fruit seen
 * end-on still shows at least its second-largest extent). The legibility boost is computed from it.
 */
function visibleSide(geo) {
  if (!geo.boundingBox) geo.computeBoundingBox();
  const b = geo.boundingBox;
  const s = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].sort((x, y) => x - y);
  return s[1];
}

// ---- fruit legibility (PLATFORM QA-05): a ripe fruit never shrinks below ~6 CSS px on screen. The field sets the
// smallest legible fruit size in world units from the camera every frame (FRUIT_MIN_PX ÷ pixels per unit at the
// field); a fruit drawn smaller than that is scaled up (at most FRUIT_BOOST_MAX×). Close up the boost is 1: the art
// is unchanged; zoomed out (phones show the whole farm) the fruit stays readable instead of vanishing.
export const FRUIT_MIN_PX = 7;
export const FRUIT_BOOST_MAX = 3;
let fruitMinWorld = 0;
/** Smallest legible fruit (world units); 0 turns the boost off. */
export function setFruitMinWorld(u) {
  fruitMinWorld = Math.max(0, Number.isFinite(Number(u)) ? Number(u) : 0);
}
export function getFruitMinWorld() {
  return fruitMinWorld;
}
/** The boost for a fruit of `worldSize` units (pure; tested). */
export function fruitBoost(worldSize, minWorld = fruitMinWorld) {
  if (!(minWorld > 0) || !(worldSize > 0)) return 1;
  return Math.min(FRUIT_BOOST_MAX, Math.max(1, minWorld / worldSize));
}
/** Inverted-hull scale and ink of the Low-tier fruit outline (QA-05: on Low, fruit gets an outline). */
export const FRUIT_RIM = Object.freeze({ scale: 1.18, color: '#3B3330' });

/** The Low-tier rim: a 20-triangle icosahedron fitted to the fruit's bounding box (cheap; an outline, not a copy). */
function rimGeometry(P) {
  const geo = P.fruitGeo;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const b = geo.boundingBox;
  const g = lowpolySphere(0.5, 0, { jitter: 0 });
  g.scale(Math.max(1e-3, b.max.x - b.min.x), Math.max(1e-3, b.max.y - b.min.y), Math.max(1e-3, b.max.z - b.min.z));
  g.translate((b.max.x + b.min.x) / 2, (b.max.y + b.min.y) / 2, (b.max.z + b.min.z) / 2);
  return g;
}

export function buildParts(coin, { tier = 'high' } = {}) {
  const crop = cropFor(coin);
  const t = tierName(tier);
  const d = DETAIL[t] ?? 1;
  const seed = [...String(crop.coin)].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7);
  const r = rng(seed);
  const fn = BUILD[crop.builder] || BUILD.vine;
  FRUIT_LO = t !== 'high';
  let out;
  try {
    out = fn(crop, { r, d });
  } finally {
    FRUIT_LO = false;
  }
  const built = out.asm.build();
  return {
    crop,
    stemLeaves: built.geo,
    leafStart: built.leafStart,
    leafEnds: built.leafEnds,
    leafBases: built.leafBases,
    fruitGeo: out.fruitGeo,
    fruitSpan: visibleSide(out.fruitGeo),
    flowerGeo: out.flowerGeo,
    fruitAnchors: out.fruitAnchors.slice(0, 6),
    flowerAnchors: out.flowerAnchors.slice(0, 6),
    height: crop.height,
    sprout: buildSprout(crop),
    flowerTint: out.flowerTint || null,
    paddy: !!out.paddy,
  };
}

// Cache per coin + tier with reference counts. Per-plot stem geometries share the cached attributes (so 15
// plots of BTC upload one buffer) but own their draw range; on release a non-last user detaches the shared
// attributes before disposing its wrapper, so the renderer never frees buffers another plot still draws.
const cache = new Map();

function acquire(coin, tier) {
  const key = `${cropFor(coin).coin}|${tierName(tier)}`;
  let e = cache.get(key);
  if (!e) {
    e = { key, parts: buildParts(coin, { tier }), refs: 0 };
    cache.set(key, e);
  }
  e.refs++;
  return e;
}

function wrapGeometry(src) {
  const g = new BufferGeometry();
  for (const [name, a] of Object.entries(src.attributes)) g.setAttribute(name, a);
  if (src.index) g.setIndex(src.index);
  g.boundingSphere = src.boundingSphere?.clone() ?? null;
  return g;
}

function stripDispose(g) {
  for (const name of Object.keys(g.attributes)) g.deleteAttribute(name);
  g.setIndex(null);
  g.dispose();
}

function release(e, wrappers) {
  e.refs--;
  if (e.refs > 0) {
    for (const w of wrappers) stripDispose(w);
    return;
  }
  // last user: dispose for real (frees the shared GPU buffers), then the cached sources
  for (const w of wrappers) w.dispose();
  e.parts.stemLeaves.dispose();
  e.parts.sprout.dispose();
  e.parts.fruitGeo.dispose();
  e.parts.flowerGeo.dispose();
  cache.delete(e.key);
}

/** Drop every cached crop geometry (field.dispose()). */
export function clearCropCache() {
  for (const e of cache.values()) {
    e.parts.stemLeaves.dispose();
    e.parts.sprout.dispose();
    e.parts.fruitGeo.dispose();
    e.parts.flowerGeo.dispose();
  }
  cache.clear();
}

// ------------------------------------------------------------------ CPU mirror of the crop shader bend

const _bw = new Vector3();
/**
 * Bend a local point exactly like the crop vertex shader (gfx/materials.js VERT_BODY), so fruit and flowers
 * stay on their branches. `u` = the crop's uniforms; `origin` = the mesh's world origin (phase source).
 */
export function bendPoint(out, p, u, origin) {
  const hgt = u.uHeight.value > 0 ? u.uHeight.value : 1;
  const aH = clamp(p.y / hgt, 0, 1);
  const w = aH * aH;
  let lx = u.uLean.value.x;
  let lz = u.uLean.value.y;
  const L = Math.hypot(lx, lz);
  if (L > 1e-4) {
    lx /= L;
    lz /= L;
  } else {
    lx = 0;
    lz = 1;
  }
  const droop = u.uDroop.value;
  let x = p.x + lx * droop * w * hgt;
  let y = p.y - droop * w * 0.4 * hgt;
  let z = p.z + lz * droop * w * hgt;
  const time = sharedUniforms.uTime.value;
  const wind = sharedUniforms.uWind.value;
  const gx = sharedUniforms.uGust.value;
  const ph = origin.x * 0.37 + origin.z * 0.61;
  const gustK = gx > -999 ? Math.exp(-Math.pow((origin.x - gx) / 4, 2)) : 0;
  const a = Math.sin(time * 1.2 + ph) * u.uSway.value * wind + Math.sin(time * 43.982 + ph * 3) * u.uShiver.value + gustK * 0.22 * Math.min(wind, 1.5);
  const b = Math.sin(time * 0.93 + ph * 1.7) * u.uSway.value * wind * 0.35;
  x += a * w * hgt;
  z += b * w * hgt;
  y -= 0.5 * (a * a + b * b) * w * hgt;
  const s = u.uSize.value;
  return out.set(x * s, y * s, z * s);
}

// ------------------------------------------------------------------ CropMesh

const DROP_SLOTS = 6; // brown fallen fruit stay 10 s (§4.2) in instances 6..11

// ---- visual scale (J4 "losses stay visible")
// stage() numbers stay exactly as the PlotView carries them (parity tests); only the DRAWN scale is remapped so
// a dying plant (size 0.12) is still a full, brown, drooping silhouette instead of twigs below the box rim, and
// a healthy one fills its box. Per crop the gain is bounded by its footprint so wide crops stay inside the soil.
/** Drawn scale at stage() size 0 / the slope per unit of size (vis = gain·(VIS_BASE + VIS_SLOPE·size)). */
export const VIS_BASE = 0.45;
export const VIS_SLOPE = 0.55;
/** Widest a size-1 crop may be drawn (u): ~70% of the 3.4 u box, inside the 2.9 u soil inset. */
const VIS_MAX_SPAN = 2.4;
/** Gain bounds: never shrink a crop, and never blow a small one up past 1.7×. */
const VIS_GAIN_MAX = 1.7;
/** Lowest a planted (non-seed) crop's top is drawn above the soil (u), as far as its footprint allows. */
const VIS_MIN_TOP = 0.6;

/** Drawn-scale gain of a crop from its stem+leaves bounds (cached on the shared parts entry). */
function visGain(entry) {
  if (entry.vis) return entry.vis;
  const geo = entry.parts.stemLeaves;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const b = geo.boundingBox;
  const span = Math.max(1e-3, b.max.x - b.min.x, b.max.z - b.min.z);
  const top = Math.max(1e-3, b.max.y);
  const spanCap = VIS_MAX_SPAN / span;            // the widest the crop may be drawn
  const gain = clamp(spanCap, 1, VIS_GAIN_MAX);
  entry.vis = { gain, top, spanCap: Math.max(1, spanCap) };
  return entry.vis;
}

/** Drawn group scale for a stage() size: remapped, gained, with the soil-height floor (bounded by footprint). */
export function visScale(size, { gain = 1, top = 1, spanCap = Infinity } = {}) {
  const s = gain * (VIS_BASE + VIS_SLOPE * Math.max(0, Number(size) || 0));
  const floor = Math.min(VIS_MIN_TOP / Math.max(top, 1e-3), spanCap);
  return Math.max(s, floor);
}
const FRUIT_CAP = 6 + DROP_SLOTS;
const HIDE = new Matrix4().makeScale(0, 0, 0);
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _mat = new Matrix4();
const _inv = new Matrix4();
const _wp = new Vector3();
const _o = new Vector3();
const BROWN = new Color('#6B4A2E');

/**
 * Build a crop actor for a coin (see the file header for the API).
 * opts: { tier, seed (per-plot variation), lean: [x, z] droop direction }
 */
export function buildCrop(coin, { tier = 'high', seed = 1, lean = null } = {}) {
  const entry = acquire(coin, tier);
  const P = entry.parts;
  const crop = P.crop;
  const vis = visGain(entry);
  const group = new Group();
  group.name = `crop:${crop.coin}`;

  // stem + leaves (own draw range over shared attributes)
  const stemGeo = wrapGeometry(P.stemLeaves);
  const sproutGeo = wrapGeometry(P.sprout);
  const { material, depthMaterial, uniforms } = cropMaterial({ lush: hexNum(crop.leaf), height: P.height });
  const lr = hash01(seed * 7 + 3);
  const lx = lean ? lean[0] : (lr < 0.5 ? -1 : 1) * (0.55 + 0.3 * hash01(seed));
  const lz = lean ? lean[1] : 0.55 + 0.35 * hash01(seed + 9);
  uniforms.uLean.value.set(lx, lz);
  const stem = new Mesh(stemGeo, material);
  stem.customDepthMaterial = depthMaterial;
  stem.castShadow = true;
  stem.receiveShadow = true;
  stem.name = 'stemLeaves';
  group.add(stem);
  const sprout = new Mesh(sproutGeo, material);
  sprout.customDepthMaterial = depthMaterial;
  sprout.castShadow = true;
  sprout.visible = false;
  sprout.name = 'sprout';
  group.add(sprout);

  // fruit (6 hanging + 6 dropped) and flowers
  const fruitMat = new MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient(), side: DoubleSide });
  fruitMat.emissive = new Color(crop.ripe);
  fruitMat.emissiveIntensity = 0;
  const fruit = new InstancedMesh(P.fruitGeo, fruitMat, FRUIT_CAP);
  fruit.instanceMatrix.setUsage(DynamicDrawUsage);
  // fruit shadows are sub-pixel below High: they only cost a second pass of every fruit (QA-07 budgets)
  fruit.castShadow = tierName(tier) === 'high';
  fruit.frustumCulled = false;
  fruit.name = 'fruit';
  for (let i = 0; i < FRUIT_CAP; i++) {
    fruit.setMatrixAt(i, HIDE);
    fruit.setColorAt(i, col(crop.unripe));
  }
  group.add(fruit);
  // Low tier: a dark inverted hull around each fruit, so a fruit reads as a shape without shadows or post (QA-05)
  let fruitRim = null;
  let rimMat = null;
  if (tierName(tier) === 'low') {
    rimMat = new MeshBasicMaterial({ color: FRUIT_RIM.color, side: BackSide });
    fruitRim = new InstancedMesh(rimGeometry(P), rimMat, 6);
    fruitRim.instanceMatrix.setUsage(DynamicDrawUsage);
    fruitRim.frustumCulled = false;
    fruitRim.name = 'fruitRim';
    for (let i = 0; i < 6; i++) fruitRim.setMatrixAt(i, HIDE);
    group.add(fruitRim);
  }
  const nFlowers = Math.max(1, P.flowerAnchors.length);
  const flowerMat = new MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient(), side: DoubleSide });
  const flower = new InstancedMesh(P.flowerGeo, flowerMat, nFlowers);
  flower.instanceMatrix.setUsage(DynamicDrawUsage);
  flower.frustumCulled = false;
  flower.name = 'flower';
  for (let i = 0; i < nFlowers; i++) {
    flower.setMatrixAt(i, HIDE);
    if (P.flowerTint) flower.setColorAt(i, col(crop.unripe));
  }
  group.add(flower);

  // rice paddy (water disc with ripple rings) — an extra, never tinted by health
  let paddy = null;
  if (P.paddy) {
    const g = new CylinderGeometry(0.95, 1.0, 0.03, 20, 1);
    paintFn(g, (x, y, z) => {
      const rr = Math.hypot(x, z);
      return col(crop.accent).lerp(WHITE, 0.12 + 0.1 * Math.max(0, Math.sin(rr * 11)));
    });
    paddy = new Mesh(g, propMaterial({ vertexColors: true, toon: true }));
    paddy.position.y = 0.01;
    paddy.receiveShadow = true;
    paddy.name = 'paddy';
    group.add(paddy);
  }

  // ---- animated state
  const st = {
    reduced: false,
    size: createSpring(0.25, { omega: 4 }),
    flatten: createSpring(1, { omega: 6 }),
    droop: createTween({ from: 0, to: 0, ms: 1200, ease: 'iOS' }),
    health: createTween({ from: 1, to: 1, ms: 1200, ease: 'iOS' }),
    ripe01: createTween({ from: 0, to: 0, ms: 600, ease: 'iOS' }),
    sat: createTween({ from: 1, to: 1, ms: 600, ease: 'iOS' }),
    frost: createTween({ from: 0, to: 0, ms: 1500, ease: 'iOS' }),
    dim: 1,
    seed: false,
    ripe: false,
    fruitN: 0,
    fruitK: new Float32Array(6), // 0..1 visible scale per anchor
    fruitPop: new Float32Array(6).fill(-1), // pop clock (ms) per anchor, −1 idle
    fruitFade: new Float32Array(6).fill(-1), // quiet fade clock (ms)
    flowerOpen: false,
    flowerK: createTween({ from: 0, to: 0, ms: 600, ease: 'oB' }),
    keep: P.leafEnds.length,
    sway: { amp: 0, shiver: 0, mul: 1 },
    bounce: -1,
    wiggle: false,
    jitter: false,
    drops: [], // { slot, local Vector3 (box-space start), t, colorK }
    has: false,
    clockMs: 0,
    sproutPop: -1,
    hidden: 0, // bit mask: fruit flown into the harvest basket stay hidden
  };
  stem.geometry.setDrawRange(0, Infinity);

  const fruitColor = new Color();
  const unripe = col(crop.unripe);
  const ripeC = col(crop.ripe);

  function setKeep(n) {
    const k = clamp(Math.round(n), 0, P.leafEnds.length);
    if (k < st.keep && api.onLeafFall) {
      for (let i = k; i < st.keep; i++) {
        try {
          api.onLeafFall(leafWorld(i), crop.leaf);
        } catch {
          /* decorative */
        }
      }
    }
    st.keep = k;
    const end = k > 0 ? P.leafEnds[k - 1] : P.leafStart;
    stem.geometry.setDrawRange(0, end);
  }

  /** World position of leaf i's base (falling-leaf particles). */
  function leafWorld(i) {
    const b = P.leafBases[clamp(i, 0, P.leafBases.length - 1)] || V(0, P.height * 0.5, 0);
    group.updateWorldMatrix(true, false);
    stem.getWorldPosition(_o);
    bendPoint(_wp, b, uniforms, _o);
    return _wp.clone().applyMatrix4(group.matrixWorld);
  }

  function anchorWorld(a) {
    group.updateWorldMatrix(true, false);
    stem.getWorldPosition(_o);
    bendPoint(_wp, a.p, uniforms, _o);
    return _wp.clone().applyMatrix4(group.matrixWorld);
  }

  const api = {
    group,
    crop,
    parts: P,
    uniforms,
    onLeafFall: null,
    /** fn() asking for one frame (set by the plot; RM timed changes). */
    onWake: null,

    /**
     * New growth targets (from field/growth.js plotLook().crop + the PlotView's stage() numbers).
     * g: { size, health, fruit, flower|flowerOpen, ripe, frac|ripe01, seed, shaded|sat, frost, frozen,
     *      droop, leafKeep, flatten }
     * Frozen plants keep their previous growth targets (§3.5 "plant targets frozen").
     */
    setGrowth(g = {}) {
      const first = !st.has;
      const frozen = !!g.frozen && st.has;
      if (!frozen) {
        const size = clamp(Number(g.size ?? 0.25), 0.05, 1.2);
        const health = clamp(Number(g.health ?? 1), 0, 1);
        st.size.retarget(size);
        const droop = Number.isFinite(g.droop) ? g.droop : droopOf(health);
        st.droop.retarget(droop, st.reduced ? 0 : 1200);
        st.health.retarget(health, st.reduced ? 0 : 1200);
        const r01 = Number.isFinite(g.ripe01) ? g.ripe01 : ripeness(g.frac ?? 0);
        st.ripe01.retarget(r01, st.reduced ? 0 : 600);
        const n = clamp(Math.floor(Number(g.fruit) || 0), 0, 6);
        // fruit appear/disappear without an effect (load, RM, missed diffs): quick fade
        for (let i = 0; i < 6; i++) {
          const want = i < n;
          if (want && st.fruitK[i] === 0 && st.fruitPop[i] < 0 && st.fruitFade[i] < 0) st.fruitFade[i] = 0;
          if (!want && i < st.fruitN && st.fruitPop[i] < 0) {
            st.fruitK[i] = 0;
            st.fruitFade[i] = -1;
          }
        }
        st.fruitN = n;
        const open = (g.flowerOpen ?? g.flower) && !g.seed;
        if (open !== st.flowerOpen) {
          st.flowerOpen = !!open;
          st.flowerK.retarget(open ? 1 : 0, st.reduced ? 0 : open ? 600 : 400, open ? 'oB' : 'iOS');
        }
        const keep = Number.isFinite(g.leafKeep) ? Math.ceil(P.leafEnds.length * g.leafKeep - 1e-9) : leafKeepCount(P.leafEnds.length, health);
        if (first) {
          st.keep = P.leafEnds.length;
          const save = api.onLeafFall;
          api.onLeafFall = null;
          setKeep(keep);
          api.onLeafFall = save;
        } else if (keep !== st.keep) setKeep(keep);
      }
      const seedNow = !!g.seed;
      if (seedNow !== st.seed && st.has && !st.reduced) st.sproutPop = 0;
      st.seed = seedNow;
      st.ripe = !!g.ripe && !g.seed;
      const sat = Number.isFinite(g.sat) ? g.sat : g.shaded ? 0.7 : 1;
      st.sat.retarget(sat, st.reduced ? 0 : 600);
      st.frost.retarget(clamp(Number(g.frost) || 0, 0, 0.6), st.reduced ? 0 : 1500);
      st.flatten.retarget(Number.isFinite(g.flatten) ? g.flatten : 1);
      st.wiggle = !!g.wiggle;
      if (first || st.reduced) {
        st.size.snap();
        st.flatten.snap();
        for (const tw of [st.droop, st.health, st.ripe01, st.sat, st.frost, st.flowerK]) tw.t = tw.delay + tw.ms;
        for (let i = 0; i < 6; i++) {
          if (i < st.fruitN) {
            st.fruitK[i] = 1;
            st.fruitFade[i] = -1;
          }
        }
      }
      st.has = true;
    },

    /** amp/shiver in rad (§3.2); windFactor is a LOCAL multiplier (wilting 0.6, RM 0) on top of the shared uWind. */
    setSway(amp = 0, shiver = 0, windFactor = 1, { jitter = false } = {}) {
      st.sway.amp = Math.max(0, amp);
      st.sway.shiver = Math.max(0, shiver);
      st.sway.mul = Math.max(0, windFactor);
      st.jitter = !!jitter;
    },

    setMotion({ reduced = false } = {}) {
      st.reduced = !!reduced;
      if (st.reduced) {
        st.size.snap();
        st.flatten.snap();
      }
    },

    /** Focus-mode dim (other boxes −15%, §5.4): multiplies the saturation (1 = normal, 0.85 = dimmed). */
    setDim(k = 1) {
      st.dim = clamp(k, 0, 1);
    },

    /** Fruit gained at anchor i: pop 0 → 1.15 → 1 (450 ms, oB) + leaf bounce; quiet → 200 ms fade (§4.2). */
    popFruit(i, quiet = false) {
      const k = clamp(i | 0, 0, 5);
      st.fruitN = Math.max(st.fruitN, k + 1);
      if (st.reduced || quiet) {
        st.fruitPop[k] = -1;
        st.fruitFade[k] = st.reduced ? 1e9 : 0;
        st.fruitK[k] = st.reduced ? 1 : 0;
        return;
      }
      st.fruitK[k] = 0;
      st.fruitFade[k] = -1;
      st.fruitPop[k] = 0;
      st.bounce = 0;
    },

    /**
     * Fruit lost at anchor i: it browns (300), drops, rolls 0.6 u, stays visible 10 s, then sinks (800) — §4.2.
     * Reduced motion: it fades to brown where it hangs, then is gone.
     */
    dropFruit(i) {
      const k = clamp(i | 0, 0, 5);
      if (st.fruitK[k] <= 0.01 && !(k < st.fruitN)) return null;
      const a = P.fruitAnchors[k];
      const world = anchorWorld(a);
      st.fruitK[k] = 0;
      st.fruitPop[k] = -1;
      st.fruitFade[k] = -1;
      if (st.fruitN > k) st.fruitN = k;
      const slot = st.drops.length < DROP_SLOTS ? st.drops.length : 0;
      if (st.drops.length >= DROP_SLOTS) st.drops.shift();
      const rollDir = Math.atan2(world.x - _o.x, world.z - _o.z) + (hash01(k + st.clockMs) - 0.5);
      const dr = { k, start: world, t: 0, roll: rollDir, ripe01: st.ripe01.value(), q: a.q.clone(), s: a.s, slot, expired: false };
      st.drops.push(dr);
      if (st.reduced) {
        // RM: the brown fruit is static, so it must not keep the on-demand loop rendering for 10 s (§7.3: 0 renders
        // when nothing changes) — a wall-clock timer removes it and asks for the one frame that shows that
        const timer = setTimeout(() => {
          dr.expired = true;
          api.onWake?.();
        }, 10_000);
        timer?.unref?.(); // (Node tests: never hold the process open)
      }
      return world;
    },

    /** Hide fruit i at once (harvest: the executor flies it into the basket). */
    hideFruit(i) {
      const k = clamp(i | 0, 0, 5);
      st.fruitK[k] = 0;
      st.fruitPop[k] = -1;
      st.fruitFade[k] = -1;
      st.hidden |= 1 << k;
    },

    /** Flatten to a stump right away (liquidation hail, §4.3); the next setGrowth keeps it via `flatten`. */
    setFlatten(f = 1) {
      st.flatten.retarget(clamp(Number(f), 0.05, 1));
      if (st.reduced) st.flatten.snap();
    },

    /** Leaves bounce (fruit pop). */
    bounce() {
      if (!st.reduced) st.bounce = 0;
    },

    /** Entering wiggle (2 Hz ±6°) on the sprout. */
    setWiggle(on) {
      st.wiggle = !!on;
    },

    fruitWorld(i) {
      return anchorWorld(P.fruitAnchors[clamp(i | 0, 0, P.fruitAnchors.length - 1)]);
    },
    flowerWorld(i) {
      return anchorWorld(P.flowerAnchors[clamp(i | 0, 0, P.flowerAnchors.length - 1)] || P.fruitAnchors[0]);
    },
    /** World position of the crop top (puffs, clouds, sparkle glints). */
    topWorld() {
      return anchorWorld({ p: V(0, P.height * (st.seed ? 0.45 : 0.85), 0) });
    },
    leafWorld,
    get fruitCount() {
      return st.fruitN;
    },
    get leafCount() {
      return P.leafEnds.length;
    },
    get visibleLeaves() {
      return st.keep;
    },
    /** The stage() size the plant currently shows (spring value; the group's drawn scale is visScale of it). */
    get stageSize() {
      return st.size.x;
    },
    /** This crop's visScale() parameters (gain, top, spanCap). */
    get visParams() {
      return vis;
    },
    /** True while something still animates (on-demand loop). */
    busy() {
      // RM drops are static until their timer fires (see dropFruit), so they do not count as animating
      if (st.size.moving || st.flatten.moving || (st.drops.length && !st.reduced)) return true;
      for (const tw of [st.droop, st.health, st.ripe01, st.sat, st.frost, st.flowerK]) if (!tw.done) return true;
      for (let i = 0; i < 6; i++) if (st.fruitPop[i] >= 0 || (st.fruitFade[i] >= 0 && st.fruitFade[i] < 1e8)) return true;
      return st.bounce >= 0 || st.sproutPop >= 0;
    },

    update(dt, t) {
      const dts = Math.min(0.05, Math.max(0, Number(dt) || 0));
      const ms = dts * 1000;
      st.clockMs += ms;
      // springs + tweens
      const size = st.reduced ? st.size.snap(st.size.target).x : st.size.step(dts);
      const flat = st.reduced ? st.flatten.snap(st.flatten.target).x : st.flatten.step(dts);
      for (const tw of [st.droop, st.health, st.ripe01, st.sat, st.frost, st.flowerK]) tw.step(st.reduced ? 1e9 : ms);
      let bounceK = 1;
      if (st.bounce >= 0) {
        st.bounce += ms;
        const k = st.bounce / 500;
        bounceK = 1 + 0.06 * Math.sin(k * Math.PI * 3) * (1 - k);
        if (k >= 1) st.bounce = -1;
      }
      let sproutK = 1;
      if (st.sproutPop >= 0) {
        st.sproutPop += ms;
        sproutK = popScale(st.sproutPop / 450);
        if (st.sproutPop >= 450) st.sproutPop = -1;
      }
      // drawn scale (see visScale): a seed keeps the plain size so the sprout maths below stays as tuned
      const drawn = st.seed ? size : visScale(size, vis);
      group.scale.set(drawn * bounceK * sproutK, drawn * flat * bounceK * sproutK, drawn * bounceK * sproutK);
      if (st.jitter && !st.reduced) group.rotation.z = 0.02 * noise3(t * 0.5, seed, 0.3);
      else group.rotation.z = 0;

      // uniforms
      const u = uniforms;
      u.uDroop.value = st.droop.value();
      u.uHealth.value = st.health.value();
      u.uSat.value = st.sat.value() * st.dim;
      u.uFrost.value = st.frost.value();
      u.uSway.value = st.reduced ? 0 : st.sway.amp * st.sway.mul;
      u.uShiver.value = st.reduced ? 0 : st.sway.shiver * st.sway.mul;

      // seed ↔ crop
      stem.visible = !st.seed;
      fruit.visible = !st.seed;
      flower.visible = !st.seed && (st.flowerK.value() > 0.01 || st.flowerOpen);
      sprout.visible = st.seed;
      if (paddy) paddy.visible = true;
      // the seedling still grows with `size`, but sub-linearly: 0.25 → ~0.65 u, 1 → ~1.5 u (a 2 u sprout looks wrong)
      if (st.seed) sprout.scale.setScalar(1 / (0.6 + 0.8 * Math.max(0.05, size)));
      if (st.seed && st.wiggle && !st.reduced) {
        sprout.rotation.z = (6 * Math.PI) / 180 * Math.sin(st.clockMs / 1000 * TAU * 2);
      } else sprout.rotation.z = 0;

      // fruit colour (ripeness) + ripe pulse (§3.5: emissive 0.12, 2 s period)
      const r01 = st.ripe01.value();
      fruitColor.copy(unripe).lerp(ripeC, r01);
      fruitMat.emissiveIntensity = st.ripe && !st.reduced ? 0.12 * pulse(st.clockMs / 1000, 2) : st.ripe ? 0.06 : 0;
      fruitMat.color.setScalar(0.85 + 0.15 * clamp((st.sat.value() - 0.7) / 0.3, 0, 1));
      if (P.flowerTint) for (let i = 0; i < nFlowers; i++) flower.setColorAt(i, fruitColor);

      // place fruit + flowers on the bent anchors
      stem.getWorldPosition(_o);
      const comp = 1 / Math.sqrt(Math.max(drawn, 0.6)); // keep fruit legible on small plants (drawn scale)
      for (let i = 0; i < 6; i++) {
        let k = st.fruitK[i];
        if (st.fruitPop[i] >= 0) {
          st.fruitPop[i] += ms;
          k = popScale(st.fruitPop[i] / 450);
          if (st.fruitPop[i] >= 450) {
            st.fruitPop[i] = -1;
            k = 1;
          }
          st.fruitK[i] = k;
        } else if (st.fruitFade[i] >= 0) {
          st.fruitFade[i] += ms;
          k = clamp(st.fruitFade[i] / 200, 0, 1);
          if (k >= 1) st.fruitFade[i] = -1;
          st.fruitK[i] = k;
        }
        if ((i >= st.fruitN && st.fruitPop[i] < 0) || st.hidden & (1 << i)) k = 0;
        const a = P.fruitAnchors[i];
        if (!a || k <= 0.001) {
          fruit.setMatrixAt(i, HIDE);
          if (fruitRim) fruitRim.setMatrixAt(i, HIDE);
          continue;
        }
        bendPoint(_p, a.p, u, _o);
        // legibility boost: the drawn fruit size is span × a.s × comp × group scale (QA-05)
        const boost = fruitBoost((P.fruitSpan || 0) * a.s * comp * Math.max(drawn, 1e-3));
        _s.setScalar(a.s * k * comp * boost);
        _mat.compose(_p.divideScalar(Math.max(u.uSize.value, 1e-3)), a.q, _s);
        fruit.setMatrixAt(i, _mat);
        fruit.setColorAt(i, fruitColor);
        if (fruitRim) {
          _s.multiplyScalar(FRUIT_RIM.scale);
          _mat.compose(_p, a.q, _s);
          fruitRim.setMatrixAt(i, _mat);
        }
      }
      if (fruitRim) fruitRim.instanceMatrix.needsUpdate = true;
      // only draw the drop slots while something lies on the soil (6 instead of 12 instances otherwise, QA-07)
      fruit.count = st.drops.length ? FRUIT_CAP : 6;
      // dropped fruit (box-space → local through the inverse group matrix)
      group.updateWorldMatrix(true, false);
      _inv.copy(group.matrixWorld).invert();
      for (let j = 0; j < DROP_SLOTS; j++) fruit.setMatrixAt(6 + j, HIDE);
      for (let j = st.drops.length - 1; j >= 0; j--) {
        const dr = st.drops[j];
        dr.t += ms;
        const T = dr.t;
        const groundY = group.parent ? group.parent.getWorldPosition(_wp).y + 0.02 : 0;
        const pos = dr.start.clone();
        let sink = 0;
        let brownK = clamp(T / 300, 0, 1);
        let scale = dr.s * comp;
        if (st.reduced) {
          // RM: brown in place, then gone after 10 s (wall-clock timer: no frames run in between)
          if (dr.expired || T > 10_000) {
            st.drops.splice(j, 1);
            continue;
          }
        } else {
          const fallT = clamp((T - 300) / 450, 0, 1);
          const rollT = clamp((T - 750) / 600, 0, 1);
          pos.y = lerp(dr.start.y, groundY + 0.06, EASE.inQuad(fallT));
          const rollD = 0.6 * EASE.oC(rollT);
          pos.x += Math.sin(dr.roll) * rollD;
          pos.z += Math.cos(dr.roll) * rollD;
          if (T > 10_750) sink = clamp((T - 10_750) / 800, 0, 1);
          pos.y -= sink * 0.25;
          scale *= 1 - 0.6 * sink;
          if (sink >= 1) {
            st.drops.splice(j, 1);
            continue;
          }
        }
        _p.copy(pos).applyMatrix4(_inv);
        _q.copy(dr.q);
        const sc = scale / Math.max(group.scale.x, 1e-3);
        _s.set(sc, (sc * group.scale.x) / Math.max(group.scale.y, 1e-3), sc);
        _mat.compose(_p, _q, _s);
        fruit.setMatrixAt(6 + (j % DROP_SLOTS), _mat);
        _c.copy(unripe).lerp(ripeC, dr.ripe01).lerp(BROWN, 0.75 * brownK);
        fruit.setColorAt(6 + (j % DROP_SLOTS), _c);
      }
      fruit.instanceMatrix.needsUpdate = true;
      if (fruit.instanceColor) fruit.instanceColor.needsUpdate = true;

      const fk = st.flowerK.value();
      for (let i = 0; i < nFlowers; i++) {
        const a = P.flowerAnchors[i];
        if (!a || fk <= 0.01) {
          flower.setMatrixAt(i, HIDE);
          continue;
        }
        bendPoint(_p, a.p, u, _o);
        _s.setScalar(a.s * Math.max(0, fk) * comp);
        _mat.compose(_p.divideScalar(Math.max(u.uSize.value, 1e-3)), a.q, _s);
        flower.setMatrixAt(i, _mat);
      }
      flower.instanceMatrix.needsUpdate = true;
      if (flower.instanceColor) flower.instanceColor.needsUpdate = true;
    },

    dispose() {
      group.removeFromParent();
      release(entry, [stemGeo, sproutGeo]);
      material.dispose();
      depthMaterial.dispose();
      fruitMat.dispose();
      flowerMat.dispose();
      fruit.dispose();
      flower.dispose();
      rimMat?.dispose();
      fruitRim?.geometry.dispose();
      fruitRim?.dispose();
      if (paddy) paddy.geometry.dispose();
    },
  };
  return api;
}

/** Every coin key that has a crop (16 + the fallback), for previews and tests. */
export function cropCoins() {
  return Object.keys(CROPS);
}

export { BUILDERS };

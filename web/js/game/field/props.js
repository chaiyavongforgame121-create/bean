/**
 * field/props.js — procedural geometry for everything in and around a planter box (GAME-DESIGN §3.2, §3.3, §3.5).
 *
 * Every factory returns ONE painted BufferGeometry (position, normal, color) in box-local units: origin at
 * the box centre on the ground, +Y up, +Z toward the default camera (south). `LAYOUT` holds where each prop
 * sits, shared with field/plot.js. Colour rules (J6): side props use blue/violet only (or the colour-blind
 * greys, set per instance), risk props use amber, nothing here is green/red except nature.
 *
 * Geometries meant for instance colouring (soil, sign, sacks, thermometer fill) are painted in neutral
 * luminance and tinted per instance.
 */

import { BufferAttribute, BufferGeometry, Color, CylinderGeometry, Quaternion, TorusGeometry, Vector3 } from '../three.js';
import { box, cyl, cone, lathe, prism, lowpolySphere, tubeAlong, leafStrip, merge, paint, xf, vertexAO, noise2, noise3, rng, flat } from '../gfx/geom.js';
import { FAMILY_TINT } from '../../model.js';

const TAU = Math.PI * 2;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const lerp = (a, b, k) => a + (b - a) * k;
const V = (x, y, z) => new Vector3(x, y, z);
const _c = new Color();

/** Box dimensions (§2.3: footprint 3.4 × 3.4, rim 0.45). */
export const BOX = Object.freeze({ size: 3.4, half: 1.7, rim: 0.45, wall: 0.16, soilY: 0.36, hexR: 1.78 });

/** Hexagons are pointy along ±X (flat front edge toward the camera): CylinderGeometry thetaStart = 30°. */
const HEX0 = Math.PI / 6;

/** Where each prop sits in box-local space (x, y, z). */
export const LAYOUT = Object.freeze({
  crop: [0, BOX.soilY, -0.05],
  post: [-1.3, BOX.soilY, -1.2], // tag post with the arrow sign (back-left)
  signY: 1.75, // arrow-sign centre height above the ground
  stake: [-1.25, BOX.soilY, 1.22], // ×N stake (front-left)
  thermo: [1.25, BOX.soilY, 1.22], // liquidation thermometer (front-right)
  sacks: [1.2, BOX.soilY, -1.15], // fertilizer sacks (back-right corner)
  valve: [1.62, 0.3, -1.62], // drip valve on the back-right rim
  basket: [0.75, 0, 2.08], // ripe basket, outside the front rim
  molehill: [-2.08, 0, 0.55], // mole beside SHORT boxes
  aframe: [2.12, 0, 0.35], // "!" error sign beside the box
  sachet: [0.15, BOX.soilY, 0.95], // seed sachet on a stick (waiting)
  liqSign: [0, BOX.soilY, 1.3], // LIQUIDATED board
  parasol: [1.32, BOX.soilY, -1.32],
});

/** The same props pulled inward for the hexagonal swarm box (its corners are cut). */
export const LAYOUT_HEX = Object.freeze({
  ...LAYOUT,
  post: [-1.0, BOX.soilY, -1.05],
  stake: [-0.95, BOX.soilY, 1.08],
  thermo: [0.95, BOX.soilY, 1.08],
  sacks: [0.95, BOX.soilY, -1.0],
  valve: [0.9, 0.3, -1.52],
  parasol: [1.05, BOX.soilY, -1.05],
});

/** Layout for a planter family. */
export function layoutFor(family) {
  return family === 'swarm' ? LAYOUT_HEX : LAYOUT;
}

/**
 * The family trims as the SCENE paints them: FAMILY_TINT (exact in the DOM) desaturated ~20%. Under the sun +
 * hemisphere light without tone mapping the saturated hexes clipped to neon cyan / safety orange and out-shouted
 * the crops (the subject) and the pastel palette (§1.1).
 */
export const SCENE_TRIM = Object.freeze({ standard: '#9FB3C8', hyper: '#D98B5A', degen: '#A98BD6', swarm: '#5BB4B9' });

/** Planter families (§3.2): material and trim (FAMILY_TINT carries over from the 2D page, softened for 3D). */
export const FAMILIES = Object.freeze({
  standard: { body: '#D6A266', bodyDk: '#B9844C', trim: SCENE_TRIM.standard, tint: FAMILY_TINT.standard },
  hyper: { body: '#C48058', bodyDk: '#A56645', trim: SCENE_TRIM.hyper, tint: FAMILY_TINT.hyper },
  degen: { body: '#6E5585', bodyDk: '#56426A', trim: SCENE_TRIM.degen, tint: FAMILY_TINT.degen },
  swarm: { body: '#CFA463', bodyDk: '#A47A40', trim: SCENE_TRIM.swarm, tint: FAMILY_TINT.swarm },
});

function finish(parts, { ao = true, aoMin = 0.72, aoTop = 0.35 } = {}) {
  const list = parts.map((g) => {
    for (const n of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(n)) g.deleteAttribute(n);
    if (!g.attributes.color) paint(g, 0xffffff);
    return g;
  });
  const g = merge(list, { dispose: true });
  if (ao) vertexAO(g, { min: aoMin, top: aoTop });
  g.computeBoundingSphere();
  return g;
}

/** Position (x, y, z) rotated by `rot` around +Y (xf() translates AFTER rotating, so walls need this). */
const around = (rot, x, y, z) => [x * Math.cos(rot) + z * Math.sin(rot), y, -x * Math.sin(rot) + z * Math.cos(rot)];

const jitterCol = (hex, r, amt = 0.06) => {
  const c = new Color(hex);
  const k = 1 + (r() - 0.5) * 2 * amt;
  return c.multiplyScalar(k);
};

// ------------------------------------------------------------------ planter boxes (one geometry per family)

/** Square plank box: 2 planks per wall, corner posts, painted trim cap. */
function plankBox(fam, r, { painted = false } = {}) {
  const parts = [];
  const H = BOX.half;
  const t = BOX.wall;
  const ph = 0.2;
  for (let side = 0; side < 4; side++) {
    for (let k = 0; k < 2; k++) {
      const y = 0.02 + k * (ph + 0.015);
      const len = BOX.size - 0.16;
      const g = box(len, ph, t, jitterCol(k ? fam.body : fam.bodyDk, r, painted ? 0.02 : 0.08));
      // plank grain: darker ends
      const rot = side * (Math.PI / 2);
      xf(g, { p: around(rot, 0, y, H - t / 2), r: [0, rot, 0] });
      parts.push(g);
    }
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(box(0.22, BOX.rim + 0.06, 0.22, fam.bodyDk, { p: [sx * (H - 0.08), 0, sz * (H - 0.08)] }));
    }
  }
  // trim cap
  for (let side = 0; side < 4; side++) {
    const g = box(BOX.size + 0.06, 0.07, 0.22, fam.trim);
    const rot = side * (Math.PI / 2);
    xf(g, { p: around(rot, 0, BOX.rim - 0.01, H - 0.09), r: [0, rot, 0] });
    parts.push(g);
  }
  return parts;
}

/** Terracotta box: smooth slab walls with a rounded lip band in the trim colour. */
function terracottaBox(fam) {
  const parts = [];
  const H = BOX.half;
  for (let side = 0; side < 4; side++) {
    const rot = side * (Math.PI / 2);
    const wall = box(BOX.size, BOX.rim - 0.06, BOX.wall + 0.02, fam.body, { p: around(rot, 0, 0, H - 0.09), r: [0, rot, 0] });
    // subtle bottom shading band
    paint(wall, (x, y) => new Color(fam.bodyDk).lerp(new Color(fam.body), clamp(y / 0.3, 0, 1)));
    parts.push(wall);
    const lip = box(BOX.size + 0.12, 0.1, 0.26, fam.trim);
    xf(lip, { p: around(rot, 0, BOX.rim - 0.08, H - 0.1), r: [0, rot, 0] });
    parts.push(lip);
  }
  // clay feet
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(cyl(0.12, 0.14, 0.06, 6, fam.bodyDk, { p: [sx * 1.4, -0.03, sz * 1.4] }));
  return parts;
}

/** Degen: plum paint, trim, star decals and black/yellow hazard tape on the rim (§3.2). */
function degenBox(fam, r) {
  const parts = plankBox(fam, r, { painted: true });
  const H = BOX.half;
  // hazard tape over the trim cap: alternating black / yellow segments
  const segs = 14;
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < segs; i++) {
      const w = BOX.size / segs;
      const g = box(w * 0.98, 0.012, 0.1, i % 2 ? '#1F1B24' : '#F2C230');
      const rot = side * (Math.PI / 2);
      xf(g, { p: around(rot, -BOX.half + w * (i + 0.5), BOX.rim + 0.03, H - 0.06), r: [0, rot, 0] });
      parts.push(g);
    }
  }
  // star decals on the front and right walls
  const star = (cx, cy, s, color, rotY, z) => {
    const pts = [];
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * TAU + Math.PI / 2;
      const rr = k % 2 ? s * 0.45 : s;
      pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
    }
    // a 5-point star is concave: build it as 5 convex kite prisms around the centre
    for (let k = 0; k < 5; k++) {
      const a0 = pts[(2 * k + 9) % 10];
      const tip = pts[2 * k];
      const a1 = pts[2 * k + 1];
      const g = prism([[0, 0], a0, tip, a1], 0.02, color);
      xf(g, { p: [cx, cy, z], r: [0, rotY, 0] });
      parts.push(g);
    }
  };
  star(-0.9, 0.24, 0.12, '#F6D44B', 0, H + 0.005);
  star(0.75, 0.2, 0.09, '#F7A6D8', 0, H + 0.005);
  star(0.3, 0.27, 0.07, '#FFFFFF', 0, H + 0.005);
  return parts;
}

/** Swarm: hexagonal wicker box, trim ring, a tiny beehive on one corner (§3.2; bees P2). */
function swarmBox(fam) {
  const parts = [];
  const R = BOX.hexR;
  // wicker wall: open hex cylinder, double-sided feel via inner wall
  const outer = new CylinderGeometry(R, R - 0.06, BOX.rim, 6, 6, true, HEX0);
  outer.translate(0, BOX.rim / 2, 0);
  const a = new Color(fam.body);
  const b = new Color(fam.bodyDk);
  paint(outer, (x, y, z) => {
    const ang = Math.atan2(z, x);
    const band = Math.floor(y / (BOX.rim / 6));
    const weave = (Math.floor(((ang + Math.PI) / TAU) * 36) + band) % 2;
    return weave ? a : b;
  });
  parts.push(outer);
  const inner = new CylinderGeometry(R - 0.14, R - 0.18, BOX.rim - 0.02, 6, 1, true, HEX0);
  inner.scale(-1, 1, 1); // flip so the inside faces outward-facing normals point in
  inner.translate(0, BOX.rim / 2, 0);
  paint(inner, b);
  parts.push(inner);
  const rim = new TorusGeometry(R - 0.06, 0.07, 5, 6);
  xf(rim, { p: [0, BOX.rim, 0], r: [Math.PI / 2, 0, 0] });
  paint(rim, fam.trim);
  parts.push(rim);
  // beehive on the back-right corner (skep: stacked tori)
  const hx = R * 0.42;
  const hz = -R * 0.72;
  for (let i = 0; i < 4; i++) {
    const tr = new TorusGeometry(0.17 - i * 0.035, 0.06, 5, 10);
    xf(tr, { p: [hx, BOX.rim + 0.06 + i * 0.075, hz], r: [Math.PI / 2, 0, 0] });
    paint(tr, i % 2 ? '#E8B04B' : '#D49A35');
    parts.push(tr);
  }
  parts.push(cyl(0.05, 0.05, 0.02, 8, '#3A2A18', { p: [hx, BOX.rim + 0.1, hz + 0.19], r: [Math.PI / 2, 0, 0] }));
  return parts;
}

/** The shell of a planter box for a family. */
export function boxGeometry(family) {
  const fam = FAMILIES[family] || FAMILIES.standard;
  const r = rng(family.length * 13 + 7);
  let parts;
  if (family === 'hyper') parts = terracottaBox(fam);
  else if (family === 'degen') parts = degenBox(fam, r);
  else if (family === 'swarm') parts = swarmBox(fam);
  else parts = plankBox(fam, r);
  return finish(parts, { aoTop: 0.3 });
}

/** Inverted-hull outline shell (back faces, §3.5 "scale 1.04" — drawn at 1.06 so the cream rim reads at the default zoom). */
export function outlineGeometry(hex = false) {
  const k = 1.06;
  const g = hex ? new CylinderGeometry(BOX.hexR * k, BOX.hexR * k, BOX.rim * 1.25, 6, 1, false, HEX0) : box(BOX.size * k, BOX.rim * 1.25, BOX.size * k, 0xffffff, null, { centered: true });
  g.translate(0, (BOX.rim * 1.25) / 2 - 0.03, 0);
  for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal') g.deleteAttribute(n);
  return g;
}

// ------------------------------------------------------------------ soil (instance colour = wet / dry / charred)

/** Hexagon boundary radius at angle a (flat sides, inradius ri). */
function hexRadius(a, ri) {
  const k = ((((a % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3)) - Math.PI / 6);
  return ri / Math.cos(k);
}

/**
 * Tilled soil top with 4 furrows (§3.5 empty) as a grid; `hex` clips the grid into the swarm hexagon.
 * Vertex shade: ridges 1.0, furrow bottoms 0.74, light speckle.
 */
export function soilGeometry(hex = false, { n = 20 } = {}) {
  // furrowed soil grid: 20 × 20 cells; the Low tier passes 8 (128 instead of 800 triangles per plot, QA-07)
  const N = Math.max(4, Math.round(n));
  const S = BOX.size - 2 * BOX.wall + 0.02;
  const pos = [];
  const colors = [];
  const idx = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      let x = (i / N - 0.5) * S;
      let z = (j / N - 0.5) * S;
      if (hex) {
        const a = Math.atan2(z, x);
        const rr = Math.hypot(x, z);
        const lim = hexRadius(a, BOX.hexR * Math.cos(Math.PI / 6) - 0.13);
        if (rr > lim) {
          x *= lim / rr;
          z *= lim / rr;
        }
      }
      const furrow = Math.cos((z / S + 0.5) * TAU * 4); // 4 furrows along X
      const y = BOX.soilY + 0.03 * furrow + 0.008 * noise2(x * 5, z * 5);
      pos.push(x, y, z);
      const k = lerp(0.74, 1.0, (furrow + 1) / 2) * (0.94 + 0.08 * noise2(x * 9 + 3, z * 9));
      colors.push(k, k, k);
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      const b = a + 1;
      const c = a + N + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // a skirt down to the box floor so the soil reads as a solid fill from low angles
  const skirt = hex ? new CylinderGeometry(BOX.hexR - 0.15, BOX.hexR - 0.15, BOX.soilY, 6, 1, true, HEX0) : box(S, BOX.soilY, S, 0xffffff, null, { centered: true });
  skirt.translate(0, BOX.soilY / 2 - 0.02, 0);
  paint(skirt, 0x9a9a9a);
  return finish([g, skirt], { ao: false });
}

/** Soil mound under a seed (waiting/entering; breathes in entering). Painted neutral, tinted like soil. */
export function moundGeometry() {
  const g = lathe([[0.55, 0], [0.45, 0.05], [0.3, 0.1], [0.12, 0.13], [0.0001, 0.135]], 12, { flat: false });
  paint(g, (x, y, z) => _c.setScalar(0.9 + 0.12 * noise3(x * 8, y * 8, z * 8)));
  return finish([g], { ao: false });
}

/** Dry cracks (liq danger / dying): thin dark zig-zags lying on the soil. */
/** Cracks stay on the soil of BOTH box shapes (the decal is shared): inside the hex inset's radius. */
const CRACK_MAX_R = 1.2;

export function cracksGeometry() {
  const r = rng(77);
  const parts = [];
  for (let k = 0; k < 7; k++) {
    // start inside r 0.9, short segments, and turn back toward the centre instead of leaving the soil
    const a0 = r() * TAU;
    const r0 = Math.sqrt(r()) * 0.9;
    let x = Math.cos(a0) * r0;
    let z = Math.sin(a0) * r0;
    let a = r() * TAU;
    for (let s = 0; s < 4; s++) {
      const len = 0.12 + r() * 0.14;
      a += (r() - 0.5) * 1.2;
      let nx = x + Math.cos(a) * len;
      let nz = z + Math.sin(a) * len;
      if (Math.hypot(nx, nz) > CRACK_MAX_R) {
        a = Math.atan2(-z, -x) + (r() - 0.5) * 0.6;
        nx = x + Math.cos(a) * len;
        nz = z + Math.sin(a) * len;
      }
      const w = 0.035 * (1 - s * 0.18);
      const g = box(len, 0.01, w, 0xffffff, { p: [(x + nx) / 2, BOX.soilY + 0.04, (z + nz) / 2], r: [0, -a, 0] }, { centered: true });
      parts.push(g);
      x = nx;
      z = nz;
    }
  }
  return finish(parts, { ao: false });
}

/** Hail scars (liquidated): small dark pocks on the soil. */
export function scarsGeometry() {
  const r = rng(91);
  const parts = [];
  for (let k = 0; k < 18; k++) {
    // inside the hex inset too (the decal is shared by both box shapes)
    const ang = r() * TAU;
    const rad = Math.sqrt(r()) * 1.15;
    const g = cyl(0.07 + r() * 0.05, 0.05, 0.012, 7, 0xffffff, { p: [Math.cos(ang) * rad, BOX.soilY + 0.035, Math.sin(ang) * rad] });
    parts.push(g);
  }
  return finish(parts, { ao: false });
}

// ------------------------------------------------------------------ the planted kit: tag post, ×N stake, thermometer plank

/**
 * Static wood that every planted box shows: the tag post (back-left) and the ×N stake with its plaque
 * (front-left; the number is a DOM label).
 */
export function kitGeometry(L = LAYOUT) {
  const parts = [];
  const wood = '#B07A47';
  const woodDk = '#7B5130';
  const [px, py, pz] = L.post;
  parts.push(box(0.12, 1.75, 0.12, woodDk, { p: [px, py - 0.1, pz] }));
  parts.push(cone(0.09, 0.1, 4, woodDk, { p: [px, py + 1.65, pz], r: [0, Math.PI / 4, 0] }));
  const [sx, sy, sz] = L.stake;
  parts.push(box(0.09, 0.85, 0.09, woodDk, { p: [sx, sy - 0.1, sz] }));
  // plaque (cream board with a wood frame)
  parts.push(box(0.52, 0.32, 0.05, '#F3E6CC', { p: [sx, sy + 0.5, sz + 0.06] }));
  parts.push(box(0.58, 0.04, 0.06, wood, { p: [sx, sy + 0.81, sz + 0.06] }));
  parts.push(box(0.58, 0.04, 0.06, wood, { p: [sx, sy + 0.48, sz + 0.06] }));
  return finish(parts, { aoMin: 0.8, aoTop: 0.5 });
}

/**
 * The TESTNET pennant (PLATFORM §9.4): a small black-and-white CHECKERED flag on a thin pole, fixed to the ×N
 * stake of a testnet plot. Word + shape, no new hue (J6): the DOM tag beside it reads TESTNET. Built at the stake's
 * position in the box layout `L`, so it is one shared batch instance per plot (shown only on testnet plots).
 */
export function pennantGeometry(L = LAYOUT) {
  const [sx, sy, sz] = L.stake;
  const parts = [];
  // pole: from the stake top up past the plaque
  parts.push(box(0.035, 0.62, 0.035, '#5A4632', { p: [sx + 0.25, sy + 0.66, sz + 0.06] }));
  // flag: 4 × 3 checker cells (0.09 u), hanging off the pole toward +X
  const cell = 0.09;
  const x0 = sx + 0.27;
  const y0 = sy + 1.02;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      const ink = (i + j) % 2 ? '#F5F2EA' : '#1E1B18';
      parts.push(box(cell, cell, 0.018, ink, { p: [x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell, sz + 0.06] }));
    }
  }
  return finish(parts, { ao: false });
}

/** The thermometer's backing plank with tick marks at the 0.3 / 0.6 band edges (front-right). */
export function thermoBoardGeometry(L = LAYOUT) {
  const parts = [];
  const [tx, ty, tz] = L.thermo;
  // dark wood board: the slate (ok) and amber (warn) fill read against it; a white board washed them out (J7)
  parts.push(box(0.28, 1.08, 0.05, '#4A3B30', { p: [tx, ty - 0.02, tz - 0.06] }));
  parts.push(box(0.08, 0.6, 0.06, '#7B5130', { p: [tx, ty - 0.45, tz - 0.07] }));
  for (const k of [0.3, 0.6]) parts.push(box(0.22, 0.014, 0.014, '#E9DCC4', { p: [tx, ty + 0.2 + k * 0.72, tz - 0.03] }));
  return finish(parts, { aoMin: 0.85, aoTop: 0.5 });
}

/**
 * Arrow-shaped tag sign pointing +Y (§3.3). Painted face 1.0 (tinted per instance: blue / violet / grey),
 * a lighter rim and a dark nail. Built centred on its pivot.
 */
export function signGeometry() {
  const head = prism([[-0.32, 0.12], [0.32, 0.12], [0, 0.48]], 0.07, 0xffffff);
  const shaft = prism([[-0.14, -0.42], [0.14, -0.42], [0.14, 0.13], [-0.14, 0.13]], 0.07, 0xffffff);
  const rimHead = prism([[-0.36, 0.1], [0.36, 0.1], [0, 0.53]], 0.05, 0xdedede);
  xf(rimHead, { p: [0, 0, -0.02] });
  const rimShaft = prism([[-0.17, -0.45], [0.17, -0.45], [0.17, 0.12], [-0.17, 0.12]], 0.05, 0xdedede);
  xf(rimShaft, { p: [0, 0, -0.02] });
  const nail = cyl(0.03, 0.03, 0.03, 6, 0x3a3a3a, { p: [0, -0.05, 0.035], r: [Math.PI / 2, 0, 0] });
  return finish([head, shaft, rimHead, rimShaft, nail], { ao: false });
}

/** Fertilizer sack (burlap) — tinted per instance; `hazard` adds the black/yellow band (≥ 25×, §3.2). */
export function sackGeometry(hazard = false) {
  const g = lathe([[0.0001, 0], [0.13, 0.01], [0.16, 0.08], [0.155, 0.2], [0.11, 0.27], [0.05, 0.3], [0.06, 0.34], [0.0001, 0.35]], 9, { flat: true });
  paint(g, (x, y, z) => {
    if (hazard && y > 0.1 && y < 0.2) {
      const a = Math.atan2(z, x);
      return Math.floor((a + y * 9) * 2.2) % 2 ? _c.setRGB(0.12, 0.11, 0.12) : _c.set('#F2C230');
    }
    return _c.set('#CDB58A').multiplyScalar(0.92 + 0.12 * noise3(x * 20, y * 20, z * 20));
  });
  const tie = new TorusGeometry(0.06, 0.018, 4, 8);
  xf(tie, { p: [0, 0.3, 0], r: [Math.PI / 2, 0, 0] });
  paint(tie, '#8C6B3E');
  return finish([g, tie], { aoMin: 0.82, aoTop: 0.2 });
}

/** Thermometer glass tube + bulb (transparent batch). Height 0.8 above the bulb. */
export function thermoGlassGeometry() {
  const tube = cyl(0.07, 0.07, 0.82, 10, 0xffffff, { p: [0, 0.1, 0] }, { open: false });
  const bulb = lowpolySphere(0.12, 1, { jitter: 0 });
  paint(bulb, 0xffffff);
  return finish([tube, bulb], { ao: false });
}

/** Thermometer fill column: unit height, pivot at the bottom (scale-y = d). */
export function thermoFillGeometry() {
  const g = cyl(0.045, 0.045, 1, 8, 0xffffff);
  return finish([g], { ao: false });
}

/** Thermometer bulb fill. */
export function thermoBulbGeometry() {
  const g = lowpolySphere(0.088, 1, { jitter: 0 });
  paint(g, 0xffffff);
  return finish([g], { ao: false });
}

/** Black hazard bands over the fill (danger band): 4 thin rings on a unit-height column. */
export function thermoHazardGeometry() {
  const parts = [];
  for (let i = 0; i < 5; i++) {
    const t = new TorusGeometry(0.05, 0.012, 4, 10);
    xf(t, { p: [0, 0.1 + i * 0.2, 0], r: [Math.PI / 2 + 0.35, 0, 0] });
    paint(t, 0x1c1a1d);
    parts.push(t);
  }
  return finish(parts, { ao: false });
}

/** Danger ring round the box (§3.2: #F59E0B, pulsing 0.5 Hz, scale 1 → 1.08). */
export function dangerRingGeometry() {
  const parts = [];
  const n = 28;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const g = box(0.34, 0.05, 0.13, i % 2 ? '#F59E0B' : '#2B2622', { p: [Math.cos(a) * 2.18, 0.03, Math.sin(a) * 2.18], r: [0, -a + Math.PI / 2, 0] }, { centered: true });
    parts.push(g);
  }
  return finish(parts, { ao: false });
}

/** Striped parasol: 8-segment cone, cream / pastel blue, on a pole (§3.5 paused). Pivot at the pole foot. */
export function parasolGeometry() {
  const parts = [];
  const pole = tubeAlong([V(0, -0.2, 0), V(-0.25, 1.2, 0.25), V(-0.85, 2.2, 0.85)], 0.04, 5);
  paint(pole, '#8C6B4A');
  parts.push(pole);
  const top = V(-0.95, 2.35, 0.95);
  const R = 1.55;
  const drop = -0.5;
  const segs = 8;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU;
    const a1 = ((i + 1) / segs) * TAU;
    const pts = [top.clone(), top.clone().add(V(Math.cos(a0) * R, drop, Math.sin(a0) * R)), top.clone().add(V(Math.cos(a1) * R, drop, Math.sin(a1) * R))];
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pts.flatMap((p) => [p.x, p.y, p.z])), 3));
    g.computeVertexNormals();
    paint(g, i % 2 ? '#FFF3DC' : '#A9C9E8');
    parts.push(g);
    const under = g.clone();
    const ia = under.attributes.position;
    // underside (reversed winding) so the canopy reads from below
    const arr = ia.array;
    for (let k = 0; k < 9; k += 9) {
      for (let c = 0; c < 3; c++) {
        const t = arr[3 + c];
        arr[3 + c] = arr[6 + c];
        arr[6 + c] = t;
      }
    }
    under.computeVertexNormals();
    paint(under, i % 2 ? '#E6DAC2' : '#93B4D4');
    parts.push(under);
  }
  const knob = lowpolySphere(0.08, 0, {});
  paint(knob, '#F2D47A');
  xf(knob, { p: [top.x, top.y + 0.05, top.z] });
  parts.push(knob);
  // scalloped edge beads
  for (let i = 0; i < segs; i++) {
    const a = ((i + 0.5) / segs) * TAU;
    const b = lowpolySphere(0.06, 0, {});
    paint(b, i % 2 ? '#A9C9E8' : '#FFF3DC');
    xf(b, { p: [top.x + Math.cos(a) * R * 0.93, top.y + drop - 0.02, top.z + Math.sin(a) * R * 0.93] });
    parts.push(b);
  }
  return finish(parts, { ao: false });
}

/** Woven basket (ripe: appears at the box corner, §3.5). */
export function basketGeometry({ lo = false } = {}) {
  // Low tier: fewer segments (~170 instead of ~350 triangles; a basket shows on every ripe plot, PLATFORM QA-07)
  const seg = lo ? 8 : 12;
  const g = new CylinderGeometry(0.32, 0.24, 0.26, seg, lo ? 1 : 3, true);
  g.translate(0, 0.13, 0);
  paint(g, (x, y, z) => (((Math.floor(Math.atan2(z, x) * 4) + Math.floor(y * 22)) % 2) ? _c.set('#C99A5B') : _c.set('#A97B42')));
  const inner = new CylinderGeometry(0.3, 0.22, 0.25, seg, 1, true);
  inner.scale(-1, 1, 1);
  inner.translate(0, 0.13, 0);
  paint(inner, '#8F6538');
  const bottom = cyl(0.24, 0.24, 0.02, seg, '#8F6538');
  const rim = new TorusGeometry(0.32, 0.03, lo ? 3 : 4, lo ? 10 : 14);
  xf(rim, { p: [0, 0.26, 0], r: [Math.PI / 2, 0, 0] });
  paint(rim, '#B98A4E');
  const handle = new TorusGeometry(0.28, 0.025, lo ? 3 : 4, lo ? 8 : 12, Math.PI);
  xf(handle, { p: [0, 0.26, 0] });
  paint(handle, '#B98A4E');
  return finish([g, inner, bottom, rim, handle], { aoMin: 0.8, aoTop: 0.2 });
}

/** Orange "!" A-frame sign (error flag, §3.5). */
export function aframeGeometry() {
  const parts = [];
  for (const s of [-1, 1]) {
    // warning amber (J6: amber = warning/risk) with a dark "!": the old orange blended into the hyper boxes
    const board = box(0.62, 0.72, 0.05, '#F2C14E', { p: [0, 0.38, s * 0.15], r: [s * 0.22, 0, 0] }, { centered: true });
    parts.push(board);
    const bar = box(0.09, 0.32, 0.02, '#2D2620', { p: [0, 0.48, s * 0.19], r: [s * 0.22, 0, 0] }, { centered: true });
    const dot = box(0.09, 0.09, 0.02, '#2D2620', { p: [0, 0.22, s * 0.21], r: [s * 0.22, 0, 0] }, { centered: true });
    parts.push(bar, dot);
  }
  return finish(parts, { ao: false });
}

/** Soft fog puff (frozen plots, §3.5: 3 billboard-like puffs). */
export function fogGeometry() {
  const parts = [];
  const r = rng(5);
  for (let i = 0; i < 5; i++) {
    const g = lowpolySphere(0.45 + r() * 0.25, 1, { jitter: 0.25, seed: i + 2, squash: [1.3, 0.75, 1] });
    paint(g, (x, y) => _c.setScalar(0.88 + 0.12 * clamp(y + 0.5, 0, 1)));
    xf(g, { p: [(i - 2) * 0.38, Math.abs(i - 2) * -0.06, (i % 2) * 0.2] });
    parts.push(g);
  }
  return finish(parts, { ao: false });
}

/** Seed sachet on a stick (waiting, §3.5) — or crossed out and nailed to the post (bean busted). */
export function sachetGeometry(crossed = false) {
  const parts = [];
  if (!crossed) parts.push(box(0.04, 0.55, 0.04, '#8C6B4A', { p: [0, 0, 0] }));
  const y = crossed ? 0 : 0.42;
  parts.push(box(0.34, 0.42, 0.04, '#F6EBD8', { p: [0, y, 0.03] }));
  // a printed seedling on the sachet
  parts.push(box(0.03, 0.14, 0.01, '#5F9A48', { p: [0, y + 0.1, 0.055] }));
  parts.push(box(0.12, 0.05, 0.01, '#79B25C', { p: [-0.05, y + 0.22, 0.055], r: [0, 0, 0.5] }));
  parts.push(box(0.12, 0.05, 0.01, '#79B25C', { p: [0.05, y + 0.22, 0.055], r: [0, 0, -0.5] }));
  parts.push(box(0.34, 0.06, 0.042, '#C98A4B', { p: [0, y + 0.36, 0.031] }));
  if (crossed) {
    parts.push(box(0.5, 0.05, 0.02, '#B33A32', { p: [0, y + 0.21, 0.065], r: [0, 0, 0.75] }, { centered: true }));
    parts.push(box(0.5, 0.05, 0.02, '#B33A32', { p: [0, y + 0.21, 0.065], r: [0, 0, -0.75] }, { centered: true }));
    parts.push(cyl(0.025, 0.025, 0.03, 6, '#555555', { p: [0, y + 0.38, 0.07], r: [Math.PI / 2, 0, 0] }));
  }
  return finish(parts, { ao: false });
}

/** "LIQUIDATED" board on a stake (the red text is a DOM label). */
export function liqSignGeometry() {
  return finish(
    [box(0.07, 0.75, 0.07, '#6E5238', { p: [0, -0.1, 0] }), box(0.9, 0.34, 0.05, '#EDE3D1', { p: [0, 0.48, 0.05] }), box(0.96, 0.04, 0.06, '#6E5238', { p: [0, 0.8, 0.05] })],
    { ao: false },
  );
}

/** Burned stump (empty · burned) and the liquidation stump stub. */
export function stumpGeometry() {
  const g = cyl(0.2, 0.26, 0.32, 8, '#3B3330');
  paint(g, (x, y) => (y > 0.3 ? _c.set('#5A4A40') : _c.set('#2E2724')));
  const r1 = cyl(0.05, 0.08, 0.18, 5, '#2E2724', { p: [0.2, 0, 0.08], r: [0, 0, -0.6] });
  return finish([g, r1], { ao: false });
}

/** Pick-mode glow: a dashed ring around the box (emissive-looking, unlit material). */
export function glowRingGeometry() {
  const parts = [];
  const n = 32;
  for (let i = 0; i < n; i += 1) {
    if (i % 2) continue;
    const a = (i / n) * TAU;
    const g = box(0.32, 0.05, 0.08, 0xffffff, { p: [Math.cos(a) * 2.02, 0, Math.sin(a) * 2.02], r: [0, -a + Math.PI / 2, 0] }, { centered: true });
    parts.push(g);
  }
  return finish(parts, { ao: false });
}

/** "Plant here" seed sign: a small stake with a seed-shaped token (no text, §3.5 empty in pick mode). */
export function seedSignGeometry() {
  const stake = box(0.06, 0.7, 0.06, '#8C6B4A', { p: [0, 0, 0] });
  const seed = lowpolySphere(0.2, 1, { jitter: 0.04, squash: [0.75, 1, 0.4] });
  paint(seed, '#E9C873');
  xf(seed, { p: [0, 0.8, 0.02], r: [0, 0, 0.35] });
  const sprout = leafStrip({ length: 0.22, width: 0.14, segments: 2, curl: 0.1, fold: 0.3 });
  paint(sprout, '#79B25C');
  xf(sprout, { p: [0.02, 0.98, 0.02], r: [-1.2, 0.6, 0] });
  return finish([stake, seed, sprout], { ao: false });
}

/** Trowel (planting pending): blade pointing −Y, handle up. Pivot at the blade tip. */
export function trowelGeometry() {
  const blade = prism([[-0.12, 0.05], [0.12, 0.05], [0.0, -0.2]], 0.02, '#B8C2C8');
  xf(blade, { p: [0, 0.2, 0] });
  const neck = box(0.03, 0.12, 0.03, '#8A949A', { p: [0, 0.25, 0] });
  const handle = cyl(0.04, 0.045, 0.28, 6, '#C98A4B', { p: [0, 0.37, 0] });
  return finish([blade, neck, handle], { ao: false });
}

/** Drip valve wheel on a short pipe stub (back-right rim). The wheel turns when the valve opens/closes. */
export function valveGeometry() {
  const pipe = tubeAlong([V(0, -0.3, 0), V(0, 0.08, 0), V(0.0, 0.1, -0.4)], 0.05, 6);
  paint(pipe, '#8E9AA3');
  const wheel = new TorusGeometry(0.11, 0.022, 4, 10);
  xf(wheel, { p: [0, 0.2, 0], r: [Math.PI / 2, 0, 0] });
  paint(wheel, '#C9483F');
  const spoke1 = box(0.22, 0.02, 0.02, '#C9483F', { p: [0, 0.2, 0] }, { centered: true });
  const spoke2 = box(0.02, 0.02, 0.22, '#C9483F', { p: [0, 0.2, 0] }, { centered: true });
  const stem = cyl(0.02, 0.02, 0.12, 5, '#6F7A83', { p: [0, 0.08, 0] });
  return finish([pipe, wheel, spoke1, spoke2, stem], { ao: false });
}

// ------------------------------------------------------------------ critters (P1): bluebird (LONG) and mole (SHORT)

/** Bluebird (tinted per instance: blue, or light grey in the colour-blind palette). Faces +Z. */
export function birdGeometry() {
  const body = lowpolySphere(0.13, 1, { jitter: 0.04, squash: [0.9, 0.85, 1.25] });
  paint(body, (x, y, z) => (y < -0.02 && z > -0.05 ? _c.setRGB(1.5, 1.4, 1.2) : _c.setScalar(1)));
  const head = lowpolySphere(0.085, 1, { jitter: 0.03 });
  xf(head, { p: [0, 0.1, 0.1] });
  paint(head, 0xffffff);
  const beak = cone(0.025, 0.07, 4, '#F2B04A', { p: [0, 0.1, 0.18], r: [Math.PI / 2, 0, 0] });
  const eyeL = lowpolySphere(0.014, 0, {});
  xf(eyeL, { p: [0.05, 0.13, 0.16] });
  paint(eyeL, 0x111111);
  const eyeR = lowpolySphere(0.014, 0, {});
  xf(eyeR, { p: [-0.05, 0.13, 0.16] });
  paint(eyeR, 0x111111);
  const tail = prism([[-0.06, 0], [0.06, 0], [0, 0.16]], 0.02, 0xd8d8d8);
  xf(tail, { p: [0, 0.0, -0.15], r: [-1.9, 0, 0] });
  const wing = lowpolySphere(0.08, 0, { squash: [0.35, 0.7, 1.2] });
  paint(wing, 0xbdbdbd);
  const w1 = wing.clone();
  xf(wing, { p: [0.11, 0.0, -0.01] });
  xf(w1, { p: [-0.11, 0.0, -0.01] });
  const legs = box(0.08, 0.06, 0.02, '#F2B04A', { p: [0, -0.15, 0.02] });
  return finish([body, head, beak, eyeL, eyeR, tail, wing, w1, legs], { ao: false });
}

/** Mole with a tiny hard hat (hat tinted per instance via a separate batch? no: hat painted violet-neutral). Faces +Z. */
export function moleGeometry() {
  const body = lowpolySphere(0.16, 1, { jitter: 0.05, squash: [1, 0.95, 1.1] });
  paint(body, '#6B5A50');
  const snout = lowpolySphere(0.06, 0, { squash: [1, 0.8, 1.2] });
  xf(snout, { p: [0, -0.01, 0.15] });
  paint(snout, '#8A786C');
  const nose = lowpolySphere(0.03, 0, {});
  xf(nose, { p: [0, 0.0, 0.21] });
  paint(nose, '#F2A7A0');
  const pawL = lowpolySphere(0.05, 0, { squash: [1.3, 0.5, 1] });
  xf(pawL, { p: [0.12, -0.08, 0.1] });
  paint(pawL, '#F2C7B5');
  const pawR = pawL.clone();
  xf(pawR, { p: [-0.24, 0, 0] });
  const eyeL = lowpolySphere(0.012, 0, {});
  xf(eyeL, { p: [0.05, 0.06, 0.13] });
  paint(eyeL, 0x111111);
  const eyeR = eyeL.clone();
  xf(eyeR, { p: [-0.1, 0, 0] });
  return finish([body, snout, nose, pawL, pawR, eyeL, eyeR], { ao: false });
}

/** The mole's hard hat (tinted per instance: violet, or dark grey in the colour-blind palette). */
export function moleHatGeometry() {
  const dome = lathe([[0.0001, 0.12], [0.06, 0.115], [0.1, 0.09], [0.12, 0.04], [0.15, 0.03], [0.15, 0.0], [0.0001, 0.0]], 10, { flat: true });
  paint(dome, 0xffffff);
  const lamp = cyl(0.03, 0.03, 0.03, 6, '#FFF3B0', { p: [0, 0.07, 0.1], r: [Math.PI / 2, 0, 0] });
  return finish([dome, lamp], { ao: false });
}

/** Molehill (soil cone, tinted like dry soil). */
export function molehillGeometry() {
  const g = lathe([[0.42, 0], [0.33, 0.06], [0.2, 0.13], [0.08, 0.17], [0.0001, 0.18]], 10, { flat: true });
  paint(g, (x, y, z) => _c.setScalar(0.85 + 0.15 * noise3(x * 9, y * 9, z * 9)));
  return finish([g], { ao: false });
}

/** Quaternion helpers for prop poses. */
export const Q = {
  yaw: (a) => new Quaternion().setFromAxisAngle(V(0, 1, 0), a),
  roll: (a) => new Quaternion().setFromAxisAngle(V(0, 0, 1), a),
  pitch: (a) => new Quaternion().setFromAxisAngle(V(1, 0, 0), a),
};

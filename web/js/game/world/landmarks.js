/**
 * world/landmarks.js — every landmark of GAME-DESIGN §2.4, built procedurally (WP3).
 *
 *   buildLandmarks({ tier, puffs }) → {
 *     list: Landmark[], byId: Map<id, Landmark>, pipes,
 *     setMoney(levels), setBarProgress(p), kickWindmill(), gustWindmill(), setSundial(b), setSundialHour(h),
 *     timelapse(), setUnread(n), setHalted(b), setFeedLook(state), setNight(k), setSlotCount(n),
 *     setActiveSpouts(map), flow(slot, dir), update(dt, env) → busy, dispose()
 *   }
 *   Landmark = { id, object3D, proxy, anchor, setState(s), update(dt, env) → busy, blob: {x, z, r} }
 *
 * Conventions
 * - Each landmark is built in local space (origin on the ground at its centre, FRONT = +Z) and the group is
 *   placed at LANDMARKS[id] with rotation.y = yaw. Static parts are merged into ONE toon vertex-colour mesh per
 *   landmark; only moving parts (sails, levels, flags, shutters, sachets…) are separate meshes.
 * - `proxy` is an invisible box on layer 1 for the picker (WP2 registers it as {type:'landmark', id}).
 * - `anchor` is an Object3D where the DOM label/tooltip goes (barn sign, crates total, windmill dial, …).
 * - No text is ever drawn into WebGL (§1.4): boards and signs are blank; the DOM labels carry the words.
 * - Colours obey J6: nothing in the scenery uses the money green/red or side blue/violet as a signal. The only
 *   "signal" colours are the amber mailbox flag (warning) and the spec'd red cap tag on the tower valve.
 */
import {
  CircleGeometry,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshToonMaterial,
  Object3D,
  BoxGeometry,
  Vector3,
} from '../three.js';
import { box, cone, cyl, flat, kit, lathe, lowpolySphere, merge, paint, prism, tubeAlong, xf } from '../gfx/geom.js';
import { propMaterial, sharedUniforms, toonGradient } from '../gfx/materials.js';
import { PAL, mixHex, scaleHex } from '../gfx/palette.js';
import {
  EASE,
  LANDMARKS,
  PIPE,
  Tween,
  WINDMILL,
  clamp01,
  compostScale,
  crateLayout,
  kickProfile,
  pipeLayout,
  pipeRouteTo,
  popScale,
  windmillSpinStep,
} from './logic.js';
import { clamp, hash2, lerp, rng } from './noise.js';
import { heightAt, pondShoreRadius, pondWaterY } from './terrain.js';
import { cropFor } from '../crops/catalog.js';

const TAU = Math.PI * 2;
const toonVC = () => propMaterial({ vertexColors: true, toon: true });

// ------------------------------------------------------------------ shared helpers

let proxyMat = null;
function proxyMaterial() {
  if (!proxyMat) proxyMat = new MeshBasicMaterial({ visible: false });
  return proxyMat;
}

/**
 * Pick proxies per landmark: [w, h, d, cx, cy, cz] in the landmark's local space (front = +Z). They are
 * invisible, so their size changes no art: each one is sized so that it projects to a tap target of at least
 * 44 × 44 CSS px at 390 × 844 in the default (portrait) framing, inside the screen (PLATFORM QA-01, WCAG 2.5.8).
 * The stall and the board sit at the phone's screen edge: their proxies reach forward, over the ground in front
 * of the counter / the board face, where a player naturally taps "at the stall".
 */
export const PICK_PROXIES = Object.freeze({
  stall: Object.freeze([3.8, 3.4, 5.2, 0, 1.7, 1.6]),
  barn: Object.freeze([6.4, 5.9, 5.2, 0, 2.95, 0]),
  silo: Object.freeze([5.0, 8.3, 4.8, 0.3, 4.15, 0.45]),
  crates: Object.freeze([3.6, 3.2, 3.6, 0, 1.6, 0]),
  compost: Object.freeze([3.6, 1.5, 3.8, 0.5, 0.75, 1.7]),
  tower: Object.freeze([4.2, 8.9, 4.2, 0, 4.45, 0]),
  pond: Object.freeze([6.6, 1.6, 6.8, -0.7, 0.4, -0.6]),
  windmill: Object.freeze([5.4, 10.4, 5.0, 0, 5.2, 0.4]),
  sundial: Object.freeze([3.6, 3.6, 3.6, 0, 1.8, 0]),
  board: Object.freeze([4.4, 3.4, 3.2, 0, 1.7, 1.2]),
  mailbox: Object.freeze([2.8, 3.2, 2.8, 0, 1.6, 0]),
  firepit: Object.freeze([3.4, 2.6, 3.4, 0, 1.3, 0]),
  pip: Object.freeze([3.2, 3.6, 2.4, 0, 1.8, 0.3]),
  signpost: Object.freeze([4.9, 7.2, 2.4, 0, 3.6, 0.3]),
});

/** The pick box of landmark `id` (PICK_PROXIES). */
function proxyFor(id) {
  const [w, h, d, cx, cy, cz] = PICK_PROXIES[id];
  return proxyBox(w, h, d, cx, cy, cz);
}

/** Invisible pick box on layer 1 (§5.3 "tests only invisible proxy boxes"). */
function proxyBox(w, h, d, cx = 0, cy = h / 2, cz = 0) {
  const m = new Mesh(new BoxGeometry(w, h, d), proxyMaterial());
  m.position.set(cx, cy, cz);
  m.layers.set(1);
  m.visible = false;
  m.name = 'proxy';
  return m;
}

function anchorAt(x, y, z, name = 'anchor') {
  const o = new Object3D();
  o.position.set(x, y, z);
  o.name = name;
  return o;
}

function staticMesh(k, name, { ao = true, shadow = true } = {}) {
  const g = k.build({ ao, aoMin: 0.72, aoTop: 0.9 });
  const m = new Mesh(g, toonVC());
  m.name = name;
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

function dynMesh(geo, name, { shadow = true, mat = null } = {}) {
  const m = new Mesh(geo, mat || toonVC());
  m.name = name;
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

/** Place a landmark group on the island at its §2.2 position and facing. */
function place(group, id) {
  const L = LANDMARKS[id];
  group.position.set(L.x, heightAt(L.x, L.z), L.z);
  group.rotation.y = L.yaw || 0;
  group.name = `lm:${id}`;
  return group;
}

/** Planks with slightly varied tones (vertex colours) — wood never looks flat. */
function plankTone(base, i) {
  return mixHex(base, scaleHex(base, 0.86), hash2(i * 1.7, i * 0.3));
}

function record(id, group, proxy, anchor, extra = {}) {
  group.add(proxy, anchor);
  return { id, object3D: group, proxy, anchor, setState() {}, update() { return false; }, ...extra };
}

// ------------------------------------------------------------------ seed stall (−16, 0) faces +X

function buildStall() {
  const g = place(new Group(), 'stall');
  const k = kit();
  // counter with vertical boards
  k.add(box(3.3, 0.95, 0.95), PAL.woodMid, { p: [0, 0, 0.15] });
  for (let i = 0; i < 9; i++) k.add(box(0.34, 0.9, 0.04), plankTone(PAL.wood, i), { p: [-1.45 + i * 0.362, 0.03, 0.64] });
  k.add(box(3.55, 0.1, 1.25), PAL.woodLt, { p: [0, 0.95, 0.2] });
  k.add(box(3.55, 0.07, 0.08), PAL.woodDk, { p: [0, 0.92, 0.84] });
  // posts
  for (const [x, z, h] of [[-1.62, -0.55, 2.75], [1.62, -0.55, 2.75], [-1.62, 0.95, 2.2], [1.62, 0.95, 2.2]]) k.add(box(0.14, h, 0.14), PAL.woodDk, { p: [x, 0, z] });
  // striped awning (butter / cream), sloping toward the front
  const n = 8;
  const slope = Math.atan2(2.72 - 2.16, 2.0);
  for (let i = 0; i < n; i++) {
    const x = -1.8 + (i + 0.5) * (3.6 / n);
    k.add(box(3.6 / n + 0.005, 0.06, 2.1), i % 2 ? PAL.cream : PAL.butter, { p: [x, 2.42, 0.2], r: [slope, 0, 0] });
    // scalloped valance
    k.add(prism([[-0.22, 0], [0.22, 0], [0, -0.26]], 0.04), i % 2 ? PAL.cream : PAL.butter, { p: [x, 2.13, 1.24] });
  }
  // back board + sign (blank; the DOM tooltip names it) with a painted seedling
  k.add(box(3.3, 0.9, 0.08), PAL.woodMid, { p: [0, 1.0, -0.55] });
  k.add(box(2.3, 0.62, 0.1), PAL.woodLt, { p: [0, 2.82, -0.55] });
  k.add(box(2.42, 0.08, 0.12), PAL.woodDk, { p: [0, 3.42, -0.55] });
  k.add(lowpolySphere(0.13, 0, { jitter: 0.1 }), PAL.woodDk, { p: [0, 3.0, -0.48], s: [1.3, 0.9, 0.5] });
  k.add(prism([[0, 0], [0.28, 0.12], [0.34, 0.26], [0.1, 0.2]], 0.03), PAL.leafB, { p: [0.05, 3.08, -0.47] });
  k.add(prism([[0, 0], [-0.26, 0.1], [-0.3, 0.24], [-0.08, 0.18]], 0.03), PAL.leafA, { p: [-0.05, 3.08, -0.47] });
  // seed sacks + bin for busted sachets
  k.add(lowpolySphere(0.42, 1, { jitter: 0.12, squash: [1, 1.2, 0.9] }), PAL.straw, { p: [-2.15, 0.4, 0.6] });
  k.add(cyl(0.18, 0.24, 0.18, 6), PAL.strawDk, { p: [-2.15, 0.85, 0.6] });
  k.add(lowpolySphere(0.34, 1, { jitter: 0.12, squash: [1, 1.1, 0.9] }), mixHex(PAL.straw, PAL.canvas, 0.4), { p: [-2.1, 0.3, -0.25] });
  k.add(box(0.95, 0.42, 0.6), PAL.woodMid, { p: [1.1, 0, 1.2] });
  k.add(box(0.85, 0.05, 0.5), PAL.woodDk, { p: [1.1, 0.4, 1.2] });
  g.add(staticMesh(k, 'stallStatic'));

  // sachets: paper + coin-coloured label (two instanced meshes sharing matrices)
  const paperGeo = merge([box(0.42, 0.56, 0.06), prism([[-0.21, 0], [0.21, 0], [0.16, 0.08], [-0.16, 0.08]], 0.06, null, { p: [0, 0.56, 0] })], { dispose: true });
  paint(paperGeo, PAL.canvas);
  const labelGeo = merge([box(0.36, 0.24, 0.07, null, { p: [0, 0.16, 0] }), lowpolySphere(0.07, 0, { jitter: 0.05, t: { p: [0, 0.28, 0.035], s: [1, 1, 0.4] } })], { dispose: true });
  paint(labelGeo, 0xffffff);
  const sachets = new InstancedMesh(paperGeo, toonVC(), 5);
  const labels = new InstancedMesh(labelGeo, propMaterial({ color: 0xffffff, toon: true }), 5);
  labels.instanceColor = new InstancedBufferAttribute(new Float32Array(15), 3);
  sachets.castShadow = labels.castShadow = false; // tiny: no shadow-pass draw calls
  sachets.name = 'sachets';
  labels.name = 'sachetLabels';
  g.add(sachets, labels);
  const sx = [-1.2, -0.6, 0, 0.6, 1.2];
  const st = sx.map(() => ({ lift: new Tween(0), spin: new Tween(0), drop: new Tween(0), slide: new Tween(0), coin: null, empty: false }));
  const o = new Object3D();
  const m4 = new Matrix4();
  const col = new Color();
  // until the shelf's coins arrive (setState({coins})), the counter shows plain seed packets in neutral pastels
  [PAL.butter, PAL.peach, PAL.lavender, PAL.cream, PAL.strawDk].forEach((c, i) => labels.setColorAt(i, col.set(c)));

  function writeSachets() {
    for (let i = 0; i < 5; i++) {
      const s = st[i];
      const drop = s.drop.v; // 0 on the plank → 1 in the bin
      const slide = s.slide.v; // 0 in place → 1 slid out to the side (restock)
      const x = lerp(sx[i], 1.1, drop) + slide * 0.8;
      const y = lerp(1.0, 0.18, EASE.iOC(drop)) + s.lift.v * 0.3;
      const z = lerp(0.35, 1.2, drop);
      o.position.set(x, y, z);
      o.rotation.set(-0.12 - drop * 1.2, s.spin.v * TAU, drop * 0.6);
      o.scale.setScalar(s.empty ? 0.0001 : 1);
      o.updateMatrix();
      sachets.setMatrixAt(i, m4.copy(o.matrix));
      labels.setMatrixAt(i, m4);
    }
    sachets.instanceMatrix.needsUpdate = true;
    labels.instanceMatrix.needsUpdate = true;
  }

  // shutters (closed when the field is halted) + the hanging "closed" plank (the words are DOM)
  const shutter = new Group();
  shutter.position.set(0, 2.12, 1.32);
  const sk = kit();
  for (let i = 0; i < 6; i++) sk.add(box(0.56, 1.1, 0.06), plankTone(PAL.woodMid, i + 3), { p: [-1.4 + i * 0.56, -1.1, 0] });
  sk.add(box(3.4, 0.08, 0.08), PAL.woodDk, { p: [0, -0.35, 0.05] });
  sk.add(box(3.4, 0.08, 0.08), PAL.woodDk, { p: [0, -0.95, 0.05] });
  const shutterMesh = dynMesh(sk.build(), 'stallShutter');
  shutter.add(shutterMesh);
  const plank = dynMesh(merge([box(1.0, 0.34, 0.05, PAL.cream, { p: [0, -0.55, 0.12] }), box(0.03, 0.4, 0.02, PAL.woodDk, { p: [-0.35, -0.2, 0.1], r: [0, 0, 0.5] }), box(0.03, 0.4, 0.02, PAL.woodDk, { p: [0.35, -0.2, 0.1], r: [0, 0, -0.5] })], { dispose: true }), 'stallClosedSign');
  shutter.add(plank);
  g.add(shutter);
  const shut = new Tween(0); // 0 open (folded up under the awning) → 1 closed
  const writeShutter = () => {
    shutter.rotation.x = lerp(-1.48, 0, shut.v);
    shutter.visible = shut.v > 0.001;
    plank.visible = shut.v > 0.9;
  };

  const lm = record('stall', g, proxyFor('stall'), anchorAt(0, 2.3, 0.9));
  lm.blob = { x: LANDMARKS.stall.x, z: LANDMARKS.stall.z, r: 2.4 };
  let reduced = false;
  lm.setState = (s = {}) => {
    const dur = reduced ? 0 : 1;
    if (Array.isArray(s.coins)) {
      for (let i = 0; i < 5; i++) {
        const coin = s.coins[i] ?? null;
        const S = st[i];
        if (coin !== S.coin) {
          const wasEmpty = S.empty;
          S.coin = coin;
          S.empty = !coin;
          if (coin) {
            labels.setColorAt(i, col.set(cropFor(coin).ripe));
            // restock: slide a new sachet in (§4.3, 400 ms)
            if (!wasEmpty || S.drop.v > 0.5) {
              S.drop.set(0, 0);
              S.slide.set(1, 0);
              S.slide.set(0, 0.4 * dur, EASE.oC);
            }
          }
        }
      }
      if (labels.instanceColor) labels.instanceColor.needsUpdate = true;
    }
    if ('selected' in s) {
      for (let i = 0; i < 5; i++) {
        const on = s.selected != null && (st[i].coin === s.selected || i === s.selected);
        const S = st[i];
        if (on && S.lift.to !== 1) {
          S.lift.set(reduced ? 0 : 1, 0.4 * dur, EASE.oC);
          S.spin.set(0, 0);
          S.spin.set(reduced ? 0 : 1, 0.4 * dur, EASE.oC);
        } else if (!on) S.lift.set(0, 0.3 * dur, EASE.iOS);
      }
    }
    if (s.bust != null) {
      // that sachet tilts and drops into the bin below the plank (§4.3, 500 ms)
      const i = st.findIndex((S) => S.coin === s.bust || st.indexOf(S) === s.bust);
      if (i >= 0) st[i].drop.set(1, 0.5 * dur, EASE.iOC);
    }
    if ('closed' in s) shut.set(s.closed ? 1 : 0, 0.6 * dur, s.closed ? EASE.oB : EASE.iOC);
  };
  lm.update = (dt, env) => {
    reduced = env.reduced;
    let busy = false;
    for (const S of st) busy = S.lift.step(dt) | S.spin.step(dt) | S.drop.step(dt) | S.slide.step(dt) || busy;
    writeSachets();
    if (shut.step(dt)) busy = true;
    writeShutter();
    return busy;
  };
  writeSachets();
  writeShutter();
  return lm;
}

// ------------------------------------------------------------------ barn (0, −13) faces S

function buildBarn(puffs) {
  const g = place(new Group(), 'barn');
  const k = kit();
  const W = 3.0; // half width
  const D = 4.5;
  // stone foundation
  k.add(box(6.35, 0.4, 4.85), PAL.stoneDk, {});
  for (let i = 0; i < 14; i++) k.add(box(0.42, 0.18, 0.06), mixHex(PAL.stone, PAL.stoneDk, hash2(i, 2)), { p: [-2.9 + i * 0.445, 0.1 + (i % 2) * 0.12, 2.43] });
  // body with gables (one convex prism, front view polygon)
  const body = [[-W, 0.4], [W, 0.4], [W, 2.95], [2.15, 4.3], [0, 5.25], [-2.15, 4.3], [-W, 2.95]];
  k.add(prism(body, D), PAL.barn, {});
  // board-and-batten lines on the front/back and sides
  for (let i = 0; i < 13; i++) {
    const x = -2.85 + i * 0.475;
    const ax = Math.abs(x);
    const top = (ax < 2.15 ? 4.3 + (2.15 - ax) * 0.442 : 2.95 + (W - ax) * 1.588) - 0.08;
    // front: battens beside the door, and above it only where the door is
    const y0 = ax < 1.3 ? 2.85 : 0.45;
    if (top - y0 > 0.1) k.add(box(0.05, top - y0, 0.03), PAL.barnDk, { p: [x, y0, D / 2 + 0.01] });
    k.add(box(0.05, top - 0.45, 0.03), PAL.barnDk, { p: [x, 0.45, -D / 2 - 0.01] });
  }
  for (let i = 0; i < 9; i++) {
    const z = -2.0 + i * 0.5;
    for (const sx of [-1, 1]) k.add(box(0.03, 2.5, 0.05), PAL.barnDk, { p: [sx * (W + 0.01), 0.45, z] });
  }
  // white trim: corners, eaves line, gable edges
  for (const [x, z] of [[-W, D / 2], [W, D / 2], [-W, -D / 2], [W, -D / 2]]) k.add(box(0.2, 2.6, 0.2), PAL.trim, { p: [x, 0.4, z] });
  for (const zz of [D / 2 + 0.04, -D / 2 - 0.04]) {
    const edge = (a, b) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) + 0.12;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      k.add(box(len, 0.16, 0.08, null, null, { centered: true }), PAL.trim, { p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, zz], r: [0, 0, ang] });
    };
    edge([-W, 2.95], [-2.15, 4.3]);
    edge([-2.15, 4.3], [0, 5.25]);
    edge([0, 5.25], [2.15, 4.3]);
    edge([2.15, 4.3], [W, 2.95]);
    k.add(box(6.1, 0.16, 0.08), PAL.trim, { p: [0, 2.88, zz] });
  }
  // gambrel roof slabs (two pitches each side) with an overhang
  const slab = (a, b, tone) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) + 0.18;
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const slabGeo = box(len, 0.18, D + 0.75, null, { p: [0, -0.09, 0] }, { centered: false });
    paint(slabGeo, (x, y, z) => mixHex(tone, scaleHex(tone, 0.9), (Math.floor((z + 3) / 0.55) % 2) * 0.6));
    k.add(slabGeo, null, { p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.12, 0], r: [0, 0, ang] });
  };
  slab([-W - 0.3, 2.78], [-2.15, 4.33], PAL.roofDk);
  slab([-2.15, 4.33], [0, 5.3], PAL.roof);
  slab([0, 5.3], [2.15, 4.33], PAL.roof);
  slab([2.15, 4.33], [W + 0.3, 2.78], PAL.roofDk);
  k.add(box(0.34, 0.16, D + 0.8), PAL.trim, { p: [0, 5.33, 0] });
  // big sliding doors with white X braces
  k.add(box(2.6, 0.12, 0.12), PAL.metalDk, { p: [0, 2.72, D / 2 + 0.12] });
  for (const sx of [-1, 1]) {
    const cx = sx * 0.6;
    k.add(box(1.18, 2.3, 0.08), PAL.barnDk, { p: [cx, 0.4, D / 2 + 0.06] });
    k.add(box(1.18, 0.12, 0.05), PAL.trim, { p: [cx, 2.6, D / 2 + 0.11] });
    k.add(box(1.18, 0.12, 0.05), PAL.trim, { p: [cx, 0.42, D / 2 + 0.11] });
    k.add(box(0.12, 2.3, 0.05), PAL.trim, { p: [cx - 0.53, 0.4, D / 2 + 0.11] });
    k.add(box(0.12, 2.3, 0.05), PAL.trim, { p: [cx + 0.53, 0.4, D / 2 + 0.11] });
    for (const s2 of [-1, 1]) k.add(box(0.1, 2.35, 0.04, null, { p: [0, -1.17, 0] }), PAL.trim, { p: [cx, 1.5, D / 2 + 0.12], r: [0, 0, s2 * 0.45] });
  }
  // gable sign board (the DOM barn sign anchors here)
  k.add(box(2.3, 0.82, 0.08), PAL.woodDk, { p: [0, 3.24, D / 2 + 0.08] });
  k.add(box(2.14, 0.66, 0.08), PAL.cream, { p: [0, 3.32, D / 2 + 0.12] });
  // hay bales
  for (const [x, y, z, r0] of [[3.75, 0.48, 1.3, 0.2], [3.85, 0.48, 0.1, -0.1], [3.8, 1.36, 0.7, 0.05]]) {
    const bale = flat(cyl(0.48, 0.48, 1.05, 9, null, { r: [0, 0, Math.PI / 2], p: [0.52, 0, 0] }, { centered: false }));
    paint(bale, (px, py, pz) => mixHex(PAL.straw, PAL.strawDk, (Math.abs(px) % 0.35) < 0.05 ? 0.8 : 0.15));
    k.add(bale, null, { p: [x - 0.52, y, z], r: [0, Math.PI / 2 + r0, 0] });
  }
  // stovepipe (smoke source) on the back-left roof slope
  k.add(cyl(0.14, 0.14, 1.25, 8), PAL.metalDk, { p: [-1.55, 4.25, -1.3] });
  k.add(cyl(0.22, 0.16, 0.14, 8), PAL.metalDk, { p: [-1.55, 5.48, -1.3] });
  // lantern bracket by the door
  k.add(box(0.06, 0.06, 0.32), PAL.metalDk, { p: [1.55, 2.3, D / 2 + 0.16] });
  g.add(staticMesh(k, 'barnStatic'));

  // windows (warm emissive at clock-night; no point lights §9.8)
  const wk = kit();
  for (const sx of [-1, 1]) for (const z of [-1.0, 1.0]) wk.add(box(0.06, 0.7, 0.7), 0x3f4852, { p: [sx * (W + 0.03), 1.45, z] });
  wk.add(cyl(0.34, 0.34, 0.06, 10, null, { r: [Math.PI / 2, 0, 0] }, { centered: true }), 0x3f4852, { p: [0, 4.45, D / 2 + 0.06] });
  wk.add(box(0.18, 0.24, 0.18), 0x3f4852, { p: [1.55, 2.06, D / 2 + 0.34] });
  const winMat = new MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient(), emissive: 0xffc97a, emissiveIntensity: 0 });
  const windows = new Mesh(wk.build(), winMat);
  windows.name = 'barnWindows';
  g.add(windows);
  // white window frames (static, separate so the glass can glow)
  const fk = kit();
  for (const sx of [-1, 1]) for (const z of [-1.0, 1.0]) {
    fk.add(box(0.05, 0.86, 0.1), PAL.trim, { p: [sx * (W + 0.05), 1.37, z - 0.4] });
    fk.add(box(0.05, 0.86, 0.1), PAL.trim, { p: [sx * (W + 0.05), 1.37, z + 0.4] });
    fk.add(box(0.05, 0.1, 0.9), PAL.trim, { p: [sx * (W + 0.05), 2.15, z] });
    fk.add(box(0.05, 0.1, 0.9), PAL.trim, { p: [sx * (W + 0.05), 1.37, z] });
    fk.add(box(0.05, 0.7, 0.05), PAL.trim, { p: [sx * (W + 0.06), 1.45, z] });
    fk.add(box(0.05, 0.05, 0.7), PAL.trim, { p: [sx * (W + 0.06), 1.78, z] });
  }
  const ring = tubeAlong(Array.from({ length: 13 }, (_, i) => [Math.cos((i / 12) * TAU) * 0.38, 4.45 + Math.sin((i / 12) * TAU) * 0.38, D / 2 + 0.1]), 0.05, 4, { caps: false });
  fk.add(ring, PAL.trim);
  g.add(staticMesh(fk, 'barnFrames', { ao: false, shadow: false }));

  // weather vane: arrow + rooster, turns slowly into the (west) wind and wobbles in gusts
  const vk = kit();
  vk.add(cyl(0.035, 0.035, 1.1, 5), PAL.metalDk, { p: [0, 5.38, 0] });
  vk.add(box(0.9, 0.03, 0.03), PAL.metalDk, { p: [0, 5.9, 0] });
  vk.add(box(0.03, 0.03, 0.9), PAL.metalDk, { p: [0, 5.9, 0] });
  g.add(staticMesh(vk, 'vaneBase', { ao: false }));
  const vane = new Group();
  vane.position.set(0, 6.3, 0);
  const ak = kit();
  ak.add(box(1.2, 0.04, 0.04), 0x8a6b4a, { p: [0, -0.02, 0] }, {});
  ak.add(prism([[0.6, 0.12], [0.85, 0], [0.6, -0.12]], 0.04), 0x8a6b4a);
  ak.add(prism([[-0.6, 0.18], [-0.38, 0.0], [-0.6, -0.18], [-0.72, 0]], 0.03), 0x8a6b4a);
  // rooster silhouette
  ak.add(prism([[-0.2, 0.02], [0.15, 0.02], [0.28, 0.2], [0.22, 0.36], [0.12, 0.3], [-0.05, 0.22], [-0.25, 0.3], [-0.3, 0.12]], 0.03), 0x9c7650);
  ak.add(prism([[0.18, 0.36], [0.22, 0.46], [0.3, 0.38]], 0.03), 0x9c7650);
  const vaneMesh = dynMesh(ak.build(), 'vane', { shadow: false });
  vane.add(vaneMesh);
  g.add(vane);

  const lm = record('barn', g, proxyFor('barn'), anchorAt(0, 3.32, D / 2 + 0.2));
  lm.blob = { x: LANDMARKS.barn.x, z: LANDMARKS.barn.z, r: 4.2 };
  lm.windows = winMat;
  const chimney = new Vector3();
  let smokeAcc = 0;
  lm.update = (dt, env) => {
    // vane: points into the wind (from the west) with a lazy wobble that grows with wind and gusts
    const wob = env.reduced ? 0 : Math.sin(env.time * 0.7) * 0.25 * env.wind + Math.sin(env.time * 2.3) * 0.06 * env.wind + env.gustK * 0.5 * Math.sin(env.time * 9);
    vane.rotation.y = Math.PI - (LANDMARKS.barn.yaw || 0) + wob;
    // chimney smoke (6 puffs alive at most, drifting east with the wind; off in RM / when disabled)
    if (puffs && env.ambient && !env.reduced) {
      smokeAcc += dt;
      if (smokeAcc > 1.2) {
        smokeAcc = 0;
        chimney.set(-1.55, 5.75, -1.3);
        g.localToWorld(chimney);
        puffs.emit({ x: chimney.x, y: chimney.y, z: chimney.z, vx: 0.25 * env.wind, vy: 0.55, vz: 0.05, life: 5.5, size: 0.38, grow: 1.5, color: 0xf2efea });
      }
    }
    return false;
  };
  return lm;
}

// ------------------------------------------------------------------ silo (4.5, −14) r 1.4 h 7

function buildSilo() {
  const g = place(new Group(), 'silo');
  const k = kit();
  const R = 1.4;
  k.add(flat(cyl(R + 0.18, R + 0.25, 0.35, 12)), PAL.stone, {});
  const body = flat(cyl(R, R, 6.2, 12));
  paint(body, (x, y, z) => mixHex(0xc3ccd1, 0xaeb8be, (Math.floor((Math.atan2(z, x) + Math.PI) / (TAU / 12)) % 2) * 0.5));
  k.add(body, null, { p: [0, 0.35, 0] });
  for (let i = 0; i < 6; i++) k.add(flat(cyl(R + 0.035, R + 0.035, 0.09, 12)), 0x8e99a1, { p: [0, 0.9 + i * 1.08, 0] });
  // dome roof + vent
  const dome = lathe([[R + 0.12, 0], [R + 0.08, 0.25], [R * 0.85, 0.75], [R * 0.45, 1.12], [0.18, 1.25], [0, 1.27]], 12, { flat: true });
  paint(dome, (x, y) => mixHex(PAL.roofDk, PAL.roof, clamp(y / 1.2, 0, 1)));
  k.add(dome, null, { p: [0, 6.55, 0] });
  k.add(cyl(0.16, 0.2, 0.3, 6), PAL.metalDk, { p: [0, 7.8, 0] });
  k.add(cone(0.3, 0.2, 6), PAL.roofDk, { p: [0, 8.1, 0] });
  // ladder on the west side
  for (const dz of [-0.22, 0.22]) k.add(box(0.06, 6.3, 0.06), PAL.metalDk, { p: [-R - 0.14, 0.35, dz] });
  for (let i = 0; i < 16; i++) k.add(box(0.05, 0.04, 0.5), PAL.metalDk, { p: [-R - 0.14, 0.6 + i * 0.38, 0] });
  // sight window frame (front, +Z) and the painted white START line at fill 0.5 (§2.4)
  const W0 = 0.85;
  const W1 = 6.2;
  k.add(box(0.72, W1 - W0 + 0.16, 0.06), PAL.trim, { p: [0, W0 - 0.08, R - 0.02] });
  k.add(box(0.56, W1 - W0, 0.06), 0x4a4f55, { p: [0, W0, R + 0.01] });
  g.add(staticMesh(k, 'siloStatic'));

  const fillGeo = box(0.5, 1, 0.05, null, {});
  paint(fillGeo, (x, y) => mixHex(0xd9b45a, PAL.straw, y));
  const fill = dynMesh(fillGeo, 'siloFill', { shadow: false });
  fill.position.set(0, W0, R + 0.045);
  g.add(fill);
  // the start line: a full white ring + a bar across the window, in front of the grain
  const startY = W0 + 0.5 * (W1 - W0);
  const lk = kit();
  lk.add(flat(cyl(R + 0.05, R + 0.05, 0.1, 12)), 0xffffff, { p: [0, startY - 0.05, 0] });
  lk.add(box(0.78, 0.1, 0.05), 0xffffff, { p: [0, startY - 0.05, R + 0.09] });
  lk.add(prism([[0, 0], [0.16, 0.09], [0, 0.18]], 0.04), 0xffffff, { p: [0.42, startY - 0.09, R + 0.08] });
  g.add(staticMesh(lk, 'siloStartLine', { ao: false, shadow: false }));
  const level = new Tween(0.5);
  const write = () => {
    const h = Math.max(0.001, level.v * (W1 - W0));
    fill.scale.set(1, h, 1);
    fill.visible = level.v > 0.002;
  };
  write();
  // the fill label sits low on the drum: at the gauge's mid height it hid under the desktop HUD row (QA-01)
  const lm = record('silo', g, proxyFor('silo'), anchorAt(0, Math.min(startY, 2.3), R + 0.2));
  lm.blob = { x: LANDMARKS.silo.x, z: LANDMARKS.silo.z, r: 2.0 };
  lm.setLevel = (v, reduced) => level.set(clamp01(v), reduced ? 0 : 0.6, EASE.iOS);
  lm.update = (dt) => {
    const b = level.step(dt);
    write();
    return b;
  };
  return lm;
}

// ------------------------------------------------------------------ crates (−4.5, −10.5)

function crateGeometry() {
  const k = kit();
  for (const [x, z, w, d] of [[0, 0.42, 0.9, 0.06], [0, -0.42, 0.9, 0.06], [0.42, 0, 0.06, 0.9], [-0.42, 0, 0.06, 0.9]]) {
    for (let i = 0; i < 3; i++) k.add(box(w, 0.18, d), plankTone(PAL.woodLt, i + x * 9 + z * 5), { p: [x, 0.04 + i * 0.22, z] });
  }
  for (const [x, z] of [[0.41, 0.41], [-0.41, 0.41], [0.41, -0.41], [-0.41, -0.41]]) k.add(box(0.09, 0.7, 0.09), PAL.woodMid, { p: [x, 0, z] });
  k.add(box(0.82, 0.05, 0.82), PAL.woodDk, { p: [0, 0.04, 0] });
  // a heap of golden produce on top (neutral colours, never money green/red)
  const r = rng(12);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU;
    const rr = i === 0 ? 0 : 0.24;
    k.add(lowpolySphere(0.15, 0, { jitter: 0.08, seed: i }), i % 3 === 0 ? 0xf2b23a : i % 3 === 1 ? 0xf39a2e : 0xf7c95a, { p: [Math.cos(a) * rr + (r() - 0.5) * 0.05, 0.62 + (i === 0 ? 0.08 : 0), Math.sin(a) * rr] });
  }
  return k.build({ ao: true, aoMin: 0.8, aoTop: 0.7 });
}

function buildCrates() {
  const g = place(new Group(), 'crates');
  const k = kit();
  for (let i = 0; i < 5; i++) k.add(box(2.2, 0.06, 0.32), plankTone(PAL.woodMid, i), { p: [0, 0.12, -0.8 + i * 0.4] });
  for (const x of [-0.95, 0, 0.95]) k.add(box(0.14, 0.12, 2.0), PAL.woodDk, { p: [x, 0, 0] });
  g.add(staticMesh(k, 'cratesPallet'));
  const geo = crateGeometry();
  const mesh = new InstancedMesh(geo, toonVC(), 8);
  mesh.name = 'crates';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.count = 0;
  g.add(mesh);
  const pops = Array.from({ length: 8 }, () => new Tween(0));
  const o = new Object3D();
  const m4 = new Matrix4();
  let shown = 0;
  const write = () => {
    const L = crateLayout(8);
    let n = 0;
    for (let i = 0; i < 8; i++) {
      const s = pops[i].v;
      if (s <= 0.001) continue;
      const p = L[i];
      o.position.set(p.x, 0.18 + p.y, p.z);
      o.rotation.set(0, (hash2(i, 3) - 0.5) * 0.3, 0);
      o.scale.setScalar(s);
      o.updateMatrix();
      mesh.setMatrixAt(n++, m4.copy(o.matrix));
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  };
  const lm = record('crates', g, proxyFor('crates'), anchorAt(0, 2.75, 0));
  lm.blob = { x: LANDMARKS.crates.x, z: LANDMARKS.crates.z, r: 1.6 };
  const popT = Array(8).fill(1);
  lm.setCount = (n, reduced) => {
    const c = Math.max(0, Math.min(8, Math.floor(Number(n) || 0)));
    for (let i = 0; i < 8; i++) {
      if (i < c && i >= shown) {
        // new crate pops in (0 → 1.1 → 1, 400 ms, staggered)
        if (reduced) pops[i].set(1, 0);
        else popT[i] = -(i - shown) * 0.08;
      } else if (i >= c) {
        pops[i].set(0, 0);
        popT[i] = 1;
      }
    }
    shown = c;
  };
  let bumpT = Infinity;
  lm.setState = (s = {}) => {
    if (s.bump) bumpT = 0; // a coin landed (WP4 executor): the stack gives a little hop
  };
  lm.update = (dt, env) => {
    let busy = false;
    if (bumpT < 0.3 && !env.reduced) {
      bumpT += dt;
      mesh.position.y = Math.sin((bumpT / 0.3) * Math.PI) * 0.06;
      busy = true;
    } else mesh.position.y = 0;
    for (let i = 0; i < 8; i++) {
      if (popT[i] < 1) {
        popT[i] += dt / 0.4;
        pops[i].v = popT[i] <= 0 ? 0 : popScale(popT[i]);
        if (popT[i] >= 1) pops[i].v = 1;
        busy = true;
      }
    }
    write();
    return busy;
  };
  return lm;
}

// ------------------------------------------------------------------ compost heap (5.5, −10.5)

function buildCompost() {
  const g = place(new Group(), 'compost');
  const k = kit();
  // three slatted walls (back, left, right), open toward the field
  for (let i = 0; i < 4; i++) {
    const y = 0.08 + i * 0.25;
    k.add(box(2.3, 0.17, 0.08), plankTone(PAL.woodMid, i), { p: [0, y, -0.9] });
    for (const sx of [-1, 1]) k.add(box(0.08, 0.17, 1.8), plankTone(PAL.woodMid, i + sx * 4), { p: [sx * 1.12, y, 0] });
  }
  for (const [x, z] of [[-1.15, -0.92], [1.15, -0.92], [-1.15, 0.9], [1.15, 0.9]]) k.add(box(0.13, 1.15, 0.13), PAL.woodDk, { p: [x, 0, z] });
  // pitchfork leaning on the front-right post
  k.add(box(0.05, 1.5, 0.05), PAL.woodLt, { p: [1.42, 0.05, 0.98], r: [0.1, 0, -0.22] });
  for (const dx of [-0.08, 0, 0.08]) k.add(box(0.02, 0.32, 0.02), PAL.metalDk, { p: [1.12 + dx, 1.42, 1.13], r: [0.1, 0, -0.22] });
  g.add(staticMesh(k, 'compostBin'));
  // heap: lumpy, brown with straw flecks (no green: green means money)
  const heapGeo = lowpolySphere(1.0, 1, { jitter: 0.32, seed: 7 });
  const p = heapGeo.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) < 0) p.setY(i, p.getY(i) * 0.08);
  heapGeo.computeVertexNormals();
  paint(heapGeo, (x, y, z) => {
    const h = hash2(x * 5.1 + y, z * 4.3);
    return h > 0.86 ? PAL.strawDk : h > 0.5 ? 0x6b4a32 : h > 0.2 ? 0x5a3e2b : 0x7a5a3c;
  });
  const heap = dynMesh(heapGeo, 'compostHeap');
  heap.position.set(0, 0.02, 0.0);
  heap.scale.set(0.95, compostScale(0), 0.8);
  g.add(heap);
  const level = new Tween(compostScale(0));
  // the label sits on the heap, inside the (low) pick proxy: the silo behind stays tappable above it (QA-01)
  const lm = record('compost', g, proxyFor('compost'), anchorAt(0.3, 1.2, 0.6));
  lm.blob = { x: LANDMARKS.compost.x, z: LANDMARKS.compost.z, r: 1.7 };
  lm.setCount = (n, reduced) => level.set(compostScale(n), reduced ? 0 : 0.6, EASE.oB);
  let bumpT = Infinity;
  lm.setState = (s = {}) => {
    if (s.bump) bumpT = 0; // a bundle landed (WP4 executor): the heap squashes a little
  };
  lm.update = (dt, env) => {
    let b = level.step(dt);
    let squash = 1;
    if (bumpT < 0.35 && !env.reduced) {
      bumpT += dt;
      squash = 1 - 0.12 * Math.sin((bumpT / 0.35) * Math.PI);
      b = true;
    }
    heap.scale.y = level.v * squash;
    return b;
  };
  return lm;
}

// ------------------------------------------------------------------ water tower (13, −8)

function buildTower() {
  const g = place(new Group(), 'tower');
  const k = kit();
  const legs = [[-1.25, -1.25], [1.25, -1.25], [-1.25, 1.25], [1.25, 1.25]];
  for (const [x, z] of legs) {
    const top = [x * 0.84, 5.0, z * 0.84];
    const bot = [x, 0, z];
    const len = Math.hypot(top[0] - bot[0], 5, top[2] - bot[2]);
    const leg = box(0.24, len, 0.24, PAL.woodMid);
    const tilt = Math.atan2(Math.hypot(top[0] - bot[0], top[2] - bot[2]), 5);
    const yaw = Math.atan2(x, z);
    xf(leg, { r: [tilt, 0, 0] });
    xf(leg, { r: [0, yaw + Math.PI, 0] });
    k.add(leg, null, { p: [x, 0, z] });
    k.add(box(0.36, 0.2, 0.36), PAL.stone, { p: [x, 0, z] });
  }
  // X braces on each side + a ring beam
  const sideBrace = (ax, az, bx, bz) => {
    for (const [y0, y1] of [[0.5, 2.6], [2.6, 4.7]]) {
      const s0 = 1 - (y0 / 5) * 0.16;
      const s1 = 1 - (y1 / 5) * 0.16;
      const A = [ax * s0, y0, az * s0];
      const B = [bx * s1, y1, bz * s1];
      const C = [bx * s0, y0, bz * s0];
      const Dd = [ax * s1, y1, az * s1];
      k.add(tubeAlong([A, B], 0.055, 4), PAL.woodDk);
      k.add(tubeAlong([C, Dd], 0.055, 4), PAL.woodDk);
    }
  };
  sideBrace(-1.25, 1.25, 1.25, 1.25);
  sideBrace(1.25, 1.25, 1.25, -1.25);
  sideBrace(1.25, -1.25, -1.25, -1.25);
  sideBrace(-1.25, -1.25, -1.25, 1.25);
  // deck + rim boards
  k.add(box(3.1, 0.16, 3.1), PAL.woodLt, { p: [0, 4.95, 0] });
  for (const [x, z, w, d] of [[0, 1.52, 3.1, 0.08], [0, -1.52, 3.1, 0.08], [1.52, 0, 0.08, 3.1], [-1.52, 0, 0.08, 3.1]]) k.add(box(w, 0.28, d), PAL.woodMid, { p: [x, 5.0, z] });
  // barrel tank with hoops
  const tank = lathe([[1.68, 0], [1.8, 0.45], [1.86, 1.2], [1.82, 1.95], [1.7, 2.4]], 14, { flat: true });
  paint(tank, (x, y, z) => plankTone(PAL.wood, Math.floor((Math.atan2(z, x) + Math.PI) / (TAU / 14))));
  k.add(tank, null, { p: [0, 5.12, 0] });
  for (const [y, r] of [[5.45, 1.84], [6.3, 1.9], [7.15, 1.86]]) k.add(flat(cyl(r, r, 0.1, 14)), PAL.metalDk, { p: [0, y, 0] });
  const roof = flat(cone(2.08, 1.05, 14));
  paint(roof, (x, y) => mixHex(PAL.roofDk, PAL.roof, clamp(y / 1.05, 0, 1)));
  k.add(roof, null, { p: [0, 7.5, 0] });
  k.add(lowpolySphere(0.13, 0, {}), PAL.metalDk, { p: [0, 8.6, 0] });
  // ladder on the front-left leg
  for (const dx of [-0.2, 0.2]) k.add(box(0.06, 5.1, 0.06), PAL.woodDk, { p: [-0.75 + dx, 0, 1.55] });
  for (let i = 0; i < 12; i++) k.add(box(0.46, 0.05, 0.05), PAL.woodDk, { p: [-0.75, 0.35 + i * 0.4, 1.55] });
  // riser pipe (inlet + outlet share it) and the valve on it
  k.add(cyl(0.11, 0.11, 5.05, 8), 0xb9824f, { p: [0, 0.05, 0] });
  k.add(flat(cyl(0.2, 0.2, 0.12, 8)), 0x8c5a35, { p: [0, 1.15, 0] });
  k.add(tubeAlong(Array.from({ length: 9 }, (_, i) => [Math.cos((i / 8) * TAU) * 0.26, 1.38, 0.18 + Math.sin((i / 8) * TAU) * 0.26]), 0.035, 4, { caps: false }), PAL.metalDk);
  k.add(box(0.04, 0.04, 0.24), PAL.metalDk, { p: [0, 1.38, 0.06] });
  // sight-glass brackets on the tank front
  for (const y of [5.25, 7.35]) k.add(box(0.1, 0.07, 0.36), PAL.metalDk, { p: [0, y, 1.92] });
  k.add(flat(cyl(0.11, 0.11, 2.15, 8)), 0xd8eef4, { p: [0, 5.25, 2.08] });
  g.add(staticMesh(k, 'towerStatic'));

  // water level in the sight glass (§2.4: deployed / account value)
  const lvlGeo = flat(cyl(0.125, 0.125, 1, 8));
  paint(lvlGeo, PAL.waterDeep);
  const lvl = dynMesh(lvlGeo, 'towerLevel', { shadow: false, mat: propMaterial({ vertexColors: true, toon: true, emissive: 0x2f7f9a, emissiveIntensity: 0.25 }) });
  lvl.position.set(0, 5.27, 2.08);
  g.add(lvl);
  const level = new Tween(0);
  // red "cap" tag on the valve (§1.5 / §4.1 bot_order skipped): hidden until it pulses
  const tagGeo = merge([box(0.24, 0.32, 0.03, PAL.capTag, { p: [0, -0.34, 0] }), box(0.015, 0.2, 0.015, PAL.cream, { p: [0, -0.08, 0] })], { dispose: true });
  const tag = dynMesh(tagGeo, 'capTag', { shadow: false });
  tag.position.set(0.12, 1.42, 0.44);
  tag.visible = false;
  g.add(tag);
  let tagT = Infinity;
  const write = () => {
    lvl.scale.set(1, Math.max(0.001, level.v * 2.1), 1);
    lvl.visible = level.v > 0.003;
  };
  write();
  const lm = record('tower', g, proxyFor('tower'), anchorAt(0, 6.3, 2.2));
  lm.blob = { x: LANDMARKS.tower.x, z: LANDMARKS.tower.z, r: 2.4 };
  lm.setLevel = (v, reduced) => level.set(clamp01(v), reduced ? 0 : 0.6, EASE.iOS);
  lm.setState = (s = {}) => {
    if (s.capTag) tagT = 0;
    if (s.capTag === false) tagT = Infinity;
  };
  lm.update = (dt, env) => {
    let busy = level.step(dt);
    write();
    if (tagT < 8) {
      tagT += dt;
      tag.visible = true;
      // pulses twice (2 × 300 ms), then hangs still until it fades away after ~8 s
      const pulse = env.reduced ? 1 : tagT < 0.6 ? 1 + 0.35 * Math.abs(Math.sin((tagT / 0.3) * Math.PI)) : 1;
      tag.scale.setScalar(pulse);
      tag.rotation.z = env.reduced ? 0 : Math.sin(env.time * 2.2) * 0.12;
      busy = true;
    } else tag.visible = false;
    return busy;
  };
  return lm;
}

// ------------------------------------------------------------------ pond + pump (15, 3), pump (13, 0.5)

const WATER_VERT = /* glsl */ `
varying vec2 vW;
`;
const WATER_FRAG_DECL = /* glsl */ `
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uFoam;
varying vec2 vW;
`;
const WATER_FRAG = /* glsl */ `
#include <color_fragment>
{
  float r = length( vW );
  vec3 c = mix( uDeep, uShallow, smoothstep( 0.15, 0.95, r ) );
  float rip = sin( r * 26.0 - uTime * 1.3 + sin( vW.x * 7.0 + uTime * 0.5 ) * 0.8 );
  c += vec3( 0.035 ) * smoothstep( 0.6, 1.0, rip ) * ( 1.0 - r );
  float foam = smoothstep( 0.86, 0.985, r + 0.025 * sin( atan( vW.y, vW.x ) * 9.0 + uTime * 0.8 ) );
  c = mix( c, uFoam, foam * 0.85 );
  float gl = sin( vW.x * 47.0 + uTime * 1.7 ) * sin( vW.y * 41.0 - uTime * 1.1 );
  c += vec3( 0.5 ) * step( 0.993, gl ) * ( 1.0 - foam );
  diffuseColor.rgb = c;
}
`;

function buildPond() {
  const L = LANDMARKS.pond;
  const g = new Group();
  g.position.set(L.x, 0, L.z);
  g.name = 'lm:pond';
  // water disc (unit circle scaled to the shore radius at the current level)
  const uniforms = { uTime: sharedUniforms.uTime, uDeep: { value: new Color(PAL.waterDeep) }, uShallow: { value: new Color(PAL.water) }, uFoam: { value: new Color(PAL.waterFoam) } };
  const wMat = new MeshLambertMaterial({ color: 0xffffff, emissive: 0x1d5566, emissiveIntensity: 0.35 });
  wMat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader.replace('#include <common>', `#include <common>\n${WATER_VERT}`).replace('#include <begin_vertex>', '#include <begin_vertex>\nvW = position.xz;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>\n${WATER_FRAG_DECL}`).replace('#include <color_fragment>', WATER_FRAG);
  };
  wMat.customProgramCacheKey = () => 'bean-water-v1';
  const disc = new CircleGeometry(1, 48);
  disc.rotateX(-Math.PI / 2);
  // the disc now lies in XZ with a unit radius: the shader reads vW = position.xz
  const water = new Mesh(disc, wMat);
  water.name = 'pondWater';
  water.receiveShadow = true;
  g.add(water);
  // lily pads ride on the water
  const pads = new Group();
  const pk = kit();
  const r = rng(55);
  for (let i = 0; i < 6; i++) {
    const a = r() * TAU;
    const d = 0.6 + r() * 1.6;
    const pad = flat(cyl(0.26 + r() * 0.12, 0.26, 0.03, 9, null, {}, {}));
    paint(pad, mixHex(0x7db55a, 0x6aa65e, r()));
    pk.add(pad, null, { p: [Math.cos(a) * d, 0, Math.sin(a) * d], r: [0, r() * TAU, 0] });
    if (i % 2 === 0) pk.add(lowpolySphere(0.09, 0, {}), i % 4 ? PAL.cream : PAL.blossom, { p: [Math.cos(a) * d + 0.05, 0.07, Math.sin(a) * d], s: [1, 0.7, 1] });
  }
  pads.add(dynMesh(pk.build(), 'lilyPads', { shadow: false }));
  g.add(pads);

  // pump on a little platform at (13, 0.5): local offset from the pond centre
  const pump = new Group();
  pump.position.set(L.pumpX - L.x, heightAt(L.pumpX, L.pumpZ), L.pumpZ - L.z);
  pump.rotation.y = -0.9;
  const k = kit();
  k.add(box(1.3, 0.16, 1.2), PAL.woodLt, {});
  for (let i = 0; i < 4; i++) k.add(box(1.3, 0.02, 0.03), PAL.woodDk, { p: [0, 0.16, -0.45 + i * 0.3] });
  k.add(flat(cyl(0.17, 0.22, 1.05, 8)), 0x5d6b73, { p: [0, 0.16, 0] });
  k.add(flat(cyl(0.21, 0.21, 0.14, 8)), 0x4a565d, { p: [0, 1.18, 0] });
  k.add(tubeAlong([[0, 0.95, 0], [0, 0.95, 0.45], [0, 0.72, 0.6]], 0.06, 6), 0x4a565d);
  k.add(box(0.07, 0.07, 0.9, null, { p: [0, 0, -0.45] }), PAL.metalDk, { p: [0, 1.32, 0.1], r: [-0.35, 0, 0] });
  k.add(flat(cyl(0.08, 0.08, 0.5, 6, null, { r: [0, 0, Math.PI / 2] }, { centered: true })), PAL.metalDk, { p: [0.3, 0.62, 0] });
  // bucket
  k.add(flat(cyl(0.2, 0.16, 0.32, 8)), 0xb5bcc2, { p: [-0.4, 0.16, 0.35] });
  pump.add(staticMesh(k, 'pumpStatic'));
  const wheelGeo = kit();
  wheelGeo.add(tubeAlong(Array.from({ length: 13 }, (_, i) => [0, Math.cos((i / 12) * TAU) * 0.42, Math.sin((i / 12) * TAU) * 0.42]), 0.04, 4, { caps: false }), PAL.woodDk);
  for (let i = 0; i < 6; i++) wheelGeo.add(box(0.03, 0.82, 0.05, null, { p: [0, -0.41, 0] }, {}), PAL.woodMid, { r: [(i / 6) * Math.PI, 0, 0] });
  wheelGeo.add(flat(cyl(0.08, 0.08, 0.1, 6, null, { r: [0, 0, Math.PI / 2] }, { centered: true })), PAL.metalDk);
  const wheel = dynMesh(wheelGeo.build(), 'pumpWheel', { shadow: false });
  wheel.position.set(0.58, 0.62, 0);
  pump.add(wheel);
  g.add(pump);

  const level = new Tween(0.6);
  const write = () => {
    const y = pondWaterY(level.v);
    const rad = pondShoreRadius(y) + 0.08;
    water.position.y = y;
    water.scale.set(rad, 1, rad);
    pads.position.y = y + 0.012;
    pads.scale.setScalar(Math.max(0.35, rad / 3.0));
  };
  write();
  const lm = record('pond', g, proxyFor('pond'), anchorAt(0, 0.9, 0));
  lm.blob = null;
  lm.setLevel = (v, reduced, dur = 0.6) => level.set(clamp01(v), reduced ? 0 : dur, EASE.iOS);
  let spin = 0;
  lm.pumpFor = (sec) => {
    spin = Math.max(spin, sec);
  };
  lm.setState = (s = {}) => {
    if (s.pump) lm.pumpFor(1.2); // the `water` effect: the pump turns while the levels move
  };
  lm.update = (dt, env) => {
    let busy = level.step(dt);
    write();
    if (spin > 0) {
      spin -= dt;
      wheel.rotation.x -= dt * (env.reduced ? 0 : 6);
      busy = true;
    }
    return busy;
  };
  return lm;
}

// ------------------------------------------------------------------ windmill (−12, −11): the bar clock

const DIAL_DECL = /* glsl */ `
uniform float uProgress;
uniform vec3 uFace;
uniform vec3 uFill;
uniform vec3 uInk;
varying vec2 vDial;
`;
const DIAL_FRAG = /* glsl */ `
#include <color_fragment>
{
  vec2 p = vDial;
  float r = length( p ) / 0.5;
  float a = atan( p.x, p.y );
  float f = fract( a / 6.2831853 + 1.0 );
  vec3 c = uFace;
  if ( r < 0.8 && f < uProgress ) c = uFill;
  float tick = step( fract( f * 12.0 + 0.04 ), 0.08 ) * step( 0.8, r ) * step( r, 0.93 );
  c = mix( c, uInk, tick );
  // the hand
  vec2 dir = vec2( sin( uProgress * 6.2831853 ), cos( uProgress * 6.2831853 ) );
  float along = dot( p, dir );
  float off = abs( p.x * dir.y - p.y * dir.x );
  c = mix( c, uInk, step( off, 0.022 ) * step( 0.0, along ) * step( along, 0.4 ) );
  c = mix( c, uInk, step( r, 0.09 ) );
  c = mix( c, uInk * 1.4, step( 0.93, r ) );
  diffuseColor.rgb = c;
}
`;

function buildWindmill() {
  const g = place(new Group(), 'windmill');
  const k = kit();
  k.add(flat(cyl(2.3, 2.45, 0.5, 8)), PAL.stone, {});
  const tower = lathe([[2.0, 0.5], [1.86, 2.0], [1.58, 4.8], [1.38, 6.45]], 8, { flat: true, phiStart: -Math.PI / 8 });
  paint(tower, (x, y) => mixHex(PAL.plaster, 0xe8dcc6, clamp((6.4 - y) / 6, 0, 1) * 0.5));
  k.add(tower);
  for (const [y, rr] of [[2.0, 1.9], [4.8, 1.62]]) k.add(flat(cyl(rr + 0.06, rr + 0.06, 0.12, 8, null, { r: [0, Math.PI / 8, 0] })), PAL.woodDk, { p: [0, y - 0.06, 0] });
  // stage (gallery) with railing posts
  k.add(flat(cyl(2.55, 2.55, 0.12, 8, null, { r: [0, Math.PI / 8, 0] })), PAL.woodLt, { p: [0, 2.0, 0] });
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    k.add(box(0.06, 0.55, 0.06), PAL.woodDk, { p: [Math.sin(a) * 2.45, 2.1, Math.cos(a) * 2.45] });
  }
  k.add(tubeAlong(Array.from({ length: 17 }, (_, i) => [Math.sin((i / 16) * TAU) * 2.45, 2.62, Math.cos((i / 16) * TAU) * 2.45]), 0.04, 4, { caps: false }), PAL.woodDk);
  // cap (boat dome), windshaft and hub
  const cap = lathe([[1.5, 0], [1.56, 0.4], [1.3, 1.05], [0.7, 1.5], [0, 1.62]], 10, { flat: true });
  paint(cap, (x, y) => mixHex(PAL.roofDk, PAL.roof, clamp(y / 1.6, 0, 1)));
  k.add(cap, null, { p: [0, 6.42, -0.1], s: [1, 1, 1.15] });
  k.add(cyl(0.22, 0.26, 0.9, 8, null, { r: [Math.PI / 2, 0, 0] }, { centered: true }), PAL.woodDk, { p: [0, 7.1, 1.35] });
  // door + windows
  k.add(box(0.95, 1.45, 0.12), PAL.woodDk, { p: [0, 0.5, 1.92] });
  k.add(cyl(0.475, 0.475, 0.12, 8, null, { r: [Math.PI / 2, 0, 0] }, { centered: true }), PAL.woodDk, { p: [0, 1.95, 1.92], s: [1, 1, 1] });
  k.add(box(0.06, 1.4, 0.04), PAL.woodMid, { p: [0, 0.52, 1.99] });
  for (const [y, x] of [[4.0, 0.0], [5.4, -0.4]]) {
    k.add(box(0.42, 0.52, 0.08), 0x3f4852, { p: [x, y, lerp(1.86, 1.58, (y - 2) / 2.8) - 0.02] });
    k.add(box(0.52, 0.06, 0.12), PAL.trim, { p: [x, y - 0.03, lerp(1.86, 1.58, (y - 2) / 2.8)] });
  }
  // dial plaque frame (the dial itself is a shader disc in front of it)
  k.add(flat(cyl(0.6, 0.6, 0.1, 12, null, { r: [Math.PI / 2, 0, 0] }, { centered: true })), PAL.woodDk, { p: [0, 3.2, 1.72] });
  g.add(staticMesh(k, 'windmillStatic'));

  // the bar-clock dial (pie timer): readable even when the sails spin with the wind
  const uProgress = { value: 0 };
  const dialMat = new MeshToonMaterial({ color: 0xffffff, gradientMap: toonGradient() });
  const dialU = { uProgress, uFace: { value: new Color(PAL.cream) }, uFill: { value: new Color(PAL.butter) }, uInk: { value: new Color(0x4a3a2c) } };
  dialMat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, dialU);
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vDial;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvDial = position.xy;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>\n${DIAL_DECL}`).replace('#include <color_fragment>', DIAL_FRAG);
  };
  dialMat.customProgramCacheKey = () => 'bean-dial-v1';
  const dial = new Mesh(new CircleGeometry(0.5, 32), dialMat);
  dial.position.set(0, 3.2, 1.78);
  dial.name = 'barDial';
  g.add(dial);

  // sails: 4 lattice arms with canvas, rotating about the windshaft (local +Z)
  const sk = kit();
  for (let i = 0; i < 4; i++) {
    const arm = kit();
    arm.add(box(0.16, 3.05, 0.12), PAL.woodDk, { p: [0, 0.15, 0] });
    for (const x of [0.16, 0.78]) arm.add(box(0.05, 2.55, 0.06), PAL.woodMid, { p: [x, 0.6, -0.02] });
    for (let j = 0; j < 7; j++) arm.add(box(0.72, 0.04, 0.05), PAL.woodMid, { p: [0.47, 0.62 + j * 0.4, -0.02] });
    const canvasGeo = box(0.56, 2.35, 0.025);
    paint(canvasGeo, (x, y) => mixHex(PAL.canvas, 0xe9dfca, (y / 2.35) * 0.5));
    arm.add(canvasGeo, null, { p: [0.47, 0.7, -0.06] });
    const armGeo = arm.build();
    xf(armGeo, { r: [0, 0, (i * Math.PI) / 2] });
    sk.add(armGeo);
  }
  sk.add(flat(cyl(0.3, 0.3, 0.3, 8, null, { r: [Math.PI / 2, 0, 0] }, { centered: true })), PAL.woodDk);
  const sailsGeo = sk.build();
  const sails = dynMesh(sailsGeo, 'sails');
  sails.material = propMaterial({ vertexColors: true, toon: true, side: 'double' });
  sails.position.set(0, 7.1, 1.86);
  g.add(sails);

  let spin = 0;
  let progress = 0;
  let pRate = 1 / 60; // progress per second (learned from setBarProgress calls)
  let pAt = 0;
  let pLast = null;
  let kickT = Infinity;
  let boostT = Infinity;
  let lapseT = Infinity;
  let clockTime = 0;
  const lm = record('windmill', g, proxyFor('windmill'), anchorAt(0, 3.2, 1.9));
  lm.blob = { x: LANDMARKS.windmill.x, z: LANDMARKS.windmill.z, r: 2.6 };
  lm.dial = uProgress;
  lm.setProgress = (p) => {
    const v = clamp01(p);
    if (pLast != null && v > pLast && clockTime > pAt) pRate = clamp((v - pLast) / (clockTime - pAt), 0, 1 / 5);
    pLast = v;
    pAt = clockTime;
    progress = v;
  };
  lm.kick = () => {
    kickT = 0;
  };
  lm.gust = () => {
    boostT = 0;
  };
  lm.timelapse = () => {
    lapseT = 0;
  };
  lm.setState = (s = {}) => {
    if (s.kick) lm.kick();
    if (s.gust) lm.gust();
    if (s.timelapse || s.spin) lm.timelapse();
  };
  lm.update = (dt, env) => {
    clockTime += dt;
    // displayed progress = last reported value extrapolated at the learned rate (smooth between reports)
    const shown = pLast == null ? 0 : clamp01(progress + pRate * (clockTime - pAt));
    uProgress.value = shown;
    let busy = false;
    if (env.reduced) {
      sails.rotation.z = -shown * TAU;
      return false;
    }
    let boost = 1;
    if (boostT < WINDMILL.gustMs / 1000) {
      boostT += dt;
      boost = WINDMILL.gustBoost;
      busy = true;
    }
    if (lapseT < 2) {
      lapseT += dt;
      boost = Math.max(boost, WINDMILL.timelapseRevPerSec / (WINDMILL.baseRevPerSec * Math.max(0.6, env.wind)));
      busy = true;
    }
    spin += windmillSpinStep(dt, env.wind, boost);
    if (spin > TAU * 1000) spin -= TAU * 1000;
    let kick = 0;
    if (kickT < WINDMILL.kickMs / 1000) {
      kickT += dt;
      kick = kickProfile(kickT / (WINDMILL.kickMs / 1000));
      busy = true;
    }
    // sails turn clockwise as seen from the front: angle = wind spin + bar progress + tick kick
    sails.rotation.z = -(spin + shown * TAU + kick);
    return busy || true;
  };
  return lm;
}

// ------------------------------------------------------------------ sundial (−8, −13.5): sim only

function buildSundial() {
  const g = place(new Group(), 'sundial');
  const k = kit();
  k.add(flat(cyl(0.55, 0.6, 0.14, 8)), PAL.stoneDk, {});
  k.add(flat(cyl(0.3, 0.36, 0.78, 8)), PAL.stone, { p: [0, 0.14, 0] });
  k.add(flat(cyl(0.42, 0.34, 0.1, 8)), PAL.stoneDk, { p: [0, 0.9, 0] });
  k.add(flat(cyl(0.6, 0.6, 0.07, 16)), 0xc49a5c, { p: [0, 1.0, 0] });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    k.add(box(0.04, 0.02, i % 3 === 0 ? 0.14 : 0.08), 0x6b4f33, { p: [Math.sin(a) * 0.48, 1.07, Math.cos(a) * 0.48], r: [0, a, 0] });
  }
  // gnomon (triangle) pointing north
  k.add(prism([[0, 0], [0.5, 0], [0, 0.34]], 0.04), 0x9c7343, { p: [0, 1.07, 0], r: [0, Math.PI / 2, 0] });
  g.add(staticMesh(k, 'sundialStatic'));
  const shadowGeo = prism([[-0.035, 0], [0.035, 0], [0.012, 0.46], [-0.012, 0.46]], 0.012);
  xf(shadowGeo, { r: [-Math.PI / 2, 0, 0] });
  paint(shadowGeo, 0x5a4636);
  const shadow = dynMesh(shadowGeo, 'sundialShadow', { shadow: false });
  shadow.position.set(0, 1.075, 0);
  g.add(shadow);
  let hour = 10.5;
  let lapseT = Infinity;
  const lm = record('sundial', g, proxyFor('sundial'), anchorAt(0, 1.55, 0));
  lm.blob = { x: LANDMARKS.sundial.x, z: LANDMARKS.sundial.z, r: 0.8 };
  lm.setHour = (h) => {
    if (Number.isFinite(Number(h))) hour = Number(h);
  };
  lm.timelapse = () => {
    lapseT = 0;
  };
  lm.setState = (s = {}) => {
    if (s.sweep || s.timelapse) {
      lm.timelapse();
      lm.onSweep?.();
    }
    if (s.hour != null) lm.setHour(s.hour);
  };
  lm.setVisible = (v) => {
    g.visible = !!v;
    if (v) lm.proxy.layers.set(1);
    else lm.proxy.layers.disable(1);
  };
  lm.update = (dt, env) => {
    let extra = 0;
    let busy = false;
    if (lapseT < 2 && !env.reduced) {
      lapseT += dt;
      extra = EASE.iOC(lapseT / 2) * TAU; // the shadow sweeps 360° in 2 s
      busy = true;
    }
    // the shadow falls opposite the sun: morning → west, noon → north, evening → east
    shadow.rotation.y = Math.PI - ((hour - 12) / 12) * Math.PI - extra;
    return busy;
  };
  return lm;
}

// ------------------------------------------------------------------ market board (−15, 8) faces NE

function buildBoard() {
  const g = place(new Group(), 'board');
  const k = kit();
  for (const x of [-1.42, 1.42]) k.add(box(0.17, 2.75, 0.17), PAL.woodDk, { p: [x, 0, 0] });
  k.add(prism([[-1.75, 0], [1.75, 0], [1.4, 0.45], [-1.4, 0.45]], 0.7), PAL.roof, { p: [0, 2.68, 0] });
  k.add(box(3.6, 0.1, 0.8), PAL.roofDk, { p: [0, 2.62, 0] });
  k.add(box(2.7, 0.06, 0.24), PAL.woodLt, { p: [0, 0.7, 0.1] });
  for (let i = 0; i < 3; i++) k.add(box(0.12, 0.04, 0.04), [0xffffff, PAL.butter, PAL.lavender][i], { p: [-0.8 + i * 0.3, 0.76, 0.16], r: [0, 0.2 * i, 0] });
  k.add(box(0.5, 0.36, 0.4), PAL.woodMid, { p: [1.05, 0, 0.55] });
  g.add(staticMesh(k, 'boardStatic'));
  // the flipping slate panel (blank: the DOM shows the prices)
  const pk = kit();
  pk.add(box(2.6, 1.55, 0.1, null, {}, { centered: true }), PAL.woodLt);
  pk.add(box(2.4, 1.35, 0.12, null, {}, { centered: true }), 0x3e4b48);
  for (let i = 0; i < 4; i++) pk.add(box(0.6 + hash2(i, 9) * 1.1, 0.035, 0.13, null, {}, { centered: true }), 0xb9c2bd, { p: [-0.4 + hash2(i, 4) * 0.2, 0.42 - i * 0.28, 0] });
  const panel = dynMesh(pk.build(), 'boardPanel');
  panel.position.set(0, 1.62, 0.02);
  g.add(panel);
  let flipT = Infinity;
  const lm = record('board', g, proxyFor('board'), anchorAt(0, 1.62, 0.12));
  lm.blob = { x: LANDMARKS.board.x, z: LANDMARKS.board.z, r: 1.6 };
  lm.setState = (s = {}) => {
    if (s.flip) flipT = 0;
  };
  lm.update = (dt, env) => {
    if (flipT < 0.6 && !env.reduced) {
      flipT += dt;
      panel.rotation.x = EASE.iOC(Math.min(1, flipT / 0.6)) * TAU;
      return true;
    }
    panel.rotation.x = 0;
    return false;
  };
  return lm;
}

// ------------------------------------------------------------------ mailbox (−7, 12): the diary

function buildMailbox() {
  const g = place(new Group(), 'mailbox');
  const k = kit();
  k.add(box(0.14, 1.08, 0.14), PAL.woodMid, {});
  k.add(box(0.5, 0.06, 0.82), PAL.woodDk, { p: [0, 1.05, 0] });
  k.add(box(0.46, 0.26, 0.78), PAL.teal, { p: [0, 1.11, 0] });
  k.add(cyl(0.23, 0.23, 0.78, 10, null, { r: [Math.PI / 2, 0, 0] }, { centered: true }), PAL.teal, { p: [0, 1.37, 0], s: [1, 0.85, 1] });
  k.add(box(0.44, 0.44, 0.04), mixHex(PAL.teal, 0x000000, 0.12), { p: [0, 1.11, 0.4] });
  k.add(lowpolySphere(0.035, 0, {}), PAL.butter, { p: [0, 1.32, 0.44] });
  // planter at the foot
  k.add(box(0.5, 0.26, 0.36), PAL.woodLt, { p: [0.05, 0, 0.3] });
  for (let i = 0; i < 4; i++) k.add(lowpolySphere(0.09, 0, { seed: i }), [PAL.lavender, PAL.butter, PAL.peach, 0xffffff][i], { p: [-0.12 + i * 0.1, 0.32, 0.3 + (i % 2) * 0.06] });
  g.add(staticMesh(k, 'mailboxStatic'));
  // the amber flag (warning colour): up = unread warnings
  const flagGeo = merge([box(0.04, 0.44, 0.04, PAL.metalDk, {}), box(0.03, 0.2, 0.26, PAL.warnAmber, { p: [0, 0.26, 0.12] })], { dispose: true });
  const flag = dynMesh(flagGeo, 'mailboxFlag', { shadow: false });
  flag.position.set(0.26, 1.15, -0.15);
  g.add(flag);
  const up = new Tween(0);
  let reduced = false;
  const lm = record('mailbox', g, proxyFor('mailbox'), anchorAt(0, 1.85, 0));
  lm.blob = { x: LANDMARKS.mailbox.x, z: LANDMARKS.mailbox.z, r: 0.7 };
  lm.setState = (s = {}) => {
    if ('unread' in s) up.set(Number(s.unread) > 0 ? 1 : 0, reduced ? 0 : 0.45, EASE.oB);
  };
  lm.update = (dt, env) => {
    reduced = env.reduced;
    const b = up.step(dt);
    // down: flag lies along the box (pointing back); up: vertical
    flag.rotation.x = lerp(-Math.PI / 2, 0, up.v);
    return b;
  };
  flag.rotation.x = -Math.PI / 2;
  return lm;
}

// ------------------------------------------------------------------ fire pit (8, 12.5) + torch

function buildFirepit(puffs) {
  const g = place(new Group(), 'firepit');
  const k = kit();
  const r = rng(8);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU;
    k.add(lowpolySphere(0.24 + r() * 0.06, 0, { jitter: 0.25, seed: i }), mixHex(PAL.stone, PAL.stoneDk, r()), { p: [Math.cos(a) * 0.82, 0.1, Math.sin(a) * 0.82], s: [1.15, 0.75, 1] });
  }
  k.add(flat(cyl(0.72, 0.72, 0.05, 10)), 0x3b3330, {});
  for (let i = 0; i < 4; i++) k.add(flat(cyl(0.08, 0.1, 0.95, 6, null, { r: [0, 0, Math.PI / 2.3] }, { centered: true })), PAL.bark, { p: [0, 0.22, 0], r: [0, (i / 4) * Math.PI, 0] });
  // log benches + a stump seat
  for (const [x, z, yaw] of [[-1.95, 0.55, 0.25], [1.85, 0.85, -0.35]]) {
    k.add(flat(cyl(0.22, 0.22, 1.5, 7, null, { r: [0, 0, Math.PI / 2] }, { centered: true })), PAL.bark, { p: [x, 0.22, z], r: [0, yaw + Math.PI / 2, 0] });
    k.add(box(1.3, 0.04, 0.3), PAL.woodLt, { p: [x, 0.42, z], r: [0, yaw + Math.PI / 2, 0] });
  }
  k.add(flat(cyl(0.3, 0.34, 0.42, 8)), PAL.bark, { p: [0.2, 0, -1.9] });
  k.add(flat(cyl(0.29, 0.29, 0.03, 8)), PAL.woodLt, { p: [0.2, 0.42, -1.9] });
  // torch on a pole (unlit until the burn)
  k.add(box(0.07, 1.55, 0.07), PAL.woodDk, { p: [1.35, 0, -0.75] });
  k.add(flat(cyl(0.1, 0.07, 0.24, 6)), PAL.strawDk, { p: [1.35, 1.52, -0.75] });
  g.add(staticMesh(k, 'firepitStatic'));
  // embers (always softly glowing) and flames (only while the field burns, or the torch)
  const emberMat = propMaterial({ basic: true, color: 0xff9a3c });
  const embers = new Mesh(merge([lowpolySphere(0.36, 0, { squash: [1, 0.25, 1] }), lowpolySphere(0.2, 0, { t: { p: [0.2, 0.05, -0.1] }, squash: [1, 0.3, 1] })], { dispose: true }), emberMat);
  embers.position.y = 0.08;
  g.add(embers);
  const flameGeo = merge([cone(0.3, 0.9, 6, PAL.ember), cone(0.18, 0.7, 5, PAL.flame, { p: [0.12, 0, 0.05] }), cone(0.16, 0.55, 5, PAL.flame, { p: [-0.12, 0, -0.05] })], { dispose: true });
  const flameMat = propMaterial({ basic: true, vertexColors: true });
  const flames = new Mesh(flameGeo, flameMat);
  flames.position.y = 0.12;
  flames.visible = false;
  g.add(flames);
  const torchFlame = new Mesh(merge([cone(0.12, 0.42, 5, PAL.ember), cone(0.07, 0.3, 5, PAL.flame, { p: [0, 0.02, 0.02] })], { dispose: true }), flameMat);
  torchFlame.position.set(1.35, 1.74, -0.75);
  torchFlame.visible = false;
  g.add(torchFlame);
  const fire = new Tween(0);
  const torch = new Tween(0);
  let smokeAcc = 0;
  const pos = new Vector3();
  const lm = record('firepit', g, proxyFor('firepit'), anchorAt(0, 1.45, 0));
  lm.blob = { x: LANDMARKS.firepit.x, z: LANDMARKS.firepit.z, r: 1.2 };
  let reduced = false;
  lm.setState = (s = {}) => {
    // `lit` (WP4 executor: burn start/end) lights both the torch and the fire
    const torchOn = 'torch' in s ? s.torch : 'lit' in s ? s.lit : undefined;
    const fireOn = 'burning' in s ? s.burning : 'lit' in s ? s.lit : undefined;
    if (torchOn !== undefined) torch.set(torchOn ? 1 : 0, reduced ? 0 : 0.4, EASE.oB);
    if (fireOn !== undefined) fire.set(fireOn ? 1 : 0, reduced ? 0 : 0.6, EASE.oC);
  };
  lm.update = (dt, env) => {
    reduced = env.reduced;
    let busy = fire.step(dt) | torch.step(dt);
    const t = env.time;
    const flick = env.reduced ? 1 : 0.85 + 0.15 * Math.sin(t * 13.1) * Math.sin(t * 7.3 + 1);
    embers.scale.set(1, 1, 1);
    emberMat.color.setRGB(1, 0.42 + 0.12 * flick, 0.12);
    flames.visible = fire.v > 0.01;
    flames.scale.set(fire.v * (0.9 + 0.1 * flick), fire.v * flick * 1.3, fire.v * (0.9 + 0.1 * flick));
    flames.rotation.y = env.reduced ? 0 : t * 1.7;
    torchFlame.visible = torch.v > 0.01;
    torchFlame.scale.setScalar(Math.max(0.001, torch.v * flick));
    // a thin smoke wisp from the embers (ambience)
    if (puffs && env.ambient && !env.reduced) {
      smokeAcc += dt;
      if (smokeAcc > (fire.v > 0.5 ? 0.25 : 2.2)) {
        smokeAcc = 0;
        pos.set(0, 0.5 + fire.v * 0.6, 0);
        g.localToWorld(pos);
        puffs.emit({ x: pos.x, y: pos.y, z: pos.z, vx: 0.2 * env.wind, vy: 0.5 + fire.v * 0.5, life: 3.5, size: 0.22 + fire.v * 0.2, grow: 1.4, color: fire.v > 0.5 ? 0x8f8780 : 0xd9d4ce });
      }
    }
    return busy || fire.v > 0.01;
  };
  return lm;
}

// ------------------------------------------------------------------ Pip the scarecrow (−12.5, −5)

function buildPip() {
  const g = place(new Group(), 'pip');
  const body = new Group(); // sways around the post base
  const k = kit();
  k.add(box(0.13, 2.45, 0.13), PAL.woodMid, {});
  k.add(box(2.0, 0.12, 0.12), PAL.woodMid, { p: [0, 1.72, 0] });
  // trousers with straw at the ankles
  for (const sx of [-1, 1]) {
    k.add(flat(cyl(0.12, 0.15, 0.62, 6)), 0x9a7a58, { p: [sx * 0.13, 0.42, 0.04], r: [0, 0, sx * 0.08] });
    k.add(flat(cone(0.13, 0.22, 6, null, { r: [Math.PI, 0, 0] })), PAL.straw, { p: [sx * 0.13, 0.44, 0.04] });
  }
  // shirt (lavender with a peach patch) and sleeves along the crossbar
  k.add(flat(cyl(0.36, 0.3, 0.9, 7)), PAL.lavender, { p: [0, 0.98, 0.03] });
  k.add(box(0.2, 0.2, 0.03), PAL.peach, { p: [0.12, 1.25, 0.34] });
  for (let i = 0; i < 3; i++) k.add(lowpolySphere(0.03, 0, {}), 0x6b5a7a, { p: [-0.05, 1.12 + i * 0.18, 0.34] });
  for (const sx of [-1, 1]) {
    k.add(flat(cyl(0.13, 0.16, 0.8, 6, null, { r: [0, 0, sx * Math.PI / 2] }, { centered: true })), PAL.lavender, { p: [sx * 0.62, 1.74, 0] });
    k.add(flat(cone(0.12, 0.24, 6, null, { r: [0, 0, -sx * Math.PI / 2] })), PAL.straw, { p: [sx * 1.0, 1.74, 0] });
  }
  k.add(flat(cone(0.2, 0.18, 7, null, { r: [Math.PI, 0, 0] })), PAL.straw, { p: [0, 1.95, 0.03] });
  // burlap head with button eyes, a stitched smile and a carrot nose
  k.add(lowpolySphere(0.3, 1, { jitter: 0.06, seed: 4 }), 0xe3cfa0, { p: [0, 2.2, 0.03] });
  for (const sx of [-1, 1]) k.add(lowpolySphere(0.045, 0, {}), 0x2d2620, { p: [sx * 0.1, 2.26, 0.3] });
  for (let i = 0; i < 5; i++) {
    const a = -0.6 + i * 0.3;
    k.add(box(0.05, 0.015, 0.02), 0x5a4636, { p: [Math.sin(a) * 0.12, 2.1 - Math.cos(a) * 0.03 + 0.03, 0.3], r: [0, 0, a * 0.6] });
  }
  k.add(cone(0.035, 0.14, 5, null, { r: [Math.PI / 2, 0, 0] }), PAL.peach, { p: [0, 2.18, 0.31] });
  // straw hat with a lavender band, tilted
  k.add(flat(cyl(0.5, 0.52, 0.05, 12)), PAL.straw, { p: [0, 2.42, 0.02], r: [0.08, 0, -0.1] });
  k.add(flat(cyl(0.24, 0.28, 0.3, 10)), PAL.straw, { p: [-0.02, 2.44, 0.02], r: [0.08, 0, -0.1] });
  k.add(flat(cyl(0.285, 0.285, 0.07, 10)), PAL.plum, { p: [-0.02, 2.47, 0.02], r: [0.08, 0, -0.1] });
  const mesh = staticMesh(k, 'pip');
  body.add(mesh);
  g.add(body);
  let hopT = Infinity;
  const lm = record('pip', g, proxyFor('pip'), anchorAt(0, 2.95, 0));
  lm.blob = { x: LANDMARKS.pip.x, z: LANDMARKS.pip.z, r: 0.9 };
  lm.setState = (s = {}) => {
    if (s.talk || s.hop) hopT = 0;
  };
  lm.update = (dt, env) => {
    const sway = env.reduced ? 0 : Math.sin(env.time * 1.1) * 0.018 * env.wind + env.gustK * 0.05;
    body.rotation.z = sway;
    body.rotation.x = env.reduced ? 0 : Math.sin(env.time * 0.8 + 1) * 0.008 * env.wind;
    if (hopT < 0.6 && !env.reduced) {
      hopT += dt;
      body.position.y = Math.sin(Math.min(1, hopT / 0.6) * Math.PI * 2) ** 2 * 0.12;
      return true;
    }
    body.position.y = 0;
    return false;
  };
  return lm;
}

// ------------------------------------------------------------------ signpost (0, 15.5): the mode badge in the world

const FEED_TONES = Object.freeze({ real: 0x1d6b5a, live: 0x1d6b5a, sim: 0x6b4fa0, delayed: 0xf2c14e, down: 0x5f6368, offline: 0x5f6368 });

function buildSignpost() {
  const g = place(new Group(), 'signpost');
  const k = kit();
  for (const x of [-2.0, 2.0]) {
    k.add(box(0.2, 2.3, 0.2), PAL.woodDk, { p: [x, 0, 0] });
    k.add(cone(0.16, 0.18, 4, null, { r: [0, Math.PI / 4, 0] }), PAL.woodDk, { p: [x, 2.3, 0] });
  }
  k.add(box(0.06, 0.06, 0.4), PAL.metalDk, { p: [-2.0, 2.05, 0.2] });
  k.add(box(0.2, 0.26, 0.2), 0x3f4852, { p: [-2.0, 1.7, 0.38] });
  for (let i = 0; i < 3; i++) k.add(lowpolySphere(0.12, 0, { seed: i }), [PAL.butter, PAL.lavender, 0xffffff][i], { p: [-1.6 + i * 1.6, 0.1, 0.4], s: [1, 0.7, 1] });
  g.add(staticMesh(k, 'signpostStatic'));
  // the board (colour mirrors the mode badge; the words are DOM): flips when the feed look changes
  const boardMat = new MeshToonMaterial({ color: FEED_TONES.sim, gradientMap: toonGradient() });
  // SIM look: 45° stripes (§6.3 "violet with 45° stripes"), drawn in the shader from the local position
  const uStripes = { value: 1 };
  boardMat.onBeforeCompile = (sh) => {
    sh.uniforms.uStripes = uStripes;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSign;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSign = position.xy;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSign;\nuniform float uStripes;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 1.0 + 0.24 * uStripes * step( 0.5, fract( ( vSign.x + vSign.y ) * 2.4 ) );');
  };
  boardMat.customProgramCacheKey = () => 'bean-sign-v1';
  const frameK = kit();
  frameK.add(prism([[-2.25, -0.55], [2.05, -0.55], [2.35, 0], [2.05, 0.55], [-2.25, 0.55]], 0.16), PAL.woodLt);
  const board = new Group();
  board.position.set(0, 1.5, 0.12);
  const frame = dynMesh(frameK.build(), 'signFrame', { shadow: false });
  const face = new Mesh(prism([[-2.12, -0.44], [1.98, -0.44], [2.22, 0], [1.98, 0.44], [-2.12, 0.44]], 0.2), boardMat);
  face.castShadow = true;
  face.name = 'signFace';
  board.add(frame, face);
  g.add(board);
  const col = new Color();
  let look = 'sim';
  let flipT = Infinity;
  let pending = null;
  const lm = record('signpost', g, proxyFor('signpost'), anchorAt(0, 1.5, 0.32));
  lm.blob = { x: LANDMARKS.signpost.x, z: LANDMARKS.signpost.z, r: 1.6 };
  const applyLook = (s) => {
    look = s;
    boardMat.color.copy(col.set(FEED_TONES[s] ?? FEED_TONES.sim));
    uStripes.value = s === 'sim' ? 1 : 0;
  };
  applyLook('sim');
  let reduced = false;
  lm.setState = (s = {}) => {
    if (s.look && s.look !== look && s.look !== pending) {
      if (reduced) applyLook(s.look);
      else {
        pending = s.look;
        flipT = 0;
      }
    }
  };
  lm.update = (dt, env) => {
    reduced = env.reduced;
    if (flipT < 0.7) {
      flipT += dt;
      const k = EASE.iOC(Math.min(1, flipT / 0.7));
      board.rotation.y = k * TAU;
      if (pending && k >= 0.25) {
        applyLook(pending);
        pending = null;
      }
      return true;
    }
    board.rotation.y = 0;
    return false;
  };
  lm.getLook = () => look;
  return lm;
}

// ------------------------------------------------------------------ irrigation: pipes from the tower + drip spouts

function buildPipes() {
  const group = new Group();
  group.name = 'pipes';
  const copper = 0xb9824f;
  let mesh = null;
  let layout = null;
  // spouts: instanced (one per slot, shown for active plots)
  const spoutK = kit();
  spoutK.add(cyl(0.06, 0.06, PIPE.spoutY - PIPE.y + 0.06, 6), copper, { p: [0, -(PIPE.spoutY - PIPE.y), 0] });
  spoutK.add(tubeAlong([[0, 0, 0], [0, 0.08, 0.2], [0, 0.02, 0.42]], 0.05, 5), copper);
  spoutK.add(flat(cyl(0.11, 0.11, 0.04, 6, null, { r: [Math.PI / 2, 0, 0] }, { centered: true })), 0x6f7a83, { p: [0, 0.05, 0.08] });
  spoutK.add(box(0.2, 0.03, 0.04), 0x6f7a83, { p: [0, 0.16, 0.08] });
  const spoutGeo = spoutK.build();
  const spouts = new InstancedMesh(spoutGeo, toonVC(), 15);
  spouts.name = 'spouts';
  spouts.castShadow = false;
  spouts.count = 0;
  group.add(spouts);
  // drips (tiny water beads falling from active, unpaused spouts)
  const dripGeo = lowpolySphere(0.045, 0, {});
  paint(dripGeo, PAL.water);
  const drips = new InstancedMesh(dripGeo, propMaterial({ vertexColors: true, toon: true, emissive: 0x2f7f9a, emissiveIntensity: 0.4 }), 15);
  drips.name = 'drips';
  drips.count = 0;
  group.add(drips);
  // flow beads (water travelling along the pipe, §4.1 "a flowing dash runs along the pipe to the box")
  const beadGeo = flat(cyl(0.085, 0.085, 0.5, 6, null, { r: [Math.PI / 2, 0, 0] }, { centered: true }));
  paint(beadGeo, 0x9fe3f5);
  const beads = new InstancedMesh(beadGeo, propMaterial({ vertexColors: true, toon: true, emissive: 0x5fc3df, emissiveIntensity: 0.6 }), 24);
  beads.name = 'flowBeads';
  beads.count = 0;
  beads.frustumCulled = false;
  group.add(beads);

  const o = new Object3D();
  const m4 = new Matrix4();
  let active = {}; // slot → 'on' | 'paused'
  let spoutsOn = false; // WP4's plots draw the valve + drip on the rim; ours are an opt-in fallback
  const flows = [];

  function rebuild(count) {
    layout = pipeLayout(count);
    if (mesh) {
      mesh.geometry.dispose();
      mesh.removeFromParent();
    }
    const k = kit();
    const tube = (pts) => k.add(tubeAlong(pts, 0.075, 6, { caps: true }), copper);
    tube(layout.inlet);
    tube(layout.main);
    for (const row of layout.rows) tube(row);
    // joints + little wooden stakes holding the pipes up
    const stakes = [...layout.inlet, ...layout.main, ...layout.rows.flat()];
    for (const p of stakes) k.add(flat(cyl(0.11, 0.11, 0.16, 6, null, {}, { centered: true })), 0x8c5a35, { p: [p[0], p[1], p[2]], r: [0, 0, Math.PI / 2] });
    for (const line of [layout.main, ...layout.rows]) {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1];
        const b = line[i];
        const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
        for (let s = 1.2; s < L; s += 2.2) {
          const t = s / L;
          k.add(box(0.07, 0.24, 0.07), PAL.woodMid, { p: [lerp(a[0], b[0], t), 0, lerp(a[2], b[2], t)] });
        }
      }
    }
    // tees under every spout
    // tap-off tees with a short stub under every box's drip valve
    for (const s of layout.spouts) {
      k.add(flat(cyl(0.1, 0.1, 0.12, 6, null, { r: [Math.PI / 2, 0, 0] }, { centered: true })), 0x8c5a35, { p: [s.x, PIPE.y, s.pipeZ] });
      k.add(cyl(0.05, 0.05, 0.22, 6), copper, { p: [s.x, PIPE.y, s.pipeZ] });
    }
    mesh = staticMesh(k, 'pipeNet', { ao: false });
    mesh.castShadow = true;
    group.add(mesh);
    writeSpouts();
  }

  function writeSpouts() {
    let n = 0;
    for (const s of layout.spouts) {
      if (!spoutsOn || !active[s.slot]) continue;
      o.position.set(s.x, PIPE.spoutY, s.pipeZ);
      // the spout reaches from the pipe over the back rim into the box (toward +z)
      o.rotation.set(0, 0, 0);
      o.scale.set(1, 1, Math.max(0.5, (s.z - s.pipeZ) / 0.42));
      o.updateMatrix();
      spouts.setMatrixAt(n++, m4.copy(o.matrix));
    }
    spouts.count = n;
    spouts.instanceMatrix.needsUpdate = true;
  }

  return {
    group,
    get layout() {
      return layout;
    },
    rebuild,
    setActive(map) {
      active = { ...(map || {}) };
      writeSpouts();
    },
    setSpouts(b) {
      spoutsOn = !!b;
      writeSpouts();
    },
    /** Water dash along the pipe to (dir 'out') or from ('in') a slot. */
    flow(slot, dir, count) {
      const route = pipeRouteTo(slot, count ?? layout.count);
      const pts = route.map((p) => new Vector3(p[0], p[1], p[2]));
      if (dir === 'in') pts.reverse();
      let L = 0;
      const seg = [0];
      for (let i = 1; i < pts.length; i++) seg.push((L += pts[i].distanceTo(pts[i - 1])));
      flows.push({ pts, seg, L, t: 0, dur: 1.2 });
    },
    update(dt, env) {
      // drips from active spouts (staggered, slow: one bead per ~1.6 s per plot)
      let n = 0;
      if (!env.reduced) {
        for (const s of layout.spouts) {
          if (!spoutsOn || active[s.slot] !== 'on') continue;
          const ph = ((env.time + s.slot * 0.37) % 1.6) / 1.6;
          const y = PIPE.spoutY - 0.02 - ph * ph * 0.4;
          o.position.set(s.x, y, s.z + 0.02);
          o.rotation.set(0, 0, 0);
          o.scale.set(1, 1 + ph * 0.6, 1);
          o.updateMatrix();
          drips.setMatrixAt(n++, m4.copy(o.matrix));
        }
      }
      drips.count = n;
      if (n) drips.instanceMatrix.needsUpdate = true;
      // flow beads
      let b = 0;
      for (let f = flows.length - 1; f >= 0; f--) {
        const F = flows[f];
        F.t += dt / (env.reduced ? 0.15 : F.dur);
        if (F.t >= 1.25) {
          flows.splice(f, 1);
          continue;
        }
        for (let j = 0; j < 6 && b < 24; j++) {
          const d = (F.t - j * 0.045) * F.L;
          if (d < 0 || d > F.L) continue;
          let i = 1;
          while (i < F.seg.length - 1 && F.seg[i] < d) i++;
          const a = F.pts[i - 1];
          const c = F.pts[i];
          const k = (d - F.seg[i - 1]) / Math.max(1e-6, F.seg[i] - F.seg[i - 1]);
          o.position.lerpVectors(a, c, clamp(k, 0, 1));
          o.lookAt(c);
          o.scale.setScalar(1 - j * 0.12);
          o.updateMatrix();
          beads.setMatrixAt(b++, m4.copy(o.matrix));
        }
      }
      beads.count = b;
      if (b) beads.instanceMatrix.needsUpdate = true;
      return flows.length > 0;
    },
    dispose() {
      mesh?.geometry.dispose();
      spoutGeo.dispose();
      dripGeo.dispose();
      beadGeo.dispose();
      group.removeFromParent();
    },
  };
}

// ------------------------------------------------------------------ public builder

export function buildLandmarks({ puffs = null, count = 10 } = {}) {
  const list = [
    buildStall(),
    buildBarn(puffs),
    buildSilo(),
    buildCrates(),
    buildCompost(),
    buildTower(),
    buildPond(),
    buildWindmill(),
    buildSundial(),
    buildBoard(),
    buildMailbox(),
    buildFirepit(puffs),
    buildPip(),
    buildSignpost(),
  ];
  const byId = new Map(list.map((l) => [l.id, l]));
  // the time-lapse sweep (sundial) also spins the windmill fast (§4.4 "Time-lapse (sim)")
  byId.get('sundial').onSweep = () => byId.get('windmill').timelapse();
  const pipes = buildPipes();
  pipes.rebuild(count);
  const group = new Group();
  group.name = 'landmarks';
  for (const l of list) group.add(l.object3D);
  group.add(pipes.group);
  const get = (id) => byId.get(id);
  let reduced = false;
  let pondFillNow = 0.6;

  return {
    group,
    list,
    byId,
    pipes,
    setReduced(b) {
      reduced = !!b;
    },
    setMoney(m) {
      get('tower').setLevel(m.towerFill, reduced);
      get('pond').setLevel(m.pondFill, reduced);
      pondFillNow = m.pondFill;
      get('silo').setLevel(m.siloFill, reduced);
      get('crates').setCount(m.crates, reduced);
      get('compost').setCount(m.compost, reduced);
    },
    setBarProgress(p) {
      get('windmill').setProgress(p);
    },
    kickWindmill() {
      get('windmill').kick();
    },
    gustWindmill() {
      get('windmill').gust();
    },
    setSundial(v) {
      get('sundial').setVisible(v);
    },
    setSundialHour(h) {
      get('sundial').setHour(h);
    },
    timelapse() {
      get('sundial').timelapse();
      get('windmill').timelapse();
    },
    setUnread(n) {
      get('mailbox').setState({ unread: n });
    },
    setHalted(b) {
      get('stall').setState({ closed: !!b });
    },
    setFeedLook(state) {
      const look = state === 'sim' ? 'sim' : state === 'down' || state === 'offline' ? 'down' : state === 'delayed' ? 'delayed' : 'real';
      get('signpost').setState({ look });
    },
    setNight(k) {
      const b = get('barn');
      if (b.windows) b.windows.emissiveIntensity = clamp(k, 0, 1) * 1.1;
    },
    setSlotCount(n) {
      pipes.rebuild(n);
    },
    setActiveSpouts(map) {
      pipes.setActive(map);
    },
    setSpouts(b) {
      pipes.setSpouts(b);
    },
    flow(slot, dir = 'out', count) {
      get('pond').pumpFor(1.2);
      pipes.flow(slot, dir, count);
    },
    get pondFill() {
      return pondFillNow;
    },
    update(dt, env) {
      let busy = false;
      for (const l of list) if (l.update(dt, env)) busy = true;
      if (pipes.update(dt, env)) busy = true;
      return busy;
    },
    dispose() {
      group.traverse((o) => {
        if (o.isMesh && o.geometry) o.geometry.dispose();
      });
      pipes.dispose();
      proxyMat?.dispose();
      proxyMat = null;
      group.removeFromParent();
    },
  };
}


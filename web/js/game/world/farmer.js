/**
 * world/farmer.js — the decorative walking farmer (WP3; GAME-DESIGN §4.5 "Farmer (P1, decorative, never blocks)").
 *
 *   createFarmer({ count, puffs }) → Farmer
 *   Farmer = {
 *     object3D,
 *     goto(slot, pose),        queue a visit (≤ 3); full queue or > 18 u away → teleport with a dust puff
 *     setEnabled(b),           off (setting / reduced motion) → hidden, queue cleared
 *     setSlotCount(n),         rebuild the path graph (ring + stand points + landmarks)
 *     setBlob(b),              Low tier: a soft contact blob instead of a real shadow
 *     update(dt, env) → busy,  dispose()
 *   }
 *
 * Effects NEVER wait for the farmer: the executor plays every effect at t = 0 and only *asks* him to come
 * over; he arrives and poses (0.6–1.0 s) afterwards. Routing is BFS on a ~30-node graph (logic.js).
 *
 * Rendering: ONE SkinnedMesh with rigid weights (each vertex belongs to exactly one bone) — a rigid-part
 * figure in a single draw call whose shadow follows the pose. Tools hang on bones under the right hand and are
 * shown by scaling their bone to 1 (hidden tools are scaled to ~0).
 */
import {
  Bone,
  BufferAttribute,
  Mesh,
  PlaneGeometry,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from '../three.js';
import { box, cone, cyl, flat, lowpolySphere, merge, paint, tubeAlong, xf } from '../gfx/geom.js';
import { blobTexture, propMaterial } from '../gfx/materials.js';
import { PAL } from '../gfx/palette.js';
import { FARMER, FARMER_HOME, admitTask, bfs, buildPathGraph, nearestNode, poseOf, standXZ } from './logic.js';
import { clamp } from './noise.js';
import { heightAt } from './terrain.js';

const TAU = Math.PI * 2;
const B = Object.freeze({ root: 0, hips: 1, torso: 2, head: 3, armL: 4, armR: 5, legL: 6, legR: 7, dig: 8, water: 9, sickle: 10, hoe: 11, parasol: 12, torch: 13 });
const TOOLS = ['dig', 'water', 'sickle', 'hoe', 'parasol', 'torch'];
const HAND = [-0.29, 0.96, 0.02]; // right hand in bind pose (the farmer faces +Z, so his right is −X)

/** Build the figure geometry with a skinIndex/skinWeight per vertex (rigid parts). */
function farmerGeometry() {
  const parts = [];
  const add = (geo, bone, color) => {
    if (color != null) paint(geo, color);
    const n = geo.attributes.position.count;
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      si[i * 4] = bone;
      sw[i * 4] = 1;
    }
    geo.setAttribute('skinIndex', new BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new BufferAttribute(sw, 4));
    parts.push(geo);
  };
  const overalls = 0x6e7f8c; // muted slate (keeps blue/violet for LONG/SHORT only)
  const shirt = PAL.butter;
  // legs + boots
  for (const [sx, bone] of [[1, B.legL], [-1, B.legR]]) {
    add(flat(cyl(0.085, 0.075, 0.74, 6, null, { p: [sx * 0.11, 0.16, 0] })), bone, overalls);
    add(box(0.17, 0.17, 0.26, null, { p: [sx * 0.11, 0, 0.03] }), bone, PAL.boots);
  }
  // hips + torso (shirt, overall bib, straps, bandana)
  add(box(0.36, 0.2, 0.23, null, { p: [0, 0.86, 0] }), B.hips, overalls);
  add(box(0.4, 0.46, 0.25, null, { p: [0, 1.02, 0] }), B.torso, shirt);
  add(box(0.28, 0.28, 0.04, null, { p: [0, 0.98, 0.12] }), B.torso, overalls);
  for (const sx of [-1, 1]) add(box(0.06, 0.24, 0.04, null, { p: [sx * 0.11, 1.22, 0.12] }), B.torso, overalls);
  add(box(0.04, 0.04, 0.02, null, { p: [0.1, 1.18, 0.145] }), B.torso, PAL.butter);
  add(flat(cyl(0.13, 0.15, 0.08, 7, null, { p: [0, 1.48, 0] })), B.torso, PAL.peach);
  // head: face, nose, ears, hair tuft, straw hat with a band
  add(lowpolySphere(0.19, 1, { jitter: 0.04, seed: 2, t: { p: [0, 1.72, 0.01] } }), B.head, PAL.skin);
  add(lowpolySphere(0.045, 0, { t: { p: [0, 1.7, 0.2] } }), B.head, 0xe8a986);
  for (const sx of [-1, 1]) add(lowpolySphere(0.022, 0, { t: { p: [sx * 0.07, 1.76, 0.18] } }), B.head, 0x2d2620);
  add(flat(cyl(0.34, 0.35, 0.035, 12, null, { p: [0, 1.84, 0] })), B.head, PAL.hat);
  add(flat(cyl(0.16, 0.19, 0.17, 10, null, { p: [0, 1.86, 0] })), B.head, PAL.hat);
  add(flat(cyl(0.192, 0.192, 0.05, 10, null, { p: [0, 1.875, 0] })), B.head, PAL.peach);
  // arms (sleeve + forearm + hand), pivot at the shoulder
  for (const [sx, bone] of [[1, B.armL], [-1, B.armR]]) {
    add(flat(cyl(0.075, 0.065, 0.3, 6, null, { p: [sx * 0.27, 1.17, 0] })), bone, shirt);
    add(flat(cyl(0.055, 0.05, 0.17, 6, null, { p: [sx * 0.29, 1.0, 0.01] })), bone, PAL.skin);
    add(lowpolySphere(0.06, 0, { t: { p: [sx * 0.29, 0.96, 0.02] } }), bone, PAL.skin);
  }
  // tools in hand-local coordinates, moved to the hand
  const at = (g) => xf(g, { p: HAND });
  // trowel
  add(at(merge([box(0.04, 0.16, 0.04, PAL.woodMid, { p: [0, -0.06, 0] }), flat(cone(0.06, 0.2, 3, PAL.metal, { r: [Math.PI, 0, 0], p: [0, -0.06, 0.02] }))], { dispose: true })), B.dig);
  // watering can
  add(at(merge([
    flat(cyl(0.1, 0.11, 0.2, 8, 0x9fb0b8, { p: [0, -0.22, 0.12] })),
    tubeAlong([[0, -0.16, 0.2], [0, -0.06, 0.38], [0, -0.02, 0.44]], 0.022, 5, { color: 0x9fb0b8 }),
    tubeAlong([[0, 0, 0.04], [0, 0.05, 0.12], [0, 0, 0.2]], 0.015, 4, { color: PAL.metalDk }),
  ], { dispose: true })), B.water);
  // sickle
  add(at(merge([
    box(0.035, 0.22, 0.035, PAL.woodMid, { p: [0, -0.12, 0] }),
    tubeAlong(Array.from({ length: 8 }, (_, i) => [0, 0.08 + Math.sin((i / 7) * Math.PI) * 0.16, -Math.cos((i / 7) * Math.PI) * 0.16 + 0.16]), (t) => 0.02 * (1 - t * 0.7), 4, { color: PAL.metal }),
  ], { dispose: true })), B.sickle);
  // hoe (long handle held upright)
  add(at(merge([box(0.035, 1.25, 0.035, PAL.woodLt, { p: [0, -0.65, 0] }), box(0.2, 0.12, 0.025, PAL.metal, { p: [0, -0.72, 0.06] })], { dispose: true })), B.hoe);
  // parasol (folded, cream with a pastel band)
  add(at(merge([box(0.025, 0.95, 0.025, PAL.woodDk, { p: [0, -0.15, 0] }), flat(cone(0.09, 0.5, 8, PAL.cream, { p: [0, 0.32, 0] })), flat(cyl(0.092, 0.092, 0.06, 8, PAL.lavender, { p: [0, 0.42, 0] }))], { dispose: true })), B.parasol);
  // torch
  add(at(merge([box(0.035, 0.55, 0.035, PAL.woodDk, { p: [0, -0.1, 0] }), flat(cone(0.06, 0.18, 5, PAL.ember, { p: [0, 0.44, 0] })), flat(cone(0.035, 0.12, 5, PAL.flame, { p: [0, 0.47, 0.01] }))], { dispose: true })), B.torch);
  return merge(parts, { dispose: true });
}

function buildSkeleton() {
  const bones = [];
  const mk = (parent, x, y, z) => {
    const b = new Bone();
    b.position.set(x, y, z);
    if (parent != null) bones[parent].add(b);
    bones.push(b);
    return b;
  };
  mk(null, 0, 0, 0); // root
  mk(B.root, 0, 0.92, 0); // hips (world y 0.92)
  mk(B.hips, 0, 0.08, 0); // torso pivot at the waist (1.0)
  mk(B.torso, 0, 0.5, 0); // head pivot at the neck (1.5)
  mk(B.torso, 0.27, 0.47, 0); // armL shoulder (1.47)
  mk(B.torso, -0.27, 0.47, 0); // armR shoulder
  mk(B.hips, 0.11, -0.02, 0); // legL hip (0.9)
  mk(B.hips, -0.11, -0.02, 0); // legR hip
  for (let i = 0; i < TOOLS.length; i++) mk(B.armR, HAND[0] + 0.27, HAND[1] - 1.47, HAND[2]); // at the hand
  return bones;
}

export function createFarmer({ count = 10, puffs = null } = {}) {
  const geo = farmerGeometry();
  const bones = buildSkeleton();
  const mesh = new SkinnedMesh(geo, propMaterial({ vertexColors: true, toon: true }));
  mesh.name = 'farmer';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.add(bones[0]);
  mesh.bind(new Skeleton(bones));
  // contact blob for the Low tier (no shadow maps)
  const tex = blobTexture();
  const blob = new Mesh(new PlaneGeometry(1.1, 1.1), propMaterial({ basic: true, color: 0xffffff, transparent: true, depthWrite: false }));
  if (tex) {
    blob.material = blob.material.clone();
    blob.material.map = tex;
  }
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.03;
  blob.visible = false;
  blob.renderOrder = 2;
  mesh.add(blob);

  let graph = buildPathGraph(count);
  let slots = count;
  const pos = new Vector3(FARMER_HOME.x, 0, FARMER_HOME.z);
  let heading = 0; // radians; 0 faces +Z
  let enabled = true;
  let mode = 'idle'; // idle | walk | pose
  let path = []; // [{x, z}]
  let task = null; // { slot, pose }
  const queue = [];
  let poseT = 0;
  let poseDur = 0.8;
  let poseName = 'idle';
  let idleT = 4 + Math.random() * 6;
  let walkPhase = 0;
  let clock = 0;
  let tool = null;
  const tmp = new Vector3();

  const showTool = (name) => {
    tool = TOOLS.includes(name) ? name : null;
    for (const t of TOOLS) bones[B[t]].scale.setScalar(t === tool ? 1 : 0.0001);
  };
  showTool(null);

  function place() {
    mesh.position.set(pos.x, heightAt(pos.x, pos.z), pos.z);
    mesh.rotation.y = heading;
  }

  function poof(x, z) {
    if (!puffs) return;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      puffs.emit({ x: x + Math.cos(a) * 0.3, y: heightAt(x, z) + 0.25, z: z + Math.sin(a) * 0.3, vx: Math.cos(a) * 0.9, vy: 0.35, vz: Math.sin(a) * 0.9, life: 0.9, size: 0.28, grow: 1.2, color: 0xe8dcc0, drag: 2 });
    }
  }

  function standOf(slot) {
    const s = standXZ(slot, slots);
    return { x: s.x, z: s.z };
  }

  function routeTo(target) {
    const from = nearestNode(graph, pos.x, pos.z);
    const to = typeof target === 'string' ? target : nearestNode(graph, target.x, target.z);
    const ids = bfs(graph, from, to) || [to];
    const pts = ids.map((id) => graph.nodes.get(id)).map((n) => ({ x: n.x, z: n.z }));
    if (typeof target !== 'string') pts.push({ x: target.x, z: target.z });
    // skip the first node if we're already past it toward the second
    if (pts.length > 1 && Math.hypot(pts[0].x - pos.x, pts[0].z - pos.z) < 0.4) pts.shift();
    return pts;
  }

  function startTask(t) {
    task = t;
    const target = standOf(t.slot);
    path = routeTo(target);
    mode = 'walk';
    showTool(poseOf(t.pose) === 'idle' ? null : toolFor(poseOf(t.pose)));
  }

  function toolFor(p) {
    return { dig: 'dig', water: 'water', sickle: 'sickle', hoe: 'hoe', parasol: 'parasol', torch: 'torch' }[p] || null;
  }

  function teleport(t) {
    poof(pos.x, pos.z);
    const s = standOf(t.slot);
    pos.set(s.x, 0, s.z);
    heading = Math.PI; // face the box (north)
    queue.length = 0;
    task = t;
    path = [];
    beginPose(poseOf(t.pose));
    poof(pos.x, pos.z);
    place();
  }

  function beginPose(name) {
    mode = 'pose';
    poseName = name;
    poseT = 0;
    poseDur = name === 'idle' ? 0.6 : 0.6 + Math.random() * 0.4;
    showTool(toolFor(name));
  }

  function nextTask() {
    if (queue.length) startTask(queue.shift());
    else {
      task = null;
      mode = 'idle';
      showTool(null);
      idleT = (FARMER.idleMinMs + Math.random() * (FARMER.idleMaxMs - FARMER.idleMinMs)) / 1000;
    }
  }

  // ---- pose solver: writes bone rotations
  function pose(dt) {
    const R = (b) => bones[b].rotation;
    for (const b of [B.hips, B.torso, B.head, B.armL, B.armR, B.legL, B.legR]) R(b).set(0, 0, 0);
    bones[B.hips].position.y = 0.92;
    const t = clock;
    if (mode === 'walk') {
      walkPhase += dt * FARMER.walkHz * TAU;
      const s = Math.sin(walkPhase);
      R(B.legL).x = s * 0.55;
      R(B.legR).x = -s * 0.55;
      R(B.armL).x = -s * 0.45;
      R(B.armR).x = s * 0.45 * (tool === 'hoe' || tool === 'parasol' ? 0.3 : 1);
      R(B.torso).y = s * 0.08;
      R(B.torso).x = 0.06;
      bones[B.hips].position.y = 0.92 + Math.abs(Math.cos(walkPhase)) * 0.04;
      if (tool === 'hoe' || tool === 'parasol') R(B.armR).x -= 0.35;
    } else if (mode === 'pose') {
      const k = clamp(poseT / poseDur, 0, 1);
      const env01 = Math.sin(Math.PI * k); // ease in and out of the pose
      switch (poseName) {
        case 'dig': {
          R(B.torso).x = 0.55 * env01;
          R(B.head).x = 0.2 * env01;
          R(B.armR).x = -0.9 * env01 + Math.sin(t * TAU * 2) * 0.45 * env01;
          R(B.armL).x = -0.4 * env01;
          R(B.legL).x = -0.25 * env01;
          R(B.legR).x = 0.2 * env01;
          bones[B.hips].position.y = 0.92 - 0.1 * env01;
          break;
        }
        case 'water': {
          R(B.armR).x = -1.05 * env01;
          bones[B.water].rotation.x = 0.7 * env01 + Math.sin(t * 5) * 0.08 * env01;
          R(B.torso).x = 0.18 * env01;
          R(B.head).x = 0.25 * env01;
          break;
        }
        case 'sickle': {
          R(B.torso).x = 0.35 * env01;
          R(B.armR).x = -0.9 * env01;
          R(B.armR).z = Math.sin(t * TAU * 2.5) * 0.7 * env01;
          bones[B.hips].position.y = 0.92 - 0.06 * env01;
          break;
        }
        case 'hoe': {
          const chop = Math.max(0, Math.sin(t * TAU * 1.6));
          R(B.armR).x = (-1.6 + chop * 1.2) * env01;
          R(B.armL).x = (-1.4 + chop * 1.1) * env01;
          R(B.torso).x = (0.1 + chop * 0.35) * env01;
          break;
        }
        case 'parasol': {
          R(B.armR).x = -2.4 * env01;
          R(B.armR).z = -0.2 * env01;
          R(B.head).x = -0.3 * env01;
          break;
        }
        case 'torch': {
          R(B.armR).x = -1.5 * env01;
          R(B.torso).x = 0.1 * env01;
          break;
        }
        default: {
          R(B.head).y = Math.sin(t * 0.9) * 0.4;
        }
      }
      if (poseName !== 'water') bones[B.water].rotation.x = 0;
    } else {
      // idle: breathing + glancing around
      R(B.torso).x = Math.sin(t * 1.4) * 0.02;
      R(B.head).y = Math.sin(t * 0.37) * 0.5;
      R(B.head).x = Math.sin(t * 0.23) * 0.08;
      R(B.armL).z = 0.06;
      R(B.armR).z = -0.06;
    }
  }

  const farmer = {
    object3D: mesh,
    get position() {
      return pos;
    },
    get state() {
      return { mode, task, queue: queue.length, enabled };
    },
    goto(slot, poseArg = 'idle') {
      if (!enabled) return;
      const s = Math.floor(Number(slot));
      if (!Number.isFinite(s) || s < 0 || s >= slots) return;
      const t = { slot: s, pose: poseArg };
      const target = standOf(s);
      const dist = Math.hypot(target.x - pos.x, target.z - pos.z);
      const verdict = admitTask(queue.length, dist);
      if (verdict === 'teleport') {
        teleport(t);
        return;
      }
      if (mode === 'idle' || (mode === 'walk' && !task)) startTask(t);
      else queue.push(t);
    },
    setEnabled(b) {
      enabled = !!b;
      mesh.visible = enabled;
      if (!enabled) {
        queue.length = 0;
        task = null;
        mode = 'idle';
        path = [];
        showTool(null);
      }
    },
    setSlotCount(n) {
      const c = Math.max(10, Math.min(15, Math.round(Number(n) || 10)));
      if (c === slots) return;
      slots = c;
      graph = buildPathGraph(c);
      queue.length = 0;
      if (task && task.slot >= c) nextTask();
    },
    setBlob(b) {
      blob.visible = !!b;
    },
    update(dt) {
      if (!enabled) return false;
      clock += dt;
      if (mode === 'walk') {
        let step = FARMER.speed * dt;
        while (step > 0 && path.length) {
          const p = path[0];
          tmp.set(p.x - pos.x, 0, p.z - pos.z);
          const d = tmp.length();
          if (d <= step) {
            pos.x = p.x;
            pos.z = p.z;
            path.shift();
            step -= d;
          } else {
            tmp.multiplyScalar(step / d);
            pos.add(tmp);
            step = 0;
          }
          if (d > 1e-3) {
            const want = Math.atan2(p.x - pos.x, p.z - pos.z);
            let diff = want - heading;
            diff = Math.atan2(Math.sin(diff), Math.cos(diff));
            heading += diff * Math.min(1, dt * 10);
          }
        }
        if (!path.length) {
          if (task) {
            heading = Math.PI; // face the box (north of the stand point)
            beginPose(poseOf(task.pose));
          } else {
            mode = 'idle';
            idleT = (FARMER.idleMinMs + Math.random() * (FARMER.idleMaxMs - FARMER.idleMinMs)) / 1000;
          }
        }
      } else if (mode === 'pose') {
        poseT += dt;
        if (poseT >= poseDur) nextTask();
      } else {
        idleT -= dt;
        if (idleT <= 0) {
          // wander: mostly to a random plot's stand point, sometimes home or to the pond
          const r = Math.random();
          if (r < 0.75) path = routeTo(standOf(Math.floor(Math.random() * slots)));
          else path = routeTo(r < 0.88 ? 'home' : 'pond');
          mode = 'walk';
          task = null;
          showTool(null);
          idleT = 9;
        }
      }
      pose(dt);
      place();
      return true;
    },
    dispose() {
      geo.dispose();
      blob.geometry.dispose();
      mesh.skeleton?.dispose();
      mesh.removeFromParent();
    },
  };
  place();
  return farmer;
}


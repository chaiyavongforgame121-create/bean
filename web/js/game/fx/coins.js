/**
 * fx/coins.js — things that fly along arcs: harvest coins, the pull bundle, the planted seed, fruit hopping
 * into the basket (GAME-DESIGN §4.1, §4.3, §9.8 "Coins/clumps: InstancedMesh (48 max) on CPU-updated
 * quadratic Bézier arcs").
 *
 *   createArcs(scene, { max }) → {
 *     launch(kind, { from, to, n, stagger, ms, height, delay, color, scale, onLand }) → Promise (all landed),
 *     update(dt), busy(), clear(), dispose()
 *   }
 *   kinds: 'coin' (gold, spinning), 'bundle' (brown uprooted clump), 'seed' (planted seed), 'ball' (tinted
 *          sphere: harvested fruit, the failed seed bouncing back)
 *
 * J4: coins exist ONLY for realized gains — the executor launches them from `harvest` effects whose coin count
 * is rules.coinBurst(usd) (0 for any loss, 0 for exactly $0). This module never decides a count itself.
 */

import { Color, CylinderGeometry, DynamicDrawUsage, InstancedMesh, Matrix4, MeshToonMaterial, Quaternion, Vector3 } from '../three.js';
import { lowpolySphere, merge, paint, xf, noise3 } from '../gfx/geom.js';
import { toonGradient } from '../gfx/materials.js';
import { EASE } from '../field/anim.js';

const HIDE = new Matrix4().makeScale(0, 0, 0);
const _m = new Matrix4();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();
const AX = new Vector3(1, 0, 0);
const AY = new Vector3(0, 1, 0);

function coinGeometry() {
  const body = new CylinderGeometry(0.17, 0.17, 0.045, 14, 1);
  paint(body, (x, y) => (Math.abs(y) > 0.02 ? _c.set('#F7D66B') : _c.set('#D9A92E')));
  const rim = new CylinderGeometry(0.11, 0.11, 0.05, 10, 1);
  paint(rim, '#E8B93A');
  // stand the coin up (face toward ±Z) so it flips nicely while flying
  const g = merge([body, rim], { dispose: true });
  xf(g, { r: [Math.PI / 2, 0, 0] });
  return g;
}

function bundleGeometry() {
  const parts = [];
  for (let i = 0; i < 5; i++) {
    const s = lowpolySphere(0.16 + (i % 2) * 0.05, 0, { jitter: 0.3, seed: i + 3 });
    paint(s, i % 2 ? '#6B4A2E' : '#7A5634');
    xf(s, { p: [((i * 37) % 5) * 0.06 - 0.12, ((i * 13) % 3) * 0.06, ((i * 17) % 4) * 0.05 - 0.08] });
    parts.push(s);
  }
  // a few wilted stalks poking out
  for (let i = 0; i < 3; i++) {
    const st = new CylinderGeometry(0.015, 0.02, 0.4, 4);
    paint(st, '#8E7A45');
    xf(st, { p: [0, 0.2, 0], r: [0.4 * (i - 1), 0, 0.5 * (i - 1)] });
    parts.push(st);
  }
  return merge(parts, { dispose: true });
}

function seedGeometry() {
  const g = lowpolySphere(0.14, 1, { jitter: 0.04, squash: [0.75, 1, 0.55] });
  paint(g, (x, y, z) => _c.set('#E2C27A').multiplyScalar(0.9 + 0.15 * noise3(x * 30, y * 30, z * 30)));
  return g;
}

function ballGeometry() {
  const g = lowpolySphere(0.13, 1, { jitter: 0.04 });
  paint(g, (x, y) => _c.setScalar(y > 0.05 ? 1 : 0.85));
  return g;
}

/** Point on the quadratic Bézier A → B with the control point lifted `height` above their midpoint. */
export function arcPoint(out, a, b, height, t) {
  const u = 1 - t;
  const cx = (a.x + b.x) / 2;
  const cy = Math.max(a.y, b.y) + height;
  const cz = (a.z + b.z) / 2;
  out.x = u * u * a.x + 2 * u * t * cx + t * t * b.x;
  out.y = u * u * a.y + 2 * u * t * cy + t * t * b.y;
  out.z = u * u * a.z + 2 * u * t * cz + t * t * b.z;
  return out;
}

export function createArcs(scene, { max = 48 } = {}) {
  const mat = new MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });
  const coinMat = new MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient(), emissive: new Color('#FFC94A'), emissiveIntensity: 0.18 });
  const meshes = {};
  const mk = (kind, geo, material, cap, colors = false) => {
    const m = new InstancedMesh(geo, material, cap);
    m.name = `fx:arc:${kind}`;
    m.instanceMatrix.setUsage(DynamicDrawUsage);
    m.frustumCulled = false;
    m.castShadow = true;
    for (let i = 0; i < cap; i++) m.setMatrixAt(i, HIDE);
    if (colors) for (let i = 0; i < cap; i++) m.setColorAt(i, _c.setRGB(1, 1, 1));
    m.visible = false;
    scene.add(m);
    meshes[kind] = { mesh: m, cap, free: Array.from({ length: cap }, (_, i) => cap - 1 - i) };
  };
  mk('coin', coinGeometry(), coinMat, max);
  mk('bundle', bundleGeometry(), mat, 8);
  mk('seed', seedGeometry(), mat, 8);
  mk('ball', ballGeometry(), mat, 24, true);

  const flights = [];

  /**
   * Launch n objects from `from` to `to` (Vector3s, or functions returning one at launch time).
   * Resolves when the last one lands. `onLand(i)` fires per object (crate bump, soil close, …).
   */
  function launch(kind, { from, to, n = 1, stagger = 60, ms = 900, height = 3, delay = 0, color = null, scale = 1, spin = true, bounce = false, onLand = null } = {}) {
    const M = meshes[kind] || meshes.ball;
    const list = [];
    for (let i = 0; i < n; i++) {
      const idx = M.free.pop();
      if (idx === undefined) break;
      const f = {
        M,
        idx,
        t: -(delay + i * stagger),
        ms: Math.max(50, ms),
        from: typeof from === 'function' ? null : from?.clone?.() ?? new Vector3(),
        fromFn: typeof from === 'function' ? from : null,
        to: to?.clone?.() ?? new Vector3(),
        height,
        scale,
        spin: spin ? (i % 2 ? 1 : -1) * (7 + (i % 3)) : 0,
        jitter: new Vector3((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4),
        bounce,
        i,
        onLand,
        done: null,
      };
      if (color && M.mesh.instanceColor) {
        M.mesh.setColorAt(idx, _c.set(color));
        M.mesh.instanceColor.needsUpdate = true;
      }
      f.done = new Promise((r) => (f.resolve = r));
      flights.push(f);
      list.push(f.done);
    }
    return Promise.all(list);
  }

  function update(dt) {
    const ms = Math.min(100, Math.max(0, (Number(dt) || 0) * 1000));
    const dirty = new Set();
    for (let j = flights.length - 1; j >= 0; j--) {
      const f = flights[j];
      f.t += ms;
      if (f.t < 0) continue;
      if (!f.from) f.from = (f.fromFn?.() ?? new Vector3()).clone();
      const k = Math.min(1, f.t / f.ms);
      const e = EASE.inOutQuad(k);
      const target = f.to.clone().add(f.jitter);
      arcPoint(_p, f.from, target, f.height, e);
      let sc = f.scale * Math.min(1, k * 6);
      if (f.bounce && k > 0.85) sc *= 1 - (k - 0.85) / 0.15 * 0.6;
      _q.setFromAxisAngle(AY, f.spin * f.t * 0.001 * 0.6);
      _q2.setFromAxisAngle(AX, f.spin * f.t * 0.001);
      _q.multiply(_q2);
      _s.setScalar(sc);
      _m.compose(_p, _q, _s);
      f.M.mesh.setMatrixAt(f.idx, _m);
      dirty.add(f.M);
      if (k >= 1) {
        f.M.mesh.setMatrixAt(f.idx, HIDE);
        f.M.free.push(f.idx);
        flights.splice(j, 1);
        try {
          f.onLand?.(f.i);
        } catch {
          /* decorative */
        }
        f.resolve(true);
      }
    }
    for (const M of Object.values(meshes)) {
      const active = flights.some((f) => f.M === M && f.t >= 0);
      M.mesh.visible = active;
      if (dirty.has(M)) M.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  return {
    launch,
    update,
    busy: () => flights.length > 0,
    clear() {
      for (const f of flights) {
        f.M.mesh.setMatrixAt(f.idx, HIDE);
        f.M.free.push(f.idx);
        f.resolve(false);
      }
      flights.length = 0;
      for (const M of Object.values(meshes)) {
        M.mesh.instanceMatrix.needsUpdate = true;
        M.mesh.visible = false;
      }
    },
    rebuild() {
      for (const M of Object.values(meshes)) {
        M.mesh.instanceMatrix.needsUpdate = true;
        if (M.mesh.instanceColor) M.mesh.instanceColor.needsUpdate = true;
      }
    },
    dispose() {
      for (const M of Object.values(meshes)) {
        M.mesh.removeFromParent();
        M.mesh.geometry.dispose();
        M.mesh.dispose();
      }
      mat.dispose();
      coinMat.dispose();
    },
  };
}

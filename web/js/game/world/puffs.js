/**
 * world/puffs.js — a tiny pool of soft low-poly puffs owned by the world (WP3): barn chimney smoke (§4.5, P1),
 * the farmer's teleport dust poof (§4.5), the fire-pit smoke wisp and pump splashes.
 *
 * One InstancedMesh (one draw call). CPU-updated because the pool is small (≤ 40). Effects that carry
 * information (the WP4 particle pool) do NOT use this; these are ambience only and are off in reduced motion.
 *
 *   createPuffs({ max }) → { mesh, emit({x,y,z, vx,vy,vz, life, size, grow, color}), update(dt), clear(), dispose() }
 */
import { Color, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshLambertMaterial, Object3D } from '../three.js';
import { lowpolySphere } from '../gfx/geom.js';

export function createPuffs({ max = 40 } = {}) {
  const geo = lowpolySphere(0.5, 1, { jitter: 0.18, seed: 3 });
  const mat = new MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.18 });
  const mesh = new InstancedMesh(geo, mat, max);
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(max * 3), 3);
  mesh.name = 'puffs';
  mesh.frustumCulled = false;
  mesh.count = 0;
  const pool = [];
  const o = new Object3D();
  const m4 = new Matrix4();
  const col = new Color();
  let head = 0;

  function emit({ x = 0, y = 0, z = 0, vx = 0, vy = 0.6, vz = 0, life = 2.5, size = 0.5, grow = 1.6, color = 0xf4f1ec, drag = 0.4 } = {}) {
    const p = { x, y, z, vx, vy, vz, age: 0, life, size, grow, color, drag, spin: Math.random() * 6 };
    if (pool.length < max) pool.push(p);
    else {
      pool[head] = p;
      head = (head + 1) % max;
    }
  }

  function update(dt) {
    let n = 0;
    for (let i = pool.length - 1; i >= 0; i--) {
      const p = pool[i];
      p.age += dt;
      if (p.age >= p.life) {
        pool.splice(i, 1);
        if (head > pool.length) head = 0;
        continue;
      }
      const k = p.age / p.life;
      const damp = Math.max(0, 1 - p.drag * dt);
      p.vx *= damp;
      p.vz *= damp;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      // swell, then shrink away (no transparency needed)
      const s = p.size * (0.35 + p.grow * Math.sin(Math.PI * Math.min(1, k * 1.15)) * (1 - k * 0.35));
      o.position.set(p.x, p.y, p.z);
      o.rotation.set(0, p.spin + k * 1.5, 0);
      o.scale.setScalar(Math.max(0.001, s));
      o.updateMatrix();
      mesh.setMatrixAt(n, m4.copy(o.matrix));
      mesh.setColorAt(n, col.set(p.color));
      n++;
    }
    mesh.count = n;
    if (n) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
    return n > 0;
  }

  return {
    mesh,
    emit,
    update,
    get active() {
      return pool.length;
    },
    clear() {
      pool.length = 0;
      mesh.count = 0;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      mesh.removeFromParent();
    },
  };
}

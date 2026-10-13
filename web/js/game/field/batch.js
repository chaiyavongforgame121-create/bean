/**
 * field/batch.js — instanced prop batches for the planter boxes (GAME-DESIGN §9.8 "Static batching").
 *
 * Box shells per family, soil, posts, signs, stakes, sacks, thermometers, parasols, … are one InstancedMesh
 * each, shared by all plots: a plot owns `perPlot` logical instances (`slot·perPlot + k`). Visible instances
 * are PACKED to the front of the GPU buffer on flush and `mesh.count` = the number visible, so hidden props
 * cost neither triangles nor vertex work; a batch with nothing visible is not drawn at all (mesh.visible =
 * false), so a rarely used prop (trowel, parasol, A-frame) costs no draw call until it appears.
 *
 *   const B = createBatches(scene, { maxSlots: 15 });
 *   B.define('soil', { geometry, material, perPlot: 1, colors: true, receiveShadow: true });
 *   const h = B.handle('soil', slot);          // → Handle
 *   h.set(base, x, y, z, quat, sx, sy, sz);     // world = base (Vector3) + local transform
 *   h.color(0x7a4e35); h.hide();
 *   B.flush();                                  // once per frame (packs + uploads dirty batches)
 */

import { Color, DynamicDrawUsage, InstancedMesh, Matrix4, Quaternion, Vector3 } from '../three.js';

const IDQ = new Quaternion();
const _m = new Matrix4();
const _v = new Vector3();
const _s = new Vector3();
const _c = new Color();

export function createBatches(scene, { maxSlots = 15 } = {}) {
  const batches = new Map();

  function define(name, { geometry, material, perPlot = 1, castShadow = false, receiveShadow = false, colors = false, renderOrder = 0, layer = 0 }) {
    const cap = Math.max(1, maxSlots * perPlot);
    const mesh = new InstancedMesh(geometry, material, cap);
    mesh.name = `field:${name}`;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = castShadow;
    mesh.userData.caster = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.renderOrder = renderOrder;
    if (layer) mesh.layers.set(layer);
    if (colors) {
      for (let i = 0; i < cap; i++) mesh.setColorAt(i, _c.setRGB(1, 1, 1));
      mesh.instanceColor.setUsage(DynamicDrawUsage);
    }
    mesh.count = 0;
    mesh.visible = false;
    scene.add(mesh);
    const b = {
      name,
      mesh,
      perPlot,
      cap,
      vis: new Uint8Array(cap),
      mats: new Float32Array(cap * 16), // logical instance → matrix (source of truth)
      cols: colors ? new Float32Array(cap * 3).fill(1) : null,
      nVis: 0,
      dirty: false,
      geometry,
      material,
    };
    batches.set(name, b);
    return b;
  }

  function handle(name, slot, k = 0) {
    const b = batches.get(name);
    if (!b) return NULL_HANDLE;
    const i = slot * b.perPlot + k;
    if (i < 0 || i >= b.cap) return NULL_HANDLE;
    const show = () => {
      if (!b.vis[i]) {
        b.vis[i] = 1;
        b.nVis++;
      }
      b.dirty = true;
    };
    return {
      batch: b,
      index: i,
      get visible() {
        return !!b.vis[i];
      },
      /** world = base + local (x, y, z), rotation q (Quaternion or null), scale (sx, sy, sz). */
      set(base, x, y, z, q = null, sx = 1, sy = sx, sz = sx) {
        if (sx === 0 && sy === 0 && sz === 0) return this.hide();
        _v.set(base.x + x, base.y + y, base.z + z);
        _s.set(sx, sy, sz);
        _m.compose(_v, q || IDQ, _s);
        _m.toArray(b.mats, i * 16);
        show();
        return this;
      },
      /** A ready matrix (already in world space). */
      setMatrix(m) {
        m.toArray(b.mats, i * 16);
        show();
        return this;
      },
      hide() {
        if (!b.vis[i]) return this;
        b.vis[i] = 0;
        b.nVis--;
        b.dirty = true;
        return this;
      },
      color(c) {
        if (!b.cols) return this;
        if (c && c.isColor) _c.copy(c);
        else _c.set(c);
        const o = i * 3;
        if (b.cols[o] !== _c.r || b.cols[o + 1] !== _c.g || b.cols[o + 2] !== _c.b) {
          b.cols[o] = _c.r;
          b.cols[o + 1] = _c.g;
          b.cols[o + 2] = _c.b;
          b.dirty = true;
        }
        return this;
      },
    };
  }

  /** Pack the visible instances to the front and upload (dirty batches only). */
  function flush() {
    for (const b of batches.values()) {
      if (b.dirty) {
        const M = b.mesh.instanceMatrix.array;
        const C = b.mesh.instanceColor ? b.mesh.instanceColor.array : null;
        let n = 0;
        for (let i = 0; i < b.cap; i++) {
          if (!b.vis[i]) continue;
          M.set(b.mats.subarray(i * 16, i * 16 + 16), n * 16);
          if (C && b.cols) {
            C[n * 3] = b.cols[i * 3];
            C[n * 3 + 1] = b.cols[i * 3 + 1];
            C[n * 3 + 2] = b.cols[i * 3 + 2];
          }
          n++;
        }
        b.mesh.count = n;
        b.mesh.instanceMatrix.clearUpdateRanges?.();
        b.mesh.instanceMatrix.addUpdateRange?.(0, Math.max(1, n) * 16);
        b.mesh.instanceMatrix.needsUpdate = true;
        if (b.mesh.instanceColor) {
          b.mesh.instanceColor.clearUpdateRanges?.();
          b.mesh.instanceColor.addUpdateRange?.(0, Math.max(1, n) * 3);
          b.mesh.instanceColor.needsUpdate = true;
        }
        b.dirty = false;
      }
      b.mesh.visible = b.nVis > 0;
    }
  }

  /** Context restore: re-upload every instance buffer. */
  function rebuild() {
    for (const b of batches.values()) b.dirty = true;
    flush();
  }

  function setShadows(on) {
    for (const b of batches.values()) b.mesh.castShadow = !!on && !!b.mesh.userData.caster;
  }

  function dispose() {
    for (const b of batches.values()) {
      b.mesh.removeFromParent();
      b.mesh.dispose();
      b.geometry.dispose();
    }
    batches.clear();
  }

  /** Draw calls this frame (visible batches). */
  function drawCount() {
    let n = 0;
    for (const b of batches.values()) if (b.nVis > 0) n++;
    return n;
  }

  /** Triangles drawn by the visible instances (main pass). */
  function triangles() {
    let t = 0;
    for (const b of batches.values()) {
      if (!b.nVis) continue;
      const g = b.geometry;
      t += ((g.index ? g.index.count : g.attributes.position.count) / 3) * b.nVis;
    }
    return Math.round(t);
  }

  return { define, handle, flush, rebuild, dispose, drawCount, triangles, setShadows, batches };
}

const NULL_HANDLE = Object.freeze({
  batch: null,
  index: -1,
  visible: false,
  set() {
    return this;
  },
  setMatrix() {
    return this;
  },
  hide() {
    return this;
  },
  color() {
    return this;
  },
});

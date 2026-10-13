/**
 * world/batch.js — fold many small meshes that share ONE material into a single BatchedMesh (WP3; §9.8
 * "static batching", §9.9 draw-call budgets).
 *
 *   batchMeshes(root, material, { exclude }) → { mesh, count, sync(), dispose() } | null
 *
 * Every non-instanced, non-skinned Mesh under `root` whose material === `material` (the shared toon
 * vertex-colour material) becomes one instance of a BatchedMesh. The original Mesh STAYS in the scene graph as
 * the source of truth for its transform and visibility (landmark code keeps animating it exactly as before),
 * but it is moved to layer 31 so the camera and the shadow camera skip it. `sync()` (call after
 * root.updateMatrixWorld(), every frame) copies each original's world matrix and effective visibility into the
 * batch. Result: the whole farm's props cost one main-pass and one shadow-pass draw call instead of ~40.
 *
 * Geometries are normalised to the same attribute set (position, normal, color; non-indexed) as BatchedMesh
 * requires. If BatchedMesh is unavailable, batchMeshes returns null and nothing changes (meshes render as is).
 */
import { BatchedMesh, BufferAttribute, Matrix4 } from '../three.js';

const HIDDEN_LAYER = 31;
const KEEP = ['position', 'normal', 'color'];

function normalise(geo) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const name of Object.keys(g.attributes)) if (!KEEP.includes(name)) g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.color) g.setAttribute('color', new BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}

function effectivelyVisible(o, stop) {
  for (let p = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (p === stop) break;
  }
  return true;
}

export function batchMeshes(root, material, { exclude = () => false, castShadow = true } = {}) {
  if (typeof BatchedMesh !== 'function') return null;
  const items = [];
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh) return;
    if (o.material !== material || exclude(o)) return;
    items.push(o);
  });
  if (!items.length) return null;
  const geos = items.map((o) => normalise(o.geometry));
  const vtx = geos.reduce((n, g) => n + g.attributes.position.count, 0);
  let batch;
  try {
    batch = new BatchedMesh(items.length, vtx, 0, material);
  } catch {
    return null;
  }
  batch.name = 'propsBatch';
  batch.castShadow = castShadow;
  batch.receiveShadow = true;
  batch.frustumCulled = false; // per-instance culling instead (perObjectFrustumCulled)
  const ids = [];
  try {
    for (let i = 0; i < items.length; i++) {
      const gid = batch.addGeometry(geos[i]);
      ids.push(batch.addInstance(gid));
    }
  } catch (e) {
    globalThis.console?.warn?.('world: batching disabled', e);
    batch.dispose();
    geos.forEach((g) => g.dispose());
    return null;
  }
  geos.forEach((g) => g.dispose());
  for (const o of items) o.layers.set(HIDDEN_LAYER);
  root.add(batch);

  const rootInv = new Matrix4();
  const m = new Matrix4();
  function sync() {
    // the batch is a child of root, so instance matrices are root-relative
    rootInv.copy(root.matrixWorld).invert();
    for (let i = 0; i < items.length; i++) {
      const o = items[i];
      const vis = effectivelyVisible(o, root);
      batch.setVisibleAt(ids[i], vis);
      if (vis) batch.setMatrixAt(ids[i], m.multiplyMatrices(rootInv, o.matrixWorld));
    }
  }

  return {
    mesh: batch,
    count: items.length,
    sync,
    dispose() {
      for (const o of items) o.layers.set(0);
      batch.dispose();
      batch.removeFromParent();
    },
  };
}

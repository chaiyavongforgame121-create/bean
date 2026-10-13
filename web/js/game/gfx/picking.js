/**
 * gfx/picking.js — raycast picking on invisible proxies + tap/double/long-press/drag-drop gestures
 * (GAME-DESIGN §5.2, §5.3).
 *
 *   const picker = createPicker(camera, canvas);
 *   const off = picker.register(proxyMesh, { type: 'plot', slot: 3 });     // or { type: 'landmark', id: 'barn' }
 *   picker.onTap((hit, ev) => …)        click/tap: moved < 6 px and pressed < 500 ms → hit | null (empty ground)
 *   picker.onDouble((hit, ev) => …)     second tap within 350 ms / 24 px (double-click, double-tap)
 *   picker.onLongPress((hit, ev) => …)  touch/pen held 450 ms without moving (radial, P1)
 *   picker.onHover((hit, ev) => …)      fine pointers only, at most one raycast per frame, on change only
 *   picker.onDragDrop(({ phase, slot, point, data, clientX, clientY }) => …)   phase 'over' | 'leave' | 'drop'
 *   picker.pickAt(clientX, clientY) → hit | null
 *   picker.slotNear(clientX, clientY) → { slot, point } | null   (ground ray, nearest plot within 2.2 u)
 *   picker.dragOver(x, y, data) / picker.drop(x, y, data) / picker.dragLeave()   for pointer-driven seed drags (WP5)
 *   picker.setEnabled(b) · picker.dispose()
 *
 * Only registered proxies are tested (about 15 plots + 14 landmarks), on layer 1, never crop meshes.
 * Native HTML5 drops are accepted too: dataTransfer 'application/x-bean' (JSON or a bean id) or 'text/plain'.
 */

import { Raycaster, Vector2 } from '../three.js';
import { rayFromCamera, rayPlaneY } from './camera.js';

export const PICK = Object.freeze({ tapPx: 6, tapMs: 500, doubleMs: 350, doublePx: 24, longMs: 450, snapU: 2.2, layer: 1 });

const BEAN_TYPES = ['application/x-bean', 'text/plain'];

export function createPicker(camera, dom, { raf = (fn) => globalThis.requestAnimationFrame?.(fn) ?? setTimeout(fn, 16), now = () => performance.now() } = {}) {
  const raycaster = new Raycaster();
  raycaster.layers.set(PICK.layer);
  const ndc = new Vector2();
  /** @type {Map<object, object>} proxy → info */
  const proxies = new Map();
  const fns = { tap: new Set(), double: new Set(), long: new Set(), hover: new Set(), drag: new Set() };
  let enabled = true;

  function fire(kind, ...args) {
    for (const fn of [...fns[kind]]) {
      try {
        fn(...args);
      } catch (e) {
        globalThis.console?.error?.(`picker ${kind} handler failed`, e);
      }
    }
  }
  const subscribe = (kind) => (fn) => {
    fns[kind].add(fn);
    return () => fns[kind].delete(fn);
  };

  function setNdc(clientX, clientY) {
    const r = dom.getBoundingClientRect();
    ndc.set(((clientX - r.left) / Math.max(1, r.width)) * 2 - 1, -(((clientY - r.top) / Math.max(1, r.height)) * 2 - 1));
    return ndc;
  }

  function pickAt(clientX, clientY) {
    if (!proxies.size) return null;
    raycaster.setFromCamera(setNdc(clientX, clientY), camera);
    const hits = raycaster.intersectObjects([...proxies.keys()], false);
    for (const h of hits) {
      const info = proxies.get(h.object);
      if (info) return { ...info, point: { x: h.point.x, y: h.point.y, z: h.point.z } };
    }
    return null;
  }

  /** Nearest registered plot to the ground point under (clientX, clientY), within 2.2 u. */
  function slotNear(clientX, clientY) {
    setNdc(clientX, clientY);
    const g = rayPlaneY(rayFromCamera(camera, ndc.x, ndc.y), 0);
    if (!g) return null;
    let best = null;
    for (const [obj, info] of proxies) {
      if (info.type !== 'plot') continue;
      const e = obj.matrixWorld.elements;
      const d = Math.hypot(e[12] - g.x, e[14] - g.z);
      if (d <= PICK.snapU && (!best || d < best.d)) best = { slot: info.slot, d };
    }
    return best ? { slot: best.slot, point: g } : { slot: null, point: g };
  }

  function register(proxy, info) {
    if (!proxy) return () => {};
    try {
      proxy.layers?.set(PICK.layer);
      proxy.updateWorldMatrix?.(true, false);
    } catch {
      /* not an Object3D */
    }
    proxies.set(proxy, { ...(info || {}) });
    return () => proxies.delete(proxy);
  }

  // ---------------------------------------------------------------- gestures

  const downs = new Map(); // pointerId → { x, y, t, type, button, moved, longFired, timer }
  let multi = false;
  let lastTap = null; // { x, y, t, key }
  let hoverQueued = false;
  let hoverXY = null;
  let hoverKey = '';

  const keyOf = (hit) => (hit ? (hit.type === 'plot' ? `plot:${hit.slot}` : `${hit.type}:${hit.id}`) : '');

  function onDown(e) {
    if (!enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const d = { x: e.clientX, y: e.clientY, t: now(), type: e.pointerType, moved: false, longFired: false, timer: null };
    downs.set(e.pointerId, d);
    if (downs.size > 1) {
      multi = true;
      for (const x of downs.values()) clearTimeout(x.timer);
      return;
    }
    multi = false;
    if (e.pointerType !== 'mouse') {
      d.timer = setTimeout(() => {
        if (!enabled || d.moved || multi || !downs.has(e.pointerId)) return;
        d.longFired = true;
        fire('long', pickAt(d.x, d.y), { clientX: d.x, clientY: d.y, pointerType: d.type });
      }, PICK.longMs);
    }
  }

  function onMove(e) {
    const d = downs.get(e.pointerId);
    if (d && !d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) >= PICK.tapPx) {
      d.moved = true;
      clearTimeout(d.timer);
    }
    // hover: fine pointers only, no buttons pressed, one raycast per frame
    if (!enabled || e.pointerType === 'touch' || e.buttons) return;
    hoverXY = { x: e.clientX, y: e.clientY };
    if (hoverQueued) return;
    hoverQueued = true;
    raf(() => {
      hoverQueued = false;
      if (!hoverXY || !enabled) return;
      const hit = pickAt(hoverXY.x, hoverXY.y);
      const k = keyOf(hit);
      if (k === hoverKey) return;
      hoverKey = k;
      try {
        dom.style.cursor = hit ? 'pointer' : '';
      } catch {
        /* ignore */
      }
      fire('hover', hit, { clientX: hoverXY.x, clientY: hoverXY.y });
    });
  }

  function onLeave() {
    hoverXY = null;
    if (hoverKey) {
      hoverKey = '';
      try {
        dom.style.cursor = '';
      } catch {
        /* ignore */
      }
      fire('hover', null, {});
    }
  }

  function onUp(e) {
    const d = downs.get(e.pointerId);
    if (!d) return;
    downs.delete(e.pointerId);
    clearTimeout(d.timer);
    const wasMulti = multi;
    if (!downs.size) multi = false;
    if (!enabled || e.type === 'pointercancel' || d.moved || d.longFired || wasMulti) return;
    if (now() - d.t > PICK.tapMs) return;
    const hit = pickAt(e.clientX, e.clientY);
    const ev = { clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType, shiftKey: e.shiftKey };
    fire('tap', hit, ev);
    const t = now();
    const key = keyOf(hit);
    if (lastTap && t - lastTap.t <= PICK.doubleMs && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) <= PICK.doublePx && key === lastTap.key) {
      lastTap = null;
      fire('double', hit, ev);
    } else lastTap = { x: e.clientX, y: e.clientY, t, key };
  }

  // ---------------------------------------------------------------- seed drag & drop

  let dragSlot;

  function dragOver(clientX, clientY, data = null) {
    if (!enabled) return null;
    const near = slotNear(clientX, clientY);
    const slot = near?.slot ?? null;
    if (slot !== dragSlot) {
      dragSlot = slot;
      fire('drag', { phase: 'over', slot, point: near?.point ?? null, data, clientX, clientY });
    }
    return near;
  }

  function dragLeave() {
    if (dragSlot !== undefined) {
      dragSlot = undefined;
      fire('drag', { phase: 'leave', slot: null, point: null, data: null });
    }
  }

  function drop(clientX, clientY, data = null) {
    if (!enabled) return null;
    const near = slotNear(clientX, clientY);
    dragSlot = undefined;
    fire('drag', { phase: 'drop', slot: near?.slot ?? null, point: near?.point ?? null, data, clientX, clientY });
    return near;
  }

  function beanData(dt) {
    if (!dt) return null;
    for (const type of BEAN_TYPES) {
      let raw = '';
      try {
        raw = dt.getData(type);
      } catch {
        raw = '';
      }
      if (!raw) continue;
      try {
        const j = JSON.parse(raw);
        if (j && typeof j === 'object') return j;
        if (Number.isInteger(j)) return { bean: j };
      } catch {
        /* not JSON */
      }
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 0) return { bean: n };
    }
    return null;
  }

  const hasBean = (e) => [...(e.dataTransfer?.types || [])].some((t) => BEAN_TYPES.includes(t));
  function onDragOver(e) {
    if (!enabled || !hasBean(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dragOver(e.clientX, e.clientY, null);
  }
  function onDrop(e) {
    if (!enabled || !hasBean(e)) return;
    e.preventDefault();
    drop(e.clientX, e.clientY, beanData(e.dataTransfer));
  }
  const onDragLeave = () => dragLeave();

  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointercancel', onUp);
  dom.addEventListener('pointerleave', onLeave);
  dom.addEventListener('dragover', onDragOver);
  dom.addEventListener('drop', onDrop);
  dom.addEventListener('dragleave', onDragLeave);

  return {
    register,
    onHover: subscribe('hover'),
    onTap: subscribe('tap'),
    onDouble: subscribe('double'),
    onLongPress: subscribe('long'),
    onDragDrop: subscribe('drag'),
    pickAt,
    slotNear,
    dragOver,
    dragLeave,
    drop,
    setEnabled(b) {
      enabled = !!b;
      if (!enabled) {
        for (const d of downs.values()) clearTimeout(d.timer);
        downs.clear();
        onLeave();
      }
    },
    get count() {
      return proxies.size;
    },
    dispose() {
      for (const d of downs.values()) clearTimeout(d.timer);
      downs.clear();
      proxies.clear();
      for (const s of Object.values(fns)) s.clear();
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointercancel', onUp);
      dom.removeEventListener('pointerleave', onLeave);
      dom.removeEventListener('dragover', onDragOver);
      dom.removeEventListener('drop', onDrop);
      dom.removeEventListener('dragleave', onDragLeave);
    },
  };
}

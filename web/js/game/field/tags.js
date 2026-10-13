/**
 * field/tags.js — small DOM labels pinned to points of a planter box (GAME-DESIGN §3.2, §3.5, §7.2).
 *
 * Text never goes into WebGL (§1.4: not translatable, blurry Thai). The ×N stake plaque number and the
 * red-lettered "LIQUIDATED −$X" sign are DOM elements projected onto the box:
 *   - through WP2's labels (`labels.anchor(object3D, el, { offsetY })`, gfx/labels.js) when it is available;
 *   - otherwise through our own projection when a camera is given (dev harness / early integration);
 *   - otherwise they stay hidden (the dock and chips always carry the same numbers).
 *
 * Elements live in the aria-hidden `#fx` container (§6) and use the shared classes `.fx-label`,
 * `.fx-label--{up|down|neutral|warn}` plus `.fx-tag`, `.fx-tag--lev`, `.fx-tag--liq` for WP5 to style.
 * Only positions and a few layout fallbacks are written through CSSOM (CSP style-src 'self').
 */

import { Vector3 } from '../three.js';

const _v = new Vector3();

/** Minimal layout fallbacks so a tag is readable even before game.css styles `.fx-tag`. */
function baseStyle(el) {
  const s = el.style;
  s.position = 'absolute';
  s.left = '0';
  s.top = '0';
  s.pointerEvents = 'none';
  s.whiteSpace = 'nowrap';
  s.willChange = 'transform';
  s.translate = '-50% -50%'; // centred on the point (independent of the projector's transform)
}

/**
 * createTags({ labels, container, camera, canvas }) → { add(object3D, opts) → Tag, update(), clear() }
 * Tag = { el, setText(text), setTone(tone), setVisible(on), remove() }
 */
export function createTags({ labels = null, container = null, camera = null, canvas = null } = {}) {
  const doc = globalThis.document;
  const box = container || doc?.getElementById?.('fx') || null;
  const own = new Set(); // tags we project ourselves
  const useLabels = !!(labels && typeof labels.anchor === 'function');

  function add(object3D, { cls = '', text = '', tone = 'neutral', offsetY = 0 } = {}) {
    if (!doc || !box) return NULL_TAG;
    const el = doc.createElement('div');
    el.className = `fx-label fx-label--${tone} fx-tag ${cls}`.trim();
    el.setAttribute('aria-hidden', 'true');
    el.textContent = text;
    baseStyle(el);
    box.appendChild(el);
    let visible = true;
    let handle = null;
    if (useLabels) {
      try {
        handle = labels.anchor(object3D, el, { offsetY, hideBehind: true });
      } catch {
        handle = null;
      }
    }
    const tag = {
      el,
      object3D,
      offsetY,
      setText(t) {
        if (el.textContent !== t) el.textContent = t;
      },
      setTone(t) {
        el.className = `fx-label fx-label--${t} fx-tag ${cls}`.trim();
      },
      setVisible(on) {
        visible = !!on;
        if (handle?.setVisible) handle.setVisible(visible);
        el.hidden = !visible;
      },
      get visible() {
        return visible;
      },
      remove() {
        own.delete(tag);
        try {
          handle?.remove?.();
        } catch {
          /* ignore */
        }
        el.remove();
      },
    };
    if (!handle) own.add(tag);
    return tag;
  }

  /** Project the tags that WP2's labels do not handle (needs a camera). */
  function update() {
    if (!own.size) return;
    if (!camera) {
      for (const tag of own) tag.el.hidden = true;
      return;
    }
    const w = canvas?.clientWidth || box.clientWidth || globalThis.innerWidth || 1;
    const h = canvas?.clientHeight || box.clientHeight || globalThis.innerHeight || 1;
    for (const tag of own) {
      if (!tag.visible) continue;
      tag.object3D.getWorldPosition(_v);
      _v.y += tag.offsetY;
      _v.project(camera);
      const behind = _v.z > 1 || _v.z < -1;
      tag.el.hidden = behind;
      if (behind) continue;
      const x = (_v.x * 0.5 + 0.5) * w;
      const y = (-_v.y * 0.5 + 0.5) * h;
      tag.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    }
  }

  function clear() {
    for (const tag of [...own]) tag.remove();
  }

  return { add, update, clear, get usesLabels() {
    return useLabels;
  } };
}

const NULL_TAG = Object.freeze({
  el: null,
  setText() {},
  setTone() {},
  setVisible() {},
  visible: false,
  remove() {},
});

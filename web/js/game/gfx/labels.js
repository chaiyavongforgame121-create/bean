/**
 * gfx/labels.js — DOM elements pinned to 3D anchors (GAME-DESIGN §9.7, §9.8).
 *
 *   const labels = createLabels(camera, document.getElementById('chips'));
 *   const h = labels.anchor(plot.anchor, chipEl, { offsetY: 0.2, hideBehind: true, maxDistance: 112 });
 *   h.setVisible(false) · h.remove() · h.el · h.visible (last projected state)
 *   labels.update()        project every anchor (stage.js calls it once per rendered frame)
 *   labels.resize(w, h)    canvas CSS size (stage.js)
 *   labels.project(vec3)   → { x, y, visible, dist } in container px (floaters, tooltips)
 *   labels.setClip({ top, bottom })   HUD-covered bands (CSS px): anchors projecting under the top HUD, or well
 *                          under the bottom dock, are hidden instead of piling up behind the HUD (the dock and
 *                          list view still carry every number, J7) — except `pin: true` anchors (landmark signs:
 *                          the barn's account value is P0, §2.4), which are clamped to the band's edge and get
 *                          the class `is-pinned` (CSS draws a caret toward the landmark)
 *
 * All text stays in the DOM (translatable, crisp Thai, screen-reader friendly, J1): WebGL never draws text.
 *
 * Positioning contract (for WP5's CSS): the element is absolutely positioned at the container's top-left and
 * moved with `transform: translate3d(x, y, 0)` (CSSOM, CSP-safe). Its own centring/offset belongs in CSS via
 * the independent `translate` property (e.g. `.chip { translate: -50% -100%; }`), which does not fight the
 * transform. `z-index` is set from the distance so nearer chips stack on top. Culled elements get
 * `visibility: hidden` (no layout cost); writes are skipped when nothing changed.
 *
 * Anchors are Object3Ds (their world position; matrixWorld must be current — stage.js updates the scene
 * matrices before projecting) or plain {x, y, z} points. Chips are culled behind the camera and beyond 112 u.
 *
 * No three import: projection uses the camera's matrices directly.
 */

/**
 * maxDistance: §9.8 says 60 u, but the default views sit at d 50–70 (landscape, fitted to the HUD) and ≈ 63–90
 * (portrait), so 60 u would cull every plot chip at the default zoom and break J7 (risk always visible). The cull
 * distance therefore covers the widest zoom (90) plus the island radius (21).
 */
export const LABELS = Object.freeze({ maxDistance: 112, margin: 80, bandPx: 120, measureMs: 500, gutter: 16, edgePx: 240 });

/** Project world point (x, y, z) with a camera whose matrices are current. → { x, y, dist, behind } in px. */
export function projectPoint(camera, x, y, z, W, H) {
  const v = camera.matrixWorldInverse.elements;
  const vx = v[0] * x + v[4] * y + v[8] * z + v[12];
  const vy = v[1] * x + v[5] * y + v[9] * z + v[13];
  const vz = v[2] * x + v[6] * y + v[10] * z + v[14];
  const dist = Math.hypot(vx, vy, vz);
  if (vz > -(camera.near || 0.1)) return { x: 0, y: 0, dist, behind: true };
  const p = camera.projectionMatrix.elements;
  const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12];
  const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13];
  const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15] || 1;
  return { x: ((cx / cw + 1) / 2) * W, y: ((1 - cy / cw) / 2) * H, dist, behind: false };
}

export function createLabels(camera, container, { maxDistance = LABELS.maxDistance } = {}) {
  let W = Math.max(1, container?.clientWidth || globalThis.innerWidth || 1);
  let H = Math.max(1, container?.clientHeight || globalThis.innerHeight || 1);
  let allVisible = true;
  const clip = { top: 0, bottom: 0 };
  /** @type {Set<object>} */
  const anchors = new Set();

  function worldOf(a) {
    const o = a.target;
    if (o?.isObject3D && o.matrixWorld) {
      const e = o.matrixWorld.elements;
      return { x: e[12], y: e[13] + a.offsetY, z: e[14] };
    }
    if (o && Number.isFinite(o.x)) return { x: o.x, y: (o.y || 0) + a.offsetY, z: o.z || 0 };
    return null;
  }

  /**
   * Rendered height of a label (px), re-measured at most every 500 ms and only for labels near the top band,
   * so the per-frame cost stays a handful of cached reads (texts and languages change the height).
   */
  function heightOf(a) {
    const t = globalThis.performance?.now?.() ?? Date.now();
    if (a.h === undefined || t - a.hAt > LABELS.measureMs) {
      a.h = Number(a.el.offsetHeight) || 0;
      a.hAt = t;
    }
    return a.h;
  }

  /** Rendered width of a label (px), measured like heightOf() and only for labels near a side edge. */
  function widthOf(a) {
    const t = globalThis.performance?.now?.() ?? Date.now();
    if (a.w === undefined || t - a.wAt > LABELS.measureMs) {
      a.w = Number(a.el.offsetWidth) || 0;
      a.wAt = t;
    }
    return a.w;
  }

  function hide(a) {
    if (a.shown) {
      a.el.style.visibility = 'hidden';
      a.shown = false;
    }
    a.visible = false;
  }

  function place(a) {
    if (!a.wanted || !allVisible) return hide(a);
    const w = worldOf(a);
    if (!w) return hide(a);
    const p = projectPoint(camera, w.x, w.y, w.z, W, H);
    if ((p.behind && a.hideBehind) || p.dist > a.maxDistance) return hide(a);
    const m = LABELS.margin;
    if (p.x < -m || p.x > W + m || p.y < -m || p.y > H + m) return hide(a);
    // labels hang above their anchor (CSS `translate: -50% -100%`): one whose BODY would reach under the top
    // HUD band is hidden too, not only one whose anchor is there (the barn sign behind the money chips)
    let py = p.y;
    let pinned = false;
    if (a.pin) {
      // pinned: slide along the band's edge instead of vanishing (the label still sits at its landmark's x)
      const topEdge = clip.top + heightOf(a) + 4;
      if (clip.top > 0 && py < topEdge) {
        py = topEdge;
        pinned = true;
      }
      if (clip.bottom > 0 && py > H - clip.bottom - 4) {
        py = H - clip.bottom - 4;
        pinned = true;
      }
    } else {
      if (clip.top > 0 && p.y < clip.top + 6) return hide(a);
      if (clip.top > 0 && p.y < clip.top + LABELS.bandPx && p.y - heightOf(a) < clip.top) return hide(a);
      if (clip.bottom > 0 && p.y > H - clip.bottom + 28) return hide(a);
    }
    if (pinned !== a.pinned) {
      a.pinned = pinned;
      a.el.classList?.toggle?.('is-pinned', pinned);
    }
    // never leave the screen sideways: a label (centred on its anchor by CSS) keeps a 16 px gutter, so the phone's
    // edge landmarks (the stall, Pip's first-run hint, the ticker post) stay readable — it slides toward the centre
    let px = p.x;
    if (px < LABELS.edgePx || px > W - LABELS.edgePx) {
      const half = widthOf(a) / 2;
      if (half > 0 && W > 2 * (half + LABELS.gutter)) px = Math.min(W - LABELS.gutter - half, Math.max(LABELS.gutter + half, px));
    }
    const x = Math.round(px * 2) / 2;
    const y = Math.round(py * 2) / 2;
    if (x !== a.x || y !== a.y) {
      a.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      a.x = x;
      a.y = y;
    }
    const z = String(Math.max(1, 1000 - Math.round(p.dist * 10)));
    if (z !== a.z) {
      a.el.style.zIndex = z;
      a.z = z;
    }
    if (!a.shown) {
      a.el.style.visibility = '';
      a.shown = true;
    }
    a.visible = true;
    a.dist = p.dist;
  }

  function anchor(target, el, { offsetY = 0, hideBehind = true, maxDistance: md = maxDistance, pin = false } = {}) {
    if (!el) throw new TypeError('labels.anchor needs an element');
    if (container && el.parentNode !== container) container.appendChild(el);
    const st = el.style;
    if (st) {
      st.position = 'absolute';
      st.left = '0px';
      st.top = '0px';
      st.willChange = 'transform';
      st.visibility = 'hidden';
    }
    const a = { target, el, offsetY: Number(offsetY) || 0, hideBehind: hideBehind !== false, maxDistance: md, pin: !!pin, pinned: false, wanted: true, shown: false, visible: false, x: NaN, y: NaN, z: '', dist: Infinity };
    anchors.add(a);
    place(a);
    const handle = {
      el,
      remove() {
        anchors.delete(a);
        if (el.parentNode === container) el.remove();
      },
      setVisible(b) {
        a.wanted = !!b;
        place(a);
      },
      /** Re-target (e.g. a plot box rebuilt). */
      setTarget(t) {
        a.target = t;
        place(a);
      },
      setOffsetY(y) {
        a.offsetY = Number(y) || 0;
      },
      get visible() {
        return a.visible;
      },
      get dist() {
        return a.dist;
      },
    };
    return handle;
  }

  return {
    anchor,
    update() {
      for (const a of anchors) place(a);
    },
    resize(w, h) {
      W = Math.max(1, Math.round(w) || W);
      H = Math.max(1, Math.round(h) || H);
    },
    /** Project an arbitrary point (container px). */
    project(v) {
      const p = projectPoint(camera, Number(v?.x) || 0, Number(v?.y) || 0, Number(v?.z) || 0, W, H);
      return { x: p.x, y: p.y, dist: p.dist, visible: !p.behind && p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H };
    },
    setClip(r) {
      clip.top = Math.max(0, Number(r?.top) || 0);
      clip.bottom = Math.max(0, Number(r?.bottom) || 0);
    },
    /** Hide or show every anchor at once (context loss, classic overlay). */
    setEnabled(b) {
      allVisible = !!b;
      for (const a of anchors) place(a);
    },
    get size() {
      return { width: W, height: H };
    },
    get count() {
      return anchors.size;
    },
    container,
  };
}

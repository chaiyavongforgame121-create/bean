/**
 * gfx/renderer.js — the WebGLRenderer, sizing, DPR, shadow settings and context loss (GAME-DESIGN §7.5,
 * §7.6, §9.8).
 *
 *   const r = createRenderer({ canvas, quality, sizeEl });
 *   r.renderer                three WebGLRenderer (SRGB output, no tone mapping, manual shadow updates)
 *   r.resize() → {width, height, changed}   CSS size of `sizeEl` (falls back to the window)
 *   r.setQuality(q)           DPR cap + shadow type/enable (tiers.js Quality); → { shadowsChanged }
 *   r.onContextLost(fn) / r.onContextRestored(fn) → off
 *   r.dispose()
 *
 * Shadows: `shadowMap.autoUpdate = false`; stage.js sets `needsUpdate` every frame on High, every 2nd frame
 * on Medium, never on Low (Low uses blob decals provided by the world/field). Changing the shadow type or
 * switching shadows off needs a material recompile, which stage.js triggers (`needsUpdate` on materials).
 */

import { WebGLRenderer, SRGBColorSpace, NoToneMapping, PCFSoftShadowMap, PCFShadowMap } from '../three.js';

export function createRenderer({ canvas, quality, sizeEl = canvas?.parentElement, win = globalThis.window } = {}) {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: quality?.antialias !== false,
    powerPreference: 'high-performance',
    alpha: false,
    stencil: false,
    depth: true,
    preserveDrawingBuffer: false,
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.shadowMap.autoUpdate = false;
  // stage.js resets the counters once per frame, so the post pass does not hide the scene's draw calls
  renderer.info.autoReset = false;

  let width = 0;
  let height = 0;
  let dpr = 0;
  let shadowsKey = '';
  const lost = new Set();
  const restored = new Set();

  function screenDpr() {
    return Math.max(1, Number(win?.devicePixelRatio) || 1);
  }

  function setQuality(q) {
    const nextDpr = Math.min(screenDpr(), Number(q?.dpr) || 1);
    if (nextDpr !== dpr) {
      dpr = nextDpr;
      renderer.setPixelRatio(dpr);
      if (width && height) renderer.setSize(width, height, false);
    }
    const shadows = q?.shadows || 'off';
    const key = shadows;
    const shadowsChanged = key !== shadowsKey;
    if (shadowsChanged) {
      shadowsKey = key;
      renderer.shadowMap.enabled = shadows !== 'off';
      renderer.shadowMap.type = shadows === 'soft' ? PCFSoftShadowMap : PCFShadowMap;
      renderer.shadowMap.needsUpdate = true;
    }
    return { shadowsChanged };
  }

  // The canvas fills its positioned container (game.css: #stage is fixed to the viewport). If no stylesheet
  // positions it, pin it with CSSOM so its own height can never feed back into the container's height.
  try {
    const cs = win?.getComputedStyle?.(canvas);
    if (!cs || cs.position === 'static') {
      Object.assign(canvas.style, { position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%', display: 'block' });
    }
  } catch {
    /* no CSSOM */
  }

  /** Container size: a positioned container's box, else the viewport (a static container is content-sized). */
  function measure() {
    let w = 0;
    let h = 0;
    try {
      const pos = sizeEl && win?.getComputedStyle ? win.getComputedStyle(sizeEl).position : 'static';
      if (pos !== 'static') {
        w = Math.round(sizeEl.clientWidth || 0);
        h = Math.round(sizeEl.clientHeight || 0);
      }
    } catch {
      /* measure the window */
    }
    if (w < 2 || h < 2) {
      const de = win?.document?.documentElement;
      w = Math.round(de?.clientWidth || win?.innerWidth || 800);
      h = Math.round(de?.clientHeight || win?.innerHeight || 600);
    }
    return { w, h };
  }

  /** Measure the stage and resize the drawing buffer (the CSS size comes from the stylesheet / 100%). */
  function resize() {
    const { w, h } = measure();
    const changed = w !== width || h !== height;
    if (changed) {
      width = w;
      height = h;
      renderer.setSize(w, h, false);
    }
    return { width, height, changed };
  }

  const onLost = (e) => {
    e.preventDefault();
    for (const fn of [...lost]) fn(e);
  };
  const onRestored = (e) => {
    for (const fn of [...restored]) fn(e);
  };
  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);

  setQuality(quality);
  resize();

  return {
    renderer,
    setQuality,
    resize,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get dpr() {
      return dpr;
    },
    onContextLost(fn) {
      lost.add(fn);
      return () => lost.delete(fn);
    },
    onContextRestored(fn) {
      restored.add(fn);
      return () => restored.delete(fn);
    },
    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      lost.clear();
      restored.clear();
      renderer.setAnimationLoop(null);
      renderer.dispose();
    },
  };
}

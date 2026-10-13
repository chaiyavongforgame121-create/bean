/**
 * gfx/loop.js — the frame loop: continuous / on-demand rendering, FPS cap, pause, stats, ?debug=1 overlay
 * (GAME-DESIGN §7.3, §9.9).
 *
 *   const loop = createLoop({ renderer, frame, now });
 *   frame(dtSec, tSec, info) → { busy: boolean, ambient: boolean }   (stage.js: update everything + render)
 *   loop.start() · loop.stop() · loop.setMode('continuous'|'demand') · loop.requestRender()
 *   loop.keepAlive(ms)       stay awake for a while (fades the executor runs on its own clock)
 *   loop.setFpsCap(30|60)    30 = render every other display frame
 *   loop.pause(b)            context lost: no frames at all until resumed
 *   loop.stats               { fps, frameMs, cpuMs, renders, mode, idle }
 *   loop.onFrame(fn) → off   after every rendered frame (governor sampling, debug overlay)
 *
 * Modes:
 *   continuous  render every frame (ambient motion: grass, clouds, windmill, critters);
 *   demand      render only after requestRender()/input/data, then keep going while `busy` (tweens, camera
 *               flights, effects), then STOP the animation loop: 0 renders per second when nothing changes.
 *               Reduced motion always uses demand; continuous also drops to idle when the frame reports
 *               `ambient: false` and nothing was busy for 5 s.
 * The loop pauses while document.hidden. dt is clamped to 50 ms.
 */

export const LOOP = Object.freeze({ maxDtMs: 50, idleAfterMs: 5000, wakeMs: 250 });

export function createLoop({ renderer, frame, now = () => performance.now(), doc = globalThis.document } = {}) {
  let mode = 'continuous';
  let running = false; // start() called and not stopped
  let armed = false; // animation loop currently installed
  let paused = false;
  let fpsCap = 60;
  let lastTs = null;
  let lastRenderTs = null;
  let awakeUntil = 0;
  let quietSince = null;
  const listeners = new Set();
  const stats = { fps: 0, frameMs: 0, cpuMs: 0, renders: 0, mode, idle: false, periodMs: 0 };
  let fpsCount = 0;
  let fpsT0 = null;

  const visible = () => !doc || doc.visibilityState !== 'hidden';

  function arm() {
    if (armed || !running || paused || !visible()) return;
    armed = true;
    stats.idle = false;
    lastTs = null;
    renderer.setAnimationLoop(tick);
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    stats.idle = true;
    renderer.setAnimationLoop(null);
  }

  function tick(ts) {
    const t = Number.isFinite(ts) ? ts : now();
    if (lastTs === null) lastTs = t - 16.7;
    // FPS cap: skip display frames until the cap interval has passed (4 ms slack for vsync jitter)
    if (fpsCap < 60 && lastRenderTs !== null && t - lastRenderTs < 1000 / fpsCap - 4) return;
    const dtMs = Math.min(LOOP.maxDtMs, Math.max(0, t - lastTs));
    lastTs = t;
    const period = lastRenderTs === null ? null : t - lastRenderTs;
    lastRenderTs = t;

    const c0 = now();
    let res;
    try {
      res = frame(dtMs / 1000, t / 1000, { dtMs, period, mode }) || {};
    } catch (e) {
      globalThis.console?.error?.('frame failed', e);
      res = {};
    }
    const cpu = now() - c0;
    stats.cpuMs = stats.cpuMs ? stats.cpuMs * 0.9 + cpu * 0.1 : cpu;
    stats.frameMs = period ?? stats.frameMs;
    stats.periodMs = period ?? 0;
    stats.renders++;
    fpsCount++;
    if (fpsT0 === null) fpsT0 = t;
    if (t - fpsT0 >= 1000) {
      stats.fps = (fpsCount * 1000) / (t - fpsT0);
      fpsCount = 0;
      fpsT0 = t;
    }
    for (const fn of [...listeners]) {
      try {
        fn({ t, dtMs, period, cpuMs: cpu, mode, busy: !!res.busy });
      } catch (e) {
        globalThis.console?.error?.('loop listener failed', e);
      }
    }

    // decide whether to keep the animation loop installed
    const busy = !!res.busy || t < awakeUntil;
    if (busy) quietSince = null;
    else if (quietSince === null) quietSince = t;
    if (mode === 'demand') {
      if (!busy) disarm();
    } else if (res.ambient === false && !busy && quietSince !== null && t - quietSince > LOOP.idleAfterMs) {
      disarm();
    }
  }

  function onVisibility() {
    if (visible()) {
      lastRenderTs = null;
      arm();
    } else disarm();
  }
  doc?.addEventListener?.('visibilitychange', onVisibility);

  return {
    start() {
      running = true;
      arm();
    },
    stop() {
      running = false;
      disarm();
    },
    /** 'continuous' | 'demand' */
    setMode(m) {
      mode = m === 'demand' ? 'demand' : 'continuous';
      stats.mode = mode;
      if (mode === 'continuous') arm();
      else this.requestRender();
    },
    get mode() {
      return mode;
    },
    /** Render at least one more frame (data changed, input, resize…). */
    requestRender() {
      awakeUntil = Math.max(awakeUntil, now() + 1);
      quietSince = null;
      arm();
    },
    /** Keep rendering for `ms` (an effect running on its own clock). */
    keepAlive(ms = LOOP.wakeMs) {
      awakeUntil = Math.max(awakeUntil, now() + Math.max(0, Number(ms) || 0));
      quietSince = null;
      arm();
    },
    setFpsCap(fps) {
      fpsCap = Number(fps) >= 60 ? 60 : Math.max(10, Number(fps) || 30);
    },
    get fpsCap() {
      return fpsCap;
    },
    pause(b) {
      paused = !!b;
      if (paused) disarm();
      else arm();
    },
    get paused() {
      return paused;
    },
    get armed() {
      return armed;
    },
    onFrame(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stats,
    dispose() {
      running = false;
      disarm();
      listeners.clear();
      doc?.removeEventListener?.('visibilitychange', onVisibility);
    },
  };
}

/**
 * ?debug=1 overlay: fps, frame ms, draw calls, triangles, tier, governor steps, marks age (§9.9).
 * `read()` returns the lines; the overlay refreshes twice per second. → { el, dispose() }
 */
export function createDebugOverlay(read, { doc = globalThis.document } = {}) {
  if (!doc?.createElement) return { el: null, dispose() {} };
  const el = doc.createElement('pre');
  el.id = 'gameDebug';
  el.setAttribute('aria-hidden', 'true');
  const s = el.style;
  s.position = 'fixed';
  s.left = '8px';
  s.bottom = '8px';
  s.zIndex = '9999';
  s.margin = '0';
  s.padding = '6px 8px';
  s.font = '11px/1.35 ui-monospace, Consolas, monospace';
  s.color = '#fffef6';
  s.background = 'rgba(30, 24, 20, 0.72)';
  s.borderRadius = '8px';
  s.pointerEvents = 'none';
  s.whiteSpace = 'pre';
  doc.body.appendChild(el);
  const timer = setInterval(() => {
    try {
      el.textContent = read().join('\n');
    } catch (e) {
      el.textContent = String(e?.message || e);
    }
  }, 500);
  return {
    el,
    dispose() {
      clearInterval(timer);
      el.remove();
    },
  };
}

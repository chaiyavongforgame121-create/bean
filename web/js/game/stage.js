/**
 * stage.js — the dynamic-import entry for everything that needs three (GAME-DESIGN §9.6 step 2, §9.7, §9.9).
 *
 *   const stage = await createStage({ store, bus, canvas, settings, sfx, software, overlay });
 *   → { scene, camera, renderer, rig, picker, labels, fxLabels, loop, world, field, fx, quality(),
 *       plotPosition(slot), requestRender(), syncViews(views, count), setReduced(b), setQuality(q),
 *       info(), dispose() }
 *
 * It builds the renderer (tier from Settings → Auto), the camera rig, picking, DOM label projectors, then
 * the World (WP3 `world/world.js`), the Field (WP4 `field/field.js`) and the effect executor
 * (WP4 `fx/executor.js`). Each of those is imported defensively: if a package is missing or throws, a small
 * placeholder takes its place so the page still boots (and the integrator sees a console warning).
 *
 * Per frame (§9.9 order): input (event-driven) → rig → tweens/springs → field → fx → world ambience (+ bar
 * progress) → labels → shadow decision → render (MSAA post pass on High). Store data is pushed into the
 * World with its setters (weather, wind, money levels, sundial, halted, unread, daylight, feed look).
 * Rendering is on demand under reduced motion (0 renders per second when nothing changes).
 */

import * as THREE from './three.js';
import { createRenderer } from './gfx/renderer.js';
import { createLoop, createDebugOverlay } from './gfx/loop.js';
import { resolveTier, qualityFor, stepDown, createGovernor, budgetMs, integratedGpu } from './gfx/tiers.js';
import { createRig, lensOf } from './gfx/camera.js';
import { createPicker } from './gfx/picking.js';
import { createLabels } from './gfx/labels.js';
import { tweens } from './gfx/tween.js';
import { createPost } from './gfx/post.js';
import { slotXZ, moneyView, closedTotals, marksAge, fmtAge } from './core/view.js';
import { coarsePointer } from './core/settings.js';

const warn = (...a) => globalThis.console?.warn?.('[stage]', ...a);

/** Call an optional method of a package object; a missing or throwing hook never breaks the frame. */
function call(obj, name, ...args) {
  const fn = obj?.[name];
  if (typeof fn !== 'function') return undefined;
  try {
    return fn.apply(obj, args);
  } catch (e) {
    warn(`${name}() failed`, e);
    return undefined;
  }
}

// ------------------------------------------------------------------ placeholders (only when a package fails)

/** A plain island so the page stays usable if world/world.js is missing (WP3 replaces it entirely). */
function placeholderWorld(scene) {
  scene.background = new THREE.Color('#9ED3EE');
  scene.fog = new THREE.Fog('#FFE6CF', 90, 220);
  const hemi = new THREE.HemisphereLight('#DFF1FF', '#E9D9C0', 0.9);
  const sun = new THREE.DirectionalLight('#FFF1DC', 1.6);
  sun.position.set(-18, 34, 22);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 24, bottom: -24, near: 1, far: 90 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  const top = new THREE.Mesh(new THREE.CylinderGeometry(21, 20, 1.2, 64), new THREE.MeshLambertMaterial({ color: '#A8D88E' }));
  top.position.y = -0.6;
  top.receiveShadow = true;
  const under = new THREE.Mesh(new THREE.ConeGeometry(20, 8.4, 48), new THREE.MeshLambertMaterial({ color: '#C9B8A6' }));
  under.position.y = -5.4;
  under.rotation.x = Math.PI;
  const group = new THREE.Group();
  group.name = 'placeholder-world';
  group.add(hemi, sun, top, under);
  scene.add(group);
  const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
  return {
    placeholder: true,
    landmarks: new Map(),
    slotPosition: (i, count) => {
      const p = slotXZ(i, count);
      return v3(p.x, 0, p.z);
    },
    standPoint: (i, count) => {
      const p = slotXZ(i, count);
      return v3(p.x, 0, p.z + 2.3);
    },
    farmer: null,
    update() {},
    rebuild() {},
    dispose() {
      scene.remove(group);
    },
  };
}

/** Plain boxes with pick proxies and chip anchors, so selection/plant flows work without WP4's field. */
function placeholderField({ scene, world, picker }) {
  const group = new THREE.Group();
  group.name = 'placeholder-field';
  scene.add(group);
  const boxGeo = new THREE.BoxGeometry(3.4, 0.45, 3.4);
  const proxyGeo = new THREE.BoxGeometry(3.6, 2.4, 3.6);
  const plantGeo = new THREE.IcosahedronGeometry(0.9, 1);
  const wood = new THREE.MeshLambertMaterial({ color: '#C98A4B' });
  const glow = new THREE.MeshLambertMaterial({ color: '#E8C27A', emissive: '#6B4423', emissiveIntensity: 0.25 });
  const leaf = new THREE.MeshLambertMaterial({ color: '#62BC5C' });
  const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
  const plots = new Map();
  let count = 0;
  let pick = false;

  function build(n) {
    for (const p of plots.values()) {
      group.remove(p.object3D);
      p.off();
    }
    plots.clear();
    count = n;
    for (let i = 0; i < n; i++) {
      const o = new THREE.Group();
      const pos = world.slotPosition(i, n);
      o.position.set(pos.x, 0, pos.z);
      const box = new THREE.Mesh(boxGeo, wood);
      box.position.y = 0.225;
      box.castShadow = box.receiveShadow = true;
      const plant = new THREE.Mesh(plantGeo, leaf);
      plant.position.y = 1.1;
      plant.castShadow = true;
      plant.visible = false;
      const proxy = new THREE.Mesh(proxyGeo, proxyMat);
      proxy.position.y = 1.2;
      const anchor = new THREE.Object3D();
      anchor.position.y = 2.6;
      o.add(box, plant, proxy, anchor);
      group.add(o);
      o.updateMatrixWorld(true);
      const off = picker.register(proxy, { type: 'plot', slot: i });
      plots.set(i, { slot: i, object3D: o, anchor, proxy, box, plant, view: null, fsm: null, off, play: async () => {}, setView() {} });
    }
  }

  return {
    placeholder: true,
    sync(views, n) {
      if (n !== count) build(n);
      for (const p of plots.values()) {
        const v = views?.[p.slot] || null;
        p.view = v;
        p.plant.visible = !!v;
        if (v) p.plant.scale.setScalar(0.35 + 0.65 * (Number(v.size) || 0.3));
        p.box.material = pick && !v ? glow : wood;
      }
    },
    plot: (slot) => plots.get(slot) || null,
    setPickMode(on) {
      pick = !!on;
      for (const p of plots.values()) p.box.material = pick && !p.view ? glow : wood;
    },
    setHover() {},
    setSelected() {},
    setDim() {},
    update() {},
    rebuild() {},
    dispose() {
      for (const p of plots.values()) p.off();
      scene.remove(group);
    },
  };
}

/** Executor stand-in: forwards the world-level effects so the windmill/weather still react. */
function fallbackFx(world) {
  return {
    placeholder: true,
    run(effects) {
      for (const e of effects || []) {
        if (e.kind === 'tick') call(world, 'kickWindmill');
        else if (e.kind === 'gust') call(world, 'gust', e);
        else if (e.kind === 'feedLook') call(world, 'setFeedLook', e.meta?.state);
      }
    },
    update() {},
    clear() {},
    rebuild() {},
  };
}

/** Import a package module; → null (and a warning) when it is missing or broken. */
async function tryImport(path) {
  try {
    return await import(path);
  } catch (e) {
    warn(`${path} unavailable — using a placeholder`, e);
    return null;
  }
}

// ------------------------------------------------------------------ the stage

/** What the field draws from a views map, minus the clock-only fields (mark age in ms, update time). */
function viewsSignature(views, count) {
  try {
    return `${count}|${JSON.stringify(views || {}, (k, v) => (k === 'markMs' || k === 'updatedMs' ? undefined : v))}`;
  } catch {
    return String(Math.random()); // unserialisable: always render
  }
}

export async function createStage({ store, bus, canvas, settings, sfx = null, software = false, overlay = null, debug = false } = {}) {
  let lastViewsSig = '';
  const timing = { start: performance.now(), worldMs: 0, fieldMs: 0, fxMs: 0, readyMs: 0, firstFrameMs: 0 };
  const settingsOf = () => (typeof settings?.get === 'function' ? settings.get() : store.get().settings || settings || {});
  // packages accept the live settings controller ({ get(), reduced() }) or a plain snapshot
  const settingsArg = typeof settings?.get === 'function' ? settings : settingsOf();
  const loopRef = { current: null };
  const requestRenderLater = () => loopRef.current?.requestRender();
  const coarse = coarsePointer();
  const env = {
    coarse,
    deviceMemory: globalThis.navigator?.deviceMemory ?? null,
    software,
    devicePixelRatio: globalThis.devicePixelRatio || 1,
  };
  let quality = qualityFor(resolveTier(settingsOf().graphics, env), env);
  let reduced = !!store.get().ui?.reduced;

  // ---- renderer, scene, camera
  const r = createRenderer({ canvas, quality, sizeEl: canvas.parentElement });
  const renderer = r.renderer;
  // Auto on an integrated / mobile GPU starts at Medium (High misses its frame budget there, §7.5, acc. #11)
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    env.integrated = integratedGpu(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const tier = resolveTier(settingsOf().graphics, env);
    if (tier !== quality.tier) {
      quality = qualityFor(tier, env);
      r.setQuality(quality);
    }
  } catch {
    /* keep the first guess */
  }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, r.width / Math.max(1, r.height), 0.5, 300);
  const rig = createRig(camera, canvas, { portrait: lensOf(r.width / Math.max(1, r.height)) === 'portrait', reduced, fadeEl: canvas });
  rig.resize(r.width, r.height);
  const picker = createPicker(camera, canvas);
  const chipsEl = globalThis.document?.getElementById('chips') || canvas.parentElement;
  const fxEl = globalThis.document?.getElementById('fx') || canvas.parentElement;
  const labels = createLabels(camera, chipsEl);
  const fxLabels = createLabels(camera, fxEl);
  labels.resize(r.width, r.height);
  fxLabels.resize(r.width, r.height);
  let post = null;

  // ---- world (WP3)
  let world = null;
  let tMark = performance.now();
  const worldMod = await tryImport('./world/world.js');
  if (worldMod?.buildWorld) {
    try {
      world = await worldMod.buildWorld({ scene, tier: quality.tier, quality, settings: settingsArg, requestRender: requestRenderLater, renderer, camera, bus });
    } catch (e) {
      warn('buildWorld failed — using a placeholder', e);
    }
  }
  if (!world) world = placeholderWorld(scene);
  timing.worldMs = performance.now() - tMark;
  if (typeof world.slotPosition !== 'function') {
    world.slotPosition = (i, count) => {
      const p = slotXZ(i, count);
      return new THREE.Vector3(p.x, 0, p.z);
    };
  }
  const landmarkOffs = [];
  if (world.landmarks && typeof world.landmarks.forEach === 'function') {
    world.landmarks.forEach((lm, id) => {
      if (lm?.proxy) landmarkOffs.push(picker.register(lm.proxy, { type: 'landmark', id: lm.id ?? id }));
    });
  }

  // ---- field (WP4)
  let field = null;
  tMark = performance.now();
  const fieldMod = await tryImport('./field/field.js');
  if (fieldMod?.createField) {
    try {
      field = await fieldMod.createField({ scene, world, picker, labels, tier: quality, quality, settings: settingsArg, bus, camera, container: chipsEl });
    } catch (e) {
      warn('createField failed — using a placeholder', e);
    }
  }
  if (!field) field = placeholderField({ scene, world, picker });
  timing.fieldMs = performance.now() - tMark;

  // ---- effect executor (WP4)
  let fx = null;
  tMark = performance.now();
  const fxMod = await tryImport('./fx/executor.js');
  if (fxMod?.createFx) {
    try {
      fx = await fxMod.createFx({ scene, field, world, labels: fxLabels, chipLabels: labels, sfx, bus, settings: settingsArg, camera, container: fxEl, renderer, quality, tweens, store, requestRender: requestRenderLater });
    } catch (e) {
      warn('createFx failed — effects fall back to world hooks only', e);
    }
  }
  if (!fx) fx = fallbackFx(world);
  timing.fxMs = performance.now() - tMark;

  // ---- quality
  const governor = createGovernor();

  function markMaterialsDirty() {
    scene.traverse((o) => {
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x && (x.needsUpdate = true));
      else if (m) m.needsUpdate = true;
    });
  }

  function applyQuality(q, { step = null, auto = false } = {}) {
    quality = q;
    const { shadowsChanged } = r.setQuality(q);
    if (shadowsChanged) markMaterialsDirty();
    if (q.post && !post) {
      try {
        post = createPost(renderer);
        const sz = renderer.getDrawingBufferSize(new THREE.Vector2());
        post.setSize(sz.x, sz.y, r.dpr);
      } catch (e) {
        warn('post pass unavailable', e);
        post = null;
      }
    } else if (!q.post && post) {
      post.dispose();
      post = null;
    }
    loop.setFpsCap(q.fps);
    call(world, 'setQuality', q);
    call(field, 'setQuality', q);
    call(fx, 'setQuality', q);
    store.update('ui', { tier: q.tier });
    bus.emit('quality', { tier: q.tier, quality: q, step, state: step ? 'lowered' : 'set', reason: step ? 'governor' : 'settings', auto });
    loop.requestRender();
  }

  // ---- frame
  let frameNo = 0;
  let firstFrame = true;
  const tmpV = new THREE.Vector3();

  function barProgress() {
    const s = store.get();
    const next = Number(s.feed?.nextTickMs);
    const tick = Number(s.feed?.tickMs) || Number(s.health?.daemon?.tick_ms) || (s.feed?.prices === 'real' ? 60_000 : 0);
    if (!Number.isFinite(next) || !(tick > 0)) return null;
    const nowS = Date.now() + (s.net?.skewMs || 0);
    return Math.min(1, Math.max(0, 1 - (next - nowS) / tick));
  }

  function frame(dt, t, info) {
    const dtMs = dt * 1000;
    renderer.info.reset();
    const camMoving = rig.update(dtMs);
    const tweening = tweens.update(dtMs);
    call(field, 'update', dt, t);
    call(fx, 'update', dt, t);
    const p = barProgress();
    if (p !== null) call(world, 'setBarProgress', p);
    call(world, 'update', dt, t);

    scene.updateMatrixWorld();
    // chips and signs never pile up under the HUD bands (the dock still carries every number)
    const safe = rig.getSafeArea();
    labels.setClip(safe);
    fxLabels.setClip({ top: safe.top, bottom: 0 });
    labels.update();
    fxLabels.update();

    // shadows: every frame on High, every 2nd on Medium, never on Low; demand mode refreshes each render
    if (quality.shadows !== 'off') {
      const every = info?.mode === 'demand' ? 1 : Math.max(1, quality.shadowEvery || 1);
      if (frameNo % every === 0) renderer.shadowMap.needsUpdate = true;
    }
    frameNo++;

    if (post) {
      const target = rig.getState().target;
      const pr = labels.project(tmpV.set(target.x, target.y, target.z));
      post.render(scene, camera, { focusY: 1 - pr.y / Math.max(1, r.height) });
    } else renderer.render(scene, camera);

    if (firstFrame) {
      firstFrame = false;
      timing.firstFrameMs = performance.now() - timing.start;
      bus.emit('stage:firstFrame', { ms: performance.now(), sinceStageMs: timing.firstFrameMs });
    }
    const busy = camMoving || tweening || !!call(fx, 'busy') || !!call(field, 'busy') || !!call(world, 'busy');
    return { busy, ambient: !reduced };
  }

  const loop = createLoop({ renderer, frame });
  loopRef.current = loop;
  // Only judge frames while the page is in front of the player: a background or unfocused window may have its
  // animation frames throttled by the browser, which says nothing about the GPU.
  const watched = () => {
    const d = globalThis.document;
    return !d || (d.visibilityState === 'visible' && (typeof d.hasFocus !== 'function' || d.hasFocus()));
  };
  loop.onFrame(({ period, t, mode }) => {
    if (mode !== 'continuous' || period === null || !watched()) return;
    if (governor.sample(period, t, budgetMs(quality))) {
      const s = stepDown(quality);
      if (s) applyQuality(s.quality, { step: s.step, auto: true });
    }
  });
  rig.onChange(() => loop.requestRender());

  // ---- sizing
  function resize() {
    const { width, height, changed } = r.resize();
    if (!changed) return;
    rig.resize(width, height);
    labels.resize(width, height);
    fxLabels.resize(width, height);
    if (post) {
      const sz = renderer.getDrawingBufferSize(new THREE.Vector2());
      post.setSize(sz.x, sz.y, r.dpr);
    }
    call(world, 'resize', width, height);
    loop.requestRender();
  }
  let ro = null;
  if (typeof globalThis.ResizeObserver === 'function') {
    ro = new ResizeObserver(() => resize());
    ro.observe(canvas.parentElement || canvas);
  }
  globalThis.addEventListener?.('resize', resize);

  // ---- store → world (state setters; effects come through the director/executor)
  const offs = [];
  const watch = (sel, fn, eq) => {
    offs.push(store.select(sel, (v, prev) => {
      try {
        fn(v, prev);
      } catch (e) {
        warn('world sync failed', e);
      }
      loop.requestRender();
    }, eq));
    try {
      fn(sel(store.get()), undefined);
    } catch (e) {
      warn('world sync failed', e);
    }
  };
  watch((s) => s.market?.weather?.key ?? null, () => {
    const w = store.get().market?.weather;
    if (w) call(world, 'setWeather', w);
  });
  watch((s) => s.market?.wind?.factor ?? null, (f) => {
    if (f !== null) call(world, 'setWind', reduced ? 0 : f);
  });
  const moneyKey = (s) => {
    const m = moneyView(s.live, s.marks);
    const c = closedTotals(s.bots);
    return [m.fills.tower.toFixed(3), m.fills.pond.toFixed(3), m.fills.silo.toFixed(3), c.crates.n, c.compost.n].join('|');
  };
  watch(moneyKey, () => {
    const s = store.get();
    const m = moneyView(s.live, s.marks);
    const c = closedTotals(s.bots);
    call(world, 'setMoney', { towerFill: m.fills.tower, pondFill: m.fills.pond, siloFill: m.fills.silo, crates: { n: c.crates.n, usd: c.crates.usd }, compost: { n: c.compost.n, usd: c.compost.usd } });
  });
  watch((s) => s.feed?.prices === 'sim', (sim) => call(world, 'setSundial', !!sim));
  watch((s) => s.feed?.state ?? null, (state) => state && call(world, 'setFeedLook', state));
  watch((s) => !!s.live?.halted, (h) => call(world, 'setHalted', h));
  watch((s) => s.ui?.unread || 0, (n) => call(world, 'setUnread', n));
  const daylight = () => {
    const s = store.get();
    const mode = s.settings?.sky === 'clock' ? 'clock' : 'day';
    // simulated prices follow market time; real prices follow the wall clock (server-relative)
    const tMs = s.feed?.prices === 'sim' ? Number(s.health?.market_time_ms) || Date.now() : Date.now() + (s.net?.skewMs || 0);
    call(world, 'setDaylight', mode, tMs);
  };
  watch((s) => `${s.settings?.sky}|${s.feed?.prices}`, daylight);
  const dayTimer = setInterval(() => {
    if (store.get().settings?.sky === 'clock') {
      daylight();
      loop.requestRender();
    }
  }, 60_000);

  // the seed stall shows the shelf's top 5 coins (one sachet per coin, §2.4)
  const stallCoins = (s) => (s.shelf?.rows || []).slice(0, 5).map((r) => r?.coin ?? null).join(',');
  watch(stallCoins, (key) => {
    const coins = key ? key.split(',').map((c) => c || null) : [];
    call(world.landmarks?.get?.('stall'), 'setState', { coins });
  });

  // sound hooks owned by the world: distant thunder after a far-sky flash; crickets under a night sky (§8)
  if (sfx) {
    const offLightning = call(world, 'onLightning', (e) => {
      setTimeout(() => call(sfx, 'play', 'thunder'), Math.max(0, Number(e?.thunderInMs) || 1500));
    });
    if (typeof offLightning === 'function') offs.push(offLightning);
  }
  let nightNow = null;
  const nightTimer = setInterval(() => {
    const night = store.get().settings?.sky === 'clock' && Number(world.sky?.night) > 0.5;
    if (night !== nightNow) {
      nightNow = night;
      call(sfx, 'setNight', night);
    }
  }, 5_000);

  // ---- settings → systems
  function setReduced(b) {
    reduced = !!b;
    tweens.setMotionScale(reduced ? 0 : 1);
    rig.setReduced(reduced);
    loop.setMode(reduced ? 'demand' : 'continuous');
    call(world, 'setReduced', reduced);
    call(field, 'setReduced', reduced);
    call(fx, 'setReduced', reduced);
    const w = store.get().market?.wind;
    if (w) call(world, 'setWind', reduced ? 0 : w.factor);
    loop.requestRender();
  }

  offs.push(bus.on('settings', ({ settings: s, changed = [] } = {}) => {
    if (!s) return;
    if (changed.includes('graphics')) {
      governor.reset(performance.now());
      applyQuality(qualityFor(resolveTier(s.graphics, env), env));
    }
    if (changed.includes('drift')) rig.setDrift(!!s.drift);
    if (changed.includes('farmer')) call(world.farmer, 'setEnabled', !!s.farmer);
    call(world, 'setSettings', s);
    call(field, 'setSettings', s);
    call(fx, 'setSettings', s);
    loop.requestRender();
  }));
  offs.push(store.select((s) => !!s.ui?.reduced, (b) => setReduced(b)));
  offs.push(bus.on('data:marks', () => loop.requestRender()));
  offs.push(bus.on('game:event', () => loop.keepAlive(400)));

  // ---- context loss (§7.6)
  let lostAt = 0;
  let lastLoss = -Infinity;
  let failTimer = null;
  let failedShown = false;
  const failed = () => {
    failedShown = true;
    overlay?.show?.('g.boot.contextFailed', { actions: true });
    loop.pause(true);
  };
  offs.push(r.onContextLost(() => {
    const t0 = performance.now();
    const second = t0 - lastLoss < 60_000;
    lastLoss = t0;
    lostAt = t0;
    loop.pause(true);
    labels.setEnabled(false);
    fxLabels.setEnabled(false);
    if (second) return failed();
    overlay?.show?.('g.boot.contextLost', { actions: false });
    clearTimeout(failTimer);
    failTimer = setTimeout(failed, 5000);
  }));
  offs.push(r.onContextRestored(() => {
    clearTimeout(failTimer);
    // §7.6: once the failure card is up (no restore within 5 s, or a second loss within 60 s) it stays — the
    // player chooses "Try again" or the classic garden; a late restore must not hide it behind their back
    if (failedShown) return;
    call(world, 'rebuild');
    call(field, 'rebuild');
    call(fx, 'rebuild');
    if (post) {
      post.dispose();
      post = createPost(renderer);
      const sz = renderer.getDrawingBufferSize(new THREE.Vector2());
      post.setSize(sz.x, sz.y, r.dpr);
    }
    markMaterialsDirty();
    renderer.shadowMap.needsUpdate = true;
    labels.setEnabled(true);
    fxLabels.setEnabled(true);
    overlay?.hide?.();
    loop.pause(false);
    loop.requestRender();
  }));

  // ---- debug overlay (?debug=1)
  let dbg = null;
  if (debug) {
    dbg = createDebugOverlay(() => {
      const s = store.get();
      const st = loop.stats;
      const age = marksAge(s.marks, Date.now() + (s.net?.skewMs || 0));
      return [
        `fps ${st.fps.toFixed(1)}  frame ${st.frameMs.toFixed(1)} ms  js ${st.cpuMs.toFixed(2)} ms`,
        `draw ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}  geo ${renderer.info.memory.geometries}  tex ${renderer.info.memory.textures}`,
        `tier ${quality.tier}  dpr ${r.dpr}  shadows ${quality.shadows}  post ${post ? 'on' : 'off'}  fps cap ${loop.fpsCap}`,
        `governor steps ${quality.steps.join(', ') || '—'}  mean ${governor.mean().toFixed(1)} ms`,
        `loop ${loop.mode}${loop.armed ? '' : ' (idle)'}  renders ${st.renders}`,
        `marks ${age === null ? '—' : fmtAge(age)}  stream ${s.net?.stream}  skew ${s.net?.skewMs ?? 0} ms`,
        `world ${world.placeholder ? 'placeholder' : 'ok'}  field ${field.placeholder ? 'placeholder' : 'ok'}  fx ${fx.placeholder ? 'fallback' : 'ok'}`,
        `build world ${timing.worldMs.toFixed(0)} ms  field ${timing.fieldMs.toFixed(0)} ms  fx ${timing.fxMs.toFixed(0)} ms  first frame ${timing.firstFrameMs.toFixed(0)} ms`,
      ];
    });
  }

  // ---- go
  applyQuality(quality);
  setReduced(reduced);
  rig.setDrift(!!settingsOf().drift);
  loop.start();
  loop.requestRender();
  timing.readyMs = performance.now() - timing.start;

  function plotPosition(slot) {
    const count = store.get().slots?.count || 10;
    const p = world.slotPosition(slot, count);
    return { x: p.x, y: p.y ?? 0, z: p.z };
  }

  const stage = {
    scene,
    camera,
    renderer,
    rig,
    picker,
    labels,
    fxLabels,
    loop,
    world,
    field,
    fx,
    governor,
    quality: () => quality,
    setQuality: (q) => applyQuality(q),
    setReduced,
    plotPosition,
    requestRender: () => loop.requestRender(),
    /** Push plot views into the field (main.js calls this after every views recompute). */
    syncViews(views, count) {
      call(field, 'sync', views, count);
      // only a visual change wakes the loop: main's 5 s clock recompute re-sends identical views (ages aside),
      // and an idle reduced-motion loop must stay at 0 renders/s (§7.3, acceptance #9)
      const sig = viewsSignature(views, count);
      if (sig !== lastViewsSig) {
        lastViewsSig = sig;
        loop.requestRender();
      }
    },
    /** Run director effects (main.js). */
    runEffects(effects) {
      if (!effects?.length) return;
      call(fx, 'run', effects);
      loop.keepAlive(600);
    },
    info: () => ({ quality, stats: loop.stats, timing: { ...timing }, world: !world.placeholder, field: !field.placeholder, fx: !fx.placeholder }),
    /** Run one full frame synchronously (debugging, screenshots of a hidden tab where rAF is paused). */
    frameNow(dtSec = 1 / 60) {
      return frame(dtSec, performance.now() / 1000, { dtMs: dtSec * 1000, period: null, mode: 'demand' });
    },
    /** The post pass while it is on (debugging). */
    get post() {
      return post;
    },
    dispose() {
      clearInterval(dayTimer);
      clearInterval(nightTimer);
      clearTimeout(failTimer);
      for (const off of offs) off?.();
      for (const off of landmarkOffs) off?.();
      ro?.disconnect();
      globalThis.removeEventListener?.('resize', resize);
      dbg?.dispose();
      loop.dispose();
      call(fx, 'clear');
      call(field, 'dispose');
      call(world, 'dispose');
      post?.dispose();
      picker.dispose();
      rig.dispose();
      r.dispose();
    },
  };
  return stage;
}

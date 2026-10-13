/**
 * world/world.js — buildWorld(): island + landmarks + sky + weather + farmer + critters + waterfall (WP3;
 * GAME-DESIGN §2, §4.4–4.5, §9.7).
 *
 *   buildWorld({ scene, tier, settings, requestRender?, quality?, bus?, plotCritters?, spouts? }) → World
 *     quality  the platform's Quality object (gfx/tiers.js); wins over `tier` when given
 *     bus      optional: the world follows 'data:views' {next} itself (butterflies, opt-in plot critters/spouts)
 *
 * World (the §9.7 contract):
 *   landmarks: Map<id, { id, object3D, proxy, anchor, setState(s) }>      ids of §2.4
 *   slotPosition(i, count) → Vector3        standPoint(i, count) → Vector3
 *   setWeather({key, mean}) · setWind(factor) · gust() · setDaylight(mode: 'day'|'clock', timeMs)
 *   setFeedLook(state) · setHalted(bool)
 *   setMoney({ towerFill, pondFill, siloFill, crates: {n}, compost: {n} })   0..1 fills, counts
 *   setBarProgress(p01) · kickWindmill() · setSundial(visible) · setUnread(n)
 *   farmer: { goto(slot, pose), setEnabled(b) } | null
 *   update(dt, t) · rebuild() · dispose()
 *
 * Additive helpers (feature-detect them; none is required by §9.7):
 *   syncPlots(views, count)   butterflies over healthy plots, (opt-in) plot critters and drip spouts, slot count
 *   setPlotCritters(b) / setSpouts(b)   opt-in fallbacks: WP4's plots already draw the bird/mole and the valve
 *                             drip, so the world's own versions are OFF by default (buildWorld options too)
 *   setSlotCount(n)           ring path, irrigation and farmer graph for 10–15 slots (also inferred from
 *                             slotPosition(i, count) calls)
 *   flow(slot, 'out'|'in')    pump turns + water beads run along the pipe (the `water` / close effects)
 *   timelapse()               sundial sweep + windmill spin-up (the `timelapse` effect)
 *   setBarClock({ nextTickMs, periodMs, skewMs })   the world computes the bar progress itself every frame
 *   setTier(tier)             quality governor steps: grass count, shadows ↔ contact blobs, critters
 *   setReduced(bool|null)     force reduced motion (null = follow settings / the system)
 *   onLightning(fn) → off     fn({ strength, thunderInMs }) — wire to sfx.play('thunder') after thunderInMs
 *   intro() → Promise         island rises from the clouds + landmarks pop in (§4.6; RM: instant)
 *   isAnimating() → bool      something world-side is still moving (for an on-demand loop); alias busy()
 *   setQuality(q)             alias of setTier (stage.js feature-detects this name)
 *   setSettings(s)            re-read "Farmer & animals" / motion (they are also polled every frame)
 *   critters, sky, weather, heightAt(x, z), pipeRoute(slot, count)
 *
 * Units: `update(dt, t)` accepts dt in seconds (or ms: values > 1 are treated as ms) and keeps its own clock,
 * so it never depends on the platform's time base. All money levels arrive precomputed (the world only clamps:
 * it never decides what a number means, J1).
 */
import { Group, InstancedMesh, Matrix4, Object3D, PlaneGeometry, Vector3 } from '../three.js';
import { blobTexture, propMaterial, refreshMaterials } from '../gfx/materials.js';
import { batchMeshes } from './batch.js';
import { buildIsland } from './island.js';
import { buildLandmarks } from './landmarks.js';
import { createSky } from './sky.js';
import { createWeather } from './weather.js';
import { createFarmer } from './farmer.js';
import { createCritters } from './critters.js';
import { createPuffs } from './puffs.js';
import { createWaterfall } from './waterfall.js';
import {
  EASE,
  GRID,
  LANDMARK_IDS,
  Tween,
  hourOf,
  moneyLevels,
  pipeRouteTo,
  popScale,
  slotXZ,
  standXZ,
  tierOf,
  weatherKey,
  windFactorSafe,
} from './logic.js';
import { heightAt } from './terrain.js';

const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);

/** Read whatever `settings` is: the core/settings.js controller ({get, reduced}) or a plain Settings object. */
function settingsReader(settings) {
  let mq = null;
  try {
    mq = globalThis.matchMedia ? globalThis.matchMedia('(prefers-reduced-motion: reduce)') : null;
  } catch {
    mq = null;
  }
  const get = () => {
    try {
      return (typeof settings?.get === 'function' ? settings.get() : settings) || {};
    } catch {
      return {};
    }
  };
  const reduced = () => {
    try {
      if (typeof settings?.reduced === 'function') return !!settings.reduced();
    } catch {
      /* fall through */
    }
    const s = get();
    if (s.motion === 'reduced') return true;
    if (s.motion === 'full') return false;
    return !!mq?.matches;
  };
  return { get, reduced };
}

export function buildWorld({ scene, tier = 'high', settings = null, requestRender = null, quality = null, bus = null, plotCritters = false, spouts = false } = {}) {
  if (!scene) throw new TypeError('buildWorld needs a scene');
  const t0 = globalThis.performance?.now?.() ?? Date.now();
  let T = tierOf(quality && typeof quality === 'object' ? quality : tier);
  const S = settingsReader(settings);

  const root = new Group();
  root.name = 'world';
  const uChar = { value: 0 };
  let count = GRID.minSlots;

  // per-stage build times (ms) for the ?debug=1 overlay: world.buildProfile
  const profile = {};
  let mark = t0;
  const lap = (k) => {
    const n = globalThis.performance?.now?.() ?? Date.now();
    profile[k] = Math.round((n - mark) * 10) / 10;
    mark = n;
  };
  const island = buildIsland({ tier: T.name, count, uChar });
  lap('island');
  const puffs = createPuffs({ max: 40 });
  const lms = buildLandmarks({ puffs, count });
  lap('landmarks');
  const sky = createSky({ scene, tier: T.name });
  const weather = createWeather({ scene, tier: T.name, sky });
  lap('skyWeather');
  const farmer = createFarmer({ count, puffs });
  const critters = createCritters({ puffs, plotCritters });
  const waterfall = createWaterfall();
  lap('actors');
  lms.setSpouts(spouts);
  root.add(island.group, lms.group, puffs.mesh, farmer.object3D, critters.group, weather.group, waterfall.group);
  scene.add(sky.group, root);

  // ---- contact blobs (Low tier / shadows off): trees, boulders, landmark bases
  const blobSpots = [...island.blobSpots, ...lms.list.map((l) => l.blob).filter(Boolean)];
  const blobTex = blobTexture();
  let blobs = null;
  if (blobTex) {
    const mat = propMaterial({ basic: true, color: 0xffffff, transparent: true, depthWrite: false }).clone();
    mat.map = blobTex;
    const geo = new PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    blobs = new InstancedMesh(geo, mat, blobSpots.length);
    const o = new Object3D();
    const m4 = new Matrix4();
    blobSpots.forEach((b, i) => {
      o.position.set(b.x, heightAt(b.x, b.z) + 0.04, b.z);
      o.scale.set(b.r * 2.4, 1, b.r * 2.4);
      o.updateMatrix();
      blobs.setMatrixAt(i, m4.copy(o.matrix));
    });
    blobs.name = 'blobShadows';
    blobs.renderOrder = 1;
    root.add(blobs);
  }

  // ---- one draw call for every prop that shares the toon vertex-colour material (rebuildable meshes excluded)
  root.updateMatrixWorld(true);
  const batch = batchMeshes(root, propMaterial({ vertexColors: true, toon: true }), {
    exclude: (o) => o.name === 'pipeNet' || o.name === 'pathStones',
    castShadow: T.shadows !== 'none',
  });
  batch?.sync();
  lap('batch');

  // the executor's `timelapse` effect sweeps the sundial (landmark state {sweep}); the windmill and the clock sky
  // follow it (§4.4 "the sundial shadow sweeps 360°; the windmill spins fast; with sky = clock the sky runs the hour")
  lms.byId.get('sundial').onSweep = () => {
    lms.byId.get('windmill').timelapse();
    sky.timelapse();
  };

  // ---- landmark map (the §9.7 shape; records also carry extra hooks)
  const landmarks = new Map();
  for (const id of LANDMARK_IDS) {
    const l = lms.byId.get(id);
    if (l) landmarks.set(id, l);
  }

  // ---- state
  let forcedReduced = null;
  let reduced = S.reduced();
  let gustT = Infinity;
  let clock = 0;
  let dayMode = null; // null until setDaylight is called (then the integrator drives it)
  let autoSky = null; // the Sky setting applied while the integrator has not called setDaylight
  let dayTimeMs = null;
  let barClock = null;
  let halted = false;
  const charT = new Tween(0);
  let pendingCount = null;
  let introT = Infinity;
  let introResolve = null;
  let animating = true;
  let farmerWanted = true;
  let mistT = 0;

  function applyTier() {
    island.setGrassCount(T.grass);
    const shadows = T.shadows !== 'none';
    sky.setShadows(T.shadows, T.shadowMap || 1024);
    if (blobs) blobs.visible = !shadows;
    farmer.setBlob(!shadows);
    weather.setRainDrops(T.rain);
  }
  applyTier();

  function applyActors() {
    const s = S.get();
    const animals = s.farmer !== false;
    farmer.setEnabled(farmerWanted && animals && !reduced && T.farmer !== false);
    critters.setEnabled(animals && !reduced && T.critters);
  }
  applyActors();

  function setSlotCount(n) {
    const c = Math.max(GRID.minSlots, Math.min(GRID.maxSlots, Math.round(num(n, GRID.minSlots))));
    if (c === count) return;
    count = c;
    island.setCount(c);
    lms.setSlotCount(c);
    farmer.setSlotCount(c);
    requestRender?.();
  }

  const world = {
    root,
    landmarks,
    island,
    sky,
    weather,
    critters,
    puffs,
    heightAt,
    get slotCount() {
      return count;
    },
    get buildMs() {
      return buildMs;
    },
    get buildProfile() {
      return { ...profile };
    },

    slotPosition(i, n = count) {
      if (n !== count) pendingCount = n;
      const p = slotXZ(i, n);
      return new Vector3(p.x, 0, p.z);
    },
    standPoint(i, n = count) {
      if (n !== count) pendingCount = n;
      const p = standXZ(i, n);
      return new Vector3(p.x, heightAt(p.x, p.z), p.z);
    },

    setWeather(w) {
      const key = weatherKey(w);
      sky.setWeather(key, { instant: reduced });
      weather.setWeather(key);
      requestRender?.();
    },
    setWind(factor) {
      weather.setWind(windFactorSafe(factor && typeof factor === 'object' ? factor.factor : factor));
    },
    gust() {
      if (reduced) return;
      gustT = 0;
      weather.gust();
      lms.gustWindmill();
    },
    setDaylight(mode, timeMs) {
      dayMode = mode === 'clock' ? 'clock' : 'day';
      if (Number.isFinite(Number(timeMs))) dayTimeMs = Number(timeMs);
      sky.setDaylight(dayMode, dayTimeMs ?? Date.now(), { instant: reduced });
      lms.setSundialHour(hourOf(dayTimeMs ?? Date.now()));
      requestRender?.();
    },
    setFeedLook(state) {
      sky.setFeedLook(state);
      lms.setFeedLook(state);
      requestRender?.();
    },
    setHalted(b) {
      halted = !!b;
      charT.set(halted ? 1 : 0, reduced ? 0 : 1.2, EASE.iOS);
      lms.setHalted(halted);
      requestRender?.();
    },
    setMoney(m) {
      lms.setReduced(reduced);
      lms.setMoney(moneyLevels(m || {}));
      requestRender?.();
    },
    setBarProgress(p) {
      lms.setBarProgress(p);
    },
    kickWindmill() {
      if (!reduced) lms.kickWindmill();
    },
    setSundial(visible) {
      lms.setSundial(!!visible);
      requestRender?.();
    },
    setUnread(n) {
      lms.setUnread(n);
      requestRender?.();
    },
    farmer: {
      goto(slot, pose) {
        farmer.goto(slot, pose);
      },
      setEnabled(b) {
        farmerWanted = !!b;
        applyActors();
      },
      get object3D() {
        return farmer.object3D;
      },
      get state() {
        return farmer.state;
      },
    },

    // ---- additive helpers
    setSlotCount,
    syncPlots(views, n) {
      if (n != null) setSlotCount(n);
      critters.sync(views || {}, count);
      const active = {};
      for (const [slot, v] of Object.entries(views || {})) {
        if (!v || v.state === 'closed' || Number(slot) >= count) continue;
        active[slot] = v.state === 'paused' || v.halted ? 'paused' : 'on';
      }
      lms.setActiveSpouts(active);
    },
    setPlotCritters(b) {
      critters.setPlotCritters(b);
    },
    setSpouts(b) {
      lms.setSpouts(b);
    },
    flow(slot, dir = 'out') {
      lms.flow(slot, dir, count);
      requestRender?.();
    },
    timelapse() {
      if (reduced) return;
      lms.timelapse();
      sky.timelapse();
    },
    setBarClock(c) {
      barClock = c && Number.isFinite(Number(c.nextTickMs)) ? { nextTickMs: Number(c.nextTickMs), periodMs: Math.max(1000, num(c.periodMs, 60000)), skewMs: num(c.skewMs) } : null;
    },
    setTier(next) {
      T = tierOf(next);
      applyTier();
      applyActors();
      if (batch) batch.mesh.castShadow = T.shadows !== 'none';
      requestRender?.();
    },
    setQuality(q) {
      world.setTier(q);
    },
    setSettings() {
      applyActors();
      requestRender?.();
    },
    resize() {
      /* nothing view-dependent in the world */
    },
    busy() {
      return animating;
    },
    setReduced(b) {
      forcedReduced = b == null ? null : !!b;
    },
    onLightning(fn) {
      return weather.onLightning(fn);
    },
    pipeRoute(slot, n = count) {
      return pipeRouteTo(slot, n).map((p) => new Vector3(p[0], p[1], p[2]));
    },
    intro() {
      return new Promise((resolve) => {
        if (reduced) {
          root.position.y = 0;
          for (const l of lms.list) l.object3D.scale.setScalar(1);
          resolve();
          return;
        }
        introT = 0;
        introResolve = resolve;
        root.position.y = -14;
        for (const l of lms.list) l.object3D.scale.setScalar(0.0001);
      });
    },
    isAnimating() {
      return animating;
    },

    /** update(dt, t): `t` is accepted but unused — the world integrates its own clock from dt (any time base). */
    update(dt) {
      let d = num(dt, 0.016);
      if (d > 1) d /= 1000; // ms → s
      d = Math.max(0, Math.min(0.1, d));
      clock += d;

      // reduced motion + "Farmer & animals" follow the settings live (cheap: a few boolean writes)
      reduced = forcedReduced ?? S.reduced();
      applyActors();
      if (pendingCount != null) {
        setSlotCount(pendingCount);
        pendingCount = null;
      }
      // sky follows the Sky setting until the integrator calls setDaylight itself
      if (dayMode == null) {
        const want = S.get().sky === 'clock' ? 'clock' : 'day';
        if (want !== autoSky) {
          sky.setDaylight(want, Date.now(), { instant: reduced || autoSky == null });
          autoSky = want;
        }
        lms.setSundialHour(hourOf(Date.now()));
      }
      // windmill bar clock from the server's next-tick time (if provided)
      if (barClock) {
        const left = barClock.nextTickMs - (Date.now() + barClock.skewMs);
        lms.setBarProgress(1 - Math.max(0, Math.min(1, left / barClock.periodMs)));
      }
      let gustK = 0;
      if (gustT < 1.6) {
        gustT += d;
        gustK = Math.sin(Math.min(1, gustT / 1.6) * Math.PI);
      }
      const env = { time: clock, reduced, wind: reduced ? 0 : weather.wind, gustK, ambient: !reduced, night: sky.night };

      let busy = false;
      busy = sky.update(d, { reduced }) || busy;
      busy = weather.update(d, { reduced, nowMs: Date.now(), dayLight: 1 - 0.85 * sky.night }) || busy;
      lms.setNight(sky.night);
      busy = lms.update(d, env) || busy;
      if (charT.step(d)) busy = true;
      island.setChar(charT.v);
      // waterfall: lit like the scene; a little mist where the sheet meets the clouds (ambience, P2)
      waterfall.setLight((0.55 + 0.45 * sky.lightK) * (1 - 0.65 * sky.night));
      if (!reduced) {
        mistT -= d;
        if (mistT <= 0) {
          mistT = 0.55 + Math.random() * 0.4;
          const b = waterfall.base;
          puffs.emit({ x: b.x + (Math.random() - 0.5) * 0.8, y: b.y, z: b.z + (Math.random() - 0.5) * 0.8, vx: 0.2 * weather.wind, vy: -0.25, life: 1.8, size: 0.45, grow: 1.6, color: 0xf3f8fb, drag: 1 });
        }
      }
      busy = puffs.update(d) || busy;
      busy = farmer.update(d, env) || busy;
      busy = critters.update(d, env) || busy;

      // intro: the island rises from the cloud layer while landmarks pop in (40 ms stagger)
      if (introT < 2.4) {
        introT += d;
        root.position.y = -14 * (1 - EASE.oC(Math.min(1, introT / 2)));
        lms.list.forEach((l, i) => {
          const k = (introT - 0.9 - i * 0.04) / 0.4;
          l.object3D.scale.setScalar(Math.max(0.0001, k <= 0 ? 0.0001 : popScale(k)));
        });
        busy = true;
        if (introT >= 2.4) {
          root.position.y = 0;
          for (const l of lms.list) l.object3D.scale.setScalar(1);
          introResolve?.();
          introResolve = null;
        }
      }
      // keep the batched props in step with their (animated) scene-graph originals
      root.updateMatrixWorld();
      batch?.sync();
      animating = busy || !reduced;
      return animating;
    },

    rebuild() {
      // after a WebGL context restore three re-uploads buffers lazily; make sure textures/materials re-upload
      // and the shadow map is recreated.
      refreshMaterials();
      sky.sun.shadow.map?.dispose();
      sky.sun.shadow.map = null;
      requestRender?.();
    },

    dispose() {
      island.dispose();
      lms.dispose();
      sky.dispose();
      weather.dispose();
      farmer.dispose();
      critters.dispose();
      waterfall.dispose();
      puffs.dispose();
      batch?.dispose();
      if (blobs) {
        blobs.geometry.dispose();
        blobs.material.dispose();
      }
      root.removeFromParent();
      landmarks.clear();
    },
  };
  // self-wiring through the documented bus event (§9.6 'data:views' {prev, next}): critters + spouts follow views
  const offViews = typeof bus?.on === 'function' ? bus.on('data:views', (p) => world.syncPlots(p?.next || {})) : null;
  // pick mode (§4.1 "Pick a seed"): that coin's sachet lifts 0.3 u and spins on the stall ('ui:pick' {bean|null})
  const offPick = typeof bus?.on === 'function'
    ? bus.on('ui:pick', (e) => landmarks.get('stall')?.setState({ selected: e?.bean?.coin ?? null }))
    : null;
  const dispose0 = world.dispose;
  world.dispose = () => {
    offViews?.();
    offPick?.();
    dispose0();
  };
  const buildMs = (globalThis.performance?.now?.() ?? Date.now()) - t0;
  return world;
}

export { LANDMARK_IDS };

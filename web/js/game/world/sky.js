/**
 * world/sky.js — sky dome, lights, fog, day/night and the far-sky lightning glow (WP3; GAME-DESIGN §2.1, §4.4,
 * §6.9 "Sky", §9.8 "Lights", §9.10 "Scene palette").
 *
 *   createSky({ scene, tier }) → Sky
 *   Sky = {
 *     dome, hemi, sun, fill, islets,
 *     setWeather(key, { instant }),       sky gradient + light multiplier crossfade over 4 s (§4.4)
 *     setDaylight(mode, timeMs),           'day' (fixed late morning) | 'clock' (local hour of timeMs)
 *     setFeedLook(state),                  'down'/'offline' → fog density ×1.6 over 1.2 s (§4.4)
 *     setShadows(mode, mapSize),           'soft' | 'pcf' | 'none'
 *     flash(strength),                     lightning glow behind the island (strength ≤ 0.3, 120 ms envelope)
 *     timelapse(),                         with Sky = clock the sky runs one hour in 2 s (§4.4 "Time-lapse (sim)")
 *     update(dt, { reduced }), state, dispose()
 *   }
 *
 * Photosensitivity (§4.4, §11.5): the flash brightens ONLY a patch of the far sky (behind the island, below the
 * horizon as seen from the default camera) by at most +30 %; the island lighting never flashes.
 * Lights never include point lights (§9.8). Day/night only changes colours/intensities.
 */
import {
  BackSide,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  Object3D,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from '../three.js';
import { cone, flat, kit, lowpolySphere, paint } from '../gfx/geom.js';
import { propMaterial } from '../gfx/materials.js';
import { DAY_FIXED, LIGHTS, PAL, WEATHER, dayKeyAt, mixHex } from '../gfx/palette.js';
import { hourOf, sunAzimuthAt, sunDir, weatherKey } from './logic.js';
import { clamp, lerp, rng, smoothstep } from './noise.js';

/**
 * Light intensities in three r169 (physically based) units, tuned by eye against the toon ramp: a warm key that
 * reads clearly in soft shadows, a hemisphere that keeps shadowed sides at ~55 % (cozy, never black) and a cool
 * back fill. Mutable on purpose (dev tuning); treat as constants.
 */
export const LIGHT_LEVELS = { sun: 3.0, hemi: 1.35, fill: 0.45 };
/** Fixed "always day" sun: late morning from the south-east (front-right of the default view). */
export const DAY_SUN = Object.freeze({ el: DAY_FIXED.sunEl, az: -34 });
const FOG = Object.freeze({ near: 85, far: 270, downK: 1.6 });
const DOME_R = 240;

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize( position );
  vec4 p = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w; // always at the far plane
}
`;

const FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBelow;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFlashDir;
uniform float uFlash;
uniform float uNight;
uniform float uTime;
varying vec3 vDir;
float h13( vec3 p ) { return fract( sin( dot( p, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 ); }
void main() {
  vec3 d = normalize( vDir );
  float e = d.y;
  vec3 col = e > 0.0
    ? mix( uHorizon, uTop, pow( clamp( e, 0.0, 1.0 ), 0.5 ) )
    : mix( uHorizon, uBelow, pow( clamp( -e * 1.15, 0.0, 1.0 ), 0.62 ) );
  // a soft luminous haze band at the horizon
  col = mix( col, uHorizon * 1.04, exp( -abs( e ) * 9.0 ) * 0.4 );
  // sun disc + glow (fades out at night)
  float s = max( dot( d, uSunDir ), 0.0 );
  col += uSunColor * ( pow( s, 900.0 ) * 1.4 + pow( s, 14.0 ) * 0.16 + pow( s, 3.0 ) * 0.05 ) * ( 1.0 - uNight );
  // stars (a floating world has them below the horizon too), gently twinkling
  if ( uNight > 0.01 ) {
    vec3 q = floor( d * 210.0 );
    float h = h13( q );
    float tw = 0.65 + 0.35 * sin( uTime * ( 1.0 + h * 3.0 ) + h * 40.0 );
    col += vec3( 0.9, 0.93, 1.0 ) * step( 0.9972, h ) * tw * uNight * 0.85;
  }
  // far-sky lightning glow (≤ +30 %, only around uFlashDir)
  float f = max( dot( d, uFlashDir ), 0.0 );
  col *= 1.0 + uFlash * smoothstep( 0.72, 0.97, f );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** A few distant floating islets (the "far hills" lightning hides behind). Merged, fog-hazed. */
function buildIslets() {
  const k = kit();
  const r = rng(404);
  const spots = [
    [-38, -46, -150, 9], [26, -40, -165, 12], [92, -34, -128, 7], [-104, -52, -112, 8], [-12, -60, -205, 15],
    [148, -42, -40, 9], [-150, -38, -20, 10], [64, -66, 120, 8], [-80, -58, 140, 7],
  ];
  for (const [x, y, z, s] of spots) {
    const top = lowpolySphere(s, 1, { jitter: 0.2, seed: x, squash: [1, 0.22, 1] });
    paint(top, mixHex(PAL.grass, PAL.grassDk, r()));
    const under = flat(cone(s * 0.95, s * 1.7, 7, null, { r: [Math.PI, r() * 3, 0], p: [0, -s * 0.05, 0] }));
    paint(under, (px, py) => mixHex(PAL.rockA, PAL.rockDk, clamp(-py / (s * 1.7), 0, 1)));
    if (r() > 0.4) {
      const tree = flat(cone(s * 0.18, s * 0.6, 5, PAL.leafC, { p: [s * 0.3, s * 0.12, 0] }));
      k.add(tree, null, { p: [x, y, z] });
    }
    k.add(top, null, { p: [x, y + s * 0.08, z] });
    k.add(under, null, { p: [x, y, z] });
  }
  const g = k.build();
  const m = new Mesh(g, propMaterial({ vertexColors: true, toon: true }));
  m.name = 'farIslets';
  return m;
}

export function createSky({ scene, tier = 'high' } = {}) {
  const group = new Group();
  group.name = 'sky';

  // ---- dome
  const uniforms = {
    uTop: { value: new Color(WEATHER.sunny.top) },
    uHorizon: { value: new Color(WEATHER.sunny.horizon) },
    uBelow: { value: new Color(WEATHER.sunny.below) },
    uSunDir: { value: new Vector3(0, 1, 0) },
    uSunColor: { value: new Color(0xfff1dc) },
    uFlashDir: { value: new Vector3(-0.18, -0.42, -0.89).normalize() },
    uFlash: { value: 0 },
    uNight: { value: 0 },
    uTime: { value: 0 },
  };
  const domeGeo = new SphereGeometry(DOME_R, 40, 24);
  const domeMat = new ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, side: BackSide, depthWrite: false, fog: false });
  const dome = new Mesh(domeGeo, domeMat);
  dome.name = 'skyDome';
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  group.add(dome);

  const islets = buildIslets();
  group.add(islets);

  // ---- lights (§9.8): hemisphere + warm key (shadows) + cool fill (no shadows)
  const hemi = new HemisphereLight(LIGHTS.hemiSky, LIGHTS.hemiGround, LIGHT_LEVELS.hemi);
  const sun = new DirectionalLight(LIGHTS.sun, LIGHT_LEVELS.sun);
  sun.name = 'sun';
  const target = new Object3D();
  target.position.set(0, 0, 0);
  sun.target = target;
  sun.castShadow = tier !== 'low';
  const sc = sun.shadow.camera;
  sc.left = -24;
  sc.right = 24;
  sc.top = 24;
  sc.bottom = -24;
  sc.near = 1;
  sc.far = 130;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 2.5;
  sun.shadow.mapSize.set(tier === 'high' ? 2048 : 1024, tier === 'high' ? 2048 : 1024);
  const fill = new DirectionalLight(LIGHTS.fill, LIGHT_LEVELS.fill);
  fill.name = 'fill';
  fill.target = target;
  group.add(hemi, sun, fill, target);

  // ---- fog
  const fog = new Fog(new Color(WEATHER.sunny.horizon), FOG.near, FOG.far);
  scene.fog = fog;

  // ---- state + crossfades
  const cur = { top: new Color(), horizon: new Color(), below: new Color(), light: 1, cool: 0 };
  const from = { top: new Color(), horizon: new Color(), below: new Color(), light: 1, cool: 0 };
  const to = { top: new Color(), horizon: new Color(), below: new Color(), light: 1, cool: 0 };
  let wKey = 'sunny';
  let wT = 1; // 0..1 progress of the 4 s crossfade
  const setTo = (k) => {
    const W = WEATHER[k];
    to.top.set(W.top);
    to.horizon.set(W.horizon);
    to.below.set(W.below);
    to.light = W.light;
    to.cool = W.cool;
  };
  setTo('sunny');
  for (const key of ['top', 'horizon', 'below']) {
    cur[key].copy(to[key]);
    from[key].copy(to[key]);
  }

  // daylight
  let dayMode = 'day';
  let dayTimeMs = Date.now();
  let dayKey = { ...DAY_FIXED };
  let dayBlend = 1;
  const dayFrom = { ...DAY_FIXED };
  let dayAz = DAY_SUN.az;
  let dayFromAz = DAY_SUN.az;

  let lapseT = Infinity; // time-lapse: the clock sky runs +1 h over 2 s
  let fogK = 1;
  let fogTarget = 1;
  let flashT = Infinity;
  let flashS = 0;
  let time = 0;
  const tint = new Color();
  const tmp = new Color();
  const sunC = new Color(LIGHTS.sun);
  const coolC = new Color(0xc8d4e6);
  const moonC = new Color(LIGHTS.moon);

  function computeDay() {
    if (dayMode === 'clock') {
      const h = hourOf(dayTimeMs);
      return { key: dayKeyAt(h), az: sunAzimuthAt(h) };
    }
    return { key: { ...DAY_FIXED }, az: DAY_SUN.az };
  }

  function apply() {
    // blended day keyframe
    const k = smoothstep(0, 1, dayBlend);
    const D = {
      sunEl: lerp(dayFrom.sunEl, dayKey.sunEl, k),
      light: lerp(dayFrom.light, dayKey.light, k),
      sky: lerp(dayFrom.sky, dayKey.sky, k),
      tintK: lerp(dayFrom.tintK, dayKey.tintK, k),
      night: lerp(dayFrom.night, dayKey.night, k),
    };
    tint.set(mixHex(dayFrom.tint, dayKey.tint, k));
    const az = lerp(dayFromAz, dayAz, k);

    // sky colours: weather gradient × day brightness, mixed toward the day tint
    const sky = (c, out) => out.copy(c).multiplyScalar(D.sky).lerp(tmp.copy(tint).multiplyScalar(Math.max(D.sky, 0.25)), D.tintK);
    sky(cur.top, uniforms.uTop.value);
    sky(cur.horizon, uniforms.uHorizon.value);
    sky(cur.below, uniforms.uBelow.value);
    uniforms.uNight.value = D.night;

    // sun / moon
    const below = D.sunEl < 0;
    const el = below ? Math.max(25, -D.sunEl + 20) : Math.max(D.sunEl, 8);
    const dir = sunDir(el, below ? az + 180 : az);
    uniforms.uSunDir.value.set(dir.x, Math.sin((D.sunEl * Math.PI) / 180), dir.z).normalize();
    sun.position.set(dir.x * 70, dir.y * 70, dir.z * 70);
    fill.position.set(-dir.x * 50, 22, -dir.z * 50);

    const wl = cur.light;
    const cool = cur.cool;
    sun.color.copy(below ? moonC : sunC).lerp(coolC, cool * 0.6).lerp(tint, below ? 0 : D.tintK * 0.5);
    uniforms.uSunColor.value.copy(sunC).lerp(tint, D.tintK * 0.6);
    sun.intensity = LIGHT_LEVELS.sun * wl * (below ? 0.28 : D.light);
    const hemiK = Math.max(LIGHTS.moonHemiMin, D.light);
    hemi.intensity = LIGHT_LEVELS.hemi * hemiK * (0.75 + 0.25 * wl);
    hemi.color.set(LIGHTS.hemiSky).lerp(coolC, cool * 0.5).lerp(tint, D.tintK * 0.35);
    hemi.groundColor.set(LIGHTS.hemiGround).lerp(tmp.set(0x9aa0a8), cool * 0.4);
    fill.intensity = LIGHT_LEVELS.fill * (0.6 + 0.4 * wl) * Math.max(0.5, D.light);

    // fog follows the horizon haze; denser when the feed is down
    fog.color.copy(uniforms.uHorizon.value).lerp(uniforms.uBelow.value, 0.35);
    fog.near = FOG.near / fogK;
    fog.far = FOG.far / fogK;
  }

  const sky = {
    group,
    dome,
    hemi,
    sun,
    fill,
    islets,
    uniforms,
    get weather() {
      return wKey;
    },
    get night() {
      return uniforms.uNight.value;
    },
    get lightK() {
      return cur.light;
    },
    get horizon() {
      return uniforms.uHorizon.value;
    },
    setWeather(key, { instant = false } = {}) {
      const k = weatherKey(key);
      if (k === wKey && !instant) return;
      wKey = k;
      for (const c of ['top', 'horizon', 'below']) from[c].copy(cur[c]);
      from.light = cur.light;
      from.cool = cur.cool;
      setTo(k);
      wT = instant ? 1 : 0;
      if (instant) {
        for (const c of ['top', 'horizon', 'below']) cur[c].copy(to[c]);
        cur.light = to.light;
        cur.cool = to.cool;
        apply();
      }
    },
    setDaylight(mode, timeMs, { instant = false } = {}) {
      const m = mode === 'clock' ? 'clock' : 'day';
      const changed = m !== dayMode;
      dayMode = m;
      if (Number.isFinite(Number(timeMs))) dayTimeMs = Number(timeMs);
      const nd = computeDay();
      if (changed && !instant) {
        const kk = smoothstep(0, 1, dayBlend);
        Object.assign(dayFrom, {
          sunEl: lerp(dayFrom.sunEl, dayKey.sunEl, kk),
          light: lerp(dayFrom.light, dayKey.light, kk),
          sky: lerp(dayFrom.sky, dayKey.sky, kk),
          tintK: lerp(dayFrom.tintK, dayKey.tintK, kk),
          night: lerp(dayFrom.night, dayKey.night, kk),
          tint: mixHex(dayFrom.tint, dayKey.tint, kk),
        });
        dayFromAz = lerp(dayFromAz, dayAz, kk);
        dayBlend = 0;
      } else if (instant) {
        Object.assign(dayFrom, nd.key);
        dayFromAz = nd.az;
        dayBlend = 1;
      }
      dayKey = nd.key;
      dayAz = nd.az;
      apply();
    },
    setFeedLook(state) {
      fogTarget = state === 'down' || state === 'offline' ? FOG.downK : state === 'delayed' ? 1.15 : 1;
    },
    setShadows(mode, mapSize) {
      sun.castShadow = mode !== 'none';
      if (mapSize && sun.shadow.mapSize.x !== mapSize) {
        sun.shadow.mapSize.set(mapSize, mapSize);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
    },
    timelapse() {
      if (dayMode === 'clock') lapseT = 0;
    },
    flash(strength = 0.3) {
      flashS = clamp(Number(strength) || 0, 0, 0.3);
      flashT = 0;
    },
    /** dt seconds. Returns true while something is still animating (crossfades). */
    update(dt, { reduced = false } = {}) {
      time += dt;
      uniforms.uTime.value = reduced ? 0 : time;
      let busy = false;
      if (wT < 1) {
        wT = reduced ? 1 : Math.min(1, wT + dt / 4);
        const k = smoothstep(0, 1, wT);
        for (const c of ['top', 'horizon', 'below']) cur[c].copy(from[c]).lerp(to[c], k);
        cur.light = lerp(from.light, to.light, k);
        cur.cool = lerp(from.cool, to.cool, k);
        busy = true;
      }
      if (dayBlend < 1) {
        dayBlend = reduced ? 1 : Math.min(1, dayBlend + dt / 4);
        busy = true;
      }
      if (dayMode === 'clock') {
        // follow the clock slowly (re-evaluated every frame from the last given time + elapsed); during a
        // time-lapse the hour runs by in 2 s (the next setDaylight with market time lands on the same hour)
        let lapse = 0;
        if (lapseT < 2 && !reduced) {
          const k0 = smoothstep(0, 1, lapseT / 2);
          lapseT = Math.min(2, lapseT + dt);
          lapse = (smoothstep(0, 1, lapseT / 2) - k0) * 3_600_000;
          busy = true;
        }
        dayTimeMs += dt * 1000 + lapse;
        const nd = computeDay();
        dayKey = nd.key;
        dayAz = nd.az;
      }
      if (fogK !== fogTarget) {
        const step = reduced ? 1 : dt / 1.2;
        fogK = fogK < fogTarget ? Math.min(fogTarget, fogK + step * (FOG.downK - 1)) : Math.max(fogTarget, fogK - step * (FOG.downK - 1));
        busy = true;
      }
      // lightning glow envelope (120 ms; never in reduced motion)
      if (flashT < 0.12 && !reduced) {
        flashT += dt;
        const t = flashT * 1000;
        const env = t < 40 ? 1 : t < 70 ? 0.45 : t < 95 ? 0.85 : Math.max(0, 1 - (t - 95) / 25);
        uniforms.uFlash.value = flashS * env;
        busy = true;
      } else uniforms.uFlash.value = 0;
      apply();
      return busy;
    },
    dispose() {
      domeGeo.dispose();
      domeMat.dispose();
      islets.geometry.dispose();
      sun.shadow.map?.dispose();
      if (scene.fog === fog) scene.fog = null;
      group.removeFromParent();
    },
  };
  sky.setWeather('sunny', { instant: true });
  sky.setDaylight('day', Date.now(), { instant: true });
  return sky;
}

/** Re-export for the world (fog/near-far constants are useful to tests and the integrator). */
export { FOG as SKY_FOG };

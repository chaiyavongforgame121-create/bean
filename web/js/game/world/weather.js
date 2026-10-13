/**
 * world/weather.js — clouds, rain, lightning and the wind/gust uniforms (WP3; GAME-DESIGN §4.4, §4.5).
 *
 *   createWeather({ scene, tier, sky }) → Weather
 *   Weather = {
 *     clouds, rain, bolt,
 *     setWeather(key)        cloud count 8/16/26/34, rain fades in/out, storm enables far-sky lightning
 *     setWind(factor)        market wind (calm 0.6 … gale 2.4); eased over 2 s into sharedUniforms.uWind
 *     gust()                 a wave crosses the grass from the west in 1.2 s (shader uGust)
 *     onLightning(fn)        fn({ strength, thunderInMs }) after each flash (wire to sfx 'thunder')
 *     setRainDrops(n), update(dt, { reduced, nowMs }), dispose()
 *   }
 *
 * Reduced motion (§7.3): clouds stop drifting, rain and lightning are off, wind uniforms are 0 (no sway).
 * Lightning obeys the photosensitivity limits in logic.js: ≤ 1 flash per 8 s, 120 ms, ≤ 30 % step, far sky only.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshLambertMaterial,
  Object3D,
  ShaderMaterial,
} from '../three.js';
import { lowpolySphere, merge, paint, xf } from '../gfx/geom.js';
import { sharedUniforms } from '../gfx/materials.js';
import { WEATHER, mixHex } from '../gfx/palette.js';
import { CLOUD_DRIFT, GUST, cloudCount, gustFront, lightningScheduler, weatherKey, windFactorSafe } from './logic.js';
import { clamp, rng } from './noise.js';

const MAX_CLOUDS = 34;
const SPAN = 170; // clouds wrap across x ∈ [−SPAN/2, SPAN/2]

/** One puffy low-poly cloud: 6 faceted puffs with a flattened, slightly shaded underside. */
function cloudGeometry() {
  const r = rng(31);
  const parts = [];
  // big puffs get detail 1, the small side puffs detail 0 (~360 triangles per cloud)
  const puffs = [[0, 0.35, 0, 1.0], [1.05, 0.15, 0.2, 0.78], [-1.05, 0.12, -0.1, 0.82], [0.45, 0.62, -0.3, 0.7], [-0.4, 0.55, 0.35, 0.66], [1.8, 0, -0.1, 0.5]];
  for (const [x, y, z, s] of puffs) {
    const g = lowpolySphere(s, s >= 0.75 || s === 0.7 ? 1 : 0, { jitter: 0.14, seed: x * 5 + z * 3 + r() });
    xf(g, { p: [x, y, z] });
    parts.push(g);
  }
  const g = merge(parts, { dispose: true });
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) < 0) p.setY(i, p.getY(i) * 0.35); // flat bottoms
  g.computeVertexNormals();
  paint(g, (x, y) => mixHex(0xdfe7f1, 0xffffff, clamp((y + 0.2) / 0.9, 0, 1)));
  return g;
}

const RAIN_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uWind;
varying float vA;
void main() {
  float H = 30.0;
  float fall = 26.0 + aSeed.w * 10.0;
  float y = mod( aSeed.y * H - uTime * fall, H ) - 6.0;
  float lean = 0.12 + 0.1 * uWind;
  vec3 p = vec3( aSeed.x * 52.0 - 26.0 + ( 24.0 - y ) * lean, y, aSeed.z * 52.0 - 26.0 );
  p.y += position.y * 0.9;          // streak: top vertex 0.9 u above the bottom one
  p.x += position.y * 0.9 * lean;
  vA = smoothstep( -6.0, -2.0, y ) * ( 1.0 - smoothstep( 20.0, 24.0, y ) );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
}
`;
const RAIN_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
void main() {
  gl_FragColor = vec4( uColor, uOpacity * vA );
  #include <colorspace_fragment>
}
`;

function buildRain(maxDrops) {
  const pos = new Float32Array(maxDrops * 2 * 3);
  const seed = new Float32Array(maxDrops * 2 * 4);
  const r = rng(808);
  for (let i = 0; i < maxDrops; i++) {
    const s = [r(), r(), r(), r()];
    pos[i * 6 + 4] = 1; // second vertex: y = 1 (streak top)
    for (let v = 0; v < 2; v++) for (let k = 0; k < 4; k++) seed[(i * 2 + v) * 4 + k] = s[k];
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new BufferAttribute(seed, 4));
  g.setDrawRange(0, maxDrops * 2);
  const m = new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uWind: { value: 1 }, uColor: { value: new Color(0xdfe9f2) }, uOpacity: { value: 0 } },
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
    transparent: true,
    depthWrite: false,
  });
  const lines = new LineSegments(g, m);
  lines.name = 'rain';
  lines.frustumCulled = false;
  lines.visible = false;
  lines.renderOrder = 5;
  return lines;
}

/** A thin jagged bolt in the far north sky, behind the far islets (visible only during a flash). */
function buildBolt() {
  const r = rng(9);
  const pts = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < 9; i++) {
    const nx = x + (r() - 0.5) * 9;
    const ny = y - 6 - r() * 4;
    pts.push(x, y, 0, nx, ny, 0);
    if (i === 4) pts.push(nx, ny, 0, nx + 8, ny - 9, 0); // a small fork
    x = nx;
    y = ny;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
  const m = new LineBasicMaterial({ color: 0xf2efff, transparent: true, opacity: 0, fog: false, depthWrite: false });
  const bolt = new LineSegments(g, m);
  bolt.name = 'bolt';
  bolt.visible = false;
  bolt.frustumCulled = false;
  return bolt;
}

export function createWeather({ scene, tier = 'high', sky = null } = {}) {
  const group = new Group();
  group.name = 'weather';
  const r = rng(4242);

  // ---- clouds (instanced; per-instance drift + scale fade)
  const cGeo = cloudGeometry();
  const cMat = new MeshLambertMaterial({ vertexColors: true, color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.32 });
  const clouds = new InstancedMesh(cGeo, cMat, MAX_CLOUDS);
  clouds.name = 'clouds';
  clouds.frustumCulled = false;
  const slots = [];
  for (let i = 0; i < MAX_CLOUDS; i++) {
    const above = i % 6 === 5; // sparse upper layer
    const ang = r() * Math.PI * 2;
    const rad = above ? 30 + r() * 30 : 8 + r() * 60;
    slots.push({
      x: Math.cos(ang) * rad,
      z: Math.sin(ang) * rad - (above ? 10 : 0),
      y: above ? 14 + r() * 6 : -12 + r() * 8,
      s: above ? 1.6 + r() * 1.2 : 2.2 + r() * 2.4,
      sx: 1 + r() * 0.8,
      yaw: r() * Math.PI * 2,
      speed: 0.7 + r() * 0.6,
      above,
      k: 0, // visible scale factor 0..1 (fades with the weather's cloud count)
    });
  }
  // order: the first `count` slots are the visible ones; spread above/below evenly
  const o = new Object3D();
  const m4 = new Matrix4();
  const cloudTint = new Color(0xffffff);
  const cloudTintTo = new Color(0xffffff);
  let cloudN = cloudCount('sunny');

  // ---- rain
  const maxDrops = tier === 'low' ? 300 : tier === 'medium' ? 800 : 1400;
  const rain = buildRain(maxDrops);
  let rainTarget = 0;
  let rainK = 0;

  // ---- lightning
  const bolt = buildBolt();
  const lightning = lightningScheduler(Math.random);
  const lightningFns = new Set();
  let boltT = Infinity;

  // ---- wind
  let windTarget = 1;
  let wind = 1;
  let gustT = Infinity;
  let key = 'sunny';
  let time = 0;

  group.add(clouds, rain, bolt);

  function writeClouds() {
    // only submit instances that are (still) visible: hidden slots are at the end of the list
    let n = 0;
    for (let i = 0; i < MAX_CLOUDS; i++) if (slots[i].k > 0.001) n = i + 1;
    clouds.count = n;
    for (let i = 0; i < n; i++) {
      const c = slots[i];
      // hide upper clouds while they pass over the island (they would hide the field)
      const overIsland = c.above && Math.hypot(c.x, c.z) < 27;
      const s = c.s * c.k * (overIsland ? 0 : 1);
      o.position.set(c.x, c.y, c.z);
      o.rotation.set(0, c.yaw, 0);
      o.scale.set(s * c.sx, s * 0.62, s);
      o.updateMatrix();
      clouds.setMatrixAt(i, m4.copy(o.matrix));
    }
    clouds.instanceMatrix.needsUpdate = true;
  }

  const weather = {
    group,
    clouds,
    rain,
    bolt,
    get key() {
      return key;
    },
    get wind() {
      return wind;
    },
    setWeather(k) {
      key = weatherKey(k);
      cloudN = Math.round(cloudCount(key) * (tier === 'low' ? 0.5 : 1));
      rainTarget = WEATHER[key].rain;
      cloudTintTo.set(WEATHER[key].cloudTint);
      if (key !== 'storm') lightning.poll(0, false);
    },
    setWind(factor) {
      windTarget = windFactorSafe(factor);
    },
    gust() {
      gustT = 0;
    },
    onLightning(fn) {
      lightningFns.add(fn);
      return () => lightningFns.delete(fn);
    },
    setRainDrops(n) {
      const d = Math.max(0, Math.min(maxDrops, Math.floor(Number(n) || 0)));
      rain.geometry.setDrawRange(0, d * 2);
    },
    /** dt seconds; nowMs wall clock (lightning pacing). Returns true while animating. */
    update(dt, { reduced = false, nowMs = Date.now(), dayLight = 1 } = {}) {
      time += dt;
      // wind eases toward the market wind over ~2 s (reduced motion: no sway uses it, so it snaps — an easing
      // that nothing shows must not keep the on-demand loop awake)
      wind = reduced ? windTarget : wind + (windTarget - wind) * Math.min(1, dt / 0.7);
      sharedUniforms.uWind.value = reduced ? 0 : wind;
      // reduced motion freezes every shader clock (crop shiver, water ripples, grass) — §7.3 "the sky is static"
      if (!reduced) sharedUniforms.uTime.value = time;
      // gust wave front. Under reduced motion there is no gust: a running one ends at once, so it can never keep
      // the on-demand loop busy (the timer would otherwise freeze and busy() stay true for good, §7.3)
      if (reduced) {
        gustT = Infinity;
        sharedUniforms.uGust.value = -1000;
      } else if (gustT <= GUST.ms / 1000) {
        gustT += dt;
        sharedUniforms.uGust.value = gustFront(gustT * 1000);
      } else sharedUniforms.uGust.value = -1000;

      // clouds: drift east, fade in/out to the weather's count
      const drift = reduced ? 0 : CLOUD_DRIFT * wind * dt;
      for (let i = 0; i < MAX_CLOUDS; i++) {
        const c = slots[i];
        const want = i < cloudN ? 1 : 0;
        c.k = reduced ? want : c.k + (want - c.k) * Math.min(1, dt / 1.2);
        c.x += drift * c.speed;
        if (c.x > SPAN / 2) c.x -= SPAN;
      }
      writeClouds();
      cloudTint.lerp(cloudTintTo, reduced ? 1 : Math.min(1, dt / 1.5));
      // clouds dim with the light (weather) and at clock-night
      cMat.color.copy(cloudTint).multiplyScalar(0.3 + 0.7 * dayLight);
      cMat.emissive.copy(cloudTint).multiplyScalar(0.2 + 0.8 * dayLight);

      // rain
      rainK += ((reduced ? 0 : rainTarget) - rainK) * Math.min(1, dt / 1.5);
      rain.visible = rainK > 0.01;
      rain.material.uniforms.uTime.value = time;
      rain.material.uniforms.uWind.value = wind;
      rain.material.uniforms.uOpacity.value = 0.42 * rainK;

      // lightning (storm only, never in reduced motion)
      const ev = lightning.poll(nowMs, key === 'storm' && !reduced);
      if (ev) {
        sky?.flash(ev.strength);
        boltT = 0;
        bolt.position.set(-30 + Math.random() * 60, -18, -175);
        bolt.rotation.set(0, 0, (Math.random() - 0.5) * 0.3);
        for (const fn of [...lightningFns]) {
          try {
            fn(ev);
          } catch (e) {
            globalThis.console?.error?.(e);
          }
        }
      }
      if (boltT < 0.12) {
        boltT += dt;
        bolt.visible = true;
        bolt.material.opacity = 0.75 * (1 - boltT / 0.12);
      } else bolt.visible = false;

      return rain.visible || gustT <= GUST.ms / 1000 || Math.abs(windTarget - wind) > 0.01;
    },
    dispose() {
      cGeo.dispose();
      cMat.dispose();
      rain.geometry.dispose();
      rain.material.dispose();
      bolt.geometry.dispose();
      bolt.material.dispose();
      lightningFns.clear();
      group.removeFromParent();
    },
  };
  weather.setWeather('sunny');
  for (const c of slots) c.k = 0;
  for (let i = 0; i < cloudN; i++) slots[i].k = 1;
  writeClouds();
  return weather;
}

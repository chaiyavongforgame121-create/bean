/**
 * world/critters.js — plot critters and ambient life (WP3; GAME-DESIGN §3.3 cue 3, §4.5 "Critters").
 *
 *   createCritters({ puffs, maxSlots }) → Critters
 *   Critters = {
 *     group,
 *     sync(views, count)          PlotView map → butterflies over healthy growing plots (≤ 6, P2) and, when
 *                                 enabled, a bluebird on every LONG plot / a mole beside every SHORT plot (§3.3)
 *     setPlotCritters(b)          per-plot bird/mole on (default OFF: WP4's plots draw them on their signs)
 *     (fireflies glow over the meadow at clock-night — env.night — P2)
 *     setPlot(slot, side)         the same for one plot (1 long, −1 short, 0 none)
 *     setAnchor(slot, obj|null)   optional perch: the plot's arrow-sign Object3D (WP4); default = back-left rim
 *     hop(slot)                   flip cue: the critter hops (swap plays automatically when the side flips)
 *     setEnabled(b), update(dt, env) → busy, dispose()
 *   }
 *
 * The bird/mole is only a mnemonic: the words (LONG ↑ / SHORT ↓) and the arrow sign stay the primary cues (J6/J7).
 * Bird blue is the side colour, so birds appear ONLY on LONG plots; nothing else in the scenery is that blue.
 * Every animal is off on the Low tier, with "Farmer & animals" off, and in reduced motion (§4.5, §7.3).
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Object3D,
  Points,
  ShaderMaterial,
  Vector3,
} from '../three.js';
import { box, cone, flat, lowpolySphere, merge, paint, prism } from '../gfx/geom.js';
import { propMaterial } from '../gfx/materials.js';
import { PAL } from '../gfx/palette.js';
import { slotXZ } from './logic.js';
import { clamp, hash2, rng } from './noise.js';
import { grassDensity, heightAt, pathSet } from './terrain.js';

const TAU = Math.PI * 2;

const WING = 0x4a7cc0;

function birdGeometry() {
  return merge([
    lowpolySphere(0.11, 1, { jitter: 0.05, seed: 1, squash: [0.9, 0.85, 1.25], color: PAL.bluebird, t: { p: [0, 0.11, 0] } }),
    lowpolySphere(0.085, 0, { jitter: 0.04, seed: 2, color: PAL.bluebirdBelly, t: { p: [0, 0.085, 0.06], s: [0.8, 0.8, 0.9] } }),
    lowpolySphere(0.075, 1, { jitter: 0.04, seed: 3, color: PAL.bluebird, t: { p: [0, 0.23, 0.08] } }),
    flat(cone(0.025, 0.08, 4, PAL.butter, { r: [Math.PI / 2, 0, 0], p: [0, 0.225, 0.15] })),
    lowpolySphere(0.016, 0, { color: 0x2d2620, t: { p: [0.045, 0.245, 0.12] } }),
    lowpolySphere(0.016, 0, { color: 0x2d2620, t: { p: [-0.045, 0.245, 0.12] } }),
    prism([[0, 0], [0.1, 0.03], [0.12, -0.03]], 0.02, WING, { p: [0, 0.14, -0.13], r: [0, Math.PI / 2, 0.4] }),
    box(0.03, 0.06, 0.12, WING, { p: [0.1, 0.1, -0.01], r: [0, 0, 0.3] }),
    box(0.03, 0.06, 0.12, WING, { p: [-0.1, 0.1, -0.01], r: [0, 0, -0.3] }),
  ], { dispose: true });
}

function moleGeometry() {
  return merge([
    lowpolySphere(0.15, 1, { jitter: 0.06, seed: 5, squash: [1, 1.15, 1], color: PAL.mole, t: { p: [0, 0.14, 0] } }),
    lowpolySphere(0.04, 0, { color: PAL.moleNose, t: { p: [0, 0.2, 0.15] } }),
    lowpolySphere(0.018, 0, { color: 0x1e1915, t: { p: [0.06, 0.25, 0.12] } }),
    lowpolySphere(0.018, 0, { color: 0x1e1915, t: { p: [-0.06, 0.25, 0.12] } }),
    box(0.1, 0.04, 0.06, 0xe9c2b8, { p: [0.12, 0.1, 0.1], r: [0, 0.4, 0] }),
    box(0.1, 0.04, 0.06, 0xe9c2b8, { p: [-0.12, 0.1, 0.1], r: [0, -0.4, 0] }),
  ], { dispose: true });
}

function hillGeometry() {
  const g = lowpolySphere(0.34, 1, { jitter: 0.25, seed: 9, squash: [1, 0.42, 1] });
  paint(g, (x, y, z) => (hash2(x * 9, z * 7) > 0.7 ? PAL.soilDry : PAL.soilWet));
  return g;
}

function butterflyGeometry() {
  return merge([
    prism([[0, 0], [0.16, 0.1], [0.18, -0.02], [0.08, -0.1]], 0.008, 0xffffff, { r: [Math.PI / 2, 0, 0] }),
    prism([[0, 0], [-0.16, 0.1], [-0.18, -0.02], [-0.08, -0.1]], 0.008, 0xffffff, { r: [Math.PI / 2, 0, 0] }),
    box(0.025, 0.025, 0.14, 0x3a3029, { p: [0, -0.012, -0.02] }),
  ], { dispose: true });
}

// fireflies (P2, clock-night only): soft additive points wandering over the meadow and the pond bank
const FLY_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uScale;
varying float vA;
void main() {
  vec3 p = position;
  float t = uTime * ( 0.25 + aSeed.w * 0.2 ) + aSeed.x * 40.0;
  p += vec3( sin( t ) * 0.6, sin( t * 1.7 + aSeed.y * 9.0 ) * 0.25 + 0.15, cos( t * 0.8 + aSeed.z * 7.0 ) * 0.6 );
  vA = smoothstep( 0.35, 1.0, 0.5 + 0.5 * sin( uTime * ( 1.2 + aSeed.y ) + aSeed.z * 30.0 ) );
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_PointSize = uScale * ( 0.6 + 0.4 * vA ) / max( 1.0, -mv.z );
  gl_Position = projectionMatrix * mv;
}
`;
const FLY_FRAG = /* glsl */ `
uniform float uNight;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length( c );
  float glow = smoothstep( 0.5, 0.0, d );
  gl_FragColor = vec4( vec3( 1.0, 0.93, 0.55 ) * ( 0.4 + glow ), glow * vA * uNight );
  #include <colorspace_fragment>
}
`;

function buildFireflies(n = 36) {
  const r = rng(717);
  const set = pathSet(10);
  const pos = [];
  const seed = [];
  let guard = 0;
  while (pos.length / 3 < n && guard++ < 4000) {
    const a = r() * Math.PI * 2;
    const rr = 6 + Math.sqrt(r()) * 13.5;
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    if (grassDensity(x, z, set) < 0.25) continue;
    pos.push(x, heightAt(x, z) + 0.5 + r() * 0.9, z);
    seed.push(r(), r(), r(), r());
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aSeed', new BufferAttribute(new Float32Array(seed), 4));
  const m = new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale: { value: 300 }, uNight: { value: 0 } },
    vertexShader: FLY_VERT,
    fragmentShader: FLY_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const p = new Points(g, m);
  p.name = 'fireflies';
  p.frustumCulled = false;
  p.visible = false;
  p.renderOrder = 6;
  return p;
}

function flockBirdGeometry() {
  return merge([
    prism([[0, 0], [0.42, 0.12], [0.5, 0.05]], 0.02, 0x4f5660, { r: [Math.PI / 2, 0, 0] }),
    prism([[0, 0], [-0.42, 0.12], [-0.5, 0.05]], 0.02, 0x4f5660, { r: [Math.PI / 2, 0, 0] }),
    lowpolySphere(0.07, 0, { color: 0x4f5660, squash: [0.8, 0.7, 1.6] }),
  ], { dispose: true });
}

export function createCritters({ puffs = null, maxSlots = 15, plotCritters = false } = {}) {
  // WP4's plots draw their own bird (on the arrow sign) and mole (with its molehill): the per-plot critters here
  // are an opt-in fallback (setPlotCritters(true)); butterflies and the bird flock are always ours.
  let plotOn = !!plotCritters;
  const group = new Group();
  group.name = 'critters';
  const mat = propMaterial({ vertexColors: true, toon: true });
  const mk = (geo, n, name, shadow = true) => {
    const m = new InstancedMesh(geo, mat, n);
    m.name = name;
    m.count = 0;
    m.castShadow = shadow;
    m.frustumCulled = false;
    group.add(m);
    return m;
  };
  // small critters cast no shadows (they would cost a shadow-pass draw call each for a few pixels)
  const birds = mk(birdGeometry(), maxSlots, 'bluebirds', false);
  const moles = mk(moleGeometry(), maxSlots, 'moles', false);
  const hills = mk(hillGeometry(), maxSlots, 'molehills', false);
  const flies = new InstancedMesh(butterflyGeometry(), propMaterial({ vertexColors: true, toon: true, side: 'double' }), 6);
  flies.instanceColor = new InstancedBufferAttribute(new Float32Array(18), 3);
  flies.name = 'butterflies';
  flies.count = 0;
  flies.frustumCulled = false;
  group.add(flies);
  const flock = mk(flockBirdGeometry(), 5, 'flock', false);
  const fireflies = buildFireflies();
  group.add(fireflies);

  const plots = Array.from({ length: maxSlots }, (_, i) => ({
    slot: i,
    side: 0,
    shown: 0, // which critter is visible: 1 bird, −1 mole, 0 none
    t: 0, // swap timer (0..0.3 s) when the side flips
    next: 4 + hash2(i, 1) * 8, // seconds until the next hop/dig
    act: 99, // seconds since the last hop/dig
    anchor: null,
    healthy: false,
  }));
  let count = 10;
  let enabled = true;
  let clock = 0;
  const flyCols = [PAL.butter, PAL.cream, PAL.lavender, PAL.peach, 0xffffff, PAL.blossom].map((c) => new Color(c));
  let flyTargets = [];
  const flockState = { t: -1, next: 40 + Math.random() * 50, z: 0, y: 19 };
  const o = new Object3D();
  const m4 = new Matrix4();
  const v = new Vector3();

  function perch(p) {
    if (p.anchor) {
      p.anchor.getWorldPosition(v);
      return { x: v.x, y: v.y, z: v.z };
    }
    const c = slotXZ(p.slot, count);
    return { x: c.x - 1.48, y: 0.46, z: c.z - 1.48 };
  }
  function hillAt(p) {
    const c = slotXZ(p.slot, count);
    return { x: c.x + 1.98, y: 0, z: c.z + 0.85 };
  }

  function setPlot(slot, side) {
    const p = plots[slot];
    if (!p) return;
    const s = Math.sign(Number(side) || 0);
    if (s === p.side) return;
    p.side = s;
    p.t = 0; // play the swap (hop out, hop in) over 0.3 s
  }

  function write(env) {
    let nb = 0;
    let nm = 0;
    let nh = 0;
    for (const p of plots) {
      if (!plotOn || p.slot >= count) continue;
      // swap: the old critter shrinks out in the first half, the new one pops in the second half
      const k = clamp(p.t / 0.3, 0, 1);
      const showing = k < 0.5 ? p.shown : p.side;
      if (k >= 0.5) p.shown = p.side;
      const sc = env.reduced ? 1 : k < 1 ? Math.abs(Math.cos(k * Math.PI)) : 1;
      // hop / dig animation (every 8–14 s)
      const a = p.act;
      const hop = a < 0.45 ? Math.sin((a / 0.45) * Math.PI) : 0;
      if (showing === 1) {
        const q = perch(p);
        o.position.set(q.x, q.y + hop * 0.28 + (env.reduced ? 0 : Math.sin(clock * 2 + p.slot) * 0.004), q.z);
        o.rotation.set(0, 0.6 + Math.sin(clock * 0.3 + p.slot * 1.7) * (env.reduced ? 0 : 0.5) + hop * 1.2, hop * 0.15);
        o.scale.setScalar(Math.max(0.0001, sc));
        o.updateMatrix();
        birds.setMatrixAt(nb++, m4.copy(o.matrix));
      } else if (showing === -1) {
        const q = hillAt(p);
        const poke = a < 1.2 ? Math.sin((a / 1.2) * Math.PI) : 0.35;
        o.position.set(q.x, q.y - 0.24 + poke * 0.24, q.z);
        o.rotation.set(0, -0.4 + (a < 1.2 ? Math.sin(a * 30) * 0.15 : 0), a < 1.2 ? Math.sin(a * 24) * 0.08 : 0);
        o.scale.setScalar(Math.max(0.0001, sc));
        o.updateMatrix();
        moles.setMatrixAt(nm++, m4.copy(o.matrix));
      }
      if (p.side === -1 || showing === -1) {
        const q = hillAt(p);
        o.position.set(q.x, q.y, q.z);
        o.rotation.set(0, p.slot * 1.3, 0);
        o.scale.setScalar(p.side === -1 ? 1 : Math.max(0.0001, 1 - k));
        o.updateMatrix();
        hills.setMatrixAt(nh++, m4.copy(o.matrix));
      }
    }
    birds.count = nb;
    moles.count = nm;
    hills.count = nh;
    birds.instanceMatrix.needsUpdate = true;
    moles.instanceMatrix.needsUpdate = true;
    hills.instanceMatrix.needsUpdate = true;
  }

  function writeFlies(env) {
    let n = 0;
    if (!env.reduced) {
      for (let i = 0; i < flyTargets.length && n < 6; i++) {
        const c = slotXZ(flyTargets[i], count);
        const ph = clock * (0.5 + 0.07 * i) + i * 2.1;
        o.position.set(c.x + Math.sin(ph) * 1.3, 1.3 + Math.sin(ph * 2.3) * 0.35 + i * 0.05, c.z + Math.sin(ph * 2) * 0.8);
        o.rotation.set(0, Math.atan2(Math.cos(ph) * 1.3, Math.cos(ph * 2) * 1.6), 0);
        const flap = 0.25 + 0.75 * Math.abs(Math.sin(clock * 16 + i));
        o.scale.set(flap, 1, 1);
        o.updateMatrix();
        flies.setMatrixAt(n, m4.copy(o.matrix));
        flies.setColorAt(n, flyCols[(flyTargets[i] + i) % flyCols.length]);
        n++;
      }
    }
    flies.count = n;
    if (n) {
      flies.instanceMatrix.needsUpdate = true;
      flies.instanceColor.needsUpdate = true;
    }
  }

  function writeFlock(dt, env) {
    if (env.reduced) {
      flock.count = 0;
      return;
    }
    if (flockState.t < 0) {
      flockState.next -= dt;
      if (flockState.next <= 0) {
        flockState.t = 0;
        flockState.z = -14 + Math.random() * 20;
        flockState.y = 17 + Math.random() * 4;
      }
      flock.count = 0;
      return;
    }
    flockState.t += dt;
    const x = -60 + flockState.t * 7;
    if (x > 60) {
      flockState.t = -1;
      flockState.next = 40 + Math.random() * 50;
      flock.count = 0;
      return;
    }
    const V = [[0, 0], [-1.1, -0.9], [-1.1, 0.9], [-2.2, -1.8], [-2.2, 1.8]];
    for (let i = 0; i < 5; i++) {
      o.position.set(x + V[i][0], flockState.y + Math.sin(flockState.t * 1.3 + i) * 0.2, flockState.z + V[i][1]);
      o.rotation.set(0, Math.PI / 2, 0);
      const flap = 0.35 + 0.65 * Math.abs(Math.sin(flockState.t * 7 + i * 0.6));
      o.scale.set(flap, 1, 1);
      o.updateMatrix();
      flock.setMatrixAt(i, m4.copy(o.matrix));
    }
    flock.count = 5;
    flock.instanceMatrix.needsUpdate = true;
  }

  return {
    group,
    sync(views, n) {
      count = Math.max(10, Math.min(maxSlots, Math.round(Number(n) || count)));
      const healthy = [];
      for (const p of plots) {
        const view = views ? views[p.slot] ?? views[String(p.slot)] : null;
        const growing = view && (view.state === 'growing' || view.phase === 'long' || view.phase === 'short');
        setPlot(p.slot, view && p.slot < count && view.state !== 'closed' ? view.side : 0);
        if (growing && Number(view.health) >= 0.6 && view.state !== 'paused') healthy.push(p.slot);
      }
      flyTargets = healthy.slice(0, 6);
    },
    setPlot,
    setPlotCritters(b) {
      plotOn = !!b;
    },
    get plotCritters() {
      return plotOn;
    },
    setAnchor(slot, obj) {
      if (plots[slot]) plots[slot].anchor = obj && obj.isObject3D ? obj : null;
    },
    hop(slot) {
      if (plots[slot]) plots[slot].act = 0;
    },
    setEnabled(b) {
      enabled = !!b;
      group.visible = enabled;
    },
    get enabled() {
      return enabled;
    },
    update(dt, env) {
      if (!enabled) return false;
      clock += dt;
      for (const p of plots) {
        if (p.t < 0.3) p.t += env.reduced ? 1 : dt;
        if (!env.reduced) {
          p.act += dt;
          p.next -= dt;
          if (p.next <= 0) {
            p.act = 0;
            p.next = 8 + Math.random() * 6;
            if (p.shown === -1 && puffs) {
              const q = hillAt(p);
              puffs.emit({ x: q.x, y: 0.15, z: q.z, vx: (Math.random() - 0.5) * 0.6, vy: 0.5, vz: 0.4, life: 0.8, size: 0.14, grow: 1.1, color: PAL.soilDry, drag: 1.5 });
            }
          }
        }
      }
      write(env);
      writeFlies(env);
      writeFlock(dt, env);
      // fireflies glow in at clock-night only
      const night = env.reduced ? 0 : clamp(((env.night ?? 0) - 0.35) / 0.4, 0, 1);
      fireflies.visible = night > 0.01;
      fireflies.material.uniforms.uNight.value = night;
      fireflies.material.uniforms.uTime.value = clock;
      fireflies.material.uniforms.uScale.value = 420 * Math.min(2, globalThis.devicePixelRatio || 1);
      return true;
    },
    dispose() {
      for (const m of [birds, moles, hills, flies, flock]) m.geometry.dispose();
      fireflies.geometry.dispose();
      fireflies.material.dispose();
      group.removeFromParent();
    },
  };
}

/**
 * fx/particles.js — GPU-ballistic particle pool + procedural atlas (GAME-DESIGN §4, §7.3, §7.5, §9.8).
 *
 *   createParticles(scene, { pool, reduced }) → {
 *     emit(kind, pos, n, opts) → number emitted,   // opts: { color, spread, area, delayMs, stagger, dir, speed, size }
 *     update(dt), setPool(n), clear(), busy(), dispose(), rebuild()
 *   }
 *
 * One instanced billboard quad per particle with a custom ShaderMaterial. Per-instance attributes:
 * spawn position, velocity, (birth, life, gravity, drag), (size0, size1, atlas cell, spin), colour+alpha.
 * Motion is ballistic on the GPU from `uTime` (gravity + exponential drag), so the CPU writes only on spawn,
 * into a ring buffer sized by the quality tier (High 1500 / Medium 800 / Low 300; the governor can halve it).
 * Two pools share the code: alpha-blended (dust, soil, water, leaves, smoke, hail, ash, clumps, popcorn) and
 * additive (sparkle, embers), split 75 / 25.
 *
 * Atlas: an 8-cell 256×32 CanvasTexture drawn at boot — circle, droplet, leaf, star, sparkle, clump, flame, hail.
 *
 * Reduced motion: emit() does nothing (§7.3 "No particles"); information-carrying effects are rendered as
 * static states by the executor instead. J11: nothing here is ever driven by a price tick.
 */

import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DataTexture,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  RGBAFormat,
  SRGBColorSpace,
  ShaderMaterial,
} from '../three.js';

/** Atlas cells. */
export const CELL = Object.freeze({ circle: 0, droplet: 1, leaf: 2, star: 3, sparkle: 4, clump: 5, flame: 6, hail: 7 });

/**
 * Particle recipes (§4 particle column). Velocities in u/s, life in s, gravity in u/s² (negative = down).
 * `cone`: vertical speed range; `radial`: horizontal speed range; `area`: spawn radius.
 */
export const KINDS = Object.freeze({
  dust: { cell: CELL.circle, colors: ['#E3D2B4', '#D2BC98'], size: [0.32, 0.6], grow: 1.9, life: [0.55, 0.95], up: [0.3, 0.8], radial: [0.6, 1.3], gravity: -0.4, drag: 2.6, area: 0.35, alpha: 0.75 },
  soil: { cell: CELL.clump, colors: ['#7A4E35', '#8C5E3E', '#6A4430'], size: [0.12, 0.2], grow: 0.8, life: [0.55, 0.85], up: [2.4, 3.6], radial: [0.6, 1.4], gravity: -9, drag: 0.4, area: 0.3, spin: 6 },
  droplets: { cell: CELL.droplet, colors: ['#8FD3E8', '#BFE9F5', '#6CC0DD'], size: [0.12, 0.18], grow: 0.7, life: [0.45, 0.75], up: [2.0, 3.2], radial: [0.5, 1.3], gravity: -9, drag: 0.3, area: 0.5 },
  drip: { cell: CELL.droplet, colors: ['#8FD3E8'], size: [0.08, 0.1], grow: 0.8, life: [0.45, 0.6], up: [-0.2, 0], radial: [0, 0.05], gravity: -6, drag: 0.2, area: 0.02 },
  drips: { cell: CELL.droplet, colors: ['#8FD3E8', '#6CC0DD'], size: [0.08, 0.12], grow: 0.8, life: [0.4, 0.6], up: [0.4, 1.2], radial: [0.3, 0.8], gravity: -8, drag: 0.4, area: 0.05 },
  splash: { cell: CELL.droplet, colors: ['#BFE9F5', '#8FD3E8', '#FFFFFF'], size: [0.1, 0.16], grow: 0.6, life: [0.4, 0.6], up: [1.6, 2.4], radial: [1.0, 1.6], gravity: -9, drag: 0.6, area: 0.2 },
  sparkle: { cell: CELL.sparkle, colors: ['#FFF6C8', '#FFFFFF', '#FFE48A'], size: [0.28, 0.42], grow: 0.2, life: [0.45, 0.8], up: [0.2, 0.6], radial: [0.1, 0.5], gravity: 0.4, drag: 1.5, area: 0.15, spin: 3, additive: true },
  leaves: { cell: CELL.leaf, colors: ['#B98A4A', '#A87A3E'], size: [0.2, 0.28], grow: 1, life: [2.2, 3.0], up: [0.1, 0.4], radial: [0.2, 0.6], gravity: -0.9, drag: 1.4, area: 0.1, spin: 2.5 },
  smoke: { cell: CELL.circle, colors: ['#9A9A9E', '#B5B5B8'], size: [0.45, 0.7], grow: 2.4, life: [1.2, 1.8], up: [0.4, 0.9], radial: [0.2, 0.6], gravity: 0.2, drag: 1.4, area: 0.3, alpha: 0.65 },
  cloud: { cell: CELL.circle, colors: ['#4E5562', '#5E6670', '#444A55'], size: [0.9, 1.3], grow: 1.5, life: [2.2, 2.6], up: [-0.05, 0.08], radial: [0.05, 0.25], gravity: 0, drag: 2, area: 0.7, alpha: 0.85 },
  clumps: { cell: CELL.clump, colors: ['#6B4A2E', '#5A3E26', '#7A5634'], size: [0.18, 0.26], grow: 0.8, life: [0.7, 1.0], up: [2.2, 3.4], radial: [0.6, 1.4], gravity: -9, drag: 0.4, area: 0.3, spin: 5 },
  popcorn: { cell: CELL.star, colors: ['#FFF7DC', '#F7E3A1', '#FFFFFF'], size: [0.16, 0.24], grow: 1.1, life: [0.9, 1.4], up: [3.6, 5.2], radial: [0.8, 1.8], gravity: -9, drag: 0.3, area: 0.4, spin: 8 },
  hail: { cell: CELL.hail, colors: ['#E8F4FF', '#FFFFFF', '#CFE3F2'], size: [0.1, 0.15], grow: 0.9, life: [0.45, 0.65], up: [-7.5, -5.5], radial: [0, 0.3], gravity: -12, drag: 0, area: 1.4 },
  embers: { cell: CELL.flame, colors: ['#FF9A3C', '#FFC75A', '#FF7A2A'], size: [0.14, 0.24], grow: 0.4, life: [0.8, 1.4], up: [1.6, 3.2], radial: [0.3, 0.9], gravity: 0.5, drag: 1.0, area: 1.2, spin: 2, additive: true },
  ash: { cell: CELL.circle, colors: ['#6D6560', '#9A928C', '#4F4844'], size: [0.07, 0.13], grow: 1, life: [2.4, 3.2], up: [-0.4, 0.1], radial: [0.1, 0.4], gravity: -0.35, drag: 1.5, area: 2.2, alpha: 0.9, spin: 1 },
  sunbeam: { cell: CELL.sparkle, colors: ['#FFF3B0', '#FFFFFF'], size: [0.2, 0.3], grow: 0.3, life: [0.6, 1.0], up: [-0.6, -0.2], radial: [0, 0.2], gravity: 0, drag: 1, area: 0.9, additive: true },
});

// ------------------------------------------------------------------ atlas

let atlasTex = null;

/** 8-cell 256×32 atlas (white shapes on transparent), drawn once at boot. */
export function particleAtlas() {
  if (atlasTex) return atlasTex;
  const doc = globalThis.document;
  if (!doc) {
    atlasTex = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat);
    atlasTex.needsUpdate = true;
    return atlasTex;
  }
  const c = doc.createElement('canvas');
  c.width = 256;
  c.height = 32;
  const g = c.getContext('2d');
  const cell = (i, fn) => {
    g.save();
    g.translate(i * 32 + 16, 16);
    fn();
    g.restore();
  };
  const soft = (r, inner = 0.4) => {
    const grd = g.createRadialGradient(0, 0, r * inner, 0, 0, r);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    return grd;
  };
  // 0 circle (soft puff)
  cell(0, () => {
    g.fillStyle = soft(15, 0.25);
    g.beginPath();
    g.arc(0, 0, 15, 0, Math.PI * 2);
    g.fill();
  });
  // 1 droplet
  cell(1, () => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(0, -13);
    g.bezierCurveTo(7, -3, 9, 4, 0, 11);
    g.bezierCurveTo(-9, 4, -7, -3, 0, -13);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.6)';
  });
  // 2 leaf
  cell(2, () => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(-12, 8);
    g.quadraticCurveTo(-8, -12, 12, -10);
    g.quadraticCurveTo(8, 10, -12, 8);
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(-10, 7);
    g.lineTo(10, -8);
    g.stroke();
  });
  // 3 star (popcorn puff: lumpy)
  cell(3, () => {
    g.fillStyle = '#fff';
    for (const [x, y, r] of [[0, 0, 8], [-6, -4, 6], [6, -3, 6], [-3, 6, 6], [5, 5, 5]]) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  });
  // 4 sparkle (4-point glint with glow)
  cell(4, () => {
    g.fillStyle = soft(9, 0.1);
    g.beginPath();
    g.arc(0, 0, 9, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(0, -15);
    g.quadraticCurveTo(1.5, -1.5, 15, 0);
    g.quadraticCurveTo(1.5, 1.5, 0, 15);
    g.quadraticCurveTo(-1.5, 1.5, -15, 0);
    g.quadraticCurveTo(-1.5, -1.5, 0, -15);
    g.fill();
  });
  // 5 clump (irregular soil blob)
  cell(5, () => {
    g.fillStyle = '#fff';
    g.beginPath();
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 10 + ((i * 37) % 5);
      if (i === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.fill();
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.beginPath();
    g.arc(3, 3, 5, 0, Math.PI * 2);
    g.fill();
  });
  // 6 flame (soft teardrop)
  cell(6, () => {
    const grd = g.createRadialGradient(0, 4, 1, 0, 2, 13);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(0, -14);
    g.bezierCurveTo(9, -2, 10, 8, 0, 13);
    g.bezierCurveTo(-10, 8, -9, -2, 0, -14);
    g.fill();
  });
  // 7 hail (round ice with a highlight)
  cell(7, () => {
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath();
    g.arc(0, 0, 10, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(200,220,235,1)';
    g.beginPath();
    g.arc(3, 3, 5, 0, Math.PI * 2);
    g.fill();
  });
  atlasTex = new CanvasTexture(c);
  atlasTex.colorSpace = SRGBColorSpace;
  atlasTex.minFilter = LinearFilter;
  atlasTex.magFilter = LinearFilter;
  atlasTex.generateMipmaps = false;
  return atlasTex;
}

// ------------------------------------------------------------------ shader

const VERT = /* glsl */ `
attribute vec3 aP0;
attribute vec3 aV0;
attribute vec4 aT;   // birth, life, gravity, drag
attribute vec4 aS;   // size0, size1, cell, spin
attribute vec4 aC;   // rgb (linear), alpha
uniform float uTime;
varying vec2 vUv;
varying vec4 vColor;
varying float vCell;
void main() {
  float age = uTime - aT.x;
  if ( age < 0.0 || age > aT.y ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    vColor = vec4( 0.0 );
    return;
  }
  float k = age / aT.y;
  float drag = aT.w;
  float d = drag > 0.001 ? ( 1.0 - exp( -drag * age ) ) / drag : age;
  vec3 p = aP0 + aV0 * d + vec3( 0.0, 0.5 * aT.z * age * age, 0.0 );
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  float size = mix( aS.x, aS.y, k );
  float ang = aS.w * age;
  float cs = cos( ang );
  float sn = sin( ang );
  vec2 c = position.xy;
  c = vec2( c.x * cs - c.y * sn, c.x * sn + c.y * cs );
  mv.xy += c * size;
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vCell = aS.z;
  float fade = smoothstep( 0.0, 0.06, k ) * ( 1.0 - smoothstep( 0.65, 1.0, k ) );
  vColor = vec4( aC.rgb, aC.a * fade );
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec4 vColor;
varying float vCell;
void main() {
  vec2 uv = vec2( ( floor( vCell + 0.5 ) + clamp( vUv.x, 0.02, 0.98 ) ) / 8.0, vUv.y );
  vec4 tex = texture2D( uAtlas, uv );
  float a = vColor.a * tex.a;
  if ( a < 0.01 ) discard;
  gl_FragColor = vec4( vColor.rgb * tex.rgb, a );
  #include <colorspace_fragment>
}
`;

function makePool(scene, size, additive) {
  const n = Math.max(16, size | 0);
  const quad = new PlaneGeometry(1, 1);
  const geo = new InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);
  const attr = (name, size2) => {
    const a = new InstancedBufferAttribute(new Float32Array(n * size2), size2);
    a.setUsage(DynamicDrawUsage);
    geo.setAttribute(name, a);
    return a;
  };
  const A = { aP0: attr('aP0', 3), aV0: attr('aV0', 3), aT: attr('aT', 4), aS: attr('aS', 4), aC: attr('aC', 4) };
  // every slot starts dead (born in the far past with zero life)
  for (let i = 0; i < n; i++) A.aT.array[i * 4] = -1e6;
  geo.instanceCount = n;
  const uniforms = { uTime: { value: 0 }, uAtlas: { value: particleAtlas() } };
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: additive ? AdditiveBlending : NormalBlending,
  });
  const mesh = new Mesh(geo, mat);
  mesh.name = additive ? 'fx:particles+' : 'fx:particles';
  mesh.frustumCulled = false;
  mesh.renderOrder = additive ? 6 : 5;
  scene.add(mesh);
  return { mesh, geo, mat, A, n, head: 0, lo: Infinity, hi: -1, uniforms, lastDeath: 0 };
}

const _c = new Color();
const rnd = (a, b) => a + Math.random() * (b - a);

/** createParticles(scene, { pool, reduced }) — see the header. */
export function createParticles(scene, { pool = 1500, reduced = () => false } = {}) {
  let size = pool;
  let main = makePool(scene, Math.round(size * 0.75), false);
  let glow = makePool(scene, Math.round(size * 0.25), true);
  let time = 0;

  function write(P, i, p0, v0, birth, life, gravity, drag, s0, s1, cell, spin, color, alpha) {
    P.A.aP0.array.set([p0.x, p0.y, p0.z], i * 3);
    P.A.aV0.array.set([v0.x, v0.y, v0.z], i * 3);
    P.A.aT.array.set([birth, life, gravity, drag], i * 4);
    P.A.aS.array.set([s0, s1, cell, spin], i * 4);
    P.A.aC.array.set([color.r, color.g, color.b, alpha], i * 4);
    if (i < P.lo) P.lo = i;
    if (i > P.hi) P.hi = i;
    P.lastDeath = Math.max(P.lastDeath, birth + life);
  }

  /**
   * Spawn n particles of a kind at a world position (Vector3 or {x,y,z}).
   * opts: { color (hex or [hex]), area (spawn radius), delayMs, stagger (ms between births), dir {x,y,z} (extra
   *        velocity), speed (multiplier), size (multiplier), up (override vertical range) }
   */
  function emit(kind, pos, n = 1, opts = {}) {
    if (reduced() || !pos) return 0;
    const K = KINDS[kind] || KINDS.dust;
    const P = K.additive ? glow : main;
    const count = Math.max(0, Math.min(n | 0, P.n));
    const colors = opts.color ? (Array.isArray(opts.color) ? opts.color : [opts.color]) : K.colors;
    const area = opts.area ?? K.area ?? 0.2;
    const sp = opts.speed ?? 1;
    const sz = opts.size ?? 1;
    const up = opts.up || K.up;
    const delay = (opts.delayMs || 0) / 1000;
    const stagger = (opts.stagger || 0) / 1000;
    const p0 = { x: 0, y: 0, z: 0 };
    const v0 = { x: 0, y: 0, z: 0 };
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * area;
      p0.x = pos.x + Math.cos(a) * rr;
      p0.y = pos.y + (kind === 'ash' || kind === 'hail' ? Math.random() * 0.6 : 0);
      p0.z = pos.z + Math.sin(a) * rr;
      const b = Math.random() * Math.PI * 2;
      const h = rnd(K.radial[0], K.radial[1]) * sp;
      v0.x = Math.cos(b) * h + (opts.dir?.x || 0);
      v0.y = rnd(up[0], up[1]) * sp + (opts.dir?.y || 0);
      v0.z = Math.sin(b) * h + (opts.dir?.z || 0);
      const life = rnd(K.life[0], K.life[1]);
      const s0 = rnd(K.size[0], K.size[1]) * sz;
      _c.set(colors[(Math.random() * colors.length) | 0]);
      const spin = (K.spin || 0) * (Math.random() < 0.5 ? -1 : 1) * rnd(0.5, 1);
      write(P, P.head, p0, v0, time + delay + k * stagger, life, K.gravity, K.drag, s0, s0 * (K.grow ?? 1), K.cell, spin, _c, K.alpha ?? 1);
      P.head = (P.head + 1) % P.n;
    }
    return count;
  }

  function flush(P) {
    if (P.hi < 0) return;
    for (const [name, a] of Object.entries(P.A)) {
      const s = a.itemSize;
      a.clearUpdateRanges?.();
      if (a.addUpdateRange) a.addUpdateRange(P.lo * s, (P.hi - P.lo + 1) * s);
      a.needsUpdate = true;
      void name;
    }
    P.lo = Infinity;
    P.hi = -1;
  }

  return {
    emit,
    update(dt) {
      time += Math.min(0.1, Math.max(0, Number(dt) || 0));
      main.uniforms.uTime.value = time;
      glow.uniforms.uTime.value = time;
      flush(main);
      flush(glow);
      main.mesh.visible = main.lastDeath > time;
      glow.mesh.visible = glow.lastDeath > time;
    },
    /** Governor step "particles halved" / tier change: rebuild the pools at a new total size. */
    setPool(n) {
      const next = Math.max(64, n | 0);
      if (next === size) return;
      size = next;
      for (const P of [main, glow]) {
        P.mesh.removeFromParent();
        P.geo.dispose();
        P.mat.dispose();
      }
      main = makePool(scene, Math.round(size * 0.75), false);
      glow = makePool(scene, Math.round(size * 0.25), true);
    },
    get size() {
      return size;
    },
    get time() {
      return time;
    },
    /** True while any particle is alive. */
    busy() {
      return main.lastDeath > time || glow.lastDeath > time;
    },
    clear() {
      for (const P of [main, glow]) {
        for (let i = 0; i < P.n; i++) P.A.aT.array[i * 4] = -1e6;
        P.lo = 0;
        P.hi = P.n - 1;
        P.lastDeath = 0;
        flush(P);
      }
    },
    rebuild() {
      if (atlasTex) atlasTex.needsUpdate = true;
      for (const P of [main, glow]) for (const a of Object.values(P.A)) a.needsUpdate = true;
    },
    dispose() {
      for (const P of [main, glow]) {
        P.mesh.removeFromParent();
        P.geo.dispose();
        P.mat.dispose();
      }
      atlasTex?.dispose();
      atlasTex = null;
    },
  };
}

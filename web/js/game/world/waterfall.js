/**
 * world/waterfall.js — a little stream from the pond's east bank that spills over the rim as a waterfall
 * (WP3; GAME-DESIGN §2.4 "Decor … waterfall (SE rim, P2)", §4.5 "Waterfall particles (P2)").
 *
 *   createWaterfall() → { group, base: Vector3, setLight(k), dispose() }
 *
 * Two ribbons (stream on the ground, a free-falling sheet off the cliff) share one unlit, fogged material whose
 * streaks scroll with the shared shader clock (frozen in reduced motion). The sheet fades out into the cloud
 * sea; world.js puffs a little mist at `base`. Pure decoration: it carries no data.
 */
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, Vector3 } from '../three.js';
import { sharedUniforms } from '../gfx/materials.js';
import { PAL } from '../gfx/palette.js';
import { STREAM, heightAt, smoothLine } from './terrain.js';

const VERT_DECL = /* glsl */ `
attribute vec3 aFlow; // u across, v along the flow (u), fall share 0..1
varying vec3 vFlow;
`;
const FRAG_DECL = /* glsl */ `
uniform float uTime;
uniform float uLight;
uniform vec3 uWater;
uniform vec3 uFoam;
varying vec3 vFlow;
`;
const FRAG = /* glsl */ `
#include <color_fragment>
{
  float u = vFlow.x;
  float v = vFlow.y;
  float fall = vFlow.z;
  float speed = mix( 0.9, 3.4, step( 0.001, fall ) );
  float edge = smoothstep( 0.0, 0.2, u ) * smoothstep( 1.0, 0.8, u );
  float wob = sin( u * 11.0 + v * 1.7 ) * 0.25;
  float streak = smoothstep( 0.6, 1.0, 0.5 + 0.5 * sin( ( v * ( fall > 0.0 ? 1.3 : 3.0 ) - uTime * speed + wob ) * 6.2831 ) );
  vec3 c = mix( uWater, uFoam, clamp( streak * 0.6 + ( 1.0 - edge ) * 0.55 + fall * 0.35, 0.0, 1.0 ) );
  diffuseColor.rgb = c * uLight;
  float fade = 1.0 - smoothstep( 0.55, 1.0, fall );
  diffuseColor.a *= mix( 0.92, 0.8, step( 0.001, fall ) ) * fade * mix( 1.0, edge, 0.5 );
}
`;

/** Ribbon geometry along a polyline of {p: Vector3, side: Vector3 (unit, across), w, v, fall}. */
function ribbon(samples) {
  const pos = [];
  const flow = [];
  const idx = [];
  samples.forEach((s, i) => {
    const h = s.w / 2;
    pos.push(s.p.x - s.side.x * h, s.p.y - s.side.y * h, s.p.z - s.side.z * h, s.p.x + s.side.x * h, s.p.y + s.side.y * h, s.p.z + s.side.z * h);
    flow.push(0, s.v, s.fall, 1, s.v, s.fall);
    if (i) {
      const a = (i - 1) * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aFlow', new BufferAttribute(new Float32Array(flow), 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export function createWaterfall() {
  const group = new Group();
  group.name = 'waterfall';
  const uniforms = { uTime: sharedUniforms.uTime, uLight: { value: 1 }, uWater: { value: new Color(PAL.water) }, uFoam: { value: new Color(PAL.waterFoam) } };
  const mat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: DoubleSide });
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader.replace('#include <common>', `#include <common>\n${VERT_DECL}`).replace('#include <begin_vertex>', '#include <begin_vertex>\nvFlow = aFlow;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>\n${FRAG_DECL}`).replace('#include <color_fragment>', FRAG);
  };
  mat.customProgramCacheKey = () => 'bean-waterfall-v1';

  // stream on the ground (follows the terrain 3.5 cm above it)
  const pts = smoothLine(STREAM.map((p) => [p[0], p[1]]), 0.25);
  const stream = [];
  let v = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i];
    const [nx, nz] = pts[Math.min(pts.length - 1, i + 1)];
    const [px, pz] = pts[Math.max(0, i - 1)];
    const dir = new Vector3(nx - px, 0, nz - pz).normalize();
    if (i) v += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
    stream.push({ p: new Vector3(x, heightAt(x, z) + 0.035, z), side: new Vector3(-dir.z, 0, dir.x), w: 0.62 - 0.12 * (i / pts.length), v, fall: 0 });
  }
  // free-falling sheet off the rim: a gentle outward parabola, widening and fading into the clouds
  const last = stream[stream.length - 1];
  const out = new Vector3(last.p.x, 0, last.p.z).normalize();
  const across = last.side.clone();
  const fall = [];
  const N = 18;
  const drop = 8.6;
  for (let i = 0; i <= N; i++) {
    const k = i / N;
    const dy = k * drop;
    const p = new Vector3(last.p.x, last.p.y - dy, last.p.z).addScaledVector(out, 0.35 * Math.sqrt(dy) + 0.05);
    fall.push({ p, side: across, w: 0.52 + 0.55 * k, v: v + dy, fall: Math.max(0.002, k) });
  }
  const streamMesh = new Mesh(ribbon(stream), mat);
  streamMesh.name = 'stream';
  streamMesh.renderOrder = 3;
  const fallMesh = new Mesh(ribbon(fall), mat);
  fallMesh.name = 'waterfallSheet';
  fallMesh.renderOrder = 3;
  group.add(streamMesh, fallMesh);
  const base = fall[Math.floor(N * 0.62)].p.clone();

  return {
    group,
    base,
    top: last.p.clone(),
    setLight(k) {
      uniforms.uLight.value = Math.max(0.25, Math.min(1.1, Number(k) || 1));
    },
    dispose() {
      streamMesh.geometry.dispose();
      fallMesh.geometry.dispose();
      mat.dispose();
      group.removeFromParent();
    },
  };
}

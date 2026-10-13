/**
 * gfx/materials.js — toon gradient, shared materials, the crop shader patch and its depth twin (WP3).
 * GAME-DESIGN §3.1 "Shared crop shading", §3.4, §9.7, §9.8.
 *
 * Contract exports (§9.7):
 *   toonGradient() → DataTexture                       3-band 3×1 NearestFilter ramp (shared singleton)
 *   cropMaterial({ lush, sick, dead }) → { material, depthMaterial, uniforms }
 *   propMaterial(colorHex | { vertexColors: true, … }) → Material   (cached by key)
 * Extras: sharedUniforms, foliageMaterial(), grassMaterial(), outlineMaterial(), blobTexture(),
 *         disposeMaterials(), refreshMaterials().
 *
 * ── Crop material contract (for WP4 builders / plots) ─────────────────────────────────────────────
 * Geometry attributes (missing attributes read as 0):
 *   color  (vec3)  vertex colour, LINEAR. Author leaves in the crop's lush hex (with AO/variation);
 *                  the shader re-tints them by health. Stems keep their colour and brown at half strength.
 *   aLeaf  (float) 1 = leaf, 0 = stem/trunk.
 *   aH     (float) normalised height 0..1 (geom.heightAttr) — drives droop, sway and frost creep.
 * Per-plot uniforms (`uniforms.<name>.value`), defaults in brackets:
 *   uSize [1]        shader-side uniform scale about the crop origin (leave 1 if you scale the group instead)
 *   uHealth [1]      0..1 → leaf tint, mirroring plant.js healthTone() (lush ≥ 0.6 → sick @ 0.2 → dead)
 *   uDroop [0]       §3.4: smoothstep(0.6, 0, health)·0.7; pos.xz += lean·uDroop·w·h, pos.y −= uDroop·w·0.4h, w = aH²
 *   uLean [(0, 1)]   vec2 droop direction in the crop's local XZ (normalised in the shader)
 *   uSway [0]        sway amplitude (rad) from leverage: 0.04 + 0.025·log2(lev) (§3.2)
 *   uShiver [0]      7 Hz shiver amplitude (rad): 0.004·log2(lev)
 *   uFrost [0]       0..0.6 white rime creeping up from the base (liquidation danger)
 *   uSat [1]         saturation multiplier (paused 0.7, focus-dim 0.85); also dims brightness slightly
 *   uHeight [0]      crop height in local units for the droop maths; 0 = derive per vertex from y / aH
 *   uLush, uSick, uDead  THREE.Color tones (set via the factory arguments)
 * Shared uniforms (same object in every crop, grass and tree material; world.update() drives them):
 *   uTime (s), uWind (windFactor; 0 under reduced motion), uGust (gust wave-front x in world units; −1000 = none)
 * Sway = sin(uTime·1.2 + φ)·uSway·uWind + sin(uTime·2π·7 + φ)·uShiver (+ gust bend); φ comes from the
 * crop's world position, so no per-plot phase uniform is needed.
 * The SAME vertex patch runs in `depthMaterial` — assign it as `mesh.customDepthMaterial` so shadows bend too.
 * customProgramCacheKey is constant, so all per-plot clones share one GPU program.
 */
import {
  BackSide,
  CanvasTexture,
  Color,
  DataTexture,
  DoubleSide,
  FrontSide,
  LinearFilter,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshLambertMaterial,
  MeshToonMaterial,
  NearestFilter,
  RedFormat,
  RGBADepthPacking,
  SRGBColorSpace,
  Vector2,
} from '../three.js';
import { CROP_TONES } from './palette.js';

/** Uniforms shared by every wind-driven material. world.update() writes them once per frame. */
export const sharedUniforms = {
  uTime: { value: 0 },
  uWind: { value: 1 },
  uGust: { value: -1000 },
};

const created = new Set(); // every material/texture we made (for dispose / context-restore refresh)
const track = (x) => {
  created.add(x);
  return x;
};

// ------------------------------------------------------------------ toon ramp

let gradient = null;

/** 3-band toon ramp (3×1 DataTexture, NearestFilter). Bands: core shadow, half-light, lit. */
export function toonGradient() {
  if (gradient) return gradient;
  const data = new Uint8Array([118, 192, 255]);
  gradient = new DataTexture(data, 3, 1, RedFormat);
  gradient.minFilter = NearestFilter;
  gradient.magFilter = NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return track(gradient);
}

// ------------------------------------------------------------------ crop shader patch

const CROP_KEY = 'bean-crop-v1';

const VERT_DECL = /* glsl */ `
attribute float aLeaf;
attribute float aH;
uniform float uSize;
uniform float uDroop;
uniform float uSway;
uniform float uShiver;
uniform float uHeight;
uniform vec2 uLean;
uniform float uTime;
uniform float uWind;
uniform float uGust;
#ifndef BEAN_DEPTH
varying float vLeaf;
varying float vH;
#endif
`;

const VERT_BODY = /* glsl */ `
vec3 transformed = vec3( position );
{
  #ifndef BEAN_DEPTH
  vLeaf = aLeaf;
  vH = aH;
  #endif
  #ifdef USE_INSTANCING
  vec3 bWorld = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  #else
  vec3 bWorld = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  #endif
  float hgt = uHeight > 0.0 ? uHeight : position.y / max( aH, 0.05 );
  float w = aH * aH;
  vec2 lean = length( uLean ) > 1e-4 ? normalize( uLean ) : vec2( 0.0, 1.0 );
  transformed.xz += lean * uDroop * w * hgt;
  transformed.y -= uDroop * w * 0.4 * hgt;
  float ph = bWorld.x * 0.37 + bWorld.z * 0.61;
  float gustK = uGust > -999.0 ? exp( -pow( ( bWorld.x - uGust ) / 4.0, 2.0 ) ) : 0.0;
  float a = sin( uTime * 1.2 + ph ) * uSway * uWind
          + sin( uTime * 43.982 + ph * 3.0 ) * uShiver
          + gustK * 0.22 * min( uWind, 1.5 );
  float b = sin( uTime * 0.93 + ph * 1.7 ) * uSway * uWind * 0.35;
  transformed.x += a * w * hgt;
  transformed.z += b * w * hgt;
  transformed.y -= 0.5 * ( a * a + b * b ) * w * hgt;
  transformed *= uSize;
}
`;

const FRAG_DECL = /* glsl */ `
uniform float uHealth;
uniform float uFrost;
uniform float uSat;
uniform vec3 uLush;
uniform vec3 uSick;
uniform vec3 uDead;
varying float vLeaf;
varying float vH;
vec3 beanHealthTone( float h ) {
  if ( h >= 0.6 ) return uLush;
  if ( h >= 0.2 ) return mix( uSick, uLush, ( h - 0.2 ) / 0.4 );
  return mix( uDead, uSick, ( h / 0.2 ) * 0.35 );
}
`;

const FRAG_BODY = /* glsl */ `
#include <color_fragment>
{
  vec3 ratio = beanHealthTone( clamp( uHealth, 0.0, 1.0 ) ) / max( uLush, vec3( 0.02 ) );
  vec3 tintK = mix( mix( vec3( 1.0 ), ratio, 0.5 ), ratio, clamp( vLeaf, 0.0, 1.0 ) );
  diffuseColor.rgb *= tintK;
  float creep = uFrost / 0.6;
  float fr = uFrost * ( 1.0 - smoothstep( creep - 0.15, creep + 0.05, vH ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.86, 0.93, 1.0 ), clamp( fr, 0.0, 0.75 ) );
  float l = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  diffuseColor.rgb = mix( vec3( l ), diffuseColor.rgb, uSat ) * ( 0.85 + 0.15 * clamp( uSat, 0.0, 1.0 ) );
}
`;

function patchCropVertex(src, depth) {
  return src
    .replace('#include <common>', `#include <common>\n${depth ? '#define BEAN_DEPTH\n' : ''}${VERT_DECL}`)
    .replace('#include <begin_vertex>', VERT_BODY);
}

function patchCropFragment(src) {
  return src.replace('#include <common>', `#include <common>\n${FRAG_DECL}`).replace('#include <color_fragment>', FRAG_BODY);
}

/**
 * A crop material (per plot) plus its depth twin. All clones share one program (constant cache key).
 * @param {{lush?: number, sick?: number, dead?: number, height?: number, side?: number}} o
 */
export function cropMaterial({ lush = 0x62bc5c, sick = CROP_TONES.sick, dead = CROP_TONES.dead, height = 0, side = DoubleSide } = {}) {
  const uniforms = {
    uSize: { value: 1 },
    uHealth: { value: 1 },
    uDroop: { value: 0 },
    uSway: { value: 0 },
    uShiver: { value: 0 },
    uLean: { value: new Vector2(0, 1) },
    uFrost: { value: 0 },
    uSat: { value: 1 },
    uHeight: { value: height },
    uLush: { value: new Color(lush) },
    uSick: { value: new Color(sick) },
    uDead: { value: new Color(dead) },
    uTime: sharedUniforms.uTime,
    uWind: sharedUniforms.uWind,
    uGust: sharedUniforms.uGust,
  };
  const material = new MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient(), side });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = patchCropVertex(shader.vertexShader, false);
    shader.fragmentShader = patchCropFragment(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => CROP_KEY;
  material.userData.uniforms = uniforms;

  const depthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, side });
  depthMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = patchCropVertex(shader.vertexShader, true);
  };
  depthMaterial.customProgramCacheKey = () => `${CROP_KEY}-depth`;
  track(material);
  track(depthMaterial);
  return { material, depthMaterial, uniforms };
}

// ------------------------------------------------------------------ wind-driven foliage (grass, trees, reeds)

const FOLIAGE_DECL = /* glsl */ `
attribute float aH;
uniform float uTime;
uniform float uWind;
uniform float uGust;
uniform float uBend;
`;

/**
 * Bend in the wind: offset ∝ aH² (aH absent → 0, rigid). Instancing-aware (grass tufts). The wind blows
 * from the west (+X) in WORLD space: the world axes are expressed in the instance/model's local frame
 * (row-vector multiply = transpose of the rotation), so randomly yawed tufts all lean the same way.
 */
const FOLIAGE_BODY = /* glsl */ `
vec3 transformed = vec3( position );
{
  #ifdef USE_INSTANCING
  mat4 fM = modelMatrix * instanceMatrix;
  #else
  mat4 fM = modelMatrix;
  #endif
  vec3 fWorld = ( fM * vec4( transformed, 1.0 ) ).xyz;
  vec3 wX = ( vec4( 1.0, 0.0, 0.0, 0.0 ) * fM ).xyz;
  vec3 wZ = ( vec4( 0.0, 0.0, 1.0, 0.0 ) * fM ).xyz;
  float sc = max( dot( wX, wX ), 1e-4 );
  wX /= sc;
  wZ /= sc;
  float w = aH * aH;
  float ph = fWorld.x * 0.21 + fWorld.z * 0.17;
  float wave = sin( uTime * 1.6 + ph ) * 0.6 + sin( uTime * 2.7 + ph * 2.3 ) * 0.25 + 0.35;
  float gustK = uGust > -999.0 ? exp( -pow( ( fWorld.x - uGust ) / 3.5, 2.0 ) ) : 0.0;
  float bend = uBend * ( wave * uWind + gustK * 2.2 * max( uWind, 0.6 ) );
  float side = uBend * 0.35 * sin( uTime * 1.1 + ph * 1.3 ) * uWind;
  transformed += ( wX * bend + wZ * side ) * w;
  transformed.y -= 0.35 * bend * bend * w;
}
`;

const foliageCache = new Map();

/**
 * Lambert material that bends with the shared wind. `bend` is the tip offset (u) at windFactor 1.
 * Shares one program per (bend-independent) variant; bend is a per-material uniform.
 */
export function foliageMaterial({ bend = 0.18, vertexColors = true, color = 0xffffff, side = FrontSide, toon = false } = {}) {
  const key = `${bend}|${vertexColors}|${color}|${side}|${toon}`;
  if (foliageCache.has(key)) return foliageCache.get(key);
  const uBend = { value: bend };
  const opts = { vertexColors, color, side };
  const material = toon ? new MeshToonMaterial({ ...opts, gradientMap: toonGradient() }) : new MeshLambertMaterial(opts);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sharedUniforms, { uBend });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FOLIAGE_DECL}`)
      .replace('#include <begin_vertex>', FOLIAGE_BODY);
  };
  material.customProgramCacheKey = () => `bean-foliage-${toon ? 't' : 'l'}`;
  material.userData.uBend = uBend;
  foliageCache.set(key, track(material));
  return material;
}

/** Grass tufts: double-sided Lambert with up-facing normals baked into the geometry (matches the terrain). */
export function grassMaterial() {
  return foliageMaterial({ bend: 0.16, vertexColors: true, side: DoubleSide });
}

// ------------------------------------------------------------------ props

const propCache = new Map();

/**
 * Shared, cached prop material.
 *   propMaterial(0xC98A4B)                 → MeshToonMaterial (landmark style)
 *   propMaterial({ vertexColors: true })   → MeshLambertMaterial with vertex colours (terrain / props)
 *   propMaterial({ vertexColors: true, toon: true })  → toon with vertex colours (merged landmarks)
 * Other options: color, flat (Lambert flatShading), emissive, emissiveIntensity, transparent, opacity,
 * side ('front'|'back'|'double'), depthWrite, basic (unlit MeshBasicMaterial), fog.
 * Do not mutate a cached material; ask for a different key instead.
 */
export function propMaterial(arg = {}) {
  const o = typeof arg === 'number' || typeof arg === 'string' || (arg && arg.isColor) ? { color: arg } : { ...arg };
  const color = o.color != null ? (o.color.isColor ? o.color.getHex() : new Color(o.color).getHex()) : 0xffffff;
  const norm = {
    color,
    vc: !!o.vertexColors,
    toon: o.toon ?? !o.vertexColors,
    flat: !!o.flat,
    em: o.emissive != null ? new Color(o.emissive).getHex() : 0,
    emI: o.emissiveIntensity ?? 1,
    tr: !!o.transparent,
    op: o.opacity ?? 1,
    side: o.side || 'front',
    dw: o.depthWrite ?? true,
    basic: !!o.basic,
    fog: o.fog ?? true,
  };
  const key = JSON.stringify(norm);
  const hit = propCache.get(key);
  if (hit) return hit;
  const side = norm.side === 'double' ? DoubleSide : norm.side === 'back' ? BackSide : FrontSide;
  const common = { color, vertexColors: norm.vc, transparent: norm.tr, opacity: norm.op, side, depthWrite: norm.dw, fog: norm.fog };
  let m;
  if (norm.basic) m = new MeshBasicMaterial(common);
  else if (norm.toon) m = new MeshToonMaterial({ ...common, gradientMap: toonGradient(), emissive: norm.em, emissiveIntensity: norm.emI });
  else m = new MeshLambertMaterial({ ...common, flatShading: norm.flat, emissive: norm.em, emissiveIntensity: norm.emI });
  propCache.set(key, track(m));
  return m;
}

/** Inverted-hull outline material (#FFF6E0, back faces; scale the hull mesh to 1.04). */
export function outlineMaterial() {
  return propMaterial({ basic: true, color: 0xfff6e0, side: 'back', toon: false });
}

// ------------------------------------------------------------------ procedural textures

let blob = null;

/** 64×64 radial soft blob (Low tier contact shadows, §7.5). sRGB CanvasTexture; null without a DOM. */
export function blobTexture() {
  if (blob) return blob;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  r.addColorStop(0, 'rgba(40,30,20,0.55)');
  r.addColorStop(0.55, 'rgba(40,30,20,0.28)');
  r.addColorStop(1, 'rgba(40,30,20,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  blob = new CanvasTexture(c);
  blob.colorSpace = SRGBColorSpace;
  blob.minFilter = LinearFilter;
  blob.generateMipmaps = false;
  return track(blob);
}

/** After a WebGL context restore: mark every texture/material we created for re-upload/recompile. */
export function refreshMaterials() {
  for (const x of created) {
    if (x.isTexture) x.needsUpdate = true;
    else if (x.isMaterial) x.needsUpdate = true;
  }
}

/** Dispose every cached material and texture (world.dispose()). */
export function disposeMaterials() {
  for (const x of created) x.dispose?.();
  created.clear();
  propCache.clear();
  foliageCache.clear();
  gradient = null;
  blob = null;
}

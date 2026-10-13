/**
 * gfx/post.js — the High-tier post pass: MSAA render target → tilt-shift + vignette + warm grade
 * (GAME-DESIGN §9.8, P2; §7.5 "Post … render target samples: 4").
 *
 *   const post = createPost(renderer);
 *   post.setSize(drawingBufferW, drawingBufferH)
 *   post.render(scene, camera, { focusY })   focusY = projected height of the rig target, 0 (bottom) … 1 (top)
 *   post.dispose()
 *
 * The scene renders into a WebGLRenderTarget with `samples: 4` (MSAA survives the extra pass), then one
 * fullscreen triangle blurs by distance from the focus band (a 12-tap golden-angle disk, so a single pass
 * is enough at these small radii), darkens the corners a little (vignette 0.18) and warms the grade.
 * three's colorspace chunk converts linear → sRGB on the way to the canvas. The governor turns this off
 * first when frames run long (tiers.js step 'post').
 */

import {
  WebGLRenderTarget, UnsignedByteType, SRGBColorSpace, ShaderMaterial, Mesh, BufferGeometry, Float32BufferAttribute,
  OrthographicCamera, Scene, Vector2, LinearFilter,
} from '../three.js';

// band 0.3: the landmarks at the top of the frame stay sharp; vignette 0.08 + a tint-only warm grade keep the
// pale morning sky from going grey at the corners (§1.1)
export const POST = Object.freeze({ samples: 4, band: 0.3, blurPx: 3.2, vignette: 0.08 });

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uRes;
uniform float uFocusY;
uniform float uBand;
uniform float uBlur;
uniform float uVignette;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  float dy = abs(vUv.y - uFocusY);
  float amt = smoothstep(uBand, uBand + 0.38, dy) * uBlur;
  if (amt > 0.3) {
    vec4 acc = c;
    for (int i = 1; i < 12; i++) {
      float fi = float(i);
      float r = sqrt(fi / 11.0) * amt;
      float a = fi * 2.39996323;
      acc += texture2D(tDiffuse, vUv + vec2(cos(a), sin(a)) * r / uRes);
    }
    c = acc / 12.0;
  }
  vec2 q = vUv - 0.5;
  c.rgb *= 1.0 - uVignette * smoothstep(0.18, 0.62, dot(q, q) * 2.0);
  c.rgb = min(c.rgb * vec3(1.02, 1.0, 0.99), vec3(1.0));
  gl_FragColor = vec4(c.rgb, 1.0);
  #include <colorspace_fragment>
}`;

export function createPost(renderer, { samples = POST.samples } = {}) {
  // 8-bit sRGB storage: perceptual precision (no banding in the shadows) and the most portable MSAA format.
  // (A half-float MSAA target composited wrongly on some drivers during testing.) GL encodes on write and
  // decodes on sampling, so the shader still sees linear colour.
  const rt = new WebGLRenderTarget(2, 2, {
    samples,
    type: UnsignedByteType,
    colorSpace: SRGBColorSpace,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: true,
  });

  const material = new ShaderMaterial({
    uniforms: {
      tDiffuse: { value: rt.texture },
      uRes: { value: new Vector2(2, 2) },
      uFocusY: { value: 0.5 },
      uBand: { value: POST.band },
      uBlur: { value: POST.blurPx },
      uVignette: { value: POST.vignette },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geo.setAttribute('uv', new Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const quad = new Mesh(geo, material);
  quad.frustumCulled = false;
  const postScene = new Scene();
  postScene.add(quad);
  const postCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let dprScale = 1;

  return {
    setSize(w, h, dpr = 1) {
      const W = Math.max(2, Math.round(w));
      const H = Math.max(2, Math.round(h));
      rt.setSize(W, H);
      material.uniforms.uRes.value.set(W, H);
      dprScale = Math.max(1, Number(dpr) || 1);
      material.uniforms.uBlur.value = POST.blurPx * dprScale;
    },
    render(scene, camera, { focusY = 0.5 } = {}) {
      material.uniforms.uFocusY.value = Math.min(1, Math.max(0, Number(focusY) || 0.5));
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      renderer.setRenderTarget(prev);
      renderer.render(postScene, postCam);
    },
    get target() {
      return rt;
    },
    dispose() {
      rt.dispose();
      material.dispose();
      geo.dispose();
    },
  };
}

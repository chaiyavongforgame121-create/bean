/**
 * boot.js — capability checks before anything heavy loads (GAME-DESIGN §7.6). Entry module of index.html.
 *
 *   1. adoptUrlParams() (brood-api.js): store and STRIP `?token=` from the address bar.
 *   2. `?classic=1` → location.replace('/classic.html' + search).
 *   3. Probe a WebGL2 context (three r169 needs WebGL2; WebGL1 is not enough). A context that only comes up
 *      with failIfMajorPerformanceCaveat: false is software rendering → the stage starts at tier Low and
 *      says so (g.boot.slowGpu). No WebGL2 → interstitial g.boot.noWebgl, then /classic.html after 1.5 s.
 *   4. HEAD /vendor/three/build/three.module.min.js. Missing → g.boot.noEngine, then /classic.html.
 *   5. import('./main.js') and start(). A module error → g.boot.error with "Try again" and classic links.
 *
 * The interstitial is the #boot card of index.html (#bootMsg, #bootActions, #bootRetry). The same card is
 * reused at runtime for WebGL context loss (stage.js) through the `overlay` object handed to main.start().
 * No inline scripts or handlers anywhere (CSP script-src 'self').
 */

import { adoptUrlParams } from '../brood-api.js';
import { initLang, t } from '../i18n.js';

export const ENGINE_URL = '/vendor/three/build/three.module.min.js';
export const CLASSIC_URL = '/classic.html';
export const REDIRECT_MS = 1500;

const doc = globalThis.document;
const $ = (id) => doc?.getElementById(id) || null;

/** The #boot card: message + optional "Open the classic garden / Try again" actions. */
export const overlay = {
  show(key, { actions = false, vars = {} } = {}) {
    const box = $('boot');
    const msg = $('bootMsg');
    if (msg) msg.textContent = t(key, vars);
    const acts = $('bootActions');
    if (acts) acts.hidden = !actions;
    if (box) {
      box.hidden = false;
      box.dataset.state = actions ? 'error' : 'busy';
      box.setAttribute('role', actions ? 'alert' : 'status');
    }
  },
  hide() {
    const box = $('boot');
    if (!box) return;
    box.dataset.state = 'done';
    box.hidden = true; // game.css honours [hidden] (WP5's ui/index.js hides the card the same way)
    box.setAttribute('role', 'status'); // a hidden card must not stay an assertive alert region
  },
};

/** Keep api/lang params when leaving for the classic page; the token was already adopted and stripped. */
export function classicHref(search = globalThis.location?.search || '') {
  const qs = new URLSearchParams(search);
  qs.delete('token');
  qs.delete('classic');
  const s = qs.toString();
  return CLASSIC_URL + (s ? `?${s}` : '');
}

function goClassic(key) {
  overlay.show(key, { actions: true });
  const link = $('bootActions')?.querySelector('a');
  if (link) link.setAttribute('href', classicHref());
  setTimeout(() => globalThis.location.replace(classicHref()), REDIRECT_MS);
}

/** → 'hw' | 'software' | null (no WebGL2). The probe context is released right away. */
export function probeWebGL2(createCanvas = () => doc.createElement('canvas')) {
  const tryCtx = (caveat) => {
    try {
      const c = createCanvas();
      const gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: caveat, antialias: false, depth: false });
      if (!gl) return false;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return true;
    } catch {
      return false;
    }
  };
  if (tryCtx(true)) return 'hw';
  if (tryCtx(false)) return 'software';
  return null;
}

async function engineAvailable() {
  try {
    const r = await fetch(ENGINE_URL, { method: 'HEAD', cache: 'no-store' });
    return r.ok;
  } catch {
    return false;
  }
}

async function boot() {
  adoptUrlParams();
  initLang();
  const qs = new URLSearchParams(globalThis.location?.search || '');
  if (qs.get('classic') === '1') {
    globalThis.location.replace(classicHref());
    return;
  }
  overlay.show('g.boot.loading');
  $('bootRetry')?.addEventListener('click', () => globalThis.location.reload());

  const gl = probeWebGL2();
  if (!gl) return goClassic('g.boot.noWebgl');
  if (!(await engineAvailable())) return goClassic('g.boot.noEngine');

  let main;
  try {
    main = await import('./main.js');
  } catch (e) {
    globalThis.console?.error?.('[boot] main.js failed to load', e);
    overlay.show('g.boot.error', { actions: true, vars: { error: String(e?.message || e) } });
    return;
  }
  try {
    await main.start({ software: gl === 'software', overlay, debug: qs.get('debug') === '1' });
  } catch (e) {
    globalThis.console?.error?.('[boot] start failed', e);
    overlay.show('g.boot.error', { actions: true, vars: { error: String(e?.message || e) } });
  }
}

if (doc && globalThis.location) boot();

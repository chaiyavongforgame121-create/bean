/**
 * main.js — wiring of the 3D page (GAME-DESIGN §9.6 "main.js wiring", §5.2 input map, §5.4 focus, §5.5 pick).
 *
 *   start({ software, overlay, debug }) → Promise<{ store, bus, data, settings, sfx, stage }>
 *
 * 1. i18n, settings, store, bus, startData(), sfx (WP3, optional), then every ui/* module
 *    (`mount({ store, bus, data, sfx, settings, api })`) — the HUD works before 3D exists.
 * 2. `await import('./stage.js')` → createStage(); bus 'stage:ready' (ui/context.js listens for it).
 * 3. On every bots / marks / market / slots / beans change: views = viewsOf(state) → director → fx.run(effects)
 *    → field.sync(views, count); store.views + bus 'data:views'. Events and commands also go through the
 *    director (`game:event`, `cmd:pending`, `cmd:done`), so the UI never animates an outcome itself (J3).
 * 4. Scene input: picker taps/doubles/long-presses/hover/drops → ui:* events + store.ui; the keyboard map of
 *    §5.2 (camera, selection, focus, panels) when focus is on #stage or <body>.
 *
 * UI contract (bus → store.ui, all also writable directly by WP5):
 *   ui:select {slot}  → ui.selectedSlot          ui:focus {slot|null} → ui.focusSlot (rig flight, dim others)
 *   ui:pick {bean|null} → ui.pickBean (empty plots glow)   ui:panel {panel|null, toggle?} → ui.panel
 * Emitted for WP5: ui:plant {slot, bean} (open the plant dialog), ui:landmark {id}, ui:hover {hit, x, y},
 *   ui:radial {slot, x, y} (long-press), ui:dropInvalid {slot}, ui:mute {}, stage:ready, stage:firstFrame.
 */

import * as api from '../brood-api.js';
import { initLang, applyI18n } from '../i18n.js';
import { createStore, initialState } from './core/store.js';
import { createBus } from './core/bus.js';
import { createSettings } from './core/settings.js';
import { startData } from './core/data.js';
import { viewsOf } from './core/view.js';
import { createDirector } from './fx/director.js';

const warn = (...a) => globalThis.console?.warn?.('[main]', ...a);

/** WP5 modules, mounted in this order when ui/index.js (mountUi) is not provided. */
export const UI_MODULES = Object.freeze([
  'sheets', 'a11y', 'hud', 'badge', 'ticker', 'board', 'dock', 'chips', 'shelf', 'plantDialog',
  'inspector', 'confirm', 'diary', 'settings', 'tutorial', 'listview', 'radial', 'help', 'testnet', 'account', 'gate',
]);

/** Panels opened by single-key shortcuts (§5.2: P seeds · D diary · L list · B market board · ? help · G places, PLATFORM QA-08). */
const PANEL_KEYS = Object.freeze({ p: 'shelf', d: 'diary', l: 'list', b: 'board', '?': 'help', g: 'places' });

/** Views are recomputed at least this often so ages ("delayed · 25 s") and frozen flags stay true. */
const VIEW_TICK_MS = 5000;

async function tryImport(path) {
  try {
    return await import(path);
  } catch (e) {
    warn(`${path} not available`, e);
    return null;
  }
}

async function mountUi(deps) {
  const idx = await import('./ui/index.js').catch(() => null);
  if (typeof idx?.mountUi === 'function') {
    try {
      return await idx.mountUi(deps);
    } catch (e) {
      warn('ui/index.js mountUi failed; mounting modules one by one', e);
    }
  }
  const mods = await Promise.allSettled(UI_MODULES.map((n) => import(`./ui/${n}.js`)));
  const out = {};
  mods.forEach((m, i) => {
    const name = UI_MODULES[i];
    if (m.status !== 'fulfilled') {
      warn(`ui/${name}.js not available`, m.reason);
      return;
    }
    if (typeof m.value.mount !== 'function') return;
    try {
      out[name] = m.value.mount(deps);
    } catch (e) {
      warn(`ui/${name}.js mount failed`, e);
    }
  });
  return out;
}

const isTyping = (el) => {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable || !!el.closest?.('dialog[open]');
};

export async function start({ software = false, overlay = null, debug = false } = {}) {
  const doc = globalThis.document;
  initLang();
  applyI18n();

  // ---------------------------------------------------------------- core
  const store = createStore(initialState());
  const bus = createBus();
  const settings = createSettings({ store, bus });
  const data = startData({ store, bus, api });
  const director = createDirector();
  const app = { store, bus, data, settings, sfx: null, stage: null, director };
  if (debug) globalThis.__bean = app;

  // ---------------------------------------------------------------- sound (WP3, optional)
  const sfxMod = await tryImport('./audio/sfx.js');
  if (typeof sfxMod?.createSfx === 'function') {
    try {
      app.sfx = sfxMod.createSfx({ settings: settings.get(), bus });
    } catch (e) {
      warn('createSfx failed', e);
    }
  }
  wireSound(app);

  // ---------------------------------------------------------------- UI (WP5) — usable before 3D
  try {
    app.ui = await mountUi({ store, bus, data, sfx: app.sfx, settings, api });
  } catch (e) {
    warn('UI mount failed', e);
  }

  wireDialogs(store);

  // ---------------------------------------------------------------- views + director
  let views = {};
  let queued = false;
  const causes = new Set();

  const ctx = (extra = {}) => {
    const s = store.get();
    return {
      skewMs: s.net?.skewMs || 0,
      reduced: !!s.ui?.reduced,
      halted: !!s.live?.halted,
      pending: s.ui?.pending || {},
      streamLive: s.net?.stream === 'live',
      prices: s.feed?.prices ?? null, // sim: replay detection uses the journal's wall time, not market time
      ...extra,
    };
  };

  const run = (prev, next, ev, extra) => {
    const effects = director.run(prev, next, ev, ctx(extra));
    if (effects.length) app.stage?.runEffects(effects);
    return effects;
  };

  function recompute() {
    queued = false;
    const s = store.get();
    const next = viewsOf(s, Date.now());
    const prev = views;
    views = next;
    store.set({ views: next });
    const cause = causes.size === 1 && causes.has('marks') ? 'mids' : 'data';
    causes.clear();
    run(prev, next, null, { cause });
    app.stage?.syncViews(next, s.slots?.count || 10);
    bus.emit('data:views', { prev, next, cause });
  }

  function schedule(cause) {
    causes.add(cause);
    if (queued) return;
    queued = true;
    queueMicrotask(recompute);
  }

  const inputs = {
    bots: (s) => s.bots,
    marks: (s) => s.marks,
    coins: (s) => s.market?.coins,
    slots: (s) => s.slots?.map,
    count: (s) => s.slots?.count,
    beans: (s) => s.beans,
    halted: (s) => !!s.live?.halted,
    stale: (s) => (s.feed?.staleCoins || []).join(','),
    skew: (s) => s.net?.skewMs,
  };
  for (const [name, sel] of Object.entries(inputs)) store.select(sel, () => schedule(name));
  setInterval(() => schedule('clock'), VIEW_TICK_MS);
  schedule('boot');

  bus.on('game:event', (ev) => run(views, views, ev));
  bus.on('cmd:pending', (p) => run(views, views, { type: 'cmd', phase: 'pending', ...p }));
  bus.on('cmd:done', (d) => run(views, views, { type: 'cmd', phase: 'done', ...d }));

  // ---------------------------------------------------------------- ui:* → store.ui
  const setUi = (patch) => store.update('ui', patch);
  bus.on('ui:select', (e) => setUi({ selectedSlot: Number.isInteger(e?.slot) ? e.slot : null }));
  bus.on('ui:focus', (e) => {
    const slot = Number.isInteger(e?.slot) ? e.slot : null;
    setUi(slot === null ? { focusSlot: null } : { focusSlot: slot, selectedSlot: slot });
  });
  bus.on('ui:pick', (e) => setUi({ pickBean: e?.bean ?? null }));
  bus.on('ui:panel', (e) => {
    const cur = store.get().ui?.panel ?? null;
    const panel = e?.panel ?? null;
    setUi({ panel: e?.toggle && cur === panel ? null : panel });
  });

  // ---------------------------------------------------------------- the 3D stage
  const canvas = doc?.getElementById('world');
  try {
    const mod = await import('./stage.js');
    app.stage = await mod.createStage({ store, bus, canvas, settings, sfx: app.sfx, software, overlay, debug });
  } catch (e) {
    store.update('boot', { phase: 'error', error: String(e?.message || e) });
    overlay?.show?.('g.boot.error', { actions: true, vars: { error: String(e?.message || e) } });
    globalThis.console?.error?.('[main] the 3D stage could not start', e);
    return app;
  }
  const stage = app.stage;
  bus.emit('stage:ready', stage);
  stage.syncViews(views, store.get().slots?.count || 10);

  wireScene(app);
  wireKeyboard(app);
  wireSafeArea(app, canvas);
  if (new URLSearchParams(globalThis.location?.search || '').get('debug') === 'pick') wireDebugPick(app);

  bus.once('stage:firstFrame', () => {
    store.update('boot', { phase: 'ready', error: null });
    overlay?.hide?.();
    if (!store.get().ui?.reduced) {
      try {
        canvas.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 700, easing: 'ease-out' });
      } catch {
        /* no WAAPI */
      }
    }
    stage.rig.intro();
    call(stage.world, 'intro');
  });
  stage.requestRender();
  if (software) bus.emit('boot:slowGpu', {}); // WP5 toast: 3D runs without graphics acceleration
  return app;
}

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

// ------------------------------------------------------------------ sound (settings → sfx)

function wireSound(app) {
  const { bus, store, sfx, settings } = app;
  if (!sfx) return;
  const s0 = settings.get();
  call(sfx, 'setVolume', s0.volume);
  call(sfx, 'setAmbience', s0.ambience);
  call(sfx, 'setChime', s0.chime);
  // The AudioContext may only start inside a user gesture: a stored "sound on" waits for the first one.
  if (s0.sound) {
    const once = () => {
      globalThis.removeEventListener('pointerdown', once, true);
      globalThis.removeEventListener('keydown', once, true);
      if (settings.get().sound) call(sfx, 'enable', true);
    };
    globalThis.addEventListener('pointerdown', once, true);
    globalThis.addEventListener('keydown', once, true);
  }
  bus.on('settings', ({ settings: s, changed = [] } = {}) => {
    if (!s) return;
    if (changed.includes('sound')) call(sfx, 'enable', !!s.sound);
    if (changed.includes('volume')) call(sfx, 'setVolume', s.volume);
    if (changed.includes('ambience')) call(sfx, 'setAmbience', s.ambience);
    if (changed.includes('chime')) call(sfx, 'setChime', s.chime);
  });
  // UI-only cues of §4.1 (no outcome, so they bypass the director): picking a seed rustles its sachet; a seed
  // dropped on a plot that cannot take it ticks
  bus.on('ui:pick', (e) => e?.bean && call(sfx, 'play', 'paperRustle'));
  bus.on('ui:dropInvalid', () => call(sfx, 'play', 'tick'));
  store.select((s) => s.market?.weather?.key ?? null, (k) => k && call(sfx, 'setWeather', k));
  store.select((s) => s.market?.wind?.factor ?? null, (f) => f !== null && call(sfx, 'setWind', f));
  store.select((s) => !!s.ui?.dialog, (open) => call(sfx, 'duck', open));
}

// ------------------------------------------------------------------ open dialog → store.ui.dialog

/**
 * store.ui.dialog (§9.6) names the open modal (`plantDlg`, `askDlg`, …) or null. WP5's dialogs are native
 * <dialog>s inside #dialogs, so one observer of their `open` attribute keeps it true for every reader
 * (sound ducking, the world's binding) without each dialog having to report itself.
 */
function wireDialogs(store) {
  const doc = globalThis.document;
  const root = doc?.getElementById('dialogs');
  if (!root || typeof globalThis.MutationObserver !== 'function') return;
  const sync = () => {
    const open = root.querySelector('dialog[open]');
    const id = open ? open.id || 'dialog' : null;
    if ((store.get().ui?.dialog ?? null) !== id) store.update('ui', { dialog: id });
  };
  new MutationObserver(sync).observe(root, { subtree: true, attributes: true, attributeFilter: ['open'] });
  sync();
}

// ------------------------------------------------------------------ scene input (picker) + focus

function wireScene(app) {
  const { store, bus, stage } = app;
  const { picker, field, rig } = stage;
  const ui = () => store.get().ui || {};
  const setUi = (patch) => store.update('ui', patch);
  const occupied = (slot) => !!store.get().views?.[slot];
  const halted = () => !!store.get().live?.halted;

  // tap: plant in pick mode, otherwise select; landmarks go to the UI; empty ground clears the selection
  picker.onTap((hit, ev) => {
    if (!hit) {
      if (ui().focusSlot === null && ui().selectedSlot !== null) bus.emit('ui:select', { slot: null, source: 'scene' });
      return;
    }
    if (hit.type === 'plot') {
      const bean = ui().pickBean;
      if (bean && !occupied(hit.slot) && !halted()) {
        bus.emit('ui:plant', { slot: hit.slot, bean, source: 'scene' });
        return;
      }
      bus.emit('ui:select', { slot: hit.slot, source: 'scene' });
      if (ui().focusSlot !== null && ui().focusSlot !== hit.slot) bus.emit('ui:focus', { slot: hit.slot, source: 'scene' });
      return;
    }
    if (hit.type === 'landmark') {
      if (hit.id === 'sundial' && store.get().feed?.prices !== 'sim') return; // exists only with simulated prices
      bus.emit('ui:landmark', { id: hit.id, x: ev?.clientX, y: ev?.clientY, source: 'scene' });
    }
  });
  picker.onDouble((hit) => {
    if (hit?.type === 'plot') bus.emit('ui:focus', { slot: hit.slot, source: 'scene' });
  });
  picker.onLongPress((hit, ev) => {
    if (hit?.type === 'plot') {
      bus.emit('ui:select', { slot: hit.slot, source: 'scene' });
      bus.emit('ui:radial', { slot: hit.slot, x: ev?.clientX, y: ev?.clientY });
    }
  });
  picker.onHover((hit, ev) => {
    call(field, 'setHover', hit?.type === 'plot' ? hit.slot : null);
    bus.emit('ui:hover', { hit, x: ev?.clientX, y: ev?.clientY });
    stage.requestRender();
  });
  picker.onDragDrop(({ phase, slot, data, clientX, clientY }) => {
    // WP4's field draws the drop target itself (ring pulse on a valid empty box); hover is the fallback
    const dragOver = (s) => (typeof field?.setDragOver === 'function' ? call(field, 'setDragOver', s) : call(field, 'setHover', s));
    if (phase === 'over') {
      dragOver(slot);
      bus.emit('ui:dragover', { slot, valid: slot !== null && !occupied(slot) && !halted() });
    } else if (phase === 'leave') dragOver(null);
    else if (phase === 'drop') {
      dragOver(null);
      const bean = data?.bean ?? data ?? ui().pickBean;
      if (slot !== null && !occupied(slot) && !halted() && bean) bus.emit('ui:plant', { slot, bean, source: 'drop', x: clientX, y: clientY });
      else bus.emit('ui:dropInvalid', { slot, x: clientX, y: clientY });
    }
    stage.requestRender();
  });

  // store.ui → scene
  store.select((s) => s.ui?.selectedSlot ?? null, (slot) => {
    call(field, 'setSelected', slot);
    stage.requestRender();
  });
  store.select((s) => s.ui?.pickBean ?? null, (bean) => {
    call(field, 'setPickMode', !!bean, bean?.coin ?? null);
    stage.requestRender();
  });

  // focus (§5.4): fly, dim the others; Esc / back returns to the previous view (600 ms)
  let historyPushed = false;
  store.select((s) => s.ui?.focusSlot ?? null, (slot, prev) => {
    if (slot !== null) {
      rig.focus(stage.plotPosition(slot));
      call(field, 'setDim', slot);
      if (!historyPushed) {
        try {
          globalThis.history?.pushState({ ...(globalThis.history.state || {}), beanFocus: true }, '');
          historyPushed = true;
        } catch {
          /* sandboxed */
        }
      }
    } else if (prev !== null && prev !== undefined) {
      rig.back();
      call(field, 'setDim', null);
      if (historyPushed) {
        historyPushed = false;
        try {
          if (globalThis.history?.state?.beanFocus) globalThis.history.back();
        } catch {
          /* ignore */
        }
      }
    }
    stage.requestRender();
  });
  globalThis.addEventListener?.('popstate', () => {
    // Android back / browser back while focused: leave focus
    if (historyPushed && store.get().ui?.focusSlot !== null) {
      historyPushed = false;
      setUi({ focusSlot: null });
    } else historyPushed = false;
  });
}

// ------------------------------------------------------------------ keyboard (§5.2)

function wireKeyboard(app) {
  const { store, bus, stage, settings } = app;
  const { rig } = stage;
  const doc = globalThis.document;
  const stageEl = doc?.getElementById('stage');
  const ui = () => store.get().ui || {};

  const occupiedSlots = () => Object.keys(store.get().views || {}).map(Number).sort((a, b) => a - b);
  const slotCount = () => store.get().slots?.count || 10;

  function stepSlot(dir) {
    const u = ui();
    const cur = u.focusSlot ?? u.selectedSlot;
    if (u.focusSlot !== null) {
      // in focus: previous/next OCCUPIED plot, staying in focus
      const occ = occupiedSlots();
      if (!occ.length) return;
      let i = occ.indexOf(cur);
      i = i < 0 ? (dir > 0 ? 0 : occ.length - 1) : (i + dir + occ.length) % occ.length;
      bus.emit('ui:focus', { slot: occ[i], source: 'key' });
      return;
    }
    const n = slotCount();
    const next = cur === null || cur === undefined ? (dir > 0 ? 0 : n - 1) : (cur + dir + n) % n;
    bus.emit('ui:select', { slot: next, source: 'key' });
  }

  function onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey) return;
    const active = doc?.activeElement;
    const onStage = !active || active === doc.body || active === stageEl || stageEl?.contains(active);
    if (!onStage || isTyping(active)) return;
    const k = e.key;
    const shortcuts = settings.get().shortcuts !== false;
    const single = k.length === 1; // letters, digits, punctuation (WCAG 2.1.4: can be turned off)
    if (single && !shortcuts) return;
    const mult = e.shiftKey ? 3 : 1;
    let handled = true;
    switch (k) {
      case 'ArrowLeft':
        rig.panBy(-2 * mult, 0);
        break;
      case 'ArrowRight':
        rig.panBy(2 * mult, 0);
        break;
      case 'ArrowUp':
        rig.panBy(0, 2 * mult);
        break;
      case 'ArrowDown':
        rig.panBy(0, -2 * mult);
        break;
      case 'PageUp':
        rig.tiltBy(4);
        break;
      case 'PageDown':
        rig.tiltBy(-4);
        break;
      case 'Home':
        if (ui().focusSlot !== null) store.update('ui', { focusSlot: null });
        rig.reset();
        break;
      case 'Escape': {
        const u = ui();
        if (u.panel) bus.emit('ui:panel', { panel: null, source: 'key' });
        else if (u.focusSlot !== null) bus.emit('ui:focus', { slot: null, source: 'key' });
        else if (u.pickBean) bus.emit('ui:pick', { bean: null, source: 'key' });
        else if (u.selectedSlot !== null) bus.emit('ui:select', { slot: null, source: 'key' });
        else handled = false;
        break;
      }
      case 'Enter': {
        // only from the stage region or <body>: a focused button inside the stage keeps its own Enter
        const plain = !active || active === doc.body || active === stageEl || active?.id === 'world';
        if (plain && ui().selectedSlot !== null) bus.emit('ui:focus', { slot: ui().selectedSlot, source: 'key' });
        else handled = false;
        break;
      }
      default:
        handled = false;
    }
    if (!handled && single) {
      handled = true;
      const lower = k.toLowerCase();
      if (lower === 'q') rig.yawBy(-20);
      else if (lower === 'e') rig.yawBy(20);
      else if (k === '+' || k === '=') rig.zoomBy(1 / 1.15);
      else if (k === '-' || k === '_') rig.zoomBy(1.15);
      else if (/^[0-9]$/.test(k)) {
        const slot = k === '0' ? 9 : Number(k) - 1;
        if (slot < slotCount()) {
          if (ui().focusSlot !== null) bus.emit('ui:focus', { slot, source: 'key' });
          else bus.emit('ui:select', { slot, source: 'key' });
        }
      } else if (k === '[') stepSlot(-1);
      else if (k === ']') stepSlot(1);
      else if (lower === 'f') {
        if (ui().selectedSlot !== null) bus.emit('ui:focus', { slot: ui().selectedSlot, source: 'key' });
      } else if (lower === 'm') {
        bus.emit('ui:mute', { source: 'key' });
        settings.set({ sound: !settings.get().sound });
      } else if (PANEL_KEYS[lower] || PANEL_KEYS[k]) bus.emit('ui:panel', { panel: PANEL_KEYS[lower] || PANEL_KEYS[k], toggle: true, source: 'key' });
      else handled = false;
    }
    if (handled) e.preventDefault();
  }
  globalThis.addEventListener('keydown', onKey);
}

// ------------------------------------------------------------------ safe area (HUD-covered edges)

function wireSafeArea(app, canvas) {
  const { stage, bus } = app;
  const doc = globalThis.document;
  const hud = doc?.getElementById('hud');
  const bottom = doc?.getElementById('bottom');
  const measure = () => {
    const c = canvas.getBoundingClientRect();
    if (!c.height) return;
    // (offsetParent is null for position: fixed, which the HUD and the bottom bar use: test the box instead)
    const visible = (el) => !!el && !el.hidden && el.getClientRects().length > 0 && el.getBoundingClientRect().height > 0;
    const top = visible(hud) ? Math.max(0, hud.getBoundingClientRect().bottom - c.top) : 0;
    let bot = visible(bottom) ? Math.max(0, c.bottom - bottom.getBoundingClientRect().top) : 0;
    let left = 0;
    // The farm gate is part of a first-time spectator's default view (PLATFORM QA-06): the untouched default view
    // re-fits beside the wooden sign (desktop) or above the bottom sheet (phone), so the farm stays in sight.
    const gate = doc?.getElementById('panel-gate');
    if (visible(gate)) {
      const g = gate.getBoundingClientRect();
      // a full-width gate is the phone's bottom sheet; otherwise it is the wooden sign on the left
      if (g.width >= c.width * 0.9) bot = Math.max(bot, c.bottom - g.top);
      else left = Math.max(0, g.right - c.left);
    }
    // never let the HUD squeeze the island into less than 40% of the canvas
    const cap = c.height * 0.3;
    stage.rig.setAutoSafeArea({ top: Math.min(top, cap), bottom: Math.min(bot, c.height * (left || bot <= cap ? 0.3 : 0.6)), left: Math.min(left, c.width * 0.45), right: 0 });
  };
  measure();
  if (typeof globalThis.ResizeObserver === 'function') {
    const ro = new ResizeObserver(measure);
    for (const el of [hud, bottom, canvas]) if (el) ro.observe(el);
  }
  globalThis.addEventListener?.('resize', measure);
  // panels report their layout changes (ui/sheets.js): the gate opening or closing re-fits the default view
  bus?.on?.('ui:safeArea', measure);
}

// ------------------------------------------------------------------ ?debug=pick (PLATFORM QA-01 manual check)

/**
 * Draw every pick proxy (landmarks and plots) as a dashed DOM box with its id and its on-screen size, so a tester
 * can see that each tap target is ≥ 44 × 44 CSS px and outside the HUD. Proxies stay invisible in the 3D scene.
 */
function wireDebugPick(app) {
  const { stage } = app;
  const doc = globalThis.document;
  if (!doc || !stage?.labels?.project) return;
  const layer = doc.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  doc.body.append(layer);
  const boxes = new Map();
  const corners = (proxy) => {
    const g = proxy.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox;
    proxy.updateWorldMatrix(true, false);
    const e = proxy.matrixWorld.elements;
    const out = [];
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      out.push({ x: e[0] * x + e[4] * y + e[8] * z + e[12], y: e[1] * x + e[5] * y + e[9] * z + e[13], z: e[2] * x + e[6] * y + e[10] * z + e[14] });
    }
    return out;
  };
  const draw = () => {
    const items = [];
    for (const [id, lm] of stage.world?.landmarks || []) if (lm?.proxy?.visible !== undefined || lm?.proxy) items.push([`lm:${id}`, lm.proxy]);
    const count = app.store.get().slots?.count || 10;
    for (let i = 0; i < count; i++) {
      const p = stage.field?.plot?.(i);
      if (p?.proxy) items.push([`plot:${i + 1}`, p.proxy]);
    }
    for (const [key, proxy] of items) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const c of corners(proxy)) {
        const s = stage.labels.project(c);
        if (!s || !Number.isFinite(s.x)) continue;
        x0 = Math.min(x0, s.x);
        x1 = Math.max(x1, s.x);
        y0 = Math.min(y0, s.y);
        y1 = Math.max(y1, s.y);
      }
      let el = boxes.get(key);
      if (!el) {
        el = doc.createElement('div');
        el.className = 'pick-debug';
        layer.append(el);
        boxes.set(key, el);
      }
      if (!Number.isFinite(x0)) {
        el.hidden = true;
        continue;
      }
      el.hidden = false;
      el.style.left = Math.round(x0) + 'px';
      el.style.top = Math.round(y0) + 'px';
      el.style.width = Math.round(x1 - x0) + 'px';
      el.style.height = Math.round(y1 - y0) + 'px';
      el.textContent = `${key} ${Math.round(x1 - x0)}×${Math.round(y1 - y0)}`;
    }
  };
  stage.rig?.onChange?.(() => globalThis.requestAnimationFrame?.(draw));
  setInterval(draw, 1000);
  draw();
}

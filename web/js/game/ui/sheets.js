/**
 * ui/sheets.js — panels, bottom sheets and safe-area reporting (GAME-DESIGN §6.1, §6.2, §2.5, §5.2).
 *
 * One manager per page (ctx.sheets). Modules register their panel once and get back a handle:
 *
 *   const p = sheets.panel('shelf', { side: 'left', titleKey: 'g.shelf.title', snap: 60, icon: 'i-seed' });
 *   p.el / p.body / p.head        DOM (the module fills p.body; text via textContent only)
 *   p.open({ opener, snap })      p.close() · p.toggle() · p.isOpen() · p.setTitle(text)
 *   p.onOpen(fn) / p.onClose(fn)
 *
 *   Desktop (≥ 760 px): `left` panels share the left column (one at a time); the `right` panel (the
 *   inspector) is independent. Phone (< 760 px): every panel is a bottom sheet with snap points
 *   25 / 60 / 92 vh, a drag handle, Esc/back to close; one sheet at a time.
 *
 * Store: `ui.panel` = the open left panel id (or null). The inspector is driven by `ui.selectedSlot`
 * (ui/inspector.js). Bus: listens to and emits `ui:panel {panel}`.
 *
 * Safe area (§2.5): after every layout change the occupied edges of the HUD, the bottom dock and any open
 * panel are reported to `stage.rig.setSafeArea({top, right, bottom, left})` (CSS px), and published as the
 * CSS variables --hud-h / --bottom-h / --sheet-h on <html> (CSSOM, CSP-safe) and bus `ui:safeArea`.
 *
 * Keyboard (§5.2): P seeds · D diary · L list · B market board · G places (QA-08) · M mute · ? help (ignored while typing in a
 * field or a dialog, and when single-key shortcuts are off — WCAG 2.1.4). Esc closes the top panel; with no
 * panel open it closes the inspector (leaving focus), then cancels pick mode. Shortcuts only open panels.
 *
 * No three.js, no side effects at import.
 */

import { t } from '../../i18n.js';
import { getCtx, emit, on } from './context.js';
import { h, icon, setText, $, isTypingTarget, isPhone, patchUi, nextFrame, reducedMotion } from './util.js';
import { announce } from './a11y.js';

const SNAPS = [25, 60, 92];
const SHORTCUTS = { p: 'shelf', d: 'diary', l: 'list', b: 'board', '?': 'help', g: 'places' };

/** The page's sheet manager (created on first use). */
export function getSheets(deps) {
  const ctx = getCtx(deps);
  if (!ctx.sheets) ctx.sheets = createSheets(ctx);
  return ctx.sheets;
}

export function mount(deps) {
  return getSheets(deps);
}

function createSheets(ctx) {
  const { store } = ctx;
  const panels = new Map();
  const root = $('panels');
  let leftOpen = null; // id of the open left panel
  let rightOpen = null; // id of the open right panel (inspector)
  let historyArmed = null; // id of the phone sheet that pushed a history entry
  let ignorePop = false;
  let safeTimer = 0;
  let lastSafe = '';

  // ------------------------------------------------------------------ panel factory

  function panel(id, opts = {}) {
    if (panels.has(id)) return panels.get(id);
    const side = opts.side === 'right' ? 'right' : 'left';
    const titleId = `panel-${id}-title`;
    const title = h('h2', { class: 'panel-title', id: titleId });
    const closeBtn = h(
      'button',
      { type: 'button', class: 'icon-btn panel-close', 'aria-label': t('g.btn.close'), title: t('g.btn.close'), dataset: { i18nAttrTitle: 'g.btn.close' } },
      icon('i-close'),
    );
    const tools = h('div', { class: 'panel-tools' });
    const head = h('header', { class: 'panel-head' }, opts.icon ? h('span', { class: 'panel-ico' }, icon(opts.icon)) : null, title, tools, closeBtn);
    const grip = h('div', { class: 'panel-grip', 'aria-hidden': 'true' }, h('span'));
    const body = h('div', { class: 'panel-body' });
    const el = h(
      'section',
      {
        class: `panel panel--${side} panel--${id}`,
        id: `panel-${id}`,
        role: 'dialog',
        'aria-modal': 'false',
        'aria-labelledby': titleId,
        tabindex: '-1',
        hidden: true,
        dataset: { panel: id },
      },
      grip,
      head,
      body,
    );
    root?.append(el);

    const openFns = new Set();
    const closeFns = new Set();
    const p = {
      id,
      side,
      el,
      head,
      tools,
      body,
      opener: null,
      snap: opts.snap || 60,
      titleKey: opts.titleKey || null,
      isOpen: () => !el.hidden,
      setTitle(text) {
        setText(title, text);
      },
      open(o = {}) {
        openPanel(p, o);
      },
      close(o = {}) {
        closePanel(p, o);
      },
      toggle(o = {}) {
        if (p.isOpen()) closePanel(p, o);
        else openPanel(p, o);
      },
      onOpen: (fn) => (openFns.add(fn), () => openFns.delete(fn)),
      onClose: (fn) => (closeFns.add(fn), () => closeFns.delete(fn)),
      _openFns: openFns,
      _closeFns: closeFns,
    };
    if (p.titleKey) p.setTitle(t(p.titleKey));
    closeBtn.addEventListener('click', () => closePanel(p, { restore: true }));
    wireGrip(p, grip);
    panels.set(id, p);
    return p;
  }

  function call(fns, arg) {
    for (const fn of [...fns]) {
      try {
        fn(arg);
      } catch (e) {
        console.error('[ui] panel hook failed', e);
      }
    }
  }

  // force: move focus into the panel even when it is already open (activating an already-selected dock card)
  function openPanel(p, { opener = null, snap = null, focus = true, force = false } = {}) {
    const phone = isPhone();
    p.opener = opener || (document.activeElement !== document.body ? document.activeElement : null) || p.opener;
    // one left panel at a time; on a phone one sheet at a time
    if (p.side === 'left' && leftOpen && leftOpen !== p.id) closePanel(panels.get(leftOpen), { silent: true, keepHistory: true });
    if (phone) {
      // a left panel that gives way to the inspector really closes (store.ui.panel → null)
      for (const other of panels.values()) if (other !== p && other.isOpen()) closePanel(other, { silent: p.side === 'left', keepHistory: true });
    }
    const wasOpen = p.isOpen();
    setSnap(p, snap || p.snap);
    p.el.hidden = false;
    p.el.classList.remove('is-closing');
    if (p.side === 'left') leftOpen = p.id;
    else rightOpen = p.id;
    document.documentElement.dataset.sheet = phone ? p.id : '';
    if (p.side === 'left') {
      if (store.get().ui?.panel !== p.id) patchUi(store, { panel: p.id });
      emit(ctx, 'ui:panel', { panel: p.id, source: 'sheets' });
    }
    syncToolbar();
    if (phone && !historyArmed) armHistory(p.id);
    if (!wasOpen) call(p._openFns, p);
    if (focus && (!wasOpen || force)) nextFrame(() => focusInto(p));
    scheduleSafe();
  }

  function closePanel(p, { restore = false, silent = false, keepHistory = false } = {}) {
    if (!p || !p.isOpen()) return;
    p.el.hidden = true;
    if (p.side === 'left' && leftOpen === p.id) leftOpen = null;
    if (p.side === 'right' && rightOpen === p.id) rightOpen = null;
    if (!leftOpen && !rightOpen) document.documentElement.dataset.sheet = '';
    if (p.side === 'left' && !silent) {
      if (store.get().ui?.panel === p.id) patchUi(store, { panel: null });
      emit(ctx, 'ui:panel', { panel: null, source: 'sheets' });
    }
    syncToolbar();
    call(p._closeFns, p);
    if (!keepHistory) disarmHistory();
    if (restore) {
      const back = p.opener && p.opener.isConnected && !p.opener.closest('[hidden]') ? p.opener : $('stage');
      back?.focus?.({ preventScroll: true });
    }
    p.opener = null;
    scheduleSafe();
  }

  function focusInto(p) {
    const target = p.el.querySelector('[data-autofocus]') || p.el;
    target.focus?.({ preventScroll: true });
  }

  function setSnap(p, vh) {
    const v = SNAPS.reduce((a, b) => (Math.abs(b - vh) < Math.abs(a - vh) ? b : a), SNAPS[1]);
    p.el.dataset.snap = String(v);
    p.el.style.setProperty('--snap', v + 'dvh');
    p.el.style.removeProperty('height');
  }

  // ------------------------------------------------------------------ phone drag handle

  function wireGrip(p, grip) {
    let startY = 0;
    let startH = 0;
    let dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      const dy = startY - e.clientY;
      const vh = Math.max(8, Math.min(96, ((startH + dy) / innerHeight) * 100));
      p.el.style.height = vh + 'dvh';
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      p.el.classList.remove('is-dragging');
      const dy = startY - e.clientY;
      const vh = ((startH + dy) / innerHeight) * 100;
      if (vh < 16) closePanel(p, { restore: true });
      else setSnap(p, vh);
      scheduleSafe();
    };
    grip.addEventListener('pointerdown', (e) => {
      if (!isPhone()) return;
      dragging = true;
      startY = e.clientY;
      startH = p.el.getBoundingClientRect().height;
      p.el.classList.add('is-dragging');
      grip.setPointerCapture?.(e.pointerId);
    });
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
    // a tap on the handle cycles the snap points (keyboard users have the close button)
    grip.addEventListener('dblclick', () => {
      const cur = Number(p.el.dataset.snap) || 60;
      setSnap(p, SNAPS[(SNAPS.indexOf(cur) + 1) % SNAPS.length]);
      scheduleSafe();
    });
  }

  // ------------------------------------------------------------------ Android back (phone sheets only)

  function armHistory(id) {
    try {
      history.pushState({ ...(history.state || {}), beanSheet: id }, '');
      historyArmed = id;
    } catch {
      historyArmed = null;
    }
  }
  function disarmHistory() {
    if (!historyArmed) return;
    historyArmed = null;
    try {
      if (history.state && history.state.beanSheet) {
        ignorePop = true;
        history.back();
      }
    } catch {
      /* ignore */
    }
  }
  addEventListener('popstate', () => {
    if (ignorePop) {
      ignorePop = false;
      return;
    }
    if (!historyArmed) return;
    historyArmed = null;
    const p = panels.get(leftOpen) || panels.get(rightOpen);
    if (p) closePanel(p, { restore: true, keepHistory: true });
    if (rightOpen === null && store.get().ui?.selectedSlot !== null) patchUi(store, { selectedSlot: null });
  });

  // ------------------------------------------------------------------ toolbar [data-panel] buttons

  function syncToolbar() {
    for (const btn of document.querySelectorAll('[data-panel]')) {
      if (btn.tagName !== 'BUTTON') continue;
      const id = btn.dataset.panel;
      const open = leftOpen === id;
      btn.setAttribute('aria-expanded', String(open));
      btn.classList.toggle('is-on', open);
    }
  }
  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button[data-panel]');
    if (!btn || btn.closest('.panel')?.dataset.panel === btn.dataset.panel) return;
    const p = panels.get(btn.dataset.panel);
    if (!p) return;
    e.preventDefault();
    p.toggle({ opener: btn, restore: true });
  });

  // ------------------------------------------------------------------ store / bus sync

  on(ctx, 'ui:panel', (msg) => {
    if (!msg || msg.source === 'sheets') return;
    const id = msg.panel;
    if (!id) {
      const p = panels.get(leftOpen);
      if (p) closePanel(p, { restore: false });
      return;
    }
    const p = panels.get(id);
    if (!p) return;
    if (msg.toggle && p.isOpen()) closePanel(p, { restore: true });
    else p.open({ opener: msg.opener || null });
  });
  store.select?.(
    (s) => s.ui?.panel ?? null,
    (id) => {
      if (id === leftOpen) return;
      if (!id) {
        const p = panels.get(leftOpen);
        if (p) closePanel(p, { silent: true });
        return;
      }
      panels.get(id)?.open({});
    },
  );

  // ------------------------------------------------------------------ keyboard

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        if (onEscape(e)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const settings = store.get().settings;
      if (settings && settings.shortcuts === false) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : '';
      if (k === 'm') {
        e.preventDefault();
        ctx.mods.hud?.toggleSound?.();
        return;
      }
      const id = SHORTCUTS[k];
      if (!id || !panels.has(id)) return;
      e.preventDefault();
      panels.get(id).toggle({ opener: document.activeElement, restore: true });
    },
    true,
  );

  /** Esc ladder (§5.2): popover/radial (their own) → panel → inspector/focus → pick mode. */
  function onEscape(e) {
    if (e.target?.closest?.('dialog[open]')) return false; // native dialogs handle their own Esc
    if (ctx.mods.tutorial?.isOpen?.() && e.target?.closest?.('.tour')) {
      ctx.mods.tutorial.stop(true);
      return true;
    }
    if (ctx.mods.radial?.isOpen?.()) {
      ctx.mods.radial.close();
      return true;
    }
    if (ctx.mods.badge?.closePopover?.()) return true;
    if (ctx.mods.hud?.closePopover?.()) return true;
    const phone = isPhone();
    // phone: the visible sheet first; desktop: the left panel, then the inspector
    if (leftOpen && (!phone || !rightOpen)) {
      closePanel(panels.get(leftOpen), { restore: true });
      return true;
    }
    const s = store.get();
    if (rightOpen || s.ui?.selectedSlot !== null || s.ui?.focusSlot !== null) {
      if (rightOpen) closePanel(panels.get(rightOpen), { restore: false });
      const sel = s.ui?.selectedSlot;
      if (ctx.actions) {
        ctx.actions.leaveFocus();
        ctx.actions.select(null);
      } else {
        patchUi(store, { selectedSlot: null, focusSlot: null });
        emit(ctx, 'ui:select', { slot: null });
      }
      // keep keyboard users on the plot they left
      if (sel !== null && sel !== undefined) document.querySelector(`#dock [data-slot="${sel}"]`)?.focus?.({ preventScroll: true });
      return true;
    }
    if (s.ui?.pickBean) {
      patchUi(store, { pickBean: null });
      emit(ctx, 'ui:pick', { bean: null });
      announce(t('g.a11y.cancelPick'));
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ safe area

  function measure() {
    const W = innerWidth;
    const H = innerHeight;
    const hud = $('hud')?.getBoundingClientRect();
    const bottom = $('bottom')?.getBoundingClientRect();
    const top = hud ? Math.max(0, Math.round(hud.bottom)) : 0;
    let bot = bottom ? Math.max(0, Math.round(H - bottom.top)) : 0;
    let left = 0;
    let right = 0;
    let sheet = 0;
    for (const p of panels.values()) {
      if (!p.isOpen()) continue;
      const r = p.el.getBoundingClientRect();
      if (isPhone()) {
        sheet = Math.max(sheet, Math.round(H - r.top));
      } else if (p.side === 'left') left = Math.max(left, Math.round(r.right));
      else right = Math.max(right, Math.round(W - r.left));
    }
    // a tall sheet must not squeeze the island to nothing: the projection centre stops at 60 % of the height
    bot = Math.max(bot, Math.min(sheet, Math.round(H * 0.6)));
    return { top, right, bottom: bot, left, hudH: top, bottomH: bottom ? Math.round(H - bottom.top) : 0, sheetH: sheet };
  }

  function reportSafe() {
    safeTimer = 0;
    const m = measure();
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('--hud-h', m.hudH + 'px');
    rootStyle.setProperty('--bottom-h', m.bottomH + 'px');
    rootStyle.setProperty('--sheet-h', m.sheetH + 'px');
    const rect = { top: m.top, right: m.right, bottom: m.bottom, left: m.left };
    const key = JSON.stringify(rect);
    if (key === lastSafe) return;
    lastSafe = key;
    try {
      ctx.stage?.rig?.setSafeArea?.(rect);
    } catch (e) {
      console.error('[ui] setSafeArea failed', e);
    }
    emit(ctx, 'ui:safeArea', rect);
  }

  function scheduleSafe() {
    if (safeTimer) return;
    // after the panel's CSS transition settles (instant under reduced motion)
    safeTimer = setTimeout(reportSafe, reducedMotion() ? 0 : 60);
  }

  try {
    const ro = new ResizeObserver(scheduleSafe);
    for (const id of ['hud', 'bottom', 'panels']) {
      const el = $(id);
      if (el) ro.observe(el);
    }
    ctx.sheetsRO = ro;
  } catch {
    /* old browsers: resize events below still cover it */
  }
  addEventListener('resize', scheduleSafe);
  // A phone sheet slides in with a transform animation (sheet-in 0.3 s): its box changes while #panels' size does not,
  // so the ResizeObserver never fires again and the 60 ms first pass can catch it mid-slide. Measure again once each
  // panel animation or transition has finished, so the camera frames for the sheet's FINAL height (QA-06, QA-10).
  const settle = (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    for (const p of panels.values()) {
      if (p.el === el || p.el.contains(el)) {
        lastSafe = '';
        scheduleSafe();
        return;
      }
    }
  };
  document.addEventListener('animationend', settle, true);
  document.addEventListener('transitionend', settle, true);
  ctx.onStage(() => {
    lastSafe = '';
    scheduleSafe();
  });
  scheduleSafe();

  return {
    panel,
    get: (id) => panels.get(id) || null,
    open: (id, o) => panels.get(id)?.open(o),
    close: (id, o) => panels.get(id)?.close(o),
    toggle: (id, o) => panels.get(id)?.toggle(o),
    leftOpen: () => leftOpen,
    rightOpen: () => rightOpen,
    reportSafe: scheduleSafe,
    onEscape,
  };
}

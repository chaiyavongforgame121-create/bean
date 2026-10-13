/**
 * ui/radial.js — the long-press radial for a plot (GAME-DESIGN §6.11, P1).
 *
 *   Long-press 450 ms on a plot (3D, via picker.onLongPress) or a dock card (touch) → four round buttons
 *   around the finger: Inspect · Shade / Sun · Harvest / Pull · Focus. Harvest/Pull opens the confirm dialog —
 *   it never closes a position by itself. Esc, a tap elsewhere, or any choice closes the radial.
 *   Keyboard: focus starts on Inspect; arrow keys move round the ring.
 *
 * Exports: mount(deps) → { open(slot, x, y, o), close(), isOpen() }.  No three.js, no side effects at import.
 */

import { t } from '../../i18n.js';
import { getCtx } from './context.js';
import { h, $, setText, plotNo, icon, isBlocked, setBlocked, reducedMotion } from './util.js';
import { getActions } from './actions.js';
import * as D from './derive.js';
import { announce } from './a11y.js';

const R = 64; // ring radius (px)

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('radial')) return ctx.mods.radial;
  const { store } = ctx;
  const A = getActions(ctx);
  const ring = h('div', { class: 'radial', role: 'group', hidden: true });
  $('dialogs')?.append(ring);
  const btn = (cls, ico) => h('button', { type: 'button', class: `radial-btn ${cls}` }, icon(ico), h('span', { class: 'radial-text' }));
  const bInspect = btn('radial-btn--inspect', 'i-list');
  const bShade = btn('radial-btn--shade', 'i-parasol');
  const bClose = btn('radial-btn--close', 'i-basket');
  const bFocus = btn('radial-btn--focus', 'i-focus');
  const center = h('span', { class: 'radial-center', 'aria-hidden': 'true' });
  ring.append(center, bInspect, bShade, bClose, bFocus);
  const order = [bInspect, bShade, bClose, bFocus];
  let cur = null; // { slot, botId, opener }

  function open(slot, x, y, o = {}) {
    const s = store.get();
    const v = D.viewsOf(s).bySlot[slot] || D.viewOfBot(s, o.botId);
    if (!v) return;
    cur = { slot, botId: v.botId, opener: o.opener || document.activeElement };
    const n = plotNo(slot);
    ring.setAttribute('aria-label', t('g.radial.label', { n }));
    setText(center, `${n} ${v.coin}`);
    setText(bInspect.lastChild, t('g.radial.inspect'));
    const paused = v.state === 'paused';
    bShade.querySelector('use')?.setAttribute('href', `/img/icons.svg#${paused ? 'i-sun' : 'i-parasol'}`);
    setText(bShade.lastChild, t(paused ? 'g.radial.sun' : 'g.radial.shade'));
    const sunWhy = paused && (D.isHalted(s) || D.isDown(s) || D.isOffline(s));
    setBlocked(bShade, sunWhy || D.isOffline(s));
    const loss = D.closeChoice(s, v).loss; // same rule as the inspector and the confirm dialog
    bClose.querySelector('use')?.setAttribute('href', `/img/icons.svg#${loss ? 'i-hoe' : 'i-basket'}`);
    setText(bClose.lastChild, t(loss ? 'g.radial.pull' : 'g.radial.harvest'));
    bClose.classList.toggle('is-loss', loss);
    setBlocked(bClose, D.isOffline(s));
    // a testnet bot that is closing shows no Harvest / Shade / Resume (§9.4): the closing line is in the centre
    bShade.hidden = !!v.closing;
    bClose.hidden = !!v.closing;
    if (v.closing) setText(center, `${n} ${v.coin} · ${t('g.state.closing')}`);
    setText(bFocus.lastChild, t('g.radial.focus'));
    bFocus.hidden = !ctx.stage;
    // place the ring inside the viewport
    const cx = Math.max(R + 40, Math.min(innerWidth - R - 40, x));
    const cy = Math.max(R + 40, Math.min(innerHeight - R - 40, y));
    ring.style.transform = `translate3d(${Math.round(cx)}px, ${Math.round(cy)}px, 0)`;
    order.forEach((b, i) => {
      const a = -Math.PI / 2 + (i * Math.PI) / 2;
      b.style.setProperty('--dx', Math.round(Math.cos(a) * R) + 'px');
      b.style.setProperty('--dy', Math.round(Math.sin(a) * R) + 'px');
    });
    ring.hidden = false;
    ring.classList.toggle('is-in', !reducedMotion());
    try {
      navigator.vibrate?.(8);
    } catch {
      /* no haptics */
    }
    bInspect.focus({ preventScroll: true });
  }

  function close({ restore = true } = {}) {
    if (ring.hidden) return;
    ring.hidden = true;
    const c = cur;
    cur = null;
    if (restore && c?.opener?.isConnected) c.opener.focus?.({ preventScroll: true });
  }

  bInspect.addEventListener('click', () => {
    const c = cur;
    close({ restore: false });
    if (c) {
      A.select(c.slot);
      ctx.mods.inspector?.open?.({});
    }
  });
  bShade.addEventListener('click', () => {
    const c = cur;
    if (!c) return;
    if (isBlocked(bShade)) return announce(t('g.plant.downBlock'));
    close({ restore: false });
    const v = D.viewOfBot(store.get(), c.botId);
    if (v?.state === 'paused') A.resume(c.botId);
    else A.requestShade(c.botId, { opener: c.opener });
  });
  bClose.addEventListener('click', () => {
    const c = cur;
    if (!c) return;
    if (isBlocked(bClose)) return announce(t('g.plant.offBlock'));
    close({ restore: false });
    A.requestClose(c.botId, { opener: c.opener });
  });
  bFocus.addEventListener('click', () => {
    const c = cur;
    close({ restore: false });
    if (c) A.focusPlot(c.slot);
  });

  ring.addEventListener('keydown', (e) => {
    const vis = order.filter((b) => !b.hidden);
    const i = vis.indexOf(document.activeElement);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      vis[(i + 1) % vis.length]?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      vis[(i - 1 + vis.length) % vis.length]?.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      vis[(i + (e.shiftKey ? -1 : 1) + vis.length) % vis.length]?.focus();
    }
  });
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!ring.hidden && !ring.contains(e.target)) close({ restore: false });
    },
    true,
  );

  const apiOut = { open, close, isOpen: () => !ring.hidden };
  ctx.mods.radial = apiOut;
  return apiOut;
}

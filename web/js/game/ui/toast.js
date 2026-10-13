/**
 * ui/toast.js — short, non-blocking notes in #toasts (command errors, "graphics lowered", "slow GPU", burn list).
 *
 *   show(text, { tone: 'info'|'warn'|'up'|'down', ms = 5000, lines = [] }) → { close() }
 *
 * #toasts is aria-hidden: anything a screen reader must hear also goes to #announce (the caller does that).
 * At most 3 toasts are visible; the oldest leaves first. Text is set with textContent only.
 * Also listens to bus `quality` (tier step-down → g.set.qualityLowered) and `boot:slowGpu`.
 *
 * No three.js, no side effects at import.
 */

import { t } from '../../i18n.js';
import { getCtx, on } from './context.js';
import { h, $ } from './util.js';

const MAX = 3;

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('toast')) return ctx.mods.toast;
  const box = $('toasts');

  function show(text, { tone = 'info', ms = 5000, lines = [] } = {}) {
    if (!box || !text) return { close() {} };
    const el = h(
      'div',
      { class: `toast toast--${tone}` },
      h('p', { class: 'toast-text', text }),
      lines.length ? h('ul', { class: 'toast-lines' }, lines.map((l) => h('li', { class: l.cls || '', text: l.text ?? l }))) : null,
    );
    box.append(el);
    while (box.children.length > MAX) box.firstElementChild.remove();
    let timer = setTimeout(close, ms);
    el.addEventListener('pointerenter', () => clearTimeout(timer));
    el.addEventListener('pointerleave', () => (timer = setTimeout(close, 1500)));
    function close() {
      clearTimeout(timer);
      if (!el.isConnected) return;
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 220);
    }
    return { close };
  }

  // graphics governor stepped down (§7.5)
  on(ctx, 'quality', (q) => {
    if (q && (q.reason === 'governor' || q.step || q.lowered)) show(t('g.set.qualityLowered'), { tone: 'info' });
  });
  on(ctx, 'boot:slowGpu', () => show(t('g.boot.slowGpu'), { tone: 'warn', ms: 9000 }));
  // QA-11: the server announced a restart (deploy / docker restart); the stream reconnects and data.js refreshes on
  // reopen, so this is information only. One toast per announcement, however many tabs of state it touches.
  let restartShownMs = 0;
  on(ctx, 'data:server_restart', () => {
    const at = Date.now();
    if (at - restartShownMs < 10_000) return;
    restartShownMs = at;
    show(t('g.err.restarting'), { tone: 'warn', ms: 8000 });
  });

  const api = { show };
  ctx.mods.toast = api;
  return api;
}

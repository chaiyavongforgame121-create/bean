/**
 * ui/listview.js — the field as a table (GAME-DESIGN §6.11, P1): the full screen-reader twin of the field.
 *
 *   Plot | Crop | Side | Lev. | Mark | Entry | P&L | % of water | Water | To liq. | State | Actions
 *   Actions: Inspect · Shade / Sun · Harvest / Pull (opens the confirm — never closes directly).
 *   Focusing a row (or hovering it) highlights the plot in 3D. Bots beyond the drawn plots are listed too.
 *   The "Open the list view" skip button (#skipList, right after the skip link) opens it.
 *
 * Exports: mount(deps) → { panel, render() }.  No three.js, no side effects at import.
 */

import { t, onLangChange } from '../../i18n.js';
import { usd } from '../../format.js';
import { fmtPx } from '../../model.js';
import { getCtx } from './context.js';
import { h, $, setText, cropIcon, cropName, plotNo, levText, watch, setBlocked, isBlocked } from './util.js';
import { getSheets } from './sheets.js';
import { getActions } from './actions.js';
import { pnlText, pctText, stateText, liqText } from './plotText.js';
import * as D from './derive.js';
import { announce } from './a11y.js';

const COLS = ['g.list.plot', 'g.list.crop', 'g.list.side', 'g.list.lev', 'g.list.mark', 'g.list.entry', 'g.list.pnl', 'g.list.pct', 'g.list.water', 'g.list.liq', 'g.list.state', 'g.list.actions'];

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('listview')) return ctx.mods.listview;
  const { store } = ctx;
  const A = getActions(ctx);
  const sheets = getSheets(ctx);
  const p = sheets.panel('list', { side: 'left', titleKey: 'g.list.title', snap: 92, icon: 'i-list' });
  const caption = h('caption', { class: 'sr-only' });
  const thead = h('thead', {}, h('tr', {}, COLS.map((k) => h('th', { scope: 'col', dataset: { key: k } }))));
  const tbody = h('tbody');
  const table = h('table', { class: 'grid grid--list' }, caption, thead, tbody);
  const note = h('p', { class: 'panel-foot' });
  p.body.append(h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-labelledby': 'panel-list-title' }, table), note);
  const rows = new Map(); // botId → row

  function hover(slot) {
    try {
      ctx.stage?.field?.setHover?.(slot);
    } catch {
      /* 3D optional */
    }
  }

  function makeRow(botId) {
    const cells = COLS.map((k, i) => (i === 0 ? h('th', { scope: 'row', class: 'num' }) : h('td')));
    const inspect = h('button', { type: 'button', class: 'btn btn--sm btn--paper' });
    const shade = h('button', { type: 'button', class: 'btn btn--sm btn--paper' });
    const close = h('button', { type: 'button', class: 'btn btn--sm' });
    cells[11].append(h('span', { class: 'row-actions' }, inspect, shade, close));
    const tr = h('tr', { dataset: { bot: botId } }, cells);
    const r = { tr, cells, inspect, shade, close, view: null, cropCoin: null };
    inspect.addEventListener('click', () => {
      const v = r.view;
      if (!v) return;
      if (v.slot < D.slotsOf(store.get()).count) {
        A.select(v.slot);
        if (!document.documentElement.dataset.sheet) ctx.mods.inspector?.open?.({ opener: inspect });
      } else ctx.mods.inspector?.openBot?.(v.botId, { opener: inspect });
    });
    shade.addEventListener('click', () => {
      const v = r.view;
      if (!v) return;
      if (isBlocked(shade)) return announce(shade.dataset.why || '');
      if (v.state === 'paused') A.resume(v.botId);
      else A.requestShade(v.botId, { opener: shade });
    });
    close.addEventListener('click', () => {
      const v = r.view;
      if (!v) return;
      if (isBlocked(close)) return announce(t('g.plant.offBlock'));
      A.requestClose(v.botId, { opener: close });
    });
    tr.addEventListener('focusin', () => r.view && hover(r.view.slot));
    tr.addEventListener('focusout', () => hover(null));
    tr.addEventListener('pointerenter', () => r.view && hover(r.view.slot));
    tr.addEventListener('pointerleave', () => hover(null));
    rows.set(botId, r);
    return r;
  }

  function fill(r, v, s, count) {
    r.view = v;
    const c = r.cells;
    const drawn = v.slot < count;
    setText(c[0], drawn ? plotNo(v.slot) : '—');
    if (r.cropCoin !== v.coin) {
      c[1].replaceChildren(h('span', { class: 'cell-ico' }, cropIcon(v.coin)), h('b', { text: v.coin }), ' ', h('span', { class: 'vbadge vbadge--testnet list-venue', hidden: true }), ' ', h('span', { class: 'muted' }));
      r.cropCoin = v.coin;
    }
    setText(c[1].lastChild, cropName(v.coin));
    // TESTNET bots say so in their row (§9.4 venue badges)
    const vb = c[1].querySelector('.list-venue');
    if (vb) {
      vb.hidden = v.venue !== 'testnet';
      setText(vb, v.venue === 'testnet' ? t('g.venue.testnet') : '');
    }
    const side = v.side > 0 ? 'long' : v.side < 0 ? 'short' : 'flat';
    c[2].replaceChildren(h('span', { class: `pill pill--${side}`, text: t(v.side > 0 ? 'g.side.long' : v.side < 0 ? 'g.side.short' : 'g.side.flat') }));
    setText(c[3], levText(v.lev));
    c[3].className = 'num';
    setText(c[4], (v.markEst ? '≈ ' : '') + fmtPx(v.mark, v.szDecimals));
    c[4].className = 'num';
    setText(c[5], v.side ? fmtPx(v.entry, v.szDecimals) : '—');
    c[5].className = 'num';
    const pnl = pnlText(v);
    setText(c[6], pnl.text);
    c[6].className = `num money money--${pnl.tone}`;
    setText(c[7], pctText(v));
    c[7].className = 'num';
    setText(c[8], usd(v.water, 2));
    c[8].className = 'num';
    setText(c[9], v.side ? liqText(v) : '—');
    c[9].className = v.liqInfo?.band === 'danger' ? 'warn' : '';
    setText(c[10], stateText(v));
    setText(r.inspect, t('g.radial.inspect'));
    const offline = D.isOffline(s);
    const paused = v.state === 'paused';
    const sunWhy = paused ? (offline ? t('g.plant.offBlock') : D.isHalted(s) ? t(D.copyKey(s, 'plot.emptyHalted')) : D.isDown(s) ? t('g.plant.downBlock') : '') : offline ? t('g.plant.offBlock') : '';
    setText(r.shade, t(paused ? 'g.radial.sun' : 'g.radial.shade'));
    r.shade.dataset.why = sunWhy;
    setBlocked(r.shade, !!sunWhy || A.isPending(v.botId));
    const loss = D.closeChoice(s, v).loss; // same rule as the inspector and the confirm dialog
    setText(r.close, t(loss ? 'g.radial.pull' : 'g.radial.harvest'));
    r.close.className = `btn btn--sm ${loss ? 'btn--danger-outline' : 'btn--gold'}`;
    setBlocked(r.close, offline || A.isPending(v.botId));
    // closing on testnet: the actions wait until the position is flat (never a second bot_close, §9.4)
    r.shade.hidden = !!v.closing;
    r.close.hidden = !!v.closing;
    for (const b of [r.inspect, r.shade, r.close]) b.setAttribute('aria-label', `${b.textContent} — ${t('g.dock.plot', { n: drawn ? plotNo(v.slot) : '—' })} ${v.coin}`);
  }

  function render() {
    p.setTitle(t('g.list.title'));
    setText(caption, t('g.list.title'));
    for (const th of thead.querySelectorAll('th')) setText(th, t(th.dataset.key));
    if (!p.isOpen()) return;
    const s = store.get();
    const all = D.viewsOf(s);
    const views = [...Object.values(all.bySlot), ...all.hidden].filter(Boolean).sort((a, b) => a.slot - b.slot);
    const kids = [];
    for (const v of views) {
      const r = rows.get(v.botId) || makeRow(v.botId);
      fill(r, v, s, all.count);
      kids.push(r.tr);
    }
    for (const id of [...rows.keys()]) if (!views.some((v) => v.botId === id)) rows.delete(id);
    if (!kids.length) kids.push(h('tr', {}, h('td', { colspan: String(COLS.length), class: 'empty', text: t('g.empty.list') })));
    const same = tbody.children.length === kids.length && kids.every((k, i) => tbody.children[i] === k);
    if (!same) {
      const active = document.activeElement;
      tbody.replaceChildren(...kids);
      if (active && kids.some((k) => k.contains(active))) active.focus({ preventScroll: true });
    }
    setText(note, all.hidden.length ? t('g.dock.hidden', { n: all.hidden.length }) : '');
  }

  $('skipList')?.addEventListener('click', (e) => p.open({ opener: e.currentTarget }));
  p.onOpen(render);
  watch(store, (s) => [s.views, s.bots, s.marks?.t, s.live, s.net?.ok, s.feed, s.ui?.pending], render, (a, b) => !!a && !!b && a.every((x, i) => Object.is(x, b[i])));
  A.onChange(render);
  onLangChange(render);
  render();

  const apiOut = { panel: p, render };
  ctx.mods.listview = apiOut;
  return apiOut;
}

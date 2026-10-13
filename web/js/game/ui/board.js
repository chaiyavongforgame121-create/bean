/**
 * ui/board.js — the market board panel and the board landmark label (GAME-DESIGN §6.4, §2.4).
 *
 *   <table>: coin | crop | price (mid) | 24h | funding /h (info only) | updated
 *   footnote: g.board.note (real) or g.board.noteSim (sim)
 *
 * Funding is information only: paper trades here are never charged funding (§6.13 rule 7).
 * Price direction stays neutral ink with ▴/▾ plus a screen-reader word (J6).
 * The world label on the board landmark shows the selected plot's coin, else the biggest 24 h mover.
 *
 * Exports: mount(deps) → { panel, render() }.  No three.js, no side effects at import.
 */

import { t, onLangChange } from '../../i18n.js';
import { fmtPx } from '../../model.js';
import { isNum } from '../../format.js';
import { getCtx, on } from './context.js';
import { h, $, setText, cropIcon, cropName, chgText, ageLabel, watch } from './util.js';
import { getSheets } from './sheets.js';
import * as D from './derive.js';

/** Funding per hour as a signed percentage with 4 decimals ("0.0013%"); '—' when unknown. */
export function fundingText(rate) {
  if (!isNum(rate)) return '—';
  const v = Number(rate) * 100;
  const s = Math.abs(v).toFixed(4);
  if (Number(s) === 0) return '0.0000%';
  return (v < 0 ? '−' : '+') + s + '%';
}

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('board')) return ctx.mods.board;
  const { store } = ctx;
  const sheets = getSheets(ctx);
  const p = sheets.panel('board', { side: 'left', titleKey: 'g.board.title', snap: 60, icon: 'i-prices' });

  const cols = ['g.board.coin', 'g.list.crop', 'g.board.price', 'g.board.chg24', 'g.board.funding', 'g.board.age'];
  const thead = h('thead', {}, h('tr', {}, cols.map((k) => h('th', { scope: 'col', dataset: { key: k } }))));
  const tbody = h('tbody');
  const table = h('table', { class: 'grid grid--board' }, h('caption', { class: 'sr-only' }), thead, tbody);
  const note = h('p', { class: 'panel-foot' });
  p.body.append(h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': t('g.board.title') }, table), note);
  const rows = new Map();

  function rowFor(coin) {
    let r = rows.get(coin);
    if (r) return r;
    const tr = h(
      'tr',
      { dataset: { coin } },
      h('th', { scope: 'row', class: 'c-coin' }, h('span', { class: 'cell-ico' }, cropIcon(coin)), h('span', { text: coin })),
      h('td', { class: 'c-crop' }),
      h('td', { class: 'c-px num' }),
      h('td', { class: 'c-chg num' }, h('span', { class: 'chg' }), h('span', { class: 'sr-only' })),
      h('td', { class: 'c-fund num' }),
      h('td', { class: 'c-age' }),
    );
    r = { tr, crop: tr.children[1], px: tr.children[2], chg: tr.children[3].firstChild, chgSr: tr.children[3].lastChild, fund: tr.children[4], age: tr.children[5] };
    rows.set(coin, r);
    return r;
  }

  function render() {
    const s = store.get();
    const sim = D.isSim(s);
    for (const th of thead.querySelectorAll('th')) setText(th, t(th.dataset.key));
    setText(table.querySelector('caption'), t('g.board.title'));
    setText(note, t(sim ? 'g.board.noteSim' : 'g.board.note'));
    renderLabel();
    if (!p.isOpen()) return;
    const coins = D.coinList(s);
    const nowMs = D.nowOf(s);
    const kids = [];
    for (const c of coins) {
      const r = rowFor(c.coin);
      const price = D.priceOf(s, c.coin);
      setText(r.crop, cropName(c.coin));
      setText(r.px, fmtPx(price.px, c.sz_decimals) + (sim ? ` · ${t('g.ticker.sim')}` : ''));
      const ch = isNum(c.change_24h) ? Number(c.change_24h) : null;
      setText(r.chg, chgText(ch, 2));
      setText(r.chgSr, ch === null ? '' : ` (${t(ch >= 0 ? 'g.board.up' : 'g.board.down')})`);
      setText(r.fund, sim || !isNum(c.funding_1h) ? '—' : fundingText(c.funding_1h));
      const a = ageLabel(price.ms, nowMs);
      setText(r.age, price.stale ? t('g.state.frozen') : a.text);
      r.age.className = `c-age age age--${price.stale ? 'delayed' : a.kind}`;
      r.tr.classList.toggle('is-stale', price.stale);
      kids.push(r.tr);
    }
    if (!kids.length) kids.push(h('tr', {}, h('td', { colspan: '6', class: 'empty', text: t('g.clock.waiting') })));
    tbody.replaceChildren(...kids);
  }

  // ------------------------------------------------------------------ world label on the board landmark

  let label = null;
  let anchorH = null;
  function boardCoin(s) {
    const sel = s.ui?.selectedSlot;
    const v = sel !== null && sel !== undefined ? D.viewsOf(s).bySlot[sel] : null;
    if (v?.coin) return v.coin;
    let best = null;
    for (const c of D.coinList(s)) if (isNum(c.change_24h) && (!best || Math.abs(c.change_24h) > Math.abs(best.change_24h))) best = c;
    return best?.coin || null;
  }
  function renderLabel() {
    if (!label) return;
    const s = store.get();
    const coin = boardCoin(s);
    if (!coin) {
      label.hidden = true;
      return;
    }
    label.hidden = false;
    const c = D.coinOf(s, coin) || {};
    const price = D.priceOf(s, coin);
    setText(label.querySelector('.lm-coin'), coin);
    setText(label.querySelector('.lm-px'), fmtPx(price.px, c.sz_decimals));
    setText(label.querySelector('.lm-chg'), chgText(c.change_24h, 1));
    setText(label.querySelector('.lm-tag'), D.isSim(s) ? t('g.ticker.sim') : price.stale ? t('g.state.frozen') : '');
  }
  ctx.onStage((stage) => {
    try {
      anchorH?.remove?.();
      const lm = stage?.world?.landmarks?.get?.('board');
      if (!lm || !stage.labels?.anchor) return;
      label = h(
        'div',
        { class: 'lm-sign lm-sign--board', 'aria-hidden': 'true' },
        h('span', { class: 'lm-coin' }),
        h('span', { class: 'lm-px num' }),
        h('span', { class: 'lm-chg num' }),
        h('span', { class: 'lm-tag' }),
      );
      $('chips')?.append(label);
      anchorH = stage.labels.anchor(lm.anchor || lm.object3D, label, { offsetY: 0.6 });
      renderLabel();
    } catch (e) {
      console.error('[ui] board label failed', e);
    }
  });

  p.onOpen(render);
  watch(store, (s) => [s.market, s.marks?.t, s.feed, s.ui?.selectedSlot], render, (a, b) => !!a && !!b && a.every((x, i) => Object.is(x, b[i])));
  const timer = setInterval(() => p.isOpen() && render(), 5000);
  onLangChange(() => {
    p.setTitle(t('g.board.title'));
    render();
  });
  on(ctx, 'ui:board', () => p.open({}));

  const apiOut = { panel: p, render, dispose: () => clearInterval(timer) };
  ctx.mods.board = apiOut;
  return apiOut;
}

/**
 * ui/shelf.js — the seed stall catalogue and the seed drag source (GAME-DESIGN §6.5 "Catalogue rules", §5.5).
 *
 *   Same query and filters as the classic shelf: shelfQuery() with sort -total_return | -ret_7d | -sharpe, the
 *   variety (archetype) filter and "sprouting now" (in position). `tradeable` is dropped when the field is burned.
 *   Each card: crop + coin, the real (or SIM-labelled) price with its 24 h change in neutral ink, variety ·
 *   strategy · leverage (venue max), paper stats, the $1,000 paper-account sparkline, what the bean holds now,
 *   and Select / Plant… buttons.
 *     - a planted coin's card is dimmed "in plot N" (the server allows one bot per coin);
 *     - a stale coin's card says g.shelf.stale and its Plant button is blocked;
 *     - Select enters pick mode (store.ui.pickBean + bus ui:pick); "Plant in the next free plot" plants the
 *       selected seed in the lowest free plot;
 *     - drag a packet (by its crop badge) onto an empty plot — in the 3D field or in the dock — to plant (P1).
 *   Footer: g.shelf.disclaimer (past results do not predict future ones).
 *
 * Data: store.shelf {rows, curves, loading, error, filters} is filled by WP2's data.restock(); without a data
 * layer this module restocks itself with brood-api (same query), so the HUD works on its own.
 *
 * Exports: mount(deps) → { panel, openFor(slot, o), restock(), select(bean) }.
 * No three.js, no side effects at import.
 */

import * as api from '../../brood-api.js';
import { t, tn, onLangChange } from '../../i18n.js';
import { shelfQuery, fmtPx, familyOf, FAMILY_TINT } from '../../model.js';
import { pct, fmt, isNum } from '../../format.js';
import { drawSparkline } from '../../plant.js';
import { getCtx, emit } from './context.js';
import { h, $, setText, setAttr, cropIcon, cropName, chgText, watch, patchUi, isPhone, plotNo, levText, setBlocked, isBlocked, reducedMotion } from './util.js';
import { getSheets } from './sheets.js';
import { getActions } from './actions.js';
import { announce } from './a11y.js';
import * as D from './derive.js';

const SORTS = [
  ['-total_return', 'shelf.byReturn'],
  ['-ret_7d', 'shelf.by7d'],
  ['-sharpe', 'shelf.bySharpe'],
];
const DRAG_PX = 8;

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('shelf')) return ctx.mods.shelf;
  const { store } = ctx;
  const A = getActions(ctx);
  const sheets = getSheets(ctx);
  const p = sheets.panel('shelf', { side: 'left', titleKey: 'g.shelf.title', snap: 60, icon: 'i-seed' });
  let targetSlot = null; // the plot the catalogue was opened for ("+ plant" on an empty plot)
  let restockSeq = 0;

  // ------------------------------------------------------------------ filters

  const arch = h('select', { class: 'select', id: 'shelfArch' });
  const sort = h('select', { class: 'select', id: 'shelfSort' });
  const sprout = h('input', { type: 'checkbox', id: 'shelfSprout', class: 'check' });
  const restockBtn = h('button', { type: 'button', class: 'btn btn--paper btn--sm', id: 'shelfRestock' });
  const lArch = h('label', { for: 'shelfArch', class: 'f-label' });
  const lSort = h('label', { for: 'shelfSort', class: 'f-label' });
  const lSprout = h('label', { for: 'shelfSprout', class: 'f-check' }, sprout, h('span'));
  const filters = h('div', { class: 'shelf-filters' }, h('div', { class: 'f-field' }, lArch, arch), h('div', { class: 'f-field' }, lSort, sort), h('div', { class: 'f-row' }, lSprout, restockBtn));
  const target = h('p', { class: 'shelf-target', hidden: true });
  const list = h('ul', { class: 'seed-list', 'aria-live': 'off' });
  const nextBtn = h('button', { type: 'button', class: 'btn btn--wood btn--block', id: 'shelfPlantNext' });
  const hint = h('p', { class: 'shelf-hint' });
  const disclaimer = h('p', { class: 'panel-foot' });
  p.body.append(filters, target, list, nextBtn, hint, disclaimer);

  function filtersOf() {
    const f = store.get().shelf?.filters || {};
    return { sort: f.sort || '-total_return', archetype: f.archetype || '', sproutingOnly: f.sproutingOnly !== false };
  }
  function setFilters(patch) {
    const s = store.get();
    const shelf = s.shelf || {};
    store.set({ shelf: { ...shelf, filters: { ...filtersOf(), ...patch } } });
    restock();
  }
  arch.addEventListener('change', () => setFilters({ archetype: arch.value }));
  sort.addEventListener('change', () => setFilters({ sort: sort.value }));
  sprout.addEventListener('change', () => setFilters({ sproutingOnly: sprout.checked }));
  restockBtn.addEventListener('click', () => restock());

  function renderFilters() {
    const f = filtersOf();
    setText(lArch, t('shelf.variety'));
    setText(lSort, t('shelf.sort'));
    setText(lSprout.lastChild, t('shelf.sprouting'));
    setText(restockBtn, t('shelf.restock'));
    setAttr(restockBtn, 'aria-label', t('shelf.restockLabel'));
    const names = archetypes();
    const opts = [h('option', { value: '', text: t('shelf.anyVariety') }), ...names.map((n) => h('option', { value: n, text: n }))];
    arch.replaceChildren(...opts);
    arch.value = names.includes(f.archetype) ? f.archetype : '';
    sort.replaceChildren(...SORTS.map(([v, k]) => h('option', { value: v, text: t(k) })));
    sort.value = f.sort;
    sprout.checked = f.sproutingOnly;
  }
  function archetypes() {
    const a = store.get().meta?.archetypes;
    const names = (Array.isArray(a) ? a : []).map((x) => (typeof x === 'string' ? x : x?.name)).filter((n) => typeof n === 'string' && n);
    return names.length ? names : ['standard', 'hyper_algo', 'degen_algo', 'swarm'];
  }

  // ------------------------------------------------------------------ restock (data layer, or our own)

  async function restock() {
    if (typeof ctx.data?.restock === 'function') {
      try {
        await ctx.data.restock();
      } catch (e) {
        console.error('[ui] restock failed', e);
      }
      return;
    }
    const seq = ++restockSeq;
    const s0 = store.get();
    store.set({ shelf: { ...(s0.shelf || {}), loading: true, error: null } });
    try {
      const f = filtersOf();
      const q = shelfQuery({ ...f, halted: D.isHalted(s0) });
      let r = await api.query('beans', q);
      if (q.tradeable && r.venue && r.venue.known === false) r = await api.query('beans', { ...q, tradeable: undefined });
      if (seq !== restockSeq) return;
      const rows = (Array.isArray(r.rows) ? r.rows : []).slice(0, 5);
      let curves = {};
      if (rows.length) {
        try {
          const c = await api.query('equity_curves', { ids: rows.map((b) => b.id) });
          curves = c?.curves && typeof c.curves === 'object' ? c.curves : {};
        } catch {
          curves = {};
        }
      }
      if (seq !== restockSeq) return;
      const s = store.get();
      store.set({ shelf: { ...(s.shelf || {}), rows, curves, loading: false, error: null, fetchedMs: Date.now() } });
    } catch (e) {
      if (seq !== restockSeq) return;
      const s = store.get();
      store.set({ shelf: { ...(s.shelf || {}), rows: [], loading: false, error: e?.message || String(e) } });
    }
  }

  // ------------------------------------------------------------------ cards

  const cards = new Map(); // beanId → card

  function makeCard(b) {
    const handle = h('button', { type: 'button', class: 'sc-handle', 'aria-hidden': 'true', tabindex: '-1' }, cropIcon(b.coin));
    const sel = h('button', { type: 'button', class: 'btn btn--paper btn--sm sc-select', 'aria-pressed': 'false' });
    const plant = h('button', { type: 'button', class: 'btn btn--wood btn--sm sc-plant' });
    const canvas = h('canvas', { class: 'sc-spark', width: '240', height: '44', role: 'img' });
    const li = h(
      'li',
      { class: 'seed-card', dataset: { bean: String(b.id), family: familyOf(b.archetype) } },
      h(
        'div',
        { class: 'sc-head' },
        handle,
        h('div', { class: 'sc-name' }, h('b', { class: 'sc-coin', text: b.coin }), h('span', { class: 'sc-crop' })),
        h('div', { class: 'sc-price' }, h('span', { class: 'sc-px num' }), h('span', { class: 'sc-chg num' }), h('span', { class: 'tag sc-tag', hidden: true })),
      ),
      h('p', { class: 'sc-variety' }),
      h('p', { class: 'sc-stats num' }),
      h('figure', { class: 'sc-curve' }, canvas, h('figcaption', { class: 'sc-curve-cap' })),
      h('p', { class: 'sc-now' }),
      h('p', { class: 'sc-note', hidden: true }),
      h('div', { class: 'sc-actions' }, sel, plant),
    );
    li.style.setProperty('--tint', FAMILY_TINT[familyOf(b.archetype)] || FAMILY_TINT.standard);
    const card = { li, b, handle, sel, plant, canvas, drawnKey: '' };
    sel.addEventListener('click', () => select(card.b));
    plant.addEventListener('click', () => {
      if (isBlocked(plant)) {
        const why = blockReason(card.b);
        if (why) {
          announce(why);
          ctx.mods.toast?.show?.(why, { tone: 'warn' });
        }
        return;
      }
      const s = store.get();
      const slot = D.freeSlotOf(s, targetSlot);
      A.requestPlant(card.b, slot, { opener: plant });
    });
    wireDrag(card);
    cards.set(String(b.id), card);
    return card;
  }

  function blockReason(b) {
    const r = D.plantBlock(store.get(), b, null);
    if (!r) return '';
    if (r.key === 'packet.alreadyPlanted') {
      const slot = D.plantedSlotOfCoin(store.get(), b.coin);
      return slot !== null && slot >= 0 ? t('g.shelf.inPlot', { n: plotNo(slot) }) : t(r.key, r.vars);
    }
    if (r.key === 'g.plant.staleBlock') return t('g.shelf.stale', { coin: b.coin });
    return t(r.key, r.vars);
  }

  function fillCard(card) {
    const s = store.get();
    const b = card.b;
    const li = card.li;
    const coinRow = D.coinOf(s, b.coin) || {};
    const price = D.priceOf(s, b.coin);
    const sim = D.isSim(s);
    setText(li.querySelector('.sc-crop'), cropName(b.coin));
    setText(li.querySelector('.sc-px'), t(sim ? 'g.shelf.priceSim' : 'g.shelf.price', { px: fmtPx(price.px, coinRow.sz_decimals) }));
    setText(li.querySelector('.sc-chg'), chgText(coinRow.change_24h, 1));
    const tag = li.querySelector('.sc-tag');
    tag.hidden = !sim;
    setText(tag, t('g.ticker.sim'));
    const venue = isNum(b.venue_max_leverage) ? ` (${t('g.shelf.venue', { n: Math.round(b.venue_max_leverage) })})` : '';
    setText(li.querySelector('.sc-variety'), `${b.archetype} · ${b.strategy} · ${levText(b.leverage)}${venue}`);
    setText(li.querySelector('.sc-stats'), t('g.shelf.stats', { ret: pct(b.total_return, 1), r7: pct(b.ret_7d, 1), dd: isNum(b.max_dd) ? (Math.abs(b.max_dd) * 100).toFixed(1) + '%' : '—', wr: isNum(b.win_rate) ? Math.round(b.win_rate * 100) + '%' : '—' }) + ` · ${tn('packet.fills', b.trades, { n: fmt(b.trades) })}`);
    setText(li.querySelector('.sc-curve-cap'), t('g.shelf.curve'));
    setAttr(card.canvas, 'aria-label', `${t('g.shelf.curve')}: ${pct(b.total_return, 1)}`);
    const side = Math.sign(Number(b.side) || 0);
    setText(li.querySelector('.sc-now'), side ? t('g.shelf.beanNow', { side: t(side > 0 ? 'g.side.long' : 'g.side.short'), px: fmtPx(b.entry_px, coinRow.sz_decimals) }) : t('g.shelf.beanFlat'));
    li.querySelector('.sc-now').dataset.side = side > 0 ? 'long' : side < 0 ? 'short' : 'flat';

    // a spectator browses read-only cards; their Plant button is the way in ("Sign in to plant", §9.1)
    const spectator = D.isSpectator(s);
    const why = spectator ? '' : blockReason(b);
    const plantedSlot = D.plantedSlotOfCoin(s, b.coin);
    const note = li.querySelector('.sc-note');
    note.hidden = !why;
    setText(note, why);
    note.dataset.tone = price.stale ? 'warn' : '';
    li.classList.toggle('is-planted', plantedSlot !== null);
    li.classList.toggle('is-stale', price.stale);
    const pick = s.ui?.pickBean;
    const selected = !!pick && Number(typeof pick === 'object' ? pick.id : pick) === Number(b.id);
    li.classList.toggle('is-selected', selected);
    setText(card.sel, selected ? t('packet.selected') : t('g.shelf.select'));
    card.sel.setAttribute('aria-pressed', String(selected));
    setText(card.plant, t(spectator ? 'g.gate.signInToPlant' : 'g.shelf.plant'));
    card.sel.hidden = spectator;
    setBlocked(card.plant, !!why);
    setBlocked(card.sel, !!why && plantedSlot !== null);
    setAttr(card.plant, 'aria-label', `${t('g.shelf.plant')} ${b.coin}${why ? ' — ' + why : ''}`);
    setAttr(card.sel, 'aria-label', `${t('g.shelf.select')} ${b.coin} (${b.archetype} · ${b.strategy})`);
    drawCurve(card, s);
  }

  function drawCurve(card, s) {
    const curves = s.shelf?.curves || {};
    const curve = curves[card.b.id] || curves[String(card.b.id)];
    const key = `${curve?.length || 0}:${document.documentElement.dataset.palette || ''}`;
    if (key === card.drawnKey && curve) return;
    const c = card.canvas;
    const ctx2d = c.getContext?.('2d');
    if (!ctx2d) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = c.clientWidth || 240;
    const hh = c.clientHeight || 44;
    c.width = Math.round(w * dpr);
    c.height = Math.round(hh * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    drawSparkline(ctx2d, w, hh, curve || [], {
      base: 1000,
      up: css.getPropertyValue('--up').trim() || '#237A4B',
      down: css.getPropertyValue('--down').trim() || '#B33A32',
      empty: s.shelf?.loading ? t('shelf.stocking') : t('packet.noHistory'),
      font: 'system-ui, "Segoe UI", "Leelawadee UI", "Noto Sans Thai", Tahoma, sans-serif',
    });
    card.drawnKey = curve ? key : '';
  }

  function render() {
    const s = store.get();
    const shelf = s.shelf || {};
    const rows = Array.isArray(shelf.rows) ? shelf.rows : [];
    list.setAttribute('aria-busy', shelf.loading ? 'true' : 'false');
    const kids = [];
    if (shelf.error && !rows.length) kids.push(h('li', { class: 'shelf-msg err', role: 'alert', text: t('shelf.error', { error: String(shelf.error).slice(0, 200) }) }));
    else if (!rows.length) kids.push(h('li', { class: 'shelf-msg', text: shelf.loading ? t('shelf.stocking') : t('shelf.empty') }));
    for (const b of rows) {
      let card = cards.get(String(b.id));
      if (!card) card = makeCard(b);
      card.b = b;
      fillCard(card);
      kids.push(card.li);
    }
    const same = list.children.length === kids.length && kids.every((k, i) => list.children[i] === k);
    if (!same) {
      const active = document.activeElement;
      list.replaceChildren(...kids);
      if (active && kids.some((k) => k.contains?.(active))) active.focus({ preventScroll: true });
    }
    for (const [id, card] of cards) if (!rows.some((b) => String(b.id) === id)) cards.delete(id);

    // target plot / next free plot / hints
    const free = D.freeSlotOf(s, targetSlot);
    target.hidden = targetSlot === null;
    setText(target, targetSlot !== null ? t('g.plant.slot', { n: plotNo(free ?? targetSlot) }) : '');
    const pick = pickedBean(s);
    setText(nextBtn, t('g.shelf.plantNext'));
    const nextWhy = !pick ? t('packet.pickFirst') : free === null ? t('g.plant.noSlot') : blockReason(pick);
    setBlocked(nextBtn, !!nextWhy);
    setAttr(nextBtn, 'aria-label', t('g.shelf.plantNext') + (nextWhy ? ' — ' + nextWhy : ''));
    nextBtn.hidden = D.isSpectator(s);
    setText(hint, D.isSpectator(s) ? t('g.gate.spectator') : D.isHalted(s) ? t(D.copyKey(s, 'shelf.noteHalted')) : nextWhy && pick ? nextWhy : t('g.shelf.dragHint'));
    setText(disclaimer, t('g.shelf.disclaimer', { source: t(D.isSim(s) ? 'g.src.sim' : 'g.src.real') }));
  }

  nextBtn.addEventListener('click', () => {
    if (isBlocked(nextBtn)) {
      announce(nextBtn.getAttribute('aria-label') || '');
      return;
    }
    const s = store.get();
    const pick = pickedBean(s);
    if (pick) A.requestPlant(pick, D.freeSlotOf(s, targetSlot), { opener: nextBtn });
  });

  function pickedBean(s) {
    const pb = s.ui?.pickBean;
    if (!pb) return null;
    return typeof pb === 'object' ? pb : D.beanOf(s, pb);
  }

  /** Select (or unselect) a seed: pick mode (§5.5). */
  function select(b) {
    const s = store.get();
    const cur = pickedBean(s);
    if (cur && Number(cur.id) === Number(b.id)) {
      patchUi(store, { pickBean: null });
      emit(ctx, 'ui:pick', { bean: null });
      announce(t('g.a11y.cancelPick'));
      return;
    }
    const why = blockReason(b);
    if (why && D.plantedSlotOfCoin(s, b.coin) !== null) {
      announce(why);
      return;
    }
    const bean = { ...b };
    patchUi(store, { pickBean: bean });
    emit(ctx, 'ui:pick', { bean });
    announce(t('g.a11y.pickMode', { coin: b.coin }));
    // with a plot already chosen ("+ plant" on a plot), go straight to the dialog
    if (targetSlot !== null && D.freeSlotOf(s, targetSlot) === targetSlot) {
      A.requestPlant(bean, targetSlot, { opener: cards.get(String(b.id))?.sel });
      return;
    }
    // phones: get the sheet out of the way so the field can be tapped
    if (isPhone()) p.close({ restore: false });
  }

  // ------------------------------------------------------------------ drag a packet onto a plot (P1)

  function wireDrag(card) {
    let start = null;
    let ghost = null;
    let pid = null;
    const handle = card.handle;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      start = { x: e.clientX, y: e.clientY };
      pid = e.pointerId;
      handle.setPointerCapture?.(pid);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== pid) return;
      if (!ghost && Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_PX) {
        if (blockReason(card.b)) {
          start = null;
          return;
        }
        ghost = h('div', { class: 'ghost-seed', 'aria-hidden': 'true' }, cropIcon(card.b.coin), h('b', { text: card.b.coin }));
        document.body.append(ghost);
        document.documentElement.classList.add('is-dragging-seed');
        select(card.b);
      }
      if (ghost) {
        ghost.style.transform = `translate3d(${e.clientX - 22}px, ${e.clientY - 22}px, 0)`;
        const slot = dropSlot(e.clientX, e.clientY);
        ghost.classList.toggle('is-ok', slot !== null);
        // let the 3D field pulse the ring under the seed (picker.dragOver → field, WP2/WP4)
        try {
          if (overStage(e.clientX, e.clientY)) ctx.stage?.picker?.dragOver?.(e.clientX, e.clientY, { bean: card.b.id, coin: card.b.coin });
          else ctx.stage?.picker?.dragLeave?.();
        } catch {
          /* 3D optional */
        }
      }
    });
    const end = (e) => {
      if (!start || e.pointerId !== pid) return;
      start = null;
      handle.releasePointerCapture?.(pid);
      if (!ghost) return;
      const slot = dropSlot(e.clientX, e.clientY);
      document.documentElement.classList.remove('is-dragging-seed');
      try {
        ctx.stage?.picker?.dragLeave?.();
      } catch {
        /* 3D optional */
      }
      if (slot !== null && e.type === 'pointerup') {
        ghost.remove();
        ghost = null;
        A.requestPlant(card.b, slot, { opener: card.plant });
        return;
      }
      // invalid drop: the ghost shakes and goes (reduced motion: it just goes)
      const g = ghost;
      ghost = null;
      if (reducedMotion()) g.remove();
      else {
        g.classList.add('is-bad');
        setTimeout(() => g.remove(), 260);
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function overStage(x, y) {
    return !!document.elementFromPoint(x, y)?.closest?.('#stage');
  }

  /**
   * The empty, plantable plot under the pointer: a dock card, or the 3D field (picker.slotNear snaps to the
   * nearest box within 2.2 u, else a direct pickAt hit).
   */
  function dropSlot(x, y) {
    const s = store.get();
    if (D.isHalted(s)) return null;
    const under = document.elementFromPoint(x, y);
    const cardEl = under?.closest?.('.plot-card.is-empty');
    if (cardEl && cardEl.dataset.slot !== '') return Number(cardEl.dataset.slot);
    if (under?.closest?.('#stage')) {
      try {
        const pk = ctx.stage?.picker;
        const near = pk?.slotNear?.(x, y);
        const hit = near ? { type: 'plot', slot: near.slot } : pk?.pickAt?.(x, y);
        if (hit && hit.type === 'plot' && Number.isInteger(hit.slot) && !D.viewsOf(s).bySlot[hit.slot]) return hit.slot;
      } catch {
        /* no 3D: dock only */
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ open / lifecycle

  function openFor(slot, o = {}) {
    targetSlot = Number.isInteger(slot) ? slot : null;
    p.open({ opener: o.opener || null });
    render();
  }

  p.onOpen(() => {
    renderFilters();
    const s = store.get();
    const age = Date.now() - (s.shelf?.fetchedMs || 0);
    if (!s.shelf?.rows?.length || age > 60_000) restock();
    render();
  });
  p.onClose(() => {
    targetSlot = null;
  });

  watch(store, (s) => [s.shelf, s.marks?.t, s.market, s.bots, s.ui?.pickBean, s.live?.halted, s.feed, s.net?.ok, s.user, s.mode], () => p.isOpen() && render(), (a, b) => !!a && !!b && a.every((x, i) => Object.is(x, b[i])));
  watch(store, (s) => s.meta, () => p.isOpen() && renderFilters());
  watch(store, (s) => s.settings?.palette, () => {
    for (const c of cards.values()) c.drawnKey = '';
    if (p.isOpen()) render();
  });
  onLangChange(() => {
    p.setTitle(t('g.shelf.title'));
    renderFilters();
    for (const c of cards.values()) c.drawnKey = '';
    render();
  });
  renderFilters();
  // the field may be empty on first visit: stock the shelf early so the first open is instant
  if (!store.get().shelf?.rows?.length && typeof ctx.data?.restock !== 'function') setTimeout(restock, 1200);

  const apiOut = { panel: p, openFor, restock, select, render };
  ctx.mods.shelf = apiOut;
  return apiOut;
}

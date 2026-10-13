/**
 * ui/dock.js — the plot dock: the accessible DOM twin of the field (GAME-DESIGN §6.1, §6.2, §7.1, J7).
 *
 *   <ol id="dock"> one <li><button> per drawn plot (10–15), then any open bots beyond the drawn plots:
 *     [01 🍊 BTC ↑ LONG 10×   +$3.10 ▲  +3.1%  ▮▮▮▯ ]   [03 ＋ plant]   (pick mode: [03 Plant SOL here])
 *
 *   - every positioned card shows side (word + arrow), leverage ×N and the liquidation thermometer (J7);
 *   - P&L has sign, colour and glyph; "≈" when the unrealized part is a client estimate (J1); % is of water;
 *   - age tag when the plot's mark is not fresh (§6.12); frozen / error / liquidation captions (§3.5);
 *   - aria-label = g.dock.label; aria-current="true" on the selected plot (two-way with the 3D field via
 *     store.ui.selectedSlot, §5.3);
 *   - click: occupied → select (the inspector opens); empty → plant dialog in pick mode, else the seed stall
 *     for that plot; double-click → focus; long-press (touch) → radial; hover/focus highlights the 3D plot.
 *   - Arrow keys move between cards; Home/End jump to the first/last.
 *
 * Numbers update in place at t = 0 (J2); cards are never rebuilt while focused.
 * Exports: mount(deps) → { render(), focusSlot(slot) }.  No three.js, no side effects at import.
 */

import { t, onLangChange } from '../../i18n.js';
import { getCtx, emit } from './context.js';
import { h, $, setText, setAttr, cropIcon, plotNo, watch, ageLabel, patchUi, levText, isPhone, reducedMotion } from './util.js';
import { stateText, pnlText, pctText, liqSegments, dockLabel, liqNear } from './plotText.js';
import { getActions } from './actions.js';
import * as D from './derive.js';
import { announce } from './a11y.js';

const LONG_PRESS_MS = 450;

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('dock')) return ctx.mods.dock;
  const { store } = ctx;
  const A = getActions(ctx);
  const ol = $('dock');
  const note = $('dockNote');
  const cards = new Map(); // key (slot number or 'h:<botId>') → card

  function makeCard(key) {
    const btn = h('button', { type: 'button', class: 'plot-card', dataset: { key: String(key) } });
    const top = h(
      'span',
      { class: 'pc-top' },
      h('span', { class: 'pc-no num' }),
      h('span', { class: 'pc-crop' }),
      h('span', { class: 'pc-coin' }),
      h('span', { class: 'vbadge vbadge--testnet pc-venue', hidden: true }),
      h('span', { class: 'pill pc-side' }, h('span', { class: 'pc-arrow' }), h('span', { class: 'pc-word' })),
      h('span', { class: 'pc-lev num' }),
    );
    const mid = h('span', { class: 'pc-mid' }, h('span', { class: 'pc-pnl money' }), h('span', { class: 'pc-pct num' }), h('span', { class: 'liqbar', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')));
    const foot = h('span', { class: 'pc-foot' }, h('span', { class: 'pc-state' }), h('span', { class: 'pc-age age' }));
    const empty = h('span', { class: 'pc-empty' }, h('span', { class: 'pc-no num' }), h('span', { class: 'pc-plus', 'aria-hidden': 'true', text: '＋' }), h('span', { class: 'pc-empty-text' }));
    btn.append(top, mid, foot, empty);
    const li = h('li', { class: 'dock-item' }, btn);
    const card = {
      key,
      li,
      btn,
      no: top.querySelector('.pc-no'),
      crop: top.querySelector('.pc-crop'),
      cropCoin: null,
      coin: top.querySelector('.pc-coin'),
      venue: top.querySelector('.pc-venue'),
      side: top.querySelector('.pc-side'),
      lev: top.querySelector('.pc-lev'),
      pnl: mid.querySelector('.pc-pnl'),
      pct: mid.querySelector('.pc-pct'),
      bar: mid.querySelector('.liqbar'),
      state: foot.querySelector('.pc-state'),
      age: foot.querySelector('.pc-age'),
      emptyNo: empty.querySelector('.pc-no'),
      emptyText: empty.querySelector('.pc-empty-text'),
      view: null,
      slot: null,
    };
    wire(card);
    cards.set(key, card);
    return card;
  }

  function wire(card) {
    const { btn } = card;
    btn.addEventListener('click', (e) => {
      if (pressFired) {
        pressFired = false;
        e.preventDefault();
        return;
      }
      onActivate(card, e);
    });
    btn.addEventListener('dblclick', () => {
      if (card.view && Number.isInteger(card.slot) && card.slot < D.slotsOf(store.get()).count) focusPlot(card.slot);
    });
    const hover = (on) => {
      try {
        ctx.stage?.field?.setHover?.(on && Number.isInteger(card.slot) ? card.slot : null);
      } catch {
        /* 3D optional */
      }
    };
    btn.addEventListener('pointerenter', () => hover(true));
    btn.addEventListener('pointerleave', () => hover(false));
    btn.addEventListener('focus', () => hover(true));
    btn.addEventListener('blur', () => hover(false));
    // long-press on touch → the radial (P1); never closes anything by itself
    let pressTimer = 0;
    let start = null;
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || !card.view) return;
      start = { x: e.clientX, y: e.clientY };
      pressTimer = setTimeout(() => {
        pressFired = true;
        const r = btn.getBoundingClientRect();
        ctx.mods.radial?.open?.(card.slot, r.left + r.width / 2, r.top, { opener: btn, botId: card.view.botId });
      }, LONG_PRESS_MS);
    });
    const cancel = () => clearTimeout(pressTimer);
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('pointermove', (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel();
    });
    btn.addEventListener('contextmenu', (e) => {
      if (pressFired) e.preventDefault();
    });
  }
  let pressFired = false;

  function onActivate(card) {
    const s = store.get();
    const v = card.view;
    if (v) {
      select(card.slot);
      return;
    }
    // empty plot
    // a spectator's empty plot opens the gate ("sign in to plant", §9.1)
    if (D.isSpectator(s)) {
      ctx.mods.gate?.open?.({ opener: card.btn, reason: 'plant' });
      return;
    }
    if (D.isHalted(s)) {
      const why = t(D.copyKey(s, 'plot.emptyHalted'));
      announce(why);
      ctx.mods.toast?.show?.(why, { tone: 'warn' });
      if (D.rearmState(s).can) ctx.mods.account?.rearm?.({ opener: card.btn });
      return;
    }
    const pick = pickBean(s);
    if (pick) A.requestPlant(pick, card.slot, { opener: card.btn });
    else ctx.mods.shelf?.openFor?.(card.slot, { opener: card.btn });
  }

  function pickBean(s) {
    const pb = s.ui?.pickBean;
    if (!pb) return null;
    if (typeof pb === 'object') return pb;
    return D.beanOf(s, pb);
  }

  function select(slot) {
    const s = store.get();
    if (s.ui?.selectedSlot !== slot) {
      patchUi(store, { selectedSlot: slot });
      emit(ctx, 'ui:select', { slot });
      announce(t('g.a11y.selected', { n: plotNo(slot) }));
    } else {
      // second activation of the selected card: move keyboard focus into the open inspector
      ctx.mods.inspector?.open?.({ opener: cards.get(slot)?.btn, force: true });
    }
  }

  function focusPlot(slot) {
    A.focusPlot(slot);
  }

  // ------------------------------------------------------------------ render

  function fillCard(card, v, slot, s, { hidden = false } = {}) {
    card.view = v;
    card.slot = slot;
    const n = hidden ? '—' : plotNo(slot);
    card.btn.dataset.slot = hidden ? '' : String(slot);
    card.li.classList.toggle('is-hidden-plot', hidden);
    if (!v) {
      card.btn.classList.add('is-empty');
      card.btn.dataset.state = D.isHalted(s) ? 'burned' : 'empty';
      setText(card.emptyNo, n);
      const pick = pickBean(s);
      card.btn.classList.toggle('is-pick', !!pick && !D.isHalted(s));
      // the ＋ glyph is drawn beside the text, so the '+ ' of g.dock.empty is dropped here
      const spectator = D.isSpectator(s);
      setText(card.emptyText, spectator ? t('g.gate.signInToPlant') : D.isHalted(s) ? t('sign.halted') : pick ? t('g.dock.emptyPick', { coin: pick.coin }) : t('g.dock.empty').replace(/^[+＋]\s*/, ''));
      setAttr(card.btn, 'aria-label', spectator ? `${t('g.dock.plot', { n })}: ${t('g.gate.signInToPlant')}` : D.isHalted(s) ? `${t('g.dock.plot', { n })}: ${t(D.copyKey(s, 'plot.emptyHalted'))}` : pick ? `${t('g.dock.plot', { n })}: ${t('g.dock.emptyPick', { coin: pick.coin })}` : t('g.dock.emptyLabel', { n }));
      card.btn.removeAttribute('aria-current');
      return;
    }
    card.btn.classList.remove('is-empty', 'is-pick');
    card.btn.dataset.state = v.state;
    setText(card.no, n);
    if (card.cropCoin !== v.coin) {
      card.crop.replaceChildren(cropIcon(v.coin));
      card.cropCoin = v.coin;
    }
    setText(card.coin, v.coin);
    card.venue.hidden = v.venue !== 'testnet';
    if (v.venue === 'testnet') setText(card.venue, t('g.venue.testnet'));
    card.btn.classList.toggle('is-testnet', v.venue === 'testnet');
    card.btn.classList.toggle('is-pending', !!v.closing || v.sync?.state === 'pending');
    const sideCls = v.side > 0 ? 'long' : v.side < 0 ? 'short' : 'flat';
    card.side.className = `pill pill--${sideCls} pc-side`;
    // arrow + word; a phone card keeps only the arrow (the word stays in the card's accessible label)
    setText(card.side.querySelector('.pc-arrow'), v.side > 0 ? '↑' : v.side < 0 ? '↓' : '–');
    setText(card.side.querySelector('.pc-word'), v.side > 0 ? ' LONG' : v.side < 0 ? ' SHORT' : ' ' + t('g.side.flat'));
    setText(card.lev, levText(v.lev));
    const p = pnlText(v);
    setText(card.pnl, p.text);
    card.pnl.className = `pc-pnl money money--${p.tone}`;
    setText(card.pct, pctText(v));
    // thermometer (J7): bands are slate / amber / amber+stripes — never green/red (J6)
    const segs = liqSegments(v);
    card.bar.hidden = !v.side;
    card.bar.dataset.band = v.liqInfo?.band || 'none';
    [...card.bar.children].forEach((i, k) => i.classList.toggle('on', k < segs));
    const near = liqNear(v);
    setText(card.state, near || stateText(v));
    card.state.dataset.tone = near ? 'warn' : v.error ? 'warn' : v.frozen ? 'stale' : v.note === 'liquidated' ? 'down' : '';
    const nowMs = D.nowOf(s);
    const a = ageLabel(v.markMs, nowMs);
    const showAge = v.side !== 0 && (a.kind !== 'fresh' || v.est);
    card.age.hidden = !showAge;
    setText(card.age, v.est ? t('g.age.est') : a.text);
    card.age.className = `pc-age age age--${v.est ? 'est' : a.kind}`;
    card.btn.classList.toggle('is-frozen', !!v.frozen);
    card.btn.classList.toggle('is-danger', v.liqInfo?.band === 'danger');
    card.btn.classList.toggle('is-error', !!v.error);
    setAttr(card.btn, 'aria-label', dockLabel(v, n) + (hidden ? '. ' + t('g.dock.notDrawn') : ''));
  }

  function render() {
    if (!ol) return;
    const s = store.get();
    const v = D.viewsOf(s);
    const wanted = [];
    for (let slot = 0; slot < v.count; slot++) {
      const card = cards.get(slot) || makeCard(slot);
      fillCard(card, v.bySlot[slot] || null, slot, s);
      wanted.push(card.li);
    }
    for (const hv of v.hidden) {
      const key = 'h:' + hv.botId;
      const card = cards.get(key) || makeCard(key);
      fillCard(card, hv, hv.slot, s, { hidden: true });
      wanted.push(card.li);
    }
    // drop cards for slots / hidden bots that are gone
    const keep = new Set(wanted);
    for (const [k, c] of cards) if (!keep.has(c.li)) cards.delete(k);
    const same = ol.children.length === wanted.length && wanted.every((li, i) => ol.children[i] === li);
    if (!same) {
      const active = document.activeElement;
      ol.replaceChildren(...wanted);
      if (active && wanted.some((li) => li.contains(active))) active.focus({ preventScroll: true });
    }
    renderSelection(false);
    // notes: hidden bots (15-plot limit) or an empty field (Pip's prompt)
    const open = D.openBots(s).length;
    if (note) {
      let text = '';
      if (v.hidden.length) text = t('g.dock.hidden', { n: v.hidden.length });
      else if (D.isSpectator(s)) text = t('g.gate.spectator');
      else if (!open && !D.isHalted(s)) text = t('g.empty.field');
      note.hidden = !text;
      setText(note, text);
    }
  }

  function renderSelection(scroll = true) {
    const sel = store.get().ui?.selectedSlot;
    for (const c of cards.values()) {
      const on = sel !== null && sel !== undefined && c.view && c.slot === sel && c.btn.dataset.slot !== '';
      if (on) {
        c.btn.setAttribute('aria-current', 'true');
        // an explicit 'smooth' is not overridden by the RM stylesheet (scroll-behavior) — choose it here (§7.3)
        if (scroll) c.btn.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
      } else c.btn.removeAttribute('aria-current');
    }
  }

  // ------------------------------------------------------------------ keyboard roving between cards

  ol?.addEventListener('keydown', (e) => {
    const btns = [...ol.querySelectorAll('.plot-card')];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = Math.min(btns.length - 1, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = btns.length - 1;
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation(); // the camera keys stay with #stage
    btns[j].focus();
  });

  watch(store, (s) => [s.views, s.bots, s.slots, s.marks?.t, s.live?.halted, s.ui?.pickBean, s.market, D.isSpectator(s)], render, (a, b) => !!a && !!b && a.every((x, i) => Object.is(x, b[i])));
  watch(store, (s) => s.ui?.selectedSlot, () => renderSelection(true));
  const timer = setInterval(render, 5000); // age tags
  onLangChange(render);

  const apiOut = {
    render,
    focusSlot(slot) {
      cards.get(slot)?.btn.focus({ preventScroll: false });
    },
    cardFor: (slot) => cards.get(slot)?.btn || null,
    dispose: () => clearInterval(timer),
  };
  ctx.mods.dock = apiOut;
  // phones: keep the selected card visible when the sheet layout changes
  addEventListener('resize', () => isPhone() && renderSelection(true));
  return apiOut;
}

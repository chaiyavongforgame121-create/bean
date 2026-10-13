/**
 * ui/chips.js — projected per-plot chips and the money signs on landmarks (GAME-DESIGN §3.2, §2.4, J7).
 *
 *   chip (aria-hidden; the dock carries the same data for assistive tech):
 *     BTC  ↑ LONG  10×  +$3.10 (+3.1%)  ▮▮▮▯        second line: state / "⚠ 1.9% from liquidation"
 *   classes: .chip  .chip--up|down (money)  .chip--long|short (side)  .chip--warn (risk)  .chip--stale (old price)
 *
 *   Visibility (settings.labels): always · hover & selected (phone default) · off (the dock still has numbers).
 *   Focus mode hides the other plots' chips unless labels = always (§5.4). Zooming out compacts the chips
 *   (one line: coin, arrow, ×N, %), it never hides side, leverage or liquidation (J7).
 *
 *   Landmark signs: the barn's account value (+ % vs start), crates (gains) and compost (losses) totals, and
 *   Pip's speech bubble on an empty field. All are DOM (translatable, crisp Thai), anchored with
 *   stage.labels.anchor(object3D, el, {offsetY}) (gfx/labels.js, WP2).
 *
 * Needs the stage; until it exists this module only keeps its elements ready.
 * Exports: mount(deps) → { render(), setHover(slot) }.  No three.js, no side effects at import.
 */

import { t, onLangChange } from '../../i18n.js';
import { usd } from '../../format.js';
import * as V from '../core/view.js';
import { getCtx, on } from './context.js';
import { h, $, setText, watch, money, levText } from './util.js';
import { pnlText, pctText, liqSegments, liqNear, stateText } from './plotText.js';
import * as D from './derive.js';

/**
 * Chips compact by the on-screen pitch of the field (px between two neighbouring plots), not by camera distance,
 * so a wide monitor keeps full chips where a small window must shrink them:
 *   < COMPACT_PX  one line: coin, ↑ LONG, ×N, %, thermometer (no $ / note)
 *   < TINY_PX     coin, arrow, ×N, thermometer (the word and % live in the dock) — side, leverage and
 *                 liquidation stay visible at every zoom (J7)
 * The selected and focused plots always keep their full chip.
 */
const COMPACT_PX = 170;
const TINY_PX = 128;
/**
 * < MICRO_PX: coin, arrow, ×N and a smaller thermometer, tighter type; and from the tiny level down, every
 * other plot's chip is raised one chip-height (`is-stagger`) so neighbours in a row never overlap (a 1024 px
 * window puts plots ~85 px apart while a tiny chip is ~100 px wide).
 */
const MICRO_PX = 100;

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('chips')) return ctx.mods.chips;
  const { store } = ctx;
  const box = $('chips');
  const chips = new Map(); // slot → { el, anchor, plot, view }
  let stage = null;
  let hoverSlot = null;
  let compact = 0; // 0 full · 1 compact · 2 tiny

  function makeChip(slot) {
    const el = h(
      'div',
      { class: 'chip', 'aria-hidden': 'true', dataset: { slot: String(slot) } },
      h(
        'div',
        { class: 'chip-row' },
        // TESTNET bots carry the word and the checkered edge (word + shape, no new hue: §9.4, J6)
        h('span', { class: 'vbadge vbadge--testnet chip-venue', hidden: true }),
        h('span', { class: 'chip-ring', 'aria-hidden': 'true', hidden: true }),
        h('b', { class: 'chip-coin' }),
        h('span', { class: 'chip-side' }, h('span', { class: 'chip-arrow' }), h('span', { class: 'chip-word' })),
        h('span', { class: 'chip-lev num' }),
        h('span', { class: 'chip-pnl num' }),
        h('span', { class: 'chip-pct num' }),
        h('span', { class: 'liqbar liqbar--chip' }, h('i'), h('i'), h('i'), h('i')),
      ),
      h('div', { class: 'chip-note' }),
    );
    // a click on a chip selects its plot (pointer users; the dock is the keyboard path)
    el.addEventListener('click', () => {
      const s = store.get();
      if (s.ui?.selectedSlot === slot) return;
      store.set({ ui: { ...s.ui, selectedSlot: slot } });
      ctx.bus?.emit?.('ui:select', { slot });
    });
    box?.append(el);
    return { el, anchor: null, plot: null, view: null };
  }

  function anchorChip(c, slot) {
    if (!stage?.labels?.anchor || !stage.field?.plot) return;
    const plot = stage.field.plot(slot);
    if (!plot || plot === c.plot) return;
    c.anchor?.remove?.();
    c.plot = plot;
    try {
      c.anchor = plot.anchor ? stage.labels.anchor(plot.anchor, c.el, { offsetY: 0 }) : stage.labels.anchor(plot.object3D, c.el, { offsetY: 2.6 });
    } catch (e) {
      console.error('[ui] chip anchor failed', e);
      c.anchor = null;
    }
  }

  function fill(c, v) {
    c.view = v;
    const el = c.el;
    const p = pnlText(v);
    const side = v.side > 0 ? 'long' : v.side < 0 ? 'short' : 'flat';
    setText(el.querySelector('.chip-coin'), v.coin);
    const tn = v.venue === 'testnet';
    const vb = el.querySelector('.chip-venue');
    vb.hidden = !tn;
    if (tn) setText(vb, t('g.venue.testnet'));
    // a half-filled / empty ring for a partial or unfilled IOC (§9.4 fill state)
    const ring = el.querySelector('.chip-ring');
    const fs = tn && !v.closing && (v.fillState === 'partial' || v.fillState === 'unfilled') ? v.fillState : null;
    ring.hidden = !fs;
    ring.dataset.fill = fs || '';
    // the arrow is the part that survives the tiniest chip; a flat plot has no arrow, so its word stays
    // flat: a dash (no direction) that survives the tiny chip, and the word beside it where there is room
    setText(el.querySelector('.chip-arrow'), v.side > 0 ? '↑' : v.side < 0 ? '↓' : '–');
    setText(el.querySelector('.chip-word'), v.side > 0 ? ' LONG' : v.side < 0 ? ' SHORT' : ' ' + t('g.side.flat'));
    el.querySelector('.chip-side').className = `chip-side pill pill--${side}`;
    setText(el.querySelector('.chip-lev'), v.side ? levText(v.lev) : '');
    setText(el.querySelector('.chip-pnl'), p.text);
    setText(el.querySelector('.chip-pct'), `(${pctText(v)})`);
    const bar = el.querySelector('.liqbar');
    bar.hidden = !v.side;
    bar.dataset.band = v.liqInfo?.band || 'none';
    const segs = liqSegments(v);
    [...bar.children].forEach((i, k) => i.classList.toggle('on', k < segs));
    const near = liqNear(v);
    const showNote = near || v.frozen || v.error || v.state !== 'growing' || v.caption === 'ripe' || v.caption === 'wilting' || v.caption === 'dying' || v.closing || (tn && (v.sync?.state || (v.fillState && v.fillState !== 'in_sync')));
    const noteEl = el.querySelector('.chip-note');
    noteEl.hidden = !showNote;
    setText(noteEl, near || stateText(v));
    const cls = ['chip', `chip--${side}`];
    if (p.tone === 'up') cls.push('chip--up');
    if (p.tone === 'down') cls.push('chip--down');
    if (near || v.error) cls.push('chip--warn');
    if (v.frozen) cls.push('chip--stale');
    if (v.note === 'liquidated' || v.noteCode === 'liquidated_testnet') cls.push('chip--liq');
    if (tn) cls.push('chip--testnet');
    if (v.closing || v.sync?.state === 'pending') cls.push('chip--pending');
    el.className = cls.join(' ');
  }

  /** 0 / 1 / 2 from the projected distance between plot 01 and plot 02 (same row, 4.4 u apart). */
  function squeezeLevel(st) {
    try {
      const a = st.plotPosition?.(0);
      const b = st.plotPosition?.(1);
      if (!a || !b || !st.labels?.project) return 0;
      const pa = st.labels.project({ x: a.x, y: 2.6, z: a.z });
      const pb = st.labels.project({ x: b.x, y: 2.6, z: b.z });
      const px = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      if (!Number.isFinite(px)) return 0;
      return px < MICRO_PX ? 3 : px < TINY_PX ? 2 : px < COMPACT_PX ? 1 : 0;
    } catch {
      return 0;
    }
  }

  function visibleFor(slot, s) {
    const mode = s.settings?.labels || 'always';
    if (mode === 'off') return false;
    const sel = s.ui?.selectedSlot;
    const focus = s.ui?.focusSlot;
    if (mode === 'always') return true;
    if (focus !== null && focus !== undefined) return slot === focus;
    return slot === sel || slot === hoverSlot;
  }

  function render() {
    const s = store.get();
    const v = D.viewsOf(s);
    const keep = new Set();
    for (const [k, view] of Object.entries(v.bySlot)) {
      const slot = Number(k);
      keep.add(slot);
      let c = chips.get(slot);
      if (!c) chips.set(slot, (c = makeChip(slot)));
      if (c.view?.botId !== view.botId) c.plot = null; // a new bot in the slot: re-anchor
      fill(c, view);
      anchorChip(c, slot);
      const vis = visibleFor(slot, s);
      c.el.classList.toggle('is-off', !vis);
      c.el.classList.toggle('is-selected', s.ui?.selectedSlot === slot);
      const squeezed = s.ui?.focusSlot !== slot && s.ui?.selectedSlot !== slot;
      c.el.classList.toggle('is-compact', compact >= 1 && squeezed);
      c.el.classList.toggle('is-tiny', compact >= 2 && squeezed);
      c.el.classList.toggle('is-micro', compact >= 3 && squeezed);
      c.el.classList.toggle('is-stagger', compact >= 2 && squeezed && slot % 2 === 1);
      c.anchor?.setVisible?.(vis);
    }
    for (const [slot, c] of chips) {
      if (keep.has(slot)) continue;
      c.anchor?.remove?.();
      c.el.remove();
      chips.delete(slot);
    }
    renderSigns(s);
  }

  // ------------------------------------------------------------------ landmark signs

  const signs = {}; // id → { el, anchor }
  function sign(id, cls, offsetY) {
    if (signs[id] || !stage?.world?.landmarks?.get || !stage.labels?.anchor) return signs[id] || null;
    const lm = stage.world.landmarks.get(id);
    if (!lm) return null;
    const el = h('div', { class: `lm-sign ${cls}`, 'aria-hidden': 'true' });
    box?.append(el);
    let anchor = null;
    try {
      // pinned: a landmark sign under the HUD band slides along its edge instead of vanishing (§2.4 P0 signs)
      anchor = stage.labels.anchor(lm.anchor || lm.object3D, el, { offsetY, pin: true });
    } catch (e) {
      console.error('[ui] landmark sign failed', id, e);
    }
    signs[id] = { el, anchor };
    return signs[id];
  }

  function renderSigns(s) {
    if (!stage) return;
    const m = V.moneyView(s.live, s.marks);
    // a spectator has no money of their own: the money signs say "Sign in" instead of empty numbers (QA-02)
    const spectator = D.isSpectator(s);
    const barn = sign('barn', 'lm-sign--barn', 0.2);
    if (barn && spectator) {
      barn.el.replaceChildren(h('span', { class: 'lm-k', text: t('sign.barn') }), h('b', { class: 'lm-v', text: t('g.gate.signin') }));
    } else if (barn && D.activeLedger(s) === 'testnet') {
      // the HUD ledger toggle (P1, §9.4) switched the landmarks: the exchange's account value, no "vs start" (J5)
      const tm = D.tnMoneyView(s);
      barn.el.replaceChildren(
        h('span', { class: 'lm-k', text: t('sign.barn') }),
        h('b', { class: 'lm-v num', text: tm.barn === null ? '—' : (tm.barnEst ? '≈ ' : '') + usd(tm.barn, 2) }),
        h('span', { class: 'lm-sub vbadge vbadge--testnet', text: t('g.venue.testnet') }),
      );
    } else if (barn) {
      const vs = m.vsStartPct;
      const tone = vs === null || Math.abs(vs) < 0.00005 ? 'zero' : vs > 0 ? 'up' : 'down';
      barn.el.replaceChildren(
        h('span', { class: 'lm-k', text: t('sign.barn') }),
        h('b', { class: 'lm-v num', text: m.barn === null ? '—' : usd(m.barn, 2) }),
        vs === null ? null : h('span', { class: `lm-sub money money--${tone}`, text: t('g.hud.vsStart', { pct: (vs >= 0 ? '+' : '−') + Math.abs(vs * 100).toFixed(2) + '%' }) }),
      );
    }
    const tot = V.closedTotals(s.bots);
    const crates = sign('crates', 'lm-sign--crates', 0.2);
    if (crates) {
      const mm = money(tot.crates.usd);
      crates.el.hidden = tot.crates.n === 0 || spectator;
      crates.el.replaceChildren(h('span', { class: 'lm-k', text: `🧺 ${tot.crates.n}` }), h('b', { class: `lm-v num money money--${mm.tone}`, text: mm.text }));
    }
    const compost = sign('compost', 'lm-sign--compost', 0.2);
    if (compost) {
      const mm = money(tot.compost.usd);
      compost.el.hidden = tot.compost.n === 0 || spectator;
      compost.el.replaceChildren(h('span', { class: 'lm-k', text: `🪓 ${tot.compost.n}` }), h('b', { class: `lm-v num money money--${mm.tone}`, text: mm.text }));
    }
    // Pip's empty-state voice (§6.10)
    const pip = sign('pip', 'lm-sign--pip', 0.6);
    if (pip) {
      const empty = D.openBots(s).length === 0 && !D.isHalted(s);
      pip.el.hidden = !empty;
      if (empty) pip.el.replaceChildren(h('span', { class: 'bubble-text', text: t('g.empty.field') }));
    }
  }

  // ------------------------------------------------------------------ stage hooks

  ctx.onStage((st) => {
    stage = st;
    for (const c of chips.values()) c.plot = null;
    for (const k of Object.keys(signs)) {
      signs[k].anchor?.remove?.();
      signs[k].el.remove();
      delete signs[k];
    }
    try {
      st?.rig?.onChange?.(() => {
        const next = squeezeLevel(st);
        if (next !== compact) {
          compact = next;
          render();
        }
      });
    } catch (e) {
      console.error('[ui] chip hooks failed', e);
    }
    compact = st ? squeezeLevel(st) : 0;
    render();
  });

  watch(store, (s) => [s.views, s.bots, s.slots, s.marks?.t, s.settings?.labels, s.ui?.selectedSlot, s.ui?.focusSlot, s.live, s.user, s.mode, s.settings?.ledger, s.venues, s.testnet], render, (a, b) => !!a && !!b && a.every((x, i) => Object.is(x, b[i])));
  on(ctx, 'data:views', () => render());
  // hover comes from main.js's picker wiring (fine pointers only)
  on(ctx, 'ui:hover', (e) => {
    const hit = e?.hit;
    const slot = hit && hit.type === 'plot' ? hit.slot : null;
    if (slot !== hoverSlot) {
      hoverSlot = slot;
      render();
    }
  });
  onLangChange(render);

  const apiOut = {
    render,
    setHover(slot) {
      hoverSlot = slot;
      render();
    },
  };
  ctx.mods.chips = apiOut;
  return apiOut;
}

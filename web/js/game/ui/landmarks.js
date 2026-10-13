/**
 * ui/landmarks.js — DOM tooltips for the island's landmarks and what a tap on them opens (GAME-DESIGN §2.4).
 *
 *   hover (fine pointer) / tap (touch, 3 s) → a `.tip` near the pointer with g.lm.* text and live numbers
 *   tap / click:
 *     stall → seed catalogue · barn → money popover · board → market board · mailbox → diary ·
 *     firepit → burn confirm · sundial → time-lapse (sim only) · pip → help (with "replay the tour") ·
 *     signpost → mode popover · tower / pond / silo / crates / compost / windmill → tooltip only
 *   plots: main.js's picker wiring selects/focuses plots itself and asks the UI over the bus:
 *     ui:plant {slot, bean} → the plant dialog (pick mode tap or a seed dropped on an empty box, §5.5)
 *     ui:radial {slot, x, y} → the long-press radial (P1) · ui:hover {hit, x, y} → landmark tooltips
 *     ui:landmark {id, x, y} → the routing above · ui:dropInvalid → a polite "not here" note
 *
 * Spectators (PLATFORM §9.1, QA-02): barn, pond, tower, silo, crates and compost answer "Sign in to see your own …"
 * with a Sign in button (never "account value —"); the signpost and the fire pit open the gate; the mailbox opens
 * the public diary; the stall opens the read-only catalogue. The routing is derive.routeLandmark() (pure, tested).
 *
 * Exports: mount(deps) → { tipFor(id), route(id) }.  No three.js, no side effects at import.
 */

import { t } from '../../i18n.js';
import { usd, isNum } from '../../format.js';
import * as V from '../core/view.js';
import { getCtx, emit, on } from './context.js';
import { h, $, setText, money, countdown, ageText } from './util.js';
import { getActions } from './actions.js';
import * as D from './derive.js';
import { announce } from './a11y.js';

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('landmarks')) return ctx.mods.landmarks;
  const { store } = ctx;
  const A = getActions(ctx);
  const tip = h('div', { class: 'tip', role: 'tooltip', 'aria-hidden': 'true', hidden: true });
  $('fx')?.append(tip);
  let pointer = { x: 0, y: 0 };
  let tipTimer = 0;
  let current = null;

  $('stage')?.addEventListener('pointermove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (!tip.hidden) place();
  });
  $('stage')?.addEventListener('pointerleave', () => hide());

  /** Tooltip text for a landmark id, with the current numbers. */
  function tipFor(id) {
    const s = store.get();
    if (D.isSpectator(s)) {
      if (D.MONEY_LANDMARKS.includes(id)) return t('g.lm.signInToSee', { place: t('g.place.' + id) });
      if (id === 'signpost') return `${t('g.lm.signpostSignedOut')} — ${ctx.mods.badge?.text?.() || ''}`;
      if (id === 'firepit') return t('g.lm.signpostSignedOut');
    }
    // the HUD ledger toggle (P1, §9.4) switches the barn, pond and tower to the testnet ledger (no "vs start", J5)
    if (D.activeLedger(s) === 'testnet' && (id === 'barn' || id === 'pond' || id === 'tower')) {
      const tm = D.tnMoneyView(s);
      const l = D.tnLedger(s);
      const val = tm.barn === null ? '—' : (tm.barnEst ? '≈ ' : '') + usd(tm.barn, 2);
      if (id === 'barn') {
        const delta = tm.barn !== null && l.value_at_connect !== null ? tm.barn - l.value_at_connect : null;
        return delta !== null && l.connected_ms
          ? t('g.lm.barnTestnet', { usd: val, age: ageText(tm.asOfMs, D.nowOf(s)), date: new Date(l.connected_ms).toLocaleDateString(), delta: money(delta, { est: tm.barnEst }).text })
          : `${t('g.venue.testnet')} · ${t('g.hud.tnValue')}: ${val}`;
      }
      if (id === 'pond') return `${t('g.venue.testnet')} · ${t('g.hud.tnFree')}: ${tm.pond === null ? '—' : usd(tm.pond, 2)}`;
      return `${t('g.venue.testnet')} · ${t('g.hud.tower')}: ${usd(tm.tower, 2)}`;
    }
    const m = V.moneyView(s.live, s.marks);
    const pctVs = m.vsStartPct === null ? '—' : (m.vsStartPct >= 0 ? '+' : '−') + Math.abs(m.vsStartPct * 100).toFixed(2) + '%';
    const tot = V.closedTotals(s.bots);
    switch (id) {
      case 'stall':
        return t('g.lm.stall');
      case 'barn':
        return t('g.lm.barn', { usd: m.barn === null ? '—' : usd(m.barn, 2), pct: pctVs, start: m.start === null ? '—' : usd(m.start, 0) });
      case 'silo':
        return t('g.lm.silo', { start: m.start === null ? '—' : usd(m.start, 0) });
      case 'tower':
        return t('g.lm.tower', { usd: m.tower === null ? '—' : usd(m.tower, 2), room: m.room === null ? '—' : usd(m.room, 0), cap: m.notionalCap === null ? '—' : usd(m.notionalCap, 0) });
      case 'pond':
        return t('g.lm.pond', { usd: m.pond === null ? '—' : usd(m.pond, 2) });
      case 'board':
        return t('g.lm.board');
      case 'mailbox':
        return t('g.lm.mailbox');
      case 'firepit':
        return D.isHalted(s) ? t(D.copyKey(s, 'plot.emptyHalted')) : t('g.lm.firepit');
      case 'sundial':
        return t('g.lm.sundial');
      case 'crates':
        return tot.crates.n ? t('g.lm.crates', { n: tot.crates.n, usd: money(tot.crates.usd).text }) : t('g.empty.crates');
      case 'compost':
        return tot.compost.n ? t('g.lm.compost', { n: tot.compost.n, usd: money(tot.compost.usd).text }) : t('g.empty.compost');
      case 'pip':
        return t('g.lm.pip');
      case 'windmill': {
        const f = s.feed || {};
        const left = isNum(f.nextTickMs) ? Number(f.nextTickMs) - D.nowOf(s) : null;
        const next = left !== null && left > -5000 ? t(D.isSim(s) ? 'g.clock.nextSim' : 'g.clock.next', { s: countdown(Math.max(0, left)) }) : t('g.clock.waiting');
        return t('g.lm.windmill', { next });
      }
      case 'signpost':
        return t('g.lm.signpost', { mode: ctx.mods.badge?.text?.() || '' });
      case 'vane':
      case 'sky': {
        const w = s.market?.weather;
        return t('g.lm.vane', { weather: w ? t('weather.' + w.key) : t('weather.unknown') });
      }
      default:
        return '';
    }
  }

  function show(id, at, ms = 0) {
    const text = tipFor(id);
    if (!text) return hide();
    current = id;
    setText(tip, text);
    tip.hidden = false;
    if (at) pointer = at;
    place();
    clearTimeout(tipTimer);
    if (ms) tipTimer = setTimeout(hide, ms);
  }
  function hide() {
    current = null;
    tip.hidden = true;
    clearTimeout(tipTimer);
  }
  function place() {
    const w = tip.offsetWidth || 220;
    const hgt = tip.offsetHeight || 40;
    const x = Math.max(8, Math.min(innerWidth - w - 8, pointer.x + 14));
    const y = Math.max(8, Math.min(innerHeight - hgt - 8, pointer.y + 16));
    tip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  const xy = (ev) => {
    if (!ev) return null;
    const x = ev.clientX ?? ev.x;
    const y = ev.clientY ?? ev.y;
    return isNum(x) && isNum(y) ? { x: Number(x), y: Number(y) } : null;
  };

  /** A small non-modal card "Sign in to see your own barn" with a Sign in button (spectators, QA-02). */
  const card = h('div', { class: 'popover popover--signin', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'lmCardText', tabindex: '-1', hidden: true }, h('p', { class: 'pop-note', id: 'lmCardText' }), h('p', { class: 'pop-links' }, h('button', { type: 'button', class: 'btn btn--wood btn--sm' })));
  $('dialogs')?.append(card);
  card.querySelector('button').addEventListener('click', () => {
    card.hidden = true;
    ctx.mods.gate?.open?.({ opener: $('stage') });
  });
  document.addEventListener('pointerdown', (e) => {
    if (!card.hidden && !card.contains(e.target)) card.hidden = true;
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      card.hidden = true;
      $('stage')?.focus?.({ preventScroll: true });
    }
  });
  function signInCard(place, at) {
    hide();
    setText(card.querySelector('.pop-note'), t('g.lm.signInToSee', { place: t('g.place.' + place) }));
    setText(card.querySelector('button'), t('g.gate.signin'));
    card.hidden = false;
    const p = at || pointer;
    const w = Math.min(300, innerWidth - 32);
    card.style.width = w + 'px';
    card.style.left = Math.round(Math.max(16, Math.min(innerWidth - w - 16, p.x - w / 2))) + 'px';
    card.style.top = Math.round(Math.max(16, Math.min(innerHeight - 140, p.y + 12))) + 'px';
    card.querySelector('button').focus({ preventScroll: true });
  }

  function onTap(hit, ev) {
    if (!hit || hit.type !== 'landmark') return;
    const opener = $('stage');
    const r = D.routeLandmark(hit.id, store.get());
    switch (r.kind) {
      case 'panel':
        return ctx.sheets?.open(r.panel, { opener });
      case 'burn':
        return A.requestBurn({ opener });
      case 'timelapse':
        return A.timelapse();
      case 'money':
        return ctx.mods.hud?.openMoney?.($('mBarn') || $('barnMini'));
      case 'mode':
        return emit(ctx, 'ui:mode', {});
      case 'gate':
        return ctx.mods.gate?.open?.({ opener });
      case 'signIn':
        return signInCard(r.place, xy(ev));
      default:
        return show(hit.id, xy(ev), 3000);
    }
  }

  // main.js turns picker gestures into bus events (§5.2/§5.3); the UI answers them here.
  on(ctx, 'ui:landmark', (e) => e && onTap({ type: 'landmark', id: e.id }, e));
  on(ctx, 'ui:plant', (e) => {
    if (!e || !Number.isInteger(e.slot) || ctx.mods.plantDialog?.isOpen?.()) return;
    const s = store.get();
    const bean = typeof e.bean === 'object' && e.bean ? e.bean : D.beanOf(s, e.bean);
    if (bean) A.requestPlant(bean, e.slot, { opener: $('stage') });
  });
  on(ctx, 'ui:radial', (e) => {
    if (!e || !Number.isInteger(e.slot)) return;
    const v = D.viewsOf(store.get()).bySlot[e.slot];
    if (!v) return;
    const p = xy(e) || pointer;
    ctx.mods.radial?.open?.(e.slot, p.x, p.y, { opener: $('stage'), botId: v.botId });
  });
  on(ctx, 'ui:hover', (e) => {
    const hit = e?.hit;
    if (hit && hit.type === 'landmark') {
      if (current !== hit.id) show(hit.id, xy(e));
    } else if (current) hide();
  });
  on(ctx, 'ui:dropInvalid', () => announce(t('g.dock.dropInvalid')));

  const apiOut = { tipFor, show, hide, route: (id) => D.routeLandmark(id, store.get()), tap: (id, at) => onTap({ type: 'landmark', id }, at) };
  ctx.mods.landmarks = apiOut;
  return apiOut;
}

/**
 * ui/tutorial.js — Pip's onboarding tour (GAME-DESIGN §6.10).
 *
 *   Runs once (localStorage["bean.game.tour.v1"]), skippable at every step, replayable from Settings, Help or
 *   by clicking Pip. Each card is a NON-modal dialog; the camera eases to the step's landmark when the 3D stage
 *   exists (reduced motion: the rig cuts), and the matching HUD control gets a soft highlight.
 *     1 badge   g.tour.1 (g.tour.1sim with simulated prices)
 *     2 stall   g.tour.2
 *     3 plant dialog preview — a static illustration, no API call: g.tour.3
 *     4 example plant — gain, wilt, LONG, SHORT (a DOM illustration labelled "example"): g.tour.4
 *     5 ×N stake and thermometer: g.tour.5
 *     6 barn, mailbox, fire pit: g.tour.6, then "Turn on sound?" (yes enables sound inside that click)
 *   Copy is neutral (J12): the tour explains, it never nudges a trade.
 *   Accounts mode (PLATFORM §9.1): step 1 says paper by default and testnet optional (g.tour.1Accounts), and a
 *   step 2 "your garden is private; beans are shared" (g.tour.private) is inserted. A spectator is never toured
 *   automatically (the farm gate is open); a new garden starts the tour after sign-up (ui/session.js).
 *
 *   The tour steps aside while the player does the thing it explains: a modal dialog opening (the plant dialog…)
 *   or a left panel (the stall; a bottom sheet on a phone) MINIMISES the card into a small "Tour with Pip ›" chip and releases
 *   the camera (no step focus over a sheet); the chip brings the tour back at the same step. Planting (cmd:pending
 *   bot_create) ends the tour: the player did it, and the camera is free to show the new crop (J3).
 *
 * Exports: mount(deps) → { start({force}), stop(), isOpen(), isMinimized() }.  No three.js, no side effects at import.
 */

import { t, onLangChange } from '../../i18n.js';
import { getCtx, on } from './context.js';
import { h, $, setText, readJSON, writeJSON, isPhone, icon, cropIcon } from './util.js';
import * as D from './derive.js';

export const TOUR_KEY = 'bean.game.tour.v1';

/** The private-garden step of accounts mode (inserted as step 2). */
const PRIVATE_STEP = Object.freeze({ key: 'g.tour.private', dom: 'btnAccount', landmark: 'barn', art: 'farm' });

const STEPS = [
  { key: 'g.tour.1', simKey: 'g.tour.1sim', dom: 'badge', landmark: 'signpost', art: 'badge' },
  { key: 'g.tour.2', dom: 'btnSeeds', landmark: 'stall', art: 'stall' },
  { key: 'g.tour.3', dom: null, landmark: null, art: 'dialog' },
  { key: 'g.tour.4', dom: 'dock', landmark: null, art: 'plants' },
  { key: 'g.tour.5', dom: null, landmark: null, art: 'stake' },
  { key: 'g.tour.6', dom: 'btnBurn', landmark: 'barn', art: 'farm', sound: true },
];

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('tutorial')) return ctx.mods.tutorial;
  const { store } = ctx;
  let step = -1;
  let opener = null;
  let lit = null;
  let steps = STEPS;
  /** The steps for the current mode (accounts mode adds the private-garden step). */
  const stepsFor = (s) => (D.isAccounts(s) && D.userOf(s) ? [STEPS[0], PRIVATE_STEP, ...STEPS.slice(1)] : STEPS);

  const pip = h('div', { class: 'pip', 'aria-hidden': 'true' }, h('span', { class: 'pip-hat' }), h('span', { class: 'pip-face' }, h('i'), h('i'), h('b')));
  const title = h('h2', { class: 'tour-title', id: 'tourTitle' });
  const count = h('p', { class: 'tour-step num' });
  const text = h('p', { class: 'tour-text', id: 'tourText' });
  const art = h('div', { class: 'tour-art', 'aria-hidden': 'true' });
  const sound = h('div', { class: 'tour-sound', hidden: true }, h('p', { class: 'tour-q' }), h('div', { class: 'tour-sound-btns' }));
  const skip = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' });
  const back = h('button', { type: 'button', class: 'btn btn--paper btn--sm' });
  const next = h('button', { type: 'button', class: 'btn btn--wood btn--sm' });
  const card = h(
    'div',
    { class: 'tour', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'tourTitle', 'aria-describedby': 'tourText', tabindex: '-1', hidden: true },
    h('div', { class: 'tour-head' }, pip, h('div', {}, title, count)),
    text,
    art,
    sound,
    h('div', { class: 'tour-actions' }, skip, h('span', { class: 'tour-gap' }), back, next),
  );
  $('dialogs')?.append(card);
  // the minimised tour: one tap target (≥ 44 px) that brings the card back at the same step
  const chip = h('button', { type: 'button', class: 'tour-chip', hidden: true });
  $('dialogs')?.append(chip);
  chip.addEventListener('click', () => restore());
  const soundYes = h('button', { type: 'button', class: 'btn btn--wood btn--sm' });
  const soundNo = h('button', { type: 'button', class: 'btn btn--paper btn--sm' });
  sound.lastChild.append(soundNo, soundYes);

  skip.addEventListener('click', () => stop(true));
  back.addEventListener('click', () => go(step - 1));
  next.addEventListener('click', () => (step >= steps.length - 1 ? stop(true) : go(step + 1)));
  soundYes.addEventListener('click', () => {
    ctx.mods.hud?.setSound?.(true); // inside the click: the AudioContext may start (§8)
    stop(true);
  });
  soundNo.addEventListener('click', () => stop(true));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      stop(true);
    }
  });

  function artFor(kind) {
    const lab = h('span', { class: 'tour-example', text: t('g.tour.example') });
    switch (kind) {
      case 'badge':
        return [h('span', { class: 'badge badge--demo', dataset: { tone: store.get().feed?.prices === 'real' ? 'real' : 'sim' } }, h('span', { class: 'badge-mark', text: store.get().feed?.prices === 'real' ? '●' : '◆' }), h('span', { text: t(store.get().feed?.prices === 'real' ? 'g.badge.short.real' : 'g.badge.short.sim') }))];
      case 'stall':
        return [h('span', { class: 'tour-packets' }, ['BTC', 'SOL', 'DOGE', 'ETH', 'WIF'].map((c) => h('span', { class: 'tour-packet' }, cropIcon(c), h('b', { text: c }))))];
      case 'dialog':
        return [
          lab,
          h(
            'div',
            { class: 'tour-mini' },
            h('p', { class: 'num', text: `${t('modal.water')}: $100` }),
            h('p', { class: 'num', text: t('g.plant.margin', { usd: '$70.80', lev: 10 }) }),
            h('p', { class: 'num pd-warn', text: t('g.plant.liq', { pct: '9.5%' }) }),
            h('p', { class: 'num', text: t('g.plant.fees', { usd: '$0.85' }) }),
          ),
        ];
      case 'plants':
        return [
          lab,
          h(
            'div',
            { class: 'tour-plants' },
            h('span', { class: 'tour-plant' }, cropIcon('SOL'), h('span', { class: 'money money--up num', text: '+$3.10 ▲' })),
            h('span', { class: 'tour-plant tour-plant--wilt' }, cropIcon('SOL'), h('span', { class: 'money money--down num', text: '−$2.40 ▼' })),
            h('span', { class: 'tour-plant' }, h('span', { class: 'pill pill--long', text: t('g.side.long') })),
            h('span', { class: 'tour-plant' }, h('span', { class: 'pill pill--short', text: t('g.side.short') })),
          ),
        ];
      case 'stake':
        return [lab, h('div', { class: 'tour-stake' }, h('span', { class: 'tour-x num', text: '10×' }), h('span', { class: 'liqbar liqbar--lg', dataset: { band: 'ok' } }, h('i', { class: 'on' }), h('i', { class: 'on' }), h('i', { class: 'on' }), h('i')), h('span', { class: 'num', text: t('g.liq.fall', { pct: '10.1%' }) }))];
      case 'farm':
        return [h('div', { class: 'tour-farm' }, icon('i-barn'), icon('i-diary'), icon('i-fire'))];
      default:
        return [];
    }
  }

  function highlight(id) {
    lit?.classList.remove('is-tour-lit');
    lit = id ? $(id) : null;
    lit?.classList.add('is-tour-lit');
  }

  function moveCamera(landmark) {
    const st = ctx.stage;
    if (!st?.rig) return;
    try {
      if (!landmark) return;
      const lm = st.world?.landmarks?.get?.(landmark);
      const pos = lm?.object3D?.position;
      if (pos && st.rig.focus) st.rig.focus(pos, { tour: true });
    } catch {
      /* the tour works without the camera */
    }
  }

  function go(i) {
    if (i < 0 || i >= steps.length) return;
    step = i;
    const s = steps[i];
    const st = store.get();
    const sim = st.feed?.prices !== 'real';
    setText(title, t('g.tour.pip'));
    setText(count, t('g.tour.step', { n: i + 1, total: steps.length }));
    // accounts mode: "paper by default; testnet optional" (never "no keys, no orders" as in none mode)
    setText(text, t(sim && s.simKey ? s.simKey : D.copyKey(st, s.key)));
    art.replaceChildren(...artFor(s.art));
    sound.hidden = !s.sound;
    setText(sound.firstChild, t('g.tour.sound'));
    setText(soundYes, t('g.tour.soundYes'));
    setText(soundNo, t('g.tour.soundNo'));
    setText(skip, t('g.tour.skip'));
    setText(back, t('g.tour.back'));
    back.hidden = i === 0;
    next.hidden = !!s.sound;
    setText(next, i >= steps.length - 1 ? t('g.tour.done') : t('g.tour.next'));
    highlight(isPhone() && (s.dom === 'btnBurn' || s.dom === 'btnAccount') ? 'btnMore' : s.dom);
    moveCamera(s.landmark);
    card.dataset.step = String(i + 1);
    (s.sound ? soundYes : next).focus({ preventScroll: true });
  }

  function start({ force = false } = {}) {
    if (!force && readJSON(TOUR_KEY, null)) return false;
    // a spectator looks at the farm gate first; the tour comes with their own garden
    if (!force && D.isSpectator(store.get())) return false;
    if (!card.hidden) return true;
    chip.hidden = true;
    steps = stepsFor(store.get());
    opener = document.activeElement;
    card.hidden = false;
    go(0);
    return true;
  }

  /** Step aside (a dialog or a phone sheet opened): the card becomes the chip; the camera is released. */
  function minimize() {
    if (card.hidden || step < 0) return;
    card.hidden = true;
    highlight(null);
    setText(chip, t('g.tour.chip'));
    chip.setAttribute('aria-label', t('g.tour.resume'));
    chip.hidden = false;
    try {
      ctx.stage?.rig?.reset?.();
    } catch {
      /* the tour works without the camera */
    }
  }

  /** The chip: the tour comes back at the step it left. */
  function restore() {
    if (step < 0) {
      chip.hidden = true;
      return;
    }
    chip.hidden = true;
    card.hidden = false;
    go(step);
  }

  function stop(done = true) {
    if (!chip.hidden) {
      // ended while minimised (planted, or signed out): just forget it
      chip.hidden = true;
      step = -1;
      if (done) writeJSON(TOUR_KEY, { done: true, at: Date.now() });
      return;
    }
    if (card.hidden) return;
    card.hidden = true;
    highlight(null);
    step = -1;
    if (done) writeJSON(TOUR_KEY, { done: true, at: Date.now() });
    try {
      ctx.stage?.rig?.reset?.();
    } catch {
      /* ignore */
    }
    const back2 = opener && opener.isConnected && opener !== document.body ? opener : $('stage');
    back2?.focus?.({ preventScroll: true });
  }

  onLangChange(() => {
    if (step >= 0 && !card.hidden) go(step);
    if (!chip.hidden) {
      setText(chip, t('g.tour.chip'));
      chip.setAttribute('aria-label', t('g.tour.resume'));
    }
  });

  // planting is what the tour leads to: once the player plants, the tour is done (and the camera free, J3)
  on(ctx, 'cmd:pending', (e) => {
    if (e?.op === 'bot_create' && step >= 0) stop(true);
  });
  // a left panel (the stall, the list…; a bottom sheet on a phone) opens where the card sits: step aside
  on(ctx, 'ui:panel', (e) => {
    if (e?.panel) minimize();
  });
  // any modal dialog (the plant dialog, a confirm) opening over the tour: step aside on every screen size
  try {
    const dialogs = $('dialogs');
    if (dialogs && typeof MutationObserver === 'function') {
      new MutationObserver((list) => {
        for (const m of list) {
          const el = m.target;
          if (el instanceof HTMLDialogElement && el.open && el !== card) {
            minimize();
            return;
          }
        }
      }).observe(dialogs, { subtree: true, attributes: true, attributeFilter: ['open'] });
    }
  } catch {
    /* without the observer the tour simply stays (as before) */
  }

  // first visit: start once the page has settled (and never on top of an open dialog)
  const tryAuto = () => {
    if (document.querySelector('dialog[open]')) return setTimeout(tryAuto, 4000);
    start();
  };
  setTimeout(tryAuto, 2500);

  const apiOut = { start, stop, isOpen: () => !card.hidden, isMinimized: () => !chip.hidden };
  ctx.mods.tutorial = apiOut;
  return apiOut;
}

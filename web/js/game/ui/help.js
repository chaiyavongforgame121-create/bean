/**
 * ui/help.js — the Help panel (`?`): controls, the safety rule for shortcuts and the colour key
 * (GAME-DESIGN §6.11, §5.2, J6). Pip opens it too (§2.4), with "replay the tour".
 *
 * PLATFORM additions (WP5):
 *   - Help & FAQ (accounts mode, §9.2): server down, what the operator can do with a stored key, the faucet rule,
 *     no recovery, inactivity, stored data — g.faq.* in EN and TH, as native <details> (keyboard and AT friendly).
 *   - Places (QA-08, P1): a list of every landmark — the help panel's "Places (G)" button and the G key open it
 *     (L stays the List view). Each entry eases the camera to the landmark and opens it (Enter / click), with a
 *     visible focus ring; the routing is the same as a tap (landmarks.js / derive.routeLandmark).
 *
 * Exports: mount(deps) → { panel, places, openFaq(o), openPlaces(o) }.  No three.js, no side effects at import.
 */

import { t, onLangChange } from '../../i18n.js';
import { getCtx } from './context.js';
import { h, setText, watch, nextFrame } from './util.js';
import { getSheets } from './sheets.js';
import * as D from './derive.js';

const CONTROLS = ['g.help.pan', 'g.help.rotate', 'g.help.zoom', 'g.help.select', 'g.help.focus', 'g.help.back', 'g.help.panels', 'g.help.places'];

/** The FAQ of PLATFORM §9.2: [question key, answer key]. */
export const FAQ = Object.freeze([
  ['g.faq.qServerDown', 'g.faq.serverDown'],
  ['g.faq.qOperator', 'g.faq.operator'],
  ['g.faq.qFaucet', 'g.faq.faucet'],
  ['g.faq.qNoRecovery', 'g.faq.noRecovery'],
  ['g.faq.qInactive', 'g.faq.inactive'],
  ['g.faq.qData', 'g.faq.data'],
]);

/** Landmarks in the Places list (QA-08), in reading order around the island; the sundial only with sim prices. */
export const PLACES = Object.freeze(['stall', 'barn', 'mailbox', 'signpost', 'board', 'firepit', 'pip', 'windmill', 'tower', 'pond', 'silo', 'crates', 'compost', 'sundial']);

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('help')) return ctx.mods.help;
  const { store } = ctx;
  const sheets = getSheets(ctx);
  const p = sheets.panel('help', { side: 'left', titleKey: 'g.help.title', snap: 60, icon: 'i-help' });

  const list = h('ul', { class: 'help-list' }, CONTROLS.map((k) => h('li', { dataset: { key: k } })));
  const safety = h('p', { class: 'help-safety', dataset: { key: 'g.help.safety' } });
  const keyTitle = h('h3', { class: 'insp-h', dataset: { key: 'g.help.key' } });
  const swatch = (cls, key) => h('li', { class: 'key-row' }, h('span', { class: `swatch ${cls}`, 'aria-hidden': 'true' }), h('span', { dataset: { key } }));
  const key = h(
    'ul',
    { class: 'key-list' },
    swatch('swatch--money', 'g.help.keyMoney'),
    swatch('swatch--side', 'g.help.keySide'),
    swatch('swatch--risk', 'g.help.keyRisk'),
    swatch('swatch--neutral', 'g.help.keyPrice'),
  );
  const colours = h('p', { class: 'muted', dataset: { key: 'g.help.colours' } });
  const sides = h('p', { class: 'muted' }, h('span', { dataset: { key: 'g.side.longHelp' } }), h('br'), h('span', { dataset: { key: 'g.side.shortHelp' } }));
  const tour = h('button', { type: 'button', class: 'btn btn--wood', dataset: { key: 'g.set.tour' } });
  tour.addEventListener('click', () => {
    p.close();
    ctx.mods.tutorial?.start?.({ force: true });
  });
  const placesBtn = h('button', { type: 'button', class: 'btn btn--paper', dataset: { key: 'g.help.places' } });
  placesBtn.addEventListener('click', () => openPlaces({ opener: placesBtn }));
  const settings = h('button', { type: 'button', class: 'btn btn--paper', dataset: { key: 'g.btn.settings' } });
  settings.addEventListener('click', () => sheets.open('settings', { opener: settings }));
  const classic = h('a', { class: 'btn btn--ghost', href: '/classic.html', dataset: { key: 'g.set.classic' } });

  // FAQ (accounts mode): native <details>, one per question
  const faqTitle = h('h3', { class: 'insp-h', id: 'helpFaq', dataset: { key: 'g.faq.title' } });
  const faqList = h(
    'div',
    { class: 'faq' },
    FAQ.map(([q, a]) => h('details', { class: 'faq-item', dataset: { answer: a } }, h('summary', { dataset: { key: q } }), h('p', { class: 'faq-a' }))),
  );
  const faq = h('section', { class: 'help-faq', 'aria-labelledby': 'helpFaq', hidden: true }, faqTitle, faqList);
  p.body.append(faq, list, safety, keyTitle, key, colours, sides, h('div', { class: 'set-links' }, tour, placesBtn, settings, classic));

  function render() {
    p.setTitle(t('g.help.title'));
    for (const el of p.body.querySelectorAll('[data-key]')) setText(el, t(el.dataset.key));
    const s = store.get();
    faq.hidden = !D.isAccounts(s);
    const vars = { days: D.inactiveDaysOf(s), backups: D.backupDaysOf(s) };
    for (const d of faqList.querySelectorAll('details')) {
      const k = d.dataset.answer;
      // g.faq.data names the backup retention as {days}; g.faq.inactive the inactivity rule
      setText(d.querySelector('.faq-a'), t(k, k === 'g.faq.data' ? { days: vars.backups } : { days: vars.days }));
    }
  }
  p.onOpen(render);
  onLangChange(render);
  watch(store, (s) => D.modeOf(s), render);
  render();

  /** Help & FAQ from the account menu: the panel opens on the FAQ. */
  function openFaq({ opener = null } = {}) {
    render();
    p.open({ opener });
    nextFrame(() => {
      faqTitle.scrollIntoView?.({ block: 'start' });
      faqList.querySelector('summary')?.focus?.({ preventScroll: true });
    });
  }

  // ------------------------------------------------------------------ Places (QA-08, P1)

  const places = sheets.panel('places', { side: 'left', titleKey: 'g.help.placesTitle', snap: 60 });
  const pList = h('ul', { class: 'places-list', role: 'list' });
  places.body.append(h('p', { class: 'muted', dataset: { key: 'g.help.placesHint' } }), pList);
  function renderPlaces() {
    places.setTitle(t('g.help.placesTitle'));
    for (const el of places.body.querySelectorAll('[data-key]')) setText(el, t(el.dataset.key));
    const sim = D.isSim(store.get());
    const kids = PLACES.filter((id) => id !== 'sundial' || sim).map((id) => {
      const b = h('button', { type: 'button', class: 'btn btn--paper place-btn', dataset: { place: id }, text: t('g.place.' + id) });
      b.addEventListener('click', () => goTo(id, b));
      return h('li', {}, b);
    });
    pList.replaceChildren(...kids);
  }
  /** Ease the camera to the landmark, then open it as a tap would. */
  function goTo(id, btn) {
    const st = ctx.stage;
    try {
      const lm = st?.world?.landmarks?.get?.(id);
      const pos = lm?.object3D?.position;
      if (pos && st?.rig?.focus) st.rig.focus({ x: pos.x, y: 0, z: pos.z }, { d: 26 });
    } catch {
      /* the panel works without the camera */
    }
    places.close({ restore: false });
    ctx.mods.landmarks?.tap?.(id, btn ? { x: btn.getBoundingClientRect().left + 40, y: btn.getBoundingClientRect().top } : null);
  }
  function openPlaces({ opener = null } = {}) {
    renderPlaces();
    places.open({ opener });
    nextFrame(() => pList.querySelector('button')?.focus({ preventScroll: true }));
  }
  places.onOpen(renderPlaces);
  onLangChange(() => places.isOpen() && renderPlaces());

  const apiOut = { panel: p, places, openFaq, openPlaces };
  ctx.mods.help = apiOut;
  return apiOut;
}

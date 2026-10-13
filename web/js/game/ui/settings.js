/**
 * ui/settings.js — the Settings panel (GAME-DESIGN §6.9) and the document-level look switches.
 *
 *   setSettings(ctx, patch)   the ONE write path for settings from the HUD: WP2's controller
 *                             (core/settings.js createSettings → deps.settings.set) when present, else a
 *                             local fallback that normalises, persists (try/catch) and emits bus 'settings'.
 *   currentSettings(ctx)      store.settings or the persisted / default settings
 *   mount(deps)               builds the panel and keeps <html> in sync:
 *                               data-palette="std|cb" (§7.4)   data-motion="full|reduced" (§7.3)
 *                               data-labels="always|hover|off" data-prices="real|sim"
 *
 * Panel content: language, sound (+ volume, ambience, bar chime), graphics, motion, sky, labels, colours,
 * single-key shortcuts, farmer & animals, camera drift, the command token (same brood-api behaviour as the
 * classic page, with the host-trust confirm), replay the tour, classic 2D, API docs.
 * Accounts mode (PLATFORM §9.2, §9.5): the token box is hidden (sessions replace it); an Account group adds
 * Testnet (the connect panel), the account menu and the privacy note (what is stored, how long backups keep it,
 * how to delete it).
 *
 * No three.js, no side effects at import.
 */

import * as api from '../../brood-api.js';
import { t, getLang, setLang, onLangChange, LANGS } from '../../i18n.js';
import { loadSettings, saveSettings, normalizeSettings, defaultSettings, isReduced, coarsePointer } from '../core/settings.js';
import { getCtx, emit, on } from './context.js';
import { h, setText, watch, uid, show } from './util.js';
import * as D from './derive.js';
import { getSheets } from './sheets.js';
import { announce } from './a11y.js';

/** Settings as the page currently applies them. */
export function currentSettings(ctx) {
  const s = ctx.store.get().settings;
  if (s && typeof s === 'object') return s;
  return loadSettings({ coarse: coarsePointer() });
}

/** Write settings (see the header). Returns the new settings. */
export function setSettings(ctx, patch) {
  if (ctx.settingsApi && typeof ctx.settingsApi.set === 'function') return ctx.settingsApi.set(patch);
  const coarse = coarsePointer();
  const prev = currentSettings(ctx);
  const next = normalizeSettings({ ...prev, ...patch }, defaultSettings({ coarse }));
  saveSettings(next);
  const sys = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const reduced = isReduced(next, sys);
  const changed = Object.keys(next).filter((k) => next[k] !== prev[k]);
  ctx.store.set((s) => ({ settings: next, ui: { ...(s.ui || {}), reduced } }));
  emit(ctx, 'settings', { settings: next, reduced, changed });
  return next;
}

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('settings')) return ctx.mods.settings;
  const { store } = ctx;

  // A page without WP2's settings controller still needs settings in the store.
  if (!store.get().settings) {
    const s = loadSettings({ coarse: coarsePointer() });
    const sys = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    store.set((st) => ({ settings: s, ui: { ...(st.ui || {}), reduced: isReduced(s, sys) } }));
  }

  // ------------------------------------------------------------------ <html> switches
  const html = document.documentElement;
  const applyDoc = () => {
    const st = store.get();
    const s = currentSettings(ctx);
    const sys = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const reduced = typeof st.ui?.reduced === 'boolean' ? st.ui.reduced : isReduced(s, sys);
    html.dataset.palette = s.palette === 'cb' ? 'cb' : 'std';
    html.dataset.motion = reduced ? 'reduced' : 'full';
    html.dataset.labels = s.labels || 'always';
    html.dataset.prices = st.feed?.prices === 'real' ? 'real' : 'sim';
  };
  watch(store, (s) => [s.settings, s.ui?.reduced, s.feed?.prices], applyDoc, (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
  try {
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', applyDoc);
  } catch {
    /* old browsers */
  }

  // ------------------------------------------------------------------ panel
  const sheets = getSheets(ctx);
  const p = sheets.panel('settings', { side: 'left', titleKey: 'g.set.title', snap: 92, icon: 'i-gear' });
  const controls = new Map(); // key → { set(value) }
  const texts = []; // [el, key, vars?] re-translated on language change

  const tx = (el, key, vars) => {
    texts.push([el, key, vars]);
    setText(el, t(key, vars));
    return el;
  };

  /** Segmented radio group. options: [[value, labelKey]] */
  function seg(key, labelKey, options, { onPick, note } = {}) {
    const name = `set-${key}`;
    const legend = tx(h('legend', { class: 'set-label' }), labelKey);
    const row = h('div', { class: 'seg', role: 'presentation' });
    const inputs = [];
    for (const [value, lk] of options) {
      const id = uid(name);
      const input = h('input', { type: 'radio', name, id, value: String(value), class: 'seg-input' });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        const v = typeof value === 'boolean' ? value : value;
        if (onPick) onPick(v);
        else setSettings(ctx, { [key]: v });
      });
      inputs.push([value, input]);
      row.append(input, tx(h('label', { for: id, class: 'seg-btn' }), lk));
    }
    const fs = h('fieldset', { class: 'set-row set-row--seg' }, legend, row, note ? tx(h('p', { class: 'set-note' }), note) : null);
    controls.set(key, {
      set(v) {
        for (const [value, input] of inputs) input.checked = value === v;
      },
    });
    return fs;
  }

  /** On/off switch (checkbox with role=switch). */
  function sw(key, labelKey) {
    const id = uid(`set-${key}`);
    const input = h('input', { type: 'checkbox', id, role: 'switch', class: 'switch-input' });
    input.addEventListener('change', () => setSettings(ctx, { [key]: input.checked }));
    const row = h('div', { class: 'set-row set-row--switch' }, tx(h('label', { for: id, class: 'set-label' }), labelKey), h('span', { class: 'switch' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' })));
    controls.set(key, { set: (v) => (input.checked = !!v) });
    return row;
  }

  function group(titleKey, ...rows) {
    return h('section', { class: 'set-group' }, tx(h('h3', { class: 'set-group-title' }), titleKey), ...rows);
  }

  // language (existing setLang)
  const langRow = seg('lang', 'lang.toggle', LANGS.map((l) => [l, `g.set.lang.${l}`]), {
    onPick: (v) => {
      setLang(v);
    },
  });

  // sound (+ volume)
  const soundRow = seg('sound', 'g.set.sound', [[false, 'g.set.off'], [true, 'g.set.on']], {
    onPick: (v) => ctx.mods.hud?.setSound?.(v) ?? setSettings(ctx, { sound: v }),
  });
  const volId = uid('set-volume');
  const vol = h('input', { type: 'range', id: volId, min: '0', max: '1', step: '0.05', class: 'range' });
  const volOut = h('output', { for: volId, class: 'set-out num' });
  vol.addEventListener('input', () => {
    setText(volOut, Math.round(Number(vol.value) * 100) + '%');
    vol.setAttribute('aria-valuetext', Math.round(Number(vol.value) * 100) + '%');
  });
  vol.addEventListener('change', () => {
    setSettings(ctx, { volume: Number(vol.value) });
    try {
      ctx.sfx?.setVolume?.(Number(vol.value));
    } catch {
      /* audio optional */
    }
  });
  controls.set('volume', {
    set(v) {
      vol.value = String(v ?? 0.6);
      setText(volOut, Math.round(Number(vol.value) * 100) + '%');
      vol.setAttribute('aria-valuetext', volOut.textContent);
    },
  });
  const volRow = h('div', { class: 'set-row set-row--range' }, tx(h('label', { for: volId, class: 'set-label' }), 'g.set.volume'), vol, volOut);

  const skyNote = h('p', { class: 'set-note', hidden: true });
  texts.push([skyNote, 'g.set.skySim']);
  const skyRow = seg('sky', 'g.set.sky', [['day', 'g.set.skyDay'], ['clock', 'g.set.skyClock']]);
  skyRow.append(skyNote);

  // command token (moved from the classic header; same brood-api behaviour)
  const tokId = uid('set-token');
  const tokInput = h('input', { id: tokId, type: 'password', autocomplete: 'off', spellcheck: 'false', class: 'input' });
  const tokSave = tx(h('button', { type: 'submit', class: 'btn btn--paper btn--sm' }), 'token.save');
  const tokState = h('span', { class: 'tok-state' });
  const tokMsg = h('p', { class: 'set-note', role: 'status' });
  const tokApi = h('p', { class: 'set-note', hidden: true });
  const tokForm = h(
    'form',
    { class: 'set-row set-row--token', autocomplete: 'off' },
    h('div', { class: 'tok-head' }, tx(h('label', { for: tokId, class: 'set-label' }), 'token.label'), tokState),
    h('div', { class: 'tok-line' }, tokInput, tokSave),
    tx(h('p', { class: 'set-note' }), 'token.help'),
    tokApi,
    tokMsg,
  );
  tokForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveToken(tokInput.value);
  });

  const hostOf = (origin) => {
    try {
      return new URL(origin).host;
    } catch {
      return String(origin);
    }
  };
  function renderToken(flash) {
    const cross = api.apiIsCrossOrigin();
    const origin = api.apiOrigin();
    setText(tokState, flash ? t(flash) : api.hasToken() ? t('token.saved') : t(cross ? 'token.noneRemote' : 'token.none'));
    tokApi.hidden = !cross;
    setText(tokApi, cross ? t(api.apiUntrusted() ? 'token.apiLink' : 'token.apiOther', { origin }) : '');
    tokApi.classList.toggle('warn', cross && api.apiUntrusted());
    tokInput.placeholder = t('token.placeholder');
  }
  async function saveToken(value) {
    let trustApi = false;
    if (String(value).trim() && api.apiUntrusted() && !api.tokenProblem(value)) {
      const origin = api.apiOrigin();
      trustApi = await (ctx.mods.confirm?.ask?.({
        title: t('token.trustTitle', { host: hostOf(origin) }),
        body: t('token.trust', { origin }),
        yes: t('token.trustYes', { host: hostOf(origin) }),
        danger: true,
      }) ?? Promise.resolve(false));
      if (!trustApi) return;
    }
    try {
      const saved = api.setToken(value, { trustApi });
      tokInput.value = '';
      setText(tokMsg, '');
      renderToken(saved ? 'token.saved' : 'token.cleared');
      announce(t(saved ? 'token.saved' : 'token.cleared'));
    } catch (e) {
      const key = e?.code === 'chars' ? 'token.badChars' : 'token.apiLink';
      setText(tokMsg, t(key, { origin: api.apiOrigin() }));
      tokMsg.classList.add('warn');
      announce(t(key, { origin: api.apiOrigin() }));
    }
  }

  const tourBtn = tx(h('button', { type: 'button', class: 'btn btn--paper' }), 'g.set.tour');
  tourBtn.addEventListener('click', () => {
    p.close();
    ctx.mods.tutorial?.start?.({ force: true });
  });
  const classic = tx(h('a', { class: 'btn btn--paper', href: '/classic.html' }), 'g.set.classic');
  const docs = tx(h('a', { class: 'btn btn--ghost', href: '/docs', target: '_blank', rel: 'noopener' }), 'app.apiDocs');
  const storageNote = h('p', { class: 'set-note set-note--warn', hidden: true });
  texts.push([storageNote, 'g.set.storageOff']);

  // accounts mode: Testnet + the account menu + the privacy note
  const tnBtn = h('button', { type: 'button', class: 'btn btn--paper' });
  tnBtn.addEventListener('click', () => ctx.mods.testnet?.open?.({ opener: tnBtn }));
  const acctBtn = tx(h('button', { type: 'button', class: 'btn btn--paper' }), 'g.acct.menu');
  acctBtn.addEventListener('click', () => ctx.mods.account?.open?.({ opener: acctBtn }));
  const privacyTitle = tx(h('h4', { class: 'set-label' }), 'g.acct.privacyTitle');
  const privacy = h('p', { class: 'set-note' });
  const acctGroup = group('g.acct.menu', h('div', { class: 'set-links' }, tnBtn, acctBtn), privacyTitle, privacy);
  acctGroup.hidden = true;

  p.body.append(
    acctGroup,
    group('g.set.groupView', langRow, seg('graphics', 'g.set.graphics', [['auto', 'g.set.auto'], ['high', 'g.set.high'], ['medium', 'g.set.medium'], ['low', 'g.set.low']]), skyRow, seg('labels', 'g.set.labels', [['always', 'g.set.labelsAlways'], ['hover', 'g.set.labelsHover'], ['off', 'g.set.labelsOff']]), seg('palette', 'g.set.palette', [['std', 'g.set.paletteStd'], ['cb', 'g.set.paletteCb']])),
    group('g.set.groupSound', soundRow, volRow, sw('ambience', 'g.set.ambience'), sw('chime', 'g.set.chime')),
    group('g.set.groupAccess', seg('motion', 'g.set.motion', [['system', 'g.set.system'], ['full', 'g.set.full'], ['reduced', 'g.set.reduced']]), sw('shortcuts', 'g.set.shortcuts'), sw('farmer', 'g.set.farmer'), sw('drift', 'g.set.drift')),
    group('g.set.groupMore', tokForm, h('div', { class: 'set-links' }, tourBtn, classic, docs), storageNote),
  );

  function render() {
    const s = currentSettings(ctx);
    for (const [k, c] of controls) {
      if (k === 'lang') c.set(getLang());
      else c.set(s[k]);
    }
    skyNote.hidden = store.get().feed?.prices !== 'sim';
    storageNote.hidden = storageWorks();
    const st = store.get();
    const accounts = D.isAccounts(st);
    // sessions replace the command token in accounts mode (§9.5): the token box is never shown there
    show(tokForm, !accounts);
    acctGroup.hidden = !accounts || !D.userOf(st);
    tnBtn.hidden = !D.testnetEnabled(st);
    setText(tnBtn, t(D.tnConnected(st) ? 'g.acct.tnConnected' : D.tnRevoked(st) ? 'g.acct.tnRevoked' : 'g.acct.tnConnect'));
    setText(privacy, t('g.acct.privacy', { days: D.backupDaysOf(st) }));
  }
  function retranslate() {
    p.setTitle(t('g.set.title'));
    for (const [el, key, vars] of texts) setText(el, t(key, vars));
    renderToken();
    render();
  }

  watch(store, (s) => s.settings, render);
  watch(store, (s) => [D.modeOf(s), D.userOf(s)?.id, D.tnConnected(s), D.tnRevoked(s), D.testnetEnabled(s)], render, (a, b) => !!a && !!b && a.every((x, i) => x === b[i]));
  watch(store, (s) => s.feed?.prices, render);
  p.onOpen(() => {
    renderToken();
    render();
  });
  onLangChange(retranslate);
  renderToken();
  render();

  // sound settings reach the audio engine (WP3) as they change
  on(ctx, 'settings', (msg) => {
    const s = msg?.settings;
    if (!s || !ctx.sfx) return;
    try {
      ctx.sfx.setVolume?.(s.volume);
      ctx.sfx.setAmbience?.(!!s.ambience);
      ctx.sfx.setChime?.(!!s.chime);
    } catch {
      /* audio is optional */
    }
  });

  const apiOut = { panel: p, set: (patch) => setSettings(ctx, patch), get: () => currentSettings(ctx), open: (o) => p.open(o) };
  ctx.mods.settings = apiOut;
  return apiOut;
}

function storageWorks() {
  try {
    const k = '__bean_probe__';
    globalThis.localStorage.setItem(k, '1');
    globalThis.localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

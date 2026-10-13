/**
 * ui/badge.js — the mode badge (always visible, never dismissible), its popover, the status banners and the
 * signpost label (GAME-DESIGN §6.3, §6.12, J9).
 *
 *   ● REAL PRICES · PAPER TRADES           #1D6B5A, white     (real, live, fresh, no stale coins)
 *   ◐ REAL PRICES · 3 COINS DELAYED · …    #F2C14E, ink       (live with stale coins)
 *   ◐ REAL PRICES · DELAYED 45 s · …       #F2C14E, ink       (state delayed, or marks older than 15 s)
 *   ○ PRICES DOWN since 12:03 · …          #5F6368, white     (+ #alert banner)
 *   ◆ SIMULATED PRICES · PAPER TRADES      #6B4FA0 + stripes  (sim)
 *   ○ OFFLINE · numbers from 12:04         #5F6368            (the client cannot reach the API)
 *
 * The truth table is WP2's pure feedBadge() (core/view.js). Phones show the short text (g.badge.short.*).
 * Banners (#banners): feed down, API offline (with the retry countdown and "Retry now"), field burned,
 * marks stale. `#alert` (assertive) hears feed-down and API-down ONLY (§7.1).
 * <html data-feed="live|delayed|down|sim|offline" data-net="ok|offline"> drives the edge fog and the dimmed
 * canvas in CSS (§6.12).
 *
 * Accounts mode (PLATFORM §9.4): a SECOND badge appears while the player is connected to testnet or has a testnet
 * bot: TESTNET ORDERS · TEST FUNDS (slate, checkered edge), TESTNET DOWN (grey) or TESTNET PAUSED BY THE OPERATOR
 * (grey). On a phone the two collapse into ONE chip ("REAL · PAPER + TESTNET", or its down / paused variants), so
 * both words stay visible (J9); tapping it opens the full text. Neither can be dismissed. "Restart the server"
 * (g.mode.realBack) is shown to admins only, and the burned-field banner offers the re-arm instead.
 *
 * Exports: mount(deps) → { closePopover(), shortText(), text() }, and the pure badgeModel(), testnetBadgeModel().
 * No three.js, no side effects at import.
 */

import { t, onLangChange } from '../../i18n.js';
import { isNum } from '../../format.js';
import * as V from '../core/view.js';
import { getCtx, on } from './context.js';
import { h, $, setText, watch, ageText, hhmm, countdown as countdownText } from './util.js';
import { alert as alertSR, announce, clearAlert } from './a11y.js';
import * as D from './derive.js';

const MARKS = { real: '●', warn: '◐', off: '○', sim: '◆', loading: '○' };

/** Pure: the badge model for a state (exported for tests). */
export function badgeModel(state, nowMs = D.nowOf(state)) {
  // store.feed when the data layer maintains it (it also folds in feed_status events), else the raw payloads
  const status = state?.feed?.source ? state.feed : state?.status ? V.feedOf(state.status, state.health) : state?.feed;
  if (!state?.status && !state?.health && !state?.feed?.source && state?.net?.ok !== false) {
    return { key: 'g.badge.loading', tone: 'loading', vars: {}, shortKey: 'g.badge.short.loading', mark: MARKS.loading, state: 'loading' };
  }
  const b = V.feedBadge({ status, marks: state?.marks || null, net: state?.net || null, nowMs });
  const vars = { ...b.vars };
  if (b.key === 'g.badge.delayed') vars.age = isNum(vars.ageMs) ? ageText(nowMs - Number(vars.ageMs), nowMs) : vars.age;
  if (b.key === 'g.badge.down' || b.key === 'g.badge.offline') vars.time = vars.time && vars.time !== '—' ? vars.time : hhmm(state?.net?.lastOkMs);
  let shortKey = b.short;
  let st = 'live';
  if (b.key === 'g.badge.offline') (shortKey = 'g.badge.short.offline'), (st = 'offline');
  else if (b.key === 'g.badge.down') (shortKey = 'g.badge.short.down'), (st = 'down');
  else if (b.key === 'g.badge.delayed' || b.key === 'g.badge.realPartial') (shortKey = 'g.badge.short.delayed'), (st = 'delayed');
  else if (b.key === 'g.badge.sim') st = 'sim';
  return { key: b.key, tone: b.tone, vars, shortKey, mark: MARKS[b.tone] || '○', state: st };
}

/**
 * Pure: the testnet badge (accounts mode), or null when the player does not use testnet.
 * → { key (desktop text), shortKey (the phone's combined chip), tone: 'testnet' | 'down' | 'kill' }
 */
export function testnetBadgeModel(state) {
  if (!D.isAccounts(state) || !D.userOf(state)) return null;
  const uses = D.tnConnected(state) || D.testnetBots(state).length > 0;
  if (!uses) return null;
  if (D.killSwitchOf(state).on) return { key: 'g.badge.kill', shortKey: 'g.badge.short.kill', tone: 'kill' };
  const st = D.tnState(state);
  if (st === 'down' || st === 'delayed') return { key: 'g.badge.testnetDown', shortKey: 'g.badge.short.testnetDown', tone: 'down' };
  return { key: 'g.badge.testnet', shortKey: 'g.badge.short.paperTestnet', tone: 'testnet' };
}

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('badge')) return ctx.mods.badge;
  const { store } = ctx;
  const btn = $('badge');
  const html = document.documentElement;
  let model = null;
  let tnModel = null;
  let popOpen = false;
  let lastAlert = '';
  // the second (testnet) badge sits right after the mode badge; desktop only (the phone combines both)
  let tnBtn = $('badgeTn');
  if (!tnBtn && btn) {
    tnBtn = h('button', { type: 'button', id: 'badgeTn', class: 'badge badge--tn desk-only', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', hidden: true }, h('span', { class: 'badge-long', id: 'badgeTnText' }));
    btn.after(tnBtn);
  }
  tnBtn?.addEventListener('click', () => (popOpen ? closePopover() : openPopover()));

  // ------------------------------------------------------------------ badge

  function render() {
    const s = store.get();
    model = badgeModel(s);
    if (!btn) return;
    btn.dataset.tone = model.tone;
    setText($('badgeMark'), model.mark);
    setText($('badgeText'), t(model.key, model.vars));
    // testnet in use: the phone's ONE chip names both venues (J9); the desktop shows a second badge
    tnModel = testnetBadgeModel(s);
    const combined = tnModel && model.state !== 'offline';
    setText($('badgeShort'), combined ? t(tnModel.shortKey) : t(model.shortKey));
    if (tnModel) btn.dataset.tn = tnModel.tone;
    else delete btn.dataset.tn;
    if (tnBtn) {
      tnBtn.hidden = !tnModel;
      if (tnModel) {
        tnBtn.dataset.tone = tnModel.tone;
        setText($('badgeTnText'), t(tnModel.key));
        tnBtn.setAttribute('aria-label', `${t(tnModel.key)} — ${t('g.badge.label')}`);
        tnBtn.setAttribute('aria-expanded', String(popOpen));
      }
    }
    // the accessible name always carries the full text, even when the phone shows the short one
    btn.setAttribute('aria-label', `${t(model.key, model.vars)}${tnModel ? ' · ' + t(tnModel.key) : ''} — ${t('g.badge.label')}`);
    html.dataset.feed = model.state;
    html.dataset.net = s.net?.ok === false ? 'offline' : 'ok';
    renderSignpost();
    renderBanners();
    if (popOpen) renderPopover();
    // §7.1: the assertive region hears feed down and API down only, once per transition
    const alertKey = model.state === 'down' || model.state === 'offline' ? model.state : '';
    if (alertKey && alertKey !== lastAlert) alertSR(model.state === 'down' ? t('g.mode.downBody', { time: model.vars.time }) : t('g.err.offline', { s: retrySeconds(s), time: model.vars.time }));
    if (!alertKey && lastAlert) {
      clearAlert(); // the outage sentence (with its frozen "retrying in 2 s") is no longer true
      announce(t(lastAlert === 'offline' ? 'g.err.back' : 'g.diary.feedBack'));
    }
    lastAlert = alertKey;
  }

  // ------------------------------------------------------------------ popover

  const pop = h('div', { class: 'popover popover--mode', id: 'modePop', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'modePopTitle', tabindex: '-1', hidden: true });
  $('dialogs')?.append(pop);

  function renderPopover() {
    const s = store.get();
    const f = s.feed || {};
    const m = model || badgeModel(s);
    const paras = [];
    const age = ageText(s.marks?.t ?? f.midsMs, D.nowOf(s));
    if (m.state === 'offline') paras.push(t('g.mode.offlineBody', { time: m.vars.time }));
    else if (f.prices === 'sim' || m.state === 'sim') {
      paras.push(t('g.mode.simBody'));
      if (f.fallback) paras.push(t('g.mode.fallbackBody', { error: String(f.fallback.reason ?? f.fallback.error ?? '—').slice(0, 200) }));
      // "restart the server" is an operator's action: players in accounts mode never read it (QA-19)
      if (f.realAvailable && (!D.isAccounts(s) || D.isAdmin(s))) paras.push(t('g.mode.realBack'));
    } else if (m.state === 'down') paras.push(t('g.mode.downBody', { time: m.vars.time }));
    else {
      paras.push(t(D.copyKey(s, 'g.mode.realBody'), { age }));
      const stale = [...D.staleCoinsOf(s)];
      if (stale.length) paras.push(t('g.mode.delayedCoins', { coins: stale.join(', ') }));
    }
    const tm = testnetBadgeModel(s);
    if (tm) paras.push(`${t(tm.key)} — ${t('g.venue.testnetLong')}`);
    if (D.isSpectator(s)) paras.push(t('g.gate.spectator'));
    pop.replaceChildren(
      h('h2', { class: 'pop-title', id: 'modePopTitle' }, h('span', { class: `badge-dot badge-dot--${m.tone}`, 'aria-hidden': 'true', text: m.mark }), ' ', t(m.key, m.vars)),
      ...paras.map((p) => h('p', { class: 'pop-note', text: p })),
      h('p', { class: 'pop-links' }, h('a', { href: '/docs', target: '_blank', rel: 'noopener', text: t('app.apiDocs') }), ' · ', h('a', { href: '/classic.html', text: t('g.set.classic') })),
    );
  }

  function openPopover() {
    renderPopover();
    pop.hidden = false;
    popOpen = true;
    btn?.setAttribute('aria-expanded', 'true');
    const r = btn?.getBoundingClientRect();
    if (r) {
      const w = Math.min(360, innerWidth - 32);
      pop.style.width = w + 'px';
      pop.style.left = Math.max(16, Math.min(innerWidth - w - 16, r.left)) + 'px';
      pop.style.top = Math.round(r.bottom + 8) + 'px';
    }
    pop.focus({ preventScroll: true });
  }
  function closePopover() {
    if (!popOpen) return false;
    pop.hidden = true;
    popOpen = false;
    btn?.setAttribute('aria-expanded', 'false');
    btn?.focus({ preventScroll: true });
    return true;
  }
  btn?.addEventListener('click', () => (popOpen ? closePopover() : openPopover()));
  document.addEventListener('pointerdown', (e) => {
    if (popOpen && !pop.contains(e.target) && !btn?.contains(e.target)) closePopover();
  });
  // the signpost landmark and its label open the same popover (§2.4)
  on(ctx, 'ui:mode', () => openPopover());

  // ------------------------------------------------------------------ banners

  const banners = $('banners');
  const bannerEls = new Map();
  function banner(id, on, { tone = 'warn', text = '', action = null } = {}) {
    let el = bannerEls.get(id);
    if (!on) {
      if (el) {
        el.remove();
        bannerEls.delete(id);
      }
      return;
    }
    if (!el) {
      el = h('div', { class: `banner banner--${tone}`, dataset: { banner: id } }, h('span', { class: 'banner-text' }));
      bannerEls.set(id, el);
      banners?.append(el);
    }
    el.className = `banner banner--${tone}`;
    setText(el.querySelector('.banner-text'), text);
    const old = el.querySelector('.banner-act');
    if (action && !old) {
      const b = h('button', { type: 'button', class: 'btn btn--sm btn--paper banner-act' });
      b.addEventListener('click', () => action.fn());
      el.append(b);
    }
    if (!action && old) old.remove();
    const act = el.querySelector('.banner-act');
    if (act && action) setText(act, action.label);
  }

  function retrySeconds(s) {
    const at = Number(s.net?.retryAtMs);
    if (Number.isFinite(at) && at > 0) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
    const inMs = Number(s.net?.retryInMs);
    return Number.isFinite(inMs) && inMs > 0 ? Math.ceil(inMs / 1000) : 2;
  }

  function renderBanners() {
    const s = store.get();
    const m = model || badgeModel(s);
    const offline = m.state === 'offline';
    banner('offline', offline, {
      tone: 'off',
      text: offline ? t('g.err.offline', { s: retrySeconds(s), time: m.vars.time }) : '',
      action: offline ? { label: t('g.err.retryNow'), fn: retryNow } : null,
    });
    banner('down', !offline && m.state === 'down', { tone: 'off', text: t('g.mode.downBody', { time: m.vars.time }) });
    const age = D.marksAgeOf(s);
    const marksStale = !offline && m.state !== 'down' && !D.isSim(s) && age !== null && age > 60_000;
    banner('marks', marksStale, { tone: 'warn', text: marksStale ? t('g.err.marksStale', { age: ageText(D.nowOf(s) - age, D.nowOf(s)) }) : '' });
    // burned: none mode says how it ends today; accounts mode offers the re-arm (after its 60 s countdown)
    const ra = D.rearmState(s);
    const haltedText = D.isAccounts(s) ? (ra.can ? t('plot.emptyHaltedRearm') : t('modal.haltedRearm', { time: countdownText(ra.waitMs) })) : t('plot.emptyHalted');
    banner('halted', D.isHalted(s), { tone: 'char', text: haltedText, action: D.isAccounts(s) && ra.can ? { label: t('g.rearm'), fn: () => ctx.mods.account?.rearm?.({ opener: document.activeElement }) } : null });
    const showBack = s.feed?.realAvailable && s.feed?.prices === 'sim' && (!D.isAccounts(s) || D.isAdmin(s));
    if (showBack) banner('realBack', true, { tone: 'info', text: t('g.mode.realBack') });
    else banner('realBack', false);
    // an API wallet the exchange no longer accepts: an urgent banner until reconnected (§6.9 agent_unknown)
    const revoked = D.isAccounts(s) && D.tnRevoked(s);
    banner('tnRevoked', revoked, { tone: 'warn', text: revoked ? t('g.tn.err.revoked') : '', action: revoked ? { label: t('g.plant.tnConnect'), fn: () => ctx.mods.testnet?.open?.({}) } : null });
    // expiry warnings (−7 d amber, −1 d red): the connect panel has Replace API wallet
    const exp = D.isAccounts(s) && D.tnConnected(s) ? D.tnExpiry(s) : { warn: null };
    banner('tnExpiry', !!exp.warn, { tone: exp.warn === '1d' ? 'char' : 'warn', text: exp.warn ? t('g.tn.expiring', { date: new Date(exp.validUntil).toLocaleDateString() }) : '', action: exp.warn ? { label: t('g.tn.replace'), fn: () => ctx.mods.testnet?.open?.({}) } : null });
  }

  function retryNow() {
    try {
      ctx.data?.refreshStatus?.();
      ctx.data?.tend?.();
    } catch {
      /* the data layer keeps its own back-off */
    }
  }

  // ------------------------------------------------------------------ signpost label (world, aria-hidden)

  let signEl = null;
  let signAnchor = null;
  function renderSignpost() {
    if (!signEl || !model) return;
    signEl.dataset.tone = model.tone;
    setText(signEl.querySelector('.sign-mark'), model.mark);
    setText(signEl.querySelector('.sign-text'), t(model.shortKey));
  }
  ctx.onStage((stage) => {
    try {
      signAnchor?.remove?.();
      const lm = stage?.world?.landmarks?.get?.('signpost');
      if (!lm || !stage.labels?.anchor) return;
      signEl = h('div', { class: 'lm-sign lm-sign--mode', 'aria-hidden': 'true' }, h('span', { class: 'sign-mark' }), h('span', { class: 'sign-text' }));
      $('chips')?.append(signEl);
      signAnchor = stage.labels.anchor(lm.anchor || lm.object3D, signEl, { offsetY: 0.4, pin: true });
      renderSignpost();
    } catch (e) {
      console.error('[ui] signpost label failed', e);
    }
  });

  // ------------------------------------------------------------------ subscriptions

  watch(store, (s) => [s.status, s.health, s.feed, s.net, s.marks?.t, s.live?.halted, s.testnet, s.venues, s.user, s.mode, s.bots, s.me], render, (a, b) => !!a && !!b && a.every((x, i) => Object.is(x, b[i])));
  // ages and the retry countdown move on their own
  const timer = setInterval(render, 1000);
  onLangChange(render);
  render();

  const apiOut = {
    closePopover,
    openPopover,
    text: () => (model ? t(model.key, model.vars) : ''),
    shortText: () => (model ? t(model.shortKey) : ''),
    dispose: () => clearInterval(timer),
  };
  ctx.mods.badge = apiOut;
  return apiOut;
}

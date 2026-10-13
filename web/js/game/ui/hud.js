/**
 * ui/hud.js — the top bar and money chips (GAME-DESIGN §6.1, §6.2, §1.5 fields, J1/J2/J5).
 *
 *   Money row:  Barn $10,042.18 (+0.42% ▲ vs start) · Pond $9,442.18 free · Water out $600 ·
 *               Growing +$38.12 ▲ · Harvested −$4.10 ▼ · Plants 6/10 · age tag ("3 s ago" / "delayed · 25 s")
 *   Status:     market weather + wind (never P&L colours) · windmill countdown "next bar in 0:23" · live dot
 *   Tools:      mute (M), settings, help · phone: barn mini + ⋯ More sheet (prices, burn, time-lapse, settings,
 *               help, classic) · desktop toolbar: time-lapse (SIM only) and 🔥 Burn.
 *
 * Honesty: every number is moneyView(live, marks) from core/view.js — the server's numbers, written at t = 0
 * (J2), never tweened. A harvest moves money from Growing to Harvested: the barn total only changes by the
 * fee and is never animated (J5); the transfer arrow is a text caption, not a counter.
 *
 * Accounts mode (PLATFORM §9.4 "Ledgers"): the chips, barn, pond and tower show the PAPER ledger; the barn popover
 * always shows BOTH ledgers side by side. The testnet column is the exchange's account value with its age (≈ for a
 * unified account), free test USDC, bots and funding, and NO "vs start" (it moves with faucet claims and manual
 * trades) — only "since you connected on {date}: {delta}". A spectator's popover asks them to sign in.
 *
 * Exports: mount(deps) → { toggleSound(), setSound(on), closePopover(), render() }, and the pure ledgersModel().
 * No three.js, no side effects at import.
 */

import { t, onLangChange, bareText as bare } from '../../i18n.js';
import { usd, isNum } from '../../format.js';
import * as V from '../core/view.js';
import { getCtx, on, emit } from './context.js';
import { h, $, setText, setAttr, setMoney, money, chgText, countdown, ageLabel, watch, isPhone, reducedMotion, show, setBlocked, setVenueBadge } from './util.js';
import { getSheets } from './sheets.js';
import { getActions } from './actions.js';
import { setSettings, currentSettings } from './settings.js';
import * as D from './derive.js';
import { announce } from './a11y.js';

/**
 * Pure: both ledgers for the barn popover (accounts mode). → { paper: {...moneyView}, testnet: null | {
 *   connected, value, est, free, age_ms, bots, funding, sinceConnect: {date_ms, delta} | null } }
 */
export function ledgersModel(state) {
  const paper = V.moneyView(state?.live, state?.marks);
  if (!D.isAccounts(state) || !D.testnetEnabled(state)) return { paper, testnet: null };
  const l = D.tnLedger(state);
  const delta = l.account_value !== null && l.value_at_connect !== null ? l.account_value - l.value_at_connect : null;
  return {
    paper,
    testnet: {
      connected: l.connected,
      value: l.account_value,
      est: l.est,
      free: l.free,
      as_of_ms: l.as_of_ms,
      bots: l.bots_open,
      funding: l.funding,
      sinceConnect: delta !== null && l.connected_ms ? { date_ms: l.connected_ms, delta } : null,
    },
  };
}

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('hud')) return ctx.mods.hud;
  const { store } = ctx;
  const A = getActions(ctx);
  const sheets = getSheets(ctx);

  // ------------------------------------------------------------------ money chips

  // P1 (§9.4): the Paper | Testnet ledger toggle, first in the money row; only when the testnet ledger exists
  const ledgerBtn = h('button', { type: 'button', class: 'mchip-btn ledger-btn', id: 'ledgerToggle', 'aria-pressed': 'false' }, h('span', { class: 'vbadge vbadge--paper' }), h('span', { class: 'ledger-text' }));
  const ledgerLi = h('li', { class: 'mchip mchip--ledger', hidden: true }, ledgerBtn);
  $('money')?.prepend(ledgerLi);
  ledgerBtn.addEventListener('click', () => {
    const next = D.activeLedger(store.get()) === 'testnet' ? 'paper' : 'testnet';
    setSettings(ctx, { ledger: next });
    announce(t('g.hud.ledger', { venue: t('g.venue.' + next) }));
  });

  /** The testnet ledger on the chips (exchange numbers, ≈ where estimated, no vs-start; J1, J5). */
  function renderTestnetMoney(s, nowMs) {
    const m = D.tnMoneyView(s);
    const barn = m.barn === null ? '—' : (m.barnEst ? '≈ ' : '') + usd(m.barn, 2);
    setText($('vBarn'), barn);
    setText($('barnMiniV'), m.barn === null ? '—' : (m.barnEst ? '≈ ' : '') + usd(m.barn, 0));
    const vs = $('vVsStart');
    if (vs) setText(vs, '');
    setText($('vPond'), m.pond === null ? '—' : usd(m.pond, 2));
    setText($('vTower'), usd(m.tower, 2));
    setMoney($('vGrowing'), m.growing, { cls: 'v num', est: true });
    setMoney($('vHarvested'), m.harvested, { cls: 'v num' });
    setText($('vPlants'), String(m.plants));
    const ageEl = $('moneyAge');
    if (ageEl) {
      const a = ageLabel(m.asOfMs, nowMs);
      ageEl.hidden = !isNum(m.asOfMs);
      setText(ageEl, `${t('g.src.hlTestnet')} · ${a.text}`);
      ageEl.className = `mchip mchip--age age age--${a.kind}`;
    }
    setAttr($('mTower'), 'title', t('g.hud.tower'));
    setAttr($('mPond'), 'title', t('g.hud.tnFree'));
  }

  function renderMoney() {
    const s = store.get();
    const nowMs = D.nowOf(s);
    // the ledger toggle (P1): visible when there is a testnet ledger; the chips follow the chosen ledger
    const avail = D.tnLedgerAvailable(s);
    const led = D.activeLedger(s);
    ledgerLi.hidden = !avail;
    ledgerBtn.setAttribute('aria-pressed', String(led === 'testnet'));
    setVenueBadge(ledgerBtn.querySelector('.vbadge'), led);
    setText(ledgerBtn.querySelector('.ledger-text'), t('g.hud.ledger', { venue: t('g.venue.' + led) }));
    setAttr(ledgerBtn, 'title', t('g.hud.ledgerTitle'));
    $('money')?.classList.toggle('money--testnet', led === 'testnet');
    setAttr($('money'), 'aria-label', led === 'testnet' ? `${t('g.venue.testnet')} · ${t('g.hud.tnValue')}` : t('g.hud.money'));
    if (led === 'testnet') {
      renderTestnetMoney(s, nowMs);
      if (popOpen) renderPopover();
      return;
    }
    const m = V.moneyView(s.live, s.marks);
    setText($('vBarn'), m.barn === null ? '—' : usd(m.barn, 2));
    setText($('barnMiniV'), m.barn === null ? '—' : usd(m.barn, 0));
    const vs = $('vVsStart');
    if (vs) {
      if (m.vsStartPct === null) setText(vs, '');
      else {
        const mm = money(m.vsStartPct * 100, { glyph: true });
        // a % is not dollars: rebuild the text with the same sign/tone rules (§6.13 rule 2)
        const p = m.vsStartPct * 100;
        const zero = Math.abs(p) < 0.005;
        const body = (zero ? '' : p > 0 ? '+' : '−') + Math.abs(p).toFixed(2) + '%' + (zero ? '' : p > 0 ? ' ▲' : ' ▼');
        setText(vs, t('g.hud.vsStart', { pct: body }));
        vs.className = `sub money money--${zero ? 'zero' : mm.tone}`;
      }
    }
    setText($('vPond'), m.pond === null ? '—' : usd(m.pond, 2));
    setText($('vTower'), m.tower === null ? '—' : usd(m.tower, 2));
    setMoney($('vGrowing'), m.growing, { cls: 'v num' });
    setMoney($('vHarvested'), m.harvested, { cls: 'v num' });
    const max = m.maxPlants;
    setText($('vPlants'), m.plants === null ? '—' : max ? `${m.plants}/${max}` : String(m.plants));

    // the age of these numbers (§6.13 rule 5): marks when newer, else live_status
    const ageEl = $('moneyAge');
    if (ageEl) {
      const ms = m.ages?.ms;
      if (!isNum(ms)) {
        ageEl.hidden = true;
      } else {
        const a = ageLabel(ms, nowMs);
        ageEl.hidden = false;
        setText(ageEl, a.text);
        ageEl.className = `mchip mchip--age age age--${a.kind}`;
      }
    }
    // landmark-style tooltips on the chips (same numbers, full sentences)
    setAttr($('mTower'), 'title', m.tower === null ? t('g.hud.tower') : t('g.lm.tower', { usd: usd(m.tower, 2), room: m.room === null ? '—' : usd(m.room, 0), cap: m.notionalCap === null ? '—' : usd(m.notionalCap, 0) }));
    setAttr($('mPond'), 'title', m.pond === null ? t('g.hud.pond') : t('g.lm.pond', { usd: usd(m.pond, 2) }));
    if (popOpen) renderPopover();
  }

  // ------------------------------------------------------------------ weather · wind · clock · live

  function renderStatus() {
    const s = store.get();
    const w = s.market?.weather;
    const wind = s.market?.wind;
    const wEl = $('weather');
    if (wEl) {
      const parts = [];
      if (w && w.key) parts.push(`${t('weather.' + w.key)} ${chgText(w.mean, 1)}`);
      else parts.push(t('weather.unknown'));
      if (wind && wind.key) parts.push(t('g.wind.' + wind.key));
      setText(wEl, parts.join(' · '));
      setAttr(wEl, 'title', `${t('weather.label')} — ${t('g.weather.note')}${wind ? '. ' + t('g.wind.label') : ''}`);
    }
    renderLive();
    renderClock();
    // time-lapse exists only with simulated prices (sundial, §2.4), and only for admins in accounts mode (§2.3)
    const lapse = D.canTimelapse(s);
    for (const id of ['btnTimelapse', 'moreTimelapse']) show($(id), lapse);
    const halted = D.isHalted(s);
    for (const id of ['btnBurn', 'moreBurn']) {
      const b = $(id);
      if (!b) continue;
      // a spectator's Burn is not "disabled": it opens the farm gate (QA-02, like the fire pit)
      setBlocked(b, !D.isSpectator(s) && (halted || D.isOffline(s) || D.openBots(s).length === 0));
      setAttr(b, 'title', halted ? t(D.copyKey(s, 'plot.emptyHalted')) : t('field.burnTitle'));
    }
  }

  function renderLive() {
    const s = store.get();
    const el = $('live');
    if (!el) return;
    let state = s.net?.stream || 'off';
    if (s.net?.ok === false) state = 'offline';
    el.dataset.state = state;
    const key = state === 'live' ? 'live.on' : state === 'reconnecting' ? 'live.reconnecting' : state === 'offline' ? 'g.live.offline' : 'live.polling';
    setText($('liveText'), t(key));
    setAttr(el, 'title', state === 'live' ? t('live.title') : state === 'offline' ? t('err.unreachable') : t('g.err.sse'));
  }

  let lastClock = '';
  function renderClock() {
    const s = store.get();
    const f = s.feed || {};
    const el = $('clockText');
    if (!el) return;
    let text;
    if (s.net?.ok === false) text = t('g.clock.waiting');
    else if (f.state === 'down' || (f.lagBars || 0) > 0) text = (f.lagBars || 0) > 0 ? t('g.clock.lag', { n: f.lagBars }) : t('g.clock.waiting');
    else if (isNum(f.nextTickMs)) {
      const left = Number(f.nextTickMs) - D.nowOf(s);
      // a bar that is late by more than its grace reads "waiting", never a negative countdown
      text = left < -5000 ? t('g.clock.waiting') : t(D.isSim(s) ? 'g.clock.nextSim' : 'g.clock.next', { s: countdown(Math.max(0, left)) });
    } else text = t('g.clock.waiting');
    if (text !== lastClock) {
      lastClock = text;
      setText(el, text);
    }
  }
  const clockTimer = setInterval(renderClock, 1000);

  // ------------------------------------------------------------------ sound (M, header toggle)

  function soundOn() {
    return !!currentSettings(ctx).sound;
  }
  function setSound(on) {
    // the AudioContext may only be created inside this user gesture (§8)
    try {
      ctx.sfx?.enable?.(!!on);
    } catch (e) {
      console.error('[ui] sound toggle failed', e);
    }
    setSettings(ctx, { sound: !!on });
    renderMute();
    return !!on;
  }
  function toggleSound() {
    const on = setSound(!soundOn());
    announce(t(on ? 'g.set.sound' : 'g.set.mute') + ': ' + t(on ? 'g.set.on' : 'g.set.off'));
  }
  function renderMute() {
    const b = $('btnMute');
    if (!b) return;
    const on = soundOn();
    b.setAttribute('aria-pressed', String(on));
    b.dataset.on = on ? '1' : '';
    const label = t(on ? 'g.set.mute' : 'g.set.unmute');
    b.setAttribute('aria-label', label);
    b.title = label;
  }
  $('btnMute')?.addEventListener('click', toggleSound);

  // ------------------------------------------------------------------ money popover (barn)

  let popOpen = false;
  let popOpener = null;
  const pop = h('div', { class: 'popover popover--money', id: 'moneyPop', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'moneyPopTitle', tabindex: '-1', hidden: true });
  $('dialogs')?.append(pop);

  function row(label, value, cls = '') {
    return h('div', { class: 'kv' + (cls ? ' ' + cls : '') }, h('dt', { text: label }), h('dd', { class: 'num' }, value));
  }

  function renderPopover() {
    const s = store.get();
    // a spectator has no money of their own: the barn asks them to sign in (QA-02)
    if (D.isSpectator(s)) {
      const signIn = h('button', { type: 'button', class: 'btn btn--wood btn--sm', text: t('g.gate.signin') });
      signIn.addEventListener('click', () => {
        closePopover();
        ctx.mods.gate?.open?.({ opener: popOpener || $('stage') });
      });
      pop.replaceChildren(h('h2', { class: 'pop-title', id: 'moneyPopTitle', text: t('g.hud.money') }), h('p', { class: 'pop-note', text: t('g.lm.signInToSee', { place: t('g.place.barn') }) }), h('p', { class: 'pop-links' }, signIn));
      return;
    }
    const lm = ledgersModel(s);
    if (lm.testnet) return renderLedgers(s, lm);
    const m = V.moneyView(s.live, s.marks);
    const tot = V.closedTotals(s.bots);
    const vs = m.vsStartPct === null ? '' : ` (${t('g.hud.vsStart', { pct: (m.vsStartPct >= 0 ? '+' : '−') + Math.abs(m.vsStartPct * 100).toFixed(2) + '%' })})`;
    const age = ageLabel(m.ages?.ms, D.nowOf(s));
    pop.replaceChildren(
      h('h2', { class: 'pop-title', id: 'moneyPopTitle', text: t('g.hud.money') }),
      h('p', { class: 'pop-sub', text: t('g.hud.paperNote', { usd: m.start === null ? '—' : usd(m.start, 0) }) }),
      h(
        'dl',
        { class: 'kvs' },
        row(t('g.hud.barn'), h('span', { text: (m.barn === null ? '—' : usd(m.barn, 2)) + vs })),
        row(t('g.hud.pond'), h('span', { text: m.pond === null ? '—' : usd(m.pond, 2) })),
        row(t('g.hud.tower'), h('span', { text: m.tower === null ? '—' : usd(m.tower, 2) })),
        row(t('g.hud.growing'), moneyChip(m.growing)),
        row(t('g.hud.harvested'), moneyChip(m.harvested)),
        row(t('g.lm.cratesShort'), h('span', { text: `${tot.crates.n} · ${money(tot.crates.usd).text}` }), 'kv--quiet'),
        row(t('g.lm.compostShort'), h('span', { text: `${tot.compost.n} · ${money(tot.compost.usd).text}` }), 'kv--quiet'),
      ),
      h('p', { class: 'pop-note', text: t('g.hud.moneyNote') }),
      m.room === null ? null : h('p', { class: 'pop-note', text: t('g.lm.tower', { usd: usd(m.tower, 2), room: usd(m.room, 0), cap: usd(m.notionalCap, 0) }) }),
      h('p', { class: `pop-age age age--${age.kind}`, text: age.text }),
    );
  }
  function moneyChip(x) {
    const mm = money(x);
    return h('span', { class: `money money--${mm.tone}`, text: mm.text });
  }

  /** Accounts mode with the testnet on: Paper | Testnet side by side (never mixed, J5: nothing animates). */
  function renderLedgers(s, lm) {
    const m = lm.paper;
    const tn = lm.testnet;
    const now = D.nowOf(s);
    const age = ageLabel(m.ages?.ms, now);
    const vs = m.vsStartPct === null ? '' : ` (${t('g.hud.vsStart', { pct: (m.vsStartPct >= 0 ? '+' : '−') + Math.abs(m.vsStartPct * 100).toFixed(2) + '%' })})`;
    const paperCol = h(
      'section',
      { class: 'ledger ledger--paper' },
      h('h3', { class: 'ledger-title' }, h('span', { class: 'vbadge vbadge--paper', text: t('g.venue.paper') }), ' ', t('g.hud.paperCol')),
      h(
        'dl',
        { class: 'kvs' },
        row(t('g.hud.barn'), h('span', { text: (m.barn === null ? '—' : usd(m.barn, 2)) + vs })),
        row(t('g.hud.pond'), h('span', { text: m.pond === null ? '—' : usd(m.pond, 2) })),
        row(t('g.hud.tower'), h('span', { text: m.tower === null ? '—' : usd(m.tower, 2) })),
        row(t('g.hud.growing'), moneyChip(m.growing)),
        row(t('g.hud.harvested'), moneyChip(m.harvested)),
      ),
      h('p', { class: `pop-age age age--${age.kind}`, text: age.text }),
    );
    let tnBody;
    if (!tn.connected && tn.value === null) {
      const connect = h('button', { type: 'button', class: 'btn btn--paper btn--sm', text: t('g.plant.tnConnect') });
      connect.addEventListener('click', () => {
        closePopover();
        ctx.mods.testnet?.open?.({ opener: $('mBarn') || $('barnMini') });
      });
      tnBody = [h('p', { class: 'muted', text: t('g.hud.tnNone') }), h('p', { class: 'muted', text: t('g.tn.optional') }), connect];
    } else {
      const tAge = ageLabel(tn.as_of_ms, now);
      tnBody = [
        h(
          'dl',
          { class: 'kvs' },
          row(t('g.hud.tnValue'), h('span', { text: tn.value === null ? '—' : (tn.est ? '≈ ' : '') + usd(tn.value, 2) })),
          row(t('g.hud.tnFree'), h('span', { text: tn.free === null ? '—' : usd(tn.free, 2) })),
          row(t('g.hud.tnBots'), h('span', { text: String(tn.bots ?? 0) })),
          tn.funding === null ? null : row(t('g.hud.tnFunding'), moneyChip(tn.funding)),
        ),
        tn.sinceConnect ? h('p', { class: 'pop-note num', text: t('g.lm.barnTestnet', { usd: (tn.est ? '≈ ' : '') + usd(tn.value, 2), age: tAge.text, date: new Date(tn.sinceConnect.date_ms).toLocaleDateString(), delta: money(tn.sinceConnect.delta, { est: tn.est }).text }) }) : null,
        h('p', { class: `pop-age age age--${tAge.kind}`, text: `${t('g.src.hlTestnet')} · ${tAge.text}` }),
      ];
    }
    const tnCol = h('section', { class: 'ledger ledger--testnet' }, h('h3', { class: 'ledger-title' }, h('span', { class: 'vbadge vbadge--testnet', text: t('g.venue.testnet') }), ' ', t('g.hud.testnetCol')), ...tnBody);
    pop.replaceChildren(
      h('h2', { class: 'pop-title', id: 'moneyPopTitle', text: t('g.hud.money') }),
      h('div', { class: 'ledgers' }, paperCol, tnCol),
      h('p', { class: 'pop-note', text: t('g.hud.moneyNote') }),
    );
  }

  function openPopover(opener) {
    popOpener = opener;
    renderPopover();
    pop.hidden = false;
    popOpen = true;
    for (const id of ['mBarn', 'barnMini']) setAttr($(id), 'aria-expanded', 'true');
    placePopover(opener);
    pop.focus({ preventScroll: true });
  }
  function closePopover() {
    if (!popOpen) return false;
    pop.hidden = true;
    popOpen = false;
    for (const id of ['mBarn', 'barnMini']) setAttr($(id), 'aria-expanded', 'false');
    popOpener?.focus?.({ preventScroll: true });
    popOpener = null;
    return true;
  }
  function placePopover(opener) {
    const r = opener?.getBoundingClientRect?.();
    if (!r) return;
    const two = !!ledgersModel(store.get()).testnet;
    const w = Math.min(two ? 560 : 340, innerWidth - 32);
    const left = Math.max(16, Math.min(innerWidth - w - 16, r.left));
    pop.style.left = left + 'px';
    pop.style.top = Math.round(r.bottom + 8) + 'px';
    pop.style.width = w + 'px';
  }
  for (const id of ['mBarn', 'barnMini']) {
    $(id)?.addEventListener('click', (e) => {
      if (popOpen) closePopover();
      else openPopover(e.currentTarget);
    });
  }
  document.addEventListener('pointerdown', (e) => {
    if (!popOpen) return;
    if (pop.contains(e.target) || e.target.closest?.('#mBarn, #barnMini')) return;
    closePopover();
  });

  // ------------------------------------------------------------------ harvest transfer caption (J5: text only)

  const transfer = h('div', { class: 'transfer', 'aria-hidden': 'true', hidden: true }, h('span', { class: 'transfer-arrow', text: '→' }), h('span', { class: 'transfer-text' }));
  $('hud')?.append(transfer);
  let transferTimer = 0;
  on(ctx, 'game:event', (ev) => {
    if (!ev || ev.type !== 'closed' || !isNum(ev.realized_pnl)) return;
    const mm = money(ev.realized_pnl);
    setText(transfer.querySelector('.transfer-text'), t('g.hud.transfer', { usd: mm.text }));
    transfer.className = `transfer transfer--${mm.tone}`;
    const from = $('mGrowing')?.getBoundingClientRect();
    if (from && !isPhone()) {
      transfer.style.left = Math.round(from.left) + 'px';
      transfer.style.top = Math.round(from.bottom + 6) + 'px';
    } else {
      transfer.style.removeProperty('left');
      transfer.style.removeProperty('top');
    }
    transfer.hidden = false;
    transfer.classList.toggle('is-moving', !reducedMotion());
    clearTimeout(transferTimer);
    transferTimer = setTimeout(() => (transfer.hidden = true), 2600);
  });

  // ------------------------------------------------------------------ toolbar: time-lapse, burn, More sheet

  $('btnTimelapse')?.addEventListener('click', (e) => runTimelapse(e.currentTarget));
  $('btnBurn')?.addEventListener('click', (e) => {
    // a spectator has no field to burn: the button asks them to sign in, like the fire pit (QA-02)
    if (D.isSpectator(store.get())) return ctx.mods.gate?.open?.({ opener: e.currentTarget });
    if (e.currentTarget.dataset.blocked === '1') {
      announce(D.isHalted(store.get()) ? t(D.copyKey(store.get(), 'plot.emptyHalted')) : t('g.empty.list'));
      return;
    }
    A.requestBurn({ opener: e.currentTarget });
  });

  async function runTimelapse(btn) {
    if (!btn || btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('aria-busy', 'true');
    try {
      await A.timelapse();
    } finally {
      btn.dataset.busy = '';
      btn.removeAttribute('aria-disabled');
      btn.removeAttribute('aria-busy');
    }
  }

  // ⋯ More (phone): the toolbar items that do not fit the 56 px bottom bar
  const more = sheets.panel('more', { side: 'left', titleKey: 'g.btn.moreTitle', snap: 60, icon: 'i-more' });
  const moreBtn = (id, iconId, key, fn) => {
    const b = h('button', { type: 'button', class: 'btn btn--paper more-btn', id }, h('span', { class: 'more-ico' }), h('span', { class: 'more-text' }));
    b.querySelector('.more-ico').append(iconSvg(iconId));
    b.dataset.key = key;
    b.addEventListener('click', fn);
    return b;
  };
  const iconSvg = (id) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `/img/icons.svg#${id}`);
    svg.append(use);
    return svg;
  };
  const moreItems = [
    moreBtn('morePrices', 'i-prices', 'g.btn.prices', (e) => sheets.open('board', { opener: e.currentTarget })),
    moreBtn('moreList', 'i-list', 'g.btn.list', (e) => sheets.open('list', { opener: e.currentTarget })),
    moreBtn('moreTimelapse', 'i-sun', 'g.btn.timelapse', (e) => runTimelapse(e.currentTarget)),
    moreBtn('moreBurn', 'i-fire', 'g.btn.burn', (e) => {
      if (D.isSpectator(store.get())) {
        more.close();
        return ctx.mods.gate?.open?.({ opener: $('btnMore') });
      }
      if (e.currentTarget.dataset.blocked === '1') return announce(t(D.copyKey(store.get(), 'plot.emptyHalted')));
      more.close();
      A.requestBurn({ opener: $('btnMore') });
    }),
    moreBtn('moreSettings', 'i-gear', 'g.btn.settings', (e) => sheets.open('settings', { opener: e.currentTarget })),
    moreBtn('moreHelp', 'i-help', 'g.btn.help', (e) => sheets.open('help', { opener: e.currentTarget })),
  ];
  moreItems.find((b) => b.id === 'moreBurn')?.classList.add('btn--danger-soft');
  const classicLink = h('a', { class: 'btn btn--ghost more-btn', href: '/classic.html', id: 'moreClassic' }, h('span', { class: 'more-text' }));
  classicLink.dataset.key = 'g.set.classic';
  more.body.append(h('div', { class: 'more-grid' }, ...moreItems, classicLink));
  const renderMoreTexts = () => {
    more.setTitle(t('g.btn.moreTitle'));
    for (const b of [...moreItems, classicLink]) setText(b.querySelector('.more-text'), bare(t(b.dataset.key)));
  };
  renderMoreTexts();

  // ------------------------------------------------------------------ subscriptions

  watch(store, (s) => [s.live, s.marks?.t, s.net?.skewMs, s.venues, s.testnet, s.user, s.mode, s.settings?.ledger, s.bots], renderMoney, arrEq);
  watch(store, (s) => [s.market?.weather, s.market?.wind, s.net, s.feed, s.live?.halted, s.bots, s.mode, s.user], renderStatus, arrEq);
  watch(store, (s) => s.settings?.sound, renderMute);
  // the age tag ticks even when no data arrives (that is the point of an age)
  const ageTimer = setInterval(renderMoney, 5000);
  onLangChange(() => {
    lastClock = '';
    renderMoney();
    renderStatus();
    renderMute();
    renderMoreTexts();
  });

  const apiOut = {
    toggleSound,
    setSound,
    closePopover,
    openMoney: (opener) => (popOpen ? null : openPopover(opener || $('mBarn') || $('barnMini'))),
    render() {
      renderMoney();
      renderStatus();
    },
    dispose() {
      clearInterval(clockTimer);
      clearInterval(ageTimer);
    },
  };
  ctx.mods.hud = apiOut;
  emit(ctx, 'ui:hudReady', {});
  return apiOut;
}

function arrEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}


/**
 * ui/plantDialog.js — the plant dialog (GAME-DESIGN §6.5 "Plant dialog rules", J1, J3, J10; PLATFORM §9.4).
 *
 *   Plant SOL · sunflower
 *   Bean #688 · hyper_algo · momentum · 10×  ·  Paper +18.4% total · +2.1% 7d · max DD 9.8% · win 54% · 212 fills
 *   Where it trades: (•) Paper (simulated) ( ) Testnet (real test orders)          ← accounts mode with testnet on
 *   Real price $110.425 (Hyperliquid · 2 s ago) · Bean now LONG ↑ since 13:58 @ $109.870 → you enter at ≈ $110.425
 *   Water [100] $ ━━●━━  (20…1000, step 10; number + slider paired; aria-valuetext = dollars)
 *   mirrors 10.0% ≈ $708 notional · Margin ≈ $70.80 at 10× isolated · ⚠ a 9.5% move liquidates it
 *   Worst case: the whole margin · Fees ≈ $0.85 open + close · Funding info only · Room / free cash · Plot 04
 *   ☐ I understand this is 25× … (only ≥ 25×)
 *   [Cancel] [🌱 Plant & water $100 (paper)]   PAPER TRADE — simulated fill at the real price. No real money.
 *
 *   Paper math: plantQuote() / mirrorNote() / stakeRoom() from model.js (never re-implemented here).
 *   Paper is blocked with a red reason when: over the room (modal.overCap / modal.full), halted, coin stale or marks
 *   older than 15 s, feed down, API offline, the coin already planted, ≥ 25× without the checkbox.
 *
 *   Testnet (PLATFORM §9.4): the option is enabled by the STAKE-INDEPENDENT checks only (testnet_quote.venue_ok /
 *   venue_reason, §7.3 checks 1–11); a disabled option names its reason (g.plant.tnReason.*), and not_connected
 *   explains testnet (g.plant.tnExplain) with a Connect button. Switching clamps the water to
 *   min(500, room, 0.9 × free collateral). testnet_quote is asked when the dialog opens, on a venue switch, 300 ms
 *   after the slider settles and at submit — never more than once per 300 ms; numbers between quotes carry ≈.
 *   Lines: the real price AND the testnet mid (with its age, "Hyperliquid TESTNET"); divergence > 3 % amber,
 *   > 20 % a required tick (ack_divergence); "bean results are at real prices"; size ×k; margin, liquidation move,
 *   fees and room from the quote; IOC slippage (≤ ≈ $); thin book blocks; the TESTNET funding rate; the testnet
 *   footer. Sends bot_create {bean, capital_usd, venue:'testnet', confirm:'testnet', ack_divergence?}.
 *
 *   Submit → actions.plant() → data.command('bot_create'); the dialog stays open until the answer (J3).
 *   Error → inline (role=alert, localised by code), focus moves to it, the dialog stays.
 *
 * Exports: mount(deps) → { open(bean, slot, o), close(), isOpen() }, and the pure testnet helpers below.
 * No three.js, no side effects at import.
 */

import * as api from '../../brood-api.js';
import { t, onLangChange } from '../../i18n.js';
import { usd, pct, fmt, isNum } from '../../format.js';
import { WATER, plantQuote, mirrorNote, fmtPx } from '../../model.js';
import { getCtx } from './context.js';
import { h, $, setText, setAttr, cropIcon, cropName, ageLabel, hhmm, plotNo, setBusy, isBusy, setBlocked, trapTab, watch, nextFrame, showErr, uid, venueBadge } from './util.js';
import { getActions } from './actions.js';
import { fundingText } from './board.js';
import * as D from './derive.js';

const HIGH_LEV = 25;

// ------------------------------------------------------------------ pure testnet helpers (tested)

/** Testnet stake ceiling of §7.3 (per-bot cap 500). */
export const TN_STAKE_MAX = 500;
/** Divergence thresholds of §9.4: > 3 % amber line, > 20 % a required tick. */
export const DIVERGE = Object.freeze({ warn: 0.03, ack: 0.2 });
/** testnet_quote at most once per this many ms (§9.4 quote cadence). */
export const QUOTE_MIN_MS = 300;

const n = (x) => (isNum(x) ? Number(x) : null);

/** Water slider max on testnet: min(500, cap, room, 0.9 × free collateral), on the 10 $ step. */
export function tnStakeMax(quote, caps = null) {
  let m = Math.min(TN_STAKE_MAX, n(caps?.max_bot_capital_usd) ?? TN_STAKE_MAX);
  if (n(quote?.room_usd) !== null) m = Math.min(m, n(quote.room_usd));
  if (n(quote?.free_usd) !== null) m = Math.min(m, 0.9 * n(quote.free_usd));
  return Math.max(0, Math.floor(m / WATER.step) * WATER.step);
}

/** The water after a switch to testnet: the current water clamped into [min, tnStakeMax]. */
export function clampTnStake(stake, quote, caps = null) {
  const max = tnStakeMax(quote, caps);
  return Math.max(WATER.min, Math.min(Number(stake) || WATER.def, Math.max(WATER.min, max)));
}

/**
 * Is the Testnet option enabled? Only the stake-independent checks decide (§7.3 checks 1–11 = venue_ok).
 * The page already knows some reasons without a quote (server switch, link, kill switch); the rest come from it.
 * → { ok: true | false | null (asking), reason }
 */
export function tnVenueState(state, quote) {
  if (!D.testnetEnabled(state)) return { ok: false, reason: 'testnet_disabled' };
  if (D.killSwitchOf(state).on) return { ok: false, reason: 'kill_switch' };
  if (D.isHalted(state)) return { ok: false, reason: 'halted' };
  if (!D.tnConnected(state)) return { ok: false, reason: D.tnRevoked(state) ? 'credential_revoked' : 'not_connected' };
  if (!quote) return { ok: null, reason: null };
  if (quote.venue_ok) return { ok: true, reason: null };
  return { ok: false, reason: quote.venue_reason || 'testnet_down' };
}

/** 'none' | 'warn' (|d| > 3 %) | 'ack' (|d| > 20 %, a tick is required). */
export function divergenceLevel(d) {
  const v = Math.abs(Number(d));
  if (!Number.isFinite(v)) return 'none';
  return v > DIVERGE.ack ? 'ack' : v > DIVERGE.warn ? 'warn' : 'none';
}

/** Localised reason for a testnet refusal code (venue_reason / reason), with its variables from the quote. */
export function tnReasonText(reason, quote = null, coin = '') {
  if (!reason) return '';
  const q = quote || {};
  const vars = {
    coin: q.coin || coin,
    free: isNum(q.free_usd) ? usd(q.free_usd, 2) : '—',
    depth: isNum(q.depth_usd) ? usd(q.depth_usd, 0) : '—',
    // one decimal: "needs 10.4× but testnet allows 10×" (rounded, both read 10 and the refusal made no sense)
    need: isNum(q.need_leverage) ? Number(q.need_leverage).toFixed(1).replace(/\.0$/, '') : '—',
    max: isNum(q.max_leverage) ? Math.round(q.max_leverage) : '—',
    detail: q.reason_detail || q.detail || '—',
  };
  const key = 'g.plant.tnReason.' + reason;
  const s = t(key, vars);
  return s === key ? t('g.err.' + reason, vars) : s;
}

/**
 * The quote's stake-linear numbers at another stake (notional, margin, fees, slippage scale with the water).
 * Between quotes these carry ≈ (`est`); at the quoted stake they are the server's numbers.
 */
export function scaleQuote(quote, stake) {
  const q = quote || {};
  const base = n(q.capital_usd);
  const k = base && base > 0 ? Number(stake) / base : 1;
  const sc = (x) => (n(x) === null ? null : n(x) * k);
  return {
    est: !(base && Math.abs(Number(stake) - base) < 1e-9),
    notional: sc(q.notional_usd),
    margin: sc(q.margin_usd),
    fees: sc(q.fees_est_usd),
    slip: sc(q.slippage_max_usd),
    flattenSlip: sc(q.flatten_slippage_max_usd),
    size: sc(q.target_sz),
    liqMovePct: n(q.liq_move_pct),
    lev: n(q.leverage),
  };
}

// ------------------------------------------------------------------ the dialog

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('plantDialog')) return ctx.mods.plantDialog;
  const { store } = ctx;
  const A = getActions(ctx);
  let dlg = $('plantDlg');
  if (!dlg) {
    dlg = h('dialog', { id: 'plantDlg', class: 'dlg dlg--plant', 'aria-labelledby': 'plantTitle' });
    $('dialogs')?.append(dlg);
  }

  let bean = null;
  let slot = null; // the plot this planting goes to (shown as "Plants in plot N")
  let chosen = null; // the plot the player picked (dock card / pick mode), kept across store changes
  let opener = null;
  let since = null; // { side, ms, px } of the bean's open trade (bean_detail, lazily)
  let off = null;
  let timer = 0;
  let venue = 'paper';
  let quote = null; // the newest testnet_quote answer
  let quoteFor = null; // { bean, stake } it answered
  let quoteBusy = false;
  let lastQuoteAt = 0;
  let quoteTimer = 0;
  let quoteErr = null;
  let tried = false; // a plant was attempted in this dialog: the leverage-tick reason turns red only then

  // ------------------------------------------------------------------ static skeleton (built once)

  const title = h('h2', { id: 'plantTitle', class: 'dlg-title' });
  const xBtn = h('button', { type: 'button', class: 'icon-btn dlg-x' });
  const icoBox = h('span', { class: 'dlg-ico' });
  const beanLine = h('p', { class: 'pd-bean' });
  const paperLine = h('p', { class: 'pd-paper num' });
  // venue segmented control (accounts mode, testnet on)
  const vName = uid('pdVenue');
  const vPaper = h('input', { type: 'radio', name: vName, id: vName + 'P', value: 'paper', class: 'seg-input' });
  const vTest = h('input', { type: 'radio', name: vName, id: vName + 'T', value: 'testnet', class: 'seg-input' });
  const vLegend = h('legend', { class: 'set-label' });
  const vLabelP = h('label', { for: vName + 'P', class: 'seg-btn' });
  const vLabelT = h('label', { for: vName + 'T', class: 'seg-btn seg-btn--testnet' });
  const vReason = h('p', { class: 'pd-vreason', id: vName + 'Why', hidden: true });
  const vExplain = h('p', { class: 'pd-vexplain muted', hidden: true });
  const vConnect = h('button', { type: 'button', class: 'btn btn--sm btn--paper', hidden: true });
  // not enough free test USDC disables the Testnet option itself: the faucet truth must still be reachable (§9.7.2)
  const vFaucet = h('a', { class: 'pd-vfaucet', href: 'https://app.hyperliquid-testnet.xyz/drip', target: '_blank', rel: 'noopener noreferrer', hidden: true });
  const venueBox = h('fieldset', { class: 'pd-venue', hidden: true }, vLegend, h('div', { class: 'seg' }, vPaper, vLabelP, vTest, vLabelT), vReason, h('div', { class: 'pd-vmore' }, vExplain, vFaucet, vConnect));
  const pxK = h('dt');
  const pxV = h('dd', { class: 'num' });
  const tnK = h('dt');
  const tnV = h('dd', { class: 'num' });
  const tnRow = h('div', { class: 'kv kv--testnet', hidden: true }, tnK, tnV);
  const nowK = h('dt');
  const nowV = h('dd');
  const enter = h('p', { class: 'pd-enter' });
  const diverge = h('p', { class: 'pd-line pd-diverge', hidden: true });
  const ackBox = h('input', { type: 'checkbox', id: vName + 'Ack', class: 'check' });
  const ackRow = h('label', { class: 'f-check pd-ack', for: vName + 'Ack', hidden: true }, ackBox, h('span'));
  const waterLabelId = 'pdWaterLabel';
  const waterLabel = h('span', { id: waterLabelId, class: 'pd-water-label' });
  const num = h('input', { type: 'number', id: 'pdWaterNum', class: 'input input--num num', min: String(WATER.min), max: String(WATER.max), step: String(WATER.step), inputmode: 'numeric', 'aria-labelledby': waterLabelId });
  const range = h('input', { type: 'range', id: 'pdWaterRange', class: 'range', min: String(WATER.min), max: String(WATER.max), step: String(WATER.step), 'aria-labelledby': waterLabelId });
  const rMin = h('span', { class: 'pd-rmin num', text: usd(WATER.min, 0) });
  const rMax = h('span', { class: 'pd-rmax num', text: usd(WATER.max, 0) });
  const mirror = h('p', { class: 'pd-line num' });
  const tnSize = h('p', { class: 'pd-line num', hidden: true });
  const margin = h('p', { class: 'pd-line num' });
  const levNote = h('p', { class: 'pd-line pd-sub', hidden: true });
  const liq = h('p', { class: 'pd-line pd-warn num' });
  const worst = h('p', { class: 'pd-line pd-worst num' });
  const exceed = h('p', { class: 'pd-line pd-sub', hidden: true });
  const fees = h('p', { class: 'pd-line num' });
  const slip = h('p', { class: 'pd-line num', hidden: true });
  const funding = h('p', { class: 'pd-line pd-sub num' });
  const room = h('p', { class: 'pd-line num' });
  const faucet = h('p', { class: 'pd-line pd-sub', hidden: true }, h('a', { href: 'https://app.hyperliquid-testnet.xyz/drip', target: '_blank', rel: 'noopener noreferrer' }));
  const slotLine = h('p', { class: 'pd-line pd-slot' });
  const levCheck = h('input', { type: 'checkbox', id: 'pdLevCheck', class: 'check' });
  const levRow = h('label', { class: 'f-check pd-levcheck', for: 'pdLevCheck', hidden: true }, levCheck, h('span'));
  const block = h('p', { class: 'pd-block', id: 'pdBlock', tabindex: '-1', hidden: true });
  const cancel = h('button', { type: 'button', class: 'btn btn--paper' });
  const go = h('button', { type: 'submit', class: 'btn btn--wood btn--go' });
  const paperNote = h('p', { class: 'dlg-paper' });
  const err = h('div', { class: 'dlg-error', role: 'alert', tabindex: '-1', hidden: true });
  const badge = h('span', { class: 'pd-vbadge' });
  const form = h(
    'form',
    { class: 'dlg-card', method: 'dialog', novalidate: true },
    h('header', { class: 'dlg-head' }, icoBox, title, badge, xBtn),
    beanLine,
    paperLine,
    venueBox,
    h('dl', { class: 'pd-kv' }, h('div', { class: 'kv' }, pxK, pxV), tnRow, h('div', { class: 'kv' }, nowK, nowV)),
    enter,
    diverge,
    ackRow,
    h('div', { class: 'pd-water' }, h('div', { class: 'pd-water-top' }, waterLabel, h('span', { class: 'pd-num' }, h('span', { 'aria-hidden': 'true', text: '$' }), num)), range, h('div', { class: 'pd-range-ends' }, rMin, rMax)),
    h('div', { class: 'pd-math' }, mirror, tnSize, margin, levNote, liq, worst, exceed, fees, slip, funding, room, faucet, slotLine),
    levRow,
    block,
    err,
    h('div', { class: 'dlg-actions' }, cancel, go),
    paperNote,
  );
  dlg.replaceChildren(form);

  // ------------------------------------------------------------------ wiring

  const maxStake = () => (venue === 'testnet' ? Math.max(WATER.min, tnStakeMax(quote, D.tnVenue(store.get())?.caps)) : WATER.max);
  const stake = () => {
    const v = Math.round(Number(range.value) / WATER.step) * WATER.step;
    return Math.min(maxStake(), Math.max(WATER.min, Number.isFinite(v) ? v : WATER.def));
  };
  const onWater = () => {
    renderMath();
    if (venue === 'testnet') scheduleQuote(QUOTE_MIN_MS); // 300 ms after the slider settles (§9.4)
  };
  range.addEventListener('input', () => {
    num.value = String(stake());
    onWater();
  });
  num.addEventListener('input', () => {
    const v = Number(num.value);
    if (Number.isFinite(v)) range.value = String(Math.min(maxStake(), Math.max(WATER.min, v)));
    onWater();
  });
  num.addEventListener('change', () => {
    num.value = String(stake());
    onWater();
  });
  levCheck.addEventListener('change', renderMath);
  ackBox.addEventListener('change', renderMath);
  for (const r of [vPaper, vTest]) r.addEventListener('change', () => r.checked && setVenue(r.value));
  vConnect.addEventListener('click', () => ctx.mods.testnet?.open?.({ opener: vConnect }));
  cancel.addEventListener('click', () => close());
  xBtn.addEventListener('click', () => close());
  dlg.addEventListener('keydown', (e) => trapTab(dlg, e));
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (!isBusy(go)) close();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  function setVenue(v) {
    if (v === 'testnet') {
      const vs = tnVenueState(store.get(), quote);
      if (vs.ok === false) {
        vPaper.checked = true;
        return renderVenue();
      }
    }
    venue = v === 'testnet' ? 'testnet' : 'paper';
    vPaper.checked = venue === 'paper';
    vTest.checked = venue === 'testnet';
    ackBox.checked = false;
    if (venue === 'testnet') {
      // clamp the water into the testnet range at once (§9.4), then ask for a fresh quote
      const w = clampTnStake(stake(), quote, D.tnVenue(store.get())?.caps);
      range.value = String(w);
      num.value = String(w);
      askQuote();
    }
    syncRange();
    renderLive();
  }

  function syncRange() {
    const max = maxStake();
    range.max = String(max);
    num.max = String(max);
    setText(rMax, usd(max, 0));
    const w = stake();
    if (Number(range.value) !== w) range.value = String(w);
    if (Number(num.value) > max) num.value = String(w);
  }

  // ------------------------------------------------------------------ testnet_quote (cache-only on the server)

  function testnetPossible() {
    const s = store.get();
    return D.isAccounts(s) && D.testnetEnabled(s) && !!D.userOf(s);
  }
  function scheduleQuote(delay) {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(askQuote, Math.max(0, delay));
  }
  async function askQuote() {
    if (!bean || !testnetPossible()) return null;
    const since = Date.now() - lastQuoteAt;
    if (since < QUOTE_MIN_MS) {
      scheduleQuote(QUOTE_MIN_MS - since); // never more than one quote per 300 ms
      return null;
    }
    if (quoteBusy) {
      scheduleQuote(QUOTE_MIN_MS);
      return null;
    }
    const b = bean;
    const w = venue === 'testnet' ? stake() : WATER.def;
    quoteBusy = true;
    lastQuoteAt = Date.now();
    try {
      const q = await (ctx.api?.query || api.query)('testnet_quote', { bean: Number(b.id), capital_usd: w });
      if (!bean || Number(bean.id) !== Number(b.id)) return null;
      quote = q && typeof q === 'object' ? { ...q, capital_usd: q.capital_usd ?? w } : null;
      quoteFor = { bean: b.id, stake: w };
      quoteErr = null;
    } catch (e) {
      quoteErr = e;
    } finally {
      quoteBusy = false;
    }
    if (bean) {
      syncRange();
      renderLive();
    }
    return quote;
  }

  // ------------------------------------------------------------------ open / close

  function open(b, s = null, o = {}) {
    if (!b) return;
    bean = { ...b };
    const st = store.get();
    chosen = Number.isInteger(s) ? s : null;
    slot = D.freeSlotOf(st, chosen, bean.id);
    opener = o.opener || document.activeElement;
    since = null;
    venue = 'paper';
    quote = null;
    quoteFor = null;
    quoteErr = null;
    vPaper.checked = true;
    vTest.checked = false;
    range.value = String(WATER.def);
    num.value = String(WATER.def);
    levCheck.checked = false;
    tried = false;
    ackBox.checked = false;
    showErr(err, null);
    setBusy(go, false);
    icoBox.replaceChildren(cropIcon(bean.coin));
    syncRange();
    renderStatic();
    renderLive();
    if (!dlg.open) {
      try {
        dlg.showModal();
      } catch {
        dlg.setAttribute('open', '');
      }
    }
    nextFrame(() => range.focus());
    off?.();
    off = watch(store, (x) => [x.marks?.t, x.market, x.live, x.feed, x.net?.ok, x.bots, x.slots, x.testnet, x.venues], renderLive, arrEq);
    clearInterval(timer);
    timer = setInterval(renderLive, 1000);
    loadSince(bean);
    // the Testnet option's enable rule needs venue_ok: one quote when the dialog opens (§9.4)
    if (testnetPossible() && D.tnConnected(st)) {
      lastQuoteAt = 0;
      askQuote();
    }
  }

  function close({ planted = false, plantedSlot = null } = {}) {
    off?.();
    off = null;
    clearInterval(timer);
    clearTimeout(quoteTimer);
    if (dlg.open) dlg.close();
    const s = Number.isInteger(plantedSlot) ? plantedSlot : slot;
    chosen = null;
    bean = null;
    quote = null;
    // after a plant, keyboard users land on their new plot in the dock
    const card = planted && Number.isInteger(s) ? ctx.mods.dock?.cardFor?.(s) : null;
    const back = card || (opener && opener.isConnected ? opener : $('stage'));
    back?.focus?.({ preventScroll: true });
    opener = null;
  }

  async function loadSince(b) {
    const side = Math.sign(Number(b.side) || 0);
    if (!side) return;
    try {
      const d = await api.query('bean_detail', { id: b.id });
      if (!bean || Number(bean.id) !== Number(b.id)) return;
      const trades = Array.isArray(d?.trades) ? d.trades : [];
      const lastOpen = [...trades].reverse().find((x) => x && x.action === 'open');
      if (lastOpen) since = { ms: Number(lastOpen.time_ms), px: Number(lastOpen.px) };
      if (d?.bean) bean = { ...bean, ...d.bean };
      renderStatic();
      renderLive();
    } catch {
      /* the line simply shows no time */
    }
  }

  // ------------------------------------------------------------------ render

  /**
   * The leverage this plant will really use: on testnet the quote's (min(bean, testnet maxLeverage)), which can be
   * lower than the mainnet venue's; otherwise the paper rule. The header, the capped note and the high-leverage tick
   * box all use it, so the dialog never states two different leverages.
   */
  function plantLev() {
    if (venue === 'testnet' && isNum(quote?.leverage)) return Number(quote.leverage);
    return plantQuote(bean, WATER.def, null).lev;
  }

  function renderLev() {
    const lev = plantLev();
    setText(beanLine, t('g.plant.bean', { id: bean.id, archetype: bean.archetype, strategy: bean.strategy, lev: Math.round(lev) }));
    setText(levRow.lastChild, t('g.plant.highLev', { lev: Math.round(lev) }));
    levRow.hidden = lev < HIGH_LEV;
  }

  function renderStatic() {
    if (!bean) return;
    setText(title, t('g.plant.title', { coin: bean.coin, crop: cropName(bean.coin) }));
    setAttr(xBtn, 'aria-label', t('g.btn.close'));
    setText(xBtn, '✕');
    renderLev();
    setText(nowK, t('g.plant.beanNow'));
    setText(waterLabel, t('modal.water'));
    setText(cancel, t('g.ask.cancel'));
    setText(vLegend, t('g.plant.venue'));
    setText(vLabelP, t('g.plant.venuePaper'));
    setText(vLabelT, t('g.plant.venueTestnet'));
    // the long venue words as the segments' tooltips (§9.7.1 g.venue.paperLong / testnetLong)
    setAttr(vLabelP, 'title', t('g.venue.paperLong'));
    setAttr(vLabelT, 'title', t('g.venue.testnetLong'));
    setText(ackRow.lastChild, t('g.plant.tnDivergeAck'));
    setText(vConnect, t('g.plant.tnConnect'));
    setText(faucet.firstChild, t('g.plant.tnFaucet'));
    setText(vFaucet, t('g.plant.tnFaucet'));
  }

  /** The venue control: visible in accounts mode with the testnet on; the Testnet option's enable state + reason. */
  function renderVenue() {
    const st = store.get();
    venueBox.hidden = !testnetPossible();
    const tn = venue === 'testnet';
    badge.replaceChildren(D.isAccounts(st) ? venueBadge(venue) : '');
    if (venueBox.hidden) return;
    const vs = tnVenueState(st, quote);
    vTest.disabled = vs.ok === false;
    vLabelT.classList.toggle('is-disabled', vs.ok === false);
    const why = vs.ok === false ? tnReasonText(vs.reason, quote, bean?.coin) : vs.ok === null && quoteBusy ? t('g.plant.tnQuoting') : '';
    vReason.hidden = !why;
    setText(vReason, why);
    setAttr(vTest, 'aria-describedby', why ? vReason.id : null);
    const explain = vs.ok === false && (vs.reason === 'not_connected' || vs.reason === 'credential_revoked');
    // too little free test USDC: the /drip link and the mainnet-deposit rule, right under the reason (QA-18)
    const poor = vs.ok === false && vs.reason === 'insufficient_testnet_balance';
    vExplain.hidden = !(explain && vs.reason === 'not_connected') && !poor;
    setText(vExplain, t('g.plant.tnExplain'));
    vFaucet.hidden = !poor;
    vConnect.hidden = !explain;
    // a testnet selection that became impossible (kill switch, revoked…) falls back to paper, visibly
    if (tn && vs.ok === false) {
      venue = 'paper';
      vPaper.checked = true;
      syncRange();
    }
  }

  function renderLive() {
    if (!bean) return;
    renderVenue();
    renderLev();
    const st = store.get();
    const sim = D.isSim(st);
    const tn = venue === 'testnet';
    const coinRow = D.coinOf(st, bean.coin) || {};
    const szd = coinRow.sz_decimals;
    const p = D.priceOf(st, bean.coin);
    const nowMs = D.nowOf(st);
    setText(pxK, t(sim ? 'g.plant.priceSim' : 'g.plant.price'));
    const age = ageLabel(p.ms, nowMs);
    pxV.replaceChildren(
      h('b', { class: 'num', text: p.px === null ? t('g.plant.noPrice') : fmtPx(p.px, szd) }),
      ' ',
      h('span', { class: `age age--${p.stale ? 'delayed' : age.kind}`, text: `(${sim ? t('g.src.sim') : t('g.src.hl')} · ${p.stale ? t('g.state.frozen') : age.text})` }),
    );
    // testnet: the testnet mid with its own age and source (every testnet price says "testnet", J9)
    tnRow.hidden = !tn;
    if (tn) {
      const tq = D.tnPriceOf(st, bean.coin);
      const px = n(quote?.testnet_mid) ?? tq.px;
      const ms = n(quote?.testnet_mid_ms) ?? tq.ms;
      const tAge = ageLabel(ms, nowMs);
      setText(tnK, t('g.insp.tnMid'));
      tnV.replaceChildren(
        h('span', { class: 'num', text: t('g.plant.tnPrice', { px: px === null ? '—' : fmtPx(px, quote?.sz_decimals ?? szd), age: `${t('g.src.hlTestnet')} · ${tAge.text}`, real: p.px === null ? '—' : fmtPx(p.px, szd) }) }),
      );
      tnV.dataset.age = tAge.kind;
    }
    const side = Math.sign(Number(bean.side) || 0);
    if (side) {
      const sideTxt = t(side > 0 ? 'g.side.long' : 'g.side.short');
      setText(nowV, since ? t('g.plant.since', { side: sideTxt, time: hhmm(since.ms), px: fmtPx(bean.entry_px ?? since.px, szd) }) : `${sideTxt} @ ${fmtPx(bean.entry_px, szd)}`);
      nowV.dataset.side = side > 0 ? 'long' : 'short';
      setText(enter, '→ ' + t('g.plant.enterNow', { px: fmtPx(tn ? n(quote?.testnet_mid) ?? p.px : p.px, szd) }));
    } else {
      setText(nowV, t('g.side.flat'));
      nowV.dataset.side = 'flat';
      setText(enter, '→ ' + t('g.plant.enterLater'));
    }
    // the bean's record is at REAL prices; on testnet that is said next to it (U14)
    setText(paperLine, t('g.plant.paper', { ret: pct(bean.total_return, 1), r7: pct(bean.ret_7d, 1), dd: isNum(bean.max_dd) ? (Math.abs(bean.max_dd) * 100).toFixed(1) + '%' : '—', wr: isNum(bean.win_rate) ? Math.round(bean.win_rate * 100) + '%' : '—', n: fmt(bean.trades) }) + (tn ? ` · ${t('g.plant.beanRealPrices')}` : ''));
    // divergence (§9.4): amber > 3 %, a required tick > 20 % — a fact, never a nudge (J12)
    const lvl = tn ? divergenceLevel(quote?.divergence) : 'none';
    diverge.hidden = lvl === 'none';
    if (lvl !== 'none') setText(diverge, t('g.plant.tnDiverge', { pct: (Math.abs(Number(quote.divergence)) * 100).toFixed(1) + '%' }));
    ackRow.hidden = lvl !== 'ack';
    setText(paperNote, tn ? t('g.plant.tnFill') : t('g.plant.paperNote', { source: t(sim ? 'g.src.sim' : 'g.src.real') }));
    paperNote.classList.toggle('dlg-paper--testnet', tn);
    renderMath();
  }

  function renderMath() {
    if (!bean) return;
    const st = store.get();
    const w = stake();
    const tn = venue === 'testnet';
    range.setAttribute('aria-valuetext', usd(w, 0));
    tnSize.hidden = !tn;
    slip.hidden = !tn;
    faucet.hidden = true;
    let text = '';
    if (tn) text = renderTestnetMath(st, w);
    else text = renderPaperMath(st, w);
    // never move the target while the plant is in flight (data.command reserves it in slots.wanted), and do
    // not count this bean's own reservation as taken: the plot stays the one the player chose
    if (!isBusy(go)) slot = D.freeSlotOf(st, chosen ?? slot, bean.id);
    setText(slotLine, slot === null ? t('g.plant.noSlot') : t('g.plant.slot', { n: plotNo(slot) }));
    if (!text && slot === null) text = t('g.plant.noSlot');
    block.hidden = !text;
    // the leverage tick is a step, not an error: neutral until the player tries to plant without it (§6.7 J12)
    block.classList.toggle('pd-block--hint', !tried && text === t('g.plant.levBlock'));
    setText(block, text);
    setBlocked(go, !!text);
    if (!isBusy(go)) setText(go, tn ? t('g.plant.submitTestnet', { usd: usd(w, 0) }) : t('g.plant.go', { usd: usd(w, 0) }));
    setAttr(go, 'aria-describedby', text ? 'pdBlock' : null);
    go.classList.toggle('btn--testnet', tn);
  }

  /** Paper lines (unchanged) → the red block text or ''. */
  function renderPaperMath(st, w) {
    // a positioned bean is mirrored right away from its units at the live price: the money lines are for THAT
    // position (q.basis 'now'); the per-entry size of later entries is shown alongside
    const q = plantQuote(bean, w, st.live, D.priceOf(st, bean.coin).px);
    const nn = mirrorNote(bean, w);
    setText(mirror, q.basis === 'now'
      ? t('g.plant.notionalNow', { pct: nn.pct.toFixed(1), usd: usd(q.notional, 0), entry: usd(q.perEntry, 0) })
      : t('modal.note', { pct: nn.pct.toFixed(1), usd: usd(nn.notional, 0) }));
    setText(margin, t('g.plant.margin', { usd: usd(q.margin, 2), lev: Math.round(q.lev) }));
    const capped = isNum(bean.venue_max_leverage) && Number(bean.leverage) > Number(bean.venue_max_leverage);
    levNote.hidden = !capped;
    if (capped) setText(levNote, t('g.lev.capped', { n: Math.round(q.lev), bean: Math.round(bean.leverage), max: Math.round(bean.venue_max_leverage) }));
    setText(liq, t('g.plant.liq', { pct: (q.liqMovePct * 100).toFixed(1) + '%' }));
    setText(worst, t('g.plant.worst', { usd: usd(q.worst, 2) }));
    exceed.hidden = !q.exceedsWater;
    if (q.exceedsWater) setText(exceed, t('modal.margin', { usd: usd(q.margin, 0) }));
    setText(fees, t('g.plant.fees', { usd: usd(q.fees, 2) }));
    const coinRow = D.coinOf(st, bean.coin) || {};
    funding.hidden = D.isSim(st) || !isNum(coinRow.funding_1h);
    if (!funding.hidden) setText(funding, t('g.plant.funding', { rate: fundingText(coinRow.funding_1h) }));
    const cash = Number(st.live?.available_usd);
    const parts = [];
    if (q.room) parts.push(t('modal.maxStake', { usd: usd(q.room.maxStake, 0) }));
    if (Number.isFinite(cash)) parts.push(t('g.plant.cash', { usd: usd(cash, 2) }));
    setText(room, parts.join(' · '));
    room.hidden = !parts.length;
    // the reason planting is refused right now (red), in the order of §6.5
    const why = D.plantBlock(st, bean, w);
    let text = why ? t(why.key, why.vars) : '';
    if (!text && q.lev >= HIGH_LEV && !levCheck.checked) text = t('g.plant.levBlock');
    return text;
  }

  /** Testnet lines from testnet_quote (server numbers; ≈ between quotes) → the red block text or ''. */
  function renderTestnetMath(st, w) {
    const q = quote;
    if (!q) {
      for (const el of [mirror, margin, liq, worst, fees, slip, funding, room, tnSize]) setText(el, '');
      setText(mirror, quoteErr ? t('g.plant.tnNoQuote') : t('g.plant.tnQuoting'));
      levNote.hidden = true;
      exceed.hidden = true;
      return quoteErr ? t('g.plant.tnNoQuote') : t('g.plant.tnQuoting');
    }
    // between quotes the numbers are the quote scaled to the water: every money line below already reads "≈"
    const sc = scaleQuote(q, w);
    const ap = (s) => s;
    const coinRow = D.tnCoin(st, bean.coin) || {};
    const szd = q.sz_decimals ?? coinRow.sz_decimals ?? 0;
    setText(mirror, ap(t('g.plant.tnNotional', { usd: usd(sc.notional, 0) })));
    // the size unsigned with its side word, as everywhere else (never "≈ -0.4613 ETH")
    const sideWord = isNum(sc.size) && Number(sc.size) !== 0 ? ' ' + t(Number(sc.size) > 0 ? 'g.side.long' : 'g.side.short') : '';
    setText(tnSize, `${t('g.plant.tnSize', { sz: isNum(sc.size) ? Math.abs(Number(sc.size)).toFixed(Math.max(0, Number(szd) || 0)) : '—', coin: bean.coin + sideWord })} · ${t('g.plant.tnK', { k: isNum(q.k) ? Number(q.k).toFixed(3) : '—' })}`);
    setText(margin, ap(t('g.plant.margin', { usd: usd(sc.margin, 2), lev: isNum(sc.lev) ? Math.round(sc.lev) : '—' })));
    // the testnet listing may allow less leverage than the bean (and the mainnet venue): say so, as paper does
    const beanLev = Number(bean.leverage);
    const tnCapped = isNum(sc.lev) && Number.isFinite(beanLev) && beanLev > Number(sc.lev) + 1e-9;
    levNote.hidden = !tnCapped;
    if (tnCapped) setText(levNote, t('g.lev.capped', { n: Math.round(sc.lev), bean: Math.round(beanLev), max: Math.round(sc.lev) }));
    setText(liq, t('g.plant.liq', { pct: isNum(sc.liqMovePct) ? (Number(sc.liqMovePct) * (Number(sc.liqMovePct) <= 1 ? 100 : 1)).toFixed(1) + '%' : '—' }));
    setText(worst, t('g.plant.worst', { usd: usd(sc.margin, 2) }));
    exceed.hidden = true;
    setText(fees, ap(t('g.plant.fees', { usd: usd(sc.fees, 2) })));
    setText(slip, t('g.plant.tnSlip', { usd: usd(sc.slip, 2) }));
    const rate = n(q.funding_1h) ?? n(coinRow.funding_1h);
    funding.hidden = rate === null;
    if (rate !== null) setText(funding, t('g.funding.testnet', { rate: fundingText(rate) }));
    const parts = [];
    // the testnet water ceiling actually in force: min(500, cap, room, 0.9 × free) — the slider's own max (§9.4)
    parts.push(t('modal.maxStake', { usd: usd(tnStakeMax(q, D.tnVenue(st)?.caps), 0) }));
    if (isNum(q.free_usd)) parts.push(t('g.plant.tnFree', { usd: usd(q.free_usd, 2) }));
    setText(room, parts.join(' · '));
    room.hidden = !parts.length;
    // the stake-independent reasons disable the option itself; the stake-dependent ones are this red line
    const vs = tnVenueState(st, q);
    if (vs.ok === false) return tnReasonText(vs.reason, q, bean.coin);
    if (D.isSpectator(st) || D.isOffline(st)) return t(D.isSpectator(st) ? 'g.gate.signInToPlant' : 'g.plant.offBlock');
    if (D.plantedSlotOfCoin(st, bean.coin) !== null) return t('packet.alreadyPlanted', { coin: bean.coin });
    // the quote cannot know about the tick box: its divergence_ack refusal is answered by ticking it (sent as
    // ack_divergence with the plant), so only the other stake-dependent refusals block here
    if (!q.ok && q.reason && !(q.reason === 'divergence_ack' && ackBox.checked)) {
      faucet.hidden = q.reason !== 'insufficient_testnet_balance';
      return tnReasonText(q.reason, q, bean.coin);
    }
    if (q.book_ok === false) return tnReasonText('thin_book', q, bean.coin);
    if (w > tnStakeMax(q, D.tnVenue(st)?.caps)) return tnReasonText('insufficient_testnet_balance', q, bean.coin);
    if (divergenceLevel(q.divergence) === 'ack' && !ackBox.checked) return t('g.err.divergence_ack');
    if (isNum(sc.lev) && sc.lev >= HIGH_LEV && !levCheck.checked) return t('g.plant.levBlock');
    return '';
  }

  async function submit() {
    if (!bean || isBusy(go)) return;
    tried = true;
    const tn = venue === 'testnet';
    if (tn) {
      // a fresh quote at submit (§9.4); a refusal it brings shows as the red line instead of a request
      lastQuoteAt = Math.min(lastQuoteAt, Date.now() - QUOTE_MIN_MS);
      setBusy(go, true);
      setText(go, t('g.plant.tnQuoting'));
      await askQuote();
      setBusy(go, false);
      if (!bean) return;
    }
    renderMath();
    if (go.dataset.blocked === '1') {
      block.focus?.();
      if (!levRow.hidden && !levCheck.checked) levCheck.focus();
      else if (!ackRow.hidden && !ackBox.checked) ackBox.focus();
      return;
    }
    const w = stake();
    const b = bean;
    const s = slot;
    setBusy(go, true);
    go.classList.add('is-pending');
    setText(go, t(tn ? 'g.insp.syncPending' : 'modal.planting'));
    showErr(err, null);
    const out = await A.plant(b, w, s, { venue, ackDivergence: tn && ackBox.checked });
    setBusy(go, false);
    go.classList.remove('is-pending');
    if (!bean) return; // closed meanwhile
    if (out?.error) {
      renderMath();
      showErr(err, A.failInfo(out));
      err.focus({ preventScroll: true });
      if (tn) askQuote();
      return;
    }
    // focus lands on the plot the bot actually went to (the server answer pins it in slots.map)
    const placed = out && out.id !== undefined ? store.get().slots?.map?.[out.id] : null;
    close({ planted: true, plantedSlot: Number.isInteger(placed) ? placed : s });
  }

  onLangChange(() => {
    if (!bean) return;
    renderStatic();
    renderLive();
  });

  const apiOut = { open, close: () => close(), isOpen: () => !!bean && dlg.open, venue: () => venue };
  ctx.mods.plantDialog = apiOut;
  return apiOut;
}

function arrEq(a, b) {
  return !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

/**
 * ui/inspector.js — the plot inspector (GAME-DESIGN §6.6; desktop right panel 380 px, phone bottom sheet).
 *
 *   Plot 01 · BTC orange tree · bot-0003                                         ⌖ ✕
 *   [LONG ↑]  10× (bean 10×, venue max 40×)   hyper_algo · momentum
 *   Mark price $82,980.5 · Hyperliquid · 3 s ago      Entry price $82,410.0
 *   Size 0.00500 BTC ≈ $414.90 notional               Margin used $44.06
 *   Liquidation $74,581.1 [▓▓▓▓] price must fall 10.1% to liquidate
 *   Water $100.00 · Unrealized +$2.85 ▲ · Realized +$0.25 ▲ · Fees paid $0.37
 *   Total P&L +$3.10 ▲ (+3.1% of water)
 *   Growth: size 0.54 · health 1.00 · fruit 1 · flower ✓ — the plant is drawn from these numbers
 *   Funding … info only · last fills · price since you opened this page (from mids) · the bean
 *   [⛱ Shade (pause & close position)] [🧺 Harvest +$3.10]  (loss: 🪓 Pull (−$8.10), red outline; paused: ☀ Sun)
 *
 * Every number is the store's (J1) with its age; "≈" marks client estimates. Growth figures are stage() of the
 * merged bot, exactly what the 3D plant is drawn from. last_error text goes into an error box (textContent).
 * Opens when store.ui.selectedSlot is set (dock, 3D tap, list view); ✕ / Esc clears the selection.
 *
 * Venues (PLATFORM §9.4, §9.6): the title carries PAPER / TESTNET (accounts mode). A testnet bot reads
 * "Testnet mid · Hyperliquid TESTNET" (never the mainnet source), shows the exchange's own numbers with their
 * age, its funding as its own line (part of Total P&L), ×k sizing, "≈ (confirming)" fees, the fill state
 * (partial / unfilled / waiting), sync pending / failed, the drift card, dust, and — while closing — the closing
 * line INSTEAD of the actions (a second bot_close is never sent). Its footer is g.venue.testnetLong.
 * After a close (QA-04) the panel turns into the empty-plot card "Plot N is empty. Last crop: COIN result" (≈
 * until the exchange confirms) with Plant here; a bot opened without a plot says so instead of "Plot —".
 *
 * Exports: mount(deps) → { open(o), openBot(botId), close(), current() }.  No three.js, no side effects at import.
 */

import * as api from '../../brood-api.js';
import { t, onLangChange } from '../../i18n.js';
import { usd, isNum } from '../../format.js';
import { fmtPx, fmtSz, dirKey } from '../../model.js';
import { getCtx, on } from './context.js';
import { h, setText, cropIcon, cropName, money, ageLabel, plotNo, setBusy, isBusy, setBlocked, isBlocked, watch, hhmm, icon, isPhone, setVenueBadge, countdown, showErr } from './util.js';
import { getSheets } from './sheets.js';
import { getActions } from './actions.js';
import { fundingText } from './board.js';
import { signedPct, liqText, stateText, liqSegments, pnlText, noteVarsOf } from './plotText.js';
import { codeText } from './diary.js';
import * as D from './derive.js';
import { announce } from './a11y.js';

const FILLS_SHOWN = 6;

/** "retrying." → "retrying" (a localised reason inside a sentence that adds its own full stop). */
export const noDot = (s) => String(s ?? '').replace(/[.。]+\s*$/, '');

/** Leave no "{placeholder}" visible when a server event did not carry a variable (never invented: a dash). */
const dashMissing = (s) => String(s).replace(/\{\w+\}/g, '—');

/**
 * Pure (PLATFORM §9.5, §12.4): the inspector's error box for a view with `error` (the BotRow's last_error).
 * The localised line comes from a machine code — the failed exchange sync's code on a testnet bot, else the code of
 * the newest `live_error` event whose text is this error — and the server's own text is only the collapsible detail.
 * Accounts mode never shows that English text as the main line (g.err.unknown); none mode keeps today's text.
 *   lastEvent: { code, vars, error } of the newest live_error for this bot (or null).
 * → null | { text, detail }
 */
export function botErrorInfo(v, { accounts = false, lastEvent = null } = {}) {
  if (!v || !v.error) return null;
  const raw = String(v.error).slice(0, 400);
  let code = null;
  let vars = {};
  if (v.venue === 'testnet' && v.sync?.state === 'failed' && typeof v.sync.code === 'string') code = v.sync.code;
  else if (lastEvent && typeof lastEvent.code === 'string' && lastEvent.error === v.error) {
    code = lastEvent.code;
    vars = lastEvent.vars && typeof lastEvent.vars === 'object' ? lastEvent.vars : {};
  } else if (typeof v.errorCode === 'string') {
    // after a reload there is no live_error event: the BotRow's own last_error_code (accounts mode)
    code = v.errorCode;
    vars = v.errorVars && typeof v.errorVars === 'object' ? v.errorVars : {};
  }
  // `conflict` is the server's catch-all for paper situations without a code: no better than the generic line
  if (code && code !== 'conflict') {
    const text = codeText(code, { coin: v.coin, ...vars }, '');
    if (text && text !== code) return { text: dashMissing(v.venue === 'testnet' ? t('g.insp.syncFailed', { reason: noDot(text) }) : text), detail: raw };
  }
  return accounts ? { text: t('g.err.unknown'), detail: raw } : { text: raw, detail: '' };
}

/** Pure: an SVG polyline "points" string for a price series (neutral ink; direction is not money, J6). */
export function sparkPoints(series, w = 240, hgt = 36, pad = 2) {
  const v = (series || []).map((p) => (Array.isArray(p) ? Number(p[1]) : Number(p?.px ?? p))).filter(Number.isFinite);
  if (v.length < 2) return '';
  let lo = Math.min(...v);
  let hi = Math.max(...v);
  if (hi - lo < 1e-12) {
    hi += 1;
    lo -= 1;
  }
  return v.map((x, i) => `${(pad + (i / (v.length - 1)) * (w - 2 * pad)).toFixed(1)},${(hgt - pad - ((x - lo) / (hi - lo)) * (hgt - 2 * pad)).toFixed(1)}`).join(' ');
}

/**
 * Pure (QA-04): the empty-plot card after a bot closed. `last` = { coin, realized, confirmed, venue } of the last
 * crop (or null), `n` the plot label ("04") or null when the bot had no drawn plot.
 * → { key, vars, tone } — the text has the coin and the harvested / pulled amount with sign, glyph and colour,
 *   "≈" while a testnet close is unconfirmed. Never a blank panel, never "Plot —".
 */
export function afterCard(last, n, { halted = false, haltedKey = 'plot.emptyHalted' } = {}) {
  if (!last || !last.coin) {
    if (halted) return { key: haltedKey, vars: {}, tone: 'none' };
    return { key: n === null ? 'g.insp.gone' : 'g.insp.empty', vars: { n: n ?? '—' }, tone: 'none' };
  }
  const r = Number(last.realized);
  const est = last.venue === 'testnet' && last.confirmed === false;
  const m = money(Number.isFinite(r) ? r : null, { est });
  const result = Number.isFinite(r) ? t(r < 0 ? 'g.insp.resultPull' : r > 0 ? 'g.insp.resultHarvest' : 'g.insp.resultFlat', { usd: m.text }) : '—';
  return { key: n === null ? 'g.insp.emptyAfterNoPlot' : 'g.insp.emptyAfter', vars: { n: n ?? '—', coin: last.coin, result }, tone: m.tone };
}

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('inspector')) return ctx.mods.inspector;
  const { store } = ctx;
  const A = getActions(ctx);
  const sheets = getSheets(ctx);
  const p = sheets.panel('inspector', { side: 'right', snap: 60 });
  let cur = { slot: null, botId: null, lastBotId: null }; // what is shown
  let detailFor = null;

  // header tools: venue badge (accounts mode) · ⌖ focus
  const vBadge = h('span', { class: 'vbadge vbadge--paper insp-venue', hidden: true });
  const focusBtn = h('button', { type: 'button', class: 'icon-btn insp-focus' }, icon('i-focus'));
  p.tools.append(vBadge, focusBtn);
  // the last crop of each plot / bot, for the after-harvest card (QA-04): botId → { coin, realized, confirmed, venue, slot }
  const lastCrops = new Map();
  // botId → { code, vars, error } of its newest live_error (the error box is localised by the code)
  const lastErrors = new Map();
  focusBtn.addEventListener('click', () => {
    if (Number.isInteger(cur.slot)) A.focusPlot(cur.slot);
  });

  const root = h('div', { class: 'insp' });
  p.body.append(root);

  // ------------------------------------------------------------------ data

  function viewNow() {
    const s = store.get();
    if (cur.botId && !Number.isInteger(cur.slot)) return D.viewOfBot(s, cur.botId);
    if (!Number.isInteger(cur.slot)) return null;
    return D.viewsOf(s).bySlot[cur.slot] || null;
  }

  async function loadDetail(botId) {
    if (!botId) return;
    try {
      if (typeof ctx.data?.loadDetail === 'function') {
        await ctx.data.loadDetail(botId);
        return;
      }
      const d = await api.query('bot_detail', { id: botId });
      const s = store.get();
      store.set({ detail: { ...(s.detail || {}), [botId]: { ...d, fetchedMs: Date.now() } } });
    } catch {
      /* fills simply stay empty */
    }
  }

  // ------------------------------------------------------------------ render (persistent nodes, updated in place)
  //
  // The inspector re-renders on every mark (~5 s). Its nodes are built once and only their text changes, so
  // keyboard focus and screen-reader position survive updates (and numbers change at t = 0, J2).

  const span = (cls = '') => h('span', { class: cls });
  const kv = (cls = '') => {
    const k = h('dt');
    const v = h('dd');
    return { row: h('div', { class: 'kv' + (cls ? ' ' + cls : '') }, k, v), k, v };
  };
  const setMoneyEl = (el, x, opts = {}) => {
    const m = money(x, opts);
    setText(el, m.text);
    el.className = `money money--${m.tone} num`;
  };

  const N = {};
  N.crop = h('span', { class: 'insp-crop' });
  N.side = h('span', { class: 'pill pill--lg' });
  N.lev = h('span', { class: 'insp-lev num' });
  N.variety = h('span', { class: 'insp-var' });
  N.sideHelp = h('p', { class: 'insp-sidehelp' });
  N.state = h('p', { class: 'insp-state' });
  N.mark = kv();
  N.markV = span('num insp-big');
  N.markAge = span('age');
  N.mark.v.append(N.markV, ' ', N.markAge);
  N.entry = kv();
  N.entryV = span('num');
  N.entry.v.append(N.entryV);
  N.size = kv();
  N.sizeV = span('num');
  N.notional = span('muted num');
  N.size.v.append(N.sizeV, ' ', N.notional);
  N.margin = kv();
  N.marginV = span('num');
  N.margin.v.append(N.marginV);
  N.liq = kv('kv--liq');
  N.liqV = span('num');
  N.liqBar = h('span', { class: 'liqbar liqbar--lg', role: 'img' }, h('i'), h('i'), h('i'), h('i'));
  N.liqText = span('insp-liqtext');
  N.liq.v.append(N.liqV, ' ', N.liqBar, ' ', N.liqText);
  N.water = kv();
  N.waterV = span('num');
  N.water.v.append(N.waterV);
  N.kvs = h('dl', { class: 'kvs insp-kvs' }, N.mark.row, N.entry.row, N.size.row, N.margin.row, N.liq.row, N.water.row);
  N.unrealK = span();
  N.unrealV = span();
  N.estTag = span('age age--est');
  N.realK = span();
  N.realV = span();
  N.feesK = span();
  N.feesV = span('num');
  N.money3 = h('p', { class: 'insp-money num' }, N.unrealK, ' ', N.unrealV, N.estTag, ' · ', N.realK, ' ', N.realV, ' · ', N.feesK, ' ', N.feesV);
  N.totalK = span('insp-total-k');
  N.totalV = h('b');
  N.totalPct = span('num');
  N.total = h('div', { class: 'insp-total' }, N.totalK, N.totalV, N.totalPct);
  N.growthSum = h('summary');
  N.growthHelp = h('p', { class: 'muted' });
  N.growth = h('details', { class: 'insp-growth' }, N.growthSum, N.growthHelp);
  N.fund = h('p', { class: 'insp-fund muted num' });
  N.tnK = h('p', { class: 'insp-tnk muted num', hidden: true });
  N.exch = h('p', { class: 'insp-exch num', hidden: true });
  N.fill = h('p', { class: 'insp-fill', role: 'status', hidden: true });
  N.sync = h('p', { class: 'insp-sync', role: 'status', hidden: true });
  N.drift = h('div', { class: 'insp-drift', role: 'note', hidden: true });
  N.dust = h('p', { class: 'insp-dust muted', hidden: true });
  N.closing = h('p', { class: 'insp-closing', role: 'status', hidden: true });
  N.errTitle = h('b');
  N.errText = h('p');
  N.err = h('div', { class: 'insp-error', role: 'note' }, N.errTitle, N.errText);
  N.fillsH = h('h3', { class: 'insp-h' });
  N.fills = h('ul', { class: 'insp-fills' });
  N.sparkH = h('h3', { class: 'insp-h' });
  N.sparkBox = h('div', { class: 'insp-sparkbox' });
  N.bean = h('p', { class: 'insp-bean muted' });
  N.pending = h('p', { class: 'insp-pending', role: 'status' });
  N.why = h('p', { class: 'insp-why' });
  N.shade = h('button', { type: 'button', class: 'btn btn--paper insp-shade' });
  N.close = h('button', { type: 'button', class: 'btn btn--gold insp-close' });
  N.paper = h('p', { class: 'dlg-paper' });
  N.full = h(
    'div',
    { class: 'insp-full' },
    h('div', { class: 'insp-top' }, N.crop, N.side, N.lev, N.variety),
    N.sideHelp,
    N.state,
    N.kvs,
    N.money3,
    N.total,
    N.growth,
    N.exch,
    N.fund,
    N.tnK,
    N.fill,
    N.sync,
    N.drift,
    N.dust,
    N.err,
    N.fillsH,
    N.fills,
    N.sparkH,
    N.sparkBox,
    N.bean,
    N.pending,
    N.why,
    N.closing,
    (N.actions = h('div', { class: 'insp-actions' }, N.shade, N.close)),
    N.paper,
  );
  N.gone = h('p', { class: 'insp-gone', role: 'status' });
  N.emptyText = h('p', { class: 'insp-empty' });
  N.afterText = h('p', { class: 'insp-after money', role: 'status', hidden: true });
  N.plant = h('button', { type: 'button', class: 'btn btn--wood' });
  N.empty = h('div', { class: 'insp-emptybox' }, N.gone, N.afterText, N.emptyText, h('div', { class: 'insp-actions' }, N.plant));
  root.append(N.full, N.empty);

  const shown = { coin: null, fillsKey: '', sparkKey: '' };
  let act = { botId: null, paused: false, sunWhy: '' };

  N.shade.addEventListener('click', () => {
    if (!act.botId || isBusy(N.shade)) return;
    if (isBlocked(N.shade)) return announce(act.sunWhy);
    if (act.paused) A.resume(act.botId);
    else A.requestShade(act.botId, { opener: N.shade });
  });
  N.close.addEventListener('click', () => {
    if (!act.botId || isBusy(N.close)) return;
    if (isBlocked(N.close)) return announce(t('g.plant.offBlock'));
    A.requestClose(act.botId, { opener: N.close });
  });
  N.plant.addEventListener('click', () => {
    const s = store.get();
    if (D.isSpectator(s)) return ctx.mods.gate?.open?.({ opener: N.plant, reason: 'plant' });
    // a burned field (accounts mode): this button IS "Re-arm the field" — the REARM dialog once 60 s have passed,
    // the countdown (spoken and shown) before that; never a silent dead end (QA-16)
    if (D.isAccounts(s) && D.isHalted(s)) {
      const ra = D.rearmState(s);
      if (ra.can) return ctx.mods.account?.rearm?.({ opener: N.plant });
      const wait = t('g.rearm.wait', { time: countdown(ra.waitMs) });
      ctx.mods.toast?.show?.(wait, { tone: 'warn' });
      return announce(wait);
    }
    if (isBlocked(N.plant)) return announce(t(D.copyKey(s, 'plot.emptyHalted')));
    const pb = s.ui?.pickBean;
    const bean = pb ? (typeof pb === 'object' ? pb : D.beanOf(s, pb)) : null;
    if (bean) A.requestPlant(bean, cur.slot, { opener: N.plant });
    else ctx.mods.shelf?.openFor?.(cur.slot, { opener: N.plant });
  });

  function render() {
    if (!p.isOpen()) return;
    const s = store.get();
    const v = viewNow();
    if (v && v.botId !== cur.botId) {
      cur.botId = v.botId;
      cur.lastBotId = v.botId;
      loadDetail(v.botId);
    }
    N.full.hidden = !v;
    N.empty.hidden = !!v;
    if (!v) return renderEmpty(s);
    const nowMs = D.nowOf(s);
    const sim = D.isSim(s);
    const bean = D.beanOf(s, v.beanId);
    const n = Number.isInteger(cur.slot) && cur.slot < D.slotsOf(s).count ? plotNo(cur.slot) : '—';
    p.setTitle(t('g.insp.title', { n, coin: v.coin, crop: cropName(v.coin), bot: v.botId }));
    const accounts = D.isAccounts(s);
    const tn = v.venue === 'testnet';
    vBadge.hidden = !accounts && !tn;
    setVenueBadge(vBadge, v.venue);
    vBadge.classList.add('insp-venue');
    remember(v, cur.slot);
    focusBtn.hidden = !Number.isInteger(cur.slot) || !ctx.stage;
    focusBtn.setAttribute('aria-label', t('g.insp.focus'));
    focusBtn.title = t('g.insp.focus');

    if (shown.coin !== v.coin) {
      N.crop.replaceChildren(cropIcon(v.coin));
      shown.coin = v.coin;
    }
    const sideCls = v.side > 0 ? 'long' : v.side < 0 ? 'short' : 'flat';
    N.side.className = `pill pill--${sideCls} pill--lg`;
    setText(N.side, t(v.side > 0 ? 'g.side.long' : v.side < 0 ? 'g.side.short' : 'g.side.flat'));
    const both = isNum(v.beanLev) && isNum(v.venueMaxLev);
    setText(N.lev, both ? t('g.lev.capped', { n: Math.round(v.lev), bean: Math.round(v.beanLev), max: Math.round(v.venueMaxLev) }) : t('g.lev.label', { n: Math.round(v.lev) }));
    setText(N.variety, v.archetype ? `${v.archetype} · ${v.strategy || ''}` : '');
    N.sideHelp.hidden = !v.side;
    setText(N.sideHelp, v.side ? t(v.side > 0 ? 'g.side.longHelp' : 'g.side.shortHelp') : '');
    setText(N.state, stateText(v));
    N.state.dataset.tone = v.error || v.liqInfo?.band === 'danger' ? 'warn' : v.frozen ? 'stale' : '';

    // numbers: server values with their ages; "≈" marks client estimates (J1)
    const markAge = ageLabel(v.markMs, nowMs);
    // a testnet bot is priced at the TESTNET mid and says so (§9.4, J9); never the mainnet source line
    setText(N.mark.k, t(tn ? 'g.insp.tnMid' : 'g.insp.mark'));
    setText(N.markV, (v.markEst ? '≈ ' : '') + fmtPx(v.mark, v.szDecimals));
    setText(N.markAge, `${tn ? t('g.src.hlTestnet') : sim ? t('g.src.sim') : t('g.src.hl')} · ${v.frozen ? t('g.state.frozen') : markAge.text}`);
    N.markAge.className = `age age--${v.frozen ? 'delayed' : markAge.kind}`;
    for (const r of [N.entry, N.size, N.margin]) r.row.hidden = !v.side;
    setText(N.entry.k, t('g.insp.entry'));
    setText(N.entryV, fmtPx(v.entry, v.szDecimals));
    setText(N.size.k, t('g.insp.size'));
    setText(N.sizeV, `${fmtSz(v.szi, v.szDecimals)} ${v.coin}`);
    setText(N.notional, t('g.insp.notional', { usd: usd(v.notional, 2) }));
    setText(N.margin.k, t('g.insp.margin'));
    // testnet: ≈ while the margin is our estimate (after a fill, before the exchange reports that position, J1)
    setText(N.marginV, isNum(v.margin) ? (v.marginEst ? '≈ ' : '') + usd(v.margin, 2) : '—');
    setText(N.liq.k, t('g.liq.label'));
    N.liqV.hidden = !v.side;
    N.liqBar.hidden = !v.side;
    setText(N.liqV, fmtPx(v.liq, v.szDecimals));
    N.liqBar.dataset.band = v.liqInfo?.band || 'none';
    N.liqBar.setAttribute('aria-label', `${t('g.liq.gauge')}: ${liqText(v)}`);
    const segs = liqSegments(v);
    [...N.liqBar.children].forEach((i, k) => i.classList.toggle('on', k < segs));
    setText(N.liqText, liqText(v));
    N.liqText.classList.toggle('warn', v.liqInfo?.band === 'danger');
    setText(N.water.k, t('g.insp.water'));
    setText(N.waterV, usd(v.water, 2));
    setText(N.unrealK, t('g.insp.unreal'));
    setMoneyEl(N.unrealV, v.unrealized, { est: v.est });
    N.estTag.hidden = !v.est;
    setText(N.estTag, v.est ? ` (${t('g.age.est')})` : '');
    setText(N.realK, t('g.insp.real'));
    setMoneyEl(N.realV, v.realized);
    setText(N.feesK, t('g.insp.fees'));
    // provisional testnet fees: "fee ≈ (confirming)" until bot_fill_confirmed (§9.6 J1)
    setText(N.feesV, usd(v.fees, 2) + (v.feesEst ? ` · ${t('g.insp.feeEst')}` : ''));
    const total = pnlText(v);
    N.total.className = `insp-total insp-total--${total.tone}`;
    setText(N.totalK, t('g.insp.total'));
    setText(N.totalV, total.text);
    N.totalV.className = `money money--${total.tone} num`;
    setText(N.totalPct, ` (${t('g.insp.ofWater', { pct: signedPct(v.frac, 1) })})`);
    setText(N.growthSum, t('g.insp.growth', { size: v.size.toFixed(2), health: v.health.toFixed(2), fruit: v.fruit, flower: v.flower ? '✓' : '–' }));
    setText(N.growthHelp, t('g.insp.growthHelp'));
    if (tn) {
      // testnet funding is charged: its own line, part of Total P&L (§6.11, §9.6), plus the testnet hourly rate
      const tc = D.tnCoin(s, v.coin) || {};
      const parts = [];
      if (v.funding !== null && v.funding !== undefined) parts.push(t('g.insp.funding', { usd: money(v.funding).text }));
      if (isNum(tc.funding_1h)) parts.push(t('g.funding.testnet', { rate: fundingText(tc.funding_1h) }));
      N.fund.hidden = !parts.length;
      setText(N.fund, parts.join(' · '));
    } else {
      const coinRow = D.coinOf(s, v.coin) || {};
      N.fund.hidden = sim || !isNum(coinRow.funding_1h);
      if (!N.fund.hidden) setText(N.fund, t('g.plant.funding', { rate: fundingText(coinRow.funding_1h) }));
    }
    renderTestnet(v, s, nowMs);
    // the error box: localised by code, the server's text only as a collapsible detail (§9.5)
    const ei = botErrorInfo(v, { accounts: D.isAccounts(s), lastEvent: lastErrors.get(v.botId) || null });
    N.err.hidden = !ei;
    setText(N.errTitle, t('g.insp.errorTitle'));
    showErr(N.errText, ei);
    N.errText.hidden = false;

    // last fills (rebuilt only when they change)
    setText(N.fillsH, t('g.insp.fills'));
    const det = s.detail?.[v.botId];
    const fills = Array.isArray(det?.fills) ? [...det.fills] : [];
    fills.sort((a, b) => (Number(b?.time_ms) || 0) - (Number(a?.time_ms) || 0));
    const fk = `${v.botId}|${fills.length}|${fills[0]?.time_ms ?? ''}|${det ? 1 : 0}|${document.documentElement.lang}`;
    if (fk !== shown.fillsKey) {
      shown.fillsKey = fk;
      N.fills.replaceChildren(
        ...(fills.length
          ? fills.slice(0, FILLS_SHOWN).map((f) => {
              const dk = dirKey(f.dir);
              const dirTxt = dk ? t(dk) : String(f.dir ?? '');
              const isClose = /^Close /.test(String(f.dir || ''));
              const li = h('li', {}, h('span', { class: 'muted num', text: hhmm(f.time_ms) }), ' ', h('span', { class: 'num', text: `${dirTxt} ${fmtSz(f.sz, v.szDecimals)} ${v.coin} @ ${fmtPx(f.px, v.szDecimals)}` }));
              if (isClose && isNum(f.closed_pnl)) {
                const m = money(Number(f.closed_pnl) - (Number(f.fee) || 0));
                li.append(h('span', { text: ` · ${t('g.insp.real')} ` }), h('span', { class: `money money--${m.tone} num`, text: m.text }));
              } else li.append(h('span', { class: 'muted num', text: ` · ${t('g.insp.fillFee', { usd: usd(f.fee, 2) })}` }));
              if (f.liquidation) li.append(h('span', { class: 'warn', text: ' ⚠' }));
              return li;
            })
          : [h('li', { class: 'muted', text: det ? t('g.insp.noFills') : t('g.insp.collecting') })]),
      );
    }

    // price since you opened this page (from mids; neutral ink)
    setText(N.sparkH, t('g.insp.priceSince'));
    const hist = s.priceHistory?.[v.coin] || [];
    const last = hist[hist.length - 1];
    const sk = `${v.coin}|${hist.length}|${Array.isArray(last) ? last[0] : ''}`;
    if (sk !== shown.sparkKey) {
      shown.sparkKey = sk;
      const pts = sparkPoints(hist);
      N.sparkBox.replaceChildren(pts ? svgSpark(pts) : h('p', { class: 'muted', text: t('g.insp.collecting') }));
    }

    N.bean.hidden = !bean;
    if (bean) setText(N.bean, t('g.insp.bean', { id: bean.id, archetype: bean.archetype, strategy: bean.strategy, ret: signedPct(bean.total_return, 1), side: t(Number(bean.side) > 0 ? 'g.side.long' : Number(bean.side) < 0 ? 'g.side.short' : 'g.side.flat') }) + (tn ? ` · ${t('g.plant.beanRealPrices')}` : ''));

    // actions (busy = aria-disabled + data-busy, never `disabled`: focus stays)
    const pending = A.isPending(v.botId);
    const offline = D.isOffline(s);
    const paused = v.state === 'paused';
    let sunWhy = '';
    if (paused) sunWhy = offline ? t('g.plant.offBlock') : D.isHalted(s) ? t(D.copyKey(s, 'plot.emptyHalted')) : D.isDown(s) ? t('g.plant.downBlock') : '';
    else if (offline) sunWhy = t('g.plant.offBlock');
    act = { botId: v.botId, paused, sunWhy };
    setText(N.shade, t(paused ? 'g.insp.sun' : 'g.insp.shade'));
    setBlocked(N.shade, !!sunWhy);
    setBusy(N.shade, pending);
    // one number decides AND labels the button (≈ after the closing fee), as in the list, radial and confirm
    const cc = D.closeChoice(s, v);
    const loss = cc.loss;
    N.close.className = `btn ${loss ? 'btn--danger-outline' : 'btn--gold'} insp-close`;
    setText(N.close, t(loss ? 'g.insp.pull' : 'g.insp.harvest', { pnl: money(cc.usd, { est: cc.est, glyph: false }).text }));
    setBlocked(N.close, offline);
    setBusy(N.close, pending);
    N.pending.hidden = !pending;
    setText(N.pending, t('g.insp.pending'));
    N.why.hidden = !(sunWhy && paused);
    setText(N.why, sunWhy);
    setText(N.paper, tn ? t('g.venue.testnetLong') : t('g.insp.paperNote', { source: t(sim ? 'g.src.sim' : 'g.src.real') }));
    N.paper.classList.toggle('dlg-paper--testnet', tn);
    // closing (testnet): the actions are replaced by the closing line until the position is flat (§9.4)
    N.actions.hidden = !!v.closing;
    N.closing.hidden = !v.closing;
    if (v.closing) {
      const failed = v.sync?.state === 'failed';
      const left = isNum(v.szi) ? Math.abs(v.szi) : 0;
      // a failed flatten retries every 15 s (§6.11 Pause): the next try is ≈ the next 15 s step after since_ms
      const since = isNum(v.sync?.since_ms) ? Number(v.sync.since_ms) : nowMs;
      const next = isNum(v.sync?.next_ms) ? Math.max(0, v.sync.next_ms - nowMs) : 15_000 - (Math.max(0, nowMs - since) % 15_000);
      // a remainder the exchange refuses as below $10 is NOT retried: say what is left and how it ends (§6.11 Close)
      const dustStuck = failed && v.sync?.code === 'min_notional' && v.dust;
      if (dustStuck) setText(N.closing, t('g.insp.closingDust', { sz: fmtSz(Math.abs(Number(v.dust.szi) || left), v.szDecimals), coin: v.coin }));
      else setText(N.closing, failed ? t('g.insp.closingFailed', { reason: noDot(codeText(v.sync?.code, { coin: v.coin }, D.isAccounts(s) ? '' : v.sync?.error)), time: '≈ ' + countdown(next) }) : t('g.insp.closing', { sz: fmtSz(left, v.szDecimals), coin: v.coin }));
      N.closing.dataset.tone = failed ? 'warn' : '';
      N.why.hidden = true;
      N.pending.hidden = true;
    }
  }

  /** The testnet-only lines of a view (fill state, sync, exchange numbers, drift, dust, ×k). */
  function renderTestnet(v, s, nowMs) {
    const tn = v.venue === 'testnet';
    for (const el of [N.tnK, N.exch, N.fill, N.sync, N.drift, N.dust]) el.hidden = !tn;
    if (!tn) return;
    // the frozen size ratio k (sized for testnet prices)
    const k = v.sizeRatio?.k;
    N.tnK.hidden = !isNum(k);
    if (isNum(k)) setText(N.tnK, t('g.insp.tnK', { k: Number(k).toFixed(3) }));
    // the exchange's own numbers with their age (§9.6 J1): unrealized, liquidation price (— until reconciled)
    // Shown only while that snapshot describes the position the bot holds: right after a fill the last reconcile ran
    // BEFORE the order (its $0.00 / — belong to the old, flat position), and a drift-paused bot has its own card.
    const ex = v.exchange;
    const lotHalf = 0.5 * 10 ** -(Number(v.szDecimals) || 0);
    const covers = !!ex && Math.abs((Number(ex.szi) || 0) - (Number(v.szi) || 0)) < lotHalf;
    N.exch.hidden = !covers;
    if (covers) {
      const a = ageLabel(ex.as_of_ms, nowMs);
      const um = money(ex.unrealized_pnl);
      setText(N.exch, `${t('g.insp.exchange', { age: a.text })}: ${t('g.insp.unreal')} ${um.text} · ${t('g.liq.label')} ${isNum(ex.liquidation_px) ? fmtPx(ex.liquidation_px, v.szDecimals) : '—'}${v.est ? ' · ' + t('g.insp.estAtMid') : ''}`);
      N.exch.className = `insp-exch num age--${a.kind}`;
    }
    // fill state
    const fs = v.fillState;
    const fillKey = fs === 'partial' ? 'g.insp.tnFilled' : fs === 'unfilled' ? 'g.insp.tnUnfilled' : fs === 'waiting_bean' ? 'g.insp.tnWaiting' : null;
    // only an active bot mirrors the bean: a paused one (shade, drift, liquidation, kill switch) has no fill target,
    // so "holding X of 0, retrying next minute" would contradict its pause note
    N.fill.hidden = !fillKey || v.closing || v.state === 'paused';
    if (fillKey) setText(N.fill, t(fillKey, { sz: fmtSz(Math.abs(v.szi || 0), v.szDecimals), target: fmtSz(Math.abs(v.targetSzi || 0), v.szDecimals), coin: v.coin }));
    // the exchange round trip (J3): pending loop text, or the localised failure
    const sy = v.sync;
    // pending: the state caption already says "Sending to testnet…" (with the pending loop); failures get a line
    N.sync.hidden = !sy || v.closing || sy.state !== 'failed';
    N.state.classList.toggle('is-pending', sy?.state === 'pending' && !v.closing);
    if (sy) {
      setText(N.sync, sy.state === 'failed' ? t('g.insp.syncFailed', { reason: noDot(codeText(sy.code, { coin: v.coin }, D.isAccounts(s) ? '' : sy.error)) }) : t('g.insp.syncPending'));
      N.sync.dataset.tone = sy.state === 'failed' ? 'warn' : '';
      N.sync.classList.toggle('is-pending', sy.state === 'pending');
    }
    // drift: the exchange holds a size the bot did not expect (traded by hand?) — explained neutrally (J12)
    const drift = v.noteCode === 'position_drift';
    N.drift.hidden = !drift;
    if (drift) {
      const nv = noteVarsOf(v);
      // signed sizes with the typographic minus, as every other number of the inspector (J4)
      const signed = (x) => (x === undefined || x === null ? '—' : String(x).replace(/^-/, '−'));
      setText(N.drift, t('g.insp.drift', { exch: signed(nv.exch), coin: v.coin, exp: signed(nv.exp) }));
    }
    N.dust.hidden = !v.dust;
    if (v.dust) setText(N.dust, t('g.insp.dust', { sz: fmtSz(Math.abs(Number(v.dust.szi) || 0), v.szDecimals), coin: v.coin }));
  }

  /** Remember the last crop shown in a slot / for a bot (coin and venue), for the after-harvest card. */
  function remember(v, slot) {
    const prev = lastCrops.get(v.botId) || {};
    lastCrops.set(v.botId, { ...prev, coin: v.coin, venue: v.venue, slot: Number.isInteger(slot) ? slot : prev.slot ?? null });
  }
  /** The closed result of a bot: the closed BotRow, else the bot_closed event we saw. */
  function lastCropOf(botId) {
    if (!botId) return null;
    const known = lastCrops.get(botId) || null;
    const row = (store.get().bots || []).find((b) => b && b.id === botId);
    if (row && row.state === 'closed') {
      return { coin: row.coin, realized: Number(row.realized_pnl) + (Number(row.funding_realized) || 0), confirmed: known?.confirmed ?? !row.fees_estimated, venue: D.venueOf(row), slot: known?.slot ?? null };
    }
    return known && known.realized !== undefined ? known : null;
  }

  function svgSpark(pts) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 240 36');
    svg.setAttribute('class', 'insp-spark');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('preserveAspectRatio', 'none');
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', pts);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.6');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(line);
    return svg;
  }

  function renderEmpty(s) {
    const drawn = Number.isInteger(cur.slot) && cur.slot < D.slotsOf(s).count;
    const n = drawn ? plotNo(cur.slot) : null;
    const last = lastCropOf(cur.lastBotId);
    // a bot opened from the list or the diary (no plot) never reads "Plot —" (QA-04 a)
    p.setTitle(n !== null ? t('g.dock.plot', { n }) : last ? `${last.coin} · ${cur.lastBotId}` : t('g.insp.gone'));
    focusBtn.hidden = true;
    vBadge.hidden = !last || (!D.isAccounts(s) && last.venue !== 'testnet');
    if (last) setVenueBadge(vBadge, last.venue);
    const halted = D.isHalted(s);
    const haltedKey = D.copyKey(s, 'plot.emptyHalted');
    const card = afterCard(last, n, { halted, haltedKey });
    N.gone.hidden = !!last || !cur.lastBotId;
    setText(N.gone, t('g.insp.gone'));
    N.afterText.hidden = !last;
    if (last) {
      setText(N.afterText, t(card.key, card.vars));
      N.afterText.className = `insp-after money money--${card.tone}`;
    }
    // what the plot offers now: plant here (blocked with the burned reason), or the plain empty line
    N.emptyText.hidden = !!last && !halted;
    setText(N.emptyText, halted ? t(haltedKey) : last ? '' : t(card.key, card.vars));
    N.plant.hidden = !drawn;
    if (halted && D.isAccounts(s) && !D.isSpectator(s)) {
      // burned (accounts mode): offer the way back instead of a "Plant here" that cannot work
      const ra = D.rearmState(s);
      setText(N.plant, ra.can ? t('g.rearm') : t('g.rearm.wait', { time: countdown(ra.waitMs) }));
      setBlocked(N.plant, !ra.can);
      return;
    }
    setText(N.plant, t(D.isSpectator(s) ? 'g.gate.signInToPlant' : 'g.insp.plantHere'));
    setBlocked(N.plant, halted);
  }

  // ------------------------------------------------------------------ open / close

  function open(o = {}) {
    p.open({ opener: o.opener || null, snap: o.snap || 60, focus: o.focus !== false, force: !!o.force });
    render();
  }

  function close() {
    p.close({ restore: false });
  }

  p.onClose(() => {
    // closing the inspector clears the selection (and leaves focus mode), unless a phone sheet swap closed it
    const s = store.get();
    if (s.ui?.selectedSlot !== null && s.ui?.selectedSlot !== undefined && !sheets.leftOpen()) {
      A.leaveFocus();
      A.select(null);
    }
    cur = { slot: null, botId: null, lastBotId: null };
  });

  // store.ui.selectedSlot drives the inspector (dock, 3D tap, list view, radial)
  watch(store, (s) => s.ui?.selectedSlot ?? null, (slot, prev) => {
    if (slot === null) {
      if (p.isOpen() && Number.isInteger(cur.slot)) close();
      return;
    }
    if (slot !== cur.slot) cur = { slot, botId: null, lastBotId: null };
    // focus stays in the dock / field on desktop; a phone sheet takes focus (it covers the field and the dock
    // card that had focus — WCAG 2.4.11); closing it returns focus to that card (the panel's opener)
    open({ focus: isPhone() });
    void prev;
  });
  watch(store, (s) => [s.views, s.bots, s.marks?.t, s.detail, s.priceHistory, s.live, s.feed, s.net?.ok, s.ui?.pending], render, (a, b) => !!a && !!b && a.every((x, i) => Object.is(x, b[i])));
  A.onChange(render);
  const timer = setInterval(() => p.isOpen() && render(), 5000);
  // a fill on the shown bot refreshes its last fills
  on(ctx, 'game:event', (ev) => {
    // the code of a bot's newest live_error: its error box is localised by it (§9.5)
    if (ev && ev.type === 'error' && ev.bot) {
      const r = ev.raw || ev;
      const code = ev.code ?? r.code;
      if (typeof code === 'string') lastErrors.set(ev.bot, { code, vars: r.vars ?? ev.vars ?? null, error: r.error ?? ev.error ?? null });
      if (p.isOpen() && cur.botId === ev.bot) render();
    }
    // the result of a close (and its later confirmation) for the after-harvest card (QA-04 c)
    const kind = ev?.kind ?? ev?.type;
    if (ev && (ev.type === 'closed' || kind === 'bot_closed') && ev.bot) {
      const prev = lastCrops.get(ev.bot) || {};
      lastCrops.set(ev.bot, { ...prev, coin: ev.coin ?? prev.coin, realized: Number(ev.realized_pnl ?? ev.raw?.realized_pnl) + (Number(ev.funding ?? ev.raw?.funding) || 0), confirmed: (ev.confirmed ?? ev.raw?.confirmed) !== false, venue: ev.venue ?? ev.raw?.venue ?? prev.venue ?? 'paper' });
      if (p.isOpen() && cur.lastBotId === ev.bot) render();
    }
    if (ev && (kind === 'bot_fill_confirmed' || ev.type === 'fillConfirmed') && ev.bot && lastCrops.has(ev.bot)) {
      const prev = lastCrops.get(ev.bot);
      const r = ev.raw || ev;
      // the confirmed number replaces the ≈ one; no effect is replayed (§9.6 J4)
      const confirmedPnl = Number(r.realized_pnl ?? r.closed_pnl);
      lastCrops.set(ev.bot, { ...prev, confirmed: true, realized: Number.isFinite(confirmedPnl) && r.realized_pnl !== undefined ? confirmedPnl : prev.realized });
      if (p.isOpen() && cur.lastBotId === ev.bot) render();
    }
    if (!ev || !cur.botId || ev.bot !== cur.botId) return;
    if (ev.type === 'fill' || ev.type === 'closed' || ev.type === 'paused' || ev.type === 'resumed') {
      if (detailFor) clearTimeout(detailFor);
      detailFor = setTimeout(() => loadDetail(cur.botId), 300);
    }
  });
  onLangChange(render);

  const apiOut = {
    open,
    close,
    openBot(botId, o = {}) {
      const s = store.get();
      const v = D.viewOfBot(s, botId);
      if (v && v.slot < D.slotsOf(s).count) {
        A.select(v.slot);
        return;
      }
      cur = { slot: null, botId, lastBotId: botId };
      open(o);
    },
    current: () => ({ ...cur }),
    dispose: () => clearInterval(timer),
  };
  ctx.mods.inspector = apiOut;
  return apiOut;
}

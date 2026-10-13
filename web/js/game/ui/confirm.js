/**
 * ui/confirm.js — confirmation dialogs that state the money (GAME-DESIGN §6.7, J10, J12).
 *
 *   close(botId, o)   Harvest (≈ total ≥ 0) / Pull (< 0, red framing) → bot_close
 *   shade(botId, o)   Shade a plot that holds a position → bot_pause
 *   burn(o)           Burn the field: every open plot with its ≈ total, the net, an "I understand" checkbox
 *   ask({title, body, yes, danger}) → Promise<boolean>   generic yes/cancel (token host trust, …)
 *
 * Every close dialog shows side, size, current price, ≈ $ and % of water after fee and slippage, and the
 * words "paper fill"; numbers refresh live while open and g.ask.changed appears when the estimate moves by more
 * than $0.50 or 10 %. Default focus is on the safe button (Keep growing / Cancel). Native modal <dialog>:
 * focus is trapped, Esc cancels, focus returns to the opener. Busy buttons use aria-disabled + data-busy.
 * Server first (J3): the dialog waits for the answer; an error shows inline (role=alert) and keeps it open.
 *
 * Venues (PLATFORM §9.4, §9.6 J10): in accounts mode every money confirm carries its PAPER / TESTNET badge. A testnet
 * harvest says what really happens — "testnet IOC order (test funds): the result is what the exchange fills" and the
 * closing slippage line (within 1 %, retries widen to 5 %: ≤ ≈ $) — and its footer is the testnet one. The burn
 * dialog of accounts mode lists the testnet plots and says planting needs a re-arm (never "restart the server").
 *
 * Exports: mount(deps) → { close, shade, burn, ask, isOpen }.  No three.js, no side effects at import.
 */

import { t, onLangChange } from '../../i18n.js';
import { usd } from '../../format.js';
import { closeQuote, fmtPx, fmtSz } from '../../model.js';
import { getCtx } from './context.js';
import { h, $, setText, money, setBusy, isBusy, setBlocked, isBlocked, trapTab, plotNo, watch, nextFrame, venueBadge, showErr } from './util.js';
import { signedPct } from './plotText.js';
import { getActions } from './actions.js';
import * as D from './derive.js';
import { announce } from './a11y.js';

const CHANGED_USD = 0.5;
const CHANGED_FRAC = 0.1;

/** Pause notes after which the exchange holds a size the bot did not expect (§6.11 step 4). */
const DRIFT_NOTES = new Set(['position_drift', 'external_close']);

/**
 * Pure: the ≈ close estimate for a bot (merged with the newest marks) — exported for tests.
 * A drift-paused TESTNET bot is closed by flattening the WHOLE exchange position on its coin (§6.11 step 4: the
 * server adopts the exchange size first), so its estimate is sized from `exchange.szi` — the part opened outside the
 * garden included — and `whole` says so; an exchange that is already flat leaves nothing to close. Otherwise the
 * bot's books (they equal the exchange; right after a fill the snapshot may still be the pre-trade one).
 */
export function closeEstimate(bot, mark) {
  const ex = bot?.venue === 'testnet' && bot.exchange && typeof bot.exchange === 'object' ? bot.exchange : null;
  const whole = !!ex && DRIFT_NOTES.has(bot?.note_code) && Number.isFinite(Number(ex.szi));
  let sized = bot;
  if (whole) {
    const szi = Number(ex.szi) || 0;
    const entry = Number(ex.entry_px) || Number(bot.real?.entry_px) || null;
    const px = Number(mark) || Number(bot.mark_px) || entry;
    const unrealized = szi && entry && px ? szi * (px - entry) : 0;
    sized = { ...bot, real: { ...(bot.real || {}), szi, entry_px: entry, unrealized_pnl: unrealized } };
  }
  const q = closeQuote(sized, mark);
  const szi = Number(sized?.real?.szi) || 0;
  const realized = Number(bot?.realized_pnl) || 0;
  return { ...q, szi, flat: szi === 0, whole, realized, realizes: q.estTotal - realized };
}

/** Pure: did the estimate move enough to warn (§6.7)? */
export function estimateChanged(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const d = Math.abs(b - a);
  return d > CHANGED_USD || (Math.abs(a) > 0 && d / Math.abs(a) > CHANGED_FRAC);
}

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('confirm')) return ctx.mods.confirm;
  const { store } = ctx;
  const A = getActions(ctx);
  let dlg = $('askDlg');
  if (!dlg) {
    dlg = h('dialog', { id: 'askDlg', class: 'dlg dlg--ask', 'aria-labelledby': 'askTitle', 'aria-describedby': 'askBody' });
    $('dialogs')?.append(dlg);
  }
  let session = null; // { kind, resolve, opener, render(), off() }

  dlg.addEventListener('keydown', (e) => trapTab(dlg, e));
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    dismiss();
  });

  /**
   * Esc / Keep growing / Cancel. While the confirm button is sending, the command is already on its way and
   * WILL go through (or fail): the dialog stays, so its result or its inline error is seen (J3); the press only
   * repeats "sending…" for screen readers.
   */
  function dismiss() {
    if (dlg.querySelector('[data-busy="1"]')) {
      announce(t('g.ask.sending'));
      return;
    }
    finish(false);
  }

  /** A focus target that is actually visible (a hidden inspector's button would drop focus to <body>). */
  function focusable(el) {
    return !!el && el.isConnected && el.getClientRects().length > 0 && !el.closest('[hidden], [inert]');
  }
  dlg.addEventListener('close', () => {
    // The 'close' event is queued asynchronously. When begin() replaced a session (close() then showModal()
    // in one go), the event of the OLD session arrives while the dialog is open again for the NEW one: it must
    // not end the new session, or the dialog would stay open with nothing behind its buttons.
    if (session && !dlg.open) finish(false, { fromClose: true });
  });

  function begin(kind, opener, build) {
    if (session) finish(false);
    const s = { kind, opener: opener || document.activeElement, resolve: null, render: null, off: null };
    session = s;
    const promise = new Promise((res) => (s.resolve = res));
    build(s);
    if (!dlg.open) {
      try {
        dlg.showModal();
      } catch {
        dlg.setAttribute('open', '');
      }
    }
    nextFrame(() => dlg.querySelector('[data-autofocus]')?.focus());
    return promise;
  }

  function finish(value, { fromClose = false } = {}) {
    const s = session;
    if (!s) return;
    session = null;
    s.off?.();
    if (!fromClose && dlg.open) dlg.close();
    dlg.classList.remove('dlg--danger', 'dlg--burn');
    s.resolve?.(value);
    // after a harvest/pull the plot is empty and the inspector's buttons go away: land on its dock card instead;
    // otherwise the opener while it is still visible, then the plot's card, then the stage
    const card = Number.isInteger(s.slot) ? ctx.mods.dock?.cardFor?.(s.slot) : null;
    const closedPlot = value === true && s.kind === 'close';
    const back = (closedPlot && focusable(card) && card) || (focusable(s.opener) && s.opener) || (focusable(card) && card) || $('stage');
    back?.focus?.({ preventScroll: true });
  }

  function frame({ title, danger = false, burn = false, venue = null }) {
    dlg.classList.toggle('dlg--danger', danger);
    dlg.classList.toggle('dlg--burn', burn);
    const titleEl = h('h2', { id: 'askTitle', class: 'dlg-title', text: title });
    const body = h('div', { id: 'askBody', class: 'dlg-body' });
    const err = h('div', { class: 'dlg-error', role: 'alert', tabindex: '-1', hidden: true });
    const actions = h('div', { class: 'dlg-actions' });
    const st = store.get();
    const tn = venue === 'testnet';
    // the venue of a money confirm, always in words (accounts mode; none mode is paper only, as today)
    const badge = venue && (D.isAccounts(st) || tn) ? venueBadge(venue, { cls: 'dlg-venue' }) : null;
    const paper = h('p', { class: `dlg-paper${tn ? ' dlg-paper--testnet' : ''}`, text: tn ? t('g.venue.testnetLong') : t('g.insp.paperNote', { source: t(D.isSim(st) ? 'g.src.sim' : 'g.src.real') }) });
    dlg.replaceChildren(h('div', { class: 'dlg-card' }, badge ? h('div', { class: 'dlg-title-row' }, titleEl, badge) : titleEl, body, err, actions, paper));
    return { titleEl, body, err, actions };
  }

  /** Inline error: the localised line (+ the raw server text as a collapsed detail), focus moves to it. */
  function showError(err, msg) {
    showErr(err, msg || null);
    if (msg) err.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ harvest / pull

  function close(botId, o = {}) {
    return begin('close', o.opener, (s) => {
      s.slot = store.get().slots?.map?.[botId] ?? null;
      const bot0 = (store.get().bots || []).find((b) => b && b.id === botId);
      const tn = D.isTestnetBot(bot0);
      const { titleEl, body, err, actions } = frame({ title: '', venue: D.venueOf(bot0) });
      const lead = h('p', { class: 'dlg-lead' });
      const big = h('p', { class: 'dlg-big num' });
      const differ = h('p', { class: 'dlg-note', text: tn ? t('g.confirm.tnFill') : t('g.ask.differ') });
      const slipLine = h('p', { class: 'dlg-note num', hidden: !tn });
      // drift-paused testnet bot: the order closes the whole exchange position on the coin, said in words (§6.11)
      const wholeLine = h('p', { class: 'dlg-warn', hidden: true });
      const changed = h('p', { class: 'dlg-warn', hidden: true, text: t('g.ask.changed') });
      body.append(big, lead, wholeLine, differ, slipLine, changed);
      const keep = h('button', { type: 'button', class: 'btn btn--paper', 'data-autofocus': '', text: t('g.ask.keep') });
      const yes = h('button', { type: 'button', class: 'btn btn--wood' });
      actions.append(keep, yes);
      keep.addEventListener('click', () => dismiss());
      let first = null;

      s.render = () => {
        const st = store.get();
        const v = D.viewOfBot(st, botId);
        const bot = D.mergedBot(st, botId);
        if (!bot || bot.state === 'closed') {
          setText(lead, t('g.insp.gone'));
          setBlocked(yes, true);
          return;
        }
        const q = closeEstimate(bot, v?.mark);
        if (first === null) first = q.estTotal;
        const loss = q.estTotal < 0;
        const m = money(q.estTotal, { est: true });
        dlg.classList.toggle('dlg--danger', loss);
        setText(titleEl, t(loss ? 'g.ask.pullTitle' : 'g.ask.harvestTitle', { coin: bot.coin, bot: bot.id }));
        setText(big, m.text);
        big.className = `dlg-big num money money--${m.tone}`;
        if (q.flat) setText(lead, t('g.ask.closeFlat', { pnl: money(q.realized).text }));
        else {
          const szd = v?.szDecimals ?? D.szDecimalsOf(st, bot.coin);
          setText(
            lead,
            t('g.ask.closeBody', {
              sz: fmtSz(q.szi, szd),
              coin: bot.coin,
              side: t(q.szi > 0 ? 'g.side.long' : 'g.side.short'),
              px: fmtPx(v?.mark ?? bot.mark_px, szd),
              pnl: m.text.replace(/^≈ /, ''),
              pct: q.pct === null ? '—' : signedPct(q.pct, 1),
              water: usd(bot.capital_usd, 2),
              fee: usd(q.fee, 2),
              slip: usd(q.slip, 2),
            }),
          );
        }
        changed.hidden = !estimateChanged(first, q.estTotal);
        wholeLine.hidden = !(tn && q.whole && !q.flat);
        if (!wholeLine.hidden) {
          const szd = v?.szDecimals ?? D.szDecimalsOf(st, bot.coin);
          setText(wholeLine, t('g.confirm.tnWhole', { sz: fmtSz(q.szi, szd), coin: bot.coin, exp: fmtSz(Number(bot.real?.szi) || 0, szd) }));
        }
        if (tn) {
          // closing starts within 1 %; on a thin book retries widen to 5 % (≤ ≈ 5 % of the notional, §6.5)
          const px = Number(v?.mark ?? bot.mark_px);
          const notional = Math.abs(q.szi) * (Number.isFinite(px) ? px : 0);
          setText(slipLine, t('g.confirm.tnSlip', { usd: usd(0.05 * notional, 2) }));
        }
        if (!isBusy(yes)) setText(yes, t(loss ? 'g.ask.pullYes' : 'g.ask.harvestYes', { pnl: money(q.estTotal, { est: true, glyph: false }).text }));
        yes.className = `btn ${loss ? 'btn--danger-outline' : 'btn--gold'}`;
      };

      yes.addEventListener('click', async () => {
        if (isBusy(yes) || isBlocked(yes)) return;
        setBusy(yes, true);
        setText(yes, t('g.ask.sending'));
        showError(err, '');
        const out = await A.close(botId);
        setBusy(yes, false);
        if (out?.error) {
          s.render?.();
          showError(err, A.failInfo(out));
          return;
        }
        finish(true);
      });
      s.off = watch(store, (st) => [st.bots, st.marks?.t, st.views], () => s.render(), arrEq);
    });
  }

  // ------------------------------------------------------------------ shade with a position

  function shade(botId, o = {}) {
    return begin('shade', o.opener, (s) => {
      s.slot = store.get().slots?.map?.[botId] ?? null;
      const bot0 = (store.get().bots || []).find((b) => b && b.id === botId);
      const { titleEl, body, err, actions } = frame({ title: '', venue: D.venueOf(bot0) });
      const lead = h('p', { class: 'dlg-lead' });
      const what = h('p', { class: 'dlg-note' });
      const differ = h('p', { class: 'dlg-note', text: t('g.ask.differ') });
      const changed = h('p', { class: 'dlg-warn', hidden: true, text: t('g.ask.changed') });
      body.append(what, lead, differ, changed);
      const keep = h('button', { type: 'button', class: 'btn btn--paper', 'data-autofocus': '', text: t('g.ask.keep') });
      const yes = h('button', { type: 'button', class: 'btn btn--wood', text: t('g.ask.shadeYes') });
      actions.append(keep, yes);
      keep.addEventListener('click', () => dismiss());
      let first = null;
      s.render = () => {
        const st = store.get();
        const v = D.viewOfBot(st, botId);
        const bot = D.mergedBot(st, botId);
        if (!bot || bot.state === 'closed') {
          setText(lead, t('g.insp.gone'));
          setBlocked(yes, true);
          return;
        }
        const q = closeEstimate(bot, v?.mark);
        if (first === null) first = q.realizes;
        setText(titleEl, t('g.ask.shadeTitle', { coin: bot.coin, bot: bot.id }));
        setText(what, t('g.ask.shadeBody', { pnl: money(q.realizes, { est: true }).text.replace(/^≈ /, '') }));
        const szd = v?.szDecimals ?? D.szDecimalsOf(st, bot.coin);
        setText(
          lead,
          q.flat
            ? t('g.ask.closeFlat', { pnl: money(q.realized).text })
            : t('g.ask.closeBody', {
                sz: fmtSz(q.szi, szd),
                coin: bot.coin,
                side: t(q.szi > 0 ? 'g.side.long' : 'g.side.short'),
                px: fmtPx(v?.mark ?? bot.mark_px, szd),
                pnl: money(q.estTotal).text,
                pct: q.pct === null ? '—' : signedPct(q.pct, 1),
                water: usd(bot.capital_usd, 2),
                fee: usd(q.fee, 2),
                slip: usd(q.slip, 2),
              }),
        );
        changed.hidden = !estimateChanged(first, q.realizes);
      };
      yes.addEventListener('click', async () => {
        if (isBusy(yes) || isBlocked(yes)) return;
        setBusy(yes, true);
        setText(yes, t('g.ask.sending'));
        showError(err, '');
        const out = await A.shade(botId);
        setBusy(yes, false);
        setText(yes, t('g.ask.shadeYes'));
        if (out?.error) {
          showError(err, A.failInfo(out));
          return;
        }
        finish(true);
      });
      s.off = watch(store, (st) => [st.bots, st.marks?.t, st.views], () => s.render(), arrEq);
    });
  }

  // ------------------------------------------------------------------ burn the field

  function burn(o = {}) {
    return begin('burn', o.opener, (s) => {
      const { body, err, actions } = frame({ title: t('ask.burnTitle'), danger: true, burn: true });
      const lead = h('p', { class: 'dlg-lead' });
      const rows = h('ul', { class: 'burn-list' });
      const net = h('p', { class: 'dlg-big num' });
      const differ = h('p', { class: 'dlg-note', text: t('g.ask.differ') });
      const checkId = 'burnCheck';
      const check = h('input', { type: 'checkbox', id: checkId, class: 'check' });
      const checkRow = h('label', { class: 'f-check dlg-check', for: checkId }, check, h('span', { text: t('g.ask.burnCheck') }));
      body.append(lead, rows, net, differ, checkRow);
      const cancel = h('button', { type: 'button', class: 'btn btn--paper', 'data-autofocus': '', text: t('g.ask.cancel') });
      const yes = h('button', { type: 'button', class: 'btn btn--danger', text: t('g.ask.burnYes') });
      actions.append(cancel, yes);
      cancel.addEventListener('click', () => dismiss());
      const syncYes = () => setBlocked(yes, !check.checked);
      check.addEventListener('change', syncYes);
      syncYes();
      s.render = () => {
        const st = store.get();
        const all = D.viewsOf(st);
        const views = [...Object.values(all.bySlot), ...all.hidden].filter(Boolean).sort((a, b) => a.slot - b.slot);
        let sumUnreal = 0;
        let sumTotal = 0;
        const items = views.map((v) => {
          const bot = D.mergedBot(st, v.botId);
          const q = closeEstimate(bot, v.mark);
          sumUnreal += Number(v.unrealized) || 0;
          sumTotal += q.estTotal;
          const m = money(q.estTotal, { est: true });
          const pos = q.flat ? t('g.side.flat') : `${q.szi > 0 ? '↑' : '↓'} ${fmtSz(q.szi, v.szDecimals)} @ ${fmtPx(v.mark, v.szDecimals)}`;
          // the coin and its TESTNET badge share one cell, so every row keeps the grid's five columns (QA-15)
          return h('li', { class: 'burn-row' }, h('span', { class: 'num', text: v.slot < all.count ? plotNo(v.slot) : '—' }), h('span', { class: 'burn-coin' }, h('b', { text: v.coin }), v.venue === 'testnet' ? venueBadge('testnet') : null), h('span', { class: 'burn-pos num', text: pos }), h('span', { class: `money money--${m.tone} num`, text: m.text }), h('span', { class: 'num burn-pct', text: q.pct === null ? '' : t('g.insp.ofWater', { pct: signedPct(q.pct, 1) }) }));
        });
        rows.replaceChildren(...items);
        // accounts mode: testnet plots close with IOC orders (may take a minute); planting needs a re-arm (§9.4)
        const nTn = views.filter((v) => v.venue === 'testnet').length;
        rows.classList.toggle('burn-list--tn', nTn > 0); // a wider coin column holds the TESTNET badge
        let bodyKey = D.copyKey(st, 'g.ask.burnBody');
        // accounts mode with no testnet plot: the "testnet (0) with IOC orders" clause is only noise
        if (bodyKey === 'g.ask.burnBodyAccounts' && nTn === 0) bodyKey = 'g.ask.burnBodyAccountsPaper';
        setText(lead, t(bodyKey, { n: views.length, t: nTn, pnl: money(sumUnreal).text }));
        const nm = money(sumTotal, { est: false });
        setText(net, t('g.ask.burnNet', { pnl: nm.text }));
        net.className = `dlg-big num money money--${nm.tone}`;
      };
      yes.addEventListener('click', async () => {
        if (isBusy(yes)) return;
        if (isBlocked(yes)) {
          check.focus();
          return;
        }
        setBusy(yes, true);
        setText(yes, t('g.ask.sending'));
        showError(err, '');
        const out = await A.burn();
        setBusy(yes, false);
        setText(yes, t('g.ask.burnYes'));
        if (out?.error) {
          showError(err, A.failInfo(out));
          return;
        }
        finish(true);
      });
      s.off = watch(store, (st) => [st.bots, st.marks?.t, st.views], () => s.render(), arrEq);
    });
  }

  // ------------------------------------------------------------------ generic ask

  function ask({ title, body: text, yes: yesText, danger = false, opener = null }) {
    return begin('ask', opener, (s) => {
      const { body, actions } = frame({ title, danger });
      body.append(h('p', { class: 'dlg-lead', text }));
      const no = h('button', { type: 'button', class: 'btn btn--paper', 'data-autofocus': '', text: t('g.ask.cancel') });
      const yes = h('button', { type: 'button', class: `btn ${danger ? 'btn--danger' : 'btn--wood'}`, text: yesText || t('ask.yes') });
      actions.append(no, yes);
      no.addEventListener('click', () => dismiss());
      yes.addEventListener('click', () => finish(true));
      s.render = () => {};
    });
  }

  onLangChange(() => session?.render?.());

  const apiOut = { close, shade, burn, ask, isOpen: () => !!session };
  ctx.mods.confirm = apiOut;
  return apiOut;
}

function arrEq(a, b) {
  return !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

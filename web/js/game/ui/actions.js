/**
 * ui/actions.js — every money-moving command the HUD can send, in one place (GAME-DESIGN §6.5–§6.7, J3, J10).
 *
 *   const A = getActions(deps)
 *   A.command(op, params, target)   → Promise<body>  (never throws; body.error on failure)
 *   A.requestPlant(bean, slot, o)   opens the plant dialog (ui/plantDialog.js); a spectator gets the farm gate
 *   A.plant(bean, stake, slot, o)   → body           bot_create (the dialog calls this); o = { venue, ackDivergence }
 *   A.requestClose(botId, o)        harvest / pull confirm (J10) → bot_close
 *   A.requestShade(botId, o)        shade confirm when a position is held, else straight to bot_pause
 *   A.resume(botId, o)              bot_resume ("back in the sun")
 *   A.requestBurn(o)                burn confirm (checkbox) → bots_halt
 *   A.timelapse(o)                  tick {n: 60} — simulated prices only
 *   A.rearm() / A.resetSeason()     garden_rearm {confirm:'REARM'} / garden_reset {confirm:'RESET'} (accounts mode)
 *   A.failInfo(body)                localised {text, detail} of a failed body (errInfo with the page's mode)
 *   A.isPending(botId | 'burn' | 'tick' | 'bean:<id>')  · A.onChange(fn) → off
 *   A.isOwn(kind, key)              echo de-dup for the diary ('created', bean) / ('closed', bot) / …
 *
 * Rules:
 *   - J3 server first: nothing is shown as done before the 2xx. Buttons go busy (aria-disabled + data-busy, never
 *     `disabled`, so focus stays), effects come from the director via data.command's cmd:pending / cmd:done.
 *   - Shortcuts never reach this module: only explicit buttons and confirm dialogs call it (§5.2).
 *   - Prefer WP2's data.command(op, params, {target}); when the data layer is absent (HUD-only page) fall back to
 *     brood-api's command() and emit cmd:pending / cmd:done ourselves, so the rest of the page behaves the same.
 *
 * No three.js, no side effects at import.
 */

import * as api from '../../brood-api.js';
import { t, tn } from '../../i18n.js';
import { usd } from '../../format.js';
import { getCtx, emit } from './context.js';
import { errText, errInfo, patchUi, money } from './util.js';
import { announce } from './a11y.js';
import * as D from './derive.js';

const OWN_MS = 60_000;

export function getActions(deps) {
  const ctx = getCtx(deps);
  if (!ctx.actions) ctx.actions = createActions(ctx);
  return ctx.actions;
}

export function mount(deps) {
  return getActions(deps);
}

function createActions(ctx) {
  const { store } = ctx;
  const pending = new Map(); // key → { op, since }
  const own = new Map(); // `${kind}:${key}` → ms
  const fns = new Set();
  let seq = 0;

  const changed = () => {
    for (const fn of [...fns]) {
      try {
        fn();
      } catch (e) {
        console.error('[ui] actions listener failed', e);
      }
    }
  };

  function markOwn(kind, key) {
    own.set(`${kind}:${key}`, Date.now());
  }
  function isOwn(kind, key) {
    const at = own.get(`${kind}:${key}`);
    return at !== undefined && Date.now() - at < OWN_MS;
  }
  function unmarkOwn(kind, key) {
    own.delete(`${kind}:${key}`);
  }

  /** One command, through the data layer when there is one. Resolves to the body ({error, status} on failure). */
  async function command(op, params = {}, target = {}) {
    const key = target.key || `${op}:${target.bot ?? target.bean ?? ''}:${++seq}`;
    const pkey = target.bot ?? (target.bean !== undefined ? `bean:${target.bean}` : op === 'bots_halt' ? 'burn' : op === 'tick' ? 'tick' : key);
    pending.set(pkey, { op, since: Date.now() });
    changed();
    let body;
    try {
      if (typeof ctx.data?.command === 'function') {
        // data.command reads the plot from opts.slot / opts.target (an integer slot), §9.6
        const slot = Number.isInteger(target.slot) ? target.slot : undefined;
        body = await ctx.data.command(op, params, { slot, target: slot, ...(target.venue ? { venue: target.venue } : {}) });
      } else {
        const venue = target.venue ?? null;
        emit(ctx, 'cmd:pending', { op, key, slot: target.slot ?? null, bot: target.bot ?? null, venue });
        body = await api.command(op, params);
        emit(ctx, 'cmd:done', { op, key, slot: target.slot ?? null, bot: target.bot ?? null, venue, ok: !body?.error, body });
      }
    } catch (e) {
      body = { error: e?.message || String(e), status: e?.status ?? 0 };
    } finally {
      pending.delete(pkey);
      changed();
    }
    if (!body || typeof body !== 'object') body = { error: 'no answer', status: 0 };
    return body;
  }

  /** Error text for a failed body, in the page's words (localised by its machine code, PLATFORM §9.5). */
  function errOpts() {
    return { crossOrigin: api.apiIsCrossOrigin?.() || false, origin: api.apiOrigin?.() || '', accounts: D.isAccounts(store.get()) };
  }
  function failText(body) {
    return errText(body, errOpts());
  }
  function failInfo(body) {
    return errInfo(body, errOpts());
  }
  /** Accounts mode: a 401 means the session ended → the farm gate (g.gate.ended), never the token copy. */
  function maybeEnded(body) {
    if (body?.status === 401 && D.isAccounts(store.get())) ctx.mods.gate?.ended?.();
  }

  /** A failed command: diary + toast + polite announcement (the dialog shows it inline when open). */
  function failed(whatKey, body, { quiet = false } = {}) {
    maybeEnded(body);
    const msg = failText(body);
    const line = t('diary.failed', { what: t(whatKey), error: msg });
    ctx.mods.diary?.add?.(line, { kind: 'warn', cls: 'warn' });
    if (!quiet) {
      ctx.mods.toast?.show?.(line, { tone: 'warn' });
      announce(line);
    }
    return msg;
  }

  function botOf(botId) {
    return (store.get().bots || []).find((b) => b && b.id === botId) || null;
  }
  function slotOf(botId) {
    const v = D.viewOfBot(store.get(), botId);
    return v ? v.slot : null;
  }
  function refreshSoon() {
    try {
      ctx.data?.tend?.();
    } catch {
      /* polling catches up */
    }
  }

  // ------------------------------------------------------------------ plant

  function requestPlant(bean, slot = null, o = {}) {
    // a spectator plants nothing: the gate says "sign in to plant" (PLATFORM §9.1, QA-03)
    if (D.isSpectator(store.get())) {
      ctx.mods.gate?.open?.({ opener: o.opener, reason: 'plant' });
      return;
    }
    const dlg = ctx.mods.plantDialog;
    if (!dlg) return;
    dlg.open(bean, slot, o);
  }

  /** bot_create. `slot` is reserved in store.slots.wanted (beanId → slot) so the new bot lands where it was planted. */
  async function plant(bean, stake, slot, { venue = 'paper', ackDivergence = false } = {}) {
    const beanId = Number(bean.id);
    const s = store.get();
    const testnet = venue === 'testnet';
    if (Number.isInteger(slot)) {
      store.set({ slots: { ...(s.slots || {}), wanted: { ...(s.slots?.wanted || {}), [beanId]: slot } } });
    }
    markOwn('created', beanId);
    // paper keeps today's exact params (none mode is byte-identical); testnet adds the venue and its confirm word
    const params = { bean: beanId, capital_usd: Math.round(Number(stake)) };
    if (testnet) Object.assign(params, { venue: 'testnet', confirm: 'testnet' }, ackDivergence ? { ack_divergence: true } : {});
    const body = await command('bot_create', params, { bean: beanId, slot, coin: bean.coin, venue });
    if (body.error) {
      unmarkOwn('created', beanId);
      const cur = store.get();
      const wanted = { ...(cur.slots?.wanted || {}) };
      delete wanted[beanId];
      store.set({ slots: { ...(cur.slots || {}), wanted } });
      failed('act.plant', body, { quiet: true });
      return body;
    }
    const line = (testnet ? t('g.venue.testnet') + ' · ' : '') + t('diary.planted', { coin: bean.coin, bean: beanId, bot: body.id ?? '?', usd: usd(stake, 0) });
    ctx.mods.diary?.add?.(line, { kind: 'plant', key: `plant:${beanId}` });
    announce(line);
    patchUi(store, { pickBean: null, ...(Number.isInteger(slot) ? { selectedSlot: slot } : {}) });
    emit(ctx, 'ui:pick', { bean: null });
    if (Number.isInteger(slot)) emit(ctx, 'ui:select', { slot });
    refreshSoon();
    try {
      ctx.data?.restock?.();
    } catch {
      /* the next restock catches up */
    }
    return body;
  }

  // ------------------------------------------------------------------ close / shade / sun

  function requestClose(botId, o = {}) {
    const bot = botOf(botId);
    if (!bot || pending.has(botId)) return;
    // a testnet bot that is already closing: a second bot_close is never sent from the UI (§9.4)
    if (D.isTestnetBot(bot) && (bot.closing || bot.exchange_sync?.op === 'flatten')) {
      announce(t('g.state.closing'));
      return;
    }
    ctx.mods.confirm?.close?.(botId, o);
  }

  async function close(botId) {
    const bot = botOf(botId);
    if (!bot) return { error: t('g.insp.gone'), status: 404 };
    markOwn('closed', botId);
    const slot = slotOf(botId);
    const body = await command('bot_close', { id: botId }, { bot: botId, slot, coin: bot.coin });
    if (body.error) {
      unmarkOwn('closed', botId);
      failed('act.harvest', body, { quiet: true });
      return body;
    }
    // testnet: the answer is the BotRow while the IOC flatten runs; the result comes with bot_closed (§6.11)
    const stillClosing = D.isTestnetBot(bot) && body.state !== 'closed' && (body.closing || body.exchange_sync || body.realized_pnl === undefined);
    if (stillClosing) {
      unmarkOwn('closed', botId); // the bot_closed echo must write its line (the number is only known then)
      const line = t('g.venue.testnet') + ' · ' + t('g.diary.closing', { bot: botId, coin: bot.coin });
      ctx.mods.diary?.add?.(line, { kind: 'close', key: `closing:${botId}` });
      announce(line);
      refreshSoon();
      return body;
    }
    const banked = Number(body.realized_pnl);
    const line = (D.isTestnetBot(bot) ? t('g.venue.testnet') + ' · ' : '') + t(banked < 0 ? 'diary.pulled' : 'diary.harvested', { coin: bot.coin, usd: usd(banked, 2, true) });
    ctx.mods.diary?.add?.(line, { kind: 'close', key: `close:${botId}` });
    announce(line);
    refreshSoon();
    try {
      ctx.data?.restock?.();
    } catch {
      /* ignore */
    }
    return body;
  }

  function requestShade(botId, o = {}) {
    const bot = botOf(botId);
    if (!bot || pending.has(botId)) return;
    const v = D.viewOfBot(store.get(), botId);
    const szi = Number(v?.szi ?? bot.real?.szi) || 0;
    if (szi !== 0) ctx.mods.confirm?.shade?.(botId, o);
    else shade(botId); // flat: nothing to realize, shade runs directly with a pending state (§6.7)
  }

  async function shade(botId) {
    const bot = botOf(botId);
    if (!bot) return { error: t('g.insp.gone'), status: 404 };
    markOwn('paused', botId);
    const body = await command('bot_pause', { id: botId }, { bot: botId, slot: slotOf(botId), coin: bot.coin });
    if (body.error) {
      unmarkOwn('paused', botId);
      failed('act.pause', body);
      return body;
    }
    const line = t('diary.shaded', { bot: botId });
    ctx.mods.diary?.add?.(line, { kind: 'pause', key: `pause:${botId}:${Math.floor(Date.now() / 5000)}` });
    announce(line);
    refreshSoon();
    return body;
  }

  async function resume(botId) {
    const bot = botOf(botId);
    if (!bot || pending.has(botId)) return { error: t('g.insp.gone'), status: 404 };
    markOwn('resumed', botId);
    const body = await command('bot_resume', { id: botId }, { bot: botId, slot: slotOf(botId), coin: bot.coin });
    if (body.error) {
      unmarkOwn('resumed', botId);
      failed('act.resume', body);
      return body;
    }
    const line = t('diary.sun', { bot: botId });
    ctx.mods.diary?.add?.(line, { kind: 'resume', key: `resume:${botId}:${Math.floor(Date.now() / 5000)}` });
    announce(line);
    refreshSoon();
    return body;
  }

  // ------------------------------------------------------------------ burn / time-lapse

  function requestBurn(o = {}) {
    if (D.isSpectator(store.get())) {
      ctx.mods.gate?.open?.({ opener: o.opener });
      return;
    }
    if (D.isHalted(store.get()) || pending.has('burn')) return;
    ctx.mods.confirm?.burn?.(o);
  }

  async function burn() {
    const open = D.openBots(store.get()).map((b) => b.id);
    for (const id of open) markOwn('closed', id);
    markOwn('halted', '*');
    const body = await command('bots_halt', {}, { key: `burn:${Date.now()}` });
    if (body.error) {
      for (const id of open) unmarkOwn('closed', id);
      unmarkOwn('halted', '*');
      failed('act.burn', body, { quiet: true });
      return body;
    }
    // accounts mode: `closing` lists the testnet bots still flattening (their totals arrive on bot_closed)
    const n = (Array.isArray(body.closed) ? body.closed.length : 0) + (Array.isArray(body.closing) ? body.closing.length : 0);
    for (const id of Array.isArray(body.closing) ? body.closing : []) unmarkOwn('closed', id);
    // accounts mode: the result in the J4 money words (a loss never "banked"); none mode keeps the classic line
    const loss = Number(body.realized_pnl) < 0;
    const line = D.isAccounts(store.get())
      ? tn(loss ? 'g.diary.burnedLoss' : 'g.diary.burned', n, { usd: money(body.realized_pnl, { glyph: false }).text })
      : tn('diary.burned', n, { usd: usd(body.realized_pnl, 2, true) });
    ctx.mods.diary?.add?.(line, { kind: 'burn', key: 'burn' });
    announce(line);
    refreshSoon();
    try {
      ctx.data?.restock?.();
    } catch {
      /* ignore */
    }
    return body;
  }

  async function timelapse() {
    if (pending.has('tick')) return null;
    if (!D.isSim(store.get())) {
      ctx.mods.toast?.show?.(t('g.err.timelapseReal'), { tone: 'warn' });
      announce(t('g.err.timelapseReal'));
      return null;
    }
    markOwn('tick', '*');
    const body = await command('tick', { n: 60 }, { key: `tick:${Date.now()}` });
    if (body.error) {
      failed('act.timelapse', body);
      return body;
    }
    const line = t('diary.timelapse', { n: body.tick ?? '?' });
    ctx.mods.diary?.add?.(line, { kind: 'tick', key: `tl:${body.tick}` });
    announce(line);
    refreshSoon();
    try {
      ctx.data?.refreshMarket?.();
    } catch {
      /* ignore */
    }
    return body;
  }

  // ------------------------------------------------------------------ re-arm / new paper season (accounts mode)

  /** garden_rearm {confirm:'REARM'} (≥ 60 s after the burn, §8.4). */
  async function rearm() {
    markOwn('rearmed', '*');
    const body = await command('garden_rearm', { confirm: 'REARM' }, { key: `rearm:${Date.now()}` });
    if (body.error) {
      unmarkOwn('rearmed', '*');
      failed('g.rearm', body, { quiet: true });
      return body;
    }
    ctx.mods.diary?.add?.(t('g.diary.rearmed'), { kind: 'plant', key: 'rearm' });
    announce(t('g.diary.rearmed'));
    refreshSoon();
    try {
      ctx.data?.restock?.();
    } catch {
      /* ignore */
    }
    return body;
  }

  /** garden_reset {confirm:'RESET'}: closes the paper bots and starts a new paper season (§8.4). */
  async function resetSeason() {
    const paper = D.paperBots(store.get()).map((b) => b.id);
    for (const id of paper) markOwn('closed', id);
    const body = await command('garden_reset', { confirm: 'RESET' }, { key: `season:${Date.now()}` });
    if (body.error) {
      for (const id of paper) unmarkOwn('closed', id);
      failed('g.acct.reset', body, { quiet: true });
      return body;
    }
    const line = t('g.diary.seasonReset', { season: body.season ?? '?', n: Array.isArray(body.closed) ? body.closed.length : 0, usd: usd(body.realized_pnl ?? 0, 2, true) });
    ctx.mods.diary?.add?.(line, { kind: 'burn', key: `season:${body.season}` });
    announce(line);
    refreshSoon();
    try {
      ctx.data?.restock?.();
    } catch {
      /* ignore */
    }
    return body;
  }

  // ------------------------------------------------------------------ selection and camera focus (§5.3, §5.4)

  /** Select a plot (null clears). Two-way with the 3D field through store.ui.selectedSlot + bus ui:select. */
  function select(slot) {
    const cur = store.get().ui?.selectedSlot ?? null;
    if (cur === slot) return;
    patchUi(store, { selectedSlot: slot });
    emit(ctx, 'ui:select', { slot });
  }

  /**
   * Enter focus on a plot (§5.4). The camera follows store.ui.focusSlot (main.js flies the rig, dims the other
   * plots and pushes a history entry), so the UI only writes the store and tells the bus.
   */
  function focusPlot(slot) {
    if (!Number.isInteger(slot)) return;
    select(slot);
    patchUi(store, { focusSlot: slot });
    emit(ctx, 'ui:focus', { slot });
  }

  /** Leave focus: main.js sends the rig back to the previous view (600 ms; reduced motion: a cut). */
  function leaveFocus() {
    const was = store.get().ui?.focusSlot;
    if (was === null || was === undefined) return false;
    patchUi(store, { focusSlot: null });
    emit(ctx, 'ui:focus', { slot: null });
    return true;
  }

  /** True while a command for this bot / key is in flight (ours, or one the data layer reports). */
  function isPending(key) {
    if (pending.has(key)) return true;
    const p = store.get().ui?.pending;
    if (p && typeof p === 'object') {
      for (const [k, v] of Object.entries(p)) {
        if (!v) continue;
        if (k === key || v.bot === key || v.target?.bot === key || String(k).includes(`:${key}:`)) return true;
      }
    }
    return false;
  }

  return {
    command,
    failText,
    failInfo,
    failed,
    maybeEnded,
    rearm,
    resetSeason,
    requestPlant,
    plant,
    requestClose,
    close,
    requestShade,
    shade,
    resume,
    requestBurn,
    burn,
    timelapse,
    isPending,
    select,
    focusPlot,
    leaveFocus,
    isOwn,
    markOwn,
    onChange: (fn) => (fns.add(fn), () => fns.delete(fn)),
  };
}

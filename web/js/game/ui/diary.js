/**
 * ui/diary.js — the garden diary in the mailbox (GAME-DESIGN §6.8).
 *
 *   Parchment sheet, newest first, at most 60 lines, each with its clock time. Filter chips: all / fills /
 *   plantings / warnings. Lines come from the normalised bus events (`game:event`, core/data.js) plus the HUD's
 *   own command results (actions.js → add()); the echo of this page's own command is not written twice
 *   (`ev.own`, plus a de-dup key). Tick lines are throttled to one per 10 s (existing rule), time-lapse bursts
 *   are silent. Backfill on load from `events?limit=100` (P1).
 *   Warnings (errors, liquidations, busts, feed down/fallback, skipped orders) are also announced politely; the
 *   unread-warning count raises the mailbox flag (world.setUnread) and the •N badge, and clears when the diary
 *   opens.
 *
 * State: store.diary = [{ ms, kind, cls, text, key? }] (≤ 60, newest first) and store.ui.unread.
 * Exports: mount(deps) → { panel, add(text, {kind, cls, key, ms}), lineFor(ev) }, and the pure lineFor().
 * No three.js, no side effects at import.
 */

import * as api from '../../brood-api.js';
import { t, tn, onLangChange, hasKey } from '../../i18n.js';
import { usd, fmt, clock, isNum } from '../../format.js';
import { dirKey, fmtPx, fmtSz } from '../../model.js';
import { getCtx, on } from './context.js';
import { h, $, setText, watch, patchUi, clip, waitText, money } from './util.js';
import * as D from './derive.js';
import { getSheets } from './sheets.js';
import { announce } from './a11y.js';

const MAX = 60;
const TICK_LINE_MS = 10_000;
const KEY_MS = 60_000;
/** testnet_account arrives after every reconcile (each minute): one diary line per 10 minutes at most. */
const THROTTLE_MS = 600_000;
const FILTERS = [
  ['all', 'g.diary.filterAll'],
  ['fill', 'g.diary.filterFills'],
  ['plant', 'g.diary.filterPlants'],
  ['warn', 'g.diary.filterWarn'],
];
/** Which filter chip a line kind belongs to. */
const GROUP = { fill: 'fill', plant: 'plant', close: 'plant', pause: 'plant', resume: 'plant', burn: 'plant', warn: 'warn' };

/**
 * credential_status {status:'revoked'} reasons that are not "the key stopped working": the player's own disconnect is
 * a plain fact (info, no mailbox flag); the operator's and the account-moved ones say what happened (warn). Every
 * reason the server emits is in CREDENTIAL_REASONS (codes.js) and covered by the parity test.
 */
const CREDENTIAL_LINES = Object.freeze({
  disconnected: { key: 'g.diary.tnDisconnected', warn: false },
  admin_disconnect: { key: 'g.diary.tnAdminDisconnected', warn: true },
  password_reset: { key: 'g.diary.tnResetWiped', warn: true },
  account_moved: { key: 'g.diary.tnAccountMoved', warn: true },
});

/** A fee: two decimals, or two significant digits under one cent (never "$0.5172"). */
function feeText(x) {
  if (!isNum(x)) return '—';
  const v = Math.abs(Number(x));
  if (v > 0 && v < 0.01) return '$' + v.toPrecision(2);
  return usd(v, 2);
}

/** The venue word before a line about a testnet bot (PLATFORM §9.5: "Lines about a testnet bot are prefixed"). */
function venueTag(r, ctx) {
  const v = r.venue ?? (typeof ctx.venueOf === 'function' ? ctx.venueOf(r.bot) : null);
  return v === 'testnet' ? t('g.venue.testnet') + ' · ' : '';
}

/**
 * A machine code (live_error.code, bot_sync.code, note_code, credential reason) as localised words, never the
 * server's English text (§9.5). Unknown codes fall back to the clipped raw text.
 */
export function codeText(code, vars = {}, raw = '') {
  if (typeof code === 'string' && code) {
    if (hasKey('g.err.' + code)) return t('g.err.' + code, vars);
    if (hasKey('g.note.' + code)) return t('g.note.' + code, vars);
  }
  return clip(raw || code || '—', 160);
}

/** A pause note_code (§8.5): the note's own words first ("paused by the operator (testnet)"), then codeText. */
export function noteText(code, vars = {}, raw = '') {
  if (typeof code === 'string' && code && hasKey('g.note.' + code)) return t('g.note.' + code, vars);
  return codeText(code, vars, raw);
}

/** Variables of a note / error record ({exch, exp, coin} + the event's own coin). */
function varsOf(r) {
  const out = { coin: r.coin ?? '' };
  for (const src of [r.vars, r.note_vars]) if (src && typeof src === 'object') for (const [k, v] of Object.entries(src)) if (v !== null && v !== undefined && typeof v !== 'object') out[k] = v;
  if (isNum(r.retry_after_s)) out.time = waitText(r.retry_after_s);
  return out;
}

/**
 * Pure: the diary line for a normalised game event, or null (nothing worth a line).
 * → { text, kind, cls, key?, quiet?, throttle? } — kind ∈ fill | plant | close | pause | resume | burn | warn | tick |
 * feed | info. `ctx.szDecimals(coin)` formats sizes/prices like the venue; `ctx.venueOf(botId)` names a bot's venue.
 *
 * Accepts the normalised events of core/data.js (`type`) and, for the platform kinds of PLATFORM §8.7 that the data
 * layer may pass through un-normalised, the raw record kind (`kind`, fields on the event or in `raw`).
 */
export function lineFor(ev, ctx = {}) {
  if (!ev || (!ev.type && !ev.kind)) return null;
  const r = { ...(ev.raw && typeof ev.raw === 'object' ? ev.raw : {}), ...ev };
  const szd = (coin) => (typeof ctx.szDecimals === 'function' ? ctx.szDecimals(coin) : 0);
  const bot = r.bot ?? '';
  const coin = r.coin ?? '';
  const tag = venueTag(r, ctx);
  const tn0 = t('g.venue.testnet') + ' · ';
  const type = TYPE_OF_KIND[r.type] ?? r.type ?? TYPE_OF_KIND[r.kind] ?? r.kind;
  switch (type) {
    case 'fill': {
      if (r.liquidation) {
        const lost = isNum(r.closed_pnl) ? Math.abs(Number(r.closed_pnl)) : null;
        return { text: tag + t('g.diary.liquidated', { bot, coin, usd: lost === null ? '—' : usd(lost, 2) }), kind: 'warn', cls: 'warn' };
      }
      const dk = dirKey(r.dir);
      const line = t('diary.fill', { bot, dir: dk ? t(dk) : clip(r.dir ?? '', 40), sz: fmtSz(r.sz, szd(coin)), coin, px: fmtPx(r.px, szd(coin)) });
      // a provisional testnet fill: its fee is confirmed by the exchange later (≈, §9.6 J1); g.insp.feeEst carries
      // its own parentheses
      return { text: tag + line + (r.provisional ? ` · ${t('g.insp.feeEst')}` : ''), kind: 'fill', cls: '' };
    }
    case 'created':
      if (r.own) return { text: tag + t('diary.planted', { coin, bean: r.bean, bot, usd: usd(r.capital_usd, 0) }), kind: 'plant', cls: '', key: `plant:${r.bean}` };
      return { text: tag + t('diary.sprouted', { bot, coin, usd: usd(r.capital_usd, 0) }), kind: 'plant', cls: '' };
    case 'paused': {
      if (r.own) return null; // the command result already wrote it
      if (r.reason === 'liquidated') return null; // the liquidation fill line says it, with the amount
      // a machine note code (accounts mode) is localised; the English reason is the none-mode text only
      if (r.note_code) {
        const warn = r.note_code !== 'kill_switch' && r.note_code !== 'inactive';
        return { text: tag + t('diary.shadedWhy', { bot, reason: noteText(r.note_code, varsOf(r), r.reason) }), kind: warn ? 'warn' : 'pause', cls: warn ? 'warn' : '' };
      }
      if (r.reason) return { text: tag + t('diary.shadedWhy', { bot, reason: clip(r.reason, 120) }), kind: r.reason === 'bean busted' ? 'warn' : 'pause', cls: r.reason === 'bean busted' ? 'warn' : '' };
      return { text: tag + t('diary.shaded', { bot }), kind: 'pause', cls: '' };
    }
    case 'resumed':
      if (r.own) return null;
      return { text: tag + t('diary.sun', { bot }), kind: 'resume', cls: '' };
    case 'closed': {
      if (r.own || r.burn) return null;
      const loss = Number(r.realized_pnl) < 0;
      // testnet: an unconfirmed close carries ≈ until bot_fill_confirmed (§9.4 "After close")
      const est = r.venue === 'testnet' && r.confirmed === false;
      // accounts mode: a loss reads as one (never "banked"), with the typographic minus (J4); none mode keeps the
      // classic line byte for byte
      if (typeof ctx.accounts === 'function' && ctx.accounts()) {
        const m = money(r.realized_pnl, { est, glyph: false });
        return { text: tag + t(loss ? 'g.diary.closedLoss' : 'g.diary.closed', { bot, usd: m.text }), kind: 'close', cls: '' };
      }
      const amount = (est ? '≈ ' : '') + usd(r.realized_pnl, 2, true);
      return { text: tag + t(loss ? 'diary.closedLoss' : 'diary.closed', { bot, usd: amount }), kind: 'close', cls: '' };
    }
    case 'halted':
      if (r.own) return null;
      return { text: tn('diary.halted', Array.isArray(r.closed) ? r.closed.length : 0), kind: 'burn', cls: 'warn' };
    case 'error': {
      const what = r.code ? codeText(r.code, varsOf(r), r.error) : clip(r.error, 200);
      return { text: tag + t('diary.error', { bot, error: what }), kind: 'warn', cls: 'warn' };
    }
    case 'orderSkipped':
      return { text: tag + t('g.diary.capped', { bot }), kind: 'warn', cls: 'warn' };
    case 'tick':
      if (r.quiet) return null;
      return { text: t('diary.tick', { n: r.tick ?? '?' }), kind: 'tick', cls: 'quiet' };
    case 'busted':
      if (!r.onShelf && !r.planted) return null; // thousands of beans live and die; only the ones shown
      return { text: t('diary.busted', { bean: r.bean, coin }), kind: 'warn', cls: 'warn' };
    case 'feed': {
      const st = r.state;
      if (st === 'live') return { text: t(r.prev === 'down' || r.prev === 'delayed' ? 'g.diary.feedBack' : 'g.diary.feedReal'), kind: 'feed', cls: '' };
      if (st === 'delayed') return { text: t('g.diary.feedDelayed', { coins: (r.stale_coins || []).join(', ') || '—' }), kind: 'feed', cls: 'warn' };
      if (st === 'down') return { text: t('g.diary.feedDown'), kind: 'warn', cls: 'warn' };
      if (st === 'sim') return { text: t('g.diary.feedSim'), kind: r.fallback ? 'warn' : 'feed', cls: r.fallback ? 'warn' : '' };
      return null;
    }
    case 'gap':
      return { text: t(r.mode === 'rewarm' ? 'g.diary.gapRewarm' : 'g.diary.gapReplay', { n: fmt(r.bars) }), kind: 'feed', cls: '' };
    case 'warmup':
      return { text: t('diary.warmup', { n: fmt(r.bars) }), kind: 'info', cls: '' };
    case 'daemon':
      return { text: t('diary.daemon', { version: r.version ?? '?' }), kind: 'info', cls: '' };

    // ---------------------------------------------------------------- platform kinds (PLATFORM §8.7)
    case 'kill_switch':
      return r.on
        ? { text: t('g.diary.killOn', { reason: clip(r.reason || '—', 120) }), kind: 'warn', cls: 'warn' }
        : { text: t('g.diary.killOff'), kind: 'info', cls: '' };
    case 'testnet_feed': {
      if (r.state === 'down' || r.state === 'delayed') {
        // a signature_mismatch halt (reason 'signing') stops testnet orders for everyone (§6.9)
        const key = r.reason === 'signing' ? 'g.err.signature_mismatch' : r.state === 'down' ? 'g.diary.testnetDown' : 'g.diary.testnetDelayed';
        return { text: t(key), kind: 'warn', cls: 'warn', key: `tnfeed:${r.state}:${r.reason || ''}` };
      }
      if (r.state === 'live') return { text: t('g.diary.testnetBack'), kind: 'feed', cls: '', key: 'tnfeed:live' };
      return { text: t('g.diary.testnetOff'), kind: 'feed', cls: '' };
    }
    case 'bot_sync':
      if (r.state === 'failed') return { text: tn0 + t('g.diary.syncFailed', { bot, reason: codeText(r.code, varsOf(r), r.error) }), kind: 'warn', cls: 'warn', key: `sync:${bot}:${r.code || ''}` };
      if (r.state === 'done') return { text: tn0 + t('g.diary.syncDone', { bot }), kind: 'info', cls: 'quiet', quiet: true, key: `syncok:${bot}:${r.op || ''}` };
      return { text: tn0 + t('g.diary.syncPending', { bot }), kind: 'info', cls: 'quiet', quiet: true, key: `syncp:${bot}:${r.op || ''}` };
    case 'bot_fill_confirmed': {
      const result = isNum(r.closed_pnl) ? money(Number(r.closed_pnl) - (Number(r.fee) || 0), { glyph: false }).text : '—';
      return { text: tn0 + t('g.diary.feeConfirmed', { bot, fee: feeText(r.fee), usd: result }), kind: 'fill', cls: '' };
    }
    case 'testnet_account':
      return {
        text: tn0 + t('g.diary.testnetAccount', { usd: (r.account_value_est ? '≈ ' : '') + usd(r.account_value, 2), free: usd(r.free, 2) }),
        kind: 'info',
        cls: 'quiet',
        quiet: true,
        throttle: 'testnet_account',
      };
    case 'credential_status': {
      const bad = r.status === 'revoked' || r.status === 'error' || r.status === 'key_unavailable';
      if (bad) {
        const own = CREDENTIAL_LINES[r.reason];
        if (own) return { text: t(own.key), kind: own.warn ? 'warn' : 'info', cls: own.warn ? 'warn' : '' };
        // a localised cause in brackets — never a raw machine code in the player's language
        const known = typeof r.reason === 'string' && (hasKey('g.err.' + r.reason) || hasKey('g.note.' + r.reason));
        const text = known ? t('g.diary.credentialRevoked', { reason: codeText(r.reason) }) : t('g.diary.credentialRevokedPlain');
        return { text, kind: 'warn', cls: 'warn' };
      }
      return { text: t('g.diary.credentialOk'), kind: 'info', cls: '' };
    }
    case 'garden_rearmed':
      if (r.own) return null; // the command result already wrote it
      return { text: t('g.diary.rearmed'), kind: 'plant', cls: '', key: 'rearm' };
    case 'garden_reset':
      if (r.own) return null;
      return {
        text: t('g.diary.seasonReset', { season: r.season ?? '?', n: Array.isArray(r.closed) ? r.closed.length : isNum(r.closed) ? r.closed : 0, usd: usd(r.realized_pnl ?? 0, 2, true) }),
        kind: 'burn',
        cls: '',
        key: `season:${r.season}`,
      };
    case 'password_reset':
      return { text: t('g.diary.passwordReset'), kind: 'warn', cls: 'warn' };
    case 'session_ended':
      return { text: t('g.diary.sessionEnded'), kind: 'warn', cls: 'warn', key: 'session_ended' };
    case 'resync':
      return { text: t('g.diary.resync'), kind: 'info', cls: 'quiet', key: 'resync' };
    case 'server_restart':
      return { text: t('g.err.restarting'), kind: 'warn', cls: 'warn', key: 'server_restart' };
    default:
      return null;
  }
}

/** Raw journal kind → the normalised `type` lineFor() reads (backfill, and un-normalised platform records). */
const KIND_TYPE = {
  bot_fill: 'fill', bot_created: 'created', bot_paused: 'paused', bot_resumed: 'resumed', bot_closed: 'closed', live_halted: 'halted',
  live_error: 'error', bot_order: 'orderSkipped', tick_completed: 'tick', busted: 'busted', feed_status: 'feed', feed_gap: 'gap',
  warmup_finished: 'warmup', daemon_started: 'daemon',
};
/** The platform kinds lineFor() handles by their journal name (PLATFORM §8.7). */
export const PLATFORM_KINDS = Object.freeze([
  'kill_switch', 'testnet_feed', 'bot_sync', 'bot_fill_confirmed', 'testnet_account', 'credential_status', 'garden_rearmed', 'garden_reset',
  'password_reset', 'session_ended', 'resync', 'server_restart',
]);
/** Type names a data layer may give the platform kinds (camelCase twins) → the kind lineFor() switches on. */
const TYPE_OF_KIND = {
  ...KIND_TYPE,
  killSwitch: 'kill_switch', testnetFeed: 'testnet_feed', sync: 'bot_sync', botSync: 'bot_sync', fillConfirmed: 'bot_fill_confirmed',
  testnetAccount: 'testnet_account', credential: 'credential_status', credentialStatus: 'credential_status', rearmed: 'garden_rearmed',
  gardenRearmed: 'garden_rearmed', seasonReset: 'garden_reset', gardenReset: 'garden_reset', passwordReset: 'password_reset',
  sessionEnded: 'session_ended', serverRestart: 'server_restart',
};

export function recordEvent(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const type = KIND_TYPE[rec.kind] ?? (PLATFORM_KINDS.includes(rec.kind) ? rec.kind : null);
  if (!type) return null;
  if (type === 'orderSkipped' && rec.status !== 'skipped') return null;
  return { ...rec, type, ms: Number(rec.t) || Date.now(), backfill: true, closed_pnl: rec.closed_pnl, stale_coins: rec.stale_coins };
}

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('diary')) return ctx.mods.diary;
  const { store } = ctx;
  const sheets = getSheets(ctx);
  const p = sheets.panel('diary', { side: 'left', titleKey: 'diary.title', snap: 60, icon: 'i-diary' });
  let filter = 'all';
  let lastTickLine = 0;
  const keys = new Map(); // de-dup key → ms
  const seenSeq = new Set();
  const throttled = new Map(); // throttle name → ms of the last line (testnet_account: one per 10 min)
  // multi-user safety (PLATFORM §9.5): the buffer belongs to ONE player; a sign-in / sign-out clears it
  let owner = D.userOf(store.get())?.id ?? null;

  const chips = h('div', { class: 'chips-row', role: 'group' });
  const list = h('ol', { class: 'diary-list', 'aria-live': 'off' });
  p.body.append(chips, h('div', { class: 'parchment' }, list));
  const chipBtns = FILTERS.map(([id, key]) => {
    const b = h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(id === filter), dataset: { filter: id, key } });
    b.addEventListener('click', () => {
      filter = id;
      for (const x of chipBtns) x.setAttribute('aria-pressed', String(x.dataset.filter === filter));
      render();
    });
    return b;
  });
  chips.append(...chipBtns);

  /** Add one line (newest first). `key` de-dups the same fact written by the 2xx and by its SSE echo. */
  function add(text, { kind = 'info', cls = '', key = null, ms = Date.now(), quiet = false } = {}) {
    if (!text) return;
    const now = Date.now();
    if (key) {
      const at = keys.get(key);
      if (at !== undefined && now - at < KEY_MS) return;
      keys.set(key, now);
    }
    const s = store.get();
    const entry = { ms, kind, cls: cls || (kind === 'warn' ? 'warn' : ''), text: String(text), key: key || undefined, src: 'ui' };
    const next = [entry, ...(Array.isArray(s.diary) ? s.diary : [])].slice(0, MAX);
    const patch = { diary: next };
    if (kind === 'warn' && !p.isOpen()) patch.ui = { ...(s.ui || {}), unread: (Number(s.ui?.unread) || 0) + 1 };
    store.set(patch);
    if (kind === 'warn' && !quiet) announce(String(text));
  }

  function szDecimals(coin) {
    const c = store.get().market?.coins?.[coin];
    return Number(c?.sz_decimals) || 0;
  }
  /** A bot's venue from the store (live events carry `venue` in accounts mode; this covers echoes without it). */
  function venueOf(botId) {
    const b = (store.get().bots || []).find((x) => x && x.id === botId);
    return b ? D.venueOf(b) : null;
  }
  const lineCtx = { szDecimals, venueOf, accounts: () => D.isAccounts(store.get()) };

  /** One line from an event (game:event or a raw platform record), with the de-dup, throttle and own rules. */
  function take(ev) {
    if (!ev) return;
    const seq = ev.raw?.seq ?? ev.seq;
    if (Number.isFinite(seq)) {
      if (seenSeq.has(seq)) return;
      seenSeq.add(seq);
    }
    if (ev.type === 'tick') {
      if (ev.quiet || Date.now() - lastTickLine < TICK_LINE_MS) return;
      lastTickLine = Date.now();
    }
    const own = ev.own || (ev.type === 'created' && ctx.actions?.isOwn?.('created', ev.bean)) || (ev.type === 'closed' && ctx.actions?.isOwn?.('closed', ev.bot));
    const line = lineFor({ ...ev, own }, lineCtx);
    if (!line) return;
    if (line.throttle) {
      const at = throttled.get(line.throttle) || 0;
      if (Date.now() - at < THROTTLE_MS) return;
      throttled.set(line.throttle, Date.now());
    }
    add(line.text, { kind: line.kind, cls: line.cls, key: line.key || null, quiet: !!line.quiet });
  }

  on(ctx, 'game:event', take);
  // platform records the data layer forwards without normalising (PLATFORM §8.7 kinds): same lines
  on(ctx, 'data:record', (rec) => rec && PLATFORM_KINDS.includes(rec.kind) && take({ ...rec, raw: rec }));

  // P1: backfill the last 100 journal records once (oldest first, so the newest ends on top)
  async function backfill() {
    try {
      const rows = typeof ctx.data?.events === 'function' ? await ctx.data.events(100) : (await api.query('events', { limit: 100 }))?.rows;
      const recs = (Array.isArray(rows) ? rows : Array.isArray(rows?.rows) ? rows.rows : []).slice().reverse();
      const lines = [];
      let lastTick = 0;
      for (const rec of recs) {
        if (Number.isFinite(rec?.seq)) {
          if (seenSeq.has(rec.seq)) continue;
          seenSeq.add(rec.seq);
        }
        const ev = recordEvent(rec);
        if (!ev) continue;
        if (ev.type === 'tick') {
          if (ev.ms - lastTick < TICK_LINE_MS) continue;
          lastTick = ev.ms;
        }
        const line = lineFor({ ...ev, onShelf: true }, lineCtx);
        if (line && !line.quiet && !line.throttle) lines.push({ ms: ev.ms, kind: line.kind, cls: line.cls, text: line.text, src: 'backfill' });
      }
      if (!lines.length) return;
      const s = store.get();
      const merged = [...(Array.isArray(s.diary) ? s.diary : []), ...lines.reverse()].sort((a, b) => (b.ms || 0) - (a.ms || 0)).slice(0, MAX);
      store.set({ diary: merged });
    } catch {
      /* the diary simply starts today */
    }
  }

  // ------------------------------------------------------------------ render

  function render() {
    const s = store.get();
    for (const b of chipBtns) setText(b, t(b.dataset.key));
    const all = Array.isArray(s.diary) ? s.diary : [];
    const rows = all.filter((e) => filter === 'all' || GROUP[e.kind] === filter);
    // a spectator reads the PUBLIC diary: its first line says so (PLATFORM §9.1, QA-02)
    const head = D.isSpectator(s) ? h('li', { class: 'diary-line diary-line--signin', dataset: { kind: 'info' } }, h('span', { class: 'diary-text', text: t('g.diary.signIn') }), signInBtn) : null;
    if (head) setText(signInBtn, t('g.gate.signin'));
    if (!rows.length) {
      list.replaceChildren(...[head, h('li', { class: 'diary-empty', text: t('g.diary.empty') })].filter(Boolean));
    } else {
      list.replaceChildren(
        ...(head ? [head] : []),
        ...rows.map((e) => h('li', { class: `diary-line${e.cls ? ' diary-line--' + e.cls : ''}`, dataset: { kind: e.kind || 'info' } }, h('time', { class: 'diary-time num', datetime: new Date(e.ms || Date.now()).toISOString(), text: clock(e.ms || Date.now()) }), h('span', { class: 'diary-text', text: e.text }))),
      );
    }
    renderUnread();
  }

  function renderUnread() {
    const n = Number(store.get().ui?.unread) || 0;
    const badge = $('diaryUnread');
    if (badge) {
      badge.hidden = n <= 0;
      setText(badge, n > 9 ? '9+' : String(n));
      // aria-label is ignored on a generic span: the visible digit is hidden from AT and a visually hidden
      // "N unread" inside the button becomes part of its name ("Diary 3 unread")
      badge.removeAttribute('aria-label');
      badge.setAttribute('aria-hidden', 'true');
      let sr = $('diaryUnreadSr');
      if (!sr && badge.parentElement) {
        sr = h('span', { class: 'sr-only', id: 'diaryUnreadSr' });
        badge.after(sr);
      }
      if (sr) setText(sr, n > 0 ? t('g.diary.unread', { n }) : '');
    }
    try {
      ctx.stage?.world?.setUnread?.(n);
    } catch {
      /* the flag is decoration */
    }
  }

  const signInBtn = h('button', { type: 'button', class: 'btn btn--sm btn--wood diary-signin' });
  signInBtn.addEventListener('click', () => ctx.mods.gate?.open?.({ opener: signInBtn }));

  p.onOpen(() => {
    if (Number(store.get().ui?.unread) > 0) patchUi(store, { unread: 0 });
    render();
  });
  // a different player (sign-in, sign-out, account switch): forget the old player's lines and reload this one's
  watch(store, (st) => D.userOf(st)?.id ?? null, (id) => {
    if (id === owner) return;
    owner = id;
    keys.clear();
    seenSeq.clear();
    throttled.clear();
    store.set((st) => ({ diary: [], ui: { ...(st.ui || {}), unread: 0 } }));
    add(t('diary.welcome'), { kind: 'info' });
    setTimeout(backfill, 300);
    render();
  });
  watch(store, (st) => D.isSpectator(st), () => p.isOpen() && render());
  watch(store, (s) => s.diary, () => p.isOpen() && render());
  watch(store, (s) => s.ui?.unread, renderUnread);
  ctx.onStage(() => renderUnread());
  onLangChange(() => {
    p.setTitle(t('diary.title'));
    render();
  });

  add(t('diary.welcome'), { kind: 'info' });
  setTimeout(backfill, 1500);
  render();

  const apiOut = { panel: p, add, take, lineFor: (ev) => lineFor(ev, lineCtx) };
  ctx.mods.diary = apiOut;
  return apiOut;
}

/**
 * garden.js — the Bean Garden page.
 *
 *   seed packet = a top bean          plot = a simulated bot          water = capital_usd
 *   grow / wilt = PnL on the stake    ⛱ / ☀ = bot_pause / bot_resume  🧺 / 🪓 = bot_close
 *   🔥 burn the field = bots_halt     weather = market mean change_24h  sunrise = tick_completed
 *
 * Data flow: tend() (bots + live_status) and restock() (beans + equity_curves) fetch;
 * render*() update the DOM in place (plots are keyed by bot id so canvases, focus and
 * glow animations survive refreshes); a requestAnimationFrame loop repaints the plant
 * canvases from the latest state. SSE events and a 20 s poll trigger (debounced) refreshes.
 *
 * Every server-provided string reaches the DOM through textContent / attributes — no
 * innerHTML anywhere — and there are no inline handlers.
 */

import * as api from './brood-api.js';
import { fmt, pct, usd, signClass, ago, clock, price, size as fmtSize, isNum } from './format.js';
import { t, tn, initLang, setLang, getLang, applyI18n, onLangChange, agoUnits } from './i18n.js';
import { stage, drawPlant, drawSparkline, botPnl } from './plant.js';
import { SHELF_SIZE, WATER, FAMILY_TINT, shelfQuery, weatherOf, mirrorNote, stakeRoom, entryMargin, dirKey, familyOf } from './model.js';

// ------------------------------------------------------------------ constants

export const PLOTS = 8;
const POLL_MS = 20_000;
const WEATHER_MS = 120_000;
const TICK_LINE_MS = 10_000;
const DIARY_MAX = 60;
const GLOW_MS = 1600;
const FRAME_MS = 1000 / 30; // the sway is slow — 30 fps is plenty and halves the work
const TEND_DEBOUNCE_MS = 700;
const OWN_ECHO_MS = 15_000;
const FALLBACK_ARCHETYPES = ['standard', 'hyper_algo', 'degen_algo', 'swarm', 'swarm_5x', 'swarm_10x', 'swarm_25x', 'swarm_50x', 'swarm_100x'];
const FONT = '"Segoe UI", "Leelawadee UI", "Noto Sans Thai", Tahoma, system-ui, sans-serif';

// ------------------------------------------------------------------ pure helpers (exported for tests)
// The shared trading helpers live in model.js (also used by the 3D page) and are re-exported here
// unchanged, so the classic page and test/web.test.js keep importing them from garden.js.

export { WATER, shelfQuery, weatherOf, mirrorNote, stakeRoom, entryMargin, dirKey, familyOf } from './model.js';

/** Plot slots: open bots first (server order), then empty plots up to at least PLOTS. */
export function plotSlots(bots) {
  const open = (bots || []).filter((b) => b && b.state !== 'closed');
  const slots = open.slice();
  while (slots.length < PLOTS) slots.push(null);
  return slots;
}

const levText = (x) => (isNum(x) ? `${Math.round(Number(x))}x` : '—');
const posKey = (b) => (b?.in_position === 'long' || b?.in_position === 'short' ? b.in_position : Number(b?.side) > 0 ? 'long' : Number(b?.side) < 0 ? 'short' : 'flat');
const clip = (s, n = 240) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''));

// ------------------------------------------------------------------ state

/**
 * Accounts-mode copy (PLATFORM §9.4, QA-19): the burned-field strings that say "restart the server" have an
 * accounts-mode twin (the field is re-armed from the account menu on the 3D page). None mode keeps today's keys.
 */
const ACCOUNTS_COPY = Object.freeze({
  'plot.emptyHalted': 'plot.emptyHaltedRearm',
  'modal.halted': 'plot.emptyHaltedRearm',
  'shelf.noteHalted': 'shelf.noteHaltedRearm',
  'ask.burn': 'ask.burnAccounts',
});
const ck = (key) => (S.accounts && ACCOUNTS_COPY[key]) || key;

const S = {
  accounts: false, // PLATFORM §9: the server runs with accounts (sign-in lives on the 3D page)
  spectator: false, // accounts mode without a session: public data only, no user queries
  live: null, // last live_status
  bots: [], // last bots rows (all states)
  shelf: [], // bean rows on the shelf
  curves: {}, // "<bean id>" → [{h, equity}]
  curvesReady: false, // false while a restock is fetching curves (avoids a "no history" flash)
  sel: null, // selected bean id
  planting: null, // bean row in the plant dialog
  glow: new Map(), // bot id → glow start (performance.now())
  lastTickLine: 0,
  tendBusy: false,
  tendAgain: false,
  tendTimer: 0,
  restockSeq: 0,
  restockTimer: 0,
  shelfFailed: false, // the last restock failed: retry after the next good tend()
  tendFailed: false, // the last tend failed: signs and plots are stale
  lastTendOk: 0, // ms of the last good tend()
  weather: null,
  reduced: false,
  stream: null,
  streamState: 'off',
  streamSeen: false, // the first successful connection gets a diary line
  own: new Map(), // `${kind}:${bot}` → ms; hides the SSE echo of our own clicks
  labels: {},
  archetypes: FALLBACK_ARCHETYPES.slice(),
};

/** bot id → { root, tag, shade, reap, canvas, phase, pnl, water, fills, bot } */
const plotEls = new Map();
/** reusable empty-plot elements */
const emptyEls = [];

// ------------------------------------------------------------------ DOM helpers

const $ = (id) => document.getElementById(id);

/** createElement with attributes; `class` and `text` are shortcuts; null/false attributes are skipped. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/** Diary line, newest first, capped at DIARY_MAX. */
function diary(text, cls) {
  const list = $('diary');
  if (!list) return;
  list.prepend(h('li', { class: cls || null }, h('time', { datetime: new Date().toISOString(), text: clock() }), text));
  while (list.children.length > DIARY_MAX) list.lastElementChild.remove();
}

/** Screen-reader announcement for results of the user's own actions. */
function announce(text) {
  const el = $('announce');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => (el.textContent = text), 40);
}

function hint(text, isError = false) {
  const el = $('fieldMsg');
  el.textContent = text || '';
  el.classList.toggle('err', !!isError);
}

/** Readable error for a failed query (thrown Error) or command ({error, status}). */
function errText(e) {
  const status = e?.status;
  const msg = clip(e?.error ?? e?.message ?? e, 300);
  // accounts mode: a 401 is an ended session (sign in again on the 3D page), never the command-token copy
  if (status === 401 && S.accounts) return t('g.gate.ended');
  if (status === 401) return api.apiIsCrossOrigin() ? t('err.authRemote', { origin: api.apiOrigin() }) : t('err.auth');
  if (status === 0) return `${t('err.unreachable')} (${msg})`;
  return msg;
}

/** Remember that WE caused the next `kind` event for `bot`, so its SSE echo is not logged twice. */
function markOwn(kind, bot) {
  const now = Date.now();
  for (const [key, at] of S.own) if (now - at >= OWN_ECHO_MS) S.own.delete(key); // echoes that never came
  S.own.set(`${kind}:${bot}`, now);
}

function unmarkOwn(kind, bot) {
  S.own.delete(`${kind}:${bot}`);
}

/**
 * Planting races its own echo: the server emits `bot_created` (SSE) before it answers bot_create, but
 * either may reach the page first. Whichever arrives first writes the diary line; this says if we're first.
 */
function firstPlantLine(beanId) {
  const key = `planted:${beanId}`;
  const at = S.own.get(key);
  if (at !== undefined && Date.now() - at < OWN_ECHO_MS) {
    S.own.delete(key);
    return false;
  }
  if (S.streamState === 'live') markOwn('planted', beanId); // the other one may still come: tell it
  return true;
}

/**
 * Busy without `disabled`: disabling the focused button would blur it and drop keyboard focus to
 * <body>. aria-disabled tells assistive tech, the handlers ignore clicks while busy.
 */
function setBusy(btn, busy) {
  if (!btn) return;
  btn.dataset.busy = busy ? '1' : '';
  if (busy) btn.setAttribute('aria-disabled', 'true');
  else btn.removeAttribute('aria-disabled');
}

const isBusy = (btn) => btn?.dataset.busy === '1';

/** Disable a control; if it held focus, hand focus to `fallback` instead of letting it fall to <body>. */
function setDisabledKeepFocus(el, disabled, fallback) {
  if (!el || el.disabled === disabled) return;
  const hadFocus = document.activeElement === el;
  el.disabled = disabled;
  if (disabled && hadFocus) fallback?.focus();
}

const fieldBurned = () => !!S.live?.halted;

function isOwn(kind, bot) {
  const key = `${kind}:${bot}`;
  const at = S.own.get(key);
  if (at === undefined) return false;
  S.own.delete(key);
  return Date.now() - at < OWN_ECHO_MS;
}

const isPlanted = (beanId) => S.bots.some((b) => Number(b.bean) === Number(beanId) && b.state !== 'closed');
const beanById = (id) => S.shelf.find((b) => Number(b.id) === Number(id)) || null;

// ------------------------------------------------------------------ header

function modeText(L) {
  if (!L) return '—';
  if (L.mode === 'off') return t('sign.off');
  let s = String(L.mode || '—');
  if (L.network && L.network !== L.mode) s += ' · ' + L.network;
  if (L.halted) s += ' · ' + t('sign.halted');
  else if (L.armed === false) s += ' · ' + t('sign.notArmed');
  if (L.dry_run) s += ' · ' + t('sign.dryRun');
  return s;
}

function setSign(id, text, tone = '') {
  const el = $(id);
  if (!el) return;
  setText(el.querySelector('.v'), text);
  el.classList.toggle('up', tone === 'up');
  el.classList.toggle('down', tone === 'down');
}

function renderSigns() {
  const L = S.live;
  setSign('signMode', modeText(L));
  setSign('signBarn', usd(L?.account_state?.account_value));
  setSign('signWater', usd(L?.deployed_usd, 0));
  setSign('signHarvested', usd(L?.realized_pnl, 2, true), signClass(L?.realized_pnl));
  setSign('signGrowing', usd(L?.unrealized_pnl, 2, true), signClass(L?.unrealized_pnl));
  setSign('signPlants', fmt(L?.active));
  setDisabledKeepFocus($('burn'), !!L?.halted, $('field'));
  // time-lapse is a simulation-only control: hidden for a non-sim live layer AND for real prices
  // (with real prices the server answers `tick` with 409 — real markets run at market speed)
  const tl = $('timelapse');
  if (tl) tl.hidden = !!(L && ((L.mode && L.mode !== 'sim') || L.prices === 'real'));
}

function renderWeather() {
  const el = $('weather');
  if (!el) return;
  const w = S.weather;
  el.textContent = w ? `${t('weather.' + w.key)} · ${t('weather.detail', { pct: pct(w.mean, 1) })}` : t('weather.unknown');
  document.body.dataset.weather = w ? w.key : 'unknown';
}

async function weather() {
  try {
    const m = await api.query('market');
    S.weather = weatherOf(m.coins);
  } catch {
    S.weather = null; // weather is decoration: just say "unknown"
  }
  renderWeather();
}

function setStreamState(state) {
  S.streamState = state;
  const badge = $('liveBadge');
  if (!badge) return;
  badge.dataset.state = state;
  setText($('liveText'), t(state === 'live' ? 'live.on' : state === 'reconnecting' ? 'live.reconnecting' : 'live.polling'));
}

/** Short token state in the 🔑 summary, plus WHERE commands go whenever that is not this page's server. */
function renderTokenState(flash) {
  const cross = api.apiIsCrossOrigin();
  const origin = api.apiOrigin();
  setText($('tokState'), flash ? t(flash) : api.hasToken() ? t('token.saved') : t(cross ? 'token.noneRemote' : 'token.none'));
  const hostEl = $('tokHost');
  if (hostEl) {
    hostEl.hidden = !cross;
    setText(hostEl, cross ? ` → ${hostOf(origin)}` : '');
    hostEl.title = cross ? t('token.apiOther', { origin }) : '';
    hostEl.classList.toggle('warn', cross && api.apiUntrusted());
  }
  const apiEl = $('tokApi');
  if (apiEl) {
    apiEl.hidden = !cross;
    setText(apiEl, cross ? t(api.apiUntrusted() ? 'token.apiLink' : 'token.apiOther', { origin }) : '');
    apiEl.classList.toggle('warn', cross && api.apiUntrusted());
  }
}

function tokenMessage(text, isWarn = false) {
  const el = $('tokMsg');
  if (!el) return;
  setText(el, text || '');
  el.classList.toggle('warn', !!isWarn);
}

function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return String(origin);
  }
}

/** Save the typed token; a `?api=` link to another origin needs an explicit "yes, that host is mine". */
async function saveToken(value) {
  let trustApi = false;
  if (String(value).trim() && api.apiUntrusted() && !api.tokenProblem(value)) {
    const origin = api.apiOrigin();
    trustApi = await ask({
      title: t('token.trustTitle', { host: hostOf(origin) }),
      body: t('token.trust', { origin }),
      yes: t('token.trustYes', { host: hostOf(origin) }),
      danger: true,
    });
    if (!trustApi) return;
  }
  try {
    const saved = api.setToken(value, { trustApi });
    $('tokInput').value = '';
    tokenMessage('');
    renderTokenState(saved ? 'token.saved' : 'token.cleared');
    announce(t(saved ? 'token.saved' : 'token.cleared'));
  } catch (e) {
    const key = e?.code === 'chars' ? 'token.badChars' : 'token.apiLink';
    tokenMessage(t(key, { origin: api.apiOrigin() }), true);
    announce(t(key, { origin: api.apiOrigin() }));
  }
}

function updateLangButtons() {
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === getLang()));
}

function buildLabels() {
  S.labels = {
    waiting: t('cap.waiting'),
    entering: t('cap.entering'),
    shade: t('cap.shade'),
    wilting: t('cap.wilting'),
    dying: t('cap.dying'),
    ripe: t('cap.ripe'),
  };
}

// ------------------------------------------------------------------ field

async function tend() {
  // a spectator has no garden: the shelf and the market work, the user queries are never called (QA-13)
  if (S.spectator) {
    renderSigns();
    renderField();
    return;
  }
  if (S.tendBusy) {
    S.tendAgain = true;
    return;
  }
  S.tendBusy = true;
  try {
    const [bots, live] = await Promise.all([api.query('bots'), api.query('live_status')]);
    S.bots = Array.isArray(bots.rows) ? bots.rows : [];
    S.live = live && typeof live === 'object' ? live : null;
    setText($('netMsg'), '');
    const recovered = S.tendFailed;
    S.tendFailed = false;
    S.lastTendOk = Date.now();
    // Back after an outage (or the shelf never loaded): restock — SSE may be off (?nostream=1).
    if (recovered || S.shelfFailed) scheduleRestock(200);
  } catch (e) {
    S.tendFailed = true;
    // status 0 = network failure: the template already says "can't reach", so show the raw cause;
    // an HTTP error means the server IS reachable but unhappy.
    setText($('netMsg'), e?.status === 0
      ? t('field.unreachable', { error: clip(e.message, 300) })
      : t('field.serverError', { error: errText(e) }));
  } finally {
    renderStale();
    renderSigns();
    renderField();
    renderFieldNotes();
    syncPackets();
    S.tendBusy = false;
    if (S.tendAgain) {
      S.tendAgain = false;
      scheduleTend(150);
    }
  }
}

/** Dim the signs and plots while their numbers are from before a failed refresh, and say since when. */
function renderStale() {
  const since = S.tendFailed && S.lastTendOk ? t('field.stale', { time: clock(S.lastTendOk) }) : '';
  for (const id of ['signs', 'plots']) {
    const el = $(id);
    if (!el) continue;
    el.classList.toggle('stale', S.tendFailed);
    if (since) {
      el.setAttribute('aria-description', since);
      el.title = since;
    } else {
      el.removeAttribute('aria-description');
      el.removeAttribute('title');
    }
  }
}

/** Coalescing refresh: the first request arms a timer, later ones ride along (no starvation under bursts). */
function scheduleTend(delay = TEND_DEBOUNCE_MS) {
  if (S.tendTimer) return;
  S.tendTimer = setTimeout(() => {
    S.tendTimer = 0;
    tend();
  }, delay);
}

function scheduleRestock(delay = 1000) {
  clearTimeout(S.restockTimer);
  S.restockTimer = setTimeout(restock, delay);
}

function makePlot(bot) {
  const p = {
    tag: h('span', { class: 'tag' }),
    shade: h('button', { type: 'button', 'data-act': 'pause' }),
    reap: h('button', { type: 'button', 'data-act': 'harvest' }),
    canvas: h('canvas', { class: 'plant', role: 'img' }),
    phase: h('span', { class: 'phase' }),
    pnl: h('b', { class: 'pnl' }),
    water: h('span', { class: 'water' }),
    fills: h('span', { class: 'fills' }),
    bot,
  };
  p.root = h(
    'div',
    { class: 'plot', role: 'group', tabindex: '-1', 'data-bot': bot.id },
    h('div', { class: 'plot-head' }, p.tag, h('div', { class: 'tools' }, p.shade, p.reap)),
    p.canvas,
    h('div', { class: 'label' }, p.phase, p.pnl),
    h('div', { class: 'label dim' }, p.water, p.fills),
  );
  p.root.id = 'plot-' + bot.id;
  return p;
}

function setTool(btn, glyph, label, act) {
  setText(btn, glyph);
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.dataset.act = act;
}

function updatePlot(p, bot) {
  p.bot = bot;
  const s = stage(bot);
  const phaseName = t('phase.' + s.phase);
  setText(p.tag, `${bot.coin} · ${bot.id}`);
  const active = bot.state === 'active';
  setTool(p.shade, active ? '⛱' : '☀', t(active ? 'plot.pause' : 'plot.resume', { bot: bot.id }), active ? 'pause' : 'resume');
  const ripe = s.usd >= 0;
  setTool(p.reap, ripe ? '🧺' : '🪓', t(ripe ? 'plot.harvest' : 'plot.pull', { bot: bot.id }), ripe ? 'harvest' : 'pull');
  setText(p.phase, phaseName + (bot.last_error ? ' ⚠' : ''));
  p.phase.title = bot.last_error ? clip(bot.last_error, 300) : '';
  setText(p.pnl, `${usd(s.usd, 2, true)} · ${pct(s.frac, 1)}`);
  p.pnl.className = 'pnl ' + signClass(s.usd);
  setText(p.water, t('plot.water', { usd: usd(bot.capital_usd, 0) }));
  setText(p.fills, tn('plot.fills', bot.fills, { n: fmt(bot.fills), ago: ago(bot.last_reconcile_ms || bot.updated_ms, Date.now(), agoUnits()) }));
  p.canvas.setAttribute('aria-label', t('plot.canvas', { coin: bot.coin, phase: phaseName, pnl: `${usd(s.usd, 2, true)} (${pct(s.frac, 1)})` }));
  p.root.setAttribute('aria-label', `${bot.coin} · ${bot.id}`);
}

function makeEmpty() {
  return h('div', { class: 'plot empty', role: 'button', tabindex: '0' }, h('span', { class: 'empty-title' }), h('span', { class: 'empty-hint' }));
}

function updateEmpty(el, slot) {
  const burned = fieldBurned();
  const sel = S.sel != null && !burned ? beanById(S.sel) : null;
  el.dataset.slot = String(slot);
  setText(el.querySelector('.empty-title'), t('plot.empty'));
  setText(el.querySelector('.empty-hint'), burned ? t(ck('plot.emptyHalted')) : sel ? t('packet.pick', { coin: sel.coin }) : t('plot.emptyHint'));
  el.setAttribute(
    'aria-label',
    burned ? `${t('plot.emptyLabel', { n: slot })}: ${t(ck('plot.emptyHalted'))}` : sel ? t('plot.emptyLabelSel', { n: slot, coin: sel.coin }) : t('plot.emptyLabel', { n: slot }),
  );
  if (burned) el.setAttribute('aria-disabled', 'true');
  else el.removeAttribute('aria-disabled');
  el.classList.toggle('armed', !!sel);
  el.classList.toggle('burned', burned);
}

/** Keyed, in-place field render: max(8, open bots) plots in server order. */
function renderField() {
  const box = $('plots');
  if (!box) return;
  const slots = plotSlots(S.bots);
  const liveIds = new Set();
  let emptyIdx = 0;
  const wanted = slots.map((bot, i) => {
    if (bot) {
      liveIds.add(bot.id);
      let p = plotEls.get(bot.id);
      if (!p) {
        p = makePlot(bot);
        plotEls.set(bot.id, p);
      }
      updatePlot(p, bot);
      return p.root;
    }
    const el = emptyEls[emptyIdx] || (emptyEls[emptyIdx] = makeEmpty());
    emptyIdx++;
    updateEmpty(el, i + 1);
    return el;
  });
  for (const [id, p] of plotEls) {
    if (!liveIds.has(id)) {
      p.root.remove();
      plotEls.delete(id);
      S.glow.delete(id);
    }
  }
  wanted.forEach((node, i) => {
    if (box.children[i] !== node) box.insertBefore(node, box.children[i] || null);
  });
  while (box.children.length > wanted.length) box.lastElementChild.remove();
  requestDraw();
}

function renderEmptyLabels() {
  for (const el of document.querySelectorAll('#plots .plot.empty')) updateEmpty(el, Number(el.dataset.slot) || 0);
}

/** Live error line + past harvests (closed bots with realized PnL). */
function renderFieldNotes() {
  const L = S.live;
  const errEl = $('liveError');
  if (errEl) {
    errEl.textContent = L?.last_error ? `⚠ ${t('field.liveError')} ${L.last_error_ms ? clock(L.last_error_ms) + ' · ' : ''}${clip(L.last_error, 300)}` : '';
  }
  const hv = $('harvests');
  if (!hv) return;
  const closed = S.bots
    .filter((b) => b.state === 'closed')
    .sort((a, b) => (Number(b.closed_ms) || 0) - (Number(a.closed_ms) || 0));
  hv.hidden = !closed.length;
  if (!closed.length) return;
  const parts = [h('span', { text: `${t('field.pastHarvests')} (${closed.length}): ` })];
  closed.slice(0, 8).forEach((b, i) => {
    if (i) parts.push(' · ');
    parts.push(`${b.coin} `, h('b', { class: signClass(b.realized_pnl), text: usd(b.realized_pnl, 2, true) }));
  });
  if (closed.length > 8) parts.push(' · …');
  hv.replaceChildren(...parts);
}

function glowPlot(botId) {
  if (!botId) return;
  S.glow.set(botId, performance.now());
  const p = plotEls.get(botId);
  if (p) {
    p.root.classList.remove('glow');
    void p.root.offsetWidth; // restart the CSS animation
    p.root.classList.add('glow');
    // one timer per plot: an older fill's timer must not cut a newer fill's glow short
    clearTimeout(p.glowTimer);
    p.glowTimer = setTimeout(() => p.root.classList.remove('glow'), GLOW_MS);
  }
  requestDraw();
  if (S.reduced) setTimeout(requestDraw, GLOW_MS + 30);
}

// ------------------------------------------------------------------ canvas rendering

let rafId = 0;
let lastFrame = -Infinity;

function requestDraw() {
  if (!rafId && typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(frame);
}

/** Size a canvas to its CSS box × devicePixelRatio and return a context in CSS pixels. */
function fitCanvas(c) {
  const w = c.clientWidth;
  const hgt = c.clientHeight;
  if (!w || !hgt) return null;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
  const W = Math.max(1, Math.round(w * dpr));
  const H = Math.max(1, Math.round(hgt * dpr));
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(W / w, 0, 0, H / hgt, 0, 0);
  return { ctx, w, h: hgt };
}

function drawPlot(p, now) {
  const fit = fitCanvas(p.canvas);
  if (!fit) return false;
  let glow = 0;
  const g0 = S.glow.get(p.bot.id);
  if (g0 !== undefined) {
    const k = (now - g0) / GLOW_MS;
    if (k >= 1 || k < 0) S.glow.delete(p.bot.id);
    else glow = S.reduced ? 0.6 : 1 - k;
  }
  drawPlant(fit.ctx, fit.w, fit.h, p.bot, now, { labels: S.labels, reducedMotion: S.reduced, glow, font: FONT });
  return glow > 0;
}

function frame(now) {
  rafId = 0;
  const animate = !S.reduced && !document.hidden && plotEls.size > 0;
  if (animate && now - lastFrame < FRAME_MS - 2) {
    requestDraw();
    return;
  }
  lastFrame = now;
  let glowing = false;
  for (const p of plotEls.values()) glowing = drawPlot(p, now) || glowing;
  if (animate || (glowing && !S.reduced)) requestDraw();
}

function drawSparks() {
  if (!S.curvesReady) return;
  for (const c of document.querySelectorAll('#packets canvas.spark')) {
    const fit = fitCanvas(c);
    if (!fit) continue;
    drawSparkline(fit.ctx, fit.w, fit.h, S.curves[c.dataset.bean] || S.curves[Number(c.dataset.bean)], {
      base: 1000,
      empty: t('packet.noHistory'),
      font: FONT,
    });
  }
}

// ------------------------------------------------------------------ seed shelf

async function restock() {
  clearTimeout(S.restockTimer);
  const seq = ++S.restockSeq;
  const box = $('packets');
  box.setAttribute('aria-busy', 'true');
  if (!S.shelf.length) box.replaceChildren(h('li', { class: 'shelf-msg', text: t('shelf.stocking') }));
  try {
    const halted = !!S.live?.halted;
    const q = shelfQuery({ sort: $('by').value, archetype: $('arch').value, sproutingOnly: $('posOnly').checked, halted });
    let r = await api.query('beans', q);
    // a backend that has not learnt its venue listing yet says so — show everything rather than nothing
    if (q.tradeable && r.venue && r.venue.known === false) r = await api.query('beans', { ...q, tradeable: undefined });
    if (seq !== S.restockSeq) return;
    S.shelfFailed = false;
    S.shelf = (Array.isArray(r.rows) ? r.rows : []).slice(0, SHELF_SIZE);
    if (S.sel != null && !beanById(S.sel)) S.sel = null;
    setText($('venueNote'), halted ? t(ck('shelf.noteHalted')) : t('shelf.note'));
    S.curvesReady = false;
    renderPackets();
    if (S.shelf.length) {
      try {
        const c = await api.query('equity_curves', { ids: S.shelf.map((b) => b.id) });
        if (seq !== S.restockSeq) return;
        S.curves = c && c.curves && typeof c.curves === 'object' ? c.curves : {};
      } catch {
        S.curves = {}; // sparklines fall back to "no history yet"
      }
      S.curvesReady = true;
      drawSparks();
    }
  } catch (e) {
    if (seq !== S.restockSeq) return;
    S.shelfFailed = true; // retried by the next good tend() (works without SSE too)
    S.shelf = [];
    S.sel = null;
    box.replaceChildren(h('li', { class: 'shelf-msg err', role: 'alert', text: t('shelf.error', { error: errText(e) }) }));
    renderEmptyLabels();
  } finally {
    if (seq === S.restockSeq) box.removeAttribute('aria-busy');
  }
}

function makePacket(b) {
  const el = h(
    'div',
    { class: 'packet', role: 'button', 'data-bean': b.id },
    h('span', { class: 'band' }, h('span', { class: 'coin', text: b.coin }), h('span', { class: 'lev', text: levText(b.leverage) })),
    h('span', { class: 'variety', text: `${b.archetype} · ${b.strategy} · ${levText(b.leverage)}` }),
    h('canvas', { class: 'spark', 'data-bean': b.id, 'aria-hidden': 'true' }),
    h('span', { class: 'ret ' + signClass(b.total_return), text: pct(b.total_return) }),
    h('span', { class: 'meta' }),
  );
  el.style.setProperty('--tint', FAMILY_TINT[b.family || familyOf(b.archetype)] || FAMILY_TINT.standard);
  updatePacket(el, b);
  return h('li', { class: 'packet-slot' }, el);
}

/** Dynamic packet bits (planted / selected / labels) — also used after every tend(). */
function updatePacket(el, b) {
  const planted = isPlanted(b.id);
  const burned = fieldBurned();
  const selected = !planted && !burned && Number(S.sel) === Number(b.id);
  el.classList.toggle('planted', planted);
  el.classList.toggle('sel', selected);
  el.classList.toggle('burned', burned && !planted);
  el.tabIndex = planted ? -1 : 0; // a burned field's packets stay readable by keyboard
  el.draggable = !planted && !burned;
  el.setAttribute('aria-pressed', String(selected));
  if (planted || burned) el.setAttribute('aria-disabled', 'true');
  else el.removeAttribute('aria-disabled');
  const pos = t('pos.' + posKey(b));
  setText(el.querySelector('.meta'), `${tn('packet.fills', b.trades, { n: fmt(b.trades) })} · ${pos}${planted ? ' · ' + t('packet.planted') : ''}`);
  el.setAttribute(
    'aria-label',
    t('packet.label', { coin: b.coin, variety: `${b.archetype} · ${b.strategy} · ${levText(b.leverage)}`, ret: pct(b.total_return), pos }) +
      (planted ? ' — ' + t('packet.planted') : selected ? ' — ' + t('packet.selected') : ''),
  );
}

function renderPackets() {
  const box = $('packets');
  if (!S.shelf.length) {
    box.replaceChildren(h('li', { class: 'shelf-msg', text: t('shelf.empty') }));
  } else {
    const focusedBean = document.activeElement?.closest?.('#packets .packet')?.dataset.bean;
    box.replaceChildren(...S.shelf.map(makePacket));
    if (focusedBean) box.querySelector(`.packet[data-bean="${CSS.escape(focusedBean)}"]`)?.focus();
  }
  renderEmptyLabels();
  requestAnimationFrame(drawSparks);
}

function syncPackets() {
  let selectionLost = false;
  for (const el of document.querySelectorAll('#packets .packet')) {
    const b = beanById(el.dataset.bean);
    if (!b) continue;
    if (isPlanted(b.id) && Number(S.sel) === Number(b.id)) {
      S.sel = null;
      selectionLost = true;
    }
    updatePacket(el, b);
  }
  if (selectionLost) renderEmptyLabels();
}

function toggleSelect(beanId) {
  const b = beanById(beanId);
  if (!b) return;
  if (fieldBurned()) {
    hint(t(ck('modal.halted')), true);
    return;
  }
  if (isPlanted(b.id)) {
    hint(t('packet.alreadyPlanted', { coin: b.coin }));
    return;
  }
  S.sel = Number(S.sel) === Number(b.id) ? null : b.id;
  for (const el of document.querySelectorAll('#packets .packet')) {
    const pb = beanById(el.dataset.bean);
    if (pb) updatePacket(el, pb);
  }
  renderEmptyLabels();
  hint(S.sel != null ? t('packet.pick', { coin: b.coin }) : '');
}

// ------------------------------------------------------------------ dialogs

let dialogOpener = null;

function showDialog(dlg) {
  dialogOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (typeof dlg.showModal === 'function') {
    if (!dlg.open) dlg.showModal();
  } else {
    dlg.classList.add('fallback');
    dlg.setAttribute('open', '');
  }
}

function closeDialog(dlg) {
  if (typeof dlg.close === 'function' && dlg.open && !dlg.classList.contains('fallback')) dlg.close();
  else if (dlg.hasAttribute('open')) {
    dlg.removeAttribute('open');
    dlg.dispatchEvent(new Event('close')); // the native path fires this itself
  }
}

function restoreFocus(fallback) {
  const target = dialogOpener && dialogOpener.isConnected ? dialogOpener : fallback;
  dialogOpener = null;
  if (target && typeof target.focus === 'function') target.focus();
}

/** Keep Tab inside an open dialog; Esc closes it (native dialogs also do this themselves). */
function trapFocus(dlg) {
  dlg.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && dlg.classList.contains('fallback')) {
      ev.preventDefault();
      closeDialog(dlg);
      return;
    }
    if (ev.key !== 'Tab') return;
    const items = [...dlg.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')].filter(
      (x) => !x.disabled && x.offsetParent !== null,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  });
}

/** Promise-based confirm built on <dialog id="askDlg">; resolves true only on "yes". */
let askResolve = null;
function ask({ title, body, yes, danger = false }) {
  const dlg = $('askDlg');
  if (askResolve) askResolve(false);
  setText($('askTitle'), title);
  setText($('askBody'), body);
  setText($('askYes'), yes || t('ask.yes'));
  setText($('askNo'), t('ask.no'));
  $('askYes').classList.toggle('danger', !!danger);
  $('askYes').classList.toggle('go', !danger);
  return new Promise((resolve) => {
    askResolve = resolve;
    showDialog(dlg);
    // safer default focus on destructive questions
    (danger ? $('askNo') : $('askYes')).focus();
  });
}

function settleAsk(value) {
  const r = askResolve;
  askResolve = null;
  closeDialog($('askDlg'));
  if (r) r(value);
}

// ------------------------------------------------------------------ planting

function openPlant(bean) {
  if (fieldBurned()) {
    hint(t(ck('modal.halted')), true);
    return;
  }
  if (!bean) {
    hint(t('modal.gone'), true);
    return;
  }
  if (isPlanted(bean.id)) {
    hint(t('packet.alreadyPlanted', { coin: bean.coin }));
    return;
  }
  S.planting = bean;
  setText($('mTitle'), t('modal.title', { coin: bean.coin, id: bean.id }));
  setText($('mVar'), `${bean.archetype} · ${bean.strategy} · ${levText(bean.leverage)}`);
  setText($('mRet'), t('modal.onPaper', { pct: pct(bean.total_return) }));
  $('mRet').className = signClass(bean.total_return);
  $('mRange').value = String(WATER.def);
  setText($('mMsg'), '');
  setBusy($('mGo'), false);
  setText($('mGo'), t('modal.plant'));
  updateWaterNote();
  showDialog($('plantDlg'));
  $('mRange').focus();
}

/** Stake, notional and margin notes; warns (and blocks planting) when the field has no room for the stake. */
function updateWaterNote() {
  const v = Number($('mRange').value) || WATER.def;
  setText($('mAmt'), usd(v, 0));
  $('mRange').setAttribute('aria-valuetext', usd(v, 0));
  const b = S.planting;
  if (!b) return;
  const n = mirrorNote(b, v);
  setText($('mNote'), t('modal.note', { pct: n.pct.toFixed(1), usd: usd(n.notional, 0) }));
  const cap = Number(b.venue_max_leverage);
  const levNote = isNum(b.venue_max_leverage) && Number(b.leverage) > cap ? t('modal.levCap', { n: cap }) : '';
  const margin = entryMargin(b, v);
  const marginNote = margin > v * 1.005 ? t('modal.margin', { usd: usd(margin, 0) }) : '';
  setText($('mLev'), [levNote, marginNote].filter(Boolean).join(' · '));

  // Room under the open-notional cap (and the cash left): say it up front instead of after a 409.
  const room = stakeRoom(b, S.live);
  const capText = room ? usd(room.cap, 0) : '';
  let roomNote = '';
  let blocked = false;
  if (room && room.maxStake < WATER.min) {
    roomNote = t('modal.full', { cap: capText });
    blocked = true;
  } else if (room && v > room.maxStake) {
    roomNote = t('modal.overCap', { usd: usd(room.maxStake, 0), cap: capText });
    blocked = true;
  } else if (room && room.maxStake < WATER.max) {
    roomNote = t('modal.maxStake', { usd: usd(room.maxStake, 0) });
  }
  const roomEl = $('mRoom');
  setText(roomEl, roomNote);
  roomEl.classList.toggle('warn', blocked);
  $('mGo').dataset.blocked = blocked ? '1' : '';
  if (blocked || isBusy($('mGo'))) $('mGo').setAttribute('aria-disabled', 'true');
  else $('mGo').removeAttribute('aria-disabled');
}

async function submitPlant(ev) {
  ev.preventDefault();
  const b = S.planting;
  const go = $('mGo');
  if (!b || isBusy(go)) return;
  if (go.dataset.blocked === '1') {
    setText($('mMsg'), $('mRoom').textContent);
    return;
  }
  const amt = Math.round(Number($('mRange').value) || WATER.def);
  setBusy(go, true);
  setText(go, t('modal.planting'));
  setText($('mMsg'), '');
  markOwn('bot_created', 'bean:' + b.id); // the bot id is unknown until the answer: key the echo by bean
  const out = await api.command('bot_create', { bean: Number(b.id), capital_usd: amt });
  setBusy(go, false);
  setText(go, t('modal.plant'));
  if (out.error) {
    unmarkOwn('bot_created', 'bean:' + b.id);
    setText($('mMsg'), errText(out));
    updateWaterNote();
    return;
  }
  S.sel = null;
  closeDialog($('plantDlg'));
  const line = t('diary.planted', { coin: b.coin, bean: b.id, bot: out.id ?? '?', usd: usd(amt, 0) });
  if (firstPlantLine(b.id)) diary(line); // else the SSE echo already wrote it
  announce(line);
  hint('');
  await tend();
  if (out.id) {
    glowPlot(out.id);
    plotEls.get(out.id)?.root.focus();
  }
  restock();
}

// ------------------------------------------------------------------ plot actions

async function onTool(act, botId, btn) {
  const bot = S.bots.find((b) => b.id === botId);
  if (!bot || isBusy(btn)) return;
  let out;
  let line = '';
  // The button keeps focus while busy (see setBusy); updatePlot reuses the same node afterwards.
  if (act === 'harvest' || act === 'pull') {
    const p = botPnl(bot);
    const ok = await ask({
      title: t(act === 'harvest' ? 'ask.harvestTitle' : 'ask.pullTitle', { coin: bot.coin }),
      body: t('ask.' + act, { bot: bot.id, coin: bot.coin, pnl: usd(p.usd, 2, true) }),
      yes: act === 'harvest' ? '🧺 ' + t('ask.yes') : '🪓 ' + t('ask.yes'),
      danger: act === 'pull',
    });
    if (!ok) return;
    setBusy(btn, true);
    markOwn('bot_closed', bot.id);
    out = await api.command('bot_close', { id: bot.id });
    if (!out.error) {
      const banked = isNum(out.realized_pnl) ? Number(out.realized_pnl) : p.usd;
      line = t(act === 'harvest' ? 'diary.harvested' : 'diary.pulled', { coin: bot.coin, usd: usd(banked, 2, true) });
    }
  } else if (act === 'pause') {
    setBusy(btn, true);
    markOwn('bot_paused', bot.id);
    out = await api.command('bot_pause', { id: bot.id });
    if (!out.error) line = t('diary.shaded', { bot: bot.id });
  } else if (act === 'resume') {
    setBusy(btn, true);
    markOwn('bot_resumed', bot.id);
    out = await api.command('bot_resume', { id: bot.id });
    if (!out.error) line = t('diary.sun', { bot: bot.id });
  } else {
    return;
  }
  setBusy(btn, false);
  if (out.error) {
    failed(act === 'pull' ? 'act.harvest' : 'act.' + act, out);
  } else {
    diary(line);
    announce(line);
    hint('');
  }
  await tend();
  if (act === 'harvest' || act === 'pull') {
    // the plot (and the focused button) is gone: keep keyboard users in the field
    if (!btn.isConnected) document.querySelector('#plots .plot.empty')?.focus();
    restock();
  }
}

function failed(whatKey, out) {
  const msg = errText(out);
  hint(`⚠ ${t(whatKey)}: ${msg}`, true);
  diary(t('diary.failed', { what: t(whatKey), error: msg }), 'warn');
}

function onEmptyPlot() {
  if (fieldBurned()) {
    hint(t(ck('modal.halted')), true);
    return;
  }
  if (S.sel == null) {
    hint(t('packet.pickFirst'));
    return;
  }
  openPlant(beanById(S.sel));
}

async function burnField() {
  const ok = await ask({ title: t('ask.burnTitle'), body: t(ck('ask.burn')), yes: '🔥 ' + t('ask.yes'), danger: true });
  if (!ok) return;
  const btn = $('burn');
  if (isBusy(btn)) return;
  setBusy(btn, true);
  // bots_halt closes every open bot: the summary line below covers them, so their echoes stay quiet
  const open = S.bots.filter((b) => b.state !== 'closed').map((b) => b.id);
  for (const id of open) markOwn('bot_closed', id);
  markOwn('live_halted', '*');
  const out = await api.command('bots_halt', {});
  setBusy(btn, false);
  if (out.error) {
    for (const id of open) unmarkOwn('bot_closed', id);
    unmarkOwn('live_halted', '*');
    failed('act.burn', out);
  } else {
    const n = Array.isArray(out.closed) ? out.closed.length : 0;
    const line = tn('diary.burned', n, { usd: usd(out.realized_pnl, 2, true) });
    diary(line);
    announce(line);
  }
  await tend(); // disables 🔥 (halted) — focus moves to the field rather than <body>
  restock();
}

async function timeLapse() {
  const btn = $('timelapse');
  if (isBusy(btn)) return;
  setBusy(btn, true);
  btn.setAttribute('aria-busy', 'true');
  setText(btn, t('field.timelapseBusy'));
  // The tick_completed burst arrives over SSE BEFORE the answer: silence its sunrise line up front.
  const quietBefore = S.lastTickLine;
  S.lastTickLine = Date.now();
  const out = await api.command('tick', { n: 60 });
  setBusy(btn, false);
  btn.removeAttribute('aria-busy');
  setText(btn, t('field.timelapse'));
  if (out.error) {
    S.lastTickLine = quietBefore;
    failed('act.timelapse', out);
  } else {
    const line = t('diary.timelapse', { n: out.tick ?? '?' });
    diary(line);
    announce(line);
    S.lastTickLine = Date.now(); // and the next regular tick waits its usual 10 s
  }
  await tend();
  restock();
  weather();
}

// ------------------------------------------------------------------ live events

function onEvent(kind, rec) {
  const bot = rec.bot ?? '';
  switch (kind) {
    case 'tick_completed':
      if (Date.now() - S.lastTickLine >= TICK_LINE_MS) {
        S.lastTickLine = Date.now();
        diary(t('diary.tick', { n: rec.tick ?? '?' }));
      }
      scheduleTend();
      break;
    case 'bot_fill': {
      const dk = dirKey(rec.dir);
      diary(t('diary.fill', { bot, dir: dk ? t(dk) : clip(rec.dir ?? '', 40), sz: fmtSize(rec.sz), coin: rec.coin ?? '', px: price(rec.px) }));
      glowPlot(bot);
      scheduleTend(250);
      break;
    }
    case 'bot_created':
      if (isOwn(kind, 'bean:' + rec.bean)) {
        // our own plant: its echo often beats the HTTP answer — write the one "planted" line now
        if (firstPlantLine(rec.bean)) {
          diary(t('diary.planted', { coin: rec.coin ?? '', bean: rec.bean, bot, usd: usd(rec.capital_usd, 0) }));
        }
      } else {
        diary(t('diary.sprouted', { bot, coin: rec.coin ?? '', usd: usd(rec.capital_usd, 0) }));
      }
      scheduleTend(150);
      scheduleRestock();
      break;
    case 'bot_paused':
      if (!isOwn(kind, bot)) diary(rec.reason ? t('diary.shadedWhy', { bot, reason: clip(rec.reason, 120) }) : t('diary.shaded', { bot }));
      scheduleTend(150);
      break;
    case 'bot_resumed':
      if (!isOwn(kind, bot)) diary(t('diary.sun', { bot }));
      scheduleTend(150);
      break;
    case 'bot_closed':
      if (!isOwn(kind, bot)) {
        const loss = Number(rec.realized_pnl) < 0;
        diary(t(loss ? 'diary.closedLoss' : 'diary.closed', { bot, usd: usd(rec.realized_pnl, 2, true) }));
      }
      scheduleTend(150);
      scheduleRestock();
      break;
    case 'bot_order':
      scheduleTend();
      break;
    case 'live_error':
      diary(t('diary.error', { bot, error: clip(rec.error, 200) }), 'warn');
      scheduleTend();
      break;
    case 'live_halted':
      if (!isOwn(kind, '*')) diary(tn('diary.halted', Array.isArray(rec.closed) ? rec.closed.length : 0));
      scheduleTend(150);
      scheduleRestock();
      break;
    case 'busted':
      // thousands of beans live and die; only mention the ones this page shows
      if (beanById(rec.bean) || S.bots.some((b) => Number(b.bean) === Number(rec.bean) && b.state !== 'closed')) {
        diary(t('diary.busted', { bean: rec.bean, coin: rec.coin ?? '' }), 'warn');
        scheduleRestock();
      }
      break;
    case 'warmup_finished':
      diary(t('diary.warmup', { n: fmt(rec.bars) }));
      scheduleRestock();
      weather();
      break;
    case 'daemon_started':
      diary(t('diary.daemon', { version: rec.version ?? '?' }));
      scheduleTend();
      scheduleRestock();
      break;
    default:
      break;
  }
}

function startStream() {
  if (api.streamDisabled()) {
    setStreamState('polling');
    return;
  }
  let es = null;
  es = api.stream(onEvent, {
    onOpen: () => {
      const wasDown = S.streamState !== 'live';
      setStreamState('live');
      if (!S.streamSeen) {
        S.streamSeen = true;
        diary(t('diary.streamOn'));
      }
      if (wasDown) scheduleTend(100); // catch up on anything missed while disconnected
    },
    onError: () => {
      if (!es) return;
      if (es.readyState === 2) {
        // the browser gave up (e.g. HTTP error): poll, and try again later
        setStreamState('polling');
        es.close();
        S.stream = null;
        setTimeout(startStream, 15_000);
      } else setStreamState('reconnecting');
    },
  });
  S.stream = es;
  setStreamState('polling'); // becomes "live" on open; polling runs regardless
}

// ------------------------------------------------------------------ wiring

function fillVarieties() {
  const sel = $('arch');
  const keep = sel.value;
  const first = sel.options[0];
  sel.replaceChildren(first, ...S.archetypes.map((name) => h('option', { value: name, text: name })));
  sel.value = S.archetypes.includes(keep) ? keep : '';
}

async function loadMeta() {
  try {
    const m = await api.query('meta');
    const names = (m.archetypes || []).map((a) => (typeof a === 'string' ? a : a && a.name)).filter((n) => typeof n === 'string' && n);
    if (names.length) {
      S.archetypes = names;
      fillVarieties();
    }
  } catch {
    /* keep the built-in list */
  }
}

function onLanguage() {
  applyI18n();
  updateLangButtons();
  buildLabels();
  renderSigns();
  renderWeather();
  renderTokenState();
  renderField();
  renderFieldNotes();
  setStreamState(S.streamState);
  if (S.shelf.length) {
    renderPackets();
    setText($('venueNote'), S.live?.halted ? t(ck('shelf.noteHalted')) : t('shelf.note'));
  }
  if ($('plantDlg').open && S.planting) {
    setText($('mTitle'), t('modal.title', { coin: S.planting.coin, id: S.planting.id }));
    setText($('mRet'), t('modal.onPaper', { pct: pct(S.planting.total_return) }));
    setText($('mGo'), t(isBusy($('mGo')) ? 'modal.planting' : 'modal.plant'));
    updateWaterNote();
  }
  hint('');
}

function wire() {
  // language + token
  for (const b of document.querySelectorAll('[data-lang]')) b.addEventListener('click', () => setLang(b.dataset.lang));
  onLangChange(onLanguage);
  $('tokForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    saveToken($('tokInput').value);
  });

  // shelf filters
  $('restock').addEventListener('click', () => restock());
  for (const id of ['arch', 'by', 'posOnly']) $(id).addEventListener('change', () => restock());

  // packets: click / keyboard / drag
  const packets = $('packets');
  packets.addEventListener('click', (ev) => {
    const p = ev.target.closest('.packet');
    if (p) toggleSelect(p.dataset.bean);
  });
  packets.addEventListener('keydown', (ev) => {
    const p = ev.target.closest('.packet');
    if (!p || ev.target !== p || (ev.key !== 'Enter' && ev.key !== ' ')) return;
    ev.preventDefault();
    toggleSelect(p.dataset.bean);
  });
  packets.addEventListener('dragstart', (ev) => {
    const p = ev.target.closest?.('.packet');
    if (!p || p.classList.contains('planted') || fieldBurned()) {
      ev.preventDefault();
      return;
    }
    if (Number(S.sel) !== Number(p.dataset.bean)) toggleSelect(p.dataset.bean);
    ev.dataTransfer.setData('text/plain', String(p.dataset.bean));
    ev.dataTransfer.effectAllowed = 'copy';
  });

  // plots: tools, empty plots, drop targets
  const plots = $('plots');
  plots.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (btn) {
      onTool(btn.dataset.act, btn.closest('.plot')?.dataset.bot, btn);
      return;
    }
    if (ev.target.closest('.plot.empty')) onEmptyPlot();
  });
  plots.addEventListener('keydown', (ev) => {
    const empty = ev.target.closest?.('.plot.empty');
    if (!empty || ev.target !== empty || (ev.key !== 'Enter' && ev.key !== ' ')) return;
    ev.preventDefault();
    onEmptyPlot();
  });
  plots.addEventListener('dragover', (ev) => {
    const e = ev.target.closest?.('.plot.empty');
    if (!e) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    e.classList.add('target');
  });
  plots.addEventListener('dragleave', (ev) => {
    const e = ev.target.closest?.('.plot.empty');
    if (e && !e.contains(ev.relatedTarget)) e.classList.remove('target');
  });
  plots.addEventListener('drop', (ev) => {
    const e = ev.target.closest?.('.plot.empty');
    if (!e) return;
    ev.preventDefault();
    e.classList.remove('target');
    const id = ev.dataTransfer.getData('text/plain');
    if (fieldBurned()) hint(t(ck('modal.halted')), true);
    else if (id && beanById(id)) {
      S.sel = Number(id);
      openPlant(beanById(id));
    }
  });

  // field buttons
  $('burn').addEventListener('click', burnField);
  $('timelapse').addEventListener('click', timeLapse);

  // plant dialog
  const plantDlg = $('plantDlg');
  $('mRange').addEventListener('input', updateWaterNote);
  $('plantForm').addEventListener('submit', submitPlant);
  $('mCancel').addEventListener('click', () => closeDialog(plantDlg));
  plantDlg.addEventListener('close', () => {
    S.planting = null;
    restoreFocus($('field'));
  });
  trapFocus(plantDlg);

  // confirm dialog
  const askDlg = $('askDlg');
  $('askYes').addEventListener('click', () => settleAsk(true));
  $('askNo').addEventListener('click', () => settleAsk(false));
  askDlg.addEventListener('close', () => {
    if (askResolve) settleAsk(false); // Esc / backdrop close = "no"
    restoreFocus(null);
  });
  trapFocus(askDlg);

  // motion + size
  const mq = globalThis.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  S.reduced = !!mq?.matches;
  mq?.addEventListener?.('change', () => {
    S.reduced = mq.matches;
    requestDraw();
  });
  let resizeTimer = 0;
  addEventListener('resize', () => {
    requestDraw();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawSparks, 150);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      requestDraw();
      scheduleTend(100);
    }
  });

  // never leave a blank page on an unexpected script error
  addEventListener('error', (ev) => hint(t('err.page', { error: clip(ev.message, 200) }), true));
  addEventListener('unhandledrejection', (ev) => hint(t('err.page', { error: clip(ev.reason?.message ?? ev.reason, 200) }), true));
}

function boot() {
  initLang();
  buildLabels();
  applyI18n();
  updateLangButtons();
  // ?token= → saved, then stripped from the address bar (dropped if the link also points ?api= elsewhere)
  const adopted = api.adoptUrlParams();
  renderTokenState();
  if (adopted.ignored) {
    const msg = t(adopted.ignored === 'chars' ? 'token.urlBadChars' : 'token.urlIgnored', { origin: api.apiOrigin() });
    tokenMessage(msg, true);
    hint('⚠ ' + msg, true);
  }
  fillVarieties();
  wire();
  renderSigns();
  renderWeather();
  renderField();
  diary(t('diary.welcome'));
  loadMeta();
  detectAccounts().finally(() => tend().then(restock));
  weather();
  startStream();
  setInterval(tend, POLL_MS);
  setInterval(weather, WEATHER_MS);
}

/**
 * Accounts mode on the classic page (PLATFORM §12.1 WP5, P1): the session cookie works here as on the 3D page;
 * the command-token box is hidden; a spectator reads "sign in on the 3D garden" (sign-in lives there) and the page
 * stays a read-only shelf. None mode: nothing changes.
 */
async function detectAccounts() {
  let mode = null;
  try {
    const r = await fetch(`${api.getBase()}/api/v1`, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    mode = await r.json();
  } catch {
    return;
  }
  if (mode?.auth !== 'accounts') return;
  S.accounts = true;
  const box = $('tokBox');
  if (box) box.hidden = true;
  let me = null;
  try {
    me = await api.query('me');
  } catch {
    me = null;
  }
  S.spectator = !me?.user;
  if (!S.spectator) return;
  const note = $('fieldMsg');
  if (note) {
    note.replaceChildren(h('span', {}, t('g.classic.signIn') + ' '), h('a', { href: '/' }, t('g.gate.signin')));
  }
}

// Only boot on the garden page itself, so the module stays importable (e.g. from tests).
if (typeof document !== 'undefined' && document.getElementById('plots')) boot();

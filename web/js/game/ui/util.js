/**
 * ui/util.js — small DOM + formatting helpers shared by every ui/* module (WP5).
 *
 * Rules this file enforces for the whole HUD (GAME-DESIGN §6.13, §9.1):
 *   - no innerHTML with data: h() builds nodes, text goes through textContent;
 *   - no inline style attributes: dynamic geometry uses CSSOM (el.style.x = …);
 *   - money always carries a sign, a colour class AND a glyph (▲ / ▼), zero is neutral;
 *   - price direction is neutral ink with ▴ / ▾ (never green/red, J6);
 *   - estimates are prefixed "≈" (J1).
 *
 * No three.js, no side effects at import (testable under node --test).
 */

import { usd, pct, isNum, ago, clock } from '../../format.js';
import { t, agoUnits, hasKey } from '../../i18n.js';

export const SPRITE = '/img/icons.svg';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Coins that have their own crop (§3.1); anything else is the beanstalk. */
export const CROP_COINS = Object.freeze(['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE', 'AVAX', 'LINK', 'SUI', 'NEAR', 'ARB', 'TIA', 'ZEC', 'WIF', 'PUMP', 'VVV']);
const CROP_SET = new Set(CROP_COINS);

/** Age thresholds (§6.13 rule 5): ≤ 15 s fresh, ≤ 60 s delayed, else stale. */
export const AGE_FRESH_MS = 15_000;
export const AGE_DELAYED_MS = 60_000;

// ------------------------------------------------------------------ DOM

const doc = () => globalThis.document;

/** createElement with attributes; `class`, `text` and `dataset` are shortcuts; null/false attributes are skipped. */
export function h(tag, attrs = {}, ...kids) {
  const el = doc().createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid?.nodeType ? kid : String(kid));
  }
}

/** An <svg class="ico"><use href="/img/icons.svg#id"/></svg> (decorative unless `label` is given). */
export function icon(id, { cls = '', label = null } = {}) {
  const svg = doc().createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', ('ico ' + cls).trim());
  svg.setAttribute('focusable', 'false');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else svg.setAttribute('aria-hidden', 'true');
  const use = doc().createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `${SPRITE}#${id}`);
  svg.append(use);
  return svg;
}

/** textContent only when it changed (avoids needless layout and screen-reader chatter). */
export function setText(el, text) {
  if (!el) return;
  const s = text === null || text === undefined ? '' : String(text);
  if (el.textContent !== s) el.textContent = s;
}

/** Set/remove an attribute (null/undefined/false removes). */
export function setAttr(el, name, value) {
  if (!el) return;
  if (value === null || value === undefined || value === false) el.removeAttribute(name);
  else {
    const s = value === true ? '' : String(value);
    if (el.getAttribute(name) !== s) el.setAttribute(name, s);
  }
}

/** Replace children only when the node list differs. */
export function replaceKids(el, kids) {
  if (!el) return;
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

/** el.hidden that tolerates null. */
export function show(el, on) {
  if (el && el.hidden === !!on) el.hidden = !on;
}

export const $ = (id) => doc()?.getElementById(id) || null;

let uidN = 0;
/** A page-unique id with a readable prefix (label/for pairs, aria-labelledby). */
export function uid(prefix = 'u') {
  uidN += 1;
  return `${prefix}-${uidN}`;
}

/**
 * Busy without `disabled` (existing classic pattern): disabling the focused button would drop keyboard focus
 * to <body>. aria-disabled tells assistive tech; handlers check isBusy()/isBlocked().
 */
export function setBusy(btn, busy) {
  if (!btn) return;
  btn.dataset.busy = busy ? '1' : '';
  syncAriaDisabled(btn);
}
export const isBusy = (btn) => btn?.dataset.busy === '1';

/** A "blocked" button keeps focusability but reads as disabled and refuses clicks (reason shown elsewhere). */
export function setBlocked(btn, blocked) {
  if (!btn) return;
  btn.dataset.blocked = blocked ? '1' : '';
  syncAriaDisabled(btn);
}
export const isBlocked = (btn) => btn?.dataset.blocked === '1';

function syncAriaDisabled(btn) {
  if (btn.dataset.busy === '1' || btn.dataset.blocked === '1') btn.setAttribute('aria-disabled', 'true');
  else btn.removeAttribute('aria-disabled');
}

/** Is the event target a text field / select / dialog (single-key shortcuts must stay quiet, WCAG 2.1.4)? */
export function isTypingTarget(target) {
  const el = target?.nodeType === 1 ? target : null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
  return !!el.closest?.('dialog[open], [role="dialog"][aria-modal="true"]');
}

/** Visible focusable descendants (for focus traps and default focus). */
export function focusables(root) {
  if (!root) return [];
  return [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter(
    (x) => !x.disabled && !x.hidden && x.getClientRects().length > 0,
  );
}

/** Keep Tab inside `root` (used by modal dialogs; native showModal already makes the page inert). */
export function trapTab(root, ev) {
  if (ev.key !== 'Tab') return;
  const items = focusables(root);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = doc().activeElement;
  if (ev.shiftKey && (active === first || !root.contains(active))) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (active === last || !root.contains(active))) {
    ev.preventDefault();
    first.focus();
  }
}

// ------------------------------------------------------------------ storage (never throws)

export function readJSON(key, fallback = null) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** → true when written, false when storage is blocked. */
export function writeJSON(key, value) {
  try {
    if (!globalThis.localStorage) return false;
    globalThis.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ store helpers

/** Subscribe to a store slice AND run once now (WP2's select() may or may not fire immediately). */
export function watch(store, selector, fn, equals = Object.is) {
  let prev;
  let first = true;
  const run = (val) => {
    if (!first && equals(val, prev)) return;
    first = false;
    const old = prev;
    prev = val;
    try {
      fn(val, old);
    } catch (e) {
      console.error('[ui] render failed', e);
    }
  };
  let off = () => {};
  if (typeof store?.select === 'function') off = store.select(selector, (v) => run(v), equals) || off;
  try {
    run(selector(store.get()));
  } catch (e) {
    console.error('[ui] initial render failed', e);
  }
  return off;
}

/** Shallow equality for small arrays / objects of primitives. */
export function shallowEq(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/** Patch `store.ui` (always with a plain patch object, so any shallow-merge store works). */
export function patchUi(store, patch) {
  const s = store.get();
  store.set({ ui: { ...(s.ui || {}), ...patch } });
}

// ------------------------------------------------------------------ money (J1, J2, §6.13)

/**
 * Money text with sign, glyph and tone: +$3.10 ▲ (up) · -$8.20 ▼ (down) · $0.00 (zero, neutral).
 * `est` prefixes "≈ " (client estimate). `glyph: false` drops the ▲/▼ (when a sibling already shows it).
 */
export function money(x, { est = false, glyph = true, d = 2 } = {}) {
  if (!isNum(x)) return { text: '—', tone: 'none' };
  const v = Number(x);
  // the typographic minus (U+2212), as the % beside it uses: an ASCII hyphen sits shorter and higher in
  // tabular numerals. format.js keeps the hyphen for the classic page and its tests.
  const body = usd(v, d, true).replace(/^-/, '−');
  const zero = body === usd(0, d);
  const tone = zero ? 'zero' : v > 0 ? 'up' : 'down';
  const g = glyph && !zero ? (tone === 'up' ? ' ▲' : ' ▼') : '';
  return { text: (est ? '≈ ' : '') + body + g, tone };
}

/** A <span class="money money--up">+$3.10 ▲</span>. */
export function moneyEl(x, opts = {}) {
  const m = money(x, opts);
  return h('span', { class: `money money--${m.tone}${opts.cls ? ' ' + opts.cls : ''}`, text: m.text });
}

/** Update an existing money span in place (J2: the number changes the moment data arrives). */
export function setMoney(el, x, opts = {}) {
  if (!el) return;
  const m = money(x, opts);
  setText(el, m.text);
  const cls = `money money--${m.tone}${opts.cls ? ' ' + opts.cls : ''}`;
  if (el.className.baseVal === undefined && el.className !== cls) el.className = cls;
}

/** Signed percentage of a fraction (0.031 → "+3.1%"). */
export function pctText(frac, d = 1) {
  return pct(frac, d);
}

/** Price direction in neutral ink: ▴1.2% / ▾0.8% / ·0.0% (J6: never money colours). */
export function chgText(frac, d = 1) {
  if (!isNum(frac)) return '—';
  const v = Number(frac) * 100;
  const s = Math.abs(v).toFixed(d);
  if (Number(s) === 0) return `·${s}%`;
  return (v > 0 ? '▴' : '▾') + s + '%';
}

/** "10×" (rounded; "—" when unknown). */
export function levText(n) {
  return isNum(n) ? `${Math.round(Number(n))}×` : '—';
}

/** "01", "02" … from a 0-based slot. */
export function plotNo(slot) {
  return String(Number(slot) + 1).padStart(2, '0');
}

/** Plain dollars with cents ("$1,234.50"), no sign. */
export function dollars(x, d = 2) {
  return usd(x, d);
}

// ------------------------------------------------------------------ crops, sides

export function cropKey(coin) {
  return CROP_SET.has(String(coin)) ? String(coin) : 'other';
}

/** Localised crop name ("orange tree" / "ต้นส้ม"). */
export function cropName(coin) {
  return t('g.crop.' + cropKey(coin));
}

export function cropIcon(coin, opts) {
  return icon('i-crop-' + cropKey(coin), opts);
}

/** -1 | 0 | 1 from szi / side numbers. */
export function sideOf(x) {
  const v = Number(x);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Localised side word (LONG ↑ / SHORT ↓ / FLAT). */
export function sideText(side) {
  return t(side > 0 ? 'g.side.long' : side < 0 ? 'g.side.short' : 'g.side.flat');
}

/** A side pill: blue LONG ↑ / violet SHORT ↓ / grey FLAT (colour-blind mode restyles it in CSS). */
export function sidePill(side, { short = false } = {}) {
  const cls = side > 0 ? 'long' : side < 0 ? 'short' : 'flat';
  const text = short ? (side > 0 ? '↑ LONG' : side < 0 ? '↓ SHORT' : t('g.side.flat')) : sideText(side);
  return h('span', { class: `pill pill--${cls}`, text });
}

// ------------------------------------------------------------------ ages (§6.12, §6.13 rule 5)

/** 'fresh' | 'delayed' | 'stale' for a timestamp (server-relative now). */
export function ageKind(ms, nowMs) {
  if (!isNum(ms) || Number(ms) <= 0) return 'stale';
  const a = nowMs - Number(ms);
  if (a <= AGE_FRESH_MS) return 'fresh';
  if (a <= AGE_DELAYED_MS) return 'delayed';
  return 'stale';
}

/** "12 s" / "3 m" (localised units; "—" when unknown). */
export function ageText(ms, nowMs) {
  if (!isNum(ms) || Number(ms) <= 0) return '—';
  const u = agoUnits();
  const s = ago(Number(ms), nowMs, u);
  // the classic EN units have no space ("12s"); the HUD reads better with one
  return /^\d+[a-z]$/.test(s) ? s.replace(/([a-z])$/, ' $1') : s;
}

/** The visible age tag text for a number: "3 s ago" / "delayed · 25 s" / "stale · 2 m". */
export function ageLabel(ms, nowMs) {
  const kind = ageKind(ms, nowMs);
  const age = ageText(ms, nowMs);
  if (kind === 'fresh') return { kind, text: t('g.age.ago', { age }) };
  return { kind, text: t(kind === 'delayed' ? 'g.age.delayed' : 'g.age.stale', { age }) };
}

/** An age tag span (class age--fresh|delayed|stale). */
export function ageEl(ms, nowMs) {
  const a = ageLabel(ms, nowMs);
  return h('span', { class: `age age--${a.kind}`, text: a.text });
}

/** "14:03" local wall clock. */
export function hhmm(ms) {
  if (!isNum(ms)) return '—';
  return clock(Number(ms)).slice(0, 5);
}

/** "0:23" countdown from milliseconds. */
export function countdown(ms) {
  if (!isNum(ms)) return '—';
  const s = Math.max(0, Math.ceil(Number(ms) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Server-relative "now" (§9.3: age = now + skew − ms). */
export function serverNow(state) {
  const skew = Number(state?.net?.skewMs);
  return Date.now() + (Number.isFinite(skew) ? skew : 0);
}

// ------------------------------------------------------------------ errors

const clip = (s, n = 300) => {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
};
export { clip };

/** "45 s" / "3 min" / "2 h" from seconds (the {time} of a 429 / too_soon answer, localised units). */
export function waitText(seconds) {
  const s = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (s < 60) return t('g.wait.s', { n: s });
  if (s < 3600) return t('g.wait.m', { n: Math.ceil(s / 60) });
  if (s < 86_400) return t('g.wait.h', { n: Math.ceil(s / 3600) });
  return t('g.wait.d', { n: Math.ceil(s / 86_400) });
}

/** A wait that may be long (the 24 h season rule): "0:42" under an hour, else "23 h" (localised units). */
export function longWait(ms) {
  if (!isNum(ms)) return '—';
  return Number(ms) < 3_600_000 ? countdown(ms) : waitText(Number(ms) / 1000);
}

/** "BTC 0.01 · ETH −0.2" from [{coin, szi}] (the {coins} of testnet_positions_open). */
export function positionsText(positions) {
  if (!Array.isArray(positions) || !positions.length) return '—';
  return positions
    .filter((p) => p && p.coin)
    .map((p) => `${p.coin} ${isNum(p.szi) ? String(p.szi).replace(/^-/, '−') : ''}`.trim())
    .join(' · ');
}

/** mainnet_key sub_reason → the {role} word ("mainnet_subAccount" → "subAccount"). */
const roleOf = (sub) => (typeof sub === 'string' ? sub.replace(/^mainnet_/, '') : '');

/**
 * Variables for a localised error / note from the body or event that carries the code (PLATFORM §9.5):
 * retry_after_s → {time}, positions → {coins} (+ {n}), sub_reason → {role}, plus every primitive field and the
 * `vars` / `note_vars` objects. Missing variables stay as their {placeholder} (never invented).
 */
export function errVars(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  for (const [k, v] of Object.entries(b)) if (v !== null && v !== undefined && (typeof v === 'string' || typeof v === 'number')) out[k] = v;
  for (const src of [b.vars, b.note_vars]) if (src && typeof src === 'object') for (const [k, v] of Object.entries(src)) if (v !== null && v !== undefined && typeof v !== 'object') out[k] = v;
  delete out.error; // the raw server text is never a variable (it would put English into Thai)
  if (isNum(b.retry_after_s)) out.time = waitText(b.retry_after_s);
  if (Array.isArray(b.positions)) {
    out.coins = positionsText(b.positions);
    if (out.n === undefined) out.n = b.positions.length;
  }
  if (Array.isArray(b.coins)) out.coins = b.coins.join(', ');
  if (b.sub_reason) out.role = roleOf(b.sub_reason);
  for (const k of ['free', 'depth', 'usd', 'account_value', 'free_usd', 'depth_usd']) if (isNum(b[k])) out[k.replace(/_usd$/, '')] = usd(b[k], 2);
  if (out.free === undefined && isNum(b.free_usd)) out.free = usd(b.free_usd, 2);
  return out;
}

/** Codes whose localised text is the farm gate's "your session ended" (accounts mode, §9.5). */
export const SESSION_CODES = Object.freeze(['auth_required', 'session_expired']);

/**
 * Localised error for a failed command body ({error, status, code, …}) or a thrown Error (PLATFORM §9.5, §9.7.2).
 * → { text, detail, code, key }
 *   - a known `code` → t('g.err.<code>', vars) and the raw server text only as `detail` (a collapsible line);
 *   - accounts mode: a 401 always reads "your session ended" (never the command-token copy, QA-19);
 *   - none mode / unknown codes: today's behaviour (token hint on 401, "unreachable" on status 0, raw text).
 */
export function errInfo(e, { crossOrigin = false, origin = '', accounts = false } = {}) {
  const status = e?.status;
  const raw = clip(e?.error ?? e?.message ?? (typeof e === 'string' ? e : ''), 300);
  const code = typeof e?.code === 'string' && /^[a-z][a-z0-9_]*$/.test(e.code) ? e.code : null;
  if (code && hasKey('g.err.' + code)) {
    return { text: t('g.err.' + code, errVars(e)), detail: raw && raw !== code ? raw : '', code, key: 'g.err.' + code };
  }
  if (status === 401) {
    if (accounts) return { text: t('g.gate.ended'), detail: raw, code: code || 'auth_required', key: 'g.gate.ended' };
    return { text: crossOrigin ? t('err.authRemote', { origin }) : t('err.auth'), detail: '', code, key: crossOrigin ? 'err.authRemote' : 'err.auth' };
  }
  if (status === 0) return { text: `${t('err.unreachable')} (${raw})`, detail: '', code, key: 'err.unreachable' };
  // accounts mode never shows raw English server text as the main line (TH players, §12.4): generic + details
  if (accounts && raw) return { text: t('g.err.unknown'), detail: raw, code, key: 'g.err.unknown' };
  return { text: raw, detail: '', code, key: null };
}

/** Readable error for a failed command body ({error, status, code}) or a thrown Error (see errInfo). */
export function errText(e, opts = {}) {
  return errInfo(e, opts).text;
}

/**
 * An inline error block: the localised line, and the raw server text in a collapsed <details> (§9.5). Fills
 * `el` (a role=alert element) in place; an empty info hides it.
 */
export function showErr(el, info) {
  if (!el) return;
  const i = typeof info === 'string' ? { text: info, detail: '' } : info || { text: '', detail: '' };
  el.hidden = !i.text;
  if (!i.text) {
    el.replaceChildren();
    return;
  }
  const kids = [h('span', { class: 'err-text', text: i.text })];
  if (i.detail) kids.push(h('details', { class: 'err-details' }, h('summary', { text: t('g.err.details') }), h('code', { text: i.detail })));
  el.replaceChildren(...kids);
}

// ------------------------------------------------------------------ venues (PLATFORM §9.4: word + shape, no hue)

/** 'paper' | 'testnet' for a bot row or a view (absent means paper, §8.5). */
export function venueOf(x) {
  return x?.venue === 'testnet' ? 'testnet' : 'paper';
}

/** <span class="vbadge vbadge--testnet">TESTNET</span> (slate, checkered left edge) / PAPER (cream). */
export function venueBadge(venue, { cls = '' } = {}) {
  const v = venue === 'testnet' ? 'testnet' : 'paper';
  return h('span', { class: `vbadge vbadge--${v}${cls ? ' ' + cls : ''}`, dataset: { venue: v }, title: t(v === 'testnet' ? 'g.venue.testnetLong' : 'g.venue.paperLong'), text: t('g.venue.' + v) });
}

/** Update a venue badge element in place (keeps focus/AT position). */
export function setVenueBadge(el, venue) {
  if (!el) return;
  const v = venue === 'testnet' ? 'testnet' : 'paper';
  el.className = `vbadge vbadge--${v}`;
  el.dataset.venue = v;
  setText(el, t('g.venue.' + v));
}

/** Did a command body fail? (data.command resolves {error, status} like brood-api.command.) */
export function failedBody(body) {
  return !body || typeof body !== 'object' || body.error !== undefined;
}

// ------------------------------------------------------------------ layout

/** Phone layout breakpoint (bottom sheets, short badge, bottom bar). */
export function isPhone() {
  return !!globalThis.matchMedia?.('(max-width: 759px)').matches;
}

/** Reduced motion as the page currently applies it (settings + system, resolved onto <html data-motion>). */
export function reducedMotion() {
  return doc()?.documentElement?.dataset.motion === 'reduced';
}

/** Run fn on the next frame (or now under Node). */
export function nextFrame(fn) {
  if (typeof globalThis.requestAnimationFrame === 'function') return globalThis.requestAnimationFrame(fn);
  return setTimeout(fn, 0);
}

/**
 * ui/a11y.js — live regions, the scene summary and focus helpers (GAME-DESIGN §7.1).
 *
 *   #announce  aria-live="polite"     plant/close/shade results, warnings, pick-mode prompts
 *   #alert     aria-live="assertive"  feed down and API down ONLY
 *   #sceneSummary (visually hidden)   "Island with 6 plants: 4 in profit, 2 at a loss";
 *                                     at most once per 10 s, or at once after a plant/close
 *
 * Exports: announce(text), alert(text), mount(deps) → { announce, alert, summaryNow() }.
 */

import { t } from '../../i18n.js';
import * as view from '../core/view.js';
import { getCtx, on } from './context.js';
import { $, setText, watch, plotNo } from './util.js';

const SUMMARY_MS = 10_000;

/** Polite announcement (re-sets the text so repeats are read again). */
export function announce(text) {
  speak('announce', text);
}

/** Assertive announcement — feed down / API down only (§7.1). */
export function alert(text) {
  speak('alert', text);
}

/** Empty the assertive region once its condition is over (an outdated alert must not linger for SR users). */
export function clearAlert() {
  clearTimeout(timers.alert);
  const el = $('alert');
  if (el) el.textContent = '';
}

const timers = {};
function speak(id, text) {
  const el = $(id);
  if (!el || !text) return;
  clearTimeout(timers[id]);
  el.textContent = '';
  timers[id] = setTimeout(() => (el.textContent = String(text)), 60);
}

/**
 * Pure: the summary sentence for a views map. Uses WP2's view.sceneSummary() when present
 * ({key, vars}), else counts plots by total P&L sign.
 */
export function summaryText(views) {
  const list = Object.values(views || {}).filter(Boolean);
  let r = null;
  if (typeof view.sceneSummary === 'function') {
    try {
      r = view.sceneSummary(views || {});
    } catch {
      r = null;
    }
  }
  if (r && r.key) return t(r.key, r.vars);
  if (!list.length) return t('g.a11y.sceneEmpty');
  const up = list.filter((v) => Number(v.usd) > 0).length;
  const down = list.filter((v) => Number(v.usd) < 0).length;
  return t('g.a11y.scene', { n: list.length, up, down });
}

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('a11y')) return ctx.mods.a11y;
  const { store } = ctx;
  let last = 0;
  let timer = 0;

  const write = () => {
    last = Date.now();
    setText($('sceneSummary'), summaryText(store.get().views));
  };
  const schedule = () => {
    const wait = SUMMARY_MS - (Date.now() - last);
    if (wait <= 0) write();
    else if (!timer) timer = setTimeout(() => ((timer = 0), write()), wait);
  };

  watch(store, (s) => s.views, schedule);
  // a plant or a close updates the summary at once (§7.1)
  on(ctx, 'game:event', (ev) => {
    if (ev && (ev.type === 'created' || ev.type === 'closed' || ev.type === 'halted')) setTimeout(write, 400);
  });
  write();

  // a plot picked with 1–0 / [ ] or by a tap in the scene is confirmed for screen readers like a dock pick
  // (the dock announces its own selections)
  on(ctx, 'ui:select', (e) => {
    if (!e || !Number.isInteger(e.slot) || (e.source !== 'key' && e.source !== 'scene')) return;
    announce(t('g.a11y.selected', { n: plotNo(e.slot) }));
  });

  const api = { announce, alert, summaryNow: write };
  ctx.mods.a11y = api;
  return api;
}

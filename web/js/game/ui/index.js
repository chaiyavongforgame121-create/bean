/**
 * ui/index.js — mounts the whole HUD in one call (WP5 entry point for main.js).
 *
 *   import { mountUi } from './ui/index.js';
 *   const ui = mountUi({ store, bus, data, settings, sfx?, api? });   // before the 3D stage exists (§9.6 step 1)
 *   …
 *   ui.setStage(stage);            // or bus.emit('stage:ready', stage) — chips, signs, picker hooks, safe area
 *
 * Each module can also be mounted on its own (`mount({store, bus, data, sfx?})`, §9.6): they share one
 * context per store (ui/context.js), so the order below only matters for first paint.
 *
 * Also owns the static-markup i18n pass (data-i18n / data-i18n-attr, re-applied on every language switch)
 * and the non-blocking #boot card (hidden when the stage is ready; shows store.boot.error with retry/classic).
 *
 * No three.js, no side effects at import.
 */

import { t, applyI18n, onLangChange } from '../../i18n.js';
import { getCtx, on } from './context.js';
import { $, setText, watch } from './util.js';
import * as settings from './settings.js';
import * as sheets from './sheets.js';
import * as toast from './toast.js';
import * as a11y from './a11y.js';
import * as actions from './actions.js';
import * as hud from './hud.js';
import * as badge from './badge.js';
import * as ticker from './ticker.js';
import * as board from './board.js';
import * as dock from './dock.js';
import * as chips from './chips.js';
import * as landmarks from './landmarks.js';
import * as shelf from './shelf.js';
import * as plantDialog from './plantDialog.js';
import * as inspector from './inspector.js';
import * as confirm from './confirm.js';
import * as diary from './diary.js';
import * as listview from './listview.js';
import * as radial from './radial.js';
import * as help from './help.js';
import * as gate from './gate.js';
import * as account from './account.js';
import * as testnet from './testnet.js';
import * as tutorial from './tutorial.js';

/** Mount order: look switches and panels first, then the always-visible HUD, then panels and dialogs. */
export const MODULES = Object.freeze([
  ['settings', settings],
  ['sheets', sheets],
  ['toast', toast],
  ['a11y', a11y],
  ['actions', actions],
  ['hud', hud],
  ['badge', badge],
  ['ticker', ticker],
  ['dock', dock],
  ['chips', chips],
  ['landmarks', landmarks],
  ['board', board],
  ['shelf', shelf],
  ['plantDialog', plantDialog],
  ['inspector', inspector],
  ['confirm', confirm],
  ['diary', diary],
  ['listview', listview],
  ['radial', radial],
  ['help', help],
  // platform (PLATFORM §9.1–9.3): the farm gate, the account menu and the testnet connect panel
  ['testnet', testnet],
  ['account', account],
  ['gate', gate],
  ['tutorial', tutorial],
]);

export function mountUi(deps = {}) {
  const ctx = getCtx(deps);
  if (ctx.mods.__ui) return ctx.mods.__ui;
  applyI18n(document);
  onLangChange(() => applyI18n(document));
  for (const [name, mod] of MODULES) {
    try {
      mod.mount(ctx);
    } catch (e) {
      // one broken panel must not take the HUD (and the PAPER badge) down with it
      console.error(`[ui] ${name} failed to mount`, e);
    }
  }
  wireBoot(ctx);
  const api = {
    ctx,
    mods: ctx.mods,
    setStage(stage) {
      ctx.setStage(stage);
    },
  };
  ctx.mods.__ui = api;
  return api;
}

/** The #boot card never blocks the HUD: it hides when the stage is ready and only takes clicks on errors. */
function wireBoot(ctx) {
  const box = $('boot');
  if (!box) return;
  const hide = () => {
    box.hidden = true;
    document.documentElement.dataset.boot = 'ready';
  };
  ctx.onStage((stage) => stage && hide());
  on(ctx, 'stage:ready', hide);
  watch(ctx.store, (s) => s.boot, (b) => {
    if (!b) return;
    if (b.phase === 'ready' && ctx.stage) hide();
    if (b.phase === 'error') {
      box.hidden = false;
      box.dataset.state = 'error';
      setText($('bootMsg'), t('g.boot.error', { error: String(b.error ?? '').slice(0, 300) }));
      const acts = $('bootActions');
      if (acts) acts.hidden = false;
    }
  });
  $('bootRetry')?.addEventListener('click', () => location.reload());
}

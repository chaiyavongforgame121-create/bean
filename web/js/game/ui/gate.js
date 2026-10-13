/**
 * ui/gate.js — the farm gate: sign in / create a garden / redeem a reset code (PLATFORM §9.1; WP5).
 *
 *   Accounts mode, spectator: the gate opens by itself once per browser session (non-modal, dismissible).
 *   "Just look around" collapses it to the Sign in chip in the top bar (#btnSignIn). The signpost, an empty plot,
 *   Plant, the fire pit and the money landmarks open it again (routed through ctx.mods.gate.open()).
 *
 *   Layout: a wooden sign on the left on desktop; a bottom sheet (≤ 60 % of the height) on a phone. It is a
 *   ui/sheets.js panel, so its covered edge reaches rig.setSafeArea like every panel (QA-06, QA-10).
 *
 *   Fields: username (autocomplete="username"), password ("current-password" / "new-password"), repeat password,
 *   reset code (one-time-code), optional operator setup code (the admin bootstrap, §4.6 step 2). Show/hide toggle,
 *   Caps Lock hint, inline role=alert errors localised by code (§9.5), the no-recovery note on Create and Reset.
 *   The <form> has method="post" and NO action: submission is fetch POST JSON (brood-api), Enter submits, and a
 *   script failure can never put a password into a URL. The submit button shows the pending loop (J3).
 *
 *   After a successful auth: ui/session.js signedIn() (per-player reset, stream reopened, tend, tour, notice).
 *   None mode: nothing is shown and nothing is fetched.
 *
 * Exports: mount(deps) → { open(o), close(), ended(), isOpen() }, and the pure validateGate(), canonUsername().
 * No three.js, no side effects at import.
 */

import { t, onLangChange } from '../../i18n.js';
import { getCtx, on } from './context.js';
import { h, $, setText, setAttr, show, setBusy, isBusy, watch, showErr, uid, nextFrame } from './util.js';
import { getSheets } from './sheets.js';
import { getActions } from './actions.js';
import { authCommand, signedIn, signedOut, ensureMode } from './session.js';
import { announce } from './a11y.js';
import * as D from './derive.js';

/** sessionStorage key: the player chose "Just look around" in this browser session (the chip stays). */
export const GATE_COLLAPSED_KEY = 'bean.gate.collapsed';
const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
const PW_MIN = 10;
const PW_MAX = 128;

/** The server's canonical username (§4.1: NFKC, trimmed, lower-case). */
export function canonUsername(name) {
  return String(name ?? '').normalize('NFKC').trim().toLowerCase();
}

/**
 * Client-side checks before a request (the server repeats them; a refused form is never sent).
 * mode: 'signin' | 'signup' | 'reset' → null or { key, field }.
 */
export function validateGate(mode, { username = '', password = '', password2 = '', code = '' } = {}) {
  const u = canonUsername(username);
  if (!u) return { key: 'g.gate.usernameHint', field: 'username' };
  if (mode !== 'signin' && !USERNAME_RE.test(u)) return { key: 'g.gate.usernameHint', field: 'username' };
  if (mode === 'reset' && !String(code).trim()) return { key: 'g.gate.resetCode', field: 'code' };
  if (!password) return { key: mode === 'signin' ? 'g.gate.badLogin' : 'g.gate.reasonTooShort', field: 'password' };
  if (mode === 'signin') return null;
  if (password.length < PW_MIN) return { key: 'g.gate.reasonTooShort', field: 'password' };
  if (password.length > PW_MAX) return { key: 'g.gate.reasonTooLong', field: 'password' };
  if (u.length >= 3 && password.toLowerCase().includes(u)) return { key: 'g.gate.reasonContains', field: 'password' };
  if (password !== password2) return { key: 'g.gate.mismatch', field: 'password2' };
  return null;
}

function readCollapsed() {
  try {
    return globalThis.sessionStorage?.getItem(GATE_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}
function writeCollapsed(on) {
  try {
    if (on) globalThis.sessionStorage?.setItem(GATE_COLLAPSED_KEY, '1');
    else globalThis.sessionStorage?.removeItem(GATE_COLLAPSED_KEY);
  } catch {
    /* private mode: the gate simply opens again next load */
  }
}

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('gate')) return ctx.mods.gate;
  const { store } = ctx;
  const sheets = getSheets(ctx);
  const A = getActions(ctx);
  const p = sheets.panel('gate', { side: 'left', titleKey: 'g.gate.title', snap: 60, icon: 'i-seed' });
  p.el.classList.add('panel--sign');
  let mode = 'signin'; // 'signin' | 'signup' | 'reset'
  let reason = null; // 'plant' | 'ended' | null — the line above the form
  let autoOpened = false;

  // ------------------------------------------------------------------ markup (built once; text set in render)

  const lead = h('p', { class: 'gate-lead' });
  const notice = h('p', { class: 'gate-notice', role: 'status', hidden: true });
  const tabSignin = h('button', { type: 'button', role: 'tab', class: 'gate-tab', id: 'gateTabIn', 'aria-controls': 'gateForm' });
  const tabSignup = h('button', { type: 'button', role: 'tab', class: 'gate-tab', id: 'gateTabUp', 'aria-controls': 'gateForm' });
  const tabs = h('div', { class: 'gate-tabs', role: 'tablist' }, tabSignin, tabSignup);
  const resetTitle = h('h3', { class: 'gate-reset-title', hidden: true });

  const field = (id, attrs, labelKey, hintKey = null) => {
    const label = h('label', { class: 'f-label', for: id, dataset: { key: labelKey } });
    const input = h('input', { id, class: 'input', ...attrs });
    const hint = hintKey ? h('p', { class: 'f-hint', id: id + 'Hint', dataset: { key: hintKey } }) : null;
    if (hint) input.setAttribute('aria-describedby', hint.id);
    const row = h('div', { class: 'f-row' }, label, input, hint);
    return { row, label, input, hint };
  };
  const user = field('gateUser', { type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', inputmode: 'text', maxlength: '64', required: true }, 'g.gate.username', 'g.gate.usernameHint');
  const code = field('gateCode', { type: 'text', name: 'code', autocomplete: 'one-time-code', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', maxlength: '128' }, 'g.gate.resetCode');
  const pw = field('gatePw', { type: 'password', name: 'password', autocomplete: 'current-password', maxlength: String(PW_MAX), required: true }, 'g.gate.password', 'g.gate.passwordHint');
  const pw2 = field('gatePw2', { type: 'password', name: 'password2', autocomplete: 'new-password', maxlength: String(PW_MAX) }, 'g.gate.password2');
  const eye = h('button', { type: 'button', class: 'btn btn--ghost btn--sm gate-eye', 'aria-pressed': 'false', 'aria-controls': 'gatePw gatePw2' });
  pw.row.append(eye);
  const caps = h('p', { class: 'f-hint f-hint--warn gate-caps', role: 'status', hidden: true });
  const noRecovery = h('p', { class: 'gate-norecovery' });
  const bootId = uid('gateBoot');
  const bootInput = h('input', { id: bootId, class: 'input', type: 'text', name: 'bootstrap_code', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '128' });
  const bootLabel = h('label', { class: 'f-label', for: bootId });
  const bootSum = h('summary', { class: 'gate-link' });
  const boot = h('details', { class: 'gate-boot' }, bootSum, h('div', { class: 'f-row' }, bootLabel, bootInput));
  const err = h('div', { class: 'dlg-error gate-error', role: 'alert', tabindex: '-1', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn--wood btn--go gate-submit' });
  // method=post, no action: if a script ever fails before preventDefault, nothing lands in a URL or a log
  const form = h('form', { class: 'gate-form', id: 'gateForm', method: 'post', novalidate: true, 'aria-labelledby': 'gateTabIn' }, user.row, code.row, pw.row, caps, pw2.row, noRecovery, boot, err, submit);
  const resetLink = h('button', { type: 'button', class: 'gate-link' });
  const backLink = h('button', { type: 'button', class: 'gate-link', hidden: true });
  const paperNote = h('p', { class: 'gate-paper' });
  const visit = h('button', { type: 'button', class: 'btn btn--paper gate-visit' });
  p.body.append(lead, notice, tabs, resetTitle, form, h('p', { class: 'gate-links' }, resetLink, backLink), paperNote, visit);

  // ------------------------------------------------------------------ behaviour

  function setMode(m) {
    mode = m;
    showErr(err, null);
    render();
  }
  tabSignin.addEventListener('click', () => setMode('signin'));
  tabSignup.addEventListener('click', () => setMode('signup'));
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = mode === 'signin' ? 'signup' : 'signin';
    setMode(next);
    (next === 'signin' ? tabSignin : tabSignup).focus();
  });
  resetLink.addEventListener('click', () => {
    setMode('reset');
    nextFrame(() => user.input.focus());
  });
  backLink.addEventListener('click', () => {
    setMode('signin');
    nextFrame(() => tabSignin.focus());
  });
  eye.addEventListener('click', () => {
    const showing = pw.input.type === 'text';
    for (const i of [pw.input, pw2.input]) i.type = showing ? 'password' : 'text';
    eye.setAttribute('aria-pressed', String(!showing));
    render();
  });
  const capsCheck = (e) => {
    if (typeof e.getModifierState !== 'function') return;
    caps.hidden = !e.getModifierState('CapsLock');
  };
  for (const i of [pw.input, pw2.input]) {
    i.addEventListener('keydown', capsCheck);
    i.addEventListener('keyup', capsCheck);
    i.addEventListener('blur', () => (caps.hidden = true));
  }
  visit.addEventListener('click', () => collapse());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });

  async function send() {
    if (isBusy(submit)) return;
    const values = { username: user.input.value, password: pw.input.value, password2: pw2.input.value, code: code.input.value };
    const bad = validateGate(mode, values);
    if (bad) {
      showErr(err, t(bad.key));
      ({ username: user.input, password: pw.input, password2: pw2.input, code: code.input })[bad.field]?.focus();
      return;
    }
    const username = canonUsername(values.username);
    let op;
    let params;
    if (mode === 'signin') {
      op = 'auth_login';
      params = { username, password: values.password };
    } else if (mode === 'signup') {
      op = 'auth_signup';
      params = { username, password: values.password, lang: document.documentElement.lang === 'th' ? 'th' : 'en' };
      const bc = bootInput.value.trim();
      if (bc) params.bootstrap_code = bc;
    } else {
      op = 'auth_reset';
      params = { username, code: values.code.trim(), new_password: values.password };
    }
    setBusy(submit, true);
    submit.classList.add('is-pending');
    setText(submit, t(mode === 'signup' ? 'g.gate.creating' : mode === 'reset' ? 'g.gate.resetting' : 'g.gate.signingIn'));
    showErr(err, null);
    const body = await authCommand(ctx, op, params);
    params = null; // drop the secrets as soon as they are sent
    setBusy(submit, false);
    submit.classList.remove('is-pending');
    if (body.error !== undefined || !body.user) {
      render();
      const info = A.failInfo(body.error !== undefined ? body : { error: 'no user', status: 500 });
      showErr(err, info);
      err.focus({ preventScroll: true });
      announce(info.text);
      return;
    }
    // success: forget every typed secret before anything else runs
    for (const i of [pw.input, pw2.input, code.input, bootInput]) i.value = '';
    for (const i of [pw.input, pw2.input]) i.type = 'password';
    eye.setAttribute('aria-pressed', 'false');
    const isNew = mode === 'signup';
    mode = 'signin';
    reason = null;
    writeCollapsed(false);
    systemClose();
    signedIn(ctx, body.user, { notice: body.notice ?? null, isNew });
    const msg = t('g.gate.welcome', { name: body.user.username });
    ctx.mods.toast?.show?.(msg, { tone: 'info' });
    announce(msg);
    render();
  }

  // ------------------------------------------------------------------ open / close / chip

  function open({ opener = null, ended = false, reason: why = null } = {}) {
    const s = store.get();
    if (!D.isAccounts(s)) return; // none mode: there is no gate
    if (D.userOf(s) && !ended) return; // already signed in
    reason = ended ? 'ended' : why;
    if (ended) mode = 'signin';
    render();
    p.open({ opener, snap: 60, focus: !!opener || ended });
    // a player who asked for the gate types at once; the automatic first-visit sign never grabs the keyboard
    // (on a phone that would open the on-screen keyboard over the island)
    if (opener || ended) nextFrame(() => user.input.focus({ preventScroll: true }));
  }
  function close() {
    p.close({ restore: true });
  }
  function collapse() {
    writeCollapsed(true);
    p.close({ restore: false });
    renderChip();
    $('btnSignIn')?.focus?.({ preventScroll: true });
    announce(t('g.gate.spectator'));
  }
  /** A session that ended (401 / session_ended): the gate with "your session ended" (§9.5). */
  function ended() {
    if (!D.isAccounts(store.get())) return;
    if (D.userOf(store.get())) signedOut(ctx, { ended: true, reason: 'expired' });
    else open({ ended: true });
  }

  const chip = $('btnSignIn');
  chip?.addEventListener('click', () => (p.isOpen() ? close() : open({ opener: chip })));
  function renderChip() {
    const s = store.get();
    const spectator = D.isSpectator(s);
    show(chip, spectator && !p.isOpen());
    if (chip) {
      setText(chip.querySelector('.signin-text') || chip, t('g.gate.signin'));
      setAttr(chip, 'aria-expanded', String(p.isOpen()));
    }
    document.documentElement.dataset.auth = !D.isAccounts(s) ? 'none' : spectator ? 'spectator' : 'player';
  }
  /** A close the page decides (signed in, mode change): not the player's "just look around" choice. */
  let closingBySystem = false;
  function systemClose() {
    closingBySystem = true;
    try {
      p.close({ restore: false });
    } finally {
      closingBySystem = false;
    }
  }
  p.onOpen(renderChip);
  p.onClose(() => {
    // closing the sign (✕, Esc) is the same choice as "Just look around"
    if (!closingBySystem && D.isSpectator(store.get())) writeCollapsed(true);
    renderChip();
  });

  // ------------------------------------------------------------------ render

  function render() {
    p.setTitle(t('g.gate.title'));
    setText(lead, t('g.gate.lead'));
    const noticeKey = reason === 'ended' ? 'g.gate.ended' : reason === 'plant' ? 'g.gate.signInToPlant' : null;
    notice.hidden = !noticeKey;
    setText(notice, noticeKey ? t(noticeKey) : '');
    notice.classList.toggle('gate-notice--warn', reason === 'ended');
    const resetting = mode === 'reset';
    tabs.hidden = resetting;
    resetTitle.hidden = !resetting;
    setText(resetTitle, t('g.gate.resetLink'));
    for (const [tab, m] of [[tabSignin, 'signin'], [tabSignup, 'signup']]) {
      setAttr(tab, 'aria-selected', String(mode === m));
      tab.tabIndex = mode === m ? 0 : -1;
      tab.classList.toggle('is-on', mode === m);
    }
    setText(tabSignin, t('g.gate.signin'));
    setText(tabSignup, t('g.gate.signup'));
    setAttr(tabs, 'aria-label', t('g.gate.tabs'));
    form.setAttribute('aria-labelledby', mode === 'signup' ? 'gateTabUp' : 'gateTabIn');
    for (const el of p.body.querySelectorAll('[data-key]')) setText(el, t(el.dataset.key));
    // labels and hints per mode
    setText(pw.label, t(resetting ? 'g.acct.newPw' : 'g.gate.password'));
    pw.input.autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
    show(user.hint, mode !== 'signin');
    show(pw.hint, mode !== 'signin');
    show(pw2.row, mode !== 'signin');
    show(code.row, resetting);
    show(boot, mode === 'signup');
    show(noRecovery, mode !== 'signin');
    setText(noRecovery, t('g.gate.noRecovery'));
    setText(bootSum, t('g.gate.bootstrapLink'));
    setText(bootLabel, t('g.gate.bootstrap'));
    const showing = pw.input.type === 'text';
    setText(eye, t(showing ? 'g.gate.hidePw' : 'g.gate.showPw'));
    setText(caps, t('g.gate.caps'));
    if (!isBusy(submit)) setText(submit, t(mode === 'signup' ? 'g.gate.signup' : resetting ? 'g.gate.resetGo' : 'g.gate.signin'));
    resetLink.hidden = resetting || mode === 'signup';
    backLink.hidden = !resetting;
    setText(resetLink, t('g.gate.resetLink'));
    setText(backLink, t('g.gate.backToSignIn'));
    setText(paperNote, t('g.gate.paperNote'));
    setText(visit, t('g.gate.visit'));
    renderChip();
  }

  // ------------------------------------------------------------------ store / bus

  // the mode and the player decide everything: a spectator gets the gate once per session; a player never does
  watch(store, (s) => [D.modeOf(s), D.userOf(s)?.id ?? null, D.modeKnown(s)], ([m, id, known], prev) => {
    renderChip();
    if (m !== 'accounts') {
      if (p.isOpen()) systemClose();
      return;
    }
    if (id !== null) {
      if (p.isOpen()) systemClose();
      return;
    }
    // signed out after having been signed in: the gate comes back (signedOut() or a session_ended event adds
    // the "your session ended" line when it was not the player's own choice)
    if (prev && prev[1] !== null && prev[1] !== undefined) {
      open({});
      return;
    }
    if (known && !autoOpened && !readCollapsed()) {
      autoOpened = true;
      // after the first paint, so the island is already there behind the sign
      setTimeout(() => D.isSpectator(store.get()) && open({}), 400);
    }
  }, (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
  on(ctx, 'auth:required', () => ended());
  on(ctx, 'game:event', (ev) => {
    if (ev && (ev.kind === 'session_ended' || ev.type === 'session_ended' || ev.type === 'sessionEnded')) ended();
  });
  onLangChange(render);
  render();
  ensureMode(ctx);

  const apiOut = { open, close, ended, collapse, isOpen: () => p.isOpen(), panel: p };
  ctx.mods.gate = apiOut;
  return apiOut;
}

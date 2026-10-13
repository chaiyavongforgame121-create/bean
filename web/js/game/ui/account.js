/**
 * ui/account.js — the account menu (PLATFORM §9.2; WP5).
 *
 *   Desktop: a HUD button with a straw-hat icon and the username (#btnAccount) opens the Account panel.
 *   Phone (< 760 px): the account entry lives in the ⋯ More sheet, whose header shows the username (no extra
 *   top-row button, QA-10). Spectators get the Sign in chip instead (ui/gate.js).
 *
 *   Account panel items: Settings · Connect testnet / Testnet: connected ✓ · Change password · Re-arm the field
 *   (when burned) · Start a new paper season · Help & FAQ · Signed-in devices (P1) · Sign out · Sign out
 *   everywhere · Delete account. Admins also get the Operator section (P1): kill switch with a reason and the
 *   admin_status numbers, plus the --testnet-double fault panel (dev only; 404 elsewhere).
 *
 *   Dialogs (one native <dialog id="acctDlg">, focus trapped, Esc cancels unless a request is in flight):
 *     change password (account_password), delete account (2 steps: password + DELETE + the bots that close with
 *     J10 money lines + backup / revoke notes; then, after 409 testnet_positions_open, the positions and a
 *     required "delete anyway" tick → force:true), new paper season (bots with money lines + RESET; disabled
 *     with its countdown within 24 h), re-arm (REARM; available 60 s after the burn), the one-time "your password
 *     was reset by the operator" card.
 *
 * Exports: mount(deps) → { open(o), resetNotice(), rearm(o), season(o), deleteAccount(o), changePassword(o) }.
 * No three.js, no side effects at import.
 */

import { t, onLangChange } from '../../i18n.js';
import { usd, isNum } from '../../format.js';
import { getCtx, on } from './context.js';
import { h, $, setText, setAttr, show, setBusy, isBusy, setBlocked, isBlocked, trapTab, watch, showErr, money, countdown, hhmm, uid, nextFrame, venueBadge, positionsText, errInfo, ageText, longWait } from './util.js';
import { getSheets } from './sheets.js';
import { getActions } from './actions.js';
import { closeEstimate } from './confirm.js';
import { authCommand, signedOut, query, refreshTestnet } from './session.js';
import { announce } from './a11y.js';
import * as D from './derive.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const REVOKE_URL = 'https://app.hyperliquid-testnet.xyz/API';

/**
 * The fault names of the --testnet-double dev panel (test/fixtures/hl-testnet-double.js DEV_FAULTS; a test keeps
 * the two lists equal). Only a datalist hint: the server checks the name.
 */
export const DEV_FAULTS = Object.freeze([
  'new_account', 'faucet', 'timeout', 'http5xx', 'http429', 'http400', 'redirect', 'execute_then_timeout', 'partial',
  'resting', 'waiting_for_fill', 'waiting_for_trigger', 'bare_string', 'unknown_oid', 'signature_mismatch', 'error',
  'must_deposit', 'drift', 'liquidation', 'revoke_agent', 'expire_agent', 'prune_unfunded', 'clock_skew', 'set_mid',
  'thin_book', 'funding', 'abstraction', 'mainnet_role', 'mainnet_down', 'clear',
]);

/** A small straw hat (brim + crown + band), drawn with DOM calls (no sprite symbol, no innerHTML). */
export function strawHat() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ico ico-hat');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = (d, cls) => {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', cls);
    return p;
  };
  svg.append(
    path('M2 15.5c0-1.6 4.5-2.9 10-2.9s10 1.3 10 2.9-4.5 2.9-10 2.9S2 17.1 2 15.5z', 'hat-brim'),
    path('M7 14.2c0-4 2.2-7.7 5-7.7s5 3.7 5 7.7c-1.5.5-3.1.7-5 .7s-3.5-.2-5-.7z', 'hat-crown'),
    path('M7.3 12.4c1.5.5 3 .7 4.7.7s3.2-.2 4.7-.7l.2 1.6c-1.5.5-3.1.7-4.9.7s-3.4-.2-4.9-.7z', 'hat-band'),
  );
  return svg;
}

/** Pure: the J10 money line of one bot that a delete / season reset closes ("BTC · ↑ 0.0050 · ≈ +$3.10 ▲"). */
export function closeLine(state, bot) {
  const v = D.viewOfBot(state, bot.id);
  const merged = D.mergedBot(state, bot.id) || bot;
  const q = closeEstimate(merged, v?.mark);
  const m = money(q.estTotal, { est: true });
  return { coin: bot.coin, venue: D.venueOf(bot), text: `${bot.coin} · ${q.flat ? t('g.side.flat') : (q.szi > 0 ? '↑ ' : '↓ ') + Math.abs(q.szi)} · ${m.text}`, tone: m.tone, est: q.estTotal };
}

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('account')) return ctx.mods.account;
  const { store } = ctx;
  const sheets = getSheets(ctx);
  const A = getActions(ctx);
  const p = sheets.panel('account', { side: 'left', titleKey: 'g.acct.menu', snap: 60 });

  // ------------------------------------------------------------------ HUD button (desktop) + More sheet (phone)

  const hudBtn = $('btnAccount');
  if (hudBtn && !hudBtn.querySelector('.ico-hat')) hudBtn.prepend(strawHat());
  hudBtn?.addEventListener('click', () => p.toggle({ opener: hudBtn, restore: true }));

  const moreHead = h('div', { class: 'more-account', hidden: true }, h('span', { class: 'more-hat' }, strawHat()), h('b', { class: 'more-user' }));
  const moreAcct = h('button', { type: 'button', class: 'btn btn--paper more-btn', id: 'moreAccount' }, h('span', { class: 'more-ico' }, strawHat()), h('span', { class: 'more-text' }));
  moreAcct.addEventListener('click', () => p.open({ opener: moreAcct }));
  const moreSignIn = h('button', { type: 'button', class: 'btn btn--wood more-btn', id: 'moreSignIn' }, h('span', { class: 'more-text' }));
  moreSignIn.addEventListener('click', () => ctx.mods.gate?.open?.({ opener: moreSignIn }));
  const attachMore = () => {
    const more = sheets.get('more');
    if (!more || moreHead.isConnected) return;
    more.body.prepend(moreHead);
    more.body.querySelector('.more-grid')?.prepend(moreAcct, moreSignIn);
  };

  // ------------------------------------------------------------------ the panel

  const who = h('p', { class: 'acct-who' });
  const season = h('p', { class: 'acct-season muted' });
  const menu = h('ul', { class: 'acct-menu' });
  const item = (id, key, fn, { cls = 'btn--paper', danger = false } = {}) => {
    const b = h('button', { type: 'button', class: `btn ${danger ? 'btn--danger-outline' : cls} acct-item`, dataset: { item: id } }, h('span', { class: 'acct-label' }), h('span', { class: 'acct-sub muted' }));
    b.dataset.key = key;
    b.addEventListener('click', (e) => {
      if (isBlocked(b)) return announce(b.querySelector('.acct-sub').textContent || '');
      fn(e.currentTarget);
    });
    const li = h('li', {}, b);
    menu.append(li);
    return b;
  };
  const items = {
    settings: item('settings', 'g.btn.settings', (b) => sheets.open('settings', { opener: b })),
    testnet: item('testnet', 'g.acct.tnConnect', (b) => ctx.mods.testnet?.open?.({ opener: b })),
    password: item('password', 'g.acct.changePw', (b) => changePassword({ opener: b })),
    rearm: item('rearm', 'g.rearm', (b) => rearm({ opener: b }), { cls: 'btn--wood' }),
    season: item('season', 'g.acct.reset', (b) => newSeason({ opener: b })),
    help: item('help', 'g.acct.help', (b) => ctx.mods.help?.openFaq?.({ opener: b }) ?? sheets.open('help', { opener: b })),
    sessions: item('sessions', 'g.acct.sessions', () => toggleSessions()),
    logout: item('logout', 'g.acct.logout', (b) => logout(false, b)),
    logoutAll: item('logoutAll', 'g.acct.logoutAll', (b) => logout(true, b)),
    del: item('delete', 'g.acct.delete', (b) => deleteAccount({ opener: b }), { danger: true }),
  };
  const sessionsBox = h('div', { class: 'acct-sessions', hidden: true });
  items.sessions.closest('li').append(sessionsBox);

  // Operator (admins, P1): kill switch + status numbers + the dev double's fault panel
  const opTitle = h('h3', { class: 'set-group-title' });
  const opState = h('p', { class: 'acct-op-state' });
  const opReasonId = uid('opReason');
  const opReasonLabel = h('label', { class: 'f-label', for: opReasonId });
  const opReason = h('input', { id: opReasonId, class: 'input', type: 'text', maxlength: '200', autocomplete: 'off' });
  const opToggle = h('button', { type: 'button', class: 'btn btn--danger-outline' });
  const opStatus = h('p', { class: 'acct-op-status muted num' });
  const opErr = h('div', { class: 'dlg-error', role: 'alert', hidden: true });
  const faultId = uid('opFault');
  const faultInput = h('input', { id: faultId, class: 'input', type: 'text', list: faultId + 'List', autocomplete: 'off', spellcheck: 'false', maxlength: '64' });
  const faultList = h('datalist', { id: faultId + 'List' }, DEV_FAULTS.map((f) => h('option', { value: f })));
  const argsId = uid('opArgs');
  const argsInput = h('input', { id: argsId, class: 'input input--mono', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '400', placeholder: '{"coin":"ETH"}' });
  const faultGo = h('button', { type: 'button', class: 'btn btn--paper btn--sm' });
  const faultOut = h('pre', { class: 'acct-dev-out num', hidden: true });
  const faultUse = h('button', { type: 'button', class: 'btn btn--wood btn--sm', hidden: true });
  const faultSum = h('summary', { class: 'gate-link' });
  const faultBox = h(
    'details',
    { class: 'acct-dev' },
    faultSum,
    h('div', { class: 'f-row' }, h('label', { class: 'f-label', for: faultId, dataset: { key: 'g.acct.devFault' } }), faultInput, faultList),
    h('div', { class: 'f-row' }, h('label', { class: 'f-label', for: argsId, dataset: { key: 'g.acct.devArgs' } }), argsInput),
    faultGo,
    faultOut,
    faultUse,
  );
  let devAccount = null; // the last `new_account` answer of the double (throwaway dev keys only)
  let devMissing = false; // dev_double answered 404: this server has no double
  const opBox = h('section', { class: 'set-group acct-op', hidden: true }, opTitle, opState, h('div', { class: 'f-row' }, opReasonLabel, opReason), opToggle, opStatus, opErr, faultBox);
  p.body.append(who, season, menu, opBox);

  // ------------------------------------------------------------------ dialog (shared)

  let dlg = $('acctDlg');
  if (!dlg) {
    dlg = h('dialog', { id: 'acctDlg', class: 'dlg dlg--ask dlg--acct', 'aria-labelledby': 'acctDlgTitle' });
    $('dialogs')?.append(dlg);
  }
  let session = null; // { opener, render(), off() }
  dlg.addEventListener('keydown', (e) => trapTab(dlg, e));
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (dlg.querySelector('[data-busy="1"]')) return announce(t('g.ask.sending'));
    finish();
  });
  dlg.addEventListener('close', () => {
    if (session && !dlg.open) finish({ fromClose: true });
  });

  function begin(opener, build) {
    if (session) finish();
    const s = { opener: opener || document.activeElement, render: () => {}, off: null };
    session = s;
    build(s);
    if (!dlg.open) {
      try {
        dlg.showModal();
      } catch {
        dlg.setAttribute('open', '');
      }
    }
    nextFrame(() => dlg.querySelector('[data-autofocus]')?.focus());
    return s;
  }
  function finish({ fromClose = false } = {}) {
    const s = session;
    if (!s) return;
    session = null;
    s.off?.();
    // a dialog never keeps a typed secret after it closes
    for (const i of dlg.querySelectorAll('input')) i.value = '';
    if (!fromClose && dlg.open) dlg.close();
    dlg.classList.remove('dlg--danger');
    const back = s.opener && s.opener.isConnected && s.opener.getClientRects().length ? s.opener : $('stage');
    back?.focus?.({ preventScroll: true });
  }
  /** Card skeleton: title, body, inline error, actions (cancel + go). */
  function frame(titleKey, { danger = false, vars = {} } = {}) {
    dlg.classList.toggle('dlg--danger', danger);
    const title = h('h2', { id: 'acctDlgTitle', class: 'dlg-title', text: t(titleKey, vars) });
    const body = h('div', { class: 'dlg-body' });
    const err = h('div', { class: 'dlg-error', role: 'alert', tabindex: '-1', hidden: true });
    const cancel = h('button', { type: 'button', class: 'btn btn--paper', 'data-autofocus': '', text: t('g.ask.cancel') });
    const go = h('button', { type: 'submit', class: `btn ${danger ? 'btn--danger' : 'btn--wood'}` });
    const form = h('form', { class: 'dlg-card', method: 'post', novalidate: true }, title, body, err, h('div', { class: 'dlg-actions' }, cancel, go));
    cancel.addEventListener('click', () => {
      if (isBusy(go)) return announce(t('g.ask.sending'));
      finish();
    });
    dlg.replaceChildren(form);
    return { form, title, body, err, cancel, go };
  }
  const pwField = (labelKey, autocomplete) => {
    const id = uid('acctPw');
    const input = h('input', { id, class: 'input', type: 'password', autocomplete, maxlength: '128' });
    return { input, row: h('div', { class: 'f-row' }, h('label', { class: 'f-label', for: id, text: t(labelKey) }), input) };
  };
  const typedField = (word) => {
    const id = uid('acctWord');
    const input = h('input', { id, class: 'input input--word', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '16' });
    return { input, row: h('div', { class: 'f-row' }, h('label', { class: 'f-label', for: id, text: t('g.acct.typeWord', { word }) }), input) };
  };
  const tick = (text, { link = null } = {}) => {
    const id = uid('acctTick');
    const input = h('input', { id, type: 'checkbox', class: 'check' });
    const label = h('label', { class: 'f-check dlg-check', for: id }, input, h('span', { text }));
    const row = h('div', { class: 'acct-tick' }, label, link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', class: 'gate-link', text: t('g.tn.revokeLink') }) : null);
    return { input, row };
  };
  const botList = (bots) =>
    bots.length
      ? h(
          'ul',
          { class: 'burn-list acct-bots' },
          bots.map((b) => {
            const l = closeLine(store.get(), b);
            return h('li', { class: 'burn-row' }, venueBadge(l.venue), h('span', { class: `money money--${l.tone} num`, text: l.text }));
          }),
        )
      : h('p', { class: 'muted', text: t('g.acct.noOpenBots') });

  // ------------------------------------------------------------------ change password

  function changePassword({ opener = null } = {}) {
    begin(opener, (s) => {
      const f = frame('g.acct.changePw');
      const cur = pwField('g.acct.currentPw', 'current-password');
      const next = pwField('g.acct.newPw', 'new-password');
      const next2 = pwField('g.gate.password2', 'new-password');
      // a hidden username field lets a password manager file the new password under the right account
      const name = h('input', { type: 'text', autocomplete: 'username', value: D.userOf(store.get())?.username || '', hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
      f.body.append(name, cur.row, next.row, next2.row, h('p', { class: 'f-hint', text: t('g.gate.passwordHint') }));
      setText(f.go, t('g.acct.pwSave'));
      f.form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (isBusy(f.go)) return;
        const np = next.input.value;
        let bad = null;
        if (!cur.input.value) bad = 'g.gate.badLogin';
        else if (np.length < 10) bad = 'g.gate.reasonTooShort';
        else if (np !== next2.input.value) bad = 'g.gate.mismatch';
        if (bad) return showErr(f.err, t(bad));
        setBusy(f.go, true);
        f.go.classList.add('is-pending');
        setText(f.go, t('g.acct.saving'));
        const body = await authCommand(ctx, 'account_password', { current_password: cur.input.value, new_password: np });
        setBusy(f.go, false);
        f.go.classList.remove('is-pending');
        setText(f.go, t('g.acct.pwSave'));
        if (body.error !== undefined) {
          showErr(f.err, A.failInfo(body));
          f.err.focus({ preventScroll: true });
          return;
        }
        finish();
        ctx.mods.toast?.show?.(t('g.acct.pwChanged'), { tone: 'info' });
        announce(t('g.acct.pwChanged'));
      });
    });
  }

  // ------------------------------------------------------------------ delete account (2 steps)

  function deleteAccount({ opener = null } = {}) {
    begin(opener, (s) => {
      const f = frame('g.acct.delete', { danger: true });
      const st = store.get();
      const bots = D.openBots(st);
      const hasKey = !!D.tnLink(st);
      const pw = pwField('g.gate.password', 'current-password');
      const word = typedField('DELETE');
      const revoke = hasKey ? tick(t('g.tn.revokeStep'), { link: REVOKE_URL }) : null;
      const days = D.backupDaysOf(st);
      f.body.append(
        h('p', { class: 'dlg-lead', text: t('g.acct.deleteBody') }),
        h('p', { class: 'dlg-note', text: t('g.acct.closesBots') }),
        botList(bots),
        h('p', { class: 'dlg-note', text: t('g.acct.deleteBackups', { days }) }),
        // native append() would print "null" for a missing row: only real nodes go in
        ...[revoke?.row, pw.row, word.row].filter(Boolean),
      );
      const step2 = h('div', { class: 'acct-step2', hidden: true });
      let force = null;
      f.body.append(step2);
      setText(f.go, t('g.acct.deleteGo'));
      const sync = () => setBlocked(f.go, word.input.value.trim() !== 'DELETE' || !pw.input.value || (revoke && !revoke.input.checked) || (force && !force.input.checked));
      for (const el of [word.input, pw.input, revoke?.input].filter(Boolean)) el.addEventListener('input', sync);
      revoke?.input.addEventListener('change', sync);
      sync();
      f.form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (isBusy(f.go)) return;
        if (isBlocked(f.go)) {
          showErr(f.err, t('g.err.confirm_required'));
          return;
        }
        setBusy(f.go, true);
        f.go.classList.add('is-pending');
        setText(f.go, t('g.acct.deleting'));
        const params = { password: pw.input.value, confirm: 'DELETE' };
        if (force?.input.checked) params.force = true;
        const body = await authCommand(ctx, 'account_delete', params);
        setBusy(f.go, false);
        f.go.classList.remove('is-pending');
        setText(f.go, t(force ? 'g.acct.deleteAnyway' : 'g.acct.deleteGo'));
        if (body.error !== undefined) {
          if (body.code === 'testnet_positions_open' && !force) {
            // step 2 (§9.2): the positions that stay open, and a required "delete anyway" tick → force:true
            const coins = positionsText(body.positions);
            force = tick(t('g.acct.deleteAnyway'));
            step2.replaceChildren(h('p', { class: 'dlg-warn', text: t('g.acct.deleteForce', { coins }) }), force.row);
            step2.hidden = false;
            force.input.addEventListener('change', sync);
            setText(f.go, t('g.acct.deleteAnyway'));
            sync();
            force.input.focus();
            return;
          }
          showErr(f.err, A.failInfo(body));
          f.err.focus({ preventScroll: true });
          return;
        }
        const left = Array.isArray(body.testnet_left_open) ? body.testnet_left_open : [];
        finish();
        p.close({ restore: false });
        signedOut(ctx, { reason: 'deleted' });
        const msg = left.length ? t('g.acct.deletedOpen', { coins: positionsText(left) }) : t('g.acct.deleted');
        ctx.mods.toast?.show?.(msg, { tone: left.length ? 'warn' : 'info', ms: left.length ? 15000 : 6000 });
        announce(msg);
      });
    });
  }

  // ------------------------------------------------------------------ new paper season

  function newSeason({ opener = null } = {}) {
    begin(opener, (s) => {
      const f = frame('g.acct.reset');
      const word = typedField('RESET');
      const lead = h('p', { class: 'dlg-lead' });
      const list = h('div');
      const wait = h('p', { class: 'dlg-warn', hidden: true });
      f.body.append(lead, list, wait, word.row);
      setText(f.go, t('g.acct.resetGo'));
      let listKey = '';
      s.render = () => {
        const st = store.get();
        const paper = D.paperBots(st);
        const cap = Number(st.live?.caps?.account_usd ?? st.venues?.paper?.account_usd ?? st.live?.account_usd);
        setText(lead, t('g.acct.resetBody', { n: paper.length, usd: Number.isFinite(cap) ? usd(cap, 0) : '$10,000', season: D.seasonOf(st) ?? 1 }));
        const key = paper.map((b) => b.id).join(',') + '|' + (st.marks?.t ?? '');
        if (key !== listKey) {
          listKey = key;
          list.replaceChildren(botList(paper));
        }
        const at = D.resetAfterOf(st);
        const left = at === null ? 0 : at - D.nowOf(st);
        const halted = D.isHalted(st);
        wait.hidden = !(left > 0 || halted);
        setText(wait, halted ? t('g.plant.tnReason.halted') : left > 0 ? t('g.acct.resetWait', { time: longWait(left) }) : '');
        setBlocked(f.go, left > 0 || halted || word.input.value.trim() !== 'RESET');
      };
      word.input.addEventListener('input', () => s.render());
      const timer = setInterval(() => s.render(), 1000);
      const off = watch(store, (st) => [st.bots, st.marks?.t, st.live], () => s.render(), arrEq);
      s.off = () => {
        clearInterval(timer);
        off();
      };
      f.form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (isBusy(f.go)) return;
        if (isBlocked(f.go)) return showErr(f.err, wait.hidden ? t('g.err.confirm_required') : wait.textContent);
        setBusy(f.go, true);
        f.go.classList.add('is-pending');
        setText(f.go, t('g.ask.sending'));
        const body = await A.resetSeason();
        setBusy(f.go, false);
        f.go.classList.remove('is-pending');
        setText(f.go, t('g.acct.resetGo'));
        if (body?.error !== undefined) {
          showErr(f.err, A.failInfo(body));
          f.err.focus({ preventScroll: true });
          return;
        }
        finish();
        ctx.mods.toast?.show?.(t('g.acct.resetDone', { season: body.season ?? '?', usd: usd(body.account_usd, 0) }), { tone: 'info' });
      });
      s.render();
    });
  }

  // ------------------------------------------------------------------ re-arm (accounts mode, QA-16)

  function rearm({ opener = null } = {}) {
    begin(opener, (s) => {
      const f = frame('g.rearm');
      const word = typedField('REARM');
      const lead = h('p', { class: 'dlg-lead' });
      const wait = h('p', { class: 'dlg-warn', hidden: true });
      f.body.append(lead, wait, word.row);
      setText(f.go, t('g.rearm.go'));
      s.render = () => {
        const st = store.get();
        const r = D.rearmState(st);
        setText(lead, t('g.rearm.body', { time: hhmm(D.haltedAtOf(st)) }));
        wait.hidden = r.can;
        setText(wait, r.can ? '' : t('g.rearm.wait', { time: countdown(r.waitMs) }));
        setBlocked(f.go, !r.can || word.input.value.trim() !== 'REARM');
        if (!r.halted) finish();
      };
      word.input.addEventListener('input', () => s.render());
      const timer = setInterval(() => s.render(), 1000);
      s.off = () => clearInterval(timer);
      f.form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (isBusy(f.go)) return;
        if (isBlocked(f.go)) return showErr(f.err, wait.hidden ? t('g.err.confirm_required') : wait.textContent);
        setBusy(f.go, true);
        f.go.classList.add('is-pending');
        const body = await A.rearm();
        setBusy(f.go, false);
        f.go.classList.remove('is-pending');
        if (body?.error !== undefined) {
          showErr(f.err, A.failInfo(body));
          f.err.focus({ preventScroll: true });
          return;
        }
        finish();
      });
      s.render();
    });
  }

  // ------------------------------------------------------------------ the one-time reset notice (§9.1 step 5)

  function resetNotice() {
    begin(null, () => {
      const f = frame('g.acct.menu');
      f.body.append(h('p', { class: 'dlg-lead', text: t('g.acct.resetNotice') }));
      f.cancel.hidden = true;
      f.go.setAttribute('data-autofocus', '');
      setText(f.go, t('g.acct.ok'));
      f.form.addEventListener('submit', (e) => {
        e.preventDefault();
        finish();
      });
    });
  }

  // ------------------------------------------------------------------ sign out / sessions

  async function logout(all, btn) {
    if (isBusy(btn)) return;
    setBusy(btn, true);
    const body = await authCommand(ctx, all ? 'auth_logout_all' : 'auth_logout', {});
    setBusy(btn, false);
    if (body.error !== undefined && body.status !== 401) {
      const info = A.failInfo(body);
      ctx.mods.toast?.show?.(info.text, { tone: 'warn' });
      announce(info.text);
      return;
    }
    p.close({ restore: false });
    signedOut(ctx, { reason: all ? 'logout_all' : 'logout' });
    announce(t('g.acct.signedOut'));
  }

  async function toggleSessions() {
    if (!sessionsBox.hidden) {
      sessionsBox.hidden = true;
      items.sessions.setAttribute('aria-expanded', 'false');
      return;
    }
    sessionsBox.hidden = false;
    items.sessions.setAttribute('aria-expanded', 'true');
    sessionsBox.replaceChildren(h('p', { class: 'muted', text: t('g.acct.loading') }));
    let rows = [];
    try {
      const r = await query(ctx, 'sessions');
      rows = Array.isArray(r?.rows) ? r.rows : [];
    } catch (e) {
      sessionsBox.replaceChildren(h('p', { class: 'dlg-error', text: errInfo(e, { accounts: true }).text }));
      return;
    }
    const now = D.nowOf(store.get());
    const others = rows.filter((x) => !x.current);
    const lines = rows.map((x) => {
      const age = isNum(x.last_seen_ms) ? ageText(x.last_seen_ms, now) : '—';
      const li = h('li', { class: 'acct-session' }, h('span', { text: t('g.acct.sessionLine', { agent: String(x.user_agent || '?').slice(0, 60), ip: x.ip_prefix || '—', age }) }), x.current ? h('b', { class: 'muted', text: ` (${t('g.acct.sessionThis')})` }) : null);
      if (!x.current) {
        const end = h('button', { type: 'button', class: 'btn btn--sm btn--paper', text: t('g.acct.sessionEnd') });
        end.addEventListener('click', async () => {
          setBusy(end, true);
          const body = await authCommand(ctx, 'session_revoke', { id: x.id });
          setBusy(end, false);
          if (body.error !== undefined) return announce(A.failText(body));
          li.remove();
        });
        li.append(' ', end);
      }
      return li;
    });
    // native replaceChildren() would print "null": the "no other devices" line only when there are none
    const list = h('ul', { class: 'acct-sessions-list' }, lines);
    if (others.length) sessionsBox.replaceChildren(list);
    else sessionsBox.replaceChildren(list, h('p', { class: 'muted', text: t('g.acct.sessionsNone') }));
  }

  // ------------------------------------------------------------------ operator (admins, P1)

  async function loadStatus() {
    try {
      const st = await query(ctx, 'admin_status');
      const tn = st?.testnet || {};
      setText(opStatus, t('g.acct.opStatus', { users: st?.users ?? '—', sessions: st?.sessions_active ?? '—', gardens: st?.gardens_loaded ?? '—', state: tn.state ?? '—', active: tn.active_users ?? '—' }));
    } catch (e) {
      setText(opStatus, errInfo(e, { accounts: true }).text);
    }
  }
  opToggle.addEventListener('click', async () => {
    if (isBusy(opToggle)) return;
    const on = !D.killSwitchOf(store.get()).on;
    setBusy(opToggle, true);
    const body = await authCommand(ctx, 'admin_kill_switch', { on, reason: opReason.value.trim().slice(0, 200) || null });
    setBusy(opToggle, false);
    showErr(opErr, body.error !== undefined ? A.failInfo(body) : null);
    refreshTestnet(ctx);
    loadStatus();
  });
  faultGo.addEventListener('click', async () => {
    const fault = faultInput.value.trim();
    if (!fault || isBusy(faultGo)) return;
    let args = {};
    const raw = argsInput.value.trim();
    if (raw) {
      try {
        args = JSON.parse(raw);
      } catch {
        args = null;
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return showErr(opErr, t('g.acct.devBadArgs'));
    }
    setBusy(faultGo, true);
    const body = await authCommand(ctx, 'dev_double', { fault, args });
    setBusy(faultGo, false);
    if (body.status === 404) {
      // no double on this server (production, or the real testnet): the dev panel goes away for this page
      devMissing = true;
      faultBox.hidden = true;
      return showErr(opErr, null);
    }
    showErr(opErr, body.error !== undefined ? A.failInfo(body) : null);
    if (body.error !== undefined) return;
    // the double's answer (dev only): `new_account` hands back a throwaway testnet account + agent key for QA-18
    devAccount = body.account_address && body.agent_key ? { address: body.account_address, key: body.agent_key } : devAccount;
    faultOut.hidden = false;
    setText(faultOut, JSON.stringify({ ...body, agent_key: body.agent_key ? '0x…(' + t('g.acct.devKeyHidden') + ')' : undefined }, null, 1));
    faultUse.hidden = !devAccount;
    refreshTestnet(ctx);
  });
  faultUse.addEventListener('click', () => {
    if (!devAccount) return;
    ctx.mods.testnet?.open?.({ opener: faultUse, prefill: devAccount });
  });

  // ------------------------------------------------------------------ render

  function render() {
    const s = store.get();
    const u = D.userOf(s);
    const accounts = D.isAccounts(s);
    p.setTitle(t('g.acct.menu'));
    // HUD button (desktop) and the More sheet header (phone)
    show(hudBtn, accounts && !!u);
    if (hudBtn) {
      setText(hudBtn.querySelector('.acct-name'), u?.username || '');
      setAttr(hudBtn, 'aria-label', t('g.acct.menuLabel', { name: u?.username || '' }));
      setAttr(hudBtn, 'title', t('g.acct.signedInAs', { name: u?.username || '' }));
      setAttr(hudBtn, 'aria-expanded', String(p.isOpen()));
    }
    attachMore();
    moreHead.hidden = !(accounts && u);
    setText(moreHead.querySelector('.more-user'), u ? t('g.acct.signedInAs', { name: u.username }) : '');
    moreAcct.hidden = !(accounts && u);
    setText(moreAcct.querySelector('.more-text'), t('g.acct.menu'));
    moreSignIn.hidden = !(accounts && !u);
    setText(moreSignIn.querySelector('.more-text'), t('g.gate.signin'));
    if (!accounts || !u) {
      // signed out (or the session ended): no account dialog may outlive its player (it would act as a spectator)
      if (session) finish();
      if (p.isOpen()) p.close({ restore: false });
      return;
    }
    setText(who, t('g.acct.signedInAs', { name: u.username }));
    const sn = D.seasonOf(s);
    season.hidden = sn === null;
    setText(season, sn === null ? '' : t('g.acct.season', { season: sn }));
    for (const b of Object.values(items)) setText(b.querySelector('.acct-label'), t(b.dataset.key));
    const sub = (b, text) => setText(b.querySelector('.acct-sub'), text || '');
    // testnet entry: connect / connected ✓ / reconnect needed (hidden when the server has no testnet)
    const tnOn = D.testnetEnabled(s);
    items.testnet.closest('li').hidden = !tnOn;
    setText(items.testnet.querySelector('.acct-label'), t(D.tnConnected(s) ? 'g.acct.tnConnected' : D.tnRevoked(s) ? 'g.acct.tnRevoked' : 'g.acct.tnConnect'));
    // re-arm: only while burned; disabled with its countdown during the first 60 s
    const r = D.rearmState(s);
    items.rearm.closest('li').hidden = !r.halted;
    setBlocked(items.rearm, r.halted && !r.can);
    sub(items.rearm, r.halted && !r.can ? t('g.rearm.wait', { time: countdown(r.waitMs) }) : '');
    // a new season: disabled (with its countdown) within 24 h of the last one, and while burned
    const at = D.resetAfterOf(s);
    const left = at === null ? 0 : at - D.nowOf(s);
    setBlocked(items.season, left > 0 || r.halted);
    sub(items.season, r.halted ? t('g.plant.tnReason.halted') : left > 0 ? t('g.acct.resetWait', { time: longWait(left) }) : '');
    // operator panel
    const admin = D.isAdmin(s);
    opBox.hidden = !admin;
    if (admin) {
      const k = D.killSwitchOf(s);
      setText(opTitle, t('g.acct.operator'));
      setText(opState, `${t('g.acct.opKill')}: ${k.on ? t('g.badge.kill') : t('g.set.off')}${k.reason ? ' — ' + k.reason : ''}`);
      setText(opReasonLabel, t('g.acct.opReason'));
      setText(opToggle, t(k.on ? 'g.acct.opOff' : 'g.acct.opOn'));
      faultBox.hidden = devMissing || !D.testnetEnabled(s);
      setText(faultSum, t('g.acct.devTitle'));
      for (const el of faultBox.querySelectorAll('[data-key]')) setText(el, t(el.dataset.key));
      setText(faultGo, t('g.acct.devRun'));
      setText(faultUse, t('g.acct.devUse'));
    }
  }

  p.onOpen(() => {
    render();
    if (D.isAdmin(store.get())) loadStatus();
  });
  p.onClose(render);
  watch(store, (s) => [D.modeOf(s), D.userOf(s)?.id, D.userOf(s)?.role, s.live?.halted, s.live?.rearm_after_ms, s.live?.reset_after_ms, D.tnConnected(s), D.tnRevoked(s), D.killSwitchOf(s).on, D.seasonOf(s), D.testnetEnabled(s)], render, arrEq);
  const timer = setInterval(() => p.isOpen() && render(), 1000);
  on(ctx, 'ui:signedIn', render);
  onLangChange(() => {
    render();
    session?.render?.();
  });
  render();

  const apiOut = { open: (o = {}) => p.open(o), panel: p, resetNotice, rearm, season: newSeason, deleteAccount, changePassword, dispose: () => clearInterval(timer) };
  ctx.mods.account = apiOut;
  return apiOut;
}

function arrEq(a, b) {
  return !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

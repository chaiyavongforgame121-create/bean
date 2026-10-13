/**
 * ui/testnet.js — Connect Hyperliquid TESTNET (PLATFORM §9.3; Settings → Testnet, and from the plant dialog).
 *
 *   Top to bottom: the red-bordered warning (g.tn.warnTestnet, g.tn.warnKeys, always visible) · how-to with the
 *   app.hyperliquid-testnet.xyz/API link · the faucet truth (g.tn.faucet: /drip pays only an address that has
 *   deposited on mainnet) · "testnet is optional" · the trust note · the account address · the API-wallet key.
 *
 *   The key field is NOT a password field and NOT inside any <form> (a password manager must never capture it, nor
 *   autofill it into the gate): type="text" masked with CSS -webkit-text-security, autocomplete/autocorrect/
 *   autocapitalize off, spellcheck false, data-1p-ignore / data-lpignore / data-bwignore; where the browser cannot
 *   mask it, the key shows in plain text with g.tn.keyVisible. It is cleared on success and when the panel closes.
 *   Client checks (the server repeats them; refused input is never sent, so it never counts against the limit):
 *   12–24 words → g.tn.err.seed; else ^(0x)?[0-9a-fA-F]{64}$ (g.tn.err.format); the address 0x + 40 hex.
 *
 *   Connected: account and agent (truncated) with its name, "valid until" (amber < 7 d, red < 1 d, g.tn.expiring),
 *   the testnet account value (≈ for unified accounts) and free collateral with their age, requests left, the
 *   warnings of the last connect (unnamed agent, expiring soon, low funds, existing positions), Check again,
 *   Replace API wallet (same account, bots kept) and Disconnect (bots choice, backups note, required revoke step;
 *   after 409 testnet_positions_open the positions and a required force tick).
 *
 * Exports: mount(deps) → { open(o), close() }, and the pure checkKeyInput(), shortAddr(), keyMaskSupported().
 * No three.js, no side effects at import.
 */

import { t, onLangChange } from '../../i18n.js';
import { usd } from '../../format.js';
import { getCtx } from './context.js';
import { h, $, setText, setAttr, show, setBusy, isBusy, setBlocked, isBlocked, trapTab, watch, showErr, ageLabel, uid, nextFrame, positionsText, waitText } from './util.js';
import { getSheets } from './sheets.js';
import { getActions } from './actions.js';
import { authCommand, refreshTestnet } from './session.js';
import { announce } from './a11y.js';
import * as D from './derive.js';

export const TN_API_URL = 'https://app.hyperliquid-testnet.xyz/API';
export const TN_DRIP_URL = 'https://app.hyperliquid-testnet.xyz/drip';
const KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
/** Server refusals after which the pasted key is cleared from the field (§6.7: never a key to keep around). */
const KEY_REFUSALS = new Set(['seed_phrase', 'master_key', 'mainnet_key']);

/**
 * Pure client checks (§9.3). → null when the pair may be sent, else { key, field }.
 * A seed phrase (12–24 words) is refused first and never sent anywhere.
 */
export function checkKeyInput(address, key) {
  const k = String(key ?? '').trim();
  const words = k.split(/\s+/).filter(Boolean);
  if (words.length >= 12 && words.length <= 24 && words.every((w) => /^[A-Za-z]+$/.test(w))) return { key: 'g.tn.err.seed', field: 'key' };
  const a = String(address ?? '').trim();
  if (!ADDR_RE.test(a)) return { key: 'g.err.bad_address', field: 'address' };
  if (!KEY_RE.test(k)) return { key: 'g.tn.err.format', field: 'key' };
  return null;
}

/** "0x12…ab" (a shown address is never the full string; the full one is in the title). */
export function shortAddr(a) {
  const s = String(a ?? '');
  return /^0x[0-9a-fA-F]{8,}$/.test(s) ? `${s.slice(0, 6)}…${s.slice(-4)}` : s || '—';
}

// ------------------------------------------------------------------ P1: approve with my wallet (§6.10)

const DAY_MS = 86_400_000;
/** Frozen EIP-712 pieces of Hyperliquid's user-signed approveAgent. "Testnet" is a literal here, never a server value. */
export const APPROVE_DOMAIN = Object.freeze({ name: 'HyperliquidSignTransaction', version: '1', verifyingContract: '0x0000000000000000000000000000000000000000' });
export const APPROVE_PRIMARY = 'HyperliquidTransaction:ApproveAgent';
export const APPROVE_CHAIN = 'Testnet';

/**
 * Check the server's testnet_agent_prepare answer before the wallet sees anything (§6.10 step 2.1):
 * agent address ^0x[0-9a-f]{40}$, name "bean-garden valid_until <13 digits>" 1–180 days ahead, nonce within ±5 min.
 * → null when it may be signed, else the name of the bad field.
 */
export function checkPrepared(p, nowMs = Date.now()) {
  if (!p || typeof p !== 'object') return 'shape';
  if (!/^0x[0-9a-f]{40}$/.test(String(p.agent_address ?? ''))) return 'agent_address';
  const m = /^bean-garden valid_until (\d{13})$/.exec(String(p.agent_name ?? ''));
  if (!m) return 'agent_name';
  const ahead = Number(m[1]) - nowMs;
  if (!(ahead >= DAY_MS && ahead <= 180 * DAY_MS)) return 'agent_name';
  const n = Number(p.nonce);
  if (!Number.isSafeInteger(n) || Math.abs(n - nowMs) > 5 * 60_000) return 'nonce';
  return null;
}

/**
 * The eth_signTypedData_v4 payload for approveAgent, built ONLY from frozen constants plus the checked agent values
 * and the wallet's own chain id (an integer in the domain, §6.10 step 2.3). hyperliquidChain is always "Testnet".
 */
export function approveTypedData({ chainId, agentAddress, agentName, nonce }) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      [APPROVE_PRIMARY]: [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'agentAddress', type: 'address' },
        { name: 'agentName', type: 'string' },
        { name: 'nonce', type: 'uint64' },
      ],
    },
    primaryType: APPROVE_PRIMARY,
    domain: { ...APPROVE_DOMAIN, chainId: Number(chainId) },
    message: { hyperliquidChain: APPROVE_CHAIN, agentAddress: String(agentAddress), agentName: String(agentName), nonce: Number(nonce) },
  };
}

/** The EIP-1193 provider, if the page has one (the button only exists then). */
function walletProvider() {
  const eth = globalThis.window?.ethereum;
  return eth && typeof eth.request === 'function' ? eth : null;
}

/** Can this browser mask a text field (CSS -webkit-text-security)? Firefox before 2024 cannot. */
export function keyMaskSupported() {
  try {
    return !!globalThis.CSS?.supports?.('-webkit-text-security', 'disc');
  } catch {
    return false;
  }
}

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('testnet')) return ctx.mods.testnet;
  const { store } = ctx;
  const sheets = getSheets(ctx);
  const A = getActions(ctx);
  const p = sheets.panel('testnet', { side: 'left', titleKey: 'g.tn.title', snap: 92 });
  let replacing = false;
  let lastWarnings = []; // warnings of the last connect / verify answer
  let lastAccount = null; // its account block (until testnet_status catches up)

  // ------------------------------------------------------------------ static parts

  const link = (href, key) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'tn-link', dataset: { key } });
  const warn = h('section', { class: 'tn-warn', role: 'note' }, h('h3', { class: 'tn-warn-title', dataset: { key: 'g.tn.dangerTitle' } }), h('p', { class: 'tn-warn-main', dataset: { key: 'g.tn.warnTestnet' } }), h('p', { dataset: { key: 'g.tn.warnKeys' } }));
  const how = h(
    'section',
    { class: 'tn-how' },
    h('p', { dataset: { key: 'g.tn.how' } }),
    h('p', {}, link(TN_API_URL, 'g.tn.howLink')),
    h('p', { class: 'tn-faucet', dataset: { key: 'g.tn.faucet' } }),
    h('p', {}, link(TN_DRIP_URL, 'g.tn.faucetLink')),
    h('p', { class: 'tn-optional', dataset: { key: 'g.tn.optional' } }),
    h('p', { class: 'tn-trust muted', dataset: { key: 'g.tn.trust' } }),
  );

  // connected state
  const st = {
    box: h('section', { class: 'tn-state', hidden: true }),
    head: h('p', { class: 'tn-connected' }),
    agent: h('p', { class: 'tn-agent muted' }),
    since: h('p', { class: 'tn-since muted' }),
    expiry: h('p', { class: 'tn-expiry' }),
    expWarn: h('p', { class: 'tn-expwarn', hidden: true }),
    balance: h('p', { class: 'tn-balance num' }),
    est: h('p', { class: 'tn-est muted', hidden: true }),
    state: h('p', { class: 'tn-feed muted' }),
    requests: h('p', { class: 'tn-requests muted num' }),
    warnings: h('ul', { class: 'tn-warnings' }),
    positions: h('p', { class: 'tn-positions muted num' }),
    revoked: h('p', { class: 'tn-revoked', role: 'status', hidden: true }),
    verify: h('button', { type: 'button', class: 'btn btn--paper btn--sm' }),
    replace: h('button', { type: 'button', class: 'btn btn--paper btn--sm' }),
    disconnect: h('button', { type: 'button', class: 'btn btn--danger-outline btn--sm' }),
    err: h('div', { class: 'dlg-error', role: 'alert', tabindex: '-1', hidden: true }),
  };
  st.box.append(st.head, st.agent, st.since, st.expiry, st.expWarn, st.balance, st.est, st.state, st.requests, st.warnings, st.positions, st.revoked, st.err, h('div', { class: 'tn-actions' }, st.verify, st.replace, st.disconnect));

  // the key form: NOT a <form> (no password-manager capture), Enter in a field submits
  const addrId = uid('tnAddr');
  const keyId = uid('tnKey');
  const addrLabel = h('label', { class: 'f-label', for: addrId, dataset: { key: 'g.tn.address' } });
  const addr = h('input', { id: addrId, class: 'input input--mono', type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', maxlength: '42', placeholder: '0x…', 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-bwignore': '' });
  const keyLabel = h('label', { class: 'f-label', for: keyId, dataset: { key: 'g.tn.key' } });
  const masked = keyMaskSupported();
  const key = h('input', {
    id: keyId,
    class: `input input--mono tn-key${masked ? ' is-masked' : ''}`,
    type: 'text', // never type=password: no browser may offer to save or autofill it (QA-20)
    inputmode: 'text',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    maxlength: '400',
    'data-1p-ignore': '',
    'data-lpignore': 'true',
    'data-bwignore': '',
    'data-form-type': 'other',
    'aria-describedby': keyId + 'Note',
  });
  const keyEye = h('button', { type: 'button', class: 'btn btn--ghost btn--sm tn-eye', 'aria-pressed': 'false', 'aria-controls': keyId, hidden: !masked });
  const keyNote = h('p', { class: 'f-hint f-hint--warn', id: keyId + 'Note', hidden: masked, dataset: { key: 'g.tn.keyVisible' } });
  const replaceHelp = h('p', { class: 'f-hint', hidden: true, dataset: { key: 'g.tn.replaceHelp' } });
  const formErr = h('div', { class: 'dlg-error', role: 'alert', tabindex: '-1', hidden: true });
  const go = h('button', { type: 'button', class: 'btn btn--wood btn--go' });
  const cancelReplace = h('button', { type: 'button', class: 'btn btn--paper', hidden: true, text: '' });
  const form = h(
    'div',
    { class: 'tn-form', role: 'group', 'aria-labelledby': `panel-testnet-title` },
    replaceHelp,
    h('div', { class: 'f-row' }, addrLabel, addr),
    h('div', { class: 'f-row' }, keyLabel, h('div', { class: 'tn-keyline' }, key, keyEye), keyNote),
    formErr,
    h('div', { class: 'dlg-actions' }, cancelReplace, go),
  );
  const signedOutNote = h('div', { class: 'tn-signin', hidden: true }, h('p', { dataset: { key: 'g.tn.notSignedIn' } }), h('button', { type: 'button', class: 'btn btn--wood', dataset: { key: 'g.gate.signin' } }));
  signedOutNote.querySelector('button').addEventListener('click', (e) => ctx.mods.gate?.open?.({ opener: e.currentTarget }));
  const disabledNote = h('p', { class: 'tn-disabled', hidden: true, dataset: { key: 'g.plant.tnReason.testnet_disabled' } });
  // P1 (§6.10): only when the page has an EIP-1193 wallet; the server makes the agent key, the wallet approves it
  const walletBtn = h('button', { type: 'button', class: 'btn btn--paper' });
  const walletErr = h('div', { class: 'dlg-error', role: 'alert', tabindex: '-1', hidden: true });
  const walletBox = h('section', { class: 'tn-wallet', hidden: true }, h('p', { class: 'f-hint', dataset: { key: 'g.tn.walletHow' } }), walletBtn, h('p', { class: 'f-hint f-hint--warn tn-wallet-check', dataset: { key: 'g.tn.walletCheck' } }), walletErr);
  let walletUnavailable = false; // the server answered 404 (no wallet flow there)
  p.body.append(warn, how, signedOutNote, disabledNote, st.box, form, walletBox);

  // ------------------------------------------------------------------ behaviour

  keyEye.addEventListener('click', () => {
    const on = key.classList.toggle('is-masked');
    keyEye.setAttribute('aria-pressed', String(!on));
    render();
  });
  for (const el of [addr, key]) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        connect();
      }
    });
  }
  go.addEventListener('click', () => connect());
  cancelReplace.addEventListener('click', () => {
    replacing = false;
    clearKey();
    showErr(formErr, null);
    render();
  });
  st.replace.addEventListener('click', () => {
    replacing = true;
    addr.value = D.tnLink(store.get())?.account_address || addr.value;
    render();
    nextFrame(() => key.focus());
  });
  st.verify.addEventListener('click', () => verify());
  st.disconnect.addEventListener('click', () => disconnect({ opener: st.disconnect }));
  walletBtn.addEventListener('click', () => approveWithWallet());
  p.onClose(() => {
    clearKey();
    replacing = false;
  });

  /** After a successful testnet_connect / testnet_agent_approve: the connected state, warnings, toast. */
  function connected(body) {
    clearKey();
    lastWarnings = Array.isArray(body.warnings) ? body.warnings : [];
    lastAccount = body.account || null;
    const msg = t(body.replaced ? 'g.tn.replaced' : 'g.tn.connectedNote');
    replacing = false;
    ctx.mods.toast?.show?.(msg, { tone: 'info' });
    announce(msg);
    if (body.testnet) store.set((s0) => ({ me: { ...(s0.me || {}), testnet: body.testnet } }));
    refreshTestnet(ctx);
    render();
  }

  /**
   * P1 browser-wallet flow (§6.10): prepare → check the three values → eth_requestAccounts + eth_chainId → sign the
   * typed data built here from frozen constants (hyperliquidChain "Testnet") → relay. The wallet's private key never
   * reaches this page; the agent key is made and kept by the server.
   */
  async function approveWithWallet() {
    const eth = walletProvider();
    if (!eth || isBusy(walletBtn)) return;
    setBusy(walletBtn, true);
    walletBtn.classList.add('is-pending');
    setText(walletBtn, t('g.tn.walletWorking'));
    showErr(walletErr, null);
    const fail = (info) => {
      showErr(walletErr, info);
      walletErr.focus({ preventScroll: true });
    };
    try {
      const prep = await authCommand(ctx, 'testnet_agent_prepare', {});
      if (prep.error !== undefined) {
        if (prep.status === 404) {
          walletUnavailable = true;
          return fail(t('g.tn.walletUnavailable'));
        }
        return fail(connectErr(prep));
      }
      if (checkPrepared(prep, Date.now())) return fail(t('g.tn.err.walletBad'));
      let account;
      let chainId;
      let signature;
      try {
        const accounts = await eth.request({ method: 'eth_requestAccounts' });
        account = Array.isArray(accounts) ? String(accounts[0] || '') : '';
        chainId = parseInt(String(await eth.request({ method: 'eth_chainId' })), 16);
        if (!/^0x[0-9a-fA-F]{40}$/.test(account) || !Number.isSafeInteger(chainId) || chainId <= 0) return fail(t('g.tn.err.walletBad'));
        const typed = approveTypedData({ chainId, agentAddress: prep.agent_address, agentName: prep.agent_name, nonce: prep.nonce });
        signature = await eth.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typed)] });
      } catch (e) {
        // 4001 = the player said no in the wallet; anything else is the wallet's own failure
        return fail(t(e?.code === 4001 ? 'g.tn.err.walletRejected' : 'g.tn.err.walletFailed'));
      }
      const body = await authCommand(ctx, 'testnet_agent_approve', { account_address: account, signature: String(signature || ''), nonce: Number(prep.nonce), chain_id: chainId });
      if (body.error !== undefined) return fail(connectErr(body));
      connected(body);
    } finally {
      setBusy(walletBtn, false);
      walletBtn.classList.remove('is-pending');
      setText(walletBtn, t('g.tn.wallet'));
      render();
    }
  }

  function clearKey() {
    key.value = '';
    if (masked) {
      key.classList.add('is-masked');
      keyEye.setAttribute('aria-pressed', 'false');
    }
  }

  /** testnet_connect (also Replace API wallet: same account → replaced:true, bots kept, §6.7 step 8). */
  async function connect() {
    if (isBusy(go)) return;
    const bad = checkKeyInput(addr.value, key.value);
    if (bad) {
      // refused here: the request is never sent (a seed phrase never leaves the browser)
      if (bad.key === 'g.tn.err.seed') clearKey();
      showErr(formErr, t(bad.key));
      (bad.field === 'address' ? addr : key).focus();
      return;
    }
    setBusy(go, true);
    go.classList.add('is-pending');
    setText(go, t('g.tn.verifying'));
    showErr(formErr, null);
    let params = { account_address: addr.value.trim(), agent_key: key.value.trim() };
    const body = await authCommand(ctx, 'testnet_connect', params);
    params = null;
    setBusy(go, false);
    go.classList.remove('is-pending');
    if (body.error !== undefined) {
      // a key the server refused as dangerous (a master or mainnet-known key, a seed phrase) does not stay in the
      // page; transient refusals (mainnet check unavailable, testnet down, 429) keep it for the retry
      if (KEY_REFUSALS.has(body.code)) clearKey();
      render();
      showErr(formErr, connectErr(body));
      formErr.focus({ preventScroll: true });
      return;
    }
    connected(body);
  }

  /** A connect error: 429 carries the wait and the attempts left (§9.5); everything else by its code. */
  function connectErr(body) {
    if (body.status === 429 || body.code === 'rate_limited') {
      // a 429 means the hourly allowance is used up: 0 left unless the server says otherwise
      const left = body.attempts_left ?? body.remaining ?? body.left ?? 0;
      return { text: t('g.tn.err.rate', { time: waitText(body.retry_after_s ?? 60), n: left }), detail: '' };
    }
    return A.failInfo(body);
  }

  async function verify() {
    if (isBusy(st.verify)) return;
    setBusy(st.verify, true);
    st.verify.classList.add('is-pending');
    setText(st.verify, t('g.tn.verifying'));
    const body = await authCommand(ctx, 'testnet_verify', {});
    setBusy(st.verify, false);
    st.verify.classList.remove('is-pending');
    if (body.error !== undefined) showErr(st.err, connectErr(body));
    else {
      showErr(st.err, null);
      lastWarnings = Array.isArray(body.warnings) ? body.warnings : lastWarnings;
      lastAccount = body.account || lastAccount;
      if (body.testnet) store.set((s0) => ({ me: { ...(s0.me || {}), testnet: body.testnet } }));
    }
    refreshTestnet(ctx);
    render();
  }

  // ------------------------------------------------------------------ disconnect dialog (§9.3)

  let dlg = $('tnDlg');
  if (!dlg) {
    dlg = h('dialog', { id: 'tnDlg', class: 'dlg dlg--ask dlg--danger', 'aria-labelledby': 'tnDlgTitle' });
    $('dialogs')?.append(dlg);
  }
  let dlgOpener = null;
  dlg.addEventListener('keydown', (e) => trapTab(dlg, e));
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (dlg.querySelector('[data-busy="1"]')) return;
    closeDlg();
  });
  function closeDlg() {
    if (dlg.open) dlg.close();
    dlgOpener?.focus?.({ preventScroll: true });
    dlgOpener = null;
  }

  function disconnect({ opener = null } = {}) {
    dlgOpener = opener;
    const s = store.get();
    const bots = D.testnetBots(s);
    const tickRow = (text, { checked = false, href = null } = {}) => {
      const id = uid('tnTick');
      const input = h('input', { id, type: 'checkbox', class: 'check', checked: checked || null });
      return { input, row: h('div', { class: 'acct-tick' }, h('label', { class: 'f-check dlg-check', for: id }, input, h('span', { text })), href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'gate-link', text: t('g.tn.revokeLink') }) : null) };
    };
    const closeBots = bots.length ? tickRow(t('g.tn.disconnectBots', { n: bots.length }), { checked: true }) : null;
    const revoke = tickRow(t('g.tn.revokeStep'), { href: TN_API_URL });
    const step2 = h('div', { hidden: true });
    let force = null;
    const err = h('div', { class: 'dlg-error', role: 'alert', tabindex: '-1', hidden: true });
    const cancel = h('button', { type: 'button', class: 'btn btn--paper', 'data-autofocus': '', text: t('g.ask.cancel') });
    const yes = h('button', { type: 'button', class: 'btn btn--danger', text: t('g.tn.disconnectGo') });
    dlg.replaceChildren(
      h(
        'div',
        { class: 'dlg-card' },
        h('h2', { id: 'tnDlgTitle', class: 'dlg-title', text: t('g.tn.disconnect') }),
        h('div', { class: 'dlg-body' }, closeBots?.row ?? null, h('p', { class: 'dlg-note', text: t('g.tn.disconnectBackups', { days: D.backupDaysOf(s) }) }), revoke.row, step2),
        err,
        h('div', { class: 'dlg-actions' }, cancel, yes),
      ),
    );
    const sync = () => setBlocked(yes, !revoke.input.checked || (force && !force.input.checked));
    revoke.input.addEventListener('change', sync);
    sync();
    cancel.addEventListener('click', () => !isBusy(yes) && closeDlg());
    yes.addEventListener('click', async () => {
      if (isBusy(yes)) return;
      if (isBlocked(yes)) return (force && !force.input.checked ? force.input : revoke.input).focus();
      setBusy(yes, true);
      yes.classList.add('is-pending');
      const params = { close_bots: !!closeBots?.input.checked };
      if (force?.input.checked) params.force = true;
      const body = await authCommand(ctx, 'testnet_disconnect', params);
      setBusy(yes, false);
      yes.classList.remove('is-pending');
      if (body.error !== undefined) {
        if (body.code === 'testnet_positions_open' && !force) {
          force = tickRow(t('g.tn.disconnectAnyway'));
          step2.replaceChildren(h('p', { class: 'dlg-warn', text: t('g.tn.disconnectForce', { coins: positionsText(body.positions) }) }), force.row);
          step2.hidden = false;
          force.input.addEventListener('change', sync);
          setText(yes, t('g.tn.disconnectAnyway'));
          sync();
          force.input.focus();
          return;
        }
        showErr(err, A.failInfo(body));
        err.focus({ preventScroll: true });
        return;
      }
      closeDlg();
      lastWarnings = [];
      lastAccount = null;
      store.set((s0) => ({ me: { ...(s0.me || {}), testnet: null } }));
      refreshTestnet(ctx);
      const msg = t('g.tn.disconnected');
      ctx.mods.toast?.show?.(msg, { tone: 'info' });
      announce(msg);
      render();
    });
    try {
      dlg.showModal();
    } catch {
      dlg.setAttribute('open', '');
    }
    nextFrame(() => cancel.focus());
  }

  // ------------------------------------------------------------------ render

  function warningLine(w) {
    switch (w?.code) {
      case 'unnamed_agent':
        return t('g.tn.warn.unnamed');
      case 'agent_expiring_soon':
        return t('g.tn.expiring', { date: dateText(w.valid_until_ms) });
      case 'no_funds':
        return t('g.tn.noFunds', { usd: usd(w.account_value, 2) });
      case 'existing_positions':
        return t('g.tn.positionsWarn', { coins: Array.isArray(w.coins) ? w.coins.join(', ') : '—' });
      default:
        return w?.code ? t('g.err.' + w.code) : '';
    }
  }

  function render() {
    p.setTitle(t('g.tn.title'));
    for (const el of p.body.querySelectorAll('[data-key]')) setText(el, t(el.dataset.key));
    const s = store.get();
    const signedIn = !!D.userOf(s);
    const enabled = D.testnetEnabled(s);
    const link = D.tnLink(s);
    const connected = D.tnConnected(s);
    const revoked = D.tnRevoked(s);
    show(signedOutNote, !signedIn);
    show(disabledNote, signedIn && !enabled);
    st.box.hidden = !signedIn || !enabled || !link;
    form.hidden = !signedIn || !enabled || (!!link && connected && !replacing);
    // the key field's show/hide toggle and the plain-text fallback note
    setText(keyEye, t(key.classList.contains('is-masked') ? 'g.tn.showKey' : 'g.tn.hideKey'));
    replaceHelp.hidden = !replacing;
    addr.readOnly = replacing;
    cancelReplace.hidden = !replacing;
    setText(cancelReplace, t('g.ask.cancel'));
    key.placeholder = t('g.tn.keyPlaceholder');
    if (!isBusy(go)) setText(go, t(replacing ? 'g.tn.replaceGo' : 'g.tn.verify'));
    // P1 wallet flow: only with an EIP-1193 wallet, while the key form is offered (not connected, or replacing)
    walletBox.hidden = form.hidden || !walletProvider() || walletUnavailable;
    if (!isBusy(walletBtn)) setText(walletBtn, t('g.tn.wallet'));
    if (st.box.hidden) return;

    const now = D.nowOf(s);
    // a revoked / unusable credential is not "Connected": the head says a reconnect is needed (the form is below)
    setText(st.head, t(revoked ? 'g.tn.revokedHead' : 'g.tn.connected', { addr: shortAddr(link.account_address), agent: shortAddr(link.agent_address) }));
    st.head.classList.toggle('tn-connected--revoked', revoked);
    setAttr(st.head, 'title', `${link.account_address || ''} · ${link.agent_address || ''}`);
    setText(st.agent, t('g.tn.agentName', { agent: shortAddr(link.agent_address), name: link.agent_name || t('g.tn.unnamed') }));
    st.since.hidden = !link.connected_ms;
    setText(st.since, link.connected_ms ? t('g.tn.connectedSince', { date: dateText(link.connected_ms) }) : '');
    const exp = D.tnExpiry(s, now);
    setText(st.expiry, exp.validUntil ? t('g.tn.validUntil', { date: dateText(exp.validUntil) }) : t('g.tn.expiryUnknown'));
    st.expiry.dataset.tone = exp.warn === '1d' ? 'red' : exp.warn === '7d' ? 'amber' : '';
    st.expWarn.hidden = !exp.warn;
    setText(st.expWarn, exp.warn ? t('g.tn.expiring', { date: dateText(exp.validUntil) }) : '');
    st.expWarn.dataset.tone = exp.warn === '1d' ? 'red' : 'amber';
    // exchange numbers plain with their age; ≈ for a unified account value we computed (§9.6 J1)
    const led = D.tnLedger(s);
    const acct = led.account_value !== null ? led : lastAccount ? { account_value: lastAccount.account_value, est: !!lastAccount.account_value_est, free: lastAccount.withdrawable ?? lastAccount.free, as_of_ms: lastAccount.as_of_ms } : led;
    const age = ageLabel(acct.as_of_ms, now);
    setText(st.balance, acct.account_value === null || acct.account_value === undefined ? '' : t('g.tn.balance', { usd: (acct.est ? '≈ ' : '') + usd(acct.account_value, 2), free: usd(acct.free, 2), age: age.text }));
    st.balance.className = `tn-balance num age--${age.kind}`;
    st.est.hidden = !acct.est;
    setText(st.est, t('g.tn.estimate'));
    setText(st.state, t('g.tn.state', { state: t('g.tn.state.' + D.tnState(s)) }));
    const req = D.tnStatus(s)?.requests;
    st.requests.hidden = !req || req.cap === undefined;
    if (req) setText(st.requests, t('g.tn.requests', { n: Math.max(0, (Number(req.cap) || 0) - (Number(req.used) || 0)).toLocaleString('en-US') }));
    const warns = lastWarnings.map(warningLine).filter(Boolean);
    st.warnings.replaceChildren(...warns.map((w) => h('li', { class: 'tn-warnline', text: w })));
    const pos = D.tnStatus(s)?.positions;
    st.positions.hidden = !Array.isArray(pos) || !pos.length;
    if (Array.isArray(pos) && pos.length) setText(st.positions, t('g.tn.positions', { list: positionsText(pos) }));
    st.revoked.hidden = !revoked;
    setText(st.revoked, revoked ? t('g.tn.err.revoked') : '');
    setText(st.verify, t('g.tn.verifyAgain'));
    setText(st.replace, t('g.tn.replace'));
    setText(st.disconnect, t('g.tn.disconnect'));
    st.replace.hidden = replacing;
  }

  /**
   * Open the panel. `prefill` ({address, key}) comes only from the --testnet-double dev panel (a throwaway double
   * account, QA-18); a real key is only ever typed or pasted by the player.
   */
  function open({ opener = null, prefill = null } = {}) {
    if (prefill && typeof prefill === 'object') {
      if (D.tnConnected(store.get())) replacing = true;
      addr.value = String(prefill.address || '');
      key.value = String(prefill.key || '');
    }
    render();
    p.open({ opener, snap: 92 });
  }

  p.onOpen(render);
  // a player change (sign-out, session end, another account) drops every typed secret and any open dialog
  let lastUid = D.userOf(store.get())?.id ?? null;
  watch(store, (s) => D.userOf(s)?.id ?? null, (id) => {
    if (id === lastUid) return;
    lastUid = id;
    clearKey();
    addr.value = '';
    replacing = false;
    lastWarnings = [];
    lastAccount = null;
    showErr(formErr, null);
    showErr(walletErr, null);
    if (dlg.open) closeDlg();
    if (id === null && p.isOpen()) p.close({ restore: false });
  });
  watch(store, (s) => [D.userOf(s)?.id, D.tnLink(s), D.tnStatus(s), D.tnVenue(s), D.testnetEnabled(s), D.tnMarket(s)?.state, s.marks?.testnet_account], () => p.isOpen() && render(), arrEq);
  const timer = setInterval(() => p.isOpen() && render(), 5000); // ages
  onLangChange(() => p.isOpen() && render());

  const apiOut = { open, close: () => p.close({ restore: true }), panel: p, dispose: () => clearInterval(timer) };
  ctx.mods.testnet = apiOut;
  return apiOut;
}

/** "11 Oct 2026, 14:03" in the page language (a date the player can act on). */
function dateText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  try {
    return new Date(n).toLocaleString(document.documentElement.lang === 'th' ? 'th-TH' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(n).toISOString().slice(0, 16).replace('T', ' ');
  }
}
export { dateText };

function arrEq(a, b) {
  return !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

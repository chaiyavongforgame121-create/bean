// test/game-platform.test.js — WP5 (PLATFORM.md §9, §11.2): the pure frontend pieces of the platform upgrade.
//
//   - i18n parity for every new key AND every machine code exported by server/catalog.js (ERROR_CODES) and
//     server/hl/errors.js (EXCHANGE_CODES, NOTE_CODES); no raw English in Thai (QA-21, §12.4);
//   - errText code mapping (accounts / none mode), diary.lineFor for every §8.7 kind (QA-19);
//   - venue badge text (desktop second badge and the phone combined chip, J9);
//   - plant-dialog testnet math against testnet_quote fixtures (stake-independent enable rule, clamp, divergence
//     thresholds, slippage, thin book) and the key / gate validation;
//   - spectator routing (QA-02), the after-harvest card (QA-04), the accounts-mode copy (QA-19), ledgers;
//   - QA-01 (landmark picks and ≥ 44 px tap targets), QA-05 (fruit silhouettes and size), QA-06 (default framing)
//     and QA-07 (triangle budgets) with a headless camera: three is loaded through a resolve hook (no GPU, no DOM).
//
// Offline: no network, no server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const imp = (p) => import(new URL(p, ROOT).href);
const read = (p) => fs.readFileSync(new URL(p, ROOT), 'utf8');

// browser-ish globals some helpers touch lazily (never at import)
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const I = await imp('web/js/i18n.js');
const CODES = await imp('web/js/game/ui/codes.js');
const U = await imp('web/js/game/ui/util.js');
const DR = await imp('web/js/game/ui/derive.js');
const DY = await imp('web/js/game/ui/diary.js');
const BG = await imp('web/js/game/ui/badge.js');
const PD = await imp('web/js/game/ui/plantDialog.js');
const GT = await imp('web/js/game/ui/gate.js');
const TN = await imp('web/js/game/ui/testnet.js');
const IN = await imp('web/js/game/ui/inspector.js');
const HU = await imp('web/js/game/ui/hud.js');
const HP = await imp('web/js/game/ui/help.js');
const PT = await imp('web/js/game/ui/plotText.js');
const V = await imp('web/js/game/core/view.js');
const CAM = await imp('web/js/game/gfx/camera.js');

const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join();
const inLang = (lang, fn) => {
  const prev = I.getLang();
  I.setLang(lang);
  try {
    return fn();
  } finally {
    I.setLang(prev);
  }
};

/** The server's code lists (the source of truth), falling back to the client lists while a module is missing. */
async function serverCodes() {
  const out = { error: CODES.ERROR_CODES, exchange: CODES.EXCHANGE_CODES, note: CODES.NOTE_CODES, sources: [] };
  try {
    const cat = await imp('server/catalog.js');
    if (Array.isArray(cat.ERROR_CODES) && cat.ERROR_CODES.length) {
      out.error = cat.ERROR_CODES;
      out.sources.push('catalog');
    }
  } catch {
    /* WP4 module not there yet: the client list covers §8.9 */
  }
  try {
    const e = await imp('server/hl/errors.js');
    if (Array.isArray(e.EXCHANGE_CODES) && e.EXCHANGE_CODES.length) out.exchange = e.EXCHANGE_CODES;
    if (Array.isArray(e.NOTE_CODES) && e.NOTE_CODES.length) out.note = e.NOTE_CODES;
    out.sources.push('hl/errors');
  } catch {
    /* WP2 module not there yet: the client lists cover §6.9 / §8.5 */
  }
  return out;
}
const SC = await serverCodes();

// ---------------------------------------------------------------- i18n parity (§9.7, QA-21)

test('i18n: every code of ERROR_CODES, EXCHANGE_CODES and NOTE_CODES has a non-empty EN and TH string with the same placeholders', () => {
  const keys = [...SC.error.map((c) => 'g.err.' + c), ...SC.exchange.map((c) => 'g.err.' + c), ...SC.note.map((c) => 'g.note.' + c)];
  assert.ok(keys.length >= 90, `codes enumerated: ${keys.length} (${SC.sources.join(', ') || 'client lists'})`);
  for (const k of keys) {
    assert.ok(I.STRINGS.en[k], `EN ${k}`);
    assert.ok(I.STRINGS.th[k], `TH ${k}`);
    assert.equal(ph(I.STRINGS.th[k]), ph(I.STRINGS.en[k]), `placeholders of ${k}`);
  }
  // the client lists never drift from the server's
  for (const c of SC.error) assert.ok(CODES.ERROR_CODES.includes(c), `codes.js ERROR_CODES has ${c}`);
  for (const c of SC.exchange) assert.ok(CODES.EXCHANGE_CODES.includes(c), `codes.js EXCHANGE_CODES has ${c}`);
  for (const c of SC.note) assert.ok(CODES.NOTE_CODES.includes(c), `codes.js NOTE_CODES has ${c}`);
});

test('i18n: the §9.7.1 table keys exist verbatim in EN and TH', () => {
  const doc = read('PLATFORM.md');
  const start = doc.indexOf('#### 9.7.1 UI keys');
  const end = doc.indexOf('#### 9.7.2 Code keys');
  const rows = [...doc.slice(start, end).matchAll(/^\| `([a-zA-Z][^`]+)` \| (.*) \| (.*) \|$/gm)];
  assert.ok(rows.length > 150, `table rows: ${rows.length}`);
  for (const [, k, en, th] of rows) {
    assert.equal(I.STRINGS.en[k], en.trim(), `EN ${k}`);
    assert.equal(I.STRINGS.th[k], th.trim(), `TH ${k}`);
  }
});

test('i18n: platform strings in Thai are Thai — no raw English sentence (brand words and codes allowed)', () => {
  // the same in both languages by design: the venue word (§9.7.1 gives TESTNET in Thai too) and g.insp.funding,
  // whose Thai in the §9.7.1 table is "Funding (testnet): {usd}"
  const SAME_OK = new Set(['g.venue.testnet', 'g.src.hlTestnet', 'g.insp.funding']);
  const thai = /[฀-๿]/;
  const platformKeys = Object.keys(I.STRINGS.en).filter((k) => /^(g\.(gate|acct|tn|plant\.tn|plant\.venue|venue|badge\.(testnet|kill|short\.(paperTestnet|testnetDown|kill))|err|note|diary\.(signIn|credential|kill|testnet|sync|fee|rearmed|season|password|session|resync|server|closing)|faq|insp\.(tn|closing|empty|drift|dust|exchange|est|fee|sync|funding|result)|lm\.(signIn|barnTestnet|signpost)|rearm|wait|state\.(closing|closeWait|syncFailed|unfilled|partial)|hud\.(tn|paperCol|testnetCol|ledger)|place|classic|help\.places|tour\.(private|1Accounts)|mode\.realBody(Accounts|Testnet)))|^(plot\.emptyHaltedRearm|modal\.haltedRearm|shelf\.noteHaltedRearm|ask\.burnAccounts|app\.simNoteAccounts)$/.test(k));
  assert.ok(platformKeys.length > 300, `platform keys checked: ${platformKeys.length}`);
  for (const k of platformKeys) {
    const th = I.STRINGS.th[k];
    if (SAME_OK.has(k)) continue;
    assert.ok(thai.test(th), `TH ${k} has Thai text: "${th}"`);
  }
});

// ---------------------------------------------------------------- errText (§9.5, QA-21)

test('errText: a known code is localised (EN and TH), the server text is only a detail; unknown codes keep today\'s text', () => {
  const body = { error: 'too many attempts, retry later', status: 429, code: 'rate_limited', retry_after_s: 125 };
  const en = inLang('en', () => U.errInfo(body, { accounts: true }));
  assert.equal(en.text, 'Too many tries. Try again in 3 min.');
  assert.equal(en.detail, 'too many attempts, retry later');
  const th = inLang('th', () => U.errInfo(body, { accounts: true }));
  assert.match(th.text, /ลองใหม่ใน 3 นาที/);
  // positions → {coins}, sub_reason → {role}
  const pos = inLang('en', () => U.errText({ status: 409, code: 'testnet_positions_open', positions: [{ coin: 'BTC', szi: 0.01 }, { coin: 'ETH', szi: -0.2 }] }));
  assert.match(pos, /BTC 0\.01 · ETH −0\.2/);
  assert.match(inLang('en', () => U.errText({ status: 422, code: 'mainnet_key', sub_reason: 'mainnet_agent' })), /MAINNET \(agent\)/);
  // accounts mode: a 401 is "your session ended", never the command-token copy (QA-19)
  for (const code of ['auth_required', 'session_expired', undefined]) {
    const t401 = inLang('en', () => U.errText({ status: 401, code, error: 'unauthorized' }, { accounts: true }));
    assert.equal(t401, I.STRINGS.en['g.gate.ended']);
    assert.doesNotMatch(t401, /token|🔑/i);
  }
  // accounts mode never shows raw English as the main line, even for an unknown code
  const unk = inLang('th', () => U.errInfo({ status: 500, error: 'internal blah' }, { accounts: true }));
  assert.equal(unk.text, I.STRINGS.th['g.err.unknown']);
  assert.equal(unk.detail, 'internal blah');
  // none mode: exactly today's behaviour
  assert.equal(inLang('en', () => U.errText({ status: 401, error: 'x' })), I.STRINGS.en['err.auth']);
  assert.match(inLang('en', () => U.errText({ status: 0, error: 'boom' })), /boom/);
  assert.equal(inLang('en', () => U.errText({ status: 409, error: 'plain conflict text' })), 'plain conflict text');
});

test('errText: every code reaches a non-empty localised line in EN and TH (QA-21)', () => {
  for (const lang of ['en', 'th']) {
    inLang(lang, () => {
      for (const code of [...SC.error, ...SC.exchange]) {
        const txt = U.errText({ status: 409, code, error: 'raw english' }, { accounts: true });
        assert.ok(txt && txt !== 'raw english' && !txt.startsWith('g.err.'), `${lang} ${code}: ${txt}`);
      }
      for (const code of SC.note) assert.ok(DY.codeText(code, { coin: 'BTC', exch: '1', exp: '2' }), `${lang} note ${code}`);
    });
  }
});

// ---------------------------------------------------------------- diary (§9.5, §8.7)

/** A representative event per §8.7 kind (the line-worthy variant). */
function sampleFor(kind) {
  const base = { kind, raw: { seq: 1 } };
  const ex = {
    warmup_finished: { type: 'warmup', bars: 2880 },
    tick_completed: { type: 'tick', tick: 9 },
    busted: { type: 'busted', bean: 3, coin: 'SOL', onShelf: true },
    daemon_started: { type: 'daemon', version: '0.3.0' },
    feed_status: { type: 'feed', state: 'down' },
    feed_gap: { type: 'gap', mode: 'replay', bars: 3 },
    kill_switch: { on: true, reason: 'maintenance' },
    testnet_feed: { state: 'down', prev: 'live' },
    bot_created: { type: 'created', bot: 'bot-0001', bean: 4, coin: 'ETH', capital_usd: 50, venue: 'testnet' },
    bot_order: { type: 'orderSkipped', bot: 'bot-0001', status: 'skipped' },
    bot_fill: { type: 'fill', bot: 'bot-0001', coin: 'ETH', dir: 'Open Long', sz: 0.01, px: 2400, venue: 'testnet', provisional: true },
    bot_paused: { type: 'paused', bot: 'bot-0001', note_code: 'position_drift', note_vars: { exch: '0.02', exp: '0.01' }, coin: 'ETH', venue: 'testnet', reason: 'drift (english)' },
    bot_resumed: { type: 'resumed', bot: 'bot-0001' },
    bot_closed: { type: 'closed', bot: 'bot-0001', realized_pnl: -1.25, venue: 'testnet', confirmed: false },
    live_error: { type: 'error', bot: 'bot-0001', code: 'ioc_no_match', error: 'Order could not immediately match' },
    live_halted: { type: 'halted', closed: ['bot-0001'] },
    bot_sync: { bot: 'bot-0001', op: 'mirror', state: 'failed', code: 'insufficient_margin', error: 'Insufficient margin' },
    bot_fill_confirmed: { bot: 'bot-0001', coin: 'ETH', fee: 0.0123, closed_pnl: 0.5 },
    testnet_account: { account_value: 1003.7, account_value_est: true, free: 912.4 },
    credential_status: { status: 'revoked', reason: 'agent_unknown' },
    garden_rearmed: {},
    garden_reset: { season: 2, closed: ['bot-0002'], realized_pnl: 4.2 },
    password_reset: {},
    session_ended: { reason: 'logout_all' },
    resync: {},
    server_restart: {},
  }[kind];
  return { ...base, ...ex };
}

test('diary: every §8.7 kind maps to a non-null localised line in EN and TH; no server English in Thai (QA-19, QA-21)', () => {
  assert.equal(CODES.DIARY_KINDS.length, 26);
  const thai = /[฀-๿]/;
  for (const kind of CODES.DIARY_KINDS) {
    for (const lang of ['en', 'th']) {
      const line = inLang(lang, () => DY.lineFor(sampleFor(kind), { szDecimals: () => 4 }));
      assert.ok(line && line.text && !/\bg\.[a-z]+\./.test(line.text), `${lang} ${kind}: ${line?.text}`);
      if (lang === 'th' && !['tick_completed'].includes(kind)) assert.ok(thai.test(line.text), `TH ${kind} is Thai: ${line.text}`);
      assert.doesNotMatch(line.text, /english|Order could not|Insufficient margin/, `${lang} ${kind}: the server text is never the line`);
    }
  }
  // lines about a testnet bot carry the venue word; an unconfirmed close shows ≈
  const created = inLang('en', () => DY.lineFor(sampleFor('bot_created')));
  assert.match(created.text, /^TESTNET · /);
  assert.match(inLang('en', () => DY.lineFor(sampleFor('bot_closed'))).text, /≈ -\$1\.25/);
  // a revoked credential is a warning (mailbox flag); a pause note is the localised note code
  assert.equal(inLang('en', () => DY.lineFor(sampleFor('credential_status'))).kind, 'warn');
  assert.match(inLang('en', () => DY.lineFor(sampleFor('bot_paused'))).text, /exchange holds 0\.02 ETH/);
  // the data layer may pass platform records raw (kind only) or with camelCase types: same line
  assert.equal(DY.lineFor({ type: 'botSync', raw: { bot: 'b', state: 'failed', code: 'tick' } }).kind, 'warn');
  assert.equal(DY.recordEvent({ seq: 9, t: 1, kind: 'garden_reset', season: 3, closed: [] }).type, 'garden_reset');
  // testnet_account lines are throttled (one per 10 min) and never backfilled
  assert.equal(DY.lineFor(sampleFor('testnet_account')).throttle, 'testnet_account');
  // none-mode lines are unchanged
  assert.equal(inLang('en', () => DY.lineFor({ type: 'closed', bot: 'bot-1', realized_pnl: -3.5 })).text, '🪓 bot-1 closed — banked -$3.50');
  // accounts mode: a loss reads as a loss with the typographic minus (J4), never "banked" / "ได้"
  const acc = { accounts: () => true };
  for (const lang of ['en', 'th']) {
    const lossLine = inLang(lang, () => DY.lineFor({ type: 'closed', bot: 'bot-1', realized_pnl: -3.5 }, acc)).text;
    assert.match(lossLine, /−\$3\.50/, `${lang}: ${lossLine}`);
    assert.doesNotMatch(lossLine, /banked|ได้|-\$/, `${lang}: ${lossLine}`);
  }
  // a provisional fill: one pair of parentheses; a confirmed fee: 2 decimals
  const prov = inLang('en', () => DY.lineFor({ type: 'fill', bot: 'b', coin: 'ETH', dir: 'Open Long', sz: 0.1, px: 2500, provisional: true }));
  assert.doesNotMatch(prov.text, /\([^)]*\(/, prov.text);
  assert.match(inLang('en', () => DY.lineFor({ kind: 'bot_fill_confirmed', bot: 'b', fee: 0.5172, closed_pnl: 0 })).text, /fee \$0\.52,/);
});

test('diary: every credential_status reason the server emits has a localised line (QA-21); the own disconnect is info', () => {
  const thai = /[฀-๿]/;
  for (const reason of CODES.CREDENTIAL_REASONS) {
    for (const lang of ['en', 'th']) {
      const line = inLang(lang, () => DY.lineFor({ kind: 'credential_status', status: 'revoked', reason }));
      assert.ok(line && line.text, `${lang} ${reason}`);
      // never the machine code itself: no snake_case code in either language, no code at all in Thai
      if (reason.includes('_') || lang === 'th') assert.ok(!line.text.includes(reason), `${lang} ${reason}: no raw code in "${line.text}"`);
      if (lang === 'th') assert.ok(thai.test(line.text), `TH ${reason} is Thai: ${line.text}`);
    }
  }
  const own = inLang('en', () => DY.lineFor({ kind: 'credential_status', status: 'revoked', reason: 'disconnected' }));
  assert.equal(own.kind, 'info', 'the player chose it: no mailbox flag');
  assert.doesNotMatch(own.text, /paused/);
  assert.equal(inLang('en', () => DY.lineFor({ kind: 'credential_status', status: 'revoked', reason: 'admin_disconnect' })).kind, 'warn');
  const unknown = inLang('th', () => DY.lineFor({ kind: 'credential_status', status: 'error', reason: null }));
  assert.ok(thai.test(unknown.text) && !/error/.test(unknown.text), unknown.text);
});

// ---------------------------------------------------------------- venue badges (§9.4, J9)

const NOW = 1_791_700_000_000;
function accState(over = {}) {
  return {
    mode: { auth: 'accounts', testnet: { enabled: true } },
    user: { id: 7, username: 'nok', role: 'user' },
    net: { ok: true, skewMs: 0 },
    testnet: {
      market: { enabled: true, state: 'live', kill_switch: { on: false }, coins: [{ coin: 'ETH', mid: 2380, mid_ms: NOW, funding_1h: 0.00001, tradeable: true, sz_decimals: 4 }] },
      status: { link: { status: 'verified', account_address: '0x' + '1'.repeat(40), agent_address: '0x' + 'a'.repeat(40), agent_name: 'bean-garden', valid_until_ms: NOW + 30 * 864e5, connected_ms: NOW - 864e5, value_at_connect: 1000 }, account: { account_value: 1003.7, account_value_est: true, free: 912.4, as_of_ms: NOW - 5000 }, expiry: { valid_until_ms: NOW + 30 * 864e5, warn: null } },
    },
    venues: { paper: { account_usd: 10000 }, testnet: { enabled: true, connected: true, state: 'live', account_value: 1003.7, account_value_est: true, free: 912.4, value_at_connect: 1000, connected_ms: NOW - 864e5, as_of_ms: NOW - 5000, bots_open: 1, funding: -0.03 } },
    bots: [],
    live: { halted: false },
    ...over,
  };
}

test('badges: the testnet badge and the phone combined chip keep PAPER and TESTNET visible (J9)', () => {
  assert.equal(BG.testnetBadgeModel({}), null, 'none mode: no second badge');
  assert.equal(BG.testnetBadgeModel(accState({ user: null })), null, 'spectator: none');
  const off = accState();
  off.testnet.status.link = null;
  off.venues.testnet.connected = false;
  assert.equal(BG.testnetBadgeModel(off), null, 'not connected and no testnet bot: none');
  assert.deepEqual(BG.testnetBadgeModel(accState()), { key: 'g.badge.testnet', shortKey: 'g.badge.short.paperTestnet', tone: 'testnet' });
  const down = accState();
  down.testnet.market.state = 'down';
  assert.equal(BG.testnetBadgeModel(down).key, 'g.badge.testnetDown');
  const kill = accState();
  kill.testnet.market.kill_switch = { on: true };
  assert.equal(BG.testnetBadgeModel(kill).key, 'g.badge.kill', 'the kill switch wins over down');
  for (const lang of ['en', 'th']) {
    const paper = I.STRINGS[lang]['g.venue.paper'];
    for (const k of ['g.badge.short.paperTestnet', 'g.badge.short.testnetDown', 'g.badge.short.kill']) {
      const s = I.STRINGS[lang][k];
      assert.ok(s.includes('TESTNET'), `${lang} ${k} names TESTNET`);
      assert.ok(s.includes(paper) || s.includes('PAPER'), `${lang} ${k} names PAPER`);
    }
  }
});

test('plot views: venue fields; a testnet bot is priced at the TESTNET mid; liquidation only from the exchange; funding in the total', () => {
  const bot = { id: 'bot-0001', bean: 4, coin: 'ETH', state: 'active', venue: 'testnet', capital_usd: 100, leverage: 10, realized_pnl: 1, fees: 0.1, mark_px: 2370, mark_ms: NOW - 60_000, real: { szi: 0.04, entry_px: 2350, unrealized_pnl: 0.8, liquidation_px: null, as_of_ms: NOW - 60_000 }, funding_realized: -0.2, exchange: { as_of_ms: NOW - 30_000, liquidation_px: null, funding_since_open: -0.05 }, fill_state: 'partial', target_szi: 0.05, fees_estimated: true, size_ratio: { k: 2.058 }, exchange_sync: { op: 'flatten', state: 'pending' }, closing: true };
  const marks = { t: NOW, px: { ETH: 9999 }, testnet: { px: { ETH: 2400 }, t: NOW } };
  const v = V.plotView(bot, 0, { marks, nowMs: NOW });
  assert.equal(v.venue, 'testnet');
  assert.equal(v.mark, 2400, 'the testnet mid, never the mainnet 9999');
  assert.equal(v.est, true, 'unrealized at the testnet mid is an estimate (≈)');
  assert.ok(Math.abs(v.unrealized - 0.04 * (2400 - 2350)) < 1e-9);
  assert.equal(v.liq, null, 'no invented liquidation price before the first reconcile (J7)');
  assert.equal(v.funding, -0.25);
  assert.equal(v.closing, true);
  assert.equal(v.fillState, 'partial');
  assert.equal(v.feesEst, true);
  assert.equal(v.sizeRatio.k, 2.058);
  // total P&L includes funding (§6.11)
  assert.ok(Math.abs(v.usd - (1 + 2 - 0.25)) < 1e-9, `usd ${v.usd}`);
  assert.equal(inLang('en', () => PT.stateText(v)), 'closing on testnet…');
  assert.match(inLang('en', () => PT.dockLabel(v, '01')), /^TESTNET · /);
  // a paper bot is untouched (none mode is byte-identical)
  const paper = V.plotView({ ...bot, venue: undefined, exchange: undefined, closing: false, exchange_sync: null }, 0, { marks, nowMs: NOW });
  assert.equal(paper.venue, 'paper');
  assert.equal(paper.mark, 9999);
  assert.equal(paper.closing, false);
});

// ---------------------------------------------------------------- plant dialog testnet math (§9.4)

const QUOTE = { ok: true, reason: null, venue_ok: true, venue_reason: null, coin: 'ETH', sz_decimals: 4, leverage: 10, testnet_mid: 2380.5, testnet_mid_ms: NOW, mainnet_mid: 2500, divergence: 2380.5 / 2500 - 1, k: 1.05, target_sz: 0.42, notional_usd: 1000, margin_usd: 100, liq_move_pct: 0.095, fees_est_usd: 0.9, slippage_max_usd: 10, flatten_slippage_max_usd: 50, book_ok: true, depth_usd: 3000, funding_1h: 0.00001, room_usd: 480, free_usd: 912.4, capital_usd: 100 };

test('plant dialog: the Testnet option is enabled by the stake-independent checks only; switching clamps the water', () => {
  const st = accState();
  assert.deepEqual(PD.tnVenueState(st, QUOTE), { ok: true, reason: null });
  // the same quote at another stake (stake-dependent refusal) never disables the option
  assert.deepEqual(PD.tnVenueState(st, { ...QUOTE, ok: false, reason: 'thin_book', book_ok: false }), { ok: true, reason: null });
  assert.deepEqual(PD.tnVenueState(st, { ...QUOTE, venue_ok: false, venue_reason: 'unlisted_testnet' }), { ok: false, reason: 'unlisted_testnet' });
  assert.equal(PD.tnVenueState(st, null).ok, null, 'asking: neither enabled nor refused');
  assert.equal(PD.tnVenueState({ ...st, mode: { auth: 'accounts', testnet: { enabled: false } } }, QUOTE).reason, 'testnet_disabled');
  const noLink = accState();
  noLink.testnet.status.link = null;
  noLink.venues.testnet.connected = false;
  assert.equal(PD.tnVenueState(noLink, QUOTE).reason, 'not_connected');
  const kill = accState();
  kill.testnet.market.kill_switch = { on: true };
  assert.equal(PD.tnVenueState(kill, QUOTE).reason, 'kill_switch');
  // water max = min(500, room, 0.9 × free collateral), on the 10 $ step
  assert.equal(PD.tnStakeMax(QUOTE), 480);
  assert.equal(PD.tnStakeMax({ ...QUOTE, room_usd: 2000, free_usd: 300 }), 270);
  assert.equal(PD.tnStakeMax({ ...QUOTE, room_usd: 2000, free_usd: 5000 }), 500);
  assert.equal(PD.tnStakeMax({ ...QUOTE, room_usd: 2000, free_usd: 5000 }, { max_bot_capital_usd: 200 }), 200);
  assert.equal(PD.clampTnStake(1000, QUOTE), 480);
  assert.equal(PD.clampTnStake(100, QUOTE), 100);
  assert.equal(PD.clampTnStake(5, { ...QUOTE, free_usd: 10 }), 20, 'never below the minimum water');
});

test('plant dialog: divergence thresholds, reason texts, slippage and the ≈ scaling between quotes', () => {
  assert.equal(PD.divergenceLevel(0.03), 'none');
  assert.equal(PD.divergenceLevel(0.031), 'warn');
  assert.equal(PD.divergenceLevel(-0.2), 'warn');
  assert.equal(PD.divergenceLevel(-0.21), 'ack');
  assert.equal(PD.divergenceLevel(null), 'none');
  for (const lang of ['en', 'th']) {
    inLang(lang, () => {
      for (const r of [...CODES.VENUE_REASONS, ...CODES.STAKE_REASONS]) {
        const s = PD.tnReasonText(r, QUOTE, 'ETH');
        assert.ok(s && !s.startsWith('g.'), `${lang} ${r}: ${s}`);
      }
    });
  }
  assert.match(inLang('en', () => PD.tnReasonText('thin_book', QUOTE)), /ETH is too thin .*\$3,000/);
  assert.match(inLang('en', () => PD.tnReasonText('insufficient_testnet_balance', QUOTE)), /\$912\.40/);
  const sc = PD.scaleQuote(QUOTE, 200);
  assert.equal(sc.est, true);
  assert.equal(sc.notional, 2000);
  assert.equal(sc.slip, 20, 'IOC within 1 %: 1 % of the notional');
  assert.equal(PD.scaleQuote(QUOTE, 100).est, false, 'at the quoted stake: the server numbers');
  assert.match(inLang('en', () => I.t('g.plant.tnSlip', { usd: '$10.00' })), /≈ \$10\.00/);
  assert.equal(PD.QUOTE_MIN_MS, 300);
});

// ---------------------------------------------------------------- gate + key validation (§9.1, §9.3)

test('gate: client checks (username, length, contains-username, repeat) and the canonical username', () => {
  assert.equal(GT.canonUsername('  Nok_Somchai '), 'nok_somchai');
  assert.equal(GT.validateGate('signin', { username: 'x', password: 'y' }), null, 'sign-in only needs both fields');
  assert.equal(GT.validateGate('signin', { username: '', password: 'y' }).field, 'username');
  assert.equal(GT.validateGate('signup', { username: 'ab', password: 'abcdefghijk', password2: 'abcdefghijk' }).key, 'g.gate.usernameHint');
  assert.equal(GT.validateGate('signup', { username: 'nok', password: 'short', password2: 'short' }).key, 'g.gate.reasonTooShort');
  assert.equal(GT.validateGate('signup', { username: 'nok', password: 'nok-is-my-pass', password2: 'nok-is-my-pass' }).key, 'g.gate.reasonContains');
  assert.equal(GT.validateGate('signup', { username: 'nok', password: 'abcdefghijk', password2: 'abcdefghijx' }).key, 'g.gate.mismatch');
  assert.equal(GT.validateGate('signup', { username: 'nok', password: 'abcdefghijk', password2: 'abcdefghijk' }), null);
  assert.equal(GT.validateGate('reset', { username: 'nok', code: '', password: 'abcdefghijk', password2: 'abcdefghijk' }).field, 'code');
});

test('testnet key: a seed phrase is refused before anything is sent; hex format; 0x address', () => {
  const addr = '0x' + 'ab'.repeat(20);
  const seed12 = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  assert.equal(TN.checkKeyInput(addr, seed12).key, 'g.tn.err.seed');
  assert.equal(TN.checkKeyInput('', seed12).key, 'g.tn.err.seed', 'the seed check comes first');
  assert.equal(TN.checkKeyInput(addr, [...Array(24)].map(() => 'Word').join(' ')).key, 'g.tn.err.seed');
  assert.equal(TN.checkKeyInput(addr, 'a'.repeat(63)).key, 'g.tn.err.format');
  assert.equal(TN.checkKeyInput('0x123', 'a'.repeat(64)).key, 'g.err.bad_address');
  assert.equal(TN.checkKeyInput(addr, 'A'.repeat(64)), null);
  assert.equal(TN.checkKeyInput(addr, '0x' + 'f'.repeat(64)), null);
  assert.equal(TN.shortAddr('0x1234567890abcdef1234567890abcdef12345678'), '0x1234…5678');
});

test('testnet key field is not a password field, not in a form, and ignored by password managers (QA-20, source scan)', () => {
  const src = read('web/js/game/ui/testnet.js');
  const keyBlock = src.slice(src.indexOf('const key = h('), src.indexOf('const keyEye'));
  assert.match(keyBlock, /type: 'text'/);
  for (const a of ["autocomplete: 'off'", "autocapitalize: 'off'", "autocorrect: 'off'", "spellcheck: 'false'", "'data-1p-ignore'", "'data-lpignore': 'true'", "'data-bwignore'"]) assert.ok(keyBlock.includes(a), a);
  assert.doesNotMatch(src, /h\('form'/, 'no <form> in the testnet panel');
  assert.doesNotMatch(src, /type: 'password'/);
  assert.match(read('web/css/game.css'), /\.tn-key\.is-masked \{\s*-webkit-text-security: disc;/);
  // the gate's form posts nowhere: no action attribute, method post (a script failure never puts a password in a URL)
  const gate = read('web/js/game/ui/gate.js');
  assert.match(gate, /h\('form', \{ class: 'gate-form', id: 'gateForm', method: 'post'/);
  assert.doesNotMatch(gate, /action: '/, 'no action attribute on the gate form');
  assert.match(gate, /autocomplete: 'username'/);
  assert.match(gate, /'current-password'/);
  assert.match(gate, /'new-password'/);
});

// ---------------------------------------------------------------- routing, copy, ledgers, QA-04

test('QA-02 / QA-13: spectator landmark routing; players keep today\'s routing', () => {
  const spec = accState({ user: null });
  for (const id of ['barn', 'pond', 'tower', 'silo', 'crates', 'compost']) assert.deepEqual(DR.routeLandmark(id, spec), { kind: 'signIn', place: id });
  assert.deepEqual(DR.routeLandmark('signpost', spec), { kind: 'gate' });
  assert.deepEqual(DR.routeLandmark('firepit', spec), { kind: 'gate' });
  assert.deepEqual(DR.routeLandmark('mailbox', spec), { kind: 'panel', panel: 'diary' });
  assert.deepEqual(DR.routeLandmark('stall', spec), { kind: 'panel', panel: 'shelf' });
  const pl = accState();
  assert.deepEqual(DR.routeLandmark('barn', pl), { kind: 'money' });
  assert.deepEqual(DR.routeLandmark('signpost', pl), { kind: 'mode' });
  assert.deepEqual(DR.routeLandmark('firepit', pl), { kind: 'burn' });
  assert.deepEqual(DR.routeLandmark('board', {}), { kind: 'panel', panel: 'board' });
  for (const lang of ['en', 'th']) for (const id of DR.MONEY_LANDMARKS) assert.ok(I.STRINGS[lang]['g.place.' + id], `${lang} g.place.${id}`);
  // a spectator cannot plant: the reason is "sign in to plant"
  assert.equal(DR.plantBlock(spec, { id: 1, coin: 'BTC' }, 100).key, 'g.gate.signInToPlant');
});

test('QA-19: accounts-mode copy never says "restart" / "รีสตาร์ท" and never mentions a command token', () => {
  // the clock: net.skewMs makes the server-relative now equal NOW
  const st = accState({ live: { halted: true, halted_ms: NOW - 10_000, rearm_after_ms: NOW + 50_000 }, net: { ok: true, skewMs: NOW - Date.now() } });
  const bad = /restart|รีสตาร์ท|token|โทเค็น|🔑/i;
  for (const key of Object.keys(DR.ACCOUNTS_COPY)) {
    const k = DR.copyKey(st, key);
    for (const lang of ['en', 'th']) assert.doesNotMatch(I.STRINGS[lang][k], bad, `${lang} ${key} → ${k}`);
  }
  assert.equal(DR.copyKey(st, 'g.mode.realBody'), 'g.mode.realBodyTestnet', 'connected: the testnet variant');
  assert.equal(DR.copyKey({}, 'plot.emptyHalted'), 'plot.emptyHalted', 'none mode keeps today\'s string');
  assert.ok(/re-arm/.test(I.t(DR.copyKey(st, 'modal.halted'), DR.copyVars(st, 'modal.halted'))));
  assert.match(DR.copyVars(st, 'modal.halted').time, /^0:5\d$/);
  // the plant block of a burned accounts garden is the re-arm copy
  assert.doesNotMatch(I.t(DR.plantBlock(st, { id: 1, coin: 'BTC' }, 100).key), bad);
  // the strings the spec mandates about the server's own state ("restarting…") are information, not instructions
  // to the player; they are the only two exceptions and are never a variant of a halted / token message
  const allowed = new Set(['g.err.restarting', 'g.err.server_restarting', 'g.faq.serverDown', 'g.mode.realBack', 'err.auth', 'err.authRemote']);
  for (const k of Object.keys(I.STRINGS.en)) {
    if (!/^(g\.(gate|acct|tn|plant\.tn|err|note|diary|faq|insp|lm|rearm|hud|venue|badge))\./.test(k) || allowed.has(k)) continue;
    if (k.startsWith('g.badge.') && !/testnet|kill|paperTestnet/i.test(k)) continue;
    assert.doesNotMatch(I.STRINGS.en[k], /restart the server|server restarts/i, k);
  }
  // rearm state: 60 s after the burn
  assert.equal(DR.rearmState(st, NOW).can, false);
  assert.equal(DR.rearmState(st, NOW + 60_000).can, true);
});

test('ledgers: the barn popover shows both; the testnet column has no "vs start", only "since you connected"', () => {
  const lm = HU.ledgersModel(accState());
  assert.ok(lm.testnet);
  assert.equal(lm.testnet.value, 1003.7);
  assert.equal(lm.testnet.est, true);
  assert.ok(Math.abs(lm.testnet.sinceConnect.delta - 3.7) < 1e-9);
  assert.ok(!('vsStartPct' in lm.testnet), 'no vs-start for testnet');
  assert.equal(HU.ledgersModel({}).testnet, null, 'none mode: one ledger as today');
  assert.match(I.STRINGS.en['g.lm.barnTestnet'], /since you connected on \{date\}/);
});

test('QA-04: after a close the inspector is the empty-plot card with the coin and the signed result — never blank, never "Plot —"', () => {
  const gain = inLang('en', () => IN.afterCard({ coin: 'SOL', realized: 3.1, confirmed: true, venue: 'paper' }, '04'));
  assert.equal(gain.key, 'g.insp.emptyAfter');
  assert.equal(I.t(gain.key, gain.vars), 'Plot 04 is empty. Last crop: SOL harvested +$3.10 ▲.');
  assert.equal(gain.tone, 'up');
  const loss = inLang('en', () => IN.afterCard({ coin: 'BTC', realized: -8.2, confirmed: true }, '02'));
  assert.equal(loss.tone, 'down');
  assert.match(I.t(loss.key, loss.vars), /BTC pulled −\$8\.20 ▼/);
  // (a) opened from the list / diary without a plot
  const nop = inLang('en', () => IN.afterCard({ coin: 'ETH', realized: 1 }, null));
  assert.equal(nop.key, 'g.insp.emptyAfterNoPlot');
  assert.doesNotMatch(I.t(nop.key, nop.vars), /Plot —/);
  // (c) an unconfirmed testnet close carries ≈ until bot_fill_confirmed
  const est = inLang('en', () => IN.afterCard({ coin: 'ETH', realized: -0.4, confirmed: false, venue: 'testnet' }, '01'));
  assert.match(I.t(est.key, est.vars), /≈ −\$0\.40/);
  // no last crop: the plain empty card (with Plant here); burned: the re-arm copy chosen by the caller
  assert.equal(IN.afterCard(null, '03').key, 'g.insp.empty');
  assert.equal(IN.afterCard(null, '03', { halted: true, haltedKey: 'plot.emptyHaltedRearm' }).key, 'plot.emptyHaltedRearm');
  for (const lang of ['en', 'th']) for (const k of ['g.insp.emptyAfter', 'g.insp.emptyAfterNoPlot', 'g.insp.resultHarvest', 'g.insp.resultPull', 'g.insp.plantHere']) assert.ok(I.STRINGS[lang][k], `${lang} ${k}`);
});

test('help: the FAQ answers every §9.2 question in EN and TH; the Places list names every landmark', () => {
  for (const [q, a] of HP.FAQ) for (const lang of ['en', 'th']) assert.ok(I.STRINGS[lang][q] && I.STRINGS[lang][a], `${lang} ${q}`);
  assert.match(I.STRINGS.en['g.faq.faucet'], /deposited on mainnet/);
  assert.match(I.STRINGS.en['g.tn.faucet'], /app\.hyperliquid-testnet\.xyz\/drip/);
  for (const id of HP.PLACES) assert.ok(I.STRINGS.th['g.place.' + id], `TH g.place.${id}`);
  // G opens the Places list (L stays the List view)
  assert.match(read('web/js/game/main.js'), /'\?': 'help', g: 'places'/);
  assert.match(read('web/js/game/ui/sheets.js'), /g: 'places'/);
});

test('index.html: the Sign in chip and the account button exist (hidden until accounts mode says so)', () => {
  const html = read('web/index.html');
  assert.match(html, /id="btnSignIn"[^>]*hidden/);
  assert.match(html, /id="btnAccount"[^>]*hidden/);
});

// ---------------------------------------------------------------- resumed-build additions (integration findings)

test('i18n: EN and TH have the same key set and the same placeholders for every key', () => {
  const en = Object.keys(I.STRINGS.en);
  const th = new Set(Object.keys(I.STRINGS.th));
  assert.equal(en.length, th.size);
  for (const k of en) {
    assert.ok(th.has(k), `TH has ${k}`);
    assert.equal(ph(I.STRINGS.th[k]), ph(I.STRINGS.en[k]), `placeholders of ${k}`);
  }
  // the keys added while integrating (wallet flow, dev panel, testnet liquidation wait, revoked head) are Thai in TH
  for (const k of ['g.tn.wallet', 'g.tn.walletHow', 'g.tn.walletCheck', 'g.tn.walletWorking', 'g.tn.walletUnavailable', 'g.tn.err.walletBad', 'g.tn.err.walletRejected', 'g.tn.err.walletFailed', 'g.tn.revokedHead', 'g.liq.tnWait', 'g.acct.devArgs', 'g.acct.devBadArgs', 'g.acct.devUse', 'g.acct.devKeyHidden']) {
    assert.ok(I.STRINGS.en[k], `EN ${k}`);
    assert.match(I.STRINGS.th[k], /[฀-๿]/, `TH ${k} is Thai`);
  }
});

test('time-lapse (tick) is an admin op in accounts mode: players and spectators never get the button or the sundial action', () => {
  const sim = { feed: { prices: 'sim' } };
  assert.equal(DR.canTimelapse(sim), true, 'none mode with simulated prices: as today');
  assert.equal(DR.canTimelapse({ feed: { prices: 'real' } }), false, 'real prices: never');
  const player = accState({ ...sim });
  assert.equal(DR.canTimelapse(player), false);
  assert.equal(DR.canTimelapse(accState({ ...sim, user: null })), false, 'spectator');
  assert.equal(DR.canTimelapse(accState({ ...sim, user: { id: 1, username: 'op', role: 'admin' } })), true, 'admin');
  assert.deepEqual(DR.routeLandmark('sundial', player), { kind: 'tip' });
  assert.deepEqual(DR.routeLandmark('sundial', sim), { kind: 'timelapse' });
  // the HUD and the More sheet use the same rule
  const hud = read('web/js/game/ui/hud.js');
  assert.match(hud, /const lapse = D\.canTimelapse\(s\);\s*for \(const id of \['btnTimelapse', 'moreTimelapse'\]\) show\(\$\(id\), lapse\);/);
});

test('inspector error box: localised by code, the server text only as a detail; accounts mode never shows it as the line', () => {
  const tn = { venue: 'testnet', coin: 'ETH', error: 'the testnet book could not fill the order right now', sync: { op: 'flatten', state: 'failed', code: 'ioc_no_match' } };
  for (const lang of ['en', 'th']) {
    const info = inLang(lang, () => IN.botErrorInfo(tn, { accounts: true }));
    assert.equal(info.detail, tn.error);
    assert.doesNotMatch(info.text, /could not fill/);
    assert.doesNotMatch(info.text, /\.\./, 'no double full stop');
    if (lang === 'th') assert.match(info.text, /[฀-๿]/);
  }
  assert.match(inLang('en', () => IN.botErrorInfo(tn, { accounts: true })).text, /^Testnet order failed: No match on the testnet book/);
  // a paper error: the code of the newest live_error with the same text; missing variables read "—", never "{x}"
  const paper = { venue: 'paper', coin: 'BTC', error: 'notional cap: $5,100.00 would exceed $5000' };
  const caps = inLang('en', () => IN.botErrorInfo(paper, { accounts: true, lastEvent: { code: 'caps', error: paper.error } }));
  assert.match(caps.text, /over your garden's limits \(—\)/);
  assert.equal(caps.detail, paper.error);
  // the catch-all `conflict`, an unknown code or no event: the generic line (accounts) / today's raw text (none mode)
  assert.equal(inLang('th', () => IN.botErrorInfo(paper, { accounts: true, lastEvent: { code: 'conflict', error: paper.error } })).text, I.STRINGS.th['g.err.unknown']);
  assert.equal(inLang('th', () => IN.botErrorInfo(paper, { accounts: true })).text, I.STRINGS.th['g.err.unknown']);
  assert.deepEqual(IN.botErrorInfo(paper, {}), { text: paper.error, detail: '' }, 'none mode: as today');
  assert.equal(IN.botErrorInfo({ error: null }, { accounts: true }), null);
  assert.equal(IN.noDot('retrying.'), 'retrying');
});

test('notes: a pause note_code reads as the note ("paused by the operator (testnet)"), not the matching error text', () => {
  assert.equal(inLang('en', () => DY.noteText('kill_switch')), I.STRINGS.en['g.note.kill_switch']);
  assert.equal(inLang('en', () => DY.codeText('kill_switch')), I.STRINGS.en['g.err.kill_switch'], 'errors keep the error text');
  const line = inLang('en', () => DY.lineFor({ type: 'paused', bot: 'bot-1', note_code: 'kill_switch', venue: 'testnet' }));
  assert.match(line.text, /paused by the operator \(testnet\)/);
  for (const c of SC.note) for (const lang of ['en', 'th']) assert.ok(inLang(lang, () => DY.noteText(c, { coin: 'ETH', exch: '1', exp: '2', days: 14 })), `${lang} ${c}`);
});

test('testnet liquidation before the first reconcile reads "—, until the exchange reports it" (J7), never "no position"', () => {
  const held = { venue: 'testnet', side: 1, liqInfo: null };
  assert.equal(inLang('en', () => PT.liqText(held)), I.STRINGS.en['g.liq.tnWait']);
  assert.equal(inLang('en', () => PT.liqText({ venue: 'paper', side: 1, liqInfo: null })), I.STRINGS.en['g.liq.none'], 'paper: as today');
  assert.equal(inLang('en', () => PT.liqText({ venue: 'testnet', side: 0, liqInfo: null })), I.STRINGS.en['g.liq.none'], 'flat testnet bot');
});

test('P1 wallet approval (§6.10): the server values are checked first; the typed data is built from frozen constants (Testnet)', () => {
  const now = NOW;
  const good = { agent_address: '0x' + 'ab'.repeat(20), agent_name: `bean-garden valid_until ${now + 90 * 864e5}`, nonce: now };
  assert.equal(TN.checkPrepared(good, now), null);
  assert.equal(TN.checkPrepared({ ...good, agent_address: '0x' + 'AB'.repeat(20) }, now), 'agent_address', 'lower-case hex only');
  assert.equal(TN.checkPrepared({ ...good, agent_name: 'evil valid_until ' + (now + 864e5 * 9) }, now), 'agent_name');
  assert.equal(TN.checkPrepared({ ...good, agent_name: `bean-garden valid_until ${now + 200 * 864e5}` }, now), 'agent_name', '≤ 180 days');
  assert.equal(TN.checkPrepared({ ...good, agent_name: `bean-garden valid_until ${now + 3600e3}` }, now), 'agent_name', '≥ 1 day');
  assert.equal(TN.checkPrepared({ ...good, nonce: now - 6 * 60_000 }, now), 'nonce', 'within ±5 min');
  assert.equal(TN.checkPrepared(null, now), 'shape');
  const td = TN.approveTypedData({ chainId: 421614, agentAddress: good.agent_address, agentName: good.agent_name, nonce: good.nonce });
  assert.equal(td.primaryType, 'HyperliquidTransaction:ApproveAgent');
  assert.deepEqual(td.domain, { name: 'HyperliquidSignTransaction', version: '1', verifyingContract: '0x0000000000000000000000000000000000000000', chainId: 421614 });
  assert.equal(typeof td.domain.chainId, 'number', 'chainId is an integer in the domain');
  assert.equal(td.message.hyperliquidChain, 'Testnet');
  assert.deepEqual(td.types['HyperliquidTransaction:ApproveAgent'].map((f) => `${f.name}:${f.type}`), ['hyperliquidChain:string', 'agentAddress:address', 'agentName:string', 'nonce:uint64']);
  // a server value can never switch the chain: the literal lives in the client source only
  const src = read('web/js/game/ui/testnet.js');
  assert.match(src, /export const APPROVE_CHAIN = 'Testnet';/);
  assert.doesNotMatch(src, /hyperliquidChain: prep\./);
  assert.doesNotMatch(src, /['"]Mainnet['"]/);
});

test('dev panel: the fault list is the double\'s DEV_FAULTS (the --testnet-double QA-18 run)', async () => {
  const AC = await imp('web/js/game/ui/account.js');
  const dbl = await imp('test/fixtures/hl-testnet-double.js');
  assert.deepEqual([...AC.DEV_FAULTS], [...dbl.DEV_FAULTS]);
});

test('J3/J4 on testnet: the bot_close 2xx only starts the closing state; bot_closed plays the effect; an unconfirmed tiny result is neutral', async () => {
  const FX = await imp('web/js/game/fx/director.js');
  const R = await imp('web/js/game/core/rules.js');
  const views = { 0: { slot: 0, botId: 'bot-0001', coin: 'ETH', fees: 0.4, venue: 'testnet', state: 'growing' } };
  // the 2xx of bot_close on a testnet bot (still open, closing): no harvest / pull yet
  const done = FX.direct(views, views, { type: 'cmd', phase: 'done', op: 'bot_close', ok: true, slot: 0, bot: 'bot-0001', body: { id: 'bot-0001', venue: 'testnet', state: 'active', closing: true, realized_pnl: 5 } }, {});
  assert.ok(!done.some((e) => e.kind === 'harvest' || e.kind === 'pull'), 'no effect on the provisional 2xx');
  // a paper close keeps today's behaviour (the 2xx plays it)
  const paper = FX.direct(views, views, { type: 'cmd', phase: 'done', op: 'bot_close', ok: true, slot: 0, bot: 'bot-0001', body: { id: 'bot-0001', state: 'closed', realized_pnl: 2 } }, {});
  assert.ok(paper.some((e) => e.kind === 'harvest'));
  // bot_closed confirmed: the effect, with funding in the result
  const conf = FX.direct(views, {}, { type: 'closed', slot: 0, bot: 'bot-0001', coin: 'ETH', venue: 'testnet', realized_pnl: -3, funding: -0.5, confirmed: true }, {});
  assert.equal(conf[0].kind, 'pull');
  assert.equal(conf[0].usd, -3.5);
  // unconfirmed and within 2 × the estimated fees: neutral (a basket, no coins, no pull)
  const tiny = FX.direct(views, {}, { type: 'closed', slot: 0, bot: 'bot-0001', coin: 'ETH', venue: 'testnet', realized_pnl: -0.6, funding: 0, confirmed: false }, {});
  assert.deepEqual([tiny[0].kind, tiny[0].usd, tiny[0].n, tiny[0].tone], ['harvest', 0, 0, 'neutral']);
  // unconfirmed but clearly a loss: a pull marked as an estimate
  const big = FX.direct(views, {}, { type: 'closed', slot: 0, bot: 'bot-0001', coin: 'ETH', venue: 'testnet', realized_pnl: -9, confirmed: false }, {});
  assert.equal(big[0].kind, 'pull');
  assert.equal(big[0].meta.est, true);
  for (const e of [...conf, ...tiny, ...big]) R.assertEffect(e);
  // QA-14: a failed exchange sync puffs dust on the plot (the refused-command look), once per failure
  const fail = FX.direct(views, views, { type: 'sync', slot: 0, bot: 'bot-0001', coin: 'ETH', op: 'mirror', state: 'failed', code: 'ioc_no_match', attempts: 1 }, {});
  assert.deepEqual(fail.map((e) => [e.kind, e.meta.on, e.meta.ok]), [['pending', false, false]]);
  assert.deepEqual(FX.direct(views, views, { type: 'sync', slot: 0, bot: 'bot-0001', state: 'pending' }, {}), []);
  assert.deepEqual(FX.direct(views, views, { type: 'sync', slot: 0, bot: 'bot-0001', state: 'failed', replay: true }, {}), [], 'replays never animate');
  // a testnet liquidation plays the paper liquidation visuals
  const liq = FX.direct({ 0: { ...views[0], margin: 12 } }, views, { type: 'paused', slot: 0, bot: 'bot-0001', coin: 'ETH', venue: 'testnet', reason: 'liquidated on testnet', note_code: 'liquidated_testnet' }, {});
  assert.equal(liq[0].kind, 'liquidate');
  R.assertEffect(liq[0]);
});

test('P1 ledger toggle: the testnet ledger exists only when connected (or holding testnet bots); paper otherwise; no vs-start', () => {
  const st = accState({ settings: { ledger: 'testnet' }, bots: [{ id: 'bot-0002', coin: 'ETH', venue: 'testnet', state: 'active', capital_usd: 120 }] });
  assert.equal(DR.tnLedgerAvailable(st), true);
  assert.equal(DR.activeLedger(st), 'testnet');
  const m = DR.tnMoneyView(st);
  assert.equal(m.barn, 1003.7);
  assert.equal(m.barnEst, true, 'a unified value we computed carries ≈');
  assert.equal(m.pond, 912.4);
  assert.equal(m.tower, 120);
  assert.equal(m.vsStartPct, null, 'the testnet ledger has no start (J5)');
  assert.equal(DR.activeLedger(accState({ settings: { ledger: 'paper' } })), 'paper');
  const off = accState({ settings: { ledger: 'testnet' } });
  off.testnet.status.link = null;
  off.venues.testnet.connected = false;
  assert.equal(DR.activeLedger(off), 'paper', 'not connected, no testnet bot: paper even if chosen');
  assert.equal(DR.activeLedger({ settings: { ledger: 'testnet' } }), 'paper', 'none mode');
});

test('API-wallet expiry: amber within 7 days, red within 1 day; the server\'s own warn wins (§9.3, U5)', () => {
  const at = (days, warn = null) => {
    const st = accState();
    st.testnet.status.expiry = { valid_until_ms: NOW + days * 864e5, warn };
    st.testnet.status.link.valid_until_ms = NOW + days * 864e5;
    return DR.tnExpiry(st, NOW);
  };
  assert.equal(at(30).warn, null);
  assert.equal(at(6).warn, '7d');
  assert.equal(at(0.5).warn, '1d');
  assert.equal(at(30, '7d').warn, '7d', 'the server decides when it says so');
  assert.match(inLang('en', () => I.t('g.tn.expiring', { date: '1 Nov' })), /Replace API wallet/);
});

test('long waits read in hours, short ones as a countdown; the classic page uses the accounts-mode burned-field copy', () => {
  assert.equal(U.longWait(42_000), '0:42');
  assert.equal(inLang('en', () => U.longWait(86_399_000)), inLang('en', () => U.waitText(86_399)));
  const classic = read('web/js/garden.js');
  assert.doesNotMatch(classic, /t\('(plot\.emptyHalted|modal\.halted|shelf\.noteHalted|ask\.burn)'/, 'every burned-field string goes through ck()');
  assert.match(classic, /'plot\.emptyHalted': 'plot\.emptyHaltedRearm'/);
});

// ---------------------------------------------------------------- 3D: QA-01, QA-05, QA-06, QA-07 (headless three)

const THREE_URL = pathToFileURL(fileURLToPath(new URL('node_modules/three/build/three.module.js', ROOT))).href;
let hooked = false;
if (typeof module.registerHooks === 'function') {
  module.registerHooks({
    resolve(spec, ctx, next) {
      if (ctx.parentURL && ctx.parentURL.includes('/web/js/game/') && /(^|\/)three\.js$/.test(spec)) return { url: THREE_URL, shortCircuit: true };
      return next(spec, ctx);
    },
  });
  hooked = true;
}
const needsThree = hooked ? {} : { skip: 'module.registerHooks is not available in this Node version' };

/** HUD insets measured in the browser (top HUD, bottom bar) at the three QA viewports. */
const VIEWPORTS = [
  { W: 1280, H: 800, safe: { top: 123, bottom: 218 } },
  { W: 1920, H: 1080, safe: { top: 123, bottom: 218 } },
  { W: 390, H: 844, safe: { top: 124, bottom: 200 } },
];

async function rigFor(THREE, { W, H, safe }) {
  const camera = new THREE.PerspectiveCamera(30, W / H, 0.5, 300);
  const rig = CAM.createRig(camera, { clientWidth: W, clientHeight: H }, { now: () => 0, portrait: W / H < CAM.RIG.portraitAspect });
  rig.resize(W, H);
  rig.setAutoSafeArea(safe);
  camera.updateMatrixWorld(true);
  return { camera, rig };
}

test('QA-01: every landmark is pickable at its anchor in the default framing, and a ≥ 44 × 44 px tap target at 390 × 844', needsThree, async () => {
  const THREE = await import(THREE_URL);
  const LM = await imp('web/js/game/world/landmarks.js');
  const built = LM.buildLandmarks({ count: 10 });
  const scene = new THREE.Scene();
  for (const l of built.list) scene.add(l.object3D);
  scene.updateMatrixWorld(true);
  const proxies = built.list.map((l) => l.proxy);
  const idOf = (obj) => built.list.find((l) => l.proxy === obj)?.id ?? null;
  const ids = ['stall', 'barn', 'mailbox', 'signpost', 'board', 'firepit', 'pip', 'windmill', 'tower', 'pond', 'silo', 'crates', 'compost', 'sundial'];
  for (const id of ids) assert.ok(LM.PICK_PROXIES[id], `pick proxy for ${id}`);
  for (const vp of VIEWPORTS) {
    const { camera } = await rigFor(THREE, vp);
    const ray = new THREE.Raycaster();
    ray.layers.set(1);
    for (const id of ids) {
      const l = built.list.find((x) => x.id === id);
      const p = new THREE.Vector3();
      l.anchor.getWorldPosition(p);
      const v = p.clone().project(camera);
      assert.ok(Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1, `${vp.W}×${vp.H}: ${id} anchor on screen`);
      ray.setFromCamera(new THREE.Vector2(v.x, v.y), camera);
      assert.equal(idOf(ray.intersectObjects(proxies, false)[0]?.object), id, `${vp.W}×${vp.H}: pickAt(project(anchor)) → ${id}`);
    }
    if (vp.W !== 390) continue;
    // phone: each proxy's on-screen box, clipped to the screen and the HUD insets, is ≥ 44 × 44 and picks itself
    for (const id of ids) {
      const l = built.list.find((x) => x.id === id);
      const box = new THREE.Box3().setFromObject(l.proxy);
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const s = new THREE.Vector3(x, y, z).project(camera);
        const sx = ((s.x + 1) / 2) * vp.W;
        const sy = ((1 - s.y) / 2) * vp.H;
        x0 = Math.min(x0, sx);
        x1 = Math.max(x1, sx);
        y0 = Math.min(y0, sy);
        y1 = Math.max(y1, sy);
      }
      const cx0 = Math.max(0, x0);
      const cx1 = Math.min(vp.W, x1);
      const cy0 = Math.max(vp.safe.top, y0);
      const cy1 = Math.min(vp.H - vp.safe.bottom, y1);
      assert.ok(cx1 - cx0 >= 44 && cy1 - cy0 >= 44, `${id}: visible tap target ${Math.round(cx1 - cx0)}×${Math.round(cy1 - cy0)} px ≥ 44×44`);
      const px = (cx0 + cx1) / 2;
      const py = (cy0 + cy1) / 2;
      ray.setFromCamera(new THREE.Vector2((px / vp.W) * 2 - 1, -((py / vp.H) * 2 - 1)), camera);
      assert.equal(idOf(ray.intersectObjects(proxies, false)[0]?.object), id, `${id}: the centre of its visible box picks it`);
    }
  }
  built.dispose?.();
});

test('QA-01 desktop: each landmark has a self-picking ≥ 44 × 44 px region inside the HUD-free area, and its label anchor is in it', needsThree, async () => {
  // HUD insets measured in the browser at 1280 × 800 (2026-10-12): the HUD row ends at 50 px, the dock + toolbar take
  // 218 px; a spectator also has the farm gate's sign on the left (372 px). Raycasting only at the anchor (above)
  // missed a landmark hidden by the DOM HUD or by the proxy in front of it (the silo behind the compost heap, the
  // signpost under the dock), so here every landmark must own a 44 × 44 px block of tappable screen.
  const THREE = await import(THREE_URL);
  const LM = await imp('web/js/game/world/landmarks.js');
  const built = LM.buildLandmarks({ count: 10 });
  const scene = new THREE.Scene();
  for (const l of built.list) scene.add(l.object3D);
  scene.updateMatrixWorld(true);
  const proxies = built.list.map((l) => l.proxy);
  const idOf = (obj) => built.list.find((l) => l.proxy === obj)?.id ?? null;
  const ids = ['stall', 'barn', 'mailbox', 'signpost', 'board', 'firepit', 'pip', 'windmill', 'tower', 'pond', 'silo', 'crates', 'compost'];
  const STEP = 4;
  for (const vp of [{ W: 1280, H: 800, safe: { top: 50, bottom: 218 } }, { W: 1280, H: 800, safe: { top: 50, bottom: 218, left: 372 } }, { W: 1920, H: 1080, safe: { top: 50, bottom: 218 } }]) {
    const { camera } = await rigFor(THREE, vp);
    const ray = new THREE.Raycaster();
    ray.layers.set(1);
    const x0 = vp.safe.left ?? 0;
    const cols = Math.floor((vp.W - x0) / STEP);
    const rows = Math.floor((vp.H - vp.safe.top - vp.safe.bottom) / STEP);
    // one pick map of the HUD-free area
    const map = [];
    for (let j = 0; j < rows; j++) {
      const row = [];
      for (let i = 0; i < cols; i++) {
        const px = x0 + (i + 0.5) * STEP;
        const py = vp.safe.top + (j + 0.5) * STEP;
        ray.setFromCamera(new THREE.Vector2((px / vp.W) * 2 - 1, -((py / vp.H) * 2 - 1)), camera);
        row.push(idOf(ray.intersectObjects(proxies, false)[0]?.object));
      }
      map.push(row);
    }
    const need = Math.ceil(44 / STEP);
    for (const id of ids) {
      // a need × need block of cells that all pick `id` (2D prefix sums)
      const S = Array.from({ length: rows + 1 }, () => new Int32Array(cols + 1));
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) S[j + 1][i + 1] = S[j][i + 1] + S[j + 1][i] - S[j][i] + (map[j][i] === id ? 1 : 0);
      let found = false;
      for (let j = need; j <= rows && !found; j++) for (let i = need; i <= cols && !found; i++) {
        if (S[j][i] - S[j - need][i] - S[j][i - need] + S[j - need][i - need] === need * need) found = true;
      }
      assert.ok(found, `${vp.W}×${vp.H} ${JSON.stringify(vp.safe)}: ${id} owns a 44×44 px tappable block`);
      // its DOM label sits in the visible area, not under the HUD (the silo's fill label once hid under the pills)
      const a = new THREE.Vector3();
      built.list.find((x) => x.id === id).anchor.getWorldPosition(a);
      const v = a.project(camera);
      const ay = ((1 - v.y) / 2) * vp.H;
      const ax = ((v.x + 1) / 2) * vp.W;
      if (id !== 'signpost') {
        // (the signpost's label is the mode badge's twin and may sit at the dock edge; its block above is checked)
        assert.ok(ay >= vp.safe.top && ay <= vp.H - vp.safe.bottom && ax >= x0, `${vp.W}×${vp.H}: ${id} label anchor (${Math.round(ax)}, ${Math.round(ay)}) is in the HUD-free area`);
      }
    }
  }
  built.dispose?.();
});

test('QA-06: default framing — the §2.5 list inside the HUD-free area (desktop, with the gate sign too); the phone shows every landmark', () => {
  // desktop: the whole DEFAULT_FRAME list, with the HUD, and with the farm gate's wooden sign on the left
  for (const { W, H, safe } of VIEWPORTS.slice(0, 2)) {
    for (const s of [safe, { ...safe, top: 50, left: 372 }]) {
      const st = CAM.defaultState('landscape', W / H, { W, H, safe: s });
      assert.ok(CAM.framesPoints(st.d, { W, H, safe: s }), `${W}×${H} ${JSON.stringify(s)}: d ${st.d}`);
    }
  }
  // phone (portrait lens: fov 42°, d ≤ 90 are frozen by the camera tests): the farm-wide fit shows the centres of
  // the field, barn, tower, mailbox and fire pit inside the safe area — also above the gate's bottom sheet (52 %)
  const centres = { field: [[-10.6, 0, -4.6], [10.6, 0, -4.6], [-10.6, 0, 4.6], [10.6, 0, 4.6]], barn: [[0, 1.5, -12]], tower: [[13, 2, -8]], firepit: [[8, 0, 11.5]], mailbox: [[-7, 0, 11.2]] };
  const port = CAM.defaultState('portrait', 390 / 844);
  assert.equal(port.d, CAM.RIG.portrait.dMax, 'the phone view fits the farm (up to the lens limit)');
  for (const safe of [{ top: 124, bottom: 200 }, { top: 82, bottom: Math.round(844 * 0.52) }]) {
    for (const [name, pts] of Object.entries(centres)) assert.ok(CAM.framesPoints(port.d, { lens: 'portrait', W: 390, H: 844, safe, points: pts }), `390×844 ${JSON.stringify(safe)}: ${name}`);
  }
});

test('QA-05: ripe fruit silhouettes differ within each shared builder (IoU < 0.8) and stay ≥ 6 px on screen', needsThree, async () => {
  const THREE = await import(THREE_URL);
  const B = await imp('web/js/game/crops/builders.js');
  const C = await imp('web/js/game/crops/catalog.js');
  const N = 32;
  const pitch = (CAM.RIG.defaultPitch * Math.PI) / 180;
  const proj = (v) => [v.x, Math.cos(pitch) * v.y - Math.sin(pitch) * v.z]; // default camera, yaw 0
  function silhouette(geo, q, s) {
    const pos = geo.attributes.position;
    const idx = geo.index ? geo.index.array : null;
    const v = new THREE.Vector3();
    const pts = [];
    for (let i = 0; i < pos.count; i++) pts.push(proj(v.fromBufferAttribute(pos, i).applyQuaternion(q).multiplyScalar(s)));
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    const span = Math.max(x1 - x0, y1 - y0) || 1;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const g = ([x, y]) => [((x - cx) / span + 0.5) * (N - 1), ((y - cy) / span + 0.5) * (N - 1)];
    const mask = new Uint8Array(N * N);
    const n = idx ? idx.length : pos.count;
    for (let i = 0; i < n; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => g(pts[idx ? idx[i + k] : i + k]));
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))); y <= Math.min(N - 1, Math.ceil(Math.max(a[1], b[1], c[1]))); y++) {
        for (let x = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))); x <= Math.min(N - 1, Math.ceil(Math.max(a[0], b[0], c[0]))); x++) {
          const w0 = ((b[0] - x) * (c[1] - y) - (b[1] - y) * (c[0] - x)) / area;
          const w1 = ((c[0] - x) * (a[1] - y) - (c[1] - y) * (a[0] - x)) / area;
          if (w0 >= -0.02 && w1 >= -0.02 && 1 - w0 - w1 >= -0.02) mask[y * N + x] = 1;
        }
      }
    }
    return { mask, extent: span };
  }
  const iou = (a, b) => {
    let i = 0;
    let u = 0;
    for (let k = 0; k < a.length; k++) {
      if (a[k] && b[k]) i++;
      if (a[k] || b[k]) u++;
    }
    return u ? i / u : 0;
  };
  const views = [
    { W: 390, H: 844, lens: 'portrait', st: CAM.defaultState('portrait', 390 / 844) },
    { W: 1280, H: 800, lens: 'landscape', st: CAM.defaultState('landscape', 1280 / 800, { W: 1280, H: 800, safe: VIEWPORTS[0].safe }) },
  ];
  for (const tier of ['high', 'medium']) {
    const res = {};
    for (const coin of B.cropCoins()) {
      const P = B.buildParts(coin, { tier });
      const a = P.fruitAnchors[0];
      const sil = silhouette(P.fruitGeo, a.q, a.s);
      if (!P.stemLeaves.boundingBox) P.stemLeaves.computeBoundingBox();
      const bb = P.stemLeaves.boundingBox;
      const gain = Math.min(Math.max(2.4 / Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z), 1), 1.7);
      // a ripe size-1 crop: fruit scale a.s × comp × drawn = a.s × √gain (comp = 1/√drawn)
      res[coin] = { mask: sil.mask, world: sil.extent * Math.sqrt(gain), base: P.fruitSpan * a.s * Math.sqrt(gain) };
      for (const g of [P.stemLeaves, P.fruitGeo, P.flowerGeo, P.sprout]) g.dispose();
    }
    const groups = {};
    for (const coin of B.cropCoins()) (groups[C.cropFor(coin).builder] ||= []).push(coin);
    for (const [builder, coins] of Object.entries(groups)) {
      for (let i = 0; i < coins.length; i++) for (let j = i + 1; j < coins.length; j++) {
        const v = iou(res[coins[i]].mask, res[coins[j]].mask);
        assert.ok(v < 0.8, `${tier} ${builder}: ${coins[i]} vs ${coins[j]} IoU ${v.toFixed(2)}`);
      }
    }
    for (const { W, H, lens, st } of views) {
      const pxPerU = H / 2 / (Math.tan((CAM.RIG[lens].fov * Math.PI) / 360) * st.d);
      for (const coin of B.cropCoins()) {
        const px = res[coin].world * pxPerU * B.fruitBoost(res[coin].base, B.FRUIT_MIN_PX / pxPerU);
        assert.ok(px >= 6, `${tier} ${W}×${H}: ${coin} ripe fruit ${px.toFixed(1)} px ≥ 6`);
      }
    }
  }
  // the boost is 1 close up (art unchanged) and bounded far away
  assert.equal(B.fruitBoost(1, 0.2), 1);
  assert.equal(B.fruitBoost(0.01, 10), B.FRUIT_BOOST_MAX);
  // Low tier: fruit gets an outline (an inverted hull)
  const low = B.buildCrop('SOL', { tier: 'low', seed: 1 });
  assert.ok(low.group.children.some((o) => o.name === 'fruitRim'), 'Low-tier fruit outline');
  const high = B.buildCrop('SOL', { tier: 'high', seed: 1 });
  assert.ok(!high.group.children.some((o) => o.name === 'fruitRim'), 'no outline above Low');
  low.dispose();
  high.dispose();
  B.clearCropCache();
});

test('QA-07: ten fully grown crops stay within the triangle budgets (Low 80k, Medium 150k, High 250k)', needsThree, async () => {
  const THREE = await import(THREE_URL);
  globalThis.requestAnimationFrame ??= (f) => setTimeout(f, 16);
  const W = await imp('web/js/game/world/world.js');
  const F = await imp('web/js/game/field/field.js');
  const TI = await imp('web/js/game/gfx/tiers.js');
  const B = await imp('web/js/game/crops/builders.js');
  const tris = (g) => (g.index ? g.index.count : g.attributes.position?.count || 0) / 3;
  const BUDGET = { low: 80_000, medium: 150_000, high: 250_000 };
  // the heaviest crops (grapes, pumpkin, blueberries…) — the worst case of "10 fully grown crops"
  const coins = ['VVV', 'PUMP', 'ARB', 'XRP', 'LINK', 'TIA', 'DOGE', 'SUI', 'WIF', 'NEAR'];
  for (const tier of ['low', 'medium', 'high']) {
    const scene = new THREE.Scene();
    const quality = { ...TI.TIERS[tier], tier };
    const world = W.buildWorld({ scene, tier, quality });
    const field = F.createField({ scene, world, tier: quality, quality });
    const views = {};
    coins.forEach((coin, i) => {
      views[i] = { slot: i, botId: 'b' + i, beanId: i, coin, crop: coin, state: 'growing', phase: 'growing', side: 1, lev: 5, size: 1, health: 1, fruit: 6, flower: true, seed: false, caption: 'ripe', ripe: true, frac: 0.2, usd: 20, pct: 20, szi: 1, entry: 1, mark: 1.2, liqInfo: { d: 1, band: 'ok', movePct: 0.5, dir: 'fall' }, water: 100, realized: 0, unrealized: 20 };
    });
    field.sync(views, 10);
    for (let i = 0; i < 120; i++) {
      field.update(0.05, i * 0.05);
      world.update?.(0.05, i * 0.05);
    }
    let total = 0;
    let casters = 0;
    scene.traverseVisible((o) => {
      if (!(o.isMesh || o.isInstancedMesh) || !o.geometry || o.material?.visible === false) return;
      let n = tris(o.geometry);
      const dr = o.geometry.drawRange;
      if (dr && Number.isFinite(dr.count)) n = Math.min(n, dr.count / 3);
      if (o.isInstancedMesh) n *= o.count;
      total += n;
      if (o.castShadow) casters += n;
    });
    // renderer.info also counts the shadow pass (casters drawn again) on tiers with shadows
    const estimate = total + (quality.shadows && quality.shadows !== 'off' ? casters : 0);
    assert.ok(estimate <= BUDGET[tier], `${tier}: ≈ ${Math.round(estimate)} triangles (budget ${BUDGET[tier]})`);
    field.dispose?.();
    world.dispose?.();
  }
  B.clearCropCache();
});

// test/game-ui.test.js — WP5 (HUD, UI, i18n, a11y) checks that need no DOM and no GPU (GAME-DESIGN §11.4).
//
//   - index.html and classic.html carry no inline script, style or handlers (CSP script-src/style-src 'self');
//   - every data-i18n / data-i18n-attr key of index.html, and every key the ui/* modules ask for, exists in
//     EN and TH (with the same {placeholders});
//   - every g.crop.* exists for the 16 coins (+ fallback); the sprite has every §9.10 symbol id;
//   - the ui/* modules import under Node with no side effects, never import three, never use innerHTML or a
//     style attribute; game.css defines the classes other packages use and the colour-blind overrides;
//   - the pure helpers behind the HUD keep the honesty rules: badge truth table, signed money / % text,
//     liquidation wording, dock labels, close estimates (≈ after fee + slippage), plant blocks, diary lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, ROOT), 'utf8');
const UI_DIR = new URL('web/js/game/ui/', ROOT);
const UI_FILES = fs.readdirSync(UI_DIR).filter((f) => f.endsWith('.js'));

// browser-ish globals some helpers touch lazily (never at import)
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const I = await import(new URL('web/js/i18n.js', ROOT).href);
const COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE', 'AVAX', 'LINK', 'SUI', 'NEAR', 'ARB', 'TIA', 'ZEC', 'WIF', 'PUMP', 'VVV'];
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join();

// ---------------------------------------------------------------- pages and CSP

for (const page of ['web/index.html', 'web/classic.html']) {
  test(`${page}: no inline script, style or event handlers (CSP 'self')`, () => {
    const html = read(page);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'every <script> has a src');
    assert.doesNotMatch(html, /<style[\s>]/i, 'no <style> element');
    assert.doesNotMatch(html, /\sstyle\s*=/i, 'no style="" attribute');
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no on…="" handler attribute');
    assert.doesNotMatch(html, /javascript:/i, 'no javascript: URL');
    assert.doesNotMatch(html, /<script[^>]*type=["']importmap/i, 'no import map');
  });
}

test('index.html: the containers other packages depend on (§6) and the boot / skip markup', () => {
  const html = read('web/index.html');
  for (const id of ['stage', 'world', 'chips', 'fx', 'hud', 'dock', 'panels', 'dialogs', 'announce', 'alert', 'sceneSummary', 'boot', 'bootMsg', 'bootActions', 'bootRetry', 'badge', 'ticker', 'skipList']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id}`);
  }
  assert.match(html, /<canvas id="world" aria-hidden="true">/);
  assert.match(html, /id="stage" tabindex="0" role="region"[^>]*aria-describedby="sceneSummary"/);
  assert.match(html, /id="announce"[^>]*aria-live="polite"/);
  assert.match(html, /id="alert"[^>]*aria-live="assertive"/);
  assert.match(html, /<ol id="dock"/, 'the dock is an ordered list (DOM twin of the field)');
  assert.match(html, /<script type="module" src="\/js\/game\/boot\.js"><\/script>/);
  assert.match(html, /<link rel="modulepreload" href="\/vendor\/three\/build\/three\.module\.min\.js">/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/game\.css">/);
  assert.match(html, /class="skip" href="#dock"/, 'skip link to the plots comes first');
});

// ---------------------------------------------------------------- i18n

test('i18n: every data-i18n / data-i18n-attr key of index.html exists in EN and TH', () => {
  const html = read('web/index.html');
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) keys.add(m[1]);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const pair of m[1].split(';')) keys.add(pair.split(':')[1].trim());
  assert.ok(keys.size > 30, 'the shell is translated');
  for (const k of keys) {
    assert.ok(k in I.STRINGS.en, `EN has ${k}`);
    assert.ok(k in I.STRINGS.th, `TH has ${k}`);
  }
});

test('i18n: every key the ui/* modules use exists in EN and TH with the same placeholders', () => {
  const keys = new Set();
  for (const f of UI_FILES) {
    const src = fs.readFileSync(new URL(f, UI_DIR), 'utf8');
    for (const m of src.matchAll(/\btn?\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
    for (const m of src.matchAll(/'((?:g|modal|shelf|packet|diary|sign|live|weather|token|act|err|dir|plot|field|ask|app|lang|set)\.[a-zA-Z0-9_.]*[a-zA-Z0-9_])'/g)) keys.add(m[1]);
  }
  for (const k of [...keys]) if (k.endsWith('.')) keys.delete(k); // prefixes of computed keys ('weather.' + key)
  for (const c of ['en', 'th']) keys.add(`g.set.lang.${c}`);
  for (const w of ['calm', 'breezy', 'windy', 'gale']) keys.add(`g.wind.${w}`);
  for (const w of ['sunny', 'mild', 'rainy', 'storm']) keys.add(`weather.${w}`);
  assert.ok(keys.size > 250, `ui modules use many keys (${keys.size})`);
  for (const k of keys) {
    assert.ok(k in I.STRINGS.en, `EN has ${k}`);
    assert.ok(k in I.STRINGS.th, `TH has ${k}`);
    assert.equal(ph(I.STRINGS.th[k]), ph(I.STRINGS.en[k]), `placeholders of ${k}`);
  }
});

test('i18n: g.crop.* for all 16 coins plus the fallback, in EN and TH; Thai side glosses', () => {
  for (const c of [...COINS, 'other']) {
    assert.ok(I.STRINGS.en[`g.crop.${c}`], `EN g.crop.${c}`);
    assert.ok(I.STRINGS.th[`g.crop.${c}`], `TH g.crop.${c}`);
  }
  assert.equal(I.STRINGS.th['g.side.long'], 'LONG ↑ (ขาขึ้น)');
  assert.equal(I.STRINGS.th['g.side.short'], 'SHORT ↓ (ขาลง)');
  assert.equal(I.STRINGS.th['g.side.longHelp'], 'LONG · ได้กำไรเมื่อราคาขึ้น');
});

test('i18n: the §7.2 key table is complete, verbatim in EN and TH', () => {
  const doc = read('GAME-DESIGN.md');
  const start = doc.indexOf('### 7.2 i18n');
  const end = doc.indexOf('### 7.3 Reduced motion');
  const rows = [...doc.slice(start, end).matchAll(/^\| `(g\.[^`]+)` \| (.*) \| (.*) \|$/gm)];
  assert.ok(rows.length > 300, `table rows: ${rows.length}`);
  const norm = (s) => s.replace(/[’]/g, "'").trim();
  for (const [, k, en, th] of rows) {
    assert.equal(norm(I.STRINGS.en[k] ?? ''), norm(en), `EN ${k}`);
    assert.equal(norm(I.STRINGS.th[k] ?? ''), norm(th), `TH ${k}`);
  }
});

test('i18n: bareText drops a leading emoji but keeps signs; applyI18n honours data-i18n-bare', () => {
  assert.equal(I.bareText('🌱 Seeds'), 'Seeds');
  assert.equal(I.bareText('☰ รายการ'), 'รายการ');
  assert.equal(I.bareText('⏩ +1h · SIM only'), '+1h · SIM only');
  const els = [
    { dataset: { i18n: 'g.btn.seeds', i18nBare: '' }, textContent: '' },
    { dataset: { i18n: 'g.btn.seeds' }, textContent: '' },
  ];
  I.applyI18n({ querySelectorAll: (sel) => (sel === '[data-i18n]' ? els : []) });
  assert.equal(els[0].textContent, 'Seeds');
  assert.equal(els[1].textContent, I.STRINGS.en['g.btn.seeds']);
});

// ---------------------------------------------------------------- icons

test('icons.svg: every §9.10 symbol id, 24 px grid, no <style> or script', () => {
  const svg = read('web/img/icons.svg');
  const ids = new Set([...svg.matchAll(/<symbol id="([^"]+)" viewBox="0 0 24 24"/g)].map((m) => m[1]));
  const ui = ['i-seed', 'i-can', 'i-basket', 'i-hoe', 'i-parasol', 'i-sun', 'i-fire', 'i-barn', 'i-tower', 'i-pond', 'i-diary', 'i-gear', 'i-sound-on', 'i-sound-off', 'i-help', 'i-list', 'i-prices', 'i-warn', 'i-lock', 'i-focus', 'i-close', 'i-more', 'i-coin', 'i-arrow-up', 'i-arrow-down'];
  for (const id of [...ui, ...COINS.map((c) => `i-crop-${c}`), 'i-crop-other']) assert.ok(ids.has(id), `symbol ${id}`);
  assert.doesNotMatch(svg, /<style|<script|\son[a-z]+=/i);
  // every icon the HTML and the ui modules reference exists
  const used = new Set([...read('web/index.html').matchAll(/icons\.svg#([\w-]+)/g)].map((m) => m[1]));
  for (const f of UI_FILES) for (const m of fs.readFileSync(new URL(f, UI_DIR), 'utf8').matchAll(/icon\('([\w-]+)'/g)) used.add(m[1]);
  for (const id of used) if (!id.endsWith('-')) assert.ok(ids.has(id), `referenced icon ${id}`);
});

// ---------------------------------------------------------------- ui modules: import rules

test('ui/*: import under Node without a DOM, no three, no innerHTML, no style attributes, no side effects', async () => {
  for (const f of UI_FILES) {
    const src = fs.readFileSync(new URL(f, UI_DIR), 'utf8');
    assert.doesNotMatch(src, /from\s+['"][^'"]*three(\.module)?(\.min)?\.js['"]|from\s+['"]three['"]/, `${f} must not import three`);
    assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/, `${f}: no HTML strings`);
    assert.doesNotMatch(src, /setAttribute\(\s*['"]style['"]/, `${f}: CSSOM only`);
    assert.doesNotMatch(src, /\beval\(|new Function\(/, `${f}: no eval`);
    const mod = await import(new URL(f, UI_DIR).href);
    assert.ok(mod && typeof mod === 'object', f);
  }
  const idx = await import(new URL('index.js', UI_DIR).href);
  assert.equal(typeof idx.mountUi, 'function');
  for (const [name, mod] of idx.MODULES) assert.equal(typeof mod.mount, 'function', `${name}.mount`);
});

test('game.css: shared class names, tokens, colour-blind and reduced-motion overrides, no imports', () => {
  const css = read('web/css/game.css');
  for (const sel of ['.chip', '.chip--up', '.chip--down', '.chip--long', '.chip--short', '.chip--warn', '.chip--stale', '.fx-label', '.fx-label--up', '.fx-label--down', '.fx-label--neutral', '.tip']) {
    assert.ok(css.includes(sel + ' ') || css.includes(sel + ',') || css.includes(sel + ' {') || css.includes(sel + '{'), sel);
  }
  for (const [tok, hex] of [['--paper', '#fff9ef'], ['--ink', '#2d2620'], ['--up', '#237a4b'], ['--down', '#b33a32'], ['--long', '#2b6cb0'], ['--short', '#7b4fc4'], ['--real', '#1d6b5a'], ['--sim', '#6b4fa0'], ['--off', '#5f6368'], ['--wood', '#c98a4b']]) {
    assert.match(css, new RegExp(`${tok}: ${hex};`, 'i'), tok);
  }
  assert.match(css, /:root\[data-palette="cb"\] \{[^}]*--up: #1f78b4;[^}]*--down: #e66101;/s, 'colour-blind P&L palette (§7.4)');
  assert.match(css, /:root\[data-motion="reduced"\] \*/, 'reduced motion kills animation (§7.3)');
  assert.match(css, /min-height: 56px/, '56 px phone bar buttons (§6.2)');
  assert.match(css, /env\(safe-area-inset-bottom/, 'safe areas');
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /@import|url\(\s*["']?https?:/i, 'no remote CSS');
});

// ---------------------------------------------------------------- pure helpers: honesty rules

const V = await import(new URL('web/js/game/core/view.js', ROOT).href);
const U = await import(new URL('util.js', UI_DIR).href);
const T = await import(new URL('plotText.js', UI_DIR).href);
const B = await import(new URL('badge.js', UI_DIR).href);
const TK = await import(new URL('ticker.js', UI_DIR).href);
const BD = await import(new URL('board.js', UI_DIR).href);
const CF = await import(new URL('confirm.js', UI_DIR).href);
const DR = await import(new URL('derive.js', UI_DIR).href);
const DY = await import(new URL('diary.js', UI_DIR).href);
const IN = await import(new URL('inspector.js', UI_DIR).href);

test('money text: explicit sign, glyph and tone; zero is neutral; ≈ for estimates (§6.13)', () => {
  assert.deepEqual(U.money(3.1), { text: '+$3.10 ▲', tone: 'up' });
  assert.deepEqual(U.money(-8.2), { text: '−$8.20 ▼', tone: 'down' }, 'typographic minus, like the % beside it');
  assert.deepEqual(U.money(-0.004), { text: '$0.00', tone: 'zero' });
  assert.deepEqual(U.money(0), { text: '$0.00', tone: 'zero' });
  assert.deepEqual(U.money(0.004), { text: '$0.00', tone: 'zero' }, 'rounds to zero → neutral, no glyph');
  assert.equal(U.money(-1.2, { est: true }).text, '≈ −$1.20 ▼');
  assert.equal(U.money(null).text, '—');
  // price direction is neutral ink with ▴ / ▾ — never money colours
  assert.equal(U.chgText(0.012), '▴1.2%');
  assert.equal(U.chgText(-0.008), '▾0.8%');
  assert.equal(T.signedPct(0.031), '+3.1%');
  assert.equal(T.signedPct(-0.012), '−1.2%');
  assert.equal(T.signedPct(0), '0.0%');
});

test('ages: fresh ≤ 15 s, delayed ≤ 60 s, stale beyond (§6.13 rule 5)', () => {
  const now = 1_000_000;
  assert.equal(U.ageLabel(now - 3000, now).kind, 'fresh');
  assert.match(U.ageLabel(now - 25_000, now).text, /^delayed · 25/);
  assert.match(U.ageLabel(now - 120_000, now).text, /^stale · 2/);
  assert.equal(U.ageLabel(null, now).kind, 'stale');
});

function plotFixture(over = {}) {
  const bot = {
    id: 'bot-0003', bean: 612, coin: 'BTC', capital_usd: 100, leverage: 10, state: 'active', bean_side: 1, sz_decimals: 5,
    realized_pnl: 0.25, fees: 0.37, fills: 2, mark_px: 82980.5, mark_ms: 1_000_000,
    real: { szi: 0.005, entry_px: 82410, unrealized_pnl: 2.85, margin_used: 44.06, liquidation_px: 74581.05, leverage: 10, as_of_ms: 1_000_000 },
    ...over,
  };
  return { bot, view: V.plotView(bot, 0, { nowMs: 1_003_000 }) };
}

test('plot text: dock label carries coin, crop, side, leverage, P&L, % of water, state and liquidation (§7.1, J7)', () => {
  const { view } = plotFixture();
  const label = T.dockLabel(view, '01');
  for (const part of ['Plot 01', 'BTC', 'orange tree', 'LONG ↑', '10×', '+$3.10 ▲', '+3.1% of water', 'price must fall 10.1% to liquidate']) assert.ok(label.includes(part), `${part} in "${label}"`);
  assert.equal(T.liqText(view), 'price must fall 10.1% to liquidate');
  assert.equal(T.liqSegments(view), 4);
  assert.equal(T.dockLabel(null, '04'), 'Plot 04: empty — plant a seed');
  const short = plotFixture({ real: { szi: -2, entry_px: 100, unrealized_pnl: -1, margin_used: 20, liquidation_px: 109.5, as_of_ms: 1_000_000 }, mark_px: 108, coin: 'SOL', sz_decimals: 2 }).view;
  assert.match(T.liqText(short), /^price must rise 1\.4% to liquidate$/);
  assert.equal(T.stateKey(short).key, 'g.liq.near', 'danger band overrides the growth caption');
});

test('plot text: neutral state captions (J12) and "nothing at risk" only when flat (§6.13 rule 8)', () => {
  const flat = plotFixture({ bean_side: 0, real: { szi: 0, entry_px: null, unrealized_pnl: 0, as_of_ms: 1_000_000 } }).view;
  assert.equal(T.stateKey(flat).key, 'g.state.waiting');
  assert.match(T.stateText(flat), /nothing at risk/);
  assert.equal(T.liqText(flat), 'no position — nothing at risk right now');
  const paused = plotFixture({ state: 'paused', note: 'liquidated', real: { szi: 0, unrealized_pnl: 0, as_of_ms: 1_000_000 } }).view;
  assert.equal(T.stateKey(paused).key, 'g.state.liquidated');
  for (const k of ['g.state.ripe', 'g.state.dying']) assert.doesNotMatch(I.STRINGS.en[k], /now!|hurry|quick/i, `${k} never pushes a decision`);
});

test('badge truth table (§6.3): loading · sim · real · coins delayed · delayed · down · offline', () => {
  const now = 2_000_000;
  const feed = (o) => ({ source: o.prices === 'sim' ? 'sim' : 'hyperliquid', prices: 'real', state: 'live', staleCoins: [], ...o });
  const st = (o) => ({ status: {}, health: {}, net: { ok: true, lastOkMs: now, skewMs: 0 }, marks: { t: now - 2000, stale: [] }, ...o });
  assert.equal(B.badgeModel({ net: { ok: true } }, now).key, 'g.badge.loading');
  assert.equal(B.badgeModel(st({ feed: feed({ prices: 'sim', state: 'sim' }) }), now).key, 'g.badge.sim');
  assert.equal(B.badgeModel(st({ feed: feed({}) }), now).tone, 'real');
  const partial = B.badgeModel(st({ feed: feed({ staleCoins: ['SOL', 'ETH', 'WIF'] }) }), now);
  assert.equal(partial.key, 'g.badge.realPartial');
  assert.equal(partial.vars.n, 3);
  assert.equal(partial.shortKey, 'g.badge.short.delayed');
  const old = B.badgeModel(st({ feed: feed({}), marks: { t: now - 45_000, stale: [] } }), now);
  assert.equal(old.key, 'g.badge.delayed');
  assert.equal(old.tone, 'warn');
  assert.equal(B.badgeModel(st({ feed: feed({ state: 'down', midsMs: now - 90_000 }) }), now).key, 'g.badge.down');
  const off = B.badgeModel(st({ feed: feed({}), net: { ok: false, lastOkMs: now - 30_000 } }), now);
  assert.equal(off.key, 'g.badge.offline');
  assert.equal(off.state, 'offline');
  // the PAPER words never leave the badge (J9)
  for (const k of ['g.badge.real', 'g.badge.realPartial', 'g.badge.delayed', 'g.badge.sim', 'g.badge.short.real', 'g.badge.short.sim']) {
    assert.match(I.STRINGS.en[k], /PAPER/, k);
    assert.match(I.STRINGS.th[k], /กระดาษ/, `TH ${k}`);
  }
});

test('ticker order: planted coins first, then by |24 h change| (no reorder by marks)', () => {
  const coins = [
    { coin: 'BTC', change_24h: 0.004 },
    { coin: 'ETH', change_24h: -0.07 },
    { coin: 'SOL', change_24h: 0.02 },
    { coin: 'DOGE', change_24h: 0.001 },
  ];
  assert.deepEqual(TK.tickerOrder(coins, ['DOGE', 'BTC', 'DOGE', 'XYZ']), ['DOGE', 'BTC', 'ETH', 'SOL']);
  assert.deepEqual(TK.tickerOrder(coins), ['ETH', 'SOL', 'BTC', 'DOGE']);
});

test('board: funding per hour is a signed 4-decimal % (information only)', () => {
  assert.equal(BD.fundingText(0.0000061117), '+0.0006%');
  assert.equal(BD.fundingText(-0.0000125), '−0.0013%');
  assert.equal(BD.fundingText(0), '0.0000%');
  assert.equal(BD.fundingText(null), '—');
  assert.match(I.STRINGS.en['g.board.funding'], /info only/);
  assert.match(I.STRINGS.en['g.plant.funding'], /not charged/);
});

test('confirm: ≈ close estimate includes fee and slippage; the "numbers changed" rule (§6.7)', () => {
  const { bot } = plotFixture();
  const q = CF.closeEstimate(bot, 82980.5);
  const notional = 0.005 * 82980.5;
  assert.ok(Math.abs(q.fee - notional * 0.00045) < 1e-9);
  assert.ok(Math.abs(q.slip - notional * 0.00015) < 1e-9);
  assert.ok(Math.abs(q.estTotal - (0.25 + 2.85 - notional * 0.0006)) < 1e-9);
  assert.ok(Math.abs(q.pct - q.estTotal / 100) < 1e-12);
  assert.equal(q.flat, false);
  assert.ok(Math.abs(q.realizes - (q.estTotal - 0.25)) < 1e-12, 'shade realizes the unrealized part net of costs');
  assert.equal(CF.estimateChanged(10, 10.4), false);
  assert.equal(CF.estimateChanged(10, 10.6), true, '> $0.50');
  assert.equal(CF.estimateChanged(2, 2.3), true, '> 10 %');
  assert.match(I.STRINGS.en['g.ask.differ'], /Paper fill/, 'J10: the words "paper fill"');
  assert.equal(I.STRINGS.en['g.ask.keep'], 'Keep growing');
});

test('derive: plant blocks in §6.5 order, free slots honour reservations, newest price wins', () => {
  const bean = { id: 7, coin: 'SOL', leverage: 10, venue_max_leverage: 20, position_size: 0.5, equity: 1000 };
  const live = { caps: { max_bots: 10, max_total_notional_usd: 10000 }, open_notional_usd: 0, available_usd: 10000, halted: false };
  const base = { net: { ok: true, skewMs: 0 }, feed: { prices: 'real', state: 'live', staleCoins: [] }, live, bots: [], marks: { t: Date.now(), px: { SOL: 110 }, stale: [] }, market: { coins: { SOL: { coin: 'SOL', px: 109, px_ms: Date.now() - 30_000 } } }, slots: { map: {}, count: 10, hidden: [], wanted: {} } };
  assert.equal(DR.plantBlock(base, bean, 100), null);
  assert.equal(DR.plantBlock({ ...base, net: { ok: false } }, bean, 100).key, 'g.plant.offBlock');
  assert.equal(DR.plantBlock({ ...base, live: { ...live, halted: true } }, bean, 100).key, 'modal.halted');
  assert.equal(DR.plantBlock({ ...base, feed: { ...base.feed, state: 'down' } }, bean, 100).key, 'g.plant.downBlock');
  assert.equal(DR.plantBlock({ ...base, marks: { ...base.marks, stale: ['SOL'] } }, bean, 100).key, 'g.plant.staleBlock');
  assert.equal(DR.plantBlock({ ...base, marks: { ...base.marks, t: Date.now() - 20_000 } }, bean, 100).key, 'g.plant.staleBlock', 'marks older than 15 s');
  assert.equal(DR.plantBlock({ ...base, bots: [{ id: 'b1', coin: 'SOL', state: 'active' }] }, bean, 100).key, 'packet.alreadyPlanted', 'one bot per coin');
  assert.equal(DR.plantBlock({ ...base, live: { ...live, open_notional_usd: 9990 } }, bean, 100).key, 'modal.full');
  assert.equal(DR.plantBlock({ ...base, live: { ...live, open_notional_usd: 9000 } }, bean, 500).key, 'modal.overCap');
  assert.equal(DR.priceOf(base, 'SOL').px, 110, 'the mids pulse is newer than the market snapshot');
  assert.equal(DR.freeSlotOf(base), 0);
  assert.equal(DR.freeSlotOf({ ...base, slots: { ...base.slots, map: { b1: 0 }, wanted: { 9: 1 } } }, null), 2);
  assert.equal(DR.freeSlotOf({ ...base, slots: { ...base.slots, map: { b1: 0 } } }, 4), 4);
  // the plant dialog's own reservation (bean 9 → plot 4, in flight) does not move its target
  assert.equal(DR.freeSlotOf({ ...base, slots: { ...base.slots, map: { b1: 0 }, wanted: { 9: 4 } } }, 4, 9), 4);
  assert.notEqual(DR.freeSlotOf({ ...base, slots: { ...base.slots, map: { b1: 0 }, wanted: { 9: 4 } } }, 4), 4);
});

test('diary lines: own echoes are not written twice, losses read as losses, only shown beans bust', () => {
  const l = (ev) => DY.lineFor(ev, { szDecimals: () => 4 });
  assert.equal(l({ type: 'paused', bot: 'bot-1', own: true }), null);
  assert.equal(l({ type: 'closed', bot: 'bot-1', own: true, realized_pnl: 2 }), null);
  assert.equal(l({ type: 'closed', bot: 'bot-1', burn: true, realized_pnl: 2 }), null, 'the burn summary covers it');
  assert.equal(l({ type: 'closed', bot: 'bot-1', realized_pnl: -3.5 }).text, '🪓 bot-1 closed — banked -$3.50');
  assert.equal(l({ type: 'created', bot: 'bot-2', bean: 5, coin: 'ETH', capital_usd: 100, own: true }).key, 'plant:5');
  assert.equal(l({ type: 'busted', bean: 9, coin: 'SOL', onShelf: false, planted: false }), null);
  assert.equal(l({ type: 'busted', bean: 9, coin: 'SOL', onShelf: true }).kind, 'warn');
  assert.equal(l({ type: 'fill', bot: 'bot-3', coin: 'ETH', dir: 'Open Long', sz: 0.5, px: 2509.354 }).text, '💧 bot-3: Open Long 0.5000 ETH @ $2,509.35');
  const liq = l({ type: 'fill', bot: 'bot-3', coin: 'ETH', dir: 'Close Long', liquidation: true, closed_pnl: -44.06 });
  assert.equal(liq.kind, 'warn');
  assert.match(liq.text, /liquidated — lost \$44\.06 margin/);
  assert.equal(l({ type: 'tick', tick: 9, quiet: true }), null, 'time-lapse bursts are silent');
  assert.equal(l({ type: 'feed', state: 'down' }).kind, 'warn');
  assert.equal(l({ type: 'gap', mode: 'replay', bars: 12 }).text, '⏪ caught up 12 missed minutes of real prices');
  assert.equal(DY.recordEvent({ seq: 3, t: 5, kind: 'bot_order', status: 'filled' }), null);
  assert.equal(DY.recordEvent({ seq: 4, t: 5, kind: 'bot_fill', bot: 'b' }).type, 'fill');
});

test('inspector: the "price since you opened this page" sparkline maps a series into the box', () => {
  assert.equal(IN.sparkPoints([[1, 5]]), '');
  const pts = IN.sparkPoints([[1, 10], [2, 20], [3, 15]], 100, 20, 0).split(' ');
  assert.deepEqual(pts, ['0.0,20.0', '50.0,0.0', '100.0,10.0']);
  assert.equal(IN.sparkPoints([[1, 3], [2, 3]], 10, 10, 0), '0.0,5.0 10.0,5.0', 'a flat series is drawn mid-height');
});

test('badge with the real-feed fixtures (status-real.json + mids.json): ● REAL PRICES · PAPER TRADES', () => {
  const status = JSON.parse(read('test/fixtures/status-real.json'));
  const mids = JSON.parse(read('test/fixtures/mids.json'));
  const feed = V.feedOf(status, status);
  const state = { status, health: status, feed, net: { ok: true, lastOkMs: mids.t, skewMs: 0 }, marks: { t: mids.t, px: mids.px, stale: mids.stale } };
  const m = B.badgeModel(state, mids.t + 3000);
  assert.equal(m.key, 'g.badge.real');
  assert.equal(m.tone, 'real');
  assert.equal(m.mark, '●');
  assert.equal(I.STRINGS.en[m.key], 'REAL PRICES · PAPER TRADES');
  // 20 s without a pulse: the same feed reads as delayed (§6.3 "marks age > 15 s")
  assert.equal(B.badgeModel(state, mids.t + 20_000).key, 'g.badge.delayed');
});

// test/web.test.js — unit tests for the browser modules in web/js (no DOM needed: browser globals are stubbed).
import test from 'node:test';
import assert from 'node:assert/strict';

const WEB = new URL('../web/js/', import.meta.url);
const imp = (f) => import(new URL(f, WEB).href);

// ---- browser-ish globals for brood-api
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
let replaced = null;
function setLocation(href) {
  const u = new URL(href);
  globalThis.location = { href: u.href, origin: u.origin, search: u.search, pathname: u.pathname, hash: u.hash };
}
globalThis.history = {
  state: null,
  replaceState: (_s, _t, url) => {
    replaced = url;
    setLocation(new URL(url, globalThis.location.href).href);
  },
};
setLocation('http://127.0.0.1:8420/');

const F = await imp('format.js');
const I = await imp('i18n.js');
const A = await imp('brood-api.js');
const P = await imp('plant.js');
const G = await imp('garden.js');

// ---------------------------------------------------------------- format
test('format: esc escapes all five specials', () => {
  assert.equal(F.esc(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(F.esc(null), '');
});
test('format: numbers', () => {
  assert.equal(F.fmt(1234.567, 1), '1,234.6');
  assert.equal(F.fmt(null), '—');
  assert.equal(F.pct(0.01234), '+1.23%');
  assert.equal(F.pct(-0.00001), '+0.00%');
  assert.equal(F.pct(-0.05, 1), '-5.0%');
  assert.equal(F.usd(-3.951), '-$3.95');
  assert.equal(F.usd(1234.5, 0), '$1,235');
  assert.equal(F.usd(2.5, 2, true), '+$2.50');
  assert.equal(F.usd(-0.001, 2, true), '$0.00');
  assert.equal(F.usd(undefined), '—');
  assert.equal(F.signClass(2), 'up');
  assert.equal(F.signClass(-2), 'down');
  assert.equal(F.signClass(0), '');
  assert.equal(F.price(82000.123), '82,000.1');
  assert.equal(F.price(0.0061234), '0.006123');
  assert.equal(F.ago(1000, 13000), '12s');
  assert.equal(F.ago(0), '—');
  assert.equal(F.ago(1, 1 + 3 * 3600e3, { s: ' วิ', m: ' นาที', h: ' ชม.', d: ' วัน' }), '3 ชม.');
});

// ---------------------------------------------------------------- i18n
test('i18n: detection, interpolation, fallback, parity', () => {
  assert.equal(I.detectLang({ navLang: 'th-TH' }), 'th');
  assert.equal(I.detectLang({ navLang: 'th' }), 'th');
  assert.equal(I.detectLang({ navLang: 'en-US' }), 'en');
  assert.equal(I.detectLang({ stored: 'en', navLang: 'th-TH' }), 'en');
  assert.equal(I.detectLang({ stored: 'xx', navLang: 'th' }), 'th');
  assert.equal(I.t('diary.tick', { n: 5 }), '🌅 a new minute: tick 5');
  assert.equal(I.t('no.such.key'), 'no.such.key');
  const en = Object.keys(I.STRINGS.en).sort();
  const th = Object.keys(I.STRINGS.th).sort();
  assert.deepEqual(th, en, 'TH and EN have the same keys');
  for (const k of en) {
    const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
    assert.equal(ph(I.STRINGS.th[k]), ph(I.STRINGS.en[k]), 'placeholders for ' + k);
  }
  I.setLang('th');
  assert.equal(store.get('bean.lang'), 'th');
  assert.equal(I.t('cap.ripe'), 'สุกแล้ว — เก็บเกี่ยวไหม? 🧺');
  assert.equal(I.tn('plot.fills', 5, { ago: '1 วิ' }), 'เทรด 5 · 1 วิที่แล้ว');
  assert.equal(I.tn('diary.burned', 1, { usd: '$1.00' }), '🔥 เผาไร่แล้ว: ปิดบอท 1 ตัว ได้ $1.00');
  I.setLang('en');
  assert.equal(I.tn('packet.fills', 1), '1 fill');
  assert.equal(I.tn('packet.fills', 2), '2 fills');
  assert.equal(I.tn('packet.fills', 1234, { n: '1,234' }), '1,234 fills');
  assert.equal(I.tn('diary.burned', 1, { usd: '-$18.65' }), '🔥 burned the field: closed 1 bot, banked -$18.65');
  assert.equal(I.tn('diary.halted', 3), '🔥 the field was burned — 3 bots closed');
});
test('i18n: localStorage that throws is tolerated', () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.doesNotThrow(() => I.initLang());
  assert.doesNotThrow(() => I.setLang(I.getLang() === 'en' ? 'th' : 'en'));
  globalThis.localStorage = saved;
  I.setLang('en');
});

// ---------------------------------------------------------------- brood-api
test('api: base resolution order + sanitising', () => {
  assert.equal(A.resolveBase({ search: '?api=http://h:1/', stored: 'http://s:2', meta: 'http://m:3' }), 'http://h:1');
  assert.equal(A.resolveBase({ search: '', stored: 'http://s:2/', meta: 'http://m:3' }), 'http://s:2');
  assert.equal(A.resolveBase({ search: '', stored: null, meta: 'http://m:3' }), 'http://m:3');
  assert.equal(A.resolveBase({}), '');
  assert.equal(A.resolveBase({ search: '?api=', stored: 'http://s:2' }), '', 'empty ?api= means same origin');
  assert.equal(A.resolveBase({ search: '?api=javascript:alert(1)', stored: 'http://s:2' }), 'http://s:2');
  assert.equal(A.cleanBase('//evil'), null);
  // "\" parses like "/": "/\evil.example" would be protocol-relative → refused; real paths stay
  assert.equal(A.cleanBase('/\\evil.example'), null);
  assert.equal(A.cleanBase('/brood\\x'), null);
  assert.equal(A.resolveBase({ search: '?api=' + encodeURIComponent('/\\evil.example'), stored: null }), '');
  assert.equal(A.cleanBase('/brood/'), '/brood');
  assert.deepEqual(A.resolveBaseInfo({ search: '?api=http://h:1' }), { base: 'http://h:1', source: 'url' });
  assert.deepEqual(A.resolveBaseInfo({ stored: 'http://s:2' }), { base: 'http://s:2', source: 'stored' });
  assert.deepEqual(A.resolveBaseInfo({ meta: 'http://m:3' }), { base: 'http://m:3', source: 'meta' });
  assert.deepEqual(A.resolveBaseInfo({ search: '?api=' }), { base: '', source: 'same' });
});
test('api: params encoding', () => {
  const sp = A.buildParams({ a: undefined, b: null, c: '', d: false, e: 0, ids: [1, 2, 3], s: '-total_return' });
  assert.equal(sp.toString(), 'd=false&e=0&ids=1%2C2%2C3&s=-total_return');
  assert.throws(() => A.apiUrl('../x'));
  assert.equal(A.apiUrl('beans', { limit: 5 }), 'http://127.0.0.1:8420/api/v1/beans?limit=5');
});
test('api: ?token= is stored, stripped, and bound to the API origin', () => {
  setLocation('http://127.0.0.1:8420/?nostream=1&token=SECRET#x');
  const r = A.adoptUrlParams();
  assert.deepEqual(r, { token: true });
  assert.equal(store.get('brood.token'), 'SECRET');
  assert.equal(replaced, '/?nostream=1#x');
  assert.equal(globalThis.location.search, '?nostream=1');
  assert.equal(A.getToken(), 'SECRET');
  assert.equal(A.streamDisabled(), true);
  // a link that points the page at another host never gets the token
  setLocation('http://127.0.0.1:8420/?api=https://evil.example');
  assert.equal(A.getToken(), null);
  setLocation('http://127.0.0.1:8420/');
  A.setToken('');
  assert.equal(A.hasToken(), false);
});
test('api: tokens live in one slot per API origin; a ?api= link can neither read, receive nor clobber them', () => {
  const home = 'http://127.0.0.1:8420/';
  const evil = 'http://127.0.0.1:8420/?api=' + encodeURIComponent('https://evil.example');
  setLocation(home);
  assert.equal(A.setToken('REAL-TOKEN'), true);
  assert.equal(store.get('brood.token'), 'REAL-TOKEN', 'same-origin token keeps the SPEC slot');

  // A) a saved token is not offered to the foreign API
  setLocation(evil);
  assert.equal(A.apiIsCrossOrigin(), true);
  assert.equal(A.apiUntrusted(), true);
  assert.equal(A.getToken(), null);
  // B) typing the token on that page is refused unless the user confirmed the host
  assert.throws(() => A.setToken('REAL-TOKEN'), (e) => e.code === 'untrusted_api');
  assert.equal(store.get('brood.token@https://evil.example'), undefined);
  // D) ?api=evil&token=attacker is stripped but never adopted
  setLocation(evil + '&token=attacker');
  assert.deepEqual(A.adoptUrlParams(), { token: false, ignored: 'untrusted_api' });
  assert.equal(globalThis.location.search.includes('token'), false, 'still stripped from the address bar');
  assert.equal(store.get('brood.token@https://evil.example'), undefined);
  // an explicit "yes, that server is mine" saves into evil's OWN slot…
  setLocation(evil);
  assert.equal(A.setToken('FOR-EVIL', { trustApi: true }), true);
  assert.equal(A.getToken(), 'FOR-EVIL');
  // C) …and the real garden still has its token
  setLocation(home);
  assert.equal(A.getToken(), 'REAL-TOKEN');
  assert.equal(store.get('brood.token'), 'REAL-TOKEN');

  // a base the user chose (setBase / stored) is trusted: no confirmation needed, its own slot
  A.setBase('http://10.0.0.5:8420');
  assert.equal(A.apiIsCrossOrigin(), true);
  assert.equal(A.apiUntrusted(), false);
  assert.equal(A.setToken('LAN-TOKEN'), true);
  assert.equal(store.get('brood.token@http://10.0.0.5:8420'), 'LAN-TOKEN');
  A.setBase(null);
  assert.equal(A.getToken(), 'REAL-TOKEN');

  // unusable characters (a header cannot carry them): refused when typed, ignored in a link
  assert.throws(() => A.setToken('โทเค็น'), (e) => e.code === 'chars');
  assert.throws(() => A.setToken('a b'), (e) => e.code === 'chars');
  assert.equal(A.tokenProblem('ok-token'), null);
  setLocation(home + '?token=' + encodeURIComponent('มี ช่องว่าง'));
  assert.deepEqual(A.adoptUrlParams(), { token: false, ignored: 'chars' });
  assert.equal(A.getToken(), 'REAL-TOKEN');

  for (const k of [...store.keys()]) if (k.startsWith('brood.token')) store.delete(k);
});

test('api: a legacy single-slot token bound to another origin moves to that origin\'s slot', () => {
  setLocation('http://127.0.0.1:8420/');
  store.set('brood.token', 'OLD');
  store.set('brood.token.origin', 'http://10.0.0.5:8420');
  assert.equal(A.getToken(), null, 'never handed to this page\'s own server');
  assert.equal(store.get('brood.token@http://10.0.0.5:8420'), 'OLD');
  assert.equal(store.has('brood.token'), false);
  assert.equal(store.has('brood.token.origin'), false);
  store.set('brood.token', 'MINE');
  store.set('brood.token.origin', 'http://127.0.0.1:8420');
  assert.equal(A.getToken(), 'MINE');
  for (const k of [...store.keys()]) if (k.startsWith('brood.token')) store.delete(k);
});

test('api: query throws server message; command resolves {error,status}', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = new URL(url);
    if (u.pathname.endsWith('/boom')) return new Response(JSON.stringify({ error: 'bad thing', status: 409 }), { status: 409 });
    if (u.pathname.endsWith('/down')) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ ok: true, echo: init.body ? JSON.parse(init.body) : null }), { status: 200 });
  };
  assert.deepEqual(await A.query('health'), { ok: true, echo: null });
  await assert.rejects(A.query('boom'), (e) => e.message === 'bad thing' && e.status === 409);
  await assert.rejects(A.query('down'), (e) => e.status === 0);
  A.setToken('T0K');
  const out = await A.command('bot_create', { bean: 7, capital_usd: 100 });
  assert.deepEqual(out.echo, { bean: 7, capital_usd: 100 });
  const last = calls.at(-1);
  assert.equal(last.init.method, 'POST');
  assert.equal(last.init.headers.Authorization, 'Bearer T0K');
  assert.equal(last.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(await A.command('boom', {}), { error: 'bad thing', status: 409 });
  const down = await A.command('down', {});
  assert.equal(down.status, 0);
  assert.match(down.error, /Failed to fetch/);
  A.setToken('');
  delete globalThis.fetch;
});

// ---------------------------------------------------------------- plant model
const bot = (o = {}) => ({
  id: 'bot-0001',
  index: 1,
  coin: 'BTC',
  state: 'active',
  capital_usd: 100,
  realized_pnl: 0,
  bean_side: 1,
  real: { szi: 0.01, unrealized_pnl: 0 },
  last_error: null,
  ...o,
});
const near = (a, b) => Math.abs(a - b) < 1e-9;
test('plant: phases', () => {
  assert.equal(P.botPhase(bot({ state: 'closed' })), 'closed');
  assert.equal(P.botPhase(bot({ state: 'paused' })), 'paused');
  assert.equal(P.botPhase(bot({ last_error: 'x' })), 'error');
  assert.equal(P.botPhase(bot({ real: { szi: 0 }, bean_side: 0 })), 'waiting');
  assert.equal(P.botPhase(bot({ real: { szi: 0 }, bean_side: -1 })), 'entering');
  assert.equal(P.botPhase(bot({ real: { szi: -2 } })), 'short');
  assert.equal(P.botPhase(bot()), 'long');
});
test('plant: growth formulas and thresholds (SPEC §5)', () => {
  let s = P.stage(bot());
  assert.ok(near(s.size, 0.35) && s.health === 1 && s.flower && s.fruit === 0 && s.caption === null);
  s = P.stage(bot({ real: { szi: 0 }, bean_side: 0 }));
  assert.ok(near(s.size, 0.25) && s.caption === 'waiting' && s.seed);
  // studied example bot-0010: −3.951 on $50 → f = −7.9%
  s = P.stage(bot({ capital_usd: 50, realized_pnl: -0.0435, real: { szi: 1, unrealized_pnl: -3.9075 } }));
  assert.ok(near(s.frac, -0.07902));
  assert.equal(s.size, 0.12);
  assert.ok(near(s.health, 1 - 8 * 0.07902));
  assert.equal(s.flower, false);
  assert.equal(s.fruit, 0);
  assert.equal(s.caption, 'wilting');
  assert.equal(P.stage(bot({ realized_pnl: 2 })).fruit, 0, 'exactly 2% → no fruit');
  assert.equal(P.stage(bot({ realized_pnl: 2.01 })).fruit, 1);
  assert.equal(P.stage(bot({ realized_pnl: 6 })).fruit, 3, '6% → 3 (float-safe)');
  assert.equal(P.stage(bot({ realized_pnl: 50 })).fruit, 6);
  assert.equal(P.stage(bot({ realized_pnl: 50 })).size, 1);
  assert.equal(P.stage(bot({ realized_pnl: 5 })).caption, null, '5% is not yet ripe');
  assert.equal(P.stage(bot({ realized_pnl: 5.1 })).caption, 'ripe');
  assert.equal(P.stage(bot({ realized_pnl: -10.1 })).caption, 'dying');
  assert.equal(P.stage(bot({ realized_pnl: -13 })).health, 0);
  const paused = P.stage(bot({ state: 'paused', realized_pnl: -7 }));
  assert.ok(paused.shaded && paused.caption === 'wilting');
  assert.equal(P.stage(bot({ capital_usd: 0 })).frac, 0);
});

// mock 2D context: records calls, measureText returns a width
function mockCtx() {
  const calls = [];
  const grad = { addColorStop() {} };
  return new Proxy(
    { calls },
    {
      get(target, prop) {
        if (prop === 'calls') return calls;
        if (prop === 'measureText') return (s) => ({ width: String(s).length * 6 });
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return (...args) => {
          calls.push([String(prop), args]);
          return grad;
        };
        if (prop in target) return target[prop];
        return (...args) => {
          calls.push([String(prop), args]);
        };
      },
      set(target, prop, value) {
        target[prop] = value;
        calls.push(['set:' + String(prop), [value]]);
        return true;
      },
    },
  );
}
test('plant: drawPlant paints every phase without throwing, finite coords', () => {
  const variants = [
    bot(),
    bot({ realized_pnl: 9 }),
    bot({ realized_pnl: -11 }),
    bot({ state: 'paused' }),
    bot({ last_error: 'boom' }),
    bot({ real: { szi: 0 }, bean_side: 0 }),
    bot({ real: { szi: 0 }, bean_side: 1 }),
    bot({ state: 'closed' }),
    {},
    null,
  ];
  for (const b of variants) {
    for (const [w, h] of [[170, 180], [132, 160], [400, 300], [1, 1]]) {
      const ctx = mockCtx();
      const s = P.drawPlant(ctx, w, h, b, 12345, { glow: 0.5, labels: { ripe: 'R', dying: 'D' } });
      assert.ok(s && typeof s.phase === 'string');
      for (const [name, args] of ctx.calls) {
        for (const a of args) if (typeof a === 'number') assert.ok(Number.isFinite(a), `${name} got ${a}`);
        if (name === 'ellipse' || name === 'arc') assert.ok(args[2] >= 0 && (name === 'arc' || args[3] >= 0), `${name} negative radius`);
      }
    }
  }
  const ctx = mockCtx();
  P.drawPlant(ctx, 170, 180, bot({ realized_pnl: 9 }), 0, { labels: { ripe: 'RIPE!' } });
  assert.ok(ctx.calls.some(([n, a]) => n === 'fillText' && a[0] === 'RIPE!'));
  const a = mockCtx();
  const b2 = mockCtx();
  P.drawPlant(a, 170, 180, bot(), 1000, { reducedMotion: true });
  P.drawPlant(b2, 170, 180, bot(), 98765, { reducedMotion: true });
  assert.equal(JSON.stringify(a.calls), JSON.stringify(b2.calls), 'reduced motion is static');
});
test('plant: sparkline', () => {
  assert.equal(P.drawSparkline(mockCtx(), 130, 36, [{ h: 0, equity: 1000 }, { h: 1, equity: 1010 }, 990]), true);
  assert.equal(P.drawSparkline(mockCtx(), 130, 36, []), false);
  assert.equal(P.drawSparkline(mockCtx(), 130, 36, [1000, 1000]), true);
});
test('plant: perf — drawPlant into mock ctx', () => {
  const ctx = mockCtx();
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) {
    ctx.calls.length = 0;
    P.drawPlant(ctx, 170, 180, bot({ realized_pnl: (i % 20) - 8 }), i * 16);
  }
  const ms = (performance.now() - t0) / 2000;
  console.log(`# drawPlant (mock ctx) ${ms.toFixed(4)} ms/call`);
});

// ---------------------------------------------------------------- garden pure helpers
test('garden: shelf query matches SPEC', () => {
  assert.deepEqual(G.shelfQuery({ sort: '-ret_7d', archetype: '', sproutingOnly: true, halted: false }), {
    distinct_coin: true,
    busted: false,
    trades_min: 1,
    limit: 5,
    sort: '-ret_7d',
    tradeable: true,
    in_position: true,
  });
  const halted = G.shelfQuery({ halted: true, sproutingOnly: false, archetype: 'swarm' });
  assert.equal('tradeable' in halted, false);
  assert.equal('in_position' in halted, false);
  assert.equal(halted.archetype, 'swarm');
});
test('garden: weather thresholds', () => {
  const w = (x) => G.weatherOf([{ change_24h: x }, { change_24h: null }]).key;
  assert.equal(w(0.0107), 'sunny');
  assert.equal(w(0.01), 'mild');
  assert.equal(w(-0.0099), 'mild');
  assert.equal(w(-0.02), 'rainy');
  assert.equal(w(-0.03), 'storm');
  assert.equal(G.weatherOf([]), null);
});
test('garden: modal mirror math (studied example)', () => {
  const n = G.mirrorNote({ position_size: 0.24577829241752625, leverage: 25, equity: 2184.212158203125 }, 100);
  assert.ok(Math.abs(n.pct - 10) < 1e-9);
  assert.ok(Math.abs(n.notional - 1342.06) < 0.1, String(n.notional));
  assert.ok(Math.abs(G.mirrorNote({}, 20).notional - 0) < 1e-9);
});
test('garden: room under the open-notional cap and cash; margin vs water; fill directions', () => {
  // ETH swarm_50x-like bean: ≈ $22,034 notional per $1000 of water
  const bean = { position_size: 0.2, leverage: 50, equity: 2203.4, venue_max_leverage: 25 };
  const live = { caps: { max_total_notional_usd: 10_000 }, open_notional_usd: 1697.46, available_usd: 9000 };
  const room = G.stakeRoom(bean, live);
  // (10000 − 1697.46) / 22.034 per $ = 376.8 → floored to the slider step
  assert.deepEqual(room, { maxStake: 370, cap: 10_000 });
  assert.equal(G.stakeRoom(bean, { ...live, open_notional_usd: 9_900 }).maxStake, 0, 'full field');
  assert.equal(G.stakeRoom(bean, { ...live, available_usd: 55 }).maxStake, 50, 'cash binds too');
  assert.equal(G.stakeRoom({ position_size: 0.01, leverage: 1, equity: 1000 }, live).maxStake, 1000, 'slider max');
  assert.equal(G.stakeRoom(bean, null), null);
  // margin = notional / min(bean, venue) leverage: 2203.4 / 25 per $1000 → above the $100 stake
  assert.ok(Math.abs(G.entryMargin(bean, 100) - (0.2 * 50 * 2203.4 * 0.1) / 25) < 1e-9);
  assert.ok(G.entryMargin({ position_size: 0.5, leverage: 10, equity: 1000 }, 100) <= 100);
  assert.equal(G.dirKey('Open Long'), 'dir.openLong');
  assert.equal(G.dirKey('Close Short'), 'dir.closeShort');
  assert.equal(G.dirKey('Liquidate'), null);
});

test('garden: plot slots ≥ 8, closed bots excluded', () => {
  assert.equal(G.plotSlots([]).length, 8);
  const many = Array.from({ length: 11 }, (_, i) => ({ id: 'bot-' + i, state: i === 3 ? 'closed' : 'active' }));
  const slots = G.plotSlots(many);
  assert.equal(slots.length, 10);
  assert.ok(slots.every(Boolean));
  assert.equal(G.familyOf('swarm_25x'), 'swarm');
  assert.equal(G.familyOf('degen_algo'), 'degen');
});

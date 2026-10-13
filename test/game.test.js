// test/game.test.js — WP2 frontend core (GAME-DESIGN §11.4): pure view/rules/director/model/data/settings plus the
// three-free gfx helpers (tween, tiers, camera maths, labels projection, loop modes). Node only: no GPU, no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const WEB = new URL('../web/js/', import.meta.url);
const imp = (f) => import(new URL(f, WEB).href);
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const model = await imp('model.js');
const garden = await imp('garden.js');
const plant = await imp('plant.js');
const view = await imp('game/core/view.js');
const rules = await imp('game/core/rules.js');
const director = await imp('game/fx/director.js');
const settingsMod = await imp('game/core/settings.js');
const storeMod = await imp('game/core/store.js');
const busMod = await imp('game/core/bus.js');
const data = await imp('game/core/data.js');
const tween = await imp('game/gfx/tween.js');
const tiers = await imp('game/gfx/tiers.js');
const camera = await imp('game/gfx/camera.js');
const labels = await imp('game/gfx/labels.js');
const loopMod = await imp('game/gfx/loop.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (±${eps})`);

// ------------------------------------------------------------------ fixtures

const BOT = Object.freeze({
  id: 'bot-0003', index: 3, bean: 612, coin: 'BTC', capital_usd: 100, leverage: 10, state: 'active', bean_side: 1,
  sz_decimals: 5, fills: 2, fees: 0.37, realized_pnl: 0.25, mark_px: 82900, mark_ms: 1000, last_error: null, note: null,
  updated_ms: 1000,
  real: Object.freeze({ szi: 0.005, entry_px: 82410, unrealized_pnl: 2.45, margin_used: 44.06, liquidation_px: 74581.05, leverage: 10, as_of_ms: 1000 }),
});

const MARK = Object.freeze({
  szi: 0.005, entry_px: 82410, mark_px: 82980.5, unrealized_pnl: 2.85, realized_pnl: 0.25, margin_used: 44.06,
  liquidation_px: 74581.05, notional_usd: 414.9, price_stale: false, as_of_ms: 2000,
});

const growthOf = (o) => ({ size: o.size, health: o.health, fruit: o.fruit, flower: o.flower, seed: o.seed, caption: o.caption });

// ------------------------------------------------------------------ model.js (§9.2)

test('model: garden.js re-exports the moved helpers unchanged (same functions)', () => {
  for (const name of ['WATER', 'shelfQuery', 'weatherOf', 'mirrorNote', 'stakeRoom', 'entryMargin', 'dirKey', 'familyOf']) {
    assert.equal(garden[name], model[name], name);
  }
});

test('model: fmtPx / fmtSz table (§9.2)', () => {
  assert.equal(model.fmtPx(82980.5, 5), '$82,980.5');
  assert.equal(model.fmtPx(2509.354, 4), '$2,509.35');
  assert.equal(model.fmtPx(110.4251, 2), '$110.425');
  assert.equal(model.fmtPx(0.1812346, 0), '$0.181235');
  assert.equal(model.fmtPx(0.0061234, 0), '$0.006123');
  assert.equal(model.fmtPx(NaN, 2), '—');
  assert.equal(model.fmtPx(null, 2), '—');
  assert.equal(model.fmtSz(0.005, 5), '0.00500');
  assert.equal(model.fmtSz(-3.5, 2), '3.50');
  assert.equal(model.fmtSz(12, 0), '12');
  assert.equal(model.fmtSz(undefined, 2), '—');
});

test('model: plantQuote — 10× liquidates on a 9.5% move, worst case = margin, fees both ways', () => {
  const bean = { position_size: 0.5, leverage: 10, equity: 1000, venue_max_leverage: 40 };
  const live = { caps: { max_total_notional_usd: 50000 }, open_notional_usd: 1000, available_usd: 9000 };
  const q = model.plantQuote(bean, 100, live);
  near(q.notional, 500); // 0.5 × 10 × 1000 × 0.1
  assert.equal(q.lev, 10);
  near(q.margin, 50);
  near(q.liqMovePct, 0.095);
  near(q.fees, 500 * (0.00045 + 0.00015) * 2);
  assert.equal(q.worst, q.margin);
  assert.equal(q.exceedsWater, false);
  assert.ok(q.room && q.room.maxStake > 0);
  // venue cap below the bean's leverage
  const capped = model.plantQuote({ ...bean, leverage: 50, venue_max_leverage: 20 }, 100, live);
  assert.equal(capped.lev, 20);
  near(capped.liqMovePct, 0.0475);
  // a grown bean: margin above the water → the "can exceed water" note
  const big = model.plantQuote({ position_size: 1, leverage: 1, equity: 3000 }, 100, live);
  assert.equal(big.exceedsWater, true);
  // A POSITIONED bean is mirrored at once from its existing units (sized at the bean's entry equity), so the
  // quote is |units| × stake/1000 × live px — not the next-entry size at today's equity (server create rule).
  const held = { position_size: 0.5, leverage: 25, equity: 1543, side: -1, units: -7.17, venue_max_leverage: 25 };
  const qNow = model.plantQuote(held, 100, live, 2988.48);
  assert.equal(qNow.basis, 'now');
  near(qNow.notional, 7.17 * 0.1 * 2988.48);
  near(qNow.perEntry, 0.5 * 25 * 1543 * 0.1);
  near(qNow.margin, qNow.notional / 25);
  near(qNow.fees, qNow.notional * (0.00045 + 0.00015) * 2);
  assert.equal(qNow.worst, qNow.margin);
  // room uses the same per-dollar figure: (cap − open) / (|units| × px / 1000)
  const roomLive = { ...live, open_notional_usd: 49_000, available_usd: 9000 };
  assert.equal(model.plantQuote(held, 100, roomLive, 2988.48).room.maxStake, Math.floor(1000 / (7.17 * 2988.48 / 1000) / 10) * 10);
  // no price (or a flat bean) → the per-entry quote, as before
  assert.equal(model.plantQuote(held, 100, live).basis, 'entry');
  assert.equal(model.plantQuote({ ...held, side: 0, units: 0 }, 100, live, 2988.48).basis, 'entry');
  assert.equal(model.stakeRoom(held, live).maxStake, model.stakeRoom(held, live, undefined).maxStake, 'classic: unchanged without a price');
});

test('model: closeQuote = realized + unrealized − |szi|·mark·(fee + slip) (≈)', () => {
  const q = model.closeQuote({ ...BOT, real: { ...BOT.real, unrealized_pnl: 2.85 } }, 82980.5);
  const notional = 0.005 * 82980.5;
  near(q.notional, notional);
  near(q.fee, notional * 0.00045);
  near(q.slip, notional * 0.00015);
  near(q.estTotal, 0.25 + 2.85 - notional * 0.0006);
  near(q.pct, q.estTotal / 100);
  const flat = model.closeQuote({ ...BOT, real: { ...BOT.real, szi: 0, unrealized_pnl: 0 } }, 82980.5);
  near(flat.estTotal, 0.25);
});

test('model: windOf from mean |change_1h| (calm/breezy/windy/gale) and weatherOf unchanged', () => {
  assert.equal(model.windOf([]), null);
  assert.equal(model.windOf([{ change_1h: 0.001 }, { change_1h: -0.002 }]).key, 'calm');
  assert.equal(model.windOf([{ change_1h: -0.005 }]).key, 'breezy');
  assert.equal(model.windOf([{ change_1h: 0.01 }]).factor, 1.6);
  assert.equal(model.windOf([{ change_1h: -0.02 }]).key, 'gale');
  assert.equal(model.weatherOf([{ change_24h: 0.02 }]).key, 'sunny');
});

// ------------------------------------------------------------------ view.js (§9.3)

test('view: a testnet bot shows the TESTNET listing cap, never the mainnet one', () => {
  const bean = { leverage: 25, venue_max_leverage: 5 }; // mainnet TIA caps at 5×
  const tn = { ...BOT, venue: 'testnet', leverage: 10, venue_max_leverage: 10 }; // testnet TIA allows 10×
  assert.equal(view.plotView(tn, 0, { nowMs: 5000, bean }).venueMaxLev, 10);
  assert.equal(view.plotView({ ...tn, venue_max_leverage: null }, 0, { nowMs: 5000, bean }).venueMaxLev, null, 'unknown → no cap shown');
  assert.equal(view.plotView(BOT, 0, { nowMs: 5000, bean }).venueMaxLev, 5, 'paper keeps the mainnet cap');
});

test('view: plotView growth equals plant.stage() of the same bot (parity)', () => {
  const v = view.plotView(BOT, 0, { nowMs: 5000 });
  assert.deepEqual(growthOf(v), growthOf(plant.stage(BOT)));
  assert.equal(v.state, 'growing');
  assert.equal(v.side, 1);
  assert.equal(v.crop, 'BTC');
  assert.equal(v.water, 100);
  near(v.usd, 2.7);
  near(v.pct, 2.7);
  // a losing short and a waiting seed keep parity too
  const short = { ...BOT, realized_pnl: -6, real: { ...BOT.real, szi: -1, unrealized_pnl: -30 } };
  assert.deepEqual(growthOf(view.plotView(short, 1, { nowMs: 5000 })), growthOf(plant.stage(short)));
  const seed = { ...BOT, bean_side: 0, realized_pnl: 0, real: { ...BOT.real, szi: 0, unrealized_pnl: 0, entry_px: null } };
  const sv = view.plotView(seed, 2, { nowMs: 5000 });
  assert.equal(sv.state, 'waiting');
  assert.deepEqual(growthOf(sv), growthOf(plant.stage(seed)));
});

test('view: newer server marks replace the row; older marks are ignored; parity holds on the merged bot', () => {
  const marks = { t: 2000, px: { BTC: 82980.5 }, stale: [], bots: { 'bot-0003': MARK } };
  const v = view.plotView(BOT, 0, { marks, nowMs: 2500 });
  assert.equal(v.unrealized, 2.85);
  assert.equal(v.mark, 82980.5);
  assert.equal(v.est, false);
  assert.equal(v.ageTag, 'fresh');
  const merged = { ...BOT, realized_pnl: 0.25, real: { ...BOT.real, unrealized_pnl: 2.85 } };
  assert.deepEqual(growthOf(v), growthOf(plant.stage(merged)));

  const old = { t: 500, px: { BTC: 1 }, stale: [], bots: { 'bot-0003': { ...MARK, as_of_ms: 500, unrealized_pnl: 99 } } };
  const v2 = view.plotView(BOT, 0, { marks: old, nowMs: 2500 });
  assert.equal(v2.unrealized, 2.45);
  assert.equal(v2.mark, 82900);
  assert.equal(v2.est, false);
});

test('view: the ≈ path — only a newer raw price: unrealized ≈ szi·(px − entry), flagged est', () => {
  const marks = { t: 3000, px: { BTC: 83410 }, stale: [], bots: {} };
  const v = view.plotView(BOT, 0, { marks, nowMs: 3500 });
  near(v.unrealized, 0.005 * (83410 - 82410));
  assert.equal(v.est, true);
  assert.equal(v.mark, 83410);
  // a stale coin is never estimated, and its plot is frozen
  const stale = view.plotView(BOT, 0, { marks: { ...marks, stale: ['BTC'] }, nowMs: 3500 });
  assert.equal(stale.est, false);
  assert.equal(stale.frozen, true);
  // a position whose mark is older than 60 s is frozen as well (server-relative: nowMs + skewMs)
  const late = view.plotView(BOT, 0, { nowMs: 1000 + 30_000, skewMs: 31_000 });
  assert.equal(late.ageTag, 'stale');
  assert.equal(late.frozen, true);
});

test('view: liqInfo vectors (§9.3/§11.4): 10× long from 82,410.0 → liq 74,581.05, 10.12% at 82,980.5', () => {
  near(view.liqPrice(82410, 10, 1), 74581.05, 1e-6);
  near(1 - view.liqPrice(82410, 10, 1) / 82410, 0.095); // 10× → 9.5% from entry
  const li = view.liqInfo({ szi: 0.005, mark: 82980.5, entry: 82410, liq: 74581.05 });
  near(li.movePct, 0.10122, 1e-5);
  assert.equal(li.dir, 'fall');
  assert.equal(li.d, 1);
  assert.equal(li.band, 'ok');
  // short mirror (fixture bot-0004: entry 111, 5× → liq 132.09)
  near(view.liqPrice(111, 5, -1), 132.09, 1e-9);
  const s = view.liqInfo({ szi: -3.5, mark: 110.205, entry: 111, liq: 132.09 });
  assert.equal(s.dir, 'rise');
  near(s.movePct, (132.09 - 110.205) / 110.205, 1e-9);
  assert.equal(s.band, 'ok');
  assert.equal(view.liqInfo({ szi: -3.5, mark: 122, entry: 111, liq: 132.09 }).band, 'warn');
  assert.equal(view.liqInfo({ szi: -3.5, mark: 128, entry: 111, liq: 132.09 }).band, 'danger');
  assert.equal(view.liqInfo({ szi: 0, mark: 1, entry: 1, liq: 1 }), null);
  // crossed: no negative distance
  assert.equal(view.liqInfo({ szi: 1, mark: 70000, entry: 82410, liq: 74581.05 }).movePct, 0);
});

test('view: ageTag thresholds — ≤ 15 s fresh, ≤ 60 s delayed, else stale', () => {
  assert.equal(view.ageTag(0, 15_000), 'fresh');
  assert.equal(view.ageTag(0, 15_001), 'delayed');
  assert.equal(view.ageTag(0, 60_000), 'delayed');
  assert.equal(view.ageTag(0, 60_001), 'stale');
  assert.equal(view.ageTag(null, 1), 'stale');
});

test('view: feedBadge truth table (§6.3)', () => {
  const status = fixture('status-real.json');
  const now = status.now_ms;
  const fresh = { t: now - 2000, stale: [] };
  assert.equal(view.feedBadge({ status, marks: fresh, nowMs: now }).key, 'g.badge.real');
  assert.equal(view.feedBadge({ status, marks: fresh, nowMs: now }).tone, 'real');
  const partial = view.feedBadge({ status: { ...status, feed: { ...status.feed, stale_coins: ['SOL', 'DOGE', 'WIF'] } }, marks: fresh, nowMs: now });
  assert.equal(partial.key, 'g.badge.realPartial');
  assert.equal(partial.vars.n, 3);
  assert.equal(partial.tone, 'warn');
  assert.equal(view.feedBadge({ status: { ...status, feed: { ...status.feed, state: 'delayed' } }, marks: fresh, nowMs: now }).key, 'g.badge.delayed');
  const oldMarks = view.feedBadge({ status, marks: { t: now - 45_000, stale: [] }, nowMs: now });
  assert.equal(oldMarks.key, 'g.badge.delayed');
  assert.equal(oldMarks.vars.age, '45 s');
  // skew: client clock + skew = server clock
  assert.equal(view.feedBadge({ status, marks: fresh, nowMs: now - 40_000, skewMs: 40_000 }).key, 'g.badge.real');
  const down = view.feedBadge({ status: { ...status, feed: { ...status.feed, state: 'down' } }, nowMs: now });
  assert.equal(down.key, 'g.badge.down');
  assert.equal(down.tone, 'off');
  const sim = view.feedBadge({ status: { ...status, prices: 'sim', feed: { ...status.feed, source: 'sim', real: false, state: 'sim' } }, nowMs: now });
  assert.equal(sim.key, 'g.badge.sim');
  assert.equal(sim.tone, 'sim');
  // offline wins over everything, even sim
  const off = view.feedBadge({ status: { ...status, feed: { ...status.feed, real: false, state: 'sim' } }, net: { ok: false, lastOkMs: now - 60_000 }, nowMs: now });
  assert.equal(off.key, 'g.badge.offline');
  assert.equal(off.tone, 'off');
  // a pre-real-feed backend (feed is just a source string) still gets a truthful badge
  assert.equal(view.feedBadge({ status: { feed: { source: 'sim', ok: true } }, nowMs: now }).key, 'g.badge.sim');
});

test('view: assignSlots is stable across closes and reloads; wanted slots win when free', () => {
  const b = (id, bean) => ({ id, bean, state: 'active' });
  const first = view.assignSlots([b('A', 1), b('B', 2), b('C', 3)], {}, { slotCount: 10 });
  assert.deepEqual(first.map, { A: 0, B: 1, C: 2 });
  // B closes: A and C keep their plots; a new bot takes the lowest free one
  const second = view.assignSlots([b('A', 1), b('C', 3), b('D', 4)], first.map, { slotCount: 10 });
  assert.deepEqual(second.map, { A: 0, C: 2, D: 1 });
  // reload: the persisted map gives the same answer regardless of server order
  const reload = view.assignSlots([b('D', 4), b('C', 3), b('A', 1)], second.map, { slotCount: 10 });
  assert.deepEqual(reload.map, second.map);
  // the plant dialog asked for plot 05 (slot 4)
  const wanted = view.assignSlots([b('A', 1), b('C', 3), b('D', 4), b('E', 5)], second.map, { slotCount: 10, wanted: { 5: 4 } });
  assert.equal(wanted.map.E, 4);
  // wanted slot already taken → lowest free
  const taken = view.assignSlots([b('A', 1), b('F', 6)], { A: 0 }, { slotCount: 10, wanted: { 6: 0 } });
  assert.equal(taken.map.F, 1);
  // more open bots than drawn plots → hidden
  const many = Array.from({ length: 12 }, (_, i) => b(`X${i}`, i));
  const out = view.assignSlots(many, {}, { slotCount: 10 });
  assert.deepEqual(out.hidden, ['X10', 'X11']);
  // closed bots never hold a slot
  assert.deepEqual(view.assignSlots([{ id: 'Z', bean: 9, state: 'closed' }], { Z: 0 }, { slotCount: 10 }).map, {});
});

test('view: slotCountOf clamps to 10..15; moneyView prefers newer marks; closedTotals; sceneSummary; viewsOf', () => {
  assert.equal(view.slotCountOf({ caps: { max_bots: 10 } }, []), 10);
  assert.equal(view.slotCountOf({ caps: { max_bots: 12 } }, []), 12);
  assert.equal(view.slotCountOf({ caps: { max_bots: 30 } }, []), 15);
  assert.equal(view.slotCountOf(null, new Array(13)), 13);

  const live = { account_usd: 10000, available_usd: 9400, deployed_usd: 600, open_notional_usd: 2000, realized_pnl: -4, unrealized_pnl: 30, active: 5, paused: 1, caps: { max_bots: 10, max_total_notional_usd: 50000 }, account_state: { account_value: 10026, as_of_ms: 1000 } };
  const m1 = view.moneyView(live, null);
  assert.equal(m1.barn, 10026);
  near(m1.vsStartPct, 0.0026);
  assert.equal(m1.plants, 6);
  assert.equal(m1.room, 48000);
  near(m1.fills.silo, 10026 / 20000);
  const marks = { t: 2000, account: { account_value: 10030, unrealized_pnl: 34, available_usd: 9400, deployed_usd: 600, realized_pnl: -4 } };
  const m2 = view.moneyView(live, marks);
  assert.equal(m2.barn, 10030);
  assert.equal(m2.growing, 34);
  assert.equal(m2.ages.source, 'marks');
  assert.equal(view.moneyView(live, { ...marks, t: 500 }).barn, 10026);
  // The money age is the age of the PRICES: an old marks frame caps a newer live_status (open positions), and
  // a positioned bot's older mark caps the marks frame — a fetch never makes 4-minute-old marks look fresh.
  const oldMarks = { t: 500, account: marks.account };
  const freshLive = { ...live, account_state: { ...live.account_state, as_of_ms: 240_500 } };
  assert.equal(view.moneyView(freshLive, oldMarks).ages.source, 'live');
  assert.equal(view.moneyView(freshLive, oldMarks).ages.ms, 500);
  assert.equal(view.moneyView({ ...freshLive, open_notional_usd: 0 }, oldMarks).ages.ms, 240_500, 'no position: nothing is marked');
  const botsMarks = { ...marks, bots: { a: { szi: 1, as_of_ms: 1500 }, b: { szi: 0, as_of_ms: 100 } } };
  assert.equal(view.moneyView(live, botsMarks).ages.ms, 1500);
  assert.equal(m2.ages.ms, 2000);

  const totals = view.closedTotals([{ state: 'closed', realized_pnl: 3 }, { state: 'closed', realized_pnl: 0 }, { state: 'closed', realized_pnl: -2 }, { state: 'active', realized_pnl: 9 }]);
  assert.deepEqual(totals, { crates: { n: 2, usd: 3 }, compost: { n: 1, usd: -2 } });

  assert.equal(view.sceneSummary({}).key, 'g.a11y.sceneEmpty');
  assert.deepEqual(view.sceneSummary({ 0: { botId: 'a', usd: 1 }, 1: { botId: 'b', usd: -1 }, 2: { botId: 'c', usd: 0 } }).vars, { n: 3, up: 1, down: 1 });

  const state = { bots: [BOT, { ...BOT, id: 'gone', state: 'closed' }, { ...BOT, id: 'nos' }], slots: { map: { 'bot-0003': 4 } }, net: { skewMs: 0 } };
  const vs = view.viewsOf(state, 5000);
  assert.deepEqual(Object.keys(vs), ['4']);
  assert.equal(vs[4].botId, 'bot-0003');
});

// ------------------------------------------------------------------ rules.js (§9.4)

test('rules: coinBurst buckets and levTier', () => {
  const cb = [[0, 0], [-5, 0], [0.5, 1], [0.99, 1], [1, 3], [9.99, 3], [10, 6], [49.99, 6], [50, 9], [199.99, 9], [200, 12], [5000, 12]];
  for (const [usd, n] of cb) assert.equal(rules.coinBurst(usd), n, `coinBurst(${usd})`);
  // a "gain" that shows as $0.00 is a basket with no coin; a loss that shows as $0.00 is no pull (J4)
  assert.equal(rules.coinBurst(0.004), 0);
  assert.equal(rules.coinBurst(0.005), 1);
  assert.equal(rules.closeRecipe(-0.004), 'harvest');
  assert.equal(rules.closeRecipe(-0.006), 'pull');
  const lt = [[1, 0], [0.5, 0], [2, 1], [5, 1], [6, 2], [10, 2], [11, 3], [25, 3], [26, 4], [50, 4], [51, 5], [100, 5]];
  for (const [lev, n] of lt) assert.equal(rules.levTier(lev), n, `levTier(${lev})`);
});

test('rules: closeRecipe, isReplayed (with skew), gust, moneyTone', () => {
  assert.equal(rules.closeRecipe(0), 'harvest');
  assert.equal(rules.closeRecipe(-0.01), 'pull');
  assert.equal(rules.isReplayed({ time_ms: 100_000 }, 221_000, 0), true);
  assert.equal(rules.isReplayed({ time_ms: 100_000 }, 219_000, 0), false);
  assert.equal(rules.isReplayed({ time_ms: 100_000 }, 200_000, 21_000), true);
  assert.equal(rules.isReplayed({}, 1e12, 0), false);
  assert.deepEqual(rules.gust({ BTC: 100, SOL: 10 }, { BTC: 100.2, SOL: 10.05 }), { coin: 'SOL', pct: 10.05 / 10 - 1 });
  assert.equal(rules.gust({ BTC: 100 }, { BTC: 100.2 }), null);
  assert.equal(rules.moneyTone(0), 'neutral');
  assert.equal(rules.moneyTone(-1), 'down');
});

test('rules: assertEffect enforces J4 / J5 / J6 / J11', () => {
  assert.doesNotThrow(() => rules.assertEffect({ kind: 'harvest', usd: 12.4, n: 6, tone: 'up' }));
  assert.doesNotThrow(() => rules.assertEffect({ kind: 'pull', usd: -8.2, n: 0, tone: 'down' }));
  assert.throws(() => rules.assertEffect({ kind: 'harvest', usd: -1, n: 0 }), /J4/);
  assert.throws(() => rules.assertEffect({ kind: 'harvest', usd: 12.4, n: 3 }), /J4/);
  assert.throws(() => rules.assertEffect({ kind: 'pull', usd: -8, n: 2 }), /J4/);
  assert.throws(() => rules.assertEffect({ kind: 'pull', usd: -8, n: 0, meta: { sparkle: true } }), /J4/);
  assert.throws(() => rules.assertEffect({ kind: 'label', usd: 5, meta: { countUp: true } }), /J5/);
  assert.throws(() => rules.assertEffect({ kind: 'fill', usd: -3, tone: 'up' }), /J6/);
  assert.throws(() => rules.assertEffect({ kind: 'harvest', usd: 1, n: 3, meta: { source: 'mids' } }), /J11/);
  assert.doesNotThrow(() => rules.assertEffect({ kind: 'fruitGain', n: 0, meta: { source: 'mids' } }));
  assert.throws(() => rules.assertEffect({ kind: 'confetti' }), /unknown effect kind/);
});

// ------------------------------------------------------------------ director (§9.5)

const growingView = (slot, over = {}) => ({ slot, botId: `bot-${slot}`, coin: 'BTC', state: 'growing', fruit: 0, ripe: false, caption: null, frozen: false, liqInfo: null, usd: 1, ...over });

test('director: a loss is a pull with 0 coins; a gain a harvest with coinBurst coins; zero = basket only', () => {
  const views = { 0: growingView(0) };
  const loss = director.direct(views, views, { type: 'closed', slot: 0, bot: 'b0', realized_pnl: -8.2 }, {});
  assert.equal(loss.length, 1);
  assert.equal(loss[0].kind, 'pull');
  assert.equal(loss[0].n, 0);
  assert.equal(loss[0].tone, 'down');
  assert.ok(!loss[0].meta?.sparkle && !loss[0].meta?.chime);
  const gain = director.direct(views, views, { type: 'closed', slot: 0, bot: 'b0', realized_pnl: 12.4 }, {});
  assert.equal(gain[0].kind, 'harvest');
  assert.equal(gain[0].n, rules.coinBurst(12.4));
  const zero = director.direct(views, views, { type: 'closed', slot: 0, bot: 'b0', realized_pnl: 0 }, {});
  assert.equal(zero[0].kind, 'harvest');
  assert.equal(zero[0].n, 0);
  for (const e of [...loss, ...gain, ...zero]) rules.assertEffect(e);
});

test('director: no plantOk before a 2xx or the bot_created echo (J3); it plays once', () => {
  let t = 10_000;
  const d = director.createDirector({ now: () => t });
  const v = {};
  const pending = d.run(v, v, { type: 'cmd', phase: 'pending', op: 'bot_create', key: 'k1', slot: 3, bean: 7 });
  assert.deepEqual(pending.map((e) => e.kind), ['pending']);
  assert.equal(pending[0].slot, 3);
  const failed = d.run(v, v, { type: 'cmd', phase: 'done', op: 'bot_create', key: 'k1', slot: 3, ok: false, body: { error: 'over the cap', status: 409 } });
  assert.ok(!failed.some((e) => e.kind === 'plantOk'));
  assert.ok(failed.some((e) => e.kind === 'plantFail'));
  // echo first, then the 2xx: plantOk + water exactly once
  t += 1000;
  const echo = d.run(v, v, { type: 'created', slot: 3, bot: 'bot-9', bean: 7, coin: 'SOL', capital_usd: 100 });
  assert.deepEqual(echo.map((e) => e.kind), ['plantOk', 'water']);
  const ok = d.run(v, v, { type: 'cmd', phase: 'done', op: 'bot_create', key: 'k2', slot: 3, ok: true, body: { id: 'bot-9', coin: 'SOL', capital_usd: 100 } }, { streamLive: true });
  assert.ok(!ok.some((e) => e.kind === 'plantOk' || e.kind === 'water'));
  // no stream: the 2xx alone plants AND waters
  const d2 = director.createDirector({ now: () => t });
  const ok2 = d2.run(v, v, { type: 'cmd', phase: 'done', op: 'bot_create', key: 'k3', slot: 1, ok: true, body: { id: 'bot-10', coin: 'BTC', capital_usd: 50 } }, { streamLive: false });
  assert.deepEqual(ok2.map((e) => e.kind), ['pending', 'plantOk', 'water']);
});

test('director: fills within 400 ms coalesce; Close X then Open Y within 400 ms is a flip', () => {
  let t = 0;
  const d = director.createDirector({ now: () => t });
  const v = { 0: growingView(0), 1: growingView(1) };
  const f = (slot, ms, dir, extra = {}) => ({ type: 'fill', slot, bot: `bot-${slot}`, coin: 'BTC', dir, sz: 0.005, px: 82000, fee: 0.2, ms, ...extra });
  t = 1000;
  assert.equal(d.run(v, v, f(0, 1000, 'Open Long'))[0].kind, 'fill');
  t = 1300;
  const merged = d.run(v, v, f(0, 1300, 'Open Long'));
  assert.equal(merged[0].kind, 'fillMerged');
  assert.equal(merged[0].n, 2);
  t = 2000;
  assert.equal(d.run(v, v, f(0, 2000, 'Open Long'))[0].kind, 'fill');
  // flip on plot 2: close long (net +1.80) then open short 200 ms later
  t = 5000;
  const close = d.run(v, v, f(1, 5000, 'Close Long', { closed_pnl: 2 }));
  assert.equal(close[0].kind, 'fill');
  near(close[0].usd, 1.8);
  assert.equal(close[0].tone, 'up');
  t = 5200;
  const flip = d.run(v, v, f(1, 5200, 'Open Short'));
  assert.equal(flip[0].kind, 'flip');
  assert.equal(flip[0].meta.from, 'Close Long');
  assert.equal(flip[0].meta.to, 'Open Short');
});

test('director: replayed fills (older than 120 s) and burn-absorbed fills get no effects', () => {
  const v = { 0: growingView(0) };
  const now = 1_000_000;
  assert.deepEqual(director.direct(v, v, { type: 'fill', slot: 0, dir: 'Open Long', time_ms: now - 121_000, ms: now }, { nowMs: now }), []);
  assert.equal(director.direct(v, v, { type: 'fill', slot: 0, dir: 'Open Long', time_ms: now - 60_000, ms: now }, { nowMs: now })[0].kind, 'fill');
  // the server clock is 200 s ahead: a fill stamped 100 s before CLIENT now is a replay
  assert.deepEqual(director.direct(v, v, { type: 'fill', slot: 0, dir: 'Open Long', time_ms: now - 100_000, ms: now }, { nowMs: now, skewMs: 200_000 }), []);
  assert.deepEqual(director.direct(v, v, { type: 'fill', slot: 0, dir: 'Close Long', burn: true, ms: now }, { nowMs: now }), []);
  assert.deepEqual(director.direct(v, v, { type: 'closed', slot: 0, realized_pnl: 3, burn: true }, { nowMs: now }), []);
  // sim: time_ms is MARKET time (a day behind after a day off) — the journal's wall time decides instead
  const simFill = { type: 'fill', slot: 0, dir: 'Open Long', time_ms: now - 79_328_000, rec_t: now - 50, ms: now };
  assert.equal(director.direct(v, v, simFill, { nowMs: now, prices: 'sim' })[0].kind, 'fill', 'a fresh sim fill animates');
  assert.deepEqual(director.direct(v, v, { ...simFill, rec_t: now - 130_000 }, { nowMs: now, prices: 'sim' }), [], 'an old journal record (reconnect replay) does not');
  // the server flags outcomes made while catching up missed minutes: applied, never animated
  assert.deepEqual(director.direct(v, v, { type: 'fill', slot: 0, dir: 'Open Long', time_ms: now - 30_000, replay: true, ms: now }, { nowMs: now }), []);
  assert.deepEqual(director.direct(v, v, { type: 'paused', slot: 0, bot: 'b0', reason: 'liquidated', replay: true }, { nowMs: now }), []);
});

test('director: one realized number per close; an opening fill without a view keeps its size decimals', () => {
  const v = { 0: growingView(0) };
  const now = 1_000_000;
  const close = { type: 'fill', slot: 0, bot: 'b0', dir: 'Close Long', sz: 0.01, px: 82_980.5, fee: 0.37, closed_pnl: 1.22, time_ms: now, ms: now };
  // a harvest/pull in flight: its closing leg gets no second floater (the pull/harvest effect states the outcome)
  assert.deepEqual(director.direct(v, v, close, { nowMs: now, pending: { k: { op: 'bot_close', bot: 'b0' } } }), []);
  assert.deepEqual(director.direct(v, v, close, { nowMs: now, played: { 'close:b0': now - 100 } }), []);
  // an ordinary mirror close still shows its fill
  assert.equal(director.direct(v, v, close, { nowMs: now })[0].kind, 'fill');
  // a liquidation fill: the liquidate effect carries the loss
  assert.deepEqual(director.direct(v, v, { ...close, liquidation: true }, { nowMs: now }), []);
  // a new bot's opening fill arrives before its PlotView: decimals come from the coin listing, never 0
  const open = { type: 'fill', slot: 3, bot: 'b9', coin: 'ETH', dir: 'Open Short', sz: -0.3587, px: 2988.48, fee: 0.48, time_ms: now, ms: now, sz_decimals: 4 };
  const [e] = director.direct({}, {}, open, { nowMs: now });
  assert.equal(e.meta.szDecimals, 4);
  assert.equal(director.direct({}, {}, { ...open, sz_decimals: null }, { nowMs: now })[0].meta.szDecimals, null, 'unknown → null (raw size), not 0');
  // data.normalizeEvent attaches the listing's decimals
  const ev = data.normalizeEvent('bot_fill', { bot: 'b9', coin: 'ETH', dir: 'Open Short', sz: 0.3587, px: 2988.48, t: now }, { coins: { ETH: { coin: 'ETH', sz_decimals: 4 } } });
  assert.equal(ev.sz_decimals, 4);
  assert.equal(ev.rec_t, now);
});

test('director: burn resolves plot by plot in slot order, 250 ms apart, each with its own realized P&L', () => {
  const prev = { 1: growingView(1, { usd: 3 }), 4: growingView(4, { usd: -2 }), 6: growingView(6, { usd: 0.4 }) };
  const ev = {
    type: 'halted',
    closed: [
      { bot: 'bot-4', slot: 4, coin: 'SOL', realized_pnl: -2.1 },
      { bot: 'bot-1', slot: 1, coin: 'BTC', realized_pnl: 3.1 },
      { bot: 'bot-6', slot: 6, coin: 'ETH', realized_pnl: null }, // missed bot_closed → ≈ from its last view
    ],
  };
  const out = director.direct(prev, prev, ev, {});
  assert.deepEqual(out.map((e) => e.kind), ['burnStart', 'burnPlot', 'burnPlot', 'burnPlot', 'burnEnd']);
  const plots = out.filter((e) => e.kind === 'burnPlot');
  assert.deepEqual(plots.map((e) => e.slot), [1, 4, 6]);
  assert.deepEqual(plots.map((e) => e.meta.delayMs), [0, 250, 500]);
  assert.deepEqual(plots.map((e) => e.meta.recipe), ['harvest', 'pull', 'harvest']);
  near(plots[0].usd, 3.1);
  assert.equal(plots[0].n, rules.coinBurst(3.1));
  near(plots[1].usd, -2.1);
  assert.equal(plots[1].n, 0);
  assert.equal(plots[2].meta.est, true);
  assert.equal(out[out.length - 1].meta.delayMs, 750);
  for (const e of out) rules.assertEffect(e);
});

test('director: a fruit re-gained within 10 s of its loss pops quietly; marks alone never celebrate', () => {
  let t = 0;
  const d = director.createDirector({ now: () => t });
  const v = (fruit, over = {}) => ({ 0: growingView(0, { fruit, ...over }) });
  t = 1000;
  assert.deepEqual(d.run(v(2), v(1), null, { cause: 'mids' }).map((e) => [e.kind, e.n]), [['fruitLoss', 1]]);
  t = 5000;
  assert.deepEqual(d.run(v(1), v(2), null, { cause: 'mids' }).map((e) => [e.kind, e.n]), [['fruitGainQuiet', 1]]);
  t = 9000;
  d.run(v(2), v(1), null, { cause: 'mids' });
  t = 25_000;
  assert.deepEqual(d.run(v(1), v(2), null, { cause: 'mids' }).map((e) => [e.kind, e.n]), [['fruitGain', 1]]);
  // flip-flopping at a threshold (J11): a loss right after a gain fades quietly; a gain right after ANY loss
  // on the plot (another index) pops quietly
  assert.deepEqual(d.run(v(2), v(1), null, { cause: 'mids' }), [], 'loss 0 s after a gain: no drop effect');
  t = 31_000;
  assert.deepEqual(d.run(v(2), v(1), null, { cause: 'mids' }).map((e) => e.kind), ['fruitLoss']);
  t = 33_000;
  assert.deepEqual(d.run(v(2), v(4), null, { cause: 'mids' }).map((e) => e.kind), ['fruitGainQuiet', 'fruitGainQuiet']);
  t = 45_000;
  // a mark that only moves the springs (size/health) produces nothing (J11)
  assert.deepEqual(d.run(v(2, { size: 0.5, health: 0.9 }), v(2, { size: 0.52, health: 0.95 }), null, { cause: 'mids' }), []);
  // state crossings are allowed and tagged with their source
  const ripe = d.run(v(2), v(3, { ripe: true }), null, { cause: 'mids' });
  assert.deepEqual(ripe.map((e) => e.kind), ['fruitGain', 'ripeOn']);
  assert.ok(ripe.every((e) => e.meta.source === 'mids'));
  // a different bot appearing in the slot is applied as-is (no growth effects)
  assert.deepEqual(d.run(v(0), { 0: growingView(0, { botId: 'other', fruit: 3 }) }, null, {}), []);
});

test('director: an entry effect plays once per plot per 30 s — a plant flickering at a threshold does not re-sigh', () => {
  let t = 0;
  const d = director.createDirector({ now: () => t });
  const v = (caption, slot = 0) => ({ [slot]: growingView(slot, { caption }) });
  t = 1000;
  assert.deepEqual(d.run(v('growing'), v('wilting'), null, { cause: 'mids' }).map((e) => e.kind), ['wiltOn']);
  t = 6000; // back above 0.5 health, then down again on the next mark: no second sigh yet
  assert.deepEqual(d.run(v('growing'), v('wilting'), null, { cause: 'mids' }), []);
  // another plot is independent, and another kind too
  assert.deepEqual(d.run(v('growing', 1), v('wilting', 1), null, { cause: 'mids' }).map((e) => e.kind), ['wiltOn']);
  assert.deepEqual(d.run(v('wilting'), v('dying'), null, { cause: 'mids' }).map((e) => e.kind), ['dyingOn']);
  t = 1000 + rules.RULES.reentryMs + 1;
  assert.deepEqual(d.run(v('growing'), v('wilting'), null, { cause: 'mids' }).map((e) => e.kind), ['wiltOn']);
  // the pure reducer itself is unchanged: every crossing is reported (the throttle lives in the wrapper)
  assert.equal(director.direct(v('growing'), v('wilting'), null, {})[0].kind, 'wiltOn');
});

test('director: ticks, quiet time-lapse ticks, feed, gust and reduced-motion tagging', () => {
  assert.equal(director.direct({}, {}, { type: 'tick', tick: 5 }, {})[0].kind, 'tick');
  assert.deepEqual(director.direct({}, {}, { type: 'tick', tick: 6, quiet: true }, {}), []);
  assert.equal(director.direct({}, {}, { type: 'feed', state: 'down', prev: 'live' }, {})[0].kind, 'feedLook');
  assert.equal(director.direct({}, {}, { type: 'gust', coin: 'SOL', pct: 0.004 }, {})[0].kind, 'gust');
  const rm = director.direct({ 0: growingView(0) }, { 0: growingView(0) }, { type: 'closed', slot: 0, bot: 'x', realized_pnl: 2 }, { reduced: true });
  assert.equal(rm[0].kind, 'harvest');
  assert.equal(rm[0].meta.reduced, true);
  // liquidation carries the lost margin (the server number when the fill reported it)
  const liq = director.direct({ 0: growingView(0, { margin: 44.06 }) }, {}, { type: 'paused', slot: 0, bot: 'b', reason: 'liquidated', usd: -44.06 }, {});
  assert.equal(liq[0].kind, 'liquidate');
  near(liq[0].usd, -44.06);
  assert.equal(liq[0].meta.est, false);
});

// ------------------------------------------------------------------ settings (§6.9, §7.3)

test('settings: defaults with a throwing localStorage; reduced-motion resolution', () => {
  const throwing = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  const s = settingsMod.loadSettings({ storage: throwing });
  assert.deepEqual(s, settingsMod.defaultSettings());
  assert.equal(s.sound, false);
  assert.equal(s.volume, 0.6);
  assert.equal(s.graphics, 'auto');
  assert.equal(s.labels, 'always');
  assert.equal(settingsMod.defaultSettings({ coarse: true }).labels, 'hover');
  assert.equal(settingsMod.saveSettings(s, { storage: throwing }), false);
  assert.deepEqual(settingsMod.loadSettings({ storage: { getItem: () => '{not json' } }), settingsMod.defaultSettings());
  assert.equal(settingsMod.normalizeSettings({ graphics: 'ultra', volume: 7, sound: 'yes' }).graphics, 'auto');
  assert.equal(settingsMod.normalizeSettings({ volume: 7 }).volume, 1);
  assert.equal(settingsMod.isReduced({ motion: 'system' }, true), true);
  assert.equal(settingsMod.isReduced({ motion: 'full' }, true), false);
  assert.equal(settingsMod.isReduced({ motion: 'reduced' }, false), true);

  // the live controller works on blocked storage, follows the media query and mirrors into the store
  const store = storeMod.createStore(storeMod.initialState());
  const bus = busMod.createBus();
  let mqFn = null;
  const mq = { matches: false, addEventListener: (_, fn) => (mqFn = fn), removeEventListener() {} };
  const seen = [];
  bus.on('settings', (p) => seen.push(p));
  const ctl = settingsMod.createSettings({ store, bus, storage: throwing, matchMedia: () => mq, coarse: false });
  assert.equal(store.get().ui.reduced, false);
  mq.matches = true;
  mqFn();
  assert.equal(store.get().ui.reduced, true);
  ctl.set({ motion: 'full' });
  assert.equal(store.get().ui.reduced, false);
  assert.equal(store.get().settings.motion, 'full');
  assert.ok(seen.at(-1).changed.includes('motion'));
  ctl.dispose();
});

// ------------------------------------------------------------------ store + bus (§9.6)

test('store: select fires on change only; nested update; bus isolates throwing listeners', () => {
  const store = storeMod.createStore(storeMod.initialState());
  const calls = [];
  store.select((s) => s.ui.selectedSlot, (v, prev) => calls.push([v, prev]));
  store.update('ui', { selectedSlot: 3 });
  store.update('ui', { selectedSlot: 3 });
  store.update('ui', { panel: 'diary' });
  assert.deepEqual(calls, [[3, null]]);
  assert.equal(store.get().ui.panel, 'diary');
  const bus = busMod.createBus();
  const got = [];
  const origErr = console.error;
  console.error = () => {};
  try {
    bus.on('x', () => {
      throw new Error('boom');
    });
    bus.on('x', (p) => got.push(p));
    assert.equal(bus.emit('x', 1), 1);
  } finally {
    console.error = origErr;
  }
  assert.deepEqual(got, [1]);
  const off = bus.on('y', () => got.push('y'));
  off();
  bus.emit('y');
  assert.deepEqual(got, [1]);
});

// ------------------------------------------------------------------ data.js pure helpers

test('data: marksFromMids keeps server numbers, drops junk; pushHistory ring; skew from the request midpoint', () => {
  const mids = fixture('mids.json');
  const m = data.marksFromMids({ ...mids, px: { ...mids.px, BAD: 'x', NEG: -1 } }, 123);
  assert.equal(m.t, mids.t);
  assert.equal(m.receivedMs, 123);
  assert.equal(m.px.BTC, 83022.5);
  assert.ok(!('BAD' in m.px) && !('NEG' in m.px));
  assert.equal(m.bots['bot-0003'].unrealized_pnl, 3.0625);
  assert.equal(m.account.account_value, 10001.745);
  let h = {};
  for (let i = 0; i < 130; i++) h = data.pushHistory(h, { BTC: 100 + i }, 1000 + i, 120);
  assert.equal(h.BTC.length, 120);
  assert.deepEqual(h.BTC.at(-1), [1129, 229]);
  assert.equal(data.pushHistory(h, { BTC: 1 }, 1129).BTC.length, 120); // same pulse twice is ignored
  assert.equal(data.skewOf(10_500, 1000, 2000), 9000);
  assert.equal(data.skewOf(undefined, 1, 2), null);
  const est = data.marksFromMarket({ BTC: { coin: 'BTC', px: 83000, px_ms: 77 }, SOL: { coin: 'SOL', mid: 110, stale: true } }, 99);
  assert.deepEqual(est.px, { BTC: 83000, SOL: 110 });
  assert.equal(est.t, 77);
  assert.deepEqual(est.stale, ['SOL']);
  assert.deepEqual(est.bots, {});
});

test('data: normalizeEvent maps every SSE kind to a game event with its plot', () => {
  const ctx = { slots: { map: { b1: 2 }, wanted: { 42: 6 }, count: 10 }, bots: [{ id: 'b1', coin: 'SOL', bean: 9, state: 'active' }], shelf: [{ id: 77 }], receivedMs: 5, isOwn: (k, key) => k === 'bot_closed' && key === 'b1' };
  const fill = data.normalizeEvent('bot_fill', { bot: 'b1', dir: 'Close Long', sz: '0.5', px: 110, fee: 0.01, closed_pnl: 0.3, time_ms: 4 }, ctx);
  assert.equal(fill.type, 'fill');
  assert.equal(fill.slot, 2);
  assert.equal(fill.coin, 'SOL');
  assert.equal(fill.sz, 0.5);
  assert.equal(fill.ms, 5);
  const created = data.normalizeEvent('bot_created', { bot: 'b9', bean: 42, coin: 'BTC', capital_usd: 100 }, ctx);
  assert.equal(created.slot, 6); // the plant dialog's wanted plot
  assert.equal(data.normalizeEvent('bot_created', { bot: 'b8', bean: 5 }, ctx).slot, 0); // lowest free
  assert.equal(data.normalizeEvent('bot_order', { bot: 'b1', status: 'filled' }, ctx), null);
  assert.equal(data.normalizeEvent('bot_order', { bot: 'b1', status: 'skipped', reason: 'cap' }, ctx).type, 'orderSkipped');
  assert.equal(data.normalizeEvent('bot_paused', { bot: 'b1', reason: 'liquidated' }, ctx).reason, 'liquidated');
  const closed = data.normalizeEvent('bot_closed', { bot: 'b1', realized_pnl: -1.5 }, ctx);
  assert.equal(closed.own, true);
  assert.equal(closed.realized_pnl, -1.5);
  const halted = data.normalizeEvent('live_halted', { closed: ['b1', 'zz'] }, ctx);
  assert.deepEqual(halted.closed.map((c) => [c.bot, c.slot, c.coin]), [['b1', 2, 'SOL'], ['zz', null, null]]);
  assert.equal(data.normalizeEvent('tick_completed', { tick: 3, next_tick_ms: 9 }, { ...ctx, timelapse: true }).quiet, true);
  const bust = data.normalizeEvent('busted', { bean: 9, coin: 'SOL' }, ctx);
  assert.equal(bust.planted, true);
  assert.equal(bust.slot, 2);
  assert.equal(data.normalizeEvent('busted', { bean: 77 }, ctx).onShelf, true);
  assert.equal(data.normalizeEvent('feed_status', { state: 'down', prev: 'live', stale_coins: ['BTC'] }, ctx).type, 'feed');
  assert.equal(data.normalizeEvent('feed_gap', { bars: 12, mode: 'replay' }, ctx).bars, 12);
  assert.equal(data.normalizeEvent('warmup_finished', { bars: 2880 }, ctx).type, 'warmup');
  assert.equal(data.normalizeEvent('daemon_started', { version: '1' }, ctx).type, 'daemon');
  assert.equal(data.normalizeEvent('nope', {}, ctx), null);
});

test('data: own-echo memory and persisted slots survive blocked or corrupt storage', () => {
  let t = 0;
  const own = data.createOwn(() => t, 15_000);
  own.mark('bot_closed', 'b1');
  assert.equal(own.has('bot_closed', 'b1'), true);
  assert.equal(own.take('bot_closed', 'b1'), true);
  assert.equal(own.take('bot_closed', 'b1'), false);
  own.mark('bot_paused', 'b2');
  t = 16_000;
  assert.equal(own.take('bot_paused', 'b2'), false);
  assert.deepEqual(data.loadSlots({ getItem: () => '{bad' }), { map: {}, wanted: {} });
  assert.deepEqual(data.loadSlots({ getItem: () => JSON.stringify({ map: { a: 3, b: 99, c: -1, d: 'x' }, wanted: { 12: 4, x: 1 } }) }), { map: { a: 3 }, wanted: { 12: 4 } });
  assert.equal(data.saveSlots({ setItem() { throw new Error('quota'); } }, { map: {}, wanted: {} }), false);
});

// ------------------------------------------------------------------ data.js with a fake API (offline, fake clock)

function fakeTimers() {
  let t = 1_000_000;
  let id = 0;
  const q = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const i = ++id;
      q.set(i, { at: t + Math.max(0, ms), fn });
      return i;
    },
    clearTimeout(i) {
      q.delete(i);
    },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [i, x] of q) if (x.at <= end && (!next || x.at < next[1].at)) next = [i, x];
        if (!next) break;
        q.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

function fakeApi(over = {}) {
  const status = fixture('status-real.json');
  const market = fixture('market-real.json');
  const api = {
    EVENT_KINDS: ['tick_completed', 'bot_fill', 'bot_created', 'bot_closed', 'live_halted'],
    streamDisabled: () => false,
    calls: [],
    commands: [],
    bots: [{ ...BOT }],
    fail: null,
    commandReply: (op, params) => (op === 'bot_create' ? { id: 'bot-0099', bean: params.bean, coin: 'SOL', capital_usd: params.capital_usd } : { id: params.id, state: 'closed', realized_pnl: 1 }),
    async query(name, params) {
      api.calls.push(name);
      if (api.fail) throw api.fail;
      switch (name) {
        case 'health':
          return { ok: true, now_ms: status.now_ms, prices: 'real', feed: 'hyperliquid', feed_state: 'live', daemon: status.daemon };
        case 'status':
          return status;
        case 'meta':
          return { coins: [], archetypes: [] };
        case 'bots':
          return { rows: api.bots };
        case 'live_status':
          return { caps: { max_bots: 10, max_total_notional_usd: 50000 }, open_notional_usd: 0, available_usd: 9000, account_usd: 10000, halted: false, account_state: { account_value: 10000, as_of_ms: 1 } };
        case 'market':
          return market;
        case 'beans':
          return { rows: params?.ids ? params.ids.map((id) => ({ id, archetype: 'hyper_algo', strategy: 'momentum', leverage: 10 })) : [{ id: 77, coin: 'SOL' }] };
        case 'equity_curves':
          return { curves: { 77: [{ h: 0, equity: 1000 }] } };
        default:
          return {};
      }
    },
    async command(op, params) {
      api.commands.push([op, params]);
      return api.commandReply(op, params);
    },
    stream(onEvent, opts) {
      api.onEvent = onEvent;
      api.opts = opts;
      return { readyState: 1, close() {} };
    },
    ...over,
  };
  return api;
}

async function boot(over) {
  const timers = fakeTimers();
  const store = storeMod.createStore(storeMod.initialState());
  const bus = busMod.createBus();
  const api = fakeApi(over);
  const storage = memStorage();
  const events = [];
  for (const type of ['game:event', 'cmd:pending', 'cmd:done', 'data:marks']) bus.on(type, (p) => events.push([type, p]));
  const d = data.startData({ store, bus, api, now: timers.now, timers, storage, search: '' });
  await flush();
  return { timers, store, bus, api, storage, events, d };
}

test('data: boot loads status, bots, market and shelf; slots persist; skew comes from health.now_ms', async () => {
  const { store, api, storage, d } = await boot();
  const s = store.get();
  assert.equal(s.feed.prices, 'real');
  assert.equal(s.feed.state, 'live');
  assert.equal(s.bots.length, 1);
  assert.deepEqual(s.slots.map, { 'bot-0003': 0 });
  assert.equal(s.slots.count, 10);
  assert.equal(s.market.coins.BTC.px, 83022.5);
  assert.ok(s.market.weather && s.market.wind);
  assert.equal(s.shelf.rows[0].id, 77);
  assert.ok(s.shelf.curves[77]);
  assert.equal(s.beans[612].archetype, 'hyper_algo');
  assert.equal(s.net.ok, true);
  assert.ok(Number.isFinite(s.net.skewMs));
  assert.ok(JSON.parse(storage.m.get(data.SLOTS_KEY)).map['bot-0003'] === 0);
  assert.ok(api.opts.kinds.includes('mids') && api.opts.kinds.includes('feed_status') && api.opts.kinds.includes('feed_gap'));
  api.opts.onOpen();
  assert.equal(store.get().net.stream, 'live');
  d.stop();
});

test('data: command → cmd:pending then cmd:done; the plant slot sticks; failures clear the wanted slot', async () => {
  const { store, api, events, d } = await boot();
  const body = await d.command('bot_create', { bean: 612, capital_usd: 100 }, { slot: 4 });
  assert.equal(body.id, 'bot-0099');
  const cmds = events.filter(([type]) => type.startsWith('cmd:'));
  assert.deepEqual(cmds.map(([type]) => type), ['cmd:pending', 'cmd:done']);
  assert.equal(cmds[0][1].slot, 4);
  assert.equal(cmds[1][1].ok, true);
  assert.equal(store.get().slots.map['bot-0099'], 4);
  assert.deepEqual(store.get().ui.pending, {});

  api.commandReply = () => ({ error: 'over the notional cap', status: 409 });
  const bad = await d.command('bot_create', { bean: 700, capital_usd: 100 }, { slot: 7 });
  assert.equal(bad.status, 409);
  const done = events.filter(([type]) => type === 'cmd:done').at(-1)[1];
  assert.equal(done.ok, false);
  assert.equal(store.get().slots.wanted[700], undefined);
  d.stop();
});

test('data: unreachable API → OFFLINE with backoff 2 s → 4 s, recovery clears it', async () => {
  const { timers, store, api, d } = await boot();
  api.fail = Object.assign(new Error('fetch failed'), { status: 0 });
  await d.tend();
  assert.equal(store.get().net.ok, false);
  assert.equal(store.get().net.retryInMs, 2000);
  await timers.advance(2000);
  assert.equal(store.get().net.retryInMs, 4000);
  api.fail = null;
  await timers.advance(4000);
  assert.equal(store.get().net.ok, true);
  assert.equal(store.get().net.retryInMs, 0);
  // an HTTP error is not "offline"
  api.fail = Object.assign(new Error('boom'), { status: 500 });
  await d.tend();
  assert.equal(store.get().net.ok, true);
  assert.match(store.get().net.error, /boom/);
  d.stop();
});

test('data: closes followed by live_halted become one burn; a lone close is delivered after 150 ms', async () => {
  const { timers, api, events, d } = await boot();
  const ge = () => events.filter(([type]) => type === 'game:event').map(([, e]) => e);
  api.onEvent('bot_fill', { bot: 'bot-0003', coin: 'BTC', dir: 'Close Long', sz: 0.005, px: 83000, fee: 0.19, closed_pnl: 2.95 });
  api.onEvent('bot_closed', { bot: 'bot-0003', realized_pnl: 3.01 });
  assert.equal(ge().length, 0); // held
  api.onEvent('live_halted', { closed: ['bot-0003'] });
  const list = ge();
  assert.deepEqual(list.map((e) => e.type), ['fill', 'closed', 'halted']);
  assert.equal(list[0].burn, true);
  assert.equal(list[1].burn, true);
  assert.equal(list[2].closed[0].realized_pnl, 3.01);
  assert.equal(list[2].closed[0].slot, 0);
  // order is preserved behind a held close (flip detection needs it)
  api.onEvent('bot_fill', { bot: 'bot-0003', dir: 'Close Long', closed_pnl: 1, fee: 0.1 });
  api.onEvent('bot_fill', { bot: 'bot-0003', dir: 'Open Short' });
  assert.equal(ge().length, 3);
  await timers.advance(150);
  assert.deepEqual(ge().slice(3).map((e) => e.dir), ['Close Long', 'Open Short']);
  assert.ok(!ge()[3].burn);
  d.stop();
});

test('data: mids land in the store at t = 0, feed the price history, and gusts are rate-limited', async () => {
  const { timers, store, api, events, d } = await boot();
  const mids = fixture('mids.json');
  api.onEvent('mids', mids);
  assert.equal(store.get().marks.px.BTC, 83022.5);
  assert.equal(store.get().priceHistory.BTC.length >= 1, true);
  assert.equal(store.get().feed.nextTickMs, mids.bar.next_tick_ms);
  assert.ok(events.some(([type]) => type === 'data:marks'));
  api.onEvent('mids', { ...mids, t: mids.t + 5000, px: { ...mids.px, SOL: mids.px.SOL * 1.005 } });
  const gusts = () => events.filter(([type, e]) => type === 'game:event' && e.type === 'gust');
  assert.equal(gusts().length, 1);
  assert.equal(gusts()[0][1].coin, 'SOL');
  await timers.advance(5000);
  api.onEvent('mids', { ...mids, t: mids.t + 10_000, px: { ...mids.px, SOL: mids.px.SOL * 1.02 } });
  assert.equal(gusts().length, 1); // within 20 s of the last gust
  // the echo of our own close is flagged `own`
  await d.command('bot_close', { id: 'bot-0003' });
  api.onEvent('bot_closed', { bot: 'bot-0003', realized_pnl: 1 });
  await timers.advance(200);
  const closed = events.filter(([type, e]) => type === 'game:event' && e.type === 'closed').at(-1)[1];
  assert.equal(closed.own, true);
  d.stop();
});

test('data: a slow drift that adds up to > 1% over one bar is a gust at the bar close', async () => {
  const { api, events, d } = await boot();
  const mids = fixture('mids.json');
  const gusts = () => events.filter(([type, e]) => type === 'game:event' && e.type === 'gust').map(([, e]) => e);
  api.onEvent('mids', mids);
  api.onEvent('tick_completed', { tick: 1, next_tick_ms: 1 });
  let sol = mids.px.SOL;
  for (let i = 1; i <= 5; i++) {
    sol *= 1.0025; // 0.25% per mark: never a 5 s gust
    api.onEvent('mids', { ...mids, t: mids.t + i * 5000, px: { ...mids.px, SOL: sol } });
  }
  assert.equal(gusts().length, 0);
  api.onEvent('tick_completed', { tick: 2, next_tick_ms: 2 });
  await flush();
  assert.equal(gusts().length, 1);
  assert.equal(gusts()[0].coin, 'SOL');
  assert.equal(gusts()[0].source, 'bar');
  d.stop();
});

// ------------------------------------------------------------------ gfx helpers without a GPU

test('tween: easings hit their ends; tweens finish; reduced motion caps durations at 150 ms; springs', async () => {
  for (const [name, fn] of Object.entries(tween.ease)) {
    near(fn(0), 0, 1e-9);
    near(fn(1), 1, 1e-9);
    assert.ok(Number.isFinite(fn(0.5)), name);
  }
  assert.ok(tween.ease.oB(0.7) > 1); // overshoots
  const tw = tween.createTweens();
  const o = { y: 0 };
  let done = false;
  const h = tw.to(o, { y: 10 }, { duration: 400, ease: 'linear', onDone: () => (done = true) });
  tw.update(200);
  near(o.y, 5);
  tw.update(250);
  assert.equal(o.y, 10);
  assert.equal(done, true);
  assert.equal(await h.done, true);
  assert.equal(tw.active(), 0);
  tw.setMotionScale(0);
  const o2 = { x: 0 };
  tw.to(o2, { x: 1 }, { duration: 2000 });
  tw.update(150);
  assert.equal(o2.x, 1);
  tw.setMotionScale(1);
  const sp = tw.spring(0.25, { omega: 4 });
  sp.target = 1;
  for (let i = 0; i < 300; i++) tw.update(16);
  near(sp.value, 1, 1e-3);
  assert.equal(sp.atRest(), true);
  sp.target = 0.3;
  tw.setMotionScale(0);
  tw.update(16);
  assert.equal(sp.value, 0.3);
  // a keyed tween replaces the previous one; timelines fire in order
  tw.setMotionScale(1);
  const order = [];
  tw.timeline([[100, () => order.push('b')], [0, () => order.push('a')]]);
  const k1 = tw.to(o, { y: 0 }, { duration: 100, key: 'cam' });
  tw.to(o, { y: 20 }, { duration: 100, key: 'cam' });
  tw.update(100);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(await k1.done, false);
  assert.equal(o.y, 20);
});

test('tiers: auto tier, tier table, governor step order, and no step-down from throttled timers', () => {
  assert.equal(tiers.resolveTier('auto', {}), 'high');
  assert.equal(tiers.resolveTier('auto', { coarse: true }), 'medium');
  assert.equal(tiers.resolveTier('auto', { deviceMemory: 4 }), 'medium');
  assert.equal(tiers.resolveTier('auto', { software: true }), 'low');
  // an integrated / mobile GPU starts at Medium (High missed its budget on an Intel UHD iGPU)
  assert.equal(tiers.resolveTier('auto', { integrated: tiers.integratedGpu('ANGLE (Intel, Intel(R) UHD Graphics (0x00009A68) Direct3D11 vs_5_0 ps_5_0, D3D11)') }), 'medium');
  assert.equal(tiers.integratedGpu('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)'), false);
  assert.equal(tiers.resolveTier('high', { integrated: true }), 'high', 'an explicit setting wins');
  assert.equal(tiers.resolveTier('low', { software: false }), 'low');
  const high = tiers.qualityFor('high', { devicePixelRatio: 3 });
  assert.equal(high.dpr, 2);
  assert.equal(high.shadows, 'soft');
  assert.equal(high.post, true);
  assert.equal(tiers.qualityFor('high', { devicePixelRatio: 1 }).dpr, 1);
  assert.equal(tiers.qualityFor('medium', { coarse: true }).fps, 30);
  assert.equal(tiers.qualityFor('medium', { coarse: false }).fps, 60);
  near(tiers.budgetMs(high), 1000 / 60);

  // step order: DPR −0.25 → post off → shadows Medium → shadows off → grass halved → particles halved → Low
  let q = tiers.qualityFor('high', { devicePixelRatio: 2 });
  const steps = [];
  for (let s = tiers.stepDown(q); s; s = tiers.stepDown(q)) {
    steps.push(s.step);
    q = s.quality;
  }
  assert.deepEqual(steps, ['dpr', 'post', 'shadowsMedium', 'shadowsOff', 'grassHalf', 'particlesHalf', 'low']);
  assert.equal(q.tier, 'low');
  assert.equal(q.shadows, 'off');
  assert.equal(q.dpr, 1); // Low caps the DPR at 1.0
  assert.equal(tiers.applyStep(tiers.qualityFor('high', { devicePixelRatio: 2 }), 'dpr').dpr, 1.75);
  // on a 1× screen the DPR step is skipped
  assert.equal(tiers.stepDown(tiers.qualityFor('high', { devicePixelRatio: 1 })).step, 'post');

  const gov = tiers.createGovernor();
  let fired = 0;
  for (let t = 0; t < 4000; t += 30) if (gov.sample(30, t, 1000 / 60)) fired++;
  assert.equal(fired, 1); // 30 ms frames vs a 16.7 ms budget, then a 5 s wait
  const ok = tiers.createGovernor();
  for (let t = 0; t < 10_000; t += 17) assert.equal(ok.sample(17, t, 1000 / 60), false);
  const throttled = tiers.createGovernor();
  for (let t = 0; t < 20_000; t += 250) assert.equal(throttled.sample(250, t, 1000 / 60), false);
  const sparse = tiers.createGovernor();
  for (let t = 0; t < 20_000; t += 90) assert.equal(sparse.sample(t % 180 ? 25 : 300, t, 1000 / 60), false);
});

/** A PerspectiveCamera stand-in: just enough for the rig (no ray maths needed by these tests). */
function fakeCamera() {
  const I = () => ({ elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
  const cam = {
    fov: 50, aspect: 1, near: 0.1, far: 100, view: null,
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    looked: null,
    matrixWorld: I(), projectionMatrixInverse: I(), matrixWorldInverse: I(), projectionMatrix: I(),
    lookAt(x, y, z) { this.looked = { x, y, z }; },
    updateMatrixWorld() {},
    updateProjectionMatrix() {},
    setViewOffset(fw, fh, x, y, w, h) { this.view = { fw, fh, x, y, w, h }; },
    clearViewOffset() { this.view = null; },
  };
  return cam;
}

test('camera: coupled pitch, portrait fit distance, default 52°, safe-area offsets', () => {
  near(camera.pitchFor(16, 'landscape'), 40);
  near(camera.pitchFor(70, 'landscape'), 62);
  near(camera.pitchFor(16, 'landscape', 20), 48); // tilt clamps to +8°
  near(camera.fitDistance(24, 42, 390 / 844), 12 / (Math.tan((21 * Math.PI) / 180) * (390 / 844)));
  const def = camera.defaultState('landscape', 16 / 9);
  assert.equal(def.d, 50);
  near(camera.pitchFor(def.d, 'landscape', def.tilt), 52);
  assert.deepEqual({ x: def.tx, y: def.ty, z: def.tz }, { x: 0, y: 0.8, z: 1 });
  const port = camera.defaultState('portrait', 390 / 844);
  assert.ok(port.d >= 22 && port.d <= 90);
  assert.equal(camera.lensOf(0.79), 'portrait');
  assert.equal(camera.lensOf(0.8), 'landscape');
  assert.equal(camera.safeOffset(1600, 900, {}), null);
  assert.deepEqual(camera.safeOffset(1600, 900, { right: 380 }), { x: 190, y: 0 });
  assert.deepEqual(camera.safeOffset(1600, 900, { top: 100, bottom: 200 }), { x: 0, y: 50 });
  // oversized insets keep 40% of the canvas visible
  const big = camera.safeOffset(1000, 1000, { top: 1611 });
  near(big.y, -300); // top capped to 600 → centre at 800
  const p = camera.camPosition({ x: 0, y: 0, z: 0 }, 10, 0, 90);
  near(p.y, 10);
  near(p.z, 0, 1e-9);
  assert.deepEqual(camera.clampTarget({ x: 50, y: 0.8, z: -50 }), { x: 14, y: 0.8, z: -12 });
  // ray / ground-plane maths
  const hit = camera.rayPlaneY({ origin: { x: 0, y: 10, z: 0 }, dir: { x: 0, y: -1, z: 0 } }, 0.8);
  near(hit.y, 0.8);
  assert.equal(camera.rayPlaneY({ origin: { x: 0, y: 10, z: 0 }, dir: { x: 0, y: 0.2, z: 1 } }, 0), null);
});

test('camera rig: focus flies to d 18 / pitch 48°, back returns, yaw clamps, reduced motion cuts', async () => {
  let t = 0;
  const cam = fakeCamera();
  const rig = camera.createRig(cam, null, { now: () => t });
  rig.resize(1600, 900);
  assert.equal(cam.fov, 30);
  near(rig.getState().pitch, 52);
  const before = rig.getState();
  const flight = rig.focus({ x: 4.4, y: 0, z: -2.2 });
  for (let i = 0; i < 60; i++) rig.update(16);
  assert.equal(await flight, true);
  const f = rig.getState();
  assert.equal(f.focused, true);
  near(f.d, 18);
  near(f.pitch, 48);
  near(f.target.x, 4.4);
  near(f.target.y, 1);
  near(cam.looked.x, 4.4);
  const back = rig.back();
  for (let i = 0; i < 60; i++) rig.update(16);
  assert.equal(await back, true);
  near(rig.getState().d, before.d);
  near(rig.getState().pitch, 52);
  assert.equal(await rig.back(), false); // no-op outside focus (UI and main may both ask)
  rig.setYaw(90, { animate: false });
  assert.equal(rig.getState().yaw, 40);
  rig.zoomBy(10, { animate: false });
  assert.equal(rig.getState().d, 70);
  rig.setReduced(true);
  assert.equal(await rig.focus({ x: 0, y: 0, z: 2.2 }), true); // a cut: resolved without frames
  near(rig.getState().d, 18);
  rig.setSafeArea({ right: 380 });
  assert.deepEqual(cam.view, { fw: 1600, fh: 900, x: 190, y: 0, w: 1600, h: 900 });
  rig.setSafeArea({});
  assert.equal(cam.view, null);
  rig.resize(390, 844);
  assert.equal(cam.fov, 42);
  // the first-load arc never takes the view away from a player who already focused or moved
  assert.equal(await rig.intro(), false);
  const fresh = camera.createRig(fakeCamera(), null, { now: () => t });
  fresh.resize(1600, 900);
  const arc = fresh.intro();
  near(fresh.getState().d, 70); // starts high and wide
  for (let i = 0; i < 200; i++) fresh.update(16);
  assert.equal(await arc, true);
  near(fresh.getState().pitch, 52);
  rig.dispose();
  fresh.dispose();
});

test('labels: projection puts the view axis at the centre and culls points behind the camera', () => {
  const cam = fakeCamera();
  cam.near = 0.5;
  const c = labels.projectPoint(cam, 0, 0, -5, 800, 600);
  assert.equal(c.behind, false);
  near(c.x, 400);
  near(c.y, 300);
  near(c.dist, 5);
  assert.equal(labels.projectPoint(cam, 0, 0, 5, 800, 600).behind, true);
  // anchors: culled beyond LABELS.maxDistance (covers the widest zoom, so default views keep their chips, J7),
  // shown again when near
  assert.ok(labels.LABELS.maxDistance >= 90 + 21, 'cull distance covers the widest zoom plus the island radius');
  const el = { style: {}, parentNode: null, remove() {} };
  const container = { clientWidth: 800, clientHeight: 600, appendChild(e) { e.parentNode = container; } };
  const L = labels.createLabels(cam, container);
  const target = { x: 0, y: 0, z: -5 };
  const h = L.anchor(target, el);
  assert.equal(h.visible, true);
  assert.equal(el.style.transform, 'translate3d(400px, 300px, 0)');
  target.z = -70; // a default-view distance: still shown
  L.update();
  assert.equal(h.visible, true);
  target.z = -(labels.LABELS.maxDistance + 10);
  L.update();
  assert.equal(h.visible, false);
  assert.equal(el.style.visibility, 'hidden');
  target.z = -5;
  L.update();
  assert.equal(h.visible, true);
  assert.equal(el.style.visibility, '');
  // HUD bands: an anchor projecting under the top HUD is hidden (it would only clutter it)
  L.setClip({ top: 320, bottom: 0 });
  L.update();
  assert.equal(h.visible, false);
  L.setClip({ top: 0, bottom: 0 });
  L.update();
  assert.equal(h.visible, true);
  // …and so is a label whose BODY (it hangs above its anchor) would reach under the HUD band
  el.offsetHeight = 40;
  L.setClip({ top: 280, bottom: 0 }); // anchor at y 300: below the band, but 300 − 40 < 280
  L.update();
  assert.equal(h.visible, false);
  L.setClip({ top: 250, bottom: 0 }); // 300 − 40 ≥ 250: the whole label is visible
  L.update();
  assert.equal(h.visible, true);
  h.setVisible(false);
  assert.equal(h.visible, false);
  // pinned anchors (landmark signs, §2.4 P0): clamped to the band's edge instead of hidden, flagged is-pinned
  const classes = new Set();
  const pel = { style: {}, parentNode: null, remove() {}, offsetHeight: 30, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  const ptarget = { x: 0, y: 0, z: -5 };
  const ph = L.anchor(ptarget, pel, { pin: true });
  L.setClip({ top: 320, bottom: 120 });
  L.update();
  assert.equal(ph.visible, true);
  assert.equal(pel.style.transform, 'translate3d(400px, 354px, 0)', 'top edge 320 + its 30 px height + 4');
  assert.ok(classes.has('is-pinned'));
  L.setClip({ top: 0, bottom: 0 });
  L.update();
  assert.equal(pel.style.transform, 'translate3d(400px, 300px, 0)');
  assert.ok(!classes.has('is-pinned'));
});

test('camera: the default landscape view backs off just enough to frame the farm inside the HUD-free area', () => {
  // no HUD: the §2.5 distance (50) already frames everything on a 16:9 canvas
  const free = camera.defaultState('landscape', 1920 / 1080, { W: 1920, H: 1080, safe: null });
  assert.equal(free.d, 50);
  // a 1024 × 768 window with a 123 px HUD and a 218 px dock needs to back off, never past dMax
  const small = camera.defaultState('landscape', 1024 / 768, { W: 1024, H: 768, safe: { top: 123, bottom: 218 } });
  assert.ok(small.d > 50 && small.d <= camera.RIG.landscape.dMax, `d = ${small.d}`);
  assert.ok(camera.framesPoints(small.d, { W: 1024, H: 768, safe: { top: 123, bottom: 218 } }) || small.d === camera.RIG.landscape.dMax);
  // the default pitch stays 52° as far as the ±8° tilt allows
  assert.ok(Math.abs(camera.pitchFor(free.d, 'landscape', free.tilt) - 52) < 1e-9);
  // portrait keeps fitDistance(24 u) (no fitting)
  const p = camera.defaultState('portrait', 390 / 844, { W: 390, H: 844, safe: { top: 200, bottom: 300 } });
  assert.equal(p.d, camera.defaultState('portrait', 390 / 844).d);
});

test('loop: demand mode renders on request then idles (0 renders when nothing changes); continuous keeps going', () => {
  let installed = null;
  const renderer = { setAnimationLoop: (fn) => (installed = fn) };
  let busy = false;
  let frames = 0;
  let now = 0;
  const loop = loopMod.createLoop({ renderer, frame: () => (frames++, { busy, ambient: false }), now: () => now, doc: null });
  loop.setMode('demand');
  loop.start();
  assert.ok(installed);
  now = 16;
  installed(16);
  assert.equal(frames, 1);
  assert.equal(installed, null); // idle: the animation loop is removed
  loop.requestRender();
  assert.ok(installed);
  busy = true;
  now = 32;
  installed(32);
  now = 48;
  installed(48);
  assert.ok(installed); // busy keeps it awake
  busy = false;
  now = 64;
  installed(64);
  assert.equal(installed, null);
  assert.equal(frames, 4);
  // continuous with ambient motion never idles
  loop.setMode('continuous');
  for (let ts = 80; ts < 8000; ts += 16) installed?.(ts);
  // ambient: false and nothing busy for 5 s → idles even in continuous mode
  assert.equal(installed, null);
  // fps cap 30: alternate display frames are skipped
  const r2 = { setAnimationLoop: (fn) => (installed = fn) };
  let f2 = 0;
  const l2 = loopMod.createLoop({ renderer: r2, frame: () => (f2++, { busy: true, ambient: true }), now: () => 0, doc: null });
  l2.setFpsCap(30);
  l2.start();
  for (let ts = 0; ts <= 1000; ts += 1000 / 60) installed(ts);
  assert.ok(f2 >= 29 && f2 <= 32, `~30 renders (${f2})`);
  l2.dispose();
  loop.dispose();
});

// ------------------------------------------------------------------ files and import rules (§9.1, §7.6)

test('import rules: pure modules never import three; no innerHTML in WP2 code; one three shim', () => {
  const read = (p) => fs.readFileSync(new URL(p, WEB), 'utf8');
  const pure = ['model.js', 'game/core/view.js', 'game/core/rules.js', 'game/core/data.js', 'game/core/store.js', 'game/core/bus.js', 'game/core/settings.js', 'game/fx/director.js'];
  for (const p of pure) {
    const src = read(p);
    assert.ok(!/from\s+['"][^'"]*three(\.js|\.module)/.test(src) && !/vendor\/three/.test(src), `${p} must not import three`);
  }
  const mine = [...pure, 'game/boot.js', 'game/main.js', 'game/stage.js', 'game/gfx/renderer.js', 'game/gfx/loop.js', 'game/gfx/tiers.js', 'game/gfx/camera.js', 'game/gfx/picking.js', 'game/gfx/labels.js', 'game/gfx/tween.js', 'game/gfx/post.js'];
  for (const p of mine) {
    const src = read(p);
    assert.ok(!/\.innerHTML\s*=/.test(src), `${p} uses innerHTML`);
    assert.ok(!/setAttribute\(\s*['"]style['"]/.test(src), `${p} sets a style attribute`);
  }
  assert.match(read('game/three.js'), /export \* from '\/vendor\/three\/build\/three\.module\.min\.js'/);
  assert.match(read('game/boot.js'), /\/vendor\/three\/build\/three\.module\.min\.js/);
});

test('classic.html keeps the 2D garden (garden.js + garden.css, no inline script) and links back to the 3D page', () => {
  const html = fs.readFileSync(new URL('../web/classic.html', import.meta.url), 'utf8');
  assert.match(html, /<script type="module" src="js\/garden\.js"><\/script>/);
  assert.match(html, /href="css\/garden\.css"/);
  assert.match(html, /<a href="\/"[^>]*>/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  for (const id of ['packets', 'plots', 'diary', 'plantDlg', 'askDlg', 'timelapse', 'burn']) assert.match(html, new RegExp(`id="${id}"`), id);
});

test('boot: classic redirect keeps ?api= but never forwards a token', async () => {
  const boot = await imp('game/boot.js'); // no DOM in Node: importing does not boot
  assert.equal(boot.classicHref('?token=abc&api=http%3A%2F%2Fh%3A1&classic=1'), '/classic.html?api=http%3A%2F%2Fh%3A1');
  assert.equal(boot.classicHref(''), '/classic.html');
  assert.equal(boot.ENGINE_URL, '/vendor/three/build/three.module.min.js');
  assert.equal(boot.probeWebGL2(() => ({ getContext: () => null })), null);
  let n = 0;
  assert.equal(boot.probeWebGL2(() => ({ getContext: () => (n++ === 0 ? null : { getExtension: () => null }) })), 'software');
  assert.equal(boot.probeWebGL2(() => ({ getContext: () => ({ getExtension: () => ({ loseContext() {} }) }) })), 'hw');
});

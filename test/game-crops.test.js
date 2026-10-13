// test/game-crops.test.js — WP4: crops, field and effect executor (GAME-DESIGN §3, §4.1–4.3, §9.7, §11.4).
// Offline, no GPU, no DOM. Pure modules are imported directly; the three-backed modules (crop builders,
// field, executor) are loaded through a resolve hook that maps the page's three shim onto
// node_modules/three (three builds geometry and materials headless; nothing is rendered).
import test from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const imp = (p) => import(new URL(p, ROOT).href);

const C = await imp('web/js/game/crops/catalog.js');
const G = await imp('web/js/game/field/growth.js');
const F = await imp('web/js/game/field/plotFsm.js');
const A = await imp('web/js/game/field/anim.js');
const FL = await imp('web/js/game/fx/floaters.js');
const P = await imp('web/js/plant.js');
const R = await imp('web/js/game/core/rules.js');
const VIEW = await imp('web/js/game/core/view.js');
const { COINS } = await imp('server/market.js');

// ---------------------------------------------------------------- three via a resolve hook (when available)

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

// ---------------------------------------------------------------- §11.4: the catalogue

test('crops: CROPS covers every venue coin plus the fallback', () => {
  const coins = COINS.map((c) => c.coin);
  assert.ok(coins.length >= 16);
  for (const coin of coins) {
    assert.ok(Object.hasOwn(C.CROPS, coin), `no crop for ${coin}`);
    assert.equal(C.cropFor(coin).coin, coin);
    assert.equal(C.cropKey(coin), `g.crop.${coin}`);
  }
  assert.ok(Object.hasOwn(C.CROPS, C.FALLBACK));
  assert.equal(C.cropFor('NOPE').coin, 'other');
  assert.equal(C.cropFor(undefined).coin, 'other');
  assert.equal(C.cropFor('').key, 'g.crop.other');
  // the coins of §3.1 match the view module's crop list (chips / dock use it)
  assert.deepEqual([...VIEW.CROP_COINS].sort(), Object.keys(C.CROPS).filter((k) => k !== 'other').sort());
});

test('crops: every palette hex is valid and every builder is one of the 9', () => {
  assert.deepEqual([...C.BUILDERS].sort(), ['bush', 'fungus', 'grassClump', 'groundRosette', 'hangingBush', 'rootCrop', 'stalk', 'tree', 'vine']);
  for (const [coin, crop] of Object.entries(C.CROPS)) {
    assert.ok(C.BUILDERS.includes(crop.builder), `${coin}: builder ${crop.builder}`);
    for (const f of C.COLOR_FIELDS) {
      if (f === 'accent' && crop.accent === null) continue;
      assert.ok(C.isHex(crop[f]), `${coin}.${f} = ${crop[f]}`);
    }
    assert.ok(crop.height > 0 && crop.height <= 3.2, `${coin} height`);
  }
  // §3.1 palettes (spot checks of the binding table)
  assert.equal(C.CROPS.BTC.leaf, '#5E9E58');
  assert.equal(C.CROPS.BTC.ripe, '#F39A2E');
  assert.equal(C.CROPS.SOL.builder, 'stalk');
  assert.equal(C.CROPS.DOGE.builder, 'stalk');
  assert.equal(C.CROPS.WIF.builder, 'fungus');
  assert.equal(C.CROPS.WIF.accent, '#F4A6C6');
  assert.equal(C.CROPS.XRP.accent, '#8FD3E8');
  assert.equal(C.CROPS.SUI.accent, '#2F6B36');
  assert.equal(C.CROPS.other.builder, 'vine');
  assert.equal(C.CROPS.other.ripe, '#4E9A3F');
  assert.equal(C.TONE.sick, '#C4B048');
  assert.equal(C.TONE.dead, '#805E3C');
  assert.deepEqual(C.hexRgb('#F39A2E'), [243, 154, 46]);
  assert.equal(C.rgbHex([243, 154, 46]), '#F39A2E');
});

// ---------------------------------------------------------------- §3.4: growth comes from stage(), never re-implemented

function bot(o = {}) {
  return { id: 'bot-1', bean: 7, coin: 'BTC', state: 'active', capital_usd: 100, realized_pnl: 0, leverage: 10, bean_side: 1, last_error: null, note: null, mark_px: 100, real: { szi: 1, entry_px: 100, unrealized_pnl: 0, liquidation_px: 90.5, margin_used: 10, as_of_ms: 1000 }, ...o };
}

test('growth: plotLook uses exactly stage() of the PlotView (size, health, fruit, flower)', () => {
  const cases = [-0.2, -0.12, -0.08, -0.05, -0.02, 0, 0.01, 0.021, 0.04, 0.06, 0.09, 0.15, 0.4];
  for (const frac of cases) {
    const b = bot({ realized_pnl: frac * 40, real: { ...bot().real, unrealized_pnl: frac * 60 } });
    const v = VIEW.plotView(b, 0, { nowMs: 2000 });
    const s = P.stage(b);
    const L = G.plotLook(v);
    assert.equal(L.crop.size, s.size, `size @ ${frac}`);
    assert.equal(L.crop.health, s.health, `health @ ${frac}`);
    assert.equal(L.crop.fruit, s.fruit, `fruit @ ${frac}`);
    assert.equal(L.crop.flowerOpen, s.flower && !s.seed, `flower @ ${frac}`);
    assert.equal(L.caption, s.caption);
    assert.equal(L.ripe, s.caption === 'ripe');
  }
  // a view without growth numbers falls back to the imported stage() on the same server numbers
  const g = G.growthOf({ state: 'growing', water: 100, realized: 3, unrealized: 3, szi: 1 });
  assert.equal(g.size, P.stage({ state: 'active', capital_usd: 100, realized_pnl: 3, real: { szi: 1, unrealized_pnl: 3 } }).size);
});

test('growth: §3.4 visual mapping (droop, leaf tint, ripeness, leaf keep, sway, shiver)', () => {
  assert.equal(G.droopOf(1), 0);
  assert.equal(G.droopOf(0.6), 0);
  assert.equal(G.droopOf(0), 0.7);
  assert.ok(G.droopOf(0.3) > 0 && G.droopOf(0.3) < 0.7);
  // same thresholds/colours as plant.js healthTone(): lush ≥ 0.6, toward sick by 0.2, then toward dead
  assert.deepEqual(G.leafTone(0.9, '#5E9E58'), [0x5e, 0x9e, 0x58]);
  assert.deepEqual(G.leafTone(0.6, '#5E9E58'), [0x5e, 0x9e, 0x58]);
  assert.deepEqual(G.leafTone(0.2, '#5E9E58').map(Math.round), [0xc4, 0xb0, 0x48]);
  const dead = G.leafTone(0, '#5E9E58').map(Math.round);
  assert.deepEqual(dead, [0x80, 0x5e, 0x3c]);
  // ripeness: clamp((f − 2%) / 3%) with the GROWTH thresholds
  assert.equal(G.ripeness(0.02), 0);
  assert.equal(G.ripeness(0.05), 1);
  assert.ok(Math.abs(G.ripeness(0.035) - 0.5) < 1e-9);
  assert.equal(G.fruitHex(C.CROPS.BTC, 0), '#9CC46A');
  assert.equal(G.fruitHex(C.CROPS.BTC, 1), '#F39A2E');
  // leaf thinning: index ≥ ceil(N·(0.4 + 0.6·health)) hidden
  assert.equal(G.leafKeepCount(10, 1), 10);
  assert.equal(G.leafKeepCount(10, 0), 4);
  assert.equal(G.leafKeepCount(12, 0.5), Math.ceil(12 * 0.7));
  // leverage: sway 0.04 + 0.025·log2(lev), shiver 0.004·log2(lev)
  assert.ok(Math.abs(G.swayAmp(1) - 0.04) < 1e-12);
  assert.ok(Math.abs(G.swayAmp(8) - 0.115) < 1e-12);
  assert.equal(G.shiverAmp(1), 0);
  assert.ok(Math.abs(G.shiverAmp(16) - 0.016) < 1e-12);
  for (const lev of [0, 1, 2, 5, 6, 10, 11, 25, 26, 50, 51, 100]) assert.equal(G.levTierLocal(lev), R.levTier(lev), `levTier ${lev}`);
});

/** Hue in degrees of a hex colour (for the J6 channel checks). */
function hue(hex) {
  const [r, g, b] = C.hexRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return null;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

test('J6: side cues are blue/violet (or greys), thermometer bands are slate/amber — never green/red', () => {
  const up = G.sideCue(1);
  const down = G.sideCue(-1);
  const flat = G.sideCue(0);
  assert.deepEqual([up.dir, up.color, up.critter], ['up', '#2B6CB0', 'bird']);
  assert.deepEqual([down.dir, down.color, down.critter], ['down', '#7B4FC4', 'mole']);
  assert.deepEqual([flat.dir, flat.color, flat.critter], ['flat', '#8A8F98', null]);
  const cb = [G.sideCue(1, 'cb'), G.sideCue(-1, 'cb')];
  assert.deepEqual(cb.map((c) => c.color), ['#D9D4C7', '#5A5550']);
  assert.deepEqual(cb.map((c) => c.dir), ['up', 'down']);
  const notMoney = (hex) => {
    const h = hue(hex);
    if (h === null) return true;
    const [r, g, b] = C.hexRgb(hex);
    const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    if (sat < 0.15) return true; // greys
    return !(h >= 90 && h <= 160) && !(h <= 15 || h >= 345); // not green, not red
  };
  for (const hex of [...Object.values(G.SIDE_COLORS.std), ...Object.values(G.SIDE_COLORS.cb), ...Object.values(G.BAND_COLORS), G.RING]) {
    assert.ok(notMoney(hex), `${hex} looks like a money colour`);
  }
  // thermometer: fill = d, bands by d (ok > 0.6, warn > 0.3, danger)
  assert.equal(G.thermoOf(null, 1), null);
  assert.equal(G.thermoOf({ d: 0.5, band: 'warn' }, 0), null); // no position, no thermometer
  assert.deepEqual(G.thermoOf({ d: 1, band: 'ok' }, 1), { fill: 1, band: 'ok', color: '#7FA7B8', hazard: false });
  assert.equal(G.thermoOf({ d: 0.45 }, -1).band, 'warn');
  const danger = G.thermoOf({ d: 0.1, band: 'danger' }, 1);
  assert.equal(danger.hazard, true);
  assert.equal(danger.color, '#E0A526');
});

// ---------------------------------------------------------------- §3.5: the exhaustive state table

const baseView = (o = {}) => ({
  slot: 0, botId: 'bot-1', coin: 'BTC', state: 'growing', phase: 'long', size: 0.6, health: 1, fruit: 1, flower: true, seed: false,
  caption: null, ripe: false, frac: 0.03, side: 1, lev: 10, family: 'standard', liqInfo: { d: 1, band: 'ok', movePct: 0.1, dir: 'fall' },
  note: null, error: null, frozen: false, stale: false, halted: false, usd: 3, water: 100, ...o,
});

test('§3.5 state → look: empty, burned, pick mode', () => {
  const e = G.plotLook(null);
  assert.equal(e.empty, true);
  assert.equal(e.soil, 'dry');
  assert.equal(e.pickGlow, false);
  assert.equal(G.plotLook(null, { pick: true }).pickGlow, true);
  const burned = G.plotLook(null, { halted: true, pick: true });
  assert.equal(burned.soil, 'charred');
  assert.equal(burned.charStump, true);
  assert.equal(burned.pickGlow, false, 'no glow on a burned field');
  assert.equal(G.plotLook(baseView({ state: 'closed' })).empty, true);
});

test('§3.5 state → look: waiting / entering seeds, growing long/short with cues', () => {
  const w = G.plotLook(baseView({ state: 'waiting', phase: 'waiting', seed: true, side: 0, liqInfo: null, caption: 'waiting', fruit: 0 }));
  assert.equal(w.mode, 'seed');
  assert.equal(w.crop.fruit, 0);
  assert.equal(w.crop.flowerOpen, false);
  assert.equal(w.thermo, null, 'no thermometer without a position');
  assert.equal(w.sign.dir, 'flat');
  const en = G.plotLook(baseView({ state: 'entering', phase: 'entering', seed: true, side: 0, liqInfo: null, caption: 'entering' }));
  assert.equal(en.entering, true);
  const long = G.plotLook(baseView({ lev: 30 }));
  assert.equal(long.mode, 'crop');
  assert.deepEqual([long.sign.dir, long.sign.critter], ['up', 'bird']);
  assert.equal(long.sacks, 4);
  assert.equal(long.hazardSacks, true);
  assert.ok(long.thermo && long.thermo.band === 'ok');
  assert.equal(long.valveOpen, true);
  assert.equal(long.soil, 'wet');
  const short = G.plotLook(baseView({ side: -1, phase: 'short', lev: 5 }));
  assert.deepEqual([short.sign.dir, short.sign.critter, short.sacks, short.hazardSacks], ['down', 'mole', 1, false]);
  const deg = G.plotLook(baseView({ family: 'degen' }));
  assert.equal(deg.sway.jitter, true);
  assert.equal(G.plotLook(baseView({ family: 'weird' })).family, 'standard');
});

test('§3.5 state → look: ripe, wilting, dying, liq danger, frozen, error', () => {
  const ripe = G.plotLook(baseView({ caption: 'ripe', ripe: true, frac: 0.07, fruit: 3 }));
  assert.equal(ripe.ripe, true);
  assert.equal(ripe.basket, true);
  assert.equal(ripe.crop.ripe01, 1);
  const wilt = G.plotLook(baseView({ caption: 'wilting', health: 0.4, frac: -0.075 }));
  assert.equal(wilt.wilting, true);
  assert.ok(wilt.crop.droop > 0);
  assert.ok(Math.abs(wilt.sway.amp - G.swayAmp(10) * 0.6) < 1e-12, 'wilting sways ×0.6');
  assert.equal(wilt.soil, 'dryish');
  const dying = G.plotLook(baseView({ caption: 'dying', health: 0.1, frac: -0.11 }));
  assert.equal(dying.dying, true);
  assert.equal(dying.soil, 'cracked');
  assert.ok(dying.crop.leafKeep < 0.5);
  const danger = G.plotLook(baseView({ liqInfo: { d: 0.2, band: 'danger', movePct: 0.01, dir: 'fall' } }));
  assert.equal(danger.danger, true);
  assert.equal(danger.crop.frost, 0.6);
  assert.equal(danger.soil, 'cracked');
  const frozen = G.plotLook(baseView({ frozen: true }));
  assert.equal(frozen.frozen, true);
  const err = G.plotLook(baseView({ error: 'boom', phase: 'error' }));
  assert.equal(err.error, true);
  assert.equal(err.crop.size, 0.6, 'the plant keeps its growth state under an error');
});

test('§3.5 state → look: paused (shade), bean busted, liquidated, halted', () => {
  const paused = G.plotLook(baseView({ state: 'paused', phase: 'paused', side: 0, liqInfo: null }));
  assert.equal(paused.parasol, true);
  assert.equal(paused.crop.sat, 0.7, 'desaturated 30%');
  assert.equal(paused.valveOpen, false);
  assert.equal(paused.soil, 'dry');
  assert.equal(paused.sign.dir, 'flat');
  assert.equal(paused.basket, false);
  const busted = G.plotLook(baseView({ state: 'paused', phase: 'paused', note: 'bean busted', side: 0, liqInfo: null }));
  assert.equal(busted.busted, true);
  assert.equal(busted.parasol, true);
  const liq = G.plotLook(baseView({ state: 'paused', phase: 'paused', note: 'liquidated', side: 0, liqInfo: null }));
  assert.equal(liq.liquidated, true);
  assert.equal(liq.crop.flatten, 0.15, 'stump: scale-y 0.15');
  const halted = G.plotLook(baseView(), { halted: true });
  assert.equal(halted.soil, 'charred');
  assert.equal(halted.valveOpen, false);
});

test('§2.3 grid fallback matches the shared slot maths', () => {
  for (const count of [10, 12, 15]) {
    for (let i = 0; i < count; i++) {
      const g = G.gridPosition(i, count);
      const v = VIEW.slotXZ(i, count);
      assert.equal(g.x, v.x);
      assert.equal(g.z, v.z);
    }
  }
  assert.deepEqual(G.gridPosition(0, 10), { x: -8.8, y: 0, z: -2.2 });
  assert.deepEqual(G.gridPosition(9, 10), { x: 8.8, y: 0, z: 2.2 });
  assert.equal(G.gridPosition(14, 15).z, 4.4);
});

// ---------------------------------------------------------------- plot FSM (§3.5)

test('plotFsm: empty → planting → waiting/growing ⇄ paused → harvesting → retill → empty', () => {
  const f = F.createPlotFsm();
  assert.equal(f.state, 'empty');
  assert.equal(f.pending(true, true, 0).state, 'planting');
  assert.equal(f.pending(false, true, 100).state, 'planting', '2xx keeps digging until the bot shows up');
  assert.equal(f.planted(200).state, 'waiting');
  const v = baseView();
  assert.equal(f.apply(v, 300).state, 'growing');
  assert.equal(f.apply({ ...v, state: 'paused' }, 400).state, 'paused');
  assert.equal(f.apply(v, 500).state, 'growing');
  assert.equal(f.startExit('harvest', 600), true);
  assert.equal(f.state, 'harvesting');
  // data during the exit is queued, not applied
  const r = f.apply(v, 700);
  assert.equal(r.deferred, true);
  assert.equal(f.state, 'harvesting');
  assert.equal(f.endExit(2600).state, 'retill');
  assert.equal(f.tick(3000).state, 'retill');
  const t = f.tick(3300);
  assert.equal(t.state, 'empty', 'the closed bot\'s late view counts as empty');
  // a new bot can take the slot afterwards
  assert.equal(f.apply({ ...v, botId: 'bot-2' }, 3400).state, 'growing');
});

test('plotFsm: failed planting re-flattens; planting times out after 10 s', () => {
  const f = F.createPlotFsm();
  f.pending(true, true, 0);
  assert.equal(f.pending(false, false, 50).state, 'empty');
  f.pending(true, true, 1000);
  assert.equal(f.tick(5000).state, 'planting');
  assert.equal(f.tick(11_000).state, 'empty');
});

test('plotFsm: a bot that vanishes waits 1.2 s for its close effect, then re-tills', () => {
  const f = F.createPlotFsm();
  f.apply(baseView(), 0);
  assert.equal(f.apply(null, 100).state, 'closing');
  assert.equal(f.startExit('pull', 400), true, 'the late bot_closed still plays');
  assert.equal(f.state, 'pulling');
  const g = F.createPlotFsm();
  g.apply(baseView(), 0);
  g.apply(null, 100);
  assert.equal(g.tick(1000).state, 'closing');
  assert.equal(g.tick(1400).state, 'retill');
  assert.equal(g.tick(2100).state, 'empty');
  // a different bot taking the slot without an exit re-tills first, then shows it
  const h = F.createPlotFsm();
  h.apply(baseView(), 0);
  assert.equal(h.apply(baseView({ botId: 'bot-9' }), 50).state, 'retill');
  assert.equal(h.tick(700).state, 'growing');
  assert.equal(h.view.botId, 'bot-9');
  assert.equal(F.stateOfView(null), 'empty');
  assert.equal(F.stateOfView({ botId: 'x', state: 'closed' }), 'empty');
  assert.equal(F.stateOfView({ botId: 'x', state: 'entering' }), 'entering');
});

test('plotFsm: overlay flags', () => {
  const f = F.createPlotFsm();
  assert.equal(f.setFlag('frozen', true), true);
  assert.equal(f.setFlag('frozen', true), false);
  assert.equal(f.flags.frozen, true);
  assert.equal(f.setFlag('nope', true), false);
  assert.deepEqual([...F.OVERLAY_FLAGS], ['error', 'frozen', 'liqDanger', 'selected', 'hover']);
});

// ---------------------------------------------------------------- animation primitives

test('anim: critically damped spring (ω = 4) converges without overshoot and retargets smoothly', () => {
  const s = A.createSpring(0.25, { omega: 4 });
  s.retarget(1);
  let prev = 0.25;
  let maxX = 0;
  for (let i = 0; i < 300; i++) {
    const x = s.step(1 / 60);
    assert.ok(x >= prev - 1e-12, 'monotonic');
    prev = x;
    maxX = Math.max(maxX, x);
  }
  assert.ok(maxX <= 1 + 1e-9, 'no overshoot');
  assert.ok(Math.abs(s.x - 1) < 1e-3);
  // a mark retargets mid-flight: position and velocity carry over (no jump, J11)
  const t = A.createSpring(0, { omega: 4 });
  t.retarget(1);
  for (let i = 0; i < 10; i++) t.step(1 / 60);
  const before = t.x;
  t.retarget(0.5);
  assert.equal(t.x, before);
  t.step(1 / 60);
  assert.ok(Math.abs(t.x - before) < 0.05);
  // stable for a huge dt (closed form)
  const u = A.createSpring(0);
  u.retarget(1);
  assert.ok(Math.abs(u.step(10) - 1) < 1e-6);
  assert.equal(u.snap(0.3).x, 0.3);
});

test('anim: easings, pop 0 → 1.15 → 1, tweens and reduced-motion timelines', () => {
  for (const k of ['oB', 'iOC', 'oC', 'iOS', 'linear']) {
    assert.ok(Math.abs(A.EASE[k](0)) < 1e-9, k);
    assert.ok(Math.abs(A.EASE[k](1) - 1) < 1e-9, k);
  }
  assert.ok(Math.abs(A.outBackPeak(1.70158) - 1.1) < 0.01);
  let peak = 0;
  for (let i = 0; i <= 1000; i++) peak = Math.max(peak, A.popScale(i / 1000));
  assert.ok(Math.abs(peak - 1.15) < 0.002, `pop peak ${peak}`);
  assert.equal(A.popScale(0), 0);
  assert.ok(Math.abs(A.popScale(1) - 1) < 1e-9);
  const tw = A.createTween({ from: 0, to: 10, ms: 100 });
  tw.step(50);
  assert.equal(tw.value(), 5);
  tw.step(100);
  assert.equal(tw.done, true);
  assert.equal(A.motionDur(700, true), 150);
  assert.equal(A.motionDur(700, false), 700);
  // timeline: ordered steps, done resolves; under RM every step is ≤ 150 ms
  const log = [];
  const tl = A.createTimeline({ reduced: false });
  tl.add({ at: 0, ms: 100, update: (k) => log.push(['a', k]) });
  tl.call(250, () => log.push(['b']));
  assert.equal(tl.length, 250);
  for (let i = 0; i < 30; i++) tl.step(10);
  assert.equal(tl.finished, true);
  assert.deepEqual(log.at(-1), ['b']);
  const rm = A.createTimeline({ reduced: true });
  rm.add({ at: 600, ms: 700 });
  assert.ok(rm.length <= 300);
});

// ---------------------------------------------------------------- floaters text (J1, J4, J6)

test('floaters: fill / harvest / pull texts carry the server number with sign, glyph and tone', () => {
  assert.deepEqual(FL.moneyText(2.66), { text: '+$2.66 ▲', tone: 'up' });
  assert.deepEqual(FL.moneyText(-8.2), { text: '−$8.20 ▼', tone: 'down' });
  assert.deepEqual(FL.moneyText(0), { text: '$0.00', tone: 'neutral' });
  assert.deepEqual(FL.moneyText(-0.001), { text: '$0.00', tone: 'neutral' });
  assert.equal(FL.moneyText(1.5, { est: true }).text, '≈ +$1.50 ▲');
  const open = FL.fillText({ kind: 'fill', coin: 'BTC', n: 1, meta: { dir: 'Open Long', sz: 0.005, px: 82410, szDecimals: 5, open: true } });
  assert.deepEqual(open, { text: 'Open Long 0.00500 BTC @ $82,410.0', tone: 'neutral' });
  const close = FL.fillText({ kind: 'fill', coin: 'BTC', usd: 2.66, n: 1, meta: { dir: 'Close Long', sz: 0.005, px: 82980.5, szDecimals: 5, open: false } });
  assert.deepEqual(close, { text: 'Close Long @ $82,980.5 · realized +$2.66 ▲', tone: 'up' });
  const merged = FL.fillText({ kind: 'fillMerged', coin: 'SOL', n: 3, meta: { dir: 'Open Short', sz: 1.5, px: 110.4251, szDecimals: 2, open: true } });
  assert.equal(merged.text, 'Open Short 1.50 SOL @ $110.425 · ×3 fills');
  const lossClose = FL.fillText({ kind: 'fill', coin: 'ETH', usd: -1.2, meta: { dir: 'Close Short', px: 2509.354, szDecimals: 4 } });
  assert.equal(lossClose.tone, 'down');
  const h = FL.effectText({ kind: 'harvest', usd: 12.4, n: 6 });
  assert.deepEqual(h, { text: '+$12.40 ▲ harvested', tone: 'up' });
  const p = FL.effectText({ kind: 'pull', usd: -8.2, n: 0 });
  assert.deepEqual(p, { text: '−$8.20 ▼ realized loss', tone: 'down' });
  assert.deepEqual(FL.effectText({ kind: 'harvest', usd: 0, n: 0 }), { text: '$0.00 harvested', tone: 'neutral' });
  assert.equal(FL.effectText({ kind: 'water', usd: 100 }).text, 'watered $100');
  assert.equal(FL.effectText({ kind: 'water', usd: 125.5 }).text, 'watered $125.50');
  assert.equal(FL.effectText({ kind: 'capTag' }).tone, 'warn');
  assert.equal(FL.effectText({ kind: 'liquidate', usd: -70.8 }).text, 'LIQUIDATED −$70.80 ▼');
  assert.equal(FL.effectText({ kind: 'liquidate', usd: 70.8 }).text, 'LIQUIDATED −$70.80 ▼', 'a liquidation is always shown as a loss');
  assert.equal(FL.effectText({ kind: 'burnPlot', usd: -3, meta: { recipe: 'pull', est: true } }).text, '≈ −$3.00 ▼ realized loss');
  assert.equal(FL.effectText({ kind: 'tick' }), null);
  // no DOM: the pool degrades to no-ops
  const pool = FL.createFloaters({});
  assert.equal(pool.show({ at: { x: 0, y: 0, z: 0 }, text: 'x' }).el, null);
});

// ---------------------------------------------------------------- three-backed modules (resolve hook)

test('builders: all 16 crops + the fallback build valid geometry within budget', needsThree, async () => {
  const B = await imp('web/js/game/crops/builders.js');
  assert.deepEqual([...B.BUILDER_FNS].sort(), [...C.BUILDERS].sort(), 'one builder function per catalogue builder');
  const tris = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
  for (const coin of B.cropCoins()) {
    for (const tier of ['high', 'low']) {
      const p = B.buildParts(coin, { tier });
      const g = p.stemLeaves;
      for (const a of ['position', 'normal', 'color', 'aLeaf', 'aH']) assert.ok(g.attributes[a], `${coin}/${tier}: ${a}`);
      for (const a of Object.values(g.attributes)) for (const v of a.array) assert.ok(Number.isFinite(v), `${coin}: NaN in geometry`);
      for (const v of g.attributes.aH.array) assert.ok(v >= 0 && v <= 1);
      assert.equal(p.fruitAnchors.length, 6, `${coin}: 6 fruit anchors`);
      assert.ok(p.flowerAnchors.length >= 1 && p.flowerAnchors.length <= 6, `${coin}: ≤ 6 flower anchors`);
      assert.ok(p.leafEnds.length >= 2, `${coin}: hideable leaves`);
      assert.ok(p.leafEnds.every((e, i) => e > (i ? p.leafEnds[i - 1] : p.leafStart)), 'leaf ranges increase');
      assert.equal(p.leafEnds.at(-1), g.attributes.position.count);
      const total = tris(g) + 6 * tris(p.fruitGeo) + p.flowerAnchors.length * tris(p.flowerGeo);
      if (tier === 'high') assert.ok(total <= 6000, `${coin}: ${total} triangles`);
      for (const a of p.fruitAnchors) assert.ok(Number.isFinite(a.p.x + a.p.y + a.p.z + a.q.w + a.s));
      for (const geo of [g, p.fruitGeo, p.flowerGeo, p.sprout]) geo.dispose();
    }
    const hi = B.buildParts(coin, { tier: 'high' });
    const lo = B.buildParts(coin, { tier: 'low' });
    assert.ok(lo.leafEnds.length <= hi.leafEnds.length, `${coin}: low tier has fewer leaves`);
  }
  B.clearCropCache();
});

test('CropMesh: growth targets, fruit pop/drop (brown fruit stays 10 s), leaf thinning, frozen targets', needsThree, async () => {
  const B = await imp('web/js/game/crops/builders.js');
  const c = B.buildCrop('BTC', { tier: 'high', seed: 3 });
  const fruitMesh = c.group.children.find((o) => o.name === 'fruit');
  const visibleFruit = () => {
    let n = 0;
    const m = new (c.group.matrix.constructor)();
    for (let i = 0; i < 6; i++) {
      fruitMesh.getMatrixAt(i, m);
      if (Math.abs(m.elements[0]) + Math.abs(m.elements[5]) > 1e-6) n++;
    }
    return n;
  };
  const dropped = () => {
    let n = 0;
    const m = new (c.group.matrix.constructor)();
    for (let i = 6; i < 12; i++) {
      fruitMesh.getMatrixAt(i, m);
      if (Math.abs(m.elements[0]) > 1e-6) n++;
    }
    return n;
  };
  c.setGrowth({ size: 0.8, health: 1, fruit: 3, flowerOpen: true, frac: 0.07, ripe: true });
  c.update(1 / 60, 0);
  assert.equal(visibleFruit(), 3, 'first view: fruit appear at once');
  // the DRAWN scale is the remapped stage() size (visScale: a dying plant stays a full silhouette, J4)
  assert.ok(Math.abs(c.stageSize - 0.8) < 1e-6, 'first view snaps the size');
  assert.ok(Math.abs(c.group.scale.x - B.visScale(0.8, c.visParams)) < 1e-6, 'drawn scale = visScale(size)');
  assert.ok(B.visScale(0.12) >= B.VIS_BASE, 'a dying plant is drawn at ≥ 45% of full size (J4: losses stay visible)');
  assert.ok(B.visScale(1, c.visParams) > B.visScale(0.12, c.visParams), 'size still reads: bigger stage() size → bigger plant');
  // pop a 4th fruit; it overshoots then settles at full scale
  c.popFruit(3);
  for (let i = 0; i < 40; i++) c.update(1 / 60, i / 60);
  assert.equal(visibleFruit(), 4);
  // drop one: it is removed from the branch and lies brown on the soil for 10 s, then sinks
  const p = c.dropFruit(3);
  assert.ok(p && Number.isFinite(p.y));
  c.update(1 / 60, 1);
  assert.equal(visibleFruit(), 3);
  assert.equal(dropped(), 1);
  for (let t = 0; t < 9.5; t += 0.05) c.update(0.05, t);
  assert.equal(dropped(), 1, 'still visible after 9.5 s');
  for (let t = 0; t < 3; t += 0.05) c.update(0.05, t);
  assert.equal(dropped(), 0, 'gone after it sank');
  // leaf thinning follows leafKeepCount, with a falling-leaf callback per hidden leaf
  let fell = 0;
  c.onLeafFall = () => fell++;
  c.setGrowth({ size: 0.4, health: 0, fruit: 0, flowerOpen: false, frac: -0.13 });
  assert.equal(c.visibleLeaves, G.leafKeepCount(c.leafCount, 0));
  assert.equal(fell, c.leafCount - c.visibleLeaves);
  // springs retarget (no jump) on a new mark
  const before = c.stageSize;
  c.update(1 / 60, 0);
  assert.ok(Math.abs(c.stageSize - before) < 0.05, 'size moves by spring, never jumps');
  // frozen: growth targets are kept
  c.setGrowth({ size: 1, health: 1, fruit: 6, flowerOpen: true, frac: 0.2, frozen: true });
  assert.equal(c.visibleLeaves, G.leafKeepCount(c.leafCount, 0));
  for (let i = 0; i < 120; i++) c.update(1 / 30, i / 30);
  assert.ok(c.stageSize < 0.5, 'a frozen plant does not grow on stale prices');
  // reduced motion: springs snap
  c.setMotion({ reduced: true });
  c.setGrowth({ size: 0.9, health: 1, fruit: 2, frac: 0.05 });
  c.update(1 / 60, 0);
  assert.ok(Math.abs(c.stageSize - 0.9) < 1e-6);
  // the shader bend mirror keeps fruit on the branch: no droop/sway → fruit stays at its anchor
  const w = c.fruitWorld(0);
  assert.ok(Number.isFinite(w.x + w.y + w.z));
  c.dispose();
  B.clearCropCache();
});

test('field + executor: every effect kind runs; J4 — coins only on a realized gain', needsThree, async () => {
  const THREE = await import(THREE_URL);
  const { createField } = await imp('web/js/game/field/field.js');
  const { createFx, planOf } = await imp('web/js/game/fx/executor.js');
  const scene = new THREE.Scene();
  const field = createField({ scene, tier: 'high', settings: { palette: 'std', labels: 'always' } });
  const fx = createFx({ scene, field, settings: {} });
  const views = {};
  const coins = ['BTC', 'SOL', 'DOGE', 'WIF', 'XRP', 'other', 'PUMP', 'ETH'];
  coins.forEach((coin, i) => (views[i] = baseView({ slot: i, botId: `bot-${i}`, coin, side: i % 2 ? -1 : 1 })));
  field.sync(views, 10);
  const step = (n) => {
    for (let i = 0; i < n; i++) {
      field.update(1 / 30, i / 30);
      fx.update(1 / 30, i / 30);
    }
  };
  step(10);
  assert.equal(field.count, 10);
  assert.equal(field.plot(0).fsm.state, 'growing');
  assert.equal(field.plot(9).fsm.state, 'empty');
  assert.ok(field.plot(0).proxy.layers.mask === 2, 'pick proxy on layer 1');
  // J4 at the rendering end
  assert.equal(planOf({ kind: 'pull', usd: -8.2, n: 0 }).coins, 0);
  assert.equal(planOf({ kind: 'pull', usd: -8.2, n: 0 }).sparkle, 0);
  assert.equal(planOf({ kind: 'harvest', usd: 0, n: 0 }).coins, 0);
  assert.deepEqual(planOf({ kind: 'harvest', usd: 0, n: 0 }).sound, [], 'zero P&L: basket, no coin blips');
  assert.equal(planOf({ kind: 'harvest', usd: 12.4, n: R.coinBurst(12.4) }).coins, 6);
  assert.equal(planOf({ kind: 'harvest', usd: 12.4, n: 6 }, { reduced: true }).coins, 0, 'RM: no flights');
  assert.equal(planOf({ kind: 'harvest', usd: 5, n: 3, coin: 'DOGE', meta: { popcorn: true } }).popcorn, 24);
  assert.equal(planOf({ kind: 'harvest', usd: 0, n: 0, coin: 'DOGE', meta: { popcorn: true } }).popcorn, 0);
  assert.equal(planOf({ kind: 'burnPlot', usd: -2, n: 0, meta: { recipe: 'pull' } }).coins, 0);
  const coinMesh = scene.getObjectByName('fx:arc:coin');
  assert.ok(coinMesh, 'coin InstancedMesh');
  fx.run([{ kind: 'pull', slot: 1, coin: 'SOL', usd: -8.2, n: 0, tone: 'down', meta: { bot: 'bot-1' } }]);
  for (let i = 0; i < 40; i++) {
    step(1);
    assert.equal(coinMesh.visible, false, 'a pull never shows a coin');
  }
  fx.run([{ kind: 'harvest', slot: 0, coin: 'BTC', usd: 12.4, n: 6, tone: 'up', meta: { bot: 'bot-0' } }]);
  let sawCoins = false;
  for (let i = 0; i < 40; i++) {
    step(1);
    sawCoins ||= coinMesh.visible;
  }
  assert.ok(sawCoins, 'a gain flies its coins to the crates');
  step(120);
  assert.equal(field.plot(0).fsm.state, 'empty', 'harvested box re-tilled');
  assert.equal(field.plot(1).fsm.state, 'empty', 'pulled box re-tilled');
  // the closed bot's late view does not resurrect the crop
  field.sync(views, 10);
  step(5);
  assert.equal(field.plot(0).fsm.state, 'empty');
  // every effect kind of the contract runs without throwing
  for (const kind of R.EFFECT_KINDS) {
    const e = { kind, slot: 2 + (kind.length % 6), coin: 'DOGE', usd: kind === 'pull' ? -1 : 1, n: kind === 'harvest' ? 3 : kind === 'burnPlot' ? 3 : 1, meta: { op: 'bot_create', on: true, dir: 'Open Long', sz: 1, px: 0.18, open: true, recipe: 'harvest', delayMs: kind === 'burnPlot' ? 250 : 0 } };
    assert.doesNotThrow(() => fx.run([e]), kind);
    step(3);
  }
  step(200);
  // reduced motion: no particles are emitted at all
  fx.setReduced(true);
  field.setReduced(true);
  fx.particles.clear();
  fx.run([{ kind: 'harvest', slot: 4, coin: 'XRP', usd: 3, n: 3, meta: { reduced: true } }, { kind: 'dyingOn', slot: 5, coin: 'other', meta: { reduced: true } }]);
  step(2);
  assert.equal(fx.particles.busy(), false, 'RM: no particles');
  assert.equal(fx.particles.emit('dust', { x: 0, y: 0, z: 0 }, 5), 0);
  field.dispose();
  fx.dispose();
});

test('field: pick mode, outlines, halted field, slot count changes', needsThree, async () => {
  const THREE = await import(THREE_URL);
  const { createField } = await imp('web/js/game/field/field.js');
  const scene = new THREE.Scene();
  const registered = [];
  const picker = { register: (proxy, info) => (registered.push(info), () => registered.splice(registered.indexOf(info), 1)) };
  const field = createField({ scene, picker, tier: { tier: 'medium', critters: true, outlines: 'selected', shadows: 'pcf' }, settings: {} });
  field.sync({ 0: baseView() }, 10);
  assert.equal(registered.length, 10);
  assert.deepEqual(registered[3], { type: 'plot', slot: 3 });
  field.setPickMode(true, 'SOL');
  field.update(0.5, 0);
  const glow = scene.getObjectByName('field:glow');
  assert.equal(glow.count, 9, 'every empty plot glows');
  field.setHover(4); // medium tier: outlines on selection only
  field.setSelected(2);
  field.update(0.5, 0.5);
  assert.equal(scene.getObjectByName('field:outline_square').count, 1);
  field.setHalted(true);
  for (let i = 0; i < 20; i++) field.update(0.05, 1 + i * 0.05); // fades: glow out 200 ms, stumps in 400 ms
  assert.equal(scene.getObjectByName('field:glow').visible, false, 'no glow on a burned field');
  assert.equal(scene.getObjectByName('field:stump').count, 9, 'char stumps on empty burned boxes');
  field.sync({ 0: baseView() }, 15);
  assert.equal(field.count, 15);
  assert.equal(registered.length, 15);
  assert.equal(field.plot(14).object3D.position.z, 4.4);
  field.dispose();
  assert.equal(registered.length, 0, 'proxies unregistered on dispose');
});

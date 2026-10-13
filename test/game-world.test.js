// WP3 world + audio tests (GAME-DESIGN §2, §4.4–4.5, §8, §9.7). Node only: no GPU, no DOM, no network.
// The three-backed modules (island, landmarks, sky, weather, farmer, critters, world) are exercised in the browser;
// everything they compute lives in the pure modules tested here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import * as L from '../web/js/game/world/logic.js';
import * as T from '../web/js/game/world/terrain.js';
import * as N from '../web/js/game/world/noise.js';
import { PAL, WEATHER, WEATHER_KEYS, DAY_KEYS, dayKeyAt, luminance, mixHex, hexToRgb01, rgb01ToHex } from '../web/js/game/gfx/palette.js';
import { worldInputs, bindWorld } from '../web/js/game/world/bind.js';
import { createSfx, BUS_DB, MAX_VOICES, SOUNDS, PENTA, RAIN_GAIN } from '../web/js/game/audio/sfx.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ------------------------------------------------------------------ layout (§2.1–2.4)

test('slot grid follows §2.3 for 10 and 15 slots', () => {
  assert.deepEqual(L.slotXZ(0, 10), { x: -8.8, y: 0, z: -2.2 });
  assert.deepEqual(L.slotXZ(4, 10), { x: 8.8, y: 0, z: -2.2 });
  assert.ok(near(L.slotXZ(5, 10).z, 2.2) && near(L.slotXZ(5, 10).x, -8.8));
  assert.ok(near(L.slotXZ(7, 10).x, 0));
  // three rows recentre at −4.4, 0, 4.4
  assert.ok(near(L.slotXZ(0, 15).z, -4.4) && near(L.slotXZ(5, 15).z, 0) && near(L.slotXZ(14, 15).z, 4.4));
  assert.deepEqual(L.standXZ(2, 10), { x: L.slotXZ(2, 10).x, y: 0, z: -2.2 + 2.3 });
  assert.equal(L.slotCountOf(10, 3), 10);
  assert.equal(L.slotCountOf(12, 0), 12);
  assert.equal(L.slotCountOf(40, 22), 15);
  assert.equal(L.rowsOf(10), 2);
  assert.equal(L.rowsOf(11), 3);
});

test('every §2.4 landmark id exists with its specified position', () => {
  const ids = ['stall', 'barn', 'silo', 'crates', 'compost', 'tower', 'pond', 'windmill', 'sundial', 'board', 'mailbox', 'firepit', 'pip', 'signpost'];
  assert.deepEqual([...L.LANDMARK_IDS].sort(), [...ids].sort());
  const at = (id) => [L.LANDMARKS[id].x, L.LANDMARKS[id].z];
  assert.deepEqual(at('stall'), [-16, 0]);
  assert.deepEqual(at('barn'), [0, -13]);
  assert.deepEqual(at('silo'), [4.5, -14]);
  assert.deepEqual(at('tower'), [13, -8]);
  assert.deepEqual(at('pond'), [15, 3]);
  assert.deepEqual([L.LANDMARKS.pond.pumpX, L.LANDMARKS.pond.pumpZ], [13, 0.5]);
  assert.deepEqual(at('windmill'), [-12, -11]);
  assert.deepEqual(at('sundial'), [-8, -13.5]);
  assert.deepEqual(at('board'), [-15, 8]);
  assert.deepEqual(at('mailbox'), [-7, 12]);
  assert.deepEqual(at('firepit'), [8, 12.5]);
  assert.deepEqual(at('pip'), [-12.5, -5]);
  assert.deepEqual(at('signpost'), [0, 15.5]);
  // the stall faces +X, the barn faces south
  assert.ok(near(Math.sin(L.LANDMARKS.stall.yaw), 1));
  assert.equal(L.LANDMARKS.barn.yaw, 0);
});

// ------------------------------------------------------------------ terrain

test('the island top is a 21 u disc with ±0.6 u rim noise', () => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let a = 0; a < Math.PI * 2; a += 0.005) {
    const r = T.rimRadius(a);
    lo = Math.min(lo, r);
    hi = Math.max(hi, r);
  }
  assert.ok(lo >= 21 - 0.6 - 1e-9 && hi <= 21 + 0.6 + 1e-9, `${lo}..${hi}`);
  assert.ok(hi - lo > 0.5, 'the rim is visibly noisy');
  assert.ok(near(T.rimRadius(0), T.rimRadius(Math.PI * 2), 1e-9), 'periodic');
});

test('the field, its ring path and every landmark footprint are perfectly flat (y = 0)', () => {
  for (const count of [10, 15]) {
    const b = L.fieldBounds(count);
    for (let x = b.x0 - 0.6; x <= b.x1 + 0.6; x += 0.3) {
      for (let z = b.z0 - 0.6; z <= b.z1 + 0.6; z += 0.3) assert.equal(T.heightAt(x, z), 0, `(${x}, ${z})`);
    }
  }
  for (const f of T.FOOTPRINTS) {
    if (f.id === 'pump') continue; // the pump stands on the pond bank
    assert.equal(T.heightAt(f.x, f.z), 0, f.id);
  }
  // the meadow is not flat everywhere (mounds), and the rim lip falls away
  assert.ok(T.MOUNDS.some((m) => T.heightAt(m.x, m.z) > 0.25));
  assert.ok(T.heightAt(20.6, 0) < -0.1);
});

test('pond bowl: water level and shore radius follow the free-cash fill', () => {
  assert.ok(T.heightAt(15, 3) < -0.8, 'bowl centre is deep');
  const y0 = T.pondWaterY(0);
  const y1 = T.pondWaterY(1);
  assert.ok(y1 > y0 && y1 < 0, 'full water sits just under the bank');
  assert.ok(T.pondShoreRadius(y1) > T.pondShoreRadius(T.pondWaterY(0.5)));
  assert.ok(T.pondShoreRadius(T.pondWaterY(0.5)) > T.pondShoreRadius(y0));
  assert.ok(T.pondShoreRadius(y1) <= T.POND.r + 1e-6);
  assert.equal(T.pondWaterY(-3), y0);
  assert.equal(T.pondWaterY(7), y1);
});

test('the gravel ring encloses the field: no planter box sits on a path (10 and 15 slots)', () => {
  for (const count of [10, 15]) {
    const net = T.pathNetwork(count);
    const ring = T.ringRect(count);
    const b = L.fieldBounds(count);
    assert.ok(ring.x0 < b.x0 && ring.x1 > b.x1 && ring.z0 < b.z0 && ring.z1 > b.z1);
    for (let i = 0; i < count; i++) {
      const p = L.slotXZ(i, count);
      for (const [dx, dz] of [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7], [0, 0]]) {
        const info = T.pathInfo(p.x + dx, p.z + dz, net.filter((l) => l.ring));
        assert.ok(info.edge > 0.3, `slot ${i} corner (${dx}, ${dz}) is ${info.edge} from the ring`);
      }
    }
    // spurs reach their landmarks
    const end = (id) => net.find((l) => l.id === id).pts.at(-1);
    assert.ok(Math.hypot(end('barn')[0] - 0, end('barn')[1] + 10.4) < 0.01);
    assert.ok(Math.hypot(end('stall')[0] + 14.6, end('stall')[1]) < 0.01);
  }
});

test('grass never grows on paths, in the field or in the pond; ground colours are valid', () => {
  const set = T.pathSet(10);
  for (let i = 0; i < 10; i++) {
    const p = L.slotXZ(i, 10);
    assert.equal(T.grassDensity(p.x, p.z, set), 0);
  }
  assert.equal(T.grassDensity(0, 5.5, set), 0, 'south ring path');
  assert.equal(T.grassDensity(15, 3, set), 0, 'pond');
  assert.equal(T.grassDensity(30, 0, set), 0, 'off the island');
  let some = 0;
  for (let x = -18; x <= 18; x += 1.5) for (let z = -18; z <= 18; z += 1.5) if (T.grassDensity(x, z, set) > 0) some++;
  assert.ok(some > 40, 'the meadow has grass');
  for (const [x, z] of [[0, 0], [0, 5.5], [15, 3], [-19, 4], [8, 12.5]]) {
    const c = T.groundColor(x, z, set);
    assert.equal(c.length, 3);
    for (const v of c) assert.ok(v >= 0 && v <= 1);
  }
});

test('noise and PRNG are deterministic', () => {
  assert.equal(N.noise2(1.3, 2.7), N.noise2(1.3, 2.7));
  assert.equal(N.noise2(3, 4), 0, 'zero on lattice points');
  const a = N.rng(5);
  const b = N.rng(5);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  const h = N.hash2(1, 2);
  assert.ok(h >= 0 && h < 1);
});

// ------------------------------------------------------------------ weather, wind, windmill (§4.4, §4.5)

test('market weather → cloud count 8/16/26/34; unknown weather → mild', () => {
  assert.deepEqual(['sunny', 'mild', 'rainy', 'storm'].map(L.cloudCount), [8, 16, 26, 34]);
  assert.equal(L.weatherKey({ key: 'storm', mean: -0.05 }), 'storm');
  assert.equal(L.weatherKey('nope'), 'mild');
  assert.equal(L.weatherKey(null), 'mild');
  assert.deepEqual(WEATHER_KEYS, ['sunny', 'mild', 'rainy', 'storm']);
  assert.ok(WEATHER.storm.light < WEATHER.rainy.light && WEATHER.rainy.light < WEATHER.sunny.light, 'weather dims the lights');
  assert.equal(WEATHER.sunny.rain, 0);
  assert.ok(WEATHER.storm.rain > WEATHER.rainy.rain);
});

test('wind = mean |change_1h|: calm 0.6 · breezy 1.0 · windy 1.6 · gale 2.4', () => {
  assert.deepEqual([0, 0.0029, 0.003, 0.0079, 0.008, 0.0149, 0.015, 0.2].map((m) => L.windLevelOf(m).factor), [0.6, 0.6, 1, 1, 1.6, 1.6, 2.4, 2.4]);
  assert.equal(L.windLevelOf(-0.01).key, 'windy', 'uses |x|');
  assert.equal(L.windFactorSafe(NaN), 1);
  assert.equal(L.windFactorSafe(99), 3);
  assert.equal(L.windFactorSafe(-1), 0);
});

test('windmill bar clock: sail angle = wind spin + bar progress; the tick kick overshoots ~20° and settles', () => {
  assert.ok(near(L.windmillAngle(0, 0.5), Math.PI));
  assert.ok(near(L.windmillAngle(1, 1.7), 1 + Math.PI * 2), 'progress clamps to 1');
  assert.ok(near(L.windmillSpinStep(1, 1), Math.PI * 2 * 0.12), '0.12 rev/s at windFactor 1');
  assert.ok(near(L.windmillSpinStep(1, 2.4), Math.PI * 2 * 0.12 * 2.4));
  assert.ok(near(L.windmillSpinStep(1, 1, 2), 2 * L.windmillSpinStep(1, 1)), 'gust spin-up ×2');
  assert.equal(L.kickProfile(0), 0);
  assert.equal(L.kickProfile(1), 0);
  let peak = 0;
  for (let t = 0; t <= 1; t += 0.01) peak = Math.max(peak, L.kickProfile(t));
  const deg = (peak * 180) / Math.PI;
  assert.ok(deg > 17 && deg <= 21, `peak ${deg}°`);
});

test('gust wave crosses from the west in 1.2 s; lightning respects the photosensitivity limits', () => {
  assert.equal(L.gustFront(-1), -1000);
  assert.equal(L.gustFront(0), L.GUST.fromX);
  assert.ok(L.gustFront(600) > L.GUST.fromX && L.gustFront(600) < L.GUST.toX);
  assert.equal(L.gustFront(1300), -1000);
  // ≤ 1 flash per 8 s, ≤ 30 % step, 120 ms
  const S = L.lightningScheduler(N.rng(3));
  const flashes = [];
  for (let t = 0; t < 600_000; t += 50) {
    const ev = S.poll(t, true);
    if (ev) flashes.push({ t, ...ev });
  }
  assert.ok(flashes.length > 10);
  for (let i = 1; i < flashes.length; i++) assert.ok(flashes[i].t - flashes[i - 1].t >= 8000);
  for (const f of flashes) {
    assert.ok(f.strength > 0 && f.strength <= 0.3);
    assert.ok(f.thunderInMs >= 1000 && f.thunderInMs <= 3000);
  }
  assert.equal(S.poll(10_000_000, false), null, 'inactive → never');
  for (let t = 0; t <= 200; t += 5) assert.ok(L.flashEnvelope(t) >= 0 && L.flashEnvelope(t) <= 1);
  assert.equal(L.flashEnvelope(121), 0);
});

// ------------------------------------------------------------------ money levels (§2.4)

test('setMoney levels are clamped, counts stop at 8 crates / 8 compost steps', () => {
  const m = L.moneyLevels({ towerFill: 1.4, pondFill: -2, siloFill: 'x', crates: { n: 11 }, compost: 3 });
  assert.deepEqual(m, { towerFill: 1, pondFill: 0, siloFill: 0, crates: 8, compost: 3, cratesN: 11, compostN: 3 });
  const f = L.fillsFromLive({ account_usd: 10000, available_usd: 9000, deployed_usd: 600, account_state: { account_value: 10042 } });
  assert.ok(near(f.towerFill, 600 / 10042));
  assert.ok(near(f.pondFill, 0.9));
  assert.ok(near(f.siloFill, 10042 / 20000), 'silo: start line at 0.5');
  assert.equal(L.crateLayout(20).length, 8);
  assert.equal(L.crateLayout(0).length, 0);
  for (let n = 1; n <= 8; n++) assert.ok(L.compostScale(n) > L.compostScale(n - 1));
  assert.equal(L.compostScale(99), L.compostScale(8));
});

// ------------------------------------------------------------------ farmer (§4.5)

test('farmer path graph: BFS reaches every plot stand point and landmark from home', () => {
  for (const count of [10, 13, 15]) {
    const g = L.buildPathGraph(count);
    assert.ok(g.nodes.size >= 20 && g.nodes.size <= 52, `small graph (${g.nodes.size} nodes)`);
    for (let i = 0; i < count; i++) {
      const route = L.bfs(g, 'home', `plot:${i}`);
      assert.ok(route && route[0] === 'home' && route.at(-1) === `plot:${i}`, `plot ${i}`);
    }
    for (const id of ['barn', 'stall', 'pond', 'firepit', 'mailbox']) assert.ok(L.bfs(g, 'home', id));
    const s = L.standXZ(3, count);
    const n = g.nodes.get('plot:3');
    assert.ok(near(n.x, s.x) && near(n.z, s.z));
    // no straight graph edge cuts through a planter box
    for (const [a, nb] of g.adj) {
      for (const b of nb) {
        const A = g.nodes.get(a);
        const B = g.nodes.get(b);
        for (let t = 0; t <= 1; t += 0.05) {
          const x = A.x + (B.x - A.x) * t;
          const z = A.z + (B.z - A.z) * t;
          for (let i = 0; i < count; i++) {
            const c = L.slotXZ(i, count);
            assert.ok(!(Math.abs(x - c.x) < 1.69 && Math.abs(z - c.z) < 1.69), `${a}→${b} crosses box ${i}`);
          }
        }
      }
    }
  }
  // through the column gaps, the walk from home to a back-row middle plot is short (no lap around the field)
  const g10 = L.buildPathGraph(10);
  const route = L.bfs(g10, 'home', 'plot:2');
  assert.ok(L.routeLength(g10, route) < 18, `route length ${L.routeLength(g10, route)}`);
  assert.equal(L.bfs(L.buildPathGraph(10), 'home', 'nowhere'), null);
});

test('farmer admission: a full queue (3) or a target > 18 u away teleports; poses map from effects', () => {
  assert.equal(L.admitTask(0, 5), 'queue');
  assert.equal(L.admitTask(2, 17.9), 'queue');
  assert.equal(L.admitTask(3, 1), 'teleport');
  assert.equal(L.admitTask(0, 18.5), 'teleport');
  assert.equal(L.poseOf('plantOk'), 'dig');
  assert.equal(L.poseOf('water'), 'water');
  assert.equal(L.poseOf('harvest'), 'sickle');
  assert.equal(L.poseOf('pull'), 'hoe');
  assert.equal(L.poseOf('shade'), 'parasol');
  assert.equal(L.poseOf('burnPlot'), 'torch');
  assert.equal(L.poseOf('???'), 'idle');
  assert.equal(L.FARMER.speed, 4);
  assert.equal(L.FARMER.walkHz, 2.2);
});

// ------------------------------------------------------------------ irrigation, easing, tiers, tween

test('irrigation: one spout per slot, pipes never run through a planter box', () => {
  for (const count of [10, 15]) {
    const P = L.pipeLayout(count);
    assert.equal(P.spouts.length, count);
    const lines = [P.main, ...P.rows];
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const [ax, , az] = line[i - 1];
        const [bx, , bz] = line[i];
        for (let t = 0; t <= 1; t += 0.02) {
          const x = ax + (bx - ax) * t;
          const z = az + (bz - az) * t;
          for (let s = 0; s < count; s++) {
            const c = L.slotXZ(s, count);
            assert.ok(!(Math.abs(x - c.x) < 1.7 && Math.abs(z - c.z) < 1.7), `pipe enters box ${s} at (${x}, ${z})`);
          }
        }
      }
    }
    const route = L.pipeRouteTo(count - 1, count);
    const sp = P.spouts[count - 1];
    assert.deepEqual(route.at(-1), [sp.x, L.PIPE.spoutY, sp.z]);
    assert.deepEqual(route[0], [L.PIPE.towerX, L.PIPE.y, L.PIPE.towerZ], 'water starts at the tower');
  }
});

test('easings hit their end points; pop-in peaks at 1.1; the tween settles', () => {
  for (const k of Object.keys(L.EASE)) {
    assert.ok(near(L.EASE[k](0), 0, 1e-9), k);
    assert.ok(near(L.EASE[k](1), 1, 1e-9), k);
  }
  assert.ok(L.EASE.oB(0.7) > 1, 'easeOutBack overshoots');
  assert.ok(near(L.popScale(0.6), 1.1) && L.popScale(1) === 1 && L.popScale(0) === 0);
  const tw = new L.Tween(0).set(1, 0.5);
  let n = 0;
  while (tw.step(0.1)) n++;
  assert.equal(tw.v, 1);
  assert.ok(n >= 4 && n <= 5);
  assert.equal(new L.Tween(0).set(3, 0).v, 3, 'duration 0 jumps (reduced motion)');
});

test('quality tiers (§7.5): grass 900/500/200, Low has no shadows and no critters; governor overrides apply', () => {
  assert.equal(L.tierOf('high').grass, 900);
  assert.equal(L.tierOf('medium').grass, 500);
  assert.equal(L.tierOf('low').grass, 200);
  assert.equal(L.tierOf('low').shadows, 'none');
  assert.equal(L.tierOf('low').critters, false);
  assert.equal(L.tierOf('bogus').name, 'high');
  assert.equal(L.tierOf({ name: 'medium', grass: 250 }).grass, 250, 'grass halved');
  assert.equal(L.tierOf({ tier: 'high', shadows: false }).shadows, 'none', 'shadows off → blobs');
});

// ------------------------------------------------------------------ palette + colour channels (J6)

test('scene palette: valid hexes, sky keyframes, and no money/side signal colours in the scenery', () => {
  for (const [k, v] of Object.entries(PAL)) assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffff, k);
  const forbidden = [0x237a4b, 0xb33a32, 0x2b6cb0, 0x7b4fc4]; // P&L up/down, LONG/SHORT
  for (const [k, v] of Object.entries(PAL)) assert.ok(!forbidden.includes(v), `${k} reuses a J6 signal colour`);
  for (const w of Object.values(WEATHER)) for (const c of [w.top, w.horizon, w.below]) assert.ok(c >= 0 && c <= 0xffffff);
  assert.equal(DAY_KEYS[0].h, 0);
  assert.equal(DAY_KEYS.at(-1).h, 24);
  assert.ok(dayKeyAt(12).sunEl > 40 && dayKeyAt(0).night === 1 && dayKeyAt(12).night === 0);
  assert.equal(rgb01ToHex(hexToRgb01(0x8fd3e8)), 0x8fd3e8);
  assert.equal(mixHex(0x000000, 0xffffff, 0.5), 0x808080);
  assert.ok(luminance(0xffffff) > 0.99 && luminance(0) === 0);
  assert.ok(near(L.hourOf(Date.UTC(2026, 0, 1, 13, 30), 0), 13.5));
  assert.ok(near(L.sunDir(90, 0).y, 1));
});

// ------------------------------------------------------------------ store → world binding

function sampleState(over = {}) {
  return {
    feed: { prices: 'sim', state: 'sim', nextTickMs: 1_000_000, tickMs: 5000, lastBarCloseMs: 990_000, staleCoins: [] },
    net: { ok: true, skewMs: 120 },
    market: { weather: { key: 'rainy', mean: -0.02 }, wind: { key: 'windy', factor: 1.6, mean: 0.01 } },
    live: { account_usd: 10000, available_usd: 9400, deployed_usd: 600, halted: false, account_state: { account_value: 10042, as_of_ms: 5 } },
    marks: null,
    bots: [
      { id: 'a', state: 'closed', realized_pnl: 3.2 },
      { id: 'b', state: 'closed', realized_pnl: -1.1 },
      { id: 'c', state: 'closed', realized_pnl: 0 },
      { id: 'd', state: 'active', realized_pnl: 9 },
    ],
    ui: { unread: 2, dialog: null, pickBean: { id: 7, coin: 'SOL' } },
    settings: { sky: 'day' },
    shelf: { rows: [{ coin: 'BTC' }, { coin: 'SOL' }, { coin: 'DOGE' }, { coin: 'ETH' }, { coin: 'WIF' }, { coin: 'PUMP' }] },
    views: { 0: { state: 'growing', side: 1 } },
    slots: { count: 10 },
    ...over,
  };
}

test('worldInputs maps the store to world levels without deciding what numbers mean', () => {
  const w = worldInputs(sampleState(), { nowMs: 123 });
  assert.equal(w.weather, 'rainy');
  assert.equal(w.wind, 1.6);
  assert.ok(near(w.money.towerFill, 600 / 10042));
  assert.ok(near(w.money.pondFill, 0.94));
  assert.ok(near(w.money.siloFill, 10042 / 20000));
  assert.deepEqual(w.money.crates, { n: 2 }, 'P&L = 0 goes to the crates (≥ 0)');
  assert.deepEqual(w.money.compost, { n: 1 });
  assert.equal(w.feedLook, 'sim');
  assert.equal(w.sundial, true);
  assert.equal(w.unread, 2);
  assert.deepEqual(w.barClock, { nextTickMs: 1_000_000, periodMs: 5000, skewMs: 120 });
  assert.equal(w.skyTimeMs, 990_000, 'sim sky follows market time');
  assert.deepEqual(w.stall, { coins: ['BTC', 'SOL', 'DOGE', 'ETH', 'WIF'], selected: 'SOL' });
  const real = worldInputs(sampleState({ feed: { prices: 'real', state: 'down', nextTickMs: null } }), { nowMs: 77 });
  assert.equal(real.feedLook, 'down');
  assert.equal(real.sundial, false, 'no sundial with real prices');
  assert.equal(real.skyTimeMs, 77);
  assert.equal(real.barClock, null);
  assert.equal(worldInputs(sampleState({ net: { ok: false } })).feedLook, 'offline');
  assert.equal(worldInputs({}).weather, null, 'tolerates an empty store');
});

test('bindWorld drives a (partial) world idempotently and unsubscribes', () => {
  const calls = [];
  const stall = { setState: (s) => calls.push(['stall', s]) };
  const world = {
    landmarks: new Map([['stall', stall]]),
    setWeather: (w) => calls.push(['weather', w.key]),
    setWind: (f) => calls.push(['wind', f]),
    setMoney: (m) => calls.push(['money', m.crates.n]),
    setFeedLook: (s) => calls.push(['feed', s]),
    setSundial: (b) => calls.push(['sundial', b]),
    setHalted: (b) => calls.push(['halted', b]),
    setUnread: (n) => calls.push(['unread', n]),
    syncPlots: (v, n) => calls.push(['plots', n]),
    // no setDaylight / setBarClock: feature-detected
  };
  let state = sampleState();
  const subs = new Set();
  const store = { get: () => state, select: (sel, fn) => (subs.add(fn), () => subs.delete(fn)) };
  const set = (patch) => {
    state = { ...state, ...patch };
    for (const fn of subs) fn(state);
  };
  const sfxCalls = [];
  const sfx = { setWeather: (k) => sfxCalls.push(k), setWind: () => {}, duck: (d) => sfxCalls.push(`duck:${d}`), setNight() {}, play() {} };
  const off = bindWorld({ world, store, sfx });
  const kinds = calls.map((c) => c[0]);
  for (const k of ['weather', 'wind', 'money', 'feed', 'sundial', 'halted', 'unread', 'plots', 'stall']) assert.ok(kinds.includes(k), k);
  const n0 = calls.length;
  set({ diary: [1] }); // unrelated change → no world calls
  assert.equal(calls.length, n0);
  set({ ui: { ...state.ui, unread: 0, dialog: 'harvest' } });
  assert.deepEqual(calls.slice(n0), [['unread', 0]]);
  assert.ok(sfxCalls.includes('rainy') && sfxCalls.includes('duck:true'));
  off();
  set({ market: { weather: { key: 'storm' } } });
  assert.ok(!calls.some((c) => c[1] === 'storm'), 'unsubscribed');
});

// ------------------------------------------------------------------ audio (§8) with a fake AudioContext

function fakeAudio() {
  const made = [];
  class Param {
    constructor(v = 0) {
      this.value = v;
      this.events = [];
    }
    setValueAtTime(v, t) { this.events.push(['set', v, t]); this.value = v; }
    linearRampToValueAtTime(v, t) { this.events.push(['lin', v, t]); this.target = v; }
    exponentialRampToValueAtTime(v, t) { this.events.push(['exp', v, t]); this.target = v; }
    cancelScheduledValues() {}
  }
  class Node {
    constructor(kind) {
      this.kind = kind;
      this.out = [];
      made.push(this);
    }
    connect(n) { this.out.push(n); return n; }
    disconnect() { this.out = []; }
  }
  class Ctx {
    constructor() {
      this.currentTime = 0;
      this.sampleRate = 4000;
      this.state = 'running';
      this.destination = new Node('dest');
      Ctx.instances.push(this);
    }
    createGain() { const n = new Node('gain'); n.gain = new Param(1); return n; }
    createOscillator() { const n = new Node('osc'); n.frequency = new Param(440); n.start = () => (n.started = true); n.stop = () => (n.stopped = true); return n; }
    createBufferSource() { const n = new Node('src'); n.start = () => (n.started = true); n.stop = () => (n.stopped = true); return n; }
    createBiquadFilter() { const n = new Node('filter'); n.frequency = new Param(350); n.Q = new Param(1); return n; }
    createDynamicsCompressor() { const n = new Node('comp'); for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new Param(0); return n; }
    createBuffer(ch, n) { return { getChannelData: () => new Float32Array(n) }; }
    resume() { this.state = 'running'; }
    suspend() { this.state = 'suspended'; }
    close() { this.state = 'closed'; }
  }
  Ctx.instances = [];
  return { Ctx, made };
}

const fakeDoc = () => {
  const l = {};
  return { hidden: false, addEventListener: (t, f) => ((l[t] ||= []).push(f)), removeEventListener: (t, f) => (l[t] = (l[t] || []).filter((x) => x !== f)), fire: (t) => (l[t] || []).slice().forEach((f) => f()), l };
};

test('sfx: default off, the AudioContext is created only by enable(true), buses at −18/−16/−24 dB', () => {
  const { Ctx, made } = fakeAudio();
  const doc = fakeDoc();
  const sfx = createSfx({ settings: { sound: false, volume: 0.5 }, AudioContext: Ctx, doc });
  assert.equal(Ctx.instances.length, 0, 'nothing created at construction');
  assert.equal(sfx.play('pop'), false, 'silent while off');
  assert.equal(sfx.enable(true), true);
  assert.equal(Ctx.instances.length, 1);
  const gains = made.filter((n) => n.kind === 'gain').map((n) => Math.round(20 * Math.log10(n.gain.value) * 10) / 10);
  for (const db of [BUS_DB.ui, BUS_DB.events, BUS_DB.ambience]) assert.ok(gains.includes(db), `bus ${db} dB`);
  const master = made.find((n) => n.kind === 'gain' && n.out.some((o) => o.kind === 'dest'));
  const ramp = master.gain.events.find((e) => e[0] === 'lin');
  assert.ok(near(ramp[1], 10 ** (-14 / 20) * 0.5, 1e-9), 'master = −14 dB × volume');
  assert.ok(near(ramp[2], 0.08, 1e-9), 'fades over 80 ms');
  assert.ok(made.some((n) => n.kind === 'comp'), 'compressor in the chain');
  sfx.enable(false);
  const off = master.gain.events.filter((e) => e[0] === 'lin').at(-1);
  assert.equal(off[1], 0, 'mute fades to 0');
  sfx.dispose();
});

test('sfx: throttles, chime toggle, unknown names, voice cap with ambience stolen first, ducking', () => {
  const { Ctx, made } = fakeAudio();
  let t = 1000;
  const sfx = createSfx({ settings: { sound: false }, AudioContext: Ctx, doc: fakeDoc(), now: () => t });
  sfx.enable(true);
  assert.equal(sfx.play('nope'), false);
  assert.equal(sfx.play('plip'), true);
  assert.equal(sfx.play('plip'), false, 'plip ≤ 1 per 150 ms');
  t += 151;
  assert.equal(sfx.play('plip', { variant: 'close' }), true);
  sfx.setChime(false);
  assert.equal(sfx.play('chime'), false, 'bar chime can be turned off');
  sfx.setChime(true);
  assert.equal(sfx.play('chime'), true);
  // fill the voice pool: ambience voices are stolen before event voices
  for (let i = 0; i < 4; i++) sfx.play('birds');
  for (const n of ['thup', 'pop', 'burble', 'rustle', 'thud', 'fwump', 'twoNoteUp', 'knock', 'hail', 'whoosh', 'crackle', 'glint']) {
    t += 1000;
    sfx.play(n);
  }
  assert.ok(sfx.voiceCount <= MAX_VOICES);
  const ambBus = made.find((n) => n.kind === 'gain' && Math.round(20 * Math.log10(n.gain.value)) === -24);
  sfx.duck(true);
  const duckTo = ambBus.gain.events.filter((e) => e[0] === 'lin').at(-1)[1];
  assert.ok(near(20 * Math.log10(duckTo), -30, 1e-6), 'dialogs duck ambience by 6 dB');
  sfx.dispose();
  assert.equal(Ctx.instances[0].state, 'closed');
});

test('sfx: every §8 recipe exists, plays on an allowed bus, and the rain bed follows the weather table', () => {
  const names = ['windBed', 'birds', 'crickets', 'rain', 'thunder', 'thup', 'pop', 'burble', 'plip', 'tock', 'chime', 'coinBlips', 'rustle', 'thud', 'fwump', 'twoNoteUp', 'knock', 'hail', 'whoosh', 'crackle', 'paperRustle', 'paperFlop', 'glint', 'sigh', 'tickTick', 'mutedBell', 'whirr'];
  const beds = ['windBed', 'rain'];
  for (const n of names) if (!beds.includes(n)) assert.ok(SOUNDS[n], n);
  for (const b of Object.values(SOUNDS)) assert.ok(['ui', 'events', 'ambience'].includes(b));
  assert.deepEqual(RAIN_GAIN, { sunny: 0, mild: 0, rainy: 0.25, storm: 0.45 });
  assert.equal(PENTA.length, 6);
  const { Ctx } = fakeAudio();
  let t = 0;
  const sfx = createSfx({ settings: {}, AudioContext: Ctx, doc: fakeDoc(), now: () => (t += 5000) });
  sfx.enable(true);
  for (const n of Object.keys(SOUNDS)) assert.equal(sfx.play(n, { count: 8, pitch: 3 }), true, n);
  sfx.dispose();
  // no AudioContext in this environment → a graceful no-op
  const none = createSfx({ settings: {}, AudioContext: null, doc: null });
  assert.equal(none.enable(true), typeof globalThis.AudioContext === 'function');
});

test('sfx: a persisted "sound on" waits for the first user gesture; hidden documents suspend the context', () => {
  const { Ctx } = fakeAudio();
  const doc = fakeDoc();
  const sfx = createSfx({ settings: { sound: true }, AudioContext: Ctx, doc });
  assert.equal(Ctx.instances.length, 0, 'not before a gesture');
  doc.fire('pointerdown');
  assert.equal(Ctx.instances.length, 1);
  assert.equal(sfx.enabled, true);
  doc.hidden = true;
  doc.fire('visibilitychange');
  assert.equal(Ctx.instances[0].state, 'suspended');
  doc.hidden = false;
  doc.fire('visibilitychange');
  assert.equal(Ctx.instances[0].state, 'running');
  sfx.dispose();
});

// ------------------------------------------------------------------ module hygiene (§9.1 import rules)

test('WP3 modules import three only through ../three.js and never use innerHTML', () => {
  const dirs = ['web/js/game/world', 'web/js/game/gfx', 'web/js/game/audio'];
  const mine = new Set(['materials.js', 'geom.js', 'palette.js']);
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(ROOT, d))) {
      if (!f.endsWith('.js') || (d.endsWith('gfx') && !mine.has(f))) continue;
      const src = fs.readFileSync(path.join(ROOT, d, f), 'utf8');
      assert.ok(!/from\s+['"]three['"]/.test(src), `${f}: bare 'three' import`);
      assert.ok(!/node_modules|vendor\/three/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), `${f}: direct three path`);
      assert.ok(!/innerHTML/.test(src), `${f}: innerHTML`);
      const pure = ['logic.js', 'terrain.js', 'noise.js', 'bind.js', 'palette.js', 'sfx.js'];
      if (pure.includes(f)) assert.ok(!/three\.js['"]/.test(src), `${f} must stay three-free (Node-testable)`);
    }
  }
});

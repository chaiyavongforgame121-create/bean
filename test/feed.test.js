// test/feed.test.js — the REAL-price feed (GAME-DESIGN §10.9), fully offline.
//
// Hyperliquid is replaced by a deterministic double (`makeHL`) behind an injected `fetch`, and wall time by an
// injected clock (`sleep` advances it), so every scenario — warm-up, real-minute bars, mids-built and flat bars,
// outages, restart replay, re-warm, rate limits, fallback to sim — runs in milliseconds with no network.
// The double also asserts that only POST https://api.hyperliquid.xyz/info is ever called, with one of the three
// read-only request types.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Engine, FeedUnavailableError, TICK_GRACE_MS, MIDS_EVERY_MS, HOLD_RETRY_MS } from '../server/engine.js';
import { MarketFeed, BAR_MS, alignCandles, lastClosedMinute, MIN_REAL_COINS, HL_CONCURRENCY, CLOSE_RETRY_MS } from '../server/market.js';
import {
  HyperliquidClient, WeightLedger, HlError, BACKOFF_MS, BOOT_BUDGET, candleWeight, parseCandles, parseMetaAndAssetCtxs,
} from '../server/hyperliquid.js';
import { Journal } from '../server/journal.js';
import { LiveLayer, entryNotional } from '../server/live.js';
import { Pulse } from '../server/pulse.js';
import { wire, parseConfig, startWithFallback, stateFiles } from '../server/main.js';
import { makeHL, fixture, META, NAMES, T0 } from './fixtures/hl-double.js';

const BTC_CANDLES = fixture('hl-candles-btc.json');
const quiet = () => {};
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `expected ${b}, got ${a}`);

/** A real-feed app wired exactly like the daemon (main.js `wire`), on an injected clock + HL double. */
function realApp({ clock, hl, beans = 120, warmup = 120, saved = null, maxReplayBars, timers } = {}) {
  const journal = new Journal({ keep: 20_000, log: quiet });
  const engine = new Engine({
    config: {
      seed: 42, beans, warmupBars: warmup, feed: 'hyperliquid', log: quiet, maxReplayBars, timers,
      now: () => clock.ms, fetch: hl.fetch, sleep: async (ms) => { clock.ms += Math.max(0, ms); },
    },
    journal,
  });
  const live = new LiveLayer({ config: { accountUsd: 10_000 }, engine, journal, now: () => clock.ms, log: quiet });
  if (saved) {
    journal.restore(saved.journal);
    engine.restore(saved.engine);
    live.restore(saved.live);
  }
  const pulse = new Pulse({ log: quiet });
  wire({ engine, live, pulse });
  const mids = [];
  pulse.subscribe((m) => mids.push(m));
  const events = (kind) => journal.query({ kind, limit: 20_000 }).rows.reverse();
  const snapshot = () => ({ engine: engine.serialize(), live: live.serialize(), journal: journal.serialize() });
  return { engine, live, journal, pulse, mids, events, snapshot };
}

/** A positioned, tradeable bean whose $capital bot clears the $10 minimum (optionally: leverage ≥ minLev). */
function pickBean(engine, { capital = 200, minLev = 1, exclude = [] } = {}) {
  const rows = engine.population.query({ in_position: true, tradeable: true, busted: false, limit: 1000, sort: '-total_return' }).rows;
  const row = rows.find((r) => r.leverage >= minLev && !exclude.includes(r.coin) &&
    entryNotional(r, capital) >= 25 && entryNotional(r, capital) < 4000);
  assert.ok(row, 'a positioned tradeable bean exists');
  return row;
}

/** Tick minute after minute on the scheduler path (clock at boundary + grace each time). */
async function tickMinutes(app, clock, n) {
  for (let i = 0; i < n; i++) {
    clock.ms = app.engine.market.timeMs + 2 * BAR_MS + TICK_GRACE_MS;
    const out = await app.engine.runMinute();
    assert.equal(out.kind, 'tick');
  }
}

// =============================================================================================
describe('alignCandles', () => {
  test('grid: candles land on their minute, gaps forward-fill, leading gaps back-fill (or continue prevClose)', () => {
    const start = BTC_CANDLES[0].t - 2 * BAR_MS; // two empty minutes before the first candle
    const holes = BTC_CANDLES.filter((_, i) => i !== 4 && i !== 5); // a two-minute hole
    const len = 15;
    const a = alignCandles(holes, start, len);
    assert.equal(a.first, 2);
    assert.equal(a.n, holes.length);
    const bar = (b) => Array.from(a.ohlc.subarray(b * 4, b * 4 + 4));
    const c0 = Number(BTC_CANDLES[0].o);
    assert.deepEqual(bar(0), [c0, c0, c0, c0], 'leading gap back-filled from the first candle');
    assert.deepEqual(bar(2), [83000 - 12, 83000, 83000 - 12, 83000].map(Number), 'first candle: o 82988 h 83000 l 82988 c 83000');
    const c3 = Number(BTC_CANDLES[3].c);
    assert.deepEqual(bar(6), [c3, c3, c3, c3], 'hole forward-filled flat at the previous close');
    assert.deepEqual(bar(7), [c3, c3, c3, c3]);
    const last = Number(BTC_CANDLES.at(-1).c);
    assert.deepEqual(bar(14), [last, last, last, last], 'trailing minutes forward-filled');
    // catch-up form: a known previous close fills the lead instead
    const b = alignCandles(holes, start, len, 81_000);
    assert.deepEqual(Array.from(b.ohlc.subarray(0, 4)), [81_000, 81_000, 81_000, 81_000]);
    // nothing on the grid / malformed rows → null
    assert.equal(alignCandles(BTC_CANDLES, start + 100 * BAR_MS, 5), null);
    assert.equal(alignCandles([{ t: start, o: '0', h: '1', l: '1', c: '1' }], start, 3), null);
    assert.equal(alignCandles([], start, 3), null);
  });

  test('parseCandles / parseMetaAndAssetCtxs read the HL shapes (string numbers, index-aligned ctxs)', () => {
    const k = parseCandles(BTC_CANDLES);
    assert.equal(k.length, 11);
    assert.deepEqual(Object.keys(k[0]), ['t', 'T', 'o', 'h', 'l', 'c', 'v', 'n']);
    assert.equal(typeof k[0].o, 'number');
    const m = parseMetaAndAssetCtxs(META);
    assert.equal(m.BTC.sz_decimals, 5);
    assert.equal(m.BTC.max_leverage, 40);
    assert.equal(m.BTC.prev_day_px, 82679);
    assert.equal(m.PUMP.max_leverage, 10, 'the venue value, not the static sim table (5)');
    assert.equal(m.FTM.delisted, true);
    for (const c of NAMES) assert.ok(m[c] && !m[c].delisted, `${c} listed in the fixture`);
  });
});

// =============================================================================================
describe('rate limiter (WeightLedger + HyperliquidClient)', () => {
  test('ledger: rolling 60 s window, fits / waitMs', () => {
    const clock = { ms: 0 };
    const l = new WeightLedger({ budget: 100, now: () => clock.ms });
    l.record(60);
    clock.ms = 30_000;
    l.record(30);
    assert.equal(l.used(), 90);
    assert.equal(l.fits(10), true);
    assert.equal(l.fits(11), false);
    assert.equal(l.waitMs(20), 30_001, 'until the first entry leaves the window');
    assert.equal(l.waitMs(101), Infinity);
    clock.ms = 60_001;
    assert.equal(l.used(), 30);
  });

  test('allMids/meta are SKIPPED (never sent) over budget; candles QUEUE until the budget allows, or skip past a deadline', async () => {
    const clock = { ms: 1_000_000 };
    const hl = makeHL(clock);
    const client = new HyperliquidClient({ fetch: hl.fetch, now: () => clock.ms, sleep: async (ms) => { clock.ms += ms; }, budget: 50 });
    client.ledger.record(49);
    await assert.rejects(client.metaAndAssetCtxs(), (e) => e instanceof HlError && e.skipped);
    assert.equal(hl.calls.metaAndAssetCtxs, 0, 'skipped requests are not sent');
    // allMids (weight 2, the heartbeat) may use the boot ceiling — but not beyond it
    await client.allMids();
    assert.equal(hl.calls.allMids, 1);
    client.ledger.record(BOOT_BUDGET - client.ledger.used());
    await assert.rejects(client.allMids(), (e) => e instanceof HlError && e.skipped);
    assert.equal(hl.calls.allMids, 1, 'skipped requests are not sent');
    // queue: weight 20 waits for the window to roll
    const t0 = clock.ms;
    const rows = await client.candles('BTC', lastClosedMinute(clock.ms), lastClosedMinute(clock.ms) + BAR_MS - 1);
    assert.equal(rows.length, 1);
    assert.ok(clock.ms - t0 > 60_000 - 1, 'waited for the ledger');
    // past a deadline → skipped without sending
    client.ledger.record(49);
    const before = hl.calls.candleSnapshot;
    await assert.rejects(client.candles('BTC', 0, BAR_MS, { deadlineMs: clock.ms + 1000 }), (e) => e.skipped);
    assert.equal(hl.calls.candleSnapshot, before);
    // a big candle request is charged 20 + 1 per 60 candles
    assert.equal(candleWeight(2880), 68);
    assert.equal(candleWeight(1), 20);
  });

  test('HTTP 429 → 15 s back-off for every request, then recovery', async () => {
    const clock = { ms: 5_000_000 };
    const hl = makeHL(clock);
    const client = new HyperliquidClient({ fetch: hl.fetch, now: () => clock.ms, sleep: async (ms) => { clock.ms += ms; } });
    hl.status = 429;
    await assert.rejects(client.allMids(), (e) => e.status === 429);
    assert.equal(client.inBackoff(), true);
    assert.equal(client.stats.rate_limited, 1);
    hl.status = null;
    await assert.rejects(client.allMids(), (e) => e.skipped, 'skip-mode requests do not wait out a back-off');
    assert.equal(hl.calls.allMids, 0);
    clock.ms += BACKOFF_MS;
    const mids = await client.allMids();
    assert.ok(mids.BTC > 0);
    assert.ok(!('@1' in mids) || typeof mids['@1'] === 'number');
  });
});

// =============================================================================================
describe('real feed: warm-up, metadata, bars on real minutes', () => {
  test('warm-up ends at the last closed minute; coin info and day stats come from metaAndAssetCtxs', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const app = realApp({ clock, hl });
    await app.engine.start();
    const m = app.engine.market;
    assert.equal(m.timeMs, lastClosedMinute(T0), 'bar index ↔ wall-clock minute');
    assert.equal(m.barIdx, 119);
    assert.equal(m.startMs, m.timeMs - 119 * BAR_MS);
    const btc = m.closes('BTC');
    assert.equal(btc.length, 120);
    near(btc.at(-1), hl.pxAt('BTC', m.timeMs + BAR_MS));
    near(btc[0], hl.pxAt('BTC', m.startMs + BAR_MS));
    assert.deepEqual(hl.calls, { allMids: 1, metaAndAssetCtxs: 1, candleSnapshot: 16 });
    const status = app.engine.status();
    assert.ok(status.feed.weight_60s <= BOOT_BUDGET, `warm-up weight ${status.feed.weight_60s} within the boot budget`);
    assert.equal(status.feed.weight_60s, 20 + 2 + 16 * candleWeight(120));

    // events: one warmup_finished, then the first feed_status
    assert.deepEqual(app.journal.query({ limit: 10 }).rows.reverse().map((r) => r.kind), ['warmup_finished', 'feed_status']);
    const fs0 = app.events('feed_status')[0];
    assert.equal(fs0.state, 'live');
    assert.equal(fs0.prev, null);
    assert.equal(fs0.source, 'hyperliquid');

    // coinInfo / listing from HL `universe`, change_24h from prevDayPx (the HL definition)
    assert.deepEqual(m.coinInfo('PUMP'), { coin: 'PUMP', index: NAMES.indexOf('PUMP'), max_leverage: 10, sz_decimals: 0 });
    assert.equal(m.coins.find((c) => c.coin === 'PUMP').max_leverage, 10);
    const snap = m.snapshot().find((c) => c.coin === 'BTC');
    const px = hl.pxAt('BTC', T0);
    near(snap.px, px);
    assert.equal(snap.mid, snap.px, 'the market op `mid` means the live mid now');
    assert.equal(snap.px_ms, T0);
    near(snap.change_24h, px / 82679 - 1);
    near(snap.close, btc.at(-1));
    near(snap.change_1h, btc.at(-1) / btc.at(-61) - 1);
    assert.equal(snap.prev_day_px, 82679);
    assert.equal(snap.funding_1h, 0.0000051759);
    assert.equal(snap.source, 'hyperliquid');
    for (const k of ['mark_px', 'oracle_px', 'open_interest', 'day_ntl_vlm']) assert.equal(typeof snap[k], 'number', k);

    // health / status in real mode
    const h = app.engine.health();
    assert.equal(h.prices, 'real');
    assert.equal(h.paper, true);
    assert.equal(h.feed, 'hyperliquid');
    assert.equal(h.feed_state, 'live');
    assert.deepEqual(h.daemon, { running: false, tick_ms: 60_000, aligned: true, next_tick_ms: m.timeMs + 2 * BAR_MS + TICK_GRACE_MS });
    assert.equal(status.feed.real, true);
    assert.equal(status.feed.state, 'live');
    assert.deepEqual(status.feed.stale_coins, []);
    assert.equal(status.feed.fallback, null);
    assert.equal(status.feed.real_available, null);
    assert.equal(status.feed.mids_ms, T0);
    assert.equal(status.feed.last_bar_close_ms, m.timeMs + BAR_MS);
    assert.equal(status.feed.lag_bars, 0);
    assert.equal(status.feed.last_gap, null);
    assert.deepEqual(Object.keys(status.feed.requests).sort(), ['allMids', 'candleSnapshot', 'errors', 'metaAndAssetCtxs', 'rate_limited', 'skipped']);
  });

  test('a delisted coin is unlisted on the venue (not tradeable); feed state live → delayed (old mids) → live', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const app = realApp({ clock, hl });
    await app.engine.start();
    const vvv = hl.meta[0].universe.find((u) => u.name === 'VVV');
    vvv.isDelisted = true;
    assert.equal(await app.engine.market.refreshMeta(), true);
    assert.equal(app.engine.market.coinInfo('VVV'), null);
    const row = app.engine.population.query({ coin: 'VVV', limit: 1 }).rows[0];
    if (row) assert.equal(row.venue_reason, 'unlisted');

    clock.ms += 20_000; // allMids now 20 s old
    assert.equal(app.engine.feedState().state, 'delayed');
    assert.equal(await app.engine.pollMids(), true);
    assert.equal(app.engine.feedState().state, 'live');
    hl.status = 429; // rate limited → back-off → delayed
    clock.ms += MIDS_EVERY_MS;
    assert.equal(await app.engine.pollMids(), false);
    assert.equal(app.engine.feedState().state, 'delayed');
    const kinds = app.events('feed_status').map((e) => `${e.prev}→${e.state}`);
    assert.ok(kinds.includes('live→delayed'), kinds.join(' '));
  });

  test('the minute timer fires at the next boundary + 2 s; mids every 5 s; tick_completed carries closed_ms/next_tick_ms/source', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const pending = [];
    const timers = {
      setTimeout: (fn, ms) => { const t = { fn, ms, at: clock.ms + ms }; pending.push(t); return t; },
      clearTimeout: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
      setInterval: () => { throw new Error('real mode uses no interval'); },
      clearInterval: () => {},
    };
    const app = realApp({ clock, hl, timers });
    await app.engine.start();
    app.engine.run();
    const boundary = Math.floor(T0 / BAR_MS) * BAR_MS;
    const minute = pending.find((t) => t.at === boundary + BAR_MS + TICK_GRACE_MS);
    assert.ok(minute, `a timer at boundary + 60 s + 2 s; got ${pending.map((t) => t.ms)}`);
    assert.ok(pending.some((t) => t.ms === MIDS_EVERY_MS), 'the allMids poller');
    assert.equal(app.engine.health().daemon.running, true);
    assert.equal(app.engine.health().daemon.next_tick_ms, boundary + BAR_MS + TICK_GRACE_MS);

    // fire the mids timer: a `mids` pulse with every coin
    const midsTimer = pending.find((t) => t.ms === MIDS_EVERY_MS);
    pending.splice(pending.indexOf(midsTimer), 1);
    clock.ms = midsTimer.at;
    await midsTimer.fn();
    assert.equal(app.mids.length, 1);
    assert.equal(Object.keys(app.mids[0].px).length, 16);
    assert.ok(pending.some((t) => t.fn !== minute.fn && t.ms <= MIDS_EVERY_MS), 'the poller re-arms itself');

    // fire the minute timer
    pending.splice(pending.indexOf(minute), 1);
    clock.ms = minute.at;
    await minute.fn();
    const ticks = app.events('tick_completed');
    assert.equal(ticks.length, 1);
    const t = ticks[0];
    assert.equal(t.time_ms, boundary, 'the bar that just closed');
    assert.equal(t.closed_ms, boundary + BAR_MS);
    assert.equal(t.next_tick_ms, boundary + 2 * BAR_MS + TICK_GRACE_MS);
    assert.equal(t.source, 'hyperliquid');
    assert.ok(pending.some((p) => p.at === boundary + 2 * BAR_MS + TICK_GRACE_MS), 'next minute scheduled');
    assert.deepEqual(app.engine.status().feed.bar_sources, { candle: 16, mids: 0, flat: 0 });
    assert.ok(app.mids.length >= 2, 'a mids pulse after the tick too');
    app.engine.stop();
    assert.equal(app.engine.health().daemon.running, false);
    assert.equal(pending.length, 0, 'stop() clears every timer');
  });

  test('per coin: candle → bar; no candle → bar from the minute\'s mid samples; neither → flat bar, coin stale', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const app = realApp({ clock, hl });
    await app.engine.start();
    await tickMinutes(app, clock, 1);
    const m = app.engine.market;
    const M2 = m.timeMs + BAR_MS; // the minute in progress
    const solPrev = m.mid('SOL');
    const tiaPrev = m.mid('TIA');
    hl.noMids.add('TIA');
    hl.noCandleAt.add(`SOL@${M2}`).add(`TIA@${M2}`);
    for (const [k, solPx] of [[1, solPrev * 1.01], [2, solPrev * 1.03], [3, solPrev * 0.99], [4, solPrev * 1.004]]) {
      hl.mid.SOL = solPx;
      clock.ms = M2 + k * 5000;
      assert.equal(await app.engine.pollMids(), true);
    }
    const frames = [];
    const orig = m.nextSync.bind(m);
    m.nextSync = () => { const f = orig(); frames.push(f); return f; };
    clock.ms = M2 + BAR_MS + TICK_GRACE_MS;
    const out = await app.engine.runMinute();
    assert.equal(out.kind, 'tick');
    assert.deepEqual(out.sources, { candle: 14, mids: 1, flat: 1 });
    const bar = frames[0].bars;
    assert.equal(frames[0].timeMs, M2);
    near(bar.SOL.o, solPrev, 1e-12);
    near(bar.SOL.h, solPrev * 1.03);
    near(bar.SOL.l, solPrev * 0.99);
    near(bar.SOL.c, solPrev * 1.004);
    assert.deepEqual(bar.TIA, { o: tiaPrev, h: tiaPrev, l: tiaPrev, c: tiaPrev }, 'flat at the previous close');
    near(bar.BTC.c, hl.pxAt('BTC', M2 + BAR_MS), 1e-12);
    assert.equal(m.isStale('TIA'), true);
    assert.equal(m.isStale('SOL'), false);
    const st = app.engine.status().feed;
    assert.deepEqual(st.stale_coins, ['TIA']);
    assert.equal(st.stale, 1);
    assert.deepEqual(st.bar_sources, { candle: 14, mids: 1, flat: 1 });
    const fsx = app.events('feed_status').at(-1);
    assert.deepEqual(fsx.stale_coins, ['TIA'], 'feed_status when the stale set changes');
    assert.equal(app.mids.at(-1).stale.includes('TIA'), true);
    assert.equal(m.snapshot().find((c) => c.coin === 'TIA').stale, true);
  });

  test('bots on a stale coin are frozen: no mirror, no liquidation on marks, mark kept; resume waits; pause still fills', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const app = realApp({ clock, hl });
    await app.engine.start();
    const bean = pickBean(app.engine);
    const bot = app.live.create({ bean: bean.id, capital_usd: 200 });
    assert.notEqual(bot.real.szi, 0);
    const coin = bot.coin;
    const fillTime = app.live.fills({ limit: 1 }).rows[0].time_ms;
    assert.equal(fillTime, T0, 'an out-of-tick fill is stamped with the wall clock');
    near(app.live.fills({ limit: 1 }).rows[0].px, hl.pxAt(coin, T0) * (1 + Math.sign(bot.real.szi) * 0.00015), 1e-9);
    await tickMinutes(app, clock, 1);

    // the coin goes quiet: no candle and no mids for the next minute
    const M2 = app.engine.market.timeMs + BAR_MS;
    hl.noMids.add(coin);
    hl.noCandleAt.add(`${coin}@${M2}`);
    clock.ms = M2 + 30_000;
    await app.engine.pollMids();
    clock.ms = M2 + BAR_MS + TICK_GRACE_MS;
    const before = app.live.botDetail(bot.id).bot;
    await app.engine.runMinute();
    const frozen = app.live.botDetail(bot.id).bot;
    assert.equal(frozen.price_stale, true);
    assert.equal(frozen.real.szi, before.real.szi);
    assert.equal(frozen.mark_px, before.mark_px, 'the mark stays at the last real price');
    assert.equal(frozen.fills, before.fills);
    // a crash price on a stale coin is ignored by the marks
    const crash = Math.sign(bot.real.szi) > 0 ? 0.01 : 100;
    app.live.markLive({ px: { [coin]: frozen.mark_px * crash }, stale: [coin], t: clock.ms });
    assert.equal(app.live.botDetail(bot.id).bot.state, 'active', 'no liquidation while frozen');
    assert.equal(app.mids.at(-1).bots[bot.id].price_stale, true);
    assert.equal(app.live.status().stale_coins.includes(coin), true);

    // pause is allowed (fills at the last real price, wall-clock stamp); resume waits for a live price
    const paused = app.live.pause({ id: bot.id });
    assert.equal(paused.state, 'paused');
    const close = app.live.fills({ limit: 1 }).rows[0];
    assert.equal(close.time_ms, clock.ms);
    assert.throws(() => app.live.resume({ id: bot.id }), (e) => e.status === 409 && /delayed/.test(e.message));
    // the coin comes back
    hl.noMids.delete(coin);
    clock.ms += 5000;
    await app.engine.pollMids();
    assert.equal(app.engine.market.isStale(coin), false);
    assert.equal(app.live.resume({ id: bot.id }).state, 'active');
  });

  test('marks every ~5 s: unrealized from the live mid, liquidation on a cross happens NOW (fill at liquidation_px, wall clock)', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const app = realApp({ clock, hl, beans: 600 });
    await app.engine.start();
    const bean = pickBean(app.engine, { minLev: 4 });
    const bot = app.live.create({ bean: bean.id, capital_usd: 200 });
    const side = Math.sign(bot.real.szi);
    assert.notEqual(side, 0);
    clock.ms += 5000;
    await app.engine.pollMids();
    const marked = app.mids.at(-1);
    const b = marked.bots[bot.id];
    const mid = hl.pxAt(bot.coin, clock.ms);
    near(b.mark_px, mid, 1e-9);
    near(b.unrealized_pnl, bot.real.szi * (mid - bot.real.entry_px), 1e-5);
    assert.equal(b.as_of_ms, clock.ms);
    assert.equal(marked.prices, 'real');
    assert.equal(marked.source, 'hyperliquid');
    assert.deepEqual(Object.keys(marked), ['kind', 't', 'source', 'prices', 'px', 'px_ms', 'stale', 'bar', 'bots', 'account']);
    assert.equal(marked.px_ms[bot.coin], clock.ms);
    const row = app.live.botDetail(bot.id).bot;
    assert.equal(row.mark_ms, clock.ms);
    near(row.mark_px, mid, 1e-9);

    // a real crash through the liquidation price, between bars
    const liq = app.live.botDetail(bot.id).bot.real.liquidation_px;
    hl.mid[bot.coin] = side > 0 ? liq * 0.99 : liq * 1.01;
    clock.ms += 5000;
    const tickBefore = app.engine.ticks;
    await app.engine.pollMids();
    assert.equal(app.engine.ticks, tickBefore, 'not waiting for the next bar');
    const after = app.live.botDetail(bot.id).bot;
    assert.equal(after.state, 'paused');
    assert.equal(after.note, 'liquidated');
    assert.equal(after.real.szi, 0);
    const fill = app.events('bot_fill').at(-1);
    assert.equal(fill.liquidation, true);
    assert.equal(fill.time_ms, clock.ms, 'wall-clock stamp');
    near(fill.px, liq, 1e-9);
    assert.equal(fill.fee, 0);
    assert.equal(app.events('bot_paused').at(-1).reason, 'liquidated');
  });
});

// =============================================================================================
describe('real feed: outages, catch-up, restart replay, re-warm', () => {
  test('HL down: hold (no invented bars), lag_bars, state down after 60 s, new exposure refused; back → one replay, one tick_completed, one feed_gap', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const app = realApp({ clock, hl });
    await app.engine.start();
    await tickMinutes(app, clock, 1);
    const M = app.engine.market.timeMs;
    const tick0 = app.engine.ticks;
    const bean = pickBean(app.engine);

    hl.down = true;
    clock.ms = M + 2 * BAR_MS + TICK_GRACE_MS;
    const held = await app.engine.runMinute();
    assert.equal(held.kind, 'hold');
    assert.equal(app.engine.ticks, tick0, 'no bar while every coin would be flat');
    assert.equal(app.engine.market.timeMs, M);
    const st = app.engine.status().feed;
    assert.equal(st.lag_bars, 1);
    assert.equal(st.state, 'down', `${clock.ms - M - BAR_MS} ms without a successful HL response`);
    assert.equal(app.engine.health().feed_state, 'down');
    assert.equal(st.stale_coins.length, 16, 'every coin is stale: bots frozen');
    const attempts = 1 + CLOSE_RETRY_MS.length;
    assert.ok(hl.failures <= attempts * HL_CONCURRENCY, `a network failure ends the attempt: ≤ one batch per attempt, not 16 requests (${hl.failures})`);
    assert.equal(app.events('feed_status').at(-1).state, 'down');
    assert.match(app.engine.canOpen('BTC'), /down/);
    assert.throws(() => app.live.create({ bean: bean.id, capital_usd: 200 }), (e) => e.status === 409 && /down/.test(e.message));

    // a later retry still holds and the lag grows with the clock
    clock.ms += HOLD_RETRY_MS + BAR_MS;
    assert.equal((await app.engine.runMinute()).kind, 'hold');
    assert.equal(app.engine.status().feed.lag_bars, 2);

    // HL is back: the missed minutes replay with ONE tick_completed and ONE feed_gap
    hl.down = false;
    const ticksBefore = app.events('tick_completed').length;
    const gapsBefore = app.events('feed_gap').length;
    clock.ms = M + 5 * BAR_MS + TICK_GRACE_MS; // minutes M+1 … M+4 have closed
    const out = await app.engine.runMinute();
    assert.equal(out.kind, 'replay');
    assert.equal(out.bars, 4);
    assert.equal(app.engine.market.timeMs, M + 4 * BAR_MS);
    assert.equal(app.engine.ticks, tick0 + 4);
    assert.equal(app.events('tick_completed').length, ticksBefore + 1);
    const gaps = app.events('feed_gap');
    assert.equal(gaps.length, gapsBefore + 1);
    assert.deepEqual(
      (({ from_ms, to_ms, bars, mode, reason }) => ({ from_ms, to_ms, bars, mode, reason }))(gaps.at(-1)),
      { from_ms: M + BAR_MS, to_ms: M + 5 * BAR_MS, bars: 4, mode: 'replay', reason: 'outage' },
    );
    near(app.engine.market.mid('BTC'), hl.pxAt('BTC', M + 5 * BAR_MS), 1e-12);
    const st2 = app.engine.status().feed;
    assert.equal(st2.lag_bars, 0);
    assert.equal(st2.last_gap.mode, 'replay');
    await app.engine.pollMids();
    assert.equal(app.engine.feedState().state, 'live');
    assert.equal(app.events('feed_status').at(-1).state, 'live');
  });

  test('catch-up replay mirrors bots per bar even when the hold retry runs before any allMids (every mid minutes old)', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const app = realApp({ clock, hl, beans: 400, warmup: 300 });
    await app.engine.start();
    await app.engine.pollMids();
    const rows = app.engine.population.query({ in_position: true, tradeable: true, busted: false, limit: 1000, distinct_coin: true, sort: '-total_return' }).rows;
    for (const r of rows.slice(0, 8)) { try { app.live.create({ bean: r.id, capital_usd: 300 }); } catch { /* below min order */ } }
    assert.ok(app.live.bots({ state: 'open' }).rows.length >= 4, 'several bots planted');
    for (let i = 0; i < 3; i++) {
      clock.ms = app.engine.market.timeMs + 2 * BAR_MS + TICK_GRACE_MS;
      await app.engine.pollMids();
      assert.equal((await app.engine.runMinute()).kind, 'tick');
    }
    // an 8-minute outage: the scheduler holds
    hl.down = true;
    for (let i = 0; i < 8; i++) { clock.ms += BAR_MS; await app.engine.runMinute(); }
    assert.equal(app.engine.feedState().state, 'down');
    // HL is back and the hold retry fires FIRST: every live mid is minutes old by the wall clock
    hl.down = false;
    clock.ms += 3000;
    assert.equal(app.engine.market.staleCoins().length, 16);
    const before = Object.fromEntries(app.live.bots({ state: 'open' }).rows.map((b) => [b.id, b.last_reconcile_ms]));
    const fills0 = app.events('bot_fill').length;
    const out = await app.engine.runMinute();
    assert.equal(out.kind, 'replay');
    const after = app.live.bots({ state: 'open' }).rows;
    for (const b of after) {
      assert.notEqual(b.last_reconcile_ms, before[b.id], `${b.id} (${b.coin}) reconciled during the replay`);
      if (b.state !== 'active') continue;
      const bean = app.engine.population.row(b.bean);
      assert.equal(Math.sign(b.real.szi), Math.sign(bean.side || 0), `${b.id} (${b.coin}) mirrors its bean after the replay`);
    }
    const replayed = app.events('bot_fill').slice(fills0);
    assert.ok(replayed.length >= 1, 'the bots traded the bars they missed');
    for (const f of replayed) assert.ok(f.time_ms <= app.engine.market.timeMs + BAR_MS, 'stamped with its bar close');
  });

  test('marks carry the age of their prices: an old mid never looks fresh, planting waits for a live mid, rows report price_stale during an outage', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const app = realApp({ clock, hl });
    await app.engine.start();
    await app.engine.pollMids();
    const midsAt = clock.ms;
    const bean = pickBean(app.engine);
    const bot = app.live.create({ bean: bean.id, capital_usd: 200 });
    assert.equal(bot.mark_ms, midsAt);
    assert.equal(app.live.status().account_state.as_of_ms, midsAt, 'account as_of = the oldest open mark, not the request time');

    // allMids starts failing; 40 s later the last mid is past the 15 s live window
    hl.down = true;
    clock.ms = midsAt + 40_000;
    await app.engine.pollMids();
    const m = app.engine.marks();
    assert.ok(m.t <= midsAt, `marks.t (${clock.ms - m.t} ms old) is the time of the prices behind it, not now`);
    assert.ok(m.px_ms[bean.coin] <= midsAt);
    assert.match(app.engine.canOpen(bean.coin), /delayed/, 'no paper fill at a price older than 15 s');
    assert.throws(() => app.live.create({ bean: pickBean(app.engine, { exclude: [bean.coin] }).id, capital_usd: 200 }), (e) => e.status === 409);
    app.live.markLive(m);
    const row = app.live.botDetail(bot.id).bot;
    assert.ok(row.mark_ms <= midsAt && row.real.as_of_ms <= midsAt, 'a re-mark at an old price keeps the old stamp');
    assert.ok(app.live.status().account_state.as_of_ms <= midsAt);

    // > 60 s: the coin is stale NOW — rows say so even though no mark or tick has run since
    clock.ms = midsAt + 70_000;
    assert.equal(app.live.bots({ state: 'open' }).rows.find((b) => b.id === bot.id).price_stale, true);
    assert.equal(app.live.marksPayload().bots[bot.id].price_stale, true);
  });

  test('an outage mid-minute still produces that bar from the mid samples (bar_src mids)', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const app = realApp({ clock, hl });
    await app.engine.start();
    await tickMinutes(app, clock, 1);
    const M2 = app.engine.market.timeMs + BAR_MS;
    clock.ms = M2 + 20_000;
    await app.engine.pollMids();
    hl.down = true;
    clock.ms = M2 + BAR_MS + TICK_GRACE_MS;
    const out = await app.engine.runMinute();
    assert.equal(out.kind, 'tick');
    assert.deepEqual(out.sources, { candle: 0, mids: 16, flat: 0 });
  });

  test('restart after 10 min: restore + replay the gap inside start() (reason restart), bots and journal kept', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const a = realApp({ clock, hl });
    await a.engine.start();
    await tickMinutes(a, clock, 1);
    await a.engine.pollMids(); // planting needs a live mid (≤ 15 s): the last allMids was before the tick
    const bean = pickBean(a.engine);
    const bot = a.live.create({ bean: bean.id, capital_usd: 200 });
    const saved = a.snapshot();
    const M = a.engine.market.timeMs;
    const lastSeq = a.journal.lastSeq;
    const tick0 = a.engine.ticks;

    clock.ms = M + 11 * BAR_MS + TICK_GRACE_MS; // 10 more minutes closed while "stopped"
    const b = realApp({ clock, hl, saved });
    const res = await b.engine.start();
    assert.equal(res.restored, true);
    assert.equal(b.engine.market.timeMs, M + 10 * BAR_MS);
    assert.equal(b.engine.ticks, tick0 + 10);
    const news = b.journal.since(lastSeq);
    assert.equal(news.filter((r) => r.kind === 'tick_completed').length, 1, 'only the last replayed bar');
    const gap = news.filter((r) => r.kind === 'feed_gap');
    assert.equal(gap.length, 1);
    assert.equal(gap[0].reason, 'restart');
    assert.equal(gap[0].mode, 'replay');
    assert.equal(gap[0].bars, 10);
    assert.equal(news.filter((r) => r.kind === 'warmup_finished').length, 0);
    assert.ok(news[0].seq === lastSeq + 1, 'journal seq continues');
    // replayed fills are stamped with their bar's close (old), so the client applies them without animation
    for (const f of news.filter((r) => r.kind === 'bot_fill')) assert.ok(f.time_ms <= M + 10 * BAR_MS + BAR_MS && f.time_ms > M, `${f.time_ms}`);
    const kept = b.live.botDetail(bot.id).bot;
    assert.equal(kept.state, 'active');
    assert.equal(kept.bean, bean.id);
    assert.equal(b.engine.status().from_snapshot, true);
  });

  test('restart after 3 days (gap > 2880): re-warm in place keeps bots and journal; tick counter stays monotonic', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const a = realApp({ clock, hl });
    await a.engine.start();
    const bean = pickBean(a.engine);
    const bot = a.live.create({ bean: bean.id, capital_usd: 200 });
    const saved = a.snapshot();
    const lastSeq = a.journal.lastSeq;
    const tick0 = a.engine.ticks;

    clock.ms = T0 + 3 * 86_400_000;
    const b = realApp({ clock, hl, saved });
    await b.engine.start();
    const g = Math.round((lastClosedMinute(clock.ms) - lastClosedMinute(T0)) / BAR_MS);
    assert.equal(g, 4320);
    assert.equal(b.engine.market.timeMs, lastClosedMinute(clock.ms), 'a fresh warm-up ending now');
    assert.equal(b.engine.market.barIdx, 119);
    assert.equal(b.engine.ticks, tick0 + g);
    const news = b.journal.since(lastSeq);
    const gap = news.find((r) => r.kind === 'feed_gap');
    assert.deepEqual((({ bars, mode, reason }) => ({ bars, mode, reason }))(gap), { bars: 4320, mode: 'rewarm', reason: 'restart' });
    assert.equal(news.filter((r) => r.kind === 'warmup_finished').length, 1);
    assert.equal(b.journal.query({ kind: 'bot_created' }).total, 1, 'the journal is kept');
    const kept = b.live.botDetail(bot.id).bot;
    assert.equal(kept.state, 'active');
    assert.equal(kept.real.as_of_ms, clock.ms, 'marked to the live price right away');
    near(kept.mark_px, hl.pxAt(bot.coin, clock.ms), 1e-9);
    assert.equal(b.engine.population.size, 120, 'same population size (same seed, same genomes)');
    assert.equal(b.engine.population.row(bean.id).coin, bean.coin);
    assert.equal(b.engine.status().feed.last_gap.mode, 'rewarm');
  });

  test('a running outage longer than maxReplayBars re-warms too (reason outage)', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const app = realApp({ clock, hl, maxReplayBars: 3 });
    await app.engine.start();
    await tickMinutes(app, clock, 1);
    clock.ms = app.engine.market.timeMs + 6 * BAR_MS + TICK_GRACE_MS; // 5 closed minutes missing
    const out = await app.engine.runMinute();
    assert.equal(out.kind, 'rewarm');
    assert.equal(app.events('feed_gap').at(-1).reason, 'outage');
    assert.equal(app.engine.market.timeMs, lastClosedMinute(clock.ms));
  });

  test('restart while HL is unreachable: restore and hold (state down); catch up when it returns', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const a = realApp({ clock, hl });
    await a.engine.start();
    const saved = a.snapshot();
    hl.down = true;
    clock.ms = T0 + 5 * BAR_MS;
    const b = realApp({ clock, hl, saved });
    await b.engine.start();
    assert.equal(b.engine.feedState().state, 'down');
    assert.ok(b.engine.status().feed.lag_bars >= 1);
    hl.down = false;
    const out = await b.engine.runMinute();
    assert.equal(out.kind, 'replay');
    assert.equal(b.events('feed_gap').at(-1).reason, 'restart');
  });

  test('tick is refused with real prices (engine.advance → 409); a real tick without a staged bar is refused', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    const app = realApp({ clock, hl });
    await app.engine.start();
    await assert.rejects(app.engine.advance(1), (e) => e.status === 409 && /sim feed/.test(e.message));
    assert.throws(() => app.engine.tick(), (e) => e.status === 409);
  });
});

// =============================================================================================
describe('fallback to sim at boot', () => {
  test('a fresh real start that cannot warm up throws FeedUnavailableError (meta/mids unreachable, or < 8 coins with candles)', async () => {
    const clock = { ms: T0 };
    const hl = makeHL(clock);
    hl.down = true;
    await assert.rejects(realApp({ clock, hl }).engine.start(), (e) => e instanceof FeedUnavailableError && /metaAndAssetCtxs/.test(e.reason));
    hl.down = false;
    for (const c of NAMES.slice(0, 16 - (MIN_REAL_COINS - 1))) hl.noCandles.add(c);
    await assert.rejects(realApp({ clock, hl }).engine.start(), (e) => e instanceof FeedUnavailableError && /only 7 coins/.test(e.reason));
    // with exactly 8 coins it warms up (the others flat at their real mid, stale until they trade)
    hl.noCandles.delete(NAMES[0]);
    const app = realApp({ clock, hl });
    await app.engine.start();
    assert.equal(app.engine.market.isStale(NAMES[0]), false);
    assert.equal(app.engine.market.isStale(NAMES[1]), true);
  });

  test('startWithFallback: sim feed with the SIM state files + status.feed.fallback; the probe sets real_available', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bean-feed-'));
    try {
      const clock = { ms: Date.now() };
      const hl = makeHL(clock);
      hl.down = true;
      const config = { ...parseConfig(['--data', dir, '--beans', '60', '--warmup', '90'], {}), fetch: hl.fetch };
      assert.equal(config.feed, 'hyperliquid');
      const lines = [];
      const { runtime, files, config: eff } = await startWithFallback({ config, version: 't', log: (l) => lines.push(l) });
      assert.equal(eff.feed, 'sim');
      assert.equal(eff.fallback.from, 'hyperliquid');
      assert.match(eff.fallback.reason, /metaAndAssetCtxs/);
      assert.equal(path.basename(files.stateFile), 'state.json');
      assert.equal(path.basename(files.journalFile), 'journal.jsonl');
      assert.ok(lines.some((l) => /falling back to SIMULATED prices/.test(l)));
      const e = runtime.engine;
      const st = e.status();
      assert.equal(st.prices, 'sim');
      assert.equal(st.feed.state, 'sim');
      assert.deepEqual(st.feed.fallback, eff.fallback);
      assert.equal(st.feed.real_available, null);
      const fsEv = runtime.journal.query({ kind: 'feed_status' }).rows;
      assert.equal(fsEv.length, 1);
      assert.equal(fsEv[0].state, 'sim');
      assert.deepEqual(fsEv[0].fallback, eff.fallback);
      assert.equal(await e.probeReal(), false);
      assert.equal(e.status().feed.real_available, false);
      hl.down = false;
      assert.equal(await e.probeReal(), true);
      assert.equal(e.status().feed.real_available, true);
      assert.equal(runtime.journal.query({ kind: 'feed_status' }).total, 3, 'the UI hears about it (and suggests a restart)');
      // sim time-lapse still works in the fallback
      const last = await e.advance(2);
      assert.equal(last.source, 'sim');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('startWithFallback with HL reachable: real feed, real state files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bean-feed-'));
    try {
      // the daemon's clock is Date.now here, so the double gets a live clock too
      const hl = makeHL({ get ms() { return Date.now(); } });
      const config = { ...parseConfig(['--data', dir, '--beans', '60', '--warmup', '90'], {}), fetch: hl.fetch };
      const { runtime, files, config: eff } = await startWithFallback({ config, version: 't' });
      assert.equal(eff.feed, 'hyperliquid');
      assert.equal(path.basename(files.stateFile), 'state-real.json');
      assert.equal(path.basename(files.journalFile), 'journal-real.jsonl');
      assert.equal(runtime.engine.status().feed.fallback, null);
      assert.equal(runtime.engine.prices, 'real');
      assert.deepEqual(stateFiles(dir, 'sim'), { stateFile: path.join(dir, 'state.json'), journalFile: path.join(dir, 'journal.jsonl') });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================================
describe('sim feed: one code path for the client', () => {
  test('after every tick a mids pulse is published from the closes (prices sim)', async () => {
    const journal = new Journal({ keep: 1000, log: quiet });
    const engine = new Engine({ config: { seed: 7, beans: 60, warmupBars: 80, log: quiet }, journal });
    const live = new LiveLayer({ config: {}, engine, journal, log: quiet });
    const pulse = new Pulse({ log: quiet });
    wire({ engine, live, pulse });
    const got = [];
    pulse.subscribe((m) => got.push(m));
    await engine.start();
    engine.tick();
    assert.equal(got.length, 1);
    const m = got[0];
    assert.equal(m.kind, 'mids');
    assert.equal(m.prices, 'sim');
    assert.equal(m.source, 'sim');
    assert.equal(m.px.BTC, engine.market.mid('BTC'));
    assert.deepEqual(m.stale, []);
    assert.equal(m.bar.tick, engine.ticks);
    await engine.advance(10);
    assert.equal(got.length, 2, 'a fast-forward publishes once, after its last tick');
    assert.equal(journal.query({ kind: 'mids' }).total, 0, 'pulses are never journaled');
    // MarketFeed sim stays deterministic and never stale
    const f = new MarketFeed({ seed: 1, startMs: 0 });
    f.nextSync();
    assert.deepEqual(f.staleCoins(), []);
    assert.equal(f.livePx('BTC'), f.mid('BTC'));
    assert.equal(f.clockMs(), f.timeMs);
    assert.equal(f.tickTimeMs(), f.timeMs);
  });
});

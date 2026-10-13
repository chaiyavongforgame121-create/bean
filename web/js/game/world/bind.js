/**
 * world/bind.js — OPTIONAL store → World (+ sfx) wiring for the integrator (WP3). PURE: no three, no DOM.
 *
 *   worldInputs(state, { nowMs }) → { weather, wind, money, feedLook, sundial, halted, unread, sky, skyTimeMs,
 *                                     barClock, views, count, stall: { coins, selected }, ducked }
 *   bindWorld({ world, store, sfx?, now? }) → off()
 *
 * Only CONTINUOUS state is bound here (levels, weather, wind, feed look, sundial, mailbox, halted, sky, bar
 * clock, critters/spouts, stall sachets, sfx beds/duck). One-shot moments (tick kick, gust, water flow, fx,
 * time-lapse, cap tag, board flip, sachet bust) stay with the director → executor (§9.5), so nothing plays twice.
 * Every World setter used here is idempotent, so calling bindWorld alongside other wiring is harmless.
 */
import { closedTotals, moneyView } from '../core/view.js';

const num = (x) => (x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null);

/** Everything the world needs from one store snapshot (pure; tested). */
export function worldInputs(s = {}, { nowMs = Date.now() } = {}) {
  const feed = s.feed || {};
  const market = s.market || {};
  const ui = s.ui || {};
  const settings = s.settings || {};
  const prices = feed.prices === 'real' ? 'real' : 'sim';
  const mv = moneyView(s.live || null, s.marks || null);
  const closed = closedTotals(s.bots || []);
  let feedLook = prices === 'sim' ? 'sim' : ['live', 'delayed', 'down'].includes(feed.state) ? feed.state : 'live';
  if (s.net && s.net.ok === false) feedLook = 'offline';
  const next = num(feed.nextTickMs);
  const rows = Array.isArray(s.shelf?.rows) ? s.shelf.rows : [];
  const pick = ui.pickBean;
  const pickCoin = pick && typeof pick === 'object' ? pick.coin ?? null : rows.find((r) => r && (r.id === pick || r.bean_id === pick))?.coin ?? null;
  return {
    weather: market.weather ? market.weather.key ?? null : null,
    wind: market.wind ? num(market.wind.factor) : null,
    money: { towerFill: mv.fills.tower, pondFill: mv.fills.pond, siloFill: mv.fills.silo, crates: { n: closed.crates.n }, compost: { n: closed.compost.n } },
    feedLook,
    sundial: prices === 'sim',
    halted: !!s.live?.halted,
    unread: num(ui.unread) ?? 0,
    sky: settings.sky === 'clock' ? 'clock' : 'day',
    // sim: the sky follows MARKET time (§6.9); real: the player's clock
    skyTimeMs: prices === 'sim' ? num(feed.lastBarCloseMs) ?? nowMs : nowMs,
    barClock: next !== null ? { nextTickMs: next, periodMs: num(feed.tickMs) ?? (prices === 'real' ? 60_000 : 5_000), skewMs: num(s.net?.skewMs) ?? 0 } : null,
    views: s.views || {},
    count: num(s.slots?.count) ?? 10,
    stall: { coins: rows.slice(0, 5).map((r) => r?.coin ?? null), selected: pickCoin },
    ducked: ui.dialog != null,
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Subscribe a World (and optionally the sfx) to the store. Returns off(). Feature-detects every World method,
 * so it also works against a partial/stub world.
 */
export function bindWorld({ world, store, sfx = null, now = () => Date.now() } = {}) {
  if (!world || !store?.get) return () => {};
  const call = (name, ...args) => (typeof world[name] === 'function' ? world[name](...args) : undefined);
  let prev = {};
  const apply = () => {
    const w = worldInputs(store.get(), { nowMs: now() });
    if (w.weather && w.weather !== prev.weather) {
      call('setWeather', { key: w.weather });
      sfx?.setWeather?.(w.weather);
    }
    if (w.wind !== null && w.wind !== prev.wind) {
      call('setWind', w.wind);
      sfx?.setWind?.(w.wind);
    }
    if (!same(w.money, prev.money)) call('setMoney', w.money);
    if (w.feedLook !== prev.feedLook) call('setFeedLook', w.feedLook);
    if (w.sundial !== prev.sundial) call('setSundial', w.sundial);
    if (w.halted !== prev.halted) call('setHalted', w.halted);
    if (w.unread !== prev.unread) call('setUnread', w.unread);
    if (w.sky !== prev.sky || (w.sky === 'clock' && Math.abs((w.skyTimeMs ?? 0) - (prev.skyTimeMs ?? 0)) > 30_000)) {
      call('setDaylight', w.sky, w.skyTimeMs);
      sfx?.setNight?.(w.sky === 'clock' && (world.sky?.night ?? 0) > 0.5);
    }
    if (!same(w.barClock, prev.barClock)) call('setBarClock', w.barClock);
    if (w.views !== prev.views || w.count !== prev.count) call('syncPlots', w.views, w.count);
    if (!same(w.stall, prev.stall)) world.landmarks?.get?.('stall')?.setState?.(w.stall);
    if (w.ducked !== prev.ducked) sfx?.duck?.(w.ducked);
    prev = w;
  };
  apply();
  const off = store.select ? store.select((s) => s, apply) : null;
  const offLightning = typeof world.onLightning === 'function' && sfx
    ? world.onLightning((ev) => setTimeout(() => sfx.play?.('thunder'), ev?.thunderInMs ?? 1500))
    : null;
  return () => {
    off?.();
    offLightning?.();
  };
}

/**
 * ui/derive.js — PURE read helpers over the store state, shared by every ui/* module (WP5).
 *
 * The HUD must work before (and without) the 3D stage, and while WP2's main.js is still filling
 * `store.views`. So every reader here prefers what main.js put in the store (`views`, `slots`) and
 * only falls back to computing the same thing with WP2's pure core/view.js functions. Nothing here
 * invents a number: it only selects the server's numbers (J1).
 *
 *   nowOf(state)                     server-relative "now" (§9.3: client clock + net.skewMs)
 *   openBots(state)                  BotRows that are not closed
 *   slotsOf(state)                   { map, count, hidden } (store.slots, or assignSlots() when empty)
 *   viewsOf(state)                   { bySlot: {[slot]: PlotView}, hidden: PlotView[], count, bySlotList }
 *   viewOfBot(state, botId)          PlotView for a bot (drawn or hidden), or null
 *   beanOf(state, beanId)            BeanRow from store.beans / shelf rows / bot detail
 *   coinOf(state, coin)              CoinRow (market.coins map or array)
 *   priceOf(state, coin)             { px, ms, source: 'marks'|'market', stale } newest server price
 *   staleCoinsOf(state)              Set of coins whose price is delayed
 *   marksAgeOf(state)                ms since the last marks (null without marks)
 *   isHalted / isOffline / isDown / isSim
 *   plantedSlotOfCoin(state, coin)   slot (0-based) of the open bot on that coin, or null (one bot per coin)
 *   freeSlotOf(state, prefer)        lowest free drawn slot (or `prefer` when free), null when full
 *   plantBlock(state, bean, stake)   → { key, vars } reason planting is refused right now, or null
 *
 * No DOM, no three.js, no side effects at import.
 */

import * as V from '../core/view.js';
import { stakeRoom, closeQuote, WATER } from '../../model.js';
import { isNum } from '../../format.js';
import { usd } from '../../format.js';

const num = (x) => (isNum(x) ? Number(x) : null);

/** Server-relative now (§9.3). `clock` is injectable for tests. */
export function nowOf(state, clock = Date.now) {
  const skew = Number(state?.net?.skewMs);
  return clock() + (Number.isFinite(skew) ? skew : 0);
}

export function openBots(state) {
  return (Array.isArray(state?.bots) ? state.bots : []).filter((b) => b && b.state !== 'closed');
}

/** store.slots when main.js maintains it, else a stable-enough local assignment (same pure function). */
export function slotsOf(state) {
  const open = openBots(state);
  const s = state?.slots || {};
  const count = num(s.count) ?? V.slotCountOf(state?.live, open);
  const map = s.map && typeof s.map === 'object' ? s.map : {};
  const mapped = open.filter((b) => b.id in map).length;
  if (mapped === open.length || (mapped > 0 && Array.isArray(s.hidden) && mapped + s.hidden.length >= open.length)) {
    return { map, count, hidden: Array.isArray(s.hidden) ? s.hidden : [] };
  }
  const r = V.assignSlots(open, map, { slotCount: count, wanted: s.wanted || {} });
  return { map: r.map, count, hidden: r.hidden };
}

function viewCtx(state, extra = {}) {
  return {
    marks: state?.marks || null,
    coins: state?.market?.coins || state?.meta?.coins || null,
    nowMs: nowOf(state),
    halted: !!state?.live?.halted,
    staleCoins: state?.feed?.staleCoins || [],
    ...extra,
  };
}

/**
 * Every plot view: store.views (main.js) for drawn slots, plus views for bots beyond the drawn plots
 * (dock/list only, §2.3). Falls back to computing views when main.js has not filled store.views.
 */
export function viewsOf(state) {
  const { map, count, hidden } = slotsOf(state);
  const open = openBots(state);
  const byId = new Map(open.map((b) => [b.id, b]));
  let bySlot = {};
  const sv = state?.views && typeof state.views === 'object' ? state.views : null;
  const svHas = sv && Object.keys(sv).length > 0;
  if (svHas) {
    for (const [k, v] of Object.entries(sv)) if (v && v.botId !== undefined && v.state !== 'closed') bySlot[k] = v;
  } else {
    for (const [id, slot] of Object.entries(map)) {
      const bot = byId.get(id);
      if (!bot) continue;
      bySlot[slot] = V.plotView(bot, Number(slot), viewCtx(state, { bean: beanOf(state, bot.bean) }));
    }
  }
  const hiddenViews = [];
  let i = count;
  for (const id of hidden) {
    const bot = byId.get(id);
    if (bot) hiddenViews.push(V.plotView(bot, i++, viewCtx(state, { bean: beanOf(state, bot.bean) })));
  }
  const list = [];
  for (let s = 0; s < count; s++) list.push(bySlot[s] || null);
  return { bySlot, hidden: hiddenViews, count, list };
}

export function viewOfBot(state, botId) {
  if (botId === null || botId === undefined) return null;
  const v = viewsOf(state);
  for (const x of Object.values(v.bySlot)) if (x && x.botId === botId) return x;
  return v.hidden.find((x) => x.botId === botId) || null;
}

/** The raw BotRow (newest marks merged) behind a view, for closeQuote(). */
export function mergedBot(state, botId) {
  const bot = (state?.bots || []).find((b) => b && b.id === botId);
  if (!bot) return null;
  return V.viewBot ? V.viewBot(bot, state?.marks || null, state?.market?.coins || null) : bot;
}

/**
 * Harvest or pull? ONE answer for every surface (inspector, list view, radial, confirm): the ≈ total after the
 * closing fee and slippage, closeQuote(merged bot, mark).estTotal — the number the confirm dialog shows. Without
 * the bot row, the server total (view.usd). → { usd, loss, est }
 */
export function closeChoice(state, view) {
  const bot = view ? mergedBot(state, view.botId) : null;
  if (bot) {
    const q = closeQuote(bot, view.mark);
    if (Number.isFinite(q.estTotal)) return { usd: q.estTotal, loss: q.estTotal < 0, est: true };
  }
  const v = Number(view?.usd) || 0;
  return { usd: v, loss: v < 0, est: false };
}

export function beanOf(state, beanId) {
  if (beanId === null || beanId === undefined) return null;
  const id = Number(beanId);
  const fromMap = state?.beans?.[id] || state?.beans?.[String(id)];
  if (fromMap) return fromMap;
  const rows = state?.shelf?.rows || [];
  const r = rows.find((b) => Number(b?.id) === id);
  if (r) return r;
  for (const d of Object.values(state?.detail || {})) if (d?.bean && Number(d.bean.id) === id) return d.bean;
  return null;
}

export function coinOf(state, coin) {
  const coins = state?.market?.coins;
  if (coins && !Array.isArray(coins) && coins[coin]) return coins[coin];
  if (Array.isArray(coins)) {
    const c = coins.find((x) => x && x.coin === coin);
    if (c) return c;
  }
  const meta = state?.meta?.coins;
  if (Array.isArray(meta)) return meta.find((x) => x && (x.coin === coin || x.name === coin)) || null;
  return null;
}

/** All coin rows (array), market first, meta listing as a fallback. */
export function coinList(state) {
  const coins = state?.market?.coins;
  if (coins && !Array.isArray(coins)) return Object.values(coins).filter(Boolean);
  if (Array.isArray(coins) && coins.length) return coins.filter(Boolean);
  const meta = state?.meta?.coins;
  return Array.isArray(meta) ? meta.filter((c) => c && c.coin) : [];
}

export function staleCoinsOf(state) {
  return new Set([
    ...(Array.isArray(state?.feed?.staleCoins) ? state.feed.staleCoins : []),
    ...(Array.isArray(state?.marks?.stale) ? state.marks.stale : []),
  ]);
}

/** Newest server price for a coin: the `mids` pulse when newer than the market snapshot. */
export function priceOf(state, coin) {
  const c = coinOf(state, coin);
  const mPx = num(state?.marks?.px?.[coin]);
  const mMs = num(state?.marks?.t);
  const cPx = num(c?.px) ?? num(c?.mid);
  const cMs = num(c?.px_ms) ?? num(state?.market?.fetchedMs) ?? num(state?.market?.market_time_ms);
  const stale = staleCoinsOf(state).has(coin) || !!c?.stale;
  if (mPx !== null && (cMs === null || (mMs ?? 0) >= cMs)) return { px: mPx, ms: mMs, source: 'marks', stale };
  if (cPx !== null) return { px: cPx, ms: cMs, source: 'market', stale };
  return { px: null, ms: null, source: null, stale };
}

export function szDecimalsOf(state, coin) {
  return num(coinOf(state, coin)?.sz_decimals) ?? 0;
}

export function marksAgeOf(state) {
  const t = num(state?.marks?.t);
  return t === null ? null : Math.max(0, nowOf(state) - t);
}

export const isSim = (state) => (state?.feed?.prices ?? 'sim') === 'sim';
export const isHalted = (state) => !!state?.live?.halted;
export const isOffline = (state) => state?.net?.ok === false;
export const isDown = (state) => state?.feed?.state === 'down';

/** Slot of the open bot on `coin` (the server allows one bot per coin), or null. */
export function plantedSlotOfCoin(state, coin) {
  const bot = openBots(state).find((b) => b.coin === coin);
  if (!bot) return null;
  const { map } = slotsOf(state);
  return bot.id in map ? Number(map[bot.id]) : -1;
}

/**
 * Lowest free drawn slot; `prefer` wins when it is free. null when every drawn plot is taken. `ignoreBean`: a
 * planting of that bean is the caller's own, so its reservation does not count as taken.
 */
export function freeSlotOf(state, prefer = null, ignoreBean = null) {
  const { map, count } = slotsOf(state);
  const taken = new Set(Object.values(map).map(Number));
  // a planting in flight reserves its slot (store.slots.wanted: beanId → slot)
  for (const [b, s] of Object.entries(state?.slots?.wanted || {})) {
    if (ignoreBean !== null && ignoreBean !== undefined && Number(b) === Number(ignoreBean)) continue;
    taken.add(Number(s));
  }
  if (Number.isInteger(prefer) && prefer >= 0 && prefer < count && !taken.has(prefer)) return prefer;
  for (let s = 0; s < count; s++) if (!taken.has(s)) return s;
  return null;
}

/**
 * Why planting `bean` with `stake` is refused right now (§6.5), or null when it may go ahead.
 * Order: offline › halted › feed down › stale coin / old marks › coin already planted › field full › caps.
 * The leverage checkbox (≥ 25×) is the dialog's own check.
 */
export function plantBlock(state, bean, stake) {
  if (!bean) return { key: 'modal.gone', vars: {} };
  if (isSpectator(state)) return { key: 'g.gate.signInToPlant', vars: {} };
  if (isOffline(state)) return { key: 'g.plant.offBlock', vars: {} };
  // accounts mode: "re-arm the field", never "restart the server" (§9.4, QA-16/19)
  if (isHalted(state)) return { key: copyKey(state, 'modal.halted'), vars: copyVars(state, 'modal.halted') };
  if (isDown(state)) return { key: 'g.plant.downBlock', vars: {} };
  const p = priceOf(state, bean.coin);
  // the age of THIS coin's price (and of the marks frame): a paper fill never uses a price older than 15 s
  const pAge = p.ms !== null ? Math.max(0, nowOf(state) - p.ms) : null;
  const age = Math.max(marksAgeOf(state) ?? 0, pAge ?? 0);
  if (p.stale || (!isSim(state) && age > 15_000)) return { key: 'g.plant.staleBlock', vars: { coin: bean.coin } };
  if (plantedSlotOfCoin(state, bean.coin) !== null) return { key: 'packet.alreadyPlanted', vars: { coin: bean.coin } };
  const open = openBots(state).length;
  const maxBots = num(state?.live?.caps?.max_bots);
  if (maxBots !== null && open >= maxBots) return { key: 'g.plant.noSlot', vars: {} };
  const room = stakeRoom(bean, state?.live, p.px); // per dollar of water: what the bot opens right away
  if (room) {
    const cap = usd(room.cap, 0);
    if (room.maxStake < WATER.min) return { key: 'modal.full', vars: { cap } };
    if (isNum(stake) && Number(stake) > room.maxStake) return { key: 'modal.overCap', vars: { usd: usd(room.maxStake, 0), cap } };
  }
  return null;
}

/** Crop key for a coin ('BTC' … or 'other'). */
export const cropKeyOf = (coin) => V.cropKey(coin);

// ------------------------------------------------------------------ platform (PLATFORM.md §9)
//
// Accounts mode adds store slices filled by WP4's core/data.js (§9.5, §12.2): `mode`, `user`, `testnet`
// (testnet_market + testnet_status), `venues` (live_status.venues) and `season`. Their exact nesting is WP4's;
// every UI module reads them ONLY through the accessors below, so an integration difference is fixed in one
// place. Each accessor accepts the documented shapes and degrades to "none mode / not connected" when a slice is
// missing, which is exactly today's behaviour (§2.4: none mode stays as it is).

/** 'none' | 'accounts'. store.mode may be the string, or getMode()'s object { auth, testnet }. Missing → 'none'. */
export function modeOf(state) {
  const m = state?.mode;
  const v = typeof m === 'string' ? m : m?.auth ?? m?.mode ?? null;
  return v === 'accounts' ? 'accounts' : 'none';
}
export const isAccounts = (state) => modeOf(state) === 'accounts';
/** True once the page knows its mode (GET /api/v1 answered). The gate never flashes before that. */
export const modeKnown = (state) => state?.mode !== undefined && state?.mode !== null;

/** The signed-in User ({id, username, role, created_ms, lang}) or null. */
export function userOf(state) {
  const u = state?.user;
  return u && typeof u === 'object' && typeof u.username === 'string' && u.username ? u : null;
}
/** Accounts mode without a session: the island, market and stall work; plots are empty (§9.1). */
export const isSpectator = (state) => isAccounts(state) && !userOf(state);
export const isAdmin = (state) => userOf(state)?.role === 'admin';
/**
 * May this page run the time-lapse (`tick`)? Simulated prices only; in accounts mode `tick` moves everyone's sim
 * market, so it is an admin op (PLATFORM §2.3) and players never see a button that would answer 403.
 */
export const canTimelapse = (state) => isSim(state) && (!isAccounts(state) || isAdmin(state));

/** live_status.venues (store.venues, or nested in store.live). */
export function venuesOf(state) {
  const v = state?.venues ?? state?.live?.venues ?? null;
  return v && typeof v === 'object' ? v : null;
}

/** The cached testnet_market payload or null. */
export function tnMarket(state) {
  const t = state?.testnet;
  if (!t || typeof t !== 'object') return null;
  const m = t.market ?? t.testnet_market ?? (Array.isArray(t.coins) ? t : null);
  return m && typeof m === 'object' ? m : null;
}

/** The cached testnet_status payload ({link, state, account, positions, requests, expiry, caps}) or null. */
export function tnStatus(state) {
  const t = state?.testnet;
  const s = t?.status ?? t?.testnet_status ?? null;
  return s && typeof s === 'object' ? s : null;
}

/** live_status.venues.testnet (the testnet ledger) or null. */
export function tnVenue(state) {
  const v = venuesOf(state)?.testnet;
  return v && typeof v === 'object' ? v : null;
}

/** Server-wide testnet switch: GET /api/v1 testnet.enabled, else testnet_market.enabled, else the ledger. */
export function testnetEnabled(state) {
  if (!isAccounts(state)) return false;
  const m = state?.mode;
  if (m && typeof m === 'object' && m.testnet && typeof m.testnet.enabled === 'boolean') return m.testnet.enabled;
  const mk = tnMarket(state);
  if (mk && typeof mk.enabled === 'boolean') return mk.enabled;
  const v = tnVenue(state);
  if (v && typeof v.enabled === 'boolean') return v.enabled;
  return false;
}

/** The player's TestnetLink (testnet_status.link, me.testnet, or user.testnet) or null. */
export function tnLink(state) {
  const l = tnStatus(state)?.link ?? state?.me?.testnet ?? state?.user?.testnet ?? state?.testnet?.link ?? null;
  return l && typeof l === 'object' ? l : null;
}

/** Connected = a stored, verified (or pending) credential. A revoked link is not connected. */
export function tnConnected(state) {
  const l = tnLink(state);
  if (l) return l.status === 'verified' || l.status === 'pending';
  return !!tnVenue(state)?.connected;
}
/** A stored link whose credential was revoked / errored (reconnect needed). */
export function tnRevoked(state) {
  const l = tnLink(state);
  if (l) return l.status === 'revoked' || l.status === 'error' || l.status === 'key_unavailable';
  const cs = tnVenue(state)?.credential_status;
  return cs === 'revoked' || cs === 'error';
}

/** 'live' | 'delayed' | 'down' | 'disabled' (testnet_market.state, testnet_status.state or the ledger). */
export function tnState(state) {
  if (!testnetEnabled(state)) return 'disabled';
  const s = tnMarket(state)?.state ?? tnStatus(state)?.state ?? tnVenue(state)?.state ?? 'live';
  return ['live', 'delayed', 'down', 'disabled'].includes(s) ? s : 'live';
}

/** The admin kill switch { on, reason, since_ms } (global). */
export function killSwitchOf(state) {
  const k = tnMarket(state)?.kill_switch ?? tnVenue(state)?.kill_switch ?? null;
  return { on: !!k?.on, reason: k?.reason ?? null, since_ms: num(k?.since_ms) };
}

/** A bot's venue ('paper' when absent, §8.5). */
export const venueOf = (bot) => (bot?.venue === 'testnet' ? 'testnet' : 'paper');
export const isTestnetBot = (bot) => venueOf(bot) === 'testnet';
export const testnetBots = (state) => openBots(state).filter(isTestnetBot);

/** Testnet market row for a coin ({coin, mid, mid_ms, funding_1h, tradeable, sz_decimals, …}) or null. */
export function tnCoin(state, coin) {
  const rows = tnMarket(state)?.coins;
  return Array.isArray(rows) ? rows.find((c) => c && c.coin === coin) || null : null;
}

/** Testnet mid for a coin: the newest of the `mids.testnet` pulse (store.marks.testnet) and testnet_market. */
export function tnPriceOf(state, coin) {
  const pulse = state?.marks?.testnet;
  const pPx = num(pulse?.px?.[coin] ?? pulse?.mids?.[coin] ?? pulse?.[coin]?.mid);
  const pMs = num(pulse?.t ?? pulse?.mids_ms ?? pulse?.[coin]?.mid_ms);
  const c = tnCoin(state, coin);
  const cPx = num(c?.mid);
  const cMs = num(c?.mid_ms ?? tnMarket(state)?.mids_ms);
  if (pPx !== null && (cMs === null || (pMs ?? 0) >= cMs)) return { px: pPx, ms: pMs };
  return { px: cPx, ms: cMs };
}

/** Halted with a re-arm time (accounts mode): { halted, rearmAfterMs } from live_status. */
export function rearmAfterOf(state) {
  return num(state?.live?.rearm_after_ms);
}

/**
 * Accounts-mode copy variants (§9.4): the strings that say "restart the server" or "no keys" in none mode have an
 * accounts-mode twin. copyKey(state, key) returns the key to show; none mode always gets `key` back.
 */
export const ACCOUNTS_COPY = Object.freeze({
  'plot.emptyHalted': 'plot.emptyHaltedRearm',
  'modal.halted': 'modal.haltedRearm',
  'shelf.noteHalted': 'shelf.noteHaltedRearm',
  'ask.burn': 'ask.burnAccounts',
  'g.ask.burnBody': 'g.ask.burnBodyAccounts',
  'app.simNote': 'app.simNoteAccounts',
  'g.tour.1': 'g.tour.1Accounts',
  'g.mode.realBody': 'g.mode.realBodyAccounts',
});

export function copyKey(state, key) {
  if (!isAccounts(state)) return key;
  if (key === 'g.mode.realBody' && (tnConnected(state) || testnetBots(state).length)) return 'g.mode.realBodyTestnet';
  // "re-arm the field in {time}" only while the 60 s wait runs; after it, the button is there
  if (key === 'modal.halted') {
    const at = rearmAfterOf(state);
    return at !== null && at > nowOf(state) ? 'modal.haltedRearm' : 'plot.emptyHaltedRearm';
  }
  return ACCOUNTS_COPY[key] || key;
}

/** Paper season number (live_status.season / store.season) or null in none mode. */
export function seasonOf(state) {
  return num(state?.season?.season ?? state?.season ?? state?.live?.season);
}

/** When a new paper season is possible again (live_status.reset_after_ms), or null. */
export function resetAfterOf(state) {
  return num(state?.live?.reset_after_ms ?? state?.season?.reset_after_ms);
}

/** When the field was burned (live_status.halted_ms), or null. */
export function haltedAtOf(state) {
  return num(state?.live?.halted_ms);
}

/** Can the field be re-armed now? (accounts mode, halted, the 60 s wait over) → { can, waitMs } */
export function rearmState(state, nowMs = nowOf(state)) {
  if (!isAccounts(state) || !isHalted(state)) return { can: false, waitMs: null, halted: isHalted(state) };
  const at = rearmAfterOf(state) ?? (haltedAtOf(state) !== null ? haltedAtOf(state) + 60_000 : null);
  const waitMs = at === null ? 0 : Math.max(0, at - nowMs);
  return { can: waitMs <= 0, waitMs, halted: true };
}

/** Backup retention in days (GET /api/v1 may publish it; the §10.5 default is 7). */
export function backupDaysOf(state) {
  return num(state?.mode?.backup_days) ?? 7;
}

/** Inactivity rule in days (§6.11; default 14). */
export function inactiveDaysOf(state) {
  return num(state?.mode?.inactive_days) ?? 14;
}

/** Open paper bots (the ones a new season closes). */
export const paperBots = (state) => openBots(state).filter((b) => !isTestnetBot(b));

/**
 * The testnet ledger for the barn popover and the connect panel: live_status.venues.testnet merged with the
 * cached testnet_status.account (whichever is newer) and the `testnet_account` part of the newest mids frame.
 * Exchange numbers are shown plain with their age; `est` marks a unified-account value we computed (≈, J1).
 */
export function tnLedger(state) {
  const v = tnVenue(state) || {};
  const a = tnStatus(state)?.account || null;
  const m = state?.marks?.testnet_account || null;
  const pick = [v, a, m].filter(Boolean).sort((x, y) => (num(y.as_of_ms) ?? 0) - (num(x.as_of_ms) ?? 0))[0] || {};
  const link = tnLink(state);
  return {
    connected: tnConnected(state),
    account_value: num(pick.account_value),
    est: !!(pick.account_value_est ?? v.account_value_est),
    free: num(pick.free ?? pick.withdrawable ?? v.free),
    as_of_ms: num(pick.as_of_ms),
    value_at_connect: num(v.value_at_connect ?? link?.value_at_connect),
    connected_ms: num(v.connected_ms ?? link?.connected_ms),
    bots_open: num(v.bots_open) ?? testnetBots(state).length,
    realized_pnl: num(v.realized_pnl),
    funding: num(v.funding),
    unrealized_pnl_est: num(v.unrealized_pnl_est),
    abstraction: v.abstraction ?? link?.abstraction ?? null,
  };
}

/**
 * P1 HUD ledger toggle (§9.4 "Ledgers"): the testnet ledger can be shown when the server has testnet and the player
 * is connected or holds testnet bots.
 */
export function tnLedgerAvailable(state) {
  return isAccounts(state) && !!userOf(state) && testnetEnabled(state) && (tnConnected(state) || testnetBots(state).length > 0);
}

/** 'paper' | 'testnet': the ledger the HUD chips and the barn / pond / tower show (paper unless the player chose testnet). */
export function activeLedger(state) {
  return state?.settings?.ledger === 'testnet' && tnLedgerAvailable(state) ? 'testnet' : 'paper';
}

/**
 * The testnet ledger in the HUD's shape (§9.6): the exchange's account value (≈ for a unified account we computed),
 * free collateral as the pond, the testnet bots' water as the tower, unrealized at the testnet mid (always ≈),
 * realized + funding as harvested. No "vs start" (J5: the testnet ledger has no start; faucet claims move it).
 */
export function tnMoneyView(state) {
  const l = tnLedger(state);
  const bots = testnetBots(state);
  const water = bots.reduce((a, b) => a + (num(b.capital_usd) ?? 0), 0);
  return {
    venue: 'testnet',
    barn: l.account_value,
    barnEst: !!l.est,
    pond: l.free,
    tower: water,
    growing: l.unrealized_pnl_est,
    harvested: l.realized_pnl === null && l.funding === null ? null : (l.realized_pnl ?? 0) + (l.funding ?? 0),
    plants: bots.length,
    vsStartPct: null,
    asOfMs: l.as_of_ms,
  };
}

/** API-wallet expiry: { validUntil, warn: '7d' | '1d' | null } (testnet_status.expiry, else the link). */
export function tnExpiry(state, nowMs = nowOf(state)) {
  const e = tnStatus(state)?.expiry;
  const validUntil = num(e?.valid_until_ms ?? tnLink(state)?.valid_until_ms);
  let warn = e?.warn ?? null;
  if (!warn && validUntil !== null) {
    const left = validUntil - nowMs;
    warn = left < 86_400_000 ? '1d' : left < 7 * 86_400_000 ? '7d' : null;
  }
  return { validUntil, warn };
}

/**
 * What a tap on a landmark opens (GAME-DESIGN §2.4, PLATFORM QA-02). PURE, so the bus routing is testable:
 *   → { kind: 'panel', panel } | { kind: 'money' } | { kind: 'mode' } | { kind: 'burn' } | { kind: 'timelapse' }
 *     | { kind: 'gate' } | { kind: 'signIn', place } (spectator: "sign in to see your own …") | { kind: 'tip' }
 */
export const MONEY_LANDMARKS = Object.freeze(['barn', 'pond', 'tower', 'silo', 'crates', 'compost']);
export function routeLandmark(id, state) {
  const spectator = isSpectator(state);
  if (spectator && MONEY_LANDMARKS.includes(id)) return { kind: 'signIn', place: id };
  switch (id) {
    case 'stall':
      return { kind: 'panel', panel: 'shelf' };
    case 'board':
      return { kind: 'panel', panel: 'board' };
    case 'mailbox':
      return { kind: 'panel', panel: 'diary' };
    case 'pip':
      return { kind: 'panel', panel: 'help' };
    case 'barn':
      return { kind: 'money' };
    case 'signpost':
      return spectator ? { kind: 'gate' } : { kind: 'mode' };
    case 'firepit':
      return spectator ? { kind: 'gate' } : { kind: 'burn' };
    case 'sundial':
      return canTimelapse(state) ? { kind: 'timelapse' } : { kind: 'tip' };
    default:
      return { kind: 'tip' };
  }
}

/** Variables for an accounts-mode variant ({time} of the re-arm countdown). */
export function copyVars(state, key, vars = {}) {
  if (copyKey(state, key) === 'modal.haltedRearm') {
    const left = Math.max(0, (rearmAfterOf(state) ?? 0) - nowOf(state));
    const s = Math.ceil(left / 1000);
    return { ...vars, time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` };
  }
  return vars;
}

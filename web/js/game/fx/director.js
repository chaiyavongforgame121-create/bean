/**
 * fx/director.js — PURE reducer: (previous views, next views, event) → Effect[] (GAME-DESIGN §4, §9.5).
 *
 *   direct(prevViews, nextViews, event, ctx) → Effect[]
 *     prevViews / nextViews  {[slot]: PlotView} (core/view.js)
 *     event                  a normalised game event (core/data.js) — or null for a pure view diff
 *     ctx                    { nowMs (client clock), skewMs, reduced, halted, streamLive,
 *                              pending: {[key]: {op}},              commands in flight
 *                              recentFills: {[slot]: {ms, dir, n}}, last fill per plot (coalescing / flips)
 *                              lastFruitLoss: {['slot:index']: ms}, fruit losses (quiet re-gain)
 *                              played: {[onceKey]: ms} }            one-shot effects already played (2xx vs echo)
 *
 *   createDirector({ now }) → { run(prev, next, event, extra) → Effect[], memory, reset() }
 *     the thin stateful wrapper main.js uses: it feeds `direct` its memory, records what was played,
 *     and validates every effect with rules.assertEffect (an invalid effect is dropped and logged).
 *
 * Effect = { kind, slot?, coin?, usd?, n?, text?, tone?: 'up'|'down'|'neutral'|'warn', meta? }
 *   kinds: rules.EFFECT_KINDS (one to one with §4). `meta.delayMs` staggers burn plots; `meta.once` is the
 *   dedupe key; fills carry {dir, sz, px, fee, closedPnl, szDecimals} for the floater text (WP4 formats it).
 *
 * Rules (tested in test/game.test.js):
 *   - harvest only when realized ≥ 0, with coinBurst(usd) coins; pull has zero coins and no sparkle (J4);
 *   - no plantOk without a 2xx (cmd done ok) or a bot_created echo (J3); each plays once per bot;
 *   - fills within 400 ms on one plot → fillMerged; Close X then Open Y within 400 ms → flip;
 *   - replayed fills (older than 120 s) → no effects; fills/closes flagged `burn` belong to the burn sequence;
 *     "older" is the fill's time_ms with real prices, but the journal's wall time (`rec_t`) in sim, where
 *     time_ms is market time (it lags the wall clock after a restart); events the server flags `replay`
 *     (made while catching up missed minutes) never animate either;
 *   - one realized number per close: the closing fill of a harvest/pull in flight (or already played) and a
 *     liquidation fill get no fill floater — the harvest/pull/liquidate effect states the outcome;
 *   - `quiet` ticks (a time-lapse burst) → no per-tick effect;
 *   - fruitGain within 10 s of a fruitLoss of the same index → fruitGainQuiet;
 *   - marks never produce effects except state crossings (fruit, ripe, wilt, dying, liq danger, frozen) (J11);
 *   - burnPlot effects are staggered 250 ms in slot order, each with that bot's own realized P&L;
 *   - under ctx.reduced the same effects are emitted (the executor renders the RM variants);
 *   - (createDirector) an entry effect (ripeOn, wiltOn, dyingOn, liqDangerOn) plays at most once per plot per
 *     RULES.reentryMs, so a plant hovering at a threshold does not re-trigger it on every mark.
 *
 * Pure module: no DOM, no three.js, no side effects at import.
 */

import { coinBurst, closeRecipe, isReplayed, moneyTone, assertEffect, RULES, ENTRY_KINDS } from '../core/rules.js';

const ONCE_MS = 15_000; // how long a one-shot key blocks its twin (2xx vs SSE echo)

/** Event types whose server `replay` flag silences them (state is applied; the moment has passed). */
const REPLAY_QUIET = new Set(['fill', 'paused', 'orderSkipped', 'busted']);

const num = (x) => (x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null);

function isFlip(prevDir, dir) {
  return (prevDir === 'Close Long' && dir === 'Open Short') || (prevDir === 'Close Short' && dir === 'Open Long');
}

function played(ctx, key) {
  const at = ctx?.played?.[key];
  return at !== undefined && (ctx.nowMs ?? 0) - at < ONCE_MS;
}

/** harvest / pull for a realized amount (J4: coins only for gains; a zero harvest is a basket, no coins). */
function closeEffect(slot, coin, usd, bot, extraMeta = {}) {
  const v = num(usd) ?? 0;
  if (closeRecipe(v) === 'harvest') {
    return { kind: 'harvest', slot, coin, usd: v, n: coinBurst(v), tone: moneyTone(v), meta: { bot, once: `close:${bot}`, popcorn: coin === 'DOGE', ...extraMeta } };
  }
  return { kind: 'pull', slot, coin, usd: v, n: 0, tone: 'down', meta: { bot, once: `close:${bot}`, ...extraMeta } };
}

/** Is this fill a replay (no animation)? Real: its time_ms is > 120 s old. Sim: its journal wall time is. */
function replayedFill(ev, ctx) {
  const now = ctx.nowMs ?? 0;
  if (ctx.prices === 'sim') {
    const t = num(ev.rec_t);
    return t !== null && isReplayed({ time_ms: t }, now, ctx.skewMs);
  }
  return isReplayed(ev, now, ctx.skewMs);
}

/** A close in flight (pending bot_close) or already played for this bot. */
function closing(ctx, bot) {
  if (bot === null || bot === undefined) return false;
  if (played(ctx, `close:${bot}`)) return true;
  return Object.values(ctx.pending || {}).some((p) => p && p.op === 'bot_close' && p.bot === bot);
}

function fillMeta(ev, view) {
  // the view's decimals, else the coin listing's (a new bot's opening fill beats its PlotView); unknown → null
  // and the floater shows the server's raw size instead of rounding it to 0
  const szd = num(view?.szDecimals) ?? num(ev.sz_decimals);
  return {
    bot: ev.bot,
    dir: ev.dir,
    sz: num(ev.sz),
    px: num(ev.px),
    fee: num(ev.fee),
    closedPnl: num(ev.closed_pnl),
    szDecimals: szd,
    open: /^Open /.test(String(ev.dir || '')),
    liquidation: !!ev.liquidation,
  };
}

/** Net realized of a fill (closing legs: closed_pnl − fee); null for opens. */
function fillUsd(ev) {
  if (!/^Close /.test(String(ev.dir || ''))) return null;
  const pnl = num(ev.closed_pnl) ?? 0;
  return pnl - (num(ev.fee) ?? 0);
}

// ------------------------------------------------------------------ events

function eventEffects(prevViews, nextViews, ev, ctx) {
  const slot = ev.slot ?? null;
  const view = (slot !== null && (nextViews?.[slot] || prevViews?.[slot])) || null;
  const coin = ev.coin ?? view?.coin;
  const now = ctx.nowMs ?? 0;
  // outcomes the server made while catching up missed minutes are applied to the state, never animated
  if (ev.replay && REPLAY_QUIET.has(ev.type)) return [];

  switch (ev.type) {
    case 'fill': {
      // replays get no animation; closing fills of a burn are resolved by the burn sequence
      if (ev.burn || replayedFill(ev, ctx)) return [];
      if (slot === null) return [];
      // one realized number per close: the harvest/pull (or liquidate) effect carries the outcome, so the closing
      // leg gets no second floater with a different amount (and a pull never shows a green fill)
      if (ev.liquidation) return [];
      if (/^Close /.test(String(ev.dir || '')) && closing(ctx, ev.bot)) return [];
      const usd = fillUsd(ev);
      const meta = fillMeta(ev, view);
      const last = ctx.recentFills?.[slot];
      const at = ev.ms ?? now;
      if (last && at - last.ms <= RULES.coalesceMs) {
        if (isFlip(last.dir, ev.dir)) {
          const closeUsd = num(last.usd);
          return [{ kind: 'flip', slot, coin, usd: closeUsd ?? undefined, n: (last.n || 1) + 1, tone: moneyTone(closeUsd), meta: { ...meta, from: last.dir, to: ev.dir } }];
        }
        return [{ kind: 'fillMerged', slot, coin, usd: usd ?? undefined, n: (last.n || 1) + 1, tone: moneyTone(usd), meta }];
      }
      return [{ kind: 'fill', slot, coin, usd: usd ?? undefined, n: 1, tone: moneyTone(usd), meta }];
    }

    case 'created': {
      if (slot === null) return [];
      const out = [];
      if (!played(ctx, `plant:${ev.bot}`)) out.push({ kind: 'plantOk', slot, coin, meta: { bot: ev.bot, bean: ev.bean, once: `plant:${ev.bot}` } });
      if (!played(ctx, `water:${ev.bot}`)) out.push({ kind: 'water', slot, coin, usd: num(ev.capital_usd) ?? undefined, tone: 'neutral', meta: { bot: ev.bot, once: `water:${ev.bot}` } });
      return out;
    }

    case 'cmd': {
      const op = ev.op;
      if (ev.phase === 'pending') {
        const out = [{ kind: 'pending', slot, coin, meta: { op, key: ev.key, on: true } }];
        if (op === 'tick') out.push({ kind: 'timelapse', meta: { key: ev.key } });
        return out;
      }
      // done
      const out = [{ kind: 'pending', slot, coin, meta: { op, key: ev.key, on: false, ok: !!ev.ok } }];
      const body = ev.body || {};
      const bot = body.id ?? ev.bot;
      if (!ev.ok) {
        if (op === 'bot_create') out.push({ kind: 'plantFail', slot, coin, text: body.error ?? null, tone: 'neutral', meta: { op, status: body.status ?? null } });
        out.push({ kind: 'sfx', slot, meta: { name: 'knock', count: 2 } });
        return out;
      }
      if (op === 'bot_create' && slot !== null && bot !== undefined) {
        if (!played(ctx, `plant:${bot}`)) out.push({ kind: 'plantOk', slot, coin: body.coin ?? coin, meta: { bot, bean: body.bean, once: `plant:${bot}` } });
        // Without a live stream the bot_created echo never comes: water on the 2xx instead.
        if (!ctx.streamLive && !played(ctx, `water:${bot}`)) {
          out.push({ kind: 'water', slot, coin: body.coin ?? coin, usd: num(body.capital_usd) ?? undefined, tone: 'neutral', meta: { bot, once: `water:${bot}` } });
        }
      } else if (op === 'bot_close' && slot !== null && bot !== undefined && !played(ctx, `close:${bot}`)) {
        // a testnet close only STARTS here (the closing state, IOC flatten); its harvest / pull plays on bot_closed
        // with the exchange's confirmed numbers (PLATFORM §9.6 J3/J4), never on this provisional 2xx
        const tnClosing = (body.venue ?? ev.venue) === 'testnet' && body.state !== 'closed';
        if (!tnClosing) out.push(closeEffect(slot, body.coin ?? coin, body.realized_pnl, bot));
      } else if (op === 'bot_pause' && slot !== null && bot !== undefined && !played(ctx, `shade:${bot}`)) {
        out.push({ kind: 'shade', slot, coin, meta: { bot, once: `shade:${bot}` } });
      } else if (op === 'bot_resume' && slot !== null && bot !== undefined && !played(ctx, `resume:${bot}`)) {
        out.push({ kind: 'resume', slot, coin, meta: { bot, once: `resume:${bot}` } });
      }
      return out;
    }

    case 'paused': {
      if (slot === null) return [];
      const reason = String(ev.reason ?? ev.note ?? '');
      // a testnet liquidation (note_code liquidated_testnet) uses the paper liquidation visuals (§9.6 J4)
      if (reason === 'liquidated' || ev.note_code === 'liquidated_testnet') {
        if (played(ctx, `liq:${ev.bot}`)) return [];
        const lost = num(ev.usd) ?? (view?.margin !== null && view?.margin !== undefined ? -Math.abs(view.margin) : null);
        return [{ kind: 'liquidate', slot, coin, usd: lost ?? undefined, tone: 'down', meta: { bot: ev.bot, once: `liq:${ev.bot}`, est: num(ev.usd) === null } }];
      }
      if (reason === 'bean busted') {
        if (played(ctx, `bust:${ev.bot}`)) return [];
        return [{ kind: 'bustPlanted', slot, coin, tone: 'warn', meta: { bot: ev.bot, once: `bust:${ev.bot}` } }];
      }
      if (played(ctx, `shade:${ev.bot}`)) return [];
      return [{ kind: 'shade', slot, coin, meta: { bot: ev.bot, reason: reason || null, once: `shade:${ev.bot}` } }];
    }

    case 'resumed':
      if (slot === null || played(ctx, `resume:${ev.bot}`)) return [];
      return [{ kind: 'resume', slot, coin, meta: { bot: ev.bot, once: `resume:${ev.bot}` } }];

    case 'closed': {
      if (slot === null || ev.burn) return [];
      // A burn in flight resolves its plots in the 'halted' sequence instead (staggered, slot order).
      const burning = Object.values(ctx.pending || {}).some((p) => p && p.op === 'bots_halt');
      if (burning || played(ctx, `close:${ev.bot}`)) return [];
      // testnet (PLATFORM §9.6 J4): the result includes funding; an UNCONFIRMED close (provisional exchange
      // numbers, shown with ≈) whose |result| is within 2 × its estimated fees could still change sign when the
      // exchange confirms: its effect is neutral (a basket, no coins, no pull). bot_fill_confirmed never replays it.
      if (ev.venue === 'testnet') {
        const total = (num(ev.realized_pnl) ?? 0) + (num(ev.funding) ?? 0);
        if (ev.confirmed === false) {
          const fees = Math.abs(num(prevViews?.[slot]?.fees) ?? 0);
          if (Math.abs(total) <= 2 * fees) return [{ kind: 'harvest', slot, coin, usd: 0, n: 0, tone: 'neutral', meta: { bot: ev.bot, once: `close:${ev.bot}`, est: true, neutral: true } }];
          return [closeEffect(slot, coin, total, ev.bot, { est: true })];
        }
        return [closeEffect(slot, coin, total, ev.bot)];
      }
      return [closeEffect(slot, coin, ev.realized_pnl, ev.bot)];
    }

    case 'halted': {
      if (played(ctx, 'halt')) return [];
      const plots = (Array.isArray(ev.closed) ? ev.closed : [])
        .map((c) => (typeof c === 'string' ? { bot: c } : c))
        .filter((c) => c && c.slot !== null && c.slot !== undefined)
        .sort((a, b) => a.slot - b.slot);
      const out = [{ kind: 'burnStart', meta: { once: 'halt', n: plots.length } }];
      plots.forEach((c, i) => {
        const pv = prevViews?.[c.slot];
        const given = num(c.realized_pnl);
        const usd = given ?? pv?.usd ?? 0;
        const recipe = closeRecipe(usd);
        out.push({
          kind: 'burnPlot',
          slot: c.slot,
          coin: c.coin ?? pv?.coin,
          usd,
          n: recipe === 'harvest' ? coinBurst(usd) : 0,
          tone: moneyTone(usd),
          meta: { bot: c.bot, recipe, delayMs: i * RULES.burnStaggerMs, est: given === null },
        });
      });
      out.push({ kind: 'burnEnd', meta: { delayMs: plots.length * RULES.burnStaggerMs } });
      return out;
    }

    case 'error':
      return [{ kind: 'error', slot, coin, text: ev.error ?? null, tone: 'warn', meta: { bot: ev.bot ?? null } }];

    case 'sync': {
      // a failed testnet exchange sync (PLATFORM §9.6 J3, QA-14): a dust puff on the plot, as for a refused
      // command; the plot stays planted and the inspector / chip carry the localised reason. Once per failure.
      if (slot === null || ev.replay || ev.state !== 'failed') return [];
      const once = `syncfail:${ev.bot}:${ev.op ?? ''}:${ev.code ?? ''}:${ev.attempts ?? ''}`;
      if (played(ctx, once)) return [];
      return [{ kind: 'pending', slot, coin, meta: { op: 'bot_sync', key: `sync:${ev.bot}`, on: false, ok: false, once } }];
    }

    case 'orderSkipped':
      if (slot === null) return [];
      return [{ kind: 'capTag', slot, coin, tone: 'warn', meta: { bot: ev.bot, reason: ev.reason ?? null } }];

    case 'tick':
      // the fast-forward burst of a time-lapse plays as one 'timelapse' effect, not 60 windmill kicks
      if (ev.quiet) return [];
      return [{ kind: 'tick', meta: { tick: ev.tick ?? null, nextTickMs: ev.next_tick_ms ?? null } }];

    case 'busted':
      // A planted bean's bust arrives as bot_paused {reason: 'bean busted'}; here only the shelf sachet drops.
      if (ev.onShelf && (ev.slot === null || ev.slot === undefined)) return [{ kind: 'bustShelf', coin, meta: { bean: ev.bean } }];
      return [];

    case 'feed':
      return [{ kind: 'feedLook', meta: { state: ev.state ?? null, prev: ev.prev ?? null, staleCoins: ev.stale_coins ?? [] } }];

    case 'gust':
      return [{ kind: 'gust', coin: ev.coin, meta: { pct: num(ev.pct) } }];

    case 'weather':
      return [{ kind: 'weather', meta: { key: ev.key ?? null, prev: ev.prev ?? null } }];

    default:
      return []; // gap / warmup / daemon / unknown: diary only
  }
}

// ------------------------------------------------------------------ view diffs

function diffEffects(prevViews, nextViews, ctx) {
  const out = [];
  const now = ctx.nowMs ?? 0;
  const source = ctx.cause === 'mids' ? 'mids' : undefined;
  const slots = Object.keys(nextViews || {})
    .map(Number)
    .sort((a, b) => a - b);
  for (const slot of slots) {
    const p = prevViews?.[slot];
    const n = nextViews[slot];
    // Only the same bot changing state animates; a plot appearing (page load, missed events) is applied as-is.
    if (!p || !n || p.botId !== n.botId || n.state === 'closed') continue;
    const base = { slot, coin: n.coin };
    if (!p.frozen && n.frozen) out.push({ kind: 'frozenOn', ...base, meta: { source } });
    if (p.frozen && !n.frozen) out.push({ kind: 'frozenOff', ...base, meta: { source } });
    if (n.frozen) continue; // frozen plants keep their targets: no growth effects

    // A plant flip-flopping across a fruit threshold must not play pop / drop / pop (J11 "slot machine"): a gain
    // within 10 s of ANY loss on this plot pops quietly, and a loss within 5 s of a gain fades without an
    // effect (the fruit count itself still changes at once — the crop drops it quietly).
    const fs = ctx.fruitSlot?.[slot] || {};
    const flipLoss = fs.loss !== undefined && now - fs.loss < RULES.fruitRegainMs;
    const flipGain = fs.gain !== undefined && now - fs.gain < RULES.fruitFlipLossMs;
    if (n.fruit > p.fruit) {
      for (let k = p.fruit; k < n.fruit; k++) {
        const lost = ctx.lastFruitLoss?.[`${slot}:${k}`];
        const quiet = flipLoss || (lost !== undefined && now - lost < RULES.fruitRegainMs);
        out.push({ kind: quiet ? 'fruitGainQuiet' : 'fruitGain', ...base, n: k, meta: { source } });
      }
    } else if (n.fruit < p.fruit && !flipGain) {
      for (let k = p.fruit - 1; k >= n.fruit; k--) out.push({ kind: 'fruitLoss', ...base, n: k, meta: { source } });
    }
    if (!p.ripe && n.ripe) out.push({ kind: 'ripeOn', ...base, meta: { source } });
    if (n.caption === 'wilting' && p.caption !== 'wilting' && p.caption !== 'dying') out.push({ kind: 'wiltOn', ...base, meta: { source } });
    if (n.caption === 'dying' && p.caption !== 'dying') out.push({ kind: 'dyingOn', ...base, meta: { source } });
    if (n.liqInfo?.band === 'danger' && p.liqInfo?.band !== 'danger') out.push({ kind: 'liqDangerOn', ...base, tone: 'warn', meta: { source } });
  }
  return out;
}

// ------------------------------------------------------------------ public

/** The pure reducer (see the header). Never throws for well-formed input; unknown events → []. */
export function direct(prevViews, nextViews, event, ctx = {}) {
  const out = [];
  if (event && typeof event === 'object' && event.type) out.push(...eventEffects(prevViews || {}, nextViews || {}, event, ctx));
  if (prevViews && nextViews && prevViews !== nextViews) out.push(...diffEffects(prevViews, nextViews, ctx));
  if (ctx.reduced) for (const e of out) e.meta = { ...(e.meta || {}), reduced: true };
  return out;
}

/**
 * Stateful wrapper around `direct` (memory: recent fills, fruit losses, one-shot keys).
 * `now` is injectable for tests. `extra` is merged into ctx (skewMs, reduced, halted, pending, streamLive, cause).
 */
export function createDirector({ now = () => Date.now(), validate = true, log = (...a) => globalThis.console?.error?.(...a) } = {}) {
  const memory = { recentFills: {}, lastFruitLoss: {}, played: {}, entered: {}, fruitSlot: {} };

  function prune(t) {
    for (const [k, v] of Object.entries(memory.played)) if (t - v > ONCE_MS * 4) delete memory.played[k];
    for (const [k, v] of Object.entries(memory.entered)) if (t - v > RULES.reentryMs) delete memory.entered[k];
    for (const [k, v] of Object.entries(memory.lastFruitLoss)) if (t - v > RULES.fruitRegainMs * 3) delete memory.lastFruitLoss[k];
    for (const [k, v] of Object.entries(memory.recentFills)) if (t - v.ms > RULES.coalesceMs * 10) delete memory.recentFills[k];
  }

  function run(prevViews, nextViews, event, extra = {}) {
    const t = now();
    const ctx = { ...extra, nowMs: t, recentFills: memory.recentFills, lastFruitLoss: memory.lastFruitLoss, played: memory.played, fruitSlot: memory.fruitSlot };
    let effects;
    try {
      effects = direct(prevViews, nextViews, event, ctx);
    } catch (e) {
      log('director failed', e);
      return [];
    }
    const ok = [];
    for (const e of effects) {
      if (validate) {
        try {
          assertEffect(e);
        } catch (err) {
          log('dropped an effect that breaks the Juice Contract', err);
          continue;
        }
      }
      if (ENTRY_KINDS.includes(e.kind) && e.slot !== undefined && e.slot !== null) {
        // once per plot per RULES.reentryMs: a plant flickering across a threshold does not sigh on every mark
        const key = `${e.kind}:${e.slot}`;
        if (memory.entered[key] !== undefined && t - memory.entered[key] < RULES.reentryMs) continue;
        memory.entered[key] = t;
      }
      ok.push(e);
      if (e.meta?.once) memory.played[e.meta.once] = t;
      if ((e.kind === 'fill' || e.kind === 'fillMerged' || e.kind === 'flip') && e.slot !== undefined && e.slot !== null) {
        memory.recentFills[e.slot] = { ms: event?.ms ?? t, dir: e.meta?.dir, n: e.n || 1, usd: e.usd ?? null };
      }
      if (e.kind === 'fruitLoss') {
        memory.lastFruitLoss[`${e.slot}:${e.n}`] = t;
        (memory.fruitSlot[e.slot] ||= {}).loss = t;
      }
      if (e.kind === 'fruitGain' || e.kind === 'fruitGainQuiet') (memory.fruitSlot[e.slot] ||= {}).gain = t;
    }
    prune(t);
    return ok;
  }

  return {
    run,
    memory,
    reset() {
      memory.recentFills = {};
      memory.lastFruitLoss = {};
      memory.played = {};
      memory.entered = {};
      memory.fruitSlot = {};
    },
  };
}

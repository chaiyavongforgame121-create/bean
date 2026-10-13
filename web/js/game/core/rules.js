/**
 * core/rules.js — the Juice Contract as pure, tested functions (GAME-DESIGN §1.3, §9.4).
 *
 *   coinBurst(usd)        coins flying to the crates on a harvest (0 for any loss or zero — J4)
 *   levTier(lev)          fertilizer sacks by leverage (§3.2)
 *   closeRecipe(usd)      'harvest' (≥ 0) | 'pull' (< 0)
 *   isReplayed(fill, …)   fills older than 120 s are applied without animation
 *   gust(prev, px, coins) biggest |Δ| > 0.3% between consecutive mids (caller keeps the 20 s cooldown)
 *   assertEffect(effect)  throws when an effect would break J4 / J5 / J6 / J11 (used by the director + tests)
 *
 * Pure module: no DOM, no three.js, no side effects at import.
 */

/** Every Effect kind the executor (WP4) implements, one to one with GAME-DESIGN §4 (§9.5). */
export const EFFECT_KINDS = Object.freeze([
  'pending', 'plantOk', 'plantFail', 'water', 'fill', 'fillMerged', 'flip', 'capTag',
  'fruitGain', 'fruitGainQuiet', 'fruitLoss', 'ripeOn', 'wiltOn', 'dyingOn', 'liqDangerOn', 'frozenOn', 'frozenOff',
  'harvest', 'pull', 'shade', 'resume', 'liquidate', 'bustPlanted', 'bustShelf', 'error',
  'tick', 'gust', 'weather', 'timelapse', 'burnStart', 'burnPlot', 'burnEnd', 'feedLook', 'label', 'sfx',
]);

/** Effects that celebrate (coins, sparkles, rising chimes): only ever for realized gains (J4). */
export const CELEBRATION_KINDS = Object.freeze(['harvest']);

/** Timing constants of the contract. */
export const RULES = Object.freeze({
  replayMs: 120_000, // fills older than this are replays: no animation (§4.1)
  coalesceMs: 400, // fills on one plot within this window coalesce / form a flip (§4.1)
  fruitRegainMs: 10_000, // a fruit re-gained this soon after its loss pops quietly (§4.2)
  fruitFlipLossMs: 5_000, // a fruit lost this soon after a gain on the same plot fades without a drop effect
  gustPct: 0.003, // |Δ| between consecutive mids that counts as a gust (§4.4)
  gustCooldownMs: 20_000,
  barGustPct: 0.01, // |bar return| that counts as a gust
  burnStaggerMs: 250, // burn resolves plot by plot (§4.3)
  // A plant hovering at a threshold (health 0.5, ripe at f 5 %, danger band) would re-enter it on every ~5 s mark:
  // its entry effect (sigh, leaves, glint, tickTick) plays once per plot per this window (the state still shows).
  reentryMs: 30_000,
});

/** View-diff entry effects that are throttled per plot by RULES.reentryMs (§4.2 "once per entry"). */
export const ENTRY_KINDS = Object.freeze(['ripeOn', 'wiltOn', 'dyingOn', 'liqDangerOn']);

/** Whole cents of a dollar amount, as the UI shows it ($0.004 → 0, −$0.006 → −1). */
export function cents(usd) {
  const v = Number(usd);
  return Number.isFinite(v) ? Math.round(v * 100) || 0 : 0;
}

/**
 * Coins for a realized gain: 0 if usd ≤ 0 — or if it shows as $0.00 (a sub-cent "gain" is a basket, no coin:
 * J4/§4.3 "P&L = 0: basket, no coins"); 1 (< $1); 3 (< $10); 6 (< $50); 9 (< $200); 12 (≥ $200).
 */
export function coinBurst(usd) {
  const v = Number(usd);
  if (!Number.isFinite(v) || cents(v) <= 0) return 0;
  if (v < 1) return 1;
  if (v < 10) return 3;
  if (v < 50) return 6;
  if (v < 200) return 9;
  return 12;
}

/** Fertilizer sacks: 0 (≤ 1×) | 1 (≤ 5×) | 2 (≤ 10×) | 3 (≤ 25×) | 4 (≤ 50×) | 5. */
export function levTier(lev) {
  const l = Number(lev);
  if (!Number.isFinite(l) || l <= 1) return 0;
  if (l <= 5) return 1;
  if (l <= 10) return 2;
  if (l <= 25) return 3;
  if (l <= 50) return 4;
  return 5;
}

/** How a close is shown: 'harvest' when realized ≥ 0 (a zero harvest has no coins), else 'pull'. */
export function closeRecipe(realizedUsd) {
  // judged on the shown cents: −$0.004 reads "$0.00", a zero harvest (basket), not a pull
  return cents(realizedUsd) < 0 ? 'pull' : 'harvest';
}

/**
 * A fill whose time is more than 120 s before server-now is a replay (catch-up, SSE resend): it is applied
 * to the state without any animation. `nowMs` is the client clock, `skewMs` = server − client.
 * A fill without a usable time is treated as live.
 */
export function isReplayed(fill, nowMs, skewMs = 0) {
  const t = Number(fill?.time_ms);
  if (!Number.isFinite(t)) return false;
  return t < Number(nowMs) + (Number(skewMs) || 0) - RULES.replayMs;
}

/**
 * Gust between two consecutive mids snapshots: the coin with the biggest |Δ| above 0.3%.
 * `coins` limits the check (default: every coin in `px`). → { coin, pct (signed fraction) } | null.
 */
export function gust(prevPx, px, coins) {
  if (!prevPx || !px) return null;
  const list = Array.isArray(coins) && coins.length ? coins : Object.keys(px);
  let best = null;
  for (const coin of list) {
    const a = Number(prevPx[coin]);
    const b = Number(px[coin]);
    if (!(a > 0) || !Number.isFinite(b)) continue;
    const pct = b / a - 1;
    if (Math.abs(pct) > RULES.gustPct && (!best || Math.abs(pct) > Math.abs(best.pct))) best = { coin, pct };
  }
  return best;
}

/** Biggest |bar return| above 1% from two close maps (prev bar → this bar) → { coin, pct } | null. */
export function barGust(prevClose, close, coins) {
  if (!prevClose || !close) return null;
  const list = Array.isArray(coins) && coins.length ? coins : Object.keys(close);
  let best = null;
  for (const coin of list) {
    const a = Number(prevClose[coin]);
    const b = Number(close[coin]);
    if (!(a > 0) || !Number.isFinite(b)) continue;
    const pct = b / a - 1;
    if (Math.abs(pct) > RULES.barGustPct && (!best || Math.abs(pct) > Math.abs(best.pct))) best = { coin, pct };
  }
  return best;
}

/** Money tone for a signed amount (J6: green/red mean money only). */
export function moneyTone(usd) {
  const v = Number(usd);
  if (!Number.isFinite(v) || v === 0) return 'neutral';
  return v > 0 ? 'up' : 'down';
}

class JuiceError extends Error {
  constructor(rule, message, effect) {
    super(`${rule}: ${message}`);
    this.name = 'JuiceError';
    this.rule = rule;
    this.effect = effect;
  }
}

/**
 * Throws a JuiceError when an effect breaks the contract; returns the effect otherwise.
 *   unknown kind                         → contract (the executor implements exactly EFFECT_KINDS)
 *   J4  harvest with usd < 0, or coins ≠ coinBurst(usd); pull/loss with coins or sparkles
 *   J5  any effect that tweens or counts a money value (meta.tweenMoney / meta.countUp)
 *   J6  tone 'up' on a loss or 'down' on a gain
 *   J11 a marks-driven effect other than a state crossing (meta.source === 'mids' on a non-diff kind)
 */
export function assertEffect(effect) {
  if (!effect || typeof effect !== 'object') throw new JuiceError('contract', 'effect must be an object', effect);
  const { kind, usd, n, tone, meta } = effect;
  if (!EFFECT_KINDS.includes(kind)) throw new JuiceError('contract', `unknown effect kind "${kind}"`, effect);
  const v = Number(usd);
  const hasUsd = usd !== undefined && usd !== null && Number.isFinite(v);

  if (kind === 'harvest' || (kind === 'burnPlot' && meta?.recipe === 'harvest')) {
    if (hasUsd && v < 0) throw new JuiceError('J4', 'a harvest needs realized P&L ≥ 0', effect);
    if ((n || 0) !== coinBurst(v)) throw new JuiceError('J4', `harvest coins must equal coinBurst(${v})`, effect);
  }
  if (kind === 'pull' || (kind === 'burnPlot' && meta?.recipe === 'pull') || (hasUsd && v < 0 && kind !== 'fill' && kind !== 'fillMerged' && kind !== 'flip' && kind !== 'label' && kind !== 'liquidate')) {
    if ((n || 0) !== 0) throw new JuiceError('J4', `${kind} with a loss carries no coins`, effect);
    if (meta?.sparkle || meta?.chime) throw new JuiceError('J4', `${kind} with a loss carries no sparkle or chime`, effect);
  }
  if (meta?.tweenMoney || meta?.countUp) throw new JuiceError('J5', 'money values never tween or count', effect);
  if (hasUsd && ((tone === 'up' && v < 0) || (tone === 'down' && v > 0))) {
    throw new JuiceError('J6', `tone "${tone}" does not match the sign of ${v}`, effect);
  }
  const diffKinds = ['fruitGain', 'fruitGainQuiet', 'fruitLoss', 'ripeOn', 'wiltOn', 'dyingOn', 'liqDangerOn', 'frozenOn', 'frozenOff'];
  if (meta?.source === 'mids' && !diffKinds.includes(kind)) {
    throw new JuiceError('J11', `marks only retarget springs; "${kind}" may not come from a mark`, effect);
  }
  return effect;
}

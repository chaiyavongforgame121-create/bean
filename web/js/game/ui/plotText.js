/**
 * ui/plotText.js — PURE text for one plot, shared by the dock, chips, list view, inspector and tests
 * (GAME-DESIGN §3.5 state table, §6.13 honesty rules, §7.1 dock labels).
 *
 *   stateKey(view)        → { key, vars } the plot's state caption (neutral copy, J12)
 *   stateText(view)       → localised caption
 *   pnlText(view)         → { text, tone }  "+$3.10 ▲" / "≈ −$1.20 ▼" (≈ when a client estimate, J1)
 *   pctText(view)         → "+3.1%" (always "of water" in words where there is room, §6.13 rule 3)
 *   liqText(view)         → "price must fall 10.1% to liquidate" | "no position — nothing at risk right now"
 *   liqNear(view)         → "⚠ 1.9% from liquidation" in the danger band, else ''
 *   liqSegments(view)     → 0..4 filled thermometer segments (dock ▮▮▮▯)
 *   dockLabel(view, n)    → the dock button's aria-label (g.dock.label)
 *   sideWord(view)        → LONG ↑ / SHORT ↓ / FLAT
 *
 * No DOM, no three.js, no side effects at import.
 */

import { t, hasKey } from '../../i18n.js';
import { isNum } from '../../format.js';
import { money } from './util.js';
import { cropKey } from '../core/view.js';

/** Percent with an explicit sign: 0.031 → "+3.1%", −0.012 → "−1.2%", 0 → "0.0%". */
export function signedPct(frac, d = 1) {
  if (!isNum(frac)) return '—';
  const v = Number(frac) * 100;
  const s = Math.abs(v).toFixed(d);
  if (Number(s) === 0) return `${(0).toFixed(d)}%`;
  return (v > 0 ? '+' : '−') + s + '%';
}

/** The plot's state caption (§3.5). Overlays (error, frozen, liquidation danger) win over the growth caption. */
export function stateKey(v) {
  if (!v) return { key: 'g.dock.empty', vars: {} };
  // testnet (PLATFORM §9.4): the closing state replaces everything until the position is flat
  if (v.venue === 'testnet' && v.closing) return { key: v.sync?.state === 'failed' ? 'g.state.closeWait' : 'g.state.closing', vars: {} };
  if (v.state === 'paused' && v.noteCode && hasKey('g.note.' + v.noteCode)) return { key: 'g.note.' + v.noteCode, vars: noteVarsOf(v) };
  if (v.state === 'paused') {
    // "LIQUIDATED −$X": the liquidated plot is flat, so its server total (v.usd) is what it lost — the same
    // number the P&L beside the caption shows (§1.5, §6.13 rule 9)
    if (v.note === 'liquidated') return { key: 'g.state.liquidated', vars: { usd: isNum(v.usd) ? money(v.usd, { est: !!v.est }).text : '' } };
    if (v.note === 'bean busted') return { key: 'g.state.busted', vars: {} };
    return { key: 'g.state.shade', vars: {} };
  }
  if (v.error) return { key: 'g.state.error', vars: {} };
  if (v.venue === 'testnet' && v.sync?.state === 'failed') return { key: 'g.state.syncFailed', vars: {} };
  if (v.venue === 'testnet' && v.sync?.state === 'pending') return { key: 'g.insp.syncPending', vars: {} };
  if (v.frozen) return { key: 'g.state.frozen', vars: {} };
  if (v.venue === 'testnet' && v.fillState === 'waiting_bean') return { key: 'g.insp.tnWaiting', vars: {} };
  if (v.state === 'waiting') return { key: 'g.state.waiting', vars: {} };
  if (v.state === 'entering') return { key: v.venue === 'testnet' && v.fillState === 'unfilled' ? 'g.state.unfilled' : 'g.state.entering', vars: {} };
  if (v.venue === 'testnet' && v.fillState === 'partial') return { key: 'g.state.partial', vars: {} };
  if (v.liqInfo && v.liqInfo.band === 'danger') return { key: 'g.liq.near', vars: { pct: (v.liqInfo.movePct * 100).toFixed(1) + '%' } };
  if (v.caption === 'dying') return { key: 'g.state.dying', vars: {} };
  if (v.caption === 'wilting') return { key: 'g.state.wilting', vars: {} };
  if (v.caption === 'ripe' || v.ripe) return { key: 'g.state.ripe', vars: {} };
  return { key: 'g.state.growing', vars: {} };
}

export function stateText(v) {
  const k = stateKey(v);
  return t(k.key, k.vars).replace(/\s+$/, '');
}

/** {exch, exp, coin, …} for a pause note (note_vars, sizes kept as the server wrote them). */
export function noteVarsOf(v) {
  const nv = v?.noteVars && typeof v.noteVars === 'object' ? v.noteVars : {};
  const out = { coin: v?.coin ?? '' };
  for (const [k, x] of Object.entries(nv)) if (x !== null && x !== undefined && typeof x !== 'object') out[k] = x;
  return out;
}

/** The venue word for the accessible label of a plot ("TESTNET · …"), '' for paper. */
export function venuePrefix(v) {
  return v && v.venue === 'testnet' ? t('g.venue.testnet') + ' · ' : '';
}

/** Total P&L (realized + unrealized) with sign, glyph and tone; "≈" when the unrealized part is estimated. */
export function pnlText(v, { glyph = true } = {}) {
  if (!v) return { text: '—', tone: 'none' };
  return money(v.usd, { est: !!v.est, glyph });
}

/** % of water (frac = total P&L / water). */
export function pctText(v) {
  return v ? signedPct(v.frac, 1) : '—';
}

export function sideWord(v) {
  const s = v ? v.side : 0;
  return t(s > 0 ? 'g.side.long' : s < 0 ? 'g.side.short' : 'g.side.flat');
}

/** Liquidation distance as a sentence with the direction (§6.13 rule 6). */
export function liqText(v) {
  // a testnet position before its first reconcile: the exchange's liquidationPx is not known yet (J7: never invented)
  // (a paused bot whose books differ from the exchange — drift — gets it only once the sizes match again)
  if (v && v.side && !v.liqInfo && v.venue === 'testnet') return t(v.state === 'paused' ? 'g.liq.tnPaused' : 'g.liq.tnWait');
  if (!v || !v.side || !v.liqInfo) return t('g.liq.none');
  return t(v.liqInfo.dir === 'rise' ? 'g.liq.rise' : 'g.liq.fall', { pct: (v.liqInfo.movePct * 100).toFixed(1) + '%' });
}

export function liqNear(v) {
  return v && v.liqInfo && v.liqInfo.band === 'danger' ? t('g.liq.near', { pct: (v.liqInfo.movePct * 100).toFixed(1) + '%' }) : '';
}

/** Thermometer as 4 segments (0 = at liquidation, 4 = at or beyond entry). */
export function liqSegments(v) {
  if (!v || !v.liqInfo) return 0;
  return Math.max(0, Math.min(4, Math.ceil(v.liqInfo.d * 4 - 1e-9)));
}

/** Dock button label (§7.1): coin, crop, side, leverage, P&L, % of water, state. */
export function dockLabel(v, n) {
  if (!v) return t('g.dock.emptyLabel', { n });
  return venuePrefix(v) + t('g.dock.label', {
    n,
    coin: v.coin,
    crop: t('g.crop.' + cropKey(v.coin)),
    side: sideWord(v),
    lev: Math.round(Number(v.lev) || 1),
    pnl: pnlText(v).text,
    pct: pctText(v),
    state: stateText(v) + (v.side ? ' — ' + liqText(v) : ''),
  });
}

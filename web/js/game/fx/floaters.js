/**
 * fx/floaters.js — DOM floating labels over the island (GAME-DESIGN §4.1–4.3, §6 `#fx`, §9.8).
 *
 *   createFloaters({ container, labels, camera, canvas }) → {
 *     show({ at: Vector3|Object3D, text, tone, rise = 40, ms = 1800, delay = 0, key, stack }) → Floater,
 *     update(), clear(), count
 *   }
 *   Floater = { el, setText(text, tone), done: Promise }
 *
 * Pool of 24 elements, at most 8 visible: the oldest visible floater is retired early when a 9th arrives.
 * Each floater rises 40 px and fades over 1.8 s (WAAPI on an inner span; the outer element is positioned by
 * WP2's labels.anchor or by our own projection). Reduced motion: it fades in place (no rise) — §4.1 RM.
 *
 * Juice Contract: the text is the server's number, formatted once (J1). A floater is decoration on top of
 * the DOM numbers, which already changed at t = 0 (J2); it never counts or tweens a value (J5). Money keeps
 * sign + colour class + glyph: `+$2.66 ▲` (`fx-label--up`), `-$8.20 ▼` (`fx-label--down`), `$0.00` neutral.
 *
 * Text helpers (pure, Node-tested): moneyText, fillText, effectText.
 */

import { usd, isNum } from '../../format.js';
import { t } from '../../i18n.js';
import { fmtPx, fmtSz, dirKey } from '../../model.js';

// ------------------------------------------------------------------ pure text

/** Money with sign, glyph and tone (§6.13 rule 2): +$3.10 ▲ / -$8.20 ▼ / $0.00. */
export function moneyText(x, { est = false, glyph = true, d = 2 } = {}) {
  if (!isNum(x)) return { text: '—', tone: 'neutral' };
  const v = Number(x);
  const body = usd(v, d, true).replace(/^-/, '−'); // typographic minus, as the HUD and chips
  const zero = body === usd(0, d);
  const tone = zero ? 'neutral' : v > 0 ? 'up' : 'down';
  const g = glyph && !zero ? (tone === 'up' ? ' ▲' : ' ▼') : '';
  return { text: (est ? '≈ ' : '') + body + g, tone };
}

/** Whole dollars when the stake is round ("$100"), cents otherwise. */
function stakeText(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return '—';
  return usd(v, Math.abs(v - Math.round(v)) < 1e-9 ? 0 : 2);
}

/**
 * Fill floater (§4.1):  open  → "Open Long 0.00500 BTC @ $82,410.0"           (neutral)
 *                       close → "Close Long @ $82,980.5 · realized +$2.66 ▲"   (money tone)
 * `usd` is the fill's net realized (closed_pnl − fee) from the director; `n` > 1 appends "×N fills".
 */
export function fillText(effect) {
  const m = effect?.meta || {};
  const dk = dirKey(m.dir);
  const dir = dk ? t(dk) : String(m.dir || '');
  const coin = effect?.coin ?? m.coin ?? '';
  // unknown size decimals → the server's raw size (never rounded to "0")
  const szd = Number.isInteger(m.szDecimals) ? m.szDecimals : null;
  const px = fmtPx(m.px, szd ?? 0);
  const open = m.open ?? /^Open /.test(String(m.dir || ''));
  let text;
  let tone = 'neutral';
  if (open) {
    const sz = szd === null ? (Number.isFinite(Number(m.sz)) ? String(Math.abs(Number(m.sz))) : '—') : fmtSz(m.sz, szd);
    text = t('g.fx.fill', { dir, sz, coin, px });
  } else {
    const mt = moneyText(effect?.usd);
    tone = mt.tone;
    text = t('g.fx.fillClose', { dir, px, pnl: mt.text });
  }
  const n = Number(effect?.n) || 1;
  if (n > 1) text += ' · ' + t('g.fx.merged', { n });
  return { text, tone };
}

/**
 * The floater text of any effect that has one (null when it has none).
 *   water → "watered $100"; harvest → "+$12.40 ▲ harvested"; pull → "-$8.20 ▼ realized loss";
 *   capTag → "order skipped: notional cap" (warn); shade with a realized amount → that amount;
 *   liquidate → "LIQUIDATED -$70.80 ▼"; label → its own text/tone.
 */
export function effectText(effect) {
  if (!effect) return null;
  switch (effect.kind) {
    case 'fill':
    case 'fillMerged':
      return fillText(effect);
    case 'water':
      return isNum(effect.usd) ? { text: t('g.fx.watered', { usd: stakeText(effect.usd) }), tone: 'neutral' } : null;
    case 'harvest':
    case 'pull': {
      const mt = moneyText(effect.usd);
      const key = effect.kind === 'harvest' ? 'g.fx.harvested' : 'g.fx.realizedLoss';
      return { text: t(key, { usd: mt.text }), tone: mt.tone };
    }
    case 'burnPlot': {
      const mt = moneyText(effect.usd, { est: !!effect.meta?.est });
      const key = effect.meta?.recipe === 'pull' ? 'g.fx.realizedLoss' : 'g.fx.harvested';
      return { text: t(key, { usd: mt.text }), tone: mt.tone };
    }
    case 'capTag':
      return { text: t('g.fx.capped'), tone: 'warn' };
    case 'shade':
      if (isNum(effect.usd) && Number(effect.usd) !== 0) {
        const mt = moneyText(effect.usd);
        return { text: mt.text, tone: mt.tone };
      }
      return null;
    case 'liquidate': {
      if (!isNum(effect.usd)) return { text: t('g.state.liquidated', { usd: '' }).trim(), tone: 'down' };
      const mt = moneyText(-Math.abs(Number(effect.usd)), { est: !!effect.meta?.est });
      return { text: t('g.state.liquidated', { usd: mt.text }), tone: 'down' };
    }
    case 'label':
      return effect.text ? { text: String(effect.text), tone: effect.tone || 'neutral' } : null;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ DOM pool

const POOL = 24;
const MAX_VISIBLE = 8;

/**
 * DOM floaters. `container` defaults to `#fx`. Positions come from `labels.anchor()` (WP2) when present,
 * else from our own projection with `camera` (+ `canvas` for the size); without either they show nowhere.
 */
export function createFloaters({ container = null, labels = null, camera = null, canvas = null, reduced = () => false, Vector3 = null } = {}) {
  // `Vector3` (three's class) is injected by the executor so this module stays importable in Node.
  const doc = globalThis.document;
  const box = container || doc?.getElementById?.('fx') || null;
  const free = [];
  const live = [];
  const useLabels = !!(labels && typeof labels.anchor === 'function');
  let tmp = null;

  function makeEl() {
    const el = doc.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    const s = el.style;
    s.position = 'absolute';
    s.left = '0';
    s.top = '0';
    s.pointerEvents = 'none';
    s.whiteSpace = 'nowrap';
    s.translate = '-50% -100%'; // centred above the point (independent of the projector's transform)
    const inner = doc.createElement('span');
    inner.className = 'fx-label__text';
    inner.style.display = 'inline-block';
    el.appendChild(inner);
    return { el, inner };
  }

  function retire(f) {
    const i = live.indexOf(f);
    if (i >= 0) live.splice(i, 1);
    try {
      f.anim?.cancel?.();
    } catch {
      /* ignore */
    }
    try {
      f.handle?.remove?.();
    } catch {
      /* ignore */
    }
    f.el.hidden = true;
    f.el.remove();
    free.push(f.node);
    f.resolve?.(true);
  }

  /**
   * Show a floater. `at` is a world point (Vector3) or an Object3D to follow. `stack` (0, 1, …) offsets
   * stacked floaters (flip: two labels 120 ms apart) by 22 px each.
   */
  function show({ at, text = '', tone = 'neutral', rise = 40, ms = 1800, delay = 0, stack = 0, cls = '' } = {}) {
    if (!doc || !box || !at) return NULL_FLOATER;
    if (live.length >= MAX_VISIBLE) retire(live[0]);
    const node = free.pop() || (live.length + free.length < POOL ? makeEl() : null);
    if (!node) return NULL_FLOATER;
    const { el, inner } = node;
    el.className = `fx-label fx-label--${tone} fx-floater ${cls}`.trim();
    inner.textContent = text;
    el.hidden = false;
    box.appendChild(el);
    let resolve;
    const done = new Promise((r) => (resolve = r));
    const f = { node, el, inner, at, stack, resolve, done, anim: null, handle: null, born: performance?.now?.() ?? Date.now() };
    // `at` is an Object3D to follow or a world point; WP2's labels project both (gfx/labels.js)
    if (useLabels) {
      try {
        f.handle = labels.anchor(at, el, { offsetY: 0, hideBehind: true });
      } catch {
        f.handle = null;
      }
    }
    live.push(f);
    const rm = !!reduced();
    const lift = rm ? 0 : -Math.abs(rise);
    const dy = -22 * stack;
    try {
      f.anim = inner.animate(
        rm
          ? [{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, offset: 0.1, transform: `translateY(${dy}px)` }, { opacity: 1, offset: 0.75, transform: `translateY(${dy}px)` }, { opacity: 0, transform: `translateY(${dy}px)` }]
          : [
              { opacity: 0, transform: `translateY(${dy + 6}px) scale(0.92)` },
              { opacity: 1, offset: 0.12, transform: `translateY(${dy}px) scale(1)` },
              { opacity: 1, offset: 0.7, transform: `translateY(${dy + lift * 0.75}px) scale(1)` },
              { opacity: 0, transform: `translateY(${dy + lift}px) scale(1)` },
            ],
        { duration: Math.max(300, ms), delay: Math.max(0, delay), easing: 'cubic-bezier(.22,.8,.3,1)', fill: 'both' },
      );
      f.anim.onfinish = () => retire(f);
    } catch {
      setTimeout(() => retire(f), ms + delay);
    }
    position(f);
    return {
      el,
      done,
      /** Replace the text (fillMerged: the last fill plus "×N fills") and restart the timer. */
      setText(next, nextTone) {
        inner.textContent = next;
        if (nextTone) el.className = `fx-label fx-label--${nextTone} fx-floater ${cls}`.trim();
        try {
          f.anim.currentTime = Math.min(f.anim.currentTime ?? 0, 200);
        } catch {
          /* ignore */
        }
      },
      get alive() {
        return live.includes(f);
      },
    };
  }

  function position(f) {
    if (f.handle) return; // WP2 labels position it
    if (!camera || !Vector3) {
      f.el.hidden = !camera;
      return;
    }
    tmp = tmp || new Vector3();
    if (f.at.isVector3) tmp.copy(f.at);
    else f.at.getWorldPosition(tmp);
    tmp.project(camera);
    const behind = tmp.z > 1 || tmp.z < -1;
    f.el.hidden = behind;
    if (behind) return;
    const w = canvas?.clientWidth || box.clientWidth || globalThis.innerWidth || 1;
    const h = canvas?.clientHeight || box.clientHeight || globalThis.innerHeight || 1;
    const x = (tmp.x * 0.5 + 0.5) * w;
    const y = (-tmp.y * 0.5 + 0.5) * h;
    f.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }

  function update() {
    for (const f of live) position(f);
  }

  function clear() {
    for (const f of [...live]) retire(f);
  }

  return {
    show,
    update,
    clear,
    get count() {
      return live.length;
    },
  };
}

const NULL_FLOATER = Object.freeze({ el: null, done: Promise.resolve(true), setText() {}, alive: false });

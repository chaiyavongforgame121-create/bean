/**
 * ui/ticker.js — the real-price ticker row (GAME-DESIGN §6.4, J2, J6, J9).
 *
 *   🍊 BTC $82,980.5 ▴1.2% · 🍆 ETH $2,509.35 ▾0.8% · … (one horizontally scrollable row, never auto-scrolling)
 *
 *   - price = newest server mid (mids pulse, else the market snapshot), fmtPx() venue precision;
 *   - 24 h change in neutral ink with ▴/▾ (price direction is never a money colour, J6);
 *   - `SIM` tag on every item with simulated prices, `delayed · 40 s` on a stale coin (J9, §6.12);
 *   - order: planted coins first, then by |24 h change| — recomputed on market refresh, not on every mark, so the
 *     row does not jump under the reader's eyes;
 *   - a changed price flips old → new in ≤ 300 ms (reduced motion: no flip). The DOM text is the new value at
 *     t = 0 (J2): the flip is decoration only, it never shows a value in between;
 *   - a gust (bus game:event {type:'gust', coin, pct}) outlines that coin for 3 s and captions it.
 *
 * Exports: mount(deps) → { render() }.  No three.js, no side effects at import.
 */

import { t, onLangChange } from '../../i18n.js';
import { fmtPx } from '../../model.js';
import { isNum } from '../../format.js';
import { getCtx, on } from './context.js';
import { h, $, setText, setAttr, cropIcon, chgText, ageText, ageKind, watch, reducedMotion } from './util.js';
import * as D from './derive.js';

const FLIP_MS = 300;
const GUST_MS = 3000;

/** Pure: ticker order — planted coins first (in slot order), then by |change_24h| descending, then by name. */
export function tickerOrder(coins, planted = []) {
  const first = planted.filter((c, i) => planted.indexOf(c) === i && coins.some((x) => x.coin === c));
  const rest = coins
    .filter((c) => !first.includes(c.coin))
    .sort((a, b) => {
      const da = Math.abs(Number(a.change_24h) || 0);
      const db = Math.abs(Number(b.change_24h) || 0);
      return db - da || String(a.coin).localeCompare(String(b.coin));
    })
    .map((c) => c.coin);
  return [...first, ...rest];
}

export function mount(deps) {
  const ctx = getCtx(deps);
  if (!ctx.claim('ticker')) return ctx.mods.ticker;
  const { store } = ctx;
  const list = $('tickerList');
  const items = new Map(); // coin → { li, px, chg, tag, last }
  let order = [];
  let orderKey = '';
  const gustCap = h('p', { class: 'ticker-gust', id: 'tickerGust', 'aria-live': 'off', hidden: true });
  $('ticker')?.append(gustCap);

  function makeItem(coin) {
    const pxWrap = h('span', { class: 'tk-pxwrap' }, h('span', { class: 'tk-px num' }));
    const li = h(
      'li',
      { class: 'tk', dataset: { coin } },
      h('span', { class: 'tk-crop' }, cropIcon(coin)),
      h('span', { class: 'tk-coin', text: coin }),
      pxWrap,
      h('span', { class: 'tk-chg num' }),
      h('span', { class: 'tk-tag', hidden: true }),
    );
    const it = { li, pxWrap, px: pxWrap.firstChild, chg: li.querySelector('.tk-chg'), tag: li.querySelector('.tk-tag'), last: null };
    items.set(coin, it);
    return it;
  }

  function plantedCoins(s) {
    const v = D.viewsOf(s);
    return [...v.list.filter(Boolean), ...v.hidden].map((x) => x.coin);
  }

  function render() {
    if (!list) return;
    const s = store.get();
    const coins = D.coinList(s);
    const sim = D.isSim(s);
    // J9: never call the prices real (or simulated) before the server said which they are
    setText($('tickerTitle'), t(!s.feed?.source ? 'g.ticker.labelUnknown' : sim ? 'g.ticker.labelSim' : 'g.ticker.label'));
    const planted = plantedCoins(s);
    const key = `${s.market?.fetchedMs ?? ''}|${coins.length}|${planted.join(',')}`;
    if (key !== orderKey) {
      orderKey = key;
      order = tickerOrder(coins, planted);
      const kids = order.map((c) => (items.get(c) || makeItem(c)).li);
      list.replaceChildren(...kids);
    }
    const nowMs = D.nowOf(s);
    const rm = reducedMotion();
    for (const coin of order) {
      const it = items.get(coin);
      const row = D.coinOf(s, coin) || {};
      const p = D.priceOf(s, coin);
      const text = fmtPx(p.px, row.sz_decimals);
      if (it.last !== text) {
        const old = it.last;
        setText(it.px, text); // t = 0: the new number is in the DOM before any animation (J2)
        if (old && !rm && p.px !== null) flip(it, old);
        it.last = text;
      }
      const ch = isNum(row.change_24h) ? Number(row.change_24h) : null;
      setText(it.chg, chgText(ch, 1));
      it.chg.dataset.dir = ch === null ? '' : ch > 0 ? 'up' : ch < 0 ? 'down' : '';
      // SIM on every simulated price; "delayed · 40 s" on a stale coin (J9, §6.12)
      let tag = '';
      let tone = '';
      // real prices 15–60 s old get the amber "delayed · 25 s" tag too, not only frozen (> 60 s) coins (§6.4, §6.12)
      const kind = !sim && p.px !== null ? ageKind(p.ms, nowMs) : 'fresh';
      if (p.stale) {
        tag = t('g.age.delayed', { age: ageText(p.ms, nowMs) });
        tone = 'delayed';
      } else if (kind !== 'fresh') {
        tag = t(kind === 'delayed' ? 'g.age.delayed' : 'g.age.stale', { age: ageText(p.ms, nowMs) });
        tone = 'delayed';
      } else if (sim) {
        tag = t('g.ticker.sim');
        tone = 'sim';
      }
      it.tag.hidden = !tag;
      setText(it.tag, tag);
      it.tag.dataset.tone = tone;
      it.li.classList.toggle('is-stale', p.stale);
      setAttr(it.li, 'aria-label', t('g.ticker.item', { coin, px: text, chg: chgText(ch, 1) }) + (tag ? ` (${tag})` : ''));
    }
  }

  function flip(it, oldText) {
    it.pxWrap.querySelector('.tk-old')?.remove();
    const old = h('span', { class: 'tk-old num', 'aria-hidden': 'true', text: oldText });
    it.pxWrap.append(old);
    it.px.classList.remove('is-in');
    // restart the CSS animation
    void it.px.offsetWidth;
    it.px.classList.add('is-in');
    setTimeout(() => {
      old.remove();
      it.px.classList.remove('is-in');
    }, FLIP_MS + 20);
  }

  // gusts: outline the coin and caption it (neutral ink — a gust is a move, not a gain or loss)
  let gustTimer = 0;
  on(ctx, 'game:event', (ev) => {
    if (!ev || ev.type !== 'gust' || !ev.coin) return;
    const it = items.get(ev.coin);
    it?.li.classList.add('is-gust');
    setText(gustCap, t('g.wind.gust', { coin: ev.coin, pct: (Number(ev.pct) > 0 ? '+' : '−') + Math.abs(Number(ev.pct) * 100).toFixed(2) + '%' }));
    gustCap.hidden = false;
    clearTimeout(gustTimer);
    gustTimer = setTimeout(() => {
      it?.li.classList.remove('is-gust');
      gustCap.hidden = true;
    }, GUST_MS);
  });

  $('tickerAll')?.addEventListener('click', (e) => ctx.sheets?.open('board', { opener: e.currentTarget }));

  watch(store, (s) => [s.market, s.marks?.t, s.feed, s.bots, s.slots], render, (a, b) => !!a && !!b && a.every((x, i) => Object.is(x, b[i])));
  const timer = setInterval(render, 5000); // delayed-tag ages
  onLangChange(() => {
    orderKey = '';
    render();
  });

  const apiOut = { render, dispose: () => clearInterval(timer) };
  ctx.mods.ticker = apiOut;
  return apiOut;
}

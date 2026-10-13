/**
 * crops/catalog.js — PURE data: which crop grows for which coin (GAME-DESIGN §3.1).
 *
 * No three.js import and no side effects, so Node tests can load it. `crops/builders.js` turns an entry into
 * geometry: `builder` picks one of the 9 parametric builders and `variant` picks the species inside it.
 *
 * Colour rules (J6): crop colours are nature colours. They never carry money or side meaning, and the DOM chip
 * always names the coin, so a crop is never the only cue to its coin.
 *
 * Entry fields:
 *   coin, name (EN, for debugging; UI text uses t(key)), key ('g.crop.<COIN>'), builder, variant,
 *   leaf    lush leaf colour (health ≥ 0.6; `field/growth.js leafTone()` mixes it toward sick/dead),
 *   stem    stem/trunk colour,
 *   unripe / ripe   fruit colour at f ≤ 2 % / f ≥ 5 % (lerp by `ripeness(f)`),
 *   flower  petal colour of the open flowers, accent: optional flourish colour (see each entry),
 *   height  local crop height at size 1 (u), used by the bend shader and for anchors.
 */

/** The 9 parametric builders (§3.1). */
export const BUILDERS = Object.freeze(['tree', 'stalk', 'vine', 'bush', 'hangingBush', 'groundRosette', 'rootCrop', 'grassClump', 'fungus']);

/** Health-tint end points shared with plant.js healthTone() (§3.4 "same thresholds and colours"). */
export const TONE = Object.freeze({ sick: '#C4B048', dead: '#805E3C' });

/** Key used for any coin without its own crop. */
export const FALLBACK = 'other';

const entry = (o) => Object.freeze({ ...o, key: `g.crop.${o.coin}` });

/** coin → crop. Exactly the palettes and silhouettes of GAME-DESIGN §3.1. */
export const CROPS = Object.freeze({
  BTC: entry({ coin: 'BTC', name: 'orange tree', builder: 'tree', variant: 'orange', leaf: '#5E9E58', stem: '#7A5236', unripe: '#9CC46A', ripe: '#F39A2E', flower: '#FFF6E6', accent: null, height: 3.0 }),
  ETH: entry({ coin: 'ETH', name: 'eggplant', builder: 'hangingBush', variant: 'eggplant', leaf: '#6FA36A', stem: '#4E7A4A', unripe: '#8C7BB8', ripe: '#4B3A8C', flower: '#C9B6E4', accent: '#5E8F4E', height: 1.7 }),
  SOL: entry({ coin: 'SOL', name: 'sunflower', builder: 'stalk', variant: 'sunflower', leaf: '#79B25C', stem: '#5F9A48', unripe: '#E9D27A', ripe: '#F5C04A', flower: '#F5C04A', accent: '#6B4A2E', height: 2.8 }),
  HYPE: entry({ coin: 'HYPE', name: 'hops', builder: 'vine', variant: 'hops', leaf: '#64B98F', stem: '#4E9A72', unripe: '#B8E6CC', ripe: '#5FD1A6', flower: '#F2EDB8', accent: '#A87B4F', height: 3.0 }),
  XRP: entry({ coin: 'XRP', name: 'rice', builder: 'grassClump', variant: 'rice', leaf: '#8CC56A', stem: '#7AB55A', unripe: '#C9D67A', ripe: '#E8C25A', flower: '#FFF8DC', accent: '#8FD3E8', height: 1.25 }),
  DOGE: entry({ coin: 'DOGE', name: 'corn', builder: 'stalk', variant: 'corn', leaf: '#7DB55A', stem: '#6FA34E', unripe: '#E8E19A', ripe: '#F2C94C', flower: '#E6C76A', accent: '#7DB55A', height: 2.5, popcorn: true }),
  AVAX: entry({ coin: 'AVAX', name: 'chili pepper', builder: 'hangingBush', variant: 'chili', leaf: '#5FA061', stem: '#4D8A4F', unripe: '#8FC46A', ripe: '#E0453A', flower: '#FFFFFF', accent: '#3F7A3E', height: 1.25 }),
  LINK: entry({ coin: 'LINK', name: 'peas', builder: 'vine', variant: 'peas', leaf: '#6DB36E', stem: '#5AA05C', unripe: '#A9D98A', ripe: '#5C8FD6', flower: '#F7F0FA', accent: '#C9A86B', height: 2.4 }),
  SUI: entry({ coin: 'SUI', name: 'watermelon', builder: 'groundRosette', variant: 'watermelon', leaf: '#6AAE5C', stem: '#5A9A4C', unripe: '#A8D08A', ripe: '#3E8F4A', flower: '#F4D35E', accent: '#2F6B36', height: 0.7 }),
  NEAR: entry({ coin: 'NEAR', name: 'carrot', builder: 'rootCrop', variant: 'carrot', leaf: '#78B75A', stem: '#6AA650', unripe: '#F2B27A', ripe: '#F07D2B', flower: '#FBF7EA', accent: null, height: 1.15 }),
  ARB: entry({ coin: 'ARB', name: 'blueberry', builder: 'bush', variant: 'blueberry', leaf: '#5D9E6A', stem: '#6B5040', unripe: '#B9D3E8', ripe: '#3F6FC4', flower: '#FFF9F2', accent: null, height: 1.35 }),
  TIA: entry({ coin: 'TIA', name: 'tea bush', builder: 'bush', variant: 'tea', leaf: '#5FA45E', stem: '#6B5040', unripe: '#D9E8C9', ripe: '#B79AE0', flower: '#FFFFFF', accent: '#F4D35E', height: 1.3 }),
  ZEC: entry({ coin: 'ZEC', name: 'zucchini', builder: 'groundRosette', variant: 'zucchini', leaf: '#6CAA58', stem: '#5A984A', unripe: '#D7E39A', ripe: '#F1CF3B', flower: '#F6C945', accent: null, height: 0.75 }),
  WIF: entry({ coin: 'WIF', name: 'mushroom in a knit hat', builder: 'fungus', variant: 'wif', leaf: '#6E9E5A', stem: '#F1E6D2', unripe: '#E9D8C4', ripe: '#D2553F', flower: '#FFF4F8', accent: '#F4A6C6', height: 1.35 }),
  PUMP: entry({ coin: 'PUMP', name: 'pumpkin', builder: 'groundRosette', variant: 'pumpkin', leaf: '#6FAE5A', stem: '#5C984B', unripe: '#C9D98A', ripe: '#F08A2C', flower: '#F7C948', accent: '#6E7A3A', height: 0.75 }),
  VVV: entry({ coin: 'VVV', name: 'grapes', builder: 'vine', variant: 'grapes', leaf: '#6AA65E', stem: '#7A5A3E', unripe: '#C7D6A0', ripe: '#8E2F57', flower: '#E9F0C8', accent: '#A87B4F', height: 2.4 }),
  other: entry({ coin: 'other', name: 'beanstalk', builder: 'vine', variant: 'beanstalk', leaf: '#6DB56A', stem: '#5CA35A', unripe: '#8FD17A', ripe: '#4E9A3F', flower: '#FFFFFF', accent: null, height: 2.8 }),
});

/** The crop for a coin; unknown, empty or missing coins get the beanstalk. */
export function cropFor(coin) {
  const c = String(coin ?? '');
  return Object.prototype.hasOwnProperty.call(CROPS, c) ? CROPS[c] : CROPS[FALLBACK];
}

/** i18n key of a coin's crop name (`g.crop.<COIN>` or `g.crop.other`). */
export function cropKey(coin) {
  return cropFor(coin).key;
}

/** Every colour field of an entry, for palette validation. */
export const COLOR_FIELDS = Object.freeze(['leaf', 'stem', 'unripe', 'ripe', 'flower', 'accent']);

/** '#RRGGBB' (6 hex digits; no alpha, no shorthand). */
export function isHex(s) {
  return typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
}

/** '#RRGGBB' → [r, g, b] in 0..255 (sRGB). */
export function hexRgb(s) {
  const n = parseInt(String(s).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** [r, g, b] 0..255 → '#RRGGBB'. */
export function rgbHex(c) {
  return '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * plant.js — the garden's pure canvas renderer. No DOM access: everything is
 * drawn through the 2D context handed in, so it runs in a browser, an
 * OffscreenCanvas or a Node test with a mock context.
 *
 *   stage(bot)                               → growth state derived from a BotRow (SPEC §5 growth model)
 *   drawPlant(ctx, w, h, bot, t, opts)       → paints one plot (w×h in CSS pixels; the caller scales for DPR)
 *   drawSparkline(ctx, w, h, values, opts)   → equity sparkline for a seed packet
 *
 * Growth model (kept exactly as the studied garden):
 *   f      = (realized_pnl + real.unrealized_pnl) / capital_usd
 *   size   = clamp(0.25 + 6f + (phase === 'waiting' ? 0 : 0.1), 0.12, 1)
 *   health = clamp(1 + 8f, 0, 1)
 *   fruit  = f > 2% and health > 0.6 → one per 2% (max 6);  flower when health > 0.4
 *   captions: dying (health < 0.2), wilting (< 0.5), ripe (f > 5%), shade (paused)
 */

import { clamp } from './format.js';

export const GROWTH = Object.freeze({
  sizeBase: 0.25,
  sizePerFrac: 6,
  sizeActiveBonus: 0.1,
  sizeMin: 0.12,
  sizeMax: 1,
  healthPerFrac: 8,
  fruitMinFrac: 0.02,
  fruitMinHealth: 0.6,
  fruitStep: 0.02,
  fruitMax: 6,
  flowerMinHealth: 0.4,
  ripeFrac: 0.05,
  wiltHealth: 0.5,
  dyingHealth: 0.2,
  droopHealth: 0.3,
});

/** Caption texts used when the caller passes no `opts.labels` (garden.js passes translated ones). */
export const DEFAULT_LABELS = Object.freeze({
  waiting: 'waiting for the bean to enter…',
  entering: 'entering…',
  shade: 'in the shade (paused, flat)',
  wilting: 'wilting…',
  dying: 'dying — pull it? 🪓',
  ripe: 'ripe — harvest? 🧺',
});

const CAPTION_COLOR = {
  waiting: '#dfe6ee',
  entering: '#bdf0c4',
  shade: '#cfd6e0',
  wilting: '#f2c14e',
  dying: '#ff8a80',
  ripe: '#ffd36b',
};

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

// ------------------------------------------------------------------ model

/** PnL of a bot in dollars and as a fraction of its capital (realized + unrealized). */
export function botPnl(bot) {
  const usd = num(bot?.realized_pnl) + num(bot?.real?.unrealized_pnl);
  const cap = num(bot?.capital_usd);
  return { usd, frac: cap > 0 ? usd / cap : 0 };
}

/** closed → paused → error → (flat position) entering | waiting → long | short. */
export function botPhase(bot) {
  if (!bot) return 'waiting';
  if (bot.state === 'closed') return 'closed';
  if (bot.state === 'paused') return 'paused';
  if (bot.last_error) return 'error';
  const szi = num(bot.real?.szi);
  if (!szi) return num(bot.bean_side) ? 'entering' : 'waiting';
  return szi > 0 ? 'long' : 'short';
}

/**
 * Everything the renderer (and the plot label) needs to know about a bot.
 * → { phase, usd, frac, size, health, seed, fruit, flower, caption, shaded }
 * `caption` is a DEFAULT_LABELS key or null; `shaded` adds the shade caption.
 */
export function stage(bot) {
  const G = GROWTH;
  const phase = botPhase(bot);
  const { usd, frac } = botPnl(bot);
  const size = clamp(G.sizeBase + G.sizePerFrac * frac + (phase === 'waiting' ? 0 : G.sizeActiveBonus), G.sizeMin, G.sizeMax);
  const health = clamp(1 + G.healthPerFrac * frac, 0, 1);
  const seed = phase === 'waiting' || phase === 'entering';
  // +1e-9 so exactly 6% reads as 3 fruit despite 0.06 / 0.02 = 2.9999…
  const fruit = frac > G.fruitMinFrac && health > G.fruitMinHealth ? Math.min(G.fruitMax, Math.floor(frac / G.fruitStep + 1e-9)) : 0;
  const flower = health > G.flowerMinHealth;
  let caption = null;
  if (seed) caption = phase;
  else if (phase !== 'closed') {
    if (health < G.dyingHealth) caption = 'dying';
    else if (health < G.wiltHealth) caption = 'wilting';
    else if (frac > G.ripeFrac) caption = 'ripe';
  }
  return { phase, usd, frac, size, health, seed, fruit, flower, caption, shaded: phase === 'paused' };
}

// ------------------------------------------------------------------ colour + randomness helpers

const rgb = (c, a = 1) => (a >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`);
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/** Lush above 0.6 health, fading to sick yellow by 0.2, then quickly to dead brown. */
function healthTone(health, lush, sick, dead) {
  if (health >= 0.6) return lush;
  if (health >= 0.2) return mix(sick, lush, (health - 0.2) / 0.4);
  return mix(dead, sick, (health / 0.2) * 0.35);
}

const LEAF = { lush: [98, 188, 92], sick: [196, 176, 72], dead: [128, 94, 60] };
const STEM = { lush: [54, 126, 64], sick: [146, 132, 60], dead: [107, 88, 64] };

/** Small deterministic PRNG (mulberry32) so every plot keeps its own stars, pebbles and lean. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(bot) {
  const i = Number(bot?.index);
  if (Number.isFinite(i)) return (Math.imul(i + 1, 2654435761) ^ 0x9e3779b9) >>> 0;
  let h = 2166136261;
  for (const ch of String(bot?.id ?? '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Point on a quadratic Bézier. */
function quad(p0, p1, p2, k) {
  const m = 1 - k;
  return { x: m * m * p0.x + 2 * m * k * p1.x + k * k * p2.x, y: m * m * p0.y + 2 * m * k * p1.y + k * k * p2.y };
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function disc(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.1, r), 0, Math.PI * 2);
  ctx.fill();
}

// ------------------------------------------------------------------ scene pieces

/** Night sky behind the plant: bluer when healthy, a sickly dusk when dying, with twinkling stars. */
function drawSky(ctx, w, h, s, L, tm, rand) {
  const top = mix([46, 22, 30], [12, 22, 44], clamp(s.health * 1.4, 0, 1));
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, rgb(top));
  g.addColorStop(0.72, '#1d2c48');
  g.addColorStop(1, '#25344f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 7; i++) {
    const x = rand() * w;
    const y = rand() * L.soilTop * 0.7;
    const r = (0.5 + rand() * 0.8) * L.u;
    const phase = rand() * 6.283;
    const a = tm ? 0.3 + 0.7 * Math.abs(Math.sin(tm / 1400 + phase)) : 0.65;
    ctx.fillStyle = `rgba(255,246,214,${a.toFixed(3)})`;
    disc(ctx, x, y, r);
  }
}

/** Golden halo (+ a few falling water drops) right after a fill. */
function drawGlow(ctx, w, h, L, glow) {
  const cy = L.soilTop - L.plantH * 0.5;
  const R = Math.max(w, h) * 0.7;
  const g = ctx.createRadialGradient(L.cx, cy, 0, L.cx, cy, R);
  g.addColorStop(0, `rgba(255,214,102,${(0.55 * glow).toFixed(3)})`);
  g.addColorStop(1, 'rgba(255,214,102,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = `rgba(150,210,255,${(0.9 * glow).toFixed(3)})`;
  for (let k = -1; k <= 1; k++) {
    const x = L.cx + k * 14 * L.u;
    const y = L.top + (L.soilTop - L.top) * (1 - glow) * (0.8 + 0.1 * (k + 1)) + 6 * L.u;
    ctx.beginPath();
    ctx.moveTo(x, y - 5 * L.u);
    ctx.quadraticCurveTo(x + 3 * L.u, y, x, y + 2.5 * L.u);
    ctx.quadraticCurveTo(x - 3 * L.u, y, x, y - 5 * L.u);
    ctx.fill();
  }
}

/** Soil mound in front of the stem base: rich + mossy, dry + ochre, or dark + cracked. */
function drawSoil(ctx, w, h, s, L, tm, rand) {
  const u = L.u;
  const tone =
    s.health > 0.5
      ? { hi: '#5d4029', lo: '#2e1f13', rim: '#4b7a3f' }
      : s.health > 0.2
        ? { hi: '#705a37', lo: '#3a2d1a', rim: '#7a6a3f' }
        : { hi: '#3f281a', lo: '#1d130b', rim: '#5a3a2a' };
  const g = ctx.createLinearGradient(0, L.soilTop - 8 * u, 0, h);
  g.addColorStop(0, tone.hi);
  g.addColorStop(1, tone.lo);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, L.rimY0);
  ctx.quadraticCurveTo(L.cx, L.rimYc, w, L.rimY0);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  // rim line (moss / dry grass / bare)
  ctx.strokeStyle = tone.rim;
  ctx.lineWidth = 3 * u;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, L.rimY0);
  ctx.quadraticCurveTo(L.cx, L.rimYc, w, L.rimY0);
  ctx.stroke();
  // pebbles
  for (let i = 0; i < 4; i++) {
    const x = rand() * w;
    const y = L.moundY(x) + (6 + rand() * (h - L.soilTop - 10)) * 0.8;
    ctx.fillStyle = `rgba(214,190,150,${(0.18 + rand() * 0.2).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(x, Math.min(h - 3 * u, y), (1.6 + rand() * 2) * u, (1 + rand() * 1.2) * u, rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // grass tufts on healthy soil, cracks on dead soil
  if (s.health > 0.5) {
    ctx.strokeStyle = '#5f9a4c';
    ctx.lineWidth = 1.3 * u;
    for (let i = 0; i < 5; i++) {
      const x = (0.06 + rand() * 0.88) * w;
      if (Math.abs(x - L.cx) < 14 * u) continue; // keep the stem base clear
      const y = L.moundY(x) + 1 * u;
      const wob = tm ? Math.sin(tm / 800 + i) * 1.5 * u : 0;
      for (let b = -1; b <= 1; b++) {
        ctx.beginPath();
        ctx.moveTo(x + b * 2 * u, y);
        ctx.quadraticCurveTo(x + b * 3 * u + wob, y - 4 * u, x + b * 4.5 * u + wob, y - (6 + (b === 0 ? 3 : 0)) * u);
        ctx.stroke();
      }
    }
  } else if (s.health < 0.2) {
    ctx.strokeStyle = 'rgba(10,6,3,0.6)';
    ctx.lineWidth = 1.1 * u;
    for (let i = 0; i < 2; i++) {
      let x = (0.2 + rand() * 0.6) * w;
      let y = L.moundY(x) + 4 * u;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = 0; k < 3; k++) {
        x += (rand() - 0.5) * 10 * u;
        y += (3 + rand() * 4) * u;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
}

/** One almond leaf with a lighter upper half and a midrib. `ang` > 0 droops it. */
function drawLeaf(ctx, x, y, len, ang, side, color, u) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(side, 1);
  ctx.rotate(ang);
  ctx.fillStyle = rgb(color);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(len * 0.45, -len * 0.36, len, 0);
  ctx.quadraticCurveTo(len * 0.45, len * 0.3, 0, 0);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.13)';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(len * 0.45, -len * 0.36, len, 0);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = rgb(mix(color, [20, 40, 20], 0.45));
  ctx.lineWidth = Math.max(0.6, 0.9 * u);
  ctx.beginPath();
  ctx.moveTo(1 * u, 0);
  ctx.lineTo(len * 0.86, 0);
  ctx.stroke();
  ctx.restore();
}

/** A sprout (and the bean it came from) while the bot waits for its bean to enter. */
function drawSeedling(ctx, s, L, tm) {
  const u = L.u;
  const sx = L.cx;
  const sy = L.moundY(sx) + 2 * u;
  const sway = tm ? Math.sin(tm / 900) * 2.5 * u : 0;
  const bob = tm ? Math.sin(tm / 500) * 3 * u : 0;
  const tipH = (s.phase === 'entering' ? 34 : 20) * u;
  const tip = { x: sx + sway, y: sy - tipH - bob };
  // sprout stem
  ctx.strokeStyle = '#7bd389';
  ctx.lineWidth = 2.6 * u;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(sx + 2 * u, sy - 4 * u);
  ctx.quadraticCurveTo(sx + 7 * u + sway, sy - tipH * 0.55, tip.x, tip.y);
  ctx.stroke();
  if (s.phase === 'entering') {
    drawLeaf(ctx, tip.x, tip.y, 11 * u, -0.45, -1, [143, 220, 122], u);
    drawLeaf(ctx, tip.x, tip.y, 11 * u, -0.45, 1, [143, 220, 122], u);
  } else {
    // still curled: a little hook at the tip
    ctx.beginPath();
    ctx.arc(tip.x - 3 * u, tip.y, 3 * u, 0, Math.PI * 1.15, true);
    ctx.stroke();
  }
  // the bean seed, half tucked into a small heap of dirt
  ctx.fillStyle = '#c9a36b';
  ctx.strokeStyle = '#8a6a3c';
  ctx.lineWidth = 1.2 * u;
  ctx.beginPath();
  ctx.ellipse(sx, sy, 11 * u, 7 * u, -0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#7a5530';
  ctx.beginPath();
  ctx.ellipse(sx - 1 * u, sy - 1.5 * u, 3 * u, 1.3 * u, -0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#4a3220';
  ctx.beginPath();
  ctx.ellipse(sx, sy + 6 * u, 18 * u, 5 * u, 0, Math.PI, 0, true);
  ctx.fill();
}

/** Stem, leaves, golden bean pods and flower for a bot that holds (or held) a position. */
function drawGrownPlant(ctx, s, L, tm, rand, idx) {
  const u = L.u;
  const sway = tm ? Math.sin(tm / 900 + idx) * 6 * s.size * u : 0;
  const bend = s.health < GROWTH.droopHealth ? (GROWTH.droopHealth - s.health) / GROWTH.droopHealth : 0;
  const lean = rand() < 0.5 ? -1 : 1;
  const P0 = { x: L.cx, y: L.moundY(L.cx) + 3 * u };
  const P1 = { x: L.cx + sway * 0.5, y: P0.y - L.plantH * 0.62 };
  const P2 = { x: L.cx + sway * 1.6 + lean * bend * L.plantH * 0.45, y: P0.y - L.plantH * (1 - 0.3 * bend) };

  const stemC = healthTone(s.health, STEM.lush, STEM.sick, STEM.dead);
  const leafC = healthTone(s.health, LEAF.lush, LEAF.sick, LEAF.dead);
  const stemW = (2.4 + 3.8 * s.size) * u;

  // stem: dark outline then body
  ctx.lineCap = 'round';
  for (const [col, wdt] of [[rgb(mix(stemC, [0, 0, 0], 0.45)), stemW + 1.6 * u], [rgb(stemC), stemW]]) {
    ctx.strokeStyle = col;
    ctx.lineWidth = wdt;
    ctx.beginPath();
    ctx.moveTo(P0.x, P0.y);
    ctx.quadraticCurveTo(P1.x, P1.y, P2.x, P2.y);
    ctx.stroke();
  }

  // leaves, alternating sides, drooping as health falls
  const n = Math.round(2 + 6 * s.size);
  const flip = rand() < 0.5 ? 1 : -1;
  for (let i = 1; i <= n; i++) {
    const k = (i / (n + 1)) * 0.9 + 0.04;
    const p = quad(P0, P1, P2, k);
    const side = (i % 2 ? -1 : 1) * flip;
    const len = (13 + 28 * s.size * (1 - i / (n + 2))) * u;
    const flutter = tm ? Math.sin(tm / 650 + i * 1.7 + idx) * 0.08 : 0;
    const ang = -0.55 + (1 - s.health) * 1.25 + flutter;
    const shade = 0.9 + rand() * 0.2;
    drawLeaf(ctx, p.x, p.y, len, ang, side, [leafC[0] * shade, leafC[1] * shade, leafC[2] * shade], u);
  }

  // golden bean pods: one per +2% (max 6) while healthy
  for (let i = 0; i < s.fruit; i++) {
    const k = 0.3 + 0.5 * (i / Math.max(1, s.fruit - 1));
    const p = quad(P0, P1, P2, k);
    const side = i % 2 ? 1 : -1;
    const rx = (4.2 + 2 * s.size) * u;
    const fx = p.x + side * (7 + 4 * (i % 3)) * u;
    const fy = p.y + 6 * u;
    ctx.strokeStyle = rgb(stemC);
    ctx.lineWidth = 1.2 * u;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(fx, fy - rx * 0.5);
    ctx.stroke();
    const g = ctx.createRadialGradient(fx - rx * 0.35, fy - rx * 0.3, 0, fx, fy, rx * 1.2);
    g.addColorStop(0, '#fff0b0');
    g.addColorStop(0.55, '#f2c14e');
    g.addColorStop(1, '#c98d1c');
    ctx.fillStyle = g;
    ctx.strokeStyle = '#8f6312';
    ctx.lineWidth = 0.8 * u;
    ctx.beginPath();
    ctx.ellipse(fx, fy, rx, rx * 0.64, side * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    disc(ctx, fx - rx * 0.35, fy - rx * 0.22, 1.3 * u);
  }

  // crown: an open flower while health > 0.4, otherwise a withered bud
  if (s.flower) {
    const r = (4 + 6 * s.size) * u;
    const spin = tm ? Math.sin(tm / 1800 + idx) * 0.2 : 0;
    const petal = s.frac >= 0 ? '#ffd166' : '#d8a878';
    ctx.fillStyle = petal;
    for (let k = 0; k < 6; k++) {
      const a = spin + (k * Math.PI) / 3;
      ctx.beginPath();
      ctx.ellipse(P2.x + Math.cos(a) * r * 0.85, P2.y + Math.sin(a) * r * 0.85, r * 0.72, r * 0.4, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#a8432f';
    disc(ctx, P2.x, P2.y, r * 0.45);
    ctx.fillStyle = 'rgba(255,220,150,0.7)';
    disc(ctx, P2.x - r * 0.12, P2.y - r * 0.12, r * 0.14);
  } else {
    ctx.fillStyle = s.health < GROWTH.dyingHealth ? '#6e5236' : '#9a7a4a';
    ctx.beginPath();
    ctx.ellipse(P2.x, P2.y + 2 * u, 3.2 * u, 5 * u, lean * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Fireflies drift around a thriving, profitable plant. */
function drawFireflies(ctx, w, s, L, tm, idx) {
  const n = Math.min(3, 1 + Math.floor(s.frac / 0.04));
  for (let k = 0; k < n; k++) {
    const x = L.cx + Math.sin(tm / 1700 + k * 2.1 + idx) * w * 0.32;
    const y = L.soilTop - L.plantH * 0.55 + Math.cos(tm / 1250 + k * 1.3 + idx) * L.plantH * 0.35;
    const r = 5 * L.u;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(226,255,150,0.95)');
    g.addColorStop(1, 'rgba(226,255,150,0)');
    ctx.fillStyle = g;
    disc(ctx, x, y, r);
  }
}

/** Paused: dim the plot and plant a striped parasol beside it. */
function drawShade(ctx, w, h, L) {
  const u = L.u;
  ctx.fillStyle = 'rgba(8,12,26,0.38)';
  ctx.fillRect(0, 0, w, h);
  const R = clamp(w * 0.2, 16 * u, 40 * u);
  const baseX = w * 0.17;
  const baseY = L.moundY(baseX) + 2 * u;
  const poleH = Math.max(R * 1.6, Math.min(L.plantH + 8 * u, baseY - L.top));
  ctx.save();
  ctx.translate(baseX, baseY);
  ctx.rotate(0.22);
  ctx.strokeStyle = '#d9c9a8';
  ctx.lineWidth = 2 * u;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -poleH);
  ctx.stroke();
  for (let k = 0; k < 6; k++) {
    const a0 = Math.PI + (k * Math.PI) / 6;
    ctx.fillStyle = k % 2 ? '#f3e6c8' : '#e5534b';
    ctx.beginPath();
    ctx.moveTo(0, -poleH);
    ctx.arc(0, -poleH, R, a0, a0 + Math.PI / 6);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Error: a little warning sign staked into the soil. */
function drawWarning(ctx, w, L) {
  const u = L.u;
  const x = w * 0.84;
  const y = L.moundY(x) + 2 * u;
  ctx.strokeStyle = '#8a6a3c';
  ctx.lineWidth = 2 * u;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - 22 * u);
  ctx.stroke();
  const s = 9 * u;
  const ty = y - 24 * u;
  ctx.fillStyle = '#f2c14e';
  ctx.beginPath();
  ctx.moveTo(x, ty - s);
  ctx.lineTo(x + s, ty + s * 0.6);
  ctx.lineTo(x - s, ty + s * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#2b2117';
  ctx.fillRect(x - 0.8 * u, ty - s * 0.45, 1.6 * u, s * 0.6);
  disc(ctx, x, ty + s * 0.32, 0.95 * u);
}

/** Closed bots: a cut stump. */
function drawStump(ctx, L) {
  const u = L.u;
  const y = L.moundY(L.cx);
  ctx.fillStyle = '#7a5a3a';
  ctx.fillRect(L.cx - 5 * u, y - 10 * u, 10 * u, 12 * u);
  ctx.fillStyle = '#c9a36b';
  ctx.beginPath();
  ctx.ellipse(L.cx, y - 10 * u, 5 * u, 2 * u, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** Caption pills at the top of the plot (shade first, then the health/seed caption). */
function drawCaptions(ctx, w, s, L, labels, font) {
  const keys = [];
  if (s.shaded) keys.push('shade');
  if (s.caption) keys.push(s.caption);
  let y = L.capTop;
  for (const key of keys) {
    const text = String(labels?.[key] ?? DEFAULT_LABELS[key] ?? '');
    if (!text) continue;
    let fs = clamp(11.5 * L.u, 10, 15);
    ctx.font = `600 ${fs.toFixed(1)}px ${font}`;
    let tw = ctx.measureText(text).width || 0;
    const room = w - 14;
    if (tw > room && tw > 0) {
      fs = Math.max(7, (fs * room) / tw);
      ctx.font = `600 ${fs.toFixed(1)}px ${font}`;
      tw = ctx.measureText(text).width || room;
    }
    const ph = fs + 7;
    ctx.fillStyle = 'rgba(6,10,20,0.6)';
    roundRectPath(ctx, L.cx - tw / 2 - 7, y, tw + 14, ph, ph / 2);
    ctx.fill();
    ctx.fillStyle = CAPTION_COLOR[key] || '#eee';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, L.cx, y + ph / 2 + 0.5);
    y += ph + 3;
  }
}

/** Shared geometry for one plot. */
function layout(w, h, s) {
  const u = clamp(Math.min(w, h) / 200, 0.5, 2.5);
  const soilTop = h - Math.max(18 * u, h * 0.18);
  const cx = w / 2;
  const capTop = 6 * u;
  const lines = (s.shaded ? 1 : 0) + (s.caption ? 1 : 0);
  const top = capTop + Math.max(1, lines) * 21 * u + 6 * u;
  const plantH = Math.max(16 * u, Math.min(soilTop - top, h * (0.16 + 0.56 * s.size)));
  // the soil rim is a symmetric quadratic, so for x in [0, w] the curve parameter is x / w
  const rimY0 = soilTop + 6 * u;
  const rimYc = soilTop - 7 * u;
  const moundY = (x) => {
    const k = clamp(x / w, 0, 1);
    return (1 - k) * (1 - k) * rimY0 + 2 * (1 - k) * k * rimYc + k * k * rimY0;
  };
  return { u, soilTop, cx, capTop, top, plantH, rimY0, rimYc, moundY };
}

/**
 * Paint one plot. `w`/`h` are CSS pixels (scale the context for devicePixelRatio
 * first); `t` is a timestamp in ms (requestAnimationFrame time).
 * opts: { labels: {waiting, entering, shade, wilting, dying, ripe},
 *         reducedMotion: boolean  — freeze sway, twinkle and fireflies,
 *         glow: 0..1              — fill highlight strength,
 *         font: CSS font family }
 * Returns the stage() it drew, handy for labels and tests.
 */
export function drawPlant(ctx, w, h, bot, t = 0, opts = {}) {
  const s = stage(bot);
  if (!ctx || !(w > 0) || !(h > 0)) return s;
  const o = opts || {};
  const font = o.font || 'system-ui, "Segoe UI", "Leelawadee UI", "Noto Sans Thai", sans-serif';
  const tm = o.reducedMotion ? 0 : Number(t) || 0;
  const glow = clamp(Number(o.glow) || 0, 0, 1);
  const idx = Number.isFinite(Number(bot?.index)) ? Number(bot.index) : 0;
  const rand = prng(seedOf(bot));
  const L = layout(w, h, s);

  ctx.save();
  ctx.clearRect(0, 0, w, h);
  drawSky(ctx, w, h, s, L, tm, rand);
  if (glow > 0) drawGlow(ctx, w, h, L, glow);

  if (s.phase === 'closed') {
    drawSoil(ctx, w, h, s, L, tm, rand);
    drawStump(ctx, L);
  } else if (s.seed) {
    drawSoil(ctx, w, h, s, L, tm, rand);
    drawSeedling(ctx, s, L, tm);
  } else {
    if (s.frac > GROWTH.fruitMinFrac && s.health > 0.8 && !s.shaded) drawFireflies(ctx, w, s, L, tm, idx);
    const plantRand = prng(seedOf(bot) ^ 0x5bd1e995);
    drawGrownPlant(ctx, s, L, tm, plantRand, idx);
    drawSoil(ctx, w, h, s, L, tm, rand);
  }
  if (s.shaded) drawShade(ctx, w, h, L);
  if (s.phase === 'error') drawWarning(ctx, w, L);
  drawCaptions(ctx, w, s, L, o.labels, font);
  ctx.restore();
  return s;
}

/**
 * Equity sparkline for a seed packet: dashed baseline at `base` (1000 = the
 * bean's starting capital), filled area, line and end dot; green above base,
 * red below. `values` may be numbers or {h, equity} points. Returns false
 * (after writing `empty`) when there are fewer than two points.
 */
export function drawSparkline(ctx, w, h, values, opts = {}) {
  const { base = 1000, up = '#2f8f4b', down = '#b23a30', empty = 'no history yet', font = 'system-ui, sans-serif' } = opts;
  if (!ctx || !(w > 0) || !(h > 0)) return false;
  ctx.clearRect(0, 0, w, h);
  const v = (values || [])
    .map((x) => (typeof x === 'number' ? x : x && typeof x.equity === 'number' ? x.equity : NaN))
    .filter(Number.isFinite);
  if (v.length < 2) {
    ctx.fillStyle = '#8a7a5c';
    ctx.font = `11px ${font}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(empty, 3, h / 2);
    return false;
  }
  let lo = base;
  let hi = base;
  for (const x of v) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  if (hi - lo < 1e-9) hi = lo + 1;
  const pad = 3;
  const X = (i) => pad + (i / (v.length - 1)) * (w - 2 * pad);
  const Y = (val) => h - pad - ((val - lo) / (hi - lo)) * (h - 2 * pad);
  const col = v[v.length - 1] >= base ? up : down;

  ctx.save();
  ctx.strokeStyle = 'rgba(107,90,66,0.5)';
  ctx.lineWidth = 1;
  if (ctx.setLineDash) ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, Y(base));
  ctx.lineTo(w, Y(base));
  ctx.stroke();
  if (ctx.setLineDash) ctx.setLineDash([]);

  ctx.beginPath();
  v.forEach((val, i) => (i ? ctx.lineTo(X(i), Y(val)) : ctx.moveTo(X(i), Y(val))));
  ctx.lineTo(X(v.length - 1), Y(base));
  ctx.lineTo(X(0), Y(base));
  ctx.closePath();
  ctx.fillStyle = col + '2e';
  ctx.fill();

  ctx.strokeStyle = col;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  v.forEach((val, i) => (i ? ctx.lineTo(X(i), Y(val)) : ctx.moveTo(X(i), Y(val))));
  ctx.stroke();
  ctx.fillStyle = col;
  disc(ctx, X(v.length - 1), Y(v[v.length - 1]), 2.2);
  ctx.restore();
  return true;
}

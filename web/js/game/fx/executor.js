/**
 * fx/executor.js — runs the director's Effect[] against the field, the world, particles, arcs, floaters and
 * sound (GAME-DESIGN §4.1–4.4, §9.5, §9.7).
 *
 *   createFx({ scene, field, world, labels, sfx, bus, settings, camera?, container?, quality?, store? })
 *     → { run(effects), update(dt, t), clear(), rebuild(), setQuality(q), setReduced(b), setSettings(s), busy(),
 *         dispose(), particles, arcs, floaters }
 *   `store` (optional) keeps field.setHalted() in step with live.halted (burned field after a reload).
 *
 * The executor implements every kind of rules.EFFECT_KINDS one to one with §4. It never decides an outcome:
 * it only renders what the director (fed by server replies and SSE echoes) already decided (J3). Coins and
 * sparkles exist only on `harvest`/`burnPlot` with a realized gain, with exactly `effect.n` coins
 * (rules.coinBurst, J4); a `pull` gets brown clumps, a red label and a neutral sound. Money labels are the
 * server number formatted once with sign + glyph + colour class (J1/J2/J6).
 *
 * Reduced motion (§7.3: effect.meta.reduced or the settings controller): no particles, no flights; states
 * snap or fade ≤ 150 ms; information-carrying effects become static (labels still show; the world's crate /
 * compost counts come from the data, not from flights).
 *
 * Timing (§4.3) is shared with field/plot.js EXIT so coins, fruit hops and bundles line up with the plot's
 * own bow / uproot animation. Effects with meta.delayMs (burn plots, 250 ms apart in slot order) are queued.
 * The farmer (world.farmer, P1) is sent along but never waited for (§4.5).
 */

import { ConeGeometry, Mesh, MeshBasicMaterial, AdditiveBlending, NormalBlending, TorusGeometry, Vector3 } from '../three.js';
import { createParticles } from './particles.js';
import { createArcs } from './coins.js';
import { createFloaters, effectText, fillText } from './floaters.js';
import { EXIT } from '../field/plot.js';
import { cropFor } from '../crops/catalog.js';
import { EASE } from '../field/anim.js';

/** Landmark fallbacks (§2.2) when the World has not landed yet: [x, y (aim height), z]. */
const LANDMARK_POS = Object.freeze({
  stall: [-16, 1.3, 0],
  crates: [-4.5, 0.9, -10.5],
  compost: [5.5, 0.7, -10.5],
  tower: [13, 6.8, -8],
  pond: [15, 0.35, 3],
  pump: [13, 0.8, 0.5],
  firepit: [8, 0.8, 12.5],
  windmill: [-12, 0, -11],
  sundial: [-8, 0.5, -13.5],
});
/** Height above a landmark's origin to aim at (only used with a real World). */
const AIM_Y = Object.freeze({ stall: 1.3, crates: 0.9, compost: 0.7, tower: 6.8, pond: 0.35, pump: 0.8, firepit: 0.8, windmill: 0, sundial: 0.5 });

const V = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
const num = (x) => (x !== null && x !== undefined && Number.isFinite(Number(x)) ? Number(x) : null);

/** Pentatonic pitch index for fruit k (sfx `pop`, §8). */
export const popPitch = (k) => Math.max(0, Math.min(5, Number(k) | 0));

/**
 * The pure "what plays" plan of an effect (no three, no DOM) — used by the executor and by the Node tests to
 * prove the Juice Contract at the rendering end: coins only for gains, never for losses or zero.
 * → { coins, popcorn, sparkle, clumps, sound: [names], floater: boolean }
 */
export function planOf(effect, { reduced = false } = {}) {
  const k = effect?.kind;
  const usd = num(effect?.usd);
  const plan = { coins: 0, popcorn: 0, sparkle: 0, clumps: 0, sound: [], floater: false };
  if (!effect) return plan;
  const rm = reduced || !!effect.meta?.reduced;
  const gain = usd !== null && Math.round(usd * 100) > 0; // a gain that shows as $0.00 is no gain (J4)
  switch (k) {
    case 'harvest':
      plan.coins = gain && !rm ? Math.max(0, Math.min(48, effect.n | 0)) : 0;
      plan.popcorn = gain && !rm && (effect.meta?.popcorn || effect.coin === 'DOGE') ? 24 : 0;
      plan.sound = gain && (effect.n | 0) > 0 ? ['coinBlips'] : [];
      plan.floater = true;
      break;
    case 'burnPlot':
      if (effect.meta?.recipe === 'pull' || (usd !== null && usd < 0)) {
        plan.clumps = rm ? 0 : 6;
        plan.sound = ['thud'];
      } else {
        plan.coins = gain && !rm ? Math.max(0, Math.min(48, effect.n | 0)) : 0;
        plan.sound = gain && (effect.n | 0) > 0 ? ['coinBlips'] : [];
      }
      plan.floater = true;
      break;
    case 'pull':
      plan.clumps = rm ? 0 : 6;
      plan.sound = ['rustle', 'thud'];
      plan.floater = true;
      break;
    case 'ripeOn':
      plan.sparkle = rm ? 0 : 3;
      plan.sound = ['glint'];
      break;
    case 'resume':
      // re-opening a position is activity, not a gain (J4/J8): no sparkles, no rising chime — the parasol
      // just folds away with a neutral whoosh (and the sunbeam light)
      plan.sparkle = 0;
      plan.sound = ['whoosh'];
      break;
    default:
      break;
  }
  return plan;
}

export function createFx({ scene, field = null, world = null, labels = null, sfx = null, bus = null, settings = null, camera = null, container = null, quality = null, store = null, requestRender = null } = {}) {
  let snap = settings;
  let reducedOverride = null;
  const readReduced = () => {
    if (reducedOverride !== null) return reducedOverride;
    try {
      if (typeof snap?.reduced === 'function') return !!snap.reduced();
      const s = typeof snap?.get === 'function' ? snap.get() : snap;
      return !!s?.reduced;
    } catch {
      return false;
    }
  };
  const poolFor = (q) => (q && typeof q === 'object' && Number(q.particles) > 0 ? Number(q.particles) : typeof q === 'string' ? { high: 1500, medium: 800, low: 300 }[q] || 1500 : 1500);

  const particles = createParticles(scene, { pool: poolFor(quality), reduced: readReduced });
  const arcs = createArcs(scene, { max: 48 });
  const floaters = createFloaters({ container, labels, camera, reduced: readReduced, Vector3 });
  const queue = [];
  const lastFill = new Map(); // slot → floater handle (fillMerged updates it)
  let clockMs = 0;

  // ---- transient meshes: splash rings (fills) and sunbeams (resume)
  const ringGeo = new TorusGeometry(0.9, 0.06, 4, 28);
  ringGeo.rotateX(Math.PI / 2);
  const beamGeo = new ConeGeometry(1.5, 6, 16, 1, true);
  beamGeo.translate(0, -3, 0);
  const transients = [];
  function transient(geo, color, { at, ms, update, additive = false, opacity = 0.8 }) {
    const mat = new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: additive ? AdditiveBlending : NormalBlending });
    const m = new Mesh(geo, mat);
    m.position.copy(at);
    m.renderOrder = 7;
    m.frustumCulled = false;
    scene.add(m);
    transients.push({ m, t: 0, ms, update, opacity });
  }

  // ---- sound + farmer (both optional, never awaited)
  function play(name, opts) {
    try {
      sfx?.play?.(name, opts);
    } catch {
      /* audio is decoration */
    }
  }
  function farmer(slot, pose) {
    try {
      world?.farmer?.goto?.(slot, pose);
    } catch {
      /* the farmer never blocks an effect */
    }
  }

  /** World point of a landmark (aim height included). */
  function lm(id) {
    const L = world?.landmarks?.get?.(id);
    if (L?.object3D?.getWorldPosition) {
      const p = L.object3D.getWorldPosition(V());
      p.y += AIM_Y[id] ?? 0.5;
      return p;
    }
    const f = LANDMARK_POS[id] || [0, 1, 0];
    return V(f[0], f[1], f[2]);
  }
  function lmState(id, state) {
    try {
      world?.landmarks?.get?.(id)?.setState?.(state);
    } catch {
      /* optional */
    }
  }

  // ---- floaters: WP2's fx labels project plain world points ({x, y, z}) themselves
  function floatAt(point, text, tone, opts = {}) {
    if (!text || !point) return null;
    return floaters.show({ at: point.clone ? point.clone() : point, text, tone, ...opts });
  }

  // ---- particles sink for ambient plot life (ripe glint, falling leaves, drips, trowel dust)
  const sink = {
    particles: (kind, pos, n, opts) => particles.emit(kind, pos, n, opts),
    sfx: (name, opts) => play(name, opts),
    // one frame for a timed, otherwise static change (the on-demand loop sleeps under reduced motion)
    wake: () => requestRender?.(),
  };
  field?.setFx?.(sink);

  // The burned field persists until a restart (§3.5 "field burned"): keep the boxes charcoal from the store's
  // live.halted, also after a reload when no open bot (and so no PlotView) carries the flag.
  let offHalted = null;
  // while a burn sequence plays (burnStart … burnEnd) the plots char one by one with their ember wave; the
  // store's halted flag (it arrives with the next tend) must not char the whole field at once in the middle
  let burning = false;
  if (store && typeof store.select === 'function') {
    try {
      const sel = (st) => !!st?.live?.halted;
      offHalted = store.select(sel, (h) => {
        if (!burning) field?.setHalted?.(h);
      });
      if (sel(store.get?.())) field?.setHalted?.(true);
    } catch {
      offHalted = null;
    }
  }

  const plotOf = (slot) => (slot === null || slot === undefined ? null : field?.plot?.(slot) || null);

  // ------------------------------------------------------------------ the effects (§4.1–4.4)

  function exec(e) {
    const kind = e?.kind;
    const plot = plotOf(e.slot);
    const rm = readReduced() || !!e.meta?.reduced;
    const P = plot?.points;
    const playPlot = () => {
      try {
        return plot?.play(e) ?? Promise.resolve(false);
      } catch (err) {
        globalThis.console?.error?.('plot effect failed', kind, err);
        return Promise.resolve(false);
      }
    };

    switch (kind) {
      // ---------------------------------------------------------------- commands
      case 'pending': {
        playPlot();
        if (e.meta?.op === 'bot_create' && e.meta?.on && plot) farmer(e.slot, 'dig');
        if (e.meta?.on === false && e.meta?.ok === false && plot && e.meta?.op !== 'bot_create') {
          // any other command refused (409/400/401): a dust puff on the target (§4.3 last row)
          particles.emit('dust', P.center(), 8);
        }
        return;
      }
      case 'plantOk': {
        playPlot();
        if (!plot) return;
        if (!rm) {
          const to = P.center();
          arcs.launch('seed', { from: lm('stall'), to, ms: 600, height: 4, onLand: () => {
            particles.emit('soil', to, 10);
            play('thup');
            play('pop', { pitch: 0 });
          } });
        } else play('pop', { pitch: 0 });
        return;
      }
      case 'plantFail': {
        playPlot();
        if (!plot) return;
        if (!rm) {
          const from = P.center();
          arcs.launch('seed', { from, to: lm('stall'), ms: 500, height: 2.5, bounce: true });
          particles.emit('dust', from, 8);
        }
        return;
      }
      case 'water': {
        playPlot();
        if (!plot) return;
        farmer(e.slot, 'can');
        lmState('pond', { pump: true });
        const t = effectText(e);
        if (t) floatAt(P.label(), t.text, t.tone);
        play('burble');
        if (!rm) {
          // the water runs from the tower to the box (the pipe itself is the World's)
          const to = P.center();
          arcs.launch('ball', { from: lm('tower'), to, n: 6, stagger: 110, ms: 900, height: 1.6, color: '#8FD3E8', scale: 0.55, spin: false }).then(() => {
            particles.emit('droplets', to, 14);
          });
        }
        return;
      }
      case 'fill':
      case 'flip':
      case 'fillMerged': {
        playPlot();
        if (!plot) return;
        const open = !!e.meta?.open;
        if (kind === 'fillMerged') {
          // coalesced (≤ 400 ms): one splash, the floater shows the last fill + "×N fills", one plip
          const f = lastFill.get(e.slot);
          const ft = fillText(e);
          if (f?.alive) f.setText(ft.text, ft.tone);
          else lastFill.set(e.slot, floatAt(P.label(), ft.text, ft.tone));
          return;
        }
        if (kind === 'flip') {
          // Close X then Open Y: a second floater stacked 120 ms later; the sign turns 180°; bird ↔ mole
          const openE = { ...e, usd: undefined, n: 1, meta: { ...e.meta, dir: e.meta?.to ?? e.meta?.dir, open: true } };
          const ft = fillText(openE);
          lastFill.set(e.slot, floatAt(P.label(), ft.text, 'neutral', { delay: 120, stack: 1 }));
          play('plip', { variant: 'open' });
          return;
        }
        const ft = fillText(e);
        lastFill.set(e.slot, floatAt(P.label(), ft.text, ft.tone));
        play('plip', { variant: open ? 'open' : 'close' });
        if (!rm) {
          const c = P.center();
          particles.emit('splash', c, 8);
          transient(ringGeo, 0xdff4ff, { at: c, ms: 600, opacity: 0.85, update: (m, k) => {
            m.scale.setScalar(Math.max(0.001, 1.4 * EASE.oC(k)));
            m.material.opacity = 0.85 * (1 - k);
          } });
        }
        return;
      }
      case 'capTag': {
        lmState('tower', { capTag: true, at: clockMs });
        const t = effectText(e);
        floatAt(lm('tower').add(V(0, 1.2, 0)), t.text, t.tone);
        play('knock');
        return;
      }

      // ---------------------------------------------------------------- plant state crossings (§4.2)
      case 'fruitGain':
        playPlot();
        play('pop', { pitch: popPitch(e.n) });
        return;
      case 'fruitGainQuiet':
        playPlot();
        return;
      case 'fruitLoss':
        playPlot();
        play('thud', { gain: 0.5 });
        return;
      case 'ripeOn': {
        playPlot();
        if (plot && !rm) particles.emit('sparkle', P.fruit(0), 3);
        play('glint');
        return;
      }
      case 'wiltOn':
      case 'dyingOn': {
        playPlot();
        if (plot && !rm) {
          particles.emit('leaves', P.top(), 3, { color: ['#B98A4A', '#C4B048'] });
          if (kind === 'dyingOn') particles.emit('smoke', P.top(), 6);
        }
        play('sigh');
        return;
      }
      case 'liqDangerOn':
        playPlot();
        play('tickTick');
        return;
      case 'frozenOn':
      case 'frozenOff':
        playPlot();
        return;

      // ---------------------------------------------------------------- closing, pausing, failure (§4.3)
      case 'harvest':
        harvest(e, plot, rm, false);
        return;
      case 'pull':
        pull(e, plot, rm, false);
        return;
      case 'shade': {
        playPlot();
        if (plot) farmer(e.slot, 'parasol');
        play('fwump');
        const t = effectText(e);
        if (t && plot) floatAt(P.label(), t.text, t.tone);
        return;
      }
      case 'resume': {
        playPlot();
        play('whoosh'); // neutral: resuming is not a reward (J4/J8)
        if (plot && !rm) {
          const top = P.sky();
          transient(beamGeo, 0xfff3b0, { at: top, ms: 800, additive: true, opacity: 0, update: (m, k) => {
            m.material.opacity = 0.35 * Math.sin(Math.PI * k);
          } });
        }
        return;
      }
      case 'liquidate': {
        playPlot();
        if (!plot) return;
        const t = effectText(e);
        if (t) floatAt(P.label(), t.text, t.tone, { ms: 2600 });
        play('hail');
        play('thud', { gain: 0.6 });
        if (!rm) {
          const sky = P.sky();
          particles.emit('cloud', sky, 9, { area: 0.9 });
          particles.emit('hail', sky.clone().add(V(0, -0.4, 0)), 40, { delayMs: 500, stagger: 30, area: 1.4 });
        }
        return;
      }
      case 'bustPlanted':
        playPlot();
        play('mutedBell');
        return;
      case 'bustShelf':
        lmState('stall', { bust: e.coin ?? null, at: clockMs });
        play('paperFlop');
        return;
      case 'error': {
        playPlot();
        if (plot && !rm) particles.emit('drips', P.valve(), 6);
        play('knock', { count: 2 });
        return;
      }

      // ---------------------------------------------------------------- burn the field (§4.3)
      case 'burnStart': {
        // the field stays unburned (explicitly, over the views' halted flag) until each plot's turn comes
        burning = true;
        field?.setHalted?.(false);
        lmState('firepit', { lit: true });
        play('whoosh');
        play('crackle');
        if (!rm) particles.emit('embers', lm('firepit'), 30, { area: 0.5 });
        return;
      }
      case 'burnPlot': {
        // the ember wave sweeps in slot order: only THIS box chars now (its delayMs already elapsed)
        if (plot) plot.setHalted?.(true);
        else if (!burning) field?.setHalted?.(true);
        const recipe = e.meta?.recipe === 'pull' || (num(e.usd) ?? 0) < 0 ? 'pull' : 'harvest';
        if (plot && !rm) particles.emit('embers', P.center(), 30, { area: 1.3 });
        if (recipe === 'pull') pull(e, plot, rm, true);
        else harvest(e, plot, rm, true);
        return;
      }
      case 'burnEnd': {
        burning = false;
        field?.setHalted?.(true);
        try {
          world?.setHalted?.(true);
        } catch {
          /* optional */
        }
        if (!rm) {
          for (const p of field?.plots?.() || []) particles.emit('ash', p.points.sky(), 4, { area: 2 });
          particles.emit('ash', V(0, 6, 0), 60, { area: 12 });
        }
        lmState('firepit', { lit: false });
        return;
      }

      // ---------------------------------------------------------------- time and market (§4.4)
      case 'tick': {
        try {
          world?.kickWindmill?.();
        } catch {
          /* optional */
        }
        play('tock');
        play('chime');
        lmState('board', { flip: true }); // the market board flips on every bar (§1.5 tick_completed)
        if (!rm) {
          // soil shimmer ripples out from the windmill across the active boxes (800)
          const w = lm('windmill');
          for (const p of field?.plots?.() || []) {
            const d = p.object3D.position.distanceTo(w);
            p.shimmer?.(d * 18);
          }
        }
        return;
      }
      case 'gust':
        try {
          world?.gust?.();
        } catch {
          /* optional */
        }
        play('whoosh');
        return;
      case 'weather':
        if (e.meta?.key) {
          try {
            world?.setWeather?.({ key: e.meta.key, mean: e.meta.mean ?? null });
          } catch {
            /* optional */
          }
        }
        return;
      case 'timelapse':
        lmState('sundial', { sweep: true, at: clockMs });
        play('whirr');
        return;
      case 'feedLook':
        try {
          world?.setFeedLook?.(e.meta?.state ?? null);
        } catch {
          /* optional */
        }
        return;

      // ---------------------------------------------------------------- generic
      case 'label': {
        const t = effectText(e);
        const at = e.meta?.at ? V(e.meta.at.x, e.meta.at.y, e.meta.at.z) : plot ? P.label() : null;
        if (t && at) floatAt(at, t.text, t.tone);
        return;
      }
      case 'sfx':
        play(e.meta?.name, { count: e.meta?.count, pitch: e.meta?.pitch, gain: e.meta?.gain });
        return;
      default:
        return;
    }
  }

  /** Harvest (§4.3): fruit hop into the basket, the plant bows and sinks, coins fly to the crates. */
  function harvest(e, plot, rm, compact) {
    const plan = planOf(e, { reduced: rm });
    const P = plot?.points;
    const crop = plot?.crop;
    const ripeHex = cropFor(e.coin ?? plot?.view?.coin).ripe;
    const fruitPos = [];
    const nFruit = plot?.fruitCount || 0;
    if (crop) for (let i = 0; i < nFruit; i++) fruitPos.push(crop.fruitWorld(i));
    if (plot) {
      plot.play(e);
      if (!compact) farmer(e.slot, 'sickle');
    }
    const at = P ? P.label() : lm('crates');
    const t = effectText(e);
    if (t) floatAt(at, t.text, t.tone, { delay: compact ? 0 : 200, ms: 2000 });
    if (plan.sound.includes('coinBlips')) play('coinBlips', { count: Math.min(8, e.n | 0) });
    if (rm || !plot) return;
    const E = EXIT.harvest;
    if (!compact) {
      const basket = P.basket();
      fruitPos.forEach((p, i) => arcs.launch('ball', { from: p, to: basket, ms: E.fruitFlight, delay: E.fruitAt + i * E.fruitStagger, height: 0.9, color: ripeHex, scale: 0.9, spin: false }));
    }
    if (plan.coins > 0) {
      const crates = lm('crates');
      arcs.launch('coin', { from: P.center().add(V(0, 0.6, 0)), to: crates, n: plan.coins, stagger: 60, ms: 900, height: 4.5, delay: compact ? 0 : E.coinsAt, onLand: () => lmState('crates', { bump: true, at: clockMs }) });
      particles.emit('sparkle', P.center().add(V(0, 0.8, 0)), Math.min(6, plan.coins), { delayMs: compact ? 0 : E.coinsAt });
    }
    if (plan.popcorn) particles.emit('popcorn', P.top(), plan.popcorn, { delayMs: compact ? 0 : 300 });
    if (!compact) waterBack();
  }

  /** Pull (§4.3): uproot, a brown bundle to the compost, clumps, a red label. No coins, no sparkle (J4). */
  function pull(e, plot, rm, compact) {
    const plan = planOf(e, { reduced: rm });
    const P = plot?.points;
    const topAtStart = P ? P.top() : null;
    if (plot) {
      plot.play(e);
      if (!compact) farmer(e.slot, 'hoe');
    }
    const at = P ? P.label() : lm('compost');
    const t = effectText(e);
    if (t) floatAt(at, t.text, t.tone, { ms: 2000 });
    for (const s of plan.sound) play(s);
    if (rm || !plot) return;
    particles.emit('clumps', P.center(), plan.clumps);
    const E = EXIT.pull;
    arcs.launch('bundle', { from: topAtStart.clone().add(V(0, 0.4, 0)), to: lm('compost'), ms: E.bundleFlight, height: 3.5, delay: compact ? 120 : E.bundleAt, onLand: () => lmState('compost', { bump: true, at: clockMs }) });
    if (!compact) waterBack();
  }

  /** Closing returns the plot's water from the tower to the pond (§4.3). */
  function waterBack() {
    arcs.launch('ball', { from: lm('tower'), to: lm('pond'), n: 5, stagger: 120, ms: 1000, height: 2.2, color: '#8FD3E8', scale: 0.5, spin: false, delay: 400 });
  }

  // ------------------------------------------------------------------ public

  return {
    particles,
    arcs,
    floaters,
    /** Run effects now (or after meta.delayMs). Unknown kinds are ignored. */
    run(effects) {
      for (const e of Array.isArray(effects) ? effects : effects ? [effects] : []) {
        if (!e || !e.kind) continue;
        const d = Number(e.meta?.delayMs) || 0;
        if (d > 0 && !(readReduced() && d > 400)) queue.push({ at: clockMs + d, e });
        else if (d > 0) queue.push({ at: clockMs + Math.min(d, 150), e });
        else {
          try {
            exec(e);
          } catch (err) {
            globalThis.console?.error?.('effect failed', e.kind, err);
          }
        }
      }
    },
    update(dt, t) {
      const ms = Math.min(100, Math.max(0, (Number(dt) || 0) * 1000));
      clockMs += ms;
      if (queue.length) {
        queue.sort((a, b) => a.at - b.at);
        while (queue.length && queue[0].at <= clockMs) {
          const { e } = queue.shift();
          try {
            exec(e);
          } catch (err) {
            globalThis.console?.error?.('effect failed', e.kind, err);
          }
        }
      }
      for (let i = transients.length - 1; i >= 0; i--) {
        const tr = transients[i];
        tr.t += ms;
        const k = Math.min(1, tr.t / tr.ms);
        tr.update?.(tr.m, k);
        if (k >= 1) {
          tr.m.removeFromParent();
          tr.m.material.dispose();
          transients.splice(i, 1);
        }
      }
      particles.update(dt);
      arcs.update(dt);
      floaters.update();
    },
    /** True while anything is still animating (on-demand loop). */
    busy() {
      return queue.length > 0 || transients.length > 0 || particles.busy() || arcs.busy() || floaters.count > 0;
    },
    /** stage.js: effective reduced motion (no particles, no flights, ≤ 150 ms fades). */
    setReduced(b) {
      reducedOverride = b === null || b === undefined ? null : !!b;
      if (reducedOverride) {
        particles.clear();
        arcs.clear();
      }
    },
    /** stage.js: new settings snapshot. */
    setSettings(s) {
      if (s) snap = s;
    },
    /** Quality step: particle pool size (High 1500 / Medium 800 / Low 300, governor halves it). */
    setQuality(q) {
      particles.setPool(poolFor(q));
    },
    clear() {
      queue.length = 0;
      for (const tr of transients) {
        tr.m.removeFromParent();
        tr.m.material.dispose();
      }
      transients.length = 0;
      particles.clear();
      arcs.clear();
      floaters.clear();
      lastFill.clear();
    },
    rebuild() {
      particles.rebuild();
      arcs.rebuild();
    },
    dispose() {
      offHalted?.();
      this.clear();
      particles.dispose();
      arcs.dispose();
      ringGeo.dispose();
      beamGeo.dispose();
    },
  };
}

/**
 * field/plot.js — one planter box and everything on it (GAME-DESIGN §3.2–§3.5, §4.1–§4.3, §9.7).
 *
 *   createPlot({ slot, base, batches, tags, tier, settings, sink }) → Plot
 *   Plot = { slot, object3D, anchor, proxy, view, fsm, look,
 *            setView(view, opts), play(effect) → Promise, update(dt, t),
 *            setBase(vec3), setPick(on), setOutline(kind), setDim(on), setHalted(on), setQuality(q),
 *            points: {…world positions for effects…}, busy(), dispose() }
 *
 * The plot draws ONLY from its PlotView through field/growth.js plotLook() (§3.5 table) — it never reads money
 * to decide a look on its own, and it never re-implements stage(). Marks (~5 s) only retarget springs (J11):
 * setView() changes targets; particles/sounds come from effects (play) or from slow ambient state loops
 * that §3.5 lists (ripe glint, wilting leaf, error sputter), never from a price tick.
 *
 * Props are instances in the shared batches (field/batch.js); the crop is a CropMesh (crops/builders.js).
 * `sink` = { particles(kind, pos, n, opts), sfx(name, opts) } is set by the executor (fx) — optional.
 */

import { Group, Mesh, BoxGeometry, MeshBasicMaterial, Object3D, Vector3, Quaternion, Color } from '../three.js';
import { buildCrop } from '../crops/builders.js';
import { cropFor } from '../crops/catalog.js';
import { plotLook, SOIL, BAND_COLORS, SIDE_COLORS, PLOT } from './growth.js';
import { createPlotFsm, PLANTED } from './plotFsm.js';
import { createTween, createTimeline, EASE, popScale, pulse, hash01, nextGap, motionDur } from './anim.js';
import { BOX, LAYOUT, Q, layoutFor } from './props.js';
import { levTier } from '../core/rules.js';
import { moneyText } from '../fx/floaters.js';
import { t as tr } from '../../i18n.js';

const TAU = Math.PI * 2;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const lerp = (a, b, k) => a + (b - a) * k;
const V = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
const _q = new Quaternion();
const _q2 = new Quaternion();
const _v = new Vector3();
const _c = new Color();
const AXIS_Y = V(0, 1, 0);
const AXIS_Z = V(0, 0, 1);
const AXIS_X = V(1, 0, 0);
const _amb = new Vector3();

/** Exit timelines (§4.3). The executor launches coins/fruit/bundles with the same timing. */
export const EXIT = Object.freeze({
  harvest: { fruitAt: 120, fruitStagger: 80, fruitFlight: 360, bowAt: 520, bowMs: 700, coinsAt: 380, total: 2000 },
  pull: { uprootMs: 500, bundleAt: 480, bundleFlight: 800, total: 1600 },
  burn: { total: 650, sinkMs: 320 },
  rm: { total: 150 },
});

/** Soil colours by look (§9.10 palette): wet / dry / charred, plus the in-between "tilled" and "dryish". */
const SOIL_COLORS = {
  wet: new Color(SOIL.wet),
  dry: new Color(SOIL.dry),
  charred: new Color(SOIL.charred),
  tilled: new Color(SOIL.wet).lerp(new Color(SOIL.dry), 0.55),
  dryish: new Color(SOIL.wet).lerp(new Color(SOIL.dry), 0.5),
  cracked: new Color(SOIL.dry).lerp(new Color('#B98A5E'), 0.3),
};

const FAMILY_KEYS = ['standard', 'hyper', 'degen', 'swarm'];
const SACK_SPOTS = [
  [0, 0, 0, 0.2],
  [-0.32, 0, 0.06, -0.4],
  [0.04, 0, 0.33, 0.7],
  [-0.16, 0.27, 0.12, 0.1],
  [-0.34, 0, 0.36, -0.9],
];
const FOG_SPOTS = [
  [-0.55, 1.35, 0.15, 1.15],
  [0.65, 1.7, -0.35, 1.0],
  [1.15, 1.05, 1.15, 0.8], // over the thermometer: "thermometer fogged"
];

// 4.3 deep on a 4.4 row pitch: the rows' pick boxes nearly touch, so on a phone (where a row is only ~36 px tall on
// screen) a tap between two rows still lands on a plot instead of bare ground (G6: ≥ 44 px targets as far as the
// row pitch allows; the dock rows are the full-size alternative)
const proxyGeo = new BoxGeometry(3.6, 3.2, 4.3);
proxyGeo.translate(0, 1.6, 0);
const proxyMat = new MeshBasicMaterial({ visible: false });

/** A 0..1 visibility value with pop-in / fade-out easings. */
function vk(msIn = 300, easeIn = 'oB', msOut = 200, easeOut = 'iOS') {
  const tw = createTween({ from: 0, to: 0, ms: msIn, ease: easeIn });
  return {
    on: false,
    set(on, { reduced = false, instant = false } = {}) {
      const want = !!on;
      if (want === this.on && !instant) return;
      this.on = want;
      const ms = instant ? 0 : motionDur(want ? msIn : msOut, reduced);
      tw.retarget(want ? 1 : 0, ms, want ? easeIn : easeOut);
      if (instant) tw.t = tw.delay + tw.ms;
    },
    step(ms) {
      return tw.step(ms);
    },
    get v() {
      return Math.max(0, tw.value());
    },
    get busy() {
      return !tw.done;
    },
  };
}

/** Lever text on the plaque: "×10", "×2.5". */
export function levLabel(lev) {
  const n = Number(lev);
  if (!Number.isFinite(n) || n <= 0) return '×—';
  return '×' + (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));
}

export function createPlot({ slot, base, batches: B, tags = null, tier = {}, settings = () => ({}), sink = null } = {}) {
  const object3D = new Group();
  object3D.name = `plot:${slot}`;
  object3D.position.copy(base);
  const cropRoot = new Group();
  cropRoot.name = 'cropRoot';
  cropRoot.position.set(LAYOUT.crop[0], LAYOUT.crop[1], LAYOUT.crop[2]);
  object3D.add(cropRoot);
  const anchor = new Object3D();
  anchor.name = 'anchor';
  anchor.position.set(0, PLOT.labelY, 0);
  object3D.add(anchor);
  const proxy = new Mesh(proxyGeo, proxyMat);
  proxy.name = `proxy:plot:${slot}`;
  proxy.layers.set(1);
  proxy.userData.pick = { type: 'plot', slot };
  object3D.add(proxy);
  let LY = LAYOUT; // family layout (the hexagonal swarm box pulls its corner props inward)
  const stakeAnchor = new Object3D();
  stakeAnchor.position.set(LY.stake[0], LY.stake[1] + 0.66, LY.stake[2] + 0.12);
  object3D.add(stakeAnchor);
  // where the TESTNET word sits: beside the checkered pennant on the stake
  const pennantAnchor = new Object3D();
  pennantAnchor.position.set(LY.stake[0] + 0.45, LY.stake[1] + 1.3, LY.stake[2] + 0.1);
  object3D.add(pennantAnchor);
  const liqAnchor = new Object3D();
  liqAnchor.position.set(LAYOUT.liqSign[0], LAYOUT.liqSign[1] + 0.98, LAYOUT.liqSign[2] + 0.1);
  object3D.add(liqAnchor);
  object3D.updateMatrixWorld(true);

  // ---- batch handles
  const H = {};
  for (const f of FAMILY_KEYS) H['box_' + f] = B.handle('box_' + f, slot);
  for (const name of ['soil_square', 'soil_hex', 'outline_square', 'outline_hex', 'mound', 'cracks', 'scars', 'kit', 'kitHex', 'sign', 'thermoBoard', 'thermoBoardHex', 'thermoGlass', 'thermoFill', 'thermoBulb', 'thermoHaz', 'ring', 'parasol', 'basket', 'aframe', 'sachet', 'bust', 'liqSign', 'stump', 'glow', 'seedSign', 'trowel', 'valve', 'bird', 'mole', 'moleHat', 'molehill', 'pennant', 'pennantHex']) H[name] = B.handle(name, slot);
  H.sacks = [0, 1, 2, 3, 4].map((k) => B.handle('sack', slot, k));
  H.sacksHaz = [0, 1, 2, 3, 4].map((k) => B.handle('sackHaz', slot, k));
  H.fog = [0, 1, 2].map((k) => B.handle('fog', slot, k));

  // ---- state
  const fsm = createPlotFsm();
  const seedR = hash01(slot * 97 + 13);
  const S = {
    clockMs: 0,
    family: 'standard',
    soilFrom: SOIL_COLORS.tilled.clone(),
    soilTo: SOIL_COLORS.tilled.clone(),
    soilNow: SOIL_COLORS.tilled.clone(),
    soilTw: createTween({ from: 1, to: 1, ms: 600 }),
    box: vk(250, 'oB', 200),
    mound: vk(300, 'oB', 250),
    kit: vk(350, 'oB', 250),
    sign: vk(400, 'oB', 250),
    pennant: vk(350, 'oB', 250),
    testnet: false, // the shown view is a TESTNET bot (PLATFORM §9.4: pennant + TESTNET tag)
    sacks: [0, 1, 2, 3, 4].map(() => vk(300, 'oB', 200)),
    thermo: vk(300, 'oB', 250),
    ring: vk(300, 'oC', 300),
    parasol: vk(700, 'oB', 500, 'iOC'),
    basket: vk(400, 'oB', 250),
    aframe: vk(600, 'oB', 250),
    fog: vk(800, 'iOS', 800, 'iOS'),
    sachet: vk(300, 'oB', 200),
    bust: vk(300, 'oB', 200),
    liqSign: vk(400, 'oB', 250),
    stump: vk(400, 'oB', 300),
    glow: vk(300, 'oC', 200),
    seedSign: vk(300, 'oB', 200),
    trowel: vk(150, 'oC', 150),
    bird: vk(300, 'oB', 250),
    mole: vk(300, 'oB', 250),
    outline: vk(120, 'linear', 120),
    cracks: vk(1500, 'iOS', 500),
    scars: vk(400, 'oC', 300),
    signAngle: createTween({ from: 0, to: 0, ms: 500, ease: 'iOC' }),
    signColor: new Color(SIDE_COLORS.std.flat),
    signColorTo: new Color(SIDE_COLORS.std.flat),
    signPop: -1,
    valveAngle: createTween({ from: 0, to: 0, ms: 600, ease: 'iOC' }),
    thermoFill: createTween({ from: 1, to: 1, ms: 400, ease: 'iOS' }),
    thermoColor: new Color(BAND_COLORS.ok),
    parasolFly: false,
    flatten: 1,
    pick: false,
    pickCoin: null,
    dragOver: false,
    dim: false,
    halted: false,
    outlineKind: null, // 'hover' | 'selected' | null
    critterHop: 0,
    nextHop: nextGap(8000, 14000, seedR),
    critterSwap: -1,
    nextGlint: 3000,
    nextLeaf: nextGap(6000, 10000, seedR),
    nextDrip: nextGap(1800, 3200, seedR),
    nextSputter: 0,
    sputterUntil: 0,
    digClock: -1,
    digCount: 0,
    exit: null, // { kind, t, total, recipe }
    retillT: -1,
    shimmerT: null,
    lastLiqUsd: null,
    lastBot: null,
    lev: 1,
    sacksN: 0,
    hazard: false,
    first: true,
    q: tier || {},
  };
  let crop = null;
  let cropCoin = null;
  let look = plotLook(null, {});
  const timelines = new Set();
  let levTag = null;
  let venueTag = null; // "TESTNET" beside the pennant (PLATFORM §9.4)
  let liqTag = null;

  const set = () => (typeof settings === 'function' ? settings() : settings) || {};
  const isReduced = () => !!set().reduced;
  const critterOn = () => S.q.critters !== false && set().farmer !== false;

  // ------------------------------------------------------------------ crop lifecycle

  function ensureCrop(coin) {
    const key = cropFor(coin).coin;
    if (crop && cropCoin === key) return crop;
    disposeCrop();
    crop = buildCrop(coin, { tier: S.q.tier || 'high', seed: slot * 31 + 7 });
    cropCoin = key;
    crop.group.rotation.y = (hash01(slot * 5 + 1) - 0.5) * 0.9;
    crop.onLeafFall = (pos, color) => sink?.particles?.('leaves', pos, 1, { color: '#B98A4A' });
    crop.onWake = () => sink?.wake?.(); // RM: a timed change (brown fruit leaving after 10 s) asks for one frame
    crop.setMotion({ reduced: isReduced() });
    cropRoot.add(crop.group);
    return crop;
  }

  function disposeCrop() {
    if (!crop) return;
    crop.dispose();
    crop = null;
    cropCoin = null;
  }

  // ------------------------------------------------------------------ look → targets

  function refreshLook({ instant = false } = {}) {
    const st = set();
    let view = fsm.view || (fsm.state === 'closing' || fsm.exiting ? fsm.lastView : null);
    // plantOk arrived before the bot's first view: show a provisional seedling of the planted coin
    if (!view && PLANTED.includes(fsm.state) && cropCoin) view = provisionalView();
    const showView = PLANTED.includes(fsm.state) || fsm.state === 'closing' || fsm.state === 'harvesting' || fsm.state === 'pulling' ? view : null;
    look = plotLook(showView, { palette: st.palette, halted: S.halted, pick: S.pick, levTier });
    applyLook({ instant: instant || S.first });
    S.first = false;
  }

  /** Seed look used between plantOk and the first PlotView (no numbers are shown from it). */
  function provisionalView() {
    return { slot, botId: '(planting)', coin: cropCoin, state: 'waiting', phase: 'waiting', side: 0, lev: 1, family: 'standard', size: 0.25, health: 1, fruit: 0, flower: false, seed: true, caption: 'waiting', ripe: false, frac: 0, liqInfo: null };
  }

  function soilTarget(key, ms) {
    const c = SOIL_COLORS[key] || SOIL_COLORS.tilled;
    if (S.soilTo.equals(c)) return;
    S.soilFrom.copy(S.soilNow);
    S.soilTo.copy(c);
    S.soilTw.retarget(1, ms);
    S.soilTw.from = 0;
    S.soilTw.t = 0;
  }

  function applyLook({ instant = false } = {}) {
    const rm = isReduced();
    const o = { reduced: rm, instant };
    const L = look;
    const planted = !L.empty;
    const state = fsm.state;
    const exiting = state === 'harvesting' || state === 'pulling';
    const seedState = state === 'planting' || (planted && L.mode === 'seed');

    // family shell (+ its prop layout)
    S.family = planted ? L.family : 'standard';
    const ly = layoutFor(S.family);
    if (ly !== LY) {
      LY = ly;
      stakeAnchor.position.set(LY.stake[0], LY.stake[1] + 0.66, LY.stake[2] + 0.12);
      stakeAnchor.updateMatrixWorld(true);
      pennantAnchor.position.set(LY.stake[0] + 0.45, LY.stake[1] + 1.3, LY.stake[2] + 0.1);
      pennantAnchor.updateMatrixWorld(true);
    }
    S.box.set(true, o);

    // soil (paused dries over 4 s; water darkens over 1 s)
    let soilKey = 'tilled';
    if (S.halted) soilKey = 'charred';
    else if (planted) soilKey = L.soil;
    else if (state === 'planting') soilKey = 'tilled';
    soilTarget(soilKey, instant ? 0 : motionDur(soilKey === 'dry' && L.paused ? 4000 : 900, rm));

    S.mound.set(seedState && !exiting, o);
    S.cracks.set(planted && L.soil === 'cracked' && !S.halted, o);
    S.scars.set(planted && L.liquidated, o);
    S.kit.set(planted, o);
    S.sign.set(planted, o);
    S.testnet = planted && fsm.view?.venue === 'testnet';
    S.pennant.set(S.testnet, o);
    S.sachet.set(planted && fsm.state === 'waiting', o);
    S.bust.set(planted && L.busted, o);
    S.liqSign.set(planted && L.liquidated, o);
    S.stump.set(!planted && S.halted && state !== 'planting', o);
    S.glow.set(!planted && S.pick && !S.halted && state === 'empty', o);
    S.seedSign.set(!planted && S.pick && !S.halted && state === 'empty', o);
    S.trowel.set(state === 'planting', o);
    S.aframe.set(planted && L.error, o);
    S.fog.set(planted && L.frozen, o);
    S.ring.set(planted && L.danger, o);
    S.basket.set((planted && L.basket) || state === 'harvesting', o);
    S.parasol.set(planted && L.parasol, o);

    // side: sign angle + colour, critters
    const side = planted ? L.side : 0;
    // nearest equivalent angle, so a flip that already turned 180° is never unwound by the next view
    let angle = side > 0 ? 0 : side < 0 ? Math.PI : -Math.PI / 2;
    angle += Math.round((S.signAngle.to - angle) / TAU) * TAU;
    if (Math.abs(S.signAngle.to - angle) > 1e-3) S.signAngle.retarget(angle, instant ? 0 : motionDur(500, rm), 'iOC');
    S.signColorTo.set(planted ? L.sign.color : SIDE_COLORS.std.flat);
    if (instant) S.signColor.copy(S.signColorTo);
    S.bird.set(planted && side > 0 && critterOn() && !exiting, o);
    S.mole.set(planted && side < 0 && critterOn() && !exiting, o);

    // leverage: sacks by tier (§3.2), hazard stripes ≥ 25×
    S.lev = planted ? L.lev : 1;
    S.sacksN = planted ? L.sacks : 0;
    S.hazard = planted && L.hazardSacks;
    S.sacks.forEach((s, i) => s.set(i < S.sacksN, o));

    // thermometer (only with a position, §3.2)
    S.thermo.set(planted && !!L.thermo, o);
    if (L.thermo) {
      if (Math.abs(S.thermoFill.to - L.thermo.fill) > 1e-4) S.thermoFill.retarget(L.thermo.fill, instant ? 0 : motionDur(400, rm), 'iOS');
      S.thermoColor.set(L.thermo.color);
    }

    // valve: open while active
    const vAngle = planted && L.valveOpen ? 0 : Math.PI / 2;
    if (Math.abs(S.valveAngle.to - vAngle) > 1e-3) S.valveAngle.retarget(vAngle, instant ? 0 : motionDur(600, rm), 'iOC');

    // crop
    const showCrop = planted || state === 'planting' || exiting || state === 'closing';
    if (planted && L.coin) ensureCrop(L.coin);
    if (crop) {
      crop.setMotion({ reduced: rm });
      if (planted) {
        const c = L.crop;
        crop.setGrowth({
          size: c.size,
          health: c.health,
          fruit: c.fruit,
          flowerOpen: c.flowerOpen,
          ripe: L.ripe,
          ripe01: c.ripe01,
          seed: L.mode === 'seed',
          sat: c.sat,
          frost: c.frost,
          frozen: L.frozen,
          droop: c.droop,
          leafKeep: c.leafKeep,
          flatten: c.flatten,
          wiggle: L.entering,
        });
        crop.setSway(L.sway.amp, L.sway.shiver, 1, { jitter: L.sway.jitter });
      }
      crop.setDim(S.dim ? 0.85 : 1);
      crop.group.visible = showCrop;
    }

    // DOM tags
    updateTags();
  }

  function updateTags() {
    const st = set();
    const labelsMode = st.labels || 'always';
    const planted = !look.empty && fsm.state !== 'harvesting' && fsm.state !== 'pulling';
    // The ×N stake tag is the in-world leverage cue whenever this plot's CHIP is not shown (J7: compacted, never
    // hidden — e.g. every unselected plot on a phone, where labels default to "hover & selected"); while the
    // chip is up it already says ×N, so the tag steps aside instead of doubling it. Labels "off" hides both.
    const chipShown = labelsMode === 'always' || !!S.outlineKind;
    const showLev = planted && labelsMode !== 'off' && !chipShown;
    if (tags) {
      // the TESTNET word (localised key; the same word in EN and TH). While the ×N tag is up, the word joins it
      // ("×40 · TESTNET") instead of hanging beside the pennant just above it: two tags 0.6 u apart overlapped and
      // hid the stake (the checkered pennant itself stays the shape cue, §9.4 J6)
      const showVenue = planted && S.testnet && labelsMode !== 'off';
      const levText = showLev && showVenue ? `${levLabel(S.lev)} · ${tr('g.venue.testnet')}` : levLabel(S.lev);
      if (showLev && !levTag) levTag = tags.add(stakeAnchor, { cls: 'fx-tag--lev', text: levText, tone: 'neutral' });
      if (levTag) {
        levTag.setText(levText);
        levTag.el?.classList?.toggle?.('fx-tag--tn', !!(showLev && showVenue));
        levTag.setVisible(!!showLev);
      }
      if (showVenue && !showLev && !venueTag) venueTag = tags.add(pennantAnchor, { cls: 'fx-tag--venue', text: tr('g.venue.testnet'), tone: 'neutral' });
      if (venueTag) {
        venueTag.setText(tr('g.venue.testnet'));
        venueTag.setVisible(!!(showVenue && !showLev));
      }
      const showLiq = planted && look.liquidated;
      if (showLiq && !liqTag) liqTag = tags.add(liqAnchor, { cls: 'fx-tag--liq', text: '', tone: 'down' });
      if (liqTag) {
        if (showLiq) {
          // X = the initial margin lost (from the liquidation event); without it, the bot's own total P&L
          const x = Number.isFinite(S.lastLiqUsd) ? -Math.abs(S.lastLiqUsd) : (fsm.view?.usd ?? fsm.lastView?.usd);
          const m = moneyText(x);
          liqTag.setText(tr('g.state.liquidated', { usd: Number.isFinite(x) ? m.text : '' }).trim());
        }
        liqTag.setVisible(!!showLiq);
      }
    }
  }

  // ------------------------------------------------------------------ prop placement (every frame)

  const pos = object3D.position;

  function put(h, k, x, y, z, q = null, sx = 1, sy = sx, sz = sx) {
    if (k <= 0.001) return h.hide();
    return h.set(pos, x, y, z, q, sx * k, sy * k, sz * k);
  }

  function drawProps(tSec, dtMs) {
    const rm = isReduced();
    const P = S;
    const L = look;
    // box + outline
    for (const f of FAMILY_KEYS) {
      if (f === P.family) put(H['box_' + f], 1, 0, 0, 0, null, 1, P.box.v, 1);
      else H['box_' + f].hide();
    }
    const hex = P.family === 'swarm';
    const dimK = P.dim ? 0.85 : 1;
    H['box_' + P.family].color(_c.setScalar(dimK));
    const ol = P.outline.v;
    put(H.outline_square, hex ? 0 : ol, 0, 0, 0);
    put(H.outline_hex, hex ? ol : 0, 0, 0, 0);

    // soil (retill: a quick ripple of the furrows)
    const k = P.soilTw.value();
    P.soilNow.copy(P.soilFrom).lerp(P.soilTo, clamp(k, 0, 1));
    let soilY = 1;
    if (P.retillT >= 0) {
      const r = clamp(P.retillT / 600, 0, 1);
      soilY = 1 + 0.35 * Math.sin(r * Math.PI) * (1 - r);
    }
    let shimmer = 1;
    if (P.shimmerT !== null) {
      P.shimmerT += dtMs;
      if (P.shimmerT >= 0) {
        const r = clamp(P.shimmerT / 800, 0, 1);
        shimmer = 1 + 0.32 * Math.sin(r * Math.PI);
        if (r >= 1) P.shimmerT = null;
      }
    }
    _c.copy(P.soilNow).multiplyScalar(dimK * shimmer);
    put(H.soil_square, hex ? 0 : 1, 0, 0, 0, null, 1, soilY, 1).color(_c);
    put(H.soil_hex, hex ? 1 : 0, 0, 0, 0, null, 1, soilY, 1).color(_c);
    // mound (entering: breathes scale-y 1 → 1.08, 1.5 s)
    const breathe = look.entering && !rm ? 1 + 0.08 * pulse(tSec, 1.5) : 1;
    put(H.mound, P.mound.v, LAYOUT.crop[0], BOX.soilY - 0.02, LAYOUT.crop[2], null, 1, breathe, 1).color(_c.copy(P.soilNow).multiplyScalar(0.92 * dimK));
    put(H.cracks, P.cracks.v > 0.02 ? 1 : 0, 0, 0, 0, null, 1, 1, 1).color(_c.set('#4A3326').lerp(P.soilNow, 1 - P.cracks.v));
    put(H.scars, P.scars.v, 0, 0, 0).color(_c.set('#3A2C24'));

    // planted kit
    put(hex ? H.kitHex : H.kit, P.kit.v > 0.001 ? 1 : 0, 0, 0, 0, null, 1, P.kit.v, 1);
    (hex ? H.kit : H.kitHex).hide();
    // TESTNET pennant on the stake (grows with the kit, pops with its own tween)
    put(hex ? H.pennantHex : H.pennant, P.pennant.v > 0.001 ? 1 : 0, 0, 0, 0, null, 1, P.pennant.v * Math.min(1, P.kit.v), 1);
    (hex ? H.pennant : H.pennantHex).hide();
    // arrow sign: pivot near the post top; LONG up / SHORT down / FLAT sideways (§3.3)
    let pop = 1;
    if (P.signPop >= 0) {
      P.signPop += dtMs;
      pop = popScale(P.signPop / 400, 1.2);
      if (P.signPop >= 400) P.signPop = -1;
    }
    P.signColor.lerp(P.signColorTo, rm ? 1 : clamp(dtMs / 250, 0, 1));
    _q.setFromAxisAngle(AXIS_Z, P.signAngle.value());
    const [px, py, pz] = LY.post;
    put(H.sign, P.sign.v * pop, px + 0.02, LAYOUT.signY, pz + 0.12, _q, 0.62).color(P.signColor);

    // sacks (tier count; hazard stripes ≥ 25×)
    const [sx, sy, sz] = LY.sacks;
    for (let i = 0; i < 5; i++) {
      const sp = SACK_SPOTS[i];
      const v = P.sacks[i].v;
      _q.setFromAxisAngle(AXIS_Y, sp[3]);
      if (P.hazard) {
        H.sacks[i].hide();
        put(H.sacksHaz[i], v, sx + sp[0], sy + sp[1], sz + sp[2], _q);
      } else {
        H.sacksHaz[i].hide();
        put(H.sacks[i], v, sx + sp[0], sy + sp[1], sz + sp[2], _q).color(_c.setScalar(1));
      }
    }

    // thermometer (fill = d; bands slate / amber / amber + hazard; never green/red)
    const tv = P.thermo.v;
    const [tx, ty, tz] = LY.thermo;
    const fill = clamp(P.thermoFill.value(), 0, 1);
    put(hex ? H.thermoBoardHex : H.thermoBoard, tv > 0.001 ? 1 : 0, 0, 0, 0, null, 1, tv, 1);
    (hex ? H.thermoBoard : H.thermoBoardHex).hide();
    put(H.thermoGlass, tv, tx, ty + 0.12, tz + 0.02, null, 1);
    put(H.thermoBulb, tv, tx, ty + 0.12, tz + 0.02).color(P.thermoColor);
    put(H.thermoFill, tv && fill > 0.005 ? 1 : 0, tx, ty + 0.2, tz + 0.02, null, tv, 0.72 * fill * tv, tv).color(P.thermoColor);
    put(H.thermoHaz, look.danger && tv ? 1 : 0, tx, ty + 0.2, tz + 0.02, null, tv, 0.72 * fill * tv, tv);

    // danger ring: pulses 0.5 Hz, scale 1 → 1.08 (RM: static)
    const ringS = rm ? 1 : 1 + 0.08 * pulse(tSec, 2);
    put(H.ring, P.ring.v, 0, 0, 0, null, ringS, 1, ringS);

    // valve wheel
    _q.setFromAxisAngle(AXIS_Y, P.valveAngle.value());
    put(H.valve, P.kit.v, LY.valve[0], LY.valve[1], LY.valve[2], _q);

    // parasol: drops in + unfolds (scale-y) / folds + flies off
    const pv = P.parasol.v;
    let pyOff = 0;
    if (!P.parasol.on && P.parasolFly) pyOff = (1 - pv) * 3.2;
    else if (P.parasol.on) pyOff = (1 - Math.min(1, pv)) * 1.6;
    const [qx, qy, qz] = LY.parasol;
    put(H.parasol, pv > 0.01 ? 1 : 0, qx, qy + pyOff, qz, null, Math.max(0.2, Math.min(1.08, pv)), Math.max(0.05, pv), Math.max(0.2, Math.min(1.08, pv)));
    if (!P.parasol.on && pv <= 0.01) P.parasolFly = false;

    // basket, A-frame, sachets, signs, stumps
    put(H.basket, P.basket.v, LAYOUT.basket[0], LAYOUT.basket[1], LAYOUT.basket[2], Q.yaw(0.3));
    put(H.aframe, P.aframe.v, LAYOUT.aframe[0], LAYOUT.aframe[1], LAYOUT.aframe[2], Q.yaw(-0.5));
    put(H.sachet, P.sachet.v, LAYOUT.sachet[0], LAYOUT.sachet[1], LAYOUT.sachet[2], Q.yaw(-0.2));
    _q.setFromAxisAngle(AXIS_Z, 0.12);
    put(H.bust, P.bust.v, px + 0.02, LAYOUT.signY - 0.72, pz + 0.12, _q);
    put(H.liqSign, P.liqSign.v, LAYOUT.liqSign[0], LAYOUT.liqSign[1], LAYOUT.liqSign[2]);
    put(H.stump, P.stump.v, LAYOUT.crop[0], BOX.soilY - 0.04, LAYOUT.crop[2]);

    // pick mode: dashed glow ring bouncing 0.05 u (1.2 s loop, iOS) + "plant here" seed sign (RM: static)
    const bounce = rm ? 0 : 0.05 * EASE.iOS(pulse(tSec, 1.2));
    // a seed dragged over this box: the ring pulses (P1; RM: static, slightly larger)
    const dragK = P.dragOver ? (rm ? 1.06 : 1 + 0.08 * pulse(tSec, 0.5)) : 1;
    put(H.glow, P.glow.v, 0, BOX.rim + 0.06 + bounce, 0, null, dragK, 1, dragK);
    put(H.seedSign, P.seedSign.v, 0, BOX.soilY, 0.2, Q.yaw(-0.15));

    // trowel dig loop (2 digs/s)
    if (P.trowel.v > 0.01) {
      const dig = rm ? 0 : (tSec * 2) % 1;
      const plunge = rm ? 0 : Math.sin(dig * Math.PI);
      _q.setFromAxisAngle(AXIS_X, -0.5 + 0.7 * plunge);
      _q2.setFromAxisAngle(AXIS_Y, 0.6);
      _q.premultiply(_q2);
      put(H.trowel, P.trowel.v, 0.15, BOX.soilY + 0.42 - 0.3 * plunge, 0.2, _q);
    } else H.trowel.hide();

    // critters (P1): bluebird on the sign post (LONG), mole by its molehill (SHORT); hop/dig every 8–14 s
    const hopK = P.critterHop > 0 ? clamp(P.critterHop / 300, 0, 1) : 0;
    const hopY = P.critterHop > 0 ? Math.sin(hopK * Math.PI) * 0.28 : 0;
    const cols = set().palette === 'cb' ? SIDE_COLORS.cb : SIDE_COLORS.std;
    _q.setFromAxisAngle(AXIS_Y, 0.35 + (P.critterHop > 0 ? hopK * TAU * 0.5 : 0));
    put(H.bird, P.bird.v, px + 0.02, BOX.soilY + 1.75 + hopY, pz + 0.02, _q).color(_c.set(cols.up));
    const [mx, my, mz] = LAYOUT.molehill;
    put(H.molehill, P.mole.v, mx, my, mz).color(_c.copy(SOIL_COLORS.dry));
    const dug = P.critterHop > 0 ? Math.sin(hopK * Math.PI) : 0;
    _q.setFromAxisAngle(AXIS_Y, -0.4);
    put(H.mole, P.mole.v, mx, my + 0.2 - dug * 0.16, mz + 0.04, _q, 1.35);
    put(H.moleHat, P.mole.v, mx, my + 0.38 - dug * 0.16, mz + 0.04, _q, 1.35).color(_c.set(cols.down));

    // fog bank: 3 soft puffs (scale in; a slow drift)
    const fv = P.fog.v;
    for (let i = 0; i < 3; i++) {
      const sp = FOG_SPOTS[i];
      const drift = rm ? 0 : Math.sin(tSec * 0.4 + i * 2.1) * 0.12;
      put(H.fog[i], fv, sp[0] + drift, sp[1], sp[2], null, sp[3] * fv, sp[3] * fv * 0.8, sp[3] * fv);
    }
  }

  // ------------------------------------------------------------------ ambient loops (state-driven, §3.5)

  function ambient(dtMs) {
    if (isReduced() || !sink) return;
    const L = look;
    const planted = !L.empty && PLANTED.includes(fsm.state);
    if (!planted || !crop) return;
    // ripe: one glint every 6–10 s — the same weight and cadence as the wilting leaf below (J11 symmetric
    // feedback; an unrealized gain is not celebrated, J4)
    if (L.ripe) {
      S.nextGlint -= dtMs;
      if (S.nextGlint <= 0) {
        S.nextGlint = nextGap(6000, 10000);
        const n = Math.max(1, crop.fruitCount);
        sink.particles?.('sparkle', crop.fruitWorld(Math.floor(Math.random() * n)), 1);
      }
    }
    // wilting: a brown leaf falls every 6–10 s
    if (L.wilting) {
      S.nextLeaf -= dtMs;
      if (S.nextLeaf <= 0) {
        S.nextLeaf = nextGap(6000, 10000);
        sink.particles?.('leaves', crop.leafWorld(Math.floor(Math.random() * Math.max(1, crop.visibleLeaves))), 1, { color: '#B98A4A' });
      }
    }
    // the drip line: a slow drip while active; error: the pipe sputters
    const vp = _amb.set(LY.valve[0], LY.valve[1] + 0.05, LY.valve[2]).add(object3D.position).clone();
    if (L.error) {
      S.nextSputter -= dtMs;
      if (S.nextSputter <= 0) {
        S.nextSputter = nextGap(500, 1400);
        sink.particles?.('drips', vp, 2);
      }
    } else if (L.valveOpen) {
      S.nextDrip -= dtMs;
      if (S.nextDrip <= 0) {
        S.nextDrip = nextGap(2200, 3600);
        sink.particles?.('drip', vp, 1);
      }
    }
    // critters hop / dig
    if (S.bird.on || S.mole.on) {
      S.nextHop -= dtMs;
      if (S.nextHop <= 0) {
        S.nextHop = nextGap(8000, 14000);
        S.critterHop = 1;
        if (S.mole.on) sink.particles?.('dust', V(LAYOUT.molehill[0], 0.15, LAYOUT.molehill[2]).add(object3D.position), 3);
      }
    }
  }

  // ------------------------------------------------------------------ effects (plot-local part)

  function timeline() {
    const tl = createTimeline({ reduced: isReduced() });
    timelines.add(tl);
    tl.done.then(() => timelines.delete(tl));
    return tl;
  }

  /**
   * Run the plot-local part of an effect (§4.1–4.3) → Promise resolved when it ends. The executor plays the
   * global parts (particles, coins, floaters, sounds) with the same timings (EXIT).
   */
  function play(effect) {
    const kind = effect?.kind;
    const rm = isReduced() || !!effect?.meta?.reduced;
    const now = S.clockMs;
    switch (kind) {
      case 'pending': {
        if (effect.meta?.op !== 'bot_create') return Promise.resolve(false);
        const r = fsm.pending(!!effect.meta.on, effect.meta.ok !== false, now);
        if (r.changed) {
          if (r.state === 'planting') {
            S.digClock = 0;
            S.digCount = 0;
          }
          refreshLook();
        }
        return Promise.resolve(true);
      }
      case 'plantFail': {
        fsm.pending(false, false, now);
        refreshLook();
        return Promise.resolve(true);
      }
      case 'plantOk': {
        const r = fsm.planted(now);
        if (effect.coin) ensureCrop(effect.coin);
        if (r.changed && crop) {
          // the seed lands at 600 ms, then the sprout pops 0 → size×1.15 → size (450, oB); RM: fade in 150
          crop.setGrowth({ size: 0.25, health: 1, fruit: 0, flowerOpen: false, seed: true });
          const tl = timeline();
          cropRoot.scale.setScalar(0.001);
          tl.add({ at: rm ? 0 : 600, ms: rm ? 150 : 450, ease: 'linear', update: (k) => cropRoot.scale.setScalar(rm ? Math.max(0.001, k) : Math.max(0.001, popScale(k))) });
          tl.call(rm ? 150 : 1050, () => cropRoot.scale.setScalar(1));
          refreshLook();
          return tl.done;
        }
        return Promise.resolve(false);
      }
      case 'water': {
        soilTarget(S.halted ? 'charred' : 'wet', rm ? 0 : 1000);
        return Promise.resolve(true);
      }
      case 'fill':
      case 'fillMerged': {
        if (!rm) S.signPop = 0;
        return Promise.resolve(true);
      }
      case 'flip': {
        // the sign rotates 180° (500, iOC); bird ↔ mole swap with a hop (300)
        const toShort = /Short/.test(String(effect.meta?.to ?? effect.meta?.dir ?? ''));
        let angle = toShort ? Math.PI : 0;
        angle += Math.round((S.signAngle.to - angle) / TAU) * TAU;
        S.signAngle.retarget(angle, motionDur(500, rm), 'iOC');
        S.signColorTo.set(SIDE_COLORS[set().palette === 'cb' ? 'cb' : 'std'][toShort ? 'down' : 'up']);
        S.critterHop = rm ? 0 : 1;
        return Promise.resolve(true);
      }
      case 'fruitGain':
      case 'fruitGainQuiet':
        crop?.popFruit(effect.n ?? 0, kind === 'fruitGainQuiet' || rm);
        if (kind === 'fruitGain' && !rm) crop?.bounce();
        return Promise.resolve(true);
      case 'fruitLoss':
        crop?.dropFruit(effect.n ?? 0);
        return Promise.resolve(true);
      case 'ripeOn':
        S.basket.set(true, { reduced: rm });
        S.nextGlint = 400;
        return Promise.resolve(true);
      case 'frozenOn':
        S.fog.set(true, { reduced: rm });
        return Promise.resolve(true);
      case 'frozenOff':
        S.fog.set(false, { reduced: rm });
        return Promise.resolve(true);
      case 'liqDangerOn':
        S.ring.set(true, { reduced: rm });
        return Promise.resolve(true);
      case 'shade':
      case 'bustPlanted': {
        S.parasolFly = false;
        S.parasol.set(true, { reduced: rm });
        if (kind === 'bustPlanted') S.bust.set(true, { reduced: rm });
        return Promise.resolve(true);
      }
      case 'resume': {
        S.parasolFly = !rm;
        S.parasol.set(false, { reduced: rm });
        return Promise.resolve(true);
      }
      case 'liquidate': {
        if (Number.isFinite(Number(effect.usd))) S.lastLiqUsd = Number(effect.usd);
        // the hail flattens the plant to a stump (scale-y 0.15) while the sign drops in (400, oB)
        const tl = timeline();
        tl.call(rm ? 0 : 900, () => crop?.setFlatten(0.15));
        tl.call(rm ? 0 : 1500, () => S.liqSign.set(true, { reduced: rm }));
        tl.call(rm ? 0 : 1500, () => S.scars.set(true, { reduced: rm }));
        tl.call(rm ? 0 : 1500, () => updateTags());
        return tl.done;
      }
      case 'error':
        S.aframe.set(true, { reduced: rm });
        S.sputterUntil = S.clockMs + 2000;
        return Promise.resolve(true);
      case 'harvest':
      case 'pull':
      case 'burnPlot':
        return exit(effect, rm);
      default:
        return Promise.resolve(false);
    }
  }

  /** Harvest / pull / burn exit timeline. Resolves when the box has started re-tilling. */
  function exit(effect, rm) {
    const recipe = effect.kind === 'burnPlot' ? (effect.meta?.recipe === 'pull' ? 'pull' : 'harvest') : effect.kind;
    const started = fsm.startExit(recipe === 'pull' ? 'pull' : 'harvest', S.clockMs);
    if (effect.kind === 'burnPlot') S.halted = true;
    if (!started || !crop) {
      refreshLook();
      return Promise.resolve(false);
    }
    refreshLook();
    const tl = timeline();
    const base = { y: cropRoot.position.y, rx: 0, rz: 0 };
    const compact = effect.kind === 'burnPlot';
    if (rm) {
      tl.add({ at: 0, ms: EXIT.rm.total, update: (k) => cropRoot.scale.setScalar(Math.max(0.001, 1 - k)) });
    } else if (recipe === 'harvest') {
      if (compact) {
        tl.add({ at: 0, ms: EXIT.burn.sinkMs, ease: 'iOS', update: (k, e) => {
          cropRoot.rotation.x = 0.4 * e;
          cropRoot.position.y = base.y - 1.2 * e;
          cropRoot.scale.setScalar(Math.max(0.001, 1 - e * 0.8));
        } });
      } else {
        const E = EXIT.harvest;
        // fruits hop into the basket (hidden here; the executor flies them)
        const n = crop.fruitCount;
        for (let i = 0; i < n; i++) tl.call(E.fruitAt + i * E.fruitStagger, () => crop?.hideFruit(i));
        tl.add({ at: E.bowAt, ms: E.bowMs, ease: 'iOS', update: (k, e) => {
          cropRoot.rotation.x = 0.45 * Math.sin(Math.min(1, e * 1.4) * Math.PI * 0.5);
          cropRoot.position.y = base.y - 1.6 * e * e;
          cropRoot.scale.setScalar(Math.max(0.001, 1 - 0.85 * e));
        } });
        tl.call(E.total - 250, () => S.basket.set(false, { reduced: false }));
      }
    } else {
      const ms = compact ? EXIT.burn.sinkMs : EXIT.pull.uprootMs;
      tl.add({ at: 0, ms, ease: 'oC', update: (k, e) => {
        cropRoot.position.y = base.y + 0.4 * e;
        cropRoot.rotation.z = (30 * Math.PI) / 180 * e;
      } });
      tl.add({ at: ms, ms: 140, ease: 'inQuad', update: (k) => cropRoot.scale.setScalar(Math.max(0.001, 1 - k)) });
    }
    const total = rm ? EXIT.rm.total : compact ? EXIT.burn.total : recipe === 'harvest' ? EXIT.harvest.total : EXIT.pull.total;
    tl.call(total, () => {
      fsm.endExit(S.clockMs);
      S.retillT = 0;
      disposeCrop();
      cropRoot.position.y = base.y;
      cropRoot.rotation.set(0, 0, 0);
      cropRoot.scale.setScalar(1);
      refreshLook();
    });
    return tl.done;
  }

  // ------------------------------------------------------------------ public

  const api = {
    slot,
    object3D,
    anchor,
    proxy,
    fsm,
    get view() {
      return fsm.view;
    },
    get look() {
      return look;
    },
    get crop() {
      return crop;
    },

    /** Apply a new PlotView (or null for an empty slot). Exits queue the view until they end (§3.5). */
    setView(view, { instant = false } = {}) {
      const r = fsm.apply(view ?? null, S.clockMs);
      if (r.deferred) return;
      if (view && view.botId !== S.lastBot) S.lastLiqUsd = null;
      if (view) S.lastBot = view.botId;
      if (r.state === 'retill') {
        S.retillT = 0;
        disposeCrop();
      }
      refreshLook({ instant });
    },

    play,

    /** Move the box (slot count changed, §2.3). */
    setBase(p) {
      object3D.position.copy(p);
      object3D.updateMatrixWorld(true);
    },
    setPick(on, coin = null) {
      S.pick = !!on;
      S.pickCoin = coin;
      refreshLook();
    },
    /** A seed card is dragged over this box (§4.1 P1): its pick ring pulses. */
    setDragOver(on) {
      S.dragOver = !!on;
    },
    /** 'selected' | 'hover' | null — inverted-hull outline (§3.5). */
    setOutline(kind) {
      S.outlineKind = kind || null;
      S.outline.set(!!kind, { reduced: isReduced() });
      updateTags();
    },
    setDim(on) {
      S.dim = !!on;
      crop?.setDim(S.dim ? 0.85 : 1);
    },
    setHalted(on) {
      if (S.halted === !!on) return;
      S.halted = !!on;
      refreshLook();
    },
    setQuality(q) {
      S.q = q || {};
      refreshLook();
    },
    /** Bar tick: a soil shimmer passes over this box after `delayMs` (§4.4; RM: none). */
    shimmer(delayMs = 0) {
      if (isReduced() || look.empty) return;
      S.shimmerT = -Math.max(0, delayMs);
    },
    /** The executor's particle/sound sink (ambient plot life). */
    setSink(s) {
      sink = s || null;
    },
    /** Settings changed (palette, labels, motion, farmer & animals). */
    refresh() {
      refreshLook();
    },

    /** World positions the executor aims effects at. */
    points: {
      center: () => object3D.localToWorld(V(0, BOX.soilY + 0.1, 0)),
      top: () => (crop && !look.empty ? crop.topWorld() : object3D.localToWorld(V(0, 1.4, 0))),
      fruit: (i) => (crop ? crop.fruitWorld(i) : object3D.localToWorld(V(0, 1, 0))),
      basket: () => object3D.localToWorld(V(LAYOUT.basket[0], 0.3, LAYOUT.basket[2])),
      valve: () => object3D.localToWorld(V(LY.valve[0], LY.valve[1] + 0.1, LY.valve[2])),
      sign: () => object3D.localToWorld(V(LY.post[0], LAYOUT.signY, LY.post[2] + 0.1)),
      sky: () => object3D.localToWorld(V(0, 4.2, 0)),
      label: () => object3D.localToWorld(V(0, 2.2, 0)),
    },
    get fruitCount() {
      return crop ? crop.fruitCount : 0;
    },

    update(dt, t) {
      const dtMs = Math.min(50, Math.max(0, (Number(dt) || 0) * 1000));
      S.clockMs += dtMs;
      const tSec = Number.isFinite(t) ? t : S.clockMs / 1000;
      // FSM timeouts (planting max 10 s, closing grace, retill)
      const r = fsm.tick(S.clockMs);
      if (r.changed) {
        if (r.state === 'retill') {
          S.retillT = 0;
          disposeCrop();
        }
        refreshLook();
      }
      if (S.retillT >= 0) {
        S.retillT += dtMs;
        if (S.retillT > 600) S.retillT = -1;
      }
      // tweens
      for (const key of ['box', 'mound', 'kit', 'sign', 'pennant', 'thermo', 'ring', 'parasol', 'basket', 'aframe', 'fog', 'sachet', 'bust', 'liqSign', 'stump', 'glow', 'seedSign', 'trowel', 'bird', 'mole', 'outline', 'cracks', 'scars']) S[key].step(dtMs);
      for (const s of S.sacks) s.step(dtMs);
      S.signAngle.step(dtMs);
      S.valveAngle.step(dtMs);
      S.thermoFill.step(dtMs);
      S.soilTw.step(dtMs);
      if (S.critterHop > 0) {
        S.critterHop += dtMs;
        if (S.critterHop > 300) S.critterHop = 0;
      }
      // the trowel's dig sounds + dust (max 4 thups)
      if (fsm.state === 'planting' && !isReduced()) {
        S.digClock += dtMs;
        if (S.digClock >= 500) {
          S.digClock -= 500;
          sink?.particles?.('dust', api.points.center(), 4);
          if (S.digCount < 4) sink?.sfx?.('thup');
          S.digCount++;
        }
      }
      for (const tl of [...timelines]) tl.step(dtMs);
      ambient(dtMs);
      if (crop) crop.update(dt, tSec);
      drawProps(tSec, dtMs);
    },

    /** True while anything on this plot still moves (on-demand rendering). */
    busy() {
      if (timelines.size || S.retillT >= 0 || S.shimmerT !== null || S.signPop >= 0 || S.critterHop > 0 || fsm.state === 'planting' || fsm.state === 'closing') return true;
      if (crop?.busy()) return true;
      for (const key of ['box', 'mound', 'kit', 'sign', 'thermo', 'ring', 'parasol', 'basket', 'aframe', 'fog', 'sachet', 'bust', 'liqSign', 'stump', 'glow', 'seedSign', 'trowel', 'bird', 'mole', 'outline', 'cracks', 'scars']) if (S[key].busy) return true;
      return !S.signAngle.done || !S.valveAngle.done || !S.thermoFill.done || !S.soilTw.done;
    },

    dispose() {
      for (const tl of timelines) tl.cancel();
      timelines.clear();
      disposeCrop();
      for (const h of Object.values(H)) (Array.isArray(h) ? h : [h]).forEach((x) => x.hide());
      levTag?.remove();
      venueTag?.remove();
      liqTag?.remove();
      object3D.removeFromParent();
    },
  };
  return api;
}

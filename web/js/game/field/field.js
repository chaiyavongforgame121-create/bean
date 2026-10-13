/**
 * field/field.js — the planter field: slots, sync, pick-mode glow, hover/selected outlines, plot lookup
 * (GAME-DESIGN §2.3, §3, §5.3–5.5, §9.7).
 *
 *   createField({ scene, world, picker, labels, tier, settings, camera?, container? }) → Field
 *   Field = { sync(views, count), plot(slot) → Plot | null, setPickMode(on, beanCoin?), setHover(slot|null),
 *             setSelected(slot|null), setDim(exceptSlot|null), update(dt, t), rebuild(), dispose(),
 *             // extras (feature-detected by stage.js / the executor):
 *             setQuality(q), setHalted(on), setSettings(s), setReduced(b), setDragOver(slot), setFx(sink), busy(),
 *             plots(), drawCalls(), triangles() }
 *
 * - Slot positions come from world.slotPosition(i, count) (§2.3); without a world the same grid is computed
 *   locally (growth.gridPosition).
 * - Each plot registers an invisible proxy box (layer 1) with the picker → { type: 'plot', slot }.
 * - `settings` may be the core/settings controller ({ get(), reduced(), onChange() }) or a plain object.
 * - `tier` may be a gfx/tiers Quality object ({ tier, critters, outlines, shadows, … }) or a tier name.
 *
 * The field draws views only. Effects reach plots through fx/executor.js (field.plot(slot).play(effect)).
 */

import { Vector3 } from '../three.js';
import { propMaterial, outlineMaterial } from '../gfx/materials.js';
import { createBatches } from './batch.js';
import { createTags } from './tags.js';
import { createPlot } from './plot.js';
import { gridPosition, PLOT } from './growth.js';
import { clearCropCache, setFruitMinWorld, FRUIT_MIN_PX } from '../crops/builders.js';
import {
  boxGeometry,
  outlineGeometry,
  soilGeometry,
  moundGeometry,
  cracksGeometry,
  scarsGeometry,
  kitGeometry,
  thermoBoardGeometry,
  signGeometry,
  sackGeometry,
  thermoGlassGeometry,
  thermoFillGeometry,
  thermoBulbGeometry,
  thermoHazardGeometry,
  dangerRingGeometry,
  parasolGeometry,
  basketGeometry,
  pennantGeometry,
  aframeGeometry,
  fogGeometry,
  sachetGeometry,
  liqSignGeometry,
  stumpGeometry,
  glowRingGeometry,
  seedSignGeometry,
  trowelGeometry,
  valveGeometry,
  birdGeometry,
  moleGeometry,
  moleHatGeometry,
  molehillGeometry,
  LAYOUT,
  LAYOUT_HEX,
} from './props.js';

const MIN_SLOTS = 10;
const MAX_SLOTS = PLOT.maxSlots;

/** Normalise a tier argument (Quality object or name) to the knobs the field reads. */
function qualityOf(tier) {
  if (tier && typeof tier === 'object') {
    return { tier: tier.tier || tier.name || 'high', critters: tier.critters !== false, outlines: tier.outlines || (tier.tier === 'high' ? 'hover' : 'selected'), shadows: tier.shadows ?? 'soft' };
  }
  const name = typeof tier === 'string' ? tier : 'high';
  return { tier: name, critters: name !== 'low', outlines: name === 'high' ? 'hover' : 'selected', shadows: name === 'low' ? 'off' : 'soft' };
}

/**
 * Settings the field uses, whatever shape `settings` has: the core/settings controller ({ get(), reduced() }),
 * a plain snapshot (stage.js passes one and then calls setSettings / setReduced on changes), or nothing.
 */
function settingsReader(initial) {
  let snap = initial;
  let reducedOverride = null;
  const read = () => {
    let s = {};
    try {
      s = (typeof snap?.get === 'function' ? snap.get() : snap) || {};
    } catch {
      s = {};
    }
    let reduced = !!s.reduced;
    try {
      if (typeof snap?.reduced === 'function') reduced = !!snap.reduced();
    } catch {
      /* keep the snapshot value */
    }
    if (reducedOverride !== null) reduced = reducedOverride;
    return { palette: s.palette || 'std', labels: s.labels || 'always', farmer: s.farmer !== false, reduced };
  };
  read.setSnapshot = (s) => {
    if (s) snap = s;
  };
  read.setReduced = (b) => {
    reducedOverride = b === null || b === undefined ? null : !!b;
  };
  return read;
}

export function createField({ scene, world = null, picker = null, labels = null, tier = 'high', quality: q0 = null, settings = null, camera = null, container = null } = {}) {
  let quality = qualityOf(q0 || tier);
  const readSettings = settingsReader(settings);
  const B = createBatches(scene, { maxSlots: MAX_SLOTS });
  const tags = createTags({ labels, container, camera });

  /**
   * Fruit legibility (PLATFORM QA-05): the smallest legible fruit in world units at the field's distance, from the
   * camera's vertical FOV and the canvas height: FRUIT_MIN_PX ÷ (pixels per unit). Crops scale a smaller fruit up.
   */
  let lastFruitKey = '';
  function updateFruitScale() {
    if (!camera || !camera.isPerspectiveCamera) return;
    const h = container?.clientHeight || globalThis.innerHeight || 0;
    const depth = camera.position.length();
    if (!(h > 0) || !(depth > 0)) return;
    const key = `${h}|${depth.toFixed(1)}|${camera.fov}|${camera.zoom}`;
    if (key === lastFruitKey) return;
    lastFruitKey = key;
    const pxPerU = h / 2 / (Math.tan((camera.fov * Math.PI) / 360) * depth) * (camera.zoom || 1);
    setFruitMinWorld(FRUIT_MIN_PX / pxPerU);
  }

  // ---- shared batches (one draw call each, only while something is visible)
  const toonVC = propMaterial({ vertexColors: true, toon: true });
  const lambertVC = propMaterial({ vertexColors: true });
  const basicVC = propMaterial({ vertexColors: true, basic: true, toon: false });
  // a faint unlit sheen only: a 0.38 lit glass over the fill turned amber into pale peach (the 3D risk cue, J7)
  const glass = propMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0.12, depthWrite: false, basic: true, toon: false });
  const fogMat = propMaterial({ vertexColors: true, transparent: true, opacity: 0.62, depthWrite: false });
  const glowMat = propMaterial({ basic: true, color: 0xffe7a0, transparent: true, opacity: 0.92, depthWrite: false, toon: false });
  const outline = outlineMaterial();
  const casters = quality.shadows !== 'off';
  const def = (name, geometry, material, o = {}) => B.define(name, { geometry, material, ...o });
  for (const f of ['standard', 'hyper', 'degen', 'swarm']) def('box_' + f, boxGeometry(f), toonVC, { castShadow: casters, receiveShadow: true, colors: true });
  // the furrow grid decimates below High, and small props cast shadows on High only (PLATFORM QA-07 budgets)
  const soilN = quality.tier === 'low' ? 8 : quality.tier === 'medium' ? 12 : 20;
  const smallCasters = casters && quality.tier === 'high';
  def('soil_square', soilGeometry(false, { n: soilN }), lambertVC, { receiveShadow: true, colors: true });
  def('soil_hex', soilGeometry(true, { n: soilN }), lambertVC, { receiveShadow: true, colors: true });
  def('outline_square', outlineGeometry(false), outline);
  def('outline_hex', outlineGeometry(true), outline);
  def('mound', moundGeometry(), lambertVC, { receiveShadow: true, colors: true });
  def('cracks', cracksGeometry(), toonVC, { colors: true });
  def('scars', scarsGeometry(), toonVC, { colors: true });
  def('kit', kitGeometry(LAYOUT), toonVC, { castShadow: casters, receiveShadow: true });
  // TESTNET plots: the checkered pennant on the ×N stake (PLATFORM §9.4)
  def('pennant', pennantGeometry(LAYOUT), toonVC, { castShadow: casters });
  def('pennantHex', pennantGeometry(LAYOUT_HEX), toonVC, { castShadow: casters });
  def('kitHex', kitGeometry(LAYOUT_HEX), toonVC, { castShadow: casters, receiveShadow: true });
  def('thermoBoard', thermoBoardGeometry(LAYOUT), toonVC, { castShadow: casters });
  def('thermoBoardHex', thermoBoardGeometry(LAYOUT_HEX), toonVC, { castShadow: casters });
  def('sign', signGeometry(), toonVC, { castShadow: smallCasters, colors: true });
  def('sack', sackGeometry(false), toonVC, { perPlot: 5, castShadow: smallCasters, colors: true });
  def('sackHaz', sackGeometry(true), toonVC, { perPlot: 5, castShadow: smallCasters });
  def('thermoFill', thermoFillGeometry(), basicVC, { colors: true });
  def('thermoBulb', thermoBulbGeometry(), basicVC, { colors: true });
  def('thermoHaz', thermoHazardGeometry(), basicVC);
  def('thermoGlass', thermoGlassGeometry(), glass, { renderOrder: 2 });
  def('ring', dangerRingGeometry(), basicVC);
  def('parasol', parasolGeometry(), toonVC, { castShadow: casters });
  def('basket', basketGeometry({ lo: quality.tier !== 'high' }), toonVC, { castShadow: smallCasters });
  def('aframe', aframeGeometry(), toonVC, { castShadow: casters });
  def('fog', fogGeometry(), fogMat, { perPlot: 3, renderOrder: 3 });
  def('sachet', sachetGeometry(false), toonVC, { castShadow: casters });
  def('bust', sachetGeometry(true), toonVC);
  def('liqSign', liqSignGeometry(), toonVC, { castShadow: casters });
  def('stump', stumpGeometry(), toonVC, { castShadow: casters });
  def('glow', glowRingGeometry(), glowMat, { renderOrder: 1 });
  def('seedSign', seedSignGeometry(), toonVC, { castShadow: casters });
  def('trowel', trowelGeometry(), toonVC, { castShadow: casters });
  def('valve', valveGeometry(), toonVC);
  def('bird', birdGeometry(), toonVC, { castShadow: casters, colors: true });
  def('mole', moleGeometry(), toonVC, { castShadow: casters });
  def('moleHat', moleHatGeometry(), toonVC, { colors: true });
  def('molehill', molehillGeometry(), lambertVC, { receiveShadow: true, colors: true });

  const plots = new Map(); // slot → Plot
  const offs = new Map(); // slot → picker unregister
  let count = 0;
  let sink = null;
  let pick = { on: false, coin: null };
  let hover = null;
  let selected = null;
  let dimExcept = null;
  let halted = false;
  let explicitHalted = null;
  let lastViews = {};

  const plotSettings = () => readSettings();

  function slotPos(i, n) {
    try {
      const p = world?.slotPosition?.(i, n);
      if (p && Number.isFinite(p.x)) return new Vector3(p.x, p.y || 0, p.z);
    } catch {
      /* fall back to the local grid */
    }
    const g = gridPosition(i, n);
    return new Vector3(g.x, g.y, g.z);
  }

  function makePlot(slot) {
    const plot = createPlot({ slot, base: slotPos(slot, count), batches: B, tags, tier: quality, settings: plotSettings, sink });
    scene.add(plot.object3D);
    plot.object3D.updateMatrixWorld(true);
    plots.set(slot, plot);
    if (picker?.register) {
      try {
        const off = picker.register(plot.proxy, { type: 'plot', slot });
        if (typeof off === 'function') offs.set(slot, off);
      } catch {
        /* picking is optional */
      }
    }
    plot.setPick(pick.on, pick.coin);
    plot.setHalted(halted);
    return plot;
  }

  function removePlot(slot) {
    const p = plots.get(slot);
    if (!p) return;
    offs.get(slot)?.();
    offs.delete(slot);
    p.dispose();
    plots.delete(slot);
  }

  function setCount(n) {
    const next = Math.max(MIN_SLOTS, Math.min(MAX_SLOTS, Math.round(Number(n) || MIN_SLOTS)));
    if (next === count) return;
    const prev = count;
    count = next;
    for (let i = 0; i < count; i++) {
      if (!plots.has(i)) makePlot(i);
      else if (prev) plots.get(i).setBase(slotPos(i, count));
    }
    for (const slot of [...plots.keys()]) if (slot >= count) removePlot(slot);
  }

  function applyOutlines() {
    for (const [slot, p] of plots) {
      const kind = slot === selected ? 'selected' : slot === hover && quality.outlines === 'hover' ? 'hover' : null;
      p.setOutline(kind);
    }
  }

  function applyHalted() {
    const anyView = Object.values(lastViews).some((v) => v && v.halted);
    const h = explicitHalted ?? anyView;
    if (h === halted) return;
    halted = !!h;
    for (const p of plots.values()) p.setHalted(halted);
  }

  // follow settings changes (palette, labels, motion, animals)
  let offSettings = null;
  try {
    offSettings = typeof settings?.onChange === 'function' ? settings.onChange(() => api.refresh()) : null;
  } catch {
    offSettings = null;
  }

  const api = {
    /** Draw these views (slot → PlotView) on `count` plots (§2.3: 10–15). Missing slots are empty. */
    sync(views, n = count || MIN_SLOTS) {
      setCount(n);
      lastViews = views || {};
      applyHalted();
      for (let i = 0; i < count; i++) {
        const v = lastViews[i] ?? lastViews[String(i)] ?? null;
        plots.get(i)?.setView(v);
      }
    },
    plot(slot) {
      return plots.get(Number(slot)) || null;
    },
    plots() {
      return [...plots.values()];
    },
    /** Pick mode (§5.5): empty plots glow and show a "plant here" seed sign. */
    setPickMode(on, beanCoin = null) {
      pick = { on: !!on, coin: beanCoin ?? null };
      for (const p of plots.values()) p.setPick(pick.on, pick.coin);
    },
    /** Drag-to-plant (§4.1, P1): the valid empty box under the dragged seed pulses its ring (null clears). */
    setDragOver(slot) {
      const s = slot === null || slot === undefined ? null : Number(slot);
      for (const [i, p] of plots) p.setDragOver(i === s && !p.view && !halted);
    },
    /** Hover outline (fine pointer, High tier only, §7.5). */
    setHover(slot) {
      hover = slot === null || slot === undefined ? null : Number(slot);
      applyOutlines();
    },
    setSelected(slot) {
      selected = slot === null || slot === undefined ? null : Number(slot);
      applyOutlines();
    },
    /** Focus mode (§5.4): every other box dims 15%. */
    setDim(exceptSlot) {
      dimExcept = exceptSlot === null || exceptSlot === undefined ? null : Number(exceptSlot);
      for (const [slot, p] of plots) p.setDim(dimExcept !== null && slot !== dimExcept);
    },
    /** Field burned (live.halted): every box charcoal, empty boxes get a char stump (§3.5). */
    setHalted(on) {
      explicitHalted = on === null || on === undefined ? null : !!on;
      applyHalted();
    },
    /** Quality knobs from gfx/tiers (critters, outlines, shadows). */
    setQuality(q) {
      quality = qualityOf(q);
      B.setShadows(quality.shadows !== 'off');
      for (const p of plots.values()) p.setQuality(quality);
      applyOutlines();
    },
    /** The executor's particle/sound sink for ambient plot life (ripe glints, falling leaves, drips). */
    setFx(s) {
      sink = s || null;
      for (const p of plots.values()) p.setSink(sink);
    },
    /** stage.js: new settings snapshot (palette, labels, farmer & animals). */
    setSettings(s) {
      readSettings.setSnapshot(s);
      api.refresh();
    },
    /** stage.js: effective reduced motion (setting or system). */
    setReduced(b) {
      readSettings.setReduced(b);
      api.refresh();
    },
    /** Settings changed: recompute every look. */
    refresh() {
      for (const p of plots.values()) p.refresh();
    },
    update(dt, t) {
      updateFruitScale();
      for (const p of plots.values()) p.update(dt, t);
      B.flush();
      tags.update();
    },
    /** True while any plot animates (keeps an on-demand loop awake). */
    busy() {
      for (const p of plots.values()) if (p.busy()) return true;
      return false;
    },
    drawCalls() {
      return B.drawCount();
    },
    /** Main-pass triangles of the visible prop instances (debug / budgets). */
    triangles() {
      return B.triangles();
    },
    /** After a WebGL context restore: re-upload instance buffers (geometry/texture caches re-upload lazily). */
    rebuild() {
      B.rebuild();
    },
    dispose() {
      offSettings?.();
      for (const slot of [...plots.keys()]) removePlot(slot);
      tags.clear();
      B.dispose();
      clearCropCache();
    },
    get count() {
      return count;
    },
  };
  return api;
}

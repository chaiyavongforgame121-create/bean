/**
 * world/logic.js — PURE world maths (WP3): no three, no DOM, no side effects at import.
 * Everything here is unit-tested under node --test (test/game-world.test.js); the three-backed modules
 * (world.js, landmarks.js, farmer.js, …) wrap these results in Vector3s and meshes.
 *
 * GAME-DESIGN references: §2.1–2.4 (layout), §4.4–4.5 (weather, wind, windmill, gust, lightning),
 * §4.5 farmer (path graph, BFS, queue ≤ 3, teleport > 18 u).
 */
import { WEATHER } from '../gfx/palette.js';

// ------------------------------------------------------------------ layout (§2.1–2.3)

export const ISLAND = Object.freeze({ radius: 21, rimNoise: 0.6, bottomY: -9 });

export const GRID = Object.freeze({
  pitch: 4.4,
  box: 3.4,
  rim: 0.45,
  cols: 5,
  minSlots: 10,
  maxSlots: 15,
  standDz: 2.3,
  labelY: 2.6,
});

/** Landmark centres (x, z) and facing (yaw radians; 0 = facing +Z/south). §2.2/§2.4. */
export const LANDMARKS = Object.freeze({
  stall: Object.freeze({ x: -16, z: 0, yaw: Math.PI / 2 }), // faces +X
  barn: Object.freeze({ x: 0, z: -13, yaw: 0 }), // faces S
  silo: Object.freeze({ x: 4.5, z: -14, yaw: 0 }),
  crates: Object.freeze({ x: -4.5, z: -10.5, yaw: 0.15 }),
  compost: Object.freeze({ x: 5.5, z: -10.5, yaw: -0.1 }),
  tower: Object.freeze({ x: 13, z: -8, yaw: -0.35 }),
  pond: Object.freeze({ x: 15, z: 3, yaw: 0, r: 3.2, pumpX: 13, pumpZ: 0.5 }),
  windmill: Object.freeze({ x: -12, z: -11, yaw: 0.35 }),
  sundial: Object.freeze({ x: -8, z: -13.5, yaw: 0 }),
  board: Object.freeze({ x: -15, z: 8, yaw: 2.05 }), // faces NE (toward the field)
  mailbox: Object.freeze({ x: -7, z: 12, yaw: 0.25 }),
  firepit: Object.freeze({ x: 8, z: 12.5, yaw: 0 }),
  pip: Object.freeze({ x: -12.5, z: -5, yaw: 0.55 }),
  signpost: Object.freeze({ x: 0, z: 15.5, yaw: 0 }),
});

export const LANDMARK_IDS = Object.freeze(Object.keys(LANDMARKS));

/** Farmer's home spot (§2.2 "farmer home (−3,−10)"). */
export const FARMER_HOME = Object.freeze({ x: -3, z: -10 });

const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
export const clamp01 = (x) => Math.max(0, Math.min(1, num(x)));

/** §2.3 slotCount = clamp(max(10, caps.max_bots, openBots), 10, 15) — kept here for world-side callers. */
export function slotCountOf(maxBots, openBots) {
  return Math.max(GRID.minSlots, Math.min(GRID.maxSlots, Math.max(GRID.minSlots, num(maxBots), num(openBots))));
}

export function rowsOf(count) {
  const c = Math.max(GRID.minSlots, Math.min(GRID.maxSlots, Math.round(num(count, GRID.minSlots))));
  return Math.ceil(c / GRID.cols);
}

/**
 * Slot centre (§2.3): column c = i % 5 at x = −8.8 + 4.4c; row r = floor(i / 5) at z = −(rows − 1)·2.2 + 4.4r.
 * Returns a plain {x, y, z}; i is 0-based (slot 0 = "Plot 01", back-left).
 */
export function slotXZ(i, count) {
  const rows = rowsOf(count);
  const idx = Math.max(0, Math.floor(num(i)));
  const c = idx % GRID.cols;
  const r = Math.floor(idx / GRID.cols);
  return { x: -8.8 + c * GRID.pitch, y: 0, z: -(rows - 1) * (GRID.pitch / 2) + r * GRID.pitch };
}

/** Farmer stand point: (x, 0, z + 2.3). */
export function standXZ(i, count) {
  const p = slotXZ(i, count);
  return { x: p.x, y: 0, z: p.z + GRID.standDz };
}

/** Field bounds (outer box edges) for a slot count. */
export function fieldBounds(count) {
  const rows = rowsOf(count);
  const half = GRID.box / 2;
  const z0 = -(rows - 1) * (GRID.pitch / 2);
  return { x0: -8.8 - half, x1: 8.8 + half, z0: z0 - half, z1: z0 + (rows - 1) * GRID.pitch + half, rows };
}

// ------------------------------------------------------------------ market weather + wind (§4.4, §4.5)

/** Normalise a weather payload ({key, mean} | key | null) to a known key ('mild' when unknown). */
export function weatherKey(w) {
  const k = typeof w === 'string' ? w : w && w.key;
  return WEATHER[k] ? k : 'mild';
}

/** §4.4 cloud count 8/16/26/34. */
export function cloudCount(key) {
  return WEATHER[weatherKey(key)].clouds;
}

/** §4.5 wind levels: mean |change_1h| < 0.3% calm 0.6, < 0.8% breezy 1.0, < 1.5% windy 1.6, else gale 2.4. */
export const WIND_LEVELS = Object.freeze([
  Object.freeze({ key: 'calm', max: 0.003, factor: 0.6 }),
  Object.freeze({ key: 'breezy', max: 0.008, factor: 1.0 }),
  Object.freeze({ key: 'windy', max: 0.015, factor: 1.6 }),
  Object.freeze({ key: 'gale', max: Infinity, factor: 2.4 }),
]);

export function windLevelOf(meanAbs1h) {
  const m = Math.abs(num(meanAbs1h, 0));
  return WIND_LEVELS.find((l) => m < l.max) || WIND_LEVELS[WIND_LEVELS.length - 1];
}

/** Sanitise a windFactor coming from outside: finite, 0..3 (0 = still). */
export function windFactorSafe(f) {
  return Math.max(0, Math.min(3, num(f, 1)));
}

/** §4.5 clouds drift at 0.3 u/s × windFactor. */
export const CLOUD_DRIFT = 0.3;

// ------------------------------------------------------------------ windmill bar clock (§2.4, §4.4, §4.5)

export const WINDMILL = Object.freeze({
  baseRevPerSec: 0.12, // × windFactor
  kickDeg: 20,
  kickMs: 500,
  gustBoost: 2,
  gustMs: 3000,
  timelapseRevPerSec: 1.5,
});

/**
 * Sail angle (radians) = wind spin (accumulated) + bar-progress angle + kick overshoot.
 * `spin` is the integrated wind rotation, `progress` the share of the current bar (0..1).
 * Under reduced motion the caller passes spin = 0 so the sails read the bar progress only.
 */
export function windmillAngle(spin, progress, kick = 0) {
  return num(spin) + clamp01(progress) * Math.PI * 2 + num(kick);
}

/** Integrate wind spin for dt seconds (rad). */
export function windmillSpinStep(dtSec, windFactor, boost = 1) {
  return Math.PI * 2 * WINDMILL.baseRevPerSec * windFactorSafe(windFactor) * Math.max(0, num(boost, 1)) * Math.max(0, num(dtSec));
}

/**
 * Tick kick (§4.4 "+20° overshoot, 500 ms, easeOutBack"): an extra forward angle that snaps up to ≈ +20°
 * with an easeOutBack attack, then settles back to 0 so the bar-progress reading takes over again.
 * t01 = elapsed / 500 ms. Returns radians; exactly 0 at t ≤ 0 and t ≥ 1.
 */
export function kickProfile(t01) {
  const t = num(t01, 1);
  if (t <= 0 || t >= 1) return 0;
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const a = Math.min(1, t / 0.35); // attack phase
  const back = 1 + c3 * Math.pow(a - 1, 3) + c1 * Math.pow(a - 1, 2); // 0 → ≈1.1 → 1
  const release = t <= 0.35 ? 1 : 1 - (t - 0.35) / 0.65; // linear settle to 0
  const ease = release * release * (3 - 2 * release);
  return ((WINDMILL.kickDeg * Math.PI) / 180) * (back / 1.1) * ease;
}

// ------------------------------------------------------------------ money levels (§2.4 data mappings)

/**
 * Normalise setMoney() input to safe fills and counts.
 * towerFill = deployed/account_value, pondFill = available/account_usd, siloFill = account_value/(2·account_usd)
 * are computed by the caller; the world only clamps. Crates/compost draw at most 8 steps.
 */
export function moneyLevels(m = {}) {
  const cnt = (x) => Math.max(0, Math.floor(num(x && typeof x === 'object' ? x.n : x)));
  return {
    towerFill: clamp01(m.towerFill),
    pondFill: clamp01(m.pondFill),
    siloFill: clamp01(m.siloFill),
    crates: Math.min(8, cnt(m.crates)),
    compost: Math.min(8, cnt(m.compost)),
    cratesN: cnt(m.crates),
    compostN: cnt(m.compost),
  };
}

/** Helper for integrators: compute the three fills from a live_status-like object (§2.4 formulas). */
export function fillsFromLive(live) {
  if (!live) return { towerFill: 0, pondFill: 0, siloFill: 0 };
  const a = live.account_state || live;
  const value = num(a.account_value ?? live.account_value);
  const start = num(live.account_usd ?? a.account_usd);
  const avail = num(a.available_usd ?? live.available_usd);
  const deployed = num(a.deployed_usd ?? live.deployed_usd);
  return {
    towerFill: value > 0 ? clamp01(deployed / value) : 0,
    pondFill: start > 0 ? clamp01(avail / start) : 0,
    siloFill: start > 0 ? clamp01(value / (2 * start)) : 0,
  };
}

/** Crate stack slots (local x, y, z) for n crates, bottom 2×2 then 3 then 1 on top (max 8). */
export function crateLayout(n) {
  const S = 0.95;
  const H = 0.78;
  const spots = [
    [-0.5, 0, -0.5], [0.5, 0, -0.5], [-0.5, 0, 0.5], [0.5, 0, 0.5],
    [-0.5, 1, -0.5], [0.5, 1, -0.5], [0, 1, 0.5],
    [0, 2, 0],
  ];
  return spots.slice(0, Math.max(0, Math.min(8, Math.floor(num(n))))).map(([x, y, z]) => ({ x: x * S, y: y * H, z: z * S }));
}

/** Compost heap vertical scale for n steps (0..8): visible but small when empty-ish. */
export function compostScale(n) {
  const k = Math.max(0, Math.min(8, Math.floor(num(n))));
  return k === 0 ? 0.08 : 0.25 + k * 0.1;
}

// ------------------------------------------------------------------ lightning (§4.4 photosensitivity limits)

export const LIGHTNING = Object.freeze({ minGapMs: 8000, maxGapMs: 19000, flashMs: 120, maxStep: 0.3, thunderMinMs: 1000, thunderMaxMs: 3000 });

/**
 * Lightning scheduler: at most one flash per 8 s, each lasting 120 ms with a luminance step ≤ 30 %.
 * `rand` is a [0,1) generator (inject a seeded one in tests).
 *   const L = lightningScheduler(Math.random); L.poll(nowMs, active) → null | { strength, thunderInMs }
 */
export function lightningScheduler(rand = Math.random) {
  let nextAt = null;
  let lastAt = -Infinity;
  const gap = () => LIGHTNING.minGapMs + rand() * (LIGHTNING.maxGapMs - LIGHTNING.minGapMs);
  return {
    get lastAt() {
      return lastAt;
    },
    reset(nowMs) {
      nextAt = num(nowMs) + 2500 + rand() * 4000;
    },
    poll(nowMs, active) {
      const now = num(nowMs);
      if (!active) {
        nextAt = null;
        return null;
      }
      if (nextAt == null) nextAt = Math.max(now + 2500 + rand() * 4000, lastAt + LIGHTNING.minGapMs);
      if (now < nextAt || now - lastAt < LIGHTNING.minGapMs) return null;
      lastAt = now;
      nextAt = now + gap();
      return {
        strength: LIGHTNING.maxStep * (0.55 + 0.45 * rand()),
        thunderInMs: LIGHTNING.thunderMinMs + rand() * (LIGHTNING.thunderMaxMs - LIGHTNING.thunderMinMs),
      };
    },
  };
}

/** Flash envelope for t ms since the flash (0..1 multiplier of the strength; 0 after 120 ms). */
export function flashEnvelope(tMs) {
  const t = num(tMs, Infinity);
  if (t < 0 || t > LIGHTNING.flashMs) return 0;
  // a quick double flicker inside the 120 ms window, never above 1
  return t < 40 ? 1 : t < 70 ? 0.45 : t < 95 ? 0.85 : 1 - (t - 95) / 25;
}

// ------------------------------------------------------------------ gust (§4.4)

export const GUST = Object.freeze({ ms: 1200, fromX: -30, toX: 30, cooldownMs: 20000 });

/** Gust wave-front x (world units) for ms since the gust started; −1000 when inactive. */
export function gustFront(msSince) {
  const t = num(msSince, Infinity);
  if (t < 0 || t > GUST.ms) return -1000;
  return GUST.fromX + (GUST.toX - GUST.fromX) * (t / GUST.ms);
}

// ------------------------------------------------------------------ farmer path graph + BFS (§4.5)

/** Ring offset from the field (u). */
export const RING_OFFSET = 1.6;

/**
 * Build the farmer's path graph for a slot count: a ring 1.6 u around the field, one stand point per plot
 * (chained along each row's aisle), the four column gaps between boxes (so the north ring reaches every aisle),
 * the barn door, stall, pond, fire pit, mailbox and home. 38 nodes for 10 slots, 49 for 15.
 * Returns { nodes: Map<id, {id, x, z}>, adj: Map<id, Set<id>> }.
 */
export function buildPathGraph(count) {
  const n = Math.max(GRID.minSlots, Math.min(GRID.maxSlots, Math.round(num(count, 10))));
  const rows = rowsOf(n);
  const b = fieldBounds(n);
  const rx0 = b.x0 - RING_OFFSET;
  const rx1 = b.x1 + RING_OFFSET;
  const rz0 = b.z0 - RING_OFFSET;
  const rz1 = b.z1 + RING_OFFSET;
  const nodes = new Map();
  const adj = new Map();
  const add = (id, x, z) => {
    nodes.set(id, { id, x, z });
    adj.set(id, adj.get(id) || new Set());
  };
  const link = (a, c) => {
    if (!nodes.has(a) || !nodes.has(c) || a === c) return;
    adj.get(a).add(c);
    adj.get(c).add(a);
  };
  // ring corners + north/south midpoints
  add('ring:nw', rx0, rz0);
  add('ring:n', 0, rz0);
  add('ring:ne', rx1, rz0);
  add('ring:sw', rx0, rz1);
  add('ring:s', 0, rz1);
  add('ring:se', rx1, rz1);
  link('ring:nw', 'ring:n');
  link('ring:n', 'ring:ne');
  link('ring:sw', 'ring:s');
  link('ring:s', 'ring:se');
  // west/east ring nodes at each aisle z (stand-point rows), chained north → south
  const west = ['ring:nw'];
  const east = ['ring:ne'];
  for (let r = 0; r < rows; r++) {
    const z = slotXZ(r * GRID.cols, n).z + GRID.standDz;
    const wz = Math.min(z, rz1 - 0.01);
    add(`ring:w${r}`, rx0, wz);
    add(`ring:e${r}`, rx1, wz);
    west.push(`ring:w${r}`);
    east.push(`ring:e${r}`);
  }
  west.push('ring:sw');
  east.push('ring:se');
  for (let i = 0; i < west.length - 1; i++) {
    link(west[i], west[i + 1]);
    link(east[i], east[i + 1]);
  }
  // stand points per plot, chained along the aisle
  for (let i = 0; i < n; i++) {
    const s = standXZ(i, n);
    add(`plot:${i}`, s.x, s.z);
  }
  for (let r = 0; r < rows; r++) {
    const ids = [];
    for (let c = 0; c < GRID.cols; c++) {
      const i = r * GRID.cols + c;
      if (i < n) ids.push(`plot:${i}`);
    }
    for (let k = 0; k < ids.length - 1; k++) link(ids[k], ids[k + 1]);
    if (ids.length) {
      link(`ring:w${r}`, ids[0]);
      link(`ring:e${r}`, ids[ids.length - 1]);
    }
    // the last row's aisle is south of the field: let it reach the south ring too
    if (r === rows - 1 && ids.length >= 3) link(ids[2], 'ring:s');
  }
  // column gaps (1 u between boxes): the north ring reaches every aisle without walking round the field
  for (let g = 0; g < GRID.cols - 1; g++) {
    const gx = -8.8 + g * GRID.pitch + GRID.pitch / 2;
    add(`gap:${g}:n`, gx, rz0);
    link(`gap:${g}:n`, gx < 0 ? 'ring:nw' : 'ring:ne');
    link(`gap:${g}:n`, 'ring:n');
    let prev = `gap:${g}:n`;
    for (let r = 0; r < rows; r++) {
      const z = slotXZ(r * GRID.cols, n).z + GRID.standDz;
      const id = `gap:${g}:${r}`;
      add(id, gx, z);
      link(prev, id);
      link(id, `plot:${r * GRID.cols + g}`);
      if (r * GRID.cols + g + 1 < n) link(id, `plot:${r * GRID.cols + g + 1}`);
      prev = id;
    }
  }
  // landmarks
  add('barn', 0, -10.4);
  add('home', FARMER_HOME.x, FARMER_HOME.z);
  add('stall', -14.4, 0.6);
  add('pond', 12.4, 2.6);
  add('firepit', 7.2, 11.0);
  add('mailbox', -6.4, 10.8);
  link('barn', 'ring:n');
  link('barn', 'home');
  link('home', 'ring:n');
  link('stall', 'ring:w0');
  link('pond', `ring:e${Math.max(0, rows - 2)}`);
  link('pond', `ring:e${rows - 1}`);
  link('firepit', 'ring:se');
  link('firepit', 'ring:s');
  link('mailbox', 'ring:sw');
  link('mailbox', 'ring:s');
  return { nodes, adj };
}

/** Breadth-first route between two node ids → [ids…] (inclusive) or null. */
export function bfs(graph, from, to) {
  if (!graph.nodes.has(from) || !graph.nodes.has(to)) return null;
  if (from === to) return [from];
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of graph.adj.get(cur) || []) {
      if (prev.has(nb)) continue;
      prev.set(nb, cur);
      if (nb === to) {
        const path = [to];
        let p = cur;
        while (p != null) {
          path.push(p);
          p = prev.get(p);
        }
        return path.reverse();
      }
      queue.push(nb);
    }
  }
  return null;
}

/** Nearest graph node to (x, z). */
export function nearestNode(graph, x, z) {
  let best = null;
  let bd = Infinity;
  for (const nd of graph.nodes.values()) {
    const d = (nd.x - x) ** 2 + (nd.z - z) ** 2;
    if (d < bd) {
      bd = d;
      best = nd.id;
    }
  }
  return best;
}

/** Polyline length of a node route. */
export function routeLength(graph, ids) {
  let L = 0;
  for (let i = 1; i < (ids || []).length; i++) {
    const a = graph.nodes.get(ids[i - 1]);
    const c = graph.nodes.get(ids[i]);
    L += Math.hypot(c.x - a.x, c.z - a.z);
  }
  return L;
}

export const FARMER = Object.freeze({
  speed: 4, // u/s
  walkHz: 2.2,
  queueMax: 3,
  teleportDist: 18,
  poseMinMs: 600,
  poseMaxMs: 1000,
  idleMinMs: 8000,
  idleMaxMs: 15000,
});

/** Map an effect/tool name to a farmer pose (§4.5 "plant → dig, water → can, …"). */
export const FARMER_POSES = Object.freeze({
  dig: 'dig', plant: 'dig', pending: 'dig', plantOk: 'dig',
  water: 'water', can: 'water',
  harvest: 'sickle', sickle: 'sickle',
  pull: 'hoe', hoe: 'hoe',
  shade: 'parasol', parasol: 'parasol', resume: 'parasol',
  burn: 'torch', torch: 'torch', burnStart: 'torch', burnPlot: 'torch',
  idle: 'idle', look: 'idle',
});

export function poseOf(name) {
  return FARMER_POSES[name] || 'idle';
}

/**
 * Farmer task admission (§4.5): returns 'queue' when the task can be walked to, or 'teleport' when the
 * queue is already full or the straight-line distance exceeds 18 u.
 */
export function admitTask(queueLength, distance) {
  if (num(queueLength) >= FARMER.queueMax) return 'teleport';
  if (num(distance) > FARMER.teleportDist) return 'teleport';
  return 'queue';
}

/** Walk-cycle phase helpers (2.2 Hz). Returns limb swing in radians for time t (s). */
export function walkSwing(tSec, amp = 0.55) {
  return Math.sin(num(tSec) * Math.PI * 2 * FARMER.walkHz) * amp;
}

// ------------------------------------------------------------------ day/night (§6.9 "Sky")

/** Local hour of the day (0..24) for a timestamp; `offsetMin` lets tests pin the timezone. */
export function hourOf(timeMs, offsetMin = null) {
  const t = num(timeMs, Date.now());
  const off = offsetMin == null ? -new Date(t).getTimezoneOffset() : num(offsetMin);
  const minutes = (((t / 60000 + off) % 1440) + 1440) % 1440;
  return minutes / 60;
}

/** Sun direction (unit, y up) for an elevation (deg) and azimuth (deg; 0 = from the south, +90 = from the west). */
export function sunDir(elevationDeg, azimuthDeg) {
  const el = (num(elevationDeg) * Math.PI) / 180;
  const az = (num(azimuthDeg) * Math.PI) / 180;
  return { x: -Math.sin(az) * Math.cos(el), y: Math.sin(el), z: Math.cos(az) * Math.cos(el) };
}

/** Sun azimuth over the day: east in the morning → south at noon → west in the evening. */
export function sunAzimuthAt(hour) {
  const h = num(hour, 10.5);
  return ((h - 12) / 6) * 75; // −75° (east) at 6:00 … +75° (west) at 18:00
}

// ------------------------------------------------------------------ easings (§4 "oB, iOC, oC, iOS")

export const EASE = Object.freeze({
  linear: (t) => clamp01(t),
  oC: (t) => 1 - Math.pow(1 - clamp01(t), 3),
  iOC: (t) => {
    const x = clamp01(t);
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  },
  iOS: (t) => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2,
  oB: (t) => {
    const x = clamp01(t);
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  },
});

/** Pop-in scale (§4.6 landmarks "0 → 1.1 → 1"): rises to 1.1 at 60 % then settles to 1. */
export function popScale(t01) {
  const t = clamp01(t01);
  if (t >= 1) return 1;
  return t < 0.6 ? 1.1 * EASE.oC(t / 0.6) : 1.1 - 0.1 * EASE.iOS((t - 0.6) / 0.4);
}

// ------------------------------------------------------------------ quality tiers (§7.5, world side)

/** What the world draws per tier (§7.5). The renderer (WP2) owns DPR, MSAA and the shadow-map type. */
export const WORLD_TIERS = Object.freeze({
  high: Object.freeze({ name: 'high', grass: 900, shadows: 'soft', shadowMap: 2048, critters: true, rain: 1400, flowers: 105 }),
  medium: Object.freeze({ name: 'medium', grass: 500, shadows: 'pcf', shadowMap: 1024, critters: true, rain: 800, flowers: 70 }),
  low: Object.freeze({ name: 'low', grass: 200, shadows: 'none', shadowMap: 0, critters: false, rain: 300, flowers: 40 }),
});

/**
 * Normalise whatever the platform passes as `tier` ('high' | {name|tier|key, grass?, shadows?, critters?, …})
 * into the world's tier record. Unknown names fall back to 'high'.
 */
export function tierOf(tier) {
  const name = typeof tier === 'string' ? tier : tier && (tier.name || tier.tier || tier.key || tier.level);
  const base = WORLD_TIERS[name] || WORLD_TIERS.high;
  if (!tier || typeof tier !== 'object') return { ...base };
  const out = { ...base };
  if (Number.isFinite(Number(tier.grass))) out.grass = Math.max(0, Math.floor(Number(tier.grass)));
  if (tier.shadows === false || tier.shadows === 'none' || tier.shadows === 'off') out.shadows = 'none';
  else if (tier.shadows === 'pcf' || tier.shadows === 'soft') out.shadows = tier.shadows;
  if (typeof tier.critters === 'boolean') out.critters = tier.critters;
  if (typeof tier.farmer === 'boolean') out.farmer = tier.farmer;
  if (Number(tier.shadowSize) > 0) out.shadowMap = Number(tier.shadowSize);
  return out;
}

// ------------------------------------------------------------------ irrigation pipes (§2.4 tower, §3.2 drip pipe)

/** Water tower ground point (the riser) and the pump outlet. */
export const PIPE = Object.freeze({ towerX: 13, towerZ: -8, pumpX: 13.25, pumpZ: 0.5, y: 0.16, spoutY: 0.45 });

/** Where each box's drip valve sits relative to the slot centre (WP4 field/props.js LAYOUT.valve, back-right rim). */
export const VALVE_OFFSET = Object.freeze({ x: 1.62, z: -1.62 });

/**
 * Irrigation layout for a slot count (pure): an inlet (pump → tower), a main line (tower → the north manifold),
 * one header per extra row (down the east side, then west along the gap north of that row) and one tap-off
 * point per slot under its box's drip valve (back-right rim, VALVE_OFFSET).
 * → { inlet: [[x,y,z]…], main: [[x,y,z]…], rows: [[[x,y,z]…]…], spouts: [{slot, x, z, pipeZ}] }
 */
export function pipeLayout(count) {
  const n = Math.max(GRID.minSlots, Math.min(GRID.maxSlots, Math.round(num(count, 10))));
  const b = fieldBounds(n);
  const y = PIPE.y;
  const rowZ = (r) => (r === 0 ? b.z0 - 0.55 : slotXZ(r * GRID.cols, n).z - GRID.box / 2 - 0.5);
  const eastX = b.x1 + 0.5;
  const westX = b.x0 + 0.3;
  const inlet = [[PIPE.pumpX, y, PIPE.pumpZ], [PIPE.pumpX + 0.15, y, -2.5], [PIPE.towerX + 0.2, y, PIPE.towerZ + 1.6], [PIPE.towerX, y, PIPE.towerZ]];
  const main = [[PIPE.towerX, y, PIPE.towerZ], [PIPE.towerX - 0.6, y, PIPE.towerZ + 1.4], [eastX + 0.2, y, rowZ(0) - 0.3], [eastX, y, rowZ(0)], [westX, y, rowZ(0)]];
  const rows = [];
  for (let r = 1; r < b.rows; r++) rows.push([[eastX, y, rowZ(0)], [eastX, y, rowZ(r)], [westX, y, rowZ(r)]]);
  const spouts = [];
  for (let i = 0; i < n; i++) {
    const p = slotXZ(i, n);
    const r = Math.floor(i / GRID.cols);
    spouts.push({ slot: i, x: p.x + VALVE_OFFSET.x, z: p.z + VALVE_OFFSET.z, pipeZ: rowZ(r) });
  }
  return { inlet, main, rows, spouts, count: n };
}

/** Polyline the water travels from the tower to a slot's spout (for the flow effect). */
export function pipeRouteTo(slot, count) {
  const L = pipeLayout(count);
  const s = L.spouts[Math.max(0, Math.min(L.spouts.length - 1, Math.floor(num(slot))))];
  const r = Math.floor(s.slot / GRID.cols);
  const route = L.main.slice(0, 4).map((p) => p.slice());
  if (r > 0) route.push([L.rows[r - 1][1][0], PIPE.y, L.rows[r - 1][1][2]]);
  route.push([s.x, PIPE.y, s.pipeZ], [s.x, PIPE.spoutY, s.pipeZ], [s.x, PIPE.spoutY, s.z]);
  return route;
}

// ------------------------------------------------------------------ a tiny value tween (world-internal; pure)

/**
 * One animated number: `tw.set(to, durSec, ease)` starts a tween from the current value; `tw.step(dt)` advances
 * it and returns true while it is running. durSec ≤ 0 (or reduced motion) jumps straight to the target.
 */
export class Tween {
  constructor(v = 0) {
    this.v = v;
    this.from = v;
    this.to = v;
    this.t = 1;
    this.dur = 0.6;
    this.ease = EASE.iOS;
  }

  set(to, dur = 0.6, ease = EASE.iOS) {
    const target = num(to, this.to);
    if (!(dur > 0)) {
      this.v = this.from = this.to = target;
      this.t = 1;
      return this;
    }
    if (target === this.to && this.t < 1) return this;
    if (target === this.v && this.t >= 1) {
      this.to = target;
      return this;
    }
    this.from = this.v;
    this.to = target;
    this.t = 0;
    this.dur = dur;
    this.ease = ease || EASE.iOS;
    return this;
  }

  step(dt) {
    if (this.t >= 1) return false;
    this.t = Math.min(1, this.t + Math.max(0, num(dt)) / this.dur);
    this.v = this.from + (this.to - this.from) * this.ease(this.t);
    return true;
  }

  get busy() {
    return this.t < 1;
  }
}

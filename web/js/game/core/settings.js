/**
 * core/settings.js — persisted player settings + reduced-motion resolution (GAME-DESIGN §6.9, §7.3).
 *
 *   loadSettings({ storage, coarse })     → Settings (defaults when storage is missing, blocked or corrupt)
 *   saveSettings(settings, { storage })   → true when written (never throws)
 *   isReduced(settings, systemReduced)    → effective reduced motion
 *   createSettings({ store, bus, storage, matchMedia, coarse })
 *        → { get(), set(patch), reduced(), onChange(fn), dispose() }
 *          keeps store.settings + store.ui.reduced in sync, persists every change, follows the
 *          `prefers-reduced-motion` media query live, and emits bus 'settings' {settings, reduced, changed}.
 *          The settings panel (WP5) may call set(patch) or write store.settings directly: both persist.
 *
 * Storage key: localStorage["bean.game.settings.v1"]. Every read/write is in try/catch (§6.9).
 * Pure module (no side effects at import); browser globals are only touched when called.
 */

export const SETTINGS_KEY = 'bean.game.settings.v1';

/** Allowed values per setting; the first is NOT necessarily the default (see defaultSettings). */
export const SETTING_VALUES = Object.freeze({
  sound: [false, true],
  ambience: [true, false],
  chime: [true, false],
  graphics: ['auto', 'high', 'medium', 'low'],
  motion: ['system', 'full', 'reduced'],
  sky: ['day', 'clock'],
  labels: ['always', 'hover', 'off'],
  palette: ['std', 'cb'],
  shortcuts: [true, false],
  farmer: [true, false],
  drift: [false, true],
  // PLATFORM §9.4 (P1): which ledger the HUD chips and the barn / pond / tower show (accounts mode, testnet on)
  ledger: ['paper', 'testnet'],
});

/**
 * Defaults (§6.9, bold values). Labels default to "always" on desktop and "hover & selected" on phones
 * (`coarse` = coarse primary pointer).
 */
export function defaultSettings({ coarse = false } = {}) {
  return {
    sound: false,
    volume: 0.6,
    ambience: true,
    chime: true,
    graphics: 'auto',
    motion: 'system',
    sky: 'day',
    labels: coarse ? 'hover' : 'always',
    palette: 'std',
    shortcuts: true,
    farmer: true,
    drift: false,
    ledger: 'paper',
  };
}

/** Keep only known keys with allowed values; anything else falls back to the default. */
export function normalizeSettings(raw, defaults = defaultSettings()) {
  const out = { ...defaults };
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, allowed] of Object.entries(SETTING_VALUES)) {
    if (k in raw && allowed.includes(raw[k])) out[k] = raw[k];
  }
  const vol = Number(raw.volume);
  if (raw.volume !== undefined && raw.volume !== null && raw.volume !== '' && Number.isFinite(vol)) out.volume = Math.min(1, Math.max(0, vol));
  return out;
}

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // some browsers throw on the localStorage getter itself when storage is blocked
  }
}

/** Read settings; any storage failure (missing, blocked, throwing, corrupt JSON) → defaults. */
export function loadSettings({ storage, coarse = false } = {}) {
  const defaults = defaultSettings({ coarse });
  try {
    const ls = storageOf(storage);
    const raw = ls ? ls.getItem(SETTINGS_KEY) : null;
    return raw ? normalizeSettings(JSON.parse(raw), defaults) : defaults;
  } catch {
    return defaults;
  }
}

/** Write settings; → false when storage is unavailable (the page keeps working for this visit). */
export function saveSettings(settings, { storage } = {}) {
  try {
    const ls = storageOf(storage);
    if (!ls) return false;
    ls.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

/** Effective reduced motion: the setting, or "follow system" + the media query. */
export function isReduced(settings, systemReduced = false) {
  const m = settings?.motion ?? 'system';
  if (m === 'reduced') return true;
  if (m === 'full') return false;
  return !!systemReduced;
}

/** Is the primary pointer coarse (phones/tablets)? false outside a browser. */
export function coarsePointer(matchMedia = globalThis.matchMedia) {
  try {
    return typeof matchMedia === 'function' ? !!matchMedia('(pointer: coarse)').matches : false;
  } catch {
    return false;
  }
}

/**
 * Live settings controller bound to the store (see the header). Returns the controller; the initial
 * settings are written to store.settings / store.ui.reduced immediately.
 */
export function createSettings({ store, bus = null, storage, matchMedia = globalThis.matchMedia, coarse } = {}) {
  const isCoarse = coarse ?? coarsePointer(matchMedia);
  let mq = null;
  try {
    mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  } catch {
    mq = null;
  }
  const systemReduced = () => !!mq?.matches;
  const listeners = new Set();
  let current = loadSettings({ storage, coarse: isCoarse });
  let reduced = isReduced(current, systemReduced());
  let writing = false;

  function publish(changed) {
    reduced = isReduced(current, systemReduced());
    writing = true;
    try {
      store?.set((s) => ({ settings: current, ui: { ...s.ui, reduced } }));
    } finally {
      writing = false;
    }
    const payload = { settings: current, reduced, changed };
    for (const fn of [...listeners]) {
      try {
        fn(payload);
      } catch (e) {
        (globalThis.console?.error || (() => {}))(e);
      }
    }
    bus?.emit('settings', payload);
  }

  function set(patch) {
    const next = normalizeSettings({ ...current, ...(patch || {}) }, defaultSettings({ coarse: isCoarse }));
    const changed = Object.keys(next).filter((k) => next[k] !== current[k]);
    current = next;
    saveSettings(current, { storage });
    publish(changed);
    return current;
  }

  // Someone (the settings panel) wrote store.settings directly: adopt + persist it.
  const offStore = store?.select(
    (s) => s.settings,
    (next) => {
      if (writing || !next || next === current) return;
      set(next);
    },
  );

  const onMq = () => publish(['motion']);
  try {
    mq?.addEventListener?.('change', onMq);
  } catch {
    /* old Safari: no live update */
  }

  publish([]);

  return {
    get: () => current,
    set,
    reduced: () => reduced,
    coarse: isCoarse,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      offStore?.();
      try {
        mq?.removeEventListener?.('change', onMq);
      } catch {
        /* ignore */
      }
      listeners.clear();
    },
  };
}

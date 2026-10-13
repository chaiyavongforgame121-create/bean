/**
 * ui/context.js — the one shared object every ui/* module receives.
 *
 * WP2's main.js may either call `mountUi(deps)` once (ui/index.js) or call each module's
 * `mount(deps)` itself (§9.6: `mount({store, bus, data, sfx?})`). Both paths land here: the context is a
 * singleton per store, so modules mounted separately still find each other (late binding through `ctx`).
 *
 *   ctx = { store, bus, data, sfx, settingsApi, api,      // injected deps (api = brood-api module, optional)
 *           stage,                                        // set by setStage() or bus 'stage:ready' (null until 3D runs)
 *           mods: { hud, badge, … },                      // each module's returned API
 *           onStage(fn) → off }                           // fn(stage) now (if ready) and whenever it changes
 *
 * No three.js, no side effects at import.
 */

const contexts = new WeakMap();

export function getCtx(deps = {}) {
  const key = deps.store || deps;
  let ctx = contexts.get(key);
  if (!ctx) {
    ctx = createCtx(deps);
    contexts.set(key, ctx);
  } else {
    // later mounts may bring deps the first one lacked (e.g. sfx created after the HUD)
    for (const k of ['data', 'sfx', 'settingsApi', 'api']) if (deps[k] && !ctx[k]) ctx[k] = deps[k];
    if (deps.settings && !ctx.settingsApi && typeof deps.settings.set === 'function') ctx.settingsApi = deps.settings;
  }
  return ctx;
}

function createCtx(deps) {
  const stageFns = new Set();
  const ctx = {
    store: deps.store,
    bus: deps.bus,
    data: deps.data || null,
    sfx: deps.sfx || null,
    // WP2's core/settings.js object, when main passes one ({ get, set }); otherwise ui/settings.js
    // writes store.settings itself and emits bus 'settings'.
    settingsApi: deps.settings && typeof deps.settings.set === 'function' ? deps.settings : null,
    api: deps.api || null,
    stage: null,
    mods: {},
    mounted: new Set(),
    setStage(stage) {
      ctx.stage = stage || null;
      for (const fn of stageFns) {
        try {
          fn(ctx.stage);
        } catch (e) {
          console.error('[ui] stage hook failed', e);
        }
      }
    },
    onStage(fn) {
      stageFns.add(fn);
      if (ctx.stage) {
        try {
          fn(ctx.stage);
        } catch (e) {
          console.error('[ui] stage hook failed', e);
        }
      }
      return () => stageFns.delete(fn);
    },
    /** True once per (ctx, module name): guards double mounts. */
    claim(name) {
      if (ctx.mounted.has(name)) return false;
      ctx.mounted.add(name);
      return true;
    },
  };
  // The stage can also arrive over the bus (main.js may prefer that to calling setStage()).
  ctx.bus?.on?.('stage:ready', (stage) => ctx.setStage(stage));
  return ctx;
}

/** Safe bus emit (the bus is required, but a half-built page must not crash on it). */
export function emit(ctx, type, payload) {
  try {
    ctx.bus?.emit?.(type, payload);
  } catch (e) {
    console.error('[ui] bus emit failed', type, e);
  }
}

/** Safe bus subscription → off(). */
export function on(ctx, type, fn) {
  const off = ctx.bus?.on?.(type, (payload) => {
    try {
      fn(payload);
    } catch (e) {
      console.error('[ui] handler failed', type, e);
    }
  });
  return typeof off === 'function' ? off : () => {};
}

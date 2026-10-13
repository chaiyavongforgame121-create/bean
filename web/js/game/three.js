/**
 * game/three.js — the ONE place the 3D page imports three.js from (GAME-DESIGN §9.8).
 *
 * three is served by the backend at /vendor/three/* (node_modules/three, pinned 0.169.0). There is no import
 * map and no `examples/jsm` addon: addons import the bare specifier 'three', which would need an inline import
 * map and therefore a CSP hash. Every three-using module (gfx/*, world/*, field/*, crops/builders.js,
 * fx/executor.js, fx/particles.js, fx/coins.js) imports from this file, and is loaded only through stage.js.
 *
 * The minified build matches index.html's <link rel="modulepreload">. For debugging, swap in
 * '/vendor/three/build/three.module.js' (served too) — a one-line edit here.
 *
 * Node (`node --test`) cannot resolve this absolute path, which is why core/*, fx/director.js, model.js,
 * crops/catalog.js and ui/* must never import it.
 */
export * from '/vendor/three/build/three.module.min.js';

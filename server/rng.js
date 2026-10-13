// server/rng.js — seeded, serialisable PRNG plus small helpers for deterministic state.
//
// Generator: sfc32 (Small Fast Counting, 128-bit state) seeded through splitmix32. It is fast,
// passes PractRand to large sizes and — the property we care about — its whole state is four
// uint32 words, so `state()` / `setState()` give exact save/restore. `normal()` uses Box–Muller
// and caches the second deviate; the cached spare is part of the state too.

const TWO_POW_32 = 4294967296;
const TWO_PI = 2 * Math.PI;

/** splitmix32 step: a good 32-bit integer mixer, used for seeding and deriving sub-seeds. */
function mix32(x) {
  let z = (x + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

/**
 * Derive an independent uint32 seed for a named sub-stream (e.g. market vs population), so that
 * changing one consumer's draw pattern never shifts another consumer's numbers.
 * @param {number} seed base seed (any number; truncated to uint32)
 * @param {number|string} salt stream label
 */
export function deriveSeed(seed, salt) {
  let h = mix32(seed >>> 0);
  const s = String(salt);
  for (let i = 0; i < s.length; i++) h = mix32(h ^ s.charCodeAt(i));
  return h;
}

/**
 * Make a seeded generator.
 * @param {number} seed uint32 seed (other numbers are truncated with >>> 0)
 * @returns {{next():number, normal():number, range(lo:number,hi:number):number, int(lo:number,hi:number):number,
 *            pick(arr:any[]):any, nextU32():number, state():object, setState(s:object):void}}
 */
export function makeRng(seed = 0) {
  // Seed the four words through splitmix32 so that nearby seeds give unrelated streams.
  let sm = seed >>> 0;
  const seedWord = () => { sm = (sm + 0x9e3779b9) >>> 0; return mix32(sm); };
  let a = seedWord(), b = seedWord(), c = seedWord(), d = seedWord();
  let spare = null; // cached second Box–Muller deviate

  /** Raw 32-bit output (sfc32). */
  function nextU32() {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  }

  // Discard a few outputs so the first draws are well mixed.
  for (let i = 0; i < 12; i++) nextU32();

  /** Uniform in [0, 1). */
  const next = () => nextU32() / TWO_POW_32;

  /** Standard normal N(0, 1) via Box–Muller (pairs; second value cached). */
  function normal() {
    if (spare !== null) { const v = spare; spare = null; return v; }
    const u1 = (nextU32() + 1) / (TWO_POW_32 + 1); // (0, 1] — never log(0)
    const u2 = nextU32() / TWO_POW_32;
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(TWO_PI * u2);
    return r * Math.cos(TWO_PI * u2);
  }

  return {
    next,
    nextU32,
    normal,
    /** Uniform real in [lo, hi). */
    range: (lo, hi) => lo + (hi - lo) * next(),
    /** Uniform integer in [lo, hi] (inclusive). */
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    /** Uniform element of a non-empty array. */
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** JSON-safe snapshot of the full generator state. */
    state: () => ({ a: a >>> 0, b: b >>> 0, c: c >>> 0, d: d >>> 0, spare }),
    /** Restore a snapshot produced by state(). */
    setState(s) {
      if (!s || typeof s !== 'object') throw new TypeError('rng.setState: state object expected');
      a = s.a | 0; b = s.b | 0; c = s.c | 0; d = s.d | 0;
      spare = typeof s.spare === 'number' ? s.spare : null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Typed-array <-> base64 helpers. Engine state is mostly typed arrays; base64 of their raw bytes
// is compact in JSON and round-trips bit-exactly (doubles included). Little-endian hosts only,
// which is every platform Node ships on today.

/** Encode a typed array's bytes as base64. */
export function typedToB64(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
}

/**
 * Decode base64 produced by typedToB64 into a fresh typed array of the given constructor.
 * @param {string} b64
 * @param {Function} Ctor e.g. Float64Array
 * @param {number} [length] expected element count (validated when given)
 */
export function b64ToTyped(b64, Ctor, length) {
  const buf = Buffer.from(String(b64 ?? ''), 'base64');
  if (buf.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) throw new Error(`state: bad ${Ctor.name} payload`);
  const out = new Ctor(buf.byteLength / Ctor.BYTES_PER_ELEMENT);
  new Uint8Array(out.buffer).set(buf); // copy → properly aligned, independent of Buffer's pool
  if (length !== undefined && out.length !== length) {
    throw new Error(`state: ${Ctor.name} length ${out.length}, expected ${length}`);
  }
  return out;
}

/**
 * audio/sfx.js — procedural WebAudio sound effects and ambience (WP3; GAME-DESIGN §8).
 *
 *   createSfx({ settings }) → {
 *     enable(on),                 must be called from a user gesture the first time (creates the AudioContext)
 *     setVolume(v), setAmbience(on), setChime(on),
 *     play(name, { pitch?, count?, gain?, variant? }),
 *     setWeather(key), setWind(factor), setNight(isNight), duck(on), dispose()
 *   }
 *
 * Rules (§8):
 * - Default OFF. Nothing is created until enable(true) runs inside a user gesture. If the persisted setting says
 *   "sound on", the first pointer/key gesture on the page enables it (browsers forbid starting audio earlier).
 * - Graph: voices → bus (ui −18 dB | events −16 dB | ambience −24 dB) → DynamicsCompressor → make-up (+18 dB)
 *   → master (−14 dB × volume). The bus and master values are the spec's relative mix; the fixed make-up stage
 *   (an implementation detail) brings a single event voice to ≈ −16 dBFS at full volume instead of ≈ −34 dBFS.
 * - Muting fades the master over 80 ms. The context suspends while the document is hidden.
 * - Dialogs duck the ambience bus by 6 dB. At most 12 voices; the oldest ambience voice is stolen first.
 * - `plip` is throttled to 1 per 150 ms and the chime to 1 per bar.
 * - Tone rule: audio confirms an event without judging it. No "fail" stingers; nothing is louder than the coin
 *   blips; a loss (`rustle` + `thud`) is neutral, never a sad trombone (J4).
 *
 * Pure at import (no window/document access until called). `AudioContext` and `doc` can be injected (tests).
 */

const DB = (db) => Math.pow(10, db / 20);
export const BUS_DB = Object.freeze({ ui: -18, events: -16, ambience: -24, master: -14, duck: -6, makeup: 18 });
export const MAX_VOICES = 12;
export const THROTTLE_MS = Object.freeze({ plip: 150, chime: 1500, tock: 300, glint: 400, sigh: 800, tickTick: 800 });

/** Pentatonic C5 D5 E5 G5 A5 C6 (§8 `pop`, `coinBlips`, `chime`). */
export const PENTA = Object.freeze([523.25, 587.33, 659.25, 783.99, 880.0, 1046.5]);

/** Which bus each sound plays on. Unknown names are ignored (play() returns false). */
export const SOUNDS = Object.freeze({
  // ui
  paperRustle: 'ui', paperFlop: 'ui', tick: 'ui',
  // events
  thup: 'events', pop: 'events', burble: 'events', plip: 'events', tock: 'events', chime: 'events',
  coinBlips: 'events', rustle: 'events', thud: 'events', fwump: 'events', twoNoteUp: 'events', knock: 'events',
  hail: 'events', whoosh: 'events', crackle: 'events', glint: 'events', sigh: 'events', tickTick: 'events',
  mutedBell: 'events', whirr: 'events',
  // ambience (one-shots; the wind and rain beds are continuous)
  thunder: 'ambience', birds: 'ambience', crickets: 'ambience',
});

/** Rain bed gain by weather (§8: 0 / 0 / 0.25 / 0.45). */
export const RAIN_GAIN = Object.freeze({ sunny: 0, mild: 0, rainy: 0.25, storm: 0.45 });

function readSettings(settings) {
  try {
    return (typeof settings?.get === 'function' ? settings.get() : settings) || {};
  } catch {
    return {};
  }
}

export function createSfx({ settings = null, AudioContext: AC = null, doc = globalThis.document, now = () => Date.now() } = {}) {
  const s0 = readSettings(settings);
  let wanted = !!s0.sound; // persisted preference (still needs a gesture to start)
  let on = false;
  let volume = Number.isFinite(Number(s0.volume)) ? Math.max(0, Math.min(1, Number(s0.volume))) : 0.6;
  let ambienceOn = s0.ambience !== false;
  let chimeOn = s0.chime !== false;
  let weather = 'sunny';
  let wind = 1;
  let night = false;
  let ducked = false;
  let ctx = null;
  let master = null;
  let comp = null;
  let makeup = null;
  const bus = {};
  let noise = null; // { white, pink, brown } AudioBuffers
  let beds = null; // { wind: {src, filter, gain, lfo}, rain: {src, gain} }
  const voices = []; // { bus, t0, end, stop() }
  const last = {}; // name → ms (throttles)
  let chimeIdx = 0;
  let ambTimer = null;
  let gestureArmed = false;
  let visBound = false;
  let disposed = false;

  // ---------------------------------------------------------------- context + graph

  function getAC() {
    if (AC) return AC;
    return globalThis.AudioContext || globalThis.webkitAudioContext || null;
  }

  function makeNoise(kind, seconds = 2) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, lastB = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w * 0.5;
      else if (kind === 'pink') {
        // Paul Kellet's refined pink filter
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else {
        lastB = (lastB + 0.02 * w) / 1.02;
        d[i] = lastB * 3.5;
      }
    }
    return buf;
  }

  function build() {
    const C = getAC();
    if (!C) return false;
    try {
      ctx = new C();
    } catch {
      ctx = null;
      return false;
    }
    master = ctx.createGain();
    master.gain.value = 0;
    comp = ctx.createDynamicsCompressor();
    try {
      comp.threshold.value = -18;
      comp.knee.value = 12;
      comp.ratio.value = 3;
      comp.attack.value = 0.005;
      comp.release.value = 0.2;
    } catch {
      /* fake contexts may not expose AudioParams */
    }
    makeup = ctx.createGain();
    makeup.gain.value = DB(BUS_DB.makeup);
    comp.connect(makeup);
    makeup.connect(master);
    master.connect(ctx.destination);
    for (const name of ['ui', 'events', 'ambience']) {
      bus[name] = ctx.createGain();
      bus[name].gain.value = DB(BUS_DB[name]);
      bus[name].connect(comp);
    }
    noise = { white: makeNoise('white'), pink: makeNoise('pink', 4), brown: makeNoise('brown', 3) };
    return true;
  }

  const masterTarget = () => (on ? DB(BUS_DB.master) * volume : 0);

  function rampMaster(sec = 0.08) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const g = master.gain;
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(masterTarget(), t + sec);
    } catch {
      g.value = masterTarget();
    }
  }

  /** resume/suspend/close return promises that may reject (autoplay policy, offline contexts): never let them escape. */
  function ctxCall(name) {
    try {
      const p = ctx?.[name]?.();
      p?.catch?.(() => {});
    } catch {
      /* not allowed right now: the next gesture retries */
    }
  }

  function onVisibility() {
    if (!ctx) return;
    if (doc?.hidden) ctxCall('suspend');
    else if (on) ctxCall('resume');
  }

  function armGesture() {
    if (gestureArmed || !doc?.addEventListener) return;
    gestureArmed = true;
    const fire = () => {
      doc.removeEventListener('pointerdown', fire, true);
      doc.removeEventListener('keydown', fire, true);
      gestureArmed = false;
      if (wanted && !disposed && (!on || ctx?.state === 'suspended')) api.enable(true);
    };
    doc.addEventListener('pointerdown', fire, true);
    doc.addEventListener('keydown', fire, true);
  }

  // ---------------------------------------------------------------- voices

  function voice(busName, dur) {
    // steal: oldest ambience voice first, else the oldest voice
    while (voices.length >= MAX_VOICES) {
      let i = voices.findIndex((v) => v.bus === 'ambience');
      if (i < 0) i = 0;
      const v = voices.splice(i, 1)[0];
      try {
        v.stop();
      } catch {
        /* already stopped */
      }
    }
    const out = ctx.createGain();
    out.connect(bus[busName]);
    const t0 = ctx.currentTime;
    const nodes = [];
    const v = {
      bus: busName,
      t0,
      end: t0 + dur,
      out,
      add(n) {
        nodes.push(n);
        return n;
      },
      stop() {
        for (const n of nodes) {
          try {
            n.stop?.();
          } catch {
            /* not started */
          }
        }
        try {
          out.disconnect();
        } catch {
          /* ignore */
        }
      },
    };
    voices.push(v);
    return v;
  }

  function reap() {
    if (!ctx) return;
    const t = ctx.currentTime;
    for (let i = voices.length - 1; i >= 0; i--) {
      if (voices[i].end < t - 0.05) {
        try {
          voices[i].out.disconnect();
        } catch {
          /* ignore */
        }
        voices.splice(i, 1);
      }
    }
  }

  /** An oscillator with a frequency glide and an exponential-ish envelope. */
  function tone(v, { type = 'sine', f0, f1 = f0, at = 0, dur, gain = 0.5, attack = 0.005, glide = 'exp' }) {
    const t = ctx.currentTime + at;
    const o = v.add(ctx.createOscillator());
    o.type = type;
    const g = ctx.createGain();
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) {
      if (glide === 'exp') o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      else o.frequency.linearRampToValueAtTime(f1, t + dur);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(v.out);
    o.start(t);
    o.stop(t + dur + 0.02);
    return o;
  }

  /** A noise burst through a filter, with an envelope. */
  function burst(v, { kind = 'white', at = 0, dur, gain = 0.5, filter = 'bandpass', f0 = 1000, f1 = f0, q = 1, attack = 0.003 }) {
    const t = ctx.currentTime + at;
    const src = v.add(ctx.createBufferSource());
    src.buffer = noise[kind];
    const flt = ctx.createBiquadFilter();
    flt.type = filter;
    flt.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) flt.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
    flt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt);
    flt.connect(g);
    g.connect(v.out);
    const off = Math.random() * 0.5;
    src.start(t, off);
    src.stop(t + dur + 0.02);
    return src;
  }

  // ---------------------------------------------------------------- recipes (§8 table)

  const R = {
    thup(v) {
      tone(v, { f0: 140, f1: 60, dur: 0.12, gain: 0.4 });
      burst(v, { filter: 'lowpass', f0: 800, dur: 0.07, gain: 0.3 });
    },
    pop(v, o) {
      const f = PENTA[Math.max(0, Math.min(PENTA.length - 1, Math.floor(o.pitch ?? 2)))];
      tone(v, { f0: f * 1.15, f1: f * 0.34, dur: 0.12, gain: 0.34 });
    },
    burble(v) {
      const n = 6 + Math.floor(Math.random() * 5);
      for (let i = 0; i < n; i++) tone(v, { f0: 600 + Math.random() * 600, f1: 500 + Math.random() * 500, at: (i / n) * 0.6, dur: 0.04, gain: 0.3 });
    },
    plip(v, o) {
      const close = o.variant === 'close';
      const [a, b] = close ? [600, 900] : [1200, 600];
      tone(v, { f0: a, f1: b, dur: 0.08, gain: 0.45 });
      tone(v, { type: 'triangle', f0: a * 2, f1: b * 2, dur: 0.08, gain: 0.45 * DB(-12) });
    },
    tock(v) {
      burst(v, { filter: 'bandpass', f0: 1800, q: 4, dur: 0.02, gain: 1.6 });
    },
    chime(v, o) {
      const f = PENTA[(o.pitch != null ? Math.floor(o.pitch) : chimeIdx++) % PENTA.length];
      tone(v, { f0: f, dur: 0.8, gain: 0.35, attack: 0.004 });
      tone(v, { f0: f * 2.01, dur: 0.5, gain: 0.08 });
    },
    coinBlips(v, o) {
      const n = Math.max(1, Math.min(8, Math.floor(o.count ?? 3)));
      for (let i = 0; i < n; i++) tone(v, { type: 'triangle', f0: PENTA[i % PENTA.length] * (i >= PENTA.length ? 2 : 1), at: i * 0.05, dur: 0.09, gain: 0.5 });
    },
    rustle(v) {
      burst(v, { filter: 'bandpass', f0: 2000, q: 1.2, dur: 0.3, gain: 0.8, attack: 0.04 });
    },
    thud(v) {
      tone(v, { f0: 90, f1: 70, dur: 0.2, gain: 0.42 });
    },
    fwump(v) {
      burst(v, { kind: 'pink', filter: 'lowpass', f0: 500, f1: 180, dur: 0.2, gain: 0.6, attack: 0.02 });
    },
    twoNoteUp(v) {
      tone(v, { f0: 392.0, dur: 0.12, gain: 0.4 });
      tone(v, { f0: 523.25, at: 0.12, dur: 0.14, gain: 0.4 });
    },
    knock(v) {
      burst(v, { filter: 'bandpass', f0: 900, q: 3, dur: 0.03, gain: 3 });
      burst(v, { filter: 'bandpass', f0: 900, q: 3, at: 0.12, dur: 0.03, gain: 2.6 });
    },
    hail(v) {
      for (let i = 0; i < 40; i++) burst(v, { filter: 'highpass', f0: 3000 + Math.random() * 3000, at: Math.random() * 1.5, dur: 0.015, gain: 0.18 + Math.random() * 0.12 });
      tone(v, { f0: 80, f1: 60, at: 1.45, dur: 0.2, gain: 0.45 });
    },
    whoosh(v) {
      burst(v, { kind: 'pink', filter: 'bandpass', f0: 300, f1: 3000, q: 0.8, dur: 0.4, gain: 1.0, attack: 0.12 });
    },
    crackle(v) {
      burst(v, { kind: 'pink', filter: 'lowpass', f0: 600, dur: 3, gain: 0.25, attack: 0.3 });
      for (let i = 0; i < 26; i++) burst(v, { filter: 'bandpass', f0: 1500 + Math.random() * 2500, q: 2, at: Math.random() * 2.8, dur: 0.012, gain: 0.15 + Math.random() * 0.3 });
    },
    paperRustle(v) {
      burst(v, { filter: 'bandpass', f0: 3000, q: 1.5, dur: 0.15, gain: 1.2, attack: 0.02 });
    },
    paperFlop(v) {
      burst(v, { filter: 'bandpass', f0: 3200, f1: 900, q: 1.5, dur: 0.25, gain: 1.2, attack: 0.02 });
    },
    tick(v) {
      burst(v, { filter: 'bandpass', f0: 1500, q: 5, dur: 0.015, gain: 3 });
    },
    glint(v) {
      for (let i = 0; i < 3; i++) tone(v, { f0: 2400 * (1 + i * 0.12), at: i * 0.07, dur: 0.06, gain: 0.24 });
    },
    sigh(v) {
      // two soft triangle notes E4 → C4: an acknowledgement, not a "fail" sound
      tone(v, { type: 'triangle', f0: 329.63, dur: 0.3, gain: 0.22, attack: 0.04 });
      tone(v, { type: 'triangle', f0: 261.63, at: 0.26, dur: 0.4, gain: 0.2, attack: 0.04 });
    },
    tickTick(v) {
      burst(v, { filter: 'bandpass', f0: 1000, q: 6, dur: 0.02, gain: 3 });
      burst(v, { filter: 'bandpass', f0: 1000, q: 6, at: 0.14, dur: 0.02, gain: 3 });
    },
    mutedBell(v) {
      for (const [m, g] of [[1, 0.3], [2.76, 0.12], [5.4, 0.06]]) tone(v, { f0: 220 * m, dur: 1.2, gain: g, attack: 0.006 });
    },
    whirr(v) {
      const t = ctx.currentTime;
      const o = v.add(ctx.createOscillator());
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(200, t);
      o.frequency.exponentialRampToValueAtTime(800, t + 1.6);
      o.frequency.exponentialRampToValueAtTime(400, t + 2);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.2);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2);
      o.connect(f);
      f.connect(g);
      g.connect(v.out);
      o.start(t);
      o.stop(t + 2.05);
    },
    thunder(v) {
      burst(v, { kind: 'brown', filter: 'lowpass', f0: 200, dur: 3, gain: 0.9, attack: 0.08 });
    },
    birds(v) {
      const base = 2500 + Math.random() * 1500;
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const t = ctx.currentTime + i * (0.1 + Math.random() * 0.08);
        const o = v.add(ctx.createOscillator());
        const fm = v.add(ctx.createOscillator());
        const fmG = ctx.createGain();
        const g = ctx.createGain();
        fm.frequency.value = 25 + Math.random() * 30;
        fmG.gain.value = 180;
        fm.connect(fmG);
        fmG.connect(o.frequency);
        o.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.2), t);
        o.frequency.exponentialRampToValueAtTime(base * (1.1 + Math.random() * 0.25), t + 0.08);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.25, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
        o.connect(g);
        g.connect(v.out);
        o.start(t);
        fm.start(t);
        o.stop(t + 0.12);
        fm.stop(t + 0.12);
      }
    },
    crickets(v) {
      const dur = 0.6 + Math.random() * 0.5;
      const pulses = Math.floor(dur * 12);
      for (let i = 0; i < pulses; i++) burst(v, { filter: 'bandpass', f0: 4500, q: 12, at: i / 12, dur: 0.04, gain: 2 });
    },
  };

  const DURS = { thup: 0.15, pop: 0.15, burble: 0.7, plip: 0.1, tock: 0.05, chime: 0.85, coinBlips: 0.5, rustle: 0.35, thud: 0.25, fwump: 0.25, twoNoteUp: 0.3, knock: 0.2, hail: 1.7, whoosh: 0.45, crackle: 3.1, paperRustle: 0.2, paperFlop: 0.3, tick: 0.05, glint: 0.3, sigh: 0.7, tickTick: 0.2, mutedBell: 1.25, whirr: 2.1, thunder: 3.1, birds: 0.6, crickets: 1.2 };

  // ---------------------------------------------------------------- ambience beds + scheduler

  function startBeds() {
    if (!ctx || beds) return;
    // wind bed: pink noise → lowpass 400 Hz, LFO 0.07 Hz ±150 Hz on the cutoff; gain × windFactor / 2.4
    const wSrc = ctx.createBufferSource();
    wSrc.buffer = noise.pink;
    wSrc.loop = true;
    const wFlt = ctx.createBiquadFilter();
    wFlt.type = 'lowpass';
    wFlt.frequency.value = 400;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 150;
    lfo.connect(lfoG);
    lfoG.connect(wFlt.frequency);
    const wG = ctx.createGain();
    wG.gain.value = 0;
    wSrc.connect(wFlt);
    wFlt.connect(wG);
    wG.connect(bus.ambience);
    // rain bed: white noise → highpass 1 kHz
    const rSrc = ctx.createBufferSource();
    rSrc.buffer = noise.white;
    rSrc.loop = true;
    const rFlt = ctx.createBiquadFilter();
    rFlt.type = 'highpass';
    rFlt.frequency.value = 1000;
    const rG = ctx.createGain();
    rG.gain.value = 0;
    rSrc.connect(rFlt);
    rFlt.connect(rG);
    rG.connect(bus.ambience);
    wSrc.start();
    lfo.start();
    rSrc.start();
    beds = { wSrc, lfo, wG, rSrc, rG };
    applyBeds();
  }

  function stopBeds() {
    if (!beds) return;
    for (const n of [beds.wSrc, beds.lfo, beds.rSrc]) {
      try {
        n.stop();
      } catch {
        /* ignore */
      }
    }
    try {
      beds.wG.disconnect();
      beds.rG.disconnect();
    } catch {
      /* ignore */
    }
    beds = null;
  }

  function setParam(p, v, sec = 1.5) {
    const t = ctx.currentTime;
    try {
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(v, t + sec);
    } catch {
      p.value = v;
    }
  }

  function applyBeds() {
    if (!beds || !ctx) return;
    const amb = ambienceOn ? 1 : 0;
    setParam(beds.wG.gain, amb * 0.9 * (Math.max(0, Math.min(3, wind)) / 2.4));
    setParam(beds.rG.gain, amb * (RAIN_GAIN[weather] ?? 0));
  }

  function applyDuck() {
    if (!ctx) return;
    setParam(bus.ambience.gain, DB(BUS_DB.ambience + (ducked ? BUS_DB.duck : 0)), 0.25);
  }

  function scheduleAmbience() {
    clearTimeout(ambTimer);
    if (!on || !ambienceOn || disposed) return;
    // birds by day (3–9 s; sparser in rain, none in storms), crickets at clock-night
    const rainK = weather === 'rainy' ? 2.2 : weather === 'storm' ? 0 : 1;
    let wait = 3000 + Math.random() * 6000;
    if (night) wait = 2000 + Math.random() * 3000;
    else if (rainK > 1) wait *= rainK;
    ambTimer = setTimeout(() => {
      if (on && ambienceOn && !doc?.hidden) {
        if (night) api.play('crickets');
        else if (rainK > 0) api.play('birds');
      }
      scheduleAmbience();
    }, wait);
  }

  // ---------------------------------------------------------------- public API

  const api = {
    get enabled() {
      return on;
    },
    get context() {
      return ctx;
    },
    get voiceCount() {
      reap();
      return voices.length;
    },
    enable(v) {
      wanted = !!v;
      if (!v) {
        on = false;
        if (ctx) {
          rampMaster(0.08);
          clearTimeout(ambTimer);
          setTimeout(() => {
            if (!on && ctx && ctx.state !== 'closed') ctxCall('suspend');
          }, 120);
        }
        return false;
      }
      if (!ctx && !build()) return false;
      on = true;
      ctxCall('resume');
      // created outside a gesture (e.g. the persisted setting): the browser keeps it suspended until one happens
      if (ctx.state === 'suspended') armGesture();
      rampMaster(0.08);
      startBeds();
      applyBeds();
      scheduleAmbience();
      if (doc?.addEventListener && !visBound) {
        visBound = true;
        doc.addEventListener('visibilitychange', onVisibility);
      }
      return true;
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, Number(v) || 0));
      rampMaster(0.08);
    },
    setAmbience(v) {
      ambienceOn = !!v;
      applyBeds();
      scheduleAmbience();
    },
    setChime(v) {
      chimeOn = !!v;
    },
    /** → true when a voice was started. */
    play(name, opts = {}) {
      const busName = SOUNDS[name];
      if (!busName || !on || !ctx || disposed) return false;
      if (name === 'chime' && !chimeOn) return false;
      if (busName === 'ambience' && !ambienceOn) return false;
      const t = now();
      const thr = THROTTLE_MS[name];
      if (thr && last[name] != null && t - last[name] < thr) return false;
      last[name] = t;
      reap();
      const v = voice(busName, DURS[name] || 0.5);
      if (opts.gain != null) v.out.gain.value = Math.max(0, Math.min(1, Number(opts.gain)));
      try {
        R[name](v, opts);
      } catch (e) {
        globalThis.console?.warn?.('sfx', name, e);
      }
      return true;
    },
    setWeather(key) {
      weather = RAIN_GAIN[key] != null ? key : 'mild';
      applyBeds();
    },
    setWind(factor) {
      const f = Number(factor && typeof factor === 'object' ? factor.factor : factor);
      wind = Number.isFinite(f) ? f : 1;
      applyBeds();
    },
    setNight(v) {
      const n = !!v;
      if (n === night) return;
      night = n;
      scheduleAmbience();
    },
    duck(v) {
      ducked = !!v;
      applyDuck();
    },
    dispose() {
      disposed = true;
      clearTimeout(ambTimer);
      stopBeds();
      for (const v of voices.splice(0)) v.stop();
      if (visBound) doc?.removeEventListener?.('visibilitychange', onVisibility);
      offSettings?.();
      ctxCall('close');
      ctx = null;
    },
  };

  // follow the settings controller live (feature-detected): sound / volume / ambience / chime
  const offSettings = typeof settings?.onChange === 'function'
    ? settings.onChange(({ settings: s, changed = [] } = {}) => {
      if (!s) return;
      if (changed.includes('volume')) api.setVolume(s.volume);
      if (changed.includes('ambience')) api.setAmbience(s.ambience);
      if (changed.includes('chime')) api.setChime(s.chime);
      if (changed.includes('sound')) {
        // the settings toggle is itself a user gesture: enable right away (a context the browser still holds
        // suspended resumes on the next pointer/key press)
        api.enable(!!s.sound);
      }
    })
    : null;

  if (wanted) armGesture();
  return api;
}

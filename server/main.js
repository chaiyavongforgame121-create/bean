// server/main.js — CLI entry point: configuration, wiring, persistence schedule, signals (SPEC §1, §4; PLATFORM §2).
//
//   node server/main.js [--port 8420] [--host 127.0.0.1] [--token T] [--feed hyperliquid|sim] …
//   node server/main.js --auth accounts --public-origin https://bean.example.com …     (PLATFORM §2.3)
//
// REAL PRICES, PAPER TRADES. The default feed is Hyperliquid's public, read-only market data (no keys, no
// signing, no orders — ever); `--feed sim` runs the synthetic market. Each feed has its own state files, so
// switching never destroys the other garden: sim → data/state.json + journal.jsonl, hyperliquid →
// data/state-real.json + journal-real.jsonl (GAME-DESIGN §10.1).
//
// Startup: parse config → load the feed's state (if compatible and not --fresh) → build journal, engine, live
// layer and pulse → restore (real: replay or re-warm the missed minutes) or warm up → start the bar loop →
// listen → print the URL. A fresh real start that cannot warm up falls back to the sim feed with the sim state
// files (never switching back at runtime: that needs a restart). State is saved every 30 sim ticks / every real
// minute, soon after each bot command, and on SIGINT/SIGTERM.
//
// TWO MODES (PLATFORM §2.3), chosen once here:
//   none (default)   exactly today's single-player server: wire({engine, live, pulse}); nothing below touches SQLite,
//                    the master key or the testnet.
//   accounts         many players: WP1's platform (DB, users, sessions, …), the scoped Journal and Pulse, one Gardens
//                    (a LiveLayer per player, loaded on demand), the optional Hyperliquid TESTNET venue (TESTNET_ENABLED=1,
//                    or the in-process double with --testnet-double), wireAccounts({engine, gardens, pulse}). The JSON
//                    state keeps only the engine and the GLOBAL journal (`live: null`); gardens live in data/bean[-sim].db.
//
// main() installs the process-wide EGRESS GUARD right after parsing the config (pure: no network) and before anything
// else runs (§1.2 rule 7): only POST to the two Hyperliquid /info URLs and the testnet /exchange URL can leave the
// process — plus, when cloud persistence is configured (SUPABASE_URL), GET/POST/DELETE to that one origin's
// /storage/v1/ paths. Tests import the library functions (parseConfig, wire, wireAccounts, startRuntime, …), never
// main(), so their local fetches are unaffected (§2.4 #10).
//
// CLOUD PERSISTENCE (accounts mode on an ephemeral host — Render free, deploy/render/README.md): with SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY, main() checks the PRIVATE bucket and restores the DB, the engine state and the admin
// bootstrap code from it BEFORE the DB is opened and the state is loaded (server/cloudsync.js; a failed download, or a
// DB/state "not found" in a bucket already in use, refuses to start: exit 4), continues the journal seq past the
// previous owner's lease, syncs every CLOUD_SYNC_SECONDS once the server listens, and runs a final sync at shutdown
// after the DB is checkpointed and closed. With cloud persistence a fresh real start that cannot warm up EXITS (1)
// instead of falling back to the sim feed: the fallback would keep the players' accounts in a separate bean-sim.db
// that later real-price boots never restore. Render restarts the process and retries real prices.
//
// Importing this module has no side effects; main() only runs when the file is the entry point.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { Engine, FeedUnavailableError, REAL_TICK_MS } from './engine.js';
import { Journal, GLOBAL_KINDS } from './journal.js';
import { LiveLayer } from './live.js';
import { Pulse } from './pulse.js';
import { saveState, loadState } from './store.js';
import { createServer, packageVersion } from './http.js';
import { MAX_CANDLES } from './hyperliquid.js';
import { PLATFORM_CLI_OPTIONS, applyEnvDefaults, parsePlatformConfig, PlatformConfigError } from './config.js';
import { installEgressGuard } from './hl/egress.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STATE_VERSION = 1;
/** Sim ticks between periodic saves (a real bar is a whole minute: real mode saves every bar). */
const SAVE_EVERY_TICKS = 30;
const SAVE_EVERY_REAL_TICKS = 1;
/** Journal kinds after which the state is saved soon (a crash must not forget a bot). */
const SAVE_SOON_KINDS = new Set(['bot_created', 'bot_paused', 'bot_resumed', 'bot_closed', 'live_halted', 'feed_gap']);
/** Sim tick interval (the real feed ticks once per real minute). */
const DEFAULT_SIM_TICK_MS = 5000;
/** A fast-forward (`tick n=1440`) crosses many 30-tick marks; never save more often than this. */
const MIN_SAVE_INTERVAL_MS = 10_000;
/** Graceful shutdown hard deadline (§10.4; below compose's stop_grace_period and Render's 30 s before SIGKILL). */
const SHUTDOWN_DEADLINE_MS = 25_000;
/** The final cloud sync gets at most this much of what is left of the shutdown deadline. */
const CLOUD_SHUTDOWN_SYNC_MS = 20_000;
/** In-flight testnet requests may finish this long at shutdown (§10.4 step 4). */
const SHUTDOWN_DRAIN_MS = 10_000;

/** Live-layer caps that SPEC §2.6 fixes (the others are CLI options). */
const LIVE_FIXED = { minCapitalUsd: 20, maxTotalNotionalUsd: 10_000, minOrderUsd: 10 };

const USAGE = `Bean Garden — REAL prices, PAPER trades (no real orders, no keys, ever).

Usage: node server/main.js [options]

  --port N              HTTP port (env PORT)                              [8420]
  --host H              interface to bind                                 [127.0.0.1]
  --token T             command token (env BEAN_API_TOKEN): 16+ visible ASCII
                        characters; without one, commands are accepted only
                        from same-origin loopback
  --no-loopback-commands  require the token even from this machine (use this
                        behind any tunnel or port-forward; needs --token)
  --feed hyperliquid|sim  price feed: hyperliquid = REAL prices from the public,
                        read-only Hyperliquid info API (one bar per real
                        minute, marks every ~5 s); sim = synthetic prices  [hyperliquid]
  --seed N              simulation seed (uint32)                          [42]
  --beans N             population size                                   [3000]
  --warmup N            bars of history before serving on a fresh start
                        (hyperliquid: at most 5000 real candles)          [2880]
  --tick-ms N           sim only: real milliseconds per tick (1 tick = 1
                        market minute)                                    [5000]
  --data DIR            state directory, relative to the project root     [./data]
                        (sim: state.json + journal.jsonl; hyperliquid:
                        state-real.json + journal-real.jsonl)
  --fresh               ignore saved state and start over
  --account USD         simulated account size                            [10000]
  --max-bots N          open bots cap                                     [10]
  --max-bot-capital USD capital cap per bot                               [1000]
  --auth none|accounts  none = this single-player local garden (default);
                        accounts = sign-up / sign-in, a garden per player (env BEAN_AUTH)
  --public-origin URL   accounts mode: the public origin, e.g. https://bean.example.com
  --trust-proxy N       accounts mode: proxy hops whose X-Forwarded-For is believed
  --testnet-double      accounts mode, development only: the Hyperliquid TESTNET venue is
                        an in-process double (no network); needs an http://localhost origin
  -h, --help            show this help
`;

class ConfigError extends Error {}

// ---------------------------------------------------------------------------------------------
// Configuration

const CLI_OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  token: { type: 'string' },
  'no-loopback-commands': { type: 'boolean' },
  feed: { type: 'string' },
  seed: { type: 'string' },
  beans: { type: 'string' },
  warmup: { type: 'string' },
  'tick-ms': { type: 'string' },
  data: { type: 'string' },
  fresh: { type: 'boolean' },
  account: { type: 'string' },
  'max-bots': { type: 'string' },
  'max-bot-capital': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

/** Visible ASCII only (no spaces): browsers can only send such a token in a header. */
const TOKEN_RE = /^[\x21-\x7e]+$/;
const TOKEN_MIN_LENGTH = 16;

/**
 * A command token unlocks every command from anywhere, so it must be usable by the garden (a Bearer
 * header: printable ASCII, no whitespace) and not guessable (16+ characters). '' → null (no token).
 */
function checkToken(raw) {
  const token = String(raw).trim();
  if (!token) return null;
  const hint = `make one with: node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`;
  if (!TOKEN_RE.test(token)) {
    throw new ConfigError(`the command token must be visible ASCII without spaces (browsers cannot send anything else in a header) — ${hint}`);
  }
  if (token.length < TOKEN_MIN_LENGTH) {
    throw new ConfigError(`the command token must be at least ${TOKEN_MIN_LENGTH} characters (got ${token.length}) — ${hint}`);
  }
  return token;
}

function intOption(name, raw, min, max) {
  const text = String(raw).trim();
  const n = Number(text);
  if (!/^[+-]?\d+$/.test(text) || !Number.isSafeInteger(n)) throw new ConfigError(`--${name} must be an integer (got "${raw}")`);
  if (n < min || n > max) throw new ConfigError(`--${name} must be between ${min} and ${max} (got ${n})`);
  return n;
}

function numberOption(name, raw, min, max) {
  const text = String(raw).trim();
  const n = Number(text);
  if (text === '' || !Number.isFinite(n)) throw new ConfigError(`--${name} must be a number (got "${raw}")`);
  if (n < min || n > max) throw new ConfigError(`--${name} must be between ${min} and ${max} (got ${n})`);
  return n;
}

/**
 * Parse CLI args + environment into the daemon config. Throws ConfigError (or PlatformConfigError, exit 2) on bad
 * input. The platform options (strict --auth, accounts-only settings, `_FILE` secrets) are parsed FIRST by WP1's
 * config.js; with no --auth/BEAN_AUTH and no accounts-only variable, the result is today's config plus `auth:'none'`.
 * Accounts-mode secrets ride a NON-enumerable `secrets` property (never logged or serialized).
 * @param {string[]} argv  arguments after the script name
 * @param {Record<string, string|undefined>} env
 */
export function parseConfig(argv = process.argv.slice(2), env = process.env) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { ...CLI_OPTIONS, ...PLATFORM_CLI_OPTIONS }, strict: true, allowPositionals: false }));
  } catch (err) {
    throw new ConfigError(err.message);
  }
  const platform = parsePlatformConfig({ values, env });
  values = applyEnvDefaults(values, env, platform.auth);

  const feed = values.feed ?? 'hyperliquid';
  if (feed !== 'sim' && feed !== 'hyperliquid') throw new ConfigError(`--feed must be hyperliquid or sim (got "${feed}")`);
  const real = feed === 'hyperliquid';
  if (real && values['tick-ms'] !== undefined) {
    throw new ConfigError('--tick-ms is only for --feed sim: real prices run at market speed: one bar per real minute');
  }
  const warmupMax = real ? MAX_CANDLES : 1_000_000;
  const warmupBars = intOption('warmup', values.warmup ?? 2880, 0, Number.MAX_SAFE_INTEGER);
  if (warmupBars > warmupMax) {
    throw new ConfigError(`--warmup must be at most ${warmupMax} with --feed hyperliquid (Hyperliquid keeps only the newest ${MAX_CANDLES} candles; got ${warmupBars})`);
  }

  const host = (values.host ?? '127.0.0.1').trim();
  if (!host) throw new ConfigError('--host must not be empty');

  // Accounts mode refused --token / BEAN_API_TOKEN above (parsePlatformConfig); none mode reads them as today.
  const token = platform.auth === 'accounts' ? null : checkToken(values.token ?? env.BEAN_API_TOKEN ?? '');
  const loopbackCommands = platform.auth === 'accounts' ? false : !values['no-loopback-commands'];
  if (platform.auth !== 'accounts' && !loopbackCommands && !token) {
    throw new ConfigError('--no-loopback-commands needs --token (otherwise no command could ever run)');
  }
  const dataArg = values.data ?? './data';

  const out = {
    help: Boolean(values.help),
    port: intOption('port', values.port ?? env.PORT ?? 8420, 0, 65535),
    host,
    token,
    loopbackCommands,
    feed,
    seed: intOption('seed', values.seed ?? 42, 0, 0xffffffff),
    beans: intOption('beans', values.beans ?? 3000, 1, 1_000_000),
    warmupBars,
    tickMs: real ? REAL_TICK_MS : intOption('tick-ms', values['tick-ms'] ?? DEFAULT_SIM_TICK_MS, 50, 86_400_000),
    dataDir: path.resolve(PROJECT_ROOT, dataArg), // relative to the project root, not the cwd
    fresh: Boolean(values.fresh),
    accountUsd: numberOption('account', values.account ?? 10_000, 1, 1e12),
    maxBots: intOption('max-bots', values['max-bots'] ?? 10, 1, 10_000),
    maxBotCapitalUsd: numberOption('max-bot-capital', values['max-bot-capital'] ?? 1000, LIVE_FIXED.minCapitalUsd, 1e12),
    ...platform,
  };
  if (platform.secrets) Object.defineProperty(out, 'secrets', { value: platform.secrets, enumerable: false });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Runtime wiring

/** State and journal file names of a feed (GAME-DESIGN §10.1): sim keeps the legacy names. */
export function stateFiles(dataDir, feed) {
  const suffix = feed === 'sim' ? '' : '-real';
  return {
    stateFile: path.join(dataDir, `state${suffix}.json`),
    journalFile: path.join(dataDir, `journal${suffix}.jsonl`),
  };
}

/**
 * Wire the runtime exactly as the daemon runs it: venue hook, tick hook (mirror), marks hook (live marks +
 * liquidation on the live mid, then the ephemeral `mids` pulse). Tests use the same function. NONE MODE ONLY.
 */
export function wire({ engine, live, pulse = null }) {
  engine.setVenueHook((row) => live.venue(row));
  engine.onTick((summary) => live.afterTick(summary));
  engine.onMarks((marks) => {
    live.markLive(marks);
    if (pulse) pulse.publish('mids', { ...marks, ...live.marksPayload() });
  });
}

/**
 * Accounts-mode wiring (PLATFORM §2.4 #9, §7.5): the engine's hooks drive every OPEN garden; the shared `mids` frame
 * carries only public data (global marks + the testnet mids) and goes through the SCOPED pulse, which throws if a
 * garden key ever slips in. Each subscriber's own garden part is attached by the SSE writer (gardens.marksFor(uid)).
 * Spectators get the engine's default venue verdict; a signed-in player's `beans` pass gardens.venueFor(uid).
 */
export function wireAccounts({ engine, gardens, pulse = null }) {
  if (pulse && pulse.scoped !== true) throw new TypeError('wireAccounts needs the scoped Pulse (new Pulse({scoped: true}))');
  engine.setVenueHook(null);
  engine.onTick((summary) => gardens.afterTick(summary));
  engine.onMarks((marks) => {
    gardens.markLive(marks);
    if (!pulse) return;
    const frame = { ...marks };
    const testnet = gardens.testnetSnapshot();
    if (testnet) frame.testnet = testnet;
    pulse.publish('mids', frame);
  });
}

/**
 * Build journal + engine + live layer + pulse, optionally restoring `saved`. Hooks are attached after the
 * restore so they bind to the restored population. Accounts mode builds the SCOPED journal and pulse and no live
 * layer (gardens are wired later, before the engine starts).
 */
function buildRuntime({ config, version, journalFile, saved, log }) {
  const accounts = config.auth === 'accounts';
  const journal = accounts
    ? new Journal({ file: journalFile, log, scoped: true, globalKinds: GLOBAL_KINDS })
    : new Journal({ file: journalFile, log });
  const pulse = accounts ? new Pulse({ log, scoped: true }) : new Pulse({ log });
  const engine = new Engine({
    config: {
      seed: config.seed,
      beans: config.beans,
      feed: config.feed,
      warmupBars: config.warmupBars,
      tickMs: config.tickMs,
      fallback: config.fallback ?? null,
      fetch: config.fetch, // tests only (never set from the CLI): an offline Hyperliquid double
      version,
      log,
    },
    journal,
  });
  const live = accounts ? null : new LiveLayer({
    config: {
      accountUsd: config.accountUsd,
      maxBots: config.maxBots,
      maxBotCapitalUsd: config.maxBotCapitalUsd,
      ...LIVE_FIXED,
    },
    engine,
    journal,
    log,
  });

  if (saved) {
    journal.restore(saved.journal);
    engine.restore(saved.engine);
    if (live) live.restore(saved.live);
  }

  if (live) wire({ engine, live, pulse });
  return { journal, engine, live, pulse, restored: Boolean(saved) };
}

/** Why a saved state cannot be resumed with this config, or null if it can. */
function incompatibility(saved, config) {
  if (!saved || typeof saved !== 'object') return 'unreadable state';
  if (saved.version !== STATE_VERSION) return `state version ${saved.version} (expected ${STATE_VERSION})`;
  if (saved.seed !== config.seed) return `seed ${saved.seed} (now ${config.seed})`;
  if (saved.beans !== config.beans) return `${saved.beans} beans (now ${config.beans})`;
  if (saved.feed !== config.feed) return `feed ${saved.feed} (now ${config.feed})`;
  // Accounts mode keeps gardens in the DB (`live: null`); none mode needs its garden (§2.4 #8).
  const liveOk = Boolean(saved.live) || config.auth === 'accounts';
  if (!saved.engine || !liveOk || !saved.journal) return 'incomplete state';
  return null;
}

/** Keep one previous generation of a state file we are about to stop using. */
function backupState(stateFile, log) {
  if (!fs.existsSync(stateFile)) return;
  const backup = stateFile.replace(/\.json$/, '.prev.json');
  try {
    fs.copyFileSync(stateFile, backup);
    log(`[state] previous state kept as ${path.relative(PROJECT_ROOT, backup)}`);
  } catch (err) {
    log(`[state] could not back up ${stateFile}: ${err.message}`);
  }
}

/**
 * A fresh start restarts journal seq numbers at 1, so the old jsonl (another seq space) is moved
 * aside to `journal.prev.jsonl` rather than mixed with the new run's records.
 */
function rotateJournal(journalFile, log) {
  if (!fs.existsSync(journalFile)) return;
  const previous = journalFile.replace(/\.jsonl$/, '.prev.jsonl');
  try {
    fs.rmSync(previous, { force: true });
    fs.renameSync(journalFile, previous);
  } catch (err) {
    log(`[state] could not rotate ${journalFile}: ${err.message} — appending to it`);
  }
}

/** Periodic + on-demand state saving. */
function makePersistence({ stateFile, config, runtime, log }) {
  const { engine, live, journal } = runtime;
  const every = config.feed === 'sim' ? SAVE_EVERY_TICKS : SAVE_EVERY_REAL_TICKS;
  let ticksSinceSave = 0;
  let lastSaveMs = 0;
  let scheduled = false;
  let soonTimer = null;

  function snapshot() {
    return {
      version: STATE_VERSION,
      seed: config.seed,
      beans: config.beans,
      feed: config.feed,
      saved_ms: Date.now(),
      engine: engine.serialize(),
      live: live ? live.serialize() : null, // accounts mode: gardens live in the DB (§3.1)
      journal: journal.serialize(),
    };
  }

  /** Save synchronously; never throws. Periodic saves only log when slow. */
  function saveNow(reason) {
    const started = performance.now();
    try {
      const bytes = saveState(stateFile, snapshot());
      ticksSinceSave = 0;
      lastSaveMs = Date.now();
      const ms = performance.now() - started;
      if (reason !== 'periodic' || ms > 500) {
        log(`[state] saved (${reason}): ${(bytes / 1e6).toFixed(1)} MB in ${ms.toFixed(0)} ms`);
      }
      return true;
    } catch (err) {
      log(`[state] save failed (${reason}): ${err.message}`);
      return false;
    }
  }

  /** Called on every tick_completed; saves (outside the tick) once 30 sim ticks / 1 real bar have passed. */
  function onTick() {
    ticksSinceSave++;
    if (scheduled || ticksSinceSave < every) return;
    if (Date.now() - lastSaveMs < MIN_SAVE_INTERVAL_MS) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      saveNow('periodic');
    });
  }

  /** After a bot command (or a gap fill): save soon, at most once per MIN_SAVE_INTERVAL_MS. */
  function soon() {
    if (soonTimer) return;
    const wait = Math.max(0, lastSaveMs + MIN_SAVE_INTERVAL_MS - Date.now());
    soonTimer = setTimeout(() => {
      soonTimer = null;
      saveNow('periodic');
    }, wait);
    soonTimer.unref?.();
  }

  function cancel() {
    if (soonTimer) clearTimeout(soonTimer);
    soonTimer = null;
  }

  return { saveNow, onTick, soon, cancel };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function displayUrl(host, port) {
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return `http://${shown.includes(':') ? `[${shown}]` : shown}:${port}/`;
}

const isLoopbackHost = (host) => host === 'localhost' || host === '::1' || host.startsWith('127.');

/** Startup lines explaining who may run commands (and the tunnel caveat of the loopback rule). */
export function commandPolicyLines({ token, loopbackCommands = true, host = '127.0.0.1' }) {
  const lines = [];
  if (!token) {
    lines.push('commands: no token — only same-origin requests from this machine may run commands');
  } else if (!loopbackCommands) {
    lines.push('commands: token required for every command (--no-loopback-commands)');
  } else {
    lines.push('commands: token set (send it as Authorization: Bearer or X-Brood-Token); same-origin loopback also allowed');
  }
  if (loopbackCommands) {
    lines.push('note: before exposing this port through ANY tunnel or port-forward (ssh -R, socat, ngrok, cloudflared…), ' +
      'set --token and --no-loopback-commands — the loopback rule cannot tell a forwarded connection from a local one');
  }
  if (!isLoopbackHost(host) && !token) {
    lines.push(`note: listening on ${host} without --token — queries are visible to your network, commands stay loopback-only`);
  }
  return lines;
}

/**
 * Load the feed's saved state (unless --fresh / incompatible), build the runtime and start the engine (warm-up,
 * or restore + gap fill). Throws FeedUnavailableError when a FRESH real start cannot warm up (nothing has been
 * journaled or saved yet, so the caller can fall back cleanly).
 * `beforeStart(runtime, config)` (accounts mode) runs after the runtime is built and BEFORE the engine starts, so the
 * gardens are wired when missed bars are replayed; `abort(runtime)` undoes it when the start fails.
 */
export async function startRuntime({ config, version, log = () => {}, beforeStart = null, abort = null }) {
  const files = stateFiles(config.dataDir, config.feed);
  const { stateFile, journalFile } = files;

  // ---- state: resume or start fresh
  let saved = null;
  if (config.fresh) {
    log(`[state] --fresh: ignoring saved ${path.basename(stateFile)}`);
    backupState(stateFile, log);
  } else {
    const loaded = loadState(stateFile, { log });
    if (loaded) {
      const why = incompatibility(loaded, config);
      if (why) {
        log(`[state] saved state does not match this run (${why}) — starting fresh`);
        backupState(stateFile, log);
      } else {
        saved = loaded;
      }
    }
  }

  let runtime;
  try {
    if (!saved) rotateJournal(journalFile, log);
    runtime = buildRuntime({ config, version, journalFile, saved, log });
  } catch (err) {
    if (!saved) throw err;
    log(`[state] could not restore saved state (${err.message}) — starting fresh`);
    backupState(stateFile, log);
    rotateJournal(journalFile, log);
    runtime = buildRuntime({ config, version, journalFile, saved: null, log });
  }

  if (beforeStart) await beforeStart(runtime, config);

  // ---- warm-up (fresh) or resume (+ gap fill with real prices)
  if (!runtime.restored) log(`warming up ${config.warmupBars} bars (${config.feed === 'sim' ? 'synthetic' : 'real Hyperliquid candles'})…`);
  const started = performance.now();
  try {
    await runtime.engine.start();
  } catch (err) {
    if (abort) await abort(runtime);
    throw err;
  }
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  if (runtime.restored) {
    const gap = runtime.engine.status().feed.last_gap;
    const filled = gap && gap.at_ms >= Date.now() - 60_000 ? ` (caught up ${gap.bars} missed minute(s) by ${gap.mode})` : '';
    log(`resumed from ${path.relative(PROJECT_ROOT, stateFile)} at tick ${runtime.engine.health()?.tick ?? '?'} in ${secs} s${filled}`);
  } else {
    log(`warm-up done in ${secs} s`);
  }
  return { runtime, files };
}

/**
 * startRuntime(), falling back to the SIM feed (with the sim state files) when a fresh real start cannot warm up.
 * Never switches back at runtime: mixing sim positions with real prices would be a lie. The badge explains the
 * fallback (status.feed.fallback) and the probe reports when real prices are reachable again; a restart retries.
 * `fallback: false` (cloud persistence) rethrows the FeedUnavailableError instead (main() exits 1).
 * @returns {Promise<{runtime, files, config}>} `config` is the effective one (feed 'sim' + fallback after a fallback)
 */
export async function startWithFallback({ config, version, log = () => {}, beforeStart = null, abort = null, fallback = true }) {
  try {
    const { runtime, files } = await startRuntime({ config, version, log, beforeStart, abort });
    return { runtime, files, config };
  } catch (err) {
    if (!(err instanceof FeedUnavailableError) || config.feed === 'sim' || !fallback) throw err;
    log(`[feed] Hyperliquid unavailable at start (${err.reason}) — falling back to SIMULATED prices; restart to try real prices again`);
    const simConfig = {
      ...config,
      feed: 'sim',
      tickMs: DEFAULT_SIM_TICK_MS,
      fallback: { from: 'hyperliquid', reason: err.reason, since_ms: Date.now() },
      // The testnet venue needs real prices (§6.14 R3): a sim fallback runs paper only.
      testnetEnabled: false,
      testnetDouble: false,
    };
    if (config.secrets) Object.defineProperty(simConfig, 'secrets', { value: config.secrets, enumerable: false });
    const { runtime, files } = await startRuntime({ config: simConfig, version, log, beforeStart, abort });
    return { runtime, files, config: simConfig };
  }
}

// ---------------------------------------------------------------------------------------------
// Accounts mode composition (PLATFORM §2, §7, §10.4, §11.1)

/**
 * Build the accounts-mode platform around a built (not yet started) runtime: WP1's platform bag (DB, migrations,
 * secrets, users, sessions, admin, …), the optional testnet (WP2 createTestnet: the real testnet, or the in-process
 * double under --testnet-double), Credentials, Gardens (+ init: load gardens with open bots, testnet restart steps),
 * and wireAccounts. Throws on a migration/DB error (the caller exits 3/1).
 * @returns {Promise<object>} { platform, gardens, credentials, testnet, double, bag, close }
 */
export async function buildAccounts({ config, runtime, log = () => {}, imports = null }) {
  const { engine, journal, pulse } = runtime;
  const load = imports ?? {
    auth: () => import('./auth/index.js'),
    gardens: () => import('./garden/gardens.js'),
    credentials: () => import('./garden/credentials.js'),
    hl: () => import('./hl/index.js'),
    secrets: () => import('./secrets.js'),
    double: () => import('../test/fixtures/hl-testnet-double.js'),
  };
  const [{ createPlatform }, { Gardens }, { Credentials }, { wipeCredentials }] = await Promise.all([
    load.auth(), load.gardens(), load.credentials(), load.secrets(),
  ]);
  const { stateFile } = stateFiles(config.dataDir, config.feed);
  const platform = await createPlatform({ config, dataDir: config.dataDir, feed: config.feed, stateFile, log });

  // ---- the testnet venue (real feed only, §6.14 R3)
  let testnet = null;
  let lib = null;
  let double = null;
  const wantsTestnet = (config.testnetEnabled || config.testnetDouble) && config.feed === 'hyperliquid';
  if (wantsTestnet) {
    const hl = await load.hl();
    lib = {
      wire: hl, format: hl, errors: hl, constants: hl, signing: hl, addr: hl,
      verify: { parseAgentKey: hl.parseAgentKey, mainnetRecheck: hl.mainnetRecheck },
    };
    let fetchImpl;
    let mainnetClient = engine.hl ?? null;
    if (config.testnetDouble) {
      // Development only (§11.1): the double IS the testnet. Its fetch is injected, so no request reaches any
      // Hyperliquid testnet host; the mainnet userRole guard is answered by the double too.
      let mod;
      try {
        mod = await load.double();
      } catch (err) {
        throw new Error(`--testnet-double needs test/fixtures/hl-testnet-double.js (not in production images): ${err?.code || err?.message}`);
      }
      // idBase: a restarted double must never reuse an oid/tid that the persisted garden DB already holds
      double = mod.makeTestnetDouble({ idBase: Date.now() });
      fetchImpl = double.fetch;
      mainnetClient = double.mainnetInfo;
      log('[testnet] --testnet-double: the Hyperliquid TESTNET venue is an in-process double (development only, no network)');
    }
    testnet = hl.createTestnet({
      fetch: fetchImpl, log, budget: config.testnetBudget ?? 800, mainnetClient,
      coins: engine.market?.coins?.map((c) => c.coin ?? c),
    });
  } else if (config.testnetEnabled || config.testnetDouble) {
    log('[testnet] disabled: the testnet venue needs real prices (the feed is sim)');
  }

  const credentials = new Credentials({
    db: platform.db, secrets: platform.secrets, makeSigner: lib?.signing?.makeSigner ?? null, wipeCredentials, log,
  });
  const gardens = new Gardens({
    engine, journal, db: platform.db, testnet, lib, credentials, admin: platform.admin,
    caps: platform.admin?.getCaps?.() ?? null, mainnetInfo: testnet ? (double?.mainnetInfo ?? engine.hl ?? null) : null, log,
    config: {
      testnetMaxActiveUsers: config.testnetMaxActiveUsers ?? 40,
      inactivityDays: config.inactivityDays ?? 14,
      minOrderUsd: LIVE_FIXED.minOrderUsd,
    },
  });
  if (testnet) await testnet.market.start(); // boot reads (meta, mids, clock), then the polling loops; never throws
  await gardens.init();
  wireAccounts({ engine, gardens, pulse });

  platform.setHooks({
    // Admin disable/halt: burn the field and WAIT for the testnet flattens before any teardown (§4.6 step 7).
    haltGarden: (uid, { reason } = {}) => gardens.haltAndWait(uid, { reason }),
    teardown: (uid) => gardens.teardown(uid, { keepWrites: true }),
    disconnectTestnet: (uid, { reason } = {}) => gardens.testnetDisconnect(uid, { close_bots: true, force: true, actor: 'admin', reason }),
    notifyUser: (uid, kind, data) => journal.emit(kind, data ?? {}, { uid }),
    deleteGarden: (uid, { force } = {}) => gardens.deleteUser(uid, { force }),
    testnetLink: (uid) => credentials.link(uid),
  });

  const bag = {
    db: platform.db,
    secrets: platform.secrets,
    users: platform.users,
    sessions: platform.sessions,
    admin: platform.admin,
    auth: platform.auth,
    guard: platform.guard,
    limiter: platform.limiter,
    clientIp: platform.clientIp,
    streamSlots: platform.streamSlots,
    gardens,
    credentials,
    testnet,
    testnetLink: testnet ? gardens.testnetLinkService() : null,
    backup: () => platform.backups.runNow({ manual: true }),
    backups: platform.backups ?? null, // admin_status.db.last_backup_* (WP4 reads backups.last())
    devDouble: double ? { fault: async (name, args) => double.script(name, args ?? {}) } : null,
    readiness: () => (platform.ready() ? { ok: true } : { ok: false, why: 'db' }),
  };
  return {
    platform, gardens, credentials, testnet, double, bag,
    async close() {
      try {
        await gardens.shutdown({ drainMs: SHUTDOWN_DRAIN_MS });
      } finally {
        await platform.close();
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Cloud persistence (accounts mode, SUPABASE_URL: server/cloudstore.js + server/cloudsync.js)

/** Records the previous instance may have emitted after its last lease renewal (the journal seq floor's margin). */
export const CLOUD_SEQ_MARGIN = 10_000;

/**
 * The Storage client, the private-bucket check and the restore of every missing managed file — BEFORE the DB is
 * opened and the engine state is loaded. Throws (CloudSyncError / CloudStoreError) when the boot must stop.
 * `seqFloor`: the journal continues after it (the previous owner's lease.json seq + CLOUD_SEQ_MARGIN), or null.
 * @returns {Promise<{store, cs, filesFor: (cfg: object) => object, seqFloor: number|null}>}
 */
export async function prepareCloud({ config, log = () => {}, fetch = null }) {
  const [{ createCloudStore }, cs, { BOOTSTRAP_FILE }, { dbFileFor }] = await Promise.all([
    import('./cloudstore.js'), import('./cloudsync.js'), import('./auth/users.js'), import('./db/db.js'),
  ]);
  const store = createCloudStore({
    url: config.cloud.url, key: config.secrets?.cloudKey, bucket: config.cloud.bucket, prefix: config.cloud.prefix, log, fetch,
  });
  const filesFor = (cfg) => cs.cloudFiles({
    dbFile: dbFileFor(cfg.dataDir, cfg.feed),
    stateFile: stateFiles(cfg.dataDir, cfg.feed).stateFile,
    bootstrapFile: path.join(cfg.dataDir, BOOTSTRAP_FILE),
  });
  await store.ensurePrivateBucket();
  const files = { ...filesFor(config) };
  // A configured ADMIN_BOOTSTRAP_CODE wins: never bring an old generated code back.
  if (config.secrets?.bootstrapCode) delete files.bootstrap;
  const restored = await cs.restoreFromCloud({ store, files, allowFresh: config.cloud.allowFresh === true, log });
  const prevSeq = restored.lease?.seq;
  const seqFloor = Number.isSafeInteger(prevSeq) && prevSeq >= 0 ? prevSeq + CLOUD_SEQ_MARGIN : null;
  return { store, cs, filesFor, seqFloor };
}

/** Render: PUBLIC_ORIGIN differs from RENDER_EXTERNAL_URL (readable through the secrets sanitizer: test/cloud.test.js). */
export function publicOriginAlert(publicOrigin, renderUrl) {
  return `[config] ALERT PUBLIC_ORIGIN ${publicOrigin} differs from this Render service URL ${renderUrl}: ` +
    'pages answer 421 until PUBLIC_ORIGIN matches (deploy/render/README.md section 3.4)';
}

/** The log line of the shutdown cloud sync's outcome (readable through the secrets sanitizer: test/cloud.test.js). */
export function cloudShutdownLine(r) {
  if (r?.ok) return `[cloud] final sync done: ${r.uploaded?.length ?? 0} upload(s)`;
  if (r?.timedOut) return '[cloud] ALERT final_sync deadline_hit: the bucket keeps the previous sync (at most 1 interval old)';
  if (r?.skipped === 'lease_standby') return '[cloud] final sync skipped: another instance holds the lease (its data wins)';
  if (r?.skipped) return `[cloud] final sync skipped (${r.skipped})`;
  return `[cloud] ALERT final sync failed: ${r?.error ?? 'unknown error'}`;
}

// ---------------------------------------------------------------------------------------------
// main

export async function main(argv = process.argv.slice(2), env = process.env) {
  let log = (line) => console.log(line);

  let config;
  try {
    config = parseConfig(argv, env); // pure: reads the env (and _FILE secrets), no network
  } catch (err) {
    if (!(err instanceof ConfigError) && !(err instanceof PlatformConfigError)) throw err;
    console.error(`bean-garden: ${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return null;
  }
  // §1.2 rule 7: before anything else runs, only POST to the two /info URLs and the testnet /exchange may leave —
  // and, with cloud persistence, GET/POST/DELETE to SUPABASE_URL's /storage/v1/ (fixed here, never widened later).
  installEgressGuard({ log: (line) => console.error(line), storageOrigin: config.auth === 'accounts' ? config.cloud?.url ?? null : null });
  if (config.help) {
    console.log(USAGE);
    return null;
  }
  const accounts = config.auth === 'accounts';
  if (accounts) {
    // Every line passes the secrets sanitizer (§5.3 rule 4); LOG_FORMAT=json gives one JSON object per line.
    const { makeSafeLogger } = await import('./secrets.js');
    log = makeSafeLogger((line) => console.log(line), { format: config.logFormat ?? 'text' });
  }

  const version = packageVersion();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const mode = config.feed === 'sim' ? 'SIMULATED PRICES · PAPER TRADES' : 'REAL PRICES (Hyperliquid, read-only) · PAPER TRADES';
  log(`bean-garden ${version} — ${mode} · seed ${config.seed} · ${config.beans} beans · ` +
    `${config.feed === 'sim' ? `tick ${config.tickMs} ms` : 'one bar per real minute'} · data ${path.relative(PROJECT_ROOT, config.dataDir) || '.'}` +
    `${accounts ? ` · accounts mode (${config.publicOrigin})` : ''}`);

  // Cloud persistence: restore what the ephemeral disk lost, before the DB is opened and the state is loaded.
  let cloudPrep = null;
  let cloud = null;
  if (accounts && config.cloud) {
    try {
      cloudPrep = await prepareCloud({ config, log });
    } catch (err) {
      const { sanitizeLogLine } = await import('./secrets.js');
      console.error(`bean-garden: ${sanitizeLogLine(err?.message || String(err))}`);
      process.exitCode = err?.exitCode ?? 4;
      return null;
    }
  }

  // Render: PUBLIC_ORIGIN must be the service's URL, or every page but /healthz answers 421 while the deploy stays "Live".
  let renderUrl = '';
  try {
    renderUrl = accounts && env.RENDER_EXTERNAL_URL ? new URL(String(env.RENDER_EXTERNAL_URL).trim()).origin : '';
  } catch {
    renderUrl = '';
  }
  if (renderUrl && renderUrl !== config.publicOrigin) log(publicOriginAlert(config.publicOrigin, renderUrl));

  // Accounts mode: the platform and the gardens exist before the engine starts (missed bars replay into them).
  let acct = null;
  const beforeStart = accounts
    ? async (runtime, cfg) => {
      // Cloud persistence: never reuse a seq the previous instance may have sent (its state can be older).
      if (cloudPrep?.seqFloor) runtime.journal.advanceSeq(cloudPrep.seqFloor);
      acct = await buildAccounts({ config: cfg, runtime, log });
      // admin_status.cloud (read at call time: the sync starts once the server listens)
      acct.bag.adminStatus = () => ({ cloud: cloud ? cloud.status() : { enabled: false } });
    }
    : null;
  const abort = accounts
    ? async () => {
      const a = acct;
      acct = null;
      if (a) await a.close().catch(() => {});
    }
    : null;

  let runtime;
  let files;
  try {
    // Cloud persistence: no sim fallback (its accounts would live in a bean-sim.db that real-price boots never restore).
    ({ runtime, files, config } = await startWithFallback({ config, version, log, beforeStart, abort, fallback: !cloudPrep }));
  } catch (err) {
    if (err?.exitCode) {
      console.error(`bean-garden: ${err.message}`);
      process.exitCode = err.exitCode; // MigrationError: 3 (§3.4)
      return null;
    }
    if (err instanceof FeedUnavailableError && cloudPrep) {
      console.error(`bean-garden: Hyperliquid is unavailable for the first warm-up (${err.reason}). With cloud persistence there is ` +
        'no simulated-price fallback (its accounts would live in a separate bean-sim.db); exiting so the host restarts and retries');
      process.exitCode = 1;
      return null;
    }
    throw err;
  }
  const { engine, live, journal, pulse } = runtime;
  const { stateFile } = files;
  const persistence = makePersistence({ stateFile, config, runtime, log });
  if (!runtime.restored) persistence.saveNow('warm-up');
  journal.subscribe((record) => {
    if (record.kind === 'tick_completed') persistence.onTick();
    // Accounts mode: garden records live in the DB (written by the gardens); the JSON state holds only global ones.
    else if (SAVE_SOON_KINDS.has(record.kind) && (live || record.uid === undefined)) persistence.soon();
  });

  // ---- serve
  const server = accounts
    ? createServer({
      engine,
      journal,
      pulse,
      platform: acct.bag,
      config: {
        auth: 'accounts', publicOrigin: config.publicOrigin, version, feed: config.feed, log,
        signupMode: config.signupMode, adminTokenRemote: config.adminTokenRemote,
        dataDir: config.dataDir, testnetMaxActiveUsers: config.testnetMaxActiveUsers ?? 40,
        testnetEnabled: Boolean(acct.testnet) && !config.testnetDouble, testnetDouble: Boolean(acct.testnet) && config.testnetDouble === true,
      },
    })
    : createServer({
      engine,
      live,
      journal,
      pulse,
      config: { token: config.token, loopbackCommands: config.loopbackCommands, version, feed: config.feed, log },
    });
  if (acct) {
    acct.gardens.setHttp(server);
    acct.platform.start(); // backups + retention timers
    acct.gardens.startSweeps(); // expiry (5 min), inactivity (daily), eviction (5 min), mainnet re-check (WP2)
  }
  engine.run();
  let address;
  try {
    address = await listen(server, config.port, config.host);
  } catch (err) {
    engine.stop();
    if (acct) await acct.close().catch(() => {});
    const hint = err.code === 'EADDRINUSE' ? ` — port ${config.port} is in use; try --port <another>` : '';
    console.error(`bean-garden: cannot listen on ${config.host}:${config.port}: ${err.message}${hint}`);
    process.exitCode = 1;
    return null;
  }

  const url = displayUrl(config.host, address.port);
  log(`Bean Garden is growing at ${url}  (API ${url}api/v1 · docs ${url}docs)`);
  if (accounts) {
    log(`accounts mode: sign-up ${config.signupMode ?? 'open'} · public origin ${config.publicOrigin} · testnet ${acct.testnet ? (config.testnetDouble ? 'DOUBLE (dev)' : 'enabled') : 'off'}`);
  } else {
    for (const line of commandPolicyLines(config)) log(line);
  }
  journal.emit('daemon_started', { pid: process.pid, version });

  // ---- cloud sync: take the lease and sync from now on (not awaited: the signal handlers below must be in place)
  if (acct && cloudPrep) {
    cloud = cloudPrep.cs.startCloudSync({
      store: cloudPrep.store,
      db: acct.platform.db,
      files: cloudPrep.filesFor(config), // the configured feed's files (cloud mode never falls back to sim)
      intervalMs: config.cloud.syncSeconds * 1000,
      egressBudgetBytes: (config.cloud.egressBudgetMb ?? 3072) * 1024 * 1024,
      seq: () => journal.lastSeq,
      adminExists: () => acct.platform.users.adminExists(),
      bootstrapConfigured: Boolean(config.secrets?.bootstrapCode),
      log,
    });
    cloud.start().catch((err) => log(`[cloud] start failed: ${err?.message || err}`));
  }

  // ---- shutdown
  // None mode: everything below is synchronous (tick() never awaits, saveState writes synchronously), so the state
  // saved here is consistent and nothing is lost by exiting right after.
  // Accounts mode (§10.4): stop accepting commands → end streams → stop the engine and the testnet market → let
  // in-flight testnet requests finish (≤ 10 s; queued jobs dropped, intents stay in bot state) → flush gardens →
  // save the JSON state → checkpoint and close the DB → exit. Hard deadline 25 s.
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    const t0 = Date.now();
    log(`${signal} — saving state and shutting down…`);
    if (!acct) {
      engine.stop();
      persistence.cancel();
      persistence.saveNow('shutdown');
      server.close();
      server.closeAllConnections?.();
      process.exit(0);
      return;
    }
    const hard = setTimeout(() => {
      log('[shutdown] deadline reached — exiting');
      persistence.saveNow('shutdown');
      process.exit(0);
    }, SHUTDOWN_DEADLINE_MS);
    hard.unref?.();
    (async () => {
      try {
        server.beginShutdown?.(); // 1–2: commands and /readyz answer 503; streams get server_restart and end
        server.close();
        server.closeAllConnections?.();
        engine.stop(); // 3 (the testnet market stops in gardens.shutdown)
        persistence.cancel();
        cloud?.stop(); // no new interval sync; the final one runs below
        await acct.gardens.shutdown({ drainMs: SHUTDOWN_DRAIN_MS }); // 3–5: market stop, drain ≤ 10 s, gardens.flush()
      } catch (err) {
        log(`[shutdown] ${err?.message || err}`);
      }
      persistence.saveNow('shutdown'); // 5: saveState(JSON) …
      if (cloud) await cloud.idle(5_000); // a running interval sync must not hold the DB while it closes
      try {
        await acct.platform.close(); // … then PRAGMA wal_checkpoint(TRUNCATE) and db.close()
      } catch (err) {
        log(`[shutdown] ${err?.message || err}`);
      }
      if (cloud) {
        // 5b (cloud persistence): the final DB + state copies, within what is left of the deadline.
        const left = SHUTDOWN_DEADLINE_MS - (Date.now() - t0) - 1_500;
        const r = await cloud.syncNow('shutdown', { force: true, deadlineMs: Math.max(1_000, Math.min(CLOUD_SHUTDOWN_SYNC_MS, left)) });
        log(cloudShutdownLine(r));
      }
      process.exit(0); // 6
    })();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => shutdown(signal));

  return { config, server, engine, live, journal, persistence, gardens: acct?.gardens ?? null, cloud };
}

/** True when this file was started directly (`node server/main.js`), not imported. */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    const entry = fs.realpathSync.native(process.argv[1]);
    const self = fs.realpathSync.native(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(`bean-garden: fatal: ${err?.stack || err}`);
    process.exit(err?.exitCode ?? 1);
  });
}

// server/config.js — platform options: strict --auth, accounts-mode settings, `_FILE` secrets (PLATFORM.md §2.3,
// §10.3). Imported by server/main.js (WP3), whose parseConfig() keeps every existing flag and default.
//
// Integration (main.js):
//   import { PLATFORM_CLI_OPTIONS, applyEnvDefaults, parsePlatformConfig, PlatformConfigError } from './config.js';
//   const { values } = parseArgs({ options: { ...CLI_OPTIONS, ...PLATFORM_CLI_OPTIONS }, ... });
//   const platform = parsePlatformConfig({ values, env });   // FIRST: refuses --token in accounts mode, etc.
//   const v = applyEnvDefaults(values, env, platform.auth);  // HOST (accounts only), BEAN_FEED, BEAN_DATA_DIR
//   … existing parseConfig body on `v` …  return { ...existing, ...platform };
//   main(): `err instanceof PlatformConfigError` → exit code 2 (err.exitCode), message printed as is.
//
// Strictness (§2.3, §10.3): a set-but-empty BEAN_AUTH, or anything but none/accounts, exits 2. None mode exits 2
// when an accounts-only setting is present or the HOST env var is non-loopback, so a typo can never put none mode on
// the internet. The stricter rules only fire when BEAN_AUTH/--auth or an accounts-only variable is present, so the
// existing parseConfig tests (explicit `{}` env) behave as today (§2.4 rule 10). Error messages name the variable,
// never its value. Every secret variable (and its _FILE twin) is deleted from `env` after it is read (§5.1).
//
// Cloud persistence (Render free + Supabase Storage, deploy/render/README.md): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// (or _FILE, a secret) enable it together — one without the other exits 2; CLOUD_STORE_BUCKET (bean-garden),
// CLOUD_STORE_PREFIX (''), CLOUD_SYNC_SECONDS (60, ≥ 15) and CLOUD_EGRESS_BUDGET_MB (3072 per month) tune it;
// CLOUD_ALLOW_FRESH=1 (one boot, on purpose) lets
// the restore start empty although the bucket shows a previous deployment. All of them are accounts-only.
//
// Render: when neither --public-origin nor PUBLIC_ORIGIN is set, accounts mode uses RENDER_EXTERNAL_URL (the URL Render
// gives the service), so a renamed service can never answer 421 everywhere. RENDER_EXTERNAL_URL is never refused.

import fs from 'node:fs';
import crypto from 'node:crypto';

import { parseMasterKey } from './secrets.js';
import { canonicalUsername } from './auth/passwords.js';
import { parseCidrs, DEFAULT_TRUSTED_PROXY_CIDRS } from './auth/clientip.js';

/** New CLI flags (merge into main.js's parseArgs options). Secrets are never accepted as flags. */
export const PLATFORM_CLI_OPTIONS = Object.freeze({
  auth: { type: 'string' },
  'public-origin': { type: 'string' },
  'trust-proxy': { type: 'string' },
  'testnet-double': { type: 'boolean' },
});

/** Config refusal: main() prints the message and exits with `exitCode` (2). */
export class PlatformConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.exitCode = 2;
  }
}

/** Secret variables (each also as NAME_FILE). Read once, then deleted from the env (§5.1). */
export const SECRET_VARS = Object.freeze(['BEAN_MASTER_KEY', 'BEAN_MASTER_KEYS_OLD', 'ADMIN_TOKEN', 'ADMIN_BOOTSTRAP_CODE', 'SUPABASE_SERVICE_ROLE_KEY']);

/** Cloud persistence (Supabase Storage; deploy/render/README.md). All accounts-only. */
export const CLOUD_VARS = Object.freeze([
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY_FILE', 'CLOUD_STORE_BUCKET', 'CLOUD_STORE_PREFIX', 'CLOUD_SYNC_SECONDS',
  'CLOUD_ALLOW_FRESH', 'CLOUD_EGRESS_BUDGET_MB',
]);

/**
 * Settings that only make sense in accounts mode: present in none mode → exit 2 (§10.3). `ADMIN_*` is a prefix.
 * BEAN_MASTER_KEYS_OLD(_FILE) is included with the master key family (refusing a stray old key is the safe side).
 */
export const ACCOUNTS_ONLY_VARS = Object.freeze([
  'PUBLIC_ORIGIN', 'TRUST_PROXY', 'TRUSTED_PROXY_CIDRS', 'CLIENT_IP_HEADER',
  'BEAN_MASTER_KEY', 'BEAN_MASTER_KEY_FILE', 'BEAN_MASTER_KEYS_OLD', 'BEAN_MASTER_KEYS_OLD_FILE',
  'TESTNET_ENABLED', 'SIGNUP_MODE', 'INACTIVITY_DAYS',
  ...CLOUD_VARS,
]);

const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;
const PREFIX_SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;
const ACCOUNTS_ONLY_FLAGS = Object.freeze(['public-origin', 'trust-proxy', 'testnet-double']);

const LOOPBACK_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;
const TOKEN_RE = /^[\x21-\x7e]+$/;
const HEADER_RE = /^[a-z0-9-]{1,64}$/;

const fail = (msg) => {
  throw new PlatformConfigError(msg);
};

const isSet = (env, name) => env[name] !== undefined;

/**
 * The auth mode: --auth wins over BEAN_AUTH. Each, when present, must be exactly 'none' or 'accounts'.
 * @returns {{auth: 'none'|'accounts', explicit: boolean}}
 */
export function parseAuthMode(values = {}, env = {}) {
  const check = (raw, name) => {
    if (raw !== 'none' && raw !== 'accounts') fail(`${name} must be exactly "none" or "accounts"`);
    return raw;
  };
  const fromEnv = isSet(env, 'BEAN_AUTH') ? check(env.BEAN_AUTH, 'BEAN_AUTH') : null;
  const fromFlag = values.auth !== undefined ? check(values.auth, '--auth') : null;
  const auth = fromFlag ?? fromEnv ?? 'none';
  return { auth, explicit: fromFlag !== null || fromEnv !== null };
}

/**
 * Read a secret from NAME_FILE (preferred: compose `secrets:`) or NAME, then DELETE both from `env`. Setting both is
 * refused (ambiguous). An unreadable file exits 2 naming the variable only. Returns the trimmed text or null.
 */
export function readSecret(env, name) {
  const fileVar = `${name}_FILE`;
  const hasFile = isSet(env, fileVar);
  const hasValue = isSet(env, name);
  let out = null;
  try {
    if (hasFile && hasValue) fail(`set only one of ${name} or ${fileVar}`);
    if (hasFile) {
      const file = String(env[fileVar]);
      if (!file.trim()) fail(`${fileVar} is set but empty`);
      try {
        out = fs.readFileSync(file, 'utf8').trim();
      } catch (err) {
        fail(`${fileVar}: cannot read the secret file (${err.code ?? err.name})`);
      }
      if (!out) fail(`${fileVar}: the secret file is empty`);
    } else if (hasValue) {
      out = String(env[name]).trim();
      if (!out) fail(`${name} is set but empty`);
    }
  } finally {
    delete env[name];
    delete env[fileVar];
  }
  return out;
}

function intVar(env, name, dflt, min, max) {
  if (!isSet(env, name)) return dflt;
  const text = String(env[name]).trim();
  if (!/^\d+$/.test(text)) fail(`${name} must be an integer between ${min} and ${max}`);
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function boolVar(env, name) {
  if (!isSet(env, name)) return false;
  const v = String(env[name]).trim();
  if (v !== '0' && v !== '1') fail(`${name} must be 0 or 1`);
  return v === '1';
}

function enumVar(env, name, allowed, dflt) {
  if (!isSet(env, name)) return dflt;
  const v = String(env[name]).trim();
  if (!allowed.includes(v)) fail(`${name} must be one of ${allowed.join(', ')}`);
  return v;
}

/**
 * PUBLIC_ORIGIN: an absolute http(s) origin with no path, query or credentials; http: only for localhost /
 * 127.0.0.1 (local development). → the normalised origin.
 */
export function parsePublicOrigin(raw, name = 'PUBLIC_ORIGIN') {
  const text = String(raw ?? '').trim();
  if (!text) fail(`${name} is required with --auth accounts (e.g. https://bean.example.com)`);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(`${name} must be an absolute http(s) origin such as https://bean.example.com`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(`${name} must use https: (or http: for localhost)`);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    fail(`${name} must be an origin only (scheme://host[:port]), with no path, query or credentials`);
  }
  if (/[?#]$/.test(text)) fail(`${name} must be an origin only (scheme://host[:port]), with no path, query or credentials`);
  if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    fail(`${name} may use http: only for localhost or 127.0.0.1; use https: on the internet`);
  }
  return url.origin;
}

/**
 * SUPABASE_URL: an https origin (https://<project>.supabase.co, or a custom https domain) with no path, query or
 * credentials. → the normalised origin.
 */
export function parseSupabaseUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) fail('SUPABASE_URL is set but empty');
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('SUPABASE_URL must be an https origin such as https://<project>.supabase.co');
  }
  if (url.protocol !== 'https:') fail('SUPABASE_URL must use https:');
  if (url.username || url.password || url.search || url.hash || /[?#]$/.test(text) || (url.pathname !== '/' && url.pathname !== '')) {
    fail('SUPABASE_URL must be an origin only (https://<project>.supabase.co), with no path, query or credentials');
  }
  return url.origin;
}

/**
 * Cloud persistence (Supabase Storage, deploy/render/README.md): enabled only when SUPABASE_URL and the service key
 * are BOTH present; one without the other (or a CLOUD_* tuning variable without either) is refused. The key is read
 * (and deleted from env) by the caller. → {url, bucket, prefix, syncSeconds, allowFresh, egressBudgetMb} | null
 */
function parseCloud(env, key) {
  const hasUrl = isSet(env, 'SUPABASE_URL');
  const tuning = ['CLOUD_STORE_BUCKET', 'CLOUD_STORE_PREFIX', 'CLOUD_SYNC_SECONDS', 'CLOUD_ALLOW_FRESH', 'CLOUD_EGRESS_BUDGET_MB'].filter((n) => isSet(env, n));
  if (!hasUrl && key === null) {
    if (tuning.length) fail(`${tuning[0]} needs cloud persistence: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or _FILE), or unset ${tuning[0]}`);
    return null;
  }
  if (!hasUrl) fail('cloud persistence is half configured: SUPABASE_SERVICE_ROLE_KEY is set but SUPABASE_URL is not (set both, or neither)');
  if (key === null) fail('cloud persistence is half configured: SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY (or _FILE) is not (set both, or neither)');
  const url = parseSupabaseUrl(env.SUPABASE_URL);
  if (key.length < 20 || key.length > 4096 || !TOKEN_RE.test(key)) {
    fail('SUPABASE_SERVICE_ROLE_KEY must be the project\'s service_role (or sb_secret_) key: 20+ visible ASCII characters without spaces');
  }
  const bucket = isSet(env, 'CLOUD_STORE_BUCKET') ? String(env.CLOUD_STORE_BUCKET).trim() : 'bean-garden';
  if (!BUCKET_NAME_RE.test(bucket)) fail('CLOUD_STORE_BUCKET must be 2–63 of a–z, 0–9, ".", "_", "-" (starting with a letter or digit)');
  let prefix = isSet(env, 'CLOUD_STORE_PREFIX') ? String(env.CLOUD_STORE_PREFIX).trim().replace(/^\/+|\/+$/g, '') : '';
  if (prefix) {
    const parts = prefix.split('/');
    if (parts.length > 6 || parts.some((s) => !PREFIX_SEGMENT_RE.test(s) || s === '.' || s === '..')) {
      fail('CLOUD_STORE_PREFIX must be a folder path such as bean/prod (A–Z, a–z, 0–9, ".", "_", "-" per segment)');
    }
    prefix = `${prefix}/`;
  }
  return {
    url, bucket, prefix,
    syncSeconds: intVar(env, 'CLOUD_SYNC_SECONDS', 60, 15, 3600),
    allowFresh: boolVar(env, 'CLOUD_ALLOW_FRESH'),
    egressBudgetMb: intVar(env, 'CLOUD_EGRESS_BUDGET_MB', 3072, 100, 1_000_000),
  };
}

/** True for http://localhost… / http://127.0.0.1… (the --testnet-double precondition). */
const isLocalHttpOrigin = (origin) => /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin);

/**
 * Fill flags from the environment where §10.3 says the env var is an alternative (call after parsePlatformConfig).
 * Returns a NEW values object:
 *   --feed ← BEAN_FEED, --data ← BEAN_DATA_DIR (both modes, only when the flag is absent);
 *   --host ← HOST (accounts mode only; none mode never reads HOST, §2.3).
 */
export function applyEnvDefaults(values, env = {}, auth = 'none') {
  const out = { ...values };
  if (out.feed === undefined && isSet(env, 'BEAN_FEED') && String(env.BEAN_FEED).trim()) out.feed = String(env.BEAN_FEED).trim();
  if (out.data === undefined && isSet(env, 'BEAN_DATA_DIR') && String(env.BEAN_DATA_DIR).trim()) out.data = String(env.BEAN_DATA_DIR).trim();
  if (auth === 'accounts' && out.host === undefined && isSet(env, 'HOST') && String(env.HOST).trim()) out.host = String(env.HOST).trim();
  return out;
}

/**
 * Parse every platform setting. Throws PlatformConfigError (exit 2) on any refusal.
 * @param {object} o
 * @param {Record<string, any>} o.values   parseArgs values (with PLATFORM_CLI_OPTIONS merged)
 * @param {Record<string, string|undefined>} o.env  (secret variables are deleted from it)
 * @returns {object} `{auth: 'none'}` in none mode; the full accounts config otherwise. Secrets sit in the
 *   NON-enumerable `secrets` property ({masterKey, masterKeyEphemeral, oldKeys, adminToken, bootstrapCode, cloudKey}), so a
 *   logged or JSON-serialised config never shows them.
 */
export function parsePlatformConfig({ values = {}, env = {} } = {}) {
  const { auth } = parseAuthMode(values, env);

  if (auth === 'none') {
    for (const name of Object.keys(env)) {
      if (env[name] === undefined) continue;
      if (ACCOUNTS_ONLY_VARS.includes(name) || name.startsWith('ADMIN_')) {
        fail(`${name} is an accounts-mode setting: set BEAN_AUTH=accounts (or --auth accounts), or unset ${name}`);
      }
    }
    for (const flag of ACCOUNTS_ONLY_FLAGS) {
      if (values[flag] !== undefined) fail(`--${flag} needs --auth accounts`);
    }
    if (isSet(env, 'HOST') && String(env.HOST).trim() && !LOOPBACK_HOST_RE.test(String(env.HOST).trim())) {
      fail('HOST is not read in none mode and is not loopback: none mode is local-only (use --host explicitly, or --auth accounts)');
    }
    return { auth: 'none' };
  }

  // ---- accounts mode
  if (values.token !== undefined || isSet(env, 'BEAN_API_TOKEN')) {
    delete env.BEAN_API_TOKEN;
    fail('--token / BEAN_API_TOKEN are refused with --auth accounts: use ADMIN_TOKEN_FILE for the operator (admin-cli)');
  }
  if (values['no-loopback-commands'] !== undefined) {
    fail('--no-loopback-commands is meaningless with --auth accounts (loopback commands are always off)');
  }

  // Render: RENDER_EXTERNAL_URL (the service's own URL) when no origin is configured.
  const originName = values['public-origin'] !== undefined ? '--public-origin'
    : isSet(env, 'PUBLIC_ORIGIN') || !isSet(env, 'RENDER_EXTERNAL_URL') ? 'PUBLIC_ORIGIN' : 'RENDER_EXTERNAL_URL';
  const publicOrigin = parsePublicOrigin(values['public-origin'] ?? env.PUBLIC_ORIGIN ?? env.RENDER_EXTERNAL_URL, originName);

  let trustProxy = 0;
  if (values['trust-proxy'] !== undefined) {
    const t = String(values['trust-proxy']).trim();
    if (!/^\d{1,2}$/.test(t) || Number(t) > 10) fail('--trust-proxy must be an integer between 0 and 10');
    trustProxy = Number(t);
  } else {
    trustProxy = intVar(env, 'TRUST_PROXY', 0, 0, 10);
  }

  let trustedProxyCidrs;
  try {
    trustedProxyCidrs = isSet(env, 'TRUSTED_PROXY_CIDRS')
      ? String(env.TRUSTED_PROXY_CIDRS).split(',').map((s) => s.trim()).filter(Boolean)
      : [...DEFAULT_TRUSTED_PROXY_CIDRS];
    parseCidrs(trustedProxyCidrs);
  } catch {
    fail('TRUSTED_PROXY_CIDRS must be a comma list of CIDRs such as 10.0.0.0/8,fd00::/8');
  }

  let clientIpHeader = null;
  if (isSet(env, 'CLIENT_IP_HEADER')) {
    clientIpHeader = String(env.CLIENT_IP_HEADER).trim().toLowerCase();
    if (!HEADER_RE.test(clientIpHeader)) fail('CLIENT_IP_HEADER must be a header name such as fly-client-ip');
    if (clientIpHeader === 'x-forwarded-for' || clientIpHeader === 'forwarded') {
      fail('CLIENT_IP_HEADER names a single-IP header (e.g. fly-client-ip); for X-Forwarded-For use TRUST_PROXY');
    }
  }

  const feed = values.feed ?? (isSet(env, 'BEAN_FEED') ? String(env.BEAN_FEED).trim() : 'hyperliquid');
  const testnetEnabled = boolVar(env, 'TESTNET_ENABLED');
  const testnetDouble = Boolean(values['testnet-double']);
  const nodeEnv = String(env.NODE_ENV ?? '');

  // ---- secrets (read once, deleted from env)
  const masterText = readSecret(env, 'BEAN_MASTER_KEY');
  const oldText = readSecret(env, 'BEAN_MASTER_KEYS_OLD');
  const adminToken = readSecret(env, 'ADMIN_TOKEN');
  const bootstrapCode = readSecret(env, 'ADMIN_BOOTSTRAP_CODE');
  const cloudKey = readSecret(env, 'SUPABASE_SERVICE_ROLE_KEY');
  const cloud = parseCloud(env, cloudKey);

  let masterKey = null;
  if (masterText !== null) {
    try {
      masterKey = parseMasterKey(masterText, 'BEAN_MASTER_KEY');
    } catch (err) {
      fail(err.message);
    }
  }
  const oldKeys = [];
  if (oldText !== null) {
    for (const part of oldText.split(',').map((s) => s.trim()).filter(Boolean)) {
      try {
        oldKeys.push(parseMasterKey(part, 'BEAN_MASTER_KEYS_OLD'));
      } catch (err) {
        fail(err.message);
      }
    }
  }
  if (adminToken !== null && (adminToken.length < 32 || !TOKEN_RE.test(adminToken))) {
    fail('ADMIN_TOKEN must be at least 32 visible ASCII characters without spaces (e.g. openssl rand -base64 33)');
  }
  if (bootstrapCode !== null && (bootstrapCode.length < 12 || bootstrapCode.length > 128 || !TOKEN_RE.test(bootstrapCode))) {
    fail('ADMIN_BOOTSTRAP_CODE must be 12–128 visible ASCII characters without spaces');
  }

  // ---- testnet preconditions
  if (testnetEnabled && testnetDouble) fail('--testnet-double and TESTNET_ENABLED=1 are exclusive (the double IS the testnet in dev mode)');
  if (testnetEnabled && !masterKey) fail('TESTNET_ENABLED=1 needs BEAN_MASTER_KEY_FILE (or BEAN_MASTER_KEY): 32 random bytes, base64 (npm run keygen)');
  if ((testnetEnabled || testnetDouble) && feed === 'sim') fail('the testnet venue needs real prices (--feed hyperliquid), not --feed sim');
  if (testnetDouble) {
    if (nodeEnv === 'production') fail('--testnet-double is refused when NODE_ENV=production');
    if (!isLocalHttpOrigin(publicOrigin)) fail('--testnet-double needs PUBLIC_ORIGIN http://localhost:<port> or http://127.0.0.1:<port>');
  }
  let masterKeyEphemeral = false;
  if (testnetDouble && !masterKey) {
    masterKey = crypto.randomBytes(32); // dev only: credentials do not survive a restart (§11.1)
    masterKeyEphemeral = true;
  }

  const adminUsernames = [];
  if (isSet(env, 'ADMIN_USERNAMES')) {
    for (const raw of String(env.ADMIN_USERNAMES).split(',').map((s) => s.trim()).filter(Boolean)) {
      const name = canonicalUsername(raw);
      if (!name) fail('ADMIN_USERNAMES must be a comma list of valid usernames (3–24 of a–z, 0–9, _)');
      adminUsernames.push(name);
    }
  }

  const sessionDays = intVar(env, 'SESSION_DAYS', 30, 1, 365);
  const sessionIdleDays = intVar(env, 'SESSION_IDLE_DAYS', 7, 1, 365);
  if (sessionIdleDays > sessionDays) fail('SESSION_IDLE_DAYS must not exceed SESSION_DAYS');

  const out = {
    auth: 'accounts',
    publicOrigin,
    trustProxy,
    trustedProxyCidrs,
    clientIpHeader,
    testnetEnabled,
    testnetDouble,
    testnetMaxActiveUsers: intVar(env, 'TESTNET_MAX_ACTIVE_USERS', 40, 1, 10_000),
    testnetBudget: intVar(env, 'TESTNET_BUDGET', 800, 50, 1200),
    inactivityDays: intVar(env, 'INACTIVITY_DAYS', 14, 1, 365),
    adminUsernames,
    adminTokenRemote: boolVar(env, 'ADMIN_TOKEN_REMOTE'),
    signupMode: enumVar(env, 'SIGNUP_MODE', ['open', 'invite', 'closed'], 'open'),
    signupMaxPerHour: intVar(env, 'SIGNUP_MAX_PER_HOUR', 60, 1, 100_000),
    sessionDays,
    sessionIdleDays,
    backupIntervalH: intVar(env, 'BACKUP_INTERVAL_H', 6, 1, 168),
    backupKeep: intVar(env, 'BACKUP_KEEP', 28, 1, 1000),
    logFormat: enumVar(env, 'LOG_FORMAT', ['text', 'json'], 'text'),
    cloud, // null, or {url, bucket, prefix, syncSeconds, allowFresh, egressBudgetMb}: Supabase Storage persistence (server/cloudsync.js)
  };
  const secrets = Object.freeze({
    masterKey, masterKeyEphemeral, oldKeys: Object.freeze(oldKeys), adminToken, bootstrapCode, cloudKey: cloud ? cloudKey : null,
  });
  Object.defineProperty(out, 'secrets', { value: secrets, enumerable: false });
  return out;
}

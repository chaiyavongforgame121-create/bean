// server/catalog.js — the operation catalogue (SPEC §3, §4; PLATFORM §8).
//
// Single source of truth for every HTTP operation: its name, kind (query|command), method, path,
// parameter specs and description. http.js routes and validates from it, `GET /api/v1` publishes it
// and `GET /docs` is rendered from it, so the three can never drift apart.
//
// Every op also carries (PLATFORM §8.1):
//   auth        'public' | 'user' | 'admin'   who may call it in accounts mode (none mode keeps SPEC §4 rules)
//   sensitive   boolean                        params never logged, input never echoed, 500s log no message (§5.3)
//   modes       ['none','accounts'] | ['accounts']   accounts-only ops answer 404 {code:'accounts_disabled'} in none mode
//
// Parameter spec fields:
//   type        'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object'
//               ('object': a JSON object in the body, or a string holding one; at most 32 keys, admin ops only)
//   required    boolean
//   default     value used when the parameter is absent
//   enum        allowed values (strings)
//   description human text
//   minimum / maximum   inclusive numeric bounds (integer, number)
//   maxLength   longest accepted string (in UTF-16 code units; a cheap guard before any deeper check)
//   items       { type } of array elements;  minItems / maxItems bound the array length
//
// No side effects at import time: only constant tables and pure functions.

import { ApiError } from './live.js';

// ---------------------------------------------------------------------------------------------
// Vocabulary (kept in sync with SPEC §2.3, §2.4, §2.6 and §4 by hand: these are the published names)

export const ARCHETYPE_NAMES = Object.freeze([
  'standard', 'hyper_algo', 'degen_algo',
  'swarm', 'swarm_5x', 'swarm_10x', 'swarm_25x', 'swarm_50x', 'swarm_100x',
]);

export const STRATEGY_ENUM = Object.freeze([
  'momentum', 'mean_reversion', 'breakout', 'ma_cross', 'rsi_reversal',
]);

/** Sort columns accepted by `beans`; each may be prefixed with `-` for descending order. */
export const SORT_KEYS = Object.freeze([
  'fitness', 'total_return', 'ret_7d', 'ret_1d', 'ret_1h', 'sharpe', 'trades', 'equity', 'max_dd', 'id',
]);

export const BOT_STATES = Object.freeze(['active', 'paused', 'closed']);

/** Where a bot's position lives (PLATFORM §1.3). None mode accepts only 'paper'. */
export const VENUES = Object.freeze(['paper', 'testnet']);

/** Auth modes of the server (PLATFORM §2.3). */
export const AUTH_MODES = Object.freeze(['none', 'accounts']);

/**
 * Journal / SSE event kinds (SPEC §4, exact names; feed_status and feed_gap from GAME-DESIGN §10.7). This list is
 * what none mode publishes in `meta.events`, byte-for-byte as before the platform upgrade (PLATFORM §8.8).
 */
export const EVENT_KINDS = Object.freeze([
  'warmup_finished', 'tick_completed', 'busted',
  'bot_created', 'bot_order', 'bot_fill', 'bot_paused', 'bot_resumed', 'bot_closed',
  'live_error', 'live_halted', 'daemon_started',
  'feed_status', 'feed_gap',
]);

/**
 * Kinds that exist only in accounts mode (PLATFORM §8.7): two new global kinds and the new per-player kinds.
 * `meta.events` in accounts mode is EVENT_KINDS followed by these.
 */
export const ACCOUNTS_EVENT_KINDS = Object.freeze([
  'kill_switch', 'testnet_feed',
  'bot_sync', 'bot_fill_confirmed', 'testnet_account', 'credential_status',
  'garden_rearmed', 'garden_reset', 'password_reset',
]);

/**
 * Kinds that every SSE subscriber may receive without a uid (PLATFORM §8.7). The authoritative copy is
 * `GLOBAL_KINDS` exported by server/journal.js (WP3); http.js prefers that one and falls back to this list, which
 * must stay identical.
 */
export const GLOBAL_EVENT_KINDS = Object.freeze([
  'warmup_finished', 'tick_completed', 'busted', 'daemon_started', 'feed_status', 'feed_gap',
  'kill_switch', 'testnet_feed',
]);

/**
 * Ephemeral, stream-only kinds (server/pulse.js): sent on /api/v1/events/stream WITHOUT an `id:` line, never
 * journaled, never replayed, not returned by `events`.
 */
export const STREAM_ONLY_KINDS = Object.freeze(['mids']);

/** Stream-only kinds added in accounts mode (PLATFORM §8.7). */
export const ACCOUNTS_STREAM_ONLY_KINDS = Object.freeze(['session_ended', 'resync', 'server_restart']);

/**
 * Payload fields of each event kind, besides the journal's own `seq`, `t` and `kind` (published in /docs).
 * `bot_order` carries the order's kind as `order_kind`: a record's `kind` is already the event name
 * (and the SSE `event:` line), so SPEC's `kind` field could not travel under that name.
 */
export const EVENT_FIELDS = Object.freeze({
  warmup_finished: 'bars, ms',
  tick_completed: 'tick, bar, time_ms (bar open), dur_ms, fills, busted, exits {liquidation, stop, target, max_hold, signal}, closed_ms (bar close), next_tick_ms (wall time of the next bar, null when not looping in sim), source (hyperliquid | sim)',
  busted: 'bean, archetype, coin, equity, replay (true while catching up on missed minutes)',
  bot_created: 'bot, bean, coin, capital_usd, leverage',
  bot_order: 'bot, coin, order_kind (mirror | flatten), sz (signed), px, status (filled | skipped), reason, replay (true while catching up)',
  bot_fill: 'bot, coin, dir (Open Long | Close Long | Open Short | Close Short), sz, px, fee, closed_pnl, time_ms, tick, liquidation (true, only on a liquidation fill), replay (true, only on fills made while catching up on missed minutes)',
  bot_paused: 'bot, reason, replay (true while catching up on missed minutes)',
  bot_resumed: 'bot',
  bot_closed: 'bot, realized_pnl',
  live_error: 'bot, error',
  live_halted: 'closed (bot ids)',
  daemon_started: 'pid, version',
  feed_status: 'state (live | delayed | down | sim), prev, source, stale_coins, lag_bars, error, fallback (null | {from, reason, since_ms})',
  feed_gap: 'from_ms, to_ms, bars, mode (replay | rewarm), reason (restart | outage) — missed minutes caught up; replayed fills carry their bar-close time_ms',
});

/** Accounts-mode fields: the additions to existing kinds and the new kinds (PLATFORM §8.7; published in /docs). */
export const ACCOUNTS_EVENT_FIELDS = Object.freeze({
  bot_created: '+ venue (paper | testnet)',
  bot_order: '+ venue, cloid, code',
  bot_fill: '+ venue, provisional, oid',
  bot_paused: '+ note_code, note_vars {exch, exp, coin}',
  bot_closed: '+ venue, funding, confirmed',
  live_error: '+ code, vars',
  live_halted: '+ closing (bot ids still flattening on testnet)',
  kill_switch: 'on, reason, since_ms (global)',
  testnet_feed: 'state, prev, reason (includes signing for a signature_mismatch halt), error (global)',
  bot_sync: "bot, op (leverage | mirror | flatten), state (pending | done | failed), attempts, code?, error?, fill_state?",
  bot_fill_confirmed: 'bot, coin, oid, sz, px, fee, closed_pnl, tids',
  testnet_account: 'account_value, account_value_est, free, total_margin_used, as_of_ms',
  credential_status: 'status, reason',
  garden_rearmed: '(no fields)',
  garden_reset: 'season, closed, realized_pnl',
  password_reset: '(no fields; one diary line after an operator reset)',
});

/** Payload of each stream-only kind (published in /docs). */
export const STREAM_ONLY_FIELDS = Object.freeze({
  mids: 'kind, t, source, prices (real | sim), px {coin: live mid}, stale [coins], bar {tick, time_ms, next_tick_ms}, ' +
    'bots {id: {szi, entry_px, mark_px, unrealized_pnl, realized_pnl, margin_used, liquidation_px, notional_usd, price_stale, as_of_ms}}, ' +
    'account {account_value, unrealized_pnl, realized_pnl, available_usd, deployed_usd, open_notional_usd}',
});

/** Accounts-mode stream-only kinds (published in /docs). */
export const ACCOUNTS_STREAM_ONLY_FIELDS = Object.freeze({
  mids: 'the global part for everyone (plus `testnet` when the testnet is enabled); `bots`, `account` and `testnet_account` only for the subscriber\'s own garden',
  session_ended: 'reason (logout | logout_all | password_changed | revoked | disabled | role_changed | password_reset | deleted | expired); the stream then ends',
  resync: '(no fields) — the Last-Event-ID is too old: do a full refresh',
  server_restart: '(no fields) — the server is shutting down; reconnect with back-off',
});

/** Fitness scales, keyed by archetype `scale` (served by `meta`). */
export const SCALES = Object.freeze({
  sharpe: 'Risk-adjusted: fitness = sharpe − max_dd. Sharpe is the annualised (√525600) mean/sd of per-bar equity returns.',
  return: 'Raw growth: fitness = ann_return − max_dd, where ann_return = mean per-bar return × 525600.',
  return_dd2: 'Growth with a softer drawdown penalty: fitness = ann_return − max_dd / 2.',
});

/** Glossary of BeanRow columns (served by `meta`). */
export const COLUMNS = Object.freeze({
  id: 'Bean id, integer 0..N-1.',
  archetype: 'Cohort the bean was born into (see archetypes).',
  family: 'Archetype family: standard | hyper | degen | swarm.',
  mode: 'Execution mode; always "algo" here (no LLM beans).',
  strategy: 'Signal function: momentum | mean_reversion | breakout | ma_cross | rsi_reversal.',
  coin: 'The one market this bean trades.',
  leverage: 'Leverage applied to every entry.',
  position_size: 'Fraction of equity posted as margin per entry.',
  lookback: 'Signal window in bars (minutes).',
  entry_threshold: 'Signal strength needed to enter (strategy units).',
  stop_loss: 'Adverse price move that closes the position.',
  take_profit: 'Favourable price move that closes the position.',
  cooldown_bars: 'Bars to wait after a close before re-entering.',
  min_hold_bars: 'Bars a position is held before an opposite signal may close it.',
  max_hold_bars: 'Bars after which a position is closed regardless.',
  equity: 'Paper equity in USD, marked to market at the last close (starts at 1000).',
  total_return: 'equity / 1000 − 1.',
  ret_1h: 'Return over the last hour of the hourly equity curve.',
  ret_1d: 'Return over the last 24 hourly points.',
  ret_7d: 'Return over the last 168 hourly points.',
  sharpe: 'Annualised Sharpe of per-bar equity returns.',
  max_dd: 'Maximum drawdown of equity so far (0..1).',
  trades: 'Fills so far (opens + closes).',
  win_rate: 'Closed trades with pnl > 0 / closed trades.',
  fitness: 'Archetype-scale score; never compare it across archetypes.',
  busted: 'True once the bean can no longer open a $10 order. Busted beans never trade again.',
  breached: 'Bit flags: 1 = max drawdown limit hit, 2 = equity at or below the ruin floor.',
  in_position: '"long" | "short" | "flat".',
  side: '-1 short, 0 flat, 1 long.',
  units: 'Signed position size in coin units.',
  entry_px: 'Entry price of the open position (null when flat).',
  tradeable: 'Whether bot_create would accept this bean right now.',
  venue_max_leverage: 'Maximum leverage the venue allows for the coin (Hyperliquid maxLeverage with real prices).',
  venue_reason: 'Why the bean is not tradeable: busted | coin_bound | bean_bound | leverage | unlisted | halted.',
  bot: 'Id of the open bot mirroring this bean, or null.',
});

// ---------------------------------------------------------------------------------------------
// Machine error codes (PLATFORM §8.9). Errors stay `{error, status}`; accounts mode adds `code` (always one of
// these). None mode stays byte-identical: it adds `code` only to errors that did not exist before the upgrade
// (`accounts_disabled`, `testnet_needs_accounts`).

/** code → the HTTP status it is normally sent with (§8.9). */
export const ERROR_STATUS = Object.freeze({
  // 400
  bad_request: 400, bad_username: 400, weak_password: 400, bad_address: 400, bad_key_format: 400,
  confirm_required: 400, invalid_json: 400, query_params_not_allowed: 400,
  // 401
  auth_required: 401, session_expired: 401, bad_credentials: 401,
  // 403
  csrf: 403, forbidden: 403, account_disabled: 403, signup_closed: 403, session_required: 403,
  // 404
  not_found: 404, accounts_disabled: 404,
  // 409
  conflict: 409, halted: 409, not_tradeable: 409, caps: 409, stale: 409, username_unavailable: 409,
  already_connected: 409, agent_in_use: 409, account_in_use: 409, has_open_testnet_bots: 409,
  testnet_positions_open: 409, testnet_needs_accounts: 409, too_soon: 409,
  // 409 — testnet create/resume checks (§7.3)
  not_connected: 409, credential_revoked: 409, agent_expiring: 409, unlisted_testnet: 409, delisted_testnet: 409,
  busted: 409, bean_bound: 409, coin_bound: 409, leverage: 409, no_testnet_price: 409, testnet_caps: 409,
  insufficient_testnet_balance: 409, thin_book: 409, divergence_ack: 409,
  // 413 / 415 / 421
  body_too_large: 413, unsupported_media_type: 415, misdirected: 421,
  // 422
  seed_phrase: 422, master_key: 422, mainnet_key: 422, not_agent: 422, agent_mismatch: 422, agent_expired: 422,
  abstraction_unsupported: 422, no_testnet_funds: 422, signer_mismatch: 422,
  // 429
  rate_limited: 429,
  // 502
  testnet_error: 502,
  // 503
  testnet_disabled: 503, testnet_down: 503, kill_switch: 503, testnet_capacity: 503, busy: 503,
  server_restarting: 503, signup_busy: 503, mainnet_check_unavailable: 503,
});

/**
 * Every machine `code` the HTTP API can send, as an array (iterate it; the i18n parity test needs a `g.err.<code>`
 * key for each, PLATFORM §9.7.2). Exchange codes and note codes live in server/hl/errors.js.
 */
export const ERROR_CODES = Object.freeze(Object.keys(ERROR_STATUS));

/** The generic code for an error that carries none, by HTTP status (accounts mode only). */
export const DEFAULT_CODE_BY_STATUS = Object.freeze({
  400: 'bad_request', 401: 'auth_required', 403: 'forbidden', 404: 'not_found', 405: 'bad_request',
  409: 'conflict', 413: 'body_too_large', 415: 'unsupported_media_type', 421: 'misdirected', 429: 'rate_limited',
  502: 'testnet_error', 503: 'busy',
});

/**
 * The only codes a NONE-mode error carries (PLATFORM §8.8): errors that did not exist before the upgrade. Every
 * other none-mode error stays `{error, status}`, byte-for-byte.
 */
export const NONE_MODE_CODES = Object.freeze(['accounts_disabled', 'testnet_needs_accounts']);

/** True when `code` is a published HTTP error code. */
export function isErrorCode(code) {
  return typeof code === 'string' && Object.hasOwn(ERROR_STATUS, code);
}

// ---------------------------------------------------------------------------------------------
// Parameter spec builders (small helpers keep the table below readable)

const str = (description, extra = {}) => ({ type: 'string', required: false, ...extra, description });
const int = (description, extra = {}) => ({ type: 'integer', required: false, ...extra, description });
const num = (description, extra = {}) => ({ type: 'number', required: false, ...extra, description });
const bool = (description, extra = {}) => ({ type: 'boolean', required: false, ...extra, description });
const arr = (description, extra = {}) => ({ type: 'array', required: false, ...extra, description });
const obj = (description, extra = {}) => ({ type: 'object', required: false, ...extra, description });

const BOTH = Object.freeze(['none', 'accounts']);
const ACCOUNTS = Object.freeze(['accounts']);

/** Op flags: `auth` (default public for queries, user for commands), `sensitive` (false), `modes` (both). */
function flags(kind, { auth, sensitive = false, modes = BOTH } = {}) {
  return { auth: auth ?? (kind === 'query' ? 'public' : 'user'), sensitive, modes };
}

const query = (name, description, params = {}, opts = {}) =>
  ({ name, kind: 'query', method: 'GET', path: `/api/v1/${name}`, params, description, ...flags('query', opts) });
const command = (name, description, params = {}, opts = {}) =>
  ({ name, kind: 'command', method: 'POST', path: `/api/v1/${name}`, params, description, ...flags('command', opts) });

const botId = () => str('Bot id, e.g. "bot-0000".', { required: true, maxLength: 32 });
/**
 * A typed confirmation word. Not `required` at the parameter level on purpose: a missing or wrong word must answer
 * `400 confirm_required` (PLATFORM §8.9), which the handler checks, not the generic missing-parameter error.
 */
const confirmWord = (word) => str(`Required: must be exactly "${word}" (else 400 confirm_required).`, { maxLength: 16 });
/** Usernames: the server canonicalises (NFKC, trim, lower-case) and checks ^[a-z0-9_]{3,24}$ (PLATFORM §4.1). */
const username = (description = 'Username: 3–24 of a–z, 0–9, _ (case-insensitive).') =>
  str(description, { required: true, maxLength: 64 });
/** Passwords: 10–128 code points and ≤ 512 UTF-8 bytes after NFKC (PLATFORM §4.1). */
const password = (description) => str(description, { required: true, maxLength: 512 });

// ---------------------------------------------------------------------------------------------
// The catalogue

const OPS_TABLE = [
  // ---- queries -------------------------------------------------------------------------------
  query('health',
    'Liveness: version, current tick and bar, bean count, server clock (now_ms), market time, uptime, feed source, prices (real | sim), paper: true, feed_state (live | delayed | down | sim) and the bar loop (daemon {running, tick_ms, aligned, next_tick_ms}). Cheap — poll this.'),
  query('status',
    'Everything in health plus last tick duration, population stats per archetype and the feed: {source, coins, ok, error, stale (count), real, state, stale_coins, fallback, real_available, mids_ms, mids_age_ms, last_bar_close_ms, next_tick_ms, lag_bars, bar_sources {candle, mids, flat}, weight_60s, last_gap, requests}.'),
  query('meta',
    'Static vocabulary: archetypes (with genome bounds), strategy names, the live coin listing (with real prices: Hyperliquid szDecimals and maxLeverage), fitness scales and a BeanRow column glossary.'),
  query('market',
    'The coin universe: live mid (px, px_ms; `mid` = px), last bar close, 24 h and 1 h change, bars of history, staleness, venue limits, Hyperliquid day stats (prev_day_px, funding_1h — info only, mark_px, oracle_px, open_interest, day_ntl_vlm; null in sim), source, and how many beans trade / are positioned on each coin.'),
  query('beans',
    'Search the population. Filters AND together, then sort, then page. `distinct_coin` keeps only the best bean per coin (by `sort`) before paging — what a frontend wants when it can run one bot per coin. In accounts mode `tradeable`, `venue_reason` and `bot` are the signed-in player\'s own paper verdict.',
    {
      archetype: str('Only this archetype.', { enum: [...ARCHETYPE_NAMES] }),
      busted: bool('Busted filter (true = only busted, false = only alive).'),
      coin: str('Only beans trading this coin symbol (e.g. BTC).'),
      strategy: str('Only beans using this strategy.', { enum: [...STRATEGY_ENUM] }),
      in_position: bool('true = only beans holding a position (side ≠ 0); false = only flat beans.'),
      tradeable: bool('true = only beans bot_create would accept right now (coin listed, not busted, coin and bean unbound, leverage within venue max).'),
      distinct_coin: bool('Keep only the best bean per coin by `sort`, then page.'),
      trades_min: int('Minimum lifetime fills.', { minimum: 0 }),
      ids: arr('Explicit bean ids (CSV or JSON array).', { items: { type: 'integer' } }),
      sort: str('Sort column; prefix `-` for descending.', {
        default: '-fitness',
        enum: SORT_KEYS.flatMap((k) => [k, `-${k}`]),
      }),
      limit: int('Rows to return (max 1000).', { default: 100, minimum: 0, maximum: 1000 }),
      offset: int('Rows to skip (paging).', { default: 0, minimum: 0 }),
    }),
  query('bean_detail',
    'One bean: its row, full genome, a one-line description, hourly equity curve and its last 50 trades.',
    { id: int('Bean id.', { required: true, minimum: 0 }) }),
  query('equity_curves',
    'Hourly equity curves ({h, equity}, capital 1000) for up to 50 beans — for sparklines.',
    { ids: arr('Bean ids (CSV or JSON array).', { required: true, items: { type: 'integer' }, minItems: 1, maxItems: 50 }) }),
  query('bots',
    'Every bot (a bean bound to simulated capital): binding, state, mirrored target, simulated position, fills, fees and PnL. Accounts mode: the signed-in player\'s bots only (BotRow gains venue fields, PLATFORM §8.5).',
    { state: str('Only bots in this state; "open" = active + paused, "all" = every bot (the default).', { enum: [...BOT_STATES, 'open', 'all'] }) },
    { auth: 'user' }),
  query('bot_detail',
    'One bot with the row of the bean it mirrors, its fills and its orders. Accounts mode: own bots only; fills and orders come from the database (newest 200).',
    { id: botId() },
    { auth: 'user' }),
  query('live_status',
    'The simulated exchange layer: mode, armed/halted, bot counts, deployed capital, open notional, realized/unrealized PnL, caps and account state. Accounts mode: the player\'s paper ledger plus user, halted_ms, rearm_after_ms, season, season_started_ms, reset_after_ms and venues {paper, testnet} (PLATFORM §8.4).',
    {},
    { auth: 'user' }),
  query('live_fills',
    'Simulated fills, newest first. Accounts mode: the player\'s own fills from the database, for the current paper season unless `season` is given.',
    {
      bot: str('Only fills of this bot id.', { maxLength: 32 }),
      limit: int('Fills to return.', { default: 100, minimum: 0, maximum: 2000 }),
      season: int('Accounts mode: paper season to read (default: the current one). Ignored in none mode.', { minimum: 1 }),
    },
    { auth: 'user' }),
  query('events',
    'Journal records, newest first, optionally filtered by kind. The same records stream live from /api/v1/events/stream. Accounts mode: global records plus the signed-in player\'s own records (spectators: global records only).',
    {
      kind: str('Only this event kind (e.g. tick_completed, busted, bot_fill).'),
      limit: int('Records to return.', { default: 100, minimum: 0, maximum: 5000 }),
      offset: int('Records to skip (paging).', { default: 0, minimum: 0 }),
    }),
  query('me',
    'Who am I: {mode, user: {id, username, role, created_ms, lang} | null, session: {created_ms, expires_ms} | null, signup: open | invite | closed, testnet: TestnetLink | null}. The one user-class query that never answers 401: spectators get 200 with user: null (a stale cookie is cleared). Cache only. None mode answers the implicit local player (id 0, role admin).',
    {},
    { auth: 'user' }),
  query('testnet_market',
    'Hyperliquid TESTNET listing for our 16 coins (cache only, never spends exchange weight): {enabled, state (live | delayed | down | disabled), state_reason, kill_switch {on, reason, since_ms}, mids_ms, ctx_ms, coins: [{coin, index, sz_decimals, max_leverage, delisted, only_isolated, mid, mid_ms, mark_px, funding_1h, tradeable}]}. Unlisted coins carry index: null, tradeable: false.'),
  query('testnet_status',
    'The player\'s testnet link and ledger, from cached snapshots only: {link, state, account, positions, requests, expiry {valid_until_ms, warn: 7d | 1d | null}, caps}.',
    {},
    { auth: 'user' }),
  query('testnet_quote',
    'Plant-dialog quote for a testnet bot, from cached snapshots only: {ok, reason, venue_ok, venue_reason, coin, asset, sz_decimals, leverage, need_leverage, max_leverage, testnet_mid, testnet_mid_ms, mainnet_mid, divergence, k, target_sz, notional_usd, margin_usd, liq_move_pct, fees_est_usd (round trip: open + close), fee_open_usd, slippage_max_usd, flatten_slippage_max_usd, book_ok, depth_usd, book_ms, funding_1h, opens_now, room_usd, free_usd}. venue_ok uses only the stake-independent checks (PLATFORM §7.3).',
    {
      bean: int('Bean id to mirror.', { required: true, minimum: 0 }),
      capital_usd: num('Stake in USD.', { required: true }),
    },
    { auth: 'user' }),
  query('sessions',
    'The player\'s live sessions: {rows: [{id (opaque public id), created_ms, last_seen_ms, user_agent, ip_prefix, current}]}.',
    {},
    { auth: 'user', modes: ACCOUNTS }),
  query('admin_status',
    'Operator view: version, uptime, users, sessions, SSE streams and buffered bytes, loaded gardens, open bots per venue, testnet scheduler and kill switch, mainnet guard queue, client-IP source and buckets, DB sizes and the last backup, event-loop p99.',
    {},
    { auth: 'admin', modes: ACCOUNTS }),
  query('admin_users',
    'Operator user list: {rows: [{id, username, role, status, created_ms, last_login_ms, bots_open, testnet: {status, account (truncated)}}], total_capped}.',
    {
      q: str('Username substring (≤ 24 chars; matched literally).', { maxLength: 24 }),
      limit: int('Rows to return.', { default: 50, minimum: 1, maximum: 500 }),
      offset: int('Rows to skip.', { default: 0, minimum: 0 }),
    },
    { auth: 'admin', modes: ACCOUNTS }),
  query('admin_audit',
    'Audit log, newest first: {rows, total_capped} (total_capped ≤ 10001).',
    {
      user: str('Only rows about this username.', { maxLength: 64 }),
      action: str('Only this audit action.', { maxLength: 40 }),
      limit: int('Rows to return.', { default: 100, minimum: 1, maximum: 1000 }),
      offset: int('Rows to skip.', { default: 0, minimum: 0 }),
    },
    { auth: 'admin', modes: ACCOUNTS }),

  // ---- commands ------------------------------------------------------------------------------
  command('bot_create',
    'Plant a bean: bind it to `capital_usd` of the simulated account. The bot mirrors the bean\'s paper position scaled by capital_usd / 1000 after every tick (and immediately on create). One open bot per coin and per bean. Refused when halted, not tradeable, over caps or short of cash. Accounts mode: `venue: "testnet"` sends real IOC orders on Hyperliquid TESTNET (needs `confirm: "testnet"`); none mode refuses it (409 testnet_needs_accounts) and ignores `venue: "paper"`.',
    {
      bean: int('Bean id to mirror.', { required: true, minimum: 0 }),
      capital_usd: num('Simulated capital for the bot (min_capital_usd..max_bot_capital_usd).', { required: true }),
      confirm: str('Accepted for brood compatibility; ignored in sim. Must be "testnet" with venue testnet.', { maxLength: 16 }),
      venue: str('Where the bot trades: paper (default) or testnet (accounts mode only).', { enum: [...VENUES] }),
      ack_divergence: bool('Testnet: the player confirmed a testnet price more than 20% away from the real price.'),
    }),
  command('bot_pause',
    'Stop mirroring and flatten the bot\'s position (a paused bot holds nothing). Testnet bots await the flatten (≤ 8 s) and return BotRow with exchange_sync.',
    { id: botId() }),
  command('bot_resume',
    'Resume mirroring a paused bot; it re-syncs to the bean immediately. A drift-paused testnet bot adopts the exchange size.',
    { id: botId() }),
  command('bot_close',
    'Flatten and retire the bot; its coin and bean can be bound again. Closing a closed bot is refused (409). A testnet bot that is already closing returns its BotRow and sends no order.',
    { id: botId() }),
  command('bots_halt',
    'Kill switch: flatten and close every open bot and refuse new bots and resumes until restart. Accounts mode: burns only the caller\'s field ({halted, closed, closing, realized_pnl}); garden_rearm lifts it.'),
  command('tick',
    'Sim feed only — fast-forward the simulation: run `n` ticks (bars) back to back and return the last tick summary. With real prices this is always refused (409): bars follow real minutes. Accounts mode: admin only (it moves everyone\'s market).',
    { n: int('Ticks to run (1..1440).', { default: 1, minimum: 1, maximum: 1440 }) },
    { auth: 'admin' }),
  command('garden_rearm',
    'Lift the burned-field halt (at least 60 s after it; 409 too_soon before). Returns {halted: false}.',
    { confirm: confirmWord('REARM') },
    { modes: ACCOUNTS }),
  command('garden_reset',
    'Start a new PAPER season: close the paper bots at market, archive paper fills and orders under the old season, reset account_usd to the current cap. Testnet is untouched. Once per 24 h (409 too_soon + retry_after_s); refused while the field is burned (409 halted). Returns {season, closed, realized_pnl, account_usd}.',
    { confirm: confirmWord('RESET') },
    { modes: ACCOUNTS }),

  // auth and account
  command('auth_signup',
    'Create a garden and sign in (Set-Cookie). Returns {user}. Errors: 400 bad_username / weak_password, 403 signup_closed, 409 username_unavailable, 429, 503 signup_busy.',
    {
      username: username(),
      password: password('Password: 10–128 characters, not a common password, not containing the username.'),
      bootstrap_code: str('First-admin code (only while no admin exists).', { maxLength: 64 }),
      invite: str('Invite code (SIGNUP_MODE=invite).', { maxLength: 64 }),
      lang: str('Preferred language.', { enum: ['en', 'th'] }),
    },
    { auth: 'public', sensitive: true, modes: ACCOUNTS }),
  command('auth_login',
    'Sign in (Set-Cookie: session and known-device). Returns {user, notice?}. Errors: 401 bad_credentials, 403 account_disabled, 429.',
    { username: username(), password: password('Password.') },
    { auth: 'public', sensitive: true, modes: ACCOUNTS }),
  command('auth_reset',
    'Set a new password with an operator-issued one-time reset code. Signs out every other session. Returns {user} + Set-Cookie. Errors: 401 bad_credentials (any wrong, used or expired code), 400 weak_password, 429.',
    {
      username: username(),
      code: str('The reset code the operator gave you.', { required: true, maxLength: 64 }),
      new_password: password('New password.'),
    },
    { auth: 'public', sensitive: true, modes: ACCOUNTS }),
  command('auth_logout',
    'Sign out this session (also 200 without one); the cookie is cleared and this session\'s streams end.',
    {},
    { auth: 'public', modes: ACCOUNTS }),
  command('auth_logout_all',
    'Sign out everywhere: revoke every session of the player. Returns {ok, revoked}.',
    {},
    { modes: ACCOUNTS }),
  command('account_password',
    'Change the password: revokes every session and issues a fresh one to the caller (Set-Cookie).',
    { current_password: password('Current password.'), new_password: password('New password.') },
    { sensitive: true, modes: ACCOUNTS }),
  command('account_delete',
    'Delete the account and garden: paper bots close, testnet bots flatten (≤ 15 s), the testnet key is wiped and the username is retired. 409 testnet_positions_open (+ positions) unless force. Returns {deleted, closed, testnet_left_open}.',
    {
      password: password('Current password.'),
      confirm: confirmWord('DELETE'),
      force: bool('Delete even when testnet positions could not be closed.'),
    },
    { sensitive: true, modes: ACCOUNTS }),
  command('session_revoke',
    'Revoke one of the player\'s sessions by its public id (404 not_found for anything else).',
    { id: str('Session public id (from sessions).', { required: true, maxLength: 32 }) },
    { modes: ACCOUNTS }),

  // testnet
  command('testnet_connect',
    'Connect a Hyperliquid TESTNET API wallet (agent) of `account_address`: verified (agent of that account, never known on mainnet, funded), sealed with AES-256-GCM and stored. On a garden already connected to the same account this is Replace API wallet (bots kept). Returns {testnet, replaced, account, warnings}.',
    {
      account_address: str('Testnet account (master) address, 0x + 40 hex.', { required: true, maxLength: 64 }),
      agent_key: str('The API wallet\'s private key (64 hex). Never a seed phrase, never a mainnet key.', { required: true, maxLength: 200 }),
    },
    { sensitive: true, modes: ACCOUNTS }),
  command('testnet_verify',
    'Re-verify the stored testnet credential (testnet role, mainnet guard, expiry, balances). Returns the same shape as testnet_connect.',
    {},
    { modes: ACCOUNTS }),
  command('testnet_disconnect',
    'Disconnect the testnet account and wipe the stored key. 409 has_open_testnet_bots unless close_bots; 409 testnet_positions_open when the flatten fails, unless force. Returns {disconnected, closed, left_open}.',
    {
      close_bots: bool('Flatten and close the testnet bots first.'),
      force: bool('Disconnect even when testnet positions could not be closed.'),
    },
    { modes: ACCOUNTS }),
  command('testnet_agent_prepare',
    'P1 browser-wallet flow: the server makes an agent key and returns only {agent_address, nonce, agent_name}; the browser builds the Testnet-only approveAgent typed data itself.',
    {},
    { modes: ACCOUNTS }),
  command('testnet_agent_approve',
    'P1 browser-wallet flow: relay the wallet-signed approveAgent (Testnet only; the signer must be account_address), then verify as testnet_connect.',
    {
      account_address: str('The wallet address that signed.', { required: true, maxLength: 64 }),
      signature: str('65-byte signature, 0x hex.', { required: true, maxLength: 200 }),
      nonce: int('The nonce from testnet_agent_prepare.', { required: true, minimum: 0 }),
      chain_id: int('The wallet chain id used in the typed-data domain.', { required: true, minimum: 1 }),
    },
    { sensitive: true, modes: ACCOUNTS }),

  // admin
  command('admin_kill_switch',
    'Global testnet halt: every open testnet bot flattens and pauses; testnet planting is refused. Paper is unaffected.',
    { on: bool('Switch on (true) or off (false).', { required: true }), reason: str('Why (shown to players).', { maxLength: 200 }) },
    { auth: 'admin', modes: ACCOUNTS }),
  command('admin_testnet_signing',
    'Clear the global testnet signing halt (signature_mismatch) after a fix is deployed.',
    { resume: bool('Must be true.', { required: true }) },
    { auth: 'admin', modes: ACCOUNTS }),
  command('admin_caps',
    'Set caps for new bots: {paper, testnet} objects; with `user`, a per-user override. Returns {caps}.',
    {
      paper: obj('Paper caps: {max_bots, min_capital_usd, max_bot_capital_usd, max_total_notional_usd, account_usd} (any subset; positive numbers).'),
      testnet: obj('Testnet caps: {max_bots, min_capital_usd, max_bot_capital_usd, max_total_notional_usd} (any subset; positive numbers).'),
      user: str('Username for a per-user override.', { maxLength: 64 }),
    },
    { auth: 'admin', modes: ACCOUNTS }),
  command('admin_user',
    'Operator action on one user: disable | enable | halt | revoke_sessions | disconnect_testnet | reset_password | make_admin | remove_admin. make_admin / remove_admin need an admin session plus the caller\'s own password (never the Bearer token). reset_password returns {code, expires_ms} once.',
    {
      username: username('Target username.'),
      action: str('What to do.', { required: true, enum: ['disable', 'enable', 'halt', 'revoke_sessions', 'disconnect_testnet', 'reset_password', 'make_admin', 'remove_admin'] }),
      password: str('The calling admin\'s own password (required for make_admin / remove_admin).', { maxLength: 512 }),
    },
    { auth: 'admin', sensitive: true, modes: ACCOUNTS }),
  command('admin_backup',
    'Run an online database backup now (at most once per 10 min). Returns {file, bytes, ms}.',
    {},
    { auth: 'admin', modes: ACCOUNTS }),
  command('dev_double',
    'Development only (--testnet-double): script a fault in the in-process testnet double. 404 otherwise.',
    { fault: str('Fault name.', { required: true, maxLength: 64 }), args: obj('Fault arguments.') },
    { auth: 'admin', modes: ACCOUNTS }),
];

/** Deep-freeze so no caller can mutate the published catalogue. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export const OPS = deepFreeze(OPS_TABLE);

const OPS_BY_NAME = new Map(OPS.map((op) => [op.name, op]));

/** Look up an op by name → op or null. */
export function findOp(name) {
  return OPS_BY_NAME.get(name) ?? null;
}

/** True when `op` runs in `mode` ('none' | 'accounts'). */
export function opInMode(op, mode) {
  return Boolean(op && Array.isArray(op.modes) && op.modes.includes(mode));
}

// ---------------------------------------------------------------------------------------------
// Parameter coercion

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off']);
const INTEGER_RE = /^[+-]?\d+$/;
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * A 400 for a bad parameter, with the machine code `bad_request`. For sensitive ops (PLATFORM §5.3) coerceParams()
 * replaces the message with one that names only the parameter, never its value.
 */
function bad(message) {
  return Object.assign(new ApiError(400, message), { code: 'bad_request' });
}

/** Short printable form of a raw value for error messages. */
function show(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value); // JSON would say "null"
  let s;
  try { s = JSON.stringify(value) ?? String(value); } catch { s = String(value); }
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/** Absent = undefined, null or an empty / whitespace-only string. */
function isAbsent(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Coerce one scalar to `type`. `label` names the parameter in error messages.
 * Strings come from query strings; numbers / booleans may come from JSON bodies.
 */
function coerceScalar(type, value, label) {
  switch (type) {
    case 'string':
      if (typeof value === 'string') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      throw bad(`parameter '${label}' must be a string (got ${show(value)})`);

    case 'integer': {
      let n = value;
      if (typeof value === 'string') {
        const t = value.trim();
        if (!INTEGER_RE.test(t)) throw bad(`parameter '${label}' must be an integer (got ${show(value)})`);
        n = Number(t);
      }
      if (typeof n !== 'number' || !Number.isInteger(n)) {
        throw bad(`parameter '${label}' must be an integer (got ${show(value)})`);
      }
      if (!Number.isSafeInteger(n)) throw bad(`parameter '${label}' is out of range (got ${show(value)})`);
      return n;
    }

    case 'number': {
      let n = value;
      if (typeof value === 'string') {
        const t = value.trim();
        if (!NUMBER_RE.test(t)) throw bad(`parameter '${label}' must be a number (got ${show(value)})`);
        n = Number(t);
      }
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw bad(`parameter '${label}' must be a finite number (got ${show(value)})`);
      }
      return n;
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === 0) return value === 1;
      if (typeof value === 'string') {
        const t = value.trim().toLowerCase();
        if (TRUE_WORDS.has(t)) return true;
        if (FALSE_WORDS.has(t)) return false;
      }
      throw bad(`parameter '${label}' must be a boolean: 1|true|yes|on or 0|false|no|off (got ${show(value)})`);
    }

    default:
      throw new ApiError(500, `catalog: unsupported parameter type '${type}' for '${label}'`);
  }
}

const splitCsv = (s) => s.split(',').map((x) => x.trim()).filter((x) => x !== '');

/**
 * Turn a raw array value into a list of raw items. Accepts:
 *   - a CSV string                "1,2,3"
 *   - a string holding JSON       "[1,2,3]"
 *   - a real array (JSON body, or repeated query keys ?ids=1&ids=2,3) — string elements are CSV-split
 *   - a bare number (one id sent as a JSON number)
 */
function splitArray(value, label) {
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t.startsWith('[')) return splitCsv(t);
    let parsed;
    try { parsed = JSON.parse(t); } catch { throw bad(`parameter '${label}' is not a valid JSON array`); }
    if (!Array.isArray(parsed)) throw bad(`parameter '${label}' must be an array`);
    return parsed;
  }
  if (Array.isArray(value)) return value.flatMap((v) => (typeof v === 'string' ? splitCsv(v) : [v]));
  if (typeof value === 'number') return [value];
  throw bad(`parameter '${label}' must be an array or a comma-separated list (got ${show(value)})`);
}

function checkBounds(spec, value, label) {
  if (spec.minimum !== undefined && value < spec.minimum) {
    throw bad(`parameter '${label}' must be ≥ ${spec.minimum} (got ${value})`);
  }
  if (spec.maximum !== undefined && value > spec.maximum) {
    throw bad(`parameter '${label}' must be ≤ ${spec.maximum} (got ${value})`);
  }
}

/** Coerce an array parameter → typed items; an empty list stays an empty list (a filter that matches nothing). */
function coerceArray(spec, value, name) {
  const itemType = spec.items?.type ?? 'string';
  const items = splitArray(value, name).map((item, i) => {
    if (isAbsent(item)) throw bad(`parameter '${name}[${i}]' is empty`);
    return coerceScalar(itemType, item, `${name}[${i}]`);
  });
  if (spec.minItems !== undefined && items.length < spec.minItems) {
    throw bad(`parameter '${name}' needs at least ${spec.minItems} item(s)`);
  }
  if (spec.maxItems !== undefined && items.length > spec.maxItems) {
    throw bad(`parameter '${name}' takes at most ${spec.maxItems} items (got ${items.length})`);
  }
  return items;
}

const MAX_OBJECT_KEYS = 32;

/**
 * Coerce an object parameter: a plain JSON object (body), or a string holding one (≤ 4000 chars). Values must be
 * JSON scalars; the op's handler validates the keys it knows.
 */
function coerceObject(value, name) {
  let o = value;
  if (typeof value === 'string') {
    if (value.length > 4000) throw bad(`parameter '${name}' is too long`);
    try { o = JSON.parse(value); } catch { throw bad(`parameter '${name}' must be a JSON object`); }
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw bad(`parameter '${name}' must be a JSON object`);
  const keys = Object.keys(o);
  if (keys.length > MAX_OBJECT_KEYS) throw bad(`parameter '${name}' has more than ${MAX_OBJECT_KEYS} keys`);
  const out = {};
  for (const k of keys) {
    const v = o[k];
    if (v !== null && typeof v === 'object') throw bad(`parameter '${name}.${k}' must be a number, string or boolean`);
    out[k] = v;
  }
  return out;
}

/** Coerce a scalar parameter → typed value (type, bounds, enum, maxLength). */
function coerceValue(spec, value, name) {
  if (spec.type === 'object') return coerceObject(value, name);
  if (Array.isArray(value)) {
    // A JSON array, or the same key repeated in the query string (?a=1&a=2).
    throw bad(`parameter '${name}' must be a single ${spec.type}, given ${value.length} values`);
  }
  const out = coerceScalar(spec.type, value, name);
  if (spec.type === 'integer' || spec.type === 'number') checkBounds(spec, out, name);
  if (spec.type === 'string' && spec.maxLength !== undefined && out.length > spec.maxLength) {
    throw bad(`parameter '${name}' is longer than ${spec.maxLength} characters`);
  }
  if (spec.enum && !spec.enum.includes(out)) {
    throw bad(`parameter '${name}' must be one of: ${spec.enum.join(', ')} (got ${show(out)})`);
  }
  return out;
}

/**
 * Validate and type the raw parameters of an operation (SPEC §3).
 *
 * @param {object|string} op  an OPS entry or an op name
 * @param {object} raw        name → raw value. Query-string values are strings (an array of strings
 *                            when a key is repeated); JSON-body values may already be typed.
 *                            Absent = undefined, null or '' — except for arrays, where a PRESENT key with an
 *                            empty value ("ids=", "ids=,,", "[]") is an empty list, not "no filter".
 * @param {object} [opts]
 * @param {boolean} [opts.redact]  sensitive op (PLATFORM §5.3): error messages never echo a value nor an unknown
 *                                 parameter name (a name can be a pasted secret too)
 * @returns {object} typed params: every known parameter that was given, plus defaults.
 * @throws {ApiError} 400 on unknown parameter, bad type, enum miss, bound violation or missing required;
 *                    404 when `op` names no operation.
 */
export function coerceParams(op, raw = {}, { redact = false } = {}) {
  const def = typeof op === 'string' ? findOp(op) : op;
  if (!def || typeof def !== 'object' || !def.params) {
    throw new ApiError(404, `unknown operation '${typeof op === 'string' ? op : op?.name}'`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw bad('parameters must be an object');
  }

  const specs = def.params;
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(specs, key)) {
      if (redact) throw bad(`unknown parameter for ${def.name} (known: ${Object.keys(specs).join(', ')})`);
      const known = Object.keys(specs);
      throw bad(`unknown parameter '${key}' for ${def.name}` +
        (known.length ? ` (known: ${known.join(', ')})` : ' (it takes no parameters)'));
    }
  }

  const out = {};
  for (const [name, spec] of Object.entries(specs)) {
    const value = Object.hasOwn(raw, name) ? raw[name] : undefined;
    let typed = null;
    try {
      if (spec.type === 'array') {
        // A client that builds ids from an empty selection must get nothing back, not everything.
        if (value !== undefined && value !== null) typed = coerceArray(spec, value, name);
      } else if (!isAbsent(value)) {
        typed = coerceValue(spec, value, name);
      }
    } catch (err) {
      // Never echo a sensitive value: keep only which parameter was wrong.
      if (redact && err instanceof ApiError) throw bad(`parameter '${name}' is not valid`);
      throw err;
    }
    if (typed !== null) {
      out[name] = typed;
    } else if (spec.required) {
      throw bad(`missing required parameter '${name}' for ${def.name}`);
    } else if (spec.default !== undefined) {
      out[name] = Array.isArray(spec.default) ? [...spec.default] : spec.default;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Markdown reference (served at GET /docs)

function mdCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function paramType(spec) {
  if (spec.type === 'array') return `${spec.items?.type ?? 'string'}[]`; // not array<…>: markdown would eat it as HTML
  return spec.type;
}

function paramNotes(spec) {
  const notes = [spec.description];
  if (spec.enum) {
    const shown = spec.enum.length > 12 ? `${spec.enum.filter((v) => !v.startsWith('-')).join(', ')} (each also with a \`-\` prefix)` : spec.enum.join(', ');
    notes.push(`One of: ${shown}.`);
  }
  if (spec.minimum !== undefined || spec.maximum !== undefined) {
    if (spec.maximum === undefined) notes.push(`Minimum ${spec.minimum}.`);
    else if (spec.minimum === undefined) notes.push(`Maximum ${spec.maximum}.`);
    else notes.push(`Range ${spec.minimum}..${spec.maximum}.`);
  }
  if (spec.maxItems !== undefined) notes.push(`At most ${spec.maxItems} items.`);
  return notes.join(' ');
}

function opSection(op) {
  const access = `Access: \`${op.auth}\`${op.sensitive ? ' · sensitive (params never logged)' : ''} · modes: ${op.modes.join(', ')}`;
  const lines = [`### \`${op.name}\``, '', `\`${op.method} ${op.path}\``, '', op.description, '', access, ''];
  const params = Object.entries(op.params);
  if (params.length === 0) {
    lines.push('_No parameters._', '');
  } else {
    lines.push('| param | type | required | default | notes |', '|---|---|---|---|---|');
    for (const [name, spec] of params) {
      const dflt = spec.default === undefined ? '' : `\`${JSON.stringify(spec.default)}\``;
      lines.push(`| \`${name}\` | ${paramType(spec)} | ${spec.required ? 'yes' : ''} | ${dflt} | ${mdCell(paramNotes(spec))} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const NONE_POLICY_LINES = (commandPolicy) => [
  '## Command policy',
  '',
  `This server currently runs with command policy **\`${commandPolicy}\`**. A command is allowed when:`,
  '',
  '1. it carries the server token (`Authorization: Bearer <token>` or `X-Brood-Token: <token>`), from anywhere; or',
  '2. it comes from a loopback address with no proxy headers (`X-Forwarded-For`, `CF-Connecting-IP`, `X-Real-IP`,',
  '   `Forwarded`), a `Host` of `localhost`, `127.0.0.1` or `[::1]` (any port), and either no `Origin` or the',
  '   request\'s own origin.',
  '',
  'Anything else gets `401`. CORS is open (`Access-Control-Allow-Origin: *`) so browser apps on other origins can read',
  'queries and send token-bearing commands; tokenless cross-origin commands are always refused.',
  '',
  'Ops marked `modes: accounts` answer `404 {"code":"accounts_disabled"}` on this server.',
];

const ACCOUNTS_POLICY_LINES = [
  '## Command policy: sessions (accounts mode)',
  '',
  'This server runs with **accounts**: players sign up and sign in (`auth_signup`, `auth_login`) and get an',
  '`HttpOnly`, `SameSite=Lax` session cookie (`__Host-bean_sid` over https). Every op has an access class:',
  '',
  '- `public` — anyone, no session (spectators see the island, the market and the beans);',
  '- `user` — a valid session (else `401 {"code":"auth_required"}`, or `session_expired` for a stale cookie);',
  '- `admin` — an admin session, or `Authorization: Bearer <ADMIN_TOKEN>` from a direct loopback peer (the',
  '  operator\'s `admin-cli`). The Bearer token never unlocks `user` ops nor `make_admin` / `remove_admin`.',
  '',
  'Commands take parameters **only from a JSON body** (`Content-Type: application/json`): a POST with a query string',
  'is refused with `400 query_params_not_allowed` before its body is read. Cross-site requests are refused (`403',
  'csrf`; `Origin` must equal the public origin, or `Sec-Fetch-Site: same-origin`), and the `Host` must match',
  '(`421 misdirected`). Only public GET queries carry `Access-Control-Allow-Origin: *`.',
  '',
  'Every error carries a machine `code` next to `error` and `status` (list: `ERROR_CODES` in server/catalog.js;',
  '`429` adds `retry_after_s` and a `Retry-After` header).',
];

/**
 * Render the API reference as markdown from OPS.
 * @param {{version?: string, commandPolicy?: 'token'|'loopback'|'session'}} info
 */
export function docsMarkdown({ version = '', commandPolicy = 'loopback' } = {}) {
  const accounts = commandPolicy === 'session';
  const queries = OPS.filter((op) => op.kind === 'query');
  const commands = OPS.filter((op) => op.kind === 'command');
  const streamKinds = accounts ? [...STREAM_ONLY_KINDS, ...ACCOUNTS_STREAM_ONLY_KINDS] : STREAM_ONLY_KINDS;
  const out = [
    `# bean-garden API${version ? ` v${version}` : ''}`,
    '',
    'The Bean Garden backend: REAL prices (read-only Hyperliquid public data, or a synthetic sim feed), PAPER trades.',
    accounts
      ? 'In accounts mode a player may also connect a Hyperliquid TESTNET API wallet: testnet bots send real IOC orders on testnet (test funds). Mainnet orders are impossible by construction. This page is generated from the operation catalogue.'
      : 'No real orders, no keys, no signing — ever. This page is generated from the operation catalogue.',
    '',
    '## Conventions',
    '',
    '- **Queries:** `GET /api/v1/<name>?param=value` → JSON. Never mutate anything; never need a token.',
    accounts
      ? '- **Commands:** `POST /api/v1/<name>` with a JSON object body (query-string params are refused).'
      : '- **Commands:** `POST /api/v1/<name>` with a JSON object body (query-string params are accepted too; the body wins).',
    '- **Discovery:** `GET /api/v1` returns the operation index; this page is `GET /docs`.',
    '- **Errors:** `{"error": "...", "status": <code>}` with the same HTTP status — `400` bad parameter (unknown name,',
    '  wrong type, enum miss, out of range, missing required, invalid JSON), `401` command auth, `404` unknown op / bean / bot,',
    '  `405` wrong method (queries are GET, commands are POST), `409` refused by the live layer, `413` body over 64 KB, `500` anything else.',
    '- **Parameter types** are coerced from strings: integers (must be integral), numbers, booleans',
    '  (`1|true|yes|on` / `0|false|no|off`) and arrays (CSV `1,2,3` or a JSON array `[1,2,3]`). Unknown parameters are rejected.',
    '- **Time:** `*_ms` fields and journal `t` are Unix epoch milliseconds; `tick` / `bar` are logical clocks',
    '  (1 tick = 1 bar = 1 minute: a real wall-clock minute with real prices, a simulated one with the sim feed).',
    '',
    ...(accounts ? ACCOUNTS_POLICY_LINES : NONE_POLICY_LINES(commandPolicy)),
    '',
    '## Event stream',
    '',
    '`GET /api/v1/events/stream` is a Server-Sent Events stream of journal records. Each record arrives as',
    '`id: <seq>` / `event: <kind>` / `data: <json record>`; a `: ping` comment is sent every 15 s. Reconnecting',
    'clients that send `Last-Event-ID` get the records they missed replayed first.',
    ...(accounts
      ? ['', 'Accounts mode: a stream opened with a session receives the global records plus the player\'s own records;',
        'a spectator stream receives global records only. A `Last-Event-ID` too old to replay answers `event: resync`.']
      : []),
    '',
    'Every record is `{seq, t, kind, ...fields}`:',
    '',
    '| kind | fields |',
    '|---|---|',
    ...EVENT_KINDS.map((k) => `| \`${k}\` | ${mdCell(EVENT_FIELDS[k] ?? '')}${accounts && ACCOUNTS_EVENT_FIELDS[k] ? ` ${mdCell(ACCOUNTS_EVENT_FIELDS[k])}` : ''} |`),
    ...(accounts ? ACCOUNTS_EVENT_KINDS.map((k) => `| \`${k}\` | ${mdCell(ACCOUNTS_EVENT_FIELDS[k] ?? '')} |`) : []),
    '',
    '### Ephemeral stream-only events',
    '',
    'These arrive on the same stream as `event: <kind>` / `data: <json>` but **without an `id:` line**: they never',
    'touch `Last-Event-ID`, are never replayed, are not journaled and are not returned by `events`. `mids` is sent',
    'after each successful Hyperliquid allMids poll (~5 s, real prices) and after every tick (both feeds).',
    '',
    '| kind | fields |',
    '|---|---|',
    ...streamKinds.map((k) => `| \`${k}\` | ${mdCell((accounts ? ACCOUNTS_STREAM_ONLY_FIELDS[k] : null) ?? STREAM_ONLY_FIELDS[k] ?? '')} |`),
    '',
    '## Queries',
    '',
    ...queries.map(opSection),
    '## Commands',
    '',
    ...commands.map(opSection),
    '## Vocabulary',
    '',
    `- **archetypes:** ${ARCHETYPE_NAMES.join(', ')}`,
    `- **strategies:** ${STRATEGY_ENUM.join(', ')}`,
    `- **sort keys:** ${SORT_KEYS.join(', ')} (prefix \`-\` for descending)`,
    `- **bot states:** ${BOT_STATES.join(', ')}`,
    `- **venues:** ${VENUES.join(', ')}`,
    `- **error codes:** ${ERROR_CODES.join(', ')}`,
    '',
  ];
  return out.join('\n');
}

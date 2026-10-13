/**
 * ui/codes.js — the machine codes and event kinds of the platform contract, as the browser knows them
 * (PLATFORM.md §8.5 note_code, §8.7 kinds, §8.9 error codes, §6.9 exchange codes). PURE data.
 *
 * The server is the source of truth: `server/catalog.js` exports ERROR_CODES and `server/hl/errors.js`
 * exports EXCHANGE_CODES / NOTE_CODES. test/game-platform.test.js checks that every code from BOTH places has
 * an EN and a TH string (`g.err.<code>`, `g.note.<code>`), so a code added on the server without copy fails the
 * build. These client lists exist so the UI can tell "a code we localize" from "an unknown code" without a
 * server round trip, and so the test still covers the contract while the server modules are being built.
 *
 * No DOM, no three.js, no side effects at import.
 */

/** §8.9 HTTP error codes (the additive `code` of an error body). */
export const ERROR_CODES = Object.freeze([
  // 400
  'bad_request', 'bad_username', 'weak_password', 'bad_address', 'bad_key_format', 'confirm_required', 'invalid_json', 'query_params_not_allowed',
  // 401
  'auth_required', 'session_expired', 'bad_credentials',
  // 403
  'csrf', 'forbidden', 'account_disabled', 'signup_closed', 'session_required',
  // 404
  'not_found', 'accounts_disabled',
  // 409
  'conflict', 'halted', 'not_tradeable', 'caps', 'stale', 'username_unavailable', 'already_connected', 'agent_in_use', 'account_in_use',
  'has_open_testnet_bots', 'testnet_positions_open', 'testnet_needs_accounts', 'too_soon',
  'not_connected', 'credential_revoked', 'agent_expiring', 'unlisted_testnet', 'delisted_testnet', 'busted', 'bean_bound', 'coin_bound',
  'leverage', 'no_testnet_price', 'testnet_caps', 'insufficient_testnet_balance', 'thin_book', 'divergence_ack',
  // 413 / 415 / 421
  'body_too_large', 'unsupported_media_type', 'misdirected',
  // 422
  'seed_phrase', 'master_key', 'mainnet_key', 'not_agent', 'agent_mismatch', 'agent_expired', 'abstraction_unsupported', 'no_testnet_funds', 'signer_mismatch',
  // 429 / 502 / 503
  'rate_limited', 'testnet_error',
  'testnet_disabled', 'testnet_down', 'kill_switch', 'testnet_capacity', 'busy', 'server_restarting', 'signup_busy', 'mainnet_check_unavailable',
]);

/** §6.9 exchange codes (live_error.code, bot_sync.code, orders.code), plus the warnings that travel the same way. */
export const EXCHANGE_CODES = Object.freeze([
  'transport', 'ip_rate_limited', 'client_error', 'address_rate_limited', 'nonce', 'signature_mismatch', 'agent_unknown', 'no_deposit',
  'min_notional', 'insufficient_margin', 'ioc_no_match', 'reduce_only', 'price_band', 'tick', 'leverage_rejected', 'oi_cap', 'rejected_other',
  'below_min_order', 'address_budget_low', 'agent_expiring',
]);

/** §8.5 pause note codes (BotRow.note_code, bot_paused.note_code). */
export const NOTE_CODES = Object.freeze([
  'liquidated_testnet', 'external_close', 'position_drift', 'credential_revoked', 'kill_switch', 'leverage_rejected',
  'insufficient_margin_repeat', 'agent_expiring', 'inactive', 'mainnet_key', 'account_moved', 'fills_beyond_horizon', 'no_deposit',
]);

/** §8.7 record kinds the diary must turn into a line (global + user; the stream-only ones except `mids`). */
export const DIARY_KINDS = Object.freeze([
  // global (unchanged)
  'warmup_finished', 'tick_completed', 'busted', 'daemon_started', 'feed_status', 'feed_gap',
  // global (new)
  'kill_switch', 'testnet_feed',
  // user (existing, now scoped)
  'bot_created', 'bot_order', 'bot_fill', 'bot_paused', 'bot_resumed', 'bot_closed', 'live_error', 'live_halted',
  // user (new)
  'bot_sync', 'bot_fill_confirmed', 'testnet_account', 'credential_status', 'garden_rearmed', 'garden_reset', 'password_reset',
  // stream-only (no id)
  'session_ended', 'resync', 'server_restart',
]);

/**
 * Every `reason` the server puts on credential_status {status:'revoked'} (gardens.js: the player's disconnect, the
 * account moving to another garden, a mainnet hit; admin.js: operator disconnect and password reset; the venue's
 * markRevoked and testnet_verify: agent_unknown and the §6.7 verify codes). The diary has a localised line for each.
 */
export const CREDENTIAL_REASONS = Object.freeze([
  'disconnected', 'admin_disconnect', 'password_reset', 'account_moved', 'mainnet_key', 'agent_unknown', 'not_agent',
  'agent_mismatch', 'agent_expired', 'master_key',
]);

/** §7.3 stake-independent testnet checks (the venue control's enable rule) and the stake-dependent ones. */
export const VENUE_REASONS = Object.freeze([
  'testnet_disabled', 'kill_switch', 'halted', 'not_connected', 'credential_revoked', 'testnet_down', 'agent_expiring', 'testnet_capacity',
  'unlisted_testnet', 'delisted_testnet', 'busted', 'bean_bound', 'coin_bound', 'leverage', 'no_testnet_price', 'stale', 'insufficient_testnet_balance',
]);
export const STAKE_REASONS = Object.freeze(['testnet_caps', 'insufficient_testnet_balance', 'thin_book', 'divergence_ack']);

-- 0001_init.sql — the platform schema (PLATFORM.md §3.3). Accounts mode only; none mode never opens SQLite.
--
-- Rules (§3.4): forward-only, never edited after release (a checksum mismatch refuses to start), applied by
-- server/db/migrate.js inside one BEGIN IMMEDIATE transaction. This file must not contain BEGIN/COMMIT.
-- Every table is STRICT. Values reach SQL only through `?` bindings (§3.2).
--
-- Additive deviations from the §3.3 listing (indexes only; no column or constraint differs):
--   * fills_by_order        — fills.order_id REFERENCES orders(id) ON DELETE SET NULL: without an index on the
--                             child column, every deleted order (retention, cascades) scans all fills.
--   * sessions_by_user_all  — sessions.user_id REFERENCES users(id) ON DELETE CASCADE: the partial
--                             sessions_by_user index cannot serve the cascade's child lookup.
--   * sessions_by_revoked   — retention deletes sessions revoked > 30 days ago in 1,000-row slices (§3.4).
--   * orders_by_user        — retention keeps the newest 20,000 orders per user (§3.4): finding the cut-off row
--                             by (user_id, id) must not sort every order of the user.

CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  checksum    TEXT    NOT NULL,                 -- sha256 hex of the migration file text
  applied_ms  INTEGER NOT NULL
) STRICT;

-- AUTOINCREMENT on users, sessions and orders: SQLite then never reuses an id after the newest row is deleted.
-- Without it, the next sign-up would inherit a deleted player's uid (audit history, lanes, caches), and orders.id
-- would repeat after a delete.
CREATE TABLE users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT, -- uid >= 1 (0 is reserved for the implicit none-mode player)
  username         TEXT    NOT NULL UNIQUE,       -- canonical form (§4.1): NFKC, lower-case, ^[a-z0-9_]{3,24}$
  pw_hash          TEXT    NOT NULL,              -- "scrypt$v=1$N=32768,r=8,p=3$<salt b64url>$<dk b64url>"
  role             TEXT    NOT NULL DEFAULT 'player' CHECK (role IN ('player','admin')),
  status           TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  lang             TEXT    CHECK (lang IS NULL OR lang IN ('en','th')),
  created_ms       INTEGER NOT NULL,
  updated_ms       INTEGER NOT NULL,
  pw_changed_ms    INTEGER NOT NULL,
  last_login_ms    INTEGER,
  failed_logins    INTEGER NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),   -- consecutive; persisted so a flood
  locked_until_ms  INTEGER,                                                 -- of other keys cannot evict it (§4.5)
  reset_hash       BLOB    CHECK (reset_hash IS NULL OR length(reset_hash) = 32), -- SHA-256 of an admin reset code
  reset_expires_ms INTEGER,                                                 -- (§4.6 step 8); single use
  CHECK (length(username) BETWEEN 3 AND 24)
) STRICT;

CREATE TABLE retired_usernames (               -- deleted accounts' names stay unavailable forever (§4.6)
  username    TEXT    PRIMARY KEY CHECK (length(username) BETWEEN 3 AND 24),
  retired_ms  INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,                           -- internal only; never sent to clients
  public_id        TEXT    NOT NULL UNIQUE CHECK (length(public_id) = 22),      -- 16 random bytes, base64url (the id clients see)
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       BLOB    NOT NULL UNIQUE CHECK (length(token_hash) = 32),     -- SHA-256(raw token bytes)
  prev_hash        BLOB    UNIQUE CHECK (prev_hash IS NULL OR length(prev_hash) = 32),
  prev_valid_ms    INTEGER,                                                     -- rotation grace end
  created_ms       INTEGER NOT NULL,
  rotated_ms       INTEGER NOT NULL,
  last_seen_ms     INTEGER NOT NULL,
  expires_ms       INTEGER NOT NULL,                                            -- absolute expiry
  revoked_ms       INTEGER,
  user_agent       TEXT    CHECK (user_agent IS NULL OR length(user_agent) <= 200),
  ip_prefix        TEXT    CHECK (ip_prefix IS NULL OR length(ip_prefix) <= 64) -- /24 (v4) or /48 (v6); for the session list
) STRICT;
CREATE INDEX sessions_by_user ON sessions(user_id) WHERE revoked_ms IS NULL;
CREATE INDEX sessions_by_user_all ON sessions(user_id);
CREATE INDEX sessions_by_expiry ON sessions(expires_ms);
CREATE INDEX sessions_by_revoked ON sessions(revoked_ms) WHERE revoked_ms IS NOT NULL;

CREATE TABLE credentials (
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue            TEXT    NOT NULL CHECK (venue = 'hl_testnet'),
  account_address  TEXT    NOT NULL CHECK (length(account_address) = 42 AND account_address GLOB '0x[0-9a-f]*'),
  agent_address    TEXT    NOT NULL CHECK (length(agent_address) = 42 AND agent_address GLOB '0x[0-9a-f]*'),
  agent_name       TEXT,
  valid_until_ms   INTEGER,                     -- from extraAgents; NULL = unknown / no expiry reported
  key_ct           BLOB    NOT NULL CHECK (length(key_ct) = 32),    -- AES-256-GCM ciphertext of the 32-byte key
  key_iv           BLOB    NOT NULL CHECK (length(key_iv) = 12),
  key_tag          BLOB    NOT NULL CHECK (length(key_tag) = 16),
  key_id           TEXT    NOT NULL CHECK (length(key_id) = 16),    -- kid of the master key that sealed it (§5.1)
  enc_version      INTEGER NOT NULL DEFAULT 1,
  status           TEXT    NOT NULL CHECK (status IN ('pending','verified','revoked','error')),
  status_reason    TEXT,                                            -- machine code (§8.9), never key material
  abstraction      TEXT    CHECK (abstraction IS NULL OR abstraction IN ('default','disabled','unifiedAccount')),
  last_nonce       INTEGER NOT NULL DEFAULT 0 CHECK (last_nonce >= 0),
  verified_ms      INTEGER,
  mainnet_checked_ms INTEGER,                                       -- last fail-closed mainnet userRole check (§6.7)
  expiry_flags     INTEGER NOT NULL DEFAULT 0,                      -- bit 1: 7-day warning sent; 2: 1-day; 4: pre-expiry flatten done
  value_at_connect REAL,                                            -- testnet account value at connect (barn comparison, §9.4)
  created_ms       INTEGER NOT NULL,
  updated_ms       INTEGER NOT NULL,
  PRIMARY KEY (user_id, venue)
) STRICT;
-- Partial: a revoked or error row never blocks a new connect of the same agent or account (§6.7 step 8).
CREATE UNIQUE INDEX credentials_agent   ON credentials(agent_address)
  WHERE status IN ('pending','verified');                          -- one live agent <-> one garden (nonce safety)
CREATE UNIQUE INDEX credentials_account ON credentials(account_address)
  WHERE status IN ('pending','verified');                          -- one live testnet account <-> one garden (attribution)
CREATE INDEX credentials_by_kid ON credentials(key_id);
CREATE INDEX credentials_mainnet_due ON credentials(mainnet_checked_ms) WHERE status = 'verified';

CREATE TABLE gardens (
  user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  epoch              TEXT    NOT NULL CHECK (length(epoch) = 16),        -- random hex at creation; lane jobs check it (§7.2)
  season             INTEGER NOT NULL DEFAULT 1 CHECK (season >= 1),     -- paper season (garden_reset, §8.4)
  season_started_ms  INTEGER NOT NULL,
  last_reset_ms      INTEGER,
  last_active_ms     INTEGER NOT NULL,                                   -- authenticated activity, written <= once per 5 min (§4.6)
  account_usd        REAL    NOT NULL CHECK (account_usd > 0),           -- paper start of the current season
  next_bot_index     INTEGER NOT NULL DEFAULT 0 CHECK (next_bot_index >= 0),  -- never reset (bot ids are never reused)
  halted             INTEGER NOT NULL DEFAULT 0 CHECK (halted IN (0,1)),
  halted_ms          INTEGER,
  fills_logged       INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  last_error_ms      INTEGER,
  last_reconcile_ms  INTEGER,
  last_tick          INTEGER,
  caps_json          TEXT,                     -- admin per-user cap overrides (JSON object) or NULL
  created_ms         INTEGER NOT NULL,
  updated_ms         INTEGER NOT NULL
) STRICT;

CREATE TABLE bots (
  user_id      INTEGER NOT NULL REFERENCES gardens(user_id) ON DELETE CASCADE,
  id           TEXT    NOT NULL CHECK (id GLOB 'bot-[0-9][0-9][0-9][0-9]*'),
  idx          INTEGER NOT NULL CHECK (idx >= 0),
  venue        TEXT    NOT NULL CHECK (venue IN ('paper','testnet')),
  bean         INTEGER NOT NULL CHECK (bean >= 0),
  coin         TEXT    NOT NULL,
  asset        INTEGER,                        -- testnet asset index at creation (re-checked against the listing)
  capital_usd  REAL    NOT NULL CHECK (capital_usd > 0),
  leverage     INTEGER NOT NULL CHECK (leverage >= 1),
  state        TEXT    NOT NULL CHECK (state IN ('active','paused','closed')),
  created_ms   INTEGER NOT NULL,
  updated_ms   INTEGER NOT NULL,
  closed_ms    INTEGER,
  data_json    TEXT    NOT NULL,               -- the remaining in-memory bot fields (real{}, counters, note, exchange{},
                                               -- exchange_sync{}, size_ratio{}, ...); sanitizeBot() validates on load
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, idx)
) STRICT;
CREATE UNIQUE INDEX bots_one_open_coin ON bots(user_id, coin) WHERE state <> 'closed';
CREATE UNIQUE INDEX bots_one_open_bean ON bots(user_id, bean) WHERE state <> 'closed';
CREATE INDEX bots_open ON bots(user_id) WHERE state <> 'closed';
CREATE INDEX bots_open_testnet ON bots(user_id) WHERE state <> 'closed' AND venue = 'testnet';

CREATE TABLE orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES gardens(user_id) ON DELETE CASCADE,
  bot_id       TEXT    NOT NULL,
  venue        TEXT    NOT NULL CHECK (venue IN ('paper','testnet')),
  season       INTEGER NOT NULL DEFAULT 1,     -- paper season at insert (testnet rows keep the season of insert; unused)
  kind         TEXT    NOT NULL CHECK (kind IN ('mirror','flatten','leverage')),
  coin         TEXT    NOT NULL,
  sz           REAL    NOT NULL,               -- signed requested size (0 for leverage)
  px           REAL,                           -- paper: fill price; testnet: limit price sent
  reduce_only  INTEGER NOT NULL DEFAULT 0 CHECK (reduce_only IN (0,1)),
  status       TEXT    NOT NULL CHECK (status IN
                 ('filled','skipped','pending','sent','partial','canceled','rejected','error','unknown')),
  reason       TEXT,                           -- tick | create | resume | pause | close | halt | kill | notional_cap | ...
  code         TEXT,                           -- exchange error code (§6.9) for rejected/error
  error        TEXT,                           -- exchange error text, truncated to 300 chars; never contains secrets
  cloid        TEXT    UNIQUE CHECK (cloid IS NULL OR (length(cloid) = 34 AND cloid GLOB '0x[0-9a-f]*')),
                                               -- 16 random bytes (§6.6), committed before the POST
  oid          INTEGER,
  nonce        INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,     -- transmissions of the same signed bytes (§6.6)
  transport_failed INTEGER NOT NULL DEFAULT 0 CHECK (transport_failed IN (0,1)), -- any earlier transmission failed in transport
  leverage     INTEGER,                        -- kind = 'leverage'
  filled_sz    REAL,                           -- from orderStatus (origSz - sz) or the order response
  avg_px       REAL,                           -- from the order response; replaced by the fills' weighted px
  tick         INTEGER,
  time_ms      INTEGER NOT NULL,
  sent_ms      INTEGER,
  done_ms      INTEGER,
  replay       INTEGER NOT NULL DEFAULT 0 CHECK (replay IN (0,1))
) STRICT;
CREATE INDEX orders_by_bot ON orders(user_id, bot_id, id DESC);
CREATE INDEX orders_inflight ON orders(status) WHERE status IN ('pending','sent','unknown');
CREATE INDEX orders_by_user ON orders(user_id, id DESC);

CREATE TABLE fills (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES gardens(user_id) ON DELETE CASCADE,
  bot_id       TEXT    NOT NULL,
  venue        TEXT    NOT NULL CHECK (venue IN ('paper','testnet')),
  season       INTEGER NOT NULL DEFAULT 1,     -- paper season at insert
  coin         TEXT    NOT NULL,
  dir          TEXT    NOT NULL CHECK (length(dir) BETWEEN 1 AND 64), -- raw display text; testnet sends more than the
                                               -- four paper values (liquidations, ADL, settlement, flips). Our own
                                               -- open/close logic derives from side, start_position and sz, never dir.
  start_position REAL,                         -- testnet `startPosition` (signed); NULL for paper
  side         TEXT    NOT NULL CHECK (side IN ('B','A')),
  sz           REAL    NOT NULL CHECK (sz > 0),
  px           REAL    NOT NULL CHECK (px > 0),
  fee          REAL    NOT NULL,
  closed_pnl   REAL    NOT NULL,
  time_ms      INTEGER NOT NULL,
  tick         INTEGER,
  liquidation  INTEGER NOT NULL DEFAULT 0 CHECK (liquidation IN (0,1)), -- testnet: the fill carries a `liquidation` object
  replay       INTEGER NOT NULL DEFAULT 0 CHECK (replay IN (0,1)),
  order_id     INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  oid          INTEGER,                        -- testnet
  tid          INTEGER,                        -- testnet trade id (NULL while provisional)
  hash         TEXT,                           -- testnet tx hash
  provisional  INTEGER NOT NULL DEFAULT 0 CHECK (provisional IN (0,1)),  -- 1 = from the order response, fee estimated
  UNIQUE (user_id, venue, tid)
) STRICT;
CREATE INDEX fills_by_bot  ON fills(user_id, bot_id, id DESC);
CREATE INDEX fills_by_user ON fills(user_id, id DESC);
CREATE INDEX fills_provisional ON fills(user_id) WHERE provisional = 1;
CREATE INDEX fills_by_order ON fills(order_id);

CREATE TABLE events (
  seq        INTEGER PRIMARY KEY,              -- the journal's GLOBAL seq (shared space with global records)
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  t          INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  data_json  TEXT    NOT NULL                  -- the record minus seq/t/kind
) STRICT;
CREATE INDEX events_by_user ON events(user_id, seq DESC);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  at_ms        INTEGER NOT NULL,
  user_id      INTEGER,                        -- no FK: the row survives account deletion (id only; uids are never reused)
  actor        TEXT    NOT NULL CHECK (actor IN ('user','admin','system','ops')),
  action       TEXT    NOT NULL,               -- §5.4 allowlist (signup, login_ok, login_fail, logout, ...)
  target       TEXT,                           -- never a raw typed username for login_fail (§4.6 step 3): an unknown
                                               -- name is stored only as "h:" + HMAC(K_name, canonical)[0..16 hex]
  ip_hash      TEXT,                           -- HMAC-SHA256(K_ip, ip_prefix) first 16 hex (§5.1)
  ok           INTEGER NOT NULL CHECK (ok IN (0,1)),
  detail_json  TEXT                            -- allowlisted fields only (§5.4)
) STRICT;
CREATE INDEX audit_by_user   ON audit_log(user_id, id DESC);
CREATE INDEX audit_by_action ON audit_log(action, id DESC);

CREATE TABLE admin_state (
  key         TEXT PRIMARY KEY,                -- 'kill_switch' | 'caps' | 'signup_mode' | 'audit_salt' | 'bootstrap_used' | 'testnet_signing'
  value_json  TEXT NOT NULL,
  updated_ms  INTEGER NOT NULL,
  updated_by  INTEGER
) STRICT;

CREATE TABLE invites (                         -- P1 (SIGNUP_MODE=invite)
  code_hash   BLOB    PRIMARY KEY CHECK (length(code_hash) = 32),
  created_by  INTEGER,
  created_ms  INTEGER NOT NULL,
  expires_ms  INTEGER NOT NULL,
  used_by     INTEGER,
  used_ms     INTEGER
) STRICT;

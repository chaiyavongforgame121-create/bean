# Bean Garden Platform: accounts, Hyperliquid TESTNET orders, many players

**Status:** binding build contract for the platform upgrade (five parallel engineers, §12). Where this document
disagrees with `SPEC.md` or `GAME-DESIGN.md`, this document wins for everything it names. WP4 updates
`SPEC.md` and `README.md` to match (§12). Files under `reference/` are data only. Never copy code from them.

**Revision 2 (2026-10-11).** This revision answers the security, protocol and product review. Every issue,
with the decision taken and where the document changed, is listed in §13 (Review log). Both blockers are resolved:
admin take-over (§4.6 step 2) and the faucet precondition (§1.1 G3, §9.7, §11.4).

**User goals.** These were decided with the user (in Thai) and are restated here:
1. The garden must be **really playable and really usable**.
2. A player can send **real orders on Hyperliquid TESTNET**. These use test funds, not real money. (Hyperliquid
   gives test funds only to an address that has deposited on mainnet; see the facts below.)
3. **Many players** can play over the internet.

**One line:** one shared engine (real mainnet prices and one public population of ~3000 beans). Each signed-up
player has a private garden. In that garden, each bot trades either on **paper** (simulated fills at real mainnet
mids, as today) or on **testnet** (real IOC orders on Hyperliquid TESTNET, using an API wallet the player
connected). Mainnet orders cannot happen: the code has no path that could send one (§1.2).

Notation used throughout:
- **P0** must ship. **P1** should ship. **P2** ships only if time allows.
- "Mainnet mid" is the live `allMids` price from `api.hyperliquid.xyz/info`.
- "Testnet mid" is the live `allMids` price from `api.hyperliquid-testnet.xyz/info`.
- All times are in ms unless they are marked s.
- `uid` means `users.id`.

Facts used by this contract, re-verified on **2026-10-11** while writing it (§6.13 lists the sources):
- The official SDK signing vectors pass against an independent implementation (zero-dependency JS: keccak,
  msgpack, EIP-712, RFC 6979 secp256k1). All 11 checks pass. The KATs in §6.12 are therefore known-good.
- The testnet universe has 212 perps. Our 16 coins on testnet:
  - 13 are tradeable.
  - **XRP** and **LINK** are not listed.
  - **ZEC** is listed but `isDelisted: true`, so it is **not tradeable**.
  - **HYPE** is `onlyIsolated` / `strictIsolated`.
  - Indices, `szDecimals` and `maxLeverage` differ from mainnet (table in §6.3).
- Testnet prices diverge strongly from mainnet. On 2026-10-11, HYPE was $41.20 on testnet and $84.79 on
  mainnet, and ZEC was $138.65 on testnet and $1223.05 on mainnet.
- **Test funds have a precondition.** Hyperliquid's testnet faucet (`https://app.hyperliquid-testnet.xyz/drip`,
  1,000 mock USDC) pays only an address that **has deposited on mainnet with the same address**. Email (Privy)
  logins get different mainnet and testnet addresses. A player without a mainnet deposit therefore cannot get test
  USDC by themselves. Paper is the complete game without it, and testnet stays optional (§1.1 G3, §11.4).

---

## 1. Goals, non-goals, glossary

### 1.1 Goals (P0 unless marked)

| # | Goal |
|---|---|
| G1 | Anyone can sign up with a username and password and play **paper** at once, with $10,000 of paper money in their own garden. |
| G2 | Gardens are private: bots, ledgers, caps, halt ("burn my field"), diary, events and SSE frames. Beans, prices and the market are public and shared. |
| G3 | A player who connects a Hyperliquid **testnet** API wallet can plant **testnet** bots. These send real IOC orders on testnet, are reconciled against the exchange every bar, and their numbers are honest per venue (§9.6). Testnet is **optional**: the test USDC comes from Hyperliquid's faucet, which pays only an address that has deposited on mainnet (§11.4). The app says so plainly, with the `/drip` link (§9.7 `g.tn.faucet`). |
| G4 | **Mainnet order sending is impossible by construction** (§1.2), and tests assert it (§11). |
| G5 | The game runs on the internet behind TLS: Docker plus Caddy, or Fly.io / Railway / Render / a VPS. There are backups, health checks and graceful shutdown (§10). |
| G6 | "Really playable": every 3D affordance is clickable **and tappable on a phone** (≥ 44 px targets), the four open lows from the last review are fixed, and sign-up to first planting takes ≤ 60 s (§9.8). |
| G7 | Today's local single-player mode stays as it is (`--auth none`), and **all 307 existing tests pass unmodified** (§2.4). |
| G8 (P1) | A browser-wallet (EIP-1193) "approve agent" flow. The server generates the agent key and the player's wallet signs `approveAgent` (§6.10). |
| G9 | **Recoverable play.** Every error a player can meet is shown in their language (EN/TH, §9.7.2). A drained paper garden can start a new season (`garden_reset`). An expiring API wallet is warned about and can be replaced without replanting. A forgotten password has an operator-assisted reset (§4.6). A developer can drive the whole testnet UI against a local double (`--testnet-double`, §11.1). |

### 1.2 Non-goals and hard rules

- **No mainnet orders, ever.** These rules make that true by construction:
  1. The only module that POSTs to an `/exchange` URL is `server/hl/exchange.js`.
  2. Its URL is the frozen constant `https://api.hyperliquid-testnet.xyz/exchange`. There is no URL parameter, no
     environment override and no constructor option.
  3. Before every `fetch`, it asserts `url === TESTNET_EXCHANGE_URL`.
  4. The signer hard-codes phantom-agent source `"b"` (testnet). No function accepts an `isMainnet` flag. An
     action signed with `"b"` recovers a different, unknown signer on mainnet and is rejected there.
  5. The string `api.hyperliquid.xyz/exchange` does not occur anywhere in `server/` or `web/`. A test greps for it
     (§11.2 T-GUARD).
  6. User-signed actions for the P1 wallet flow are built **in the browser from frozen constants**
     (`hyperliquidChain: "Testnet"`). The server re-checks the chain and recovers the signer before relaying (§6.10).
  7. **Egress guard (P0).** `server/main.js` (the CLI entry `main()`, never the library functions that tests
     import) installs `installEgressGuard()` from `server/hl/egress.js` before anything else runs. It wraps
     `globalThis.fetch` and allows only `POST` to exactly three URLs: `https://api.hyperliquid.xyz/info`,
     `https://api.hyperliquid-testnet.xyz/info` and `https://api.hyperliquid-testnet.xyz/exchange`. Anything else
     throws `egress_denied` and logs an alert. Rules 1–5 can be evaded by building a URL at runtime; this guard
     cannot, because it checks the final URL string at the moment of the request.
  8. Every Hyperliquid `fetch` passes `redirect: 'error'`, so a 3xx can never re-POST a signed body elsewhere.
  9. `HyperliquidClient` (mainnet info, `server/hyperliquid.js`) asserts `url === HL_INFO_URL` unless an injected
     test `fetch` is supplied. Existing tests always inject `fetch`, so they are unaffected.
- **No withdrawals or transfers.** We only send `order` (limit IOC, and P1 trigger), `cancel`/`cancelByCloid`
  (P1, only for P1 trigger orders), `updateLeverage`, and (P1) the relayed `approveAgent`. There is no code for
  `withdraw3`, `usdSend`, `spotSend`, `usdClassTransfer`, `sendAsset`, `vaultTransfer` or `subAccountTransfer`.
  An allowlist in `exchange.js` refuses any other `action.type`.
- **No master keys, no mainnet keys, no seed phrases.** We store only a testnet **API-wallet (agent)** key. An
  agent can trade but cannot withdraw. A master key is detected (testnet `userRole` = `user`) and refused. A key
  whose address has **any** mainnet role other than `missing` (`user`, `agent`, `vault`, `subAccount`) is refused,
  and the mainnet check **fails closed**: if it cannot be answered, nothing is stored (§6.7). Stored keys are
  re-checked against mainnet every 24 h. A seed phrase is detected by its shape and refused, and nothing about it
  is logged.
- **Serverless hosting is out of scope.** See §10.1.
- **Out of scope:**
  - mainnet order sending of any kind;
  - sub-accounts and vaults (the vault byte in the action hash is always `0x00`);
  - spot trading;
  - HIP-3 dexes;
  - a WebSocket feed (§6.8 explains why REST is used);
  - multiple processes or horizontal scaling (§2.2).

### 1.3 Glossary

| Term | Meaning |
|---|---|
| **Engine** | The shared, stateful core: `MarketFeed` (real mainnet bars and marks), `Population` (the beans) and the minute scheduler. There is one engine per process, and it is public and read-only for players. |
| **Bean** | A public paper strategy with $1,000 of paper capital (SPEC §2.3–2.5). Beans are shared by everyone. Many players may mirror the same bean. |
| **Player** | A row in `users`. In `--auth none` there is exactly one implicit player, `local` (uid `0`). |
| **Garden** | One player's private world: their bots, their ledgers (one per venue), caps, halt state, diary/events and plot layout. In code it is one `LiveLayer` instance (§7.1). |
| **Venue** | Where a bot's position lives. **`paper`**: simulated fills computed by our server at mainnet mids (SPEC §2.6, unchanged). **`testnet`**: real IOC orders on Hyperliquid TESTNET in the player's connected testnet account, filled and marked at **testnet** prices. |
| **Ledger** | A garden's money for one venue. **Paper ledger**: `account_usd` (start, $10,000) + Σ realized + Σ unrealized, as today. **Testnet ledger**: the exchange's view of the connected account (`clearinghouseState`: account value, withdrawable, margin), plus our per-bot attribution of fills and P&L. |
| **Bot** | A bean bound to a stake (`capital_usd`) on one venue in one garden. Its id is `bot-NNNN`, numbered per garden. States are `active \| paused \| closed`. A garden has at most one open bot per coin across both venues. |
| **Master account** | The player's Hyperliquid testnet account address (it holds the funds). |
| **Agent / API wallet** | A key pair approved by the master account to sign trading actions for it. It cannot withdraw. |
| **cloid** | A 16-byte client order id that we attach to every testnet order (§6.6). |
| **Nonce** | A per-signer number, unique and increasing, that the exchange uses to stop replays (§6.6). |
| **Halt** | A player burns their own field. All of their bots close, and new plants are refused until they re-arm (accounts mode) or the server restarts (none mode). |
| **Season** | A paper garden's numbered run. `garden_reset` closes the paper bots, archives their fills and orders under the old season number and starts the paper ledger again (§8.4). Testnet is untouched. |
| **Active testnet player** | A player with at least one testnet bot in state `active`, or with an unfinished flatten. This is what `TESTNET_MAX_ACTIVE_USERS` counts (§6.8). |
| **Kill switch** | The admin's global halt for **testnet**. Every open testnet bot is flattened and paused, and testnet planting is refused. Paper is unaffected. |
| **Spectator** | A visitor who is not signed in. They see the island, market and seed stall, but plots are empty and planting asks them to sign in. |

---

## 2. Architecture and process model

### 2.1 Diagram

```
   players' browsers (3D garden + EventSource)       operator: `docker compose exec bean` / `fly ssh console`
            │ HTTPS, HTTP/2                                        │ node server/admin-cli.js … (Bearer ADMIN_TOKEN,
   ┌────────▼────────────────────────────────┐                     │  direct loopback only, §4.4)
   │ Caddy (TLS, HSTS, HTTP/2)  — or the     │                     │
   │ Fly/Render/Railway edge proxy           │                     │
   └────────┬────────────────────────────────┘                     │
            │ HTTP/1.1  (XFF honoured only from a peer in TRUSTED_PROXY_CIDRS, §4.5)  │
┌───────────▼──────────────────────────────────────────────────────────────────────────▼───────┐
│ ONE Node process:  node server/main.js --auth accounts   (egress guard installed first, §1.2) │
│                                                                                                │
│  http.js ── auth/ (sessions, csrf, ratelimit, users) ── catalog.js ── static web/ + /vendor/three
│     │  queries · commands · SSE (global frames to all; user frames to that user's sessions)  │
│     ▼                                                                                          │
│  ┌──────────────────────┐ onTick / onMarks ┌────────────────────────────────────────────────┐  │
│  │ Engine (shared)      │─────────────────▶│ Gardens  (uid → LiveLayer, loaded on demand)   │  │
│  │  MarketFeed (mainnet)│                  │   paper bots: sync fills at mainnet mids       │  │
│  │  Population (beans)  │                  │   testnet bots: TestnetVenue (async adapter) ──┼──┐
│  └─────────┬────────────┘                  └───────┬──────────────────────────┬─────────────┘  │
│            │ read-only                             │ repo (write-through)     │ credentials    │
│  hyperliquid.js ─▶ api.hyperliquid.xyz/info        ▼                          ▼ (decrypt only  │
│                                            data/bean.db (SQLite, WAL)   secrets.js  for signing)
│  Journal (global seq; global records ─▶ ring + jsonl; user records ─▶ bean.db `events`)       │
│  Pulse (mids: global part + per-subscriber garden part)                                       │
│                                                                                                │
│  server/hl/ ── scheduler (weight ledger, priority queue, per-user serial lanes)               │
│     ├ info.js / market.js ──▶ api.hyperliquid-testnet.xyz/info      (read)                   ◀─┘
│     └ exchange.js (ONLY POST to /exchange, URL frozen to TESTNET) ──▶ api.hyperliquid-testnet.xyz/exchange
│                                                                                                │
│  data/state-real.json (engine + global journal)  ·  data/journal-real.jsonl  ·  data/backups/ │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Process model

- **Single process, single event loop, vertical scaling only.** Four things force this:
  - The engine is stateful: 3000 beans with 14 days of bars in memory, and a minute scheduler.
  - SQLite has a single writer.
  - Nonces are sequenced per agent.
  - SSE fan-out needs one process.
- **Synchronous work:** engine ticks, paper fills and SQLite calls (`node:sqlite`, `DatabaseSync`, WAL). Each costs
  µs to ms.
- **Asynchronous work:**
  - every Hyperliquid request: mainnet info as today, plus testnet info and exchange;
  - scrypt (libuv threadpool; set `UV_THREADPOOL_SIZE=8`);
  - SSE writes.
- **Capacity targets per process** (benchmarked in §11.2 T-PERF):
  - 2,000 registered players;
  - 300 concurrent SSE streams in normal use. The hard limits and memory budget are in §4.5, and T-PERF holds
    2,000 non-reading streams within that budget;
  - 1,000 open paper gardens × 10 bots;
  - **40 active testnet players** (glossary). The binding limit is Hyperliquid's per-IP weight budget (§6.8). The
    default may be raised after T-PERF and the M4 runbook show headroom.
- **Gardens are loaded on demand.** A garden is in memory while it has an open bot, or while its player made a
  request in the last 30 min. Idle gardens with no open bots are evicted. Their state is in SQLite.
- **uid-keyed state is torn down synchronously.** Account deletion calls `gardens.teardown(uid)` before the DELETE
  commits, and admin disable calls it once the disable's flatten has finished: the player's scheduler lane, queued
  jobs and retry timers are cancelled, their
  streams are closed, and uid-keyed caches are dropped. Every lane job also captures the garden's random `epoch`
  and aborts if it no longer matches (§7.2). A later player can therefore never inherit work meant for a deleted
  one.

### 2.3 The two modes

`--auth none|accounts` (env `BEAN_AUTH`). The default is **`none`**. Parsing is **strict** (§10.3): a value that
is set but empty, or anything other than `none`/`accounts`, exits with code 2. None mode also exits 2 when an
accounts-only setting is present, so a typo can never put none mode on the internet.

| Aspect | `--auth none` (local dev, today) | `--auth accounts` (internet) |
|---|---|---|
| Players | one implicit `local` (uid 0) | sign-up / sign-in; spectators allowed |
| Default `--host` | `127.0.0.1`. Only an explicit `--host` changes it (as today). The `HOST` env var is **not read**; a non-loopback `HOST` env var exits 2. | `127.0.0.1`; `HOST` env or `--host` (Docker sets `HOST=0.0.0.0`) |
| Command auth | SPEC §4 rules 1–2: token from anywhere, or a same-origin loopback request | **session cookie** plus CSRF checks (§4.4). The loopback exemption is **disabled**: behind a proxy every request is loopback. |
| Bearer token | `--token` / `BEAN_API_TOKEN` unlocks every command | Only `ADMIN_TOKEN` / `ADMIN_TOKEN_FILE` (≥ 32 chars). It unlocks **admin ops only** (§8.6), and only from a **direct loopback peer with no proxy headers** (the `admin-cli`, §4.4) unless `ADMIN_TOKEN_REMOTE=1`. It never unlocks garden or auth ops, nor `make_admin`/`remove_admin`. `--token` and `BEAN_API_TOKEN` are refused (exit 2). |
| Command params | query string and JSON body (as today) | **JSON body only**. A POST with a non-empty query string answers `400 query_params_not_allowed` before the body is read (§4.4). |
| CORS | `ACAO: *` on all API responses (as today) | `ACAO: *` only on **public** GET queries (§8.1). No CORS on user-scoped GETs, POSTs or SSE. |
| Cross-origin `?api=` | allowed (brood-api.js rules) | refused. The page and API must share one origin. |
| Garden state | `live` section of `data/state[-real].json` (as today) | `data/bean[-sim].db` (§3). The JSON `live` field is `null`. |
| Gardens | 1 | many (§7) |
| Venues | `paper` only. `venue:'testnet'` → 409 `testnet_needs_accounts`. | `paper`, plus `testnet` when `TESTNET_ENABLED=1`, the feed is real and the master key is set; or, for local development only, backed by the in-process double (`--testnet-double`, §11.1) |
| Halt | lasts until restart (as today) | persisted; lifted by `garden_rearm` (§8.4) |
| Events | all records are global (as today) | only `GLOBAL_KINDS` are global (engine kinds, `kill_switch`, `testnet_feed`); `bot_*`, `live_*`, `testnet_account`, `credential_status`, `garden_*` and `password_reset` are user-scoped, and an unscoped user kind throws (§8.7) |
| `tick` (sim feed only) | as today | admin only (it moves everyone's sim market) |
| Payloads | **byte-for-byte as today**, except the additive `auth:"none"` key in `GET /api/v1` | additive fields (§8) |

### 2.4 How current behaviour and the 307 tests are preserved (P0, a release gate)

1. `parseConfig()` defaults to `auth: 'none'`. No existing flag changes meaning.
2. `createServer({engine, live, journal, pulse, config})` with no `config.auth` is exactly today's server. The
   accounts branch is chosen only by `config.auth === 'accounts'` and needs a `platform` dependency bag (§12,
   WP4). The none-mode code paths (`commandAuth`, `isSameOriginLoopback`, CORS `*`) are **not deleted**. They are
   selected at the composition root.
3. `new LiveLayer({config, engine, journal, now, log})` keeps its signature, defaults and behaviour. All new
   behaviour is opt-in through new optional options (`owner`, `repo`, `testnet`, `logKeep`, `paperOnlyAggregates`).
   With none of them set, every code path is unchanged (§7.1).
4. `Journal.emit(kind, data)` keeps its signature. Scoping uses a new optional third argument `{uid}` (§8.7).
   `new Journal(...)` without the new `scoped` option behaves exactly as today. Accounts mode builds it with
   `{scoped: true, globalKinds: GLOBAL_KINDS}`, where an unscoped emit of a user kind throws (§8.7).
5. `Population.row/query/detail` gain an optional `venue` override (§7.4). The installed hook still wins when it is
   absent.
6. None mode never opens SQLite, never reads `BEAN_MASTER_KEY` and never contacts the testnet.
7. CI gate: `npm test` runs the existing 9 test files **unmodified**, plus the new files (§11). A PR that edits an
   existing assertion needs this contract amended first.
8. `incompatibility()` in `main.js` accepts `live: null` only when `config.auth === 'accounts'`.
9. `wire({engine, live, pulse})` stays exactly as today for none mode. Accounts mode uses a separate
   `wireAccounts({engine, gardens, pulse})` that never merges garden data into the shared `mids` frame (§7.5).
10. The egress guard (§1.2 rule 7) is installed only by `main()`. Tests import `parseConfig`, `wire`,
    `startRuntime` and friends, never `main()`, so their local `fetch` calls to the test server are unaffected.
    The stricter config rules (§10.3) apply only when `BEAN_AUTH`/`--auth` or an accounts-only variable is present
    in the `env` passed in, so the existing `parseConfig` cases behave as today.

---

## 3. Data model

### 3.1 Storage split

| Store | Holds | Mode |
|---|---|---|
| `data/state-real.json` / `state.json` | Engine snapshot (market, population, tick) and the **global** journal ring. `live` is `null` in accounts mode. | both |
| `data/journal-real.jsonl` / `journal.jsonl` | Global journal records (append) | both |
| `data/bean.db` (real feed) / `data/bean-sim.db` (sim feed) | Users, sessions, credentials, gardens, bots, orders, fills, user events, audit, admin state | accounts only |
| `data/backups/` | Online `sqlite.backup()` snapshots of the DB plus a copy of the state JSON (§10.5); `VACUUM INTO` only for the pre-migration backup at boot, before serving | accounts only |
| `data/admin-bootstrap.txt` | The generated first-admin code, mode `0600`, deleted once an admin exists (§4.6 step 2) | accounts only |

There is one DB per feed. The rule "switching feeds never destroys a garden" (GAME-DESIGN §10.1) carries over:
sim-priced paper positions never mix with real-priced ones. The testnet venue exists only with the real feed.

### 3.2 Connection settings (`server/db/db.js`)

`new DatabaseSync(file)` (`node:sqlite`). `node:sqlite` is unflagged from Node 22.13, and the asynchronous,
page-stepped `sqlite.backup()` used for online backups (§10.5) exists from **Node 22.16** (added in v23.8.0 and
v22.16.0). Set `package.json` `engines.node` to `>=22.16`. Docker uses Node 24 LTS (§10.2).

**SQL rule (P0, tested in `db.test.js`).** All SQL takes values **only through `?` bindings**. `db.exec(sql)` runs
only the migration files and constant PRAGMA strings. The one exception is `PRAGMA user_version = <n>` in
`migrate.js`, where `n` passes `Number.isInteger` first. `db.test.js` scans `server/**` for `prepare(` and `exec(`
calls whose argument contains `${` or `+` concatenation, and fails on any hit outside that allowlisted line.

Then run, in this order:
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;      -- WAL commits survive a process crash; the write-ahead order rows rely on that
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA secure_delete = ON;        -- freed pages are zeroed (credential wipes)
PRAGMA temp_store = MEMORY;
PRAGMA wal_autocheckpoint = 1000;
```

Transactions use `BEGIN IMMEDIATE` … `COMMIT`, through `db.tx(fn)`, which rolls back on throw. There is exactly one
connection.

### 3.3 Schema (migration `0001_init.sql`; all tables `STRICT`)

```sql
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
  id               INTEGER PRIMARY KEY AUTOINCREMENT, -- uid ≥ 1 (0 is reserved for the implicit none-mode player)
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
  token_hash       BLOB    NOT NULL UNIQUE CHECK (length(token_hash) = 32),       -- SHA-256(raw token bytes)
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
CREATE INDEX sessions_by_expiry ON sessions(expires_ms);

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
  WHERE status IN ('pending','verified');                          -- one live agent ↔ one garden (nonce safety)
CREATE UNIQUE INDEX credentials_account ON credentials(account_address)
  WHERE status IN ('pending','verified');                          -- one live testnet account ↔ one garden (attribution)
CREATE INDEX credentials_by_kid ON credentials(key_id);
CREATE INDEX credentials_mainnet_due ON credentials(mainnet_checked_ms) WHERE status = 'verified';

CREATE TABLE gardens (
  user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  epoch              TEXT    NOT NULL CHECK (length(epoch) = 16),        -- random hex at creation; lane jobs check it (§7.2)
  season             INTEGER NOT NULL DEFAULT 1 CHECK (season >= 1),     -- paper season (garden_reset, §8.4)
  season_started_ms  INTEGER NOT NULL,
  last_reset_ms      INTEGER,
  last_active_ms     INTEGER NOT NULL,                                   -- authenticated activity, written ≤ once per 5 min (inactivity rule, §4.6)
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
                                               -- exchange_sync{}, size_ratio{}, …); sanitizeBot() validates on load
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
  reason       TEXT,                           -- tick | create | resume | pause | close | halt | kill | notional_cap | …
  code         TEXT,                           -- exchange error code (§6.9) for rejected/error
  error        TEXT,                           -- exchange error text, truncated to 300 chars; never contains secrets
  cloid        TEXT    UNIQUE CHECK (cloid IS NULL OR (length(cloid) = 34 AND cloid GLOB '0x[0-9a-f]*')),
                                               -- 16 random bytes (§6.6), committed before the POST
  oid          INTEGER,
  nonce        INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,     -- transmissions of the same signed bytes (§6.6)
  transport_failed INTEGER NOT NULL DEFAULT 0 CHECK (transport_failed IN (0,1)), -- any earlier transmission failed in transport
  leverage     INTEGER,                        -- kind = 'leverage'
  filled_sz    REAL,                           -- from orderStatus (origSz − sz) or the order response
  avg_px       REAL,                           -- from the order response; replaced by the fills' weighted px
  tick         INTEGER,
  time_ms      INTEGER NOT NULL,
  sent_ms      INTEGER,
  done_ms      INTEGER,
  replay       INTEGER NOT NULL DEFAULT 0 CHECK (replay IN (0,1))
) STRICT;
CREATE INDEX orders_by_bot ON orders(user_id, bot_id, id DESC);
CREATE INDEX orders_inflight ON orders(status) WHERE status IN ('pending','sent','unknown');

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
  action       TEXT    NOT NULL,               -- §5.4 allowlist (signup, login_ok, login_fail, logout, …)
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
```

### 3.4 Migrations

- Files live in `server/db/migrations/NNNN_name.sql`. There are four zero-padded digits, and versions run
  1, 2, 3… with no gaps. Migrations go forward only. A file is never edited after release, and a checksum mismatch
  refuses to start.
- At boot, `migrate(db, dir)`:
  1. Read the applied versions.
  2. If any migration is pending and the DB is not new, take a backup to
     `data/backups/pre-migration-<from>-<to>-<ts>.db` with `VACUUM INTO`.
  3. Apply each pending file in its own `BEGIN IMMEDIATE` transaction, insert into `schema_migrations`, and set
     `PRAGMA user_version = <version>`.
  4. Any error rolls back that migration and exits with code 3, with the message printed.
- Data migrations that need JS (for example, re-encryption on key rotation, §5.2) are separate boot steps, not
  SQL migrations.
- Retention runs hourly in `server/db/retention.js`:
  - `events`: keep the newest 5,000 per user.
  - `fills` and `orders`: keep the newest 20,000 per user, never deleting a row of an **open** bot.
  - `sessions`: delete rows that have been expired or revoked for > 30 days.
  - `audit_log`: keep 180 days.
  - It never blocks the event loop for long: each statement deletes **≤ 1,000 rows** (`DELETE … WHERE rowid IN
    (SELECT … LIMIT 1000)`), and the next batch is scheduled with `setImmediate`. One pass over 2,000 users is
    spread over many slices; T-PERF asserts event-loop p99 < 200 ms while it runs.

### 3.5 Write path

- **Paper fills, orders and bot rows** are buffered during an engine tick or a command. They are flushed in **one
  transaction** at the end of `Gardens.afterTick()` or the command handler (§7.6). Inside it, **each garden's
  writes run in their own `SAVEPOINT`**. A row that throws (a constraint, an unexpected exchange value) rolls back
  only that garden's savepoint: the error is logged as an alert and the garden is marked dirty for the next flush.
  Other players' writes still commit.
- **Testnet orders are write-ahead.** The order row is inserted with status `pending`, together with the nonce
  update (`credentials.last_nonce`), and that transaction **commits before the HTTP POST** (§6.6).
- **User events** are inserted in the same transaction as the change that caused them. If that is not possible
  (for example, an async testnet callback), they get their own transaction.
- **Marks** (mark price, unrealized P&L) are **not persisted** every 5 s. They are recomputed from mids after a
  restart.

---

## 4. Auth, sessions, CSRF, rate limits, account lifecycle

### 4.1 Usernames and passwords

**Usernames:**
- Canonical form = `input.normalize('NFKC').trim().toLowerCase()`, matching `^[a-z0-9_]{3,24}$`.
- Reserved names: `admin, administrator, root, system, operator, support, bean, beans, garden, api, local, null,
  undefined, testnet, mainnet, hyperliquid, me, you`.
- **Retired names:** the name of a deleted account goes into `retired_usernames` in the same transaction as the
  delete, and can never be registered again.
- **Configured admin names** (`ADMIN_USERNAMES`) that do not exist yet can be registered only together with a valid
  bootstrap code (§4.6 step 2). Without it the answer is the ordinary `409 username_unavailable`.

**Passwords:**
- `NFKC`, then 10–128 code points and ≤ 512 UTF-8 bytes.
- Must not equal the username or contain it (when the username has ≥ 4 chars).
- Must not appear in the bundled list `server/auth/common-passwords.txt`. P0 ships the top 1,000 entries; P1
  ships 10,000.
- The error is `weak_password` with a reason key (`too_short | too_long | contains_username | common`).

**Hashing** (`server/auth/passwords.js`):
- `crypto.scrypt(pw, salt, 64, {N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024})`, asynchronous on the threadpool.
  This is one of the OWASP Password Storage configurations for scrypt (N=2^15, r=8, p=3; equivalent to the
  N=2^17, p=1 minimum). Memory stays 32 MiB per hash, so 4 concurrent hashes fit a 2 GB VM.
- The salt is 16 random bytes.
- Encoding: `scrypt$v=1$N=32768,r=8,p=3$<b64url salt>$<b64url dk>`.
- Verification parses the parameters from the stored string, recomputes, then compares with
  `crypto.timingSafeEqual`.
- When the stored parameters are below current, re-hash on successful login.
- A semaphore allows **4 concurrent** hashes. When more than 32 wait, return `503 busy`. **Each client IP has at
  most one hash in flight**; a second concurrent login or sign-up from the same IP bucket waits for the first.
- **Order of checks** on `auth_login`, cheapest first: per-IP bucket → per-username lockout (§4.5) → scrypt. A
  request refused by a limit never reaches scrypt.
- **Unknown usernames still pay one scrypt** against `DUMMY_HASH` (computed at boot), so timing does not reveal
  whether a user exists.

### 4.2 Sessions and cookies (`server/auth/sessions.js`)

**Token:**
- `crypto.randomBytes(32)`, sent in the cookie as base64url (43 chars).
- The server stores only `SHA-256(token bytes)`.
- A cookie value that does not match `^[A-Za-z0-9_-]{43}$` is ignored.

**Cookie:**

| `PUBLIC_ORIGIN` scheme | Set-Cookie |
|---|---|
| `https:` | `__Host-bean_sid=<token>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000` |
| `http:` (local dev only; `--public-origin http://localhost:8420`) | `bean_sid=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` |

To clear: the same name and attributes with `Max-Age=0`. There is never a `Domain` attribute.

**Lifetimes:**
- Absolute lifetime 30 days (`SESSION_DAYS`). Idle lifetime 7 days (`SESSION_IDLE_DAYS`).
- **Rotation** happens on the first authenticated request more than 24 h after `rotated_ms`:
  1. Generate a new token.
  2. Set `prev_hash := token_hash` and `prev_valid_ms := now + 60 s` (parallel requests still carrying the old
     cookie keep working for 60 s).
  3. Set `token_hash := new` and `rotated_ms := now`.
  4. Send `Set-Cookie` with the new token.
- Sign-in, sign-up and password change always create a **new** session row; they never reuse one.
- Each user has at most 20 live sessions. Creating the 21st revokes the oldest.

**Validation, on every request carrying the cookie:**
1. Look up the row where `token_hash = H` OR (`prev_hash = H` AND `prev_valid_ms > now`).
2. Require `revoked_ms IS NULL`, `expires_ms > now`, `last_seen_ms + idle > now` and `users.status = 'active'`.
3. If the cookie is present but invalid, the request is anonymous. A user-scoped op then answers
   `401 session_expired` and clears the cookie.
4. Update `last_seen_ms` only if it is older than 5 min (this bounds writes).

**Session ids seen by clients.** `sessions` (P1) lists and `session_revoke` takes the opaque `public_id` (16 random
bytes, base64url). The integer rowid never leaves the server.

**Known-device cookie** (anti-lockout, P0). A successful sign-in also sets `__Host-bean_kd` (`bean_kd` on http
localhost): `<uid>.<expires_ms>.<b64url HMAC-SHA256(K_dev, uid ‖ expires_ms ‖ pw_changed_ms)>`, `HttpOnly`,
`SameSite=Lax`, `Secure` on https, 90 days. A login that presents a valid known-device cookie **for the same
user** is not subject to the per-username lockout (§4.5); the per-IP limit still applies. A password change
invalidates every known-device cookie because `pw_changed_ms` is in the MAC.

**SSE:** the session is checked at connect. Each stream records its `session_id` and `uid`. **Every revocation
path** (logout, logout everywhere, password change, `session_revoke`, admin `revoke_sessions`, disable, role change,
password reset, account deletion) **synchronously** sends `event: session_ended` (no `id:`) to the matching streams
and ends them, in the same tick as the revocation. The 60 s re-check stays as a backstop for expiry.

### 4.3 Endpoints (details and shapes in §8.2)

- `auth_signup`
- `auth_login`
- `auth_logout`
- `auth_logout_all`
- `me`
- `account_password`
- `account_delete`
- `auth_reset` (sets a new password with an operator-issued reset code, §4.6 step 8)
- `sessions` (P1)
- `session_revoke` (P1)

All auth commands are POST, CSRF-checked (§4.4) and rate-limited (§4.5), and their catalog entries are marked
`sensitive: true` (§5.3).

### 4.4 CSRF and host checks (`server/auth/csrf.js`; accounts mode)

Exact algorithm, run before any command handler:

```
directLoopback(req): socket peer ∈ {127.0.0.1, ::1} AND none of PROXY_HEADERS is present
                     (PROXY_HEADERS as in http.js today: x-forwarded-for, cf-connecting-ip, x-real-ip, forwarded,
                      x-forwarded-host, x-forwarded-proto; plus fly-client-ip, true-client-ip)
hostOk(req):   Host header === new URL(PUBLIC_ORIGIN).host
               (exceptions: GET/HEAD /healthz answers ANY Host — its body is the constant {ok:true}, and platform
                health checkers such as Render's call it with an internal Host name;
                /healthz, /readyz and GET /api/v1/health also accept 127.0.0.1:<PORT> / localhost:<PORT>;
                an admin op from directLoopback(req) with a Bearer header is also exempt — the admin-cli path)
               else 421 'misdirected request'
if method === POST and url.search !== '':  400 {code:'query_params_not_allowed'}   (before the body is read;
               command params come only from the JSON body, so secrets never sit in a request line or access log)
if method ∈ {GET, HEAD, OPTIONS}: no CSRF check  (rule: NO state-changing GET exists — a test enumerates OPS)
mediaType = content-type before ';', trimmed, lower-case
if mediaType !== 'application/json': 415 {code:'unsupported_media_type'}      (blocks HTML form posts)
if a Bearer header is present:
    if op.auth !== 'admin':                                     401 {code:'auth_required'} (Bearer never unlocks user ops)
    if !directLoopback(req) && ADMIN_TOKEN_REMOTE !== '1':      403 {code:'forbidden'}
    if op is admin_user with action make_admin|remove_admin:   403 {code:'session_required'}
    if the token does not match (constant time): take 1 from the per-IP 'admin_token' bucket (5 / 15 min),
                                                 audit admin_token_fail, 401 {code:'auth_required'}
    if NO session cookie was used: allowed (no ambient credential)
origin = Origin header
if origin present:  new URL(origin).origin === new URL(PUBLIC_ORIGIN).origin  else 403 {code:'csrf'}
else:               Sec-Fetch-Site === 'same-origin'                          else 403 {code:'csrf'}
```

Layered with `SameSite=Lax` and the absence of credentialed CORS, this defends against CSRF and login-CSRF. CORS
preflight (`OPTIONS`) in accounts mode answers `204` **without** `Access-Control-Allow-*` for any non-public path.

**Operator path.** `server/admin-cli.js` (WP1) is run inside the container (`docker compose exec bean node
server/admin-cli.js status|kill on "reason"|kill off|backup|users|user <name> <action>`). It reads
`ADMIN_TOKEN_FILE`, calls `http://127.0.0.1:<PORT>` directly (so `directLoopback` holds and `hostOk` is exempt), and
prints the JSON. External monitoring that must pull `admin_status` over the internet sets `ADMIN_TOKEN_REMOTE=1`
explicitly; this is documented as a weaker setting.

### 4.5 Rate limits (`server/auth/ratelimit.js`)

**Client IP** (`clientIp(req, {trustProxy, header, trustedCidrs})`):
- The socket peer address is the client IP **unless the peer is in `TRUSTED_PROXY_CIDRS`** (default
  `127.0.0.0/8, ::1/128, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7, fdaa::/16`). Only then:
  - if `CLIENT_IP_HEADER` is set (e.g. `fly-client-ip`), that single header is used;
  - otherwise, with `TRUST_PROXY = N ≥ 1`, the N-th address from the **right** of `X-Forwarded-For`. If XFF has
    fewer than N entries, the socket address is used and a warning is logged once.
- A client that reaches port 8420 directly (a debug `ports:` entry; Docker publishing bypasses ufw) therefore cannot
  choose its own bucket by writing `X-Forwarded-For`.
- Per-topology settings are in §10.3. `admin_status` reports `client_ip_source` (`socket | xff | header`) and the
  number of distinct IP buckets in the last hour, so a misconfiguration that collapses everyone into a few buckets
  (for example a CDN in front of Caddy) is visible.
- **IPv6 bucketing:** /56 for login, sign-up and SSE counting; /48 for the per-prefix sign-up bucket; /64 elsewhere.

**Stores.** Each scope has its **own** store, so a flood in one scope cannot evict another:
- Per-username failure state of **existing** users lives in `users.failed_logins` / `users.locked_until_ms`. It
  cannot be evicted.
- Failure counters for **unknown** usernames live in their own bounded LRU (100,000 keys, entries expire after
  60 min). When it is full, a new unknown username is answered as **locked** (`429`) instead of evicting an entry.
  The residual effect (under a flood, unknown names answer 429 while known names still answer 401) is accepted and
  needs > 100,000 distinct names after the per-IP limits.
- Per-IP buckets: one LRU per scope (50,000 keys each). Eviction there only ever forgets an attacker's own buckets'
  history, which is acceptable because per-username lockout does not depend on it.
- Buckets reset on restart (accepted), except the persisted per-user state above.
- Every limit answers `429 {code:'rate_limited', retry_after_s}` plus a `Retry-After` header.

| Scope | Limit |
|---|---|
| `auth_login` per IP (/56) | bucket 10, refill 1 per 90 s; at most one scrypt in flight per IP (§4.1) |
| `auth_login` per canonical username, **whether the user exists or not** | after 5 consecutive failures, lockout 2^(f−5) min (1, 2, 4 … cap 60 min). Reset on success. The response is the same generic `429`. **Exempt:** a client presenting a valid known-device cookie for that user (§4.2). |
| `auth_signup` attempts per IP (/56), **every attempt including 409** | 10 per hour (the enumeration bucket) |
| `auth_signup` **successful creations** | 3 per hour per IP (/56); 10 per hour per /48; globally `SIGNUP_MAX_PER_HOUR` (60). When the global cap is reached: `503 {code:'signup_busy', retry_after_s}`. Failed attempts do not consume the global cap, so junk sign-ups cannot block G1. |
| `auth_reset` per IP and per username | 5 per hour each; a wrong code counts as a login failure for that username |
| `account_password`, `account_delete` per user | 5 per 15 min |
| `testnet_connect` / `testnet_verify` per user | 5 per hour, counting **only requests that reach Hyperliquid**. Format errors (400) and seed-phrase refusals do not count. These also queue behind the testnet weight budget (§6.8). |
| Bearer admin token failures per IP | 5 per 15 min; each failure is audited as `admin_token_fail` |
| `garden_reset` per user | 1 per 24 h |
| `admin_backup` | 1 per 10 min (global) |
| commands per user | bucket 60, refill 1/s. `bot_create` separately: 10 per min. |
| queries per IP | bucket 120, refill 10/s. **Opening an SSE stream costs 10 tokens** from this bucket (a reconnect with `Last-Event-ID` runs a replay query). |
| SSE streams | ≤ 5 concurrent per user, ≤ 20 per IP (/56), ≤ 2,000 total, of which **spectator streams may hold at most 1,000**; a signed-in player can always connect while the total is below 2,000. |
| SSE buffering | per stream ≤ **128 KB** queued (today: 1 MB, kept in none mode). A global budget of **64 MB** queued across all streams: when exceeded, the stream with the most queued bytes is dropped first. |
| request body | 64 KB (as today). Auth and credential ops: 4 KB. |

**Order of checks for sign-up:** per-IP enumeration bucket → username validity and availability → per-IP, per-/48
and global creation budgets → scrypt → insert. The remaining sign-up oracle (`409 username_unavailable` reveals that
a name is taken) is accepted: it is bounded by the 10/h enumeration bucket, usernames are not treated as secrets,
and lockout abuse against a known name is defused by the known-device exemption.

### 4.6 Account lifecycle

1. **Sign up** (`SIGNUP_MODE=open|invite|closed`, default `open`):
   1. Check the limits in the order given in §4.5.
   2. Validate the username (reserved, retired, configured-admin rules of §4.1) and the password.
   3. Hash the password.
   4. In one transaction, insert into `users` and `gardens` (`account_usd` = the current paper cap, default
      10,000; a random `epoch`; `season = 1`).
   5. Create a session and set the cookie.
   6. Write the audit row `signup`.
2. **Admin role** (no stranger can ever obtain it):
   - **`ADMIN_USERNAMES`** (comma list) only **promotes users that already exist**, at boot. It never grants admin
     at sign-up. A sign-up whose name is listed and does not exist yet must carry a valid `bootstrap_code`;
     otherwise it gets the ordinary `409 username_unavailable`.
   - **Bootstrap code.** While no admin exists, a sign-up carrying `bootstrap_code` equal to the code
     (constant-time compare) becomes admin. The code comes from `ADMIN_BOOTSTRAP_CODE` / `ADMIN_BOOTSTRAP_CODE_FILE`.
     If neither is set, the server **generates** a random 12-character code at boot and writes it to
     `<data>/admin-bootstrap.txt` with mode `0600` (owner `node`). It is **never printed** to stdout, which on
     Fly/Render/Railway goes to dashboards and log drains. The log line says only `admin bootstrap code written to
     <path> (read it with docker compose exec / fly ssh console)`. The file is deleted as soon as an admin exists,
     and `admin_state.bootstrap_used` is set.
   - Deleted names are retired (§4.1), so an admin name freed by deletion or rename can never be re-registered.
   - `make_admin` / `remove_admin` need an admin **session** plus re-entry of that admin's password (§8.6). The
     Bearer token cannot do it.
3. **Sign in:** generic failure `401 {code:'bad_credentials', error:'wrong username or password'}`. On success:
   create a session, set `last_login_ms`, reset `failed_logins`, set the known-device cookie, write audit
   `login_ok`. On failure: audit `login_fail`. When the username exists, the row carries `user_id` and
   `target = NULL`. When it does not, `target = "h:" + HMAC(K_name, canonical)[0..16 hex]`, which still correlates
   attacks but never stores what was typed (people type passwords into the username field).
4. **Sign out:** revoke the current session and clear the cookie. **Sign out everywhere:** revoke all of the
   user's sessions and clear the cookie. In both cases the matching SSE streams get `session_ended` and close in the
   same tick (§4.2).
5. **Change password:**
   1. Verify the current password.
   2. Store the new hash and `pw_changed_ms` (this also invalidates known-device cookies).
   3. Revoke **all** sessions and close their streams.
   4. Issue a fresh session to the caller.
   5. Write audit `password_changed`.
6. **Delete account** (`{password, confirm:'DELETE', force?}`):
   1. Verify the password.
   2. Run the garden halt: paper bots close synchronously; testnet bots flatten, awaited ≤ 15 s.
   3. If testnet positions are still open (testnet down, credential revoked) and `force !== true`, answer
      `409 {code:'testnet_positions_open', positions:[{coin, szi}]}`. The UI then shows a second step (§9.2).
   4. `gardens.teardown(uid)`: cancel the player's lane, queued jobs and retry timers; close their streams; drop
      uid-keyed caches (marks, rate buckets, memoized frames).
   5. In one transaction: overwrite `credentials.key_ct/iv/tag` with zero bytes; insert the canonical name into
      `retired_usernames`; `DELETE FROM users WHERE id=?`, which cascades to sessions, credentials,
      gardens→bots/orders/fills, and events. `secure_delete` zeroes the freed pages.
   6. Run `PRAGMA wal_checkpoint(TRUNCATE)` so the old credential pages leave `bean.db-wal` at once.
   7. Write audit `account_deleted` (user id only; uids are never reused, §3.3).
   8. Clear the cookie.
   - With `force`, the response says that positions stay open on testnet until the player closes them on
     `app.hyperliquid-testnet.xyz`.
   - **Honest wipe.** The dialog states that encrypted copies of the key remain in backups for
     `BACKUP_KEEP × BACKUP_INTERVAL_H` (7 days by default) and in any off-site retention, and that the only real
     kill is to **revoke the API wallet** at `https://app.hyperliquid-testnet.xyz/API` (a required, linked step in
     the dialog, §9.2).
7. **Disable** (admin): set `status='disabled'`, revoke sessions and close their streams, halt the garden (testnet
   flattened), `gardens.teardown(uid)` after the flatten completes, audit. Sign-in then answers
   `403 {code:'account_disabled'}`, but only after a correct password.
8. **Operator password reset** (there is no email, so no self-service recovery; the sign-up form says so,
   `g.gate.noRecovery`):
   1. The player asks the operator out of band. The admin runs `admin_user {username, action:'reset_password'}`.
   2. The server generates a one-time code (12 characters), stores only `SHA-256(code)` in `users.reset_hash` with
      `reset_expires_ms = now + 24 h`, and returns the code **once** to the admin. Audit `password_reset_issued`.
   3. **The reset protects testnet keys from the operator:** issuing it flattens the player's testnet bots (as in
      disconnect with `close_bots`) and then **wipes the testnet credential**. An admin who used the code to take
      over the account would find only the paper garden. The player's diary gets a line, and the next sign-in
      shows "your password was reset by the operator; reconnect testnet".
   4. The player calls `auth_reset {username, code, new_password}`. A matching, unexpired code sets the new password,
      clears `reset_hash`, revokes all sessions, creates a fresh one and writes audit `password_reset_used`.
9. **Inactivity rule** (testnet only). When a player has had no authenticated activity for `INACTIVITY_DAYS` (14)
   days, a daily job flattens and pauses their testnet bots, with note code `inactive` and a diary line. Paper bots
   keep running. This frees testnet capacity (§6.8) and stops abandoned gardens from trading forever. It is stated
   in the FAQ (§9.2).

---

## 5. Secrets

### 5.1 Encryption at rest (`server/secrets.js`)

**Master key:**
- `BEAN_MASTER_KEY_FILE` (preferred: Docker compose `secrets:` mounted at `/run/secrets/bean_master_key`, §10.2)
  or `BEAN_MASTER_KEY` holds the base64 or base64url of **exactly 32 random bytes**.
- Generate one with `npm run keygen`, which prints `crypto.randomBytes(32).toString('base64')`.
- It is required when `--auth accounts` and `TESTNET_ENABLED=1`. Otherwise it is optional and, when absent, the
  HMAC keys below are derived from a random 32-byte `admin_state.audit_salt` instead.
- **Every secret env var is deleted after it is read:** `BEAN_MASTER_KEY`, `BEAN_MASTER_KEYS_OLD`, `ADMIN_TOKEN`,
  `ADMIN_BOOTSTRAP_CODE` (and their `_FILE` variables). Deleting from `process.env` does not scrub the kernel's
  initial environment (`/proc/1/environ`) or `docker inspect`, which is why compose delivers secrets as **files**.
  On Fly/Render/Railway, platform secrets arrive as env vars; that residual exposure is limited to whoever can
  already reach the VM or the platform dashboard, and is accepted.
- It is never accepted as a CLI flag (it would be visible in the process list). The same holds for the admin token
  in accounts mode (`--token` is refused, §2.3).
- Config errors never echo env values (they name the variable only).
- **Key id:** `kid = hex(SHA-256("bean-garden kid v1" ‖ master))[0..16]`.

**Derived keys** (HKDF-SHA256, `crypto.hkdfSync('sha256', ikm, salt='bean-garden/v1', info, 32)`, where `ikm` is
the master key, or `audit_salt` when there is none, except for `K_cred`, which needs the master key):

| `info` | Use |
|---|---|
| `credentials/hl_testnet` | `K_cred`: the AES-256-GCM key for agent keys |
| `audit/ip` | `K_ip`: an HMAC key for `audit_log.ip_hash` (pseudonymous IPs) |
| `audit/name` | `K_name`: an HMAC key for unknown usernames in `login_fail` rows (§4.6 step 3) |
| `auth/device` | `K_dev`: the HMAC key of the known-device cookie (§4.2) |

**Seal:**
```
iv  = randomBytes(12)                                   (unique per record; a new iv on every re-seal)
aad = utf8("cred|v1|" + user_id + "|hl_testnet|" + account_address + "|" + agent_address)
{ct (32 bytes), tag (16 bytes)} = AES-256-GCM(K_cred, iv, aad, plaintext = the 32 raw private-key bytes)
store key_ct, key_iv, key_tag, key_id = kid, enc_version = 1
```

The AAD binds the ciphertext to its row. A ciphertext copied to another user or address fails authentication.

**Use:**
- `credentials.withSigner(uid, async (signer) => …)` is the **only** decrypt path. It:
  1. decrypts into a fresh `Uint8Array(32)`;
  2. builds `signer = makeSigner(keyBytes)` (§6.4);
  3. runs the callback;
  4. in `finally`, calls `keyBytes.fill(0)`.
- The key is never converted to a string, never cached across calls, and never leaves `server/hl/` or
  `server/secrets.js`.
- At connect time the pasted hex string is parsed to bytes immediately, and the string reference is dropped.
  Request-body strings live until GC, which is unavoidable and documented.

### 5.2 Rotation and loss

**P0 rotation (manual, no re-seal code):** the `key_id` column is kept so rotation is possible later, but P0 ships
no re-seal path, because a first deploy has no old keys.
1. Deploy with the new `BEAN_MASTER_KEY_FILE`.
2. At boot, every `credentials` row whose `key_id ≠ kid(new)` gets `status='error', status_reason='key_unavailable'`.
   Those players' testnet bots pause (no flatten is possible without the key) and they see the reconnect banner.
3. Players reconnect with a new API wallet. The runbook tells the operator to warn players first.

**P1 re-seal at boot:**
1. Deploy with `BEAN_MASTER_KEY_FILE=<new>` and `BEAN_MASTER_KEYS_OLD_FILE=<old1>[,<old2>]`.
2. At boot, before serving, every `credentials` row with `key_id ≠ kid(new)` is decrypted with the matching old
   key (looked up by kid) and re-sealed with the new key and a new iv. All of this happens in one transaction.
3. The log shows only the count: `[secrets] re-sealed N credential(s) under kid …`.
4. A row whose kid matches no supplied key gets `status='error', status_reason='key_unavailable'`, as in P0.
5. Remove the old keys after a successful boot.

Old backups stay sealed under the old key. Once that key is destroyed, they cannot be decrypted, which is
intended.

**Loss:** if the master key is lost, every stored agent key is undecryptable. Players reconnect with a new API
wallet. Funds are unaffected, because agents are revocable and cannot withdraw.

### 5.3 Redaction and logging rules (P0, tested in §11.2 T-SECRETS)

1. A catalog op with `sensitive: true` (`auth_signup`, `auth_login`, `auth_reset`, `account_password`,
   `account_delete`, `testnet_connect`, `testnet_agent_approve`, `admin_user`):
   - never has its params logged (the `[api]` line shows `<redacted>`);
   - never echoes input in error messages;
   - on a body JSON parse failure, answers `400 'invalid JSON body'` without the V8 snippet (that snippet can
     contain the key);
   - on an internal error (500), logs **only** `op`, `err.name` and a code (no message, no stack), and the response
     says `internal error` without the message. Today's `sendError` logs `err.stack` and echoes the message; that
     stays for none mode only.
2. **No secrets in URLs.** In accounts mode a POST with a query string is refused before its body is read (§4.4), so
   credentials can never reach a request line, proxy access log, browser history or `Referer`.
3. **Range checks before libraries.** The agent key scalar is checked against `[1, n−1]` with our own BigInt
   comparison before any `@noble/curves` call, because noble's range errors render the value in decimal.
4. A **log sanitizer** wraps the process logger and applies to every line, after allowlisting `0x[0-9a-f]{40}`
   addresses and values of fields named `hash`, `cloid` or `oid`:
   - `/\b(0x)?[0-9a-fA-F]{64}\b/g` → `[hex64]`;
   - base64/base64url runs: `/[A-Za-z0-9+\/_-]{40,}={0,2}/g` → `[b64]`, applied only to runs that contain a digit,
     an upper-case and a lower-case letter and do not start with `/` (so file paths and stack frames survive). This
     covers the 44-character master key and the 43-character session token;
   - `/\b\d{60,}\b/g` → `[dec]` (a key rendered as a decimal integer);
   - `/\b(?:[a-z]{3,8}[\s,.;:|\-\d]+){11,23}[a-z]{3,8}\b/gi` → `[words]` (seed-phrase shape: case-insensitive, and
     tolerant of numbering and punctuation between words). False positives only redact log text, which is safe.
5. `server/hl/exchange.js` builds its own error messages: code, the status string from the exchange truncated to
   300 chars, and the cloid. It never includes request bodies, signatures or keys.
6. The agent key is never present in: any API response, any SSE frame, the JSON state, the journal, the
   `events`/`audit_log`/`orders` tables, or a thrown error.
7. Production runs without `--heapsnapshot-signal`/`--inspect`. `NODE_OPTIONS` is fixed in the Dockerfile. The
   container has `ulimits: core: 0`, so a crash never writes a core dump that could hold a decrypted key (§10.2).
8. `audit_log.detail_json` keeps allowlisted fields only: `{venue, coin, bot, count, code, reason, caps}`.
9. **Wipes are followed by a WAL checkpoint.** After any credential wipe (disconnect, account deletion, admin
   force-disconnect, password reset, mainnet hit) the server runs `PRAGMA wal_checkpoint(TRUNCATE)`, so the
   overwritten pages do not linger in `bean.db-wal`. Backups still hold sealed copies for their retention period,
   which the UI states (§9.2, §9.3).

### 5.4 Audit and admin boundaries

- **Audit actions:**
  - `signup`, `login_ok`, `login_fail`, `logout`, `logout_all`, `password_changed`, `account_deleted`,
    `password_reset_issued`, `password_reset_used`;
  - `testnet_connected`, `testnet_verify`, `testnet_disconnected`, `testnet_revoked_detected`,
    `testnet_agent_replaced`, `mainnet_key_detected`, `testnet_signing_halted`;
  - `garden_halt`, `garden_rearm`, `garden_reset`, `inactivity_pause`;
  - `admin_kill_switch`, `admin_caps`, `admin_user`, `admin_backup`, `admin_bootstrap`, `admin_token_fail`;
  - `keys_resealed` (P1).
- **What admins can do:**
  - see usernames, roles, status, counts of open bots by venue, testnet connection status, and **truncated**
    addresses (`0x1234…abcd`);
  - toggle the kill switch, set caps, disable or enable users, revoke sessions, force-disconnect a credential, and
    issue a password reset code (which wipes the player's testnet credential first, §4.6 step 8).
- **What admins can never do:** read a key, sign for a user, plant or close bots for a user, or read a user's
  events or fills. No op exists for any of these. A password reset cannot be used to reach a player's testnet key,
  because issuing it wipes that key.
- **Trust boundary (stated to players in the connect dialog, §9.3):** whoever operates the server (shell, env and
  DB access) can technically use a stored agent key to trade that testnet account. That is acceptable because it
  is **testnet** and agents cannot withdraw. It is the reason mainnet keys are refused.

---

## 6. Hyperliquid testnet integration

### 6.1 Module layout (`server/hl/`, owned by WP2)

| File | Exports | Notes |
|---|---|---|
| `constants.js` | `TESTNET_INFO_URL='https://api.hyperliquid-testnet.xyz/info'`, `TESTNET_EXCHANGE_URL='https://api.hyperliquid-testnet.xyz/exchange'`, `L1_DOMAIN`, `PHANTOM_SOURCE='b'`, `IOC_SLIPPAGE=0.01`, `FLATTEN_SLIPPAGE_STEPS=[0.01, 0.025, 0.05]`, `MIN_ORDER_USD=10`, `ALLOWED_ACTIONS` | frozen. **There is no mainnet exchange URL anywhere.** |
| `egress.js` | `installEgressGuard({log})`, `EGRESS_ALLOW` (the three exact URLs of §1.2 rule 7), `isAllowedEgress(url, method)` | installed by `main()` only; `T-GUARD` tests the function directly |
| `addr.js` | `normAddr(s) → lower-case 0x…40 or throws`, `sameAddr(a, b)` | **every** address comparison and stored address goes through these (lower-case, §6.7) |
| `msgpack.js` | `packAction(action) → Uint8Array` | `@msgpack/msgpack@2.8.0` `encode` plus guards (§6.4) |
| `signing.js` | `actionHash(action, nonce)`, `agentDigest(connectionId)`, `makeSigner(privKeyBytes) → {address, signL1(action, nonce) → {r,s,v}}`, `recoverL1(action, nonce, sig) → address`, `addressOf(privKeyBytes)`, `isValidScalar(bytes)` (own BigInt range check, §5.3), P1: `recoverUserSigned(primaryType, types, message, chainId, sig)` | `@noble/curves@1.6.0` secp256k1 and `@noble/hashes@1.5.0` keccak_256. The L1 source `"b"` is hard-coded. |
| `format.js` | `fmtPxWire(px, szDecimals)`, `fmtSzWire(sz, szDecimals)`, `floorSz(sz, szDecimals)`, `isWirePx(str, szDecimals)` | §6.5 |
| `wire.js` | `orderWire({asset, isBuy, px, sz, reduceOnly, tif, cloid})`, `orderAction(wires, grouping='na')`, `updateLeverageAction(asset, leverage)`, `cancelByCloidAction(asset, cloid)` (P1), `newCloid()` | builds objects in the **exact** key order (§6.4); `newCloid()` = `'0x' + randomBytes(16).hex` (§6.6) |
| `scheduler.js` | `HlScheduler({budget, ledger, now, sleep})`: `.run(priority, weight, fn)`, `.lane(uid, epoch)` (serial per user; jobs abort when the garden epoch changed), `.cancelLane(uid)`, `.drain(deadlineMs)`, `.stats()` | one weight ledger for the testnet host, shared by info and exchange |
| `info.js` | `TestnetInfo`: `metaAndAssetCtxs()`, `allMids()`, `l2Book(coin)`, `clearinghouseState(user)`, `spotClearinghouseState(user)`, `userFillsByTime(user, start, end)` (paginated, §6.11), `userFunding(user, start)` (at close completion), `orderStatus(user, cloidOrOid)`, `userRole(addr)`, `extraAgents(user)`, `userAbstraction(user)`, `userRateLimit(user)`, `exchangeStatus()` | every call goes through the scheduler with the documented weight and `redirect:'error'` |
| `market.js` | `TestnetMarket`: `start()/stop()`, `coinInfo(coin) → {index, sz_decimals, max_leverage, delisted, only_isolated, margin_mode} \| null`, `quote(coin) → {px, ms} \| null`, `ctx(coin) → {funding_1h, mark_px, ms} \| null`, `book(coin) → {depth_buy_usd_1pct, depth_sell_usd_1pct, ms} \| null` (shared cache), `state() → 'live'\|'delayed'\|'down'\|'disabled'`, `snapshot()` (for the `mids` frame), `listing()` | `allMids` every 5 s; `metaAndAssetCtxs` every 5 min and at boot; `l2Book` per coin **on demand, at most once per 30 s per coin, de-duplicated and shared by all players** |
| `exchange.js` | `TestnetExchange.post(action, signer, nonce) → {ok, statuses?, code?, error?, transport?, http?}` | the **only** `/exchange` POST. It asserts the URL and the action allowlist, and uses `redirect:'error'`. |
| `errors.js` | `classify(responseOrStatus, {agentAddress, accountAddress, attempt, hadTransportFailure}) → code`, `RETRY` table, `EXCHANGE_CODES` (exported for the i18n parity test) | §6.9 |
| `verify.js` | `verifyAgent({accountAddress, agentKeyBytes, info, mainnetInfo}) → {ok, code?, agent_address, agent_name, valid_until_ms, abstraction, account_value, withdrawable, positions, warnings}`; `mainnetRecheck(agentAddress, mainnetInfo) → 'missing' \| role \| 'unavailable'` | §6.7 |
| `index.js` | `createTestnet({fetch, now, sleep, log, budget, mainnetClient})` → `{scheduler, info, market, exchange, verify}` | `fetch` is injectable (tests and `--testnet-double` use the double, §11.1) |

**New dependencies.** These are the only ones. They are pinned exactly in `package.json` (no `^`), and
`package-lock.json` is committed:
- `@noble/curves` `1.6.0`
- `@noble/hashes` `1.5.0`
- `@msgpack/msgpack` `2.8.0`

The server imports them only from `server/hl/`. `three` stays browser-only.

### 6.2 What we send (wire formats)

**Top-level request** (`POST TESTNET_EXCHANGE_URL`, `content-type: application/json`, `AbortSignal.timeout(8000)`,
`redirect: 'error'`):
```json
{ "action": { … }, "nonce": 1791700000123, "signature": { "r": "0x…64 hex", "s": "0x…64 hex", "v": 27 },
  "vaultAddress": null, "expiresAfter": null }
```
- `r` and `s` are sent zero-padded to 64 hex digits. The SDK's `to_hex(int)` strips leading zeros, so some of
  its KAT strings have 62 or 63 digits. KAT comparison is **numeric** (§6.12).
- `vaultAddress` is always `null`.
- `expiresAfter` is always `null` in P0. In P1 it may carry `now + 20 s`, which changes the hash tail (§6.4 step
  3) and needs a manual testnet check first.

**Actions** (keys exactly in this order; ints are JSON numbers; prices and sizes are strings):

| Action | JSON (key order is significant) |
|---|---|
| updateLeverage | `{"type":"updateLeverage","asset":<int>,"isCross":false,"leverage":<int>}` |
| order (IOC) | `{"type":"order","orders":[{"a":<int>,"b":<bool>,"p":"<px>","s":"<sz>","r":<bool>,"t":{"limit":{"tif":"Ioc"}},"c":"0x<32 hex>"}],"grouping":"na"}` |
| cancelByCloid (P1) | `{"type":"cancelByCloid","cancels":[{"asset":<int>,"cloid":"0x<32 hex>"}]}` |
| trigger order (P1, positionTpsl) | order wire with `"t":{"trigger":{"isMarket":true,"triggerPx":"<px>","tpsl":"tp"\|"sl"}}`, `"r":true`, grouping `"positionTpsl"`. The trigger key order is `isMarket, triggerPx, tpsl` (SDK `order_type_to_wire`). |

**Responses we parse** (shapes as in the docs and the official Rust SDK's `ExchangeDataStatus` enum:
`Success | WaitingForFill | WaitingForTrigger | Error(String) | Resting | Filled`):
- `{"status":"ok","response":{"type":"order","data":{"statuses":[ S ]}}}` where `S` is either an **object**:
  - `{"filled":{"totalSz":"0.02","avgPx":"1891.4","oid":77747314}}`;
  - `{"resting":{"oid":…}}`, which must not happen for IOC: treat it as an anomaly, log it, and cancel by cloid in
    P1;
  - `{"error":"…"}`;
- or a **bare string** (the parser checks `typeof S === 'string'` before any `in` test):
  - `"success"` (cancel / cancelByCloid, P1) → done;
  - `"waitingForFill"` / `"waitingForTrigger"` (trigger and TP/SL orders, P1) → resting-like;
  - any other string → `rejected_other` with the string stored.
- `updateLeverage` answers `{"status":"ok","response":{"type":"default"}}`.
- Top-level failures look like `{"status":"err","response":"<text>"}`.
- **HTTP status:** 2xx → parse as above. 429 → `ip_rate_limited`. Any other 4xx → `client_error` (the body may be
  plain text, not JSON; it is stored truncated). ≥ 500 → `transport`. A redirect is an error (`redirect:'error'`)
  and is classified `client_error` with an alert, never followed.

### 6.3 Testnet listing (re-read at runtime; snapshot of 2026-10-11)

Eligibility for the testnet venue: the coin is in testnet `meta.universe` **and** `isDelisted !== true`. The
asset index is the position in the testnet universe and is used as `a` / `asset`.

| Coin | testnet idx | szDec | maxLev | testnet mid | mainnet idx / szDec / maxLev / mid | Tradeable on testnet |
|---|---|---|---|---|---|---|
| BTC | 3 | 5 | 40 | 82306.5 | 0 / 5 / 40 / 82992.5 | yes |
| ETH | 4 | 4 | 25 | 2492.45 | 1 / 4 / 25 / 2502.35 | yes |
| SOL | 0 | 2 | 10 | 108.91 | 5 / 2 / 20 / 109.415 | yes (lev ≤ 10) |
| HYPE | 135 | 2 | 10 | 41.199 | 159 / 2 / 10 / 84.7915 | yes (onlyIsolated, strictIsolated) |
| XRP | – | – | – | – | 25 / 0 / 20 | **no (unlisted)** |
| DOGE | 173 | 0 | 10 | 0.083946 | 12 / 0 / 10 | yes |
| AVAX | 7 | 2 | 10 | 10.307 | 6 / 2 / 10 | yes |
| LINK | – | – | – | – | 18 / 1 / 10 | **no (unlisted)** |
| SUI | 25 | 1 | 10 | 1.10325 | 14 / 1 / 10 | yes |
| NEAR | 54 | 1 | 20 | 5.40475 | 74 / 1 / 10 | yes |
| ARB | 13 | 1 | 10 | 0.19367 | 11 / 1 / 10 | yes |
| TIA | 42 | 1 | 10 | 0.61223 | 63 / 1 / 5 | yes |
| ZEC | 193 | 0 | 3 | 138.65 | 214 / 2 / 10 / 1223.05 | **no (`isDelisted: true`)** |
| WIF | 78 | 0 | 5 | 0.223875 | 98 / 0 / 5 | yes |
| PUMP | 179 | 0 | 10 | 0.005528 | 200 / 0 / 10 | yes |
| VVV | 154 | 2 | 3 | 22.395 | 178 / 2 / 3 | yes |

A test (§11.2 T-LIST) asserts that the code never hard-codes these numbers. The fixture
`test/fixtures/hl-testnet-meta.json` captures this snapshot.

### 6.4 Signing algorithm (L1 actions; byte-exact)

All L1 actions (`order`, `cancelByCloid`, `updateLeverage`) are signed by the agent:

1. **msgpack.**
   - `bytesA = encode(action)` with `@msgpack/msgpack@2.8.0` defaults (`sortKeys: false`, `forceFloat32: false`,
     `ignoreUndefined: false`).
   - Map keys are emitted in JS insertion order, which **must** equal the order in §6.2.
   - Integers use the smallest unsigned form: positive fixint `0x00–0x7f`; `0xcc` u8; `0xcd` u16; `0xce` u32;
     `0xcf` u64. Values above 2^32−1, such as `100000000000` in the dummy KAT, are `0xcf` + 8 bytes BE.
   - `true`/`false` are `0xc3`/`0xc2`. `null` is `0xc0`.
   - Strings use fixstr `0xa0|len` (< 32 bytes) or str8 `0xd9 len`. Arrays use `0x90|n`. Maps use `0x80|n`.
   - **Guards in `packAction`:**
     - throw on any `undefined` value (it would encode as nil);
     - throw on a non-integer number (a float in an action is a bug: prices and sizes are strings);
     - throw on a negative integer or one above `Number.MAX_SAFE_INTEGER`;
     - throw on a BigInt;
     - check the top-level and order-wire key order against a schema per `action.type`.
2. **Nonce tail.** `bytesN = u64be(nonce)`, 8 bytes, big-endian.
3. **Vault byte.** Append `0x00` (no vault).
   - P1 only: if `expiresAfter` is used, also append `0x00 ‖ u64be(expiresAfter)`. This mirrors SDK
     `action_hash` exactly.
4. **connectionId** = `keccak_256(bytesA ‖ bytesN ‖ 0x00)`, 32 bytes.
5. **Phantom agent** = `{source: "b", connectionId}`. `"b"` means testnet. Mainnet would be `"a"`, which we never
   produce.
6. **EIP-712 digest:**
   ```
   DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
   domainSeparator = keccak256(DOMAIN_TYPEHASH ‖ keccak256("Exchange") ‖ keccak256("1") ‖ u256be(1337) ‖ 0x00×32)
                   = 0xd79297fcdf2ffcd4ae223d01edaa2ba214ff8f401d7c9300d995d17c82aa4040      (KAT-D1)
   AGENT_TYPEHASH  = keccak256("Agent(string source,bytes32 connectionId)")
                   = 0x26f05c2f7239b6983075e58321292d77b3aa173d19b27257ac96ab362570f508      (KAT-D2)
   structHash      = keccak256(AGENT_TYPEHASH ‖ keccak256("b") ‖ connectionId)
   digest          = keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ structHash)
   ```
7. **Sign.** `secp256k1.sign(digest, priv, {lowS: true})`. This is deterministic RFC 6979 (the noble default).
   - `r = sig.r`, `s = sig.s` (low-s; noble normalizes, and if s was flipped the recovery bit flips with it).
   - `v = 27 + sig.recovery`.
   - Wire form: `{r: '0x'+hex64(r), s: '0x'+hex64(s), v}`.
8. **Self-check (P0).** `recoverL1(action, nonce, sig)` must equal `signer.address` before sending. A mismatch
   throws `signing_selfcheck`. This guards only **curve and recovery-bit** bugs. It cannot catch a payload bug
   (msgpack key order, a trailing zero in a price), because it recovers from our own `packAction` output; the
   official signing page warns about exactly this. Payload bugs are caught by the KATs, the `packAction` schema
   guards, the double's independent re-encoding (§11.1) and, in production, the `signature_mismatch`
   classification (§6.9).

**Annotated example: the official phantom-agent KAT** (asset 4, buy 0.0147 @ 1670.1 IOC, nonce
1677777606040):
```
83                               map(3)
a4 74797065                      "type"
a5 6f72646572                    "order"
a6 6f7264657273                  "orders"
91 86                            array(1) → map(6)
a1 61 04                         "a": 4
a1 62 c3                         "b": true
a1 70 a6 313637302e31            "p": "1670.1"
a1 73 a6 302e30313437            "s": "0.0147"
a1 72 c2                         "r": false
a1 74 81 a5 6c696d6974 81 a3 746966 a3 496f63      "t": {"limit": {"tif": "Ioc"}}
a8 67726f7570696e67 a2 6e61      "grouping": "na"
‖ 00000186a3569598               nonce u64 BE (1677777606040)
‖ 00                             vault: none
keccak256 → 0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908   (KAT-1, official)
```

### 6.5 Price and size formatting (wire strings)

The rules (Hyperliquid "tick and lot size", perps):
- A price has ≤ 5 significant figures **and** ≤ `6 − szDecimals` decimals. Integer prices are always allowed.
- A size is rounded to `szDecimals`.
- Trailing zeros are removed, because the exchange re-serializes the action and a different string changes the
  hash.

```js
fmtPxWire(px, d):   // px > 0 finite, d = testnet szDecimals
  const maxDec = Math.max(0, 6 - d);
  let x = Number(px.toPrecision(5));            // 5 significant figures
  x = Number(x.toFixed(maxDec));                 // ≤ 6 − szDecimals decimals
  return stripZeros(x.toFixed(maxDec));          // "83130", "0.084785", never "1e-7", never "-0"
fmtSzWire(sz, d):   // sz > 0
  const lots = Math.floor(Math.abs(sz) * 10 ** d + 1e-9);   // floor to the lot (never round a size up)
  if (lots === 0) throw new RangeError('size below one lot');
  return stripZeros((lots / 10 ** d).toFixed(d));
stripZeros(s) = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
```

IOC limit price: `fmtPxWire(testnetMid × (1 + s·sign), szDecimals)`. Buys go above the mid and sells below.
- Opening and mirror orders: `s = IOC_SLIPPAGE = 1%`.
- Reduce-only **flatten** retries widen through `FLATTEN_SLIPPAGE_STEPS`: 1% → 2.5% → 5%, then every 15 s at 5%
  (§6.11). The official SDK's market close uses 5% by default; 5% is far inside the exchange's reference-price band.
  An IOC fills at book prices, so the band is a worst case, not the expected fill.

Required examples (unit tests, §11.2 T-FMT). The mids are from the 2026-10-11 table:

| Case | Input | Output |
|---|---|---|
| BTC buy (d=5) | 82306.5 × 1.01 = 83129.565 | `"83130"` |
| BTC sell | 82306.5 × 0.99 | `"81483"` |
| ETH buy (d=4) | 2492.45 × 1.01 | `"2517.4"` |
| SOL buy (d=2) | 108.91 × 1.01 = 109.9991 | `"110"` |
| HYPE buy (d=2) | 41.199 × 1.01 | `"41.611"` |
| DOGE buy (d=0) | 0.083946 × 1.01 | `"0.084785"` |
| PUMP sell (d=0) | 0.005528 × 0.99 | `"0.005473"` |
| ARB buy (d=1) | 0.19367 × 1.01 | `"0.19561"` |
| docs: too many sig figs | 1234.56 (d=0) | `"1234.6"` |
| docs: too many decimals | 0.0012345 (d=0) | `"0.001234"` |
| docs: d=1 | 0.012345 | `"0.01235"` |
| large integer | 123456.7 (d=0) | `"123460"` |
| size BTC | 0.0012345 (d=5) | `"0.00123"` |
| size DOGE | 1234.9 (d=0) | `"1234"` |
| size ETH | 0.1 (d=4) | `"0.1"` |
| size float noise | 2.999999999 (d=2) | `"2.99"` |
| SDK parity: px (`fmtPxWire`, d=4) | 1670.1 | `"1670.1"` |
| SDK parity: sz (`fmtSzWire`, d=4) | 0.0147 | `"0.0147"` |
| SDK parity: px (`fmtPxWire`, d=1) | 100, 103 | `"100"`, `"103"` |
| SDK parity: sz (`fmtSzWire`, d=0) | 100 | `"100"` |

The SDK's `float_to_wire` uses 8 decimals, while perp prices allow at most `6 − szDecimals`. Its `0.00001231` case
therefore has no perp equivalent: `fmtPxWire(0.00001231, 0)` correctly gives `"0.000012"` and
`fmtSzWire(0.00001231, 5)` gives `"0.00001"` (verified by running the code above). That value is not a parity case.

### 6.6 Nonces and cloids

**Nonce (per agent = per credential):**
- `nonce = max(Date.now(), credentials.last_nonce + 1)`.
- It is written to `credentials.last_nonce` **in the same transaction** that inserts the `pending` order row,
  committed before the POST.
- All exchange actions of one user run on that user's **serial lane** (`scheduler.lane(uid)`), so nonces are
  strictly increasing and never concurrent.
- Exchange rules this satisfies:
  - The exchange keeps the 100 highest nonces per signer.
  - A new nonce must be > the smallest of them and never reused.
  - A nonce must lie in `(T − 2 days, T + 1 day)`.
- **Clock check:** `exchangeStatus.time` (weight 2) is read at boot and every 10 min, giving `skew = server − HL`.
  - |skew| > 5 s: log a warning.
  - |skew| > 60 s: testnet state `down` with reason `clock_skew` (no orders).
- The player is told to use a **dedicated** API wallet for the garden (§9.3). If the same agent signs elsewhere,
  ms nonces still rarely collide, and a duplicate is classified `nonce` (§6.9).

**cloid:**
- `newCloid() = '0x' + randomBytes(16).toString('hex')`: 16 random bytes, lower-case. It is stored in
  `orders.cloid` (UNIQUE) in the write-ahead transaction that commits **before** the POST.
- It is not derived from the row id, so it stays unique across a backup restore (§10.5), where row ids written
  after the backup point would repeat. Crash reproducibility comes from the committed column.
- Hyperliquid documents a cloid only as an optional 128-bit hex string. It does **not** promise that a duplicate
  cloid is rejected, so the cloid is used only to **look an order up** (`orderStatus`), never as a de-duplication
  guarantee.

**Idempotency rule:** we **never re-sign** an order intent after any transmission whose outcome is unknown.
- After a transport failure (timeout, reset, 5xx) on a transmission, `orders.transport_failed = 1`. We may
  **resend the identical signed bytes** (same nonce, same cloid) up to 2 times within 10 s (`orders.attempts`).
- A **nonce error** is interpreted by context (§6.9 `nonce` row):
  - on the **first** transmission of an order that has had **no** transport failure, the order was not executed. It
    gets **one** new attempt with a fresh nonce and a new signature, keeping the same cloid;
  - on a resend (attempt ≥ 2), or for any order with `transport_failed = 1`, a nonce error most likely means the
    first transmission **was** executed. The order becomes `unknown` and is resolved by `orderStatus`. It is
    **never** re-signed.
- **Resolution** with `orderStatus(account, cloid)`:
  - `{status:'order', order:{order:{oid, origSz, sz, …}, status}}`: store `oid`, set
    `filled_sz = origSz − sz`, and map the status (`filled`, `canceled`, `iocCancelRejected`, `marginCanceled`,
    `reduceOnlyRejected`, `perpMarginRejected`, `minTradeNtlRejected`, … → `filled` / `partial` / `canceled` /
    `rejected` with the exchange status string in `orders.error`). "Apply the result" means exactly this: status and
    filled size come from `orderStatus`; **price, fee and closed P&L come only from the fills sweep** (§6.11),
    because `orderStatus` carries `limitPx`, not a fill price or fee.
  - `{status:'unknownOid'}`: the order status is `unknown` until the next bar's reconcile (§6.11), which resolves
    unresolved orders first and reads the true position; the mirror computes a fresh delta from it.
- Position-based mirroring (`target − actual`) is inherently idempotent.

### 6.7 Credential verification (`verify.js`; at connect, on `testnet_verify`, and periodically)

Steps, in order. Each failure stops and returns a code. **Every address is normalized with `normAddr()` (lower-case)
before it is compared or stored**: Hyperliquid and the SDK use EIP-55 mixed-case addresses in places (the SDK's
`approve_agent` posts the checksummed `account.address`), and the signing docs recommend lower-casing.

1. Format checks (no network):
   - `account_address` matches `^0x[0-9a-fA-F]{40}$`, then is lower-cased. Otherwise `400 bad_address`.
   - `agent_key` is checked by its trimmed form:
     - 12 or more words (case-insensitive, any separators) → `422 seed_phrase` (nothing is logged);
     - `^(0x)?[0-9a-fA-F]{64}$` with a scalar in [1, n−1], checked by `isValidScalar` (own BigInt comparison,
       before any library call) → accepted;
     - otherwise `400 bad_key_format`.
   - These refusals do not count against the 5-per-hour connect limit (§4.5).
2. `agent_address = addressOf(key)`. If `agent_address === account_address` → `422 master_key` ("this is the
   account's own key").
3. **Testnet role** `userRole(agent_address)` (testnet, weight 60) must be exactly `{role:'agent', data:{user}}`
   with `normAddr(data.user) === account_address`:
   - role `user` → `422 master_key`;
   - role `missing` → `422 not_agent`;
   - another account → `422 agent_mismatch` (the error includes the truncated address the agent belongs to).
   Running this **before** the mainnet check means a random well-formed key never spends mainnet weight.
4. **Mainnet guard, fail-closed.** `userRole(agent_address)` on the **mainnet info** endpoint (read-only, weight 60,
   through the engine's `HyperliquidClient` queue at the lowest priority, one retry, 10 s deadline in total):
   - role `missing` → continue. A freshly generated testnet API wallet is always `missing` on mainnet, so
     legitimate players are unaffected;
   - any other role (`user`, `agent`, `vault`, `subAccount`) → `422 mainnet_key` with sub-reason `mainnet_<role>`.
     Nothing is stored. Audit `mainnet_key_detected`;
   - the call fails or times out → `503 mainnet_check_unavailable`. Nothing is stored. The player may retry; the
     attempt does count against the connect limit.
5. Testnet `extraAgents(account_address)` (weight 20). Find the entry with `sameAddr(address, agent_address)`:
   - take its `name` and `validUntil` → `agent_name`, `valid_until_ms`;
   - `validUntil < now + 1 h` → `422 agent_expired`;
   - `validUntil < now + 7 d` → warning `{code:'agent_expiring_soon', valid_until_ms}`;
   - not listed (an **unnamed** agent): `valid_until_ms = null` and warning `{code:'unnamed_agent'}`. Hyperliquid
     deregisters an unnamed API wallet as soon as **any** new unnamed approval is sent for the account, so the
     player is told to create a **named** API wallet instead (`g.tn.warn.unnamed`).
6. Testnet `userAbstraction(account_address)` (weight 20), stored in `abstraction`:
   - `"default"` or `"disabled"` → **standard**: balances from `clearinghouseState`;
   - `"unifiedAccount"` → **unified** (Hyperliquid's recommended mode for most users): balances from
     `spotClearinghouseState`, positions still from `clearinghouseState` (step 7);
   - `"portfolioMargin"` or `"dexAbstraction"` (discontinued) → `422 abstraction_unsupported`. The message tells the
     player to switch the testnet account to Standard (manual) or Unified on the testnet site.
7. **Balances and positions.** `clearinghouseState(account_address)` (weight 2) gives `positions` (and, for standard
   accounts, `account_value = marginSummary.accountValue`, `withdrawable`). For unified accounts,
   `spotClearinghouseState(account_address)` (weight 2) gives the USDC `total` and `hold`:
   `balance = total`, `free = total − hold`, and `account_value = total + Σ position.unrealizedPnl`, marked as an
   estimate (`≈`) until runbook R5 confirms how the testnet site computes it (risk K1, §12.5).
   - `account_value = 0` → `422 no_testnet_funds` (Hyperliquid prunes the API wallets of accounts without funds, so
     there is nothing to trade). The error links the faucet (`g.tn.faucet`).
   - `0 < account_value < min_capital_usd` (20) → warning `{code:'no_funds'}` (`g.tn.noFunds`).
   - Non-zero positions on our coins → warning `{code:'existing_positions', coins}` ("the garden will not touch
     positions on coins without a bot, but use a dedicated account").
8. **Seal and upsert** with `status='verified'`, `mainnet_checked_ms = now`, `value_at_connect = account_value`.
   - **Same garden, same account** (a connected garden pasting a new API wallet for the account it already uses):
     this is **Replace API wallet**. It runs on the player's lane after in-flight jobs finish, re-seals the new key in
     one transaction (`last_nonce` restarts at 0, which is safe because nonces are per signer), keeps every bot, and
     writes audit `testnet_agent_replaced`. A different account on a connected garden is still `409
     already_connected` (disconnect first).
   - The UNIQUE indexes are **partial** (`status IN ('pending','verified')`), so a revoked or error row never blocks a
     connect. They still stop the same live agent or account being attached to two gardens (`409 agent_in_use` /
     `409 account_in_use`).
   - **Take-over of an abandoned account.** If another garden holds a revoked or error row for the same account, that
     row is wiped and that garden's open testnet bots are closed **in our books only** (no orders; note code
     `account_moved`), so fills are never attributed to two gardens.
   - Write audit `testnet_connected`.

The total weight is ≈ 104 testnet (106 for unified) plus 60 mainnet. Connects run at the **lowest** scheduler
priority and are limited to 2 per minute globally, so they never starve trading.

**Periodic mainnet re-check.** Every stored `verified` credential is re-checked against mainnet (step 4 only):
- on every `testnet_verify`;
- at boot, and then whenever `mainnet_checked_ms` is older than 24 h. Due checks are queued on the mainnet client at
  the lowest priority and share the **≤ 2 per minute** mainnet `userRole` slot with connects (connects first;
  ≤ 120 mainnet weight/min, §6.8), never all at once. 2 per minute is 2,880 checks a day, far above the number of
  stored credentials;
- a failed or timed-out re-check is retried at the next slot and does not change the credential;
- a **hit** (any role other than `missing`) flattens the player's testnet bots at P0 priority with a 60 s deadline
  (the testnet-only signer cannot act on mainnet, and flattening avoids stranded positions), then **wipes** the
  credential (zero, delete, WAL checkpoint), pauses the bots with note code `mainnet_key`, emits
  `credential_status {status:'revoked', reason:'mainnet_key'}` and writes audit `mainnet_key_detected`.

### 6.8 Rate-limit budget (per IP, testnet host)

Hyperliquid limits (rate-limits page):
- REST: **1200 weight/min per IP**.
- Info weights: 2 for `allMids`, `clearinghouseState`, `spotClearinghouseState`, `orderStatus`, `exchangeStatus`,
  `l2Book`; 20 for all other documented requests including `metaAndAssetCtxs`, `extraAgents`, `userAbstraction`,
  `userRateLimit`; **60** for `userRole`.
- `userFills`/`userFillsByTime` add 1 per 20 items returned. Time-range responses return at most 500 elements per
  page; `userFillsByTime` returns at most 2,000 fills per response and only the 10,000 most recent fills exist.
- An exchange action weighs `1 + floor(batch/40)`.
- Per **address**: 10,000 initial requests plus 1 per USDC traded. When limited, 1 request per 10 s. This applies
  to actions only.
- WebSocket: at most 10 unique users across user subscriptions per IP. That cannot serve 40 players, so **REST
  only**.

Our configuration:
- Our testnet budget is `TESTNET_BUDGET = 800` weight per rolling 60 s, covering testnet info **and** exchange.
  Burst ceiling: 900 (flatten storms).
- **Assumption, stated plainly:** `api.hyperliquid.xyz` and `api.hyperliquid-testnet.xyz` are separate deployments
  and are treated as **independent** per-IP limiters. The mainnet side is: steady state 364/min (SPEC §2.2), plus
  the mainnet `userRole` guard (connects and periodic re-checks **share one slot of ≤ 2 per minute**, connects
  first), i.e. ≤ 120/min, for ≤ 484/min, inside the existing client's `LEDGER_BUDGET` of 1000 (warm-up bursts use
  `BOOT_BUDGET` 1150). If Hyperliquid ever counted both hosts together, mainnet 429s would show it (alert in §10.6);
  the mitigation is to lower `TESTNET_BUDGET` to 600 (risk K11, §12.5).
- HTTP 429 → 15 s back-off for the whole testnet host. A 429 is never retried inside the back-off.
- **User-triggered GETs never spend weight.** `testnet_status`, `testnet_quote`, `testnet_market` and `me` read only
  cached snapshots: the last reconcile, the last `userRateLimit`, and `TestnetMarket` (mids, contexts, the shared
  `l2Book` cache). They never enqueue a Hyperliquid request of their own. The only exception is the shared book
  cache: a quote for a coin whose book is older than 30 s schedules **one** de-duplicated `l2Book` refresh for that
  coin, whoever asks, so the cost is bounded by coins, not by users. The only per-user Hyperliquid calls a player can
  trigger are `testnet_connect` / `testnet_verify` (5 per hour) and bot commands.

**Per active testnet player per minute** ("active" as in the glossary; max 3 bots by default caps):

| Item | Weight | Typical | Worst |
|---|---|---|---|
| `clearinghouseState` each bar (reconcile) | 2 | 2 | 2 |
| `spotClearinghouseState` each bar (**unified** accounts only; counted for everyone here) | 2 | 2 | 2 |
| `userFillsByTime` sweep: once per 5 bars when provisional fills exist, otherwise every 30 bars (+20 per extra page) | 20 + ⌈n/20⌉ | 4.2 | 4.2 |
| `orderStatus` for unresolved orders (transport errors, reconcile step 2) | 2 | ~0 | 1 |
| exchange actions: orders, plus `updateLeverage` **before every open from flat** (§6.11) | 1 each | 0.7 | 9 (3 bots flip: close + leverage + open) |
| `userRateLimit` hourly | 20 | 0.33 | 0.33 |
| **Sum per player** | | **≈ 9.2** | **≈ 18.5** |

Fixed costs: `allMids` every 5 s = 24, `metaAndAssetCtxs` every 5 min = 4, `exchangeStatus` every 10 min = 0.2, the
shared `l2Book` cache ≈ 2 typical and ≤ 52 worst (13 coins × weight 2 × twice a minute). Total ≈ 30 typical,
≤ 80 worst.

| Active testnet players N | Typical total | Worst total | vs 800 |
|---|---|---|---|
| 10 | 122 | 265 | OK |
| 20 | 214 | 450 | OK |
| 30 | 306 | 635 | OK |
| 40 | 398 | 820 | at the limit in the worst minute: the degradation order below absorbs it (≈ 720) |
| 60 | 582 | 1190 | **refused**: over `TESTNET_MAX_ACTIVE_USERS` |

- Hence `TESTNET_MAX_ACTIVE_USERS = 40` by default (it was 60 before the leverage-before-open, unified-balance and
  order-book items were added). Testnet `bot_create` or `bot_resume` from a player who is not yet active, while 40
  players are active, answers `503 testnet_capacity`. The default may be raised after T-PERF and M4 measurements.
- **Degradation order** when `weight_60s > 0.9 × budget`:
  1. the fills sweep stretches to 10 bars;
  2. `userRateLimit` is skipped;
  3. the `l2Book` cache TTL stretches to 120 s;
  4. `clearinghouseState` (and `spotClearinghouseState`) run every 2nd bar for players without pending orders;
  5. new testnet connects queue.
- Orders and flattens are never degraded.
- **Scheduler priorities**, highest first, round-robin across players within a priority:
  - P0 flatten (pause, close, halt, kill, delete, mainnet hit, expiry, inactivity);
  - P1 testnet `allMids`;
  - P2 mirror orders and leverage;
  - P3 reconcile `clearinghouseState` / `spotClearinghouseState`;
  - P4 `orderStatus`;
  - P5 fills sweep;
  - P6 `metaAndAssetCtxs` / `exchangeStatus` / `userRateLimit` / `l2Book`;
  - P7 credential verification.
- **Address budget** per player: ≈ 1,440 actions a day at 1 per minute worst case, against 10,000 plus volume
  credit. `userRateLimit` is shown in Settings as "requests left".
  - When `nRequestsCap − nRequestsUsed < 200`: a warning (`live_error` code `address_budget_low`).
  - Below 50: testnet bots stop **opening** (closing still allowed).

### 6.9 Error taxonomy and retry rules (`errors.js`)

Classification uses the HTTP status first, then a case-insensitive substring match on the exchange text. Unknown
text → `rejected_other`, with the raw text stored (300 chars). The double (§11.1) emits these exact strings. Every
code is exported in `EXCHANGE_CODES` and has a localized key `g.err.<code>` (§9.7.2).

**Address-bearing errors.** Hyperliquid answers a **wrong signature** with the same texts it uses for a missing
agent or an unfunded user (`L1 error: User or API Wallet 0x… does not exist.` / `Must deposit before performing
actions. User: 0x…`), naming the address it recovered. `classify()` therefore parses the first `0x[0-9a-fA-F]{40}`
from the text, normalizes it, and compares it with the credential's `agent_address` and `account_address`. A signing
regression (key order, a trailing zero) must never be mistaken for a revoked wallet, because that would revoke every
player's credential and pause all their bots.

| Code | Match (substring) or condition | Retry policy | Bot effect |
|---|---|---|---|
| `transport` | timeout, network error, HTTP ≥ 500 | `transport_failed = 1`; resend the **identical bytes** ≤ 2× in 10 s, then `orderStatus(cloid)` | order `unknown` if unresolved; reconcile next bar |
| `ip_rate_limited` | HTTP 429 | host back-off 15 s; the job stays queued (a 429 was not processed) | none |
| `client_error` | any other HTTP 4xx (body may be plain text), or a redirect | **definitive**: never resent | order `rejected`; `live_error` on that bot; **alert log** (a wire-format bug) |
| `address_rate_limited` | "too many cumulative requests" / "rate limit" in an ok-200 err | per-player back-off 10 s → 20 → 40 → 60 s | `live_error` |
| `nonce` | "nonce" | **Only** on the first transmission of an order with no earlier transport failure: not executed, so **one** new attempt with a fresh nonce and the **same cloid**. On a resend (attempt ≥ 2) or for an order with `transport_failed = 1`: the first transmission was probably executed, so the order becomes `unknown` and is resolved with `orderStatus(account, cloid)`. **Never re-signed** in that case. | none / as resolved |
| `signature_mismatch` | "does not exist" or "must deposit", naming an address that is **neither** our `agent_address` **nor** our `account_address` | none. **Testnet signing halts for everyone**: testnet state `down` with reason `signing`, no further sends (flattens included, as they would fail the same way), persisted in `admin_state.testnet_signing`, audit `testnet_signing_halted`, alert. It is cleared only by an admin (`admin_testnet_signing {resume:true}`) after a fix. | credentials untouched; bot intents kept (flattens resume after the fix) |
| `agent_unknown` | "does not exist" naming **our `agent_address`** | none; confirm with testnet `userRole(agent_address)` (P4): role `missing` or not an agent of the account → revoked; still the account's agent → `rejected_other` plus an alert | when confirmed: credential `revoked`; **all** of the player's testnet bots pause with note code `credential_revoked` (no flatten is possible); urgent banner |
| `no_deposit` | "must deposit before performing actions" naming our account (or our agent) | none; a `userRole` confirm is queued (Hyperliquid prunes the agents of unfunded accounts, which then shows as `agent_unknown`) | the credential **stays verified**; no bot is paused for it alone; order `rejected`; `live_error` once; new plants are refused with `insufficient_testnet_balance` and the faucet link |
| `min_notional` | "minimum value of $10" | skip until the target changes | order `skipped` reason `below_min_order` |
| `insufficient_margin` | "insufficient margin" | next bar | `live_error`; after 3 consecutive the bot pauses (note code `insufficient_margin_repeat`) |
| `ioc_no_match` | "could not immediately match" | next bar. Flatten: retried 2 s apart with a fresh mid at 1% → 2.5% → 5% slippage, then every 15 s at 5% (§6.5) | `live_error` once per situation |
| `reduce_only` | "reduce only order would increase" | reconcile now | as reconcile decides |
| `price_band` | "away from the reference price" / "too far from" | next bar | `live_error` |
| `tick` | "tick size" / "invalid price" | none (a formatting bug) | `live_error`; alert log |
| `leverage_rejected` | "leverage" on `updateLeverage` | none | bot paused, note code `leverage_rejected` |
| `oi_cap` | "open interest" | next bar | `live_error` |
| `rejected_other` | anything else, including an unexpected **bare string** status | next bar | `live_error` |

Rules:
1. A rejection or error affects **only that bot** (except `signature_mismatch`, which is a code bug and stops all
   sends). The lane continues with the next job.
2. Errors are keyed per situation, as in SPEC §2.6 (`#setError` keying), so a persisting error emits one
   `live_error`, not one per bar.
3. Every exchange error increments `admin_status.testnet.errors_60s`.
4. `live_error` carries `code` (and `note_code` on pauses) so the client shows localized text; the raw exchange text
   is only a collapsible detail (§9.5).

### 6.10 Browser-wallet approveAgent (P1)

The player's **real** browser wallet signs here, so nothing the server sends may be able to turn this into a
mainnet approval. The client builds the typed data itself from frozen constants; the server only supplies values
that the client checks.

1. `testnet_agent_prepare {}`:
   1. The server generates `agentKey = randomBytes(32)` (a valid scalar).
   2. It seals the key into `credentials` with `status='pending'` and a placeholder `account_address`. The pending
      row expires after 10 min.
   3. It returns **only** `{agent_address, nonce, agent_name}`, where `agent_name = "bean-garden valid_until <ms>"`
      (90 days ahead; Hyperliquid allows at most 180) and `nonce` is the current ms time.
2. The browser (`ui/testnet.js`):
   1. checks the three values against their expected formats (`^0x[0-9a-f]{40}$`; `^bean-garden valid_until
      \d{13}$` with a time 1–180 days ahead; a nonce within ±5 min of the local clock) and refuses to continue on any
      mismatch;
   2. calls `eth_requestAccounts`, then reads `eth_chainId` (`chainId`, an integer);
   3. builds the typed data from **frozen constants**:
      - domain `{name:"HyperliquidSignTransaction", version:"1", chainId, verifyingContract:"0x0000000000000000000000000000000000000000"}`
        (`chainId` as an **integer**);
      - types `HyperliquidTransaction:ApproveAgent: [hyperliquidChain:string, agentAddress:address, agentName:string, nonce:uint64]`;
      - message `{hyperliquidChain:"Testnet", agentAddress, agentName, nonce}`, where `"Testnet"` is a literal in
        the client code, never a server value;
   4. calls `eth_signTypedData_v4(account, typedData)`. The dialog tells the player to check that the wallet prompt
      shows `hyperliquidChain: Testnet`.
3. `testnet_agent_approve {account_address, signature, nonce}`. The server:
   1. splits the 65-byte signature into r, s, v;
   2. rebuilds the same typed data with `hyperliquidChain:'Testnet'` and **recovers the EIP-712 signer**
      (`recoverUserSigned`). It must equal `normAddr(account_address)`, otherwise `422 signer_mismatch`;
   3. POSTs `{action:{type:'approveAgent', signatureChainId:'0x' + chainId.toString(16), hyperliquidChain:'Testnet',
      agentAddress, agentName, nonce}, nonce, signature, expiresAfter:null}` to `TESTNET_EXCHANGE_URL`.
      `signatureChainId` is the hex **string** of the same chain id the domain used as an integer (the SDK parses it
      with `int(…, 16)`). `expiresAfter` is always `null`: user-signed actions do not support it. `approveAgent` is in
      `ALLOWED_ACTIONS` only for this relay;
   4. runs `verify.js` steps 3–8.
4. The fixed name prefix `bean-garden` means re-approving replaces the previous garden agent (named-agent
   semantics). It stays within the limit of 1 unnamed + 3 named agents per account.
5. Test: `KAT-U1` (§6.12) proves the `HyperliquidSignTransaction` domain code against the official SDK vector before
   this flow ships.

### 6.11 Testnet bot lifecycle and reconcile

**Sizing** (refined decision R1, §6.14). The mirror is matched in **dollars**, not raw coin units, because testnet
prices differ by up to ~2× (HYPE, above):

```
scale     = capital_usd / 1000
k         = mainnetMid / testnetMid             // frozen per bean position episode (below)
target_sz = sign(bean.side) × floorSz(|bean.units| × scale × k, testnetSzDecimals)
```

- `k` is frozen in `bot.size_ratio = {k, mainnet_px, testnet_px, at_ms, episode}`.
- `episode = bean.side + '|' + bean.entry_px + '|' + |bean.units|`. When the episode changes (a new entry, a flip,
  or an add), `k` is recomputed from current mids. Otherwise the target is constant while the bean holds, so there
  is no churn as prices move.
- When the bean is flat, the target is 0.
- If either mid is missing, the bot is not synced this bar (`no_price`).
- The bot stores `target_szi` and a derived **`fill_state`** after every sync, so the player can tell a thin book
  from a flat bean (§8.5, §9.4):
  - `waiting_bean`: the target is 0 and the exchange position is flat;
  - `in_sync`: `|target − szi|` is below one lot, or the difference is below the $10 minimum;
  - `partial`: the exchange holds part of the target (`szi ≠ 0`, same side, gap ≥ one lot);
  - `unfilled`: the target is non-zero and the exchange is flat (for example repeated `ioc_no_match`).

**Leverage:** `L = min(bean.leverage, testnet maxLeverage)`, isolated (`isCross:false`). `clearinghouseState` shows
leverage only for an open position, and new positions default to **cross** margin, while the player may also change
leverage or margin mode on the testnet site. So **`updateLeverage({asset, isCross:false, leverage:L})` is sent
before every open from flat** (weight 1, idempotent). Leverage is never changed while a position is open.

**Create** (`bot_create {venue:'testnet', confirm:'testnet'}`), with synchronous checks (§7.3):
1. Insert the bot row (`active`, `exchange_sync = {op:'leverage', state:'pending'}`). Emit `bot_created`.
2. On the player's lane:
   1. `updateLeverage`;
   2. then, if the bean is positioned, the opening IOC (sync below).
3. The HTTP handler **awaits** the lane job for up to 8 s. It returns the BotRow with the outcome (fill, error or
   still pending). Later progress arrives as `bot_sync` / `bot_fill` events (J3).

**Sync** (per bar after `tick_completed`, and on create/resume). This runs on the lane, inside the garden's epoch
(§7.2). All of a player's bots are handled in one job:
1. **Reconcile:** `clearinghouseState(account)` → for each open testnet bot's coin, `exch = {szi, entryPx,
   unrealizedPnl, liquidationPx, marginUsed, leverage{type,value}, positionValue, cumFunding.sinceOpen}`, plus
   account `{accountValue, withdrawable, totalMarginUsed, totalNtlPos}`. For unified accounts,
   `spotClearinghouseState(account)` supplies the balance (§6.7 step 7).
2. **Resolve unresolved orders first.** For every order of this player in `pending | sent | unknown` on these coins,
   call `orderStatus(account, cloid)` and store `oid` and `filled_sz = origSz − sz` (§6.6). An order still answering
   `unknownOid` ≥ 60 s after it was sent becomes `canceled` (it never reached the book).
3. **Fills sweep when needed** (provisional fills exist, or step 2 resolved an order with `filled_sz > 0`):
   `userFillsByTime(account, since = oldest unresolved order time − 5 s)`, paginated (below). Fills are attributed
   **by `oid`** (exchange fills carry no cloid). Price, fee and closed P&L come **only** from fills, never from
   `limitPx`. A fill whose `oid` is not ours while this coin still has unresolved orders is **pending attribution**,
   not unexplained.
4. **Drift check** per bot, only once **no unresolved orders remain on that coin**. `expected = bot.real.szi` (after
   every fill we applied). The bot is in sync if `|exch.szi − expected| < 0.5 × 10^−szDecimals`. Otherwise look at
   the unexplained fills in the window:
   - a fill carrying a **`liquidation` object** (and `liquidation.liquidatedUser` equal to the account when that
     field is present) → the bot **pauses** with note code `liquidated_testnet` (J4 visuals as for a paper
     liquidation; realized P&L from the exchange fills). `dir` text containing "Liquidat" is only a fallback;
   - else, if `exch.szi === 0` → pause, note code `external_close`;
   - else → pause, note code `position_drift` with `{exch, exp}`.
   A drift pause **never sends an order**: it cannot tell whose position it is. The player chooses **Resume**
   (adopt: `expected := exch.szi`, then mirror from there) or **Close** (flatten the whole exchange position on that
   coin, after a confirm showing its size).
5. **Mirror** (active, in-sync bots only):
   - `delta = target − exch.szi`, rounded to lots.
   - If `delta === 0`: done.
   - If `|delta| × testnetMid < 10` and `target ≠ 0`: skip with `below_min_order`.
   - Reducing or closing (`|target| < |szi|`, same side, or target 0): **one reduce-only IOC** for `|delta|`.
   - Increasing on the same side: one IOC with `reduceOnly:false`. It must pass the notional cap (§7.3), as in the
     paper rule.
   - **Open from flat** (including the second leg of a flip): `updateLeverage` first, then the IOC.
   - **Flip:** first a reduce-only IOC closing `|szi|`, and only after that fills, `updateLeverage` and an opening
     IOC for `|target|`. If the opening leg is blocked (cap, margin), the closing leg still stands, so the bot never
     keeps a side the bean has left.
   - **A reduce-only close below $10:** send it anyway. If the exchange answers `min_notional`, record
     `dust: {szi}` on the bot, show it, and do not retry until the target changes. Runbook R7 records the actual
     testnet behaviour.
6. **Order outcome** (statuses may be objects or bare strings, §6.2):
   - `filled {totalSz, avgPx, oid}`: insert **one provisional fill**. Its fee is estimated at 4.5 bp × notional;
     its `closed_pnl` is computed against our entry. `fills.provisional = 1`, `bot.fees_estimated = true`. Update
     `bot.real.szi` and the weighted entry (the same accounting as paper `#execute`). Emit `bot_fill` with
     `provisional: true`.
   - **Partial** (`totalSz < sz`): the same with the filled part. The order status is `partial`; `fill_state`
     becomes `partial`. The rest is re-evaluated next bar (flatten: retried at once per §6.9).
   - `error` or an unexpected string: classify (§6.9).

**Fills sweep** (cadence in §6.8, step 3 above, and always at pause, close and halt completion):
1. `userFillsByTime(account, since)`. **Pagination:** while a page returns ≥ 500 rows, request again with
   `startTime = last fill time` and de-duplicate by `tid`. The weight is charged per page.
2. For each fill with an `oid` in our `orders` table, **replace** that order's provisional fill with the exchange
   fills (`tid`, `hash`, `fee`, `closedPnl`, `px`, `sz`, raw `dir`, `startPosition`, `liquidation`). Our open/close
   logic derives from `side`, `startPosition` and `sz`, never from `dir`.
3. If `since` lies beyond the exchange's 10,000-most-recent-fills horizon, the provisional fills stay, the bot keeps
   `fees_estimated = true`, and it gets note code `fills_beyond_horizon` (shown, never hidden).
4. Recompute `bot.realized_pnl = Σ(closed_pnl − fee)` from the DB rows.
5. Emit `bot_fill_confirmed`.
6. A fill with an unknown `oid` on a coin with an open bot feeds the drift logic (after step 2 above). On other coins
   it is ignored.

**Funding** (testnet funding is charged, unlike paper). Each reconcile stores `exchange.funding_since_open` from
`cumFunding.sinceOpen`. When the position goes flat or flips, the last value is added to `bot.funding_realized`;
at close completion, one `userFunding(account, open_ms)` call (weight 20) makes the total exact. A bot's
**Total P&L = realized (Σ closed_pnl − fee) + funding_realized + funding_since_open + unrealized**. Funding is shown
as its own labelled line (§9.6). The sign convention is pinned by the double test "Σ bot totals ≈ Δ accountValue"
(§11.2) and by runbook R6.

**Pause** = stop mirroring, then flatten:
- `exchange_sync = {op:'flatten'}`, then a reduce-only IOC for `|exch.szi|` at P0 priority, with the widening
  slippage of §6.5 on retries.
- The state becomes `paused` at once; `real.szi` shows what remains until it is flat.
- `bot_paused` is emitted when the flatten completes. If flatten is impossible (testnet down, revoked), the bot
  stays `paused` with `exchange_sync.state='failed'` and keeps retrying every 15 s (except `agent_unknown` and
  `signature_mismatch`).

**Close** = pause plus retire:
- `closing: true` until flat. **`bot_close` is idempotent while closing**: it returns the BotRow and sends no new
  order.
- When flat, the **completion fills sweep** runs (and the funding read above). Only then: `state='closed'`,
  `closed_ms`, the coin and bean unbind, and `bot_closed {realized_pnl, funding, confirmed:true}` is emitted.
- If the completion sweep fails, `bot_closed` is emitted with `confirmed:false` (provisional numbers, `≈`), and a
  later `bot_fill_confirmed` corrects them. The UI then plays a **neutral** effect when |realized| ≤ 2 × the
  estimated fee, and re-sorts crates and compost on confirmation without replaying effects (§9.6 J4).

**Halt** (player): paper bots close synchronously; testnet bots close as above. The response lists both:
`closed` (already flat) and `closing` (pending).

**Kill switch** (admin): every open testnet bot of every player pauses with note code `kill_switch`, and its flatten
is queued at P0. Testnet creates and resumes are refused with `503 kill_switch`. Turning the switch off resumes
nothing: each player resumes their own bots.

**API-wallet expiry** (`valid_until_ms` known):
- at `valid_until − 7 d` and `− 1 d`: `live_error` code `agent_expiring` with the date, once each
  (`credentials.expiry_flags`), and a badge on the connect panel;
- at `valid_until − 30 min`, while the agent can still sign: flatten and pause every testnet bot with note code
  `agent_expiring`;
- testnet `bot_create` and `bot_resume` are refused while `valid_until < now + 24 h` (`agent_expiring`);
- the fix is **Replace API wallet** (§6.7 step 8), which keeps the bots.

**Inactivity** and **mainnet re-check hits** flatten and pause as described in §4.6 step 9 and §6.7.

**During engine catch-up** (`engine.catchingUp`, replaying missed bars): testnet bots **do not trade replayed bars**,
because they cannot trade the past. One sync runs after the catch-up ends.

**Stale prices:**
- A stale mainnet coin freezes the bean, so its target does not change.
- A testnet mid older than 60 s freezes **mirroring** for that coin. Flatten still runs, using a fresh mid it
  fetches itself, or waits.

**Restart:**
1. At boot, every order with status `pending`, `sent` or `unknown` is resolved by `orderStatus(account, cloid)` (P4).
   The write-ahead row commits **before** the POST (§3.5), so a `pending` row may have executed.
2. A `pending` or `sent` order becomes `canceled` **only after `orderStatus` answers `unknownOid`**. Any other status
   is applied normally, with prices and fees from the fills sweep.
3. Then every player with open testnet bots is reconciled **before** the first mirror.
4. Every testnet bot with an unfinished flatten intent (`closing`, or `exchange_sync.op === 'flatten'`) that still
   holds an exchange position gets a fresh flatten at P0.
   - Intents live in bot state, never in queued jobs.
   - Drift-paused bots (`position_drift`, `external_close`) are never flattened automatically.
5. Positions stay open on the exchange while the server is down. They are test funds; this is stated in the
   runbook and the in-app FAQ (§9.2).

**Testnet outage handling:**
- **Delayed:** no successful testnet info request for > 15 s.
- **Down:** none for > 60 s, or `signature_mismatch` (§6.9).
- **While delayed or down:**
  - mirror jobs are dropped (re-planned next bar);
  - flatten jobs retry every 15 s (not while signing is halted);
  - creates and resumes answer `503 testnet_down`;
  - the testnet badge shows (§9.4).

**Liquidation on testnet** is the exchange's own, detected at reconcile (step 4). We never simulate testnet
liquidation, and `real.liquidation_px` is the exchange's `liquidationPx`.

### 6.12 KAT test plan (`test/hl-signing.test.js`; offline; P0 release gate)

The **official** vectors from `hyperliquid-python-sdk/tests/signing_test.py` (master, fetched 2026-10-11). Key:
`0x0123456789012345678901234567890123456789012345678901234567890123`; its address
`0x14791697260e4c9a71f18484c9f997b308e59325` is derived and is test KAT-A. Compare `r` and `s` **numerically**
(BigInt), because the SDK's `to_hex(int)` strips leading zeros. The vectors below all happen to have 64 digits,
but other vectors in the same file do not: the mainnet dummy r `0x53749d5b…` has 63 digits, and the mainnet vault
r `0x3c548db7…` has 62. `v` must match exactly.

| ID | Action, vault, nonce | Official expected (testnet, source "b", except KAT-1) |
|---|---|---|
| KAT-1 | phantom agent: order ETH(a=4) buy sz 0.0147 px 1670.1 IOC, nonce 1677777606040. **Asserts the connectionId (action hash) only.** It is source-independent; the SDK test builds this phantom agent with `is_mainnet=True`, so the test must not assert a source. | connectionId `0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908` |
| KAT-2 | `{"type":"dummy","num":100000000000}`, no vault, nonce 0 | testnet r `0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510` s `0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613` v **28** |
| KAT-3 | same dummy, vault `0x1719884eb866cb12b2287399b15f7db5e7d775ea`, nonce 0 (tests the hash layout only; our code never sends a vault) | testnet r `0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b` s `0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60` v **27** |
| KAT-4 | order a=1 buy sz "100" px "100" GTC, nonce 0 | testnet r `0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54` s `0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5` v **27** |
| KAT-5 | KAT-4 + cloid `0x00000000000000000000000000000001` | testnet r `0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d` s `0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988` v **28** |
| KAT-6 | trigger order a=1 buy sz 100 px 100 `{"trigger":{"isMarket":true,"triggerPx":"103","tpsl":"sl"}}`, nonce 0 | testnet r `0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4` s `0x206257b104788f80450f8e786c329daa589aa0b32ba96948201ae556d5637eac` v **28** |
| KAT-7 | `{"type":"scheduleCancel"}`, nonce 0 | testnet r `0xc75bb195c3f6a4e06b7d395acc20bbb224f6d23ccff7c6a26d327304e6efaeed` s `0x342f8ede109a29f2c0723bd5efb9e9100e3bbb493f8fb5164ee3d385908233df` v **28** |
| KAT-8 | `{"type":"scheduleCancel","time":123456789}`, nonce 0 | testnet r `0x4e4f2dbd4107c69783e251b7e1057d9f2b9d11cee213441ccfa2be63516dc5bc` s `0x706c656b23428c8ba356d68db207e11139ede1670481a9e01ae2dfcdb0e1a678` v **27** |

KAT-3, KAT-6 (trigger), KAT-7 and KAT-8 exercise code paths that P0 never sends. They exist so the hash layout and
encoder match the SDK byte-for-byte. Our test-only helper `actionHashWithVault()` lives in the **test file**, not in
`server/`, so the shipped code keeps "no vault" by construction.

Derived vectors, cross-checked because KAT-4 passes with them:

| ID | Value |
|---|---|
| KAT-D1 | domainSeparator `0xd79297fcdf2ffcd4ae223d01edaa2ba214ff8f401d7c9300d995d17c82aa4040` |
| KAT-D2 | Agent typehash `0x26f05c2f7239b6983075e58321292d77b3aa173d19b27257ac96ab362570f508` |
| KAT-M1 | `packAction(KAT-4 action)` = `0x83a474797065a56f72646572a66f72646572739186a16101a162c3a170a3313030a173a3313030a172c2a17481a56c696d697481a3746966a3477463a867726f7570696e67a26e61` |
| KAT-M2 | connectionId(KAT-4, nonce 0) = `0x884f2c32bb6dbdd65f6033e32fb28c0cb6f5b345db0f6471fd3366d85c9252c1` |
| KAT-M3 | `packAction({type:'updateLeverage',asset:0,isCross:false,leverage:5})` = `0x84a474797065ae7570646174654c65766572616765a5617373657400a7697343726f7373c2a86c6576657261676505` |
| KAT-R | `recoverL1(action, nonce, sig)` returns KAT-A for KAT-2…8 |

User-signed (EIP-712 `HyperliquidSignTransaction`) vector, required before the P1 wallet flow (§6.10) ships. It lives
in `test/hl-signing.test.js` and exercises the same domain code as `approveAgent`:

| ID | Input | Official expected |
|---|---|---|
| KAT-U1 | SDK `test_sign_usd_transfer_action`: key as above; `HyperliquidTransaction:UsdSend(string hyperliquidChain,string destination,string amount,uint64 time)`; `{hyperliquidChain:"Testnet", destination:"0x5e9ee1089755c3435139848e47e6635505d5a13a", amount:"1", time:1687816341423}`; `signatureChainId "0x66eee"` (domain chainId 421614) | r `0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073` s `0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7` v **27** |

The test helper builds the `UsdSend` typed data in the **test file**. `server/` never contains `usdSend` code (§1.2
allowlist); only the generic `recoverUserSigned` digest code is shared.

The mainnet vectors in the same SDK file (r `0x53749d5b…`, `0xd6536982…`, …) are **not reproducible on purpose**:
our signer has no `"a"` source. Test T-GUARD asserts that `makeSigner(k).signL1.length === 2` and that no export
accepts a network flag.

### 6.13 Sources (read-only, 2026-10-11)

- `hyperliquid-python-sdk` (master): `tests/signing_test.py` (vectors above, including
  `test_phantom_agent_creation_matches_production` with `is_mainnet=True` and `test_sign_usd_transfer_action`),
  `hyperliquid/utils/signing.py` (`action_hash`, `l1_payload`, `float_to_wire` with 8 decimals,
  `order_type_to_wire`, `user_signed_payload`: `chain_id = int(action["signatureChainId"], 16)`),
  `hyperliquid/exchange.py` (order/cancel/updateLeverage/approveAgent payloads; `approve_agent` posts the
  checksummed `account.address`; `DEFAULT_SLIPPAGE = 0.05`; "expires_after is not supported on user_signed
  actions"), `hyperliquid/api.py` (4xx → `ClientError`, falling back to the raw text; ≥ 500 → `ServerError`),
  `hyperliquid/info.py` (`userRole`, `extraAgents`, `userAbstraction`, `orderStatus` by cloid),
  `hyperliquid/utils/types.py` (`Cloid`: `0x` + 32 hex).
- `hyperliquid-rust-sdk` (master) `src/exchange/exchange_responses.rs`: `ExchangeDataStatus { Success,
  WaitingForFill, WaitingForTrigger, Error(String), Resting, Filled }` (bare-string statuses, §6.2).
- GitBook pages:
  - `for-developers/api/exchange-endpoint` (payloads; response shapes; "1 unnamed and up to 3 named" agents;
    `valid_until`);
  - `…/rate-limits-and-user-limits` (weights and limits in §6.8);
  - `…/tick-and-lot-size` (§6.5);
  - `…/nonces-and-api-wallets` (100 highest nonces, `(T−2d, T+1d)`, per-signer tracking, pruning of unnamed
    agents on a new unnamed approval and of agents of unfunded accounts, "do not reuse agent addresses");
  - `…/signing` (a wrong signature yields "User or API Wallet 0x… does not exist" or "Must deposit before performing
    actions" with a foreign address; local recovery does not prove the payload; lower-case addresses);
  - `…/info-endpoint` (pagination: 500 elements per time-range page; `userFillsByTime`: 2,000 per response, 10,000
    most recent; `orderStatus` statuses and `unknownOid`; `userRole` roles `missing|user|agent|vault|subAccount`;
    `userAbstraction` values), `…/info-endpoint/perpetuals` (`clearinghouseState` with `cumFunding` and leverage only
    under open positions; "under unified account or portfolio margin, use spot balances"; `activeAssetData`),
    `…/info-endpoint/spot` (`spotClearinghouseState` balances `total`/`hold`);
  - `…/websocket/subscriptions` (`WsFill`: `dir` "used for frontend display", optional `liquidation`
    `{liquidatedUser?, markPx, method}`, no cloid);
  - `trading/account-abstraction-modes` (unified account recommended for most users; API balances in the spot
    clearinghouse state), `trading/margining` (cross margin is the default);
  - `onboarding/testnet-faucet` (the faucet needs a mainnet deposit from the same address; 1,000 mock USDC;
    `/drip`; Privy email logins have different mainnet and testnet addresses).
- Node.js `node:sqlite` docs: unflagged in v22.13.0; `sqlite.backup()` added in v23.8.0 and v22.16.0, returns a
  Promise, copies `rate` pages per step.
- Live testnet and mainnet `metaAndAssetCtxs`, `allMids`, `userRole`, `extraAgents`, `userAbstraction` and
  `exchangeStatus` (read-only info calls) for §6.3.

### 6.14 Refined decisions (deviations from the brief, with reasons)

| # | Brief | Refinement | Why |
|---|---|---|---|
| R1 | Testnet size = bean_units × capital/1000 | ... × `k`, where `k = mainnetMid/testnetMid` is frozen per bean position episode | Testnet prices differ by up to ~2× (HYPE 41.2 vs 84.8). Raw units would make testnet exposure, and the $10 minimum, differ from paper by that ratio. The frozen `k` avoids churn. |
| R2 | 14 of 16 coins are on testnet | 13 are **tradeable**: ZEC is `isDelisted` | Re-verified live |
| R3 | Testnet available to connected players | It also requires the **real** feed | Mirroring synthetic beans with real orders would be meaningless |
| R4 | First user is admin | Admin only through the operator-held bootstrap code (file, never stdout) or by promoting an **existing** user via `ADMIN_USERNAMES` at boot; deleted names are retired | Otherwise anyone who signs up first, or first re-registers a freed admin name, on a public URL becomes admin |
| R5 | "Use cloid for idempotency" | Never re-sign an order whose outcome is unknown; resend identical bytes; a nonce error after a transport failure means "probably executed"; resolve by `orderStatus(cloid)`, then position-based reconcile. cloids are random, not derived. | Re-signing an unknown-outcome order can double it; Hyperliquid does not promise to reject a duplicate cloid |
| R6 | Halt lasts until restart | Persisted per player, with an explicit `garden_rearm` (accounts mode) | A restart is the operator's action, not the player's |
| R7 | `data/bean.db` | `bean.db` (real) and `bean-sim.db` (sim) | Keeps the per-feed separation rule (GAME-DESIGN §10.1) |
| R8 | Info weight budget | One 800/min ledger for testnet info + exchange; the two hosts are **assumed** to be independent per-IP limiters | Stated as an assumption with a knob (K11), not as arithmetic: with shared limits, 364 + 120 + 800 > 1200 |
| R9 | – | One live testnet account and one live agent per garden (partial UNIQUE) | Fill attribution and nonce safety; revoked rows never block |
| R10 | Node ≥ 22 | Node ≥ **22.16** (unflagged `node:sqlite` from 22.13; `sqlite.backup()` from 22.16); Docker uses Node 24 LTS | Online backups must not block the event loop |
| R11 | ~ many testnet players | `TESTNET_MAX_ACTIVE_USERS = 40` by default (was 60) | Leverage before every open, unified balances and the order-book cache raise the per-player weight (§6.8) |
| R12 | Reject unsupported account modes | **Unified accounts are supported in P0** (balances from `spotClearinghouseState`); only portfolio margin and the discontinued DEX abstraction are refused | Hyperliquid recommends unified accounts for most users |
| R13 | IOC at mid ± 1% | Opens stay at 1%; reduce-only flatten retries widen 1% → 2.5% → 5% | Thin testnet books; the SDK's market close uses 5% |
| R14 | – | An operator password reset wipes the player's testnet credential first | Keeps "admins can never sign for a player" true even through a reset |
| R15 | – | A mainnet re-check hit flattens on testnet (≤ 60 s), then wipes the key | Avoids stranded positions; the testnet-only signer cannot act on mainnet |

---

## 7. Multi-tenant live layer

### 7.1 Refactor shape (owned by WP3)

`LiveLayer` (`server/live.js`) **stays the garden**: one instance per player. Its constructor gains optional
options. None mode passes none of them, so behaviour is unchanged:

```js
new LiveLayer({
  config, engine, journal, now, log,            // as today
  owner = null,          // { uid, username } — accounts mode
  repo = null,           // GardenRepo (server/garden/repo.js): write-through persistence; null → JSON serialize() as today
  testnet = null,        // TestnetVenue for this player (server/garden/testnet-venue.js); null → venue 'testnet' refused
  logKeep = LOG_KEEP,    // in-memory fill/order ring size (accounts mode: 200; the DB holds the rest)
  testnetCaps = null,    // §7.3
})
```

Changes inside `LiveLayer`, all gated so that a paper-only garden behaves exactly as today:

1. **Bots carry `venue`** (default `'paper'`). `#newBot` stores `venue`, `asset`, `size_ratio:null`,
   `exchange:null`, `exchange_sync:null`, `closing:false`, `fees_estimated:false`, `target_szi:null`,
   `fill_state:null`, `funding_realized:0`, `note_code:null`. `sanitizeBot` accepts them, and a missing `venue`
   means `'paper'`.
2. **Paper code paths are untouched.** `#mirror`, `#execute`, `#fill`, `#liquidate` and `#mark` run only for
   `venue === 'paper'`.
3. **Testnet bots:**
   - `afterTick` calls `this.testnet.planTarget(bot, row)` and then `this.testnet.requestSync()` once per tick, but
     not while `engine.catchingUp`.
   - `markLive` marks them at `testnet.quote(coin)`; there is no local liquidation.
   - `pause`/`close`/`halt` call `this.testnet.requestFlatten(bot, reason)`.
4. **New callbacks** for the venue (they mutate the bot, persist through `repo`, and emit events):
   `applyExchangeFill(botId, fill)`, `confirmFills(botId, rows)`, `applyExchangeSnapshot(botId, exch, account)`,
   `setSync(botId, sync)`, `exchangeError(botId, code, message)`, `flattenDone(botId)`,
   `pauseFromExchange(botId, noteCode, vars)`, `closeConfirmed(botId, {confirmed})`. Every pause and error carries
   a machine `note_code` / `code` (§8.7) next to any English text, so the client can localize it.
5. **Aggregates split by venue.** `#account()` sums **paper** bots only; `#testnetAccount()` sums testnet bots plus
   the latest exchange account snapshot. With paper-only gardens the numbers are identical to today.
6. **`status()`** adds `venues` and `user` only when `owner` is set (§8.4). **`toRow()`** adds the testnet fields
   only when `owner` is set (§8.5).
7. **`journal`** is the per-player facade returned by `journal.forUser(uid)`: a frozen object
   `{uid, scoped: true, emit: (kind, data) => journal.emit(kind, data, {uid})}`, built by `Gardens`. **Fail-closed
   wiring:** a `LiveLayer` constructed with `owner` set **throws** unless `journal.scoped === true` and
   `journal.uid === owner.uid`. The `TestnetVenue` of a player receives the same facade, never the global journal.
   (The global journal itself refuses unscoped user kinds in accounts mode, §8.7, as a second line of defence.)

### 7.2 `Gardens` (`server/garden/gardens.js`)

```js
export class Gardens {
  constructor({ engine, journal, db, repoFactory, testnet /* createTestnet() or null */, credentials, caps, now, log })
  async init()                          // load every garden with open bots (SELECT DISTINCT user_id FROM bots WHERE state<>'closed')
  get(uid) → LiveLayer                  // load on demand (DB) and touch; creates the gardens row if missing
  peek(uid) → LiveLayer | null          // no load
  afterTick(summary)                    // engine onTick hook (§7.6)
  markLive(marks)                       // engine onMarks hook: mainnet marks + testnet quotes
  marksFor(uid) → { bots, account, testnet_account } | null    // per-subscriber part of a `mids` frame (memoized per frame)
  venueFor(uid) → (row) => venue verdict                        // for Population.query/row/detail (§7.4)
  killSwitch({ on, reason, by }) → { on, flattening: [{uid, bot}] }
  setCaps(patch, by)                    // admin_state 'caps'; applies to NEW bots
  deleteUser(uid, { force }) → result   // §4.6 step 6 (calls teardown before the DELETE commits)
  teardown(uid)                         // cancel lane + queued jobs + retry timers (scheduler.cancelLane), close the uid's
                                        // streams (http.closeStreamsFor), drop uid-keyed caches (marks memo, buckets), unload
  resetSeason(uid) → result             // garden_reset (§8.4)
  inactivitySweep()                     // daily: §4.6 step 9
  expirySweep()                         // every 5 min: API-wallet expiry steps (§6.11)
  evictIdle()                           // every 5 min: no open bots and idle > 30 min → unload
  flush()                               // one transaction for all dirty gardens/bots + buffered fills/orders/events,
                                        // one SAVEPOINT per garden (§3.5)
  stats()                               // for admin_status
}
```

**Garden epoch.** `gardens.epoch` is 16 random hex characters set when the garden row is created. Every lane job and
every retry timer captures `(uid, epoch)` when it is queued and checks both before it touches a credential or a
bot. A mismatch aborts the job silently (logged at debug). With `AUTOINCREMENT` uids (§3.3) a uid is never reused,
and the epoch is a second guard, for example against a job already running when `teardown(uid)` cancels its lane.
The epoch never changes for the life of a garden (`garden_reset` keeps it, because testnet jobs must continue).

In none mode `Gardens` is **not used**. `wire()` keeps binding the single `LiveLayer` exactly as today.

### 7.3 Caps (per player; admin-adjustable; persisted in `admin_state.caps`, with per-user overrides in `gardens.caps_json`)

| Cap | Paper (unchanged defaults) | Testnet (new defaults) |
|---|---|---|
| start account | `account_usd` 10,000 | the exchange account value (not a cap) |
| open bots | `max_bots` 10 (across both venues; one plot per bot) | `max_bots` **3** (a subset of the 10) |
| stake per bot | `min_capital_usd` 20 … `max_bot_capital_usd` 1,000 | 20 … **500**, and ≤ 0.9 × free collateral at create (`withdrawable` for standard accounts; `total − hold` for unified, §6.7) |
| open notional | `max_total_notional_usd` 10,000 (Σ paper bots) | **3,000** (Σ testnet bots at testnet mids) |
| leverage | min(bean, mainnet venue max) | min(bean, **testnet** max); `requiredLeverage(row)` ≤ testnet max |
| min order | $10 | $10 (exchange rule) |
| one open bot per coin, one per bean | yes, across venues | yes, across venues |

**Testnet create checks, in order. The first failure wins.** Checks 1–11 do not depend on the stake; the plant dialog
uses only these to enable or disable the Testnet option (§9.4). Checks 12–15 depend on the stake and appear as the
dialog's normal red block line. Testnet `bot_resume` re-runs checks 1–8.
1. `testnet_disabled`
2. `kill_switch`
3. `halted`
4. `not_connected` / `credential_revoked`
5. `testnet_down` (also while signing is halted)
6. `agent_expiring` (`valid_until < now + 24 h`)
7. `testnet_capacity`
8. `unlisted_testnet` / `delisted_testnet`
9. `busted`, `bean_bound`, `coin_bound`, `leverage`
10. `no_testnet_price`, `stale`
11. `insufficient_testnet_balance` when free collateral < `min_capital_usd` (with the faucet link)
12. `testnet_caps` (bots / stake / notional)
13. `insufficient_testnet_balance` for this stake (> 0.9 × free collateral)
14. `thin_book`: the cached book holds less than the target notional within 1% of the mid on the opening side
15. `divergence_ack`: |divergence| > 20% and the request lacks `ack_divergence: true` (§9.4)

The paper venue keeps its existing checks and messages.

### 7.4 Per-player venue verdicts for the public bean list

`Population.row(id, venue?)`, `query(params, {venue}?)` and `detail(id, {venue}?)` accept an optional verdict
function. When it is absent, the installed hook is used (unchanged).

- `beans`/`bean_detail` from a signed-in player pass `gardens.venueFor(uid)`, so `tradeable`, `venue_reason` and
  `bot` are that player's **paper** verdict. The `tradeable` semantics are unchanged: paper.
- Spectators get the engine's default verdict (`unlisted | busted | leverage` only).
- Testnet eligibility is never mixed into `beans`. The plant dialog asks `testnet_quote` (§8.3).

### 7.5 Marks for both venues

- **Mainnet:** `engine.onMarks(marks)` (every ~5 s) → `gardens.markLive(marks)` → paper bots as today
  (liquidation on the live mid, then mark).
- **Testnet:** `TestnetMarket` polls testnet `allMids` every 5 s. `gardens.markLive` also hands the latest
  `testnet.snapshot()` to each garden. Testnet bots get:
  - `mark_px = testnet mid` and `mark_ms` = its receive time;
  - `real.unrealized_pnl ≈ szi × (mark − entry)`, flagged as an **estimate** (`est: true` in the row; the UI shows
    `≈`, §9.6);
  - the exchange's own `unrealizedPnl` from the last reconcile in `exchange.unrealized_pnl` with
    `exchange.as_of_ms`.
- **Testnet funding and marks:** `TestnetMarket` polls `metaAndAssetCtxs` (same weight 20 as `meta`) every 5 min and
  exposes `funding_1h` and `mark_px` per coin in `testnet_market` and the `mids.testnet` part. Testnet bots and the
  plant dialog use these, never the mainnet `funding_1h`.
- Each `mids` pulse frame is built **per subscriber**:
  `{...globalMarks, testnet: testnetMarket.snapshot(), ...gardens.marksFor(uid)}`.
  - `testnet` is present only when the testnet is enabled.
  - Garden parts are memoized per frame per uid, so several tabs cost one build.
  - **Fail-closed:** in accounts mode the shared frame goes through `Pulse` built with `{scoped: true}`, whose
    `publish('mids', frame)` **throws** if the frame carries a `bots`, `account` or `testnet_account` key. Garden
    parts are attached only by the SSE writer, per subscriber, at write time. `wireAccounts()` never calls
    `live.marksPayload()` into the shared frame (today's `wire()` does, which is right for one player only).

### 7.6 Driving all ledgers efficiently

- `Gardens` keeps `open: Set<LiveLayer>` (gardens with ≥ 1 open bot) and `testnetActive: Set<uid>`.
- **`afterTick(summary)`:**
  1. Run each garden in `open` through `g.afterTick(summary)`. Paper is synchronous, as today. Testnet targets
     are planned.
  2. Call `testnetVenue.requestSync()` for each uid in `testnetActive` (dropped while catching up).
  3. Call `flush()`, one transaction.
  - Cost is O(open bots). Closed bots are skipped by state, and gardens without open bots are never visited.
- **`markLive(marks)`:** visits `open` only.
- **Budgets** (asserted by T-PERF, with 1,000 gardens × 10 open paper bots and 40 testnet players faked):
  - `afterTick` ≤ 40 ms;
  - `markLive` ≤ 20 ms;
  - `flush` ≤ 60 ms;
  - all testnet syncs done ≤ 20 s after bar close at the default load, with the double answering in 50 ms.
- **Busted beans:** each garden pauses its own bots (existing rule), so `busted` stays one global event.
- **Halt per player:** `garden.halt()`. Re-arm is `garden_rearm`, at least 60 s after the halt, with
  `confirm:'REARM'`.
- **Kill switch:** `Gardens.killSwitch` (§6.11).
- **Paper season reset:** `Gardens.resetSeason(uid)` (§8.4): close the paper bots at market (synchronous, as a
  paper halt of paper bots only), increment `gardens.season`, set `account_usd` to the current paper cap, set
  `season_started_ms` and `last_reset_ms`, keep `next_bot_index` (bot ids never repeat). Old paper fills and orders
  keep their old `season` value; paper queries default to the current season and accept `season` to look back.
  Testnet bots, testnet fills and the credential are untouched.

---

## 8. HTTP API changes

### 8.1 General

- `GET /api/v1` adds `auth: 'none'|'accounts'`, `testnet: {enabled}` and `public_origin` (accounts mode only).
  `command_policy` is `'session'` in accounts mode.
- Errors stay `{error, status}`. A machine `code` is added **additively** (§8.9). Existing messages do not change.
- Every op in `catalog.js` gets these fields:
  - `auth: 'public' | 'user' | 'admin'`. All engine queries are `public`.
  - `sensitive: boolean` (§5.3).
  - `modes: ['none','accounts']` or `['accounts']`. In none mode, accounts-only ops answer
    `404 {code:'accounts_disabled'}`.
- **Public queries** (both modes, no session needed): `health`, `status`, `meta`, `market`, `beans`,
  `bean_detail`, `equity_curves`, `events` (spectators get global records only), `testnet_market` (new).
- **User queries** (accounts mode: session required, else `401 auth_required`; none mode: the local player):
  `bots`, `bot_detail`, `live_status`, `live_fills`, `me`, `testnet_status`, `testnet_quote`, `sessions` (P1).
  `me`, `testnet_status`, `testnet_quote` and `testnet_market` read **cached snapshots only** and never spend
  Hyperliquid weight per call (§6.8).
- **Commands in accounts mode** take params **only from the JSON body**. A POST with a non-empty query string is
  refused with `400 query_params_not_allowed` before the body is read (§4.4). None mode keeps today's merge of query
  and body.

### 8.2 Auth and account ops (accounts mode)

| Op | Method | Params | Returns | Errors |
|---|---|---|---|---|
| `auth_signup` | POST | `username*`, `password*`, `bootstrap_code`, `invite` (P1), `lang` | `{user: User}` + Set-Cookie | 400 `bad_username`/`weak_password`; 403 `signup_closed`; 409 `username_unavailable`; 429; 503 `signup_busy` (+ `retry_after_s`) |
| `auth_login` | POST | `username*`, `password*` | `{user: User, notice?: 'password_reset'}` + Set-Cookie (session and known-device) | 401 `bad_credentials`; 403 `account_disabled`; 429 |
| `auth_reset` | POST | `username*`, `code*`, `new_password*` | `{user: User}` + Set-Cookie | 401 `bad_credentials` (any wrong, used or expired code: generic); 400 `weak_password`; 429 |
| `auth_logout` | POST | – | `{ok:true}`, cookie cleared (also 200 without a session) | – |
| `auth_logout_all` | POST | – | `{ok:true, revoked:n}` | 401 |
| `me` | GET | – | `{mode, user: User\|null, session: {created_ms, expires_ms}\|null, signup: 'open'\|'invite'\|'closed', testnet: TestnetLink\|null}` (200 for spectators, `user:null`) | – |
| `account_password` | POST | `current_password*`, `new_password*` | `{ok:true}` + new Set-Cookie | 401 `bad_credentials`; 400 `weak_password`; 429 |
| `account_delete` | POST | `password*`, `confirm*` (`'DELETE'`), `force` | `{deleted:true, closed:[ids], testnet_left_open:[{coin, szi}]}` | 401; 400 `confirm_required`; 409 `testnet_positions_open` (+ `positions`) |
| `sessions` (P1) | GET | – | `{rows:[{id: public_id, created_ms, last_seen_ms, user_agent, ip_prefix, current}]}` | 401 |
| `session_revoke` (P1) | POST | `id*` (a `public_id`) | `{ok:true}` | 404 `not_found` (also for another player's session: `revoke(uid, id)` updates only `WHERE public_id=? AND user_id=? AND revoked_ms IS NULL`) |

`User` = `{id, username, role, created_ms, lang}`.

`TestnetLink` = `{status, account_address, agent_address, agent_name, valid_until_ms, verified_ms, status_reason,
abstraction, value_at_connect, connected_ms}`.

In **none mode**, `me` returns `{mode:'none', user:{id:0, username:'local', role:'admin', created_ms:null,
lang:null}, session:null, signup:'closed', testnet:null}`. This lets the frontend run one code path.

### 8.3 Testnet ops (accounts mode, `TESTNET_ENABLED=1`, real feed)

| Op | Method | Params | Returns |
|---|---|---|---|
| `testnet_market` | GET (public) | – | `{enabled, state:'live'\|'delayed'\|'down'\|'disabled', state_reason, kill_switch:{on, reason, since_ms}, mids_ms, ctx_ms, coins:[{coin, index, sz_decimals, max_leverage, delisted, only_isolated, mid, mid_ms, mark_px, funding_1h, tradeable}]}` for **our 16 coins** (unlisted ones carry `index:null, tradeable:false`). Cache only. |
| `testnet_connect` | POST, sensitive | `account_address*`, `agent_key*` | `{testnet: TestnetLink, replaced: bool, account:{account_value, account_value_est, withdrawable, as_of_ms}, warnings:[{code:'existing_positions', coins} \| {code:'unnamed_agent'} \| {code:'agent_expiring_soon', valid_until_ms} \| {code:'no_funds', account_value}]}`. On a garden already connected to the **same** account it acts as **Replace API wallet** (`replaced:true`, bots kept, §6.7 step 8). Errors (§6.7): 400 `bad_address`/`bad_key_format`; 409 `already_connected` (a different account)/`agent_in_use`/`account_in_use`; 422 `seed_phrase`/`master_key`/`mainnet_key` (+ `sub_reason`)/`not_agent`/`agent_mismatch`/`agent_expired`/`abstraction_unsupported`/`no_testnet_funds`; 503 `mainnet_check_unavailable`/`testnet_down`/`testnet_disabled`; 429 |
| `testnet_verify` | POST | – | the same as connect, re-checking the stored credential (steps 3–7, including the mainnet guard) |
| `testnet_disconnect` | POST | `close_bots` (bool), `force` (bool) | `{disconnected:true, closed:[ids], left_open:[{coin, szi}]}`. 409 `has_open_testnet_bots` unless `close_bots:true` (then the bots flatten first; if the flatten fails, 409 `testnet_positions_open` with `positions`, and a retry with `force:true` disconnects anyway, §9.3). The wipe is followed by a WAL checkpoint (§5.3). |
| `testnet_status` | GET | – | `{link: TestnetLink\|null, state, account:{account_value, account_value_est, balance, free, withdrawable, total_margin_used, total_ntl_pos, as_of_ms}\|null, positions:[{coin, szi, entry_px, unrealized_pnl, liquidation_px, leverage, funding_since_open, bot}], requests:{used, cap, as_of_ms}\|null, expiry:{valid_until_ms, warn:'7d'\|'1d'\|null}, caps}`. Cache only (§6.8). |
| `testnet_quote` | GET | `bean*`, `capital_usd*` | `{ok, reason, venue_ok, venue_reason, coin, asset, sz_decimals, leverage, testnet_mid, testnet_mid_ms, mainnet_mid, divergence, k, target_sz, notional_usd, margin_usd, liq_move_pct, fees_est_usd, slippage_max_usd, flatten_slippage_max_usd, book_ok, depth_usd, book_ms, funding_1h, opens_now, room_usd, free_usd}`. `venue_ok`/`venue_reason` use only the stake-independent checks 1–11 of §7.3; `ok`/`reason` use all of them. `divergence = testnet_mid / mainnet_mid − 1`. `slippage_max_usd = 0.01 × notional`; `flatten_slippage_max_usd = 0.05 × notional`. `book_ok`: the cached book holds ≥ the target notional within 1% of the mid on the opening side. Cache only (the shared book cache, §6.8). |
| `testnet_agent_prepare` (P1) | POST | – | `{agent_address, nonce, agent_name}` only (the client builds the typed data, §6.10) |
| `testnet_agent_approve` (P1) | POST, sensitive | `account_address*`, `signature*`, `nonce*`, `chain_id*` | as `testnet_connect`; also 422 `signer_mismatch` |

### 8.4 Garden ops (changed)

| Op | Change |
|---|---|
| `bot_create` | New `venue: 'paper'\|'testnet'` (default `'paper'`) and `ack_divergence` (bool, testnet). With `testnet`, `confirm` must equal `'testnet'` (`400 confirm_required`). Testnet: awaits the first lane job ≤ 8 s (§6.11). It returns BotRow. The paper path is unchanged. |
| `bot_pause` / `bot_resume` / `bot_close` | Unchanged params. On testnet bots they await the flatten (or mirror) ≤ 8 s and return BotRow with `exchange_sync`. Resume of a `position_drift` bot **adopts** the exchange size (§6.11). `bot_close` on a bot that is already `closing` is idempotent: it returns the BotRow and sends no order. |
| `bots_halt` | Per player. It returns `{halted:true, closed:[ids], closing:[ids], realized_pnl}`; `realized_pnl` is paper only, and the testnet total arrives on `bot_closed` events. |
| `garden_rearm` (new; accounts mode) | `confirm*:'REARM'`. `409 too_soon` until 60 s after the halt. Returns `{halted:false}`. |
| `garden_reset` (new; accounts mode) | `confirm*:'RESET'`. Starts a new **paper season** (§7.6): closes paper bots at market (the confirm lists each bot, J10), archives paper fills and orders under the old season, resets `account_usd` to the current cap. Testnet bots and the testnet link are untouched. `409 too_soon` within 24 h of the last reset (with `retry_after_s`); `409 halted` while the field is burned (re-arm first). Returns `{season, closed:[ids], realized_pnl, account_usd}`. Diary line `garden_reset`. |
| `bots`, `bot_detail`, `live_status`, `live_fills`, `events` | Scoped to the session's player. `bot_detail.fills/orders` come from the DB (newest 200). `live_fills` reads the DB with the same params, for the current season unless `season` is given. |
| `tick` | Accounts mode: admin only (sim feed). Real feed: 409 as today. |

**`live_status` in accounts mode.** The existing keys stay, and they describe the **paper** ledger of this player.
New keys:
```json
{ "user": {"id": 7, "username": "nok"},
  "halted": false, "halted_ms": null, "rearm_after_ms": null,
  "season": 1, "season_started_ms": 1791000000000, "reset_after_ms": null,
  "venues": {
    "paper":   { "account_usd": 10000, "account_value": 10012.3, "available_usd": 9712.3, "deployed_usd": 300,
                 "open_notional_usd": 1420.5, "realized_pnl": 9.1, "unrealized_pnl": 3.2, "bots_open": 3 },
    "testnet": { "enabled": true, "connected": true, "state": "live", "credential_status": "verified",
                 "kill_switch": {"on": false, "reason": null, "since_ms": null},
                 "account_address": "0x12…ab", "abstraction": "unifiedAccount",
                 "account_value": 1003.7, "account_value_est": true, "balance": 1002.6, "free": 912.4,
                 "value_at_connect": 1000.0, "connected_ms": 1790900000000,
                 "total_margin_used": 42.1, "open_notional_usd": 210.4, "as_of_ms": 1791700000000,
                 "realized_pnl": -0.42, "funding": -0.03, "unrealized_pnl_est": 1.1, "bots_open": 1,
                 "caps": {"max_bots": 3, "min_capital_usd": 20, "max_bot_capital_usd": 500, "max_total_notional_usd": 3000} } } }
```
`venues.testnet` is `null` when the testnet is disabled server-wide. The testnet ledger has **no "start"**: its
`account_value` also moves with faucet claims, transfers and manual trades. The only comparison offered is against
`value_at_connect`, labelled with its date (§9.4).

### 8.5 Payload additions (accounts mode only; none mode is byte-identical)

**BotRow adds:**

| Field | Meaning |
|---|---|
| `venue` | `'paper' \| 'testnet'` (absent means paper) |
| `price_source` | `'hyperliquid' \| 'sim' \| 'hyperliquid-testnet'` |
| `asset` | testnet asset index or null |
| `closing` | boolean: close requested, flatten pending |
| `exchange_sync` | `null \| {op:'leverage'\|'mirror'\|'flatten', state:'pending'\|'failed', since_ms, attempts, code, error}` |
| `exchange` | `null \| {as_of_ms, szi, entry_px, unrealized_pnl, margin_used, liquidation_px, position_value, leverage, leverage_type, funding_since_open}` (testnet; the last `clearinghouseState`) |
| `size_ratio` | `null \| {k, mainnet_px, testnet_px, at_ms}` |
| `target_szi` | testnet: the size the bot is trying to hold (§6.11) |
| `fill_state` | testnet: `'in_sync' \| 'partial' \| 'unfilled' \| 'waiting_bean'` |
| `funding_realized` | testnet: funding from closed position episodes (§6.11) |
| `fees_estimated` | boolean (testnet provisional fills exist) |
| `est` | `null \| ['unrealized_pnl']` (testnet: computed at the testnet mid) |
| `dust` | `null \| {szi}` (testnet: a remainder below $10) |
| `note_code` | machine code of the pause note (`liquidated_testnet`, `external_close`, `position_drift`, `credential_revoked`, `kill_switch`, `leverage_rejected`, `insufficient_margin_repeat`, `agent_expiring`, `inactive`, `mainnet_key`, `account_moved`, `fills_beyond_horizon`, `no_deposit`), with `note_vars` (`{exch, exp, coin}`) |

**Fill adds** `venue`, `oid`, `tid`, `hash`, `provisional`, `season`, `liquidation`.

**Order adds** `venue`, `cloid`, `oid`, `reduce_only`, `code`, `error`, `filled_sz`, `avg_px`, `leverage`, and the
statuses `pending | sent | partial | canceled | rejected | error | unknown`.

### 8.6 Admin ops (accounts mode; admin session, or Bearer `ADMIN_TOKEN` under the rules of §4.4)

The Bearer token is accepted only from a direct loopback peer without proxy headers (`server/admin-cli.js` inside
the container) unless `ADMIN_TOKEN_REMOTE=1`, and never for `make_admin` / `remove_admin`.

| Op | Method | Params | Returns |
|---|---|---|---|
| `admin_status` | GET | – | `{version, uptime_s, users, sessions_active, sse_streams:{total, spectators, buffered_bytes}, gardens_loaded, bots:{paper_open, testnet_open}, testnet:{enabled, state, state_reason, signing_halted, kill_switch, weight_60s, budget, active_users, max_active_users, exchange_actions_60s, errors_60s, lanes_busy}, mainnet:{weight_60s, user_role_queue, rechecks_due}, client_ip:{source:'socket'\|'xff'\|'header', buckets_1h}, db:{size_bytes, wal_bytes, last_backup_ms, last_backup_file}, event_loop_p99_ms}` |
| `admin_kill_switch` | POST | `on*` (bool), `reason` | `{kill_switch:{on, reason, since_ms}, flattening:[{user_id, bot}]}` |
| `admin_testnet_signing` | POST | `resume*` (true) | `{signing_halted:false}`. Clears the `signature_mismatch` halt (§6.9) after a fix is deployed. |
| `admin_caps` | POST | `paper` (object), `testnet` (object), `user` (username; per-user override) | `{caps}` |
| `admin_users` | GET | `q` (≤ 24 chars; matched with `LIKE ? ESCAPE '\'`, where `%`, `_` and `\` in the input are escaped), `limit` (50, ≤ 500), `offset` | `{rows:[{id, username, role, status, created_ms, last_login_ms, bots_open, testnet:{status, account:'0x12…ab'}}], total_capped}` |
| `admin_user` | POST, sensitive | `username*`, `action*` (`disable\|enable\|halt\|revoke_sessions\|disconnect_testnet\|reset_password\|make_admin\|remove_admin`), `password` (the calling admin's own password; **required** for `make_admin`/`remove_admin`, which also need a session, not Bearer) | `{user}`; for `reset_password` also `{code, expires_ms}`, shown once (§4.6 step 8). Role changes revoke the target's sessions. |
| `admin_audit` | GET | `user`, `action`, `limit` (100, ≤ 1000), `offset` | `{rows, total_capped}` where `total_capped = min(count, 10001)` from a `LIMIT 10001` sub-query, never an exact `COUNT(*)` over 180 days |
| `admin_backup` | POST | – | `{file, bytes, ms}`; at most once per 10 min (`429` otherwise); runs the online backup (§10.5) |
| `dev_double` (dev only) | POST | `fault*`, `args` | Exists only under `--testnet-double` (§11.1): scripts a fault in the in-process testnet double. `404` otherwise. |

### 8.7 SSE: one stream, scoped

`GET /api/v1/events/stream`. The headers, `retry`, hello, ping and pulse framing are as today.

**Record scoping (fail-closed in accounts mode):**
- `GLOBAL_KINDS = ['warmup_finished', 'tick_completed', 'busted', 'daemon_started', 'feed_status', 'feed_gap',
  'kill_switch', 'testnet_feed']` (exported from `server/journal.js`).
- Accounts mode builds the journal as `new Journal({…, scoped: true, globalKinds: GLOBAL_KINDS})`. None mode builds it
  as today (no `scoped`), and every record stays global.
- `Journal.emit(kind, data, {uid} = {})`:
  - a kind in `GLOBAL_KINDS` with no uid → a global record: ring + jsonl, as today;
  - any kind **with** a uid → a user record: it gets the **same global seq**, is inserted into `events`
    (`user_id = uid`), is **not** put in the ring or jsonl, and is broadcast with an internal `uid` that is stripped
    before sending;
  - in scoped mode, a kind **not** in `GLOBAL_KINDS` **without** a uid **throws** `unscoped_user_event`, is logged as
    an alert, and is never stored or broadcast. A wiring mistake (the raw journal handed to a garden, a new emit site,
    a venue callback using the global journal) therefore fails loudly instead of leaking a player's records to
    everyone.
- **Delivery:** a stream opened with a valid session for `uid` receives global records plus records where
  `record.uid === uid`. A spectator stream receives global records only. The SSE writer **and** the `events` query
  deliver a uid-less record only when its kind is in `GLOBAL_KINDS` (a second check at the edge).
- **Replay on `Last-Event-ID = L`:** merge (global ring where seq > L) with
  (`SELECT … FROM events WHERE user_id=? AND seq>? ORDER BY seq LIMIT 1000`), ordered by seq. If L is older than
  the ring start, or more than 1000 records are missing, send `event: resync` (no `id:`). The client then does a
  full refresh. Opening a stream costs 10 query tokens (§4.5).
- At boot, `journal.seq = max(journal.seq, SELECT max(seq) FROM events)`, so seq never regresses after a crash.
- **Streams know their session.** Each stream records `{uid, session_id}`. `http.closeStreamsFor({uid, sessionId?})`
  is called synchronously by every revocation path (§4.2) and by `gardens.teardown(uid)`.

**Kinds:**

| Scope | Kinds |
|---|---|
| global (unchanged) | `warmup_finished`, `tick_completed`, `busted`, `daemon_started`, `feed_status`, `feed_gap` |
| global (new) | `kill_switch {on, reason, since_ms}`, `testnet_feed {state, prev, reason, error}` (`reason` includes `signing` for a `signature_mismatch` halt) |
| user (existing kinds, now scoped) | `bot_created` (+`venue`), `bot_order` (+`venue`, `cloid`, `code`), `bot_fill` (+`venue`, `provisional`, `oid`), `bot_paused` (+`note_code`, `note_vars`), `bot_resumed`, `bot_closed` (+`venue`, `funding`, `confirmed`), `live_error` (+`code`, `vars`), `live_halted` (+`closing`) |
| user (new) | `bot_sync {bot, op, state:'pending'\|'done'\|'failed', attempts, code?, error?, fill_state?}`, `bot_fill_confirmed {bot, coin, oid, sz, px, fee, closed_pnl, tids}`, `testnet_account {account_value, account_value_est, free, total_margin_used, as_of_ms}` (after each reconcile), `credential_status {status, reason}`, `garden_rearmed {}`, `garden_reset {season, closed, realized_pnl}`, `password_reset {}` (one line in the diary after an operator reset) |
| stream-only (no id) | `mids` (global part plus the subscriber's own garden part, §7.5), `session_ended {reason}`, `resync {}`, `server_restart {}` |

Every pause note and error carries a **machine code** (`note_code`, `code`) next to any English text; the client
localizes the code and shows the text only as a detail (§9.5).

In none mode the stream is exactly as today. All records are global, and no new kinds are emitted.

### 8.8 Backward compatibility (none mode)

The none-mode contract is this:
- `--auth none` serves the same routes, payloads, auth rules, CORS, SSE frames and event kinds as SPEC §4 today.
- The only exception is the `GET /api/v1` key `auth:"none"` (and `testnet:{enabled:false}`).
- Accounts-only ops answer `404 accounts_disabled`.
- `bot_create {venue:'testnet'}` answers `409 testnet_needs_accounts`.
- `venue:'paper'` is accepted and ignored.

### 8.9 Error codes (additive `code`)

| HTTP | Codes |
|---|---|
| 400 | `bad_request` (existing param errors), `bad_username`, `weak_password`, `bad_address`, `bad_key_format`, `confirm_required`, `invalid_json`, `query_params_not_allowed` |
| 401 | `auth_required`, `session_expired`, `bad_credentials` |
| 403 | `csrf`, `forbidden`, `account_disabled`, `signup_closed`, `session_required` |
| 404 | `not_found`, `accounts_disabled` |
| 409 | `conflict` (existing), `halted`, `not_tradeable`, `caps`, `stale`, `username_unavailable`, `already_connected`, `agent_in_use`, `account_in_use`, `has_open_testnet_bots`, `testnet_positions_open`, `testnet_needs_accounts`, `too_soon`; testnet create/resume checks (§7.3): `not_connected`, `credential_revoked`, `agent_expiring`, `unlisted_testnet`, `delisted_testnet`, `busted`, `bean_bound`, `coin_bound`, `leverage`, `no_testnet_price`, `testnet_caps`, `insufficient_testnet_balance`, `thin_book`, `divergence_ack` |
| 413 | `body_too_large` |
| 415 | `unsupported_media_type` |
| 421 | `misdirected` |
| 422 | `seed_phrase`, `master_key`, `mainnet_key` (+ `sub_reason`: `mainnet_user`, `mainnet_agent`, `mainnet_vault`, `mainnet_subAccount`), `not_agent`, `agent_mismatch`, `agent_expired`, `abstraction_unsupported`, `no_testnet_funds`, `signer_mismatch` (P1) |
| 429 | `rate_limited` (+ `retry_after_s`) |
| 502 | `testnet_error` |
| 503 | `testnet_disabled`, `testnet_down`, `kill_switch`, `testnet_capacity`, `busy`, `server_restarting`, `signup_busy`, `mainnet_check_unavailable` |

Exchange codes that reach players through `live_error.code`, `bot_sync.code` and `orders.code` are listed in §6.9
(`EXCHANGE_CODES`). Pause notes use the `note_code` values of §8.5. **Every** code in this section, in §6.9 and in
§8.5 `note_code` has an EN and a TH string (§9.7.2). The i18n parity test enumerates the codes exported by
`server/catalog.js` (`ERROR_CODES`) and `server/hl/errors.js` (`EXCHANGE_CODES`, `NOTE_CODES`) and fails when a key
is missing.

## 9. Frontend changes (owned by WP5; transport by WP4)

### 9.1 Boot and the farm gate

**Boot:**
1. `GET /api/v1` gives `auth`.
2. `GET me` gives `user`.

**Accounts mode, spectator:**
- The island, market, ticker and seed stall work.
- Plots are empty.
- The **farm gate** panel is shown, non-modal and dismissible. `g.gate.visit` collapses it to a "Sign in" chip in
  the top bar.
- Clicking the signpost, any empty plot, or *Plant* while signed out opens the gate.
- Landmarks that show money (barn, pond, tower, silo, crates, compost) show `g.lm.signInToSee` with a **Sign in**
  action instead of "account value —". The mailbox opens the **global** diary with a first line `g.diary.signIn`.
  (QA-02, QA-13.)

**Farm gate** (`ui/gate.js`, DOM dialog styled as a wooden sign):
- Two tabs: **Sign in** / **Create a garden**, plus a small link **"I have a reset code"** (fields: username, code,
  new password; calls `auth_reset`).
- Fields have `autocomplete="username"` and `"current-password"` / `"new-password"`.
- Password show/hide toggle.
- Caps-lock hint.
- Inline `role=alert` errors, localized by code (§9.5).
- The *Create* tab shows `g.gate.noRecovery` ("No email, no password reset: keep your password in a password
  manager") under the password fields.
- On submit, the button shows the pending loop (J3).
- There is no `<form action>`; submission uses `fetch` POST JSON. Enter submits.
- **Layout:** on desktop a wooden sign at the left; at widths < 768 px a **bottom sheet** (max 60% of the height).
  Either way it reports its covered edge through `rig.setSafeArea`, so the camera keeps the field visible beside or
  above it (QA-06, QA-10).
- After sign-in:
  1. the store resets the per-player state;
  2. the SSE is reopened (§9.5);
  3. `tend()` runs;
  4. a first-timer gets Pip's tour, with step 2 `g.tour.private` ("your garden is private; beans are shared");
  5. after an operator password reset (`notice:'password_reset'`), a one-time card `g.acct.resetNotice` says the
     password was reset by the operator and testnet must be reconnected.

**None mode:** no gate and no account menu. Everything else is as today.

### 9.2 Account menu (`ui/account.js`)

- **Desktop:** a HUD button shows a straw-hat icon and the username. **Phone (< 768 px):** the account entry moves
  into the existing **⋯ More** sheet, whose header shows the username (no extra top-row button, QA-10).
- Menu items:
  - *Settings*;
  - *Connect testnet* / *Testnet: connected ✓*;
  - *Change password*;
  - *Start a new paper season* (`g.acct.reset`; confirm lists each paper bot that closes with J10 money lines and
    requires typing `RESET`; disabled with its countdown within 24 h of the last reset);
  - *Help & FAQ* (`ui/help.js`, below);
  - *Sign out*;
  - *Sign out everywhere*;
  - *Delete account*:
    1. step 1: password field, the typed word `DELETE`, the open bots that will close (J10 money lines per bot),
       `g.acct.deleteBody`, and the backup and revoke notes (`g.acct.deleteBackups`, `g.tn.revokeStep` with a link to
       `https://app.hyperliquid-testnet.xyz/API`; the revoke step is a required tick box when a testnet key is stored);
    2. step 2, only after `409 testnet_positions_open`: the list of `{coin, szi}` and `g.acct.deleteForce`, with a
       required "delete anyway" tick box that sends `force:true`;
  - admins also see an *Operator* panel (P1): kill-switch toggle with a reason, and `admin_status` numbers.
- **Settings** also shows the privacy note `g.acct.privacy` (what is stored: username, password hash, sessions with an
  IP prefix, the encrypted testnet API key and its backups; how to delete it).
- **Help & FAQ** (`ui/help.js`, WP5, EN and TH, keys `g.faq.*`) answers:
  - `g.faq.serverDown`: testnet positions stay open while the server is down or restarting; how to close them on
    `app.hyperliquid-testnet.xyz`;
  - `g.faq.operator`: what the operator can technically do with a stored agent key (trade that testnet account; never
    withdraw), and why mainnet keys are refused;
  - `g.faq.faucet`: the faucet rule and the two ways to get test USDC (§11.4);
  - `g.faq.noRecovery`: no email and no self-service reset; the operator reset wipes the testnet key;
  - `g.faq.inactive`: testnet bots are flattened and paused after 14 days without a visit;
  - `g.faq.data`: what is stored, for how long backups keep it, and how to delete it.

### 9.3 Connect Hyperliquid testnet (`ui/testnet.js`; Settings → Testnet, and from the plant dialog)

The panel, top to bottom:
1. A red-bordered warning block that is always visible: `g.tn.warnTestnet`, `g.tn.warnKeys`.
2. How-to: `g.tn.how`, with a link `https://app.hyperliquid-testnet.xyz/API` (`rel="noopener noreferrer"`), and
   `g.tn.faucet` with the link `https://app.hyperliquid-testnet.xyz/drip` and the mainnet-deposit rule. A short
   `g.tn.optional` line says testnet is optional and paper is the complete game.
3. Trust note `g.tn.trust`.
4. **Account address** input (`0x…`, `inputmode="text"`, `autocomplete="off"`, `spellcheck="false"`).
5. **API wallet private key** input. It must never be captured by a password manager or autofilled into the gate:
   - `type="text"` (or a single-line `textarea`) masked with CSS `-webkit-text-security: disc`, plus
     `autocomplete="off"`, `autocapitalize="off"`, `autocorrect="off"`, `spellcheck="false"`, `data-1p-ignore`,
     `data-lpignore="true"`, `data-bwignore`;
   - it is **not** inside any `<form>`, and no element of the panel has a username-like `autocomplete`;
   - a show/hide toggle; where `CSS.supports('-webkit-text-security', 'disc')` is false, the key is shown in plain
     text with the note `g.tn.keyVisible`;
   - it is cleared on success and on dialog close.

Client-side checks (the server repeats them):
- 12–24 words → refuse with `g.tn.err.seed` and do not send.
- Otherwise the key must match `^(0x)?[0-9a-fA-F]{64}$` (`g.tn.err.format`). Refused input is never sent, so it
  never counts against the connect limit.

Flow:
- **Verify and connect** shows `g.tn.verifying`, then the result. Warnings (`unnamed_agent`, `agent_expiring_soon`,
  `no_funds`, `existing_positions`) appear as amber lines under the connected state.
- **Connected state:** account (truncated), agent (truncated) and its name, `valid until` (amber at < 7 days, red at
  < 1 day, `g.tn.expiring`), testnet account value (`≈` for unified accounts) and free collateral with their age,
  requests left, existing-positions warning, **Replace API wallet** (paste a new key for the same account; bots are
  kept), and **Disconnect and delete the key**.
- **Disconnect dialog:**
  1. when testnet bots are open: the `close_bots` choice (`g.tn.disconnectBots`);
  2. `g.tn.disconnectBackups` (encrypted copies stay in backups for up to 7 days) and the required step
     `g.tn.revokeStep` with the link to `https://app.hyperliquid-testnet.xyz/API`;
  3. after `409 testnet_positions_open`: the `{coin, szi}` list with `g.acct.deleteForce`-style copy
     (`g.tn.disconnectForce`) and a required tick box that sends `force:true`.
- P1: **Approve with my wallet** (§6.10) appears only when `window.ethereum` exists.

### 9.4 Plant dialog, venue badges, testnet cues

**Plant dialog** (`ui/plantDialog.js`):
- A **venue segmented control** under the bean line: `Paper (simulated)` | `Testnet (real test orders)`. The
  default is Paper.
- **When the Testnet option is enabled** depends only on stake-independent checks (§7.3 checks 1–11, returned as
  `testnet_quote.venue_ok` / `venue_reason`): testnet enabled, connected, credential live, kill switch off, testnet
  up, API wallet not about to expire, capacity, coin listed, bean plantable, a fresh testnet price, and free
  collateral ≥ the minimum stake. When disabled, the reason text comes from `g.plant.tnReason.*`. The reason
  `not_connected` links to a short explainer (`g.plant.tnExplain`: testnet is optional, paper is complete, and test
  USDC needs a mainnet-deposited address) and to Connect.
- **Switching to Testnet** clamps the water to `min(500, room, 0.9 × free collateral)`. Stake-dependent problems
  (`testnet_caps`, balance for this stake, `thin_book`) appear in the normal red block line, not as a disabled
  option.
- **Quote cadence:** `testnet_quote` is called when the dialog opens, on a venue switch, 300 ms after the slider
  settles, and at submit. Numbers computed between quotes (the 1 s `renderLive` loop) carry `≈`. A dialog never
  calls the quote more than once per 300 ms, which keeps phone drags far below the per-IP query bucket.
- **Testnet selected:**
  - Price lines: `g.plant.price` (real mainnet price) **and** `g.plant.tnPrice` (**testnet mid**, with its age,
    source `g.src.hlTestnet`).
  - **Divergence:** when `|divergence| > 3%`, an amber line `g.plant.tnDiverge` ("The testnet price is {pct} away
    from the real price. This bot's results will not match the bean's."). When `> 20%`, a required tick box
    `g.plant.tnDivergeAck` sends `ack_divergence:true`.
  - The bean's track record line adds `g.plant.beanRealPrices` ("bean results are at real prices").
  - Size line `g.plant.tnSize`, and `g.plant.tnK` ("sized ×{k} for testnet prices").
  - Margin, liquidation move %, fees and room come from `testnet_quote`. Server numbers; a `≈` prefix only where
    the quote is an estimate.
  - **Slippage and liquidity:** `g.plant.tnSlip` ("IOC within 1%: up to ≈ {usd} worse than the testnet price"); when
    `book_ok` is false the submit is blocked with `g.plant.tnReason.thin_book`.
  - Funding line `g.funding.testnet` with the **testnet** rate (`testnet_market.coins[].funding_1h`).
  - Water slider max = `min(500, room, 0.9 × free collateral)`.
  - Submit label `g.plant.submitTestnet`.
  - Footer `g.plant.tnFill`, replacing the PAPER footer.
  - It sends `bot_create {bean, capital_usd, venue:'testnet', confirm:'testnet', ack_divergence?}`.
- **Paper selected:** unchanged.

**Testnet bots in the inspector, dock and radial:**
- The mark line reads `g.src.hlTestnet` ("Hyperliquid TESTNET") and "Testnet mid", never the mainnet `g.src.hl`.
- The paper footer `g.insp.paperNote` is replaced by `g.venue.testnetLong` on testnet bots (inspector and dock).
- `g.insp.tnK` shows the frozen `k` ("sized ×{k} for testnet prices"); the bean line adds `g.plant.beanRealPrices`.
- **Funding** is its own line (`g.insp.funding`: realized + since open), included in Total P&L (§6.11).
- **Fill state** (`fill_state`): `partial` → `g.insp.tnFilled` ("Holding {sz} of {target} {coin}: the IOC filled
  partly; retrying next minute"); `unfilled` → `g.insp.tnUnfilled`; `waiting_bean` → `g.insp.tnWaiting`. The chip
  shows a small half-filled or empty ring for `partial` / `unfilled`.
- **Closing state:** while `closing` or `exchange_sync.op === 'flatten'`, the inspector, radial and dock replace
  their actions (Harvest, Shade, Resume) with `g.insp.closing` ("Closing on testnet… {sz} {coin} left"); when the
  flatten has failed, `g.insp.closingFailed` with the next retry time. A second `bot_close` is never sent from the UI
  (and the server treats it as idempotent).
- **Harvest confirm** for a testnet bot shows `g.confirm.tnSlip` ("starts within 1%; on a thin book retries widen to
  5% (≤ ≈ {usd})").
- **After close:** the empty-plot card (QA-04) shows the coin and result; with `confirmed:false` the result carries
  `≈` until `bot_fill_confirmed`.

**Venue badges** (word plus shape, no new hue: J6):
- `PAPER`: cream chip, dark ink.
- `TESTNET`: slate chip, white ink, black-and-white **checkered** left edge.
- They are shown on plot chips (`ui/chips.js`), dock rows (`ui/dock.js`), the inspector title (`ui/inspector.js`),
  the list view, the confirm dialogs and diary lines.
- In 3D, testnet plots get a small checkered pennant on the tag stake (`field/props.js`). Its DOM label reads
  `TESTNET`.

**Mode badge** (`ui/badge.js`):
- **Desktop:** the existing badge stays. A **second** badge appears when the player has ≥ 1 open testnet bot or is
  connected: `g.badge.testnet` (slate, checkered edge); `g.badge.testnetDown` (grey) when testnet is delayed or down;
  `g.badge.kill` (grey) when the kill switch is on.
- **Phone (< 768 px):** **one combined chip** in the top row: `g.badge.short.paperTestnet` ("REAL · PAPER + TESTNET"),
  or `g.badge.short.testnetDown` / `g.badge.short.kill` in their states. Tapping it opens the full badge text. Both
  the words PAPER and TESTNET stay visible (J9).
- It cannot be dismissed (J9).

**Ledgers (barn and HUD):**
- The barn, pond, tower and the *growing*/*harvested* signs show the **paper** ledger.
- The **barn popover** always shows both ledgers side by side. The testnet column shows the account value with its
  age (and `≈` for unified accounts) and **no "vs start" percentage**: the testnet ledger has no start, and its value
  also moves with faucet claims and manual trades. It may show "since you connected on {date}: {delta}"
  (`g.lm.barnTestnet`), using `value_at_connect`.
- P1: a `Paper | Testnet` HUD toggle (`g.hud.ledger`) that switches the landmarks to the testnet ledger. Cut first if
  late (§12.6); the barn popover already shows both.

**Accounts-mode copy variants** (selected by `mode`; none mode keeps today's strings):
- `plot.emptyHalted` → `plot.emptyHaltedRearm`; `modal.halted` and `shelf.noteHalted` → `modal.haltedRearm` /
  `shelf.noteHaltedRearm` ("re-arm the field in {time}" / "re-arm the field to plant again");
- `ask.burn` and `g.ask.burnBody` → `ask.burnAccounts` / `g.ask.burnBodyAccounts` (lists testnet bots and says they
  close with IOC orders that may take a minute, and that planting needs a re-arm);
- `g.mode.realBody` → `g.mode.realBodyAccounts` (no testnet) or `g.mode.realBodyTestnet` (connected);
- `app.simNote` and `g.tour.1` → `app.simNoteAccounts` / `g.tour.1Accounts` (paper by default; testnet optional);
- `g.mode.realBack` ("restart the server…") is shown to **admins only**.
QA-19 asserts that no rendered accounts-mode string contains "restart" or "รีสตาร์ท" outside admin views.

### 9.5 Transport: `brood-api.js` and `core/data.js` (owned by WP4)

**`brood-api.js`:**
- `getMode()` caches `GET /api/v1` → `{auth, testnet}`.
- In accounts mode:
  - `cleanBase()` accepts only the page origin, so `?api=` to another origin is refused with a console notice;
  - the token functions are inert, and the token box is hidden;
  - `fetch` uses `credentials: 'same-origin'` explicitly;
  - commands send **only** `Content-Type: application/json` plus `Accept` (no Authorization);
  - a `401` with `code ∈ {auth_required, session_expired}` dispatches `auth:required` on the injected bus;
  - `429` responses expose `retry_after_s`.
- `EVENT_KINDS` adds `bot_sync`, `bot_fill_confirmed`, `testnet_account`, `credential_status`, `garden_rearmed`,
  `garden_reset`, `password_reset`, `kill_switch`, `testnet_feed`, `session_ended`, `resync`, `server_restart`.
- Commands never put params in the query string (they already use the JSON body today; accounts mode refuses query
  params, §4.4).
- New helpers: `signup()`, `login()`, `logout()` (thin `command()` wrappers that never log params) and
  `restream()` (close and reopen the EventSource; needed because cookies apply at connect).

**`core/data.js`:**
- The store gains `user`, `mode`, `testnet` (`testnet_market` + `testnet_status`) and `venues` (from
  `live_status.venues`).
- `tend()` skips user queries for spectators.
- On `auth:required` or `session_ended`: clear the user, bots, live, detail, diary cache and own-echo map, then
  show the gate with `g.gate.ended`.
- On `resync`: run a full refresh.
- On `server_restart`: show a toast, and reconnect with the existing back-off.
- The slots key becomes `bean.game.slots.v1:<uid>`, with the none-mode key unchanged.
- `testnet_market` refreshes every 60 s. Testnet mids arrive in `mids.testnet`.
- `bot_sync` drives the pending loops on plots (J3).
- **Diary is multi-user-safe:**
  - it is built only from this stream (server-scoped) and the `events` backfill (scoped);
  - its in-memory buffer is keyed by uid and cleared on sign-out;
  - nothing user-specific is put in localStorage except the slot layout.

**Localized errors and notes (WP5, `ui/util.js`, `ui/diary.js`):**
- `errText(body)` returns `t('g.err.' + body.code, vars)` whenever that key exists, with variables taken from the
  body (`retry_after_s` → `{time}`, `positions` → `{coins}`, `sub_reason`, …). The raw server text appears only in a
  collapsible "details" line. Only bodies without a known code fall back to today's behaviour.
- In accounts mode, `401` with `auth_required` or `session_expired` opens the gate with `g.gate.ended`. The token copy
  (`err.auth`, "save a command token in 🔑") is never shown in accounts mode.
- `429` from `testnet_connect` shows `g.tn.err.rate` with the time until the next attempt and the attempts left.
- `diary.lineFor` gains a case for **every** §8.7 kind: `credential_status` (revoked → `warn` line and the mailbox
  flag), `kill_switch` (on → `warn`), `testnet_feed` (down → `warn`), `bot_sync` (failed), `bot_fill_confirmed`,
  `garden_rearmed`, `garden_reset`, `password_reset`. Pause and error lines use `note_code` / `code` through
  `g.note.*` and `g.err.*` (with `{exch}`, `{exp}`, `{coin}`), never the server's English `reason` text. Lines about
  a testnet bot are prefixed with the venue word (`g.venue.testnet`). A test asserts that every §8.7 kind maps to a
  non-null localized line.

### 9.6 Honesty rules per venue (the Juice Contract still applies; additions are P0)

| Rule | Paper (unchanged) | Testnet (new reading) |
|---|---|---|
| J1 one source of truth | server numbers | **Exchange** numbers are shown plain, with the age of `exchange.as_of_ms`. Numbers computed at the testnet mid (uPnL between reconciles) carry `≈` (`est`). Provisional fees show `≈` plus `g.insp.feeEst` until `bot_fill_confirmed`. The source label is `g.src.hlTestnet` and the price is called "Testnet mid"; the paper footer never appears on a testnet bot. Unified-account values computed by us carry `≈`. |
| J2 numbers first | as today | as today; nothing tweens |
| J3 server first | pending loop until 2xx / SSE | pending loop until `bot_sync state:'done'` or a `bot_fill`; `exchange_sync.state:'failed'` → dust puff + `g.insp.syncFailed` (localized by code); the closing state replaces the actions until flat (§9.4) |
| J4 losses look like losses | as today | as today, using **confirmed** exchange fills: harvest and pull effects play on `bot_closed {confirmed:true}`. With `confirmed:false`, the result shows `≈`, and the effect is neutral when \|realized\| ≤ 2 × the estimated fee; crates and compost re-sort on `bot_fill_confirmed` without replaying effects. A testnet liquidation uses the paper liquidation visuals with `g.note.liquidated_testnet`. |
| J5 harvest does not grow the barn | paper barn | the testnet barn is the exchange's account value, which also moves with **real testnet funding**, fees, faucet claims and manual trades. It has no "vs start" (§9.4). Never animated. |
| J6 colour channels | as today | the venue uses word + checkered shape and no hue |
| J7 risk always visible | as today | the liquidation price is the **exchange's** `liquidationPx` ("—" until the first reconcile after an open, never invented) |
| J8 no rewards | as today | as today |
| J9 PAPER always on screen | badge | plus the TESTNET badge whenever testnet is used; every testnet price is labelled "testnet" |
| J10 confirms state the money | "paper fill" | `g.confirm.tnFill`: side, size, **testnet** price, ≈ $ result, "IOC: may fill partly or not at all; test funds", plus the slippage line `g.confirm.tnSlip` |
| J11 symmetric feedback | as today | as today |
| J12 neutral nudges | as today | as today; the drift copy (`g.insp.drift`) explains both choices neutrally; the divergence warning (`g.plant.tnDiverge`) is amber, not red, and states a fact |
| funding line | "info only, not charged" | `g.funding.testnet` with the **testnet** rate from `metaAndAssetCtxs`: "charged on testnet (test funds)"; the bot's funding paid or received is its own line and part of Total P&L |

### 9.7 i18n keys (EN + TH; added to `web/js/i18n.js` under `g.`; the parity test covers them)

#### 9.7.1 UI keys

Keys without the `g.` prefix are accounts-mode variants of existing keys in the same namespaces (§9.4).

| Key | EN | TH |
|---|---|---|
| `g.gate.title` | The farm gate | ประตูฟาร์ม |
| `g.gate.lead` | Sign in to tend your own garden. Everyone shares the same seeds and prices; each garden is private. | เข้าสู่ระบบเพื่อดูแลสวนของคุณเอง ทุกคนใช้เมล็ดและราคาชุดเดียวกัน แต่สวนของแต่ละคนเป็นส่วนตัว |
| `g.gate.signin` | Sign in | เข้าสู่ระบบ |
| `g.gate.signup` | Create a garden | สร้างสวนใหม่ |
| `g.gate.visit` | Just look around | ขอเดินชมก่อน |
| `g.gate.username` | Username | ชื่อผู้ใช้ |
| `g.gate.usernameHint` | 3–24 characters: a–z, 0–9 or _ | 3–24 ตัว ใช้ a–z ตัวเลข หรือ _ |
| `g.gate.password` | Password | รหัสผ่าน |
| `g.gate.passwordHint` | At least 10 characters | อย่างน้อย 10 ตัวอักษร |
| `g.gate.password2` | Repeat password | ใส่รหัสผ่านอีกครั้ง |
| `g.gate.mismatch` | The passwords do not match. | รหัสผ่านทั้งสองช่องไม่ตรงกัน |
| `g.gate.badLogin` | Wrong username or password. | ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง |
| `g.gate.rate` | Too many tries. Try again in {time}. | ลองหลายครั้งเกินไป ลองใหม่ใน {time} |
| `g.gate.taken` | That username is not available. | ใช้ชื่อผู้ใช้นี้ไม่ได้ |
| `g.gate.weak` | Choose a longer or less common password. | โปรดเลือกรหัสผ่านที่ยาวขึ้นหรือเดายากขึ้น |
| `g.gate.closed` | New gardens are closed on this server. | เซิร์ฟเวอร์นี้ปิดรับการสร้างสวนใหม่ |
| `g.gate.ended` | Your session ended. Sign in again. | เซสชันสิ้นสุดแล้ว โปรดเข้าสู่ระบบอีกครั้ง |
| `g.gate.paperNote` | New gardens start with $10,000 of paper money. No real money. | สวนใหม่เริ่มด้วยเงินกระดาษ $10,000 ไม่ใช่เงินจริง |
| `g.gate.signInToPlant` | Sign in to plant | เข้าสู่ระบบเพื่อปลูก |
| `g.acct.menu` | Account | บัญชี |
| `g.acct.signedInAs` | Signed in as {name} | เข้าสู่ระบบในชื่อ {name} |
| `g.acct.changePw` | Change password | เปลี่ยนรหัสผ่าน |
| `g.acct.currentPw` | Current password | รหัสผ่านปัจจุบัน |
| `g.acct.newPw` | New password | รหัสผ่านใหม่ |
| `g.acct.pwChanged` | Password changed. Other devices were signed out. | เปลี่ยนรหัสผ่านแล้ว อุปกรณ์อื่นถูกออกจากระบบ |
| `g.acct.logout` | Sign out | ออกจากระบบ |
| `g.acct.logoutAll` | Sign out everywhere | ออกจากระบบทุกอุปกรณ์ |
| `g.acct.delete` | Delete account | ลบบัญชี |
| `g.acct.deleteBody` | Closes every bot and deletes your garden, diary and saved testnet key. This cannot be undone. Type DELETE to confirm. | ปิดบอททุกตัว ลบสวน บันทึก และคีย์ testnet ที่บันทึกไว้ ย้อนกลับไม่ได้ พิมพ์ DELETE เพื่อยืนยัน |
| `g.acct.operator` | Operator | ผู้ดูแลระบบ |
| `g.venue.paper` | PAPER | กระดาษ |
| `g.venue.testnet` | TESTNET | TESTNET |
| `g.venue.paperLong` | Paper: simulated fills at real prices | กระดาษ: จำลองการซื้อขายที่ราคาจริง |
| `g.venue.testnetLong` | Testnet: real orders on Hyperliquid TESTNET with test funds | Testnet: คำสั่งจริงบน Hyperliquid TESTNET ด้วยเงินทดสอบ |
| `g.badge.testnet` | TESTNET ORDERS · TEST FUNDS | คำสั่ง TESTNET · เงินทดสอบ |
| `g.badge.testnetDown` | TESTNET DOWN · TESTNET BOTS WAIT | TESTNET ไม่ตอบสนอง · บอท TESTNET รอ |
| `g.badge.kill` | TESTNET PAUSED BY THE OPERATOR | ผู้ดูแลระบบหยุด TESTNET ชั่วคราว |
| `g.tn.title` | Connect Hyperliquid TESTNET | เชื่อมต่อ Hyperliquid TESTNET |
| `g.tn.warnTestnet` | TESTNET ONLY. Test funds, never real money. | ใช้กับ TESTNET เท่านั้น เป็นเงินทดสอบ ไม่ใช่เงินจริง |
| `g.tn.warnKeys` | Never paste a MAINNET key, your wallet's own private key or a seed phrase. Paste only an API-wallet key made for testnet. | ห้ามวางคีย์ MAINNET คีย์ส่วนตัวของกระเป๋าหลัก หรือ seed phrase เด็ดขาด วางเฉพาะคีย์ API wallet ที่สร้างสำหรับ testnet |
| `g.tn.how` | Open app.hyperliquid-testnet.xyz/API, create an API wallet named bean-garden, approve it, and copy its private key (shown once). | เปิด app.hyperliquid-testnet.xyz/API สร้าง API wallet ชื่อ bean-garden กดอนุมัติ แล้วคัดลอกคีย์ส่วนตัว (แสดงเพียงครั้งเดียว) |
| `g.tn.trust` | This server stores the key encrypted and uses it only for your bots' testnet orders. API wallets can trade but cannot withdraw. Revoke it any time on the testnet site. | เซิร์ฟเวอร์นี้เก็บคีย์แบบเข้ารหัส และใช้เฉพาะส่งคำสั่ง testnet ของบอทคุณ API wallet เทรดได้แต่ถอนเงินไม่ได้ เพิกถอนได้ทุกเมื่อบนเว็บ testnet |
| `g.tn.faucet` | Test USDC comes from Hyperliquid's testnet faucet (1,000 mock USDC): app.hyperliquid-testnet.xyz/drip. Hyperliquid only gives it to an address that has deposited on mainnet. If you log in by email, export that wallet first. Without it, paper planting is the full game. | รับ USDC ทดสอบจาก faucet ของ Hyperliquid testnet (1,000 USDC จำลอง): app.hyperliquid-testnet.xyz/drip โดย Hyperliquid ให้เฉพาะที่อยู่ที่เคยฝากเงินบน mainnet แล้ว ถ้าเข้าระบบด้วยอีเมลต้อง export กระเป๋าก่อน ถ้าไม่มีก็เล่นแบบกระดาษได้ครบทุกอย่าง |
| `g.tn.address` | Testnet account address (0x…) | ที่อยู่บัญชี testnet (0x…) |
| `g.tn.key` | API wallet private key | คีย์ส่วนตัวของ API wallet |
| `g.tn.verify` | Verify and connect | ตรวจสอบและเชื่อมต่อ |
| `g.tn.verifying` | Checking with Hyperliquid testnet… | กำลังตรวจสอบกับ Hyperliquid testnet… |
| `g.tn.connected` | Connected · {addr} · API wallet {agent} | เชื่อมต่อแล้ว · {addr} · API wallet {agent} |
| `g.tn.validUntil` | API wallet valid until {date} | API wallet ใช้ได้ถึง {date} |
| `g.tn.expiryUnknown` | API wallet expiry unknown | ไม่ทราบวันหมดอายุของ API wallet |
| `g.tn.balance` | Testnet account {usd} · free {free} · {age} | บัญชี testnet {usd} · ว่าง {free} · {age} |
| `g.tn.requests` | Exchange requests left: {n} | คำขอไปยังตลาดที่เหลือ: {n} |
| `g.tn.positionsWarn` | This account already holds {coins}. The garden will not touch them, but it cannot tell your trades from its own on the same coin. Avoid trading those coins by hand while a bot holds them. | บัญชีนี้ถือ {coins} อยู่แล้ว สวนจะไม่แตะสถานะเหล่านั้น แต่สวนแยกไม่ออกว่าการเทรดเหรียญเดียวกันเป็นของคุณหรือของบอท อย่าเทรดเหรียญนั้นด้วยตัวเองระหว่างที่บอทถืออยู่ |
| `g.tn.disconnect` | Disconnect and delete the stored key | ตัดการเชื่อมต่อและลบคีย์ที่บันทึกไว้ |
| `g.tn.disconnectBots` | Close my {n} testnet bots first | ปิดบอท testnet {n} ตัวก่อน |
| `g.tn.err.format` | That is not a 64-character hex private key. | นี่ไม่ใช่คีย์ส่วนตัวแบบ hex 64 ตัวอักษร |
| `g.tn.err.seed` | That looks like a seed phrase. Never paste a seed phrase anywhere. | นี่ดูเหมือน seed phrase ห้ามวาง seed phrase ที่ใดเด็ดขาด |
| `g.tn.err.notAgent` | This key is not an approved API wallet on testnet. | คีย์นี้ไม่ใช่ API wallet ที่ได้รับอนุมัติบน testnet |
| `g.tn.err.mismatch` | This API wallet belongs to another account ({addr}). | API wallet นี้เป็นของบัญชีอื่น ({addr}) |
| `g.tn.err.master` | This is an account's own private key, not an API wallet. Do not use it here; create an API wallet. | นี่คือคีย์ส่วนตัวของบัญชีหลัก ไม่ใช่ API wallet ห้ามใช้ที่นี่ ให้สร้าง API wallet แทน |
| `g.tn.err.mainnet` | This key's address is known on MAINNET ({role}). Refused and not stored. If you did not mean to share it, revoke or move funds from it on app.hyperliquid.xyz now. | ที่อยู่ของคีย์นี้มีอยู่บน MAINNET ({role}) จึงถูกปฏิเสธและไม่ได้บันทึก หากไม่ได้ตั้งใจเปิดเผย ให้เพิกถอนหรือย้ายเงินออกที่ app.hyperliquid.xyz ทันที |
| `g.tn.err.expired` | This API wallet has expired. Create a new one. | API wallet นี้หมดอายุแล้ว โปรดสร้างใหม่ |
| `g.tn.err.abstraction` | This account uses portfolio margin, which the garden does not support. Switch it to Standard or Unified on the testnet site. | บัญชีนี้ใช้ portfolio margin ซึ่งสวนไม่รองรับ โปรดเปลี่ยนเป็นโหมด Standard หรือ Unified บนเว็บ testnet |
| `g.tn.err.inUse` | This API wallet or account is already connected to another garden. | API wallet หรือบัญชีนี้เชื่อมต่อกับสวนอื่นอยู่แล้ว |
| `g.tn.err.revoked` | Your API wallet is no longer approved. Testnet positions stay open until you close them on the testnet site or reconnect. | API wallet ของคุณถูกเพิกถอนแล้ว สถานะบน testnet ยังเปิดอยู่จนกว่าคุณจะปิดบนเว็บ testnet หรือเชื่อมต่อใหม่ |
| `g.tn.err.down` | Hyperliquid testnet is not answering. Try again later. | Hyperliquid testnet ไม่ตอบสนอง โปรดลองใหม่ภายหลัง |
| `g.tn.err.capacity` | The testnet field is full right now. Paper planting still works. | ตอนนี้แปลง testnet เต็ม ยังปลูกแบบกระดาษได้ |
| `g.plant.venue` | Where it trades | เทรดที่ไหน |
| `g.plant.venuePaper` | Paper (simulated) | กระดาษ (จำลอง) |
| `g.plant.venueTestnet` | Testnet (real test orders) | Testnet (คำสั่งทดสอบจริง) |
| `g.plant.tnPrice` | Testnet price {px} ({age}). Orders fill here; it can differ from the real price {real}. | ราคา testnet {px} ({age}) คำสั่งจะจับคู่ที่ราคานี้ ซึ่งอาจต่างจากราคาจริง {real} |
| `g.plant.tnSize` | ≈ {sz} {coin}, sized to the bean's dollar exposure at testnet prices | ≈ {sz} {coin} ปรับขนาดตามมูลค่าที่ ถั่ว ถือ ณ ราคา testnet |
| `g.plant.tnFill` | TESTNET ORDER: an IOC order on Hyperliquid testnet within 1% of the testnet price. It may fill partly or not at all. Closing retries may go up to 5% on thin books. Test funds only. | คำสั่ง TESTNET: คำสั่ง IOC บน Hyperliquid testnet ภายใน 1% ของราคา testnet อาจจับคู่ได้บางส่วนหรือไม่ได้เลย การปิดสถานะที่ลองซ้ำอาจขยายได้ถึง 5% เมื่อสภาพคล่องน้อย ใช้เงินทดสอบเท่านั้น |
| `g.plant.submitTestnet` | 🌱 Plant & send testnet order ({usd}) | 🌱 ปลูกและส่งคำสั่ง testnet ({usd}) |
| `g.plant.tnReason.not_connected` | Connect a testnet account first. | เชื่อมต่อบัญชี testnet ก่อน |
| `g.plant.tnReason.unlisted_testnet` | {coin} is not listed on testnet. | {coin} ไม่มีบน testnet |
| `g.plant.tnReason.delisted_testnet` | {coin} is delisted on testnet. | {coin} ถูกถอดออกจาก testnet |
| `g.plant.tnReason.testnet_caps` | Over your testnet limits ({detail}). | เกินขีดจำกัด testnet ของคุณ ({detail}) |
| `g.plant.tnReason.insufficient_testnet_balance` | Not enough free test USDC ({free}). | USDC ทดสอบที่ว่างไม่พอ ({free}) |
| `g.plant.tnReason.testnet_down` | Testnet is not answering. | testnet ไม่ตอบสนอง |
| `g.plant.tnReason.kill_switch` | Testnet trading is paused by the operator. | ผู้ดูแลระบบหยุดการเทรด testnet ชั่วคราว |
| `g.plant.tnReason.leverage` | Needs {need}× but testnet allows {max}×. | ต้องใช้ {need}× แต่ testnet อนุญาต {max}× |
| `g.plant.tnReason.testnet_capacity` | The testnet field is full right now. | ตอนนี้แปลง testnet เต็ม |
| `g.confirm.tnFill` | testnet IOC order (test funds): the result is what the exchange fills | คำสั่ง IOC บน testnet (เงินทดสอบ): ผลลัพธ์ขึ้นกับการจับคู่จริงของตลาด |
| `g.insp.exchange` | Exchange says ({age}) | ตัวเลขจากตลาด ({age}) |
| `g.insp.estAtMid` | ≈ at the testnet mid | ≈ ที่ราคากลาง testnet |
| `g.insp.feeEst` | fee ≈ (confirming) | ค่าธรรมเนียม ≈ (กำลังยืนยัน) |
| `g.insp.syncPending` | Sending to testnet… | กำลังส่งไป testnet… |
| `g.insp.syncFailed` | Testnet order failed: {reason} | คำสั่ง testnet ล้มเหลว: {reason} |
| `g.insp.drift` | The testnet account holds {exch} {coin}, but this bot expected {exp}. Was this coin traded by hand? Resume adopts the exchange size; Close closes it. | บัญชี testnet ถือ {exch} {coin} แต่บอทนี้คาดว่า {exp} มีการเทรดเหรียญนี้ด้วยตัวเองหรือไม่? กด "กลับมาทำงาน" เพื่อใช้ขนาดจากตลาด หรือกด "ปิด" เพื่อปิดสถานะนั้น |
| `g.insp.dust` | {sz} {coin} left below the $10 minimum | เหลือ {sz} {coin} ต่ำกว่าขั้นต่ำ $10 |
| `g.insp.emptyAfter` | Plot {n} is empty. Last crop: {coin} {result}. | แปลง {n} ว่าง พืชล่าสุด: {coin} {result} |
| `g.insp.emptyAfterNoPlot` | Last crop: {coin} {result}. (It was not planted on a plot you can see.) | พืชล่าสุด: {coin} {result} (ไม่ได้ปลูกบนแปลงที่มองเห็นอยู่) |
| `g.insp.plantHere` | Plant here | ปลูกที่นี่ |
| `g.hud.ledger` | Showing: {venue} | แสดง: {venue} |
| `g.funding.testnet` | Funding {rate}/h, charged on testnet (test funds) | Funding {rate}/ชม. คิดจริงบน testnet (เงินทดสอบ) |
| `g.lm.signpostSignedOut` | Sign in to farm | เข้าสู่ระบบเพื่อทำฟาร์ม |
| `g.rearm` | Re-arm the field | เปิดใช้งานแปลงอีกครั้ง |
| `g.rearm.body` | Your field was burned at {time}. Re-arming lets you plant again. Type REARM to confirm. | แปลงของคุณถูกเผาเมื่อ {time} การเปิดใช้งานอีกครั้งจะทำให้ปลูกได้อีก พิมพ์ REARM เพื่อยืนยัน |
| `g.err.restarting` | The garden server is restarting… | เซิร์ฟเวอร์สวนกำลังรีสตาร์ต… |
| `g.gate.noRecovery` | No email, no password reset: keep your password in a password manager. If you lose it, only the operator can issue a reset code. | ไม่มีอีเมลและไม่มีการรีเซ็ตรหัสผ่านเอง โปรดเก็บรหัสผ่านไว้ในโปรแกรมจัดการรหัสผ่าน ถ้าลืม มีเพียงผู้ดูแลระบบที่ออกรหัสรีเซ็ตให้ได้ |
| `g.gate.resetLink` | I have a reset code | ฉันมีรหัสรีเซ็ต |
| `g.gate.resetCode` | Reset code from the operator | รหัสรีเซ็ตจากผู้ดูแลระบบ |
| `g.tour.private` | Your garden is private: only you see your bots, money and diary. The beans and prices are shared by everyone. | สวนของคุณเป็นส่วนตัว มีแต่คุณที่เห็นบอท เงิน และบันทึกของคุณ ส่วน ถั่ว และราคาใช้ร่วมกันทุกคน |
| `g.acct.resetNotice` | Your password was reset by the operator. Your testnet key was deleted for safety; reconnect testnet if you use it. | ผู้ดูแลระบบรีเซ็ตรหัสผ่านของคุณแล้ว คีย์ testnet ถูกลบเพื่อความปลอดภัย หากใช้ testnet โปรดเชื่อมต่อใหม่ |
| `g.acct.reset` | Start a new paper season | เริ่มฤดูกาลกระดาษใหม่ |
| `g.acct.resetBody` | Closes your {n} paper bots at market and starts again with {usd} of paper money. Old results stay in season {season}. Testnet bots are not touched. Type RESET to confirm. | ปิดบอทกระดาษ {n} ตัวที่ราคาตลาด แล้วเริ่มใหม่ด้วยเงินกระดาษ {usd} ผลเดิมเก็บไว้ในฤดูกาล {season} ไม่แตะบอท testnet พิมพ์ RESET เพื่อยืนยัน |
| `g.acct.resetWait` | A new season is possible again in {time}. | เริ่มฤดูกาลใหม่ได้อีกครั้งใน {time} |
| `g.acct.privacy` | We store your username, a password hash, your sign-ins with a shortened IP, and (if connected) your testnet API key, encrypted. Backups keep copies for up to {days} days. Delete account removes everything else at once. | เราเก็บชื่อผู้ใช้ ค่าแฮชของรหัสผ่าน ประวัติการเข้าระบบพร้อม IP แบบย่อ และคีย์ API testnet แบบเข้ารหัส (ถ้าเชื่อมต่อ) ข้อมูลสำรองเก็บสำเนาไว้ได้ถึง {days} วัน การลบบัญชีจะลบส่วนที่เหลือทั้งหมดทันที |
| `g.acct.deleteBackups` | Encrypted copies of your testnet key stay in server backups for up to {days} days. The only sure way to disable it is to revoke the API wallet on the testnet site. | สำเนาคีย์ testnet แบบเข้ารหัสยังอยู่ในข้อมูลสำรองของเซิร์ฟเวอร์ได้ถึง {days} วัน วิธีเดียวที่แน่นอนคือเพิกถอน API wallet บนเว็บ testnet |
| `g.acct.deleteForce` | These testnet positions could not be closed now: {coins}. Delete anyway? They stay open on app.hyperliquid-testnet.xyz until you close them there. | ปิดสถานะ testnet เหล่านี้ไม่ได้ในตอนนี้: {coins} ลบต่อหรือไม่? สถานะจะยังเปิดอยู่บน app.hyperliquid-testnet.xyz จนกว่าคุณจะปิดเอง |
| `g.tn.revokeStep` | I will revoke this API wallet at app.hyperliquid-testnet.xyz/API | ฉันจะเพิกถอน API wallet นี้ที่ app.hyperliquid-testnet.xyz/API |
| `g.tn.disconnectBackups` | The key is deleted from the garden now. Encrypted copies stay in backups for up to {days} days; revoking the API wallet is what really disables it. | คีย์ถูกลบออกจากสวนทันที สำเนาแบบเข้ารหัสยังอยู่ในข้อมูลสำรองได้ถึง {days} วัน การเพิกถอน API wallet เท่านั้นที่ปิดใช้งานได้จริง |
| `g.tn.disconnectForce` | These testnet positions are still open: {coins}. Disconnect anyway? They stay open until you close them on the testnet site. | สถานะ testnet เหล่านี้ยังเปิดอยู่: {coins} ตัดการเชื่อมต่อต่อหรือไม่? สถานะจะยังเปิดอยู่จนกว่าคุณจะปิดบนเว็บ testnet |
| `g.tn.optional` | Testnet is optional. Paper planting is the complete game. | testnet เป็นทางเลือก การปลูกแบบกระดาษเล่นได้ครบทุกอย่าง |
| `g.tn.keyVisible` | Your browser cannot hide this field, so the key is visible. Make sure nobody is watching your screen. | เบราว์เซอร์นี้ซ่อนช่องนี้ไม่ได้ จึงมองเห็นคีย์ได้ โปรดระวังไม่ให้ใครเห็นหน้าจอ |
| `g.tn.replace` | Replace API wallet | เปลี่ยน API wallet |
| `g.tn.replaced` | API wallet replaced. Your testnet bots keep running. | เปลี่ยน API wallet แล้ว บอท testnet ยังทำงานต่อ |
| `g.tn.expiring` | API wallet expires on {date}. Create a new one and use Replace API wallet before then; bots pause 30 minutes before expiry. | API wallet จะหมดอายุวันที่ {date} โปรดสร้างใหม่และกด "เปลี่ยน API wallet" ก่อนวันนั้น บอทจะหยุดก่อนหมดอายุ 30 นาที |
| `g.tn.noFunds` | This testnet account has only {usd}. Plants need at least $20 of free test USDC. | บัญชี testnet นี้มีเพียง {usd} การปลูกต้องมี USDC ทดสอบที่ว่างอย่างน้อย $20 |
| `g.tn.warn.unnamed` | This is an unnamed API wallet. Any new unnamed approval on your account revokes it. Create a named API wallet (for example bean-garden) instead. | นี่คือ API wallet ที่ไม่มีชื่อ การอนุมัติ API wallet ไม่มีชื่ออันใหม่จะยกเลิกอันนี้ โปรดสร้าง API wallet แบบมีชื่อ (เช่น bean-garden) แทน |
| `g.tn.err.rate` | Too many connection attempts. Try again in {time} ({n} left this hour). | ลองเชื่อมต่อหลายครั้งเกินไป ลองใหม่ใน {time} (เหลือ {n} ครั้งในชั่วโมงนี้) |
| `g.tn.err.mainnetCheck` | Could not confirm with Hyperliquid mainnet that this key is testnet-only. Nothing was stored. Try again in a minute. | ยืนยันกับ Hyperliquid mainnet ไม่ได้ว่าคีย์นี้ใช้กับ testnet เท่านั้น จึงไม่ได้บันทึกอะไร ลองใหม่ในอีกหนึ่งนาที |
| `g.badge.short.paperTestnet` | REAL · PAPER + TESTNET | ราคาจริง · กระดาษ + TESTNET |
| `g.badge.short.testnetDown` | PAPER · TESTNET DOWN | กระดาษ · TESTNET ล่ม |
| `g.badge.short.kill` | PAPER · TESTNET PAUSED | กระดาษ · TESTNET หยุด |
| `g.src.hlTestnet` | Hyperliquid TESTNET | Hyperliquid TESTNET |
| `g.plant.tnExplain` | Testnet is optional: real orders with test money on Hyperliquid's test exchange. Test USDC needs an address that has deposited on mainnet. Paper is the complete game. | testnet เป็นทางเลือก: คำสั่งจริงด้วยเงินทดสอบบนตลาดทดสอบของ Hyperliquid การรับ USDC ทดสอบต้องใช้ที่อยู่ที่เคยฝากเงินบน mainnet การเล่นแบบกระดาษครบทุกอย่าง |
| `g.plant.tnDiverge` | The testnet price is {pct} away from the real price. This bot's results will not match the bean's. | ราคา testnet ต่างจากราคาจริง {pct} ผลของบอทนี้จะไม่ตรงกับผลของ ถั่ว |
| `g.plant.tnDivergeAck` | I understand the testnet price is far from the real price | ฉันเข้าใจว่าราคา testnet ต่างจากราคาจริงมาก |
| `g.plant.beanRealPrices` | bean results are at real prices | ผลของ ถั่ว คิดที่ราคาจริง |
| `g.plant.tnK` | sized ×{k} for testnet prices | ปรับขนาด ×{k} ตามราคา testnet |
| `g.plant.tnSlip` | IOC within 1%: up to ≈ {usd} worse than the testnet price | IOC ภายใน 1%: อาจแย่กว่าราคา testnet ได้ถึง ≈ {usd} |
| `g.confirm.tnSlip` | Closing starts within 1%; on a thin book retries widen to 5% (≤ ≈ {usd}). | การปิดเริ่มที่ภายใน 1% ถ้าสภาพคล่องน้อย การลองซ้ำจะขยายถึง 5% (ไม่เกิน ≈ {usd}) |
| `g.insp.tnK` | sized ×{k} for testnet prices | ปรับขนาด ×{k} ตามราคา testnet |
| `g.insp.funding` | Funding (testnet): {usd} | Funding (testnet): {usd} |
| `g.insp.tnFilled` | Holding {sz} of {target} {coin}: the IOC filled partly; retrying next minute. | ถือ {sz} จาก {target} {coin}: IOC จับคู่ได้บางส่วน จะลองใหม่ในนาทีถัดไป |
| `g.insp.tnUnfilled` | Not filled yet: the testnet book had no match within 1%. Retrying next minute. | ยังไม่ได้จับคู่: ไม่มีคำสั่งรับในช่วง 1% บน testnet จะลองใหม่ในนาทีถัดไป |
| `g.insp.tnWaiting` | Waiting for the bean to take a position. | รอให้ ถั่ว เปิดสถานะ |
| `g.insp.closing` | Closing on testnet… {sz} {coin} left | กำลังปิดบน testnet… เหลือ {sz} {coin} |
| `g.insp.closingFailed` | Closing is waiting: {reason}. Next try {time}. | การปิดกำลังรอ: {reason} ลองใหม่ {time} |
| `g.lm.signInToSee` | Sign in to see your own {place}. | เข้าสู่ระบบเพื่อดู{place}ของคุณเอง |
| `g.lm.barnTestnet` | Testnet account {usd} ({age}) · since you connected on {date}: {delta} | บัญชี testnet {usd} ({age}) · ตั้งแต่เชื่อมต่อเมื่อ {date}: {delta} |
| `g.diary.signIn` | This is the public diary. Sign in to see your own garden's diary. | นี่คือบันทึกสาธารณะ เข้าสู่ระบบเพื่อดูบันทึกสวนของคุณเอง |
| `g.diary.credentialRevoked` | Your testnet API wallet is no longer usable ({reason}). Testnet bots paused. | API wallet ของ testnet ใช้ไม่ได้แล้ว ({reason}) บอท testnet หยุดชั่วคราว |
| `g.diary.killOn` | The operator paused all testnet trading: {reason}. | ผู้ดูแลระบบหยุดการเทรด testnet ทั้งหมด: {reason} |
| `g.diary.killOff` | Testnet trading is allowed again. Resume your bots when you are ready. | เทรด testnet ได้อีกครั้ง กดให้บอททำงานต่อเมื่อพร้อม |
| `g.diary.testnetDown` | Hyperliquid testnet is not answering. Testnet bots wait. | Hyperliquid testnet ไม่ตอบสนอง บอท testnet รออยู่ |
| `g.diary.testnetBack` | Hyperliquid testnet is answering again. | Hyperliquid testnet ตอบสนองแล้ว |
| `g.diary.syncFailed` | {bot}: testnet order failed: {reason} | {bot}: คำสั่ง testnet ล้มเหลว: {reason} |
| `g.diary.feeConfirmed` | {bot}: exchange confirmed the fill: fee {fee}, result {usd} | {bot}: ตลาดยืนยันการจับคู่แล้ว ค่าธรรมเนียม {fee} ผล {usd} |
| `g.diary.rearmed` | The field is re-armed. You can plant again. | เปิดใช้งานแปลงอีกครั้งแล้ว ปลูกได้อีก |
| `g.diary.seasonReset` | Paper season {season} started. {n} paper bots closed ({usd}). | เริ่มฤดูกาลกระดาษ {season} แล้ว ปิดบอทกระดาษ {n} ตัว ({usd}) |
| `g.diary.passwordReset` | Your password was reset by the operator. | ผู้ดูแลระบบรีเซ็ตรหัสผ่านของคุณแล้ว |
| `g.faq.serverDown` | If the garden server is down or restarting, your testnet positions stay open on Hyperliquid testnet. To close them yourself, open app.hyperliquid-testnet.xyz → Positions → Close. | ถ้าเซิร์ฟเวอร์สวนล่มหรือกำลังรีสตาร์ต สถานะ testnet ยังเปิดอยู่บน Hyperliquid testnet หากต้องการปิดเอง ให้เปิด app.hyperliquid-testnet.xyz → Positions → Close |
| `g.faq.operator` | Whoever runs this server could use your stored API-wallet key to trade your testnet account. An API wallet can never withdraw, and it is testnet only; keys known on mainnet are refused. | ผู้ที่ดูแลเซิร์ฟเวอร์นี้สามารถใช้คีย์ API wallet ที่บันทึกไว้เพื่อเทรดบัญชี testnet ของคุณได้ API wallet ถอนเงินไม่ได้และใช้กับ testnet เท่านั้น คีย์ที่มีอยู่บน mainnet จะถูกปฏิเสธ |
| `g.faq.faucet` | Hyperliquid's faucet (app.hyperliquid-testnet.xyz/drip) pays 1,000 mock USDC only to an address that has deposited on mainnet. Either connect that address's testnet account (you paste only a testnet API-wallet key, never the wallet key), or send the mock USDC from it to a fresh testnet address. | faucet ของ Hyperliquid (app.hyperliquid-testnet.xyz/drip) ให้ USDC จำลอง 1,000 เฉพาะที่อยู่ที่เคยฝากเงินบน mainnet เลือกได้ว่าจะเชื่อมต่อบัญชี testnet ของที่อยู่นั้น (วางเพียงคีย์ API wallet ของ testnet ไม่ใช่คีย์กระเป๋า) หรือโอน USDC จำลองไปยังที่อยู่ testnet ใหม่ |
| `g.faq.noRecovery` | There is no email and no self-service reset. The operator can issue a one-time reset code; doing so deletes your stored testnet key, so the operator can never use it through your account. | ไม่มีอีเมลและไม่มีการรีเซ็ตเอง ผู้ดูแลระบบออกรหัสรีเซ็ตแบบใช้ครั้งเดียวได้ และการทำเช่นนั้นจะลบคีย์ testnet ที่บันทึกไว้ ผู้ดูแลระบบจึงใช้คีย์ผ่านบัญชีของคุณไม่ได้ |
| `g.faq.inactive` | If you do not visit for {days} days, your testnet bots are closed and paused. Paper bots keep growing. | ถ้าไม่ได้เข้ามา {days} วัน บอท testnet จะถูกปิดสถานะและหยุดชั่วคราว บอทกระดาษยังทำงานต่อ |
| `g.faq.data` | See Settings → Privacy for what is stored and for how long. Delete account removes it; backups expire within {days} days. | ดูได้ที่ ตั้งค่า → ความเป็นส่วนตัว ว่าเก็บข้อมูลอะไรและนานเท่าไร การลบบัญชีจะลบข้อมูลนั้น และข้อมูลสำรองจะหมดอายุภายใน {days} วัน |
| `plot.emptyHaltedRearm` | the field is burned — re-arm it to plant again | ไร่ถูกเผาแล้ว — เปิดใช้งานแปลงอีกครั้งเพื่อปลูกใหม่ |
| `modal.haltedRearm` | the field is burned — re-arm the field in {time} to plant again | ไร่ถูกเผาแล้ว — เปิดใช้งานแปลงได้อีกครั้งใน {time} เพื่อปลูกใหม่ |
| `shelf.noteHaltedRearm` | the field is burned — showing every bean; re-arm the field to plant again | ไร่ถูกเผาแล้ว — แสดงถั่วทุกตัว เปิดใช้งานแปลงอีกครั้งเพื่อปลูกใหม่ |
| `ask.burnAccounts` | burn the field: close EVERY bot and refuse new ones until you re-arm it? | เผาไร่: ปิดบอท "ทุกตัว" และไม่รับบอทใหม่จนกว่าคุณจะเปิดใช้งานแปลงอีกครั้ง? |
| `g.ask.burnBodyAccounts` | Closes ALL {n} plots now: paper at market, testnet ({t}) with IOC orders that may take a minute. Unrealized {pnl} becomes realized. Planting needs a re-arm (after 60 s). | ปิด "ทุกแปลง" {n} แปลงทันที: กระดาษที่ราคาตลาด testnet ({t}) ด้วยคำสั่ง IOC ซึ่งอาจใช้เวลาหนึ่งนาที ส่วนที่ยังไม่รับรู้ {pnl} จะกลายเป็นรับรู้แล้ว การปลูกต้องเปิดใช้งานแปลงอีกครั้ง (หลัง 60 วินาที) |
| `g.mode.realBodyAccounts` | Prices: Hyperliquid public market data, updated {age} ago. Trades: simulated (paper) fills at those prices. No real money. | ราคา: ข้อมูลตลาดสาธารณะของ Hyperliquid อัปเดตเมื่อ {age}ที่แล้ว การเทรด: ซื้อขายจำลองบนกระดาษที่ราคานั้น ไม่ใช้เงินจริง |
| `g.mode.realBodyTestnet` | Prices: Hyperliquid public market data, updated {age} ago. Paper bots are simulated. Testnet bots send real orders on Hyperliquid TESTNET with test funds, using the API wallet you connected. No real money. | ราคา: ข้อมูลตลาดสาธารณะของ Hyperliquid อัปเดตเมื่อ {age}ที่แล้ว บอทกระดาษเป็นการจำลอง บอท testnet ส่งคำสั่งจริงบน Hyperliquid TESTNET ด้วยเงินทดสอบผ่าน API wallet ที่คุณเชื่อมต่อ ไม่ใช้เงินจริง |
| `app.simNoteAccounts` | paper by default · testnet bots use test funds · never real money | กระดาษเป็นค่าเริ่มต้น · บอท testnet ใช้เงินทดสอบ · ไม่ใช้เงินจริง |
| `g.tour.1Accounts` | Hi, I'm Pip! Prices here are REAL (Hyperliquid). Your bots trade on PAPER by default. Later you can connect Hyperliquid TESTNET for real orders with test money. Never real money. | สวัสดี ฉันชื่อพิป! ราคาที่นี่เป็นราคาจริง (Hyperliquid) บอทของคุณเทรดบนกระดาษเป็นค่าเริ่มต้น ภายหลังคุณเชื่อมต่อ Hyperliquid TESTNET เพื่อส่งคำสั่งจริงด้วยเงินทดสอบได้ ไม่ใช้เงินจริงเลย |
| `g.plant.tnReason.credential_revoked` | Your testnet API wallet is no longer usable. Reconnect it in Settings. | API wallet ของ testnet ใช้ไม่ได้แล้ว โปรดเชื่อมต่อใหม่ในการตั้งค่า |
| `g.plant.tnReason.no_testnet_price` | No fresh testnet price for {coin} right now. | ตอนนี้ไม่มีราคา testnet ล่าสุดของ {coin} |
| `g.plant.tnReason.testnet_disabled` | Testnet trading is not enabled on this server. | เซิร์ฟเวอร์นี้ไม่ได้เปิดการเทรด testnet |
| `g.plant.tnReason.busted` | This bean is busted. | ถั่วนี้หมดตัวแล้ว |
| `g.plant.tnReason.bean_bound` | You already have a bot on this bean. | คุณมีบอทบน ถั่วนี้อยู่แล้ว |
| `g.plant.tnReason.coin_bound` | You already have a bot on {coin}. | คุณมีบอทบน {coin} อยู่แล้ว |
| `g.plant.tnReason.stale` | {coin}'s price is stale; planting waits for fresh prices. | ราคาของ {coin} เก่าเกินไป รอราคาล่าสุดก่อนปลูก |
| `g.plant.tnReason.thin_book` | The testnet book for {coin} is too thin for this size within 1% (≈ {depth} available). Try less water. | สภาพคล่องของ {coin} บน testnet ไม่พอสำหรับขนาดนี้ในช่วง 1% (มีประมาณ {depth}) ลองลดน้ำลง |
| `g.plant.tnReason.agent_expiring` | Your API wallet expires within a day. Replace it in Settings first. | API wallet ของคุณจะหมดอายุภายในหนึ่งวัน โปรดเปลี่ยนในการตั้งค่าก่อน |
| `g.plant.tnReason.halted` | The field is burned. Re-arm it first. | ไร่ถูกเผาแล้ว โปรดเปิดใช้งานแปลงอีกครั้งก่อน |

#### 9.7.2 Code keys (`g.err.<code>`, `g.note.<note_code>`; P0)

Every machine code a player can receive has a key. "→ `key`" means the code reuses an existing key (the parity test
accepts an alias). Variables come from the response body or the event (`{time}` is formatted from
`retry_after_s`).

| Key | EN | TH |
|---|---|---|
| `g.err.bad_request` | That request was not valid. | คำขอนี้ไม่ถูกต้อง |
| `g.err.bad_username` | → `g.gate.usernameHint` | → `g.gate.usernameHint` |
| `g.err.weak_password` | → `g.gate.weak` | → `g.gate.weak` |
| `g.err.bad_address` | That is not a 0x… address of 42 characters. | นี่ไม่ใช่ที่อยู่ 0x… ความยาว 42 ตัวอักษร |
| `g.err.bad_key_format` | → `g.tn.err.format` | → `g.tn.err.format` |
| `g.err.confirm_required` | Type the confirmation word exactly. | พิมพ์คำยืนยันให้ตรงทุกตัวอักษร |
| `g.err.invalid_json` | The garden could not read that request. Reload the page. | สวนอ่านคำขอนี้ไม่ได้ โปรดโหลดหน้าใหม่ |
| `g.err.query_params_not_allowed` | → `g.err.invalid_json` | → `g.err.invalid_json` |
| `g.err.auth_required` | → `g.gate.ended` | → `g.gate.ended` |
| `g.err.session_expired` | → `g.gate.ended` | → `g.gate.ended` |
| `g.err.bad_credentials` | → `g.gate.badLogin` | → `g.gate.badLogin` |
| `g.err.csrf` | This page is out of date. Reload it and try again. | หน้านี้ล้าสมัยแล้ว โปรดโหลดใหม่แล้วลองอีกครั้ง |
| `g.err.forbidden` | You are not allowed to do that. | คุณไม่มีสิทธิ์ทำสิ่งนี้ |
| `g.err.session_required` | Sign in as an admin in the browser to do that. | ต้องเข้าสู่ระบบในฐานะผู้ดูแลระบบผ่านเบราว์เซอร์จึงจะทำได้ |
| `g.err.account_disabled` | This account is disabled. Contact the operator. | บัญชีนี้ถูกปิดใช้งาน โปรดติดต่อผู้ดูแลระบบ |
| `g.err.signup_closed` | → `g.gate.closed` | → `g.gate.closed` |
| `g.err.not_found` | That no longer exists. | สิ่งนี้ไม่มีอยู่แล้ว |
| `g.err.accounts_disabled` | This server runs without accounts. | เซิร์ฟเวอร์นี้ทำงานแบบไม่มีบัญชีผู้ใช้ |
| `g.err.conflict` | That conflicts with the garden's current state. Refresh and try again. | ขัดกับสถานะปัจจุบันของสวน โปรดรีเฟรชแล้วลองใหม่ |
| `g.err.halted` | → `g.plant.tnReason.halted` | → `g.plant.tnReason.halted` |
| `g.err.not_tradeable` | This bean cannot be planted right now. | ตอนนี้ปลูก bean นี้ไม่ได้ |
| `g.err.caps` | That is over your garden's limits ({detail}). | เกินขีดจำกัดของสวนคุณ ({detail}) |
| `g.err.stale` | → `g.plant.tnReason.stale` | → `g.plant.tnReason.stale` |
| `g.err.username_unavailable` | → `g.gate.taken` | → `g.gate.taken` |
| `g.err.already_connected` | This garden is connected to another testnet account. Disconnect it first. | สวนนี้เชื่อมต่อกับบัญชี testnet อื่นอยู่ โปรดยกเลิกการเชื่อมต่อก่อน |
| `g.err.agent_in_use` | → `g.tn.err.inUse` | → `g.tn.err.inUse` |
| `g.err.account_in_use` | → `g.tn.err.inUse` | → `g.tn.err.inUse` |
| `g.err.has_open_testnet_bots` | You still have {n} testnet bots. Close them first, or choose "close my testnet bots first". | คุณยังมีบอท testnet {n} ตัว โปรดปิดก่อน หรือเลือก "ปิดบอท testnet ก่อน" |
| `g.err.testnet_positions_open` | → `g.tn.disconnectForce` | → `g.tn.disconnectForce` |
| `g.err.testnet_needs_accounts` | Testnet needs a server with accounts. | testnet ต้องใช้เซิร์ฟเวอร์ที่มีระบบบัญชี |
| `g.err.too_soon` | Not yet. Try again in {time}. | ยังไม่ได้ ลองใหม่ใน {time} |
| `g.err.not_connected` | → `g.plant.tnReason.not_connected` | → `g.plant.tnReason.not_connected` |
| `g.err.credential_revoked` | → `g.plant.tnReason.credential_revoked` | → `g.plant.tnReason.credential_revoked` |
| `g.err.agent_expiring` | → `g.plant.tnReason.agent_expiring` | → `g.plant.tnReason.agent_expiring` |
| `g.err.unlisted_testnet` | → `g.plant.tnReason.unlisted_testnet` | → `g.plant.tnReason.unlisted_testnet` |
| `g.err.delisted_testnet` | → `g.plant.tnReason.delisted_testnet` | → `g.plant.tnReason.delisted_testnet` |
| `g.err.busted` | → `g.plant.tnReason.busted` | → `g.plant.tnReason.busted` |
| `g.err.bean_bound` | → `g.plant.tnReason.bean_bound` | → `g.plant.tnReason.bean_bound` |
| `g.err.coin_bound` | → `g.plant.tnReason.coin_bound` | → `g.plant.tnReason.coin_bound` |
| `g.err.leverage` | → `g.plant.tnReason.leverage` | → `g.plant.tnReason.leverage` |
| `g.err.no_testnet_price` | → `g.plant.tnReason.no_testnet_price` | → `g.plant.tnReason.no_testnet_price` |
| `g.err.testnet_caps` | → `g.plant.tnReason.testnet_caps` | → `g.plant.tnReason.testnet_caps` |
| `g.err.insufficient_testnet_balance` | → `g.plant.tnReason.insufficient_testnet_balance` (+ the faucet link) | → `g.plant.tnReason.insufficient_testnet_balance` |
| `g.err.thin_book` | → `g.plant.tnReason.thin_book` | → `g.plant.tnReason.thin_book` |
| `g.err.divergence_ack` | Tick the box to confirm you understand the price difference. | ติ๊กช่องเพื่อยืนยันว่าคุณเข้าใจความต่างของราคา |
| `g.err.body_too_large` | That request was too large. | คำขอนี้ใหญ่เกินไป |
| `g.err.unsupported_media_type` | → `g.err.csrf` | → `g.err.csrf` |
| `g.err.misdirected` | → `g.err.csrf` | → `g.err.csrf` |
| `g.err.seed_phrase` | → `g.tn.err.seed` | → `g.tn.err.seed` |
| `g.err.master_key` | → `g.tn.err.master` | → `g.tn.err.master` |
| `g.err.mainnet_key` | → `g.tn.err.mainnet` (`{role}` from `sub_reason`) | → `g.tn.err.mainnet` |
| `g.err.not_agent` | → `g.tn.err.notAgent` | → `g.tn.err.notAgent` |
| `g.err.agent_mismatch` | → `g.tn.err.mismatch` | → `g.tn.err.mismatch` |
| `g.err.agent_expired` | → `g.tn.err.expired` | → `g.tn.err.expired` |
| `g.err.abstraction_unsupported` | → `g.tn.err.abstraction` | → `g.tn.err.abstraction` |
| `g.err.no_testnet_funds` | This testnet account has no funds, so Hyperliquid will not keep its API wallet. Get test USDC first (see the faucet note). | บัญชี testnet นี้ไม่มีเงิน Hyperliquid จึงไม่เก็บ API wallet ไว้ โปรดรับ USDC ทดสอบก่อน (ดูหมายเหตุเรื่อง faucet) |
| `g.err.signer_mismatch` | Your wallet signed with a different address than the account you entered. | กระเป๋าของคุณลงนามด้วยที่อยู่ที่ต่างจากบัญชีที่คุณกรอก |
| `g.err.rate_limited` | → `g.gate.rate` | → `g.gate.rate` |
| `g.err.testnet_error` | Hyperliquid testnet returned an error. Try again later. | Hyperliquid testnet ตอบกลับด้วยข้อผิดพลาด โปรดลองใหม่ภายหลัง |
| `g.err.testnet_disabled` | → `g.plant.tnReason.testnet_disabled` | → `g.plant.tnReason.testnet_disabled` |
| `g.err.testnet_down` | → `g.tn.err.down` | → `g.tn.err.down` |
| `g.err.kill_switch` | → `g.plant.tnReason.kill_switch` | → `g.plant.tnReason.kill_switch` |
| `g.err.testnet_capacity` | → `g.tn.err.capacity` | → `g.tn.err.capacity` |
| `g.err.busy` | The garden is busy. Try again in a few seconds. | สวนกำลังยุ่ง โปรดลองใหม่ในอีกไม่กี่วินาที |
| `g.err.server_restarting` | → `g.err.restarting` | → `g.err.restarting` |
| `g.err.signup_busy` | Many new gardens are being made right now. Try again in {time}. | ตอนนี้มีการสร้างสวนใหม่จำนวนมาก โปรดลองใหม่ใน {time} |
| `g.err.mainnet_check_unavailable` | → `g.tn.err.mainnetCheck` | → `g.tn.err.mainnetCheck` |
| `g.err.transport` | Could not reach Hyperliquid testnet; checking whether the order arrived. | ติดต่อ Hyperliquid testnet ไม่ได้ กำลังตรวจสอบว่าคำสั่งไปถึงหรือไม่ |
| `g.err.ip_rate_limited` | Hyperliquid testnet is busy; waiting a few seconds. | Hyperliquid testnet มีคำขอมากเกินไป กำลังรอสักครู่ |
| `g.err.client_error` | The exchange refused the order format. The operator has been alerted. | ตลาดปฏิเสธรูปแบบคำสั่ง ผู้ดูแลระบบได้รับแจ้งแล้ว |
| `g.err.address_rate_limited` | Your testnet account has used up its request allowance; waiting. | บัญชี testnet ของคุณใช้โควตาคำขอหมดแล้ว กำลังรอ |
| `g.err.address_budget_low` | Your testnet account has only {n} exchange requests left; bots will stop opening below 50. | บัญชี testnet ของคุณเหลือคำขอไปยังตลาดเพียง {n} ครั้ง บอทจะหยุดเปิดสถานะเมื่อเหลือต่ำกว่า 50 |
| `g.err.nonce` | The order was sent twice by mistake and the duplicate was refused; checking the result. | คำสั่งถูกส่งซ้ำโดยไม่ตั้งใจและตลาดปฏิเสธฉบับซ้ำ กำลังตรวจสอบผล |
| `g.err.signature_mismatch` | Testnet orders are paused for everyone while the operator fixes a signing problem. | การส่งคำสั่ง testnet หยุดชั่วคราวสำหรับทุกคนระหว่างที่ผู้ดูแลระบบแก้ปัญหาการลงนาม |
| `g.err.agent_unknown` | → `g.tn.err.revoked` | → `g.tn.err.revoked` |
| `g.err.no_deposit` | Your testnet account has no funds for this order. Get test USDC first. | บัญชี testnet ของคุณไม่มีเงินพอสำหรับคำสั่งนี้ โปรดรับ USDC ทดสอบก่อน |
| `g.err.min_notional` | Below the $10 minimum order; waiting until the size changes. | ต่ำกว่าขั้นต่ำ $10 รอจนกว่าขนาดจะเปลี่ยน |
| `g.err.insufficient_margin` | Not enough free margin on testnet for this order. | มาร์จินว่างบน testnet ไม่พอสำหรับคำสั่งนี้ |
| `g.err.ioc_no_match` | No match on the testnet book within the price band; retrying. | ไม่มีคำสั่งรับบน testnet ในช่วงราคาที่กำหนด กำลังลองใหม่ |
| `g.err.reduce_only` | The position changed before the close arrived; re-checking. | สถานะเปลี่ยนก่อนคำสั่งปิดไปถึง กำลังตรวจสอบใหม่ |
| `g.err.price_band` | The testnet price is too far from its reference price right now; retrying next minute. | ราคา testnet ห่างจากราคาอ้างอิงมากเกินไปตอนนี้ จะลองใหม่ในนาทีถัดไป |
| `g.err.tick` | The exchange refused the price format. The operator has been alerted. | ตลาดปฏิเสธรูปแบบราคา ผู้ดูแลระบบได้รับแจ้งแล้ว |
| `g.err.leverage_rejected` | The exchange refused the leverage setting. | ตลาดปฏิเสธการตั้งค่าเลเวอเรจ |
| `g.err.oi_cap` | {coin} is at its open-interest cap on testnet; retrying next minute. | {coin} บน testnet ถึงเพดาน open interest แล้ว จะลองใหม่ในนาทีถัดไป |
| `g.err.rejected_other` | The exchange refused the order (see details). | ตลาดปฏิเสธคำสั่ง (ดูรายละเอียด) |
| `g.err.below_min_order` | → `g.err.min_notional` | → `g.err.min_notional` |
| `g.note.liquidated_testnet` | liquidated on testnet | ถูกบังคับปิดสถานะ (liquidate) บน testnet |
| `g.note.external_close` | closed outside the garden | ถูกปิดจากนอกสวน |
| `g.note.position_drift` | position drift: the exchange holds {exch} {coin}, the bot expected {exp} | สถานะไม่ตรง: ตลาดถือ {exch} {coin} แต่บอทคาดว่า {exp} |
| `g.note.credential_revoked` | API wallet no longer usable | API wallet ใช้ไม่ได้แล้ว |
| `g.note.kill_switch` | paused by the operator (testnet) | ผู้ดูแลระบบหยุดชั่วคราว (testnet) |
| `g.note.leverage_rejected` | leverage refused by the exchange | ตลาดปฏิเสธเลเวอเรจ |
| `g.note.insufficient_margin_repeat` | paused after 3 orders failed for margin | หยุดหลังคำสั่งล้มเหลวเพราะมาร์จิน 3 ครั้ง |
| `g.note.agent_expiring` | API wallet about to expire; replace it to resume | API wallet ใกล้หมดอายุ เปลี่ยนใหม่เพื่อให้ทำงานต่อ |
| `g.note.inactive` | paused after {days} days without a visit | หยุดหลังไม่ได้เข้ามา {days} วัน |
| `g.note.mainnet_key` | key refused: it is known on mainnet | คีย์ถูกปฏิเสธ: มีอยู่บน mainnet |
| `g.note.account_moved` | the testnet account was connected to another garden | บัญชี testnet นี้ถูกเชื่อมต่อกับสวนอื่นแล้ว |
| `g.note.fills_beyond_horizon` | some exchange fills are too old to confirm; numbers stay estimated (≈) | การจับคู่บางรายการเก่าเกินกว่าจะยืนยันได้ ตัวเลขจึงยังเป็นค่าประมาณ (≈) |
| `g.note.no_deposit` | → `g.err.no_deposit` | → `g.err.no_deposit` |

### 9.8 "Really playable" interaction QA (P0 unless marked; owned by WP5; each item gets a Node test or a scripted browser check)

| ID | Check | Pass criterion |
|---|---|---|
| QA-01 | Every landmark is clickable **and tappable** | In the default framing at **1280×800, 1920×1080 and 390×844**, `picker.pickAt(project(anchor))` returns the landmark id for `stall, barn, mailbox, signpost, board, firepit, pip, windmill, tower, pond, silo, crates, compost` (and `sundial` in sim). **Each landmark's pick proxy projects to a screen box ≥ 44×44 CSS px at 390×844** (never below 24 px, WCAG 2.5.8) and lies outside the HUD safe-area insets; any proxy that fails is enlarged (proxies are invisible, so this changes no art). A Node test with a headless camera covers the projection, the box size and the raycast. A `?debug=pick` overlay draws the proxies for manual checks. |
| QA-02 | Each click opens the right thing | stall → catalogue (spectator: read-only cards + `g.gate.signInToPlant`); barn → money popover (both ledgers); mailbox → diary; signpost → mode popover, **or the gate when signed out**; board → market board; firepit → burn confirm (signed in) or the gate. **Spectator:** barn, pond, tower, silo, crates and compost show `g.lm.signInToSee` with a Sign in action (never "account value —"); the mailbox opens the global diary with `g.diary.signIn` as its first line. Tested through the `ui:landmark` bus routing. |
| QA-03 | Plots are clickable | an empty plot → plant flow (signed out → gate); a planted plot → inspector. Both by tap and by keyboard (dock row Enter). |
| QA-04 | **No empty inspector after harvest** | When the inspected bot closes (`bot_closed`), the inspector switches to the empty-plot card `g.insp.emptyAfter` (coin, harvested/pulled amount with sign, glyph and colour) plus `g.insp.plantHere`. It is never a blank panel. Also covered: (a) a bot opened through `openBot` from the list or the diary (no slot) shows `g.insp.emptyAfterNoPlot` with the coin and result, never "Plot —"; (b) a **testnet** bot in the closing state shows `g.insp.closing` with the actions replaced, and a failed flatten shows `g.insp.closingFailed`; (c) `bot_closed {confirmed:false}` shows `≈` and switches to the confirmed number on `bot_fill_confirmed` without replaying the effect. Unit tests drive the store transitions. |
| QA-05 | **Fruit silhouettes read** | In Node, each ripe fruit's silhouette is rasterized from the default camera into a 32×32 mask. Among crops that **share a builder** (`groundRosette`: SUI, ZEC, PUMP; `vine`: HYPE, LINK, VVV, beanstalk; `stalk`: SOL, DOGE; `hangingBush`: ETH, AVAX; `bush`: ARB, TIA) the pairwise mask IoU is < 0.8. Each fruit projects to ≥ 6 px at **390×844 and 1280×800**, on High and Medium. On Low, fruit gets an outline at the selected tier. |
| QA-06 | **Default camera framing** | The GAME-DESIGN §2.5 list (whole field, stall, barn, tower, pond, front of the fire pit and mailbox) is inside the safe area at the three viewports, with HUD safe areas applied, **including the gate panel or bottom sheet** for a first-time spectator. A Node test projects the landmark bounding spheres. |
| QA-07 | **Low-tier triangles** | With 10 fully grown crops, `renderer.info.render.triangles` is ≤ 80k on Low, ≤ 150k on Medium and ≤ 250k on High (`?debug=1`). Grass and decor decimate on Low. A Node estimate test sums the geometry builders. |
| QA-08 (P1) | Keyboard path to every landmark | A "Places" list (the help panel and the **`G`** key, "go to place"; `L` stays the List view) focuses each landmark and opens it with Enter. The focus ring is visible. `g.help.panels` (EN/TH) and the `main.js` shortcut table are updated. |
| QA-09 | Sign-up to first plant ≤ 60 s | A scripted flow: gate → create → stall → first card *Plant…* → *Plant & water $100* needs ≤ 5 clicks after sign-up, with no dead ends. |
| QA-10 | Phone 360×780 and 390×844 | The gate (bottom sheet), account items in ⋯ More, testnet panel and plant dialog fit with 16 px gutters and no horizontal page scroll. Inputs are ≥ 16 px (no iOS zoom). **The top HUD** fits in **TH** at 360 and 390 px in the worst states: (a) spectator with the Sign in chip; (b) connected + testnet down + kill switch on. No overflow, and the words PAPER and TESTNET both stay visible (J9). |
| QA-11 | Reconnects | After a server restart: the SSE resumes with `Last-Event-ID`; `server_restart` → toast → a full refresh, with no duplicate diary lines. After sign-in, the stream is reopened (user frames arrive within 5 s). |
| QA-12 | Two tabs, two players | Tab A (player A) never shows player B's bots, diary lines or SSE frames. Covered by the multi-user server test and a scripted browser check. |
| QA-13 | Spectator never errors | No 401 noise in the console as a spectator. User queries are not called. The QA-02 spectator rows hold. |
| QA-14 | Testnet pending loops | A testnet plant shows the pending loop until `bot_sync done` / `bot_fill`. On a failure: dust puff + inline **localized** error; the plot stays planted (the bot exists) with an amber note; `fill_state` `partial`/`unfilled` show `g.insp.tnFilled` / `g.insp.tnUnfilled`. |
| QA-15 | Venue visible everywhere | A testnet bot shows `TESTNET` in its chip, dock row, inspector title, confirm dialogs, diary lines and the 3D pennant, and its mark line says `Hyperliquid TESTNET` / "Testnet mid", never the paper footer. A paper bot shows `PAPER` in the inspector and the confirms. |
| QA-16 | Halt and re-arm | Burn → charred field, plant disabled with a reason. Re-arm appears after 60 s; it needs REARM typed, and the field becomes plantable. In accounts mode the halted plot, shelf and plant dialog show the re-arm countdown or button, never "restart the server". |
| QA-17 (P1) | Admin panel | Kill switch toggles; the badge changes for all players within 5 s (`kill_switch` event). |
| QA-18 | **Testnet UI against the double** | With `npm run accounts:double` (§11.1), a scripted browser run at 1280×800 and 390×844, in EN and TH: sign-up → connect (each connect error code shows its own key) → testnet plant → pending loop → provisional → confirmed fee → partial fill → `ioc_no_match` → insufficient balance (with the faucet link) → testnet-down badge → harvest closing state → drift card → revoked banner → kill-switch badge → Replace API wallet → expiry warning. |
| QA-19 | No dead-end copy | In accounts mode, no rendered string outside admin views contains "restart" or "รีสตาร์ท", and no string mentions a command token (`err.auth`). Every §8.7 kind maps to a non-null localized diary line. |
| QA-20 | Key field is not a password | Manual, Chrome and Safari: after a successful connect, the browser does not offer to save a password, and the gate's login fields are never autofilled with the key (§9.3). |
| QA-21 | Errors are localized | For every code in §8.9, §6.9 and §8.5 `note_code`, `errText({code})` and `diary.lineFor` return a non-empty string in EN and TH (part of the i18n parity test). |

---

## 10. Deployment and operations (owned by WP1, with WP4 for HTTP health/headers)

### 10.1 Topology and why not serverless

- **Recommended:** one container (`bean`) plus Caddy for TLS on a small VM (2 vCPU, 2–4 GB RAM, 20 GB SSD,
  persistent volume at `/data`). Fly.io, Railway or Render work with **one instance** and a **persistent volume**:
  the platform edge terminates TLS, and Caddy is not needed there.
- **Serverless (Vercel/Netlify functions, Lambda) is unsuitable:**
  - The engine is a long-running, stateful process: a minute scheduler, 5 s pollers, ~3000 beans with 14 days of
    bars in memory, and live marks.
  - Functions are short-lived, time-limited and scaled horizontally. That would split state, duplicate ticks,
    break per-agent nonce sequencing, and could **double-send orders**.
  - Functions have no persistent local disk for SQLite.
  - Functions cannot hold thousands of open SSE streams.
- **Never run 2+ replicas.** `fly.toml`/Render/Railway must pin `min = max = 1` and disable auto-stop and scale to
  zero.
- **No persistent volume (Render free):** §10.8 keeps the durable state in a private Supabase Storage bucket instead.

### 10.2 Files (WP1 creates them at the repo root)

**`Dockerfile`:**
```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:24.19.0-bookworm-slim AS base        # pin by digest in CI (@sha256:…)
ENV NODE_ENV=production NODE_OPTIONS=--disable-proto=throw UV_THREADPOOL_SIZE=8
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY web ./web
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=8420 BEAN_DATA_DIR=/data
EXPOSE 8420
VOLUME ["/data"]
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/main.js", "--auth", "accounts"]
```
- The mode is passed **explicitly** on the command line, so an empty or overridden `BEAN_AUTH` cannot drop the
  image into none mode. (None mode would also refuse to start with `HOST=0.0.0.0` from the env, §2.3.)
- The health check runs as a separate `node -e` process; the egress guard (§1.2) lives only in the server process
  and does not apply to it. It calls `127.0.0.1`, which `hostOk` exempts for `/readyz`.
- The image contains no `test/` directory (`.dockerignore`), so `--testnet-double` cannot load the double in
  production even if the flag were passed; the flag is refused there anyway (§11.1).

**`.dockerignore`:** `node_modules`, `data`, `reference`, `test`, `.claude`, `*.md` (except `README.md`), `.env*`,
`secrets/`.

**`.gitignore`** (WP1 owns it; today it lists only `node_modules/`, `data/`, `*.log`): add `.env`, `.env.*`,
`!.env.example`, `secrets/`.

**`docker-compose.yml`:**
```yaml
services:
  bean:
    build: .
    image: bean-garden:${BEAN_VERSION:-0.3.0}
    restart: unless-stopped
    env_file: .env                     # NON-secret settings only (PUBLIC_ORIGIN, TRUST_PROXY, TESTNET_ENABLED, …)
    environment:
      BEAN_MASTER_KEY_FILE: /run/secrets/bean_master_key
      ADMIN_TOKEN_FILE: /run/secrets/admin_token
    secrets: [ bean_master_key, admin_token ]
    volumes: [ "bean-data:/data" ]
    expose: [ "8420" ]                 # never `ports:` — Docker publishing bypasses host firewalls (§4.5)
    stop_grace_period: 30s
    read_only: true
    tmpfs: [ "/tmp" ]
    security_opt: [ "no-new-privileges:true" ]
    cap_drop: [ "ALL" ]
    ulimits: { core: 0 }               # a crash never writes a core dump that could hold a decrypted key
  caddy:
    image: caddy:2.8.4
    restart: unless-stopped
    ports: [ "80:80", "443:443", "443:443/udp" ]
    environment: [ "DOMAIN=${DOMAIN}" ]
    volumes: [ "./deploy/Caddyfile:/etc/caddy/Caddyfile:ro", "caddy-data:/data", "caddy-config:/config" ]
    depends_on: [ bean ]
secrets:
  bean_master_key: { file: ./secrets/bean_master_key }   # chmod 600; never committed (.gitignore)
  admin_token:     { file: ./secrets/admin_token }
volumes: { bean-data: {}, caddy-data: {}, caddy-config: {} }
```
Secrets reach the container as files under `/run/secrets/`, so they are not in `docker inspect` or in the
container's initial environment. The process deletes every secret env var it reads (§5.1).

**`deploy/Caddyfile`:**
```
{$DOMAIN} {
	reverse_proxy bean:8420 {
		flush_interval -1                       # SSE: flush immediately
		header_up X-Forwarded-Proto {scheme}
		header_up -Fly-Client-IP                # never pass client-supplied single-IP headers through
		header_up -CF-Connecting-IP
		header_up -X-Real-IP
		header_up -True-Client-IP
	}
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}
	request_body { max_size 128KB }
}
```
- Do not add `encode`. Node already gzips static files, and SSE must not be buffered.
- Caddy (≥ 2.5) ignores a client-supplied `X-Forwarded-For` unless the client is in its `trusted_proxies`, and sets
  it to the real peer, so `TRUST_PROXY=1` (the rightmost hop) is correct for **Caddy directly on the internet**.
- **With a CDN in front of Caddy** (for example Cloudflare), configure Caddy's global `servers { trusted_proxies
  static <CDN ranges> }` so it keeps the CDN's XFF; otherwise every player appears as a few CDN addresses and the
  per-IP limits lock everyone out. `admin_status.client_ip.buckets_1h` shows this (§4.5).

**`deploy/fly.toml`** (alternative):
- `[http_service] internal_port=8420, force_https=true, auto_stop_machines="off", min_machines_running=1`;
- `[[mounts]] source="bean_data" destination="/data"`;
- `[checks]` a GET on `/readyz`;
- env `CLIENT_IP_HEADER=fly-client-ip` (the Fly edge sets it; the Fly proxy connects from a private address inside
  `TRUSTED_PROXY_CIDRS`, so the header is honoured only from it);
- secrets with `fly secrets set` (they arrive as env vars; §5.1 explains the accepted residual).

**`server/admin-cli.js`** (WP1): the operator tool of §4.4, run inside the container.

**`package.json` scripts added:**
- `"accounts": "node server/main.js --auth accounts --public-origin http://localhost:8420"` (local multi-user,
  HTTP cookies);
- `"accounts:double": "node server/main.js --auth accounts --public-origin http://localhost:8420 --feed hyperliquid --testnet-double"`
  (the testnet UI against the in-process double, §11.1; refused when `NODE_ENV=production`);
- `"keygen": "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""`;
- `"admin": "node server/admin-cli.js"`.

Engines: `"node": ">=22.16"`. Version `0.3.0`.

### 10.3 Environment variables (`.env.example`)

Secrets (**marked S**) are delivered as files (`*_FILE`) in compose; the plain variable is accepted for platforms that
only offer env secrets. Every secret variable is deleted from `process.env` after it is read.

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `BEAN_AUTH` / `--auth` | `none` | – | exactly `none` or `accounts`. Set-but-empty or anything else → exit 2. |
| `PORT` / `--port` | 8420 | – | listen port |
| `HOST` / `--host` | 127.0.0.1 | – | bind address. The `HOST` env var is read **only in accounts mode**; in none mode only `--host` counts, and a non-loopback `HOST` env var exits 2. |
| `PUBLIC_ORIGIN` / `--public-origin` | – | **accounts** | e.g. `https://bean.example.com`. Origin/Host checks; `__Host-` Secure cookie when https. |
| `TRUST_PROXY` / `--trust-proxy` | 0 | behind a proxy | number of proxy hops; honoured only when the socket peer is in `TRUSTED_PROXY_CIDRS` (§4.5) |
| `TRUSTED_PROXY_CIDRS` | `127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fdaa::/16` | – | peers whose forwarding headers are believed |
| `CLIENT_IP_HEADER` | – | – | optional single header (e.g. `fly-client-ip`), honoured only from a trusted peer |
| `BEAN_DATA_DIR` / `--data` | `./data` | – | state directory (absolute paths allowed) |
| `BEAN_FEED` / `--feed` | `hyperliquid` | – | `hyperliquid` \| `sim` |
| S `BEAN_MASTER_KEY_FILE` / `BEAN_MASTER_KEY` | – | **if testnet** | 32 bytes base64 (§5.1). Never a CLI flag. |
| S `BEAN_MASTER_KEYS_OLD_FILE` / `BEAN_MASTER_KEYS_OLD` | – | rotation (P1) | comma list of old keys (§5.2) |
| `TESTNET_ENABLED` | 0 | – | 1 enables the testnet venue (needs the master key and the real feed) |
| `TESTNET_MAX_ACTIVE_USERS` | 40 | – | §6.8 |
| `TESTNET_BUDGET` | 800 | – | testnet weight per 60 s (info + exchange) |
| `INACTIVITY_DAYS` | 14 | – | §4.6 step 9 |
| `ADMIN_USERNAMES` | – | – | comma list of **existing** users promoted to admin at boot (never at sign-up, §4.6) |
| S `ADMIN_BOOTSTRAP_CODE_FILE` / `ADMIN_BOOTSTRAP_CODE` | generated into `<data>/admin-bootstrap.txt` (0600) | – | first-admin sign-up code (§4.6); never printed |
| S `ADMIN_TOKEN_FILE` / `ADMIN_TOKEN` | – | – | accounts mode only: ≥ 32 visible ASCII chars; Bearer for admin ops only, from direct loopback (§4.4) |
| `ADMIN_TOKEN_REMOTE` | 0 | – | 1 also accepts the Bearer token through the proxy (weaker; for external monitoring) |
| S `BEAN_API_TOKEN` / `--token` | – | – | **none mode only** (as today). Refused in accounts mode (exit 2). |
| `SIGNUP_MODE` | `open` | – | `open` \| `invite` (P1) \| `closed` |
| `SIGNUP_MAX_PER_HOUR` | 60 | – | global successful sign-ups per hour |
| `SESSION_DAYS` / `SESSION_IDLE_DAYS` | 30 / 7 | – | §4.2 |
| `BACKUP_INTERVAL_H` / `BACKUP_KEEP` | 6 / 28 | – | §10.5 |
| `LOG_FORMAT` | `text` | – | `json` in production |

**Per-topology client-IP settings:**

| Topology | Settings |
|---|---|
| Caddy directly on the internet (compose above) | `TRUST_PROXY=1` (Caddy's peer is in the default CIDRs) |
| CDN → Caddy | Caddy `trusted_proxies` = the CDN's published ranges; keep `TRUST_PROXY=1` |
| Fly.io | `CLIENT_IP_HEADER=fly-client-ip` (`TRUST_PROXY` unused) |
| Render / Railway | `TRUST_PROXY=1`; verify with the §10.7 client-IP check, because their proxy chains are not documented here |
| No proxy (local) | `TRUST_PROXY=0` |

`parseConfig` validation:
- **None mode** (no `--auth` and no `BEAN_AUTH`, or `none`): exit 2 if any accounts-only setting is present
  (`PUBLIC_ORIGIN`, `TRUST_PROXY`, `TRUSTED_PROXY_CIDRS`, `CLIENT_IP_HEADER`, `BEAN_MASTER_KEY(_FILE)`,
  `TESTNET_ENABLED`, `ADMIN_*`, `SIGNUP_MODE`, `INACTIVITY_DAYS`) or if the `HOST` env var is non-loopback. Only
  `BEAN_API_TOKEN`/`--token` is read as the token. The existing `parseConfig` tests pass an explicit `env` without
  these variables and are unaffected.
- **Accounts mode:**
  - `PUBLIC_ORIGIN` is required and must be an absolute http(s) origin with no path. `http:` is allowed only for
    `localhost`/`127.0.0.1`.
  - `TESTNET_ENABLED=1` without a valid master key → exit 2 with a message.
  - `--token` or `BEAN_API_TOKEN` present → exit 2 ("use ADMIN_TOKEN_FILE").
  - `--no-loopback-commands` is rejected as meaningless (loopback is always off).
  - `--testnet-double` is refused unless `PUBLIC_ORIGIN` is `http://localhost…`/`http://127.0.0.1…` and
    `NODE_ENV !== 'production'`; it is also refused together with `TESTNET_ENABLED=1` (the two are exclusive:
    the double **is** the testnet in that mode, §11.1).
- Error messages name the variable, never its value.

### 10.4 Health, headers, shutdown

**Health endpoints:**
- `GET /healthz`: 200 `{ok:true}` while the process runs. No DB and no engine access.
- `GET /readyz`: 200 when warm-up is done, the DB answers `SELECT 1`, the process is not shutting down, and the
  data dir is writable. Otherwise 503 `{ok:false, why}`.
- `GET /api/v1/health`: unchanged.

**Security headers in accounts mode** (static and API), in addition to today's:
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` (only when `PUBLIC_ORIGIN` is https; Caddy also
  sets it);
- `Cross-Origin-Opener-Policy: same-origin`;
- `Cross-Origin-Resource-Policy: same-origin`;
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`;
- CSP `connect-src 'self'` (cross-origin APIs are disabled in accounts mode).
- Everything else in `STATIC_CSP` stays.

**Graceful shutdown** (`SIGTERM`/`SIGINT`; hard deadline 25 s, below `stop_grace_period` 30 s):
1. `shuttingDown = true`. New commands answer `503 server_restarting`. `/readyz` answers 503.
2. Send `event: server_restart` to all streams, then end them. `server.close()`.
3. `engine.stop()`, `testnetMarket.stop()`.
4. `scheduler.drain(10 s)`: in-flight HL requests complete and their results apply. Queued jobs are dropped. The
   **intent** survives in the persisted bot state: a testnet bot with an unfinished flatten that still holds a
   position gets a fresh flatten at boot, after reconcile (§6.11 Restart).
5. `gardens.flush()`. `saveState(JSON)`. `PRAGMA wal_checkpoint(TRUNCATE)`. `db.close()`.
6. `process.exit(0)`.

Open testnet positions stay open during the restart. This is documented in the runbook.

### 10.5 Backups

- **Built-in:** every `BACKUP_INTERVAL_H`, run the **online, asynchronous** `sqlite.backup(db,
  'data/backups/bean-<UTC yyyymmddThhmmZ>.db', {rate: 64})` (Node ≥ 22.16; it copies 64 pages per step and yields
  to the event loop between steps), then copy `state-real.json` beside it. Keep the newest `BACKUP_KEEP`. Also take
  one at the first boot each day. `admin_backup` triggers one now, at most once per 10 min. A synchronous
  `VACUUM INTO` is used **only** for the pre-migration backup at boot, before the server accepts connections.
  T-PERF asserts event-loop p99 < 200 ms during a backup of a DB with 1,000 users × 20k fills.
- **What backups mean for wiped keys:** a backup holds sealed credentials as they were at backup time. A key wiped
  later stays (encrypted) in up to `BACKUP_KEEP × BACKUP_INTERVAL_H` (7 days by default) of local backups and in any
  off-site retention. The disconnect and delete dialogs say so (§9.2, §9.3); the operator's off-site retention should
  match.
- **Off-site (operator):** `rclone`/`restic` of `/data/backups` to object storage, daily. **Never back up the
  master key with the data.** Keep it in the platform secret store or a password manager.
- **Restore:**
  1. Stop the container.
  2. Copy the chosen backup to `/data/bean.db`.
  3. Delete `bean.db-wal` and `bean.db-shm`.
  4. Optionally restore the matching `state-real.json`.
  5. Start. Migrations run, and the reconcile catches testnet positions up. New orders get fresh random cloids
     (§6.6), and `AUTOINCREMENT` ids continue from the restored maximum, so nothing written after the backup point
     can be confused with new rows by `orderStatus`.
- A restore drill is part of the pre-launch checklist.

### 10.6 Upgrades, monitoring, logs

**Upgrades:**
1. `docker compose build && docker compose up -d`.
2. Boot runs migrations, taking a pre-migration backup.
3. Rollback = the previous image tag plus `pre-migration-*.db`.
4. Additive API only, so old tabs keep working. `server_restart` makes them refresh.

**Logs:**
- stdout. `LOG_FORMAT=json` gives `{t, level, msg, op?, status?, ms?, uid?, ip_hash?, code?}`.
- Everything passes the sanitizer (§5.3).
- Docker log rotation: `json-file` with `max-size=10m`, `max-file=5`.

**Monitoring** (`docker compose exec bean npm run -s admin -- status`, or an external pull with
`ADMIN_TOKEN_REMOTE=1`; P2: `/metrics` in Prometheus format). Alerts:

| Signal | Alert when |
|---|---|
| `testnet.weight_60s` | > 90% of the budget for 5 min |
| `testnet.errors_60s` | > 20 |
| testnet state | `down` > 5 min |
| `testnet.signing_halted` | true (**page the operator**: a signing regression, §6.9) |
| mainnet client 429s | any while testnet traffic is high (the hosts may share a limit, K11) |
| `client_ip.buckets_1h` | < 5 while > 50 users were active (proxy misconfiguration, §4.5) |
| alert log lines | `unscoped_user_event`, `egress_denied`, `client_error`, `tick` |
| `kill_switch` | on (informational) |
| `db.last_backup_ms` | older than 2 × interval |
| disk free | < 1 GB |
| `event_loop_p99_ms` | > 200 (`perf_hooks.monitorEventLoopDelay`) |
| engine `feed_state` | `down` > 5 min |
| `/readyz` | failing |

### 10.7 Pre-launch security checklist (every box ticked before a public URL is shared)

1. [ ] `--auth accounts` (in the image `CMD`), `PUBLIC_ORIGIN=https://…`, and the client-IP settings of the
   per-topology table (§10.3). The service is reachable only through Caddy or the edge; port 8420 is not published
   (`expose`, never `ports`).
2. [ ] Secrets: `BEAN_MASTER_KEY` and `ADMIN_TOKEN` are delivered as files (`secrets:` / `*_FILE`) or as platform
   secrets; they are not in the image, the compose file, `.env`, the repo or shell history; `.env`, `.env.*` and
   `secrets/` are in `.gitignore` (verify with `git check-ignore`); the master key is backed up separately.
   `docker inspect bean` shows no secret values.
3. [ ] `ADMIN_TOKEN` is ≥ 32 random chars. An admin exists; `data/admin-bootstrap.txt` has been deleted by the server;
   `docker compose logs bean` contains no bootstrap code.
4. [ ] T-GUARD passes: there is no mainnet exchange URL, the signer is testnet-only, the action allowlist is
   enforced, the egress guard is installed, and every HL fetch uses `redirect:'error'`.
5. [ ] All KATs pass (KAT-1…8, D1, D2, M1–M3, R, A; KAT-U1 before the P1 wallet flow).
6. [ ] Cookies: `__Host-bean_sid` and `__Host-bean_kd`, `Secure`, `HttpOnly`, `SameSite=Lax`, verified in a browser
   over https.
7. [ ] CSRF: a cross-site HTML form POST and a cross-origin `fetch` with `credentials:'include'` both fail (403 or
   415, and no CORS). A POST with credentials in the query string answers `400 query_params_not_allowed`.
8. [ ] Login rate limit and lockout verified. The responses are identical for unknown and known usernames. A
   known-device login still works while the username is locked.
9. [ ] **Client IP:** two clients from different networks land in different rate buckets (`admin_status`
   `client_ip.buckets_1h`), and a request with a spoofed `X-Forwarded-For` or `Fly-Client-IP` header does not change
   its bucket.
10. [ ] Logs scanned after a full test run plus a manual testnet run: no 64-hex strings, base64 runs ≥ 40 chars,
    decimal runs ≥ 60 digits, passwords or seed-like strings (`grep -E '[0-9a-fA-F]{64}'` is empty apart from tx
    hashes, which are allowlisted by the `hash` field name).
11. [ ] The API never returns the key: T-SECRETS scans every response and SSE frame of the integration test.
12. [ ] A DB file copied off the server cannot reveal keys without the master key (T-SECRETS decrypts with the
    wrong key → fails).
13. [ ] The headers (HSTS, CSP, COOP, CORP, nosniff, frame-ancestors) are verified with `curl -I` on `/`,
    `/api/v1/health` and a static JS file.
14. [ ] The SSE stream through Caddy delivers `mids` every ~5 s (no buffering). User frames are isolated (QA-12).
    A spectator `mids` frame has no `bots`/`account` keys.
15. [ ] Backups are created by the online backup, an off-site copy is configured with a retention that matches the
    in-app statement, and a **restore drill** is done on a scratch VM.
16. [ ] Graceful shutdown is tested (`docker compose restart bean`): no lost fills, and in-flight orders are
    resolved at boot.
17. [ ] Kill switch tested on testnet with ≥ 2 players: every testnet bot flattens within 60 s.
18. [ ] `SIGNUP_MODE` is decided (start `invite` or `closed` for a private beta if preferred).
19. [ ] Dependencies: `npm audit --omit=dev` is clean or reviewed, and the lockfile is committed with exact
    versions.
20. [ ] The container runs as user `node`, with a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`
    and `ulimits: core: 0`.
21. [ ] The privacy note (`g.acct.privacy`) and the FAQ (§9.2) are shown in Settings and state the backup retention
    actually configured.
22. [ ] `admin-cli status` works from `docker compose exec`; the Bearer token is refused through the public URL
    (unless `ADMIN_TOKEN_REMOTE=1` was chosen deliberately).

### 10.8 Ephemeral disk: Render free + Supabase Storage (`render.yaml`, `deploy/render/README.md`)

Render's free web services have no persistent disk and sleep after 15 min without inbound traffic. Accounts mode can
then keep its durable files in a **private** Supabase Storage bucket (`server/cloudstore.js` — a zero-dependency REST
client; `server/cloudsync.js` — what and when):

- **Config** (accounts-only; none mode exits 2 on any of them): `SUPABASE_URL` (https origin) and
  `SUPABASE_SERVICE_ROLE_KEY` / `_FILE` (a secret: read once, deleted from env) enable it **together** — one without
  the other exits 2; `CLOUD_STORE_BUCKET` (`bean-garden`), `CLOUD_STORE_PREFIX` (''), `CLOUD_SYNC_SECONDS` (60, 15–3600),
  `CLOUD_EGRESS_BUDGET_MB` (3072 per month), `CLOUD_ALLOW_FRESH` (0/1, for one deliberate boot).
- **Boot:** the bucket must exist and be private (created private when missing; a public bucket → exit 4). Every managed
  file missing locally — the feed's DB, its state JSON, `admin-bootstrap.txt` (unless `ADMIN_BOOTSTRAP_CODE` is set) — is
  downloaded and checked, and only then written atomically (stale `-wal`/`-shm` removed), **before the DB is opened and
  the state is loaded**. Empty bucket → fresh start; any other download failure, a corrupt gzip or a wrong file type →
  exit 4 (starting empty would later overwrite the good copy). The DB or the state "not found" while the bucket shows a
  previous deployment (`lease.json` says a DB was synced, `history/` has hours, or the other file exists) → exit 4 too,
  unless `CLOUD_ALLOW_FRESH=1`. The journal continues after the previous owner's `lease.json` `seq` (+10,000): a seq is
  never reused; older Last-Event-IDs resync. A fresh real start that cannot warm up exits 1 instead of falling back to
  the sim feed (the fallback's accounts would live in a `bean-sim.db` that later boots never restore).
- **Lease:** once listening, the instance writes `lease.json` {instance, started_ms, renewed_ms, interval_s, seq, month,
  month_bytes, synced} unless an instance that started later holds it, renews it on every sync, and re-reads it before
  every DB/state upload and before each renewal. An instance that sees another owner stops uploading and **stands by**:
  it takes the lease back when `lease.json` stays unchanged for 3 intervals + 1 min on its own clock (the owner died —
  e.g. a deploy that took the lease and was then cancelled), and logs an ALERT every 10 min while a live owner keeps it.
  A missing `lease.json` while owning it is retried once, then written again — never a takeover. Every acquisition is
  followed by a full upload; after a takeover it waits until the previous owner's last upload can no longer land
  (`store.maxCallMs`), so a stale late upload is always overwritten.
- **Sync** (serialized): the DB when `total_changes()` moved (online backup → gzip → `db/<file>.gz`) every
  `CLOUD_SYNC_SECONDS`; the state JSON every 2 h when changed (≈ 2–3 MB gzipped, the biggest upload);
  `history/YYYYMMDDHH/` gets server-side copies of both every hour (no egress; newest 48 kept) and the bucket's
  privacy is re-checked (public → every upload stops, ALERT). **Egress pace:** Render Hobby includes 5 GB outbound per month, shared with the players' traffic; a
  non-forced upload goes only while the month stays within `CLOUD_EGRESS_BUDGET_MB` × (elapsed fraction + 5 %) — the DB
  first, the state at least every 12 h — so a big DB widens the loss window instead of suspending the service. The
  generated bootstrap code goes to `admin/admin-bootstrap.txt` while no admin exists and is deleted once one does.
  Failures: logged (first of a streak, then every 10 min) and in `admin_status.cloud`.
- **Replay guard** (`server/live.js`): `gardens.last_tick` is a watermark (always the engine's tick when the row is
  written). A garden loaded with a watermark ahead of a RESTORED engine skips the bars up to it, so an engine state older
  than the DB never re-mirrors bars the bots already traded (no phantom fills).
- **Shutdown:** after gardens flush → state save → checkpoint + close, a final forced sync within what is left of the
  25 s deadline (≤ 20 s). Loss bounds: a crash loses ≤ one sync interval of DB writes (longer only while the egress
  pace holds the DB back); a zero-downtime deploy loses what the old instance wrote after the new one restored. An
  older engine state costs only a longer replay.
- **Egress (§1.2):** `installEgressGuard({storageOrigin})` additionally allows GET/POST/DELETE to exactly
  `<SUPABASE_URL>/storage/v1/…` (canonical URLs, no query/fragment/credentials); the Hyperliquid list is unchanged.
- **Render:** `PORT` from the platform wins over the image's 8420; without `PUBLIC_ORIGIN`, `RENDER_EXTERNAL_URL` is the
  public origin (and a mismatch between the two is an ALERT at boot); `/healthz` answers any Host (§4.4); client IP
  with `TRUST_PROXY=1`, verified by the one-time `[clientip] first request through a trusted proxy …` log line (counts
  and header names only) and §10.7 #9; a proxy peer outside `TRUSTED_PROXY_CIDRS` is reported once
  (`[clientip] proxy peer not in TRUSTED_PROXY_CIDRS …`).

---

## 11. Test plan

### 11.1 Offline fixtures (no network in `npm test`, as today)

- `test/fixtures/hl-testnet-meta.json`: the captured testnet `metaAndAssetCtxs` (trimmed, index alignment kept), the
  2026-10-11 snapshot.
- `test/fixtures/hl-testnet-double.js`, a **mock Hyperliquid testnet**. It is injected as `fetch` and serves
  `/info` and `/exchange`:
  - `/info`: `metaAndAssetCtxs`, `allMids`, `l2Book`, `clearinghouseState` (with `cumFunding`, leverage only on open
    positions), `spotClearinghouseState` (for unified accounts), `userFillsByTime` (**paginated** at 500 per page,
    10,000-fill horizon, fills **without cloid**, optional `liquidation` object, raw `dir` strings including
    non-standard ones), `userFunding`, `orderStatus` (by oid or cloid; the real status strings such as
    `iocCancelRejected`; `unknownOid`), `userRole` (with mixed-case addresses in `data.user`), `extraAgents`,
    `userAbstraction` (all five values), `userRateLimit`, `exchangeStatus`.
  - `/exchange`:
    - verifies each signature by **recovering the signer** (with `@noble/curves`, independent of our signer
      module: it re-implements the digest from §6.4) and checks the signer is an approved agent of a known
      account; a wrong signature is answered the way Hyperliquid does, with "User or API Wallet 0x<recovered> does
      not exist." (a **foreign** address);
    - enforces the nonce rules (100-highest set, window), and can be scripted to **execute an order and then time
      out**, so that the resend meets a nonce error;
    - parses the action with the exact key order (it re-encodes and compares the hash);
    - applies IOC against a configurable book (mid, depth) to produce `filled`/partial/`error`;
    - keeps positions, entry, isolated margin and leverage (new positions default to cross unless `updateLeverage`
      was sent), and generates fills with `tid`, `fee`, `closedPnl`, `startPosition`;
    - answers cancels with the bare string `"success"` and can emit `"waitingForFill"` / `"waitingForTrigger"`.
  - Scriptable faults: timeout, HTTP 5xx, 429, **HTTP 400 with a plain-text body**, a **307 redirect**, each §6.9
    error string, "Must deposit before performing actions. User: <account>", partial fill, `resting` anomaly,
    external position change (drift), liquidation fill, agent revocation, agent expiry, agent pruning when the
    account has no funds, clock skew, `unknownOid`, `signature_mismatch`.
  - It records every request so tests can assert weights and ordering.
- The mainnet double (`hl-double.js`, existing) gains `userRole` (all roles, plus failure and timeout) for the
  mainnet guard.

**`--testnet-double` (dev mode, P0).** `npm run accounts:double` starts the real server in accounts mode with the
testnet venue backed by the **in-process** double: `createTestnet({fetch: double.fetch})`, and the verification's
mainnet `userRole` also answered by the double. There is no network traffic to any Hyperliquid testnet host in this
mode (the double is an injected `fetch`, never a URL). Without a master key, an ephemeral in-memory key is generated
(credentials do not survive a restart). The admin-only `dev_double` op (§8.6) scripts faults from the browser (a small
panel in the Operator view). The flag is refused unless `PUBLIC_ORIGIN` is an `http://localhost` origin and
`NODE_ENV !== 'production'`, and together with `TESTNET_ENABLED=1`; the Docker image has no `test/` directory, so it
cannot load the double at all. QA-18 runs the whole testnet UI against it.

### 11.2 New test files (each offline; all 307 existing tests stay unmodified)

| File | Covers |
|---|---|
| `test/hl-signing.test.js` | KAT-1…8 (KAT-1 asserts the connectionId only), D1, D2, M1–M3, R, A (§6.12); KAT-U1 (P1 gate); `packAction` guards (undefined, float, BigInt, key order); low-s; `r`/`s` padding to 64; `isValidScalar` boundaries (0, 1, n−1, n) without calling noble |
| `test/hl-format.test.js` (T-FMT) | every row of the §6.5 table (parity rows with their stated function and `d`); that `isWirePx` accepts every `fmtPxWire` output for random prices × szDecimals 0..5 (10k cases); sizes never round up; the flatten slippage steps |
| `test/mainnet-guard.test.js` (T-GUARD) | (a) grep `server/` and `web/` for `api.hyperliquid.xyz/exchange` → none; (b) `api.hyperliquid.xyz` appears only in `server/hyperliquid.js` and `server/hl/egress.js`, and only as `/info`; (c) the `exchange.js` URL constant equals testnet and is frozen; (d) a `fetch` spy over the whole integration run: every request to a path ending in `/exchange` has host `api.hyperliquid-testnet.xyz`; (e) the action allowlist refuses `withdraw3`/`usdSend`/… ; (f) `signL1.length === 2`, and source `"b"` is baked in (a KAT-2 testnet vector passes, the mainnet vector does not); (g) the **egress guard** refuses a runtime-concatenated `'https://api.hyperliquid' + '.xyz' + '/exchange'`, any non-POST, and any other host; (h) a redirecting double (307 to another URL) is refused because every HL fetch uses `redirect:'error'`; (i) `HyperliquidClient` throws on a non-`HL_INFO_URL` url without an injected fetch; (j) with `--testnet-double`, zero requests reach any real Hyperliquid host |
| `test/hl-exchange.test.js` | scheduler weights and priorities; 429 back-off; per-user lanes keep nonces monotonic under concurrency; identical-bytes resend on a timeout; **the double executes an order and times out, the resend gets a nonce error, and exactly one order exists** (no re-sign); a first-transmission nonce error gets exactly one fresh-nonce attempt; `orderStatus` resolution (status and `filled_sz` only; prices from fills); string statuses (`"success"`, `"waitingForFill"`, an unknown string → `rejected_other`); HTTP 400 plain text → `client_error`, never resent; a foreign-address "does not exist" → `signature_mismatch` (credentials untouched, signing halted for everyone); our agent's address → `agent_unknown` only after the `userRole` confirm; "Must deposit" naming the account → `no_deposit`, credential stays verified; the error classification table; lane cancel and epoch abort |
| `test/hl-verify.test.js` | §6.7 every branch, in the new order: bad format (not counted against the limit), seed phrase, master key, not an agent, mismatch (with a **mixed-case** `data.user` that must still match), mainnet `user`/`agent`/`vault`/`subAccount` → `422 mainnet_key`, mainnet failure or timeout → `503 mainnet_check_unavailable` with nothing stored, a random key never reaches the mainnet call, expired, expiring soon (warning), unnamed (warning), `portfolioMargin`/`dexAbstraction` refused, **unified** accepted with balances from `spotClearinghouseState`, zero value → `422 no_testnet_funds`, low value → `no_funds` warning, existing positions warning, same-account reconnect → replace (bots kept), revoked row in another garden → take-over with `account_moved`; the **periodic re-check**: a later mainnet hit flattens, wipes the credential, emits `credential_status revoked` and audits |
| `test/testnet-live.test.js` | full lifecycle with the double: create → leverage → IOC → provisional fill → sweep confirms (fee replaced) → per-bar mirror (reduce-only on decrease) → flip (close, leverage, open) → pause flattens (widening slippage on `ioc_no_match`) → resume (leverage resent from flat) → close (`bot_closed` only after the completion sweep, `confirmed:true`; a failed sweep → `confirmed:false` then `bot_fill_confirmed`); `bot_close` while closing sends nothing; partial fill and `fill_state`; min-notional dust; unresolved order + its fill → pending attribution, **no** drift pause; drift → pause, no orders; resume adopts; liquidation detected by the `liquidation` object (and a fill with an unusual `dir` string inserts without error); one garden's bad row does not roll back another's flush (savepoints); pagination across > 500 fills; fills beyond the horizon keep `fees_estimated`; funding: Σ bot totals + funding reconcile to Δ account value within fee tolerance; agent revoked → bots pause + banner event; `no_deposit` → credential kept, plant refused; expiry warnings at −7 d / −1 d, flatten at −30 min, create refused within 24 h; replace API wallet keeps bots; inactivity flattens after 14 days; restart with `pending`/`sent` orders resolved by cloid (`unknownOid` → canceled, executed → applied); catch-up does not trade replayed bars; kill switch flattens everyone; frozen-ratio sizing (HYPE example in §6.11: 10 units × 0.1 × 2.058 → 2.05) |
| `test/auth.test.js` | sign-up/sign-in/out; scrypt format and parameters (**N=32768, r=8, p=3**) and re-hash of older hashes; timing path for unknown users (dummy hash called); one hash in flight per IP; check order (IP → lockout → scrypt); cookie attributes for https vs http; rotation with a 60 s grace; idle and absolute expiry; `logout_all`; a password change revokes sessions and invalidates known-device cookies; lockout and IP limits; **flooding 60,000 distinct IP keys does not reset a locked username**; a known-device cookie bypasses the lockout for its own user only; sign-up enumeration bucket vs creation budget, `503 signup_busy`; **signing up as a name in `ADMIN_USERNAMES` without the bootstrap code gives `409` and no admin**; `ADMIN_USERNAMES` promotes existing users at boot only; **a deleted admin's name cannot be re-registered**; the bootstrap code is written to a 0600 file, never logged, and the file is deleted once an admin exists; **player A revoking B's session `public_id` gets 404 and B's session survives**; **every revocation path closes the matching SSE streams in the same tick**; operator reset: code shown once, wipes the testnet credential, `auth_reset` works once and expires; `login_fail` rows never contain a typed unknown username; disabled account |
| `test/csrf.test.js` | Origin mismatch → 403; missing Origin with `Sec-Fetch-Site: cross-site` → 403; `text/plain` and form content types → 415; Host mismatch → 421; **a POST with a query string → 400 `query_params_not_allowed` before the body is read, and nothing is logged** (`auth_login?password=…`, `testnet_connect?agent_key=…`); Bearer: accepted only from a direct loopback peer without proxy headers (unless `ADMIN_TOKEN_REMOTE=1`), never for user ops, never for `make_admin`; failed Bearer attempts limited and audited; client IP: XFF honoured only from `TRUSTED_PROXY_CIDRS`, a spoofed XFF from a direct peer is ignored, `CLIENT_IP_HEADER` honoured only from a trusted peer, short XFF falls back to the socket; **no state-changing GET** (enumerates OPS) |
| `test/secrets.test.js` (T-SECRETS) | seal/open round trip; AAD binding (row swap fails); tamper → fails; the wrong master key fails; P0 rotation marks foreign-kid rows `key_unavailable` (P1: re-seal with new ivs); every secret env var is deleted after reading; the key never appears in API responses, SSE frames, logs (captured), JSON state or DB text columns (scan for the 64-hex key); the sanitizer redacts a base64 master key, a 43-char session token, a decimal-rendered key and a capitalised, numbered seed phrase pushed through the sensitive-op 500 path; sensitive 500s log only `op`, `err.name` and a code; config errors never echo values; a WAL checkpoint follows every wipe |
| `test/db.test.js` | migrations from empty; re-run is a no-op; a checksum mismatch refuses; the pre-migration backup is created; WAL mode; cascades on user delete; `secure_delete`; `AUTOINCREMENT`: deleting the newest user does not give its uid to the next sign-up; partial credential indexes; retention runs in ≤ 1,000-row batches; the **SQL binding scan** of `server/**` (§3.2) |
| `test/multiuser.test.js` | two or three players on one engine: bots, `live_status`, `live_fills`, `events` and SSE are isolated (A never receives B's `bot_*` or `mids.bots`); **an unscoped `bot_fill` emit throws in accounts mode and is never broadcast**; **a spectator `mids` frame has no `bots`/`account`/`testnet_account` keys**, and `Pulse` refuses such a frame; a `LiveLayer` with `owner` and the raw journal throws; the same coin and bean are allowed across players; one bot per coin per player across venues; per-player halt and re-arm; `garden_reset` (paper only, once per 24 h, testnet untouched, seasons); `beans.tradeable` is per player; spectators get global frames only; replay with `Last-Event-ID` merges global and user records in seq order; **delete the max-uid user while a flatten retry is pending, sign up a new user, and the retry never runs against the new garden** (teardown + epoch) |
| `test/api-accounts.test.js` | every new op: params, auth class, status codes, `code` values (every code is in `ERROR_CODES`); `testnet_status`/`testnet_quote`/`testnet_market`/`me` spend zero HL weight (1,000 calls); none mode unchanged (`404 accounts_disabled`; `testnet_needs_accounts`); strict `--auth` parsing and the none-mode refusals (accounts-only env present, non-loopback `HOST` env, `--token` in accounts mode); `--testnet-double` refusals; index additions |
| `test/perf-gardens.test.js` (T-PERF; runs when `PERF=1`) | the §7.6 budgets with 1,000 gardens × 10 bots and 40 testnet players on the double; the weight ledger never exceeds `TESTNET_BUDGET` over a simulated hour; **2,000 non-reading SSE streams for 10 min keep RSS within budget** (128 KB per stream, 64 MB total) and a signed-in player can still connect; event-loop p99 < 200 ms during an online backup of 1,000 users × 20k fills and during a retention pass |
| `test/game-platform.test.js` | the pure frontend pieces: venue badge text (desktop and the phone combined chip), plant-dialog testnet math against `testnet_quote` fixtures (venue enable rules independent of the stake, clamping, divergence thresholds, slippage line, thin book), gate validation, `errText` code mapping, `diary.lineFor` for every §8.7 kind, i18n parity for every new key **and every code** exported by `catalog.js` and `hl/errors.js`, QA-01/04/05/06/07/19/21 Node checks |

### 11.3 CI gates

1. `npm test` is green with **no network**.
2. The 307 existing tests are unmodified (a diff check against main).
3. T-GUARD and the KATs are required checks.
4. A secret scan on the test logs.

### 11.4 Manual testnet runbook (for the user, with their own testnet key)

Do this on a computer you control. Use test funds only.

**Getting test USDC (read first).** Hyperliquid's faucet (`https://app.hyperliquid-testnet.xyz/drip`, 1,000 mock USDC)
pays only an address that **has deposited on mainnet with the same address**. Email (Privy) logins get different
mainnet and testnet addresses; export the mainnet email wallet into a wallet extension first. Two ways work:
- **(a) Use the mainnet-deposited address as the testnet account.** This is safe for the garden: you paste only a
  **testnet API-wallet key** made on the testnet site, never your wallet's own key or seed phrase, and the garden
  refuses any key that is known on mainnet (§6.7).
- **(b) Fresh testnet address.** Claim the mock USDC on the mainnet-deposited address, then send it on the testnet
  site to a fresh wallet address and use that address as the testnet account. Step R2b records whether this works.
- Without any mainnet-deposited address, testnet cannot be funded; paper is the complete game.

| Step | Action | Record |
|---|---|---|
| R1 | Choose (a) or (b) above. Open `https://app.hyperliquid-testnet.xyz` and connect the wallet you chose as the testnet account. | the address, and (a) or (b) |
| R2 | On the mainnet-deposited address, claim the faucet at `/drip`. Deposit or transfer to perps if the UI asks. | the account value shown |
| R2b | Path (b) only: send the mock USDC to the fresh address on the testnet site; check it arrives and can be used for perps. | whether path (b) works (report it; it decides the FAQ wording) |
| R3 | Testnet site → **API** → create a **named** API wallet `bean-garden` (pick the longest validity), approve it with your wallet, and copy the **private key** (shown once). | agent address, valid-until |
| R4 | On your computer, in PowerShell: `$env:BEAN_MASTER_KEY = (npm run -s keygen)`, `$env:TESTNET_ENABLED = '1'`, then `npm run accounts`. Open `http://localhost:8420`, create a garden with the bootstrap code from `Get-Content data\admin-bootstrap.txt` (so you become admin). | that the file disappears afterwards |
| R5 | Settings → Connect testnet: paste the address and the key → **Verify**. | the `abstraction` value; for a **unified** account, compare the garden's `≈` account value with the testnet site's (risk K1: does spot `total` already include unrealized P&L?) |
| R6 | Plant a **testnet** bot with $20–50 water on BTC or ETH, choosing a bean that is positioned now. Watch the inspector: provisional fill → confirmed fee. Compare with testnet site → Trade history (price, size, fee), Positions (entry, liquidation price, isolated leverage) and Funding history (sign of the funding line). | screenshots of both |
| R7 | Wait for the bean to reduce or close (or pick a bean that changes often). Check that a reduce-only order appears. If a remainder below $10 occurs, note whether the exchange accepted the reduce-only close. | the dust behaviour |
| R8 | **Pause** → the position closes on the testnet site within ~10 s. **Resume** → it re-opens (leverage set again). **Close** → flat, and the bot is harvested or pulled only after the fills are confirmed. | – |
| R9 | Drift test: with a bot open, close the position **manually** on the testnet site. Within a minute the bot pauses with "closed outside the garden"; no order is sent. | – |
| R10 | Restart test: stop the server (Ctrl+C) while a bot holds a position. Start it again. The position is reconciled and nothing is double-sent. | – |
| R11 | Kill switch: as admin, open the Operator panel (or `npm run admin -- kill on "test"`) → kill switch on → every testnet bot flattens → off. | – |
| R12 | Replace test: create a second named API wallet on the testnet site and use **Replace API wallet**; the bots keep running. | – |
| R13 | Disconnect → the key is deleted. Then **revoke both API wallets** on the testnet site (required: the garden's backups keep an encrypted copy for up to 7 days). | – |

Report the R2b/R5/R6/R7 observations back. They close the open questions (§12.5 risks K1, K2, K12).

---

## 12. Work packages (5 engineers, exclusive file ownership)

### 12.1 Ownership

| WP | Owner scope | Files (exclusive) |
|---|---|---|
| **WP1 Platform core and ops** | DB, migrations, auth (passwords, sessions, CSRF, rate limits, users), secrets, admin service, audit, config parsing for new env/flags, deployment files | `server/db/db.js`, `server/db/migrate.js`, `server/db/retention.js`, `server/db/backup.js`, `server/db/migrations/0001_init.sql`, `server/auth/passwords.js`, `server/auth/sessions.js`, `server/auth/csrf.js`, `server/auth/ratelimit.js`, `server/auth/users.js`, `server/auth/common-passwords.txt`, `server/secrets.js`, `server/admin.js`, `server/config.js` (new: env + flag parsing for platform options, strict `--auth`, `_FILE` secrets, imported by `main.js`), `server/admin-cli.js` (new), `server/auth/clientip.js` (new), `Dockerfile`, `.dockerignore`, `.gitignore`, `docker-compose.yml`, `deploy/Caddyfile`, `deploy/fly.toml`, `.env.example`; tests `auth.test.js`, `csrf.test.js`, `secrets.test.js`, `db.test.js` |
| **WP2 Hyperliquid testnet** | everything in §6, including the egress guard and address normalization | `server/hl/*` (§6.1, including `egress.js` and `addr.js`), `server/hyperliquid.js` (**additive only**: the `url === HL_INFO_URL` assertion without an injected fetch, `redirect:'error'`, a queued `userRole(addr)` for the mainnet guard), `test/fixtures/hl-testnet-double.js`, `test/fixtures/hl-testnet-meta.json`, `test/fixtures/hl-double.js` (additive: mainnet `userRole` for the guard; existing behaviour unchanged); tests `hl-signing`, `hl-format`, `hl-exchange`, `hl-verify`, `mainnet-guard` |
| **WP3 Gardens and engine glue** | multi-tenant live layer, testnet venue adapter, repo, journal scoping (fail-closed), population venue override, main wiring (`wireAccounts`, egress guard install, `--testnet-double`), teardown, seasons, expiry and inactivity sweeps, and shutdown | `server/live.js`, `server/garden/gardens.js`, `server/garden/testnet-venue.js`, `server/garden/repo.js`, `server/garden/credentials.js` (the `withSigner` bridge: WP1 secrets + DB → WP2 signer), `server/journal.js`, `server/pulse.js` (scoped mode only), `server/population.js` (venue param only), `server/engine.js` (no functional change except exposing `catchingUp` to hooks if needed), `server/main.js`, `package.json` (+ lockfile); tests `testnet-live`, `multiuser`, `perf-gardens`, and **additions only** in new files (existing `live.test.js` untouched) |
| **WP4 HTTP API, SSE, client transport, docs** | catalog (with `ERROR_CODES`), routing, auth integration, query-string refusal, sensitive-op error path, SSE scoping, buffering budgets and `closeStreamsFor`, headers, `/healthz` `/readyz`, client transport and store slices, contract docs | `server/http.js`, `server/catalog.js`, `web/js/brood-api.js`, `web/js/game/core/data.js`, `web/js/game/core/store.js`, `SPEC.md`, `README.md`; test `api-accounts.test.js` (+ `web.test.js` additions in a new file `web-accounts.test.js`) |
| **WP5 Frontend UI and playability** | gate, account, testnet panel, plant venue, badges, barn ledgers (HUD toggle P1), i18n including every error and note code, `errText` and diary localization, FAQ and privacy copy, all "really playable" fixes, the classic page in accounts mode (P1: it shows "sign in on the 3D garden" for spectators and otherwise works with the cookie) | `web/index.html`, `web/classic.html`, `web/css/**`, `web/js/i18n.js`, `web/js/model.js`, `web/js/garden.js`, `web/js/game/core/view.js`, `web/js/game/core/rules.js`, `web/js/game/core/settings.js`, `web/js/game/ui/**` (new `gate.js`, `account.js`, `testnet.js`; changed `plantDialog`, `chips`, `dock`, `inspector`, `radial`, `badge`, `settings`, `landmarks`, `hud`, `diary`, `tutorial`, `listview`, `confirm`, `help` (FAQ), `util` (`errText`)), `web/js/game/world/**`, `web/js/game/gfx/**`, `web/js/game/field/**`, `web/js/game/crops/**`, `web/js/game/fx/**`, `web/js/game/audio/**`, `web/js/game/main.js`, `GAME-DESIGN.md` (a short pointer to §9 of this file); test `game-platform.test.js` |

`PLATFORM.md` itself is changed only by the architect, through a PR that all WP owners review.

### 12.2 Interfaces (frozen at M0; stubs merged on day 1)

```js
// WP1 → WP3/WP4
openDb({ file, log }) → Db  { tx(fn), prepare(sql), exec(sql) /* migrations + constant PRAGMAs only, §3.2 */, close(), file }
backupDb(db, file, { rate }) → Promise<{ bytes, ms }>              // node:sqlite backup(), §10.5
migrate(db, dir, { backupDir, log }) → { from, to }
Users(db): create({username, password, role, bootstrapCode}) / verify(username, password, { knownDevice }) → user|null /
           get(id) / byName(name) / setPassword(id, pw) / setRole / setStatus / remove(id) /* retires the name */ /
           issueReset(id) → { code, expiresMs } / redeemReset(username, code, newPassword) → user|null /
           recordFailure(name) / clearFailures(id) / isLocked(name) → { locked, retryAfterS }
Sessions(db, cfg): create(uid, {userAgent, ip}) → {token, cookie, publicId} / authenticate(req) → {user, session, setCookie?}|null /
                   revoke(uid, publicId) → boolean /* false → 404 */ / revokeAll(uid) / list(uid) / clearCookie() /
                   knownDeviceCookie(user) / checkKnownDevice(req, user) → boolean
  // every revoke* returns the revoked session ids so the caller can call http.closeStreamsFor() in the same tick
checkCsrf(req, { publicOrigin, op, bearerPresent, directLoopback }) → null | ApiError(400|401|403|415|421)
RateLimiter: take(scope, key, cost=1) → { ok, retryAfterS }        // one store per scope, §4.5
clientIp(req, { trustProxy, header, trustedCidrs }) → { ip, source: 'socket'|'xff'|'header', bucketKey(scope) }
Secrets({ masterKey, oldKeys }): seal(uid, accountAddress, agentAddress, keyBytes) → row fields / open(row) → Uint8Array / kid /
         hmacName(canonical) / hmacIp(prefix) / deviceKey
Admin(db): getKillSwitch() / setKillSwitch(on, reason, by) / getCaps() / setCaps(patch, by) / audit(entry) /
           getSigningHalt() / setSigningHalt(halted, sample)

// WP2 → WP3/WP4
createTestnet({ fetch, now, sleep, log, budget, mainnetClient }) → { scheduler, info, market, exchange, verify }
installEgressGuard({ log }) ; isAllowedEgress(url, method)
makeSigner(keyBytes) → { address, signL1(action, nonce) }          // testnet only
isValidScalar(bytes) ; normAddr(s) ; sameAddr(a, b)
fmtPxWire / fmtSzWire / floorSz / orderWire / orderAction / updateLeverageAction / newCloid
classify(response, { agentAddress, accountAddress, attempt, hadTransportFailure }) → code ; RETRY[code] ;
EXCHANGE_CODES ; NOTE_CODES
verifyAgent(…) (§6.1) ; mainnetRecheck(agentAddress, mainnetInfo) → 'missing' | role | 'unavailable'
scheduler.lane(uid, epoch) ; scheduler.cancelLane(uid)

// WP3 → WP4
Gardens API (§7.2, including teardown, resetSeason); LiveLayer additions (§7.1); credentials.withSigner(uid, fn)
new Journal({ …, scoped, globalKinds }) ; GLOBAL_KINDS ; journal.forUser(uid) → { uid, scoped: true, emit } ;
journal.emit(kind, data, { uid }) ; journal.subscribe(fn(record /* has .uid for user records */)) ;
journal.sinceFor(uid, seq, limit) → records | { resync: true }
new Pulse({ scoped: true }) /* publish() refuses garden keys */ ; wireAccounts({ engine, gardens, pulse })

// WP4 → WP1/WP3
http.closeStreamsFor({ uid, sessionIds? }) ; ERROR_CODES (catalog.js)

// WP4 → WP5 (browser)
api.getMode() → { auth, testnet:{enabled} } ; api.signup/login/logout/resetPassword ; api.restream()
store slices: user, mode, testnet, venues, season ; bus events: auth:required, data:marks (+ testnet), cmd:pending/done (+ venue)
```

### 12.3 Integration order and milestones

| Milestone | Content | Gate |
|---|---|---|
| **M0** (day 1) | Interface stubs from all WPs; strict `--auth` parsing; none mode untouched; `.gitignore` updated | 307 tests green |
| **M1** | WP1 DB, users (retired names, bootstrap file, operator reset), sessions (public ids, known-device), CSRF and query-string refusal, client IP, rate limits. WP4 auth ops, `me`, error codes. WP5 farm gate (bottom sheet on phone, no-recovery note, reset-code link), `errText` mapping. | sign up / in / out in a browser (http localhost); `auth`/`csrf`/`db` tests green |
| **M2** | WP3 Gardens (paper, multi-user, teardown, seasons) and fail-closed journal/pulse scoping. WP4 scoped ops, SSE budgets and synchronous stream closing. WP5 account menu, per-user diary (localized notes), slots, spectator landmarks, accounts-mode copy. **The multi-user paper game is playable end to end.** | `multiuser` green; QA-01…13, 16, 19 pass |
| **M3** | WP2 signing KATs, format, egress guard, double (all faults), info/market/exchange, verify (fail-closed mainnet guard, unified accounts). WP1 secrets. WP3 TestnetVenue against the double (attribution, expiry, inactivity, funding). WP4 testnet ops and `--testnet-double` wiring with WP3. WP5 connect panel, plant venue (divergence, slippage, thin book), badges (phone chip), closing state, barn ledgers. | `hl-*`, `mainnet-guard`, `testnet-live`, `secrets` green; **QA-14, 15, 18, 20, 21 pass against the double** |
| **M4** | Docker + Caddy staging on a VM. **The manual runbook R1–R13 with the user's testnet key** (funded per §11.4). Fix the findings (K1, K2, K12). | runbook report attached |
| **M5** | Security checklist §10.7, restore drill, T-PERF, launch (`SIGNUP_MODE` as decided) | all boxes ticked |

### 12.4 Acceptance criteria (release gate)

1. **WP1:**
   - All §4 algorithms are exactly as specified (parameters asserted in tests), including the admin rules (no
     admin without the operator's code or boot promotion; retired names), persisted lockout, the client-IP rules and
     the query-string refusal.
   - The DB passes migrations, retention (batched), online backup and restore; uids and order ids are never reused.
   - The container is healthy behind Caddy, receives secrets as files, and starts in accounts mode from its `CMD`.
   - There are no secrets in logs, `.env` is ignored by git, and no bootstrap code ever reaches stdout.
2. **WP2:**
   - Every KAT passes.
   - T-GUARD passes, including the egress guard and redirect refusal.
   - The weight ledger never exceeds the budget under T-PERF; user-triggered GETs spend no weight.
   - Every §6.9 code is classified from the double's strings, including `signature_mismatch`, `no_deposit`,
     `client_error` and bare-string statuses; a nonce error after a transport failure never re-signs.
   - Verification covers every branch; the mainnet guard fails closed and re-checks every 24 h; unified accounts work.
3. **WP3:**
   - The paper semantics of SPEC §2.6 are unchanged: existing `live.test.js` and `feed.test.js` pass untouched.
   - The §6.11 lifecycle passes on the double, including attribution by `oid`, drift, liquidation, funding, expiry,
     inactivity, restart and catch-up.
   - The §7.6 budgets are met.
   - Players are isolated, and isolation fails closed: an unscoped user emit throws, a garden key in the shared
     `mids` frame throws, and a deleted player's pending work never touches a new garden.
4. **WP4:**
   - Every §8 op, code and shape is implemented; every code is in `ERROR_CODES`.
   - None mode is byte-identical (the existing `api.test.js` and fixtures pass untouched).
   - SSE scoping and replay are correct; SSE memory stays within the §4.5 budgets; revocations close streams at once.
   - Headers and health endpoints are present.
   - `SPEC.md`/`README.md` are updated (README stays in Thai and states the faucet precondition next to "test
     funds").
5. **WP5:**
   - QA-01…07 and QA-09…21 pass (QA-08 and QA-17 are P1).
   - §9.6 honesty holds on testnet bots (≈ on estimates, ages on exchange numbers, testnet labels, confirmed fills
     before effects, testnet funding).
   - The EN/TH parity test covers every key **and every code**; no player-visible English server text in TH mode.
   - Phone layout passes (360 and 390 px, TH, worst HUD state).
   - No console errors as a spectator.

### 12.5 Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| K1 | Unified accounts: is the spot USDC `total` already inclusive of unrealized P&L? | **Implemented** (§6.7 step 7): unified accounts read `spotClearinghouseState`; our account value is marked `≈` until runbook R5 compares it with the testnet site. If `total` already includes uPnL, the formula becomes `total` (a one-line change in WP2). Portfolio margin stays refused with a clear message. |
| K2 | A reduce-only close below $10 is rejected (dust) | `dust` state + UI line (`g.insp.dust`); runbook R7 records the real behaviour. P1: top up to $10 then close, only if R7 shows it is needed. |
| K3 | Signature mismatch from msgpack key order or number formatting | KAT-M1/M2/M3, `packAction` schema guards, and the double's independent re-encoding catch it before release. In production, `signature_mismatch` (a foreign address in the error) halts testnet signing for everyone and alerts, instead of revoking credentials (§6.9). The local self-check guards only curve and recovery-bit bugs; it cannot catch payload bugs. |
| K4 | The HL per-IP budget is shared with other tenants on a PaaS egress IP | `TESTNET_BUDGET` and `TESTNET_MAX_ACTIVE_USERS` are configurable; 429 back-off; recommend a VM with a dedicated IP |
| K5 | Players trade the same coin manually on the connected account | Drift detection pauses the bot without trading; the connect dialog warns (`g.tn.positionsWarn`); the existing-positions warning |
| K6 | Testnet outages or resets (testnet state can be wiped) | `down` state, frozen mirroring, retries for flattens; on a reset, reconcile shows `external_close` and the bots pause |
| K7 | Account takeover through credential stuffing | scrypt (OWASP parameters), persisted per-username lockout that a flood cannot evict, known-device exemption against lockout abuse, IP limits, the common-password list; P2: TOTP |
| K8 | Operator compromise exposes testnet agent keys | Agents cannot withdraw; testnet only; keys known on mainnet refused and re-checked; the master key kept outside the DB and backups and delivered as a file; core dumps off; the reset path wipes keys; revoke instructions in Settings |
| K9 | Memory growth with many gardens or streams | Lazy load and evict, a 200-entry in-memory log ring, DB-backed queries, SSE buffer budgets, T-PERF |
| K10 | Breaking the 307 tests while refactoring `live.js` | Only opt-in options; none mode unchanged; the egress guard only in `main()`; a CI diff check on existing test files |
| K11 | Hyperliquid counts `api.hyperliquid.xyz` and `api.hyperliquid-testnet.xyz` against one per-IP limit | Assumed independent (§6.8). Mainnet 429s while testnet traffic is high raise an alert; the operator then sets `TESTNET_BUDGET=600` (364 + 120 + 600 < 1200). |
| K12 | Most players have no mainnet-deposited address, so they cannot fund testnet | Stated plainly in the app (`g.tn.faucet`, `g.plant.tnExplain`, FAQ) and README; paper is complete; runbook R2b checks whether funding a fresh address by transfer works. **Open question for the user:** whether to run a shared funded "garden testnet account" model later (out of scope now; it would need per-player sub-accounts). |
| K13 | The operator password reset gives the operator a path into a player's paper garden | The reset wipes the testnet credential first and leaves a diary line and a sign-in notice (§4.6 step 8), so it can never reach a testnet key, and the player can see it happened. |

### 12.6 Cut list (cut in this order if late)

**Promoted to P0 in revision 2** (never cut): the honest faucet copy and runbook; `no_deposit`; the code → i18n
mapping (§9.7.2); Replace API wallet and expiry warnings; the no-recovery note and the operator reset
(`reset_password` / `auth_reset`); partial credential indexes; `garden_reset`; `--testnet-double` with QA-18; testnet
labels and testnet funding (§9.4).

**Demoted to P1 in revision 2:** the boot re-seal for master-key rotation (§5.2; the `key_id` column stays and the
manual P0 procedure applies), the HUD `Paper | Testnet` toggle (the barn popover shows both ledgers), and QA-08 (the
Places list).

Cut in this order if late:
1. P2: `/metrics`, TOTP, invite admin UI.
2. P1: the HUD `Paper | Testnet` ledger toggle.
3. P1: QA-08 Places list.
4. P1: browser-wallet approveAgent (§6.10). The paste flow stays.
5. P1: `sessions` / `session_revoke` UI.
6. P1: exchange-side SL/TP (`positionTpsl`) and `expiresAfter`.
7. P1: the admin Operator panel in the UI (`admin_*` ops stay available through `admin-cli`).
8. P1: 10k common-password list (keep the 1k).
9. P1: `QA-17`.
10. P1: per-user cap overrides (global caps stay).
11. P1: the boot re-seal on master-key rotation.

**Never cut:** §1.2 hard rules, the egress guard and T-GUARD, the KATs, the fail-closed mainnet guard,
CSRF/session security, the admin bootstrap rules, encryption at rest, per-player isolation (fail-closed), the honesty
rules of §9.6, localized errors, the faucet truth, the manual runbook before launch, and backups.


---

## 13. Review log (revision 2, 2026-10-11)

Every issue raised against revision 1 was checked before deciding. Protocol claims were checked against read-only
copies of the official sources: the Hyperliquid GitBook pages (`signing`, `info-endpoint`, `info-endpoint/perpetuals`,
`info-endpoint/spot`, `exchange-endpoint`, `rate-limits-and-user-limits`, `nonces-and-api-wallets`,
`websocket/subscriptions`, `trading/account-abstraction-modes`, `trading/margining`, `onboarding/testnet-faucet`),
`hyperliquid-python-sdk` (`tests/signing_test.py`, `utils/signing.py`, `exchange.py`, `api.py`, `info.py`),
`hyperliquid-rust-sdk` (`exchange_responses.rs`) and the Node.js `node:sqlite` docs. Code claims were checked
against this repository (`server/http.js`, `server/live.js`, `server/main.js`, `server/journal.js`,
`server/hyperliquid.js`, `web/js/game/ui/{util,diary,inspector,landmarks,plantDialog}.js`, `web/js/game/main.js`,
`web/js/i18n.js`, `web/js/game/crops/catalog.js`, `.gitignore`). The §6.5 formatting claim was checked by running
the code. **Both blockers are resolved. No issue was rejected outright**; three were accepted with a stated
refinement (marked "accepted, refined").

| # | Lens · severity | Issue | Decision | Change |
|---|---|---|---|---|
| S1 | security · **blocker** | A stranger can become admin (`ADMIN_USERNAMES` at sign-up, freed names, bootstrap code on stdout) | accepted | `ADMIN_USERNAMES` promotes existing users at boot only; a listed name that does not exist needs the bootstrap code, else `409`; deleted names are retired (`retired_usernames`); the generated code goes to `<data>/admin-bootstrap.txt` (0600), never stdout, deleted once an admin exists; role changes need a session + password. §3.1, §3.3, §4.1, §4.6 step 2, §6.14 R4, §10.3, §10.7 #3, §11.2 auth tests, §11.4 R4 |
| S2 | security · major | Mainnet-key refusal is fail-open and incomplete | accepted (merged with P3) | New order: format → agent≠account → testnet role → **fail-closed** mainnet check (any role but `missing` → `422 mainnet_key`; failure → `503 mainnet_check_unavailable`; nothing stored); re-check at verify, boot and every 24 h; a hit flattens, wipes and audits. §1.2, §6.7, §6.8, §6.14 R15, §8.3, §8.9, §11.2 hl-verify |
| S3 | security · major | Secrets in the query string reach access logs | accepted | Accounts mode: any POST with a query string → `400 query_params_not_allowed` before the body is read; params from the JSON body only. §2.3, §4.4, §5.3 #2, §8.1, §10.7 #7, §11.2 csrf |
| S4 | security · major | User scoping fails open (uid-less emits, `mids` merges garden data) | accepted | Scoped `Journal` with `GLOBAL_KINDS`; an unscoped user kind throws and is never broadcast; the SSE writer and `events` re-check; scoped `Pulse` refuses garden keys; `LiveLayer` with `owner` requires a uid-bound facade; `wireAccounts()`. §2.4, §7.1 #7, §7.5, §8.7, §12.2, §11.2 multiuser |
| S5 | security · major | Session revoke IDOR via global rowid | accepted | `revoke(uid, publicId)` with an owner-checked UPDATE; opaque `public_id` (16 bytes); 404 for others' sessions. §3.3, §4.2, §8.2, §12.2, §11.2 auth |
| S6 | security · major | rowid reuse hands a deleted player's uid and pending work to the next sign-up | accepted | `AUTOINCREMENT` on users, sessions, orders; `gardens.teardown(uid)` before the DELETE commits; per-garden `epoch` checked by every lane job and timer. §2.2, §3.3, §4.6 step 6, §7.2, §11.2 db + multiuser |
| S7 | security · major | One shared LRU lets a flood evict a username's lockout | accepted | Per-scope stores; existing users' failures persisted in `users`; unknown names in their own LRU that answers "locked" when full; IPv6 /56 (login, sign-up, SSE) and /48 (sign-up). §3.3, §4.5, §11.2 auth (60k-key flood) |
| S8 | security · major | Client IP trusts headers from anyone; CDN collapse; spoofable single-IP headers | accepted | Headers honoured only from `TRUSTED_PROXY_CIDRS`; short XFF falls back to the socket; Caddy strips single-IP headers; per-topology table; `admin_status.client_ip`; checklist item. §4.5, §10.2, §10.3, §10.6, §10.7 #9, §11.2 csrf |
| S9 | security · major | scrypt p=1 is below OWASP | accepted | `N=32768, r=8, p=3` (same 32 MiB); encoding, DUMMY_HASH and tests updated; old hashes re-hash on login. §3.3, §4.1, §11.2 auth |
| S10 | security · major | SSE buffering can exhaust memory; spectators can fill the pool | accepted | 128 KB per stream, 64 MB global (drop the largest), spectators ≤ 1,000 of 2,000, a connect costs 10 query tokens, /56 counting; T-PERF with 2,000 non-reading streams. §2.2, §4.5, §8.6, §11.2 perf |
| S11 | security · major | `.env` not ignored; env secrets visible in `docker inspect` / `/proc/1/environ`; `--token` on the CLI | accepted | `.gitignore` (WP1) adds `.env`, `.env.*`, `!.env.example`, `secrets/`; compose `secrets:` + `*_FILE`; all secret env vars deleted after reading; `--token` refused in accounts mode; `ulimits: core: 0`. Residual on env-only platforms (Fly/Render/Railway) documented. §5.1, §10.2, §10.3, §10.7 #2 and #20 |
| S12 | security · minor | `login_fail` stores typed usernames (often passwords) | accepted | `user_id` for known names, `HMAC(K_name, …)` for unknown ones; never the raw string. §3.3, §4.6 step 3, §5.1 |
| S13 | security · minor | "Wipe" overstated (WAL, backups) | accepted | `wal_checkpoint(TRUNCATE)` after every wipe; dialogs and privacy note state backup retention; revoking the API wallet is a required, linked step. §4.6 step 6, §5.3 #9, §9.2, §9.3, §10.5, §9.7 keys |
| S14 | security · minor | Sanitizer misses base64, decimal keys, capitalised seeds; 500s log stacks | accepted, refined | Sensitive-op 500s log only `op`, `err.name`, a code; own scalar range check before noble; new b64 / decimal / case-insensitive seed rules. **Refinement:** the b64 rule applies only to runs with a digit, an upper- and a lower-case letter not starting with `/`, so file paths and stack frames stay readable. §5.3, §11.2 T-SECRETS |
| S15 | security · minor | Revoked sessions keep streams for up to 60 s | accepted | Streams record `{uid, session_id}`; every revocation path ends them synchronously; 60 s re-check kept as a backstop. §4.2, §4.6, §8.7, §11.2 auth |
| S16 | security · minor | Static Bearer admin token usable from the internet, incl. `make_admin` | accepted | Bearer only from a direct loopback peer (`admin-cli` via `docker compose exec` / `fly ssh`) unless `ADMIN_TOKEN_REMOTE=1`; exempt from `hostOk` there; never `make_admin`/`remove_admin`; failures limited and audited. §2.1, §2.3, §4.4, §8.6, §10.6, §10.7 #22 |
| S17 | security · minor | "Only exchange.js POSTs to /exchange" is grep-deep; redirects re-POST | accepted, refined | Process-wide egress guard (three exact URLs, POST only), `redirect:'error'` on every HL fetch, `HyperliquidClient` url assertion. **Refinement:** installed only by `main()`, because tests import the library functions and use global `fetch` against the local test server. §1.2 rules 7–9, §2.4 #10, §6.1, §11.2 T-GUARD (g)–(j) |
| S18 | security · minor | None mode can end up on 0.0.0.0 by accident | accepted | Strict `--auth` parsing; none mode exits on accounts-only settings or a non-loopback `HOST` env (today none mode does not read `HOST` at all, so this only adds a refusal); none mode reads only `BEAN_API_TOKEN`; the image `CMD` passes `--auth accounts`. §2.3, §10.2, §10.3, §11.2 api-accounts |
| S19 | security · minor | Sign-up/login oracles, global sign-up cap abuse, scrypt starvation | accepted | Check order IP → lockout → scrypt; one hash in flight per IP; 10/h enumeration bucket counting every attempt; creations-only 3/h per IP, 10/h per /48, global cap → `503 signup_busy`; known-device cookie exempts the owner from lockout; residual oracle documented. §4.1, §4.2, §4.5, §8.2 |
| S20 | security · minor | User GETs could spend the shared testnet budget | accepted | `testnet_status`/`testnet_quote`/`testnet_market`/`me` are cache-only; the one exception is the shared, per-coin, de-duplicated `l2Book` cache needed by U9 (bounded by coins, not users). §6.8, §8.1, §8.3, §11.2 api-accounts |
| S21 | security · minor | `VACUUM INTO`, retention and exact counts block the event loop | accepted | Online `sqlite.backup()` (Node ≥ 22.16, engines bumped), `admin_backup` ≤ 1/10 min, retention in 1,000-row slices, `total_capped` via `LIMIT 10001`; T-PERF p99 check. §3.1, §3.2, §3.4, §6.14 R10, §8.6, §10.5 |
| S22 | security · minor | P1 wallet flow signs server-built typed data | accepted, refined | Server returns only `{agent_address, nonce, agent_name}`; the client builds typed data from frozen constants (`"Testnet"` literal) and checks formats; the server recovers the signer (`signer_mismatch`). **Refined:** "require a fresh test wallet" is not adopted, because the faucet needs a mainnet-deposited address (U1); the frozen chain plus server-side recovery already make a mainnet approval impossible. §1.2 #6, §6.10 |
| S23 | security · minor | Raw `exec`/`prepare` and an unescaped LIKE | accepted | Binding-only rule with a source scan in `db.test.js`; `q` escaped with `ESCAPE '\'`, ≤ 24 chars. §3.2, §8.6, §11.2 db |
| P1 | protocol · major | §6.6 resend vs §6.9 `nonce` re-sign can double an order | accepted | A fresh-nonce retry only on a first transmission without transport failure; otherwise `unknown` → `orderStatus`, never re-signed; `orders.attempts` / `transport_failed`; double test "executed then timed out". §3.3, §6.6, §6.9, §6.14 R5, §11.2 hl-exchange |
| P2 | protocol · major | Wrong-signature errors look like a missing agent and would revoke everyone | accepted | Parse the address from the error: foreign → `signature_mismatch` (global signing halt, alert, credentials untouched, admin resume); our agent → confirm with `userRole` before revoking; our account → `no_deposit`. Self-check scope corrected in §6.4 step 8 and K3. §6.9, §8.6, §8.7, §10.6, §12.5 K3 |
| P3 | protocol · major | Mainnet guard refuses only `agent` | accepted (same as S2) | See S2. |
| P4 | protocol · major | Fills carry no cloid; `orderStatus` has no price or fee | accepted | Resolve unresolved orders by `orderStatus` first (store `oid`, `filled_sz`), then sweep fills by `oid`; prices, fees and P&L only from fills; "pending attribution" instead of drift while orders are unresolved. §6.6, §6.11 sync steps 2–4 |
| P5 | protocol · major | `fills.dir` CHECK breaks on liquidation/ADL text and rolls back everyone's flush | accepted | No CHECK (raw ≤ 64 chars), `start_position` stored, open/close derived from side/startPosition/sz, liquidation via the `liquidation` object, per-garden SAVEPOINT. §3.3, §3.5, §6.11 |
| P6 | protocol · major | Unified accounts (Hyperliquid's recommended mode) refused or misread | accepted, refined | Unified is P0: balances from `spotClearinghouseState` (`total`, `total − hold`), positions from `clearinghouseState`; portfolio margin and DEX abstraction refused; zero value → `422 no_testnet_funds`. **Refinement:** the unified account value is computed as `total + Σ uPnL` and shown with `≈` until runbook R5 confirms whether `total` already includes uPnL. §6.7, §6.8, §7.3, §8.3, §8.4, §6.14 R12, K1 |
| P7 | protocol · major | Runbook R1/R2 cannot get test funds | accepted (merged with U1) | See U1. |
| P8 | protocol · minor | Leverage is invisible while flat; positions default to cross | accepted | `updateLeverage` before every open from flat; worst case recomputed (9 actions per player-minute), which with P6 and U9 lowers `TESTNET_MAX_ACTIVE_USERS` to 40. §6.8, §6.11, §6.14 R11, §2.2, §10.3 |
| P9 | protocol · minor | Bare-string statuses | accepted | Parser handles strings (`"success"`, `"waitingForFill"`, `"waitingForTrigger"`, other → `rejected_other`); the double emits them. §6.2, §6.9, §11.1 |
| P10 | protocol · minor | HTTP 4xx has no taxonomy row | accepted | `client_error`: definitive, never resent, order rejected, alert, `live_error`. §6.2, §6.9 |
| P11 | protocol · minor | Derived cloids repeat after a backup restore | accepted | 16 random bytes in `orders.cloid` (`newCloid()`). §3.3, §6.1, §6.6, §10.5 |
| P12 | protocol · minor | No fills pagination; 10,000-fill horizon | accepted | Paginate at 500 with `startTime = last time`, de-dup by `tid`, weight per page; beyond the horizon keep `fees_estimated` with `fills_beyond_horizon`. §6.8, §6.11 |
| P13 | protocol · minor | `0.00001231` parity row cannot pass | accepted (reproduced: gives `"0.000012"` / `"0.00001"`) | Row split per function with its `d`; the value removed with an explanation. §6.5 |
| P14 | protocol · minor | "Even if both hosts were counted together" is arithmetically false | accepted | Stated plainly as an assumption; risk K11 with the `TESTNET_BUDGET=600` knob and a mainnet-429 alert. §6.8, §6.14 R8, §10.6, K11 |
| P15 | protocol · minor | P1 approveAgent: signer, `signatureChainId` format, `expiresAfter`, no KAT | accepted | Signer recovery; hex-string `signatureChainId` vs integer domain `chainId`; `expiresAfter: null`; KAT-U1 (SDK `test_sign_usd_transfer_action`, testnet). §6.10, §6.12 |
| P16 | protocol · minor | Case-sensitive address comparisons | accepted | `normAddr`/`sameAddr` everywhere; mixed-case fixture. §6.1, §6.7, §11.1, §11.2 |
| P17 | protocol · minor | Unnamed agents die silently; unfunded accounts prune agents | accepted | `unnamed_agent` warning with advice; zero value refused. §6.7 steps 5 and 7, §9.7 |
| P18 | protocol · minor | "A pending order never sent becomes canceled" cannot be decided locally | accepted | `pending`/`sent` → canceled only after `unknownOid`. §6.11 Restart |
| P19 | protocol · minor | KAT-1 label invites asserting the source | accepted | Annotated "connectionId only; SDK uses `is_mainnet=True`". §6.12 |
| P20 | protocol · minor | Flatten retries stuck at 1% on thin books | accepted | Flatten retries widen 1% → 2.5% → 5% (SDK default 5%), then every 15 s at 5%; copy updated. §6.1, §6.5, §6.9, §6.14 R13, §9.4, §9.7 |
| U1 | product · **blocker** | The faucet needs a mainnet deposit; the copy and runbook hide it | accepted | `g.tn.faucet` EN/TH as proposed with the `/drip` link; facts and G3 state the precondition; R1/R2 rewritten with paths (a) and (b) and a new R2b check; `positionsWarn` reworded; `g.plant.tnExplain` behind `not_connected`; FAQ; README acceptance criterion; risk K12. Header, §1.1, §9.3, §9.4, §9.7, §11.4, §12.4, §12.5 |
| U2 | product · major | "Must deposit" misclassified as revoked | accepted (reconciled with P6/P17) | `no_deposit`: credential stays verified, no pause, plant refused with the faucet link; at connect, value 0 → `422 no_testnet_funds` (agents of unfunded accounts are pruned), 0 < value < $20 → `no_funds` warning. §6.7, §6.9, §9.7 |
| U3 | product · major | Errors reach Thai players as raw English | accepted | `errText` maps `code` → `g.err.<code>`; raw text only as a detail; accounts-mode 401 → gate; keys for every code (§9.7.2); parity test enumerates `ERROR_CODES`/`EXCHANGE_CODES`/`NOTE_CODES`; format errors do not count against the connect limit. §4.5, §8.9, §9.5, §9.7.2, QA-21 |
| U4 | product · major | Existing strings say "restart the server" | accepted | Accounts-mode variants selected by mode; `realBack` admin-only; QA-19 forbids "restart"/"รีสตาร์ท". §9.4, §9.7.1, QA-16, QA-19 |
| U5 | product · major | API-wallet expiry strands positions; rotation is punitive | accepted | Same-account reconnect = Replace API wallet (bots kept); warnings at −7 d and −1 d; flatten at −30 min; create refused within 24 h; warn at connect < 7 d. §3.3, §6.7, §6.11, §7.3, §8.3, §9.3, §9.7 |
| U6 | product · major | No password recovery; non-partial indexes; abandoned gardens hold capacity | accepted, refined | No-recovery note; operator `reset_password` → one-time code → `auth_reset`; **refinement:** issuing a reset flattens and wipes the testnet credential so the operator can never reach a key through it (R14, K13); partial UNIQUE indexes and take-over of revoked rows; 14-day inactivity rule. §3.3, §4.6 steps 8–9, §5.4, §6.7, §8.2, §8.6, §9.1, §9.2 |
| U7 | product · major | No paper reset | accepted | `garden_reset` (`RESET`, once per 24 h, refused while burned): closes paper bots, new season, archives by `season`; testnet untouched. §3.3, §7.6, §8.4, §8.7, §9.2, §9.7 |
| U8 | product · major | Testnet bots mislabeled; mainnet funding shown as testnet; funding missing from P&L | accepted | `g.src.hlTestnet`, "Testnet mid", testnet footer; `metaAndAssetCtxs` for testnet funding/mark; `cumFunding` → funding line and Total P&L; reconciliation test. §6.1, §6.11, §7.5, §8.5, §9.4, §9.6, §11.2 |
| U9 | product · major | Partial/unfilled bots look idle; slippage and liquidity not shown | accepted | `target_szi`, `fill_state`; quote returns `slippage_max_usd`, `book_ok`, `depth_usd`; `thin_book` block; inspector and chip lines. §6.11, §7.3, §8.3, §8.5, §9.4, §9.7 |
| U10 | product · major | Async testnet close has no UI; effects play on provisional numbers | accepted | Closing state replaces actions; `bot_close` idempotent; `bot_closed` after the completion sweep (`confirmed`), neutral effect when tiny, re-sort on confirm; QA-04 extended. §6.11, §8.4, §8.7, §9.4, §9.6 J4, §9.8 |
| U11 | product · major | Key input as `type=password` invites password managers | accepted | Masked `type=text` with ignore attributes, outside any form, visible fallback note; QA-20. §9.3, §9.7 |
| U12 | product · major | New event kinds missing from the diary; English notes | accepted | `note_code` + `note_vars` on every pause; `lineFor` for every §8.7 kind; venue prefix; keys. §7.1, §8.5, §8.7, §9.5, §9.7.2, QA-19 |
| U13 | product · major | Phone top row overflows | accepted | Combined phone chip with short keys; account in ⋯ More; ledgers in the barn popover; gate as a bottom sheet reporting the safe area; QA-10 at 360/390 px in TH. §9.1, §9.2, §9.4, §9.8 |
| U14 | product · major | Bean record at mainnet prices vs testnet results | accepted | `divergence` in the quote; amber warning > 3%, required tick > 20% (`divergence_ack`); `k` shown; "bean results are at real prices". §7.3, §8.3, §8.4, §9.4, §9.7 |
| U15 | product · minor | Venue control disabled by stake; quote cadence unspecified | accepted | Stake-independent enable checks (`venue_ok`); clamp on switch; quote at open, switch, 300 ms after the slider settles, submit; `≈` in between. §7.3, §8.3, §9.4 |
| U16 | product · minor | 409 `testnet_positions_open` unhandled in dialogs | accepted | Second step with the position list and a required force tick in delete and disconnect. §8.3, §9.2, §9.3, §9.7 |
| U17 | product · minor | Spectator landmarks look broken | accepted | Sign-in tooltips and the global diary line; QA-02/13. §9.1, §9.8, §9.7 |
| U18 | product · minor | Places list bound to `L` (already List) | accepted | Key `G`; QA-08 demoted to P1 (U24). §9.8, §12.6 |
| U19 | product · minor | Silhouette test measures the wrong thing | accepted | 32×32 mask IoU < 0.8 within each shared builder; ≥ 6 px at 390×844 too. §9.8 QA-05 |
| U20 | product · minor | Landmarks too small to tap on phones | accepted | Proxy screen box ≥ 44×44 CSS px at 390×844 (≥ 24 px minimum), outside HUD insets. §1.1 G6, §9.8 QA-01 |
| U21 | product · minor | FAQ and privacy note have no owner or keys | accepted | WP5 Help & FAQ with `g.faq.*`; `g.acct.privacy`. §9.2, §9.7, §10.7 #21, §12.1 |
| U22 | product · minor | Testnet barn "vs start" would be invented | accepted | No vs-start for testnet; optional "since you connected on {date}" from `value_at_connect`. §3.3, §8.4, §9.4, §9.6 J5 |
| U23 | product · major | The testnet UI cannot be exercised without a funded account | accepted | `--testnet-double` dev mode (refused in production, no `test/` in the image), `dev_double` fault op, QA-18 scripted run, T-GUARD (j); in M3. §8.6, §10.2, §10.3, §11.1, §12.3 |
| U24 | product · minor | P0 set misses retail-critical items | accepted | Promoted: faucet truth, `no_deposit`, code→i18n, replace/expiry, recovery note + operator reset, partial indexes, `garden_reset`, `--testnet-double` + QA-18, testnet labels/funding. Demoted to P1: boot re-seal (§5.2 manual P0 procedure), HUD ledger toggle, QA-08. §5.2, §9.4, §9.8, §12.6 |

**Knock-on changes** made to keep the document coherent: `TESTNET_MAX_ACTIVE_USERS` 60 → 40 and the §6.8 tables
(P8, P6, U9); engines `>=22.16` (S21); new interfaces in §12.2; milestones M1–M4 re-scoped; acceptance criteria and
risks K1, K3, K7, K8 updated and K11–K13 added; WP ownership extended (`.gitignore`, `server/admin-cli.js`,
`server/auth/clientip.js`, `server/hl/egress.js`, `server/hl/addr.js`, additive `server/hyperliquid.js`,
`server/pulse.js`).

**Open questions for the user** (not blockers for starting work):
1. **Hosting:** a VPS with Docker + Caddy (recommended: dedicated IP for the Hyperliquid budget, compose `secrets:`,
   cheapest at this size) or Fly.io (simplest TLS and volumes; env-only secrets; shared egress IPs may need a lower
   `TESTNET_BUDGET`). Render/Railway work but need the §10.7 client-IP check.
2. **Domain name** for `PUBLIC_ORIGIN`.
3. **Test funds:** does the user have an address with a mainnet deposit to claim the faucet (runbook path (a) or
   (b))? Without one, testnet cannot be tested at M4.
4. **Sign-up policy at launch:** `open`, `invite` (P1) or `closed` for a private beta.
5. **Operator password reset** (wipes the player's testnet key): acceptable, or no recovery at all?
6. **Inactivity rule:** 14 days before testnet bots are flattened, or another value.
7. **Thai copy:** the new EN/TH strings (§9.7) should be read once by a native speaker before launch.


**Review fixes (2026-10-12).** Decisions taken while fixing the post-build review. Code and tests follow them:
- **Resume withdraws a flatten** (§6.11 Pause). Resuming clears `exchange_sync.op = 'flatten'` and cancels the flatten
  retry. Every flatten step re-checks "still pausing or closing" after each await and before it sends anything.
  `bot_paused` is emitted only for a paused bot. Mirror work re-checks "active, not closing, same target" after every
  await, so no opening order is sent after a pause or close.
- **Dust on close** (§6.11 Close, risk K2). When the exchange refuses a reduce-only remainder as `min_notional`, a
  closing bot **stays closing**: the dust is shown, nothing is resent, and the coin stays bound. Each bar's reconcile
  looks again: once the exchange is flat (closed by hand on the testnet site) the close completes; once the remainder is
  worth ≥ $10 again, one more flatten runs. A pausing bot pauses, and its dust stays shown.
- **Funding at close** (§6.11 Funding). `userFunding` is paginated like `userFillsByTime`: pages of 500, de-duplicated
  by (time, coin, hash), at most 6 pages at close. A history longer than that keeps the reconciled value
  (banked + since open) and closes with `confirmed:false`. A partial sum is never reported as exact.
- **Budget** (§6.8). Each garden's sweep cadence and hourly `userRateLimit` read are offset per uid, so gardens loaded
  together never share a sweep bar. The cadence sweep runs **after** that bar's orders and may wait at most 10 s to
  start (otherwise it runs next bar). Degradation step 1 stretches the provisional cadence 5 → 10; the idle cadence
  stays 30. Step 4 skips the whole sync on every 2nd bar for a player with nothing to send (no unresolved order, no
  flatten, books at target). T-PERF also measures order latency on the fake clock.
- **Testnet quote fees** (§8.3). `fees_est_usd` is the round trip (both taker sides), which matches the dialog's
  "to open and close". The new additive `fee_open_usd` is one side.
- **Exchange numbers after a fill** (§9.6 J1/J7). A bot's margin and liquidation price come from the exchange only
  while the last reconcile's position matches the books. Otherwise the margin is our estimate (BotRow
  `est` gains `'margin_used'`, shown with ≈) and the liquidation price is unknown. An external close books the outside
  fills when they explain it exactly; otherwise it zeroes the books. A closed bot never holds a size.
- **Thai copy** (§9.7.1, open question 7). The new Thai strings say ถั่ว, not "bean". The three verbs are now
  distinct: disconnect = ตัดการเชื่อมต่อ, revoke = เพิกถอน, cancel = ยกเลิก. The 15 affected table rows were
  updated. A native speaker should still read the copy before launch.
- **Really playable** (§9.8, QA-01/06/10/16/18). Some invisible pick proxies were reshaped: the compost proxy is low
  and pulled forward, the silo proxy is wider, the barn proxy matches its art, and the signpost proxy reaches up above
  the dock. The compost and silo labels sit lower. With the HUD insets measured in the browser (1280 × 800: top 50,
  bottom 218), every landmark now has its own 44 × 44 px tappable block, and a new Node test checks this. Under a
  two-row HUD (top 123) the silo and the signpost reach only about 28–39 px; framing their art tops would need a camera
  distance beyond `dMax`. Other changes:
  - 3D labels keep a 16 px gutter at the screen sides.
  - Phone sheets report their safe area again when their slide-in animation ends.
  - Pip's tour shrinks to a "Tour with Pip ›" chip while a dialog or a left panel is open, and it ends when the player
    plants.
  - A burned plot's button in the inspector is now "Re-arm the field" (with its countdown).
  - The plant dialog shows the faucet link and the explainer when the Testnet option is disabled for lack of test USDC.
  - On testnet, the plant dialog header and the high-leverage check use the testnet leverage.
  - The money row stays on one row on desktop.
  - Small buttons are 44 px tall on touch screens.
  - Plot pick boxes are 4.3 u deep (row pitch 4.4).

# Bean Garden — build spec (contract for every module)

A self-contained re-creation of the **brood "Bean Garden"** experience (studied in `BROOD-STUDY.md`, mirror in
`reference/brood-site/`). We write our OWN code — never copy files from `reference/` — but we keep brood's op
names, params and response shapes for the subset the garden needs, so the experience and contract match.
`GAME-DESIGN.md` (the 3D game) is the binding contract where the two differ; this file is kept in sync with it
(§10 there = §2.1, §2.2 and §4 here).

**Hard rule: REAL PRICES, PAPER TRADES.** No real exchange orders, no private keys, no signing — ever. The "live
layer" is a paper exchange (`mode: "sim"`: fills are computed locally). By default prices are REAL: read-only
public market data from Hyperliquid (`POST https://api.hyperliquid.xyz/info`, three request types, no
credentials). `--feed sim` runs the synthetic market instead (deterministic, offline; what `npm run sim`/`dev`
and every test use). A fresh real start that cannot reach Hyperliquid falls back to the sim feed with the sim state
files and says so; it never switches feeds at runtime.

**Platform upgrade (`PLATFORM.md`, binding where it speaks).** `--auth none` (the default) is exactly this spec: one
implicit local player, paper only. `--auth accounts` adds sign-up / sign-in, many private gardens on one shared engine,
and — optional, `TESTNET_ENABLED=1` — bots that send real IOC orders on **Hyperliquid TESTNET** (test funds) through an
API wallet the player connects. **Mainnet orders are impossible by construction** (PLATFORM §1.2): the only `/exchange`
URL in the code is the frozen testnet one, the signer is testnet-only and an egress guard allows nothing else. The
none-mode contract below is unchanged except for the additive items listed in §4 ("Platform additions").

Runtime: **Node.js ≥ 22.16** (`node:sqlite` with the online backup), ES modules (`"type": "module"`), dependencies
pinned exactly: `three@0.169.0` (a browser asset only, served at `/vendor/three/…`; the server never imports it) and,
for the testnet signer only (`server/hl/`), `@noble/curves@1.6.0`, `@noble/hashes@1.5.0`, `@msgpack/msgpack@2.8.0` —
run `npm install` once. Windows-friendly paths
(`node:path`, `node:url`). Tests: `npm test` = `node --test "test/*.test.js"` (a bare `node --test test/` fails on
Node ≥ 22). Tests never touch the network: the Hyperliquid client takes an injected `fetch` and clock
(`test/fixtures/hl-double.js`).

---

## 1. Layout and ownership

```
package.json                 (api agent)  scripts: start (real), sim, dev (sim, 2 s ticks), fresh, test; "type":"module";
                                          dependencies: three 0.169.0 (browser asset only)
server/rng.js                (engine)     seeded PRNG
server/hyperliquid.js        (engine)     READ-ONLY Hyperliquid info client: allMids, metaAndAssetCtxs, candleSnapshot;
                                          60 s weight ledger, skip/queue rules, 429 back-off; fetch/clock injectable
server/market.js             (engine)     MarketFeed: sim GBM feed, or REAL bars on real minutes from Hyperliquid
server/strategies.js         (engine)     signal functions
server/population.js         (engine)     beans: genomes, paper trading, metrics, queries
server/engine.js             (engine)     Engine: market + population, tick loop / real-minute scheduler, warmup,
                                          live marks, gap fill (replay / re-warm), feed state
server/journal.js            (live)       Journal: event bus + ring buffer + optional jsonl file
server/pulse.js              (live)       Pulse: ephemeral stream-only frames (`mids`), never journaled
server/live.js               (live)       LiveLayer: paper bots mirroring beans; live marks + liquidation on marks
server/store.js              (live)       atomic JSON save/load of state
server/catalog.js            (api, WP4)   op catalogue (names, kinds, params, descriptions, auth class, sensitive, modes)
                                          and ERROR_CODES — single source of truth
server/http.js               (api, WP4)   HTTP server: static, /vendor/three, /api/v1 router, none-mode command auth, the
                                          accounts pipeline (host, CSRF, sessions, access classes, rate limits), SSE
                                          (scoped, budgets, closeStreamsFor), /healthz /readyz, security headers, errors
server/main.js               (api)        CLI entry: config, per-feed state files, sim fallback, wiring, signals,
                                          persistence schedule
web/index.html               (frontend)   the 3D Bean Garden (GAME-DESIGN §9); web/classic.html = the 2D garden
web/css/garden.css           (frontend)
web/js/brood-api.js          (frontend, WP4) client contract (mode, base URL, token, cookies, query, command, stream,
                                          restream, auth wrappers, auth:required)
web/js/game/core/data.js     (WP4)        polling + SSE + commands → store / bus (mode, user, testnet, venues, season)
web/js/game/core/store.js    (WP4)        the store (accounts slices: mode, user, me, testnet, venues, season)
web/js/format.js             (frontend)   esc/fmt/pct/usd/signClass/ago
web/js/i18n.js               (frontend)   EN + TH strings, auto by navigator.language, toggle
web/js/plant.js              (frontend)   pure canvas renderer: stage(), drawPlant()
web/js/garden.js             (frontend)   page logic
test/*.test.js               (each agent tests its own modules; integration adds api tests; feed.test.js = real feed)
test/fixtures/               Hyperliquid captures, the offline HL double, payload fixtures for the frontend
                             (status-real.json, market-real.json, mids.json — the API tests keep them in sync)
data/                        runtime state (gitignored): sim → state.json + journal.jsonl,
                             hyperliquid → state-real.json + journal-real.jsonl (switching feeds never destroys a garden);
                             accounts mode adds bean[-sim].db (SQLite, WAL) and backups/
```

Accounts mode adds (owners in PLATFORM §12.1): `server/config.js`, `server/auth/*` (users, passwords, sessions, csrf,
ratelimit, clientip, the AuthService), `server/db/*` (+ `migrations/0001_init.sql`), `server/secrets.js`,
`server/admin.js`, `server/admin-cli.js` (WP1); `server/hl/*` (testnet info, market, signing, exchange, verify, egress
guard; WP2); `server/garden/*` (Gardens, repo, credentials, testnet venue) and the accounts wiring in
`server/main.js` (WP3); `web/js/game/ui/{gate,account,testnet,session}.js` (WP5).

Each module must be importable on its own (no side effects at import time except constant tables).

---

## 2. Domain model (mirrors brood semantics)

### 2.1 Time
- 1 **tick** = 1 **bar** = 1 minute. `barMs = 60_000` of *market time*.
- **Real prices (default):** one bar per REAL minute. Bar `b` opens at `startMs + b·60 000`; after warmup
  `startMs` = last closed minute − (warmup − 1) min, so bar index ↔ wall-clock minute exactly. A timer at the next
  minute boundary **+ 2 s** fetches the just-closed candles and ticks (see §2.2). `tick_ms` = 60 000, `aligned`.
  Marks (live mids) arrive every ~5 s in between. Fast-forward is impossible: the `tick` op answers 409.
- **Sim feed:** a tick fires every `tickMs` (default **5000 ms**), so the market runs 12× faster than wall clock.
- On first start the engine **warms up** `warmupBars` (default **2880** = 2 days; real prices: at most 5000, the
  candles Hyperliquid keeps) as fast as possible before serving, so the shelf already has history, returns and
  sparklines. Budget: warmup ≤ 8 s, one tick ≤ 50 ms for the default population on a laptop (measured, real feed:
  2.8 s warm-up including the candle download, ~1–3 ms per tick).
- Hourly curve point = every 60 bars.

### 2.2 Coins (sim venue)
`market.js` exports `COINS` — the venue listing. Each: `{coin, px (start price), vol (annualised), max_leverage, sz_decimals}`.

| coin | px | vol | max_lev | sz_dec |
|---|---|---|---|---|
| BTC | 82000 | 0.55 | 40 | 5 |
| ETH | 3200 | 0.70 | 25 | 4 |
| SOL | 180 | 0.95 | 20 | 2 |
| HYPE | 42 | 1.20 | 10 | 2 |
| XRP | 2.4 | 0.90 | 20 | 0 |
| DOGE | 0.18 | 1.10 | 10 | 0 |
| AVAX | 28 | 1.00 | 10 | 2 |
| LINK | 18 | 0.95 | 10 | 1 |
| SUI | 3.6 | 1.20 | 10 | 1 |
| NEAR | 3.1 | 1.10 | 10 | 1 |
| ARB | 0.45 | 1.10 | 10 | 1 |
| TIA | 4.2 | 1.30 | 5 | 1 |
| ZEC | 220 | 1.40 | 10 | 2 |
| WIF | 1.1 | 1.60 | 5 | 0 |
| PUMP | 0.006 | 1.80 | 5 | 0 |
| VVV | 21 | 1.70 | 3 | 2 |

Synthetic feed: per-coin GBM on 1-minute steps, σ_min = vol / √525600, plus a **regime drift** (re-drawn with
mean duration ~720 bars, μ ~ N(0, 0.03·σ_min)) and rare **jumps** (p ≈ 0.0005/bar, size N(0, 8·σ_min)); a mild
common market factor (correlation ~0.4 with BTC). Each bar has `o,h,l,c` (simulate ≥4 sub-steps for h/l).
Deterministic from `seed`. Goal: trends are detectable, some beans profit, the median bean loses a little to fees.

**Hyperliquid feed (default, read-only; GAME-DESIGN §10.2–§10.6).** `POST https://api.hyperliquid.xyz/info`, no
credentials, `AbortSignal.timeout(8000)`, fetch injectable:

| Request | When | Weight | Use |
|---|---|---|---|
| `{"type":"metaAndAssetCtxs"}` | boot; once per minute after each tick | 20 | `universe[i]` → `sz_decimals`, `max_leverage` (venue limits, replacing the table above); `ctx[i]` → `prev_day_px`, `funding_1h`, `mark_px`, `oracle_px`, `open_interest`, `day_ntl_vlm` |
| `{"type":"allMids"}` | every 5 s | 2 | live mid per coin → marks, out-of-tick fills, the minute's sample buffer |
| `{"type":"candleSnapshot","req":{coin,"interval":"1m",startTime,endTime}}` | warmup, catch-up, each minute close | 20 + 1 per 60 candles | bars |

- **Budget.** Steady state 24 + 20 + 16 × 20 = **364 weight/min** (HL allows 1200/min per IP); warmup 16 × 68 + 22 =
  1110. A rolling 60 s ledger: candles **queue** under a 1000 budget (bursts — warmup, catch-up — may use 1150);
  `metaAndAssetCtxs` is **skipped** over 1000, `allMids` (the heartbeat) over 1150; HTTP 429 → 15 s back-off for all.
- **Bars.** At each minute close, per coin: (a) the HL candle (missing ones retried at +5 s and +10 s, 15 s
  deadline); else (b) a bar from that minute's 5 s mid samples (`o` = previous close, `h/l` = extremes of samples
  and `o`, `c` = last sample); else (c) a **flat bar** at the previous close and the coin is **stale**. If every coin
  would be (c) the engine **holds** (no bar, `lag_bars` grows, retry every 15 s). A synthetic price is never used.
- **Stale coins** (flat last bar, or no mid for > 60 s): their bots are frozen — no mirror, no liquidation check,
  marks stay at the last real price, BotRow `price_stale: true` (computed when the row is read, so it is true during
  an outage before any mark runs); `bot_create`/`bot_resume` on them answer 409 — and so do they whenever the coin's
  mid is > 15 s old (`livePx` would fall back to the bar close). Inside a tick or a catch-up replay a coin is stale
  only when **that bar** is flat (the wall-clock mid age says nothing about a replayed bar).
- **Price times.** Every mark carries the time of the price behind it, never the request time: `mark_ms` /
  `real.as_of_ms` = the mid's receive time (or the bar close it fell back to), `mids.t` = the last allMids while
  fresh (else the last bar close), `mids.px_ms` per coin, and `live_status.account_state.as_of_ms` = the oldest
  open position's mark time (now when nothing is open).
- **Feed state.** `live` (allMids ≤ 15 s old, no lag) · `delayed` (allMids 15–60 s old, `lag_bars ≥ 1`, or a 429
  back-off) · `down` (no successful HL request for > 60 s; new exposure refused) · `sim`.
- **Gap fill** (`MAX_REPLAY_BARS = 2880`): a restart or an outage replays the missed minutes from candles (bots mirror
  and liquidate per bar, fills stamped with the bar close, ONE `tick_completed` at the end, `feed_gap` journaled);
  a longer gap (or candles that cannot cover it) **re-warms** in place: MarketFeed and Population are rebuilt from a
  fresh real warmup (same seed and genomes); the live layer and journal are kept and open bots are marked at once.
- **Fallback.** A fresh real start whose warmup fails (meta or mids unreachable, or < 8 coins with candles) runs the
  sim feed with the sim state files; `status.feed.fallback = {from:'hyperliquid', reason, since_ms}` and an allMids
  probe every 60 s sets `real_available` (the UI suggests a restart). A restored real state with HL unreachable is
  kept and holds (state `down`) until HL returns.

### 2.3 Archetypes (algo only — we have no LLM)
| name | family | leverage | position_size | stop_loss | take_profit | scale | fitness | default count |
|---|---|---|---|---|---|---|---|---|
| standard | standard | 1 | 0.05–1.0 | 0.01–0.2 | 0.01–0.4 | sharpe | sharpe − max_dd | 400 |
| hyper_algo | hyper | 2–10 | 0.25–1.0 | 0.02–0.5 | 0.05–1.5 | return | ann_return − max_dd | 400 |
| degen_algo | degen | 10–25 | 0.5–1.0 | 0.02–0.5 | 0.1–3.0 | return_dd2 | ann_return − max_dd/2 | 400 |
| swarm | swarm | 1 | 0.05–0.35 | 0.01–0.2 | 0.01–0.4 | sharpe | sharpe − max_dd | 300 |
| swarm_5x | swarm | 5 | 0.05–0.35 | 0.01–0.2 | 0.01–0.4 | sharpe | sharpe − max_dd | 300 |
| swarm_10x | swarm | 10 | ″ | ″ | ″ | sharpe | ″ | 300 |
| swarm_25x | swarm | 25 | ″ | ″ | ″ | sharpe | ″ | 300 |
| swarm_50x | swarm | 50 | ″ | ″ | ″ | sharpe | ″ | 300 |
| swarm_100x | swarm | 100 | ″ | ″ | ″ | sharpe | ″ | 300 |

All: `mode: "algo"`, `lookback 2–60`, `entry_threshold 0.1–3`, `cooldown_bars 0–48`, `min_hold_bars 0–96`,
`max_hold_bars 60–4320`, `capital_per_bean = 1000`. Non-swarm families use strategies
`momentum | mean_reversion | breakout`; swarm uses all of `momentum | mean_reversion | breakout | ma_cross | rsi_reversal`.
`--beans N` scales the default counts proportionally (default total 3000). Bean ids are integers `0..N-1`,
assigned in the table order above. `sharpe` = annualised (√525600) mean/sd of per-bar equity returns;
`ann_return` = mean per-bar return × 525600. Fitness is never compared across archetypes (UI rule too).

### 2.4 Strategies (signal ∈ {-1, 0, +1} on bar close)
Let `L = lookback`, `k = entry_threshold`, closes `c`.
- **momentum**: z = (c[t]/c[t−L] − 1) / (σ_1bar·√L); long if z > k, short if z < −k.
- **mean_reversion**: z = (c[t] − SMA_L) / SD_L; long if z < −k, short if z > k.
- **breakout**: long if c[t] > max(c[t−L..t−1])·(1 + k·σ_1bar), short if c[t] < min(...)·(1 − k·σ_1bar).
- **ma_cross**: fast = SMA_⌈L/3⌉, slow = SMA_L; long if (fast/slow − 1) > k·σ_1bar, short if < −k·σ_1bar.
- **rsi_reversal**: RSI_L; long if RSI < 50 − 10k, short if RSI > 50 + 10k (clamped to sensible 5..95).
σ_1bar = rolling stdev of 1-bar log returns over 60 bars. Use per-coin prefix sums so window stats are O(1)
where possible (performance budget above).

### 2.5 Paper execution (per bean, isolated margin, $1000 start)
- Entry when flat, cooldown elapsed and signal ≠ 0: margin = equity × position_size; notional = margin × leverage;
  units = notional / fill_px. Fill price = close × (1 ± (spread 1bp + impact 0.5bp)) against the trader.
  Taker fee 4.5 bp of notional on every fill (open and close), paid from equity.
- Exits, checked in this order each bar using the bar's h/l: **liquidation** (adverse move ≥ 1/leverage ×0.95 →
  lose the whole margin), **stop_loss** (adverse price move ≥ stop_loss, fill at stop price, floored by
  liquidation), **take_profit** (favourable move ≥ take_profit; short TP capped at 0.9), **max_hold_bars**,
  **signal flip** (opposite signal after min_hold_bars → close; re-entry next bar). Reasons:
  `liquidation | stop | target | max_hold | signal`.
- `trades` counts fills (opens + closes). `win_rate` = closed trades with pnl > 0 / closed trades.
- **busted** (the only death): flat AND `equity × position_size × leverage < 10` (cannot open a $10 order). A
  busted bean never trades again. Emit journal `busted` the first time.
- `breached` bit flags: 1 = max_dd ≥ family max_drawdown (standard/swarm 0.30, hyper 0.60, degen 0.85), 2 = equity ≤ ruin_floor×1000 (0.5/0.25/0.10).
- Metrics: `equity` (marked to market at close), `total_return = equity/1000 − 1`, `ret_1h/ret_1d/ret_7d` vs the
  hourly curve 1/24/168 points back (or start), `max_dd`, `sharpe`, `fitness`, `in_position` `"long"|"short"|"flat"`,
  `side` −1/0/1, `units` (signed position size in coin units), `entry_px`.
- Hourly curve per bean: `[{h, equity}]`, keep last 336 points (14 days); `h` = hour index since bar 0.

### 2.6 Live layer (simulated exchange — `server/live.js`)
- `mode: "sim"`, `network: "sim"`, `dry_run: false`, `armed: true` unless halted. Simulated account starts with
  `account_usd` (default 10 000). `account_value = start + Σ realized + Σ unrealized`.
- **bot** = a bean bound to simulated capital. id `bot-0000` (zero-padded index). States `active | paused | closed`.
- **tradeable(bean)**: coin listed in COINS, not busted, coin not bound to an open (active|paused) bot, bean not
  bound, and `required_leverage = position_size × leverage × equity / 1000 ≤ venue max_leverage`. When false give
  `venue_reason` (`"busted" | "coin_bound" | "bean_bound" | "leverage" | "unlisted"`).
- `bot_create {bean, capital_usd, confirm?}` rejects (409) when halted, not tradeable, open bots ≥ `max_bots`
  (default 10), capital outside `[min_capital_usd 20, max_bot_capital_usd 1000]` (400), capital > available cash
  (409), or Σ open notional would exceed `max_total_notional_usd` (10 000). On success: bot leverage =
  min(bean.leverage, venue max_leverage); **mirror immediately** (do not wait for the next tick).
- **Mirror** (after every tick and on create/resume): `target_sz = bean.side × floor_to(|bean.units| × capital/1000, sz_decimals)`.
  If `|target − szi| × mid ≥ min_order_usd (10)` (or target is 0 and szi ≠ 0) → simulated IOC fill at mid ±
  (1bp + 0.5bp) with 4.5bp fee. Track `real = {szi, entry_px, unrealized_pnl, margin_used, liquidation_px, leverage, as_of_ms}`,
  `realized_pnl` (net of fees), `fees`, `volume`, `fills`, `orders`, `notional_usd`.
  The notional cap gates only NEW exposure (|target| > |szi|): when it blocks a flip's opening leg the closing leg
  still executes, so a bot never keeps the side its bean has left. A blocked situation logs one skipped order and
  one `live_error` (keyed by situation, e.g. `notional_cap`) — not one per tick while prices move.
- **Water scales, it does not cap**: notional = capital × position_size × leverage × equity / 1000 at
  min(bean, venue) leverage, isolated — a bean grown past 1000/position_size makes the bot's margin (and possible
  loss) exceed `capital_usd`. Available cash = account_value − Σ max(capital_usd, initial margin) over open bots.
- **Liquidation** (bots): mid crossing `liquidation_px` = entry × (1 ∓ 0.95/leverage) → closed at that price losing the
  whole initial margin (`closed_pnl = −|szi|·entry/leverage`, no taker fee — the same outcome as a bean's §2.5
  liquidation), then `paused` with note `"liquidated"`.
- `bot_pause {id}` → flatten + `paused` (a paused bot holds nothing, does not mirror). `bot_resume {id}` →
  `active` + mirror now. `bot_close {id}` → flatten + `closed` (+ `closed_ms`). Closing an already closed bot → 409.
- Bean of an active bot busts → bot auto-paused + flattened, note `"bean busted"`, event `bot_paused`.
- `bots_halt {}` → close every open bot, `halted: true`, `halted_ms`; reject `bot_create`/`bot_resume` until restart.
- Fill record: `{bot, coin, dir: "Open Long"|"Close Long"|"Open Short"|"Close Short", side: "B"|"A", sz, px, fee, closed_pnl, time_ms, tick}`.
  A flip (long→short) is two fills (close then open). Keep the last 2000 fills.
- Order record: `{bot, coin, kind: "mirror"|"flatten", sz (signed), px, status: "filled"|"skipped", reason, time_ms, tick}`; keep last 2000.

---

## 3. Module interfaces (implement exactly these exports)

```js
// server/rng.js
export function makeRng(seed /* uint32 */) // → { next(): number in [0,1), normal(): number, range(lo,hi): number,
                                            //     int(lo,hi): integer inclusive, pick(arr): any, state(): any, setState(s): void }

// server/hyperliquid.js (read-only)
export class HyperliquidClient {
  constructor({ fetch, now, sleep, budget = 1000, timeoutMs = 8000, log })
  allMids() → {coin: px}  /  metaAndAssetCtxs() → {coin: {sz_decimals, max_leverage, delisted, mid_px, mark_px,
  oracle_px, prev_day_px, funding_1h, open_interest, day_ntl_vlm}}  /  candles(coin, startTime, endTime, {budget, deadlineMs})
  post(body, {weight, queue, budget, deadlineMs}); inBackoff(); weight60s(); snapshot() (request counters); stats
}
export class WeightLedger, HlError; export function candleWeight(n), parseCandles(raw), parseMetaAndAssetCtxs(raw)

// server/market.js
export const COINS            // array per §2.2 (frozen)
export function lastClosedMinute(ms), alignCandles(candles, startMs, len, prevClose?)
export class MarketFeed {
  constructor({ seed, source = 'sim', coins = COINS, log = console.log, startMs, warmupBars, hl?, fetch?, now?, sleep? })
  async init()                // sim: no-op. hyperliquid: meta + mids, then (fresh) the real warmup ending at the last
                              // closed minute → {ok, reason?}; never throws
  nextSync() / async next()   // ONE bar → { barIdx, timeMs, bars: { [coin]: {o,h,l,c} } } (real: consumes a staged bar)
  stage(seg) / clearStaged()  // real: queue closed bars (fetchClosed / fetchRange results)
  async fetchClosed(openMs)   // real: the bar that just closed (candle › mids › flat), not staged
  async fetchRange(from, to)  // real: candles for missed bars (null when HL is unreachable)
  async pollMids() / setLiveMids(px, tMs) / async refreshMeta()
  get barIdx() / get timeMs() / get source() / get real() / get coins() (the live listing)
  closes(coin)                // array-like of closes, oldest→newest (keep ≥ 20160 = 14 days)
  mid(coin)                   // last BAR close (tick reconciliation, population)
  livePx(coin)                // live mid while ≤ 15 s old, else the last close (out-of-tick fills, marks)
  clockMs() / tickTimeMs()    // fill stamps: real → wall clock / bar close; sim → market time
  change24h(coin)             // real: px / prev_day_px − 1; sim: close / close 1440 bars ago − 1; null if unknown
  change1h(coin)              // close / close 60 bars ago − 1
  coinInfo(coin)              // { coin, index, max_leverage, sz_decimals } (HL universe in real mode) or null if unlisted
  isStale(coin) / staleCoins()
  snapshot()                  // market op rows (§4)
  status()                    // { source, coins, ok, error, stale (count) }
  feedInfo()                  // { mids_ms, weight_60s, requests, last_ok_ms, backoff }
  serialize() / restore(obj)  // full deterministic state (rng, prices, history, regimes, venue info); refuses the other feed
}

// server/strategies.js
export const STRATEGY_NAMES   // ['momentum','mean_reversion','breakout','ma_cross','rsi_reversal']
export function signal(name, series, params) // → -1|0|1 ; `series` is the population's per-coin series object (engine-internal; document it in the file)

// server/population.js
export const ARCHETYPES       // array per §2.3: { name, family, mode:'algo', scale, fitness (text), leverage:[lo,hi], position_size:[lo,hi], stop_loss:[lo,hi], take_profit:[lo,hi], strategies:[...], count, max_drawdown, ruin_floor }
export class Population {
  constructor({ seed, total = 3000, coins })            // generates genomes deterministically
  get size()
  step({ barIdx, timeMs, bars, market })                 // paper-trade every bean one bar → { fills, exits:{liquidation,stop,target,max_hold,signal}, busted:[beanIds newly busted] }
  row(id)                                               // BeanRow (§4) or null — `tradeable`/`venue_*`/`bot` filled by the caller hook below
  setVenueHook(fn)                                      // fn(row) → { tradeable, venue_max_leverage, venue_reason, bot } — set by main from LiveLayer
  query(params)                                         // beans op: { rows, total, limit, offset, sort }
  detail(id)                                            // bean_detail op payload (§4) or null
  curves(ids)                                           // { [id]: [{h, equity}] }
  stats()                                               // { beans, by_archetype: [{archetype, count, busted, positioned, traded, best_return, mean_return}] }
  serialize() / restore(obj)
}

// server/engine.js
export class FeedUnavailableError extends Error   // a fresh real start could not warm up (main.js falls back to sim)
export class Engine {
  constructor({ config, journal })   // config: { seed, beans, feed, warmupBars, tickMs (sim), startMs?, fallback?,
                                     //   now?, fetch?, hl?, sleep?, timers?, maxReplayBars? (tests) }
  async start()                      // market.init(); fresh: warmup synchronously, one 'warmup_finished';
                                     // restored + real: replay / re-warm the gap ('feed_gap' reason restart) or hold
  tick({quiet, marks})               // one bar: market.nextSync → population.step → onTick hooks → 'tick_completed'
                                     // → onMarks hooks; re-entrancy guarded; returns the tick summary
  async advance(n)                   // sim fast-forward (the `tick` op); 409 with real prices
  run() / stop()                     // sim: setInterval(tickMs) (+ the 60 s real probe when a fallback);
                                     // real: minute timer at boundary + 2 s and the 5 s allMids poller
  async runMinute() / pollMids() / rewarm(reason, g) / probeReal()   // the scheduler steps (public for tests)
  onTick(fn)                         // fn(summary, engine), BEFORE tick_completed (the live layer mirrors here)
  onMarks(fn)                        // fn(marks, engine) after each allMids (~5 s, real) and every tick (both feeds)
  setVenueHook(fn)                   // population venue hook, re-applied after a re-warm
  canOpen(coin)                      // null | why new exposure waits (prices down, catching up, stale coin)
  feedState() / nextTickMs() / marks()
  get market() / get population() / get prices ('real'|'sim') / get catchingUp
  health() / status() / marketView() // op payloads (§4)
  serialize() / restore(obj)         // { market, population, tick, last_gap, ... }
}

// server/journal.js
export class Journal {
  constructor({ file = null, keep = 5000 })
  emit(kind, data)                   // record = { seq, t: Date.now(), kind, ...data } → appended, broadcast; returns record
  subscribe(fn) → unsubscribe        // fn(record)
  since(seq)                         // records with seq > given (for SSE Last-Event-ID)
  query({ kind, limit = 100, offset = 0 }) // newest first → { rows, total }
  serialize() / restore(obj)
}

// server/pulse.js
export class Pulse { publish(kind, data) → msg; subscribe(fn) → unsubscribe }   // in-memory only, never journaled

// server/live.js
export class ApiError extends Error { constructor(status, message) }   // also re-exported/used by http.js
export class LiveLayer {
  constructor({ config, engine, journal, now?, log? })   // config: { accountUsd, maxBots, maxBotCapitalUsd, minCapitalUsd, maxTotalNotionalUsd, minOrderUsd }
  afterTick(summary)                  // reconcile/mirror every active bot at the BAR close; auto-pause on bust;
                                      // bots on a stale coin are frozen
  markLive({px, stale, t})            // onMarks hook: liquidation checked on the LIVE mid, then mark (unrealized,
                                      // margin, notional, as_of); stale coins frozen
  marksPayload()                      // { bots: {id: {...}}, account: {...} } — the bot/account part of a `mids` frame
  venue(row)                          // → { tradeable, venue_max_leverage, venue_reason, bot } (used as Population venue hook)
  status()                            // live_status payload
  bots({ state })                     // { rows, total, mode }
  botDetail(id)                       // { bot, bean, fills, orders } or throws ApiError(404)
  fills({ bot, limit = 100 })         // { rows, total }
  create({ bean, capital_usd, confirm }) / pause({ id }) / resume({ id }) / close({ id }) / halt()
  serialize() / restore(obj)
}

// server/store.js
export function saveState(file, obj)   // atomic: write tmp + rename; creates dir
export function loadState(file)        // → obj or null (missing/corrupt → null, log)

// server/catalog.js
export const OPS   // [{ name, kind:'query'|'command', method, path, params:{ [p]: { type:'string'|'integer'|'number'|'boolean'|'array'|'object', required?, default?, enum?, maxLength?, description } }, description,
                   //    auth:'public'|'user'|'admin', sensitive:boolean, modes:['none','accounts']|['accounts'] }]
export const EVENT_KINDS, EVENT_FIELDS, STREAM_ONLY_KINDS (['mids']), STREAM_ONLY_FIELDS
export const ACCOUNTS_EVENT_KINDS, ACCOUNTS_EVENT_FIELDS, ACCOUNTS_STREAM_ONLY_KINDS, ACCOUNTS_STREAM_ONLY_FIELDS, VENUES
export const ERROR_CODES, ERROR_STATUS (code → HTTP status), DEFAULT_CODE_BY_STATUS, NONE_MODE_CODES; isErrorCode(code); findOp(name); opInMode(op, mode)
export function coerceParams(op, raw, { redact }) // → typed params or throws ApiError(400, code bad_request) (unknown param, bad type, enum, missing required). Booleans accept 1|true|yes|on / 0|false|no|off; arrays accept CSV or JSON array (a present-but-empty array, e.g. `ids=`, is an empty list — not "absent"); objects accept a JSON object (≤ 32 scalar keys). `redact` (sensitive ops) never echoes a value or an unknown name.
export function docsMarkdown({ version, commandPolicy: 'token'|'loopback'|'session' })

// server/http.js
export function createServer({ engine, live, journal, pulse, config, platform })   // → http.Server (not listening)
  // config.auth === 'accounts' selects the accounts pipeline (needs config.publicOrigin and platform {users, sessions,
  // gardens, …}; the full bag is documented at the top of http.js); anything else = the none-mode server of §4.
  // The server also carries closeStreamsFor({uid, sessionIds?, reason?}) (PLATFORM §12.2), beginShutdown(), streamStats().
  // /readyz checks that the data dir is writable: config.dataDir, else (accounts mode) the directory of platform.db.file.
export const SSE_LIMITS, RATE_LIMITS; export class TokenBuckets; export function packageVersion(), builtinCheckCsrf(),
  canonicalUsername(), parseAgentKey(), bucketKeyFor(), closeStreamsFor(ctx, opts)
```

The interfaces of the platform modules (Users, Sessions, checkCsrf, RateLimiter, clientIp, Secrets, Admin, Gardens,
Journal scoping, Pulse scoping, createTestnet, …) are frozen in PLATFORM §12.2.

---

## 4. HTTP API (brood-compatible subset)

- `GET /api/v1/<query>?…` → JSON. `POST /api/v1/<command>` with JSON body (query-string params also accepted).
  Wrong method → 405. Unknown op → 404. Errors are `{ "error": "...", "status": <code> }` with the same HTTP status.
- Response headers: `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`.
- `GET /api/v1` → `{ name: "bean-garden API", api_version: 1, version, command_policy: "token"|"loopback", operations: OPS }`.
- `GET /docs` → markdown generated from OPS (text/markdown).
- Static files from `web/` at `/` (index.html default = the 3D page; `/classic.html` = the 2D garden). Block path
  traversal and dotfiles (re-checked on the real path, which also catches Windows 8.3 aliases like `ENV~1`), correct
  content types, `Cache-Control: no-cache` + `Last-Modified`/304, and a CSP with `script-src 'self'` (no inline
  script / eval / import map) and `frame-ancestors 'none'`.
- `GET|HEAD /vendor/three/<path>` serves exactly `build/three.module.min.js`, `build/three.module.js` and `LICENSE` from
  `node_modules/three` (realpath must stay inside it) with the static headers; any other path, encoded character
  (`%2e%2e`, `%2f`, `%5c`, …), dotfile or missing file → 404. `script-src 'self'` covers it; the CSP is unchanged.

**Command auth** (stricter than brood — it had a CSRF hole: loopback exemption + `CORS *`):
1. A valid token (`Authorization: Bearer T` or `X-Brood-Token: T`, constant-time compare) → allowed from anywhere.
2. Otherwise allowed only if ALL: remote address is loopback, no proxy headers (`X-Forwarded-For`, `CF-Connecting-IP`,
   `X-Real-IP`, `Forwarded`), `Host` is `localhost|127.0.0.1|[::1]` (+port) (anti DNS-rebinding), and `Origin` is absent
   or equals the request's own origin.
3. Else 401 `{error:"command needs a token (or a same-origin request from loopback)"}`.
CORS: `Access-Control-Allow-Origin: *` on GET; OPTIONS preflight allows `Authorization, X-Brood-Token, Content-Type`
(token-bearing cross-origin clients still work; tokenless cross-origin commands fail rule 2).
Queries never need a token. Token from `--token` or env `BEAN_API_TOKEN` (16+ visible ASCII characters, no whitespace:
a browser can only send that in a header). Rule 1 checks BOTH headers (a proxy-injected `Authorization` must not hide a
valid `X-Brood-Token`). Rule 2 trusts the socket peer, so a plain TCP forward (ssh -R, socat) looks local:
`--no-loopback-commands` (needs a token) disables rule 2. Default host **127.0.0.1**.

### Platform additions (PLATFORM §8; none mode stays byte-identical apart from these)

- **None mode** (`--auth none`, the default): `GET /api/v1` adds `auth: "none"` and `testnet: {enabled: false}`; every op
  carries `auth`, `sensitive` and `modes`. New queries answer the implicit local player: `me` →
  `{mode:'none', user:{id:0, username:'local', role:'admin', created_ms:null, lang:null}, session:null, signup:'closed',
  testnet:null}`; `testnet_market` / `testnet_status` / `testnet_quote` answer their "disabled" shapes. Accounts-only
  ops answer `404 {error, status, code:'accounts_disabled'}`; `bot_create {venue:'testnet'}` answers
  `409 {…, code:'testnet_needs_accounts'}`; `venue:'paper'` is accepted and ignored. No other none-mode error gains a
  `code`. `/healthz` and `/readyz` exist in both modes.
- **Accounts mode** (`--auth accounts --public-origin https://…`): every request gets COOP/CORP/Permissions-Policy (HSTS
  over https) and a Host check (`421 misdirected`; `/healthz`, `/readyz` and `GET health` also answer on
  `127.0.0.1:<port>`). Commands: a non-empty query string → `400 query_params_not_allowed` **before the body is read**;
  then CSRF (`Content-Type: application/json` else 415; `Origin` = PUBLIC_ORIGIN or `Sec-Fetch-Site: same-origin` else
  403 `csrf`), the Bearer `ADMIN_TOKEN` rules (admin ops only, direct loopback only unless `ADMIN_TOKEN_REMOTE=1`, never
  `make_admin`/`remove_admin`), the session cookie (`__Host-bean_sid`, HttpOnly, SameSite=Lax), the access class
  (`public` | `user` → 401 `auth_required` / `session_expired` | `admin` → 403 `forbidden`), rate limits (429 with
  `retry_after_s` + `Retry-After`), a JSON body of ≤ 64 KB (4 KB for sensitive ops), params from the body only. Errors
  always carry a machine `code` from `ERROR_CODES` (none on a 500, which never echoes its message). CORS `*` only on
  public GET queries. Sensitive ops (`auth_*` with credentials, `account_*`, `testnet_connect`, `testnet_agent_approve`,
  `admin_user`) never log their params.
- **New ops** (shapes in PLATFORM §8.2–§8.6; `GET /docs` documents every param): `me`, `auth_signup`, `auth_login`,
  `auth_reset`, `auth_logout`, `auth_logout_all`, `account_password`, `account_delete`, `sessions`, `session_revoke`,
  `garden_rearm` (`REARM`, ≥ 60 s after a halt), `garden_reset` (`RESET`, a new paper season once per 24 h),
  `testnet_market`, `testnet_status`, `testnet_quote` (all three cache-only: they never spend Hyperliquid weight),
  `testnet_connect`, `testnet_verify`, `testnet_disconnect`, `testnet_agent_prepare` / `testnet_agent_approve` (P1),
  `admin_status`, `admin_users`, `admin_audit`, `admin_kill_switch`, `admin_testnet_signing`, `admin_caps`,
  `admin_user`, `admin_backup`, `dev_double` (only with `--testnet-double`). `bot_create` gains `venue`
  (`paper` | `testnet`; testnet needs `confirm:'testnet'`) and `ack_divergence`; `bots`, `bot_detail`, `live_status`,
  `live_fills` (+ `season`), `events`, `beans` and `bean_detail` (the `tradeable`/`bot` verdict) are scoped to the
  signed-in player; `tick` is admin only.
- **SSE in accounts mode**: a stream opened with a session gets the global records (`GLOBAL_KINDS`) plus that player's
  own; a spectator stream gets global records only (re-checked at the edge, fail-closed); `mids` frames get the
  subscriber's own `bots`/`account`/`testnet_account` attached at write time. `Last-Event-ID` replays global + own
  records in seq order, or answers `event: resync` when it is too old. Stream-only control frames (no `id:`):
  `session_ended {reason}` (every revocation ends the session's streams in the same tick), `resync`, `server_restart`.
  Limits: ≤ 5 streams per player, ≤ 20 per IP, ≤ 2,000 in all (spectators ≤ 1,000), an open costs 10 query tokens;
  ≤ 128 KB queued per stream and ≤ 64 MB in all (the largest queue is dropped first). New record kinds:
  `bot_sync`, `bot_fill_confirmed`, `testnet_account`, `credential_status`, `garden_rearmed`, `garden_reset`,
  `password_reset` (per player) and `kill_switch`, `testnet_feed` (global).
- **BotRow in accounts mode** carries the PLATFORM §8.5 fields (`venue`, `price_source`, `asset`, `closing`,
  `exchange_sync` (its `attempts` counts the failed tries of the current op), `exchange`, `size_ratio`, `target_szi`,
  `fill_state`, `funding_realized`, `fees_estimated`, `est`, `dust`, `note_code`, `note_vars`, `season`) plus, as an
  integration addition, `last_error_code` / `last_error_vars`: the machine code (and vars) of `last_error`, the same
  code the `live_error` event carried, so a client that reloads can still localize the error (§9.5).

### Queries
| op | params | returns |
|---|---|---|
| `health` | – | `{ok, version, tick, bar_idx, beans, now_ms, market_time_ms, uptime_s, feed (source string), prices: 'real'\|'sim', paper: true, feed_state: 'live'\|'delayed'\|'down'\|'sim', daemon:{running, tick_ms (real 60000), aligned (real true), next_tick_ms}}` |
| `status` | – | health + `{from_snapshot, last_tick_duration_ms, last_tick_ms, population: stats(), feed: FeedStatus}` |
| `meta` | – | `{archetypes: ARCHETYPES, strategies: STRATEGY_NAMES, coins: market.coins (the live listing: HL szDecimals/maxLeverage with real prices), scales:{sharpe, return, return_dd2}, columns:{…glossary}, sort_keys, events: EVENT_KINDS, stream_only_events: ['mids']}` |
| `market` | – | `{market_time_ms, feed_ok, coins: snapshot() + {beans, positioned}}` — see CoinRow below |
| `beans` | `archetype, busted, coin, strategy, in_position, tradeable, distinct_coin, trades_min, ids, sort (default -fitness), limit (100, max 1000), offset` | `{rows: BeanRow[], total, limit, offset, sort, venue:{known:true, network:"sim"}}` |
| `bean_detail` | `id*` | `{bean: BeanRow, genome:{…all params}, describe, curve:[{h,equity}], trades:[{bar, time_ms, action:"open"\|"close", side, px, units, pnl, reason}] (last 50)}` |
| `equity_curves` | `ids*` (≤50) | `{capital: 1000, curves: {"<id>": [{h, equity}]}}` |
| `bots` | `state` | `{rows: BotRow[], total, mode:"sim"}` |
| `bot_detail` | `id*` | `{bot: BotRow, bean: BeanRow, fills: Fill[], orders: Order[]}` |
| `live_status` | – | see below |
| `live_fills` | `bot, limit (100)` | `{rows: Fill[], total}` newest first |
| `events` | `kind, limit (100), offset` | `{rows, total}` newest first |

`sort` keys: `fitness, total_return, ret_7d, ret_1d, ret_1h, sharpe, trades, equity, max_dd, id` with optional `-` for
descending. `distinct_coin=true`: per coin only the best bean by `sort` survives, then paging. `in_position=true`
→ side ≠ 0. `tradeable=true` → venue hook says tradeable.

**BeanRow** `{id, archetype, family, mode, strategy, coin, leverage, position_size, lookback, entry_threshold, stop_loss, take_profit, cooldown_bars, min_hold_bars, max_hold_bars, equity, total_return, ret_1h, ret_1d, ret_7d, sharpe, max_dd, trades, win_rate, fitness, busted, breached, in_position, side, units, entry_px, tradeable, venue_max_leverage, venue_reason, bot}`

**BotRow** `{id, index, bean, coin, capital_usd, leverage, state, created_ms, updated_ms, closed_ms, bean_side, bean_units, bean_equity, target_sz, sz_decimals, fills, orders, volume, fees, realized_pnl, notional_usd, last_error, last_error_ms, last_reconcile_ms, note, mark_px, mark_ms, price_stale, real:{szi, entry_px, unrealized_pnl, margin_used, liquidation_px, leverage, as_of_ms}}`

**live_status** `{mode:"sim", network:"sim", dry_run:false, armed, halted, halted_ms, disabled_reason, bots, active, paused, closed, deployed_usd, open_notional_usd, realized_pnl, unrealized_pnl, last_reconcile_ms, last_error, last_error_ms, fills_logged, exchange_stops:false, caps:{max_bots, max_bot_capital_usd, min_capital_usd, max_total_notional_usd}, account_state:{account_value, withdrawable, total_margin_used, total_ntl_pos, as_of_ms}, universe:{coins, fetched_ms}, account_usd, available_usd, prices: 'real'|'sim', paper: true, stale_coins}` (`mode`/`network` stay `"sim"`: the exchange is paper even when prices are real)

**FeedStatus** (`status.feed`) `{source, coins, ok, error, stale (count), real, state: 'live'|'delayed'|'down'|'sim', stale_coins, fallback: null|{from:'hyperliquid', reason, since_ms}, real_available: null|boolean (sim fallback only), mids_ms, mids_age_ms, last_bar_close_ms, next_tick_ms, lag_bars, bar_sources:{candle, mids, flat} (last bar), weight_60s, last_gap: null|{bars, mode:'replay'|'rewarm', from_ms, to_ms, at_ms}, requests:{allMids, metaAndAssetCtxs, candleSnapshot, errors, rate_limited, skipped}|null}` — sample: `test/fixtures/status-real.json`

**CoinRow** (`market.coins[]`) `{coin, index, mid, change_24h, bars, stale, max_leverage, sz_decimals, px, px_ms, close, change_1h, prev_day_px, funding_1h, mark_px, oracle_px, open_interest, day_ntl_vlm, source, beans, positioned}`: `px`/`px_ms` = the latest live mid (sim: the last close at its tick time) and `mid` = `px`; `close` = last bar close; `change_1h` = close / close 60 bars ago − 1; real `change_24h` = px / prev_day_px − 1; the HL day stats are null in sim (`funding_1h` is info only, never charged) — sample: `test/fixtures/market-real.json`

### Commands
| op | body | returns |
|---|---|---|
| `bot_create` | `bean* (integer), capital_usd* (number), confirm (string, ignored in sim)` | BotRow |
| `bot_pause` / `bot_resume` / `bot_close` | `id*` | BotRow |
| `bots_halt` | – | `{halted:true, closed:[ids], realized_pnl}` |
| `tick` | `n (integer 1..1440, default 1)` | last tick summary — **sim feed only**; with real prices always 409 `"tick is only available with the sim feed — real prices run at market speed"` |

Paper fills (all commands and ticks): out of a tick (create, pause, resume, close, halt) the bot fills at
`market.livePx` (the live mid) and `time_ms` = wall clock (real) / market time (sim); tick and replayed fills use the
bar close and `time_ms` = the bar's close time (real) / market time (sim). With real prices `bot_create` and
`bot_resume` answer 409 while prices are down, while missed minutes are being caught up, or on a stale coin;
pause and close always work (they fill at the last real price).

### SSE — `GET /api/v1/events/stream`
Headers: `text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
Flush immediately: first write `retry: 3000\n: hello\n\n`. Keep-alive comment `: ping` every 15 s. Each journal record
→ `id: <seq>\nevent: <kind>\ndata: <json record>\n\n`. Honour `Last-Event-ID` (replay `journal.since`). Clean up on close.
The same stream carries **ephemeral pulse frames** (`server/pulse.js`) written **without an `id:` line**: they never
move `Last-Event-ID`, are never replayed, are not journaled and are not returned by `events`. Today there is one:

```
event: mids
data: {"kind":"mids","t":…,"source":"hyperliquid"|"sim","prices":"real"|"sim","px":{coin: live mid, …16},
       "px_ms":{coin: time of that price, …},"stale":[coins],
       "bar":{"tick","time_ms","next_tick_ms"},
       "bots":{"bot-0003":{szi, entry_px, mark_px, unrealized_pnl, realized_pnl, margin_used, liquidation_px, notional_usd, price_stale, as_of_ms}},
       "account":{account_value, unrealized_pnl, realized_pnl, available_usd, deployed_usd, open_notional_usd}}
```
sent after each successful allMids (~5 s, real) and after every tick (both feeds; once per fast-forward), ≈ 0.5–1.5 KB
(sample: `test/fixtures/mids.json`).

### Journal / SSE event kinds (exact names)
`warmup_finished {bars, ms}`, `tick_completed {tick, bar, time_ms, dur_ms, fills, busted, exits}`, `busted {bean, archetype, coin, equity}`,
`bot_created {bot, bean, coin, capital_usd, leverage}`, `bot_order {bot, coin, order_kind, sz, px, status, reason}` (the order's kind travels as `order_kind` because a record's `kind` is the event name),
`bot_fill {bot, coin, dir, sz, px, fee, closed_pnl, time_ms, tick, liquidation?: true}`, `bot_paused {bot, reason}`, `bot_resumed {bot}`,
`bot_closed {bot, realized_pnl}`, `live_error {bot, error}`, `live_halted {closed}`, `daemon_started {pid, version}`,
`feed_status {state, prev, source, stale_coins, lag_bars, error, fallback}` (on a state or stale-set change; at start with
real prices or a fallback), `feed_gap {from_ms, to_ms, bars, mode: 'replay'|'rewarm', reason: 'restart'|'outage'}`.
`tick_completed` also carries `closed_ms` (bar close), `next_tick_ms` (wall time of the next bar; null when a sim engine
is not looping) and `source`. A replay emits ONE `tick_completed` (for its last bar).

---

## 5. Frontend experience (web/) — parity with the studied garden, our own code and art

Read `BROOD-STUDY.md` §6.8 and §8 (garden) and `reference/brood-site/games/garden.html` for BEHAVIOUR only.
- **Header**: title + subtitle, signs: mode (`sim`), **barn** (account_value), **water out** (deployed_usd), **harvested**
  (realized_pnl, coloured), **growing** (unrealized_pnl, coloured), **plants** (active). Weather badge. Language toggle EN/TH.
  Token box (input + save; shows "token saved" / "loopback only"). `?token=` is stored then **removed from the URL**
  with `history.replaceState`.
- **Seed shelf**: filters (variety = archetype, sort by total return / 7-day / Sharpe, "sprouting now" = in_position,
  restock). Shows top 5 via `beans?tradeable=true&distinct_coin=true&busted=false&trades_min=1&limit=5&sort=…` (drop
  `tradeable` if live is halted). Packet = coin, archetype · strategy · leverage, sparkline from `equity_curves`
  (baseline 1000), return coloured, fills count, position; planted packets dimmed.
- **Field**: ≥ 8 plots (more if more open bots). Pick a packet then click an empty plot, or drag a packet onto a plot,
  or keyboard (Enter/Space). Plant modal: variety, paper return, **water** slider 20..1000 step 10 (default 100), note
  "the bot mirrors X% of the bean ≈ $Y notional per entry" (= stake/1000 of `position_size × leverage × equity`), plant / cancel,
  inline error. Plot card: tag (coin · bot id), tools (⛱ pause / ☀ resume, 🧺 harvest if PnL ≥ 0 else 🪓 pull — confirm dialog
  showing PnL), animated canvas plant, phase + PnL label, water + fills + "updated ago".
- **Growth model** (keep exactly): f = (realized + unrealized)/capital;
  `size = clamp(0.25 + 6f + (phase==='waiting' ? 0 : 0.1), 0.12, 1)`, `health = clamp(1 + 8f, 0, 1)`.
  Phases (from bot): closed / paused / error / waiting (bean flat & szi 0) / entering (bean side ≠ 0, szi 0) / long / short.
  waiting|entering → seed with a sprout + caption. Fruit when f > 0.02 and health > 0.6 (1 per 2%, max 6). Flower when
  health > 0.4. Captions: "dying — pull it? 🪓" (health < 0.2), "wilting…" (< 0.5), "ripe — harvest? 🧺" (f > 0.05),
  "in the shade" (paused). Sway animation with requestAnimationFrame; respect `prefers-reduced-motion`.
- **Weather**: mean `change_24h` over market coins → ☀ sunny (> 1%), ⛅ mild (> −1%), 🌧 rainy (> −3%), ⛈ storm; refresh 120 s.
- **Diary**: timestamped log, newest first, max 60 lines: planted, harvested/pulled (banked $), shaded, sun, 💧 fills, ⚠ errors,
  🌅 "a new minute: tick N" (throttle: at most one tick line per 10 s).
- **Burn the field** → confirm → `bots_halt`. **Time-lapse** button "⏩ +1h" → `tick {n:60}` (sim only).
- **Live**: SSE via `EventSource`; on `bot_fill` glow the plot + refresh; on `tick_completed` refresh field (debounced); on
  other `bot_*`/`live_*` refresh. Poll `tend()` every 20 s as fallback; `?nostream=1` disables SSE.
- Past harvests line (closed bots with realized PnL). Error line for live `last_error`.
- **Security**: escape every interpolated value (`esc`) or use textContent; no inline event handlers; CSP-friendly (no eval).
- **Responsive** (works at 360 px wide; 16 px gutters; no horizontal scroll), keyboard accessible, focus styles, aria labels,
  dark wood/soil/night-sky theme like the original but our own drawing.
- `brood-api.js` (ES module): base URL resolution `?api=` → `localStorage["brood.api"]` → `<meta name="brood-api">` → same
  origin; token in `localStorage["brood.token"]` for the page's own origin and `localStorage["brood.token@<api origin>"]`
  for any other (one origin can never read or overwrite another's). An API on another origin chosen by a `?api=` link
  gets no token silently: `?token=` in such a link is stripped but not adopted, and a typed token needs the user to
  confirm the host (shown next to 🔑); bases with `\` or path bases off this origin are refused;
  `query(name, params)` (GET, 30 s timeout, throws `Error(server message)` with `.status`, `.code`, `.retry_after_s`),
  `command(name, params)` (POST JSON, Bearer token in none mode, resolves to body even on error), `stream(onEvent)`.
  Accounts mode (PLATFORM §9.5): `getMode()` asks the page's own origin first and, when it runs accounts, locks the API to
  that origin (`?api=` / stored / meta bases elsewhere are ignored with a console notice); the token functions are inert;
  fetches send cookies same-origin; commands carry only `Content-Type` + `Accept`; a 401 `auth_required` /
  `session_expired` dispatches `auth:required` on the bus given to `attachBus()` — except for a request that carried
  the old cookie while a session-changing command (`SESSION_CHANGING_OPS`: sign-up/in/out, reset, password change,
  delete) was in flight, whose 401 is stale; `authSettled()` resolves once none is in flight; `signup` / `login` /
  `logout` / `logoutAll` / `resetPassword` wrap the auth commands; `restream()` reopens the stream after a sign-in or
  sign-out. `core/data.js` confirms a `session_ended` frame with `me` (after `authSettled()` + 600 ms): the same
  player still signed in (a password change hands out a fresh cookie) → keep the player and reopen the stream; nobody →
  clear the player and emit the `sessionEnded` game event (the gate, the diary).

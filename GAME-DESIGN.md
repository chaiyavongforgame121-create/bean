# Bean Garden 3D: game design and build contract

**Status:** binding contract for the parallel build (5 engineers). Where this document and `SPEC.md` disagree,
this document wins for everything it names, and `SPEC.md` is updated to match (WP1 owns that edit).

**Platform upgrade (accounts, Hyperliquid TESTNET, many players):** [`PLATFORM.md`](PLATFORM.md) §9 is the binding
contract for the frontend from that build on, and wins over this document for everything it names: the farm gate,
the account menu, the testnet connect panel, the plant dialog's venue choice, PAPER / TESTNET badges, both ledgers in
the barn popover, localized error and note codes, accounts-mode copy, and the "really playable" checks QA-01…QA-21
(§9.8). The Juice Contract (J1–J12) still applies, with the per-venue readings of PLATFORM §9.6. None mode
(`--auth none`) keeps everything below as written.

**One line:** a cozy, procedural, low-poly floating-island farm in three.js. Every crop is a paper-trading bot
priced by the **real** Hyperliquid market. The game layer makes watching a position pleasant. It never decides
what the numbers mean.

**Direction chosen:** the *Diorama* proposal is the base (both judges' winner: best honesty architecture,
bounded scene, best feasibility). It is grafted with *Juicy*'s game feel and engineering, and with *Living*'s
life layer and testable rules. §1.4 lists every graft and every rejection.

Notation used throughout:
- **P0** must ship, **P1** should ship, **P2** ship only if time allows. §11.6 gives the cut order.
- **RM** means the reduced-motion variant (see §7.3).
- `u` means world units (1 u ≈ 0.5 toy-metre).
- All times are in ms unless they are marked s.
- "Mark" means the latest real mid price (§10.4).

---

## 1. Vision, pillars, and the trading↔farming mapping

### 1.1 Vision

The player holds a small floating island in a pale morning sky. A windmill turns once per real minute, water
runs from a pond up to a water tower, and ten wooden planter boxes sit in two rows. Each box holds a crop
belonging to one coin: an orange tree for BTC, a sunflower for SOL, corn for DOGE. Each crop is a live paper
trade at the real Hyperliquid price.

- The crop swells, flowers and fruits as the trade gains, and droops, yellows and browns as it loses.
- A bluebird sits on LONG signs and a mole digs beside SHORT ones.
- Pip the scarecrow teaches the rules, and a small farmer walks out to dig, water and harvest.
- A paper badge that cannot be hidden says **REAL PRICES · PAPER TRADES**.
- Every plot always shows its real price, side, leverage, distance to liquidation and P&L in $ and %.

Trading is anxious, and farming is patient. The island's job is to make the patient part pleasant: plant a
strategy, water it with capital, tend it, and decide when to harvest. It must never blur the anxious part,
which is risk and loss.

### 1.2 Pillars (every feature must serve at least one, and may not break any)

1. **Real and honest.** Prices are real, trades are paper, and every number is the server's number with its
   age. Losses look like losses (§1.3).
2. **A real farm game.** The island has its own life: wind, weather, day light, critters and a farmer. Juicy
   moments (planting, watering, harvesting) are physical and satisfying.
3. **Calm at market speed.** One bar per real minute and a mark every ~5 s. Nothing fakes speed in real mode.
4. **Readable at a glance.** Shape, word and colour channels are separate, and the plot dock reads like a
   watch-list.
5. **For everyone.** EN/TH, touch-first phones, keyboard and screen reader, reduced motion, and a classic 2D
   fallback.

### 1.3 The Juice Contract (non-negotiable rules)

These are enforced by pure functions in `core/rules.js` and `fx/director.js` with Node tests (§11.4). Any
effect that would break a rule is a bug.

| # | Rule |
|---|---|
| J1 | **One source of truth.** Every number shown (3D label, chip, HUD, dialog) comes from the store, which holds the server's values. Client estimates appear only when the server value is missing, and are prefixed `≈`. |
| J2 | **Numbers first.** A number changes in the DOM the moment data arrives (t = 0). Animation is decoration that may lag ≤ 3 s, but it never delays, interpolates, counts up or hides a money value. The ticker's digit flip shows only the old and the new value, ≤ 300 ms. |
| J3 | **Server first.** No outcome is animated before the server reports it. Commands show a *pending* loop; results play on the HTTP 2xx or the SSE echo; failure plays a dust puff plus an inline error. |
| J4 | **Losses look like losses.** Coins, sparkles and the rising "harvest" chime happen only when realized P&L > 0. A close with P&L < 0 is a *pull*: brown clumps go to the compost heap, the number is red with ▼, and the sound is neutral. Lost fruit browns, drops and stays visible for 10 s. |
| J5 | **Harvest does not grow the barn.** `account_value = start + realized + unrealized`, so closing a position moves money from *growing* to *harvested*. The barn total changes only by the closing fee. Never animate account value upwards on harvest, or downwards on pull. |
| J6 | **Colour channels are separate.** Green/red = money (P&L) only. Blue (#2B6CB0) / violet (#7B4FC4) = side (LONG/SHORT) only. Amber = warning/risk. Price direction is neutral ink with ▴/▾. Every colour cue also has a word or a shape. |
| J7 | **Risk is always visible.** Every positioned plot shows side (word + arrow shape), leverage (×N) and liquidation distance, both in the DOM dock and in the 3D world. Zooming out compacts them, never hides them. |
| J8 | **No rewards for activity.** No XP, achievements, streaks, daily gifts, loot, or celebrations for opening or holding positions. Nothing is unlocked by trading. |
| J9 | **PAPER is always on screen.** The mode badge cannot be dismissed. SIM prices are labelled on the badge, the signpost, the ticker and every price. |
| J10 | **Confirms state the money.** Harvest, pull, shade-with-position and burn dialogs show side, size, current price, estimated $ and % after fees, and the words "paper fill". Default focus is on the safe button. |
| J11 | **Symmetric feedback.** The ~5 s marks retarget the plant's springs (the growth formula) and nothing else: no per-mark sparkles, no dust. Gains and losses get equal visual weight. |
| J12 | **Neutral nudges.** Captions never push a trade decision. "Ripe: harvest or keep growing" (not "harvest now!"). "Dying: consider pulling". |

### 1.4 Grafts and rejections (decision log)

**Base (Diorama):**
- Floating-island diorama; landmarks as metaphors; colour channels; number ages and `≈`; the "never animate
  unconfirmed" rule.
- Compost heap and crates; liquidation stump; windmill bar clock; sim-only sundial.
- Per-plot director queues with 400 ms fill coalescing; coin buckets by $.
- Single three.js shim with no import map; DOM-only text; settings set.

**Fixes to the base (judges):**
- The island no longer bobs. It forced per-frame shadow re-renders and made shadows swim; ambient motion
  moves to clouds, grass and critters instead.
- Crops get `customDepthMaterial`, so their shadows bend with them.
- The post render target uses MSAA `samples`.
- A portrait/safe-area framing rule uses `camera.setViewOffset`.
- The liquidation maths is unit-tested (10× → 9.5% from entry, §11.4).

**Grafted from Juicy:**
- The Juice Contract with `rules.js` tests.
- Pond (free cash) → pump → water tower (deployed). Water flows back on close.
- A silo with a painted *start* line.
- A big `×N` leverage stake, fertilizer sacks by leverage tier (hazard stripes ≥ 25×), and a leverage shiver.
- A liquidation thermometer stake with "price must fall X% to liquidate".
- Pip the scarecrow, as guide and empty-state voice.
- Drag-a-seed-onto-a-bed and a long-press radial (P1).
- A yaw-clamped, pan-first farm camera; 56 px mobile action buttons.
- DOGE popcorn harvest; WIF knit-hat mushroom.
- Thai glosses (ได้กำไรเมื่อราคาขึ้น/ลง).
- A colour-blind palette; the OFFLINE badge; "final number can differ slightly".
- Burn resolves plot by plot with real numbers.
- GPU-ballistic particle pool with a procedural atlas; quality tiers that only step down.

**Grafted from Living:**
- A non-blocking walking farmer (P1, first big cut).
- Day/night as an opt-in setting (default *always day*); in sim it follows market time.
- Market *wind* = volatility (mean |1h change|) and a gust on big real moves.
- J2 "numbers at t = 0".
- Plant dialog: worst case = whole margin, fees for open and close, funding shown as *info only*, planting
  blocked on a stale coin.
- Server-side liquidation checks on the 5 s marks.
- A list-view `<table>` twin (P1).
- Lightning only on the far hills, with a luminance cap; neutral *ripe* copy.
- A pure-reducer director; rate-limit arithmetic for Hyperliquid.

**Rejected:**

| Idea | Why it is rejected |
|---|---|
| Green/red side pennants (Juicy) | Breaks J6. |
| Amber SHORT (Living) | Collides with warning amber. |
| Barn counting up/down on close (Juicy, Living) | Breaks J5. |
| Asymmetric 5 s sparkles/dust (Juicy) | Breaks J11, slot-machine feel. |
| Almanac, stickers, achievements (Juicy) | Breaks J8. |
| Mound/trench beds | One judge: a trench reads as "losing". The arrow sign already gives a shape cue. Saves morph-target work. |
| Island bob | Shadows swim, no on-demand rendering. |
| Generative music | Scope. |
| A* path-finding farmer | BFS on a 20-node graph is enough. |
| River boat per bar | The windmill already is the bar clock. |
| Text drawn into WebGL textures | Not translatable, blurry Thai. |
| Import maps / three addons | CSP would need a hash; brittle. |
| Synthetic per-coin price fallback in real mode | That is a fake price. Real mode waits, freezes or replays instead (§10.6). |
| Auto-switching sim → real at runtime | It would mix sim positions with real prices. A restart is required, and the UI says so. |

### 1.5 The trading↔farming mapping (every op, event and field)

**Queries and commands**

| API (op / route) | Game element | Notes |
|---|---|---|
| `health` | boot check; clock skew (`now_ms`); feed kind (`feed`, `prices`) | Polled at boot and every 30 s with `status`. |
| `status` | mode badge, signpost, sundial visibility, windmill countdown, "prices delayed/down" banners | Uses `feed.*` (§10.5). |
| `meta` | coin listing (`sz_decimals`, `max_leverage`) for price/size formatting, archetype list for the catalogue filter | Loaded once, and again on `daemon_started`. |
| `market` | ticker, market board, weather (sky), wind (grass, windmill speed), coin `prev_day_px`/`funding` | Every 60 s (real) / 30 s (sim). Live prices come from `mids`. |
| `beans?…&distinct_coin=true&limit=5` | **seed stall**: 5 sachets on the plank; seed catalogue cards | Existing `shelfQuery()`. |
| `equity_curves` | sparkline on each seed card | Baseline 1000. |
| `bean_detail` | "more" disclosure on a catalogue card (genome, last trades) | P2. |
| `bots` (all states) | plots: open bots = planted boxes; closed bots = crates (P&L ≥ 0) / compost (P&L < 0) totals | `tend()` (§9.6). |
| `bot_detail` | plot inspector: last fills, orders | Fetched when the inspector opens and on that bot's `bot_fill`. |
| `live_status` | barn, silo, pond, tower, *growing*/*harvested* signs, plant count, burned field, room under caps | `tend()`. |
| `live_fills` | not used by the 3D page (the inspector uses `bot_detail`) | – |
| `events?limit=100` | diary backfill on page load | P1. |
| `bot_create {bean, capital_usd}` | **plant + water** (dig, seed drop, water pipe flow) | Pending loop until 2xx (J3). |
| `bot_pause` / `bot_resume` | **shade** (parasol unfolds) / **sun** (parasol folds, sunbeam) | |
| `bot_close` | **harvest** (P&L ≥ 0) / **pull** (P&L < 0) | Confirm dialog (J10). |
| `bots_halt` | **burn the field** at the fire pit | Checkbox confirm. |
| `tick {n:60}` | **sundial** time-lapse +1h | Sim only. The sundial does not exist in real mode, and the server returns 409. |

**Events (SSE)**

| Event (SSE) | Game element |
|---|---|
| `tick_completed` | windmill kick and countdown reset; soil shimmer ripple; market board flip; debounced `tend()` |
| `bot_created` | water flows pond → tower → plot; sprout pops (if not already played from the 2xx) |
| `bot_fill` | splash ring at the plot plus a floating DOM label (`Open Long 0.00500 BTC @ $82,410.0`); a flip rotates the sign and swaps bird ↔ mole |
| `bot_order` (`status: skipped`) | red "cap" tag on the tower valve and an amber chip note |
| `bot_paused` (`reason`) | `manual` → parasol; `bean busted` → crossed-out sachet nailed to the post plus parasol; `liquidated` → hail, stump and a "LIQUIDATED −$X" sign |
| `bot_resumed` | parasol folds and flies off, sunbeam |
| `bot_closed` (`realized_pnl`) | harvest (coins → crates) or pull (clumps → compost); water flows tower → pond |
| `live_error` | "!" A-frame sign springs up; mailbox flag up |
| `live_halted` | ember wave across rows, charcoal soil, stall shutters close |
| `busted` (a shelf or planted bean) | sachet tilts and drops from the stall; planted → see `bot_paused` |
| `warmup_finished` / `daemon_started` | diary line; full refresh |
| `feed_status` *(new, §10.7)* | badge, signpost, sundial, fog on stale-coin plots, diary line |
| `feed_gap` *(new)* | diary "caught up N missed minutes"; replayed fills are applied without animation |
| `mids` *(new, ephemeral)* | ticker digits; plant springs retarget; chips' P&L; liquidation thermometers; pond/tower levels; gust detection |

**Fields**

| Field | Game element |
|---|---|
| `account_state.account_value` | **Barn** sign; **silo** fill |
| `account_usd` | the silo's painted **start line**; the "vs start" % on the barn chip |
| `available_usd` | **Pond** water level (free cash to plant with) |
| `deployed_usd` | **Water tower** tank level |
| `realized_pnl` / `unrealized_pnl` | *Harvested* / *Growing* signs |
| `active`, `caps.max_bots` | *Plants n/max*; slot count |
| `open_notional_usd`, `caps.max_total_notional_usd` | tower tooltip "room"; plant dialog room note |
| `halted` | charred field, closed stall, burn button disabled |
| `last_error` | mailbox flag, error banner line |
| BotRow `state`, `note`, `last_error` | plot FSM state (§3.5) |
| BotRow `real.szi` sign | arrow sign up/down; bluebird or mole |
| BotRow `leverage` | `×N` stake, fertilizer sacks, shiver |
| BotRow `real.entry_px` / `mark_px` / `real.liquidation_px` | thermometer stake; inspector |
| BotRow `capital_usd` | "water" on chip, inspector, drip-line width |
| BotRow `realized_pnl + real.unrealized_pnl` | f → size, health, fruit, flower (§3.4) |
| BotRow `price_stale` *(new)* | fog bank over the plot; plant frozen; chip "price delayed" |
| BeanRow `archetype` → family | planter-box material and trim colour |
| BeanRow `coin` | crop species (§3.1) |
| BeanRow `side`, `entry_px`, `total_return`, `ret_7d`, `max_dd`, `win_rate`, `trades`, `leverage`, `venue_max_leverage`, `strategy` | seed card and plant dialog |
| market `change_24h` (mean) | sky weather: ☀ > 1%, ⛅ > −1%, 🌧 > −3%, ⛈ otherwise (existing `weatherOf`) |
| market `change_1h` (mean of \|x\|) *(new)* | wind strength |
| market `funding_1h` *(new)* | shown on the board and dialog as "info only, not charged" |

---

## 2. World layout, landmarks, camera framing

### 2.1 Axes and scale

- **Axes:** `+X` is east (right on the default view), `+Y` is up, `+Z` is south (toward the default camera).
  North is `−Z`.
- **Island:**
  - Top surface: a disc of radius **21 u** at `y = 0`, rim noise ±0.6 u.
  - Underside: an inverted cone down to `y = −9`, with strata vertex colours and 6 hanging rocks.
  - Cloud layers at `y ∈ [−12, −4]` (below) and `y ∈ [14, 20]` (above, sparse).
- **The island is static** (no bob). The shadow map is fitted to it.

### 2.2 Map (top-down, north up; coordinates are landmark centres in u)

```
 z        x: -20      -15      -10       -5        0        5       10       15       20
-20  .  ·  ·  ·  ·  ·  ·  ~ ~ ~ cloud layer ~ ~ ~  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  .
-16              .-'''''''''''''''''''''''''''''''''''''''''''''''''''-.
-14            /           (−8,−13.5)    [BARN (0,−13)] [SILO (4.5,−14)]   \
-13           /  [WINDMILL]  ◷SUNDIAL*  ┌──────────┐  ║start line║         \
-11          |   (−12,−11)              │  sign:   │  ║          ║  [TOWER] |
-10          |   bar clock      [CRATES]│  $10,042 │[COMPOST]       (13,−8) |
             |                  (−4.5,  └──────────┘ (5.5,−10.5)    tank =  |
 -8          |                   −10.5)        farmer home (−3,−10) deployed|
 -6  .      |    PIP (−12.5,−5)  ═══════════ gravel ring path ══════════╗ pipes|
 -4         |   scarecrow       ║ ┌─────┬─────┬─────┬─────┬─────┐     ║ to    |
 -2.2       | [SEED STALL]      ║ │ 01  │ 02  │ 03  │ 04  │ 05  │     ║ boxes |
  0         |  (−16,0) faces E  ║ ├─────┼─────┼─────┼─────┼─────┤ [PUMP]  [POND] |
 +2.2       |  5 sachets        ║ │ 06  │ 07  │ 08  │ 09  │ 10  │(13,0.5) (15,3)  |
 +4.4       |                   ║ └─────┴─────┴─────┴─────┴─────┘  r=3.2 free cash|
 +6.6       |  (row 11–15 only when slotCount > 10; grid recentres, §2.3)          |
 +8         | [MARKET BOARD]    ╚═══════════════╦═══════════════════╝             |
             |  (−15,8) faces NE               ║                                 |
+12          \   [MAILBOX] (−7,12)            ║          [FIRE PIT + torch] (8,12.5)
+14           \                                ║                               /
+15.5          `-.            [SIGNPOST (0,15.5)] "REAL PRICES · PAPER"      .-'
+17                `''''''''''''''''''''''''''''''''''''''''''''''''''''''''`
                                        S  ← default camera (yaw 0)
                * sundial exists only when prices are simulated
```

### 2.3 Field grid (`world.slotPosition(i, count)`)

- `slotCount = clamp(max(10, caps.max_bots, openBots), 10, 15)`.
  - The default `max_bots = 10` gives 2 rows of 5.
  - At most 15 plots are drawn. Extra open bots exist only in the dock/list, with a note (`g.dock.hidden`).
- Box footprint is 3.4 × 3.4 u, the rim is 0.45 u high, and the pitch is 4.4 u (1.0 u gap).
- Columns `c = 0..4` sit at `x = −8.8, −4.4, 0, 4.4, 8.8`.
- Rows: `rows = ceil(slotCount / 5)`, `z_r = −(rows − 1)·2.2 + r·4.4`. Two rows sit at `−2.2, +2.2`; three
  rows at `−4.4, 0, 4.4`.
- Slot `i` (0-based) is at `r = floor(i / 5)`, `c = i % 5`. Labels are 1-based ("Plot 01"), with slot 1 at the
  back-left.
- Each plot has a *stand point* for the farmer at `(x, 0, z + 2.3)` and a label anchor at `(x, 2.6, z)`.

### 2.4 Landmarks

All landmarks are procedural (§9.8). Each has an invisible pick proxy box and a DOM tooltip
(`g.lm.*`, §7.5).

| Landmark (id) | Pos (x, z) / facing | Meaning (data) | Interaction | Pri |
|---|---|---|---|---|
| Seed stall `stall` | (−16, 0) faces +X | seed shelf: top 5 beans, one per coin (`beans`) | opens the seed catalogue; sachets lift when selected in the DOM | P0 |
| Planter boxes `plot:i` | grid §2.3 | one plot = one bot | select / inspect / plant | P0 |
| Barn `barn` | (0, −13) faces S, 6 × 4.5, h 5.5 | account value (DOM sign anchored on the gable) | opens the money popover | P0 |
| Silo `silo` | (4.5, −14), r 1.4, h 7 | fill = `account_value / (2·account_usd)`, clamped 0..1; the painted white **start line** sits at 0.5 | tooltip | P1 |
| Crates `crates` | (−4.5, −10.5) | closed bots with realized ≥ 0: crate stack height (1 crate per close, max 8 drawn), DOM total | tooltip | P1 |
| Compost `compost` | (5.5, −10.5) | closed bots with realized < 0: heap height ∝ count (max 8 steps), DOM total | tooltip | P1 |
| Water tower `tower` | (13, −8), h 8, tank r 1.8 | tank level = `deployed_usd / account_value`; a drip pipe runs to every active plot | tooltip: deployed $, room under the notional cap | P0 |
| Pond + pump `pond` | (15, 3) r 3.2; pump (13, 0.5) | water level = `available_usd / account_usd`, clamped 0..1 | tooltip | P0 |
| Windmill `windmill` | (−12, −11), h 9, sails r 3.2 | **bar clock**: sail angle = elapsed share of the current bar; speed boost from wind | tooltip "next bar in 23 s" | P0 |
| Sundial `sundial` | (−8, −13.5) | time-lapse `tick {n:60}`. **Only rendered when `prices === 'sim'`.** | click = time-lapse button | P0 |
| Market board `board` | (−15, 8) faces NE | real prices; the board shows the focused coin (or the biggest 24 h mover) in DOM | opens the market board panel | P0 |
| Mailbox `mailbox` | (−7, 12) | diary; flag up = unread warnings | opens the diary | P0 |
| Fire pit `firepit` | (8, 12.5) | `bots_halt` | opens the burn confirm | P0 |
| Pip the scarecrow `pip` | (−12.5, −5) | help and tour; empty-state speech bubble | opens help / replays the tour | P1 |
| Signpost `signpost` | (0, 15.5) | the mode badge text in the world (DOM label) | opens the mode popover | P1 |
| Sky + weather vane on barn roof | – | market weather (mean `change_24h`) | tooltip "market weather, not your P&L" | P0 |
| Decor | rim trees (6), rocks, fences, flower border, waterfall (SE rim, P2), grass | none | – | P1 |

### 2.5 Camera framing (default)

- **Lens:** `PerspectiveCamera`, FOV **30°** in landscape (aspect ≥ 0.8) and **42°** in portrait; near 0.5,
  far 300.
- **Default rig:**
  - Target `(0, 0.8, 1.0)`, yaw 0° (looking north), pitch 52° above the horizon.
  - Distance `d0 = 50` (landscape). In portrait, `d0 = fitDistance(24 u horizontal)`, which is ≈ 63 at
    390 × 844.
- **Safe area.** The rig keeps the target centred in the *visible* region, not the full canvas. HUD panels
  report their occupied edges through `rig.setSafeArea({top, right, bottom, left})` (CSS px), and the rig
  applies `camera.setViewOffset` so the projection centre is the centre of the safe area. This handles:
  - the top HUD and bottom dock;
  - the desktop inspector (right 380 px);
  - the phone bottom sheet (up to 60 vh).
- **Default view shows:** the whole field, the stall, the barn, the tower, the pond, and the front of the fire
  pit and mailbox. The underside of the island is visible at the bottom edge only at the widest zoom.

---

## 3. Crops, cues and states

### 3.1 Coin → crop catalogue (all 16 plus fallback)

Crops are built by **9 procedural builders**. Each builder returns
`{stemLeaves: BufferGeometry, fruitGeo, flowerGeo, fruitAnchors[6], flowerAnchors[≤6], height}`.
The DOM chip always shows the ticker, so a crop is never the only cue to its coin.
`crops/catalog.js` is pure data (no three import), so it can be tested in Node.

| Coin | Crop (EN / TH key `g.crop.<COIN>`) | Builder | Silhouette | Leaf | Fruit unripe → ripe | Accent / flourish |
|---|---|---|---|---|---|---|
| BTC | orange tree | `tree` | tapered trunk; canopy of 3 jittered icospheres (detail 1) | #5E9E58 | #9CC46A → #F39A2E (icosphere r 0.18) | – |
| ETH | eggplant | `hangingBush` | broad leaves on 2 stems; hanging teardrops | #6FA36A | #8C7BB8 → #4B3A8C (8-seg lathe teardrop, flat-shaded) | – |
| SOL | sunflower | `stalk` | tall stem, 2 big leaves, disc head + 12 petal quads | #79B25C | petals #E9D27A → #F5C04A; "fruit" = side mini-heads | centre #6B4A2E |
| HYPE | hops | `vine` | pole + spiral vine | #64B98F | stacked cones #B8E6CC → #5FD1A6 | – |
| XRP | rice | `grassClump` | 24 blades in a shallow paddy (water disc with ripple rings) | #8CC56A | bent grain chains #C9D67A → #E8C25A | paddy water #8FD3E8 |
| DOGE | corn | `stalk` | 2–3 strap-leaf stalks | #7DB55A | husked cob #E8E19A → #F2C94C | **harvest: popcorn burst** (P1) |
| AVAX | chili pepper | `hangingBush` | low bush, curved hanging cones | #5FA061 | #8FC46A → #E0453A | – |
| LINK | peas | `vine` | twining vine on a cane | #6DB36E | pod (capsule + 4 bumps) #A9D98A → #5C8FD6 | – |
| SUI | watermelon | `groundRosette` | sprawling ground vine, curly tendrils | #6AAE5C | striped ellipsoid #A8D08A → #3E8F4A (vertex stripes #2F6B36) | – |
| NEAR | carrot | `rootCrop` | feathery fronds; orange shoulders in the soil (fruit = shoulders) | #78B75A | #F2B27A → #F07D2B | – |
| ARB | blueberry | `bush` | round bush, 5-berry clusters | #5D9E6A | #B9D3E8 → #3F6FC4 | – |
| TIA | tea bush | `bush` | glossy round bush, lavender bloom bundles | #5FA45E | #D9E8C9 → #B79AE0 | – |
| ZEC | zucchini | `groundRosette` | big ground leaves | #6CAA58 | capsule #D7E39A → #F1CF3B | – |
| WIF | mushroom in a knit hat | `fungus` | stalk #F1E6D2 on a mossy log; lathe cap knitted (vertex-noise ribs) | moss #6E9E5A | cap #E9D8C4 → #D2553F with cream dots; "fruit" = baby mushrooms | pom-pom #F4A6C6 |
| PUMP | pumpkin | `groundRosette` | sprawling vine, big leaves | #6FAE5A | 8-rib lathe #C9D98A → #F08A2C | curly stem |
| VVV | grapes | `vine` | V-shaped trellis (two slanted poles) | #6AA65E | 9-sphere cone clusters #C7D6A0 → #8E2F57 | – |
| *(other)* | beanstalk | `vine` | – | #6DB56A | green bean pod #8FD17A → #4E9A3F | – |

The 9 builders are `tree, stalk, vine, bush, hangingBush, groundRosette, rootCrop, grassClump, fungus`.

**Shared crop shading.** The crop material is `MeshToonMaterial` with a 3-band procedural gradient and
`vertexColors`. A vertex attribute `aLeaf` (1 = leaf, 0 = stem) tints leaves and stems separately.
`aH` = normalised height (0..1) drives bending.

### 3.2 Planter box, family and leverage cues

```
  DOM chip (aria-hidden; same data as the dock card):  BTC  LONG ↑  10×   +$3.10 (+3.1%)  ▮▮▮▯
          bluebird ▸ ◣ arrow sign (LONG: points up, blue)        ×10 stake   🌡 thermometer stake
                     ║ tag post                 crop              ║            ║
     ┌───────────────╨───────────────────────────────────────────╨────────────╨─┐
     │ soil: wet ↔ dry ↔ cracked ↔ charred (vertex-colour lerp)    ▣▣ sacks       │ ← box material = family
     └────────────────────────────────────────────────────────────────────────────┘   drip pipe from the tower
```

- **Box material = archetype family.** The trim uses the classic `FAMILY_TINT` so it carries over from the
  2D page.
  - `standard`: natural pine, trim #9FB3C8.
  - `hyper`: terracotta, trim #F0883E.
  - `degen`: plum paint, trim #C084FC, star decals plus black/yellow hazard tape on the rim.
  - `swarm`: hexagonal wicker box, trim #39C5CF, a tiny beehive on one corner with 2 orbiting bees (bees P2).
- **Leverage** (bot leverage = min(bean, venue)):
  - **`×N` stake**, front-left: a wooden stake with a painted plaque. The number is a DOM label, so it stays
    legible and translatable.
  - **Fertilizer sacks** at the box corner, by `levTier(lev)`: 1× → 0, 2–5× → 1, 6–10× → 2, 11–25× → 3,
    26–50× → 4, 51–100× → 5. At ≥ 25× the sacks get hazard stripes.
  - **Shiver.** Sway amplitude `0.04 + 0.025·log2(lev)` rad. A 7 Hz shiver of amplitude
    `0.004·log2(lev)` rad is added on top. degen boxes add 0.5 Hz noise jitter.
- **Liquidation thermometer**, a glass stake front-right, present only when `szi ≠ 0`:
  - `d = clamp(|mark − liq| / |entry − liq|, 0, 1)`; fill height = `d`.
  - **Bands (J6: never green/red):**
    - `ok` d > 0.6: slate #7FA7B8.
    - `warn` 0.3 < d ≤ 0.6: amber #E0A526.
    - `danger` d ≤ 0.3: amber with black hazard stripes. A pulsing ring #F59E0B (0.5 Hz, scale 1→1.08) goes
      round the box, frost rime (white tint, `uFrost` 0→0.6) creeps up the leaves, the soil cracks, and the
      chip adds `⚠ 1.9% from liquidation`.
  - Text: `liqInfo()` (§9.3) gives "price must fall 10.1% to liquidate" (long) or "…rise…" (short).
- **Drip pipe:** active bots have a pipe from the tower with a slow drip. Paused bots have the valve closed
  and no drip.

### 3.3 LONG vs SHORT (J6/J7)

The side comes from `sign(real.szi)` regardless of `phase` (an `error` phase can still hold a position).
Three cues are layered, and the first alone is enough:

1. **Words.** The chip, dock, inspector and dialogs say `LONG ↑` (blue pill #2B6CB0) or `SHORT ↓` (violet
   pill #7B4FC4). In Thai: `LONG ↑ (ขาขึ้น)` / `SHORT ↓ (ขาลง)`. Help text explains how a position profits:
   *LONG · ได้กำไรเมื่อราคาขึ้น* / *SHORT · ได้กำไรเมื่อราคาลง*.
2. **Arrow-sign shape.** The tag sign on the post is arrow-shaped. It points up to the sky (long) or down
   into the soil (short), painted blue or violet. When flat (waiting, entering, paused), the sign hangs
   sideways, grey #8A8F98, with the DOM word `FLAT`.
3. **Critter mnemonic (P1).** A bluebird perches on long signs and hops up every 8–14 s. A mole pokes out of
   a molehill beside short boxes and digs every 8–14 s. On a flip they swap with a hop.

A profitable short shows a green P&L next to a violet sign, and that is correct (J6). In colour-blind mode the
side pills become neutral outlined pills with the arrow, and blue/orange are used for P&L (§7.4).

### 3.4 Growth model (unchanged; imported, never re-implemented)

The 3D page imports `stage()`, `botPhase()` and `botPnl()` from `web/js/plant.js` and uses `GROWTH` as-is:

```
f      = (realized_pnl + real.unrealized_pnl) / capital_usd          (the store feeds the newest server mark, §9.3)
size   = clamp(0.25 + 6f + (phase === 'waiting' ? 0 : 0.1), 0.12, 1)
health = clamp(1 + 8f, 0, 1)
fruit  = f > 0.02 && health > 0.6 ? min(6, floor(f / 0.02 + 1e-9)) : 0
flower = health > 0.4
caption: seed phases → 'waiting' | 'entering'; else dying (health < 0.2) › wilting (< 0.5) › ripe (f > 0.05)
phase  = closed › paused › error › (szi = 0: bean side ≠ 0 ? entering : waiting) › long | short
```

**Mapping to 3D parameters** (`field/plot.js`; tween targets update on every new view):

| Parameter | Formula | Smoothing |
|---|---|---|
| Crop root scale | `s = size` (0.12…1) | critically damped spring, ω = 4 rad/s |
| Droop | `uDroop = smoothstep(0.6, 0.0, health) · 0.7`; per vertex with `w = aH²`: `pos.xz += leanDir·uDroop·w·h`, `pos.y −= uDroop·w·0.4h` | tween 1.2 s, easeInOutSine |
| Leaf tint | **same thresholds and colours as `plant.js` healthTone()**: lush (per-crop leaf hex) at health ≥ 0.6; mix toward sick #C4B048 down to 0.2; then toward dead #805E3C | tween 1.2 s |
| Sway | `sin(t·1.2 + φ)·amp·windFactor`, `amp` from leverage (§3.2), windFactor from §4.5 | continuous (RM: 0) |
| Fruit count | `n = stage().fruit` on anchors `0..n−1` in fixed order | add: pop · remove: drop (§4) |
| Fruit colour | lerp unripe → ripe by `clamp((f − 0.02) / 0.03, 0, 1)` | tween 0.6 s |
| Flowers | open (petal scale-y 0→1) when `flower && !seed`, else closed | 0.6 s easeOutBack / 0.4 s |
| Leaf count | leaf instances with index ≥ `ceil(N·(0.4 + 0.6·health))` are hidden after a falling-leaf effect | – |

### 3.5 State → visual table (exhaustive)

`PlotView.state` is derived in `core/view.js` (§9.3). Overlay flags stack on top of the state.

| State / flag | Trigger | 3D visual | Chip / dock text (key) |
|---|---|---|---|
| **empty** | no bot in slot | tilled soil with 4 furrows. In pick mode: a dashed glow ring bouncing 0.05 u, plus a "plant here" seed sign | `g.dock.empty` |
| **empty · burned** | `live.halted` | charcoal soil #3B3330, char stump, no glow | `plot.emptyHalted` |
| **planting** (pending) | `cmd:pending bot_create` for this slot | trowel digs in a loop (max 10 s). On failure: soil re-flattens with a dust puff | `g.insp.pending` |
| **waiting** | phase `waiting` | seed sachet on a stick plus a 2-leaf sprout at `size` (≈ 0.25). Still. A snail crosses the rim every ~40 s (P2) | `g.state.waiting` ("nothing at risk") |
| **entering** | phase `entering` | sprout wiggles at 2 Hz (±6°); the soil mound breathes (scale-y 1→1.08, 1.5 s) | `g.state.entering` |
| **growing long / short** | phase `long`/`short` | full crop per §3.4; arrow sign, critter, ×N stake, sacks, thermometer | P&L, side, ×N, liq |
| **flowering** | `flower && !seed` | flowers open on the anchors | – |
| **fruiting** | `fruit ≥ 1` | n fruits; colour by f | – |
| **ripe** | `caption === 'ripe'` | fruit emissive 0.12 pulsing (2 s period); one glint every 6–10 s, the same weight and cadence as the wilting leaf (J11; RM: none); an empty basket appears at the box corner | `g.state.ripe` (neutral, J12) |
| **wilting** | `caption === 'wilting'` | droop and tint per §3.4; sway ×0.6; a brown leaf falls every 6–10 s | `g.state.wilting` |
| **dying** | `caption === 'dying'` | near-max droop, brown, leaves thinned; one grey cloud puff on entry | `g.state.dying` |
| **paused** | state `paused`, `note == null` | striped parasol (8-segment cone, cream/pastel blue) over the box; plant desaturated 30% (`uSat`); valve closed; soil dries over 4 s; sign FLAT | `g.state.shade` |
| **paused · bean busted** | `note === 'bean busted'` | parasol, plus a crossed-out sachet nailed to the post | `g.state.busted` |
| **paused · liquidated** | `note === 'liquidated'` | crop flattened to a stump (scale-y 0.15), hail-scar soil decal, red-lettered DOM sign "LIQUIDATED −$X" (X = initial margin from the liquidation fill). Persists until harvested or pulled | `g.state.liquidated` |
| **error** (flag) | `last_error` | orange "!" A-frame sign beside the box; the drip pipe sputters (particles). The plant keeps its growth state | `g.state.error` |
| **frozen** (flag) | `price_stale` or coin in `stale` | grey fog bank (3 billboard puffs) over the box; plant targets frozen; thermometer fogged | `g.state.frozen` |
| **liq danger** (flag) | thermometer band `danger` | hazard ring, frost, cracks (§3.2) | `g.liq.near` |
| **selected / hover** (flag) | UI | inverted-hull outline at scale 1.04, #FFF6E0 (hover: desktop only; selected: also a DOM `aria-current`) | – |
| **harvesting** | `bot_closed` with P&L ≥ 0 | exit timeline (§4); the slot keeps the last view until it ends (≤ 2.2 s) | "harvested +$X" for 3 s |
| **pulling** | `bot_closed` with P&L < 0 | exit timeline (§4) | "pulled −$X" for 3 s |
| **closed** | after the exit | box re-tills (0.6 s) → **empty** | – |
| **field burned** | `live_halted` | burn sequence (§4); all boxes charcoal; stall shutters closed with a "closed until restart" sign | `plot.emptyHalted` |
| **not drawn** | open bot beyond slot 15 | none (dock/list only) | `g.dock.hidden` |

`plotFsm` states are `empty → planting → (waiting | entering | growing) ⇄ paused → (harvesting | pulling) →
empty`. `error`, `frozen`, `liqDanger` and `selected` are overlay flags. Data updates that arrive during an exit
timeline are queued and reconciled when it ends.

---

## 4. Animation, VFX and SFX catalogue

The director (§9.5) maps events and view diffs to effects. Every row obeys J1–J12.
- **Easings:** `oB` = easeOutBack(1.70158), `iOC` = easeInOutCubic, `oC` = easeOutCubic, `iOS` = easeInOutSine.
- **Particles** come from the GPU pool (§9.8). Sounds are defined in §8.

### 4.1 Commands and trades

| Trigger | Animation (duration, easing) | Particles | Sound | RM |
|---|---|---|---|---|
| Pick a seed (DOM card or stall sachet) | sachet lifts 0.3 u and spins 360° (400, oC); empty boxes get a dashed glow ring bouncing 0.05 u (1.2 s loop, iOS); the cursor/finger carries a ghost sprout | – | `paperRustle` | static ring, no lift |
| Drag a seed card over the canvas (P1) | ghost sachet follows the pointer; valid empty box: ring pulse; invalid (occupied/burned): ghost shakes ±4° (200) | – | `tick` | outline only |
| `bot_create` **pending** | the farmer walks to the box (if enabled); trowel dig loop (2 digs/s), max 10 s | `dust` ×4 per dig | `thup` per dig (max 4) | static trowel icon |
| `bot_create` **2xx** (plant) | seed arcs from the stall to the box (600, oC), soil closes, sprout pops 0 → size×1.15 → size (450, oB) | `soil` ×10 | `thup` + `pop` | sprout fades in (150) |
| `bot_created` echo (**water**) | the pump turns, the pond level drops by the stake and the tower rises (1.0 s, iOS); a flowing dash runs along the pipe to the box (animated vertex colour, 1.2 s); the soil darkens; DOM label "watered $100" | `droplets` ×14 on the box | `burble` | levels jump; label only |
| `bot_create` **4xx** | the seed bounces back to the stall (500, oC); dust puff; error inline in the dialog (`role=alert`) | `dust` ×8 | `knock` ×2 | dust icon |
| `bot_fill` open | splash ring (scale 0→1.4, fade, 600); DOM floater rises 40 px and fades (1.8 s): `Open Long 0.00500 BTC @ $82,410.0`; the arrow sign springs up | `splash` ×8 | `plip` open (1200→600 Hz) | floater fades in place |
| `bot_fill` close | as open; floater `Close Long @ $82,980.5 · realized +$2.66` (net of fee, money colour + ▲/▼) | `splash` ×8 | `plip` close (600→900 Hz) | same, static |
| Fills on one plot within 400 ms | coalesced: one splash, the floater shows the last fill plus `×N fills` | – | one `plip` | – |
| Flip (Close X then Open Y within 400 ms) | two stacked floaters 120 ms apart; the sign rotates 180° (500, iOC); bird ↔ mole swap with a hop (300) | – | `plip` ×2 | instant swap |
| `bot_order` skipped (notional cap) | red "cap" tag on the tower valve pulses twice (600); amber chip note | – | `knock` | tag appears |
| Fill with `time_ms < now − 120 s` (replayed) | **no animation**; state applied directly | – | – | – |

### 4.2 Plant state changes (from view diffs)

| Diff | Animation | Particles | Sound | RM |
|---|---|---|---|---|
| Size or health retarget (every mark) | springs per §3.4 only (J11) | – | – | value jumps at the next frame |
| Fruit gained (index k) | fruit pops 0 → 1.15 → 1 (450, oB) and the leaves bounce. If the same index was lost < 10 s ago: a quiet 200 ms fade instead | – | `pop` (pentatonic note k) | fade 150 |
| Fruit lost | the fruit browns (300), drops, rolls 0.6 u and sinks into the soil (800); the brown fruit stays visible 10 s before sinking | – | `thud` (soft) | fade to brown, then gone |
| Enter ripe | basket appears (400, oB); glint begins | `sparkle` ×3 every 3 s | `glint` (once) | basket only |
| Enter wilting / dying | droop tween 1.2 s; 3 falling leaves; dying: grey puff | `leaves` ×3 / `smoke` ×6 | `sigh` (2 descending notes, once per entry) | tween 150 |
| Enter liq danger | ring starts pulsing; frost creeps up over 1.5 s | – | `tickTick` (once per entry, never looping) | static ring + frost |
| Enter frozen | 3 fog puffs fade in (800) | – | – | fade 150 |
| Bean flat → in (waiting → entering) | wiggle starts | – | – | – |

### 4.3 Closing, pausing, failure

| Trigger | Animation | Particles | Sound | RM |
|---|---|---|---|---|
| **Harvest** (`bot_closed`, P&L ≥ 0) | farmer cuts with a sickle (if present; never waited for). Fruits hop into the basket (staggered 80 ms); the plant bows and sinks into the soil (700, iOS). **Coins** (count `coinBurst(usd)`, §9.4) arc from the box to the **crates** (900 flight, 60 ms stagger), and a crate is added. Water flows tower → pond. HUD: a transfer arrow animates from *Growing* to *Harvested* (400). Floater "+$12.40 harvested". Total 2.0 s. P&L = 0: basket, no coins (J4) | `coins` (InstancedMesh); DOGE: `popcorn` ×24 | `coinBlips` (count = coins, max 8, rising pentatonic) | label + crate appear, no flight |
| **Pull** (`bot_closed`, P&L < 0) | hoe swing; the plant uproots (lift 0.4 u, tilt 30°, 500, oC); a brown bundle arcs to the **compost** heap (800), which grows a step. Water flows tower → pond. Floater "−$8.20 realized loss" in red ▼. **No coins, no sparkles, no fanfare.** 1.6 s | `clumps` ×6 (brown) | `rustle` + `thud` (neutral) | label + compost appear |
| **Shade** (`bot_paused` manual) | the parasol drops from above and unfolds (scale-y 0→1, 700, oB); the valve turns; desaturate; the sign goes FLAT. If flattened with P&L, a floater shows the realized amount | – | `fwump` | instant |
| **Resume** (`bot_resumed`) | the parasol folds and flies off (500, iOC); a sunbeam (additive cone, 800); the valve opens and the drip restarts | none (re-opening is activity, not a gain: J4/J8) | `whoosh` (neutral) | instant |
| **Liquidation** (`bot_paused` liquidated) | a small dark cloud forms over the one box (600); hail falls (1.2 s); the plant flattens to a stump; the sign drops in (400, oB). 2.0 s | `hail` ×40 | `hail` + `thud` | stump + sign |
| **Bean busted** (planted) | crossed-out sachet slaps onto the post (300, oB) and the parasol opens | – | `mutedBell` | instant |
| Bean busted (shelf) | that stall sachet tilts and drops into the bin below the plank (500); restock slides a new one in (400) | – | `paperFlop` | swap |
| `live_error` | the "!" A-frame springs up (600, oB); the pipe sputters for 2 s; mailbox flag up | `drips` ×6 | `knock` ×2 | sign appears |
| **Burn the field** (`live_halted` plus per-bot `bot_closed`) | camera pulls back to frame the field (the user started it; RM: cut). The torch lights (400); an ember wave sweeps the rows from the fire pit (250 per plot, in slot order). Each plot resolves in turn as a compact harvest or pull with **its real number** (from its `bot_closed`). Soil lerps to charcoal, ash falls 3 s, stall shutters close. 3–4 s | `embers` ×30 per plot, `ash` ×60 | `whoosh` + `crackle` (3 s) + per-plot `coinBlip`/`thud` | 400 crossfade to charred; labels listed in a toast |
| Any command 409/400/401 | dust puff on the target; error text inline in the open dialog or as a toast (server text, via textContent) | `dust` ×8 | `knock` ×2 | – |

### 4.4 Time and market

| Trigger | Animation | Sound | RM |
|---|---|---|---|
| `tick_completed` | windmill kick +20° overshoot (500, oB), then the slow turn resumes (sail angle = bar progress); a soil-shimmer ripple spreads from the windmill across active boxes (800); market board flips | `tock` + one pentatonic `chime` (the chime can be turned off) | board updates only |
| `mids` (~5 s) | ticker digit flip ≤ 300 (old → new only); chips update at t = 0; springs retarget (§3.4); pond/tower levels tween 600; thermometers ease 400 | – | instant |
| Gust (any coin \|Δ\| > 0.3% between consecutive mids, or \|bar return\| > 1%; at most 1 per 20 s) | a wind wave crosses the grass from the west (1.2 s, shader `uGust`); windmill spin-up ×2 for 3 s; that coin's ticker item gets an outline for 3 s; DOM caption "gust: SOL moved +0.42% in seconds" in the ticker | `whoosh` | ticker outline only |
| Weather change | sky gradient crossfade 4 s; cloud count 8/16/26/34 (sunny/mild/rainy/storm); rain fades in or out; storm: lightning **only in the far sky behind the island**, ≤ 1 flash per 8 s, luminance step ≤ 30%, 120 ms | rain bed, distant thunder 1–3 s after the flash | no lightning; static rain streaks off |
| Time-lapse (sim) | the sundial shadow sweeps 360° (2 s); the windmill spins fast; with *sky = clock* the sky runs the hour | `whirr` | instant |
| `feed_status` → down/delayed | fog creeps over the island edge (DOM gradient plus scene fog density ×1.6, 1.2 s); the signpost flips; affected plots get fog banks | – | instant |
| `feed_gap` (replay) | diary line only | – | – |

### 4.5 Ambience (continuous; all off in RM)

- **Grass:** instanced tufts with a wind vertex shader, `windFactor` by market wind. Wind is
  `mean |change_1h|`: < 0.3% calm 0.6, < 0.8% breezy 1.0, < 1.5% windy 1.6, else gale 2.4.
- **Clouds** drift at 0.3 u/s × windFactor.
- **Windmill:** base speed 0.12 rev/s × windFactor, plus the bar-progress angle.
- **Barn chimney smoke** (6 puffs, P1).
- **Critters:** bluebirds and moles (P1); bees near open flowers and butterflies over healthy plots
  (P2, count = healthy plots, max 6); a bird flock every 40–90 s (P2).
- **Waterfall** particles (P2).
- **Fireflies** at night with *sky = clock* (P2).

**Farmer (P1, decorative, never blocks):**
- Rigid-part figure (hips, torso, head, straw hat, 2 arms, 2 legs, tool socket), walk cycle 2.2 Hz, speed 4 u/s.
- Path graph: ~20 nodes (a ring around the field at 1.6 u offset, one stand point per plot, barn door, stall,
  pond, fire pit, mailbox). Routing is BFS.
- Tasks come from effects (plant → dig, water → can, harvest → sickle, pull → hoe, shade → parasol,
  burn → torch). The queue holds at most 3. If a task arrives with the queue full, or the target is > 18 u
  away, the farmer teleports with a dust puff.
- **Effects never wait for him.** They play at t = 0, and he arrives and poses afterwards (pose 0.6–1.0 s).
- Idle: wanders to a random plot every 8–15 s. RM or setting off → hidden.

### 4.6 Camera motions

| Motion | Duration | RM |
|---|---|---|
| First load: the island rises from the cloud layer, landmarks pop in (scale 0→1.1→1, 40 ms stagger), and the camera arcs to default | 2.0 s | 200 ms fade |
| Focus a plot | 700 iOC | cut with 150 ms crossfade |
| Back / reset | 600 / 800 iOC | cut |
| Tour step | 900 iOC | cut |
| Idle drift (setting, default off): yaw oscillates ±10° at 0.01 Hz after 30 s idle | – | disabled |

---

## 5. Camera and input

### 5.1 Rig (own code, no OrbitControls; `gfx/camera.js`)

| Parameter | Landscape | Portrait (aspect < 0.8) |
|---|---|---|
| FOV | 30° | 42° |
| Distance range `[dMin, dMax]` | [16, 70], default 50 | [22, 90], default `fitDistance(24 u)` |
| Pitch | coupled to zoom: `lerp(40°, 62°, (d − dMin)/(dMax − dMin)) + userTilt`, userTilt ∈ [−8°, +8°] | same |
| Yaw | clamped to [−40°, +40°] | same |
| Target | y fixed 0.8; x ∈ [−14, 14], z ∈ [−12, 13] | same |
| Inertia | pan/yaw velocity × 0.9 per 16.7 ms, time-normalised (RM: none) | same |
| Focus (plot) | d = 18, pitch 48°, target = plot + (0, 1, 0) | d = 26, pitch 54° |

The camera never goes below `y = 3`. `rig.setSafeArea()` is applied on every HUD layout change (§2.5).

### 5.2 Input map

| Action | Mouse | Touch | Keyboard (when focus is on `#stage` or `<body>`) |
|---|---|---|---|
| Pan | left-drag on empty ground | 1-finger drag | arrows (Shift = ×3) |
| Rotate / tilt | right-drag, or Alt+left-drag | 2-finger twist (yaw), 2-finger vertical drag (tilt) | Q / E yaw ∓20°; PageUp / PageDown tilt ±4° |
| Zoom | wheel toward the cursor (exponential, 8% per notch) | pinch | `+` / `−` |
| Select | click (move < 6 px and press < 500 ms) | tap | `1`–`9`, `0` = plots 1–10; `[` / `]` previous/next plot |
| Focus and inspect | double-click | double-tap | Enter or F on the selected plot |
| Quick actions | – | long-press 450 ms on a plot → radial (P1) | – |
| Plant by drag (P1) | drag a seed card onto a box | same | – |
| Back | Esc | ⌖ button / Android back (history state) | Esc: close panel → leave focus → cancel pick mode |
| Reset view | – | ⌖ long-press | Home |
| Panels | – | bottom bar | P seeds · D diary · L list · B market board · M mute · ? help |

- **Single-key shortcuts** (letters, digits, punctuation) are ignored while an `input`, `select`,
  `textarea` or dialog has focus, and can be turned off in Settings (WCAG 2.1.4).
- **Shortcuts only ever open panels or move the selection.** Nothing that spends money or closes a position
  runs from one key.
- The canvas has `touch-action: none`; panels scroll normally. Pointer events use pointer capture. Pinch and
  twist are computed from the two active pointers.

### 5.3 Picking (`gfx/picking.js`)

- A `Raycaster` with `layers.set(1)` tests **only** invisible proxy boxes: about 15 plots plus 14 landmarks.
  Crop meshes are never raycast.
- Hover (fine pointer only) raycasts at most once per frame, on `pointermove`.
- A tap/click resolves on `pointerup` within the thresholds. The result is `{type:'plot', slot}`,
  `{type:'landmark', id}` or `null`.
- Selection is two-way synced with the DOM dock (`aria-current="true"`) through `store.ui.selectedSlot`.
- Seed drag uses a raycast against the ground plane, snapping to the nearest box within 2.2 u.

### 5.4 Focus mode

Entering focus (select + Enter/double-click/double-tap, or the inspector's ⌖):
- the rig flies to the plot;
- the inspector opens (desktop right panel 380 px; phone bottom sheet at the 60% snap);
- other plots' chips hide (unless *labels = always*) and other boxes dim 15% (`uSat`);
- `[` / `]` move to the previous/next occupied plot, staying in focus.

Esc closes the inspector and returns to the previous view (600 ms).

### 5.5 Pick mode (planting)

Selecting a seed enters pick mode:
- empty plots glow;
- the dock's empty cards read "Plant BTC here";
- the live region announces `g.a11y.pickMode`.

Clicking an empty box, its dock card, or dropping a dragged seed opens the plant dialog for that slot.
**Plant in next free plot** in the catalogue does the same for the lowest free slot. Esc cancels.

---

## 6. HUD and dialogs

All text and controls are DOM over the canvas:
- `<canvas id="world" aria-hidden="true">` sits inside `<div id="stage" tabindex="0" role="region"
  aria-label=… aria-describedby="sceneSummary">`;
- `#sceneSummary` is a visually hidden live summary (`g.a11y.scene`).

**Containers that other packages depend on** (owned by WP5):
- `#hud` (top);
- `#chips` (projected plot chips, aria-hidden);
- `#fx` (floating labels, aria-hidden);
- `#dock`;
- `#panels` (sheets/side panels);
- `#dialogs`;
- `#announce` (`aria-live="polite"`);
- `#alert` (`aria-live="assertive"`, only for errors and feed-down).

### 6.1 Main HUD, desktop (≥ 1024 px)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│[● REAL PRICES · PAPER TRADES ⓘ]  🌱 Bean Garden       ⛅ market +0.4% · breezy   ◷ next bar 0:23   ● live  [🔇] [⚙] [?]│
│[Barn $10,042.18 · +0.42% vs start] [Pond $9,442.18 free] [Water out $600] [Growing +$38.12 ▲] [Harvested −$4.10 ▼] [Plants 6/10]│
│ ┌ Seed stall ──────────┐                                                 ┌ Plot 03 · BTC orange tree ┐ │
│ │ (catalogue panel      │                (3D island)                      │ (inspector panel, §6.6)    │ │
│ │  opens on demand)     │                                                 │                            │ │
│ └───────────────────────┘                                                 └────────────────────────────┘ │
│ [🌱 Seeds] [☰ List] [📔 Diary •3] [📈 Prices]                              [⏩ +1h · SIM only] [🔥 Burn]   │
│ ┌ Plots ──────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │[01 BTC ↑LONG 10× +$3.10 +3.1% ▮▮▮▯][02 SOL ↓SHORT 5× −$1.20 −1.2% ▮▮▮▮][03 ＋ plant] … [10 ＋ plant]  │ │
│ └──────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│ BTC 82,980.5 ▴1.2% · ETH 2,509.35 ▾0.8% · SOL 110.425 ▴2.1% · HYPE … (scrollable, no auto-move)  [All ▸]  │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Main HUD, phone (360–430 px; 16 px gutters; no page-level horizontal scroll)

```
┌──────────────────────────────────────┐
│[● REAL · PAPER ⓘ]   Barn $10,042  [⚙]│
│[Pond $9,442][Out $600][Grow +$38 ▲]… │  ← one swipeable row
│ ⛅ +0.4% · ◷ 0:23 · ● live            │
│                                      │
│             (3D island)              │
│                                      │
│ BTC 82,980.5 ▴1.2% · ETH 2,509… [▸]  │  ← ticker, one line
│[01 BTC ↑10× +3.1%][02 SOL ↓5× −1.2%]…│  ← dock, swipe
│ [🌱 Seeds] [☰ Plots] [📔 Diary] [⋯]  │  ← 56 px bottom bar
└──────────────────────────────────────┘
```

- Panels open as **bottom sheets** with snap points 25 / 60 / 92 vh, a drag handle, Esc/back to close, and
  focus trapped in modal sheets only.
- **⋯ More** holds Prices, Burn, Time-lapse (sim), Settings, Help and Classic view.
- Tap targets are ≥ 44 px; primary bar buttons are 56 px.

### 6.3 Mode badge (always visible, never dismissible; `ui/badge.js`)

| Badge (EN / TH) | Condition (`feedBadge()`, §9.3) | Style |
|---|---|---|
| `● REAL PRICES · PAPER TRADES` / `● ราคาจริง · เทรดกระดาษ` | `prices = 'real'`, `state = 'live'`, no stale coins, marks age ≤ 15 s | #1D6B5A bg, white text |
| `◐ REAL PRICES · 3 COINS DELAYED · PAPER TRADES` | live with stale coins | #F2C14E bg, ink #2D2620 |
| `◐ REAL PRICES · DELAYED 45 s · PAPER TRADES` | `state = 'delayed'`, or marks age > 15 s | same amber |
| `○ PRICES DOWN since 12:03 · NOTHING TRADES` | `state = 'down'` | #5F6368 bg, white; plus an `#alert` banner |
| `◆ SIMULATED PRICES · PAPER TRADES` | `prices = 'sim'` | #6B4FA0 bg with 45° stripes (CSS gradient), white |
| `○ OFFLINE · numbers from 12:04` | client cannot reach the API | #5F6368 bg |

Clicking the badge opens a popover (`g.mode.realBody` / `simBody` / `fallbackBody` / `downBody`,
plus `g.mode.realBack` when `feed.real_available`).

### 6.4 Ticker and market board

- **Ticker:**
  - One horizontally scrollable row (never auto-scrolling). Each item: crop icon, coin, mid price
    (`fmtPx`), 24 h change in neutral ink with ▴/▾, and a `SIM` or `delayed 40 s` tag when relevant.
  - Order: planted coins first, then the rest by |24 h change|.
  - Digit flip on change ≤ 300 ms (RM: none).
  - `aria-label` per item: `g.ticker.item`. **All ▸** opens the board.
- **Market board panel** (`ui/board.js`; also opened by clicking the board landmark): a `<table>` with
  columns coin | crop | price (mid) | 24h | funding/h (info only) | updated. Footnote `g.board.note` (or
  `noteSim`).

### 6.5 Seed catalogue (`ui/shelf.js`) and plant dialog (`ui/plantDialog.js`)

```
┌ Seed stall · best bean per coin ──────────── ✕ ┐  ┌ Plant SOL · sunflower ─────────────────── ✕ ┐
│ variety [any ▾]  sort [total return ▾]          │  │ Bean #688 · hyper_algo · momentum · 10×    │
│ ☑ sprouting now        ↻ restock                │  │ Paper +18.4% total · +2.1% 7d · max DD 9.8% │
│ ┌──────────────────────────────────────────┐    │  │   · win 54% · 212 fills                     │
│ │🌻 SOL sunflower   real $110.425 ▴2.1%     │    │  │ Real price   $110.425 (Hyperliquid · 2 s)   │
│ │ hyper_algo · momentum · 10× (venue 20×)   │    │  │ Bean now     LONG ↑ since 13:58 @ $109.870  │
│ │ paper +18.4% · 7d +2.1% · DD 9.8% · 54%   │    │  │   → you enter right away at ≈ $110.425      │
│ │ ╱╲_╱‾ equity of its $1,000 paper account  │    │  │ ─────────────────────────────────────────── │
│ │ bean now LONG ↑ @ $109.870                │    │  │ Water (your stake) [ 100 ] $ ━━●━━━━━━━━━    │
│ │                       [ Select ] [Plant…] │    │  │                    20 ─────────────── 1000   │
│ ├──────────────────────────────────────────┤    │  │ Mirrors 10.0% of the bean ≈ $708 notional    │
│ │🍊 BTC orange tree … (in plot 1: dimmed)  │    │  │ Margin ≈ $70.80 at 10× isolated             │
│ └──────────────────────────────────────────┘    │  │ ⚠ A 9.5% move against the position          │
│ [ Plant in the next free plot ]                 │  │   liquidates it (loses its margin)          │
│ Paper results of a simulated $1,000 strategy on │  │ Worst case: the whole margin ≈ $70.80 — it  │
│ real prices. Past results do not predict future │  │   can exceed the water if the bean grows    │
│ ones.                                           │  │ Fees ≈ $0.85 to open and close              │
└─────────────────────────────────────────────────┘  │ Funding 0.0013%/h — info only, not charged  │
                                                     │ Room: up to $640 · free cash $9,442.18      │
                                                     │ Plants in plot 04                           │
                                                     │ ☐ I understand this is 25× … (only ≥ 25×)   │
                                                     │ [ Cancel ]   [ 🌱 Plant & water $100 (paper) ]│
                                                     │ PAPER TRADE — simulated fill at the real     │
                                                     │ price. No real money.                        │
                                                     │ (inline error line, role=alert)             │
                                                     └─────────────────────────────────────────────┘
```

**Catalogue rules:**
- Same query and filters as the classic shelf: `shelfQuery()` with `sort -total_return | -ret_7d | -sharpe`,
  the variety filter and *sprouting now*. `tradeable` is dropped when halted.
- A planted coin's card is dimmed: "in plot N".
- A stale coin's card shows `g.shelf.stale`, and its Plant button is disabled.
- `Select` enters pick mode (§5.5).

**Plant dialog rules (P0):**
- The water slider and a number input are paired (min 20, max 1000, step 10, default 100).
  `aria-valuetext` gives the dollar amount.
- **Math reuses** `mirrorNote`, `stakeRoom`, `entryMargin` (moved to `model.js`, §9.1). Plus `plantQuote()`:
  - `notional = openingNotional(bean, stake, livePx)`: a **positioned** bean (side ≠ 0) is mirrored at once
    from its existing units, so the notional is `|bean.units| × stake/1000 × livePx` (those units were sized
    at the bean's *entry* equity); a flat bean (or no price) uses the next-entry size
    `mirrorNote(bean, stake).notional`. The dialog shows the per-entry size alongside ("≈ $X per later
    entry"). `stakeRoom(bean, live, livePx)` uses the same per-dollar figure, and so does the server's
    create-time notional-cap check (`openingNotional` in `server/live.js`).
  - `lev = min(bean.leverage, venue_max_leverage)`
  - `margin = notional / lev`
  - `liqMovePct = 0.95 / lev`
  - `fees ≈ notional × (0.00045 + 0.00015) × 2`
  - `worst = margin`; the "can exceed water" note shows when `margin > stake × 1.005`
- **Plant is blocked, with a red reason, when:**
  - the stake is above `stakeRoom.maxStake` (`modal.overCap` / `modal.full`);
  - the field is halted (`modal.halted`);
  - the coin price is stale or the marks age is > 15 s (`g.plant.staleBlock`);
  - the feed is down (`g.plant.downBlock`);
  - bot leverage ≥ 25× and the *I understand* checkbox is unticked.
- The entry line says `g.plant.enterNow` when the bean side ≠ 0, else `g.plant.enterLater`.
- Submit: `bus.emit('cmd:pending')`, then `command('bot_create', {bean, capital_usd})`. The dialog stays open
  until the response.
  - 2xx: the dialog closes and the slot is assigned to the new bot (§9.6).
  - Error: inline server message, the dialog stays open, focus moves to the error.

### 6.6 Plot inspector (`ui/inspector.js`; desktop right panel, phone bottom sheet)

```
┌ Plot 01 · BTC orange tree · bot-0003 ─────────────────────── ⌖ ✕ ┐
│ [LONG ↑]  10× (bean 10×, venue max 40×)   hyper_algo · momentum   │
│ Mark price     $82,980.5    Hyperliquid · 3 s ago                 │
│ Entry price    $82,410.0                                          │
│ Size           0.00500 BTC  ≈ $414.90 notional                    │
│ Margin used    $44.06                                             │
│ Liquidation    $74,581.1  [▓▓▓▓▓▓▓▓▓▓] price must fall 10.1% to liquidate │
│ Water (stake)  $100.00                                            │
│ Unrealized +$2.85 ▲ · Realized +$0.25 ▲ · Fees paid $0.37        │
│ Total P&L      +$3.10 ▲  (+3.1% of water)                         │
│ Growth: size 0.54 · health 1.00 · fruit 1 · flower ✓              │
│   ⓘ the plant is drawn from these numbers: f = total P&L ÷ water  │
│ Funding 0.0011%/h — info only, not charged                        │
│ ─ last fills ─────────────────────────────────────────────────── │
│ 12:41  Open Long 0.00500 BTC @ $82,410.0 · fee $0.19              │
│ 12:03  Close Short 0.00480 BTC @ $82,700.5 · realized +$0.25      │
│ ─ price since you opened this page ─  ▁▂▃▅▄▆▇ (from mids, ≤ 10 min)│
│ Bean #612 · hyper_algo · momentum · paper +18.4% · now LONG ↑     │
│ [ ⛱ Shade (pause & close position) ]  [ 🧺 Harvest +$3.10 ]        │
│ Paper trade: simulated fills at the real price.                   │
└───────────────────────────────────────────────────────────────────┘
```

- When total < 0 the close button reads **🪓 Pull (−$8.10)** with a red outline, not a gold fill. Paused bots
  show **☀ Back in the sun** instead of Shade.
- Every number shows its age tag (§6.12). A missing server mark falls back to `≈` estimates (§9.3).
- The `last_error` text (escaped, textContent) appears in an error box above the buttons.
- **Prices** use `fmtPx(px, szDecimals)`: 6 significant figures, never more than `6 − szDecimals` decimals.
  **Sizes** use `fmtSz(sz, szDecimals)`.

### 6.7 Confirmation dialogs (`ui/confirm.js`; modal `<dialog>`, focus trap, focus returns to the opener)

```
┌ Harvest BTC (bot-0003)? ─────────────────────────┐  ┌ Burn the field? ───────────────────────────────┐
│ Closes 0.00500 BTC LONG ↑ at market (≈ $82,980.5).│  │ Closes ALL 4 plots at market now. Unrealized   │
│ You end with ≈ +$2.85 total (+2.9% of $100 water) │  │ +$1.90 becomes realized. Planting is refused   │
│ after fee ≈ $0.19 and slippage ≈ $0.06.           │  │ until the server restarts.                     │
│ Paper fill at the next price; the final number    │  │  01 BTC ↑ +$3.10 ▲   02 SOL ↓ −$1.20 ▼          │
│ can differ slightly.                              │  │  04 ETH ↑ +$0.40 ▲   07 DOGE ↓ −$0.40 ▼         │
│        [ Keep growing ]   [ 🧺 Harvest +$2.85 ]   │  │ Net ≈ +$1.90                                    │
└──────────────────────────────────────────────────┘  │ ☐ I understand every plot closes now           │
                                                      │  [ Cancel ]   [ 🔥 Burn the field ] (needs ☑)    │
                                                      └────────────────────────────────────────────────┘
```

- **Harvest / pull** (`bot_close`):
  - `estClose = realized + unrealized − |szi|·mark·(0.00045 + 0.00015)`, prefixed `≈`.
  - Pull uses red framing and the title `g.ask.pullTitle`.
  - When flat: `g.ask.closeFlat`.
  - **Numbers refresh live while the dialog is open.** If |Δ estClose| > $0.50 or > 10%, `g.ask.changed`
    shows. Default focus is *Keep growing*.
- **Shade with a position:** `g.ask.shadeBody` with ≈ realized. No dialog when the plot is flat (shade runs
  directly, with a pending state).
- **Burn:**
  - Lists every open plot with its total P&L (`closeQuote().estTotal`), plus the net (their sum). `{pnl}` in `g.ask.burnBody` is Σ unrealized.
  - The burn button is enabled only after the checkbox is ticked (no hold-to-confirm, for motor
    accessibility).
  - Default focus is *Cancel*. Esc cancels.

### 6.8 Diary (`ui/diary.js`; mailbox panel)

- Parchment sheet, newest first, max 60 lines, timestamped (`clock()`).
- Filter chips: all / fills / plantings / warnings.
- Reuses every existing `diary.*` key plus the new `g.diary.*` keys.
- Tick lines are throttled to 1 per 10 s (existing rule).
- Backfill on load from `events?limit=100` (P1).
- Warnings (errors, liquidation, bust, feed down/fallback) also go to `#announce`; feed down goes to `#alert`.
- The mailbox flag and the `•N` badge show unread warnings; they clear when the diary opens.

### 6.9 Settings (`ui/settings.js`)

Persisted in `localStorage["bean.game.settings.v1"]` (every read and write in try/catch; defaults when
storage is blocked). Defaults are in **bold**.

| Setting | Values | Notes |
|---|---|---|
| Language | EN / TH | existing `setLang` |
| Sound | **off** / on | §8 |
| Volume | 0–1 (**0.6**) | – |
| Ambient sounds | **on** / off | only while sound is on |
| Bar chime | **on** / off | – |
| Graphics | **Auto** / High / Medium / Low | §9.9 |
| Motion | **Follow system** / Full / Reduced | §7.3 |
| Sky | **Always day** / Follow my clock | sim: market time |
| Labels over plots | **Always** (desktop) / On hover & selected (**phone default**) / Off | the dock always shows numbers |
| Colours | **Standard** / Colour-blind friendly | §7.4 |
| Single-key shortcuts | **on** / off | WCAG 2.1.4 |
| Farmer & animals | **on** / off | – |
| Camera idle drift | on / **off** | – |
| Command token | existing token box (moved from the header; same `brood-api` behaviour, host confirm) | – |
| Replay the tour · Open classic 2D · API docs | links/buttons | – |

### 6.10 Onboarding (`ui/tutorial.js`; Pip)

- Runs once (`localStorage["bean.game.tour.v1"]`). It is skippable at every step and can be replayed from
  Settings or by clicking Pip.
- Each card is a non-modal dialog anchored near the landmark. The camera eases to each landmark (RM: cuts).
  Steps:
  1. **Badge.** `g.tour.1` (or `g.tour.1sim`).
  2. **Stall.** `g.tour.2`.
  3. **Plant dialog preview.** A static illustration card, no API call: `g.tour.3`.
  4. **Demo ghost plant.** A translucent ghost crop in an empty box, labelled `g.tour.example`, cycling
     through gain, wilt, LONG and SHORT: `g.tour.4`.
  5. **×N stake and thermometer.** `g.tour.5`.
  6. **Barn, mailbox and fire pit.** `g.tour.6`, then the final card offers `g.tour.sound` (Turn on sound?).

### 6.11 Other panels

- **List view** (`ui/listview.js`, P1). A `<table>` of all open bots: plot, crop, side, lev., mark, entry,
  P&L, % of water, water, to liq., state, actions (Inspect / Shade or Sun / Harvest or Pull). Focusing a row
  highlights the plot in 3D. Screen-reader users get a "List view" link right after the skip link.
- **Radial** (`ui/radial.js`, P1). Long-press opens 4 buttons around the finger: Inspect, Shade/Sun,
  Harvest/Pull (opens the confirm, never closes directly), Focus. Esc or tap-away closes it.
- **Help** (`?`). Lists the controls (`g.help.*`) and the colour key (green/red = money, blue/violet = side,
  amber = risk).

### 6.12 Offline, error and age states

| Situation | World | HUD |
|---|---|---|
| Marks age 15–60 s | – | numbers get an amber `delayed · 25s` tag |
| Marks age > 60 s | plants freeze (no new targets) | numbers greyed `stale · 2m`; badge delayed |
| Coin stale | fog bank on that plot | ticker `SIM`/`delayed` tag; plot chip `g.state.frozen`; planting that coin blocked |
| Feed down | edge fog; signpost flips | grey badge; `#alert` banner `g.mode.downBody`; plant and resume disabled (close/pause still allowed: they fill at the last real price, flagged ≈) |
| SSE down | – | live dot amber "polling"; `g.err.sse`; polling continues every 20 s |
| API unreachable | canvas dims to 60% (`filter`) and desaturates | OFFLINE badge; banner `g.err.offline` with a retry countdown (backoff 2 → 4 → 8 → 20 s); all actions disabled; last numbers kept, greyed and stamped |
| Command error | dust puff | inline error in the dialog, or a toast with `diary.failed` |
| Halted | charred field | persistent banner `plot.emptyHalted`; Plant and Sun disabled with the reason |
| WebGL2 missing / engine missing / context lost | – | §7.6 |

### 6.13 Honesty rules for money display (all P0)

1. Show exactly what the store holds (J1). Estimates (`estClose`, `≈ szi·(px − entry)`) carry `≈`.
2. P&L always has an explicit sign, colour **and** glyph: `+$3.10 ▲` (up #237A4B), `−$8.20 ▼` (down
   #B33A32). Zero is neutral `$0.00`. Use `usd(x, 2, true)`.
3. Plot % is always "**of water**". Barn % is "**vs start**". Price % is the 24 h change in neutral ink.
4. Money never counts up or tweens (J2). The barn never animates on harvest (J5).
5. Every number shows its age. Thresholds: ≤ 15 s fresh, 15–60 s `delayed`, > 60 s `stale` (§9.3).
6. Liquidation distance is always shown as price **and** % move, with the direction (fall/rise).
7. Funding is labelled "info only, not charged". Fees are always included in "you end with".
8. *Waiting/entering* copy says "nothing at risk" only when `szi === 0`.
9. Losses stay visible: compost totals, liquidation stumps until acted on, dropped fruit for 10 s, red labels.
10. The mode badge, PAPER wording and SIM labels are never hidden (J9).

---

## 7. Accessibility, i18n, reduced motion, quality, fallback

### 7.1 Accessibility (P0)

- **DOM twin of the field.** The dock is an `<ol>` of buttons, one per slot. Each `aria-label` uses
  `g.dock.label` (coin, crop, side, leverage, P&L, % of water, state). The List view is the full `<table>` twin.
- The canvas is `aria-hidden`. `#sceneSummary` updates at most once per 10 s, or immediately on plant/close.
- **Live regions.** `#announce` (polite) gets plant/close/shade results, warnings and pick-mode prompts.
  `#alert` (assertive) gets feed-down and API-down only.
- **Dialogs and focus.**
  - Dialogs are native `<dialog>` with a focus trap. Focus returns to the opener.
  - Busy buttons use `aria-disabled` plus `data-busy`, not `disabled`, so focus is not dropped (existing
    `setBusy` pattern).
  - Bottom sheets are `role="dialog"` with `aria-modal` only when modal.
- **Visuals.**
  - Contrast: AA for all text, AA large for 18 px bold+. Badge colours are chosen for ≥ 4.5:1 (§6.3).
  - Focus ring: 3 px #2B6CB0 plus a 2 px white offset, never removed.
- **Keyboard.** Everything is reachable by Tab through the DOM. The `#stage` region is focusable for camera
  keys, but it is never a required stop.
- **Thai.** All text renders in DOM, never in WebGL. Font stack:
  `system-ui, "Segoe UI", "Leelawadee UI", "Noto Sans Thai", "Sukhumvit Set", Tahoma, sans-serif`.
  Chips may wrap to 2 lines. The longest TH strings are tested at 360 px.

### 7.2 i18n

- All new keys go into `web/js/i18n.js` `STRINGS.en` and `STRINGS.th`, with `{placeholder}` parity. The
  existing parity test covers them.
- Existing keys are **reused** (do not duplicate): `sign.*`, `weather.*`, `token.*`, `shelf.*`, `packet.*`,
  `modal.*` (note, levCap, margin, maxStake, overCap, full, halted, cancel, gone, water, waterLabel),
  `ask.yes/no/burnTitle`, `diary.*`, `act.*`, `err.*`, `dir.*`, `ago.*`, `plot.emptyHalted`, `lang.*`,
  `app.apiDocs`.

**New keys** (WP5 adds them all on day 1 so other packages can call `t()` immediately):

| Key | EN | TH |
|---|---|---|
| **boot** | | |
| `g.boot.loading` | Growing the island… | กำลังปลูกเกาะ… |
| `g.boot.noWebgl` | Your browser can't run the 3D garden (it needs WebGL2). Opening the classic garden… | เบราว์เซอร์นี้เปิดสวน 3 มิติไม่ได้ (ต้องใช้ WebGL2) กำลังเปิดสวนแบบคลาสสิกให้… |
| `g.boot.noEngine` | The 3D engine files are missing on the server (run npm install). Opening the classic garden… | เซิร์ฟเวอร์ไม่มีไฟล์เอนจิน 3 มิติ (ต้องรัน npm install ก่อน) กำลังเปิดสวนแบบคลาสสิกให้… |
| `g.boot.slowGpu` | 3D is running without graphics acceleration and may be slow. | สวน 3 มิติกำลังทำงานโดยไม่มีการเร่งกราฟิก อาจช้า |
| `g.boot.openClassic` | Open the classic garden | เปิดสวนแบบคลาสสิก |
| `g.boot.contextLost` | 3D view paused — restoring… | ภาพ 3 มิติหยุดชั่วคราว กำลังกู้คืน… |
| `g.boot.contextFailed` | The 3D view could not be restored. | กู้คืนภาพ 3 มิติไม่สำเร็จ |
| `g.boot.retry` | Try again | ลองอีกครั้ง |
| `g.boot.error` | The garden could not start: {error} | เปิดสวนไม่สำเร็จ: {error} |
| **mode badge** | | |
| `g.badge.real` | REAL PRICES · PAPER TRADES | ราคาจริง · เทรดกระดาษ |
| `g.badge.realPartial` | REAL PRICES · {n} COINS DELAYED · PAPER TRADES | ราคาจริง · ล่าช้า {n} เหรียญ · เทรดกระดาษ |
| `g.badge.delayed` | REAL PRICES · DELAYED {age} · PAPER TRADES | ราคาจริง · ล่าช้า {age} · เทรดกระดาษ |
| `g.badge.down` | PRICES DOWN since {time} · NOTHING TRADES | ไม่มีราคาตั้งแต่ {time} · หยุดเทรดทั้งหมด |
| `g.badge.sim` | SIMULATED PRICES · PAPER TRADES | ราคาจำลอง · เทรดกระดาษ |
| `g.badge.offline` | OFFLINE · numbers from {time} | ออฟไลน์ · ตัวเลข ณ เวลา {time} |
| `g.badge.short.real` | REAL · PAPER | ราคาจริง · กระดาษ |
| `g.badge.short.sim` | SIM · PAPER | ราคาจำลอง · กระดาษ |
| `g.badge.label` | Price source and trading mode — details | แหล่งราคาและโหมดการเทรด — ดูรายละเอียด |
| `g.mode.realBody` | Prices: Hyperliquid public market data, updated {age} ago. Trades: simulated (paper) fills at those prices. No real orders, no keys, no real money. | ราคา: ข้อมูลตลาดสาธารณะของ Hyperliquid อัปเดตเมื่อ {age}ที่แล้ว การเทรด: ซื้อขายจำลองบนกระดาษที่ราคานั้น ไม่มีคำสั่งจริง ไม่มีคีย์ ไม่มีเงินจริง |
| `g.mode.simBody` | Prices: simulated by this server — not real market prices. Trades: paper fills at those prices. Time-lapse is available. | ราคา: เซิร์ฟเวอร์นี้จำลองขึ้นเอง ไม่ใช่ราคาตลาดจริง การเทรด: ซื้อขายบนกระดาษที่ราคานั้น ใช้การเร่งเวลาได้ |
| `g.mode.fallbackBody` | The real price feed was unreachable when the server started ({error}), so this garden runs on simulated prices. | ตอนเซิร์ฟเวอร์เริ่มทำงาน ติดต่อฟีดราคาจริงไม่ได้ ({error}) สวนนี้จึงใช้ราคาจำลอง |
| `g.mode.realBack` | Real prices are reachable again — restart the server to switch to the real-price garden. | ติดต่อราคาจริงได้แล้ว — รีสตาร์ทเซิร์ฟเวอร์เพื่อสลับไปใช้สวนราคาจริง |
| `g.mode.delayedCoins` | Delayed: {coins}. Bots on these coins are frozen until prices return. | ล่าช้า: {coins} บอทของเหรียญเหล่านี้จะหยุดนิ่งจนกว่าราคาจะกลับมา |
| `g.mode.downBody` | Hyperliquid has not answered since {time}. Bars and trades wait — no price is invented. Missed minutes are replayed when prices return. | Hyperliquid ไม่ตอบตั้งแต่ {time} แท่งราคาและการเทรดจะรอไว้ — ไม่มีการสร้างราคาขึ้นเอง นาทีที่หายไปจะถูกเล่นย้อนเมื่อราคากลับมา |
| **HUD** | | |
| `g.hud.barn` | Barn (account value) | ยุ้งฉาง (มูลค่าบัญชี) |
| `g.hud.vsStart` | {pct} vs start | {pct} จากทุนเริ่มต้น |
| `g.hud.pond` | Pond (free cash) | บ่อน้ำ (เงินสดว่าง) |
| `g.hud.tower` | Water out (deployed) | น้ำที่ให้ไป (ทุนที่ลงอยู่) |
| `g.hud.growing` | Growing (unrealized) | กำลังโต (ยังไม่รับรู้) |
| `g.hud.harvested` | Harvested (realized) | เก็บเกี่ยวแล้ว (รับรู้แล้ว) |
| `g.hud.paperNote` | paper account · started with {usd} | บัญชีกระดาษ · ทุนเริ่มต้น {usd} |
| `g.hud.transfer` | plot closed · {usd} realized in total · growing → harvested | ปิดแปลงแล้ว · รับรู้รวม {usd} · “กำลังโต” → “เก็บเกี่ยวแล้ว” |
| **clock** | | |
| `g.clock.next` | next bar in {s} | แท่งถัดไปใน {s} |
| `g.clock.nextSim` | next simulated bar in {s} | แท่งจำลองถัดไปใน {s} |
| `g.clock.waiting` | waiting for prices | กำลังรอราคา |
| `g.clock.label` | Windmill: one turn per 1-minute bar | กังหันลม: หมุนหนึ่งรอบต่อแท่ง 1 นาที |
| `g.clock.lag` | {n} minutes behind — catching up when prices return | ช้ากว่าเวลาจริง {n} นาที — จะตามทันเมื่อราคากลับมา |
| **weather / wind** | | |
| `g.weather.note` | market weather, not your P&L | สภาพอากาศของตลาด ไม่ใช่กำไรขาดทุนของคุณ |
| `g.wind.calm` | calm | ลมสงบ |
| `g.wind.breezy` | breezy | ลมอ่อน |
| `g.wind.windy` | windy | ลมแรง |
| `g.wind.gale` | gale | ลมพายุ |
| `g.wind.label` | Market wind: average size of 1-hour moves (volatility), not direction | ลมตลาด: ขนาดเฉลี่ยของการขยับใน 1 ชั่วโมง (ความผันผวน) ไม่ใช่ทิศทาง |
| `g.wind.gust` | gust: {coin} moved {pct} in seconds | ลมกระโชก: {coin} ขยับ {pct} ในไม่กี่วินาที |
| **ticker / board** | | |
| `g.ticker.label` | Real prices | ราคาจริง |
| `g.ticker.labelSim` | Simulated prices | ราคาจำลอง |
| `g.ticker.all` | All prices | ราคาทั้งหมด |
| `g.ticker.sim` | SIM | จำลอง |
| `g.ticker.item` | {coin} {px}, {chg} in 24 hours | {coin} {px} เปลี่ยน {chg} ใน 24 ชั่วโมง |
| `g.board.title` | Market board | กระดานราคา |
| `g.board.coin` | coin | เหรียญ |
| `g.board.price` | price (mid) | ราคา (กลาง) |
| `g.board.chg24` | 24h | 24 ชม. |
| `g.board.funding` | funding /h (info only) | funding/ชม. (ข้อมูลเท่านั้น) |
| `g.board.age` | updated | อัปเดต |
| `g.board.note` | Mid prices from Hyperliquid. Funding is shown for information; paper trades here are not charged funding. | ราคากลางจาก Hyperliquid แสดง funding ไว้เป็นข้อมูลเท่านั้น การเทรดกระดาษที่นี่ไม่ถูกคิด funding |
| `g.board.noteSim` | Simulated prices from this server — not the real market. | ราคาจำลองจากเซิร์ฟเวอร์นี้ — ไม่ใช่ตลาดจริง |
| `g.board.up` | up | ขึ้น |
| `g.board.down` | down | ลง |
| **ages / sources** | | |
| `g.age.ago` | {age} ago | {age}ที่แล้ว |
| `g.age.delayed` | delayed · {age} | ล่าช้า · {age} |
| `g.age.stale` | stale · {age} | ข้อมูลเก่า · {age} |
| `g.age.est` | ≈ estimate | ≈ ค่าประมาณ |
| `g.src.real` | real | จริง |
| `g.src.sim` | simulated | จำลอง |
| `g.src.hl` | Hyperliquid | Hyperliquid |
| **side / leverage / liquidation** | | |
| `g.side.long` | LONG ↑ | LONG ↑ (ขาขึ้น) |
| `g.side.short` | SHORT ↓ | SHORT ↓ (ขาลง) |
| `g.side.flat` | FLAT | ไม่มีสถานะ |
| `g.side.longHelp` | LONG · profits when the price rises | LONG · ได้กำไรเมื่อราคาขึ้น |
| `g.side.shortHelp` | SHORT · profits when the price falls | SHORT · ได้กำไรเมื่อราคาลง |
| `g.lev.label` | leverage {n}× | เลเวอเรจ {n}× |
| `g.lev.capped` | {n}× (bean {bean}×, venue max {max}×) | {n}× (ถั่ว {bean}× · ตลาดให้สูงสุด {max}×) |
| `g.liq.label` | Liquidation | จุดล้างพอร์ต (liquidation) |
| `g.liq.fall` | price must fall {pct} to liquidate | ราคาต้องลง {pct} จึงจะถูกล้างพอร์ต |
| `g.liq.rise` | price must rise {pct} to liquidate | ราคาต้องขึ้น {pct} จึงจะถูกล้างพอร์ต |
| `g.liq.near` | ⚠ {pct} from liquidation | ⚠ ห่างจุดล้างพอร์ต {pct} |
| `g.liq.gauge` | distance to liquidation | ระยะห่างจากจุดล้างพอร์ต |
| `g.liq.none` | no position — nothing at risk right now | ไม่มีสถานะ — ตอนนี้ยังไม่มีเงินเสี่ยง |
| **plot states** | | |
| `g.state.waiting` | waiting for the bean — nothing at risk | รอถั่วเข้าตลาด — ยังไม่มีเงินเสี่ยง |
| `g.state.entering` | entering at the next fill… | กำลังเข้าในการซื้อขายครั้งถัดไป… |
| `g.state.growing` | growing | กำลังโต |
| `g.state.ripe` | ripe — harvest or keep growing | สุกแล้ว — จะเก็บเกี่ยวหรือปล่อยให้โตต่อก็ได้ |
| `g.state.wilting` | wilting | กำลังเหี่ยว |
| `g.state.dying` | dying — consider pulling | ใกล้ตาย — ลองพิจารณาถอน |
| `g.state.shade` | in the shade · flat | อยู่ในร่ม · ไม่มีสถานะ |
| `g.state.busted` | bean busted · auto-paused | ถั่วหมดตัว · พักอัตโนมัติ |
| `g.state.liquidated` | LIQUIDATED {usd} | ถูกล้างพอร์ต {usd} |
| `g.state.error` | error — open the plot for details | ผิดพลาด — เปิดแปลงเพื่อดูรายละเอียด |
| `g.state.frozen` | price delayed — frozen | ราคาล่าช้า — หยุดนิ่ง |
| `g.state.harvestedNow` | harvested {usd} | เก็บเกี่ยวแล้ว {usd} |
| `g.state.pulledNow` | pulled {usd} | ถอนแล้ว {usd} |
| **dock** | | |
| `g.dock.title` | Plots | แปลง |
| `g.dock.plot` | Plot {n} | แปลง {n} |
| `g.dock.empty` | + plant | + ปลูก |
| `g.dock.emptyPick` | Plant {coin} here | ปลูก {coin} ที่นี่ |
| `g.dock.emptyLabel` | Plot {n}: empty — plant a seed | แปลง {n}: ว่าง — ปลูกเมล็ด |
| `g.dock.label` | Plot {n}: {coin} {crop}, {side}, {lev}×, {pnl} ({pct} of water), {state} | แปลง {n}: {coin} {crop}, {side}, {lev}×, {pnl} ({pct} ของน้ำ), {state} |
| `g.dock.hidden` | {n} more open bots are not drawn in the field (15-plot limit) — see the list | ยังมีบอทเปิดอยู่อีก {n} ตัวที่ไม่ได้วาดในไร่ (จำกัด 15 แปลง) — ดูในรายการ |
| **seed stall / catalogue** | | |
| `g.shelf.title` | Seed stall · best bean per coin | แผงเมล็ด · ถั่วดีที่สุดของแต่ละเหรียญ |
| `g.shelf.price` | real {px} | ราคาจริง {px} |
| `g.shelf.priceSim` | sim {px} | ราคาจำลอง {px} |
| `g.shelf.beanNow` | bean now {side} @ {px} | ตอนนี้ถั่ว {side} ที่ {px} |
| `g.shelf.beanFlat` | bean is flat (waiting for a signal) | ถั่วยังไม่มีสถานะ (รอสัญญาณ) |
| `g.shelf.stats` | paper {ret} · 7d {r7} · max drawdown {dd} · win {wr} | บนกระดาษ {ret} · 7 วัน {r7} · ขาดทุนสะสมสูงสุด {dd} · ชนะ {wr} |
| `g.shelf.curve` | equity of its $1,000 paper account | มูลค่าบัญชีกระดาษ $1,000 ของถั่วตัวนี้ |
| `g.shelf.select` | Select | เลือก |
| `g.shelf.plant` | Plant… | ปลูก… |
| `g.shelf.plantNext` | Plant in the next free plot | ปลูกในแปลงว่างถัดไป |
| `g.shelf.inPlot` | in plot {n} | อยู่ในแปลง {n} |
| `g.shelf.stale` | price delayed — planting {coin} waits for a fresh price | ราคาล่าช้า — ต้องรอราคาใหม่ก่อนปลูก {coin} |
| `g.shelf.disclaimer` | Paper results of a simulated $1,000 strategy on {source} prices. Past results do not predict future ones. | ผลบนกระดาษของกลยุทธ์จำลองทุน $1,000 บนราคา{source} ผลในอดีตไม่ได้บอกอนาคต |
| `g.shelf.dragHint` | drag a packet onto an empty plot, or select it and tap a plot | ลากซองไปวางบนแปลงว่าง หรือเลือกซองแล้วแตะแปลง |
| **plant dialog** | | |
| `g.plant.title` | Plant {coin} · {crop} | ปลูก {coin} · {crop} |
| `g.plant.bean` | Bean #{id} · {archetype} · {strategy} · {lev}× | ถั่ว #{id} · {archetype} · {strategy} · {lev}× |
| `g.plant.paper` | Paper {ret} total · {r7} 7d · max DD {dd} · win {wr} · {n} fills | กระดาษ รวม {ret} · 7 วัน {r7} · ขาดทุนสะสมสูงสุด {dd} · ชนะ {wr} · เทรด {n} ครั้ง |
| `g.plant.price` | Real price | ราคาจริง |
| `g.plant.priceSim` | Simulated price | ราคาจำลอง |
| `g.plant.beanNow` | Bean now | ถั่วตอนนี้ |
| `g.plant.since` | {side} since {time} @ {px} | {side} ตั้งแต่ {time} ที่ {px} |
| `g.plant.enterNow` | you enter right away at ≈ {px} | คุณจะเข้าทันทีที่ราคา ≈ {px} |
| `g.plant.enterLater` | the bean is flat — you enter when it does | ถั่วยังไม่มีสถานะ — คุณจะเข้าเมื่อถั่วเข้า |
| `g.plant.waterInput` | Water in dollars | น้ำเป็นดอลลาร์ |
| `g.plant.notionalNow` | the bot mirrors {pct}% of the bean: ≈ {usd} notional now (≈ {entry} per later entry) | บอทเลียนแบบ {pct}% ของถั่ว: ≈ {usd} มูลค่าสัญญาตอนนี้ (≈ {entry} ต่อการเข้าครั้งถัดไป) |
| `g.plant.margin` | Margin ≈ {usd} at {lev}× isolated | มาร์จิ้น ≈ {usd} ที่ {lev}× แบบ isolated |
| `g.plant.liq` | ⚠ A {pct} move against the position liquidates it (loses its margin) | ⚠ ถ้าราคาวิ่งสวนทาง {pct} สถานะจะถูกล้างพอร์ต (เสียมาร์จิ้นทั้งหมด) |
| `g.plant.worst` | Worst case: the whole margin ≈ {usd} — it can exceed the water if the bean grows | กรณีแย่ที่สุด: เสียมาร์จิ้นทั้งหมด ≈ {usd} — อาจมากกว่าน้ำได้ถ้าถั่วโตขึ้น |
| `g.plant.fees` | Fees ≈ {usd} to open and close | ค่าธรรมเนียม ≈ {usd} สำหรับเปิดและปิด |
| `g.plant.funding` | Funding {rate}/h — info only, not charged | Funding {rate}/ชม. — แสดงเป็นข้อมูล ไม่ถูกคิด |
| `g.plant.cash` | free cash {usd} | เงินสดว่าง {usd} |
| `g.plant.slot` | Plants in plot {n} | จะปลูกในแปลง {n} |
| `g.plant.highLev` | I understand this is {lev}× leverage: a small move can liquidate it | ฉันเข้าใจว่านี่คือเลเวอเรจ {lev}× ราคาขยับนิดเดียวก็อาจถูกล้างพอร์ต |
| `g.plant.go` | 🌱 Plant & water {usd} (paper) | 🌱 ปลูกและรดน้ำ {usd} (กระดาษ) |
| `g.plant.paperNote` | PAPER TRADE — simulated fill at the {source} price. No real money. | เทรดกระดาษ — ซื้อขายจำลองที่ราคา{source} ไม่ใช้เงินจริง |
| `g.plant.staleBlock` | {coin} price is delayed — planting waits for a fresh price | ราคา {coin} ล่าช้า — ต้องรอราคาใหม่ก่อนปลูก |
| `g.plant.downBlock` | prices are down — planting waits until they return | ไม่มีราคาเข้ามา — ต้องรอให้ราคากลับมาก่อนปลูก |
| `g.plant.levBlock` | tick the leverage box to plant | ติ๊กช่องยืนยันเลเวอเรจก่อนปลูก |
| **inspector** | | |
| `g.insp.title` | Plot {n} · {coin} {crop} · {bot} | แปลง {n} · {coin} {crop} · {bot} |
| `g.insp.mark` | Mark price | ราคาปัจจุบัน |
| `g.insp.entry` | Entry price | ราคาเข้า |
| `g.insp.size` | Size | ขนาด |
| `g.insp.notional` | ≈ {usd} notional | ≈ {usd} มูลค่าสัญญา |
| `g.insp.margin` | Margin used | มาร์จิ้นที่ใช้ |
| `g.insp.water` | Water (stake) | น้ำ (เงินที่ลง) |
| `g.insp.unreal` | Unrealized | ยังไม่รับรู้ |
| `g.insp.real` | Realized | รับรู้แล้ว |
| `g.insp.fees` | Fees paid | ค่าธรรมเนียมที่จ่าย |
| `g.insp.total` | Total P&L | กำไรขาดทุนรวม |
| `g.insp.ofWater` | {pct} of water | {pct} ของน้ำ |
| `g.insp.growth` | Growth: size {size} · health {health} · fruit {fruit} · flower {flower} | การเติบโต: ขนาด {size} · สุขภาพ {health} · ผล {fruit} · ดอก {flower} |
| `g.insp.growthHelp` | The plant is drawn from these numbers: f = total P&L ÷ water | ต้นไม้วาดจากตัวเลขเหล่านี้: f = กำไรขาดทุนรวม ÷ น้ำ |
| `g.insp.fills` | Last fills | การซื้อขายล่าสุด |
| `g.insp.noFills` | no fills yet | ยังไม่มีการซื้อขาย |
| `g.insp.priceSince` | price since you opened this page | ราคาตั้งแต่เปิดหน้านี้ |
| `g.insp.bean` | Bean #{id} · {archetype} · {strategy} · paper {ret} · now {side} | ถั่ว #{id} · {archetype} · {strategy} · กระดาษ {ret} · ตอนนี้ {side} |
| `g.insp.shade` | ⛱ Shade (pause & close position) | ⛱ กางร่ม (พักและปิดสถานะ) |
| `g.insp.sun` | ☀ Back in the sun (resume) | ☀ ออกแดด (ทำงานต่อ) |
| `g.insp.harvest` | 🧺 Harvest {pnl} | 🧺 เก็บเกี่ยว {pnl} |
| `g.insp.pull` | 🪓 Pull ({pnl}) | 🪓 ถอน ({pnl}) |
| `g.insp.focus` | Focus the camera on this plot | ซูมกล้องไปที่แปลงนี้ |
| `g.insp.pending` | waiting for the server… | กำลังรอเซิร์ฟเวอร์… |
| `g.insp.paperNote` | Paper trade: simulated fills at the {source} price. | เทรดกระดาษ: ซื้อขายจำลองที่ราคา{source} |
| `g.insp.errorTitle` | Error | ข้อผิดพลาด |
| **radial** | | |
| `g.radial.label` | Plot {n} actions | คำสั่งของแปลง {n} |
| `g.radial.inspect` | Inspect | ดูรายละเอียด |
| **confirms** | | |
| `g.ask.harvestTitle` | Harvest {coin} ({bot})? | เก็บเกี่ยว {coin} ({bot})? |
| `g.ask.pullTitle` | Pull {coin} at a loss ({bot})? | ถอน {coin} ทั้งที่ขาดทุน ({bot})? |
| `g.ask.closeBody` | Closes {sz} {coin} {side} at market (≈ {px}). You end with ≈ {pnl} total ({pct} of {water} water) after fee ≈ {fee} and slippage ≈ {slip}. | ปิด {sz} {coin} {side} ที่ราคาตลาด (≈ {px}) จะเหลือกำไรขาดทุนรวม ≈ {pnl} ({pct} ของน้ำ {water}) หลังหักค่าธรรมเนียม ≈ {fee} และ slippage ≈ {slip} |
| `g.ask.closeFlat` | This plot holds no position. Closing frees the plot; realized so far: {pnl}. | แปลงนี้ไม่มีสถานะ การปิดจะคืนแปลง รับรู้แล้วทั้งหมด {pnl} |
| `g.ask.differ` | Paper fill at the next price; the final number can differ slightly. | ซื้อขายบนกระดาษที่ราคาถัดไป ตัวเลขสุดท้ายอาจต่างไปเล็กน้อย |
| `g.ask.changed` | Numbers changed while this was open — check them again. | ตัวเลขเปลี่ยนระหว่างที่หน้าต่างนี้เปิดอยู่ — ตรวจอีกครั้ง |
| `g.ask.harvestYes` | 🧺 Harvest {pnl} | 🧺 เก็บเกี่ยว {pnl} |
| `g.ask.pullYes` | 🪓 Pull ({pnl}) | 🪓 ถอน ({pnl}) |
| `g.ask.keep` | Keep growing | ปล่อยให้โตต่อ |
| `g.ask.shadeTitle` | Shade {coin} ({bot})? | กางร่มให้ {coin} ({bot})? |
| `g.ask.shadeBody` | Shade closes the position at market and stops mirroring until you resume. Realizes ≈ {pnl}. | การกางร่มจะปิดสถานะที่ราคาตลาด และหยุดเลียนแบบถั่วจนกว่าคุณจะให้ทำงานต่อ รับรู้ ≈ {pnl} |
| `g.ask.shadeYes` | ⛱ Shade | ⛱ กางร่ม |
| `g.ask.burnBody` | Closes ALL {n} plots at market now. Unrealized {pnl} becomes realized. Planting is refused until the server restarts. | ปิด “ทุกแปลง” {n} แปลงที่ราคาตลาดทันที ส่วนที่ยังไม่รับรู้ {pnl} จะกลายเป็นรับรู้แล้ว และจะปลูกไม่ได้จนกว่าเซิร์ฟเวอร์จะรีสตาร์ท |
| `g.ask.burnNet` | Net ≈ {pnl} | สุทธิ ≈ {pnl} |
| `g.ask.burnCheck` | I understand every plot closes now | ฉันเข้าใจว่าทุกแปลงจะถูกปิดทันที |
| `g.ask.burnYes` | 🔥 Burn the field | 🔥 เผาไร่ |
| **floaters (fx)** | | |
| `g.fx.fill` | {dir} {sz} {coin} @ {px} | {dir} {sz} {coin} @ {px} |
| `g.fx.fillClose` | {dir} @ {px} · realized {pnl} | {dir} @ {px} · รับรู้ {pnl} |
| `g.fx.merged` | ×{n} fills | ซื้อขาย ×{n} |
| `g.fx.harvested` | {usd} harvested | เก็บเกี่ยว {usd} |
| `g.fx.realizedLoss` | {usd} realized loss | ขาดทุนที่รับรู้ {usd} |
| `g.fx.watered` | watered {usd} | รดน้ำ {usd} |
| `g.fx.capped` | order skipped: notional cap | ข้ามคำสั่ง: ชนเพดานมูลค่าสัญญา |
| **diary (new lines)** | | |
| `g.diary.feedReal` | 📈 real prices flowing (Hyperliquid) | 📈 ราคาจริงเข้ามาแล้ว (Hyperliquid) |
| `g.diary.feedDelayed` | ⏳ prices delayed: {coins} | ⏳ ราคาล่าช้า: {coins} |
| `g.diary.feedDown` | ⛔ price feed down — trading waits | ⛔ ฟีดราคาล่ม — หยุดเทรดรอไว้ก่อน |
| `g.diary.feedBack` | ✅ prices are back | ✅ ราคากลับมาแล้ว |
| `g.diary.feedSim` | ◆ running on simulated prices | ◆ กำลังใช้ราคาจำลอง |
| `g.diary.gapReplay` | ⏪ caught up {n} missed minutes of real prices | ⏪ เล่นย้อนราคาจริงที่พลาดไป {n} นาทีแล้ว |
| `g.diary.gapRewarm` | 🌄 away too long ({n} minutes) — the beans re-learned the last 2 days of real prices | 🌄 หายไปนานเกินไป ({n} นาที) — ถั่วเรียนรู้ราคาจริง 2 วันล่าสุดใหม่แล้ว |
| `g.diary.liquidated` | 🧊 {bot} ({coin}) liquidated — lost {usd} margin | 🧊 {bot} ({coin}) ถูกล้างพอร์ต — เสียมาร์จิ้น {usd} |
| `g.diary.capped` | ⚠ {bot}: order skipped (notional cap) | ⚠ {bot}: ข้ามคำสั่ง (ชนเพดานมูลค่าสัญญา) |
| `g.diary.filterAll` | all | ทั้งหมด |
| `g.diary.filterFills` | fills | การซื้อขาย |
| `g.diary.filterPlants` | plantings | การปลูก |
| `g.diary.filterWarn` | warnings | คำเตือน |
| `g.diary.empty` | A quiet morning on the farm. | เช้าที่เงียบสงบในไร่ |
| `g.diary.unread` | {n} unread | ยังไม่อ่าน {n} |
| **settings** | | |
| `g.set.title` | Settings | ตั้งค่า |
| `g.set.sound` | Sound | เสียง |
| `g.set.off` | off | ปิด |
| `g.set.on` | on | เปิด |
| `g.set.volume` | Volume | ความดัง |
| `g.set.ambience` | Ambient sounds | เสียงบรรยากาศ |
| `g.set.chime` | Bar chime | เสียงกระดิ่งทุกแท่ง |
| `g.set.graphics` | Graphics | กราฟิก |
| `g.set.auto` | Auto | อัตโนมัติ |
| `g.set.high` | High | สูง |
| `g.set.medium` | Medium | กลาง |
| `g.set.low` | Low | ต่ำ |
| `g.set.motion` | Motion | การเคลื่อนไหว |
| `g.set.system` | Follow system | ตามระบบ |
| `g.set.full` | Full | เต็มที่ |
| `g.set.reduced` | Reduced | ลดลง |
| `g.set.sky` | Sky | ท้องฟ้า |
| `g.set.skyDay` | Always day | กลางวันตลอด |
| `g.set.skyClock` | Follow my clock | ตามนาฬิกาของฉัน |
| `g.set.labels` | Labels over plots | ป้ายเหนือแปลง |
| `g.set.labelsAlways` | Always | แสดงตลอด |
| `g.set.labelsHover` | On hover and when selected | เมื่อชี้หรือเลือก |
| `g.set.labelsOff` | Off (the plot list still shows numbers) | ปิด (รายการแปลงยังแสดงตัวเลข) |
| `g.set.palette` | Colours | สี |
| `g.set.paletteStd` | Standard | มาตรฐาน |
| `g.set.paletteCb` | Colour-blind friendly | สำหรับผู้ที่แยกสีได้ยาก |
| `g.set.shortcuts` | Single-key shortcuts | ปุ่มลัดแบบกดปุ่มเดียว |
| `g.set.farmer` | Farmer & animals | ชาวไร่และสัตว์ |
| `g.set.drift` | Slow camera drift when idle | กล้องหมุนช้า ๆ เมื่อไม่ได้ใช้งาน |
| `g.set.tour` | Replay the tour | ดูทัวร์อีกครั้ง |
| `g.set.classic` | Open the classic 2D garden | เปิดสวน 2 มิติแบบคลาสสิก |
| `g.set.qualityLowered` | Graphics quality lowered for smoother play | ลดคุณภาพกราฟิกลงเพื่อให้ลื่นขึ้น |
| `g.set.mute` | Mute | ปิดเสียง |
| `g.set.unmute` | Unmute | เปิดเสียง |
| **tour (Pip)** | | |
| `g.tour.skip` | Skip tour | ข้ามทัวร์ |
| `g.tour.next` | Next | ถัดไป |
| `g.tour.back` | Back | ย้อนกลับ |
| `g.tour.done` | Let's farm | ไปปลูกกันเลย |
| `g.tour.step` | {n} of {total} | {n} จาก {total} |
| `g.tour.1` | Hi, I'm Pip! Prices here are REAL (Hyperliquid). Trades are PAPER — simulated, no real money. | สวัสดี ฉันชื่อพิป! ราคาที่นี่เป็นราคาจริง (Hyperliquid) ส่วนการเทรดเป็นเทรดกระดาษ — จำลองทั้งหมด ไม่ใช้เงินจริง |
| `g.tour.1sim` | Hi, I'm Pip! Right now prices are SIMULATED by this server, and trades are paper. | สวัสดี ฉันชื่อพิป! ตอนนี้ราคาเป็นราคาจำลองจากเซิร์ฟเวอร์นี้ และการเทรดเป็นเทรดกระดาษ |
| `g.tour.2` | Each seed packet is a bean: a trading strategy for one coin, with its paper track record. | ซองเมล็ดแต่ละซองคือถั่ว: กลยุทธ์เทรดของเหรียญหนึ่งเหรียญ พร้อมผลงานบนกระดาษ |
| `g.tour.3` | Water is your stake. Before you plant you see the notional, margin, fees and the move that would liquidate it. Water is not a loss cap. | น้ำคือเงินที่คุณลง ก่อนปลูกคุณจะเห็นมูลค่าสัญญา มาร์จิ้น ค่าธรรมเนียม และระยะราคาที่จะถูกล้างพอร์ต น้ำไม่ใช่เพดานขาดทุน |
| `g.tour.4` | Plants grow with profit and wilt with loss. LONG ↑ (blue, bluebird) profits when the price rises; SHORT ↓ (violet, mole) profits when it falls. Green and red only ever mean money. | ต้นไม้โตเมื่อกำไรและเหี่ยวเมื่อขาดทุน LONG ↑ (สีฟ้า มีนกสีฟ้า) ได้กำไรเมื่อราคาขึ้น SHORT ↓ (สีม่วง มีตัวตุ่น) ได้กำไรเมื่อราคาลง สีเขียวกับสีแดงหมายถึงเงินเท่านั้น |
| `g.tour.5` | The ×N stake is leverage. The thermometer shows how far the price is from liquidation. | หลัก ×N คือเลเวอเรจ ส่วนเทอร์โมมิเตอร์บอกว่าราคายังห่างจากจุดล้างพอร์ตแค่ไหน |
| `g.tour.6` | Harvest banks a gain, pull cuts a loss, shade pauses and goes flat. The fire pit burns the whole field — an emergency stop. | เก็บเกี่ยวเพื่อรับกำไร ถอนเพื่อตัดขาดทุน กางร่มเพื่อพักและปิดสถานะ กองไฟคือการเผาทั้งไร่ — ปุ่มหยุดฉุกเฉิน |
| `g.tour.sound` | Turn on sound? | เปิดเสียงไหม? |
| `g.tour.example` | example | ตัวอย่าง |
| **empty states** | | |
| `g.empty.field` | Pick a seed at the stall to start | เลือกเมล็ดที่แผงเพื่อเริ่มปลูก |
| `g.empty.crates` | No harvests yet | ยังไม่มีผลเก็บเกี่ยว |
| `g.empty.compost` | No losses closed yet | ยังไม่มีการปิดขาดทุน |
| `g.empty.list` | No plots yet. | ยังไม่มีแปลง |
| **errors** | | |
| `g.err.offline` | Can't reach the garden server — retrying in {s} s. Numbers are from {time}. | ติดต่อเซิร์ฟเวอร์สวนไม่ได้ — จะลองใหม่ใน {s} วินาที ตัวเลขเป็นของเวลา {time} |
| `g.err.sse` | live updates paused — polling every 20 s | หยุดอัปเดตสดชั่วคราว — ดึงข้อมูลทุก 20 วินาที |
| `g.err.marksStale` | prices not updated for {age} | ราคาไม่ได้อัปเดตมา {age} |
| `g.err.timelapseReal` | time-lapse works only with simulated prices | เร่งเวลาได้เฉพาะตอนใช้ราคาจำลอง |
| **landmark tooltips** | | |
| `g.lm.stall` | Seed stall — open the seed catalogue | แผงเมล็ด — เปิดแค็ตตาล็อกเมล็ด |
| `g.lm.barn` | Barn: account value {usd} ({pct} vs start {start}) | ยุ้งฉาง: มูลค่าบัญชี {usd} ({pct} จากทุนเริ่มต้น {start}) |
| `g.lm.silo` | Silo: account value against the {start} you started with (painted line) | ไซโล: มูลค่าบัญชีเทียบกับทุนเริ่มต้น {start} (เส้นที่ทาสีไว้) |
| `g.lm.tower` | Water tower: {usd} deployed in plots · room {room} under the {cap} cap | หอเก็บน้ำ: ลงอยู่ในแปลง {usd} · เหลือที่ {room} ใต้เพดาน {cap} |
| `g.lm.pond` | Pond: {usd} free cash to plant with | บ่อน้ำ: เงินสดว่าง {usd} ใช้ปลูกได้ |
| `g.lm.board` | Market board — all prices | กระดานราคา — ราคาทั้งหมด |
| `g.lm.mailbox` | Mailbox — garden diary | ตู้จดหมาย — บันทึกสวน |
| `g.lm.firepit` | Fire pit — burn the field (closes every plot) | กองไฟ — เผาไร่ (ปิดทุกแปลง) |
| `g.lm.sundial` | Sundial — time-lapse +1h (simulated prices only) | นาฬิกาแดด — เร่งเวลา +1 ชม. (เฉพาะราคาจำลอง) |
| `g.lm.crates` | Harvest crates: {n} closed with a gain, {usd} total | ลังผลผลิต: ปิดได้กำไร {n} ครั้ง รวม {usd} |
| `g.lm.compost` | Compost heap: {n} closed at a loss, {usd} total | กองปุ๋ยหมัก: ปิดขาดทุน {n} ครั้ง รวม {usd} |
| `g.lm.pip` | Pip the scarecrow — help and tour | พิปหุ่นไล่กา — ความช่วยเหลือและทัวร์ |
| **accessibility** | | |
| `g.a11y.stage` | 3D island view — arrow keys move the camera; the plot list has every action | มุมมองเกาะ 3 มิติ — ใช้ปุ่มลูกศรเลื่อนกล้อง ทุกคำสั่งอยู่ในรายการแปลง |
| `g.a11y.scene` | Island with {n} plants: {up} in profit, {down} at a loss | เกาะที่มีต้นไม้ {n} ต้น: กำไร {up} ต้น ขาดทุน {down} ต้น |
| `g.a11y.sceneEmpty` | Island with no plants yet | เกาะที่ยังไม่มีต้นไม้ |
| `g.a11y.skip` | Skip to the plots | ข้ามไปที่รายการแปลง |
| `g.a11y.list` | Open the list view | เปิดมุมมองรายการ |
| `g.a11y.selected` | Plot {n} selected | เลือกแปลง {n} แล้ว |
| `g.a11y.pickMode` | Seed {coin} selected — choose an empty plot, or press Esc to cancel | เลือกเมล็ด {coin} แล้ว — เลือกแปลงว่าง หรือกด Esc เพื่อยกเลิก |
| `g.a11y.cancelPick` | Planting cancelled | ยกเลิกการปลูกแล้ว |
| **list view** | | |
| `g.list.title` | Field list | รายการแปลง |
| `g.list.plot` | Plot | แปลง |
| `g.list.crop` | Crop | พืช |
| `g.list.side` | Side | ฝั่ง |
| `g.list.lev` | Lev. | เลเวอเรจ |
| `g.list.mark` | Mark | ราคา |
| `g.list.entry` | Entry | ราคาเข้า |
| `g.list.pnl` | P&L | กำไรขาดทุน |
| `g.list.pct` | % of water | % ของน้ำ |
| `g.list.water` | Water | น้ำ |
| `g.list.liq` | To liq. | ถึงจุดล้าง |
| `g.list.state` | State | สถานะ |
| `g.list.actions` | Actions | คำสั่ง |
| **help** | | |
| `g.help.title` | Controls | การควบคุม |
| `g.help.pan` | Move: drag · arrow keys | เลื่อน: ลาก · ปุ่มลูกศร |
| `g.help.rotate` | Rotate: right-drag · two-finger twist · Q / E | หมุน: ลากคลิกขวา · บิดสองนิ้ว · Q / E |
| `g.help.zoom` | Zoom: wheel · pinch · + / − | ซูม: ล้อเมาส์ · จีบนิ้ว · + / − |
| `g.help.select` | Select a plot: click · tap · 1–9, 0 · [ ] | เลือกแปลง: คลิก · แตะ · 1–9, 0 · [ ] |
| `g.help.focus` | Focus: double-click · double-tap · Enter · F | ซูมเข้าแปลง: ดับเบิลคลิก · แตะสองครั้ง · Enter · F |
| `g.help.back` | Back / reset view: Esc · Home | ย้อนกลับ / รีเซ็ตมุมมอง: Esc · Home |
| `g.help.panels` | Seeds P · Diary D · List L · Prices B · Mute M · Help ? | เมล็ด P · บันทึก D · รายการ L · ราคา B · ปิดเสียง M · ช่วยเหลือ ? |
| `g.help.safety` | Keys only open panels — nothing that spends money or closes a position runs from one key. | ปุ่มลัดเปิดได้แค่หน้าต่าง — ไม่มีปุ่มเดียวที่ใช้เงินหรือปิดสถานะได้ทันที |
| `g.help.colours` | Green / red = money · blue / violet = side · amber = risk | เขียว / แดง = เงิน · ฟ้า / ม่วง = ฝั่ง · เหลืองอำพัน = ความเสี่ยง |
| **buttons** | | |
| `g.btn.seeds` | 🌱 Seeds | 🌱 เมล็ด |
| `g.btn.list` | ☰ List | ☰ รายการ |
| `g.btn.diary` | 📔 Diary | 📔 บันทึก |
| `g.btn.prices` | 📈 Prices | 📈 ราคา |
| `g.btn.more` | ⋯ More | ⋯ เพิ่มเติม |
| `g.btn.reset` | Reset view | รีเซ็ตมุมมอง |
| `g.btn.close` | Close | ปิด |
| `g.btn.help` | Help | ช่วยเหลือ |
| `g.btn.settings` | Settings | ตั้งค่า |
| **crop names** | | |
| `g.crop.BTC` | orange tree | ต้นส้ม |
| `g.crop.ETH` | eggplant | มะเขือม่วง |
| `g.crop.SOL` | sunflower | ทานตะวัน |
| `g.crop.HYPE` | hops | ฮอปส์ |
| `g.crop.XRP` | rice | ข้าว |
| `g.crop.DOGE` | corn | ข้าวโพด |
| `g.crop.AVAX` | chili pepper | พริก |
| `g.crop.LINK` | peas | ถั่วลันเตา |
| `g.crop.SUI` | watermelon | แตงโม |
| `g.crop.NEAR` | carrot | แครอท |
| `g.crop.ARB` | blueberry | บลูเบอร์รี |
| `g.crop.TIA` | tea bush | ต้นชา |
| `g.crop.ZEC` | zucchini | ซูกินี |
| `g.crop.WIF` | mushroom in a knit hat | เห็ดใส่หมวกไหมพรม |
| `g.crop.PUMP` | pumpkin | ฟักทอง |
| `g.crop.VVV` | grapes | องุ่น |
| `g.crop.other` | beanstalk | ต้นถั่ว |

### 7.3 Reduced motion

Reduced motion is active when the setting is *Reduced*, or *Follow system* plus
`matchMedia('(prefers-reduced-motion: reduce)')`. It is live-updated via the media query's `change` event.
Effects:

- `tween.setMotionScale(0)`: durations become ≤ 150 ms, with opacity/colour fades only; springs snap.
- No camera flights (cuts with a 150 ms crossfade), no inertia, no idle drift.
- No ambient motion: sway, grass wind, clouds, critters, farmer, chimney, waterfall, rain and lightning are all
  off. The sky is static.
- No particles. Effects that carry information become static icons (dust → icon; coins → crate/compost update).
- The loop renders **on demand only** (`loop.setMode('demand')`), after data changes or input.
- The ticker digit flip is off.

### 7.4 Colour-blind palette

When enabled:
- P&L up becomes #1F78B4 (blue) and down becomes #E66101 (orange). ▲/▼ and signs remain.
- Side pills switch to neutral outlined pills (ink border, arrow glyph). The 3D sign keeps its arrow shape and
  becomes light grey #D9D4C7 (up) / dark grey #5A5550 (down), so blue does not mean two things.
- Thermometer bands keep their patterns (hazard stripes on danger).

### 7.5 Quality tiers (only step down at runtime)

| | High (desktop default) | Medium (coarse pointer or `deviceMemory ≤ 4`) | Low |
|---|---|---|---|
| DPR cap | 2.0 | 1.5 | 1.0 |
| Antialias | MSAA (context) | MSAA | off |
| Shadows | PCFSoft 2048, every frame | PCF 1024, every 2nd frame | none; blob decals (64×64 radial CanvasTexture) |
| Post (tilt-shift + vignette, P2) | on (render target `samples: 4`) | off | off |
| Grass instances | 900 | 500 | 200 |
| Particle pool | 1500 | 800 | 300 |
| Critters / farmer | on / on | on / on | off / on |
| Inverted-hull outlines | hover + selected | selected | selected |
| Target fps | 60 | 60 (fine pointer) / 30 (coarse) | 30 |
| Main-pass draw calls | ≤ 140 | ≤ 110 | ≤ 80 |
| Shadow casters | ≤ 70 | ≤ 50 | 0 |
| Triangles | ≤ 250k | ≤ 150k | ≤ 80k |

- **Governor.** Rolling 3 s mean frame time vs budget (16.7 / 33.3 ms). Above 1.3× budget, it steps down
  once and shows toast `g.set.qualityLowered`. It waits 5 s before evaluating again.
- Steps in order: DPR −0.25 → post off → shadows Medium → shadows off (blobs) → grass halved → particles
  halved → tier Low.
- It never steps up during a session. A manual change in Settings resets it.
- *Auto* starts at High, or Medium for a coarse pointer or `deviceMemory ≤ 4`. If the WebGL2 context was
  created only under a `failIfMajorPerformanceCaveat: false` retry (software rendering), Auto starts at Low
  and shows `g.boot.slowGpu`.

### 7.6 WebGL2 / engine fallback to `/classic.html`

`web/js/game/boot.js` runs before anything heavy:

1. `adoptUrlParams()` from `brood-api.js` (stores and strips `?token=`).
2. If `?classic=1` is present → `location.replace('/classic.html' + location.search)`.
3. Probe `canvas.getContext('webgl2')`. three r169 requires WebGL2, so **WebGL1 is not enough**. On failure,
   show the interstitial `g.boot.noWebgl` with a link `g.boot.openClassic`, then redirect after 1.5 s.
4. `fetch('/vendor/three/build/three.module.min.js', {method: 'HEAD'})`. On 404, show `g.boot.noEngine`, then
   redirect as above.
5. `import('./main.js')`. On a module error, show `g.boot.error` with retry and classic links.

At runtime:
- `webglcontextlost` → `preventDefault`, overlay `g.boot.contextLost`, pause the loop. On `restored`,
  rebuild GPU resources: world, field and fx expose `rebuild()`.
- No restore within 5 s, or a second loss within 60 s, → `g.boot.contextFailed` with classic and retry links.
- `classic.html` is the current `index.html` moved verbatim. It keeps `css/garden.css`, `js/garden.js` and its
  CSP compliance, and the footer gains a link back to `/` (the 3D garden).

---

## 8. Audio (procedural WebAudio; `web/js/game/audio/sfx.js`)

- **Default state: off.**
  - The 🔇/🔊 header toggle and `M` switch it; the choice persists in settings.
  - The `AudioContext` is created only inside the first user gesture that enables sound.
  - Muting fades the master over 80 ms.
  - The context suspends on `document.hidden` and resumes on visible.
- **Graph:** `voices → bus (ui −18 dB | events −16 dB | ambience −24 dB) → DynamicsCompressor → master
  (−14 dB × volume)`.
  - Dialogs duck ambience by 6 dB.
  - At most 12 voices; the oldest ambience voice is stolen first.
  - `plip` is throttled to 1 per 150 ms and the chime to 1 per bar.
- **Tone rule:** audio confirms an event without judging it. No "fail" stingers. Gains never get more than
  the coin blips.

| Name | Recipe |
|---|---|
| `windBed` | pink noise → lowpass 400 Hz, LFO 0.07 Hz ±150 Hz on cutoff; gain × windFactor/2.4 |
| `birds` (day) / `crickets` (clock-night) | FM sine chirps 2.5–4 kHz every 3–9 s (fewer in rain) / bandpassed noise pulses 4.5 kHz at 12 Hz |
| `rain` | white noise → highpass 1 kHz; gain 0 / 0 / 0.25 / 0.45 by weather |
| `thunder` | brown noise → lowpass 200 Hz, 3 s exponential decay, 1–3 s after a flash |
| `thup` | sine 140→60 Hz, 120 ms, plus a noise burst through lowpass 800 Hz |
| `pop` | sine 600→180 Hz, 120 ms; pitch from the pentatonic C5 D5 E5 G5 A5 C6 by fruit index |
| `burble` | 6–10 random sine blips 600–1200 Hz, 40 ms decays, over 600 ms |
| `plip` | open: sine 1200→600 Hz, 80 ms; close: 600→900 Hz, 80 ms; triangle overtone −12 dB |
| `tock` + `chime` | bandpassed noise click 1.8 kHz 20 ms; then a pentatonic note (cycling per bar), 0.8 s exponential decay |
| `coinBlips` | triangle blips rising through the pentatonic, 50 ms apart, count = coins (max 8) |
| `rustle` + `thud` (pull) | bandpass 2 kHz noise 300 ms + sine 90 Hz thud, 200 ms. Neutral. |
| `fwump` / `twoNoteUp` | lowpassed noise 200 ms / sine G4 → C5, 120 ms each |
| `knock` | bandpass 900 Hz noise, 30 ms, ×2 at 120 ms |
| `hail` | 40 short highpassed noise ticks over 1.5 s + thud |
| `whoosh` + `crackle` | noise sweep 300 → 3 kHz 400 ms; lowpass 600 Hz noise with random-amplitude crackle bursts, 3 s envelope |
| `paperRustle` / `paperFlop` | bandpass 3 kHz noise 150 ms / 250 ms with a downward filter sweep |
| `glint` / `sigh` / `tickTick` / `mutedBell` / `whirr` | sine 2.4 kHz 60 ms ×3 / two triangle notes E4→C4 lowpassed / 2 clicks 1 kHz / 3 inharmonic partials 220 Hz, 1.2 s / sawtooth 200→800 Hz 2 s lowpassed |

**API**

```js
export function createSfx({ settings }) → {
  enable(on: boolean),            // must be called from a user gesture the first time
  setVolume(v: number), setAmbience(on), setChime(on),
  play(name: string, opts?: { pitch?: number, count?: number, gain?: number }),
  setWeather(key), setWind(factor), setNight(isNight), duck(on), dispose()
}
```

---

## 9. Frontend architecture

### 9.1 File tree (`web/`)

Owners (WP1–WP5) are defined in §11.1.

```
web/index.html                    WP5  3D shell: HUD markup, containers, <script type="module" src="/js/game/boot.js">
web/classic.html                  WP2  the current index.html, moved verbatim (+ footer link to "/")
web/css/garden.css                –    unchanged (classic)
web/css/game.css                  WP5  all 3D-page styles, tokens, responsive, chips/floaters classes
web/img/icons.svg                 WP5  SVG <symbol> sprite (§9.10)
web/js/brood-api.js               –    unchanged (stream() gets extra kinds via its `kinds` option)
web/js/format.js                  –    unchanged
web/js/i18n.js                    WP5  + all keys of §7.2 (EN/TH)
web/js/plant.js                   –    unchanged: stage(), botPhase(), botPnl(), GROWTH
web/js/garden.js                  WP2  pure helpers moved to model.js and RE-EXPORTED (classic + web.test.js keep working);
                                       time-lapse hidden when live.prices === 'real'
web/js/model.js                   WP2  pure shared helpers (no DOM, no three)
web/js/game/boot.js               WP2  capability checks → import('./main.js') | redirect (§7.6)
web/js/game/main.js               WP2  wiring (§9.6)
web/js/game/three.js              WP2  `export * from '/vendor/three/build/three.module.min.js';` (the ONLY three import)
web/js/game/stage.js              WP2  dynamic-import entry for everything that needs three (renderer, world, field, fx)
web/js/game/core/store.js         WP2  state container
web/js/game/core/bus.js           WP2  event bus
web/js/game/core/data.js          WP2  polling + SSE + commands → store/bus
web/js/game/core/view.js          WP2  PURE: plotView, assignSlots, feedBadge, ageTag, liqInfo, moneyView, sceneSummary
web/js/game/core/rules.js         WP2  PURE: Juice Contract helpers (coinBurst, levTier, gustCheck, effect guards)
web/js/game/core/settings.js      WP2  persisted settings + reduced-motion resolution
web/js/game/fx/director.js        WP2  PURE reducer → Effect[] (§9.5)
web/js/game/gfx/renderer.js       WP2  WebGLRenderer, context loss, resize, DPR
web/js/game/gfx/loop.js           WP2  frame loop, on-demand mode, stats, ?debug=1 overlay
web/js/game/gfx/tiers.js          WP2  tier table + governor
web/js/game/gfx/camera.js         WP2  rig (§5.1), safe area, focus
web/js/game/gfx/picking.js        WP2  raycast proxies, gestures (tap/double/long-press/drag)
web/js/game/gfx/labels.js         WP2  projected DOM anchors (chips, tooltips, signs)
web/js/game/gfx/tween.js          WP2  tween/spring/timeline, motion scale
web/js/game/gfx/post.js           WP2  tilt-shift + vignette (P2)
web/js/game/gfx/materials.js      WP3  toon gradient, shared materials, crop shader patch + depth material
web/js/game/gfx/geom.js           WP3  procedural geometry utils (lathe, tube, leaf strip, lowpoly, merge, vertex AO, noise)
web/js/game/gfx/palette.js        WP3  scene colour constants, sky keyframes
web/js/game/world/world.js        WP3  buildWorld(): island + landmarks + sky + weather; World API
web/js/game/world/island.js       WP3  terrain top/underside, paths, rocks, rim trees, grass
web/js/game/world/landmarks.js    WP3  stall, barn, silo, crates, compost, tower, pond+pump, windmill, sundial, board, mailbox, firepit, pip, signpost
web/js/game/world/sky.js          WP3  sky dome shader, lights, day/night, fog
web/js/game/world/weather.js      WP3  clouds, rain, lightning, wind/gust uniforms
web/js/game/world/farmer.js       WP3  farmer actor (P1)
web/js/game/world/critters.js     WP3  birds/moles hooks for plots (P1), bees/butterflies/flock (P2)
web/js/game/audio/sfx.js          WP3  §8
web/js/game/crops/catalog.js      WP4  PURE data: CROPS (§3.1), cropFor()
web/js/game/crops/builders.js     WP4  9 builders → CropMesh
web/js/game/field/field.js        WP4  Field: slots, sync, pick-mode glow, plot lookup
web/js/game/field/plot.js         WP4  Plot actor: box, soil, post, sign, ×N stake, sacks, thermometer, parasol, signs, crop
web/js/game/field/plotFsm.js      WP4  per-plot FSM + timeline queue
web/js/game/fx/executor.js        WP4  runs Effect[] against field/world/particles/labels/sfx
web/js/game/fx/particles.js       WP4  GPU-ballistic pool + procedural atlas
web/js/game/fx/coins.js           WP4  coin/clump arcs (InstancedMesh)
web/js/game/fx/floaters.js        WP4  DOM floating labels (pool 24, ≤ 8 visible)
web/js/game/ui/hud.js             WP5  top bar, money chips, weather/wind/clock, live dot
web/js/game/ui/badge.js           WP5  mode badge + popover, signpost label
web/js/game/ui/ticker.js          WP5  ticker row
web/js/game/ui/board.js           WP5  market board panel
web/js/game/ui/dock.js            WP5  plot dock (<ol>), chips container sync
web/js/game/ui/chips.js           WP5  projected per-plot chips (uses gfx/labels)
web/js/game/ui/shelf.js           WP5  seed catalogue + drag source
web/js/game/ui/plantDialog.js     WP5
web/js/game/ui/inspector.js       WP5
web/js/game/ui/confirm.js         WP5  harvest/pull/shade/burn dialogs
web/js/game/ui/diary.js           WP5
web/js/game/ui/settings.js        WP5
web/js/game/ui/tutorial.js        WP5
web/js/game/ui/listview.js        WP5  (P1)
web/js/game/ui/radial.js          WP5  (P1)
web/js/game/ui/help.js            WP5
web/js/game/ui/sheets.js          WP5  panel/bottom-sheet manager + safe-area reporting
web/js/game/ui/a11y.js            WP5  announce/alert helpers, scene summary, focus utils
```

**Import rules:**
- Only `gfx/*`, `world/*`, `crops/builders.js`, `field/*`, `fx/executor.js`, `fx/particles.js` and
  `fx/coins.js` may import `../three.js`, and they are loaded only through `stage.js`.
- `core/*`, `fx/director.js`, `crops/catalog.js`, `model.js` and `ui/*` must not import three, and must have
  no side effects at import. This keeps them testable under `node --test`: three's absolute-path import does
  not resolve in Node.
- Nothing uses `innerHTML` with data. Use `textContent` or attributes (existing rule).
- No inline styles via `setAttribute('style')`. Dynamic positions use CSSOM (`el.style.transform = …`), which
  `style-src 'self'` allows.

### 9.2 `model.js` (pure; shared by classic and 3D)

```js
// moved from garden.js (same names, same behaviour; garden.js re-exports them)
export const WATER;                               // {min:20, max:1000, step:10, def:100}
export function shelfQuery(opts) {}               // unchanged
export function weatherOf(coins) {}               // unchanged → {key, mean} | null
export function mirrorNote(bean, stake) {}        // unchanged → {pct, notional}
export function stakeRoom(bean, live) {}          // unchanged → {maxStake, cap} | null
export function entryMargin(bean, stake) {}       // unchanged
export function dirKey(dir) {}                    // unchanged
export function familyOf(archetype) {}            // unchanged
// new
export const COSTS = { fee: 0.00045, slip: 0.00015, liqFraction: 0.95 };
export function pxDecimals(px, szDecimals) {}     // min(6 − szDecimals, max(0, 6 − (floor(log10|px|) + 1)))
export function fmtPx(px, szDecimals) {}          // '$' + en-US grouping with pxDecimals; '—' if not finite
export function fmtSz(sz, szDecimals) {}          // |sz|.toFixed(szDecimals)
export function plantQuote(bean, stake, live) {}  // → {notional, lev, margin, liqMovePct, fees, worst, exceedsWater, room}
export function closeQuote(bot, mark) {}          // → {estTotal, fee, slip} using COSTS (≈ values)
export function windOf(coins) {}                  // mean |change_1h| → {key:'calm'|'breezy'|'windy'|'gale', factor, mean} | null
```

`fmtPx` test vectors:

| Input | Output |
|---|---|
| BTC 82980.5, szDec 5 | `$82,980.5` |
| ETH 2509.354, szDec 4 | `$2,509.35` |
| SOL 110.4251, szDec 2 | `$110.425` |
| DOGE 0.1812346, szDec 0 | `$0.181235` |
| PUMP 0.0061234, szDec 0 | `$0.006123` |

### 9.3 `core/view.js` (pure)

```js
/** PlotView: everything the field, chips, dock, inspector need for one slot. */
export function plotView(bot, slot, { marks, coins, nowMs, skewMs }) → PlotView
// PlotView = {
//   slot, botId, beanId, coin, crop, family, archetype, strategy,
//   state: 'waiting'|'entering'|'growing'|'paused'|'closed',  phase (botPhase), note, error,
//   side: 1|-1|0, lev, beanLev, venueMaxLev, szDecimals,
//   water, realized, unrealized, fees, fills, usd, frac, pct,            // money (server numbers)
//   size, health, fruit, flower, seed, caption, ripe,                    // = stage(botForStage)
//   szi, entry, mark, notional, margin, liq,                             // position
//   liqInfo: {d, movePct, dir:'fall'|'rise', band:'ok'|'warn'|'danger'} | null,
//   markMs, ageTag: 'fresh'|'delayed'|'stale', est: boolean,             // est = client ≈ estimate in use
//   stale: boolean, frozen: boolean, halted: boolean, updatedMs }
```

**How the marks are merged:**
- `botForStage = {...bot, realized_pnl: m.realized_pnl, real: {...bot.real, unrealized_pnl: m.unrealized_pnl}}`,
  where `m = marks.bots[bot.id]` when `m.as_of_ms > bot.real.as_of_ms`. Otherwise `bot` is used as-is.
- If `m` is absent but `marks.px[coin]` is newer than the bot, `unrealized ≈ szi·(px − entry)` and
  `est = true` (shown with `≈`).
- `frozen` is true when the coin is in `marks.stale`, or the mark age is > 60 s.
- The age is `nowMs + skewMs − markMs`. `skewMs = health.now_ms − clientReceiveMs`, refreshed every 30 s.

**Other exports:**

```js
export function assignSlots(openBots, prevMap, { slotCount, wanted }) → { map: {[botId]: slot}, hidden: botId[] }
//   stable: keep prevMap entries for still-open bots; `wanted` (beanId → slot, from the plant dialog) wins if free;
//   others take the lowest free slot; persisted by data.js in localStorage["bean.game.slots.v1"].
export function slotCountOf(live, openBots) → number                // §2.3
export function liqInfo({ szi, mark, entry, liq }) → { d, movePct, dir, band } | null
//   movePct = |mark − liq| / mark;  d = clamp(|mark − liq| / |entry − liq|, 0, 1);
//   band: d > 0.6 ok, > 0.3 warn, else danger.  Test: long entry 82410, lev 10 → liq 74581.05;
//   mark 82980.5 → movePct 0.10122 ("10.1%"), dir 'fall', d = 1, band ok.
export function ageTag(ms, nowMs) → 'fresh' (≤ 15 s) | 'delayed' (≤ 60 s) | 'stale'
export function feedBadge({ status, marks, net, nowMs }) → { key, tone, vars }   // §6.3 truth table
export function moneyView(live, marks) → { barn, vsStartPct, pond, tower, growing, harvested, plants, maxPlants, ages }
export function closedTotals(bots) → { crates: {n, usd}, compost: {n, usd} }
export function sceneSummary(views) → { key, vars }
```

### 9.4 `core/rules.js` (pure; Juice Contract)

```js
export function coinBurst(usd) → 0 if usd ≤ 0; 1 (<1); 3 (<10); 6 (<50); 9 (<200); 12 (≥200)
export function levTier(lev) → 0 (≤1) | 1 (≤5) | 2 (≤10) | 3 (≤25) | 4 (≤50) | 5
export function closeRecipe(realizedUsd) → 'harvest' (≥ 0) | 'pull' (< 0)
export function isReplayed(fill, nowMs, skewMs) → fill.time_ms < nowMs + skewMs − 120_000
export function gust(prevPx, px, coins) → { coin, pct } | null       // |Δ| > 0.3 % (plus 20 s cooldown kept by caller)
export function assertEffect(effect) → effect                        // throws in tests if J4/J5/J11 broken
```

### 9.5 `fx/director.js` (pure reducer) and Effects

```js
export function direct(prevViews, nextViews, event, ctx) → Effect[]
// prevViews/nextViews: {[slot]: PlotView}; event: normalised game event (§9.6) or null (view diff only);
// ctx: { nowMs, skewMs, reduced, halted, pending: {[key]: true}, lastFruitLoss: {[slot:index]: ms} }
```

**Effect** is `{ kind, slot?, coin?, usd?, n?, text?, tone?: 'up'|'down'|'neutral'|'warn', meta? }`. The kinds
WP4 must implement, matching §4 one to one:

`pending, plantOk, plantFail, water, fill, fillMerged, flip, capTag, fruitGain, fruitGainQuiet, fruitLoss,
ripeOn, wiltOn, dyingOn, liqDangerOn, frozenOn, frozenOff, harvest, pull, shade, resume, liquidate, bustPlanted,
bustShelf, error, tick, gust, weather, timelapse, burnStart, burnPlot, burnEnd, feedLook, label, sfx`.

**Director rules (tested):**
- `harvest` only when `realized_pnl ≥ 0`, carrying `coinBurst(usd)` coins. `pull` carries zero coins and no
  sparkle.
- No `plantOk` without a 2xx or an `bot_created` echo.
- Fills within 400 ms on one slot → one `fillMerged`.
- `Close X` then `Open Y` within 400 ms → `flip`.
- `isReplayed(fill)` → no effects.
- `fruitGain` within 10 s of a `fruitLoss` of the same index → `fruitGainQuiet`.
- Marks never produce effects other than spring retargets, which the field does itself.
- `burnPlot` effects are staggered 250 ms in slot order, each with that bot's own `realized_pnl`.
- Under `ctx.reduced` the same effects are emitted; the executor renders the RM variants.

### 9.6 Store, bus, data flow

```js
// core/bus.js
export function createBus() → { on(type, fn) → off, once(type, fn), emit(type, payload) }
// core/store.js
export function createStore(initial) → { get(), set(patchOrFn), select(selector, fn, equals = Object.is) → off, version }
```

**State shape (frozen on day 1):**

```js
{
  boot:   { phase: 'loading'|'ready'|'error', error: null },
  net:    { ok, lastOkMs, error, stream: 'off'|'live'|'reconnecting'|'polling', skewMs, retryInMs },
  health, status, meta,                                   // raw payloads
  feed:   { source, prices: 'real'|'sim', state: 'live'|'delayed'|'down'|'sim', staleCoins: [], fallback, realAvailable,
            nextTickMs, lastBarCloseMs, lagBars, tickMs },
  live:   LiveStatus | null,
  bots:   BotRow[],                                       // all states
  detail: { [botId]: { bot, bean, fills, orders, fetchedMs } },
  market: { coins: { [coin]: CoinRow }, weather: {key, mean} | null, wind: {key, factor, mean} | null, fetchedMs },
  marks:  { t, receivedMs, source, prices, px: {}, stale: [], bots: {}, account: {} } | null,
  priceHistory: { [coin]: Array<[ms, px]> },              // ring of 120 per coin (from mids)
  shelf:  { rows: BeanRow[], curves: {}, loading, error, filters: { sort, archetype, sproutingOnly } },
  slots:  { map: {[botId]: slot}, count, hidden: [], wanted: {[beanId]: slot} },
  views:  { [slot]: PlotView },                           // recomputed by main on bots/marks/market change
  ui:     { selectedSlot: null, focusSlot: null, pickBean: null, panel: null, dialog: null, pending: {} },
  diary:  [{ ms, kind, cls, text }],                      // ≤ 60, newest first
  settings: Settings,
}
```

**`core/data.js`:**

```js
export function startData({ store, bus, api }) → {
  tend(), restock(), refreshMarket(), refreshStatus(), loadDetail(botId),
  command(op, params, { target }) → Promise<body>,   // emits cmd:pending / cmd:done; uses markOwn/isOwn echo de-dup
  stop()
}
```

**Polling cadence:**
- `tend` (bots + live_status): every 20 s, plus debounced 700 ms after `tick_completed`/`bot_*`/`live_*`
  (150 ms for `bot_*`).
- `market`: every 60 s (real) / 30 s (sim).
- `status` + `health`: every 30 s and on `feed_status`.
- Shelf: on boot, on `bot_created`/`bot_closed`/`busted`/`live_halted`, and on a manual restock.

**SSE:** `api.stream(onEvent, {kinds: [...api.EVENT_KINDS, 'feed_status', 'feed_gap', 'mids']})`. On reconnect:
`tend`, `refreshMarket`, `refreshStatus`. `?nostream=1` → polling only, with marks from `market` every 10 s.

**Normalised bus events:**
- `game:event` with `{type, ...}` where `type ∈ fill | created | paused | resumed | closed | halted | error |
  orderSkipped | tick | busted | feed | gap | warmup | daemon`;
- `data:marks`, `data:views`;
- `cmd:pending {op, key}`, `cmd:done {op, key, ok, body}`;
- `ui:select`, `ui:focus`, `ui:pick`, `ui:panel`;
- `settings`, `quality`.

**`main.js` wiring:**
1. `initLang()`, settings, store, bus, `startData()`, then mount every `ui/*` module
   (`mount({store, bus, data, sfx?})`). The HUD is usable before 3D exists.
2. `await import('./stage.js')` → `createStage({store, bus, canvas, settings})`. This creates the renderer,
   loop, rig, picker, labels, world, field, executor and particles, and returns
   `{ field, world, rig, picker, labels, loop, fx, dispose }`.
3. On every `bots`/`marks`/`market`/`slots` change, recompute `views` with `plotView`. Then
   `effects = direct(prev, next, event, ctx)` → `fx.run(effects)`, and `field.sync(views, slotCount)`.
4. UI modules call `data.command()` and `stage.rig.focus()`. Effects go only through the director, so the UI
   never animates outcomes itself.

### 9.7 Scene and actor model (interfaces WP3/WP4 implement)

```js
// stage.js (WP2)
export async function createStage({ store, bus, canvas, settings }) → Stage
// world/world.js (WP3)
export function buildWorld({ scene, tier, settings }) → World
World = {
  landmarks: Map<id, { id, object3D, proxy, anchor, setState(s) }>,   // ids of §2.4
  slotPosition(i, count) → Vector3, standPoint(i, count) → Vector3,
  setWeather({key, mean}), setWind(factor), gust(), setDaylight(mode: 'day'|'clock', timeMs),
  setFeedLook(state), setHalted(bool),
  setMoney({ towerFill, pondFill, siloFill, crates: {n}, compost: {n} }),   // 0..1 fills, counts
  setBarProgress(p01), kickWindmill(), setSundial(visible), setUnread(n),
  farmer: { goto(slot, pose) → void, setEnabled(b) } | null,
  update(dt, t), rebuild(), dispose()
}
// field/field.js (WP4)
export function createField({ scene, world, picker, labels, tier, settings }) → Field
Field = { sync(views: {[slot]: PlotView}, count), plot(slot) → Plot | null, setPickMode(on, beanCoin?),
          setHover(slot|null), setSelected(slot|null), setDim(exceptSlot|null), update(dt, t), rebuild(), dispose() }
Plot  = { slot, object3D, anchor, proxy, view, fsm, play(effect) → Promise, setView(view) }
// crops/builders.js (WP4)
export function buildCrop(coin, { tier }) → CropMesh
CropMesh = { group, setGrowth({ size, health, fruit, flower, ripe, frac, seed, shaded, frost, frozen }),
             setSway(amp, shiver, windFactor), fruitWorld(i) → Vector3, update(dt, t), dispose() }
// fx/executor.js (WP4)
export function createFx({ scene, field, world, labels, sfx, bus, settings }) → { run(effects), update(dt, t), clear(), rebuild() }
// gfx/labels.js (WP2)
export function createLabels(camera, container) → { anchor(object3D, el, { offsetY = 0, hideBehind = true }) → { remove(), setVisible(b) }, update() }
// gfx/picking.js (WP2)
export function createPicker(camera, dom) → { register(proxy, info) → off, onHover(fn), onTap(fn), onDouble(fn),
                                              onLongPress(fn), onDragDrop(fn), pickAt(x, y), setEnabled(b) }
// gfx/camera.js (WP2)
export function createRig(camera, dom, { portrait }) → { update(dt), focus(vec3, opts) → Promise, back(), reset(),
                                              setSafeArea(rect), setYaw, zoomBy, panBy, getState(), onChange(fn), setEnabled(b) }
// gfx/materials.js (WP3)
export function toonGradient() → DataTexture
export function cropMaterial({ lush, sick, dead }) → { material, depthMaterial, uniforms }  // shared program, per-plot uniforms
export function propMaterial(colorHex | { vertexColors: true }) → Material                  // cached by key
// gfx/geom.js (WP3)
export { lathe, tubeAlong, leafStrip, lowpolySphere, merge, vertexAO, noise2, displaceRadial }
```

### 9.8 Rendering details

- **three.js import:**
  - `web/js/game/three.js` is the only importer:
    `export * from '/vendor/three/build/three.module.min.js';`.
  - `index.html` adds `<link rel="modulepreload" href="/vendor/three/build/three.module.min.js">`.
  - We use the minified build: 687 KB vs 1.3 MB, and the static server does not gzip. `three.module.js` is
    served too; swapping it in is a one-line edit for debugging.
  - **No import map and no `examples/jsm` addons.** Addons import the bare specifier `'three'`, which needs an
    inline import map, which needs a CSP hash. We write our own rig, merge (~60 lines) and blur. The CSP stays
    as it is.
- **Renderer:**
  - `WebGLRenderer({antialias: tier !== 'low', powerPreference: 'high-performance'})`, `SRGBColorSpace`,
    `NoToneMapping`, DPR capped per tier, `shadowMap.type` per tier.
  - `shadowMap.autoUpdate = false`; `needsUpdate` is set every frame on High and every 2nd frame on Medium.
- **Lights:**
  - Hemisphere: sky #DFF1FF, ground #E9D9C0, 0.9.
  - Directional sun: #FFF1DC, 1.6, `castShadow`, ortho frustum ±24 around the island, `bias −0.0005`,
    `normalBias 0.02`.
  - Weather multiplies the lights (rain 0.75, storm 0.55, cooler).
  - Clock-night (P1): moonlight 0.35 minimum hemisphere; plot lanterns are emissive only, with **no point
    lights**.
- **Materials:**
  - `MeshToonMaterial` with a 3-band `DataTexture` (3×1, NearestFilter) for crops and landmarks.
  - `MeshLambertMaterial` with `vertexColors` for terrain and props.
  - Vertex AO at build time: `0.78 + 0.22·smoothstep(0, 0.6, y_local)`.
  - No image textures except procedural `DataTexture`/`CanvasTexture` (gradient, blob shadow, particle atlas).
- **Crop shader:**
  - One `onBeforeCompile` patch: bend/droop/sway/shiver/tint/frost/desaturate. Uniforms are `uSize, uHealth,
    uDroop, uSway, uShiver, uLean, uFrost, uSat, uTime, uWind, uGust, uLush, uSick, uDead`.
  - `customProgramCacheKey` returns a constant, so every per-plot clone shares one program.
  - The **same patch is applied to a `MeshDepthMaterial` assigned as `customDepthMaterial`**, so shadows bend
    with the plant.
- **Static batching:** static props are merged per material at build time (`geom.merge`). Grass, clouds,
  fences, box shells per family, soil, posts, signs, stakes, sacks and thermometers are `InstancedMesh`.
  Each crop is 1 stem/leaves mesh plus a fruit `InstancedMesh(6)` plus a flower `InstancedMesh(6)`.
- **Particles:**
  - One `InstancedMesh` of billboard quads with a custom `ShaderMaterial`. Per-instance attributes:
    spawn pos, velocity, colour, `(birth, life)`, size, atlas cell.
  - Motion is ballistic on the GPU from `uTime` (gravity, drag), so the CPU writes only on spawn into a ring
    buffer (pool per tier).
  - The atlas is an 8-cell 256×32 `CanvasTexture` drawn at boot: circle, droplet, leaf, star, sparkle, clump,
    flame, hail.
- **Coins/clumps:** `InstancedMesh` (48 max) on CPU-updated quadratic Bézier arcs.
- **Labels and floaters:** DOM. Only on-screen anchors are projected (`translate3d`, CSSOM). Chips are
  culled behind the camera and at distance > 60 u.
- **Post (P2, High only):** render to a `WebGLRenderTarget({samples: 4})`, separable 9-tap blur weighted by
  distance from a focus band (the projected y of the rig target), vignette 0.18, warm grade.

### 9.9 Render loop and performance budgets

- `renderer.setAnimationLoop(frame)`; `dt` is clamped to 50 ms.
- **Update order:** input → rig → tweens/springs → field (plots, crops) → fx (particles, coins) → world
  ambience → labels → shadow decision → render.
- **Loop modes:**
  - `continuous` (default).
  - `demand` (RM, or nothing animating for 5 s with ambience disabled): renders only after `requestRender()`.
  - Paused while `document.hidden`.
- An FPS cap per tier (30 → skip alternate frames).

| Budget | Desktop (High) | Mid phone (Medium/Low) |
|---|---|---|
| Frame | 16.7 ms (JS ≤ 4 ms) | 33.3 ms (JS ≤ 8 ms) |
| First 3D frame after HUD | ≤ 1.5 s | ≤ 2.5 s |
| World build | ≤ 300 ms | ≤ 600 ms; crops build lazily on first sync |
| JS heap | ≤ 120 MB | ≤ 80 MB |
| GPU memory | ≤ 64 MB | ≤ 48 MB |
| Our JS (unminified) | ≤ 350 KB total, ~45 ES modules | same |
| Estimated triangles | terrain 8k + landmarks 25k + 15 crops × 3k + grass 22k + clouds 3k ≈ 105k | ≈ 70k |

`?debug=1` shows an overlay: fps, frame ms, draw calls, triangles (`renderer.info`), tier, governor steps and
marks age.

### 9.10 Visual tokens and icons

- **CSS tokens** (`game.css :root`):

  | Token | Value |
  |---|---|
  | `--paper` | #FFF9EF |
  | `--paper-2` | #F6EBD8 |
  | `--ink` | #2D2620 |
  | `--ink-2` | #6E6257 |
  | `--line` | #E2D3BC |
  | `--up` / `--up-bg` | #237A4B / #DDF3E4 |
  | `--down` / `--down-bg` | #B33A32 / #FBE1DD |
  | `--long` | #2B6CB0 |
  | `--short` | #7B4FC4 |
  | `--warn` | #B7791F |
  | `--warn-bg` | #F2C14E |
  | `--real` | #1D6B5A |
  | `--sim` | #6B4FA0 |
  | `--off` | #5F6368 |
  | `--focus` | #2B6CB0 |
  | `--wood` | #C98A4B |
  | `--wood-dk` | #6B4423 |

  The colour-blind overrides go under `[data-palette="cb"]`.
- **Cards:** 14 px radius, 2 px wood-tone top border, `box-shadow: 0 6px 18px #5a3e2522`. Buttons press
  2 px. Hover spring scale 1.03 (RM: none).
- **Fonts:** system stacks only (§7.1). The display font is `ui-rounded, "Segoe UI Rounded", "Arial Rounded MT
  Bold"` plus the Thai stack. Numbers use `font-variant-numeric: tabular-nums`.
- **Scene palette:**

  | Element | Colour |
  |---|---|
  | Sky top → horizon (sunny) | #9ED3EE → #FFE6CF |
  | Sky (rain) | #8FA3B8 / #C9CFD6 |
  | Sky (storm) | #5E6B80 / #9AA3AF |
  | Grass | #A8D88E / #84C17A |
  | Path | #F0DDB8 |
  | Soil wet / dry / charred | #7A4E35 / #A7774F / #3B3330 |
  | Rock strata | #C9B8A6 / #A8968A |
  | Water | #8FD3E8 |
  | Barn / roof | #D97A6C / #7C8FB8 |
- **`img/icons.svg`** symbols (24 px grid, 2.5 px rounded strokes):
  - `i-seed, i-can, i-basket, i-hoe, i-parasol, i-sun, i-fire, i-barn, i-tower, i-pond, i-diary, i-gear,
    i-sound-on, i-sound-off, i-help, i-list, i-prices, i-warn, i-lock, i-focus, i-close, i-more, i-coin`;
  - `i-arrow-up, i-arrow-down`;
  - `i-crop-<COIN>` for all 16 coins plus `i-crop-other`.

  They are used via `<use href="/img/icons.svg#id">` (same-origin, CSP-safe). Emoji appear only in diary text
  and existing strings.

---

## 10. Backend changes (contract for WP1)

### 10.1 CLI, files and package

- **`--feed hyperliquid|sim`.** Default: **`hyperliquid`**.
  - `--tick-ms N` is accepted **only with `--feed sim`** (default 5000). With hyperliquid it is a
    `ConfigError` ("real prices run at market speed: one bar per real minute").
  - `--warmup N`: ≤ 5000 with hyperliquid (Hyperliquid keeps only the newest 5000 candles), otherwise
    `ConfigError`. Default 2880.
- **State files per feed**, so switching feeds never destroys the other garden:

  | Feed | State file | Journal file |
  |---|---|---|
  | sim (legacy names, existing gardens keep working) | `data/state.json` | `data/journal.jsonl` |
  | hyperliquid | `data/state-real.json` | `data/journal-real.jsonl` |

  `incompatibility()` keeps the feed check as a safety net.
- **`package.json`:**
  - `"start": "node server/main.js"` (real);
  - `"sim": "node server/main.js --feed sim"`;
  - `"dev": "node server/main.js --feed sim --tick-ms 2000"`;
  - `"fresh"` unchanged;
  - `"dependencies": {"three": "0.169.0"}` (already pinned exactly; served to the browser only, the server
    never imports it);
  - the description is updated to "real prices, paper trades".
- `.claude/launch.json` adds `--feed sim` to its `--tick-ms 3000` args.
- README and SPEC: "run `npm install` once". SPEC §0 and §1 ("zero dependencies" → one browser-asset
  dependency), §2.1 (real time), §2.2 (feed) and §4 (new fields/events) are updated.

### 10.2 Hyperliquid usage (read-only; no keys, no signing; `POST https://api.hyperliquid.xyz/info`)

| Request | When | Weight | Use |
|---|---|---|---|
| `{"type":"metaAndAssetCtxs"}` | boot; then once per minute (after each tick) | 20 | `universe[i].{name, szDecimals, maxLeverage}` and `ctx[i].{midPx, markPx, oraclePx, prevDayPx, funding, openInterest, dayNtlVlm}`, aligned by index |
| `{"type":"allMids"}` | every **5 s** | 2 | live mid per coin → marks |
| `{"type":"candleSnapshot","req":{coin,"interval":"1m",startTime,endTime}}` | warmup (2880 per coin), catch-up, and at each minute close (≤ 2 candles per coin) | 20 + 1 per 60 candles | bars `[{t,T,o,h,l,c,v,n}]`, string numbers, `t` = open ms |

- **Budget.** Steady state is 24 + 20 + 16 × 20 = **364 weight/min** (HL allows 1200/min per IP). Warmup is
  16 × 68 = 1088.
- **Rate limiter.** `market.js` keeps a rolling 60 s weight ledger with a **1000** budget.
  - Candle requests queue until the budget allows.
  - `allMids` and `metaAndAssetCtxs` are *skipped*, not queued, when over budget.
  - HTTP 429 → 15 s back-off for all requests, and `state → delayed`.
- Every request uses `AbortSignal.timeout(8000)`. The fetch implementation is injectable for tests.

### 10.3 Bars on real minutes

- **Grid.** Bar `b` has open time `startMs + b·60 000`. After warmup, `startMs` = last closed minute −
  (warmup − 1) min, so bar index ↔ wall-clock minute exactly (the existing `alignCandles` forward-fill stays).
- **Scheduler** (`Engine.run()` in real mode replaces `setInterval`): timer at the next minute boundary +
  **2000 ms grace**. On fire, the target bar is the one that just closed. Then:
  1. `await market.fetchClosed(targetOpenMs)`, which requests the closed candle for each coin. A coin whose
     candle is not yet published is retried at +5 s and +10 s, up to a **15 s deadline**.
  2. Per coin, in priority order:
     - **(a)** the HL candle;
     - **(b)** a bar built from that minute's 5 s mid samples (`o` = previous close, `h/l` = max/min of
       samples and `o`, `c` = last sample), with `bar_src: 'mids'`;
     - **(c)** if neither exists, a **flat bar** at the previous close, with the coin marked **stale**.
  3. If **every** coin is in case (c) (HL unreachable): **do not tick**. `lag_bars++`, `state → down` after
     60 s without any successful HL response, and retry every 15 s. On recovery, run catch-up (§10.6).
  4. Otherwise `engine.tick()` runs synchronously as today. `tick_completed` gains
     `{closed_ms, next_tick_ms, source}`, and the next timer is scheduled.
- **Sim mode:** `setInterval(tickMs)` as today. After each tick a `mids` pulse is published from the closes,
  so the client has one code path.
- **`tick` op:** in real mode it **always returns 409**
  `"tick is only available with the sim feed — real prices run at market speed"` (previously only n > 1 was
  refused).
- Warmup and catch-up never produce one `tick_completed` per replayed bar (§10.6).

### 10.4 Live marks every ~5 s

- After each successful `allMids`, `market.setLiveMids(px, tMs)` records the price and appends it to the
  current minute's sample buffer. Engine hooks run `live.markLive({px, stale, t})` and then
  `pulse.publish('mids', payload)`.
- **`market.livePx(coin)`** returns the latest mid if it is ≤ 15 s old, else the last bar close. The live layer
  uses it for **out-of-tick** fills (create, pause, resume, close, halt flattening) and for marks. Tick
  reconciliation keeps using the bar close (mirror at the bean's price).
- **`live.markLive`**, for each open bot whose coin is not stale:
  - update `mark_px`, `real.unrealized_pnl`, `margin_used`, `notional_usd`, `real.as_of_ms`;
  - **check liquidation against the live mid**. If crossed, run the existing `#liquidate` (fill at
    `liquidation_px`, `−margin`, no fee, `bot_fill` + `bot_paused {reason:'liquidated'}`). This happens
    immediately, not at the next bar.
- **Stale coins:** bots on a stale coin are **frozen**. No mirror, no liquidation checks, and marks stay at the
  last real price. BotRow gets `price_stale: true`.
- **Fill timestamps:** in real mode `time_ms` = wall clock for out-of-tick fills and the bar close time
  (`time_ms + 60 000` of the bar) for tick and replay fills. In sim, market time as today. This is exposed as
  `market.clockMs()`.
- **Price times (honesty).** Marks are stamped with the time of the price behind them, never "now": `mark_ms`,
  `real.as_of_ms` and `mids.px_ms[coin]` = the mid's receive time (or the bar close `livePx` fell back to);
  `mids.t` = the last allMids while ≤ 15 s old, else the last bar close; `account_state.as_of_ms` = the oldest
  open position's mark. `bot_create`/`bot_resume` answer 409 while the coin's mid is > 15 s old. Inside a tick
  or replay, staleness is judged from the bar being applied (flat = stale), not the wall-clock mid age.

### 10.5 Changed payloads (additive; existing keys keep their meaning)

- **`health`** adds:
  - `prices: 'real'|'sim'`;
  - `paper: true`;
  - `feed_state: 'live'|'delayed'|'down'|'sim'`;
  - `daemon: {running, tick_ms, aligned, next_tick_ms}`. In real mode `tick_ms = 60000` and `aligned = true`.

  `feed` stays the source string.
- **`status.feed`** keeps `{source, coins, ok, error, stale}` (`stale` stays a count) and adds:

  ```
  real: boolean, state: 'live'|'delayed'|'down'|'sim', stale_coins: string[],
  fallback: null | { from: 'hyperliquid', reason: string, since_ms },
  real_available: boolean|null,            // sim fallback only: an allMids probe every 60 s succeeded
  mids_ms, mids_age_ms, last_bar_close_ms, next_tick_ms, lag_bars,
  bar_sources: { candle, mids, flat },     // for the last bar
  weight_60s, last_gap: null | { bars, mode: 'replay'|'rewarm', from_ms, to_ms, at_ms }
  ```

  **State rules:**
  - `live`: the last allMids is ≤ 15 s old and `lag_bars = 0`.
  - `delayed`: allMids is 15–60 s old, `lag_bars ≥ 1` for less than 60 s, or there is a 429 back-off.
  - `down`: no successful HL request for > 60 s.
  - `sim`: the source is sim.
- **`market.coins[]`** adds:

  ```
  px, px_ms,                 // live mid (= mid); `mid` now also means the live mid (sim: last close)
  close,                     // last bar close
  change_1h,                 // close / close 60 bars ago − 1
  prev_day_px, funding_1h, mark_px, oracle_px, open_interest, day_ntl_vlm,   // real only, else null
  source: 'hyperliquid'|'sim'
  ```

  In real mode `change_24h` = `px / prev_day_px − 1` (the Hyperliquid definition). `max_leverage` and
  `sz_decimals` come from HL `universe`.
- **MarketFeed methods vs payload fields.** The method `market.mid(coin)` keeps returning the last bar close (population and tick reconciliation use it). The new `market.livePx(coin)` returns the live mid. Only the `market` op payload field `mid` changes meaning (it equals `px`).
- **`meta.coins`** = `engine.market.coins` (the live listing, with HL `szDecimals`/`maxLeverage` in real mode)
  instead of the static `COINS`. `market.coinInfo()` returns the same values, so caps and sizes match the
  venue.
- **`live_status`** adds `prices`, `paper: true` and `stale_coins`.
- **BotRow** adds `mark_px`, `mark_ms` and `price_stale`.
- **`bot_fill` event** adds `time_ms`, `tick`, and `liquidation: true` when it comes from a liquidation.

### 10.6 Gap fill, re-warm, fallback

`MAX_REPLAY_BARS = 2880`.

| Situation | Behaviour | Status / events |
|---|---|---|
| Start, `--feed hyperliquid`, `state-real.json` exists, gap `g` = closed minutes since the last bar, `1 ≤ g ≤ 2880` | inside `engine.start()`: fetch candles `[last+1 min, lastClosed]` for each coin, then replay `g` bars with hooks on (bots mirror and liquidate per bar, fills stamped with the bar close time). Only the **last** replayed bar emits `tick_completed` | journal `feed_gap {from_ms, to_ms, bars:g, mode:'replay', reason:'restart'}` |
| Start, gap > 2880, or candles cannot cover the gap | **re-warm**: `engine.rewarm()` rebuilds MarketFeed and Population in place (same seed and genomes) from a fresh 2880-bar real warmup ending now. The **live layer and journal are kept**; open bots reconcile on the next bar and are marked to `livePx` right away (liquidation checked) | `feed_gap {mode:'rewarm', bars:g}` + `warmup_finished` |
| Running, HL down (every coin flat at a close) | hold ticks, `lag_bars` grows, `state` delayed → down; marks stop; bots frozen | `feed_status` on each transition |
| Running, HL back, `lag ≤ 2880` | catch-up replay as on start (yielding every 20 bars) | `feed_gap {mode:'replay', reason:'outage'}` + `feed_status live` |
| Running, HL back, `lag > 2880` | `rewarm()` as above | `feed_gap {mode:'rewarm', reason:'outage'}` |
| Start, hyperliquid, **no real state**, warmup fails (meta or allMids unreachable, or < 8 coins return candles) | **fallback to sim**: run the sim feed with the sim state files, `status.feed.fallback = {from:'hyperliquid', reason, since_ms}`; probe `allMids` every 60 s → `real_available = true` (UI suggests a restart). Never switches at runtime | `feed_status {state:'sim', fallback}` |
| Start, hyperliquid, real state exists, HL unreachable | restore it and hold (state `down`); catch up when HL returns | `feed_status down` |
| One coin missing candles and mids for a minute | flat bar, coin stale, its bots frozen | `feed_status` (stale_coins changed) |

`engine.rewarm()` also re-applies the population venue hook. Add `engine.setVenueHook(fn)`; `main.js` calls it
instead of `engine.population.setVenueHook`.

### 10.7 New event and payload shapes

**Journal (persisted, with `id:`):** add `feed_status` and `feed_gap` to `catalog.js EVENT_KINDS` and
`EVENT_FIELDS`.

```
feed_status  { state: 'live'|'delayed'|'down'|'sim', prev, source, stale_coins: [], lag_bars, error: string|null, fallback: null|{…} }
feed_gap     { from_ms, to_ms, bars, mode: 'replay'|'rewarm', reason: 'restart'|'outage' }
tick_completed (+ closed_ms, next_tick_ms, source)
bot_fill       (+ time_ms, tick, liquidation?)
```

**Ephemeral pulse (`server/pulse.js`, new):**

```js
export class Pulse { publish(kind, data); subscribe(fn) → unsubscribe }   // in-memory only, never journaled
```

`createServer({..., pulse})`: every SSE stream subscribes to the journal **and** the pulse. Pulse frames are
written **without an `id:` line**, so they never touch `Last-Event-ID` and are never replayed. They are not in
`events`, not in `journal.jsonl` and not in the 5000-record ring.

```
event: mids
data: {"kind":"mids","t":1760112345678,"source":"hyperliquid","prices":"real",
       "px":{"BTC":82980.5,"ETH":2509.35, …16 coins},
       "stale":[],
       "bar":{"tick":5123,"time_ms":1760112240000,"next_tick_ms":1760112362000},
       "bots":{"bot-0003":{"szi":0.005,"entry_px":82410,"mark_px":82980.5,"unrealized_pnl":2.85,"realized_pnl":0.25,
               "margin_used":44.06,"liquidation_px":74581.05,"notional_usd":414.9,"price_stale":false,"as_of_ms":1760112345678}},
       "account":{"account_value":10042.18,"unrealized_pnl":38.12,"realized_pnl":-4.1,"available_usd":9442.18,
                  "deployed_usd":600,"open_notional_usd":2310.4}}
```

- Sent every ~5 s (real, after each successful allMids) and after every tick (both modes). Size is about
  1.5 KB.
- `/docs` documents `mids` as an ephemeral stream-only event.

### 10.8 Static route for three.js and CSP

- `http.js` routes `GET|HEAD /vendor/three/<path>` **before** the static handler. Allowed paths, exactly:
  `build/three.module.min.js`, `build/three.module.js`, `LICENSE`.
- They map to `node_modules/three/<path>`, resolved from the project root. The realpath must stay inside
  `node_modules/three`, reusing `isInside`/`hasDotSegment`.
- Any other path, encoded traversal (`%2e%2e`, `%2f`, `%5c`), dotfile, or missing file → 404.
- Headers are the same as static (`Content-Type: text/javascript; charset=utf-8` / `text/plain`, `no-cache` +
  `Last-Modified`/304, `nosniff`, CSP, `X-Frame-Options`).
- **CSP: no change.** `script-src 'self'` covers `/vendor/three/*` and `modulepreload`. There is no inline
  script, no import map, no eval (three r169 has none) and no inline styles. The existing CSP test is extended
  to `classic.html` and `/`.

### 10.9 Backend tests (offline; injected `fetch`/clock)

**`test/feed.test.js` (new):**
- alignCandles grid;
- warmup ends at the last closed minute;
- scheduler time = next boundary + 2 s;
- candle → bar; missing candle → mids bar; nothing → flat + stale + frozen bots;
- all coins down → hold + `lag_bars` + `down` after 60 s; recovery → replay with exactly one `tick_completed`
  and one `feed_gap`;
- gap > 2880 → rewarm keeps bots and journal;
- limiter ledger and skip/queue rules; 429 back-off;
- `change_24h` from `prevDayPx`; `coinInfo` from `universe`;
- fallback-to-sim at boot sets `fallback`; the probe sets `real_available`.

**`test/api.test.js` updates:**
- `tick` → 409 in real mode (fake feed);
- SSE `mids` frame has no `id:` and is absent from `events`;
- vendor route 200/404/traversal;
- new fields in `health`, `status.feed`, `market`, `live_status`, BotRow;
- `parseConfig` defaults to `hyperliquid`; `--tick-ms` with hyperliquid → error; `--warmup 6000` real → error;
- per-feed state file names.

**`test/live.test.js`:**
- `markLive` updates unrealized and liquidates on a cross;
- stale-coin bots are frozen;
- out-of-tick fills use the wall clock in real mode;
- `bot_fill` carries `time_ms`.

**`test/engine.test.js`:** update the exact-key assertions (lines ~677–686) to the new superset.

---

## 11. Build plan

### 11.1 Work packages (file ownership never overlaps)

| WP | Engineer focus | Owns (exclusive) | Delivers |
|---|---|---|---|
| **WP1 Backend** | real feed, scheduler, marks, pulse, vendor route | `server/*` (+ new `server/pulse.js`), `package.json`, `package-lock.json`, `.claude/launch.json`, `SPEC.md`, `test/api.test.js`, `test/engine.test.js`, `test/live.test.js`, `test/feed.test.js`, `test/fixtures/*` | §10 complete; fixtures `test/fixtures/{mids,status-real,market-real}.json` on day 1 |
| **WP2 Platform & core** | boot, data/store, view/rules/director, renderer infra, camera, picking, labels | `web/classic.html`, `web/js/model.js`, `web/js/garden.js` (re-export edit only), `web/js/game/{boot,main,three,stage}.js`, `web/js/game/core/*`, `web/js/game/fx/director.js`, `web/js/game/gfx/{renderer,loop,tiers,camera,picking,labels,tween,post}.js`, `test/game.test.js`, `README.md` (final docs pass) | §5, §7.3, §7.5, §7.6, §9.1–9.6, §9.9 |
| **WP3 World & audio** | island, landmarks, sky, weather, farmer, materials, geometry, audio | `web/js/game/gfx/{materials,geom,palette}.js`, `web/js/game/world/*`, `web/js/game/audio/sfx.js` | §2, §4.4–4.5, §8, `World` API |
| **WP4 Crops, field & FX** | 16 crops, plots, FSM, effect executor, particles | `web/js/game/crops/*`, `web/js/game/field/*`, `web/js/game/fx/{executor,particles,coins,floaters}.js`, `test/game-crops.test.js` | §3, §4.1–4.3, `Field`/`CropMesh`/executor APIs |
| **WP5 HUD, UI, i18n, a11y** | all DOM: HUD, dialogs, panels, tour, styles, strings | `web/index.html`, `web/css/game.css`, `web/img/icons.svg`, `web/js/i18n.js`, `web/js/game/ui/*`, `test/game-ui.test.js` | §6, §7.1–7.2, §7.4, §9.10 |

**Day-1 contracts** (first 2 hours; each owner publishes stubs exporting the exact signatures with no-op
bodies so everyone compiles):
- WP2: `store` shape, bus event names, `PlotView`, `Effect`, `Stage`.
- WP3: `World`, `materials`/`geom` signatures, `sfx`.
- WP4: `Field`, `Plot`, `CropMesh`, executor.
- WP5: all i18n keys of §7.2, the container ids of §6, and the CSS class names used by others (`.chip`,
  `.chip--up|down|long|short|warn|stale`, `.fx-label`, `.fx-label--up|down|neutral`, `.tip`).
- WP1: fixtures and the vendor route.

Until WP1 lands `mids`, the frontend develops against `npm run dev` (sim). `data.js` tolerates a missing
`mids` (`≈` estimates).

### 11.2 Integration order and milestones

1. **M0 (day 1, morning).** WP1 lands the vendor route, scripts, `tick` 409, BotRow `mark_px` and
   `bot_fill.time_ms`. All stubs merge, `npm test` stays green, and `classic.html` works.
2. **M1, "island + truthful HUD".** WP2 boot/stage/renderer/rig/store/data, WP3 island and landmark blockouts,
   WP5 HUD, badge, ticker and dock. Exit: real/sim badge correct, numbers live, island orbitable on phone and
   desktop, WebGL2 fallback works.
3. **M2, "plant to harvest end-to-end".** WP4 field, plots, 4 builders (tree, stalk, bush, groundRosette) with
   palette swaps for all coins; WP5 catalogue, plant dialog, inspector and confirms; WP2 slots and pick mode.
   Exit: plant/shade/sun/harvest/pull/burn work by mouse, touch and keyboard, with server-confirmed visuals.
4. **M3, "feel".** WP2 director; WP4 executor, particles, coins, floaters and the remaining 5 builders; WP3
   weather, wind, windmill clock, pond/tower/silo levels, audio, farmer; WP5 diary, settings, tour, list view
   and radial. WP1 phase B: real feed scheduler, marks pulse, liquidation on marks, gap fill and rewarm,
   fallback.
5. **M4, "hardening".** RM pass, colour-blind pass, Thai at 360 px, perf budgets and governor, context loss,
   offline/stale states, docs (WP2 README, WP1 SPEC).

### 11.3 Acceptance criteria (release gate)

1. `npm start` with network shows `● REAL PRICES · PAPER TRADES`, with ticker prices within 10 s of
   Hyperliquid's `allMids`. `npm run sim` shows the violet SIM badge and the sundial. Neither badge can be
   hidden.
2. Bars tick within [+2 s, +17 s] of each wall-clock minute in real mode. `tick` returns 409 in real mode.
   `mids` arrive every 5 ± 1 s.
3. Every inspector number equals the API/mids value it names, or carries `≈` and an age tag.
   `stage()` parity: the plot's size/health/fruit/flower equal `stage()` of the merged bot (test).
4. A losing close produces zero coin/sparkle effects and the barn total changes by at most the fee (tests plus
   manual).
5. Kill the network during real mode: within 60 s the badge reads PRICES DOWN, plants freeze, and plant and
   resume are disabled. Restore it: missed minutes replay, one diary line appears, and there are no fill
   animations for replayed fills.
6. Restart after 10 min → replay. Restart after 3 days (simulated by an injected clock in tests) → rewarm, with
   bots kept.
7. Keyboard only: plant, inspect, shade, sun, harvest, pull and burn are all possible with no pointer. NVDA
   reads the dock card labels. `axe` shows no serious violations on `/`.
8. At 360 × 740: no horizontal page scroll, the TH strings fit (wrapping allowed), and the bottom bar buttons
   are ≥ 56 px.
9. RM: no camera flights, no particles, no sway; the loop is idle (0 renders per second) when nothing changes.
10. With WebGL2 disabled, or `/vendor/three/*` returning 404 → interstitial → `/classic.html` within 2 s, with
    any `?token=` stripped.
11. Performance: desktop iGPU ≥ 55 fps on High with 10 plots; a Moto-G-class phone ≥ 30 fps on Low; first 3D
    frame ≤ 2.5 s after the HUD on the phone; `?debug=1` within the §7.5 budgets.
12. `npm test` is green offline (no network in tests). The existing 152 tests still pass, with only the
    intended updates.

### 11.4 Frontend tests (Node, no GPU, no DOM)

**`test/game.test.js` (WP2):**
- `plotView` parity with `stage()`;
- marks override only when newer; the `≈` path;
- `liqInfo` vectors (10× long from 82,410.0 → 10.12% at mark 82,980.5; liquidation at 74,581.05; a short
  mirror case);
- `fmtPx`/`fmtSz` table (§9.2); `ageTag` thresholds; `feedBadge` truth table (§6.3);
- `assignSlots` stability across closes and reloads, and `wanted` slots;
- `coinBurst` buckets; `levTier`;
- director:
  - a loss → `pull` with 0 coins;
  - no `plantOk` before a 2xx;
  - 400 ms coalescing; flip detection;
  - replayed fills → no effects;
  - burn stagger order with per-bot amounts;
  - quiet fruit re-gain;
- settings defaults with throwing `localStorage`.

**`test/game-crops.test.js` (WP4):** `CROPS` covers every `COINS` coin plus the fallback; palette hexes are
valid; builder names ∈ the 9 builders.

**`test/game-ui.test.js` (WP5):**
- `index.html` and `classic.html` have no inline script, style or handlers;
- every `data-i18n` key exists in EN and TH;
- every `g.crop.*` exists for the 16 coins;
- the sprite contains every symbol id in §9.10.

The existing `web.test.js` must keep passing unchanged (`garden.js` re-exports).

**Manual QA checklist:** Chrome, Firefox and Safari desktop; Android Chrome; iOS Safari; NVDA and VoiceOver;
RM on/off; 360 px TH; context loss (`WEBGL_lose_context`); feed offline; 429 simulation; halted field.

### 11.5 Risks and mitigations

| Risk | Mitigation |
|---|---|
| HL rate limits or outages | one shared server poll, 1000/min ledger, back-off, hold-and-replay (no invented prices), clear `down` state |
| Real pace feels slow (1 bar/min) | 5 s marks move springs and numbers; windmill countdown; wind/gusts from real volatility; ambient life; the *sprouting now* filter is on by default |
| Charm hides risk | Juice Contract plus tests, channel separation, always-visible ×N and thermometer, confirm math, neutral copy |
| Mobile GPU / thermal | tiers, step-down governor, on-demand loop, no point lights, blob shadows on Low |
| 16 crops overrun the schedule | 9 parametric builders; M2 ships 4 builders with palette swaps; the beanstalk fallback always works |
| Replay/rewarm complexity | `MAX_REPLAY_BARS` bound, injected clock and fetch tests, live layer untouched by rewarm |
| Clock skew between server and browser | `skewMs` from `health.now_ms`; ages computed server-relative |
| CSP / module loading | single shim, absolute path, no addons or import maps, a HEAD probe before import |
| Thai overflow | DOM only, 2-line chips, 360 px TH tests, abbreviated mobile badge (`g.badge.short.*`) |
| Photosensitivity / motion sickness | far-sky lightning ≤ 1 per 8 s with ≤ 30% step; no screen shake; RM honoured |
| Feed switch confuses players | per-feed state files; no runtime auto-switch; the badge explains a fallback and the restart path |

### 11.6 Cut list (cut in this order; P-tags in §2–§9)

1. Tilt-shift post pass (P2).
2. Bees, butterflies, bird flock, waterfall, fireflies, snail (P2).
3. Lightning and rain particles (keep the sky tint and weather caption).
4. Ambient audio, then all audio (keep the toggle hidden).
5. **Farmer** (effects already never wait for him; tools pop in at the plot instead).
6. Sky *Follow my clock* (always day).
7. Crop builders 9 → 5 (tree, stalk, vine, bush, groundRosette) with palette swaps; DOGE popcorn.
8. Drag-to-plant and the long-press radial (tap → dialog and the inspector remain).
9. List view table (the dock remains the accessible twin).
10. Intro fly-in and animated landmark levels (levels update instantly).
11. Tour shortened to 3 cards (1, 3, 4).

**Never cut:**
- the mode badge and SIM/down states;
- the real-price ticker;
- real feed default, `mids`, `tick` 409, hold-and-replay;
- inspector numbers and confirm dialogs with $ amounts;
- the plot dock (keyboard/screen-reader path);
- EN/TH; reduced motion;
- the WebGL2 and engine fallback to `/classic.html`;
- the server-confirm rule (J3);
- the Juice Contract tests.

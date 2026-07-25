> # ⚠️ SUPERSEDED — kept for history
>
> **The current roadmap is [`roadmap.md`](roadmap.md).** The strategic argument behind the change is in [`new-design.md`](new-design.md).
>
> This document was superseded for three reasons:
>
> 1. **Phases 0 and 1 shipped in full** — commit `5630bb7` (PR #152), closing issues #113–#131. Everything in §3 and §4 below is done.
> 2. **Its scope was too narrow.** It covers the League Discord bot alone. The sellable product is the intersection of Diana's match data and Meeps' voice presence, so the roadmap now covers both repositories as one programme.
> 3. **§6.3 (match betting) cannot ship.** Riot's monetisation policy states that a product "cannot feature betting or gambling functionality." It has been deleted, not deferred — replaced by _Calls_ (`roadmap.md` §8.5), which keeps the social payoff and is idempotent by construction.
>
> Sections that remain accurate and were carried forward rather than rewritten: the **Riot rate-budget analysis** (§1, §10), the **traps** (§9, except #1 and #3), and the **implementer conventions** (§11).
>
> _Do not plan from this file._

---

# Diana Feature Roadmap

_Scope: the **League of Legends Discord bot** (`diana-league-bot` plugin). The web dashboard and Pathfinder (Apex) are out of scope._

_Written July 2026, based on an audit of the current plugin code, the production key's actual API access ([docs/access.md](access.md)), the 2026 Riot API surface, and a survey of competing LoL Discord bots (Dorans, Rankup, Orianna, OP.GG bot, Zoe, In-House Queue) and what their users praise most._

---

## 1. How to read this

Each feature entry states:

> **What** it does · **Why** it's worth building · **Effort**: XS / S / M / L · **Needs**: dependencies · **Rate**: Riot API cost

Phases are ordered by value-per-effort _for a friend-group server_:

| Phase | Theme                                       | Riot rate impact                                        |
| ----- | ------------------------------------------- | ------------------------------------------------------- |
| 0     | Sharpen what exists (fixes + tiny enablers) | Slightly **reduces** usage                              |
| 1     | Friend-group fun on data already stored     | Near zero                                               |
| 2     | Interaction & visual upgrades               | Near zero                                               |
| 3     | Live-game & economy (opt-in)                | Significant for self-hosters; trivial on the hosted key |
| 4     | Public-bot readiness                        | Varies                                                  |

### Riot rate-budget primer

| Key tier                     | Limits                                                    | Notes                                                       |
| ---------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| Development                  | 20/s and 100/2min, **expires daily**                      | Testing only                                                |
| Personal                     | Same limits, permanent                                    | What most **self-hosters** will run — no increases possible |
| Production (this deployment) | **Per-method** — full list in [docs/access.md](access.md) | 39 methods approved for "Stew's Server Bot"                 |

**What the production key actually allows** ([docs/access.md](access.md)): everything this roadmap leans on is effectively unlimited at Diana's scale — match-v5 and its timeline (2000/10s), spectator-v5 (3000/10s), and league-entries-by-puuid / champion-mastery / challenges / rotations (20000/10s). The only tight spots: **clash-v1 `/tournaments` at 10/min** (Clash reminders must poll daily and cache) and **account-v1 lookups at 1000/min** (the stricter of its two listed limits; only matters for mass metadata syncs and by-Riot-ID lookups). The key has **no TFT APIs and only the tournament _stub_** — the §8 ideas that need them are flagged.

The math that still matters is for **self-hosters on personal keys** (~50 calls/min sustained): the current poller costs roughly **N calls/min** (one match-list check per tracked summoner, default every minute) **+ ~3 calls per finished match** (match detail, rank entries, occasional account sync) **+ 2N/day** (24h metadata sync). A friend group tracking 5–15 summoners has comfortable headroom — but that headroom is the budget every rate-costing feature below spends from. Features marked **Rate: zero** run entirely off data already in Postgres.

---

## 2. Where Diana is today

### Commands

| Command                         | What it does                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `/add name tag [region]`        | Track a summoner in this server (seeds rank baseline + current match pointer) |
| `/remove name [tag]`            | Stop tracking (autocomplete, guild-scoped)                                    |
| `/summoner name [tag] [region]` | Profile embed: ranks (from DB), 7-day W/L, recent matches, IOTW 7-day stats   |
| `/champion name champion [tag]` | Per-champion stats from stored matches (⚠ region hardcoded EUW)               |
| `/iotw`                         | "Inter of the Week" — lowest average AI score, roast leaderboard + fun stats  |
| `/setchannel channel`           | Set the notification channel (Manage Channels)                                |
| `/config live-posting/view`     | Toggle match posts / view settings (Manage Guild)                             |
| `/help`, `/ping`                | Reference (⚠ lists wrong command names) and liveness                          |

### The pipeline

One cron (default **every minute**): check each tracked summoner's latest match id → on a new completed match, fetch full match → store **entire participants/teams JSON** in `match_details` → compute **AI scores + placements for all 10 lobby players** (`match_scores`) → diff ranked standing into `rank_tracking` → post a **match-summary embed** (result, champion, queue, role, KDA, damage, placement, AI score, LP change) plus **promotion/demotion embeds** → fan out to every guild tracking that player (`guild_config.channel_id`, `live_posting` flag) and to the optional **Meeps webhook**.

### Data you already have "for free"

This is the roadmap's biggest lever — much of Phase 1 needs **no new Riot calls**:

- `match_details.participants` (JSONB, GIN-indexed) — the **full match-v5 participant objects, including the ~100-metric `challenges` block** (kill participation, damage/min, solo kills, skillshots, ping counts…), stored **retroactively for every match already tracked**.
- `match_scores` — AI score + placement for **all 10 players** of every match, not just tracked ones.
- `rank_tracking` — a per-match **rank/LP history** with INIT anchors (`fetchRankHistory()` already exists in `summonerService.ts`).

### Architecture constraints to respect

- **Notifications** go through the single-embed `MessagePayload` → `MessageAdapter`, which **also serializes to the Meeps JSON webhook** (`apps/server/src/messageAdapter.ts` fan-out). Anything binary (images) or interactive (buttons) on the _notification_ path is a cross-service contract change.
- **Command replies bypass the adapter** (raw `interaction.reply`) — buttons, select menus, and file attachments on command replies are safe and contained.
- The interaction router (`setupDiscord.ts`) handles only slash commands + autocomplete today; there is **no component/modal router** (Phase 2 enabler).
- Two bot clients share the Discord layer (diana + pathfinder) — shared enablers belong in `packages/diana-discord/src/discord/`, keyed by `botKey`.
- `node-cron` jobs have **no overlap guard**; the poller survives overlapping ticks only via `ON CONFLICT DO NOTHING`.
- Minimal gateway intents (`Guilds`, `GuildMessages`) — no member data, no message content.

### What's already a differentiator

The **AI score with per-lobby placement** is something none of the surveyed competitors have, and `/iotw` gives Diana a voice (roast culture) competitors mostly lack. Several Phase 1 features deliberately compound these two assets rather than chasing parity features first.

---

## 3. Phase 0 — Sharpen what exists

Small fixes and enablers. Everything here is XS–S, and several items are **prerequisites** for later phases.

**Guild-scoping pass** · Effort: S · Rate: zero
`/iotw` currently aggregates **across every server the bot is in** (`utils/interStats.ts` has no guild filter) — in multi-guild deployments that leaks other servers' players into the leaderboard. Add an optional `guildId` join on `guild_summoners` and pass `interaction.guildId`. Same pass: `/champion`'s autocomplete is global while `/summoner`'s is guild-scoped (the search functions already accept `guildId`; the command just doesn't pass it), and `/champion` hardcodes EUW — copy `/summoner`'s region-option pattern.

**Fix `/help`** · XS — it advertises `/champion-stats` and `/inter-of-the-week`; the real names are `/champion` and `/iotw`.

**Unpin Data Dragon version** · XS — champion icon URLs are pinned to `15.2.1` in `championStatsCommand.ts` and `leaguePresentation.ts`; new champions render broken icons. `dataDragonService.fetchLatestVersion()` already exists (module-private) — export and use it.

**Queue-name coverage** · XS — `getQueueNameById` is a static 8-entry map, so an Arena game renders "Unknown Queue (ID: 1700)" in embeds _today_. Add Arena (1700), Swiftplay (480), and friends, with an "unknown" fallback (the static Data Dragon queue list lags new modes).

**Keep `summoners` rank columns fresh** · XS · **prereq for `/leaderboard`**
`summoners.tier/rank/lp` are written once at `/add` and never again — the poller writes fresh ranks only to `rank_tracking`. An update function already exists in `summonerService.ts` but is unwired. Either call it from the poller's rank branch, or make consumers read latest-per-puuid from `rank_tracking`.

**Rate giveback in `/summoner`** · XS — it fetches live rank entries and then discards them (`void rankEntries`; the embed uses DB rank). Delete the call, or actually use it to show up-to-the-second LP.

**Cron overlap guard** · XS · **prereq for every new cron**
A per-handler in-flight flag in `pluginRegistry.registerCron`. Today only the poller's `ON CONFLICT` saves it; digest/spectator/betting crons won't have that accidental protection.

**`notification_prefs` on `guild_config`** · S (1 migration) · **prereq for all new post types**
One `live_posting` boolean currently governs everything. Add a JSONB prefs column (`match_posts`, `rank_posts`, `digest`, `streaks`, `rotation`, `live_alerts`, …) so each new poster in Phases 1–3 ships with a per-guild toggle instead of its own migration. `/config` grows subcommands to flip them.

**Finish or remove the dead "missing data summary" feature** · XS–S — `buildMissingDataMessage`, its `summoners.lastMissingDataNotification` column, and service method are fully built and tested but never called. Decide: wire it into the poller or delete it.

**Doc/env truthing** · XS — `.env.example`/docs reference `USE_RIOT_API` but the code reads `USE_MOCK_RIOT_API` (with the opposite default); `docs/development.md` documents a `context.registerSlashCommands()` that doesn't exist (commands are registered out-of-band in `apps/server/src/index.ts`); the `defaultDiscordChannelId` plugin-config field is never read (poller uses the `DISCORD_CHANNEL_ID` env). Fix the docs now; the real registration refactor is Phase 4.

---

## 4. Phase 1 — Friend-group fun on data already stored

The highest-delight-per-effort tier. Everything except `/livegame` and the rotation post is **Rate: zero**.

### 4.1 Richer match embeds with personality · Effort: S · Rate: zero

**What:** Surface the stored `challenges` metrics in the match-summary embed — kill participation, damage/min, vision score, solo kills, multikills, and the infamous **ping counts** ("47× enemy missing") — plus one or two **generated flavor lines** picked from thresholds: a hype line for a 1st-place AI score, a gentle roast for 0-kill 12-death adventures, "AFK farmer" for high CS / low KP, etc.
**Why:** "Fun descriptions" are Dorans' signature feature and the single most engaging thing a tracker bot posts; Diana already has the roast identity via `/iotw` and — unlike Dorans — already computes a lobby-relative score to hang lines on.
**How:** extend `baseMatchSummary` in `matchMonitoringService.ts` and the embed builder in `leagueNotifications.ts`. Parse `challenges` defensively (fields vanish between patches) — the pattern already exists in `scoringAlgorithm.ts`. Flavor lines = a data table of `(predicate, lines[])`, easily unit-tested alongside the existing notification tests.

### 4.2 MVP of the Week · Effort: S · Rate: zero

**What:** The positive twin of `/iotw` — crown the **highest** average AI score, with fun stats (most damage, best KDA, best vision).
**Why:** Cheap (same `interStats` query, sorted the other way), and it balances the roast culture so improving players get celebrated too. Do it in the same PR as the `/iotw` guild-scoping fix.

### 4.3 `/leaderboard` · Effort: S · Rate: zero

**What:** Guild-scoped boards: **LP ladder** (solo + flex) plus weekly stat boards — KDA, vision, damage share, games played, average AI score.
**Why:** Every successful competitor makes leaderboards the headline (Dorans' auto-updating boards, Rankup's "Carry Score", OP.GG's `/leaderboard`) — rivalry is the retention engine of a friend-group bot.
**How:** LP ladder reads latest-per-puuid rank (see the Phase 0 staleness fix); sorting uses `getTotalPoints` from `rankService.ts` (currently module-private — export it). Stat boards reuse the guild-scoped `interStats` query. One new command file + registration line.

### 4.4 Weekly digest · Effort: S–M · Rate: zero

**What:** A Sunday-evening post per guild: 📈 who climbed / 📉 who fell (LP delta over the week from `rank_tracking`), 🎮 the grinder (most games), 🏆 best and 💀 worst AI-scored game of the week, MVP + Inter crowns.
**Why:** Recurring engagement beats on-demand commands — Dorans' daily summaries ("who played 15 games and went nowhere") are its most-quoted feature. Weekly fits friend groups better than daily (less spam).
**How:** a second `context.registerCron()` in the plugin's `onEnable`; iterate guilds with a digest pref enabled; entirely Postgres-fed. Needs Phase 0's overlap guard + prefs. Note: node-cron fires in server-local time — document that.

### 4.5 Streak & milestone callouts · Effort: S · Rate: zero

**What:** Append callouts to match posts (or post separately, per prefs): 🔥 3+ win streaks, 🧊 loss streaks (gently), **new peak rank ever**, first time reaching a tier, and LP landmarks in Master+.
**Why:** Rank-up celebration is universal across competitors; Diana currently only posts on tier/division promotion — streaks and "new personal best" moments are free wins from data it already writes every match.
**How:** streaks from the last N `match_details` rows per player; peaks from `rank_tracking` history. Lives in the poller's post-match branch.

### 4.6 `/compare` and duo stats · Effort: M · Rate: zero

**What:** `/compare a b` — head-to-head card (rank, weekly W/L, KDA, CS/min, avg AI score) settling "who carries." Plus **duo win-rate**: your record when two tracked players are in the same game, from `participants` JSONB containment (GIN-indexed).
**Why:** Rankup markets head-to-head as "settle debates"; Dorans surfaces duo win-rates. For a friend group this is the social feature.
**Gotcha:** when both players are tracked, the same match is stored once per entry player — dedup with `DISTINCT ON ("matchId")`, and count each match once.

### 4.7 `/livegame` (on-demand) · Effort: S · Rate: 1 call per use

**What:** "Is X in a game right now?" — champions, teams, bans, and rune summary for a live game, with DeepLOL links. Spectator data is pre-game-only (no live gold/HP), which is exactly enough for "get in here and watch."
**Why:** The most-requested live feature that's _safe_ on a personal key when on-demand (and effectively free on the hosted key — spectator-v5 allows 3000/10s). It's also the foundation Phase 3's live alerts build on.
**How:** twisted already ships `SpectatorV5.activeGame()` returning a typed not-in-game/in-game union — add it to `ILolService`, `LolService`, **and `MockLolService`** (tests depend on the mock).

### 4.8 Free-rotation post · Effort: XS–S · Rate: 1 call per week

Weekly "free champions this week" post (champion-v3), behind a pref, default off. Trivial breadth win competitors mostly skip.

### 4.9 LP sparkline · Effort: XS · Rate: zero

A text sparkline (`▂▄▅▇`) of recent LP in `/summoner`, from `fetchRankHistory()`. It's the zero-infrastructure preview of Phase 2's proper LP graphs. (An intermediate option — QuickChart URL images via a new Meeps-safe `imageUrl` payload field — works but adds an external-service dependency self-hosters may not want.)

---

## 5. Phase 2 — Interaction & visual upgrades

Two enablers, then the features they unlock. All command-reply-side: **the notification path and Meeps contract stay untouched.**

### Enabler A — Component interaction router · Effort: M

Extend `setupDiscord.ts`/`commandRegistry.ts` to dispatch `isButton()`/`isStringSelectMenu()`/`isModalSubmit()` through a customId-namespaced registry (`plugin:command:action:state`), per `botKey` (two-client architecture). Keep pagination **stateless** — encode page/target in the customId, don't hold server-side session state. This is shared infra: Pathfinder gets it for free.

### Enabler B — Canvas renderer · Effort: M

`@napi-rs/canvas` (prebuilt binaries — works on the `node:24-bookworm-slim` Docker base with no Dockerfile surgery, unlike `node-canvas`). A small renderer module in `diana-discord` with bundled fonts; replies attach via `interaction.editReply({ files })`. The repo's `assets/ranked-emblem/*.webp` are ready-made ingredients.

### Unlocked features

**Paginated `/matches` browser** · S (needs A) — match history with ◀ ▶ buttons and a player select menu; per-match drill-down. The modern-UX baseline users now expect from OP.GG-style bots.

**Image score cards** · M (needs B) — `/summoner` and `/leaderboard` render as generated cards (rank emblem, champion splash, KDA, LP trend). The single most visible polish upgrade a stats bot can ship; nearly every top competitor has imagery.

**LP progression graphs** · S (needs B) — `/graph name` renders the `rank_tracking` history as a proper LP curve (y-axis via exported `getTotalPoints`). Note: history has gaps (bot downtime, unranked stretches) — connect known points and mark long gaps.

**Mastery milestones** · S · Rate: +1 call per finished match — check champion-mastery-v4 on match-end for the played champion; alert on level-ups and point landmarks ("500k Yasuo 😔"). Store last-known mastery (small migration). Orianna built an entire beloved bot on this data.

**Clash reminders** · S–M · Rate: ~1 call per day — poll clash-v1 for upcoming tournaments; post the weekend schedule; optionally create a **Guild Scheduled Event** so the server gets native Discord reminders. Heads-up: `/lol/clash/v1/tournaments` is one of the key's two genuinely low limits (**10/min**) — one daily poll with cached results is the right shape anyway.

---

## 6. Phase 3 — Live & economy (rate-sensitive, opt-in)

The headline features. On the hosted key these are comfortably affordable (spectator-v5: 3000/10s); the rate caution is for self-hosters — so ship them **opt-in, default off**, with the math visible in docs.

### 6.1 Live-game alerts (spectator polling) · Effort: L · Rate: +N calls per cadence tick

**What:** "🔴 X just queued into Ranked Solo as Jinx — with tracked duo Y!" posted at game start, with `/livegame`-style detail; optionally a follow-up edit linking the eventual match summary.
**Why:** Porofessor's headline experience, requested of every tracker bot; it turns Diana from a rear-view mirror into appointment viewing (and is the prerequisite for betting).
**How, carefully:**

- New cron at **2–3 min cadence** (not the poller's 1 min), guarded by Phase 0's overlap flag.
- **Own dedup state** (e.g. `live_game_state` column or table): do **not** reuse `summoners.currentMatchId` — the completed-match poller's rank-anchor logic keys off it.
- Per-guild opt-in via `notification_prefs`; only poll summoners tracked by at least one opted-in guild; skip players who finished a game in the last few minutes.
- Rate math: on the hosted key this is a non-issue (spectator-v5 allows 3000/10s and 180000/10min — minute-cadence polling for hundreds of summoners doesn't dent it). For self-hosters, spectator polling adds ~N calls per tick on top of the poller's N/min baseline — at 1-min cadence it would **double** usage (~25 tracked summoners saturates a personal key), at 3-min it's +33%. Document this next to the toggle.

### 6.2 Lobby scouting enrichment · Effort: M–L · Rate: up to ~10 calls per use — **gate it**

Per-participant enrichment of `/livegame` (each player's rank and recent form, OP.GG `/multi`-style). On the hosted key the burst is trivial (league entries by-puuid: 20000/10s); the danger is personal keys, where it can push the shared `twisted` queue into 429 backoff and **silently delay the flagship match-end embeds**. Gate behind a "production key" config flag, default off; personal-key deployments keep the 1-call basic view.

### 6.3 Match betting / predictions · Effort: L · Rate: zero beyond 6.1

**What:** When a live alert fires, open a 5-minute betting window — server members wager virtual currency on win/loss (later: props like "will X finish top-3 AI score?"). Settlement on the match-end event; balances, a richest-degenerate leaderboard, weekly allowance.
**Why:** Dorans' betting is its stickiest social feature, and an entire subgenre of prediction bots exists — for a friend group this is peak banter fuel, compounding live alerts + AI scores.
**Requirements:** ledger + balances tables (migrations); **idempotent settlement keyed on `matchId`** (the cron model tolerates overlapping/duplicate ticks — a naive implementation double-pays); buttons from Enabler A for placing bets. This is the biggest-effort fun feature in the roadmap — sequence it last in the phase, after live alerts have soaked.

---

## 7. Phase 4 — Public-bot readiness

The friend-group features above work multi-guild already (fan-out is per-guild). This phase is what makes _strangers'_ servers a good experience.

**`/link` (Discord user ↔ Riot account)** · M · prereq for everything below
A `riot_account_links` table + `/link`/`/unlink`. Note `guild_summoners.added_by` records who _added_ a summoner, not who _owns_ it — real linking is new data. Verification option: the classic profile-icon handshake (ask the user to set a specific icon, confirm via summoner-v4, 2 calls).

**Auto rank roles** · L · the ecosystem's most-praised feature (Orianna, Dorans, Zoe all lead with it)
Per-guild tier→role mapping; assign on rank movement in the poller + a reconciliation cron. Needs `/link` first, Manage Roles + role-hierarchy handling, and — at 100+ servers — the **GuildMembers privileged intent** and bot verification. Worth it: this is the #1 reason servers install a LoL bot.

**User-installable app mode** · M — let `/summoner`-style lookups work **in any server or DM** (Discord user-install contexts). Needs by-Riot-ID on-demand paths that don't require the target to be tracked. Low competition among LoL bots; strong organic-growth lever.

**Privacy toggles** · S — per-player opt-out of leaderboards/IOTW/digests (Orianna's privacy dashboard is loved). Friend groups don't need it; strangers do.

**Platform hardening** (each M): centralized Riot rate-limiter/cache in front of `lolService` (per-region budgets, request coalescing, DataDragon TTL); plugin enable/config from `data/plugins.json` → Postgres (multi-instance/HA); slash-command registration through `PluginContext` (close the doc/code gap for real); onboarding polish (post-`/setchannel` quick-start embed).

---

## 8. Ideas bucket (unscheduled)

- **TFT tracking** — same account→puuid flow, **but the TFT APIs are not on the current production key** ([docs/access.md](access.md)) — request expanded access from Riot first. (Self-hosters' personal keys do include TFT.) A second game without a second bot.
- **Arena-specific handling** — placement-based embeds (queue 1700), augment display; the AI scoring algorithm assumes SR roles, so Arena needs its own scoring branch.
- **Timeline-powered recaps** — gold-diff@15 graphs and kill maps from match-v5 `/timeline` (+1 call per finished match; 2000/10s on the key). The client method (`MatchV5.timeline`) and the `match_timeline` table already exist, currently unused by the bot. Pairs with the Phase 2 canvas enabler.
- **Season recap / "Diana Wrapped"** — end-of-split per-player recap card (games, hours, most-played champ, best game, LP journey). All from stored data; pairs beautifully with Phase 2 image cards.
- **Self-refreshing rank channel** — Zoe's pattern: one pinned, auto-edited leaderboard message instead of (or besides) posts.
- **In-house queue tools** — MMR-balanced team drafts, auto voice channels (In-House Queue's whole niche). Big, separate product — only if the community pulls hard. The key includes **tournament-stub-v5 only**; real tournament codes would need separate tournament-v5 approval.
- **lol-challenges-v1 flexes** — "top 2% of EUW at vision score" percentile callouts and title tracking. Already on the key (all six challenge methods at 20000/10s).
- **Forum-thread-per-match** — post recaps as forum threads for per-game discussion (LoL Esports bot pattern).
- **Components V2 layouts** — rebuild notification cards as component-based messages; blocked on the Meeps contract question (below).
- **Notification-path image cards** — see Don't build (yet), below.

---

## 9. Don't build (traps)

1. **Naive betting settlement.** The cron model allows overlapping ticks; the match pipeline is only accidentally idempotent (`ON CONFLICT DO NOTHING`). A wager system that settles inside that path without its own idempotency key **will double-pay**. Build the overlap guard first, key settlement on `matchId`, and write the concurrency test.
2. **Full 10-player lobby scouting on personal keys.** Ten league-v4 calls per curious user, funneled through the same `twisted` queue as the poller — 429 backoff then **silently delays match-end embeds**, and the cause is invisible to the operator. Gate enrichment behind a production-key flag.
3. **Images/components on the notification path.** Every notification also fans out to the Meeps JSON webhook; binary attachments mean base64 bloat, hosting, or divergent adapters — a cross-service contract change for embeds that already render fine. Command-reply images (Phase 2) deliver ~90% of the polish with zero adapter risk. Revisit only if Meeps grows an image contract.
4. **Default-on spectator polling.** It halves every self-hoster's rate headroom for a feature many guilds won't enable. Opt-in, slower cadence, opted-in-guilds only.

---

## 10. Appendix

### Rate cost per feature (personal-key lens)

| Feature                                                                      | Riot calls                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------- |
| Richer embeds, MVP, leaderboards, digest, streaks, compare, sparkline, recap | **0** (stored data)                           |
| `/livegame` (basic)                                                          | 1 per use                                     |
| Free rotation                                                                | 1 per week                                    |
| Clash reminders                                                              | ~1 per day                                    |
| Mastery milestones                                                           | +1 per finished match                         |
| `/summoner` today                                                            | −1 after Phase 0 (discarded call removed)     |
| Spectator polling                                                            | +N per tick (cadence-dependent; see 6.1 math) |
| Lobby scouting enrichment                                                    | up to ~10 per use — production-key gated      |
| `/link` icon verification                                                    | ~2 per link                                   |

On the production key every row above is comfortably in budget ([docs/access.md](access.md)); the two limits worth remembering are clash-v1 `/tournaments` (10/min — poll daily, cache) and account-v1 (1000/min — only relevant to mass metadata syncs and by-Riot-ID lookups).

### Migrations by phase

- **P0:** `guild_config.notification_prefs` JSONB; (optional) drop `summoners.lastMissingDataNotification` if the dead feature is removed
- **P2:** last-known mastery per (puuid, champion)
- **P3:** live-game dedup state; betting ledger + balances
- **P4:** `riot_account_links`; per-guild role mappings; plugin config tables

### Conventions for implementers

- Tests live in root `test/` (Jest + ts-jest) with established mock patterns for interactions, `db`, and `lolService` — every new command/notification should ship with them, and **every new `ILolService` method needs a `MockLolService` counterpart**.
- New commands: one file under `packages/diana-discord/src/plugins/diana-league-bot/discord/commands/` + export in its `index.ts` (registration is picked up from the array).
- New posters: respect `notification_prefs`, go through the `MessageAdapter` (Meeps receives everything — consider a `postType` discriminator field early).
- Parse `challenges` fields as optional, always — Riot changes them between patches without notice.

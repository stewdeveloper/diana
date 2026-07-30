# Meeps + Diana - Programme Roadmap

_Scope: **both repositories**, as one product. Diana (the free Discord bot and data pipeline) and Meeps (the paid desktop client) are tracked here together, because the features worth selling exist only where they meet._

_Written July 2026. Supersedes [`diana-roadmap.md`](diana-roadmap.md), which was scoped to the League bot alone and predates the shipping of its own Phases 0 and 1. The strategic argument - market analysis, competitive landscape, pricing - lives in [`new-design.md`](new-design.md); **this document is the what and the when**, not the why._

---

## 1. How to read this

Each item carries:

> **Owner** `[Diana]` `[Meeps]` `[Joint]` · **Effort** XS / S / M / L · **Rate** Riot API cost · **Needs** dependencies

| Status | Meaning                           |
| ------ | --------------------------------- |
| ✅     | Shipped and in production         |
| 🔨     | In flight                         |
| ⬜     | Planned, in a numbered release    |
| 🧊     | Parked - see §10, with the reason |

Releases are sequenced on one principle: **nothing that isn't required to charge money goes before something that is.** That is the substantive break from the old roadmap, which sequenced on delight-per-effort. Delight-per-effort was the right ordering for a hobby project with five users; it is the wrong ordering the moment a second group is expected to pay.

---

## 2. The thesis, in short

Neither half is sellable alone. Meeps alone is a worse Discord, and that graveyard is deep and recent - Guilded had voice, video, calendars and brackets, was bought by Roblox for $90m, and shut down on 19 December 2025. Diana alone competes in a category where every competitor is free and Riot's own policy _requires_ a free tier.

But there is one position nobody occupies, and structurally almost nobody can:

```
                  INDIVIDUAL                    GROUP
            ┌──────────────────────┬──────────────────────────┐
  ANALYTICS │ Porofessor, Blitz,   │ Trackimo, Dorans,        │
            │ Mobalytics, U.GG,    │ Rankup, Orianna          │
            │ iTero, Hexgate       │ (stats only, no presence)│
            ├──────────────────────┼──────────────────────────┤
  SOCIAL    │ (n/a)                │ Discord, TeamSpeak,      │
            │                      │ Stoat, Mumble            │
            │                      │ (presence only, no data) │
            └──────────────────────┴──────────────────────────┘

  The empty cell is GROUP × (ANALYTICS ∩ SOCIAL): a room that knows
  who is in it, what they are playing, and what happened last time.
```

Every companion app sees matches but not people. Every Discord bot sees a server but not a session. Trackimo.lol sees a "crew" but has no voice and no client. Occupying the intersection requires owning both a voice client and a Riot data pipeline. **We own both, and they already talk to each other** - through exactly one file, `apps/server/src/meepsAdapter.ts`.

The unit of value is the **squad**: the 3–6 people who queue together on a Tuesday night. Not the solo climber (saturated, ad-funded, unwinnable) and not the 5,000-member community (that's Discord, also unwinnable). See [`new-design.md`](new-design.md) §§0–4 for the full argument, competitive survey and pricing.

---

## 3. Where we are today

### 3.1 Diana

**Stack.** TypeScript monorepo - `packages/diana-core` (plugin registry, auth, config store, Express API, both game plugins), `packages/diana-discord` (two Discord clients keyed by `botKey`, command registry, adapters), `apps/server` (host + adapter wiring), `dashboard` (React SPA). Postgres, 12 migrations, 41 Jest suites, Docker, CI.

**It is not a League bot - it is a plugin platform that currently ships two game plugins**, `diana-league-bot` and `diana-apex-bot` (Pathfinder).

**Command surface (21 + core).** League (12): `/add` `/remove` `/summoner` `/champion` `/iotw` `/mvp` `/compare` `/leaderboard` `/livegame` `/setchannel` `/config` `/help`. Apex (8): `/apex-add` `/apex-remove` `/apex-player` `/apex-matches` `/apex-predator` `/apex-uid` `/apex-channel` `/apex-help`. Core: `/ping`.

**The pipeline.** One cron per minute → check each tracked summoner's latest match id → on a new completed match, fetch full match-v5 → store the **entire participants/teams JSON** (including the ~100-metric `challenges` block) in `match_details` → compute **AI score and lobby placement for all ten players** → diff ranked standing into `rank_tracking` → emit a `MessagePayload` → fan out through `MessageAdapter` to Discord **and** the Meeps webhook.

**Three registered crons** (`packages/diana-core/src/plugins/diana-league-bot/index.ts:59-84`): `matchCheckCron` (`0 * * * * *`), `weeklyDigestCron` (`0 0 19 * * 0`), `rotationPostCron` (`0 0 12 * * 2`) - all dashboard-editable, all behind `notification_prefs`.

#### ✅ The old roadmap's Phases 0 and 1 are complete

Shipped in commit `5630bb7` (PR #152, 59 files, +5389/−337), closing issues #113–#131. **Nothing in this table is re-planned below.**

| Old § | Item                                   | Shipped as                                                                                               |
| ----- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 3     | Guild-scoping pass                     | `guildId` join in `interStats.ts:94-120`; `/champion` autocomplete guild-scoped + `region` option (#113) |
| 3     | Fix `/help` names                      | #114                                                                                                     |
| 3     | Unpin Data Dragon version              | 24h-cached latest version + fallback in `dataDragonService.ts` (#115)                                    |
| 3     | Queue-name coverage                    | Expanded map incl. Arena/Swiftplay (#116)                                                                |
| 3     | Keep `summoners` rank columns fresh    | Wired into the poller's rank branch (#117)                                                               |
| 3     | Rate giveback in `/summoner`           | Discarded live rank fetch removed (#118)                                                                 |
| 3     | Cron overlap guard                     | Per-handler in-flight flag, `pluginRegistry.ts:102-135` (#119)                                           |
| 3     | `notification_prefs` on `guild_config` | Migration 012 + `/config notifications` (#120)                                                           |
| 3     | Dead "missing data summary"            | Removed; migration 011 drops the column (#121)                                                           |
| 3     | Doc/env truthing                       | #122                                                                                                     |
| 4.1   | Richer match embeds + flavor lines     | `notifications/flavorLines.ts` - priority-ranked rule table (#123)                                       |
| 4.2   | MVP of the Week                        | `/mvp` (#124)                                                                                            |
| 4.3   | `/leaderboard`                         | `lp` ladder + weekly stat boards (#125)                                                                  |
| 4.4   | Weekly digest                          | `monitoring/weeklyDigestService.ts` + cron (#126)                                                        |
| 4.5   | Streak & milestone callouts            | `utils/streaks.ts`, wired into the poller (#127)                                                         |
| 4.6   | `/compare` and duo stats               | `utils/duoStats.ts` - JSONB containment on the GIN index (#128)                                          |
| 4.7   | `/livegame`                            | `getActiveGame` on `ILolService` + mock (#129)                                                           |
| 4.8   | Free-rotation post                     | `monitoring/rotationPostService.ts`, pref default off (#130)                                             |
| 4.9   | LP sparkline                           | `utils/sparkline.ts`, used in `/summoner` (#131)                                                         |

**What Diana still lacks**, and this release plan addresses: portable scope (everything is keyed to a Discord `guildId`), verified Riot account linking, per-player privacy opt-out, a rate limiter or cache in front of `lolService`, plugin config in Postgres rather than a gitignored `data/plugins.json`, and - the keystone - any structured event contract with Meeps.

### 3.2 Meeps

Per the audit in [`new-design.md`](new-design.md) §1.1. React + Vite + Tailwind (untyped JS), Tauri v1 desktop (Windows-only), Node/Express + Postgres + `ws`, PWA. 28 migrations, v2.0.31.

**Assets that matter, in order:** the **two-way Discord bridge** (per-user identity relay via webhooks, edit/delete propagation, 2000-message backfill) - this is the answer to the objection that killed every Discord competitor; the **call overlay + global hotkeys + system audio capture**, native capabilities a web competitor cannot reach; and **voice presence data**, which no other product in this space has.

**Structural weaknesses R1 exists to fix:** no multi-tenancy at all (channels are hardcoded constants in `App.jsx`); no roles, permissions or moderation; WebRTC mesh voice that degrades past ~6–8 peers; Windows only; setup requires a developer; and a **duplicate Riot pipeline** (`lol_match_pool`, `lol_precomputed_builds`, `draftgap_dataset`) which is a policy problem, not just waste - see §4.1.

---

## 4. Hard constraints

Three constraints that shape the sequencing below rather than being discovered by it.

### 4.1 Riot developer policy

- **Monetisation requires registration** on the Developer Portal with status **Approved or Acknowledged**. Approval has lead time. → **DN-8, started week 1.**
- **A free tier for players is mandatory.** → Diana-on-Discord stays free forever. This is not generosity; it is the licence condition.
- **Paid content must be transformative** - new information, insight or understanding. Reselling match history fails. AI scores, session analytics and squad synergy modelling pass comfortably. Write the argument down for the submission; it doubles as marketing copy.
- **🚨 "Your product cannot feature betting or gambling functionality."** Stated as a condition of monetisation. → The old roadmap's §6.3 betting feature is **deleted**, not deferred. Replacement in §8, _Calls_.
- **One product per production key.** Two pipelines drawing on Riot data read as two products. → §5.4 consolidation.
- No exposing historic Riot IDs, no ads inside Riot properties, no unfair-advantage automation.

### 4.2 Discord monetisation policy

Charging for Diana _as a Discord app_ triggers Discord's Monetization Requirements (effective Oct 2024): the paid capability must be offered through Premium Apps at a price no higher than anywhere else, carrying a 15–30% platform fee.

**⇒ Sell the client, not the bot.** Diana-on-Discord is free forever: it is the distribution channel _and_ it satisfies Riot's free-tier requirement simultaneously. The paid product is Meeps - own surface, own billing, no platform cut, no policy dependency.

This is why §10 demotes Discord-side visual polish. Discord is the funnel; rendering investment belongs where the revenue is.

### 4.3 The Guilded lesson

Guilded did not die from missing features. It died because a friend group cannot unilaterally leave Discord - the switching cost is everyone else.

**⇒ Never ask anyone to leave Discord.** The bridge in `discordBridge.js` is the most commercially important file in either repository, and it is currently configured through a comma-separated environment variable. **MP-8 productises it, and the marketing leads with it:** _"Keep your Discord. We'll bring the messages with us."_

---

## 5. Architecture keystones

Four cross-cutting changes that everything else hangs off. All four get harder every week features are added on top of the current shape.

### 5.1 Typed event bus (DN-1) - the keystone ✅

Today Diana serialises a `MessagePayload` and POSTs it to `/api/diana-notify`. Meeps therefore has no structured knowledge of anything Diana knows. Every joint feature in §7 is blocked by exactly this.

> **Correction to `new-design.md` §1.1, now resolved.** That document describes a "Diana webhook receiver at `/api/diana-notify`" in Meeps. No such route ever existed — only `buildNotifyController.js`, which handles GitHub build pings. DN-1 built the receiver from scratch at **`/api/diana-events`** (`dianaEventsController.js`, migration `030_diana_events.sql`), which was easier than retrofitting: no legacy receiver to stay compatible with, and no existing Meeps rendering to preserve. The only backward-compatibility burden was Discord's output, covered by snapshot tests in `test/discordPayloadRegression.test.ts`.

`MessagePayload` (`packages/diana-core/src/core/pluginTypes.ts:9-20`) is presentation-shaped - title, description, colourHex, fields, footer. There is **no discriminator, no scope id, no idempotency key** anywhere in it.

**Required:** a typed `DianaEvent` union and an `EventAdapter` that ships _alongside_ the existing `MessageAdapter` - Discord output stays byte-identical, regression-tested. `apps/server/src/messageAdapter.ts` `fanOut()` is the seam.

```ts
type DianaEvent =
    | {
          type: 'match.completed';
          squadId;
          matchId;
          queueId;
          participants: ScoredParticipant[];
          startedAt;
          endedAt;
          trackedPlayers: PlayerRef[];
      }
    | { type: 'rank.changed'; squadId; player; from; to; lpDelta; isPeak }
    | { type: 'game.started'; squadId; player; champion; queueId }
    | { type: 'streak'; squadId; player; kind: 'win' | 'loss'; length };
```

Meeps stores these **as rows**, renders them natively, and - critically - **posts presence events back**: `voice.joined`, `voice.left`, `client.in_champ_select`, `client.in_game`.

**Two delivery problems the strategy doc does not name, both must be fixed here:**

1. **Delivery is fire-and-forget.** `meepsAdapter.ts:91-104` is a bare `fetch` with a `console.warn` on failure - no retry, no queue, no acknowledgement. That is acceptable for a chat message and unacceptable for an event that becomes a row: a dropped `match.completed` silently corrupts every session recap and curve computed downstream. **DN-1 must specify at-least-once delivery plus an idempotency key** (`matchId` is the natural one) so redelivery is safe.
2. **The contract already diverges.** `serializeMessagePayload` (`meepsAdapter.ts:14-34`) silently drops `supportUrl` - Discord renders it, Meeps never sees it. A field that exists on one side of a contract and vanishes on the other is exactly the class of bug the typed contract must make impossible.

This also **resolves** the old roadmap's trap #3 (no images or components on the notification path): Meeps receives data and renders natively, so it can show graphs and cards without Diana ever serialising a binary.

### 5.2 `squad_id` as the portable scope (DN-2) ✅

Diana scopes to Discord `guildId`; Meeps has no scope at all. Introduce **`squad_id`** as the shared primary scope, with a Discord guild _or_ a Meeps space as an **attachment** to it. `guild_config` and `guild_summoners` become attachments rather than the scope itself.

This makes every leaderboard, digest and recap correct in both destinations.

> **Note against `new-design.md` §1.2 and DN-2:** the `/iotw` cross-guild leak it describes is **already fixed** - `interStats.ts:94-120` carries the `guild_summoners` join, gated on `InterStatsOptions.guildId`, shipped in #113. DN-2 is required for _portability_, not to close a live leak.

### 5.3 Unified identity (DN-3)

Today nothing is authoritative: Meeps has `users.discord_user_id`, `users.league_username` (free text!) and `valorant_links.riot_puuid`; Diana has `summoners` + `guild_summoners.added_by`, which records who _added_ a summoner, not who _owns_ it.

One `identities` table: one person → many linked accounts (Riot PUUID per game, Discord id, Meeps user). Verify properly - apply for **Riot Sign On**; failing that, the profile-icon handshake (~2 calls). **Delete `league_username` as a matching key** - it is a correctness bug waiting to happen.

`new-design.md` moves this from the old roadmap's Phase 4 to R1, and that is right: honest consent, privacy opt-out and per-player attribution all depend on it, and all three are R1 requirements.

### 5.4 One Riot pipeline (§5.2 of the strategy doc)

Meeps maintains `lol_match_pool`, `lol_precomputed_builds`, `draftgap_dataset`; Diana maintains `match_details`, `match_scores`, `rank_tracking`. Two pipelines, two sets of Riot calls, one-product-per-key exposure, two places to fix a patch-day breakage.

**All Riot ingestion moves behind Diana.** Meeps' build/meta work becomes a `diana-builds` plugin exposing precomputed builds over the event bus and API. Meeps keeps the _presentation_, loses the _ingestion_. This also gives the build data something no competitor's has - see Squad Draft (§7.4).

Scheduled in R3 rather than R1 because it is not a blocker on charging money - but the **portal registration in R1 must describe the consolidated end state**, not the current two-pipeline reality.

---

## 6. R1 - "Sellable"

**Target: 8–10 weeks. Goal: a second group can pay and successfully onboard without your help.**

> **Do not charge anyone before DN-8 completes.** Registration has lead time; start it in week one, in parallel with everything else.

### Diana track

| ID          | Item                                                                                             | Effort       | Acceptance                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ **DN-1** | Typed event bus + `EventAdapter`, with at-least-once delivery and deterministic idempotency keys | M            | **Shipped.** `EventAdapter` ships alongside `MessageAdapter`; Discord output byte-identical (13 snapshots in `discordPayloadRegression.test.ts`); Meeps stores events as rows in `diana_events`; `event_id` is the primary key, so redelivery is a no-op |
| ✅ **DN-2** | `squad_id` scope, portable across Discord guild and Meeps space                                  | S–M          | **Shipped.** Migration 014 (`squads`, `squad_attachments`, `squad_summoners`); every roster read scoped to the squad; events carry `squadId`; two-squad isolation tested in `interStats.test.ts` and `weeklyDigestService.test.ts`                       |
| ⬜ **DN-3** | Riot account linking (RSO if granted, icon handshake otherwise) + per-player privacy opt-out     | M            | Verified link; opt-out honoured by every leaderboard, digest and recap                                                                                                                                                                                   |
| ⬜ **DN-8** | Riot compliance package                                                                          | S, long lead | Product registered; status Approved or Acknowledged; single production key; transformativeness statement written; free tier defined                                                                                                                      |
| ⬜ **DN-4** | Betting removed from the roadmap                                                                 | XS           | No wagering design or code path exists anywhere. **Note: no betting code was ever written** - this is a documentation deletion, already done by this file's existence                                                                                    |
| ~~DN-10~~   | ~~Migration tooling hardening~~ — **dropped, see below**                                         | —            | Not needed                                                                                                                                                                                                                                               |

> **DN-10 was written on a false premise and has been dropped.** `db/migrate.sh`
> already maintains a `schema_migration_diana` versions table keyed on filename,
> applying in `ls | sort` order. The duplicate `002_*` prefix is cosmetic — and
> renaming those files would be actively harmful, because the filename **is** the
> applied-key, so a rename makes those migrations re-run against production.

> **The `supportUrl` divergence in DN-1 is moot** and has been removed from the
> acceptance criteria. `serializeMessagePayload` does drop the field, but nothing
> consumes the message webhook — see §3.2. The path retires under MP-6.

### Meeps track

| ID          | Item                                                                                                                       | Effort | Acceptance                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ **MP-1** | **Spaces** - real multi-tenancy: `spaces`, `channels`, `memberships`, invite links; delete the hardcoded channel constants | **L**  | Two independent squads coexist on one deployment with zero data bleed; channels created/renamed/deleted at runtime; invite flow works end to end. **Highest-priority item in the programme** |
| ✅ **MP-2** | Roles & moderation basics - owner/admin/member, kick, ban, channel permissions                                             | M      | Owner can kick/ban; non-admins cannot alter space config; enforced server-side, not just in the UI                                                                                           |
| ⬜ **MP-4** | Self-serve onboarding - hosted signup, no `.env`, no VAPID generation, no migration step                                   | M      | A non-technical buyer goes from landing page to talking in voice with a friend in under 10 minutes                                                                                           |
| ⬜ **MP-8** | Bridge productisation - guided setup flow replacing `DISCORD_CHANNEL_MAP` env parsing                                      | M      | Channel mapping, identity linking and backfill all self-serve through the UI                                                                                                                 |
| ⬜ **MP-7** | Consent & data surface - per-user opt-in, visible, revocable, exportable; per-space export and delete                      | S–M    | Every user can see, revoke and export what is collected about them; activity logging and voice analytics both default **off**                                                                |
| ⬜ **MP-5** | macOS build (+ Linux)                                                                                                      | S–M    | Signed, notarised, auto-updating. One Mac user currently blocks a whole group's adoption                                                                                                     |

### Joint

| Item                               | Notes                                                                                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⬜ Event contract freeze           | The `DianaEvent` union is a shared artifact. Version it, own it in one place, and regression-test both sides before either team builds on it                                           |
| ⬜ Discord-output regression suite | The single highest-risk part of DN-1 is silently changing what the free bot posts. Snapshot the current embeds first                                                                   |
| ⬜ Pilot recruitment               | Onboard **three friend groups who are not you** in weeks 8–10. This is the most informative item in the plan and the easiest to skip. Watch where onboarding breaks. Do not charge yet |

---

## 7. R2 - "Worth buying"

**Target: +8–10 weeks. Goal: the features that make the price obvious.**

| ID          | Item                                                                           | Owner     | Effort | Rate |
| ----------- | ------------------------------------------------------------------------------ | --------- | ------ | ---- |
| ✅ **DN-5** | Presence ingestion - accept `voice.*` and `client.*` events from Meeps         | `[Diana]` | S      | zero |
| ✅ **DN-6** | Session service - sessionise matches + voice presence into a `sessions` table  | `[Diana]` | M      | zero |
| ⬜ **MP-6** | Native event rendering - match cards, LP graphs, recap cards as first-class UI | `[Meeps]` | M      | -    |
| ⬜ **MP-3** | SFU voice (LiveKit or mediasoup) replacing mesh                                | `[Meeps]` | M–L    | -    |

> **The presence path, as built.** DN-5 and Meeps' MP-07 were each shipped and
> never connected — Meeps recorded voice intervals locally and nothing sent them,
> so `presence_events` held nothing. Three things closed the gap: Meeps grew an
> outbox (`dianaPresence.js`, migration 037) that ships each interval as
> `voice.joined` + `voice.left`; DN-5 learned to resolve a `meepsSpaceId` to a
> squad through `squad_attachments`, because Meeps has no way to know a Diana
> squad uuid; and DN-6 sessionises the result. **Two things still gate real
> data**: `MEEPS_INBOUND_SECRET` on Diana with its `DIANA_PRESENCE_SECRET`
> counterpart on Meeps, and a `meeps_space` attachment row — there were none, so
> every event would have answered `unattached_space`.
>
> **Match attribution is squad-level and works today.** `squad_summoners` says
> which puuids a squad tracks, so "which games happened during this night" needs
> no identity linking. Only per-player attribution — "was Louis in voice for game
> 5" — waits on DN-3/MP-05, and the recap line quoted below is the part that
> waits. `session_participants` is therefore keyed on `meeps_user_id`, not puuid:
> keying on puuid would exclude exactly the friend who was in the call all night
> without playing.

### 7.1 ⭐ Session Recap - the flagship

**If only one thing ships in R2, this is it.**

**What.** The atomic unit of a friend group's gaming life is not the match - it's the night. When the last person leaves voice, the space gets a recap card:

> _Tuesday 8:12pm – 1:40am · 5 hrs 28 min · 7 games · 3W-4L · five of you · Louis left after game 5 (you were 3-1) · best game: Aidan's Warwick, 1st place AI score · worst: everyone's, game 6 · longest voice silence: 4m12s during game 6._

**Why it works.** It is the artifact of an experience people already value and currently have no record of. It is shareable, which makes it a distribution loop. And it is _funny_, which is the actual retention mechanism in a friend group - Diana already has the voice, in `flavorLines.ts` and `/iotw`.

**Why nobody can copy it.** Requires voice presence timestamps joined to match outcomes. Trackimo has no voice. Discord bots can read voice-state events but have no match pipeline. Companion apps have no concept of a group.

**Needs:** DN-1, DN-5, DN-6, MP-6 · **Effort:** M · **Rate:** zero (entirely stored data)

### 7.2 Squad Wrapped

End-of-split recap card per squad: games, voice hours, most-played duo, best and worst game, the LP journey, the night you went 0-6 - plus, because Meeps owns the chat corpus, the group's most-used word and most-reacted message.

Cheap (all stored data) and the single most shareable artifact producible. This is the organic acquisition channel: one person posts the card, four friends ask what it is.

**Timing matters: ship before the next split boundary, not after.**

**Needs:** DN-6, MP-6 · **Effort:** M · **Rate:** zero

### 7.3 Presence-aware notification routing

Meeps knows whether you are in voice, in game or away, and already has Web Push with VAPID. So: suppress match pings while you are in a game, batch them, deliver the recap when you leave voice, escalate a mention to push only if you are genuinely away.

Small, but this is the texture of a product people pay for. Discord cannot do it - it doesn't know you're in champ select.

**Needs:** DN-5, existing push infrastructure · **Effort:** S

---

## 8. R3 - "Defensible"

**Target: +12 weeks.**

### 8.1 The Session Curve (Queue Curfew)

Per-squad analytics on _when_ the group plays well: win rate and average AI score by game number in the session, by session length, by hour of night, by roster composition, and - the one nothing else can compute - **by whether the player was in voice**. A chart plus one plain sentence:

> _This squad's win rate is 58% for games 1–4 and 31% from game 5 on. Median session: 6 games._

**Why nobody can copy it.** Same data requirement as the recap, plus a business-model reason: the incumbents are engagement-funded ad products. **An ad-supported app cannot ship a feature that tells you to stop playing.** You can only build this because you charge money - which is worth saying out loud in marketing.

**Design ethic, non-negotiable.** Informational, never moralising. Per-user opt-in for the voice dimension. Group-visible only with consent - _"your winrate collapses after 11pm"_ is banter between friends and a weapon between acquaintances. Nudge defaults off. Never gamify session length upward.

**Needs:** DN-6, MP-7 · **Effort:** M · **Rate:** zero

### 8.2 Live squad presence & the champ-select room

The Meeps desktop client reads the local League client (LCU), so the space shows live: who's in queue, who's in champ select and on what, who's in game. Then: auto-join voice on queue accept; a champ-select panel showing each squadmate's lock-in, their history on that champion _from your group's own data_, and the recommended build from the consolidated pipeline; the voice room's accent theming shifting to the locked champion (Meeps already extracts accent colours from character art).

This is the answer to Trackimo's "nothing to install" - the feature that makes a desktop client worth having.

**Risks, stated plainly.** LCU is undocumented and unofficial; Riot tolerates it but it can break on any patch. Streamer Mode already restricts some live scouting data. **Do not automate any in-game action** - that crosses the unfair-advantage line.

**Fallback: spectator-v5 polling.** The old roadmap's §6.1 design notes still apply and are carried forward verbatim: a **2–3 minute cadence** (not the poller's 1 min), guarded by the overlap flag; **its own dedup state** - do _not_ reuse `summoners.currentMatchId`, the completed-match poller's rank-anchor logic keys off it; per-squad opt-in; only poll summoners tracked by an opted-in squad; skip players who finished a game in the last few minutes.

**Needs:** MP-3, MP-6, LCU integration in Tauri · **Effort:** L · **Rate:** low with LCU (local); +N per tick with the spectator fallback

### 8.3 Squad Draft

A draft/comp tool scoped to _your five_. Not "Xayah-Rakan wins 54% globally," but: given the champions **these five have actually played in the last 90 days**, their **real recorded duo and trio win rates together** (`duoStats.ts` already computes this from `participants` JSONB), and DraftGap's generic priors as a fallback where the sample is thin - here are comps that work _for you_, and here's the bot lane that keeps losing.

Every draft tool in existence is generic. This is the flex-queue and Clash use case, and it is the only build/draft feature in the category that gets _better_ the longer you use the product - a retention flywheel and a switching cost.

**Needs:** §5.4 pipeline consolidation, DN-2 · **Effort:** M–L · **Rate:** zero

### 8.4 Enabler A - component interaction router `[Diana]`

**Promoted from the old roadmap's Phase 2, because Calls depends on it.**

Extend `setupDiscord.ts` / `commandRegistry.ts` to dispatch `isButton()` / `isStringSelectMenu()` / `isModalSubmit()` through a customId-namespaced registry (`plugin:command:action:state`), per `botKey` (two-client architecture). Keep pagination **stateless** - encode page and target in the customId, hold no server-side session state. Shared infra: Pathfinder gets it free.

**Effort:** M

### 8.5 Calls - the betting replacement

Betting was the old roadmap's stickiest planned social feature. It is also **prohibited**: _"Your product cannot feature betting or gambling functionality"_ is a stated condition of Riot monetisation. Virtual currency does not obviously save you, and "richest degenerate leaderboard" is not the framing you want in a compliance review.

**Ship this instead.** When a game starts, the space opens a 3-minute **Calls** window. Members call outcomes - win/loss, "Aidan tops the AI score", "this goes over 35 minutes". No currency, no stake, no wager, no payout. Settlement produces **reputation only**: a rolling accuracy percentage and a "who called it" leaderboard.

You keep the entire social payoff - the banter is in _being right_, not in the fake money - you lose the policy risk, and you lose the engineering trap the old roadmap correctly flagged as trap #1: a ledger with idempotent settlement that double-pays under overlapping cron ticks. **Accuracy statistics are idempotent by nature.** That is a real engineering reason to prefer Calls, independent of policy.

**Needs:** §8.2 live game detection, §8.4 Enabler A · **Effort:** M

### 8.6 Platform hardening

| ID           | Item                                                                                                            | Owner     | Effort     |
| ------------ | --------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| ⬜ **DN-7a** | Centralised rate limiter + cache in front of `lolService` - per-region budgets, request coalescing, DDragon TTL | `[Diana]` | M          |
| ⬜ **DN-7b** | Plugin enable/config from `data/plugins.json` → Postgres (multi-instance / HA)                                  | `[Diana]` | M          |
| ⬜ **MP-9**  | Incremental TypeScript migration of the Meeps backend + real test coverage                                      | `[Meeps]` | M, ongoing |
| ⬜ **§5.4**  | Riot pipeline consolidation into `diana-builds`                                                                 | `[Joint]` | M–L        |

`lolService.ts` today is a thin `twisted` wrapper with **no rate limiter, no queue, no cache and no 429 backoff of its own** - the only cache in the codebase is DataDragon's 24h version cache. That is survivable while one friend group shares one key. It stops being survivable the moment paying customers share it.

MP-9 matters because the event contract is shared with a 40-suite TypeScript codebase; Meeps' 2 test files and untyped backend are the weak side of that contract.

---

## 9. Riot rate budget

Carried forward from the old roadmap. Still correct, and still the sharpest constraint analysis in either document.

| Key tier                     | Limits                               | Notes                                                  |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------ |
| Development                  | 20/s and 100/2min, **expires daily** | Testing only                                           |
| Personal                     | Same limits, permanent               | What most **self-hosters** run - no increases possible |
| Production (this deployment) | **Per-method** - 39 methods approved | See note below                                         |

> **⚠️ `docs/access.md` is missing.** The old roadmap cites it six times as the authoritative record of the production key's per-method limits, but it has never been committed to this repository (`git log --all -- docs/access.md` is empty). The figures below are carried forward from that roadmap and should be treated as unverified until the file is restored. **Restoring it is an R1 task under DN-8** - the compliance package needs an accurate record of what the key actually grants, and every rate claim in this section depends on it.

**What the production key allows** (per the figures above - see the caveat). Everything here is effectively unlimited at our scale: match-v5 and timeline (2000/10s), spectator-v5 (3000/10s), league-entries-by-puuid / champion-mastery / challenges / rotations (20000/10s). The only tight spots: **clash-v1 `/tournaments` at 10/min** (poll daily, cache) and **account-v1 at 1000/min** (only matters for mass metadata syncs). The key has **no TFT APIs** and only the tournament _stub_.

**The maths that still matters is for self-hosters on personal keys** (~50 calls/min sustained): the poller costs roughly **N calls/min** + **~3 per finished match** + **2N/day** metadata sync. A group tracking 5–15 summoners has comfortable headroom - and that headroom is the budget every rate-costing feature spends from.

| Feature                                                                        | Riot calls                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **Every joint feature in §7 and §8.1/§8.3**                                    | **0** - entirely stored data                                 |
| Session Recap, Session Curve, Squad Wrapped, Squad Draft, Calls                | **0**                                                        |
| Shipped: richer embeds, MVP, leaderboards, digest, streaks, compare, sparkline | 0                                                            |
| `/livegame` (basic, shipped)                                                   | 1 per use                                                    |
| Free rotation (shipped)                                                        | 1 per week                                                   |
| `/link` icon verification (DN-3)                                               | ~2 per link                                                  |
| LCU presence (§8.2)                                                            | 0 - local client                                             |
| Spectator polling fallback (§8.2)                                              | +N per tick - 1-min cadence **doubles** usage; 3-min is +33% |
| Lobby scouting enrichment                                                      | up to ~10 per use - **production-key gated**                 |

**That every differentiated feature is `Rate: zero` is a strategic fact, not a footnote.** The product's moat is built on data already in Postgres. Riot rate limits do not constrain the roadmap; they constrain only the live-presence layer, which has a local-client path that avoids them entirely.

---

## 10. Parked and superseded 🧊

Items from the old roadmap that are **not** cancelled but are no longer scheduled, each with the reason.

### Demoted because Discord is now the free acquisition tier

Per §4.2, rendering investment belongs where the revenue is. Meeps' native rendering (MP-6) delivers this value on the paid surface.

| Item                                               | Old § | Reason                                                                          |
| -------------------------------------------------- | ----- | ------------------------------------------------------------------------------- |
| 🧊 Enabler B - canvas renderer (`@napi-rs/canvas`) | 5     | Optional/late. Its only consumers below are all superseded                      |
| 🧊 Image score cards                               | 5     | Superseded by MP-6                                                              |
| 🧊 LP progression graphs                           | 5     | Superseded by MP-6 - Meeps renders graphs natively from event rows              |
| 🧊 Paginated `/matches` browser                    | 5     | Needs Enabler A, which now ships for Calls. Revisit if the router lands cheaply |
| 🧊 Mastery milestones                              | 5     | +1 Riot call per match for a free-tier polish feature                           |
| 🧊 Clash reminders                                 | 5     | Genuinely nice; not on the path to revenue                                      |

### Still live ideas, unscheduled

- **Auto rank roles** - the ecosystem's most-praised feature (Orianna, Dorans, Zoe all lead with it). Now unblocked by DN-3. Reconsider as an **acquisition** investment once R1 ships: it is the #1 reason servers install a LoL bot. Needs Manage Roles, role-hierarchy handling, and at 100+ servers the GuildMembers privileged intent + bot verification.
- **User-installable app mode** - `/summoner`-style lookups in any server or DM. Low competition; strong organic-growth lever.
- **TFT tracking** - same account→puuid flow, but TFT APIs are **not on the current production key**. Request expanded access first. A second game without a second bot.
- **Arena-specific handling** - placement-based embeds (queue 1700); the AI scoring algorithm assumes SR roles, so Arena needs its own branch.
- **Timeline-powered recaps** - gold-diff@15 and kill maps from match-v5 `/timeline`. The client method and the `match_timeline` table already exist, unused. Now better sited in Meeps than Discord.
- **Cross-game continuity** - Apex ships today, Valorant is half-built in Meeps (`valorant_links`, `valorant_tracked_matches`), Rust device control exists. Overwolf and Tracker Network do multi-game **per individual**; nobody does multi-game **per group**. Build sessions, recaps and Wrapped on the event schema, not on League specifics, and this comes nearly free.
- **Self-refreshing rank channel**, **in-house queue tools**, **lol-challenges-v1 percentile flexes**, **forum-thread-per-match** - unchanged from the old §8.

---

## 11. Don't build (traps)

Merged from the old roadmap §9 and [`new-design.md`](new-design.md) §10.

1. **Anything with a wager.** No currency, no balances, no payouts. Riot's monetisation conditions prohibit betting and gambling functionality outright. Calls (§8.5) delivers the same social payoff - _and_ it is idempotent by construction, which the old ledger design was not.
2. **Discord feature parity.** Threads, forums, stage channels, server discovery, emoji marketplaces. This is the Guilded death march. The answer to "Discord has X" is "yes, and we bridge to Discord."
3. **Community-scale anything.** 1,000-member servers need moderation tooling, trust & safety and abuse response you cannot staff. Cap spaces deliberately and say so as a feature.
4. **A solo-player companion overlay.** Saturated, ad-funded, wrong unit of analysis. Every hour here is an hour not spent on the intersection.
5. **Two Riot pipelines.** One product per production key, and patch-day breakage twice over.
6. **Window-title activity logging as a headline feature.** The right thing is already built (three detail levels including `none`) - but in a market spooked by ID leaks, a feature that reads what window you have open must be opt-in, obviously scoped, and explained. Lead with LCU game presence, which is narrow and legible.
7. **A mobile-first bet.** The value is at the desk, at night, in voice. Mobile is for reading the recap the next morning; the PWA already covers that.
8. **Full 10-player lobby scouting on personal keys.** Ten league-v4 calls per curious user through the same `twisted` queue as the poller - 429 backoff then **silently delayed match-end embeds**, with the cause invisible to the operator. Gate behind a production-key flag.
9. **Default-on spectator polling.** It halves every self-hoster's rate headroom for a feature many squads won't enable. Opt-in, slower cadence, opted-in squads only.
10. **Hand-rolling an SFU.** The honest cost of this strategy is having to be good at two hard things - real-time voice _and_ a rate-limited data pipeline. The mitigation is that voice is a **buy, not a build**. If you find yourself writing an SFU, you have lost the plot.

---

## 12. Validation gates

Five questions in descending order of how much damage a wrong answer does. Each is attached to the release that must answer it - these are **gates, not musings**.

| #   | Question                                                                                                 | Gate                    | How to test                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Do people share the Session Recap unprompted?**                                                        | End of R2               | Three pilot groups, zero marketing spend. If they don't share it, the flagship is wrong - and you need to know in month four, not month twelve                                                     |
| 2   | **Is the Session Curve _true_ for real groups, and _interesting_ rather than obvious?**                  | **Before any R3 work**  | Compute it retroactively from existing `match_details` on your own group. **Costs a SQL query and zero Riot calls.** If the curve is flat, the single best differentiator is dead - find out first |
| 3   | **Will the payer pay while friends free-ride?**                                                          | Before building billing | A manual Stripe link. Precedent says yes (game servers, TeamSpeak), but test it                                                                                                                    |
| 4   | **Does the bridge neutralise the switching cost,** or do groups bounce back to Discord within two weeks? | End of R1 pilot         | If the bridge doesn't hold them, the whole anti-Guilded strategy needs rethinking                                                                                                                  |
| 5   | **Can you get RSO?**                                                                                     | R1, ask week 1          | Changes onboarding friction materially. The icon handshake works but costs conversions                                                                                                             |

Gate 2 is the cheapest and most load-bearing item in this entire document.

---

## 13. Appendix

### 13.1 Traceability - every `new-design.md` ID

| ID        | Item                                 | Here                                                |
| --------- | ------------------------------------ | --------------------------------------------------- |
| MP-1      | Spaces multi-tenancy                 | ✅ **Shipped** - §6 R1                              |
| MP-2      | Roles & moderation                   | ✅ **Shipped** - §6 R1                              |
| MP-3      | SFU voice                            | §7 R2                                               |
| MP-4      | Self-serve onboarding                | §6 R1                                               |
| MP-5      | macOS build                          | §6 R1                                               |
| MP-6      | Native event rendering               | §7 R2                                               |
| MP-7      | Consent & data surface               | §6 R1                                               |
| MP-8      | Bridge productisation                | §6 R1                                               |
| MP-9      | Typed backend + coverage             | §8.6 R3                                             |
| DN-1      | Typed event bus                      | ✅ **Shipped** - §5.1, §6 R1                        |
| DN-2      | `squad_id` scope                     | ✅ **Shipped** - §5.2, §6 R1                        |
| DN-3      | Riot account linking + opt-out       | §5.3, §6 R1                                         |
| DN-4      | Kill betting                         | §6 R1 - **doc deletion only, no code existed**      |
| DN-5      | Presence ingestion                   | ✅ **Shipped** - §7 R2                              |
| DN-6      | Session service                      | ✅ **Shipped** - §7 R2                              |
| DN-7      | Rate limiter, cache, Postgres config | §8.6 R3                                             |
| DN-8      | Riot compliance package              | §6 R1, **week 1**                                   |
| DN-9      | Old roadmap Phase 0                  | ✅ **Shipped** - §3.1                               |
| ~~DN-10~~ | ~~Migration tooling~~                | **Dropped** — versions table already exists; see §6 |
| 6.3.1     | Session Recap                        | §7.1                                                |
| 6.3.2     | Session Curve                        | §8.1                                                |
| 6.3.3     | LCU presence & champ select          | §8.2                                                |
| 6.3.4     | Squad Draft                          | §8.3                                                |
| 6.3.5     | Squad Wrapped                        | §7.2                                                |
| 6.3.6     | Presence-aware notifications         | §7.3                                                |
| 6.3.7     | Cross-game continuity                | §10, ideas                                          |
| 6.4       | Calls                                | §8.5                                                |
| §5.2      | Pipeline consolidation               | §5.4, §8.6                                          |

### 13.2 What changed from `diana-roadmap.md`

| Old                                                             | New home                 | Why                                                                            |
| --------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| Phase 0 (all 9 items)                                           | ✅ §3.1                  | Shipped in #152                                                                |
| Phase 1 (all 9 items)                                           | ✅ §3.1                  | Shipped in #152                                                                |
| Phase 2 Enabler A (component router)                            | §8.4 R3                  | **Promoted** - Calls depends on it                                             |
| Phase 2 Enabler B (canvas) + image cards, LP graphs, `/matches` | 🧊 §10                   | Superseded by MP-6; Discord is the free tier                                   |
| Phase 2 mastery, Clash                                          | 🧊 §10                   | Not on the path to revenue                                                     |
| Phase 3.1 live-game alerts                                      | §8.2                     | Absorbed as the LCU fallback path; design notes carried verbatim               |
| Phase 3.2 lobby scouting                                        | §11 trap 8               | Unchanged; still production-key gated                                          |
| **Phase 3.3 match betting**                                     | **Deleted** → §8.5 Calls | **Riot policy prohibits it.** Not deferred - removed                           |
| Phase 4 `/link`                                                 | §5.3 R1                  | **Promoted from Phase 4 to R1** - identity gates consent and privacy           |
| Phase 4 privacy toggles                                         | §6 R1, part of DN-3      | Same promotion; a paid product needs honest consent                            |
| Phase 4 auto rank roles                                         | 🧊 §10                   | Now unblocked by DN-3; reconsider as acquisition after R1                      |
| Phase 4 platform hardening                                      | §8.6 DN-7                | Urgent once customers share one key                                            |
| §8 ideas bucket                                                 | §10                      | Carried forward, plus the demotions                                            |
| §9 traps                                                        | §11                      | Merged. Trap 1 retired (betting deleted); **trap 3 resolved** by the event bus |
| §1 rate budget                                                  | §9                       | Carried forward near-verbatim                                                  |
| §11 conventions                                                 | §13.4                    | Carried forward, plus an event convention                                      |

### 13.3 Migrations by release

- **R1** `[Diana]`: `squads` + squad attachments (guild ⇄ space) — ✅ `014_squads.sql`; `identities` + `riot_account_links` and per-player privacy flags — DN-3, outstanding.
- **R1** `[Meeps]`: `030_diana_events.sql` — the event log, `event_id` as primary key for idempotency. ✅ shipped (it landed as 030, not 029).
- **R1** `[Meeps]`: `spaces`, `channels`, `memberships`, invite links — ✅ `032_spaces.sql`, `033_messages_channel_id_backfill.sql`; roles/permissions — ✅ `035_space_bans.sql`; consent + export records — MP-7, outstanding.
- **R2** `[Diana]`: voice presence — ✅ `015_presence.sql` (`presence_events`, `presence_consent`); `sessions`, `session_participants`, `session_matches` — ✅ `016_sessions.sql` (DN-6, derived and rebuildable).
- **R2** `[Meeps]`: durable voice intervals — ✅ `031_voice_presence.sql` (MP-07); `users.public_id` + presence delivery tracking — ✅ `037_presence_outbox.sql`.
- **R3**: live-game dedup state (**separate from `summoners.currentMatchId`**); Calls windows + accuracy stats; plugin config tables; `diana-builds` tables migrated from Meeps.

### 13.4 Conventions for implementers

Carried forward from the old §11, plus one addition:

- Tests live in root `test/` (Jest + ts-jest) with established mocks for interactions, `db` and `lolService`. Every new command and notification ships with them.
- **Every new `ILolService` method needs a `MockLolService` counterpart** - tests depend on the mock.
- New commands: one file under `packages/diana-discord/src/plugins/diana-league-bot/discord/commands/` + export in its `index.ts`.
- New posters respect `notification_prefs` and go through the adapter.
- **Parse `challenges` fields as optional, always** - Riot changes them between patches without notice. The defensive pattern is in `scoringAlgorithm.ts`.
- Shared Discord enablers belong in `packages/diana-discord/src/discord/`, keyed by `botKey` - two bot clients share the layer.
- `node-cron` fires in server-local time. Document it wherever a schedule is user-visible.
- **New:** every `DianaEvent` variant needs (a) a documented Meeps-side row shape and (b) an idempotency key. An event without both is a message, and belongs on `MessageAdapter` instead.

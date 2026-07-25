# Meeps + Diana: Product Strategy & Requirements

**Prepared July 2026.** Based on a code-level audit of both repositories (not the READMEs - both undersell themselves badly), Diana's existing roadmap doc, Riot and Discord developer policy as of July 2026, and a survey of the chat/voice and League-companion competitive landscapes.

---

## 0. The thesis in one paragraph

Neither product is sellable alone. Meeps alone is a worse Discord, and the graveyard of "better Discord" products is deep and recent. Diana alone lives in a category where every competitor is free and Riot's own policy requires you to have a free tier. But there is one thing on the market that nobody has and - structurally - almost nobody _can_ build: **a product that knows both who is in voice and what happened in the game.** Every companion app (Porofessor, Blitz, Mobalytics, U.GG, iTero) sees matches but not people. Every Discord bot (Dorans, Orianna, Rankup, Zoe) sees a server but not a session. Trackimo.lol sees a "crew" but is a website with no voice and no chat. You own both halves already, and they are already wired together by one file (`apps/server/src/meepsAdapter.ts`). The product you should sell is not "chat app plus stats bot." It is **the friend group's room, which remembers.**

The unit of value is the **squad** - the 3–6 people who queue together on a Tuesday night. Not the individual player (that's the companion-app market, saturated and ad-funded) and not the community server (that's Discord, unwinnable).

---

## 1. What you actually have today

### 1.1 Meeps - audited

**Stack:** React + Vite + Tailwind (JS, untyped), Tauri v1 desktop (Windows-only shipping), Node/Express + Postgres + `ws` backend, PWA with service worker. 28 migrations, 221 commits, 34 releases, currently v2.0.31 (3 July 2026). Deployed on Railway.

The README describes "a cross-platform desktop and web chat application." That is a dramatic undersell. What is actually in the tree:

| Area                      | What's built                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Text**                  | Single merged feed across bridged channels, replies, reactions, GIF picker, uploads with signed file paths, pinned uploads, rich embed cards (`EmbedCard.jsx`, `messages.embed`)                                                                                                                                                                                                                    |
| **Voice**                 | WebRTC voice rooms, noise suppression (`noiseSuppression.js`), global push-to-talk hotkeys via Rust (`src-tauri/src/global_keys.rs`), system audio capture (`system_audio.rs`), a separate always-on-top **call overlay window** (`src/overlay/CallOverlay.jsx`), join/leave/connect sounds, deafen/mute, resizable voice rail                                                                      |
| **Presence**              | User status, plus **activity logging that reads the active window title** with three privacy levels (`in_depth` / `just_application` / `none`)                                                                                                                                                                                                                                                      |
| **Identity / vanity**     | Character selection from LoL champions and Valorant agents (`characters.js`, `valorantAgents.js`, `leagueChampions.js`), skin art, **accent colour extracted from the character art and used to theme that user's UI** (`extractAccentColor.js`), per-user win/lose GIFs                                                                                                                            |
| **Notifications**         | Web Push with VAPID, iOS PWA push when the app is closed, mention detection, background/foreground routing                                                                                                                                                                                                                                                                                          |
| **Integrations**          | **Two-way Discord bridge** with per-user identity relay via webhooks, edit/delete propagation, and startup backfill of up to 2000 messages per channel (`discordBridge.js`); Diana webhook receiver at `/api/diana-notify`; GitHub Actions build notifications into a `#Builds` channel; Rust game-server device control (`rust_configs`, `rust_devices`); Valorant account links + tracked matches |
| **LoL data (surprising)** | `lol_match_pool`, `lol_precomputed_builds` (top-3 builds per champion/role/patch), `draftgap_dataset` - i.e. **Meeps has its own independent League data pipeline**                                                                                                                                                                                                                                 |
| **Distribution**          | Tauri MSI + portable exe, GitHub Actions Windows build, auto-update dialog + `latest.json`, PWA install, Docker                                                                                                                                                                                                                                                                                     |

**The three assets you are undervaluing, in order:**

1. **The two-way Discord bridge.** This is the most commercially important file in either repository and neither README mentions it. See §3.3 - it is the answer to the objection that has killed every Discord competitor.
2. **The call overlay + global hotkeys + system audio.** You have native desktop capabilities that a web-based competitor cannot reach. This is the surface for in-game features.
3. **Voice presence data.** You are the only product in this space that knows who was in a room, with whom, for how long. Nothing in §6.3 is buildable without it.

**Structural weaknesses (product, not code quality):**

- **No multi-tenancy at all.** Channels are hardcoded constants in `App.jsx` (`TEXT_CHANNELS`, `MAIN_TEXT_CHANNEL = "general"`, `VOICE_CHANNELS = [{id:"voice"}]`). There is no `spaces` / `servers` / `channels` table. Every install is one group. You cannot sell this to a second customer without this change.
- **No roles, permissions, or moderation.** Fine for five friends; a liability the moment a stranger joins.
- **WebRTC mesh voice** - every peer connects to every peer. Degrades badly past roughly 6–8 participants.
- **Windows-only desktop**, no native mobile (PWA only), no E2EE.
- **Untyped JS backend, 2 test files.** Contrast with Diana's ~40 Jest suites. This asymmetry will bite when the two share a data contract.
- **A duplicate Riot pipeline** (see §3.1 - this is a policy problem, not just waste).
- **Setup requires a developer**: `.env`, VAPID key generation, migrations, Railway config.

### 1.2 Diana - audited

**Stack:** TypeScript monorepo (96% TS), 227 commits, v2.0.1 (28 March 2026). Packages: `diana-core` (plugin registry, auth, config store, Express API), `diana-discord` (client, command registry, keyed by `botKey` for two bots), `apps/server` (adapters + entry), `dashboard` (React). Postgres, 12 migrations, ~40 Jest suites, Docker, CI, ISC licensed.

**It is not a League bot. It is a plugin platform that currently ships two game plugins.** `diana-league-bot` (LoL) and `diana-apex-bot` (Apex, branded Pathfinder). Plugins contribute slash commands, Express routes and cron jobs, toggled from a web dashboard.

**The pipeline:** one cron per minute → check each tracked summoner's latest match ID → on a new completed match, fetch full match-v5 → store the **entire participants/teams JSON** (including the ~100-metric `challenges` block) → compute **an AI score and lobby placement for all ten players** → diff ranked standing into `rank_tracking` → emit a `MessagePayload` → fan out through `MessageAdapter` to Discord **and** the Meeps webhook.

**Commands today:** `/add`, `/remove`, `/summoner`, `/champion`, `/iotw` (Inter of the Week - roast leaderboard), `/mvp`, `/compare`, `/leaderboard`, `/livegame`, `/setchannel`, `/config`, `/help`, plus the Apex set.

**The two assets you are undervaluing:**

1. **`MessagePayload` → `MessageAdapter` fan-out.** Diana is already destination-agnostic. Discord is _a_ renderer, not _the_ renderer. Most bot codebases are welded to discord.js. Yours isn't. That is what makes a paid non-Discord client possible at all.
2. **The AI score with per-lobby placement.** Your own roadmap correctly identifies that none of the surveyed competitors have this. It scores all ten players, so you have relative-performance data on untracked players too.

**Weaknesses:**

- Scope is the **Discord guild**, not a portable group. `/iotw` currently aggregates across every guild the bot is in (no guild filter in `interStats.ts`) - a data-leak bug in any multi-tenant deployment.
- The dashboard is a login page plus a summoner list. There is no player-facing web product.
- No Riot account linking (roadmap Phase 4), no per-player privacy opt-out.
- Plugin enable/config lives in `data/plugins.json` - blocks multi-instance/HA.
- No centralised Riot rate limiter or cache in front of `lolService`.
- **The Phase 3 betting feature cannot ship.** See §3.1.

Your roadmap doc is, for what it's worth, better than most funded startups' - the phase ordering by value-per-effort, the rate-budget maths, and the "don't build (traps)" section are all correct. Most of it survives this document intact; §7 slots it into a commercial sequence.

---

## 2. Competitive landscape

### 2.1 The chat/voice side

The timing here is unusually good, and it will not last.

| Product                     | Position                                       | Weakness you can exploit                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Discord**                 | Incumbent, ~unassailable network effects, free | Rolling out global age verification (announced Feb 2026 for March, **delayed to H2 2026 after severe backlash**); an October 2025 third-party vendor breach exposed government IDs of ~70,000 users; ad products in-app. Google searches for "Discord alternative" spiked immediately after the Feb 9 announcement; a r/pcmasterrace thread demanding a "proper Discord alternative" cleared 16,000 upvotes |
| **TeamSpeak**               | Voice quality, private hosting                 | Reported a _massive surge_ of new users in Feb 2026 and had to add hosting regions. Text chat, media and emoji support are primitive; no video                                                                                                                                                                                                                                                              |
| **Stoat** (formerly Revolt) | Closest visual/functional clone, open source   | New (2021), capacity issues and lag during the 2026 surge, feature gaps                                                                                                                                                                                                                                                                                                                                     |
| **Element / Matrix**        | Federated, E2EE, self-hostable                 | Requires technical savvy; not gaming-shaped                                                                                                                                                                                                                                                                                                                                                                 |
| **Mumble**                  | Free OSS low-latency voice                     | Dated UI, voice-only                                                                                                                                                                                                                                                                                                                                                                                        |
| **Valour**                  | OSS challenger, vocally anti-Discord           | Tiny                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Guilded**                 | **Dead.** Shut down 19 Dec 2025                | See §3.3 - the most important competitor in this table                                                                                                                                                                                                                                                                                                                                                      |

**Read:** demand for an exit from Discord is at a decade high and is currently being absorbed by _voice-only_ (TeamSpeak, Mumble) or _clone_ (Stoat) products. Nobody is offering a reason to switch beyond "not Discord." "Not Discord" is not a product.

### 2.2 The League side

**Companion apps** (individual player, desktop overlay, ad-funded):

| App                             | Note                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Porofessor**                  | Pre-game lobby scouting; Overwolf-dependent, increasingly dated, rising error reports                                                                                          |
| **Blitz**                       | Auto-imports runes/items on champ lock; standalone (no Overwolf) which is now a differentiator; **heavy ads** on free tier; multi-game expansion diluted LoL focus             |
| **Mobalytics**                  | Deepest post-game analytics (GPI); **user rating down to ~3.6 stars**, 2026 reviews dominated by 1-star complaints about freezing, bugs and increasing ads; Overwolf-dependent |
| **U.GG / OP.GG**                | Trusted static build data and player lookup; overlays thin                                                                                                                     |
| **Facecheck**                   | Deliberately minimal - one actionable matchup tip                                                                                                                              |
| **iTero, Hexgate, buildzcrank** | 2026's AI-coach wave; standalone, adaptive builds. The innovation is happening here, not at the big three                                                                      |

The pattern across every review in 2026: **the incumbents are bloated, ad-saturated, Overwolf-dependent and losing users to lighter standalone tools.** Also worth noting: Riot's Streamer Mode can block the live scouting data that several of these depend on - a platform risk for anyone building lobby-scouting features.

**Discord LoL bots** (server-scoped, free): Dorans (fun match descriptions, betting, daily summaries, auto-updating leaderboards), Rankup ("Carry Score", head-to-head), Orianna (mastery, auto rank roles, privacy dashboard), OP.GG bot, Zoe (self-refreshing pinned rank channel), In-House Queue. All free. Nobody in this category has trained users to pay.

**The one that matters: [Trackimo.lol](https://trackimo.lol).** Web app, Riot sign-in, nothing to install. Its own marketing describes turning the solo/duo grind into a shared clubhouse: invite your crew by link, compare stats only within the group rather than against random players, see per-duo win rates to identify which pairings actually work, and get a weekly surfacing of who climbed most, who fell hardest, and who's on the longest win streak - explicitly framed as giving the group something to argue about.

That is, almost line for line, Diana's group-tracking feature set with a better onboarding story. **Take this seriously: the "group stats" idea is not defensible on its own.** It is already built, already frictionless, and already free. What Trackimo does not have - and cannot easily get - is voice, chat, presence, or a desktop client. Which is exactly where your moat has to come from.

### 2.3 The gap

Draw the two axes:

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

Nobody occupies the intersection. Not because it's unattractive but because it requires owning both a voice client and a game-data pipeline, and nobody has both. **You have both, and they are already talking to each other.**

---

## 3. Hard constraints - read before designing anything

Three constraints that should shape the roadmap rather than be discovered by it.

### 3.1 Riot's developer policy

Riot permits commercial products, but with conditions that directly affect your plans:

- **Monetisation is allowed** provided the product is registered on the Developer Portal and its status is **Approved or Acknowledged**. You need to do this before you charge anyone. Register now - approval is not instant.
- **A free tier for players is mandatory**, not optional - the policy states it as a requirement, and notes it may include advertising. Your pricing model has to include a genuinely usable free tier.
- **Paid content must be transformative** - Riot defines this as adding value through new information, aesthetics, insights or understanding. Reselling match history fails this test. Your AI score, session analytics and group synergy modelling pass it comfortably. **Write the transformativeness argument down** as part of the portal submission; it is also, conveniently, your marketing copy.
- **🚨 "Your product cannot feature betting or gambling functionality."** This is stated as a condition of monetisation. **Diana's roadmap Phase 3.2 "Match betting / predictions" - virtual currency, wagers, balances, a "richest degenerate" leaderboard - is a direct policy violation and must not ship in a paid product.** See §6.4 for a replacement that keeps the social payoff.
- **One product per production key.** Meeps' `lol_match_pool` / `lol_precomputed_builds` / `draftgap_dataset` pipeline and Diana's pipeline are, on the face of it, two products drawing on Riot data. Consolidate to one pipeline under one registered product (§5.2).
- Also: no exposing players' historic Riot IDs; no ads inside Riot properties; no unfair-advantage automation.

### 3.2 Discord's monetisation policy

If you charge for Diana _as a Discord app_, Discord's Monetization Requirements policy (effective Oct 2024) requires you to offer the paid capability through Discord's Premium Apps at a price **no higher** than anywhere else - and Premium Apps carry a 15% (growth tier) or 30% platform fee plus processing.

**Design implication, and it's a big one: sell the client, not the bot.** Diana-on-Discord stays free forever. It is your distribution channel and it satisfies Riot's free-tier requirement at the same time. The paid product is Meeps - your own surface, your own billing, no platform cut, no policy dependency.

### 3.3 The Guilded lesson

Guilded was the best-funded, most feature-complete Discord alternative ever built: voice, video, text, calendars, tournament brackets, scheduling - explicitly aimed at competitive gaming communities. Roblox bought it for **$90 million** in 2021. It was **shut down on 19 December 2025**, its export tool has since been withdrawn, and its data is gone.

It did not die from missing features. It died because a friend group cannot unilaterally leave Discord - the switching cost is everyone else. Adding a login requirement made it worse.

**Therefore: do not ask anyone to leave Discord.** This is why the bridge in `discordBridge.js` is your most valuable asset. Meeps sits _beside_ Discord: bridged channels, backfilled history, identity mapping, edit/delete propagation. A group can adopt Meeps on Tuesday, keep every Discord friend, and decide over months whether they still need Discord. Nobody who tried to beat Discord head-on has survived. Nobody has seriously tried to _annex_ it.

**Position the bridge as a headline feature, not plumbing.** "Keep your Discord. We'll bring the messages with us."

---

## 4. Positioning

**Product statement.** _For friend groups who play ranked together, [product] is the desktop room you leave open all night: voice, chat, and a shared memory of every game your group has ever played together. It bridges to your existing Discord so nobody has to move, and unlike the trackers, it knows who was actually in the call._

**Who buys:** one person per squad. The one who already hosts the Minecraft server, pays for the TeamSpeak, set up the Discord in 2017. This person exists in essentially every group, has paid for group infrastructure before, and is your entire go-to-market.

**Who does not buy:** the solo climber (they have Blitz and Mobalytics for free) and the 5,000-member community (they have Discord, and you cannot moderate at that scale). Say no to both, loudly, in the marketing.

**The three-second pitch:** _"It's your group's Discord, that knows your Tuesday-night winrate drops off a cliff after game five."_

**Naming:** keep **Diana** as the free Discord bot - it has an identity, a roast voice, and Buy-Me-A-Coffee goodwill. **Meeps** becomes the paid client. Consider a shared umbrella later, but two names with two jobs is coherent: Diana is the funnel, Meeps is the product.

---

## 5. How they combine

### 5.1 The keystone change: from webhook to event bus

Today Diana serialises a `MessagePayload` - title, description, colour, fields, footer - POSTs it to `/api/diana-notify`, and Meeps writes it into a channel as **a message**. Meeps therefore has no structured knowledge of anything Diana knows. Every joint feature in §6.3 is blocked by exactly this.

**Required:** replace the message webhook with a **typed event contract**, and make it bidirectional.

```
                        ┌─────────────────────────────┐
                        │        DIANA CORE           │
   Riot API ───────────►│  plugin registry · cron     │
   (one key, one        │  scoring · rank tracking    │
    registered product) │                             │
                        │  emits typed EVENTS         │
                        └───────┬──────────────┬──────┘
                                │              │
              MessageAdapter    │              │  EventAdapter (new)
              (render as embed) │              │  (structured, typed)
                                ▼              ▼
                    ┌────────────────┐   ┌──────────────────────────┐
                    │    DISCORD     │   │          MEEPS           │
                    │  (free tier /  │   │  spaces · channels       │
                    │   acquisition) │   │  voice rooms · presence  │
                    └────────────────┘   │                          │
                                         │  stores events as ROWS   │
                                         │  match / rank / session  │
                                         └───────────┬──────────────┘
                                                     │
                                     presence events │ (voice join/leave,
                                                     │  in-game, champ select)
                                                     ▼
                                         ┌──────────────────────────┐
                                         │  SESSION SERVICE (new)   │
                                         │  joins voice presence ×  │
                                         │  match outcomes          │
                                         │  → the features nobody   │
                                         │    else can build        │
                                         └──────────────────────────┘
```

Diana's own roadmap already flags the enabler ("consider a `postType` discriminator field early") under conventions for implementers. Promote it from a note to a P0 blocker: it is the seam the whole product hangs on.

Concretely, events like:

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
    | { type: 'game.started'; squadId; player; champion; queueId } // spectator / LCU
    | { type: 'streak'; squadId; player; kind: 'win' | 'loss'; length };
```

Meeps stores these, renders them itself (native cards, not embed-shaped text), and - critically - **posts presence events back**: `voice.joined`, `voice.left`, `client.in_champ_select`, `client.in_game`. Diana's session service consumes both sides.

Note the constraint Diana's roadmap correctly identifies: images and interactive components on the _notification_ path are a cross-service contract change. The event bus resolves this properly - Meeps receives data and renders natively, so it can show graphs and cards without Diana ever serialising a binary.

### 5.2 Consolidate the Riot pipeline

Meeps currently maintains `lol_match_pool`, `lol_precomputed_builds` and `draftgap_dataset`; Diana maintains `match_details`, `match_scores`, `rank_tracking`. Two pipelines, two sets of Riot calls, one-product-per-key policy problem, and two places to fix a patch-day breakage.

**Decision: all Riot ingestion moves behind Diana.** Meeps' build/meta work becomes a Diana plugin (`diana-builds`) exposing its precomputed builds over the event bus and API. Meeps keeps the _presentation_ of builds, loses the _ingestion_. This also gives the build data something no competitor's build data has - see Squad Draft (§6.3.4).

### 5.3 Unify identity

Right now: Meeps has `users.discord_user_id`, `users.league_username` (a free-text string!), `valorant_links.riot_puuid`; Diana has `summoners` + `guild_summoners.added_by`. Nothing is authoritative.

One `identities` table: one person → many linked accounts (Riot PUUID per game, Discord ID, Meeps user). Linking verified properly - apply for Riot Sign On if you can get it; failing that use Orianna's profile-icon handshake (ask the user to set a specific icon, confirm via summoner-v4, ~2 calls). Delete `league_username` as a matching key; it is a correctness bug waiting to happen.

### 5.4 Squad as the portable scope

Diana scopes to Discord `guildId`. Meeps has no scope at all. Introduce **`squad_id`** as the shared primary scope, with a Discord guild _or_ a Meeps space as an attachment to it. This makes every leaderboard, digest and recap correct in both destinations, and fixes the `/iotw` cross-guild leak in the same pass.

---

## 6. Feature design

Effort notation follows Diana's existing convention: XS / S / M / L.

### 6.1 What Meeps must gain

These are not differentiators. They are the price of admission for a second customer.

| #        | Feature                                                                                                                                                 | Why                                                                                                                                      | Effort     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **MP-1** | **Spaces** - real multi-tenancy: `spaces`, `channels`, `memberships`, invite links; delete the hardcoded channel constants                              | You literally cannot sell to a second group without this. Highest-priority item in the document                                          | **L**      |
| **MP-2** | **Roles & moderation basics** - owner/admin/member, kick, ban, channel permissions                                                                      | Required the moment membership isn't "five people who trust each other"                                                                  | M          |
| **MP-3** | **SFU voice** (LiveKit or mediasoup) replacing mesh                                                                                                     | Mesh dies past ~6–8; a 5-stack plus two spectators already hits it. Voice quality is the single thing TeamSpeak refugees are choosing on | M–L        |
| **MP-4** | **Self-serve onboarding** - hosted signup, no `.env`, no VAPID generation, no migration step                                                            | Current setup requires a developer. Trackimo's pitch is literally "nothing to install"                                                   | M          |
| **MP-5** | **macOS build** (+ Linux)                                                                                                                               | Tauri makes this cheap; Windows-only halves the addressable group (one Mac user blocks group adoption)                                   | S–M        |
| **MP-6** | **Native event rendering** - match cards, LP graphs, session recaps as first-class UI, not chat messages                                                | The event bus is wasted if everything still lands as text. This is where Meeps stops looking like a Discord clone                        | M          |
| **MP-7** | **Consent & data surface** - per-user opt-in for activity logging and voice analytics, visible, revocable, exportable; per-space data export and delete | Ethical requirement, and a _marketing asset_ in a post-breach market. "Your data, your export, no ID scan" is a real pitch in 2026       | S–M        |
| **MP-8** | **Bridge productisation** - bridge setup as a guided flow rather than `DISCORD_CHANNEL_MAP` env parsing                                                 | Your best feature is currently configured through a comma-separated environment variable                                                 | M          |
| **MP-9** | Typed backend (incremental TS migration) + real test coverage                                                                                           | The event contract is shared with a 40-suite TS codebase. Asymmetry will cost you                                                        | M, ongoing |

### 6.2 What Diana must gain

| #        | Feature                                                                                                                                            | Why                                                                                                                                     | Effort            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **DN-1** | **Typed event bus + `EventAdapter`** alongside `MessageAdapter`                                                                                    | The keystone. Blocks everything in §6.3                                                                                                 | M                 |
| **DN-2** | **`squad_id` scope**, portable across Discord guild and Meeps space; fixes the `/iotw` cross-guild leak                                            | Correctness bug today, multi-tenancy blocker tomorrow                                                                                   | S–M               |
| **DN-3** | **Riot account linking** (RSO if granted, icon handshake otherwise) + per-player privacy opt-out                                                   | Prerequisite for real identity, auto roles, and honest consent. Roadmap has this at Phase 4 - it needs to be Phase 1 for a paid product | M                 |
| **DN-4** | **Kill betting; ship Calls instead** (§6.4)                                                                                                        | Riot policy blocker                                                                                                                     | -                 |
| **DN-5** | **Presence ingestion** - accept `voice.*` and `client.*` events from Meeps                                                                         | Diana currently only pushes. Session features need the return path                                                                      | S                 |
| **DN-6** | **Session service** - sessionise matches + voice presence into a `sessions` table                                                                  | The engine behind §6.3.1–6.3.3                                                                                                          | M                 |
| **DN-7** | **Centralised rate limiter + cache** in front of `lolService`; plugin config to Postgres                                                           | Roadmap Phase 4 items that become urgent the moment paying customers share one key                                                      | M each            |
| **DN-8** | **Riot compliance package** - portal registration, Approved/Acknowledged status, transformativeness write-up, single-key consolidation             | Gate on charging money at all                                                                                                           | S (but lead time) |
| **DN-9** | Phase 0 of the existing roadmap (guild scoping, `/help` fix, Data Dragon unpinning, queue-name coverage, cron overlap guard, `notification_prefs`) | Already correctly specified; still correct                                                                                              | S total           |

### 6.3 The joint features - the reason to buy

Each of these is only possible at the intersection. For each I've noted **why a competitor can't copy it**, because that's the part that determines whether this is a product or a feature.

#### 6.3.1 Session Recap ⭐ _the flagship_

**What.** The atomic unit of a friend group's gaming life is not the match - it's the night. When the last person leaves voice, the space gets a Session Recap card: _"Tuesday 8:12pm – 1:40am · 5 hrs 28 min · 7 games · 3W-4L · five of you · Louis left after game 5 (you were 3-1) · best game: Aidan's Warwick, 1st place AI score · worst: everyone's, game 6 · longest voice silence: 4m12s during game 6."_

**Why it works.** It's the artifact of an experience people already value and currently have no record of. It's shareable, which makes it a distribution loop. And it's _funny_, which is the actual retention mechanism in a friend group - Diana already has the roast voice in `flavorLines.ts` and `/iotw`.

**Why nobody can copy it.** Requires voice presence timestamps joined to match outcomes. Trackimo has no voice. Discord bots can read voice-state events but have no match pipeline and no reason to build one. Companion apps have no concept of a group at all.

**Requires:** DN-1, DN-5, DN-6, MP-6. **Effort:** M. **Riot cost:** zero - entirely stored data.

#### 6.3.2 The Session Curve (a.k.a. Queue Curfew)

**What.** Per-squad analytics on _when_ the group plays well: win rate and average AI score by game number in the session, by session length, by hour of night, by roster composition, and - the one nothing else can compute - **by whether the player was in voice**. Surfaced as a chart plus one plain sentence: _"This squad's win rate is 58% for games 1–4 and 31% from game 5 on. Median session: 6 games."_ Optional opt-in nudge after the group's statistical cliff.

**Why it works.** This is the only genuinely actionable insight in ranked League that no tool provides. Every companion app tells you to build differently; none tells you to stop queuing, which is the higher-EV advice. It is _specific to you_, computed from your games, which is exactly what "transformative" means in Riot's policy language.

**Design ethic, non-negotiable:** informational, never moralising. Per-user opt-in for the voice dimension. Group-visible only with consent - "your winrate collapses after 11pm" is banter between friends and a weapon between acquaintances. Default the nudge off. Never gamify session length upward.

**Why nobody can copy it.** Same reason as above, plus: the incumbents' business model is engagement-funded ads. An ad-supported app cannot ship a feature that tells you to stop playing. **You can only build this because you charge money.** That is a genuinely defensible position, and it is worth saying out loud in marketing.

**Requires:** DN-6, MP-7. **Effort:** M. **Riot cost:** zero.

#### 6.3.3 Live squad presence & the champ-select room

**What.** The Meeps desktop client reads the local League client (LCU) so the space shows, live: who's in queue, who's in champ select and on what, who's in game. Then: auto-join voice on queue accept; a champ-select panel showing each squadmate's lock-in, their history on that champion _from your group's own data_, and the recommended build from the consolidated pipeline; the voice room's accent theming shifting to the locked champion (you already extract accent colours from character art).

**Why it works.** It closes the loop between "we're hanging out" and "we're playing." It's also the feature that makes the desktop client worth installing versus a website - your answer to Trackimo's "nothing to install."

**Risks, stated plainly.** LCU is undocumented and unofficial; Riot tolerates it (every companion app uses it) but it can break on any patch. Riot's Streamer Mode already restricts some live scouting data. Do not automate any in-game action - that crosses Riot's unfair-advantage line. Keep the fallback: spectator-v5 polling, which Diana's roadmap already costs out (opt-in, 2–3 min cadence).

**Requires:** MP-3, MP-6, LCU integration in Tauri. **Effort:** L. **Riot cost:** low with LCU (local), N-per-tick with spectator fallback.

#### 6.3.4 Squad Draft

**What.** A draft/comp tool scoped to _your five_. Not "Xayah-Rakan wins 54% globally," but: given the champions **these five people have actually played in the last 90 days** (Diana has it), and **their real recorded duo and trio win rates together** (Diana's `duoStats.ts` already computes this from `participants` JSONB), and DraftGap's generic priors as a fallback where your sample is thin - here are comps that work _for you_, and here's the bot lane that keeps losing.

**Why it works.** Every draft tool in existence is generic. This is the flex-queue and Clash use case, and it is the only build/draft feature in the category that gets _better_ the longer you use the product - a retention flywheel and a switching cost.

**Why nobody can copy it.** Requires longitudinal group-scoped match history. Trackimo could theoretically build it and is the one competitor to watch here; they'd have to build the draft-data layer you already have in `draftgap_dataset` and `lol_precomputed_builds`.

**Requires:** §5.2 pipeline consolidation, DN-2. **Effort:** M–L. **Riot cost:** zero.

#### 6.3.5 Squad Wrapped

**What.** End-of-split recap card per squad: games, voice hours, most-played duo, best and worst game, the LP journey, the night you went 0-6 - plus, because Meeps owns the chat corpus, _the group's most-used word and most-reacted message_. Diana's roadmap has "Diana Wrapped" in the ideas bucket; the group version with voice and chat data is a strictly better product.

**Why it works.** Cheap (all stored data), and the single most shareable artifact you can produce. This is your organic acquisition channel: one person posts the card, four friends ask what it is.

**Requires:** DN-6, MP-6. **Effort:** M. **Riot cost:** zero.

#### 6.3.6 Presence-aware notification routing

**What.** Meeps knows whether you're in voice, in game, or away, and already has Web Push. So: suppress match-post pings while you're in a game, batch them, deliver the session recap when you leave voice, escalate a mention to push only if you're genuinely away.

**Small, but this is the texture of a product people pay for.** Discord cannot do this - it doesn't know you're in champ select.

**Requires:** DN-5, existing push infrastructure. **Effort:** S.

#### 6.3.7 Cross-game continuity

Diana's plugin architecture means the squad's identity persists across games: Apex already ships, Valorant is half-built in Meeps (`valorant_links`, `valorant_tracked_matches`), TFT is gated on Riot key access, Rust device control already exists. Overwolf and Tracker Network do multi-game **per individual**. Nobody does multi-game **per group**. Sessions, recaps and Wrapped are game-agnostic by construction - build them on the event schema, not on League specifics.

### 6.4 The betting replacement: **Calls**

Diana's roadmap identifies betting as Dorans' stickiest social feature, and it is. It is also prohibited: _"Your product cannot feature betting or gambling functionality"_ is a stated condition of Riot monetisation. Virtual currency does not obviously save you, and "richest degenerate leaderboard" is not the framing you want in a compliance review.

**Ship this instead.** When a game starts, the space opens a 3-minute **Calls** window. Members call outcomes - win/loss, "Aidan tops the AI score", "this goes over 35 minutes". No currency, no stake, no wager, no payout. Settlement produces **reputation only**: a rolling accuracy percentage and a "who called it" leaderboard.

You keep the entire social payoff (the banter is in _being right_, not in the fake money), you lose the policy risk, and you lose the engineering trap Diana's roadmap correctly flags as trap #1 - a ledger with idempotent settlement that double-pays under overlapping cron ticks. Accuracy stats are idempotent by nature.

**Requires:** live game detection (6.3.3), component interaction router (roadmap Enabler A). **Effort:** M.

---

## 7. Sequenced requirements

Three releases. The ordering principle: nothing that isn't required to charge money goes before something that is.

### R1 - "Sellable" (target: 8–10 weeks)

_Goal: a second group can pay you and successfully onboard without your help._

| ID   | Requirement            | Acceptance criteria                                                                                                                                   |
| ---- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| MP-1 | Spaces multi-tenancy   | Two independent squads coexist on one deployment with zero data bleed; channels created/renamed/deleted at runtime; invite link flow works end to end |
| MP-2 | Roles & moderation     | Owner can kick/ban; non-admins cannot alter space config; permissions enforced server-side, not just in UI                                            |
| MP-4 | Self-serve onboarding  | A non-technical buyer goes from landing page to talking in voice with a friend in under 10 minutes, no env vars, no CLI                               |
| MP-8 | Bridge as guided setup | Discord bridge configured through UI; channel mapping, identity linking and backfill all self-serve                                                   |
| MP-7 | Consent & data surface | Every user can see, revoke and export what's collected about them; activity logging and voice analytics both default **off**                          |
| MP-5 | macOS build            | Signed, notarised, auto-updating                                                                                                                      |
| DN-1 | Typed event bus        | `EventAdapter` ships alongside `MessageAdapter`; Discord output byte-identical to today (regression-tested); Meeps stores events as rows              |
| DN-2 | `squad_id` scope       | `/iotw`, `/leaderboard`, digests all correct across two guilds and two spaces; cross-guild leak closed with a test                                    |
| DN-3 | Riot account linking   | Verified link; per-player opt-out honoured by every leaderboard and digest                                                                            |
| DN-8 | Riot compliance        | Product registered, status Approved or Acknowledged, single production key, transformativeness statement written, free tier defined                   |
| DN-4 | Betting removed        | No wagering code path exists                                                                                                                          |
| DN-9 | Roadmap Phase 0        | As specified in `docs/diana-roadmap.md`                                                                                                               |

**Do not charge anyone before DN-8 completes.** Approval has lead time; start it in week one, in parallel with everything else.

### R2 - "Worth buying" (target: +8–10 weeks)

_Goal: the features that make the price obvious._

| ID         | Requirement                          | Notes                                                      |
| ---------- | ------------------------------------ | ---------------------------------------------------------- |
| DN-5, DN-6 | Presence ingestion + session service | The engine                                                 |
| **6.3.1**  | **Session Recap**                    | The flagship. If only one thing ships in R2, this          |
| MP-6       | Native event rendering               | Match cards, LP graphs, recap cards                        |
| MP-3       | SFU voice                            | Before you have groups larger than six                     |
| 6.3.6      | Presence-aware notifications         | Cheap, high-perception                                     |
| 6.3.5      | Squad Wrapped                        | Time to the next split boundary; ship it before, not after |
| -          | Roadmap Phase 1 + Enabler A          | Richer embeds, streaks, sparklines, component router       |

### R3 - "Defensible" (target: +12 weeks)

| ID    | Requirement                                     |
| ----- | ----------------------------------------------- |
| 6.3.2 | The Session Curve / Queue Curfew                |
| 6.3.3 | LCU presence + champ-select room                |
| §5.2  | Riot pipeline consolidation into `diana-builds` |
| 6.3.4 | Squad Draft                                     |
| 6.4   | Calls                                           |
| DN-7  | Rate limiter, cache, Postgres plugin config     |
| MP-9  | Backend typing and coverage                     |

---

## 8. Pricing & packaging

Constraints to satisfy simultaneously: Riot requires a free tier; Discord takes 15–30% if you sell inside it; friend groups pay **per group, not per seat**; one person always pays.

| Tier                    | Price                                                        | Contents                                                                                                                  |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **Diana** (Discord bot) | Free, forever                                                | Full tracking, leaderboards, digests, `/iotw`. Satisfies Riot's free-tier requirement. Acquisition channel. Never gated   |
| **Meeps Free**          | Free                                                         | One space, up to 3 members, voice, chat, Discord bridge, 30 days of history                                               |
| **Meeps Squad**         | **€6–8 / month per squad**, up to 8 members, annual discount | Everything: unlimited history, Session Recaps, Wrapped, the Session Curve, Squad Draft, champ-select room, priority voice |
| **Self-hosted**         | One-time ~€49–79, or free for non-commercial                 | Docker compose, your Postgres, your Railway. The technical buyer will not rent                                            |

**Why per-squad and not per-seat.** Per-seat pricing forces the payer to collect money from four friends, which is where group purchases die. One payer, flat price, everyone benefits: this is the TeamSpeak/Minecraft-server model that this exact demographic has been paying for since 2010. €7/month is one pint. It is also roughly what a Mobalytics premium subscription costs for one person - and you're pricing for five.

**Do not** offer a per-player "pro" tier. It re-centres the product on the individual, which puts you back in the ad-funded companion-app fight you cannot win.

---

## 9. Why sell them together

The weak version of this argument is "bundle two things, charge more." Don't make that argument; it's not true and buyers can smell it.

The real argument has four parts:

**1. Neither is sellable alone, for different reasons.** Meeps alone competes with Discord on features - the exact strategy that cost Roblox $90 million and ended in a sunset notice. Diana alone competes in a category where every competitor is free, users have never been trained to pay for a Discord bot, and Riot's own policy obliges you to keep a free tier. Separately they're two hobby projects. There is no price for either.

**2. The differentiated features are not additive - they are the join.** Session Recap, the Session Curve, Squad Draft, Wrapped and the champ-select room are not "Meeps features" or "Diana features." Each one requires voice presence data _and_ match data in the same database. Ship only Meeps and you have a Discord clone. Ship only Diana and you have Trackimo with extra steps. Ship both and you're the only product in the intersection cell of §2.3. **That's not a bundle; it's a product that happens to be in two repos.**

**3. They are already a system, and the code proves it.** `messageAdapter.ts` fans out to Discord and Meeps. `meepsAdapter.ts` speaks HTTP to `/api/diana-notify`. Meeps has a `user_type` for bots and a Diana bot user, an embed column built for Diana's cards, and per-user win/lose GIFs whose only purpose is decorating Diana's match posts. You didn't build two products that could be combined; you built one product across two repos and haven't named it yet.

**4. Distribution and monetisation want to be separate surfaces.** Free Diana in Discord is where strangers meet you - zero-friction, no install, and it inherits Discord's discovery. Paid Meeps is where they land - your billing, no platform cut, no Discord policy exposure. Selling them separately would mean either charging for a Discord bot (15–30% cut, policy risk, category resistance) or selling a chat client with no reason to exist. Together, one funds the other's acquisition.

**And the honest counter-argument, so you can answer it:** the combination has a real cost, which is that you now have to be good at two hard things - real-time voice infrastructure _and_ a rate-limited third-party data pipeline. Most small teams fail by trying to do both adequately instead of one excellently. Your mitigation is that voice is a buy, not a build (SFU, MP-3), and the data pipeline is already the more mature of your two codebases. **If you find yourself hand-rolling an SFU, you've lost the plot.**

---

## 10. What not to build

1. **Anything with a wager.** No currency, no balances, no payouts. Riot's monetisation conditions prohibit betting and gambling functionality outright. Calls (§6.4) delivers the same social payoff.
2. **Discord feature parity.** Threads, forums, stage channels, server discovery, emoji marketplaces. This is the Guilded death march. Your answer to "Discord has X" is "yes, and we bridge to Discord."
3. **Community-scale anything.** 1,000-member servers need moderation tooling, trust & safety, and abuse response you cannot staff. Cap spaces deliberately and say so as a feature.
4. **A solo-player companion overlay.** Porofessor, Blitz, Mobalytics, U.GG, iTero, Hexgate. Saturated, ad-funded, and the wrong unit of analysis. Every hour spent here is an hour not spent on the intersection.
5. **Two Riot pipelines.** One product per production key, and patch-day breakage twice over.
6. **Window-title activity logging as a headline feature.** You already built the right thing (three detail levels including `none`) - but in a market spooked by ID leaks, a feature that reads what window you have open needs to be opt-in, obviously scoped, and explained. Lead with LCU game presence, which is narrow and legible; keep window titles as an advanced opt-in.
7. **A mobile-first bet.** Your value is at the desk, at night, in voice. Mobile is for reading the recap the next morning; the PWA already covers that.

---

## 11. First 90 days

**Week 1.** Register the product on the Riot Developer Portal - everything downstream is gated on approval lead time. Write the transformativeness statement. Delete the betting design. Decide: one brand or two.

**Weeks 1–4.** MP-1 (Spaces) and DN-1 (event bus) in parallel - the two keystones. Both are architectural and both get harder every week you add features on top of the current shape.

**Weeks 4–8.** MP-2, MP-4, MP-8, DN-2, DN-3. Roadmap Phase 0 alongside (it's a few days total and several items are prerequisites).

**Weeks 8–10.** R1 hardening. Onboard **three friend groups who are not you** - this is the single most informative thing in the plan and the easiest to skip. Watch where onboarding breaks. Do not charge yet.

**Weeks 10–16.** DN-5, DN-6, then Session Recap. Ship it to the three pilot groups and watch whether they share the cards unprompted. If they don't, the flagship is wrong and you need to know in month four, not month twelve.

**Week 16+.** Pricing goes live once Riot status is Approved/Acknowledged.

---

## 12. What to validate before building R3

Five questions, in descending order of how much damage a wrong answer does:

1. **Do people share the Session Recap unprompted?** This is the load-bearing assumption for both retention and acquisition. Testable in R2 with three pilot groups and zero marketing spend.
2. **Will the payer pay while their friends are free-riding?** The per-squad model assumes yes (precedent: game servers, TeamSpeak). Test with a manual Stripe link before building billing.
3. **Does the bridge actually neutralise the switching cost,** or do groups bounce back to Discord within two weeks anyway? If the bridge doesn't hold them, the whole anti-Guilded strategy needs rethinking.
4. **Is the Session Curve insight _true_ for real groups,** and is it _interesting_ rather than obvious? Compute it retroactively from Diana's existing data on your own group before building any UI. If the curve is flat, the feature is dead - and it's the single best differentiator, so find out early.
5. **Can you get RSO?** It changes onboarding friction materially. Ask early; the fallback icon handshake works but costs you conversions.

---

## Appendix: source notes

- Riot developer policy: General Policies and per-game policy pages, developer.riotgames.com and support-developer.riotgames.com, as published July 2026. Monetisation conditions (registration + Approved/Acknowledged status, mandatory free tier, transformativeness, betting/gambling prohibition, one product per key) quoted from those pages.
- Discord monetisation: Premium Apps documentation and the Monetization Requirements policy effective 7 October 2024; platform fee structure per Discord's Creator Revenue FAQ.
- Discord age verification: announced 9 February 2026 for a March rollout, delayed to H2 2026 following backlash (TechCrunch, 24 Feb 2026). October 2025 third-party vendor breach affected ~70,000 users' ID documents.
- Competitor surge data: TechPowerUp and TechRadar coverage of the February 2026 "Discord alternative" search spike; TeamSpeak's own reporting of new-user surge and added hosting regions.
- Discord alternatives landscape: TechCrunch, 1 March 2026.
- Guilded: acquired by Roblox 2021 for $90m; shutdown announced 28 September 2025, service ended 19 December 2025; export tool withdrawn early 2026.
- League companion app landscape and 2026 user-sentiment data: iTero, buildzcrank and Hexgate comparison articles (March–June 2026), 1v9 companion-app roundup (May 2026).
- Trackimo.lol: product copy as published at trackimo.lol, July 2026.
- Diana's own competitor survey (Dorans, Rankup, Orianna, OP.GG bot, Zoe, In-House Queue) in `docs/diana-roadmap.md`, July 2026 - reused rather than duplicated here.

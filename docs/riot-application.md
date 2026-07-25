# Riot Developer Portal - Production Application (draft)

_Prepared July 2026 for the Diana production key application. Fills the registration form field by field; the App Notes at the end raise the gray areas Riot's own guidance asks applicants to surface. Tracks roadmap item **DN-8**._

**Before submitting, read §3 - there are four points where the product as currently shipped or planned conflicts with the policies on the registration page. All four are disclosed below rather than omitted.**

---

## 1. Form fields - ready to paste

### Product Name

```
Diana
```

### Product Game Focus

```
League of Legends
```

### Product URL

```
https://louissullivan4.github.io/diana/
```

> **Changed from the top.gg listing.** Riot requires a verification file at
> `<PRODUCT_URL>/riot.txt`, and top.gg does not allow hosting arbitrary files.
> The GitHub Pages site is served from `/docs` on `main`, so
> `docs/riot.txt` publishes to `https://louissullivan4.github.io/diana/riot.txt`.
>
> The trailing slash matters. Give Riot the directory URL, not `index.html` -
> `https://louissullivan4.github.io/diana/index.html` would make the verifier
> look for `…/index.html/riot.txt`.

### Product Group

> Not the Default Group if you intend to add other developers later - the portal does not allow adding developers to the Default Group. Create a named group now if there is any chance of a second maintainer.

### Are you organizing tournaments?

```
No
```

Diana does not create, organize, seed, bracket or administer tournaments, and does not use the Tournament API (the current key carries the tournament _stub_ only). The Tournament Policies do not apply to this product.

---

## 2. Product Description

> Riot rejects applications with incomplete descriptions, so this is deliberately thorough: what it is, who it serves, every API called and why, the companion client, and how player data is handled.

```
Diana is a free Discord bot that helps small groups of friends who play League of
Legends together keep a shared record of the games they play as a group. It is not
a solo-player companion app or an overlay: it is scoped to a friend group's private
Discord server, and everything it produces is about the group rather than about
individual players in isolation.

WHO IT IS FOR
The typical install is a private Discord server of three to eight friends who queue
together in the evenings. A member uses /add to start tracking a summoner in that
server. Diana then posts a summary when a tracked player finishes a match, tracks
their ranked progress over time, and answers on-demand questions about the group's
recent games.

WHAT IT DOES
- Match summaries. When a tracked player completes a match, Diana posts an embed to
  the server's configured channel: result, champion, queue, role, KDA, damage, CS,
  vision score, and the LP change for ranked games.
- Rank tracking. Promotions, demotions, new personal-best ranks and win/loss streaks
  are posted as they happen, built from a per-match rank history Diana stores itself.
- Group statistics. /summoner, /champion, /compare and /leaderboard answer questions
  about the group's own recent games - head-to-head comparisons, per-champion
  performance, duo win rates when two tracked players are in the same match, and
  weekly leaderboards for the players tracked in that server.
- A weekly digest. A Sunday post summarising the group's week: who climbed, who fell,
  who played most, and the best and worst games of the week.
- /livegame. An on-demand check of whether a tracked player is currently in a game,
  showing champions, teams and bans, so friends can spectate.
- A weekly free champion rotation post, off by default.
- A per-match performance score. Diana computes a score for each participant in a
  match from the match data Riot returns (kill participation, damage, vision, CS,
  objective contribution and related fields), used to highlight standout games within
  the group. This is a per-match descriptive score, not a persistent skill rating -
  see App Note 2.

APIS USED, AND WHY
- MATCH-V5 (/lol/match/v5/matches/by-puuid/{puuid}/ids): once per minute per tracked
  summoner, to detect that a new match has finished. This is the bulk of our usage.
- MATCH-V5 (/lol/match/v5/matches/{matchId}): once per newly completed match, to build
  the match summary and the group statistics above.
- MATCH-V5 (/lol/match/v5/matches/{matchId}/timeline): available in our client layer
  and used sparingly; reserved for per-match detail views.
- LEAGUE-V4 (entries by PUUID): on each completed ranked match, to record the player's
  new rank and compute the LP change shown in the post.
- ACCOUNT-V1 (by-riot-id, by-puuid, active-region): to resolve a Riot ID to a PUUID
  when a player is first added, to keep display names current, and to route requests
  to the correct regional host.
- SPECTATOR-V5 (active game by PUUID): only when a user runs /livegame. It is not
  polled on a schedule today.
- CHAMPION-V3 (champion rotations): at most once per week, for the optional rotation
  post.
- Data Dragon is used for champion names, icons and static assets.

We cache the current Data Dragon version for 24 hours and store completed match data
in our own Postgres database, so the great majority of Diana's features - leaderboards,
comparisons, digests, per-champion statistics - are computed entirely from data already
retrieved and require no additional API calls.

COMPANION DESKTOP CLIENT
Diana has a companion desktop and web application, Meeps, used by the same friend
groups for voice and text chat. Diana currently forwards its match and rank posts to
Meeps over a webhook so they appear alongside the group's conversation. We are
consolidating so that Diana is the only component that ever contacts the Riot API;
Meeps consumes Diana's already-retrieved data and never holds an API key. We are
registering these as one product for this reason - see App Note 4.

PLAYER DATA
Diana stores match data for tracked players and the other participants of those
matches, as returned by MATCH-V5. It does not store or expose any player's historic
Riot IDs, does not scrape any undocumented endpoint or third-party source, does not
connect to League chat or any other game system, and does not automate any in-game
action. Its Discord gateway intents are minimal (Guilds, GuildMessages only) - it
reads no message content and no member data. Removing a summoner with /remove stops
tracking them in that server.

ACCESS
Diana is free. Every feature described above is available to every member of any
server the bot is in, with no paid tier, no exclusive access and no advertising.
Our plans for the companion client are described in App Note 1.
```

---

## 3. App Notes - the gray areas, disclosed

> Riot's guidance on the registration page is explicit: _"If you have an idea that you think might fall within a gray area feel free ask us in your project's application… post your question as an App Note."_ Each of the following is a genuine conflict between the shipped or planned product and the policy text. Raising them now costs a slower approval; discovering them later costs the key.

### App Note 1 - Monetisation of the companion client

```
We would like to check our understanding before building anything that charges money.

Diana, the Discord bot described above, is free and we intend to keep it free
permanently, with no gated features.

Our companion desktop client, Meeps, is a voice and chat application for the same
friend groups. We are considering a paid subscription for Meeps - roughly EUR 6-8 per
month per group, not per player - which would include group-level features built on
data Diana has already retrieved: a recap of a play session once everyone leaves the
voice call, per-group analytics about when the group performs well, and an
end-of-split summary for the group.

We understand from the General Policies that monetisation is permitted where the
product is registered and Approved or Acknowledged, a free tier is available to
players, the paid content is transformative, there is no betting or gambling, and
the pricing is not exploitative. We also understand from the API Terms that charging
for access requires Riot's prior written approval. We are asking for that approval
here rather than assuming it.

Our transformativeness argument: none of the paid features present Riot match data as
retrieved. They join it to information Riot does not have and we do - who was in a
voice call together, for how long, and in what order they left - to produce insights
that do not exist in any Riot surface or any competing product. For example, whether
a group's win rate declines after a certain number of consecutive games, or how a
specific pair of friends performs when queuing together versus apart. The value is in
the analysis of the group's own history, not in redisplaying match history.

Two specific questions:
1. Is this an acceptable monetisation model, given the bot itself remains free?
2. If so, what is the correct process for obtaining the prior written approval the
   API Terms require, and should it happen before or after this product reaches
   Approved status?

We will not charge anyone until we have an explicit answer.
```

### App Note 2 - Performance scoring, and whether it reads as a ranking alternative

```
We want to be sure our per-match score is not an alternative to your ranking systems.

Diana computes a score for each participant in a completed match from the fields
MATCH-V5 returns - kill participation, damage, vision score, CS, objective
contribution and similar. Within a single match we also order the ten participants by
that score, so a player can see that their game was, for example, the strongest in
that lobby.

What it is not: it is not persistent, it does not accumulate across matches into a
rating, it does not attempt to estimate MMR or ELO, it makes no prediction about
matchmaking or future outcomes, and it is never presented as a measure of a player's
skill. It describes one game that has already been played.

Where we are less certain: two commands (/mvp and /iotw) aggregate the average of that
score across a player's matches in the last seven days, for the players tracked in a
single Discord server, and present that as a weekly leaderboard. We can see an
argument that a rolling average presented as a leaderboard begins to resemble a
rating, even though it is scoped to one small private group and resets weekly.

Is the per-match score acceptable, and is the seven-day aggregate acceptable? If the
aggregate is the problem, we would rather remove or restructure it now than find out
later.
```

### App Note 3 - Negative performance framing

```
We are disclosing this because we think it may conflict with the policy, and we would
rather be told to change it.

The registration page states that we must not "shame players based on any metric
including their recent performance" and that assumptions leading to negative
preconceptions of a player are not allowed.

Diana has a command, /iotw ("Inter of the Week"), that identifies the tracked player
with the lowest average per-match score over the past seven days, in a light-hearted
register. Diana also attaches a short generated comment to some match posts; most are
positive (multikills, deathless games, high damage, best score in the lobby), but a
few are gently self-deprecating about weak games - low kill participation, low vision
score, or a high count of "enemy missing" pings.

The context: this only ever runs inside a private Discord server of friends who play
together and who added each other to be tracked. It is not public, it is never shown
to strangers, it does not aggregate across servers, and the tone is the banter those
groups already exchange in voice chat. We also ship /mvp, the positive counterpart,
which crowns the highest average score.

We recognise that "these people are friends" is our assertion rather than something
the product can verify, and that a player added by a friend has not personally
consented. Our questions:

1. Does the private, group-scoped, opt-in context change your assessment, or is any
   negative performance framing prohibited regardless of scope?
2. If it is prohibited regardless: is the acceptable line "no negative framing at
   all" (we would remove /iotw and the negative comments and keep only /mvp and
   positive callouts), or would a per-player opt-in be sufficient?

We are willing to change or remove this feature. We would prefer to do it because you
told us to rather than discover it during a review.
```

### App Note 4 - One product, and consolidating a second data pipeline

```
Disclosing this proactively because of the one-product-per-production-key rule.

Our companion client, Meeps, historically maintained its own small League data
pipeline for champion build and draft information, separate from Diana's. We are
aware that two pipelines drawing on Riot data could reasonably be read as two
products, and that a production key may only serve one.

Our plan, which is on our roadmap and which we would carry out before or alongside
this approval: retire that second pipeline entirely and move all Riot API access
behind Diana. Meeps would then hold no API key and make no Riot API calls; it would
consume only data Diana has already retrieved. There would be exactly one key, one
pipeline and one registered product.

Is registering Diana and its companion client as a single product the correct
approach here, or would you prefer separate applications? If a single product, is
there anything further we should do to demonstrate the consolidation?
```

### App Note 5 - Reading the local League client (planned, not shipped)

```
Asking before we build this, not after.

We are considering having the Meeps desktop client read the local League client
(the LCU) so that a friend group's chat room can show who is in queue, who is in
champion select, and who is in a game - so the group knows when to get in voice
together. We would use it only for that presence signal.

We are aware that the policy prohibits scraping undocumented endpoints or sources
outside the documented Riot API and Third Party Developer Tools, and that the LCU is
not a documented endpoint, even though many companion applications read it. We would
not automate any in-game action, would not modify the client, would not read or
transmit anything beyond a coarse presence state, and would make the feature opt-in.

Is reading the local client for presence acceptable? If it is not, we will use
SPECTATOR-V5 polling instead, at a conservative cadence and only for players in
groups that have opted in - but we would rather ask than assume the tolerance we see
elsewhere applies to us.
```

### App Note 6 - A prediction feature with no currency and no stakes

```
Checking this against the betting and gambling prohibition before we build it.

We would like to let members of a group call the outcome of a game their friends are
about to play - win or lose, or whether a particular player will have the strongest
game. When the match finishes, we would record whether each person called it
correctly and show a running accuracy percentage.

There is no currency of any kind, real or virtual. There are no stakes, no balances,
no entry, no payout, and nothing to win or lose. The only outcome is a percentage
showing how often someone was right.

We designed it this way specifically to stay clear of the prohibition on betting and
gambling functionality. Is a stake-free, currency-free prediction feature of this kind
acceptable, or does calling a match outcome fall on the wrong side of the line
regardless of the absence of stakes?
```

---

## 4. Checklist before you submit

| #   | Item                                                                      | Status                                                                                      |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | API key is not committed, not client-side, not in the public repo         | 🚨 **FAILS - fix before submitting. See §4.1**                                              |
| 2   | No Riot logos used anywhere in Diana, Meeps, top.gg listing, or marketing | **Verify.** Champion art and assets are permitted; official logos are not                   |
| 3   | No claim of Riot partnership or approval in any surface                   | **Verify** the top.gg listing and any README                                                |
| 4   | Meeps does not visually imitate the League client or Riot branding        | **Verify.** Accent colours drawn from champion art are fine; client-lookalike chrome is not |
| 5   | Nothing charges money today                                               | ✅ Correct today. Keep it that way until App Note 1 is answered                             |
| 6   | No betting, wagering, virtual currency or balances exist in code          | ✅ Verified - no such code has ever been written                                            |
| 7   | Not using a Development or Interim key for the live bot                   | **Verify** which key the production deployment currently uses                               |
| 8   | Second Riot pipeline in Meeps retired, or a dated plan to retire it       | **In progress** - roadmap §5.4 / §8.6                                                       |
| 9   | Product URL is live and describes the product accurately                  | ✅ `docs/index.html` added, matching the description above                                  |
| 10  | Privacy policy and terms are reachable from the product URL               | ✅ Linked from `index.html`; both already published via Pages                               |
| 11  | `riot.txt` reachable at `<PRODUCT_URL>/riot.txt`                          | **Verify after push.** See §4.2                                                             |
| 12  | No internal planning docs served from the product URL                     | ✅ `docs/_config.yml` excludes them. See §4.2                                               |

### 4.1 🚨 Two Riot API keys are in this repository's public git history

The registration page lists _"Publish a project that doesn't properly secure your API key"_ under **Please Don't**. The repository at `github.com/louissullivan4/diana` is public, and two keys were committed in `.env` files and are still retrievable from history:

| Commit                                      | Key                                                |
| ------------------------------------------- | -------------------------------------------------- |
| `949582c` "Summoner and Match ids complete" | `RGAPI-bbeff4bc-…` (added)                         |
| `ee41c37` "Delete"                          | `RGAPI-a02f6a96-…` (removed from the working tree) |

Deleting a file does not remove it from git history. Both keys remain readable by anyone who clones the repo, and a reviewer checking the public repo may well find them.

**Almost certainly low actual risk:** the `RGAPI-` + UUID format is the _development_ key format, and development keys expire every 24 hours, so both are long dead. `.env` is correctly gitignored now (`.gitignore:9`), the key is read only from `process.env` server-side (`lolServiceFactory.ts:10`), and `.env.example` carries a placeholder rather than a real value. The current setup is correct - this is historical residue.

**Do before submitting, in order:**

1. **Confirm both keys are dead.** If either was ever a _production_ key rather than a development key, rotate it in the portal immediately - that changes this from housekeeping to an incident.
2. **Decide on history.** Purging with `git filter-repo` or BFG removes the keys but rewrites every commit hash, which breaks existing clones and forks. For two expired development keys that is often not worth it - but it is your call, and it is cheaper to do now than after the repo has more contributors.
3. **Either way, be ready to answer it.** If you leave the history, the honest position is straightforward: expired development keys from early prototyping, never a production key, current handling is environment-only. Consider saying so in an App Note pre-emptively rather than being asked.

### 4.2 Verifying the URL - order of operations

Riot's verifier fetches `<PRODUCT_URL>/riot.txt` and expects that file to contain the code and nothing else. The site is GitHub Pages serving `/docs` from `main`.

**Before clicking "Verify URL":**

1. **Push these files to `main`.** `docs/riot.txt`, `docs/index.html`, `docs/_config.yml`.
2. **Confirm Pages settings** - repo Settings → Pages → Source must be **Deploy from a branch**, branch `main`, folder `/docs`. That is how `docs/privacy.html` already reaches `louissullivan4.github.io/diana/privacy.html`, so this should already be correct.
3. **Wait for the Pages build** to finish (Actions tab, "pages build and deployment"). It takes a minute or two; the file 404s until it completes.
4. **Fetch it yourself first:**

    ```
    curl -i https://louissullivan4.github.io/diana/riot.txt
    ```

    Expect `200` and exactly `32995056-dd10-4184-890b-e3955fe4b89e`. If you get a 404, Pages has not rebuilt or the source folder is wrong. **Do not click Verify until this returns 200** - a failed verification is a wasted round trip.

5. Only then click **Verify URL**.

**Why `_config.yml` matters.** Pages serves everything in `/docs`, and Jekyll copies `.md` files through verbatim when they lack front matter. Without the exclude list, `new-design.md` (full commercial strategy and pricing), `roadmap.md`, and `riot-application.md` - this file, including §4.1's record of the leaked keys - would all be publicly readable at the exact URL you are handing to Riot for review. The config publishes only `index.html`, `privacy.html`, `terms.html` and `riot.txt`.

**If you add another internal document to `/docs`, add it to the exclude list.** A stronger long-term fix is to move planning docs out of `/docs` entirely so the published directory contains only the site.

## 5. What to expect

Approval is not instant, and Notes 1, 3 and 5 are the ones most likely to draw a
response rather than a rubber stamp. That is the intended outcome: roadmap item
**DN-8** gates all charging on this approval, and Note 3 in particular may require a
change to shipped behaviour (`/iotw` and the negative flavor rules in
`flavorLines.ts` - `heavy-inting`, `wooden-spoon`, `kp-tourist`, `vision-blind`,
`ping-committee`).

Plan for that outcome now: if Riot rules against negative framing, `/mvp` already
exists as the positive counterpart, and the roadmap's Session Recap and Squad Wrapped
features should be specified positive-only from the start rather than retrofitted.

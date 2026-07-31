# Squad Wrapped — design

**Roadmap:** §7.2 · **Issue:** #161 · **Release:** R2 · **Migrations:** none

The last R2 item on Diana's side. DN-5, DN-6 and Session Recap have shipped on
both sides, and Meeps' MP-06/MP-10 closed the rendering half, so the remaining
R2 work is this and #162 — and #162 is a Meeps feature waiting on an R3 Diana
event (`game.started`, §8.2), which leaves this one.

The issue's own urgency is a deadline: _"Ship before the next split boundary,
not after. A wrapped card that arrives three weeks late is worth a fraction of
one that lands the day the split ends."_

---

## 1. What it is

An end-of-period card per squad: games, record, voice hours, the most-played
duo, the most-picked champion, best and worst game, the LP journey, and the
night that went 0-6. Meeps adds the group's most-used word and most-reacted
message from its own chat corpus, and draws the card.

Rate cost is zero. Every figure comes from data already in Postgres.

---

## 2. The four decisions

### 2.1 A query, not an event

Session Recap is a `DianaEvent` because a night ending is something that
happens and nobody asked for it. A Wrapped is something somebody asks for, and —
decisively — **the card is assembled from two sources**: Diana's figures plus
Meeps' chat corpus, which Diana cannot see.

Pushing would mean Meeps receiving half a card at a moment of Diana's choosing
and holding it until it could join its own half. Pulling means it assembles the
card at render time, when it has both halves. DN-3's `GET /api/identity/resolve`
is a route rather than an event for the same reason, so the precedent is already
in the tree.

Two consequences worth stating: the `DianaEvent` union does not grow, and
**there is no migration** — so there is no deploy race of the kind DN-3 had,
where the app can boot before its migration applies.

§13.4's convention is satisfied either way: a variant needing a Meeps row shape
and an idempotency key is one that gets _delivered_, and this one gets _fetched_.

### 2.2 No split calendar

The feature is described as an end-of-split recap, and the obvious
implementation is a table of split boundaries. There is no way to keep one
honest. Riot publishes no endpoint for split dates — `match-v5` carries
`gameVersion`, which is a patch, and `league-v4` carries a tier, which is a
standing. A hand-maintained table needs a deploy every time Riot moves a date
and silently produces wrong windows for every self-hoster on an older version.
A card that quietly covers the wrong three months is worse than one that says
what it covers.

So the period is **data, not code**. The API takes an explicit `[from, to)`,
which is the escape hatch for an operator who does know the dates, and the
presets are the ones derivable from a calendar alone:

| Key     | Window                   | Label          |
| ------- | ------------------------ | -------------- |
| `split` | last 90 days _(default)_ | `Last 90 days` |
| `month` | calendar month to date   | `July 2026`    |
| `year`  | calendar year to date    | `2026`         |
| `all`   | from the epoch           | `All time`     |

`split` is named for what a player will look for and labelled for what it
actually is. `month` and `year` are calendar-to-date rather than rolling: a card
saying "July 2026" that covered 14 June to 14 July would be a lie in the one
place a reader is most likely to check it.

### 2.3 One roster read, computed in memory

`duoStats.getDuoRecord` answers the duo question for `/compare` with one
JSONB-containment query per pair. That is right there and wrong here: every pair
on the roster is O(n²) queries — 105 for a fifteen-player squad — each scanning
`match_details` over ninety days rather than `/compare`'s seven.

Instead the service reads the squad's matches once, projecting each down to
seven fields per squad member inside the query, and every pairing, champion
count and per-player total is computed from that one result in `pairings.ts`.
The projection is what makes it affordable: `participants` is the ~100-metric
blob for ten players, so shipping it whole for a ninety-day window is tens of
megabytes for seven fields.

The CTE deduplicates before the projection unpacks. `match_details` is unique on
`(matchId, entryPlayerPuuid)`, so a game five tracked players were in is five
rows; unpacking first would produce twenty-five member entries for five people.

Being pure also means the tie-breaks are testable without a database, which is
the split `sessionise`/`sessionService` and `recapService`/`recapSweep` already
made.

### 2.4 Distinct matches, not player-games

`computeWeeklyDigestStats` sums `matchesPlayed` across players, so a five-stack
game counts five times. That is defensible on a leaderboard, where the figure
sits beside per-player rows, and indefensible on a card that tells a group of
five they played 412 games when they played 96. Wrapped counts distinct matches.

A match counts as a win only when every squad member in it agrees, exactly as
`sessionService.resolveWin` decides it for a night. So `wins + losses` can be
less than `totalGames`, and the embed states the record rather than implying it.

---

## 3. Privacy (DN-3)

DN-3's lesson was that there were three read paths and filtering only the
obvious one left an opted-out player named as the week's best game. Wrapped adds
five reads and **every one of them names people**, so every one filters.

| Read            | Feeds                               | Filter                                            |
| --------------- | ----------------------------------- | ------------------------------------------------- |
| roster          | record, duos, champions, per-player | `getHiddenPuuids`, in TypeScript — see below      |
| scores          | best game, worst game, avg AI score | `notHiddenPredicate` in SQL                       |
| names           | display names                       | only reached for puuids the above already cleared |
| nights          | voice totals, worst night           | not person-shaped                                 |
| voice-by-person | the voice ranking                   | `notHiddenMeepsUserPredicate` in SQL              |

**Why the roster read filters in TypeScript.** It is the one read whose _match
count_ must survive a hidden participant: dropping the match would make the
headline figure wrong, and "drop the member but keep the match" is not something
a WHERE clause on the match can express. The filtering still happens before any
ranking, which is the property `recapService` was careful about — filter after
picking a winner and one person's privacy choice becomes a missing line for
everyone.

**Voice is the interesting one, and it is new.** Privacy is keyed on the puuid,
deliberately: you must not have to identify yourself in order to become
invisible (§6.1). But voice time is keyed on `meeps_user_id`, because
`session_participants` has to hold the friend who was in the call all night
without playing. So a voice-hours ranking has a puuid-shaped rule and a
Meeps-shaped column, and the only thing joining them is `identity_accounts`.

`notHiddenMeepsUserPredicate` is that join, and this is the **first internal
reader of the identity table** — until now it only served Meeps over HTTP. A
Meeps user with no linked Riot account matches nothing and stays visible, which
is correct: they never opted out of anything.

The squad total still includes a hidden player's voice time. Opting out means
not being named in a ranking, not being erased from the evening.

---

## 4. Shape

```
core/wrapped/
  wrappedPeriod.ts   pure   window resolution, presets, explicit ranges
  pairings.ts        pure   record, duos, champions, per-player totals
  wrappedTypes.ts           the card's shape
  wrappedService.ts         the five reads + orchestration
core/api/wrappedApi.ts      GET /api/squads/:squadId/wrapped
```

Two callers, one handler. Meeps is a server with a shared secret; the dashboard
is a browser with a JWT. `meepsSecretOrSkip` — built for DN-2's `by-attachment`
route — already solves this: a request with no `x-meeps-secret` is handed on
with `next('router')` to the authenticated router mounted after it. So the
handler is registered on both routers and neither caller knows about the other.

Discord's `/wrapped` does not go through HTTP at all. It calls
`computeSquadWrapped` directly, the way the digest cron calls
`computeWeeklyDigestStats` directly: a request from a process to itself is a
failure mode, not an abstraction.

**`/wrapped` exists deliberately, not as a consolation.** Discord is the
acquisition channel (§4.2) and the entire acquisition story for Wrapped is "one
person posts the card, four friends ask what it is". A card nobody outside the
paid client can post cannot start that.

---

## 5. Best names a person, worst names a game

`WrappedWorstGame` carries a match id and a mean, and no name at all —
the same asymmetry as `SessionLowPoint`, and for the same reason. A digest ranks
individuals across a week and being named is the point of a leaderboard. A card
the whole group posts and re-reads is a meaner artifact if it names one of them
as the worst. The worst game is the lowest mean squad score, so it names a game.

`WeeklyDigestStats.worstGame` still names a person, deliberately and for a
different surface.

---

## 6. Out of scope, with reasons

- **A scheduled boundary emission.** Nothing fires a Wrapped on a date. That
  needs the calendar §2.2 refuses to invent; the on-demand path is also the
  better acquisition loop, since a person choosing to post the card _is_ the
  loop. Revisit if Riot ever publishes split dates.
- **Flex queue in the LP journey.** Solo only. Two ladders on one line make
  "biggest climb" ambiguous, and solo is the one a group argues about.
- **Trios.** `computePairings` generalises, but the issue asks for a duo and
  three-name lines read badly on a card.
- **The chat-corpus half.** Most-used word and most-reacted message are Meeps'
  data and Meeps' PR.
- **Squad-level caching.** A ninety-day window is one projected scan plus four
  small reads. Revisit if `/wrapped` ever becomes hot; `DN-7a` is where a cache
  belongs anyway.

---

## 7. The Meeps side

Not required for this to ship — `/wrapped` works standalone — but required for
the card the roadmap actually describes. Meeps needs to:

1. call `GET /api/squads/:squadId/wrapped` through `dianaClient.js`, which
   already holds the base URL and the shared secret for `dianaPresence` and
   `dianaSquads`;
2. compute its own half from `messages` and `message_reactions`;
3. render, reusing MP-06's card components.

Worth noting separately: **MP-05 is now unblocked** and is the higher-value
Meeps PR. It is the last R1 blocker on that side and it is what makes the
recap's cross-reference work — knowing that the person who left after game 5 is
the person who played Warwick. DN-3 shipped the endpoint; nothing in Meeps calls
it yet.

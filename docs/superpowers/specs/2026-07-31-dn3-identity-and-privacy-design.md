# DN-3: verified account linking and per-player privacy

_31 July 2026 · roadmap §5.3, §6 R1 · issue #142_

## Why now

DN-3 is the last R1 code item. DN-1, DN-2, DN-5, DN-6 and DN-8 are closed;
Session Recap shipped on both sides. Everything else outstanding is R2 or R3,
and the roadmap's sequencing rule is that nothing which isn't required to charge
money goes before something that is.

Its acceptance criterion is one line: _"Verified link; opt-out honoured by every
leaderboard, digest and recap."_ That is two independent features sharing an ID,
and they are built and shipped separately here — see **Two branches** below.

## What this unblocks

Identity is the join between the two halves of the product. Diana knows puuids;
Meeps knows its own users. Nothing currently connects them, which is why:

- **Session Recap** can say "Louis left after game 5" and "best game: Aidan's
  Warwick" but cannot say they are the same person (roadmap §7.1, correction 2).
- **The Session Curve** cannot compute its one uncopyable dimension — win rate
  _by whether the player was in voice_ (§8.1). That needs `presence_events` and
  `match_scores` joined on a person, and the join column does not exist.
- **Squad Wrapped** cannot attribute voice hours to the player who played.
- **Auto rank roles** (§10, parked) needs a verified Discord ↔ Riot link.

## Two branches, merged in order

**1. `feat/dn-3-privacy-opt-out`.** Per-player opt-out, keyed on puuid.
**2. `feat/dn-3-identity-linking`.** `identities`, verification, `/link`.

Privacy goes first, and not only because it is smaller. Keying opt-out on the
identity would mean **you must identify yourself before you can become
invisible**, which is a bad privacy story and a worse one to defend in a Riot
compliance review. Keyed on puuid it works with zero identity data, so the
feature that protects people does not wait on the feature that names them.

Branch 2 then makes it ergonomic rather than possible: with accounts linked,
one `/privacy` call covers all of them.

---

# Part 1 — Privacy opt-out

## What is being hidden, and from what

Opting out removes a player from **rankings and group summaries** — surfaces
where they appear alongside other people without having asked to. It does not
remove them from **direct lookups**, where somebody typed their name, and it
does not stop their own match posts. That is the line issue #145 drew ("excluded
from all aggregate surfaces but still get their own match posts") and the
behaviour Orianna's privacy dashboard has trained people to expect.

| Surface                        | Opted-out player |
| ------------------------------ | ---------------- |
| `/leaderboard`                 | hidden           |
| `/iotw`                        | hidden           |
| `/mvp`                         | hidden           |
| Weekly digest                  | hidden           |
| Session Recap best/worst game  | hidden           |
| `/summoner <name>`             | **shown**        |
| `/compare <a> <b>`             | **shown**        |
| Their own match-completed post | **shown**        |

## The invariant this rests on

`getInterCandidatesSince` is the single choke point for `/iotw`, `/mvp`,
`/leaderboard`, `/compare`, `/summoner` **and** the weekly digest. One filter
there covers six surfaces.

The two halves of the table above are already distinguishable in the code, and
not by accident: **every ranking surface omits `targetPuuid`, and every direct
lookup sets it.** `/summoner` passes `targetPuuid: puuid`; `/compare` passes it
twice, once per player; `/leaderboard`, `/iotw`, `/mvp` and the digest pass
none. That is what `targetPuuid` means — "the caller named this person".

So the rule is: **filter when `targetPuuid` is absent.** It is expressed as an
explicit `respectPrivacy` option defaulting to `true` rather than left implicit,
because a future ranking surface that happens to pass a `targetPuuid` would
otherwise silently leak an opted-out player.

Session Recap needs its own filter — it does not go through `interStats` — in
`getSessionScores`, which is the only place recap standouts are chosen.

## Schema

Migration `018_summoner_privacy.sql`:

```sql
CREATE TABLE "summoner_privacy" (
    "puuid"       VARCHAR(200) PRIMARY KEY REFERENCES "summoners" ("puuid") ON DELETE CASCADE,
    "hidden"      BOOLEAN NOT NULL DEFAULT FALSE,
    "set_by"      VARCHAR(30),
    "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Its own table rather than a column on `summoners` because `summoners` is the
Riot mirror — every column on it is something Riot told us, refreshed by the
poller. A privacy choice is the opposite: it is the one thing on that row the
player said and Riot did not, and it must survive any refresh, re-add or
backfill that rewrites the mirror.

**Global, not per squad.** `presence_consent` is per squad, and deliberately so:
being happy for your Tuesday group to know when you were in voice does not mean
being happy for another. Leaderboard visibility is not like that. It is a stance
about being ranked in public at all, and a person who wants out of one squad's
leaderboard almost never wants to stay in another's. Per-squad is a strictly
larger table and a strictly worse default; it can be added later without moving
this one, because a per-squad row would override rather than replace.

**Absence means visible.** The opposite of `presence_consent`, and the
difference is that collection is opt-in while display is opt-out. Voice presence
is data we would otherwise not hold; leaderboard placement is data we already
hold and are choosing how to show. Making rankings opt-in would empty every
leaderboard in production on deploy.

## Components

| Unit                             | Does                                                                |
| -------------------------------- | ------------------------------------------------------------------- |
| `core/privacy/privacyService.ts` | `isHidden`, `setHidden`, `getHiddenPuuids`, `getPrivacy`            |
| `interStats.ts`                  | `respectPrivacy` option; `NOT EXISTS` filter in the aggregate query |
| `sessions/recapService.ts`       | same filter in `getSessionScores`                                   |
| `/privacy` command               | `show` / `hide` / `status`, ephemeral                               |
| `core/api/privacyApi.ts`         | read and write, for the dashboard and Meeps' consent surface        |

## Error handling

The filter is a SQL `NOT EXISTS` against a table that may be empty in every
deployment for weeks. It costs one index probe per aggregate row and cannot
fail independently of the query it is part of — there is no partial state where
privacy is applied to some rows and not others.

The failure mode that matters is the opposite one: a **new** aggregate surface
added later that forgets the filter. Mitigated by the default (`respectPrivacy`
is true unless a caller opts out) and by a test asserting the default.

## Testing

- `privacyService`: set, unset, read, absent-means-visible.
- `interStats`: opted-out player absent from an aggregate; present when
  `targetPuuid` names them; present when `respectPrivacy: false`.
- `recapService`: opted-out player never chosen as best or worst game.
- Regression: the `/summoner` and `/compare` call sites still return the player.

---

# Part 2 — Identity and verification

## Shape

Two tables, mirroring `squads` / `squad_attachments` — a bare identity plus
`(kind, external_id)` attachments — because that shape has already proved itself
for exactly this problem and the resolution query is the same one.

Migration `019_identities.sql`:

```sql
CREATE TABLE "identities" (
    "identity_id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "identity_accounts" (
    "kind"        VARCHAR(20) NOT NULL,   -- riot_puuid | discord_user | meeps_user
    "external_id" VARCHAR(200) NOT NULL,
    "identity_id" UUID NOT NULL REFERENCES "identities" ON DELETE CASCADE,
    "verified_at" TIMESTAMPTZ,
    "method"      VARCHAR(20),            -- icon_handshake | trusted | rso
    "linked_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("kind", "external_id")
);
```

`PRIMARY KEY (kind, external_id)` is the load-bearing constraint, as it was for
`squad_attachments`: one Riot account belongs to exactly one person, so
`puuid → identity` is total and single-valued and no read path has to decide
what an account linked to two people means.

`verified_at` is nullable and `method` records how. An unverified link is a real
and useful state — a friend group that trusts each other should not have to do a
handshake — but it must be distinguishable, because auto rank roles and anything
that grants privileges may only trust a verified one.

## Verification: the icon handshake

RSO is not granted (roadmap gate 5, still open), so the fallback ships:

1. `/link <riot-id>` resolves the Riot ID to a puuid via account-v1, picks a
   random profile icon from a small set, stores a challenge with a 10-minute
   expiry, and tells the player to set that icon in the client.
2. `/link confirm` reads summoner-v4 by puuid and compares `profileIconId`.
3. Match → `verified_at = NOW()`, `method = 'icon_handshake'`.

Two Riot calls per link, as costed in roadmap §9.

**This needs a new `ILolService` method.** `getSummonerByPUUID` does not exist;
the interface has account-v1 and match-v5 but no summoner-v4. Per the
conventions in §13.4 it ships with a `MockLolService` counterpart in the same
commit, because every test depends on the mock.

**The challenge icon must be chosen from a set the player does not already
have.** Picking at random from all icons gives a roughly 1-in-N chance of
"verifying" somebody who changed nothing. The current icon is read first and
excluded.

## Trusted links

Issue #142: _"For friend-group servers a trust-based link (no verification)
behind a guild setting is fine."_ Shipped as `guild_config.allow_trusted_links`,
default **false**. With it on, `/link` completes immediately with
`method = 'trusted'` and `verified_at` null.

Default false because the setting's blast radius is a stranger claiming
somebody else's account, and a server that wants the convenience can say so.

## What Meeps gets

One route, `GET /api/identity/resolve?meepsUserId=…`, returning the linked
puuids. That is the cross-reference the recap and the Session Curve need. It
goes behind `requireMeepsSecret` alongside the presence routes — machine to
machine, same shared secret, same reasoning.

**No new `DianaEvent` type.** Identity is a lookup, not something that happens;
an event would have no Meeps-side row shape and no natural idempotency key,
which by the §13.4 convention means it is not an event. It also avoids the
two-repo ordering problem — a new event type must land in Meeps' `VALID_TYPES`
before Diana emits it or every one is 400'd and dropped permanently.

## Components

| Unit                               | Does                                               |
| ---------------------------------- | -------------------------------------------------- |
| `core/identity/identityService.ts` | link, unlink, resolve, verify; challenge lifecycle |
| `ILolService.getSummonerByPUUID`   | summoner-v4 read for the handshake                 |
| `/link`, `/unlink`                 | Discord surface, ephemeral                         |
| `core/api/identityApi.ts`          | `resolve` for Meeps                                |
| `/privacy`                         | extended to apply across every linked puuid        |

## Error handling

- **Unknown Riot ID** → account-v1 404, reported as "no such Riot ID", not an
  error trace. The commonest failure is a typo.
- **summoner-v4 unavailable** (not on the production key, or 403) → the
  handshake cannot complete. Reported as a setup problem naming the method,
  because the operator's fix is a key request, not a retry. `docs/access.md` is
  missing (roadmap §9) so this is genuinely unverified until DN-8's record is
  restored.
- **Challenge expired** → say so and offer to restart. Ten minutes is long
  enough to alt-tab and change an icon.
- **Account already linked to somebody else** → refuse and say so. Do not
  silently move it; a contested link is a person to talk to, not a race to win.

## Testing

- `identityService`: link, unlink, resolve, double-link refusal, expiry.
- Handshake: match, mismatch, expired, current-icon exclusion.
- `MockLolService.getSummonerByPUUID` returns a stable icon.
- `/link` and `/unlink` command tests against the existing interaction mocks.
- `/privacy` across two linked accounts sets both.

## Out of scope

- **RSO.** Gated on an application that has not been made (gate 5).
- **Auto rank roles.** Unblocked by this, still parked in §10 as an acquisition
  investment after R1.
- **Deleting `users.league_username` on the Meeps side.** Roadmap §5.3 calls for
  it and it is right, but it is a Meeps migration and belongs in that repo's
  MP-05.
- **Per-squad privacy.** See the schema note; addable without moving anything.
- **Merging identities.** One person with two Discord accounts can link both to
  one identity, but there is no UI to merge two identities that already exist.
  Nothing needs it yet.

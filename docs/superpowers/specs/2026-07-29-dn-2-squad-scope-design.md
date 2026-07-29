# DN-2 — `squad_id` as the portable scope

_Design, 29 July 2026. Implements [`roadmap.md`](../../roadmap.md) §5.2 and the R1 Diana track entry DN-2._

## Why

Diana scopes everything to a Discord `guildId`. Meeps, since MP-1, scopes everything
to a space. Neither knows about the other, so a squad that lives in both places is two
unrelated datasets. Every joint feature in R2 — Session Recap, Squad Wrapped, the
Session Curve — needs one scope that spans both.

`DianaEventBase.squadId` already exists in the DN-1 contract, documented as "always
undefined until DN-2", and Meeps' `diana_events` table already carries an empty
`squad_id` column. This design fills both.

## Model

A **squad** is a group of people. A **Discord guild** and a **Meeps space** are
_attachments_ to it — destinations where that squad is reachable. The squad owns the
roster and the identity; each attachment owns its own delivery configuration.

That split is why `guild_config` is untouched by this work. `channel_id`,
`live_posting`, `notification_prefs` and `competitive_scope` are all answers to
"how should we post to this Discord server", not "who is in this group". A Meeps
space attached to the same squad is a different audience and will want its own
answers. `guild_config` is not being kept for compatibility — it is now correctly
named for what it always was.

## Schema — `db/migrations/014_squads.sql`

```
squads            (squad_id UUID PK, name TEXT, created_at)
squad_attachments (kind, external_id, squad_id FK, attached_at,
                   PRIMARY KEY (kind, external_id))
                   kind IN ('discord_guild', 'meeps_space')
squad_summoners   (squad_id FK, puuid FK, added_by, added_at,
                   PRIMARY KEY (squad_id, puuid))
```

`PRIMARY KEY (kind, external_id)` is the load-bearing constraint. One Discord guild
or Meeps space belongs to exactly one squad, so `guildId → squadId` resolution is
total and unambiguous. Without it, every read path would have to decide what to do
about a guild in two squads.

`squad_summoners` is indexed on `puuid`: the poller's reverse lookup
(`which squads track this player`) runs once per tracked player per minute.

### Idempotency

`db/migrate.sh` runs `psql` **without** `ON_ERROR_STOP` and records the file as
applied either way — established in `013_guild_competitive_scope.sql`. A statement
that fails is silently skipped and never retried. So every statement here, including
the backfill, must be safe to run twice and must not depend on the one before it
having succeeded. Backfill inserts are guarded with `WHERE NOT EXISTS`.

`gen_random_uuid()` is built in from Postgres 13. `CREATE EXTENSION IF NOT EXISTS
"pgcrypto"` is included so this also works on 12.

### Backfill

One squad per distinct guild appearing in `guild_config` or `guild_summoners`,
attached as `discord_guild`, roster copied preserving `added_by` and `added_at`.
`guild_summoners` is left in place as a historical table. It stops being read;
nothing writes to it after this change.

## Code

### `packages/diana-core/src/core/squads/squadService.ts` — new

Squads belong in `core/`, not in the League plugin: Apex needs the same scope, and a
Meeps space is not a League concept.

It imports `db` from `plugins/diana-league-bot/api/utils/db`, which is backwards.
`db` is a bare `pg.Pool` wrapper — infrastructure, already re-exported from the core
barrel, misfiled under a plugin. Moving it would touch 31 imports for no benefit to
this change, so the import is commented and left alone.

Surface: attachment resolution (`getSquadIdForAttachment`,
`getOrCreateSquadForAttachment`, `attachToSquad`, `detachAttachment`,
`getSquadAttachments`), roster (`addSummonerToSquad`, `removeSummonerFromSquad`,
`getSummonersForSquad`, `isSummonerInSquad`), and `getSquadsTrackingPuuid` for the
poller.

### `guildService.ts` — becomes the Discord-attachment shim

The roster functions keep their exported names and signatures; their bodies resolve
`guildId → squadId` and delegate. The five Discord command files calling them do not
change. A Discord command legitimately holds a `guildId`; resolving at the edge is
the whole point of an attachment.

### Read-path cutover — six SQL sites

`interStats.ts` (`InterStatsOptions.guildId` → `squadId`), `weeklyDigestService.ts`,
`summonerService.ts` (three joins), `compareCommand.ts` (two), `liveGameCommand.ts`.
Each swaps `JOIN guild_summoners … guild_id = $n` for
`JOIN squad_summoners … squad_id = $n`, with the caller resolving first.

### Events — one per squad

`buildMatchScopedEventId(type, matchId, puuid, squadId)` and
`buildPeriodicEventId(type, squadId, isoWeek)`. The match-event block in
`matchMonitoringService.ts` moves inside a loop over `getSquadsTrackingPuuid(puuid)`,
stamping `squadId` on each event.

This is the option that fits the receiver already in production: Meeps'
`diana_events.squad_id` is a scalar column, and its
`INSERT … ON CONFLICT (event_id) DO NOTHING` needs no change. The cost is N HTTP
calls for N squads, where N is 1 in every case that exists today.

Digest and rotation events key on squad, so two guilds attached to one squad produce
two Discord posts and one event row. That is correct: two destinations, one fact.

**Known one-time consequence.** Changing the id format means any `match.completed`
rows Meeps has already stored under the old `type:matchId:puuid` key will be inserted
once more under the new `type:squadId:matchId:puuid` key. Harmless, bounded, and
worth stating rather than discovering.

### `packages/diana-core/src/core/api/squadsApi.ts` — new

Mounted `app.use('/api/squads', requireAuth, squadsApiRouter)` beside `authApiRouter`
and `pluginsApiRouter`. This is how a Meeps space gets attached without SQL.

```
GET    /api/squads/:squadId
GET    /api/squads/by-attachment/:kind/:externalId
GET    /api/squads/:squadId/summoners
POST   /api/squads/:squadId/attachments
DELETE /api/squads/:squadId/attachments/:kind/:externalId
```

## Testing

New `test/squadService.test.ts` and `test/squadsApi.test.ts`, following the
established pattern of `jest.mock`-ing `db.query` or the service layer.

The acceptance criterion — "correct across two guilds _and_ two spaces" — is covered
by extending `interStats.test.ts` and `weeklyDigestService.test.ts` with two squads,
one backed by a Discord guild and one by a Meeps space, asserting no bleed in either
direction.

`test/discordPayloadRegression.test.ts` snapshots must stay green **without being
regenerated**. That is the guardrail on the free bot's output and the single
highest-risk part of this change.

## Out of scope

- No Meeps-side change. Its receiver and schema already accommodate this.
- No `/squad` Discord command. Discord guilds auto-attach on first use, and §4.2 says
  investment belongs on the paid surface.
- No `guild_summoners` drop. It is left in place; removing it is a later migration
  once this has run in production.

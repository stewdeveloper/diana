# Session Recap — Diana's half

_Design, 31 July 2026. Implements [`roadmap.md`](../../roadmap.md) §7.1, tracked as #160.
Builds on DN-6 (#174), which shipped the sessions engine but nothing that turns it._

## Why now

Three of Session Recap's four prerequisites are met. DN-5 (#171, #173) ingests voice
presence. DN-6 (#174) sessionises it into nights and attaches the matches that fall
inside them. Meeps shipped MP-10 six hours before this was written, so `diana_events`
finally has a reader, a WebSocket fan-out and an authorisation join.

What is missing is the middle: **nothing closes a night, and nothing announces one.**

- `rebuildSessionsForSquad` is reachable only from `POST /api/sessions/squad/:id/rebuild`
  behind the dashboard JWT (`apps/server/src/index.ts:137`). There is no cron. Sessions
  do not exist unless a human asks for them.
- `eventTypes.ts:22-28` has six event variants and none is session-shaped.

This design fills that gap and nothing else.

## What DN-3 does not block

The roadmap and Meeps' own `ROADMAP.md` §3 both record Session Recap as blocked on
identity. That is truer than it needs to be.

`session_participants` is keyed on `meeps_user_id` (`016_sessions.sql`), and Meeps
already knows its own users' display names. So "Louis left after game 5" is renderable
today: Diana emits the id, Meeps resolves the name. Separately, "best game: Aidan's
Warwick" comes from `squad_summoners` → `match_scores` → `summoners.gameName`, which
never needed identity either.

What DN-3 actually blocks is only the **cross-reference** between those two halves —
knowing that the person who left voice is the same person who played Warwick. The card
does not need it. When identity lands, `participants[].puuid` starts arriving populated
and the two lists join without a contract change.

## What is not computable, and is therefore not in the event

§7.1's example card ends with _"longest voice silence: 4m12s during game 6"_. Meeps
sends `voice.joined` and `voice.left` only. **Presence is not speech**: five people
sitting in a channel saying nothing are, to this pipeline, indistinguishable from five
people talking. Emitting a silence figure derived from join/leave would be a fabrication.

Dropped from the card until Meeps sends voice-activity data. Noted here rather than
silently omitted, because the line is quoted in two roadmap documents.

## The trigger

**The signal is silence, and silence does not arrive.**

`sessionisePresence` sets `endedAt` the moment voice empties
(`sessionise.ts:265-267` — `anyOpen ? null : max(leftAt)`). The 45-minute
`DEFAULT_IDLE_GAP_MS` governs only _grouping_: a rejoin inside that window merges back
into the same night through `groupIntoSessions`, and `endedAt` moves later.

So a session is finally settled when both hold:

```
ended_at IS NOT NULL          -- everybody has left
now - ended_at > idleGapMs    -- and nobody can rejoin this night any more
```

Nothing is delivered when the second condition becomes true. Only a timer can observe
an absence, so the trigger must be a sweep, not a hook on ingestion. And it must be a
cron rather than an in-process `setTimeout`, because a deploy would drop every pending
timer and the recap for that night would be lost silently.

**Consequence, stated plainly:** a recap lands 45–50 minutes after the last person
leaves, not instantly. That is forced by the grouping rule — firing sooner means firing
on nights that are not over. It is tunable via `idleGapMs`, and the sweep cadence
(5 minutes) sets the remaining jitter.

## Schema — `db/migrations/017_session_recaps.sql`

```
sessions.recap_emitted_at  TIMESTAMPTZ  -- NULL means "not yet announced"
```

One nullable column, plus a partial index on the sweep's exact predicate.

DN-6 is emphatic that `sessions` is derived and rebuildable, so a column that survives
a rebuild deserves justification. `recap_emitted_at` is **delivery bookkeeping, not a
fact about the night**: it records that we told someone, which is not recomputable from
`presence_events` and `match_details` because it is not a property of them.

It is safe against the rebuild rule in the direction that matters. `upsertSession` uses
`ON CONFLICT (squad_id, started_at) DO UPDATE` and does not touch this column, so a
rebuild preserves it. If some future rebuild did drop it, the worst outcome is one
redundant POST that Meeps discards on `ON CONFLICT (event_id) DO NOTHING`. A duplicate
delivery is a no-op; a lost recap is not. The column fails in the safe direction.

### Idempotency

`db/migrate.sh` runs `psql` without `ON_ERROR_STOP` and records the file as applied
either way, so every statement must be independently safe to re-run. `ADD COLUMN IF NOT
EXISTS` and `CREATE INDEX IF NOT EXISTS` throughout; no statement assumes its
predecessor succeeded.

## The event

A seventh variant on the DN-1 contract. Facts only — no prose, no colours, no field
ordering. `eventTypes.ts:4-7` draws that line and this stays on the right side of it:
Meeps composes the sentence in MP-06 and can reword it without a Diana deploy.

```ts
interface SessionCompletedEvent extends DianaEventBase {
    type: 'session.completed';
    sessionId: string;
    startedAt: string;
    endedAt: string;
    durationSeconds: number; // wall clock, endedAt - startedAt
    voiceSeconds: number; // summed across people; 3 for 2h is 21600
    participantCount: number;
    peakConcurrent: number;
    matchCount: number;
    wins: number;
    losses: number;
    participants: SessionParticipantSummary[];
    matches: SessionMatchSummary[];
    bestGame?: SessionStandout;
    worstGame?: SessionLowPoint;
}
```

`occurredAt` is the session's `endedAt`, not sweep time — `DianaEventBase.occurredAt`
is documented as "when the thing happened, not when we noticed it", and the sweep can
notice up to 50 minutes late.

`durationSeconds` and `voiceSeconds` are both present and are different numbers. Wall
clock is "5 hrs 28 min"; voice seconds is summed per person. Shipping only one would
make the other a subtraction Meeps has to guess at.

### Idempotency key

```
session.completed:{squadId}:{startedAtIso}
```

Keyed on the domain, **not** `session_id`. That column is `gen_random_uuid()`, which is
exactly the "random UUID" `eventTypes.ts:13-14` forbids as an event key. `(squad_id,
started_at)` is already the table's `UNIQUE` constraint, so it is both stable across
rebuilds and genuinely identifying.

### Meeps-side row shape

Required by the §13.4 convention — a variant without a documented consumer row shape
"is a message, and belongs on `MessageAdapter` instead".

`diana_events` stores it unchanged: `event_id` (the key above), `type`
`'session.completed'`, `squad_id`, `occurred_at` = `endedAt`, and the whole event as
`payload` JSONB. No new Meeps table. `broadcastDianaEvent` fans it to connected clients,
and MP-06 renders `payload`.

> ⚠️ **One-line Meeps change required, and it is not optional.**
> `dianaEventsController.js:4-11` is a closed allowlist; an unknown `type` returns 400,
> which `meepsEventAdapter` treats as permanent and never retries. Until
> `"session.completed"` is added to `VALID_TYPES`, every recap is dropped silently and
> forever. Shipped as a separate PR on the Meeps repo.

## Standouts

**Best game names a person. Worst game blames the room.**

`bestGame` is the highest `match_scores.score` among the squad's tracked puuids across
the session, carrying `summonerName` and `championName`.

`worstGame` is the _game_ with the lowest mean squad score — not the worst individual
performance. This matches §7.1's own phrasing ("worst: everyone's, game 6") and it is a
deliberate product choice, not a simplification: a recap that names the worst player
every night is a different and worse product than one that names the worst game. The
roadmap's §8.1 design ethic ("banter between friends and a weapon between
acquaintances") applies here even though it was written about the Session Curve.

Both are optional, in the sense #176 established for `WeeklyDigestStats`: absent means
"not awarded", never "unknown". A night where the squad played nothing, or where scoring
failed, emits neither rather than a zero.

### Against the `digest.weekly` precedent

#176 landed while this was being written and gives `WeeklyDigestStats` its own
`bestGame` and `worstGame`, both typed `WeeklyDigestAward { name, value }` — i.e. both
name a **person**. The session card's `worstGame` names a **game**. Same field name,
deliberately different meaning, so it is worth being explicit about why rather than
letting a future reader assume symmetry.

The digest ranks individuals across a week because that is what a digest is: seven days
flattened into a leaderboard, where being named is the point. A session recap is one
evening that five people experienced together, and the room reads it together. Naming
the worst player of the night, every night, to the people who were there is a different
product — and a meaner one — than naming the game that went badly for everyone.

The shapes are self-describing, which is what keeps this safe: the digest's carries
`name`, the session's carries `matchId` and `gameIndex` and no name at all. A consumer
cannot mistake one for the other, because there is no person in the session's low point
to mistake.

`bestGame` does name a person on both, and stays symmetrical for the same reason
inverted — a good game is worth attributing.

## Components

| File                                   | Responsibility                                        |
| -------------------------------------- | ----------------------------------------------------- |
| `db/migrations/017_session_recaps.sql` | The column and its index                              |
| `core/eventTypes.ts`                   | Variant, payload interfaces, `buildSessionEventId`    |
| `core/sessions/recapService.ts`        | Settled-session query, standouts, pure event builder  |
| `core/sessions/recapSweep.ts`          | Orchestration: candidates → rebuild → emit → mark     |
| `core/pluginRegistry.ts`               | Extract the guarded scheduler; add `registerCoreCron` |
| `apps/server/src/index.ts`             | `setEventAdapter`, start the sweep                    |

`recapService` is split from `recapSweep` on the same principle DN-6 used to split
`sessionise` from `sessionService`: the parts that are judgement calls (what counts as a
standout, what the card carries) should be testable without a database or a clock.

### Why the sweep is core, not a plugin cron

`registerCron` is only reachable through `PluginContext`, and sessions are deliberately
game-agnostic — roadmap §10 asks that recaps be built "on the event schema, not on
League specifics". Registering the sweep on the League plugin would make Apex squads
structurally incapable of having nights.

The scheduler body in `pluginRegistry.ts:105-140` already carries the in-flight guard
added by #119, which the sweep needs for exactly the reason the poller did. So it is
extracted to a module-level function and `createContext` delegates to it, rather than
the guard being written twice.

`getEventAdapter()` already falls back to a global `eventAdapter`
(`pluginRegistry.ts:166-168`) that nothing currently sets. That fallback is the seam a
core emitter is supposed to use; `apps/server` sets it.

## Data flow

```
cron (*/5 * * * *)
  └─ candidate squads: presence in the last 24h, or an open session
       └─ rebuildSessionsForSquad(squadId, { since: 3 days })   [DN-6, unchanged]
            └─ findSettledSessions(now, idleGapMs)
                 └─ getSessionDetail + computeStandouts
                      └─ buildSessionCompletedEvent  (pure)
                           └─ eventAdapter.emit  ──────► Meeps /api/diana-events
                                └─ mark recap_emitted_at
```

The 3-day `since` against a 24-hour activity filter is deliberately generous.
`rebuildSessionsForSquad`'s docstring warns that a `since` landing mid-night
under-reports that night, so the lookback must comfortably clear the oldest session a
tick could still be settling.

## Error handling

`EventAdapter.emit` must not throw by contract (`eventTypes.ts:145-147`), and
`meepsEventAdapter` already honours that. The sweep adds two further guarantees:

- **Per-squad and per-session isolation.** One squad's rebuild failing must not stop the
  others. Each is wrapped; failures are logged and the sweep continues.
- **Mark only after emit.** `recap_emitted_at` is set only once `emit` has resolved. A
  failed delivery therefore retries on the next tick, which is what "at-least-once"
  requires — and redelivery is a no-op on Meeps' primary key.

The in-flight guard prevents a slow tick from overlapping the next.

## Testing

Root `test/`, Jest + ts-jest, `db` mocked at the module boundary — the DN-6 convention in
`test/sessionService.test.ts`.

- **Settlement boundary.** Not settled at `gap - 1ms`; settled at `gap + 1ms`. This is
  the rule the whole feature turns on.
- **No double emit.** A session with `recap_emitted_at` set is not re-emitted.
- **Mark only after emit.** A throwing adapter leaves `recap_emitted_at` NULL.
- **Standouts.** Ties resolve deterministically; a session with no scored matches emits
  neither standout rather than a zero.
- **Event shape.** `occurredAt` equals `endedAt`; the id is domain-keyed; wall-clock and
  voice seconds are distinct.
- **Sweep isolation.** One squad throwing does not prevent the next from emitting.
- **Contract.** `eventTypes.test.ts` extended for the new builder.

## Out of scope

- MP-06 rendering (Meeps).
- Discord posting. Roadmap §4.2 puts rendering investment on the paid surface, and a
  squad with no Meeps space has no voice presence and therefore no sessions at all.
- "Longest voice silence" — see above.
- The voice ↔ Riot cross-reference (DN-3).
- Squad Wrapped (#161) and the Session Curve (#163), both of which read these rows.

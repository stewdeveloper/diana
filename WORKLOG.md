# Worklog

Section-by-section progress against [`docs/roadmap.md`](docs/roadmap.md). Kept at
the repo root deliberately — GitHub Pages publishes `docs/`, and unreleased plans
should not sit at the URL given to Riot for product verification.

---

## Section 1 — DN-1 Typed event bus 🔨

**Branches:** diana `ls/dn-1-event-bus` · Meeps `ls/diana-events`

Diana emits structured events alongside its existing Discord messages; Meeps
stores them as rows. This is the keystone for every R2/R3 joint feature — session
recaps, the session curve, wrapped, squad draft all need match data in Meeps'
database rather than as chat text.

### Done

| Part | What                                                                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | `packages/diana-core/src/core/eventTypes.ts` — `DianaEvent` union, `EventAdapter`, deterministic id builders, `toIsoWeek`                                                                      |
| A2   | `EventAdapter` plumbed through `PluginContext` mirroring `MessageAdapter` (`pluginTypes.ts`, `pluginRegistry.ts`, `apps/server/src/index.ts`)                                                  |
| A3   | `apps/server/src/meepsEventAdapter.ts` — retry with backoff, never throws. URL handling extracted to `meepsUrl.ts` and shared with the message adapter                                         |
| A4   | Emission wired into `matchMonitoringService`, `weeklyDigestService`, `rotationPostService`; plugin passes `context.getEventAdapter()`                                                          |
| B    | Meeps: migration `029_diana_events.sql`, `dianaEventsController.js`, `dianaEventsRoutes.js`, wired in `app.js`                                                                                 |
| C    | `test/discordPayloadRegression.test.ts` (12 snapshots), `test/eventTypes.test.ts`, `test/meepsEventAdapter.test.ts`, extended rotation + digest suites, `backend/src/test/dianaEvents.test.js` |

**Diana: 44 suites, 728 tests, 12 snapshots — all passing.**

### Decisions that differ from the plan

**Events are emitted once per match, not once per guild.** The plan put emission
inside the four `notify*` functions. Those run inside the per-guild fan-out loop,
so a match tracked by three guilds would have emitted three identical events —
deduped by the receiver, but three HTTP calls with retries each. Emission now
sits after the fan-out in `matchMonitoringService`, which is also semantically
right: an event is a fact about a match, not about a Discord channel. It means
events are still captured for matches no guild is configured to post.

**`buildRotationPayload` kept, `buildRotationPost` added.** The rotation event
needs the champion names, which were computed inside the payload builder and
discarded. Rather than change a tested export's return shape, `buildRotationPost`
returns `{ payload, championNames }` and `buildRotationPayload` is a thin wrapper.
No extra Riot call.

**DN-10 dropped from the roadmap, not implemented.** `db/migrate.sh` already
maintains a `schema_migration_diana` versions table keyed on filename. The
duplicate `002_` prefix is cosmetic and must _not_ be renamed — the filename is
the applied-key, so renaming would re-run those migrations against production.

### Known gaps

- **Not runtime-verified end to end.** Meeps has no `node_modules` installed and
  no database was running, so its controller and migration are syntax-checked
  only. The Diana side is fully unit-tested. See "To finish Section 1" below.
- **`matchMonitoringService` has no test suite** (it did not have one before
  this work either). The emission block there is covered by typechecking and the
  digest/rotation tests exercising the same adapter contract, not directly.
  Worth a fixture-based suite before Section 2 touches the same file.
- **`squadId` is always undefined**, and match-scoped events carry no `guildId` —
  a match belongs to a player, not a server, and a player can be tracked by
  several. DN-2 introduces the portable scope that resolves this; the Meeps
  schema already has the column.
- **The legacy `/api/diana-notify` message path still has no receiver.** It was
  never built on the Meeps side. Left alone deliberately: it retires under MP-6
  when Meeps renders events natively. The `supportUrl` serialisation gap the
  roadmap flagged is moot for the same reason.

### To finish Section 1

1. `cd Meeps/backend && npm install && npm run migrate` — confirm `diana_events` exists.
2. Start Meeps with `DIANA_WEBHOOK_SECRET` set; run its test suite.
3. Run Diana with `MEEPS_WEBHOOK_URL` + matching secret and `USE_MOCK_RIOT_API=true`
   so `MockLolService` drives a match through the poller.
4. `SELECT event_id, type, occurred_at FROM diana_events ORDER BY received_at DESC LIMIT 5;`
5. Replay the same event — expect one row, 200 on both calls.
6. Stop Meeps, trigger a match, confirm Discord still posts and Diana does not crash.

---

## Next: Section 2 — DN-2 `squad_id` portable scope

Introduce `squad_id` as the shared scope, with a Discord guild _or_ a Meeps space
as an attachment to it. `guild_config` and `guild_summoners` become attachments
rather than the scope itself. Fill in `squadId` on every event and populate the
column that already exists in `diana_events`.

Note: the `/iotw` cross-guild leak described in `new-design.md` was already fixed
in #113 — `interStats.ts` carries the `guild_summoners` join. DN-2 is needed for
portability, not to close a live leak.

## Then: Section 3 — DN-3 Riot account linking + privacy opt-out

RSO if granted, profile-icon handshake otherwise. Per-player opt-out honoured by
every leaderboard, digest and recap. Gated on the Riot application outcome — see
the App Notes in the submitted application regarding `/iotw` and the AI score.

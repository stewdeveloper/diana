-- 017: recap delivery bookkeeping (Session Recap, roadmap §7.1)
--
-- DN-6 built the sessions engine and nothing that turns it. The recap sweep is
-- the missing trigger, and it needs exactly one thing the derived tables cannot
-- give it: whether a night has already been announced.
--
-- WHY THIS COLUMN IS ALLOWED TO EXIST ON A DERIVED TABLE
--
-- 016 is emphatic that `sessions` is derived and rebuildable, and that nothing
-- may treat it as a system of record. This column does not break that rule
-- because it is not a fact *about the night*: it records that we told somebody,
-- which is not recomputable from `presence_events` and `match_details` for the
-- simple reason that it is not a property of them.
--
-- It survives a rebuild in practice - `upsertSession` uses
-- ON CONFLICT (squad_id, started_at) DO UPDATE and does not name this column, so
-- a recomputed night keeps it. And if some future rebuild did drop it, the
-- failure is in the safe direction: one redundant POST, which Meeps discards on
-- ON CONFLICT (event_id) DO NOTHING. A duplicate delivery is a no-op; a lost
-- recap is not recoverable at all.
--
-- migrate.sh runs psql without ON_ERROR_STOP and records the file as applied
-- either way, so every statement here must be idempotent and must not assume
-- the statement before it succeeded.

ALTER TABLE "sessions"
    -- NULL means "not yet announced". Set only after the event is confirmed
    -- delivered, never before - see recapSweep.ts.
    ADD COLUMN IF NOT EXISTS "recap_emitted_at" TIMESTAMPTZ;

-- The sweep's exact predicate, once per tick: finished nights that have settled
-- and have not been announced. Partial on `recap_emitted_at IS NULL` because the
-- rows it excludes are permanent - a night, once announced, is never a candidate
-- again, so the index stays roughly the size of the backlog rather than the
-- size of the history.
CREATE INDEX IF NOT EXISTS "idx_sessions_awaiting_recap"
    ON "sessions" ("ended_at")
    WHERE "recap_emitted_at" IS NULL AND "ended_at" IS NOT NULL;

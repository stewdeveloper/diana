-- 016: sessions - voice presence joined to matches (DN-6)
--
-- The atomic unit of a friend group's gaming life is not the match, it is the
-- night. This is the table that makes a night addressable, and it is the engine
-- behind Session Recap (roadmap §7.1), the Session Curve (§8.1) and Squad
-- Wrapped (§7.2).
--
-- Derived, never authoritative. Every row here is recomputable from
-- `presence_events` and `match_details`, which matters because the sessionising
-- rules will change - the idle gap is a judgement call, not a fact - and a
-- derived table can simply be rebuilt. Nothing may write to these tables except
-- the session service, and nothing may treat them as a system of record.
--
-- migrate.sh runs psql without ON_ERROR_STOP and records the file as applied
-- either way, so every statement here must be idempotent and must not assume
-- the statement before it succeeded.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
--
-- `ended_at` is nullable and means "still in voice". A live session is a real
-- state, not an incomplete row: the recap fires when the last person leaves, so
-- something has to represent the night that has not finished yet.
--
-- `source_max_occurred_at` is the watermark the rebuild uses. Recomputing a
-- squad's whole history on every tick is wasteful once there are months of it,
-- and this records how far the derivation had consumed.
CREATE TABLE IF NOT EXISTS "sessions" (
    "session_id"    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "squad_id"      UUID NOT NULL REFERENCES "squads" ("squad_id") ON DELETE CASCADE,
    "started_at"    TIMESTAMPTZ NOT NULL,
    "ended_at"      TIMESTAMPTZ,
    -- Denormalised summary. All recomputable; stored because the recap card
    -- reads them together and the alternative is four aggregates per render.
    "participant_count" INTEGER NOT NULL DEFAULT 0,
    "match_count"       INTEGER NOT NULL DEFAULT 0,
    "wins"              INTEGER NOT NULL DEFAULT 0,
    "losses"            INTEGER NOT NULL DEFAULT 0,
    "peak_concurrent"   INTEGER NOT NULL DEFAULT 0,
    "voice_seconds"     INTEGER NOT NULL DEFAULT 0,
    "computed_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- One session per squad per start instant. Makes the rebuild idempotent:
    -- re-deriving the same night updates rather than duplicating it.
    CONSTRAINT "sessions_squad_started_at_key" UNIQUE ("squad_id", "started_at")
);

-- "This squad's nights, most recent first" - the recap list and every §8.1
-- aggregate read this way.
CREATE INDEX IF NOT EXISTS "idx_sessions_squad_started_at"
    ON "sessions" ("squad_id", "started_at" DESC);

-- The live session, which is what the "last person left" trigger looks for.
CREATE INDEX IF NOT EXISTS "idx_sessions_open"
    ON "sessions" ("squad_id")
    WHERE "ended_at" IS NULL;

-- ---------------------------------------------------------------------------
-- Who was there
-- ---------------------------------------------------------------------------
--
-- Keyed on `meeps_user_id`, not puuid, and that is the load-bearing decision.
-- DN-3 is not built, so a Meeps user's Riot account is not authoritative; if
-- this table required a puuid it would silently exclude exactly the person whose
-- voice presence matters most - the friend who was in the call all night without
-- playing.
--
-- `puuid` is therefore a nullable convenience, filled when presence happened to
-- carry one. Per-player match attribution ("was Louis in voice for game 5")
-- lights up when identity lands; everything voice-shaped works today.
CREATE TABLE IF NOT EXISTS "session_participants" (
    "session_id"     UUID NOT NULL REFERENCES "sessions" ("session_id") ON DELETE CASCADE,
    "meeps_user_id"  VARCHAR(64) NOT NULL,
    "puuid"          VARCHAR(200),
    "first_joined_at" TIMESTAMPTZ NOT NULL,
    "last_left_at"   TIMESTAMPTZ,
    "voice_seconds"  INTEGER NOT NULL DEFAULT 0,
    -- How many separate visits. "Louis left after game 5 and came back" is a
    -- recap line, and it is invisible if only the first and last are kept.
    "interval_count" INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY ("session_id", "meeps_user_id")
);

CREATE INDEX IF NOT EXISTS "idx_session_participants_user"
    ON "session_participants" ("meeps_user_id", "first_joined_at" DESC);

-- ---------------------------------------------------------------------------
-- What was played
-- ---------------------------------------------------------------------------
--
-- Attribution is at *squad* level and works today: `squad_summoners` says which
-- puuids the squad tracks, and a match those players finished inside the session
-- window belongs to the night. That needs no identity linking at all.
--
-- `game_index` is the ordinal within the session - game 1, game 2 - and it is
-- the whole point of the Session Curve: "58% for games 1-4 and 31% from game 5
-- on" is a question about this column.
CREATE TABLE IF NOT EXISTS "session_matches" (
    "session_id"  UUID NOT NULL REFERENCES "sessions" ("session_id") ON DELETE CASCADE,
    "match_id"    VARCHAR(50) NOT NULL,
    "game_index"  INTEGER NOT NULL,
    "started_at"  TIMESTAMPTZ NOT NULL,
    "ended_at"    TIMESTAMPTZ,
    "queue_id"    INTEGER,
    -- Null when the squad's participants disagree, which happens in a custom or
    -- an Arena lobby where two tracked players were on different teams.
    "win"         BOOLEAN,
    PRIMARY KEY ("session_id", "match_id")
);

CREATE INDEX IF NOT EXISTS "idx_session_matches_match"
    ON "session_matches" ("match_id");

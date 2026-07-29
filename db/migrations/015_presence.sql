-- 015: Presence ingestion from Meeps (DN-5)
--
-- DN-1 made the event bus one-directional: Diana pushes, Meeps stores. This is
-- the return path. Diana holds the match data, so Diana has to be the side that
-- joins it to presence - that join is the whole of Session Recap (DN-6), the
-- Session Curve and Squad Wrapped.
--
-- migrate.sh runs psql without ON_ERROR_STOP and records the file as applied
-- either way, so every statement here must be idempotent and must not assume
-- the statement before it succeeded.

-- ---------------------------------------------------------------------------
-- Consent
-- ---------------------------------------------------------------------------
--
-- Declared before presence_events because ingestion checks it on every event.
--
-- Voice presence is personal data: it records when someone was at their
-- computer and who they were with. Consent is per person per squad, opt-in, and
-- defaults to off - a row's absence means "no". Enforced at ingestion rather
-- than at read time, so opting out means the data is never collected, not
-- merely filtered later. Roadmap §8.1 and trap 6.
CREATE TABLE IF NOT EXISTS "presence_consent" (
    "meeps_user_id" VARCHAR(64) NOT NULL,
    "squad_id"      UUID NOT NULL REFERENCES "squads" ("squad_id") ON DELETE CASCADE,
    "opted_in"      BOOLEAN NOT NULL DEFAULT FALSE,
    "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("meeps_user_id", "squad_id")
);

-- ---------------------------------------------------------------------------
-- Presence events
-- ---------------------------------------------------------------------------
--
-- event_id mirrors diana_events on the Meeps side: a deterministic key built
-- from the domain, never random, so redelivery is a no-op rather than a
-- duplicate row.
--
-- puuid is nullable and deliberately carries no foreign key. DN-3 (verified
-- account linking) is not built, so a Meeps user's Riot account is not yet
-- authoritative; a FK here would drop presence for anyone Diana has not seen
-- play, which is exactly the person whose voice presence still matters to a
-- session.
CREATE TABLE IF NOT EXISTS "presence_events" (
    "event_id"      VARCHAR(255) PRIMARY KEY,
    "type"          VARCHAR(64) NOT NULL,
    "squad_id"      UUID NOT NULL REFERENCES "squads" ("squad_id") ON DELETE CASCADE,
    "meeps_user_id" VARCHAR(64) NOT NULL,
    "puuid"         VARCHAR(200),
    "channel_id"    VARCHAR(64),
    "queue_id"      INTEGER,
    "match_id"      VARCHAR(64),
    "occurred_at"   TIMESTAMPTZ NOT NULL,
    "received_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "payload"       JSONB NOT NULL
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'presence_events_type_check'
    ) THEN
        ALTER TABLE "presence_events"
            ADD CONSTRAINT "presence_events_type_check"
            CHECK ("type" IN (
                'voice.joined',
                'voice.left',
                'client.in_champ_select',
                'client.in_game'
            ));
    END IF;
END $$;

-- Sessionising reads one squad's events in time order - this is the index the
-- session service (DN-6) will live on.
CREATE INDEX IF NOT EXISTS "idx_presence_events_squad_occurred_at"
    ON "presence_events" ("squad_id", "occurred_at" ASC);

-- Per-person history, for export and for "was this player in voice for that
-- match" - the one dimension no competitor can compute.
CREATE INDEX IF NOT EXISTS "idx_presence_events_user_occurred_at"
    ON "presence_events" ("meeps_user_id", "occurred_at" ASC);

CREATE INDEX IF NOT EXISTS "idx_presence_events_puuid_occurred_at"
    ON "presence_events" ("puuid", "occurred_at" ASC)
    WHERE "puuid" IS NOT NULL;

-- 014: squad_id as the portable scope (DN-2)
--
-- A squad is a group of people. A Discord guild and a Meeps space are
-- *attachments* to it - destinations where that squad is reachable. The squad
-- owns the roster; each attachment owns its own delivery config, which is why
-- guild_config is untouched by this migration: channel_id, live_posting,
-- notification_prefs and competitive_scope all answer "how should we post to
-- this Discord server", not "who is in this group".
--
-- migrate.sh runs psql without ON_ERROR_STOP and records the file as applied
-- either way, so every statement here must be idempotent and must not assume
-- the statement before it succeeded.

-- gen_random_uuid() is built in from Postgres 13; pgcrypto supplies it on 12.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS "squads" (
    "squad_id"   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "name"       TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PRIMARY KEY (kind, external_id) is the load-bearing constraint: one Discord
-- guild or Meeps space belongs to exactly one squad, so guildId -> squadId
-- resolution is total and unambiguous. Without it every read path would have to
-- decide what to do about a guild in two squads.
CREATE TABLE IF NOT EXISTS "squad_attachments" (
    "kind"        VARCHAR(20) NOT NULL,
    "external_id" VARCHAR(64) NOT NULL,
    "squad_id"    UUID NOT NULL REFERENCES "squads" ("squad_id") ON DELETE CASCADE,
    "attached_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("kind", "external_id")
);

-- ADD CONSTRAINT has no IF NOT EXISTS in Postgres; guard it explicitly.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'squad_attachments_kind_check'
    ) THEN
        ALTER TABLE "squad_attachments"
            ADD CONSTRAINT "squad_attachments_kind_check"
            CHECK ("kind" IN ('discord_guild', 'meeps_space'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_squad_attachments_squad"
    ON "squad_attachments" ("squad_id");

CREATE TABLE IF NOT EXISTS "squad_summoners" (
    "squad_id" UUID NOT NULL REFERENCES "squads" ("squad_id") ON DELETE CASCADE,
    "puuid"    VARCHAR(200) NOT NULL REFERENCES "summoners" ("puuid") ON DELETE CASCADE,
    "added_by" VARCHAR(30),
    "added_at" TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY ("squad_id", "puuid")
);

-- The poller's reverse lookup - "which squads track this player" - runs once
-- per tracked player per minute, so it gets its own index.
CREATE INDEX IF NOT EXISTS "idx_squad_summoners_puuid"
    ON "squad_summoners" ("puuid");

-- ---------------------------------------------------------------------------
-- Backfill: one squad per existing Discord guild
-- ---------------------------------------------------------------------------
--
-- Done as a loop rather than a set-based INSERT ... SELECT because squads and
-- squad_attachments are two tables with no shared natural key: RETURNING gives
-- back the new squad_id but nothing to correlate it to its guild.
--
-- Squad name is left NULL. Diana never stored Discord guild names, and inventing
-- one ("Guild 123456") would be worse than an honest absence - the dashboard and
-- the /api/squads route can render the attachment instead.
DO $$
DECLARE
    g RECORD;
    new_squad UUID;
BEGIN
    FOR g IN
        SELECT DISTINCT guild_id
        FROM (
            SELECT "guild_id" FROM "guild_config"
            UNION
            SELECT "guild_id" FROM "guild_summoners"
        ) AS all_guilds
        WHERE guild_id IS NOT NULL
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM "squad_attachments"
            WHERE "kind" = 'discord_guild' AND "external_id" = g.guild_id
        ) THEN
            INSERT INTO "squads" DEFAULT VALUES RETURNING "squad_id" INTO new_squad;
            INSERT INTO "squad_attachments" ("kind", "external_id", "squad_id")
            VALUES ('discord_guild', g.guild_id, new_squad);
        END IF;
    END LOOP;
END $$;

-- Roster copy. added_by and added_at are preserved: they are the only record of
-- who put a summoner in the group and when.
INSERT INTO "squad_summoners" ("squad_id", "puuid", "added_by", "added_at")
SELECT sa."squad_id", gs."puuid", gs."added_by", gs."added_at"
FROM "guild_summoners" gs
JOIN "squad_attachments" sa
  ON sa."kind" = 'discord_guild' AND sa."external_id" = gs."guild_id"
ON CONFLICT ("squad_id", "puuid") DO NOTHING;

-- guild_summoners is deliberately left in place. After this migration nothing
-- reads or writes it; dropping it is a separate migration once this has run in
-- production for long enough to trust the backfill.

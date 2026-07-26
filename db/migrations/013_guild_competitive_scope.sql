-- 013: Per-guild competitive stats scope + purge Arena AI scores
--
-- migrate.sh runs psql without ON_ERROR_STOP and records the file as applied
-- either way, so every statement here must be idempotent.

ALTER TABLE "guild_config"
    ADD COLUMN IF NOT EXISTS "competitive_scope" VARCHAR(10) NOT NULL DEFAULT 'all';

-- ADD CONSTRAINT has no IF NOT EXISTS in Postgres; guard it explicitly.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'guild_config_competitive_scope_check'
    ) THEN
        ALTER TABLE "guild_config"
            ADD CONSTRAINT "guild_config_competitive_scope_check"
            CHECK ("competitive_scope" IN ('all', 'ranked'));
    END IF;
END $$;

-- Arena (gameMode CHERRY) is a placement mode with no lanes, wards or rank, so
-- the role-weighted AI score never meant anything for it. match_scores has no
-- queueId column, so leaving these rows in place would force every reader to
-- join match_details forever. Deleting makes the table's meaning invariant:
-- "match_scores contains only competitive, non-Arena matches". The rows are
-- fully reconstructible from match_details.participants if this ever reverses.
--
-- Ships with the backfillMissingScores() queue filter - without that, /mvp and
-- /iotw recreate these rows within a week.
DELETE FROM "match_scores" ms
USING "match_details" md
WHERE md."matchId" = ms."matchId"
  AND (UPPER(COALESCE(md."gameMode", '')) = 'CHERRY'
       OR md."queueId" IN (1700, 1701, 1704, 1710, 1750));

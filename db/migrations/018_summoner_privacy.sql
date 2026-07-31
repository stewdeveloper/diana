-- 018: per-player privacy opt-out (DN-3)
--
-- Half of DN-3's acceptance: "opt-out honoured by every leaderboard, digest and
-- recap". The other half - verified account linking - is migration 019, and the
-- ordering is deliberate. Keying this on the identity would mean a player has to
-- *identify themselves before they can become invisible*, so it is keyed on the
-- puuid instead and works with no identity data at all.
--
-- migrate.sh runs psql without ON_ERROR_STOP and records the file as applied
-- either way, so every statement here must be idempotent and must not assume
-- the statement before it succeeded.

-- Its own table rather than a column on `summoners`. That table is the Riot
-- mirror: every column on it is something Riot told us, rewritten by the poller
-- and by any re-add or backfill. A privacy choice is the one fact on that row
-- the player asserted and Riot did not, and it has to survive all of them.
CREATE TABLE IF NOT EXISTS "summoner_privacy" (
    "puuid"      VARCHAR(200) PRIMARY KEY
                 REFERENCES "summoners" ("puuid") ON DELETE CASCADE,
    -- Absence means visible, and so does FALSE. The inverse of
    -- `presence_consent`, whose absence means no: collection is opt-in because
    -- it is data we would otherwise not hold, while display is opt-out because
    -- it is data we already hold and are choosing how to show. Defaulting
    -- rankings to hidden would empty every leaderboard in production on deploy.
    "hidden"     BOOLEAN NOT NULL DEFAULT FALSE,
    -- Who set it. A Discord user id when set through /privacy, null when set
    -- through the API. Kept because "who hid this player" is the first question
    -- asked when somebody disappears from a leaderboard unexpectedly.
    "set_by"     VARCHAR(30),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every aggregate read asks the same question - "which of these puuids are
-- hidden" - and the answer is almost always a very short list. A partial index
-- on the hidden rows keeps that lookup proportional to the number of people who
-- opted out rather than to the size of the roster.
CREATE INDEX IF NOT EXISTS "idx_summoner_privacy_hidden"
    ON "summoner_privacy" ("puuid")
    WHERE "hidden" = TRUE;

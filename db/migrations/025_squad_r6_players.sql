-- ====================================
-- Migration 025: a squad-keyed Siege roster
--
-- WHY THIS TABLE EXISTS
--
-- `guild_r6_players` (020) is keyed on a Discord guild id, and until now it was
-- the only way a Siege player could be tracked: `getAllTrackedR6Players` joins
-- it, so a row without a guild is a row the poller never sees. That made Siege
-- tracking Discord-only in a way League never was — League rosters live in
-- `squad_summoners`, keyed on `squad_id`, so a Meeps-only squad works.
--
-- This is the Siege equivalent, and it is a second roster rather than a
-- migration of the first. Both are real: a guild tracks whoever `/r6-add` named,
-- a squad tracks whoever linked their account in Meeps, and the same player can
-- be both. The poller unions them.
--
-- WHY NOT REUSE `squad_summoners`
--
-- Same reason 020 did not reuse `summoners`: that table's `puuid` is a foreign
-- key into `summoners`, and a Ubisoft profile id is never a summoner.
--
-- `added_by` IS A MEEPS PUBLIC ID, NOT A DISCORD SNOWFLAKE
--
-- Unlike `guild_r6_players.added_by`. Widened to 200 to match `identity_accounts
-- .external_id` rather than the 30 a snowflake needs — a Meeps `users.public_id`
-- is neither, and the column is a record of who enrolled the player, not a key.
-- ====================================

CREATE TABLE IF NOT EXISTS "squad_r6_players" (
    "squad_id"  UUID NOT NULL REFERENCES "squads" ("squad_id") ON DELETE CASCADE,
    "ubisoftId" VARCHAR(200) NOT NULL
                REFERENCES "r6_players" ("ubisoftId") ON DELETE CASCADE,
    "added_by"  VARCHAR(200),
    "added_at"  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY ("squad_id", "ubisoftId")
);

-- The poller's reverse lookup — "which squads track this player" — runs once per
-- tracked player per poll, so it gets its own index. The forward direction is
-- already served by the primary key's leading column.
CREATE INDEX IF NOT EXISTS "idx_squad_r6_players_player"
    ON "squad_r6_players" ("ubisoftId");

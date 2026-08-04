-- ====================================
-- Migration 020: Rainbow Six: Siege player tables
--
-- Mirrors 007_apex_players.sql rather than reusing `summoners`, for the same
-- reason: that table requires a tagLine, which Siege has no concept of. There
-- is no data to migrate across — this is a new plugin, not a move.
-- ====================================

CREATE TABLE IF NOT EXISTS "r6_players" (
    "ubisoftId"        VARCHAR(200) PRIMARY KEY,
    "gameName"         VARCHAR(200) NOT NULL,
    "platform"         VARCHAR(20)  NOT NULL,
    "tier"             VARCHAR(50)  NOT NULL DEFAULT 'Unranked',
    "division"         INT          NOT NULL DEFAULT 0,
    "rp"               INT          NOT NULL DEFAULT 0,
    "currentMatchId"   VARCHAR(200),
    "discordChannelId" VARCHAR(200),
    "lastUpdated"      TIMESTAMPTZ  DEFAULT NOW(),
    "kills_snapshot"   INT,
    "wins_snapshot"    INT,
    "losses_snapshot"  INT
);

CREATE INDEX IF NOT EXISTS idx_r6_players_gamename ON r6_players ("gameName");

CREATE TABLE IF NOT EXISTS "guild_r6_players" (
    "id"        SERIAL       PRIMARY KEY,
    "guild_id"  VARCHAR(200) NOT NULL,
    "ubisoftId" VARCHAR(200) NOT NULL REFERENCES r6_players("ubisoftId") ON DELETE CASCADE,
    "added_by"  VARCHAR(200),
    "added_at"  TIMESTAMPTZ  DEFAULT NOW(),
    UNIQUE ("guild_id", "ubisoftId")
);

CREATE INDEX IF NOT EXISTS idx_guild_r6_players_guild ON guild_r6_players (guild_id);
CREATE INDEX IF NOT EXISTS idx_guild_r6_players_player ON guild_r6_players ("ubisoftId");

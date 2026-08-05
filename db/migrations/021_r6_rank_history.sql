-- ====================================
-- Migration 021: Rainbow Six: Siege rank history
--
-- 020 followed diana-apex-bot in writing rank history to the shared
-- `rank_tracking` table, discriminated by `game_id`. That cannot work:
-- `rank_tracking.entryParticipantId` carries
--
--     FOREIGN KEY ("entryParticipantId") REFERENCES "summoners" ("puuid")
--
-- from 004, and a Ubisoft profile id is never a row in `summoners` — Siege
-- players live in `r6_players`, exactly as Apex players were moved out to
-- `apex_players` in 007 for the same reason. Every insert therefore raised a
-- foreign key violation, which the call sites swallowed with `.catch(() => {})`,
-- so the failure was invisible and the history silently empty.
--
-- The fix is a dedicated table rather than dropping that constraint: the
-- constraint is doing real work for League, which is the only game whose
-- participants *are* summoners, and loosening it to admit two other games'
-- identifiers would leave nothing checking any of them.
--
-- (diana-apex-bot has the identical defect against `rank_tracking` and wants
-- the identical table. Left alone here so an R6 change does not silently
-- rewrite Apex's storage — see the note in the PR.)
-- ====================================

CREATE TABLE IF NOT EXISTS "r6_rank_history" (
    "id"          SERIAL       PRIMARY KEY,
    -- Synthetic, supplied by the caller: Siege has no match id on a stats
    -- profile, so this is what makes one poll's row distinct from the next.
    "syncId"      VARCHAR(200) NOT NULL,
    "ubisoftId"   VARCHAR(200) NOT NULL REFERENCES r6_players("ubisoftId") ON DELETE CASCADE,
    "tier"        VARCHAR(50)  NOT NULL DEFAULT 'Unranked',
    "division"    INT          NOT NULL DEFAULT 0,
    "rp"          INT          NOT NULL DEFAULT 0,
    "recordedAt"  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE ("syncId", "ubisoftId")
);

-- The only read is "this player's most recent rank", newest first.
CREATE INDEX IF NOT EXISTS idx_r6_rank_history_player
    ON r6_rank_history ("ubisoftId", "recordedAt" DESC);

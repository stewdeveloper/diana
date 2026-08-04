import { db } from '../../../diana-league-bot/api/utils/db.js';
import { R6_GAME_ID, type R6Player } from '../../types.js';

export const getR6PlayerById = async (
    ubisoftId: string
): Promise<R6Player | null> => {
    const result = await db.query(
        `SELECT * FROM r6_players WHERE "ubisoftId" = $1`,
        [ubisoftId]
    );
    return rowToR6Player(result.rows[0]) ?? null;
};

export const getR6PlayerByName = async (
    gameName: string,
    platform: string
): Promise<R6Player | null> => {
    const result = await db.query(
        `SELECT * FROM r6_players WHERE "gameName" = $1 AND platform = $2`,
        [gameName, platform]
    );
    return rowToR6Player(result.rows[0]) ?? null;
};

/** Look up a player's Ubisoft id by name (no platform required). */
export const getR6PlayerIdByName = async (
    gameName: string
): Promise<string | null> => {
    const result = await db.query(
        `SELECT "ubisoftId" FROM r6_players WHERE "gameName" = $1 LIMIT 1`,
        [gameName]
    );
    return result.rows[0]?.ubisoftId ?? null;
};

export const createR6Player = async (data: {
    ubisoftId: string;
    gameName: string;
    platform: string;
    tier: string;
    division: number;
    rp: number;
    discordChannelId?: string | null;
}): Promise<R6Player> => {
    const result = await db.query(
        `INSERT INTO r6_players
            ("ubisoftId", "gameName", platform, tier, division, rp, "discordChannelId")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
            data.ubisoftId,
            data.gameName,
            data.platform,
            data.tier,
            data.division,
            data.rp,
            data.discordChannelId ?? null,
        ]
    );
    return rowToR6Player(result.rows[0])!;
};

/** Update rank and store the current stat snapshot for session diffing. */
export const updateR6PlayerRankAndSnapshot = async (
    ubisoftId: string,
    tier: string,
    division: number,
    rp: number,
    killsSnapshot: number,
    winsSnapshot: number,
    lossesSnapshot: number
): Promise<void> => {
    await db.query(
        `UPDATE r6_players
         SET tier = $1, division = $2, rp = $3,
             kills_snapshot = $4, wins_snapshot = $5, losses_snapshot = $6,
             "lastUpdated" = NOW()
         WHERE "ubisoftId" = $7`,
        [
            tier,
            division,
            rp,
            killsSnapshot,
            winsSnapshot,
            lossesSnapshot,
            ubisoftId,
        ]
    );
};

export const deleteR6Player = async (
    ubisoftId: string
): Promise<R6Player | null> => {
    const result = await db.query(
        `DELETE FROM r6_players WHERE "ubisoftId" = $1 RETURNING *`,
        [ubisoftId]
    );
    return rowToR6Player(result.rows[0]) ?? null;
};

export const searchR6PlayerNames = async (
    search: string,
    limit = 25,
    guildId?: string
): Promise<string[]> => {
    const trimmed = search.trim();
    if (guildId) {
        const query = trimmed
            ? `SELECT DISTINCT r."gameName"
               FROM r6_players r
               JOIN guild_r6_players grp ON grp."ubisoftId" = r."ubisoftId"
               WHERE grp.guild_id = $1 AND r."gameName" ILIKE $2
               ORDER BY r."gameName" ASC LIMIT $3`
            : `SELECT DISTINCT r."gameName"
               FROM r6_players r
               JOIN guild_r6_players grp ON grp."ubisoftId" = r."ubisoftId"
               WHERE grp.guild_id = $1
               ORDER BY r."gameName" ASC LIMIT $2`;
        const params = trimmed
            ? [guildId, `${trimmed}%`, limit]
            : [guildId, limit];
        const result = await db.query(query, params);
        return result.rows.map((r: { gameName: string }) => r.gameName);
    }

    const query = trimmed
        ? `SELECT DISTINCT "gameName" FROM r6_players
           WHERE "gameName" ILIKE $1
           ORDER BY "gameName" ASC LIMIT $2`
        : `SELECT DISTINCT "gameName" FROM r6_players
           ORDER BY "gameName" ASC LIMIT $1`;
    const params = trimmed ? [`${trimmed}%`, limit] : [limit];
    const result = await db.query(query, params);
    return result.rows.map((r: { gameName: string }) => r.gameName);
};

export const getAllTrackedR6Players = async (): Promise<R6Player[]> => {
    const result = await db.query(
        `SELECT DISTINCT r.*
         FROM r6_players r
         JOIN guild_r6_players grp ON grp."ubisoftId" = r."ubisoftId"`,
        []
    );
    return result.rows.map(rowToR6Player).filter(Boolean) as R6Player[];
};

export const getGuildsTrackingR6Player = async (
    ubisoftId: string
): Promise<
    Array<{ guild_id: string; channel_id: string; live_posting: boolean }>
> => {
    const result = await db.query(
        `SELECT gc.guild_id, gc.channel_id, gc.live_posting
         FROM guild_r6_players grp
         JOIN guild_config gc ON gc.guild_id = grp.guild_id
         WHERE grp."ubisoftId" = $1 AND gc.channel_id IS NOT NULL`,
        [ubisoftId]
    );
    return result.rows;
};

export const isR6PlayerInGuild = async (
    guildId: string,
    ubisoftId: string
): Promise<boolean> => {
    const result = await db.query(
        `SELECT 1 FROM guild_r6_players WHERE guild_id = $1 AND "ubisoftId" = $2`,
        [guildId, ubisoftId]
    );
    return (result.rowCount ?? 0) > 0;
};

export const addR6PlayerToGuild = async (
    guildId: string,
    ubisoftId: string,
    addedBy?: string | null
): Promise<void> => {
    await db.query(
        `INSERT INTO guild_r6_players (guild_id, "ubisoftId", added_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (guild_id, "ubisoftId") DO NOTHING`,
        [guildId, ubisoftId, addedBy ?? null]
    );
};

export const removeR6PlayerFromGuild = async (
    guildId: string,
    ubisoftId: string
): Promise<boolean> => {
    const result = await db.query(
        `DELETE FROM guild_r6_players WHERE guild_id = $1 AND "ubisoftId" = $2`,
        [guildId, ubisoftId]
    );
    return (result.rowCount ?? 0) > 0;
};

export const createR6RankHistory = async (
    matchId: string,
    ubisoftId: string,
    tier: string,
    division: number,
    rp: number
): Promise<void> => {
    await db.query(
        `INSERT INTO rank_tracking
            ("matchId", "entryParticipantId", "tier", "rank", "lp", "queueType", "game_id")
         VALUES ($1, $2, $3, $4, $5, 'RANKED', $6)
         ON CONFLICT ("matchId", "entryParticipantId") DO NOTHING`,
        [matchId, ubisoftId, tier, String(division), rp, R6_GAME_ID]
    );
};

export const getMostRecentR6Rank = async (
    ubisoftId: string
): Promise<{ tier: string; rank: string; lp: number } | null> => {
    const result = await db.query(
        `SELECT tier, rank, lp FROM rank_tracking
         WHERE "entryParticipantId" = $1 AND game_id = $2
         ORDER BY "lastUpdated" DESC LIMIT 1`,
        [ubisoftId, R6_GAME_ID]
    );
    return result.rows[0] ?? null;
};

/**
 * Wins/losses/kills gained since the stored snapshot.
 *
 * Returns nulls the first time a player is seen — a snapshot of `null` means
 * "no baseline", which is not the same as "played a session and gained
 * nothing", and the notification renders the two differently.
 */
export function diffSnapshot(
    player: Pick<R6Player, 'killsSnapshot' | 'winsSnapshot' | 'lossesSnapshot'>,
    current: { kills: number; wins: number; losses: number }
): {
    killsGained: number | null;
    winsGained: number | null;
    lossesGained: number | null;
} {
    return {
        killsGained:
            player.killsSnapshot === null
                ? null
                : current.kills - player.killsSnapshot,
        winsGained:
            player.winsSnapshot === null
                ? null
                : current.wins - player.winsSnapshot,
        lossesGained:
            player.lossesSnapshot === null
                ? null
                : current.losses - player.lossesSnapshot,
    };
}

function rowToR6Player(row: any): R6Player | null {
    if (!row) return null;
    return {
        ubisoftId: row.ubisoftId,
        gameName: row.gameName,
        platform: row.platform,
        tier: row.tier ?? 'Unranked',
        division: row.division ?? 0,
        rp: row.rp ?? 0,
        currentMatchId: row.currentMatchId ?? null,
        discordChannelId: row.discordChannelId ?? null,
        lastUpdated: row.lastUpdated,
        killsSnapshot: row.kills_snapshot ?? null,
        winsSnapshot: row.wins_snapshot ?? null,
        lossesSnapshot: row.losses_snapshot ?? null,
    };
}

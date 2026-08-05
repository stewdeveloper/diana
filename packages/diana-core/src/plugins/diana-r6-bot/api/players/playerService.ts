import { db } from '../../../diana-league-bot/api/utils/db.js';
import { type R6Player } from '../../types.js';

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

/**
 * Look up a player's Ubisoft id by name.
 *
 * `guildId` scopes the lookup to players that guild actually tracks. Without
 * it the `LIMIT 1` picks arbitrarily between same-named players on different
 * platforms — Ubisoft names are only unique per platform, and the autocomplete
 * that feeds this offers names alone — so `/r6-remove` could resolve the name
 * to a row belonging to somebody else's server and report "not tracked here".
 */
export const getR6PlayerIdByName = async (
    gameName: string,
    guildId?: string
): Promise<string | null> => {
    const result = guildId
        ? await db.query(
              `SELECT r."ubisoftId" FROM r6_players r
               JOIN guild_r6_players grp ON grp."ubisoftId" = r."ubisoftId"
               WHERE r."gameName" = $1 AND grp.guild_id = $2 LIMIT 1`,
              [gameName, guildId]
          )
        : await db.query(
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

/**
 * How many guilds track this player at all.
 *
 * Deliberately *not* `getGuildsTrackingR6Player(...).length`: that query exists
 * to answer "where do I post", so it inner-joins `guild_config` and drops any
 * guild with no notification channel set. Using it to answer "is anyone still
 * tracking this player" counts those guilds as zero, and the caller then
 * deletes the `r6_players` row — which cascades `guild_r6_players` and quietly
 * untracks the player for servers that never asked.
 */
export const countGuildsTrackingR6Player = async (
    ubisoftId: string
): Promise<number> => {
    const result = await db.query(
        `SELECT COUNT(*)::int AS count FROM guild_r6_players WHERE "ubisoftId" = $1`,
        [ubisoftId]
    );
    return result.rows[0]?.count ?? 0;
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

/**
 * Record one rank observation.
 *
 * Writes `r6_rank_history` (migration 021), not the shared `rank_tracking`.
 * That table's `entryParticipantId` is a foreign key into `summoners`, and a
 * Ubisoft profile id is never a summoner — Siege players live in `r6_players`.
 * Every write here used to raise a foreign key violation that the callers
 * swallowed, so the history was silently empty. Not swallowed any more: with a
 * table it can actually be written to, a failure is worth seeing.
 */
export const createR6RankHistory = async (
    syncId: string,
    ubisoftId: string,
    tier: string,
    division: number,
    rp: number
): Promise<void> => {
    await db.query(
        `INSERT INTO r6_rank_history
            ("syncId", "ubisoftId", tier, division, rp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("syncId", "ubisoftId") DO NOTHING`,
        [syncId, ubisoftId, tier, division, rp]
    );
};

export const getMostRecentR6Rank = async (
    ubisoftId: string
): Promise<{ tier: string; division: number; rp: number } | null> => {
    const result = await db.query(
        `SELECT tier, division, rp FROM r6_rank_history
         WHERE "ubisoftId" = $1
         ORDER BY "recordedAt" DESC LIMIT 1`,
        [ubisoftId]
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

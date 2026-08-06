import { db } from '../../../diana-league-bot/api/utils/db.js';
import { type R6Player, type R6StatSnapshot } from '../../types.js';

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

/**
 * Update rank and store the current stat snapshot for session diffing.
 *
 * Takes the whole `R6StatSnapshot` rather than a positional counter list. It was
 * three counters and is now five, and the previous signature had `kills, wins,
 * losses` as three adjacent numbers — adding `deaths` between them was a silent
 * mis-wiring waiting to happen at the one call site.
 */
export const updateR6PlayerRankAndSnapshot = async (
    ubisoftId: string,
    tier: string,
    division: number,
    rp: number,
    snapshot: R6StatSnapshot
): Promise<void> => {
    await db.query(
        `UPDATE r6_players
         SET tier = $1, division = $2, rp = $3,
             kills_snapshot = $4, deaths_snapshot = $5,
             wins_snapshot = $6, losses_snapshot = $7,
             abandons_snapshot = $8,
             "lastUpdated" = NOW()
         WHERE "ubisoftId" = $9`,
        [
            tier,
            division,
            rp,
            snapshot.kills,
            snapshot.deaths,
            snapshot.wins,
            snapshot.losses,
            snapshot.abandons,
            ubisoftId,
        ]
    );
};

/**
 * Record that a call was spent on this player, and where their active window
 * now sits (migration 023).
 *
 * Separate from `updateR6PlayerRankAndSnapshot` because it must happen on *every*
 * poll, including the overwhelming majority that find nothing changed and return
 * before the snapshot write. Folding the two together would leave a player whose
 * rank never moves with a null `last_polled_at` forever, and therefore always
 * due — the poller would spend its entire budget on the quietest player in the
 * table.
 */
export const markR6PlayerPolled = async (
    ubisoftId: string,
    activeUntil: Date | null
): Promise<void> => {
    await db.query(
        `UPDATE r6_players
         SET last_polled_at = NOW(), active_until = $1
         WHERE "ubisoftId" = $2`,
        [activeUntil, ubisoftId]
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
 * Every squad tracking this player, for stamping `squadId` on emitted events.
 *
 * Siege players are not in `squad_summoners` — that table's `puuid` is a foreign
 * key into `summoners`, and a Ubisoft profile id is never a summoner. So the
 * squad is resolved the other way round, through the Discord guilds that track
 * the player and the attachment that maps a guild to its squad. That is exactly
 * the resolution `getOrCreateSquadForAttachment` performs for League, run in
 * reverse.
 *
 * Deliberately *not* built on `getGuildsTrackingR6Player`: that query answers
 * "where do I post", so it inner-joins `guild_config` and drops any guild with
 * no notification channel. An event is a fact about the group and should be
 * captured whether or not anywhere is configured to announce it.
 */
export const getSquadsTrackingR6Player = async (
    ubisoftId: string
): Promise<string[]> => {
    const result = await db.query(
        `SELECT DISTINCT sa.squad_id
         FROM guild_r6_players grp
         JOIN squad_attachments sa
           ON sa.kind = 'discord_guild' AND sa.external_id = grp.guild_id
         WHERE grp."ubisoftId" = $1
         ORDER BY sa.squad_id ASC`,
        [ubisoftId]
    );
    return result.rows.map((row: { squad_id: string }) => row.squad_id);
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

export interface R6SnapshotDiff {
    killsGained: number | null;
    deathsGained: number | null;
    winsGained: number | null;
    lossesGained: number | null;
    abandonsGained: number | null;
}

/**
 * Counters gained since the stored snapshot.
 *
 * Returns nulls the first time a player is seen — a snapshot of `null` means
 * "no baseline", which is not the same as "played a session and gained
 * nothing", and the notification renders the two differently.
 *
 * Each counter is nulled independently, and that matters more after 023 than it
 * did before: a player tracked before the migration has kills, wins and losses
 * baselines but no deaths or abandons one. So their next poll legitimately
 * reports a real W/L with a null deaths figure, and the match card shows no K/D
 * rather than inventing a zero. It heals itself on the poll after that.
 */
export function diffSnapshot(
    player: Pick<
        R6Player,
        | 'killsSnapshot'
        | 'deathsSnapshot'
        | 'winsSnapshot'
        | 'lossesSnapshot'
        | 'abandonsSnapshot'
    >,
    current: {
        kills: number;
        deaths: number;
        wins: number;
        losses: number;
        abandons: number;
    }
): R6SnapshotDiff {
    return {
        killsGained:
            player.killsSnapshot === null
                ? null
                : current.kills - player.killsSnapshot,
        deathsGained:
            player.deathsSnapshot === null
                ? null
                : current.deaths - player.deathsSnapshot,
        winsGained:
            player.winsSnapshot === null
                ? null
                : current.wins - player.winsSnapshot,
        lossesGained:
            player.lossesSnapshot === null
                ? null
                : current.losses - player.lossesSnapshot,
        abandonsGained:
            player.abandonsSnapshot === null
                ? null
                : current.abandons - player.abandonsSnapshot,
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
        deathsSnapshot: row.deaths_snapshot ?? null,
        winsSnapshot: row.wins_snapshot ?? null,
        lossesSnapshot: row.losses_snapshot ?? null,
        abandonsSnapshot: row.abandons_snapshot ?? null,
        lastPolledAt: row.last_polled_at ?? null,
        activeUntil: row.active_until ?? null,
    };
}

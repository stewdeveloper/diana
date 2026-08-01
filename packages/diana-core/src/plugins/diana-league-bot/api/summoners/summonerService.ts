import { db } from '../utils/db.js';
import { Summoner } from '../../types.js';
import { getSquadIdForGuild } from './guildService';

export const getSummonerByAccountName = async (
    accountName: string,
    tagLine: string,
    region: string
) => {
    try {
        const query = `
            SELECT * FROM summoners
            WHERE "gameName" = $1 AND "tagLine" = $2 AND "matchRegionPrefix" = $3
              AND game_id = 'league_of_legends'
        `;
        const params = [accountName, tagLine, region];
        const result = await db.query(query, params);
        const summoner = result.rows[0];
        if (!summoner) {
            console.info(
                `Summoner ${accountName}#${tagLine} (${region}) not found.`
            );
            return null;
        }
        return summoner;
    } catch (error) {
        console.error('Error retrieving summoner details:', error);
        throw new Error('Failed to retrieve summoner details.');
    }
};

export async function searchSummonerGameNames(
    search: string,
    limit = 25,
    guildId?: string
): Promise<string[]> {
    try {
        const trimmedSearch = search.trim();

        const squadId = guildId ? await getSquadIdForGuild(guildId) : null;

        if (squadId) {
            const query = trimmedSearch
                ? `
                    SELECT DISTINCT s."gameName"
                    FROM summoners s
                    JOIN squad_summoners ss ON ss.puuid = s.puuid
                    WHERE ss.squad_id = $1 AND s."gameName" ILIKE $2
                      AND s.game_id = 'league_of_legends'
                    ORDER BY s."gameName" ASC
                    LIMIT $3
                `
                : `
                    SELECT DISTINCT s."gameName"
                    FROM summoners s
                    JOIN squad_summoners ss ON ss.puuid = s.puuid
                    WHERE ss.squad_id = $1
                      AND s.game_id = 'league_of_legends'
                    ORDER BY s."gameName" ASC
                    LIMIT $2
                `;
            const params = trimmedSearch
                ? [squadId, `${trimmedSearch}%`, limit]
                : [squadId, limit];
            const result = await db.query(query, params);
            return result.rows.map((row: { gameName: string }) => row.gameName);
        }

        const query = trimmedSearch
            ? `
                SELECT DISTINCT "gameName"
                FROM summoners
                WHERE "gameName" ILIKE $1
                  AND game_id = 'league_of_legends'
                ORDER BY "gameName" ASC
                LIMIT $2
            `
            : `
                SELECT DISTINCT "gameName"
                FROM summoners
                WHERE game_id = 'league_of_legends'
                ORDER BY "gameName" ASC
                LIMIT $1
            `;

        const params = trimmedSearch ? [`${trimmedSearch}%`, limit] : [limit];

        const result = await db.query(query, params);
        return result.rows.map((row: { gameName: string }) => row.gameName);
    } catch (error) {
        console.error('Error searching summoner game names:', error);
        throw new Error('Failed to search summoner game names.');
    }
}

interface SummonerTagSuggestion {
    tagLine: string;
    matchRegionPrefix: string | null;
}

export async function searchSummonerTags(
    gameName: string | null | undefined,
    search: string,
    limit = 25,
    guildId?: string
): Promise<SummonerTagSuggestion[]> {
    try {
        const trimmedSearch = search.trim();
        const trimmedName = gameName ? gameName.trim() : null;

        const squadId = guildId ? await getSquadIdForGuild(guildId) : null;

        if (squadId) {
            const conditions: string[] = [
                'ss.squad_id = $1',
                's."tagLine" IS NOT NULL',
                "s.game_id = 'league_of_legends'",
            ];
            const params: Array<string | number> = [squadId];

            if (trimmedName) {
                params.push(trimmedName);
                conditions.push(`s."gameName" = $${params.length}`);
            }
            if (trimmedSearch) {
                params.push(`${trimmedSearch}%`);
                conditions.push(`s."tagLine" ILIKE $${params.length}`);
            }

            params.push(limit);
            const query = `
                SELECT DISTINCT s."tagLine", s."matchRegionPrefix"
                FROM summoners s
                JOIN squad_summoners ss ON ss.puuid = s.puuid
                WHERE ${conditions.join(' AND ')}
                ORDER BY s."tagLine" ASC
                LIMIT $${params.length}
            `;
            const result = await db.query(query, params);
            return result.rows.map(
                (row: {
                    tagLine: string;
                    matchRegionPrefix: string | null;
                }) => ({
                    tagLine: row.tagLine,
                    matchRegionPrefix: row.matchRegionPrefix,
                })
            );
        }

        const conditions: string[] = [
            '"tagLine" IS NOT NULL',
            "game_id = 'league_of_legends'",
        ];
        const params: Array<string | number> = [];

        if (trimmedName) {
            params.push(trimmedName);
            conditions.push(`"gameName" = $${params.length}`);
        }

        if (trimmedSearch) {
            params.push(`${trimmedSearch}%`);
            conditions.push(`"tagLine" ILIKE $${params.length}`);
        }

        const whereClause = conditions.length
            ? `WHERE ${conditions.join(' AND ')}`
            : '';

        params.push(limit);
        const limitIndex = params.length;

        const query = `
            SELECT DISTINCT "tagLine", "matchRegionPrefix"
            FROM summoners
            ${whereClause}
            ORDER BY "tagLine" ASC
            LIMIT $${limitIndex}
        `;

        const result = await db.query(query, params);
        return result.rows.map(
            (row: { tagLine: string; matchRegionPrefix: string | null }) => ({
                tagLine: row.tagLine,
                matchRegionPrefix: row.matchRegionPrefix,
            })
        );
    } catch (error) {
        console.error('Error searching summoner tags:', error);
        throw new Error('Failed to search summoner tags.');
    }
}

export const getSummonerByPuuid = async (puuid: string) => {
    try {
        const query = `SELECT * FROM summoners WHERE "puuid" = $1 AND game_id = 'league_of_legends'`;
        const params = [puuid];
        const result = await db.query(query, params);
        const summoner = result.rows[0];
        if (!summoner) {
            console.info(`Summoner with PUUID ${puuid} not found.`);
            return null;
        }
        return summoner;
    } catch (error) {
        console.error('Error retrieving summoner by PUUID:', error);
        throw new Error('Failed to retrieve summoner details.');
    }
};

export const getSummonerCurrentGame = async (puuid: string) => {
    try {
        const query = `
            SELECT "currentMatchId" FROM summoners
            WHERE puuid = $1
        `;
        const params = [puuid];
        const result = await db.query(query, params);
        const matchId = result.rows[0];
        if (!matchId) {
            console.info(`Summoner with PUUID ${puuid} has no current game`);
            return {};
        }
        return matchId;
    } catch (error) {
        console.error('Error retrieving summoner by PUUID:', error);
        throw new Error('Failed to retrieve summoner details.');
    }
};

export const createSummoner = async (summonerData: Partial<Summoner>) => {
    try {
        const query = `
            INSERT INTO summoners ("puuid", "gameName", "tagLine", "region", "matchRegionPrefix", "deepLolLink", "tier", "rank", "lp", "discordChannelId", "regionGroup", "game_id")
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'league_of_legends')
            RETURNING *;
        `;
        const params = [
            summonerData.puuid,
            summonerData.gameName,
            summonerData.tagLine,
            summonerData.region,
            summonerData.matchRegionPrefix,
            summonerData.deepLolLink,
            summonerData.tier,
            summonerData.rank,
            summonerData.lp,
            summonerData.discordChannelId,
            summonerData.regionGroup,
        ];
        const result = await db.query(query, params);
        return result.rows[0];
    } catch (error) {
        console.error('Error creating summoner:', error);
        throw new Error('Failed to create summoner.');
    }
};

export const updateSummonerIdentityByPuuid = async (
    puuid: string,
    gameName: string,
    tagLine: string,
    deepLolLink: string,
    discordChannelId?: string | null
) => {
    try {
        const query = `
            UPDATE summoners
            SET
                "gameName" = $1,
                "tagLine" = $2,
                "deepLolLink" = $3,
                "discordChannelId" = $4,
                "lastUpdated" = NOW()
            WHERE "puuid" = $5
            RETURNING *;
        `;
        const params = [
            gameName,
            tagLine,
            deepLolLink,
            discordChannelId ?? null,
            puuid,
        ];
        const result = await db.query(query, params);
        const updatedSummoner = result.rows[0];
        if (!updatedSummoner) {
            console.info(`Summoner with PUUID ${puuid} not found for update.`);
            return null;
        }
        return updatedSummoner;
    } catch (error) {
        console.error('Error updating summoner identity:', error);
        throw new Error('Failed to update summoner identity.');
    }
};

export const updateSummonerRegionDataByPuuid = async (
    puuid: string,
    region: string,
    matchRegionPrefix: string,
    regionGroup: string
) => {
    try {
        const query = `
            UPDATE summoners
            SET
                "region" = $1,
                "matchRegionPrefix" = $2,
                "regionGroup" = $3,
                "lastUpdated" = NOW()
            WHERE "puuid" = $4
            RETURNING *;
        `;
        const params = [region, matchRegionPrefix, regionGroup, puuid];
        const result = await db.query(query, params);
        const updatedSummoner = result.rows[0];
        if (!updatedSummoner) {
            console.info(
                `Summoner with PUUID ${puuid} not found for region update.`
            );
            return null;
        }
        return updatedSummoner;
    } catch (error) {
        console.error('Error updating summoner region data:', error);
        throw new Error('Failed to update summoner region data.');
    }
};

export const updateSummonerRankByPuuid = async (
    puuid: string,
    tier: string,
    rank: string,
    lp: number
) => {
    try {
        const query = `
            UPDATE summoners
            SET
                "tier" = $1,
                "rank" = $2,
                "lp" = $3,
                "lastUpdated" = NOW()
            WHERE "puuid" = $4
            RETURNING *;
        `;
        const params = [tier, rank, lp, puuid];
        const result = await db.query(query, params);
        const updatedSummoner = result.rows[0];
        if (!updatedSummoner) {
            console.info(
                `Summoner with PUUID ${puuid} not found for rank update.`
            );
            return null;
        }
        return updatedSummoner;
    } catch (error) {
        console.error('Error updating summoner rank:', error);
        throw new Error('Failed to update summoner rank.');
    }
};

export const deleteSummoner = async (puuid: string) => {
    try {
        const query = `
            DELETE FROM summoners
            WHERE "puuid" = $1
            RETURNING *;
        `;
        const params = [puuid];
        const result = await db.query(query, params);
        const deletedSummoner = result.rows[0];
        if (!deletedSummoner) {
            return null;
        }
        return deletedSummoner;
    } catch (error) {
        console.error('Error deleting summoner:', error);
        throw new Error('Failed to delete summoner.');
    }
};

export const setSummonerCurrentMatchIdByPuuid = async (
    puuid: string,
    matchId: string
) => {
    try {
        const query = `
            UPDATE summoners
            SET 
                "currentMatchId" = $1,
                "lastUpdated" = NOW()
            WHERE "puuid" = $2
            RETURNING *;
        `;
        const params = [matchId, puuid];
        const result = await db.query(query, params);
        const updatedSummoner = result.rows[0];
        if (!updatedSummoner) {
            return null;
        }
        return updatedSummoner;
    } catch (error) {
        console.error('Error setting summoner:', error);
        throw new Error('Failed to delete summoner.');
    }
};

export const fetchRankHistory = async (
    entryParticipantId: string,
    startDate?: string,
    endDate?: string,
    queueType?: string
) => {
    try {
        const conditions: string[] = ['"entryParticipantId" = $1'];
        const params: Array<string> = [entryParticipantId];

        if (startDate) {
            params.push(startDate);
            conditions.push(`"lastUpdated" >= $${params.length}`);
        }

        if (endDate) {
            params.push(endDate);
            conditions.push(`"lastUpdated" <= $${params.length}`);
        }

        if (queueType) {
            params.push(queueType);
            conditions.push(`"queueType" = $${params.length}`);
        }

        const whereClause = conditions.length
            ? `WHERE ${conditions.join(' AND ')}`
            : '';

        const query = `
            SELECT * FROM rank_tracking
            ${whereClause}
            ORDER BY "lastUpdated" DESC
        `;

        const result = await db.query(query, params);
        return result.rows;
    } catch (error) {
        console.error('Error fetching rank history:', error);
        throw new Error('Failed to fetch rank history.');
    }
};

export const getMostRecentRankByParticipantIdAndQueueType = async (
    entryParticipantId: string,
    queueType: string
): Promise<any> => {
    try {
        const query = `
            SELECT * FROM rank_tracking
            WHERE "entryParticipantId" = $1 AND "queueType" = $2
            ORDER BY "lastUpdated" DESC
            LIMIT 1
        `;
        const params = [entryParticipantId, queueType];
        const result = await db.query(query, params);
        const mostRecentRank = result.rows[0];
        if (!mostRecentRank) {
            console.info(
                `No rank history found for participant ID ${entryParticipantId} and queue type ${queueType}.`
            );
            return {
                matchId: '0',
                rid: 0,
                entryParticipantId,
                tier: 'Unranked',
                rank: 'N/A',
                lp: 0,
                queueType,
                lastUpdated: new Date().toISOString(),
            };
        }
        return mostRecentRank;
    } catch (error) {
        console.error('Error retrieving most recent rank history:', error);
        throw new Error('Failed to retrieve rank history.');
    }
};

export interface LatestRankRow {
    entryParticipantId: string;
    tier: string;
    rank: string;
    lp: number;
    queueType: string;
    lastUpdated: string;
}

export const getLatestRanksForPuuids = async (
    puuids: string[],
    queueType: string
): Promise<LatestRankRow[]> => {
    if (puuids.length === 0) return [];
    try {
        const query = `
            SELECT DISTINCT ON ("entryParticipantId")
                "entryParticipantId", "tier", "rank", "lp", "queueType", "lastUpdated"
            FROM rank_tracking
            WHERE "entryParticipantId" = ANY($1) AND "queueType" = $2
            ORDER BY "entryParticipantId", "lastUpdated" DESC
        `;
        const result = await db.query(query, [puuids, queueType]);
        return result.rows;
    } catch (error) {
        console.error('Error retrieving latest ranks for puuids:', error);
        throw new Error('Failed to retrieve latest ranks.');
    }
};

export const getRankByMatchAndQueueType = async (
    matchId: string,
    entryParticipantId: string,
    queueType: string
): Promise<any> => {
    try {
        const query = `
            SELECT * FROM rank_tracking
            WHERE "matchId" = $1 AND "entryParticipantId" = $2 AND "queueType" = $3
            LIMIT 1
        `;
        const result = await db.query(query, [
            matchId,
            entryParticipantId,
            queueType,
        ]);
        return result.rows[0] ?? null;
    } catch (error) {
        console.error('Error retrieving rank by match ID:', error);
        throw new Error('Failed to retrieve rank by match ID.');
    }
};

export const createRankHistory = async (
    matchId: string,
    entryParticipantId: string,
    tier: string,
    rank: string,
    lp: number,
    queueType: string
) => {
    try {
        const query = `
            INSERT INTO rank_tracking (
                "matchId",
                "entryParticipantId",
                "tier",
                "rank",
                "lp",
                "queueType"
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT ("matchId", "entryParticipantId") DO NOTHING
            RETURNING *;
        `;
        const params = [matchId, entryParticipantId, tier, rank, lp, queueType];
        const result = await db.query(query, params);
        return result.rows[0];
    } catch (error) {
        console.error('Error creating rank history:', error);
        throw new Error('Failed to create rank history.');
    }
};

export const updateRankHistory = async (
    rid: number,
    tier: string,
    rank: string,
    lp: number,
    queueType: string
) => {
    try {
        const query = `
            UPDATE rank_tracking
            SET 
                "tier" = $1,
                "rank" = $2,
                "lp" = $3,
                "queueType" = $4,
                "lastUpdated" = NOW()
            WHERE "rid" = $5
            RETURNING *;
        `;
        const params = [tier, rank, lp, queueType, rid];
        const result = await db.query(query, params);
        const updatedRankHistory = result.rows[0];
        if (!updatedRankHistory) {
            console.info(`Rank history with RID ${rid} not found.`);
            return null;
        }
        return updatedRankHistory;
    } catch (error) {
        console.error('Error updating rank history:', error);
        throw new Error('Failed to update rank history.');
    }
};

export const deleteRankHistory = async (rid: number) => {
    try {
        const query = `
            DELETE FROM rank_tracking
            WHERE "rid" = $1
            RETURNING *;
        `;
        const params = [rid];
        const result = await db.query(query, params);
        const deletedRankHistory = result.rows[0];
        if (!deletedRankHistory) {
            return null;
        }
        return deletedRankHistory;
    } catch (error) {
        console.error('Error deleting rank history:', error);
        throw new Error('Failed to delete rank history.');
    }
};

export interface SquadSummonerSuggestion {
    gameName: string;
    tagLine: string | null;
    matchRegionPrefix: string | null;
    tier: string | null;
    rank: string | null;
    lp: number | null;
}

/**
 * Whole summoners matching one query, for Meeps' command picker.
 *
 * WHY THIS EXISTS ALONGSIDE `searchSummonerGameNames` / `searchSummonerTags`
 *
 * Those two answer Discord's autocomplete protocol, which returns
 * `{ name, value }` and therefore cannot fill more than the one option the
 * player is focused on. That is a limit of the protocol, not of the data - so
 * `/summoner` in Discord is necessarily two steps: choose a name, then choose a
 * tag from the list that name narrowed.
 *
 * Meeps' picker is ours, so it does not have to inherit that. This returns the
 * whole row, which lets one click fill `name` and `tag` together, and gives the
 * suggestion a rank to show underneath. The Discord handlers are untouched and
 * keep working exactly as they did.
 *
 * Squad-scoped by id rather than by guild: the caller already resolved the
 * scope (see `resolveCommandScope`), and going back through `guildId` here
 * would re-do that lookup to arrive at the same place.
 */
export async function searchSquadSummoners(
    squadId: string,
    search: string,
    limit = 25
): Promise<SquadSummonerSuggestion[]> {
    try {
        // "Louis#EUW" typed whole is the fastest path to the row somebody
        // means, and it is what they will paste from anywhere else.
        const raw = search.trim();
        const hashIndex = raw.lastIndexOf('#');
        const namePart = hashIndex > 0 ? raw.slice(0, hashIndex) : raw;
        const tagPart = hashIndex > 0 ? raw.slice(hashIndex + 1) : null;

        const conditions: string[] = [
            'ss.squad_id = $1',
            "s.game_id = 'league_of_legends'",
        ];
        const params: Array<string | number> = [squadId];

        if (namePart) {
            params.push(`${namePart}%`);
            const nameParam = `$${params.length}`;
            if (tagPart === null) {
                // No '#' typed yet, so the query could be either half.
                conditions.push(
                    `(s."gameName" ILIKE ${nameParam} OR s."tagLine" ILIKE ${nameParam})`
                );
            } else {
                conditions.push(`s."gameName" ILIKE ${nameParam}`);
            }
        }
        if (tagPart) {
            params.push(`${tagPart}%`);
            conditions.push(`s."tagLine" ILIKE $${params.length}`);
        }

        params.push(limit);
        const result = await db.query(
            `SELECT DISTINCT s."gameName", s."tagLine", s."matchRegionPrefix",
                    s."tier", s."rank", s."lp"
             FROM summoners s
             JOIN squad_summoners ss ON ss.puuid = s.puuid
             WHERE ${conditions.join(' AND ')}
             ORDER BY s."gameName" ASC, s."tagLine" ASC
             LIMIT $${params.length}`,
            params
        );
        return result.rows;
    } catch (error) {
        console.error('Error searching squad summoners:', error);
        throw new Error('Failed to search squad summoners.');
    }
}

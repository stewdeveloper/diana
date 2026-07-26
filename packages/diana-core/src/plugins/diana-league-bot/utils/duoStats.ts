import { db } from '../api/utils/db';
import { parseParticipants } from './interStats';
import {
    buildCompetitiveSqlFilter,
    DEFAULT_COMPETITIVE_SCOPE,
    type CompetitiveScope,
} from './queueClassification';

export interface DuoRecord {
    /** Matches where both players were on the same team (remakes excluded) */
    gamesTogether: number;
    winsTogether: number;
    lossesTogether: number;
    /** Matches where the players were on opposite teams */
    gamesAgainst: number;
    /** Of the games against each other, how many player A won */
    winsForAAgainstB: number;
}

/**
 * Shared-match record for two players from stored match data.
 *
 * match_details stores one row per tracked entry player, so the same match
 * appears once per tracked participant - DISTINCT ON ("matchId") counts each
 * match exactly once. Both-players filtering uses JSONB containment on the
 * GIN-indexed participants column.
 */
export async function getDuoRecord(
    puuidA: string,
    puuidB: string,
    sinceTimestamp = 0,
    scope: CompetitiveScope = DEFAULT_COMPETITIVE_SCOPE
): Promise<DuoRecord> {
    const result = await db.query(
        `SELECT DISTINCT ON (md."matchId")
                md."matchId", md."participants", md."gameDuration",
                md."queueId", md."gameMode"
         FROM match_details md
         WHERE md."participants" @> $1::jsonb
           AND md."participants" @> $2::jsonb
           AND md."gameCreation" IS NOT NULL
           AND md."gameCreation" >= $3
           ${buildCompetitiveSqlFilter('md', scope)}
         ORDER BY md."matchId"`,
        [
            JSON.stringify([{ puuid: puuidA }]),
            JSON.stringify([{ puuid: puuidB }]),
            sinceTimestamp,
        ]
    );

    const record: DuoRecord = {
        gamesTogether: 0,
        winsTogether: 0,
        lossesTogether: 0,
        gamesAgainst: 0,
        winsForAAgainstB: 0,
    };

    for (const row of result.rows) {
        if (Number(row.gameDuration ?? 0) < 300) continue; // remake
        const participants = parseParticipants(row.participants);
        const a = participants.find((p) => p.puuid === puuidA);
        const b = participants.find((p) => p.puuid === puuidB);
        if (!a || !b) continue;

        if (a.teamId != null && b.teamId != null && a.teamId === b.teamId) {
            record.gamesTogether += 1;
            if (a.win) record.winsTogether += 1;
            else record.lossesTogether += 1;
        } else {
            record.gamesAgainst += 1;
            if (a.win) record.winsForAAgainstB += 1;
        }
    }

    return record;
}

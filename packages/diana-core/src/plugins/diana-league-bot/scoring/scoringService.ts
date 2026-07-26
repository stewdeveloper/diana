import { db } from '../api/utils/db';
import { calculateMatchScores, type PlayerScore } from './scoringAlgorithm';
import { buildCompetitiveSqlFilter } from '../utils/queueClassification';

export interface MatchScoreRow {
    sid: number;
    matchId: string;
    puuid: string;
    score: number;
    placement: number;
    role: string;
    win: boolean;
    createdAt: string;
}

export async function saveMatchScores(
    matchId: string,
    scores: PlayerScore[]
): Promise<void> {
    for (const s of scores) {
        await db.query(
            `INSERT INTO match_scores ("matchId", "puuid", "score", "placement", "role", "win")
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT ("matchId", "puuid") DO NOTHING`,
            [matchId, s.puuid, s.score, s.placement, s.role, s.win]
        );
    }
}

export async function getMatchScore(
    matchId: string,
    puuid: string
): Promise<MatchScoreRow | null> {
    try {
        const result = await db.query(
            `SELECT * FROM match_scores WHERE "matchId" = $1 AND "puuid" = $2`,
            [matchId, puuid]
        );
        return result.rows[0] ?? null;
    } catch (error) {
        console.error('Error retrieving match score:', error);
        return null;
    }
}

export async function backfillMissingScores(
    sinceTimestamp: number
): Promise<number> {
    // Always 'all', never the per-guild scope: this is write-time, and a match
    // is scored once globally for every guild. The filter's only job here is to
    // keep Arena out - without it, /mvp and /iotw call this on a thin week and
    // silently recreate the Arena rows migration 013 deleted.
    const result = await db.query(
        `SELECT DISTINCT md."matchId", md."participants"
         FROM match_details md
         WHERE md."gameCreation" >= $1
           AND NOT EXISTS (
               SELECT 1 FROM match_scores ms WHERE ms."matchId" = md."matchId"
           )
           ${buildCompetitiveSqlFilter('md', 'all')}`,
        [sinceTimestamp]
    );

    let backfilled = 0;
    for (const row of result.rows) {
        try {
            const participants =
                typeof row.participants === 'string'
                    ? JSON.parse(row.participants)
                    : row.participants;
            if (!Array.isArray(participants) || participants.length === 0)
                continue;
            const scores = calculateMatchScores(
                participants as Record<string, any>[]
            );
            await saveMatchScores(row.matchId, scores);
            backfilled++;
        } catch (err) {
            console.error(
                `[Error] Failed to backfill scores for match ${row.matchId}:`,
                err
            );
        }
    }
    return backfilled;
}

export async function getMatchScores(
    matchId: string
): Promise<MatchScoreRow[]> {
    try {
        const result = await db.query(
            `SELECT * FROM match_scores WHERE "matchId" = $1 ORDER BY "placement" ASC`,
            [matchId]
        );
        return result.rows;
    } catch (error) {
        console.error('Error retrieving match scores:', error);
        return [];
    }
}

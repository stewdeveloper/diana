import { db } from '../api/utils/db';
import { parseParticipants } from './interStats';
import { getTotalPoints } from '../api/utils/rankService';
import {
    countsForCompetition,
    type CompetitiveScope,
} from './queueClassification';

export interface MatchResultRow {
    matchId: string;
    /** null when the entry player could not be found in the stored data */
    win: boolean | null;
    isRemake: boolean;
    queueId: number | null;
    gameMode: string | null;
}

export interface Streak {
    kind: 'win' | 'loss';
    length: number;
}

export const WIN_STREAK_THRESHOLDS = [3, 5, 7, 10];
export const LOSS_STREAK_THRESHOLDS = [3, 5];

/** Recent match results for a player, newest first. */
export async function fetchRecentResultsForPuuid(
    puuid: string,
    limit = 10
): Promise<MatchResultRow[]> {
    // match_details is UNIQUE(matchId, entryPlayerPuuid), so rows are
    // already one-per-match for a single player.
    // Deliberately unfiltered by queue: one read has to serve every guild's
    // competitive scope, so callers narrow it with `filterCompetitiveResults`.
    const result = await db.query(
        `SELECT md."matchId", md."gameDuration", md."participants",
                md."queueId", md."gameMode"
         FROM match_details md
         WHERE md."entryPlayerPuuid" = $1
           AND md."gameCreation" IS NOT NULL
         ORDER BY md."gameCreation" DESC
         LIMIT $2`,
        [puuid, limit]
    );
    return result.rows.map((row: Record<string, unknown>) => {
        const participant = parseParticipants(row.participants as string).find(
            (p) => p.puuid === puuid
        );
        return {
            matchId: row.matchId as string,
            win: participant?.win ?? null,
            isRemake: Number(row.gameDuration ?? 0) < 300,
            queueId: row.queueId != null ? Number(row.queueId) : null,
            gameMode: (row.gameMode as string) ?? null,
        };
    });
}

/** Narrow raw results to the queues a given scope counts. */
export function filterCompetitiveResults(
    rows: MatchResultRow[],
    scope: CompetitiveScope
): MatchResultRow[] {
    return rows.filter((row) => countsForCompetition(row, scope));
}

/**
 * Current win/loss streak from results ordered newest first. Remakes are
 * skipped; a match with unknown result ends the streak.
 */
export function computeWinLossStreak(rows: MatchResultRow[]): Streak | null {
    let kind: 'win' | 'loss' | null = null;
    let length = 0;

    for (const row of rows) {
        if (row.isRemake) continue;
        if (row.win === null) break;
        const rowKind = row.win ? 'win' : 'loss';
        if (kind === null) kind = rowKind;
        if (rowKind !== kind) break;
        length += 1;
    }

    return kind && length > 0 ? { kind, length } : null;
}

/**
 * True when a streak sits exactly on an announcement threshold. Because the
 * streak length is deterministic per match, each threshold fires once.
 */
export function isStreakThreshold(streak: Streak): boolean {
    const thresholds =
        streak.kind === 'win' ? WIN_STREAK_THRESHOLDS : LOSS_STREAK_THRESHOLDS;
    return thresholds.includes(streak.length);
}

export interface RankHistoryPoint {
    matchId: string;
    tier: string;
    rank: string;
    lp: number;
}

export type RankMilestone = 'new_peak' | 'first_time_tier';

/**
 * Detect a rank milestone for the just-finished match.
 *
 * - 'first_time_tier': the player has never been at this tier before and it
 *   is above everything in their history.
 * - 'new_peak': strictly above every previous rank, but only when the peak
 *   being beaten was NOT set in the immediately previous match — otherwise
 *   every win while climbing would announce a "new peak".
 *
 * History rows are expected newest first and may include the current match
 * (it is excluded via currentMatchId).
 */
export function detectRankMilestone(
    history: RankHistoryPoint[],
    current: { tier: string; rank: string; lp: number },
    currentMatchId: string
): RankMilestone | null {
    const currentPoints = getTotalPoints(
        current.tier,
        current.rank,
        current.lp
    );
    if (currentPoints === null) return null;

    const previousRows = history.filter(
        (row) => row.matchId !== currentMatchId
    );
    const previousPoints = previousRows
        .map((row) => ({
            row,
            points: getTotalPoints(row.tier, row.rank, row.lp),
        }))
        .filter(
            (entry): entry is { row: RankHistoryPoint; points: number } =>
                entry.points !== null
        );

    if (previousPoints.length === 0) return null;

    const maxBefore = Math.max(...previousPoints.map((e) => e.points));
    if (currentPoints <= maxBefore) return null;

    const seenTiers = new Set(
        previousRows.map((row) => row.tier?.toUpperCase?.() ?? row.tier)
    );
    if (!seenTiers.has(current.tier.toUpperCase())) {
        return 'first_time_tier';
    }

    // Skip "new peak" when the previous match already held the peak — the
    // player is just continuing a climb, not reclaiming an old high.
    const previousMatchPoints = previousPoints[0]?.points;
    if (previousMatchPoints === maxBefore) return null;

    return 'new_peak';
}

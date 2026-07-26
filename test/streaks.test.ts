jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({
        db: {
            query: jest.fn(),
        },
    })
);

import { db } from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db';
import {
    filterCompetitiveResults,
    computeWinLossStreak,
    isStreakThreshold,
    detectRankMilestone,
    fetchRecentResultsForPuuid,
    type MatchResultRow,
    type RankHistoryPoint,
} from '../packages/diana-core/src/plugins/diana-league-bot/utils/streaks';

const queryMock = db.query as unknown as jest.Mock;

function result(
    win: boolean | null,
    isRemake = false,
    matchId = 'm',
    queueId: number | null = 420,
    gameMode: string | null = 'CLASSIC'
): MatchResultRow {
    return { matchId, win, isRemake, queueId, gameMode };
}

describe('computeWinLossStreak', () => {
    it('counts consecutive wins from the most recent match', () => {
        const streak = computeWinLossStreak([
            result(true),
            result(true),
            result(true),
            result(false),
            result(true),
        ]);
        expect(streak).toEqual({ kind: 'win', length: 3 });
    });

    it('counts consecutive losses', () => {
        const streak = computeWinLossStreak([
            result(false),
            result(false),
            result(true),
        ]);
        expect(streak).toEqual({ kind: 'loss', length: 2 });
    });

    it('skips remakes without breaking the streak', () => {
        const streak = computeWinLossStreak([
            result(true),
            result(null, true),
            result(true),
            result(false),
        ]);
        expect(streak).toEqual({ kind: 'win', length: 2 });
    });

    it('stops at a match with unknown result', () => {
        const streak = computeWinLossStreak([
            result(true),
            result(null),
            result(true),
        ]);
        expect(streak).toEqual({ kind: 'win', length: 1 });
    });

    it('returns null for no matches', () => {
        expect(computeWinLossStreak([])).toBeNull();
    });

    it('returns null when only remakes exist', () => {
        expect(
            computeWinLossStreak([result(null, true), result(null, true)])
        ).toBeNull();
    });
});

describe('isStreakThreshold', () => {
    it('fires exactly on win thresholds', () => {
        expect(isStreakThreshold({ kind: 'win', length: 3 })).toBe(true);
        expect(isStreakThreshold({ kind: 'win', length: 4 })).toBe(false);
        expect(isStreakThreshold({ kind: 'win', length: 5 })).toBe(true);
        expect(isStreakThreshold({ kind: 'win', length: 10 })).toBe(true);
    });

    it('fires exactly on loss thresholds', () => {
        expect(isStreakThreshold({ kind: 'loss', length: 3 })).toBe(true);
        expect(isStreakThreshold({ kind: 'loss', length: 4 })).toBe(false);
        expect(isStreakThreshold({ kind: 'loss', length: 5 })).toBe(true);
        expect(isStreakThreshold({ kind: 'loss', length: 7 })).toBe(false);
    });
});

describe('detectRankMilestone', () => {
    // History is newest-first and includes the current match row.
    function historyPoint(
        matchId: string,
        tier: string,
        rank: string,
        lp: number
    ): RankHistoryPoint {
        return { matchId, tier, rank, lp };
    }

    it('detects a first-time tier', () => {
        const history = [
            historyPoint('current', 'PLATINUM', 'IV', 10),
            historyPoint('m2', 'GOLD', 'I', 75),
            historyPoint('m1', 'GOLD', 'I', 50),
            historyPoint('INIT', 'GOLD', 'II', 0),
        ];
        const milestone = detectRankMilestone(
            history,
            { tier: 'PLATINUM', rank: 'IV', lp: 10 },
            'current'
        );
        expect(milestone).toBe('first_time_tier');
    });

    it('detects a reclaimed peak (peak not set in previous match)', () => {
        const history = [
            historyPoint('current', 'GOLD', 'I', 90),
            historyPoint('m3', 'GOLD', 'II', 40),
            historyPoint('m2', 'GOLD', 'I', 80),
            historyPoint('m1', 'GOLD', 'II', 60),
        ];
        const milestone = detectRankMilestone(
            history,
            { tier: 'GOLD', rank: 'I', lp: 90 },
            'current'
        );
        expect(milestone).toBe('new_peak');
    });

    it('does not announce a new peak while continuously climbing', () => {
        const history = [
            historyPoint('current', 'GOLD', 'I', 90),
            historyPoint('m2', 'GOLD', 'I', 70),
            historyPoint('m1', 'GOLD', 'II', 60),
        ];
        const milestone = detectRankMilestone(
            history,
            { tier: 'GOLD', rank: 'I', lp: 90 },
            'current'
        );
        expect(milestone).toBeNull();
    });

    it('returns null when below the previous peak', () => {
        const history = [
            historyPoint('current', 'GOLD', 'III', 10),
            historyPoint('m1', 'GOLD', 'I', 80),
        ];
        const milestone = detectRankMilestone(
            history,
            { tier: 'GOLD', rank: 'III', lp: 10 },
            'current'
        );
        expect(milestone).toBeNull();
    });

    it('returns null without any prior history', () => {
        const history = [historyPoint('current', 'GOLD', 'III', 10)];
        const milestone = detectRankMilestone(
            history,
            { tier: 'GOLD', rank: 'III', lp: 10 },
            'current'
        );
        expect(milestone).toBeNull();
    });

    it('ignores unmappable ranks (Unranked)', () => {
        const history = [
            historyPoint('current', 'GOLD', 'IV', 10),
            historyPoint('INIT', 'UNRANKED', 'IV', 0),
        ];
        const milestone = detectRankMilestone(
            history,
            { tier: 'GOLD', rank: 'IV', lp: 10 },
            'current'
        );
        expect(milestone).toBeNull();
    });
});

describe('fetchRecentResultsForPuuid', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('maps rows to results with remake detection', async () => {
        queryMock.mockResolvedValue({
            rows: [
                {
                    matchId: 'm2',
                    gameDuration: 1800,
                    participants: JSON.stringify([{ puuid: 'p1', win: true }]),
                },
                {
                    matchId: 'm1',
                    gameDuration: 200,
                    participants: JSON.stringify([{ puuid: 'p1', win: false }]),
                },
            ],
        });

        const results = await fetchRecentResultsForPuuid('p1', 10);

        expect(results).toEqual([
            {
                matchId: 'm2',
                win: true,
                isRemake: false,
                queueId: null,
                gameMode: null,
            },
            {
                matchId: 'm1',
                win: false,
                isRemake: true,
                queueId: null,
                gameMode: null,
            },
        ]);
        const [query, params] = queryMock.mock.calls[0];
        expect(query).toContain('entryPlayerPuuid');
        expect(params).toEqual(['p1', 10]);
    });

    it('returns null win when the player is missing from participants', async () => {
        queryMock.mockResolvedValue({
            rows: [
                {
                    matchId: 'm1',
                    gameDuration: 1800,
                    participants: JSON.stringify([
                        { puuid: 'other', win: true },
                    ]),
                },
            ],
        });

        const results = await fetchRecentResultsForPuuid('p1');
        expect(results[0].win).toBeNull();
    });
});

describe('filterCompetitiveResults', () => {
    const arena = result(true, false, 'arena-1', 1750, 'CHERRY');
    const aram = result(true, false, 'aram-1', 450, 'ARAM');
    const solo = result(true, false, 'solo-1', 420, 'CLASSIC');

    it('drops Arena under every scope', () => {
        expect(filterCompetitiveResults([arena, solo], 'all')).toEqual([solo]);
        expect(filterCompetitiveResults([arena, solo], 'ranked')).toEqual([
            solo,
        ]);
    });

    it("keeps non-ranked queues under 'all'", () => {
        expect(filterCompetitiveResults([aram, solo], 'all')).toEqual([
            aram,
            solo,
        ]);
    });

    it("keeps only ranked queues under 'ranked'", () => {
        expect(filterCompetitiveResults([aram, solo], 'ranked')).toEqual([
            solo,
        ]);
    });

    it('lets an Arena game sit inside a streak without breaking it', () => {
        // Arena is removed rather than counted as a loss, so three ranked wins
        // either side of an Arena game are still a 3-win streak.
        const rows = [
            result(true, false, 'w3', 420, 'CLASSIC'),
            arena,
            result(true, false, 'w2', 420, 'CLASSIC'),
            result(true, false, 'w1', 420, 'CLASSIC'),
        ];
        const streak = computeWinLossStreak(
            filterCompetitiveResults(rows, 'all')
        );
        expect(streak).toEqual({ kind: 'win', length: 3 });
    });

    it('an Arena loss does not end a win streak', () => {
        const rows = [
            result(false, false, 'arena-loss', 1750, 'CHERRY'),
            result(true, false, 'w2', 420, 'CLASSIC'),
            result(true, false, 'w1', 420, 'CLASSIC'),
        ];
        expect(computeWinLossStreak(rows)?.kind).toBe('loss');
        expect(
            computeWinLossStreak(filterCompetitiveResults(rows, 'all'))
        ).toEqual({ kind: 'win', length: 2 });
    });
});

import {
    determineR6RankMovement,
    getR6RpChange,
    getR6RpToNextRank,
    formatR6Rank,
    fallbackRankLadder,
    rungForOrdinal,
} from '../packages/diana-core/src/plugins/diana-r6-bot/api/utils/rankService';

describe('r6RankService', () => {
    describe('determineR6RankMovement', () => {
        it('returns promoted when tier increases', () => {
            expect(
                determineR6RankMovement('Gold', 2, 2800, 'Platinum', 5, 3000)
            ).toBe('promoted');
        });

        it('returns demoted when tier decreases', () => {
            expect(
                determineR6RankMovement('Platinum', 5, 3000, 'Gold', 1, 2900)
            ).toBe('demoted');
        });

        it('returns promoted when division improves within a tier', () => {
            // V → IV is a promotion: a lower number is a higher division.
            expect(
                determineR6RankMovement('Gold', 5, 2500, 'Gold', 4, 3000)
            ).toBe('promoted');
        });

        it('returns demoted when division worsens within a tier', () => {
            expect(
                determineR6RankMovement('Gold', 4, 3000, 'Gold', 5, 2500)
            ).toBe('demoted');
        });

        it('returns no_change when only RP moved', () => {
            expect(
                determineR6RankMovement('Diamond', 2, 4600, 'Diamond', 2, 4750)
            ).toBe('no_change');
        });

        it('returns no_change for an unranked or unknown tier', () => {
            // Guards the first poll of a new player: "Unranked → Copper" must
            // not be announced as a promotion.
            expect(
                determineR6RankMovement('Unranked', 0, 0, 'Copper', 5, 100)
            ).toBe('no_change');
            expect(
                determineR6RankMovement('Copper', 5, 100, 'Mythic', 1, 9000)
            ).toBe('no_change');
        });

        it('handles a divisionless rung on either side', () => {
            // Pre-Ranked-3.0 rows stored Champion with division 0; comparing
            // one against a divisioned rung must not read as movement.
            expect(
                determineR6RankMovement(
                    'Champion',
                    0,
                    5200,
                    'Champion',
                    1,
                    5600
                )
            ).toBe('no_change');
            expect(
                determineR6RankMovement('Diamond', 1, 4900, 'Champion', 5, 5000)
            ).toBe('promoted');
        });
    });

    describe('getR6RpChange', () => {
        it('is signed', () => {
            expect(getR6RpChange(3000, 3120)).toBe(120);
            expect(getR6RpChange(3120, 3000)).toBe(-120);
        });
    });

    describe('fallbackRankLadder', () => {
        it('is the 40-rung Ranked 3.0 ladder, five divisions per tier', () => {
            const ladder = fallbackRankLadder();
            expect(ladder).toHaveLength(40);
            expect(ladder[0]!.label).toBe('Copper V');
            expect(ladder[39]!.label).toBe('Champion I');
        });

        it('numbers ordinals contiguously from 1', () => {
            const ladder = fallbackRankLadder();
            expect(ladder.map((r) => r.ordinal)).toEqual(
                Array.from({ length: 40 }, (_, i) => i + 1)
            );
        });

        it('descends the numeral as the ordinal climbs within a tier', () => {
            const copper = fallbackRankLadder().filter(
                (r) => r.tier === 'Copper'
            );
            expect(copper.map((r) => r.label)).toEqual([
                'Copper V',
                'Copper IV',
                'Copper III',
                'Copper II',
                'Copper I',
            ]);
        });

        it('carries no RP thresholds, so nothing invents them offline', () => {
            expect(fallbackRankLadder().every((r) => r.minRp === null)).toBe(
                true
            );
        });
    });

    describe('rungForOrdinal', () => {
        const ladder = fallbackRankLadder();

        it('finds a rung by the provider ordinal', () => {
            expect(rungForOrdinal(ladder, 22)?.label).toBe('Platinum IV');
        });

        it('is null for unranked and for anything off the ladder', () => {
            for (const ordinal of [0, -1, 999, NaN]) {
                expect(rungForOrdinal(ladder, ordinal)).toBeNull();
            }
        });
    });

    describe('getR6RpToNextRank', () => {
        const withThresholds = [
            {
                ordinal: 1,
                tier: 'Copper',
                division: 5,
                label: 'Copper V',
                minRp: 0,
                iconUrl: null,
            },
            {
                ordinal: 2,
                tier: 'Copper',
                division: 4,
                label: 'Copper IV',
                minRp: 100,
                iconUrl: null,
            },
        ];

        it('counts up to the next rung', () => {
            expect(getR6RpToNextRank(withThresholds, 1, 40)).toEqual({
                rpNeeded: 60,
                nextRankName: 'Copper IV',
            });
        });

        it('never reports a negative requirement', () => {
            expect(getR6RpToNextRank(withThresholds, 1, 9999)?.rpNeeded).toBe(
                0
            );
        });

        it('is null at the top of the ladder', () => {
            expect(getR6RpToNextRank(withThresholds, 2, 150)).toBeNull();
        });

        it('is null for an ordinal that is not on the ladder', () => {
            expect(getR6RpToNextRank(withThresholds, 99, 0)).toBeNull();
        });

        it('is null when the ladder carries no thresholds', () => {
            // The static fallback has none, and a made-up "120 RP to Copper IV"
            // would read as fact in a Discord embed.
            expect(getR6RpToNextRank(fallbackRankLadder(), 1, 0)).toBeNull();
        });
    });

    describe('formatR6Rank', () => {
        it('renders tier, numeral and RP', () => {
            expect(formatR6Rank('Platinum', 4, 3200)).toBe(
                'Platinum IV (3200 RP)'
            );
            expect(formatR6Rank('Copper', 5, 40)).toBe('Copper V (40 RP)');
        });

        it('drops the numeral for a divisionless rung', () => {
            expect(formatR6Rank('Unranked', 0, 0)).toBe('Unranked (0 RP)');
        });
    });
});

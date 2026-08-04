import {
    parseRankLabel,
    parseLadder,
    selectRankedProfile,
    toSnapshot,
} from '../packages/diana-core/src/plugins/diana-r6-bot/api/utils/r6DataService';
import { fallbackRankLadder } from '../packages/diana-core/src/plugins/diana-r6-bot/api/utils/rankService';

/**
 * The r6data mapping is the one piece of the client with real logic in it, and
 * the piece that cannot be exercised without an API key — so it is tested
 * against the response shapes r6data documents.
 *
 * Two of those shapes are only partly documented: the `/api/ranks` payload,
 * and what the numeric `rank` on a stats profile indexes into. Both are read
 * defensively, and these cases pin that defensiveness rather than a guess.
 */
describe('parseRankLabel', () => {
    it('splits a tier and its Roman division, including V and IV', () => {
        expect(parseRankLabel('Copper V')).toEqual({
            tier: 'Copper',
            division: 5,
        });
        expect(parseRankLabel('Platinum IV')).toEqual({
            tier: 'Platinum',
            division: 4,
        });
        expect(parseRankLabel('Champion I')).toEqual({
            tier: 'Champion',
            division: 1,
        });
    });

    it('keeps an undivided label whole rather than dropping it', () => {
        // Pre-Ranked-3.0 Champion had no division; such a label must still
        // render as "Champion", not vanish into "Unranked".
        expect(parseRankLabel('Champion')).toEqual({
            tier: 'Champion',
            division: 0,
        });
    });

    it('falls back to Unranked for missing input', () => {
        for (const value of [null, undefined, '', '   ']) {
            expect(parseRankLabel(value)).toEqual({
                tier: 'Unranked',
                division: 0,
            });
        }
    });
});

describe('parseLadder', () => {
    const rows = [
        { id: 2, name: 'Copper IV', min_mmr: 100, image: 'https://x/2.png' },
        { id: 1, name: 'Copper V', min_mmr: 0, image: 'https://x/1.png' },
    ];

    it('reads a bare array and sorts by ordinal', () => {
        const ladder = parseLadder(rows)!;
        expect(ladder.map((r) => r.label)).toEqual(['Copper V', 'Copper IV']);
        expect(ladder[0]).toEqual({
            ordinal: 1,
            tier: 'Copper',
            division: 5,
            label: 'Copper V',
            minRp: 0,
            iconUrl: 'https://x/1.png',
        });
    });

    it('unwraps the common envelope spellings', () => {
        // The docs do not say whether the payload is bare, {data}, or {ranks},
        // so all three are accepted rather than guessed at.
        expect(parseLadder({ data: rows })).toHaveLength(2);
        expect(parseLadder({ ranks: rows })).toHaveLength(2);
    });

    it('tolerates alternative field spellings', () => {
        const ladder = parseLadder([
            {
                rank_id: 3,
                rank_name: 'Copper III',
                imageUrl: 'https://x/3.png',
            },
        ])!;
        expect(ladder[0]!.label).toBe('Copper III');
        expect(ladder[0]!.iconUrl).toBe('https://x/3.png');
    });

    it('skips rows missing a name or an ordinal', () => {
        const ladder = parseLadder([
            { id: 1, name: 'Copper V' },
            { id: 2 },
            { name: 'Bronze V' },
        ])!;
        expect(ladder.map((r) => r.label)).toEqual(['Copper V']);
    });

    it('returns null — not an empty ladder — for an unusable payload', () => {
        // Null is what makes the caller fall through to the static ladder.
        // An empty array would render every player as "Unranked" forever.
        for (const body of [null, undefined, {}, [], { data: 'nope' }]) {
            expect(parseLadder(body)).toBeNull();
        }
    });
});

describe('selectRankedProfile', () => {
    function statsBody(boards: unknown) {
        return {
            platform_families_full_profiles: [
                { profile_id: 'p1', board_ids_full_profiles: boards },
            ],
        } as never;
    }

    it('prefers the ranked board over casual', () => {
        const body = statsBody([
            {
                board_id: 'casual',
                full_profiles: [{ season_id: 40, profile: { rank_points: 1 } }],
            },
            {
                board_id: 'ranked',
                full_profiles: [{ season_id: 40, profile: { rank_points: 2 } }],
            },
        ]);
        expect(selectRankedProfile(body)?.rank_points).toBe(2);
    });

    it('takes the newest season, not the first listed', () => {
        const body = statsBody([
            {
                board_id: 'ranked',
                full_profiles: [
                    { season_id: 39, profile: { rank_points: 100 } },
                    { season_id: 41, profile: { rank_points: 900 } },
                    { season_id: 40, profile: { rank_points: 500 } },
                ],
            },
        ]);
        expect(selectRankedProfile(body)?.rank_points).toBe(900);
    });

    it('returns null when there is nothing to read', () => {
        expect(selectRankedProfile(undefined)).toBeNull();
        expect(selectRankedProfile({})).toBeNull();
        expect(selectRankedProfile(statsBody([]))).toBeNull();
    });
});

describe('toSnapshot', () => {
    const ladder = fallbackRankLadder();
    const account = {
        username: 'Fishy.EU',
        platform: 'uplay',
        profile_id: 'abc-123',
    };
    const stats = {
        platform_families_full_profiles: [
            {
                profile_id: 'abc-123',
                board_ids_full_profiles: [
                    {
                        board_id: 'ranked',
                        full_profiles: [
                            {
                                season_id: 41,
                                profile: {
                                    rank: 22,
                                    rank_points: 3200,
                                    max_rank: 24,
                                    kills: 4200,
                                    deaths: 3700,
                                    wins: 310,
                                    losses: 280,
                                },
                            },
                        ],
                    },
                ],
            },
        ],
    } as never;

    it('resolves the numeric rank through the ladder', () => {
        const snapshot = toSnapshot(
            account,
            stats,
            ladder,
            'Fishy.EU',
            'uplay'
        );
        // Ordinal 22 on the 40-rung ladder: fifth tier (Platinum), fourth rung.
        expect(snapshot.rank).toEqual({
            tier: 'Platinum',
            division: 4,
            rp: 3200,
        });
        expect(snapshot.rankOrdinal).toBe(22);
        expect(snapshot.maxRankOrdinal).toBe(24);
        expect(snapshot.ubisoftId).toBe('abc-123');
        expect(snapshot.gameName).toBe('Fishy.EU');
    });

    it('derives K/D from the raw counters r6data reports', () => {
        expect(toSnapshot(account, stats, ladder, 'x', 'uplay').kd).toBeCloseTo(
            4200 / 3700
        );
    });

    it('reports K/D as null rather than Infinity with no deaths', () => {
        const noDeaths = {
            platform_families_full_profiles: [
                {
                    board_ids_full_profiles: [
                        {
                            board_id: 'ranked',
                            full_profiles: [
                                {
                                    season_id: 41,
                                    profile: { rank: 1, kills: 5, deaths: 0 },
                                },
                            ],
                        },
                    ],
                },
            ],
        } as never;
        expect(
            toSnapshot(account, noDeaths, ladder, 'x', 'uplay').kd
        ).toBeNull();
    });

    it('never claims live presence, which Siege has no source for', () => {
        expect(
            toSnapshot(account, stats, ladder, 'x', 'uplay').isInGame
        ).toBeNull();
    });

    it('reads an empty profile as Unranked with zeroed counters, not NaN', () => {
        const snapshot = toSnapshot(undefined, undefined, ladder, 'New', 'psn');
        expect(snapshot.rank).toEqual({
            tier: 'Unranked',
            division: 0,
            rp: 0,
        });
        expect(snapshot.stats).toEqual({
            kills: 0,
            deaths: 0,
            wins: 0,
            losses: 0,
        });
        expect(snapshot.rankOrdinal).toBe(0);
        expect(snapshot.maxRankOrdinal).toBeNull();
        // Falls back to what the caller asked for rather than going blank.
        expect(snapshot.gameName).toBe('New');
        expect(snapshot.platform).toBe('psn');
    });

    it('reads an off-ladder ordinal as Unranked rather than crashing', () => {
        const offLadder = {
            platform_families_full_profiles: [
                {
                    board_ids_full_profiles: [
                        {
                            board_id: 'ranked',
                            full_profiles: [
                                { season_id: 41, profile: { rank: 999 } },
                            ],
                        },
                    ],
                },
            ],
        } as never;
        expect(
            toSnapshot(account, offLadder, ladder, 'x', 'uplay').rank.tier
        ).toBe('Unranked');
    });
});

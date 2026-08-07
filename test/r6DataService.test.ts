import {
    parseRankLabel,
    parseLadder,
    selectRankedProfile,
    selectRankedEntry,
    toSnapshot,
    R6DataService,
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

    it('parses a pathological label in linear time', () => {
        // js/polynomial-redos (high): the previous
        // /^(.*?)\s+(V|IV|I{1,3})$/i let `.*?` and `\s+` both consume a
        // space, so a label that is a long run of them backtracked
        // quadratically. Ladder labels come off the provider's undocumented
        // /api/ranks payload, so this is attacker-adjacent input.
        const started = Date.now();
        expect(parseRankLabel(`${' '.repeat(50_000)}X`).division).toBe(0);
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('keeps the tier when the trailing token is not a division', () => {
        expect(parseRankLabel('Copper VI')).toEqual({
            tier: 'Copper VI',
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

    it('falls back to another board when ranked is present but empty', () => {
        // Preferring `ranked` must not mean abandoning the whole platform
        // family when it happens to carry no seasons — the casual board next
        // to it is the only thing this player has.
        const body = statsBody([
            { board_id: 'ranked', full_profiles: [] },
            {
                board_id: 'casual',
                full_profiles: [{ season_id: 40, profile: { rank_points: 7 } }],
            },
        ]);
        expect(selectRankedProfile(body)?.rank_points).toBe(7);
    });

    it('keeps an entry that carries only season_statistics', () => {
        // The counters are the whole point of the entry; one with no `profile`
        // still has this season's kills and W/L in it.
        const body = statsBody([
            {
                board_id: 'ranked',
                full_profiles: [
                    { season_id: 41, season_statistics: { kills: 12 } },
                ],
            },
        ]);
        expect(selectRankedEntry(body)?.season_statistics?.kills).toBe(12);
        expect(selectRankedProfile(body)).toBeNull();
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

    it('reads counters from season_statistics when the profile has none', () => {
        // r6data documents both spellings and does not say which a ranked
        // board returns. Reading only `profile` renders a real player as
        // 0 kills / 0W 0L with a null K/D, and stores that as the session
        // baseline — silently, in both cases.
        const seasonOnly = {
            platform_families_full_profiles: [
                {
                    board_ids_full_profiles: [
                        {
                            board_id: 'ranked',
                            full_profiles: [
                                {
                                    season_id: 41,
                                    profile: { rank: 22, rank_points: 3200 },
                                    season_statistics: {
                                        kills: 900,
                                        deaths: 600,
                                        match_outcomes: {
                                            wins: 40,
                                            losses: 30,
                                            abandons: 2,
                                        },
                                    },
                                },
                            ],
                        },
                    ],
                },
            ],
        } as never;
        const snapshot = toSnapshot(account, seasonOnly, ladder, 'x', 'uplay');
        expect(snapshot.stats).toEqual({
            kills: 900,
            deaths: 600,
            wins: 40,
            losses: 30,
            // Spelled `abandons` under `match_outcomes` and `abandon` on
            // `profile`. Both are read, for the same reason the four above are.
            abandons: 2,
        });
        expect(snapshot.kd).toBeCloseTo(1.5);
        // The rank still comes off `profile` — only the counters fall back.
        expect(snapshot.rank.rp).toBe(3200);
    });

    it('prefers the profile counters when both places carry them', () => {
        const both = {
            platform_families_full_profiles: [
                {
                    board_ids_full_profiles: [
                        {
                            board_id: 'ranked',
                            full_profiles: [
                                {
                                    season_id: 41,
                                    profile: { rank: 22, kills: 7, deaths: 1 },
                                    season_statistics: { kills: 999 },
                                },
                            ],
                        },
                    ],
                },
            ],
        } as never;
        expect(
            toSnapshot(account, both, ladder, 'x', 'uplay').stats.kills
        ).toBe(7);
    });

    it('reads a genuine zero as zero, not as a missing counter', () => {
        // `firstNum` exists to tell "absent" from "0"; a player with 0 wins
        // must not fall through to whatever season_statistics happens to say.
        const zeroed = {
            platform_families_full_profiles: [
                {
                    board_ids_full_profiles: [
                        {
                            board_id: 'ranked',
                            full_profiles: [
                                {
                                    season_id: 41,
                                    profile: { rank: 22, wins: 0 },
                                    season_statistics: {
                                        match_outcomes: { wins: 55 },
                                    },
                                },
                            ],
                        },
                    ],
                },
            ],
        } as never;
        expect(
            toSnapshot(account, zeroed, ladder, 'x', 'uplay').stats.wins
        ).toBe(0);
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
            abandons: 0,
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

describe('R6DataService.getRankLadder', () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
        jest.restoreAllMocks();
    });

    function respondOnce(bodies: unknown[]) {
        let call = 0;
        const mock = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => bodies[Math.min(call++, bodies.length - 1)],
        }));
        global.fetch = mock as unknown as typeof fetch;
        return mock;
    }

    const goodLadder = [{ id: 1, name: 'Copper V', min_mmr: 1000 }];

    it('memoises a ladder it could parse', async () => {
        const mock = respondOnce([goodLadder]);
        const service = new R6DataService('key');

        expect((await service.getRankLadder())[0]?.minRp).toBe(1000);
        await service.getRankLadder();

        expect(mock).toHaveBeenCalledTimes(1);
    });

    it('retries after an unrecognised shape instead of pinning the fallback', async () => {
        // The static fallback carries no RP thresholds by design, so memoising
        // it would leave `getR6RpToNextRank` returning null for the life of the
        // process. An unparseable `/api/ranks` is the likeliest failure here —
        // it is the half of the vendor schema the docs do not pin down — so it
        // has to recover on the next poll, not the next restart.
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const mock = respondOnce([{ nothing: 'useful' }, goodLadder]);
        const service = new R6DataService('key');

        expect((await service.getRankLadder())[0]?.minRp).toBeNull();
        expect((await service.getRankLadder())[0]?.minRp).toBe(1000);
        expect(mock).toHaveBeenCalledTimes(2);
    });
});

/**
 * What a poll costs, and what a poll is charged.
 *
 * This is the whole reason Part B is buildable: r6data allows 3,000 requests a
 * month across 3 tracked players, and at two requests per player per poll no
 * cadence narrow enough to resolve single matches comes close to fitting. The
 * two suites below pin the halves of the fix — the poller spends one request,
 * and every request is counted.
 */
describe('R6DataService — request cost', () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
        jest.restoreAllMocks();
    });

    const ladderBody = [{ id: 22, name: 'Platinum IV', min_mmr: 3000 }];
    const statsBody = {
        platform_families_full_profiles: [
            {
                board_ids_full_profiles: [
                    {
                        board_id: 'ranked',
                        full_profiles: [
                            {
                                season_id: 41,
                                profile: {
                                    rank: 22,
                                    rank_points: 3120,
                                    kills: 1012,
                                    deaths: 1004,
                                    wins: 403,
                                    losses: 301,
                                    abandon: 2,
                                },
                            },
                        ],
                    },
                ],
            },
        ],
    };

    /** Answers `/api/ranks` with the ladder and anything else with the stats. */
    function routingFetch() {
        const mock = jest.fn(async (url: string) => ({
            ok: true,
            status: 200,
            json: async () =>
                String(url).includes('/api/ranks') ? ladderBody : statsBody,
        }));
        global.fetch = mock as unknown as typeof fetch;
        return mock;
    }

    /** The `nameOnPlatform`/`type` pairs a run of requests asked for. */
    const requestedTypes = (mock: jest.Mock): string[] =>
        mock.mock.calls.map(
            (call) =>
                new URL(String(call[0])).searchParams.get('type') ?? 'ranks'
        );

    it('spends two requests resolving a player by name', async () => {
        // The registration path: `/r6-add` does not know the Ubisoft id, so
        // buying it is the point.
        const mock = routingFetch();
        const service = new R6DataService('key');
        await service.getProfileByName('Ash', 'uplay');

        expect(requestedTypes(mock).sort()).toEqual([
            'accountInfo',
            'ranks',
            'stats',
        ]);
    });

    it('spends one request polling a player already tracked', async () => {
        // The poller's path, and the reason a 5-minute cadence fits the plan at
        // all. `accountInfo` buys only a display-name refresh for a row that
        // already stores the id and the name.
        const mock = routingFetch();
        const service = new R6DataService('key');
        // Warm the ladder first so it is not counted against the poll; the real
        // service memoises it once per process, not once per poll.
        await service.getRankLadder();
        mock.mockClear();

        const profile = await service.getTrackedProfile({
            ubisoftId: 'ubi-1',
            gameName: 'Ash',
            platform: 'uplay',
        });

        expect(requestedTypes(mock)).toEqual(['stats']);
        // And it is the same snapshot: the stored id and name are threaded into
        // the shape `accountInfo` would have returned, so there is one mapping.
        expect(profile.ubisoftId).toBe('ubi-1');
        expect(profile.gameName).toBe('Ash');
        expect(profile.rank).toEqual({
            tier: 'Platinum',
            division: 4,
            rp: 3120,
        });
        expect(profile.stats.abandons).toBe(2);
    });

    it('charges the meter once per request, before it is sent', async () => {
        const mock = routingFetch();
        const meter = jest.fn();
        const service = new R6DataService('key', meter);

        await service.getProfileByName('Ash', 'uplay');

        expect(meter).toHaveBeenCalledTimes(mock.mock.calls.length);
        expect(meter).toHaveBeenCalledWith(1);
    });

    it('charges a failed request too', async () => {
        // A 429 or a 500 costs quota at the provider exactly as a 200 does. A
        // meter that only counted successes would speed the poller up at
        // precisely the moment the provider was pushing back.
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 429,
            text: async () => 'slow down',
        })) as unknown as typeof fetch;
        const meter = jest.fn();
        const service = new R6DataService('key', meter);

        await expect(
            service.getTrackedProfile({
                ubisoftId: 'ubi-1',
                gameName: 'Ash',
                platform: 'uplay',
            })
        ).rejects.toThrow(/429/);
        expect(meter).toHaveBeenCalled();
    });
});

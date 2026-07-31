const getAllGuildConfigsMock = jest.fn();
const getInterCandidatesSinceMock = jest.fn();
const fetchRankHistoryMock = jest.fn();
const dbQueryMock = jest.fn();
const getSquadIdForGuildMock = jest.fn().mockResolvedValue('squad-1');

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({
        db: { query: dbQueryMock },
    })
);

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/summoners/guildService',
    () => {
        const actual = jest.requireActual(
            '../packages/diana-core/src/plugins/diana-league-bot/api/summoners/guildService'
        );
        return {
            ...actual,
            getAllGuildConfigs: getAllGuildConfigsMock,
            getSquadIdForGuild: getSquadIdForGuildMock,
        };
    }
);

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/summoners/summonerService',
    () => ({
        fetchRankHistory: fetchRankHistoryMock,
    })
);

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/utils/interStats',
    () => {
        const actual = jest.requireActual(
            '../packages/diana-core/src/plugins/diana-league-bot/utils/interStats'
        );
        return {
            ...actual,
            getInterCandidatesSince: getInterCandidatesSinceMock,
        };
    }
);

import {
    buildWeeklyDigestPayload,
    buildWeeklyDigestPayloadFromStats,
    computeWeeklyDigestStats,
    createWeeklyDigestTick,
} from '../packages/diana-core/src/plugins/diana-league-bot/monitoring/weeklyDigestService';

function makeCandidate(overrides: Record<string, unknown> = {}) {
    return {
        puuid: 'p1',
        displayName: 'Player#EUW',
        deepLolLink: null,
        matchesPlayed: 5,
        wins: 3,
        losses: 2,
        totalKills: 20,
        totalDeaths: 10,
        totalAssists: 15,
        totalDamage: 0,
        totalVisionScore: 0,
        totalCs: 0,
        avgDamage: 15000,
        kdaRatio: 3.5,
        winRate: 0.6,
        avgVisionScore: 22,
        avgCsPerMin: 6.4,
        avgAiScore: 55,
        scoredMatchesCount: 5,
        ...overrides,
    };
}

const baseConfig = {
    matchCheckCron: '0 * * * * *',
    weeklyDigestCron: '0 0 19 * * 0',
};

describe('buildWeeklyDigestPayload', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        dbQueryMock.mockResolvedValue({ rows: [] });
        fetchRankHistoryMock.mockResolvedValue([]);
    });

    it('returns null when the guild had no matches this week', async () => {
        getInterCandidatesSinceMock.mockResolvedValue([]);
        const payload = await buildWeeklyDigestPayload('g1');
        expect(payload).toBeNull();
    });

    it("scopes the stats query to the guild's squad, with the guild's own queue scope", async () => {
        getInterCandidatesSinceMock.mockResolvedValue([makeCandidate()]);
        await buildWeeklyDigestPayload('g1');
        expect(getInterCandidatesSinceMock).toHaveBeenCalledWith(
            expect.any(Number),
            { squadId: 'squad-1', scope: 'all' }
        );
    });

    // DN-2 acceptance: two guilds, two squads. Each digest must be built from
    // its own squad's roster. The second guild here stands for one whose squad
    // is also reachable from a Meeps space - buildWeeklyDigestPayload cannot
    // tell the difference, which is the portability property.
    it('scopes each guild to its own squad, with no bleed between them', async () => {
        getSquadIdForGuildMock
            .mockResolvedValueOnce('squad-a')
            .mockResolvedValueOnce('squad-b');
        getInterCandidatesSinceMock
            .mockResolvedValueOnce([makeCandidate({ displayName: 'Alice' })])
            .mockResolvedValueOnce([makeCandidate({ displayName: 'Bob' })]);

        const a = await buildWeeklyDigestPayload('guild-a');
        const b = await buildWeeklyDigestPayload('guild-b');

        expect(getInterCandidatesSinceMock).toHaveBeenNthCalledWith(
            1,
            expect.any(Number),
            expect.objectContaining({ squadId: 'squad-a' })
        );
        expect(getInterCandidatesSinceMock).toHaveBeenNthCalledWith(
            2,
            expect.any(Number),
            expect.objectContaining({ squadId: 'squad-b' })
        );

        const aText = JSON.stringify(a);
        const bText = JSON.stringify(b);
        expect(aText).toContain('Alice');
        expect(aText).not.toContain('Bob');
        expect(bText).toContain('Bob');
        expect(bText).not.toContain('Alice');
    });

    it('returns null when the guild has no squad, rather than digesting everything', async () => {
        // A guild with no attachment has no roster; without this guard the
        // unscoped query would report every tracked player on the deployment.
        getSquadIdForGuildMock.mockResolvedValueOnce(null);
        getInterCandidatesSinceMock.mockResolvedValue([makeCandidate()]);

        const payload = await buildWeeklyDigestPayload('g-unattached');

        expect(payload).toBeNull();
        expect(getInterCandidatesSinceMock).not.toHaveBeenCalled();
    });

    it('crowns MVP and Inter and names the grinder', async () => {
        getInterCandidatesSinceMock.mockResolvedValue([
            makeCandidate({
                puuid: 'a',
                displayName: 'Carry#1',
                avgAiScore: 80,
                matchesPlayed: 4,
            }),
            makeCandidate({
                puuid: 'b',
                displayName: 'Feeder#2',
                avgAiScore: 20,
                matchesPlayed: 9,
            }),
        ]);

        const payload = await buildWeeklyDigestPayload('g1');

        expect(payload).not.toBeNull();
        const byName = new Map(
            (payload!.fields ?? []).map((f) => [f.name, f.value])
        );
        expect(byName.get('🏆 **MVP of the Week**')).toContain('Carry#1');
        expect(byName.get('🤡 **Inter of the Week**')).toContain('Feeder#2');
        expect(byName.get('🎮 **The Grinder**')).toContain('Feeder#2');
        expect(payload!.description).toContain('13 games');
        expect(payload!.description).toContain('2 players');
    });

    it('computes climber and faller from weekly LP deltas', async () => {
        getInterCandidatesSinceMock.mockResolvedValue([
            makeCandidate({ puuid: 'up', displayName: 'Climber#1' }),
            makeCandidate({ puuid: 'down', displayName: 'Faller#2' }),
        ]);
        fetchRankHistoryMock.mockImplementation((puuid: string) => {
            if (puuid === 'up') {
                // newest first: climbed from 20 LP to 80 LP within GOLD IV
                return Promise.resolve([
                    { tier: 'GOLD', rank: 'IV', lp: 80 },
                    { tier: 'GOLD', rank: 'IV', lp: 20 },
                ]);
            }
            return Promise.resolve([
                { tier: 'GOLD', rank: 'IV', lp: 10 },
                { tier: 'GOLD', rank: 'IV', lp: 55 },
            ]);
        });

        const payload = await buildWeeklyDigestPayload('g1');

        const byName = new Map(
            (payload!.fields ?? []).map((f) => [f.name, f.value])
        );
        expect(byName.get('🧗 **Climber of the Week**')).toContain('Climber#1');
        expect(byName.get('🧗 **Climber of the Week**')).toContain('+60 LP');
        expect(byName.get('📉 **Faller of the Week**')).toContain('Faller#2');
        expect(byName.get('📉 **Faller of the Week**')).toContain('-45 LP');
    });

    it('includes best and worst single games from match_scores', async () => {
        getInterCandidatesSinceMock.mockResolvedValue([makeCandidate()]);
        dbQueryMock.mockResolvedValue({
            rows: [
                {
                    matchId: 'm1',
                    puuid: 'a',
                    score: '92.5',
                    gameName: 'Star',
                    tagLine: 'EUW',
                },
                {
                    matchId: 'm2',
                    puuid: 'b',
                    score: '8.1',
                    gameName: 'Griefer',
                    tagLine: 'EUW',
                },
            ],
        });

        const payload = await buildWeeklyDigestPayload('g1');

        const byName = new Map(
            (payload!.fields ?? []).map((f) => [f.name, f.value])
        );
        expect(byName.get('⭐ **Best Single Game**')).toContain('Star#EUW');
        expect(byName.get('⭐ **Best Single Game**')).toContain('93');
        expect(byName.get('💩 **Worst Single Game**')).toContain('Griefer#EUW');
    });
});

describe('createWeeklyDigestTick', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        dbQueryMock.mockResolvedValue({ rows: [] });
        fetchRankHistoryMock.mockResolvedValue([]);
        delete process.env.STOP_BOT;
    });

    it('sends the digest to each opted-in guild channel', async () => {
        getAllGuildConfigsMock.mockResolvedValue([
            {
                guild_id: 'g1',
                channel_id: 'c1',
                live_posting: true,
                notification_prefs: {},
            },
        ]);
        getInterCandidatesSinceMock.mockResolvedValue([makeCandidate()]);
        const adapter = { sendMessage: jest.fn().mockResolvedValue(undefined) };

        await createWeeklyDigestTick(baseConfig as any, adapter)();

        expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
        expect(adapter.sendMessage).toHaveBeenCalledWith(
            { channelId: 'c1' },
            expect.objectContaining({
                title: expect.stringContaining('Weekly Diana Digest'),
            })
        );
    });

    it('skips guilds that disabled the digest pref', async () => {
        getAllGuildConfigsMock.mockResolvedValue([
            {
                guild_id: 'g1',
                channel_id: 'c1',
                live_posting: true,
                notification_prefs: { digest: false },
            },
        ]);
        getInterCandidatesSinceMock.mockResolvedValue([makeCandidate()]);
        const adapter = { sendMessage: jest.fn().mockResolvedValue(undefined) };

        await createWeeklyDigestTick(baseConfig as any, adapter)();

        expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it('skips quiet guilds with no matches', async () => {
        getAllGuildConfigsMock.mockResolvedValue([
            {
                guild_id: 'g1',
                channel_id: 'c1',
                live_posting: true,
                notification_prefs: {},
            },
        ]);
        getInterCandidatesSinceMock.mockResolvedValue([]);
        const adapter = { sendMessage: jest.fn().mockResolvedValue(undefined) };

        await createWeeklyDigestTick(baseConfig as any, adapter)();

        expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it('continues to other guilds when one send fails', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        getAllGuildConfigsMock.mockResolvedValue([
            {
                guild_id: 'g1',
                channel_id: 'c1',
                live_posting: true,
                notification_prefs: {},
            },
            {
                guild_id: 'g2',
                channel_id: 'c2',
                live_posting: true,
                notification_prefs: {},
            },
        ]);
        getInterCandidatesSinceMock.mockResolvedValue([makeCandidate()]);
        const adapter = {
            sendMessage: jest
                .fn()
                .mockRejectedValueOnce(new Error('send failed'))
                .mockResolvedValue(undefined),
        };

        await createWeeklyDigestTick(baseConfig as any, adapter)();

        expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
        jest.restoreAllMocks();
    });

    // -----------------------------------------------------------------------
    // Event emission (DN-1)
    // -----------------------------------------------------------------------

    it('emits a digest event per guild, keyed on the ISO week', async () => {
        getAllGuildConfigsMock.mockResolvedValue([
            {
                guild_id: 'g1',
                channel_id: 'c1',
                live_posting: true,
                notification_prefs: {},
            },
        ]);
        getInterCandidatesSinceMock.mockResolvedValue([makeCandidate()]);
        const adapter = { sendMessage: jest.fn().mockResolvedValue(undefined) };
        const events = { emit: jest.fn().mockResolvedValue(undefined) };

        await createWeeklyDigestTick(baseConfig as any, adapter, events)();

        expect(events.emit).toHaveBeenCalledTimes(1);
        expect(events.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'digest.weekly',
                // guildId records where it was posted; squadId is the scope
                // the event belongs to, and the key is built from the squad so
                // two guilds on one squad cannot produce two rows.
                guildId: 'g1',
                squadId: 'squad-1',
                eventId: expect.stringMatching(
                    /^digest\.weekly:squad-1:\d{4}-W\d{2}$/
                ),
            })
        );
    });

    it('works with no event adapter - emission is optional', async () => {
        getAllGuildConfigsMock.mockResolvedValue([
            {
                guild_id: 'g1',
                channel_id: 'c1',
                live_posting: true,
                notification_prefs: {},
            },
        ]);
        getInterCandidatesSinceMock.mockResolvedValue([makeCandidate()]);
        const adapter = { sendMessage: jest.fn().mockResolvedValue(undefined) };

        await expect(
            createWeeklyDigestTick(baseConfig as any, adapter)()
        ).resolves.toBeUndefined();

        expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    });

    // The event used to carry only `isoWeek`, so a consumer could tell that a
    // digest happened and nothing about what was in it. Meeps renders its own
    // digest card from these figures (MP-06).
    it('carries the week as structured stats, not only the ISO week', async () => {
        getAllGuildConfigsMock.mockResolvedValue([
            {
                guild_id: 'g1',
                channel_id: 'c1',
                live_posting: true,
                notification_prefs: {},
            },
        ]);
        getInterCandidatesSinceMock.mockResolvedValue([
            makeCandidate({
                puuid: 'a',
                displayName: 'Carry#1',
                avgAiScore: 80.4,
                matchesPlayed: 4,
            }),
            makeCandidate({
                puuid: 'b',
                displayName: 'Feeder#2',
                avgAiScore: 20,
                matchesPlayed: 9,
            }),
        ]);
        const adapter = { sendMessage: jest.fn().mockResolvedValue(undefined) };
        const events = { emit: jest.fn().mockResolvedValue(undefined) };

        await createWeeklyDigestTick(baseConfig as any, adapter, events)();

        const event = events.emit.mock.calls[0][0];
        expect(event.stats).toEqual(
            expect.objectContaining({
                totalGames: 13,
                playerCount: 2,
                // Rounded to the figure the embed prints, so the two renderings
                // of one week cannot show different numbers.
                mvp: { name: 'Carry#1', value: 80 },
                inter: { name: 'Feeder#2', value: 20 },
                grinder: { name: 'Feeder#2', value: 9 },
            })
        );
    });

    it('computes the week once and renders it twice', async () => {
        getAllGuildConfigsMock.mockResolvedValue([
            {
                guild_id: 'g1',
                channel_id: 'c1',
                live_posting: true,
                notification_prefs: {},
            },
        ]);
        getInterCandidatesSinceMock.mockResolvedValue([makeCandidate()]);
        const adapter = { sendMessage: jest.fn().mockResolvedValue(undefined) };
        const events = { emit: jest.fn().mockResolvedValue(undefined) };

        await createWeeklyDigestTick(baseConfig as any, adapter, events)();

        // One roster query for the one guild. A second would mean the embed and
        // the event were computed separately and could drift apart — and would
        // double the digest's query cost every week.
        expect(getInterCandidatesSinceMock).toHaveBeenCalledTimes(1);

        const sent = adapter.sendMessage.mock.calls[0][1];
        const emitted = events.emit.mock.calls[0][0];
        const byName = new Map(
            (sent.fields ?? []).map((f: { name: string; value: string }) => [
                f.name,
                f.value,
            ])
        );
        expect(byName.get('🎮 **The Grinder**')).toContain(
            String(emitted.stats.grinder.value)
        );
        expect(sent.description).toContain(String(emitted.stats.totalGames));
    });
});

describe('computeWeeklyDigestStats', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        dbQueryMock.mockResolvedValue({ rows: [] });
        fetchRankHistoryMock.mockResolvedValue([]);
    });

    it('omits an award nobody earned rather than reporting a zero', async () => {
        // Everyone flat on LP and nothing scored: no climber, no faller, no
        // MVP. A zero-valued award would read as "Player#EUW (+0 LP)", which is
        // a claim the week does not support.
        getInterCandidatesSinceMock.mockResolvedValue([
            makeCandidate({ scoredMatchesCount: 0 }),
        ]);

        const stats = await computeWeeklyDigestStats('g1');

        expect(stats).not.toBeNull();
        expect(stats!.climber).toBeUndefined();
        expect(stats!.faller).toBeUndefined();
        expect(stats!.mvp).toBeUndefined();
        expect(stats!.inter).toBeUndefined();
        // The grinder is the one award every non-empty week has.
        expect(stats!.grinder).toEqual({ name: 'Player#EUW', value: 5 });
    });

    it('awards no worst game when the week had a single scored game', async () => {
        getInterCandidatesSinceMock.mockResolvedValue([makeCandidate()]);
        dbQueryMock.mockResolvedValue({
            rows: [
                {
                    matchId: 'm1',
                    puuid: 'a',
                    score: '92.5',
                    gameName: 'Star',
                    tagLine: 'EUW',
                },
            ],
        });

        const stats = await computeWeeklyDigestStats('g1');

        expect(stats!.bestGame).toEqual({ name: 'Star#EUW', value: 93 });
        expect(stats!.worstGame).toBeUndefined();
    });

    it('renders only the awards present, in the embed order', async () => {
        const payload = buildWeeklyDigestPayloadFromStats({
            totalGames: 3,
            playerCount: 1,
            grinder: { name: 'Solo#EUW', value: 3 },
        });

        expect((payload.fields ?? []).map((f) => f.name)).toEqual([
            '🎮 **The Grinder**',
        ]);
        expect(payload.description).toContain('3 games');
        expect(payload.description).toContain('1 player');
    });
});

describe('fetchWeeklyScoredGames competitive filtering', () => {
    beforeEach(() => {
        dbQueryMock.mockReset();
        dbQueryMock.mockResolvedValue({ rows: [] });
        getInterCandidatesSinceMock.mockResolvedValue([makeCandidate()]);
    });

    const scoredGamesQuery = () => {
        const call = dbQueryMock.mock.calls.find((c: any[]) =>
            String(c[0]).includes('match_scores')
        );
        return String(call?.[0] ?? '');
    };

    it('excludes Arena from the best/worst game picks', async () => {
        await buildWeeklyDigestPayload('g1');
        expect(scoredGamesQuery()).toContain("<> 'CHERRY'");
    });

    it('filters via EXISTS, not a join, so late-added summoners are kept', async () => {
        // match_scores holds every participant but match_details only holds
        // entry players, so an inner join would silently drop rows.
        await buildWeeklyDigestPayload('g1');
        const query = scoredGamesQuery();
        expect(query).toContain('EXISTS');
        expect(query).not.toContain('JOIN match_details');
    });
});

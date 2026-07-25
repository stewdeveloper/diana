const getAllGuildConfigsMock = jest.fn();
const getInterCandidatesSinceMock = jest.fn();
const fetchRankHistoryMock = jest.fn();
const dbQueryMock = jest.fn();

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

    it('passes the guildId into the stats query', async () => {
        getInterCandidatesSinceMock.mockResolvedValue([makeCandidate()]);
        await buildWeeklyDigestPayload('g1');
        expect(getInterCandidatesSinceMock).toHaveBeenCalledWith(
            expect.any(Number),
            { guildId: 'g1' }
        );
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
                guildId: 'g1',
                eventId: expect.stringMatching(
                    /^digest\.weekly:g1:\d{4}-W\d{2}$/
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
});

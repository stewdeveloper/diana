const getAllGuildConfigsMock = jest.fn();
const getChampionRotationMock = jest.fn();
const buildChampionIdMapMock = jest.fn();
const getSquadIdForGuildMock = jest.fn().mockResolvedValue('squad-1');

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
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/dataDragonService',
    () => ({
        buildChampionIdMap: buildChampionIdMapMock,
    })
);

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/lolService/lolServiceFactory',
    () => ({
        createLolService: () => ({
            getChampionRotation: getChampionRotationMock,
        }),
    })
);

import {
    buildRotationPayload,
    createRotationPostTick,
} from '../packages/diana-core/src/plugins/diana-league-bot/monitoring/rotationPostService';

const baseConfig = {
    matchCheckCron: '0 * * * * *',
    weeklyDigestCron: '0 0 19 * * 0',
    rotationPostCron: '0 0 12 * * 2',
};

function optedInGuild(overrides: Record<string, unknown> = {}) {
    return {
        guild_id: 'g1',
        channel_id: 'c1',
        live_posting: true,
        notification_prefs: { rotation: true },
        ...overrides,
    };
}

describe('buildRotationPayload', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        buildChampionIdMapMock.mockResolvedValue({
            '1': { name: 'Annie' },
            '10': { name: 'Kayle' },
        });
    });

    it('maps champion ids to names, alphabetically sorted', async () => {
        getChampionRotationMock.mockResolvedValue({
            freeChampionIds: [10, 1],
            freeChampionIdsForNewPlayers: [],
            maxNewPlayerLevel: 10,
        });

        const payload = await buildRotationPayload();

        expect(payload).not.toBeNull();
        expect(payload!.fields![0].value).toBe('Annie, Kayle');
    });

    it('falls back to a numeric label for unknown champion ids', async () => {
        getChampionRotationMock.mockResolvedValue({
            freeChampionIds: [999],
            freeChampionIdsForNewPlayers: [],
            maxNewPlayerLevel: 10,
        });

        const payload = await buildRotationPayload();

        expect(payload!.fields![0].value).toContain('Champion #999');
    });

    it('returns null when the rotation is empty', async () => {
        getChampionRotationMock.mockResolvedValue({
            freeChampionIds: [],
            freeChampionIdsForNewPlayers: [],
            maxNewPlayerLevel: 10,
        });

        expect(await buildRotationPayload()).toBeNull();
    });
});

describe('createRotationPostTick', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        buildChampionIdMapMock.mockResolvedValue({ '1': { name: 'Annie' } });
        getChampionRotationMock.mockResolvedValue({
            freeChampionIds: [1],
            freeChampionIdsForNewPlayers: [],
            maxNewPlayerLevel: 10,
        });
        delete process.env.STOP_BOT;
    });

    it('is OFF by default - guilds without an explicit pref get nothing', async () => {
        getAllGuildConfigsMock.mockResolvedValue([
            optedInGuild({ notification_prefs: {} }),
        ]);
        const adapter = { sendMessage: jest.fn().mockResolvedValue(undefined) };

        await createRotationPostTick(baseConfig as any, adapter)();

        expect(adapter.sendMessage).not.toHaveBeenCalled();
        // No opted-in guilds means the Riot API is never called either.
        expect(getChampionRotationMock).not.toHaveBeenCalled();
    });

    it('posts to guilds that explicitly enabled the rotation pref', async () => {
        getAllGuildConfigsMock.mockResolvedValue([
            optedInGuild(),
            optedInGuild({
                guild_id: 'g2',
                channel_id: 'c2',
                notification_prefs: {},
            }),
        ]);
        const adapter = { sendMessage: jest.fn().mockResolvedValue(undefined) };

        await createRotationPostTick(baseConfig as any, adapter)();

        expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
        expect(adapter.sendMessage).toHaveBeenCalledWith(
            { channelId: 'c1' },
            expect.objectContaining({
                title: expect.stringContaining('Free Champion Rotation'),
            })
        );
        // Exactly one Riot call regardless of guild count.
        expect(getChampionRotationMock).toHaveBeenCalledTimes(1);
    });

    it('survives a Riot API failure without sending', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        getAllGuildConfigsMock.mockResolvedValue([optedInGuild()]);
        getChampionRotationMock.mockRejectedValue(new Error('riot down'));
        const adapter = { sendMessage: jest.fn().mockResolvedValue(undefined) };

        await createRotationPostTick(baseConfig as any, adapter)();

        expect(adapter.sendMessage).not.toHaveBeenCalled();
        jest.restoreAllMocks();
    });

    // -----------------------------------------------------------------------
    // Event emission (DN-1)
    // -----------------------------------------------------------------------

    it('emits a rotation event per posted guild, keyed on the ISO week', async () => {
        getAllGuildConfigsMock.mockResolvedValue([optedInGuild()]);
        const adapter = { sendMessage: jest.fn().mockResolvedValue(undefined) };
        const events = { emit: jest.fn().mockResolvedValue(undefined) };

        await createRotationPostTick(baseConfig as any, adapter, events)();

        expect(events.emit).toHaveBeenCalledTimes(1);
        expect(events.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'rotation.weekly',
                // guildId records where it was posted; squadId is the scope
                // the event belongs to, and the key is built from the squad so
                // two guilds on one squad cannot produce two rows.
                guildId: 'g1',
                squadId: 'squad-1',
                championNames: ['Annie'],
                eventId: expect.stringMatching(
                    /^rotation\.weekly:squad-1:\d{4}-W\d{2}$/
                ),
            })
        );
    });

    it('works with no event adapter - emission is optional', async () => {
        getAllGuildConfigsMock.mockResolvedValue([optedInGuild()]);
        const adapter = { sendMessage: jest.fn().mockResolvedValue(undefined) };

        await expect(
            createRotationPostTick(baseConfig as any, adapter)()
        ).resolves.toBeUndefined();

        expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('still posts to Discord when event emission throws', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        getAllGuildConfigsMock.mockResolvedValue([optedInGuild()]);
        const adapter = { sendMessage: jest.fn().mockResolvedValue(undefined) };
        const events = {
            emit: jest.fn().mockRejectedValue(new Error('meeps down')),
        };

        await createRotationPostTick(baseConfig as any, adapter, events)();

        // Discord is the product; events are the nice-to-have.
        expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
        jest.restoreAllMocks();
    });
});

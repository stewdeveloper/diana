/**
 * The Siege tick's two output paths.
 *
 * Before this, the R6 plugin emitted no typed events at all — grepping it for
 * `emitEvent`/`EventAdapter` returned nothing, so nothing Siege reached Meeps'
 * `diana_events` and the Siege card's promise in Meeps ("Rank updates for this
 * account reach you here") was unfulfilled. These pin the event half: that it
 * fires, what it says, that it is keyed so a retry is free, and — the part
 * easiest to regress — that it cannot take the Discord half down with it.
 *
 * Everything the tick touches is mocked. The provider, the storage layer and
 * both notification builders each have their own suite; what is under test here
 * is the branching between them.
 */

const getProfileByName = jest.fn();
const getRankLadder = jest.fn();

jest.mock(
    '../packages/diana-core/src/plugins/diana-r6-bot/api/utils/r6ServiceFactory',
    () => ({
        createR6Service: () => ({
            checkConnection: jest.fn(),
            getProfileByName,
            getRankLadder,
        }),
    })
);

jest.mock(
    '../packages/diana-core/src/plugins/diana-r6-bot/api/players/playerService',
    () => ({
        getAllTrackedR6Players: jest.fn(),
        getR6PlayerById: jest.fn(),
        getGuildsTrackingR6Player: jest.fn(),
        getSquadsTrackingR6Player: jest.fn(),
        updateR6PlayerRankAndSnapshot: jest.fn().mockResolvedValue(undefined),
        // The tick chains `.catch()` onto this one rather than awaiting it
        // bare, so the mock has to hand back a real promise.
        createR6RankHistory: jest.fn().mockResolvedValue(undefined),
        diffSnapshot: jest.requireActual(
            '../packages/diana-core/src/plugins/diana-r6-bot/api/players/playerService'
        ).diffSnapshot,
    })
);

jest.mock(
    '../packages/diana-core/src/plugins/diana-r6-bot/notifications/r6Notifications',
    () => ({
        notifyR6RankChange: jest.fn(),
        notifyR6Session: jest.fn(),
    })
);

import { runR6Tick } from '../packages/diana-core/src/plugins/diana-r6-bot/monitoring/rankMonitoringService';
import {
    getAllTrackedR6Players,
    getR6PlayerById,
    getGuildsTrackingR6Player,
    getSquadsTrackingR6Player,
} from '../packages/diana-core/src/plugins/diana-r6-bot/api/players/playerService';
import {
    notifyR6RankChange,
    notifyR6Session,
} from '../packages/diana-core/src/plugins/diana-r6-bot/notifications/r6Notifications';
import type {
    DianaEvent,
    EventAdapter,
} from '../packages/diana-core/src/core/eventTypes';

const trackedMock = getAllTrackedR6Players as jest.Mock;
const playerMock = getR6PlayerById as jest.Mock;
const guildsMock = getGuildsTrackingR6Player as jest.Mock;
const squadsMock = getSquadsTrackingR6Player as jest.Mock;
const rankChangeMock = notifyR6RankChange as jest.Mock;
const sessionMock = notifyR6Session as jest.Mock;

/** The stored row: Platinum V on 3,000 RP, with a snapshot baseline. */
const storedPlayer = (overrides: Record<string, unknown> = {}) => ({
    ubisoftId: 'ubi-1',
    gameName: 'Ash',
    platform: 'uplay',
    tier: 'Platinum',
    division: 5,
    rp: 3000,
    currentMatchId: null,
    discordChannelId: null,
    lastUpdated: '2026-08-05T10:00:00.000Z',
    killsSnapshot: 1000,
    winsSnapshot: 400,
    lossesSnapshot: 300,
    ...overrides,
});

/** The live profile: same player, one poll later. */
const profile = (overrides: Record<string, unknown> = {}) => ({
    ubisoftId: 'ubi-1',
    gameName: 'Ash',
    platform: 'uplay',
    rank: { tier: 'Platinum', division: 4, rp: 3120 },
    rankOrdinal: 21,
    maxRankOrdinal: 24,
    rankIconUrl: 'https://example.invalid/plat.png',
    stats: { kills: 1012, deaths: 1004, wins: 403, losses: 301 },
    kd: 1.01,
    isInGame: null,
    ...overrides,
});

/** An adapter that records rather than sends, and never throws (per DN-1). */
function recordingAdapter(): EventAdapter & { emitted: DianaEvent[] } {
    const emitted: DianaEvent[] = [];
    return {
        emitted,
        async emit(event: DianaEvent) {
            emitted.push(event);
            return true;
        },
    };
}

describe('runR6Tick — typed events', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.STOP_BOT;
        trackedMock.mockResolvedValue([
            { ubisoftId: 'ubi-1', gameName: 'Ash', platform: 'uplay' },
        ]);
        playerMock.mockResolvedValue(storedPlayer());
        guildsMock.mockResolvedValue([
            { guild_id: 'g-1', channel_id: 'c-1', live_posting: true },
        ]);
        squadsMock.mockResolvedValue(['squad-a']);
        getRankLadder.mockResolvedValue([]);
        getProfileByName.mockResolvedValue(profile());
    });

    it('emits r6.rank.changed when a division boundary is crossed', async () => {
        const adapter = recordingAdapter();
        await runR6Tick(null, adapter);

        expect(adapter.emitted).toHaveLength(1);
        const event = adapter.emitted[0] as Extract<
            DianaEvent,
            { type: 'r6.rank.changed' }
        >;
        expect(event.type).toBe('r6.rank.changed');
        expect(event.schemaVersion).toBe(1);
        expect(event.squadId).toBe('squad-a');
        expect(event.ubisoftId).toBe('ubi-1');
        expect(event.direction).toBe('promoted');
        expect(event.rankAfter).toBe('Platinum IV (3120 RP)');
        expect(event.tier).toBe('Platinum');
        expect(event.division).toBe(4);
        expect(event.rp).toBe(3120);
        expect(event.rpChange).toBe(120);
        // 403 wins + 301 losses. The closest thing Siege has to a match id.
        expect(event.matchCount).toBe(704);
        expect(event.eventId).toBe('r6.rank.changed:squad-a:ubi-1:704:3120');
    });

    it('emits r6.session.completed when RP moved inside a division', async () => {
        // Same rank, more RP: the case a Siege evening actually produces most
        // of the time, and the reason the plugin does not stay silent here the
        // way Apex does.
        getProfileByName.mockResolvedValue(
            profile({ rank: { tier: 'Platinum', division: 5, rp: 3080 } })
        );
        const adapter = recordingAdapter();
        await runR6Tick(null, adapter);

        expect(adapter.emitted).toHaveLength(1);
        const event = adapter.emitted[0] as Extract<
            DianaEvent,
            { type: 'r6.session.completed' }
        >;
        expect(event.type).toBe('r6.session.completed');
        expect(event.killsGained).toBe(12);
        expect(event.winsGained).toBe(3);
        expect(event.lossesGained).toBe(1);
        expect(event.rpChange).toBe(80);
    });

    it('reports a missing baseline as null rather than as a quiet session', async () => {
        // First sighting of a player. Zero would say "played and gained
        // nothing", which is a different and wrong claim — the Discord builder
        // draws the same distinction, and a consumer must be able to too.
        playerMock.mockResolvedValue(
            storedPlayer({
                killsSnapshot: null,
                winsSnapshot: null,
                lossesSnapshot: null,
            })
        );
        getProfileByName.mockResolvedValue(
            profile({ rank: { tier: 'Platinum', division: 5, rp: 3080 } })
        );
        const adapter = recordingAdapter();
        await runR6Tick(null, adapter);

        const event = adapter.emitted[0] as Extract<
            DianaEvent,
            { type: 'r6.session.completed' }
        >;
        expect(event.killsGained).toBeNull();
        expect(event.winsGained).toBeNull();
        expect(event.lossesGained).toBeNull();
    });

    it('emits one event per squad, and the ids differ', async () => {
        squadsMock.mockResolvedValue(['squad-a', 'squad-b']);
        const adapter = recordingAdapter();
        await runR6Tick(null, adapter);

        expect(adapter.emitted).toHaveLength(2);
        const ids = adapter.emitted.map((event) => event.eventId);
        expect(new Set(ids).size).toBe(2);
    });

    it('produces the same event id when the same poll is replayed', async () => {
        // The whole point of the deterministic key: Diana's transport retries,
        // and a redelivery must hit Meeps' ON CONFLICT (event_id) DO NOTHING
        // rather than fan out a second card.
        const first = recordingAdapter();
        const second = recordingAdapter();
        await runR6Tick(null, first);
        await runR6Tick(null, second);

        expect(first.emitted[0].eventId).toBe(second.emitted[0].eventId);
    });

    it('emits even when no guild is configured to post', async () => {
        // guild_config gates Discord, not the event. A squad whose Discord side
        // is muted still gets the card in its Meeps space.
        guildsMock.mockResolvedValue([]);
        const adapter = recordingAdapter();
        await runR6Tick(null, adapter);

        expect(rankChangeMock).not.toHaveBeenCalled();
        expect(adapter.emitted).toHaveLength(1);
    });

    it('emits nothing for a player no squad reaches', async () => {
        squadsMock.mockResolvedValue([]);
        const adapter = recordingAdapter();
        await runR6Tick(null, adapter);

        expect(adapter.emitted).toHaveLength(0);
    });

    it('never emits r6.match.completed — that branch is Part B', async () => {
        // The discriminator ships now so Meeps can land its card before Diana
        // sends one (the contract README's rollout order). Emission waits on the
        // one-match branch and a five-minute poll.
        squadsMock.mockResolvedValue(['squad-a']);
        const adapter = recordingAdapter();
        await runR6Tick(null, adapter);
        getProfileByName.mockResolvedValue(
            profile({ rank: { tier: 'Platinum', division: 5, rp: 3080 } })
        );
        await runR6Tick(null, adapter);

        expect(
            adapter.emitted.some((e) => e.type === 'r6.match.completed')
        ).toBe(false);
    });

    it('keeps posting to Discord when the event path throws', async () => {
        // DN-1's rule: a consumer being unreachable must never break Discord
        // posting. The adapter is contractually non-throwing, so this simulates
        // the squad lookup failing instead — same blast radius, and the one
        // failure mode the emit block's own try/catch has to absorb.
        squadsMock.mockRejectedValue(new Error('squads table unavailable'));
        const errors = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        await expect(
            runR6Tick(null, recordingAdapter())
        ).resolves.toBeUndefined();

        expect(rankChangeMock).toHaveBeenCalledTimes(1);
        expect(errors).toHaveBeenCalled();
        errors.mockRestore();
    });

    it('posts to Discord unchanged when there is no event adapter at all', async () => {
        // The pre-DN-1 configuration, and what a plugin with the event adapter
        // unset still does today.
        await runR6Tick(null);

        expect(rankChangeMock).toHaveBeenCalledTimes(1);
        expect(sessionMock).not.toHaveBeenCalled();
        expect(squadsMock).not.toHaveBeenCalled();
    });
});

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

const getTrackedProfile = jest.fn();
const getRankLadder = jest.fn();

jest.mock(
    '../packages/diana-core/src/plugins/diana-r6-bot/api/utils/r6ServiceFactory',
    () => ({
        createR6Service: () => ({
            checkConnection: jest.fn(),
            getProfileByName: jest.fn(),
            getTrackedProfile,
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
        markR6PlayerPolled: jest.fn().mockResolvedValue(undefined),
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
        notifyR6Match: jest.fn(),
        notifyR6RankChange: jest.fn(),
        notifyR6Session: jest.fn(),
        r6MatchResultLabel: jest.requireActual(
            '../packages/diana-core/src/plugins/diana-r6-bot/notifications/r6Notifications'
        ).r6MatchResultLabel,
    })
);

// The budget is the poller's gate, and every case below except the two that
// exercise it wants the gate open. Mocked rather than fed through a fake ledger
// so the branching stays the subject.
const currentR6BudgetPlan = jest.fn();
jest.mock(
    '../packages/diana-core/src/plugins/diana-r6-bot/api/utils/r6Budget',
    () => ({
        currentR6BudgetPlan: (...args: unknown[]) =>
            currentR6BudgetPlan(...args),
    })
);

import {
    resolveSingleMatch,
    runR6Tick,
} from '../packages/diana-core/src/plugins/diana-r6-bot/monitoring/rankMonitoringService';
import {
    getAllTrackedR6Players,
    getR6PlayerById,
    getGuildsTrackingR6Player,
    getSquadsTrackingR6Player,
    markR6PlayerPolled,
    updateR6PlayerRankAndSnapshot,
} from '../packages/diana-core/src/plugins/diana-r6-bot/api/players/playerService';
import {
    notifyR6Match,
    notifyR6RankChange,
    notifyR6Session,
} from '../packages/diana-core/src/plugins/diana-r6-bot/notifications/r6Notifications';
import { ACTIVE_WINDOW_MINUTES } from '../packages/diana-core/src/plugins/diana-r6-bot/monitoring/r6PollScheduler';
import type {
    DianaEvent,
    EventAdapter,
} from '../packages/diana-core/src/core/eventTypes';

const trackedMock = getAllTrackedR6Players as jest.Mock;
const playerMock = getR6PlayerById as jest.Mock;
const guildsMock = getGuildsTrackingR6Player as jest.Mock;
const squadsMock = getSquadsTrackingR6Player as jest.Mock;
const polledMock = markR6PlayerPolled as jest.Mock;
const snapshotMock = updateR6PlayerRankAndSnapshot as jest.Mock;
const matchMock = notifyR6Match as jest.Mock;
const rankChangeMock = notifyR6RankChange as jest.Mock;
const sessionMock = notifyR6Session as jest.Mock;

/** The stored row: Platinum V on 3,000 RP, with a full snapshot baseline. */
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
    deathsSnapshot: 1000,
    winsSnapshot: 400,
    lossesSnapshot: 300,
    abandonsSnapshot: 2,
    // Overdue on any cadence, so every case below is due unless it says
    // otherwise.
    lastPolledAt: '2026-08-05T10:00:00.000Z',
    activeUntil: null,
    ...overrides,
});

/** The live profile: same player, one poll later — three wins and a loss on. */
const profile = (overrides: Record<string, unknown> = {}) => ({
    ubisoftId: 'ubi-1',
    gameName: 'Ash',
    platform: 'uplay',
    rank: { tier: 'Platinum', division: 4, rp: 3120 },
    rankOrdinal: 21,
    maxRankOrdinal: 24,
    rankIconUrl: 'https://example.invalid/plat.png',
    stats: {
        kills: 1012,
        deaths: 1004,
        wins: 403,
        losses: 301,
        abandons: 2,
    },
    kd: 1.01,
    isInGame: null,
    ...overrides,
});

/**
 * The same player with exactly one more win: the Part B case.
 *
 * RP moves inside the division so the rank-change branch does not pre-empt it.
 */
const oneWin = (overrides: Record<string, unknown> = {}) =>
    profile({
        rank: { tier: 'Platinum', division: 5, rp: 3024 },
        stats: {
            kills: 1008,
            deaths: 1004,
            wins: 401,
            losses: 300,
            abandons: 2,
        },
        ...overrides,
    });

const budgetPlan = (overrides: Record<string, unknown> = {}) => ({
    used: 100,
    pollBudget: 2850,
    pressure: 1,
    exhausted: false,
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
        polledMock.mockResolvedValue(undefined);
        snapshotMock.mockResolvedValue(undefined);
        getRankLadder.mockResolvedValue([]);
        getTrackedProfile.mockResolvedValue(profile());
        currentR6BudgetPlan.mockResolvedValue(budgetPlan());
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
        getTrackedProfile.mockResolvedValue(
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
        getTrackedProfile.mockResolvedValue(
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

/**
 * The one-match branch — Part B.
 *
 * Siege has no match record, so "one match completed" is inferred from the
 * counters moving by exactly one between two polls. These pin the inference, the
 * branch ordering it sits inside, and the case that made abandons worth
 * capturing.
 */
describe('resolveSingleMatch', () => {
    const diff = (overrides: Record<string, unknown> = {}) => ({
        killsGained: 8,
        deathsGained: 4,
        winsGained: 0,
        lossesGained: 0,
        abandonsGained: 0,
        ...overrides,
    });

    it('reads one win as a victory and one loss as a defeat', () => {
        expect(resolveSingleMatch(diff({ winsGained: 1 }))).toEqual({
            matches: 1,
            win: true,
        });
        expect(resolveSingleMatch(diff({ lossesGained: 1 }))).toEqual({
            matches: 1,
            win: false,
        });
    });

    it('reads one abandon as neither, not as a defeat', () => {
        // The case abandons were captured for. Wins and losses both stand still
        // while RP moves, so before this the window read as zero matches.
        expect(resolveSingleMatch(diff({ abandonsGained: 1 }))).toEqual({
            matches: 1,
            win: null,
        });
    });

    it('refuses to resolve a window that spanned more than one match', () => {
        expect(
            resolveSingleMatch(diff({ winsGained: 2, lossesGained: 1 })).win
        ).toBeUndefined();
        expect(
            resolveSingleMatch(diff({ winsGained: 2, lossesGained: 1 })).matches
        ).toBe(3);
    });

    it('counts a win plus an abandon as two matches, not one', () => {
        expect(
            resolveSingleMatch(diff({ winsGained: 1, abandonsGained: 1 }))
                .matches
        ).toBe(2);
    });

    it('reports an unknown total rather than zero without a baseline', () => {
        // First sighting. Zero matches would claim a window in which nothing
        // happened, which is a different and wrong statement.
        expect(
            resolveSingleMatch(diff({ winsGained: null, lossesGained: null }))
        ).toEqual({ matches: null });
    });

    it('resolves a match for a player whose abandons baseline predates 023', () => {
        // Deliberate asymmetry: wins and losses have been stored since 020,
        // abandons only since 023, so for one poll after the migration every
        // player has the first two and not the third. Refusing to resolve there
        // would suppress a real Victory card for no gain.
        expect(
            resolveSingleMatch(diff({ winsGained: 1, abandonsGained: null }))
        ).toEqual({ matches: 1, win: true });
    });
});

describe('runR6Tick — the one-match branch', () => {
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
        polledMock.mockResolvedValue(undefined);
        snapshotMock.mockResolvedValue(undefined);
        getRankLadder.mockResolvedValue([]);
        getTrackedProfile.mockResolvedValue(oneWin());
        currentR6BudgetPlan.mockResolvedValue(budgetPlan());
    });

    it('posts a match embed and emits r6.match.completed for a single win', async () => {
        const adapter = recordingAdapter();
        await runR6Tick({ sendMessage: jest.fn() }, adapter);

        expect(matchMock).toHaveBeenCalledTimes(1);
        expect(sessionMock).not.toHaveBeenCalled();
        expect(matchMock.mock.calls[0][1]).toMatchObject({
            playerName: 'Ash',
            win: true,
            rpChange: 24,
            kills: 8,
            deaths: 4,
        });

        expect(adapter.emitted).toHaveLength(1);
        const event = adapter.emitted[0] as Extract<
            DianaEvent,
            { type: 'r6.match.completed' }
        >;
        expect(event.type).toBe('r6.match.completed');
        expect(event.win).toBe(true);
        expect(event.result).toBe('Victory');
        expect(event.kills).toBe(8);
        expect(event.deaths).toBe(4);
        expect(event.rpChange).toBe(24);
        expect(event.rankAfter).toBe('Platinum V (3024 RP)');
        expect(event.squadId).toBe('squad-a');
    });

    it('reports a single loss as a defeat', async () => {
        getTrackedProfile.mockResolvedValue(
            oneWin({
                rank: { tier: 'Platinum', division: 5, rp: 2969 },
                stats: {
                    kills: 1003,
                    deaths: 1005,
                    wins: 400,
                    losses: 301,
                    abandons: 2,
                },
            })
        );
        const adapter = recordingAdapter();
        await runR6Tick({ sendMessage: jest.fn() }, adapter);

        const event = adapter.emitted[0] as Extract<
            DianaEvent,
            { type: 'r6.match.completed' }
        >;
        expect(event.win).toBe(false);
        expect(event.result).toBe('Defeat');
        expect(event.rpChange).toBe(-31);
    });

    it('reports a single abandon as abandoned, with no side having won', async () => {
        getTrackedProfile.mockResolvedValue(
            oneWin({
                rank: { tier: 'Platinum', division: 5, rp: 2950 },
                stats: {
                    kills: 1000,
                    deaths: 1000,
                    wins: 400,
                    losses: 300,
                    abandons: 3,
                },
            })
        );
        const adapter = recordingAdapter();
        await runR6Tick({ sendMessage: jest.fn() }, adapter);

        const event = adapter.emitted[0] as Extract<
            DianaEvent,
            { type: 'r6.match.completed' }
        >;
        expect(event.win).toBeNull();
        expect(event.result).toBe('Abandoned');
        expect(matchMock.mock.calls[0][1]).toMatchObject({ win: null });
    });

    it('falls back to the session message for a window of several matches', async () => {
        // Not a fallback for a failed feature: a window that spanned three games
        // genuinely cannot be resolved into them, and the session line is the
        // honest rendering of that.
        getTrackedProfile.mockResolvedValue(
            profile({ rank: { tier: 'Platinum', division: 5, rp: 3080 } })
        );
        const adapter = recordingAdapter();
        await runR6Tick({ sendMessage: jest.fn() }, adapter);

        expect(matchMock).not.toHaveBeenCalled();
        expect(sessionMock).toHaveBeenCalledTimes(1);
        expect(adapter.emitted[0].type).toBe('r6.session.completed');
    });

    it('lets a rank change outrank a single match, on both paths', async () => {
        // Crossing a division already names the result implicitly. Posting both
        // would announce one game twice, and the Discord and event branches have
        // to agree about which one it was.
        getTrackedProfile.mockResolvedValue(
            oneWin({ rank: { tier: 'Platinum', division: 4, rp: 3024 } })
        );
        const adapter = recordingAdapter();
        await runR6Tick({ sendMessage: jest.fn() }, adapter);

        expect(rankChangeMock).toHaveBeenCalledTimes(1);
        expect(matchMock).not.toHaveBeenCalled();
        expect(adapter.emitted).toHaveLength(1);
        expect(adapter.emitted[0].type).toBe('r6.rank.changed');
    });

    it('carries a null K/D rather than a fabricated zero without a deaths baseline', async () => {
        playerMock.mockResolvedValue(storedPlayer({ deathsSnapshot: null }));
        const adapter = recordingAdapter();
        await runR6Tick({ sendMessage: jest.fn() }, adapter);

        const event = adapter.emitted[0] as Extract<
            DianaEvent,
            { type: 'r6.match.completed' }
        >;
        expect(event.type).toBe('r6.match.completed');
        expect(event.kills).toBe(8);
        expect(event.deaths).toBeNull();
    });

    it('emits the match card even when the Discord side is muted', async () => {
        // `live_posting` answers "should Discord announce this". A squad's Meeps
        // space still gets the card.
        guildsMock.mockResolvedValue([
            { guild_id: 'g-1', channel_id: 'c-1', live_posting: false },
        ]);
        const adapter = recordingAdapter();
        await runR6Tick({ sendMessage: jest.fn() }, adapter);

        expect(matchMock).not.toHaveBeenCalled();
        expect(sessionMock).not.toHaveBeenCalled();
        expect(adapter.emitted[0].type).toBe('r6.match.completed');
    });

    it('keys a replayed poll identically, so a retry inserts nothing', async () => {
        const first = recordingAdapter();
        const second = recordingAdapter();
        await runR6Tick(null, first);
        await runR6Tick(null, second);

        expect(first.emitted[0].eventId).toBe(second.emitted[0].eventId);
        expect(first.emitted[0].eventId).toContain('r6.match.completed');
    });
});

/**
 * The budget gate and the poll accounting.
 *
 * The plan is 3,000 r6data requests a month across 3 players, so these are not
 * hygiene tests: each one is a way the poller could quietly spend a month's
 * allowance in an afternoon.
 */
describe('runR6Tick — spending the budget', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.STOP_BOT;
        trackedMock.mockResolvedValue([
            { ubisoftId: 'ubi-1', gameName: 'Ash', platform: 'uplay' },
        ]);
        playerMock.mockResolvedValue(storedPlayer());
        guildsMock.mockResolvedValue([]);
        squadsMock.mockResolvedValue([]);
        polledMock.mockResolvedValue(undefined);
        snapshotMock.mockResolvedValue(undefined);
        getRankLadder.mockResolvedValue([]);
        getTrackedProfile.mockResolvedValue(profile());
        currentR6BudgetPlan.mockResolvedValue(budgetPlan());
    });

    it('issues no request at all once the month is spent', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        currentR6BudgetPlan.mockResolvedValue(
            budgetPlan({ exhausted: true, used: 2850 })
        );

        await runR6Tick(null, recordingAdapter());

        expect(getTrackedProfile).not.toHaveBeenCalled();
        expect(polledMock).not.toHaveBeenCalled();
    });

    it('skips a player who is not yet due', async () => {
        // The heartbeat runs every 5 minutes and the idle interval is hours; a
        // tick with nobody due must cost nothing.
        const now = new Date('2026-08-06T20:00:00.000Z');
        trackedMock.mockResolvedValue([
            {
                ubisoftId: 'ubi-1',
                gameName: 'Ash',
                platform: 'uplay',
                lastPolledAt: new Date(now.getTime() - 60_000).toISOString(),
                activeUntil: null,
            },
        ]);

        await runR6Tick(null, recordingAdapter(), { now });

        expect(getTrackedProfile).not.toHaveBeenCalled();
    });

    it('records the poll even when nothing changed', async () => {
        // Most polls find nothing. Without this the row keeps a null
        // `last_polled_at`, reads as permanently due, and the quietest player in
        // the table absorbs the whole month.
        getTrackedProfile.mockResolvedValue(
            profile({
                rank: { tier: 'Platinum', division: 5, rp: 3000 },
                stats: {
                    kills: 1000,
                    deaths: 1000,
                    wins: 400,
                    losses: 300,
                    abandons: 2,
                },
            })
        );

        await runR6Tick(null, recordingAdapter());

        expect(polledMock).toHaveBeenCalledTimes(1);
        // Quiet poll, so the active window is left exactly as it was.
        expect(polledMock.mock.calls[0][1]).toBeNull();
    });

    it('records the poll even when the provider threw', async () => {
        // The request was already issued and already charged. Treating a failure
        // as "not polled" would retry a player whose name no longer resolves on
        // every heartbeat — thousands of requests a month against a 3,000 plan.
        jest.spyOn(console, 'error').mockImplementation(() => {});
        getTrackedProfile.mockRejectedValue(new Error('r6data 404'));

        await runR6Tick(null, recordingAdapter());

        expect(polledMock).toHaveBeenCalledTimes(1);
    });

    it('opens the active window when something moved', async () => {
        const now = new Date('2026-08-06T20:00:00.000Z');
        await runR6Tick(null, recordingAdapter(), { now });

        const activeUntil = polledMock.mock.calls[0][1] as Date;
        expect(activeUntil.getTime() - now.getTime()).toBe(
            ACTIVE_WINDOW_MINUTES * 60_000
        );
    });

    it('polls no more players than the remaining budget allows', async () => {
        trackedMock.mockResolvedValue([
            { ubisoftId: 'a', gameName: 'A', platform: 'uplay' },
            { ubisoftId: 'b', gameName: 'B', platform: 'uplay' },
            { ubisoftId: 'c', gameName: 'C', platform: 'uplay' },
        ]);
        currentR6BudgetPlan.mockResolvedValue(
            budgetPlan({ used: 2848, pollBudget: 2850 })
        );

        await runR6Tick(null, recordingAdapter());

        expect(getTrackedProfile).toHaveBeenCalledTimes(2);
    });

    it('does not spend a request on a tick with no tracked players', async () => {
        trackedMock.mockResolvedValue([]);
        await runR6Tick(null, recordingAdapter());

        expect(currentR6BudgetPlan).not.toHaveBeenCalled();
        expect(getTrackedProfile).not.toHaveBeenCalled();
    });
});

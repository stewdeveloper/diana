export {};

const getPendingLinkChallengesMock = jest.fn();
const deleteExpiredLinkChallengesMock = jest.fn();
const verifyLinkChallengeMock = jest.fn();

jest.mock('../packages/diana-core/src/core/identity/identityService', () => ({
    getPendingLinkChallenges: getPendingLinkChallengesMock,
    deleteExpiredLinkChallenges: deleteExpiredLinkChallengesMock,
    verifyLinkChallenge: verifyLinkChallengeMock,
}));

import { runLinkSweep } from '../packages/diana-core/src/core/identity/linkSweep';

/**
 * The sweep exists because the wait in a link handshake is not the player's - it
 * is Riot's summoner-v4 cache, which is slower than a person and slower than any
 * window sized for one. Extending the window alone would only have replaced "it
 * expired" with "keep running this command at it for an unknown length of time".
 */

const challenge = (overrides: Record<string, unknown> = {}) => ({
    discord_user_id: 'discord-1',
    puuid: 'puuid-1',
    game_name: 'Louis',
    tag_line: 'EUW',
    region: 'EU_WEST',
    required_icon: 12,
    expires_at: '2026-08-02T00:00:00.000Z',
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
});

const lolService = (profileIconId = 12) => ({
    getSummonerByPUUID: jest.fn().mockResolvedValue({ profileIconId }),
});

beforeEach(() => {
    jest.clearAllMocks();
    deleteExpiredLinkChallengesMock.mockResolvedValue(0);
    getPendingLinkChallengesMock.mockResolvedValue([]);
    verifyLinkChallengeMock.mockResolvedValue({
        ok: true,
        puuid: 'puuid-1',
        identityId: 'id-1',
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('runLinkSweep', () => {
    it('completes a handshake Riot has finally caught up on', async () => {
        getPendingLinkChallengesMock.mockResolvedValue([challenge()]);
        const service = lolService(12);

        const result = await runLinkSweep(service);

        expect(service.getSummonerByPUUID).toHaveBeenCalledWith(
            'puuid-1',
            'EU_WEST'
        );
        expect(verifyLinkChallengeMock).toHaveBeenCalledWith(
            'discord-1',
            12,
            expect.any(Number)
        );
        expect(result.verified).toBe(1);
        expect(result.pending).toBe(0);
    });

    it('tells the player, because they are not watching', async () => {
        getPendingLinkChallengesMock.mockResolvedValue([challenge()]);
        const notify = jest.fn().mockResolvedValue(undefined);

        await runLinkSweep(lolService(12), { notify });

        expect(notify).toHaveBeenCalledWith({
            discordUserId: 'discord-1',
            puuid: 'puuid-1',
            gameName: 'Louis',
            tagLine: 'EUW',
        });
    });

    it('counts a still-cached icon as pending, not as a failure', async () => {
        // The expected answer almost every tick. Treating it as an error would
        // make the log one line per waiting player per tick, forever.
        getPendingLinkChallengesMock.mockResolvedValue([challenge()]);
        verifyLinkChallengeMock.mockResolvedValue({
            ok: false,
            reason: 'icon_mismatch',
            expected: 12,
            actual: 3,
        });

        const result = await runLinkSweep(lolService(3));

        expect(result.pending).toBe(1);
        expect(result.verified).toBe(0);
        expect(console.error).not.toHaveBeenCalled();
    });

    it('leaves a pending challenge open so the next tick retries it', async () => {
        getPendingLinkChallengesMock.mockResolvedValue([challenge()]);
        verifyLinkChallengeMock.mockResolvedValue({
            ok: false,
            reason: 'icon_mismatch',
            expected: 12,
            actual: 3,
        });

        await runLinkSweep(lolService(3));

        // Only `verifyLinkChallenge` deletes on success; the sweep never does.
        expect(deleteExpiredLinkChallengesMock).toHaveBeenCalledTimes(1);
    });

    it('keeps going when one player’s account cannot be read', async () => {
        // A wrong region, a deleted account, a transient 500 — none of which is
        // a reason for everybody else to wait another tick.
        const service = {
            getSummonerByPUUID: jest
                .fn()
                .mockRejectedValueOnce(new Error('404'))
                .mockResolvedValue({ profileIconId: 12 }),
        };
        getPendingLinkChallengesMock.mockResolvedValue([
            challenge({ discord_user_id: 'broken', puuid: 'puuid-broken' }),
            challenge(),
        ]);

        const result = await runLinkSweep(service);

        expect(result.verified).toBe(1);
        expect(result.pending).toBe(1);
    });

    it('does not let a failed DM cost somebody their link', async () => {
        // Closed DMs are a setting, not an error, and the link is already made
        // by the time the notifier runs.
        getPendingLinkChallengesMock.mockResolvedValue([challenge()]);
        const notify = jest.fn().mockRejectedValue(new Error('cannot DM'));

        const result = await runLinkSweep(lolService(12), { notify });

        expect(result.verified).toBe(1);
    });

    it('clears expired handshakes even with no Riot key configured', async () => {
        // Otherwise the table grows forever on a deployment that cannot verify.
        deleteExpiredLinkChallengesMock.mockResolvedValue(3);

        const result = await runLinkSweep(null);

        expect(result.expired).toBe(3);
        expect(getPendingLinkChallengesMock).not.toHaveBeenCalled();
    });

    it('does nothing at all when nobody is mid-link', async () => {
        const service = lolService();
        const result = await runLinkSweep(service);

        expect(service.getSummonerByPUUID).not.toHaveBeenCalled();
        expect(result).toEqual({
            checked: 0,
            verified: 0,
            pending: 0,
            expired: 0,
        });
    });

    it('falls back to a region rather than asking Riot for undefined', async () => {
        getPendingLinkChallengesMock.mockResolvedValue([
            challenge({ region: null }),
        ]);
        const service = lolService(12);

        await runLinkSweep(service);

        expect(service.getSummonerByPUUID).toHaveBeenCalledWith(
            'puuid-1',
            'EU_WEST'
        );
    });
});

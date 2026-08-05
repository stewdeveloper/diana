const chooseChallengeIconMock = jest.fn();
const createLinkChallengeMock = jest.fn();
const createSelfAssertedLinkMock = jest.fn();
const deleteLinkChallengeMock = jest.fn();
const getLinkChallengeMock = jest.fn();
const resolveIdentityMock = jest.fn();

jest.mock('../packages/diana-core/src/core/identity/identityService', () => ({
    chooseChallengeIcon: chooseChallengeIconMock,
    createLinkChallenge: createLinkChallengeMock,
    createSelfAssertedLink: createSelfAssertedLinkMock,
    deleteLinkChallenge: deleteLinkChallengeMock,
    getLinkChallenge: getLinkChallengeMock,
    resolveIdentity: resolveIdentityMock,
    // Unused by these handlers, but the module is mocked wholesale and
    // identityApi imports them.
    getAccountsForIdentity: jest.fn(),
    linkAccount: jest.fn(),
    unlinkAccount: jest.fn(),
    getOrCreateIdentityForAccount: jest.fn(),
}));

const getAccountByRiotIdMock = jest.fn();
const getSummonerByPUUIDMock = jest.fn();
const createLolServiceMock = jest.fn();

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/lolService/lolServiceFactory',
    () => ({ createLolService: createLolServiceMock })
);

const getProfileByNameMock = jest.fn();

jest.mock(
    '../packages/diana-core/src/plugins/diana-r6-bot/api/utils/r6ServiceFactory',
    () => ({
        createR6Service: () => ({ getProfileByName: getProfileByNameMock }),
    })
);

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/dataDragonService',
    () => ({
        buildProfileIconUrl: (id: number) => `https://ddragon.test/${id}.png`,
    })
);

import {
    cancelRiotChallenge,
    getRiotChallenge,
    linkR6Account,
    startRiotChallenge,
} from '../packages/diana-core/src/core/api/identityApi';

/**
 * The linking half of the identity API (022) — what Meeps' Settings →
 * Connections screen talks to.
 *
 * The two flows are deliberately asymmetric and the tests say so. Riot gets a
 * handshake because Riot exposes a profile field a player can be asked to
 * change; Siege gets none, because Ubisoft publishes no OAuth and Siege has no
 * equivalent field. The Siege tests below pin that the link is recorded as
 * `self_asserted` rather than quietly borrowing `trusted`, which would imply
 * somebody had decided to trust it.
 */

function makeRes() {
    const res: any = {
        statusCode: 200,
        body: undefined,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(payload: unknown) {
            this.body = payload;
            return this;
        },
    };
    return res;
}

const EMPTY = {
    identityId: null,
    puuids: [],
    discordUserIds: [],
    meepsUserIds: [],
    r6UbisoftIds: [],
    verifiedPuuids: [],
};

const MEEPS_BODY = { subjectKind: 'meeps_user', subjectId: 'meeps-1' };

/** A Riot error as `twisted` throws it: a status on a plain object. */
const riotError = (status: number) =>
    Object.assign(new Error('riot'), { status });

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    createLolServiceMock.mockReturnValue({
        getAccountByRiotId: getAccountByRiotIdMock,
        getSummonerByPUUID: getSummonerByPUUIDMock,
    });
    getAccountByRiotIdMock.mockResolvedValue({
        puuid: 'puuid-1',
        gameName: 'Louis',
        tagLine: 'EUW',
    });
    getSummonerByPUUIDMock.mockResolvedValue({ profileIconId: 4 });
    chooseChallengeIconMock.mockReturnValue(17);
    createLinkChallengeMock.mockResolvedValue({
        expires_at: '2026-08-06T12:00:00.000Z',
    });
    resolveIdentityMock.mockResolvedValue(EMPTY);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('POST /api/identity/riot/challenge', () => {
    it('opens a handshake for a Meeps user with no Discord account', async () => {
        // The case the old schema could not express at all: before 022 a
        // challenge was keyed on a Discord snowflake, so the only way to give
        // this person one was to invent a fake snowflake for them.
        const res = makeRes();
        await startRiotChallenge(
            {
                body: { ...MEEPS_BODY, gameName: 'Louis', tagLine: 'EUW' },
            } as any,
            res
        );

        expect(res.statusCode).toBe(200);
        expect(createLinkChallengeMock).toHaveBeenCalledWith(
            { kind: 'meeps_user', id: 'meeps-1' },
            expect.objectContaining({ puuid: 'puuid-1' }),
            17
        );
        expect(res.body.requiredIcon).toBe(17);
        expect(res.body.expiresAt).toBe('2026-08-06T12:00:00.000Z');
    });

    it('never asks for the icon they already have', async () => {
        // A "verification" that passes on a player who changed nothing verifies
        // nothing, which is the entire reason chooseChallengeIcon is given the
        // current one.
        getSummonerByPUUIDMock.mockResolvedValue({ profileIconId: 9 });

        const res = makeRes();
        await startRiotChallenge(
            {
                body: { ...MEEPS_BODY, gameName: 'Louis', tagLine: 'EUW' },
            } as any,
            res
        );

        expect(chooseChallengeIconMock).toHaveBeenCalledWith(9);
        expect(res.statusCode).toBe(200);
    });

    it('sends the picture, not just the number', async () => {
        // The client's icon picker is a grid of images and displays an id
        // nowhere, so "set your icon to #17" asks for something the player has
        // no way to look up.
        const res = makeRes();
        await startRiotChallenge(
            {
                body: { ...MEEPS_BODY, gameName: 'Louis', tagLine: 'EUW' },
            } as any,
            res
        );

        expect(res.body.iconUrl).toBe('https://ddragon.test/17.png');
    });

    it('refuses an account that is already somebody else’s', async () => {
        resolveIdentityMock.mockResolvedValue({
            ...EMPTY,
            identityId: 'id-other',
            puuids: ['puuid-1'],
            meepsUserIds: ['meeps-someone-else'],
        });

        const res = makeRes();
        await startRiotChallenge(
            {
                body: { ...MEEPS_BODY, gameName: 'Louis', tagLine: 'EUW' },
            } as any,
            res
        );

        expect(res.statusCode).toBe(409);
        expect(res.body.reason).toBe('already_linked');
        expect(createLinkChallengeMock).not.toHaveBeenCalled();
    });

    it('lets somebody re-link the account they already hold', async () => {
        // Re-linking is how an unverified link becomes a verified one. Refusing
        // it would fail for the one person entitled to try.
        resolveIdentityMock.mockResolvedValue({
            ...EMPTY,
            identityId: 'id-1',
            puuids: ['puuid-1'],
            meepsUserIds: ['meeps-1'],
        });

        const res = makeRes();
        await startRiotChallenge(
            {
                body: { ...MEEPS_BODY, gameName: 'Louis', tagLine: 'EUW' },
            } as any,
            res
        );

        expect(res.statusCode).toBe(200);
        expect(createLinkChallengeMock).toHaveBeenCalled();
    });

    it('turns a Riot 404 into something a person can act on', async () => {
        getAccountByRiotIdMock.mockRejectedValue(riotError(404));

        const res = makeRes();
        await startRiotChallenge(
            {
                body: { ...MEEPS_BODY, gameName: 'Nobody', tagLine: 'ZZZ' },
            } as any,
            res
        );

        expect(res.statusCode).toBe(404);
        expect(res.body.reason).toBe('not_found');
        expect(res.body.error).toContain('Check the spelling');
    });

    it('does not blame the player for an expired API key', async () => {
        // A 403 is the operator's problem. Meeps needs to know not to offer a
        // retry, which is what the reason is for.
        getAccountByRiotIdMock.mockRejectedValue(riotError(403));

        const res = makeRes();
        await startRiotChallenge(
            {
                body: { ...MEEPS_BODY, gameName: 'Louis', tagLine: 'EUW' },
            } as any,
            res
        );

        expect(res.statusCode).toBe(502);
        expect(res.body.reason).toBe('upstream_forbidden');
    });

    it('says so plainly when this Diana has no Riot key', async () => {
        // Not a 500 the caller will sit there retrying: the deployment cannot
        // verify anybody and no amount of trying again will change that.
        createLolServiceMock.mockImplementation(() => {
            throw new Error('RIOT_API_KEY is not set');
        });
        jest.resetModules();
        const { startRiotChallenge: fresh } =
            await import('../packages/diana-core/src/core/api/identityApi');

        const res = makeRes();
        await fresh(
            {
                body: { ...MEEPS_BODY, gameName: 'Louis', tagLine: 'EUW' },
            } as any,
            res
        );

        expect(res.statusCode).toBe(503);
        expect(res.body.reason).toBe('no_riot_key');
    });

    it('refuses a puuid as the subject', async () => {
        // The thing being linked is never the person doing the linking, and
        // accepting one would anchor an identity on a game account.
        const res = makeRes();
        await startRiotChallenge(
            {
                body: {
                    subjectKind: 'riot_puuid',
                    subjectId: 'puuid-1',
                    gameName: 'Louis',
                    tagLine: 'EUW',
                },
            } as any,
            res
        );

        expect(res.statusCode).toBe(400);
        expect(getAccountByRiotIdMock).not.toHaveBeenCalled();
    });

    it('rejects a region Riot does not have', async () => {
        const res = makeRes();
        await startRiotChallenge(
            {
                body: {
                    ...MEEPS_BODY,
                    gameName: 'Louis',
                    tagLine: 'EUW',
                    region: 'MIDDLE_EARTH',
                },
            } as any,
            res
        );

        expect(res.statusCode).toBe(400);
        expect(getAccountByRiotIdMock).not.toHaveBeenCalled();
    });
});

describe('GET /api/identity/riot/challenge', () => {
    it('answers 200 with a null challenge rather than 404', async () => {
        // Having no link in progress is the ordinary state. A 404 would put a
        // failure path on the common case, as it would for /resolve.
        getLinkChallengeMock.mockResolvedValue(null);

        const res = makeRes();
        await getRiotChallenge({ query: MEEPS_BODY } as any, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.challenge).toBeNull();
    });

    it('returns the open challenge, which is how Meeps polls', async () => {
        getLinkChallengeMock.mockResolvedValue({
            subject_kind: 'meeps_user',
            subject_id: 'meeps-1',
            puuid: 'puuid-1',
            game_name: 'Louis',
            tag_line: 'EUW',
            region: 'EUW1',
            required_icon: 17,
            expires_at: '2026-08-06T12:00:00.000Z',
        });

        const res = makeRes();
        await getRiotChallenge({ query: MEEPS_BODY } as any, res);

        expect(res.body.challenge).toMatchObject({
            requiredIcon: 17,
            iconUrl: 'https://ddragon.test/17.png',
            gameName: 'Louis',
        });
    });
});

describe('DELETE /api/identity/riot/challenge', () => {
    it('cancels, so a mistyped name is not a 24-hour wait', async () => {
        deleteLinkChallengeMock.mockResolvedValue(undefined);

        const res = makeRes();
        await cancelRiotChallenge({ query: MEEPS_BODY } as any, res);

        expect(deleteLinkChallengeMock).toHaveBeenCalledWith({
            kind: 'meeps_user',
            id: 'meeps-1',
        });
        expect(res.body.cancelled).toBe(true);
    });
});

describe('POST /api/identity/r6', () => {
    beforeEach(() => {
        getProfileByNameMock.mockResolvedValue({
            ubisoftId: 'ubi-1',
            gameName: 'Aidan.TTV',
            platform: 'uplay',
            rank: { tier: 'Platinum', division: 4, rp: 3200 },
        });
        createSelfAssertedLinkMock.mockResolvedValue({
            ok: true,
            account: {
                kind: 'r6_ubisoft',
                external_id: 'ubi-1',
                identity_id: 'id-1',
                verified_at: null,
                method: 'self_asserted',
            },
        });
    });

    it('links a Siege account and records that nobody verified it', async () => {
        // The distinction the whole method vocabulary exists for. A row that
        // claimed to be verified would let a privilege check trust a claimant.
        const res = makeRes();
        await linkR6Account(
            { body: { ...MEEPS_BODY, gameName: 'Aidan.TTV' } } as any,
            res
        );

        expect(res.statusCode).toBe(200);
        expect(createSelfAssertedLinkMock).toHaveBeenCalledWith(
            { kind: 'meeps_user', id: 'meeps-1' },
            'r6_ubisoft',
            'ubi-1'
        );
        expect(res.body.account.verified_at).toBeNull();
        expect(res.body.account.method).toBe('self_asserted');
    });

    it('resolves the name to a ubisoftId, which is what R6 events are keyed on', async () => {
        // The point of the lookup. It is not verification — it turns a name
        // into the id `r6_players` and every rank notification already use, and
        // rejects a typo that would otherwise be a permanent link to nothing.
        const res = makeRes();
        await linkR6Account(
            { body: { ...MEEPS_BODY, gameName: 'Aidan.TTV' } } as any,
            res
        );

        expect(res.body.player.ubisoftId).toBe('ubi-1');
    });

    it('defaults the platform to uplay', async () => {
        const res = makeRes();
        await linkR6Account(
            { body: { ...MEEPS_BODY, gameName: 'Aidan.TTV' } } as any,
            res
        );

        expect(getProfileByNameMock).toHaveBeenCalledWith('Aidan.TTV', 'uplay');
        expect(res.statusCode).toBe(200);
    });

    it('rejects a platform Ubisoft does not have', async () => {
        const res = makeRes();
        await linkR6Account(
            {
                body: {
                    ...MEEPS_BODY,
                    gameName: 'Aidan.TTV',
                    platform: 'switch',
                },
            } as any,
            res
        );

        expect(res.statusCode).toBe(400);
        expect(getProfileByNameMock).not.toHaveBeenCalled();
    });

    it('says a name does not exist rather than linking to nothing', async () => {
        getProfileByNameMock.mockRejectedValue(riotError(404));

        const res = makeRes();
        await linkR6Account(
            { body: { ...MEEPS_BODY, gameName: 'Typo' } } as any,
            res
        );

        expect(res.statusCode).toBe(404);
        expect(res.body.reason).toBe('not_found');
        expect(createSelfAssertedLinkMock).not.toHaveBeenCalled();
    });

    it('refuses an account that is already somebody else’s', async () => {
        // One Siege account belongs to one person — the primary key says so.
        // A contested link is a person to talk to, not a race to win, and
        // self-assertion makes that more important rather than less.
        resolveIdentityMock.mockResolvedValue({
            ...EMPTY,
            identityId: 'id-other',
            r6UbisoftIds: ['ubi-1'],
            meepsUserIds: ['meeps-someone-else'],
        });

        const res = makeRes();
        await linkR6Account(
            { body: { ...MEEPS_BODY, gameName: 'Aidan.TTV' } } as any,
            res
        );

        expect(res.statusCode).toBe(409);
        expect(res.body.reason).toBe('already_linked');
        expect(createSelfAssertedLinkMock).not.toHaveBeenCalled();
    });

    it('409s on a link that was taken between the check and the write', async () => {
        createSelfAssertedLinkMock.mockResolvedValue({
            ok: false,
            reason: 'already_linked',
            identityId: 'id-other',
        });

        const res = makeRes();
        await linkR6Account(
            { body: { ...MEEPS_BODY, gameName: 'Aidan.TTV' } } as any,
            res
        );

        expect(res.statusCode).toBe(409);
    });

    it('requires a subject', async () => {
        const res = makeRes();
        await linkR6Account({ body: { gameName: 'Aidan.TTV' } } as any, res);

        expect(res.statusCode).toBe(400);
        expect(getProfileByNameMock).not.toHaveBeenCalled();
    });
});

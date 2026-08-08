const resolveIdentityMock = jest.fn();
const getAccountsForIdentityMock = jest.fn();
const linkAccountMock = jest.fn();
const unlinkAccountMock = jest.fn();
const getOrCreateIdentityForAccountMock = jest.fn();

jest.mock('../packages/diana-core/src/core/identity/identityService', () => ({
    resolveIdentity: resolveIdentityMock,
    getAccountsForIdentity: getAccountsForIdentityMock,
    linkAccount: linkAccountMock,
    unlinkAccount: unlinkAccountMock,
    getOrCreateIdentityForAccount: getOrCreateIdentityForAccountMock,
}));

// Unlinking a Siege account also withdraws it from polling (migration 025).
const removeR6PlayerFromAllSquadsMock = jest.fn();
const countTrackersOfR6PlayerMock = jest.fn();
const deleteR6PlayerMock = jest.fn();

jest.mock(
    '../packages/diana-core/src/plugins/diana-r6-bot/api/players/playerService',
    () => ({
        removeR6PlayerFromAllSquads: (...args: unknown[]) =>
            removeR6PlayerFromAllSquadsMock(...args),
        countTrackersOfR6Player: (...args: unknown[]) =>
            countTrackersOfR6PlayerMock(...args),
        deleteR6Player: (...args: unknown[]) => deleteR6PlayerMock(...args),
        // Imported by identityApi for the link path, unused here.
        ensureR6Player: jest.fn(),
        getR6PlayerById: jest.fn(),
        addR6PlayerToSquad: jest.fn(),
        createR6RankHistory: jest.fn(),
    })
);

jest.mock('../packages/diana-core/src/core/squads/squadService', () => ({
    getSquadIdForAttachment: jest.fn(),
}));

import {
    getIdentity,
    linkMeepsUser,
    resolveAccount,
    unlinkAccountRoute,
} from '../packages/diana-core/src/core/api/identityApi';

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
    verifiedPuuids: [],
};

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('GET /api/identity/resolve', () => {
    it('returns the puuids for a Meeps user — the join Meeps needs', async () => {
        resolveIdentityMock.mockResolvedValue({
            ...EMPTY,
            identityId: 'id-1',
            puuids: ['puuid-1'],
            meepsUserIds: ['meeps-1'],
        });

        const res = makeRes();
        await resolveAccount(
            { query: { kind: 'meeps_user', externalId: 'meeps-1' } } as any,
            res
        );

        expect(res.statusCode).toBe(200);
        expect(res.body.puuids).toEqual(['puuid-1']);
    });

    it('answers 200 with empty lists for an unlinked account', async () => {
        // Most people are unlinked most of the time. A 404 would put a failure
        // path on the common case.
        resolveIdentityMock.mockResolvedValue(EMPTY);

        const res = makeRes();
        await resolveAccount(
            { query: { kind: 'meeps_user', externalId: 'nobody' } } as any,
            res
        );

        expect(res.statusCode).toBe(200);
        expect(res.body.identityId).toBeNull();
    });

    it('rejects an unknown kind', async () => {
        const res = makeRes();
        await resolveAccount(
            { query: { kind: 'steam_user', externalId: 'x' } } as any,
            res
        );
        expect(res.statusCode).toBe(400);
        expect(resolveIdentityMock).not.toHaveBeenCalled();
    });

    it('rejects a missing externalId', async () => {
        const res = makeRes();
        await resolveAccount({ query: { kind: 'meeps_user' } } as any, res);
        expect(res.statusCode).toBe(400);
    });

    it('500s when resolution fails', async () => {
        resolveIdentityMock.mockRejectedValue(new Error('db down'));
        const res = makeRes();
        await resolveAccount(
            { query: { kind: 'meeps_user', externalId: 'm' } } as any,
            res
        );
        expect(res.statusCode).toBe(500);
    });
});

describe('GET /api/identity/:identityId', () => {
    it('returns every account on the identity', async () => {
        getAccountsForIdentityMock.mockResolvedValue([
            { kind: 'riot_puuid', external_id: 'puuid-1' },
        ]);

        const res = makeRes();
        await getIdentity({ params: { identityId: 'id-1' } } as any, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.accounts).toHaveLength(1);
    });

    it('404s for an identity with no accounts', async () => {
        getAccountsForIdentityMock.mockResolvedValue([]);
        const res = makeRes();
        await getIdentity({ params: { identityId: 'ghost' } } as any, res);
        expect(res.statusCode).toBe(404);
    });
});

describe('POST /api/identity/meeps-user', () => {
    it('attaches the Meeps user to the anchor’s identity', async () => {
        getOrCreateIdentityForAccountMock.mockResolvedValue('id-1');
        linkAccountMock.mockResolvedValue({
            ok: true,
            account: { kind: 'meeps_user' },
        });

        const res = makeRes();
        await linkMeepsUser(
            {
                body: {
                    meepsUserId: 'meeps-1',
                    anchorKind: 'discord_user',
                    anchorId: 'discord-1',
                },
            } as any,
            res
        );

        expect(getOrCreateIdentityForAccountMock).toHaveBeenCalledWith(
            'discord_user',
            'discord-1'
        );
        expect(linkAccountMock).toHaveBeenCalledWith(
            'id-1',
            'meeps_user',
            'meeps-1'
        );
        expect(res.statusCode).toBe(200);
    });

    it('409s rather than moving an account somebody else owns', async () => {
        getOrCreateIdentityForAccountMock.mockResolvedValue('id-1');
        linkAccountMock.mockResolvedValue({
            ok: false,
            reason: 'already_linked',
            identityId: 'id-other',
        });

        const res = makeRes();
        await linkMeepsUser(
            {
                body: {
                    meepsUserId: 'meeps-1',
                    anchorKind: 'discord_user',
                    anchorId: 'discord-1',
                },
            } as any,
            res
        );

        expect(res.statusCode).toBe(409);
        expect(res.body.identityId).toBe('id-other');
    });

    it('refuses to anchor a Meeps user to a Meeps user', async () => {
        // Says nothing, and would silently create a fresh identity holding
        // one account.
        const res = makeRes();
        await linkMeepsUser(
            {
                body: {
                    meepsUserId: 'meeps-1',
                    anchorKind: 'meeps_user',
                    anchorId: 'meeps-2',
                },
            } as any,
            res
        );

        expect(res.statusCode).toBe(400);
        expect(getOrCreateIdentityForAccountMock).not.toHaveBeenCalled();
    });

    it('requires a meepsUserId', async () => {
        const res = makeRes();
        await linkMeepsUser(
            { body: { anchorKind: 'discord_user', anchorId: 'd' } } as any,
            res
        );
        expect(res.statusCode).toBe(400);
    });

    it('requires an anchor', async () => {
        const res = makeRes();
        await linkMeepsUser({ body: { meepsUserId: 'meeps-1' } } as any, res);
        expect(res.statusCode).toBe(400);
    });

    it('500s when the link fails', async () => {
        getOrCreateIdentityForAccountMock.mockRejectedValue(
            new Error('db down')
        );
        const res = makeRes();
        await linkMeepsUser(
            {
                body: {
                    meepsUserId: 'm',
                    anchorKind: 'discord_user',
                    anchorId: 'd',
                },
            } as any,
            res
        );
        expect(res.statusCode).toBe(500);
    });
});

describe('DELETE /api/identity/:kind/:externalId', () => {
    it('removes a link', async () => {
        unlinkAccountMock.mockResolvedValue(true);
        const res = makeRes();
        await unlinkAccountRoute(
            { params: { kind: 'meeps_user', externalId: 'meeps-1' } } as any,
            res
        );
        expect(res.body).toEqual({ removed: true });
    });

    it('is idempotent — unlinking nothing is a success', async () => {
        unlinkAccountMock.mockResolvedValue(false);
        const res = makeRes();
        await unlinkAccountRoute(
            { params: { kind: 'meeps_user', externalId: 'gone' } } as any,
            res
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ removed: false });
    });

    /**
     * Giving up a Siege link gives up the polling that came with it.
     *
     * Without this the enrolment outlives the link: nothing in Meeps would still
     * show the account, and the poller would go on spending a call on it every
     * hour for as long as the deployment lives — against a plan that affords
     * about five players.
     */
    describe('withdrawing a Siege enrolment', () => {
        beforeEach(() => {
            jest.clearAllMocks();
            unlinkAccountMock.mockResolvedValue(true);
            removeR6PlayerFromAllSquadsMock.mockResolvedValue(1);
            countTrackersOfR6PlayerMock.mockResolvedValue(0);
            deleteR6PlayerMock.mockResolvedValue(null);
        });

        const unlinkR6 = async () => {
            const res = makeRes();
            await unlinkAccountRoute(
                {
                    params: { kind: 'r6_ubisoft', externalId: 'ubi-1' },
                } as any,
                res
            );
            return res;
        };

        it('drops the squad enrolments and the now-untracked player row', async () => {
            const res = await unlinkR6();

            expect(removeR6PlayerFromAllSquadsMock).toHaveBeenCalledWith(
                'ubi-1'
            );
            expect(deleteR6PlayerMock).toHaveBeenCalledWith('ubi-1');
            expect(res.body).toEqual({ removed: true });
        });

        it('keeps the player row when a Discord server still tracks them', async () => {
            // One player, two independent reasons to be polled. Unlinking is a
            // statement about one of them, and deleting the row would cascade
            // the other away from a server that never asked.
            countTrackersOfR6PlayerMock.mockResolvedValue(1);

            await unlinkR6();

            expect(removeR6PlayerFromAllSquadsMock).toHaveBeenCalled();
            expect(deleteR6PlayerMock).not.toHaveBeenCalled();
        });

        it('leaves the row alone when there was no enrolment to withdraw', async () => {
            // Somebody who linked before 025, or linked with no space attached.
            // They have no squad rows, so this must not become a licence to
            // delete a player row that `/r6-add` owns.
            removeR6PlayerFromAllSquadsMock.mockResolvedValue(0);

            await unlinkR6();

            expect(countTrackersOfR6PlayerMock).not.toHaveBeenCalled();
            expect(deleteR6PlayerMock).not.toHaveBeenCalled();
        });

        it('still reports the unlink when withdrawing throws', async () => {
            jest.spyOn(console, 'error').mockImplementation(() => {});
            removeR6PlayerFromAllSquadsMock.mockRejectedValue(
                new Error('db is down')
            );

            const res = await unlinkR6();

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ removed: true });
        });

        it('does not touch the Siege roster when unlinking anything else', async () => {
            const res = makeRes();
            await unlinkAccountRoute(
                {
                    params: { kind: 'riot_puuid', externalId: 'puuid-1' },
                } as any,
                res
            );

            expect(removeR6PlayerFromAllSquadsMock).not.toHaveBeenCalled();
        });
    });

    it('rejects an unknown kind', async () => {
        const res = makeRes();
        await unlinkAccountRoute(
            { params: { kind: 'nope', externalId: 'x' } } as any,
            res
        );
        expect(res.statusCode).toBe(400);
        expect(unlinkAccountMock).not.toHaveBeenCalled();
    });
});

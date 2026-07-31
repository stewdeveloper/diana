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

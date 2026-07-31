const getPrivacyMock = jest.fn();
const setHiddenMock = jest.fn();

jest.mock('../packages/diana-core/src/core/privacy/privacyService', () => {
    const actual = jest.requireActual(
        '../packages/diana-core/src/core/privacy/privacyService'
    );
    return {
        ...actual,
        getPrivacy: getPrivacyMock,
        setHidden: setHiddenMock,
    };
});

import {
    getSummonerPrivacy,
    putSummonerPrivacy,
} from '../packages/diana-core/src/core/api/privacyApi';

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

beforeEach(() => {
    getPrivacyMock.mockReset();
    setHiddenMock.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('GET /api/privacy/:puuid', () => {
    it('returns the stored decision', async () => {
        const row = {
            puuid: 'p1',
            hidden: true,
            set_by: 'u1',
            updated_at: '2026-07-31T00:00:00.000Z',
        };
        getPrivacyMock.mockResolvedValue(row);

        const res = makeRes();
        await getSummonerPrivacy({ params: { puuid: 'p1' } } as any, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(row);
    });

    it('answers "visible" for a player who never decided, not 404', async () => {
        // Never deciding is the default state, not a missing resource. Making
        // callers branch on 404 to discover "not hidden" would be a worse API.
        getPrivacyMock.mockResolvedValue(null);

        const res = makeRes();
        await getSummonerPrivacy({ params: { puuid: 'p1' } } as any, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ puuid: 'p1', hidden: false });
    });

    it('400s without a puuid', async () => {
        const res = makeRes();
        await getSummonerPrivacy({ params: {} } as any, res);
        expect(res.statusCode).toBe(400);
    });

    it('500s when the read fails', async () => {
        getPrivacyMock.mockRejectedValue(new Error('db down'));
        const res = makeRes();
        await getSummonerPrivacy({ params: { puuid: 'p1' } } as any, res);
        expect(res.statusCode).toBe(500);
    });
});

describe('PUT /api/privacy/:puuid', () => {
    it('records the decision', async () => {
        setHiddenMock.mockResolvedValue({ puuid: 'p1', hidden: true });

        const res = makeRes();
        await putSummonerPrivacy(
            {
                params: { puuid: 'p1' },
                body: { hidden: true, setBy: 'u1' },
            } as any,
            res
        );

        expect(setHiddenMock).toHaveBeenCalledWith('p1', true, 'u1');
        expect(res.statusCode).toBe(200);
    });

    it('rejects a non-boolean hidden', async () => {
        // 'true' is the commonest way to get this wrong from a form, and
        // coercing it would let a typo silently un-hide somebody.
        const res = makeRes();
        await putSummonerPrivacy(
            { params: { puuid: 'p1' }, body: { hidden: 'true' } } as any,
            res
        );
        expect(res.statusCode).toBe(400);
        expect(setHiddenMock).not.toHaveBeenCalled();
    });

    it('rejects a missing body', async () => {
        const res = makeRes();
        await putSummonerPrivacy({ params: { puuid: 'p1' } } as any, res);
        expect(res.statusCode).toBe(400);
    });

    it('drops a blank setBy rather than storing whitespace', async () => {
        setHiddenMock.mockResolvedValue({});
        const res = makeRes();
        await putSummonerPrivacy(
            {
                params: { puuid: 'p1' },
                body: { hidden: false, setBy: '  ' },
            } as any,
            res
        );
        expect(setHiddenMock).toHaveBeenCalledWith('p1', false, undefined);
    });

    it('404s for an untracked puuid rather than 500', async () => {
        // Foreign key violation. The player is not tracked, which is the
        // caller's mistake and not a server fault.
        setHiddenMock.mockRejectedValue(
            Object.assign(new Error('fk'), { code: '23503' })
        );
        const res = makeRes();
        await putSummonerPrivacy(
            { params: { puuid: 'nope' }, body: { hidden: true } } as any,
            res
        );
        expect(res.statusCode).toBe(404);
    });

    it('500s on any other failure', async () => {
        setHiddenMock.mockRejectedValue(new Error('db down'));
        const res = makeRes();
        await putSummonerPrivacy(
            { params: { puuid: 'p1' }, body: { hidden: true } } as any,
            res
        );
        expect(res.statusCode).toBe(500);
    });
});

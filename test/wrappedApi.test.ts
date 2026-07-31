export {};

const computeSquadWrappedMock = jest.fn();

jest.mock('../packages/diana-core/src/core/wrapped/wrappedService', () => ({
    computeSquadWrapped: computeSquadWrappedMock,
}));

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({ db: { query: jest.fn() } })
);

import {
    getSquadWrapped,
    parsePeriodFromQuery,
} from '../packages/diana-core/src/core/api/wrappedApi';

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

const req = (params: any = {}, query: any = {}) => ({ params, query }) as any;

beforeEach(() => {
    jest.clearAllMocks();
    computeSquadWrappedMock.mockResolvedValue({ squadId: 'sq1' });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('parsePeriodFromQuery', () => {
    it('defaults to the 90-day window when nothing is asked for', () => {
        const period = parsePeriodFromQuery({});
        expect(typeof period).not.toBe('string');
        expect((period as any).key).toBe('split');
    });

    it('accepts a named preset', () => {
        expect((parsePeriodFromQuery({ period: 'year' }) as any).key).toBe(
            'year'
        );
    });

    it('rejects a preset it does not have, and says which it has', () => {
        const result = parsePeriodFromQuery({ period: 'fortnight' });
        expect(typeof result).toBe('string');
        expect(result).toContain('split');
    });

    it('lets an explicit window win over a preset', () => {
        // The escape hatch for an operator who knows the real split dates,
        // which this codebase deliberately does not.
        const period = parsePeriodFromQuery({
            period: 'month',
            from: '2026-05-01T00:00:00Z',
            to: '2026-09-01T00:00:00Z',
            label: 'Split 2',
        });
        expect((period as any).key).toBe('custom');
        expect((period as any).label).toBe('Split 2');
    });

    it('refuses half a window', () => {
        expect(parsePeriodFromQuery({ from: '2026-05-01T00:00:00Z' })).toBe(
            'from and to must be given together'
        );
        expect(parsePeriodFromQuery({ to: '2026-05-01T00:00:00Z' })).toBe(
            'from and to must be given together'
        );
    });

    it('refuses an unparseable or backwards window', () => {
        expect(
            typeof parsePeriodFromQuery({ from: 'yesterday', to: 'today' })
        ).toBe('string');
        expect(
            typeof parsePeriodFromQuery({
                from: '2026-09-01T00:00:00Z',
                to: '2026-05-01T00:00:00Z',
            })
        ).toBe('string');
    });
});

describe('GET /api/squads/:squadId/wrapped', () => {
    it('returns the card', async () => {
        const res = makeRes();
        await getSquadWrapped(req({ squadId: 'sq1' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.wrapped).toEqual({ squadId: 'sq1' });
        expect(res.body.period.key).toBe('split');
    });

    it('answers 200 with a null card for a quiet period, not 404', async () => {
        // "This group played no games in July" is a true answer about a squad
        // that exists; a 404 would make an ordinary quiet month look like a
        // broken squad id.
        computeSquadWrappedMock.mockResolvedValue(null);
        const res = makeRes();
        await getSquadWrapped(req({ squadId: 'sq1' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.wrapped).toBeNull();
    });

    it('passes the resolved window down rather than re-deriving it', async () => {
        const res = makeRes();
        await getSquadWrapped(req({ squadId: 'sq1' }, { period: 'all' }), res);
        expect(computeSquadWrappedMock).toHaveBeenCalledWith(
            'sq1',
            expect.objectContaining({
                period: expect.objectContaining({ key: 'all' }),
            })
        );
    });

    it('honours the competitive scope the caller asked for', async () => {
        const res = makeRes();
        await getSquadWrapped(
            req({ squadId: 'sq1' }, { scope: 'ranked' }),
            res
        );
        expect(computeSquadWrappedMock).toHaveBeenCalledWith(
            'sq1',
            expect.objectContaining({ scope: 'ranked' })
        );
    });

    it('defaults an unrecognised scope rather than failing', async () => {
        const res = makeRes();
        await getSquadWrapped(req({ squadId: 'sq1' }, { scope: 'silly' }), res);
        expect(computeSquadWrappedMock).toHaveBeenCalledWith(
            'sq1',
            expect.objectContaining({ scope: 'all' })
        );
    });

    it('400s on a bad period without touching the database', async () => {
        const res = makeRes();
        await getSquadWrapped(
            req({ squadId: 'sq1' }, { period: 'fortnight' }),
            res
        );
        expect(res.statusCode).toBe(400);
        expect(computeSquadWrappedMock).not.toHaveBeenCalled();
    });

    it('400s without a squad id', async () => {
        const res = makeRes();
        await getSquadWrapped(req({}), res);
        expect(res.statusCode).toBe(400);
    });

    it('500s when the computation fails', async () => {
        computeSquadWrappedMock.mockRejectedValue(new Error('db down'));
        const res = makeRes();
        await getSquadWrapped(req({ squadId: 'sq1' }), res);
        expect(res.statusCode).toBe(500);
    });
});

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({
        db: {
            query: jest.fn(),
        },
    })
);

import { db } from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db';
import {
    getHiddenPuuids,
    getPrivacy,
    isHidden,
    notHiddenPredicate,
    setHidden,
    setHiddenForAll,
} from '../packages/diana-core/src/core/privacy/privacyService';

const queryMock = db.query as unknown as jest.Mock;

/** Collapse whitespace so assertions do not depend on SQL indentation. */
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

beforeEach(() => {
    queryMock.mockReset();
});

describe('notHiddenPredicate', () => {
    it('tests the column it is given', () => {
        expect(flat(notHiddenPredicate('s."puuid"'))).toContain(
            'sp."puuid" = s."puuid"'
        );
    });

    it('only excludes rows that are explicitly hidden', () => {
        // The distinction that makes absence mean visible: a row with
        // hidden = false must not filter anybody out.
        expect(flat(notHiddenPredicate('ms."puuid"'))).toContain(
            'sp."hidden" = TRUE'
        );
    });

    it('is an anti-join, so it cannot multiply the outer rows', () => {
        expect(flat(notHiddenPredicate('s."puuid"'))).toMatch(
            /^NOT EXISTS \( SELECT 1 FROM summoner_privacy sp/
        );
    });
});

describe('isHidden', () => {
    it('is true when the row says hidden', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ hidden: true }] });
        await expect(isHidden('p1')).resolves.toBe(true);
    });

    it('is false when the row says visible', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ hidden: false }] });
        await expect(isHidden('p1')).resolves.toBe(false);
    });

    it('is false when there is no row at all', async () => {
        // Absence means visible. The inverse of presence_consent, deliberately.
        queryMock.mockResolvedValueOnce({ rows: [] });
        await expect(isHidden('p1')).resolves.toBe(false);
    });
});

describe('setHidden', () => {
    it('upserts and returns the stored row', async () => {
        const row = {
            puuid: 'p1',
            hidden: true,
            set_by: 'u1',
            updated_at: '2026-07-31T00:00:00.000Z',
        };
        queryMock.mockResolvedValueOnce({ rows: [row] });

        await expect(setHidden('p1', true, 'u1')).resolves.toEqual(row);

        const [sql, params] = queryMock.mock.calls[0];
        expect(flat(sql)).toContain('ON CONFLICT (puuid) DO UPDATE');
        expect(params).toEqual(['p1', true, 'u1']);
    });

    it('records a null setter rather than the string "undefined"', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{}] });
        await setHidden('p1', false);
        expect(queryMock.mock.calls[0][1]).toEqual(['p1', false, null]);
    });

    it('refreshes updated_at on an existing row', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{}] });
        await setHidden('p1', true, 'u1');
        expect(flat(queryMock.mock.calls[0][0])).toContain(
            'updated_at = NOW()'
        );
    });
});

describe('getPrivacy', () => {
    it('returns the row when one exists', async () => {
        const row = {
            puuid: 'p1',
            hidden: true,
            set_by: null,
            updated_at: '2026-07-31T00:00:00.000Z',
        };
        queryMock.mockResolvedValueOnce({ rows: [row] });
        await expect(getPrivacy('p1')).resolves.toEqual(row);
    });

    it('returns null when the player never decided', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        await expect(getPrivacy('p1')).resolves.toBeNull();
    });
});

describe('getHiddenPuuids', () => {
    it('returns only the hidden ones, as a set', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{ puuid: 'p2' }],
        });
        const hidden = await getHiddenPuuids(['p1', 'p2', 'p3']);
        expect(hidden.has('p2')).toBe(true);
        expect(hidden.has('p1')).toBe(false);
        expect(hidden.size).toBe(1);
    });

    it('does not query at all for an empty list', async () => {
        await expect(getHiddenPuuids([])).resolves.toEqual(new Set());
        expect(queryMock).not.toHaveBeenCalled();
    });
});

describe('setHiddenForAll', () => {
    it('applies one decision to every account', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 3 });
        await expect(
            setHiddenForAll(['a', 'b', 'c'], true, 'u1')
        ).resolves.toBe(3);
        expect(queryMock.mock.calls[0][1]).toEqual([
            ['a', 'b', 'c'],
            true,
            'u1',
        ]);
    });

    it('does not query at all for an empty list', async () => {
        await expect(setHiddenForAll([], true)).resolves.toBe(0);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('reports 0 rather than null when the driver gives no count', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: null });
        await expect(setHiddenForAll(['a'], false)).resolves.toBe(0);
    });
});

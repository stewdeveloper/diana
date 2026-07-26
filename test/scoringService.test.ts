export {};

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({
        db: { query: jest.fn() },
    })
);

import { db } from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db';
import { backfillMissingScores } from '../packages/diana-core/src/plugins/diana-league-bot/scoring/scoringService';

const queryMock = db.query as unknown as jest.Mock;

describe('backfillMissingScores', () => {
    beforeEach(() => {
        queryMock.mockReset();
        queryMock.mockResolvedValue({ rows: [] });
    });

    // Migration 013 deletes Arena rows from match_scores. /mvp and /iotw call
    // this whenever a guild has fewer than 5 scored games in a week, so without
    // an Arena filter here the backfill would silently recreate them.
    it('never re-scores Arena matches', async () => {
        await backfillMissingScores(0);
        const query = queryMock.mock.calls[0][0] as string;
        expect(query).toContain("<> 'CHERRY'");
        expect(query).toContain('NOT IN (1700,1701,1704,1710,1750)');
    });

    it('is not scope-aware - scoring is global, not per guild', async () => {
        await backfillMissingScores(0);
        const query = queryMock.mock.calls[0][0] as string;
        expect(query).not.toContain('IN (420,440)');
    });

    it('still skips matches that already have scores', async () => {
        await backfillMissingScores(0);
        const query = queryMock.mock.calls[0][0] as string;
        expect(query).toContain('NOT EXISTS');
        expect(queryMock.mock.calls[0][1]).toEqual([0]);
    });
});

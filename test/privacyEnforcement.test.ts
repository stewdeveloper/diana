jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({
        db: {
            query: jest.fn(),
        },
    })
);

import { db } from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db';
import { getInterCandidatesSince } from '../packages/diana-core/src/plugins/diana-league-bot/utils/interStats';
import { computeStandouts } from '../packages/diana-core/src/core/sessions/recapService';

const queryMock = db.query as unknown as jest.Mock;

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** Did this SQL carry the opt-out filter? */
const filtersPrivacy = (sql: string) =>
    flat(sql).includes('NOT EXISTS ( SELECT 1 FROM summoner_privacy sp');

beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [] });
});

/**
 * These are the tests that matter for DN-3.
 *
 * `privacyService.test.ts` proves the predicate is correct. These prove it is
 * actually *reached* on every surface the acceptance criterion names - "every
 * leaderboard, digest and recap" - because a correct filter nobody applies is
 * the failure mode this feature actually has.
 */
describe('privacy enforcement — where the filter reaches', () => {
    describe('interStats: rankings vs named lookups', () => {
        it('filters an aggregate read, which is what a leaderboard is', async () => {
            // No targetPuuid: /leaderboard, /iotw, /mvp and the digest all
            // call it exactly like this.
            await getInterCandidatesSince(0, { squadId: 'sq1' });
            expect(filtersPrivacy(queryMock.mock.calls[0][0])).toBe(true);
        });

        it('does not filter when the caller named somebody', async () => {
            // /summoner and /compare. Opting out of rankings is not vanishing
            // from a lookup where a person typed your name.
            await getInterCandidatesSince(0, { targetPuuid: 'p1' });
            expect(filtersPrivacy(queryMock.mock.calls[0][0])).toBe(false);
        });

        it('filters a named lookup when told to explicitly', async () => {
            await getInterCandidatesSince(0, {
                targetPuuid: 'p1',
                respectPrivacy: true,
            });
            expect(filtersPrivacy(queryMock.mock.calls[0][0])).toBe(true);
        });

        it('skips the filter on an aggregate when told to explicitly', async () => {
            // The escape hatch for an internal reader - an export, say, where
            // hiding the subject's own data would be absurd.
            await getInterCandidatesSince(0, {
                squadId: 'sq1',
                respectPrivacy: false,
            });
            expect(filtersPrivacy(queryMock.mock.calls[0][0])).toBe(false);
        });

        it('defaults to filtering when given no options at all', async () => {
            // The default is the thing protecting a future ranking surface
            // whose author never read this file.
            await getInterCandidatesSince(0);
            expect(filtersPrivacy(queryMock.mock.calls[0][0])).toBe(true);
        });

        it('keeps the squad and competitive filters alongside it', async () => {
            await getInterCandidatesSince(0, {
                squadId: 'sq1',
                scope: 'ranked',
            });
            const sql = flat(queryMock.mock.calls[0][0]);
            expect(sql).toContain('JOIN squad_summoners');
            expect(sql).toContain('"queueId" IN');
            expect(filtersPrivacy(sql)).toBe(true);
        });
    });

    describe('recap: the standout picker', () => {
        it('filters the scores a night chooses its best game from', async () => {
            await computeStandouts('sess-1', ['p1', 'p2']);
            expect(filtersPrivacy(queryMock.mock.calls[0][0])).toBe(true);
        });

        it('filters in the score query, not after picking', async () => {
            // Filtering after pickStandouts would let a hidden player win best
            // game and leave the card with no best game at all - turning one
            // person's privacy choice into a missing line for everybody.
            await computeStandouts('sess-1', ['p1']);

            const scoreQuery = flat(queryMock.mock.calls[0][0]);
            expect(scoreQuery).toContain('FROM session_matches sm');
            expect(filtersPrivacy(scoreQuery)).toBe(true);
        });

        it('still does no work at all for a squad with no roster', async () => {
            await expect(computeStandouts('sess-1', [])).resolves.toEqual({});
            expect(queryMock).not.toHaveBeenCalled();
        });
    });
});

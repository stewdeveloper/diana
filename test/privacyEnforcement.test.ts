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
import {
    fetchSquadMatches,
    fetchSquadScores,
    fetchVoiceByPerson,
} from '../packages/diana-core/src/core/wrapped/wrappedService';
import {
    computeChampionCounts,
    computePlayerTotals,
    computeSquadRecord,
    pickTopDuo,
} from '../packages/diana-core/src/core/wrapped/pairings';

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

    describe('wrapped: a card the group posts in public', () => {
        it('filters the scores it names a best game from', async () => {
            await fetchSquadScores('sq1', 0, 1);
            expect(filtersPrivacy(queryMock.mock.calls[0][0])).toBe(true);
        });

        it('does not drop the match itself when a participant is hidden', async () => {
            // The roster read is the one whose *count* has to survive a hidden
            // player: dropping the match would make the headline figure wrong.
            // The member is filtered in TypeScript instead - before any ranking,
            // which is the property that matters.
            await fetchSquadMatches(['p1'], 0, 1);
            expect(filtersPrivacy(queryMock.mock.calls[0][0])).toBe(false);
        });

        it('excludes a hidden player from every surface that names one', async () => {
            const matches = [
                {
                    matchId: 'M1',
                    playedAt: 1,
                    members: [
                        {
                            puuid: 'p1',
                            win: true,
                            teamId: 100,
                            championName: 'Lux',
                            kills: 1,
                            deaths: 1,
                            assists: 1,
                        },
                        {
                            puuid: 'hidden',
                            win: true,
                            teamId: 100,
                            championName: 'Yasuo',
                            kills: 1,
                            deaths: 1,
                            assists: 1,
                        },
                    ],
                },
            ];
            const hiddenPuuids = new Set(['hidden']);

            // Named surfaces: the roster board, the duo line, the champion line.
            expect(
                computePlayerTotals(matches, { hiddenPuuids }).map(
                    (t) => t.puuid
                )
            ).toEqual(['p1']);
            expect(pickTopDuo(matches, { hiddenPuuids })).toBeNull();
            expect(
                computeChampionCounts(matches, hiddenPuuids).map(
                    (c) => c.championName
                )
            ).toEqual(['Lux']);

            // Counted, not named: the match still happened.
            expect(computeSquadRecord(matches).totalGames).toBe(1);
        });

        it('filters voice time through identity, since it is keyed on a Meeps user', async () => {
            // Privacy is keyed on the puuid so that nobody has to identify
            // themselves to become invisible; voice is keyed on meeps_user_id so
            // that the friend who never plays is still counted. identity_accounts
            // is the only thing that joins them.
            await fetchVoiceByPerson('sq1', 'a', 'b');
            const sql = flat(queryMock.mock.calls[0][0]);
            expect(sql).toContain('FROM identity_accounts me');
            expect(sql).toContain(`riot."kind" = 'riot_puuid'`);
            expect(sql).toContain('summoner_privacy sp2');
            expect(sql).toContain(`me."kind" = 'meeps_user'`);
        });
    });
});

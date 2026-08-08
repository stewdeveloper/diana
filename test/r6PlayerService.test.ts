jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({
        db: { query: jest.fn() },
    })
);

import { db } from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db';
import {
    createR6RankHistory,
    getMostRecentR6Rank,
    countGuildsTrackingR6Player,
    countTrackersOfR6Player,
    getAllTrackedR6Players,
    getGuildsTrackingR6Player,
    getSquadsTrackingR6Player,
    getR6PlayerIdByName,
    addR6PlayerToSquad,
    removeR6PlayerFromAllSquads,
    ensureR6Player,
    markR6PlayerPolled,
    diffSnapshot,
} from '../packages/diana-core/src/plugins/diana-r6-bot/api/players/playerService';

const queryMock = db.query as unknown as jest.Mock;

/** The SQL a call issued, with runs of whitespace flattened. */
function sqlOf(call = 0): string {
    return String(queryMock.mock.calls[call]?.[0]).replace(/\s+/g, ' ').trim();
}

/**
 * The storage half of the Siege plugin.
 *
 * `db.query` is mocked, as it is for Apex, so these pin the statement each
 * function issues and the parameters it binds — not that the SQL is valid.
 * Where a statement's *validity* is the point (migration 021's table, and the
 * foreign key that made the original one impossible), that was verified by
 * running the migrations and both writes against Postgres directly; the
 * findings are recorded on the rows below.
 */
describe('r6PlayerService', () => {
    beforeEach(() => {
        queryMock.mockReset();
        queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    });

    describe('createR6RankHistory', () => {
        it('writes r6_rank_history, not the shared rank_tracking', () => {
            // rank_tracking."entryParticipantId" is a foreign key into
            // `summoners` (migration 004). A Ubisoft profile id is never a
            // summoner, so the original write raised
            //   violates foreign key constraint
            //   "rank_tracking_entryParticipantId_fkey"
            // on every single call — swallowed by a `.catch(() => {})`, which
            // is why the history was silently empty. Migration 021 gives Siege
            // its own table rather than loosening League's constraint.
            createR6RankHistory('R6_SYNC_1', 'ubi-abc', 'Platinum', 4, 3200);

            expect(sqlOf()).toContain('INSERT INTO r6_rank_history');
            expect(sqlOf()).not.toContain('rank_tracking');
            expect(queryMock.mock.calls[0]?.[1]).toEqual([
                'R6_SYNC_1',
                'ubi-abc',
                'Platinum',
                4,
                3200,
            ]);
        });

        it('binds division as a number, not the stringified rank column', () => {
            // The old statement reused rank_tracking's VARCHAR "rank" column
            // and bound String(division); r6_rank_history.division is an INT.
            createR6RankHistory('R6_SYNC_1', 'ubi-abc', 'Platinum', 4, 3200);
            expect(queryMock.mock.calls[0]?.[1]?.[3]).toBe(4);
        });

        it('is idempotent for a replayed sync id', () => {
            createR6RankHistory('R6_SYNC_1', 'ubi-abc', 'Platinum', 4, 3200);
            expect(sqlOf()).toContain(
                'ON CONFLICT ("syncId", "ubisoftId") DO NOTHING'
            );
        });
    });

    describe('getMostRecentR6Rank', () => {
        it('reads the newest row back out of r6_rank_history', async () => {
            queryMock.mockResolvedValueOnce({
                rows: [{ tier: 'Platinum', division: 3, rp: 3450 }],
            });

            await expect(getMostRecentR6Rank('ubi-abc')).resolves.toEqual({
                tier: 'Platinum',
                division: 3,
                rp: 3450,
            });
            expect(sqlOf()).toContain('FROM r6_rank_history');
            expect(sqlOf()).toContain('ORDER BY "recordedAt" DESC LIMIT 1');
        });

        it('returns null for a player with no history yet', async () => {
            await expect(getMostRecentR6Rank('ubi-abc')).resolves.toBeNull();
        });
    });

    describe('countGuildsTrackingR6Player', () => {
        it('counts guild_r6_players without joining guild_config', async () => {
            // The distinction this exists for: getGuildsTrackingR6Player
            // answers "where do I post", so it drops guilds with no channel
            // set. Asking it "is anyone still tracking this player" counts
            // those guilds as zero, and /r6-remove then deletes the
            // r6_players row — cascading guild_r6_players away from servers
            // that never asked.
            queryMock.mockResolvedValueOnce({ rows: [{ count: 2 }] });

            await expect(countGuildsTrackingR6Player('ubi-abc')).resolves.toBe(
                2
            );
            expect(sqlOf()).toContain('FROM guild_r6_players');
            expect(sqlOf()).not.toContain('guild_config');
            expect(sqlOf()).not.toContain('channel_id');
        });

        it('reports zero rather than undefined when nothing comes back', async () => {
            await expect(countGuildsTrackingR6Player('ubi-abc')).resolves.toBe(
                0
            );
        });

        it('is not interchangeable with the notification-target query', async () => {
            await getGuildsTrackingR6Player('ubi-abc');
            expect(sqlOf()).toContain('guild_config');
            expect(sqlOf()).toContain('channel_id IS NOT NULL');
        });
    });

    describe('getSquadsTrackingR6Player', () => {
        it('resolves squads through the guild attachment, not squad_summoners', async () => {
            // squad_summoners.puuid is a foreign key into `summoners`, and a
            // Ubisoft profile id is never a summoner — the same constraint that
            // made the original rank_tracking write impossible. So a Siege
            // player's squad is reached the other way round: the guilds that
            // track them, then each guild's attachment.
            queryMock.mockResolvedValueOnce({
                rows: [{ squad_id: 'squad-a' }, { squad_id: 'squad-b' }],
            });

            await expect(getSquadsTrackingR6Player('ubi-abc')).resolves.toEqual(
                ['squad-a', 'squad-b']
            );
            expect(sqlOf()).toContain('FROM guild_r6_players');
            expect(sqlOf()).toContain('JOIN squad_attachments');
            expect(sqlOf()).toContain("sa.kind = 'discord_guild'");
            expect(sqlOf()).not.toContain('squad_summoners');
            expect(queryMock.mock.calls[0]?.[1]).toEqual(['ubi-abc']);
        });

        it('does not drop guilds that have no notification channel', async () => {
            // An event is a fact about the group. A squad whose Discord side is
            // muted should still get the card in its Meeps space, so this must
            // not inherit getGuildsTrackingR6Player's guild_config inner join.
            await getSquadsTrackingR6Player('ubi-abc');
            expect(sqlOf()).not.toContain('guild_config');
            expect(sqlOf()).not.toContain('channel_id');
        });

        it('returns an empty list for a player no squad reaches', async () => {
            await expect(getSquadsTrackingR6Player('ubi-abc')).resolves.toEqual(
                []
            );
        });

        it('also reaches squads through the Meeps roster (025)', async () => {
            // The branch that makes a Meeps-only squad possible at all. Without
            // it the walk starts at guild_r6_players, so a space with no Discord
            // guild behind it can never be reached however the link was made.
            await getSquadsTrackingR6Player('ubi-abc');

            expect(sqlOf()).toContain('FROM squad_r6_players');
            expect(sqlOf()).toContain('UNION');
            // UNION, not UNION ALL: a squad owning both a guild that tracks this
            // player and a Meeps enrolment for them would otherwise be emitted
            // to twice for one poll.
            expect(sqlOf()).not.toContain('UNION ALL');
        });
    });

    /**
     * The two rosters, and the ways they can be got wrong.
     *
     * Both are real and independent (migration 025): a guild tracks whoever
     * `/r6-add` named, a squad tracks whoever linked in Meeps, and the same
     * player can be in both. Every read that treats one as the whole picture is
     * a bug, and these are the reads that used to.
     */
    describe('the two rosters', () => {
        describe('getAllTrackedR6Players', () => {
            it('polls players from either roster', async () => {
                await getAllTrackedR6Players();

                expect(sqlOf()).toContain('guild_r6_players');
                expect(sqlOf()).toContain('squad_r6_players');
            });

            it('returns a player in both rosters once', async () => {
                // This is the poller's work list. A player listed twice is two
                // r6data calls a tick to learn one thing, against a plan that
                // allows about 495 a month each. `EXISTS` answers the question
                // directly; the join it replaced multiplied a player by the
                // number of guilds tracking them and leant on DISTINCT.
                await getAllTrackedR6Players();

                expect(sqlOf()).toContain('EXISTS');
                expect(sqlOf()).not.toContain('JOIN');
                expect(sqlOf()).not.toContain('DISTINCT');
            });
        });

        describe('countTrackersOfR6Player', () => {
            it('counts both rosters', async () => {
                // `/r6-remove` deletes the r6_players row once this hits zero,
                // and that row is the parent of both rosters. Counting guilds
                // alone would cascade away every Meeps enrolment the moment the
                // last Discord server stopped tracking somebody.
                queryMock.mockResolvedValueOnce({ rows: [{ count: 3 }] });

                await expect(countTrackersOfR6Player('ubi-abc')).resolves.toBe(
                    3
                );
                expect(sqlOf()).toContain('guild_r6_players');
                expect(sqlOf()).toContain('squad_r6_players');
            });

            it('reports zero rather than undefined when nothing comes back', async () => {
                await expect(countTrackersOfR6Player('ubi-abc')).resolves.toBe(
                    0
                );
            });

            it('is a different question from countGuildsTrackingR6Player', async () => {
                await countGuildsTrackingR6Player('ubi-abc');
                expect(sqlOf()).not.toContain('squad_r6_players');
            });
        });

        describe('addR6PlayerToSquad', () => {
            it('is idempotent, because linking twice is not an error', async () => {
                await addR6PlayerToSquad('squad-1', 'ubi-abc', 'meeps-1');

                expect(sqlOf()).toContain('INSERT INTO squad_r6_players');
                expect(sqlOf()).toContain(
                    'ON CONFLICT (squad_id, "ubisoftId") DO NOTHING'
                );
                expect(queryMock.mock.calls[0]?.[1]).toEqual([
                    'squad-1',
                    'ubi-abc',
                    'meeps-1',
                ]);
            });
        });

        describe('removeR6PlayerFromAllSquads', () => {
            it('takes no squad id, so a space left since linking is not missed', async () => {
                // Unlinking is withdrawing the account, not leaving one group.
                queryMock.mockResolvedValueOnce({ rows: [], rowCount: 2 });

                await expect(
                    removeR6PlayerFromAllSquads('ubi-abc')
                ).resolves.toBe(2);
                expect(sqlOf()).toContain('DELETE FROM squad_r6_players');
                expect(queryMock.mock.calls[0]?.[1]).toEqual(['ubi-abc']);
            });
        });
    });

    describe('ensureR6Player', () => {
        it('does not clobber the rank baseline when the row already exists', async () => {
            // The one thing this must never do. tier/division/rp are what the
            // next poll diffs against; writing a reading taken now would tell it
            // nothing had moved since, swallowing whatever the player did in
            // between. The display name is worth refreshing — Ubisoft names
            // change — and nothing else is.
            queryMock.mockResolvedValueOnce({
                rows: [{ ubisoftId: 'ubi-abc', gameName: 'Aidan.TTV' }],
            });

            await ensureR6Player({
                ubisoftId: 'ubi-abc',
                gameName: 'Aidan.TTV',
                platform: 'uplay',
                tier: 'Platinum',
                division: 4,
                rp: 3200,
            });

            expect(sqlOf()).toContain('ON CONFLICT ("ubisoftId") DO UPDATE');
            expect(sqlOf()).toContain('SET "gameName" = EXCLUDED."gameName"');
            expect(sqlOf()).not.toContain('tier = EXCLUDED');
            expect(sqlOf()).not.toContain('rp = EXCLUDED');
            expect(sqlOf()).not.toContain('kills_snapshot = EXCLUDED');
            // DO UPDATE rather than DO NOTHING: the latter returns no row, and
            // the caller needs one back.
            expect(sqlOf()).toContain('RETURNING *');
        });
    });

    describe('markR6PlayerPolled', () => {
        it('records the poll without touching the vestigial active window', async () => {
            await markR6PlayerPolled('ubi-abc');

            expect(sqlOf()).toContain('SET last_polled_at = NOW()');
            expect(sqlOf()).not.toContain('active_until');
            expect(queryMock.mock.calls[0]?.[1]).toEqual(['ubi-abc']);
        });
    });

    describe('getR6PlayerIdByName', () => {
        it('scopes to the guild when one is given', async () => {
            // Ubisoft names are unique per platform and the autocomplete
            // offers names alone, so an unscoped LIMIT 1 can resolve to a row
            // belonging to another server.
            await getR6PlayerIdByName('Fishy.EU', 'guild-1');

            expect(sqlOf()).toContain('JOIN guild_r6_players');
            expect(queryMock.mock.calls[0]?.[1]).toEqual([
                'Fishy.EU',
                'guild-1',
            ]);
        });

        it('falls back to a global lookup without one', async () => {
            await getR6PlayerIdByName('Fishy.EU');

            expect(sqlOf()).not.toContain('JOIN guild_r6_players');
            expect(queryMock.mock.calls[0]?.[1]).toEqual(['Fishy.EU']);
        });
    });

    describe('diffSnapshot', () => {
        it('reports null, not zero, before a baseline exists', () => {
            // "First sighting" and "played and gained nothing" render
            // differently in the session embed.
            expect(
                diffSnapshot(
                    {
                        killsSnapshot: null,
                        deathsSnapshot: null,
                        winsSnapshot: null,
                        lossesSnapshot: null,
                        abandonsSnapshot: null,
                    },
                    { kills: 10, deaths: 8, wins: 2, losses: 1, abandons: 0 }
                )
            ).toEqual({
                killsGained: null,
                deathsGained: null,
                winsGained: null,
                lossesGained: null,
                abandonsGained: null,
            });
        });

        it('subtracts the stored snapshot once there is one', () => {
            expect(
                diffSnapshot(
                    {
                        killsSnapshot: 100,
                        deathsSnapshot: 90,
                        winsSnapshot: 20,
                        lossesSnapshot: 15,
                        abandonsSnapshot: 1,
                    },
                    {
                        kills: 112,
                        deaths: 94,
                        wins: 22,
                        losses: 16,
                        abandons: 1,
                    }
                )
            ).toEqual({
                killsGained: 12,
                deathsGained: 4,
                winsGained: 2,
                lossesGained: 1,
                abandonsGained: 0,
            });
        });

        it('nulls each counter independently, which migration 023 relies on', () => {
            // A player tracked before 023 has kills/wins/losses baselines and no
            // deaths or abandons one. Nulling the whole diff whenever any counter
            // is missing would suppress a real match card for that poll; nulling
            // them one at a time reports the W/L it does know, and no K/D.
            expect(
                diffSnapshot(
                    {
                        killsSnapshot: 100,
                        deathsSnapshot: null,
                        winsSnapshot: 20,
                        lossesSnapshot: 15,
                        abandonsSnapshot: null,
                    },
                    {
                        kills: 108,
                        deaths: 94,
                        wins: 21,
                        losses: 15,
                        abandons: 0,
                    }
                )
            ).toEqual({
                killsGained: 8,
                deathsGained: null,
                winsGained: 1,
                lossesGained: 0,
                abandonsGained: null,
            });
        });
    });
});

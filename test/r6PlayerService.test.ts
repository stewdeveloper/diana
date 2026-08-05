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
    getGuildsTrackingR6Player,
    getR6PlayerIdByName,
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
                        winsSnapshot: null,
                        lossesSnapshot: null,
                    },
                    { kills: 10, wins: 2, losses: 1 }
                )
            ).toEqual({
                killsGained: null,
                winsGained: null,
                lossesGained: null,
            });
        });

        it('subtracts the stored snapshot once there is one', () => {
            expect(
                diffSnapshot(
                    {
                        killsSnapshot: 100,
                        winsSnapshot: 20,
                        lossesSnapshot: 15,
                    },
                    { kills: 112, wins: 22, losses: 16 }
                )
            ).toEqual({ killsGained: 12, winsGained: 2, lossesGained: 1 });
        });
    });
});

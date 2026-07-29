jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({
        db: {
            query: jest.fn(),
        },
    })
);

import { db } from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db';
import * as guildService from '../packages/diana-core/src/plugins/diana-league-bot/api/summoners/guildService';

const queryMock = db.query as unknown as jest.Mock;

describe('guildService', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    // ─── getGuildConfig ───────────────────────────────────────────────────────

    describe('getGuildConfig', () => {
        it('returns config row when found', async () => {
            const row = {
                guild_id: 'g1',
                channel_id: 'c1',
                live_posting: true,
            };
            queryMock.mockResolvedValue({ rows: [row] });

            const result = await guildService.getGuildConfig('g1');

            expect(result).toBe(row);
            expect(queryMock).toHaveBeenCalledWith(
                expect.stringContaining('FROM guild_config'),
                ['g1']
            );
        });

        it('returns null when not found', async () => {
            queryMock.mockResolvedValue({ rows: [] });

            const result = await guildService.getGuildConfig('missing');

            expect(result).toBeNull();
        });
    });

    // ─── getOrCreateGuildConfig ───────────────────────────────────────────────

    describe('getOrCreateGuildConfig', () => {
        it('upserts and returns the config row', async () => {
            const row = {
                guild_id: 'g1',
                channel_id: null,
                live_posting: true,
            };
            queryMock.mockResolvedValue({ rows: [row] });

            const result = await guildService.getOrCreateGuildConfig('g1');

            expect(result).toBe(row);
            expect(queryMock).toHaveBeenCalledWith(
                expect.stringContaining('ON CONFLICT'),
                ['g1']
            );
        });
    });

    // ─── setGuildChannel ──────────────────────────────────────────────────────

    describe('setGuildChannel', () => {
        it('upserts channel_id and returns updated row', async () => {
            const row = {
                guild_id: 'g1',
                channel_id: 'c99',
                live_posting: true,
            };
            queryMock.mockResolvedValue({ rows: [row] });

            const result = await guildService.setGuildChannel('g1', 'c99');

            expect(result).toBe(row);
            expect(queryMock).toHaveBeenCalledWith(
                expect.stringContaining('channel_id'),
                ['g1', 'c99']
            );
        });
    });

    // ─── setGuildLivePosting ──────────────────────────────────────────────────

    describe('setGuildLivePosting', () => {
        it('sets live_posting to false', async () => {
            const row = {
                guild_id: 'g1',
                channel_id: 'c1',
                live_posting: false,
            };
            queryMock.mockResolvedValue({ rows: [row] });

            const result = await guildService.setGuildLivePosting('g1', false);

            expect(result).toBe(row);
            expect(queryMock).toHaveBeenCalledWith(
                expect.stringContaining('live_posting'),
                ['g1', false]
            );
        });

        it('sets live_posting to true', async () => {
            const row = {
                guild_id: 'g1',
                channel_id: 'c1',
                live_posting: true,
            };
            queryMock.mockResolvedValue({ rows: [row] });

            const result = await guildService.setGuildLivePosting('g1', true);

            expect(result).toBe(row);
            expect(queryMock).toHaveBeenCalledWith(expect.anything(), [
                'g1',
                true,
            ]);
        });
    });

    // ─── setGuildNotificationPref ─────────────────────────────────────────────

    describe('setGuildNotificationPref', () => {
        it('upserts a single pref key via jsonb merge', async () => {
            const row = {
                guild_id: 'g1',
                channel_id: 'c1',
                live_posting: true,
                notification_prefs: { digest: false },
            };
            queryMock.mockResolvedValue({ rows: [row] });

            const result = await guildService.setGuildNotificationPref(
                'g1',
                'digest',
                false
            );

            expect(result).toBe(row);
            const [query, params] = queryMock.mock.calls[0];
            expect(query).toContain('notification_prefs');
            expect(query).toContain('jsonb_build_object');
            expect(params).toEqual(['g1', 'digest', false]);
        });
    });

    // ─── getNotificationPref ──────────────────────────────────────────────────

    describe('getNotificationPref', () => {
        it('returns the explicit pref when set', () => {
            const config = {
                live_posting: true,
                notification_prefs: { digest: false },
            };
            expect(guildService.getNotificationPref(config, 'digest')).toBe(
                false
            );
        });

        it('bridges match_posts and rank_posts to live_posting', () => {
            const optedOut = { live_posting: false, notification_prefs: {} };
            expect(
                guildService.getNotificationPref(optedOut, 'match_posts')
            ).toBe(false);
            expect(
                guildService.getNotificationPref(optedOut, 'rank_posts')
            ).toBe(false);

            const optedIn = { live_posting: true, notification_prefs: null };
            expect(
                guildService.getNotificationPref(optedIn, 'match_posts')
            ).toBe(true);
        });

        it('explicit pref beats the live_posting bridge', () => {
            const config = {
                live_posting: false,
                notification_prefs: { match_posts: true },
            };
            expect(
                guildService.getNotificationPref(config, 'match_posts')
            ).toBe(true);
        });

        it('falls back to defaults for other keys', () => {
            const config = { live_posting: true, notification_prefs: {} };
            expect(guildService.getNotificationPref(config, 'streaks')).toBe(
                true
            );
            expect(guildService.getNotificationPref(config, 'digest')).toBe(
                true
            );
            expect(guildService.getNotificationPref(config, 'rotation')).toBe(
                false
            );
        });

        it('uses defaults when config is null', () => {
            expect(guildService.getNotificationPref(null, 'digest')).toBe(true);
            expect(guildService.getNotificationPref(null, 'rotation')).toBe(
                false
            );
            expect(guildService.getNotificationPref(null, 'match_posts')).toBe(
                true
            );
        });
    });

    // ─── addSummonerToGuild ───────────────────────────────────────────────────

    describe('addSummonerToGuild', () => {
        it('resolves the guild to its squad, then inserts with addedBy', async () => {
            // 1. resolve the discord_guild attachment, 2. insert the roster row
            queryMock
                .mockResolvedValueOnce({ rows: [{ squad_id: 'sq1' }] })
                .mockResolvedValueOnce({ rows: [] });

            await guildService.addSummonerToGuild(
                'g1',
                'puuid-abc',
                'user-123'
            );

            expect(queryMock).toHaveBeenNthCalledWith(
                1,
                expect.stringContaining('FROM squad_attachments'),
                ['discord_guild', 'g1']
            );
            expect(queryMock).toHaveBeenNthCalledWith(
                2,
                expect.stringContaining('INSERT INTO squad_summoners'),
                ['sq1', 'puuid-abc', 'user-123']
            );
        });

        it('creates the squad on first use, so a new guild needs no setup step', async () => {
            queryMock
                // no attachment yet
                .mockResolvedValueOnce({ rows: [] })
                // INSERT INTO squads
                .mockResolvedValueOnce({ rows: [{ squad_id: 'sq-new' }] })
                // INSERT INTO squad_attachments
                .mockResolvedValueOnce({ rows: [{ squad_id: 'sq-new' }] })
                // INSERT INTO squad_summoners
                .mockResolvedValueOnce({ rows: [] });

            await guildService.addSummonerToGuild('g-fresh', 'puuid-abc');

            expect(queryMock).toHaveBeenNthCalledWith(
                3,
                expect.stringContaining('INSERT INTO squad_attachments'),
                ['discord_guild', 'g-fresh', 'sq-new']
            );
            expect(queryMock).toHaveBeenNthCalledWith(
                4,
                expect.stringContaining('INSERT INTO squad_summoners'),
                ['sq-new', 'puuid-abc', null]
            );
        });

        it('inserts with null addedBy when not provided', async () => {
            queryMock
                .mockResolvedValueOnce({ rows: [{ squad_id: 'sq1' }] })
                .mockResolvedValueOnce({ rows: [] });

            await guildService.addSummonerToGuild('g1', 'puuid-abc');

            expect(queryMock).toHaveBeenCalledWith(expect.anything(), [
                'sq1',
                'puuid-abc',
                null,
            ]);
        });
    });

    // ─── removeSummonerFromGuild ──────────────────────────────────────────────

    describe('removeSummonerFromGuild', () => {
        it('returns true when a row was deleted', async () => {
            queryMock
                .mockResolvedValueOnce({ rows: [{ squad_id: 'sq1' }] })
                .mockResolvedValueOnce({
                    rows: [{ puuid: 'p1' }],
                    rowCount: 1,
                });

            const result = await guildService.removeSummonerFromGuild(
                'g1',
                'p1'
            );

            expect(result).toBe(true);
            expect(queryMock).toHaveBeenCalledWith(
                expect.stringContaining('DELETE FROM squad_summoners'),
                ['sq1', 'p1']
            );
        });

        it('returns false without querying the roster when the guild has no squad', async () => {
            queryMock.mockResolvedValueOnce({ rows: [] });

            const result = await guildService.removeSummonerFromGuild(
                'g-unknown',
                'p1'
            );

            expect(result).toBe(false);
            expect(queryMock).toHaveBeenCalledTimes(1);
        });

        it('returns false when no row was deleted', async () => {
            queryMock.mockResolvedValue({ rows: [], rowCount: 0 });

            const result = await guildService.removeSummonerFromGuild(
                'g1',
                'missing'
            );

            expect(result).toBe(false);
        });
    });

    // ─── getSummonersForGuild ─────────────────────────────────────────────────

    describe('getSummonersForGuild', () => {
        it('returns joined rows for the given guild', async () => {
            // The roster is stored against the squad; callers still think in
            // guilds, so guild_id is substituted back on the way out.
            const squadRows = [
                {
                    squad_id: 'sq1',
                    puuid: 'p1',
                    gameName: 'Alice',
                    tagLine: 'EUW',
                },
                {
                    squad_id: 'sq1',
                    puuid: 'p2',
                    gameName: 'Bob',
                    tagLine: 'NA1',
                },
            ];
            queryMock
                .mockResolvedValueOnce({ rows: [{ squad_id: 'sq1' }] })
                .mockResolvedValueOnce({ rows: squadRows });

            const result = await guildService.getSummonersForGuild('g1');

            expect(result).toEqual([
                {
                    guild_id: 'g1',
                    puuid: 'p1',
                    gameName: 'Alice',
                    tagLine: 'EUW',
                },
                {
                    guild_id: 'g1',
                    puuid: 'p2',
                    gameName: 'Bob',
                    tagLine: 'NA1',
                },
            ]);
            expect(result.every((row) => !('squad_id' in row))).toBe(true);
            expect(queryMock).toHaveBeenCalledWith(
                expect.stringContaining('JOIN summoners'),
                ['sq1']
            );
        });

        it('returns empty array when guild has no summoners', async () => {
            queryMock.mockResolvedValue({ rows: [] });

            const result =
                await guildService.getSummonersForGuild('empty-guild');

            expect(result).toEqual([]);
        });
    });

    // ─── isSummonerInGuild ────────────────────────────────────────────────────

    describe('isSummonerInGuild', () => {
        it('returns true when summoner is tracked in the guild', async () => {
            queryMock
                .mockResolvedValueOnce({ rows: [{ squad_id: 'sq1' }] })
                .mockResolvedValueOnce({
                    rows: [{ '?column?': 1 }],
                    rowCount: 1,
                });

            const result = await guildService.isSummonerInGuild('g1', 'p1');

            expect(result).toBe(true);
        });

        it('returns false when summoner is not tracked in the guild', async () => {
            queryMock
                .mockResolvedValueOnce({ rows: [{ squad_id: 'sq1' }] })
                .mockResolvedValueOnce({ rows: [], rowCount: 0 });

            const result = await guildService.isSummonerInGuild(
                'g1',
                'p-unknown'
            );

            expect(result).toBe(false);
        });
    });

    // ─── getGuildsTrackingSummoner ────────────────────────────────────────────

    describe('getGuildsTrackingSummoner', () => {
        it('returns guild targets with channel and live_posting', async () => {
            const rows = [
                { guild_id: 'g1', channel_id: 'c1', live_posting: true },
                { guild_id: 'g2', channel_id: 'c2', live_posting: false },
            ];
            queryMock.mockResolvedValue({ rows });

            const result = await guildService.getGuildsTrackingSummoner('p1');

            expect(result).toEqual(rows);
            // Reaches guild_config through the squad, so a guild attached to a
            // squad it did not create still receives that squad's match posts.
            expect(queryMock).toHaveBeenCalledWith(
                expect.stringContaining('WHERE ss.puuid = $1'),
                ['p1']
            );
        });

        it('only returns guilds with a non-null channel_id', async () => {
            queryMock.mockResolvedValue({ rows: [] });

            await guildService.getGuildsTrackingSummoner('p-no-channel');

            expect(queryMock).toHaveBeenCalledWith(
                expect.stringContaining('channel_id IS NOT NULL'),
                ['p-no-channel']
            );
        });

        it('returns empty array when no guilds track the summoner', async () => {
            queryMock.mockResolvedValue({ rows: [] });

            const result =
                await guildService.getGuildsTrackingSummoner('p-new');

            expect(result).toEqual([]);
        });
    });

    // ─── getAllTrackedPuuids ───────────────────────────────────────────────────

    describe('getAllTrackedPuuids', () => {
        it('returns distinct puuids from every squad roster', async () => {
            queryMock.mockResolvedValue({
                rows: [{ puuid: 'p1' }, { puuid: 'p2' }, { puuid: 'p3' }],
            });

            const result = await guildService.getAllTrackedPuuids();

            expect(result).toEqual(['p1', 'p2', 'p3']);
            // Squad-wide, so a summoner tracked only through a Meeps space is
            // still polled.
            expect(queryMock).toHaveBeenCalledWith(
                expect.stringContaining('ss.puuid'),
                []
            );
        });

        it('returns empty array when no summoners are tracked', async () => {
            queryMock.mockResolvedValue({ rows: [] });

            const result = await guildService.getAllTrackedPuuids();

            expect(result).toEqual([]);
        });
    });
});

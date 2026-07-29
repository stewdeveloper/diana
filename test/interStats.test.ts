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
    ONE_WEEK_IN_MS,
    parseParticipants,
    getInterCandidatesSince,
    getInterCandidatesLastWeek,
    RiotParticipant,
    RawMatchRow,
} from '../packages/diana-core/src/plugins/diana-league-bot/utils/interStats';

const queryMock = db.query as unknown as jest.Mock;

describe('interStats', () => {
    beforeEach(() => {
        queryMock.mockReset();
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('ONE_WEEK_IN_MS', () => {
        it('equals 7 * 24 * 60 * 60 * 1000', () => {
            expect(ONE_WEEK_IN_MS).toBe(7 * 24 * 60 * 60 * 1000);
        });

        it('equals 604800000', () => {
            expect(ONE_WEEK_IN_MS).toBe(604800000);
        });
    });

    describe('parseParticipants', () => {
        it('returns empty array when participants is null/undefined', () => {
            expect(parseParticipants(null as any)).toEqual([]);
            expect(parseParticipants(undefined as any)).toEqual([]);
        });

        it('returns array as-is when already an array', () => {
            const participants: RiotParticipant[] = [
                { puuid: 'abc', championName: 'Jinx', kills: 5 },
                { puuid: 'def', championName: 'Lux', kills: 2 },
            ];
            const result = parseParticipants(participants);
            expect(result).toBe(participants);
            expect(result).toHaveLength(2);
        });

        it('parses a valid JSON string of participants', () => {
            const participants: RiotParticipant[] = [
                { puuid: 'abc', kills: 3, deaths: 1, assists: 5 },
            ];
            const result = parseParticipants(JSON.stringify(participants));
            expect(result).toEqual(participants);
        });

        it('returns empty array when JSON string parses to non-array', () => {
            const result = parseParticipants('{"key": "value"}');
            expect(result).toEqual([]);
        });

        it('returns empty array for malformed JSON string', () => {
            const result = parseParticipants('not valid json{{');
            expect(result).toEqual([]);
        });

        it('returns empty array for empty string', () => {
            const result = parseParticipants('');
            expect(result).toEqual([]);
        });

        it('returns empty array for JSON null string', () => {
            const result = parseParticipants('null');
            expect(result).toEqual([]);
        });
    });

    describe('getInterCandidatesSince', () => {
        const makeRow = (
            overrides: Partial<RawMatchRow> = {}
        ): RawMatchRow => ({
            puuid: 'player-1',
            gameName: 'TestPlayer',
            tagLine: 'NA1',
            deepLolLink: 'https://deeplol.gg/player/NA1/TestPlayer-NA1',
            matchId: 'NA1_123',
            participants: JSON.stringify([
                {
                    puuid: 'player-1',
                    championName: 'Jinx',
                    totalDamageDealtToChampions: 20000,
                    kills: 5,
                    deaths: 2,
                    assists: 8,
                    win: true,
                    visionScore: 15,
                    profileIcon: 100,
                },
            ]),
            gameCreation: Date.now() - 1000,
            ...overrides,
        });

        it('returns empty array when db returns no rows', async () => {
            queryMock.mockResolvedValue({ rows: [] });

            const result = await getInterCandidatesSince(
                Date.now() - ONE_WEEK_IN_MS
            );

            expect(result).toEqual([]);
            expect(queryMock).toHaveBeenCalled();
        });

        it('correctly calculates avgDamage for a single match', async () => {
            queryMock.mockResolvedValue({ rows: [makeRow()] });

            const result = await getInterCandidatesSince(0);

            expect(result).toHaveLength(1);
            expect(result[0].avgDamage).toBe(20000);
            expect(result[0].matchesPlayed).toBe(1);
        });

        it('correctly calculates kdaRatio', async () => {
            queryMock.mockResolvedValue({ rows: [makeRow()] });

            const result = await getInterCandidatesSince(0);

            // kills=5, deaths=2, assists=8 → (5+8)/2 = 6.5
            expect(result[0].kdaRatio).toBeCloseTo(6.5);
        });

        it('kdaRatio is killContrib when deaths is 0', async () => {
            const row = makeRow({
                participants: JSON.stringify([
                    {
                        puuid: 'player-1',
                        kills: 10,
                        deaths: 0,
                        assists: 5,
                        win: true,
                        totalDamageDealtToChampions: 0,
                        visionScore: 0,
                    },
                ]),
            });
            queryMock.mockResolvedValue({ rows: [row] });

            const result = await getInterCandidatesSince(0);

            // deaths=0, so kdaRatio = kills+assists = 15
            expect(result[0].kdaRatio).toBe(15);
        });

        it('correctly calculates winRate', async () => {
            const row1 = makeRow({ matchId: 'match-1' });
            const row2 = makeRow({
                matchId: 'match-2',
                participants: JSON.stringify([
                    {
                        puuid: 'player-1',
                        win: false,
                        totalDamageDealtToChampions: 10000,
                        kills: 1,
                        deaths: 5,
                        assists: 2,
                        visionScore: 5,
                    },
                ]),
            });
            queryMock.mockResolvedValue({ rows: [row1, row2] });

            const result = await getInterCandidatesSince(0);

            expect(result[0].matchesPlayed).toBe(2);
            expect(result[0].wins).toBe(1);
            expect(result[0].losses).toBe(1);
            expect(result[0].winRate).toBeCloseTo(0.5);
        });

        it('aggregates stats across multiple matches for the same player', async () => {
            const row1 = makeRow({
                matchId: 'match-1',
                participants: JSON.stringify([
                    {
                        puuid: 'player-1',
                        totalDamageDealtToChampions: 10000,
                        kills: 4,
                        deaths: 2,
                        assists: 6,
                        win: true,
                        visionScore: 10,
                        profileIcon: 42,
                    },
                ]),
            });
            const row2 = makeRow({
                matchId: 'match-2',
                participants: JSON.stringify([
                    {
                        puuid: 'player-1',
                        totalDamageDealtToChampions: 30000,
                        kills: 2,
                        deaths: 4,
                        assists: 1,
                        win: false,
                        visionScore: 20,
                        profileIcon: 99,
                    },
                ]),
            });
            queryMock.mockResolvedValue({ rows: [row1, row2] });

            const result = await getInterCandidatesSince(0);

            expect(result).toHaveLength(1);
            const candidate = result[0];
            expect(candidate.matchesPlayed).toBe(2);
            expect(candidate.totalDamage).toBe(40000);
            expect(candidate.avgDamage).toBe(20000);
            expect(candidate.totalKills).toBe(6);
            expect(candidate.totalDeaths).toBe(6);
            expect(candidate.totalAssists).toBe(7);
            expect(candidate.wins).toBe(1);
            expect(candidate.losses).toBe(1);
            // kdaRatio: (6+7)/6 = 2.1667
            expect(candidate.kdaRatio).toBeCloseTo(13 / 6);
            expect(candidate.totalVisionScore).toBe(30);
        });

        it('deduplicates rows with the same matchId', async () => {
            const row = makeRow({ matchId: 'dupe-match' });
            // Same matchId appears twice in the result set
            queryMock.mockResolvedValue({ rows: [row, row] });

            const result = await getInterCandidatesSince(0);

            expect(result[0].matchesPlayed).toBe(1);
        });

        it('skips rows where participant puuid is not in participants list', async () => {
            const row = makeRow({
                participants: JSON.stringify([
                    {
                        puuid: 'other-player',
                        kills: 5,
                        deaths: 1,
                        assists: 0,
                        win: true,
                    },
                ]),
            });
            queryMock.mockResolvedValue({ rows: [row] });

            const result = await getInterCandidatesSince(0);

            // Player not found in participants → matchesPlayed remains 0 → filtered out
            expect(result).toHaveLength(0);
        });

        it('handles multiple players in the same result set', async () => {
            const row1: RawMatchRow = {
                puuid: 'player-1',
                gameName: 'Alice',
                tagLine: 'NA1',
                matchId: 'match-1',
                participants: JSON.stringify([
                    {
                        puuid: 'player-1',
                        totalDamageDealtToChampions: 15000,
                        kills: 3,
                        deaths: 1,
                        assists: 5,
                        win: true,
                        visionScore: 8,
                    },
                ]),
                gameCreation: Date.now(),
            };
            const row2: RawMatchRow = {
                puuid: 'player-2',
                gameName: 'Bob',
                tagLine: 'EUW',
                matchId: 'match-1',
                participants: JSON.stringify([
                    {
                        puuid: 'player-2',
                        totalDamageDealtToChampions: 5000,
                        kills: 0,
                        deaths: 7,
                        assists: 2,
                        win: false,
                        visionScore: 3,
                    },
                ]),
                gameCreation: Date.now(),
            };
            queryMock.mockResolvedValue({ rows: [row1, row2] });

            const result = await getInterCandidatesSince(0);

            expect(result).toHaveLength(2);
            const alice = result.find((c) => c.puuid === 'player-1');
            const bob = result.find((c) => c.puuid === 'player-2');
            expect(alice?.displayName).toBe('Alice#NA1');
            expect(bob?.displayName).toBe('Bob#EUW');
            expect(alice?.winRate).toBe(1);
            expect(bob?.winRate).toBe(0);
        });

        it('filters by targetPuuid when provided', async () => {
            queryMock.mockResolvedValue({ rows: [] });

            await getInterCandidatesSince(1000, {
                targetPuuid: 'specific-puuid',
            });

            const [query, params] = queryMock.mock.calls[0];
            expect(query).toContain('$2');
            expect(params).toContain('specific-puuid');
        });

        it('joins squad_summoners when squadId is provided', async () => {
            queryMock.mockResolvedValue({ rows: [] });

            await getInterCandidatesSince(1000, { squadId: 'squad-1' });

            const [query, params] = queryMock.mock.calls[0];
            expect(query).toContain('squad_summoners');
            expect(query).toContain('ss.squad_id = $2');
            expect(params).toContain('squad-1');
        });

        it('does not join squad_summoners without a squadId', async () => {
            queryMock.mockResolvedValue({ rows: [] });

            await getInterCandidatesSince(1000);

            const [query] = queryMock.mock.calls[0];
            expect(query).not.toContain('squad_summoners');
        });

        it('numbers parameters correctly with squadId and targetPuuid', async () => {
            queryMock.mockResolvedValue({ rows: [] });

            await getInterCandidatesSince(1000, {
                squadId: 'squad-1',
                targetPuuid: 'puuid-9',
            });

            const [query, params] = queryMock.mock.calls[0];
            expect(query).toContain('s."puuid" = $3');
            expect(params).toEqual([1000, 'squad-1', 'puuid-9']);
        });

        // DN-2 acceptance: the same aggregation, asked for two different
        // squads, must be scoped to each. The squads here stand for one backed
        // by a Discord guild and one backed by a Meeps space - interStats does
        // not know or care which, and that is the portability property.
        it('scopes to each squad independently, with no bleed between them', async () => {
            const discordSquadRows: RawMatchRow[] = [
                {
                    puuid: 'p-discord',
                    gameName: 'Alice',
                    tagLine: 'EUW',
                    deepLolLink: null,
                    matchId: 'EUW1_1',
                    participants: [
                        {
                            puuid: 'p-discord',
                            win: true,
                            kills: 5,
                            deaths: 1,
                            assists: 3,
                        },
                    ],
                    gameCreation: 2000,
                    gameDuration: 1800,
                    queueId: 420,
                    gameMode: 'CLASSIC',
                    aiScore: 70,
                } as RawMatchRow,
            ];
            const meepsSquadRows: RawMatchRow[] = [
                {
                    puuid: 'p-meeps',
                    gameName: 'Bob',
                    tagLine: 'NA1',
                    deepLolLink: null,
                    matchId: 'NA1_1',
                    participants: [
                        {
                            puuid: 'p-meeps',
                            win: false,
                            kills: 1,
                            deaths: 7,
                            assists: 0,
                        },
                    ],
                    gameCreation: 2000,
                    gameDuration: 1800,
                    queueId: 420,
                    gameMode: 'CLASSIC',
                    aiScore: 20,
                } as RawMatchRow,
            ];

            queryMock
                .mockResolvedValueOnce({ rows: discordSquadRows })
                .mockResolvedValueOnce({ rows: meepsSquadRows });

            const fromDiscordGuild = await getInterCandidatesSince(1000, {
                squadId: 'squad-discord',
            });
            const fromMeepsSpace = await getInterCandidatesSince(1000, {
                squadId: 'squad-meeps',
            });

            expect(queryMock.mock.calls[0][1]).toContain('squad-discord');
            expect(queryMock.mock.calls[1][1]).toContain('squad-meeps');

            expect(fromDiscordGuild.map((c) => c.puuid)).toEqual(['p-discord']);
            expect(fromMeepsSpace.map((c) => c.puuid)).toEqual(['p-meeps']);
            expect(fromDiscordGuild.map((c) => c.puuid)).not.toContain(
                'p-meeps'
            );
            expect(fromMeepsSpace.map((c) => c.puuid)).not.toContain(
                'p-discord'
            );
        });

        it('uses displayName without tagLine when tagLine is empty', async () => {
            const row: RawMatchRow = {
                puuid: 'player-1',
                gameName: 'Solo',
                tagLine: '',
                matchId: 'match-1',
                participants: JSON.stringify([
                    {
                        puuid: 'player-1',
                        totalDamageDealtToChampions: 1000,
                        kills: 1,
                        deaths: 1,
                        assists: 1,
                        win: true,
                        visionScore: 5,
                    },
                ]),
                gameCreation: Date.now(),
            };
            queryMock.mockResolvedValue({ rows: [row] });

            const result = await getInterCandidatesSince(0);

            expect(result[0].displayName).toBe('Solo');
        });

        it('uses defaults when optional participant fields are missing', async () => {
            const row = makeRow({
                participants: JSON.stringify([
                    { puuid: 'player-1' }, // all stats missing
                ]),
            });
            queryMock.mockResolvedValue({ rows: [row] });

            const result = await getInterCandidatesSince(0);

            expect(result[0].matchesPlayed).toBe(1);
            expect(result[0].totalDamage).toBe(0);
            expect(result[0].totalKills).toBe(0);
            expect(result[0].totalDeaths).toBe(0);
            expect(result[0].totalAssists).toBe(0);
            expect(result[0].wins).toBe(0);
            expect(result[0].losses).toBe(1);
        });

        it('passes sinceTimestamp as first query parameter', async () => {
            queryMock.mockResolvedValue({ rows: [] });

            const timestamp = 1700000000000;
            await getInterCandidatesSince(timestamp);

            const [, params] = queryMock.mock.calls[0];
            expect(params[0]).toBe(timestamp);
        });
    });

    describe('getInterCandidatesLastWeek', () => {
        it('calls db.query with a timestamp approximately one week ago', async () => {
            queryMock.mockResolvedValue({ rows: [] });

            const before = Date.now();
            await getInterCandidatesLastWeek();
            const after = Date.now();

            const [, params] = queryMock.mock.calls[0];
            const usedTimestamp: number = params[0];

            const expectedMin = before - ONE_WEEK_IN_MS;
            const expectedMax = after - ONE_WEEK_IN_MS;

            expect(usedTimestamp).toBeGreaterThanOrEqual(expectedMin);
            expect(usedTimestamp).toBeLessThanOrEqual(expectedMax);
        });

        it('passes targetPuuid to the query when provided', async () => {
            queryMock.mockResolvedValue({ rows: [] });

            await getInterCandidatesLastWeek({ targetPuuid: 'my-puuid' });

            const [, params] = queryMock.mock.calls[0];
            expect(params).toContain('my-puuid');
        });

        it('returns InterCandidate array on success', async () => {
            const row = {
                puuid: 'player-1',
                gameName: 'Test',
                tagLine: 'TAG',
                deepLolLink: null,
                matchId: 'match-1',
                participants: JSON.stringify([
                    {
                        puuid: 'player-1',
                        totalDamageDealtToChampions: 5000,
                        kills: 2,
                        deaths: 3,
                        assists: 4,
                        win: false,
                        visionScore: 7,
                    },
                ]),
                gameCreation: Date.now(),
            };
            queryMock.mockResolvedValue({ rows: [row] });

            const result = await getInterCandidatesLastWeek();

            expect(result).toHaveLength(1);
            expect(result[0].puuid).toBe('player-1');
            expect(result[0].displayName).toBe('Test#TAG');
        });
    });
});

describe('getInterCandidatesSince competitive scoping', () => {
    beforeEach(() => {
        queryMock.mockReset();
        queryMock.mockResolvedValue({ rows: [] });
    });

    const lastQuery = () => queryMock.mock.calls[0][0] as string;

    it('always excludes Arena, even under the default scope', async () => {
        await getInterCandidatesSince(0);
        expect(lastQuery()).toContain("<> 'CHERRY'");
        expect(lastQuery()).toContain('NOT IN (1700,1701,1704,1710,1750)');
    });

    it("does not restrict to ranked queues under 'all'", async () => {
        await getInterCandidatesSince(0, { scope: 'all' });
        expect(lastQuery()).not.toContain('IN (420,440)');
    });

    it("restricts to Solo/Duo and Flex under 'ranked'", async () => {
        await getInterCandidatesSince(0, { scope: 'ranked' });
        expect(lastQuery()).toContain('md."queueId" IN (420,440)');
    });

    it('selects the columns the filter depends on', async () => {
        await getInterCandidatesSince(0);
        expect(lastQuery()).toContain('md."queueId"');
        expect(lastQuery()).toContain('md."gameMode"');
    });

    it('keeps bind-parameter numbering intact alongside other options', async () => {
        await getInterCandidatesSince(123, {
            squadId: 'sq1',
            targetPuuid: 'p1',
            scope: 'ranked',
        });
        const [, params] = queryMock.mock.calls[0];
        expect(params).toEqual([123, 'sq1', 'p1']);
    });
});

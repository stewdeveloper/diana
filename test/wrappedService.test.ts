export {};

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({ db: { query: jest.fn() } })
);

import { db } from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db';
import {
    computeSquadWrapped,
    fetchSquadMatches,
    pickWorstNight,
    pickWrappedGames,
} from '../packages/diana-core/src/core/wrapped/wrappedService';
import { resolveExplicitPeriod } from '../packages/diana-core/src/core/wrapped/wrappedPeriod';

const queryMock = db.query as unknown as jest.Mock;

const PERIOD = resolveExplicitPeriod(
    '2026-04-01T00:00:00Z',
    '2026-07-01T00:00:00Z',
    'Test period'
)!;

/**
 * Rows to return, keyed by which read is asking.
 *
 * Routed on the SQL rather than on call order, because `computeSquadWrapped`
 * issues four of its reads inside one `Promise.all` and then a variable number
 * of rank lookups. Ordering assertions over that would break every time a read
 * moved, without ever catching a real defect.
 */
interface Fixtures {
    roster?: unknown[];
    matches?: unknown[];
    scores?: unknown[];
    nights?: unknown[];
    voice?: unknown[];
    hidden?: unknown[];
    names?: unknown[];
    ranks?: unknown[];
}

function install(fixtures: Fixtures): void {
    queryMock.mockImplementation(async (sql: string) => {
        const flat = String(sql).replace(/\s+/g, ' ');
        const rows = (): unknown[] => {
            if (flat.includes('WITH squad_matches AS')) {
                return fixtures.matches ?? [];
            }
            if (flat.includes('FROM match_scores ms')) {
                return fixtures.scores ?? [];
            }
            if (flat.includes('FROM session_participants sp')) {
                return fixtures.voice ?? [];
            }
            if (flat.includes('FROM sessions')) return fixtures.nights ?? [];
            if (flat.includes('FROM squad_summoners WHERE squad_id')) {
                return fixtures.roster ?? [];
            }
            if (flat.includes('SELECT puuid FROM summoner_privacy')) {
                return fixtures.hidden ?? [];
            }
            if (flat.includes('FROM summoners')) return fixtures.names ?? [];
            if (flat.includes('FROM rank_tracking'))
                return fixtures.ranks ?? [];
            return [];
        };
        return { rows: rows(), rowCount: rows().length };
    });
}

const rosterRow = (matchId: string, members: unknown[], gameCreation = 1) => ({
    matchId,
    gameCreation,
    members,
});

const memberJson = (
    puuid: string,
    overrides: Record<string, unknown> = {}
) => ({
    puuid,
    win: true,
    teamId: 100,
    championName: 'Lux',
    kills: 4,
    deaths: 1,
    assists: 6,
    ...overrides,
});

beforeEach(() => {
    queryMock.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('fetchSquadMatches', () => {
    it('asks for nothing when the squad has no roster', async () => {
        // A squad with no tracked players cannot have played anything, and the
        // ANY($1) would match every row rather than none.
        await expect(fetchSquadMatches([], 0, 1)).resolves.toEqual([]);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('deduplicates match_details before unpacking participants', async () => {
        install({});
        await fetchSquadMatches(['p1'], 0, 1);
        const sql = String(queryMock.mock.calls[0][0]).replace(/\s+/g, ' ');
        // Five tracked players in one game is five rows; unpacking first would
        // produce twenty-five member entries for five people.
        expect(sql).toContain('DISTINCT ON (md."matchId")');
        expect(sql.indexOf('DISTINCT ON')).toBeLessThan(
            sql.indexOf('jsonb_array_elements')
        );
    });

    it('projects only the fields the card needs', async () => {
        install({});
        await fetchSquadMatches(['p1'], 0, 1);
        const sql = String(queryMock.mock.calls[0][0]);
        // `participants` is the ~100-metric blob for ten players. Shipping it
        // whole for a 90-day window is tens of megabytes for seven fields.
        expect(sql).toContain('jsonb_build_object');
        expect(sql).toContain(`WHERE p->>'puuid' = ANY($1::varchar[])`);
    });

    it('drops a participant entry with no puuid', async () => {
        install({
            matches: [rosterRow('M1', [memberJson('p1'), { win: true }])],
        });
        const matches = await fetchSquadMatches(['p1'], 0, 1);
        expect(matches[0].members).toHaveLength(1);
    });

    it('normalises missing numbers rather than emitting NaN', async () => {
        install({
            matches: [
                rosterRow('M1', [
                    memberJson('p1', {
                        kills: null,
                        deaths: null,
                        assists: null,
                        teamId: null,
                        win: null,
                    }),
                ]),
            ],
        });
        const [match] = await fetchSquadMatches(['p1'], 0, 1);
        expect(match.members[0]).toMatchObject({
            kills: 0,
            deaths: 0,
            assists: 0,
            teamId: null,
            win: null,
        });
    });
});

describe('pickWrappedGames', () => {
    const score = (matchId: string, puuid: string, value: number) => ({
        matchId,
        puuid,
        score: value,
        gameCreation: 1_700_000_000_000,
    });

    it('finds nothing in an empty period', () => {
        expect(pickWrappedGames([])).toEqual({});
    });

    it('names the highest single score as the best game', () => {
        const { best } = pickWrappedGames([
            score('M1', 'a', 40),
            score('M2', 'b', 91),
        ]);
        expect(best?.puuid).toBe('b');
    });

    it('picks the worst game by squad mean, not by one bad player', () => {
        // A game one person threw while four carried is not the worst game;
        // "worst: everyone's, game 6" is load-bearing, not a turn of phrase.
        const { worst } = pickWrappedGames([
            score('M1', 'a', 10),
            score('M1', 'b', 90),
            score('M1', 'c', 90),
            score('M2', 'a', 40),
            score('M2', 'b', 41),
        ]);
        expect(worst?.matchId).toBe('M2');
        expect(worst?.playerCount).toBe(2);
    });

    it('breaks ties the same way every time', () => {
        const entries = [score('M2', 'a', 50), score('M1', 'b', 50)];
        expect(pickWrappedGames(entries).best?.matchId).toBe('M1');
        expect(pickWrappedGames([...entries].reverse()).best?.matchId).toBe(
            'M1'
        );
    });
});

describe('pickWorstNight', () => {
    const night = (
        id: string,
        wins: number,
        losses: number,
        matchCount = wins + losses
    ) => ({
        session_id: id,
        started_at: '2026-05-01T20:00:00.000Z',
        ended_at: '2026-05-02T01:00:00.000Z',
        wins,
        losses,
        match_count: matchCount,
        voice_seconds: 3600,
    });

    it('prefers more losses', () => {
        expect(
            pickWorstNight([night('a', 3, 2), night('b', 4, 6)])?.sessionId
        ).toBe('b');
    });

    it('breaks a tie on losses by fewer wins, so 0-6 beats 2-6', () => {
        expect(
            pickWorstNight([night('a', 2, 6), night('b', 0, 6)])?.sessionId
        ).toBe('b');
    });

    it('ignores a night with no matches', () => {
        // "The night you went 0-0" is a night you did not play, and it is
        // already represented in the voice hours.
        expect(pickWorstNight([night('a', 0, 0, 0)])).toBeNull();
    });

    it('ignores a night nobody lost', () => {
        expect(pickWorstNight([night('a', 5, 0)])).toBeNull();
    });
});

describe('computeSquadWrapped', () => {
    it('returns null when nothing happened', async () => {
        // An empty card reads as a bug rather than as an honest "nothing
        // happened".
        install({ roster: [{ puuid: 'p1' }] });
        await expect(
            computeSquadWrapped('sq1', { period: PERIOD })
        ).resolves.toBeNull();
    });

    it('counts distinct matches for the headline figure', async () => {
        install({
            roster: [{ puuid: 'p1' }, { puuid: 'p2' }],
            matches: [
                rosterRow('M1', [memberJson('p1'), memberJson('p2')]),
                rosterRow('M2', [
                    memberJson('p1', { win: false }),
                    memberJson('p2', { win: false }),
                ]),
            ],
            names: [
                { puuid: 'p1', gameName: 'One', tagLine: 'EUW' },
                { puuid: 'p2', gameName: 'Two', tagLine: 'EUW' },
            ],
        });

        const wrapped = await computeSquadWrapped('sq1', { period: PERIOD });
        expect(wrapped?.totalGames).toBe(2);
        expect(wrapped?.wins).toBe(1);
        expect(wrapped?.losses).toBe(1);
        expect(wrapped?.playerCount).toBe(2);
    });

    it('renders names in the form every other surface uses', async () => {
        install({
            roster: [{ puuid: 'p1' }],
            matches: [rosterRow('M1', [memberJson('p1')])],
            names: [{ puuid: 'p1', gameName: 'Player', tagLine: 'EUW' }],
        });
        const wrapped = await computeSquadWrapped('sq1', { period: PERIOD });
        expect(wrapped?.players[0].name).toBe('Player#EUW');
    });

    it('falls back to the puuid when a summoner row is missing', async () => {
        install({
            roster: [{ puuid: 'p1' }],
            matches: [rosterRow('M1', [memberJson('p1')])],
            names: [],
        });
        const wrapped = await computeSquadWrapped('sq1', { period: PERIOD });
        expect(wrapped?.players[0].name).toBe('p1');
    });

    it('averages AI score from the scores read, not from participants', async () => {
        install({
            roster: [{ puuid: 'p1' }],
            matches: [
                rosterRow('M1', [memberJson('p1')]),
                rosterRow('M2', [memberJson('p1')]),
            ],
            scores: [
                { matchId: 'M1', puuid: 'p1', score: 80, gameCreation: 1 },
                { matchId: 'M2', puuid: 'p1', score: 60, gameCreation: 2 },
            ],
            names: [{ puuid: 'p1', gameName: 'Player', tagLine: 'EUW' }],
        });
        const wrapped = await computeSquadWrapped('sq1', { period: PERIOD });
        expect(wrapped?.players[0].avgAiScore).toBe(70);
    });

    it('reports no average for a player nothing scored', async () => {
        install({
            roster: [{ puuid: 'p1' }],
            matches: [rosterRow('M1', [memberJson('p1')])],
            names: [{ puuid: 'p1', gameName: 'Player', tagLine: 'EUW' }],
        });
        const wrapped = await computeSquadWrapped('sq1', { period: PERIOD });
        expect(wrapped?.players[0].avgAiScore).toBeNull();
    });

    it('omits the second award when one game is both best and worst', async () => {
        install({
            roster: [{ puuid: 'p1' }],
            matches: [rosterRow('M1', [memberJson('p1')])],
            scores: [
                { matchId: 'M1', puuid: 'p1', score: 70, gameCreation: 1 },
            ],
            names: [{ puuid: 'p1', gameName: 'Player', tagLine: 'EUW' }],
        });
        const wrapped = await computeSquadWrapped('sq1', { period: PERIOD });
        expect(wrapped?.bestGame?.matchId).toBe('M1');
        expect(wrapped?.worstGame).toBeUndefined();
    });

    it('names the best game’s champion from the matches already in memory', async () => {
        install({
            roster: [{ puuid: 'p1' }],
            matches: [
                rosterRow('M1', [
                    memberJson('p1', { championName: 'Warwick' }),
                ]),
            ],
            scores: [
                { matchId: 'M1', puuid: 'p1', score: 99, gameCreation: 1 },
            ],
            names: [{ puuid: 'p1', gameName: 'Player', tagLine: 'EUW' }],
        });
        const wrapped = await computeSquadWrapped('sq1', { period: PERIOD });
        expect(wrapped?.bestGame?.championName).toBe('Warwick');
        // And without the extra match_details round trip the recap makes.
        const detailReads = queryMock.mock.calls.filter((call) =>
            String(call[0]).includes("participant->>'championName'")
        );
        expect(detailReads).toHaveLength(0);
    });

    it('omits voice entirely when the squad has no sessionised nights', async () => {
        // A squad with no Meeps space must not be told it spent 0 hours in
        // voice: absent means "not awarded", never "unknown".
        install({
            roster: [{ puuid: 'p1' }],
            matches: [rosterRow('M1', [memberJson('p1')])],
            names: [{ puuid: 'p1', gameName: 'Player', tagLine: 'EUW' }],
        });
        const wrapped = await computeSquadWrapped('sq1', { period: PERIOD });
        expect(wrapped?.voice).toBeUndefined();
        expect(wrapped?.worstNight).toBeUndefined();
    });

    it('reports voice hours and the longest night when nights exist', async () => {
        install({
            roster: [{ puuid: 'p1' }],
            matches: [rosterRow('M1', [memberJson('p1')])],
            names: [{ puuid: 'p1', gameName: 'Player', tagLine: 'EUW' }],
            nights: [
                {
                    session_id: 's1',
                    started_at: '2026-05-01T20:00:00.000Z',
                    ended_at: '2026-05-02T01:00:00.000Z',
                    wins: 1,
                    losses: 4,
                    match_count: 5,
                    voice_seconds: 18000,
                },
            ],
            voice: [{ meepsUserId: 'meeps-1', voiceSeconds: 9000, nights: 1 }],
        });

        const wrapped = await computeSquadWrapped('sq1', { period: PERIOD });
        expect(wrapped?.voice?.totalVoiceSeconds).toBe(18000);
        expect(wrapped?.voice?.nights).toBe(1);
        expect(wrapped?.voice?.longestNightSeconds).toBe(5 * 3600);
        expect(wrapped?.voice?.byPerson[0].meepsUserId).toBe('meeps-1');
        expect(wrapped?.worstNight?.losses).toBe(4);
    });

    it('awards a climb only when somebody actually climbed', async () => {
        install({
            roster: [{ puuid: 'p1' }],
            matches: [rosterRow('M1', [memberJson('p1')])],
            names: [{ puuid: 'p1', gameName: 'Player', tagLine: 'EUW' }],
            ranks: [
                { tier: 'GOLD', rank: 'II', lp: 40 },
                { tier: 'GOLD', rank: 'IV', lp: 10 },
            ],
        });
        const wrapped = await computeSquadWrapped('sq1', { period: PERIOD });
        expect(wrapped?.biggestClimb?.delta).toBe(230);
        expect(wrapped?.biggestClimb?.from).toBe('GOLD IV 10 LP');
        expect(wrapped?.biggestClimb?.to).toBe('GOLD II 40 LP');
        // A period where everybody climbed has no faller.
        expect(wrapped?.biggestFall).toBeUndefined();
    });

    it('does not invent a journey from a single rank row', async () => {
        install({
            roster: [{ puuid: 'p1' }],
            matches: [rosterRow('M1', [memberJson('p1')])],
            names: [{ puuid: 'p1', gameName: 'Player', tagLine: 'EUW' }],
            ranks: [{ tier: 'GOLD', rank: 'II', lp: 40 }],
        });
        const wrapped = await computeSquadWrapped('sq1', { period: PERIOD });
        expect(wrapped?.biggestClimb).toBeUndefined();
        expect(wrapped?.biggestFall).toBeUndefined();
    });

    it('carries the period it was asked for, so the card never guesses', async () => {
        install({
            roster: [{ puuid: 'p1' }],
            matches: [rosterRow('M1', [memberJson('p1')])],
            names: [{ puuid: 'p1', gameName: 'Player', tagLine: 'EUW' }],
        });
        const wrapped = await computeSquadWrapped('sq1', { period: PERIOD });
        expect(wrapped?.period.label).toBe('Test period');
        expect(wrapped?.period.from).toBe('2026-04-01T00:00:00.000Z');
    });
});

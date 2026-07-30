jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({ db: { query: jest.fn() } })
);
jest.mock('../packages/diana-core/src/core/presence/presenceService', () => ({
    getPresenceForSquad: jest.fn(),
}));

import { db } from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db';
import { getPresenceForSquad } from '../packages/diana-core/src/core/presence/presenceService';
import {
    findMatchesInWindow,
    getSquadPuuids,
    rebuildSessionsForSquad,
} from '../packages/diana-core/src/core/sessions/sessionService';
import type { PresenceEventRow } from '../packages/diana-core/src/core/presence/presenceService';

const queryMock = db.query as unknown as jest.Mock;
const presenceMock = getPresenceForSquad as jest.Mock;

const T0 = Date.parse('2026-07-28T20:00:00.000Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

function event(
    type: 'voice.joined' | 'voice.left',
    meepsUserId: string,
    atMs: number
): PresenceEventRow {
    return {
        event_id: `${type}:sq1:${meepsUserId}:${atMs}`,
        type,
        squad_id: 'sq1',
        meeps_user_id: meepsUserId,
        puuid: null,
        channel_id: 'voice-1',
        queue_id: null,
        match_id: null,
        occurred_at: new Date(atMs).toISOString(),
        received_at: new Date(atMs).toISOString(),
        payload: {},
    };
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

describe('getSquadPuuids', () => {
    it('reads the squad roster, which needs no identity linking', () => {
        queryMock.mockResolvedValue({
            rows: [{ puuid: 'p1' }, { puuid: 'p2' }],
        });

        return getSquadPuuids('sq1').then((puuids) => {
            expect(puuids).toEqual(['p1', 'p2']);
            expect(queryMock.mock.calls[0][0]).toContain('squad_summoners');
        });
    });
});

// ---------------------------------------------------------------------------
// Match attachment
// ---------------------------------------------------------------------------

describe('findMatchesInWindow', () => {
    function matchRow(overrides: Record<string, unknown> = {}) {
        return {
            matchId: 'EUW1_1',
            gameStartTime: String(T0 + 10 * MIN),
            gameEndTime: String(T0 + 40 * MIN),
            gameDuration: 1800,
            queueId: 420,
            participants: [{ puuid: 'p1', win: true }],
            ...overrides,
        };
    }

    it('does no query at all for a squad with no tracked players', async () => {
        expect(await findMatchesInWindow([], T0, T0 + HOUR)).toEqual([]);
        expect(queryMock).not.toHaveBeenCalled();
    });

    // match_details is unique on (matchId, entryPlayerPuuid), so a game five
    // tracked players were in is five rows. Counting it five times would put
    // "7 games" on the card for a night with two.
    it('deduplicates on matchId in the query itself', async () => {
        queryMock.mockResolvedValue({ rows: [matchRow()] });

        await findMatchesInWindow(['p1', 'p2'], T0, T0 + HOUR);

        expect(queryMock.mock.calls[0][0]).toContain('DISTINCT ON ("matchId")');
    });

    // Overlap, not containment: a game that started before the first person
    // joined voice still belongs to the night they spent talking about it.
    it('selects on overlap rather than containment', async () => {
        queryMock.mockResolvedValue({ rows: [] });

        await findMatchesInWindow(['p1'], T0, T0 + HOUR);

        const [sql, params] = queryMock.mock.calls[0];
        expect(sql).toContain('"gameStartTime" <= $3');
        expect(sql).toContain('>= $2');
        expect(params).toEqual([['p1'], T0, T0 + HOUR]);
    });

    it('reads the win from the tracked players own participant entries', async () => {
        queryMock.mockResolvedValue({ rows: [matchRow()] });

        const [match] = await findMatchesInWindow(['p1'], T0, T0 + HOUR);

        expect(match).toMatchObject({
            matchId: 'EUW1_1',
            queueId: 420,
            win: true,
            startedAt: T0 + 10 * MIN,
            endedAt: T0 + 40 * MIN,
        });
    });

    // Two tracked players on opposite sides happens in customs and in Arena.
    // Calling that a squad win would be a straight-up lie on the recap card.
    it('reports null when the squads own players disagree on the result', async () => {
        queryMock.mockResolvedValue({
            rows: [
                matchRow({
                    participants: [
                        { puuid: 'p1', win: true },
                        { puuid: 'p2', win: false },
                    ],
                }),
            ],
        });

        const [match] = await findMatchesInWindow(['p1', 'p2'], T0, T0 + HOUR);

        expect(match.win).toBeNull();
    });

    it('ignores untracked players when deciding the result', async () => {
        queryMock.mockResolvedValue({
            rows: [
                matchRow({
                    participants: [
                        { puuid: 'p1', win: true },
                        { puuid: 'stranger', win: false },
                    ],
                }),
            ],
        });

        const [match] = await findMatchesInWindow(['p1'], T0, T0 + HOUR);

        expect(match.win).toBe(true);
    });

    it('reports null rather than guessing when participants are unusable', async () => {
        queryMock.mockResolvedValue({
            rows: [matchRow({ participants: null })],
        });

        const [match] = await findMatchesInWindow(['p1'], T0, T0 + HOUR);

        expect(match.win).toBeNull();
    });

    it('derives the end from duration when gameEndTime is missing', async () => {
        queryMock.mockResolvedValue({
            rows: [matchRow({ gameEndTime: null, gameDuration: 600 })],
        });

        const [match] = await findMatchesInWindow(['p1'], T0, T0 + HOUR);

        expect(match.endedAt).toBe(T0 + 10 * MIN + 600 * 1000);
    });

    it('drops a match with no usable start time instead of dating it to 1970', async () => {
        queryMock.mockResolvedValue({
            rows: [matchRow({ gameStartTime: null })],
        });

        expect(await findMatchesInWindow(['p1'], T0, T0 + HOUR)).toEqual([]);
    });

    it('returns matches in the order they were played', async () => {
        queryMock.mockResolvedValue({
            rows: [
                matchRow({
                    matchId: 'B',
                    gameStartTime: String(T0 + 30 * MIN),
                }),
                matchRow({ matchId: 'A', gameStartTime: String(T0 + 5 * MIN) }),
            ],
        });

        const matches = await findMatchesInWindow(['p1'], T0, T0 + HOUR);

        expect(matches.map((m) => m.matchId)).toEqual(['A', 'B']);
    });
});

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

describe('rebuildSessionsForSquad', () => {
    /** Route every statement the rebuild issues, capturing what it wrote. */
    function wireDb({ matches = [] as unknown[] } = {}) {
        const writes: Array<{ sql: string; params: unknown[] }> = [];
        queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
            if (sql.includes('squad_summoners')) {
                return { rows: [{ puuid: 'p1' }] };
            }
            if (sql.includes('match_details')) return { rows: matches };
            if (sql.includes('INSERT INTO sessions')) {
                writes.push({ sql, params });
                return { rows: [{ session_id: 'sess-1' }] };
            }
            writes.push({ sql, params });
            return { rows: [], rowCount: 0 };
        });
        return writes;
    }

    it('does nothing when a squad has no voice presence', async () => {
        presenceMock.mockResolvedValue([]);
        wireDb();

        const result = await rebuildSessionsForSquad('sq1');

        expect(result).toEqual({
            squadId: 'sq1',
            sessions: 0,
            matchesAttached: 0,
            openSessions: 0,
        });
        // Not even the roster is read - there is nothing to attach matches to.
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('writes one session with its participants for a single night', async () => {
        presenceMock.mockResolvedValue([
            event('voice.joined', 'a', T0),
            event('voice.joined', 'b', T0 + 10 * MIN),
            event('voice.left', 'b', T0 + HOUR),
            event('voice.left', 'a', T0 + 2 * HOUR),
        ]);
        const writes = wireDb();

        const result = await rebuildSessionsForSquad('sq1', {
            now: T0 + 12 * HOUR,
        });

        expect(result.sessions).toBe(1);
        expect(result.openSessions).toBe(0);

        const session = writes.find((w) =>
            w.sql.includes('INSERT INTO sessions')
        );
        expect(session).toBeDefined();
        // participant_count is the 4th parameter.
        expect(session?.params[3]).toBe(2);

        const participants = writes.filter((w) =>
            w.sql.includes('INSERT INTO session_participants')
        );
        expect(participants).toHaveLength(2);
    });

    // The upsert is what makes a rebuild safe to run on a cron: recomputing the
    // same night must update the row, not add a second copy.
    it('upserts on (squad_id, started_at) so a rebuild is idempotent', async () => {
        presenceMock.mockResolvedValue([
            event('voice.joined', 'a', T0),
            event('voice.left', 'a', T0 + HOUR),
        ]);
        const writes = wireDb();

        await rebuildSessionsForSquad('sq1', { now: T0 + 12 * HOUR });

        const session = writes.find((w) =>
            w.sql.includes('INSERT INTO sessions')
        );
        expect(session?.sql).toContain('ON CONFLICT (squad_id, started_at)');
    });

    // A rebuild can legitimately *remove* a participant or match — a later
    // erasure, a corrected window — and an upsert alone would leave the stale
    // row behind forever.
    it('replaces children wholesale rather than upserting them', async () => {
        presenceMock.mockResolvedValue([
            event('voice.joined', 'a', T0),
            event('voice.left', 'a', T0 + HOUR),
        ]);
        const writes = wireDb();

        await rebuildSessionsForSquad('sq1', { now: T0 + 12 * HOUR });

        expect(
            writes.some((w) =>
                w.sql.includes('DELETE FROM session_participants')
            )
        ).toBe(true);
        expect(
            writes.some((w) => w.sql.includes('DELETE FROM session_matches'))
        ).toBe(true);
    });

    it('attaches matches and counts the record', async () => {
        presenceMock.mockResolvedValue([
            event('voice.joined', 'a', T0),
            event('voice.left', 'a', T0 + 3 * HOUR),
        ]);
        const writes = wireDb({
            matches: [
                {
                    matchId: 'EUW1_1',
                    gameStartTime: String(T0 + 10 * MIN),
                    gameEndTime: String(T0 + 40 * MIN),
                    gameDuration: 1800,
                    queueId: 420,
                    participants: [{ puuid: 'p1', win: true }],
                },
                {
                    matchId: 'EUW1_2',
                    gameStartTime: String(T0 + 60 * MIN),
                    gameEndTime: String(T0 + 90 * MIN),
                    gameDuration: 1800,
                    queueId: 420,
                    participants: [{ puuid: 'p1', win: false }],
                },
            ],
        });

        const result = await rebuildSessionsForSquad('sq1', {
            now: T0 + 12 * HOUR,
        });

        expect(result.matchesAttached).toBe(2);

        const session = writes.find((w) =>
            w.sql.includes('INSERT INTO sessions')
        );
        // match_count, wins, losses are parameters 5, 6, 7.
        expect(session?.params[4]).toBe(2);
        expect(session?.params[5]).toBe(1);
        expect(session?.params[6]).toBe(1);
    });

    // "You were 3-1 after game 5" counts from one, and the Session Curve is
    // entirely a question about this ordinal.
    it('numbers games from one, in the order played', async () => {
        presenceMock.mockResolvedValue([
            event('voice.joined', 'a', T0),
            event('voice.left', 'a', T0 + 3 * HOUR),
        ]);
        const writes = wireDb({
            matches: [
                {
                    matchId: 'second',
                    gameStartTime: String(T0 + 60 * MIN),
                    gameEndTime: String(T0 + 90 * MIN),
                    gameDuration: 1800,
                    queueId: 420,
                    participants: [],
                },
                {
                    matchId: 'first',
                    gameStartTime: String(T0 + 10 * MIN),
                    gameEndTime: String(T0 + 40 * MIN),
                    gameDuration: 1800,
                    queueId: 420,
                    participants: [],
                },
            ],
        });

        await rebuildSessionsForSquad('sq1', { now: T0 + 12 * HOUR });

        const matchWrites = writes.filter((w) =>
            w.sql.includes('INSERT INTO session_matches')
        );
        expect(matchWrites.map((w) => [w.params[1], w.params[2]])).toEqual([
            ['first', 1],
            ['second', 2],
        ]);
    });

    it('reports a live night as an open session', async () => {
        presenceMock.mockResolvedValue([event('voice.joined', 'a', T0)]);
        wireDb();

        const result = await rebuildSessionsForSquad('sq1', {
            now: T0 + HOUR,
        });

        expect(result.openSessions).toBe(1);
    });

    it('passes `since` through so a rebuild can be bounded', async () => {
        presenceMock.mockResolvedValue([]);
        wireDb();

        await rebuildSessionsForSquad('sq1', { since: '2026-07-01T00:00:00Z' });

        expect(presenceMock).toHaveBeenCalledWith(
            'sq1',
            '2026-07-01T00:00:00Z'
        );
    });
});

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({ db: { query: jest.fn() } })
);

import { db } from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db';
import {
    buildSessionCompletedEvent,
    computeStandouts,
    findSettledSessions,
    markRecapEmitted,
    pickStandouts,
} from '../packages/diana-core/src/core/sessions/recapService';
import { DEFAULT_IDLE_GAP_MS } from '../packages/diana-core/src/core/sessions/sessionise';
import type {
    SessionDetail,
    SessionMatchRow,
    SessionParticipantRow,
    SessionRow,
} from '../packages/diana-core/src/core/sessions/sessionService';

const queryMock = db.query as unknown as jest.Mock;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NIGHT_START = Date.parse('2026-07-28T20:12:00.000Z');
const NIGHT_END = Date.parse('2026-07-29T01:40:00.000Z');

beforeEach(() => jest.clearAllMocks());

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
    return {
        session_id: 'sess-1',
        squad_id: 'squad-1',
        started_at: new Date(NIGHT_START).toISOString(),
        ended_at: new Date(NIGHT_END).toISOString(),
        participant_count: 5,
        match_count: 7,
        wins: 3,
        losses: 4,
        peak_concurrent: 5,
        voice_seconds: 60000,
        computed_at: new Date(NIGHT_END).toISOString(),
        ...overrides,
    };
}

function participant(
    meepsUserId: string,
    overrides: Partial<SessionParticipantRow> = {}
): SessionParticipantRow {
    return {
        session_id: 'sess-1',
        meeps_user_id: meepsUserId,
        puuid: null,
        first_joined_at: new Date(NIGHT_START).toISOString(),
        last_left_at: new Date(NIGHT_END).toISOString(),
        voice_seconds: 19680,
        interval_count: 1,
        ...overrides,
    };
}

function match(
    gameIndex: number,
    overrides: Partial<SessionMatchRow> = {}
): SessionMatchRow {
    return {
        session_id: 'sess-1',
        match_id: `EUW1_${gameIndex}`,
        game_index: gameIndex,
        started_at: new Date(NIGHT_START + gameIndex * 30 * MIN).toISOString(),
        ended_at: new Date(
            NIGHT_START + gameIndex * 30 * MIN + 25 * MIN
        ).toISOString(),
        queue_id: 420,
        win: gameIndex % 2 === 1,
        ...overrides,
    };
}

function detail(overrides: Partial<SessionDetail> = {}): SessionDetail {
    return {
        session: sessionRow(),
        participants: [participant('meeps-a'), participant('meeps-b')],
        matches: [match(1), match(2)],
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Settlement - the rule the whole feature turns on
// ---------------------------------------------------------------------------

describe('findSettledSessions', () => {
    it('asks for nights that finished at least one idle gap ago', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        const now = Date.parse('2026-07-29T03:00:00.000Z');

        await findSettledSessions(now);

        const [, params] = queryMock.mock.calls[0];
        expect(params[0]).toBe(
            new Date(now - DEFAULT_IDLE_GAP_MS).toISOString()
        );
    });

    it('moves the watermark with a custom idle gap', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        const now = Date.parse('2026-07-29T03:00:00.000Z');

        await findSettledSessions(now, 10 * MIN);

        const [, params] = queryMock.mock.calls[0];
        expect(params[0]).toBe(new Date(now - 10 * MIN).toISOString());
    });

    // A night that has not settled is not merely "not ready" - a rejoin inside
    // the gap moves ended_at later, so announcing it would describe a night that
    // then kept going.
    it('excludes live nights and already-announced ones in the query itself', async () => {
        queryMock.mockResolvedValue({ rows: [] });

        await findSettledSessions(Date.now());

        const [sql] = queryMock.mock.calls[0];
        expect(sql).toContain('recap_emitted_at IS NULL');
        expect(sql).toContain('ended_at IS NOT NULL');
    });
});

describe('markRecapEmitted', () => {
    it('stamps the session it is given', async () => {
        queryMock.mockResolvedValue({ rows: [] });

        await markRecapEmitted('sess-9');

        const [sql, params] = queryMock.mock.calls[0];
        expect(sql).toContain('recap_emitted_at = NOW()');
        expect(params).toEqual(['sess-9']);
    });
});

// ---------------------------------------------------------------------------
// Standouts
// ---------------------------------------------------------------------------

const entry = (
    gameIndex: number,
    puuid: string,
    score: number
): Parameters<typeof pickStandouts>[0][number] => ({
    matchId: `EUW1_${gameIndex}`,
    gameIndex,
    puuid,
    summonerName: `${puuid}#EUW`,
    score,
    placement: 1,
});

describe('pickStandouts', () => {
    it('returns nothing at all when the night had no scored games', () => {
        expect(pickStandouts([])).toEqual({});
    });

    it('picks the single best individual performance', () => {
        const result = pickStandouts([
            entry(1, 'p1', 40),
            entry(1, 'p2', 55),
            entry(2, 'p1', 80),
            entry(2, 'p2', 20),
        ]);

        expect(result.best?.puuid).toBe('p1');
        expect(result.best?.gameIndex).toBe(2);
        expect(result.best?.score).toBe(80);
    });

    // The card says "worst: everyone's, game 6". It names a game, and the
    // arithmetic that finds it is a mean across the squad - not the single
    // lowest score, which would name a person.
    it('picks the worst GAME by squad mean, not the worst player', () => {
        const result = pickStandouts([
            // Game 1 mean 50, and contains the night's single lowest score.
            entry(1, 'p1', 95),
            entry(1, 'p2', 5),
            // Game 2 mean 30 - worse as a game, though nobody hit a low of 5.
            entry(2, 'p1', 30),
            entry(2, 'p2', 30),
        ]);

        expect(result.worst?.gameIndex).toBe(2);
        expect(result.worst?.meanAiScore).toBe(30);
        expect(result.worst).not.toHaveProperty('puuid');
        expect(result.worst).not.toHaveProperty('summonerName');
    });

    // Redelivery must not contradict the first card, so ties cannot be
    // arbitrary. Earliest game wins in both directions.
    it('breaks a best-score tie towards the earlier game', () => {
        const result = pickStandouts([entry(3, 'p1', 70), entry(1, 'p2', 70)]);

        expect(result.best?.gameIndex).toBe(1);
    });

    it('breaks a worst-game tie towards the earlier game', () => {
        const result = pickStandouts([entry(2, 'p1', 10), entry(5, 'p1', 10)]);

        expect(result.worst?.gameIndex).toBe(2);
    });

    it('handles a night where one game was played by one person', () => {
        const result = pickStandouts([entry(1, 'p1', 42)]);

        expect(result.best?.score).toBe(42);
        expect(result.worst).toEqual({
            matchId: 'EUW1_1',
            gameIndex: 1,
            meanAiScore: 42,
        });
    });
});

describe('computeStandouts', () => {
    it('emits neither standout rather than a zero when nothing scored', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });

        await expect(computeStandouts('sess-1', ['p1'])).resolves.toEqual({});
    });

    it('does not query at all for a squad with no tracked accounts', async () => {
        await expect(computeStandouts('sess-1', [])).resolves.toEqual({});
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('names the best performance and its champion', async () => {
        queryMock
            .mockResolvedValueOnce({
                rows: [
                    {
                        matchId: 'EUW1_2',
                        gameIndex: 2,
                        puuid: 'p-aidan',
                        summonerName: 'Aidan#EUW',
                        score: 88.5,
                        placement: 1,
                    },
                ],
            })
            .mockResolvedValueOnce({ rows: [{ championName: 'Warwick' }] });

        const result = await computeStandouts('sess-1', ['p-aidan']);

        expect(result.bestGame).toEqual({
            matchId: 'EUW1_2',
            gameIndex: 2,
            puuid: 'p-aidan',
            summonerName: 'Aidan#EUW',
            championName: 'Warwick',
            aiScore: 88.5,
            placement: 1,
        });
    });

    it('falls back to the puuid when the summoner row has gone', async () => {
        queryMock
            .mockResolvedValueOnce({
                rows: [
                    {
                        matchId: 'EUW1_1',
                        gameIndex: 1,
                        puuid: 'p-orphan',
                        summonerName: null,
                        score: 10,
                        placement: 5,
                    },
                ],
            })
            .mockResolvedValueOnce({ rows: [] });

        const result = await computeStandouts('sess-1', ['p-orphan']);

        expect(result.bestGame?.summonerName).toBe('p-orphan');
        expect(result.bestGame?.championName).toBeNull();
    });

    it('only counts the squad, so a stranger cannot win best game', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });

        await computeStandouts('sess-1', ['p1', 'p2']);

        const [sql, params] = queryMock.mock.calls[0];
        expect(sql).toContain('ms."puuid" = ANY($2::varchar[])');
        expect(params[1]).toEqual(['p1', 'p2']);
    });
});

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

describe('buildSessionCompletedEvent', () => {
    it('keys on the squad and start instant, never the session uuid', () => {
        const event = buildSessionCompletedEvent(detail());

        expect(event.eventId).toBe(
            `session.completed:squad-1:${new Date(NIGHT_START).toISOString()}`
        );
        expect(event.eventId).not.toContain('sess-1');
    });

    // The driver hands back TIMESTAMPTZ as a Date or a string depending on how
    // it is configured. Two spellings of one instant would key one night twice.
    it('normalises the key whether the row carries a Date or a string', () => {
        const asDate = buildSessionCompletedEvent(
            detail({
                session: sessionRow({
                    started_at: new Date(NIGHT_START) as unknown as string,
                }),
            })
        );

        expect(asDate.eventId).toBe(
            buildSessionCompletedEvent(detail()).eventId
        );
    });

    // "When the thing happened, not when we noticed it" - and the sweep can
    // notice a full idle gap late.
    it('stamps occurredAt with the end of the night, not the sweep time', () => {
        const event = buildSessionCompletedEvent(detail());

        expect(event.occurredAt).toBe(new Date(NIGHT_END).toISOString());
        expect(event.occurredAt).toBe(event.endedAt);
    });

    it('carries wall-clock duration and summed voice time as different numbers', () => {
        const event = buildSessionCompletedEvent(detail());

        expect(event.durationSeconds).toBe((NIGHT_END - NIGHT_START) / 1000);
        expect(event.voiceSeconds).toBe(60000);
        expect(event.voiceSeconds).not.toBe(event.durationSeconds);
    });

    it('carries participants by Meeps id, which is what makes it renderable without DN-3', () => {
        const event = buildSessionCompletedEvent(detail());

        expect(event.participants.map((p) => p.meepsUserId)).toEqual([
            'meeps-a',
            'meeps-b',
        ]);
        expect(event.participants[0].puuid).toBeNull();
    });

    it('preserves game order and an undecided result', () => {
        const event = buildSessionCompletedEvent(
            detail({ matches: [match(1), match(2, { win: null })] })
        );

        expect(event.matches.map((m) => m.gameIndex)).toEqual([1, 2]);
        expect(event.matches[1].win).toBeNull();
    });

    it('omits standouts entirely rather than sending empty ones', () => {
        const event = buildSessionCompletedEvent(detail());

        expect(event).not.toHaveProperty('bestGame');
        expect(event).not.toHaveProperty('worstGame');
    });

    it('includes standouts when there are any', () => {
        const event = buildSessionCompletedEvent(detail(), {
            bestGame: {
                matchId: 'EUW1_2',
                gameIndex: 2,
                puuid: 'p1',
                summonerName: 'Aidan#EUW',
                championName: 'Warwick',
                aiScore: 88.5,
                placement: 1,
            },
            worstGame: {
                matchId: 'EUW1_6',
                gameIndex: 6,
                meanAiScore: 12.5,
            },
        });

        expect(event.bestGame?.championName).toBe('Warwick');
        expect(event.worstGame?.gameIndex).toBe(6);
    });

    // A live night is a real state in `sessions`, and it must never become a
    // recap: the card would describe an evening still in progress.
    it('refuses to build a recap for a night that has not ended', () => {
        expect(() =>
            buildSessionCompletedEvent(
                detail({ session: sessionRow({ ended_at: null }) })
            )
        ).toThrow(/has not ended/);
    });

    it('reports a participant who never left as unknown rather than guessing', () => {
        const event = buildSessionCompletedEvent(
            detail({
                participants: [participant('meeps-a', { last_left_at: null })],
            })
        );

        expect(event.participants[0].lastLeftAt).toBeNull();
    });

    it('describes a five-hour seven-game night the way the card reads it', () => {
        const event = buildSessionCompletedEvent(detail());

        expect(event.type).toBe('session.completed');
        expect(event.squadId).toBe('squad-1');
        expect(event.participantCount).toBe(5);
        expect(event.peakConcurrent).toBe(5);
        expect(event.matchCount).toBe(7);
        expect(event.wins).toBe(3);
        expect(event.losses).toBe(4);
        expect(event.durationSeconds).toBe((5 * HOUR) / 1000 + 28 * 60);
    });
});

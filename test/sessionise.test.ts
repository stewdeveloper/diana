import {
    DEFAULT_IDLE_GAP_MS,
    groupIntoSessions,
    sessionisePresence,
    toIntervals,
    type VoiceInterval,
} from '../packages/diana-core/src/core/sessions/sessionise';
import type { PresenceEventRow } from '../packages/diana-core/src/core/presence/presenceService';

/**
 * The sessionising rules (DN-6).
 *
 * These are judgement calls rather than facts — how long a gap ends a night,
 * what a leave with no join means — so they are tested directly and in the pure
 * layer, where a case is three lines instead of a database fixture.
 */

const T0 = Date.parse('2026-07-28T20:00:00.000Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function event(
    type: 'voice.joined' | 'voice.left',
    meepsUserId: string,
    atMs: number,
    overrides: Partial<PresenceEventRow> = {}
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
        ...overrides,
    };
}

function interval(
    meepsUserId: string,
    joinedAt: number,
    leftAt: number | null
): VoiceInterval {
    return { meepsUserId, puuid: null, channelId: 'voice-1', joinedAt, leftAt };
}

// ---------------------------------------------------------------------------
// Pairing events into intervals
// ---------------------------------------------------------------------------

describe('toIntervals', () => {
    it('pairs a join with its leave', () => {
        const intervals = toIntervals([
            event('voice.joined', 'a', T0),
            event('voice.left', 'a', T0 + HOUR),
        ]);

        expect(intervals).toHaveLength(1);
        expect(intervals[0]).toMatchObject({
            meepsUserId: 'a',
            joinedAt: T0,
            leftAt: T0 + HOUR,
        });
    });

    it('leaves someone still in voice open, which is what makes a session live', () => {
        const intervals = toIntervals([event('voice.joined', 'a', T0)]);

        expect(intervals).toHaveLength(1);
        expect(intervals[0].leftAt).toBeNull();
    });

    // Ordinary at the start of any backfill window: the join happened before the
    // window began. Inventing a start would fabricate voice duration, and
    // over-reporting time in a call is the one error this feature cannot afford.
    it('ignores a leave with no join rather than guessing when it started', () => {
        expect(toIntervals([event('voice.left', 'a', T0 + HOUR)])).toEqual([]);
    });

    // Meeps' unique index makes this near-impossible, but a re-keyed backfill
    // could produce it, and two overlapping intervals would double the duration.
    it('drops a duplicate join instead of opening a second overlapping interval', () => {
        const intervals = toIntervals([
            event('voice.joined', 'a', T0),
            event('voice.joined', 'a', T0 + MIN),
            event('voice.left', 'a', T0 + HOUR),
        ]);

        expect(intervals).toHaveLength(1);
        expect(intervals[0].joinedAt).toBe(T0);
    });

    it('treats the same person in two channels as two intervals', () => {
        const intervals = toIntervals([
            event('voice.joined', 'a', T0, { channel_id: 'chan-1' }),
            event('voice.joined', 'a', T0 + MIN, { channel_id: 'chan-2' }),
            event('voice.left', 'a', T0 + HOUR, { channel_id: 'chan-1' }),
            event('voice.left', 'a', T0 + HOUR, { channel_id: 'chan-2' }),
        ]);

        expect(intervals).toHaveLength(2);
    });

    it('clamps a leave that predates its join rather than emitting negative time', () => {
        const intervals = toIntervals([
            event('voice.joined', 'a', T0),
            event('voice.left', 'a', T0 - HOUR),
        ]);

        expect(intervals[0].leftAt).toBe(T0);
    });

    it('ignores client.* events - only voice defines a session', () => {
        const inGame = {
            ...event('voice.joined', 'a', T0),
            type: 'client.in_game' as PresenceEventRow['type'],
        };
        expect(toIntervals([inGame])).toEqual([]);
    });

    it('skips an unparseable timestamp instead of producing NaN durations', () => {
        const bad = { ...event('voice.joined', 'a', T0), occurred_at: 'nope' };
        expect(toIntervals([bad])).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Grouping intervals into nights
// ---------------------------------------------------------------------------

describe('groupIntoSessions', () => {
    it('keeps overlapping intervals in one session', () => {
        const groups = groupIntoSessions([
            interval('a', T0, T0 + 2 * HOUR),
            interval('b', T0 + 10 * MIN, T0 + HOUR),
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0]).toHaveLength(2);
    });

    it('splits on a gap longer than the idle threshold', () => {
        const groups = groupIntoSessions([
            interval('a', T0, T0 + HOUR),
            interval('a', T0 + HOUR + DEFAULT_IDLE_GAP_MS + MIN, T0 + 3 * HOUR),
        ]);

        expect(groups).toHaveLength(2);
    });

    it('bridges a gap shorter than the threshold', () => {
        const groups = groupIntoSessions([
            interval('a', T0, T0 + HOUR),
            interval('a', T0 + HOUR + 10 * MIN, T0 + 2 * HOUR),
        ]);

        expect(groups).toHaveLength(1);
    });

    // The comparison must be against the session's running maximum end, not the
    // previous interval's: one person sitting in voice all evening while others
    // come and go would otherwise be split into a session per arrival.
    it('measures the gap from the session end, not the previous interval', () => {
        const groups = groupIntoSessions([
            // Present the whole evening.
            interval('a', T0, T0 + 5 * HOUR),
            // Brief early visit, then a long absence.
            interval('b', T0 + MIN, T0 + 2 * MIN),
            // Arrives hours later - but 'a' never left, so it is the same night.
            interval('c', T0 + 4 * HOUR, T0 + 5 * HOUR),
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0]).toHaveLength(3);
    });

    it('never ends a session while someone is still in voice', () => {
        const groups = groupIntoSessions([
            interval('a', T0, null),
            interval('b', T0 + 10 * HOUR, T0 + 11 * HOUR),
        ]);

        expect(groups).toHaveLength(1);
    });

    it('respects a custom idle gap', () => {
        const groups = groupIntoSessions(
            [
                interval('a', T0, T0 + MIN),
                interval('a', T0 + 10 * MIN, T0 + 11 * MIN),
            ],
            { idleGapMs: 5 * MIN }
        );

        expect(groups).toHaveLength(2);
    });

    it('returns nothing for no intervals', () => {
        expect(groupIntoSessions([])).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// The whole derivation
// ---------------------------------------------------------------------------

describe('sessionisePresence', () => {
    const NOW = T0 + 12 * HOUR;

    it('summarises a simple two-person night', () => {
        const sessions = sessionisePresence(
            [
                event('voice.joined', 'a', T0),
                event('voice.joined', 'b', T0 + 10 * MIN),
                event('voice.left', 'b', T0 + 70 * MIN),
                event('voice.left', 'a', T0 + 2 * HOUR),
            ],
            { now: NOW }
        );

        expect(sessions).toHaveLength(1);
        const [session] = sessions;
        expect(session.startedAt).toBe(T0);
        expect(session.endedAt).toBe(T0 + 2 * HOUR);
        expect(session.peakConcurrent).toBe(2);
        expect(session.participants.map((p) => p.meepsUserId)).toEqual([
            'a',
            'b',
        ]);
        // 2h for a, 1h for b, summed.
        expect(session.voiceSeconds).toBe(3 * 3600);
    });

    it('counts a return visit rather than smoothing it into one stay', () => {
        const sessions = sessionisePresence(
            [
                event('voice.joined', 'a', T0),
                event('voice.left', 'a', T0 + 30 * MIN),
                event('voice.joined', 'a', T0 + 40 * MIN),
                event('voice.left', 'a', T0 + 70 * MIN),
            ],
            { now: NOW }
        );

        const [participant] = sessions[0].participants;
        expect(participant.intervalCount).toBe(2);
        // An hour of voice, not the 70 minutes the first-to-last span suggests.
        expect(participant.voiceSeconds).toBe(3600);
    });

    it('reports a live session as open with a running duration', () => {
        const sessions = sessionisePresence(
            [event('voice.joined', 'a', NOW - HOUR)],
            { now: NOW }
        );

        expect(sessions[0].endedAt).toBeNull();
        expect(sessions[0].participants[0].lastLeftAt).toBeNull();
        expect(sessions[0].participants[0].voiceSeconds).toBe(3600);
    });

    // One person leaving as another arrives is one person in voice, not two.
    it('does not double-count a handover at the same instant', () => {
        const sessions = sessionisePresence(
            [
                event('voice.joined', 'a', T0),
                event('voice.left', 'a', T0 + HOUR),
                event('voice.joined', 'b', T0 + HOUR),
                event('voice.left', 'b', T0 + 2 * HOUR),
            ],
            { now: NOW }
        );

        expect(sessions).toHaveLength(1);
        expect(sessions[0].peakConcurrent).toBe(1);
    });

    it('splits two nights and orders them oldest first', () => {
        const nightTwo = T0 + 24 * HOUR;
        const sessions = sessionisePresence(
            [
                event('voice.joined', 'a', T0),
                event('voice.left', 'a', T0 + HOUR),
                event('voice.joined', 'a', nightTwo),
                event('voice.left', 'a', nightTwo + HOUR),
            ],
            { now: nightTwo + 12 * HOUR }
        );

        expect(sessions).toHaveLength(2);
        expect(sessions[0].startedAt).toBe(T0);
        expect(sessions[1].startedAt).toBe(nightTwo);
    });

    it('carries a puuid through when presence happened to know one', () => {
        const sessions = sessionisePresence(
            [
                event('voice.joined', 'a', T0, { puuid: 'puuid-a' }),
                event('voice.left', 'a', T0 + HOUR, { puuid: 'puuid-a' }),
            ],
            { now: NOW }
        );

        expect(sessions[0].participants[0].puuid).toBe('puuid-a');
    });

    // DN-3 is unbuilt, so most presence has no puuid. That must not exclude
    // anyone: the friend who was in the call all night without playing is
    // precisely the person whose presence the recap needs.
    it('includes a participant with no puuid at all', () => {
        const sessions = sessionisePresence(
            [
                event('voice.joined', 'a', T0),
                event('voice.left', 'a', T0 + HOUR),
            ],
            { now: NOW }
        );

        expect(sessions[0].participants).toHaveLength(1);
        expect(sessions[0].participants[0].puuid).toBeNull();
    });

    it('has no sessions for a squad that never used voice', () => {
        expect(sessionisePresence([], { now: NOW })).toEqual([]);
    });
});

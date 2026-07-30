/**
 * Turning presence events into nights (DN-6).
 *
 * Deliberately pure: it takes rows and returns sessions, touching no database
 * and reading no clock it was not handed. The sessionising rules are judgement
 * calls - how long a gap ends a night, whether a lone person in voice counts -
 * and judgement calls need to be cheap to test and cheap to change. Persistence
 * lives in `sessionService`.
 *
 * WHY VOICE DEFINES THE SESSION AND NOT MATCHES
 *
 * A night is a social unit, not a queue history. It starts when people turn up
 * and ends when the last one leaves, and it contains the games that happened in
 * between - including the stretch where nobody was playing, which is exactly the
 * part a match-derived session would throw away. "Longest voice silence: 4m12s
 * during game 6" is only computable this way round.
 *
 * That also means a squad that never uses voice has no sessions, which is
 * correct: there is nothing here a match-history tracker could not already tell
 * them, and the whole claim of this feature is the voice dimension.
 */

import type { PresenceEventRow } from '../presence/presenceService';

/** A single visit to a voice channel. `leftAt` null means still in it. */
export interface VoiceInterval {
    meepsUserId: string;
    puuid: string | null;
    channelId: string | null;
    joinedAt: number;
    leftAt: number | null;
}

export interface DerivedParticipant {
    meepsUserId: string;
    puuid: string | null;
    firstJoinedAt: number;
    lastLeftAt: number | null;
    voiceSeconds: number;
    /** Separate visits. "Left after game 5 and came back" needs more than 1. */
    intervalCount: number;
}

export interface DerivedSession {
    startedAt: number;
    /** Null while somebody is still in voice. A live night is a real state. */
    endedAt: number | null;
    participants: DerivedParticipant[];
    /** Most people in voice at once - "five of you" on the recap card. */
    peakConcurrent: number;
    /** Summed across participants, so two people for an hour is 7200. */
    voiceSeconds: number;
}

export interface SessioniseOptions {
    /**
     * How long a squad can have nobody in voice before the night is over.
     *
     * 45 minutes. Long enough to survive a dinner break, a queue dodge, or the
     * gap between "we're done" and someone starting one more game; short enough
     * that Tuesday and Wednesday never merge into one 30-hour session. The exact
     * figure is a guess that should be revisited against real data - which is
     * why this table is derived and rebuildable.
     */
    idleGapMs?: number;
    /**
     * Now, for measuring intervals that have not closed. Passed in rather than
     * read so that a test can describe a live session without being flaky.
     */
    now?: number;
}

export const DEFAULT_IDLE_GAP_MS = 45 * 60 * 1000;

/**
 * Pair `voice.joined` with `voice.left` into intervals.
 *
 * Keyed on user + channel, because the same person can be in two channels and
 * those are two intervals. Events must arrive in time order.
 *
 * Two malformed shapes are possible and both are handled rather than trusted:
 *
 * - **A leave with no join.** Ordinary at the start of any backfill window: the
 *   join happened before the window. Ignored, because inventing a start time
 *   would fabricate voice duration, and over-reporting how long people spent in
 *   a call is the one error this feature cannot afford.
 * - **A second join while already open.** The unique index on Meeps' side makes
 *   this near-impossible, but a re-keyed backfill could produce it. The first
 *   join wins; the duplicate is dropped rather than opening a second overlapping
 *   interval, which would double the duration.
 */
export function toIntervals(events: PresenceEventRow[]): VoiceInterval[] {
    const open = new Map<string, VoiceInterval>();
    const closed: VoiceInterval[] = [];

    // U+0000 as the separator, written as an escape: it cannot occur in a user
    // or channel id, so no pair of real ids can collide into one key.
    const key = (userId: string, channelId: string | null) =>
        `${userId}\u0000${channelId ?? ''}`;

    for (const event of events) {
        if (event.type !== 'voice.joined' && event.type !== 'voice.left') {
            continue;
        }
        const at = new Date(event.occurred_at).getTime();
        if (Number.isNaN(at)) continue;

        const k = key(event.meeps_user_id, event.channel_id);

        if (event.type === 'voice.joined') {
            if (open.has(k)) continue; // already in this channel; not a new visit
            open.set(k, {
                meepsUserId: event.meeps_user_id,
                puuid: event.puuid,
                channelId: event.channel_id,
                joinedAt: at,
                leftAt: null,
            });
            continue;
        }

        const interval = open.get(k);
        if (!interval) continue; // leave with no join - see the note above
        // A leave that predates its join is nonsense; clamp rather than emit a
        // negative duration that would silently subtract from a total.
        interval.leftAt = Math.max(at, interval.joinedAt);
        // Prefer any puuid we learn later over none at all.
        interval.puuid = interval.puuid ?? event.puuid;
        closed.push(interval);
        open.delete(k);
    }

    // Still-open intervals are people currently in voice, and they are what makes
    // a session live rather than finished.
    return [...closed, ...open.values()].sort(
        (a, b) => a.joinedAt - b.joinedAt
    );
}

/**
 * Group intervals into nights.
 *
 * A session runs while at least one person is in voice, and survives a gap
 * shorter than `idleGapMs`. The comparison is against the session's running
 * maximum end, not the previous interval's - otherwise one person staying in
 * voice all evening while others come and go would be split into a session per
 * arrival.
 */
export function groupIntoSessions(
    intervals: VoiceInterval[],
    options: SessioniseOptions = {}
): VoiceInterval[][] {
    const idleGapMs = options.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
    const sorted = [...intervals].sort((a, b) => a.joinedAt - b.joinedAt);

    const groups: VoiceInterval[][] = [];
    let current: VoiceInterval[] = [];
    let runningEnd = -Infinity;

    for (const interval of sorted) {
        // An open interval has no end yet, so nothing can be idle after it.
        const end = interval.leftAt ?? Infinity;

        if (
            current.length === 0 ||
            interval.joinedAt - runningEnd <= idleGapMs
        ) {
            current.push(interval);
            runningEnd = Math.max(runningEnd, end);
            continue;
        }

        groups.push(current);
        current = [interval];
        runningEnd = end;
    }

    if (current.length > 0) groups.push(current);
    return groups;
}

/** Most people in voice simultaneously, by sweeping interval endpoints. */
function peakConcurrent(intervals: VoiceInterval[], now: number): number {
    const points: Array<{ at: number; delta: number }> = [];
    for (const interval of intervals) {
        points.push({ at: interval.joinedAt, delta: 1 });
        points.push({ at: interval.leftAt ?? now, delta: -1 });
    }
    // Leaves settle before joins at the same instant: one person leaving as
    // another arrives is one person in voice, not two.
    points.sort((a, b) => a.at - b.at || a.delta - b.delta);

    let peak = 0;
    let live = 0;
    for (const point of points) {
        live += point.delta;
        if (live > peak) peak = live;
    }
    return peak;
}

function summariseParticipants(
    intervals: VoiceInterval[],
    now: number
): DerivedParticipant[] {
    const byUser = new Map<string, DerivedParticipant>();

    for (const interval of intervals) {
        const end = interval.leftAt ?? now;
        const seconds = Math.max(
            0,
            Math.round((end - interval.joinedAt) / 1000)
        );

        const existing = byUser.get(interval.meepsUserId);
        if (!existing) {
            byUser.set(interval.meepsUserId, {
                meepsUserId: interval.meepsUserId,
                puuid: interval.puuid,
                firstJoinedAt: interval.joinedAt,
                lastLeftAt: interval.leftAt,
                voiceSeconds: seconds,
                intervalCount: 1,
            });
            continue;
        }

        existing.firstJoinedAt = Math.min(
            existing.firstJoinedAt,
            interval.joinedAt
        );
        // An open interval keeps `lastLeftAt` null: this person has not left.
        existing.lastLeftAt =
            existing.lastLeftAt === null || interval.leftAt === null
                ? null
                : Math.max(existing.lastLeftAt, interval.leftAt);
        existing.voiceSeconds += seconds;
        existing.intervalCount += 1;
        existing.puuid = existing.puuid ?? interval.puuid;
    }

    return [...byUser.values()].sort(
        (a, b) => a.firstJoinedAt - b.firstJoinedAt
    );
}

/**
 * Presence events for one squad, in time order, into that squad's nights.
 *
 * Match attachment is not done here: it needs `match_details` and therefore a
 * database, so it lives in `sessionService`. This function answers only "when
 * was this group together, and for how long".
 */
export function sessionisePresence(
    events: PresenceEventRow[],
    options: SessioniseOptions = {}
): DerivedSession[] {
    const now = options.now ?? Date.now();
    const groups = groupIntoSessions(toIntervals(events), options);

    return groups.map((intervals) => {
        const participants = summariseParticipants(intervals, now);
        const anyOpen = intervals.some((i) => i.leftAt === null);

        return {
            startedAt: Math.min(...intervals.map((i) => i.joinedAt)),
            endedAt: anyOpen
                ? null
                : Math.max(...intervals.map((i) => i.leftAt as number)),
            participants,
            peakConcurrent: peakConcurrent(intervals, now),
            voiceSeconds: participants.reduce(
                (total, p) => total + p.voiceSeconds,
                0
            ),
        };
    });
}

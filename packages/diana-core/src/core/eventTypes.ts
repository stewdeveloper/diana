/**
 * The Diana event contract (DN-1).
 *
 * `MessagePayload` in ./pluginTypes.ts is presentation-shaped: it describes an
 * embed to render. These events are the opposite — they describe *what
 * happened*, so a consumer can store them as rows and compute things Diana
 * never rendered (session recaps, per-squad curves, wrapped cards).
 *
 * Both paths run side by side. Discord keeps receiving `MessagePayload` and its
 * output is unchanged; Meeps additionally receives these events.
 *
 * IDEMPOTENCY
 * Every event carries a deterministic `eventId` derived from the domain, never
 * a random UUID. The poller cron is only accidentally idempotent (it relies on
 * `ON CONFLICT DO NOTHING` when writing matches), and the transport retries on
 * failure — so the same event can legitimately be delivered more than once.
 * A deterministic key plus `ON CONFLICT (event_id) DO NOTHING` on the consumer
 * makes redelivery provably safe. Use the builders at the bottom of this file;
 * do not hand-assemble ids.
 */

export type DianaEventType =
    | 'match.completed'
    | 'rank.changed'
    | 'streak'
    | 'milestone'
    | 'digest.weekly'
    | 'rotation.weekly';

export interface DianaEventBase {
    /** Deterministic idempotency key. See the builders below. */
    eventId: string;
    type: DianaEventType;
    /** ISO 8601. When the thing happened, not when we noticed it. */
    occurredAt: string;
    /**
     * Discord guild the event was posted for.
     *
     * Present only on events that are inherently about a Discord destination
     * (the weekly digest and rotation posts). Prefer `squadId` for anything that
     * is a fact about the group rather than about where it was announced.
     */
    guildId?: string;
    /**
     * The portable scope (DN-2). A squad is reachable from a Discord guild and a
     * Meeps space at once, so this is the id joint features aggregate on.
     */
    squadId?: string;
}

export interface MatchCompletedEvent extends DianaEventBase {
    type: 'match.completed';
    matchId: string;
    puuid: string;
    summonerName: string;
    queueId?: number;
    queueName: string;
    /** Riot's raw gameMode, e.g. 'CLASSIC', 'ARAM', 'CHERRY'. */
    gameMode?: string;
    /** Arena (gameMode CHERRY). Never scored, never counts toward competition. */
    isArena?: boolean;
    /**
     * Whether this match counts toward competitive stats under the widest
     * scope ('all' - i.e. everything except Arena). Guilds set to 'ranked' will
     * count fewer; consumers can narrow further using `queueId`.
     */
    countsForCompetition?: boolean;
    /** Arena only: Riot's real placement, 1st-8th. */
    subteamPlacement?: number;
    championName: string;
    role?: string;
    /** 'Win' | 'Lose' | 'Remake', as rendered. */
    result: string;
    win: boolean;
    kills: number;
    deaths: number;
    assists: number;
    damage: number;
    gameDurationSeconds: number;
    /** Diana's per-match score for this player, when scoring succeeded. */
    aiScore?: number;
    /** 1-based rank of this player among all scored players in the lobby. */
    placement?: number;
    totalPlayers?: number;
    lpChange?: number | null;
    rankAfter?: string;
}

export interface RankChangedEvent extends DianaEventBase {
    type: 'rank.changed';
    matchId: string;
    puuid: string;
    summonerName: string;
    direction: 'promoted' | 'demoted';
    rankAfter: string;
    lpChange?: number | null;
}

export interface StreakEvent extends DianaEventBase {
    type: 'streak';
    matchId: string;
    puuid: string;
    summonerName: string;
    kind: 'win' | 'loss';
    length: number;
    /**
     * Which queues this streak counted. Events fire once per match, not per
     * guild, so this is always 'all' (every queue except Arena) even when
     * individual guilds are set to 'ranked' and see a different streak.
     */
    competitiveScope?: 'all' | 'ranked';
}

export interface MilestoneEvent extends DianaEventBase {
    type: 'milestone';
    matchId: string;
    puuid: string;
    summonerName: string;
    milestone: 'new_peak' | 'first_time_tier';
    rankAfter: string;
}

export interface WeeklyDigestEvent extends DianaEventBase {
    type: 'digest.weekly';
    /** ISO year-week the digest covers, e.g. "2026-W30". */
    isoWeek: string;
}

export interface RotationPostEvent extends DianaEventBase {
    type: 'rotation.weekly';
    isoWeek: string;
    championNames: string[];
}

export type DianaEvent =
    | MatchCompletedEvent
    | RankChangedEvent
    | StreakEvent
    | MilestoneEvent
    | WeeklyDigestEvent
    | RotationPostEvent;

/**
 * Emits events to a downstream consumer (Meeps today).
 *
 * Implementations MUST NOT throw: a consumer being unreachable must never break
 * Discord posting. Swallow, log, and move on.
 */
export interface EventAdapter {
    emit(event: DianaEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Deterministic event id builders
// ---------------------------------------------------------------------------

/**
 * Per-squad, per-match, per-player events. The (squadId, matchId, puuid) triple
 * is the natural key: a given player finishes a given match exactly once for a
 * given squad, however many times the poller sees it.
 *
 * The squad is part of the key because one player can be on several squads, and
 * each needs its own row - a session recap for squad A must not be assembled
 * from squad B's copy of the same match.
 */
export function buildMatchScopedEventId(
    type: Extract<
        DianaEventType,
        'match.completed' | 'rank.changed' | 'streak' | 'milestone'
    >,
    squadId: string,
    matchId: string,
    puuid: string
): string {
    return `${type}:${squadId}:${matchId}:${puuid}`;
}

/**
 * Recurring per-squad posts. Keyed on the period they cover rather than the
 * time they were sent, so a retry — or a redeploy that re-runs the cron within
 * the same week — cannot produce a second row.
 *
 * Keyed on squad rather than guild, so two Discord guilds attached to one squad
 * produce two posts and one event row: two destinations, one fact.
 */
export function buildPeriodicEventId(
    type: Extract<DianaEventType, 'digest.weekly' | 'rotation.weekly'>,
    squadId: string,
    isoWeek: string
): string {
    return `${type}:${squadId}:${isoWeek}`;
}

/**
 * ISO-8601 year-week for a date, e.g. "2026-W30".
 *
 * ISO weeks start on Monday and week 1 is the week containing the first
 * Thursday of the year, so this is not simply `ceil(dayOfYear / 7)`.
 */
export function toIsoWeek(date: Date): string {
    // Work in UTC on a copy so callers' dates are untouched.
    const d = new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    );
    // Shift to the Thursday of this ISO week; that day's year is the ISO year.
    const dayNum = d.getUTCDay() || 7; // Sunday 0 -> 7
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const isoYear = d.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const weekNo = Math.ceil(
        ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
    );
    return `${isoYear}-W${String(weekNo).padStart(2, '0')}`;
}

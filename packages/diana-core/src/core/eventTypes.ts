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
    | 'rotation.weekly'
    | 'session.completed';

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

/** One named player and the number that earned them the slot. */
export interface WeeklyDigestAward {
    /** Display name as rendered, e.g. "Player#EUW". */
    name: string;
    /**
     * The award's figure, in the unit its slot implies: LP for climber and
     * faller (signed), games for the grinder, AI score for the rest. Rounded to
     * the value Discord shows, so both renderings agree.
     */
    value: number;
}

/**
 * The digest as numbers rather than as an embed.
 *
 * The Discord post has always computed these and then flattened them into
 * markdown strings ("🧗 **Climber of the Week**" / "Player#EUW (**+42 LP**)"),
 * which is unparseable by anything downstream. Carrying the same figures
 * structurally is what lets Meeps draw its own digest card — the point of the
 * event contract is that a consumer receives data and decides how to show it.
 *
 * Every award is optional and for the same reason it is optional in the embed:
 * a week with no ranked movement has no climber, and a week where nothing was
 * scored has no MVP. Absent means "not awarded this week", never "unknown".
 */
export interface WeeklyDigestStats {
    totalGames: number;
    playerCount: number;
    climber?: WeeklyDigestAward;
    faller?: WeeklyDigestAward;
    grinder?: WeeklyDigestAward;
    mvp?: WeeklyDigestAward;
    inter?: WeeklyDigestAward;
    bestGame?: WeeklyDigestAward;
    worstGame?: WeeklyDigestAward;
}

export interface WeeklyDigestEvent extends DianaEventBase {
    type: 'digest.weekly';
    /** ISO year-week the digest covers, e.g. "2026-W30". */
    isoWeek: string;
    /**
     * Optional because events emitted before this field existed have none, and
     * consumers read historical rows. A card with no `stats` should degrade to
     * the week label rather than fail.
     */
    stats?: WeeklyDigestStats;
}

export interface RotationPostEvent extends DianaEventBase {
    type: 'rotation.weekly';
    isoWeek: string;
    championNames: string[];
}

/** One person's presence during a night. */
export interface SessionParticipantSummary {
    /**
     * Meeps' own user id. Diana never learns a display name, and does not need
     * one: Meeps resolves this against its own users when it renders the card.
     * That is why the recap does not wait on DN-3.
     */
    meepsUserId: string;
    /**
     * Populated only where a presence event happened to carry it. Stays mostly
     * null until DN-3 makes a Meeps user's Riot account authoritative, at which
     * point this is what joins a participant to their games.
     */
    puuid: string | null;
    firstJoinedAt: string;
    /**
     * Null means "never left", which on a completed session can only happen if
     * presence was truncated. Consumers should treat it as "unknown", not "now".
     */
    lastLeftAt: string | null;
    voiceSeconds: number;
    /** Separate visits. "Left after game 5 and came back" needs more than one. */
    intervalCount: number;
}

/** One game played during a night, in the order it was played. */
export interface SessionMatchSummary {
    matchId: string;
    /** 1-based ordinal within the session: "you were 3-1 after game 5". */
    gameIndex: number;
    startedAt: string;
    endedAt: string | null;
    queueId: number | null;
    /**
     * Null when the squad's own players disagree - a custom or an Arena lobby
     * with tracked players on both sides. Not a loss.
     */
    win: boolean | null;
}

/** The night's best individual performance. */
export interface SessionStandout {
    matchId: string;
    gameIndex: number;
    puuid: string;
    /** Display name as rendered, e.g. "Player#EUW". */
    summonerName: string;
    /** Null when the match row did not yield one. */
    championName: string | null;
    aiScore: number;
    /** 1-based rank within the lobby, when scoring produced one. */
    placement: number | null;
}

/**
 * The night's worst *game* - deliberately not its worst player.
 *
 * `WeeklyDigestStats` also has a `worstGame`, and it is a `WeeklyDigestAward`
 * naming a person. This one names a match and carries no `name` at all. The
 * asymmetry is intentional, so the shapes are made obviously different rather
 * than subtly so.
 *
 * A digest ranks individuals across a week; being named is the point of a
 * leaderboard. A session recap is one evening that five people had together and
 * read together, and naming the worst player of the night to the people who were
 * there every night is a meaner product than naming the game that went badly for
 * everyone. Roadmap §8.1's ethic - banter between friends, a weapon between
 * acquaintances - was written about the Session Curve and applies here too.
 */
export interface SessionLowPoint {
    matchId: string;
    gameIndex: number;
    /** Mean AI score across the squad's players in that game. */
    meanAiScore: number;
}

/**
 * A night is over: everybody left voice and nobody came back.
 *
 * Emitted by the recap sweep once a session has settled, which is later than it
 * ended - see `recapSweep.ts` for why silence can only be observed by a timer.
 *
 * Facts only. Meeps composes the sentence, so the wording of a recap can change
 * without a Diana deploy.
 */
export interface SessionCompletedEvent extends DianaEventBase {
    type: 'session.completed';
    sessionId: string;
    startedAt: string;
    /** Never null: an unfinished night is not a completed session. */
    endedAt: string;
    /** Wall clock, `endedAt - startedAt`. "5 hrs 28 min" on the card. */
    durationSeconds: number;
    /**
     * Summed across people, so three of them for two hours is 21600, not 7200.
     * Carried alongside `durationSeconds` because it is a different number and
     * neither is derivable from the other.
     */
    voiceSeconds: number;
    participantCount: number;
    /** Most people in voice at once - "five of you". */
    peakConcurrent: number;
    matchCount: number;
    wins: number;
    losses: number;
    participants: SessionParticipantSummary[];
    matches: SessionMatchSummary[];
    /**
     * Optional in the sense `WeeklyDigestStats` established: absent means "not
     * awarded", never "unknown". A night with no scored games has neither.
     */
    bestGame?: SessionStandout;
    worstGame?: SessionLowPoint;
}

export type DianaEvent =
    | MatchCompletedEvent
    | RankChangedEvent
    | StreakEvent
    | MilestoneEvent
    | WeeklyDigestEvent
    | RotationPostEvent
    | SessionCompletedEvent;

/**
 * Emits events to a downstream consumer (Meeps today).
 *
 * Implementations MUST NOT throw: a consumer being unreachable must never break
 * Discord posting. Swallow, log, and move on.
 *
 * RETURNS WHETHER THE EVENT WAS DELIVERED
 * Most callers ignore this, and should: a match post is emitted once as a side
 * effect of the poller, and there is nothing useful to do about a failure. The
 * recap sweep is the exception - it records that a night has been announced, and
 * recording that against an event that never arrived loses the recap silently
 * and permanently. It marks only on `true`, and retries on the next tick
 * otherwise, which is safe because the event id is deterministic.
 */
export interface EventAdapter {
    emit(event: DianaEvent): Promise<boolean>;
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
 * One night, one recap.
 *
 * Keyed on `(squadId, startedAt)` and deliberately **not** on `session_id`: that
 * column is `gen_random_uuid()`, which is exactly the random key the header of
 * this file forbids. `(squad_id, started_at)` is already the `sessions` table's
 * UNIQUE constraint, so it identifies the same night across every rebuild - and
 * a rebuild is expected, because the table is derived.
 *
 * `startedAt` is normalised through `Date` rather than trusted as given. The
 * driver may hand back a `Date` or a string depending on how it is configured,
 * and two spellings of one instant would key one night as two.
 */
export function buildSessionEventId(
    squadId: string,
    startedAt: string | Date
): string {
    return `session.completed:${squadId}:${new Date(startedAt).toISOString()}`;
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

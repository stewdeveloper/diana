/**
 * When to spend an r6data call on a player.
 *
 * Pure functions, no I/O: this is the half of the poller worth having tests for,
 * and the half whose arithmetic has a hard external constraint behind it — see
 * `../api/utils/r6Budget.ts` for why 3,000 calls a month across 3 players rules
 * out every fixed cron interval that would resolve single matches.
 *
 * THE SHAPE
 *
 * The cron becomes a fast heartbeat (every 5 minutes) that decides nothing on
 * its own. Each tick asks, per player, whether that player is due — and a
 * player is due when the interval for their current state has elapsed since the
 * last call spent on them. Two states:
 *
 *   active — something moved within the last `ACTIVE_WINDOW_MINUTES`, so the
 *            player is probably mid-session: poll every `ACTIVE_POLL_MINUTES`,
 *            which is narrow enough that a completed match usually shows up as
 *            a diff of exactly one and renders as a match card.
 *
 *   idle   — nothing has moved lately: poll every `IDLE_POLL_MINUTES`, purely so
 *            that a session starting is noticed at all. This is a floor cost
 *            paid every day whether anybody plays or not, which is why it is
 *            hours rather than minutes.
 *
 * Both intervals are then stretched by budget pressure, so the month cannot be
 * overspent by somebody having an unusually good week.
 *
 * WHAT THE IDLE INTERVAL COSTS, AND WHAT IT BUYS
 *
 * The whole allowance is ~950 polls per player per month (2,850 usable / 3).
 * A 3-hour idle interval spends 8 of those a day — 240 a month, a quarter of the
 * budget — and leaves ~710 for sessions. At ~48 polls per three-hour evening (36
 * inside it, 12 in the closing window) that is roughly 14 evenings a player a
 * month before pressure starts widening things, which is about what three people
 * actually play.
 *
 * Spread evenly instead of concentrated into evenings it is about two hours a
 * day, because the idle floor is paid either way — so the same monthly hours cost
 * more when they are sprinkled across every afternoon than when they arrive in
 * blocks. Past that, budget pressure widens the intervals; the plan is not
 * exceeded, the cadence just loosens.
 *
 * The thing it buys is session *detection*: the first match after a quiet
 * stretch is found up to `IDLE_POLL_MINUTES` late, so the matches inside that
 * first window arrive as one `r6.session.completed` rather than as cards. That
 * is not a defect to be engineered away — a window that spanned several matches
 * genuinely cannot be resolved into them, and the session message is the honest
 * rendering of it. Shortening the idle interval trades evenings of coverage for
 * a faster first detection; it is one number, and it is in the plugin config.
 */

/** Poll interval while a player looks mid-session. */
export const ACTIVE_POLL_MINUTES = 5;

/** Poll interval while nothing has moved. */
export const IDLE_POLL_MINUTES = 180;

/**
 * How long movement keeps a player in the active state.
 *
 * Sized off the gap between two consecutive matches, not off a match: 25-35
 * minutes of play, a few minutes of queue, plus however long r6data takes to
 * reflect the result. An hour covers that with room, and covers a short break
 * without reopening the window from scratch.
 */
export const ACTIVE_WINDOW_MINUTES = 60;

const MINUTE_MS = 60_000;

/** The subset of an `r6_players` row the scheduler reads. */
export interface R6PollState {
    lastPolledAt: Date | string | null;
    activeUntil: Date | string | null;
}

export interface R6PollCadence {
    activePollMinutes: number;
    idlePollMinutes: number;
    activeWindowMinutes: number;
}

export const DEFAULT_R6_POLL_CADENCE: R6PollCadence = {
    activePollMinutes: ACTIVE_POLL_MINUTES,
    idlePollMinutes: IDLE_POLL_MINUTES,
    activeWindowMinutes: ACTIVE_WINDOW_MINUTES,
};

/**
 * `null` and unparseable values both become null rather than `Invalid Date`.
 *
 * The driver hands timestamps back as a `Date` or as a string depending on how
 * it is configured, and an `Invalid Date` compared with `>=` is silently false —
 * which for `lastPolledAt` would mean "not due", i.e. a player who quietly stops
 * being polled at all. Null is the safe reading of "we do not know", and null
 * means due.
 */
function toDate(value: Date | string | null | undefined): Date | null {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** Is this player inside their active window at `now`? */
export function isActive(state: R6PollState, now: Date): boolean {
    const until = toDate(state.activeUntil);
    return until !== null && until.getTime() > now.getTime();
}

/**
 * The interval this player is on, before budget pressure.
 */
export function pollIntervalMinutes(
    state: R6PollState,
    now: Date,
    cadence: R6PollCadence = DEFAULT_R6_POLL_CADENCE
): number {
    return isActive(state, now)
        ? cadence.activePollMinutes
        : cadence.idlePollMinutes;
}

/**
 * Should this tick spend a call on this player?
 *
 * `pressure` comes from the budget ledger and multiplies the interval: at 1 the
 * cadence above is used as written, at 2 everything is polled half as often.
 * Never polled (`lastPolledAt === null`) is always due — a player added between
 * ticks should not wait out an idle interval before their first reading.
 */
export function isDueForPoll(
    state: R6PollState,
    now: Date,
    pressure = 1,
    cadence: R6PollCadence = DEFAULT_R6_POLL_CADENCE
): boolean {
    const last = toDate(state.lastPolledAt);
    if (last === null) return true;

    const interval =
        pollIntervalMinutes(state, now, cadence) * Math.max(1, pressure);
    return now.getTime() - last.getTime() >= interval * MINUTE_MS;
}

/**
 * Where the active window should sit after a poll.
 *
 * Movement extends it from `now`, so a session stays covered for as long as it
 * keeps producing matches. A quiet poll leaves it alone rather than shortening
 * it: the window is "how long since something happened", and a poll that found
 * nothing is not information about when the last thing happened.
 */
export function nextActiveUntil(
    state: R6PollState,
    moved: boolean,
    now: Date,
    cadence: R6PollCadence = DEFAULT_R6_POLL_CADENCE
): Date | null {
    if (moved) {
        return new Date(
            now.getTime() + cadence.activeWindowMinutes * MINUTE_MS
        );
    }
    return toDate(state.activeUntil);
}

/**
 * Which of `players` this tick may poll, and in what order.
 *
 * Ordered by how overdue each player is, so a budget that runs out partway down
 * the list starves the player who was polled most recently rather than an
 * arbitrary one. `limit` is how many calls the tick is allowed to issue — the
 * poller passes the budget's remaining figure, so the last tick of an exhausted
 * month polls a few players rather than failing every request.
 */
export function selectPlayersToPoll<T extends R6PollState>(
    players: readonly T[],
    now: Date,
    pressure = 1,
    limit = Number.POSITIVE_INFINITY,
    cadence: R6PollCadence = DEFAULT_R6_POLL_CADENCE
): T[] {
    if (limit <= 0) return [];

    const due = players.filter((player) =>
        isDueForPoll(player, now, pressure, cadence)
    );

    const overdueBy = (player: T): number => {
        const last = toDate(player.lastPolledAt);
        if (last === null) return Number.POSITIVE_INFINITY;
        return now.getTime() - last.getTime();
    };

    return due
        .sort((a, b) => overdueBy(b) - overdueBy(a))
        .slice(0, Math.floor(limit));
}

/**
 * Sanity figure for the logs and for the plugin's config help: what one player
 * costs a month at a given cadence, assuming `activeHoursPerDay` of play.
 *
 * Exported because the numbers in this file's header are only checkable if
 * something computes them, and a test that pins the model is how a future
 * cadence change is stopped from quietly going 3x over the plan.
 */
export function estimatedMonthlyCallsPerPlayer(
    activeHoursPerDay: number,
    cadence: R6PollCadence = DEFAULT_R6_POLL_CADENCE,
    daysPerMonth = 30
): number {
    const activeMinutesPerDay = Math.max(0, activeHoursPerDay) * 60;
    const idleMinutesPerDay = Math.max(0, 24 * 60 - activeMinutesPerDay);
    const perDay =
        activeMinutesPerDay / cadence.activePollMinutes +
        idleMinutesPerDay / cadence.idlePollMinutes;
    return Math.round(perDay * daysPerMonth);
}

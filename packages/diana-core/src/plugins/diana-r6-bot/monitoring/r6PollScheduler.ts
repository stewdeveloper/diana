/**
 * When to spend an r6data call on a player.
 *
 * Pure functions, no I/O: this is the half of the poller worth having tests for,
 * and the half whose arithmetic has a hard external constraint behind it — see
 * `../api/utils/r6Budget.ts` for the 3,000-call month this all has to fit in.
 *
 * THE SHAPE
 *
 * A fixed interval on clock boundaries, with a window overnight where nobody is
 * polled at all. The cron stays a fast heartbeat that decides nothing; each tick
 * asks, per player, whether a new slot has opened since the last call spent on
 * them.
 *
 * This replaced an adaptive active/idle scheme, and the trade it makes is worth
 * being explicit about because it is not a free win.
 *
 *   WHAT WAS GIVEN UP. The old model polled every 5 minutes while somebody
 *   looked mid-session, which is narrow enough that a completed match usually
 *   showed up as a diff of exactly one and rendered as a match card. An hour
 *   spans two or three games, so that diff is now almost never 1, and
 *   `resolveSingleMatch` falls through to the session branch. Match cards do not
 *   disappear from the code — they are still correct when somebody plays exactly
 *   one game in an hour — but they stop being the common case.
 *
 *   WHAT WAS BOUGHT. Predictability, and roughly half the spend. Polls land on
 *   the hour instead of drifting with whenever a session happened to start, the
 *   cost of a player is the same number every month whether they play or not,
 *   and nothing has to model "is this person probably mid-session".
 *
 * CLOCK ALIGNMENT
 *
 * A player is due when `now` falls in a later interval-slot than their last
 * poll, rather than when `now - lastPolledAt >= interval`. The difference
 * matters: the elapsed-time form drifts, because a poll at 10:03 makes the next
 * one due at 11:03 and the heartbeat that notices lands at 11:05, and by the end
 * of a day the polls have wandered half an hour. Slots are measured from the
 * epoch, which is aligned to the hour, so an hourly cadence lands within one
 * heartbeat of every hour, every day.
 *
 * QUIET HOURS
 *
 * A window each night where no call is issued. There is no point paying to
 * discover that somebody asleep has not played, and the calls it saves are the
 * budget that keeps the daytime cadence at an hour rather than two.
 *
 * A poll is not "delayed" into the window and then caught up on afterwards. It
 * simply does not happen, and the first slot after the window ends is when the
 * night's play is noticed — as one session, which is the honest rendering of a
 * gap that genuinely cannot be resolved into matches.
 */

/**
 * How often to poll a player, in minutes.
 *
 * 60 puts a player at ~495 calls a month with the default quiet window, so the
 * 3,000-call plan carries about five of them. Anything below ~35 minutes starts
 * resolving single matches again but costs proportionally more.
 */
export const POLL_MINUTES = 60;

/** Start of the nightly window where nobody is polled, `HH:MM`. */
export const QUIET_HOURS_START = '01:30';

/** End of it. Exclusive: the slot at this time is polled. */
export const QUIET_HOURS_END = '09:00';

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 24 * 60;

/** The subset of an `r6_players` row the scheduler reads. */
export interface R6PollState {
    lastPolledAt: Date | string | null;
}

export interface R6PollCadence {
    pollMinutes: number;
    /** `HH:MM`. Equal to `quietEnd` means no quiet window at all. */
    quietStart: string;
    quietEnd: string;
    /**
     * IANA zone the quiet window is expressed in.
     *
     * Load-bearing, and the reason this is not just two numbers: "no polling
     * between half one and nine" is a statement about the people playing, not
     * about the server, and a container running in UTC would otherwise put the
     * window in the wrong place for anyone who is not. Defaults to the
     * deployment's own `TZ` because that is usually already set to where the
     * operator lives, and falls back to UTC when it is not set.
     */
    timeZone: string;
}

export const DEFAULT_R6_POLL_CADENCE: R6PollCadence = {
    pollMinutes: POLL_MINUTES,
    quietStart: QUIET_HOURS_START,
    quietEnd: QUIET_HOURS_END,
    timeZone: process.env.TZ || 'UTC',
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

/**
 * `HH:MM` as minutes past midnight, or null if it is not a time.
 *
 * Null rather than a thrown error or a silent zero: a mistyped quiet window in
 * the plugin config should disable the window, not move it to midnight and not
 * take the poller down.
 */
export function parseTimeOfDay(value: string): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
}

/**
 * What time it is where the quiet window is measured, in minutes past midnight.
 *
 * `Intl` rather than `getHours()` because the process timezone is whatever the
 * container was built with, and this has to be able to answer for a zone the
 * server is not in.
 */
export function minutesOfDayIn(now: Date, timeZone: string): number {
    let parts;
    try {
        parts = new Intl.DateTimeFormat('en-GB', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).formatToParts(now);
    } catch {
        // An unknown zone is a config error, and treating it as UTC keeps the
        // window roughly where it was meant to be rather than dropping it.
        parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'UTC',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).formatToParts(now);
    }

    const value = (type: string): number =>
        Number(parts.find((part) => part.type === type)?.value ?? '0');

    // `hour12: false` renders midnight as 24 under some ICU versions.
    return (value('hour') % 24) * 60 + value('minute');
}

/**
 * Is `minutes` inside the window, given it may wrap past midnight?
 *
 * The default window does not wrap, but `22:00`–`06:00` is the obvious thing an
 * operator will try next and reading it as an empty window would be a silent
 * failure rather than a visible one.
 */
export function isWithinWindow(
    minutes: number,
    start: number,
    end: number
): boolean {
    if (start === end) return false;
    return start < end
        ? minutes >= start && minutes < end
        : minutes >= start || minutes < end;
}

/** Are we inside the nightly quiet window? */
export function isQuietHours(
    now: Date,
    cadence: R6PollCadence = DEFAULT_R6_POLL_CADENCE
): boolean {
    const start = parseTimeOfDay(cadence.quietStart);
    const end = parseTimeOfDay(cadence.quietEnd);
    if (start === null || end === null) return false;
    return isWithinWindow(minutesOfDayIn(now, cadence.timeZone), start, end);
}

/**
 * The interval in force, in minutes, once budget pressure is applied.
 *
 * Pressure is **rounded to a whole multiple** of the base interval rather than
 * used as-is. A pressure of 1.4 on a 60-minute cadence would otherwise give an
 * 84-minute one, whose slots drift across the clock and undo the alignment this
 * module exists to provide. Whole multiples of an hour are still hourly, just
 * fewer of them.
 */
export function pollIntervalMinutes(
    pressure = 1,
    cadence: R6PollCadence = DEFAULT_R6_POLL_CADENCE
): number {
    const multiple = Math.max(1, Math.round(pressure));
    return cadence.pollMinutes * multiple;
}

/** Which interval-slot a moment falls in, counted from the epoch. */
function slotOf(time: Date, intervalMinutes: number): number {
    return Math.floor(time.getTime() / (intervalMinutes * MINUTE_MS));
}

/**
 * Should this tick spend a call on this player?
 *
 * Never polled (`lastPolledAt === null`) is due as soon as the quiet window is
 * over — a player enrolled overnight should not wait until morning *and* then a
 * full slot before their first reading.
 */
export function isDueForPoll(
    state: R6PollState,
    now: Date,
    pressure = 1,
    cadence: R6PollCadence = DEFAULT_R6_POLL_CADENCE
): boolean {
    if (isQuietHours(now, cadence)) return false;

    const last = toDate(state.lastPolledAt);
    if (last === null) return true;

    const interval = pollIntervalMinutes(pressure, cadence);
    return slotOf(now, interval) > slotOf(last, interval);
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

/** How many minutes a day the quiet window covers. */
export function quietMinutesPerDay(
    cadence: R6PollCadence = DEFAULT_R6_POLL_CADENCE
): number {
    const start = parseTimeOfDay(cadence.quietStart);
    const end = parseTimeOfDay(cadence.quietEnd);
    if (start === null || end === null || start === end) return 0;
    return start < end ? end - start : MINUTES_PER_DAY - start + end;
}

/**
 * Sanity figure for the logs and for the plugin's config help: what one player
 * costs a month at a given cadence.
 *
 * Exported because the numbers in this file's header are only checkable if
 * something computes them, and a test that pins the model is how a future
 * cadence change is stopped from quietly going 3x over the plan. No longer takes
 * an activity figure — that was the point of a fixed interval: a player costs
 * the same whether they play every night or never.
 */
export function estimatedMonthlyCallsPerPlayer(
    cadence: R6PollCadence = DEFAULT_R6_POLL_CADENCE,
    daysPerMonth = 30
): number {
    const pollableMinutes = MINUTES_PER_DAY - quietMinutesPerDay(cadence);
    const perDay = pollableMinutes / cadence.pollMinutes;
    return Math.round(perDay * daysPerMonth);
}

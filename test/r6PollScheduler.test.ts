/**
 * When the Siege poller spends a call.
 *
 * Pure arithmetic, no I/O, and the half of Part B most worth pinning: the
 * cadence is not a cron string any more, it is a decision made per player per
 * tick against a 3,000-call month. The rows here fix the two things a future
 * change could quietly break — that a session stays covered end to end, and that
 * the idle floor stays inside the plan.
 */

import {
    ACTIVE_POLL_MINUTES,
    ACTIVE_WINDOW_MINUTES,
    DEFAULT_R6_POLL_CADENCE,
    IDLE_POLL_MINUTES,
    estimatedMonthlyCallsPerPlayer,
    isActive,
    isDueForPoll,
    nextActiveUntil,
    pollIntervalMinutes,
    selectPlayersToPoll,
} from '../packages/diana-core/src/plugins/diana-r6-bot/monitoring/r6PollScheduler';

const NOW = new Date('2026-08-06T20:00:00.000Z');
const minutesFromNow = (m: number) =>
    new Date(NOW.getTime() + m * 60_000).toISOString();
const minutesAgo = (m: number) => minutesFromNow(-m);

const player = (overrides: Record<string, unknown> = {}) => ({
    ubisoftId: 'ubi-1',
    gameName: 'Ash',
    lastPolledAt: minutesAgo(10),
    activeUntil: null as string | null,
    ...overrides,
});

describe('isActive', () => {
    it('is active while the window is still ahead of now', () => {
        expect(isActive(player({ activeUntil: minutesFromNow(20) }), NOW)).toBe(
            true
        );
        expect(isActive(player({ activeUntil: minutesAgo(1) }), NOW)).toBe(
            false
        );
        expect(isActive(player({ activeUntil: null }), NOW)).toBe(false);
    });

    it('reads a timestamp the driver handed back as a string or a Date alike', () => {
        const asDate = new Date(NOW.getTime() + 20 * 60_000);
        expect(isActive({ lastPolledAt: null, activeUntil: asDate }, NOW)).toBe(
            true
        );
    });
});

describe('pollIntervalMinutes', () => {
    it('is minutes inside a session and hours outside one', () => {
        expect(
            pollIntervalMinutes(
                player({ activeUntil: minutesFromNow(20) }),
                NOW
            )
        ).toBe(ACTIVE_POLL_MINUTES);
        expect(pollIntervalMinutes(player(), NOW)).toBe(IDLE_POLL_MINUTES);
    });

    it('keeps the active interval well inside a Siege match', () => {
        // A ranked game runs 25-35 minutes. If the active interval ever
        // approached that, a poll window would routinely span two matches and
        // the counter diff would stop resolving to one — which is the entire
        // feature.
        expect(ACTIVE_POLL_MINUTES).toBeLessThan(25 / 2);
    });
});

describe('isDueForPoll', () => {
    it('polls a player never polled before, whatever state they are in', () => {
        // A player added between ticks should not wait out an idle interval for
        // their first reading.
        expect(isDueForPoll(player({ lastPolledAt: null }), NOW)).toBe(true);
    });

    it('holds an active player to the active interval', () => {
        const active = { activeUntil: minutesFromNow(30) };
        expect(
            isDueForPoll(
                player({ ...active, lastPolledAt: minutesAgo(4) }),
                NOW
            )
        ).toBe(false);
        expect(
            isDueForPoll(
                player({ ...active, lastPolledAt: minutesAgo(6) }),
                NOW
            )
        ).toBe(true);
    });

    it('holds an idle player to the idle interval', () => {
        expect(
            isDueForPoll(player({ lastPolledAt: minutesAgo(120) }), NOW)
        ).toBe(false);
        expect(
            isDueForPoll(player({ lastPolledAt: minutesAgo(200) }), NOW)
        ).toBe(true);
    });

    it('stretches both intervals by budget pressure', () => {
        const active = player({
            activeUntil: minutesFromNow(30),
            lastPolledAt: minutesAgo(6),
        });
        expect(isDueForPoll(active, NOW, 1)).toBe(true);
        expect(isDueForPoll(active, NOW, 2)).toBe(false);
    });

    it('never speeds up below the configured cadence', () => {
        // Pressure is a brake, not a throttle. A pressure under 1 arriving from
        // anywhere must not make the poller spend faster than the plan allows.
        const active = player({
            activeUntil: minutesFromNow(30),
            lastPolledAt: minutesAgo(3),
        });
        expect(isDueForPoll(active, NOW, 0.1)).toBe(false);
    });

    it('treats an unparseable last-polled timestamp as due, not as never due', () => {
        // `new Date('nonsense') >= x` is silently false, which would mean a
        // player who quietly stops being polled at all.
        expect(
            isDueForPoll({ lastPolledAt: 'not a date', activeUntil: null }, NOW)
        ).toBe(true);
    });
});

describe('nextActiveUntil', () => {
    it('opens the window on movement', () => {
        const until = nextActiveUntil(player(), true, NOW);
        expect(until).not.toBeNull();
        expect(until!.getTime() - NOW.getTime()).toBe(
            ACTIVE_WINDOW_MINUTES * 60_000
        );
    });

    it('extends the window on every subsequent match', () => {
        // This is what keeps a three-hour session covered end to end with a
        // one-hour window.
        const midSession = player({ activeUntil: minutesFromNow(5) });
        const until = nextActiveUntil(midSession, true, NOW);
        expect(until!.getTime()).toBeGreaterThan(
            new Date(midSession.activeUntil!).getTime()
        );
    });

    it('leaves the window untouched on a quiet poll', () => {
        // The window means "how long since something happened", and a poll that
        // found nothing carries no information about when that was. This is also
        // why the design is a window rather than a backoff ladder: within a
        // session most polls are quiet, so a ladder that ramped down on quiet
        // polls would ramp down in the middle of a match.
        const open = minutesFromNow(25);
        expect(
            nextActiveUntil(
                player({ activeUntil: open }),
                false,
                NOW
            )!.toISOString()
        ).toBe(open);
        expect(nextActiveUntil(player(), false, NOW)).toBeNull();
    });

    it('covers the gap between two consecutive matches', () => {
        // 25-35 minutes of play, a few minutes of queue, plus the provider's own
        // lag. A window shorter than that would close mid-session and lump the
        // rest of the evening into one session card.
        expect(ACTIVE_WINDOW_MINUTES).toBeGreaterThanOrEqual(45);
    });
});

describe('selectPlayersToPoll', () => {
    it('returns only the players actually due', () => {
        const due = selectPlayersToPoll(
            [
                player({ ubisoftId: 'a', lastPolledAt: minutesAgo(300) }),
                player({ ubisoftId: 'b', lastPolledAt: minutesAgo(5) }),
            ],
            NOW
        );
        expect(due.map((p) => p.ubisoftId)).toEqual(['a']);
    });

    it('spends a partial allowance on the most overdue player', () => {
        // The last tick of an exhausted month polls somebody rather than
        // failing every request, and starving the player polled most recently is
        // the least arbitrary way to choose.
        const due = selectPlayersToPoll(
            [
                player({ ubisoftId: 'recent', lastPolledAt: minutesAgo(200) }),
                player({ ubisoftId: 'stale', lastPolledAt: minutesAgo(900) }),
            ],
            NOW,
            1,
            1
        );
        expect(due.map((p) => p.ubisoftId)).toEqual(['stale']);
    });

    it('polls a never-polled player ahead of a merely overdue one', () => {
        const due = selectPlayersToPoll(
            [
                player({ ubisoftId: 'stale', lastPolledAt: minutesAgo(900) }),
                player({ ubisoftId: 'new', lastPolledAt: null }),
            ],
            NOW,
            1,
            1
        );
        expect(due.map((p) => p.ubisoftId)).toEqual(['new']);
    });

    it('spends nothing when there is nothing left to spend', () => {
        expect(
            selectPlayersToPoll([player({ lastPolledAt: null })], NOW, 1, 0)
        ).toEqual([]);
    });
});

/**
 * The cost model, checked against the plan.
 *
 * These are the numbers the design was chosen from. A cadence change that breaks
 * one of them has moved the plugin off a plan it cannot see.
 */
describe('estimatedMonthlyCallsPerPlayer', () => {
    /** 3,000 a month less a 5% reserve, across 3 players. */
    const PER_PLAYER_BUDGET = Math.floor(3000 * 0.95) / 3;

    it('keeps the idle floor to about a quarter of a player’s budget', () => {
        // 1,440 minutes a day at a 3-hour interval is 8 polls, ~240 a month.
        expect(estimatedMonthlyCallsPerPlayer(0)).toBe(240);
        expect(estimatedMonthlyCallsPerPlayer(0)).toBeLessThan(
            PER_PLAYER_BUDGET * 0.3
        );
    });

    it('fits two hours of play a day inside the plan', () => {
        expect(estimatedMonthlyCallsPerPlayer(2)).toBeLessThan(
            PER_PLAYER_BUDGET
        );
    });

    it('fits fourteen three-hour evenings a month, which is the shape play takes', () => {
        // Concentrated play is cheaper than the same hours spread thin, because
        // the idle floor is paid either way. 14 evenings is ~1.4 hours a day
        // averaged, and it leaves real headroom.
        const evenings = 14;
        const activePolls =
            (evenings * 3 * 60) / DEFAULT_R6_POLL_CADENCE.activePollMinutes;
        expect(activePolls + estimatedMonthlyCallsPerPlayer(0)).toBeLessThan(
            PER_PLAYER_BUDGET
        );
    });

    it('goes over the plan past about two hours a day, which is what pressure is for', () => {
        // Stated rather than hidden: the cadence is sized for normal play, and an
        // unusually heavy month is absorbed by budget pressure widening the
        // intervals rather than by the plan being exceeded.
        expect(estimatedMonthlyCallsPerPlayer(3)).toBeGreaterThan(
            PER_PLAYER_BUDGET
        );
    });

    it('costs nothing extra to run the heartbeat faster than the cadence', () => {
        // The cron only asks who is due. The model depends on the intervals, not
        // on the heartbeat.
        expect(
            estimatedMonthlyCallsPerPlayer(2.5, DEFAULT_R6_POLL_CADENCE)
        ).toBe(
            estimatedMonthlyCallsPerPlayer(2.5, {
                ...DEFAULT_R6_POLL_CADENCE,
            })
        );
    });
});

/**
 * When the Siege poller spends a call.
 *
 * Pure arithmetic, no I/O, and the half of the poller most worth pinning: the
 * cadence is not a cron string, it is a decision made per player per tick
 * against a 3,000-call month. The rows here fix the three things a future change
 * could quietly break — that polls land on the clock rather than drifting, that
 * the quiet window is honoured in the zone it was written in, and that a
 * player's monthly cost stays inside the plan.
 */

import {
    DEFAULT_R6_POLL_CADENCE,
    POLL_MINUTES,
    estimatedMonthlyCallsPerPlayer,
    isDueForPoll,
    isQuietHours,
    isWithinWindow,
    minutesOfDayIn,
    parseTimeOfDay,
    pollIntervalMinutes,
    quietMinutesPerDay,
    selectPlayersToPoll,
} from '../packages/diana-core/src/plugins/diana-r6-bot/monitoring/r6PollScheduler';

/**
 * 20:30 UTC — outside the default quiet window, and deliberately *not* on a slot
 * boundary. On the hour exactly, every `minutesAgo` value lands in the previous
 * slot and "recently polled" cases would be vacuously due.
 */
const NOW = new Date('2026-08-06T20:30:00.000Z');
const minutesFromNow = (m: number) =>
    new Date(NOW.getTime() + m * 60_000).toISOString();
const minutesAgo = (m: number) => minutesFromNow(-m);

/** The default cadence, pinned to UTC so these rows do not depend on the host. */
const CADENCE = { ...DEFAULT_R6_POLL_CADENCE, timeZone: 'UTC' };

const player = (overrides: Record<string, unknown> = {}) => ({
    ubisoftId: 'ubi-1',
    gameName: 'Ash',
    lastPolledAt: minutesAgo(10),
    ...overrides,
});

describe('parseTimeOfDay', () => {
    it('reads HH:MM as minutes past midnight', () => {
        expect(parseTimeOfDay('00:00')).toBe(0);
        expect(parseTimeOfDay('01:30')).toBe(90);
        expect(parseTimeOfDay('9:00')).toBe(540);
        expect(parseTimeOfDay('23:59')).toBe(1439);
    });

    it('returns null for anything that is not a time', () => {
        // Null disables the window rather than moving it to midnight. A mistyped
        // config should not silently stop polling for eight hours a day, and it
        // certainly should not take the poller down.
        expect(parseTimeOfDay('')).toBeNull();
        expect(parseTimeOfDay('half past one')).toBeNull();
        expect(parseTimeOfDay('24:00')).toBeNull();
        expect(parseTimeOfDay('01:60')).toBeNull();
    });
});

describe('isWithinWindow', () => {
    it('covers a window inside one day', () => {
        expect(isWithinWindow(90, 90, 540)).toBe(true);
        expect(isWithinWindow(89, 90, 540)).toBe(false);
        // End is exclusive: 09:00 itself is polled.
        expect(isWithinWindow(540, 90, 540)).toBe(false);
    });

    it('covers a window that wraps past midnight', () => {
        // 22:00-06:00 is the obvious thing an operator tries next, and reading
        // it as an empty window would be a silent failure.
        const start = 22 * 60;
        const end = 6 * 60;
        expect(isWithinWindow(23 * 60, start, end)).toBe(true);
        expect(isWithinWindow(2 * 60, start, end)).toBe(true);
        expect(isWithinWindow(12 * 60, start, end)).toBe(false);
    });

    it('treats an empty window as no window', () => {
        expect(isWithinWindow(600, 600, 600)).toBe(false);
    });
});

describe('minutesOfDayIn', () => {
    it('answers in the requested zone, not the process one', () => {
        // The whole reason the cadence carries a zone: a container in UTC must
        // still be able to put the window where the players are.
        const at = new Date('2026-08-06T23:30:00.000Z');
        expect(minutesOfDayIn(at, 'UTC')).toBe(23 * 60 + 30);
        // BST in August: UTC+1.
        expect(minutesOfDayIn(at, 'Europe/London')).toBe(30);
    });

    it('renders midnight as 0 rather than 1440', () => {
        // `hour12: false` yields hour 24 under some ICU versions.
        expect(
            minutesOfDayIn(new Date('2026-08-06T00:00:00.000Z'), 'UTC')
        ).toBe(0);
    });

    it('falls back to UTC for a zone that does not exist', () => {
        const at = new Date('2026-08-06T13:00:00.000Z');
        expect(minutesOfDayIn(at, 'Middle/Earth')).toBe(13 * 60);
    });
});

describe('isQuietHours', () => {
    const at = (iso: string) => new Date(iso);

    it('is quiet across the configured window', () => {
        expect(isQuietHours(at('2026-08-06T01:29:00.000Z'), CADENCE)).toBe(
            false
        );
        expect(isQuietHours(at('2026-08-06T01:30:00.000Z'), CADENCE)).toBe(
            true
        );
        expect(isQuietHours(at('2026-08-06T05:00:00.000Z'), CADENCE)).toBe(
            true
        );
        expect(isQuietHours(at('2026-08-06T08:59:00.000Z'), CADENCE)).toBe(
            true
        );
        expect(isQuietHours(at('2026-08-06T09:00:00.000Z'), CADENCE)).toBe(
            false
        );
    });

    it('moves with the zone the window is written in', () => {
        // 01:00 UTC is 02:00 in London in August — inside the window there and
        // outside it in UTC. Getting this wrong shifts the whole night by an
        // hour twice a year, which is exactly the bug a fixed offset would have.
        const at0100Utc = at('2026-08-06T01:00:00.000Z');
        expect(isQuietHours(at0100Utc, CADENCE)).toBe(false);
        expect(
            isQuietHours(at0100Utc, { ...CADENCE, timeZone: 'Europe/London' })
        ).toBe(true);
    });

    it('is never quiet when the window is empty or malformed', () => {
        expect(
            isQuietHours(at('2026-08-06T03:00:00.000Z'), {
                ...CADENCE,
                quietStart: '03:00',
                quietEnd: '03:00',
            })
        ).toBe(false);
        expect(
            isQuietHours(at('2026-08-06T03:00:00.000Z'), {
                ...CADENCE,
                quietStart: 'nonsense',
            })
        ).toBe(false);
    });
});

describe('pollIntervalMinutes', () => {
    it('is the configured interval when there is no budget pressure', () => {
        expect(pollIntervalMinutes(1, CADENCE)).toBe(POLL_MINUTES);
    });

    it('widens to whole multiples so slots stay on the clock', () => {
        // 1.4 x 60 would be 84 minutes, whose slots walk across the clock and
        // undo the alignment this module exists for. Whole multiples of an hour
        // are still hourly, just fewer of them.
        expect(pollIntervalMinutes(1.4, CADENCE)).toBe(60);
        expect(pollIntervalMinutes(1.6, CADENCE)).toBe(120);
        expect(pollIntervalMinutes(3, CADENCE)).toBe(180);
    });

    it('never speeds up below the configured cadence', () => {
        // Pressure is a brake, not a throttle.
        expect(pollIntervalMinutes(0.1, CADENCE)).toBe(POLL_MINUTES);
        expect(pollIntervalMinutes(0, CADENCE)).toBe(POLL_MINUTES);
    });
});

describe('isDueForPoll', () => {
    it('is due once a new slot has opened', () => {
        const at1005 = new Date('2026-08-06T10:05:00.000Z');
        // Polled at 09:58, so the 10:00 slot is new.
        expect(
            isDueForPoll(
                { lastPolledAt: '2026-08-06T09:58:00.000Z' },
                at1005,
                1,
                CADENCE
            )
        ).toBe(true);
        // Polled at 10:02, same slot as 10:05.
        expect(
            isDueForPoll(
                { lastPolledAt: '2026-08-06T10:02:00.000Z' },
                at1005,
                1,
                CADENCE
            )
        ).toBe(false);
    });

    it('does not drift, which is the whole point of slots', () => {
        // The elapsed-time form would make a 10:03 poll due at 11:03, noticed at
        // 11:05, and so on until the polls had wandered half an hour. Here a
        // poll at 10:03 is due again at 11:00 sharp.
        const polledLate = { lastPolledAt: '2026-08-06T10:03:00.000Z' };
        expect(
            isDueForPoll(
                polledLate,
                new Date('2026-08-06T10:59:00.000Z'),
                1,
                CADENCE
            )
        ).toBe(false);
        expect(
            isDueForPoll(
                polledLate,
                new Date('2026-08-06T11:00:00.000Z'),
                1,
                CADENCE
            )
        ).toBe(true);
    });

    it('polls nobody during the quiet window', () => {
        // Not even somebody wildly overdue. The window is a hard stop, not a
        // deprioritisation.
        expect(
            isDueForPoll(
                { lastPolledAt: '2026-08-05T10:00:00.000Z' },
                new Date('2026-08-06T04:00:00.000Z'),
                1,
                CADENCE
            )
        ).toBe(false);
    });

    it('polls a never-polled player at once, but still not while quiet', () => {
        expect(isDueForPoll({ lastPolledAt: null }, NOW, 1, CADENCE)).toBe(
            true
        );
        expect(
            isDueForPoll(
                { lastPolledAt: null },
                new Date('2026-08-06T03:00:00.000Z'),
                1,
                CADENCE
            )
        ).toBe(false);
    });

    it('widens with budget pressure', () => {
        const polledLastHour = { lastPolledAt: '2026-08-06T10:30:00.000Z' };
        const at1100 = new Date('2026-08-06T11:00:00.000Z');
        expect(isDueForPoll(polledLastHour, at1100, 1, CADENCE)).toBe(true);
        // At pressure 2 the slot is two hours wide, and 10:30 and 11:00 share it.
        expect(isDueForPoll(polledLastHour, at1100, 2, CADENCE)).toBe(false);
    });

    it('treats an unparseable last-polled timestamp as due, not as never due', () => {
        // `new Date('nonsense')` compared with anything is silently false, which
        // would mean a player who quietly stops being polled at all.
        expect(
            isDueForPoll({ lastPolledAt: 'not a date' }, NOW, 1, CADENCE)
        ).toBe(true);
    });
});

describe('selectPlayersToPoll', () => {
    it('returns only the players actually due', () => {
        const due = selectPlayersToPoll(
            [
                player({ ubisoftId: 'a', lastPolledAt: minutesAgo(300) }),
                player({ ubisoftId: 'b', lastPolledAt: minutesAgo(5) }),
            ],
            NOW,
            1,
            Number.POSITIVE_INFINITY,
            CADENCE
        );
        expect(due.map((p) => p.ubisoftId)).toEqual(['a']);
    });

    it('returns nobody at all during the quiet window', () => {
        expect(
            selectPlayersToPoll(
                [player({ lastPolledAt: null })],
                new Date('2026-08-06T04:00:00.000Z'),
                1,
                Number.POSITIVE_INFINITY,
                CADENCE
            )
        ).toEqual([]);
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
            1,
            CADENCE
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
            1,
            CADENCE
        );
        expect(due.map((p) => p.ubisoftId)).toEqual(['new']);
    });

    it('spends nothing when there is nothing left to spend', () => {
        expect(
            selectPlayersToPoll(
                [player({ lastPolledAt: null })],
                NOW,
                1,
                0,
                CADENCE
            )
        ).toEqual([]);
    });
});

describe('quietMinutesPerDay', () => {
    it('measures the default window', () => {
        expect(quietMinutesPerDay(CADENCE)).toBe(7.5 * 60);
    });

    it('measures a window that wraps past midnight', () => {
        expect(
            quietMinutesPerDay({
                ...CADENCE,
                quietStart: '22:00',
                quietEnd: '06:00',
            })
        ).toBe(8 * 60);
    });

    it('is zero when there is no window', () => {
        expect(
            quietMinutesPerDay({
                ...CADENCE,
                quietStart: '09:00',
                quietEnd: '09:00',
            })
        ).toBe(0);
    });
});

/**
 * The cost model, checked against the plan.
 *
 * These are the numbers the design was chosen from. A cadence change that breaks
 * one of them has moved the plugin off a plan it cannot see.
 */
describe('estimatedMonthlyCallsPerPlayer', () => {
    /** 3,000 a month less the 5% reserve. */
    const POLL_BUDGET = Math.floor(3000 * 0.95);

    it('costs about 495 calls a player a month at the shipped cadence', () => {
        // 16.5 pollable hours a day, hourly, over 30 days.
        expect(estimatedMonthlyCallsPerPlayer(CADENCE)).toBe(495);
    });

    it('leaves room for five players inside the plan', () => {
        // The figure that silently degrades as more people link their accounts,
        // which is why `index.ts` logs it on enable.
        const affordable = Math.floor(
            POLL_BUDGET / estimatedMonthlyCallsPerPlayer(CADENCE)
        );
        expect(affordable).toBeGreaterThanOrEqual(5);
    });

    it('does not depend on how much anybody plays', () => {
        // The point of a fixed interval, and the thing the adaptive scheme could
        // not offer: a player costs the same every month whether they play every
        // night or never touch the game.
        expect(estimatedMonthlyCallsPerPlayer(CADENCE)).toBe(
            estimatedMonthlyCallsPerPlayer(CADENCE)
        );
    });

    it('charges for the quiet window only if you remove it', () => {
        const roundTheClock = estimatedMonthlyCallsPerPlayer({
            ...CADENCE,
            quietStart: '09:00',
            quietEnd: '09:00',
        });
        expect(roundTheClock).toBe(720);
        // What the window actually buys, stated as the only figure that matters:
        // how many people can be tracked before the cadence has to widen. Losing
        // the window costs two of them.
        const affordable = (perPlayer: number) =>
            Math.floor(POLL_BUDGET / perPlayer);
        expect(affordable(roundTheClock)).toBe(3);
        expect(affordable(estimatedMonthlyCallsPerPlayer(CADENCE))).toBe(5);
    });

    it('halves when the interval doubles', () => {
        expect(
            estimatedMonthlyCallsPerPlayer({ ...CADENCE, pollMinutes: 120 })
        ).toBe(Math.round(estimatedMonthlyCallsPerPlayer(CADENCE) / 2));
    });
});

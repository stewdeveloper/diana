/**
 * The r6data monthly call budget.
 *
 * This is the arithmetic Part B rests on. The plan allows **3,000 requests a
 * month across 3 tracked players**, and the feature it pays for — reporting a
 * single Siege match rather than a session — needs a poll window about one match
 * wide. Those two facts are in tension, the resolution is a per-player adaptive
 * cadence rather than a cron interval, and the numbers below are what make the
 * resolution checkable instead of asserted in a comment.
 *
 * The DB-backed half is mocked. What is under test is the model.
 */

const queryMock = jest.fn().mockResolvedValue({ rows: [] });

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({
        db: { query: (...args: unknown[]) => queryMock(...args) },
    })
);

import {
    DEFAULT_MONTHLY_CALL_BUDGET,
    DEFAULT_POLL_BUDGET_RESERVE,
    MAX_BUDGET_PRESSURE,
    budgetPeriod,
    currentR6BudgetPlan,
    monthElapsedFraction,
    planR6Budget,
    pollBudgetFor,
    r6BudgetConfig,
    readR6ApiUsage,
    recordR6ApiCalls,
} from '../packages/diana-core/src/plugins/diana-r6-bot/api/utils/r6Budget';

const at = (iso: string) => new Date(iso);

describe('budgetPeriod', () => {
    it('keys on the UTC month, zero-padded', () => {
        expect(budgetPeriod(at('2026-08-06T12:00:00Z'))).toBe('2026-08');
        expect(budgetPeriod(at('2026-01-01T00:00:00Z'))).toBe('2026-01');
    });

    it('keys by UTC, not by local time', () => {
        // 31 Aug 23:00 UTC is 1 Sep in Sydney. Charging that request to
        // September would leave August's ledger under-reporting and September's
        // over — and which way round it went would depend on where the bot
        // happened to be deployed.
        expect(budgetPeriod(at('2026-08-31T23:00:00Z'))).toBe('2026-08');
    });
});

describe('monthElapsedFraction', () => {
    it('measures against the real length of the month, not 30 days', () => {
        // Half of February 2026 (28 days) is the 15th at midnight; half of
        // August (31 days) is the 16th at noon. Using 30 for both would be a
        // ~10% error in the comparison the whole model is built on.
        expect(monthElapsedFraction(at('2026-02-15T00:00:00Z'))).toBeCloseTo(
            0.5,
            2
        );
        expect(monthElapsedFraction(at('2026-08-16T12:00:00Z'))).toBeCloseTo(
            0.5,
            2
        );
    });

    it('never returns zero, because it is a divisor', () => {
        expect(
            monthElapsedFraction(at('2026-08-01T00:00:00Z'))
        ).toBeGreaterThan(0);
    });
});

describe('pollBudgetFor', () => {
    it('holds back the reserve', () => {
        expect(pollBudgetFor(3000, 0.05)).toBe(2850);
    });

    it('treats a missing or nonsensical allowance as no allowance', () => {
        // Fail closed. The alternative reading — "no limit configured means no
        // limit" — would spend a real plan's month on a typo.
        expect(pollBudgetFor(0, 0.05)).toBe(0);
        expect(pollBudgetFor(-100, 0.05)).toBe(0);
        expect(pollBudgetFor(Number.NaN, 0.05)).toBe(0);
    });

    it('will not reserve more than half the plan', () => {
        expect(pollBudgetFor(3000, 5)).toBe(1500);
        expect(pollBudgetFor(3000, -1)).toBe(3000);
    });
});

describe('planR6Budget', () => {
    const limit = 3000;
    const reserve = 0.05;

    it('leaves the cadence alone while spend tracks elapsed time', () => {
        // Half the month gone, half the poll budget spent: exactly on pace.
        const plan = planR6Budget(
            1425,
            limit,
            reserve,
            at('2026-08-16T12:00:00Z')
        );
        expect(plan.pollBudget).toBe(2850);
        expect(plan.pressure).toBe(1);
        expect(plan.exhausted).toBe(false);
    });

    it('does not speed up when spend is behind pace', () => {
        // Deliberately *not* "divide what is left by the days remaining", which
        // treats an unspent fortnight as a windfall the rest of the month is
        // obliged to burn. Pressure floors at 1: being under budget is simply
        // headroom for a busy week.
        const plan = planR6Budget(
            100,
            limit,
            reserve,
            at('2026-08-16T12:00:00Z')
        );
        expect(plan.pressure).toBe(1);
    });

    it('stretches intervals in proportion to the overspend', () => {
        // Half the month gone, three quarters of the budget spent → 1.5x pace,
        // so every interval is 1.5x longer, which halves the pace back toward 1.
        const plan = planR6Budget(
            Math.round(2850 * 0.75),
            limit,
            reserve,
            at('2026-08-16T12:00:00Z')
        );
        expect(plan.pressure).toBeCloseTo(1.5, 1);
        expect(plan.exhausted).toBe(false);
    });

    it('caps how far it will stretch', () => {
        // Unbounded pressure would be worse than the hard stop it avoids: a
        // player would go unpolled for days while the ledger still reported
        // budget left.
        const plan = planR6Budget(
            2800,
            limit,
            reserve,
            at('2026-08-01T00:30:00Z')
        );
        expect(plan.pressure).toBe(MAX_BUDGET_PRESSURE);
    });

    it('stops entirely once the poller has spent its share', () => {
        const plan = planR6Budget(
            2850,
            limit,
            reserve,
            at('2026-08-20T00:00:00Z')
        );
        expect(plan.exhausted).toBe(true);
    });

    it('leaves the reserve for the paths a person is waiting on', () => {
        // 2,850 spent of 3,000: the poller is done for the month, but `/r6-add`
        // still has 150 calls. A poller allowed to spend the last request would
        // make adding a player fail until the 1st.
        expect(
            planR6Budget(2850, 3000, 0.05, at('2026-08-20T00:00:00Z')).exhausted
        ).toBe(true);
        expect(pollBudgetFor(3000, 0.05)).toBeLessThan(3000);
    });
});

describe('r6BudgetConfig', () => {
    const original = { ...process.env };
    afterEach(() => {
        process.env = { ...original };
    });

    it('defaults to the plan Diana is actually on', () => {
        delete process.env.R6DATA_MONTHLY_CALL_BUDGET;
        delete process.env.R6DATA_POLL_BUDGET_RESERVE;
        expect(r6BudgetConfig()).toEqual({
            limit: DEFAULT_MONTHLY_CALL_BUDGET,
            reserve: DEFAULT_POLL_BUDGET_RESERVE,
        });
        expect(DEFAULT_MONTHLY_CALL_BUDGET).toBe(3000);
    });

    it('reads an override, and ignores an unusable one', () => {
        process.env.R6DATA_MONTHLY_CALL_BUDGET = '10000';
        expect(r6BudgetConfig().limit).toBe(10000);

        process.env.R6DATA_MONTHLY_CALL_BUDGET = 'unlimited';
        expect(r6BudgetConfig().limit).toBe(DEFAULT_MONTHLY_CALL_BUDGET);
    });
});

describe('the ledger', () => {
    beforeEach(() => {
        queryMock.mockReset();
        queryMock.mockResolvedValue({ rows: [] });
    });

    it('reads zero for a month with no row yet', async () => {
        expect(await readR6ApiUsage(at('2026-09-01T00:00:00Z'))).toBe(0);
    });

    it('increments inside Postgres rather than read-modify-write', async () => {
        // Two ticks reading 100 and both writing 101 is exactly the race a
        // monthly cap must not have.
        await recordR6ApiCalls(3, at('2026-08-06T00:00:00Z'));

        const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('ON CONFLICT (period) DO UPDATE');
        expect(sql).toContain('r6_api_budget.calls + EXCLUDED.calls');
        expect(params).toEqual(['2026-08', 3]);
    });

    it('writes nothing for a zero charge', async () => {
        await recordR6ApiCalls(0);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('treats an unreadable ledger as no budget, not as unlimited budget', async () => {
        // The failure that matters. "Assume budget on error" would spend the
        // month's allowance during any database outage; this costs one tick.
        jest.spyOn(console, 'error').mockImplementation(() => {});
        queryMock.mockRejectedValue(new Error('pg down'));

        const plan = await currentR6BudgetPlan(at('2026-08-06T00:00:00Z'));
        expect(plan.exhausted).toBe(true);
    });
});

/**
 * The figures in r6Budget.ts's header, checked rather than asserted.
 *
 * If a future change makes one of these fail, the cadence has moved off the plan
 * — that is the point of pinning them.
 */
describe('the plan, as arithmetic', () => {
    const PLAYERS = 3;
    const usable = pollBudgetFor(
        DEFAULT_MONTHLY_CALL_BUDGET,
        DEFAULT_POLL_BUDGET_RESERVE
    );

    it('rules out a fixed 5-minute cron at one call per player', () => {
        const ticksPerMonth = (30 * 24 * 60) / 5;
        expect(ticksPerMonth * PLAYERS).toBeGreaterThan(usable * 8);
    });

    it('shows the hourly default only fit once the second request was dropped', () => {
        // Worth being exact about, because it is the one figure that changed
        // meaning. At the two requests per player `getProfileByName` issues, the
        // hourly cron 020 shipped was already over the plan and nobody knew. At
        // one, it fits — with too little headroom to also afford resolving
        // matches, which is what the adaptive cadence spends the difference on.
        const ticksPerMonth = 30 * 24;
        expect(ticksPerMonth * PLAYERS * 2).toBeGreaterThan(usable);
        expect(ticksPerMonth * PLAYERS).toBeLessThan(usable);
    });

    it('puts the fixed-cadence ceiling around three quarters of an hour', () => {
        // 2,850 usable / 3 players = 950 polls each = one every ~45 minutes.
        // Far too wide to resolve a 25-35 minute match, which is why the cadence
        // had to become adaptive rather than merely slower.
        const pollsPerPlayer = usable / PLAYERS;
        const minutesBetweenPolls = (30 * 24 * 60) / pollsPerPlayer;
        expect(minutesBetweenPolls).toBeGreaterThan(40);
        expect(minutesBetweenPolls).toBeLessThan(50);
    });

    it('affords roughly one Siege evening a day at the active cadence', () => {
        // The claim the whole design turns on: the month's allowance spent at
        // five minutes buys about two and a half hours of match-resolving
        // coverage per player per day. This is the *ceiling* — it ignores the
        // idle floor the poller also pays to notice a session starting, which
        // r6PollScheduler's own model takes out and lands at about two hours.
        const pollsPerPlayerPerDay = usable / PLAYERS / 30;
        const hoursCovered = (pollsPerPlayerPerDay * 5) / 60;
        expect(hoursCovered).toBeGreaterThan(2);
        expect(hoursCovered).toBeLessThan(3);
    });
});

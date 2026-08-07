/**
 * The r6data monthly call budget.
 *
 * WHY THIS EXISTS AT ALL
 *
 * Every other data source in Diana is either free at our volume (Data Dragon)
 * or rate-limited per second rather than per month (Riot). r6data is neither:
 * the plan is **3,000 requests per calendar month**, and there are **3 tracked
 * players**. That single figure decides the shape of the Siege poller, because
 * per-match messages need a poll window about one match wide (25-35 minutes)
 * and a fixed cron at that cadence costs an order of magnitude more than the
 * plan allows:
 *
 *   cadence     ticks/month   x 1 call/player x 3 players   verdict
 *   5 min             8,760                        26,280   8.8x over
 *   15 min            2,920                         8,760   2.9x over
 *   1 hour              730                         2,190   fits, resolves ~nothing
 *   44 min            ~995                         ~2,985   the fixed-cadence ceiling
 *
 * The 1-hour row is the interesting one: it fits, and it is what the plugin
 * shipped with — but only after the companion change to this PR dropped the
 * redundant `accountInfo` request. At the two calls per player `getProfileByName`
 * issues it cost ~4,380 and was already over the plan, silently, because nothing
 * counted. It still resolves almost nothing, since an hour spans two or three
 * games.
 *
 * So there is no fixed interval that both fits the plan and resolves single
 * matches. What the plan *does* buy is roughly 31 polls per player per day, and
 * spent back-to-back at five minutes that is about two and a half hours of
 * coverage — one Siege evening. That is a ceiling: `r6PollScheduler.ts` also pays
 * an idle floor to notice a session starting at all, which takes the sustainable
 * figure to about two hours a day, or ~14 three-hour evenings a month. The
 * feature is affordable only if the calls are spent while somebody is actually
 * playing, which is what that module arranges and what this one keeps honest.
 *
 * WHAT THIS MODULE GUARANTEES, AND WHAT IT DOES NOT
 *
 * It guarantees the poller cannot silently overspend the month: the ledger is a
 * table, so it survives the restarts an in-process counter would not, and it
 * counts requests *issued* rather than requests that succeeded, because a 429
 * costs quota at the provider exactly as a 200 does.
 *
 * It does not guarantee the figure matches the provider's own accounting to the
 * request. Nothing here can — r6data exposes no quota endpoint, so this is our
 * count of what we sent, and a proxy retry or a request that dies in flight
 * could differ. That is what the reserve below is for.
 */

import { db } from '../../../diana-league-bot/api/utils/db.js';

/** The plan's monthly allowance. Overridable because plans change. */
export const DEFAULT_MONTHLY_CALL_BUDGET = 3000;

/**
 * Share of the allowance the poller may not touch.
 *
 * Load-bearing, not padding. Three things spend r6data calls that are *not* the
 * poller: the ladder fetch on each process start, `checkConnection`, and — the
 * one that matters — `/r6-add`, which resolves a name to a Ubisoft id and is a
 * person waiting on a Discord reply. A poller allowed to spend the last call in
 * the month would make adding a player fail for the rest of it, and the reserve
 * also absorbs the drift between our count and the provider's.
 */
export const DEFAULT_POLL_BUDGET_RESERVE = 0.05;

/**
 * Ceiling on how far budget pressure may stretch a poll interval.
 *
 * At 8, the idle interval degrades from 3 hours to 24 and the active one from 5
 * minutes to 40. Unbounded pressure would be worse than the hard stop it is
 * trying to avoid: a player would go effectively unpolled for days while the
 * ledger still reported budget remaining.
 */
export const MAX_BUDGET_PRESSURE = 8;

export interface R6BudgetPlan {
    /** Requests issued so far this UTC month, per our ledger. */
    used: number;
    /** What the poller may spend: the allowance less the reserve. */
    pollBudget: number;
    /** Multiplier applied to every poll interval. 1 means on pace. */
    pressure: number;
    /** The poller's share is gone. It must not issue another request. */
    exhausted: boolean;
}

/** `'YYYY-MM'` for a date, in UTC. The ledger's primary key. */
export function budgetPeriod(now: Date): string {
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

/**
 * How much of the current UTC month has elapsed, in `(0, 1]`.
 *
 * Computed against the real length of *this* month rather than 30 days, because
 * the whole point is to compare spend against elapsed time and a 3-day error at
 * the end of February is a 10% error in the comparison.
 */
export function monthElapsedFraction(now: Date): number {
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    const elapsed = (now.getTime() - start) / (end - start);
    // Floored rather than clamped to 0: this is a divisor. In the opening
    // seconds of a month the floor makes pressure large, which is correct — any
    // spend at all at that point is ahead of pace — and the clamp in
    // `planR6Budget` keeps it bounded.
    return Math.min(1, Math.max(elapsed, 1e-6));
}

/** The poller's share of an allowance. */
export function pollBudgetFor(limit: number, reserve: number): number {
    if (!Number.isFinite(limit) || limit <= 0) return 0;
    const clampedReserve = Math.min(0.5, Math.max(0, reserve));
    return Math.floor(limit * (1 - clampedReserve));
}

/**
 * Turn "spent so far" into "how much to slow down".
 *
 * The rule is one line: compare the fraction of the budget spent with the
 * fraction of the month elapsed, and stretch every interval by the ratio. Spend
 * at twice the pace the month is passing and intervals double, which halves the
 * pace — self-correcting, and it needs no forecast of how much anybody is going
 * to play.
 *
 * Deliberately not "divide the remaining budget by the remaining days". That
 * looks equivalent and behaves worse: it treats budget as something to be spent
 * evenly, so a quiet fortnight leaves a windfall that the second half of the
 * month is then obliged to burn. This form treats being *under* pace as no
 * reason to do anything differently — pressure floors at 1 — so an unspent
 * fortnight simply becomes headroom for a busy one.
 */
export function planR6Budget(
    used: number,
    limit: number,
    reserve: number,
    now: Date
): R6BudgetPlan {
    const pollBudget = pollBudgetFor(limit, reserve);
    if (pollBudget <= 0) {
        return {
            used,
            pollBudget,
            pressure: MAX_BUDGET_PRESSURE,
            exhausted: true,
        };
    }
    if (used >= pollBudget) {
        return {
            used,
            pollBudget,
            pressure: MAX_BUDGET_PRESSURE,
            exhausted: true,
        };
    }

    const spent = used / pollBudget;
    const elapsed = monthElapsedFraction(now);
    const pressure = Math.min(
        MAX_BUDGET_PRESSURE,
        Math.max(1, spent / elapsed)
    );
    return { used, pollBudget, pressure, exhausted: false };
}

/** Env-configured allowance and reserve, read per tick so tests can set them. */
export function r6BudgetConfig(): { limit: number; reserve: number } {
    const rawLimit = Number(process.env.R6DATA_MONTHLY_CALL_BUDGET);
    const rawReserve = Number(process.env.R6DATA_POLL_BUDGET_RESERVE);
    return {
        limit:
            Number.isFinite(rawLimit) && rawLimit > 0
                ? rawLimit
                : DEFAULT_MONTHLY_CALL_BUDGET,
        reserve: Number.isFinite(rawReserve)
            ? rawReserve
            : DEFAULT_POLL_BUDGET_RESERVE,
    };
}

/** Requests issued this month, per the ledger. 0 when the month has no row. */
export async function readR6ApiUsage(now = new Date()): Promise<number> {
    const result = await db.query(
        `SELECT calls FROM r6_api_budget WHERE period = $1`,
        [budgetPeriod(now)]
    );
    return result.rows[0]?.calls ?? 0;
}

/**
 * Charge `count` requests to the current month.
 *
 * An upsert rather than a read-modify-write: the increment happens inside
 * Postgres, so two concurrent ticks cannot both read 100 and both write 101.
 */
export async function recordR6ApiCalls(
    count: number,
    now = new Date()
): Promise<void> {
    if (count <= 0) return;
    await db.query(
        `INSERT INTO r6_api_budget (period, calls, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (period) DO UPDATE
            SET calls = r6_api_budget.calls + EXCLUDED.calls,
                updated_at = NOW()`,
        [budgetPeriod(now), count]
    );
}

/**
 * Read the ledger and turn it into a plan.
 *
 * A read failure is not a licence to spend: the poller is told the budget is
 * exhausted, which costs at most one tick's worth of latency and cannot
 * overspend. The opposite default — assume budget on error — would spend the
 * month's allowance during any database outage.
 */
export async function currentR6BudgetPlan(
    now = new Date()
): Promise<R6BudgetPlan> {
    const { limit, reserve } = r6BudgetConfig();
    try {
        const used = await readR6ApiUsage(now);
        return planR6Budget(used, limit, reserve, now);
    } catch (err) {
        console.error(
            '[R6] Failed to read the call budget; skipping poll:',
            err
        );
        return {
            used: Number.NaN,
            pollBudget: pollBudgetFor(limit, reserve),
            pressure: MAX_BUDGET_PRESSURE,
            exhausted: true,
        };
    }
}

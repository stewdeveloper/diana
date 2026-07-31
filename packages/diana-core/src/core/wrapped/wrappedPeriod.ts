/**
 * The window a Wrapped card covers (roadmap §7.2).
 *
 * WHY THERE IS NO SPLIT CALENDAR IN THIS FILE
 *
 * The feature is described as an "end-of-split recap", and the obvious
 * implementation is a table of split boundaries. There is no way to keep one
 * honest. Riot publishes no endpoint for split dates - `match-v5` carries
 * `gameVersion`, which is a patch, and `league-v4` carries a tier, which is a
 * standing - so any table here would be hand-maintained, would need a deploy
 * every time Riot moved a date, and would silently produce wrong windows for
 * every self-hoster running a version older than the last edit. A card that
 * quietly covers the wrong three months is worse than one that says what it
 * covers.
 *
 * So the period is **data, not code**: the API takes an explicit `[from, to)`
 * and the card carries its own label, which is what lets an operator who *does*
 * know the split dates pass them in. The presets below are the ones that can be
 * derived from a calendar alone and therefore cannot go stale.
 *
 * `split` is a 90-day window rather than a real split. It is named for the thing
 * it approximates because that is what a player will look for, and its label
 * says "Last 90 days" so the card never claims more than it knows.
 */

/** Presets that need no external knowledge. */
export type WrappedPeriodKey = 'split' | 'month' | 'year' | 'all';

export const WRAPPED_PERIOD_KEYS: readonly WrappedPeriodKey[] = [
    'split',
    'month',
    'year',
    'all',
];

export const DEFAULT_WRAPPED_PERIOD: WrappedPeriodKey = 'split';

/** Days in the `split` approximation. Roughly one ranked split. */
export const SPLIT_WINDOW_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A resolved window.
 *
 * Half-open: `from` is inclusive and `to` is exclusive, so two adjacent periods
 * cannot both claim the match that lands exactly on the boundary.
 */
export interface WrappedPeriod {
    /** The preset it came from, or 'custom' for an explicit window. */
    key: WrappedPeriodKey | 'custom';
    /** What the card says it covers, e.g. "Last 90 days" or "2026". */
    label: string;
    /** Inclusive, ISO 8601. */
    from: string;
    /** Exclusive, ISO 8601. */
    to: string;
}

const MONTH_NAMES = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
];

export function isWrappedPeriodKey(value: unknown): value is WrappedPeriodKey {
    return (
        typeof value === 'string' &&
        (WRAPPED_PERIOD_KEYS as readonly string[]).includes(value)
    );
}

/**
 * Resolve a preset against a clock.
 *
 * Pure, and `now` is a parameter rather than a call to `Date.now()`, so the
 * month and year boundaries are testable without waiting for January.
 *
 * `month` and `year` are calendar-to-date rather than the last 30 or 365 days:
 * a card labelled "July 2026" that actually covered 21 June to 21 July would be
 * a lie in the one place a reader is most likely to check it.
 */
export function resolveWrappedPeriod(
    key: WrappedPeriodKey = DEFAULT_WRAPPED_PERIOD,
    now: number = Date.now()
): WrappedPeriod {
    const to = new Date(now).toISOString();

    switch (key) {
        case 'month': {
            const d = new Date(now);
            const from = new Date(
                Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
            );
            return {
                key,
                label: `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
                from: from.toISOString(),
                to,
            };
        }
        case 'year': {
            const d = new Date(now);
            const from = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
            return {
                key,
                label: String(d.getUTCFullYear()),
                from: from.toISOString(),
                to,
            };
        }
        case 'all': {
            // The epoch rather than the squad's first match: finding that would
            // cost a query to produce a bound the window queries would then
            // ignore, since nothing predates the data anyway.
            return {
                key,
                label: 'All time',
                from: new Date(0).toISOString(),
                to,
            };
        }
        case 'split':
        default:
            return {
                key: 'split',
                label: `Last ${SPLIT_WINDOW_DAYS} days`,
                from: new Date(now - SPLIT_WINDOW_DAYS * DAY_MS).toISOString(),
                to,
            };
    }
}

/**
 * An explicit window, for a caller that knows its own dates.
 *
 * Returns null when either bound is unparseable or the range is empty, so a
 * malformed query string produces a 400 rather than a card covering no time at
 * all - which would otherwise render as a plausible-looking empty squad.
 */
export function resolveExplicitPeriod(
    from: string,
    to: string,
    label?: string
): WrappedPeriod | null {
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
    if (toMs <= fromMs) return null;

    return {
        key: 'custom',
        label: label?.trim() || 'Custom period',
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
    };
}

/** Epoch milliseconds for the window bounds, which is what `match_details` stores. */
export function periodBoundsMs(period: WrappedPeriod): {
    fromMs: number;
    toMs: number;
} {
    return { fromMs: Date.parse(period.from), toMs: Date.parse(period.to) };
}

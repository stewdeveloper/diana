import {
    DEFAULT_WRAPPED_PERIOD,
    isWrappedPeriodKey,
    periodBoundsMs,
    resolveExplicitPeriod,
    resolveWrappedPeriod,
    SPLIT_WINDOW_DAYS,
    WRAPPED_PERIOD_KEYS,
} from '../packages/diana-core/src/core/wrapped/wrappedPeriod';

/** 14 July 2026, 10:30 UTC — mid-month and mid-year, so neither bound is trivial. */
const NOW = Date.UTC(2026, 6, 14, 10, 30, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

describe('resolveWrappedPeriod', () => {
    it('defaults to the 90-day window', () => {
        const period = resolveWrappedPeriod(undefined, NOW);
        expect(period.key).toBe('split');
        expect(period.label).toBe(`Last ${SPLIT_WINDOW_DAYS} days`);
        expect(Date.parse(period.to) - Date.parse(period.from)).toBe(
            SPLIT_WINDOW_DAYS * DAY_MS
        );
    });

    it('never claims to know a real split boundary', () => {
        // The label is the whole point: Riot publishes no split dates, so the
        // card says what the window actually is rather than "Split 2".
        expect(resolveWrappedPeriod('split', NOW).label).not.toMatch(/split/i);
    });

    it('runs a calendar month from the first of the month', () => {
        const period = resolveWrappedPeriod('month', NOW);
        expect(period.from).toBe('2026-07-01T00:00:00.000Z');
        expect(period.to).toBe(new Date(NOW).toISOString());
        expect(period.label).toBe('July 2026');
    });

    it('runs a calendar year from 1 January', () => {
        const period = resolveWrappedPeriod('year', NOW);
        expect(period.from).toBe('2026-01-01T00:00:00.000Z');
        expect(period.label).toBe('2026');
    });

    it('labels a month by its own name and not a rolling 30 days', () => {
        // A card labelled "July 2026" that covered 14 June to 14 July would be a
        // lie in the one place a reader is most likely to check it.
        const period = resolveWrappedPeriod('month', NOW);
        expect(Date.parse(period.to) - Date.parse(period.from)).toBeLessThan(
            30 * DAY_MS
        );
    });

    it('reaches back to the epoch for all-time', () => {
        const period = resolveWrappedPeriod('all', NOW);
        expect(period.from).toBe('1970-01-01T00:00:00.000Z');
        expect(period.label).toBe('All time');
    });

    it('handles a January date without rolling into the previous year', () => {
        const january = Date.UTC(2026, 0, 3, 12, 0, 0);
        expect(resolveWrappedPeriod('month', january).from).toBe(
            '2026-01-01T00:00:00.000Z'
        );
        expect(resolveWrappedPeriod('year', january).from).toBe(
            '2026-01-01T00:00:00.000Z'
        );
    });

    it('falls back to the default for an unrecognised key', () => {
        const period = resolveWrappedPeriod('quarter' as never, NOW);
        expect(period.key).toBe(DEFAULT_WRAPPED_PERIOD);
    });
});

describe('resolveExplicitPeriod', () => {
    it('accepts a window an operator supplies', () => {
        // The escape hatch for somebody who *does* know the split dates.
        const period = resolveExplicitPeriod(
            '2026-05-01T00:00:00Z',
            '2026-09-01T00:00:00Z',
            'Split 2'
        );
        expect(period).not.toBeNull();
        expect(period?.key).toBe('custom');
        expect(period?.label).toBe('Split 2');
    });

    it('names the window when no label is given', () => {
        const period = resolveExplicitPeriod(
            '2026-05-01T00:00:00Z',
            '2026-09-01T00:00:00Z'
        );
        expect(period?.label).toBe('Custom period');
    });

    it('rejects an unparseable bound', () => {
        expect(
            resolveExplicitPeriod('not-a-date', '2026-09-01T00:00:00Z')
        ).toBeNull();
    });

    it('rejects an empty range rather than returning one', () => {
        // An empty window would render as a plausible-looking silent squad.
        expect(
            resolveExplicitPeriod(
                '2026-09-01T00:00:00Z',
                '2026-05-01T00:00:00Z'
            )
        ).toBeNull();
        expect(
            resolveExplicitPeriod(
                '2026-05-01T00:00:00Z',
                '2026-05-01T00:00:00Z'
            )
        ).toBeNull();
    });
});

describe('period plumbing', () => {
    it('exposes bounds as epoch milliseconds, which is what match_details stores', () => {
        const period = resolveWrappedPeriod('month', NOW);
        const { fromMs, toMs } = periodBoundsMs(period);
        expect(fromMs).toBe(Date.UTC(2026, 6, 1));
        expect(toMs).toBe(NOW);
    });

    it('recognises exactly the documented keys', () => {
        for (const key of WRAPPED_PERIOD_KEYS) {
            expect(isWrappedPeriodKey(key)).toBe(true);
        }
        expect(isWrappedPeriodKey('split ')).toBe(false);
        expect(isWrappedPeriodKey(undefined)).toBe(false);
        expect(isWrappedPeriodKey(7)).toBe(false);
    });
});

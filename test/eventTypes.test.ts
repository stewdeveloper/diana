import {
    buildMatchScopedEventId,
    buildPeriodicEventId,
    buildSessionEventId,
    DIANA_EVENT_SCHEMA_VERSION,
    DIANA_EVENT_TYPES,
    toIsoWeek,
} from '../packages/diana-core/src/core/eventTypes';

describe('Diana event wire contract', () => {
    it('exports the versioned runtime discriminator list', () => {
        expect(DIANA_EVENT_SCHEMA_VERSION).toBe(1);
        expect(DIANA_EVENT_TYPES.length).toBeGreaterThan(0);
        expect(new Set(DIANA_EVENT_TYPES).size).toBe(DIANA_EVENT_TYPES.length);
    });
});

// ---------------------------------------------------------------------------
// Idempotency keys
//
// These ids are the whole reason redelivery is safe. If they ever become
// non-deterministic, duplicate rows appear downstream and every session recap
// built on them is wrong.
// ---------------------------------------------------------------------------

describe('buildMatchScopedEventId', () => {
    it('is deterministic for the same inputs', () => {
        const a = buildMatchScopedEventId(
            'match.completed',
            'squad-1',
            'EUW1_123',
            'puuid-1'
        );
        const b = buildMatchScopedEventId(
            'match.completed',
            'squad-1',
            'EUW1_123',
            'puuid-1'
        );
        expect(a).toBe(b);
    });

    it('differs by match', () => {
        expect(
            buildMatchScopedEventId(
                'match.completed',
                'squad-1',
                'EUW1_123',
                'puuid-1'
            )
        ).not.toBe(
            buildMatchScopedEventId(
                'match.completed',
                'squad-1',
                'EUW1_124',
                'puuid-1'
            )
        );
    });

    it('differs by player, so both players in a duo get their own event', () => {
        expect(
            buildMatchScopedEventId(
                'match.completed',
                'squad-1',
                'EUW1_123',
                'puuid-1'
            )
        ).not.toBe(
            buildMatchScopedEventId(
                'match.completed',
                'squad-1',
                'EUW1_123',
                'puuid-2'
            )
        );
    });

    it('differs by squad, so a player on two squads produces a row for each', () => {
        expect(
            buildMatchScopedEventId(
                'match.completed',
                'squad-1',
                'EUW1_123',
                'puuid-1'
            )
        ).not.toBe(
            buildMatchScopedEventId(
                'match.completed',
                'squad-2',
                'EUW1_123',
                'puuid-1'
            )
        );
    });

    it('differs by type, so a match and a rank change from the same game do not collide', () => {
        expect(
            buildMatchScopedEventId(
                'match.completed',
                'squad-1',
                'EUW1_123',
                'puuid-1'
            )
        ).not.toBe(
            buildMatchScopedEventId(
                'rank.changed',
                'squad-1',
                'EUW1_123',
                'puuid-1'
            )
        );
    });

    it('produces a readable, greppable key', () => {
        expect(
            buildMatchScopedEventId('streak', 'squad-1', 'EUW1_123', 'puuid-1')
        ).toBe('streak:squad-1:EUW1_123:puuid-1');
    });
});

describe('buildPeriodicEventId', () => {
    it('is stable across the same week, so a redeploy cannot double-post', () => {
        expect(
            buildPeriodicEventId('digest.weekly', 'squad-1', '2026-W30')
        ).toBe(buildPeriodicEventId('digest.weekly', 'squad-1', '2026-W30'));
    });

    it('differs by week', () => {
        expect(
            buildPeriodicEventId('digest.weekly', 'squad-1', '2026-W30')
        ).not.toBe(
            buildPeriodicEventId('digest.weekly', 'squad-1', '2026-W31')
        );
    });

    it('differs by squad, so each squad gets its own digest row', () => {
        expect(
            buildPeriodicEventId('digest.weekly', 'squad-1', '2026-W30')
        ).not.toBe(
            buildPeriodicEventId('digest.weekly', 'squad-2', '2026-W30')
        );
    });

    it('is the same for two guilds attached to one squad: two posts, one fact', () => {
        // Both guilds resolve to squad-1, so both emissions carry this key and
        // the receiver's ON CONFLICT (event_id) keeps a single row.
        expect(
            buildPeriodicEventId('digest.weekly', 'squad-1', '2026-W30')
        ).toBe(buildPeriodicEventId('digest.weekly', 'squad-1', '2026-W30'));
    });
});

// ---------------------------------------------------------------------------
// ISO weeks
//
// Not ceil(dayOfYear / 7): ISO weeks start Monday and week 1 is the week
// containing the first Thursday, which makes the year boundaries interesting.
// ---------------------------------------------------------------------------

describe('toIsoWeek', () => {
    it('formats as YYYY-Www with a zero-padded week', () => {
        expect(toIsoWeek(new Date('2026-01-08T12:00:00Z'))).toMatch(
            /^\d{4}-W\d{2}$/
        );
    });

    it('gives the same week for every day Monday to Sunday', () => {
        // 2026-07-20 is a Monday; 2026-07-26 the Sunday that closes that week.
        const monday = toIsoWeek(new Date('2026-07-20T00:00:00Z'));
        const sunday = toIsoWeek(new Date('2026-07-26T23:59:59Z'));
        expect(monday).toBe(sunday);
    });

    it('rolls over to a new week on the following Monday', () => {
        const sunday = toIsoWeek(new Date('2026-07-26T23:59:59Z'));
        const nextMonday = toIsoWeek(new Date('2026-07-27T00:00:00Z'));
        expect(nextMonday).not.toBe(sunday);
    });

    it('assigns 1 Jan 2026 (a Thursday) to week 1 of 2026', () => {
        expect(toIsoWeek(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01');
    });

    it('assigns 1 Jan 2027 (a Friday) to week 53 of 2026, not week 1 of 2027', () => {
        // The ISO year follows the Thursday of the week, which falls in 2026.
        expect(toIsoWeek(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    });

    it('does not mutate the date it is given', () => {
        const d = new Date('2026-07-25T12:00:00Z');
        const before = d.getTime();
        toIsoWeek(d);
        expect(d.getTime()).toBe(before);
    });
});

describe('buildSessionEventId', () => {
    const SQUAD = 'squad-1';
    const START = '2026-07-28T20:12:00.000Z';

    it('is stable for the same night', () => {
        expect(buildSessionEventId(SQUAD, START)).toBe(
            buildSessionEventId(SQUAD, START)
        );
    });

    // `sessions.session_id` is gen_random_uuid(), which is exactly the random
    // key this file forbids. (squad_id, started_at) is the table's own UNIQUE
    // constraint, so it survives the rebuilds a derived table expects.
    it('is keyed on the squad and the start instant', () => {
        expect(buildSessionEventId(SQUAD, START)).toBe(
            `session.completed:${SQUAD}:${START}`
        );
    });

    it('separates two squads whose nights began at the same moment', () => {
        expect(buildSessionEventId('squad-a', START)).not.toBe(
            buildSessionEventId('squad-b', START)
        );
    });

    it('separates two nights of the same squad', () => {
        expect(buildSessionEventId(SQUAD, START)).not.toBe(
            buildSessionEventId(SQUAD, '2026-07-29T20:12:00.000Z')
        );
    });

    // The driver may hand back TIMESTAMPTZ as a Date or as a string. Two
    // spellings of one instant would announce one night twice.
    it('normalises a Date and a string to the same key', () => {
        expect(buildSessionEventId(SQUAD, new Date(START))).toBe(
            buildSessionEventId(SQUAD, START)
        );
    });

    it('normalises a non-UTC spelling of the same instant', () => {
        expect(
            buildSessionEventId(SQUAD, '2026-07-28T21:12:00.000+01:00')
        ).toBe(buildSessionEventId(SQUAD, START));
    });
});

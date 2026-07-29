import {
    buildPresenceEventId,
    isMeepsEventType,
    validatePresenceEvent,
    MEEPS_EVENT_TYPES,
} from '../packages/diana-core/src/core/presenceTypes';

// ---------------------------------------------------------------------------
// Idempotency keys
//
// Same contract as the outbound direction: derived from the domain, never
// random. Meeps retries, so a non-deterministic key means duplicate rows and a
// wrong session recap built on top of them.
// ---------------------------------------------------------------------------

describe('buildPresenceEventId', () => {
    it('is deterministic for the same inputs', () => {
        const a = buildPresenceEventId(
            'voice.joined',
            'sq1',
            'user-1',
            '2026-07-29T18:00:00.000Z'
        );
        const b = buildPresenceEventId(
            'voice.joined',
            'sq1',
            'user-1',
            '2026-07-29T18:00:00.000Z'
        );
        expect(a).toBe(b);
    });

    it('normalises equivalent timestamp spellings to one key', () => {
        // The same instant written two ways must not produce two rows.
        expect(
            buildPresenceEventId(
                'voice.joined',
                'sq1',
                'user-1',
                '2026-07-29T18:00:00Z'
            )
        ).toBe(
            buildPresenceEventId(
                'voice.joined',
                'sq1',
                'user-1',
                '2026-07-29T18:00:00.000Z'
            )
        );
    });

    it('normalises an offset to the same instant in UTC', () => {
        expect(
            buildPresenceEventId(
                'voice.joined',
                'sq1',
                'user-1',
                '2026-07-29T19:00:00+01:00'
            )
        ).toBe(
            buildPresenceEventId(
                'voice.joined',
                'sq1',
                'user-1',
                '2026-07-29T18:00:00.000Z'
            )
        );
    });

    it('differs by squad, so one person in two squads keys separately', () => {
        expect(
            buildPresenceEventId(
                'voice.joined',
                'sq1',
                'u1',
                '2026-07-29T18:00:00Z'
            )
        ).not.toBe(
            buildPresenceEventId(
                'voice.joined',
                'sq2',
                'u1',
                '2026-07-29T18:00:00Z'
            )
        );
    });

    it('differs by person, type and instant', () => {
        const base = buildPresenceEventId(
            'voice.joined',
            'sq1',
            'u1',
            '2026-07-29T18:00:00Z'
        );
        expect(base).not.toBe(
            buildPresenceEventId(
                'voice.joined',
                'sq1',
                'u2',
                '2026-07-29T18:00:00Z'
            )
        );
        expect(base).not.toBe(
            buildPresenceEventId(
                'voice.left',
                'sq1',
                'u1',
                '2026-07-29T18:00:00Z'
            )
        );
        expect(base).not.toBe(
            buildPresenceEventId(
                'voice.joined',
                'sq1',
                'u1',
                '2026-07-29T18:00:01Z'
            )
        );
    });

    it('falls back to the raw string rather than throwing on an unparseable date', () => {
        expect(
            buildPresenceEventId('voice.joined', 'sq1', 'u1', 'not-a-date')
        ).toBe('voice.joined:sq1:u1:not-a-date');
    });

    it('produces a readable, greppable key', () => {
        expect(
            buildPresenceEventId(
                'client.in_game',
                'sq1',
                'u1',
                '2026-07-29T18:00:00.000Z'
            )
        ).toBe('client.in_game:sq1:u1:2026-07-29T18:00:00.000Z');
    });
});

describe('isMeepsEventType', () => {
    it('accepts every declared type', () => {
        for (const type of MEEPS_EVENT_TYPES) {
            expect(isMeepsEventType(type)).toBe(true);
        }
    });

    it('rejects anything else', () => {
        expect(isMeepsEventType('voice.muted')).toBe(false);
        expect(isMeepsEventType('match.completed')).toBe(false);
        expect(isMeepsEventType(undefined)).toBe(false);
        expect(isMeepsEventType(null)).toBe(false);
        expect(isMeepsEventType(1)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Validation
//
// Rejects rather than coerces: a malformed event stays malformed on retry, so
// the endpoint answers 4xx and the sender is expected to stop.
// ---------------------------------------------------------------------------

describe('validatePresenceEvent', () => {
    const validJoin = {
        type: 'voice.joined',
        squadId: 'sq1',
        meepsUserId: 'user-1',
        occurredAt: '2026-07-29T18:00:00.000Z',
        channelId: 'chan-1',
    };

    it('accepts a well-formed voice.joined', () => {
        const result = validatePresenceEvent(validJoin);
        expect(result.ok).toBe(true);
        expect(result.event?.type).toBe('voice.joined');
    });

    it('rebuilds the eventId rather than trusting the sender', () => {
        // A sender that computes the key differently would otherwise defeat
        // deduplication entirely.
        const result = validatePresenceEvent({
            ...validJoin,
            eventId: 'whatever-the-client-felt-like',
        });

        expect(result.ok).toBe(true);
        expect(result.event?.eventId).toBe(
            'voice.joined:sq1:user-1:2026-07-29T18:00:00.000Z'
        );
    });

    it('supplies an eventId when the sender omits one', () => {
        const result = validatePresenceEvent(validJoin);
        expect(result.event?.eventId).toBe(
            'voice.joined:sq1:user-1:2026-07-29T18:00:00.000Z'
        );
    });

    it.each([
        ['a non-object', 'nope'],
        ['null', null],
    ])('rejects %s', (_label, input) => {
        expect(validatePresenceEvent(input).ok).toBe(false);
    });

    it('rejects an unknown type', () => {
        const result = validatePresenceEvent({
            ...validJoin,
            type: 'voice.screamed',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('type must be one of');
    });

    it('rejects a Diana-side event type, so the two directions cannot cross', () => {
        expect(
            validatePresenceEvent({ ...validJoin, type: 'match.completed' }).ok
        ).toBe(false);
    });

    it.each(['squadId', 'meepsUserId', 'occurredAt'])(
        'rejects a missing %s',
        (field) => {
            const input: Record<string, unknown> = { ...validJoin };
            delete input[field];
            expect(validatePresenceEvent(input).ok).toBe(false);
        }
    );

    it.each(['squadId', 'meepsUserId'])(
        'rejects a whitespace-only %s',
        (field) => {
            expect(
                validatePresenceEvent({ ...validJoin, [field]: '   ' }).ok
            ).toBe(false);
        }
    );

    it('rejects an unparseable occurredAt', () => {
        const result = validatePresenceEvent({
            ...validJoin,
            occurredAt: 'last tuesday',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('not a valid date');
    });

    it.each(['voice.joined', 'voice.left'])(
        'requires channelId for %s',
        (type) => {
            const input: Record<string, unknown> = { ...validJoin, type };
            delete input.channelId;
            const result = validatePresenceEvent(input);
            expect(result.ok).toBe(false);
            expect(result.error).toContain('channelId is required');
        }
    );

    it('does not require channelId for client events', () => {
        expect(
            validatePresenceEvent({
                type: 'client.in_champ_select',
                squadId: 'sq1',
                meepsUserId: 'user-1',
                occurredAt: '2026-07-29T18:00:00.000Z',
            }).ok
        ).toBe(true);
    });

    it('accepts client.in_game with an optional queueId and matchId', () => {
        const result = validatePresenceEvent({
            type: 'client.in_game',
            squadId: 'sq1',
            meepsUserId: 'user-1',
            occurredAt: '2026-07-29T18:00:00.000Z',
            queueId: 420,
            matchId: 'EUW1_1',
        });
        expect(result.ok).toBe(true);
    });

    it('rejects a non-numeric queueId', () => {
        expect(
            validatePresenceEvent({
                type: 'client.in_game',
                squadId: 'sq1',
                meepsUserId: 'user-1',
                occurredAt: '2026-07-29T18:00:00.000Z',
                queueId: '420',
            }).ok
        ).toBe(false);
    });

    it('accepts an absent puuid, since DN-3 identity linking is not built', () => {
        const result = validatePresenceEvent(validJoin);
        expect(result.ok).toBe(true);
        expect(result.event?.puuid).toBeUndefined();
    });

    it('rejects a non-string puuid', () => {
        expect(validatePresenceEvent({ ...validJoin, puuid: 12345 }).ok).toBe(
            false
        );
    });
});

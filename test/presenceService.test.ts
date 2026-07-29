jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({
        db: {
            query: jest.fn(),
        },
    })
);

import { db } from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db';
import {
    deletePresenceForUser,
    exportPresenceForUser,
    getPresenceConsentForUser,
    getPresenceForSquad,
    hasPresenceConsent,
    setPresenceConsent,
    storePresenceEvent,
} from '../packages/diana-core/src/core/presence/presenceService';
import type { MeepsEvent } from '../packages/diana-core/src/core/presenceTypes';

const queryMock = db.query as unknown as jest.Mock;

const joinEvent: MeepsEvent = {
    eventId: 'voice.joined:sq1:user-1:2026-07-29T18:00:00.000Z',
    type: 'voice.joined',
    squadId: 'sq1',
    meepsUserId: 'user-1',
    occurredAt: '2026-07-29T18:00:00.000Z',
    channelId: 'chan-1',
};

/** squadExists -> hasPresenceConsent, the two reads every ingest does first. */
function mockGates({ squad = true, consent = true }) {
    queryMock
        .mockResolvedValueOnce({
            rows: squad ? [{}] : [],
            rowCount: squad ? 1 : 0,
        })
        .mockResolvedValueOnce({ rows: consent ? [{ opted_in: true }] : [] });
}

beforeEach(() => {
    queryMock.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

describe('hasPresenceConsent', () => {
    it('is false when there is no row at all - absence means no', () => {
        queryMock.mockResolvedValue({ rows: [] });
        return expect(hasPresenceConsent('user-1', 'sq1')).resolves.toBe(false);
    });

    it('is false when the row says false', async () => {
        queryMock.mockResolvedValue({ rows: [{ opted_in: false }] });
        expect(await hasPresenceConsent('user-1', 'sq1')).toBe(false);
    });

    it('is true only for an explicit opt-in', async () => {
        queryMock.mockResolvedValue({ rows: [{ opted_in: true }] });
        expect(await hasPresenceConsent('user-1', 'sq1')).toBe(true);
    });

    it('is scoped per squad, not global', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await hasPresenceConsent('user-1', 'sq1');
        expect(queryMock).toHaveBeenCalledWith(expect.any(String), [
            'user-1',
            'sq1',
        ]);
    });
});

describe('setPresenceConsent', () => {
    it('upserts and returns the stored decision', async () => {
        const row = {
            meeps_user_id: 'user-1',
            squad_id: 'sq1',
            opted_in: true,
            updated_at: 'now',
        };
        queryMock.mockResolvedValue({ rows: [row] });

        expect(await setPresenceConsent('user-1', 'sq1', true)).toEqual(row);
        expect(queryMock).toHaveBeenCalledWith(expect.any(String), [
            'user-1',
            'sq1',
            true,
        ]);
    });
});

describe('getPresenceConsentForUser', () => {
    it('returns every squad the person has decided about', async () => {
        const rows = [
            { meeps_user_id: 'u1', squad_id: 'sq1', opted_in: true },
            { meeps_user_id: 'u1', squad_id: 'sq2', opted_in: false },
        ];
        queryMock.mockResolvedValue({ rows });
        expect(await getPresenceConsentForUser('u1')).toEqual(rows);
    });
});

// ---------------------------------------------------------------------------
// Ingestion
//
// The consent gate is the point of this whole module. These are the tests that
// matter most.
// ---------------------------------------------------------------------------

describe('storePresenceEvent', () => {
    it('stores a consented event', async () => {
        mockGates({});
        queryMock.mockResolvedValueOnce({ rows: [{ event_id: 'x' }] });

        expect(await storePresenceEvent(joinEvent)).toBe('stored');
    });

    it('drops an event for someone who has not opted in, writing nothing', async () => {
        mockGates({ consent: false });

        expect(await storePresenceEvent(joinEvent)).toBe('not_consented');
        // Two reads (squad, consent) and no third call: the INSERT never runs,
        // so a non-consented event leaves no trace at all.
        expect(queryMock).toHaveBeenCalledTimes(2);
        expect(
            queryMock.mock.calls.some(([sql]) =>
                String(sql).includes('INSERT INTO presence_events')
            )
        ).toBe(false);
    });

    it('checks consent before writing, not after', async () => {
        mockGates({ consent: false });
        await storePresenceEvent(joinEvent);

        const sqls = queryMock.mock.calls.map(([sql]) => String(sql));
        expect(sqls[1]).toContain('presence_consent');
    });

    it('rejects an unknown squad without consulting consent', async () => {
        mockGates({ squad: false });
        // mockGates queued a consent response too; it must go unused.
        expect(await storePresenceEvent(joinEvent)).toBe('unknown_squad');
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('reports a redelivery as a duplicate rather than an error', async () => {
        mockGates({});
        queryMock.mockResolvedValueOnce({ rows: [] }); // ON CONFLICT DO NOTHING

        expect(await storePresenceEvent(joinEvent)).toBe('duplicate');
    });

    it('stores channelId for voice events and leaves queue/match null', async () => {
        mockGates({});
        queryMock.mockResolvedValueOnce({ rows: [{ event_id: 'x' }] });

        await storePresenceEvent(joinEvent);

        const params = queryMock.mock.calls[2][1];
        expect(params[5]).toBe('chan-1'); // channel_id
        expect(params[6]).toBeNull(); // queue_id
        expect(params[7]).toBeNull(); // match_id
    });

    it('stores queueId and matchId for client.in_game and leaves channel null', async () => {
        mockGates({});
        queryMock.mockResolvedValueOnce({ rows: [{ event_id: 'x' }] });

        await storePresenceEvent({
            eventId: 'client.in_game:sq1:user-1:2026-07-29T18:00:00.000Z',
            type: 'client.in_game',
            squadId: 'sq1',
            meepsUserId: 'user-1',
            occurredAt: '2026-07-29T18:00:00.000Z',
            queueId: 420,
            matchId: 'EUW1_1',
        });

        const params = queryMock.mock.calls[2][1];
        expect(params[5]).toBeNull(); // channel_id
        expect(params[6]).toBe(420); // queue_id
        expect(params[7]).toBe('EUW1_1'); // match_id
    });

    it('stores a null puuid when Meeps does not know it', async () => {
        mockGates({});
        queryMock.mockResolvedValueOnce({ rows: [{ event_id: 'x' }] });

        await storePresenceEvent(joinEvent);

        expect(queryMock.mock.calls[2][1][4]).toBeNull();
    });

    it('normalises occurredAt to ISO on the way in', async () => {
        mockGates({});
        queryMock.mockResolvedValueOnce({ rows: [{ event_id: 'x' }] });

        await storePresenceEvent({
            ...joinEvent,
            occurredAt: '2026-07-29T19:00:00+01:00',
        });

        expect(queryMock.mock.calls[2][1][8]).toBe('2026-07-29T18:00:00.000Z');
    });
});

// ---------------------------------------------------------------------------
// Reads, export and erasure
// ---------------------------------------------------------------------------

describe('getPresenceForSquad', () => {
    it('returns a squad in time order, which is what sessionising needs', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await getPresenceForSquad('sq1');

        const [sql, params] = queryMock.mock.calls[0];
        expect(sql).toContain('ORDER BY occurred_at ASC');
        expect(params).toEqual(['sq1']);
    });

    it('numbers the window parameters correctly', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await getPresenceForSquad(
            'sq1',
            '2026-07-29T00:00:00Z',
            '2026-07-30T00:00:00Z'
        );

        const [sql, params] = queryMock.mock.calls[0];
        expect(sql).toContain('occurred_at >= $2');
        expect(sql).toContain('occurred_at <= $3');
        expect(params).toEqual([
            'sq1',
            '2026-07-29T00:00:00Z',
            '2026-07-30T00:00:00Z',
        ]);
    });

    it('handles an until without a since', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await getPresenceForSquad('sq1', undefined, '2026-07-30T00:00:00Z');

        const [sql, params] = queryMock.mock.calls[0];
        expect(sql).toContain('occurred_at <= $2');
        expect(params).toEqual(['sq1', '2026-07-30T00:00:00Z']);
    });
});

describe('exportPresenceForUser', () => {
    it('returns consent and events together', async () => {
        const events = [{ event_id: 'e1' }];
        const consent = [{ meeps_user_id: 'u1', squad_id: 'sq1' }];
        queryMock
            .mockResolvedValueOnce({ rows: events })
            .mockResolvedValueOnce({ rows: consent });

        expect(await exportPresenceForUser('u1')).toEqual({
            meepsUserId: 'u1',
            consent,
            events,
        });
    });
});

describe('deletePresenceForUser', () => {
    it('erases everything for the person when no squad is given', async () => {
        queryMock.mockResolvedValue({ rowCount: 3 });

        expect(await deletePresenceForUser('u1')).toBe(3);
        const [sql, params] = queryMock.mock.calls[0];
        expect(sql).toContain('DELETE FROM presence_events');
        expect(sql).not.toContain('squad_id');
        expect(params).toEqual(['u1']);
    });

    it('scopes erasure to one squad when asked', async () => {
        queryMock.mockResolvedValue({ rowCount: 1 });

        await deletePresenceForUser('u1', 'sq1');
        const [sql, params] = queryMock.mock.calls[0];
        expect(sql).toContain('squad_id = $2');
        expect(params).toEqual(['u1', 'sq1']);
    });

    it('reports zero rather than null when nothing matched', async () => {
        queryMock.mockResolvedValue({ rowCount: null });
        expect(await deletePresenceForUser('u1')).toBe(0);
    });
});

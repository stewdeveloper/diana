jest.mock('../packages/diana-core/src/core/presence/presenceService', () => ({
    storePresenceEvent: jest.fn(),
    setPresenceConsent: jest.fn(),
    getPresenceConsentForUser: jest.fn(),
    getPresenceForSquad: jest.fn(),
    exportPresenceForUser: jest.fn(),
    deletePresenceForUser: jest.fn(),
}));

import type { NextFunction, Request, Response } from 'express';
import * as presenceService from '../packages/diana-core/src/core/presence/presenceService';
import {
    requireMeepsSecret,
    receivePresenceEvent,
    receivePresenceBatch,
    putPresenceConsent,
    getConsent,
    getSquadPresence,
    exportUserPresence,
    deleteUserPresence,
} from '../packages/diana-core/src/core/api/presenceApi';

const storePresenceEventMock = presenceService.storePresenceEvent as jest.Mock;
const setPresenceConsentMock = presenceService.setPresenceConsent as jest.Mock;
const getPresenceConsentForUserMock =
    presenceService.getPresenceConsentForUser as jest.Mock;
const getPresenceForSquadMock =
    presenceService.getPresenceForSquad as jest.Mock;
const exportPresenceForUserMock =
    presenceService.exportPresenceForUser as jest.Mock;
const deletePresenceForUserMock =
    presenceService.deletePresenceForUser as jest.Mock;

function makeRes() {
    const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    };
    return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

function makeReq(
    overrides: {
        body?: unknown;
        params?: Record<string, string>;
        query?: Record<string, string>;
        headers?: Record<string, string>;
    } = {}
): Request {
    return {
        body: overrides.body,
        params: overrides.params ?? {},
        query: overrides.query ?? {},
        headers: overrides.headers ?? {},
    } as unknown as Request;
}

const validJoin = {
    type: 'voice.joined',
    squadId: 'sq1',
    meepsUserId: 'user-1',
    occurredAt: '2026-07-29T18:00:00.000Z',
    channelId: 'chan-1',
};

const ORIGINAL_SECRET = process.env.MEEPS_INBOUND_SECRET;

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.MEEPS_INBOUND_SECRET = 'shh';
});

afterEach(() => {
    jest.restoreAllMocks();
    if (ORIGINAL_SECRET === undefined) delete process.env.MEEPS_INBOUND_SECRET;
    else process.env.MEEPS_INBOUND_SECRET = ORIGINAL_SECRET;
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('requireMeepsSecret', () => {
    it('refuses outright when unconfigured, rather than defaulting to open', () => {
        // An unauthenticated endpoint that writes personal data is a worse
        // failure than a disabled one.
        delete process.env.MEEPS_INBOUND_SECRET;
        const res = makeRes();
        const next = jest.fn() as NextFunction;

        requireMeepsSecret(makeReq(), res, next);

        expect(res.status).toHaveBeenCalledWith(503);
        expect(next).not.toHaveBeenCalled();
    });

    it('401s on a mismatched secret', () => {
        const res = makeRes();
        const next = jest.fn() as NextFunction;

        requireMeepsSecret(
            makeReq({ headers: { 'x-meeps-secret': 'wrong' } }),
            res,
            next
        );

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('401s when the header is absent entirely', () => {
        const res = makeRes();
        const next = jest.fn() as NextFunction;

        requireMeepsSecret(makeReq(), res, next);

        expect(res.status).toHaveBeenCalledWith(401);
    });

    it('passes a matching secret through', () => {
        const res = makeRes();
        const next = jest.fn() as NextFunction;

        requireMeepsSecret(
            makeReq({ headers: { 'x-meeps-secret': 'shh' } }),
            res,
            next
        );

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

describe('POST /api/presence/events', () => {
    it('stores a valid event and reports it stored', async () => {
        storePresenceEventMock.mockResolvedValue('stored');
        const res = makeRes();

        await receivePresenceEvent(makeReq({ body: validJoin }), res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ stored: true, outcome: 'stored' })
        );
    });

    it('answers 200 for a duplicate, so the sender does not retry a success', async () => {
        storePresenceEventMock.mockResolvedValue('duplicate');
        const res = makeRes();

        await receivePresenceEvent(makeReq({ body: validJoin }), res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ stored: false, outcome: 'duplicate' })
        );
    });

    it('answers 200 - not 403 - when the person has not opted in', async () => {
        // Not an error: the event is simply dropped. A distinct error status
        // would leak who has opted in to anyone able to probe the endpoint.
        storePresenceEventMock.mockResolvedValue('not_consented');
        const res = makeRes();

        await receivePresenceEvent(makeReq({ body: validJoin }), res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ stored: false, outcome: 'not_consented' })
        );
    });

    it('400s an unknown squad, which will never succeed on retry', async () => {
        storePresenceEventMock.mockResolvedValue('unknown_squad');
        const res = makeRes();

        await receivePresenceEvent(makeReq({ body: validJoin }), res);

        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('400s a malformed event without touching storage', async () => {
        const res = makeRes();

        await receivePresenceEvent(
            makeReq({ body: { type: 'voice.joined' } }),
            res
        );

        expect(res.status).toHaveBeenCalledWith(400);
        expect(storePresenceEventMock).not.toHaveBeenCalled();
    });

    it('500s rather than throwing when storage fails', async () => {
        storePresenceEventMock.mockRejectedValue(new Error('db down'));
        const res = makeRes();

        await receivePresenceEvent(makeReq({ body: validJoin }), res);

        expect(res.status).toHaveBeenCalledWith(500);
    });
});

describe('POST /api/presence/events/batch', () => {
    it('processes each event and reports on it independently', async () => {
        storePresenceEventMock
            .mockResolvedValueOnce('stored')
            .mockResolvedValueOnce('duplicate');
        const res = makeRes();

        await receivePresenceBatch(
            makeReq({
                body: {
                    events: [
                        validJoin,
                        {
                            ...validJoin,
                            occurredAt: '2026-07-29T18:05:00.000Z',
                        },
                    ],
                },
            }),
            res
        );

        expect(res.status).toHaveBeenCalledWith(200);
        const payload = res.json.mock.calls[0][0];
        expect(payload.results).toHaveLength(2);
        expect(payload.results[0].outcome).toBe('stored');
        expect(payload.results[1].outcome).toBe('duplicate');
    });

    it('keeps processing after a malformed entry rather than discarding the batch', async () => {
        storePresenceEventMock.mockResolvedValue('stored');
        const res = makeRes();

        await receivePresenceBatch(
            makeReq({ body: { events: [{ type: 'nonsense' }, validJoin] } }),
            res
        );

        const payload = res.json.mock.calls[0][0];
        expect(payload.results[0].ok).toBe(false);
        expect(payload.results[1].outcome).toBe('stored');
        expect(storePresenceEventMock).toHaveBeenCalledTimes(1);
    });

    it('accepts an empty batch as a no-op', async () => {
        const res = makeRes();

        await receivePresenceBatch(makeReq({ body: { events: [] } }), res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(storePresenceEventMock).not.toHaveBeenCalled();
    });

    it('400s a non-array events field', async () => {
        const res = makeRes();
        await receivePresenceBatch(makeReq({ body: { events: 'nope' } }), res);
        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('400s a missing body without throwing', async () => {
        const res = makeRes();
        await receivePresenceBatch(makeReq(), res);
        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('caps the batch size', async () => {
        const res = makeRes();
        await receivePresenceBatch(
            makeReq({ body: { events: new Array(501).fill(validJoin) } }),
            res
        );
        expect(res.status).toHaveBeenCalledWith(400);
        expect(storePresenceEventMock).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Consent, export, erasure
// ---------------------------------------------------------------------------

describe('PUT /api/presence/consent', () => {
    it('records an opt-in', async () => {
        const row = { meeps_user_id: 'u1', squad_id: 'sq1', opted_in: true };
        setPresenceConsentMock.mockResolvedValue(row);
        const res = makeRes();

        await putPresenceConsent(
            makeReq({
                body: { meepsUserId: 'u1', squadId: 'sq1', optedIn: true },
            }),
            res
        );

        expect(setPresenceConsentMock).toHaveBeenCalledWith('u1', 'sq1', true);
        expect(res.json).toHaveBeenCalledWith(row);
    });

    it('records an opt-out', async () => {
        setPresenceConsentMock.mockResolvedValue({});
        const res = makeRes();

        await putPresenceConsent(
            makeReq({
                body: { meepsUserId: 'u1', squadId: 'sq1', optedIn: false },
            }),
            res
        );

        expect(setPresenceConsentMock).toHaveBeenCalledWith('u1', 'sq1', false);
    });

    it('rejects a non-boolean optedIn rather than coercing it', async () => {
        // Coercing "false" to true would silently opt someone in.
        const res = makeRes();

        await putPresenceConsent(
            makeReq({
                body: { meepsUserId: 'u1', squadId: 'sq1', optedIn: 'false' },
            }),
            res
        );

        expect(res.status).toHaveBeenCalledWith(400);
        expect(setPresenceConsentMock).not.toHaveBeenCalled();
    });

    it.each(['meepsUserId', 'squadId'])(
        'rejects a missing %s',
        async (field) => {
            const body: Record<string, unknown> = {
                meepsUserId: 'u1',
                squadId: 'sq1',
                optedIn: true,
            };
            delete body[field];
            const res = makeRes();

            await putPresenceConsent(makeReq({ body }), res);

            expect(res.status).toHaveBeenCalledWith(400);
        }
    );
});

describe('GET /api/presence/consent/:meepsUserId', () => {
    it('returns every decision the person has made', async () => {
        const rows = [{ squad_id: 'sq1', opted_in: true }];
        getPresenceConsentForUserMock.mockResolvedValue(rows);
        const res = makeRes();

        await getConsent(makeReq({ params: { meepsUserId: 'u1' } }), res);

        expect(res.json).toHaveBeenCalledWith(rows);
    });
});

describe('GET /api/presence/squad/:squadId', () => {
    it('passes the time window through', async () => {
        getPresenceForSquadMock.mockResolvedValue([]);
        const res = makeRes();

        await getSquadPresence(
            makeReq({
                params: { squadId: 'sq1' },
                query: {
                    since: '2026-07-29T00:00:00Z',
                    until: '2026-07-30T00:00:00Z',
                },
            }),
            res
        );

        expect(getPresenceForSquadMock).toHaveBeenCalledWith(
            'sq1',
            '2026-07-29T00:00:00Z',
            '2026-07-30T00:00:00Z'
        );
    });
});

describe('GET /api/presence/export/:meepsUserId', () => {
    it('returns the full export payload', async () => {
        const payload = { meepsUserId: 'u1', consent: [], events: [] };
        exportPresenceForUserMock.mockResolvedValue(payload);
        const res = makeRes();

        await exportUserPresence(
            makeReq({ params: { meepsUserId: 'u1' } }),
            res
        );

        expect(res.json).toHaveBeenCalledWith(payload);
    });
});

describe('DELETE /api/presence/user/:meepsUserId', () => {
    it('erases the data and revokes consent, so collection cannot refill it', async () => {
        deletePresenceForUserMock.mockResolvedValue(4);
        getPresenceConsentForUserMock.mockResolvedValue([
            { squad_id: 'sq1' },
            { squad_id: 'sq2' },
        ]);
        setPresenceConsentMock.mockResolvedValue({});
        const res = makeRes();

        await deleteUserPresence(
            makeReq({ params: { meepsUserId: 'u1' } }),
            res
        );

        expect(deletePresenceForUserMock).toHaveBeenCalledWith('u1', undefined);
        expect(setPresenceConsentMock).toHaveBeenCalledWith('u1', 'sq1', false);
        expect(setPresenceConsentMock).toHaveBeenCalledWith('u1', 'sq2', false);
        expect(res.json).toHaveBeenCalledWith({
            deleted: 4,
            consentRevoked: true,
        });
    });

    it('scopes erasure and revocation to one squad when asked', async () => {
        deletePresenceForUserMock.mockResolvedValue(1);
        setPresenceConsentMock.mockResolvedValue({});
        const res = makeRes();

        await deleteUserPresence(
            makeReq({
                params: { meepsUserId: 'u1' },
                query: { squadId: 'sq1' },
            }),
            res
        );

        expect(deletePresenceForUserMock).toHaveBeenCalledWith('u1', 'sq1');
        expect(setPresenceConsentMock).toHaveBeenCalledTimes(1);
        expect(setPresenceConsentMock).toHaveBeenCalledWith('u1', 'sq1', false);
        expect(getPresenceConsentForUserMock).not.toHaveBeenCalled();
    });

    it('500s rather than throwing when erasure fails', async () => {
        deletePresenceForUserMock.mockRejectedValue(new Error('db down'));
        const res = makeRes();

        await deleteUserPresence(
            makeReq({ params: { meepsUserId: 'u1' } }),
            res
        );

        expect(res.status).toHaveBeenCalledWith(500);
    });
});

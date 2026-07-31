// Mock the service before importing the handlers.
jest.mock('../packages/diana-core/src/core/squads/squadService', () => {
    const actual = jest.requireActual(
        '../packages/diana-core/src/core/squads/squadService'
    );
    return {
        // isSquadAttachmentKind and SQUAD_ATTACHMENT_KINDS are pure; keeping the
        // real ones means the validation tests below exercise the real rules.
        ...actual,
        getSquad: jest.fn(),
        getSquadAttachments: jest.fn(),
        getSquadIdForAttachment: jest.fn(),
        getSummonersForSquad: jest.fn(),
        attachToSquad: jest.fn(),
        detachAttachment: jest.fn(),
    };
});

import type { Request, Response } from 'express';
import * as squadService from '../packages/diana-core/src/core/squads/squadService';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import {
    getSquadByAttachment,
    getSquadById,
    getSquadRoster,
    createSquadAttachment,
    deleteSquadAttachment,
    meepsSecretOrSkip,
    squadsMachineRouter,
} from '../packages/diana-core/src/core/api/squadsApi';

const getSquadMock = squadService.getSquad as jest.Mock;
const getSquadAttachmentsMock = squadService.getSquadAttachments as jest.Mock;
const getSquadIdForAttachmentMock =
    squadService.getSquadIdForAttachment as jest.Mock;
const getSummonersForSquadMock = squadService.getSummonersForSquad as jest.Mock;
const attachToSquadMock = squadService.attachToSquad as jest.Mock;
const detachAttachmentMock = squadService.detachAttachment as jest.Mock;

function makeRes() {
    const res: Partial<Response> & {
        status: jest.Mock;
        json: jest.Mock;
    } = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    };
    return res as Response & { status: jest.Mock; json: jest.Mock };
}

function makeReq(params: Record<string, string> = {}, body?: unknown): Request {
    return { params, body } as unknown as Request;
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('GET /api/squads/by-attachment/:kind/:externalId', () => {
    it('returns the squad behind a Meeps space', async () => {
        const squad = { squad_id: 'sq1', name: null, created_at: 'now' };
        getSquadIdForAttachmentMock.mockResolvedValue('sq1');
        getSquadMock.mockResolvedValue(squad);
        const res = makeRes();

        await getSquadByAttachment(
            makeReq({ kind: 'meeps_space', externalId: 'space-1' }),
            res
        );

        expect(getSquadIdForAttachmentMock).toHaveBeenCalledWith(
            'meeps_space',
            'space-1'
        );
        expect(res.json).toHaveBeenCalledWith(squad);
        expect(res.status).not.toHaveBeenCalled();
    });

    it('rejects an unknown kind without touching the database', async () => {
        const res = makeRes();

        await getSquadByAttachment(
            makeReq({ kind: 'slack', externalId: 'x' }),
            res
        );

        expect(res.status).toHaveBeenCalledWith(400);
        expect(getSquadIdForAttachmentMock).not.toHaveBeenCalled();
    });

    it('404s when nothing is attached', async () => {
        getSquadIdForAttachmentMock.mockResolvedValue(null);
        const res = makeRes();

        await getSquadByAttachment(
            makeReq({ kind: 'discord_guild', externalId: 'g-unknown' }),
            res
        );

        expect(res.status).toHaveBeenCalledWith(404);
    });

    it('500s rather than throwing when the lookup fails', async () => {
        getSquadIdForAttachmentMock.mockRejectedValue(new Error('db down'));
        const res = makeRes();

        await getSquadByAttachment(
            makeReq({ kind: 'discord_guild', externalId: 'g1' }),
            res
        );

        expect(res.status).toHaveBeenCalledWith(500);
    });
});

describe('GET /api/squads/:squadId', () => {
    it('includes every attachment, so a caller can see both destinations', async () => {
        const attachments = [
            { kind: 'discord_guild', external_id: 'g1', squad_id: 'sq1' },
            { kind: 'meeps_space', external_id: 'space-1', squad_id: 'sq1' },
        ];
        getSquadMock.mockResolvedValue({
            squad_id: 'sq1',
            name: 'Tuesday',
            created_at: 'now',
        });
        getSquadAttachmentsMock.mockResolvedValue(attachments);
        const res = makeRes();

        await getSquadById(makeReq({ squadId: 'sq1' }), res);

        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ squad_id: 'sq1', attachments })
        );
    });

    it('404s for an unknown squad', async () => {
        getSquadMock.mockResolvedValue(null);
        const res = makeRes();

        await getSquadById(makeReq({ squadId: 'nope' }), res);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(getSquadAttachmentsMock).not.toHaveBeenCalled();
    });
});

describe('GET /api/squads/:squadId/summoners', () => {
    it('returns the roster', async () => {
        const roster = [{ puuid: 'p1' }, { puuid: 'p2' }];
        getSummonersForSquadMock.mockResolvedValue(roster);
        const res = makeRes();

        await getSquadRoster(makeReq({ squadId: 'sq1' }), res);

        expect(res.json).toHaveBeenCalledWith(roster);
    });

    it('500s when the roster read fails', async () => {
        getSummonersForSquadMock.mockRejectedValue(new Error('db down'));
        const res = makeRes();

        await getSquadRoster(makeReq({ squadId: 'sq1' }), res);

        expect(res.status).toHaveBeenCalledWith(500);
    });
});

describe('POST /api/squads/:squadId/attachments', () => {
    it('attaches a Meeps space to an existing squad', async () => {
        const attachment = {
            kind: 'meeps_space',
            external_id: 'space-1',
            squad_id: 'sq1',
            attached_at: 'now',
        };
        getSquadMock.mockResolvedValue({ squad_id: 'sq1' });
        attachToSquadMock.mockResolvedValue(attachment);
        const res = makeRes();

        await createSquadAttachment(
            makeReq(
                { squadId: 'sq1' },
                { kind: 'meeps_space', externalId: 'space-1' }
            ),
            res
        );

        expect(attachToSquadMock).toHaveBeenCalledWith(
            'sq1',
            'meeps_space',
            'space-1'
        );
        expect(res.status).toHaveBeenCalledWith(201);
        expect(res.json).toHaveBeenCalledWith(attachment);
    });

    it('409s when the destination already belongs to another squad', async () => {
        // Silently reassigning would strand every stat scoped to the old squad.
        getSquadMock.mockResolvedValue({ squad_id: 'sq-other' });
        attachToSquadMock.mockResolvedValue(null);
        const res = makeRes();

        await createSquadAttachment(
            makeReq(
                { squadId: 'sq-other' },
                { kind: 'discord_guild', externalId: 'g1' }
            ),
            res
        );

        expect(res.status).toHaveBeenCalledWith(409);
    });

    it('404s when the squad does not exist', async () => {
        getSquadMock.mockResolvedValue(null);
        const res = makeRes();

        await createSquadAttachment(
            makeReq(
                { squadId: 'missing' },
                { kind: 'meeps_space', externalId: 'space-1' }
            ),
            res
        );

        expect(res.status).toHaveBeenCalledWith(404);
        expect(attachToSquadMock).not.toHaveBeenCalled();
    });

    it('rejects a blank externalId', async () => {
        const res = makeRes();

        await createSquadAttachment(
            makeReq(
                { squadId: 'sq1' },
                { kind: 'meeps_space', externalId: '  ' }
            ),
            res
        );

        expect(res.status).toHaveBeenCalledWith(400);
        expect(getSquadMock).not.toHaveBeenCalled();
    });

    it('rejects a missing body without throwing', async () => {
        const res = makeRes();

        await createSquadAttachment(makeReq({ squadId: 'sq1' }), res);

        expect(res.status).toHaveBeenCalledWith(400);
    });
});

describe('DELETE /api/squads/:squadId/attachments/:kind/:externalId', () => {
    it('detaches a destination this squad owns', async () => {
        getSquadIdForAttachmentMock.mockResolvedValue('sq1');
        detachAttachmentMock.mockResolvedValue(true);
        const res = makeRes();

        await deleteSquadAttachment(
            makeReq({
                squadId: 'sq1',
                kind: 'meeps_space',
                externalId: 'space-1',
            }),
            res
        );

        expect(detachAttachmentMock).toHaveBeenCalledWith(
            'meeps_space',
            'space-1'
        );
        expect(res.json).toHaveBeenCalledWith({ detached: true });
    });

    it('refuses to detach a destination belonging to another squad', async () => {
        getSquadIdForAttachmentMock.mockResolvedValue('sq-other');
        const res = makeRes();

        await deleteSquadAttachment(
            makeReq({
                squadId: 'sq1',
                kind: 'discord_guild',
                externalId: 'g1',
            }),
            res
        );

        expect(res.status).toHaveBeenCalledWith(404);
        expect(detachAttachmentMock).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Machine access (Meeps)
// ---------------------------------------------------------------------------
//
// `by-attachment` is the only squad route a server may call, and it may only
// read. These cover the gate itself and — because the fall-through is the part
// that is easy to get wrong and impossible to see from a unit test — the real
// mounting order, over a real socket.

describe('meepsSecretOrSkip', () => {
    const ORIGINAL = process.env.MEEPS_INBOUND_SECRET;

    afterEach(() => {
        if (ORIGINAL === undefined) delete process.env.MEEPS_INBOUND_SECRET;
        else process.env.MEEPS_INBOUND_SECRET = ORIGINAL;
    });

    function reqWith(headers: Record<string, string>): Request {
        return { headers } as unknown as Request;
    }

    it('hands a request carrying no secret to the next router', () => {
        // The dashboard calls this path too. Answering 401 because it did not
        // send a machine credential it has never had would be a regression.
        process.env.MEEPS_INBOUND_SECRET = 'shh';
        const next = jest.fn();
        const res = makeRes();

        meepsSecretOrSkip(reqWith({}), res, next);

        expect(next).toHaveBeenCalledWith('router');
        expect(res.status).not.toHaveBeenCalled();
    });

    it('admits a correct secret', () => {
        process.env.MEEPS_INBOUND_SECRET = 'shh';
        const next = jest.fn();
        const res = makeRes();

        meepsSecretOrSkip(reqWith({ 'x-meeps-secret': 'shh' }), res, next);

        expect(next).toHaveBeenCalledWith();
        expect(res.status).not.toHaveBeenCalled();
    });

    it('401s a wrong secret rather than falling through to the JWT router', () => {
        // Falling through would turn a mistyped secret into "Authentication
        // required", which sends the operator looking for a dashboard problem.
        process.env.MEEPS_INBOUND_SECRET = 'shh';
        const next = jest.fn();
        const res = makeRes();

        meepsSecretOrSkip(reqWith({ 'x-meeps-secret': 'wrong' }), res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('503s when Diana has no secret configured', () => {
        delete process.env.MEEPS_INBOUND_SECRET;
        const next = jest.fn();
        const res = makeRes();

        meepsSecretOrSkip(reqWith({ 'x-meeps-secret': 'anything' }), res, next);

        expect(res.status).toHaveBeenCalledWith(503);
        expect(next).not.toHaveBeenCalled();
    });
});

describe('squadsMachineRouter mounting', () => {
    const ORIGINAL = process.env.MEEPS_INBOUND_SECRET;
    let server: Server;
    let origin: string;
    /** Stands in for the JWT-guarded router mounted after the machine one. */
    const dashboardReached = jest.fn();

    beforeAll(async () => {
        process.env.MEEPS_INBOUND_SECRET = 'shh';

        const app = express();
        app.use('/api/squads', squadsMachineRouter);
        app.use('/api/squads', (_req, res) => {
            dashboardReached();
            res.status(401).json({ error: 'Authentication required' });
        });

        server = app.listen(0);
        await new Promise((resolve) => server.once('listening', resolve));
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        if (ORIGINAL === undefined) delete process.env.MEEPS_INBOUND_SECRET;
        else process.env.MEEPS_INBOUND_SECRET = ORIGINAL;
        await new Promise((resolve) => server.close(resolve));
    });

    const get = (path: string, headers: Record<string, string> = {}) =>
        fetch(origin + path, { headers });

    it('serves by-attachment to a caller holding the secret', async () => {
        getSquadIdForAttachmentMock.mockResolvedValue('sq1');
        getSquadMock.mockResolvedValue({ squad_id: 'sq1', name: 'Squad' });

        const res = await get('/api/squads/by-attachment/meeps_space/space-1', {
            'x-meeps-secret': 'shh',
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ squad_id: 'sq1', name: 'Squad' });
        expect(dashboardReached).not.toHaveBeenCalled();
    });

    it('falls through to the authenticated router without the secret', async () => {
        // This is the assertion that proves `next(\'router\')` really exits the
        // machine router rather than skipping to the next route inside it.
        const res = await get('/api/squads/by-attachment/meeps_space/space-1');

        expect(res.status).toBe(401);
        expect(dashboardReached).toHaveBeenCalled();
        expect(getSquadIdForAttachmentMock).not.toHaveBeenCalled();
    });

    it('never lets the secret reach a write', async () => {
        // The machine router claims one GET. Everything that mutates an
        // attachment must land on the dashboard router even with a valid secret.
        const res = await fetch(origin + '/api/squads/sq1/attachments', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-meeps-secret': 'shh',
            },
            body: JSON.stringify({
                kind: 'meeps_space',
                externalId: 'space-2',
            }),
        });

        expect(res.status).toBe(401);
        expect(dashboardReached).toHaveBeenCalled();
        expect(attachToSquadMock).not.toHaveBeenCalled();
    });

    it('does not open the roster or the squad record to the secret', async () => {
        for (const path of ['/api/squads/sq1', '/api/squads/sq1/summoners']) {
            const res = await get(path, { 'x-meeps-secret': 'shh' });
            expect(res.status).toBe(401);
        }
        expect(getSummonersForSquadMock).not.toHaveBeenCalled();
    });
});

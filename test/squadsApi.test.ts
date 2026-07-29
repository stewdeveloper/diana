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
import {
    getSquadByAttachment,
    getSquadById,
    getSquadRoster,
    createSquadAttachment,
    deleteSquadAttachment,
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

import {
    Router,
    type NextFunction,
    type Request,
    type Response,
} from 'express';
import {
    getSquad,
    getSquadAttachments,
    getSquadIdForAttachment,
    getSummonersForSquad,
    attachToSquad,
    detachAttachment,
    isSquadAttachmentKind,
    SQUAD_ATTACHMENT_KINDS,
} from '../squads/squadService';
import { requireMeepsSecret } from './presenceApi';
import { getParamValue } from './requestUtils';

/**
 * Squad API (DN-2).
 *
 * Handlers are exported separately from the router, matching
 * `summonerController` / `summonerRoutes`, so they can be driven directly in
 * tests without standing up an HTTP server.
 */

function timestamp(): string {
    return new Date().toISOString();
}

function logApi(method: string, path: string, message: string): void {
    console.log(`[${timestamp()}] [Diana:API] ${method} ${path} - ${message}`);
}

const KIND_ERROR = `kind must be one of: ${SQUAD_ATTACHMENT_KINDS.join(', ')}`;

/**
 * Resolve an external destination to its squad.
 *
 * This is how Meeps finds the squad behind one of its spaces without knowing
 * anything about Discord guild ids.
 */
export async function getSquadByAttachment(
    req: Request,
    res: Response
): Promise<void> {
    const kind = getParamValue(req.params.kind);
    const externalId = getParamValue(req.params.externalId);

    if (!isSquadAttachmentKind(kind)) {
        res.status(400).json({ error: KIND_ERROR });
        return;
    }
    if (!externalId) {
        res.status(400).json({ error: 'Missing externalId' });
        return;
    }

    try {
        const squadId = await getSquadIdForAttachment(kind, externalId);
        if (!squadId) {
            res.status(404).json({ error: 'No squad for that attachment' });
            return;
        }
        res.json(await getSquad(squadId));
    } catch (err) {
        console.error(
            `[${timestamp()}] [Diana:API] GET /api/squads/by-attachment error:`,
            err
        );
        res.status(500).json({ error: 'Failed to resolve attachment' });
    }
}

export async function getSquadById(req: Request, res: Response): Promise<void> {
    const squadId = getParamValue(req.params.squadId);
    if (!squadId) {
        res.status(400).json({ error: 'Missing squad id' });
        return;
    }

    try {
        const squad = await getSquad(squadId);
        if (!squad) {
            res.status(404).json({ error: 'Squad not found' });
            return;
        }
        res.json({ ...squad, attachments: await getSquadAttachments(squadId) });
    } catch (err) {
        console.error(
            '[%s] [Diana:API] GET /api/squads/%s error:',
            timestamp(),
            squadId,
            err
        );
        res.status(500).json({ error: 'Failed to load squad' });
    }
}

export async function getSquadRoster(
    req: Request,
    res: Response
): Promise<void> {
    const squadId = getParamValue(req.params.squadId);
    if (!squadId) {
        res.status(400).json({ error: 'Missing squad id' });
        return;
    }

    try {
        const summoners = await getSummonersForSquad(squadId);
        logApi(
            'GET',
            `/api/squads/${squadId}/summoners`,
            `Returning ${summoners.length} summoner(s)`
        );
        res.json(summoners);
    } catch (err) {
        console.error(
            `[${timestamp()}] [Diana:API] GET /api/squads/${squadId}/summoners error:`,
            err
        );
        res.status(500).json({ error: 'Failed to load squad roster' });
    }
}

export async function createSquadAttachment(
    req: Request,
    res: Response
): Promise<void> {
    const squadId = getParamValue(req.params.squadId);
    const { kind, externalId } = (req.body ?? {}) as {
        kind?: unknown;
        externalId?: unknown;
    };

    if (!squadId) {
        res.status(400).json({ error: 'Missing squad id' });
        return;
    }
    if (!isSquadAttachmentKind(kind)) {
        res.status(400).json({ error: KIND_ERROR });
        return;
    }
    if (typeof externalId !== 'string' || !externalId.trim()) {
        res.status(400).json({
            error: 'externalId must be a non-empty string',
        });
        return;
    }

    try {
        if (!(await getSquad(squadId))) {
            res.status(404).json({ error: 'Squad not found' });
            return;
        }

        const attachment = await attachToSquad(squadId, kind, externalId);
        if (!attachment) {
            // Already attached to a different squad. Detach it there first -
            // silently moving it would strand every stat scoped to the old
            // squad, which is exactly what the (kind, external_id) key prevents.
            logApi(
                'POST',
                `/api/squads/${squadId}/attachments`,
                `${kind}:${externalId} already belongs to another squad`
            );
            res.status(409).json({
                error: 'That destination is already attached to another squad',
            });
            return;
        }

        logApi(
            'POST',
            `/api/squads/${squadId}/attachments`,
            `Attached ${kind}:${externalId}`
        );
        res.status(201).json(attachment);
    } catch (err) {
        console.error(
            '[%s] [Diana:API] POST /api/squads/%s/attachments error:',
            timestamp(),
            squadId,
            err
        );
        res.status(500).json({ error: 'Failed to attach' });
    }
}

export async function deleteSquadAttachment(
    req: Request,
    res: Response
): Promise<void> {
    const squadId = getParamValue(req.params.squadId);
    const kind = getParamValue(req.params.kind);
    const externalId = getParamValue(req.params.externalId);

    if (!squadId) {
        res.status(400).json({ error: 'Missing squad id' });
        return;
    }
    if (!isSquadAttachmentKind(kind)) {
        res.status(400).json({ error: KIND_ERROR });
        return;
    }
    if (!externalId) {
        res.status(400).json({ error: 'Missing externalId' });
        return;
    }

    try {
        // Ownership check before deleting: without it, any squad id in the path
        // could detach another squad's destination.
        const owner = await getSquadIdForAttachment(kind, externalId);
        if (owner !== squadId) {
            res.status(404).json({
                error: 'That attachment does not belong to this squad',
            });
            return;
        }

        const removed = await detachAttachment(kind, externalId);
        logApi(
            'DELETE',
            `/api/squads/${squadId}/attachments/${kind}/${externalId}`,
            removed ? 'Detached' : 'Nothing to detach'
        );
        res.json({ detached: removed });
    } catch (err) {
        console.error(
            '[%s] [Diana:API] DELETE /api/squads/%s/attachments error:',
            timestamp(),
            squadId,
            err
        );
        res.status(500).json({ error: 'Failed to detach' });
    }
}

/**
 * Machine credential for the one squad route a server needs.
 *
 * `getSquadByAttachment` was written so Meeps could find the squad behind one of
 * its spaces — that is what its docstring says and it is the only caller the
 * route has ever had. But the whole squads router is mounted behind the
 * dashboard JWT, and Meeps is a server with no browser session and no way to
 * obtain one. So the endpoint built for Meeps has never been callable by Meeps.
 *
 * That gap is load-bearing on the other side of the wall: Meeps authorises reads
 * by space membership while `diana_events` rows are scoped by squad, and this is
 * the only mapping between the two. Without it Meeps cannot safely answer "which
 * events may this member see", because the space→squad attachment lives here.
 *
 * Two rules keep the widening narrow:
 *
 * 1. **Reads only, and only this read.** The gate is attached to
 *    `by-attachment` alone; creating and removing attachments stay
 *    dashboard-only. A shared secret that could re-home a squad's destinations
 *    would be a much larger grant than "tell me my own squad id", and the
 *    (kind, external_id) key means re-homing strands every stat scoped to the
 *    old squad.
 * 2. **No header means no judgement.** A request that offers no
 *    `x-meeps-secret` is the dashboard, not a failed machine call, so it is
 *    handed on with `next('router')` to the authenticated router mounted after
 *    this one. Only a caller that actually presents the credential is judged on
 *    it — otherwise adding this route would have made the dashboard's own
 *    access to it a 401.
 */
export function meepsSecretOrSkip(
    req: Request,
    res: Response,
    next: NextFunction
): void {
    if (req.headers['x-meeps-secret'] === undefined) {
        next('router');
        return;
    }
    requireMeepsSecret(req, res, next);
}

const machineRouter = Router();
machineRouter.get(
    '/by-attachment/:kind/:externalId',
    meepsSecretOrSkip,
    getSquadByAttachment
);

/**
 * The machine-callable slice of the squad API. Mount it *before* the
 * JWT-guarded `squadsApiRouter` on the same path — anything it does not claim
 * falls through to that one.
 */
export const squadsMachineRouter = machineRouter;

const router = Router();

// `/by-attachment` is declared before `/:squadId` so the literal segment is not
// swallowed by the parameterised route.
router.get('/by-attachment/:kind/:externalId', getSquadByAttachment);
router.get('/:squadId', getSquadById);
router.get('/:squadId/summoners', getSquadRoster);
router.post('/:squadId/attachments', createSquadAttachment);
router.delete('/:squadId/attachments/:kind/:externalId', deleteSquadAttachment);

export const squadsApiRouter = router;

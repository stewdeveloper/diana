import {
    Router,
    type Request,
    type Response,
    type NextFunction,
} from 'express';
import {
    deletePresenceForUser,
    exportPresenceForUser,
    getPresenceConsentForUser,
    getPresenceForSquad,
    setPresenceConsent,
    storePresenceEvent,
} from '../presence/presenceService';
import { validatePresenceEvent } from '../presenceTypes';
import { getParamValue } from './requestUtils';

/**
 * Inbound presence API (DN-5).
 *
 * The mirror of Meeps' `/api/diana-events`. Machine-to-machine, so it is gated
 * on a shared secret rather than the dashboard's JWT - Meeps is a server, not a
 * logged-in browser.
 *
 * Handlers are exported separately from the router so they can be driven
 * directly in tests, matching `squadsApi` and `summonerController`.
 */

function timestamp(): string {
    return new Date().toISOString();
}

/**
 * Shared-secret gate.
 *
 * Refuses outright when unconfigured rather than defaulting to open: an
 * unauthenticated endpoint that writes personal data is a worse failure than a
 * disabled one. Mirrors Meeps' controller, which answers 503 on the same
 * condition.
 */
export function requireMeepsSecret(
    req: Request,
    res: Response,
    next: NextFunction
): void {
    const secret = process.env.MEEPS_INBOUND_SECRET;
    if (!secret) {
        console.log(
            '[presence] Not running: MEEPS_INBOUND_SECRET is not set on the server.'
        );
        res.status(503).json({ error: 'Presence ingestion not configured' });
        return;
    }
    if (req.headers['x-meeps-secret'] !== secret) {
        console.log('[presence] Rejected: secret mismatch.');
        res.status(401).json({ error: 'Invalid Meeps secret' });
        return;
    }
    next();
}

/**
 * Receive one presence event.
 *
 * 200 for both stored and duplicate - a duplicate means the sender already
 * succeeded, and answering an error would make it retry something that worked.
 * 4xx is reserved for events that will never be accepted, which the sender
 * should treat as permanent.
 *
 * `not_consented` is deliberately **200, not 403**. It is not an error: the
 * person simply has not opted in, the event is dropped without a trace, and
 * saying so through an error status would leak that distinction to anyone able
 * to probe the endpoint.
 */
export async function receivePresenceEvent(
    req: Request,
    res: Response
): Promise<void> {
    const validation = validatePresenceEvent(req.body);
    if (!validation.ok || !validation.event) {
        res.status(400).json({ error: validation.error });
        return;
    }

    try {
        const outcome = await storePresenceEvent(validation.event);
        if (outcome === 'unknown_squad') {
            res.status(400).json({ error: 'Unknown squadId' });
            return;
        }
        if (outcome === 'stored') {
            console.log(
                `[presence] Stored ${validation.event.type} (${validation.event.eventId}).`
            );
        }
        res.status(200).json({
            ok: true,
            stored: outcome === 'stored',
            outcome,
        });
    } catch (err) {
        console.error(`[${timestamp()}] [presence] Insert error:`, err);
        res.status(500).json({ error: 'Failed to store presence event' });
    }
}

/**
 * Receive a batch.
 *
 * The desktop client goes offline and comes back; replaying a backlog one HTTP
 * call at a time is wasteful when the ids already make redelivery safe. Each
 * event is reported on independently so one bad entry cannot discard the rest.
 */
export async function receivePresenceBatch(
    req: Request,
    res: Response
): Promise<void> {
    const body = req.body as { events?: unknown };
    if (!Array.isArray(body?.events)) {
        res.status(400).json({ error: 'events must be an array' });
        return;
    }
    if (body.events.length === 0) {
        res.status(200).json({ ok: true, results: [] });
        return;
    }
    if (body.events.length > 500) {
        res.status(400).json({
            error: 'events must contain at most 500 items',
        });
        return;
    }

    const results: Array<{
        eventId?: string;
        ok: boolean;
        outcome?: string;
        error?: string;
    }> = [];

    try {
        for (const raw of body.events) {
            const validation = validatePresenceEvent(raw);
            if (!validation.ok || !validation.event) {
                results.push({ ok: false, error: validation.error });
                continue;
            }
            const outcome = await storePresenceEvent(validation.event);
            results.push({
                eventId: validation.event.eventId,
                ok: outcome !== 'unknown_squad',
                outcome,
            });
        }
        res.status(200).json({ ok: true, results });
    } catch (err) {
        console.error(`[${timestamp()}] [presence] Batch error:`, err);
        res.status(500).json({ error: 'Failed to store presence batch' });
    }
}

export async function putPresenceConsent(
    req: Request,
    res: Response
): Promise<void> {
    const { meepsUserId, squadId, optedIn } = (req.body ?? {}) as {
        meepsUserId?: unknown;
        squadId?: unknown;
        optedIn?: unknown;
    };

    if (typeof meepsUserId !== 'string' || !meepsUserId.trim()) {
        res.status(400).json({ error: 'meepsUserId is required' });
        return;
    }
    if (typeof squadId !== 'string' || !squadId.trim()) {
        res.status(400).json({ error: 'squadId is required' });
        return;
    }
    if (typeof optedIn !== 'boolean') {
        res.status(400).json({ error: 'optedIn must be a boolean' });
        return;
    }

    try {
        const consent = await setPresenceConsent(meepsUserId, squadId, optedIn);
        console.log(
            `[presence] Consent for ${meepsUserId} in ${squadId} set to ${optedIn}.`
        );
        res.json(consent);
    } catch (err) {
        console.error(`[${timestamp()}] [presence] Consent error:`, err);
        res.status(500).json({ error: 'Failed to record consent' });
    }
}

export async function getConsent(req: Request, res: Response): Promise<void> {
    const meepsUserId = getParamValue(req.params.meepsUserId);
    if (!meepsUserId) {
        res.status(400).json({ error: 'Missing meepsUserId' });
        return;
    }

    try {
        res.json(await getPresenceConsentForUser(meepsUserId));
    } catch (err) {
        console.error(`[${timestamp()}] [presence] Consent read error:`, err);
        res.status(500).json({ error: 'Failed to read consent' });
    }
}

export async function getSquadPresence(
    req: Request,
    res: Response
): Promise<void> {
    const squadId = getParamValue(req.params.squadId);
    if (!squadId) {
        res.status(400).json({ error: 'Missing squad id' });
        return;
    }

    const since = getParamValue(req.query.since as string | undefined);
    const until = getParamValue(req.query.until as string | undefined);

    try {
        res.json(await getPresenceForSquad(squadId, since, until));
    } catch (err) {
        console.error(`[${timestamp()}] [presence] Squad read error:`, err);
        res.status(500).json({ error: 'Failed to read squad presence' });
    }
}

/** The export half of "visible, revocable, exportable". */
export async function exportUserPresence(
    req: Request,
    res: Response
): Promise<void> {
    const meepsUserId = getParamValue(req.params.meepsUserId);
    if (!meepsUserId) {
        res.status(400).json({ error: 'Missing meepsUserId' });
        return;
    }

    try {
        res.json(await exportPresenceForUser(meepsUserId));
    } catch (err) {
        console.error(`[${timestamp()}] [presence] Export error:`, err);
        res.status(500).json({ error: 'Failed to export presence' });
    }
}

/**
 * The revocable half. Erases; it does not merely stop collection.
 *
 * Also writes `opted_in = false` for the squads in scope, so revoking does not
 * leave collection running and silently refill what was just deleted.
 */
export async function deleteUserPresence(
    req: Request,
    res: Response
): Promise<void> {
    const meepsUserId = getParamValue(req.params.meepsUserId);
    if (!meepsUserId) {
        res.status(400).json({ error: 'Missing meepsUserId' });
        return;
    }
    const squadId = getParamValue(req.query.squadId as string | undefined);

    try {
        const deleted = await deletePresenceForUser(meepsUserId, squadId);

        if (squadId) {
            await setPresenceConsent(meepsUserId, squadId, false);
        } else {
            for (const row of await getPresenceConsentForUser(meepsUserId)) {
                await setPresenceConsent(meepsUserId, row.squad_id, false);
            }
        }

        console.log(
            `[presence] Erased ${deleted} event(s) for ${meepsUserId}${
                squadId ? ` in ${squadId}` : ''
            } and revoked consent.`
        );
        res.json({ deleted, consentRevoked: true });
    } catch (err) {
        console.error(`[${timestamp()}] [presence] Erase error:`, err);
        res.status(500).json({ error: 'Failed to erase presence' });
    }
}

const router = Router();

router.use(requireMeepsSecret);
router.post('/events', receivePresenceEvent);
router.post('/events/batch', receivePresenceBatch);
router.put('/consent', putPresenceConsent);
router.get('/consent/:meepsUserId', getConsent);
router.get('/squad/:squadId', getSquadPresence);
router.get('/export/:meepsUserId', exportUserPresence);
router.delete('/user/:meepsUserId', deleteUserPresence);

export const presenceApiRouter = router;

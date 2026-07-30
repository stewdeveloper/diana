import { Router, type Request, type Response } from 'express';
import {
    getOpenSessionForSquad,
    getSessionDetail,
    getSessionsForSquad,
    rebuildSessionsForSquad,
} from '../sessions/sessionService';
import { getParamValue } from './requestUtils';

/**
 * Sessions (DN-6).
 *
 * Behind the dashboard's JWT, not the Meeps shared secret: a session says who
 * was at their computer, with whom, and for how long, which is personal data
 * about a group of people rather than a machine-to-machine fact.
 *
 * Read-only apart from the rebuild, which is safe to call repeatedly - the
 * derivation is idempotent on `(squad_id, started_at)`.
 */

function timestamp(): string {
    return new Date().toISOString();
}

export async function listSquadSessions(
    req: Request,
    res: Response
): Promise<void> {
    const squadId = getParamValue(req.params.squadId);
    if (!squadId) {
        res.status(400).json({ error: 'Missing squad id' });
        return;
    }

    const rawLimit = Number(
        getParamValue(req.query.limit as string | undefined)
    );
    // Clamped rather than rejected: a silly limit is a caller mistake, not a
    // reason to fail a read.
    const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(Math.floor(rawLimit), 100)
            : 20;

    try {
        res.json(await getSessionsForSquad(squadId, limit));
    } catch (err) {
        console.error(`[${timestamp()}] [sessions] List error:`, err);
        res.status(500).json({ error: 'Failed to read sessions' });
    }
}

/**
 * The night in progress, if any.
 *
 * Separate from the list because it answers a different question - "are they
 * playing right now" - and because the recap fires on this becoming null.
 */
export async function getLiveSession(
    req: Request,
    res: Response
): Promise<void> {
    const squadId = getParamValue(req.params.squadId);
    if (!squadId) {
        res.status(400).json({ error: 'Missing squad id' });
        return;
    }

    try {
        const session = await getOpenSessionForSquad(squadId);
        // 200 with null, not 404: "this squad is not in voice" is a successful
        // answer, and a 404 would make a client treat it as an error.
        res.json(session);
    } catch (err) {
        console.error(`[${timestamp()}] [sessions] Live read error:`, err);
        res.status(500).json({ error: 'Failed to read live session' });
    }
}

export async function getSessionById(
    req: Request,
    res: Response
): Promise<void> {
    const sessionId = getParamValue(req.params.sessionId);
    if (!sessionId) {
        res.status(400).json({ error: 'Missing session id' });
        return;
    }

    try {
        const detail = await getSessionDetail(sessionId);
        if (!detail) {
            res.status(404).json({ error: 'Session not found' });
            return;
        }
        res.json(detail);
    } catch (err) {
        console.error(`[${timestamp()}] [sessions] Read error:`, err);
        res.status(500).json({ error: 'Failed to read session' });
    }
}

/**
 * Recompute a squad's sessions from presence.
 *
 * Explicit rather than automatic on purpose, for now: the sessionising rules are
 * still a guess (see `DEFAULT_IDLE_GAP_MS`), and being able to re-derive on
 * demand after changing them is more useful than a schedule. Hooking this to
 * presence arrival is a follow-up that touches the ingestion path.
 */
export async function rebuildSquadSessions(
    req: Request,
    res: Response
): Promise<void> {
    const squadId = getParamValue(req.params.squadId);
    if (!squadId) {
        res.status(400).json({ error: 'Missing squad id' });
        return;
    }

    const since = getParamValue(req.query.since as string | undefined);
    if (since && Number.isNaN(new Date(since).getTime())) {
        res.status(400).json({ error: 'since is not a valid date' });
        return;
    }

    try {
        const result = await rebuildSessionsForSquad(squadId, { since });
        console.log(
            `[sessions] Rebuilt ${result.sessions} session(s) for ${squadId} (${result.matchesAttached} match(es) attached).`
        );
        res.json(result);
    } catch (err) {
        console.error(`[${timestamp()}] [sessions] Rebuild error:`, err);
        res.status(500).json({ error: 'Failed to rebuild sessions' });
    }
}

const router = Router();

router.get('/squad/:squadId', listSquadSessions);
router.get('/squad/:squadId/live', getLiveSession);
router.post('/squad/:squadId/rebuild', rebuildSquadSessions);
router.get('/:sessionId', getSessionById);

export const sessionsApiRouter = router;

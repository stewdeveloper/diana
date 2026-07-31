/**
 * Squad Wrapped over HTTP (roadmap §7.2).
 *
 * WHY A ROUTE AND NOT AN EVENT
 *
 * The reasoning is on `SquadWrapped` in `wrappedTypes.ts` and comes down to one
 * fact: the card is assembled from Diana's figures *and* the group's chat corpus,
 * which only Meeps has. A pull lets Meeps join the two halves at the moment it
 * draws the card. A push would make it hold one half and wait.
 *
 * TWO CALLERS, ONE HANDLER
 *
 * Meeps is a server with a shared secret; the dashboard is a browser with a JWT.
 * `meepsSecretOrSkip` already solves this for the squad lookup - a request with
 * no `x-meeps-secret` header is handed on with `next('router')` to the
 * authenticated router mounted after this one - so the same handler is
 * registered on both and neither caller has to know about the other.
 *
 * Discord's `/wrapped` does not come through here at all. It calls
 * `computeSquadWrapped` directly, the way the digest cron calls
 * `computeWeeklyDigestStats` directly: an HTTP hop to your own process is a
 * failure mode, not an abstraction.
 */

import { Router, type Request, type Response } from 'express';
import { computeSquadWrapped } from '../wrapped/wrappedService';
import {
    isWrappedPeriodKey,
    resolveExplicitPeriod,
    resolveWrappedPeriod,
    WRAPPED_PERIOD_KEYS,
    type WrappedPeriod,
} from '../wrapped/wrappedPeriod';
import { parseCompetitiveScope } from '../../plugins/diana-league-bot/utils/queueClassification';
import { meepsSecretOrSkip } from './squadsApi';
import { getParamValue } from './requestUtils';

function timestamp(): string {
    return new Date().toISOString();
}

const PERIOD_ERROR = `period must be one of: ${WRAPPED_PERIOD_KEYS.join(', ')}`;

/**
 * Turn the query string into a window.
 *
 * `from`/`to` win over `period` when both are given, because an explicit window
 * is the more specific instruction and is the escape hatch for the split dates
 * this codebase deliberately does not know (see `wrappedPeriod.ts`).
 *
 * Returns a string on failure rather than throwing, so the caller can answer 400
 * with the reason instead of 500 with a stack trace.
 */
export function parsePeriodFromQuery(
    query: Request['query']
): WrappedPeriod | string {
    const from = getParamValue(query.from as string | string[] | undefined);
    const to = getParamValue(query.to as string | string[] | undefined);
    const label = getParamValue(query.label as string | string[] | undefined);

    if (from || to) {
        if (!from || !to) {
            return 'from and to must be given together';
        }
        const explicit = resolveExplicitPeriod(from, to, label);
        if (!explicit) {
            return 'from and to must be ISO 8601 timestamps with to after from';
        }
        return explicit;
    }

    const period = getParamValue(query.period as string | string[] | undefined);
    if (period === undefined) return resolveWrappedPeriod();
    if (!isWrappedPeriodKey(period)) return PERIOD_ERROR;
    return resolveWrappedPeriod(period);
}

/**
 * GET /api/squads/:squadId/wrapped
 *
 * 200 with `wrapped: null` when the squad did nothing in the window, rather than
 * 404. "This group played no games in July" is a true answer about a squad that
 * exists, and a 404 would make a renderer treat an ordinary quiet month as a
 * broken squad id.
 */
export const getSquadWrapped = async (
    req: Request,
    res: Response
): Promise<void> => {
    const squadId = getParamValue(req.params.squadId);
    if (!squadId) {
        res.status(400).json({ error: 'squadId is required' });
        return;
    }

    const period = parsePeriodFromQuery(req.query);
    if (typeof period === 'string') {
        res.status(400).json({ error: period });
        return;
    }

    const scope = parseCompetitiveScope(
        getParamValue(req.query.scope as string | string[] | undefined)
    );

    try {
        const wrapped = await computeSquadWrapped(squadId, { period, scope });
        res.json({ squadId, period, wrapped });
    } catch (error) {
        console.error(
            `[${timestamp()}] [Diana:API] GET /api/squads/${squadId}/wrapped failed:`,
            error
        );
        res.status(500).json({ error: 'Failed to compute squad wrapped' });
    }
};

/**
 * The machine-callable route, for Meeps. Mount on the same path as, and *before*,
 * the JWT-guarded router - a caller with no secret header falls through to it.
 */
const machineRouter = Router();
machineRouter.get('/:squadId/wrapped', meepsSecretOrSkip, getSquadWrapped);
export const wrappedMachineRouter = machineRouter;

/** The dashboard route. Mounted behind `requireAuth`. */
const router = Router();
router.get('/:squadId/wrapped', getSquadWrapped);
export const wrappedApiRouter = router;

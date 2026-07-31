import { Router, type Request, type Response } from 'express';
import {
    getPrivacy,
    setHidden,
    type SummonerPrivacy,
} from '../privacy/privacyService';
import { getParamValue } from './requestUtils';

/**
 * Privacy opt-out API (DN-3).
 *
 * The non-Discord half of `/privacy`. Two consumers: the dashboard, and Meeps'
 * consent surface (MP-13), which already shows a person what is collected about
 * them and now has somewhere to send "and stop ranking me".
 *
 * Mounted behind the dashboard's JWT rather than the Meeps shared secret. That
 * is the narrower of the two gates and the right one here: presence *ingestion*
 * is machine-to-machine and has no logged-in user, but a privacy decision is
 * made by a person, and the route that records it should know which.
 *
 * Handlers are exported separately from the router so they can be driven
 * directly in tests, matching `presenceApi` and `squadsApi`.
 */

function timestamp(): string {
    return new Date().toISOString();
}

/**
 * One player's decision.
 *
 * A player who has never decided is not an error and not a 404 - they are
 * visible, which is the default. Returning the same shape either way saves
 * every caller a branch.
 */
export async function getSummonerPrivacy(
    req: Request,
    res: Response
): Promise<void> {
    const puuid = getParamValue(req.params.puuid);
    if (!puuid) {
        res.status(400).json({ error: 'Missing puuid' });
        return;
    }

    try {
        const record = await getPrivacy(puuid);
        const response: SummonerPrivacy = record ?? {
            puuid,
            hidden: false,
            set_by: null,
            updated_at: new Date(0).toISOString(),
        };
        res.json(response);
    } catch (err) {
        console.error(`[${timestamp()}] [privacy] Read error:`, err);
        res.status(500).json({ error: 'Failed to read privacy' });
    }
}

export async function putSummonerPrivacy(
    req: Request,
    res: Response
): Promise<void> {
    const puuid = getParamValue(req.params.puuid);
    if (!puuid) {
        res.status(400).json({ error: 'Missing puuid' });
        return;
    }

    const { hidden, setBy } = (req.body ?? {}) as {
        hidden?: unknown;
        setBy?: unknown;
    };

    if (typeof hidden !== 'boolean') {
        res.status(400).json({ error: 'hidden must be a boolean' });
        return;
    }

    try {
        const record = await setHidden(
            puuid,
            hidden,
            typeof setBy === 'string' && setBy.trim() ? setBy.trim() : undefined
        );
        console.log(
            `[privacy] ${puuid} set to ${hidden ? 'hidden' : 'visible'}.`
        );
        res.json(record);
    } catch (err) {
        // A puuid with no `summoners` row fails the foreign key. That is a
        // client error - the player is not tracked - not a server fault, and
        // saying so saves the caller reading logs to find out.
        if ((err as { code?: string })?.code === '23503') {
            res.status(404).json({ error: 'Unknown puuid' });
            return;
        }
        console.error(`[${timestamp()}] [privacy] Write error:`, err);
        res.status(500).json({ error: 'Failed to record privacy' });
    }
}

const router = Router();

router.get('/:puuid', getSummonerPrivacy);
router.put('/:puuid', putSummonerPrivacy);

export const privacyApiRouter = router;

import { Router, type Request, type Response } from 'express';
import {
    getAccountsForIdentity,
    linkAccount,
    resolveIdentity,
    unlinkAccount,
    getOrCreateIdentityForAccount,
    type IdentityAccountKind,
} from '../identity/identityService';
import { requireMeepsSecret } from './presenceApi';
import { getParamValue } from './requestUtils';

/**
 * Identity resolution API (DN-3).
 *
 * The route Meeps needs. It already knows its own user ids and its own display
 * names; what it cannot know is which Riot accounts they belong to, and that is
 * the join the Session Recap needs to say the friend who left after game 5 is
 * the one who played Warwick.
 *
 * Behind `requireMeepsSecret`, alongside presence ingestion, for the same
 * reason: Meeps is a server, not a logged-in browser.
 *
 * **Not an event.** A `DianaEvent` needs a Meeps-side row shape and an
 * idempotency key (roadmap §13.4) and identity has neither - it is a lookup,
 * not something that happens. Keeping it a route also avoids the two-repo
 * ordering trap, where a type missing from Meeps' VALID_TYPES is 400'd and
 * dropped permanently.
 *
 * Handlers are exported separately from the router so they can be driven
 * directly in tests, matching `presenceApi` and `squadsApi`.
 */

function timestamp(): string {
    return new Date().toISOString();
}

const KINDS: IdentityAccountKind[] = [
    'riot_puuid',
    'discord_user',
    'meeps_user',
];

const parseKind = (value: unknown): IdentityAccountKind | null =>
    typeof value === 'string' && KINDS.includes(value as IdentityAccountKind)
        ? (value as IdentityAccountKind)
        : null;

/**
 * Everything linked to the same person as this account.
 *
 * An unlinked account is 200 with empty lists, not 404. Most people are
 * unlinked most of the time; that is the normal state of the system, and
 * making Meeps treat it as an error would put a failure path on the common
 * case.
 */
export async function resolveAccount(
    req: Request,
    res: Response
): Promise<void> {
    const kind = parseKind(getParamValue(req.query.kind as string | undefined));
    const externalId = getParamValue(
        req.query.externalId as string | undefined
    );

    if (!kind) {
        res.status(400).json({
            error: `kind must be one of ${KINDS.join(', ')}`,
        });
        return;
    }
    if (!externalId) {
        res.status(400).json({ error: 'externalId is required' });
        return;
    }

    try {
        res.json(await resolveIdentity(kind, externalId));
    } catch (err) {
        console.error(`[${timestamp()}] [identity] Resolve error:`, err);
        res.status(500).json({ error: 'Failed to resolve identity' });
    }
}

/** Every account on one identity, for an export or a settings screen. */
export async function getIdentity(req: Request, res: Response): Promise<void> {
    const identityId = getParamValue(req.params.identityId);
    if (!identityId) {
        res.status(400).json({ error: 'Missing identity id' });
        return;
    }

    try {
        const accounts = await getAccountsForIdentity(identityId);
        if (accounts.length === 0) {
            res.status(404).json({ error: 'Unknown identity' });
            return;
        }
        res.json({ identityId, accounts });
    } catch (err) {
        console.error(`[${timestamp()}] [identity] Read error:`, err);
        res.status(500).json({ error: 'Failed to read identity' });
    }
}

/**
 * Attach a Meeps user to an identity.
 *
 * The one link Meeps can assert on its own: it authenticated the user, so it
 * knows the Meeps id is theirs. It cannot assert a Riot account - that needs
 * the handshake, which needs the Riot key, which only Diana has.
 *
 * `anchor` names an account already on the target identity, almost always the
 * person's Discord id from the bridge. Without one this would have no way to
 * know which existing person the Meeps user is.
 */
export async function linkMeepsUser(
    req: Request,
    res: Response
): Promise<void> {
    const { meepsUserId, anchorKind, anchorId } = (req.body ?? {}) as {
        meepsUserId?: unknown;
        anchorKind?: unknown;
        anchorId?: unknown;
    };

    if (typeof meepsUserId !== 'string' || !meepsUserId.trim()) {
        res.status(400).json({ error: 'meepsUserId is required' });
        return;
    }

    const kind = parseKind(anchorKind);
    if (!kind || typeof anchorId !== 'string' || !anchorId.trim()) {
        res.status(400).json({
            error: `anchorKind (one of ${KINDS.join(', ')}) and anchorId are required`,
        });
        return;
    }
    if (kind === 'meeps_user') {
        // Anchoring a Meeps user to a Meeps user says nothing and would
        // silently create a fresh identity holding one account.
        res.status(400).json({ error: 'anchorKind must not be meeps_user' });
        return;
    }

    try {
        const identityId = await getOrCreateIdentityForAccount(
            kind,
            anchorId.trim()
        );
        const outcome = await linkAccount(
            identityId,
            'meeps_user',
            meepsUserId.trim()
        );

        if (!outcome.ok) {
            // Refused rather than moved. A contested link is a person to talk
            // to, not a race to win.
            res.status(409).json({
                error: 'That Meeps user is already linked to someone else',
                identityId: outcome.identityId,
            });
            return;
        }

        console.log(
            `[identity] Linked meeps_user ${meepsUserId} to ${identityId}.`
        );
        res.json({ identityId, account: outcome.account });
    } catch (err) {
        console.error(`[${timestamp()}] [identity] Link error:`, err);
        res.status(500).json({ error: 'Failed to link account' });
    }
}

/** Detach an account. Idempotent: unlinking nothing is a success. */
export async function unlinkAccountRoute(
    req: Request,
    res: Response
): Promise<void> {
    const kind = parseKind(getParamValue(req.params.kind));
    const externalId = getParamValue(req.params.externalId);

    if (!kind) {
        res.status(400).json({
            error: `kind must be one of ${KINDS.join(', ')}`,
        });
        return;
    }
    if (!externalId) {
        res.status(400).json({ error: 'Missing externalId' });
        return;
    }

    try {
        const removed = await unlinkAccount(kind, externalId);
        console.log(`[identity] Unlinked ${kind} ${externalId}.`);
        res.json({ removed });
    } catch (err) {
        console.error(`[${timestamp()}] [identity] Unlink error:`, err);
        res.status(500).json({ error: 'Failed to unlink account' });
    }
}

const router = Router();

router.use(requireMeepsSecret);
router.get('/resolve', resolveAccount);
router.get('/:identityId', getIdentity);
router.post('/meeps-user', linkMeepsUser);
router.delete('/:kind/:externalId', unlinkAccountRoute);

export const identityApiRouter = router;

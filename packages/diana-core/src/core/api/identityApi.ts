import { Router, type Request, type Response } from 'express';
import {
    chooseChallengeIcon,
    createLinkChallenge,
    createSelfAssertedLink,
    deleteLinkChallenge,
    getAccountsForIdentity,
    getLinkChallenge,
    linkAccount,
    resolveIdentity,
    unlinkAccount,
    getOrCreateIdentityForAccount,
    type ChallengeSubject,
    type IdentityAccountKind,
    type IdentitySubjectKind,
} from '../identity/identityService';
import {
    DEFAULT_REGION,
    isKnownRegion,
    regionGroupFor,
} from '../../plugins/diana-league-bot/api/utils/regions';
import { buildProfileIconUrl } from '../../plugins/diana-league-bot/api/utils/dataDragonService';
import { createLolService } from '../../plugins/diana-league-bot/api/utils/lolService/lolServiceFactory';
import { createR6Service } from '../../plugins/diana-r6-bot/api/utils/r6ServiceFactory';
import { R6_PLATFORMS } from '../../plugins/diana-r6-bot/types';
import {
    addR6PlayerToSquad,
    countTrackersOfR6Player,
    createR6RankHistory,
    deleteR6Player,
    ensureR6Player,
    getR6PlayerById,
    removeR6PlayerFromAllSquads,
} from '../../plugins/diana-r6-bot/api/players/playerService';
import { getSquadIdForAttachment } from '../squads/squadService';
import { requireMeepsSecret } from './presenceApi';
import { getParamValue } from './requestUtils';

/**
 * Identity resolution and linking API (DN-3, extended by 022).
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
 *
 * WHY THE LINKING HALF LIVES HERE AND NOT IN MEEPS
 *
 * Meeps has a Settings → Connections screen and no Riot key, and it is never
 * getting one - a second copy of the key is a second thing to leak and a second
 * rate-limit bucket Riot did not agree to. So the division is: Meeps owns the
 * screen, the session and the person's consent; Diana owns every call to Riot
 * and Ubisoft and every row that results. What crosses between them is a
 * `meeps_user` id and a game name.
 *
 * The Riot flow is the profile-icon handshake `/link` already uses, driven from
 * a different front end. Meeps starts it, Meeps polls it, and the sweep is what
 * finishes it - there is no Meeps equivalent of `/link confirm`, because the
 * thing being waited on is Riot's cache and a button that says "check again"
 * only invites somebody to press it for ten minutes.
 *
 * The Siege flow has no handshake because Siege has no mechanism for one. See
 * `createSelfAssertedLink`.
 */

function timestamp(): string {
    return new Date().toISOString();
}

const KINDS: IdentityAccountKind[] = [
    'riot_puuid',
    'discord_user',
    'meeps_user',
    'r6_ubisoft',
];

const parseKind = (value: unknown): IdentityAccountKind | null =>
    typeof value === 'string' && KINDS.includes(value as IdentityAccountKind)
        ? (value as IdentityAccountKind)
        : null;

const SUBJECT_KINDS: IdentitySubjectKind[] = ['discord_user', 'meeps_user'];

/**
 * Who a link is being made for.
 *
 * Rejects `riot_puuid` and `r6_ubisoft` by construction: those are the things
 * being linked, never the person doing the linking, and accepting one would
 * quietly create an identity anchored on a game account.
 */
function parseSubject(source: {
    subjectKind?: unknown;
    subjectId?: unknown;
}): ChallengeSubject | null {
    const kind = source.subjectKind;
    const id = source.subjectId;
    if (
        typeof kind !== 'string' ||
        !SUBJECT_KINDS.includes(kind as IdentitySubjectKind)
    ) {
        return null;
    }
    if (typeof id !== 'string' || !id.trim()) return null;
    return { kind: kind as IdentitySubjectKind, id: id.trim() };
}

const SUBJECT_ERROR = `subjectKind (one of ${SUBJECT_KINDS.join(
    ', '
)}) and subjectId are required`;

/**
 * Riot and Ubisoft failures, in terms Meeps can put in front of a person.
 *
 * A coarse `reason` beside the sentence because Meeps' card has to decide what
 * to *do* as well as what to say - a 404 leaves the form open for another go, a
 * 403 is the operator's problem and there is no point retrying it - and parsing
 * an English sentence to find that out is how the two repos drift.
 */
function describeUpstreamError(
    error: unknown,
    stage: 'account' | 'summoner' | 'r6'
): { status: number; reason: string; error: string } {
    const status =
        (error as { status?: number })?.status ??
        (error as { statusCode?: number })?.statusCode;

    if (status === 404) {
        if (stage === 'r6') {
            return {
                status: 404,
                reason: 'not_found',
                error: 'No Ubisoft account with that name on that platform. Ubisoft names are case-sensitive.',
            };
        }
        return {
            status: 404,
            reason: 'not_found',
            error:
                stage === 'account'
                    ? 'No Riot account with that name and tag. Check the spelling and the region.'
                    : 'Riot has no League profile for that account in this region.',
        };
    }
    if (status === 403) {
        return {
            status: 502,
            reason: 'upstream_forbidden',
            error: 'Diana cannot read profiles right now — its API key may have expired. Whoever runs the bot needs to look at it.',
        };
    }
    if (status === 429) {
        return {
            status: 503,
            reason: 'rate_limited',
            error: 'Riot is rate-limiting Diana at the moment. Try again in a minute.',
        };
    }
    return {
        status: 502,
        reason: 'upstream_error',
        error: 'Something went wrong talking to the game provider. Please try again later.',
    };
}

/**
 * The Riot client, built on first use and not before.
 *
 * `createLolService` throws when `RIOT_API_KEY` is unset, and this module is
 * imported by every deployment including the ones running Diana without a Riot
 * key at all. Building it at module scope - which is what `/link` does, because
 * a Discord command has no meaning without the key - would turn a missing
 * optional variable into a server that will not boot.
 */
let lolServiceInstance: ReturnType<typeof createLolService> | null = null;
function lolService(): ReturnType<typeof createLolService> | null {
    if (lolServiceInstance) return lolServiceInstance;
    try {
        lolServiceInstance = createLolService();
        return lolServiceInstance;
    } catch {
        return null;
    }
}

let r6ServiceInstance: ReturnType<typeof createR6Service> | null = null;
function r6Service(): ReturnType<typeof createR6Service> {
    // Unlike the Riot factory this one never throws — it falls back to the mock
    // service when unconfigured — so there is no null case to handle.
    r6ServiceInstance ??= createR6Service();
    return r6ServiceInstance;
}

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

        // Giving up the link gives up the polling that came with it. Without
        // this the enrolment outlives the link: nothing in Meeps would still
        // show the account, and the poller would go on spending a call on it
        // every interval for as long as the deployment lives.
        if (kind === 'r6_ubisoft') {
            await withdrawR6Enrolment(externalId).catch((err) =>
                console.error(
                    `[${timestamp()}] [identity] Unlinked ${externalId} but could not withdraw their enrolment:`,
                    err
                )
            );
        }

        res.json({ removed });
    } catch (err) {
        console.error(`[${timestamp()}] [identity] Unlink error:`, err);
        res.status(500).json({ error: 'Failed to unlink account' });
    }
}

/**
 * Undo what `enrolLinkedR6Player` did.
 *
 * Drops every squad enrolment, then deletes the player row only if that left
 * nobody at all tracking them. The count spans both rosters on purpose: an
 * account linked in Meeps *and* added by `/r6-add` in a Discord server is one
 * player with two independent reasons to be polled, and unlinking is a statement
 * about one of them. Deleting the row would cascade the other away.
 */
async function withdrawR6Enrolment(ubisoftId: string): Promise<void> {
    const dropped = await removeR6PlayerFromAllSquads(ubisoftId);
    if (dropped === 0) return;

    const remaining = await countTrackersOfR6Player(ubisoftId);
    if (remaining > 0) return;

    await deleteR6Player(ubisoftId);
    console.log(
        `[identity] ${ubisoftId} is no longer tracked by anyone; dropped the player row.`
    );
}

// ---------------------------------------------------------------------------
// Riot: the icon handshake, driven from Meeps
// ---------------------------------------------------------------------------

/**
 * Is this account already somebody else's?
 *
 * "Somebody else" is the question, not "anybody" - re-linking an account to the
 * person who already has it is how a trusted link is later upgraded to a
 * verified one, and refusing it would make the second attempt fail for the one
 * person entitled to make it.
 */
function belongsToAnother(
    resolved: {
        identityId: string | null;
        discordUserIds: string[];
        meepsUserIds: string[];
    },
    subject: ChallengeSubject
): boolean {
    if (!resolved.identityId) return false;
    const mine =
        subject.kind === 'discord_user'
            ? resolved.discordUserIds
            : resolved.meepsUserIds;
    return !mine.includes(subject.id);
}

/**
 * POST /api/identity/riot/challenge — start a handshake.
 *
 * Two Riot reads: the Riot ID becomes a puuid, then that account's current icon
 * is read so the challenge cannot name it. Asking for an icon they already have
 * would "verify" somebody who changed nothing, which is the whole reason
 * `chooseChallengeIcon` takes the current one.
 *
 * The response carries the icon's *picture* as well as its id, because the
 * League client's icon picker is a grid of images that shows an id nowhere -
 * telling a player to set icon #17 asks for something they cannot look up.
 */
export async function startRiotChallenge(
    req: Request,
    res: Response
): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subject = parseSubject(body);
    if (!subject) {
        res.status(400).json({ error: SUBJECT_ERROR, reason: 'bad_request' });
        return;
    }

    const gameName =
        typeof body.gameName === 'string' ? body.gameName.trim() : '';
    const tagLine = typeof body.tagLine === 'string' ? body.tagLine.trim() : '';
    if (!gameName || !tagLine) {
        res.status(400).json({
            error: 'gameName and tagLine are required',
            reason: 'bad_request',
        });
        return;
    }

    const requested =
        typeof body.region === 'string' && body.region.trim()
            ? body.region.trim().toUpperCase()
            : DEFAULT_REGION;
    if (!isKnownRegion(requested)) {
        res.status(400).json({
            error: `Unknown region ${requested}.`,
            reason: 'bad_request',
        });
        return;
    }

    const lol = lolService();
    if (!lol) {
        // Not a failure of the request. This deployment cannot verify anybody,
        // and saying so is more use than a 500 the caller will retry.
        res.status(503).json({
            error: 'This Diana has no Riot API key, so it cannot verify Riot accounts.',
            reason: 'no_riot_key',
        });
        return;
    }

    try {
        let account;
        try {
            account = await lol.getAccountByRiotId(
                gameName,
                tagLine,
                regionGroupFor(requested) as never
            );
        } catch (error) {
            const described = describeUpstreamError(error, 'account');
            console.error(
                `[${timestamp()}] [identity] Riot account lookup failed:`,
                error
            );
            res.status(described.status).json(described);
            return;
        }

        const existing = await resolveIdentity('riot_puuid', account.puuid);
        if (belongsToAnother(existing, subject)) {
            res.status(409).json({
                error: `${account.gameName}#${account.tagLine} is already linked to someone else. If it is yours, they need to unlink it first.`,
                reason: 'already_linked',
            });
            return;
        }

        let currentIcon: number | null = null;
        try {
            const profile = await lol.getSummonerByPUUID(
                account.puuid,
                requested as never
            );
            currentIcon = profile.profileIconId;
        } catch (error) {
            const described = describeUpstreamError(error, 'summoner');
            console.error(
                `[${timestamp()}] [identity] Riot profile read failed:`,
                error
            );
            res.status(described.status).json(described);
            return;
        }

        const requiredIcon = chooseChallengeIcon(currentIcon);
        const challenge = await createLinkChallenge(
            subject,
            {
                puuid: account.puuid,
                gameName: account.gameName,
                tagLine: account.tagLine,
                region: requested,
            },
            requiredIcon
        );

        console.log(
            `[identity] Opened a Riot challenge for ${subject.kind} ${subject.id}.`
        );
        res.json({
            puuid: account.puuid,
            gameName: account.gameName,
            tagLine: account.tagLine,
            region: requested,
            requiredIcon,
            // The synchronous builder, not `fetchProfileIconUrl`: this is one
            // more network call on a path that has already made two, and a
            // slightly stale Data Dragon version still serves every icon in the
            // 0-28 range. The version cache is warmed by everything else that
            // renders an icon.
            iconUrl: buildProfileIconUrl(requiredIcon),
            expiresAt: challenge.expires_at,
        });
    } catch (err) {
        console.error(`[${timestamp()}] [identity] Challenge error:`, err);
        res.status(500).json({
            error: 'Failed to start the link',
            reason: 'server_error',
        });
    }
}

/**
 * GET /api/identity/riot/challenge — the poll.
 *
 * Meeps has no `/link confirm`, so this and the resolve route are the whole
 * story it can tell: a challenge here means "still waiting on Riot", and the
 * challenge vanishing while `resolve` grows a puuid means the sweep finished it.
 *
 * 200 with `{ challenge: null }` rather than 404, for the same reason `resolve`
 * answers empty rather than missing — having no link in progress is the ordinary
 * state and should not arrive as an error.
 */
export async function getRiotChallenge(
    req: Request,
    res: Response
): Promise<void> {
    const subject = parseSubject({
        subjectKind: getParamValue(req.query.subjectKind as string | undefined),
        subjectId: getParamValue(req.query.subjectId as string | undefined),
    });
    if (!subject) {
        res.status(400).json({ error: SUBJECT_ERROR });
        return;
    }

    try {
        const challenge = await getLinkChallenge(subject);
        res.json({
            challenge: challenge
                ? {
                      puuid: challenge.puuid,
                      gameName: challenge.game_name,
                      tagLine: challenge.tag_line,
                      region: challenge.region,
                      requiredIcon: challenge.required_icon,
                      iconUrl: buildProfileIconUrl(challenge.required_icon),
                      expiresAt: challenge.expires_at,
                  }
                : null,
        });
    } catch (err) {
        console.error(`[${timestamp()}] [identity] Challenge read error:`, err);
        res.status(500).json({ error: 'Failed to read the link challenge' });
    }
}

/**
 * DELETE /api/identity/riot/challenge — give up on one.
 *
 * Idempotent, like every other delete here. The reason it exists at all is that
 * a 24-hour window is a long time to be stuck looking at instructions for an
 * account you have decided you typed wrong.
 */
export async function cancelRiotChallenge(
    req: Request,
    res: Response
): Promise<void> {
    const subject = parseSubject({
        subjectKind: getParamValue(req.query.subjectKind as string | undefined),
        subjectId: getParamValue(req.query.subjectId as string | undefined),
    });
    if (!subject) {
        res.status(400).json({ error: SUBJECT_ERROR });
        return;
    }

    try {
        await deleteLinkChallenge(subject);
        console.log(
            `[identity] Cancelled the Riot challenge for ${subject.kind} ${subject.id}.`
        );
        res.json({ cancelled: true });
    } catch (err) {
        console.error(
            `[${timestamp()}] [identity] Challenge cancel error:`,
            err
        );
        res.status(500).json({ error: 'Failed to cancel the link challenge' });
    }
}

// ---------------------------------------------------------------------------
// Siege: a link with no handshake behind it
// ---------------------------------------------------------------------------

/**
 * Space public ids from a link request. Absent, empty and malformed all mean
 * "no spaces", because none of them is a reason to refuse the link itself.
 */
function parseMeepsSpaceIds(body: Record<string, unknown>): string[] {
    const raw = body.meepsSpaceIds;
    if (!Array.isArray(raw)) return [];
    const ids = raw
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean);
    return [...new Set(ids)];
}

/**
 * Put a freshly linked Siege account onto the poller's work list.
 *
 * WHY THIS IS HERE AND NOT IN THE POLLER
 *
 * `getAllTrackedR6Players` is a read over two rosters; it does not enrol anyone.
 * Before 025 the only writer was `/r6-add`, so linking an account in Meeps
 * recorded who owned it and nothing ever polled it — the account was known and
 * invisible at the same time. This closes that: a link is now also an enrolment.
 *
 * WHY IT TAKES SPACE IDS RATHER THAN SQUAD IDS
 *
 * Diana owns the `(kind, external_id) -> squad` mapping and Meeps owns space
 * membership, so each side sends what it actually knows. This mirrors
 * `presenceService`, including the part that matters most: it resolves through
 * `squad_attachments` and **does not create the squad**. A space nobody has
 * attached is a setup step that has not happened, and self-attaching here would
 * hand a friend group with both a Discord guild and a Meeps space two squads —
 * matches under one, links under the other, every query healthy and empty.
 *
 * WHAT A FAILURE HERE COSTS
 *
 * Nothing that should fail the request. The link is the thing the person asked
 * for and it is already committed; enrolment is a consequence of it, and a
 * squad that could not be resolved is worth a log line rather than a 500 that
 * makes them think their account did not link. The next link attempt re-enrols.
 */
async function enrolLinkedR6Player(
    profile: {
        ubisoftId: string;
        gameName: string;
        platform: string;
        rank: { tier: string; division: number; rp: number };
    },
    spaceIds: string[],
    addedBy: string
): Promise<void> {
    // Read before the upsert: `ensureR6Player` is deliberately silent about
    // whether it inserted, and the opening rank history row is only honest for
    // a player we had never seen.
    const known = await getR6PlayerById(profile.ubisoftId);

    await ensureR6Player({
        ubisoftId: profile.ubisoftId,
        gameName: profile.gameName,
        platform: profile.platform,
        tier: profile.rank.tier,
        division: profile.rank.division,
        rp: profile.rank.rp,
    });

    if (!known) {
        await createR6RankHistory(
            `INIT_${profile.ubisoftId}`,
            profile.ubisoftId,
            profile.rank.tier,
            profile.rank.division,
            profile.rank.rp
        ).catch((err) =>
            console.error(
                `[identity] Failed to record initial rank for ${profile.ubisoftId}:`,
                err
            )
        );
    }

    const unattached: string[] = [];
    for (const spaceId of spaceIds) {
        const squadId = await getSquadIdForAttachment('meeps_space', spaceId);
        if (!squadId) {
            unattached.push(spaceId);
            continue;
        }
        await addR6PlayerToSquad(squadId, profile.ubisoftId, addedBy);
    }

    if (unattached.length > 0) {
        console.warn(
            `[identity] ${profile.gameName} linked, but ${unattached.length} space(s) ` +
                `are not attached to a squad, so no squad tracks them there: ` +
                unattached.join(', ')
        );
    }
}

/**
 * POST /api/identity/r6 — link a Siege account.
 *
 * The Ubisoft lookup is not verification and is not pretending to be. It does
 * two useful things: it turns a name into the `ubisoftId` that `r6_players` and
 * every R6 notification are keyed on, and it refuses a name that matches no
 * profile, which catches the typo that would otherwise become a permanent link
 * to nothing. What it cannot do is tell the owner from anybody else, so the row
 * it writes is `self_asserted` and `verified_at` stays null.
 *
 * Since 025 a successful link also enrols the account for polling against every
 * squad the caller's spaces resolve to — see `enrolLinkedR6Player`. The Ubisoft
 * call this handler already makes is the same one `/r6-add` spends to enrol
 * somebody, so the enrolment is free: no second request, no extra budget.
 */
export async function linkR6Account(
    req: Request,
    res: Response
): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subject = parseSubject(body);
    if (!subject) {
        res.status(400).json({ error: SUBJECT_ERROR, reason: 'bad_request' });
        return;
    }

    const gameName =
        typeof body.gameName === 'string' ? body.gameName.trim() : '';
    if (!gameName) {
        res.status(400).json({
            error: 'gameName is required',
            reason: 'bad_request',
        });
        return;
    }

    const platform =
        typeof body.platform === 'string' && body.platform.trim()
            ? body.platform.trim().toLowerCase()
            : 'uplay';
    if (!(R6_PLATFORMS as readonly string[]).includes(platform)) {
        res.status(400).json({
            error: `platform must be one of ${R6_PLATFORMS.join(', ')}.`,
            reason: 'bad_request',
        });
        return;
    }

    try {
        let profile;
        try {
            profile = await r6Service().getProfileByName(gameName, platform);
        } catch (error) {
            const described = describeUpstreamError(error, 'r6');
            console.error(
                `[${timestamp()}] [identity] Ubisoft lookup failed:`,
                error
            );
            res.status(described.status).json(described);
            return;
        }

        const existing = await resolveIdentity('r6_ubisoft', profile.ubisoftId);
        if (belongsToAnother(existing, subject)) {
            res.status(409).json({
                error: `${profile.gameName} is already linked to someone else. If it is yours, they need to unlink it first.`,
                reason: 'already_linked',
            });
            return;
        }

        const outcome = await createSelfAssertedLink(
            subject,
            'r6_ubisoft',
            profile.ubisoftId
        );
        if (!outcome.ok) {
            // `belongsToAnother` said no a moment ago, so this is a race rather
            // than the ordinary refusal. Same answer either way.
            res.status(409).json({
                error: `${profile.gameName} is already linked to someone else.`,
                reason: 'already_linked',
            });
            return;
        }

        console.log(
            `[identity] Linked r6_ubisoft ${profile.ubisoftId} to ${outcome.account.identity_id}.`
        );

        // After the link is committed and outside its success path's ability to
        // fail it — see the note on `enrolLinkedR6Player`.
        try {
            await enrolLinkedR6Player(
                profile,
                parseMeepsSpaceIds(body),
                subject.id
            );
        } catch (err) {
            console.error(
                `[${timestamp()}] [identity] Linked ${profile.ubisoftId} but could not enrol them for polling:`,
                err
            );
        }

        res.json({
            identityId: outcome.account.identity_id,
            account: outcome.account,
            player: {
                ubisoftId: profile.ubisoftId,
                gameName: profile.gameName,
                platform: profile.platform,
                rank: profile.rank,
            },
        });
    } catch (err) {
        console.error(`[${timestamp()}] [identity] R6 link error:`, err);
        res.status(500).json({
            error: 'Failed to link the Siege account',
            reason: 'server_error',
        });
    }
}

const router = Router();

router.use(requireMeepsSecret);
router.get('/resolve', resolveAccount);
// Every literal path goes above `/:identityId` and `/:kind/:externalId`, which
// would otherwise swallow them: Express matches in declaration order, so
// `GET /riot/challenge` registered after `/:identityId` never runs, and
// `DELETE /riot/challenge` would arrive at the unlink handler as kind "riot".
router.post('/riot/challenge', startRiotChallenge);
router.get('/riot/challenge', getRiotChallenge);
router.delete('/riot/challenge', cancelRiotChallenge);
router.post('/r6', linkR6Account);
router.post('/meeps-user', linkMeepsUser);
router.get('/:identityId', getIdentity);
router.delete('/:kind/:externalId', unlinkAccountRoute);

export const identityApiRouter = router;

/**
 * Unified identity - one person, many linked accounts (DN-3, roadmap §5.3).
 *
 * Diana knows puuids. Meeps knows its own users. Discord knows its own users.
 * This is the only thing that says any two of those are the same person, which
 * is why the recap cannot currently say the friend who left after game 5 is the
 * one who played Warwick, and why the Session Curve cannot compute win rate by
 * whether the player was in voice.
 *
 * Two rules run through everything here:
 *
 * 1. **An account belongs to exactly one person.** Enforced by the primary key
 *    on `(kind, external_id)`, so resolution never has to decide what a
 *    contested link means.
 * 2. **Unverified is a real state, not a failure.** A friend group that trusts
 *    each other should not have to do a handshake, so `verified_at` is nullable
 *    and callers that grant privileges check it rather than assuming it.
 */

// See the note in squadService: `db` is infrastructure misfiled under the
// League plugin. Imported where it lives rather than moved.
import { db } from '../../plugins/diana-league-bot/api/utils/db';

/** What kind of external account a link points at. */
export type IdentityAccountKind = 'riot_puuid' | 'discord_user' | 'meeps_user';

/** How a link was established. Null until it is verified at all. */
export type VerificationMethod = 'icon_handshake' | 'trusted' | 'rso';

/**
 * The methods that actually prove ownership.
 *
 * `trusted` is deliberately absent: it records *how* a link was made without
 * claiming anybody proved anything. Deriving `verified_at` from the presence of
 * a method rather than from this set is the easy mistake, and it would silently
 * mark every trusted link as verified - collapsing the one distinction that
 * lets a privilege check be stricter than a lookup.
 */
const VERIFYING_METHODS: readonly VerificationMethod[] = [
    'icon_handshake',
    'rso',
];

export interface IdentityAccount {
    kind: IdentityAccountKind;
    external_id: string;
    identity_id: string;
    verified_at: string | null;
    method: VerificationMethod | null;
    linked_at: string;
}

export interface LinkChallenge {
    discord_user_id: string;
    puuid: string;
    game_name: string;
    tag_line: string;
    region: string | null;
    required_icon: number;
    expires_at: string;
    created_at: string;
}

/**
 * How long a handshake stays open.
 *
 * Ten minutes: long enough to alt-tab, find the icon in a client that is
 * probably mid-game, and come back; short enough that an abandoned challenge
 * does not sit around holding a claim on somebody else's account.
 */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/**
 * The icons a challenge may ask for.
 *
 * A small hand-picked set of the free starter icons every account owns. Picking
 * from all ~5000 would frequently name one the player cannot select, which
 * fails verification for a reason they cannot see or fix.
 */
export const CHALLENGE_ICON_IDS = [
    588, 589, 590, 591, 592, 593, 594, 595, 596, 597,
] as const;

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

/** Every account belonging to the same person as this one. */
export const getAccountsForIdentity = async (
    identityId: string
): Promise<IdentityAccount[]> => {
    const result = await db.query(
        `SELECT kind, external_id, identity_id, verified_at, method, linked_at
           FROM identity_accounts
          WHERE identity_id = $1
          ORDER BY linked_at ASC`,
        [identityId]
    );
    return result.rows;
};

/** The link for one external account, or null if it has never been linked. */
export const getAccount = async (
    kind: IdentityAccountKind,
    externalId: string
): Promise<IdentityAccount | null> => {
    const result = await db.query(
        `SELECT kind, external_id, identity_id, verified_at, method, linked_at
           FROM identity_accounts
          WHERE kind = $1 AND external_id = $2`,
        [kind, externalId]
    );
    return result.rows[0] ?? null;
};

/**
 * The identity this account belongs to, creating one if it is new.
 *
 * The entry point for linking: the first account a person links creates their
 * identity, and every later one attaches to it.
 */
export const getOrCreateIdentityForAccount = async (
    kind: IdentityAccountKind,
    externalId: string
): Promise<string> => {
    const existing = await getAccount(kind, externalId);
    if (existing) return existing.identity_id;

    const created = await db.query(
        `INSERT INTO identities DEFAULT VALUES RETURNING identity_id`,
        []
    );
    const identityId: string = created.rows[0].identity_id;

    await db.query(
        `INSERT INTO identity_accounts (kind, external_id, identity_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (kind, external_id) DO NOTHING`,
        [kind, externalId, identityId]
    );

    // Re-read rather than trusting the insert. Two concurrent first-links for
    // the same account would each create an identity, and the loser's INSERT
    // does nothing - returning its own orphan id would split one person in two.
    const settled = await getAccount(kind, externalId);
    return settled?.identity_id ?? identityId;
};

export type LinkOutcome =
    | { ok: true; account: IdentityAccount }
    | { ok: false; reason: 'already_linked'; identityId: string };

/**
 * Attach an account to an identity.
 *
 * Refuses when the account already belongs to somebody else rather than moving
 * it. A contested link is a person to talk to, not a race to win, and silently
 * reassigning would let anyone capture a Riot account by linking it second.
 * Re-linking an account to the *same* identity is allowed and upgrades its
 * verification, which is how a trusted link later becomes a verified one.
 */
export const linkAccount = async (
    identityId: string,
    kind: IdentityAccountKind,
    externalId: string,
    verification?: { method: VerificationMethod; verifiedAt?: Date }
): Promise<LinkOutcome> => {
    const existing = await getAccount(kind, externalId);
    if (existing && existing.identity_id !== identityId) {
        return {
            ok: false,
            reason: 'already_linked',
            identityId: existing.identity_id,
        };
    }

    // Only a verifying method stamps verified_at. A trusted link records its
    // method and stays unverified, which is exactly what it is.
    const verifiedAt =
        verification && VERIFYING_METHODS.includes(verification.method)
            ? (verification.verifiedAt ?? new Date()).toISOString()
            : null;

    const result = await db.query(
        `INSERT INTO identity_accounts
             (kind, external_id, identity_id, verified_at, method)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (kind, external_id) DO UPDATE
             SET identity_id = EXCLUDED.identity_id,
                 -- Never downgrade. A re-link with no verification leaves an
                 -- already-verified account verified; re-verifying replaces it.
                 verified_at = COALESCE(EXCLUDED.verified_at,
                                        identity_accounts.verified_at),
                 method = COALESCE(EXCLUDED.method, identity_accounts.method)
         RETURNING kind, external_id, identity_id, verified_at, method, linked_at`,
        [kind, externalId, identityId, verifiedAt, verification?.method ?? null]
    );

    return { ok: true, account: result.rows[0] };
};

/** Detach one account. Returns whether there was anything to detach. */
export const unlinkAccount = async (
    kind: IdentityAccountKind,
    externalId: string
): Promise<boolean> => {
    const result = await db.query(
        `DELETE FROM identity_accounts WHERE kind = $1 AND external_id = $2`,
        [kind, externalId]
    );
    return (result.rowCount ?? 0) > 0;
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolvedIdentity {
    identityId: string | null;
    puuids: string[];
    discordUserIds: string[];
    meepsUserIds: string[];
    /** The subset of `puuids` whose link was actually verified. */
    verifiedPuuids: string[];
}

const EMPTY_RESOLUTION: ResolvedIdentity = {
    identityId: null,
    puuids: [],
    discordUserIds: [],
    meepsUserIds: [],
    verifiedPuuids: [],
};

/**
 * Everything linked to the same person as this account.
 *
 * The read the whole feature exists for: Meeps asks with a `meeps_user` and
 * gets back the puuids, which is the join the recap and the Session Curve need.
 *
 * An unlinked account resolves to an empty answer rather than an error. Not
 * being linked is the normal state for most people most of the time, and making
 * every caller handle it as a failure would be wrong.
 */
export const resolveIdentity = async (
    kind: IdentityAccountKind,
    externalId: string
): Promise<ResolvedIdentity> => {
    const account = await getAccount(kind, externalId);
    if (!account) return { ...EMPTY_RESOLUTION };

    const accounts = await getAccountsForIdentity(account.identity_id);
    const of = (k: IdentityAccountKind) =>
        accounts.filter((a) => a.kind === k).map((a) => a.external_id);

    return {
        identityId: account.identity_id,
        puuids: of('riot_puuid'),
        discordUserIds: of('discord_user'),
        meepsUserIds: of('meeps_user'),
        verifiedPuuids: accounts
            .filter((a) => a.kind === 'riot_puuid' && a.verified_at !== null)
            .map((a) => a.external_id),
    };
};

/** The Riot accounts belonging to whoever owns this Discord account. */
export const getPuuidsForDiscordUser = async (
    discordUserId: string
): Promise<string[]> =>
    (await resolveIdentity('discord_user', discordUserId)).puuids;

/** The Riot accounts belonging to whoever owns this Meeps account. */
export const getPuuidsForMeepsUser = async (
    meepsUserId: string
): Promise<string[]> =>
    (await resolveIdentity('meeps_user', meepsUserId)).puuids;

// ---------------------------------------------------------------------------
// The icon handshake
// ---------------------------------------------------------------------------

/**
 * Choose an icon to ask for, excluding the one they already have.
 *
 * The exclusion is the whole point. Picking at random from the set gives a
 * 1-in-10 chance of naming the current icon, and a "verification" that passes
 * on a player who changed nothing verifies nothing.
 *
 * Deterministic given `pickIndex`, so the tests do not have to stub randomness.
 */
export const chooseChallengeIcon = (
    currentIconId: number | null | undefined,
    pickIndex: number = Math.floor(Math.random() * CHALLENGE_ICON_IDS.length)
): number => {
    const options = CHALLENGE_ICON_IDS.filter((id) => id !== currentIconId);
    const safeIndex =
        ((Math.trunc(pickIndex) % options.length) + options.length) %
        options.length;
    return options[safeIndex];
};

/**
 * Open a handshake, replacing any challenge this person already had.
 *
 * One outstanding challenge per Discord user, so starting a second `/link`
 * abandons the first rather than leaving two live claims.
 */
export const createLinkChallenge = async (
    discordUserId: string,
    account: {
        puuid: string;
        gameName: string;
        tagLine: string;
        region?: string | null;
    },
    requiredIcon: number,
    now: number = Date.now()
): Promise<LinkChallenge> => {
    const expiresAt = new Date(now + CHALLENGE_TTL_MS).toISOString();

    const result = await db.query(
        `INSERT INTO identity_link_challenges
             (discord_user_id, puuid, game_name, tag_line, region,
              required_icon, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (discord_user_id) DO UPDATE
             SET puuid = EXCLUDED.puuid,
                 game_name = EXCLUDED.game_name,
                 tag_line = EXCLUDED.tag_line,
                 region = EXCLUDED.region,
                 required_icon = EXCLUDED.required_icon,
                 expires_at = EXCLUDED.expires_at,
                 created_at = NOW()
         RETURNING discord_user_id, puuid, game_name, tag_line, region,
                   required_icon, expires_at, created_at`,
        [
            discordUserId,
            account.puuid,
            account.gameName,
            account.tagLine,
            account.region ?? null,
            requiredIcon,
            expiresAt,
        ]
    );
    return result.rows[0];
};

/**
 * The open challenge for this person, or null.
 *
 * Expiry is applied here rather than left to the caller, and an expired row is
 * deleted on the way past: a challenge nobody finished is not state worth
 * keeping, and sweeping it on read means no cron has to.
 */
export const getLinkChallenge = async (
    discordUserId: string,
    now: number = Date.now()
): Promise<LinkChallenge | null> => {
    const result = await db.query(
        `SELECT discord_user_id, puuid, game_name, tag_line, region,
                required_icon, expires_at, created_at
           FROM identity_link_challenges
          WHERE discord_user_id = $1`,
        [discordUserId]
    );

    const challenge: LinkChallenge | undefined = result.rows[0];
    if (!challenge) return null;

    if (new Date(challenge.expires_at).getTime() <= now) {
        await deleteLinkChallenge(discordUserId);
        return null;
    }
    return challenge;
};

export const deleteLinkChallenge = async (
    discordUserId: string
): Promise<void> => {
    await db.query(
        `DELETE FROM identity_link_challenges WHERE discord_user_id = $1`,
        [discordUserId]
    );
};

export type VerifyOutcome =
    | { ok: true; puuid: string; identityId: string }
    | { ok: false; reason: 'no_challenge' }
    | { ok: false; reason: 'icon_mismatch'; expected: number; actual: number }
    | { ok: false; reason: 'already_linked'; identityId: string };

/**
 * Complete a handshake.
 *
 * Takes the observed icon rather than fetching it, so the decision is testable
 * without a Riot key and the Riot call stays at the command layer where its
 * failure can be reported in the player's own words.
 *
 * On success both accounts are linked to one identity - the Discord user and
 * the Riot account - because the point of the handshake is to establish that
 * they are the same person, and linking only one half would record none of it.
 */
export const verifyLinkChallenge = async (
    discordUserId: string,
    observedIconId: number,
    now: number = Date.now()
): Promise<VerifyOutcome> => {
    const challenge = await getLinkChallenge(discordUserId, now);
    if (!challenge) return { ok: false, reason: 'no_challenge' };

    if (challenge.required_icon !== observedIconId) {
        // Deliberately left open. A mismatch is nearly always "they have not
        // changed it yet", and deleting the challenge would make the fix
        // "start again" rather than "wait a moment and retry".
        return {
            ok: false,
            reason: 'icon_mismatch',
            expected: challenge.required_icon,
            actual: observedIconId,
        };
    }

    const identityId = await getOrCreateIdentityForAccount(
        'discord_user',
        discordUserId
    );

    const linked = await linkAccount(
        identityId,
        'riot_puuid',
        challenge.puuid,
        {
            method: 'icon_handshake',
            verifiedAt: new Date(now),
        }
    );

    if (!linked.ok) {
        return {
            ok: false,
            reason: 'already_linked',
            identityId: linked.identityId,
        };
    }

    await deleteLinkChallenge(discordUserId);
    return { ok: true, puuid: challenge.puuid, identityId };
};

/**
 * Link without verifying, for servers that have turned that on.
 *
 * Issue #142: "for friend-group servers a trust-based link (no verification) is
 * fine". It records `method = 'trusted'` and leaves `verified_at` null, so
 * anything that grants a privilege can still tell the difference.
 */
export const createTrustedLink = async (
    discordUserId: string,
    puuid: string
): Promise<LinkOutcome> => {
    const identityId = await getOrCreateIdentityForAccount(
        'discord_user',
        discordUserId
    );
    return linkAccount(identityId, 'riot_puuid', puuid, { method: 'trusted' });
};

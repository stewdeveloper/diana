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
export type IdentityAccountKind =
    | 'riot_puuid'
    | 'discord_user'
    | 'meeps_user'
    | 'r6_ubisoft';

/**
 * The kinds that identify a *person* rather than a game account.
 *
 * The distinction the challenge subject needs: a handshake attaches a Riot
 * account to somebody, and "somebody" can be a Discord user or a Meeps user but
 * never a puuid or a Ubisoft id.
 */
export type IdentitySubjectKind = 'discord_user' | 'meeps_user';

/** Who a link challenge is for. */
export interface ChallengeSubject {
    kind: IdentitySubjectKind;
    id: string;
}

/** How a link was established. Null until it is verified at all. */
export type VerificationMethod =
    | 'icon_handshake'
    | 'trusted'
    | 'rso'
    | 'self_asserted';

/**
 * The methods that actually prove ownership.
 *
 * `trusted` is deliberately absent: it records *how* a link was made without
 * claiming anybody proved anything. Deriving `verified_at` from the presence of
 * a method rather than from this set is the easy mistake, and it would silently
 * mark every trusted link as verified - collapsing the one distinction that
 * lets a privilege check be stricter than a lookup.
 *
 * `self_asserted` is absent for a stronger reason: for Siege there is no method
 * that could be present. Ubisoft publishes no OAuth and Siege has no profile
 * field a challenge could ask a player to change, so an r6_ubisoft link records
 * that somebody typed a name which resolved to a real profile, and nothing more.
 * A privilege check that trusted it would be trusting the claimant.
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
    subject_kind: IdentitySubjectKind;
    subject_id: string;
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
 * **Twenty-four hours, and the old ten minutes was a bug.** The window was sized
 * for how long a person takes to alt-tab and change an icon, which is the wrong
 * quantity: what has to fit inside it is how long *Riot* takes to admit the icon
 * changed. summoner-v4 serves cached data and that cache is not fast - reliably
 * longer than ten minutes, sometimes much longer - so the handshake was expiring
 * before it could possibly have succeeded, for everybody, every time.
 *
 * The original comment justified the short window as stopping an abandoned
 * challenge "holding a claim on somebody else's account". That was wrong too: a
 * challenge holds nothing. `identity_link_challenges` is keyed on the subject,
 * so two people can have an open challenge for the same puuid, and no link
 * exists until one of them verifies.
 *
 * The real cost of a long window is coincidence: the longer it stays open, the
 * more chance the account's owner independently sets the exact icon being asked
 * for and hands an attacker a verification. With the current icon excluded that
 * is one chance in twenty-eight *of the times they change it at all*, which is
 * a price worth paying to make the feature work. RSO removes the question
 * entirely and is still the real fix (roadmap gate 5).
 */
export const CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The icons a challenge may ask for.
 *
 * **These must be icons every account can actually select**, and that is a
 * narrower set than it looks. Data Dragon lists all ~5000 icons and says nothing
 * about ownership, so a URL resolving proves only that the picture exists —
 * most icons are event, mastery or purchase rewards, and naming one the player
 * does not own fails the handshake for a reason they can neither see nor fix.
 * There is no endpoint on the public API that answers "which icons does this
 * account own", so the set has to be one that needs no lookup.
 *
 * 0-28 is the original launch set: present on every account since the game
 * shipped, always selectable, and the range a brand-new account's default icon
 * comes from.
 *
 * An earlier version of this used 588-597 and described them in this comment as
 * "free starter icons every account owns". That was asserted rather than
 * checked, and it is wrong — they are reward icons, so the handshake asked most
 * players for something they could not set.
 */
export const CHALLENGE_ICON_IDS = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    21, 22, 23, 24, 25, 26, 27, 28,
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
    /**
     * Ubisoft profile ids. There is no `verifiedR6UbisoftIds` beside this and
     * there never will be - see `createSelfAssertedLink` - so a caller that
     * needs proof has to treat this list as unproven in full.
     */
    r6UbisoftIds: string[];
    /** The subset of `puuids` whose link was actually verified. */
    verifiedPuuids: string[];
}

const EMPTY_RESOLUTION: ResolvedIdentity = {
    identityId: null,
    puuids: [],
    discordUserIds: [],
    meepsUserIds: [],
    r6UbisoftIds: [],
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
        r6UbisoftIds: of('r6_ubisoft'),
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
 * Open a handshake, replacing any challenge this subject already had.
 *
 * One outstanding challenge per subject, so starting a second link abandons the
 * first rather than leaving two live claims.
 *
 * Per *subject*, not per person: somebody who exists as both a Discord user and
 * a Meeps user can have one of each, because those are two separate attempts
 * started from two separate places. Neither holds anything the other could
 * lose — see the note on `CHALLENGE_TTL_MS` — so the only cost of allowing both
 * is one extra summoner-v4 read per sweep tick, and the alternative is Meeps
 * silently cancelling a `/link start` somebody is in the middle of.
 */
export const createLinkChallenge = async (
    subject: ChallengeSubject,
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
             (subject_kind, subject_id, puuid, game_name, tag_line, region,
              required_icon, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (subject_kind, subject_id) DO UPDATE
             SET puuid = EXCLUDED.puuid,
                 game_name = EXCLUDED.game_name,
                 tag_line = EXCLUDED.tag_line,
                 region = EXCLUDED.region,
                 required_icon = EXCLUDED.required_icon,
                 expires_at = EXCLUDED.expires_at,
                 created_at = NOW()
         RETURNING subject_kind, subject_id, puuid, game_name, tag_line, region,
                   required_icon, expires_at, created_at`,
        [
            subject.kind,
            subject.id,
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
 * Every handshake still waiting, oldest first.
 *
 * For the sweep that finishes them. Expired rows are excluded here rather than
 * deleted, unlike `getLinkChallenge` - the sweep runs over the whole table and
 * deleting as a side effect of a read that happens every few minutes turns a
 * clean-up into something that races with a player's own `/link confirm`.
 */
export const getPendingLinkChallenges = async (
    now: number = Date.now()
): Promise<LinkChallenge[]> => {
    const result = await db.query(
        `SELECT subject_kind, subject_id, puuid, game_name, tag_line, region,
                required_icon, expires_at, created_at
           FROM identity_link_challenges
          WHERE expires_at > $1
          ORDER BY created_at ASC`,
        [new Date(now).toISOString()]
    );
    return result.rows;
};

/** Drop handshakes nobody finished. Called by the sweep, not by a read. */
export const deleteExpiredLinkChallenges = async (
    now: number = Date.now()
): Promise<number> => {
    const result = await db.query(
        `DELETE FROM identity_link_challenges WHERE expires_at <= $1`,
        [new Date(now).toISOString()]
    );
    return result.rowCount ?? 0;
};

/**
 * The open challenge for this subject, or null.
 *
 * Expiry is applied here rather than left to the caller, and an expired row is
 * deleted on the way past: a challenge nobody finished is not state worth
 * keeping, and sweeping it on read means no cron has to.
 *
 * This is also Meeps' poll. A Meeps client has no `/link confirm` to run and no
 * DM to receive, so "is my handshake still open" is the only question it can
 * ask, and the answer going from a row to null is how it learns the sweep
 * finished the job.
 */
export const getLinkChallenge = async (
    subject: ChallengeSubject,
    now: number = Date.now()
): Promise<LinkChallenge | null> => {
    const result = await db.query(
        `SELECT subject_kind, subject_id, puuid, game_name, tag_line, region,
                required_icon, expires_at, created_at
           FROM identity_link_challenges
          WHERE subject_kind = $1 AND subject_id = $2`,
        [subject.kind, subject.id]
    );

    const challenge: LinkChallenge | undefined = result.rows[0];
    if (!challenge) return null;

    if (new Date(challenge.expires_at).getTime() <= now) {
        await deleteLinkChallenge(subject);
        return null;
    }
    return challenge;
};

export const deleteLinkChallenge = async (
    subject: ChallengeSubject
): Promise<void> => {
    await db.query(
        `DELETE FROM identity_link_challenges
          WHERE subject_kind = $1 AND subject_id = $2`,
        [subject.kind, subject.id]
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
 * On success both accounts are linked to one identity - the subject and the
 * Riot account - because the point of the handshake is to establish that they
 * are the same person, and linking only one half would record none of it.
 *
 * `getOrCreateIdentityForAccount` on the subject is what makes a Meeps-started
 * link land on the *existing* person rather than a new one: a Meeps user who has
 * already been attached to their Discord identity resolves to that identity, so
 * the puuid joins everything else they own. Somebody with no Discord account
 * gets a fresh identity, which is correct - there is nothing to join them to.
 */
export const verifyLinkChallenge = async (
    subject: ChallengeSubject,
    observedIconId: number,
    now: number = Date.now()
): Promise<VerifyOutcome> => {
    const challenge = await getLinkChallenge(subject, now);
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
        subject.kind,
        subject.id
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

    await deleteLinkChallenge(subject);
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

/**
 * Link a Siege account to whoever this subject is.
 *
 * **There is no verified version of this and there cannot be one.** Ubisoft
 * publishes no OAuth, and Siege has no profile field a challenge could ask a
 * player to change, so nothing on either side of this call can distinguish the
 * account's owner from somebody who typed their name. `self_asserted` is the
 * honest record of that and is not a verifying method, so `verified_at` stays
 * null and any check stricter than a lookup will keep refusing it.
 *
 * What it *is* good for is the thing 020 could not do: routing. An R6 rank
 * change arrives keyed on a `ubisoftId`, and this is the only row that says
 * which person that is - which is enough to put the notification in front of
 * them, a decision that grants nothing and costs nothing if the claim is wrong.
 *
 * The primary key still means one Siege account belongs to one person, so
 * claiming somebody else's is refused rather than allowed to move it.
 */
export const createSelfAssertedLink = async (
    subject: ChallengeSubject,
    kind: Extract<IdentityAccountKind, 'r6_ubisoft'>,
    externalId: string
): Promise<LinkOutcome> => {
    const identityId = await getOrCreateIdentityForAccount(
        subject.kind,
        subject.id
    );
    return linkAccount(identityId, kind, externalId, {
        method: 'self_asserted',
    });
};

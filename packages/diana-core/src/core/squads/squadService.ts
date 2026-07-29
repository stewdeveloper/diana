/**
 * Squads - the portable scope (DN-2).
 *
 * A squad is a group of people. A Discord guild and a Meeps space are
 * *attachments* to it: destinations where that squad is reachable. The squad
 * owns the roster and the identity; each attachment owns its own delivery
 * configuration (for Discord, that is `guild_config`).
 *
 * This lives in core/ rather than under the League plugin because the scope is
 * game-agnostic - Apex needs it too, and a Meeps space is not a League concept.
 */

// `db` is a bare pg.Pool wrapper - infrastructure, already re-exported from the
// core barrel, but misfiled under the League plugin. Moving it would touch 31
// imports for no benefit to this change, so it is imported where it lives.
import { db } from '../../plugins/diana-league-bot/api/utils/db';

export type SquadAttachmentKind = 'discord_guild' | 'meeps_space';

export const SQUAD_ATTACHMENT_KINDS: readonly SquadAttachmentKind[] = [
    'discord_guild',
    'meeps_space',
];

export function isSquadAttachmentKind(
    value: unknown
): value is SquadAttachmentKind {
    return (
        typeof value === 'string' &&
        (SQUAD_ATTACHMENT_KINDS as readonly string[]).includes(value)
    );
}

export interface Squad {
    squad_id: string;
    name: string | null;
    created_at: string;
}

export interface SquadAttachment {
    kind: SquadAttachmentKind;
    external_id: string;
    squad_id: string;
    attached_at: string;
}

export interface SquadSummonerRow {
    squad_id: string;
    puuid: string;
    gameName: string;
    tagLine: string;
    region: string;
    tier: string;
    rank: string;
    lp: number;
    deepLolLink: string | null;
    matchRegionPrefix: string;
    regionGroup: string;
    added_by: string | null;
    added_at: string;
}

// ---------------------------------------------------------------------------
// Squads
// ---------------------------------------------------------------------------

export const getSquad = async (squadId: string): Promise<Squad | null> => {
    const result = await db.query(
        `SELECT squad_id, name, created_at FROM squads WHERE squad_id = $1`,
        [squadId]
    );
    return result.rows[0] ?? null;
};

export const createSquad = async (name?: string | null): Promise<Squad> => {
    const result = await db.query(
        `INSERT INTO squads (name) VALUES ($1)
         RETURNING squad_id, name, created_at`,
        [name ?? null]
    );
    return result.rows[0];
};

export const renameSquad = async (
    squadId: string,
    name: string | null
): Promise<Squad | null> => {
    const result = await db.query(
        `UPDATE squads SET name = $2 WHERE squad_id = $1
         RETURNING squad_id, name, created_at`,
        [squadId, name]
    );
    return result.rows[0] ?? null;
};

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export const getSquadIdForAttachment = async (
    kind: SquadAttachmentKind,
    externalId: string
): Promise<string | null> => {
    const result = await db.query(
        `SELECT squad_id FROM squad_attachments
         WHERE kind = $1 AND external_id = $2`,
        [kind, externalId]
    );
    return result.rows[0]?.squad_id ?? null;
};

/**
 * Resolve an attachment to its squad, creating both if this is the first time
 * we have seen it. This is what makes a Discord guild self-attach on first use:
 * no migration step, no setup command.
 */
export const getOrCreateSquadForAttachment = async (
    kind: SquadAttachmentKind,
    externalId: string,
    name?: string | null
): Promise<string> => {
    const existing = await getSquadIdForAttachment(kind, externalId);
    if (existing) return existing;

    const squad = await createSquad(name);

    const attached = await db.query(
        `INSERT INTO squad_attachments (kind, external_id, squad_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (kind, external_id) DO NOTHING
         RETURNING squad_id`,
        [kind, externalId, squad.squad_id]
    );
    if (attached.rows.length > 0) return squad.squad_id;

    // Lost a race: a concurrent caller attached this external id first. Drop the
    // squad we just created - it has no attachments and no roster - and use
    // theirs, so the (kind, external_id) -> squad mapping stays single-valued.
    await db.query(`DELETE FROM squads WHERE squad_id = $1`, [squad.squad_id]);
    const winner = await getSquadIdForAttachment(kind, externalId);
    if (!winner) {
        throw new Error(
            `Failed to resolve squad for ${kind}:${externalId} after losing an attachment race`
        );
    }
    return winner;
};

/**
 * Attach an external destination to a squad.
 *
 * Returns null when the destination is already attached to a *different* squad;
 * re-attaching to the same squad succeeds, so callers can retry safely. The
 * (kind, external_id) primary key is what guarantees resolution stays
 * unambiguous, and this is where that guarantee is enforced.
 */
export const attachToSquad = async (
    squadId: string,
    kind: SquadAttachmentKind,
    externalId: string
): Promise<SquadAttachment | null> => {
    const result = await db.query(
        `INSERT INTO squad_attachments (kind, external_id, squad_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (kind, external_id) DO UPDATE
             SET squad_id = EXCLUDED.squad_id
             WHERE squad_attachments.squad_id = EXCLUDED.squad_id
         RETURNING kind, external_id, squad_id, attached_at`,
        [kind, externalId, squadId]
    );
    return result.rows[0] ?? null;
};

export const detachAttachment = async (
    kind: SquadAttachmentKind,
    externalId: string
): Promise<boolean> => {
    const result = await db.query(
        `DELETE FROM squad_attachments
         WHERE kind = $1 AND external_id = $2
         RETURNING external_id`,
        [kind, externalId]
    );
    return result.rowCount !== null && result.rowCount > 0;
};

export const getSquadAttachments = async (
    squadId: string
): Promise<SquadAttachment[]> => {
    const result = await db.query(
        `SELECT kind, external_id, squad_id, attached_at
         FROM squad_attachments
         WHERE squad_id = $1
         ORDER BY attached_at ASC`,
        [squadId]
    );
    return result.rows;
};

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export const addSummonerToSquad = async (
    squadId: string,
    puuid: string,
    addedBy?: string | null
): Promise<void> => {
    await db.query(
        `INSERT INTO squad_summoners (squad_id, puuid, added_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (squad_id, puuid) DO NOTHING`,
        [squadId, puuid, addedBy ?? null]
    );
};

export const removeSummonerFromSquad = async (
    squadId: string,
    puuid: string
): Promise<boolean> => {
    const result = await db.query(
        `DELETE FROM squad_summoners WHERE squad_id = $1 AND puuid = $2
         RETURNING puuid`,
        [squadId, puuid]
    );
    return result.rowCount !== null && result.rowCount > 0;
};

export const getSummonersForSquad = async (
    squadId: string
): Promise<SquadSummonerRow[]> => {
    const result = await db.query(
        `SELECT ss.squad_id, ss.puuid, ss.added_by, ss.added_at,
                s."gameName", s."tagLine", s."region", s."tier", s."rank", s."lp",
                s."deepLolLink", s."matchRegionPrefix", s."regionGroup"
         FROM squad_summoners ss
         JOIN summoners s ON s.puuid = ss.puuid
         WHERE ss.squad_id = $1
           AND s.game_id = 'league_of_legends'
         ORDER BY s."gameName" ASC`,
        [squadId]
    );
    return result.rows;
};

export const isSummonerInSquad = async (
    squadId: string,
    puuid: string
): Promise<boolean> => {
    const result = await db.query(
        `SELECT 1 FROM squad_summoners WHERE squad_id = $1 AND puuid = $2`,
        [squadId, puuid]
    );
    return result.rowCount !== null && result.rowCount > 0;
};

/**
 * Every squad tracking this player.
 *
 * The poller calls this once per tracked player per tick to stamp `squadId` on
 * the events it emits, which is why `squad_summoners` is indexed on puuid.
 */
export const getSquadsTrackingPuuid = async (
    puuid: string
): Promise<string[]> => {
    const result = await db.query(
        `SELECT squad_id FROM squad_summoners WHERE puuid = $1
         ORDER BY squad_id ASC`,
        [puuid]
    );
    return result.rows.map((row: { squad_id: string }) => row.squad_id);
};

export const getAllSquadTrackedPuuids = async (): Promise<string[]> => {
    const result = await db.query(
        `SELECT DISTINCT ss.puuid
         FROM squad_summoners ss
         JOIN summoners s ON s.puuid = ss.puuid
         WHERE s.game_id = 'league_of_legends'`,
        []
    );
    return result.rows.map((row: { puuid: string }) => row.puuid);
};

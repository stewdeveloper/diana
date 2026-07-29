/**
 * Presence storage and consent (DN-5).
 *
 * The consent check lives here rather than in the API layer on purpose: it is
 * the single choke point every write passes through, so there is no route,
 * script or future caller that can bypass it by accident.
 */

// See the note in squadService: `db` is infrastructure misfiled under the
// League plugin. Imported where it lives rather than moved.
import { db } from '../../plugins/diana-league-bot/api/utils/db';
import type { MeepsEvent, MeepsEventType } from '../presenceTypes';

export interface PresenceConsent {
    meeps_user_id: string;
    squad_id: string;
    opted_in: boolean;
    updated_at: string;
}

export interface PresenceEventRow {
    event_id: string;
    type: MeepsEventType;
    squad_id: string;
    meeps_user_id: string;
    puuid: string | null;
    channel_id: string | null;
    queue_id: number | null;
    match_id: string | null;
    occurred_at: string;
    received_at: string;
    payload: unknown;
}

/** What happened to an inbound event. Reported back so Meeps can log it. */
export type PresenceIngestOutcome =
    | 'stored'
    | 'duplicate'
    | 'not_consented'
    | 'unknown_squad';

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * Whether this person has opted in to presence collection for this squad.
 *
 * A missing row means no. Consent is per squad, not global: being happy for
 * your Tuesday group to see when you were in voice does not mean being happy
 * for a different group to.
 */
export const hasPresenceConsent = async (
    meepsUserId: string,
    squadId: string
): Promise<boolean> => {
    const result = await db.query(
        `SELECT opted_in FROM presence_consent
         WHERE meeps_user_id = $1 AND squad_id = $2`,
        [meepsUserId, squadId]
    );
    return result.rows[0]?.opted_in === true;
};

export const setPresenceConsent = async (
    meepsUserId: string,
    squadId: string,
    optedIn: boolean
): Promise<PresenceConsent> => {
    const result = await db.query(
        `INSERT INTO presence_consent (meeps_user_id, squad_id, opted_in)
         VALUES ($1, $2, $3)
         ON CONFLICT (meeps_user_id, squad_id) DO UPDATE
             SET opted_in = EXCLUDED.opted_in, updated_at = NOW()
         RETURNING meeps_user_id, squad_id, opted_in, updated_at`,
        [meepsUserId, squadId, optedIn]
    );
    return result.rows[0];
};

/** Every squad this person has an explicit consent decision for. */
export const getPresenceConsentForUser = async (
    meepsUserId: string
): Promise<PresenceConsent[]> => {
    const result = await db.query(
        `SELECT meeps_user_id, squad_id, opted_in, updated_at
         FROM presence_consent
         WHERE meeps_user_id = $1
         ORDER BY updated_at DESC`,
        [meepsUserId]
    );
    return result.rows;
};

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

const squadExists = async (squadId: string): Promise<boolean> => {
    const result = await db.query(`SELECT 1 FROM squads WHERE squad_id = $1`, [
        squadId,
    ]);
    return result.rowCount !== null && result.rowCount > 0;
};

/**
 * Store one presence event.
 *
 * Returns an outcome rather than throwing, because none of these conditions is
 * an error the sender should retry: a duplicate means it already succeeded, and
 * a missing opt-in means it should stop sending rather than try again.
 *
 * Note the ordering - consent is checked before anything is written, so a
 * non-consented event leaves no trace at all, not even a rejected row.
 */
export const storePresenceEvent = async (
    event: MeepsEvent
): Promise<PresenceIngestOutcome> => {
    if (!(await squadExists(event.squadId))) return 'unknown_squad';
    if (!(await hasPresenceConsent(event.meepsUserId, event.squadId))) {
        return 'not_consented';
    }

    const channelId =
        event.type === 'voice.joined' || event.type === 'voice.left'
            ? event.channelId
            : null;
    const queueId =
        event.type === 'client.in_champ_select' ||
        event.type === 'client.in_game'
            ? (event.queueId ?? null)
            : null;
    const matchId =
        event.type === 'client.in_game' ? (event.matchId ?? null) : null;

    const result = await db.query(
        `INSERT INTO presence_events
             (event_id, type, squad_id, meeps_user_id, puuid,
              channel_id, queue_id, match_id, occurred_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [
            event.eventId,
            event.type,
            event.squadId,
            event.meepsUserId,
            event.puuid ?? null,
            channelId,
            queueId,
            matchId,
            new Date(event.occurredAt).toISOString(),
            JSON.stringify(event),
        ]
    );

    return result.rows.length > 0 ? 'stored' : 'duplicate';
};

// ---------------------------------------------------------------------------
// Reads, export and erasure
// ---------------------------------------------------------------------------

/**
 * A squad's presence in time order. This is what the session service (DN-6)
 * sessionises.
 */
export const getPresenceForSquad = async (
    squadId: string,
    sinceIso?: string,
    untilIso?: string
): Promise<PresenceEventRow[]> => {
    const params: string[] = [squadId];
    let window = '';
    if (sinceIso) {
        params.push(sinceIso);
        window += ` AND occurred_at >= $${params.length}`;
    }
    if (untilIso) {
        params.push(untilIso);
        window += ` AND occurred_at <= $${params.length}`;
    }

    const result = await db.query(
        `SELECT event_id, type, squad_id, meeps_user_id, puuid, channel_id,
                queue_id, match_id, occurred_at, received_at, payload
         FROM presence_events
         WHERE squad_id = $1${window}
         ORDER BY occurred_at ASC`,
        params
    );
    return result.rows;
};

/**
 * Everything held about one person, for the export half of "visible, revocable,
 * exportable".
 */
export const exportPresenceForUser = async (
    meepsUserId: string
): Promise<{
    meepsUserId: string;
    consent: PresenceConsent[];
    events: PresenceEventRow[];
}> => {
    const events = await db.query(
        `SELECT event_id, type, squad_id, meeps_user_id, puuid, channel_id,
                queue_id, match_id, occurred_at, received_at, payload
         FROM presence_events
         WHERE meeps_user_id = $1
         ORDER BY occurred_at ASC`,
        [meepsUserId]
    );
    return {
        meepsUserId,
        consent: await getPresenceConsentForUser(meepsUserId),
        events: events.rows,
    };
};

/**
 * Erase one person's presence, optionally scoped to a single squad.
 *
 * Revocation has to actually delete. Flipping `opted_in` to false stops
 * collection but leaves the history, and "revocable" that keeps the data is not
 * revocable. Callers that want to stop future collection *and* erase the past
 * call `setPresenceConsent(..., false)` and then this.
 */
export const deletePresenceForUser = async (
    meepsUserId: string,
    squadId?: string
): Promise<number> => {
    const params: string[] = [meepsUserId];
    let scope = '';
    if (squadId) {
        params.push(squadId);
        scope = ` AND squad_id = $${params.length}`;
    }

    const result = await db.query(
        `DELETE FROM presence_events WHERE meeps_user_id = $1${scope}`,
        params
    );
    return result.rowCount ?? 0;
};

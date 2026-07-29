/**
 * The Meeps → Diana presence contract (DN-5).
 *
 * `eventTypes.ts` is the outbound half: facts Diana knows about matches and
 * ranks, pushed to Meeps. This is the return path. Diana holds the match data
 * and is therefore the side that has to join it to presence, so presence has to
 * come here rather than the join happening in Meeps.
 *
 * Presence alone is not interesting. Presence joined to match outcomes is the
 * whole of Session Recap, the Session Curve and Squad Wrapped - the things no
 * competitor can compute, because no competitor owns both halves.
 *
 * IDEMPOTENCY
 * Same rule as the outbound direction: `eventId` is derived from the domain,
 * never random. A person joins a given voice channel in a given squad at a
 * given instant exactly once, so (type, squadId, meepsUserId, occurredAt) is a
 * natural key. Meeps may retry; `ON CONFLICT (event_id) DO NOTHING` makes that
 * safe.
 *
 * CONSENT
 * Voice presence is personal data about when someone was at their computer and
 * with whom. It is opt-in, default off, and enforced at ingestion rather than
 * at read time - see `presenceService`. Roadmap §8.1 and trap 6.
 */

export type MeepsEventType =
    | 'voice.joined'
    | 'voice.left'
    | 'client.in_champ_select'
    | 'client.in_game';

export const MEEPS_EVENT_TYPES: readonly MeepsEventType[] = [
    'voice.joined',
    'voice.left',
    'client.in_champ_select',
    'client.in_game',
];

export function isMeepsEventType(value: unknown): value is MeepsEventType {
    return (
        typeof value === 'string' &&
        (MEEPS_EVENT_TYPES as readonly string[]).includes(value)
    );
}

export interface MeepsEventBase {
    /** Deterministic idempotency key. See `buildPresenceEventId`. */
    eventId: string;
    type: MeepsEventType;
    /** ISO 8601. When it happened, not when we received it. */
    occurredAt: string;
    /**
     * The portable scope (DN-2), resolved.
     *
     * Meeps does not have to know this value. It may send `meepsSpaceId`
     * instead and let Diana resolve it through `squad_attachments` - see
     * `resolvePresenceScope`. By the time an event reaches validation the scope
     * is always a real squad id, so the idempotency key never depends on which
     * form the sender used.
     */
    squadId: string;
    /**
     * The Meeps space this presence happened in, as Meeps knows it.
     *
     * Carried through to the stored payload for provenance: it is the only
     * record of *which* attachment resolved to this squad, and a space can be
     * re-attached to a different squad later.
     */
    meepsSpaceId?: string;
    /** Meeps' own user id. The person, as Meeps knows them. */
    meepsUserId: string;
    /**
     * Riot PUUID, when Meeps knows it.
     *
     * Optional on purpose: DN-3 (verified account linking) is not built, so the
     * link between a Meeps user and a Riot account is not yet authoritative.
     * Presence is still worth storing without it - the session service can join
     * on `meepsUserId` alone for voice-shaped questions, and gains the match
     * join later for free once identities land.
     */
    puuid?: string;
}

export interface VoiceJoinedEvent extends MeepsEventBase {
    type: 'voice.joined';
    channelId: string;
}

export interface VoiceLeftEvent extends MeepsEventBase {
    type: 'voice.left';
    channelId: string;
}

export interface ClientInChampSelectEvent extends MeepsEventBase {
    type: 'client.in_champ_select';
    queueId?: number;
}

export interface ClientInGameEvent extends MeepsEventBase {
    type: 'client.in_game';
    queueId?: number;
    /** Riot match id, when the local client already knows it. */
    matchId?: string;
}

export type MeepsEvent =
    | VoiceJoinedEvent
    | VoiceLeftEvent
    | ClientInChampSelectEvent
    | ClientInGameEvent;

/**
 * Deterministic id for a presence event.
 *
 * `occurredAt` is part of the key rather than a received-at timestamp: the same
 * event redelivered carries the same `occurredAt`, whereas two genuinely
 * different joins by the same person are seconds apart and key differently.
 *
 * Normalised through `Date` so that `2026-07-29T18:00:00Z` and
 * `2026-07-29T18:00:00.000Z` - the same instant, spelled two ways - cannot
 * produce two rows.
 */
export function buildPresenceEventId(
    type: MeepsEventType,
    squadId: string,
    meepsUserId: string,
    occurredAt: string
): string {
    const normalised = new Date(occurredAt);
    const stamp = Number.isNaN(normalised.getTime())
        ? occurredAt
        : normalised.toISOString();
    return `${type}:${squadId}:${meepsUserId}:${stamp}`;
}

export interface PresenceValidationResult {
    ok: boolean;
    /** Present when ok is false. Safe to return to the caller verbatim. */
    error?: string;
    event?: MeepsEvent;
}

/**
 * Validate an inbound presence event.
 *
 * Rejects rather than coerces. A malformed event will be malformed on every
 * retry, so the endpoint answers 4xx and Meeps is expected not to retry it -
 * the same contract Diana's own outbound adapter follows in the other
 * direction.
 */
export function validatePresenceEvent(
    input: unknown
): PresenceValidationResult {
    if (typeof input !== 'object' || input === null) {
        return { ok: false, error: 'Event must be an object' };
    }

    const e = input as Record<string, unknown>;

    if (!isMeepsEventType(e.type)) {
        return {
            ok: false,
            error: `type must be one of: ${MEEPS_EVENT_TYPES.join(', ')}`,
        };
    }
    if (typeof e.squadId !== 'string' || !e.squadId.trim()) {
        return { ok: false, error: 'squadId is required' };
    }
    if (typeof e.meepsUserId !== 'string' || !e.meepsUserId.trim()) {
        return { ok: false, error: 'meepsUserId is required' };
    }
    if (typeof e.occurredAt !== 'string' || !e.occurredAt.trim()) {
        return { ok: false, error: 'occurredAt is required' };
    }
    if (Number.isNaN(new Date(e.occurredAt).getTime())) {
        return { ok: false, error: 'occurredAt is not a valid date' };
    }
    if (
        (e.type === 'voice.joined' || e.type === 'voice.left') &&
        (typeof e.channelId !== 'string' || !e.channelId.trim())
    ) {
        return { ok: false, error: `channelId is required for ${e.type}` };
    }
    if (e.puuid !== undefined && typeof e.puuid !== 'string') {
        return { ok: false, error: 'puuid must be a string when present' };
    }
    if (e.meepsSpaceId !== undefined && typeof e.meepsSpaceId !== 'string') {
        return {
            ok: false,
            error: 'meepsSpaceId must be a string when present',
        };
    }
    if (e.queueId !== undefined && typeof e.queueId !== 'number') {
        return { ok: false, error: 'queueId must be a number when present' };
    }

    // The id is rebuilt rather than trusted. A sender that computes it
    // differently - or omits it - would otherwise defeat deduplication, and the
    // inputs are all present and validated by this point anyway.
    const event = {
        ...e,
        eventId: buildPresenceEventId(
            e.type,
            e.squadId,
            e.meepsUserId,
            e.occurredAt
        ),
    } as MeepsEvent;

    return { ok: true, event };
}

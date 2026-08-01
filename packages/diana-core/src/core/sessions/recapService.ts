/**
 * Session Recap - what a finished night is worth saying about it (roadmap §7.1).
 *
 * `sessionService` owns the rows; this owns the announcement. The split follows
 * the one DN-6 made between `sessionise` and `sessionService`: the parts that
 * are judgement calls - when a night counts as settled, which game was the best
 * one, what the card carries - belong somewhere they can be tested without a
 * database or a clock.
 *
 * The sweep that drives this is in `recapSweep.ts`.
 */

import { db } from '../../plugins/diana-league-bot/api/utils/db';
import {
    buildSessionEventId,
    DIANA_EVENT_SCHEMA_VERSION,
    type SessionCompletedEvent,
    type SessionLowPoint,
    type SessionMatchSummary,
    type SessionParticipantSummary,
    type SessionStandout,
} from '../eventTypes';
import { notHiddenPredicate } from '../privacy/privacyService';
import { DEFAULT_IDLE_GAP_MS } from './sessionise';
import type { SessionDetail } from './sessionService';

/**
 * A night whose recap is due.
 *
 * Carried as its own row rather than a full `SessionRow` because the sweep only
 * needs enough to fetch the detail and key the event.
 */
export interface SettledSession {
    session_id: string;
    squad_id: string;
    started_at: string;
    ended_at: string;
}

/**
 * Nights that have finished, settled, and not yet been announced.
 *
 * "Settled" is the whole subtlety of this feature. `sessionisePresence` sets
 * `endedAt` the instant the last person leaves, but a rejoin inside
 * `idleGapMs` merges back into the same night and moves `endedAt` later. So a
 * session is only safely finished once the gap has fully elapsed with nothing
 * happening - announcing at `ended_at` would routinely announce nights that
 * were still going.
 *
 * The comparison is strict (`<`), matching `groupIntoSessions`, which continues
 * a session on a gap of exactly `idleGapMs` (`<=`). A rejoin landing precisely
 * on the boundary therefore extends the night rather than racing the recap.
 */
export const findSettledSessions = async (
    now: number = Date.now(),
    idleGapMs: number = DEFAULT_IDLE_GAP_MS
): Promise<SettledSession[]> => {
    const settledBefore = new Date(now - idleGapMs).toISOString();

    const result = await db.query(
        `SELECT session_id, squad_id, started_at, ended_at
           FROM sessions
          WHERE recap_emitted_at IS NULL
            AND ended_at IS NOT NULL
            AND ended_at < $1
          ORDER BY ended_at ASC`,
        [settledBefore]
    );
    return result.rows;
};

/** Records that a night has been announced. Called only on confirmed delivery. */
export const markRecapEmitted = async (sessionId: string): Promise<void> => {
    await db.query(
        `UPDATE sessions SET recap_emitted_at = NOW() WHERE session_id = $1`,
        [sessionId]
    );
};

// ---------------------------------------------------------------------------
// Standouts
// ---------------------------------------------------------------------------

/** One squad player's score in one game of the session. */
interface ScoredEntry {
    matchId: string;
    gameIndex: number;
    puuid: string;
    summonerName: string | null;
    score: number;
    placement: number | null;
}

export interface SessionStandouts {
    bestGame?: SessionStandout;
    worstGame?: SessionLowPoint;
}

/**
 * Every score the squad's own players earned during the night.
 *
 * Restricted to `squadPuuids` deliberately. `match_scores` holds all ten players
 * in a lobby, and the best performance in the room is very often a stranger's -
 * which is not what "best game" means on a card about five friends.
 *
 * Players who opted out of rankings (DN-3) are excluded here rather than after
 * `pickStandouts`, so that a hidden player's score cannot win best game and
 * leave the card with no best game at all. Filtering afterwards would silently
 * turn one person's privacy choice into a missing line for everyone.
 *
 * The night's *shape* - its games, its record, who was in voice - is unaffected.
 * Opting out means not being named in a ranking, not being erased from the
 * evening.
 */
const getSessionScores = async (
    sessionId: string,
    squadPuuids: string[]
): Promise<ScoredEntry[]> => {
    if (squadPuuids.length === 0) return [];

    const result = await db.query(
        `SELECT sm.match_id                AS "matchId",
                sm.game_index              AS "gameIndex",
                ms."puuid"                 AS "puuid",
                s."gameName"               AS "summonerName",
                ms."score"::float8         AS "score",
                ms."placement"             AS "placement"
           FROM session_matches sm
           JOIN match_scores ms ON ms."matchId" = sm.match_id
           LEFT JOIN summoners s ON s."puuid" = ms."puuid"
          WHERE sm.session_id = $1
            AND ms."puuid" = ANY($2::varchar[])
            AND ${notHiddenPredicate('ms."puuid"')}`,
        [sessionId, squadPuuids]
    );
    return result.rows;
};

/**
 * The champion a player was on in a match.
 *
 * Looked up only for the one game that won `bestGame`, rather than joined across
 * the whole session: `participants` is the full ~100-metric blob for ten players,
 * and unpacking every game of a seven-game night to read one string from one of
 * them is a lot of JSONB for a caption.
 *
 * `LIMIT 1` because `match_details` is unique on (matchId, entryPlayerPuuid), so
 * a game five tracked players were in is five rows carrying the same roster.
 */
const getChampionName = async (
    matchId: string,
    puuid: string
): Promise<string | null> => {
    const result = await db.query(
        `SELECT participant->>'championName' AS "championName"
           FROM "match_details" md,
                jsonb_array_elements(md."participants") AS participant
          WHERE md."matchId" = $1
            AND participant->>'puuid' = $2
          LIMIT 1`,
        [matchId, puuid]
    );
    return result.rows[0]?.championName ?? null;
};

/**
 * Pick the night's best performance and its worst game.
 *
 * Pure, so the tie rules are testable without a database.
 *
 * **Best names a person, worst names a game.** See `SessionLowPoint` for why
 * that asymmetry is deliberate rather than an oversight.
 *
 * Ties resolve to the earlier game in both directions. Any rule would do; the
 * requirement is only that the same night always produces the same card, since
 * a redelivery must not contradict the first one.
 */
export function pickStandouts(entries: ScoredEntry[]): {
    best?: ScoredEntry;
    worst?: SessionLowPoint;
} {
    if (entries.length === 0) return {};

    let best: ScoredEntry | undefined;
    for (const entry of entries) {
        if (
            !best ||
            entry.score > best.score ||
            (entry.score === best.score && entry.gameIndex < best.gameIndex)
        ) {
            best = entry;
        }
    }

    // Group by game, then compare each game's mean across the squad's players.
    const byGame = new Map<number, { matchId: string; scores: number[] }>();
    for (const entry of entries) {
        const existing = byGame.get(entry.gameIndex);
        if (existing) {
            existing.scores.push(entry.score);
            continue;
        }
        byGame.set(entry.gameIndex, {
            matchId: entry.matchId,
            scores: [entry.score],
        });
    }

    let worst: SessionLowPoint | undefined;
    for (const [gameIndex, game] of [...byGame.entries()].sort(
        (a, b) => a[0] - b[0]
    )) {
        const mean =
            game.scores.reduce((total, s) => total + s, 0) / game.scores.length;
        // Strict `<` keeps the earliest game on a tie, given ascending order.
        if (!worst || mean < worst.meanAiScore) {
            worst = {
                matchId: game.matchId,
                gameIndex,
                meanAiScore: mean,
            };
        }
    }

    return { best, worst };
}

/** The night's standouts, or an empty object when nothing was scored. */
export const computeStandouts = async (
    sessionId: string,
    squadPuuids: string[]
): Promise<SessionStandouts> => {
    const entries = await getSessionScores(sessionId, squadPuuids);
    const { best, worst } = pickStandouts(entries);
    if (!best) return {};

    return {
        bestGame: {
            matchId: best.matchId,
            gameIndex: best.gameIndex,
            puuid: best.puuid,
            // A scored puuid with no `summoners` row should not happen - the
            // roster is what put it in the session - but a missing name must not
            // take the whole recap down with it.
            summonerName: best.summonerName ?? best.puuid,
            championName: await getChampionName(best.matchId, best.puuid),
            aiScore: best.score,
            placement: best.placement,
        },
        worstGame: worst,
    };
};

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

const toIso = (value: string | Date): string => new Date(value).toISOString();

const toIsoOrNull = (value: string | Date | null): string | null =>
    value === null ? null : toIso(value);

/**
 * A finished night as a `session.completed` event.
 *
 * Pure: rows in, event out. Every timestamp is normalised through `Date` because
 * the driver returns `TIMESTAMPTZ` as a `Date` or a string depending on how it
 * is configured, and the event id is built from one of them.
 *
 * Facts only - no prose, no ordering hints, no colours. Meeps composes the
 * sentence, which is what lets a recap be reworded without a Diana deploy.
 */
export function buildSessionCompletedEvent(
    detail: SessionDetail,
    standouts: SessionStandouts = {}
): SessionCompletedEvent {
    const { session, participants, matches } = detail;

    if (session.ended_at === null) {
        throw new Error(
            `Session ${session.session_id} has not ended; a live night has no recap.`
        );
    }

    const startedAt = toIso(session.started_at);
    const endedAt = toIso(session.ended_at);

    return {
        schemaVersion: DIANA_EVENT_SCHEMA_VERSION,
        eventId: buildSessionEventId(session.squad_id, session.started_at),
        type: 'session.completed',
        // When the night ended, not when the sweep noticed - which is up to a
        // full idle gap later. `DianaEventBase.occurredAt` says so explicitly.
        occurredAt: endedAt,
        squadId: session.squad_id,
        sessionId: session.session_id,
        startedAt,
        endedAt,
        durationSeconds: Math.max(
            0,
            Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000)
        ),
        voiceSeconds: session.voice_seconds,
        participantCount: session.participant_count,
        peakConcurrent: session.peak_concurrent,
        matchCount: session.match_count,
        wins: session.wins,
        losses: session.losses,
        participants: participants.map(
            (p): SessionParticipantSummary => ({
                meepsUserId: p.meeps_user_id,
                puuid: p.puuid,
                firstJoinedAt: toIso(p.first_joined_at),
                lastLeftAt: toIsoOrNull(p.last_left_at),
                voiceSeconds: p.voice_seconds,
                intervalCount: p.interval_count,
            })
        ),
        matches: matches.map(
            (m): SessionMatchSummary => ({
                matchId: m.match_id,
                gameIndex: m.game_index,
                startedAt: toIso(m.started_at),
                endedAt: toIsoOrNull(m.ended_at),
                queueId: m.queue_id,
                win: m.win,
            })
        ),
        ...(standouts.bestGame ? { bestGame: standouts.bestGame } : {}),
        ...(standouts.worstGame ? { worstGame: standouts.worstGame } : {}),
    };
}

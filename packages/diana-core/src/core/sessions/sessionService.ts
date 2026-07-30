/**
 * Sessions - persistence and match attachment (DN-6).
 *
 * `sessionise.ts` owns the rules. This owns the reads and writes: pulling a
 * squad's presence, attaching the matches that fall inside each night, and
 * upserting the result.
 *
 * Everything here is **derived**. `sessions`, `session_participants` and
 * `session_matches` can be dropped and rebuilt from `presence_events` and
 * `match_details` at any time, which is the property that makes it safe to change
 * the idle-gap rule later.
 */

import { db } from '../../plugins/diana-league-bot/api/utils/db';
import { getPresenceForSquad } from '../presence/presenceService';
import type { PresenceEventRow } from '../presence/presenceService';
import {
    sessionisePresence,
    type DerivedSession,
    type SessioniseOptions,
} from './sessionise';

export interface SessionRow {
    session_id: string;
    squad_id: string;
    started_at: string;
    ended_at: string | null;
    participant_count: number;
    match_count: number;
    wins: number;
    losses: number;
    peak_concurrent: number;
    voice_seconds: number;
    computed_at: string;
}

export interface SessionParticipantRow {
    session_id: string;
    meeps_user_id: string;
    puuid: string | null;
    first_joined_at: string;
    last_left_at: string | null;
    voice_seconds: number;
    interval_count: number;
}

export interface SessionMatchRow {
    session_id: string;
    match_id: string;
    game_index: number;
    started_at: string;
    ended_at: string | null;
    queue_id: number | null;
    win: boolean | null;
}

/** A match that overlapped a session window, before it is stored. */
interface AttachableMatch {
    matchId: string;
    startedAt: number;
    endedAt: number | null;
    queueId: number | null;
    win: boolean | null;
}

// ---------------------------------------------------------------------------
// Match attachment
// ---------------------------------------------------------------------------

/**
 * The squad's tracked Riot accounts.
 *
 * This is what makes squad-level match attachment work *today*, with DN-3
 * unbuilt: the squad roster is authoritative even though the mapping from a
 * Meeps user to a Riot account is not. "Which games happened during this night"
 * needs only the roster. "Was this particular person in voice for that game"
 * needs identity, and waits.
 */
export const getSquadPuuids = async (squadId: string): Promise<string[]> => {
    const result = await db.query(
        `SELECT puuid FROM squad_summoners WHERE squad_id = $1`,
        [squadId]
    );
    return result.rows.map((row: { puuid: string }) => row.puuid);
};

interface MatchDetailRow {
    matchId: string;
    gameStartTime: string | number | null;
    gameEndTime: string | number | null;
    gameDuration: number | null;
    queueId: number | null;
    participants: unknown;
}

function toMs(value: string | number | null): number | null {
    if (value === null) return null;
    const n = typeof value === 'string' ? Number(value) : value;
    return Number.isFinite(n) ? n : null;
}

/**
 * Did the squad win?
 *
 * Read from the tracked players' own participant entries rather than a team id,
 * because "which team were we on" is not knowable without looking. Returns null
 * when the squad's players disagree - two tracked players on opposite sides
 * happens in customs and in Arena, and calling that a win for the squad would be
 * a straight-up lie on the recap card.
 */
function resolveWin(participants: unknown, squadPuuids: Set<string>): boolean | null {
    if (!Array.isArray(participants)) return null;

    const verdicts = new Set<boolean>();
    for (const entry of participants) {
        const p = entry as { puuid?: unknown; win?: unknown };
        if (typeof p?.puuid !== 'string' || !squadPuuids.has(p.puuid)) continue;
        if (typeof p.win === 'boolean') verdicts.add(p.win);
    }

    if (verdicts.size !== 1) return null;
    return [...verdicts][0];
}

/**
 * Matches by this squad's players that overlap a window.
 *
 * Deduplicated on `matchId`: `match_details` is unique on
 * `(matchId, entryPlayerPuuid)`, so a game five tracked players were in is five
 * rows, and counting it five times would put "7 games" on a card for a night
 * with two.
 *
 * Overlap, not containment. A game that started before the first person joined
 * voice still belongs to the night they spent talking about it, and a game
 * running when the last person left is the reason they left.
 */
export const findMatchesInWindow = async (
    squadPuuids: string[],
    startMs: number,
    endMs: number
): Promise<AttachableMatch[]> => {
    if (squadPuuids.length === 0) return [];

    const result = await db.query(
        `SELECT DISTINCT ON ("matchId")
                "matchId", "gameStartTime", "gameEndTime", "gameDuration",
                "queueId", "participants"
           FROM "match_details"
          WHERE "entryPlayerPuuid" = ANY($1::varchar[])
            AND "gameStartTime" IS NOT NULL
            AND "gameStartTime" <= $3
            AND COALESCE(
                  "gameEndTime",
                  "gameStartTime" + COALESCE("gameDuration", 0) * 1000
                ) >= $2
          ORDER BY "matchId", "gameStartTime" ASC`,
        [squadPuuids, startMs, endMs]
    );

    const squadSet = new Set(squadPuuids);

    return result.rows
        .map((row: MatchDetailRow) => {
            const startedAt = toMs(row.gameStartTime);
            if (startedAt === null) return null;
            const endedAt =
                toMs(row.gameEndTime) ??
                (row.gameDuration
                    ? startedAt + row.gameDuration * 1000
                    : null);
            return {
                matchId: row.matchId,
                startedAt,
                endedAt,
                queueId: row.queueId ?? null,
                win: resolveWin(row.participants, squadSet),
            };
        })
        .filter((m): m is AttachableMatch => m !== null)
        .sort((a, b) => a.startedAt - b.startedAt);
};

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

const upsertSession = async (
    squadId: string,
    session: DerivedSession,
    matches: AttachableMatch[]
): Promise<string> => {
    const wins = matches.filter((m) => m.win === true).length;
    const losses = matches.filter((m) => m.win === false).length;

    // ON CONFLICT on (squad_id, started_at) is what makes a rebuild idempotent:
    // the same night recomputes into the same row rather than a second copy.
    const result = await db.query(
        `INSERT INTO sessions
             (squad_id, started_at, ended_at, participant_count, match_count,
              wins, losses, peak_concurrent, voice_seconds, computed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (squad_id, started_at) DO UPDATE SET
             ended_at          = EXCLUDED.ended_at,
             participant_count = EXCLUDED.participant_count,
             match_count       = EXCLUDED.match_count,
             wins              = EXCLUDED.wins,
             losses            = EXCLUDED.losses,
             peak_concurrent   = EXCLUDED.peak_concurrent,
             voice_seconds     = EXCLUDED.voice_seconds,
             computed_at       = NOW()
         RETURNING session_id`,
        [
            squadId,
            new Date(session.startedAt).toISOString(),
            session.endedAt === null
                ? null
                : new Date(session.endedAt).toISOString(),
            session.participants.length,
            matches.length,
            wins,
            losses,
            session.peakConcurrent,
            session.voiceSeconds,
        ]
    );

    const sessionId: string = result.rows[0].session_id;

    // Children are replaced wholesale. A rebuild can legitimately *remove* a
    // participant or a match - a later erasure under MP-13, a corrected window -
    // and an upsert alone would leave the stale row behind forever.
    await db.query(`DELETE FROM session_participants WHERE session_id = $1`, [
        sessionId,
    ]);
    for (const participant of session.participants) {
        await db.query(
            `INSERT INTO session_participants
                 (session_id, meeps_user_id, puuid, first_joined_at,
                  last_left_at, voice_seconds, interval_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                sessionId,
                participant.meepsUserId,
                participant.puuid,
                new Date(participant.firstJoinedAt).toISOString(),
                participant.lastLeftAt === null
                    ? null
                    : new Date(participant.lastLeftAt).toISOString(),
                participant.voiceSeconds,
                participant.intervalCount,
            ]
        );
    }

    await db.query(`DELETE FROM session_matches WHERE session_id = $1`, [
        sessionId,
    ]);
    for (const [index, match] of matches.entries()) {
        await db.query(
            `INSERT INTO session_matches
                 (session_id, match_id, game_index, started_at, ended_at,
                  queue_id, win)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                sessionId,
                match.matchId,
                // 1-based: "you were 3-1 after game 5" counts from one.
                index + 1,
                new Date(match.startedAt).toISOString(),
                match.endedAt === null
                    ? null
                    : new Date(match.endedAt).toISOString(),
                match.queueId,
                match.win,
            ]
        );
    }

    return sessionId;
};

export interface RebuildResult {
    squadId: string;
    sessions: number;
    matchesAttached: number;
    /** Live at the time of the rebuild, i.e. somebody still in voice. */
    openSessions: number;
}

/**
 * Recompute a squad's sessions from presence.
 *
 * Idempotent by construction, so it is safe to run on a cron, after an ingest,
 * or by hand. `since` bounds the work: without it this reads the squad's entire
 * presence history, which is correct but wasteful once there is a lot of it.
 *
 * A `since` that lands mid-night is safe in one direction only. Because a leave
 * with no join is ignored rather than guessed at, a window that cuts an interval
 * in half *under*-reports that night rather than inventing time - so prefer a
 * `since` comfortably older than the oldest session you care about.
 */
export const rebuildSessionsForSquad = async (
    squadId: string,
    options: SessioniseOptions & { since?: string } = {}
): Promise<RebuildResult> => {
    const events: PresenceEventRow[] = await getPresenceForSquad(
        squadId,
        options.since
    );

    const derived = sessionisePresence(events, options);
    if (derived.length === 0) {
        return { squadId, sessions: 0, matchesAttached: 0, openSessions: 0 };
    }

    const squadPuuids = await getSquadPuuids(squadId);
    const now = options.now ?? Date.now();

    let matchesAttached = 0;
    for (const session of derived) {
        const matches = await findMatchesInWindow(
            squadPuuids,
            session.startedAt,
            session.endedAt ?? now
        );
        await upsertSession(squadId, session, matches);
        matchesAttached += matches.length;
    }

    return {
        squadId,
        sessions: derived.length,
        matchesAttached,
        openSessions: derived.filter((s) => s.endedAt === null).length,
    };
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const getSessionsForSquad = async (
    squadId: string,
    limit = 20
): Promise<SessionRow[]> => {
    const result = await db.query(
        `SELECT session_id, squad_id, started_at, ended_at, participant_count,
                match_count, wins, losses, peak_concurrent, voice_seconds,
                computed_at
           FROM sessions
          WHERE squad_id = $1
          ORDER BY started_at DESC
          LIMIT $2`,
        [squadId, limit]
    );
    return result.rows;
};

/** The night that has not finished yet, if there is one. */
export const getOpenSessionForSquad = async (
    squadId: string
): Promise<SessionRow | null> => {
    const result = await db.query(
        `SELECT session_id, squad_id, started_at, ended_at, participant_count,
                match_count, wins, losses, peak_concurrent, voice_seconds,
                computed_at
           FROM sessions
          WHERE squad_id = $1 AND ended_at IS NULL
          ORDER BY started_at DESC
          LIMIT 1`,
        [squadId]
    );
    return result.rows[0] ?? null;
};

export interface SessionDetail {
    session: SessionRow;
    participants: SessionParticipantRow[];
    matches: SessionMatchRow[];
}

/** Everything the recap card needs, in one call. */
export const getSessionDetail = async (
    sessionId: string
): Promise<SessionDetail | null> => {
    const session = await db.query(
        `SELECT session_id, squad_id, started_at, ended_at, participant_count,
                match_count, wins, losses, peak_concurrent, voice_seconds,
                computed_at
           FROM sessions WHERE session_id = $1`,
        [sessionId]
    );
    if (session.rows.length === 0) return null;

    const participants = await db.query(
        `SELECT session_id, meeps_user_id, puuid, first_joined_at, last_left_at,
                voice_seconds, interval_count
           FROM session_participants
          WHERE session_id = $1
          ORDER BY first_joined_at ASC`,
        [sessionId]
    );

    const matches = await db.query(
        `SELECT session_id, match_id, game_index, started_at, ended_at,
                queue_id, win
           FROM session_matches
          WHERE session_id = $1
          ORDER BY game_index ASC`,
        [sessionId]
    );

    return {
        session: session.rows[0],
        participants: participants.rows,
        matches: matches.rows,
    };
};

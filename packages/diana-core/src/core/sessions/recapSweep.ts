/**
 * The recap sweep - the thing that was missing (roadmap §7.1).
 *
 * DN-6 shipped the sessions engine complete and unturned: `rebuildSessionsForSquad`
 * was reachable only from a dashboard route, so nights existed only when a human
 * asked for them. This is the timer that asks.
 *
 * WHY A SWEEP AND NOT A HOOK
 *
 * A night ends in silence, and silence does not arrive. `sessionisePresence` sets
 * `endedAt` the moment the last person leaves, but a rejoin within `idleGapMs`
 * merges back into the same night, so "finished" is not knowable until the gap
 * has elapsed with nothing happening. There is no event to hang a listener on -
 * the whole signal is the absence of one.
 *
 * And it must be a cron rather than a `setTimeout` armed on the last `voice.left`:
 * a deploy drops every pending timer, and this deploys often. A recap lost that
 * way would be lost silently and permanently.
 *
 * The cost is latency. A recap lands one idle gap plus up to one tick after the
 * last person leaves - roughly 45-50 minutes on the defaults. That is forced by
 * the grouping rule: announcing sooner means announcing nights that are not over.
 */

import type { EventAdapter } from '../eventTypes';
import { db } from '../../plugins/diana-league-bot/api/utils/db';
import {
    buildSessionCompletedEvent,
    computeStandouts,
    findSettledSessions,
    markRecapEmitted,
} from './recapService';
import {
    getSessionDetail,
    getSquadPuuids,
    rebuildSessionsForSquad,
} from './sessionService';
import { DEFAULT_IDLE_GAP_MS } from './sessionise';

function timestamp(): string {
    return new Date().toISOString();
}

/**
 * How far back to look for squads worth rebuilding.
 *
 * A squad with no voice in a day has no night that could still be settling, so
 * rebuilding it would recompute history to reach the same answer.
 */
export const DEFAULT_ACTIVITY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * How far back each rebuild reads presence.
 *
 * Deliberately much wider than the activity window. `rebuildSessionsForSquad`
 * warns that a `since` landing mid-night under-reports that night rather than
 * over-reporting it, so the bound has to clear the oldest session a tick could
 * still be closing, with room to spare.
 */
export const DEFAULT_REBUILD_SINCE_MS = 3 * 24 * 60 * 60 * 1000;

export interface RecapSweepResult {
    squadsRebuilt: number;
    recapsEmitted: number;
    /** Settled nights whose delivery failed; they retry on the next tick. */
    recapsDeferred: number;
}

export interface RecapSweepOptions {
    now?: number;
    idleGapMs?: number;
    activityLookbackMs?: number;
    rebuildSinceMs?: number;
}

/**
 * Squads worth recomputing: voice recently, or a night still open.
 *
 * The second half matters more than it looks. A squad whose last event was a
 * `voice.joined` two days ago has an open session and no recent activity, and
 * without the union its night would never close.
 */
export const findActiveSquads = async (since: string): Promise<string[]> => {
    const result = await db.query(
        `SELECT DISTINCT squad_id FROM presence_events WHERE occurred_at >= $1
         UNION
         SELECT DISTINCT squad_id FROM sessions WHERE ended_at IS NULL`,
        [since]
    );
    return result.rows.map((row: { squad_id: string }) => row.squad_id);
};

/**
 * Recompute recently-active squads, then announce any night that has settled.
 *
 * Every squad and every session is isolated: one squad with a corrupt presence
 * history, or one session whose match rows have gone missing, must not stop the
 * rest of the sweep. Failures are logged and the loop continues.
 */
export const runRecapSweep = async (
    eventAdapter?: EventAdapter | null,
    options: RecapSweepOptions = {}
): Promise<RecapSweepResult> => {
    const now = options.now ?? Date.now();
    const idleGapMs = options.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
    const activityLookbackMs =
        options.activityLookbackMs ?? DEFAULT_ACTIVITY_LOOKBACK_MS;
    const rebuildSinceMs = options.rebuildSinceMs ?? DEFAULT_REBUILD_SINCE_MS;

    const result: RecapSweepResult = {
        squadsRebuilt: 0,
        recapsEmitted: 0,
        recapsDeferred: 0,
    };

    const squadIds = await findActiveSquads(
        new Date(now - activityLookbackMs).toISOString()
    );
    const rebuildSince = new Date(now - rebuildSinceMs).toISOString();

    for (const squadId of squadIds) {
        try {
            await rebuildSessionsForSquad(squadId, {
                since: rebuildSince,
                now,
                idleGapMs,
            });
            result.squadsRebuilt += 1;
        } catch (error) {
            console.error(
                `[${timestamp()}] [recap] Rebuild failed for squad ${squadId}:`,
                error
            );
        }
    }

    // Announcing is a separate pass over the whole table rather than something
    // done inside the loop above. A night can settle without its squad being
    // active - the last thing that happened was everyone leaving - so keying the
    // announcement off "was rebuilt this tick" would strand exactly the nights
    // that are ready.
    const settled = await findSettledSessions(now, idleGapMs);
    if (settled.length === 0) return result;

    if (!eventAdapter) {
        // Not an error: a deployment with no Meeps configured still sessionises
        // correctly, and the rows are what Squad Wrapped and the Session Curve
        // read. Recaps simply wait, and `recap_emitted_at` stays null, so they
        // are all delivered whenever an adapter does appear.
        console.log(
            `[${timestamp()}] [recap] ${settled.length} night(s) settled but no event adapter is configured; not announcing.`
        );
        result.recapsDeferred += settled.length;
        return result;
    }

    for (const session of settled) {
        try {
            const detail = await getSessionDetail(session.session_id);
            if (!detail) continue;

            const standouts = await computeStandouts(
                session.session_id,
                await getSquadPuuids(session.squad_id)
            );

            const delivered = await eventAdapter.emit(
                buildSessionCompletedEvent(detail, standouts)
            );

            // Marked only on confirmed delivery. Marking on the call returning
            // would lose the recap whenever Meeps happened to be redeploying:
            // the adapter gives up after three attempts inside two seconds, and
            // a night is announced exactly once. Redelivery is safe - the event
            // id is deterministic and Meeps discards duplicates on it - so the
            // failure worth avoiding is the silent one.
            if (delivered) {
                await markRecapEmitted(session.session_id);
                result.recapsEmitted += 1;
            } else {
                result.recapsDeferred += 1;
            }
        } catch (error) {
            result.recapsDeferred += 1;
            console.error(
                `[${timestamp()}] [recap] Could not announce session ${session.session_id}:`,
                error
            );
        }
    }

    if (result.recapsEmitted > 0) {
        console.log(
            `[${timestamp()}] [recap] Announced ${result.recapsEmitted} session recap(s).`
        );
    }

    return result;
};

/**
 * Per-player privacy opt-out (DN-3).
 *
 * Opting out removes a player from **rankings and group summaries** - surfaces
 * where they appear alongside other people without having asked to. It does not
 * remove them from direct lookups, where somebody typed their name, and it does
 * not stop their own match posts.
 *
 * The enforcement is not here. It is a SQL predicate applied inside the
 * aggregate queries themselves (`SQL_NOT_HIDDEN`), because a service call that
 * every reader has to remember to make is a filter that some reader will
 * eventually forget. This module owns the state and the vocabulary; the queries
 * own the filtering.
 */

// See the note in squadService: `db` is infrastructure misfiled under the
// League plugin. Imported where it lives rather than moved.
import { db } from '../../plugins/diana-league-bot/api/utils/db';

export interface SummonerPrivacy {
    puuid: string;
    hidden: boolean;
    set_by: string | null;
    updated_at: string;
}

/**
 * The predicate every aggregate surface applies.
 *
 * Exported as a string rather than composed per caller so that all of them
 * filter identically, and so that `grep SQL_NOT_HIDDEN` answers "which queries
 * respect privacy" completely and in one step.
 *
 * `NOT EXISTS` rather than a `LEFT JOIN ... IS NULL`: most players will never
 * have a row here, and an anti-join against a partial index on the hidden rows
 * costs a probe that finds nothing. It also cannot change the cardinality of the
 * outer query the way a join can if the table ever gains a second row per puuid.
 *
 * The parameter is the column to test, interpolated by the caller - never user
 * input. Callers pass a literal like `s."puuid"`.
 */
export const notHiddenPredicate = (puuidColumn: string): string =>
    `NOT EXISTS (
        SELECT 1 FROM summoner_privacy sp
        WHERE sp."puuid" = ${puuidColumn} AND sp."hidden" = TRUE
    )`;

/**
 * Whether this player has opted out.
 *
 * A missing row means visible. So does `hidden = false`; the row survives
 * un-hiding so that `set_by` and `updated_at` still record the decision.
 */
export const isHidden = async (puuid: string): Promise<boolean> => {
    const result = await db.query(
        `SELECT hidden FROM summoner_privacy WHERE puuid = $1`,
        [puuid]
    );
    return result.rows[0]?.hidden === true;
};

/**
 * Opt a player in or out.
 *
 * Upsert rather than insert-or-update in two statements: `/privacy hide` is
 * idempotent from the player's point of view and should be idempotent here too.
 */
export const setHidden = async (
    puuid: string,
    hidden: boolean,
    setBy?: string
): Promise<SummonerPrivacy> => {
    const result = await db.query(
        `INSERT INTO summoner_privacy (puuid, hidden, set_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (puuid) DO UPDATE
             SET hidden = EXCLUDED.hidden,
                 set_by = EXCLUDED.set_by,
                 updated_at = NOW()
         RETURNING puuid, hidden, set_by, updated_at`,
        [puuid, hidden, setBy ?? null]
    );
    return result.rows[0];
};

/** One player's recorded decision, or null if they have never made one. */
export const getPrivacy = async (
    puuid: string
): Promise<SummonerPrivacy | null> => {
    const result = await db.query(
        `SELECT puuid, hidden, set_by, updated_at
         FROM summoner_privacy WHERE puuid = $1`,
        [puuid]
    );
    return result.rows[0] ?? null;
};

/**
 * Which of these players are hidden.
 *
 * For callers that already hold a list of puuids and are filtering in
 * TypeScript rather than in SQL - the recap's standout picker, which reads its
 * candidates through several joins before choosing between them.
 *
 * Returns a Set because every caller asks "is this one hidden" per candidate.
 */
export const getHiddenPuuids = async (
    puuids: string[]
): Promise<Set<string>> => {
    if (puuids.length === 0) return new Set();

    const result = await db.query(
        `SELECT puuid FROM summoner_privacy
         WHERE puuid = ANY($1::varchar[]) AND hidden = TRUE`,
        [puuids]
    );
    return new Set(result.rows.map((row: { puuid: string }) => row.puuid));
};

/**
 * Set the same decision for several accounts at once.
 *
 * One person can own several Riot accounts, and hiding one of them while the
 * others stay on a leaderboard is not what anybody means by opting out. DN-3's
 * identity half calls this with every puuid linked to the caller; without
 * identity, `/privacy` calls it with the one account it could resolve.
 */
export const setHiddenForAll = async (
    puuids: string[],
    hidden: boolean,
    setBy?: string
): Promise<number> => {
    if (puuids.length === 0) return 0;

    const result = await db.query(
        `INSERT INTO summoner_privacy (puuid, hidden, set_by)
         SELECT unnest($1::varchar[]), $2, $3
         ON CONFLICT (puuid) DO UPDATE
             SET hidden = EXCLUDED.hidden,
                 set_by = EXCLUDED.set_by,
                 updated_at = NOW()`,
        [puuids, hidden, setBy ?? null]
    );
    return result.rowCount ?? 0;
};

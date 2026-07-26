/**
 * Single source of truth for "does this match count as competition?".
 *
 * Two independent rules combine here:
 *
 *  1. Arena is NEVER competitive. It is a placement mode (8 subteams of 2) with
 *     no lanes, no wards and no rank, so the role-weighted AI score is
 *     meaningless for it. This rule is universal - not a setting.
 *  2. Beyond that, each guild picks a `CompetitiveScope`: count every queue
 *     (default, preserves historical behaviour) or ranked queues only.
 *
 * Keep every queue-ID literal in this file. Nothing else should hardcode one.
 *
 * This module deliberately has NO imports. `dataDragonService` builds its rank
 * lookup from RANKED_QUEUE_TAGS below rather than the other way round, so that
 * mocking dataDragonService in a test can never leave these constants
 * undefined at module-load time.
 */

export type CompetitiveScope = 'all' | 'ranked';

export const DEFAULT_COMPETITIVE_SCOPE: CompetitiveScope = 'all';

export const COMPETITIVE_SCOPES: readonly CompetitiveScope[] = [
    'all',
    'ranked',
];

/**
 * Riot's internal name for Arena. Unlike the queue IDs this has been stable
 * across every Arena revision, so it is the primary signal.
 */
export const ARENA_GAME_MODE = 'CHERRY';

/**
 * Fallback only, for rows whose `gameMode` is missing or 'Unknown' (older
 * ingests, partial backfills). Riot keeps minting new Arena queue IDs - 1750
 * appeared after 1700/1701/1704/1710 - so this list WILL go stale. Never rely
 * on it as the primary check.
 */
export const KNOWN_ARENA_QUEUE_IDS: readonly number[] = [
    1700, 1701, 1704, 1710, 1750,
];

/**
 * The only queues that carry a rank. Single source of truth: LP tracking reads
 * it via `getRankTagsById`, and the SQL filters read the IDs below, so the two
 * can never drift apart.
 */
export const RANKED_QUEUE_TAGS: ReadonlyMap<number, string> = new Map<
    number,
    string
>([
    [420, 'RANKED_SOLO_5x5'],
    [440, 'RANKED_FLEX_SR'],
]);

export const RANKED_QUEUE_IDS: readonly number[] = [
    ...RANKED_QUEUE_TAGS.keys(),
];

/** The subset of a match row needed to classify it. */
export interface QueueClassifiable {
    gameMode?: string | null;
    queueId?: number | string | null;
}

const toQueueId = (queueId?: number | string | null): number => {
    const parsed = Number(queueId);
    return Number.isFinite(parsed) ? parsed : 0;
};

export function isArenaMatch(
    gameMode?: string | null,
    queueId?: number | string | null
): boolean {
    if (String(gameMode ?? '').toUpperCase() === ARENA_GAME_MODE) return true;
    return KNOWN_ARENA_QUEUE_IDS.includes(toQueueId(queueId));
}

export function isRankedQueue(queueId?: number | string | null): boolean {
    return RANKED_QUEUE_TAGS.has(toQueueId(queueId));
}

/** Arena is never scored, whatever the guild's scope. */
export function isScorableMatch(match: QueueClassifiable): boolean {
    return !isArenaMatch(match.gameMode, match.queueId);
}

export function countsForCompetition(
    match: QueueClassifiable,
    scope: CompetitiveScope
): boolean {
    if (isArenaMatch(match.gameMode, match.queueId)) return false;
    return scope === 'all' || isRankedQueue(match.queueId);
}

export function parseCompetitiveScope(value: unknown): CompetitiveScope {
    return value === 'ranked' ? 'ranked' : DEFAULT_COMPETITIVE_SCOPE;
}

/**
 * A WHERE-clause fragment (leading `AND`) for a `match_details` alias.
 *
 * Emits integer literals only - no bind parameters - so it can be appended to
 * any query without disturbing that query's existing $N numbering.
 */
export function buildCompetitiveSqlFilter(
    alias: string,
    scope: CompetitiveScope
): string {
    const arenaIds = KNOWN_ARENA_QUEUE_IDS.join(',');
    let sql =
        ` AND COALESCE(UPPER(${alias}."gameMode"), '') <> '${ARENA_GAME_MODE}'` +
        ` AND COALESCE(${alias}."queueId", 0) NOT IN (${arenaIds})`;
    if (scope === 'ranked') {
        sql += ` AND ${alias}."queueId" IN (${RANKED_QUEUE_IDS.join(',')})`;
    }
    return sql;
}

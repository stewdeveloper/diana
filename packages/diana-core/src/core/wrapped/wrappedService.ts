/**
 * Squad Wrapped - the period's figures (roadmap §7.2).
 *
 * The split follows the one DN-6 made between `sessionise` and `sessionService`,
 * and the one §7.1 made between `recapService` and `recapSweep`: the judgement
 * calls - which duo counts, how a tie breaks, who may be named - live in
 * `pairings.ts` and `wrappedPeriod.ts` where they are testable without a
 * database, and this file owns the reads that feed them.
 *
 * FIVE READS, AND WHY THEY ARE NOT ONE
 *
 *  1. the roster read - every match the squad played in the window, projected
 *     down to its own members. Feeds the record, the duos, the champions and the
 *     per-player totals, all from one scan.
 *  2. the scores read - `match_scores` for the same window, for best and worst
 *     game and each player's average.
 *  3. the names read - `summoners`, because everything above is keyed on puuid
 *     and a card names people.
 *  4. the nights read - `sessions`, for voice hours and the night that went 0-6.
 *  5. the LP read - `rank_tracking` per player, which cannot be a join because
 *     the journey is a first-and-last comparison per player rather than an
 *     aggregate.
 *
 * PRIVACY (DN-3)
 *
 * Every one of those five names people, so every one filters. Three do it in
 * SQL through `notHiddenPredicate`; the roster read filters in TypeScript
 * through `getHiddenPuuids`, because it is the one read whose *match count* must
 * survive a hidden participant - dropping the match would make the headline
 * number wrong, and dropping only the member is not something a WHERE clause on
 * the match can express. The filtering still happens before any ranking, which
 * is the property `recapService` was careful about: filter after picking a
 * winner and one person's privacy choice becomes a missing line for everyone.
 *
 * Voice time is the interesting case and is documented on
 * `notHiddenMeepsUserPredicate`.
 */

import { db } from '../../plugins/diana-league-bot/api/utils/db';
import {
    getHiddenPuuids,
    notHiddenMeepsUserPredicate,
    notHiddenPredicate,
} from '../privacy/privacyService';
import {
    buildCompetitiveSqlFilter,
    DEFAULT_COMPETITIVE_SCOPE,
    type CompetitiveScope,
} from '../../plugins/diana-league-bot/utils/queueClassification';
import { fetchRankHistory } from '../../plugins/diana-league-bot/api/summoners/summonerService';
import { getTotalPoints } from '../../plugins/diana-league-bot/api/utils/rankService';
import {
    computeChampionCounts,
    computePlayerTotals,
    computeSquadRecord,
    pickTopDuo,
    type WrappedMatch,
} from './pairings';
import {
    periodBoundsMs,
    resolveWrappedPeriod,
    type WrappedPeriod,
} from './wrappedPeriod';
import type {
    SquadWrapped,
    WrappedBestGame,
    WrappedDuo,
    WrappedLpJourney,
    WrappedPlayer,
    WrappedVoice,
    WrappedWorstGame,
    WrappedWorstNight,
} from './wrappedTypes';

/** How many players the card carries. A renderer shows fewer; nobody shows more. */
export const MAX_WRAPPED_PLAYERS = 10;

const toIsoOrNull = (value: string | Date | null | undefined): string | null =>
    value === null || value === undefined
        ? null
        : new Date(value).toISOString();

// ---------------------------------------------------------------------------
// 1. The roster read
// ---------------------------------------------------------------------------

/** One projected member as `jsonb_build_object` hands it back. */
interface RosterMemberJson {
    puuid?: string | null;
    win?: boolean | null;
    teamId?: number | null;
    championName?: string | null;
    kills?: number | null;
    deaths?: number | null;
    assists?: number | null;
}

interface RosterRow {
    matchId: string;
    gameCreation: string | number | null;
    members: RosterMemberJson[] | null;
}

const toNumber = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Every match the squad played in the window, carrying only its own members.
 *
 * The CTE deduplicates first and the projection happens second, and both halves
 * matter. `match_details` is unique on (matchId, entryPlayerPuuid), so a game
 * five tracked players were in is five rows; unpacking `participants` before
 * collapsing them would produce twenty-five member entries for five people.
 *
 * And the projection is why this is affordable at all. `participants` is the
 * full ~100-metric blob for ten players, so a ninety-day window is tens of
 * megabytes over the wire for the seven fields below. Filtering to the squad's
 * own puuids inside the lateral cuts ten participants to one to five before the
 * aggregate ever runs.
 */
export const fetchSquadMatches = async (
    squadPuuids: string[],
    fromMs: number,
    toMs: number,
    scope: CompetitiveScope = DEFAULT_COMPETITIVE_SCOPE
): Promise<WrappedMatch[]> => {
    if (squadPuuids.length === 0) return [];

    const result = await db.query(
        `WITH squad_matches AS (
             SELECT DISTINCT ON (md."matchId")
                    md."matchId", md."gameCreation", md."participants"
               FROM "match_details" md
              WHERE md."entryPlayerPuuid" = ANY($1::varchar[])
                AND md."gameCreation" IS NOT NULL
                AND md."gameCreation" >= $2
                AND md."gameCreation" < $3
                ${buildCompetitiveSqlFilter('md', scope)}
              ORDER BY md."matchId", md."gameCreation" ASC
         )
         SELECT sm."matchId"      AS "matchId",
                sm."gameCreation" AS "gameCreation",
                jsonb_agg(jsonb_build_object(
                    'puuid',        p->>'puuid',
                    'win',          (p->>'win')::boolean,
                    'teamId',       (p->>'teamId')::int,
                    'championName', p->>'championName',
                    'kills',        (p->>'kills')::int,
                    'deaths',       (p->>'deaths')::int,
                    'assists',      (p->>'assists')::int
                )) AS "members"
           FROM squad_matches sm,
                jsonb_array_elements(sm."participants") AS p
          WHERE p->>'puuid' = ANY($1::varchar[])
          GROUP BY sm."matchId", sm."gameCreation"
          ORDER BY sm."gameCreation" ASC`,
        [squadPuuids, fromMs, toMs]
    );

    return result.rows.map((row: RosterRow): WrappedMatch => {
        const playedAt =
            row.gameCreation === null ? null : Number(row.gameCreation);

        const members: WrappedMatch['members'] = [];
        for (const m of row.members ?? []) {
            // A participant entry with no puuid cannot be attributed to anybody,
            // and Riot has shipped them on partial ingests before.
            if (typeof m?.puuid !== 'string') continue;
            members.push({
                puuid: m.puuid,
                win: typeof m.win === 'boolean' ? m.win : null,
                teamId:
                    m.teamId === null || m.teamId === undefined
                        ? null
                        : toNumber(m.teamId),
                championName: m.championName ?? null,
                kills: toNumber(m.kills),
                deaths: toNumber(m.deaths),
                assists: toNumber(m.assists),
            });
        }

        return {
            matchId: row.matchId,
            playedAt:
                playedAt !== null && Number.isFinite(playedAt)
                    ? playedAt
                    : null,
            members,
        };
    });
};

// ---------------------------------------------------------------------------
// 2. The scores read
// ---------------------------------------------------------------------------

/** One squad player's AI score in one match of the period. */
export interface WrappedScoreRow {
    matchId: string;
    puuid: string;
    score: number;
    gameCreation: string | number | null;
}

/**
 * Every AI score the squad's own players earned in the window.
 *
 * Restricted to the squad's roster for the same reason the recap restricts
 * `getSessionScores`: `match_scores` holds all ten players in a lobby, and the
 * best performance in the room is very often a stranger's - which is not what
 * "best game" means on a card about five friends.
 *
 * The lateral supplies `gameCreation` for the window bound. It cannot be a plain
 * join on `entryPlayerPuuid`, because a scored player need not be an entry
 * player - the same trap `fetchWeeklyScoredGames` avoids with its EXISTS.
 */
export const fetchSquadScores = async (
    squadId: string,
    fromMs: number,
    toMs: number,
    scope: CompetitiveScope = DEFAULT_COMPETITIVE_SCOPE
): Promise<WrappedScoreRow[]> => {
    const result = await db.query(
        `SELECT ms."matchId"        AS "matchId",
                ms."puuid"          AS "puuid",
                ms."score"::float8  AS "score",
                m."gameCreation"    AS "gameCreation"
           FROM match_scores ms
           JOIN squad_summoners ss
             ON ss.puuid = ms."puuid" AND ss.squad_id = $1
           JOIN LATERAL (
                SELECT md."gameCreation"
                  FROM "match_details" md
                 WHERE md."matchId" = ms."matchId"
                   ${buildCompetitiveSqlFilter('md', scope)}
                 LIMIT 1
           ) m ON TRUE
          WHERE m."gameCreation" >= $2
            AND m."gameCreation" < $3
            AND ${notHiddenPredicate('ms."puuid"')}
          ORDER BY ms."score" DESC`,
        [squadId, fromMs, toMs]
    );

    return result.rows.map((row: WrappedScoreRow) => ({
        ...row,
        score: Number(row.score),
    }));
};

/**
 * The period's best performance and its worst game.
 *
 * Pure, so the tie rules are testable without a database. Ties resolve to the
 * earlier match id in both directions - any rule would do, the requirement is
 * only that the same period always produces the same card.
 *
 * **Best names a person, worst names a game.** See `WrappedWorstGame`.
 */
export function pickWrappedGames(scores: WrappedScoreRow[]): {
    best?: WrappedScoreRow;
    worst?: WrappedWorstGame;
} {
    if (scores.length === 0) return {};

    let best: WrappedScoreRow | undefined;
    for (const entry of scores) {
        if (
            !best ||
            entry.score > best.score ||
            (entry.score === best.score && entry.matchId < best.matchId)
        ) {
            best = entry;
        }
    }

    const byMatch = new Map<
        string,
        { scores: number[]; playedAt: string | null }
    >();
    for (const entry of scores) {
        const existing = byMatch.get(entry.matchId);
        if (existing) {
            existing.scores.push(entry.score);
            continue;
        }
        byMatch.set(entry.matchId, {
            scores: [entry.score],
            playedAt:
                entry.gameCreation === null
                    ? null
                    : new Date(Number(entry.gameCreation)).toISOString(),
        });
    }

    let worst: WrappedWorstGame | undefined;
    for (const [matchId, game] of [...byMatch.entries()].sort((a, b) =>
        a[0].localeCompare(b[0])
    )) {
        const mean =
            game.scores.reduce((total, s) => total + s, 0) / game.scores.length;
        if (!worst || mean < worst.meanAiScore) {
            worst = {
                matchId,
                meanAiScore: mean,
                playerCount: game.scores.length,
                playedAt: game.playedAt,
            };
        }
    }

    return { best, worst };
}

// ---------------------------------------------------------------------------
// 3. The names read
// ---------------------------------------------------------------------------

/** Display names for a set of puuids, in the form every other surface renders. */
export const fetchDisplayNames = async (
    puuids: string[]
): Promise<Map<string, string>> => {
    if (puuids.length === 0) return new Map();

    const result = await db.query(
        `SELECT "puuid", "gameName", "tagLine"
           FROM summoners
          WHERE "puuid" = ANY($1::varchar[])`,
        [puuids]
    );

    const names = new Map<string, string>();
    for (const row of result.rows as Array<{
        puuid: string;
        gameName: string;
        tagLine: string;
    }>) {
        names.set(
            row.puuid,
            row.tagLine ? `${row.gameName}#${row.tagLine}` : row.gameName
        );
    }
    return names;
};

// ---------------------------------------------------------------------------
// 4. The nights read
// ---------------------------------------------------------------------------

interface NightRow {
    session_id: string;
    started_at: string;
    ended_at: string | null;
    wins: number;
    losses: number;
    match_count: number;
    voice_seconds: number;
}

/**
 * The squad's finished nights in the window.
 *
 * Open nights are excluded: a session still in progress has no duration and
 * would report whatever voice time had accumulated by the moment somebody asked
 * for the card, which is not a fact about the night.
 */
export const fetchNights = async (
    squadId: string,
    from: string,
    to: string
): Promise<NightRow[]> => {
    const result = await db.query(
        `SELECT session_id, started_at, ended_at, wins, losses,
                match_count, voice_seconds
           FROM sessions
          WHERE squad_id = $1
            AND started_at >= $2
            AND started_at < $3
            AND ended_at IS NOT NULL
          ORDER BY started_at ASC`,
        [squadId, from, to]
    );
    return result.rows;
};

/**
 * Voice time per person, excluding anyone who opted out.
 *
 * The privacy join runs in SQL rather than by resolving each Meeps user through
 * `getPuuidsForMeepsUser` in a loop: a ten-person squad is ten round trips for
 * a filter, and the predicate is the sort of thing that must read identically to
 * the puuid-shaped one beside it.
 */
export const fetchVoiceByPerson = async (
    squadId: string,
    from: string,
    to: string
): Promise<
    Array<{ meepsUserId: string; voiceSeconds: number; nights: number }>
> => {
    const result = await db.query(
        `SELECT sp.meeps_user_id                AS "meepsUserId",
                SUM(sp.voice_seconds)::int      AS "voiceSeconds",
                COUNT(*)::int                   AS "nights"
           FROM session_participants sp
           JOIN sessions s ON s.session_id = sp.session_id
          WHERE s.squad_id = $1
            AND s.started_at >= $2
            AND s.started_at < $3
            AND s.ended_at IS NOT NULL
            AND ${notHiddenMeepsUserPredicate('sp.meeps_user_id')}
          GROUP BY sp.meeps_user_id
          ORDER BY SUM(sp.voice_seconds) DESC, sp.meeps_user_id ASC`,
        [squadId, from, to]
    );
    return result.rows.map(
        (row: {
            meepsUserId: string;
            voiceSeconds: number;
            nights: number;
        }) => ({
            meepsUserId: row.meepsUserId,
            voiceSeconds: Number(row.voiceSeconds),
            nights: Number(row.nights),
        })
    );
};

/**
 * The night that went worst.
 *
 * Ranked on losses first and then on how few wins came with them, so a 0-6 beats
 * a 2-6. A night with no matches is not a candidate - "the night you went 0-0"
 * is a night you did not play, and it is already represented in the voice hours.
 */
export function pickWorstNight(nights: NightRow[]): WrappedWorstNight | null {
    let worst: NightRow | null = null;

    for (const night of nights) {
        if (night.match_count === 0) continue;
        if (night.losses === 0) continue;
        if (
            !worst ||
            night.losses > worst.losses ||
            (night.losses === worst.losses && night.wins < worst.wins)
        ) {
            worst = night;
        }
    }

    if (!worst) return null;
    return {
        sessionId: worst.session_id,
        startedAt: new Date(worst.started_at).toISOString(),
        endedAt: toIsoOrNull(worst.ended_at),
        wins: worst.wins,
        losses: worst.losses,
        matchCount: worst.match_count,
    };
}

// ---------------------------------------------------------------------------
// 5. The LP read
// ---------------------------------------------------------------------------

interface RankRow {
    tier: string;
    rank: string;
    lp: number;
}

const describeRank = (row: RankRow): string =>
    `${row.tier} ${row.rank} ${row.lp} LP`;

/**
 * Each player's rank movement across the window.
 *
 * One query per player, as `computeWeeklyLpDeltas` does, and for the same
 * reason: the journey is a first-and-last comparison per player, not an
 * aggregate, and a window function to do it in one statement would be harder to
 * read than the loop for a roster that never exceeds a few dozen.
 *
 * Solo queue only. Flex movement is real but putting two ladders on one line
 * makes "biggest climb" ambiguous, and solo is the one a group argues about.
 */
export const computeLpJourneys = async (
    puuids: string[],
    names: Map<string, string>,
    from: string,
    to: string
): Promise<WrappedLpJourney[]> => {
    const journeys: WrappedLpJourney[] = [];

    for (const puuid of puuids) {
        try {
            const history: RankRow[] = await fetchRankHistory(
                puuid,
                from,
                to,
                'RANKED_SOLO_5x5'
            );
            // Rows come newest-first.
            const usable = history.filter(
                (row) => getTotalPoints(row.tier, row.rank, row.lp) !== null
            );
            if (usable.length < 2) continue;

            const latest = usable[0];
            const earliest = usable[usable.length - 1];
            const delta =
                (getTotalPoints(
                    latest.tier,
                    latest.rank,
                    latest.lp
                ) as number) -
                (getTotalPoints(
                    earliest.tier,
                    earliest.rank,
                    earliest.lp
                ) as number);

            journeys.push({
                puuid,
                name: names.get(puuid) ?? puuid,
                delta,
                from: describeRank(earliest),
                to: describeRank(latest),
            });
        } catch (error) {
            // One player's missing rank history must not cost the whole card.
            console.error(
                `[Wrapped] Failed to compute LP journey for ${puuid}:`,
                error
            );
        }
    }

    return journeys;
};

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface ComputeWrappedOptions {
    period?: WrappedPeriod;
    scope?: CompetitiveScope;
}

/**
 * Everything the Wrapped card needs, for one squad over one window.
 *
 * Returns null when the squad played nothing and spent no time in voice - there
 * is no card to draw, and an empty one reads as a bug rather than as an honest
 * "nothing happened".
 */
export const computeSquadWrapped = async (
    squadId: string,
    options: ComputeWrappedOptions = {}
): Promise<SquadWrapped | null> => {
    const period = options.period ?? resolveWrappedPeriod();
    const scope = options.scope ?? DEFAULT_COMPETITIVE_SCOPE;
    const { fromMs, toMs } = periodBoundsMs(period);

    const rosterResult = await db.query(
        `SELECT puuid FROM squad_summoners WHERE squad_id = $1`,
        [squadId]
    );
    const squadPuuids: string[] = rosterResult.rows.map(
        (row: { puuid: string }) => row.puuid
    );

    const [matches, scores, nights, voiceByPerson] = await Promise.all([
        fetchSquadMatches(squadPuuids, fromMs, toMs, scope),
        fetchSquadScores(squadId, fromMs, toMs, scope),
        fetchNights(squadId, period.from, period.to),
        fetchVoiceByPerson(squadId, period.from, period.to),
    ]);

    if (matches.length === 0 && nights.length === 0) return null;

    const hiddenPuuids = await getHiddenPuuids(squadPuuids);
    const record = computeSquadRecord(matches);
    const totals = computePlayerTotals(matches, { hiddenPuuids });

    const names = await fetchDisplayNames([
        ...new Set([
            ...totals.map((t) => t.puuid),
            ...scores.map((s) => s.puuid),
        ]),
    ]);
    const named = (puuid: string): string => names.get(puuid) ?? puuid;

    // Average AI score per player, from the scores read rather than the roster
    // read: `participants` has no score in it, because the score is Diana's and
    // not Riot's.
    const scoreTotals = new Map<string, { total: number; count: number }>();
    for (const entry of scores) {
        const acc = scoreTotals.get(entry.puuid) ?? { total: 0, count: 0 };
        acc.total += entry.score;
        acc.count += 1;
        scoreTotals.set(entry.puuid, acc);
    }

    const players: WrappedPlayer[] = totals
        .slice(0, MAX_WRAPPED_PLAYERS)
        .map((total): WrappedPlayer => {
            const scored = scoreTotals.get(total.puuid);
            return {
                puuid: total.puuid,
                name: named(total.puuid),
                games: total.games,
                wins: total.wins,
                losses: total.losses,
                winRate: total.winRate,
                avgAiScore:
                    scored && scored.count > 0
                        ? Math.round(scored.total / scored.count)
                        : null,
                kdaRatio: total.kdaRatio,
                topChampion: total.topChampion,
            };
        });

    const wrapped: SquadWrapped = {
        squadId,
        period,
        generatedAt: new Date().toISOString(),
        totalGames: record.totalGames,
        wins: record.wins,
        losses: record.losses,
        playerCount: totals.length,
        players,
    };

    const champions = computeChampionCounts(matches, hiddenPuuids);
    if (champions.length > 0) {
        wrapped.topChampion = {
            name: champions[0].championName,
            value: champions[0].games,
        };
    }

    const duo = pickTopDuo(matches, { hiddenPuuids });
    if (duo) {
        const duoNames = await fetchDisplayNames(duo.puuids);
        wrapped.topDuo = {
            puuids: duo.puuids,
            names: [
                duoNames.get(duo.puuids[0]) ?? duo.puuids[0],
                duoNames.get(duo.puuids[1]) ?? duo.puuids[1],
            ],
            gamesTogether: duo.gamesTogether,
            winsTogether: duo.winsTogether,
            winRate: duo.winRate,
        } satisfies WrappedDuo;
    }

    const { best, worst } = pickWrappedGames(scores);
    if (best) {
        wrapped.bestGame = {
            matchId: best.matchId,
            puuid: best.puuid,
            name: named(best.puuid),
            championName: findChampion(matches, best.matchId, best.puuid),
            aiScore: best.score,
            playedAt:
                best.gameCreation === null
                    ? null
                    : new Date(Number(best.gameCreation)).toISOString(),
        } satisfies WrappedBestGame;
    }
    // One scored game in the period is both the best and the worst; only the
    // distinct case earns a second line, as the digest decided for the same case.
    if (worst && (!best || worst.matchId !== best.matchId)) {
        wrapped.worstGame = worst;
    }

    if (nights.length > 0) {
        wrapped.voice = buildVoice(nights, voiceByPerson);
        const worstNight = pickWorstNight(nights);
        if (worstNight) wrapped.worstNight = worstNight;
    }

    const visiblePuuids = totals.map((t) => t.puuid);
    const journeys = await computeLpJourneys(
        visiblePuuids,
        names,
        period.from,
        period.to
    );
    if (journeys.length > 0) {
        const climb = journeys.reduce((a, b) => (b.delta > a.delta ? b : a));
        const fall = journeys.reduce((a, b) => (b.delta < a.delta ? b : a));
        // A period where everybody lost LP has no climber, and vice versa. The
        // sign test is what makes the line mean something.
        if (climb.delta > 0) wrapped.biggestClimb = climb;
        if (fall.delta < 0) wrapped.biggestFall = fall;
    }

    return wrapped;
};

/**
 * The champion somebody was on in one match, from the roster read.
 *
 * Looked up in memory rather than with the extra `match_details` query the recap
 * makes for the same caption: Wrapped already holds every match in the window
 * with its members projected, so the answer is present and a query would be a
 * round trip to re-read it.
 */
function findChampion(
    matches: WrappedMatch[],
    matchId: string,
    puuid: string
): string | null {
    const match = matches.find((m) => m.matchId === matchId);
    return match?.members.find((m) => m.puuid === puuid)?.championName ?? null;
}

function buildVoice(
    nights: NightRow[],
    byPerson: Array<{
        meepsUserId: string;
        voiceSeconds: number;
        nights: number;
    }>
): WrappedVoice {
    let longest = 0;
    let totalVoiceSeconds = 0;

    for (const night of nights) {
        totalVoiceSeconds += Number(night.voice_seconds);
        if (night.ended_at === null) continue;
        const wall =
            Date.parse(new Date(night.ended_at).toISOString()) -
            Date.parse(new Date(night.started_at).toISOString());
        if (wall > longest) longest = wall;
    }

    return {
        totalVoiceSeconds,
        nights: nights.length,
        longestNightSeconds: Math.max(0, Math.round(longest / 1000)),
        byPerson,
    };
}

import { db } from '../api/utils/db';
import {
    buildCompetitiveSqlFilter,
    DEFAULT_COMPETITIVE_SCOPE,
    type CompetitiveScope,
} from './queueClassification';

export const ONE_WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;

export interface RiotParticipant {
    puuid: string;
    championName?: string;
    totalDamageDealtToChampions?: number;
    totalMinionsKilled?: number;
    neutralMinionsKilled?: number;
    kills?: number;
    deaths?: number;
    assists?: number;
    win?: boolean;
    teamId?: number;
    teamPosition?: string;
    individualPosition?: string;
    goldEarned?: number;
    visionScore?: number;
    profileIcon?: number;
    riotIdGameName?: string;
    riotIdTagline?: string;
    summonerLevel?: number;
}

export interface RawMatchRow {
    puuid: string;
    gameName: string;
    tagLine: string;
    deepLolLink?: string | null;
    matchId: string;
    queueId?: number | string | null;
    gameMode?: string | null;
    gameDuration?: number | string | null;
    participants: string | RiotParticipant[];
    gameCreation: string | number | null;
    aiScore?: number | string | null;
}

export interface InterCandidate {
    puuid: string;
    displayName: string;
    deepLolLink?: string | null;
    matchesPlayed: number;
    wins: number;
    losses: number;
    totalDamage: number;
    totalKills: number;
    totalDeaths: number;
    totalAssists: number;
    totalVisionScore: number;
    totalCs: number;
    latestProfileIconId?: number;
    avgDamage: number;
    kdaRatio: number;
    winRate: number;
    avgVisionScore: number;
    avgCsPerMin: number;
    avgAiScore: number;
    scoredMatchesCount: number;
}

export interface InterStatsOptions {
    /** Restrict aggregation to a single summoner */
    targetPuuid?: string;
    /** Restrict aggregation to summoners tracked in this guild */
    guildId?: string;
    /**
     * Which queues count. Resolve it at the call site via
     * `getGuildCompetitiveScope(interaction.guildId)` - not here, because
     * callers like /summoner deliberately pass no guildId. Defaults to 'all'.
     * Arena is excluded either way.
     */
    scope?: CompetitiveScope;
}

export function parseParticipants(
    participants: RawMatchRow['participants']
): RiotParticipant[] {
    if (!participants) return [];

    if (Array.isArray(participants)) {
        return participants as RiotParticipant[];
    }

    if (typeof participants === 'string') {
        try {
            const parsed = JSON.parse(participants);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    return [];
}

function buildDisplayName(gameName: string, tagLine: string) {
    return tagLine ? `${gameName}#${tagLine}` : gameName;
}

export async function getInterCandidatesSince(
    sinceTimestamp: number,
    { targetPuuid, guildId, scope }: InterStatsOptions = {}
): Promise<InterCandidate[]> {
    const params: Array<string | number> = [sinceTimestamp];

    let guildJoin = '';
    if (guildId) {
        params.push(guildId);
        guildJoin = `JOIN guild_summoners gs ON gs.puuid = s.puuid AND gs.guild_id = $${params.length}`;
    }

    let query = `
        SELECT
            s."puuid",
            s."gameName",
            s."tagLine",
            s."deepLolLink",
            md."matchId",
            md."participants",
            md."gameCreation",
            md."gameDuration",
            md."queueId",
            md."gameMode",
            ms."score" AS "aiScore"
        FROM summoners s
        JOIN match_details md ON md."entryPlayerPuuid" = s."puuid"
        ${guildJoin}
        LEFT JOIN match_scores ms ON ms."matchId" = md."matchId" AND ms."puuid" = s."puuid"
        WHERE md."gameCreation" IS NOT NULL
          AND md."gameCreation" >= $1
          ${buildCompetitiveSqlFilter('md', scope ?? DEFAULT_COMPETITIVE_SCOPE)}
    `;

    if (targetPuuid) {
        params.push(targetPuuid);
        query += ` AND s."puuid" = $${params.length}`;
    }

    query += ' ORDER BY md."gameCreation" DESC';

    const result = await db.query(query, params);
    const rows: RawMatchRow[] = result.rows;

    const accumulator = new Map<
        string,
        InterCandidate & {
            matchIds: Set<string>;
            totalAiScore: number;
            totalDurationSeconds: number;
        }
    >();

    for (const row of rows) {
        const {
            puuid,
            gameName,
            tagLine,
            deepLolLink,
            participants,
            matchId,
            gameDuration,
            aiScore,
        } = row;

        if (!matchId) continue;
        if (targetPuuid && puuid !== targetPuuid) continue;

        let candidate = accumulator.get(puuid);

        if (!candidate) {
            candidate = {
                puuid,
                displayName: buildDisplayName(gameName, tagLine),
                deepLolLink,
                matchesPlayed: 0,
                wins: 0,
                losses: 0,
                totalDamage: 0,
                totalKills: 0,
                totalDeaths: 0,
                totalAssists: 0,
                totalVisionScore: 0,
                totalCs: 0,
                latestProfileIconId: undefined,
                avgDamage: 0,
                kdaRatio: 0,
                winRate: 0,
                avgVisionScore: 0,
                avgCsPerMin: 0,
                avgAiScore: 0,
                scoredMatchesCount: 0,
                totalAiScore: 0,
                totalDurationSeconds: 0,
                matchIds: new Set<string>(),
            };
            accumulator.set(puuid, candidate);
        }

        if (candidate.matchIds.has(matchId)) continue;
        candidate.matchIds.add(matchId);

        const parsedParticipants = parseParticipants(participants);
        const participant = parsedParticipants.find((p) => p.puuid === puuid);

        if (!participant) continue;

        const damage = participant.totalDamageDealtToChampions ?? 0;
        const kills = participant.kills ?? 0;
        const deaths = participant.deaths ?? 0;
        const assists = participant.assists ?? 0;
        const win = participant.win ?? false;
        const visionScore = participant.visionScore ?? 0;
        const cs =
            (participant.totalMinionsKilled ?? 0) +
            (participant.neutralMinionsKilled ?? 0);
        const durationSeconds = Number(gameDuration ?? 0);

        candidate.matchesPlayed += 1;
        candidate.totalDamage += damage;
        candidate.totalKills += kills;
        candidate.totalDeaths += deaths;
        candidate.totalAssists += assists;
        candidate.totalVisionScore += visionScore;
        candidate.totalCs += cs;
        candidate.totalDurationSeconds += Number.isFinite(durationSeconds)
            ? durationSeconds
            : 0;
        candidate.wins += win ? 1 : 0;
        candidate.losses += win ? 0 : 1;
        candidate.latestProfileIconId =
            participant.profileIcon ?? candidate.latestProfileIconId;

        const parsedAiScore = aiScore != null ? Number(aiScore) : null;
        if (parsedAiScore != null && Number.isFinite(parsedAiScore)) {
            candidate.totalAiScore += parsedAiScore;
            candidate.scoredMatchesCount += 1;
        }
    }

    const candidates: InterCandidate[] = [];

    for (const entry of Array.from(accumulator.values())) {
        if (entry.matchesPlayed === 0) continue;

        const avgDamage = entry.totalDamage / entry.matchesPlayed;
        const deaths = entry.totalDeaths;
        const killContrib = entry.totalKills + entry.totalAssists;
        const kdaRatio = deaths === 0 ? killContrib : killContrib / deaths;
        const winRate = entry.matchesPlayed
            ? entry.wins / entry.matchesPlayed
            : 0;
        const avgVisionScore = entry.totalVisionScore / entry.matchesPlayed;
        const avgCsPerMin =
            entry.totalDurationSeconds > 0
                ? entry.totalCs / (entry.totalDurationSeconds / 60)
                : 0;
        const avgAiScore =
            entry.scoredMatchesCount > 0
                ? entry.totalAiScore / entry.scoredMatchesCount
                : 0;

        const {
            matchIds: _matchIds,
            totalAiScore: _totalAiScore,
            totalDurationSeconds: _totalDurationSeconds,
            ...rest
        } = entry;

        candidates.push({
            ...rest,
            avgDamage,
            kdaRatio,
            winRate,
            avgVisionScore,
            avgCsPerMin,
            avgAiScore,
        });
    }

    return candidates;
}

export function getInterCandidatesLastWeek(opts: InterStatsOptions = {}) {
    return getInterCandidatesSince(Date.now() - ONE_WEEK_IN_MS, opts);
}

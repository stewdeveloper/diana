import 'dotenv/config';
import {
    getQueueNameById,
    getRoleNameTranslation,
    getRankTagsById,
} from '../api/utils/dataDragonService';
import { createMatchDetail } from '../api/matches/matchService';
import {
    calculateMatchScores,
    type PlayerScore,
} from '../scoring/scoringAlgorithm';
import { saveMatchScores } from '../scoring/scoringService';
import {
    calculateRankChange,
    determineRankMovement,
} from '../api/utils/rankService';
import { createLolService } from '../api/utils/lolService/lolServiceFactory';
import {
    setSummonerCurrentMatchIdByPuuid,
    getSummonerByPuuid,
    createRankHistory,
    getRankByMatchAndQueueType,
    updateSummonerIdentityByPuuid,
    updateSummonerRankByPuuid,
    fetchRankHistory,
} from '../api/summoners/summonerService';
import {
    getAllTrackedPuuids,
    getGuildsTrackingSummoner,
    getNotificationPref,
    getCompetitiveScopeFromConfig,
} from '../api/summoners/guildService.js';
import {
    isArenaMatch,
    countsForCompetition,
    COMPETITIVE_SCOPES,
    type CompetitiveScope,
} from '../utils/queueClassification';
import { buildDeepLolLink } from '../utils/deepLol.js';
import {
    notifyMatchEnd,
    notifyRankChange,
    notifyStreak,
    notifyMilestone,
} from '../notifications/leagueNotifications';
import { pickFlavorLine } from '../notifications/flavorLines';
import {
    computeWinLossStreak,
    fetchRecentResultsForPuuid,
    filterCompetitiveResults,
    isStreakThreshold,
    detectRankMilestone,
    type Streak,
    type RankMilestone,
} from '../utils/streaks';
import { Summoner, LeagueBotConfig } from '../types';
import { MatchV5DTOs } from 'twisted/dist/models-dto/matches/match-v5/match.dto';
import { Constants } from 'twisted';
import type { MessageAdapter } from '../../../core/pluginTypes';
import type { EventAdapter } from '../../../core/eventTypes';
import { buildMatchScopedEventId } from '../../../core/eventTypes';
import { getSquadsTrackingPuuid } from '../../../core/squads/squadService';

const lolService = createLolService();
const shouldForceDevelopmentTimers = Boolean(
    process.env.FORCE_DEVELOPMENT_TIMERS
);
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
let lastSummonerMetadataSync = 0;

const syncTrackedSummonerMetadata = async (puuid: string) => {
    const summoner = await getSummonerByPuuid(puuid);

    if (!summoner) {
        console.warn(
            `[Warn] Tracked PUUID ${puuid} not found in database, skipping metadata sync.`
        );
        return;
    }

    const account = await lolService.getAccountByPUUID(
        puuid,
        summoner.regionGroup as any
    );
    const deepLolLink = buildDeepLolLink(
        account.gameName,
        account.tagLine,
        summoner.matchRegionPrefix
    );
    const envDiscordChannelId = process.env.DISCORD_CHANNEL_ID;
    const targetDiscordChannelId =
        envDiscordChannelId ?? summoner.discordChannelId ?? null;

    await lolService.getActiveRegionByPUUID(puuid, summoner.regionGroup as any);

    const requiresUpdate =
        summoner.gameName !== account.gameName ||
        summoner.tagLine !== account.tagLine ||
        summoner.deepLolLink !== deepLolLink ||
        (targetDiscordChannelId !== null &&
            targetDiscordChannelId !== summoner.discordChannelId);

    if (!requiresUpdate) {
        console.log(
            `[Info] [${new Date().toISOString()}] Summoner identity already up to date for ${account.gameName}#${account.tagLine}.`
        );
    } else {
        await updateSummonerIdentityByPuuid(
            puuid,
            account.gameName,
            account.tagLine,
            deepLolLink,
            targetDiscordChannelId
        );
        console.log(
            `[Info] [${new Date().toISOString()}] Synced tracked summoner identity for ${account.gameName}#${account.tagLine}.`
        );
    }
};

const syncTrackedSummonersWithDatabase = async (puuids: string[]) => {
    console.log(
        `[Info] [${new Date().toISOString()}] Starting tracked summoner metadata sync...`
    );
    for (const puuid of puuids) {
        try {
            await syncTrackedSummonerMetadata(puuid);
        } catch (error) {
            console.error(
                `[Error] Failed to sync metadata for tracked PUUID ${puuid}:`,
                error
            );
        }
    }
    console.log(
        `[Info] [${new Date().toISOString()}] Finished tracked summoner metadata sync.`
    );
};

const checkAndHandleSummoner = async (
    summoner: Summoner,
    messageAdapter: MessageAdapter | null | undefined,
    eventAdapter?: EventAdapter | null
) => {
    try {
        const recentMatches = await lolService.getMatchesByPUUID(
            summoner.puuid,
            1,
            summoner.regionGroup as any
        );

        if (recentMatches.length === 0) {
            console.log(
                `[Info] [${new Date().toISOString()}] No matches found for summoner [${summoner.gameName}]`
            );
            return;
        }

        const mostRecentMatchId = recentMatches[0];
        const storedMatchId = summoner.currentMatchId;

        if (mostRecentMatchId !== storedMatchId) {
            console.log(
                `[Info] [${new Date().toISOString()}] New match detected for [${summoner.gameName}]: ${mostRecentMatchId}`
            );
            await handleNewMatchCompleted(
                summoner,
                mostRecentMatchId,
                messageAdapter,
                eventAdapter
            );
        } else {
            console.log(
                `[Info] [${new Date().toISOString()}] No new matches for [${summoner.gameName}]`
            );
        }
    } catch (error) {
        console.error(
            `[Error] [${new Date().toISOString()}] [${summoner.gameName}] (PUUID=${summoner.puuid}): ${error}`
        );
    }
};

const handleNewMatchCompleted = async (
    summoner: Summoner,
    newMatchId: string,
    messageAdapter: MessageAdapter | null | undefined,
    eventAdapter?: EventAdapter | null
) => {
    const { puuid, gameName: summonerName } = summoner;

    let matchSummaryData: MatchV5DTOs.MatchDto = {
        metadata: { dataVersion: '', matchId: '', participants: [] },
        info: {
            gameCreation: 0,
            gameDuration: 0,
            gameEndTimestamp: 0,
            gameId: 0,
            gameMode: '',
            gameName: '',
            gameStartTimestamp: 0,
            gameType: '',
            gameVersion: '',
            mapId: 0,
            participants: [],
            platformId: '',
            queueId: 0,
            teams: [],
            tournamentCode: '',
            endOfGameResult: '',
        },
    };

    try {
        matchSummaryData = await lolService.getMatchSummary(newMatchId);
    } catch {
        console.error(
            `[Error] Failed to get match summary for ${summonerName} (${newMatchId})`
        );
    }

    const info = matchSummaryData.info;
    const participants: MatchV5DTOs.ParticipantDto[] = info.participants ?? [];
    const teams = info.teams ?? [];

    const matchDetails = {
        matchId: newMatchId,
        entryPlayerPuuid: puuid,
        gameCreation: info.gameCreation ?? 0,
        gameStartTime: info.gameStartTimestamp ?? 0,
        gameEndTime: info.gameEndTimestamp ?? 0,
        gameVersion: info.gameVersion ?? 'Unknown',
        gameDuration: info.gameDuration ?? 0,
        gameMode: info.gameMode ?? 'Unknown',
        gameType: info.gameType ?? 'Unknown',
        queueId: info.queueId ?? 0,
        mapName: info.mapId ?? 0,
        participants: JSON.stringify(participants),
        teams: JSON.stringify(teams),
    };

    // Arena (gameMode CHERRY) is a placement mode with no lanes or wards, so
    // the role-weighted AI score is meaningless for it. Skip scoring entirely -
    // this leaves `scores` empty, which in turn drops the AI Score and Match
    // Placement embed fields and the placement-based flavor lines for free.
    const arena = isArenaMatch(info.gameMode, info.queueId);

    let scores: PlayerScore[] = [];
    if (!arena) {
        try {
            scores = calculateMatchScores(
                participants as Record<string, any>[]
            );
        } catch (scoringError) {
            console.error(
                `[Error] Failed to calculate match scores for [${newMatchId}]:`,
                scoringError
            );
        }
    }

    let createdMatchDetail: Awaited<ReturnType<typeof createMatchDetail>>;
    try {
        createdMatchDetail = await createMatchDetail(matchDetails);
    } catch (error: any) {
        console.error(
            `[Error] [${new Date().toISOString()}] Failed to create match detail for [${summonerName}]:`,
            error
        );
        throw error;
    }

    // The INSERT uses `ON CONFLICT ("matchId","entryPlayerPuuid") DO NOTHING`,
    // so the first concurrent tick to reach this point wins and gets a row
    // back. Subsequent ticks (queued by Riot rate-limiting; cron has no
    // concurrency guard) get `null` — they must NOT re-fan-out notifications,
    // or each match gets spammed N times. We still advance this summoner's
    // pointer so the next tick sees the match as already processed.
    if (!createdMatchDetail) {
        console.log(
            `[Info] [${new Date().toISOString()}] Match detail already exists for [${summonerName}], skipping notifications (matchId: ${newMatchId})`
        );
        await setSummonerCurrentMatchIdByPuuid(puuid, newMatchId);
        return;
    }

    console.log(
        `[Info] [${new Date().toISOString()}] Stored match detail for [${summonerName}] (matchId: ${newMatchId})`
    );
    if (arena) {
        console.log(
            `[Info] [${new Date().toISOString()}] Skipped scoring for Arena match [${newMatchId}] - Arena never counts toward competition`
        );
    } else {
        try {
            await saveMatchScores(newMatchId, scores);
            console.log(
                `[Info] [${new Date().toISOString()}] Saved match scores for [${newMatchId}] (${scores.length} participants)`
            );
        } catch (scoringError) {
            console.error(
                `[Error] Failed to save match scores for [${newMatchId}]:`,
                scoringError
            );
        }
    }

    const participant = participants.find(
        (p: MatchV5DTOs.ParticipantDto) => p.puuid === puuid
    );
    const gameDuration = info.gameDuration ?? 0;

    const myScore = scores.find((s) => s.puuid === puuid);
    const summonerPlacement = myScore?.placement;
    const summonerAiScore = myScore?.score;

    // The <5min remake heuristic is a Summoner's Rift rule. An Arena subteam
    // eliminated early finishes legitimately short, so don't call it a remake.
    let result = 'Lose';
    if (!arena && gameDuration < 300) result = 'Remake';
    else if (participant?.win) result = 'Win';

    const queueName = getQueueNameById(info.queueId ?? 0);
    const kdaStr = `${participant?.kills ?? 0}/${participant?.deaths ?? 0}/${participant?.assists ?? 0}`;
    const champion = participant?.championName || 'Unknown';
    const role =
        participant?.individualPosition || participant?.teamPosition || 'N/A';
    const damage = participant?.totalDamageDealtToChampions ?? 0;
    const matchRank = getRankTagsById(info.queueId ?? 0);

    // Challenge-derived stats. `challenges` is untyped in twisted's DTO, so
    // access is guarded the same way as the scoring algorithm does it.
    const challenges = (participant as Record<string, any> | undefined)
        ?.challenges as Record<string, unknown> | undefined;
    const challengeNumber = (key: string): number | undefined => {
        const value = challenges?.[key];
        return typeof value === 'number' && Number.isFinite(value)
            ? value
            : undefined;
    };
    const rawKillParticipation = challengeNumber('killParticipation');
    const killParticipationPct =
        rawKillParticipation != null
            ? Math.round(rawKillParticipation * 100)
            : undefined;
    const damagePerMinute = challengeNumber('damagePerMinute');
    const soloKills = challengeNumber('soloKills');
    const visionScore = participant?.visionScore;

    // Arena's real placement: 8 subteams of 2, so 1st-8th. Riot exposes it as
    // `subteamPlacement`, which twisted's DTO doesn't type - same cast as above.
    const rawSubteamPlacement = (participant as Record<string, any> | undefined)
        ?.subteamPlacement;
    const arenaPlacement =
        arena &&
        Number.isInteger(rawSubteamPlacement) &&
        rawSubteamPlacement >= 1 &&
        rawSubteamPlacement <= 8
            ? (rawSubteamPlacement as number)
            : undefined;
    const arenaTeamCount =
        arena && participants.length
            ? Math.max(1, Math.round(participants.length / 2))
            : undefined;
    const enemyMissingPings = (participant as Record<string, any> | undefined)
        ?.enemyMissingPings as number | undefined;
    const largestMultikill = (participant as Record<string, any> | undefined)
        ?.largestMultiKill as number | undefined;

    let newRankMsg = 'Unranked N/A (0 LP)';
    let lpChangeMsg: number | null = null;
    let checkForRankUp = 'no_change';
    let latestRankInfo: { tier: string; rank: string; lp: number } | null =
        null;

    try {
        if (matchRank) {
            const rankEntriesPost =
                await lolService.getRankEntriesByPUUID(puuid);
            const rankPost = rankEntriesPost?.find(
                (e) => e.queueType === matchRank
            );

            // Anchor the previous rank to a SPECIFIC known row — either the
            // rank recorded during the last monitored match, or the INIT row
            // written when the summoner was first added. Never fall back to
            // "most recent rank for this summoner" — that can return a row
            // from before a data gap, producing misleading deltas.
            let oldRankInfo = summoner.currentMatchId
                ? await getRankByMatchAndQueueType(
                      summoner.currentMatchId,
                      puuid,
                      matchRank
                  )
                : null;
            if (!oldRankInfo) {
                oldRankInfo = await getRankByMatchAndQueueType(
                    'INIT',
                    puuid,
                    matchRank
                );
            }

            if (rankPost) {
                const summonerNewRankInfo = {
                    tier: rankPost.tier,
                    rank: rankPost.rank,
                    lp: rankPost.leaguePoints,
                    puuid,
                };

                newRankMsg = `${summonerNewRankInfo.tier} ${summonerNewRankInfo.rank} (${summonerNewRankInfo.lp} LP)`;

                if (oldRankInfo) {
                    const rankChange = calculateRankChange(
                        oldRankInfo,
                        summonerNewRankInfo
                    );
                    checkForRankUp = determineRankMovement(
                        oldRankInfo,
                        summonerNewRankInfo
                    );
                    lpChangeMsg = rankChange.lpChange;
                } else {
                    console.warn(
                        `[Warn] [${new Date().toISOString()}] No rank baseline for ${summonerName} (${newMatchId}, ${matchRank}); suppressing LP delta for this match.`
                    );
                }

                try {
                    await createRankHistory(
                        newMatchId,
                        puuid,
                        summonerNewRankInfo.tier,
                        summonerNewRankInfo.rank,
                        summonerNewRankInfo.lp,
                        matchRank
                    );
                } catch (dbError) {
                    console.error(
                        `[Error] Failed to save rank history for ${summonerName} (${newMatchId}): ${dbError}`
                    );
                }

                try {
                    await updateSummonerRankByPuuid(
                        puuid,
                        summonerNewRankInfo.tier,
                        summonerNewRankInfo.rank,
                        summonerNewRankInfo.lp
                    );
                } catch (dbError) {
                    console.error(
                        `[Error] Failed to refresh summoner rank columns for ${summonerName}: ${dbError}`
                    );
                }

                latestRankInfo = {
                    tier: summonerNewRankInfo.tier,
                    rank: summonerNewRankInfo.rank,
                    lp: summonerNewRankInfo.lp,
                };
            }
        }
    } catch (error) {
        console.error(
            `[Error] Failed to fetch updated rank for ${summonerName}: ${error}`
        );
    }

    const baseMatchSummary = {
        summonerName,
        queueName,
        result,
        gameLengthSeconds: gameDuration,
        newRankMsg,
        lpChangeMsg,
        championDisplay: champion,
        role: getRoleNameTranslation(role),
        kdaStr,
        damage,
        deepLolLink: summoner.deepLolLink || '',
        placement: summonerPlacement,
        totalPlayers: participants.length || undefined,
        aiScore: summonerAiScore,
        killParticipationPct,
        damagePerMinute,
        soloKills,
        visionScore,
        isArena: arena,
        arenaPlacement,
        arenaTeamCount,
        flavorLine: pickFlavorLine({
            isArena: arena,
            result: result.toLowerCase() as 'win' | 'lose' | 'remake',
            kills: participant?.kills ?? 0,
            deaths: participant?.deaths ?? 0,
            assists: participant?.assists ?? 0,
            killParticipationPct,
            damagePerMinute,
            soloKills,
            visionScore,
            enemyMissingPings,
            largestMultikill,
            placement: summonerPlacement,
            totalPlayers: participants.length || undefined,
            gameLengthSeconds: gameDuration,
        }),
    };

    // Streak and milestone detection - purely from data already stored.
    //
    // Streaks are per-guild now, because guilds disagree on which queues count.
    // One DB read serves every scope: fetch unfiltered, then narrow in memory
    // once per scope and let the fan-out loop below pick the right variant.
    const streakByScope: Record<CompetitiveScope, Streak | null> = {
        all: null,
        ranked: null,
    };
    try {
        if (result !== 'Remake') {
            // 12 was enough when every queue counted. Under 'ranked' a 10-game
            // streak needs 10 *ranked* rows in the window, so widen it.
            const recentResults = await fetchRecentResultsForPuuid(puuid, 30);
            const thisMatch = {
                gameMode: info.gameMode,
                queueId: info.queueId,
            };
            for (const scope of COMPETITIVE_SCOPES) {
                // If the match that just finished doesn't count for this scope,
                // the streak is unchanged from the last counting match and was
                // already announced - re-announcing would double-post it.
                if (!countsForCompetition(thisMatch, scope)) continue;
                const streak = computeWinLossStreak(
                    filterCompetitiveResults(recentResults, scope)
                );
                if (streak && isStreakThreshold(streak)) {
                    streakByScope[scope] = streak;
                }
            }
        }
    } catch (error) {
        console.error(
            `[Error] Failed to compute streak for ${summonerName}:`,
            error
        );
    }

    let milestoneToAnnounce: RankMilestone | null = null;
    try {
        if (latestRankInfo && matchRank) {
            const history = await fetchRankHistory(
                puuid,
                undefined,
                undefined,
                matchRank
            );
            milestoneToAnnounce = detectRankMilestone(
                history,
                latestRankInfo,
                newMatchId
            );
        }
    } catch (error) {
        console.error(
            `[Error] Failed to detect rank milestone for ${summonerName}:`,
            error
        );
    }

    let anyMessageSent = false;
    try {
        const guildTargets = await getGuildsTrackingSummoner(puuid);
        for (const target of guildTargets) {
            const wantsMatchPosts = getNotificationPref(target, 'match_posts');
            const wantsRankPosts = getNotificationPref(target, 'rank_posts');
            if (!wantsMatchPosts && !wantsRankPosts) continue;

            if (wantsMatchPosts) {
                const matchSummary = {
                    ...baseMatchSummary,
                    discordChannelId: target.channel_id,
                };
                const sent = await notifyMatchEnd(messageAdapter, matchSummary);
                if (sent) anyMessageSent = true;
            }

            if (wantsRankPosts && checkForRankUp !== 'no_change') {
                const rankChangeInfo = {
                    summonerName,
                    direction:
                        checkForRankUp === 'promoted' ? 'promoted' : 'demoted',
                    newRankMsg,
                    lpChangeMsg,
                    discordChannelId: target.channel_id,
                    deepLolLink: summoner.deepLolLink || '',
                };
                const sent = await notifyRankChange(
                    messageAdapter,
                    rankChangeInfo
                );
                if (sent) anyMessageSent = true;
            }

            if (getNotificationPref(target, 'streaks')) {
                // Match posts above fire for every queue; only the derived
                // posts respect this guild's competitive scope.
                const guildStreak =
                    streakByScope[getCompetitiveScopeFromConfig(target)];
                if (guildStreak) {
                    await notifyStreak(messageAdapter, {
                        summonerName,
                        kind: guildStreak.kind,
                        length: guildStreak.length,
                        deepLolLink: summoner.deepLolLink || '',
                        discordChannelId: target.channel_id,
                    });
                }
                if (milestoneToAnnounce) {
                    await notifyMilestone(messageAdapter, {
                        summonerName,
                        milestone: milestoneToAnnounce,
                        newRankMsg,
                        deepLolLink: summoner.deepLolLink || '',
                        discordChannelId: target.channel_id,
                    });
                }
            }
        }

        if (guildTargets.length === 0 && process.env.DISCORD_CHANNEL_ID) {
            const fallbackChannelId = process.env.DISCORD_CHANNEL_ID;
            const matchSummary = {
                ...baseMatchSummary,
                discordChannelId: fallbackChannelId,
            };
            const sent = await notifyMatchEnd(messageAdapter, matchSummary);
            if (sent) anyMessageSent = true;

            if (checkForRankUp !== 'no_change') {
                const rankChangeInfo = {
                    summonerName,
                    direction:
                        checkForRankUp === 'promoted' ? 'promoted' : 'demoted',
                    newRankMsg,
                    lpChangeMsg,
                    discordChannelId: fallbackChannelId,
                    deepLolLink: summoner.deepLolLink || '',
                };
                await notifyRankChange(messageAdapter, rankChangeInfo);
            }
        }

        if (!anyMessageSent) {
            console.warn(
                `[Warn] [${new Date().toISOString()}] No notification sent for [${summonerName}] match ${newMatchId}: no channel configured for any tracking guild.`
            );
        }
    } catch (error) {
        console.error(
            `[Error] Failed to fan out match notifications for ${summonerName}:`,
            error
        );
    }

    // Structured events (DN-1), scoped to the squad (DN-2).
    //
    // Emitted once per *squad* tracking this player, not once per Discord guild:
    // an event is a fact about the group, not about a channel. A squad reachable
    // from both a Discord guild and a Meeps space still gets exactly one row per
    // event, and a match is still captured when no guild is configured to post.
    //
    // Never allowed to break match posting - hence its own try/catch, and an
    // adapter that does not throw.
    try {
        if (eventAdapter) {
            const occurredAt = new Date(
                info.gameStartTimestamp
                    ? info.gameStartTimestamp + gameDuration * 1000
                    : Date.now()
            ).toISOString();

            for (const squadId of await getSquadsTrackingPuuid(puuid)) {
                await eventAdapter.emit({
                    eventId: buildMatchScopedEventId(
                        'match.completed',
                        squadId,
                        newMatchId,
                        puuid
                    ),
                    type: 'match.completed',
                    occurredAt,
                    squadId,
                    matchId: newMatchId,
                    puuid,
                    summonerName,
                    queueId: info.queueId ?? undefined,
                    queueName,
                    gameMode: info.gameMode ?? undefined,
                    isArena: arena,
                    // Arena is excluded here regardless of any guild's setting.
                    countsForCompetition: countsForCompetition(
                        { gameMode: info.gameMode, queueId: info.queueId },
                        'all'
                    ),
                    subteamPlacement: arenaPlacement,
                    championName: champion,
                    role: getRoleNameTranslation(role),
                    result,
                    win: result === 'Win',
                    kills: participant?.kills ?? 0,
                    deaths: participant?.deaths ?? 0,
                    assists: participant?.assists ?? 0,
                    damage,
                    gameDurationSeconds: gameDuration,
                    aiScore: summonerAiScore,
                    placement: summonerPlacement,
                    totalPlayers: participants.length || undefined,
                    lpChange: lpChangeMsg,
                    rankAfter: newRankMsg,
                });

                if (checkForRankUp !== 'no_change') {
                    await eventAdapter.emit({
                        eventId: buildMatchScopedEventId(
                            'rank.changed',
                            squadId,
                            newMatchId,
                            puuid
                        ),
                        type: 'rank.changed',
                        occurredAt,
                        squadId,
                        matchId: newMatchId,
                        puuid,
                        summonerName,
                        direction:
                            checkForRankUp === 'promoted'
                                ? 'promoted'
                                : 'demoted',
                        rankAfter: newRankMsg,
                        lpChange: lpChangeMsg,
                    });
                }

                // Streaks are computed once per match, not per guild, so they
                // carry the 'all' scope (Arena excluded, every other queue
                // counted) and declare it - consumers re-filter from the
                // match.completed fields.
                const streakForEvent = streakByScope.all;
                if (streakForEvent) {
                    await eventAdapter.emit({
                        eventId: buildMatchScopedEventId(
                            'streak',
                            squadId,
                            newMatchId,
                            puuid
                        ),
                        type: 'streak',
                        occurredAt,
                        squadId,
                        matchId: newMatchId,
                        puuid,
                        summonerName,
                        kind: streakForEvent.kind,
                        length: streakForEvent.length,
                        competitiveScope: 'all',
                    });
                }

                if (milestoneToAnnounce) {
                    await eventAdapter.emit({
                        eventId: buildMatchScopedEventId(
                            'milestone',
                            squadId,
                            newMatchId,
                            puuid
                        ),
                        type: 'milestone',
                        occurredAt,
                        squadId,
                        matchId: newMatchId,
                        puuid,
                        summonerName,
                        milestone: milestoneToAnnounce,
                        rankAfter: newRankMsg,
                    });
                }
            }
        }
    } catch (error) {
        console.error(
            `[Error] Failed to emit match events for ${summonerName}:`,
            error
        );
    }

    await setSummonerCurrentMatchIdByPuuid(puuid, newMatchId);
};

export function createMatchMonitoringTick(
    config: LeagueBotConfig,
    messageAdapter: MessageAdapter | null | undefined,
    eventAdapter?: EventAdapter | null
): () => Promise<void> {
    return async function runMatchMonitoringTick(): Promise<void> {
        if (process.env.STOP_BOT) {
            console.log(
                `[Info] [${new Date().toISOString()}] Stop bot enabled, skipping run...`
            );
            return;
        }
        const apiValid = await lolService.checkConnection();
        if (apiValid) {
            const trackedPuuids = await getAllTrackedPuuids();

            const now = Date.now();
            if (
                shouldForceDevelopmentTimers ||
                now - lastSummonerMetadataSync >= TWENTY_FOUR_HOURS_MS
            ) {
                await syncTrackedSummonersWithDatabase(trackedPuuids);
                lastSummonerMetadataSync = now;
            }

            console.log(
                `[Info] [${new Date().toISOString()}] Starting cron check for completed matches (${trackedPuuids.length} summoners)...`
            );
            for (const puuid of trackedPuuids) {
                const summoner = await getSummonerByPuuid(puuid);
                if (summoner) {
                    await checkAndHandleSummoner(
                        summoner,
                        messageAdapter,
                        eventAdapter
                    );
                } else {
                    console.log(
                        `[Info] [${new Date().toISOString()}] Player PUUID[${puuid}] was not found in database.`
                    );
                }
            }
            console.log(
                `[Info] [${new Date().toISOString()}] Finished cron check.\n`
            );
        } else {
            console.log(
                `[Error] [${new Date().toISOString()}] API connection failed, skipping run...`
            );
        }
    };
}

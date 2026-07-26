import { Request, Response } from 'express';
import { getParamValue } from '../../../../core/api/requestUtils';
import { isArenaMatch } from '../../utils/queueClassification';
import {
    createMatchDetail,
    getMatchDetailsByPuuid,
    getMatchDetailsByMatchId,
    listRecentMatchDetails,
    listMatchFilterOptions,
    getRankForMatch,
    getPreviousRankForMatch,
    updateMatchDetail,
    deleteMatchDetail,
    createMatchTimeline,
    getMatchTimeline,
    updateMatchTimeline,
    deleteMatchTimeline,
} from './matchService.js';
import {
    getQueueNameById,
    getRoleNameTranslation,
    getRankTagsById,
} from '../utils/dataDragonService.js';
import { getChampionThumbnail } from '../../presentation/leaguePresentation.js';
import {
    buildMatchEndMessage,
    buildRankChangeMessage,
} from '../../notifications/leagueNotifications.js';
import { determineRankMovement } from '../utils/rankService.js';
import { getSummonerByPuuid } from '../summoners/summonerService.js';

export const createMatchDetailHandler = async (
    req: Request,
    res: Response
): Promise<any> => {
    try {
        const matchDetail = req.body;
        const createdMatch = await createMatchDetail(matchDetail);
        res.status(201).json(createdMatch);
    } catch (error) {
        console.error(`[ERROR] ${error}`);
        res.status(500).json({ error: 'Failed to create match detail.' });
    }
};

export const getMatchDetailsHandler = async (
    req: Request<{ puuid: string }, {}, {}, { numberOfMatches: number }>,
    res: Response
): Promise<any> => {
    try {
        const puuid = getParamValue(req.params.puuid);
        const numberOfMatches = req.query.numberOfMatches || 20;

        if (!puuid) {
            return res
                .status(400)
                .json({ error: 'Missing required parameter: puuid.' });
        }

        const matchDetails = await getMatchDetailsByPuuid(
            puuid,
            numberOfMatches
        );

        if (!matchDetails || matchDetails.length === 0) {
            return res.status(404).json({ error: 'No match details found.' });
        }

        res.status(200).json(matchDetails);
    } catch (error) {
        console.log(
            `[ERROR] Error Code 500 - Failed to fetch match details.`,
            error
        );
        res.status(500).json({ error: 'Failed to fetch match details.' });
    }
};

export const getMatchDetailsByMatchIdHandler = async (
    req: Request,
    res: Response
): Promise<any> => {
    try {
        const matchId = getParamValue(req.params.matchId);

        if (!matchId) {
            console.log(
                `[WARN] Error Code 400 - Missing required parameter: matchId.`
            );
            return res
                .status(400)
                .json({ error: 'Missing required parameter: matchId.' });
        }

        const matchDetails = await getMatchDetailsByMatchId(matchId);

        if (!matchDetails || matchDetails.length === 0) {
            console.log(`[WARN] Error Code 404 - No match details found.`);
            return res.status(404).json({ error: 'No match details found.' });
        }

        res.status(200).json(matchDetails);
    } catch (error) {
        console.log(
            `[ERROR] Error Code 500 - Failed to fetch match details.`,
            error
        );
        res.status(500).json({ error: 'Failed to fetch match details.' });
    }
};

export const getRecentMatchDetailsHandler = async (
    req: Request,
    res: Response
): Promise<any> => {
    try {
        const rawLimit = Number(req.query.limit);
        const rawOffset = Number(req.query.offset);
        const playerPuuid =
            typeof req.query.player === 'string' ? req.query.player : undefined;
        const queueId =
            typeof req.query.queueId === 'string'
                ? Number(req.query.queueId)
                : undefined;
        const resultFilter =
            typeof req.query.result === 'string' ? req.query.result : undefined;
        const limit =
            Number.isFinite(rawLimit) && rawLimit > 0
                ? Math.min(rawLimit, 50)
                : 20;
        const offset =
            Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

        const rows = await listRecentMatchDetails(limit, offset, {
            entryPlayerPuuid: playerPuuid,
            queueId: Number.isFinite(queueId) ? queueId : undefined,
            result:
                resultFilter === 'Win' ||
                resultFilter === 'Lose' ||
                resultFilter === 'Remake'
                    ? resultFilter
                    : undefined,
        });
        const matches = await Promise.all(
            rows.map(async (row: any) => {
                const participantsRaw = row.participants ?? [];
                let participants: any[] = [];
                if (Array.isArray(participantsRaw)) {
                    participants = participantsRaw;
                } else if (typeof participantsRaw === 'string') {
                    try {
                        const parsed = JSON.parse(participantsRaw);
                        participants = Array.isArray(parsed) ? parsed : [];
                    } catch {
                        participants = [];
                    }
                }
                const entry =
                    row.entryParticipant ??
                    participants.find(
                        (p: any) => p.puuid === row.entryPlayerPuuid
                    );

                const arena = isArenaMatch(row.gameMode, row.queueId);
                const gameDuration = row.gameDuration ?? 0;
                let result = row.match_result || 'Lose';
                if (!row.match_result) {
                    // The <5min remake rule is Summoner's Rift only - an Arena
                    // subteam eliminated early legitimately finishes short.
                    if (!arena && gameDuration < 300) result = 'Remake';
                    else if (entry?.win) result = 'Win';
                }

                const queueName = getQueueNameById(row.queueId ?? 0);
                const rawSubteamPlacement = (entry as any)?.subteamPlacement;
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
                const kdaStr = `${entry?.kills ?? 0}/${entry?.deaths ?? 0}/${
                    entry?.assists ?? 0
                }`;
                const champion = entry?.championName || 'Unknown';
                const role =
                    entry?.individualPosition || entry?.teamPosition || 'N/A';
                const damage = entry?.totalDamageDealtToChampions ?? 0;
                const matchRank = getRankTagsById(row.queueId ?? 0);
                const rankInfo = matchRank
                    ? await getRankForMatch(row.matchId, row.entryPlayerPuuid)
                    : null;
                const previousRank =
                    matchRank && rankInfo?.queueType
                        ? await getPreviousRankForMatch(
                              row.entryPlayerPuuid,
                              rankInfo.queueType,
                              row.matchId
                          )
                        : null;
                const rankDisplay = rankInfo
                    ? `${rankInfo.tier} ${rankInfo.rank} (${rankInfo.lp} LP)`
                    : null;
                const rankTier = rankInfo?.tier ?? null;
                const lpChange =
                    rankInfo && previousRank
                        ? rankInfo.lp - previousRank.lp
                        : null;
                const summoner = await getSummonerByPuuid(row.entryPlayerPuuid);
                const deepLolLink = (summoner as any)?.deepLolLink || '';
                const notificationPayload = await buildMatchEndMessage({
                    summonerName:
                        entry?.riotIdGameName ||
                        entry?.summonerName ||
                        'Unknown',
                    queueName,
                    result,
                    gameLengthSeconds: gameDuration,
                    newRankMsg: rankDisplay || 'Unranked N/A (0 LP)',
                    lpChangeMsg: lpChange ?? 0,
                    championDisplay: champion,
                    role: getRoleNameTranslation(role),
                    kdaStr,
                    damage,
                    deepLolLink,
                    isArena: arena,
                    arenaPlacement,
                    arenaTeamCount,
                });
                const rankMovement =
                    previousRank && rankInfo
                        ? determineRankMovement(
                              {
                                  tier: previousRank.tier,
                                  rank: previousRank.rank,
                                  lp: previousRank.lp,
                              },
                              {
                                  tier: rankInfo.tier,
                                  rank: rankInfo.rank,
                                  lp: rankInfo.lp,
                              }
                          )
                        : 'no_change';
                const rankNotificationPayload =
                    rankMovement !== 'no_change' && rankDisplay
                        ? buildRankChangeMessage({
                              summonerName:
                                  entry?.riotIdGameName ||
                                  entry?.summonerName ||
                                  'Unknown',
                              direction:
                                  rankMovement === 'promoted'
                                      ? 'promoted'
                                      : 'demoted',
                              newRankMsg: rankDisplay,
                              lpChangeMsg: lpChange ?? 0,
                              deepLolLink,
                          })
                        : null;

                return {
                    id: row.mid,
                    matchId: row.matchId,
                    entryPlayerPuuid: row.entryPlayerPuuid,
                    summonerName:
                        entry?.riotIdGameName ||
                        entry?.summonerName ||
                        'Unknown',
                    tagLine: entry?.riotIdTagline || null,
                    queueName,
                    result,
                    champion,
                    championImageUrl: await getChampionThumbnail(champion),
                    role: getRoleNameTranslation(role),
                    kda: kdaStr,
                    damage,
                    rank: rankDisplay,
                    rankTier,
                    lpChange,
                    notificationPayload,
                    rankNotificationPayload,
                    gameCreation: row.gameCreation ?? null,
                    gameDuration: row.gameDuration ?? null,
                    gameMode: row.gameMode ?? null,
                    gameType: row.gameType ?? null,
                };
            })
        );

        res.status(200).json({
            matches,
            limit,
            offset,
            hasMore: rows.length === limit,
        });
    } catch (error) {
        console.log(
            `[ERROR] Error Code 500 - Failed to fetch recent match details.`,
            error
        );
        res.status(500).json({
            error: 'Failed to fetch recent match details.',
        });
    }
};

export const getMatchFiltersHandler = async (
    _req: Request,
    res: Response
): Promise<any> => {
    try {
        const { players, queueIds } = await listMatchFilterOptions();
        const matchTypes = (queueIds || [])
            .filter((id: number) => typeof id === 'number')
            .map((id: number) => ({
                queueId: id,
                name: getQueueNameById(id),
            }));
        res.status(200).json({
            players: players.map((p: any) => ({
                puuid: p.puuid,
                gameName: p.gameName,
                tagLine: p.tagLine,
            })),
            matchTypes,
            results: ['Win', 'Lose', 'Remake'],
        });
    } catch (error) {
        console.log(
            `[ERROR] Error Code 500 - Failed to fetch match filters.`,
            error
        );
        res.status(500).json({ error: 'Failed to fetch match filters.' });
    }
};

export const updateMatchDetailHandler = async (
    req: Request,
    res: Response
): Promise<any> => {
    try {
        const matchId = getParamValue(req.params.matchId);
        if (!matchId) {
            console.log(
                `[WARN] Error Code 400 - Missing required parameter: matchId.`
            );
            return res
                .status(400)
                .json({ error: 'Missing required parameter: matchId.' });
        }
        const updatedDetails = req.body;

        const updatedMatch = await updateMatchDetail(matchId, updatedDetails);

        if (!updatedMatch) {
            console.log(`[WARN] Error Code 404 - Match Details not found.`);
            return res.status(404).json({ error: 'Match detail not found.' });
        }

        res.status(200).json(updatedMatch);
    } catch (error) {
        console.log(
            `[ERROR] Error Code 500 - Failed to update match details.`,
            error
        );
        res.status(500).json({ error: 'Failed to update match detail.' });
    }
};

export const deleteMatchDetailHandler = async (
    req: Request,
    res: Response
): Promise<any> => {
    try {
        const matchId = getParamValue(req.params.matchId);
        if (!matchId) {
            console.log(
                `[WARN] Error Code 400 - Missing required parameter: matchId.`
            );
            return res
                .status(400)
                .json({ error: 'Missing required parameter: matchId.' });
        }

        const deletedMatch = await deleteMatchDetail(matchId);

        if (!deletedMatch) {
            console.log(`[WARN] Error Code 404 - Match Details not found.`);
            return res.status(404).json({ error: 'Match detail not found.' });
        }

        res.status(200).json({ message: 'Match detail deleted successfully.' });
    } catch (error) {
        console.log(
            `[ERROR] Error Code 500 - Failed to delete match detail.`,
            error
        );
        res.status(500).json({ error: 'Failed to delete match detail.' });
    }
};

export const createMatchTimelineHandler = async (
    req: Request,
    res: Response
): Promise<any> => {
    try {
        const data = req.body;
        const created = await createMatchTimeline(data);
        res.status(201).json(created);
    } catch (error) {
        console.log(
            `[ERROR] Error Code 500 - Failed to delete match detail.`,
            error
        );
        res.status(500).json({ error: 'Failed to create match timeline.' });
    }
};

export const fetchMatchTimelineHandler = async (
    req: Request,
    res: Response
): Promise<any> => {
    try {
        const matchId = getParamValue(req.params.matchId);
        if (!matchId) {
            console.log(
                `[WARN] Error Code 400 - Missing required parameter: matchId.`
            );
            return res
                .status(400)
                .json({ error: 'Missing required parameter: matchId.' });
        }
        const timeline = await getMatchTimeline(matchId);
        if (!timeline.length) {
            console.log(`[WARN] Error Code 404 - No timeline found.`);
            return res.status(404).json({ error: 'No timeline found.' });
        }
        res.status(200).json(timeline);
    } catch (error) {
        console.log(
            `[ERROR] Error Code 500 - Failed to fetch match timeline.`,
            error
        );
        res.status(500).json({ error: 'Failed to fetch match timeline.' });
    }
};

export const updateMatchTimelineHandler = async (
    req: Request,
    res: Response
): Promise<any> => {
    try {
        const timelineId = getParamValue(req.params.timelineId);
        if (!timelineId) {
            console.log(
                `[WARN] Error Code 400 - Missing required parameter: timelineId.`
            );
            return res
                .status(400)
                .json({ error: 'Missing required parameter: timelineId.' });
        }
        const data = req.body;
        const updated = await updateMatchTimeline(timelineId, data);
        if (!updated) {
            console.log(`[WARN] Error Code 404 - Timeline not found.`);
            return res.status(404).json({ error: 'Timeline not found.' });
        }
        res.status(200).json(updated);
    } catch (error) {
        console.log(
            `[ERROR] Error Code 500 - Failed to update match timeline.`,
            error
        );
        res.status(500).json({ error: 'Failed to update match timeline.' });
    }
};

export const deleteMatchTimelineHandler = async (
    req: Request,
    res: Response
): Promise<any> => {
    try {
        const timelineId = getParamValue(req.params.timelineId);
        if (!timelineId) {
            console.log(
                `[WARN] Error Code 400 - Missing required parameter: timelineId.`
            );
            return res
                .status(400)
                .json({ error: 'Missing required parameter: timelineId.' });
        }
        const deleted = await deleteMatchTimeline(timelineId);
        if (!deleted) {
            console.log(`[WARN] Error Code 404 - Timeline not found.`);
            return res.status(404).json({ error: 'Timeline not found.' });
        }
        res.status(200).json({
            message: 'Match timeline deleted successfully.',
        });
    } catch (error) {
        console.log(
            `[ERROR] Error Code 500 - Failed to delete match timeline.`,
            error
        );
        res.status(500).json({ error: 'Failed to delete match timeline.' });
    }
};

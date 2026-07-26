import {
    EmbedBuilder,
    SlashCommandBuilder,
    type SlashCommandStringOption,
} from 'discord.js';
import { Constants } from 'twisted';
import type { SlashCommand } from '../../../../discord/commandTypes';
import {
    getSummonerByAccountName,
    searchSummonerGameNames,
    searchSummonerTags,
    getMostRecentRankByParticipantIdAndQueueType,
    fetchRankHistory,
    getTotalPoints,
    buildSparkline,
    db,
    calculateWinRatePercentage,
    getQueueNameById,
    rankColors,
    getRankedEmblem,
    getInterCandidatesLastWeek,
    getGuildCompetitiveScope,
    countsForCompetition,
    parseParticipants,
    ONE_WEEK_IN_MS,
    type CompetitiveScope,
    type InterCandidate,
    type RawMatchRow,
    type RiotParticipant,
} from 'diana-core';

type QueueResult = 'WIN' | 'LOSS' | 'REMAKE';

interface ParsedMatch {
    id: string;
    createdAt: number;
    queueId: number;
    gameMode: string | null;
    duration: number;
    participant: RiotParticipant;
}

interface YearlyStats {
    wins: number;
    losses: number;
    remakes: number;
}

const regionChoices = Object.entries(Constants.Regions)
    .map(([label, value]) => ({ label, value }))
    .filter(
        (choice, index, self) =>
            self.findIndex((entry) => entry.value === choice.value) === index
    )
    .slice(0, 25);

function toNumber(value: number | string | null | undefined): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function getResult(
    participant: RiotParticipant,
    duration: number
): QueueResult {
    if (duration > 0 && duration < 300) return 'REMAKE';
    return participant.win ? 'WIN' : 'LOSS';
}

function getResultIcon(result: QueueResult) {
    switch (result) {
        case 'WIN':
            return '🟢 Win';
        case 'LOSS':
            return '🔴 Loss';
        default:
            return '🟠 Remake';
    }
}

function formatDate(timestamp: number) {
    return new Date(timestamp).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
    });
}

async function fetchRecentMatches(puuid: string): Promise<ParsedMatch[]> {
    const since = Date.now() - ONE_WEEK_IN_MS;

    // Deliberately unfiltered: the recent-matches list shows every queue,
    // including Arena. Only the W/L summary narrows - see summarizePeriod.
    const query = `
        SELECT "matchId", "gameCreation", "gameDuration", "queueId", "gameMode",
               "participants"
        FROM match_details
        WHERE "entryPlayerPuuid" = $1
          AND "gameCreation" >= $2
        ORDER BY "gameCreation" DESC
    `;
    const params = [puuid, since];
    const result = await db.query(query, params);

    return result.rows
        .map((row: RawMatchRow) => {
            const parsed = parseParticipants(row.participants);
            const participant = parsed.find(
                (p: RiotParticipant) => p.puuid === puuid
            );
            if (!participant) return null;
            return {
                id: row.matchId,
                createdAt: toNumber(row.gameCreation),
                queueId: toNumber(row.queueId),
                gameMode: row.gameMode ?? null,
                duration: toNumber(row.gameDuration),
                participant,
            } satisfies ParsedMatch;
        })
        .filter((match: ParsedMatch | null): match is ParsedMatch =>
            Boolean(match)
        );
}

function summarizePeriod(
    matches: ParsedMatch[],
    scope: CompetitiveScope
): YearlyStats {
    // The list above shows every queue; the W/L record only counts competitive
    // ones, so Arena is visible but never inflates the record.
    return matches
        .filter((match) => countsForCompetition(match, scope))
        .reduce<YearlyStats>(
            (acc, match) => {
                const result = getResult(match.participant, match.duration);
                if (result === 'WIN') acc.wins += 1;
                else if (result === 'LOSS') acc.losses += 1;
                else acc.remakes += 1;
                return acc;
            },
            { wins: 0, losses: 0, remakes: 0 }
        );
}

function buildRecentMatches(matches: ParsedMatch[]) {
    const recent = matches.slice(0, 3);
    if (recent.length === 0) {
        return 'No recorded matches in the last 7 days.';
    }

    return recent
        .map((match) => {
            const { participant } = match;
            const result = getResult(participant, match.duration);
            const queueName = getQueueNameById(match.queueId);
            const kda = `${participant.kills ?? 0}/${participant.deaths ?? 0}/${participant.assists ?? 0}`;
            const champion = participant.championName ?? 'Unknown';
            return `• ${formatDate(match.createdAt)} · ${queueName} · ${getResultIcon(result)} · ${champion} ${kda}`;
        })
        .join('\n');
}

function formatWinRate(stats: YearlyStats) {
    const winRate = calculateWinRatePercentage(stats.wins, stats.losses);
    return winRate !== null ? winRate.toFixed(1) : 'N/A';
}

const numberFormatter = new Intl.NumberFormat('en-US');

function formatIotwStats(stats?: InterCandidate) {
    if (!stats) {
        return 'No IOTW stats recorded in the last 7 days.';
    }

    const averageDamage = numberFormatter.format(Math.round(stats.avgDamage));
    const kda = Number.isFinite(stats.kdaRatio)
        ? stats.kdaRatio.toFixed(2)
        : '0.00';
    const winRate = (stats.winRate * 100).toFixed(1);
    const vision = stats.avgVisionScore.toFixed(1);

    return [
        `Average Damage: ${averageDamage}`,
        `KDA Ratio: ${kda}`,
        `Win Rate: ${winRate}%`,
        `Matches Played: ${stats.matchesPlayed}`,
        `Avg Vision Score: ${vision}`,
    ].join('\n');
}

async function findSummonersByNameAndRegion(gameName: string, region: string) {
    const query = `
        SELECT *
        FROM summoners
        WHERE "gameName" = $1
          AND "matchRegionPrefix" = $2
        ORDER BY "tagLine" ASC
    `;
    const params = [gameName, region];
    const result = await db.query(query, params);
    return result.rows;
}

async function resolveSummonerRecord(
    gameName: string,
    tag: string | null,
    region: string
) {
    if (tag) {
        return {
            type: 'single' as const,
            record: await getSummonerByAccountName(gameName, tag, region),
        };
    }

    const matches = await findSummonersByNameAndRegion(gameName, region);

    if (matches.length === 0) {
        return { type: 'none' as const };
    }

    if (matches.length === 1) {
        return { type: 'single' as const, record: matches[0] };
    }

    return { type: 'multiple' as const, records: matches };
}

export const summonerInfoCommand: SlashCommand = {
    data: (() => {
        const builder = new SlashCommandBuilder()
            .setName('summoner')
            .setDescription(
                'Displays a detailed profile for a tracked summoner.'
            )
            .addStringOption((option: SlashCommandStringOption) =>
                option
                    .setName('name')
                    .setDescription('Summoner game name (no tag).')
                    .setRequired(true)
                    .setAutocomplete(true)
            )
            .addStringOption((option: SlashCommandStringOption) =>
                option
                    .setName('tag')
                    .setDescription('Summoner tagline (e.g. EUW).')
                    .setRequired(false)
                    .setAutocomplete(true)
            )
            .addStringOption((option: SlashCommandStringOption) => {
                option
                    .setName('region')
                    .setDescription('Riot platform region.')
                    .setRequired(false);
                for (const choice of regionChoices) {
                    option.addChoices({
                        name: choice.label,
                        value: choice.value,
                    });
                }
                return option;
            });

        return builder;
    })(),
    execute: async (interaction) => {
        const name = interaction.options.getString('name', true);
        const tag = interaction.options.getString('tag');
        const region =
            interaction.options.getString('region') ||
            Constants.Regions.EU_WEST;

        await interaction.deferReply();

        try {
            const resolution = await resolveSummonerRecord(name, tag, region);

            if (resolution.type === 'multiple') {
                const choices = resolution.records
                    .map(
                        (row: any, index: number) =>
                            `${index + 1}. ${row.gameName}#${row.tagLine}`
                    )
                    .join('\n');
                await interaction.editReply(
                    `Multiple tracked summoners found for **${name}** in ${region}. Please rerun the command with a tag.\n${choices}`
                );
                return;
            }

            if (resolution.type === 'none') {
                await interaction.editReply(
                    `Could not find **${name}** in region ${region}.`
                );
                return;
            }

            const summonerRecord = resolution.record;

            if (!summonerRecord) {
                const missingTarget = tag ? `${name}#${tag}` : name;
                await interaction.editReply(
                    `Could not find **${missingTarget}** in region ${region}.`
                );
                return;
            }

            const { puuid, gameName, tagLine, tier, rank, lp, deepLolLink } =
                summonerRecord as any;

            // No guildId here on purpose: passing one would activate the
            // guild_summoners join and restrict /summoner to tracked players.
            const scope = await getGuildCompetitiveScope(interaction.guildId);
            const [matches, iotwCandidates] = (await Promise.all([
                fetchRecentMatches(puuid),
                getInterCandidatesLastWeek({ targetPuuid: puuid, scope }),
            ])) as [ParsedMatch[], InterCandidate[]];

            const soloRank = await getMostRecentRankByParticipantIdAndQueueType(
                puuid,
                'RANKED_SOLO_5x5'
            );

            const {
                tier: soloTier,
                rank: soloDivision,
                lp: soloLp,
                ...soloRankRest
            } = soloRank ?? {};

            const displaySoloRank = {
                ...soloRankRest,
                tier: soloTier ?? 'UNRANKED',
                rank: soloDivision ?? 'N/A',
                lp: soloLp ?? 0,
            };

            const flexRank = await getMostRecentRankByParticipantIdAndQueueType(
                puuid,
                'RANKED_FLEX_SR'
            );

            const {
                tier: flexTier,
                rank: flexDivision,
                lp: flexLp,
                ...flexRankRest
            } = flexRank ?? {};

            const displayFlexRank = {
                ...flexRankRest,
                tier: flexTier ?? 'UNRANKED',
                rank: flexDivision ?? 'N/A',
                lp: flexLp ?? 0,
            };

            let embedTier = displaySoloRank.tier;
            if (displaySoloRank.tier === 'UNRANKED') {
                embedTier = displayFlexRank.tier;
            }

            // LP trend sparkline from stored rank history (oldest -> newest)
            let lpSparkline = '';
            try {
                const rankHistory = await fetchRankHistory(
                    puuid,
                    undefined,
                    undefined,
                    'RANKED_SOLO_5x5'
                );
                const lpPoints = rankHistory
                    .map((row: { tier: string; rank: string; lp: number }) =>
                        getTotalPoints(row.tier, row.rank, row.lp)
                    )
                    .filter((value: number | null): value is number =>
                        Number.isFinite(value as number)
                    )
                    .reverse();
                if (lpPoints.length >= 2) {
                    lpSparkline = buildSparkline(lpPoints);
                }
            } catch (sparklineError) {
                console.error('Failed to build LP sparkline:', sparklineError);
            }

            const stats = summarizePeriod(matches, scope);
            const weeklyWinRate = formatWinRate(stats);
            const recentMatches = buildRecentMatches(matches);
            const iotwStats = iotwCandidates.find(
                (candidate: InterCandidate) => candidate.puuid === puuid
            );
            const iotwStatsValue = formatIotwStats(iotwStats);

            const levelSource = matches[0]?.participant.summonerLevel;

            const embedColor = rankColors.get(embedTier) || 0x3498db;
            const emblem = getRankedEmblem(embedTier);

            const embed = new EmbedBuilder()
                .setTitle(`Summoner Info - ${gameName}#${tagLine}`)
                .setDescription(
                    deepLolLink
                        ? `[View on DeepLOL](${deepLolLink})`
                        : 'Tracked summoner overview.'
                )
                .setColor(embedColor)
                .addFields(
                    {
                        name: 'Profile',
                        value: `• Region: **${region}**\n• Account Level: **${levelSource ?? '0'}**`,
                        inline: false,
                    },
                    {
                        name: 'Ranked Solo/Duo',
                        value: `• ${displaySoloRank.tier} ${displaySoloRank.rank} (${displaySoloRank.lp} LP)`,
                        inline: false,
                    },
                    {
                        name: 'Ranked Flex',
                        value: `• ${displayFlexRank.tier} ${displayFlexRank.rank} (${displayFlexRank.lp} LP)`,
                        inline: false,
                    },
                    ...(lpSparkline
                        ? [
                              {
                                  name: 'LP Trend (Solo/Duo)',
                                  value: `\`${lpSparkline}\``,
                                  inline: false,
                              },
                          ]
                        : []),
                    {
                        name: 'Performance (Last 7 Days)',
                        value: `• Record: ${stats.wins}W - ${stats.losses}L${stats.remakes ? ` (${stats.remakes} remakes)` : ''}\n• Win Rate: ${
                            weeklyWinRate === 'N/A'
                                ? 'N/A'
                                : `${weeklyWinRate}%`
                        }`,
                        inline: false,
                    },
                    {
                        name: 'Recent Matches',
                        value: recentMatches,
                        inline: false,
                    },
                    {
                        name: 'IOTW 7 Day Stats',
                        value: iotwStatsValue,
                        inline: false,
                    }
                )
                .setTimestamp();

            if (emblem) {
                embed.setThumbnail(emblem);
            }

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Failed to build summoner info response:', error);
            await interaction.editReply(
                'Something went wrong while fetching this summoner. Please try again later.'
            );
        }
    },
    autocomplete: async (interaction) => {
        try {
            const focused = interaction.options.getFocused(true);
            const focusedValue =
                typeof focused.value === 'string' ? focused.value : '';

            if (focused.name === 'name') {
                const names = (await searchSummonerGameNames(
                    focusedValue,
                    25,
                    interaction.guildId ?? undefined
                )) as string[];
                await interaction.respond(
                    names.map((gameName: string) => ({
                        name: gameName,
                        value: gameName,
                    }))
                );
                return;
            }

            if (focused.name === 'tag') {
                const selectedName = interaction.options.getString('name');
                const tags = (await searchSummonerTags(
                    selectedName,
                    focusedValue,
                    25,
                    interaction.guildId ?? undefined
                )) as Array<{
                    tagLine: string;
                    matchRegionPrefix?: string | null;
                }>;
                await interaction.respond(
                    tags.map(
                        ({
                            tagLine,
                            matchRegionPrefix,
                        }: {
                            tagLine: string;
                            matchRegionPrefix?: string | null;
                        }) => ({
                            name: matchRegionPrefix
                                ? `${tagLine} (${matchRegionPrefix})`
                                : tagLine,
                            value: tagLine,
                        })
                    )
                );
                return;
            }

            await interaction.respond([]);
        } catch (error) {
            console.error(
                'Failed to provide autocomplete suggestions for summoner command:',
                error
            );
            try {
                if (!interaction.responded) {
                    await interaction.respond([]);
                }
            } catch (respondError) {
                console.error(
                    'Failed to send fallback autocomplete response for summoner command:',
                    respondError
                );
            }
        }
    },
};

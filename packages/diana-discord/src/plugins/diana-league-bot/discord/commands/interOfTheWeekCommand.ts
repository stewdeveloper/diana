import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';
import {
    getInterCandidatesLastWeek,
    getGuildCompetitiveScope,
    backfillMissingScores,
    ONE_WEEK_IN_MS,
    type InterCandidate,
} from 'diana-core';

const numberFormatter = new Intl.NumberFormat('en-US');

function formatNumber(value: number, fractionDigits = 0) {
    if (!Number.isFinite(value)) return '0';
    if (fractionDigits <= 0) {
        return numberFormatter.format(Math.round(value));
    }
    return value.toFixed(fractionDigits);
}

function linkedName(candidate: InterCandidate): string {
    return candidate.deepLolLink
        ? `[${candidate.displayName}](${candidate.deepLolLink})`
        : candidate.displayName;
}

function buildFunStats(candidates: InterCandidate[]): string {
    if (candidates.length === 0) return '';

    const byAsc = (key: keyof InterCandidate) =>
        [...candidates].sort(
            (a, b) => ((a[key] as number) ?? 0) - ((b[key] as number) ?? 0)
        )[0];

    const byDesc = (key: keyof InterCandidate) =>
        [...candidates].sort(
            (a, b) => ((b[key] as number) ?? 0) - ((a[key] as number) ?? 0)
        )[0];

    const eligible = (minMatches: number) =>
        candidates.filter((c) => c.matchesPlayed >= minMatches);

    const leastDamage = byAsc('avgDamage');
    const worstKda = byAsc('kdaRatio');
    const worstVision = byAsc('avgVisionScore');
    const mostGames = byDesc('matchesPlayed');

    const winRateCandidates = eligible(3);
    const lowestWinRate =
        winRateCandidates.length > 0
            ? [...winRateCandidates].sort((a, b) => a.winRate - b.winRate)[0]
            : null;

    const lines: string[] = [];

    lines.push(
        `💥 **Least damage** - ${linkedName(leastDamage)} (${formatNumber(leastDamage.avgDamage)} dmg/game)`
    );
    lines.push(
        `⚰️ **Worst KDA** - ${linkedName(worstKda)} (${Number.isFinite(worstKda.kdaRatio) ? worstKda.kdaRatio.toFixed(2) : '0.00'} - ${worstKda.totalKills}/${worstKda.totalDeaths}/${worstKda.totalAssists})`
    );
    lines.push(
        `👁️‍🗨️ **Worst vision** - ${linkedName(worstVision)} (avg ${formatNumber(worstVision.avgVisionScore, 1)})`
    );
    lines.push(
        `🕒 **Most games** - ${linkedName(mostGames)} (${mostGames.matchesPlayed} game${mostGames.matchesPlayed === 1 ? '' : 's'})`
    );
    if (lowestWinRate) {
        const winPct = (lowestWinRate.winRate * 100).toFixed(1);
        lines.push(
            `📉 **Lowest winrate** - ${linkedName(lowestWinRate)} (${winPct}% - ${lowestWinRate.wins}W/${lowestWinRate.losses}L)`
        );
    }

    return lines.join('\n');
}

function buildLeaderboard(candidates: InterCandidate[]): string {
    const scored = [...candidates]
        .filter((c) => c.scoredMatchesCount > 0)
        .sort((a, b) => a.avgAiScore - b.avgAiScore);

    if (scored.length === 0) return '';

    const [winner, ...rest] = scored;
    const lines: string[] = [];

    lines.push(
        `1. **${linkedName(winner)}** - ${Math.round(winner.avgAiScore)} (${winner.scoredMatchesCount} game${winner.scoredMatchesCount === 1 ? '' : 's'})`
    );

    rest.slice(0, 5).forEach((c, i) => {
        lines.push(
            `${i + 2}. ${linkedName(c)} - ${Math.round(c.avgAiScore)} (${c.scoredMatchesCount} game${c.scoredMatchesCount === 1 ? '' : 's'})`
        );
    });

    return lines.join('\n');
}

function buildEmbed(candidates: InterCandidate[]): EmbedBuilder {
    const scoredCandidates = candidates.filter((c) => c.scoredMatchesCount > 0);

    let description: string;
    let crowned: InterCandidate | null = null;

    if (scoredCandidates.length > 0) {
        crowned = [...scoredCandidates].sort(
            (a, b) => a.avgAiScore - b.avgAiScore
        )[0];
        const name = linkedName(crowned);
        const score = crowned.avgAiScore;
        description = `**${name}** 👑\nInter of the Week with an average AI score of **${score}** across ${crowned.scoredMatchesCount} game${crowned.scoredMatchesCount === 1 ? '' : 's'}.`;
    } else {
        description =
            'No scored matches found this week. Nobody can be crowned yet!';
    }

    const embed = new EmbedBuilder()
        .setTitle('Inter Of the Week')
        .setDescription(description)
        .setColor(0xe74c3c)
        .setFooter({ text: 'Last week of matches' })
        .setTimestamp();

    const leaderboard = buildLeaderboard(candidates);
    if (leaderboard) {
        embed.addFields({
            name: 'Leaderboard',
            value: leaderboard,
        });
    }

    const funStats = buildFunStats(candidates);
    if (funStats) {
        embed.addFields({
            name: 'Fun Stats',
            value: funStats,
        });
    }

    return embed;
}

export const interOfTheWeekCommand: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('iotw')
        .setDescription('Crowns the Inter of the Week from the past week.'),
    execute: async (interaction) => {
        await interaction.deferReply();

        try {
            const guildId = interaction.guildId ?? undefined;
            const scope = await getGuildCompetitiveScope(guildId);
            let candidates = await getInterCandidatesLastWeek({
                guildId,
                scope,
            });

            if (candidates.length === 0) {
                await interaction.editReply(
                    'No matches found in the last 7 days. Nobody is inting-yet.'
                );
                return;
            }

            const totalScoredMatches = candidates.reduce(
                (sum, c) => sum + c.scoredMatchesCount,
                0
            );

            if (totalScoredMatches < 5) {
                const backfilled = await backfillMissingScores(
                    Date.now() - ONE_WEEK_IN_MS
                );
                if (backfilled > 0) {
                    candidates = await getInterCandidatesLastWeek({
                        guildId,
                        scope,
                    });
                }
            }

            const embed = buildEmbed(candidates);

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Failed to compute Inter of the Week:', error);
            await interaction.editReply(
                'Something went wrong while picking the Inter of the Week.'
            );
        }
    },
};

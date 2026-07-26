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

    const byDesc = (key: keyof InterCandidate) =>
        [...candidates].sort(
            (a, b) => ((b[key] as number) ?? 0) - ((a[key] as number) ?? 0)
        )[0];

    const eligible = (minMatches: number) =>
        candidates.filter((c) => c.matchesPlayed >= minMatches);

    const mostDamage = byDesc('avgDamage');
    const bestKda = byDesc('kdaRatio');
    const bestVision = byDesc('avgVisionScore');
    const mostGames = byDesc('matchesPlayed');

    const winRateCandidates = eligible(3);
    const highestWinRate =
        winRateCandidates.length > 0
            ? [...winRateCandidates].sort((a, b) => b.winRate - a.winRate)[0]
            : null;

    const lines: string[] = [];

    lines.push(
        `💥 **Most damage** - ${linkedName(mostDamage)} (${formatNumber(mostDamage.avgDamage)} dmg/game)`
    );
    lines.push(
        `⚔️ **Best KDA** - ${linkedName(bestKda)} (${Number.isFinite(bestKda.kdaRatio) ? bestKda.kdaRatio.toFixed(2) : '0.00'} - ${bestKda.totalKills}/${bestKda.totalDeaths}/${bestKda.totalAssists})`
    );
    lines.push(
        `👁️ **Best vision** - ${linkedName(bestVision)} (avg ${formatNumber(bestVision.avgVisionScore, 1)})`
    );
    lines.push(
        `🕒 **Most games** - ${linkedName(mostGames)} (${mostGames.matchesPlayed} game${mostGames.matchesPlayed === 1 ? '' : 's'})`
    );
    if (highestWinRate) {
        const winPct = (highestWinRate.winRate * 100).toFixed(1);
        lines.push(
            `📈 **Highest winrate** - ${linkedName(highestWinRate)} (${winPct}% - ${highestWinRate.wins}W/${highestWinRate.losses}L)`
        );
    }

    return lines.join('\n');
}

function buildLeaderboard(candidates: InterCandidate[]): string {
    const scored = [...candidates]
        .filter((c) => c.scoredMatchesCount > 0)
        .sort((a, b) => b.avgAiScore - a.avgAiScore);

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

    if (scoredCandidates.length > 0) {
        const crowned = [...scoredCandidates].sort(
            (a, b) => b.avgAiScore - a.avgAiScore
        )[0];
        const name = linkedName(crowned);
        const score = crowned.avgAiScore;
        description = `**${name}** 🏆\nMVP of the Week with an average AI score of **${score}** across ${crowned.scoredMatchesCount} game${crowned.scoredMatchesCount === 1 ? '' : 's'}. Bow down.`;
    } else {
        description =
            'No scored matches found this week. Nobody can be crowned yet!';
    }

    const embed = new EmbedBuilder()
        .setTitle('MVP Of the Week')
        .setDescription(description)
        .setColor(0xffd700)
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
            name: 'Honour Roll',
            value: funStats,
        });
    }

    return embed;
}

export const mvpOfTheWeekCommand: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('mvp')
        .setDescription('Crowns the MVP of the Week from the past week.'),
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
                    'No matches found in the last 7 days. No heroics to report.'
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
            console.error('Failed to compute MVP of the Week:', error);
            await interaction.editReply(
                'Something went wrong while picking the MVP of the Week.'
            );
        }
    },
};

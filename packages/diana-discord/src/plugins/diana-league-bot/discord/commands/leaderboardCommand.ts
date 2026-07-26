import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';
import {
    getSummonersForGuild,
    getLatestRanksForPuuids,
    getTotalPoints,
    getInterCandidatesLastWeek,
    getGuildCompetitiveScope,
    type GuildSummonerRow,
    type InterCandidate,
} from 'diana-core';

const numberFormatter = new Intl.NumberFormat('en-US');

const QUEUE_CHOICES = [
    { name: 'Ranked Solo/Duo', value: 'RANKED_SOLO_5x5' },
    { name: 'Ranked Flex', value: 'RANKED_FLEX_SR' },
];

interface StatBoard {
    label: string;
    emoji: string;
    minMatches: number;
    metric: (c: InterCandidate) => number;
    format: (c: InterCandidate) => string;
}

const STAT_BOARDS: Record<string, StatBoard> = {
    aiscore: {
        label: 'Average AI Score',
        emoji: '🤖',
        minMatches: 1,
        metric: (c) => (c.scoredMatchesCount > 0 ? c.avgAiScore : -Infinity),
        format: (c) =>
            `${Math.round(c.avgAiScore)} (${c.scoredMatchesCount} scored game${c.scoredMatchesCount === 1 ? '' : 's'})`,
    },
    kda: {
        label: 'KDA',
        emoji: '⚔️',
        minMatches: 1,
        metric: (c) => c.kdaRatio,
        format: (c) =>
            `${c.kdaRatio.toFixed(2)} (${c.totalKills}/${c.totalDeaths}/${c.totalAssists})`,
    },
    damage: {
        label: 'Average Damage',
        emoji: '💥',
        minMatches: 1,
        metric: (c) => c.avgDamage,
        format: (c) =>
            `${numberFormatter.format(Math.round(c.avgDamage))} dmg/game`,
    },
    vision: {
        label: 'Average Vision Score',
        emoji: '👁️',
        minMatches: 1,
        metric: (c) => c.avgVisionScore,
        format: (c) => `${c.avgVisionScore.toFixed(1)} per game`,
    },
    cs: {
        label: 'CS per Minute',
        emoji: '🌾',
        minMatches: 1,
        metric: (c) => c.avgCsPerMin,
        format: (c) => `${c.avgCsPerMin.toFixed(1)} cs/min`,
    },
    games: {
        label: 'Games Played',
        emoji: '🕒',
        minMatches: 1,
        metric: (c) => c.matchesPlayed,
        format: (c) =>
            `${c.matchesPlayed} game${c.matchesPlayed === 1 ? '' : 's'}`,
    },
    winrate: {
        label: 'Win Rate',
        emoji: '📈',
        minMatches: 3,
        metric: (c) => c.winRate,
        format: (c) =>
            `${(c.winRate * 100).toFixed(1)}% (${c.wins}W/${c.losses}L)`,
    },
};

function linkedName(name: string, deepLolLink?: string | null): string {
    return deepLolLink ? `[${name}](${deepLolLink})` : name;
}

function formatRank(tier: string, rank: string, lp: number): string {
    if (!tier || tier.toUpperCase() === 'UNRANKED') return 'Unranked';
    return `${tier} ${rank} (${lp} LP)`;
}

async function buildLpBoard(
    guildId: string,
    queueType: string
): Promise<EmbedBuilder | string> {
    const members: GuildSummonerRow[] = await getSummonersForGuild(guildId);
    if (members.length === 0) {
        return 'No summoners are tracked in this server yet. Use `/add` to start tracking.';
    }

    const latestRanks = await getLatestRanksForPuuids(
        members.map((m) => m.puuid),
        queueType
    );
    const rankByPuuid = new Map(
        latestRanks.map((row) => [row.entryParticipantId, row])
    );

    const entries = members.map((member) => {
        const rankRow = rankByPuuid.get(member.puuid);
        const points = rankRow
            ? getTotalPoints(rankRow.tier, rankRow.rank, rankRow.lp)
            : null;
        return { member, rankRow, points };
    });

    entries.sort((a, b) => (b.points ?? -1) - (a.points ?? -1));

    const queueLabel =
        QUEUE_CHOICES.find((q) => q.value === queueType)?.name ?? queueType;

    const lines = entries.slice(0, 15).map((entry, index) => {
        const name = linkedName(
            `${entry.member.gameName}#${entry.member.tagLine}`,
            entry.member.deepLolLink
        );
        const rankText = entry.rankRow
            ? formatRank(
                  entry.rankRow.tier,
                  entry.rankRow.rank,
                  entry.rankRow.lp
              )
            : 'Unranked';
        const medal =
            index === 0
                ? '🥇'
                : index === 1
                  ? '🥈'
                  : index === 2
                    ? '🥉'
                    : `${index + 1}.`;
        return `${medal} ${name} - **${rankText}**`;
    });

    return new EmbedBuilder()
        .setTitle(`🏆 ${queueLabel} Ladder`)
        .setDescription(lines.join('\n'))
        .setColor(0xffd700)
        .setFooter({ text: 'Ranks from tracked match history' })
        .setTimestamp();
}

async function buildStatBoard(
    guildId: string,
    boardKey: string
): Promise<EmbedBuilder | string> {
    const board = STAT_BOARDS[boardKey];
    if (!board) return 'Unknown stat board.';

    const scope = await getGuildCompetitiveScope(guildId);
    const candidates = await getInterCandidatesLastWeek({ guildId, scope });
    const eligible = candidates
        .filter((c) => c.matchesPlayed >= board.minMatches)
        .filter((c) => Number.isFinite(board.metric(c)))
        .sort((a, b) => board.metric(b) - board.metric(a));

    if (eligible.length === 0) {
        return 'No matches found in the last 7 days for this board.';
    }

    const lines = eligible.slice(0, 10).map((c, index) => {
        const medal =
            index === 0
                ? '🥇'
                : index === 1
                  ? '🥈'
                  : index === 2
                    ? '🥉'
                    : `${index + 1}.`;
        return `${medal} ${linkedName(c.displayName, c.deepLolLink)} - **${board.format(c)}**`;
    });

    return new EmbedBuilder()
        .setTitle(`${board.emoji} Weekly ${board.label} Board`)
        .setDescription(lines.join('\n'))
        .setColor(0x5865f2)
        .setFooter({ text: 'Last 7 days of matches' })
        .setTimestamp();
}

export const leaderboardCommand: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription("This server's LP ladder and weekly stat boards.")
        .addSubcommand((sub) => {
            sub.setName('lp').setDescription(
                'Rank ladder of tracked summoners in this server.'
            );
            sub.addStringOption((option) => {
                option
                    .setName('queue')
                    .setDescription('Ranked queue (default: Solo/Duo).')
                    .setRequired(false);
                for (const choice of QUEUE_CHOICES) {
                    option.addChoices({
                        name: choice.name,
                        value: choice.value,
                    });
                }
                return option;
            });
            return sub;
        })
        .addSubcommand((sub) => {
            sub.setName('stats').setDescription(
                'Weekly stat boards for tracked summoners in this server.'
            );
            sub.addStringOption((option) => {
                option
                    .setName('board')
                    .setDescription('Which stat to rank by.')
                    .setRequired(true);
                for (const [value, board] of Object.entries(STAT_BOARDS)) {
                    option.addChoices({ name: board.label, value });
                }
                return option;
            });
            return sub;
        }),
    execute: async (interaction) => {
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.reply({
                content: 'This command can only be used in a server.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.deferReply();

        try {
            const subcommand = interaction.options.getSubcommand();
            const result =
                subcommand === 'lp'
                    ? await buildLpBoard(
                          guildId,
                          interaction.options.getString('queue') ||
                              'RANKED_SOLO_5x5'
                      )
                    : await buildStatBoard(
                          guildId,
                          interaction.options.getString('board', true)
                      );

            if (typeof result === 'string') {
                await interaction.editReply(result);
            } else {
                await interaction.editReply({ embeds: [result] });
            }
        } catch (error) {
            console.error('Failed to build leaderboard:', error);
            await interaction.editReply(
                'Something went wrong while building the leaderboard.'
            );
        }
    },
};

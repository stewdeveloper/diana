import {
    EmbedBuilder,
    SlashCommandBuilder,
    MessageFlags,
    type SlashCommandStringOption,
} from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';
import {
    db,
    getDuoRecord,
    getInterCandidatesLastWeek,
    getGuildCompetitiveScope,
    getMostRecentRankByParticipantIdAndQueueType,
    type InterCandidate,
} from 'diana-core';

const numberFormatter = new Intl.NumberFormat('en-US');

interface TrackedSummonerRow {
    puuid: string;
    gameName: string;
    tagLine: string;
    deepLolLink: string | null;
}

function splitNameTag(value: string): { name: string; tag: string | null } {
    const hashIndex = value.lastIndexOf('#');
    if (hashIndex <= 0) return { name: value.trim(), tag: null };
    return {
        name: value.slice(0, hashIndex).trim(),
        tag: value.slice(hashIndex + 1).trim() || null,
    };
}

async function findTrackedSummoner(
    guildId: string,
    input: string
): Promise<TrackedSummonerRow | null> {
    const { name, tag } = splitNameTag(input);
    const conditions = [
        'gs.guild_id = $1',
        's."gameName" = $2',
        "s.game_id = 'league_of_legends'",
    ];
    const params: string[] = [guildId, name];
    if (tag) {
        params.push(tag);
        conditions.push(`s."tagLine" = $${params.length}`);
    }
    const result = await db.query(
        `SELECT s."puuid", s."gameName", s."tagLine", s."deepLolLink"
         FROM summoners s
         JOIN guild_summoners gs ON gs.puuid = s.puuid
         WHERE ${conditions.join(' AND ')}
         ORDER BY s."tagLine" ASC
         LIMIT 1`,
        params
    );
    return result.rows[0] ?? null;
}

async function searchGuildNameTags(
    guildId: string,
    search: string
): Promise<string[]> {
    const trimmed = search.trim();
    const params: Array<string | number> = [guildId];
    let filter = '';
    if (trimmed) {
        params.push(`${trimmed}%`);
        filter = `AND (s."gameName" ILIKE $${params.length})`;
    }
    params.push(25);
    const result = await db.query(
        `SELECT s."gameName", s."tagLine"
         FROM summoners s
         JOIN guild_summoners gs ON gs.puuid = s.puuid
         WHERE gs.guild_id = $1 ${filter}
           AND s.game_id = 'league_of_legends'
         ORDER BY s."gameName" ASC
         LIMIT $${params.length}`,
        params
    );
    return result.rows.map(
        (row: { gameName: string; tagLine: string }) =>
            `${row.gameName}#${row.tagLine}`
    );
}

function formatRankRow(rankRow: {
    tier: string;
    rank: string;
    lp: number;
}): string {
    if (!rankRow.tier || rankRow.tier.toUpperCase() === 'UNRANKED') {
        return 'Unranked';
    }
    return `${rankRow.tier} ${rankRow.rank} (${rankRow.lp} LP)`;
}

function playerFieldValue(
    rankText: string,
    weekly: InterCandidate | undefined
): string {
    const lines = [`🏅 ${rankText}`];
    if (weekly && weekly.matchesPlayed > 0) {
        lines.push(
            `🎮 ${weekly.matchesPlayed} game${weekly.matchesPlayed === 1 ? '' : 's'} (${weekly.wins}W/${weekly.losses}L)`
        );
        lines.push(
            `⚔️ ${weekly.kdaRatio.toFixed(2)} KDA (${weekly.totalKills}/${weekly.totalDeaths}/${weekly.totalAssists})`
        );
        lines.push(
            `💥 ${numberFormatter.format(Math.round(weekly.avgDamage))} dmg/game`
        );
        lines.push(`🌾 ${weekly.avgCsPerMin.toFixed(1)} cs/min`);
        if (weekly.scoredMatchesCount > 0) {
            lines.push(`🤖 ${Math.round(weekly.avgAiScore)} avg AI score`);
        }
    } else {
        lines.push('🎮 No games in the last 7 days');
    }
    return lines.join('\n');
}

export const compareCommand: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('compare')
        .setDescription('Head-to-head comparison of two tracked summoners.')
        .addStringOption((option: SlashCommandStringOption) =>
            option
                .setName('player1')
                .setDescription('First summoner (Name#Tag).')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addStringOption((option: SlashCommandStringOption) =>
            option
                .setName('player2')
                .setDescription('Second summoner (Name#Tag).')
                .setRequired(true)
                .setAutocomplete(true)
        ),
    execute: async (interaction) => {
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.reply({
                content: 'This command can only be used in a server.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const input1 = interaction.options.getString('player1', true);
        const input2 = interaction.options.getString('player2', true);

        await interaction.deferReply();

        try {
            const [playerA, playerB] = await Promise.all([
                findTrackedSummoner(guildId, input1),
                findTrackedSummoner(guildId, input2),
            ]);

            if (!playerA || !playerB) {
                const missing = !playerA ? input1 : input2;
                await interaction.editReply(
                    `Could not find **${missing}** among this server's tracked summoners.`
                );
                return;
            }

            if (playerA.puuid === playerB.puuid) {
                await interaction.editReply(
                    'Pick two different summoners to compare.'
                );
                return;
            }

            const scope = await getGuildCompetitiveScope(guildId);
            const [weeklyA, weeklyB, rankA, rankB, duo] = await Promise.all([
                getInterCandidatesLastWeek({
                    targetPuuid: playerA.puuid,
                    guildId,
                    scope,
                }),
                getInterCandidatesLastWeek({
                    targetPuuid: playerB.puuid,
                    guildId,
                    scope,
                }),
                getMostRecentRankByParticipantIdAndQueueType(
                    playerA.puuid,
                    'RANKED_SOLO_5x5'
                ),
                getMostRecentRankByParticipantIdAndQueueType(
                    playerB.puuid,
                    'RANKED_SOLO_5x5'
                ),
                getDuoRecord(playerA.puuid, playerB.puuid, 0, scope),
            ]);

            const nameA = `${playerA.gameName}#${playerA.tagLine}`;
            const nameB = `${playerB.gameName}#${playerB.tagLine}`;

            const embed = new EmbedBuilder()
                .setTitle(`⚖️ ${nameA} vs ${nameB}`)
                .setDescription('Last 7 days, plus all shared stored matches.')
                .setColor(0x5865f2)
                .addFields(
                    {
                        name: `🟦 ${nameA}`,
                        value: playerFieldValue(
                            formatRankRow(rankA),
                            weeklyA[0]
                        ),
                        inline: true,
                    },
                    {
                        name: `🟥 ${nameB}`,
                        value: playerFieldValue(
                            formatRankRow(rankB),
                            weeklyB[0]
                        ),
                        inline: true,
                    }
                )
                .setTimestamp();

            const duoLines: string[] = [];
            if (duo.gamesTogether > 0) {
                const winPct = (
                    (duo.winsTogether / duo.gamesTogether) *
                    100
                ).toFixed(1);
                duoLines.push(
                    `🤝 **Together**: ${duo.winsTogether}W/${duo.lossesTogether}L (${winPct}% over ${duo.gamesTogether} game${duo.gamesTogether === 1 ? '' : 's'})`
                );
            }
            if (duo.gamesAgainst > 0) {
                duoLines.push(
                    `⚔️ **Head-to-head**: ${nameA} ${duo.winsForAAgainstB} - ${duo.gamesAgainst - duo.winsForAAgainstB} ${nameB}`
                );
            }
            if (duoLines.length === 0) {
                duoLines.push('No shared matches stored yet.');
            }
            embed.addFields({
                name: '👥 Duo Record',
                value: duoLines.join('\n'),
                inline: false,
            });

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Failed to compare summoners:', error);
            await interaction.editReply(
                'Something went wrong while comparing the summoners.'
            );
        }
    },
    autocomplete: async (interaction) => {
        try {
            const guildId = interaction.guildId;
            if (!guildId) {
                await interaction.respond([]);
                return;
            }
            const focused = interaction.options.getFocused(true);
            const focusedValue =
                typeof focused.value === 'string' ? focused.value : '';
            const suggestions = await searchGuildNameTags(
                guildId,
                focusedValue
            );
            await interaction.respond(
                suggestions.map((nameTag) => ({
                    name: nameTag,
                    value: nameTag,
                }))
            );
        } catch (error) {
            console.error(
                'Failed to provide autocomplete suggestions for compare command:',
                error
            );
            try {
                if (!interaction.responded) {
                    await interaction.respond([]);
                }
            } catch {
                // ignore
            }
        }
    },
};

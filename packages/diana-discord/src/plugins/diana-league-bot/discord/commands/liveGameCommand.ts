import {
    EmbedBuilder,
    SlashCommandBuilder,
    MessageFlags,
    type SlashCommandStringOption,
} from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';
import {
    db,
    createLolService,
    buildChampionIdMap,
    getQueueNameById,
    searchSummonerGameNames,
    searchSummonerTags,
    getSquadIdForGuild,
    type LiveGameInfo,
} from 'diana-core';

const lolService = createLolService();

interface TrackedSummonerRow {
    puuid: string;
    gameName: string;
    tagLine: string;
    region: string;
    matchRegionPrefix: string | null;
    deepLolLink: string | null;
}

async function findTrackedSummoners(
    guildId: string,
    gameName: string,
    tag: string | null
): Promise<TrackedSummonerRow[]> {
    const squadId = await getSquadIdForGuild(guildId);
    if (!squadId) return [];

    const conditions = [
        'ss.squad_id = $1',
        's."gameName" = $2',
        "s.game_id = 'league_of_legends'",
    ];
    const params: string[] = [squadId, gameName];
    if (tag) {
        params.push(tag);
        conditions.push(`s."tagLine" = $${params.length}`);
    }
    const result = await db.query(
        `SELECT s."puuid", s."gameName", s."tagLine", s."region",
                s."matchRegionPrefix", s."deepLolLink"
         FROM summoners s
         JOIN squad_summoners ss ON ss.puuid = s.puuid
         WHERE ${conditions.join(' AND ')}
         ORDER BY s."tagLine" ASC`,
        params
    );
    return result.rows;
}

function formatGameLength(game: LiveGameInfo): string {
    const seconds = Math.max(0, Number(game.gameLength ?? 0));
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${Math.floor(seconds % 60)
        .toString()
        .padStart(2, '0')}`;
}

async function buildLiveGameEmbed(
    summoner: TrackedSummonerRow,
    game: LiveGameInfo
): Promise<EmbedBuilder> {
    const idMap = await buildChampionIdMap();
    const championName = (championId: number): string =>
        idMap[String(championId)]?.name ?? `Champion #${championId}`;

    const teamLines = (teamId: number): string =>
        game.participants
            .filter((p) => p.teamId === teamId)
            .map((p) => {
                const champ = championName(p.championId);
                const player = p.riotId || 'Unknown';
                return p.puuid === summoner.puuid
                    ? `**${champ}** - **${player}** ⬅️`
                    : `${champ} - ${player}`;
            })
            .join('\n') || 'Unknown';

    const embed = new EmbedBuilder()
        .setTitle(
            `🔴 Live Game - ${getQueueNameById(game.gameQueueConfigId ?? 0)}`
        )
        .setDescription(
            `**${summoner.gameName}#${summoner.tagLine}** is in a game right now (${formatGameLength(game)} elapsed).`
        )
        .setColor(0xe74c3c)
        .addFields(
            { name: '🔵 Blue Team', value: teamLines(100), inline: true },
            { name: '🔴 Red Team', value: teamLines(200), inline: true }
        )
        .setTimestamp();

    const bans = (game.bannedChampions ?? [])
        .filter((ban) => ban.championId > 0)
        .map((ban) => championName(ban.championId));
    if (bans.length > 0) {
        embed.addFields({
            name: '🚫 Bans',
            value: bans.join(', '),
            inline: false,
        });
    }

    if (summoner.deepLolLink) {
        embed.setURL(summoner.deepLolLink);
    }

    return embed;
}

export const liveGameCommand: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('livegame')
        .setDescription(
            'Check whether a tracked summoner is in a game right now.'
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

        const name = interaction.options.getString('name', true);
        const tag = interaction.options.getString('tag');

        await interaction.deferReply();

        try {
            const matches = await findTrackedSummoners(guildId, name, tag);

            if (matches.length === 0) {
                await interaction.editReply(
                    `Could not find **${tag ? `${name}#${tag}` : name}** among this server's tracked summoners.`
                );
                return;
            }

            if (matches.length > 1) {
                const choices = matches
                    .map(
                        (row, index) =>
                            `${index + 1}. ${row.gameName}#${row.tagLine}`
                    )
                    .join('\n');
                await interaction.editReply(
                    `Multiple tracked summoners found for **${name}**. Please rerun the command with a tag.\n${choices}`
                );
                return;
            }

            const summoner = matches[0];
            const region = summoner.matchRegionPrefix || summoner.region;
            const game = await lolService.getActiveGame(summoner.puuid, region);

            if (!game) {
                await interaction.editReply(
                    `**${summoner.gameName}#${summoner.tagLine}** is not currently in a game.`
                );
                return;
            }

            const embed = await buildLiveGameEmbed(summoner, game);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Failed to look up live game:', error);
            await interaction.editReply(
                'Something went wrong while looking up the live game.'
            );
        }
    },
    autocomplete: async (interaction) => {
        try {
            const focused = interaction.options.getFocused(true);
            const focusedValue =
                typeof focused.value === 'string' ? focused.value : '';
            const guildId = interaction.guildId ?? undefined;

            if (focused.name === 'name') {
                const names = (await searchSummonerGameNames(
                    focusedValue,
                    25,
                    guildId
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
                    guildId
                )) as Array<{
                    tagLine: string;
                    matchRegionPrefix?: string | null;
                }>;
                await interaction.respond(
                    tags.map(({ tagLine, matchRegionPrefix }) => ({
                        name: matchRegionPrefix
                            ? `${tagLine} (${matchRegionPrefix})`
                            : tagLine,
                        value: tagLine,
                    }))
                );
                return;
            }

            await interaction.respond([]);
        } catch (error) {
            console.error(
                'Failed to provide autocomplete suggestions for livegame command:',
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

import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';
import {
    createR6Service,
    buildR6PlayerEmbed,
    searchR6PlayerNames,
    R6_PLATFORMS,
} from 'diana-core';

const r6Service = createR6Service();
const platformChoices = R6_PLATFORMS.map((p) => ({ name: p, value: p }));

export const r6PlayerInfoCommand: SlashCommand = {
    botKey: 'ash',
    data: (() => {
        const builder = new SlashCommandBuilder()
            .setName('r6-player')
            .setDescription(
                "Look up a Rainbow Six Siege player's rank and stats."
            )
            .addStringOption((opt) =>
                opt
                    .setName('name')
                    .setDescription("Player's Ubisoft name.")
                    .setRequired(true)
                    .setAutocomplete(true)
            )
            .addStringOption((opt) => {
                opt.setName('platform')
                    .setDescription('Platform (default: uplay).')
                    .setRequired(false);
                for (const c of platformChoices) {
                    opt.addChoices({ name: c.name, value: c.value });
                }
                return opt;
            });
        return builder;
    })(),

    autocomplete: async (interaction) => {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'name') return;
        try {
            const names = await searchR6PlayerNames(
                focused.value,
                25,
                interaction.guildId ?? undefined
            );
            await interaction.respond(
                names.map((n) => ({ name: n, value: n }))
            );
        } catch {
            await interaction.respond([]);
        }
    },

    execute: async (interaction) => {
        const name = interaction.options.getString('name', true).trim();
        const platform = (
            interaction.options.getString('platform') ?? 'uplay'
        ).toLowerCase();

        await interaction.deferReply();

        try {
            const profile = await r6Service.getProfileByName(name, platform);
            const view = buildR6PlayerEmbed(profile);

            const embed = new EmbedBuilder()
                .setTitle(view.playerName)
                .setColor(view.colorHex)
                .addFields(
                    {
                        name: '🏆 **Rank**',
                        value: `**${view.rankDisplay}**`,
                        inline: true,
                    },
                    {
                        name: '🖥️ **Platform**',
                        value: `**${view.platform}**`,
                        inline: true,
                    },
                    ...view.topStats.map((s) => ({
                        name: s.name,
                        value: `**${s.value}**`,
                        inline: true,
                    }))
                )
                .setFooter({ text: 'Rainbow Six Siege' })
                .setTimestamp();

            if (view.rankIconUrl) embed.setThumbnail(view.rankIconUrl);

            await interaction.editReply({ embeds: [embed] });
        } catch (err: any) {
            const status = err?.status ?? err?.statusCode;
            if (status === 404) {
                await interaction.editReply(
                    `Could not find player **${name}** on **${platform}**.`
                );
                return;
            }
            // Not ephemeral: the reply was already deferred publicly, and
            // `editReply` cannot change that after the fact.
            console.error('[/r6-player] Error:', err);
            await interaction.editReply(
                'Something went wrong. Please try again later.'
            );
        }
    },
};

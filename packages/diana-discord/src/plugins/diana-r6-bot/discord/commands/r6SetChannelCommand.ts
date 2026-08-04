import {
    SlashCommandBuilder,
    MessageFlags,
    PermissionFlagsBits,
} from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';
import { setGuildChannel } from 'diana-core';

export const r6SetChannelCommand: SlashCommand = {
    botKey: 'ash',
    data: new SlashCommandBuilder()
        .setName('r6-channel')
        .setDescription(
            'Set the channel for Rainbow Six Siege rank change notifications.'
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addChannelOption((opt) =>
            opt
                .setName('channel')
                .setDescription('The channel to post notifications in.')
                .setRequired(true)
        ) as SlashCommandBuilder,

    execute: async (interaction) => {
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.reply({
                content: 'This command can only be used in a server.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const channel = interaction.options.getChannel('channel', true);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            await setGuildChannel(guildId, channel.id);
            await interaction.editReply(
                `Rainbow Six Siege notifications will be posted in <#${channel.id}>.`
            );
        } catch (err) {
            console.error('[/r6-channel] Error:', err);
            await interaction.editReply(
                'Failed to set channel. Please try again.'
            );
        }
    },
};

import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';

export const r6HelpCommand: SlashCommand = {
    botKey: 'ash',
    data: new SlashCommandBuilder()
        .setName('r6-help')
        .setDescription('Show all Rainbow Six Siege bot commands.'),

    execute: async (interaction) => {
        const embed = new EmbedBuilder()
            .setTitle('Ash - Rainbow Six Siege Bot Help')
            .setColor(0x3d9be9)
            .setDescription(
                'Track Rainbow Six Siege players and get rank change notifications.'
            )
            .addFields(
                {
                    name: '/r6-player <name> [platform]',
                    value: "Look up a player's rank and stats.",
                },
                {
                    name: '/r6-add <name> [platform]',
                    value: 'Start tracking a player in this server.',
                },
                {
                    name: '/r6-remove <name>',
                    value: 'Stop tracking a player in this server.',
                },
                {
                    name: '/r6-channel <#channel>',
                    value: 'Set the channel for rank change notifications.',
                },
                {
                    // Stated rather than left to be discovered: Siege has no
                    // live-session API, so there is deliberately no "who is in
                    // a game right now" command to go looking for.
                    name: 'Live match tracking',
                    value: 'Not available — Ubisoft publishes no live-session API for Siege. Ranks are polled on a schedule instead.',
                }
            )
            .setFooter({ text: 'Rainbow Six Siege' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    },
};

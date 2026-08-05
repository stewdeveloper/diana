import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';
import {
    searchR6PlayerNames,
    getR6PlayerIdByName,
    removeR6PlayerFromGuild,
    deleteR6Player,
    countGuildsTrackingR6Player,
} from 'diana-core';

export const r6RemovePlayerCommand: SlashCommand = {
    botKey: 'ash',
    data: new SlashCommandBuilder()
        .setName('r6-remove')
        .setDescription(
            'Stop tracking a Rainbow Six Siege player in this server.'
        )
        .addStringOption((opt) =>
            opt
                .setName('name')
                .setDescription('Player name to remove.')
                .setRequired(true)
                .setAutocomplete(true)
        ) as SlashCommandBuilder,

    autocomplete: async (interaction) => {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'name') return;
        try {
            const guildId = interaction.guildId ?? undefined;
            const names = await searchR6PlayerNames(focused.value, 25, guildId);
            await interaction.respond(
                names.map((n) => ({ name: n, value: n }))
            );
        } catch {
            await interaction.respond([]);
        }
    },

    execute: async (interaction) => {
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.reply({
                content: 'This command can only be used in a server.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const name = interaction.options.getString('name', true).trim();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const ubisoftId = await getR6PlayerIdByName(name, guildId);
            if (!ubisoftId) {
                await interaction.editReply(
                    `**${name}** is not tracked in this server.`
                );
                return;
            }

            const removed = await removeR6PlayerFromGuild(guildId, ubisoftId);
            if (!removed) {
                await interaction.editReply(
                    `**${name}** is not tracked in this server.`
                );
                return;
            }

            // Nobody left tracking them: drop the player row too, so a stale
            // profile is not polled forever on every tick. Counted straight
            // off guild_r6_players — the "where do I post" query filters out
            // guilds with no channel configured, and deleting on its say-so
            // cascades this row away from servers that still track them.
            const remaining = await countGuildsTrackingR6Player(ubisoftId);
            if (remaining === 0) {
                await deleteR6Player(ubisoftId).catch(() => {});
            }

            await interaction.editReply(
                `Stopped tracking **${name}** in this server.`
            );
        } catch (err) {
            console.error('[/r6-remove] Error:', err);
            await interaction.editReply(
                'Something went wrong. Please try again later.'
            );
        }
    },
};

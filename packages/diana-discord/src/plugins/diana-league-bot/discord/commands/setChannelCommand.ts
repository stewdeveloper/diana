import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    EmbedBuilder,
    MessageFlags,
} from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';
import { commandMention } from '../../../../discord/commandRegistry';
import { setGuildChannel, getSummonersForGuild } from 'diana-core';

/**
 * The quick-start, posted into the channel that was just chosen.
 *
 * Issue #149 asked for this and it never shipped: `/setchannel` acknowledged
 * ephemerally and stopped, so the person who had just done step 1 was given no
 * indication that a step 2 existed. Setting a channel is the only moment we know
 * for certain somebody is mid-setup and looking at Discord, so it is the one
 * moment worth spending a message on.
 *
 * Public rather than ephemeral, and in the chosen channel rather than where the
 * command was run: it doubles as proof the bot can actually post there, which is
 * otherwise not discovered until the first match ends in silence.
 */
export function buildQuickStartEmbed(): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle('Diana is posting here')
        .setDescription(
            `One thing left — add somebody to track.\n\n` +
                `${commandMention('add')} \`name:\` your Riot name \`tag:\` your tag`
        )
        .setColor(0xfaa61a)
        .addFields(
            {
                name: 'Then what?',
                value: 'Nothing. Match results post here on their own, plus a weekly digest and a recap of each night.',
            },
            {
                name: 'Later, if you want',
                value: `${commandMention('config')} to change what posts · ${commandMention('help')} for everything else`,
            }
        );
}

export const setChannelCommand: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('setchannel')
        .setDescription(
            'Set the channel where match notifications will be posted.'
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addChannelOption((option) =>
            option
                .setName('channel')
                .setDescription('The channel to post match notifications in.')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
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

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const channel = interaction.options.getChannel('channel', true);

        await setGuildChannel(guildId, channel.id);

        // Only for a server that has not finished setting up. Moving the channel
        // on a running server is an admin housekeeping task, and posting a
        // quick-start into it would be addressed to nobody.
        let posted = false;
        const tracked = await getSummonersForGuild(guildId).catch(() => []);
        if (tracked.length === 0) {
            try {
                // Fetched from the guild rather than used as the option handed
                // back: the resolved option can be a partial API channel with no
                // `send` on it, and the real one is what proves we can post.
                const target = await interaction.guild?.channels.fetch(
                    channel.id
                );
                if (target?.isTextBased()) {
                    await target.send({ embeds: [buildQuickStartEmbed()] });
                    posted = true;
                }
            } catch (error) {
                // Almost always missing Send Messages in the chosen channel,
                // which is worth saying now rather than discovering it when the
                // first match ends and nothing appears.
                console.error(
                    '[/setchannel] Could not post quick-start:',
                    error
                );
            }
        }

        await interaction.editReply({
            content: posted
                ? `Match results will post in <#${channel.id}>. I have left the next step there.`
                : tracked.length === 0
                  ? `Match results will post in <#${channel.id}> — but I could not post a message there just now, so check I have **Send Messages** in it. Next step: ${commandMention('add')}.`
                  : `Match results will now post in <#${channel.id}>.`,
        });
    },
};

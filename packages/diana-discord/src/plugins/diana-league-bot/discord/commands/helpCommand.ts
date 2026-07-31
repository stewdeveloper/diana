import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';

export const helpCommand: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show all available Diana commands.'),

    execute: async (interaction) => {
        const embed = new EmbedBuilder()
            .setTitle('Diana - Command Reference')
            .setDescription('Here are all available commands:')
            .setColor(0x5865f2)
            .addFields(
                {
                    name: '⚙️ Setup',
                    value: [
                        '`/setchannel #channel` - Set the channel where match notifications are posted. Requires **Manage Channels**.',
                        '`/config live-posting true/false` - Enable or disable live match notifications. Requires **Manage Server**.',
                        '`/config notifications <type> true/false` - Toggle a specific notification type. Requires **Manage Server**.',
                        '`/config view` - View the current bot settings for this server.',
                        '`/privacy hide|show <name> [tag]` - Keep a player off leaderboards, digests and recaps. Requires **Manage Server**.',
                        '`/privacy status` - List who is currently hidden.',
                    ].join('\n'),
                    inline: false,
                },
                {
                    name: '🔗 Your account',
                    value: [
                        '`/link start <name> <tag> [region]` - Prove a Riot account is yours.',
                        '`/link confirm` - Finish linking after changing your profile icon.',
                        '`/link status` - See which accounts are linked to you.',
                        '`/unlink [puuid]` - Unlink a Riot account from your Discord account.',
                        '`/privacy me <true|false>` - Hide or show your own linked accounts.',
                    ].join('\n'),
                    inline: false,
                },
                {
                    name: '👤 Summoner Tracking',
                    value: [
                        '`/add <name> <tag> [region]` - Start tracking a summoner in this server.',
                        '`/remove <name> [tag]` - Stop tracking a summoner in this server.',
                    ].join('\n'),
                    inline: false,
                },
                {
                    name: '📊 Stats',
                    value: [
                        "`/summoner <name> [tag] [region]` - View a tracked summoner's profile and recent stats.",
                        "`/champion <name> [tag] <champion>` - View a summoner's stats on a specific champion.",
                        '`/iotw` - View the Inter of the Week rankings.',
                        '`/mvp` - View the MVP of the Week rankings.',
                        "`/leaderboard lp [queue]` - This server's rank ladder.",
                        '`/livegame <name> [tag]` - Check if a tracked summoner is in a game right now.',
                        '`/compare <player1> <player2>` - Head-to-head and duo stats for two tracked summoners.',
                        '`/leaderboard stats <board>` - Weekly stat boards (KDA, damage, vision...).',
                    ].join('\n'),
                    inline: false,
                },
                {
                    name: '🔧 Other',
                    value: '`/help` - Show this help message.',
                    inline: false,
                }
            )
            .setFooter({ text: 'Diana - League of Legends match tracking bot' })
            .setTimestamp();

        await interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral,
        });
    },
};

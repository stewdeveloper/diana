import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    MessageFlags,
} from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';
import {
    getGuildConfig,
    setGuildLivePosting,
    setGuildNotificationPref,
    getNotificationPref,
    setGuildCompetitiveScope,
    getCompetitiveScopeFromConfig,
    type NotificationPrefKey,
    type CompetitiveScope,
} from 'diana-core';

const COMPETITIVE_SCOPE_CHOICES: Array<{
    name: string;
    value: CompetitiveScope;
}> = [
    { name: 'All queues', value: 'all' },
    { name: 'Ranked only (Solo/Duo + Flex)', value: 'ranked' },
];

const COMPETITIVE_SCOPE_LABELS = new Map<CompetitiveScope, string>(
    COMPETITIVE_SCOPE_CHOICES.map((c) => [c.value, c.name])
);

const NOTIFICATION_TYPES: Array<{ name: string; value: NotificationPrefKey }> =
    [
        { name: 'Match posts', value: 'match_posts' },
        { name: 'Rank change posts', value: 'rank_posts' },
        { name: 'Streak & milestone posts', value: 'streaks' },
        { name: 'Weekly digest', value: 'digest' },
        { name: 'Free champion rotation', value: 'rotation' },
    ];

const NOTIFICATION_TYPE_LABELS = new Map(
    NOTIFICATION_TYPES.map((t) => [t.value, t.name])
);

export const configCommand: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('View or update Diana bot settings for this server.')
        .addSubcommand((sub) =>
            sub
                .setName('live-posting')
                .setDescription('Enable or disable live match notifications.')
                .addBooleanOption((option) =>
                    option
                        .setName('enabled')
                        .setDescription(
                            'True to enable live posting, false to disable.'
                        )
                        .setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('notifications')
                .setDescription(
                    'Enable or disable a specific notification type.'
                )
                .addStringOption((option) => {
                    option
                        .setName('type')
                        .setDescription('The notification type to toggle.')
                        .setRequired(true);
                    for (const choice of NOTIFICATION_TYPES) {
                        option.addChoices({
                            name: choice.name,
                            value: choice.value,
                        });
                    }
                    return option;
                })
                .addBooleanOption((option) =>
                    option
                        .setName('enabled')
                        .setDescription(
                            'True to enable this notification type, false to disable.'
                        )
                        .setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('competitive-scope')
                .setDescription(
                    'Choose which queues count toward MVP, leaderboards and streaks.'
                )
                .addStringOption((option) => {
                    option
                        .setName('scope')
                        .setDescription(
                            'All queues, or ranked only. Arena never counts.'
                        )
                        .setRequired(true);
                    for (const choice of COMPETITIVE_SCOPE_CHOICES) {
                        option.addChoices({
                            name: choice.name,
                            value: choice.value,
                        });
                    }
                    return option;
                })
        )
        .addSubcommand((sub) =>
            sub
                .setName('view')
                .setDescription(
                    'View the current bot configuration for this server.'
                )
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    execute: async (interaction) => {
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.reply({
                content: 'This command can only be used in a server.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (subcommand === 'live-posting') {
            const enabled = interaction.options.getBoolean('enabled', true);
            await setGuildLivePosting(guildId, enabled);
            await interaction.editReply({
                content: `Live match posting is now **${enabled ? 'enabled' : 'disabled'}** for this server.`,
            });
            return;
        }

        if (subcommand === 'notifications') {
            const type = interaction.options.getString(
                'type',
                true
            ) as NotificationPrefKey;
            const enabled = interaction.options.getBoolean('enabled', true);
            await setGuildNotificationPref(guildId, type, enabled);
            const label = NOTIFICATION_TYPE_LABELS.get(type) ?? type;
            await interaction.editReply({
                content: `${label} notifications are now **${enabled ? 'enabled' : 'disabled'}** for this server.`,
            });
            return;
        }

        if (subcommand === 'competitive-scope') {
            const scope = interaction.options.getString(
                'scope',
                true
            ) as CompetitiveScope;
            await setGuildCompetitiveScope(guildId, scope);
            const label = COMPETITIVE_SCOPE_LABELS.get(scope) ?? scope;
            await interaction.editReply({
                content: `Competitive stats now count **${label}**. Arena is always excluded.`,
            });
            return;
        }

        if (subcommand === 'view') {
            const config = await getGuildConfig(guildId);
            const channel = config?.channel_id
                ? `<#${config.channel_id}>`
                : 'Not set - use `/setchannel` to configure.';
            const livePosting = config
                ? config.live_posting
                    ? 'Enabled'
                    : 'Disabled'
                : 'Enabled (default)';

            const prefLines = NOTIFICATION_TYPES.map(({ name, value }) => {
                const effective = getNotificationPref(config, value);
                const explicit = config?.notification_prefs?.[value];
                const suffix =
                    typeof explicit === 'boolean' ? '' : ' (default)';
                return `${name}: **${effective ? 'Enabled' : 'Disabled'}**${suffix}`;
            });

            const competitiveScope = getCompetitiveScopeFromConfig(config);
            const competitiveScopeLabel = `**${
                COMPETITIVE_SCOPE_LABELS.get(competitiveScope) ??
                competitiveScope
            }**`;
            const competitiveScopeSuffix = config?.competitive_scope
                ? ''
                : ' (default)';

            const embed = new EmbedBuilder()
                .setTitle('Diana - Server Configuration')
                .addFields(
                    {
                        name: 'Notification Channel',
                        value: channel,
                        inline: false,
                    },
                    {
                        name: 'Live Match Posting',
                        value: livePosting,
                        inline: false,
                    },
                    {
                        name: 'Notification Types',
                        value: prefLines.join('\n'),
                        inline: false,
                    },
                    {
                        name: 'Competitive Stats Scope',
                        value: `${competitiveScopeLabel}${competitiveScopeSuffix}\nArena is always excluded from competitive stats.`,
                        inline: false,
                    }
                )
                .setColor(0x5865f2)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        }
    },
};

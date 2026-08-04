import { EmbedBuilder, SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';
import {
    createR6Service,
    getR6PlayerById,
    createR6Player,
    addR6PlayerToGuild,
    isR6PlayerInGuild,
    createR6RankHistory,
    formatR6Rank,
    R6_PLATFORMS,
} from 'diana-core';

const r6Service = createR6Service();
const platformChoices = R6_PLATFORMS.map((p) => ({ name: p, value: p }));

const r6RankColors = new Map<string, number>([
    ['Copper', 0x7c4a2d],
    ['Bronze', 0xcd7f32],
    ['Silver', 0xc0c0c0],
    ['Gold', 0xffd700],
    ['Platinum', 0x22c1c3],
    ['Emerald', 0x2ecc71],
    ['Diamond', 0x00bfff],
    ['Champion', 0xe74c3c],
]);

export const r6AddPlayerCommand: SlashCommand = {
    botKey: 'ash',
    data: (() => {
        const builder = new SlashCommandBuilder()
            .setName('r6-add')
            .setDescription(
                'Add a Rainbow Six Siege player to track in this server.'
            )
            .addStringOption((opt) =>
                opt
                    .setName('name')
                    .setDescription("Player's Ubisoft name.")
                    .setRequired(true)
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
        const platform = (
            interaction.options.getString('platform') ?? 'uplay'
        ).toLowerCase();

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const profile = await r6Service.getProfileByName(name, platform);
            const { ubisoftId, gameName, rank } = profile;

            if (await isR6PlayerInGuild(guildId, ubisoftId)) {
                await interaction.editReply(
                    `**${gameName}** (${platform}) is already being tracked in this server.`
                );
                return;
            }

            const existing = await getR6PlayerById(ubisoftId);
            if (!existing) {
                await createR6Player({
                    ubisoftId,
                    gameName,
                    platform,
                    tier: rank.tier,
                    division: rank.division,
                    rp: rank.rp,
                });
                await createR6RankHistory(
                    `INIT_${ubisoftId}`,
                    ubisoftId,
                    rank.tier,
                    rank.division,
                    rank.rp
                ).catch(() => {});
            }

            await addR6PlayerToGuild(guildId, ubisoftId, interaction.user.id);

            const embed = new EmbedBuilder()
                .setTitle(`✅ Now tracking ${gameName}`)
                .setColor(r6RankColors.get(rank.tier) ?? 0x3498db)
                .addFields(
                    {
                        name: '🏆 **Rank**',
                        value: `**${formatR6Rank(rank.tier, rank.division, rank.rp)}**`,
                        inline: true,
                    },
                    {
                        name: '🖥️ **Platform**',
                        value: `**${platform}**`,
                        inline: true,
                    }
                )
                .setFooter({ text: 'Rainbow Six Siege' })
                .setTimestamp();

            if (profile.rankIconUrl) embed.setThumbnail(profile.rankIconUrl);

            await interaction.editReply({ embeds: [embed] });
        } catch (err: any) {
            const status = err?.status ?? err?.statusCode;
            if (status === 404) {
                await interaction.editReply(
                    `Could not find player **${name}** on **${platform}**. Check the spelling and platform — Ubisoft names are case-sensitive.`
                );
            } else {
                console.error('[/r6-add] Error:', err);
                await interaction.editReply(
                    'Something went wrong. Please try again later.'
                );
            }
        }
    },
};

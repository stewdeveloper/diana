import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';
import { resolveIdentity, unlinkAccount } from 'diana-core';

/**
 * `/unlink` - detach a Riot account from your Discord account (DN-3).
 *
 * Only ever acts on accounts already linked to the caller. There is no option
 * to unlink somebody else's: the identity is the thing that says an account is
 * yours, so acting outside it would be acting with no authority at all.
 *
 * Unlinking does not delete anything Diana knows about the Riot account. It
 * stops saying the account is *yours*, which is the whole of what the link
 * asserted. Removing a summoner from tracking is `/remove`; hiding it from
 * leaderboards is `/privacy`.
 */
export const unlinkCommand: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('unlink')
        .setDescription('Unlink a Riot account from your Discord account.')
        .addStringOption((option) =>
            option
                .setName('puuid')
                .setDescription(
                    'Which account, if you have more than one linked.'
                )
                .setRequired(false)
        ),

    execute: async (interaction) => {
        const discordUserId = interaction.user.id;
        const requested =
            interaction.options.getString('puuid')?.trim() ?? null;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const identity = await resolveIdentity(
                'discord_user',
                discordUserId
            );

            if (identity.puuids.length === 0) {
                await interaction.editReply(
                    'You have no linked Riot accounts.'
                );
                return;
            }

            if (!requested && identity.puuids.length > 1) {
                // Never guess which one. Picking the first would silently
                // unlink an account they did not name.
                const list = identity.puuids
                    .map((puuid) => `• \`${puuid}\``)
                    .join('\n');
                await interaction.editReply(
                    `You have more than one linked account. Re-run with the one you mean:\n${list}`
                );
                return;
            }

            const target = requested ?? identity.puuids[0];

            if (!identity.puuids.includes(target)) {
                // Also the answer when the account belongs to somebody else -
                // deliberately the same message, so this cannot be used to
                // discover who has linked what.
                await interaction.editReply(
                    'That Riot account is not linked to you.'
                );
                return;
            }

            await unlinkAccount('riot_puuid', target);
            await interaction.editReply(
                'Unlinked. Diana still tracks that summoner if the server added it — ' +
                    'this only stops it being recorded as yours.'
            );
        } catch (error) {
            console.error('[/unlink] Error:', error);
            await interaction.editReply(
                'Something went wrong while unlinking. Please try again later.'
            );
        }
    },
};

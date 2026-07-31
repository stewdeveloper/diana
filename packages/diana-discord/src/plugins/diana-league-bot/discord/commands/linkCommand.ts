import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { Constants } from 'twisted';
import type { SlashCommand } from '../../../../discord/commandTypes';
import {
    createLinkChallenge,
    createTrustedLink,
    chooseChallengeIcon,
    createLolService,
    getLinkChallenge,
    getGuildAllowsTrustedLinks,
    resolveIdentity,
    verifyLinkChallenge,
} from 'diana-core';

const lolService = createLolService();

/**
 * `/link` - prove a Riot account is yours (DN-3).
 *
 * RSO is not granted, so this is the profile-icon handshake: Diana names an
 * icon, you set it in the client, Diana reads summoner-v4 and confirms. Two
 * Riot calls per link, as costed in roadmap §9.
 *
 * `/link start` and `/link confirm` are two commands rather than one waiting
 * command because the wait is measured in minutes - the player has to alt-tab
 * into a client that is quite possibly mid-game - and a Discord interaction
 * cannot be held open that long.
 */

const REGION_GROUPS: Record<string, string> = {
    [Constants.Regions.EU_WEST]: 'EUROPE',
    [Constants.Regions.EU_EAST]: 'EUROPE',
    [Constants.Regions.TURKEY]: 'EUROPE',
    [Constants.Regions.RUSSIA]: 'EUROPE',
    [Constants.Regions.AMERICA_NORTH]: 'AMERICAS',
    [Constants.Regions.LAT_NORTH]: 'AMERICAS',
    [Constants.Regions.LAT_SOUTH]: 'AMERICAS',
    [Constants.Regions.BRAZIL]: 'AMERICAS',
    [Constants.Regions.KOREA]: 'ASIA',
    [Constants.Regions.JAPAN]: 'ASIA',
    [Constants.Regions.OCEANIA]: 'SEA',
    [Constants.Regions.SINGAPORE]: 'SEA',
};

const regionChoices = Object.keys(REGION_GROUPS)
    .map((value) => ({ name: value.replace(/_/g, ' '), value }))
    .slice(0, 25);

/**
 * Turn a Riot API failure into something the player can act on.
 *
 * summoner-v4 is called out by name on a 403: `docs/access.md` is missing
 * (roadmap §9) so whether the production key grants it is genuinely unverified,
 * and the operator's fix is a key request rather than a retry.
 */
function describeRiotError(error: unknown, stage: 'account' | 'summoner') {
    const status = (error as { status?: number })?.status;
    if (status === 404) {
        return stage === 'account'
            ? 'No Riot account with that name and tag. Check the spelling and the region.'
            : 'Riot has no League profile for that account in this region.';
    }
    if (status === 403) {
        return stage === 'summoner'
            ? 'Diana cannot read League profiles right now — the summoner-v4 endpoint is not available on this API key. Ask whoever runs this bot to check the key.'
            : 'Diana cannot reach the Riot API right now — its key may have expired.';
    }
    if (status === 429) {
        return 'Riot is rate-limiting Diana at the moment. Try again in a minute.';
    }
    return 'Something went wrong talking to Riot. Please try again later.';
}

export const linkCommand: SlashCommand = {
    data: (() => {
        const builder = new SlashCommandBuilder()
            .setName('link')
            .setDescription('Link your Riot account to your Discord account.');

        builder.addSubcommand((sub) => {
            sub.setName('start')
                .setDescription('Begin linking a Riot account.')
                .addStringOption((option) =>
                    option
                        .setName('name')
                        .setDescription('Your Riot game name (no tag).')
                        .setRequired(true)
                )
                .addStringOption((option) =>
                    option
                        .setName('tag')
                        .setDescription('Your Riot tagline (e.g. EUW).')
                        .setRequired(true)
                )
                .addStringOption((option) => {
                    option
                        .setName('region')
                        .setDescription(
                            'Riot platform region (default: EU_WEST).'
                        )
                        .setRequired(false);
                    for (const choice of regionChoices) {
                        option.addChoices({
                            name: choice.name,
                            value: choice.value,
                        });
                    }
                    return option;
                });
            return sub;
        });

        builder.addSubcommand((sub) =>
            sub
                .setName('confirm')
                .setDescription('Confirm the icon change and finish linking.')
        );

        builder.addSubcommand((sub) =>
            sub
                .setName('status')
                .setDescription('Show which accounts are linked to you.')
        );

        return builder;
    })(),

    execute: async (interaction) => {
        const subcommand = interaction.options.getSubcommand();
        const discordUserId = interaction.user.id;

        // Ephemeral throughout. Linking is about one person's account, and the
        // handshake instructions are noise to everybody else in the channel.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            if (subcommand === 'status') {
                const identity = await resolveIdentity(
                    'discord_user',
                    discordUserId
                );
                if (identity.puuids.length === 0) {
                    await interaction.editReply(
                        'You have no linked Riot accounts. Use `/link start` to link one.'
                    );
                    return;
                }

                const verified = new Set(identity.verifiedPuuids);
                const lines = identity.puuids.map(
                    (puuid) =>
                        `• \`${puuid.slice(0, 12)}…\` — ${
                            verified.has(puuid)
                                ? 'verified'
                                : 'trusted (unverified)'
                        }`
                );
                await interaction.editReply(
                    `Linked to your Discord account:\n${lines.join('\n')}`
                );
                return;
            }

            if (subcommand === 'confirm') {
                const challenge = await getLinkChallenge(discordUserId);
                if (!challenge) {
                    await interaction.editReply(
                        'You have no link in progress, or it expired. Start again with `/link start`.'
                    );
                    return;
                }

                let profile;
                try {
                    profile = await lolService.getSummonerByPUUID(
                        challenge.puuid,
                        (challenge.region ?? Constants.Regions.EU_WEST) as any
                    );
                } catch (error) {
                    console.error('[/link confirm] Riot error:', error);
                    await interaction.editReply(
                        describeRiotError(error, 'summoner')
                    );
                    return;
                }

                const outcome = await verifyLinkChallenge(
                    discordUserId,
                    profile.profileIconId
                );

                if (outcome.ok) {
                    await interaction.editReply(
                        `Linked **${challenge.game_name}#${challenge.tag_line}** to your Discord account. ` +
                            'You can change your icon back now.'
                    );
                    return;
                }

                if (outcome.reason === 'icon_mismatch') {
                    // The challenge is left open on purpose: this is nearly
                    // always "not changed yet", and the fix is to wait rather
                    // than to start over.
                    await interaction.editReply(
                        `Your icon is still #${outcome.actual}. Set it to **#${outcome.expected}**, ` +
                            'wait a moment for Riot to catch up, then run `/link confirm` again.'
                    );
                    return;
                }

                if (outcome.reason === 'already_linked') {
                    await interaction.editReply(
                        'That Riot account is already linked to someone else. ' +
                            'If it is yours, ask them to run `/unlink` first.'
                    );
                    return;
                }

                await interaction.editReply(
                    'You have no link in progress, or it expired. Start again with `/link start`.'
                );
                return;
            }

            // start
            const name = interaction.options.getString('name', true).trim();
            const tag = interaction.options.getString('tag', true).trim();
            const region =
                interaction.options.getString('region') ??
                Constants.Regions.EU_WEST;
            const regionGroup = REGION_GROUPS[region] ?? 'EUROPE';

            let account;
            try {
                account = await lolService.getAccountByRiotId(
                    name,
                    tag,
                    regionGroup as any
                );
            } catch (error) {
                console.error('[/link start] Riot error:', error);
                await interaction.editReply(
                    describeRiotError(error, 'account')
                );
                return;
            }

            const alreadyMine = await resolveIdentity(
                'riot_puuid',
                account.puuid
            );
            if (
                alreadyMine.identityId &&
                !alreadyMine.discordUserIds.includes(discordUserId)
            ) {
                await interaction.editReply(
                    `**${account.gameName}#${account.tagLine}** is already linked to someone else. ` +
                        'If it is yours, ask them to run `/unlink` first.'
                );
                return;
            }

            // A server that has said its members trust each other skips the
            // handshake entirely. Default is off - see migration 019.
            if (
                interaction.guildId &&
                (await getGuildAllowsTrustedLinks(interaction.guildId))
            ) {
                const trusted = await createTrustedLink(
                    discordUserId,
                    account.puuid
                );
                if (!trusted.ok) {
                    await interaction.editReply(
                        `**${account.gameName}#${account.tagLine}** is already linked to someone else.`
                    );
                    return;
                }
                await interaction.editReply(
                    `Linked **${account.gameName}#${account.tagLine}** to your Discord account. ` +
                        'This server allows trusted links, so no verification was needed.'
                );
                return;
            }

            // Read the current icon so the challenge cannot name it. Asking for
            // an icon they already have would "verify" a player who changed
            // nothing.
            let currentIcon: number | null = null;
            try {
                const profile = await lolService.getSummonerByPUUID(
                    account.puuid,
                    region as any
                );
                currentIcon = profile.profileIconId;
            } catch (error) {
                console.error('[/link start] Riot error:', error);
                await interaction.editReply(
                    describeRiotError(error, 'summoner')
                );
                return;
            }

            const requiredIcon = chooseChallengeIcon(currentIcon);
            await createLinkChallenge(
                discordUserId,
                {
                    puuid: account.puuid,
                    gameName: account.gameName,
                    tagLine: account.tagLine,
                    region,
                },
                requiredIcon
            );

            await interaction.editReply(
                `To prove **${account.gameName}#${account.tagLine}** is yours:\n` +
                    `1. Open the League client and change your profile icon to **#${requiredIcon}**.\n` +
                    '2. Come back and run `/link confirm`.\n\n' +
                    'You have 10 minutes, and you can change the icon back straight afterwards.'
            );
        } catch (error) {
            console.error('[/link] Error:', error);
            await interaction.editReply(
                'Something went wrong while linking. Please try again later.'
            );
        }
    },
};

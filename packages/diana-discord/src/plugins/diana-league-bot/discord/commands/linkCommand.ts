import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { Constants } from 'twisted';
import type { SlashCommand } from '../../../../discord/commandTypes';
import {
    createLinkChallenge,
    createTrustedLink,
    chooseChallengeIcon,
    createLolService,
    fetchProfileIconUrl,
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
                    // The sweep may have finished it already, which is the whole
                    // point of the sweep - so "no link in progress" would be a
                    // confusing answer to somebody whose link just succeeded
                    // without them.
                    const identity = await resolveIdentity(
                        'discord_user',
                        discordUserId
                    );
                    await interaction.editReply(
                        identity.puuids.length > 0
                            ? 'Already done — I finished that link for you when Riot caught up. `/link status` shows what is linked.'
                            : 'You have no link in progress, or it expired. Start again with `/link start`.'
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
                    //
                    // Shows the picture again for the same reason `/link start`
                    // does - repeating a number they could not find the first
                    // time is not a hint - and names the way out for somebody
                    // who does not own it.
                    const retry = new EmbedBuilder()
                        .setTitle("Riot hasn't caught up yet")
                        .setDescription(
                            'Set your profile icon to the one shown here if you have not already. ' +
                                "If you have, this is Riot's end being slow — nothing is wrong."
                        )
                        .setThumbnail(
                            await fetchProfileIconUrl(outcome.expected)
                        )
                        .setColor(0xfaa61a)
                        .addFields(
                            {
                                // The line that stops somebody sitting there
                                // running this every thirty seconds against a
                                // cache that updates on its own schedule.
                                name: 'You can walk away',
                                value: "I keep checking in the background and I'll DM you the moment it goes through. `/link confirm` just skips the wait if you would rather watch.",
                            },
                            {
                                name: 'Not in your collection?',
                                value: 'Run `/link start` again and you will be asked for a different one.',
                            }
                        )
                        .setFooter({
                            text: `Wanted #${outcome.expected} · Riot still reports #${outcome.actual}`,
                        });

                    await interaction.editReply({ embeds: [retry] });
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

            // The picture, not the number. The client's icon picker is a grid of
            // images and shows an id nowhere, so a message naming "#596" asks
            // for something the player has no way to look up. The id stays as a
            // caption because it is what `/link confirm` reports back.
            const embed = new EmbedBuilder()
                .setTitle('Prove this account is yours')
                .setDescription(
                    `Set your profile icon on **${account.gameName}#${account.tagLine}** ` +
                        'to the one shown here. Then you can close Discord — I will take it from there.'
                )
                .setThumbnail(await fetchProfileIconUrl(requiredIcon))
                .setColor(0x5865f2)
                .addFields(
                    {
                        name: 'Where to find it',
                        value: 'League client → your name, top right → the icon → **Available**. Match the picture; the client never shows icon numbers.',
                    },
                    {
                        // Said up front rather than discovered by running
                        // `/link confirm` into a wall: Riot's cache is slower
                        // than a person, and somebody who does not know that
                        // reads the delay as the feature being broken.
                        name: 'It will not be instant',
                        value: "Riot takes a while to report an icon change — often much longer than you would expect. I keep checking and I'll DM you when it goes through. `/link confirm` skips the wait if you would rather watch.",
                    },
                    {
                        name: "Haven't got it?",
                        value: 'Run `/link start` again for a different icon. These are the starter icons every account has, so one of them will be there.',
                    }
                )
                .setFooter({
                    text: `Icon #${requiredIcon} · you have 24 hours · change it back once it goes through`,
                });

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[/link] Error:', error);
            await interaction.editReply(
                'Something went wrong while linking. Please try again later.'
            );
        }
    },
};

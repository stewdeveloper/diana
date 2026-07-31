import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
} from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';
import {
    getSummonersForGuild,
    getHiddenPuuids,
    getPrivacy,
    resolveIdentity,
    setHidden,
    setHiddenForAll,
    type GuildSummonerRow,
} from 'diana-core';

/**
 * `/privacy` - opt out of rankings (DN-3).
 *
 * Two ways in, and the difference is who is allowed to speak for an account.
 *
 * **`/privacy me`** needs no permission at all. It acts on the accounts linked
 * to the caller's own identity, which is exactly the set they are entitled to
 * decide about, and it covers all of them at once - hiding one of somebody's
 * three accounts while the other two stay on a leaderboard is not what anybody
 * means by opting out.
 *
 * **`/privacy hide|show <name>`** still requires Manage Server. Naming somebody
 * else's account is an administrative act whether or not the caller has linked
 * anything, so it stays where an admin can be held responsible for it. This is
 * also the only route open to a player who has not linked.
 *
 * The command-level permission is the *lower* of the two, so `me` is reachable;
 * the admin subcommands re-check `ManageGuild` at execution time. Discord's
 * `setDefaultMemberPermissions` is per command, not per subcommand, which is
 * why the check is here rather than declared.
 */

interface ResolvedSummoner {
    puuid: string;
    gameName: string;
    tagLine: string;
}

type Resolution =
    | { ok: true; summoner: ResolvedSummoner }
    | { ok: false; message: string };

/**
 * Whether the caller may act on somebody else's account.
 *
 * Defaults to **refusing** when permissions cannot be read at all - in a DM,
 * say, where `memberPermissions` is null. A privacy control that fails open is
 * not a privacy control.
 */
const hasManageGuild = (interaction: ChatInputCommandInteraction): boolean =>
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ===
    true;

/**
 * Find one tracked summoner by name, and optionally tag.
 *
 * Same shape as `/remove`: an ambiguous name is reported with the candidates
 * rather than resolved arbitrarily, because picking one at random would hide the
 * wrong person and give no sign of it.
 */
const resolveSummoner = (
    tracked: GuildSummonerRow[],
    name: string,
    tag: string | null
): Resolution => {
    const matches = tracked.filter((s) => {
        const nameMatch = s.gameName.toLowerCase() === name.toLowerCase();
        if (tag) {
            return nameMatch && s.tagLine.toLowerCase() === tag.toLowerCase();
        }
        return nameMatch;
    });

    if (matches.length === 0) {
        return {
            ok: false,
            message: `No tracked summoner found matching **${name}${
                tag ? `#${tag}` : ''
            }** in this server.`,
        };
    }

    if (matches.length > 1) {
        const list = matches
            .map((s) => `• ${s.gameName}#${s.tagLine}`)
            .join('\n');
        return {
            ok: false,
            message: `Multiple summoners match **${name}**. Please re-run with a tag:\n${list}`,
        };
    }

    return { ok: true, summoner: matches[0] };
};

export const privacyCommand: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('privacy')
        .setDescription(
            'Hide a tracked player from leaderboards, digests and recaps.'
        )
        .addSubcommand((sub) =>
            sub
                .setName('me')
                .setDescription(
                    'Hide or show your own linked accounts. No permission needed.'
                )
                .addBooleanOption((option) =>
                    option
                        .setName('hidden')
                        .setDescription(
                            'True to hide yourself, false to appear again.'
                        )
                        .setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('hide')
                .setDescription(
                    'Remove a player from leaderboards, digests and recaps.'
                )
                .addStringOption((option) =>
                    option
                        .setName('name')
                        .setDescription('Summoner game name.')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
                .addStringOption((option) =>
                    option
                        .setName('tag')
                        .setDescription(
                            'Summoner tagline (required if multiple share a name).'
                        )
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('show')
                .setDescription('Put a player back on leaderboards.')
                .addStringOption((option) =>
                    option
                        .setName('name')
                        .setDescription('Summoner game name.')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
                .addStringOption((option) =>
                    option
                        .setName('tag')
                        .setDescription(
                            'Summoner tagline (required if multiple share a name).'
                        )
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('status')
                .setDescription('List the players currently hidden here.')
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

        const subcommand = interaction.options.getSubcommand();

        // Ephemeral throughout. Announcing "Louis has been hidden from the
        // leaderboard" to the channel would undo most of what the command is
        // for.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // `me` acts only on the caller's own linked accounts, so it needs no
        // permission. Everything else names somebody else's account, which is
        // an administrative act. Checked here because Discord's declared
        // permissions are per command, not per subcommand.
        if (subcommand !== 'me' && !hasManageGuild(interaction)) {
            await interaction.editReply(
                'Only someone with **Manage Server** can change another player’s visibility. ' +
                    'To hide your own linked accounts, use `/privacy me`.'
            );
            return;
        }

        try {
            if (subcommand === 'me') {
                const hidden = interaction.options.getBoolean('hidden', true);
                const identity = await resolveIdentity(
                    'discord_user',
                    interaction.user.id
                );

                if (identity.puuids.length === 0) {
                    await interaction.editReply(
                        'You have no linked Riot accounts, so there is nothing for Diana to hide. ' +
                            'Link one with `/link start`, or ask an admin to run `/privacy hide`.'
                    );
                    return;
                }

                // Every linked account at once. Hiding one of somebody's three
                // while the other two stay on a leaderboard is not opting out.
                await setHiddenForAll(
                    identity.puuids,
                    hidden,
                    interaction.user.id
                );

                const count = identity.puuids.length;
                const accounts = `${count} linked account${count === 1 ? '' : 's'}`;
                await interaction.editReply(
                    hidden
                        ? `Hidden. Your ${accounts} are off leaderboards, digests and recaps. ` +
                              'Your own match posts still go out.'
                        : `Visible again. Your ${accounts} are back on leaderboards, digests and recaps.`
                );
                return;
            }

            const tracked = (await getSummonersForGuild(
                guildId
            )) as GuildSummonerRow[];

            if (subcommand === 'status') {
                if (tracked.length === 0) {
                    await interaction.editReply(
                        'No summoners are tracked in this server yet.'
                    );
                    return;
                }

                const hidden = await getHiddenPuuids(
                    tracked.map((s) => s.puuid)
                );
                if (hidden.size === 0) {
                    await interaction.editReply(
                        'Nobody is hidden here. All tracked players appear on leaderboards, digests and recaps.'
                    );
                    return;
                }

                const list = tracked
                    .filter((s) => hidden.has(s.puuid))
                    .map((s) => `• ${s.gameName}#${s.tagLine}`)
                    .join('\n');
                await interaction.editReply(
                    `Hidden from leaderboards, digests and recaps:\n${list}\n\n` +
                        'They still get their own match posts, and `/summoner` still finds them.'
                );
                return;
            }

            const name = interaction.options.getString('name', true).trim();
            const tag = interaction.options.getString('tag')?.trim() ?? null;

            const resolved = resolveSummoner(tracked, name, tag);
            if (!resolved.ok) {
                await interaction.editReply(resolved.message);
                return;
            }

            const { puuid, gameName, tagLine } = resolved.summoner;
            const hide = subcommand === 'hide';

            // Report a no-op as a no-op. Saying "hidden" to somebody who was
            // already hidden reads as though the command did something, and
            // the next question is always whether it worked the first time.
            const current = await getPrivacy(puuid);
            if ((current?.hidden ?? false) === hide) {
                await interaction.editReply(
                    hide
                        ? `**${gameName}#${tagLine}** is already hidden.`
                        : `**${gameName}#${tagLine}** is already visible.`
                );
                return;
            }

            await setHidden(puuid, hide, interaction.user.id);

            await interaction.editReply(
                hide
                    ? `**${gameName}#${tagLine}** is now hidden from leaderboards, digests and recaps. ` +
                          'Their own match posts still go out, and `/summoner` still finds them.'
                    : `**${gameName}#${tagLine}** is back on leaderboards, digests and recaps.`
            );
        } catch (error) {
            console.error('[/privacy] Error:', error);
            await interaction.editReply(
                'Something went wrong while updating privacy. Please try again later.'
            );
        }
    },

    autocomplete: async (interaction) => {
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.respond([]);
            return;
        }

        try {
            const focused = interaction.options.getFocused(true);
            if (focused.name !== 'name') {
                await interaction.respond([]);
                return;
            }

            const focusedValue = focused.value.toString().toLowerCase();
            const tracked = (await getSummonersForGuild(
                guildId
            )) as GuildSummonerRow[];

            const unique = [...new Set(tracked.map((s) => s.gameName))];
            const filtered = unique
                .filter((n) => n.toLowerCase().startsWith(focusedValue))
                .slice(0, 25);

            await interaction.respond(
                filtered.map((n) => ({ name: n, value: n }))
            );
        } catch (error) {
            console.error('[/privacy autocomplete] Error:', error);
            try {
                if (!interaction.responded) await interaction.respond([]);
            } catch (_) {}
        }
    },
};

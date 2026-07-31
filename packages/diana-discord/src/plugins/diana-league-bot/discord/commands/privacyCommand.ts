import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
} from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';
import {
    getSummonersForGuild,
    getHiddenPuuids,
    getPrivacy,
    setHidden,
    type GuildSummonerRow,
} from 'diana-core';

/**
 * `/privacy` - opt a tracked player out of rankings (DN-3).
 *
 * **Gated on Manage Server, and that is a compromise this command carries until
 * `/link` ships.** Without verified account linking there is nothing that says
 * which Riot account belongs to the person typing, so a self-service form would
 * let anyone hide - or worse, un-hide - anyone else. `squad_summoners.added_by`
 * looks like an answer and is not: it records who *added* a summoner, not who
 * owns it (issue #142).
 *
 * So for now a server admin acts on request, which is how a friend group works
 * anyway. Once identity lands, a linked player can hide their own accounts
 * without asking anybody.
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
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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

        try {
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

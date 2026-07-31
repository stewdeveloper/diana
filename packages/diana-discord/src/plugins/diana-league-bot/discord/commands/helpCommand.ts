import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';
import { commandMention } from '../../../../discord/commandRegistry';
import { getGuildConfig, getSummonersForGuild } from 'diana-core';

/**
 * `/help` - what to do next, then what exists.
 *
 * WHY THIS IS NOT ONE LIST
 *
 * It used to print all 24 commands in a fixed order, with six admin commands
 * above `/add`. A server that had just installed Diana got a reference manual
 * when what it needed was two instructions, and the two it needed were 1st and
 * 13th in a wall of monospace.
 *
 * So the embed asks what state the guild is in first. Until a channel is set and
 * somebody is tracked, `/help` is a setup card and nothing else; after that it
 * is the reference. Same command, and the reference is never in the way of the
 * thing you have to do before any of it works.
 *
 * ORDERED BY HOW OFTEN IT IS USED, NOT BY WHEN
 *
 * The reference leads with the commands people run every day and ends with the
 * ones an admin runs once. The old order was roughly the reverse.
 *
 * Every command is a `commandMention`, so it renders as a chip Discord pre-fills
 * on tap and degrades to `/name` wherever it cannot resolve.
 */

const BRAND_COLOUR = 0x5865f2;
const SETUP_COLOUR = 0xfaa61a;

/** Where a guild is in setup. The only thing the render branches on. */
export type SetupStage = 'no-channel' | 'no-players' | 'ready';

export function resolveSetupStage(
    channelId: string | null | undefined,
    trackedCount: number
): SetupStage {
    if (!channelId) return 'no-channel';
    if (trackedCount === 0) return 'no-players';
    return 'ready';
}

/**
 * Step 1 of 2. Every other command is gated on this, so nothing else is shown -
 * a menu here would be a list of things that will all refuse to run.
 */
function buildChannelStep(): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle('Setup — step 1 of 2')
        .setDescription(
            `Pick where Diana posts match results.\n\n${commandMention('setchannel')} \`#your-channel\``
        )
        .setColor(SETUP_COLOUR)
        .setFooter({ text: 'Two commands and you are done.' });
}

/** Step 2 of 2. A channel with nobody tracked posts nothing, forever. */
function buildPlayerStep(channelId: string): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle('Setup — step 2 of 2')
        .setDescription(
            `Results will post in <#${channelId}>. Now add somebody to track.\n\n` +
                `${commandMention('add')} \`name:\` your Riot name \`tag:\` your tag`
        )
        .setColor(SETUP_COLOUR)
        .addFields({
            name: 'Where do I find my tag?',
            value: 'It is the part after the # on your Riot ID — `Faker#KR1` is name `Faker`, tag `KR1`.',
        })
        .setFooter({ text: 'After this, results post by themselves.' });
}

/**
 * The reference, for a server that is already running.
 *
 * Subcommands are collapsed to one line each. `/config live-posting`,
 * `/config notifications` and `/config view` were three lines of a help embed
 * spent saying "there is a config command", and Discord's own autocomplete
 * lists them the moment you type it.
 */
function buildReference(): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle('Diana')
        .setDescription(
            'Match results post themselves. These are for everything else.'
        )
        .setColor(BRAND_COLOUR)
        .addFields(
            {
                name: '📊 Stats',
                value: [
                    `${commandMention('summoner')} — a player's profile and recent form`,
                    `${commandMention('leaderboard')} — rank ladder, or a weekly stat board`,
                    `${commandMention('wrapped')} — the squad's games, voice hours and highlights`,
                    `${commandMention('compare')} — head-to-head and duo win rates`,
                    `${commandMention('champion')} — one player on one champion`,
                    `${commandMention('livegame')} — is somebody in a game right now`,
                ].join('\n'),
            },
            {
                name: '🏆 Weekly',
                value: [
                    `${commandMention('mvp')} — best average score of the week`,
                    `${commandMention('iotw')} — the other end of that table`,
                ].join('\n'),
            },
            {
                name: '🔗 Your account',
                value: [
                    `${commandMention('link start')} — prove a Riot account is yours`,
                    `${commandMention('unlink')} — undo that`,
                    `${commandMention('privacy me')} — keep yourself off leaderboards`,
                ].join('\n'),
            },
            // The one field that is not for everybody, and the only one an admin
            // needs more than twice. Last on purpose.
            {
                name: '⚙️ Server settings',
                value: [
                    `${commandMention('add')} / ${commandMention('remove')} — who this server tracks`,
                    `${commandMention('setchannel')} — where results post`,
                    `${commandMention('config')} — what posts, and which queues count`,
                    `${commandMention('privacy hide')} — keep a player off leaderboards`,
                ].join('\n'),
            }
        )
        .setFooter({ text: 'Diana • free forever on Discord' });
}

/** Chooses the embed for a guild's state. Pure, so the branching is testable. */
export function buildHelpEmbed(
    stage: SetupStage,
    channelId?: string | null
): EmbedBuilder {
    if (stage === 'no-channel') return buildChannelStep();
    if (stage === 'no-players') return buildPlayerStep(channelId ?? '');
    return buildReference();
}

export const helpCommand: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('What to do next, and every Diana command.'),

    execute: async (interaction) => {
        // Ephemeral, as it always was. Help is for whoever asked: a setup card
        // is an admin talking to themselves, and a 24-command reference posted
        // into a channel is noise for everybody who did not run it.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const guildId = interaction.guildId;
            if (!guildId) {
                // A DM has no setup to be part-way through.
                await interaction.editReply({ embeds: [buildReference()] });
                return;
            }

            const config = await getGuildConfig(guildId);
            // Only asked for when a channel exists, so an unconfigured server
            // costs one query rather than two.
            const tracked = config?.channel_id
                ? await getSummonersForGuild(guildId)
                : [];

            const stage = resolveSetupStage(config?.channel_id, tracked.length);
            await interaction.editReply({
                embeds: [buildHelpEmbed(stage, config?.channel_id)],
            });
        } catch (error) {
            // Help is what somebody runs when something is already wrong, so it
            // falls back to the reference rather than failing.
            console.error('[/help] Failed to read guild state:', error);
            await interaction.editReply({ embeds: [buildReference()] });
        }
    },
};

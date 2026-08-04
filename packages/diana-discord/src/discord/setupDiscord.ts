import 'dotenv/config';
import { MessageFlags } from 'discord.js';
import type { Guild, Interaction, TextChannel, Client } from 'discord.js';
import { BOT_ENV, BOT_KEYS } from './botKeys';
import {
    getAshClient,
    getDianaClient,
    getPathfinderClient,
    loginBot,
} from './client';
import type { BotKey } from './client';
import {
    syncCommandsToDiscord,
    handleSlashCommand,
    handleAutocomplete,
    commandMention,
} from './commandRegistry';

/**
 * The first thing a server ever sees.
 *
 * Built per send rather than held as a constant so the commands render as
 * clickable mentions: ids only exist after the first sync, and a constant
 * evaluated at module load would freeze the plain-text fallback in place
 * forever.
 *
 * Two steps, not three. `/help` was listed as step 3 and is not a step - it is
 * what you run when you are stuck, and telling somebody to read the manual as
 * part of setup is how a two-command setup starts feeling like a chore.
 */
function buildWelcomeMessage(botKey: BotKey): string {
    if (botKey === 'ash') {
        return (
            "Hi! I'm **Ash**, a Rainbow Six Siege tracking bot.\n\n" +
            `**1.** ${commandMention('r6-channel', 'ash')} — pick where results get posted.\n` +
            `**2.** ${commandMention('r6-add', 'ash')} — track your first player.\n\n` +
            `That is it. ${commandMention('r6-help', 'ash')} if you get stuck.`
        );
    }

    if (botKey === 'pathfinder') {
        return (
            "Hi! I'm **Pathfinder**, an Apex Legends tracking bot.\n\n" +
            `**1.** ${commandMention('apex-channel', 'pathfinder')} — pick where results get posted.\n` +
            `**2.** ${commandMention('apex-add', 'pathfinder')} — track your first player.\n\n` +
            `That is it. ${commandMention('apex-help', 'pathfinder')} if you get stuck.`
        );
    }

    return (
        "Hi! I'm **Diana**. I track your group's League games and post the results here.\n\n" +
        `**1.** ${commandMention('setchannel')} — pick where results get posted.\n` +
        `**2.** ${commandMention('add')} — track your first player.\n\n` +
        `That is it — everything after that posts by itself. ${commandMention('help')} if you get stuck.\n\n` +
        'Please upvote on [top.gg](https://top.gg/bot/1327445461107347567) and share Diana if you find her useful! [Support development here](https://buymeacoffee.com/yngstew).'
    );
}

async function sendWelcomeMessage(guild: Guild, botKey: BotKey): Promise<void> {
    try {
        const systemChannel = guild.systemChannel;
        if (systemChannel?.isSendable()) {
            await systemChannel.send(buildWelcomeMessage(botKey));
            return;
        }
        const textChannel = guild.channels.cache
            .filter(
                (c: any): c is TextChannel => c.isTextBased() && 'send' in c
            )
            .sort((a: any, b: any) => a.position - b.position)
            .first();
        if (textChannel?.isSendable()) {
            await textChannel.send(buildWelcomeMessage(botKey));
        }
    } catch (err) {
        console.error(
            `[Diana:${botKey}] Failed to send welcome message to guild ${guild.id}:`,
            err
        );
    }
}

function attachClientListeners(client: Client, botKey: BotKey): void {
    client.on('error', (err) => {
        console.error(`[Diana:${botKey}] Discord client error:`, err);
    });

    client.on('shardError', (err) => {
        console.error(
            `[Diana:${botKey}] Discord gateway connection error:`,
            err
        );
    });

    client.once('ready', async () => {
        console.log(
            `[Diana:${botKey}] Discord client ready as ${client.user?.tag ?? 'unknown'}.`
        );
        try {
            await syncCommandsToDiscord(botKey);
        } catch (err) {
            console.error(
                `[Diana:${botKey}] Failed to register slash commands:`,
                err
            );
        }
    });

    client.on('guildCreate', async (guild: Guild) => {
        console.log(
            `[Diana:${botKey}] Joined new guild: ${guild.name} (${guild.id})`
        );
        await sendWelcomeMessage(guild, botKey);
    });

    client.on('interactionCreate', async (interaction: Interaction) => {
        if (interaction.isAutocomplete()) {
            try {
                await handleAutocomplete(interaction, botKey);
            } catch (err) {
                console.error(`[Diana:${botKey}] Autocomplete error:`, err);
                try {
                    if (!interaction.responded) await interaction.respond([]);
                } catch (_) {}
            }
            return;
        }
        if (!interaction.isChatInputCommand()) return;
        if (Date.now() - interaction.createdTimestamp > 2500) return;
        try {
            await handleSlashCommand(interaction, botKey);
        } catch (err: any) {
            if (err?.code === 10062) return;
            console.error(`[Diana:${botKey}] Slash command error:`, err);
            const msg = 'An unexpected error occurred.';
            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({
                        content: msg,
                        flags: MessageFlags.Ephemeral,
                    });
                } else {
                    await interaction.reply({
                        content: msg,
                        flags: MessageFlags.Ephemeral,
                    });
                }
            } catch (_) {}
        }
    });
}

async function startBot(botKey: BotKey, tokenEnvVar: string): Promise<void> {
    const token = process.env[tokenEnvVar];
    if (!token) {
        console.warn(
            `[Diana:${botKey}] ${tokenEnvVar} not set. Bot will not start.`
        );
        return;
    }
    try {
        await loginBot(botKey, token);
        console.log(`[Diana:${botKey}] Discord login initiated.`);
    } catch (err) {
        console.error(`[Diana:${botKey}] Discord login failed:`, err);
    }
}

export async function setupAndStartDiscord(): Promise<void> {
    attachClientListeners(getDianaClient(), 'diana');
    attachClientListeners(getPathfinderClient(), 'pathfinder');
    attachClientListeners(getAshClient(), 'ash');

    // `startBot` warns and returns when a token is unset, so a deployment
    // that has not been given Ash's credentials keeps running the other two.
    for (const botKey of BOT_KEYS) {
        await startBot(botKey, BOT_ENV[botKey].token);
    }
}

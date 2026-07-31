import {
    REST,
    Routes,
    MessageFlags,
    type ChatInputCommandInteraction,
    type AutocompleteInteraction,
} from 'discord.js';
import type { SlashCommand } from './commandTypes';
import type { BotKey } from './client';
import { getGuildConfig } from 'diana-core';

// Commands that may run even when no notification channel is configured
const CHANNEL_EXEMPT_COMMANDS: Record<BotKey, Set<string>> = {
    diana: new Set(['help', 'setchannel', 'ping']),
    pathfinder: new Set(['apex-help', 'apex-channel']),
};

/**
 * Command ids Discord handed back at registration, keyed by name.
 *
 * A command written as `</add:123>` renders in Discord as a clickable chip that
 * pre-fills the command when tapped, and as plain `/add` text everywhere it
 * cannot resolve. That turns "here are the two commands you need" from
 * instructions into two taps, which is most of what onboarding costs.
 *
 * Populated by `syncCommandsToDiscord`, which already receives these ids and
 * previously threw them away. Empty until the first sync - so every reader goes
 * through `commandMention`, which falls back rather than emitting a broken
 * mention.
 */
const commandIds: Record<BotKey, Map<string, string>> = {
    diana: new Map(),
    pathfinder: new Map(),
};

/**
 * A command as a clickable mention, or as code if its id is unknown.
 *
 * `name` may include subcommands ("link start"): Discord keys the mention on the
 * *parent* id and carries the subcommand in the label, so only the first word is
 * looked up.
 *
 * Unknown names degrade to `/name` rather than throwing. This runs on every
 * help render and in the welcome message, both of which can fire before a sync
 * has happened - a help embed is not worth a crash.
 */
export function commandMention(name: string, botKey: BotKey = 'diana'): string {
    const trimmed = name.trim().replace(/^\//, '');
    const root = trimmed.split(/\s+/)[0];
    const id = commandIds[botKey].get(root);
    return id ? `</${trimmed}:${id}>` : `\`/${trimmed}\``;
}

/** Test seam, and the reset the registry's own `clearAllCommands` implies. */
export function setCommandIds(
    botKey: BotKey,
    entries: Array<{ id: string; name: string }>
): void {
    commandIds[botKey] = new Map(entries.map((c) => [c.name, c.id]));
}

// Per-user cooldown tracking: key = `botKey:userId:commandName`, value = last-used ms
const cooldownMap = new Map<string, number>();
const COOLDOWN_MS = 3000;

const handlers = {
    diana: new Map<string, SlashCommand['execute']>(),
    pathfinder: new Map<string, SlashCommand['execute']>(),
};

const autocompleteHandlers = {
    diana: new Map<string, NonNullable<SlashCommand['autocomplete']>>(),
    pathfinder: new Map<string, NonNullable<SlashCommand['autocomplete']>>(),
};

const definitions: Record<BotKey, SlashCommand[]> = {
    diana: [],
    pathfinder: [],
};

export function registerSlashCommands(
    commands: SlashCommand[],
    defaultBotKey: BotKey = 'diana'
): void {
    for (const cmd of commands) {
        const botKey = cmd.botKey ?? defaultBotKey;
        const name = cmd.data.name;
        if (!name) continue;
        if (handlers[botKey].has(name)) {
            console.warn(
                `[Diana] Duplicate slash command "${name}" for bot "${botKey}", skipping.`
            );
            continue;
        }
        handlers[botKey].set(name, cmd.execute);
        if (cmd.autocomplete) {
            autocompleteHandlers[botKey].set(name, cmd.autocomplete);
        }
        definitions[botKey].push(cmd);
    }
    console.log(
        `[Diana] Registered commands for ${defaultBotKey}: [${[...handlers[defaultBotKey].keys()].join(', ')}]`
    );
}

export function getRegisteredCommands(
    botKey: BotKey = 'diana'
): SlashCommand[] {
    return [...definitions[botKey]];
}

export function clearAllCommands(botKey?: BotKey): void {
    const keys: BotKey[] = botKey ? [botKey] : ['diana', 'pathfinder'];
    for (const k of keys) {
        handlers[k].clear();
        autocompleteHandlers[k].clear();
        definitions[k] = [];
    }
}

export async function syncCommandsToDiscord(botKey: BotKey): Promise<void> {
    const tokenEnv =
        botKey === 'pathfinder'
            ? 'APEX_DISCORD_BOT_TOKEN'
            : 'DISCORD_BOT_TOKEN';
    const clientIdEnv =
        botKey === 'pathfinder'
            ? 'APEX_DISCORD_CLIENT_ID'
            : 'DISCORD_CLIENT_ID';
    const guildIdEnv =
        botKey === 'pathfinder' ? 'APEX_DISCORD_GUILD_ID' : 'DISCORD_GUILD_ID';

    const token = process.env[tokenEnv];
    const clientId = process.env[clientIdEnv];

    if (!token || !clientId) {
        console.warn(
            `[Diana] ${tokenEnv} or ${clientIdEnv} missing. Slash commands for "${botKey}" not registered.`
        );
        return;
    }

    const rest = new REST({ version: '10' }).setToken(token);
    const payload = definitions[botKey].map((c) => c.data.toJSON());
    const guildId = process.env[guildIdEnv];

    // The response is the registered commands, ids and all. Keeping them is what
    // lets every later message link to a command instead of naming one.
    let registered: unknown;
    if (guildId) {
        registered = await rest.put(
            Routes.applicationGuildCommands(clientId, guildId),
            { body: payload }
        );
        console.log(
            `[Diana] Registered ${payload.length} slash command(s) for "${botKey}" in guild ${guildId}.`
        );
    } else {
        registered = await rest.put(Routes.applicationCommands(clientId), {
            body: payload,
        });
        console.log(
            `[Diana] Registered ${payload.length} slash command(s) for "${botKey}" globally.`
        );
    }

    if (Array.isArray(registered)) {
        setCommandIds(
            botKey,
            registered.filter(
                (c): c is { id: string; name: string } =>
                    typeof c?.id === 'string' && typeof c?.name === 'string'
            )
        );
    }
}

export async function handleSlashCommand(
    interaction: ChatInputCommandInteraction,
    botKey: BotKey
): Promise<void> {
    const handler = handlers[botKey].get(interaction.commandName);
    if (!handler) {
        console.warn(
            `[Diana:${botKey}] No handler for command "${interaction.commandName}". Registered: [${[...handlers[botKey].keys()].join(', ')}]`
        );
        await interaction.reply({
            content: 'This command is not available.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const exempt = CHANNEL_EXEMPT_COMMANDS[botKey];
    if (!exempt.has(interaction.commandName) && interaction.guildId) {
        const guildConfig = await getGuildConfig(interaction.guildId);
        if (!guildConfig?.channel_id) {
            // Names both remaining steps, not just the one that is blocking.
            // The old message said "run /setchannel first" and stopped, which
            // left the player at a second dead end the moment they did - the
            // gap issue #149 called "gating dead-ends without an explanation".
            const channelCmd = commandMention(
                botKey === 'pathfinder' ? 'apex-channel' : 'setchannel',
                botKey
            );
            const addCmd = commandMention(
                botKey === 'pathfinder' ? 'apex-add' : 'add',
                botKey
            );
            await interaction.reply({
                content:
                    `Almost there — this server needs two commands before anything else works.\n` +
                    `**1.** ${channelCmd} — pick where results get posted.\n` +
                    `**2.** ${addCmd} — track your first player.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
    }

    const cooldownKey = `${botKey}:${interaction.user.id}:${interaction.commandName}`;
    const lastUsed = cooldownMap.get(cooldownKey) ?? 0;
    const remaining = COOLDOWN_MS - (Date.now() - lastUsed);
    if (remaining > 0) {
        await interaction.reply({
            content: `Please wait ${(remaining / 1000).toFixed(1)}s before using this command again.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    cooldownMap.set(cooldownKey, Date.now());

    await handler(interaction);
}

export async function handleAutocomplete(
    interaction: AutocompleteInteraction,
    botKey: BotKey
): Promise<void> {
    const handler = autocompleteHandlers[botKey].get(interaction.commandName);
    if (!handler) {
        await interaction.respond([]);
        return;
    }
    await handler(interaction);
}

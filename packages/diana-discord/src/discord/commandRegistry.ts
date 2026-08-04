import {
    REST,
    Routes,
    MessageFlags,
    type ChatInputCommandInteraction,
    type AutocompleteInteraction,
} from 'discord.js';
import type { SlashCommand } from './commandTypes';
import { BOT_ENV, BOT_KEYS, type BotKey } from './botKeys';
import { getGuildConfig } from 'diana-core';

// Commands that may run even when no notification channel is configured
const CHANNEL_EXEMPT_COMMANDS: Record<BotKey, Set<string>> = {
    diana: new Set(['help', 'setchannel', 'ping']),
    pathfinder: new Set(['apex-help', 'apex-channel']),
    ash: new Set(['r6-help', 'r6-channel']),
};

/**
 * The two commands a fresh guild has to run, per bot.
 *
 * Was a `botKey === 'pathfinder' ? … : …` pair inline in the gate below; a
 * third bot would have been told to run Diana's `/setchannel`, which its
 * client does not even publish.
 */
const SETUP_COMMANDS: Record<BotKey, { channel: string; add: string }> = {
    diana: { channel: 'setchannel', add: 'add' },
    pathfinder: { channel: 'apex-channel', add: 'apex-add' },
    ash: { channel: 'r6-channel', add: 'r6-add' },
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
    ash: new Map(),
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

const handlers: Record<BotKey, Map<string, SlashCommand['execute']>> = {
    diana: new Map(),
    pathfinder: new Map(),
    ash: new Map(),
};

const autocompleteHandlers: Record<
    BotKey,
    Map<string, NonNullable<SlashCommand['autocomplete']>>
> = {
    diana: new Map(),
    pathfinder: new Map(),
    ash: new Map(),
};

const definitions: Record<BotKey, SlashCommand[]> = {
    diana: [],
    pathfinder: [],
    ash: [],
};

/**
 * Bumped whenever the registered set changes.
 *
 * `commandManifest` memoises against this. Deriving the manifest means calling
 * `toJSON()` on every command, and the Meeps suggest route runs on every
 * keystroke - so recomputing it per call is real work on a hot path, while
 * caching it without an invalidation signal would strand the cache the moment a
 * test re-registers.
 */
let registryVersion = 0;

export function getRegistryVersion(): number {
    return registryVersion;
}

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
        registryVersion += 1;
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
    const keys: BotKey[] = botKey ? [botKey] : [...BOT_KEYS];
    for (const k of keys) {
        handlers[k].clear();
        autocompleteHandlers[k].clear();
        definitions[k] = [];
    }
    registryVersion += 1;
}

export async function syncCommandsToDiscord(botKey: BotKey): Promise<void> {
    const {
        token: tokenEnv,
        clientId: clientIdEnv,
        guildId: guildIdEnv,
    } = BOT_ENV[botKey];

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
            const setup = SETUP_COMMANDS[botKey];
            const channelCmd = commandMention(setup.channel, botKey);
            const addCmd = commandMention(setup.add, botKey);
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

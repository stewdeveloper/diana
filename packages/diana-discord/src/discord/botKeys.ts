/**
 * Bot identity tables, deliberately free of any discord.js import.
 *
 * These used to live in client.ts. They cannot: `commandRegistry` needs them
 * as *values* (not types), and client.ts constructs `new Client()` at module
 * load — so importing them from there pulls a real discord.js client into
 * every module that only wanted to know a bot's name, breaking the suites that
 * stub discord.js partially.
 */

export type BotKey = 'diana' | 'pathfinder' | 'ash';

export const BOT_KEYS: BotKey[] = ['diana', 'pathfinder', 'ash'];

/**
 * Per-bot environment variable names.
 *
 * Introduced with the third bot. Every consumer used to branch on
 * `botKey === 'pathfinder' ? APEX_… : DISCORD_…`, which silently resolves a
 * third key to Diana's credentials rather than failing — so this table is the
 * only place a bot's env names are written down.
 */
export const BOT_ENV: Record<
    BotKey,
    { token: string; clientId: string; guildId: string }
> = {
    diana: {
        token: 'DISCORD_BOT_TOKEN',
        clientId: 'DISCORD_CLIENT_ID',
        guildId: 'DISCORD_GUILD_ID',
    },
    pathfinder: {
        token: 'APEX_DISCORD_BOT_TOKEN',
        clientId: 'APEX_DISCORD_CLIENT_ID',
        guildId: 'APEX_DISCORD_GUILD_ID',
    },
    ash: {
        token: 'R6_DISCORD_BOT_TOKEN',
        clientId: 'R6_DISCORD_CLIENT_ID',
        guildId: 'R6_DISCORD_GUILD_ID',
    },
};

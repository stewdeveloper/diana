import { Client, IntentsBitField } from 'discord.js';

export { BOT_ENV, BOT_KEYS, type BotKey } from './botKeys';
import type { BotKey } from './botKeys';

const intents = [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
];

const dianaClient = new Client({ intents });
const pathfinderClient = new Client({ intents });
const ashClient = new Client({ intents });

export function getDianaClient(): Client {
    return dianaClient;
}

export function getPathfinderClient(): Client {
    return pathfinderClient;
}

export function getAshClient(): Client {
    return ashClient;
}

const clients: Record<BotKey, Client> = {
    diana: dianaClient,
    pathfinder: pathfinderClient,
    ash: ashClient,
};

export function getClientForBot(botKey: BotKey): Client {
    return clients[botKey] ?? dianaClient;
}

export async function loginBot(botKey: BotKey, token: string): Promise<void> {
    await getClientForBot(botKey).login(token);
}

export function isDiscordReady(botKey: BotKey = 'diana'): boolean {
    return getClientForBot(botKey).isReady();
}

/** @deprecated Use getDianaClient() or getPathfinderClient() instead */
export function getDiscordClient(): Client {
    return dianaClient;
}

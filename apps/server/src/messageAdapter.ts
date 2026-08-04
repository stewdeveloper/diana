import type { MessageAdapter, MessagePayload, MessageTarget } from 'diana-core';
import {
    createAshDiscordAdapter,
    createDianaDiscordAdapter,
    createPathfinderDiscordAdapter,
} from './discordAdapter';
import { createMeepsMessageAdapter } from './meepsAdapter';

function fanOut(...adapters: MessageAdapter[]): MessageAdapter {
    return {
        async sendMessage(target: MessageTarget, payload: MessagePayload) {
            for (const adapter of adapters) {
                await adapter.sendMessage(target, payload);
            }
        },
    };
}

/** Message adapter for the League of Legends plugin (Diana bot). */
export function createDianaPluginAdapter(): MessageAdapter {
    return fanOut(createDianaDiscordAdapter(), createMeepsMessageAdapter());
}

/** Message adapter for the Apex Legends plugin (Pathfinder bot). */
export function createPathfinderPluginAdapter(): MessageAdapter {
    return fanOut(
        createPathfinderDiscordAdapter(),
        createMeepsMessageAdapter()
    );
}

/** Message adapter for the Rainbow Six Siege plugin (Ash bot). */
export function createAshPluginAdapter(): MessageAdapter {
    return fanOut(createAshDiscordAdapter(), createMeepsMessageAdapter());
}

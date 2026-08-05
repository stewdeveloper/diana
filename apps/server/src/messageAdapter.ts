import type { MessageAdapter, MessagePayload, MessageTarget } from 'diana-core';
import {
    createAshDiscordAdapter,
    createDianaDiscordAdapter,
    createPathfinderDiscordAdapter,
} from './discordAdapter';

/**
 * MESSAGES GO TO DISCORD ONLY.
 *
 * All three plugins used to fan out to a `createMeepsMessageAdapter()` as well,
 * which POSTed every rank post, match post and session post to Meeps'
 * `/api/diana-notify`. That endpoint does not exist in Meeps — `grep -r
 * diana-notify` over its backend and frontend returns nothing. The adapter
 * `console.warn`ed a non-OK response and swallowed it, so the only symptom was
 * one 404 per post, in Diana's own logs.
 *
 * Meeps is reached by the typed event path instead (`meepsEventAdapter.ts`,
 * DN-1): an event describes what happened, so Meeps draws its own card rather
 * than re-rendering a Discord embed. `MessagePayload` is presentation-shaped and
 * had nothing useful to give it even while the endpoint was alive.
 *
 * `fanOut` stays because it is what makes adding a second *live* destination a
 * one-line change, and because the League plugin is the one most likely to want
 * one.
 */
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
    return fanOut(createDianaDiscordAdapter());
}

/** Message adapter for the Apex Legends plugin (Pathfinder bot). */
export function createPathfinderPluginAdapter(): MessageAdapter {
    return fanOut(createPathfinderDiscordAdapter());
}

/** Message adapter for the Rainbow Six Siege plugin (Ash bot). */
export function createAshPluginAdapter(): MessageAdapter {
    return fanOut(createAshDiscordAdapter());
}

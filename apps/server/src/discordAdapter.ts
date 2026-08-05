import type { MessageAdapter, MessagePayload, MessageTarget } from 'diana-core';
import {
    createDiscordMessageAdapter,
    getAshClient,
    getDianaClient,
    getPathfinderClient,
} from 'diana-discord';

const DISABLE_DISCORD_POSTS = ['1', 'true', 'yes'].includes(
    (process.env.DISABLE_DISCORD_POSTS ?? '').toLowerCase()
);

function wrapWithDisableCheck(inner: MessageAdapter): MessageAdapter {
    return {
        async sendMessage(target: MessageTarget, payload: MessagePayload) {
            if (DISABLE_DISCORD_POSTS) {
                console.log(
                    '[Diana] DISABLE_DISCORD_POSTS enabled; skipping Discord send.'
                );
                return;
            }
            await inner.sendMessage(target, payload);
        },
    };
}

/** Message adapter that sends via the Diana (LoL) bot client. */
export function createDianaDiscordAdapter(): MessageAdapter {
    return wrapWithDisableCheck(createDiscordMessageAdapter(getDianaClient()));
}

/** Message adapter that sends via the Pathfinder (Apex) bot client. */
export function createPathfinderDiscordAdapter(): MessageAdapter {
    return wrapWithDisableCheck(
        createDiscordMessageAdapter(getPathfinderClient())
    );
}

/** Message adapter that sends via the Ash (Rainbow Six Siege) bot client. */
export function createAshDiscordAdapter(): MessageAdapter {
    return wrapWithDisableCheck(createDiscordMessageAdapter(getAshClient()));
}

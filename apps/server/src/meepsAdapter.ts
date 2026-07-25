import type { MessageAdapter, MessagePayload, MessageTarget } from 'diana-core';
import { isEnvFlagEnabled, resolveMeepsUrl } from './meepsUrl';

const MEEPS_WEBHOOK_URL = process.env.MEEPS_WEBHOOK_URL;
const MEEPS_WEBHOOK_SECRET = process.env.MEEPS_WEBHOOK_SECRET;
const DISABLE_MEEPS_POSTS = isEnvFlagEnabled(process.env.DISABLE_MEEPS_POSTS);

let _meepsConfigLogged = false;

/**
 * Serialize MessagePayload for JSON (e.g. Date -> ISO string).
 */
function serializeMessagePayload(
    payload: MessagePayload
): Record<string, unknown> {
    const out: Record<string, unknown> = {
        title: payload.title,
        description: payload.description,
        url: payload.url,
        colorHex: payload.colorHex,
        thumbnailUrl: payload.thumbnailUrl,
        fields: payload.fields,
        footer: payload.footer,
        text: payload.text,
    };
    if (payload.timestamp !== undefined) {
        out.timestamp =
            payload.timestamp instanceof Date
                ? payload.timestamp.toISOString()
                : payload.timestamp;
    }
    return out;
}

export function createMeepsMessageAdapter(): MessageAdapter {
    return {
        async sendMessage(_target: MessageTarget, payload: MessagePayload) {
            if (DISABLE_MEEPS_POSTS) {
                console.log(
                    '[Diana] DISABLE_MEEPS_POSTS enabled; skipping Meeps send.'
                );
                return;
            }

            const parsed = resolveMeepsUrl(
                MEEPS_WEBHOOK_URL,
                '/api/diana-notify'
            );
            if (!parsed) return;

            if (!_meepsConfigLogged) {
                _meepsConfigLogged = true;
                console.log(
                    '[Diana] Meeps webhook endpoint:',
                    parsed.origin + '/api/diana-notify'
                );
            }

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            };
            if (MEEPS_WEBHOOK_SECRET) {
                headers['x-diana-secret'] = MEEPS_WEBHOOK_SECRET;
            }
            try {
                const res = await fetch(parsed.href, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(serializeMessagePayload(payload)),
                });
                if (!res.ok) {
                    console.warn(
                        `[Diana] Meeps webhook returned ${res.status}: ${await res.text()}`
                    );
                }
            } catch (err) {
                console.warn('[Diana] Meeps webhook request failed:', err);
            }
        },
    };
}

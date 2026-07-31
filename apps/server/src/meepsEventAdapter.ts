import type { DianaEvent, EventAdapter } from 'diana-core';
import { isEnvFlagEnabled, resolveMeepsUrl } from './meepsUrl';

const MEEPS_WEBHOOK_URL = process.env.MEEPS_WEBHOOK_URL;
const MEEPS_WEBHOOK_SECRET = process.env.MEEPS_WEBHOOK_SECRET;
const DISABLE_MEEPS_POSTS = isEnvFlagEnabled(process.env.DISABLE_MEEPS_POSTS);

/** Attempts per event, including the first. */
const MAX_ATTEMPTS = 3;
/** Backoff before retry n: 500ms, then 1000ms. */
const BASE_BACKOFF_MS = 500;

let _meepsEventConfigLogged = false;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Should a failed attempt be retried?
 *
 * Retry transient conditions only. A 400 means the event does not match the
 * contract and will be rejected identically forever; retrying it just delays
 * the events behind it and triples the log noise.
 */
function isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
}

/**
 * Emits Diana events to Meeps over HTTP.
 *
 * Delivery is at-least-once: the transport retries, and every event carries a
 * deterministic `eventId` so the receiver can discard duplicates. That is why
 * retrying is safe here where it would not be for a chat message.
 *
 * This adapter never throws. Meeps being down must not stop Diana posting to
 * Discord — the events are recoverable, a missed match post is not.
 *
 * Returns whether Meeps accepted the event. `false` covers every way it did not
 * arrive: disabled, unconfigured, rejected, or still failing after the last
 * attempt. Callers that record having sent something must check it — see the
 * note on `EventAdapter`.
 */
export function createMeepsEventAdapter(): EventAdapter {
    return {
        async emit(event: DianaEvent): Promise<boolean> {
            if (DISABLE_MEEPS_POSTS) return false;

            const parsed = resolveMeepsUrl(
                MEEPS_WEBHOOK_URL,
                '/api/diana-events'
            );
            if (!parsed) return false;

            if (!_meepsEventConfigLogged) {
                _meepsEventConfigLogged = true;
                console.log(
                    '[Diana] Meeps events endpoint:',
                    parsed.origin + '/api/diana-events'
                );
            }

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            };
            if (MEEPS_WEBHOOK_SECRET) {
                headers['x-diana-secret'] = MEEPS_WEBHOOK_SECRET;
            }
            const body = JSON.stringify(event);

            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                try {
                    const res = await fetch(parsed.href, {
                        method: 'POST',
                        headers,
                        body,
                    });

                    if (res.ok) return true;

                    if (!isRetryableStatus(res.status)) {
                        console.warn(
                            `[Diana] Meeps event ${event.eventId} rejected (${res.status}, not retryable): ${await res.text()}`
                        );
                        return false;
                    }

                    if (attempt === MAX_ATTEMPTS) {
                        console.warn(
                            `[Diana] Meeps event ${event.eventId} failed after ${MAX_ATTEMPTS} attempts (last status ${res.status}); dropping.`
                        );
                        return false;
                    }
                } catch (err) {
                    // Network-level failure - always transient enough to retry.
                    if (attempt === MAX_ATTEMPTS) {
                        console.warn(
                            `[Diana] Meeps event ${event.eventId} failed after ${MAX_ATTEMPTS} attempts:`,
                            err
                        );
                        return false;
                    }
                }

                await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
            }

            // Unreachable: the loop returns on every path at MAX_ATTEMPTS.
            return false;
        },
    };
}

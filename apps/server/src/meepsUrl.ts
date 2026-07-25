/**
 * Shared URL handling for the Meeps webhook transports.
 *
 * Extracted from meepsAdapter.ts so the message and event adapters cannot drift
 * apart on how MEEPS_WEBHOOK_URL is interpreted.
 */

/**
 * Resolve `MEEPS_WEBHOOK_URL` + a path into an absolute URL.
 *
 * `fetch` requires a scheme, and the env var is frequently set to a bare host
 * (`meeps.railway.internal`) or a protocol-relative one. Returns null when the
 * variable is unset or cannot be parsed, logging the reason — callers treat
 * null as "not configured, skip silently".
 */
export function resolveMeepsUrl(
    rawBaseUrl: string | undefined,
    path: string
): URL | null {
    if (!rawBaseUrl?.trim()) return null;

    const baseUrl = rawBaseUrl.trim();
    let normalizedBaseUrl: string;
    if (/^https?:\/\//i.test(baseUrl)) {
        normalizedBaseUrl = baseUrl;
    } else if (/^\/\//.test(baseUrl)) {
        // Protocol-relative URL: //host -> https://host
        normalizedBaseUrl = 'https:' + baseUrl;
    } else {
        normalizedBaseUrl = 'https://' + baseUrl;
    }

    const url = normalizedBaseUrl.replace(/\/$/, '') + path;

    try {
        return new URL(url);
    } catch {
        console.error(
            '[Diana] Invalid MEEPS_WEBHOOK_URL:',
            JSON.stringify(rawBaseUrl),
            '→ resolved to:',
            url,
            '(expected e.g. https://meeps.railway.internal)'
        );
        return null;
    }
}

/** True for env values meaning "on": 1, true, yes. */
export function isEnvFlagEnabled(value: string | undefined): boolean {
    return ['1', 'true', 'yes'].includes((value ?? '').toLowerCase());
}

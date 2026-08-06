/**
 * Shared URL handling for the Meeps webhook transports.
 *
 * Originally extracted from the message adapter so it and the event adapter
 * could not drift apart on how MEEPS_WEBHOOK_URL is interpreted. The message
 * adapter has since been deleted — it POSTed to an endpoint Meeps does not
 * serve — so `meepsEventAdapter.ts` is the only caller today. Kept as its own
 * module because MEEPS_WEBHOOK_URL parsing is where the environment-specific
 * reasoning below lives, and that reasoning belongs next to itself rather than
 * inlined into a transport.
 */

/**
 * Which scheme should a bare host default to?
 *
 * Railway's private network carries no TLS - traffic is already encrypted by a
 * Wireguard tunnel, and nothing terminates HTTPS on a `*.railway.internal`
 * name, so an https:// URL there cannot connect at all. Defaulting every bare
 * host to https therefore produced a config that looked right and could never
 * work. Docker Compose service names (`meeps`, `meeps:4000`) have the same
 * property: no dots, no public CA, plain HTTP inside the network.
 *
 * Public hosts keep defaulting to https - downgrading those would be worse than
 * the bug this fixes.
 */
function defaultSchemeFor(host: string): 'http:' | 'https:' {
    const hostname = host
        .replace(/[/?#].*$/, '')
        .split(':')[0]
        .toLowerCase();

    const isInternal =
        hostname.endsWith('.railway.internal') ||
        hostname.endsWith('.internal') ||
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        // A bare label with no dot is a container/service name, not a domain.
        !hostname.includes('.');

    return isInternal ? 'http:' : 'https:';
}

/**
 * Resolve `MEEPS_WEBHOOK_URL` + a path into an absolute URL.
 *
 * `fetch` requires a scheme, and the env var is frequently set to a bare host
 * (`meeps.railway.internal`) or a protocol-relative one. Returns null when the
 * variable is unset or cannot be parsed, logging the reason — callers treat
 * null as "not configured, skip silently".
 *
 * An explicit scheme is never rewritten, including a wrong one: silently
 * "correcting" an operator's URL hides a misconfiguration instead of surfacing
 * it. Only the default for a bare host is inferred, by `isTlsTerminatedHost`.
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
        // Protocol-relative URL: //host -> inferred scheme.
        normalizedBaseUrl = defaultSchemeFor(baseUrl.slice(2)) + baseUrl;
    } else {
        normalizedBaseUrl = defaultSchemeFor(baseUrl) + '//' + baseUrl;
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

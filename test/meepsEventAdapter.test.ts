import type {
    DianaEvent,
    EventAdapter,
} from '../packages/diana-core/src/core/eventTypes';
import { DIANA_EVENT_SCHEMA_VERSION } from '../packages/diana-core/src/core/eventTypes';

/**
 * The event transport's contract:
 *   - retries transient failures (network, 5xx, 429)
 *   - does NOT retry permanent ones (400) - they will never succeed
 *   - NEVER throws, whatever happens; a Meeps outage must not stop Diana
 *     posting matches to Discord
 */

const EVENT: DianaEvent = {
    schemaVersion: DIANA_EVENT_SCHEMA_VERSION,
    eventId: 'match.completed:EUW1_1:puuid-1',
    type: 'match.completed',
    occurredAt: '2026-07-25T12:00:00.000Z',
    matchId: 'EUW1_1',
    puuid: 'puuid-1',
    summonerName: 'TestPlayer',
    queueName: 'Ranked Solo',
    championName: 'Ahri',
    result: 'Win',
    win: true,
    kills: 7,
    deaths: 2,
    assists: 10,
    damage: 42000,
    gameDurationSeconds: 1830,
};

/**
 * The adapter snapshots env vars at module load, so each case needs a fresh
 * module registry with the env already in place.
 */
function loadAdapter(env: Record<string, string | undefined>): EventAdapter {
    let adapter!: EventAdapter;
    jest.isolateModules(() => {
        const previous = { ...process.env };
        Object.assign(process.env, env);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('../apps/server/src/meepsEventAdapter');
        adapter = mod.createMeepsEventAdapter();
        process.env = previous;
    });
    return adapter;
}

function mockFetchSequence(...responses: Array<Response | Error>): jest.Mock {
    const fn = jest.fn();
    for (const r of responses) {
        if (r instanceof Error) fn.mockRejectedValueOnce(r);
        else fn.mockResolvedValueOnce(r);
    }
    return fn;
}

function res(status: number, body = ''): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
    } as Response;
}

const originalFetch = global.fetch;
let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    global.fetch = originalFetch;
    warnSpy.mockRestore();
    logSpy.mockRestore();
    jest.clearAllMocks();
});

const CONFIGURED = {
    MEEPS_WEBHOOK_URL: 'https://meeps.example.test',
    MEEPS_WEBHOOK_SECRET: 'shhh',
    DISABLE_MEEPS_POSTS: undefined,
};

describe('createMeepsEventAdapter', () => {
    it('posts the event to /api/diana-events with the shared secret', async () => {
        const fetchMock = mockFetchSequence(res(200));
        global.fetch = fetchMock as unknown as typeof fetch;

        await loadAdapter(CONFIGURED).emit(EVENT);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://meeps.example.test/api/diana-events');
        expect(init.method).toBe('POST');
        expect(init.headers['x-diana-secret']).toBe('shhh');
        expect(JSON.parse(init.body)).toMatchObject({
            schemaVersion: DIANA_EVENT_SCHEMA_VERSION,
            eventId: EVENT.eventId,
            type: 'match.completed',
        });
    });

    it('does nothing when MEEPS_WEBHOOK_URL is unset', async () => {
        const fetchMock = mockFetchSequence(res(200));
        global.fetch = fetchMock as unknown as typeof fetch;

        await loadAdapter({ MEEPS_WEBHOOK_URL: undefined }).emit(EVENT);

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does nothing when DISABLE_MEEPS_POSTS is set', async () => {
        const fetchMock = mockFetchSequence(res(200));
        global.fetch = fetchMock as unknown as typeof fetch;

        await loadAdapter({
            ...CONFIGURED,
            DISABLE_MEEPS_POSTS: 'true',
        }).emit(EVENT);

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('retries a 500 and stops once it succeeds', async () => {
        const fetchMock = mockFetchSequence(res(500), res(200));
        global.fetch = fetchMock as unknown as typeof fetch;

        await loadAdapter(CONFIGURED).emit(EVENT);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a 429', async () => {
        const fetchMock = mockFetchSequence(res(429), res(200));
        global.fetch = fetchMock as unknown as typeof fetch;

        await loadAdapter(CONFIGURED).emit(EVENT);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a network error', async () => {
        const fetchMock = mockFetchSequence(
            new Error('ECONNREFUSED'),
            res(200)
        );
        global.fetch = fetchMock as unknown as typeof fetch;

        await loadAdapter(CONFIGURED).emit(EVENT);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up after 3 attempts, reporting failure rather than throwing', async () => {
        const fetchMock = mockFetchSequence(res(500), res(500), res(500));
        global.fetch = fetchMock as unknown as typeof fetch;

        await expect(loadAdapter(CONFIGURED).emit(EVENT)).resolves.toBe(false);

        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does NOT retry a 400 - a malformed event will be rejected forever', async () => {
        const fetchMock = mockFetchSequence(res(400, 'bad event'));
        global.fetch = fetchMock as unknown as typeof fetch;

        await expect(loadAdapter(CONFIGURED).emit(EVENT)).resolves.toBe(false);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry a 401', async () => {
        const fetchMock = mockFetchSequence(res(401, 'nope'));
        global.fetch = fetchMock as unknown as typeof fetch;

        await expect(loadAdapter(CONFIGURED).emit(EVENT)).resolves.toBe(false);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never throws when the network fails on every attempt', async () => {
        const fetchMock = mockFetchSequence(
            new Error('down'),
            new Error('down'),
            new Error('down')
        );
        global.fetch = fetchMock as unknown as typeof fetch;

        await expect(loadAdapter(CONFIGURED).emit(EVENT)).resolves.toBe(false);
    });

    // The recap sweep records that a night has been announced, and only a
    // truthy answer here entitles it to. A `true` for anything that did not
    // reach Meeps would lose that recap permanently.
    it('reports true only when Meeps accepted the event', async () => {
        const fetchMock = mockFetchSequence(res(200));
        global.fetch = fetchMock as unknown as typeof fetch;

        await expect(loadAdapter(CONFIGURED).emit(EVENT)).resolves.toBe(true);
    });

    it('reports false when posting is disabled or unconfigured', async () => {
        const fetchMock = mockFetchSequence(res(200));
        global.fetch = fetchMock as unknown as typeof fetch;

        await expect(loadAdapter({}).emit(EVENT)).resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts a bare public host and upgrades it to https', async () => {
        const fetchMock = mockFetchSequence(res(200));
        global.fetch = fetchMock as unknown as typeof fetch;

        await loadAdapter({
            ...CONFIGURED,
            MEEPS_WEBHOOK_URL: 'meeps.up.railway.app',
        }).emit(EVENT);

        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://meeps.up.railway.app/api/diana-events'
        );
    });

    // Railway's private network has no TLS - `.railway.internal` hosts speak
    // plain HTTP behind a Wireguard tunnel. Defaulting a bare internal host to
    // https produced a connection that could never succeed, so the scheme is
    // chosen from the host rather than fixed.
    it('leaves a bare internal host on http, which is all it speaks', async () => {
        const fetchMock = mockFetchSequence(res(200));
        global.fetch = fetchMock as unknown as typeof fetch;

        await loadAdapter({
            ...CONFIGURED,
            MEEPS_WEBHOOK_URL: 'meeps.railway.internal:4000',
        }).emit(EVENT);

        expect(fetchMock.mock.calls[0][0]).toBe(
            'http://meeps.railway.internal:4000/api/diana-events'
        );
    });

    // An explicit scheme is the operator's decision and is never rewritten -
    // including the wrong one, which would otherwise fail silently as a
    // "working" config.
    it('does not rewrite an explicit scheme, even a mistaken one', async () => {
        const fetchMock = mockFetchSequence(res(200));
        global.fetch = fetchMock as unknown as typeof fetch;

        await loadAdapter({
            ...CONFIGURED,
            MEEPS_WEBHOOK_URL: 'https://meeps.railway.internal:4000',
        }).emit(EVENT);

        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://meeps.railway.internal:4000/api/diana-events'
        );
    });

    it('strips a trailing slash rather than doubling it', async () => {
        const fetchMock = mockFetchSequence(res(200));
        global.fetch = fetchMock as unknown as typeof fetch;

        await loadAdapter({
            ...CONFIGURED,
            MEEPS_WEBHOOK_URL: 'https://meeps.example.test/',
        }).emit(EVENT);

        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://meeps.example.test/api/diana-events'
        );
    });
});

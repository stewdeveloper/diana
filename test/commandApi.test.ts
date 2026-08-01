export {};

/**
 * The HTTP surface Meeps talks to.
 *
 * Two behaviours here are easy to get backwards and expensive to get wrong:
 *
 * 1. A scope that cannot be resolved is 200 with a message, not 4xx. "Your
 *    squad has two Discord servers" is something to show the person who ran the
 *    command; a 4xx says "Meeps sent a bad request", which is untrue and
 *    invites a retry that will fail identically.
 *
 * 2. Suggestions fail silently. The picker asks on every keystroke, so an
 *    explanation there would flash and vanish - the person finds out when they
 *    actually run the command.
 */

const resolveCommandScopeMock = jest.fn();
const invokeCommandMock = jest.fn();
const suggestForCommandMock = jest.fn();
const findCommandDescriptorMock = jest.fn();
const buildCommandManifestMock = jest.fn();

jest.mock('diana-core', () => ({
    requireMeepsSecret: jest.fn(),
    resolveCommandScope: resolveCommandScopeMock,
    SCOPE_FAILURE_MESSAGES: {
        no_squad: 'This space is not linked to a squad yet.',
        no_guild: 'This squad has no Discord server attached.',
        ambiguous_guild: 'This squad is attached to more than one server.',
    },
}));

jest.mock('diana-discord', () => ({
    buildCommandManifest: buildCommandManifestMock,
    findCommandDescriptor: findCommandDescriptorMock,
    invokeCommand: invokeCommandMock,
    suggestForCommand: suggestForCommandMock,
}));

const {
    getCommandManifest,
    runCommand,
    suggestCommand,
    __test,
} = require('../apps/server/src/commandApi');

function makeRes() {
    const res: any = {
        statusCode: 200,
        body: undefined,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(payload: unknown) {
            this.body = payload;
            return this;
        },
    };
    return res;
}

const req = (body: Record<string, unknown>) => ({ body }) as any;

beforeEach(() => {
    jest.clearAllMocks();
    __test.lastRun.clear();
    resolveCommandScopeMock.mockResolvedValue({
        ok: true,
        squadId: 'squad-1',
        guildId: 'guild-1',
    });
    findCommandDescriptorMock.mockReturnValue({
        id: 'summoner',
        name: 'summoner',
        display: '/summoner',
        description: 'Profile',
        params: [],
        mutates: false,
    });
    invokeCommandMock.mockResolvedValue({
        ok: true,
        payload: { title: 'Summoner Info' },
    });
    suggestForCommandMock.mockResolvedValue([]);
    buildCommandManifestMock.mockReturnValue([{ id: 'summoner' }]);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('GET /api/commands', () => {
    it('returns the manifest', () => {
        const res = makeRes();
        getCommandManifest(req({}), res);
        expect(res.body).toEqual({ commands: [{ id: 'summoner' }] });
    });

    it('does not need a resolvable space to describe what exists', () => {
        // The picker has to render before it can explain why a command failed.
        const res = makeRes();
        getCommandManifest(req({}), res);
        expect(resolveCommandScopeMock).not.toHaveBeenCalled();
    });
});

describe('POST /api/commands/run', () => {
    it('runs the command and returns a payload', async () => {
        const res = makeRes();
        await runCommand(
            req({ spaceId: 'space-1', id: 'summoner', actorId: '42' }),
            res
        );

        expect(res.body).toEqual({
            ok: true,
            payload: { title: 'Summoner Info' },
        });
    });

    it('namespaces the actor so it can never pass for a Discord id', async () => {
        // This reaches squad_summoners.added_by through /add, a column that
        // otherwise holds Discord ids.
        await runCommand(
            req({ spaceId: 'space-1', id: 'add', actorId: '42' }),
            makeRes()
        );

        expect(invokeCommandMock).toHaveBeenCalledWith(
            expect.objectContaining({ actorId: 'meeps:42' })
        );
    });

    it('still namespaces when Meeps sent no actor', async () => {
        await runCommand(req({ spaceId: 'space-1', id: 'add' }), makeRes());

        expect(invokeCommandMock).toHaveBeenCalledWith(
            expect.objectContaining({ actorId: 'meeps:unknown' })
        );
    });

    it('passes the resolved guild through, which is the whole point', async () => {
        await runCommand(
            req({ spaceId: 'space-1', id: 'summoner' }),
            makeRes()
        );

        expect(invokeCommandMock).toHaveBeenCalledWith(
            expect.objectContaining({ guildId: 'guild-1' })
        );
    });

    it('rejects a request with no space or command', async () => {
        const res = makeRes();
        await runCommand(req({ id: 'summoner' }), res);
        expect(res.statusCode).toBe(400);
    });

    it('404s a command that is not offered', async () => {
        findCommandDescriptorMock.mockReturnValue(null);
        const res = makeRes();
        await runCommand(req({ spaceId: 'space-1', id: 'link' }), res);
        expect(res.statusCode).toBe(404);
    });

    it('explains an unresolvable scope instead of failing the request', async () => {
        resolveCommandScopeMock.mockResolvedValue({
            ok: false,
            reason: 'ambiguous_guild',
        });
        const res = makeRes();
        await runCommand(req({ spaceId: 'space-1', id: 'summoner' }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(false);
        expect(res.body.reason).toBe('ambiguous_guild');
        expect(res.body.message).toContain('more than one');
        expect(invokeCommandMock).not.toHaveBeenCalled();
    });

    it('rate limits the command that spends a Riot call', async () => {
        findCommandDescriptorMock.mockReturnValue({
            id: 'livegame',
            name: 'livegame',
            display: '/livegame',
            description: '',
            params: [],
            mutates: false,
        });

        const first = makeRes();
        await runCommand(req({ spaceId: 'space-1', id: 'livegame' }), first);
        expect(first.body.ok).toBe(true);

        const second = makeRes();
        await runCommand(req({ spaceId: 'space-1', id: 'livegame' }), second);
        expect(second.body).toEqual(
            expect.objectContaining({ ok: false, reason: 'cooldown' })
        );
        expect(invokeCommandMock).toHaveBeenCalledTimes(1);
    });

    it('rate limits per space, not globally', async () => {
        findCommandDescriptorMock.mockReturnValue({
            id: 'livegame',
            name: 'livegame',
            display: '/livegame',
            description: '',
            params: [],
            mutates: false,
        });

        await runCommand(
            req({ spaceId: 'space-1', id: 'livegame' }),
            makeRes()
        );
        const other = makeRes();
        await runCommand(req({ spaceId: 'space-2', id: 'livegame' }), other);

        expect(other.body.ok).toBe(true);
    });

    it('does not rate limit the commands that only read the database', async () => {
        const first = makeRes();
        const second = makeRes();
        await runCommand(req({ spaceId: 'space-1', id: 'summoner' }), first);
        await runCommand(req({ spaceId: 'space-1', id: 'summoner' }), second);

        expect(first.body.ok).toBe(true);
        expect(second.body.ok).toBe(true);
    });

    it('keeps only the parameter types a manifest can describe', async () => {
        await runCommand(
            req({
                spaceId: 'space-1',
                id: 'summoner',
                params: {
                    name: 'Louis',
                    count: 3,
                    flag: true,
                    dropped: null,
                    alsoDropped: { nested: 'object' },
                },
            }),
            makeRes()
        );

        expect(invokeCommandMock).toHaveBeenCalledWith(
            expect.objectContaining({
                params: { name: 'Louis', count: 3, flag: true },
            })
        );
    });

    it('tells the caller when the command produced nothing', async () => {
        invokeCommandMock.mockResolvedValue({ ok: false, reason: 'threw' });
        const res = makeRes();
        await runCommand(req({ spaceId: 'space-1', id: 'summoner' }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(false);
        expect(res.body.message).toBeTruthy();
    });

    it('500s only when something genuinely unexpected happens', async () => {
        resolveCommandScopeMock.mockRejectedValue(new Error('db down'));
        const res = makeRes();
        await runCommand(req({ spaceId: 'space-1', id: 'summoner' }), res);
        expect(res.statusCode).toBe(500);
    });
});

describe('POST /api/commands/suggest', () => {
    it('returns suggestions for a parameter', async () => {
        suggestForCommandMock.mockResolvedValue([
            { label: 'Louis#EUW', value: 'Louis', fill: { name: 'Louis' } },
        ]);
        const res = makeRes();
        await suggestCommand(
            req({
                spaceId: 'space-1',
                id: 'summoner',
                param: 'name',
                query: 'lou',
            }),
            res
        );

        expect(res.body.suggestions).toHaveLength(1);
        expect(suggestForCommandMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'summoner', guildId: 'guild-1' }),
            'squad-1',
            'name',
            'lou'
        );
    });

    it('goes quiet rather than explaining itself mid-keystroke', async () => {
        resolveCommandScopeMock.mockResolvedValue({
            ok: false,
            reason: 'no_squad',
        });
        const res = makeRes();
        await suggestCommand(
            req({ spaceId: 'space-1', id: 'summoner', param: 'name' }),
            res
        );

        expect(res.body).toEqual({ suggestions: [] });
        expect(res.statusCode).toBe(200);
    });

    it('never fails the picker when the lookup throws', async () => {
        suggestForCommandMock.mockRejectedValue(new Error('boom'));
        const res = makeRes();
        await suggestCommand(
            req({ spaceId: 'space-1', id: 'summoner', param: 'name' }),
            res
        );

        expect(res.body).toEqual({ suggestions: [] });
    });

    it('treats a missing query as an empty one', async () => {
        await suggestCommand(
            req({ spaceId: 'space-1', id: 'summoner', param: 'name' }),
            makeRes()
        );

        expect(suggestForCommandMock).toHaveBeenCalledWith(
            expect.anything(),
            'squad-1',
            'name',
            ''
        );
    });

    it('rejects a request that names no parameter', async () => {
        const res = makeRes();
        await suggestCommand(req({ spaceId: 'space-1', id: 'summoner' }), res);
        expect(res.statusCode).toBe(400);
    });
});

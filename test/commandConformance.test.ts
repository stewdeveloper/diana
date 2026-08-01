export {};

/**
 * The test that makes the invocation shim safe to rely on.
 *
 * `commandInvocation.ts` hands each command an object that satisfies the part
 * of `ChatInputCommandInteraction` the allowlisted commands were measured to
 * use. That measurement is a fact about the code today, and nothing in the type
 * system keeps it true - a command that starts reading `interaction.member` or
 * `interaction.channel` would compile, deploy, and only then fail.
 *
 * So this drives *every* allowlisted command through the real shim and asserts
 * it got far enough to reply. It is not checking the numbers each command
 * produces; the per-command suites do that. It is checking one thing: that the
 * stand-in is still enough.
 *
 * The database is mocked empty on purpose. Every command then takes its
 * "nothing found" path, which is the shortest route through its whole option
 * -reading and replying flow, and needs no fixtures to stay correct as the
 * queries change.
 *
 * discord.js is NOT mocked here, unlike the per-command suites. The manifest is
 * derived from `data.toJSON()`, so a fake builder would test the fake.
 */

const dbQueryMock = jest.fn();

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({ db: { query: dbQueryMock } })
);

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/lolService/lolServiceFactory',
    () => ({
        createLolService: () => ({
            getActiveGame: jest.fn().mockResolvedValue(null),
            getSummonerByPUUID: jest
                .fn()
                .mockResolvedValue({ profileIconId: 1 }),
            getAccountByRiotId: jest.fn().mockResolvedValue(null),
        }),
    })
);

import {
    buildCommandManifest,
    findCommandDescriptor,
    invokeCommand,
    toMessagePayload,
    MEEPS_COMMANDS,
    registerSlashCommands,
    clearAllCommands,
    leagueDiscordCommands,
    apexDiscordCommands,
    pingCommand,
    type MeepsCommandDescriptor,
    type CommandParamValue,
} from 'diana-discord';

/**
 * A value for each required parameter, derived from the manifest rather than
 * hardcoded - so a command that gains a required option stays covered without
 * anybody remembering to update this list.
 */
function fillRequired(
    descriptor: MeepsCommandDescriptor
): Record<string, CommandParamValue> {
    const params: Record<string, CommandParamValue> = {};
    for (const param of descriptor.params) {
        if (!param.required) continue;
        if (param.choices?.length) {
            params[param.name] = param.choices[0].value;
            continue;
        }
        params[param.name] =
            param.type === 'boolean'
                ? false
                : param.type === 'string'
                  ? 'conformance-probe'
                  : 1;
    }
    return params;
}

// At module scope, not in `beforeAll`: the conformance block below generates
// one test per manifest entry, and Jest builds that list while collecting the
// file - long before any hook runs. Registering in `beforeAll` yields an empty
// manifest and therefore zero generated tests, which passes silently.
clearAllCommands();
registerSlashCommands([pingCommand, ...leagueDiscordCommands], 'diana');
registerSlashCommands([...apexDiscordCommands], 'pathfinder');

afterAll(() => {
    clearAllCommands();
});

beforeEach(() => {
    dbQueryMock.mockReset();
    dbQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('the manifest', () => {
    it('offers every allowlisted command', () => {
        const names = new Set(buildCommandManifest().map((c) => c.name));
        for (const allowed of MEEPS_COMMANDS) {
            expect(names).toContain(allowed);
        }
    });

    it('offers nothing that is not allowlisted', () => {
        for (const entry of buildCommandManifest()) {
            expect(MEEPS_COMMANDS.has(entry.name)).toBe(true);
        }
    });

    it('keeps the commands that would corrupt or confuse out', () => {
        // `/link` is the one that matters: it keys on a *Discord* user id, so
        // running it from Meeps would write a Meeps id into
        // identity_link_challenges.discord_user_id. The rest are Discord
        // administration or Discord-only rendering.
        const names = new Set(buildCommandManifest().map((c) => c.name));
        for (const excluded of [
            'link',
            'unlink',
            'setchannel',
            'config',
            'privacy',
            'help',
            'ping',
        ]) {
            expect(names.has(excluded)).toBe(false);
        }
    });

    it('offers no Apex command, which belongs to the other bot', () => {
        for (const entry of buildCommandManifest()) {
            expect(entry.name.startsWith('apex-')).toBe(false);
        }
    });

    it('splits a subcommand command into one entry per subcommand', () => {
        // `/leaderboard` cannot be run bare in Discord either, and its two
        // subcommands take different options - so one flat entry could not
        // describe both.
        const manifest = buildCommandManifest();
        const boards = manifest.filter((c) => c.name === 'leaderboard');

        expect(boards.map((c) => c.id).sort()).toEqual([
            'leaderboard:lp',
            'leaderboard:stats',
        ]);
        expect(boards.every((c) => c.display.startsWith('/leaderboard '))).toBe(
            true
        );
    });

    it('marks the two commands that change something', () => {
        const mutating = buildCommandManifest()
            .filter((c) => c.mutates)
            .map((c) => c.name)
            .sort();
        expect(mutating).toEqual(['add', 'remove']);
    });

    it('describes parameters the picker can actually render', () => {
        for (const entry of buildCommandManifest()) {
            for (const param of entry.params) {
                expect(['string', 'integer', 'number', 'boolean']).toContain(
                    param.type
                );
                expect(typeof param.name).toBe('string');
                expect(param.name.length).toBeGreaterThan(0);
            }
        }
    });

    it('carries the autocomplete flag through from the command', () => {
        const summoner = findCommandDescriptor('summoner');
        const name = summoner?.params.find((p) => p.name === 'name');
        expect(name?.autocomplete).toBe(true);
        expect(name?.required).toBe(true);
    });

    it('is not stranded by a re-registration', () => {
        // The manifest is memoised against the registry's version. If that
        // signal ever stops firing, this is the shape of the bug: commands are
        // re-registered and the picker keeps offering the old set.
        expect(buildCommandManifest().length).toBeGreaterThan(0);

        clearAllCommands();
        expect(buildCommandManifest()).toEqual([]);

        registerSlashCommands([pingCommand, ...leagueDiscordCommands], 'diana');
        expect(buildCommandManifest().length).toBeGreaterThan(0);
    });

    it('hands out a copy, so a caller cannot edit everyone else’s manifest', () => {
        const first = buildCommandManifest();
        first.length = 0;
        expect(buildCommandManifest().length).toBeGreaterThan(0);
    });

    it('carries choices through from the command', () => {
        const wrapped = findCommandDescriptor('wrapped');
        const period = wrapped?.params.find((p) => p.name === 'period');
        expect(period?.choices?.map((c) => c.value)).toEqual([
            'split',
            'month',
            'year',
            'all',
        ]);
    });
});

describe('every allowlisted command survives the shim', () => {
    // Generated from the manifest, so a newly allowlisted command is covered
    // the moment it is added rather than when somebody remembers to add a case.
    const manifest = buildCommandManifest();

    it('has commands to check', () => {
        expect(manifest.length).toBeGreaterThan(0);
    });

    for (const descriptor of manifest) {
        it(`${descriptor.display} replies without reaching for anything missing`, async () => {
            const outcome = await invokeCommand({
                id: descriptor.id,
                params: fillRequired(descriptor),
                guildId: 'guild-1',
                actorId: 'meeps:1',
            });

            // `no_reply` means the command returned without replying - which
            // would be "the application did not respond" in Discord too.
            // `threw` means the shim was not enough, which is the failure this
            // whole test exists to catch.
            expect(outcome).toEqual(
                expect.objectContaining({
                    ok: true,
                    payload: expect.anything(),
                })
            );

            if (outcome.ok) {
                const hasSomethingToShow = Boolean(
                    outcome.payload.title ||
                    outcome.payload.description ||
                    outcome.payload.text ||
                    outcome.payload.fields?.length
                );
                expect(hasSomethingToShow).toBe(true);
            }
        });
    }
});

describe('invokeCommand', () => {
    it('refuses a command that is not allowlisted', async () => {
        const outcome = await invokeCommand({
            id: 'link',
            params: {},
            guildId: 'guild-1',
            actorId: 'meeps:1',
        });
        expect(outcome).toEqual({ ok: false, reason: 'unknown_command' });
    });

    it('refuses an id that does not exist at all', async () => {
        const outcome = await invokeCommand({
            id: 'not-a-command',
            params: {},
            guildId: 'guild-1',
            actorId: 'meeps:1',
        });
        expect(outcome).toEqual({ ok: false, reason: 'unknown_command' });
    });
});

describe('toMessagePayload', () => {
    /**
     * The three keys that differ between Discord's embed JSON and Diana's own
     * MessagePayload. Meeps' EmbedCard reads the latter, so getting these wrong
     * loses the colour, the portrait and the footer - silently, because every
     * one of them is optional on both sides.
     */
    it('renames the three keys that differ', () => {
        const payload = toMessagePayload({
            embeds: [
                {
                    title: 'Summoner Info',
                    color: 0xc8aa6e,
                    thumbnail: { url: 'https://example.test/emblem.png' },
                    footer: { text: 'Last 7 days' },
                },
            ],
        });

        expect(payload.colorHex).toBe(0xc8aa6e);
        expect(payload.thumbnailUrl).toBe('https://example.test/emblem.png');
        expect(payload.footer).toBe('Last 7 days');
    });

    it('passes the rest through unchanged', () => {
        const payload = toMessagePayload({
            embeds: [
                {
                    title: 'T',
                    description: 'D',
                    url: 'https://example.test',
                    timestamp: '2026-08-01T00:00:00.000Z',
                    fields: [{ name: 'F', value: 'V', inline: true }],
                },
            ],
        });

        expect(payload).toEqual(
            expect.objectContaining({
                title: 'T',
                description: 'D',
                url: 'https://example.test',
                timestamp: '2026-08-01T00:00:00.000Z',
                fields: [{ name: 'F', value: 'V', inline: true }],
            })
        );
    });

    it('unwraps a builder as readily as a plain object', () => {
        // Commands reply with EmbedBuilder instances, not JSON.
        const builder = { toJSON: () => ({ title: 'Built' }) };
        expect(toMessagePayload({ embeds: [builder] }).title).toBe('Built');
    });

    it('keeps plain text, which is how the error paths reply', () => {
        expect(toMessagePayload({ content: 'Could not find that.' })).toEqual({
            text: 'Could not find that.',
        });
    });

    it('survives a reply with no embed at all', () => {
        expect(toMessagePayload({})).toEqual({});
    });

    it('drops inline:false rather than sending it', () => {
        // MessageField.inline is optional; false and absent render the same,
        // and absent is smaller on every message.
        const payload = toMessagePayload({
            embeds: [{ fields: [{ name: 'F', value: 'V', inline: false }] }],
        });
        expect(payload.fields).toEqual([{ name: 'F', value: 'V' }]);
    });
});

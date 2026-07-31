export {};

// ─── Discord.js mock builders ─────────────────────────────────────────────────

class MockStringOption {
    public config: Record<string, unknown> = {};
    setName(n: string) {
        this.config.name = n;
        return this;
    }
    setDescription(_d: string) {
        return this;
    }
    setRequired(r: boolean) {
        this.config.required = r;
        return this;
    }
    setAutocomplete(a: boolean) {
        this.config.autocomplete = a;
        return this;
    }
}

class MockBooleanOption {
    public config: Record<string, unknown> = {};
    setName(n: string) {
        this.config.name = n;
        return this;
    }
    setDescription(_d: string) {
        return this;
    }
    setRequired(r: boolean) {
        this.config.required = r;
        return this;
    }
}

class MockSubcommand {
    public name?: string;
    public options: Array<MockStringOption | MockBooleanOption> = [];
    setName(n: string) {
        this.name = n;
        return this;
    }
    setDescription(_d: string) {
        return this;
    }
    addStringOption(cb: (o: MockStringOption) => unknown) {
        const o = new MockStringOption();
        cb(o);
        this.options.push(o);
        return this;
    }
    addBooleanOption(cb: (o: MockBooleanOption) => unknown) {
        const o = new MockBooleanOption();
        cb(o);
        this.options.push(o);
        return this;
    }
}

class MockSlashCommandBuilder {
    public name?: string;
    public subcommands: MockSubcommand[] = [];
    public defaultMemberPermissions: unknown;
    setName(n: string) {
        this.name = n;
        return this;
    }
    setDescription(_d: string) {
        return this;
    }
    setDefaultMemberPermissions(p: unknown) {
        this.defaultMemberPermissions = p;
        return this;
    }
    addSubcommand(cb: (s: MockSubcommand) => unknown) {
        const s = new MockSubcommand();
        cb(s);
        this.subcommands.push(s);
        return this;
    }
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

const getSummonersForGuildMock = jest.fn();
const getHiddenPuuidsMock = jest.fn();
const getPrivacyMock = jest.fn();
const setHiddenMock = jest.fn();
const setHiddenForAllMock = jest.fn();
const resolveIdentityMock = jest.fn();

jest.mock('discord.js', () => ({
    SlashCommandBuilder: MockSlashCommandBuilder,
    PermissionFlagsBits: { ManageGuild: BigInt(32) },
    MessageFlags: { Ephemeral: 64 },
}));

jest.mock('diana-core', () => ({
    getSummonersForGuild: getSummonersForGuildMock,
    getHiddenPuuids: getHiddenPuuidsMock,
    getPrivacy: getPrivacyMock,
    setHidden: setHiddenMock,
    setHiddenForAll: setHiddenForAllMock,
    resolveIdentity: resolveIdentityMock,
}));

import { privacyCommand } from '../packages/diana-discord/src/plugins/diana-league-bot/discord/commands/privacyCommand';

const roster = [
    { puuid: 'p1', gameName: 'Louis', tagLine: 'EUW' },
    { puuid: 'p2', gameName: 'Aidan', tagLine: 'EUW' },
    { puuid: 'p3', gameName: 'Aidan', tagLine: 'NA1' },
];

function makeInteraction(
    opts: {
        subcommand?: string;
        name?: string | null;
        tag?: string | null;
        guildId?: string | null;
        manageGuild?: boolean;
        hidden?: boolean;
    } = {}
) {
    const {
        subcommand = 'hide',
        name = 'Louis',
        tag = null,
        guildId = 'guild-7',
        manageGuild = true,
        hidden = true,
    } = opts;
    return {
        guildId,
        user: { id: 'admin-1' },
        memberPermissions: { has: jest.fn().mockReturnValue(manageGuild) },
        options: {
            getSubcommand: jest.fn().mockReturnValue(subcommand),
            getString: jest.fn((option: string) =>
                option === 'name' ? name : tag
            ),
            getBoolean: jest.fn().mockReturnValue(hidden),
        },
        reply: jest.fn().mockResolvedValue(undefined),
        deferReply: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
    };
}

const replyText = (interaction: ReturnType<typeof makeInteraction>) => {
    const arg = interaction.editReply.mock.calls[0][0];
    return typeof arg === 'string' ? arg : String(arg?.content ?? '');
};

beforeEach(() => {
    jest.clearAllMocks();
    getSummonersForGuildMock.mockResolvedValue(roster);
    getHiddenPuuidsMock.mockResolvedValue(new Set());
    getPrivacyMock.mockResolvedValue(null);
    setHiddenMock.mockResolvedValue({});
    setHiddenForAllMock.mockResolvedValue(1);
    resolveIdentityMock.mockResolvedValue({
        identityId: 'id-1',
        puuids: ['p1'],
        discordUserIds: ['admin-1'],
        meepsUserIds: [],
        verifiedPuuids: ['p1'],
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('privacyCommand data', () => {
    it('is named privacy', () => {
        expect(privacyCommand.data.name).toBe('privacy');
    });

    it('offers me, hide, show and status', () => {
        const names = (privacyCommand.data as any).subcommands.map(
            (s: MockSubcommand) => s.name
        );
        expect(names).toEqual(['me', 'hide', 'show', 'status']);
    });

    it('is not declared-gated, so /privacy me stays reachable', () => {
        // Discord's declared permissions are per command, not per subcommand.
        // Gating the command would put self-service behind Manage Server,
        // which is the opposite of the point.
        expect(
            (privacyCommand.data as any).defaultMemberPermissions
        ).toBeUndefined();
    });
});

describe('/privacy me', () => {
    it('needs no permission at all', async () => {
        const interaction = makeInteraction({
            subcommand: 'me',
            manageGuild: false,
        });
        await privacyCommand.execute(interaction as any);

        expect(setHiddenForAllMock).toHaveBeenCalled();
        expect(replyText(interaction)).not.toContain('Manage Server');
    });

    it('covers every linked account at once', async () => {
        // Hiding one of somebody's three accounts while the other two stay on
        // a leaderboard is not what anybody means by opting out.
        resolveIdentityMock.mockResolvedValue({
            identityId: 'id-1',
            puuids: ['p1', 'p2', 'p3'],
            discordUserIds: ['admin-1'],
            meepsUserIds: [],
            verifiedPuuids: [],
        });

        const interaction = makeInteraction({ subcommand: 'me' });
        await privacyCommand.execute(interaction as any);

        expect(setHiddenForAllMock).toHaveBeenCalledWith(
            ['p1', 'p2', 'p3'],
            true,
            'admin-1'
        );
        expect(replyText(interaction)).toContain('3 linked accounts');
    });

    it('can put them back', async () => {
        const interaction = makeInteraction({
            subcommand: 'me',
            hidden: false,
        });
        await privacyCommand.execute(interaction as any);

        expect(setHiddenForAllMock).toHaveBeenCalledWith(
            ['p1'],
            false,
            'admin-1'
        );
        expect(replyText(interaction)).toContain('Visible again');
    });

    it('points an unlinked caller at /link, and at an admin', async () => {
        resolveIdentityMock.mockResolvedValue({
            identityId: null,
            puuids: [],
            discordUserIds: [],
            meepsUserIds: [],
            verifiedPuuids: [],
        });

        const interaction = makeInteraction({ subcommand: 'me' });
        await privacyCommand.execute(interaction as any);

        expect(setHiddenForAllMock).not.toHaveBeenCalled();
        const text = replyText(interaction);
        expect(text).toContain('/link start');
        expect(text).toContain('/privacy hide');
    });
});

describe('/privacy permission gate', () => {
    it('refuses a non-admin naming somebody else', async () => {
        const interaction = makeInteraction({
            subcommand: 'hide',
            manageGuild: false,
        });
        await privacyCommand.execute(interaction as any);

        expect(setHiddenMock).not.toHaveBeenCalled();
        expect(replyText(interaction)).toContain('Manage Server');
    });

    it('refuses when permissions cannot be read at all', async () => {
        // A privacy control that fails open is not a privacy control.
        const interaction = {
            ...makeInteraction({ subcommand: 'hide' }),
            memberPermissions: null,
        };
        await privacyCommand.execute(interaction as any);

        expect(setHiddenMock).not.toHaveBeenCalled();
        expect(replyText(interaction as any)).toContain('Manage Server');
    });

    it('still refuses a non-admin using status', async () => {
        const interaction = makeInteraction({
            subcommand: 'status',
            manageGuild: false,
        });
        await privacyCommand.execute(interaction as any);
        expect(getHiddenPuuidsMock).not.toHaveBeenCalled();
    });
});

describe('/privacy hide', () => {
    it('hides a resolved player and records who did it', async () => {
        const interaction = makeInteraction({ subcommand: 'hide' });
        await privacyCommand.execute(interaction as any);

        expect(setHiddenMock).toHaveBeenCalledWith('p1', true, 'admin-1');
        expect(replyText(interaction)).toContain('Louis#EUW');
    });

    it('replies ephemerally', async () => {
        // Announcing "Louis has been hidden" to the channel would undo most
        // of what the command is for.
        const interaction = makeInteraction();
        await privacyCommand.execute(interaction as any);
        expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    });

    it('says the player keeps their own match posts', async () => {
        const interaction = makeInteraction();
        await privacyCommand.execute(interaction as any);
        expect(replyText(interaction)).toContain('match posts');
    });

    it('reports a no-op instead of claiming it did something', async () => {
        getPrivacyMock.mockResolvedValue({ puuid: 'p1', hidden: true });
        const interaction = makeInteraction({ subcommand: 'hide' });
        await privacyCommand.execute(interaction as any);

        expect(setHiddenMock).not.toHaveBeenCalled();
        expect(replyText(interaction)).toContain('already hidden');
    });

    it('refuses an ambiguous name and lists the candidates', async () => {
        const interaction = makeInteraction({ name: 'Aidan' });
        await privacyCommand.execute(interaction as any);

        expect(setHiddenMock).not.toHaveBeenCalled();
        const text = replyText(interaction);
        expect(text).toContain('Aidan#EUW');
        expect(text).toContain('Aidan#NA1');
    });

    it('resolves an ambiguous name once a tag disambiguates it', async () => {
        const interaction = makeInteraction({ name: 'Aidan', tag: 'NA1' });
        await privacyCommand.execute(interaction as any);
        expect(setHiddenMock).toHaveBeenCalledWith('p3', true, 'admin-1');
    });

    it('reports an untracked name without touching the database', async () => {
        const interaction = makeInteraction({ name: 'Nobody' });
        await privacyCommand.execute(interaction as any);

        expect(setHiddenMock).not.toHaveBeenCalled();
        expect(replyText(interaction)).toContain('No tracked summoner');
    });
});

describe('/privacy show', () => {
    it('un-hides a hidden player', async () => {
        getPrivacyMock.mockResolvedValue({ puuid: 'p1', hidden: true });
        const interaction = makeInteraction({ subcommand: 'show' });
        await privacyCommand.execute(interaction as any);

        expect(setHiddenMock).toHaveBeenCalledWith('p1', false, 'admin-1');
    });

    it('reports a no-op for somebody already visible', async () => {
        const interaction = makeInteraction({ subcommand: 'show' });
        await privacyCommand.execute(interaction as any);

        expect(setHiddenMock).not.toHaveBeenCalled();
        expect(replyText(interaction)).toContain('already visible');
    });
});

describe('/privacy status', () => {
    it('names everybody currently hidden', async () => {
        getHiddenPuuidsMock.mockResolvedValue(new Set(['p2']));
        const interaction = makeInteraction({ subcommand: 'status' });
        await privacyCommand.execute(interaction as any);

        const text = replyText(interaction);
        expect(text).toContain('Aidan#EUW');
        expect(text).not.toContain('Louis');
    });

    it('says so plainly when nobody is hidden', async () => {
        const interaction = makeInteraction({ subcommand: 'status' });
        await privacyCommand.execute(interaction as any);
        expect(replyText(interaction)).toContain('Nobody is hidden');
    });

    it('handles a server with no tracked summoners', async () => {
        getSummonersForGuildMock.mockResolvedValue([]);
        const interaction = makeInteraction({ subcommand: 'status' });
        await privacyCommand.execute(interaction as any);
        expect(replyText(interaction)).toContain('No summoners are tracked');
    });
});

describe('/privacy failure modes', () => {
    it('refuses outside a server', async () => {
        const interaction = makeInteraction({ guildId: null });
        await privacyCommand.execute(interaction as any);

        expect(interaction.reply).toHaveBeenCalled();
        expect(getSummonersForGuildMock).not.toHaveBeenCalled();
    });

    it('reports a database failure without leaking the error', async () => {
        getSummonersForGuildMock.mockRejectedValue(new Error('db down'));
        const interaction = makeInteraction();
        await privacyCommand.execute(interaction as any);

        expect(replyText(interaction)).toContain('Something went wrong');
        expect(replyText(interaction)).not.toContain('db down');
    });
});

describe('/privacy autocomplete', () => {
    function makeAutocomplete(value: string, focusedName = 'name') {
        return {
            guildId: 'guild-7',
            responded: false,
            options: {
                getFocused: jest
                    .fn()
                    .mockReturnValue({ name: focusedName, value }),
            },
            respond: jest.fn().mockResolvedValue(undefined),
        };
    }

    it('suggests matching tracked names', async () => {
        const interaction = makeAutocomplete('ai');
        await privacyCommand.autocomplete!(interaction as any);

        expect(interaction.respond).toHaveBeenCalledWith([
            { name: 'Aidan', value: 'Aidan' },
        ]);
    });

    it('de-duplicates a name shared by two accounts', async () => {
        const interaction = makeAutocomplete('');
        await privacyCommand.autocomplete!(interaction as any);

        const suggestions = interaction.respond.mock.calls[0][0];
        expect(suggestions).toHaveLength(2);
    });

    it('stays silent for any option other than the name', async () => {
        const interaction = makeAutocomplete('x', 'tag');
        await privacyCommand.autocomplete!(interaction as any);
        expect(interaction.respond).toHaveBeenCalledWith([]);
    });

    it('answers empty rather than throwing when the lookup fails', async () => {
        getSummonersForGuildMock.mockRejectedValue(new Error('db down'));
        const interaction = makeAutocomplete('a');
        await privacyCommand.autocomplete!(interaction as any);
        expect(interaction.respond).toHaveBeenCalledWith([]);
    });
});

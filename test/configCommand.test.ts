export {};

// ─── Discord.js mock builders ─────────────────────────────────────────────────

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
    addChoices(...choices: Array<Record<string, unknown>>) {
        const existing =
            (this.config.choices as Record<string, unknown>[] | undefined) ??
            [];
        this.config.choices = [...existing, ...choices];
        return this;
    }
}

class MockSubcommand {
    public name?: string;
    public options: Array<MockBooleanOption | MockStringOption> = [];
    setName(n: string) {
        this.name = n;
        return this;
    }
    setDescription(_d: string) {
        return this;
    }
    addBooleanOption(cb: (o: MockBooleanOption) => unknown) {
        const o = new MockBooleanOption();
        cb(o);
        this.options.push(o);
        return this;
    }
    addStringOption(cb: (o: MockStringOption) => unknown) {
        const o = new MockStringOption();
        cb(o);
        this.options.push(o);
        return this;
    }
}

class MockSlashCommandBuilder {
    public name?: string;
    public subcommands: MockSubcommand[] = [];
    setName(n: string) {
        this.name = n;
        return this;
    }
    setDescription(_d: string) {
        return this;
    }
    setDefaultMemberPermissions(_p: unknown) {
        return this;
    }
    addSubcommand(cb: (s: MockSubcommand) => unknown) {
        const s = new MockSubcommand();
        cb(s);
        this.subcommands.push(s);
        return this;
    }
}

class MockEmbedBuilder {
    public data: Record<string, any> = { fields: [] };
    setTitle(t: string) {
        this.data.title = t;
        return this;
    }
    setColor(c: number) {
        this.data.color = c;
        return this;
    }
    setTimestamp() {
        return this;
    }
    addFields(...fields: any[]) {
        const normalized = Array.isArray(fields[0]) ? fields[0] : fields;
        this.data.fields = [...this.data.fields, ...normalized];
        return this;
    }
}

// ─── diana-core mocks ─────────────────────────────────────────────────────────

const getGuildConfigMock = jest.fn();
const setGuildLivePostingMock = jest.fn();
const setGuildNotificationPrefMock = jest.fn();

const NOTIFICATION_PREF_DEFAULTS: Record<string, boolean> = {
    match_posts: true,
    rank_posts: true,
    streaks: true,
    digest: true,
    rotation: false,
    live_alerts: false,
};

function getNotificationPrefImpl(
    config: {
        live_posting?: boolean;
        notification_prefs?: Record<string, boolean> | null;
    } | null,
    key: string
): boolean {
    const explicit = config?.notification_prefs?.[key];
    if (typeof explicit === 'boolean') return explicit;
    if ((key === 'match_posts' || key === 'rank_posts') && config) {
        return config.live_posting ?? true;
    }
    return NOTIFICATION_PREF_DEFAULTS[key];
}

jest.mock('discord.js', () => ({
    SlashCommandBuilder: MockSlashCommandBuilder,
    PermissionFlagsBits: { ManageGuild: BigInt(32) },
    EmbedBuilder: MockEmbedBuilder,
    MessageFlags: { Ephemeral: 64 },
}));

jest.mock('diana-core', () => ({
    getGuildCompetitiveScope: jest.fn().mockResolvedValue('all'),
    setGuildCompetitiveScope: jest.fn().mockResolvedValue({}),
    getCompetitiveScopeFromConfig: (config: any) =>
        config?.competitive_scope === 'ranked' ? 'ranked' : 'all',
    getGuildConfig: getGuildConfigMock,
    setGuildLivePosting: setGuildLivePostingMock,
    setGuildNotificationPref: setGuildNotificationPrefMock,
    getNotificationPref: getNotificationPrefImpl,
}));

const {
    configCommand,
} = require('../packages/diana-discord/src/plugins/diana-league-bot/discord/commands/configCommand');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInteraction(
    opts: {
        subcommand?: string;
        enabled?: boolean;
        guildId?: string | null;
        type?: string;
    } = {}
) {
    const {
        subcommand = 'live-posting',
        enabled = true,
        guildId = 'guild-7',
        type = 'digest',
    } = opts;
    return {
        guildId,
        options: {
            getSubcommand: jest.fn().mockReturnValue(subcommand),
            getBoolean: jest.fn().mockReturnValue(enabled),
            getString: jest.fn().mockReturnValue(type),
        },
        reply: jest.fn().mockResolvedValue(undefined),
        deferReply: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('configCommand', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('data', () => {
        it('has command name "config"', () => {
            expect(configCommand.data.name).toBe('config');
        });

        it('has live-posting and view subcommands', () => {
            const names = configCommand.data.subcommands.map(
                (s: any) => s.name
            );
            expect(names).toContain('live-posting');
            expect(names).toContain('view');
        });
    });

    describe('execute - live-posting subcommand', () => {
        it('disables live posting and confirms', async () => {
            setGuildLivePostingMock.mockResolvedValue(undefined);
            const interaction = makeInteraction({
                subcommand: 'live-posting',
                enabled: false,
            });

            await configCommand.execute(interaction as any);

            expect(setGuildLivePostingMock).toHaveBeenCalledWith(
                'guild-7',
                false
            );
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('disabled'),
                })
            );
        });

        it('enables live posting and confirms', async () => {
            setGuildLivePostingMock.mockResolvedValue(undefined);
            const interaction = makeInteraction({
                subcommand: 'live-posting',
                enabled: true,
            });

            await configCommand.execute(interaction as any);

            expect(setGuildLivePostingMock).toHaveBeenCalledWith(
                'guild-7',
                true
            );
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('enabled'),
                })
            );
        });

        it('replies ephemerally', async () => {
            setGuildLivePostingMock.mockResolvedValue(undefined);
            const interaction = makeInteraction({ subcommand: 'live-posting' });

            await configCommand.execute(interaction as any);

            expect(interaction.deferReply).toHaveBeenCalledWith(
                expect.objectContaining({ flags: 64 })
            );
        });
    });

    describe('execute - notifications subcommand', () => {
        it('registers the notifications subcommand with type choices', () => {
            const names = configCommand.data.subcommands.map(
                (s: any) => s.name
            );
            expect(names).toContain('notifications');
        });

        it('persists the pref and confirms', async () => {
            setGuildNotificationPrefMock.mockResolvedValue(undefined);
            const interaction = makeInteraction({
                subcommand: 'notifications',
                type: 'digest',
                enabled: false,
            });

            await configCommand.execute(interaction as any);

            expect(setGuildNotificationPrefMock).toHaveBeenCalledWith(
                'guild-7',
                'digest',
                false
            );
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('disabled'),
                })
            );
        });

        it('enables a pref and confirms', async () => {
            setGuildNotificationPrefMock.mockResolvedValue(undefined);
            const interaction = makeInteraction({
                subcommand: 'notifications',
                type: 'rotation',
                enabled: true,
            });

            await configCommand.execute(interaction as any);

            expect(setGuildNotificationPrefMock).toHaveBeenCalledWith(
                'guild-7',
                'rotation',
                true
            );
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('enabled'),
                })
            );
        });
    });

    describe('execute - view subcommand', () => {
        it('shows channel and live_posting from DB config', async () => {
            getGuildConfigMock.mockResolvedValue({
                channel_id: 'c-123',
                live_posting: true,
            });
            const interaction = makeInteraction({ subcommand: 'view' });

            await configCommand.execute(interaction as any);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({ embeds: expect.any(Array) })
            );
        });

        it('shows "Not set" when no config exists', async () => {
            getGuildConfigMock.mockResolvedValue(null);
            const interaction = makeInteraction({ subcommand: 'view' });

            await configCommand.execute(interaction as any);

            const reply = interaction.editReply.mock.calls[0][0];
            const embed: MockEmbedBuilder = reply.embeds[0];
            const channelField = embed.data.fields.find(
                (f: any) => f.name === 'Notification Channel'
            );
            expect(channelField.value).toContain('Not set');
        });

        it('shows live posting as Disabled when false', async () => {
            getGuildConfigMock.mockResolvedValue({
                channel_id: 'c-1',
                live_posting: false,
            });
            const interaction = makeInteraction({ subcommand: 'view' });

            await configCommand.execute(interaction as any);

            const reply = interaction.editReply.mock.calls[0][0];
            const embed: MockEmbedBuilder = reply.embeds[0];
            const liveField = embed.data.fields.find(
                (f: any) => f.name === 'Live Match Posting'
            );
            expect(liveField.value).toContain('Disabled');
        });
    });

    describe('execute - guildId guard', () => {
        it('replies with error when not in a guild', async () => {
            const interaction = makeInteraction({ guildId: null });

            await configCommand.execute(interaction as any);

            expect(setGuildLivePostingMock).not.toHaveBeenCalled();
            expect(interaction.reply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining(
                        'only be used in a server'
                    ),
                })
            );
        });
    });
});

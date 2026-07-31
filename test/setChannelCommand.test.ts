export {};

// ─── Discord.js mock builders ─────────────────────────────────────────────────

class MockChannelOption {
    public config: Record<string, unknown> = {};
    setName(n: string) {
        this.config.name = n;
        return this;
    }
    setDescription(d: string) {
        this.config.description = d;
        return this;
    }
    setRequired(r: boolean) {
        this.config.required = r;
        return this;
    }
    addChannelTypes(..._types: unknown[]) {
        return this;
    }
}

class MockSlashCommandBuilder {
    public name?: string;
    public description?: string;
    public options: MockChannelOption[] = [];
    setName(n: string) {
        this.name = n;
        return this;
    }
    setDescription(d: string) {
        this.description = d;
        return this;
    }
    setDefaultMemberPermissions(_p: unknown) {
        return this;
    }
    addChannelOption(cb: (o: MockChannelOption) => unknown) {
        const o = new MockChannelOption();
        cb(o);
        this.options.push(o);
        return this;
    }
}

class MockEmbedBuilder {
    public data: Record<string, any> = { fields: [] };
    setTitle(t: string) {
        this.data.title = t;
        return this;
    }
    setDescription(d: string) {
        this.data.description = d;
        return this;
    }
    setColor(c: number) {
        this.data.color = c;
        return this;
    }
    addFields(...fields: any[]) {
        const normalized = Array.isArray(fields[0]) ? fields[0] : fields;
        this.data.fields = [...this.data.fields, ...normalized];
        return this;
    }
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

const setGuildChannelMock = jest.fn();
const getSummonersForGuildMock = jest.fn();

jest.mock('discord.js', () => ({
    SlashCommandBuilder: MockSlashCommandBuilder,
    EmbedBuilder: MockEmbedBuilder,
    PermissionFlagsBits: { ManageChannels: BigInt(16) },
    ChannelType: { GuildText: 0 },
    MessageFlags: { Ephemeral: 64 },
}));

jest.mock('diana-core', () => ({
    setGuildChannel: setGuildChannelMock,
    getSummonersForGuild: getSummonersForGuildMock,
}));

const {
    setChannelCommand,
} = require('../packages/diana-discord/src/plugins/diana-league-bot/discord/commands/setChannelCommand');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A channel the bot can post into, and a record of what it posted. */
function makeTargetChannel(sendable = true) {
    return {
        id: 'channel-456',
        isTextBased: () => true,
        send: sendable
            ? jest.fn().mockResolvedValue(undefined)
            : jest.fn().mockRejectedValue(new Error('Missing Permissions')),
    };
}

function makeInteraction(overrides: Record<string, unknown> = {}) {
    const target = (overrides.target as any) ?? makeTargetChannel();
    delete overrides.target;
    const interaction = {
        guildId: 'guild-123',
        guild: {
            channels: { fetch: jest.fn().mockResolvedValue(target) },
        },
        options: {
            getChannel: jest.fn().mockReturnValue({ id: 'channel-456' }),
        },
        reply: jest.fn().mockResolvedValue(undefined),
        deferReply: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    };
    return Object.assign(interaction, { target });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('setChannelCommand', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        setGuildChannelMock.mockResolvedValue(undefined);
        // Default: a server part-way through setup, which is the case the
        // quick-start exists for.
        getSummonersForGuildMock.mockResolvedValue([]);
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('data', () => {
        it('has the correct command name', () => {
            expect(setChannelCommand.data.name).toBe('setchannel');
        });

        it('has a channel option', () => {
            const opt = setChannelCommand.data.options.find(
                (o: any) => o.config.name === 'channel'
            );
            expect(opt).toBeDefined();
            expect(opt.config.required).toBe(true);
        });
    });

    describe('execute', () => {
        it('calls setGuildChannel with guildId and channelId, then replies', async () => {
            const interaction = makeInteraction();
            setGuildChannelMock.mockResolvedValue(undefined);

            await setChannelCommand.execute(interaction as any);

            expect(setGuildChannelMock).toHaveBeenCalledWith(
                'guild-123',
                'channel-456'
            );
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('<#channel-456>'),
                })
            );
        });

        it('replies ephemerally', async () => {
            const interaction = makeInteraction();
            setGuildChannelMock.mockResolvedValue(undefined);

            await setChannelCommand.execute(interaction as any);

            expect(interaction.deferReply).toHaveBeenCalledWith(
                expect.objectContaining({ flags: 64 })
            );
        });

        it('posts the next step into the channel it was just given', async () => {
            // Issue #149's second acceptance point, which never shipped: setting
            // a channel is the one moment we know somebody is mid-setup and
            // looking at Discord.
            const interaction = makeInteraction();

            await setChannelCommand.execute(interaction as any);

            expect(interaction.target.send).toHaveBeenCalledWith(
                expect.objectContaining({
                    embeds: expect.arrayContaining([
                        expect.any(MockEmbedBuilder),
                    ]),
                })
            );
            const embed = interaction.target.send.mock.calls[0][0].embeds[0];
            expect(JSON.stringify(embed.data)).toContain('/add');
        });

        it('says nothing extra to a server that is already running', async () => {
            // Moving the channel on a live server is admin housekeeping, and a
            // quick-start posted into it would be addressed to nobody.
            getSummonersForGuildMock.mockResolvedValue([{ puuid: 'p1' }]);
            const interaction = makeInteraction();

            await setChannelCommand.execute(interaction as any);

            expect(interaction.target.send).not.toHaveBeenCalled();
        });

        it('reports a channel it cannot post in, rather than failing silently', async () => {
            // Otherwise the missing permission is discovered when the first
            // match ends and nothing appears.
            const interaction = makeInteraction({
                target: makeTargetChannel(false),
            });

            await setChannelCommand.execute(interaction as any);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('Send Messages'),
                })
            );
        });

        it('still sets the channel when the quick-start cannot be posted', async () => {
            // The setting is the command's job; the message is a courtesy.
            const interaction = makeInteraction({
                target: makeTargetChannel(false),
            });

            await setChannelCommand.execute(interaction as any);

            expect(setGuildChannelMock).toHaveBeenCalledWith(
                'guild-123',
                'channel-456'
            );
        });

        it('rejects with ephemeral message when guildId is null', async () => {
            const interaction = makeInteraction({ guildId: null });

            await setChannelCommand.execute(interaction as any);

            expect(setGuildChannelMock).not.toHaveBeenCalled();
            expect(interaction.reply).toHaveBeenCalledWith(
                expect.objectContaining({ flags: 64 })
            );
        });
    });
});

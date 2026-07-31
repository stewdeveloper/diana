export {};

const getGuildConfigMock = jest.fn();
const getSummonersForGuildMock = jest.fn();

class MockSlashCommandBuilder {
    public name?: string;
    setName(n: string) {
        this.name = n;
        return this;
    }
    setDescription(_d: string) {
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
    setFooter(f: Record<string, string>) {
        this.data.footer = f;
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

jest.mock('discord.js', () => ({
    SlashCommandBuilder: MockSlashCommandBuilder,
    EmbedBuilder: MockEmbedBuilder,
    MessageFlags: { Ephemeral: 64 },
}));

jest.mock('diana-core', () => ({
    getGuildConfig: getGuildConfigMock,
    getSummonersForGuild: getSummonersForGuildMock,
}));

const {
    helpCommand,
    buildHelpEmbed,
    resolveSetupStage,
} = require('../packages/diana-discord/src/plugins/diana-league-bot/discord/commands/helpCommand');

function makeInteraction(guildId: string | null = 'guild-1') {
    return {
        guildId,
        deferReply: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
    };
}

const embedOf = (interaction: ReturnType<typeof makeInteraction>) =>
    interaction.editReply.mock.calls[0][0].embeds[0].data;

/** Everything the embed says, fields and all. */
const textOf = (interaction: ReturnType<typeof makeInteraction>) =>
    JSON.stringify(embedOf(interaction));

beforeEach(() => {
    jest.clearAllMocks();
    getGuildConfigMock.mockResolvedValue({ channel_id: 'chan-1' });
    getSummonersForGuildMock.mockResolvedValue([{ puuid: 'p1' }]);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('resolveSetupStage', () => {
    it('reads no channel as the first step', () => {
        expect(resolveSetupStage(null, 0)).toBe('no-channel');
        expect(resolveSetupStage(undefined, 5)).toBe('no-channel');
    });

    it('reads a channel with nobody tracked as the second', () => {
        // A channel with no roster posts nothing, forever — which looks
        // identical to a broken bot.
        expect(resolveSetupStage('chan-1', 0)).toBe('no-players');
    });

    it('reads both as done', () => {
        expect(resolveSetupStage('chan-1', 1)).toBe('ready');
    });
});

describe('helpCommand.data', () => {
    it('is named "help"', () => {
        expect(helpCommand.data.name).toBe('help');
    });
});

describe('/help during setup', () => {
    it('shows one instruction, not a menu, before a channel is set', async () => {
        // The regression this exists to stop: 24 commands, every one of which
        // refuses to run until a channel exists, with the one that fixes that
        // buried among them.
        getGuildConfigMock.mockResolvedValue(null);
        const interaction = makeInteraction();

        await helpCommand.execute(interaction as any);

        const embed = embedOf(interaction);
        expect(embed.title).toContain('step 1 of 2');
        expect(embed.fields).toHaveLength(0);
        expect(textOf(interaction)).toContain('/setchannel');
        expect(textOf(interaction)).not.toContain('/iotw');
    });

    it('does not ask for the roster it cannot use yet', async () => {
        // An unconfigured server costs one query, not two.
        getGuildConfigMock.mockResolvedValue(null);
        await helpCommand.execute(makeInteraction() as any);
        expect(getSummonersForGuildMock).not.toHaveBeenCalled();
    });

    it('names the channel and the next command once one is set', async () => {
        getGuildConfigMock.mockResolvedValue({ channel_id: 'chan-9' });
        getSummonersForGuildMock.mockResolvedValue([]);
        const interaction = makeInteraction();

        await helpCommand.execute(interaction as any);

        const text = textOf(interaction);
        expect(embedOf(interaction).title).toContain('step 2 of 2');
        expect(text).toContain('<#chan-9>');
        expect(text).toContain('/add');
    });

    it('explains what a tag is, which is where /add actually stalls', async () => {
        getGuildConfigMock.mockResolvedValue({ channel_id: 'chan-9' });
        getSummonersForGuildMock.mockResolvedValue([]);
        const interaction = makeInteraction();

        await helpCommand.execute(interaction as any);
        expect(textOf(interaction)).toContain('#');
        expect(textOf(interaction).toLowerCase()).toContain('tag');
    });
});

describe('/help once the server is running', () => {
    it('lists the everyday commands', async () => {
        const interaction = makeInteraction();
        await helpCommand.execute(interaction as any);

        const text = textOf(interaction);
        for (const command of [
            '/summoner',
            '/leaderboard',
            '/wrapped',
            '/compare',
            '/champion',
            '/livegame',
            '/mvp',
            '/iotw',
        ]) {
            expect(text).toContain(command);
        }
    });

    it('still lists the admin commands, just not first', async () => {
        const interaction = makeInteraction();
        await helpCommand.execute(interaction as any);

        const fields = embedOf(interaction).fields;
        const text = JSON.stringify(fields);
        expect(text).toContain('/add');
        expect(text).toContain('/setchannel');
        expect(text).toContain('/config');

        // Ordering is the point: what people run daily comes before what an
        // admin runs once. The old help had this exactly backwards.
        const names = fields.map((f: any) => f.name).join(' ');
        expect(names.indexOf('Stats')).toBeLessThan(
            names.indexOf('Server settings')
        );
    });

    it('keeps the account commands on one line each', async () => {
        // `/link start`, `/link confirm` and `/link status` were three lines
        // saying there is a link command; Discord's autocomplete lists the
        // subcommands the moment you type it.
        const interaction = makeInteraction();
        await helpCommand.execute(interaction as any);

        const text = textOf(interaction);
        expect(text).toContain('/link start');
        expect(text).not.toContain('/link confirm');
        expect(text).not.toContain('/config view');
    });
});

describe('/help when things are not normal', () => {
    it('shows the reference in a DM, where there is no setup to be in', async () => {
        const interaction = makeInteraction(null);
        await helpCommand.execute(interaction as any);

        expect(embedOf(interaction).fields.length).toBeGreaterThan(0);
        expect(getGuildConfigMock).not.toHaveBeenCalled();
    });

    it('still answers when the database does not', async () => {
        // Help is what somebody runs when something is already wrong. Failing
        // here would be the worst possible moment.
        getGuildConfigMock.mockRejectedValue(new Error('db down'));
        const interaction = makeInteraction();

        await helpCommand.execute(interaction as any);

        expect(embedOf(interaction).fields.length).toBeGreaterThan(0);
    });

    it('replies exactly once', async () => {
        const interaction = makeInteraction();
        await helpCommand.execute(interaction as any);
        expect(interaction.editReply).toHaveBeenCalledTimes(1);
    });

    it('stays ephemeral, as it always was', async () => {
        // Help is for whoever asked. A setup card is an admin talking to
        // themselves, and the reference posted into a channel is noise for
        // everybody who did not run it.
        const interaction = makeInteraction();
        await helpCommand.execute(interaction as any);
        expect(interaction.deferReply).toHaveBeenCalledWith(
            expect.objectContaining({ flags: 64 })
        );
    });
});

describe('buildHelpEmbed', () => {
    it('picks the embed from the stage alone', () => {
        expect(buildHelpEmbed('no-channel').data.title).toContain('step 1');
        expect(buildHelpEmbed('no-players', 'c1').data.title).toContain(
            'step 2'
        );
        expect(buildHelpEmbed('ready').data.fields.length).toBeGreaterThan(0);
    });

    it('does not print "undefined" when a channel id is missing', () => {
        expect(JSON.stringify(buildHelpEmbed('no-players').data)).not.toContain(
            'undefined'
        );
    });
});

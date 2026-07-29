export {};

const dbQueryMock = jest.fn();
const getActiveGameMock = jest.fn();
const buildChampionIdMapMock = jest.fn();
const getQueueNameByIdMock = jest.fn();
const searchSummonerGameNamesMock = jest.fn();
const searchSummonerTagsMock = jest.fn();
const getSquadIdForGuildMock = jest.fn().mockResolvedValue('squad-1');

class MockSlashCommandStringOption {
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

class MockSlashCommandBuilder {
    public name?: string;
    public options: MockSlashCommandStringOption[] = [];
    setName(n: string) {
        this.name = n;
        return this;
    }
    setDescription(_d: string) {
        return this;
    }
    addStringOption(cb: (o: MockSlashCommandStringOption) => unknown) {
        const o = new MockSlashCommandStringOption();
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
    setURL(u: string) {
        this.data.url = u;
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
    db: { query: dbQueryMock },
    getSquadIdForGuild: getSquadIdForGuildMock,
    createLolService: () => ({ getActiveGame: getActiveGameMock }),
    buildChampionIdMap: buildChampionIdMapMock,
    getQueueNameById: getQueueNameByIdMock,
    searchSummonerGameNames: searchSummonerGameNamesMock,
    searchSummonerTags: searchSummonerTagsMock,
}));

const {
    liveGameCommand,
} = require('../packages/diana-discord/src/plugins/diana-league-bot/discord/commands/liveGameCommand');

function makeSummonerRow(overrides: Record<string, unknown> = {}) {
    return {
        puuid: 'p1',
        gameName: 'Faker',
        tagLine: 'EUW',
        region: 'EUW1',
        matchRegionPrefix: 'EUW1',
        deepLolLink: 'https://deeplol.gg/faker',
        ...overrides,
    };
}

function makeGame(overrides: Record<string, unknown> = {}) {
    return {
        gameId: 1,
        gameMode: 'CLASSIC',
        gameQueueConfigId: 420,
        gameLength: 754,
        participants: [
            { puuid: 'p1', teamId: 100, championId: 1, riotId: 'Faker#EUW' },
            { puuid: 'x2', teamId: 200, championId: 10, riotId: 'Enemy#EUW' },
        ],
        bannedChampions: [
            { championId: 20, teamId: 100, pickTurn: 1 },
            { championId: -1, teamId: 200, pickTurn: 2 },
        ],
        ...overrides,
    };
}

function makeInteraction(
    opts: { guildId?: string | null; name?: string; tag?: string | null } = {}
) {
    const { guildId = 'guild-1', name = 'Faker', tag = null } = opts;
    return {
        guildId,
        options: {
            getString: jest.fn((optName: string) =>
                optName === 'name' ? name : tag
            ),
        },
        reply: jest.fn().mockResolvedValue(undefined),
        deferReply: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
    };
}

describe('liveGameCommand', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        buildChampionIdMapMock.mockResolvedValue({
            '1': { name: 'Annie' },
            '10': { name: 'Kayle' },
            '20': { name: 'Nunu' },
        });
        getQueueNameByIdMock.mockReturnValue('Ranked Solo');
    });

    it('has name "livegame"', () => {
        expect(liveGameCommand.data.name).toBe('livegame');
    });

    it('rejects use outside a guild', async () => {
        const interaction = makeInteraction({ guildId: null });
        await liveGameCommand.execute(interaction as any);
        expect(interaction.reply).toHaveBeenCalledWith(
            expect.objectContaining({
                content: expect.stringContaining('only be used in a server'),
            })
        );
    });

    it('reports when the summoner is not tracked in this guild', async () => {
        dbQueryMock.mockResolvedValue({ rows: [] });
        const interaction = makeInteraction();

        await liveGameCommand.execute(interaction as any);

        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.stringContaining('Could not find')
        );
        expect(getActiveGameMock).not.toHaveBeenCalled();
    });

    it('asks for a tag when multiple tracked summoners share the name', async () => {
        dbQueryMock.mockResolvedValue({
            rows: [
                makeSummonerRow({ tagLine: 'EUW' }),
                makeSummonerRow({ tagLine: 'NA1' }),
            ],
        });
        const interaction = makeInteraction();

        await liveGameCommand.execute(interaction as any);

        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.stringContaining('Multiple tracked summoners')
        );
    });

    it('reports not-in-game when the spectator API returns null', async () => {
        dbQueryMock.mockResolvedValue({ rows: [makeSummonerRow()] });
        getActiveGameMock.mockResolvedValue(null);
        const interaction = makeInteraction();

        await liveGameCommand.execute(interaction as any);

        expect(getActiveGameMock).toHaveBeenCalledWith('p1', 'EUW1');
        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.stringContaining('not currently in a game')
        );
    });

    it('builds a live-game embed with both teams and bans', async () => {
        dbQueryMock.mockResolvedValue({ rows: [makeSummonerRow()] });
        getActiveGameMock.mockResolvedValue(makeGame());
        const interaction = makeInteraction();

        await liveGameCommand.execute(interaction as any);

        const reply = interaction.editReply.mock.calls[0][0];
        const embed = reply.embeds[0];
        expect(embed.data.title).toContain('Live Game');
        expect(embed.data.title).toContain('Ranked Solo');
        expect(embed.data.description).toContain('Faker#EUW');
        expect(embed.data.description).toContain('12:34');

        const blue = embed.data.fields.find(
            (f: any) => f.name === '🔵 Blue Team'
        );
        const red = embed.data.fields.find(
            (f: any) => f.name === '🔴 Red Team'
        );
        expect(blue.value).toContain('**Annie**');
        expect(red.value).toContain('Kayle');

        const bans = embed.data.fields.find((f: any) => f.name === '🚫 Bans');
        expect(bans.value).toContain('Nunu');
        expect(bans.value).not.toContain('-1');
    });

    it('replies with an error message when the lookup throws', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        dbQueryMock.mockResolvedValue({ rows: [makeSummonerRow()] });
        getActiveGameMock.mockRejectedValue(new Error('riot down'));
        const interaction = makeInteraction();

        await liveGameCommand.execute(interaction as any);

        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.stringContaining('Something went wrong')
        );
        jest.restoreAllMocks();
    });

    it('guild-scopes name autocomplete', async () => {
        searchSummonerGameNamesMock.mockResolvedValue(['Faker']);
        const interaction = {
            guildId: 'guild-9',
            options: {
                getFocused: jest.fn(() => ({ name: 'name', value: 'fa' })),
                getString: jest.fn(),
            },
            respond: jest.fn().mockResolvedValue(undefined),
            responded: false,
        };

        await liveGameCommand.autocomplete(interaction as any);

        expect(searchSummonerGameNamesMock).toHaveBeenCalledWith(
            'fa',
            25,
            'guild-9'
        );
        expect(interaction.respond).toHaveBeenCalledWith([
            { name: 'Faker', value: 'Faker' },
        ]);
    });
});

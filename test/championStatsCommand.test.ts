export {};

const getSummonerByAccountNameMock = jest.fn();
const searchSummonerGameNamesMock = jest.fn();
const searchSummonerTagsMock = jest.fn();
const dbQueryMock = jest.fn();
const fetchChampionDataMock = jest.fn();
const calculateWinRatePercentageMock = jest.fn(
    (wins: number, losses: number) => {
        const total = wins + losses;
        return total === 0 ? null : (wins / total) * 100;
    }
);
const getQueueNameByIdMock = jest.fn();

class MockSlashCommandStringOption {
    public config: Record<string, unknown> = {};

    setName(name: string) {
        this.config.name = name;
        return this;
    }

    setDescription(description: string) {
        this.config.description = description;
        return this;
    }

    setRequired(required: boolean) {
        this.config.required = required;
        return this;
    }

    setAutocomplete(autocomplete: boolean) {
        this.config.autocomplete = autocomplete;
        return this;
    }

    addChoices(...choices: Array<Record<string, unknown>>) {
        const normalized =
            Array.isArray(choices[0]) && choices.length === 1
                ? (choices[0] as Record<string, unknown>[])
                : choices;
        const existing =
            (this.config.choices as Record<string, unknown>[] | undefined) ??
            [];
        this.config.choices = [...existing, ...normalized];
        return this;
    }
}

class MockSlashCommandBuilder {
    public name?: string;
    public description?: string;
    public options: MockSlashCommandStringOption[] = [];

    setName(name: string) {
        this.name = name;
        return this;
    }

    setDescription(description: string) {
        this.description = description;
        return this;
    }

    addStringOption(
        configure: (option: MockSlashCommandStringOption) => unknown
    ) {
        const option = new MockSlashCommandStringOption();
        configure(option);
        this.options.push(option);
        return this;
    }

    addBooleanOption(
        configure: (option: MockSlashCommandStringOption) => unknown
    ) {
        const option = new MockSlashCommandStringOption();
        configure(option);
        this.options.push(option);
        return this;
    }
}

class MockEmbedBuilder {
    public data: Record<string, any>;

    constructor() {
        this.data = { fields: [] as Array<Record<string, any>> };
    }

    setTitle(title: string) {
        this.data.title = title;
        return this;
    }

    setDescription(description: string) {
        this.data.description = description;
        return this;
    }

    setColor(color: number) {
        this.data.color = color;
        return this;
    }

    addFields(...fields: Array<Record<string, any>>) {
        const normalized = Array.isArray(fields[0]) ? fields[0] : fields;
        this.data.fields = [...(this.data.fields || []), ...normalized];
        return this;
    }

    setTimestamp() {
        this.data.timestamp = 'mock-timestamp';
        return this;
    }

    setThumbnail(url: string) {
        this.data.thumbnail = { url };
        return this;
    }
}

jest.mock('twisted', () => ({
    Constants: {
        Regions: {
            EU_WEST: 'EUW',
            NORTH_AMERICA: 'NA',
        },
    },
}));

jest.mock('discord.js', () => ({
    EmbedBuilder: MockEmbedBuilder,
    SlashCommandBuilder: MockSlashCommandBuilder,
}));

jest.mock('diana-core', () => ({
    getGuildCompetitiveScope: jest.fn().mockResolvedValue('all'),
    buildCompetitiveSqlFilter: jest.requireActual(
        '../packages/diana-core/src/plugins/diana-league-bot/utils/queueClassification'
    ).buildCompetitiveSqlFilter,
    getSummonerByAccountName: getSummonerByAccountNameMock,
    searchSummonerGameNames: searchSummonerGameNamesMock,
    searchSummonerTags: searchSummonerTagsMock,
    db: { query: dbQueryMock },
    fetchChampionData: fetchChampionDataMock,
    calculateWinRatePercentage: calculateWinRatePercentageMock,
    getQueueNameById: getQueueNameByIdMock,
    getChampionThumbnail: jest
        .fn()
        .mockImplementation((championName: string) =>
            Promise.resolve(`https://example.com/${championName}.png`)
        ),
}));

const {
    championStatsCommand,
} = require('../packages/diana-discord/src/plugins/diana-league-bot/discord/commands/championStatsCommand');

// Summoner fixture
function makeSummoner(overrides: Record<string, unknown> = {}) {
    return {
        puuid: 'test-puuid',
        gameName: 'Faker',
        tagLine: 'EUW',
        deepLolLink: 'https://deep.lol/summoner/faker',
        ...overrides,
    };
}

// Match row with a participant fixture for Ahri
function makeMatchRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        matchId: 'match-1',
        queueId: 420,
        gameDuration: 1800,
        gameCreation: Date.now(),
        participants: [
            {
                puuid: 'test-puuid',
                championName: 'Ahri',
                kills: 8,
                deaths: 2,
                assists: 10,
                win: true,
                totalDamageDealtToChampions: 25000,
                totalMinionsKilled: 180,
                neutralMinionsKilled: 20,
                goldEarned: 12000,
            },
        ],
        ...overrides,
    };
}

// Default champion data map returned by fetchChampionData
const defaultChampions = {
    Ahri: { id: 'Ahri', name: 'Ahri' },
    Zed: { id: 'Zed', name: 'Zed' },
};

describe('championStatsCommand', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        fetchChampionDataMock.mockResolvedValue(defaultChampions);
        getQueueNameByIdMock.mockReturnValue('Ranked Solo');
        getSummonerByAccountNameMock.mockResolvedValue(null);
        dbQueryMock.mockResolvedValue({ rows: [] });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('data', () => {
        it('has the correct command name', () => {
            expect(championStatsCommand.data.name).toBe('champion');
        });

        it('has a non-empty description', () => {
            expect(typeof championStatsCommand.data.description).toBe('string');
            expect(
                championStatsCommand.data.description.length
            ).toBeGreaterThan(0);
        });

        it('registers a required "name" option with autocomplete', () => {
            const nameOpt = championStatsCommand.data.options.find(
                (o: any) => o.config.name === 'name'
            );
            expect(nameOpt).toBeDefined();
            expect(nameOpt.config.required).toBe(true);
            expect(nameOpt.config.autocomplete).toBe(true);
        });

        it('registers a required "champion" option with autocomplete', () => {
            const championOpt = championStatsCommand.data.options.find(
                (o: any) => o.config.name === 'champion'
            );
            expect(championOpt).toBeDefined();
            expect(championOpt.config.required).toBe(true);
            expect(championOpt.config.autocomplete).toBe(true);
        });

        it('registers an optional "tag" option with autocomplete', () => {
            const tagOpt = championStatsCommand.data.options.find(
                (o: any) => o.config.name === 'tag'
            );
            expect(tagOpt).toBeDefined();
            expect(tagOpt.config.required).toBe(false);
            expect(tagOpt.config.autocomplete).toBe(true);
        });
    });

    describe('execute', () => {
        it('calls deferReply before doing any work', async () => {
            dbQueryMock.mockResolvedValue({ rows: [] });

            const interaction = {
                options: {
                    getBoolean: jest.fn(() => null),
                    getString: jest.fn((key: string, _required?: boolean) => {
                        if (key === 'name') return 'Faker';
                        if (key === 'champion') return 'Ahri';
                        return null;
                    }),
                },
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await championStatsCommand.execute(interaction as any);

            expect(interaction.deferReply).toHaveBeenCalledTimes(1);
        });

        it('returns "not found" when summoner does not exist (tag provided, null result)', async () => {
            getSummonerByAccountNameMock.mockResolvedValue(null);

            const interaction = {
                options: {
                    getBoolean: jest.fn(() => null),
                    getString: jest.fn((key: string, _required?: boolean) => {
                        if (key === 'name') return 'Ghost';
                        if (key === 'champion') return 'Ahri';
                        if (key === 'tag') return 'EUW';
                        return null;
                    }),
                },
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await championStatsCommand.execute(interaction as any);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringMatching(/Ghost/)
            );
            // Should not try to query champion matches
            expect(dbQueryMock).not.toHaveBeenCalled();
        });

        it('returns "not found" when no summoner row in db (no tag, empty db result)', async () => {
            // No tag → findSummonersByNameAndRegion path
            dbQueryMock.mockResolvedValueOnce({ rows: [] });

            const interaction = {
                options: {
                    getBoolean: jest.fn(() => null),
                    getString: jest.fn((key: string, _required?: boolean) => {
                        if (key === 'name') return 'NoOne';
                        if (key === 'champion') return 'Ahri';
                        return null; // no tag
                    }),
                },
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await championStatsCommand.execute(interaction as any);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringMatching(/NoOne/)
            );
        });

        it('shows disambiguation message when multiple summoners match the name', async () => {
            // No tag → multiple rows returned
            dbQueryMock.mockResolvedValueOnce({
                rows: [
                    { gameName: 'Faker', tagLine: 'EUW' },
                    { gameName: 'Faker', tagLine: 'KR' },
                ],
            });

            const interaction = {
                options: {
                    getBoolean: jest.fn(() => null),
                    getString: jest.fn((key: string, _required?: boolean) => {
                        if (key === 'name') return 'Faker';
                        if (key === 'champion') return 'Ahri';
                        return null;
                    }),
                },
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await championStatsCommand.execute(interaction as any);

            const reply = interaction.editReply.mock.calls[0][0] as string;
            expect(reply).toContain('Multiple');
            expect(reply).toContain('Faker');
        });

        it('returns "no matches" when summoner is found but has no champion data', async () => {
            getSummonerByAccountNameMock.mockResolvedValue(makeSummoner());
            // db returns no rows for champion matches
            dbQueryMock.mockResolvedValue({ rows: [] });

            const interaction = {
                options: {
                    getBoolean: jest.fn(() => null),
                    getString: jest.fn((key: string, _required?: boolean) => {
                        if (key === 'name') return 'Faker';
                        if (key === 'champion') return 'Ahri';
                        if (key === 'tag') return 'EUW';
                        return null;
                    }),
                },
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await championStatsCommand.execute(interaction as any);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringMatching(/No recorded matches/)
            );
        });

        it('renders an embed with correct fields when summoner and champion data are found', async () => {
            getSummonerByAccountNameMock.mockResolvedValue(makeSummoner());
            dbQueryMock.mockResolvedValue({ rows: [makeMatchRow()] });

            const interaction = {
                options: {
                    getBoolean: jest.fn(() => null),
                    getString: jest.fn((key: string, _required?: boolean) => {
                        if (key === 'name') return 'Faker';
                        if (key === 'champion') return 'Ahri';
                        if (key === 'tag') return 'EUW';
                        return null;
                    }),
                },
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await championStatsCommand.execute(interaction as any);

            const call = interaction.editReply.mock.calls[0][0];
            expect(call).toHaveProperty('embeds');
            expect(call.embeds).toHaveLength(1);

            const embed = call.embeds[0];
            expect(embed.data.title).toContain('Faker');
            expect(embed.data.title).toContain('Ahri');
        });

        it('embed includes Overview, Performance, Damage & Economy, and Recent Games fields', async () => {
            getSummonerByAccountNameMock.mockResolvedValue(makeSummoner());
            dbQueryMock.mockResolvedValue({ rows: [makeMatchRow()] });

            const interaction = {
                options: {
                    getBoolean: jest.fn(() => null),
                    getString: jest.fn((key: string, _required?: boolean) => {
                        if (key === 'name') return 'Faker';
                        if (key === 'champion') return 'Ahri';
                        if (key === 'tag') return 'EUW';
                        return null;
                    }),
                },
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await championStatsCommand.execute(interaction as any);

            const embed = interaction.editReply.mock.calls[0][0].embeds[0];
            const fieldNames = embed.data.fields.map((f: any) => f.name);
            expect(fieldNames).toContain('Overview');
            expect(fieldNames).toContain('Performance');
            expect(fieldNames).toContain('Damage & Economy');
            expect(fieldNames).toContain('Recent Games');
        });

        it('sets a thumbnail with the champion icon URL', async () => {
            getSummonerByAccountNameMock.mockResolvedValue(makeSummoner());
            dbQueryMock.mockResolvedValue({ rows: [makeMatchRow()] });

            const interaction = {
                options: {
                    getBoolean: jest.fn(() => null),
                    getString: jest.fn((key: string, _required?: boolean) => {
                        if (key === 'name') return 'Faker';
                        if (key === 'champion') return 'Ahri';
                        if (key === 'tag') return 'EUW';
                        return null;
                    }),
                },
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await championStatsCommand.execute(interaction as any);

            const embed = interaction.editReply.mock.calls[0][0].embeds[0];
            expect(embed.data.thumbnail.url).toContain('Ahri');
        });

        it('replies with error message when an exception is thrown', async () => {
            getSummonerByAccountNameMock.mockRejectedValue(
                new Error('Network error')
            );

            const interaction = {
                options: {
                    getBoolean: jest.fn(() => null),
                    getString: jest.fn((key: string, _required?: boolean) => {
                        if (key === 'name') return 'Faker';
                        if (key === 'champion') return 'Ahri';
                        if (key === 'tag') return 'EUW';
                        return null;
                    }),
                },
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await championStatsCommand.execute(interaction as any);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringMatching(/went wrong/i)
            );
        });
    });

    describe('autocomplete', () => {
        it('responds with summoner game name suggestions when "name" is focused', async () => {
            const interaction = {
                guildId: 'guild-123',
                options: {
                    getFocused: jest.fn(() => ({ name: 'name', value: 'fa' })),
                    getString: jest.fn(),
                },
                respond: jest.fn().mockResolvedValue(undefined),
                responded: false,
            };

            searchSummonerGameNamesMock.mockResolvedValue(['Faker', 'Fariq']);

            await championStatsCommand.autocomplete(interaction as any);

            expect(searchSummonerGameNamesMock).toHaveBeenCalledWith(
                'fa',
                25,
                'guild-123'
            );
            expect(interaction.respond).toHaveBeenCalledWith([
                { name: 'Faker', value: 'Faker' },
                { name: 'Fariq', value: 'Fariq' },
            ]);
        });

        it('responds with tag suggestions (with region label) when "tag" is focused', async () => {
            const interaction = {
                guildId: 'guild-123',
                options: {
                    getFocused: jest.fn(() => ({ name: 'tag', value: 'eu' })),
                    getString: jest.fn(() => 'Faker'),
                },
                respond: jest.fn().mockResolvedValue(undefined),
                responded: false,
            };

            searchSummonerTagsMock.mockResolvedValue([
                { tagLine: 'EUW', matchRegionPrefix: 'Europe' },
                { tagLine: 'EUNE', matchRegionPrefix: null },
            ]);

            await championStatsCommand.autocomplete(interaction as any);

            expect(searchSummonerTagsMock).toHaveBeenCalledWith(
                'Faker',
                'eu',
                25,
                'guild-123'
            );
            expect(interaction.respond).toHaveBeenCalledWith([
                { name: 'EUW (Europe)', value: 'EUW' },
                { name: 'EUNE', value: 'EUNE' },
            ]);
        });

        it('responds with champion name suggestions filtered by the typed value when "champion" is focused', async () => {
            fetchChampionDataMock.mockResolvedValue({
                Ahri: { id: 'Ahri', name: 'Ahri' },
                Zed: { id: 'Zed', name: 'Zed' },
                Azir: { id: 'Azir', name: 'Azir' },
            });

            const interaction = {
                options: {
                    getFocused: jest.fn(() => ({
                        name: 'champion',
                        value: 'a',
                    })),
                    getString: jest.fn(),
                },
                respond: jest.fn().mockResolvedValue(undefined),
                responded: false,
            };

            await championStatsCommand.autocomplete(interaction as any);

            const responded = interaction.respond.mock.calls[0][0];
            // "Ahri" and "Azir" both contain "a", "Zed" does not
            expect(responded).toEqual(
                expect.arrayContaining([
                    { name: 'Ahri', value: 'Ahri' },
                    { name: 'Azir', value: 'Azir' },
                ])
            );
            expect(responded).not.toContainEqual({ name: 'Zed', value: 'Zed' });
        });

        it('responds with empty array when focused option name is unknown', async () => {
            const interaction = {
                options: {
                    getFocused: jest.fn(() => ({
                        name: 'unknown_field',
                        value: '',
                    })),
                    getString: jest.fn(),
                },
                respond: jest.fn().mockResolvedValue(undefined),
                responded: false,
            };

            await championStatsCommand.autocomplete(interaction as any);

            expect(interaction.respond).toHaveBeenCalledWith([]);
        });

        it('responds with empty array on autocomplete error (if not yet responded)', async () => {
            searchSummonerGameNamesMock.mockRejectedValue(
                new Error('Search failure')
            );

            const interaction = {
                options: {
                    getFocused: jest.fn(() => ({ name: 'name', value: 'fa' })),
                    getString: jest.fn(),
                },
                respond: jest.fn().mockResolvedValue(undefined),
                responded: false,
            };

            await championStatsCommand.autocomplete(interaction as any);

            expect(interaction.respond).toHaveBeenCalledWith([]);
        });
    });
});

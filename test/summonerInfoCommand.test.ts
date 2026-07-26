export {};

const getRankEntriesByPUUIDMock = jest.fn();
const mockRankColors = new Map<string, number>([
    ['UNRANKED', 0x95a5a6],
    ['GOLD', 0xffd700],
]);
const getRankedEmblemMock = jest.fn();
const getQueueNameByIdMock = jest.fn();
const getSummonerByAccountNameMock = jest.fn();
const searchSummonerGameNamesMock = jest.fn();
const searchSummonerTagsMock = jest.fn();
const getMostRecentRankByParticipantIdAndQueueTypeMock = jest.fn();
const getInterCandidatesLastWeekMock = jest.fn();
const fetchRankHistoryMock = jest.fn().mockResolvedValue([]);
const dbQueryMock = jest.fn();

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
        Divisions: {
            I: 'I',
            II: 'II',
            III: 'III',
            IV: 'IV',
        },
    },
}));

jest.mock('discord.js', () => ({
    EmbedBuilder: MockEmbedBuilder,
    SlashCommandBuilder: MockSlashCommandBuilder,
}));

jest.mock('diana-core', () => ({
    getGuildCompetitiveScope: jest.fn().mockResolvedValue('all'),
    countsForCompetition: jest.requireActual(
        '../packages/diana-core/src/plugins/diana-league-bot/utils/queueClassification'
    ).countsForCompetition,
    getSummonerByAccountName: getSummonerByAccountNameMock,
    searchSummonerGameNames: searchSummonerGameNamesMock,
    searchSummonerTags: searchSummonerTagsMock,
    getMostRecentRankByParticipantIdAndQueueType:
        getMostRecentRankByParticipantIdAndQueueTypeMock,
    db: { query: dbQueryMock },
    calculateWinRatePercentage: (wins: number, losses: number) => {
        const total = wins + losses;
        return total === 0 ? null : (wins / total) * 100;
    },
    createLolService: jest.fn(() => ({
        getRankEntriesByPUUID: getRankEntriesByPUUIDMock,
    })),
    getQueueNameById: getQueueNameByIdMock,
    rankColors: mockRankColors,
    getRankedEmblem: getRankedEmblemMock,
    getInterCandidatesLastWeek: getInterCandidatesLastWeekMock,
    fetchRankHistory: fetchRankHistoryMock,
    getTotalPoints: (tier: string, division: string, lp: number) => {
        const tiers = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM'];
        const divisions: Record<string, number> = {
            IV: 1,
            III: 2,
            II: 3,
            I: 4,
        };
        const tierValue = tiers.indexOf(tier?.toUpperCase?.() ?? '');
        const divisionValue = divisions[division?.toUpperCase?.() ?? ''] ?? -1;
        if (tierValue === -1 || divisionValue === -1) return null;
        return tierValue * 400 + divisionValue * 100 + lp;
    },
    buildSparkline: (values: number[]) => '▁▄█'.slice(0, values.length),
    parseParticipants: jest.fn((p: unknown) =>
        Array.isArray(p) ? p : JSON.parse(p as string)
    ),
    ONE_WEEK_IN_MS: 604800000,
}));

const {
    summonerInfoCommand,
} = require('../packages/diana-discord/src/plugins/diana-league-bot/discord/commands/summonerInfoCommand');

describe('summonerInfoCommand', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        dbQueryMock.mockReset();
        getRankEntriesByPUUIDMock.mockReset();
        getRankedEmblemMock.mockReset();
        getQueueNameByIdMock.mockReset();
        getInterCandidatesLastWeekMock.mockResolvedValue([]);
        getRankedEmblemMock.mockReturnValue('https://emblem.example/gold.png');
        getQueueNameByIdMock.mockReturnValue('Ranked Solo');
        getRankEntriesByPUUIDMock.mockResolvedValue([]);
    });

    describe('execute', () => {
        it('renders embed with fallback values when solo rank data is missing', async () => {
            const interaction = {
                options: {
                    getString: jest.fn((key: string) => {
                        if (key === 'name') return 'Faker';
                        if (key === 'tag') return 'NA1';
                        if (key === 'region') return 'EUW';
                        return null;
                    }),
                },
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            const now = Date.now();

            getSummonerByAccountNameMock.mockResolvedValue({
                puuid: 'test-puuid',
                gameName: 'Faker',
                tagLine: 'NA1',
                deepLolLink: 'https://deep.lol/summoner/faker',
            });

            getMostRecentRankByParticipantIdAndQueueTypeMock.mockImplementation(
                async (_puuid: string, queueType: string) => {
                    if (queueType === 'RANKED_SOLO_5x5') {
                        return {
                            queueType,
                            tier: null,
                            rank: undefined,
                            lp: null,
                            season: 2024,
                        };
                    }
                    return {
                        queueType,
                        tier: 'GOLD',
                        rank: 'I',
                        lp: 80,
                        season: 2024,
                    };
                }
            );

            dbQueryMock.mockResolvedValue({
                rows: [
                    {
                        matchId: 'match-1',
                        gameCreation: now,
                        gameDuration: 1800,
                        queueId: 420,
                        participants: [
                            {
                                puuid: 'test-puuid',
                                win: true,
                                kills: 10,
                                deaths: 2,
                                assists: 9,
                                championName: 'Ahri',
                                summonerLevel: 560,
                            },
                        ],
                    },
                ],
            });

            await summonerInfoCommand.execute(interaction as any);

            expect(interaction.deferReply).toHaveBeenCalledTimes(1);
            expect(getSummonerByAccountNameMock).toHaveBeenCalledWith(
                'Faker',
                'NA1',
                'EUW'
            );

            const editReplyPayload = interaction.editReply.mock.calls[0][0];
            expect(editReplyPayload.embeds).toHaveLength(1);

            const embedData = editReplyPayload.embeds[0].data;
            expect(embedData.fields).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        name: 'Ranked Solo/Duo',
                        value: '• UNRANKED N/A (0 LP)',
                    }),
                    expect.objectContaining({
                        name: 'Ranked Flex',
                        value: '• GOLD I (80 LP)',
                    }),
                ])
            );

            expect(embedData.color).toBe(mockRankColors.get('GOLD'));
            expect(embedData.thumbnail).toEqual({
                url: 'https://emblem.example/gold.png',
            });
            expect(getQueueNameByIdMock).toHaveBeenCalledWith(420);
        });

        it('returns a not-found response when the summoner is missing', async () => {
            const interaction = {
                options: {
                    getString: jest.fn((key: string) => {
                        if (key === 'name') return 'Unknown';
                        if (key === 'tag') return 'EUW';
                        if (key === 'region') return 'EUW';
                        return null;
                    }),
                },
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            getSummonerByAccountNameMock.mockResolvedValue(null);

            await summonerInfoCommand.execute(interaction as any);

            expect(interaction.editReply).toHaveBeenCalledWith(
                'Could not find **Unknown#EUW** in region EUW.'
            );
            expect(
                getMostRecentRankByParticipantIdAndQueueTypeMock
            ).not.toHaveBeenCalled();
            expect(dbQueryMock).not.toHaveBeenCalled();
        });
    });

    describe('autocomplete', () => {
        it('responds with game name suggestions when name option is focused', async () => {
            const interaction = {
                options: {
                    getFocused: jest.fn(() => ({ name: 'name', value: 'fa' })),
                },
                respond: jest.fn().mockResolvedValue(undefined),
            };

            searchSummonerGameNamesMock.mockResolvedValue([
                'Faker',
                'Fabulous',
            ]);

            await summonerInfoCommand.autocomplete(interaction as any);

            expect(searchSummonerGameNamesMock).toHaveBeenCalledWith(
                'fa',
                25,
                undefined
            );
            expect(interaction.respond).toHaveBeenCalledWith([
                { name: 'Faker', value: 'Faker' },
                { name: 'Fabulous', value: 'Fabulous' },
            ]);
        });

        it('responds with tag suggestions when tag option is focused', async () => {
            const interaction = {
                options: {
                    getFocused: jest.fn(() => ({ name: 'tag', value: 'eu' })),
                    getString: jest.fn(() => 'Faker'),
                },
                respond: jest.fn().mockResolvedValue(undefined),
            };

            searchSummonerTagsMock.mockResolvedValue([
                { tagLine: 'EUW', matchRegionPrefix: 'Europe' },
                { tagLine: 'EUNE', matchRegionPrefix: null },
            ]);

            await summonerInfoCommand.autocomplete(interaction as any);

            expect(searchSummonerTagsMock).toHaveBeenCalledWith(
                'Faker',
                'eu',
                25,
                undefined
            );
            expect(interaction.respond).toHaveBeenCalledWith([
                { name: 'EUW (Europe)', value: 'EUW' },
                { name: 'EUNE', value: 'EUNE' },
            ]);
        });
    });
});

export {};

const getInterCandidatesLastWeekMock = jest.fn();

class MockSlashCommandBuilder {
    public name?: string;
    public description?: string;

    setName(name: string) {
        this.name = name;
        return this;
    }

    setDescription(description: string) {
        this.description = description;
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

    setFooter(footer: Record<string, unknown>) {
        this.data.footer = footer;
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

jest.mock('discord.js', () => ({
    EmbedBuilder: MockEmbedBuilder,
    SlashCommandBuilder: MockSlashCommandBuilder,
}));

jest.mock('diana-core', () => ({
    getGuildCompetitiveScope: jest.fn().mockResolvedValue('all'),
    getInterCandidatesLastWeek: getInterCandidatesLastWeekMock,
    backfillMissingScores: jest.fn().mockResolvedValue(0),
    ONE_WEEK_IN_MS: 7 * 24 * 60 * 60 * 1000,
}));

const {
    interOfTheWeekCommand,
} = require('../packages/diana-discord/src/plugins/diana-league-bot/discord/commands/interOfTheWeekCommand');

// Minimal valid InterCandidate fixture
function makeCandidate(overrides: Record<string, unknown> = {}) {
    return {
        puuid: 'puuid-1',
        displayName: 'TestPlayer',
        deepLolLink: null,
        avgDamage: 10000,
        kdaRatio: 2.5,
        winRate: 0.5,
        matchesPlayed: 5,
        avgVisionScore: 20,
        wins: 3,
        losses: 2,
        totalKills: 15,
        totalDeaths: 6,
        totalAssists: 10,
        avgAiScore: 45.0,
        scoredMatchesCount: 5,
        ...overrides,
    };
}

describe('interOfTheWeekCommand', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('data', () => {
        it('has name "iotw"', () => {
            expect(interOfTheWeekCommand.data.name).toBe('iotw');
        });

        it('has a non-empty description', () => {
            expect(typeof interOfTheWeekCommand.data.description).toBe(
                'string'
            );
            expect(
                interOfTheWeekCommand.data.description.length
            ).toBeGreaterThan(0);
        });

        it('does not have any required options (command has no options)', () => {
            // The iotw command takes no user-facing options
            expect(interOfTheWeekCommand.data.options ?? []).toHaveLength(0);
        });
    });

    describe('execute', () => {
        it('calls deferReply before any heavy work', async () => {
            getInterCandidatesLastWeekMock.mockResolvedValue([]);

            const interaction = {
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await interOfTheWeekCommand.execute(interaction as any);

            expect(interaction.deferReply).toHaveBeenCalledTimes(1);
        });

        it('replies with a "no matches" message when candidates list is empty', async () => {
            getInterCandidatesLastWeekMock.mockResolvedValue([]);

            const interaction = {
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await interOfTheWeekCommand.execute(interaction as any);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringMatching(/no matches/i)
            );
        });

        it('replies with an embed when candidates are present', async () => {
            getInterCandidatesLastWeekMock.mockResolvedValue([makeCandidate()]);

            const interaction = {
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await interOfTheWeekCommand.execute(interaction as any);

            const call = interaction.editReply.mock.calls[0][0];
            expect(call).toHaveProperty('embeds');
            expect(call.embeds).toHaveLength(1);
        });

        it('embed title contains "Inter Of the Week"', async () => {
            getInterCandidatesLastWeekMock.mockResolvedValue([makeCandidate()]);

            const interaction = {
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await interOfTheWeekCommand.execute(interaction as any);

            const embed = interaction.editReply.mock.calls[0][0].embeds[0];
            expect(embed.data.title).toContain('Inter Of the Week');
        });

        it('embed description crowns the single candidate when there is only one', async () => {
            const candidate = makeCandidate({
                displayName: 'FakeCrowned',
                matchesPlayed: 10,
            });
            getInterCandidatesLastWeekMock.mockResolvedValue([candidate]);

            const interaction = {
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await interOfTheWeekCommand.execute(interaction as any);

            const embed = interaction.editReply.mock.calls[0][0].embeds[0];
            expect(embed.data.description).toContain('FakeCrowned');
        });

        it('embed includes a Fun Stats field', async () => {
            getInterCandidatesLastWeekMock.mockResolvedValue([makeCandidate()]);

            const interaction = {
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await interOfTheWeekCommand.execute(interaction as any);

            const embed = interaction.editReply.mock.calls[0][0].embeds[0];
            const statsField = embed.data.fields.find(
                (f: any) => f.name === 'Fun Stats'
            );
            expect(statsField).toBeDefined();
        });

        it('crowns the candidate with the lowest average AI score', async () => {
            const bad = makeCandidate({
                puuid: 'puuid-bad',
                displayName: 'InterPlayer',
                avgAiScore: 20.0,
                scoredMatchesCount: 5,
            });
            const good = makeCandidate({
                puuid: 'puuid-good',
                displayName: 'GoodPlayer',
                avgAiScore: 75.0,
                scoredMatchesCount: 5,
            });

            getInterCandidatesLastWeekMock.mockResolvedValue([good, bad]);

            const interaction = {
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await interOfTheWeekCommand.execute(interaction as any);

            const embed = interaction.editReply.mock.calls[0][0].embeds[0];
            expect(embed.data.description).toContain('InterPlayer');
            expect(embed.data.description).not.toContain('GoodPlayer');
        });

        it('shows "no scored matches" message when no candidates have AI scores', async () => {
            const candidate = makeCandidate({
                scoredMatchesCount: 0,
                avgAiScore: 0,
            });
            getInterCandidatesLastWeekMock.mockResolvedValue([candidate]);

            const interaction = {
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await interOfTheWeekCommand.execute(interaction as any);

            const embed = interaction.editReply.mock.calls[0][0].embeds[0];
            expect(embed.data.description).toMatch(/no scored matches/i);
        });

        it('replies with an error message when getInterCandidatesLastWeek throws', async () => {
            getInterCandidatesLastWeekMock.mockRejectedValue(
                new Error('DB failure')
            );

            const interaction = {
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await interOfTheWeekCommand.execute(interaction as any);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringMatching(/went wrong/i)
            );
        });

        it('includes a Leaderboard field when candidates have scored matches', async () => {
            getInterCandidatesLastWeekMock.mockResolvedValue([makeCandidate()]);

            const interaction = {
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await interOfTheWeekCommand.execute(interaction as any);

            const embed = interaction.editReply.mock.calls[0][0].embeds[0];
            const leaderboard = embed.data.fields.find(
                (f: any) => f.name === 'Leaderboard'
            );
            expect(leaderboard).toBeDefined();
        });

        it('leaderboard lists winner first with crown, then runners-up sorted by avgAiScore', async () => {
            const players = [
                makeCandidate({
                    puuid: 'p1',
                    displayName: 'Alpha',
                    avgAiScore: 60,
                }),
                makeCandidate({
                    puuid: 'p2',
                    displayName: 'Beta',
                    avgAiScore: 30,
                }),
                makeCandidate({
                    puuid: 'p3',
                    displayName: 'Gamma',
                    avgAiScore: 50,
                }),
            ];
            getInterCandidatesLastWeekMock.mockResolvedValue(players);

            const interaction = {
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await interOfTheWeekCommand.execute(interaction as any);

            const embed = interaction.editReply.mock.calls[0][0].embeds[0];
            const leaderboard = embed.data.fields.find(
                (f: any) => f.name === 'Leaderboard'
            );
            const lines: string[] = leaderboard.value.split('\n');
            expect(lines[0]).toContain('Beta');
            expect(lines[1]).toContain('Gamma');
            expect(lines[2]).toContain('Alpha');
        });

        it('leaderboard caps at winner + 5 runners-up', async () => {
            const players = Array.from({ length: 8 }, (_, i) =>
                makeCandidate({
                    puuid: `p${i}`,
                    displayName: `Player${i}`,
                    avgAiScore: i * 10,
                })
            );
            getInterCandidatesLastWeekMock.mockResolvedValue(players);

            const interaction = {
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await interOfTheWeekCommand.execute(interaction as any);

            const embed = interaction.editReply.mock.calls[0][0].embeds[0];
            const leaderboard = embed.data.fields.find(
                (f: any) => f.name === 'Leaderboard'
            );
            expect(leaderboard.value.split('\n')).toHaveLength(6);
        });

        it('leaderboard is absent when no candidates have scored matches', async () => {
            getInterCandidatesLastWeekMock.mockResolvedValue([
                makeCandidate({ scoredMatchesCount: 0, avgAiScore: 0 }),
            ]);

            const interaction = {
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await interOfTheWeekCommand.execute(interaction as any);

            const embed = interaction.editReply.mock.calls[0][0].embeds[0];
            const leaderboard = embed.data.fields.find(
                (f: any) => f.name === 'Leaderboard'
            );
            expect(leaderboard).toBeUndefined();
        });

        it('includes the candidate display name in the Fun Stats field value', async () => {
            const candidate = makeCandidate({
                displayName: 'StatsTarget',
                matchesPlayed: 5,
            });
            getInterCandidatesLastWeekMock.mockResolvedValue([candidate]);

            const interaction = {
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await interOfTheWeekCommand.execute(interaction as any);

            const embed = interaction.editReply.mock.calls[0][0].embeds[0];
            const statsField = embed.data.fields.find(
                (f: any) => f.name === 'Fun Stats'
            );
            expect(statsField.value).toContain('StatsTarget');
        });

        it('uses a deepLolLink as a hyperlink in the embed when available', async () => {
            const candidate = makeCandidate({
                displayName: 'LinkedPlayer',
                deepLolLink: 'https://deep.lol/summoner/linked',
                matchesPlayed: 5,
            });
            getInterCandidatesLastWeekMock.mockResolvedValue([candidate]);

            const interaction = {
                deferReply: jest.fn().mockResolvedValue(undefined),
                editReply: jest.fn().mockResolvedValue(undefined),
            };

            await interOfTheWeekCommand.execute(interaction as any);

            const embed = interaction.editReply.mock.calls[0][0].embeds[0];
            expect(embed.data.description).toContain(
                'https://deep.lol/summoner/linked'
            );
        });
    });
});

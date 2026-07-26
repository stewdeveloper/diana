export {};

const getInterCandidatesLastWeekMock = jest.fn();
const backfillMissingScoresMock = jest.fn().mockResolvedValue(0);

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
}

jest.mock('discord.js', () => ({
    EmbedBuilder: MockEmbedBuilder,
    SlashCommandBuilder: MockSlashCommandBuilder,
}));

jest.mock('diana-core', () => ({
    getGuildCompetitiveScope: jest.fn().mockResolvedValue('all'),
    getInterCandidatesLastWeek: getInterCandidatesLastWeekMock,
    backfillMissingScores: backfillMissingScoresMock,
    ONE_WEEK_IN_MS: 7 * 24 * 60 * 60 * 1000,
}));

const {
    mvpOfTheWeekCommand,
} = require('../packages/diana-discord/src/plugins/diana-league-bot/discord/commands/mvpOfTheWeekCommand');

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

function makeInteraction(guildId: string | null = 'guild-1') {
    return {
        guildId,
        deferReply: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
    };
}

describe('mvpOfTheWeekCommand', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        backfillMissingScoresMock.mockResolvedValue(0);
    });

    describe('data', () => {
        it('has name "mvp"', () => {
            expect(mvpOfTheWeekCommand.data.name).toBe('mvp');
        });
    });

    describe('execute', () => {
        it('passes the guildId and competitive scope through to the stats query', async () => {
            getInterCandidatesLastWeekMock.mockResolvedValue([makeCandidate()]);
            const interaction = makeInteraction('guild-42');

            await mvpOfTheWeekCommand.execute(interaction as any);

            expect(getInterCandidatesLastWeekMock).toHaveBeenCalledWith({
                guildId: 'guild-42',
                scope: 'all',
            });
        });

        it('crowns the candidate with the HIGHEST average AI score', async () => {
            const best = makeCandidate({
                puuid: 'best',
                displayName: 'Carry',
                avgAiScore: 88,
            });
            const worst = makeCandidate({
                puuid: 'worst',
                displayName: 'Inter',
                avgAiScore: 12,
            });
            getInterCandidatesLastWeekMock.mockResolvedValue([worst, best]);
            const interaction = makeInteraction();

            await mvpOfTheWeekCommand.execute(interaction as any);

            const reply = interaction.editReply.mock.calls[0][0];
            const embed = reply.embeds[0];
            expect(embed.data.description).toContain('Carry');
            expect(embed.data.description).toContain('88');
            expect(embed.data.description).not.toContain('Inter');
        });

        it('sorts the leaderboard descending by AI score', async () => {
            const a = makeCandidate({
                puuid: 'a',
                displayName: 'Alpha',
                avgAiScore: 70,
            });
            const b = makeCandidate({
                puuid: 'b',
                displayName: 'Beta',
                avgAiScore: 90,
            });
            getInterCandidatesLastWeekMock.mockResolvedValue([a, b]);
            const interaction = makeInteraction();

            await mvpOfTheWeekCommand.execute(interaction as any);

            const reply = interaction.editReply.mock.calls[0][0];
            const embed = reply.embeds[0];
            const leaderboard = embed.data.fields.find(
                (f: any) => f.name === 'Leaderboard'
            );
            const betaIndex = leaderboard.value.indexOf('Beta');
            const alphaIndex = leaderboard.value.indexOf('Alpha');
            expect(betaIndex).toBeGreaterThanOrEqual(0);
            expect(betaIndex).toBeLessThan(alphaIndex);
        });

        it('replies with an empty-state message when no matches exist', async () => {
            getInterCandidatesLastWeekMock.mockResolvedValue([]);
            const interaction = makeInteraction();

            await mvpOfTheWeekCommand.execute(interaction as any);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('No matches found')
            );
        });

        it('backfills scores when fewer than 5 scored matches exist', async () => {
            const unscored = makeCandidate({
                scoredMatchesCount: 1,
            });
            getInterCandidatesLastWeekMock.mockResolvedValue([unscored]);
            backfillMissingScoresMock.mockResolvedValue(3);
            const interaction = makeInteraction();

            await mvpOfTheWeekCommand.execute(interaction as any);

            expect(backfillMissingScoresMock).toHaveBeenCalled();
            expect(getInterCandidatesLastWeekMock).toHaveBeenCalledTimes(2);
        });

        it('replies with an error message when the query throws', async () => {
            jest.spyOn(console, 'error').mockImplementation(() => undefined);
            getInterCandidatesLastWeekMock.mockRejectedValue(
                new Error('db down')
            );
            const interaction = makeInteraction();

            await mvpOfTheWeekCommand.execute(interaction as any);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('Something went wrong')
            );
            jest.restoreAllMocks();
        });
    });
});

export {};

const getSummonersForGuildMock = jest.fn();
const getLatestRanksForPuuidsMock = jest.fn();
const getInterCandidatesLastWeekMock = jest.fn();

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
    public options: MockStringOption[] = [];
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
    setDescription(d: string) {
        this.data.description = d;
        return this;
    }
    setColor(c: number) {
        this.data.color = c;
        return this;
    }
    setFooter(f: Record<string, unknown>) {
        this.data.footer = f;
        return this;
    }
    setTimestamp() {
        return this;
    }
}

jest.mock('discord.js', () => ({
    SlashCommandBuilder: MockSlashCommandBuilder,
    EmbedBuilder: MockEmbedBuilder,
    MessageFlags: { Ephemeral: 64 },
}));

function getTotalPointsImpl(
    tier: string,
    division: string,
    lp: number
): number | null {
    const tiers = [
        'IRON',
        'BRONZE',
        'SILVER',
        'GOLD',
        'PLATINUM',
        'EMERALD',
        'DIAMOND',
        'MASTER',
        'GRANDMASTER',
        'CHALLENGER',
    ];
    const divisions: Record<string, number> = { IV: 1, III: 2, II: 3, I: 4 };
    const tierValue = tiers.indexOf(tier?.toUpperCase?.() ?? '');
    const divisionValue = divisions[division?.toUpperCase?.() ?? ''] ?? -1;
    if (tierValue === -1 || divisionValue === -1) return null;
    return tierValue * 400 + divisionValue * 100 + lp;
}

jest.mock('diana-core', () => ({
    getGuildCompetitiveScope: jest.fn().mockResolvedValue('all'),
    getSummonersForGuild: getSummonersForGuildMock,
    getLatestRanksForPuuids: getLatestRanksForPuuidsMock,
    getInterCandidatesLastWeek: getInterCandidatesLastWeekMock,
    getTotalPoints: getTotalPointsImpl,
}));

const {
    leaderboardCommand,
} = require('../packages/diana-discord/src/plugins/diana-league-bot/discord/commands/leaderboardCommand');

function makeMember(overrides: Record<string, unknown> = {}) {
    return {
        puuid: 'p1',
        gameName: 'Player',
        tagLine: 'EUW',
        deepLolLink: null,
        ...overrides,
    };
}

function makeCandidate(overrides: Record<string, unknown> = {}) {
    return {
        puuid: 'p1',
        displayName: 'Player#EUW',
        deepLolLink: null,
        matchesPlayed: 5,
        wins: 3,
        losses: 2,
        totalKills: 20,
        totalDeaths: 10,
        totalAssists: 15,
        avgDamage: 15000,
        kdaRatio: 3.5,
        winRate: 0.6,
        avgVisionScore: 22,
        avgCsPerMin: 6.4,
        avgAiScore: 55,
        scoredMatchesCount: 5,
        ...overrides,
    };
}

function makeInteraction(
    opts: {
        subcommand?: string;
        queue?: string | null;
        board?: string;
        guildId?: string | null;
    } = {}
) {
    const {
        subcommand = 'lp',
        queue = null,
        board = 'kda',
        guildId = 'guild-1',
    } = opts;
    return {
        guildId,
        options: {
            getSubcommand: jest.fn().mockReturnValue(subcommand),
            getString: jest.fn((name: string) =>
                name === 'queue' ? queue : board
            ),
        },
        reply: jest.fn().mockResolvedValue(undefined),
        deferReply: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
    };
}

describe('leaderboardCommand', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('has name "leaderboard" with lp and stats subcommands', () => {
        expect(leaderboardCommand.data.name).toBe('leaderboard');
        const names = leaderboardCommand.data.subcommands.map(
            (s: any) => s.name
        );
        expect(names).toContain('lp');
        expect(names).toContain('stats');
    });

    it('rejects use outside a guild', async () => {
        const interaction = makeInteraction({ guildId: null });
        await leaderboardCommand.execute(interaction as any);
        expect(interaction.reply).toHaveBeenCalledWith(
            expect.objectContaining({
                content: expect.stringContaining('only be used in a server'),
            })
        );
    });

    describe('lp subcommand', () => {
        it('orders the ladder by total rank points', async () => {
            getSummonersForGuildMock.mockResolvedValue([
                makeMember({ puuid: 'low', gameName: 'LowRank' }),
                makeMember({ puuid: 'high', gameName: 'HighRank' }),
            ]);
            getLatestRanksForPuuidsMock.mockResolvedValue([
                {
                    entryParticipantId: 'low',
                    tier: 'SILVER',
                    rank: 'II',
                    lp: 10,
                },
                {
                    entryParticipantId: 'high',
                    tier: 'DIAMOND',
                    rank: 'IV',
                    lp: 50,
                },
            ]);
            const interaction = makeInteraction({ subcommand: 'lp' });

            await leaderboardCommand.execute(interaction as any);

            const reply = interaction.editReply.mock.calls[0][0];
            const description = reply.embeds[0].data.description;
            expect(description.indexOf('HighRank')).toBeLessThan(
                description.indexOf('LowRank')
            );
            expect(description).toContain('DIAMOND IV (50 LP)');
        });

        it('defaults to Ranked Solo and shows Unranked members last', async () => {
            getSummonersForGuildMock.mockResolvedValue([
                makeMember({ puuid: 'unranked', gameName: 'NoRank' }),
                makeMember({ puuid: 'ranked', gameName: 'HasRank' }),
            ]);
            getLatestRanksForPuuidsMock.mockResolvedValue([
                {
                    entryParticipantId: 'ranked',
                    tier: 'GOLD',
                    rank: 'I',
                    lp: 20,
                },
            ]);
            const interaction = makeInteraction({ subcommand: 'lp' });

            await leaderboardCommand.execute(interaction as any);

            expect(getLatestRanksForPuuidsMock).toHaveBeenCalledWith(
                ['unranked', 'ranked'],
                'RANKED_SOLO_5x5'
            );
            const description =
                interaction.editReply.mock.calls[0][0].embeds[0].data
                    .description;
            expect(description.indexOf('HasRank')).toBeLessThan(
                description.indexOf('NoRank')
            );
            expect(description).toContain('Unranked');
        });

        it('shows an empty-state message when no summoners tracked', async () => {
            getSummonersForGuildMock.mockResolvedValue([]);
            const interaction = makeInteraction({ subcommand: 'lp' });

            await leaderboardCommand.execute(interaction as any);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('No summoners are tracked')
            );
        });
    });

    describe('stats subcommand', () => {
        it('ranks by the chosen metric descending', async () => {
            getInterCandidatesLastWeekMock.mockResolvedValue([
                makeCandidate({
                    puuid: 'a',
                    displayName: 'LowKda',
                    kdaRatio: 1.2,
                }),
                makeCandidate({
                    puuid: 'b',
                    displayName: 'HighKda',
                    kdaRatio: 6.8,
                }),
            ]);
            const interaction = makeInteraction({
                subcommand: 'stats',
                board: 'kda',
            });

            await leaderboardCommand.execute(interaction as any);

            expect(getInterCandidatesLastWeekMock).toHaveBeenCalledWith({
                guildId: 'guild-1',
                scope: 'all',
            });
            const description =
                interaction.editReply.mock.calls[0][0].embeds[0].data
                    .description;
            expect(description.indexOf('HighKda')).toBeLessThan(
                description.indexOf('LowKda')
            );
        });

        it('applies a minimum-games threshold to the winrate board', async () => {
            getInterCandidatesLastWeekMock.mockResolvedValue([
                makeCandidate({
                    puuid: 'few',
                    displayName: 'TwoGames',
                    matchesPlayed: 2,
                    winRate: 1,
                }),
                makeCandidate({
                    puuid: 'many',
                    displayName: 'ManyGames',
                    matchesPlayed: 8,
                    winRate: 0.75,
                }),
            ]);
            const interaction = makeInteraction({
                subcommand: 'stats',
                board: 'winrate',
            });

            await leaderboardCommand.execute(interaction as any);

            const description =
                interaction.editReply.mock.calls[0][0].embeds[0].data
                    .description;
            expect(description).toContain('ManyGames');
            expect(description).not.toContain('TwoGames');
        });

        it('shows an empty-state message when no matches this week', async () => {
            getInterCandidatesLastWeekMock.mockResolvedValue([]);
            const interaction = makeInteraction({
                subcommand: 'stats',
                board: 'kda',
            });

            await leaderboardCommand.execute(interaction as any);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('No matches found')
            );
        });
    });

    it('replies with an error message when a query throws', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        getSummonersForGuildMock.mockRejectedValue(new Error('db down'));
        const interaction = makeInteraction({ subcommand: 'lp' });

        await leaderboardCommand.execute(interaction as any);

        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.stringContaining('Something went wrong')
        );
        jest.restoreAllMocks();
    });
});

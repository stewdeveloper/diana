export {};

const dbQueryMock = jest.fn();
const getDuoRecordMock = jest.fn();
const getInterCandidatesLastWeekMock = jest.fn();
const getMostRecentRankMock = jest.fn();
// Every guild in these tests resolves to one squad; the roster reads below are
// scoped to it, not to the guild id.
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
    getGuildCompetitiveScope: jest.fn().mockResolvedValue('all'),
    getSquadIdForGuild: getSquadIdForGuildMock,
    db: { query: dbQueryMock },
    getDuoRecord: getDuoRecordMock,
    getInterCandidatesLastWeek: getInterCandidatesLastWeekMock,
    getMostRecentRankByParticipantIdAndQueueType: getMostRecentRankMock,
}));

const {
    compareCommand,
} = require('../packages/diana-discord/src/plugins/diana-league-bot/discord/commands/compareCommand');

function summonerRow(
    puuid: string,
    gameName: string,
    tagLine = 'EUW'
): Record<string, unknown> {
    return { puuid, gameName, tagLine, deepLolLink: null };
}

function weeklyCandidate(overrides: Record<string, unknown> = {}) {
    return {
        puuid: 'a',
        displayName: 'A#EUW',
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
        guildId?: string | null;
        player1?: string;
        player2?: string;
    } = {}
) {
    const {
        guildId = 'guild-1',
        player1 = 'Alpha#EUW',
        player2 = 'Beta#EUW',
    } = opts;
    return {
        guildId,
        options: {
            getString: jest.fn((name: string) =>
                name === 'player1' ? player1 : player2
            ),
        },
        reply: jest.fn().mockResolvedValue(undefined),
        deferReply: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
    };
}

describe('compareCommand', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getMostRecentRankMock.mockResolvedValue({
            tier: 'GOLD',
            rank: 'II',
            lp: 40,
        });
        getInterCandidatesLastWeekMock.mockResolvedValue([weeklyCandidate()]);
        getDuoRecordMock.mockResolvedValue({
            gamesTogether: 4,
            winsTogether: 3,
            lossesTogether: 1,
            gamesAgainst: 2,
            winsForAAgainstB: 2,
        });
    });

    it('has name "compare"', () => {
        expect(compareCommand.data.name).toBe('compare');
    });

    it('rejects use outside a guild', async () => {
        const interaction = makeInteraction({ guildId: null });
        await compareCommand.execute(interaction as any);
        expect(interaction.reply).toHaveBeenCalledWith(
            expect.objectContaining({
                content: expect.stringContaining('only be used in a server'),
            })
        );
    });

    it('reports a missing player', async () => {
        dbQueryMock.mockResolvedValue({ rows: [] });
        const interaction = makeInteraction();

        await compareCommand.execute(interaction as any);

        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.stringContaining('Could not find')
        );
        expect(getDuoRecordMock).not.toHaveBeenCalled();
    });

    it('rejects comparing a player with themselves', async () => {
        dbQueryMock.mockResolvedValue({
            rows: [summonerRow('same', 'Alpha')],
        });
        const interaction = makeInteraction({
            player1: 'Alpha#EUW',
            player2: 'Alpha#EUW',
        });

        await compareCommand.execute(interaction as any);

        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.stringContaining('two different summoners')
        );
    });

    it('builds a comparison embed with both players and the duo record', async () => {
        dbQueryMock.mockImplementation((_query: string, params: string[]) => {
            const name = params[1];
            return Promise.resolve({
                rows: [
                    name === 'Alpha'
                        ? summonerRow('pa', 'Alpha')
                        : summonerRow('pb', 'Beta'),
                ],
            });
        });
        const interaction = makeInteraction();

        await compareCommand.execute(interaction as any);

        expect(getDuoRecordMock).toHaveBeenCalledWith('pa', 'pb', 0, 'all');
        const reply = interaction.editReply.mock.calls[0][0];
        const embed = reply.embeds[0];
        expect(embed.data.title).toContain('Alpha#EUW');
        expect(embed.data.title).toContain('Beta#EUW');

        const duoField = embed.data.fields.find(
            (f: any) => f.name === '👥 Duo Record'
        );
        expect(duoField.value).toContain('3W/1L');
        expect(duoField.value).toContain('75.0%');
        expect(duoField.value).toContain('Alpha#EUW 2 - 0 Beta#EUW');

        const playerField = embed.data.fields.find((f: any) =>
            f.name.includes('Alpha#EUW')
        );
        expect(playerField.value).toContain('GOLD II (40 LP)');
        expect(playerField.value).toContain('3.50 KDA');
    });

    it('shows an empty duo message when no shared matches exist', async () => {
        dbQueryMock.mockImplementation((_query: string, params: string[]) => {
            const name = params[1];
            return Promise.resolve({
                rows: [
                    name === 'Alpha'
                        ? summonerRow('pa', 'Alpha')
                        : summonerRow('pb', 'Beta'),
                ],
            });
        });
        getDuoRecordMock.mockResolvedValue({
            gamesTogether: 0,
            winsTogether: 0,
            lossesTogether: 0,
            gamesAgainst: 0,
            winsForAAgainstB: 0,
        });
        const interaction = makeInteraction();

        await compareCommand.execute(interaction as any);

        const embed = interaction.editReply.mock.calls[0][0].embeds[0];
        const duoField = embed.data.fields.find(
            (f: any) => f.name === '👥 Duo Record'
        );
        expect(duoField.value).toContain('No shared matches');
    });

    it('autocompletes guild-scoped Name#Tag suggestions', async () => {
        dbQueryMock.mockResolvedValue({
            rows: [
                { gameName: 'Alpha', tagLine: 'EUW' },
                { gameName: 'Beta', tagLine: 'NA1' },
            ],
        });
        const interaction = {
            guildId: 'guild-1',
            options: {
                getFocused: jest.fn(() => ({ name: 'player1', value: 'a' })),
            },
            respond: jest.fn().mockResolvedValue(undefined),
            responded: false,
        };

        await compareCommand.autocomplete(interaction as any);

        expect(interaction.respond).toHaveBeenCalledWith([
            { name: 'Alpha#EUW', value: 'Alpha#EUW' },
            { name: 'Beta#NA1', value: 'Beta#NA1' },
        ]);
    });

    it('replies with an error message when a lookup throws', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        dbQueryMock.mockRejectedValue(new Error('db down'));
        const interaction = makeInteraction();

        await compareCommand.execute(interaction as any);

        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.stringContaining('Something went wrong')
        );
        jest.restoreAllMocks();
    });
});

export {};

const computeSquadWrappedMock = jest.fn();
const getSquadIdForGuildMock = jest.fn().mockResolvedValue('squad-42');
const getGuildCompetitiveScopeMock = jest.fn().mockResolvedValue('all');

class MockStringOption {
    public config: Record<string, unknown> = {};
    setName(name: string) {
        this.config.name = name;
        return this;
    }
    setDescription(_description: string) {
        return this;
    }
    setRequired(required: boolean) {
        this.config.required = required;
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

class MockSlashCommandBuilder {
    public name?: string;
    public options: MockStringOption[] = [];
    setName(name: string) {
        this.name = name;
        return this;
    }
    setDescription(_description: string) {
        return this;
    }
    addStringOption(cb: (option: MockStringOption) => unknown) {
        const option = new MockStringOption();
        cb(option);
        this.options.push(option);
        return this;
    }
}

class MockEmbedBuilder {
    public data: Record<string, any> = { fields: [] };
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

jest.mock('diana-core', () => {
    // The period helpers are pure, so the command is tested against the real
    // ones - a stub would let the labels drift apart from what a card shows.
    const period = require('../packages/diana-core/src/core/wrapped/wrappedPeriod');
    return {
        computeSquadWrapped: computeSquadWrappedMock,
        getSquadIdForGuild: getSquadIdForGuildMock,
        getGuildCompetitiveScope: getGuildCompetitiveScopeMock,
        isWrappedPeriodKey: period.isWrappedPeriodKey,
        resolveWrappedPeriod: period.resolveWrappedPeriod,
    };
});

const {
    wrappedCommand,
    buildWrappedEmbed,
} = require('../packages/diana-discord/src/plugins/diana-league-bot/discord/commands/wrappedCommand');

function makeWrapped(overrides: Record<string, unknown> = {}) {
    return {
        squadId: 'squad-42',
        period: {
            key: 'split',
            label: 'Last 90 days',
            from: '2026-04-01T00:00:00.000Z',
            to: '2026-07-01T00:00:00.000Z',
        },
        generatedAt: '2026-07-01T00:00:00.000Z',
        totalGames: 96,
        wins: 55,
        losses: 41,
        playerCount: 5,
        players: [
            {
                puuid: 'p1',
                name: 'One#EUW',
                games: 90,
                wins: 52,
                losses: 38,
                winRate: 0.577,
                avgAiScore: 63,
                kdaRatio: 3.1,
                topChampion: 'Lux',
            },
        ],
        ...overrides,
    };
}

function makeInteraction(
    guildId: string | null = 'guild-1',
    period: string | null = null
) {
    return {
        guildId,
        options: { getString: jest.fn().mockReturnValue(period) },
        deferReply: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
    };
}

const embedText = (embed: any): string => JSON.stringify(embed.data ?? embed);

beforeEach(() => {
    jest.clearAllMocks();
    getSquadIdForGuildMock.mockResolvedValue('squad-42');
    getGuildCompetitiveScopeMock.mockResolvedValue('all');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('wrappedCommand.data', () => {
    it('is named "wrapped"', () => {
        expect(wrappedCommand.data.name).toBe('wrapped');
    });

    it('offers an optional period with the four presets', () => {
        const option = wrappedCommand.data.options[0];
        expect(option.config.name).toBe('period');
        expect(option.config.required).toBe(false);
        expect(
            (option.config.choices as Array<{ value: string }>).map(
                (c) => c.value
            )
        ).toEqual(['split', 'month', 'year', 'all']);
    });

    it('never labels a choice as a real split', () => {
        // Riot publishes no split dates. The window says what it is.
        const labels = (
            wrappedCommand.data.options[0].config.choices as Array<{
                name: string;
            }>
        ).map((c) => c.name);
        expect(labels).toContain('Last 90 days');
        expect(labels.join(' ')).not.toMatch(/Split \d/);
    });
});

describe('wrappedCommand.execute', () => {
    it('scopes to the guild’s squad and its competitive scope', async () => {
        computeSquadWrappedMock.mockResolvedValue(makeWrapped());
        const interaction = makeInteraction('guild-7');

        await wrappedCommand.execute(interaction as any);

        expect(getSquadIdForGuildMock).toHaveBeenCalledWith('guild-7');
        expect(computeSquadWrappedMock).toHaveBeenCalledWith(
            'squad-42',
            expect.objectContaining({ scope: 'all' })
        );
    });

    it('resolves the period the user asked for', async () => {
        computeSquadWrappedMock.mockResolvedValue(makeWrapped());
        await wrappedCommand.execute(makeInteraction('guild-1', 'year') as any);

        expect(computeSquadWrappedMock).toHaveBeenCalledWith(
            'squad-42',
            expect.objectContaining({
                period: expect.objectContaining({ key: 'year' }),
            })
        );
    });

    it('falls back to the default window for a period it does not know', async () => {
        computeSquadWrappedMock.mockResolvedValue(makeWrapped());
        await wrappedCommand.execute(
            makeInteraction('guild-1', 'fortnight') as any
        );

        expect(computeSquadWrappedMock).toHaveBeenCalledWith(
            'squad-42',
            expect.objectContaining({
                period: expect.objectContaining({ key: 'split' }),
            })
        );
    });

    it('explains itself in a DM instead of failing', async () => {
        const interaction = makeInteraction(null);
        await wrappedCommand.execute(interaction as any);
        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.stringContaining('inside a server')
        );
        expect(computeSquadWrappedMock).not.toHaveBeenCalled();
    });

    it('points an unattached server at /add', async () => {
        getSquadIdForGuildMock.mockResolvedValue(null);
        const interaction = makeInteraction('guild-1');
        await wrappedCommand.execute(interaction as any);
        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.stringContaining('/add')
        );
    });

    it('says so plainly when the period was empty', async () => {
        computeSquadWrappedMock.mockResolvedValue(null);
        const interaction = makeInteraction('guild-1');
        await wrappedCommand.execute(interaction as any);
        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.stringContaining('Nothing to wrap up')
        );
    });

    it('survives a failed computation', async () => {
        computeSquadWrappedMock.mockRejectedValue(new Error('db down'));
        const interaction = makeInteraction('guild-1');
        await wrappedCommand.execute(interaction as any);
        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.stringContaining('went wrong')
        );
    });
});

describe('buildWrappedEmbed', () => {
    it('leads with the record and the roster size', () => {
        const embed = buildWrappedEmbed(makeWrapped());
        expect(embed.data.description).toContain('96 games');
        expect(embed.data.description).toContain('55W-41L');
        expect(embed.data.description).toContain('5 players');
    });

    it('labels the window in the footer', () => {
        const embed = buildWrappedEmbed(makeWrapped());
        expect(embed.data.footer).toEqual({ text: 'Last 90 days' });
    });

    it('says nothing about voice for a squad with no client', () => {
        // "0h in voice" would state something about the group that is really a
        // fact about their deployment.
        const embed = buildWrappedEmbed(makeWrapped());
        expect(embedText(embed)).not.toContain('in voice');
        expect(embedText(embed)).not.toContain('Nights');
    });

    it('reports voice hours and the worst night when there are nights', () => {
        const embed = buildWrappedEmbed(
            makeWrapped({
                voice: {
                    totalVoiceSeconds: 19680,
                    nights: 12,
                    longestNightSeconds: 19680,
                    byPerson: [],
                },
                worstNight: {
                    sessionId: 's1',
                    startedAt: '2026-05-14T20:00:00.000Z',
                    endedAt: '2026-05-15T02:00:00.000Z',
                    wins: 0,
                    losses: 6,
                    matchCount: 6,
                },
            })
        );
        expect(embed.data.description).toContain('5h 28m in voice');
        expect(embedText(embed)).toContain('2026-05-14');
        expect(embedText(embed)).toContain('0W-6L');
    });

    it('names a person for the best game and a game for the worst', () => {
        // The asymmetry is deliberate. See WrappedWorstGame.
        const embed = buildWrappedEmbed(
            makeWrapped({
                bestGame: {
                    matchId: 'M1',
                    puuid: 'p1',
                    name: 'One#EUW',
                    championName: 'Warwick',
                    aiScore: 97.4,
                    playedAt: '2026-05-01T00:00:00.000Z',
                },
                worstGame: {
                    matchId: 'M2',
                    meanAiScore: 21.6,
                    playerCount: 5,
                    playedAt: '2026-05-02T00:00:00.000Z',
                },
            })
        );
        const text = embedText(embed);
        expect(text).toContain("One#EUW's Warwick");
        expect(text).toContain('97');
        expect(text).toContain('all of you');
        expect(text).not.toContain('Worst game** - One#EUW');
    });

    it('renders a climb and a fall with their standings', () => {
        const embed = buildWrappedEmbed(
            makeWrapped({
                biggestClimb: {
                    puuid: 'p1',
                    name: 'One#EUW',
                    delta: 230,
                    from: 'GOLD IV 10 LP',
                    to: 'GOLD II 40 LP',
                },
                biggestFall: {
                    puuid: 'p2',
                    name: 'Two#EUW',
                    delta: -140,
                    from: 'PLATINUM IV 60 LP',
                    to: 'GOLD I 20 LP',
                },
            })
        );
        const text = embedText(embed);
        expect(text).toContain('+230 LP');
        expect(text).toContain('-140 LP');
        expect(text).toContain('GOLD IV 10 LP');
    });

    it('omits the duo line when nobody queued together', () => {
        expect(embedText(buildWrappedEmbed(makeWrapped()))).not.toContain(
            'Duo of the period'
        );
    });

    it('names the duo when there is one', () => {
        const embed = buildWrappedEmbed(
            makeWrapped({
                topDuo: {
                    names: ['One#EUW', 'Two#EUW'],
                    puuids: ['p1', 'p2'],
                    gamesTogether: 40,
                    winsTogether: 24,
                    winRate: 0.6,
                },
            })
        );
        expect(embedText(embed)).toContain('One#EUW + Two#EUW');
        expect(embedText(embed)).toContain('60.0%');
    });

    it('lists the roster with each player’s own champion', () => {
        const embed = buildWrappedEmbed(makeWrapped());
        const roster = embed.data.fields.find(
            (f: any) => f.name === 'The roster'
        );
        expect(roster.value).toContain('One#EUW');
        expect(roster.value).toContain('Lux');
        expect(roster.value).toContain('AI 63');
    });

    it('leaves the AI score off a player nothing scored', () => {
        const embed = buildWrappedEmbed(
            makeWrapped({
                players: [
                    {
                        puuid: 'p1',
                        name: 'One#EUW',
                        games: 3,
                        wins: 1,
                        losses: 2,
                        winRate: 0.333,
                        avgAiScore: null,
                        kdaRatio: 1,
                        topChampion: null,
                    },
                ],
            })
        );
        const roster = embed.data.fields.find(
            (f: any) => f.name === 'The roster'
        );
        expect(roster.value).not.toContain('AI ');
    });
});

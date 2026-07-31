export {};

// ─── Discord.js mock builders ─────────────────────────────────────────────────

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
    addChoices(..._c: unknown[]) {
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
    setDefaultMemberPermissions(_p: unknown) {
        return this;
    }
    addSubcommand(cb: (s: MockSubcommand) => unknown) {
        const s = new MockSubcommand();
        cb(s);
        this.subcommands.push(s);
        return this;
    }
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

const getAccountByRiotIdMock = jest.fn();
const getSummonerByPUUIDMock = jest.fn();
const createLinkChallengeMock = jest.fn();
const createTrustedLinkMock = jest.fn();
const chooseChallengeIconMock = jest.fn();
const getLinkChallengeMock = jest.fn();
const getGuildAllowsTrustedLinksMock = jest.fn();
const resolveIdentityMock = jest.fn();
const verifyLinkChallengeMock = jest.fn();

jest.mock('discord.js', () => ({
    SlashCommandBuilder: MockSlashCommandBuilder,
    MessageFlags: { Ephemeral: 64 },
}));

jest.mock('twisted', () => ({
    Constants: {
        Regions: {
            EU_WEST: 'EU_WEST',
            EU_EAST: 'EU_EAST',
            TURKEY: 'TURKEY',
            RUSSIA: 'RUSSIA',
            AMERICA_NORTH: 'AMERICA_NORTH',
            LAT_NORTH: 'LAT_NORTH',
            LAT_SOUTH: 'LAT_SOUTH',
            BRAZIL: 'BRAZIL',
            KOREA: 'KOREA',
            JAPAN: 'JAPAN',
            OCEANIA: 'OCEANIA',
            SINGAPORE: 'SINGAPORE',
        },
    },
}));

jest.mock('diana-core', () => ({
    createLolService: () => ({
        getAccountByRiotId: getAccountByRiotIdMock,
        getSummonerByPUUID: getSummonerByPUUIDMock,
    }),
    createLinkChallenge: createLinkChallengeMock,
    createTrustedLink: createTrustedLinkMock,
    chooseChallengeIcon: chooseChallengeIconMock,
    getLinkChallenge: getLinkChallengeMock,
    getGuildAllowsTrustedLinks: getGuildAllowsTrustedLinksMock,
    resolveIdentity: resolveIdentityMock,
    verifyLinkChallenge: verifyLinkChallengeMock,
}));

import { linkCommand } from '../packages/diana-discord/src/plugins/diana-league-bot/discord/commands/linkCommand';

const EMPTY_IDENTITY = {
    identityId: null,
    puuids: [],
    discordUserIds: [],
    meepsUserIds: [],
    verifiedPuuids: [],
};

function makeInteraction(
    opts: {
        subcommand?: string;
        name?: string;
        tag?: string;
        region?: string | null;
        guildId?: string | null;
    } = {}
) {
    const {
        subcommand = 'start',
        name = 'Louis',
        tag = 'EUW',
        region = null,
        guildId = 'guild-7',
    } = opts;
    return {
        guildId,
        user: { id: 'discord-1' },
        options: {
            getSubcommand: jest.fn().mockReturnValue(subcommand),
            getString: jest.fn((option: string) => {
                if (option === 'name') return name;
                if (option === 'tag') return tag;
                return region;
            }),
        },
        deferReply: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
    };
}

const replyText = (interaction: ReturnType<typeof makeInteraction>) =>
    String(interaction.editReply.mock.calls[0][0]);

beforeEach(() => {
    jest.clearAllMocks();
    getAccountByRiotIdMock.mockResolvedValue({
        puuid: 'puuid-1',
        gameName: 'Louis',
        tagLine: 'EUW',
    });
    getSummonerByPUUIDMock.mockResolvedValue({
        puuid: 'puuid-1',
        profileIconId: 12,
    });
    resolveIdentityMock.mockResolvedValue(EMPTY_IDENTITY);
    getGuildAllowsTrustedLinksMock.mockResolvedValue(false);
    chooseChallengeIconMock.mockReturnValue(590);
    createLinkChallengeMock.mockResolvedValue({});
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('linkCommand data', () => {
    it('is named link', () => {
        expect(linkCommand.data.name).toBe('link');
    });

    it('offers start, confirm and status', () => {
        const names = (linkCommand.data as any).subcommands.map(
            (s: MockSubcommand) => s.name
        );
        expect(names).toEqual(['start', 'confirm', 'status']);
    });
});

describe('/link start', () => {
    it('opens a challenge naming an icon and telling them what to do', async () => {
        const interaction = makeInteraction();
        await linkCommand.execute(interaction as any);

        expect(createLinkChallengeMock).toHaveBeenCalledWith(
            'discord-1',
            expect.objectContaining({ puuid: 'puuid-1' }),
            590
        );
        const text = replyText(interaction);
        expect(text).toContain('#590');
        expect(text).toContain('/link confirm');
    });

    it('excludes the icon they already have', async () => {
        // Asking for an icon they already have would "verify" a player who
        // changed nothing.
        getSummonerByPUUIDMock.mockResolvedValue({ profileIconId: 588 });
        const interaction = makeInteraction();
        await linkCommand.execute(interaction as any);

        expect(chooseChallengeIconMock).toHaveBeenCalledWith(588);
    });

    it('replies ephemerally', async () => {
        const interaction = makeInteraction();
        await linkCommand.execute(interaction as any);
        expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    });

    it('refuses an account already linked to somebody else', async () => {
        resolveIdentityMock.mockResolvedValue({
            ...EMPTY_IDENTITY,
            identityId: 'id-other',
            discordUserIds: ['discord-someone-else'],
        });

        const interaction = makeInteraction();
        await linkCommand.execute(interaction as any);

        expect(createLinkChallengeMock).not.toHaveBeenCalled();
        expect(replyText(interaction)).toContain('already linked to someone');
    });

    it('lets somebody re-link an account already theirs', async () => {
        resolveIdentityMock.mockResolvedValue({
            ...EMPTY_IDENTITY,
            identityId: 'id-1',
            discordUserIds: ['discord-1'],
        });

        const interaction = makeInteraction();
        await linkCommand.execute(interaction as any);
        expect(createLinkChallengeMock).toHaveBeenCalled();
    });

    it('skips the handshake where the server allows trusted links', async () => {
        getGuildAllowsTrustedLinksMock.mockResolvedValue(true);
        createTrustedLinkMock.mockResolvedValue({ ok: true, account: {} });

        const interaction = makeInteraction();
        await linkCommand.execute(interaction as any);

        expect(createTrustedLinkMock).toHaveBeenCalledWith(
            'discord-1',
            'puuid-1'
        );
        expect(createLinkChallengeMock).not.toHaveBeenCalled();
        expect(replyText(interaction)).toContain('no verification');
    });

    it('says a Riot ID does not exist rather than showing a stack trace', async () => {
        getAccountByRiotIdMock.mockRejectedValue(
            Object.assign(new Error('not found'), { status: 404 })
        );

        const interaction = makeInteraction();
        await linkCommand.execute(interaction as any);
        expect(replyText(interaction)).toContain('No Riot account');
    });

    it('names summoner-v4 on a 403, because the fix is a key request', async () => {
        // docs/access.md is missing, so whether the production key grants
        // summoner-v4 is genuinely unverified. The operator needs to know it
        // is a key problem, not something to retry.
        getSummonerByPUUIDMock.mockRejectedValue(
            Object.assign(new Error('forbidden'), { status: 403 })
        );

        const interaction = makeInteraction();
        await linkCommand.execute(interaction as any);
        expect(replyText(interaction)).toContain('summoner-v4');
    });

    it('reports rate limiting as something to wait out', async () => {
        getAccountByRiotIdMock.mockRejectedValue(
            Object.assign(new Error('slow down'), { status: 429 })
        );

        const interaction = makeInteraction();
        await linkCommand.execute(interaction as any);
        expect(replyText(interaction)).toContain('rate-limiting');
    });
});

describe('/link confirm', () => {
    it('completes when the icon matches', async () => {
        getLinkChallengeMock.mockResolvedValue({
            puuid: 'puuid-1',
            game_name: 'Louis',
            tag_line: 'EUW',
            region: 'EU_WEST',
            required_icon: 590,
        });
        getSummonerByPUUIDMock.mockResolvedValue({ profileIconId: 590 });
        verifyLinkChallengeMock.mockResolvedValue({
            ok: true,
            puuid: 'puuid-1',
            identityId: 'id-1',
        });

        const interaction = makeInteraction({ subcommand: 'confirm' });
        await linkCommand.execute(interaction as any);

        expect(verifyLinkChallengeMock).toHaveBeenCalledWith('discord-1', 590);
        expect(replyText(interaction)).toContain('Louis#EUW');
    });

    it('tells them to wait and retry on a mismatch, not to start again', async () => {
        getLinkChallengeMock.mockResolvedValue({
            puuid: 'puuid-1',
            game_name: 'Louis',
            tag_line: 'EUW',
            region: 'EU_WEST',
            required_icon: 590,
        });
        getSummonerByPUUIDMock.mockResolvedValue({ profileIconId: 12 });
        verifyLinkChallengeMock.mockResolvedValue({
            ok: false,
            reason: 'icon_mismatch',
            expected: 590,
            actual: 12,
        });

        const interaction = makeInteraction({ subcommand: 'confirm' });
        await linkCommand.execute(interaction as any);

        const text = replyText(interaction);
        expect(text).toContain('#590');
        expect(text).toContain('/link confirm');
        expect(text).not.toContain('/link start');
    });

    it('says so when there is no challenge open', async () => {
        getLinkChallengeMock.mockResolvedValue(null);

        const interaction = makeInteraction({ subcommand: 'confirm' });
        await linkCommand.execute(interaction as any);

        expect(getSummonerByPUUIDMock).not.toHaveBeenCalled();
        expect(replyText(interaction)).toContain('/link start');
    });

    it('reports an account claimed while they were away', async () => {
        getLinkChallengeMock.mockResolvedValue({
            puuid: 'puuid-1',
            game_name: 'Louis',
            tag_line: 'EUW',
            region: 'EU_WEST',
            required_icon: 590,
        });
        getSummonerByPUUIDMock.mockResolvedValue({ profileIconId: 590 });
        verifyLinkChallengeMock.mockResolvedValue({
            ok: false,
            reason: 'already_linked',
            identityId: 'id-other',
        });

        const interaction = makeInteraction({ subcommand: 'confirm' });
        await linkCommand.execute(interaction as any);
        expect(replyText(interaction)).toContain('/unlink');
    });
});

describe('/link status', () => {
    it('distinguishes verified accounts from trusted ones', async () => {
        resolveIdentityMock.mockResolvedValue({
            ...EMPTY_IDENTITY,
            identityId: 'id-1',
            puuids: ['puuid-verified', 'puuid-trusted'],
            verifiedPuuids: ['puuid-verified'],
        });

        const interaction = makeInteraction({ subcommand: 'status' });
        await linkCommand.execute(interaction as any);

        const text = replyText(interaction);
        expect(text).toContain('verified');
        expect(text).toContain('trusted (unverified)');
    });

    it('points an unlinked user at /link start', async () => {
        const interaction = makeInteraction({ subcommand: 'status' });
        await linkCommand.execute(interaction as any);
        expect(replyText(interaction)).toContain('/link start');
    });
});

export {};

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
}

class MockSlashCommandBuilder {
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

const resolveIdentityMock = jest.fn();
const unlinkAccountMock = jest.fn();

jest.mock('discord.js', () => ({
    SlashCommandBuilder: MockSlashCommandBuilder,
    MessageFlags: { Ephemeral: 64 },
}));

jest.mock('diana-core', () => ({
    resolveIdentity: resolveIdentityMock,
    unlinkAccount: unlinkAccountMock,
}));

import { unlinkCommand } from '../packages/diana-discord/src/plugins/diana-league-bot/discord/commands/unlinkCommand';

const identity = (puuids: string[]) => ({
    identityId: puuids.length ? 'id-1' : null,
    puuids,
    discordUserIds: ['discord-1'],
    meepsUserIds: [],
    verifiedPuuids: [],
});

function makeInteraction(puuid: string | null = null) {
    return {
        user: { id: 'discord-1' },
        options: { getString: jest.fn().mockReturnValue(puuid) },
        deferReply: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
    };
}

const replyText = (interaction: ReturnType<typeof makeInteraction>) =>
    String(interaction.editReply.mock.calls[0][0]);

beforeEach(() => {
    jest.clearAllMocks();
    unlinkAccountMock.mockResolvedValue(true);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('unlinkCommand', () => {
    it('is named unlink', () => {
        expect(unlinkCommand.data.name).toBe('unlink');
    });

    it('unlinks the only linked account without being told which', async () => {
        resolveIdentityMock.mockResolvedValue(identity(['puuid-1']));

        const interaction = makeInteraction();
        await unlinkCommand.execute(interaction as any);

        expect(unlinkAccountMock).toHaveBeenCalledWith('riot_puuid', 'puuid-1');
    });

    it('refuses to guess when several are linked', async () => {
        // Picking the first would silently unlink an account they did not name.
        resolveIdentityMock.mockResolvedValue(identity(['puuid-1', 'puuid-2']));

        const interaction = makeInteraction();
        await unlinkCommand.execute(interaction as any);

        expect(unlinkAccountMock).not.toHaveBeenCalled();
        const text = replyText(interaction);
        expect(text).toContain('puuid-1');
        expect(text).toContain('puuid-2');
    });

    it('unlinks the named one when there are several', async () => {
        resolveIdentityMock.mockResolvedValue(identity(['puuid-1', 'puuid-2']));

        const interaction = makeInteraction('puuid-2');
        await unlinkCommand.execute(interaction as any);

        expect(unlinkAccountMock).toHaveBeenCalledWith('riot_puuid', 'puuid-2');
    });

    it('will not touch an account that is not the caller’s', async () => {
        resolveIdentityMock.mockResolvedValue(identity(['puuid-1']));

        const interaction = makeInteraction('puuid-someone-else');
        await unlinkCommand.execute(interaction as any);

        expect(unlinkAccountMock).not.toHaveBeenCalled();
        expect(replyText(interaction)).toContain('not linked to you');
    });

    it('gives the same answer for a stranger’s account as for a nonexistent one', async () => {
        // Otherwise /unlink becomes a way to discover who has linked what.
        resolveIdentityMock.mockResolvedValue(identity(['puuid-1']));

        const strangers = makeInteraction('puuid-owned-by-someone');
        await unlinkCommand.execute(strangers as any);

        const nonsense = makeInteraction('not-a-puuid-at-all');
        await unlinkCommand.execute(nonsense as any);

        expect(replyText(strangers)).toBe(replyText(nonsense));
    });

    it('says so when nothing is linked', async () => {
        resolveIdentityMock.mockResolvedValue(identity([]));

        const interaction = makeInteraction();
        await unlinkCommand.execute(interaction as any);

        expect(unlinkAccountMock).not.toHaveBeenCalled();
        expect(replyText(interaction)).toContain('no linked Riot accounts');
    });

    it('says tracking continues, because unlinking is not removing', async () => {
        resolveIdentityMock.mockResolvedValue(identity(['puuid-1']));

        const interaction = makeInteraction();
        await unlinkCommand.execute(interaction as any);
        expect(replyText(interaction)).toContain('still tracks');
    });

    it('replies ephemerally', async () => {
        resolveIdentityMock.mockResolvedValue(identity(['puuid-1']));
        const interaction = makeInteraction();
        await unlinkCommand.execute(interaction as any);
        expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    });

    it('reports a failure without leaking the error', async () => {
        resolveIdentityMock.mockRejectedValue(new Error('db down'));

        const interaction = makeInteraction();
        await unlinkCommand.execute(interaction as any);

        expect(replyText(interaction)).toContain('Something went wrong');
        expect(replyText(interaction)).not.toContain('db down');
    });
});

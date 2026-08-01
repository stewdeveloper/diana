export {};

/**
 * One click should fill every box it can.
 *
 * Discord's autocomplete protocol returns `{name, value}`, so a handler cannot
 * say "this choice sets both `name` and `tag`" - which is why picking a
 * summoner in Discord is two steps. That limit belongs to the protocol, not the
 * data, and Meeps' picker is not speaking that protocol.
 *
 * What must not regress: the enriched path is never *worse* than Discord's. In
 * particular, asking for a tag still narrows by the name already chosen.
 */

const searchSquadSummonersMock = jest.fn();
const suggestFromCommandMock = jest.fn();
const findCommandDescriptorMock = jest.fn();

jest.mock('diana-core', () => ({
    searchSquadSummoners: searchSquadSummonersMock,
}));

jest.mock('../packages/diana-discord/src/discord/commandManifest', () => ({
    findCommandDescriptor: findCommandDescriptorMock,
}));

jest.mock('../packages/diana-discord/src/discord/commandInvocation', () => ({
    suggestFromCommand: suggestFromCommandMock,
}));

import { suggestForCommand } from '../packages/diana-discord/src/discord/commandSuggest';

const descriptor = (name: string, id = name) => ({
    id,
    name,
    display: `/${name}`,
    description: '',
    params: [],
    mutates: false,
});

const row = (overrides: Record<string, unknown> = {}) => ({
    gameName: 'Louis',
    tagLine: 'EUW',
    matchRegionPrefix: 'euw1',
    tier: 'GOLD',
    rank: 'II',
    lp: 42,
    ...overrides,
});

const invocation = (id: string, params: Record<string, unknown> = {}) =>
    ({ id, params, guildId: 'guild-1', actorId: 'meeps:1' }) as never;

beforeEach(() => {
    jest.clearAllMocks();
    searchSquadSummonersMock.mockResolvedValue([row()]);
    suggestFromCommandMock.mockResolvedValue([]);
    findCommandDescriptorMock.mockReturnValue(descriptor('summoner'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('summoner-shaped parameters', () => {
    it('fills the name and the tag from one choice', async () => {
        const [suggestion] = await suggestForCommand(
            invocation('summoner'),
            'squad-1',
            'name',
            'lou'
        );

        expect(suggestion.fill).toEqual({ name: 'Louis', tag: 'EUW' });
        expect(suggestion.label).toBe('Louis#EUW');
    });

    it('shows the rank underneath', async () => {
        const [suggestion] = await suggestForCommand(
            invocation('summoner'),
            'squad-1',
            'name',
            'lou'
        );
        expect(suggestion.sublabel).toBe('Gold II · 42 LP');
    });

    it('says nothing rather than "UNRANKED"', async () => {
        searchSquadSummonersMock.mockResolvedValue([
            row({ tier: 'UNRANKED', rank: 'N/A', lp: 0 }),
        ]);
        const [suggestion] = await suggestForCommand(
            invocation('summoner'),
            'squad-1',
            'name',
            'lou'
        );
        expect(suggestion.sublabel).toBeUndefined();
    });

    it('still narrows the tag by the name already chosen', async () => {
        // The one respect in which the enriched path could have been a
        // downgrade on Discord's behaviour.
        await suggestForCommand(
            invocation('summoner', { name: 'Louis' }),
            'squad-1',
            'tag',
            'E'
        );

        expect(searchSquadSummonersMock).toHaveBeenCalledWith(
            'squad-1',
            'Louis#E',
            25
        );
    });

    it('puts the tag in the focused box when the tag was asked for', async () => {
        const [suggestion] = await suggestForCommand(
            invocation('summoner', { name: 'Louis' }),
            'squad-1',
            'tag',
            'E'
        );

        expect(suggestion.value).toBe('EUW');
        expect(suggestion.fill).toEqual({ name: 'Louis', tag: 'EUW' });
    });

    it('handles a summoner with no tag without inventing one', async () => {
        searchSquadSummonersMock.mockResolvedValue([row({ tagLine: null })]);
        const [suggestion] = await suggestForCommand(
            invocation('summoner'),
            'squad-1',
            'name',
            'lou'
        );

        expect(suggestion.label).toBe('Louis');
        expect(suggestion.fill).toEqual({ name: 'Louis' });
    });

    it('enriches every command that names a squad member', async () => {
        for (const name of ['summoner', 'champion', 'livegame', 'remove']) {
            findCommandDescriptorMock.mockReturnValue(descriptor(name));
            const [suggestion] = await suggestForCommand(
                invocation(name),
                'squad-1',
                'name',
                'lou'
            );
            expect(suggestion.fill).toEqual({ name: 'Louis', tag: 'EUW' });
        }
    });
});

describe('/compare', () => {
    it('puts the whole Name#Tag in one box, because that is what it parses', async () => {
        findCommandDescriptorMock.mockReturnValue(descriptor('compare'));
        const [suggestion] = await suggestForCommand(
            invocation('compare'),
            'squad-1',
            'player1',
            'lou'
        );

        expect(suggestion.fill).toEqual({ player1: 'Louis#EUW' });
        expect(suggestion.value).toBe('Louis#EUW');
    });

    it('fills whichever of the two players was asked for', async () => {
        findCommandDescriptorMock.mockReturnValue(descriptor('compare'));
        const [suggestion] = await suggestForCommand(
            invocation('compare'),
            'squad-1',
            'player2',
            'lou'
        );

        expect(suggestion.fill).toEqual({ player2: 'Louis#EUW' });
    });
});

describe('everything else falls through to Discord’s own handler', () => {
    it('passes a champion name through untouched', async () => {
        findCommandDescriptorMock.mockReturnValue(descriptor('champion'));
        suggestFromCommandMock.mockResolvedValue([
            { name: 'Ahri', value: 'Ahri' },
        ]);

        const [suggestion] = await suggestForCommand(
            invocation('champion'),
            'squad-1',
            'champion',
            'ah'
        );

        expect(searchSquadSummonersMock).not.toHaveBeenCalled();
        expect(suggestion).toEqual({
            label: 'Ahri',
            value: 'Ahri',
            fill: { champion: 'Ahri' },
        });
    });

    it('does not suggest current members for /add, which adds new ones', async () => {
        // /add exists to track somebody who is *not* in the squad yet, so the
        // squad roster is exactly the wrong list. It has no autocomplete in
        // Discord for the same reason.
        findCommandDescriptorMock.mockReturnValue(descriptor('add'));
        await suggestForCommand(invocation('add'), 'squad-1', 'name', 'lou');

        expect(searchSquadSummonersMock).not.toHaveBeenCalled();
        expect(suggestFromCommandMock).toHaveBeenCalled();
    });

    it('always carries a fill map, so the client has one code path', async () => {
        findCommandDescriptorMock.mockReturnValue(descriptor('wrapped'));
        suggestFromCommandMock.mockResolvedValue([
            { name: 'This month', value: 'month' },
        ]);

        const [suggestion] = await suggestForCommand(
            invocation('wrapped'),
            'squad-1',
            'period',
            ''
        );

        expect(suggestion.fill).toEqual({ period: 'month' });
    });
});

describe('failure', () => {
    it('returns nothing for a command that is not offered', async () => {
        findCommandDescriptorMock.mockReturnValue(null);
        expect(
            await suggestForCommand(invocation('link'), 'squad-1', 'name', '')
        ).toEqual([]);
    });

    it('costs the person a shortcut, not the ability to type it', async () => {
        searchSquadSummonersMock.mockRejectedValue(new Error('db down'));
        expect(
            await suggestForCommand(
                invocation('summoner'),
                'squad-1',
                'name',
                'lou'
            )
        ).toEqual([]);
    });
});

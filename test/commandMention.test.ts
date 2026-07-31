export {};

jest.mock('discord.js', () => ({
    REST: class {
        setToken() {
            return this;
        }
    },
    Routes: {
        applicationCommands: () => '/commands',
        applicationGuildCommands: () => '/guild-commands',
    },
    MessageFlags: { Ephemeral: 64 },
}));

jest.mock('diana-core', () => ({
    getGuildConfig: jest.fn(),
}));

import {
    commandMention,
    setCommandIds,
} from '../packages/diana-discord/src/discord/commandRegistry';

/**
 * A command written as `</add:123>` renders in Discord as a chip that pre-fills
 * the command when tapped. That is the difference between telling somebody to
 * run two commands and giving them two things to press, which is most of what
 * onboarding costs.
 *
 * The ids only exist after the first sync, so the fallback matters as much as
 * the mention: help and the welcome message can both fire before one has
 * happened, and neither is worth a broken `</add:undefined>`.
 */
describe('commandMention', () => {
    beforeEach(() => {
        setCommandIds('diana', []);
        setCommandIds('pathfinder', []);
    });

    it('renders a registered command as a clickable mention', () => {
        setCommandIds('diana', [{ id: '123', name: 'add' }]);
        expect(commandMention('add')).toBe('</add:123>');
    });

    it('keys a subcommand on its parent, which is what Discord accepts', () => {
        // `</link start:9>` is the documented shape - the id is the parent's,
        // and the subcommand rides along in the label.
        setCommandIds('diana', [{ id: '9', name: 'link' }]);
        expect(commandMention('link start')).toBe('</link start:9>');
    });

    it('falls back to code rather than emitting a broken mention', () => {
        // Before the first sync, and in every test that does not stub one.
        expect(commandMention('add')).toBe('`/add`');
        expect(commandMention('link start')).toBe('`/link start`');
    });

    it('tolerates a leading slash from a careless caller', () => {
        setCommandIds('diana', [{ id: '123', name: 'add' }]);
        expect(commandMention('/add')).toBe('</add:123>');
    });

    it('keeps the two bots apart', () => {
        // Both clients register their own commands and the ids are unrelated;
        // resolving Pathfinder's `apex-add` against Diana's table would produce
        // a mention that points at the wrong application entirely.
        setCommandIds('diana', [{ id: '1', name: 'add' }]);
        setCommandIds('pathfinder', [{ id: '2', name: 'apex-add' }]);

        expect(commandMention('apex-add', 'pathfinder')).toBe('</apex-add:2>');
        expect(commandMention('apex-add')).toBe('`/apex-add`');
    });

    it('does not resolve a command that was never registered', () => {
        setCommandIds('diana', [{ id: '1', name: 'add' }]);
        expect(commandMention('nonexistent')).toBe('`/nonexistent`');
    });
});

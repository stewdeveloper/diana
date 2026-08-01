export {};

/**
 * Scope resolution is the only genuinely new decision in running Diana's
 * commands from Meeps, and the one with a wrong answer that looks right.
 *
 * A Meeps request carries a space. Commands read `guildId`. The bridge between
 * them is `squad_attachments`, whose PRIMARY KEY (kind, external_id) makes
 * guild -> squad total but leaves squad -> guild potentially many. Picking the
 * first of several would answer "does Arena count for this squad?" correctly
 * about half the time and never say which half - so it refuses instead.
 */

const getSquadIdForAttachmentMock = jest.fn();
const getSquadAttachmentsMock = jest.fn();

jest.mock('../packages/diana-core/src/core/squads/squadService', () => ({
    getSquadIdForAttachment: getSquadIdForAttachmentMock,
    getSquadAttachments: getSquadAttachmentsMock,
}));

import {
    resolveCommandScope,
    SCOPE_FAILURE_MESSAGES,
} from '../packages/diana-core/src/core/commands/commandScope';

const attachment = (kind: string, externalId: string) => ({
    kind,
    external_id: externalId,
    squad_id: 'squad-1',
    attached_at: '2026-08-01T00:00:00.000Z',
});

beforeEach(() => {
    jest.clearAllMocks();
    getSquadIdForAttachmentMock.mockResolvedValue('squad-1');
    getSquadAttachmentsMock.mockResolvedValue([
        attachment('discord_guild', 'guild-1'),
    ]);
});

describe('resolveCommandScope', () => {
    it('resolves a space to its squad and that squad’s guild', async () => {
        const scope = await resolveCommandScope('space-1');

        expect(getSquadIdForAttachmentMock).toHaveBeenCalledWith(
            'meeps_space',
            'space-1'
        );
        expect(scope).toEqual({
            ok: true,
            squadId: 'squad-1',
            guildId: 'guild-1',
        });
    });

    it('ignores the space’s own attachment when looking for the guild', async () => {
        // The squad is attached to both the Meeps space and a Discord guild;
        // only one of those is a guild.
        getSquadAttachmentsMock.mockResolvedValue([
            attachment('meeps_space', 'space-1'),
            attachment('discord_guild', 'guild-1'),
        ]);

        const scope = await resolveCommandScope('space-1');

        expect(scope).toEqual({
            ok: true,
            squadId: 'squad-1',
            guildId: 'guild-1',
        });
    });

    it('refuses a space that is not attached to any squad', async () => {
        getSquadIdForAttachmentMock.mockResolvedValue(null);

        expect(await resolveCommandScope('space-1')).toEqual({
            ok: false,
            reason: 'no_squad',
        });
    });

    it('never brings a squad into existence just by reading', async () => {
        // `getOrCreateSquadForAttachment` exists and is deliberately not used:
        // running a leaderboard must not create a squad as a side effect.
        getSquadIdForAttachmentMock.mockResolvedValue(null);
        await resolveCommandScope('space-1');

        expect(getSquadAttachmentsMock).not.toHaveBeenCalled();
    });

    it('refuses a squad with no Discord server', async () => {
        getSquadAttachmentsMock.mockResolvedValue([
            attachment('meeps_space', 'space-1'),
        ]);

        expect(await resolveCommandScope('space-1')).toEqual({
            ok: false,
            reason: 'no_guild',
        });
    });

    it('refuses rather than guessing when a squad has two Discord servers', async () => {
        getSquadAttachmentsMock.mockResolvedValue([
            attachment('discord_guild', 'guild-1'),
            attachment('discord_guild', 'guild-2'),
        ]);

        expect(await resolveCommandScope('space-1')).toEqual({
            ok: false,
            reason: 'ambiguous_guild',
            guildIds: ['guild-1', 'guild-2'],
        });
    });

    it('has something to say to the person for every refusal', async () => {
        // These are shown in a chat channel, not a log, so each has to name the
        // fix rather than the internal condition.
        for (const reason of [
            'no_squad',
            'no_guild',
            'ambiguous_guild',
        ] as const) {
            expect(SCOPE_FAILURE_MESSAGES[reason]).toBeTruthy();
            expect(SCOPE_FAILURE_MESSAGES[reason].length).toBeGreaterThan(20);
        }
    });
});

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({
        db: {
            query: jest.fn(),
        },
    })
);

import { db } from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db';
import {
    attachToSquad,
    createSquad,
    detachAttachment,
    getAllSquadTrackedPuuids,
    getOrCreateSquadForAttachment,
    getSquad,
    getSquadAttachments,
    getSquadIdForAttachment,
    getSquadsTrackingPuuid,
    getSummonersForSquad,
    isSquadAttachmentKind,
    isSummonerInSquad,
    addSummonerToSquad,
    removeSummonerFromSquad,
    renameSquad,
    SQUAD_ATTACHMENT_KINDS,
} from '../packages/diana-core/src/core/squads/squadService';

const queryMock = db.query as unknown as jest.Mock;

beforeEach(() => {
    queryMock.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('isSquadAttachmentKind', () => {
    it('accepts the two supported kinds', () => {
        expect(isSquadAttachmentKind('discord_guild')).toBe(true);
        expect(isSquadAttachmentKind('meeps_space')).toBe(true);
    });

    it('rejects anything else, including non-strings', () => {
        expect(isSquadAttachmentKind('slack')).toBe(false);
        expect(isSquadAttachmentKind('')).toBe(false);
        expect(isSquadAttachmentKind(undefined)).toBe(false);
        expect(isSquadAttachmentKind(null)).toBe(false);
        expect(isSquadAttachmentKind(7)).toBe(false);
    });

    it('matches the exported list, so the API error message cannot drift', () => {
        for (const kind of SQUAD_ATTACHMENT_KINDS) {
            expect(isSquadAttachmentKind(kind)).toBe(true);
        }
    });
});

describe('getSquad', () => {
    it('returns the row when found', async () => {
        const squad = { squad_id: 'sq1', name: null, created_at: 'now' };
        queryMock.mockResolvedValue({ rows: [squad] });

        expect(await getSquad('sq1')).toEqual(squad);
        expect(queryMock).toHaveBeenCalledWith(expect.any(String), ['sq1']);
    });

    it('returns null rather than undefined when missing', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        expect(await getSquad('nope')).toBeNull();
    });
});

describe('createSquad', () => {
    it('stores null for an omitted name', async () => {
        queryMock.mockResolvedValue({ rows: [{ squad_id: 'sq1' }] });
        await createSquad();
        expect(queryMock).toHaveBeenCalledWith(expect.any(String), [null]);
    });

    it('stores the name when given', async () => {
        queryMock.mockResolvedValue({ rows: [{ squad_id: 'sq1' }] });
        await createSquad('Tuesday Night');
        expect(queryMock).toHaveBeenCalledWith(expect.any(String), [
            'Tuesday Night',
        ]);
    });
});

describe('renameSquad', () => {
    it('returns null when the squad does not exist', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        expect(await renameSquad('missing', 'X')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Attachments
//
// (kind, external_id) is the primary key, which is what makes guildId ->
// squadId resolution single-valued. These tests pin that behaviour.
// ---------------------------------------------------------------------------

describe('getSquadIdForAttachment', () => {
    it('resolves an external destination to its squad', async () => {
        queryMock.mockResolvedValue({ rows: [{ squad_id: 'sq1' }] });

        expect(await getSquadIdForAttachment('discord_guild', 'g1')).toBe(
            'sq1'
        );
        expect(queryMock).toHaveBeenCalledWith(expect.any(String), [
            'discord_guild',
            'g1',
        ]);
    });

    it('returns null for an unknown destination', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        expect(
            await getSquadIdForAttachment('meeps_space', 'space-9')
        ).toBeNull();
    });
});

describe('getOrCreateSquadForAttachment', () => {
    it('returns the existing squad without creating anything', async () => {
        queryMock.mockResolvedValue({ rows: [{ squad_id: 'sq1' }] });

        expect(await getOrCreateSquadForAttachment('discord_guild', 'g1')).toBe(
            'sq1'
        );
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('creates the squad and attaches it on first use', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [] }) // no attachment yet
            .mockResolvedValueOnce({ rows: [{ squad_id: 'sq-new' }] }) // INSERT squads
            .mockResolvedValueOnce({ rows: [{ squad_id: 'sq-new' }] }); // INSERT attachment

        expect(
            await getOrCreateSquadForAttachment('meeps_space', 'space-1')
        ).toBe('sq-new');
        expect(queryMock).toHaveBeenNthCalledWith(
            3,
            expect.stringContaining('INSERT INTO squad_attachments'),
            ['meeps_space', 'space-1', 'sq-new']
        );
    });

    it('yields to the winner and cleans up its own squad after losing a race', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [] }) // no attachment yet
            .mockResolvedValueOnce({ rows: [{ squad_id: 'sq-mine' }] }) // INSERT squads
            .mockResolvedValueOnce({ rows: [] }) // attach lost the ON CONFLICT race
            .mockResolvedValueOnce({ rows: [] }) // DELETE the orphan squad
            .mockResolvedValueOnce({ rows: [{ squad_id: 'sq-theirs' }] }); // re-resolve

        expect(await getOrCreateSquadForAttachment('discord_guild', 'g1')).toBe(
            'sq-theirs'
        );
        // The orphan must go: a squad with no attachment and no roster would
        // otherwise accumulate silently on every lost race.
        expect(queryMock).toHaveBeenNthCalledWith(
            4,
            expect.stringContaining('DELETE FROM squads'),
            ['sq-mine']
        );
    });

    it('throws if the race is lost and the winner cannot be resolved', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ squad_id: 'sq-mine' }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        await expect(
            getOrCreateSquadForAttachment('discord_guild', 'g1')
        ).rejects.toThrow(/after losing an attachment race/);
    });
});

describe('attachToSquad', () => {
    it('returns the attachment when it is created', async () => {
        const row = {
            kind: 'meeps_space',
            external_id: 'space-1',
            squad_id: 'sq1',
            attached_at: 'now',
        };
        queryMock.mockResolvedValue({ rows: [row] });

        expect(await attachToSquad('sq1', 'meeps_space', 'space-1')).toEqual(
            row
        );
    });

    it('returns null when the destination belongs to another squad', async () => {
        // The DO UPDATE ... WHERE squad_id = EXCLUDED.squad_id clause returns no
        // row in that case, which is how the API knows to answer 409 rather than
        // silently moving the destination and orphaning the old squad's stats.
        queryMock.mockResolvedValue({ rows: [] });

        expect(
            await attachToSquad('sq-other', 'discord_guild', 'g1')
        ).toBeNull();
    });
});

describe('detachAttachment', () => {
    it('reports whether a row was removed', async () => {
        queryMock.mockResolvedValue({
            rows: [{ external_id: 'g1' }],
            rowCount: 1,
        });
        expect(await detachAttachment('discord_guild', 'g1')).toBe(true);

        queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
        expect(await detachAttachment('discord_guild', 'g1')).toBe(false);
    });
});

describe('getSquadAttachments', () => {
    it('returns every destination a squad is reachable from', async () => {
        const rows = [
            {
                kind: 'discord_guild',
                external_id: 'g1',
                squad_id: 'sq1',
                attached_at: 'a',
            },
            {
                kind: 'meeps_space',
                external_id: 'space-1',
                squad_id: 'sq1',
                attached_at: 'b',
            },
        ];
        queryMock.mockResolvedValue({ rows });

        expect(await getSquadAttachments('sq1')).toEqual(rows);
    });
});

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

describe('roster operations', () => {
    it('adds with a null added_by when none is given', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await addSummonerToSquad('sq1', 'p1');
        expect(queryMock).toHaveBeenCalledWith(expect.any(String), [
            'sq1',
            'p1',
            null,
        ]);
    });

    it('reports whether a removal deleted anything', async () => {
        queryMock.mockResolvedValue({ rows: [{ puuid: 'p1' }], rowCount: 1 });
        expect(await removeSummonerFromSquad('sq1', 'p1')).toBe(true);

        queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
        expect(await removeSummonerFromSquad('sq1', 'p1')).toBe(false);
    });

    it('restricts the roster read to League summoners', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        await getSummonersForSquad('sq1');

        const [query, params] = queryMock.mock.calls[0];
        expect(query).toContain('FROM squad_summoners ss');
        expect(query).toContain("s.game_id = 'league_of_legends'");
        expect(params).toEqual(['sq1']);
    });

    it('answers membership from rowCount', async () => {
        queryMock.mockResolvedValue({ rows: [{}], rowCount: 1 });
        expect(await isSummonerInSquad('sq1', 'p1')).toBe(true);

        queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
        expect(await isSummonerInSquad('sq1', 'p1')).toBe(false);
    });
});

describe('getSquadsTrackingPuuid', () => {
    it('returns every squad tracking the player, so each gets its own event', async () => {
        queryMock.mockResolvedValue({
            rows: [{ squad_id: 'sq1' }, { squad_id: 'sq2' }],
        });

        expect(await getSquadsTrackingPuuid('p1')).toEqual(['sq1', 'sq2']);
        expect(queryMock).toHaveBeenCalledWith(expect.any(String), ['p1']);
    });

    it('returns an empty list for an untracked player, so no events are emitted', async () => {
        queryMock.mockResolvedValue({ rows: [] });
        expect(await getSquadsTrackingPuuid('p-unknown')).toEqual([]);
    });
});

describe('getAllSquadTrackedPuuids', () => {
    it('flattens to a distinct puuid list for the poller', async () => {
        queryMock.mockResolvedValue({
            rows: [{ puuid: 'p1' }, { puuid: 'p2' }],
        });

        expect(await getAllSquadTrackedPuuids()).toEqual(['p1', 'p2']);
    });
});

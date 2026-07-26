export {};

import {
    isArenaMatch,
    isRankedQueue,
    isScorableMatch,
    countsForCompetition,
    parseCompetitiveScope,
    buildCompetitiveSqlFilter,
    RANKED_QUEUE_IDS,
    KNOWN_ARENA_QUEUE_IDS,
    ARENA_GAME_MODE,
    COMPETITIVE_SCOPES,
} from '../packages/diana-core/src/plugins/diana-league-bot/utils/queueClassification';
import {
    getRankTagsById,
    getQueueNameById,
} from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/dataDragonService';

describe('isArenaMatch', () => {
    it('detects Arena by gameMode regardless of queue ID', () => {
        // The whole point: queue IDs churn, CHERRY does not.
        expect(isArenaMatch('CHERRY', 1700)).toBe(true);
        expect(isArenaMatch('CHERRY', 9999)).toBe(true);
        expect(isArenaMatch('CHERRY', null)).toBe(true);
    });

    it('is case-insensitive on gameMode', () => {
        expect(isArenaMatch('cherry', 0)).toBe(true);
        expect(isArenaMatch('Cherry', 0)).toBe(true);
    });

    it('falls back to known Arena queue IDs when gameMode is missing', () => {
        for (const id of KNOWN_ARENA_QUEUE_IDS) {
            expect(isArenaMatch('Unknown', id)).toBe(true);
            expect(isArenaMatch(null, id)).toBe(true);
        }
    });

    it('covers queue 1750, the ID that surfaced this bug', () => {
        expect(isArenaMatch('Unknown', 1750)).toBe(true);
        expect(getQueueNameById(1750)).toBe('Arena');
    });

    it('accepts string queue IDs from the database', () => {
        expect(isArenaMatch(null, '1750')).toBe(true);
        expect(isArenaMatch(null, '420')).toBe(false);
    });

    it('does not flag Summoner’s Rift or ARAM', () => {
        expect(isArenaMatch('CLASSIC', 420)).toBe(false);
        expect(isArenaMatch('CLASSIC', 440)).toBe(false);
        expect(isArenaMatch('ARAM', 450)).toBe(false);
        expect(isArenaMatch(undefined, undefined)).toBe(false);
    });
});

describe('isRankedQueue', () => {
    it('is true only for Solo/Duo and Flex', () => {
        expect(isRankedQueue(420)).toBe(true);
        expect(isRankedQueue(440)).toBe(true);
        expect(isRankedQueue(450)).toBe(false);
        expect(isRankedQueue(1750)).toBe(false);
        expect(isRankedQueue(0)).toBe(false);
        expect(isRankedQueue(null)).toBe(false);
    });

    it('cannot drift from the LP-tracking lookup', () => {
        // Both read RANKED_QUEUE_TAGS, so a change to one must move the other.
        for (const id of RANKED_QUEUE_IDS) {
            expect(getRankTagsById(id)).not.toBe(false);
        }
        expect(RANKED_QUEUE_IDS).toEqual([420, 440]);
    });
});

describe('isScorableMatch', () => {
    it('excludes Arena and nothing else', () => {
        expect(isScorableMatch({ gameMode: 'CHERRY', queueId: 1750 })).toBe(
            false
        );
        expect(isScorableMatch({ gameMode: 'ARAM', queueId: 450 })).toBe(true);
        expect(isScorableMatch({ gameMode: 'CLASSIC', queueId: 420 })).toBe(
            true
        );
    });
});

describe('countsForCompetition', () => {
    it('excludes Arena under every scope', () => {
        for (const scope of COMPETITIVE_SCOPES) {
            expect(
                countsForCompetition(
                    { gameMode: 'CHERRY', queueId: 1750 },
                    scope
                )
            ).toBe(false);
        }
    });

    it("counts every non-Arena queue under 'all'", () => {
        expect(
            countsForCompetition({ gameMode: 'ARAM', queueId: 450 }, 'all')
        ).toBe(true);
        expect(
            countsForCompetition({ gameMode: 'CLASSIC', queueId: 400 }, 'all')
        ).toBe(true);
        expect(
            countsForCompetition({ gameMode: 'CLASSIC', queueId: 420 }, 'all')
        ).toBe(true);
    });

    it("counts only ranked queues under 'ranked'", () => {
        expect(
            countsForCompetition(
                { gameMode: 'CLASSIC', queueId: 420 },
                'ranked'
            )
        ).toBe(true);
        expect(
            countsForCompetition(
                { gameMode: 'CLASSIC', queueId: 440 },
                'ranked'
            )
        ).toBe(true);
        expect(
            countsForCompetition({ gameMode: 'ARAM', queueId: 450 }, 'ranked')
        ).toBe(false);
    });
});

describe('parseCompetitiveScope', () => {
    it("defaults to 'all' for anything unrecognised", () => {
        expect(parseCompetitiveScope(undefined)).toBe('all');
        expect(parseCompetitiveScope(null)).toBe('all');
        expect(parseCompetitiveScope('nonsense')).toBe('all');
        expect(parseCompetitiveScope('all')).toBe('all');
    });

    it("recognises 'ranked'", () => {
        expect(parseCompetitiveScope('ranked')).toBe('ranked');
    });
});

describe('buildCompetitiveSqlFilter', () => {
    it('always excludes Arena by gameMode and by known IDs', () => {
        const sql = buildCompetitiveSqlFilter('md', 'all');
        expect(sql).toContain(`<> '${ARENA_GAME_MODE}'`);
        expect(sql).toContain('NOT IN (1700,1701,1704,1710,1750)');
        expect(sql).not.toContain('IN (420,440)');
    });

    it("adds a ranked allowlist under 'ranked'", () => {
        const sql = buildCompetitiveSqlFilter('md', 'ranked');
        expect(sql).toContain(`<> '${ARENA_GAME_MODE}'`);
        expect(sql).toContain('md."queueId" IN (420,440)');
    });

    it('respects the table alias', () => {
        expect(buildCompetitiveSqlFilter('match_details', 'all')).toContain(
            'match_details."gameMode"'
        );
    });

    it('emits no bind parameters, so it composes with any $N numbering', () => {
        for (const scope of COMPETITIVE_SCOPES) {
            expect(buildCompetitiveSqlFilter('md', scope)).not.toMatch(/\$\d/);
        }
    });

    it('starts with AND so it can be appended to an existing WHERE', () => {
        expect(buildCompetitiveSqlFilter('md', 'all').trimStart()).toMatch(
            /^AND /
        );
    });
});

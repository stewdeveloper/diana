import {
    buildProfileIconUrl,
    FALLBACK_DDRAGON_VERSION,
    getQueueNameById,
    getRankTagsById,
    getRoleNameTranslation,
} from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/dataDragonService';

// ─── Pure / synchronous helpers ───────────────────────────────────────────────

describe('buildProfileIconUrl', () => {
    it('points at the icon Data Dragon serves for that id', () => {
        expect(buildProfileIconUrl(12, '15.2.1')).toBe(
            'https://ddragon.leagueoflegends.com/cdn/15.2.1/img/profileicon/12.png'
        );
    });

    it('falls back to the pinned version rather than emitting "undefined"', () => {
        // A URL with `undefined` where the version goes renders as a broken
        // image in the `/link` embed, which is the one place the picture *is*
        // the instruction.
        expect(buildProfileIconUrl(0)).toContain(FALLBACK_DDRAGON_VERSION);
    });

    it('handles icon 0, which is a real icon and not a missing one', () => {
        expect(buildProfileIconUrl(0, '15.2.1')).toContain(
            '/profileicon/0.png'
        );
    });
});

describe('getQueueNameById', () => {
    it('returns "Custom Game" for queue 0', () => {
        expect(getQueueNameById(0)).toBe('Custom Game');
    });

    it('returns "Ranked Solo" for queue 420', () => {
        expect(getQueueNameById(420)).toBe('Ranked Solo');
    });

    it('returns "Normal Blind" for queue 430', () => {
        expect(getQueueNameById(430)).toBe('Normal Blind');
    });

    it('returns "Ranked Flex" for queue 440', () => {
        expect(getQueueNameById(440)).toBe('Ranked Flex');
    });

    it('returns "ARAM" for queue 450', () => {
        expect(getQueueNameById(450)).toBe('ARAM');
    });

    it('returns "Swiftplay" for queue 480', () => {
        expect(getQueueNameById(480)).toBe('Swiftplay');
    });

    it('returns "Clash" for queue 700', () => {
        expect(getQueueNameById(700)).toBe('Clash');
    });

    it('returns "ARURF" for queue 900', () => {
        expect(getQueueNameById(900)).toBe('ARURF');
    });

    it('returns "Arena" for every known Arena queue ID', () => {
        // 1750 is the one that showed up as "Unknown Queue (ID: 1750)".
        for (const id of [1700, 1701, 1704, 1710, 1750]) {
            expect(getQueueNameById(id)).toBe('Arena');
        }
    });

    it('returns "Quickplay" for queue 490', () => {
        expect(getQueueNameById(490)).toBe('Quickplay');
    });

    it('returns "Normal Draft" for queue 400', () => {
        expect(getQueueNameById(400)).toBe('Normal Draft');
    });

    it('returns "Ultimate Spellbook" for queue 1400', () => {
        expect(getQueueNameById(1400)).toBe('Ultimate Spellbook');
    });

    it('returns a fallback string containing the unknown ID', () => {
        expect(getQueueNameById(9999)).toBe('Unknown Queue (ID: 9999)');
    });

    it('includes the numeric ID in the fallback for any unknown queue', () => {
        expect(getQueueNameById(123)).toContain('123');
    });

    it('fallback message starts with "Unknown Queue"', () => {
        expect(getQueueNameById(1)).toMatch(/^Unknown Queue/);
    });
});

describe('getRankTagsById', () => {
    it('returns "RANKED_SOLO_5x5" for queue 420', () => {
        expect(getRankTagsById(420)).toBe('RANKED_SOLO_5x5');
    });

    it('returns "RANKED_FLEX_SR" for queue 440', () => {
        expect(getRankTagsById(440)).toBe('RANKED_FLEX_SR');
    });

    it('returns false for ARAM (450)', () => {
        expect(getRankTagsById(450)).toBe(false);
    });

    it('returns false for Custom Game (0)', () => {
        expect(getRankTagsById(0)).toBe(false);
    });

    it('returns false for an unknown queue ID', () => {
        expect(getRankTagsById(9999)).toBe(false);
    });

    it('returns false for all non-ranked queue IDs', () => {
        [0, 430, 450, 480, 700, 900].forEach((id) => {
            expect(getRankTagsById(id)).toBe(false);
        });
    });
});

describe('getRoleNameTranslation', () => {
    it('returns "Top" for TOP', () => {
        expect(getRoleNameTranslation('TOP')).toBe('Top');
    });

    it('returns "Jungle" for JUNGLE', () => {
        expect(getRoleNameTranslation('JUNGLE')).toBe('Jungle');
    });

    it('returns "Mid" for MIDDLE', () => {
        expect(getRoleNameTranslation('MIDDLE')).toBe('Mid');
    });

    it('returns "ADC" for BOTTOM', () => {
        expect(getRoleNameTranslation('BOTTOM')).toBe('ADC');
    });

    it('returns "Support" for UTILITY', () => {
        expect(getRoleNameTranslation('UTILITY')).toBe('Support');
    });

    it('returns "Unknown Role" for an unrecognised string', () => {
        expect(getRoleNameTranslation('MID')).toBe('Unknown Role');
    });

    it('returns "Unknown Role" for an empty string', () => {
        expect(getRoleNameTranslation('')).toBe('Unknown Role');
    });

    it('is case-sensitive - lowercase input does not match', () => {
        expect(getRoleNameTranslation('top')).toBe('Unknown Role');
        expect(getRoleNameTranslation('jungle')).toBe('Unknown Role');
        expect(getRoleNameTranslation('bottom')).toBe('Unknown Role');
    });

    it('returns "Unknown Role" for SUPPORT (not a valid internal key)', () => {
        expect(getRoleNameTranslation('SUPPORT')).toBe('Unknown Role');
    });
});

// ─── Async functions (axios mocked via isolateModules per test) ────────────────
//
// dataDragonService uses module-level caches (cachedLatestVersion,
// championDataCache, championIdMapCache). jest.isolateModules + require()
// gives each test a fresh module instance with empty caches, avoiding
// cross-test pollution.

describe('fetchChampionData', () => {
    it('calls the versions endpoint then the champion endpoint and returns the data map', async () => {
        let fetchChampionData: any;
        let getMock: jest.Mock;

        jest.isolateModules(() => {
            getMock = jest
                .fn()
                .mockResolvedValueOnce({ data: ['15.2.1', '15.1.1'] })
                .mockResolvedValueOnce({
                    data: {
                        data: {
                            Ahri: {
                                key: '103',
                                name: 'Ahri',
                                tags: ['Mage', 'Assassin'],
                            },
                        },
                    },
                });
            jest.mock('axios', () => ({ get: getMock }));
            ({
                fetchChampionData,
            } = require('../packages/diana-core/src/plugins/diana-league-bot/api/utils/dataDragonService'));
        });

        const result = await fetchChampionData();
        expect(result).toHaveProperty('Ahri');
        expect(result.Ahri.name).toBe('Ahri');
        expect(getMock!.mock.calls.length).toBe(2);
    });

    it('uses the first (latest) version string in the champion data URL', async () => {
        let fetchChampionData: any;
        let getMock: jest.Mock;

        jest.isolateModules(() => {
            getMock = jest
                .fn()
                .mockResolvedValueOnce({ data: ['99.0.0', '98.0.0'] })
                .mockResolvedValueOnce({ data: { data: {} } });
            jest.mock('axios', () => ({ get: getMock }));
            ({
                fetchChampionData,
            } = require('../packages/diana-core/src/plugins/diana-league-bot/api/utils/dataDragonService'));
        });

        await fetchChampionData();
        const championCallUrl = getMock!.mock.calls[1][0] as string;
        expect(championCallUrl).toContain('99.0.0');
    });

    it('caches champion data so axios is only called twice even on repeated invocations', async () => {
        let fetchChampionData: any;
        let getMock: jest.Mock;

        jest.isolateModules(() => {
            getMock = jest
                .fn()
                .mockResolvedValueOnce({ data: ['15.2.1'] })
                .mockResolvedValueOnce({
                    data: {
                        data: { Lux: { key: '99', name: 'Lux', tags: [] } },
                    },
                });
            jest.mock('axios', () => ({ get: getMock }));
            ({
                fetchChampionData,
            } = require('../packages/diana-core/src/plugins/diana-league-bot/api/utils/dataDragonService'));
        });

        await fetchChampionData();
        await fetchChampionData(); // should hit cache, not axios again
        expect(getMock!.mock.calls.length).toBe(2); // versions + data, not 4
    });
});

describe('buildChampionIdMap', () => {
    it('indexes champions by their numeric string key', async () => {
        let buildChampionIdMap: any;

        jest.isolateModules(() => {
            const getMock = jest
                .fn()
                .mockResolvedValueOnce({ data: ['15.2.1'] })
                .mockResolvedValueOnce({
                    data: {
                        data: {
                            Ahri: { key: '103', name: 'Ahri', tags: ['Mage'] },
                            Lux: {
                                key: '99',
                                name: 'Lux',
                                tags: ['Mage', 'Support'],
                            },
                        },
                    },
                });
            jest.mock('axios', () => ({ get: getMock }));
            ({
                buildChampionIdMap,
            } = require('../packages/diana-core/src/plugins/diana-league-bot/api/utils/dataDragonService'));
        });

        const result = await buildChampionIdMap();
        expect(result['103'].name).toBe('Ahri');
        expect(result['99'].name).toBe('Lux');
    });

    it('returns an empty object when champion data is empty', async () => {
        let buildChampionIdMap: any;

        jest.isolateModules(() => {
            const getMock = jest
                .fn()
                .mockResolvedValueOnce({ data: ['15.2.1'] })
                .mockResolvedValueOnce({ data: { data: {} } });
            jest.mock('axios', () => ({ get: getMock }));
            ({
                buildChampionIdMap,
            } = require('../packages/diana-core/src/plugins/diana-league-bot/api/utils/dataDragonService'));
        });

        const result = await buildChampionIdMap();
        expect(Object.keys(result).length).toBe(0);
    });
});

describe('getChampionInfoById', () => {
    it('returns name and slash-joined tag string for a known champion', async () => {
        let getChampionInfoById: any;

        jest.isolateModules(() => {
            const getMock = jest
                .fn()
                .mockResolvedValueOnce({ data: ['15.2.1'] })
                .mockResolvedValueOnce({
                    data: {
                        data: {
                            Ahri: {
                                key: '103',
                                name: 'Ahri',
                                tags: ['Mage', 'Assassin'],
                            },
                        },
                    },
                });
            jest.mock('axios', () => ({ get: getMock }));
            ({
                getChampionInfoById,
            } = require('../packages/diana-core/src/plugins/diana-league-bot/api/utils/dataDragonService'));
        });

        const result = await getChampionInfoById('103');
        expect(result.name).toBe('Ahri');
        expect(result.tagString).toBe('Mage/Assassin');
    });

    it('returns Unknown Champion fallback for an unknown numeric ID', async () => {
        let getChampionInfoById: any;

        jest.isolateModules(() => {
            const getMock = jest
                .fn()
                .mockResolvedValueOnce({ data: ['15.2.1'] })
                .mockResolvedValueOnce({ data: { data: {} } });
            jest.mock('axios', () => ({ get: getMock }));
            ({
                getChampionInfoById,
            } = require('../packages/diana-core/src/plugins/diana-league-bot/api/utils/dataDragonService'));
        });

        const result = await getChampionInfoById('9999');
        expect(result.name).toBe('Unknown Champion');
        expect(result.tagString).toBe('Unknown');
    });

    it('returns "Unknown" tagString when champion has an empty tags array', async () => {
        let getChampionInfoById: any;

        jest.isolateModules(() => {
            const getMock = jest
                .fn()
                .mockResolvedValueOnce({ data: ['15.2.1'] })
                .mockResolvedValueOnce({
                    data: {
                        data: {
                            Taric: { key: '44', name: 'Taric', tags: [] },
                        },
                    },
                });
            jest.mock('axios', () => ({ get: getMock }));
            ({
                getChampionInfoById,
            } = require('../packages/diana-core/src/plugins/diana-league-bot/api/utils/dataDragonService'));
        });

        const result = await getChampionInfoById('44');
        expect(result.name).toBe('Taric');
        expect(result.tagString).toBe('Unknown');
    });

    it('returns a single tag without a slash when the champion has exactly one tag', async () => {
        let getChampionInfoById: any;

        jest.isolateModules(() => {
            const getMock = jest
                .fn()
                .mockResolvedValueOnce({ data: ['15.2.1'] })
                .mockResolvedValueOnce({
                    data: {
                        data: {
                            Garen: {
                                key: '86',
                                name: 'Garen',
                                tags: ['Fighter'],
                            },
                        },
                    },
                });
            jest.mock('axios', () => ({ get: getMock }));
            ({
                getChampionInfoById,
            } = require('../packages/diana-core/src/plugins/diana-league-bot/api/utils/dataDragonService'));
        });

        const result = await getChampionInfoById('86');
        expect(result.name).toBe('Garen');
        expect(result.tagString).toBe('Fighter');
    });
});

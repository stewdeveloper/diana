import axios from 'axios';
import { RANKED_QUEUE_TAGS } from '../../utils/queueClassification';

const VERSIONS_URL = 'https://ddragon.leagueoflegends.com/api/versions.json';
const CHAMPION_URL = (version: string) =>
    `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`;

// Used when the Data Dragon version list cannot be fetched
export const FALLBACK_DDRAGON_VERSION = '15.2.1';
const VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let cachedLatestVersion: string | undefined;
let versionFetchedAt = 0;
let championDataCache: Record<string, any>;
let championIdMapCache: Record<string, any>;

export const fetchLatestVersion = async (): Promise<string> => {
    const now = Date.now();
    if (!cachedLatestVersion || now - versionFetchedAt > VERSION_CACHE_TTL_MS) {
        try {
            const { data: versions } = await axios.get(VERSIONS_URL);
            cachedLatestVersion = versions[0];
            versionFetchedAt = now;
        } catch (error) {
            console.error(
                '[DataDragon] Failed to fetch latest version:',
                error
            );
        }
    }
    return cachedLatestVersion || FALLBACK_DDRAGON_VERSION;
};

/**
 * The picture of a profile icon.
 *
 * The League client's icon picker is a grid of images and shows an id nowhere,
 * so "set your icon to #596" asks for something the player cannot look up. The
 * `/link` handshake shows this instead and the number becomes a caption rather
 * than an instruction.
 *
 * Data Dragon serves every icon at this path whether or not the account asking
 * owns it, so a URL resolving is not evidence the icon is selectable — see
 * `CHALLENGE_ICON_IDS`.
 */
export const buildProfileIconUrl = (
    iconId: number,
    version: string = cachedLatestVersion || FALLBACK_DDRAGON_VERSION
): string =>
    `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/${iconId}.png`;

/** The same URL, having made sure the cached version is current. */
export const fetchProfileIconUrl = async (iconId: number): Promise<string> =>
    buildProfileIconUrl(iconId, await fetchLatestVersion());

export const fetchChampionData = async () => {
    if (!championDataCache) {
        const version = await fetchLatestVersion();
        const { data } = await axios.get(CHAMPION_URL(version));
        championDataCache = data.data;
    }
    return championDataCache;
};

export const buildChampionIdMap = async () => {
    if (!championIdMapCache) {
        const champions = await fetchChampionData();
        championIdMapCache = Object.values(champions).reduce((acc, champ) => {
            acc[champ.key] = champ;
            return acc;
        }, {});
    }
    return championIdMapCache;
};

export const getChampionInfoById = async (championId: string) => {
    const champIdMap = await buildChampionIdMap();
    const champion = champIdMap[String(championId)];
    if (!champion) {
        return { name: 'Unknown Champion', tagString: 'Unknown' };
    }
    const tagString =
        champion.tags && champion.tags.length
            ? champion.tags.join('/')
            : 'Unknown';
    return { name: champion.name, tagString };
};

export const getQueueNameById = (queueId: number) => {
    const queueMap = new Map<number, string>([
        [0, 'Custom Game'],
        [400, 'Normal Draft'],
        [420, 'Ranked Solo'],
        [430, 'Normal Blind'],
        [440, 'Ranked Flex'],
        [450, 'ARAM'],
        [480, 'Swiftplay'],
        [490, 'Quickplay'],
        [700, 'Clash'],
        [720, 'ARAM Clash'],
        [830, 'Co-op vs AI Intro'],
        [840, 'Co-op vs AI Beginner'],
        [850, 'Co-op vs AI Intermediate'],
        [900, 'ARURF'],
        [1020, 'One for All'],
        [1400, 'Ultimate Spellbook'],
        // Riot mints new Arena queue IDs regularly. These are the names only -
        // never detect Arena by queue ID, use `isArenaMatch` (gameMode CHERRY).
        [1700, 'Arena'],
        [1701, 'Arena'],
        [1704, 'Arena'],
        [1710, 'Arena'],
        [1750, 'Arena'],
        [1900, 'URF'],
        [2000, 'Tutorial'],
        [2010, 'Tutorial'],
        [2020, 'Tutorial'],
    ]);
    return queueMap.get(queueId) || `Unknown Queue (ID: ${queueId})`;
};

export const getRankTagsById = (queueId: number) =>
    RANKED_QUEUE_TAGS.get(queueId) || false;

export const getRoleNameTranslation = (role: string) => {
    const roleMap = new Map<string, string>([
        ['TOP', 'Top'],
        ['JUNGLE', 'Jungle'],
        ['MIDDLE', 'Mid'],
        ['BOTTOM', 'ADC'],
        ['UTILITY', 'Support'],
    ]);

    return roleMap.get(role) || 'Unknown Role';
};

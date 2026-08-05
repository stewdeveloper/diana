import { Constants } from 'twisted';

/**
 * Platform region → routing region group.
 *
 * Riot splits its API in two: account-v1 is addressed by a *group* (EUROPE,
 * AMERICAS, ASIA, SEA) while summoner-v4 is addressed by a *platform* (EUW1,
 * NA1, …). Anything that resolves a Riot ID and then reads that account's
 * profile - which is every link flow - needs both, and the mapping between them
 * is the sort of thing that gets copied rather than looked up.
 *
 * It lived in `/link` until Meeps needed the same answer for the same reason
 * (022). Here rather than there because it is a fact about Riot's API, not about
 * a Discord command, and a second copy would be a second thing to get wrong when
 * Riot adds a region.
 */
export const REGION_GROUPS: Record<string, string> = {
    [Constants.Regions.EU_WEST]: 'EUROPE',
    [Constants.Regions.EU_EAST]: 'EUROPE',
    [Constants.Regions.TURKEY]: 'EUROPE',
    [Constants.Regions.RUSSIA]: 'EUROPE',
    [Constants.Regions.AMERICA_NORTH]: 'AMERICAS',
    [Constants.Regions.LAT_NORTH]: 'AMERICAS',
    [Constants.Regions.LAT_SOUTH]: 'AMERICAS',
    [Constants.Regions.BRAZIL]: 'AMERICAS',
    [Constants.Regions.KOREA]: 'ASIA',
    [Constants.Regions.JAPAN]: 'ASIA',
    [Constants.Regions.OCEANIA]: 'SEA',
    [Constants.Regions.SINGAPORE]: 'SEA',
};

/** The platform assumed when a caller does not say. */
export const DEFAULT_REGION: string = Constants.Regions.EU_WEST;

/** Whether a string is a platform region this bot will accept. */
export const isKnownRegion = (region: string): boolean =>
    Object.prototype.hasOwnProperty.call(REGION_GROUPS, region);

/**
 * The routing group for a platform region.
 *
 * Falls back to EUROPE rather than throwing, matching what `/link` did: an
 * unrecognised region is a lookup that fails at Riot with a legible 404, which
 * is a better answer than an internal error for what is nearly always a typo.
 */
export const regionGroupFor = (region: string | null | undefined): string =>
    REGION_GROUPS[region ?? ''] ?? 'EUROPE';

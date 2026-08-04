import type {
    IR6Service,
    R6ProfileSnapshot,
    R6RankRung,
    R6StatSnapshot,
} from '../../types.js';
import { fallbackRankLadder, rungForOrdinal } from './rankService.js';

const BASE_URL = 'https://api.r6data.com';

/** Ladder version to request. r6data documents v1–v6; v7 is the current one. */
const RANKS_VERSION = process.env.R6DATA_RANKS_VERSION ?? 'v7';

/**
 * r6data responses, narrowed to the parts this plugin reads.
 *
 * ⚠️ r6data's published docs give the request shape for every endpoint but
 * only a partial response shape for `/api/ranks`, and do not say what the
 * numeric `rank` on a stats profile indexes into. Both are therefore read
 * defensively: unknown field spellings are tolerated, and a ladder that comes
 * back in an unexpected shape falls back to the static one rather than
 * throwing. `toSnapshot` and `parseLadder` are the only two functions that
 * know any of this — that is why `IR6Service` returns domain types.
 */
interface AccountInfoResponse {
    username?: string;
    platform?: string;
    profile_id?: string;
}

interface StatsProfile {
    rank?: number;
    rank_points?: number;
    max_rank?: number;
    max_rank_points?: number;
    kills?: number;
    deaths?: number;
    wins?: number;
    losses?: number;
    abandon?: number;
    update_time?: string;
}

interface StatsResponse {
    platform_families_full_profiles?: Array<{
        profile_id?: string;
        board_ids_full_profiles?: Array<{
            board_id?: string;
            full_profiles?: Array<{
                season_id?: number;
                profile?: StatsProfile;
                season_statistics?: {
                    kills?: number;
                    deaths?: number;
                    match_outcomes?: {
                        wins?: number;
                        losses?: number;
                        abandons?: number;
                    };
                };
            }>;
        }>;
    }>;
}

/** One entry from `/api/ranks`, whose exact spelling the docs do not pin down. */
interface RanksResponseEntry {
    id?: number;
    rank?: number;
    rank_id?: number;
    name?: string;
    rank_name?: string;
    min_mmr?: number;
    max_mmr?: number;
    image?: string;
    imageUrl?: string;
    icon?: string;
}

function num(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Split a ladder label like "Platinum II" or "Champion" into tier + division.
 *
 * Roman numerals only go to V here, which is the whole ladder — a label the
 * regex does not recognise keeps its full text as the tier and division 0,
 * so an unfamiliar rung still renders rather than disappearing.
 */
export function parseRankLabel(label: string | null | undefined): {
    tier: string;
    division: number;
} {
    const raw = (label ?? '').trim();
    if (!raw) return { tier: 'Unranked', division: 0 };

    const match = raw.match(/^(.*?)\s+(V|IV|I{1,3})$/i);
    if (!match) return { tier: raw, division: 0 };

    const numerals: Record<string, number> = {
        i: 1,
        ii: 2,
        iii: 3,
        iv: 4,
        v: 5,
    };
    return {
        tier: (match[1] ?? '').trim(),
        division: numerals[(match[2] ?? '').toLowerCase()] ?? 0,
    };
}

/**
 * Fold `/api/ranks` into the ladder, or return null if it is unusable.
 *
 * Null rather than an empty array or a throw: an unrecognised payload must
 * fall through to the static ladder, not leave every rank rendering as
 * "Unranked" and not take the whole poll down.
 */
export function parseLadder(body: unknown): R6RankRung[] | null {
    const rows: RanksResponseEntry[] = Array.isArray(body)
        ? body
        : Array.isArray((body as { data?: unknown })?.data)
          ? (body as { data: RanksResponseEntry[] }).data
          : Array.isArray((body as { ranks?: unknown })?.ranks)
            ? (body as { ranks: RanksResponseEntry[] }).ranks
            : [];

    const rungs: R6RankRung[] = [];
    for (const row of rows) {
        const label = row?.name ?? row?.rank_name;
        const ordinal = row?.id ?? row?.rank ?? row?.rank_id;
        if (typeof label !== 'string' || typeof ordinal !== 'number') continue;
        const { tier, division } = parseRankLabel(label);
        rungs.push({
            ordinal,
            tier,
            division,
            label,
            minRp: typeof row.min_mmr === 'number' ? row.min_mmr : null,
            iconUrl: row.image ?? row.imageUrl ?? row.icon ?? null,
        });
    }

    if (rungs.length === 0) return null;
    return rungs.sort((a, b) => a.ordinal - b.ordinal);
}

/** Pick the ranked board's newest season profile out of a stats response. */
export function selectRankedProfile(
    body: StatsResponse | undefined
): StatsProfile | null {
    const families = body?.platform_families_full_profiles ?? [];
    for (const family of families) {
        const boards = family?.board_ids_full_profiles ?? [];
        const ranked =
            boards.find((b) => b?.board_id === 'ranked') ?? boards[0];
        const profiles = ranked?.full_profiles ?? [];
        if (profiles.length === 0) continue;
        // Highest season_id wins: a stats response can carry several seasons
        // and the first one is not reliably the current one.
        const newest = [...profiles].sort(
            (a, b) => num(b?.season_id) - num(a?.season_id)
        )[0];
        if (newest?.profile) return newest.profile;
    }
    return null;
}

export function toSnapshot(
    account: AccountInfoResponse | undefined,
    stats: StatsResponse | undefined,
    ladder: R6RankRung[],
    fallbackName: string,
    fallbackPlatform: string
): R6ProfileSnapshot {
    const profile = selectRankedProfile(stats);
    const ordinal = num(profile?.rank);
    const rung = rungForOrdinal(ladder, ordinal);

    const counters: R6StatSnapshot = {
        kills: num(profile?.kills),
        deaths: num(profile?.deaths),
        wins: num(profile?.wins),
        losses: num(profile?.losses),
    };

    return {
        ubisoftId: account?.profile_id ?? fallbackName,
        gameName: account?.username ?? fallbackName,
        platform: account?.platform ?? fallbackPlatform,
        rank: {
            tier: rung?.tier ?? 'Unranked',
            division: rung?.division ?? 0,
            rp: num(profile?.rank_points),
        },
        rankOrdinal: ordinal,
        maxRankOrdinal:
            typeof profile?.max_rank === 'number' ? profile.max_rank : null,
        rankIconUrl: rung?.iconUrl ?? null,
        stats: counters,
        // Derived rather than read: r6data reports raw counters on the ranked
        // profile and no ratio. Guarded so a player with no deaths yet is null
        // instead of Infinity.
        kd: counters.deaths > 0 ? counters.kills / counters.deaths : null,
        isInGame: null,
    };
}

export class R6DataService implements IR6Service {
    private readonly apiKey: string;
    private ladderPromise: Promise<R6RankRung[]> | null = null;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    private async fetch<T>(
        path: string,
        params: Record<string, string> = {}
    ): Promise<T> {
        const url = new URL(`${BASE_URL}${path}`);
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }

        const response = await fetch(url.toString(), {
            headers: { 'api-key': this.apiKey, Accept: 'application/json' },
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw Object.assign(
                new Error(`r6data API error ${response.status}: ${body}`),
                { status: response.status }
            );
        }

        return response.json() as Promise<T>;
    }

    async checkConnection(): Promise<boolean> {
        try {
            await this.fetch('/api/servicestatus');
            return true;
        } catch (err: unknown) {
            const status = (err as { status?: number })?.status;
            return status !== undefined && status !== 401 && status !== 403;
        }
    }

    /**
     * The ladder, fetched once per process.
     *
     * Memoised on the promise, not the value, so concurrent first calls share
     * one request; a failure clears it so the next poll retries rather than
     * caching the static fallback forever.
     */
    async getRankLadder(): Promise<R6RankRung[]> {
        if (this.ladderPromise) return this.ladderPromise;

        this.ladderPromise = this.fetch<unknown>('/api/ranks', {
            version: RANKS_VERSION,
        })
            .then((body) => {
                const parsed = parseLadder(body);
                if (!parsed) {
                    console.warn(
                        '[R6] /api/ranks returned an unrecognised shape; using the static ladder.'
                    );
                    return fallbackRankLadder();
                }
                return parsed;
            })
            .catch((err) => {
                console.warn(
                    '[R6] /api/ranks failed; using the static ladder:',
                    err.message
                );
                this.ladderPromise = null;
                return fallbackRankLadder();
            });

        return this.ladderPromise;
    }

    async getProfileByName(
        name: string,
        platform: string
    ): Promise<R6ProfileSnapshot> {
        const [account, stats, ladder] = await Promise.all([
            this.fetch<AccountInfoResponse>('/api/stats', {
                type: 'accountInfo',
                nameOnPlatform: name,
                platformType: platform,
            }),
            this.fetch<StatsResponse>('/api/stats', {
                type: 'stats',
                nameOnPlatform: name,
                platformType: platform,
                platform_families: platform === 'uplay' ? 'pc' : 'console',
            }),
            this.getRankLadder(),
        ]);
        return toSnapshot(account, stats, ladder, name, platform);
    }
}

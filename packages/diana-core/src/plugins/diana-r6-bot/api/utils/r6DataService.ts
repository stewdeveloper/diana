import type {
    IR6Service,
    R6ProfileSnapshot,
    R6RankRung,
    R6StatSnapshot,
} from '../../types.js';
import {
    fallbackRankLadder,
    rungForOrdinal,
    rungForRp,
} from './rankService.js';

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

/**
 * Charged once per request issued, before it is sent.
 *
 * Before rather than after, and per request rather than per successful request:
 * a 429 or a 500 costs quota at the provider exactly as a 200 does, and a meter
 * that only counted successes would speed up precisely when the provider was
 * pushing back.
 */
export type R6CallMeter = (calls: number) => void;

/**
 * One season on one board.
 *
 * r6data reports the same four counters in two places, and which one is
 * populated is exactly the part of the schema the docs leave open: `profile`
 * carries them flat, `season_statistics` nests wins/losses under
 * `match_outcomes`. `toSnapshot` reads `profile` first and falls back, so
 * whichever spelling the live API uses, the embed is not all zeroes.
 */
interface SeasonEntry {
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
}

interface StatsResponse {
    platform_families_full_profiles?: Array<{
        profile_id?: string;
        board_ids_full_profiles?: Array<{
            board_id?: string;
            full_profiles?: SeasonEntry[];
        }>;
    }>;
}

/**
 * One entry from `/api/ranks`.
 *
 * The vendor publishes no response schema for this endpoint, so this was
 * written blind and got it wrong. The live v7 payload — captured verbatim in
 * `test/fixtures/r6-ranks-v7.json` — is a bare array of 42 rows carrying
 * exactly three keys:
 *
 *     {"name": "Copper 5", "min_mmr": 1000, "max_mmr": 1099}
 *
 * No id, no ordinal, no icon, and divisions in Arabic rather than Roman
 * numerals. The fields beyond those three are kept as tolerated alternatives
 * because the endpoint is versioned and undocumented — `version=v8` is a thing
 * that will happen — but `name`/`min_mmr` are the ones that arrive today, and
 * the fixture is what the tests assert against.
 */
interface RanksResponseEntry {
    id?: unknown;
    rank?: unknown;
    rank_id?: unknown;
    name?: unknown;
    rank_name?: unknown;
    min_mmr?: unknown;
    max_mmr?: unknown;
    image?: unknown;
    imageUrl?: unknown;
    icon?: unknown;
}

function num(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * First of `values` that is actually a number, else 0.
 *
 * Unlike `num`, this distinguishes "absent" from "zero", which is what lets a
 * counter be read from whichever of the two places r6data puts it without the
 * first lookup's `undefined` collapsing to 0 and masking the second.
 */
function firstNum(...values: unknown[]): number {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return 0;
}

const ROMAN_DIVISIONS: Record<string, number> = {
    i: 1,
    ii: 2,
    iii: 3,
    iv: 4,
    v: 5,
};

/**
 * Split a ladder label like "Platinum 2", "Platinum II" or "Champion" into
 * tier + division.
 *
 * Both numeral systems, because the two places a label comes from disagree:
 * `/api/ranks` spells them "Copper 5", the rank metadata under
 * `type=seasonalStats` spells them "PLATINUM II", and `fallbackRankLadder`
 * generates Roman. Reading only Roman is what made every live rung parse as
 * tier "Copper 5" with division 0 — which reads acceptably in an embed but
 * leaves `determineR6RankMovement` unable to find the tier in `R6_TIER_ORDER`,
 * so no promotion or demotion was ever reported.
 *
 * Divisions only go to 5, which is the whole ladder — a label this does not
 * recognise keeps its full text as the tier and division 0, so an unfamiliar
 * rung ("Legend Division", "Unranked") still renders rather than disappearing.
 *
 * Tokenised rather than matched against `/^(.*?)\s+(V|IV|I{1,3})$/i`, which
 * CodeQL flagged as `js/polynomial-redos` (high): `.*?` and `\s+` can both
 * consume a space, so a label that is a long run of them backtracks
 * quadratically. The label comes straight off the provider's `/api/ranks`
 * response — the one payload whose shape the vendor does not document — so it
 * is exactly the input not to hand a quadratic matcher. `split` is linear and
 * the behaviour is unchanged for every label either form recognises.
 */
export function parseRankLabel(label: string | null | undefined): {
    tier: string;
    division: number;
} {
    const raw = (label ?? '').trim();
    if (!raw) return { tier: 'Unranked', division: 0 };

    const parts = raw.split(/\s+/);
    if (parts.length < 2) return { tier: raw, division: 0 };

    const last = parts[parts.length - 1] ?? '';
    const division = divisionFor(last);
    if (division === null) return { tier: raw, division: 0 };

    return { tier: parts.slice(0, -1).join(' '), division };
}

/** A trailing division token, Roman or Arabic, or null if it is neither. */
function divisionFor(token: string): number | null {
    const roman = ROMAN_DIVISIONS[token.toLowerCase()];
    if (roman !== undefined) return roman;
    // Anchored and bounded to a single digit 1-5: "Copper 12" is not a rung,
    // and neither is the "5000" in a label that happens to end in a number.
    return /^[1-5]$/.test(token) ? Number(token) : null;
}

/**
 * Fold `/api/ranks` into the ladder, or return null if it is unusable.
 *
 * Null rather than an empty array or a throw: an unrecognised payload must
 * fall through to the static ladder, not leave every rank rendering as
 * "Unranked" and not take the whole poll down.
 */
export function parseLadder(body: unknown): R6RankRung[] | null {
    const parsed = ladderRows(body)
        .map((row) => {
            const label = firstString(row?.name, row?.rank_name);
            if (label === null) return null;
            return {
                ordinal: firstNumeric(row?.id, row?.rank, row?.rank_id),
                label,
                minRp: firstNumeric(row?.min_mmr),
                iconUrl: firstString(row?.image, row?.imageUrl, row?.icon),
            };
        })
        .filter((row) => row !== null);

    // Whether the payload numbers its rungs *at all* decides what a row without
    // a number means. The live v7 ladder numbers none of them — which is the
    // bug: requiring an ordinal per row rejected all 42 rows and fell through
    // to the static ladder on every poll. But if some row does carry one, a row
    // that does not is a broken row, and inventing a number for it would
    // collide with the real ones.
    const numbered = parsed.some((row) => row.ordinal !== null);
    const usable = numbered
        ? parsed.filter((row) => row.ordinal !== null)
        : // Lowest threshold first. Sorted rather than trusted in payload
          // order because a derived ordinal has to mean *something*, and
          // "climbs with RP" is the only ordering the payload justifies.
          // Left alone when there are no thresholds to sort on.
          parsed.every((row) => row.minRp !== null)
          ? [...parsed].sort((a, b) => a.minRp! - b.minRp!)
          : parsed;

    if (usable.length === 0) return null;

    // The live ladder's bottom row is "Unranked" (0-999 MMR), which is not a
    // rung anyone holds — numbering from it would shift the ladder by one and
    // read every player a rung low. Unranked takes ordinal 0, which is what
    // `rungForOrdinal` already treats as "no rank", so Copper 5 takes 1, the
    // same numbering `fallbackRankLadder` generates.
    const offset = parseRankLabel(usable[0]!.label).tier === 'Unranked' ? 1 : 0;

    const rungs = usable.map((row, index) => {
        const { tier, division } = parseRankLabel(row.label);
        return {
            ordinal: row.ordinal ?? index + 1 - offset,
            tier,
            division,
            label: row.label,
            minRp: row.minRp,
            iconUrl: row.iconUrl,
        };
    });

    return rungs.sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * The rank rows, unwrapped if the payload wraps them.
 *
 * v7 is a bare array. `{data}` and `{ranks}` are kept because the endpoint is
 * versioned and its response schema is published nowhere, so today's shape is
 * not promised to hold — and two extra spellings are cheaper than another
 * round of this.
 */
function ladderRows(body: unknown): RanksResponseEntry[] {
    const wrapper = body as { data?: unknown; ranks?: unknown } | null;
    for (const candidate of [body, wrapper?.data, wrapper?.ranks]) {
        if (Array.isArray(candidate)) return candidate as RanksResponseEntry[];
    }
    return [];
}

/** First of `values` that is a non-empty string, else null. */
function firstString(...values: unknown[]): string | null {
    for (const value of values) {
        if (typeof value === 'string' && value.trim() !== '')
            return value.trim();
    }
    return null;
}

/**
 * First of `values` that is a number, else null.
 *
 * Unlike `firstNum`, absent stays absent — a null ordinal is what tells
 * `parseLadder` the payload is unnumbered, and a null threshold is what stops
 * `getR6RpToNextRank` inventing a target of 0 RP.
 */
function firstNumeric(...values: unknown[]): number | null {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
}

/**
 * A one-line sketch of a payload: its container, and the keys of its first row.
 *
 * The point of the warning this feeds is to make the *next* unrecognised shape
 * diagnosable without an API key, which the old message — which said only that
 * something was wrong — could not do. Keys only, never values: the keys are
 * what `parseLadder` matches on, and a payload is not something to spill whole
 * into a log line. Both lists are capped so a hostile or enormous response
 * cannot flood the log.
 */
export function describeShape(body: unknown): string {
    if (body === null || body === undefined) return String(body);
    if (Array.isArray(body)) {
        return `array(${body.length}) of ${describeRow(body[0])}`;
    }
    if (typeof body !== 'object') return typeof body;

    const keys = Object.keys(body);
    const first = Object.values(body)[0];
    return `object{${capped(keys)}} first value ${describeRow(first)}`;
}

function describeRow(row: unknown): string {
    if (row === null || row === undefined) return String(row);
    if (Array.isArray(row)) return `array(${row.length})`;
    if (typeof row !== 'object') return typeof row;
    return `{${capped(Object.keys(row))}}`;
}

function capped(keys: string[], limit = 12): string {
    const shown = keys.slice(0, limit).map((key) => key.slice(0, 40));
    return keys.length > limit
        ? `${shown.join(',')},…+${keys.length - limit}`
        : shown.join(',');
}

/**
 * Pick the ranked board's newest season entry out of a stats response.
 *
 * Returns the whole `full_profiles` element, not just its `profile`, because
 * r6data reports the same counters in two places — see `toSnapshot`.
 */
export function selectRankedEntry(
    body: StatsResponse | undefined
): SeasonEntry | null {
    const families = body?.platform_families_full_profiles ?? [];
    for (const family of families) {
        const boards = family?.board_ids_full_profiles ?? [];
        // Ranked first, then any other board in the family. Preferring `ranked`
        // but *giving up on the family* when it happens to be empty would skip
        // a populated casual/unranked board sitting right next to it — and for
        // a player whose only board is empty this season, that is the whole
        // response.
        const ordered = [
            ...boards.filter((b) => b?.board_id === 'ranked'),
            ...boards.filter((b) => b?.board_id !== 'ranked'),
        ];
        for (const board of ordered) {
            const profiles = board?.full_profiles ?? [];
            if (profiles.length === 0) continue;
            // Highest season_id wins: a stats response can carry several
            // seasons and the first one is not reliably the current one.
            const newest = [...profiles].sort(
                (a, b) => num(b?.season_id) - num(a?.season_id)
            )[0];
            // Either half is enough to be worth reading: an entry carrying only
            // `season_statistics` still has this season's kills and W/L in it.
            if (newest?.profile || newest?.season_statistics) return newest;
        }
    }
    return null;
}

/** The ranked board's newest season `profile`, or null. */
export function selectRankedProfile(
    body: StatsResponse | undefined
): StatsProfile | null {
    return selectRankedEntry(body)?.profile ?? null;
}

export function toSnapshot(
    account: AccountInfoResponse | undefined,
    stats: StatsResponse | undefined,
    ladder: R6RankRung[],
    fallbackName: string,
    fallbackPlatform: string
): R6ProfileSnapshot {
    const entry = selectRankedEntry(stats);
    const profile = entry?.profile;
    const ordinal = num(profile?.rank);
    const rp = num(profile?.rank_points);

    // RP first, ordinal second. The live ladder publishes no ordinals, so the
    // ones on a parsed ladder are derived here and need not agree with the
    // provider's `rank` — but its RP bands are stated outright, and RP is the
    // same number in both payloads. The ordinal path still runs for the static
    // fallback ladder, which carries no bands.
    const rung = rungForRp(ladder, rp) ?? rungForOrdinal(ladder, ordinal);

    // Counters come from `profile` when it has them and `season_statistics`
    // when it does not. r6data documents both shapes and does not say which a
    // ranked board returns; reading only the first would render a real player
    // as 0 kills / 0W 0L with a null K/D, and — because the poller stores these
    // as the session baseline — would make every session diff zero too. Silent
    // in both cases, which is why it is read defensively rather than guessed.
    const seasonStats = entry?.season_statistics;
    const outcomes = seasonStats?.match_outcomes;
    const counters: R6StatSnapshot = {
        kills: firstNum(profile?.kills, seasonStats?.kills),
        deaths: firstNum(profile?.deaths, seasonStats?.deaths),
        wins: firstNum(profile?.wins, outcomes?.wins),
        losses: firstNum(profile?.losses, outcomes?.losses),
        // Singular on `profile`, plural under `match_outcomes` — the vendor
        // spells the same counter both ways, exactly as it does for the four
        // above, which is why both are read.
        abandons: firstNum(profile?.abandon, outcomes?.abandons),
    };

    return {
        ubisoftId: account?.profile_id ?? fallbackName,
        gameName: account?.username ?? fallbackName,
        platform: account?.platform ?? fallbackPlatform,
        rank: {
            tier: rung?.tier ?? 'Unranked',
            division: rung?.division ?? 0,
            rp,
        },
        // The resolved rung's ordinal, not the provider's. Its only consumer is
        // `getR6RpToNextRank`, which looks the number back up in this same
        // ladder — so it has to be this ladder's numbering, or it finds the
        // wrong rung's threshold. Falls back to the provider's when nothing
        // resolved, which is the unranked case and reads 0 either way.
        rankOrdinal: rung?.ordinal ?? ordinal,
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
    private readonly meter: R6CallMeter;
    private ladderPromise: Promise<R6RankRung[]> | null = null;

    constructor(apiKey: string, meter: R6CallMeter = () => {}) {
        this.apiKey = apiKey;
        this.meter = meter;
    }

    private async fetch<T>(
        path: string,
        params: Record<string, string> = {}
    ): Promise<T> {
        const url = new URL(`${BASE_URL}${path}`);
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }

        // Charged here, in the one place every request passes through. Anywhere
        // else and the next endpoint added to this class would be free by
        // default, which for a monthly cap is the wrong default.
        this.meter(1);

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
                        `[R6] /api/ranks (version=${RANKS_VERSION}) returned an unrecognised shape; using the static ladder. Saw: ${describeShape(body)}`
                    );
                    // Cleared for the same reason the network path clears it:
                    // the fallback carries no RP thresholds, so memoising it
                    // pins `getR6RpToNextRank` to null for the life of the
                    // process. An unrecognised shape is the *likeliest* of the
                    // two failures here — it is the part of the vendor schema
                    // the docs do not pin down — so it is the one that most
                    // needs to recover on the next poll rather than at the
                    // next restart.
                    this.ladderPromise = null;
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

    /** Two requests: resolve the account, then read the stats. */
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
            this.fetchStats(name, platform),
            this.getRankLadder(),
        ]);
        return toSnapshot(account, stats, ladder, name, platform);
    }

    /**
     * One request: the stats, with the account taken from the stored row.
     *
     * This is the poller's path, and halving its cost is what makes a 5-minute
     * cadence affordable at all — see the arithmetic in `r6Budget.ts`. The id and
     * display name are synthesised into the same `AccountInfoResponse` shape
     * `getProfileByName` would have fetched, so `toSnapshot` cannot tell the two
     * callers apart and there is one mapping to keep correct rather than two.
     */
    async getTrackedProfile(player: {
        ubisoftId: string;
        gameName: string;
        platform: string;
    }): Promise<R6ProfileSnapshot> {
        const [stats, ladder] = await Promise.all([
            this.fetchStats(player.gameName, player.platform),
            this.getRankLadder(),
        ]);
        return toSnapshot(
            {
                profile_id: player.ubisoftId,
                username: player.gameName,
                platform: player.platform,
            },
            stats,
            ladder,
            player.gameName,
            player.platform
        );
    }

    private fetchStats(name: string, platform: string): Promise<StatsResponse> {
        return this.fetch<StatsResponse>('/api/stats', {
            type: 'stats',
            nameOnPlatform: name,
            platformType: platform,
            platform_families: platform === 'uplay' ? 'pc' : 'console',
        });
    }
}

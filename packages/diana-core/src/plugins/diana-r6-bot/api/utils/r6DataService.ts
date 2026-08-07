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
 * One entry from `/api/ranks`, whose exact spelling the docs do not pin down.
 *
 * Every field is `unknown` rather than its expected type: this is the one
 * payload the vendor documents no response schema for, so the shape here is a
 * list of *spellings to look for*, not a claim about what arrives. `rank` in
 * particular is both — a number on a stats profile, but a label
 * ("PLATINUM II") in the rank metadata the docs do show — so it is read as
 * whichever of the two it turns out to be.
 */
interface RanksResponseEntry {
    id?: unknown;
    rank?: unknown;
    rank_id?: unknown;
    name?: unknown;
    rank_name?: unknown;
    label?: unknown;
    min_mmr?: unknown;
    mmr_min?: unknown;
    max_mmr?: unknown;
    image?: unknown;
    imageUrl?: unknown;
    image_url?: unknown;
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
 * Split a ladder label like "Platinum II" or "Champion" into tier + division.
 *
 * Roman numerals only go to V here, which is the whole ladder — a label this
 * does not recognise keeps its full text as the tier and division 0, so an
 * unfamiliar rung still renders rather than disappearing.
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
    const division = ROMAN_DIVISIONS[last.toLowerCase()];
    if (division === undefined) return { tier: raw, division: 0 };

    return { tier: parts.slice(0, -1).join(' '), division };
}

/**
 * Fold `/api/ranks` into the ladder, or return null if it is unusable.
 *
 * Null rather than an empty array or a throw: an unrecognised payload must
 * fall through to the static ladder, not leave every rank rendering as
 * "Unranked" and not take the whole poll down.
 */
export function parseLadder(body: unknown): R6RankRung[] | null {
    const rows = ladderRows(body);

    // Read in two passes, because whether the payload numbers its rungs at all
    // decides how a row without a number is treated. When some row carries an
    // ordinal, one that does not is a broken row and is dropped. When *no* row
    // does, the vendor simply does not publish ordinals and dropping every row
    // would throw away a ladder that is otherwise complete — RP thresholds and
    // icons included, which is the whole reason to prefer it to the static one.
    const parsed = rows
        .map((row) => {
            const label = normaliseLabel(
                firstString(row?.name, row?.rank_name, row?.label, row?.rank)
            );
            if (label === null) return null;
            return {
                ordinal: firstNumeric(row?.id, row?.rank_id, row?.rank),
                label,
                minRp: firstNumeric(row?.min_mmr, row?.mmr_min),
                iconUrl: firstString(
                    row?.image,
                    row?.imageUrl,
                    row?.image_url,
                    row?.icon
                ),
            };
        })
        .filter((row) => row !== null);

    const numbered = parsed.some((row) => row.ordinal !== null);
    const usable = numbered
        ? parsed.filter((row) => row.ordinal !== null)
        : // Lowest RP threshold first, which is the order `fallbackRankLadder`
          // numbers in, so a derived ordinal means the same thing a provider
          // one does. Left in payload order when the thresholds are absent
          // too — there is nothing better to sort on, and the vendor's own
          // order is more likely right than an arbitrary one.
          parsed.every((row) => row.minRp !== null)
          ? [...parsed].sort((a, b) => a.minRp! - b.minRp!)
          : parsed;

    if (usable.length === 0) return null;

    const rungs = usable.map((row, index) => {
        const { tier, division } = parseRankLabel(row.label);
        return {
            ordinal: row.ordinal ?? index + 1,
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
 * The rank rows inside whatever the payload wraps them in.
 *
 * Arrays win over objects at every depth: `{data: [...]}` is a wrapped list,
 * whereas an object whose *values* are the rows is a map keyed by ordinal or
 * rank name. Both are shapes the vendor could plausibly return and neither is
 * documented, so both are read rather than one of them guessed at.
 */
function ladderRows(body: unknown): RanksResponseEntry[] {
    type Wrapper = {
        data?: { ranks?: unknown } | unknown;
        ranks?: unknown;
        results?: unknown;
    };
    const wrapper = body as Wrapper | null | undefined;
    const candidates = [
        wrapper?.data,
        wrapper?.ranks,
        wrapper?.results,
        (wrapper?.data as { ranks?: unknown } | undefined)?.ranks,
        body,
    ];

    for (const candidate of candidates) {
        if (Array.isArray(candidate)) return candidate as RanksResponseEntry[];
    }
    for (const candidate of candidates) {
        if (!isRecord(candidate)) continue;
        const values = Object.values(candidate).filter(isRecord);
        if (values.length > 0) return values as RanksResponseEntry[];
    }
    return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * Numeric strings count: a JSON API that spells an id `"18"` is describing the
 * same rung as one that spells it `18`, and the difference is not worth an
 * entire ladder. Unlike `firstNum`, absent stays absent — a null ordinal is
 * what tells `parseLadder` the payload is unnumbered, and a null threshold is
 * what stops `getR6RpToNextRank` inventing a target of 0 RP.
 */
function firstNumeric(...values: unknown[]): number | null {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return null;
}

/**
 * Title-case a shouted label, leaving anything else alone.
 *
 * The rank metadata r6data does document spells labels "PLATINUM II", and that
 * string is what a Discord embed prints and what a promotion message compares
 * against. Only labels with no lower-case letter at all are touched, so a
 * correctly-cased ladder passes through untouched, and Roman divisions keep
 * their capitals.
 */
function normaliseLabel(label: string | null): string | null {
    if (label === null || /[a-z]/.test(label)) return label;
    return label
        .split(/\s+/)
        .map((word) =>
            ROMAN_DIVISIONS[word.toLowerCase()] !== undefined
                ? word
                : word.charAt(0) + word.slice(1).toLowerCase()
        )
        .join(' ');
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
    const rung = rungForOrdinal(ladder, ordinal);

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

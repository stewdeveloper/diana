/**
 * Rainbow Six: Siege plugin types.
 *
 * Shaped after diana-apex-bot rather than diana-league-bot: Siege has no
 * first-party developer API, so — exactly like Apex — everything comes from a
 * third-party stats provider behind a swappable service interface.
 *
 * The one deliberate difference from Apex is that `IR6Service` is defined in
 * terms of `R6ProfileSnapshot`, a normalised domain shape, instead of the
 * vendor's response type. The provider's schema is not versioned in a way we
 * control, so the mapping is confined to r6DataService.ts and every other file
 * in the plugin depends only on the shapes below.
 */

/** A row in `r6_players`. */
export interface R6Player {
    /** Ubisoft profile id — primary key in r6_players. */
    ubisoftId: string;
    gameName: string;
    /** Platform: uplay, psn, xbl */
    platform: string;
    /** Ranked tier name, e.g. "Platinum" or "Champion". */
    tier: string;
    /** Division within the tier: 5 = V (lowest) … 1 = I (highest); 0 unranked. */
    division: number;
    /** Rank points. */
    rp: number;
    currentMatchId: string | null;
    discordChannelId: string | null;
    lastUpdated: string;
    /** Lifetime ranked kills (null = not yet captured). */
    killsSnapshot: number | null;
    /** Lifetime ranked wins (null = not yet captured). */
    winsSnapshot: number | null;
    /** Lifetime ranked losses (null = not yet captured). */
    lossesSnapshot: number | null;
}

export interface R6Rank {
    tier: string;
    division: number;
    rp: number;
}

/** Lifetime ranked counters, used to diff one session against the last poll. */
export interface R6StatSnapshot {
    kills: number;
    deaths: number;
    wins: number;
    losses: number;
}

/**
 * One rung of the ranked ladder.
 *
 * `ordinal` is the provider's numeric `rank` field — the index a stats
 * response reports rather than a name. Everything user-facing goes through
 * this, so a season that adds a tier is a data change, not a code change.
 */
export interface R6RankRung {
    ordinal: number;
    tier: string;
    division: number;
    label: string;
    minRp: number | null;
    iconUrl: string | null;
}

/**
 * The normalised profile every `IR6Service` implementation returns.
 *
 * `isInGame` is `null` rather than `false` on purpose: Siege exposes no live
 * session anywhere, so "not in a game" would be a claim we cannot make.
 */
export interface R6ProfileSnapshot {
    ubisoftId: string;
    gameName: string;
    platform: string;
    rank: R6Rank;
    /** The provider's numeric rank index, kept for ladder lookups. */
    rankOrdinal: number;
    maxRankOrdinal: number | null;
    rankIconUrl: string | null;
    stats: R6StatSnapshot;
    /** Ranked K/D, derived from kills and deaths; null when never died. */
    kd: number | null;
    isInGame: null;
}

export interface IR6Service {
    checkConnection(): Promise<boolean>;
    getProfileByName(
        name: string,
        platform: string
    ): Promise<R6ProfileSnapshot>;
    /** The ranked ladder, provider-supplied and cached by the implementation. */
    getRankLadder(): Promise<R6RankRung[]>;
}

/** R6 bot plugin configuration. */
export interface R6BotConfig {
    /** Cron schedule for rank polling. */
    rankCheckCron: string;
    /** Default Discord channel ID for notifications. */
    defaultDiscordChannelId?: string;
}

export const R6_GAME_ID = 'rainbow_six_siege';

/** r6data's platformType values. */
export const R6_PLATFORMS = ['uplay', 'psn', 'xbl'] as const;
export type R6Platform = (typeof R6_PLATFORMS)[number];

/** Ranked tier order, lowest to highest. */
export const R6_TIER_ORDER = [
    'Copper',
    'Bronze',
    'Silver',
    'Gold',
    'Platinum',
    'Emerald',
    'Diamond',
    'Champion',
] as const;

/**
 * Divisions per tier in the current system.
 *
 * This number has moved twice: Ranked 2.0 (Y8S1) put Champion on its own with
 * no divisions, and Ranked 3.0 (Operation System Override, 2 June 2026) gave
 * every tier five, taking the ladder to 40 rungs. It is a fallback only — the
 * live ladder comes from the provider's ranks endpoint precisely because this
 * constant has a track record of going stale.
 */
export const R6_DIVISIONS_PER_TIER = 5;

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
    /** Lifetime ranked deaths (null = not yet captured). */
    deathsSnapshot: number | null;
    /** Lifetime ranked wins (null = not yet captured). */
    winsSnapshot: number | null;
    /** Lifetime ranked losses (null = not yet captured). */
    lossesSnapshot: number | null;
    /** Lifetime ranked abandons (null = not yet captured). */
    abandonsSnapshot: number | null;
    /**
     * When a call was last spent on this player (migration 023).
     *
     * Not `lastUpdated`, which records when the *rank* last changed. Budgeting
     * needs "when did I last pay for a reading", which is most polls.
     */
    lastPolledAt: string | null;
    /**
     * When this player was last seen moving (migration 023).
     *
     * Vestigial: it drove the adaptive cadence that `r6PollScheduler` replaced
     * with a fixed interval, and nothing reads it now. Kept on the row and on
     * this type because the values are a real record of activity and dropping
     * the column would destroy them for no gain.
     */
    activeUntil: string | null;
}

export interface R6Rank {
    tier: string;
    division: number;
    rp: number;
}

/**
 * Lifetime ranked counters, used to diff one session against the last poll.
 *
 * `abandons` is a third match outcome, not a subset of `losses`. r6data reports
 * it separately, and it is the reason RP can move while wins and losses both
 * stand still — without it, an abandoned match is indistinguishable from a match
 * that never happened, and the one-match branch would read an abandon as a
 * session in which nothing occurred.
 */
export interface R6StatSnapshot {
    kills: number;
    deaths: number;
    wins: number;
    losses: number;
    abandons: number;
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
    /**
     * The same snapshot for a player already in `r6_players`, at half the cost.
     *
     * `getProfileByName` spends two requests: one to turn a name into a Ubisoft
     * profile id and display name, one for the stats. The poller already holds
     * both — they are columns on the row it just read — so for a tracked player
     * the first request buys nothing but a rename check, and at 3,000 requests a
     * month (see `api/utils/r6Budget.ts`) paying it doubles the cost of the
     * entire feature. Registration still uses `getProfileByName`, because there
     * the id is exactly what is not yet known.
     *
     * The trade is explicit: a player who renames on Ubisoft keeps their stored
     * `gameName` on cards until they are re-added. Lookup was already by name
     * and already broke on a rename, so this loses a display-name refresh, not a
     * working case.
     */
    getTrackedProfile(player: {
        ubisoftId: string;
        gameName: string;
        platform: string;
    }): Promise<R6ProfileSnapshot>;
    /** The ranked ladder, provider-supplied and cached by the implementation. */
    getRankLadder(): Promise<R6RankRung[]>;
}

/** R6 bot plugin configuration. */
export interface R6BotConfig {
    /**
     * Cron schedule for the poll heartbeat.
     *
     * This is not the poll cadence. The heartbeat only asks *who is due*; the
     * cadence is per-player and lives in the settings below. Running the
     * heartbeat faster than `pollMinutes` costs nothing — a tick with nobody due
     * spends no requests — and running it slower is what actually delays polls,
     * since a slot can only be noticed by a tick that lands inside it.
     */
    rankCheckCron: string;
    /** Default Discord channel ID for notifications. */
    defaultDiscordChannelId?: string;
    /** Minutes between polls, aligned to clock boundaries. */
    pollMinutes?: number;
    /** `HH:MM` start of the nightly window where nobody is polled. */
    quietHoursStart?: string;
    /** `HH:MM` end of it. Equal to the start means no quiet window. */
    quietHoursEnd?: string;
    /** IANA zone the quiet window is measured in. Defaults to the process TZ. */
    quietHoursTimeZone?: string;
}

export const R6_GAME_ID = 'rainbow_six_siege';

/** r6data's platformType values. */
export const R6_PLATFORMS = ['uplay', 'psn', 'xbl'] as const;
export type R6Platform = (typeof R6_PLATFORMS)[number];

/** Ranked tier order, lowest to highest. Each has `R6_DIVISIONS_PER_TIER`. */
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
 * Tier order for *comparison*, which is `R6_TIER_ORDER` plus the top rung.
 *
 * The live v7 ladder ends with a 42nd row, "Legend Division" (5,000+ MMR),
 * above Champion 1 and with no divisions of its own. It is deliberately not in
 * `R6_TIER_ORDER`, which generates the fallback ladder five divisions to a
 * tier and would invent a "Legend Division 5" that does not exist. But it does
 * have to rank above Champion, or reaching it reads as a demotion.
 */
export const R6_COMPARABLE_TIER_ORDER = [
    ...R6_TIER_ORDER,
    'Legend Division',
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

/**
 * The Squad Wrapped card, as figures (roadmap §7.2).
 *
 * WHY THIS IS NOT A `DianaEvent`
 *
 * Session Recap is an event because a night ending is something that happens
 * and nobody asked. A Wrapped is something somebody asks for, and - decisively -
 * the card is assembled from two sources: these figures plus the group's chat
 * corpus (most-used word, most-reacted message), which lives in Meeps and which
 * Diana cannot see. Pushing this would mean Meeps receiving half a card at a
 * moment of Diana's choosing and holding it until it could join its own half.
 * Pulling means it assembles the card at render time, when it has both halves.
 *
 * DN-3's `GET /api/identity/resolve` is a route rather than an event for the
 * same reason, and §13.4's convention is satisfied either way: a variant that
 * needs a Meeps row shape and an idempotency key is one that gets *delivered*,
 * and this one gets *fetched*.
 *
 * ABSENT MEANS "NOT AWARDED", NEVER "UNKNOWN"
 *
 * Every optional field follows the rule `WeeklyDigestStats` established. A squad
 * with no Meeps space has no `voice` and no `worstNight`; a period where nothing
 * was scored has no `bestGame`. A renderer omits the section rather than drawing
 * a zero, because "0 hours in voice" reads as a fact about the group and is
 * really a fact about their deployment.
 */

import type { WrappedPeriod } from './wrappedPeriod';

/** One named player and a figure, mirroring `WeeklyDigestAward`. */
export interface WrappedAward {
    name: string;
    value: number;
}

export interface WrappedPlayer {
    puuid: string;
    /** Display name as rendered, e.g. "Player#EUW". */
    name: string;
    games: number;
    wins: number;
    losses: number;
    /** 0..1. */
    winRate: number;
    /** Null when none of their games were scored. */
    avgAiScore: number | null;
    kdaRatio: number;
    /** Their own most-picked champion over the period. */
    topChampion: string | null;
}

export interface WrappedDuo {
    /** Display names, in the same order as `puuids`. */
    names: [string, string];
    puuids: [string, string];
    gamesTogether: number;
    winsTogether: number;
    /** 0..1. */
    winRate: number;
}

/** The period's single best individual performance. */
export interface WrappedBestGame {
    matchId: string;
    puuid: string;
    name: string;
    championName: string | null;
    aiScore: number;
    /** ISO 8601, or null when the match row carried no creation time. */
    playedAt: string | null;
}

/**
 * The period's worst *game* - deliberately not its worst player.
 *
 * Same asymmetry, and the same reason, as `SessionLowPoint` in `eventTypes.ts`:
 * a digest ranks individuals across a week and being named is the point, while
 * a card the whole group posts and re-reads is a meaner artifact if it names one
 * of them as the worst. The worst game is the lowest mean squad score, so it
 * names a match.
 */
export interface WrappedWorstGame {
    matchId: string;
    meanAiScore: number;
    /** How many squad scores went into the mean. */
    playerCount: number;
    playedAt: string | null;
}

/** One player's rank movement across the period. */
export interface WrappedLpJourney {
    puuid: string;
    name: string;
    /** Signed league points, where one division is 100. */
    delta: number;
    /** Rendered standing at each end, e.g. "GOLD IV 20 LP". */
    from: string;
    to: string;
}

/** One person's voice time, keyed the way `session_participants` keys it. */
export interface WrappedVoicePerson {
    /**
     * Meeps' own user id. Diana never learns a display name and does not need
     * one - Meeps resolves it when it renders, exactly as it does for a recap.
     */
    meepsUserId: string;
    voiceSeconds: number;
    /** Nights they turned up to. */
    nights: number;
}

export interface WrappedVoice {
    /**
     * Summed across people, so three of them for two hours is 21600. Carried
     * alongside `nights` because neither is derivable from the other.
     */
    totalVoiceSeconds: number;
    nights: number;
    /** Wall clock of the longest single night. */
    longestNightSeconds: number;
    /** Ranked, longest first. Privacy-filtered through identity - see the service. */
    byPerson: WrappedVoicePerson[];
}

/**
 * The night that went worst, by record.
 *
 * "The night you went 0-6" is in the issue verbatim, and it is the line that
 * only this product can write: it needs voice presence sessionised into nights
 * (DN-6) *and* match outcomes, which is the join nobody else has.
 */
export interface WrappedWorstNight {
    sessionId: string;
    startedAt: string;
    endedAt: string | null;
    wins: number;
    losses: number;
    matchCount: number;
}

export interface SquadWrapped {
    squadId: string;
    period: WrappedPeriod;
    /** When these figures were computed. The card is a snapshot, not a record. */
    generatedAt: string;

    /** Distinct matches, not per-player appearances. See `computeSquadRecord`. */
    totalGames: number;
    wins: number;
    losses: number;
    playerCount: number;
    players: WrappedPlayer[];

    topChampion?: WrappedAward;
    topDuo?: WrappedDuo;
    bestGame?: WrappedBestGame;
    worstGame?: WrappedWorstGame;
    biggestClimb?: WrappedLpJourney;
    biggestFall?: WrappedLpJourney;

    /** Absent when the squad has no sessionised nights in the period. */
    voice?: WrappedVoice;
    worstNight?: WrappedWorstNight;
}

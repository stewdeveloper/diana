/**
 * The sweep that finishes a link handshake for you (DN-3).
 *
 * WHY THIS EXISTS
 *
 * `/link start` names an icon; you set it; `/link confirm` reads summoner-v4 and
 * compares. The gap in the middle is not how long you take - it is how long Riot
 * takes to admit the icon changed, and summoner-v4 serves cached data that is
 * reliably slower than a person is. So the flow as shipped asked you to keep
 * running `/link confirm` until an unknowable moment, and the ten-minute window
 * usually expired before that moment arrived.
 *
 * Extending the window alone does not fix that. It replaces "it expired" with
 * "run this command again, repeatedly, for an unknown length of time", which is
 * a worse thing to ask of somebody than a clear failure. So Diana does the
 * waiting: this checks every open handshake and completes the ones Riot has
 * caught up on, and whoever started it gets told when it lands.
 *
 * `/link confirm` still works and is still the fast path for anybody watching -
 * this only removes the obligation to sit there doing it.
 *
 * WHAT IT COSTS
 *
 * One summoner-v4 call per open handshake per tick. Open handshakes are keyed on
 * the Discord user, so the ceiling is "people mid-link right now", which for a
 * bot serving friend groups is a handful. Roadmap §9 costed `/link` at ~2 calls;
 * it is now ~2 plus the sweep, which is why §9 says so.
 */

import {
    deleteExpiredLinkChallenges,
    getPendingLinkChallenges,
    verifyLinkChallenge,
    type LinkChallenge,
} from './identityService';

/** Just enough of `ILolService` to read an icon, so this needs no plugin types. */
export interface LinkSweepLolService {
    getSummonerByPUUID(
        puuid: string,
        region?: string
    ): Promise<{ profileIconId: number }>;
}

/**
 * Told when a handshake completes on its own.
 *
 * Implementations MUST NOT throw: a player with closed DMs must not stop the
 * sweep for everybody else, and the link is already made by the time this is
 * called - the message is the courtesy, not the outcome.
 */
export type LinkVerifiedNotifier = (verified: {
    discordUserId: string;
    puuid: string;
    gameName: string;
    tagLine: string;
}) => Promise<void>;

export interface LinkSweepResult {
    checked: number;
    verified: number;
    /** Still waiting on Riot's cache. The normal outcome, not a failure. */
    pending: number;
    expired: number;
}

export interface LinkSweepOptions {
    now?: number;
    notify?: LinkVerifiedNotifier | null;
}

const DEFAULT_REGION = 'EU_WEST';

function timestamp(): string {
    return new Date().toISOString();
}

/**
 * Check every open handshake, complete the ones that are ready.
 *
 * Every challenge is isolated: one player whose region is wrong, or whose Riot
 * account has been deleted, must not stop the others being checked. A failure
 * leaves the challenge open, which is correct - it will be retried next tick,
 * and the window is now long enough for that to be worth something.
 */
export const runLinkSweep = async (
    lolService: LinkSweepLolService | null | undefined,
    options: LinkSweepOptions = {}
): Promise<LinkSweepResult> => {
    const now = options.now ?? Date.now();
    const result: LinkSweepResult = {
        checked: 0,
        verified: 0,
        pending: 0,
        expired: 0,
    };

    // Done first and unconditionally: expired rows should go even on a
    // deployment with no Riot key, or the table grows forever.
    result.expired = await deleteExpiredLinkChallenges(now);

    if (!lolService) return result;

    const challenges: LinkChallenge[] = await getPendingLinkChallenges(now);
    for (const challenge of challenges) {
        try {
            const profile = await lolService.getSummonerByPUUID(
                challenge.puuid,
                challenge.region ?? DEFAULT_REGION
            );
            result.checked += 1;

            const outcome = await verifyLinkChallenge(
                challenge.discord_user_id,
                profile.profileIconId,
                now
            );

            if (!outcome.ok) {
                // `icon_mismatch` is the expected answer almost every tick:
                // Riot has not caught up yet. Not logged, or the log would be
                // one line per waiting player per tick, forever.
                result.pending += 1;
                continue;
            }

            result.verified += 1;
            try {
                await options.notify?.({
                    discordUserId: challenge.discord_user_id,
                    puuid: challenge.puuid,
                    gameName: challenge.game_name,
                    tagLine: challenge.tag_line,
                });
            } catch (error) {
                // The link is already made. A failed DM costs the player a
                // notification, not their link.
                console.error(
                    `[${timestamp()}] [link-sweep] Could not notify ${challenge.discord_user_id}:`,
                    error
                );
            }
        } catch (error) {
            result.pending += 1;
            console.error(
                `[${timestamp()}] [link-sweep] Could not check ${challenge.puuid}:`,
                error
            );
        }
    }

    if (result.verified > 0) {
        console.log(
            `[${timestamp()}] [link-sweep] Completed ${result.verified} link(s).`
        );
    }

    return result;
};

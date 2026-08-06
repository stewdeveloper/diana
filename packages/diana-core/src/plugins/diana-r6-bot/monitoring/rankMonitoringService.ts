import 'dotenv/config';
import type { MessageAdapter } from '../../../core/pluginTypes.js';
import type { EventAdapter } from '../../../core/eventTypes.js';
import {
    DIANA_EVENT_SCHEMA_VERSION,
    buildR6EventId,
} from '../../../core/eventTypes.js';
import { createR6Service } from '../api/utils/r6ServiceFactory.js';
import {
    getAllTrackedR6Players,
    getR6PlayerById,
    getGuildsTrackingR6Player,
    getSquadsTrackingR6Player,
    updateR6PlayerRankAndSnapshot,
    createR6RankHistory,
    diffSnapshot,
} from '../api/players/playerService.js';
import {
    determineR6RankMovement,
    formatR6Rank,
    getR6RpToNextRank,
} from '../api/utils/rankService.js';
import {
    notifyR6RankChange,
    notifyR6Session,
} from '../notifications/r6Notifications.js';

const r6Service = createR6Service();

export async function runR6Tick(
    adapter: MessageAdapter | null | undefined,
    eventAdapter?: EventAdapter | null
): Promise<void> {
    if (process.env.STOP_BOT === 'true') return;

    let players;
    try {
        players = await getAllTrackedR6Players();
    } catch (err) {
        console.error('[R6] Failed to fetch tracked players:', err);
        return;
    }

    if (players.length === 0) return;
    console.log(`[R6] Tick - checking ${players.length} player(s)`);

    for (const player of players) {
        try {
            await processPlayer(player, adapter, eventAdapter);
        } catch (err) {
            console.error(`[R6] Error processing ${player.gameName}:`, err);
        }
    }
}

async function processPlayer(
    tracked: Awaited<ReturnType<typeof getAllTrackedR6Players>>[number],
    adapter: MessageAdapter | null | undefined,
    eventAdapter?: EventAdapter | null
): Promise<void> {
    // r6data resolves players by name, not by profile id, so the stored
    // gameName is the lookup key. A player who renames on Ubisoft stops
    // resolving until they are re-added — logged by the caller's catch.
    const profile = await r6Service.getProfileByName(
        tracked.gameName,
        tracked.platform
    );
    const player = await getR6PlayerById(tracked.ubisoftId);
    if (!player) return;

    await postSessionIfChanged(
        tracked.ubisoftId,
        player,
        profile,
        adapter,
        eventAdapter
    );
}

async function postSessionIfChanged(
    ubisoftId: string,
    player: NonNullable<Awaited<ReturnType<typeof getR6PlayerById>>>,
    profile: Awaited<ReturnType<typeof r6Service.getProfileByName>>,
    adapter: MessageAdapter | null | undefined,
    eventAdapter?: EventAdapter | null
): Promise<void> {
    const { tier: newTier, division: newDiv, rp: newRp } = profile.rank;

    // Nothing moved since the last poll.
    if (
        player.tier === newTier &&
        player.division === newDiv &&
        player.rp === newRp
    ) {
        return;
    }

    const rankChanged = player.tier !== newTier || player.division !== newDiv;
    const rpChange = newRp - player.rp;
    const gained = diffSnapshot(player, profile.stats);

    const rankMovement = determineR6RankMovement(
        player.tier,
        player.division,
        player.rp,
        newTier,
        newDiv,
        newRp
    );
    const newRankMsg = formatR6Rank(newTier, newDiv, newRp);
    const rpToNextRank = getR6RpToNextRank(
        await r6Service.getRankLadder(),
        profile.rankOrdinal,
        newRp
    );

    console.log(
        `[R6] Session for ${profile.gameName}: ${rpChange > 0 ? '+' : ''}${rpChange} RP → ${newRankMsg}`
    );

    // Persist before notifying: a send failure must not make the next tick
    // replay the same session.
    await updateR6PlayerRankAndSnapshot(
        ubisoftId,
        newTier,
        newDiv,
        newRp,
        profile.stats.kills,
        profile.stats.wins,
        profile.stats.losses
    );
    // Logged rather than swallowed: history is a nice-to-have and must not
    // abort the tick, but a silent `.catch(() => {})` is how the write to
    // `rank_tracking` went unnoticed for as long as it did.
    await createR6RankHistory(
        `R6_SYNC_${ubisoftId}_${Date.now()}`,
        ubisoftId,
        newTier,
        newDiv,
        newRp
    ).catch((err) =>
        console.error(
            `[R6] Failed to record rank history for ${ubisoftId}:`,
            err
        )
    );

    const guilds = await getGuildsTrackingR6Player(ubisoftId);
    for (const guild of guilds) {
        const channelId =
            guild.channel_id ?? process.env.DISCORD_CHANNEL_ID ?? null;
        if (!channelId) continue;

        if (rankChanged && rankMovement !== 'no_change') {
            await notifyR6RankChange(adapter, {
                playerName: profile.gameName,
                direction: rankMovement,
                newRankMsg,
                rankIconUrl: profile.rankIconUrl,
                rpChange,
                rpToNextRank,
                discordChannelId: channelId,
            });
            continue;
        }

        // RP moved without crossing a division. Apex stays silent here; Siege
        // posts a session line instead, because RP-only swings are most of
        // what a Siege evening produces and a silent tick would mean the
        // plugin says nothing for days.
        if (guild.live_posting) {
            await notifyR6Session(adapter, {
                playerName: profile.gameName,
                rpChange,
                newRankMsg,
                rankIconUrl: profile.rankIconUrl,
                killsGained: gained.killsGained,
                winsGained: gained.winsGained,
                lossesGained: gained.lossesGained,
                discordChannelId: channelId,
            });
        }
    }

    await emitR6Events({
        ubisoftId,
        profile,
        rankChanged: rankChanged && rankMovement !== 'no_change',
        rankMovement,
        newRankMsg,
        rpChange,
        rpToNextRank,
        gained,
        eventAdapter,
    });
}

/**
 * The typed event path (DN-1), beside the Discord embeds above.
 *
 * Emitted once per *squad*, not once per guild: an event is a fact about the
 * group, not about a channel — the same call the League poller makes. Two
 * consequences follow, and both are deliberate:
 *
 *   - It is **not** gated on `live_posting` or on a configured channel. Those
 *     answer "should Discord announce this"; a squad's Meeps space should still
 *     get the card when the Discord side is muted.
 *   - A squad with no Discord guild attached gets nothing, because a Siege
 *     player is only reachable through `guild_r6_players`. Meeps-only squads
 *     wait on a roster table of their own.
 *
 * Wrapped in its own try/catch, and behind an adapter that never throws, so a
 * consumer being unreachable cannot break Discord posting.
 *
 * `r6.match.completed` is not emitted here. It needs the one-match branch
 * (`winsGained + lossesGained === 1`) and a five-minute poll for that branch to
 * fire at all — Part B of docs/r6-events-and-post-match.md in Meeps. The
 * discriminator exists in the contract already so Meeps can ship its card
 * first, which is the rollout order the contract README mandates.
 */
async function emitR6Events({
    ubisoftId,
    profile,
    rankChanged,
    rankMovement,
    newRankMsg,
    rpChange,
    rpToNextRank,
    gained,
    eventAdapter,
}: {
    ubisoftId: string;
    profile: Awaited<ReturnType<typeof r6Service.getProfileByName>>;
    rankChanged: boolean;
    rankMovement: ReturnType<typeof determineR6RankMovement>;
    newRankMsg: string;
    rpChange: number;
    rpToNextRank: { rpNeeded: number; nextRankName: string } | null;
    gained: ReturnType<typeof diffSnapshot>;
    eventAdapter?: EventAdapter | null;
}): Promise<void> {
    if (!eventAdapter) return;

    try {
        const squads = await getSquadsTrackingR6Player(ubisoftId);
        if (squads.length === 0) return;

        // r6data reports counters, never a match clock. The poll time is the
        // only timestamp we have, and claiming anything more precise would be
        // inventing one — the match happened somewhere in the preceding window.
        const occurredAt = new Date().toISOString();
        const matchCount = profile.stats.wins + profile.stats.losses;

        const common = {
            schemaVersion: DIANA_EVENT_SCHEMA_VERSION,
            occurredAt,
            ubisoftId,
            gameName: profile.gameName,
            platform: profile.platform,
            rankAfter: newRankMsg,
            tier: profile.rank.tier,
            division: profile.rank.division,
            rp: profile.rank.rp,
            rpChange,
            rankIconUrl: profile.rankIconUrl,
            matchCount,
        } as const;

        for (const squadId of squads) {
            // Mirrors the Discord branch above: a tick is either a rank change
            // or a session, never both, so a squad never sees two cards for one
            // poll.
            if (rankChanged) {
                await eventAdapter.emit({
                    ...common,
                    eventId: buildR6EventId(
                        'r6.rank.changed',
                        squadId,
                        ubisoftId,
                        matchCount,
                        profile.rank.rp
                    ),
                    type: 'r6.rank.changed',
                    squadId,
                    direction:
                        rankMovement === 'promoted' ? 'promoted' : 'demoted',
                    rpToNextRank: rpToNextRank?.rpNeeded ?? null,
                    nextRankName: rpToNextRank?.nextRankName ?? null,
                });
                continue;
            }

            await eventAdapter.emit({
                ...common,
                eventId: buildR6EventId(
                    'r6.session.completed',
                    squadId,
                    ubisoftId,
                    matchCount,
                    profile.rank.rp
                ),
                type: 'r6.session.completed',
                squadId,
                killsGained: gained.killsGained,
                winsGained: gained.winsGained,
                lossesGained: gained.lossesGained,
            });
        }
    } catch (err) {
        console.error(`[R6] Failed to emit events for ${ubisoftId}:`, err);
    }
}

import 'dotenv/config';
import type { MessageAdapter } from '../../../core/pluginTypes.js';
import { createR6Service } from '../api/utils/r6ServiceFactory.js';
import {
    getAllTrackedR6Players,
    getR6PlayerById,
    getGuildsTrackingR6Player,
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
    adapter: MessageAdapter | null | undefined
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
            await processPlayer(player, adapter);
        } catch (err) {
            console.error(`[R6] Error processing ${player.gameName}:`, err);
        }
    }
}

async function processPlayer(
    tracked: Awaited<ReturnType<typeof getAllTrackedR6Players>>[number],
    adapter: MessageAdapter | null | undefined
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

    await postSessionIfChanged(tracked.ubisoftId, player, profile, adapter);
}

async function postSessionIfChanged(
    ubisoftId: string,
    player: NonNullable<Awaited<ReturnType<typeof getR6PlayerById>>>,
    profile: Awaited<ReturnType<typeof r6Service.getProfileByName>>,
    adapter: MessageAdapter | null | undefined
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
    await createR6RankHistory(
        `R6_SYNC_${ubisoftId}_${Date.now()}`,
        ubisoftId,
        newTier,
        newDiv,
        newRp
    ).catch(() => {});

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
}

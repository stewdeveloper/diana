import {
    getAllGuildConfigs,
    getNotificationPref,
    getSquadIdForGuild,
} from '../api/summoners/guildService';
import { buildChampionIdMap } from '../api/utils/dataDragonService';
import { createLolService } from '../api/utils/lolService/lolServiceFactory';
import type { MessageAdapter, MessagePayload } from '../../../core/pluginTypes';
import type { EventAdapter } from '../../../core/eventTypes';
import {
    buildPeriodicEventId,
    DIANA_EVENT_SCHEMA_VERSION,
    toIsoWeek,
} from '../../../core/eventTypes';
import type { LeagueBotConfig } from '../types';

const lolService = createLolService();

async function championNames(championIds: number[]): Promise<string[]> {
    const idMap = await buildChampionIdMap();
    return championIds.map(
        (id) => idMap[String(id)]?.name ?? `Champion #${id}`
    );
}

/**
 * Build the free-rotation post, or null when the rotation is empty.
 * One Riot call per tick, shared by every guild.
 *
 * Returns the champion names alongside the payload so the rotation event can
 * carry them without a second lookup - the payload itself only has them joined
 * into a display string.
 */
export async function buildRotationPost(): Promise<{
    payload: MessagePayload;
    championNames: string[];
} | null> {
    const rotation = await lolService.getChampionRotation();
    if (!rotation || rotation.freeChampionIds.length === 0) return null;

    const names = await championNames(rotation.freeChampionIds);
    names.sort((a, b) => a.localeCompare(b));

    return {
        championNames: names,
        payload: {
            title: '🔄 **Free Champion Rotation**',
            description: "This week's free champions - try something new!",
            colorHex: 0x1e90ff,
            fields: [
                {
                    name: '🆓 **Free to Play**',
                    value: names.join(', '),
                    inline: false,
                },
            ],
            footer: 'Free Rotation • Updates weekly',
            timestamp: new Date().toISOString(),
        },
    };
}

/**
 * Payload-only view of {@link buildRotationPost}.
 */
export async function buildRotationPayload(): Promise<MessagePayload | null> {
    return (await buildRotationPost())?.payload ?? null;
}

export function createRotationPostTick(
    _config: LeagueBotConfig,
    messageAdapter: MessageAdapter | null | undefined,
    eventAdapter?: EventAdapter | null
): () => Promise<void> {
    return async function runRotationPostTick(): Promise<void> {
        if (process.env.STOP_BOT) {
            console.log(
                `[Info] [${new Date().toISOString()}] Stop bot enabled, skipping rotation post...`
            );
            return;
        }
        if (!messageAdapter) {
            console.warn(
                '[Rotation] No message adapter set; skipping rotation post.'
            );
            return;
        }

        const guilds = await getAllGuildConfigs();
        const optedIn = guilds.filter(
            (guild) =>
                guild.channel_id && getNotificationPref(guild, 'rotation')
        );
        if (optedIn.length === 0) return;

        let post: Awaited<ReturnType<typeof buildRotationPost>>;
        try {
            post = await buildRotationPost();
        } catch (error) {
            console.error(
                '[Error] Failed to fetch the free champion rotation:',
                error
            );
            return;
        }
        if (!post) return;
        const { payload, championNames: names } = post;
        const isoWeek = toIsoWeek(new Date());

        for (const guild of optedIn) {
            try {
                await messageAdapter.sendMessage(
                    { channelId: guild.channel_id as string },
                    payload
                );
                console.log(
                    `[Info] [${new Date().toISOString()}] Sent rotation post to guild ${guild.guild_id}.`
                );
            } catch (error) {
                console.error(
                    `[Error] Failed to send rotation post to guild ${guild.guild_id}:`,
                    error
                );
            }

            // Keyed on the squad and the ISO week, so a redeploy that re-runs
            // the cron in the same week - or a second guild attached to the same
            // squad - cannot create a second row.
            try {
                const squadId = await getSquadIdForGuild(guild.guild_id);
                if (squadId) {
                    await eventAdapter?.emit({
                        schemaVersion: DIANA_EVENT_SCHEMA_VERSION,
                        eventId: buildPeriodicEventId(
                            'rotation.weekly',
                            squadId,
                            isoWeek
                        ),
                        type: 'rotation.weekly',
                        occurredAt: new Date().toISOString(),
                        guildId: guild.guild_id,
                        squadId,
                        isoWeek,
                        championNames: names,
                    });
                }
            } catch (error) {
                console.error(
                    `[Error] Failed to emit rotation event for guild ${guild.guild_id}:`,
                    error
                );
            }
        }
    };
}

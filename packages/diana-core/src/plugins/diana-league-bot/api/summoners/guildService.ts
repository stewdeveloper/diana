import { db } from '../utils/db.js';
import {
    type CompetitiveScope,
    parseCompetitiveScope,
} from '../../utils/queueClassification';

export interface GuildConfig {
    guild_id: string;
    channel_id: string | null;
    live_posting: boolean;
    notification_prefs: Record<string, boolean> | null;
    competitive_scope: CompetitiveScope | null;
    created_at: string;
}

export type NotificationPrefKey =
    | 'match_posts'
    | 'rank_posts'
    | 'streaks'
    | 'digest'
    | 'rotation'
    | 'live_alerts';

export const NOTIFICATION_PREF_DEFAULTS: Record<NotificationPrefKey, boolean> =
    {
        match_posts: true,
        rank_posts: true,
        streaks: true,
        digest: true,
        rotation: false,
        live_alerts: false,
    };

/**
 * Effective value of a notification preference. Explicit prefs win; the
 * match/rank post types fall back to the legacy live_posting column so
 * existing opt-outs keep working; everything else uses the defaults table.
 */
export const getNotificationPref = (
    config:
        | Pick<GuildConfig, 'live_posting' | 'notification_prefs'>
        | null
        | undefined,
    key: NotificationPrefKey
): boolean => {
    const explicit = config?.notification_prefs?.[key];
    if (typeof explicit === 'boolean') return explicit;
    if ((key === 'match_posts' || key === 'rank_posts') && config) {
        return config.live_posting;
    }
    return NOTIFICATION_PREF_DEFAULTS[key];
};

/**
 * Which queues a guild's competitive stats (MVP, Inter of the Week,
 * leaderboards, streaks, digest) consider. Arena is excluded from both scopes -
 * see `queueClassification`.
 *
 * Sync variant, for rows already loaded (e.g. the per-guild notification
 * fan-out); use `getGuildCompetitiveScope` when you only have a guild id.
 */
export const getCompetitiveScopeFromConfig = (
    config: Pick<GuildConfig, 'competitive_scope'> | null | undefined
): CompetitiveScope => parseCompetitiveScope(config?.competitive_scope);

export const getGuildCompetitiveScope = async (
    guildId: string | null | undefined
): Promise<CompetitiveScope> => {
    if (!guildId) return parseCompetitiveScope(undefined);
    return getCompetitiveScopeFromConfig(await getGuildConfig(guildId));
};

export interface GuildSummonerRow {
    guild_id: string;
    puuid: string;
    gameName: string;
    tagLine: string;
    region: string;
    tier: string;
    rank: string;
    lp: number;
    deepLolLink: string | null;
    matchRegionPrefix: string;
    regionGroup: string;
    added_by: string | null;
    added_at: string;
}

export const getGuildConfig = async (
    guildId: string
): Promise<GuildConfig | null> => {
    const result = await db.query(
        `SELECT * FROM guild_config WHERE guild_id = $1`,
        [guildId]
    );
    return result.rows[0] ?? null;
};

export const getOrCreateGuildConfig = async (
    guildId: string
): Promise<GuildConfig> => {
    const result = await db.query(
        `INSERT INTO guild_config (guild_id)
         VALUES ($1)
         ON CONFLICT (guild_id) DO UPDATE SET guild_id = EXCLUDED.guild_id
         RETURNING *`,
        [guildId]
    );
    return result.rows[0];
};

export const setGuildChannel = async (
    guildId: string,
    channelId: string
): Promise<GuildConfig> => {
    const result = await db.query(
        `INSERT INTO guild_config (guild_id, channel_id)
         VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE SET channel_id = EXCLUDED.channel_id
         RETURNING *`,
        [guildId, channelId]
    );
    return result.rows[0];
};

export const setGuildLivePosting = async (
    guildId: string,
    enabled: boolean
): Promise<GuildConfig> => {
    const result = await db.query(
        `INSERT INTO guild_config (guild_id, live_posting)
         VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE SET live_posting = EXCLUDED.live_posting
         RETURNING *`,
        [guildId, enabled]
    );
    return result.rows[0];
};

export const setGuildCompetitiveScope = async (
    guildId: string,
    scope: CompetitiveScope
): Promise<GuildConfig> => {
    const result = await db.query(
        `INSERT INTO guild_config (guild_id, competitive_scope)
         VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE SET competitive_scope = EXCLUDED.competitive_scope
         RETURNING *`,
        [guildId, scope]
    );
    return result.rows[0];
};

export const setGuildNotificationPref = async (
    guildId: string,
    key: NotificationPrefKey,
    enabled: boolean
): Promise<GuildConfig> => {
    const result = await db.query(
        `INSERT INTO guild_config (guild_id, notification_prefs)
         VALUES ($1, jsonb_build_object($2::text, $3::boolean))
         ON CONFLICT (guild_id) DO UPDATE
             SET notification_prefs = COALESCE(guild_config.notification_prefs, '{}'::jsonb)
                 || jsonb_build_object($2::text, $3::boolean)
         RETURNING *`,
        [guildId, key, enabled]
    );
    return result.rows[0];
};

export const addSummonerToGuild = async (
    guildId: string,
    puuid: string,
    addedBy?: string
): Promise<void> => {
    await db.query(
        `INSERT INTO guild_summoners (guild_id, puuid, added_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (guild_id, puuid) DO NOTHING`,
        [guildId, puuid, addedBy ?? null]
    );
};

export const removeSummonerFromGuild = async (
    guildId: string,
    puuid: string
): Promise<boolean> => {
    const result = await db.query(
        `DELETE FROM guild_summoners WHERE guild_id = $1 AND puuid = $2 RETURNING puuid`,
        [guildId, puuid]
    );
    return result.rowCount !== null && result.rowCount > 0;
};

export const getSummonersForGuild = async (
    guildId: string
): Promise<GuildSummonerRow[]> => {
    const result = await db.query(
        `SELECT gs.guild_id, gs.puuid, gs.added_by, gs.added_at,
                s."gameName", s."tagLine", s."region", s."tier", s."rank", s."lp",
                s."deepLolLink", s."matchRegionPrefix", s."regionGroup"
         FROM guild_summoners gs
         JOIN summoners s ON s.puuid = gs.puuid
         WHERE gs.guild_id = $1
           AND s.game_id = 'league_of_legends'
         ORDER BY s."gameName" ASC`,
        [guildId]
    );
    return result.rows;
};

export const isSummonerInGuild = async (
    guildId: string,
    puuid: string
): Promise<boolean> => {
    const result = await db.query(
        `SELECT 1 FROM guild_summoners WHERE guild_id = $1 AND puuid = $2`,
        [guildId, puuid]
    );
    return result.rowCount !== null && result.rowCount > 0;
};

export interface GuildNotificationTarget {
    guild_id: string;
    channel_id: string;
    live_posting: boolean;
    notification_prefs: Record<string, boolean> | null;
    competitive_scope: CompetitiveScope | null;
}

export const getGuildsTrackingSummoner = async (
    puuid: string
): Promise<GuildNotificationTarget[]> => {
    const result = await db.query(
        `SELECT gc.guild_id, gc.channel_id, gc.live_posting, gc.notification_prefs,
                gc.competitive_scope
         FROM guild_summoners gs
         JOIN guild_config gc ON gc.guild_id = gs.guild_id
         WHERE gs.puuid = $1
           AND gc.channel_id IS NOT NULL`,
        [puuid]
    );
    return result.rows;
};

/** All guilds with a configured notification channel. */
export const getAllGuildConfigs = async (): Promise<GuildConfig[]> => {
    const result = await db.query(
        `SELECT * FROM guild_config WHERE channel_id IS NOT NULL`,
        []
    );
    return result.rows;
};

export const getAllTrackedPuuids = async (): Promise<string[]> => {
    const result = await db.query(
        `SELECT DISTINCT gs.puuid
         FROM guild_summoners gs
         JOIN summoners s ON s.puuid = gs.puuid
         WHERE s.game_id = 'league_of_legends'`,
        []
    );
    return result.rows.map((row: { puuid: string }) => row.puuid);
};

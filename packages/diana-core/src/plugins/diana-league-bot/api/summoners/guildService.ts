import { db } from '../utils/db.js';
import {
    type CompetitiveScope,
    parseCompetitiveScope,
} from '../../utils/queueClassification';
import {
    addSummonerToSquad,
    getAllSquadTrackedPuuids,
    getOrCreateSquadForAttachment,
    getSquadIdForAttachment,
    getSummonersForSquad,
    isSummonerInSquad,
    removeSummonerFromSquad,
} from '../../../../core/squads/squadService';

/**
 * Since DN-2 the roster lives on the squad, not the guild. A Discord guild is an
 * *attachment* to a squad, and `guild_config` below is that attachment's
 * delivery configuration - channel, notification prefs, competitive scope.
 *
 * The roster functions keep their `*Guild` names and signatures because a
 * Discord command legitimately holds a `guildId`; they resolve it to a squad and
 * delegate. Resolution at the edge is the whole point of an attachment.
 */
const DISCORD_GUILD = 'discord_guild' as const;

/** The squad behind a Discord guild, or null if the guild has never been used. */
export const getSquadIdForGuild = (guildId: string): Promise<string | null> =>
    getSquadIdForAttachment(DISCORD_GUILD, guildId);

/**
 * The squad behind a Discord guild, creating it on first use.
 *
 * Only write paths should call this. Reads use `getSquadIdForGuild` so that
 * querying an unknown guild returns nothing rather than conjuring an empty squad.
 */
export const getOrCreateSquadIdForGuild = (guildId: string): Promise<string> =>
    getOrCreateSquadForAttachment(DISCORD_GUILD, guildId);

export interface GuildConfig {
    guild_id: string;
    channel_id: string | null;
    live_posting: boolean;
    notification_prefs: Record<string, boolean> | null;
    competitive_scope: CompetitiveScope | null;
    /**
     * Whether `/link` may complete without the icon handshake (DN-3).
     *
     * Nullable in the type, not in the column: a row written before migration
     * 019 reads back as undefined through some drivers, and treating that as
     * "allowed" would turn a missing column into an open door.
     */
    allow_trusted_links: boolean | null;
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

/**
 * Whether this server lets `/link` skip verification (DN-3).
 *
 * Defaults closed on anything other than an explicit `true`, so a missing row,
 * a missing column and an explicit `false` all mean the same safe thing.
 */
export const allowsTrustedLinks = (
    config: Pick<GuildConfig, 'allow_trusted_links'> | null | undefined
): boolean => config?.allow_trusted_links === true;

export const getGuildAllowsTrustedLinks = async (
    guildId: string
): Promise<boolean> => allowsTrustedLinks(await getGuildConfig(guildId));

export const setGuildAllowTrustedLinks = async (
    guildId: string,
    allowed: boolean
): Promise<GuildConfig> => {
    const result = await db.query(
        `INSERT INTO guild_config (guild_id, allow_trusted_links)
         VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE SET allow_trusted_links = EXCLUDED.allow_trusted_links
         RETURNING *`,
        [guildId, allowed]
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
    const squadId = await getOrCreateSquadIdForGuild(guildId);
    await addSummonerToSquad(squadId, puuid, addedBy);
};

export const removeSummonerFromGuild = async (
    guildId: string,
    puuid: string
): Promise<boolean> => {
    const squadId = await getSquadIdForGuild(guildId);
    if (!squadId) return false;
    return removeSummonerFromSquad(squadId, puuid);
};

export const getSummonersForGuild = async (
    guildId: string
): Promise<GuildSummonerRow[]> => {
    const squadId = await getSquadIdForGuild(guildId);
    if (!squadId) return [];
    const rows = await getSummonersForSquad(squadId);
    // Callers still think in guilds, so hand back the guild they asked about
    // rather than leaking the squad id into presentation code.
    return rows.map(({ squad_id: _squadId, ...rest }) => ({
        ...rest,
        guild_id: guildId,
    }));
};

export const isSummonerInGuild = async (
    guildId: string,
    puuid: string
): Promise<boolean> => {
    const squadId = await getSquadIdForGuild(guildId);
    if (!squadId) return false;
    return isSummonerInSquad(squadId, puuid);
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
         FROM squad_summoners ss
         JOIN squad_attachments sa
           ON sa.squad_id = ss.squad_id AND sa.kind = 'discord_guild'
         JOIN guild_config gc ON gc.guild_id = sa.external_id
         WHERE ss.puuid = $1
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

/**
 * Every League summoner tracked by any squad.
 *
 * Squad-wide, not guild-wide: a summoner tracked only through a Meeps space is
 * still polled, which is the point of the portable scope.
 */
export const getAllTrackedPuuids = (): Promise<string[]> =>
    getAllSquadTrackedPuuids();

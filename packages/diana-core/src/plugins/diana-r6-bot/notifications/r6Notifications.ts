import type {
    MessageAdapter,
    MessagePayload,
} from '../../../core/pluginTypes.js';

const r6RankColors = new Map<string, number>([
    ['Copper', 0x7c4a2d],
    ['Bronze', 0xcd7f32],
    ['Silver', 0xc0c0c0],
    ['Gold', 0xffd700],
    ['Platinum', 0x22c1c3],
    ['Emerald', 0x2ecc71],
    ['Diamond', 0x00bfff],
    ['Champion', 0xe74c3c],
]);

// ─── Rank Change ──────────────────────────────────────────────────────────────

interface RankChangeInput {
    playerName: string;
    direction: 'promoted' | 'demoted';
    newRankMsg: string;
    rpChange: number;
    rankIconUrl?: string | null;
    rpToNextRank: { rpNeeded: number; nextRankName: string } | null;
    discordChannelId: string;
}

export function buildR6RankChangeMessage({
    playerName,
    direction,
    newRankMsg,
    rpChange,
    rankIconUrl,
    rpToNextRank,
}: Omit<RankChangeInput, 'discordChannelId'>): MessagePayload {
    const isPromotion = direction === 'promoted';
    const tier = newRankMsg.split(' ')[0] ?? '';
    const colorHex = r6RankColors.get(tier) ?? 0x3498db;
    const rpSign = rpChange > 0 ? '+' : '';

    const fields: MessagePayload['fields'] = [
        {
            name: '🏆 **New Rank**',
            value: `**${newRankMsg}**`,
            inline: true,
        },
        {
            name: '🔄 **RP Change**',
            value: `**${rpSign}${rpChange} RP**`,
            inline: true,
        },
    ];

    if (rpToNextRank !== null) {
        fields.push({
            name: '🎯 **Next Rank**',
            value: `**${rpToNextRank.rpNeeded} RP** to ${rpToNextRank.nextRankName}`,
            inline: true,
        });
    }

    return {
        title: isPromotion ? '📈 **Rank Up!**' : '📉 **Rank Down...**',
        description: isPromotion
            ? `${playerName} has ranked up in Rainbow Six Siege!`
            : `${playerName} has been demoted in Rainbow Six Siege.`,
        colorHex,
        thumbnailUrl: rankIconUrl ?? undefined,
        fields,
        footer: 'Rainbow Six Siege Rank Notification',
        timestamp: new Date().toISOString(),
    };
}

export async function notifyR6RankChange(
    adapter: MessageAdapter | null | undefined,
    input: RankChangeInput
): Promise<boolean> {
    const { discordChannelId, ...payload } = input;
    const message = buildR6RankChangeMessage(payload);
    return sendWithAdapter(adapter, discordChannelId, message, 'rank change');
}

// ─── Session Summary ──────────────────────────────────────────────────────────

interface SessionInput {
    playerName: string;
    rpChange: number;
    newRankMsg: string;
    rankIconUrl?: string | null;
    /** Ranked kills gained this session — null if no snapshot baseline yet. */
    killsGained: number | null;
    winsGained: number | null;
    lossesGained: number | null;
    discordChannelId: string;
}

export function buildR6SessionMessage({
    playerName,
    rpChange,
    newRankMsg,
    rankIconUrl,
    killsGained,
    winsGained,
    lossesGained,
}: Omit<SessionInput, 'discordChannelId'>): MessagePayload {
    const tier = newRankMsg.split(' ')[0] ?? '';
    const colorHex = r6RankColors.get(tier) ?? 0x95a5a6;
    const rpSign = rpChange > 0 ? '+' : '';

    const fields: MessagePayload['fields'] = [
        {
            name: '🔄 **RP Change**',
            value: `**${rpSign}${rpChange} RP**`,
            inline: true,
        },
        {
            name: '🏅 **Current Rank**',
            value: `**${newRankMsg}**`,
            inline: true,
        },
    ];

    // A null snapshot is the first sighting of this player, not a quiet
    // session — the stats block is omitted entirely rather than shown as zero.
    const hasBaseline =
        killsGained !== null || winsGained !== null || lossesGained !== null;
    const anyNonZero =
        (killsGained ?? 0) > 0 ||
        (winsGained ?? 0) > 0 ||
        (lossesGained ?? 0) > 0;

    if (hasBaseline && anyNonZero) {
        if ((winsGained ?? 0) > 0 || (lossesGained ?? 0) > 0) {
            fields.push({
                name: '📊 **W / L**',
                value: `**${winsGained ?? 0}W ${lossesGained ?? 0}L**`,
                inline: true,
            });
        }
        if ((killsGained ?? 0) > 0) {
            fields.push({
                name: '⚔️ **Kills**',
                value: `**+${killsGained}**`,
                inline: true,
            });
        }
    } else if (hasBaseline && !anyNonZero) {
        fields.push({
            name: '📊 **Stats**',
            value: '*No tracked change*',
            inline: true,
        });
    }

    return {
        title: '🎮 **Session Update**',
        description: `${playerName} played a session in Rainbow Six Siege!`,
        colorHex,
        thumbnailUrl: rankIconUrl ?? undefined,
        fields,
        footer: 'Rainbow Six Siege Session',
        timestamp: new Date().toISOString(),
    };
}

export async function notifyR6Session(
    adapter: MessageAdapter | null | undefined,
    input: SessionInput
): Promise<boolean> {
    const { discordChannelId, ...payload } = input;
    const message = buildR6SessionMessage(payload);
    return sendWithAdapter(adapter, discordChannelId, message, 'session');
}

// ─── Shared sender ────────────────────────────────────────────────────────────

async function sendWithAdapter(
    adapter: MessageAdapter | null | undefined,
    channelId: string,
    payload: MessagePayload,
    label: string
): Promise<boolean> {
    if (!adapter) {
        console.warn(
            `[R6 Notification] No message adapter; skipping ${label}.`
        );
        return true;
    }
    try {
        await adapter.sendMessage({ channelId }, payload);
        return true;
    } catch (err) {
        console.error(`[R6 Notification] Failed to send ${label}:`, err);
        return false;
    }
}

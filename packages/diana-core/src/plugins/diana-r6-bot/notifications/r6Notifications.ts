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

// ─── Single Match ─────────────────────────────────────────────────────────────
//
// Part B of Meeps' docs/r6-events-and-post-match.md, and the sparsest embed in
// the plugin on purpose.
//
// Siege has no first-party developer API and the third-party provider returns
// season-cumulative counters, so there is no match record to read: no operator,
// no map, no teammates, no duration, no per-match score. What this embed says is
// everything a single match *can* be known to have been — outcome, RP swing,
// resulting rank, and the kills and deaths attributable to it — and that is
// accepted deliberately rather than treated as a first cut. The one thing it
// must not do is imply more precision than the inference supports.

interface MatchInput {
    playerName: string;
    /** Won, lost, or — when null — abandoned. */
    win: boolean | null;
    rpChange: number;
    newRankMsg: string;
    rankIconUrl?: string | null;
    /** Kills in this match. Null when the player has no kills baseline. */
    kills: number | null;
    /** Deaths in this match. Null when the deaths baseline predates 023. */
    deaths: number | null;
    discordChannelId: string;
}

/** 'Victory' | 'Defeat' | 'Abandoned' — the one place the wording is decided. */
export function r6MatchResultLabel(win: boolean | null): string {
    if (win === true) return 'Victory';
    if (win === false) return 'Defeat';
    return 'Abandoned';
}

export function buildR6MatchMessage({
    playerName,
    win,
    rpChange,
    newRankMsg,
    rankIconUrl,
    kills,
    deaths,
}: Omit<MatchInput, 'discordChannelId'>): MessagePayload {
    const result = r6MatchResultLabel(win);
    const rpSign = rpChange > 0 ? '+' : '';

    // Outcome colours the embed, not the tier. On the session and rank-change
    // embeds the tier is the subject; here the subject is "did you win", and a
    // Platinum player losing should not get the same cheerful teal as one
    // winning. An abandon is neither, so it takes the tier colour.
    const tier = newRankMsg.split(' ')[0] ?? '';
    const colorHex =
        win === true
            ? 0x2ecc71
            : win === false
              ? 0xe74c3c
              : (r6RankColors.get(tier) ?? 0x95a5a6);

    const fields: MessagePayload['fields'] = [
        {
            name: '🔄 **RP Change**',
            value: `**${rpSign}${rpChange} RP**`,
            inline: true,
        },
        {
            name: '🏅 **Rank**',
            value: `**${newRankMsg}**`,
            inline: true,
        },
    ];

    // Both halves or neither. "8 / —" is not a K/D, and a player whose deaths
    // baseline predates migration 023 legitimately has one poll in that state.
    if (kills !== null && deaths !== null) {
        fields.push({
            name: '⚔️ **K / D**',
            value: `**${kills} / ${deaths}**`,
            inline: true,
        });
    } else if (kills !== null) {
        fields.push({
            name: '⚔️ **Kills**',
            value: `**${kills}**`,
            inline: true,
        });
    }

    return {
        title:
            win === true
                ? '🏆 **Victory!**'
                : win === false
                  ? '💀 **Defeat**'
                  : '🚪 **Match Abandoned**',
        description:
            win === null
                ? `${playerName} abandoned a ranked match in Rainbow Six Siege.`
                : `${playerName} finished a ranked match in Rainbow Six Siege.`,
        colorHex,
        thumbnailUrl: rankIconUrl ?? undefined,
        fields,
        footer: `Rainbow Six Siege · ${result}`,
        timestamp: new Date().toISOString(),
    };
}

export async function notifyR6Match(
    adapter: MessageAdapter | null | undefined,
    input: MatchInput
): Promise<boolean> {
    const { discordChannelId, ...payload } = input;
    const message = buildR6MatchMessage(payload);
    return sendWithAdapter(adapter, discordChannelId, message, 'match');
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
    /** Abandons in the window, counted apart from losses. */
    abandonsGained?: number | null;
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
    abandonsGained = null,
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
        (lossesGained ?? 0) > 0 ||
        (abandonsGained ?? 0) > 0;

    if (hasBaseline && anyNonZero) {
        if (
            (winsGained ?? 0) > 0 ||
            (lossesGained ?? 0) > 0 ||
            (abandonsGained ?? 0) > 0
        ) {
            // Abandons are appended rather than folded into losses: a night that
            // was 2W 1L plus a disconnect is not a 2W 2L night, and the RP
            // arithmetic only reconciles if the abandon is visible.
            const record = `${winsGained ?? 0}W ${lossesGained ?? 0}L`;
            fields.push({
                name: '📊 **W / L**',
                value:
                    (abandonsGained ?? 0) > 0
                        ? `**${record}** · ${abandonsGained} abandoned`
                        : `**${record}**`,
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

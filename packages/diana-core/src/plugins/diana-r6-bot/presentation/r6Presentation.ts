import type { R6ProfileSnapshot } from '../types.js';
import { formatR6Rank } from '../api/utils/rankService.js';

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

export interface R6PlayerEmbed {
    playerName: string;
    platform: string;
    rankDisplay: string;
    rankIconUrl: string | null;
    /** "🎮 In Game" | "❔ Unknown" — Siege exposes no presence source. */
    status: string;
    topStats: Array<{ name: string; value: string }>;
    colorHex: number;
}

export function buildR6PlayerEmbed(profile: R6ProfileSnapshot): R6PlayerEmbed {
    const { gameName, platform, rank, rankIconUrl, stats, kd } = profile;

    const rankDisplay = formatR6Rank(rank.tier, rank.division, rank.rp);
    const colorHex = r6RankColors.get(rank.tier) ?? 0x3498db;

    // Apex can say "Online"/"Offline" because its provider exposes a realtime
    // block. Siege has no such source, so claiming a status would be invented.
    const status = profile.isInGame === true ? '🎮 In Game' : '❔ Unknown';

    const topStats: Array<{ name: string; value: string }> = [
        { name: 'Kills', value: stats.kills.toLocaleString() },
        { name: 'Deaths', value: stats.deaths.toLocaleString() },
        { name: 'W / L', value: `${stats.wins}W ${stats.losses}L` },
    ];
    if (kd !== null) {
        topStats.push({ name: 'K/D', value: kd.toFixed(2) });
    }
    const winRate = formatWinRate(stats.wins, stats.losses);
    if (winRate !== null) {
        topStats.push({ name: 'Win Rate', value: winRate });
    }

    return {
        playerName: gameName,
        platform,
        rankDisplay,
        rankIconUrl,
        status,
        topStats,
        colorHex,
    };
}

/** "52.6%", or null when the player has no recorded ranked games. */
export function formatWinRate(wins: number, losses: number): string | null {
    const played = wins + losses;
    if (played <= 0) return null;
    return `${((wins / played) * 100).toFixed(1)}%`;
}

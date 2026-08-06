import type { IR6Service, R6ProfileSnapshot, R6RankRung } from '../../types.js';
import { R6DataService } from './r6DataService.js';
import { recordR6ApiCalls } from './r6Budget.js';
import { fallbackRankLadder } from './rankService.js';

class MockR6Service implements IR6Service {
    async checkConnection(): Promise<boolean> {
        return true;
    }

    async getRankLadder(): Promise<R6RankRung[]> {
        return fallbackRankLadder();
    }

    async getProfileByName(
        name: string,
        platform: string
    ): Promise<R6ProfileSnapshot> {
        const ladder = fallbackRankLadder();
        // Ordinal 22 is Platinum IV on the 40-rung Ranked 3.0 ladder.
        const rung = ladder.find((r) => r.ordinal === 22)!;
        return {
            ubisoftId: `mock_${name.toLowerCase().replace(/\s+/g, '_')}`,
            gameName: name,
            platform,
            rank: { tier: rung.tier, division: rung.division, rp: 3200 },
            rankOrdinal: rung.ordinal,
            maxRankOrdinal: rung.ordinal,
            rankIconUrl: null,
            stats: {
                kills: 4200,
                deaths: 3700,
                wins: 310,
                losses: 280,
                abandons: 4,
            },
            kd: 4200 / 3700,
            isInGame: null,
        };
    }

    async getTrackedProfile(player: {
        ubisoftId: string;
        gameName: string;
        platform: string;
    }): Promise<R6ProfileSnapshot> {
        const profile = await this.getProfileByName(
            player.gameName,
            player.platform
        );
        return { ...profile, ubisoftId: player.ubisoftId };
    }
}

/**
 * Charge one r6data request to the current month.
 *
 * Fire-and-forget, and deliberately so: the request has already been issued by
 * the time this runs, so awaiting the write would only delay the response, and a
 * failed write must not turn a successful poll into a thrown tick. The cost of a
 * lost write is that the month's ledger reads a little low, which the poll
 * budget's reserve exists to absorb.
 */
function meterR6Call(calls: number): void {
    recordR6ApiCalls(calls).catch((err) =>
        console.error('[R6] Failed to record API call against the budget:', err)
    );
}

export function createR6Service(): IR6Service {
    if (process.env.MOCK_R6_SERVICE === 'true') {
        console.log('[R6] Using mock R6 service');
        return new MockR6Service();
    }
    const apiKey = process.env.R6DATA_API_KEY;
    if (!apiKey) {
        console.warn(
            '[R6] R6DATA_API_KEY not set - falling back to mock service'
        );
        return new MockR6Service();
    }
    // The mock is unmetered on purpose: it issues no requests, and charging it
    // would make a local run with MOCK_R6_SERVICE=true eat the live plan's
    // ledger.
    return new R6DataService(apiKey, meterR6Call);
}

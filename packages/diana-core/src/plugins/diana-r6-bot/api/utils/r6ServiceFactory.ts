import type { IR6Service, R6ProfileSnapshot, R6RankRung } from '../../types.js';
import { R6DataService } from './r6DataService.js';
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
            stats: { kills: 4200, deaths: 3700, wins: 310, losses: 280 },
            kd: 4200 / 3700,
            isInGame: null,
        };
    }
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
    return new R6DataService(apiKey);
}

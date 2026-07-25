/**
 * Discord output regression gate for DN-1 (typed event bus).
 *
 * DN-1 adds event emission alongside the existing message sends. Discord's
 * rendered output must not change at all. The other notification suites assert
 * individual fields; these snapshots capture the WHOLE payload, so they also
 * catch fields being added, removed or reordered.
 *
 * If a snapshot here fails, the change altered what players see in Discord.
 * Do not update the snapshot to make it pass unless that change was intended.
 */

jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/dataDragonService',
    () => ({
        fetchLatestVersion: jest.fn().mockResolvedValue('15.2.1'),
    })
);

import {
    buildMatchEndMessage,
    buildMilestoneMessage,
    buildRankChangeMessage,
    buildStreakMessage,
} from '../packages/diana-core/src/plugins/diana-league-bot/notifications/leagueNotifications';

// Builders stamp `timestamp: new Date().toISOString()`. Freeze time so the
// snapshots are stable.
const FROZEN_NOW = new Date('2026-07-25T12:00:00.000Z');

beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
    jest.useRealTimers();
});

const baseMatchInput = {
    summonerName: 'TestPlayer',
    queueName: 'Ranked Solo',
    result: 'Win',
    gameLengthSeconds: 1830,
    newRankMsg: 'Gold IV',
    lpChangeMsg: 18,
    championDisplay: 'Ahri',
    role: 'Middle',
    kdaStr: '7/2/10',
    damage: 42000,
    deepLolLink: 'https://deeplol.gg/test',
};

describe('buildMatchEndMessage payload', () => {
    it('ranked win, minimal input', async () => {
        expect(await buildMatchEndMessage(baseMatchInput)).toMatchSnapshot();
    });

    it('ranked loss with full challenge metrics, placement and flavor line', async () => {
        expect(
            await buildMatchEndMessage({
                ...baseMatchInput,
                result: 'Lose',
                lpChangeMsg: -21,
                placement: 7,
                totalPlayers: 10,
                aiScore: 42.5,
                killParticipationPct: 38,
                damagePerMinute: 612,
                soloKills: 1,
                visionScore: 14,
                flavorLine:
                    '🚨 Chief communications officer of the missing-ping department.',
            })
        ).toMatchSnapshot();
    });

    it('remake', async () => {
        expect(
            await buildMatchEndMessage({
                ...baseMatchInput,
                result: 'Remake',
                gameLengthSeconds: 240,
                lpChangeMsg: null,
            })
        ).toMatchSnapshot();
    });

    it('non-ranked, non-role queue (ARAM) omits rank and role fields', async () => {
        expect(
            await buildMatchEndMessage({
                ...baseMatchInput,
                queueName: 'ARAM',
                lpChangeMsg: null,
            })
        ).toMatchSnapshot();
    });

    it('first place in lobby', async () => {
        expect(
            await buildMatchEndMessage({
                ...baseMatchInput,
                placement: 1,
                totalPlayers: 10,
                aiScore: 91.2,
            })
        ).toMatchSnapshot();
    });
});

describe('buildRankChangeMessage payload', () => {
    it('promotion', () => {
        expect(
            buildRankChangeMessage({
                summonerName: 'TestPlayer',
                direction: 'promoted',
                newRankMsg: 'Platinum IV',
                lpChangeMsg: 24,
                deepLolLink: 'https://deeplol.gg/test',
            })
        ).toMatchSnapshot();
    });

    it('demotion', () => {
        expect(
            buildRankChangeMessage({
                summonerName: 'TestPlayer',
                direction: 'demoted',
                newRankMsg: 'Gold I',
                lpChangeMsg: -18,
                deepLolLink: 'https://deeplol.gg/test',
            })
        ).toMatchSnapshot();
    });

    it('promotion without an LP delta', () => {
        expect(
            buildRankChangeMessage({
                summonerName: 'TestPlayer',
                direction: 'promoted',
                newRankMsg: 'Silver II',
                lpChangeMsg: null,
                deepLolLink: 'https://deeplol.gg/test',
            })
        ).toMatchSnapshot();
    });

    it('returns null for an unrecognised direction', () => {
        expect(
            buildRankChangeMessage({
                summonerName: 'TestPlayer',
                direction: 'sideways',
                newRankMsg: 'Gold IV',
                lpChangeMsg: 0,
                deepLolLink: 'https://deeplol.gg/test',
            })
        ).toBeNull();
    });
});

describe('buildStreakMessage payload', () => {
    it('win streak', () => {
        expect(
            buildStreakMessage({
                summonerName: 'TestPlayer',
                kind: 'win',
                length: 5,
                deepLolLink: 'https://deeplol.gg/test',
            })
        ).toMatchSnapshot();
    });

    it('loss streak', () => {
        expect(
            buildStreakMessage({
                summonerName: 'TestPlayer',
                kind: 'loss',
                length: 3,
                deepLolLink: 'https://deeplol.gg/test',
            })
        ).toMatchSnapshot();
    });
});

describe('buildMilestoneMessage payload', () => {
    it('new peak', () => {
        expect(
            buildMilestoneMessage({
                summonerName: 'TestPlayer',
                milestone: 'new_peak',
                newRankMsg: 'Diamond III',
                deepLolLink: 'https://deeplol.gg/test',
            })
        ).toMatchSnapshot();
    });

    it('first time reaching a tier', () => {
        expect(
            buildMilestoneMessage({
                summonerName: 'TestPlayer',
                milestone: 'first_time_tier',
                newRankMsg: 'Emerald IV',
                deepLolLink: 'https://deeplol.gg/test',
            })
        ).toMatchSnapshot();
    });
});

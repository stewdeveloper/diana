import {
    buildR6RankChangeMessage,
    buildR6SessionMessage,
    notifyR6RankChange,
} from '../packages/diana-core/src/plugins/diana-r6-bot/notifications/r6Notifications';
import {
    buildR6PlayerEmbed,
    formatWinRate,
} from '../packages/diana-core/src/plugins/diana-r6-bot/presentation/r6Presentation';

const baseRankChange = {
    playerName: 'Fishy',
    direction: 'promoted' as const,
    newRankMsg: 'Platinum II (3200 RP)',
    rpChange: 120,
    rankIconUrl: 'https://cdn.test/plat2.png',
    rpToNextRank: { rpNeeded: 300, nextRankName: 'Platinum I' },
};

describe('buildR6RankChangeMessage', () => {
    it('titles a promotion and a demotion differently', () => {
        expect(buildR6RankChangeMessage(baseRankChange).title).toContain(
            'Rank Up'
        );
        expect(
            buildR6RankChangeMessage({
                ...baseRankChange,
                direction: 'demoted',
                rpChange: -140,
            }).title
        ).toContain('Rank Down');
    });

    it('signs a positive RP change and leaves a negative one alone', () => {
        const up = buildR6RankChangeMessage(baseRankChange);
        expect(up.fields?.[1]?.value).toBe('**+120 RP**');
        const down = buildR6RankChangeMessage({
            ...baseRankChange,
            direction: 'demoted',
            rpChange: -140,
        });
        expect(down.fields?.[1]?.value).toBe('**-140 RP**');
    });

    it('colours by tier, and falls back for an unknown one', () => {
        expect(buildR6RankChangeMessage(baseRankChange).colorHex).toBe(
            0x22c1c3
        );
        expect(
            buildR6RankChangeMessage({
                ...baseRankChange,
                newRankMsg: 'Mythic II (9000 RP)',
            }).colorHex
        ).toBe(0x3498db);
    });

    it('omits the next-rank field at Champion', () => {
        const message = buildR6RankChangeMessage({
            ...baseRankChange,
            newRankMsg: 'Champion (5400 RP)',
            rpToNextRank: null,
        });
        expect(message.fields).toHaveLength(2);
        expect(JSON.stringify(message.fields)).not.toContain('Next Rank');
    });
});

describe('buildR6SessionMessage', () => {
    const base = {
        playerName: 'Stew',
        rpChange: 85,
        newRankMsg: 'Gold I (2900 RP)',
        rankIconUrl: null,
    };

    it('shows W/L and kills when a baseline exists and something moved', () => {
        const message = buildR6SessionMessage({
            ...base,
            killsGained: 14,
            winsGained: 3,
            lossesGained: 1,
        });
        const rendered = JSON.stringify(message.fields);
        expect(rendered).toContain('3W 1L');
        expect(rendered).toContain('+14');
    });

    it('distinguishes "no baseline yet" from "a session with no change"', () => {
        // First sighting: no stats block at all, because zero would be a lie.
        const firstSighting = buildR6SessionMessage({
            ...base,
            killsGained: null,
            winsGained: null,
            lossesGained: null,
        });
        expect(JSON.stringify(firstSighting.fields)).not.toContain('Stats');

        const nothingMoved = buildR6SessionMessage({
            ...base,
            killsGained: 0,
            winsGained: 0,
            lossesGained: 0,
        });
        expect(JSON.stringify(nothingMoved.fields)).toContain(
            'No tracked change'
        );
    });
});

describe('notifyR6RankChange', () => {
    it('sends to the given channel through the adapter', async () => {
        const sendMessage = jest.fn().mockResolvedValue(undefined);
        const sent = await notifyR6RankChange(
            { sendMessage },
            { ...baseRankChange, discordChannelId: '42' }
        );

        expect(sent).toBe(true);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0][0]).toEqual({ channelId: '42' });
        // The channel id is routing, not content — it must not reach the embed.
        expect(sendMessage.mock.calls[0][1]).not.toHaveProperty(
            'discordChannelId'
        );
    });

    it('reports failure rather than throwing when the adapter rejects', async () => {
        const sendMessage = jest.fn().mockRejectedValue(new Error('discord'));
        await expect(
            notifyR6RankChange(
                { sendMessage },
                { ...baseRankChange, discordChannelId: '42' }
            )
        ).resolves.toBe(false);
    });

    it('is a no-op, not a crash, without an adapter', async () => {
        await expect(
            notifyR6RankChange(null, {
                ...baseRankChange,
                discordChannelId: '42',
            })
        ).resolves.toBe(true);
    });
});

describe('r6Presentation', () => {
    it('never claims a status Siege cannot report', () => {
        const view = buildR6PlayerEmbed({
            ubisoftId: 'x',
            gameName: 'Pruhaps',
            platform: 'uplay',
            rank: { tier: 'Diamond', division: 2, rp: 4600 },
            rankOrdinal: 32,
            maxRankOrdinal: 32,
            rankIconUrl: null,
            stats: { kills: 100, deaths: 100, wins: 10, losses: 10 },
            kd: 1.0,
            isInGame: null,
        });
        expect(view.status).toBe('❔ Unknown');
        expect(view.rankDisplay).toBe('Diamond II (4600 RP)');
    });

    it('computes a win rate only when games have been played', () => {
        expect(formatWinRate(10, 10)).toBe('50.0%');
        expect(formatWinRate(0, 0)).toBeNull();
    });
});

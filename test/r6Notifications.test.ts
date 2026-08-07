import {
    buildR6MatchMessage,
    buildR6RankChangeMessage,
    buildR6SessionMessage,
    notifyR6Match,
    notifyR6RankChange,
    r6MatchResultLabel,
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

    it('counts abandons beside the record rather than inside it', () => {
        // A night that was 2W 1L plus a disconnect is not a 2W 2L night, and the
        // RP arithmetic only reconciles if the abandon is visible.
        const message = buildR6SessionMessage({
            ...base,
            killsGained: 9,
            winsGained: 2,
            lossesGained: 1,
            abandonsGained: 1,
        });
        const rendered = JSON.stringify(message.fields);
        expect(rendered).toContain('2W 1L');
        expect(rendered).toContain('1 abandoned');
    });

    it('shows a window whose only event was an abandon', () => {
        // Wins and losses both standing still while RP moves is exactly the case
        // that made abandons worth capturing. Before it, this window rendered as
        // "No tracked change" next to a real RP swing.
        const message = buildR6SessionMessage({
            ...base,
            rpChange: -40,
            killsGained: 0,
            winsGained: 0,
            lossesGained: 0,
            abandonsGained: 1,
        });
        const rendered = JSON.stringify(message.fields);
        expect(rendered).toContain('1 abandoned');
        expect(rendered).not.toContain('No tracked change');
    });
});

/**
 * The per-match embed — Part B of Meeps' docs/r6-events-and-post-match.md.
 *
 * The thing worth pinning is mostly what it does *not* say. Siege has no match
 * record, so there is no operator, map, duration or per-match score to render,
 * and the card is deliberately sparse rather than provisionally sparse. What it
 * must get right is the three-way outcome and never printing half a K/D.
 */
describe('buildR6MatchMessage', () => {
    const base = {
        playerName: 'Stew',
        rpChange: 24,
        newRankMsg: 'Gold I (2900 RP)',
        rankIconUrl: null,
        kills: 8,
        deaths: 4,
    };

    it('names the three outcomes Siege actually has', () => {
        expect(r6MatchResultLabel(true)).toBe('Victory');
        expect(r6MatchResultLabel(false)).toBe('Defeat');
        // Not a defeat. An abandon is counted separately by the provider and is
        // the reason RP can move while wins and losses stand still, so folding
        // it into `win: false` would report a loss that did not happen.
        expect(r6MatchResultLabel(null)).toBe('Abandoned');
    });

    it('titles and colours a win, a loss and an abandon apart', () => {
        const win = buildR6MatchMessage({ ...base, win: true });
        const loss = buildR6MatchMessage({
            ...base,
            win: false,
            rpChange: -31,
        });
        const abandon = buildR6MatchMessage({
            ...base,
            win: null,
            rpChange: -50,
        });

        expect(win.title).toContain('Victory');
        expect(loss.title).toContain('Defeat');
        expect(abandon.title).toContain('Abandoned');
        expect(win.footer).toBe('Rainbow Six Siege · Victory');

        // Outcome drives the colour here, unlike the session and rank embeds
        // where the tier does: the subject of this card is "did you win".
        expect(win.colorHex).not.toBe(loss.colorHex);
        expect(abandon.colorHex).not.toBe(win.colorHex);
        expect(abandon.colorHex).not.toBe(loss.colorHex);
    });

    it('signs the RP swing and names the resulting rank', () => {
        const rendered = JSON.stringify(
            buildR6MatchMessage({ ...base, win: true }).fields
        );
        expect(rendered).toContain('+24 RP');
        expect(rendered).toContain('Gold I (2900 RP)');
    });

    it('shows K/D only with both halves, and kills alone otherwise', () => {
        // A player whose deaths baseline predates migration 023 has exactly one
        // poll in that state. "8 / undefined" is not a stat; "8 kills" is.
        const both = JSON.stringify(
            buildR6MatchMessage({ ...base, win: true }).fields
        );
        expect(both).toContain('8 / 4');

        const killsOnly = JSON.stringify(
            buildR6MatchMessage({ ...base, win: true, deaths: null }).fields
        );
        expect(killsOnly).toContain('Kills');
        expect(killsOnly).not.toContain('K / D');

        const neither = JSON.stringify(
            buildR6MatchMessage({
                ...base,
                win: true,
                kills: null,
                deaths: null,
            }).fields
        );
        expect(neither).not.toContain('Kills');
        expect(neither).not.toContain('K / D');
    });

    it('claims no operator, map or duration, because there is no match record', () => {
        // Siege has no first-party developer API and the provider returns
        // season-cumulative counters. This is the assertion that stops a future
        // change inventing a field the data cannot support.
        const rendered = JSON.stringify(
            buildR6MatchMessage({ ...base, win: true })
        ).toLowerCase();
        for (const claim of ['operator', 'map', 'duration', 'score', 'mvp']) {
            expect(rendered).not.toContain(claim);
        }
    });

    it('routes through the adapter without leaking the channel into the embed', async () => {
        const sendMessage = jest.fn().mockResolvedValue(undefined);
        const sent = await notifyR6Match(
            { sendMessage },
            { ...base, win: true, discordChannelId: '42' }
        );

        expect(sent).toBe(true);
        expect(sendMessage.mock.calls[0][0]).toEqual({ channelId: '42' });
        expect(sendMessage.mock.calls[0][1]).not.toHaveProperty(
            'discordChannelId'
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
            stats: {
                kills: 100,
                deaths: 100,
                wins: 10,
                losses: 10,
                abandons: 0,
            },
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

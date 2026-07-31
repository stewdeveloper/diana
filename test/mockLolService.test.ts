import {
    MockLolService,
    MOCK_PROFILE_ICON_ID,
} from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/lolService/mockLolService';

/**
 * `MockLolService` is what every test with a Riot dependency runs against, so
 * the convention in roadmap §13.4 is that a new `ILolService` method ships with
 * its counterpart here in the same commit. This covers the one DN-3 added.
 */
describe('MockLolService.getSummonerByPUUID', () => {
    const service = new MockLolService();

    it('echoes back the puuid it was asked about', async () => {
        const profile = await service.getSummonerByPUUID('puuid-1');
        expect(profile.puuid).toBe('puuid-1');
    });

    it('reports a stable icon', async () => {
        // The handshake tests compare this against a challenge. A mock that
        // varied between calls would make "verification succeeded" and
        // "verification failed" both reachable from the same test.
        const first = await service.getSummonerByPUUID('puuid-1');
        const second = await service.getSummonerByPUUID('puuid-1');
        expect(first.profileIconId).toBe(MOCK_PROFILE_ICON_ID);
        expect(second.profileIconId).toBe(MOCK_PROFILE_ICON_ID);
    });

    it('is the same icon regardless of player or region', async () => {
        const a = await service.getSummonerByPUUID('puuid-1', 'EU_WEST');
        const b = await service.getSummonerByPUUID('puuid-2', 'KOREA');
        expect(a.profileIconId).toBe(b.profileIconId);
    });
});

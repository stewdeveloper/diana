import {
    ILolService,
    ChampionRotation,
    LiveGameInfo,
    SummonerProfile,
} from '../../../types';

/** The icon `MockLolService` always reports. Exported so tests can match it. */
export const MOCK_PROFILE_ICON_ID = 4568;
import { readFileSync } from 'fs';
import { join } from 'path';
import { SummonerLeagueDto } from 'twisted/dist/models-dto/league/summoner-league/summoner-league.dto';
import { AccountDto } from 'twisted/dist/models-dto/account/account.dto';
import { AccountRegionDto } from 'twisted/dist/models-dto/account/account-region.dto';
import {
    MatchV5DTOs,
    MatchV5TimelineDTOs,
} from 'twisted/dist/models-dto/matches/match-v5';

class JsonLoader {
    private static readonly basePath = join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        '..',
        '..',
        '..',
        '..',
        'db',
        'data',
        'riot'
    );

    static load<T>(filename: string): T {
        const filePath = join(this.basePath, filename);
        const data = readFileSync(filePath, 'utf-8');
        return JSON.parse(data) as T;
    }
}

export class MockLolService implements ILolService {
    async checkConnection(): Promise<boolean> {
        return true;
    }

    async getMatchesByPUUID(
        puuid: string,
        count?: number,
        regionGroup?: string
    ): Promise<string[]> {
        return JsonLoader.load<string[]>('riot_matches_by_puuid.json');
    }

    async getMatchDataById(
        matchId: string,
        _regionGroup?: string
    ): Promise<MatchV5TimelineDTOs.MatchTimelineDto> {
        return JsonLoader.load<MatchV5TimelineDTOs.MatchTimelineDto>(
            'riot_match_timeline_by_match_id.json'
        );
    }

    async getMatchSummary(
        matchId: string,
        _regionGroup?: string
    ): Promise<MatchV5DTOs.MatchDto> {
        return JsonLoader.load<MatchV5DTOs.MatchDto>(
            'riot_match_data_by_match_id.json'
        );
    }

    async getRankEntriesByPUUID(
        puuid: string,
        _region?: string
    ): Promise<SummonerLeagueDto[]> {
        return JsonLoader.load<SummonerLeagueDto[]>(
            'riot_league_account_info.json'
        );
    }

    async getAccountByPUUID(puuid: string): Promise<AccountDto> {
        return {
            puuid,
            gameName: `MockGame${puuid.slice(0, 4)}`,
            tagLine: 'MOCK',
        };
    }

    async getAccountByRiotId(
        gameName: string,
        tagLine: string
    ): Promise<AccountDto> {
        return {
            puuid: 'mock-puuid-' + gameName.toLowerCase().replace(/\s/g, '-'),
            gameName,
            tagLine,
        };
    }

    async getActiveRegionByPUUID(puuid: string): Promise<AccountRegionDto> {
        return {
            puuid,
            game: 'lol',
            region: 'EUW1',
        };
    }

    async getChampionRotation(_region?: string): Promise<ChampionRotation> {
        return JsonLoader.load<ChampionRotation>('riot_champion_rotation.json');
    }

    async getActiveGame(
        _puuid: string,
        _region?: string
    ): Promise<LiveGameInfo | null> {
        return JsonLoader.load<LiveGameInfo>('riot_active_game_found.json');
    }

    /**
     * A stable profile for the DN-3 icon handshake.
     *
     * The icon is a fixed constant rather than a random or time-derived value:
     * the handshake tests compare it against a challenge, and a mock that
     * changed between calls would make "verification succeeded" and
     * "verification failed" both reachable from the same test.
     */
    async getSummonerByPUUID(
        puuid: string,
        _region?: string
    ): Promise<SummonerProfile> {
        return {
            puuid,
            profileIconId: MOCK_PROFILE_ICON_ID,
            summonerLevel: 250,
            revisionDate: 0,
        };
    }
}

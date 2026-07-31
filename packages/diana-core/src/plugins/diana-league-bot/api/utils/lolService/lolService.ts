import { LolApi, Constants, RiotApi } from 'twisted';
import {
    ILolService,
    ChampionRotation,
    LiveGameInfo,
    SummonerProfile,
} from '../../../types';
import { SummonerLeagueDto } from 'twisted/dist/models-dto/league/summoner-league/summoner-league.dto';
import {
    MatchV5DTOs,
    MatchV5TimelineDTOs,
} from 'twisted/dist/models-dto/matches/match-v5';
import { AccountDto } from 'twisted/dist/models-dto/account/account.dto';
import { AccountRegionDto } from 'twisted/dist/models-dto/account/account-region.dto';

type Region = (typeof Constants.Regions)[keyof typeof Constants.Regions];
type RegionGroup =
    (typeof Constants.RegionGroups)[keyof typeof Constants.RegionGroups];
type AccountRegionGroup = Exclude<
    RegionGroup,
    typeof Constants.RegionGroups.SEA
>;

export class LolApiError extends Error {
    constructor(
        public status: number,
        message: string
    ) {
        super(message);
        this.name = 'LolApiError';
    }
}

export class LolService implements ILolService {
    private lolApi: LolApi;
    private riotApi: RiotApi;

    constructor(apiKey: string) {
        this.lolApi = new LolApi({ key: apiKey });
        this.riotApi = new RiotApi({ key: apiKey });
    }

    async checkConnection(
        region: Region = Constants.Regions.EU_WEST
    ): Promise<boolean> {
        try {
            await this.lolApi.StatusV4.get(region);
            return true;
        } catch {
            return false;
        }
    }

    async getMatchesByPUUID(
        puuid: string,
        count: number = 20,
        regionGroup: RegionGroup = Constants.RegionGroups.EUROPE
    ): Promise<string[]> {
        try {
            const { response } = await this.lolApi.MatchV5.list(
                puuid,
                regionGroup,
                { count }
            );
            return response;
        } catch (error: any) {
            throw new LolApiError(
                error?.status ?? 500,
                error?.message ?? 'Unknown error'
            );
        }
    }

    async getMatchDataById(
        matchId: string,
        regionGroup: RegionGroup = Constants.RegionGroups.EUROPE
    ): Promise<MatchV5TimelineDTOs.MatchTimelineDto> {
        try {
            const { response } = await this.lolApi.MatchV5.timeline(
                matchId,
                regionGroup
            );
            return response;
        } catch (error: any) {
            throw new LolApiError(
                error?.status ?? 500,
                error?.message ?? 'Unknown error'
            );
        }
    }

    async getMatchSummary(
        matchId: string,
        regionGroup: RegionGroup = Constants.RegionGroups.EUROPE
    ): Promise<MatchV5DTOs.MatchDto> {
        try {
            const { response } = await this.lolApi.MatchV5.get(
                matchId,
                regionGroup
            );
            return response;
        } catch (error: any) {
            throw new LolApiError(
                error?.status ?? 500,
                error?.message ?? 'Unknown error'
            );
        }
    }

    async getRankEntriesByPUUID(
        puuid: string,
        region: Region = Constants.Regions.EU_WEST
    ): Promise<SummonerLeagueDto[]> {
        try {
            const { response } = await this.lolApi.League.byPUUID(
                puuid,
                region
            );
            return response;
        } catch (error: any) {
            throw new LolApiError(
                error?.status ?? 500,
                error?.message ?? 'Unknown error'
            );
        }
    }

    async getAccountByPUUID(
        puuid: string,
        regionGroup: RegionGroup = Constants.RegionGroups.EUROPE
    ): Promise<AccountDto> {
        try {
            const safeRegionGroup: AccountRegionGroup =
                regionGroup === Constants.RegionGroups.SEA
                    ? Constants.RegionGroups.EUROPE
                    : (regionGroup as AccountRegionGroup);
            const { response } = await this.riotApi.Account.getByPUUID(
                puuid,
                safeRegionGroup
            );
            return response;
        } catch (error: any) {
            throw new LolApiError(
                error?.status ?? 500,
                error?.message ?? 'Unknown error'
            );
        }
    }

    async getAccountByRiotId(
        gameName: string,
        tagLine: string,
        regionGroup: RegionGroup = Constants.RegionGroups.EUROPE
    ): Promise<AccountDto> {
        try {
            const safeRegionGroup: AccountRegionGroup =
                regionGroup === Constants.RegionGroups.SEA
                    ? Constants.RegionGroups.EUROPE
                    : (regionGroup as AccountRegionGroup);
            const { response } = await this.riotApi.Account.getByRiotId(
                gameName,
                tagLine,
                safeRegionGroup
            );
            return response;
        } catch (error: any) {
            throw new LolApiError(
                error?.status ?? 500,
                error?.message ?? 'Unknown error'
            );
        }
    }

    async getActiveRegionByPUUID(
        puuid: string,
        regionGroup: RegionGroup = Constants.RegionGroups.EUROPE
    ): Promise<AccountRegionDto> {
        try {
            const safeRegionGroup: AccountRegionGroup =
                regionGroup === Constants.RegionGroups.SEA
                    ? Constants.RegionGroups.EUROPE
                    : (regionGroup as AccountRegionGroup);
            const { response } = await this.riotApi.Account.getActiveRegion(
                puuid,
                Constants.Games.LOL,
                safeRegionGroup
            );
            return response;
        } catch (error: any) {
            throw new LolApiError(
                error?.status ?? 500,
                error?.message ?? 'Unknown error'
            );
        }
    }

    /**
     * Live summoner profile, for the DN-3 icon handshake.
     *
     * summoner-v4 is per-platform, so this takes a `Region` (EUW1) rather than
     * the `RegionGroup` (EUROPE) that account-v1 takes. Passing the wrong one is
     * the easy mistake here and it fails at runtime, not at compile time.
     */
    async getSummonerByPUUID(
        puuid: string,
        region: Region = Constants.Regions.EU_WEST
    ): Promise<SummonerProfile> {
        try {
            const { response } = await this.lolApi.Summoner.getByPUUID(
                puuid,
                region
            );
            return response as SummonerProfile;
        } catch (error: any) {
            throw new LolApiError(
                error?.status ?? 500,
                error?.message ?? 'Unknown error'
            );
        }
    }

    async getChampionRotation(
        region: Region = Constants.Regions.EU_WEST
    ): Promise<ChampionRotation> {
        try {
            const { response } = await this.lolApi.Champion.rotation(region);
            return response as ChampionRotation;
        } catch (error: any) {
            throw new LolApiError(
                error?.status ?? 500,
                error?.message ?? 'Unknown error'
            );
        }
    }

    async getActiveGame(
        puuid: string,
        region: Region = Constants.Regions.EU_WEST
    ): Promise<LiveGameInfo | null> {
        try {
            const result = await this.lolApi.SpectatorV5.activeGame(
                puuid,
                region
            );
            // SpectatorV5 returns a SpectatorNotAvailableDTO (no `response`
            // property) when the player is not in a game.
            if (
                !result ||
                typeof result !== 'object' ||
                !('response' in result)
            ) {
                return null;
            }
            return result.response as LiveGameInfo;
        } catch (error: any) {
            if (error?.status === 404) return null;
            throw new LolApiError(
                error?.status ?? 500,
                error?.message ?? 'Unknown error'
            );
        }
    }
}

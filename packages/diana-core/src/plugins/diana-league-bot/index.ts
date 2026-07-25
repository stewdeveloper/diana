import type { DianaPlugin, ConfigField } from '../../core/pluginTypes';
import { summonerRouter } from './api/summoners/summonerRoutes';
import { matchRouter } from './api/matches/matchRoutes';
import { createMatchMonitoringTick } from './monitoring/matchMonitoringService';
import { createWeeklyDigestTick } from './monitoring/weeklyDigestService';
import { createRotationPostTick } from './monitoring/rotationPostService';
import type { LeagueBotConfig } from './types';

const defaultConfig: LeagueBotConfig = {
    matchCheckCron: '0 * * * * *',
    weeklyDigestCron: '0 0 19 * * 0',
    rotationPostCron: '0 0 12 * * 2',
};

const configSchema: ConfigField[] = [
    {
        key: 'matchCheckCron',
        label: 'Match Check Schedule',
        type: 'string',
        description:
            'Cron expression for match checking (default: every minute)',
        required: false,
        default: '0 * * * * *',
    },
    {
        key: 'weeklyDigestCron',
        label: 'Weekly Digest Schedule',
        type: 'string',
        description:
            '6-field cron expression, server-local time (default: Sunday 19:00)',
        required: false,
        default: '0 0 19 * * 0',
    },
    {
        key: 'rotationPostCron',
        label: 'Free Rotation Post Schedule',
        type: 'string',
        description:
            '6-field cron expression, server-local time (default: Tuesday 12:00)',
        required: false,
        default: '0 0 12 * * 2',
    },
];

export const leagueBotPlugin: DianaPlugin = {
    id: 'diana-league-bot',
    name: 'League Bot',
    version: '1.0.0',
    description:
        'League of Legends match tracking, summoner info, champion stats, and inter of the week.',
    icon: '/dashboard/icons/league-bot.png',
    configSchema,

    async onLoad(context) {
        context.mountRouter('/summoners', summonerRouter);
        context.mountRouter('/match', matchRouter);
    },

    async onEnable(context) {
        const storedConfig = context.getConfig<Partial<LeagueBotConfig>>();
        const config: LeagueBotConfig = { ...defaultConfig, ...storedConfig };

        console.log(`[LeagueBot] Enabling with config:`, {
            matchCheckCron: config.matchCheckCron,
        });

        const runTick = createMatchMonitoringTick(
            config,
            context.getMessageAdapter(),
            context.getEventAdapter()
        );
        context.registerCron(config.matchCheckCron, runTick);

        const runDigest = createWeeklyDigestTick(
            config,
            context.getMessageAdapter(),
            context.getEventAdapter()
        );
        context.registerCron(config.weeklyDigestCron, runDigest);

        const runRotationPost = createRotationPostTick(
            config,
            context.getMessageAdapter(),
            context.getEventAdapter()
        );
        context.registerCron(config.rotationPostCron, runRotationPost);
    },
};

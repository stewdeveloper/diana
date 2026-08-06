import type { DianaPlugin } from '../../core/pluginTypes.js';
import type { R6BotConfig } from './types.js';
import { playerRouter } from './api/players/playerRoutes.js';
import {
    cadenceFromConfig,
    runR6Tick,
} from './monitoring/rankMonitoringService.js';
import { estimatedMonthlyCallsPerPlayer } from './monitoring/r6PollScheduler.js';

export const r6BotPlugin: DianaPlugin = {
    id: 'diana-r6-bot',
    name: 'Ash (Rainbow Six Siege)',
    version: '1.0.0',
    description: 'Track Rainbow Six Siege players, rank changes, and stats.',
    icon: '🛡️',

    configSchema: [
        {
            key: 'rankCheckCron',
            label: 'Poll Heartbeat Cron',
            type: 'string',
            default: '*/5 * * * *',
            description:
                'How often to check who is due a poll. Not the poll rate — that is per player, below. A heartbeat with nobody due costs no API calls.',
        },
        {
            key: 'defaultDiscordChannelId',
            label: 'Default Discord Channel ID',
            type: 'string',
            default: '',
            description: 'Fallback channel for rank change notifications.',
        },
        {
            key: 'activePollMinutes',
            label: 'Active Poll Interval (minutes)',
            type: 'number',
            default: 5,
            description:
                'Poll rate while a player looks mid-session. Must be well under a match (25-35 min) for single matches to be reported as matches rather than sessions.',
        },
        {
            key: 'idlePollMinutes',
            label: 'Idle Poll Interval (minutes)',
            type: 'number',
            default: 180,
            description:
                'Poll rate while nothing has moved — this is what notices a session starting. Lowering it detects sessions sooner and spends the monthly budget faster.',
        },
        {
            key: 'activeWindowMinutes',
            label: 'Active Window (minutes)',
            type: 'number',
            default: 60,
            description:
                'How long movement keeps a player on the active interval. Sized off the gap between two matches, not a match.',
        },
    ],

    async onLoad(context) {
        context.mountRouter('/r6/players', playerRouter);
        console.log('[R6] Plugin loaded - routes mounted at /r6/players');
    },

    async onEnable(context) {
        const config = context.getConfig<R6BotConfig>();
        const adapter = context.getMessageAdapter();
        // Two destinations, two shapes: Discord gets rendered embeds, Meeps gets
        // typed `r6.*` events it draws its own cards from (DN-1).
        const eventAdapter = context.getEventAdapter();
        const schedule = config?.rankCheckCron ?? '*/5 * * * *';
        const cadence = cadenceFromConfig(config);

        context.registerCron(schedule, async () => {
            await runR6Tick(adapter, eventAdapter, { cadence });
        });

        // Logged with the model's own estimate, because the constraint that
        // shapes this plugin (3,000 r6data calls a month, 3 players) is invisible
        // in a cron string and every future cadence change will be made by
        // somebody reading a log line rather than r6Budget.ts.
        const perPlayer = estimatedMonthlyCallsPerPlayer(2, cadence);
        console.log(
            `[R6] Plugin enabled - heartbeat ${schedule}; ` +
                `polling every ${cadence.activePollMinutes}m active / ` +
                `${cadence.idlePollMinutes}m idle ` +
                `(~${perPlayer} calls/player/month at 2h of play a day; ` +
                `~${estimatedMonthlyCallsPerPlayer(0, cadence)} idling)`
        );
    },

    async onDisable() {
        console.log('[R6] Plugin disabled.');
    },
};

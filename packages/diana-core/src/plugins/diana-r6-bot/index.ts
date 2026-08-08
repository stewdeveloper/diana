import type { DianaPlugin } from '../../core/pluginTypes.js';
import type { R6BotConfig } from './types.js';
import { playerRouter } from './api/players/playerRoutes.js';
import {
    cadenceFromConfig,
    runR6Tick,
} from './monitoring/rankMonitoringService.js';
import { estimatedMonthlyCallsPerPlayer } from './monitoring/r6PollScheduler.js';
import { pollBudgetFor, r6BudgetConfig } from './api/utils/r6Budget.js';

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
            key: 'pollMinutes',
            label: 'Poll Interval (minutes)',
            type: 'number',
            default: 60,
            description:
                'How often each player is polled, on clock boundaries. Below ~35 minutes single games start being reported as match cards rather than sessions, at proportionally more calls; above it everything is a session.',
        },
        {
            key: 'quietHoursStart',
            label: 'Quiet Hours Start (HH:MM)',
            type: 'string',
            default: '01:30',
            description:
                'Start of the nightly window where nobody is polled. Set equal to the end time to poll around the clock.',
        },
        {
            key: 'quietHoursEnd',
            label: 'Quiet Hours End (HH:MM)',
            type: 'string',
            default: '09:00',
            description:
                'End of the quiet window. Play during the window is noticed at the first poll after it, as one session.',
        },
        {
            key: 'quietHoursTimeZone',
            label: 'Quiet Hours Time Zone',
            type: 'string',
            default: '',
            description:
                "IANA zone the quiet window is measured in, e.g. Europe/London. Defaults to the deployment's own TZ, or UTC if that is unset.",
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
        // shapes this plugin (3,000 r6data calls a month) is invisible in a cron
        // string and every future cadence change will be made by somebody
        // reading a log line rather than r6Budget.ts. The affordable-roster
        // figure is the one worth having in front of you: it is what silently
        // degrades as more people link their accounts.
        const perPlayer = estimatedMonthlyCallsPerPlayer(cadence);
        const affordable = Math.floor(
            pollBudgetFor(r6BudgetConfig().limit, r6BudgetConfig().reserve) /
                Math.max(1, perPlayer)
        );
        console.log(
            `[R6] Plugin enabled - heartbeat ${schedule}; ` +
                `polling every ${cadence.pollMinutes}m, quiet ` +
                `${cadence.quietStart}-${cadence.quietEnd} ${cadence.timeZone} ` +
                `(~${perPlayer} calls/player/month; ~${affordable} players fit the plan)`
        );
    },

    async onDisable() {
        console.log('[R6] Plugin disabled.');
    },
};

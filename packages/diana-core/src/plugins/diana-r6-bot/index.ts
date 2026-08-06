import type { DianaPlugin } from '../../core/pluginTypes.js';
import type { R6BotConfig } from './types.js';
import { playerRouter } from './api/players/playerRoutes.js';
import { runR6Tick } from './monitoring/rankMonitoringService.js';

export const r6BotPlugin: DianaPlugin = {
    id: 'diana-r6-bot',
    name: 'Ash (Rainbow Six Siege)',
    version: '1.0.0',
    description: 'Track Rainbow Six Siege players, rank changes, and stats.',
    icon: '🛡️',

    configSchema: [
        {
            key: 'rankCheckCron',
            label: 'Rank Check Cron',
            type: 'string',
            default: '0 * * * *',
            description:
                'Cron schedule for polling player ranks (default: every hour).',
        },
        {
            key: 'defaultDiscordChannelId',
            label: 'Default Discord Channel ID',
            type: 'string',
            default: '',
            description: 'Fallback channel for rank change notifications.',
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
        const schedule = config?.rankCheckCron ?? '0 * * * *';

        context.registerCron(schedule, async () => {
            await runR6Tick(adapter, eventAdapter);
        });

        console.log(`[R6] Plugin enabled - rank checks scheduled: ${schedule}`);
    },

    async onDisable() {
        console.log('[R6] Plugin disabled.');
    },
};

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import {
    setExpressApp,
    registerPlugin,
    loadPlugin,
    pluginsApiRouter,
    squadsApiRouter,
    squadsMachineRouter,
    wrappedApiRouter,
    wrappedMachineRouter,
    presenceApiRouter,
    privacyApiRouter,
    identityApiRouter,
    sessionsApiRouter,
    authApiRouter,
    requireAuth,
    setPluginMessageAdapter,
    setPluginEventAdapter,
    setEventAdapter,
    registerCoreCron,
    runRecapSweep,
    runLinkSweep,
    createLolService,
    leagueBotPlugin,
    apexBotPlugin,
} from 'diana-core';
import {
    registerSlashCommands,
    pingCommand,
    setupAndStartDiscord,
    leagueDiscordCommands,
    apexDiscordCommands,
    sendDirectMessage,
} from 'diana-discord';
import {
    createDianaPluginAdapter,
    createPathfinderPluginAdapter,
} from './messageAdapter';
import { createMeepsEventAdapter } from './meepsEventAdapter';

/** Cron scope label and schedule for the session recap sweep. */
const SESSION_RECAP_LABEL = 'session-recap';
const SESSION_RECAP_CRON = '*/5 * * * *';

/**
 * Link verification sweep (DN-3).
 *
 * Ten minutes rather than five: this is waiting on a third party's cache, and
 * checking twice as often does not make Riot answer sooner - it only doubles
 * the calls spent per person mid-link.
 */
const LINK_SWEEP_LABEL = 'link-verify';
const LINK_SWEEP_CRON = '*/10 * * * *';

// Rate limiter for dashboard routes (100 requests per minute per IP)
const dashboardLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
});

// Rate limiter for all API routes (200 requests per minute per IP)
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
});

async function main() {
    const app = express();
    app.use((req, res, next) => {
        const start = Date.now();
        const host = req.headers.host ?? 'unknown-host';
        const ua = req.headers['user-agent'] ?? 'unknown-ua';
        console.log(
            `[Diana:HTTP] --> ${req.method} ${req.originalUrl} host=${host} ip=${req.ip} ua="${ua}"`
        );
        res.on('finish', () => {
            const durationMs = Date.now() - start;
            console.log(
                `[Diana:HTTP] <-- ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`
            );
        });
        next();
    });
    app.use(
        cors({
            origin: (
                origin: string | undefined,
                callback: (err: Error | null, allow?: boolean) => void
            ) => {
                // Allow server-to-server requests (no Origin header)
                if (!origin) {
                    callback(null, true);
                    return;
                }
                const isLocalhost =
                    origin === 'http://localhost:5173' ||
                    origin === 'http://localhost:3000' ||
                    // Tauri desktop app origins
                    origin === 'https://tauri.localhost' ||
                    origin === 'tauri://localhost';
                // Accept any Railway subdomain (*.up.railway.app) — Railway
                // controls this namespace and may assign new subdomains on redeploy.
                const isRailway = origin.endsWith('.up.railway.app');
                const isConfiguredDomain = process.env.RAILWAY_PUBLIC_DOMAIN
                    ? origin === `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
                    : false;
                if (isLocalhost || isRailway || isConfiguredDomain) {
                    callback(null, true);
                } else {
                    console.warn(`[Diana:CORS] Rejected origin: ${origin}`);
                    callback(new Error('Not allowed by CORS'));
                }
            },
            credentials: true,
        })
    );
    app.use(express.json());
    app.use(cookieParser());

    const PORT = Number(process.env.PORT) || 3000;
    const inRailway = Boolean(process.env.RAILWAY_PUBLIC_DOMAIN);

    // Public routes (no auth required)
    app.get('/', (_req, res) => {
        res.json({ status: 'ok', service: 'diana' });
    });
    app.get('/api/health', (_req, res) => {
        res.json({ status: 'ok', service: 'diana' });
    });

    // Rate limit all API routes
    app.use('/api/', apiLimiter);

    // Auth routes (login/logout don't require auth)
    app.use('/api/auth', authApiRouter);

    // Protected routes (require authentication)
    app.use('/api/plugins', requireAuth, pluginsApiRouter);
    // One squad read is reachable with the Meeps shared secret instead of the
    // dashboard JWT: `by-attachment`, which is how Meeps learns the squad behind
    // one of its spaces. It is mounted first and falls through to the JWT router
    // below for any caller that does not present the secret — see
    // `meepsSecretOrSkip`. Order matters; swapping these two makes the machine
    // route unreachable again.
    app.use('/api/squads', squadsMachineRouter);
    // Squad Wrapped (§7.2) is the second machine-readable squad route, and for
    // the same reason: Meeps draws the card, joining these figures to the chat
    // corpus that only it has. Same fall-through, so the dashboard reaches the
    // identical handler through the JWT router further down.
    app.use('/api/squads', wrappedMachineRouter);
    app.use('/api/squads', requireAuth, squadsApiRouter);
    app.use('/api/squads', requireAuth, wrappedApiRouter);
    // Sessions (DN-6) sit behind the dashboard JWT, not the Meeps secret: a
    // session records who was at their computer and with whom, which is personal
    // data about a group rather than a machine-to-machine fact.
    app.use('/api/sessions', requireAuth, sessionsApiRouter);
    // Presence ingestion (DN-5) is machine-to-machine from the Meeps server, so
    // it carries its own shared-secret gate instead of the dashboard's JWT.
    app.use('/api/presence', presenceApiRouter);
    // Privacy (DN-3) sits behind the JWT for the same reason sessions do, and
    // one more: a privacy decision is made by a person, so the route that
    // records it should know which person rather than only which machine.
    app.use('/api/privacy', requireAuth, privacyApiRouter);
    // Identity resolution (DN-3) carries the Meeps shared secret, like presence
    // ingestion: Meeps asks it with its own user ids to find the matching Riot
    // accounts, and it is a server asking rather than a logged-in browser.
    app.use('/api/identity', identityApiRouter);

    setExpressApp(app);
    setPluginMessageAdapter(leagueBotPlugin.id, createDianaPluginAdapter());
    setPluginMessageAdapter(apexBotPlugin.id, createPathfinderPluginAdapter());

    // Structured events (DN-1). League only for now - the Apex plugin still
    // posts messages exclusively.
    setPluginEventAdapter(leagueBotPlugin.id, createMeepsEventAdapter());

    // The same adapter again, as the fallback for emitters that are not a
    // plugin. Session recaps are about a squad's evening, not about a game, so
    // the sweep that emits them has no plugin id to look one up by.
    setEventAdapter(createMeepsEventAdapter());

    registerSlashCommands([pingCommand, ...leagueDiscordCommands], 'diana');
    registerSlashCommands([...apexDiscordCommands], 'pathfinder');

    registerPlugin(leagueBotPlugin);
    await loadPlugin(leagueBotPlugin.id);

    registerPlugin(apexBotPlugin);
    await loadPlugin(apexBotPlugin.id);

    // Session Recap (roadmap §7.1). Five minutes is the resolution on "the night
    // is over", which is already coarse: a recap cannot fire until a full idle
    // gap has passed in silence, so the tick adds jitter to a 45-minute wait
    // rather than being the wait itself. See recapSweep.ts.
    registerCoreCron(SESSION_RECAP_LABEL, SESSION_RECAP_CRON, async () => {
        await runRecapSweep(createMeepsEventAdapter());
    });

    // Link verification (DN-3). What the wait is actually for is Riot's
    // summoner-v4 cache noticing an icon change, which takes longer than a
    // person does and is not knowable in advance - so rather than asking the
    // player to keep running `/link confirm` at it, Diana checks and tells them
    // when it lands. See linkSweep.ts.
    registerCoreCron(LINK_SWEEP_LABEL, LINK_SWEEP_CRON, async () => {
        // `createLolService` throws when RIOT_API_KEY is unset. A deployment
        // without one cannot verify anything, but it can still expire abandoned
        // handshakes - so the sweep is handed null rather than the cron throwing
        // every ten minutes forever.
        let lolService = null;
        try {
            lolService = createLolService();
        } catch {
            // Logged by the sweep's own no-op path; nothing to add here.
        }

        await runLinkSweep(lolService, {
            notify: async ({ discordUserId, gameName, tagLine }) => {
                await sendDirectMessage(
                    discordUserId,
                    `**${gameName}#${tagLine}** is now linked to your Discord account — ` +
                        'Riot finally caught up with the icon change. You can set your icon back whenever you like.'
                );
            },
        });
    });

    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const dashboardDir = path.join(repoRoot, 'dashboard', 'dist');
    const indexHtmlPath = path.join(dashboardDir, 'index.html');
    try {
        const fs = await import('fs');
        const stat = fs.statSync(dashboardDir);
        if (stat.isDirectory()) {
            // Apply rate limiting to dashboard routes
            app.use(
                '/dashboard',
                dashboardLimiter,
                express.static(dashboardDir)
            );
            app.get('/dashboard', dashboardLimiter, (_req, res) => {
                res.sendFile(indexHtmlPath);
            });
            app.get('/dashboard/*splat', dashboardLimiter, (_req, res) => {
                res.sendFile(indexHtmlPath);
            });
            const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
                ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
                : `http://localhost:${PORT}`;
            console.log(`[Diana] Dashboard available at ${baseUrl}/dashboard`);
        }
    } catch {
        console.log(
            '[Diana] No dashboard build at dashboard/dist; run "npm run build" in dashboard/.'
        );
    }

    const servers: ReturnType<typeof app.listen>[] = [];
    const startHttpServer = (port: number, label: string) => {
        // "::", not "0.0.0.0". Railway's private network is IPv6: on legacy
        // environments a `*.railway.internal` host resolves to an AAAA record
        // only, so an IPv4-only listener refuses every internal connection at
        // the TCP layer while the public domain keeps serving normally. Meeps
        // spent DN-1 in exactly that state, and DN-5's inbound presence path
        // reaches Diana over the same private network.
        //
        // "::" is dual-stack - Linux accepts IPv4 as v4-mapped addresses on the
        // same socket - so the public edge and localhost are unaffected.
        const server = app.listen(port, '::', () => {
            console.log(`[Diana] Server running on port ${port} (::) ${label}`);
        });
        server.on('error', (err) => {
            console.error('[Diana] HTTP server error:', err);
        });
        servers.push(server);
    };

    startHttpServer(PORT, '(primary)');

    // Railway sometimes routes traffic to a configured port that differs from PORT.
    // To avoid 502s, also listen on 3001 when running on Railway.
    if (inRailway && PORT !== 3001) {
        startHttpServer(3001, '(railway fallback)');
    }

    try {
        await setupAndStartDiscord();
    } catch (err) {
        console.error(
            '[Diana] Discord startup failed; continuing without Discord:',
            err
        );
    }

    const shutdown = () => {
        console.log('[Diana] Shutting down...');
        let remaining = servers.length;
        if (remaining === 0) {
            process.exit(0);
            return;
        }
        for (const srv of servers) {
            srv.close(() => {
                remaining -= 1;
                if (remaining === 0) {
                    process.exit(0);
                }
            });
        }
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('[Diana] Fatal error:', err);
    process.exit(1);
});

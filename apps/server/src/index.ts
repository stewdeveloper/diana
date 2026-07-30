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
    presenceApiRouter,
    sessionsApiRouter,
    authApiRouter,
    requireAuth,
    setPluginMessageAdapter,
    setPluginEventAdapter,
    leagueBotPlugin,
    apexBotPlugin,
} from 'diana-core';
import {
    registerSlashCommands,
    pingCommand,
    setupAndStartDiscord,
    leagueDiscordCommands,
    apexDiscordCommands,
} from 'diana-discord';
import {
    createDianaPluginAdapter,
    createPathfinderPluginAdapter,
} from './messageAdapter';
import { createMeepsEventAdapter } from './meepsEventAdapter';

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
    app.use('/api/squads', requireAuth, squadsApiRouter);
    // Sessions (DN-6) sit behind the dashboard JWT, not the Meeps secret: a
    // session records who was at their computer and with whom, which is personal
    // data about a group rather than a machine-to-machine fact.
    app.use('/api/sessions', requireAuth, sessionsApiRouter);
    // Presence ingestion (DN-5) is machine-to-machine from the Meeps server, so
    // it carries its own shared-secret gate instead of the dashboard's JWT.
    app.use('/api/presence', presenceApiRouter);

    setExpressApp(app);
    setPluginMessageAdapter(leagueBotPlugin.id, createDianaPluginAdapter());
    setPluginMessageAdapter(apexBotPlugin.id, createPathfinderPluginAdapter());

    // Structured events (DN-1). League only for now - the Apex plugin still
    // posts messages exclusively.
    setPluginEventAdapter(leagueBotPlugin.id, createMeepsEventAdapter());

    registerSlashCommands([pingCommand, ...leagueDiscordCommands], 'diana');
    registerSlashCommands([...apexDiscordCommands], 'pathfinder');

    registerPlugin(leagueBotPlugin);
    await loadPlugin(leagueBotPlugin.id);

    registerPlugin(apexBotPlugin);
    await loadPlugin(apexBotPlugin.id);

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
        const server = app.listen(port, '0.0.0.0', () => {
            console.log(
                `[Diana] Server running on port ${port} (0.0.0.0) ${label}`
            );
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

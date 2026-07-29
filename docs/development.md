# Development Guide

## Structure

```
packages/
  diana-core/       # Plugin runtime, Express server, auth, DB utilities
  diana-discord/    # Discord client, slash command registry, message adapters
apps/
  server/           # Entry point - wires plugins, Discord, and HTTP together
dashboard/          # Vite + React dashboard UI
db/                 # SQL migrations
docs/               # This directory
```

---

## Prerequisites

- Node.js 20+
- PostgreSQL
- One or two Discord applications (bot token + client ID each) from the [Discord Developer Portal](https://discord.com/developers/applications)

---

## Setup

```bash
cp .env.example .env   # fill in your values
npm install
npm run build
npm run db:migrate
npm run user -- add <username> <password>
npm start
```

For hot reload during development:

```bash
npm run dev
```

---

## Environment Variables

| Variable                 | Required         | Description                                                                                        |
| ------------------------ | ---------------- | -------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | Yes              | PostgreSQL connection string                                                                       |
| `JWT_SECRET`             | Yes              | Min 32 chars. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `NODE_ENV`               | Yes (prod)       | Set to `production` for secure (HTTPS-only) cookies                                                |
| `DISCORD_BOT_TOKEN`      | Yes (Diana)      | Bot token for the League of Legends bot                                                            |
| `DISCORD_CLIENT_ID`      | Yes (Diana)      | Application ID for the League of Legends bot                                                       |
| `APEX_DISCORD_BOT_TOKEN` | Yes (Pathfinder) | Bot token for the Apex Legends bot                                                                 |
| `APEX_DISCORD_CLIENT_ID` | Yes (Pathfinder) | Application ID for the Apex Legends bot                                                            |
| `RIOT_API_KEY`           | Yes (League)     | Riot Games API key                                                                                 |
| `APEX_API_KEY`           | Yes (Apex)       | mozambiquehe.re API key                                                                            |
| `PORT`                   | No               | HTTP port (default `3000`)                                                                         |
| `DISCORD_GUILD_ID`       | No               | Restrict Diana commands to one server (faster for dev)                                             |
| `APEX_DISCORD_GUILD_ID`  | No               | Restrict Pathfinder commands to one server                                                         |
| `USE_MOCK_RIOT_API`      | No               | `true` to use mock Riot data (default: real API)                                                   |
| `MOCK_APEX_SERVICE`      | No               | `true` to force mock Apex data                                                                     |
| `SUPPORT_URL`            | No               | URL shown at the bottom of match-end embeds                                                        |
| `DISABLE_DISCORD_POSTS`  | No               | Dry-run - suppresses all Discord messages                                                          |
| `MEEPS_WEBHOOK_URL`      | No               | Base URL of the Meeps server. Unset disables outbound events entirely                              |
| `MEEPS_WEBHOOK_SECRET`   | No               | Sent as `x-diana-secret` on outbound events; must match Meeps' `DIANA_WEBHOOK_SECRET`              |
| `DISABLE_MEEPS_POSTS`    | No               | Dry-run - suppresses all outbound Meeps traffic                                                    |
| `MEEPS_INBOUND_SECRET`   | No               | Expected as `x-meeps-secret` on inbound presence events. **Unset disables `/api/presence` (503)**  |

---

## User Management

Dashboard users are managed via CLI:

```bash
npm run user -- add <username> <password>      # create
npm run user -- list                           # list all
npm run user -- passwd <username> <password>   # change password
npm run user -- delete <username>              # delete
```

Password requirements: 12+ characters, at least one uppercase letter and one number.
Sessions last 30 days.

---

## Scripts

| Script                    | Description                            |
| ------------------------- | -------------------------------------- |
| `npm run dev`             | Run with hot reload                    |
| `npm run build`           | Build all packages                     |
| `npm run build:dashboard` | Build dashboard UI to `dashboard/dist` |
| `npm start`               | Run the compiled server                |
| `npm test`                | Run Jest tests                         |
| `npm run user`            | Manage dashboard users                 |
| `npm run db:migrate`      | Run database migrations                |

---

## Creating a Plugin

Implement the `DianaPlugin` interface:

```ts
import type { DianaPlugin } from 'diana-core';

export const myPlugin: DianaPlugin = {
    id: 'my-plugin',
    name: 'My Plugin',
    version: '1.0.0',

    async onLoad(context) {
        context.mountRouter('/my-api', myRouter);
    },

    async onEnable(context) {
        context.registerCron('*/5 * * * *', async () => {
            // runs every 5 minutes while plugin is enabled
        });
    },

    async onDisable() {
        // cron jobs are stopped automatically
    },
};
```

**`PluginContext` API:**

| Method                       | Description                                   |
| ---------------------------- | --------------------------------------------- |
| `mountRouter(path, router)`  | Mount an Express router                       |
| `registerCron(schedule, fn)` | Register a cron job (auto-stopped on disable) |
| `getConfig<T>()`             | Read plugin config saved from the dashboard   |
| `getMessageAdapter()`        | Send messages via the plugin's bot account    |

Register the plugin in `apps/server/src/index.ts`:

```ts
registerPlugin(myPlugin);
await loadPlugin(myPlugin.id);
```

Slash commands are registered out-of-band in `apps/server/src/index.ts` via
`registerSlashCommands(commands, botKey)` from `diana-discord` - there is no
`PluginContext` method for them.

See `packages/diana-core/src/plugins/diana-league-bot/` for a complete reference implementation.

---

## Deployment

### Standard

```bash
npm run build
npm run build:dashboard   # optional - serves UI at /dashboard
npm start
```

### Docker

```bash
docker build -t diana .
docker run --env-file .env -p 3000:3000 diana
```

Point `DATABASE_URL` at an external Postgres instance. Override the port with `PORT`.

/**
 * Running Diana's commands from Meeps.
 *
 * WHY THIS LIVES IN apps/server AND NOT IN diana-core
 *
 * The commands are defined in `diana-discord`, which depends on `diana-core`.
 * Core cannot import them back without a cycle, so a router in core would have
 * nothing to route to. `apps/server` already owns exactly this kind of wiring -
 * it is where the message and event adapters are joined up - so the router sits
 * here and the pure pieces stay in `diana-discord`.
 *
 * THE THREE ROUTES
 *
 *     GET  /api/commands          what Meeps may offer, and what each takes
 *     POST /api/commands/run      run one, get back a MessagePayload
 *     POST /api/commands/suggest  suggestions for one parameter
 *
 * The id is carried in the body rather than the path because a subcommand's id
 * contains a colon (`leaderboard:lp`), and a path segment that needs escaping
 * is a bug waiting for whichever client forgets.
 *
 * All three sit behind the Meeps shared secret. Unlike `squadsApi`'s
 * `meepsSecretOrSkip`, there is no fall-through to a JWT router: the dashboard
 * has no reason to run commands, so a request without the secret is a mistake
 * rather than a different caller.
 */

import { Router, type Request, type Response } from 'express';
import {
    requireMeepsSecret,
    resolveCommandScope,
    SCOPE_FAILURE_MESSAGES,
} from 'diana-core';
import {
    buildCommandManifest,
    findCommandDescriptor,
    invokeCommand,
    suggestForCommand,
    type CommandParamValue,
} from 'diana-discord';

function timestamp(): string {
    return new Date().toISOString();
}

/**
 * Commands that spend a Riot call per invocation, and how long a space must
 * wait between them.
 *
 * In Discord these are rate-limited by `handleSlashCommand`'s 3s per-user
 * cooldown. That cooldown is not shared with this path on purpose - a Meeps
 * caller must not consume a Discord user's budget - so the ones that actually
 * cost something get their own, keyed per space rather than per person, because
 * the thing being protected is the Riot quota and that is shared.
 *
 * Roadmap §9 costs `/livegame` at one spectator call per invocation.
 */
const COOLDOWN_MS: Record<string, number> = {
    livegame: 10_000,
};

const lastRun = new Map<string, number>();

/** Remaining cooldown in ms, or 0. Records the run when it is allowed. */
function consumeCooldown(spaceId: string, commandName: string): number {
    const window = COOLDOWN_MS[commandName];
    if (!window) return 0;

    const key = `${spaceId}:${commandName}`;
    const remaining = window - (Date.now() - (lastRun.get(key) ?? 0));
    if (remaining > 0) return remaining;

    lastRun.set(key, Date.now());
    return 0;
}

/** Only the value types a manifest parameter can have. */
function parseParams(raw: unknown): Record<string, CommandParamValue> {
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, CommandParamValue> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (value === null) continue;
        if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
        ) {
            out[key] = value;
        }
    }
    return out;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * What Meeps may offer.
 *
 * Unconditional - the manifest describes what exists, not what this particular
 * space may run, and a space with no squad still needs the picker to render so
 * it can explain itself when a command is attempted.
 */
export function getCommandManifest(_req: Request, res: Response): void {
    res.json({ commands: buildCommandManifest() });
}

/**
 * Resolve the scope, or answer the caller with the reason it could not be.
 *
 * Returns null when it has already responded. Every failure is 200 with a
 * `message`, not 4xx: "your squad has two Discord servers" is a thing to show
 * the person in the channel, not a transport error for Meeps to retry.
 */
async function scopeOrExplain(
    spaceId: string,
    res: Response
): Promise<{ squadId: string; guildId: string } | null> {
    const scope = await resolveCommandScope(spaceId);
    if (!scope.ok) {
        res.json({
            ok: false,
            reason: scope.reason,
            message: SCOPE_FAILURE_MESSAGES[scope.reason],
        });
        return null;
    }
    return { squadId: scope.squadId, guildId: scope.guildId };
}

export async function runCommand(req: Request, res: Response): Promise<void> {
    const spaceId = readString(req.body?.spaceId);
    const id = readString(req.body?.id);
    const actor = readString(req.body?.actorId);

    if (!spaceId || !id) {
        res.status(400).json({ error: 'spaceId and id are required' });
        return;
    }

    const descriptor = findCommandDescriptor(id);
    if (!descriptor) {
        res.status(404).json({ error: `Unknown command "${id}"` });
        return;
    }

    try {
        const scope = await scopeOrExplain(spaceId, res);
        if (!scope) return;

        const waitMs = consumeCooldown(spaceId, descriptor.name);
        if (waitMs > 0) {
            res.json({
                ok: false,
                reason: 'cooldown',
                message: `That one talks to Riot, so it is rate limited. Try again in ${Math.ceil(waitMs / 1000)}s.`,
            });
            return;
        }

        const outcome = await invokeCommand({
            id,
            params: parseParams(req.body?.params),
            guildId: scope.guildId,
            // Namespaced so an audit column holding this can never be mistaken
            // for a Discord id. See CommandInvocation.actorId.
            actorId: `meeps:${actor ?? 'unknown'}`,
        });

        if (!outcome.ok) {
            console.warn(
                `[${timestamp()}] [Diana:commands] "${id}" produced no reply (${outcome.reason}).`
            );
            res.json({
                ok: false,
                reason: outcome.reason,
                message:
                    'Something went wrong running that. Try again shortly.',
            });
            return;
        }

        res.json({ ok: true, payload: outcome.payload });
    } catch (err) {
        console.error(
            `[${timestamp()}] [Diana:commands] POST /run "${id}" error:`,
            err
        );
        res.status(500).json({ error: 'Failed to run command' });
    }
}

export async function suggestCommand(
    req: Request,
    res: Response
): Promise<void> {
    const spaceId = readString(req.body?.spaceId);
    const id = readString(req.body?.id);
    const param = readString(req.body?.param);

    if (!spaceId || !id || !param) {
        res.status(400).json({ error: 'spaceId, id and param are required' });
        return;
    }

    try {
        const scope = await resolveCommandScope(spaceId);
        // Suggestions degrade to silence rather than explaining themselves: the
        // picker is mid-keystroke, and the person finds out why when they
        // actually run the command.
        if (!scope.ok) {
            res.json({ suggestions: [] });
            return;
        }

        const suggestions = await suggestForCommand(
            {
                id,
                params: parseParams(req.body?.params),
                guildId: scope.guildId,
                actorId: 'meeps:suggest',
            },
            scope.squadId,
            param,
            typeof req.body?.query === 'string' ? req.body.query : ''
        );

        res.json({ suggestions });
    } catch (err) {
        console.error(
            `[${timestamp()}] [Diana:commands] POST /suggest "${id}" error:`,
            err
        );
        res.json({ suggestions: [] });
    }
}

const router = Router();
router.get('/', requireMeepsSecret, getCommandManifest);
router.post('/run', requireMeepsSecret, runCommand);
router.post('/suggest', requireMeepsSecret, suggestCommand);

export const commandApiRouter = router;

/** Test seam: the cooldown map is module state and outlives a single test. */
export const __test = { lastRun };

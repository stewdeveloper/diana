/**
 * Running a Discord command without Discord.
 *
 * WHAT THIS IS
 *
 * Every Diana command takes a discord.js `ChatInputCommandInteraction`. Meeps
 * has no such thing and never will. This builds an object that satisfies the
 * part of that interface the allowlisted commands actually use, runs the
 * command against it, and captures what the command tried to reply with.
 *
 * WHY A SHIM IS ACCEPTABLE HERE AND USUALLY IS NOT
 *
 * A duck-typed stand-in for a large interface is normally a slow-motion
 * failure: it type-checks against nothing, so the day a command reaches for
 * `interaction.member.roles` it breaks in production and nowhere earlier.
 *
 * Two things buy that off.
 *
 * First, the surface is small and was measured rather than guessed. Across all
 * ten allowlisted commands it is exactly: `deferReply`, `editReply`, `reply`,
 * `guildId`, `user.id`, `responded`, `respond`, and five `options` getters.
 * Twelve members, all trivial.
 *
 * Second - and this is the part that matters - `test/commandConformance.test.ts`
 * runs every allowlisted command through this shim. When the surface stops
 * being enough, CI says so, not a deploy.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No cooldown, no channel gate, no permission check. Those live in
 * `handleSlashCommand` because they are Discord's concerns; the HTTP layer in
 * front of this applies its own. Sharing them would mean a Meeps caller
 * consuming a Discord user's cooldown budget.
 */

import type { MessageField, MessagePayload } from 'diana-core';
import { getRegisteredCommands } from './commandRegistry';
import { findCommandDescriptor } from './commandManifest';

/** A parameter value as it arrives over HTTP. */
export type CommandParamValue = string | number | boolean | null;

export interface CommandInvocation {
    /** Route key from the manifest: `summoner`, `leaderboard:lp`. */
    id: string;
    params: Record<string, CommandParamValue>;
    /** Resolved by `resolveCommandScope`. Commands read this directly. */
    guildId: string;
    /**
     * Who ran it, namespaced.
     *
     * This reaches `squad_summoners.added_by` through `/add`. That column is a
     * nullable audit field with no foreign key, so a Meeps id is safe there -
     * but it sits beside Discord ids, and an unprefixed number would be
     * indistinguishable from one. `meeps:` says which system the id belongs to
     * and fits the column's VARCHAR(30) with room to spare.
     */
    actorId: string;
}

export type CommandOutcome =
    | { ok: true; payload: MessagePayload }
    | { ok: false; reason: 'unknown_command' | 'no_reply' | 'threw' };

interface CapturedReply {
    content?: string;
    embeds?: unknown[];
}

/** Anything with a `toJSON`, which is how discord.js builders serialise. */
function unwrapEmbed(embed: unknown): Record<string, unknown> | null {
    if (!embed || typeof embed !== 'object') return null;
    const maybeBuilder = embed as { toJSON?: () => Record<string, unknown> };
    if (typeof maybeBuilder.toJSON === 'function') return maybeBuilder.toJSON();
    return embed as Record<string, unknown>;
}

/**
 * Discord embed JSON to Diana's own `MessagePayload`.
 *
 * These two shapes are close but not the same, and the three differences are
 * the whole reason this function exists rather than a cast:
 *
 *     Discord                     MessagePayload
 *     color            (int)      colorHex        (int, same value)
 *     thumbnail: {url}            thumbnailUrl    (flat)
 *     footer: {text}              footer          (string)
 *
 * `MessagePayload` is what Meeps' `EmbedCard` has rendered since migration 013,
 * so converting here means no new renderer on that side.
 */
export function toMessagePayload(captured: CapturedReply): MessagePayload {
    const payload: MessagePayload = {};
    if (captured.content) payload.text = captured.content;

    const embeds = captured.embeds ?? [];
    if (embeds.length > 1) {
        // Nothing allowlisted does this today. If something starts to, the
        // extra embeds would vanish silently without this line.
        console.warn(
            `[Diana] Command reply carried ${embeds.length} embeds; Meeps renders one.`
        );
    }

    const embed = unwrapEmbed(embeds[0]);
    if (!embed) return payload;

    if (typeof embed.title === 'string') payload.title = embed.title;
    if (typeof embed.description === 'string') {
        payload.description = embed.description;
    }
    if (typeof embed.url === 'string') payload.url = embed.url;
    if (typeof embed.color === 'number') payload.colorHex = embed.color;
    if (typeof embed.timestamp === 'string')
        payload.timestamp = embed.timestamp;

    const thumbnail = embed.thumbnail as { url?: string } | undefined;
    if (thumbnail?.url) payload.thumbnailUrl = thumbnail.url;

    const footer = embed.footer as { text?: string } | undefined;
    if (footer?.text) payload.footer = footer.text;

    if (Array.isArray(embed.fields)) {
        payload.fields = (embed.fields as MessageField[]).map((f) => ({
            name: f.name,
            value: f.value,
            ...(f.inline === true ? { inline: true } : {}),
        }));
    }

    return payload;
}

/** Normalise the several shapes a command may reply with. */
function captureReply(payload: unknown): CapturedReply {
    if (typeof payload === 'string') return { content: payload };
    if (!payload || typeof payload !== 'object') return {};
    const obj = payload as { content?: unknown; embeds?: unknown };
    return {
        ...(typeof obj.content === 'string' ? { content: obj.content } : {}),
        ...(Array.isArray(obj.embeds) ? { embeds: obj.embeds } : {}),
    };
}

interface ShimState {
    captured: CapturedReply | null;
    choices: Array<{ name: string; value: string | number }>;
    responded: boolean;
}

/**
 * The stand-in itself.
 *
 * `focused` is only set on the autocomplete path, where `getFocused(true)` must
 * report which parameter the picker is asking about.
 */
function buildShim(
    invocation: CommandInvocation,
    subcommand: string | undefined,
    state: ShimState,
    focused?: { name: string; value: string }
) {
    const read = (name: string): CommandParamValue => {
        const value = invocation.params[name];
        return value === undefined ? null : value;
    };

    const asString = (name: string): string | null => {
        const value = read(name);
        return value === null ? null : String(value);
    };

    return {
        guildId: invocation.guildId,
        user: { id: invocation.actorId },
        get responded() {
            return state.responded;
        },
        options: {
            getString: (name: string) => asString(name),
            getInteger: (name: string) => {
                const value = read(name);
                return value === null ? null : Number(value);
            },
            getNumber: (name: string) => {
                const value = read(name);
                return value === null ? null : Number(value);
            },
            getBoolean: (name: string) => {
                const value = read(name);
                return value === null ? null : Boolean(value);
            },
            getSubcommand: () => subcommand ?? null,
            getFocused: (withMeta?: boolean) =>
                withMeta
                    ? (focused ?? { name: '', value: '' })
                    : (focused?.value ?? ''),
        },
        deferReply: async () => undefined,
        reply: async (payload: unknown) => {
            state.captured = captureReply(payload);
            state.responded = true;
        },
        editReply: async (payload: unknown) => {
            state.captured = captureReply(payload);
            state.responded = true;
        },
        followUp: async (payload: unknown) => {
            state.captured = captureReply(payload);
            state.responded = true;
        },
        respond: async (
            choices: Array<{ name: string; value: string | number }>
        ) => {
            state.choices = choices;
            state.responded = true;
        },
    };
}

/**
 * Run an allowlisted command and return what it would have shown.
 *
 * Never throws. A command that fails mid-flight has usually already replied
 * with its own error message - they all wrap their bodies in try/catch and
 * `editReply` an apology - so the captured payload is preferred over the
 * exception even when one escaped.
 */
export async function invokeCommand(
    invocation: CommandInvocation
): Promise<CommandOutcome> {
    const descriptor = findCommandDescriptor(invocation.id);
    if (!descriptor) return { ok: false, reason: 'unknown_command' };

    const command = getRegisteredCommands('diana').find(
        (c) => c.data.name === descriptor.name
    );
    if (!command) return { ok: false, reason: 'unknown_command' };

    const state: ShimState = { captured: null, choices: [], responded: false };
    const shim = buildShim(invocation, descriptor.subcommand, state);

    try {
        // The shim satisfies the measured surface, not the full interface; the
        // conformance test is what keeps that true.
        await command.execute(shim as never);
    } catch (err) {
        // Constant format string with the id as an argument, not interpolated
        // into it: the id arrives in a request body, and console treats its
        // first argument as a format string - so a "%s" in an id would be
        // consumed as a specifier rather than printed.
        console.error('[Diana] Command "%s" threw:', invocation.id, err);
        if (!state.captured) return { ok: false, reason: 'threw' };
    }

    if (!state.captured) return { ok: false, reason: 'no_reply' };
    return { ok: true, payload: toMessagePayload(state.captured) };
}

/**
 * Ask a command's own autocomplete handler for suggestions.
 *
 * Returns Discord's `{name, value}` choices unchanged. The `fill` enrichment
 * that lets one click populate several chips is layered on in
 * `commandSuggest.ts` - this stays a faithful passthrough so a command with no
 * enrichment behaves exactly as it does in Discord.
 */
export async function suggestFromCommand(
    invocation: CommandInvocation,
    param: string,
    query: string
): Promise<Array<{ name: string; value: string | number }>> {
    const descriptor = findCommandDescriptor(invocation.id);
    if (!descriptor) return [];

    const command = getRegisteredCommands('diana').find(
        (c) => c.data.name === descriptor.name
    );
    if (!command?.autocomplete) return [];

    const state: ShimState = { captured: null, choices: [], responded: false };
    const shim = buildShim(invocation, descriptor.subcommand, state, {
        name: param,
        value: query,
    });

    try {
        await command.autocomplete(shim as never);
    } catch (err) {
        // A failed suggestion is a slower path to the same answer - the person
        // can still type the value - so this never propagates.
        console.error(
            '[Diana] Autocomplete for "%s.%s" threw:',
            invocation.id,
            param,
            err
        );
        return [];
    }

    return state.choices;
}

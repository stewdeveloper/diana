/**
 * Which Diana commands Meeps may run, and what they take.
 *
 * DERIVED, NEVER WRITTEN TWICE
 *
 * `cmd.data.toJSON()` already describes every command exactly: names,
 * descriptions, parameters, types, required flags, choices and autocomplete
 * flags. That is the manifest. Re-declaring it by hand would create a second
 * source of truth that drifts the first time somebody adds an option, and the
 * drift would surface as a command that rejects what its own picker offered.
 *
 * A CLOSED LIST, NOT AN OPEN ONE
 *
 * `MEEPS_COMMANDS` is an allowlist rather than a denylist, so a command added
 * to Diana is invisible in Meeps until somebody deliberately opens it. The
 * exclusions below are not preference - see `EXCLUDED` for why each one would
 * be wrong rather than merely unwanted.
 *
 * SUBCOMMANDS BECOME THEIR OWN ENTRIES
 *
 * `/leaderboard` cannot be invoked bare - Discord requires `lp` or `stats`, and
 * they take different options. Rather than teach the picker a second level, each
 * subcommand becomes its own manifest entry with its own parameter list. The
 * picker shows "/leaderboard lp" and "/leaderboard stats" as two rows you can
 * choose directly, which is both simpler to render and fewer keystrokes than
 * Discord's own two-step.
 */

import { ApplicationCommandOptionType } from 'discord.js';
import { getRegisteredCommands, getRegistryVersion } from './commandRegistry';

/**
 * Commands Meeps may run.
 *
 * The first eight answer a question about the squad. `add` and `remove` mutate
 * the roster and are marked `mutates` so both sides can gate them on space
 * membership - the Meeps-side equivalent of being in the guild.
 */
export const MEEPS_COMMANDS: ReadonlySet<string> = new Set([
    'summoner',
    'leaderboard',
    'champion',
    'compare',
    'livegame',
    'iotw',
    'mvp',
    'wrapped',
    'add',
    'remove',
]);

/** Commands that change something. Everything else is a read. */
const MUTATING_COMMANDS: ReadonlySet<string> = new Set(['add', 'remove']);

/**
 * Why the rest are not here. Kept as prose rather than a list of names because
 * the reasons differ in kind, and two of them are correctness rather than taste.
 *
 * `link`, `unlink`
 *     These bind a Riot account to a *Discord user id*. Invoked from Meeps the
 *     actor is a Meeps user id, so exposing them would write a Meeps id into
 *     `identity_link_challenges.discord_user_id` and corrupt identity rows
 *     silently. Needs a Meeps-native identity flow, which is its own work.
 *
 * `setchannel`, `config`, `apex-channel`
 *     These configure how Diana posts *to Discord*. Running them from Meeps
 *     changes a different product's delivery settings.
 *
 * `help`, `ping`, `apex-help`
 *     `/help` renders `</name:id>` command mentions, which are Discord chips and
 *     render as literal noise anywhere else.
 *
 * `privacy`
 *     A personal decision keyed on puuid through `identity_accounts`. It has its
 *     own API route already and deserves a real Meeps surface, not a command.
 *
 * the remaining `apex-*`
 *     A different bot (`pathfinder` botKey) and plugin. Not excluded on
 *     principle - just not in this slice.
 */

export type MeepsParamType = 'string' | 'integer' | 'number' | 'boolean';

export interface MeepsCommandParam {
    name: string;
    description: string;
    type: MeepsParamType;
    required: boolean;
    /** Whether the picker should ask Diana for suggestions as you type. */
    autocomplete: boolean;
    choices?: Array<{ label: string; value: string | number }>;
}

export interface MeepsCommandDescriptor {
    /** Route key. `summoner`, or `leaderboard:lp` for a subcommand. */
    id: string;
    name: string;
    subcommand?: string;
    /** What the picker shows: `/summoner`, `/leaderboard lp`. */
    display: string;
    description: string;
    params: MeepsCommandParam[];
    /** True for commands that change the roster. */
    mutates: boolean;
}

/** Discord's numeric option types, mapped to the few Meeps can render. */
const PARAM_TYPES: Partial<Record<number, MeepsParamType>> = {
    [ApplicationCommandOptionType.String]: 'string',
    [ApplicationCommandOptionType.Integer]: 'integer',
    [ApplicationCommandOptionType.Number]: 'number',
    [ApplicationCommandOptionType.Boolean]: 'boolean',
};

interface RawOption {
    name: string;
    description: string;
    type: number;
    required?: boolean;
    autocomplete?: boolean;
    choices?: Array<{ name: string; value: string | number }>;
    options?: RawOption[];
}

/**
 * Convert one Discord option, or null if Meeps has no way to ask for it.
 *
 * `USER`, `CHANNEL`, `ROLE`, `MENTIONABLE` and `ATTACHMENT` all resolve against
 * a Discord guild the Meeps client cannot see. A picker cannot honestly offer
 * them, so the command carrying one is dropped whole rather than offered with a
 * parameter nobody can fill - see `toDescriptor`.
 */
function toParam(option: RawOption): MeepsCommandParam | null {
    const type = PARAM_TYPES[option.type];
    if (!type) return null;

    return {
        name: option.name,
        description: option.description,
        type,
        required: option.required === true,
        autocomplete: option.autocomplete === true,
        ...(option.choices?.length
            ? {
                  choices: option.choices.map((c) => ({
                      label: c.name,
                      value: c.value,
                  })),
              }
            : {}),
    };
}

/**
 * Build one entry, or null if any of its parameters cannot be represented.
 *
 * All-or-nothing on purpose. Dropping just the unrepresentable parameter would
 * produce a command that looks complete in the picker and fails on submit if
 * that parameter was required - a worse outcome than not offering it.
 */
function toDescriptor(
    name: string,
    description: string,
    options: RawOption[],
    subcommand?: string
): MeepsCommandDescriptor | null {
    const params: MeepsCommandParam[] = [];
    for (const option of options) {
        const param = toParam(option);
        if (!param) {
            console.warn(
                `[Diana] Command "${name}${subcommand ? ` ${subcommand}` : ''}" has an option ` +
                    `("${option.name}", type ${option.type}) Meeps cannot render; not offering it.`
            );
            return null;
        }
        params.push(param);
    }

    return {
        id: subcommand ? `${name}:${subcommand}` : name,
        name,
        ...(subcommand ? { subcommand } : {}),
        display: subcommand ? `/${name} ${subcommand}` : `/${name}`,
        description,
        params,
        mutates: MUTATING_COMMANDS.has(name),
    };
}

let cache: { version: number; manifest: MeepsCommandDescriptor[] } | null =
    null;

/**
 * Every command Meeps may offer, in picker order.
 *
 * Memoised against the registry's version rather than rebuilt per call.
 * Deriving this means `toJSON()` on every registered command, and the suggest
 * route asks for it on every keystroke - so per-call was measurable work in the
 * one place latency is felt. Keying on the version rather than caching outright
 * means a test that re-registers commands still sees its own set.
 */
export function buildCommandManifest(): MeepsCommandDescriptor[] {
    const version = getRegistryVersion();
    // Shallow copy on the way out, matching `getRegisteredCommands`: the cached
    // array is shared, and a caller sorting or filtering it in place would
    // silently change what every later caller sees.
    if (cache?.version === version) return [...cache.manifest];

    const manifest: MeepsCommandDescriptor[] = [];

    for (const command of getRegisteredCommands('diana')) {
        const json = command.data.toJSON() as {
            name: string;
            description: string;
            options?: RawOption[];
        };
        if (!MEEPS_COMMANDS.has(json.name)) continue;

        const options = json.options ?? [];
        const subcommands = options.filter(
            (o) => o.type === ApplicationCommandOptionType.Subcommand
        );

        // Subcommand *groups* nest one level deeper. Nothing allowlisted uses
        // one today; if that changes, this is where it would need handling
        // rather than silently offering a broken entry.
        const hasGroup = options.some(
            (o) => o.type === ApplicationCommandOptionType.SubcommandGroup
        );
        if (hasGroup) {
            console.warn(
                `[Diana] Command "${json.name}" uses subcommand groups, which the Meeps ` +
                    'manifest does not model; not offering it.'
            );
            continue;
        }

        if (subcommands.length > 0) {
            for (const sub of subcommands) {
                const entry = toDescriptor(
                    json.name,
                    sub.description,
                    sub.options ?? [],
                    sub.name
                );
                if (entry) manifest.push(entry);
            }
            continue;
        }

        const entry = toDescriptor(json.name, json.description, options);
        if (entry) manifest.push(entry);
    }

    manifest.sort((a, b) => a.display.localeCompare(b.display));
    cache = { version, manifest };
    return [...manifest];
}

/** One entry by its route key, or null. */
export function findCommandDescriptor(
    id: string
): MeepsCommandDescriptor | null {
    return buildCommandManifest().find((c) => c.id === id) ?? null;
}

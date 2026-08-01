/**
 * Suggestions for Meeps' command picker.
 *
 * ONE CLICK SHOULD FILL EVERY BOX IT CAN
 *
 * Discord's autocomplete protocol returns `{name, value}` and nothing else, so
 * a handler physically cannot say "this choice sets both `name` and `tag`".
 * That is why `/summoner` in Discord is two steps: pick a name, then pick a tag
 * from the list that name narrowed.
 *
 * The limit is the protocol's, not the data's. Meeps' picker is ours, so this
 * adds a `fill` map alongside each suggestion - click "Louis#EUW" and both
 * chips populate at once, with the player's rank shown underneath.
 *
 * FALLING BACK IS THE DEFAULT, NOT THE ERROR PATH
 *
 * Only summoner-shaped parameters are enriched. Everything else - champion
 * names, queues, boards - passes straight through to the command's own
 * autocomplete handler and behaves exactly as it does in Discord. A command
 * with no enrichment entry needs no work to be correct here.
 */

import { searchSquadSummoners, type SquadSummonerSuggestion } from 'diana-core';
import { findCommandDescriptor } from './commandManifest';
import {
    suggestFromCommand,
    type CommandInvocation,
} from './commandInvocation';

export interface CommandSuggestion {
    /** Primary line: what the person is choosing. */
    label: string;
    /** Secondary line, when there is something worth knowing. */
    sublabel?: string;
    /** Value for the focused parameter. */
    value: string | number;
    /**
     * Every parameter this choice sets, focused one included.
     *
     * Always populated so the client has a single code path - a suggestion that
     * fills only its own parameter carries a one-entry map rather than nothing.
     */
    fill: Record<string, string | number>;
}

/**
 * How a command's parameters map onto a summoner row.
 *
 * `combined` commands take the whole `Name#Tag` in one parameter (`/compare`
 * splits it back apart itself); the rest take name and tag separately.
 */
interface SummonerParams {
    nameParam: string;
    tagParam?: string;
    combined?: boolean;
}

/**
 * Which parameters name a member of the squad.
 *
 * `/add` is deliberately absent. It exists to track somebody *not* in the squad
 * yet, so suggesting current members would offer exactly the wrong set - and it
 * has no autocomplete handler in Discord for the same reason.
 *
 * `/champion`'s `champion` parameter is also absent: it autocompletes champion
 * names, which are not summoners and pass through untouched.
 */
const SUMMONER_PARAMS: Record<string, SummonerParams[]> = {
    summoner: [{ nameParam: 'name', tagParam: 'tag' }],
    champion: [{ nameParam: 'name', tagParam: 'tag' }],
    livegame: [{ nameParam: 'name', tagParam: 'tag' }],
    remove: [{ nameParam: 'name', tagParam: 'tag' }],
    compare: [
        { nameParam: 'player1', combined: true },
        { nameParam: 'player2', combined: true },
    ],
};

/** "GOLD"/"II"/42 -> "Gold II · 42 LP". Absent rank means no second line. */
function describeRank(row: SquadSummonerSuggestion): string | undefined {
    const tier = row.tier;
    if (!tier || tier === 'UNRANKED') return undefined;

    const pretty = tier.charAt(0) + tier.slice(1).toLowerCase();
    const division = row.rank && row.rank !== 'N/A' ? ` ${row.rank}` : '';
    const lp = typeof row.lp === 'number' ? ` · ${row.lp} LP` : '';
    return `${pretty}${division}${lp}`;
}

function summonerLabel(row: SquadSummonerSuggestion): string {
    return row.tagLine ? `${row.gameName}#${row.tagLine}` : row.gameName;
}

/** Which summoner-shaped parameter, if any, is being asked about. */
function summonerParamsFor(
    commandName: string,
    param: string
): SummonerParams | null {
    const entries = SUMMONER_PARAMS[commandName] ?? [];
    return (
        entries.find((e) => e.nameParam === param || e.tagParam === param) ??
        null
    );
}

/**
 * Suggestions for one parameter.
 *
 * Never throws: a failed lookup costs the person a shortcut, not the ability to
 * type the value themselves, so it degrades to an empty list.
 */
export async function suggestForCommand(
    invocation: CommandInvocation,
    squadId: string,
    param: string,
    query: string
): Promise<CommandSuggestion[]> {
    const descriptor = findCommandDescriptor(invocation.id);
    if (!descriptor) return [];

    const shape = summonerParamsFor(descriptor.name, param);

    if (shape) {
        // When the tag is being asked for, the name already chosen narrows the
        // search - the same behaviour Discord's handler has, kept here so the
        // enriched path is not a downgrade in that one respect.
        const chosenName =
            shape.tagParam === param
                ? invocation.params[shape.nameParam]
                : null;
        const search = chosenName ? `${String(chosenName)}#${query}` : query;

        let rows: SquadSummonerSuggestion[] = [];
        try {
            rows = await searchSquadSummoners(squadId, search, 25);
        } catch (err) {
            console.error(
                `[Diana] Summoner suggestions for "${invocation.id}.${param}" failed:`,
                err
            );
            return [];
        }

        return rows.map((row) => {
            const label = summonerLabel(row);
            if (shape.combined) {
                return {
                    label,
                    sublabel: describeRank(row),
                    value: label,
                    fill: { [shape.nameParam]: label },
                };
            }

            const fill: Record<string, string | number> = {
                [shape.nameParam]: row.gameName,
            };
            if (shape.tagParam && row.tagLine)
                fill[shape.tagParam] = row.tagLine;

            return {
                label,
                sublabel: describeRank(row),
                value:
                    param === shape.tagParam
                        ? (row.tagLine ?? '')
                        : row.gameName,
                fill,
            };
        });
    }

    // Everything else is the command's own handler, unchanged.
    const choices = await suggestFromCommand(invocation, param, query);
    return choices.map((choice) => ({
        label: choice.name,
        value: choice.value,
        fill: { [param]: choice.value },
    }));
}

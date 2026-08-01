/**
 * What a command invoked from Meeps is allowed to see.
 *
 * WHY THIS IS NOT A ONE-LINER
 *
 * Diana's commands scope by `guildId`. A Meeps request has no guild anywhere in
 * it - Meeps scopes by space, and `dianaSquads` resolves that to a squad. So
 * every command reached from Meeps needs a guild synthesised for it, and the
 * only honest source is the squad's own Discord attachment.
 *
 * `squad_attachments` has PRIMARY KEY (kind, external_id). That guarantees one
 * guild resolves to one squad. It does NOT guarantee the reverse: a squad may
 * have two Discord servers attached, and those servers each carry their own
 * `competitive_scope` and `channel_id`. Asked "does Arena count for this
 * squad?", a two-guild squad has two answers.
 *
 * So this refuses rather than picking one. Silently taking the first attachment
 * would give an answer that is right about half the time and never says which
 * half - the worst of the available behaviours. `dianaSquads` on the Meeps side
 * already draws this line for unresolved spaces, and for the same reason: "we
 * do not know who is allowed to see this" is not a thing to guess at.
 */

import {
    getSquadAttachments,
    getSquadIdForAttachment,
} from '../squads/squadService';

/** Why a scope could not be resolved. Each maps to a different fix. */
export type CommandScopeFailure =
    /** The space has never been attached to a squad on Diana's side. */
    | 'no_squad'
    /** The squad exists but has no Discord server, so no guild config exists. */
    | 'no_guild'
    /** Two or more Discord servers: no single competitive scope to apply. */
    | 'ambiguous_guild';

export type CommandScope =
    | { ok: true; squadId: string; guildId: string }
    | { ok: false; reason: CommandScopeFailure; guildIds?: string[] };

/**
 * Human-readable reason, for showing the person who ran the command.
 *
 * These are shown in a chat channel, not a log, so each says what to do next
 * rather than what went wrong internally.
 */
export const SCOPE_FAILURE_MESSAGES: Record<CommandScopeFailure, string> = {
    no_squad:
        'This space is not linked to a squad yet, so there is nothing for me to look up. ' +
        'An admin can attach it from the Diana dashboard.',
    no_guild:
        'This squad has no Discord server attached, and my stats settings live per server. ' +
        'Run `/setchannel` in your Discord server to attach it.',
    ambiguous_guild:
        'This squad is attached to more than one Discord server, and they can disagree about ' +
        'which queues count. Run the command in Discord instead, so I know which one you mean.',
};

/**
 * Resolve a Meeps space to the scope a command should run in.
 *
 * Deliberately uses `getSquadIdForAttachment` rather than
 * `getOrCreateSquadForAttachment`: reading a leaderboard must never bring a
 * squad into existence as a side effect. A space with no squad is a real state
 * with a real fix, not something to paper over.
 */
export const resolveCommandScope = async (
    spaceId: string
): Promise<CommandScope> => {
    const squadId = await getSquadIdForAttachment('meeps_space', spaceId);
    if (!squadId) return { ok: false, reason: 'no_squad' };

    const attachments = await getSquadAttachments(squadId);
    const guildIds = attachments
        .filter((a) => a.kind === 'discord_guild')
        .map((a) => a.external_id);

    if (guildIds.length === 0) return { ok: false, reason: 'no_guild' };
    if (guildIds.length > 1) {
        return { ok: false, reason: 'ambiguous_guild', guildIds };
    }

    return { ok: true, squadId, guildId: guildIds[0] };
};

import 'dotenv/config';
import type { MessageAdapter } from '../../../core/pluginTypes.js';
import type { EventAdapter } from '../../../core/eventTypes.js';
import {
    DIANA_EVENT_SCHEMA_VERSION,
    buildR6EventId,
} from '../../../core/eventTypes.js';
import { createR6Service } from '../api/utils/r6ServiceFactory.js';
import {
    getAllTrackedR6Players,
    getR6PlayerById,
    getGuildsTrackingR6Player,
    getSquadsTrackingR6Player,
    updateR6PlayerRankAndSnapshot,
    markR6PlayerPolled,
    createR6RankHistory,
    diffSnapshot,
    type R6SnapshotDiff,
} from '../api/players/playerService.js';
import {
    determineR6RankMovement,
    formatR6Rank,
    getR6RpToNextRank,
} from '../api/utils/rankService.js';
import {
    notifyR6Match,
    notifyR6RankChange,
    notifyR6Session,
    r6MatchResultLabel,
} from '../notifications/r6Notifications.js';
import { currentR6BudgetPlan } from '../api/utils/r6Budget.js';
import {
    DEFAULT_R6_POLL_CADENCE,
    nextActiveUntil,
    selectPlayersToPoll,
    type R6PollCadence,
} from './r6PollScheduler.js';

const r6Service = createR6Service();

/**
 * How many matches the counter diff resolves to, and which single one if one.
 *
 * Siege reports season-cumulative counters and no match record, so "a match
 * happened" is inferred from wins, losses and abandons together. All three are
 * needed: an abandon moves RP while wins and losses stand still, so counting
 * only the first two reads an abandoned game as a window in which nothing
 * occurred.
 *
 * Returns `null` for the outcome when the window is not exactly one match wide —
 * including when there is no baseline at all, where the diff is unknown rather
 * than zero.
 */
export function resolveSingleMatch(gained: R6SnapshotDiff): {
    matches: number | null;
    /** true = won, false = lost, null = abandoned; undefined = not one match. */
    win?: boolean | null;
} {
    const { winsGained, lossesGained, abandonsGained } = gained;
    if (winsGained === null || lossesGained === null) {
        return { matches: null };
    }

    // A missing abandons baseline is treated as zero abandons rather than as an
    // unknown total, and that is a deliberate asymmetry. Wins and losses have
    // been persisted since 020; abandons only since 023, so for one poll after
    // the migration every player has the first two and not the third. Refusing
    // to resolve a match in that window would suppress a real Victory card for
    // no gain, and the failure it risks is narrow: a window whose *only* event
    // was an abandon reads as zero matches and falls through to the rank-change
    // branch, which is what shipped before Part B anyway.
    const matches = winsGained + lossesGained + (abandonsGained ?? 0);
    if (matches !== 1) return { matches };

    if (winsGained === 1) return { matches, win: true };
    if (lossesGained === 1) return { matches, win: false };
    return { matches, win: null };
}

/** Plugin config, narrowed to the cadence knobs, with the defaults applied. */
export function cadenceFromConfig(config?: {
    activePollMinutes?: number;
    idlePollMinutes?: number;
    activeWindowMinutes?: number;
}): R6PollCadence {
    const positive = (value: unknown, fallback: number): number =>
        typeof value === 'number' && Number.isFinite(value) && value > 0
            ? value
            : fallback;
    return {
        activePollMinutes: positive(
            config?.activePollMinutes,
            DEFAULT_R6_POLL_CADENCE.activePollMinutes
        ),
        idlePollMinutes: positive(
            config?.idlePollMinutes,
            DEFAULT_R6_POLL_CADENCE.idlePollMinutes
        ),
        activeWindowMinutes: positive(
            config?.activeWindowMinutes,
            DEFAULT_R6_POLL_CADENCE.activeWindowMinutes
        ),
    };
}

/**
 * One heartbeat.
 *
 * The cron that calls this runs far more often than any player is polled — it
 * decides who is *due*, and a tick with nobody due issues no requests and costs
 * nothing. That indirection is what lets the poll cadence be per-player, which
 * is what the 3,000-calls-a-month plan requires: see `api/utils/r6Budget.ts` for
 * why no fixed cron interval both fits the plan and resolves single matches.
 */
export async function runR6Tick(
    adapter: MessageAdapter | null | undefined,
    eventAdapter?: EventAdapter | null,
    options: { cadence?: R6PollCadence; now?: Date } = {}
): Promise<void> {
    if (process.env.STOP_BOT === 'true') return;

    const cadence = options.cadence ?? DEFAULT_R6_POLL_CADENCE;
    const now = options.now ?? new Date();

    let players;
    try {
        players = await getAllTrackedR6Players();
    } catch (err) {
        console.error('[R6] Failed to fetch tracked players:', err);
        return;
    }

    if (players.length === 0) return;

    // The budget is read once per tick, not once per player: it is a monthly
    // figure and a tick lasts seconds, so a per-player read would be the same
    // answer several times over at the cost of a query each.
    const budget = await currentR6BudgetPlan(now);
    if (budget.exhausted) {
        console.warn(
            `[R6] Monthly r6data budget spent (${budget.used}/${budget.pollBudget}); ` +
                'skipping this tick. Polling resumes on the 1st.'
        );
        return;
    }

    const due = selectPlayersToPoll(
        players,
        now,
        budget.pressure,
        budget.pollBudget - budget.used,
        cadence
    );
    if (due.length === 0) return;

    console.log(
        `[R6] Tick - polling ${due.length} of ${players.length} tracked player(s); ` +
            `budget ${budget.used}/${budget.pollBudget}, pressure ${budget.pressure.toFixed(2)}`
    );

    for (const player of due) {
        let moved = false;
        try {
            moved = await processPlayer(player, adapter, eventAdapter);
        } catch (err) {
            console.error(`[R6] Error processing ${player.gameName}:`, err);
        }

        // Outside the try, and reached however the poll went. Three cases have to
        // land here or the budget leaks:
        //
        //   - nothing changed, which is most polls. Without this the row keeps a
        //     null `last_polled_at`, reads as permanently due, and the quietest
        //     player in the table absorbs the whole month.
        //   - the provider threw. The request was already issued and already
        //     charged, so treating a failure as "not polled" would retry a
        //     player whose name no longer resolves on every heartbeat — 8,600
        //     requests a month against a 3,000 plan.
        //   - the write itself fails, which is the one case that cannot be fixed
        //     here. It is logged, and the next tick re-polls: one wasted call,
        //     not a loop.
        await markR6PlayerPolled(
            player.ubisoftId,
            nextActiveUntil(player, moved, now, cadence)
        ).catch((err) =>
            console.error(
                `[R6] Failed to record the poll for ${player.gameName}:`,
                err
            )
        );
    }
}

/** Poll one player. Returns whether anything moved. */
async function processPlayer(
    tracked: Awaited<ReturnType<typeof getAllTrackedR6Players>>[number],
    adapter: MessageAdapter | null | undefined,
    eventAdapter: EventAdapter | null | undefined
): Promise<boolean> {
    // One request rather than two: the Ubisoft id and display name are columns on
    // the row already, so re-resolving the account each poll would double the
    // cost of the whole feature against a 3,000-call month.
    const profile = await r6Service.getTrackedProfile({
        ubisoftId: tracked.ubisoftId,
        gameName: tracked.gameName,
        platform: tracked.platform,
    });
    const player = await getR6PlayerById(tracked.ubisoftId);
    if (!player) return false;

    return postSessionIfChanged(
        tracked.ubisoftId,
        player,
        profile,
        adapter,
        eventAdapter
    );
}

/**
 * Post whatever this poll turned out to be, and return whether anything moved.
 *
 * The return value is the scheduler's input: movement is the only evidence we
 * have that somebody is mid-session, and it is what extends the active window.
 */
async function postSessionIfChanged(
    ubisoftId: string,
    player: NonNullable<Awaited<ReturnType<typeof getR6PlayerById>>>,
    profile: Awaited<ReturnType<typeof r6Service.getTrackedProfile>>,
    adapter: MessageAdapter | null | undefined,
    eventAdapter?: EventAdapter | null
): Promise<boolean> {
    const { tier: newTier, division: newDiv, rp: newRp } = profile.rank;

    // Nothing moved since the last poll.
    if (
        player.tier === newTier &&
        player.division === newDiv &&
        player.rp === newRp
    ) {
        return false;
    }

    const rankChanged = player.tier !== newTier || player.division !== newDiv;
    const rpChange = newRp - player.rp;
    const gained = diffSnapshot(player, profile.stats);
    const single = resolveSingleMatch(gained);

    const rankMovement = determineR6RankMovement(
        player.tier,
        player.division,
        player.rp,
        newTier,
        newDiv,
        newRp
    );
    const newRankMsg = formatR6Rank(newTier, newDiv, newRp);
    const rpToNextRank = getR6RpToNextRank(
        await r6Service.getRankLadder(),
        profile.rankOrdinal,
        newRp
    );

    console.log(
        `[R6] ${single.matches === 1 ? r6MatchResultLabel(single.win ?? null) : 'Session'} ` +
            `for ${profile.gameName}: ${rpChange > 0 ? '+' : ''}${rpChange} RP → ${newRankMsg}`
    );

    // Persist before notifying: a send failure must not make the next tick
    // replay the same session.
    await updateR6PlayerRankAndSnapshot(
        ubisoftId,
        newTier,
        newDiv,
        newRp,
        profile.stats
    );
    // Logged rather than swallowed: history is a nice-to-have and must not
    // abort the tick, but a silent `.catch(() => {})` is how the write to
    // `rank_tracking` went unnoticed for as long as it did.
    await createR6RankHistory(
        `R6_SYNC_${ubisoftId}_${Date.now()}`,
        ubisoftId,
        newTier,
        newDiv,
        newRp
    ).catch((err) =>
        console.error(
            `[R6] Failed to record rank history for ${ubisoftId}:`,
            err
        )
    );

    const guilds = await getGuildsTrackingR6Player(ubisoftId);
    for (const guild of guilds) {
        const channelId =
            guild.channel_id ?? process.env.DISCORD_CHANNEL_ID ?? null;
        if (!channelId) continue;

        // A rank change is the loudest thing that can happen and stays the
        // headline even when the window resolved to one match: crossing a
        // division already names the result implicitly, and posting both would
        // announce one game twice.
        if (rankChanged && rankMovement !== 'no_change') {
            await notifyR6RankChange(adapter, {
                playerName: profile.gameName,
                direction: rankMovement,
                newRankMsg,
                rankIconUrl: profile.rankIconUrl,
                rpChange,
                rpToNextRank,
                discordChannelId: channelId,
            });
            continue;
        }

        if (!guild.live_posting) continue;

        // Part B: exactly one match in the window, so it can be reported as a
        // match instead of as a session. The session embed stays for every wider
        // window — it is not a fallback for a failed feature, it is the correct
        // output when the gap genuinely cannot be resolved into single games.
        if (single.matches === 1) {
            await notifyR6Match(adapter, {
                playerName: profile.gameName,
                win: single.win ?? null,
                rpChange,
                newRankMsg,
                rankIconUrl: profile.rankIconUrl,
                kills: gained.killsGained,
                deaths: gained.deathsGained,
                discordChannelId: channelId,
            });
            continue;
        }

        // RP moved without crossing a division. Apex stays silent here; Siege
        // posts a session line instead, because RP-only swings are most of
        // what a Siege evening produces and a silent tick would mean the
        // plugin says nothing for days.
        await notifyR6Session(adapter, {
            playerName: profile.gameName,
            rpChange,
            newRankMsg,
            rankIconUrl: profile.rankIconUrl,
            killsGained: gained.killsGained,
            winsGained: gained.winsGained,
            lossesGained: gained.lossesGained,
            abandonsGained: gained.abandonsGained,
            discordChannelId: channelId,
        });
    }

    await emitR6Events({
        ubisoftId,
        profile,
        rankChanged: rankChanged && rankMovement !== 'no_change',
        rankMovement,
        newRankMsg,
        rpChange,
        rpToNextRank,
        gained,
        single,
        eventAdapter,
    });

    return true;
}

/**
 * The typed event path (DN-1), beside the Discord embeds above.
 *
 * Emitted once per *squad*, not once per guild: an event is a fact about the
 * group, not about a channel — the same call the League poller makes. Two
 * consequences follow, and both are deliberate:
 *
 *   - It is **not** gated on `live_posting` or on a configured channel. Those
 *     answer "should Discord announce this"; a squad's Meeps space should still
 *     get the card when the Discord side is muted.
 *   - A squad with no Discord guild attached gets nothing, because a Siege
 *     player is only reachable through `guild_r6_players`. Meeps-only squads
 *     wait on a roster table of their own.
 *
 * Wrapped in its own try/catch, and behind an adapter that never throws, so a
 * consumer being unreachable cannot break Discord posting.
 *
 * The branching mirrors the Discord loop exactly — rank change, else single
 * match, else session — so a squad and its channel never disagree about what
 * this poll was. Keeping the two orders in step is the thing to check when
 * either changes.
 */
async function emitR6Events({
    ubisoftId,
    profile,
    rankChanged,
    rankMovement,
    newRankMsg,
    rpChange,
    rpToNextRank,
    gained,
    single,
    eventAdapter,
}: {
    ubisoftId: string;
    profile: Awaited<ReturnType<typeof r6Service.getTrackedProfile>>;
    rankChanged: boolean;
    rankMovement: ReturnType<typeof determineR6RankMovement>;
    newRankMsg: string;
    rpChange: number;
    rpToNextRank: { rpNeeded: number; nextRankName: string } | null;
    gained: R6SnapshotDiff;
    single: ReturnType<typeof resolveSingleMatch>;
    eventAdapter?: EventAdapter | null;
}): Promise<void> {
    if (!eventAdapter) return;

    try {
        const squads = await getSquadsTrackingR6Player(ubisoftId);
        if (squads.length === 0) return;

        // r6data reports counters, never a match clock. The poll time is the
        // only timestamp we have, and claiming anything more precise would be
        // inventing one — the match happened somewhere in the preceding window.
        const occurredAt = new Date().toISOString();
        const matchCount = profile.stats.wins + profile.stats.losses;

        const common = {
            schemaVersion: DIANA_EVENT_SCHEMA_VERSION,
            occurredAt,
            ubisoftId,
            gameName: profile.gameName,
            platform: profile.platform,
            rankAfter: newRankMsg,
            tier: profile.rank.tier,
            division: profile.rank.division,
            rp: profile.rank.rp,
            rpChange,
            rankIconUrl: profile.rankIconUrl,
            matchCount,
        } as const;

        for (const squadId of squads) {
            // Mirrors the Discord branch above: a tick is a rank change, a
            // single match, or a session — never two of them — so a squad never
            // sees two cards for one poll.
            if (rankChanged) {
                await eventAdapter.emit({
                    ...common,
                    eventId: buildR6EventId(
                        'r6.rank.changed',
                        squadId,
                        ubisoftId,
                        matchCount,
                        profile.rank.rp
                    ),
                    type: 'r6.rank.changed',
                    squadId,
                    direction:
                        rankMovement === 'promoted' ? 'promoted' : 'demoted',
                    rpToNextRank: rpToNextRank?.rpNeeded ?? null,
                    nextRankName: rpToNextRank?.nextRankName ?? null,
                });
                continue;
            }

            if (single.matches === 1) {
                const win = single.win ?? null;
                await eventAdapter.emit({
                    ...common,
                    eventId: buildR6EventId(
                        'r6.match.completed',
                        squadId,
                        ubisoftId,
                        matchCount,
                        profile.rank.rp
                    ),
                    type: 'r6.match.completed',
                    squadId,
                    win,
                    result: r6MatchResultLabel(win),
                    kills: gained.killsGained,
                    deaths: gained.deathsGained,
                });
                continue;
            }

            await eventAdapter.emit({
                ...common,
                eventId: buildR6EventId(
                    'r6.session.completed',
                    squadId,
                    ubisoftId,
                    matchCount,
                    profile.rank.rp
                ),
                type: 'r6.session.completed',
                squadId,
                killsGained: gained.killsGained,
                winsGained: gained.winsGained,
                lossesGained: gained.lossesGained,
                abandonsGained: gained.abandonsGained,
            });
        }
    } catch (err) {
        console.error(`[R6] Failed to emit events for ${ubisoftId}:`, err);
    }
}

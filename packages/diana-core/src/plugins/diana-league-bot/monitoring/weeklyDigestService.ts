import { db } from '../api/utils/db';
import type { EventAdapter, WeeklyDigestStats } from '../../../core/eventTypes';
import {
    buildPeriodicEventId,
    DIANA_EVENT_SCHEMA_VERSION,
    toIsoWeek,
} from '../../../core/eventTypes';
import {
    getAllGuildConfigs,
    getNotificationPref,
    getGuildCompetitiveScope,
    getSquadIdForGuild,
} from '../api/summoners/guildService';
import {
    buildCompetitiveSqlFilter,
    type CompetitiveScope,
} from '../utils/queueClassification';
import { notHiddenPredicate } from '../../../core/privacy/privacyService';
import { fetchRankHistory } from '../api/summoners/summonerService';
import { getTotalPoints } from '../api/utils/rankService';
import {
    getInterCandidatesSince,
    ONE_WEEK_IN_MS,
    type InterCandidate,
} from '../utils/interStats';
import type { MessageAdapter, MessagePayload } from '../../../core/pluginTypes';
import type { LeagueBotConfig } from '../types';

const numberFormatter = new Intl.NumberFormat('en-US');

interface ScoredGameRow {
    matchId: string;
    puuid: string;
    score: number | string;
    gameName: string;
    tagLine: string;
}

function displayName(gameName: string, tagLine: string): string {
    return tagLine ? `${gameName}#${tagLine}` : gameName;
}

async function fetchWeeklyScoredGames(
    squadId: string,
    sinceTimestamp: number,
    scope: CompetitiveScope
): Promise<ScoredGameRow[]> {
    // EXISTS rather than a JOIN: match_scores holds every participant, but
    // match_details only holds rows for *entry* players. Joining would silently
    // drop a summoner added to the squad after a match; EXISTS only ever
    // removes Arena/non-ranked matches, so it is purely additive.
    //
    // The privacy filter is repeated here rather than inherited from
    // `getInterCandidatesSince`, because this is a *second* read path: the
    // digest's headline figures come from the candidates, but its best and worst
    // game come from here. Filtering only the first would have left an
    // opted-out player named as the week's best game.
    const result = await db.query(
        `SELECT ms."matchId", ms."puuid", ms."score", s."gameName", s."tagLine"
         FROM match_scores ms
         JOIN squad_summoners ss ON ss.puuid = ms."puuid" AND ss.squad_id = $1
         JOIN summoners s ON s.puuid = ms."puuid"
         WHERE ms."createdAt" >= to_timestamp($2 / 1000.0)
           AND ${notHiddenPredicate('ms."puuid"')}
           AND EXISTS (
               SELECT 1 FROM match_details md
               WHERE md."matchId" = ms."matchId"
                 ${buildCompetitiveSqlFilter('md', scope)}
           )
         ORDER BY ms."score" DESC`,
        [squadId, sinceTimestamp]
    );
    return result.rows;
}

interface LpDelta {
    candidate: InterCandidate;
    delta: number;
}

async function computeWeeklyLpDeltas(
    candidates: InterCandidate[],
    sinceIso: string
): Promise<LpDelta[]> {
    const deltas: LpDelta[] = [];
    for (const candidate of candidates) {
        try {
            const history = await fetchRankHistory(
                candidate.puuid,
                sinceIso,
                undefined,
                'RANKED_SOLO_5x5'
            );
            // Rows come newest-first; keep only rows with a computable rank.
            const points = history
                .map((row: { tier: string; rank: string; lp: number }) =>
                    getTotalPoints(row.tier, row.rank, row.lp)
                )
                .filter((value: number | null): value is number =>
                    Number.isFinite(value as number)
                );
            if (points.length < 2) continue;
            deltas.push({
                candidate,
                delta: points[0] - points[points.length - 1],
            });
        } catch (error) {
            console.error(
                `[Digest] Failed to compute LP delta for ${candidate.displayName}:`,
                error
            );
        }
    }
    return deltas;
}

/**
 * Compute the week's figures for one guild, or null when the guild had no
 * tracked matches this week (no post is sent in that case).
 *
 * Split out from the embed builder so the Discord post and the `digest.weekly`
 * event are two renderings of one computation rather than two computations that
 * have to be kept in step. The embed reduces these to markdown; the event
 * carries them as they are.
 */
export async function computeWeeklyDigestStats(
    guildId: string
): Promise<WeeklyDigestStats | null> {
    const sinceTimestamp = Date.now() - ONE_WEEK_IN_MS;
    const scope = await getGuildCompetitiveScope(guildId);
    // The roster is the squad's; the competitive scope above is this Discord
    // attachment's. Two guilds on one squad share players and may still count
    // different queues.
    const squadId = await getSquadIdForGuild(guildId);
    if (!squadId) return null;
    const candidates = await getInterCandidatesSince(sinceTimestamp, {
        squadId,
        scope,
    });
    if (candidates.length === 0) return null;

    const stats: WeeklyDigestStats = {
        totalGames: candidates.reduce((sum, c) => sum + c.matchesPlayed, 0),
        playerCount: candidates.length,
    };

    const deltas = await computeWeeklyLpDeltas(
        candidates,
        new Date(sinceTimestamp).toISOString()
    );
    if (deltas.length > 0) {
        const climber = deltas.reduce((a, b) => (b.delta > a.delta ? b : a));
        const faller = deltas.reduce((a, b) => (b.delta < a.delta ? b : a));
        // A week where everyone lost LP has no climber, and vice versa. The
        // sign test is what makes the award mean something.
        if (climber.delta > 0) {
            stats.climber = {
                name: climber.candidate.displayName,
                value: climber.delta,
            };
        }
        if (faller.delta < 0) {
            stats.faller = {
                name: faller.candidate.displayName,
                value: faller.delta,
            };
        }
    }

    const grinder = [...candidates].sort(
        (a, b) => b.matchesPlayed - a.matchesPlayed
    )[0];
    stats.grinder = { name: grinder.displayName, value: grinder.matchesPlayed };

    const scored = candidates.filter((c) => c.scoredMatchesCount > 0);
    if (scored.length > 0) {
        const mvp = [...scored].sort((a, b) => b.avgAiScore - a.avgAiScore)[0];
        const inter = [...scored].sort(
            (a, b) => a.avgAiScore - b.avgAiScore
        )[0];
        // Rounded here rather than at each render, so the number Meeps shows is
        // the number Discord showed.
        stats.mvp = {
            name: mvp.displayName,
            value: Math.round(mvp.avgAiScore),
        };
        stats.inter = {
            name: inter.displayName,
            value: Math.round(inter.avgAiScore),
        };
    }

    try {
        const scoredGames = await fetchWeeklyScoredGames(
            squadId,
            sinceTimestamp,
            scope
        );
        if (scoredGames.length > 0) {
            const best = scoredGames[0];
            const worst = scoredGames[scoredGames.length - 1];
            stats.bestGame = {
                name: displayName(best.gameName, best.tagLine),
                value: Math.round(Number(best.score)),
            };
            // One scored game in the week is both the best and the worst; only
            // the distinct case earns a second award.
            if (worst.matchId !== best.matchId || worst.puuid !== best.puuid) {
                stats.worstGame = {
                    name: displayName(worst.gameName, worst.tagLine),
                    value: Math.round(Number(worst.score)),
                };
            }
        }
    } catch (error) {
        console.error(
            `[Digest] Failed to fetch scored games for guild ${guildId}:`,
            error
        );
    }

    return stats;
}

/**
 * Render the week's figures as the Discord embed. Field order and wording are
 * unchanged from when this lived inside the computation — `discordPayloadRegression`
 * pins the output.
 */
export function buildWeeklyDigestPayloadFromStats(
    stats: WeeklyDigestStats
): MessagePayload {
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

    if (stats.climber) {
        fields.push({
            name: '🧗 **Climber of the Week**',
            value: `${stats.climber.name} (**+${stats.climber.value} LP**)`,
            inline: true,
        });
    }
    if (stats.faller) {
        fields.push({
            name: '📉 **Faller of the Week**',
            value: `${stats.faller.name} (**${stats.faller.value} LP**)`,
            inline: true,
        });
    }
    if (stats.grinder) {
        fields.push({
            name: '🎮 **The Grinder**',
            value: `${stats.grinder.name} (**${stats.grinder.value} game${stats.grinder.value === 1 ? '' : 's'}**)`,
            inline: true,
        });
    }
    if (stats.mvp) {
        fields.push({
            name: '🏆 **MVP of the Week**',
            value: `${stats.mvp.name} (avg AI score **${stats.mvp.value}**)`,
            inline: true,
        });
    }
    if (stats.inter) {
        fields.push({
            name: '🤡 **Inter of the Week**',
            value: `${stats.inter.name} (avg AI score **${stats.inter.value}**)`,
            inline: true,
        });
    }
    if (stats.bestGame) {
        fields.push({
            name: '⭐ **Best Single Game**',
            value: `${stats.bestGame.name} (AI score **${stats.bestGame.value}**)`,
            inline: true,
        });
    }
    if (stats.worstGame) {
        fields.push({
            name: '💩 **Worst Single Game**',
            value: `${stats.worstGame.name} (AI score **${stats.worstGame.value}**)`,
            inline: true,
        });
    }

    return {
        title: '📰 **Weekly Diana Digest**',
        description: `Your server's week in League: **${numberFormatter.format(stats.totalGames)} game${stats.totalGames === 1 ? '' : 's'}** across **${stats.playerCount} player${stats.playerCount === 1 ? '' : 's'}**.`,
        colorHex: 0x5865f2,
        fields: fields.slice(0, 25),
        footer: 'Weekly Digest • Last 7 days',
        timestamp: new Date().toISOString(),
    };
}

/**
 * Build the weekly digest payload for one guild, or null when the guild had
 * no tracked matches this week.
 */
export async function buildWeeklyDigestPayload(
    guildId: string
): Promise<MessagePayload | null> {
    const stats = await computeWeeklyDigestStats(guildId);
    return stats ? buildWeeklyDigestPayloadFromStats(stats) : null;
}

export function createWeeklyDigestTick(
    _config: LeagueBotConfig,
    messageAdapter: MessageAdapter | null | undefined,
    eventAdapter?: EventAdapter | null
): () => Promise<void> {
    return async function runWeeklyDigestTick(): Promise<void> {
        if (process.env.STOP_BOT) {
            console.log(
                `[Info] [${new Date().toISOString()}] Stop bot enabled, skipping weekly digest...`
            );
            return;
        }
        if (!messageAdapter) {
            console.warn(
                '[Digest] No message adapter set; skipping weekly digest.'
            );
            return;
        }

        const guilds = await getAllGuildConfigs();
        for (const guild of guilds) {
            try {
                if (!getNotificationPref(guild, 'digest')) continue;
                if (!guild.channel_id) continue;

                // Computed once and rendered twice: the embed below and the
                // event further down carry the same figures, so Meeps' digest
                // card can never disagree with the Discord post.
                const stats = await computeWeeklyDigestStats(guild.guild_id);
                if (!stats) continue;
                const payload = buildWeeklyDigestPayloadFromStats(stats);

                await messageAdapter.sendMessage(
                    { channelId: guild.channel_id },
                    payload
                );
                console.log(
                    `[Info] [${new Date().toISOString()}] Sent weekly digest to guild ${guild.guild_id}.`
                );

                // Keyed on the squad and the ISO week the digest covers, so a
                // retry, a redeploy inside the same week, or a second guild
                // attached to the same squad cannot create a second row.
                const isoWeek = toIsoWeek(new Date());
                const squadId = await getSquadIdForGuild(guild.guild_id);
                if (squadId) {
                    await eventAdapter?.emit({
                        schemaVersion: DIANA_EVENT_SCHEMA_VERSION,
                        eventId: buildPeriodicEventId(
                            'digest.weekly',
                            squadId,
                            isoWeek
                        ),
                        type: 'digest.weekly',
                        occurredAt: new Date().toISOString(),
                        guildId: guild.guild_id,
                        squadId,
                        isoWeek,
                        stats,
                    });
                }
            } catch (error) {
                console.error(
                    `[Error] Failed to send weekly digest to guild ${guild.guild_id}:`,
                    error
                );
            }
        }
    };
}

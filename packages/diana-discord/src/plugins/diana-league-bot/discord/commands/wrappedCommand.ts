import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import type { SlashCommand } from '../../../../discord/commandTypes';
import {
    computeSquadWrapped,
    getGuildCompetitiveScope,
    getSquadIdForGuild,
    isWrappedPeriodKey,
    resolveWrappedPeriod,
    type SquadWrapped,
} from 'diana-core';

/**
 * `/wrapped` - the squad's period on one card (roadmap §7.2).
 *
 * The paid client draws the real thing: Meeps fetches the same figures from
 * `GET /api/squads/:id/wrapped` and joins them to its own chat corpus. This is
 * the free-tier rendering, and it exists deliberately rather than as a
 * consolation - Discord is the acquisition channel (§4.2), and the whole
 * acquisition story for Wrapped is "one person posts the card, four friends ask
 * what it is". A card nobody outside the client can post cannot start that.
 *
 * It calls `computeSquadWrapped` directly rather than its own HTTP route, the
 * way the digest cron calls `computeWeeklyDigestStats` directly. A request from
 * a process to itself is a failure mode, not an abstraction.
 */

const numberFormatter = new Intl.NumberFormat('en-US');

function formatCount(value: number): string {
    return numberFormatter.format(Math.round(value));
}

/** Whole hours and minutes. "5h 28m" reads better on a card than "19,680s". */
function formatDuration(totalSeconds: number): string {
    const seconds = Math.max(0, Math.round(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours === 0) return `${minutes}m`;
    return `${hours}h ${minutes}m`;
}

function formatPercent(ratio: number): string {
    return `${(ratio * 100).toFixed(1)}%`;
}

function plural(count: number, word: string): string {
    return `${formatCount(count)} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * The headline line.
 *
 * `wins + losses` can be less than `totalGames` - a match where the squad's own
 * players were on opposite sides counts as neither, by `computeSquadRecord` -
 * so the record is stated separately rather than implied by the total.
 */
function buildDescription(wrapped: SquadWrapped): string {
    const parts = [
        `**${plural(wrapped.totalGames, 'game')}** · **${wrapped.wins}W-${wrapped.losses}L**`,
    ];
    if (wrapped.wins + wrapped.losses > 0) {
        parts.push(
            formatPercent(wrapped.wins / (wrapped.wins + wrapped.losses))
        );
    }
    parts.push(`${plural(wrapped.playerCount, 'player')}`);

    if (wrapped.voice) {
        parts.push(
            `${formatDuration(wrapped.voice.totalVoiceSeconds)} in voice across ${plural(wrapped.voice.nights, 'night')}`
        );
    }

    return parts.join(' · ');
}

function buildPlayerBoard(wrapped: SquadWrapped): string {
    return wrapped.players
        .slice(0, 8)
        .map((player, index) => {
            const score =
                player.avgAiScore === null ? '' : ` · AI ${player.avgAiScore}`;
            const champion = player.topChampion
                ? ` · ${player.topChampion}`
                : '';
            return `${index + 1}. **${player.name}** - ${plural(player.games, 'game')} (${player.wins}W-${player.losses}L)${score}${champion}`;
        })
        .join('\n');
}

/**
 * The lines that only exist when the period earned them.
 *
 * Every one of these is optional in the same sense `WeeklyDigestStats`
 * established: absent means "not awarded", never "unknown". A squad with no
 * Meeps space has no voice figures at all, and drawing "0h in voice" would state
 * something about the group that is really a fact about their deployment.
 */
function buildHighlights(wrapped: SquadWrapped): string {
    const lines: string[] = [];

    if (wrapped.topDuo) {
        const duo = wrapped.topDuo;
        lines.push(
            `👯 **Duo of the period** - ${duo.names[0]} + ${duo.names[1]} (${plural(duo.gamesTogether, 'game')}, ${formatPercent(duo.winRate)})`
        );
    }
    if (wrapped.topChampion) {
        lines.push(
            `🧙 **Most-picked champion** - ${wrapped.topChampion.name} (${plural(wrapped.topChampion.value, 'game')})`
        );
    }
    if (wrapped.bestGame) {
        const champion = wrapped.bestGame.championName
            ? `'s ${wrapped.bestGame.championName}`
            : '';
        lines.push(
            `⭐ **Best game** - ${wrapped.bestGame.name}${champion} (AI score **${Math.round(wrapped.bestGame.aiScore)}**)`
        );
    }
    if (wrapped.worstGame) {
        // Names a game, not a person. See `WrappedWorstGame`.
        lines.push(
            `💩 **Worst game** - all of you, mean AI score **${Math.round(wrapped.worstGame.meanAiScore)}**`
        );
    }
    if (wrapped.biggestClimb) {
        lines.push(
            `🧗 **Biggest climb** - ${wrapped.biggestClimb.name} (**+${wrapped.biggestClimb.delta} LP**, ${wrapped.biggestClimb.from} → ${wrapped.biggestClimb.to})`
        );
    }
    if (wrapped.biggestFall) {
        lines.push(
            `📉 **Biggest fall** - ${wrapped.biggestFall.name} (**${wrapped.biggestFall.delta} LP**, ${wrapped.biggestFall.from} → ${wrapped.biggestFall.to})`
        );
    }

    return lines.join('\n');
}

function buildNightsField(wrapped: SquadWrapped): string {
    if (!wrapped.voice) return '';

    const lines: string[] = [
        `🌙 **Nights** - ${plural(wrapped.voice.nights, 'night')}, longest ${formatDuration(wrapped.voice.longestNightSeconds)}`,
    ];

    if (wrapped.worstNight) {
        const night = wrapped.worstNight;
        const date = new Date(night.startedAt).toISOString().slice(0, 10);
        lines.push(
            `☠️ **The one nobody talks about** - ${date}, ${night.wins}W-${night.losses}L over ${plural(night.matchCount, 'game')}`
        );
    }

    return lines.join('\n');
}

export function buildWrappedEmbed(wrapped: SquadWrapped): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setTitle('🎁 Squad Wrapped')
        .setDescription(buildDescription(wrapped))
        .setColor(0xf1c40f)
        .setFooter({ text: wrapped.period.label })
        .setTimestamp();

    const highlights = buildHighlights(wrapped);
    if (highlights) {
        embed.addFields({ name: 'Highlights', value: highlights });
    }

    const nights = buildNightsField(wrapped);
    if (nights) {
        embed.addFields({ name: 'Nights', value: nights });
    }

    const board = buildPlayerBoard(wrapped);
    if (board) {
        embed.addFields({ name: 'The roster', value: board });
    }

    return embed;
}

export const wrappedCommand: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('wrapped')
        .setDescription("Your squad's games, voice hours and highlights.")
        .addStringOption((option) =>
            option
                .setName('period')
                .setDescription('How far back to look. Defaults to 90 days.')
                .setRequired(false)
                .addChoices(
                    // No "split" option that claims a real split: Riot publishes
                    // no split dates, so the label says what the window is.
                    { name: 'Last 90 days', value: 'split' },
                    { name: 'This month', value: 'month' },
                    { name: 'This year', value: 'year' },
                    { name: 'All time', value: 'all' }
                )
        ),

    execute: async (interaction) => {
        await interaction.deferReply();

        try {
            const guildId = interaction.guildId ?? undefined;
            if (!guildId) {
                await interaction.editReply(
                    'A Wrapped is about a squad, so this only works inside a server.'
                );
                return;
            }

            const squadId = await getSquadIdForGuild(guildId);
            if (!squadId) {
                await interaction.editReply(
                    'This server is not attached to a squad yet. Add a summoner with `/add` and try again.'
                );
                return;
            }

            const requested = interaction.options.getString('period');
            const period = resolveWrappedPeriod(
                isWrappedPeriodKey(requested) ? requested : undefined
            );
            // The roster is the squad's; the queue scope is this Discord
            // attachment's. Two guilds on one squad share players and may still
            // count different queues.
            const scope = await getGuildCompetitiveScope(guildId);

            const wrapped = await computeSquadWrapped(squadId, {
                period,
                scope,
            });

            if (!wrapped) {
                await interaction.editReply(
                    `Nothing to wrap up for **${period.label}** - no games and no time in voice.`
                );
                return;
            }

            await interaction.editReply({
                embeds: [buildWrappedEmbed(wrapped)],
            });
        } catch (error) {
            console.error('Failed to build Squad Wrapped:', error);
            await interaction.editReply(
                'Something went wrong while wrapping up the squad.'
            );
        }
    },
};

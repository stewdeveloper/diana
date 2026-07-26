/**
 * Flavor lines for match-end embeds. A rule table maps match situations to
 * short roast/praise lines in the same tone as /iotw. The highest-priority
 * matching rule wins and one of its lines is picked at random.
 */

export interface FlavorContext {
    result: 'win' | 'lose' | 'remake';
    kills: number;
    deaths: number;
    assists: number;
    /** Kill participation as a whole percentage (0-100) */
    killParticipationPct?: number;
    damagePerMinute?: number;
    soloKills?: number;
    visionScore?: number;
    enemyMissingPings?: number;
    largestMultikill?: number;
    /**
     * 1-based AI-score placement across the whole lobby. Always undefined for
     * Arena, which is never scored - so the placement-based rules can't fire.
     */
    placement?: number;
    totalPlayers?: number;
    gameLengthSeconds?: number;
    /** Arena (gameMode CHERRY): suppresses rules that assume Summoner's Rift. */
    isArena?: boolean;
}

type FlavorLine = (ctx: FlavorContext) => string;

interface FlavorRule {
    id: string;
    /** Higher priority wins when multiple rules match */
    priority: number;
    predicate: (ctx: FlavorContext) => boolean;
    lines: FlavorLine[];
}

function kdaRatio(ctx: FlavorContext): number {
    const contrib = ctx.kills + ctx.assists;
    return ctx.deaths === 0 ? contrib : contrib / ctx.deaths;
}

export const FLAVOR_RULES: FlavorRule[] = [
    {
        id: 'multikill-monster',
        priority: 95,
        predicate: (ctx) => (ctx.largestMultikill ?? 0) >= 4,
        lines: [
            (ctx) =>
                ctx.largestMultikill === 5
                    ? '🔥 A PENTAKILL?! Clip it or it did not happen.'
                    : '🔥 A quadra kill! Someone queued up angry today.',
            () => '🎬 Highlight-reel material. The enemy team is in shambles.',
        ],
    },
    {
        id: 'deathless',
        priority: 90,
        predicate: (ctx) =>
            ctx.result === 'win' &&
            ctx.deaths === 0 &&
            ctx.kills + ctx.assists >= 5,
        lines: [
            () => '🧼 Deathless. Suspiciously clean. Smurf check incoming.',
            () => '💀 Zero deaths - the gray screen never stood a chance.',
        ],
    },
    {
        id: 'lobby-mvp',
        priority: 80,
        predicate: (ctx) => ctx.placement === 1,
        lines: [
            () => '👑 Best AI score in the lobby. Carried nine passengers.',
            () => '🥇 Number one in the lobby - the team owes you dinner.',
        ],
    },
    {
        id: 'heavy-inting',
        priority: 85,
        predicate: (ctx) => ctx.deaths >= 10 && kdaRatio(ctx) < 1,
        lines: [
            (ctx) =>
                `⚰️ ${ctx.deaths} deaths. The enemy team sends their regards.`,
            () => '🏃 That was not a KDA, that was a taxi schedule.',
        ],
    },
    {
        id: 'wooden-spoon',
        priority: 75,
        predicate: (ctx) =>
            ctx.placement != null &&
            ctx.totalPlayers != null &&
            ctx.totalPlayers >= 4 &&
            ctx.placement === ctx.totalPlayers,
        lines: [
            () => '🥄 Wooden spoon: worst AI score in the lobby. IOTW watch.',
            () => '📉 Dead last in the lobby. The algorithm saw everything.',
        ],
    },
    {
        id: 'damage-machine',
        priority: 70,
        predicate: (ctx) => (ctx.damagePerMinute ?? 0) >= 800,
        lines: [
            (ctx) =>
                `💥 ${Math.round(ctx.damagePerMinute ?? 0)} damage per minute - someone had to do everything.`,
            () => '🔨 The damage chart looks like a skyscraper next to huts.',
        ],
    },
    {
        id: 'solo-kill-menace',
        priority: 65,
        predicate: (ctx) => (ctx.soloKills ?? 0) >= 3,
        lines: [
            (ctx) =>
                `🗡️ ${ctx.soloKills} solo kills. The lane opponent is uninstalling.`,
            () => '⚔️ A 1v1 menace. No jungler required.',
        ],
    },
    {
        id: 'kp-tourist',
        priority: 60,
        predicate: (ctx) =>
            ctx.killParticipationPct != null &&
            ctx.killParticipationPct < 30 &&
            ctx.result !== 'remake',
        lines: [
            (ctx) =>
                `🏝️ ${ctx.killParticipationPct}% kill participation - enjoying a solo vacation out there?`,
            () => '📷 Mostly there to spectate, apparently.',
        ],
    },
    {
        id: 'vision-blind',
        priority: 55,
        // Arena has no wards, so every long Arena game would trip this.
        predicate: (ctx) =>
            !ctx.isArena &&
            (ctx.visionScore ?? Infinity) <= 5 &&
            (ctx.gameLengthSeconds ?? 0) >= 1200,
        lines: [
            () => '🦇 Vision score of a bat. Wards are purchasable, you know.',
            () => '👁️ The map was dark and full of terrors.',
        ],
    },
    {
        id: 'ping-committee',
        priority: 50,
        predicate: (ctx) => (ctx.enemyMissingPings ?? 0) >= 30,
        lines: [
            (ctx) =>
                `📢 ${ctx.enemyMissingPings} missing pings. The team definitely heard you.`,
            () =>
                '🚨 Chief communications officer of the missing-ping department.',
        ],
    },
];

/**
 * Pick a flavor line for a match. Returns null when no rule matches.
 * The rng parameter is injectable for tests.
 */
export function pickFlavorLine(
    ctx: FlavorContext,
    rng: () => number = Math.random
): string | null {
    const matching = FLAVOR_RULES.filter((rule) => rule.predicate(ctx));
    if (matching.length === 0) return null;

    const best = matching.reduce((a, b) => (b.priority > a.priority ? b : a));
    const index = Math.min(
        best.lines.length - 1,
        Math.floor(rng() * best.lines.length)
    );
    return best.lines[index](ctx);
}

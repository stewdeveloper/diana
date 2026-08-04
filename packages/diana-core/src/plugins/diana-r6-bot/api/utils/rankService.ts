import {
    R6_TIER_ORDER,
    R6_DIVISIONS_PER_TIER,
    type R6RankRung,
} from '../../types.js';

/**
 * The static ladder, used only when the provider's ranks endpoint is
 * unavailable or returns a shape we do not recognise.
 *
 * Generated rather than typed out: eight tiers of five divisions is forty
 * rungs of identical arithmetic, and a hand-written table is one typo away
 * from silently misreporting a promotion. RP thresholds are deliberately
 * absent here — the live ladder carries them, and inventing them offline
 * would make `getR6RpToNextRank` confidently wrong.
 */
export function fallbackRankLadder(): R6RankRung[] {
    const rungs: R6RankRung[] = [];
    let ordinal = 1;
    for (const tier of R6_TIER_ORDER) {
        // Division V is the bottom of a tier and I the top, so the numeral
        // descends as the ordinal climbs.
        for (let division = R6_DIVISIONS_PER_TIER; division >= 1; division--) {
            rungs.push({
                ordinal,
                tier,
                division,
                label: `${tier} ${romanNumeral(division)}`,
                minRp: null,
                iconUrl: null,
            });
            ordinal += 1;
        }
    }
    return rungs;
}

function romanNumeral(division: number): string {
    return ['', 'I', 'II', 'III', 'IV', 'V'][division] ?? String(division);
}

/** The rung a provider `rank` ordinal refers to, or null for unranked. */
export function rungForOrdinal(
    ladder: R6RankRung[],
    ordinal: number
): R6RankRung | null {
    if (!Number.isFinite(ordinal) || ordinal <= 0) return null;
    return ladder.find((r) => r.ordinal === ordinal) ?? null;
}

const getTierIndex = (tier: string): number => {
    const normalized = tier.trim().toLowerCase();
    return R6_TIER_ORDER.findIndex((t) => t.toLowerCase() === normalized);
};

/**
 * Returns 'promoted', 'demoted', or 'no_change' from a tier/division pair.
 *
 * As in Apex, a *lower* division number is a higher rank within a tier.
 */
export function determineR6RankMovement(
    previousTier: string,
    previousDiv: number,
    _previousRp: number,
    currentTier: string,
    currentDiv: number,
    _currentRp: number
): 'promoted' | 'demoted' | 'no_change' {
    const prevTierIdx = getTierIndex(previousTier);
    const currTierIdx = getTierIndex(currentTier);

    // An unknown tier on either side (Unranked, or a tier added next season)
    // must not be reported as a promotion from nothing.
    if (prevTierIdx === -1 || currTierIdx === -1) return 'no_change';

    if (currTierIdx > prevTierIdx) return 'promoted';
    if (currTierIdx < prevTierIdx) return 'demoted';

    if (currentDiv === 0 || previousDiv === 0) return 'no_change';
    if (currentDiv < previousDiv) return 'promoted';
    if (currentDiv > previousDiv) return 'demoted';

    return 'no_change';
}

export function getR6RpChange(previousRp: number, currentRp: number): number {
    return currentRp - previousRp;
}

/**
 * RP needed to reach the next rung, and its display name.
 *
 * Null at the top of the ladder, and null when the ladder carries no RP
 * thresholds — the static fallback does not, and a made-up number here would
 * read as fact in a Discord embed.
 */
export function getR6RpToNextRank(
    ladder: R6RankRung[],
    ordinal: number,
    rp: number
): { rpNeeded: number; nextRankName: string } | null {
    const idx = ladder.findIndex((r) => r.ordinal === ordinal);
    if (idx === -1) return null;

    const next = ladder[idx + 1];
    if (!next || next.minRp === null) return null;

    return {
        rpNeeded: Math.max(0, next.minRp - rp),
        nextRankName: next.label,
    };
}

/** Format rank for display: "Platinum II (3200 RP)". */
export function formatR6Rank(tier: string, div: number, rp: number): string {
    if (div === 0) return `${tier} (${rp} RP)`;
    return `${tier} ${romanNumeral(div)} (${rp} RP)`;
}

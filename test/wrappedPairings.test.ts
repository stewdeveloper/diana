import {
    computeChampionCounts,
    computePlayerTotals,
    computeSquadRecord,
    computePairings,
    DEFAULT_MIN_DUO_GAMES,
    pickTopDuo,
    type WrappedMatch,
    type WrappedMatchMember,
} from '../packages/diana-core/src/core/wrapped/pairings';

function member(
    puuid: string,
    overrides: Partial<WrappedMatchMember> = {}
): WrappedMatchMember {
    return {
        puuid,
        win: true,
        teamId: 100,
        championName: 'Lux',
        kills: 5,
        deaths: 2,
        assists: 3,
        ...overrides,
    };
}

function match(
    matchId: string,
    members: WrappedMatchMember[],
    playedAt: number | null = 1_700_000_000_000
): WrappedMatch {
    return { matchId, playedAt, members };
}

describe('computeSquadRecord', () => {
    it('counts distinct matches, not per-player appearances', () => {
        // The digest sums matchesPlayed across players, so a five-stack game
        // counts five times. That is defensible beside per-player rows and
        // indefensible on a card that says "we played N games together".
        const record = computeSquadRecord([
            match('M1', [member('a'), member('b'), member('c')]),
            match('M2', [member('a'), member('b')]),
        ]);
        expect(record.totalGames).toBe(2);
        expect(record.wins).toBe(2);
    });

    it('counts a loss when everybody agrees they lost', () => {
        const record = computeSquadRecord([
            match('M1', [
                member('a', { win: false }),
                member('b', { win: false }),
            ]),
        ]);
        expect(record).toEqual({ totalGames: 1, wins: 0, losses: 1 });
    });

    it('calls a split lobby neither a win nor a loss', () => {
        // Two tracked players on opposite sides happens in customs and Arena.
        // Calling it a squad win is a straight-up lie.
        const record = computeSquadRecord([
            match('M1', [
                member('a', { win: true, teamId: 100 }),
                member('b', { win: false, teamId: 200 }),
            ]),
        ]);
        expect(record).toEqual({ totalGames: 1, wins: 0, losses: 0 });
    });

    it('ignores a match whose rows carried no verdict', () => {
        const record = computeSquadRecord([
            match('M1', [member('a', { win: null })]),
        ]);
        expect(record).toEqual({ totalGames: 1, wins: 0, losses: 0 });
    });
});

describe('computePairings', () => {
    it('counts a pair once per shared match', () => {
        const pairs = computePairings([
            match('M1', [member('a'), member('b')]),
            match('M2', [member('a'), member('b')]),
        ]);
        expect(pairs).toHaveLength(1);
        expect(pairs[0].gamesTogether).toBe(2);
        expect(pairs[0].winsTogether).toBe(2);
    });

    it('produces every pair from a three-stack', () => {
        const pairs = computePairings([
            match('M1', [member('a'), member('b'), member('c')]),
        ]);
        expect(pairs).toHaveLength(3);
    });

    it('keys a pair the same way whichever order the members arrive in', () => {
        const one = computePairings([match('M1', [member('b'), member('a')])]);
        const two = computePairings([match('M1', [member('a'), member('b')])]);
        expect(one[0].puuids).toEqual(two[0].puuids);
    });

    it('does not pair players on opposite teams', () => {
        // Two squad members against each other are not a duo in any sense a
        // reader would recognise; /compare covers the head-to-head question.
        const pairs = computePairings([
            match('M1', [
                member('a', { teamId: 100 }),
                member('b', { teamId: 200 }),
            ]),
        ]);
        expect(pairs).toEqual([]);
    });

    it('excludes a player who opted out of rankings', () => {
        const pairs = computePairings(
            [match('M1', [member('a'), member('b'), member('c')])],
            { hiddenPuuids: new Set(['b']) }
        );
        expect(pairs).toHaveLength(1);
        expect(pairs[0].puuids).toEqual(['a', 'c']);
    });

    it('ranks by games first and win rate second', () => {
        const pairs = computePairings([
            match('M1', [member('a'), member('b')]),
            match('M2', [member('a'), member('b'), member('c')]),
            match('M3', [member('a'), member('c')]),
        ]);
        expect(pairs[0].puuids).toEqual(['a', 'b']);
    });

    it('does not collide two pairs that a delimiter would merge', () => {
        // The original key was the two puuids joined by a space, which CodeQL
        // flagged: ("a b", "c") and ("a", "b c") both join to "a b c", so two
        // different duos would share one tally and the card would name a pair
        // that never played. Riot puuids do not contain spaces, but the tally
        // must not depend on that.
        const pairs = computePairings([
            match('M1', [member('a b'), member('c')]),
            match('M2', [member('a'), member('b c')]),
        ]);

        expect(pairs).toHaveLength(2);
        for (const pair of pairs) {
            expect(pair.gamesTogether).toBe(1);
        }
    });

    it('recovers each pair intact, whatever is in the puuid', () => {
        // The pair is carried as data rather than parsed back out of a key, so
        // a puuid containing the old delimiter survives the round trip.
        const pairs = computePairings([
            match('M1', [member('x y z'), member('q')]),
        ]);
        expect(pairs[0].puuids).toEqual(['q', 'x y z']);
    });

    it('is deterministic for identical figures', () => {
        // Two runs over the same night must produce the same card; a
        // redelivered card must not contradict the first one.
        const matches = [
            match('M1', [member('a'), member('b')]),
            match('M1b', [member('c'), member('d')]),
        ];
        expect(computePairings(matches)).toEqual(computePairings(matches));
    });
});

describe('pickTopDuo', () => {
    it('ignores a one-game pair when a real sample exists', () => {
        const matches: WrappedMatch[] = [];
        for (let i = 0; i < DEFAULT_MIN_DUO_GAMES; i += 1) {
            matches.push(
                match(`M${i}`, [
                    member('a', { win: false }),
                    member('b', { win: false }),
                ])
            );
        }
        // A pair that queued once and won it would otherwise top the board at
        // 100%, which is the first thing anybody notices is wrong.
        matches.push(match('lucky', [member('c'), member('d')]));

        expect(pickTopDuo(matches)?.puuids).toEqual(['a', 'b']);
    });

    it('still names a duo for a squad with a small sample', () => {
        // A hole where the duo line should be is worse than a thin one.
        const duo = pickTopDuo([match('M1', [member('a'), member('b')])]);
        expect(duo?.puuids).toEqual(['a', 'b']);
    });

    it('returns null when nobody ever played together', () => {
        expect(pickTopDuo([match('M1', [member('a')])])).toBeNull();
    });
});

describe('computeChampionCounts', () => {
    it('counts each pick, so three of them on Lux is three Lux games', () => {
        const counts = computeChampionCounts([
            match('M1', [
                member('a', { championName: 'Lux' }),
                member('b', { championName: 'Lux' }),
                member('c', { championName: 'Yasuo' }),
            ]),
        ]);
        expect(counts[0]).toEqual({ championName: 'Lux', games: 2 });
    });

    it('skips a hidden player’s picks', () => {
        const counts = computeChampionCounts(
            [
                match('M1', [
                    member('a', { championName: 'Lux' }),
                    member('b', { championName: 'Yasuo' }),
                ]),
            ],
            new Set(['b'])
        );
        expect(counts.map((c) => c.championName)).toEqual(['Lux']);
    });

    it('ignores a row with no champion name', () => {
        const counts = computeChampionCounts([
            match('M1', [member('a', { championName: null })]),
        ]);
        expect(counts).toEqual([]);
    });
});

describe('computePlayerTotals', () => {
    it('accumulates games, record and KDA per player', () => {
        const totals = computePlayerTotals([
            match('M1', [
                member('a', { kills: 10, deaths: 2, assists: 4, win: true }),
            ]),
            match('M2', [
                member('a', { kills: 0, deaths: 2, assists: 0, win: false }),
            ]),
        ]);
        expect(totals[0]).toMatchObject({
            puuid: 'a',
            games: 2,
            wins: 1,
            losses: 1,
            winRate: 0.5,
            kills: 10,
            deaths: 4,
            assists: 4,
        });
        expect(totals[0].kdaRatio).toBeCloseTo(3.5);
    });

    it('treats a deathless player as their kill contribution, not infinity', () => {
        const totals = computePlayerTotals([
            match('M1', [member('a', { kills: 7, deaths: 0, assists: 3 })]),
        ]);
        expect(totals[0].kdaRatio).toBe(10);
    });

    it('names each player’s own most-picked champion', () => {
        const totals = computePlayerTotals([
            match('M1', [member('a', { championName: 'Lux' })]),
            match('M2', [member('a', { championName: 'Lux' })]),
            match('M3', [member('a', { championName: 'Ahri' })]),
        ]);
        expect(totals[0].topChampion).toBe('Lux');
    });

    it('leaves out a player who opted out of rankings', () => {
        const totals = computePlayerTotals(
            [match('M1', [member('a'), member('b')])],
            { hiddenPuuids: new Set(['a']) }
        );
        expect(totals.map((t) => t.puuid)).toEqual(['b']);
    });

    it('ranks by games played', () => {
        const totals = computePlayerTotals([
            match('M1', [member('a'), member('b')]),
            match('M2', [member('b')]),
        ]);
        expect(totals.map((t) => t.puuid)).toEqual(['b', 'a']);
    });
});

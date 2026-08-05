jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({
        db: {
            query: jest.fn(),
        },
    })
);

import { db } from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db';
import {
    CHALLENGE_ICON_IDS,
    CHALLENGE_TTL_MS,
    chooseChallengeIcon,
    createLinkChallenge,
    createTrustedLink,
    deleteLinkChallenge,
    getAccount,
    getAccountsForIdentity,
    getLinkChallenge,
    getOrCreateIdentityForAccount,
    getPuuidsForDiscordUser,
    getPuuidsForMeepsUser,
    linkAccount,
    resolveIdentity,
    unlinkAccount,
    verifyLinkChallenge,
} from '../packages/diana-core/src/core/identity/identityService';

const queryMock = db.query as unknown as jest.Mock;

const account = (over: Record<string, unknown> = {}) => ({
    kind: 'riot_puuid',
    external_id: 'puuid-1',
    identity_id: 'id-1',
    verified_at: null,
    method: null,
    linked_at: '2026-07-31T00:00:00.000Z',
    ...over,
});

const NOW = Date.parse('2026-07-31T12:00:00.000Z');

const DISCORD_SUBJECT = { kind: 'discord_user' as const, id: 'discord-1' };
const MEEPS_SUBJECT = { kind: 'meeps_user' as const, id: 'meeps-1' };

const challenge = (over: Record<string, unknown> = {}) => ({
    subject_kind: 'discord_user',
    subject_id: 'discord-1',
    puuid: 'puuid-1',
    game_name: 'Louis',
    tag_line: 'EUW',
    region: 'EU_WEST',
    required_icon: 590,
    expires_at: new Date(NOW + 60_000).toISOString(),
    created_at: new Date(NOW).toISOString(),
    ...over,
});

beforeEach(() => {
    queryMock.mockReset();
});

describe('CHALLENGE_TTL_MS', () => {
    it('is sized for Riot\u2019s cache, not for how fast a person clicks', () => {
        // The bug it fixes: ten minutes was chosen for how long somebody takes
        // to alt-tab and change an icon. What has to fit inside the window is
        // how long summoner-v4 takes to *report* the change, which is reliably
        // longer than that \u2014 so the handshake expired before it could
        // possibly have succeeded.
        expect(CHALLENGE_TTL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    });

    it('still ends, so an abandoned handshake is not open forever', () => {
        // The cost of a long window is coincidence: the account's real owner
        // independently setting the exact icon being asked for.
        expect(CHALLENGE_TTL_MS).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    });
});

describe('CHALLENGE_ICON_IDS', () => {
    it('only names icons every account can actually select', () => {
        // The bug this pins: the set was 588-597, described in the source as
        // "free starter icons every account owns". It was never checked and it
        // is false — those are reward icons, so the handshake asked most
        // players to set something they did not have, and failed for a reason
        // they could neither see nor fix.
        //
        // 0-28 is the original launch set: on every account since the game
        // shipped, and the range a new account's default icon comes from. There
        // is no public endpoint for "which icons does this account own", so a
        // set that needs no lookup is the only safe one.
        for (const id of CHALLENGE_ICON_IDS) {
            expect(id).toBeGreaterThanOrEqual(0);
            expect(id).toBeLessThanOrEqual(28);
        }
    });

    it('offers enough icons that a re-roll is worth suggesting', () => {
        // `/link start` tells a player who cannot select the named icon to run
        // it again. That advice is only honest if there is a real choice.
        expect(CHALLENGE_ICON_IDS.length).toBeGreaterThan(5);
        expect(new Set(CHALLENGE_ICON_IDS).size).toBe(
            CHALLENGE_ICON_IDS.length
        );
    });
});

describe('chooseChallengeIcon', () => {
    it('never names the icon the player already has', () => {
        // The whole point of the handshake. An icon they already have would
        // "verify" a player who changed nothing.
        for (const current of CHALLENGE_ICON_IDS) {
            for (let i = 0; i < CHALLENGE_ICON_IDS.length; i++) {
                expect(chooseChallengeIcon(current, i)).not.toBe(current);
            }
        }
    });

    it('always returns an icon from the known-owned set', () => {
        const chosen = chooseChallengeIcon(null, 3);
        expect(CHALLENGE_ICON_IDS).toContain(chosen as never);
    });

    it('handles an unknown current icon', () => {
        expect(CHALLENGE_ICON_IDS).toContain(
            chooseChallengeIcon(undefined, 0) as never
        );
    });

    it('wraps an out-of-range index rather than returning undefined', () => {
        expect(chooseChallengeIcon(null, 999)).toBeDefined();
        expect(chooseChallengeIcon(null, -4)).toBeDefined();
    });

    it('is deterministic for a given index', () => {
        expect(chooseChallengeIcon(588, 2)).toBe(chooseChallengeIcon(588, 2));
    });
});

describe('getOrCreateIdentityForAccount', () => {
    it('reuses the identity of an account already linked', async () => {
        queryMock.mockResolvedValueOnce({ rows: [account()] });
        await expect(
            getOrCreateIdentityForAccount('riot_puuid', 'puuid-1')
        ).resolves.toBe('id-1');
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('creates one for an account never seen before', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [] }) // getAccount
            .mockResolvedValueOnce({ rows: [{ identity_id: 'id-new' }] }) // insert identity
            .mockResolvedValueOnce({ rows: [] }) // insert account
            .mockResolvedValueOnce({
                rows: [account({ identity_id: 'id-new' })],
            });

        await expect(
            getOrCreateIdentityForAccount('discord_user', 'discord-1')
        ).resolves.toBe('id-new');
    });

    it('settles on the winner when two first-links race', async () => {
        // Both create an identity; the loser's INSERT does nothing. Returning
        // its own orphan id would split one person into two identities.
        queryMock
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ identity_id: 'id-mine' }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({
                rows: [account({ identity_id: 'id-winner' })],
            });

        await expect(
            getOrCreateIdentityForAccount('discord_user', 'discord-1')
        ).resolves.toBe('id-winner');
    });
});

describe('linkAccount', () => {
    it('links an account nobody has claimed', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [account()] });

        const result = await linkAccount('id-1', 'riot_puuid', 'puuid-1');
        expect(result.ok).toBe(true);
    });

    it('refuses an account belonging to somebody else', async () => {
        // A contested link is a person to talk to, not a race to win. Silently
        // reassigning would let anyone capture an account by linking it second.
        queryMock.mockResolvedValueOnce({
            rows: [account({ identity_id: 'id-other' })],
        });

        const result = await linkAccount('id-1', 'riot_puuid', 'puuid-1');
        expect(result).toEqual({
            ok: false,
            reason: 'already_linked',
            identityId: 'id-other',
        });
        // Refused before writing anything.
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('allows re-linking to the same identity, to upgrade verification', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [account({ method: 'trusted' })] })
            .mockResolvedValueOnce({
                rows: [account({ method: 'icon_handshake' })],
            });

        const result = await linkAccount('id-1', 'riot_puuid', 'puuid-1', {
            method: 'icon_handshake',
        });
        expect(result.ok).toBe(true);
    });

    it('never downgrades an already-verified link', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [account()] });

        await linkAccount('id-1', 'riot_puuid', 'puuid-1');

        const sql = String(queryMock.mock.calls[1][0]).replace(/\s+/g, ' ');
        expect(sql).toContain(
            'verified_at = COALESCE(EXCLUDED.verified_at, identity_accounts.verified_at)'
        );
    });

    it('records the verification time and method when given one', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [account()] });

        const at = new Date(NOW);
        await linkAccount('id-1', 'riot_puuid', 'puuid-1', {
            method: 'icon_handshake',
            verifiedAt: at,
        });

        const params = queryMock.mock.calls[1][1];
        expect(params[3]).toBe(at.toISOString());
        expect(params[4]).toBe('icon_handshake');
    });

    it('leaves verified_at null for an unverified link', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [account()] });

        await linkAccount('id-1', 'riot_puuid', 'puuid-1');
        expect(queryMock.mock.calls[1][1][3]).toBeNull();
    });
});

describe('unlinkAccount', () => {
    it('reports true when something was removed', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 1 });
        await expect(unlinkAccount('riot_puuid', 'puuid-1')).resolves.toBe(
            true
        );
    });

    it('reports false when there was nothing to remove', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 0 });
        await expect(unlinkAccount('riot_puuid', 'puuid-1')).resolves.toBe(
            false
        );
    });
});

describe('resolveIdentity', () => {
    it('groups every linked account by kind', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [account()] })
            .mockResolvedValueOnce({
                rows: [
                    account({ kind: 'riot_puuid', external_id: 'puuid-1' }),
                    account({
                        kind: 'riot_puuid',
                        external_id: 'puuid-2',
                        verified_at: '2026-07-31T00:00:00.000Z',
                    }),
                    account({ kind: 'discord_user', external_id: 'discord-1' }),
                    account({ kind: 'meeps_user', external_id: 'meeps-1' }),
                ],
            });

        const resolved = await resolveIdentity('riot_puuid', 'puuid-1');
        expect(resolved.identityId).toBe('id-1');
        expect(resolved.puuids).toEqual(['puuid-1', 'puuid-2']);
        expect(resolved.discordUserIds).toEqual(['discord-1']);
        expect(resolved.meepsUserIds).toEqual(['meeps-1']);
    });

    it('separates verified accounts from merely linked ones', async () => {
        // Auto rank roles and anything else granting a privilege may only
        // trust a verified link.
        queryMock
            .mockResolvedValueOnce({ rows: [account()] })
            .mockResolvedValueOnce({
                rows: [
                    account({ external_id: 'puuid-trusted' }),
                    account({
                        external_id: 'puuid-verified',
                        verified_at: '2026-07-31T00:00:00.000Z',
                        method: 'icon_handshake',
                    }),
                ],
            });

        const resolved = await resolveIdentity('discord_user', 'discord-1');
        expect(resolved.verifiedPuuids).toEqual(['puuid-verified']);
        expect(resolved.puuids).toHaveLength(2);
    });

    it('answers empty for an unlinked account rather than throwing', async () => {
        // Not being linked is the normal state for most people most of the
        // time; making callers handle it as a failure would be wrong.
        queryMock.mockResolvedValueOnce({ rows: [] });

        const resolved = await resolveIdentity('meeps_user', 'nobody');
        expect(resolved).toEqual({
            identityId: null,
            puuids: [],
            discordUserIds: [],
            meepsUserIds: [],
            r6UbisoftIds: [],
            verifiedPuuids: [],
        });
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('exposes the two convenience readers', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [account()] })
            .mockResolvedValueOnce({ rows: [account()] });
        await expect(getPuuidsForDiscordUser('discord-1')).resolves.toEqual([
            'puuid-1',
        ]);

        queryMock
            .mockResolvedValueOnce({ rows: [account()] })
            .mockResolvedValueOnce({ rows: [account()] });
        await expect(getPuuidsForMeepsUser('meeps-1')).resolves.toEqual([
            'puuid-1',
        ]);
    });
});

describe('link challenges', () => {
    it('expires ten minutes out', async () => {
        queryMock.mockResolvedValueOnce({ rows: [challenge()] });
        await createLinkChallenge(
            DISCORD_SUBJECT,
            { puuid: 'puuid-1', gameName: 'Louis', tagLine: 'EUW' },
            590,
            NOW
        );

        // Index 7, not 6: the subject is two parameters since 022.
        const params = queryMock.mock.calls[0][1];
        expect(Date.parse(params[7]) - NOW).toBe(CHALLENGE_TTL_MS);
    });

    it('replaces an earlier challenge rather than adding one', async () => {
        // One outstanding challenge per person: starting a second /link
        // abandons the first instead of leaving two live claims.
        queryMock.mockResolvedValueOnce({ rows: [challenge()] });
        await createLinkChallenge(
            DISCORD_SUBJECT,
            { puuid: 'puuid-1', gameName: 'Louis', tagLine: 'EUW' },
            590,
            NOW
        );
        expect(String(queryMock.mock.calls[0][0])).toContain(
            'ON CONFLICT (subject_kind, subject_id) DO UPDATE'
        );
    });

    it('returns an open challenge', async () => {
        queryMock.mockResolvedValueOnce({ rows: [challenge()] });
        await expect(
            getLinkChallenge(DISCORD_SUBJECT, NOW)
        ).resolves.toMatchObject({ puuid: 'puuid-1' });
    });

    it('treats an expired challenge as absent and sweeps it', async () => {
        queryMock
            .mockResolvedValueOnce({
                rows: [
                    challenge({
                        expires_at: new Date(NOW - 1000).toISOString(),
                    }),
                ],
            })
            .mockResolvedValueOnce({ rows: [] });

        await expect(
            getLinkChallenge(DISCORD_SUBJECT, NOW)
        ).resolves.toBeNull();
        expect(String(queryMock.mock.calls[1][0])).toContain('DELETE FROM');
    });

    it('expires exactly on the boundary', async () => {
        queryMock
            .mockResolvedValueOnce({
                rows: [challenge({ expires_at: new Date(NOW).toISOString() })],
            })
            .mockResolvedValueOnce({ rows: [] });
        await expect(
            getLinkChallenge(DISCORD_SUBJECT, NOW)
        ).resolves.toBeNull();
    });

    it('returns null when there was never a challenge', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        await expect(
            getLinkChallenge(DISCORD_SUBJECT, NOW)
        ).resolves.toBeNull();
    });

    it('deletes on request', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        await deleteLinkChallenge(DISCORD_SUBJECT);
        expect(String(queryMock.mock.calls[0][0])).toContain('DELETE FROM');
    });
});

describe('verifyLinkChallenge', () => {
    it('links both accounts on a matching icon', async () => {
        queryMock
            .mockResolvedValueOnce({
                rows: [challenge({ required_icon: 590 })],
            })
            .mockResolvedValueOnce({
                rows: [account({ kind: 'discord_user' })],
            })
            .mockResolvedValueOnce({ rows: [] }) // linkAccount: getAccount
            .mockResolvedValueOnce({ rows: [account()] }) // linkAccount: upsert
            .mockResolvedValueOnce({ rows: [] }); // deleteLinkChallenge

        const outcome = await verifyLinkChallenge(DISCORD_SUBJECT, 590, NOW);
        expect(outcome).toEqual({
            ok: true,
            puuid: 'puuid-1',
            identityId: 'id-1',
        });
    });

    it('reports a mismatch with both icons, and leaves the challenge open', async () => {
        // Nearly always "not changed yet". Deleting would make the fix "start
        // again" rather than "wait a moment and retry".
        queryMock.mockResolvedValueOnce({
            rows: [challenge({ required_icon: 590 })],
        });

        const outcome = await verifyLinkChallenge(DISCORD_SUBJECT, 12, NOW);
        expect(outcome).toEqual({
            ok: false,
            reason: 'icon_mismatch',
            expected: 590,
            actual: 12,
        });
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('reports no challenge when it expired mid-handshake', async () => {
        queryMock
            .mockResolvedValueOnce({
                rows: [
                    challenge({
                        expires_at: new Date(NOW - 1).toISOString(),
                    }),
                ],
            })
            .mockResolvedValueOnce({ rows: [] });

        await expect(
            verifyLinkChallenge(DISCORD_SUBJECT, 590, NOW)
        ).resolves.toEqual({ ok: false, reason: 'no_challenge' });
    });

    it('refuses when the Riot account was claimed while they were away', async () => {
        queryMock
            .mockResolvedValueOnce({
                rows: [challenge({ required_icon: 590 })],
            })
            .mockResolvedValueOnce({
                rows: [account({ kind: 'discord_user' })],
            })
            .mockResolvedValueOnce({
                rows: [account({ identity_id: 'id-other' })],
            });

        await expect(
            verifyLinkChallenge(DISCORD_SUBJECT, 590, NOW)
        ).resolves.toEqual({
            ok: false,
            reason: 'already_linked',
            identityId: 'id-other',
        });
    });
});

describe('createTrustedLink', () => {
    it('links without verification and says so in the method', async () => {
        queryMock
            .mockResolvedValueOnce({
                rows: [account({ kind: 'discord_user' })],
            })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [account({ method: 'trusted' })] });

        const outcome = await createTrustedLink('discord-1', 'puuid-1');
        expect(outcome.ok).toBe(true);

        const params = queryMock.mock.calls[2][1];
        expect(params[4]).toBe('trusted');
        // verified_at stays null, so a privilege check can still tell the
        // difference between trusted and verified.
        expect(params[3]).toBeNull();
    });

    it('stamps verified_at only for a method that proves ownership', async () => {
        // Deriving verified_at from "was a method given" rather than from
        // which method would mark every trusted link as verified, collapsing
        // the one distinction that lets a privilege check be stricter than a
        // lookup.
        for (const [method, expectStamp] of [
            ['icon_handshake', true],
            ['rso', true],
            ['trusted', false],
        ] as const) {
            queryMock.mockReset();
            queryMock
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [account()] });

            await linkAccount('id-1', 'riot_puuid', 'puuid-1', { method });

            const verifiedAt = queryMock.mock.calls[1][1][3];
            expect(verifiedAt === null).toBe(!expectStamp);
        }
    });
});

describe('getAccountsForIdentity', () => {
    it('reads in link order', async () => {
        queryMock.mockResolvedValueOnce({ rows: [account()] });
        await getAccountsForIdentity('id-1');
        expect(String(queryMock.mock.calls[0][0])).toContain(
            'ORDER BY linked_at ASC'
        );
    });
});

describe('getAccount', () => {
    it('returns null for an account never linked', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        await expect(getAccount('riot_puuid', 'nope')).resolves.toBeNull();
    });
});

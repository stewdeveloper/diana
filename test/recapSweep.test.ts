jest.mock(
    '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db',
    () => ({ db: { query: jest.fn() } })
);
jest.mock('../packages/diana-core/src/core/sessions/sessionService', () => ({
    rebuildSessionsForSquad: jest.fn(),
    getSessionDetail: jest.fn(),
    getSquadPuuids: jest.fn(),
}));
jest.mock('../packages/diana-core/src/core/sessions/recapService', () => ({
    findSettledSessions: jest.fn(),
    markRecapEmitted: jest.fn(),
    computeStandouts: jest.fn(),
    buildSessionCompletedEvent: jest.fn(),
}));

import { db } from '../packages/diana-core/src/plugins/diana-league-bot/api/utils/db';
import {
    getSessionDetail,
    getSquadPuuids,
    rebuildSessionsForSquad,
} from '../packages/diana-core/src/core/sessions/sessionService';
import {
    buildSessionCompletedEvent,
    computeStandouts,
    findSettledSessions,
    markRecapEmitted,
} from '../packages/diana-core/src/core/sessions/recapService';
import {
    DEFAULT_ACTIVITY_LOOKBACK_MS,
    findActiveSquads,
    runRecapSweep,
} from '../packages/diana-core/src/core/sessions/recapSweep';

const queryMock = db.query as unknown as jest.Mock;
const rebuildMock = rebuildSessionsForSquad as jest.Mock;
const detailMock = getSessionDetail as jest.Mock;
const puuidsMock = getSquadPuuids as jest.Mock;
const settledMock = findSettledSessions as jest.Mock;
const markMock = markRecapEmitted as jest.Mock;
const standoutsMock = computeStandouts as jest.Mock;
const buildMock = buildSessionCompletedEvent as jest.Mock;

const NOW = Date.parse('2026-07-29T03:00:00.000Z');

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    queryMock.mockResolvedValue({ rows: [] });
    rebuildMock.mockResolvedValue({
        squadId: 'squad-1',
        sessions: 1,
        matchesAttached: 2,
        openSessions: 0,
    });
    settledMock.mockResolvedValue([]);
    detailMock.mockResolvedValue({
        session: { session_id: 'sess-1', squad_id: 'squad-1' },
        participants: [],
        matches: [],
    });
    puuidsMock.mockResolvedValue(['p1']);
    standoutsMock.mockResolvedValue({});
    buildMock.mockReturnValue({
        eventId: 'session.completed:squad-1:x',
        type: 'session.completed',
    });
    markMock.mockResolvedValue(undefined);
});

afterEach(() => jest.restoreAllMocks());

const settled = (sessionId: string, squadId = 'squad-1') => ({
    session_id: sessionId,
    squad_id: squadId,
    started_at: '2026-07-28T20:00:00.000Z',
    ended_at: '2026-07-29T01:40:00.000Z',
});

const adapter = (delivered = true) => ({
    emit: jest.fn().mockResolvedValue(delivered),
});

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

describe('findActiveSquads', () => {
    // A squad whose last event was a join two days ago has an open night and no
    // recent activity. Without the union its evening would never close.
    it('unions recent presence with squads that still have an open night', async () => {
        queryMock.mockResolvedValue({ rows: [{ squad_id: 'a' }] });

        await findActiveSquads('2026-07-28T03:00:00.000Z');

        const [sql] = queryMock.mock.calls[0];
        expect(sql).toContain('FROM presence_events');
        expect(sql).toContain('UNION');
        expect(sql).toContain('ended_at IS NULL');
    });
});

describe('runRecapSweep', () => {
    it('looks a day back for active squads and rebuilds each one', async () => {
        queryMock.mockResolvedValue({
            rows: [{ squad_id: 'squad-1' }, { squad_id: 'squad-2' }],
        });

        const result = await runRecapSweep(adapter(), { now: NOW });

        const [, params] = queryMock.mock.calls[0];
        expect(params[0]).toBe(
            new Date(NOW - DEFAULT_ACTIVITY_LOOKBACK_MS).toISOString()
        );
        expect(rebuildMock).toHaveBeenCalledTimes(2);
        expect(result.squadsRebuilt).toBe(2);
    });

    // The rebuild window has to comfortably clear the oldest night that could
    // still be settling: rebuildSessionsForSquad under-reports a night its
    // `since` cuts in half.
    it('rebuilds from further back than it searches for activity', async () => {
        queryMock.mockResolvedValue({ rows: [{ squad_id: 'squad-1' }] });

        await runRecapSweep(adapter(), { now: NOW });

        const [, options] = rebuildMock.mock.calls[0];
        expect(Date.parse(options.since)).toBeLessThan(
            NOW - DEFAULT_ACTIVITY_LOOKBACK_MS
        );
    });

    it('announces a settled night and records it', async () => {
        settledMock.mockResolvedValue([settled('sess-1')]);
        const events = adapter();

        const result = await runRecapSweep(events, { now: NOW });

        expect(events.emit).toHaveBeenCalledTimes(1);
        expect(markMock).toHaveBeenCalledWith('sess-1');
        expect(result.recapsEmitted).toBe(1);
        expect(result.recapsDeferred).toBe(0);
    });

    // The point of the whole delivery-result change. Marking a night announced
    // when it never arrived loses that recap permanently - there is exactly one
    // per night and nothing re-derives it.
    it('does NOT record a night whose delivery failed, so it retries', async () => {
        settledMock.mockResolvedValue([settled('sess-1')]);
        const events = adapter(false);

        const result = await runRecapSweep(events, { now: NOW });

        expect(events.emit).toHaveBeenCalledTimes(1);
        expect(markMock).not.toHaveBeenCalled();
        expect(result.recapsEmitted).toBe(0);
        expect(result.recapsDeferred).toBe(1);
    });

    it('holds recaps rather than losing them when no adapter is configured', async () => {
        settledMock.mockResolvedValue([settled('sess-1'), settled('sess-2')]);

        const result = await runRecapSweep(null, { now: NOW });

        expect(markMock).not.toHaveBeenCalled();
        expect(result.recapsDeferred).toBe(2);
    });

    it('scopes standouts to the squad that owns the night', async () => {
        settledMock.mockResolvedValue([settled('sess-1', 'squad-7')]);
        puuidsMock.mockResolvedValue(['p1', 'p2']);

        await runRecapSweep(adapter(), { now: NOW });

        expect(puuidsMock).toHaveBeenCalledWith('squad-7');
        expect(standoutsMock).toHaveBeenCalledWith('sess-1', ['p1', 'p2']);
    });

    // ------------------------------------------------------------------
    // Isolation
    // ------------------------------------------------------------------

    it('keeps sweeping when one squad cannot be rebuilt', async () => {
        queryMock.mockResolvedValue({
            rows: [{ squad_id: 'bad' }, { squad_id: 'good' }],
        });
        rebuildMock
            .mockRejectedValueOnce(new Error('corrupt presence'))
            .mockResolvedValueOnce({
                squadId: 'good',
                sessions: 1,
                matchesAttached: 0,
                openSessions: 0,
            });

        const result = await runRecapSweep(adapter(), { now: NOW });

        expect(rebuildMock).toHaveBeenCalledTimes(2);
        expect(result.squadsRebuilt).toBe(1);
    });

    // A failed rebuild must not stop a *different* night that is already ready.
    it('still announces settled nights after a rebuild failure', async () => {
        queryMock.mockResolvedValue({ rows: [{ squad_id: 'bad' }] });
        rebuildMock.mockRejectedValue(new Error('corrupt presence'));
        settledMock.mockResolvedValue([settled('sess-1')]);
        const events = adapter();

        const result = await runRecapSweep(events, { now: NOW });

        expect(events.emit).toHaveBeenCalledTimes(1);
        expect(result.recapsEmitted).toBe(1);
    });

    it('keeps announcing when one night cannot be assembled', async () => {
        settledMock.mockResolvedValue([
            settled('sess-bad'),
            settled('sess-ok'),
        ]);
        detailMock
            .mockRejectedValueOnce(new Error('matches vanished'))
            .mockResolvedValueOnce({
                session: { session_id: 'sess-ok', squad_id: 'squad-1' },
                participants: [],
                matches: [],
            });
        const events = adapter();

        const result = await runRecapSweep(events, { now: NOW });

        expect(events.emit).toHaveBeenCalledTimes(1);
        expect(markMock).toHaveBeenCalledWith('sess-ok');
        expect(result.recapsEmitted).toBe(1);
        expect(result.recapsDeferred).toBe(1);
    });

    it('treats a vanished session as nothing to announce, not a failure', async () => {
        settledMock.mockResolvedValue([settled('sess-1')]);
        detailMock.mockResolvedValue(null);
        const events = adapter();

        const result = await runRecapSweep(events, { now: NOW });

        expect(events.emit).not.toHaveBeenCalled();
        expect(markMock).not.toHaveBeenCalled();
        expect(result.recapsEmitted).toBe(0);
    });

    it('does nothing noisy on a quiet tick', async () => {
        const events = adapter();

        const result = await runRecapSweep(events, { now: NOW });

        expect(events.emit).not.toHaveBeenCalled();
        expect(result).toEqual({
            squadsRebuilt: 0,
            recapsEmitted: 0,
            recapsDeferred: 0,
        });
    });

    it('passes the idle gap through to settlement', async () => {
        await runRecapSweep(adapter(), { now: NOW, idleGapMs: 12345 });

        expect(settledMock).toHaveBeenCalledWith(NOW, 12345);
    });
});

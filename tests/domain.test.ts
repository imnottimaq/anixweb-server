import assert from 'node:assert/strict';
import test from 'node:test';
import { RoomEngine, playbackPosition, DomainError } from '../src/domain.ts';
import { WAIT_MS, EMPTY_TTL_MS, parseClientMessage, parseServerMessage, type RoomCommandPayload, type RoomMedia } from '../protocol/index.ts';

const host = { profileId: 1, login: 'Host', avatar: null };
const guest = { profileId: 2, login: 'Guest', avatar: null };
const third = { profileId: 3, login: 'Third', avatar: null };
const media: RoomMedia = { releaseId: 10, releaseName: 'Anime', dubId: 20, sourceId: 30, episode: 1, episodeName: 'One' };
let serial = 0;
function create() {
    const engine = RoomEngine.create({ roomId: 'room', joinCode: 'AB12CD34', title: 'Test room', visibility: 'private', host }, 0);
    engine.connect(host, 0); engine.connect(guest, 0);
    return engine;
}
function send(engine: RoomEngine, who: number, payload: RoomCommandPayload, now = 0, id = `command-${++serial}`) {
    return engine.command(who, { ...payload, commandId: id, mediaVersion: engine.state.mediaVersion }, now);
}
function select(engine: RoomEngine) {
    send(engine, 1, { type: 'set_viewing', viewing: true });
    send(engine, 2, { type: 'set_viewing', viewing: true });
    send(engine, 1, { type: 'set_media', media });
}
function ready(engine: RoomEngine, who: number, now = 0) { return send(engine, who, { type: 'ready', epoch: engine.state.syncEpoch }, now); }
function playing() { const engine = create(); select(engine); ready(engine, 1); ready(engine, 2); return engine; }
function rejects(code: string, fn: () => unknown) { assert.throws(fn, error => error instanceof DomainError && error.code === code); }

test('all viewers ready resumes immediately, before the seven-second deadline', () => {
    const e = create(); select(e); ready(e, 1, 1000);
    assert.equal(e.state.playback.paused, true);
    ready(e, 2, 1500);
    assert.equal(e.state.barrier, null); assert.equal(e.state.playback.paused, false);
    assert.equal(playbackPosition(e.state, 2500), 1);
});
test('seven-second timeout continues without kicking the loader', () => {
    const e = create(); select(e); ready(e, 1, 1000);
    e.tick(WAIT_MS - 1); assert.equal(e.state.playback.paused, true);
    e.tick(WAIT_MS); assert.equal(e.state.playback.paused, false);
    assert.equal(e.state.participants.length, 2);
    assert.equal(e.state.participants[1].excludedEpoch, e.state.syncEpoch);
    assert.equal(e.state.participants[1].connected, true);
});
test('late ready joins the running anchor without pausing everyone', () => {
    const e = create(); select(e); ready(e, 1); e.tick(WAIT_MS);
    ready(e, 2, WAIT_MS + 3000);
    assert.equal(e.state.playback.position, 3); assert.equal(e.state.playback.paused, false);
    assert.equal(e.state.barrier, null); assert.equal(e.state.participants[1].excludedEpoch, null);
});
test('repeated buffering cannot extend the deadline or re-pause a timed-out loader', () => {
    const e = create(); select(e); ready(e, 1);
    send(e, 2, { type: 'buffering', epoch: e.state.syncEpoch }, 5000);
    assert.equal(e.state.barrier?.deadline, WAIT_MS);
    e.tick(WAIT_MS);
    send(e, 2, { type: 'buffering', epoch: e.state.syncEpoch }, WAIT_MS + 1000);
    assert.equal(e.state.barrier, null); assert.equal(e.state.playback.paused, false);
});
test('a recovered participant can trigger a new wait for a genuinely new stall', () => {
    const e = create(); select(e); ready(e, 1); e.tick(WAIT_MS); ready(e, 2, 8000);
    send(e, 2, { type: 'buffering', epoch: e.state.syncEpoch }, 9000);
    assert.equal(e.state.barrier?.deadline, 16000); assert.equal(e.state.playback.position, 2);
    assert.equal(e.state.playback.paused, true);
});
test('manual pause remains paused when everyone becomes ready', () => {
    const e = create(); select(e); ready(e, 1);
    send(e, 1, { type: 'pause', position: 123 }, 1000); ready(e, 2, 2000);
    assert.equal(e.state.barrier, null); assert.equal(e.state.playback.intent, 'paused'); assert.equal(e.state.playback.paused, true);
});
test('manual pause remains paused after the timeout', () => {
    const e = create(); select(e); ready(e, 1);
    send(e, 1, { type: 'pause', position: 123 }, 1000); e.tick(WAIT_MS);
    assert.equal(e.state.playback.paused, true); assert.equal(e.state.playback.position, 0);
});
test('seeks create a fresh readiness epoch and preserve manual pause', () => {
    const e = playing(); send(e, 1, { type: 'pause', position: 0 }, 1000);
    const oldEpoch = e.state.syncEpoch; send(e, 1, { type: 'seek', position: 42 }, 2000);
    assert.equal(e.state.syncEpoch, oldEpoch + 1); assert.equal(e.state.barrier?.target, 42);
    ready(e, 1, 2500); ready(e, 2, 2500);
    assert.equal(e.state.playback.position, 42); assert.equal(e.state.playback.paused, true);
});
test('ready reports for an old seek or media epoch are rejected', () => {
    const e = playing(); const oldEpoch = e.state.syncEpoch;
    send(e, 1, { type: 'seek', position: 30 });
    rejects('STALE_EPOCH', () => send(e, 2, { type: 'ready', epoch: oldEpoch }));
});
test('room metadata retains complete media identity including dub and source', () => {
    const e = playing(); const previous = e.state.mediaVersion;
    send(e, 1, { type: 'set_media', media: { ...media, dubId: 99, sourceId: 88 } });
    assert.equal(e.state.mediaVersion, previous + 1); assert.equal(e.state.media?.dubId, 99); assert.equal(e.state.media?.sourceId, 88);
    assert.equal(e.state.playback.position, 0); assert.equal(e.state.playback.intent, 'playing');
});
test('unprivileged viewers cannot issue playback commands', () => {
    const e = playing(); rejects('CONTROL_REQUIRED', () => send(e, 2, { type: 'pause', position: 0 }));
    rejects('HOST_REQUIRED', () => send(e, 2, { type: 'grant_control', profileId: 2 }));
});
for (const visibility of ['private', 'public'] as const) test(`host can grant and revoke control in ${visibility} rooms`, () => {
    const e = playing(); e.state.visibility = visibility;
    send(e, 1, { type: 'grant_control', profileId: 2 });
    send(e, 2, { type: 'pause', position: 0 });
    send(e, 1, { type: 'revoke_control', profileId: 2 });
    rejects('CONTROL_REQUIRED', () => send(e, 2, { type: 'play', position: 0 }));
});
test('manual host transfer updates authority atomically', () => {
    const e = playing(); send(e, 1, { type: 'transfer_host', profileId: 2 });
    assert.equal(e.state.hostId, 2); assert.equal(e.state.participants[0].canControl, false);
    rejects('HOST_REQUIRED', () => send(e, 1, { type: 'kick', profileId: 2 }));
    send(e, 2, { type: 'grant_control', profileId: 1 });
});
test('explicit host leave chooses a connected participant immediately', () => {
    const e = new RoomEngine(create().exportData(), () => 0.99); e.connect(third, 0);
    send(e, 1, { type: 'leave' }); assert.equal(e.state.hostId, 3);
    assert.equal(e.state.participants.some(p => p.profileId === 1), false);
});
test('offline host gets seven seconds to reconnect', () => {
    const e = playing(); e.disconnect(1, 1000); e.tick(7999); assert.equal(e.state.hostId, 1);
    e.connect(host, 7999); e.tick(8000); assert.equal(e.state.hostId, 1);
});
test('host loss beyond seven seconds transfers role and return does not reclaim it', () => {
    const e = playing(); e.disconnect(1, 1000); e.tick(8000); assert.equal(e.state.hostId, 2);
    e.connect(host, 9000); assert.equal(e.state.hostId, 2); assert.equal(e.state.participants[0].canControl, false);
});
test('presence updates do not reset running playback time', () => {
    const e = playing(); e.connect(third, 5000);
    assert.equal(playbackPosition(e.state, 6000), 6);
    send(e, 3, { type: 'set_viewing', viewing: false }, 7000);
    assert.equal(playbackPosition(e.state, 8000), 8);
});
test('new transport cannot inherit a previous player readiness or viewing lease', () => {
    const e = playing(); e.connect(guest, 1000);
    const participant = e.state.participants.find(p => p.profileId === 2)!;
    assert.equal(participant.viewing, false); assert.equal(participant.status, 'idle'); assert.equal(participant.readyEpoch, null);
    assert.equal(e.state.playback.paused, false); assert.equal(playbackPosition(e.state, 2000), 2);
});
test('people outside the player never block loading', () => {
    const e = create(); send(e, 1, { type: 'set_viewing', viewing: true }); send(e, 1, { type: 'set_media', media }); ready(e, 1);
    assert.equal(e.state.playback.paused, false); assert.equal(e.state.participants[1].status, 'idle');
});
test('leaving the player releases an active readiness blocker', () => {
    const e = create(); select(e); ready(e, 1);
    send(e, 2, { type: 'set_viewing', viewing: false }, 1000);
    assert.equal(e.state.barrier, null); assert.equal(e.state.playback.paused, false);
});
test('commands are idempotent across persistence and a media revision', () => {
    const e = playing(); const cmd = { type: 'set_media', media, commandId: 'same', mediaVersion: e.state.mediaVersion } as const;
    e.command(1, cmd, 1000); const revision = e.state.revision;
    const restored = new RoomEngine(e.exportData());
    assert.equal(restored.command(1, cmd, 2000).duplicate, true); assert.equal(restored.state.revision, revision);
});
test('stale commands never change a new episode', () => {
    const e = playing(); const oldVersion = e.state.mediaVersion;
    send(e, 1, { type: 'set_media', media: { ...media, episode: 2 } });
    rejects('STALE_MEDIA', () => e.command(1, { type: 'seek', position: 99, commandId: 'old', mediaVersion: oldVersion }, 0));
    assert.equal(e.state.playback.position, 0);
});
test('empty rooms expire after ten minutes and reconnect prevents expiration', () => {
    const e = create(); send(e, 1, { type: 'leave' }, 1000); send(e, 2, { type: 'leave' }, 1000);
    assert.equal(e.state.emptySince, 1000); e.tick(1000 + EMPTY_TTL_MS - 1); assert.equal(e.state.closed, false);
    const restored = new RoomEngine(e.exportData()); restored.connect(third, 1000 + EMPTY_TTL_MS - 1);
    restored.tick(1000 + EMPTY_TTL_MS); assert.equal(restored.state.closed, false);
    e.tick(1000 + EMPTY_TTL_MS); assert.equal(e.state.closed, true); assert.equal(e.nextDeadline(), null);
    rejects('ROOM_CLOSED', () => e.connect(host, 1000 + EMPTY_TTL_MS));
});
test('room state survives a reload with its original wait deadline', () => {
    const e = create(); select(e); ready(e, 1);
    const restored = new RoomEngine(e.exportData()); assert.equal(restored.nextDeadline(), WAIT_MS);
    restored.tick(WAIT_MS); assert.equal(restored.state.playback.paused, false);
});
test('kicking an unready viewer releases the barrier without affecting the host', () => {
    const e = create(); select(e); ready(e, 1);
    const result = send(e, 1, { type: 'kick', profileId: 2 });
    assert.equal(result.kicked, 2); assert.equal(e.state.playback.paused, false);
    rejects('CANNOT_KICK_HOST', () => send(e, 1, { type: 'kick', profileId: 1 }));
});
test('speed changes use the server anchor rather than a stale client position', () => {
    const e = playing(); send(e, 1, { type: 'set_rate', position: 999, rate: 2 }, 5000);
    assert.equal(e.state.playback.position, 5); assert.equal(playbackPosition(e.state, 6000), 7);
});
test('runtime protocol rejects malformed and non-finite command payloads', () => {
    for (const invalid of [null, {}, { type: 'seek', commandId: 'x', mediaVersion: 0, position: NaN },
        { type: 'set_media', commandId: 'x', mediaVersion: 0, media: { ...media, dubId: 0 } },
        { type: 'set_rate', commandId: 'x', mediaVersion: 0, position: 0, rate: 999 }]) {
        assert.throws(() => parseClientMessage(invalid));
    }
    assert.deepEqual(parseClientMessage({ type: 'ping', requestId: 'clock' }), { type: 'ping', requestId: 'clock' });
});
test('runtime protocol validates full snapshots rather than trusting casts', () => {
    const e = playing(); const message = { type: 'room_state', state: e.snapshot(), serverTime: 123 };
    assert.deepEqual(parseServerMessage(message), message);
    const corrupt = structuredClone(message); corrupt.state.participants[0].connected = 'yes' as unknown as boolean;
    assert.throws(() => parseServerMessage(corrupt));
    assert.throws(() => parseServerMessage({ type: 'room_state', state: {}, serverTime: 0 }));
});

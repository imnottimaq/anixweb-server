import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ANIXART_APP_USER_AGENT } from '../src/userAgent.ts';

const origin = 'http://localhost:5173';
const bundle = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
function runtime(secret = 'integration-secret-at-least-thirty-two-characters') {
  return new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-07',
    bindings: { SESSION_SECRET: secret, ALLOWED_ORIGINS: origin },
    durableObjects: { ROOMS: { className: 'RoomObject', useSQLite: true }, DIRECTORY: { className: 'RoomDirectory', useSQLite: true } },
    serviceBindings: { ANIXART_TEST: async request => {
      assert.equal(request.headers.get('User-Agent'), ANIXART_APP_USER_AGENT);
      const token = new URL(request.url).searchParams.get('token');
      if (token === 'outage') return new Response('unavailable', { status: 503 });
      return Response.json({ code: 0, profile: { id: Number(token), login: token === '4' ? '   ' : `user${token}`, avatar: token === '3' ? '' : null } });
    } },
  }));
}
function post(mf, path, body, session) {
  return mf.dispatchFetch(`http://localhost${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session}` } : {}) }, body: JSON.stringify(body) });
}
async function login(mf, id) {
  const response = await post(mf, '/api/v2/session', { token: String(id) });
  assert.equal(response.status, 200); return (await response.json()).session;
}
async function socket(mf, roomId, ticket) {
  const response = await mf.dispatchFetch(`http://localhost/api/v2/rooms/${roomId}/ws?ticket=${ticket}`, { headers: { Origin: origin, Upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  const ws = response.webSocket;
  const messages = [], waiters = [];
  ws.addEventListener('message', event => { const message = JSON.parse(event.data); messages.push(message); for (const waiter of [...waiters]) waiter(message); });
  ws.accept();
  const nextAfter = (checkpoint, predicate, timeout = 4000) => new Promise((resolve, reject) => {
    const existing = messages.slice(checkpoint).find(predicate);
    if (existing) { resolve(existing); return; }
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('WebSocket message timeout')); }, timeout);
    const waiter = message => { if (predicate(message)) { clearTimeout(timer); waiters.splice(waiters.indexOf(waiter), 1); resolve(message); } };
    waiters.push(waiter);
  });
  return {
    ws,
    messages,
    checkpoint: () => messages.length,
    nextAfter,
    next: (predicate, timeout = 4000) => nextAfter(0, predicate, timeout),
  };
}
const send = (client, type, fields = {}, mediaVersion = 0) => {
  const commandId = crypto.randomUUID(); client.ws.send(JSON.stringify({ commandId, mediaVersion, type, ...fields })); return commandId;
};

test('real Worker: authentication, private tickets, identity, permissions, replacement, snapshots and deduplication', async () => {
  const mf = runtime();
  try {
    const host = await login(mf, 1), guest = await login(mf, 2);
    const created = await post(mf, '/api/v2/rooms', { title: 'Together', visibility: 'private' }, host);
    assert.equal(created.status, 200);
    const { roomId, ticket } = await created.json();
    const h = await socket(mf, roomId, ticket);
    const initial = (await h.next(m => m.type === 'room_state')).state;
    assert.equal(initial.hostId, 1);
    assert.equal((await post(mf, '/api/v2/rooms/join', { roomId }, guest)).status, 403);
    const ticketReplay = await mf.dispatchFetch(`http://localhost/api/v2/rooms/${roomId}/ws?ticket=${ticket}`, { headers: { Origin: origin, Upgrade: 'websocket' } });
    assert.equal(ticketReplay.status, 401);
    const invitation = await post(mf, '/api/v2/rooms/join', { code: initial.joinCode }, guest);
    const g = await socket(mf, roomId, (await invitation.json()).ticket);
    assert.equal((await g.next(m => m.type === 'room_state')).state.participants.length, 2);
    const denied = send(g, 'play', { position: 0 });
    assert.equal((await g.next(m => m.type === 'error' && m.commandId === denied)).code, 'CONTROL_REQUIRED');
    const media = { releaseId: 1, releaseName: 'Test', dubId: 2, sourceId: 3, episode: 0, episodeName: 'Episode' };
    const selected = send(h, 'set_media', { media });
    const originalAck = await h.next(m => m.type === 'ack' && m.commandId === selected);
    const recordedRevision = originalAck.revision;
    const current = (await g.next(m => m.type === 'room_state' && m.state.mediaVersion === 1)).state;
    const cp = h.checkpoint();
    await assert.rejects(h.nextAfter(cp, m => m.type === 'ack' && m.commandId === selected, 50), /WebSocket message timeout/);
    h.ws.send(JSON.stringify({ type: 'set_media', commandId: selected, mediaVersion: 0, media }));
    const replayAck = await h.nextAfter(cp, m => m.type === 'ack' && m.commandId === selected);
    assert.equal(replayAck.revision, recordedRevision);
    h.ws.send(JSON.stringify({ type: 'sync_request' }));
    const replayedState = (await h.nextAfter(cp, m => m.type === 'room_state' && m.state.mediaVersion === 1)).state;
    assert.equal(replayedState.revision, recordedRevision);
    assert.equal(replayedState.mediaVersion, 1);
    const old = send(g, 'ready', { epoch: current.syncEpoch }, 0);
    await g.next(m => m.type === 'error' && m.commandId === old);
    const replacementTicket = await post(mf, '/api/v2/rooms/join', { roomId }, guest);
    const replacement = await socket(mf, roomId, (await replacementTicket.json()).ticket);
    await g.next(m => m.type === 'session_replaced');
    replacement.ws.send(JSON.stringify({ type: 'sync_request' }));
    const connected = await replacement.next(m => m.type === 'room_state' && m.state.participants.some(p => p.profileId === 2 && p.connected));
    assert.equal(connected.state.participants.filter(p => p.profileId === 2).length, 1);
    const grant = send(h, 'grant_control', { profileId: 2 }, 1);
    await h.next(m => m.type === 'ack' && m.commandId === grant);
    const pause = send(replacement, 'pause', { position: 5 }, 1);
    await replacement.next(m => m.type === 'ack' && m.commandId === pause);
    const transferred = send(h, 'transfer_host', { profileId: 2 }, 1);
    await h.next(m => m.type === 'ack' && m.commandId === transferred);
    await replacement.next(m => m.type === 'room_state' && m.state.hostId === 2);
    h.ws.close(); replacement.ws.close();
    const list = await (await mf.dispatchFetch('http://localhost/api/v2/rooms', { headers: { Origin: origin } })).json();
    assert.deepEqual(list.rooms, []);
  } finally { await mf.dispose(); }
});

test('real Worker: public list, invalid authentication, origin rejection, outage and configuration failure', async () => {
  const mf = runtime();
  try {
    assert.equal((await post(mf, '/api/v2/rooms', { title: 'Test', visibility: 'public' })).status, 401);
    assert.equal((await post(mf, '/api/v2/session', { token: 'outage' })).status, 503);
    assert.equal((await (await post(mf, '/api/v2/session', { token: '3' })).json()).profile.avatar, null);
    assert.equal((await post(mf, '/api/v2/session', { token: '4' })).status, 503);
    assert.equal((await post(mf, '/api/v2/session', { token: 'x'.repeat(9000) })).status, 413);
    assert.equal((await post(mf, '/api/v2/session', { token: 'я'.repeat(4500) })).status, 413);
    assert.equal((await mf.dispatchFetch('http://localhost/api/v2/rooms', { headers: { Origin: 'https://evil.example' } })).status, 403);
    const host = await login(mf, 1);
    const exploit = await post(mf, '/api/v2/rooms', { title: 'Exploit', visibility: ['private'] }, host);
    assert.equal(exploit.status, 400);
    assert.equal((await exploit.json()).code, 'INVALID_PAYLOAD');
    const response = await post(mf, '/api/v2/rooms', { title: 'Public', visibility: 'public' }, host);
    const { roomId } = await response.json();
    const list = await (await mf.dispatchFetch('http://localhost/api/v2/rooms', { headers: { Origin: origin } })).json();
    assert.equal(list.rooms[0].roomId, roomId);
    assert.equal((await post(mf, '/api/v2/rooms/join', { roomId }, await login(mf, 2))).status, 200);
    assert.equal((await post(mf, '/api/v2/rooms', { title: 'Public', visibility: 'public' }, host + 'tamper')).status, 401);
    for (let i = 0; i < 4; i++) assert.equal((await post(mf, '/api/v2/rooms', { title: 'Public', visibility: 'public' }, host)).status, 200);
    assert.equal((await post(mf, '/api/v2/rooms', { title: 'Public', visibility: 'public' }, host)).status, 429);
  } finally { await mf.dispose(); }
  const unconfigured = runtime('');
  try { assert.equal((await post(unconfigured, '/api/v2/session', { token: '1' })).status, 503); }
  finally { await unconfigured.dispose(); }
});

test('real Worker durable alarm: seven-second readiness timeout, manual pause, late catch-up, new buffering and kick', async () => {
  const mf = runtime();
  try {
    const host = await login(mf, 1), guest = await login(mf, 2);
    const created = await (await post(mf, '/api/v2/rooms', { title: 'Readiness', visibility: 'public' }, host)).json();
    const h = await socket(mf, created.roomId, created.ticket);
    const joined = await (await post(mf, '/api/v2/rooms/join', { roomId: created.roomId }, guest)).json();
    const g = await socket(mf, created.roomId, joined.ticket);
    async function command(client, type, fields = {}, version = 0) {
      const id = send(client, type, fields, version);
      const ack = await client.next(m => m.type === 'ack' && m.commandId === id);
      return (await h.next(m => m.type === 'room_state' && m.state.revision >= ack.revision)).state;
    }
    await command(h, 'set_viewing', { viewing: true });
    await command(g, 'set_viewing', { viewing: true });
    let state = await command(h, 'set_media', { media: { releaseId: 1, releaseName: 'Test', dubId: 1, sourceId: 1, episode: 1, episodeName: 'One' } });
    assert.ok(state.barrier);
    state = await command(h, 'ready', { epoch: state.syncEpoch }, 1);
    assert.ok(state.barrier);
    state = await command(h, 'pause', { position: 0 }, 1);
    const revision = state.revision;
    state = (await h.next(m => m.type === 'room_state' && m.state.revision > revision && m.state.barrier === null, 10_000)).state;
    assert.equal(state.playback.intent, 'paused');
    assert.equal(state.playback.paused, true);
    assert.equal(state.participants.length, 2);
    assert.equal(state.participants.find(p => p.profileId === 2).excludedEpoch, state.syncEpoch);
    state = await command(h, 'play', { position: 0 }, 1);
    assert.equal(state.playback.paused, false);
    state = await command(g, 'ready', { epoch: state.syncEpoch }, 1);
    assert.equal(state.playback.paused, false);
    state = await command(h, 'buffering', { epoch: state.syncEpoch }, 1);
    assert.ok(state.barrier);
    assert.equal(state.playback.paused, true);
    state = await command(h, 'ready', { epoch: state.syncEpoch }, 1);
    assert.equal(state.barrier, null);
    assert.equal(state.playback.paused, false);
    state = await command(h, 'kick', { profileId: 2 }, 1);
    await g.next(m => m.type === 'kicked');
    assert.deepEqual(state.participants.map(p => p.profileId), [1]);
    h.ws.close();
  } finally { await mf.dispose(); }
});

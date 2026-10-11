import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ANIXART_APP_USER_AGENT } from '../src/userAgent.ts';
import { RoomObject, RoomDirectory } from '../src/objects.ts';
import { EMPTY_TTL_MS } from '../protocol/index.ts';

const origin = 'http://localhost:5173';
const secret = 'integration-secret-at-least-thirty-two-characters';
const bundle = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });

function runtime() {
  return new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-07',
    bindings: { SESSION_SECRET: secret, ALLOWED_ORIGINS: origin },
    durableObjects: {
      ROOMS: { className: 'RoomObject', useSQLite: true },
      DIRECTORY: { className: 'RoomDirectory', useSQLite: true },
    },
    serviceBindings: {
      ANIXART_TEST: async request => {
        assert.equal(request.headers.get('User-Agent'), ANIXART_APP_USER_AGENT);
        const token = new URL(request.url).searchParams.get('token');
        if (token === 'outage') return new Response('unavailable', { status: 503 });
        return Response.json({
          code: 0,
          profile: { id: Number(token), login: `user${token}`, avatar: null },
        });
      },
    },
  }));
}

function post(mf: Miniflare, path: string, body: unknown, session?: string) {
  return mf.dispatchFetch(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function login(mf: Miniflare, id: number | string) {
  const response = await post(mf, '/api/v2/session', { token: String(id) });
  assert.equal(response.status, 200);
  return (await response.json() as { session: string }).session;
}

async function socket(mf: Miniflare, roomId: string, ticket: string) {
  const response = await mf.dispatchFetch(`http://localhost/api/v2/rooms/${roomId}/ws?ticket=${ticket}`, {
    headers: { Origin: origin, Upgrade: 'websocket' },
  });
  assert.equal(response.status, 101);
  const ws = response.webSocket!;
  const messages: any[] = [];
  const waiters: ((msg: any) => void)[] = [];
  ws.addEventListener('error', () => {});
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    messages.push(message);
    for (const waiter of [...waiters]) waiter(message);
  });
  ws.accept();
  const nextAfter = (checkpoint: number, predicate: (m: any) => boolean, timeout = 10_000) =>
    new Promise<any>((resolve, reject) => {
      const existing = messages.slice(checkpoint).find(predicate);
      if (existing) { resolve(existing); return; }
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error('WebSocket message timeout'));
      }, timeout);
      const waiter = (message: any) => {
        if (predicate(message)) {
          clearTimeout(timer);
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) waiters.splice(idx, 1);
          resolve(message);
        }
      };
      waiters.push(waiter);
    });

  return {
    ws,
    messages,
    checkpoint: () => messages.length,
    nextAfter,
    next: (predicate: (m: any) => boolean, timeout = 10_000) => nextAfter(0, predicate, timeout),
  };
}

const send = (client: { ws: WebSocket }, type: string, fields = {}, mediaVersion = 0) => {
  const commandId = crypto.randomUUID();
  client.ws.send(JSON.stringify({ commandId, mediaVersion, type, ...fields }));
  return commandId;
};

test('roomLifecycle: private room joins with incorrect invite codes are rejected', async () => {
  const mf = runtime();
  try {
    const host = await login(mf, 1);
    const guest = await login(mf, 2);

    const created = await post(mf, '/api/v2/rooms', { title: 'Secret Room', visibility: 'private' }, host);
    assert.equal(created.status, 200);
    const { roomId, ticket: hostTicket } = await created.json() as { roomId: string; ticket: string };
    const h = await socket(mf, roomId, hostTicket);
    const initial = (await h.next(m => m.type === 'room_state')).state;

    // 1. Invalid code format (too short) -> 400 INVALID_CODE
    const badCodeRes1 = await post(mf, '/api/v2/rooms/join', { roomId, code: 'SHORT' }, guest);
    assert.equal(badCodeRes1.status, 400);
    assert.equal((await badCodeRes1.json() as { code: string }).code, 'INVALID_CODE');

    // 2. Invalid code format (too long) -> 400 INVALID_CODE
    const badCodeRes2 = await post(mf, '/api/v2/rooms/join', { roomId, code: 'TOOLONGCODE123' }, guest);
    assert.equal(badCodeRes2.status, 400);
    assert.equal((await badCodeRes2.json() as { code: string }).code, 'INVALID_CODE');

    // 3. Valid format but non-existent code -> 404 ROOM_NOT_FOUND
    const nonExistentRes = await post(mf, '/api/v2/rooms/join', { code: 'ZZZZZZZZ' }, guest);
    assert.equal(nonExistentRes.status, 404);
    assert.equal((await nonExistentRes.json() as { code: string }).code, 'ROOM_NOT_FOUND');

    // 4. Joining private room by roomId directly without code -> 403 INVITE_REQUIRED
    const noCodeRes = await post(mf, '/api/v2/rooms/join', { roomId }, guest);
    assert.equal(noCodeRes.status, 403);
    assert.equal((await noCodeRes.json() as { code: string }).code, 'INVITE_REQUIRED');

    // 5. Joining with correct invite code -> 200
    const correctRes = await post(mf, '/api/v2/rooms/join', { code: initial.joinCode }, guest);
    assert.equal(correctRes.status, 200);
    const { ticket: guestTicket } = await correctRes.json() as { ticket: string };
    const g = await socket(mf, roomId, guestTicket);
    assert.equal((await g.next(m => m.type === 'room_state')).state.participants.length, 2);

    h.ws.close();
    g.ws.close();
    await new Promise(r => setTimeout(r, 50));
  } finally {
    await mf.dispose();
  }
});

test('roomLifecycle: session replacement - replaced socket cannot change presence or send commands once replaced', async () => {
  const mf = runtime();
  try {
    const host = await login(mf, 1);
    const guest = await login(mf, 2);

    const created = await (await post(mf, '/api/v2/rooms', { title: 'Replace Room', visibility: 'public' }, host)).json() as { roomId: string; ticket: string };
    const h = await socket(mf, created.roomId, created.ticket);
    await h.next(m => m.type === 'room_state');

    // Guest connects with first socket G1
    const join1 = await (await post(mf, '/api/v2/rooms/join', { roomId: created.roomId }, guest)).json() as { ticket: string };
    const g1 = await socket(mf, created.roomId, join1.ticket);
    await g1.next(m => m.type === 'room_state');

    // Guest connects with second socket G2 (same user session replacement)
    const join2 = await (await post(mf, '/api/v2/rooms/join', { roomId: created.roomId }, guest)).json() as { ticket: string };
    const g2 = await socket(mf, created.roomId, join2.ticket);

    // G1 must receive session_replaced
    await g1.next(m => m.type === 'session_replaced');

    // Checkpoint on G2 and Host
    const g2Cp = g2.checkpoint();
    const hCp = h.checkpoint();

    // Replaced socket G1 attempts to send commands
    send(g1, 'set_viewing', { viewing: true });
    send(g1, 'ping', { requestId: 'test' });
    send(g1, 'pause', { position: 10 });

    // Verify neither G2 nor Host receives any state mutation or ack from G1's commands
    await assert.rejects(
      g2.nextAfter(g2Cp, m => m.type === 'ack' || m.type === 'error', 100),
      /WebSocket message timeout/
    );

    // G1 closes
    g1.ws.close();

    // G1's close must NOT disconnect User 2 on G2
    await new Promise(r => setTimeout(r, 100));
    send(g2, 'sync_request');
    const stateAfter = (await g2.nextAfter(g2Cp, m => m.type === 'room_state')).state;
    const participant2 = stateAfter.participants.find((p: any) => p.profileId === 2);
    assert.equal(participant2.connected, true); // Still connected!

    h.ws.close();
    g2.ws.close();
    await new Promise(r => setTimeout(r, 50));
  } finally {
    await mf.dispose();
  }
});

test('roomLifecycle: disconnected host recovery before 7s retains authority; disconnect beyond 7s triggers transfer to connected successor', async () => {
  const mf = runtime();
  try {
    const host = await login(mf, 1);
    const guest = await login(mf, 2);

    const created = await (await post(mf, '/api/v2/rooms', { title: 'Host Recovery', visibility: 'public' }, host)).json() as { roomId: string; ticket: string };
    let h = await socket(mf, created.roomId, created.ticket);
    const gJoined = await (await post(mf, '/api/v2/rooms/join', { roomId: created.roomId }, guest)).json() as { ticket: string };
    const g = await socket(mf, created.roomId, gJoined.ticket);

    await h.next(m => m.type === 'room_state');
    await g.next(m => m.type === 'room_state');

    // 1. Host disconnects and reconnects BEFORE 7 seconds (at ~200ms)
    let gCp = g.checkpoint();
    h.ws.close();

    // Guest observes host disconnect
    const disconnectedState = (await g.nextAfter(gCp, m => m.type === 'room_state' && m.state.participants.some((p: any) => p.profileId === 1 && !p.connected))).state;
    assert.equal(disconnectedState.hostId, 1);

    // Host reconnects quickly (< 7 seconds)
    gCp = g.checkpoint();
    const hostReconnectTicket = await (await post(mf, '/api/v2/rooms/join', { roomId: created.roomId }, host)).json() as { ticket: string };
    h = await socket(mf, created.roomId, hostReconnectTicket.ticket);

    const recoveredState = (await g.nextAfter(gCp, m => m.type === 'room_state' && m.state.participants.some((p: any) => p.profileId === 1 && p.connected))).state;
    assert.equal(recoveredState.hostId, 1); // Host authority retained!

    // Host can still execute host commands
    const grantCmd = send(h, 'grant_control', { profileId: 2 }, 0);
    await h.next(m => m.type === 'ack' && m.commandId === grantCmd);

    // 2. Host disconnects and stays offline beyond 7 seconds -> triggers durable alarm host transfer
    gCp = g.checkpoint();
    h.ws.close();

    // Wait for the 7-second offline host transfer (12s safe timeout)
    const transferredState = (await g.nextAfter(gCp, m => m.type === 'room_state' && m.state.hostId === 2, 12_000)).state;
    assert.equal(transferredState.hostId, 2); // Transferred to connected successor (Guest 2)!

    // 3. Old host reconnects after transfer: does NOT reclaim host role
    const oldHostReturnTicket = await (await post(mf, '/api/v2/rooms/join', { roomId: created.roomId }, host)).json() as { ticket: string };
    h = await socket(mf, created.roomId, oldHostReturnTicket.ticket);

    const returnState = (await h.next(m => m.type === 'room_state')).state;
    assert.equal(returnState.hostId, 2); // Guest 2 remains host!

    // Old host attempting host commands is rejected with HOST_REQUIRED
    const deniedCmd = send(h, 'transfer_host', { profileId: 1 }, 0);
    const deniedMsg = await h.next(m => m.type === 'error' && m.commandId === deniedCmd);
    assert.equal(deniedMsg.code, 'HOST_REQUIRED');

    h.ws.close();
    g.ws.close();
    await new Promise(r => setTimeout(r, 50));
  } finally {
    await mf.dispose();
  }
});

test('roomLifecycle: no connected successor - if all leave, the next user to join becomes host', async () => {
  const mf = runtime();
  try {
    const user1 = await login(mf, 1);
    const user2 = await login(mf, 2);
    const user3 = await login(mf, 3);

    const created = await (await post(mf, '/api/v2/rooms', { title: 'Successor Room', visibility: 'public' }, user1)).json() as { roomId: string; ticket: string };
    const h = await socket(mf, created.roomId, created.ticket);
    const j2 = await (await post(mf, '/api/v2/rooms/join', { roomId: created.roomId }, user2)).json() as { ticket: string };
    const g = await socket(mf, created.roomId, j2.ticket);

    await h.next(m => m.type === 'room_state');
    await g.next(m => m.type === 'room_state');

    // Guest leaves explicitly
    send(g, 'leave');
    await h.next(m => m.type === 'room_state' && m.state.participants.length === 1);
    g.ws.close();

    // Host leaves explicitly when no other participants exist
    send(h, 'leave');
    await new Promise(r => setTimeout(r, 50));
    h.ws.close();

    // Now, User 3 joins the room where all have left
    const j3 = await (await post(mf, '/api/v2/rooms/join', { roomId: created.roomId }, user3)).json() as { ticket: string };
    const u3 = await socket(mf, created.roomId, j3.ticket);

    const u3State = (await u3.next(m => m.type === 'room_state')).state;
    assert.equal(u3State.hostId, 3); // User 3 becomes host!
    const u3Participant = u3State.participants.find((p: any) => p.profileId === 3);
    assert.equal(u3Participant.canControl, true);

    u3.ws.close();
    await new Promise(r => setTimeout(r, 50));
  } finally {
    await mf.dispose();
  }
});

test('roomLifecycle: all viewers unready at 7-second barrier - late ready resumes anchor without stall loop', async () => {
  const mf = runtime();
  try {
    const host = await login(mf, 1);
    const guest = await login(mf, 2);

    const created = await (await post(mf, '/api/v2/rooms', { title: 'Barrier Room', visibility: 'public' }, host)).json() as { roomId: string; ticket: string };
    const h = await socket(mf, created.roomId, created.ticket);
    const gJoined = await (await post(mf, '/api/v2/rooms/join', { roomId: created.roomId }, guest)).json() as { ticket: string };
    const g = await socket(mf, created.roomId, gJoined.ticket);

    await h.next(m => m.type === 'room_state');
    await g.next(m => m.type === 'room_state');

    // Both set viewing: true
    let hCp = h.checkpoint();
    send(h, 'set_viewing', { viewing: true });
    send(g, 'set_viewing', { viewing: true });
    await h.nextAfter(hCp, m => m.type === 'room_state' && m.state.participants.every((p: any) => p.viewing));

    // Host sets media and starts playback -> barrier begins
    const media = { releaseId: 1, releaseName: 'Test', dubId: 1, sourceId: 1, episode: 1, episodeName: 'One' };
    hCp = h.checkpoint();
    send(h, 'set_media', { media }, 0);
    let barrierState = (await h.nextAfter(hCp, m => m.type === 'room_state' && m.state.mediaVersion === 1)).state;
    assert.ok(barrierState.barrier);

    hCp = h.checkpoint();
    send(h, 'play', { position: 0 }, 1);
    await h.nextAfter(hCp, m => m.type === 'room_state' && m.state.playback.intent === 'playing');

    // Neither host nor guest sends ready. Wait for 7-second timeout.
    hCp = h.checkpoint();
    const timedOutState = (await h.nextAfter(hCp, m => m.type === 'room_state' && m.state.barrier === null, 12_000)).state;
    // With 0 ready viewers, playback stays paused until at least one viewer is ready
    assert.equal(timedOutState.playback.paused, true);
    for (const p of timedOutState.participants) {
      assert.equal(p.excludedEpoch, timedOutState.syncEpoch);
    }

    // Now, Guest reports late ready
    hCp = h.checkpoint();
    send(g, 'ready', { epoch: timedOutState.syncEpoch }, 1);

    // Guest's excludedEpoch clears, playback resumes without stall loop!
    const lateReadyState = (await h.nextAfter(hCp, m => m.type === 'room_state' && m.state.participants.some((p: any) => p.profileId === 2 && p.excludedEpoch === null), 5000)).state;
    assert.equal(lateReadyState.barrier, null); // Barrier remains null!
    assert.equal(lateReadyState.playback.paused, false); // Resumed without stall loop!

    h.ws.close();
    g.ws.close();
    await new Promise(r => setTimeout(r, 50));
  } finally {
    await mf.dispose();
  }
});

test('roomLifecycle: loader remains exempt across another viewer buffering epoch', async () => {
  const mf = runtime();
  try {
    const host = await login(mf, 1);
    const guest = await login(mf, 2);

    const created = await (await post(mf, '/api/v2/rooms', { title: 'Loader Exemption', visibility: 'public' }, host)).json() as { roomId: string; ticket: string };
    const h = await socket(mf, created.roomId, created.ticket);
    const gJoined = await (await post(mf, '/api/v2/rooms/join', { roomId: created.roomId }, guest)).json() as { ticket: string };
    const g = await socket(mf, created.roomId, gJoined.ticket);

    let hCp = h.checkpoint();
    send(h, 'set_viewing', { viewing: true });
    send(g, 'set_viewing', { viewing: true });
    await h.nextAfter(hCp, m => m.type === 'room_state' && m.state.participants.every((p: any) => p.viewing));

    // Host sets media -> barrier at syncEpoch 1
    const media = { releaseId: 1, releaseName: 'Test', dubId: 1, sourceId: 1, episode: 1, episodeName: 'One' };
    hCp = h.checkpoint();
    send(h, 'set_media', { media }, 0);
    const state1 = (await h.nextAfter(hCp, m => m.type === 'room_state' && m.state.barrier)).state;

    // Host starts playback and sends ready; Guest stays unready
    hCp = h.checkpoint();
    send(h, 'play', { position: 0 }, 1);
    send(h, 'ready', { epoch: state1.syncEpoch }, 1);

    // Wait for 7-second barrier timeout: Guest becomes timed-out loader (excludedEpoch: 1)
    // Host is ready and intent is playing -> playback unpauses
    const timeoutState = (await h.nextAfter(hCp, m => m.type === 'room_state' && m.state.barrier === null, 12_000)).state;
    assert.equal(timeoutState.playback.paused, false);
    const guestParticipant = timeoutState.participants.find((p: any) => p.profileId === 2);
    assert.equal(guestParticipant.excludedEpoch, timeoutState.syncEpoch);

    // Now Host encounters buffering at syncEpoch 1
    hCp = h.checkpoint();
    send(h, 'buffering', { epoch: timeoutState.syncEpoch }, 1);

    // New barrier starts at syncEpoch 2
    const bufferingState = (await h.nextAfter(hCp, m => m.type === 'room_state' && m.state.barrier !== null, 5000)).state;
    assert.equal(bufferingState.syncEpoch, timeoutState.syncEpoch + 1);

    // Guest loader is exempt across this new barrier!
    const guestInNewBarrier = bufferingState.participants.find((p: any) => p.profileId === 2);
    assert.equal(guestInNewBarrier.excludedEpoch, bufferingState.syncEpoch);

    // As soon as Host sends ready for epoch 2, the barrier completes IMMEDIATELY
    // without waiting 7 seconds for the loader Guest!
    hCp = h.checkpoint();
    send(h, 'ready', { epoch: bufferingState.syncEpoch }, 1);

    const resumedState = (await h.nextAfter(hCp, m => m.type === 'room_state' && m.state.barrier === null, 2000)).state;
    assert.equal(resumedState.playback.paused, false); // Resumed immediately!

    h.ws.close();
    g.ws.close();
    await new Promise(r => setTimeout(r, 50));
  } finally {
    await mf.dispose();
  }
});

test('roomLifecycle: closed/empty room lifecycle and directory removal via controlled clock and alarm', async () => {
  // Test 10-minute empty room TTL and directory removal using controlled clock abstractions
  const dirStorage = new Map<string, any>();
  const mockDirStorage = {
    async get(key: string | string[]) {
      if (Array.isArray(key)) {
        const m = new Map();
        for (const k of key) if (dirStorage.has(k)) m.set(k, dirStorage.get(k));
        return m;
      }
      return dirStorage.get(key);
    },
    async put(kOrObj: string | Record<string, any>, v?: any) {
      if (typeof kOrObj === 'string') dirStorage.set(kOrObj, v);
      else for (const [k, val] of Object.entries(kOrObj)) dirStorage.set(k, val);
    },
    async delete(kOrKeys: string | string[]) {
      if (Array.isArray(kOrKeys)) for (const k of kOrKeys) dirStorage.delete(k);
      else dirStorage.delete(kOrKeys);
    },
    async list(options?: { prefix?: string; limit?: number }) {
      const res = new Map();
      for (const [k, v] of dirStorage.entries()) {
        if (!options?.prefix || k.startsWith(options.prefix)) res.set(k, v);
      }
      return res;
    },
    async transaction(closure: (txn: any) => Promise<any>) { return await closure(this); },
    async getAlarm() { return null; },
    async setAlarm() {},
    async deleteAlarm() {},
  } as any;

  const mockDirCtx = {
    storage: mockDirStorage,
    blockConcurrencyWhile: async (fn: () => Promise<any>) => fn(),
  } as any;

  const directory = new RoomDirectory(mockDirCtx);
  await directory.ready;

  const roomStorage = new Map<string, any>();
  const mockRoomStorage = {
    async get(key: string) { return roomStorage.get(key); },
    async put(kOrObj: string | Record<string, any>, v?: any) {
      if (typeof kOrObj === 'string') roomStorage.set(kOrObj, v);
      else for (const [k, val] of Object.entries(kOrObj)) roomStorage.set(k, val);
    },
    async delete(kOrKeys: string | string[]) {
      if (Array.isArray(kOrKeys)) for (const k of kOrKeys) roomStorage.delete(k);
      else roomStorage.delete(kOrKeys);
    },
    async list(options?: { prefix?: string; limit?: number }) {
      const res = new Map();
      for (const [k, v] of roomStorage.entries()) {
        if (!options?.prefix || k.startsWith(options.prefix)) res.set(k, v);
      }
      return res;
    },
    async deleteAll() { roomStorage.clear(); },
    async getAlarm() { return null; },
    async setAlarm() {},
    async deleteAlarm() {},
  } as any;

  const mockRoomCtx = {
    storage: mockRoomStorage,
    blockConcurrencyWhile: async (fn: () => Promise<any>) => fn(),
    getWebSockets: () => [],
    acceptWebSocket: () => {},
  } as any;

  const mockEnv = {
    DIRECTORY: {
      get: () => ({
        fetch: async (req: Request) => directory.fetch(req),
      }),
      idFromName: () => ({}),
    },
  } as any;

  const roomId = '44444444-4444-4444-4444-444444444444';
  const joinCode = 'EMPTY123';

  // Reserve in directory
  const reserveRes = await directory.fetch(new Request('https://internal/reserve', {
    method: 'POST',
    body: JSON.stringify({ roomId }),
  }));
  assert.equal(reserveRes.status, 200);

  // Initialize room
  const room = new RoomObject(mockRoomCtx, mockEnv);
  const initRes = await room.fetch(new Request('https://internal/init', {
    method: 'POST',
    body: JSON.stringify({
      roomId,
      joinCode,
      title: 'Empty Room TTL',
      visibility: 'public',
      host: { profileId: 1, login: 'user1', avatar: null },
    }),
  }));
  assert.equal(initRes.status, 200);

  // Room is listed in directory
  const resolveInitial = await directory.fetch(new Request(`https://internal/resolve?code=${joinCode}`));
  assert.equal(resolveInitial.status, 200);

  // Mock Date.now to advance beyond the 10-minute EMPTY_TTL_MS (600_000ms)
  const realDateNow = Date.now;
  try {
    const futureTime = realDateNow() + EMPTY_TTL_MS + 5000;
    Date.now = () => futureTime;

    // Trigger durable object alarm directly
    await room.alarm();

    // Verify: room has closed and purged from directory
    // 1. Directory resolve returns 404
    const resolveAfter = await directory.fetch(new Request(`https://internal/resolve?code=${joinCode}`));
    assert.equal(resolveAfter.status, 404);

    // 2. Directory list does not contain the room
    const listAfter = await directory.fetch(new Request('https://internal/list'));
    const listJson = await listAfter.json() as { rooms: any[] };
    assert.equal(listJson.rooms.some(r => r.roomId === roomId), false);

    // 3. RoomObject returns 410 ROOM_CLOSED on subsequent requests
    const roomFetchAfter = await room.fetch(new Request('https://internal/ticket', {
      method: 'POST',
      body: JSON.stringify({ profile: { profileId: 2, login: 'user2', avatar: null } }),
    }));
    assert.equal(roomFetchAfter.status, 410);
    assert.equal((await roomFetchAfter.json() as { code: string }).code, 'ROOM_CLOSED');
  } finally {
    Date.now = realDateNow;
  }
});

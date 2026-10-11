import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ANIXART_APP_USER_AGENT } from '../src/userAgent.ts';
import { RoomObject } from '../src/objects.ts';

const origin = 'http://localhost:5173';
const secret = 'integration-secret-at-least-thirty-two-characters';
const bundle = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

async function signSessionToken(profile: { profileId: number; login: string; avatar: string | null }, secretKey: string, expiresAt: number) {
  const payload = encode(new TextEncoder().encode(JSON.stringify({ profile, expiresAt })));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
  return `${payload}.${signature}`;
}

function runtime(sessionSecret = secret, allowedOrigin = origin) {
  return new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-07',
    bindings: { SESSION_SECRET: sessionSecret, ALLOWED_ORIGINS: allowedOrigin },
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
          profile: { id: Number(token), login: token === '4' ? '   ' : `user${token}`, avatar: token === '3' ? '' : null },
        });
      },
    },
  }));
}

function post(mf: Miniflare, path: string, body: unknown, session?: string, customOrigin = origin) {
  return mf.dispatchFetch(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Origin: customOrigin,
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

async function socket(mf: Miniflare, roomId: string, ticket: string, wsOrigin = origin) {
  const response = await mf.dispatchFetch(`http://localhost/api/v2/rooms/${roomId}/ws?ticket=${ticket}`, {
    headers: { Origin: wsOrigin, Upgrade: 'websocket' },
  });
  if (response.status !== 101) return { status: response.status, response };
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
  const next = (predicate: (m: any) => boolean, timeout = 4000) => new Promise((resolve, reject) => {
    const existing = messages.find(predicate);
    if (existing) { resolve(existing); return; }
    const timer = setTimeout(() => reject(new Error('WebSocket timeout')), timeout);
    const waiter = (msg: any) => {
      if (predicate(msg)) {
        clearTimeout(timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        resolve(msg);
      }
    };
    waiters.push(waiter);
  });
  return { status: 101, ws, messages, next };
}

test('auth: replayed tickets within 30s window and invalid tickets are rejected with 401 INVALID_TICKET', async () => {
  const mf = runtime();
  try {
    const host = await login(mf, 1);
    const guest = await login(mf, 2);

    const created = await post(mf, '/api/v2/rooms', { title: 'Auth Ticket Room', visibility: 'public' }, host);
    assert.equal(created.status, 200);
    const { roomId, ticket: hostTicket } = await created.json() as { roomId: string; ticket: string };

    // 1. Host connects with valid ticket -> 101
    const h = await socket(mf, roomId, hostTicket);
    assert.equal(h.status, 101);
    await h.next!(m => m.type === 'room_state');

    // 2. Replaying the host ticket within the 30s window must fail with 401 INVALID_TICKET
    const replayHost = await socket(mf, roomId, hostTicket);
    assert.equal(replayHost.status, 401);

    // 3. Guest joins and gets guest ticket
    const joinRes = await post(mf, '/api/v2/rooms/join', { roomId }, guest);
    assert.equal(joinRes.status, 200);
    const { ticket: guestTicket } = await joinRes.json() as { ticket: string };

    const g = await socket(mf, roomId, guestTicket);
    assert.equal(g.status, 101);
    await g.next!(m => m.type === 'room_state');

    // 4. Replay guest ticket -> 401 INVALID_TICKET
    const replayGuest = await socket(mf, roomId, guestTicket);
    assert.equal(replayGuest.status, 401);

    // 5. Missing ticket parameter -> 401 INVALID_TICKET
    const missingTicketRes = await mf.dispatchFetch(`http://localhost/api/v2/rooms/${roomId}/ws`, {
      headers: { Origin: origin, Upgrade: 'websocket' },
    });
    assert.equal(missingTicketRes.status, 401);

    // 6. Malformed ticket format (not a 36-char UUID) -> 401 INVALID_TICKET
    const malformedTicketRes = await mf.dispatchFetch(`http://localhost/api/v2/rooms/${roomId}/ws?ticket=not-a-valid-uuid`, {
      headers: { Origin: origin, Upgrade: 'websocket' },
    });
    assert.equal(malformedTicketRes.status, 401);

    // 7. Non-existent UUID ticket -> 401 INVALID_TICKET
    const fakeUuid = '00000000-0000-0000-0000-000000000000';
    const nonExistentTicketRes = await mf.dispatchFetch(`http://localhost/api/v2/rooms/${roomId}/ws?ticket=${fakeUuid}`, {
      headers: { Origin: origin, Upgrade: 'websocket' },
    });
    assert.equal(nonExistentTicketRes.status, 401);

    h.ws!.close();
    g.ws!.close();
    await new Promise(r => setTimeout(r, 50));
  } finally {
    await mf.dispose();
  }
});

test('auth: expired tickets are rejected with 401 INVALID_TICKET and pruned on alarm', async () => {
  const data = new Map<string, any>();
  const mockStorage = {
    async get(key: string) { return data.get(key); },
    async put(keyOrObj: string | Record<string, any>, val?: any) {
      if (typeof keyOrObj === 'string') data.set(keyOrObj, val);
      else for (const [k, v] of Object.entries(keyOrObj)) data.set(k, v);
    },
    async delete(keyOrKeys: string | string[]) {
      if (Array.isArray(keyOrKeys)) for (const k of keyOrKeys) data.delete(k);
      else data.delete(keyOrKeys);
    },
    async list(options?: { prefix?: string; limit?: number }) {
      const res = new Map<string, any>();
      for (const [k, v] of data.entries()) {
        if (!options?.prefix || k.startsWith(options.prefix)) res.set(k, v);
      }
      return res;
    },
    async getAlarm() { return null; },
    async setAlarm() {},
    async deleteAlarm() {},
    async deleteAll() { data.clear(); },
  } as any;

  const mockCtx = {
    storage: mockStorage,
    blockConcurrencyWhile: async (fn: () => Promise<any>) => fn(),
    getWebSockets: () => [],
    acceptWebSocket: () => {},
  } as any;

  const mockEnv = {
    DIRECTORY: {
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ ok: true })),
      }),
      idFromName: () => ({}),
    },
  } as any;

  const room = new RoomObject(mockCtx, mockEnv);

  // Initialize room
  const initRes = await room.fetch(new Request('https://internal/init', {
    method: 'POST',
    body: JSON.stringify({
      roomId: '11111111-1111-1111-1111-111111111111',
      joinCode: 'TEST1234',
      title: 'Room',
      visibility: 'public',
      host: { profileId: 1, login: 'user1', avatar: null },
    }),
  }));
  assert.equal(initRes.status, 200);

  // Manually store an expired ticket (expiresAt 5 seconds in the past)
  const expiredTicketId = '22222222-2222-2222-2222-222222222222';
  data.set(`ticket:${expiredTicketId}`, {
    profile: { profileId: 2, login: 'user2', avatar: null },
    expiresAt: Date.now() - 5000,
  });

  // Attempting to connect with expired ticket must return 401 INVALID_TICKET
  const wsRes = await room.fetch(new Request(`https://internal/ws?ticket=${expiredTicketId}`, {
    headers: { Upgrade: 'websocket' },
  }));
  assert.equal(wsRes.status, 401);
  const json = await wsRes.json() as { code: string };
  assert.equal(json.code, 'INVALID_TICKET');

  // Add another expired ticket and verify alarm prunes it
  const secondExpiredTicketId = '33333333-3333-3333-3333-333333333333';
  data.set(`ticket:${secondExpiredTicketId}`, {
    profile: { profileId: 3, login: 'user3', avatar: null },
    expiresAt: Date.now() - 10000,
  });
  assert.ok(data.has(`ticket:${secondExpiredTicketId}`));

  await room.alarm();
  assert.equal(data.has(`ticket:${secondExpiredTicketId}`), false);
});

test('auth: forbidden or missing Origin is rejected with 403 ORIGIN_FORBIDDEN on tickets and authenticated endpoints', async () => {
  const mf = runtime();
  try {
    const host = await login(mf, 1);
    const evilOrigin = 'https://malicious.evil.com';

    // 1. Denied Origin on POST /api/v2/rooms
    const evilCreate = await post(mf, '/api/v2/rooms', { title: 'Evil Room', visibility: 'public' }, host, evilOrigin);
    assert.equal(evilCreate.status, 403);
    assert.equal((await evilCreate.json() as { code: string }).code, 'ORIGIN_FORBIDDEN');

    // 2. Denied Origin on POST /api/v2/rooms/join
    const evilJoin = await post(mf, '/api/v2/rooms/join', { roomId: '00000000-0000-0000-0000-000000000000' }, host, evilOrigin);
    assert.equal(evilJoin.status, 403);
    assert.equal((await evilJoin.json() as { code: string }).code, 'ORIGIN_FORBIDDEN');

    // 3. Denied Origin on GET /api/v2/user/settings
    const evilGetSettings = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      headers: { Origin: evilOrigin, Authorization: `Bearer ${host}` },
    });
    assert.equal(evilGetSettings.status, 403);
    assert.equal((await evilGetSettings.json() as { code: string }).code, 'ORIGIN_FORBIDDEN');

    // 4. Denied Origin on POST /api/v2/user/settings
    const evilPostSettings = await post(mf, '/api/v2/user/settings', { theme: 'dark' }, host, evilOrigin);
    assert.equal(evilPostSettings.status, 403);
    assert.equal((await evilPostSettings.json() as { code: string }).code, 'ORIGIN_FORBIDDEN');

    // 5. Denied Origin on session login
    const evilSession = await post(mf, '/api/v2/session', { token: '1' }, undefined, evilOrigin);
    assert.equal(evilSession.status, 403);
    assert.equal((await evilSession.json() as { code: string }).code, 'ORIGIN_FORBIDDEN');

    // 6. Denied Origin on rooms list
    const evilRooms = await mf.dispatchFetch('http://localhost/api/v2/rooms', {
      headers: { Origin: evilOrigin },
    });
    assert.equal(evilRooms.status, 403);
    assert.equal((await evilRooms.json() as { code: string }).code, 'ORIGIN_FORBIDDEN');
  } finally {
    await mf.dispose();
  }
});

test('auth: signed session expiration, corruption, and signature tampering', async () => {
  const mf = runtime();
  try {
    const validSession = await login(mf, 1);
    const [validPayload, validSig] = validSession.split('.');

    // 1. Expired session token
    const pastTime = Date.now() - 1000;
    const expiredSession = await signSessionToken({ profileId: 1, login: 'user1', avatar: null }, secret, pastTime);
    const expiredRes = await post(mf, '/api/v2/rooms', { title: 'Room', visibility: 'public' }, expiredSession);
    assert.equal(expiredRes.status, 401);
    assert.equal((await expiredRes.json() as { code: string }).code, 'SESSION_INVALID');

    // 2. Change significant bits: the last base64url character also contains
    // padding bits, so changing only that character may decode to the same bytes.
    const tamperedSig = (validSig.startsWith('A') ? 'B' : 'A') + validSig.slice(1);
    const tamperedRes = await post(mf, '/api/v2/rooms', { title: 'Room', visibility: 'public' }, `${validPayload}.${tamperedSig}`);
    assert.equal(tamperedRes.status, 401);
    assert.equal((await tamperedRes.json() as { code: string }).code, 'SESSION_INVALID');

    // 3. Corrupted payload: invalid base64
    const corruptBase64Res = await post(mf, '/api/v2/rooms', { title: 'Room', visibility: 'public' }, `!!!notbase64.${validSig}`);
    assert.equal(corruptBase64Res.status, 401);
    assert.equal((await corruptBase64Res.json() as { code: string }).code, 'SESSION_INVALID');

    // 4. Malformed payload JSON: non-object or missing profile fields
    const badPayload1 = encode(new TextEncoder().encode(JSON.stringify({ expiresAt: Date.now() + 900_000, profile: null })));
    const badPayloadRes1 = await post(mf, '/api/v2/rooms', { title: 'Room', visibility: 'public' }, `${badPayload1}.${validSig}`);
    assert.equal(badPayloadRes1.status, 401);
    assert.equal((await badPayloadRes1.json() as { code: string }).code, 'SESSION_INVALID');

    // 5. Malformed profileId: non-integer / negative
    const badPayload2 = encode(new TextEncoder().encode(JSON.stringify({ expiresAt: Date.now() + 900_000, profile: { profileId: -5, login: 'bad' } })));
    const badPayloadRes2 = await post(mf, '/api/v2/rooms', { title: 'Room', visibility: 'public' }, `${badPayload2}.${validSig}`);
    assert.equal(badPayloadRes2.status, 401);
    assert.equal((await badPayloadRes2.json() as { code: string }).code, 'SESSION_INVALID');

    // 6. Token signed with wrong secret
    const otherSecretSession = await signSessionToken({ profileId: 1, login: 'user1', avatar: null }, 'different-secret-thirty-two-chars-long', Date.now() + 900_000);
    const wrongSecretRes = await post(mf, '/api/v2/rooms', { title: 'Room', visibility: 'public' }, otherSecretSession);
    assert.equal(wrongSecretRes.status, 401);
    assert.equal((await wrongSecretRes.json() as { code: string }).code, 'SESSION_INVALID');

    // 7. Extra dot segment (extra parts)
    const extraSegmentRes = await post(mf, '/api/v2/rooms', { title: 'Room', visibility: 'public' }, `${validSession}.extra`);
    assert.equal(extraSegmentRes.status, 401);
    assert.equal((await extraSegmentRes.json() as { code: string }).code, 'SESSION_INVALID');

    // 8. Missing Authorization header -> 401 SESSION_REQUIRED
    const missingAuthRes = await post(mf, '/api/v2/rooms', { title: 'Room', visibility: 'public' });
    assert.equal(missingAuthRes.status, 401);
    assert.equal((await missingAuthRes.json() as { code: string }).code, 'SESSION_REQUIRED');

    // 9. Oversized token (> 5000 characters) -> 401 SESSION_REQUIRED
    const oversizedRes = await post(mf, '/api/v2/rooms', { title: 'Room', visibility: 'public' }, 'x'.repeat(5001));
    assert.equal(oversizedRes.status, 401);
    assert.equal((await oversizedRes.json() as { code: string }).code, 'SESSION_REQUIRED');
  } finally {
    await mf.dispose();
  }
});

test('auth: profile spoofing denied - user identity is strictly bound to session token', async () => {
  const mf = runtime();
  try {
    const user1Session = await login(mf, 1);
    const user2Session = await login(mf, 2);

    // 1. User 1 creates room trying to spoof host as User 2 in request payload
    const createRes = await post(mf, '/api/v2/rooms', {
      title: 'Spoof Room',
      visibility: 'public',
      hostId: 2,
      profile: { profileId: 2, login: 'user2' },
    }, user1Session);
    assert.equal(createRes.status, 200);
    const { roomId, ticket } = await createRes.json() as { roomId: string; ticket: string };

    // Verify room state created host is strictly user 1 (from session), not spoofed user 2
    const h = await socket(mf, roomId, ticket);
    assert.equal(h.status, 101);
    const stateMsg = await h.next!(m => m.type === 'room_state');
    assert.equal(stateMsg.state.hostId, 1); // Strictly 1!
    assert.equal(stateMsg.state.participants[0].profileId, 1);
    h.ws!.close();
    await new Promise(r => setTimeout(r, 50));

    // 2. User 1 tries to save settings posing as user 2 in body
    const saveRes = await post(mf, '/api/v2/user/settings', {
      profileId: 2,
      theme: 'evil-spoof',
      volume: 100,
    }, user1Session);
    assert.equal(saveRes.status, 200);

    // User 2 fetches settings: must NOT have user 1's spoofed payload
    const user2Get = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      headers: { Origin: origin, Authorization: `Bearer ${user2Session}` },
    });
    assert.equal(user2Get.status, 404); // User 2 has no settings saved!

    // User 1 fetches settings: stored under User 1
    const user1Get = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      headers: { Origin: origin, Authorization: `Bearer ${user1Session}` },
    });
    assert.equal(user1Get.status, 200);
    const user1Data = await user1Get.json() as { ok: boolean; settings: any };
    assert.equal(user1Data.settings.theme, 'evil-spoof');
  } finally {
    await mf.dispose();
  }
});

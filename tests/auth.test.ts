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
        const url = new URL(request.url);
        const path = url.pathname;
        const token = url.searchParams.get('token');
        if (token === 'outage') return new Response('unavailable', { status: 503 });
        if (token === 'http401') return new Response('unauthorized', { status: 401 });
        if (token === 'json401') return Response.json({ code: 401 });
        if (token === 'upstream_err') return Response.json({ code: 500 });
        if (token === 'malformed_json') return new Response('{bad json', { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (path === '/profile/info') {
          // Realistic production info-only response lacking identity/login/id fields
          return Response.json({
            code: 0,
            channel_id: null,
            privilege_level: 0,
            rating_score: 0,
            sponsorship_expires: 0,
            is_perm_banned: false,
            is_sponsor: false,
          });
        }
        const profileId = Number(path.replace('/profile/', ''));
        const isOwner = token === String(profileId);
        return Response.json({
          code: 0,
          is_my_profile: isOwner,
          profile: { id: profileId, login: profileId === 4 ? '   ' : `user${profileId}`, avatar: profileId === 3 ? '' : null },
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
  const profileId = Number(id);
  const response = await post(mf, '/api/v2/session', { token: String(id), profileId: Number.isSafeInteger(profileId) && profileId > 0 ? profileId : 1 });
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
    const evilSession = await post(mf, '/api/v2/session', { token: '1', profileId: 1 }, undefined, evilOrigin);
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

test('auth: candidate profileId validation, ownership verification, and rejection contract', async () => {
  const mf = runtime();
  try {
    // 1. Missing profileId in /api/v2/session -> 400 INVALID_PROFILE_ID
    const missingProfileId = await post(mf, '/api/v2/session', { token: '1' });
    assert.equal(missingProfileId.status, 400);
    assert.equal((await missingProfileId.json() as { code: string }).code, 'INVALID_PROFILE_ID');

    // 2. Non-integer or negative profileId -> 400 INVALID_PROFILE_ID
    for (const badId of ['1', -5, 0, 1.5, NaN, null, {}]) {
      const badRes = await post(mf, '/api/v2/session', { token: '1', profileId: badId });
      assert.equal(badRes.status, 400);
      assert.equal((await badRes.json() as { code: string }).code, 'INVALID_PROFILE_ID');
    }

    // 3. User with valid token "1" targets another user profileId 2:
    // Upstream returns public profile code 0, but is_my_profile is false.
    // Server MUST reject with 401 AUTH_REJECTED.
    const targetingOtherId = await post(mf, '/api/v2/session', { token: '1', profileId: 2 });
    assert.equal(targetingOtherId.status, 401);
    assert.equal((await targetingOtherId.json() as { code: string }).code, 'AUTH_REJECTED');

    // 4. Upstream returns HTTP 200 with JSON { code: 401 } (synthetic invalid token)
    // Server MUST classify as 401 AUTH_REJECTED, NOT 503 AUTH_UNAVAILABLE!
    const json401Res = await post(mf, '/api/v2/session', { token: 'json401', profileId: 1 });
    assert.equal(json401Res.status, 401);
    assert.equal((await json401Res.json() as { code: string }).code, 'AUTH_REJECTED');

    // 5. Upstream returns HTTP 401 status
    // Server MUST classify as 401 AUTH_REJECTED.
    const http401Res = await post(mf, '/api/v2/session', { token: 'http401', profileId: 1 });
    assert.equal(http401Res.status, 401);
    assert.equal((await http401Res.json() as { code: string }).code, 'AUTH_REJECTED');

    // 6. Genuine upstream outage (HTTP 503) returns 503 AUTH_UNAVAILABLE
    const outageRes = await post(mf, '/api/v2/session', { token: 'outage', profileId: 1 });
    assert.equal(outageRes.status, 503);
    assert.equal((await outageRes.json() as { code: string }).code, 'AUTH_UNAVAILABLE');

    // 7. Upstream internal server error code (e.g. code 500) returns 503 AUTH_UNAVAILABLE
    const upstreamErrRes = await post(mf, '/api/v2/session', { token: 'upstream_err', profileId: 1 });
    assert.equal(upstreamErrRes.status, 503);
    assert.equal((await upstreamErrRes.json() as { code: string }).code, 'AUTH_UNAVAILABLE');

    // 8. Malformed upstream JSON returns 503 AUTH_UNAVAILABLE
    const malformedJsonRes = await post(mf, '/api/v2/session', { token: 'malformed_json', profileId: 1 });
    assert.equal(malformedJsonRes.status, 503);
    assert.equal((await malformedJsonRes.json() as { code: string }).code, 'AUTH_UNAVAILABLE');
  } finally {
    await mf.dispose();
  }
});

test('auth: realistic info-only upstream regression and mismatched profile ID rejection', async () => {
  // Test runtime with custom service bindings modeling info-only and mismatched profile ID
  const mfInfo = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-07',
    bindings: { SESSION_SECRET: secret, ALLOWED_ORIGINS: origin },
    durableObjects: {
      ROOMS: { className: 'RoomObject', useSQLite: true },
      DIRECTORY: { className: 'RoomDirectory', useSQLite: true },
    },
    serviceBindings: {
      ANIXART_TEST: async () => {
        // Realistic /profile/info response that has no profile identity/login
        return Response.json({
          code: 0,
          channel_id: 12345,
          privilege_level: 1,
          rating_score: 100,
          sponsorship_expires: 0,
          is_perm_banned: false,
          is_sponsor: false,
        });
      },
    },
  }));
  try {
    // Production /profile/info response lacks ownership flag (is_my_profile is missing/undefined)
    // Per contract: Missing/false ownership => 401 AUTH_REJECTED.
    const infoRes = await post(mfInfo, '/api/v2/session', { token: 'my-token', profileId: 10 });
    assert.equal(infoRes.status, 401);
    assert.equal((await infoRes.json() as { code: string }).code, 'AUTH_REJECTED');
  } finally {
    await mfInfo.dispose();
  }

  // Test upstream returning bad shape (is_my_profile true but missing profile object) -> 503 AUTH_UNAVAILABLE
  const mfBadShape = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-07',
    bindings: { SESSION_SECRET: secret, ALLOWED_ORIGINS: origin },
    durableObjects: {
      ROOMS: { className: 'RoomObject', useSQLite: true },
      DIRECTORY: { className: 'RoomDirectory', useSQLite: true },
    },
    serviceBindings: {
      ANIXART_TEST: async () => {
        return Response.json({
          code: 0,
          is_my_profile: true,
          profile: null,
        });
      },
    },
  }));
  try {
    const badShapeRes = await post(mfBadShape, '/api/v2/session', { token: 'my-token', profileId: 10 });
    assert.equal(badShapeRes.status, 503);
    assert.equal((await badShapeRes.json() as { code: string }).code, 'AUTH_UNAVAILABLE');
  } finally {
    await mfBadShape.dispose();
  }

  // Test upstream returning profile with mismatched ID even if is_my_profile is true
  const mfMismatch = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-07',
    bindings: { SESSION_SECRET: secret, ALLOWED_ORIGINS: origin },
    durableObjects: {
      ROOMS: { className: 'RoomObject', useSQLite: true },
      DIRECTORY: { className: 'RoomDirectory', useSQLite: true },
    },
    serviceBindings: {
      ANIXART_TEST: async () => {
        return Response.json({
          code: 0,
          is_my_profile: true,
          profile: { id: 999, login: 'user999', avatar: null }, // Mismatched from candidateId 10
        });
      },
    },
  }));
  try {
    const mismatchRes = await post(mfMismatch, '/api/v2/session', { token: 'my-token', profileId: 10 });
    assert.equal(mismatchRes.status, 401);
    assert.equal((await mismatchRes.json() as { code: string }).code, 'AUTH_REJECTED');
  } finally {
    await mfMismatch.dispose();
  }
});

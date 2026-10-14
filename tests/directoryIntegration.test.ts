import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { RoomDirectory } from '../src/objects.ts';
import { ANIXART_APP_USER_AGENT } from '../src/userAgent.ts';
import type { PublicRoom, WatchRoomState } from '../protocol/index.ts';

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
        const url = new URL(request.url);
        const path = url.pathname;
        const token = url.searchParams.get('token');
        if (token === 'outage') return new Response('unavailable', { status: 503 });
        const profileId = Number(path.replace('/profile/', ''));
        const isOwner = token === String(profileId);
        return Response.json({
          code: 0,
          is_my_profile: isOwner,
          profile: { id: profileId, login: `user${profileId}`, avatar: null },
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
  const profileId = Number(id);
  const response = await post(mf, '/api/v2/session', { token: String(id), profileId: Number.isSafeInteger(profileId) && profileId > 0 ? profileId : 1 });
  assert.equal(response.status, 200);
  return (await response.json() as { session: string }).session;
}

function createMockDirectoryState(initialData = new Map<string, any>()) {
  const data = new Map<string, any>(initialData);
  let alarmTime: number | null = null;
  const storage = {
    async get(keyOrKeys: string | string[]) {
      if (Array.isArray(keyOrKeys)) {
        const map = new Map<string, any>();
        for (const k of keyOrKeys) if (data.has(k)) map.set(k, structuredClone(data.get(k)));
        return map;
      }
      return data.has(keyOrKeys) ? structuredClone(data.get(keyOrKeys)) : undefined;
    },
    async put(keyOrObj: string | Record<string, any>, val?: any) {
      if (typeof keyOrObj === 'string') data.set(keyOrObj, structuredClone(val));
      else for (const [k, v] of Object.entries(keyOrObj)) data.set(k, structuredClone(v));
    },
    async delete(keyOrKeys: string | string[]) {
      if (Array.isArray(keyOrKeys)) {
        let count = 0;
        for (const k of keyOrKeys) if (data.delete(k)) count++;
        return count;
      }
      return data.delete(keyOrKeys);
    },
    async list(options?: { prefix?: string; limit?: number; startAfter?: string }) {
      assert.ok(options?.limit && options.limit > 0);
      const sorted = Array.from(data.keys()).sort();
      const res = new Map<string, any>();
      for (const k of sorted) {
        if (options.prefix && !k.startsWith(options.prefix)) continue;
        if (options.startAfter && k <= options.startAfter) continue;
        res.set(k, structuredClone(data.get(k)));
        if (res.size >= options.limit) break;
      }
      return res;
    },
    async transaction(closure: (txn: any) => Promise<any>) { return await closure(this); },
    async getAlarm() { return alarmTime; },
    async setAlarm(time: number) { alarmTime = time; },
    async deleteAlarm() { alarmTime = null; },
    async deleteAll() { data.clear(); alarmTime = null; },
  };

  const ctx = {
    storage,
    blockConcurrencyWhile: async (fn: () => Promise<any>) => fn(),
  } as any;

  return { ctx, storage, rawData: data };
}

function makeUuid(idx: number): string {
  return `00000000-0000-0000-0000-${String(idx).padStart(12, '0')}`;
}

test('directoryIntegration: real worker public vs private room filtering and cursor pagination', async () => {
  const mf = runtime();
  try {
    const host = await login(mf, 1);

    // 1. Initially empty directory
    const emptyList = await (await mf.dispatchFetch('http://localhost/api/v2/rooms', { headers: { Origin: origin } })).json() as { rooms: any[]; cursor: string | null };
    assert.deepEqual(emptyList.rooms, []);
    assert.equal(emptyList.cursor, null);

    // 2. Create private room
    const privRes = await post(mf, '/api/v2/rooms', { title: 'Private Party', visibility: 'private' }, host);
    assert.equal(privRes.status, 200);

    // Directory list MUST still be empty (private room filtered out)
    const afterPriv = await (await mf.dispatchFetch('http://localhost/api/v2/rooms', { headers: { Origin: origin } })).json() as { rooms: any[] };
    assert.deepEqual(afterPriv.rooms, []);

    // 3. Create public room
    const pubRes = await post(mf, '/api/v2/rooms', { title: 'Public Party', visibility: 'public' }, host);
    assert.equal(pubRes.status, 200);
    const { roomId: pubRoomId } = await pubRes.json() as { roomId: string };

    // Directory list now includes public room
    const afterPub = await (await mf.dispatchFetch('http://localhost/api/v2/rooms', { headers: { Origin: origin } })).json() as { rooms: any[] };
    assert.equal(afterPub.rooms.length, 1);
    assert.equal(afterPub.rooms[0].roomId, pubRoomId);
    assert.equal(afterPub.rooms[0].title, 'Public Party');

    // 4. Invalid cursor returns 400 INVALID_CURSOR
    const badCursorRes = await mf.dispatchFetch('http://localhost/api/v2/rooms?cursor=not-a-uuid', { headers: { Origin: origin } });
    assert.equal(badCursorRes.status, 400);
    assert.equal((await badCursorRes.json() as { code: string }).code, 'INVALID_CURSOR');
  } finally {
    await mf.dispose();
  }
});

test('directoryIntegration: batch migration across multiple stages (rooms, limits, done)', async () => {
  const initialData = new Map<string, any>();
  const totalRooms = 150; // Requires 2 batches of 100
  const totalLimits = 120; // Requires 2 batches of 100

  // Seed legacy unindexed rooms
  for (let i = 1; i <= totalRooms; i++) {
    const roomId = makeUuid(i);
    const isPublic = i % 2 === 0;
    initialData.set(`room:${roomId}`, {
      roomId,
      code: `CODE${String(i).padStart(4, '0')}`,
      expiresAt: Number.MAX_SAFE_INTEGER,
      room: isPublic ? { roomId, title: `Room ${i}`, hostId: i, media: null, participants: 1 } : null,
    });
  }

  // Seed legacy limits
  for (let i = 1; i <= totalLimits; i++) {
    initialData.set(`limit:key-${i}`, {
      count: 1,
      until: Date.now() + 60_000,
    });
  }

  const { ctx, storage, rawData } = createMockDirectoryState(initialData);
  const directory = new RoomDirectory(ctx);
  await directory.ready;

  // Initial state: not migrated yet
  assert.equal(directory.isMigrated, false);

  // Calling /list while unmigrated returns 503 DIRECTORY_MIGRATING
  const migratingRes = await directory.fetch(new Request('https://internal/list'));
  assert.equal(migratingRes.status, 503);
  assert.equal((await migratingRes.json() as { code: string }).code, 'DIRECTORY_MIGRATING');

  // Step 1: migrates first 100 rooms
  const done1 = await directory.stepMigration();
  assert.equal(done1, false);
  const meta1 = await storage.get('meta:migration');
  assert.equal(meta1.stage, 'rooms');
  assert.ok(meta1.cursor);

  // Step 2: migrates remaining 50 rooms, transitions to limits
  const done2 = await directory.stepMigration();
  assert.equal(done2, false);
  const meta2 = await storage.get('meta:migration');
  assert.equal(meta2.stage, 'limits');

  // Step 3: migrates first 100 limits
  const done3 = await directory.stepMigration();
  assert.equal(done3, false);
  const meta3 = await storage.get('meta:migration');
  assert.equal(meta3.stage, 'limits');
  assert.ok(meta3.cursor);

  // Step 4: migrates remaining 20 limits, completes migration
  const done4 = await directory.stepMigration();
  assert.equal(done4, true);
  assert.equal(directory.isMigrated, true);

  const metaFinal = await storage.get('meta:migration');
  assert.deepEqual(metaFinal, { stage: 'done' });

  // Verify all public rooms were indexed with public: prefix
  const publicKeys = Array.from(rawData.keys()).filter(k => k.startsWith('public:'));
  assert.equal(publicKeys.length, totalRooms / 2); // 75 public rooms

  // Now /list works and returns 200 with cursor pagination
  const listRes = await directory.fetch(new Request('https://internal/list'));
  assert.equal(listRes.status, 200);
  const listJson = await listRes.json() as { rooms: PublicRoom[]; cursor: string | null };
  assert.equal(listJson.rooms.length, 20); // First page of 20
  assert.ok(listJson.cursor); // Has next cursor
});

test('directoryIntegration: concurrent updates and deletions between migration batches do not revive deleted rooms', async () => {
  const initialData = new Map<string, any>();
  // Seed 50 rooms
  for (let i = 1; i <= 50; i++) {
    const roomId = makeUuid(i);
    initialData.set(`room:${roomId}`, {
      roomId,
      code: `CODE${String(i).padStart(4, '0')}`,
      expiresAt: Number.MAX_SAFE_INTEGER,
      room: { roomId, title: `Room ${i}`, hostId: i, media: null, participants: 1 },
    });
  }

  const { ctx, storage, rawData } = createMockDirectoryState(initialData);
  const directory = new RoomDirectory(ctx);
  await directory.ready;

  // Delete Room 10 and Room 20 concurrently via /remove before/during migration
  const deleteRes1 = await directory.fetch(new Request('https://internal/remove', {
    method: 'POST',
    body: JSON.stringify({ roomId: makeUuid(10), code: 'CODE0010' }),
  }));
  assert.equal(deleteRes1.status, 200);

  // Update Room 5 to become private concurrently
  const privState: WatchRoomState = {
    roomId: makeUuid(5),
    joinCode: 'CODE0005',
    title: 'Room 5 Private',
    visibility: 'private',
    hostId: 5,
    media: null,
    participants: [],
    playback: { intent: 'paused', position: 0, paused: true, rate: 1, updatedAt: Date.now() },
    syncEpoch: 0,
    mediaVersion: 0,
    revision: 1,
    closed: false,
    barrier: null,
    emptySince: null,
  };
  const updatePrivRes = await directory.fetch(new Request('https://internal/update', {
    method: 'POST',
    body: JSON.stringify({ state: privState }),
  }));
  assert.equal(updatePrivRes.status, 200);

  // Run migration steps to completion
  while (!directory.isMigrated) {
    await directory.stepMigration();
  }
  assert.equal(directory.isMigrated, true);

  // Verify: deleted room 10 was NOT resurrected
  assert.equal(rawData.has(`room:${makeUuid(10)}`), false);
  assert.equal(rawData.has(`public:${makeUuid(10)}`), false);
  assert.equal(rawData.has('code:CODE0010'), false);

  // Verify: room 5 was NOT indexed as public
  assert.equal(rawData.has(`public:${makeUuid(5)}`), false);

  // Verify /list does not contain room 10 or room 5
  const listRes = await directory.fetch(new Request('https://internal/list'));
  assert.equal(listRes.status, 200);
  const body = await listRes.json() as { rooms: PublicRoom[] };
  assert.equal(body.rooms.some(r => r.roomId === makeUuid(10)), false);
  assert.equal(body.rooms.some(r => r.roomId === makeUuid(5)), false);
});

test('directoryIntegration: room visibility switching dynamically adds and removes public listing', async () => {
  const { ctx } = createMockDirectoryState();
  const directory = new RoomDirectory(ctx);
  await directory.ready;

  const roomId = makeUuid(42);
  const code = 'SWITCH42';

  // 1. Room is created public
  const statePublic: WatchRoomState = {
    roomId,
    joinCode: code,
    title: 'Switching Room',
    visibility: 'public',
    hostId: 42,
    media: null,
    participants: [{ profileId: 42, login: 'host', avatar: null, connected: true, viewing: true, status: 'ready', readyEpoch: 0, excludedEpoch: null, disconnectedAt: null, error: null, canControl: true }],
    playback: { intent: 'paused', position: 0, paused: true, rate: 1, updatedAt: Date.now() },
    syncEpoch: 0,
    mediaVersion: 0,
    revision: 1,
    closed: false,
    barrier: null,
    emptySince: null,
  };

  await directory.fetch(new Request('https://internal/update', {
    method: 'POST',
    body: JSON.stringify({ state: statePublic }),
  }));

  let listRes = await directory.fetch(new Request('https://internal/list'));
  let listJson = await listRes.json() as { rooms: PublicRoom[] };
  assert.equal(listJson.rooms.length, 1);
  assert.equal(listJson.rooms[0].roomId, roomId);

  // 2. Room switches to private
  const statePrivate: WatchRoomState = {
    ...statePublic,
    visibility: 'private',
    revision: 2,
  };

  await directory.fetch(new Request('https://internal/update', {
    method: 'POST',
    body: JSON.stringify({ state: statePrivate }),
  }));

  listRes = await directory.fetch(new Request('https://internal/list'));
  listJson = await listRes.json() as { rooms: PublicRoom[] };
  assert.equal(listJson.rooms.length, 0); // Removed from public listing!

  // Room can still be resolved by join code
  const resolveRes = await directory.fetch(new Request(`https://internal/resolve?code=${code}`));
  assert.equal(resolveRes.status, 200);

  // 3. Room switches back to public
  const statePublicAgain: WatchRoomState = {
    ...statePublic,
    visibility: 'public',
    revision: 3,
  };

  await directory.fetch(new Request('https://internal/update', {
    method: 'POST',
    body: JSON.stringify({ state: statePublicAgain }),
  }));

  listRes = await directory.fetch(new Request('https://internal/list'));
  listJson = await listRes.json() as { rooms: PublicRoom[] };
  assert.equal(listJson.rooms.length, 1);
  assert.equal(listJson.rooms[0].roomId, roomId);
});

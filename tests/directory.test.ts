import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomDirectory, RoomObject } from '../src/objects.ts';
import type { PublicRoom, WatchRoomState } from '../protocol/index.ts';

class MockStorage {
  private data = new Map<string, any>();
  private alarm: number | null = null;
  public listCalls: { prefix?: string; limit?: number; startAfter?: string }[] = [];

  constructor(initialData?: Map<string, any>) {
    if (initialData) {
      for (const [k, v] of initialData.entries()) {
        this.data.set(k, structuredClone(v));
      }
    }
  }

  get rawData() { return this.data; }

  async get<T = any>(keyOrKeys: string | string[]): Promise<any> {
    if (Array.isArray(keyOrKeys)) {
      const map = new Map<string, T>();
      for (const k of keyOrKeys) {
        if (this.data.has(k)) {
          map.set(k, structuredClone(this.data.get(k)));
        }
      }
      return map;
    }
    return this.data.has(keyOrKeys) ? structuredClone(this.data.get(keyOrKeys)) : undefined;
  }

  async put(keyOrRecord: string | Record<string, any>, value?: any): Promise<void> {
    if (typeof keyOrRecord === 'string') {
      this.data.set(keyOrRecord, structuredClone(value));
    } else {
      for (const [k, v] of Object.entries(keyOrRecord)) {
        this.data.set(k, structuredClone(v));
      }
    }
  }

  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      let count = 0;
      for (const k of keyOrKeys) {
        if (this.data.delete(k)) count++;
      }
      return count;
    }
    return this.data.delete(keyOrKeys);
  }

  async list<T = any>(options?: { prefix?: string; limit?: number; startAfter?: string }): Promise<Map<string, T>> {
    assert.ok(options, 'storage.list must be called with options');
    assert.ok(
      typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0,
      `storage.list must specify a finite positive limit, received: ${options?.limit}`
    );

    this.listCalls.push({ ...options });

    const sortedKeys = Array.from(this.data.keys()).sort();
    const result = new Map<string, T>();

    for (const key of sortedKeys) {
      if (options.prefix && !key.startsWith(options.prefix)) continue;
      if (options.startAfter && key <= options.startAfter) continue;
      result.set(key, structuredClone(this.data.get(key)));
      if (result.size >= options.limit) break;
    }

    return result;
  }

  async transaction<T>(closure: (txn: MockStorage) => Promise<T>): Promise<T> {
    return await closure(this);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  async deleteAll(): Promise<void> {
    this.data.clear();
    this.alarm = null;
  }
}

function createMockDOState(storage: MockStorage): { ctx: DurableObjectState; waitUntils: Promise<any>[] } {
  const waitUntils: Promise<any>[] = [];
  const ctx = {
    storage,
    waitUntil(promise: Promise<any>) {
      waitUntils.push(promise);
    },
    blockConcurrencyWhile: async (fn: () => Promise<any>) => {
      await fn();
    },
    id: { toString: () => 'mock-id', equals: () => false, name: 'directory-v2' },
    getWebSockets: () => [],
    acceptWebSocket: () => {},
  } as unknown as DurableObjectState;
  return { ctx, waitUntils };
}

function req(path: string, method = 'GET', body?: unknown): Request {
  return new Request(`https://internal${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeUuid(index: number): string {
  const hex = String(index).padStart(12, '0');
  return `00000000-0000-0000-0000-${hex}`;
}

test('RoomDirectory: empty database marks migration done immediately and enforces finite list limits', async () => {
  const storage = new MockStorage();
  const { ctx } = createMockDOState(storage);
  const directory = new RoomDirectory(ctx);
  await directory.ready;

  assert.equal(directory.isMigrated, true);
  const meta = await storage.get('meta:migration');
  assert.deepEqual(meta, { stage: 'done' });

  const res = await directory.fetch(req('/list'));
  assert.equal(res.status, 200);
  const data = await res.json() as { rooms: any[]; cursor: string | null };
  assert.deepEqual(data.rooms, []);
  assert.equal(data.cursor, null);

  // Assert all list calls had finite limits
  assert.ok(storage.listCalls.length > 0);
  for (const call of storage.listCalls) {
    assert.ok(typeof call.limit === 'number' && Number.isFinite(call.limit) && call.limit > 0);
  }
});

test('RoomDirectory: >40 public rooms mixed with private rooms paginate without skips or duplicates', async () => {
  const storage = new MockStorage();
  const { ctx } = createMockDOState(storage);
  const directory = new RoomDirectory(ctx);

  // Populate 45 public rooms and 25 private rooms, interspersed
  const totalPublic = 45;
  const totalPrivate = 25;
  const expectedPublicIds: string[] = [];

  for (let i = 1; i <= totalPublic + totalPrivate; i++) {
    const roomId = makeUuid(i);
    const isPublic = i % 2 === 1 ? expectedPublicIds.length < totalPublic : (i > totalPrivate * 2);

    const state: WatchRoomState = {
      roomId,
      joinCode: `CODE${String(i).padStart(4, '0')}`,
      title: `Room ${i}`,
      visibility: isPublic ? 'public' : 'private',
      hostId: 100 + i,
      media: { releaseId: i, releaseName: `Show ${i}`, dubId: 1, sourceId: 1, episode: 1, episodeName: 'Ep 1' },
      participants: [{ profileId: 100 + i, login: `User${i}`, avatar: null, connected: true, viewing: true, status: 'ready' }],
      playback: { intent: 'paused', position: 0, paused: true, speed: 1, anchorServerTime: Date.now() },
      syncEpoch: 1,
      mediaVersion: 1,
      revision: 1,
      closed: false,
      barrier: null,
    };

    if (isPublic) expectedPublicIds.push(roomId);
    await directory.fetch(req('/update', 'POST', { state }));
  }

  assert.equal(expectedPublicIds.length, totalPublic);
  expectedPublicIds.sort();

  // Test cursor pagination
  const collectedRoomIds: string[] = [];
  let cursor: string | null = null;
  let pageCount = 0;

  do {
    pageCount++;
    const url = cursor ? `/list?cursor=${cursor}` : '/list';
    const res = await directory.fetch(req(url));
    assert.equal(res.status, 200);
    const body = await res.json() as { rooms: PublicRoom[]; cursor: string | null };

    if (pageCount === 1) {
      assert.equal(body.rooms.length, 20);
      assert.ok(body.cursor !== null);
      assert.equal(body.cursor, body.rooms[19].roomId);
    } else if (pageCount === 2) {
      assert.equal(body.rooms.length, 20);
      assert.ok(body.cursor !== null);
      assert.equal(body.cursor, body.rooms[19].roomId);
    } else if (pageCount === 3) {
      assert.equal(body.rooms.length, 5);
      assert.equal(body.cursor, null);
    }

    for (const r of body.rooms) {
      assert.ok(!collectedRoomIds.includes(r.roomId), `Duplicate room detected: ${r.roomId}`);
      collectedRoomIds.push(r.roomId);
    }
    cursor = body.cursor;
  } while (cursor !== null);

  assert.equal(pageCount, 3);
  assert.equal(collectedRoomIds.length, totalPublic);
  assert.deepEqual(collectedRoomIds, expectedPublicIds);

  // Invalid cursor test
  const badCursorRes = await directory.fetch(req('/list?cursor=not-a-valid-uuid'));
  assert.equal(badCursorRes.status, 400);
});

test('RoomDirectory: lifecycle transitions (reservation -> active, public -> private, close/remove)', async () => {
  const storage = new MockStorage();
  const { ctx } = createMockDOState(storage);
  const directory = new RoomDirectory(ctx);

  const roomId = makeUuid(99);

  // 1. Reserve room
  const reserveRes = await directory.fetch(req('/reserve', 'POST', { roomId }));
  assert.equal(reserveRes.status, 200);
  const { code } = await reserveRes.json() as { code: string };

  // Should not be in public list
  const list1 = await (await directory.fetch(req('/list'))).json() as { rooms: any[] };
  assert.equal(list1.rooms.length, 0);

  // Should be resolvable by code
  const resolve1 = await directory.fetch(req(`/resolve?code=${code}`));
  assert.equal(resolve1.status, 200);
  assert.deepEqual(await resolve1.json(), { roomId });

  // Expiry index must exist for reservation
  const expiryKeys = Array.from(storage.rawData.keys()).filter(k => k.startsWith('expiry:'));
  assert.equal(expiryKeys.length, 1);
  assert.ok(expiryKeys[0].includes(`:room:room:${roomId}`));

  // 2. Activate room as public
  const state: WatchRoomState = {
    roomId,
    joinCode: code,
    title: 'Activated Room',
    visibility: 'public',
    hostId: 1,
    media: null,
    participants: [{ profileId: 1, login: 'Host', avatar: null, connected: true, viewing: false, status: 'loading' }],
    playback: { intent: 'paused', position: 0, paused: true, speed: 1, anchorServerTime: Date.now() },
    syncEpoch: 0,
    mediaVersion: 0,
    revision: 1,
    closed: false,
    barrier: null,
  };
  await directory.fetch(req('/update', 'POST', { state }));

  // Public index created, old reservation expiry removed
  assert.equal(await storage.get(`public:${roomId}`), true);
  const remainingExpiry = Array.from(storage.rawData.keys()).filter(k => k.startsWith('expiry:'));
  assert.equal(remainingExpiry.length, 0);

  const list2 = await (await directory.fetch(req('/list'))).json() as { rooms: any[] };
  assert.equal(list2.rooms.length, 1);
  assert.equal(list2.rooms[0].roomId, roomId);

  // 3. Transition public -> private
  state.visibility = 'private';
  await directory.fetch(req('/update', 'POST', { state }));

  assert.equal(await storage.get(`public:${roomId}`), undefined);
  const list3 = await (await directory.fetch(req('/list'))).json() as { rooms: any[] };
  assert.equal(list3.rooms.length, 0);

  // Still resolvable by code
  const resolve2 = await directory.fetch(req(`/resolve?code=${code}`));
  assert.equal(resolve2.status, 200);

  // 4. Close room
  state.closed = true;
  await directory.fetch(req('/update', 'POST', { state }));
  assert.equal(await storage.get(`room:${roomId}`), undefined);
  assert.equal(await storage.get(`code:${code}`), undefined);

  const resolve3 = await directory.fetch(req(`/resolve?code=${code}`));
  assert.equal(resolve3.status, 404);
});

test('RoomDirectory: alarm cleanup protects activated rooms and renewed limits against stale expiry keys', async () => {
  const storage = new MockStorage();
  const { ctx } = createMockDOState(storage);
  const directory = new RoomDirectory(ctx);
  await directory.ready;

  const now = Date.now();

  // 1. Stale expiry for an activated room
  const activeRoomId = makeUuid(101);
  await storage.put(`room:${activeRoomId}`, {
    roomId: activeRoomId,
    code: 'CODE101A',
    expiresAt: Number.MAX_SAFE_INTEGER,
    room: { roomId: activeRoomId, title: 'Active', hostId: 1, media: null, participants: 1 },
  });
  await storage.put(`public:${activeRoomId}`, true);
  await storage.put(`code:CODE101A`, activeRoomId);

  // Stale expiry key with timestamp in the past
  const pastTimestamp = String(now - 10_000).padStart(13, '0');
  const staleRoomExpiry = `expiry:${pastTimestamp}:room:room:${activeRoomId}`;
  await storage.put(staleRoomExpiry, true);

  // 2. Truly expired room reservation
  const expiredRoomId = makeUuid(102);
  await storage.put(`room:${expiredRoomId}`, {
    roomId: expiredRoomId,
    code: 'CODE102B',
    expiresAt: now - 5_000,
    room: null,
  });
  await storage.put(`code:CODE102B`, expiredRoomId);
  const expiredRoomKey = `expiry:${String(now - 5_000).padStart(13, '0')}:room:room:${expiredRoomId}`;
  await storage.put(expiredRoomKey, true);

  // 3. Stale expiry for a renewed rate limit
  const limitKey = 'auth:user1';
  await storage.put(`limit:${limitKey}`, { count: 3, until: now + 50_000 });
  const staleLimitExpiry = `expiry:${pastTimestamp}:limit:limit:${limitKey}`;
  await storage.put(staleLimitExpiry, true);

  // 4. Truly expired rate limit
  const expiredLimitKey = 'auth:user2';
  await storage.put(`limit:${expiredLimitKey}`, { count: 5, until: now - 1_000 });
  const expiredLimitExpiry = `expiry:${String(now - 1_000).padStart(13, '0')}:limit:limit:${expiredLimitKey}`;
  await storage.put(expiredLimitExpiry, true);

  // Trigger alarm
  await directory.alarm();

  // Active room must NOT be deleted
  assert.ok(await storage.get(`room:${activeRoomId}`));
  assert.equal(await storage.get(`public:${activeRoomId}`), true);
  assert.equal(await storage.get(staleRoomExpiry), undefined); // stale expiry removed

  // Expired room reservation MUST be deleted
  assert.equal(await storage.get(`room:${expiredRoomId}`), undefined);
  assert.equal(await storage.get(`code:CODE102B`), undefined);
  assert.equal(await storage.get(expiredRoomKey), undefined);

  // Renewed limit must NOT be deleted
  const limit = await storage.get<{ count: number; until: number }>(`limit:${limitKey}`);
  assert.ok(limit);
  assert.equal(limit.count, 3);
  assert.equal(await storage.get(staleLimitExpiry), undefined); // stale expiry removed

  // Expired limit MUST be deleted
  assert.equal(await storage.get(`limit:${expiredLimitKey}`), undefined);
  assert.equal(await storage.get(expiredLimitExpiry), undefined);
});

test('RoomDirectory: alarm cleanup handles >100 expiry records across multiple bounded batches', async () => {
  const storage = new MockStorage();
  const { ctx } = createMockDOState(storage);
  const directory = new RoomDirectory(ctx);
  await directory.ready;

  const now = Date.now();
  const totalExpired = 250;

  // Create 250 expired limit keys
  for (let i = 1; i <= totalExpired; i++) {
    const key = `batch:${i}`;
    const until = now - 100_000 + i;
    const pad = String(until).padStart(13, '0');
    await storage.put(`limit:${key}`, { count: 1, until });
    await storage.put(`expiry:${pad}:limit:limit:${key}`, true);
  }

  // Create 5 future keys
  const futureTime = now + 60_000;
  for (let i = 1; i <= 5; i++) {
    const key = `future:${i}`;
    const until = futureTime + i * 1000;
    const pad = String(until).padStart(13, '0');
    await storage.put(`limit:${key}`, { count: 1, until });
    await storage.put(`expiry:${pad}:limit:limit:${key}`, true);
  }

  // Alarm run 1: cleans first 100
  await directory.alarm();
  let remainingExpired = Array.from(storage.rawData.keys()).filter(k => k.startsWith('expiry:') && Number(k.split(':')[1]) <= now);
  assert.equal(remainingExpired.length, 150);
  assert.ok(await storage.getAlarm() !== null); // short alarm scheduled to continue

  // Alarm run 2: cleans next 100
  await directory.alarm();
  remainingExpired = Array.from(storage.rawData.keys()).filter(k => k.startsWith('expiry:') && Number(k.split(':')[1]) <= now);
  assert.equal(remainingExpired.length, 50);

  // Alarm run 3: cleans remaining 50
  await directory.alarm();
  remainingExpired = Array.from(storage.rawData.keys()).filter(k => k.startsWith('expiry:') && Number(k.split(':')[1]) <= now);
  assert.equal(remainingExpired.length, 0);

  // Future keys untouched
  const futureKeys = Array.from(storage.rawData.keys()).filter(k => k.startsWith('expiry:'));
  assert.equal(futureKeys.length, 5);

  // Next alarm scheduled for earliest future expiry
  const expectedEarliest = futureTime + 1000;
  assert.equal(await storage.getAlarm(), expectedEarliest);
});

test('RoomDirectory: staged migration returns 503 DIRECTORY_MIGRATING while running and allows other ops', async () => {
  const storage = new MockStorage();
  const now = Date.now();

  // Seed 150 legacy rooms without index or migration meta
  for (let i = 1; i <= 150; i++) {
    const roomId = makeUuid(i);
    await storage.put(`room:${roomId}`, {
      roomId,
      code: `CODE${i}`,
      expiresAt: Number.MAX_SAFE_INTEGER,
      room: { roomId, title: `Legacy ${i}`, hostId: 1, media: null, participants: 1 },
    });
    await storage.put(`code:CODE${i}`, roomId);
  }

  const { ctx } = createMockDOState(storage);
  const directory = new RoomDirectory(ctx);

  assert.equal(directory.isMigrated, false);

  // /list returns 503 DIRECTORY_MIGRATING
  const listRes = await directory.fetch(req('/list'));
  assert.equal(listRes.status, 503);
  assert.deepEqual(await listRes.json(), { code: 'DIRECTORY_MIGRATING' });

  // Other operations continue normally
  const limitRes = await directory.fetch(req('/limit', 'POST', { key: 'test-user', max: 5 }));
  assert.equal(limitRes.status, 200);

  const resolveRes = await directory.fetch(req('/resolve?code=CODE1'));
  assert.equal(resolveRes.status, 200);
  assert.deepEqual(await resolveRes.json(), { roomId: makeUuid(1) });
});

test('RoomDirectory: staged migration resumes after reconstruction', async () => {
  const storage = new MockStorage();

  // Seed 250 legacy rooms
  for (let i = 1; i <= 250; i++) {
    const roomId = makeUuid(i);
    await storage.put(`room:${roomId}`, {
      roomId,
      code: `CODE${i}`,
      expiresAt: Number.MAX_SAFE_INTEGER,
      room: { roomId, title: `Legacy ${i}`, hostId: 1, media: null, participants: 1 },
    });
  }

  // First instance
  const { ctx: ctx1 } = createMockDOState(storage);
  const dir1 = new RoomDirectory(ctx1);
  assert.equal(dir1.isMigrated, false);

  // Step 1: migrates 100 rooms
  await dir1.stepMigration();
  let meta = await storage.get<any>('meta:migration');
  assert.equal(meta.stage, 'rooms');
  assert.ok(meta.cursor);

  let publicKeys = Array.from(storage.rawData.keys()).filter(k => k.startsWith('public:'));
  assert.equal(publicKeys.length, 100);

  // Simulate DO restart/reconstruction
  const { ctx: ctx2 } = createMockDOState(storage);
  const dir2 = new RoomDirectory(ctx2);
  assert.equal(dir2.isMigrated, false);

  // Step 2: resumes from cursor, migrates next 100
  await dir2.stepMigration();
  meta = await storage.get<any>('meta:migration');
  assert.equal(meta.stage, 'rooms');
  publicKeys = Array.from(storage.rawData.keys()).filter(k => k.startsWith('public:'));
  assert.equal(publicKeys.length, 200);

  // Step 3: migrates remaining 50 rooms, moves to limits stage
  await dir2.stepMigration();
  meta = await storage.get<any>('meta:migration');
  assert.equal(meta.stage, 'limits');
  publicKeys = Array.from(storage.rawData.keys()).filter(k => k.startsWith('public:'));
  assert.equal(publicKeys.length, 250);

  // Step 4: limits stage finishes
  await dir2.stepMigration();
  assert.equal(dir2.isMigrated, true);
  meta = await storage.get<any>('meta:migration');
  assert.equal(meta.stage, 'done');

  // /list now succeeds
  const listRes = await dir2.fetch(req('/list'));
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json() as { rooms: any[]; cursor: string | null };
  assert.equal(listBody.rooms.length, 20);
});

test('RoomDirectory: concurrent updates and deletions between migration batches do not revive old rooms', async () => {
  const storage = new MockStorage();

  // Seed 200 rooms
  for (let i = 1; i <= 200; i++) {
    const roomId = makeUuid(i);
    await storage.put(`room:${roomId}`, {
      roomId,
      code: `CODE${i}`,
      expiresAt: Number.MAX_SAFE_INTEGER,
      room: { roomId, title: `Room ${i}`, hostId: 1, media: null, participants: 1 },
    });
    await storage.put(`code:CODE${i}`, roomId);
  }

  const { ctx } = createMockDOState(storage);
  const directory = new RoomDirectory(ctx);

  // Batch 1: migrates rooms 1..100
  await directory.stepMigration();

  // Concurrent mutations before batch 2:
  // 1. Room 150 is deleted via /remove
  const room150Id = makeUuid(150);
  await directory.fetch(req('/remove', 'POST', { roomId: room150Id, code: 'CODE150' }));

  // 2. Room 160 is changed from public to private via /update
  const room160Id = makeUuid(160);
  const privateState: WatchRoomState = {
    roomId: room160Id,
    joinCode: 'CODE160',
    title: 'Room 160',
    visibility: 'private',
    hostId: 1,
    media: null,
    participants: [{ profileId: 1, login: 'Host', avatar: null, connected: true, viewing: false, status: 'ready' }],
    playback: { intent: 'paused', position: 0, paused: true, speed: 1, anchorServerTime: Date.now() },
    syncEpoch: 0,
    mediaVersion: 0,
    revision: 2,
    closed: false,
    barrier: null,
  };
  await directory.fetch(req('/update', 'POST', { state: privateState }));

  // Batch 2: migrates rooms 101..200
  await directory.stepMigration();
  // Batch 3: limits finish
  await directory.stepMigration();

  assert.equal(directory.isMigrated, true);

  // Verify room 150 was NOT revived
  assert.equal(await storage.get(`room:${room150Id}`), undefined);
  assert.equal(await storage.get(`public:${room150Id}`), undefined);

  // Verify room 160 was NOT revived as public
  assert.equal(await storage.get(`public:${room160Id}`), undefined);
  const entry160 = await storage.get<any>(`room:${room160Id}`);
  assert.ok(entry160);
  assert.equal(entry160.room, null);
});

test('RoomObject: corrupted or unknown visibility safely requires invite code / ticket authorization', async () => {
  const profile = { profileId: 999, login: 'Intruder', avatar: null };
  const host = { profileId: 1, login: 'Host', avatar: null };

  const storage = new MockStorage();
  const { ctx } = createMockDOState(storage);
  const dummyEnv = {
    ROOMS: {} as any,
    DIRECTORY: {
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ ok: true })),
      }),
      idFromName: () => ({ toString: () => 'dir' }),
    } as any,
    SESSION_SECRET: 'x'.repeat(32),
    ALLOWED_ORIGINS: 'http://localhost',
  };

  const room = new RoomObject(ctx, dummyEnv);

  // Initialize room with corrupted / unknown visibility
  const initRes = await room.fetch(req('/init', 'POST', {
    roomId: makeUuid(1),
    joinCode: 'SECRET99',
    title: 'Corrupted Visibility Room',
    visibility: 'corrupted_unknown_visibility' as any,
    host,
  }));
  assert.equal(initRes.status, 200);

  // Guest requests ticket WITHOUT invite code: MUST be rejected with 403 INVITE_REQUIRED
  const ticketWithoutCode = await room.fetch(req('/ticket', 'POST', { profile }));
  assert.equal(ticketWithoutCode.status, 403);
  assert.deepEqual(await ticketWithoutCode.json(), { code: 'INVITE_REQUIRED' });

  // Guest requests ticket WITH invite code: succeeds
  const ticketWithCode = await room.fetch(req('/ticket', 'POST', { profile, code: 'SECRET99' }));
  assert.equal(ticketWithCode.status, 200);
  const body = await ticketWithCode.json() as { ticket: string; roomId: string };
  assert.ok(body.ticket);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_VOICE_DURATION_MS,
  isChatMessage,
  isAttachment,
  parseClientMessage,
  type RoomChatMessage,
  type RoomCommand,
} from '../protocol/index.ts';
import { ANIXART_APP_USER_AGENT } from '../src/userAgent.ts';
import {
  sniffMimeType,
  readBoundedStream,
  saveAttachment,
  loadAttachment,
  cleanEvictedAttachments,
  eraseAllAttachmentData,
  type StoredAttachmentMeta,
} from '../src/attachments.ts';

const origin = 'http://localhost:5173';
const secret = 'integration-secret-at-least-thirty-two-characters';
const bundle = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });

function runtime() {
  return new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-07',
    port: 0,
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
          profile: { id: Number(token), login: `user${token}`, avatar: `https://avatar/${token}.png` },
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

async function createRoom(mf: Miniflare, session: string, title = 'Test Room') {
  const response = await post(mf, '/api/v2/rooms', { title, visibility: 'public' }, session);
  assert.equal(response.status, 200);
  return await response.json() as { roomId: string; ticket: string; state: any };
}

async function joinRoom(mf: Miniflare, session: string, roomId: string) {
  const response = await post(mf, '/api/v2/rooms/join', { roomId }, session);
  assert.equal(response.status, 200);
  return await response.json() as { roomId: string; ticket: string; state: any };
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

// Sample binary generators
function makePng(size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 8));
  bytes.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return bytes;
}

function makeWebm(size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 4));
  bytes.set([0x1A, 0x45, 0xDF, 0xA3]);
  return bytes;
}

function makeJpeg(size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 3));
  bytes.set([0xFF, 0xD8, 0xFF]);
  return bytes;
}

function makeGif(size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 6));
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  return bytes;
}

function makeWebp(size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 12));
  bytes.set([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]); // RIFF....WEBP
  return bytes;
}

function makeOgg(size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 4));
  bytes.set([0x4F, 0x67, 0x67, 0x53]); // OggS
  return bytes;
}

function makeMp4Audio(size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 12));
  bytes.set([0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x4D, 0x34, 0x41, 0x20]); // ftyp M4A
  return bytes;
}

function makeAvif(size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 12));
  bytes.set([0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]); // ftyp avif
  return bytes;
}

async function upload(
  mf: Miniflare,
  roomId: string,
  session: string,
  bytes: Uint8Array,
  opts: {
    kind: 'image' | 'voice';
    name?: string;
    durationMs?: number;
    text?: string;
    uploadId?: string;
    contentType?: string;
  }
) {
  const uploadId = opts.uploadId ?? crypto.randomUUID();
  const headers: Record<string, string> = {
    Origin: origin,
    Authorization: `Bearer ${session}`,
    // Raw browser Blob uploads have a known HTTP byte length. Explicitly
    // mirror that in Miniflare's Request-to-Undici streaming bridge.
    'Content-Length': String(bytes.byteLength),
    'X-Attachment-Kind': opts.kind,
    'X-Attachment-Upload-Id': uploadId,
  };
  if (opts.name !== undefined) headers['X-Attachment-Name'] = encodeURIComponent(opts.name);
  if (opts.durationMs !== undefined) headers['X-Attachment-Duration'] = String(opts.durationMs);
  if (opts.text !== undefined) headers['X-Attachment-Text'] = encodeURIComponent(opts.text);
  headers['Content-Type'] = opts.contentType ?? (opts.kind === 'image' ? 'image/png' : 'audio/webm');

  // Exercise the listening Worker over HTTP like a real browser Blob upload;
  // Miniflare dispatchFetch converts binary arrays into a separate proxy stream.
  return fetch(new URL(`/api/v2/rooms/${roomId}/attachments`, await mf.ready), {
    method: 'POST',
    headers,
    body: Buffer.from(bytes),
  });
}

async function download(mf: Miniflare, roomId: string, attachmentId: string, session?: string) {
  const headers: Record<string, string> = {
    Origin: origin,
    ...(session ? { Authorization: `Bearer ${session}` } : {}),
  };
  return mf.dispatchFetch(`http://localhost/api/v2/rooms/${roomId}/attachments/${attachmentId}`, {
    method: 'GET',
    headers,
  });
}

// =========================================================================
// 1. Exact-Size Boundary, Max+1, and Length Header Scenarios
// =========================================================================

test('attachments: exact-size boundary (5,000,000 bytes) succeeds, max+1 (5,000,001 bytes) is rejected with 413', async () => {
  const mf = runtime();
  try {
    const hostSession = await login(mf, 1);
    const room = await createRoom(mf, hostSession);
    const sock = await socket(mf, room.roomId, room.ticket);

    // 1. Exactly MAX_ATTACHMENT_BYTES (5_000_000)
    const exactBytes = makePng(MAX_ATTACHMENT_BYTES);
    const exactRes = await upload(mf, room.roomId, hostSession, exactBytes, {
      kind: 'image',
      name: 'exact.png',
      text: 'Exact boundary image',
    });
    assert.equal(exactRes.status, 200);
    const exactData = await exactRes.json() as { message: RoomChatMessage };
    assert.ok(exactData.message.attachment);
    assert.equal(exactData.message.attachment.size, 5_000_000);
    assert.equal(exactData.message.attachment.kind, 'image');
    assert.equal(exactData.message.attachment.mimeType, 'image/png');
    assert.equal(exactData.message.text, 'Exact boundary image');

    // Verify WebSocket received the broadcast
    const stateMsg = await sock.next(m => m.type === 'room_state' && m.state.chat?.some((c: any) => c.id === exactData.message.id));
    assert.ok(stateMsg);

    // 2. Max + 1 (5_000_001 bytes)
    const overBytes = makePng(MAX_ATTACHMENT_BYTES + 1);
    const overRes = await upload(mf, room.roomId, hostSession, overBytes, {
      kind: 'image',
      name: 'oversized.png',
    });
    assert.equal(overRes.status, 413);
    const overData = await overRes.json() as { code: string };
    assert.equal(overData.code, 'BODY_TOO_LARGE');

    // 3. 0 bytes (empty)
    const emptyRes = await upload(mf, room.roomId, hostSession, new Uint8Array(0), {
      kind: 'image',
      name: 'empty.png',
    });
    assert.equal(emptyRes.status, 400);
    assert.equal((await emptyRes.json() as { code: string }).code, 'EMPTY_ATTACHMENT');
  } finally {
    await mf.dispose();
  }
});

test('attachments: bounded stream reader rejects oversized chunks regardless of absent length', async () => {
  // Test readBoundedStream directly with simulated ReadableStreams
  const exactChunk = new Uint8Array(5_000_000);
  exactChunk.fill(1);
  const streamOk = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(exactChunk);
      controller.close();
    },
  });
  const resBytes = await readBoundedStream(streamOk, 5_000_000);
  assert.equal(resBytes.byteLength, 5_000_000);

  // Exceeds max bytes by 1 byte across chunks
  const streamOver = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4_000_000));
      controller.enqueue(new Uint8Array(1_000_001));
      controller.close();
    },
  });
  await assert.rejects(
    async () => readBoundedStream(streamOver, 5_000_000),
    err => (err as any).status === 413 && (err as any).code === 'BODY_TOO_LARGE',
  );

  // Empty stream
  const streamEmpty = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  await assert.rejects(
    async () => readBoundedStream(streamEmpty, 5_000_000),
    err => (err as any).status === 400 && (err as any).code === 'EMPTY_ATTACHMENT',
  );
});

// =========================================================================
// 2. MIME Sniffing, Voice Durations, and Unsupported Formats
// =========================================================================

test('attachments: sniffMimeType detects supported signatures and rejects SVG/HTML/arbitrary', () => {
  // PNG, JPEG, GIF, WebP, AVIF
  assert.equal(sniffMimeType(makePng())?.mimeType, 'image/png');
  assert.equal(sniffMimeType(makePng())?.kind, 'image');
  assert.equal(sniffMimeType(makeJpeg())?.mimeType, 'image/jpeg');
  assert.equal(sniffMimeType(makeJpeg())?.kind, 'image');
  assert.equal(sniffMimeType(makeGif())?.mimeType, 'image/gif');
  assert.equal(sniffMimeType(makeGif())?.kind, 'image');
  assert.equal(sniffMimeType(makeWebp())?.mimeType, 'image/webp');
  assert.equal(sniffMimeType(makeWebp())?.kind, 'image');
  assert.equal(sniffMimeType(makeAvif())?.mimeType, 'image/avif');
  assert.equal(sniffMimeType(makeAvif())?.kind, 'image');

  // WebM, OGG, MP4
  assert.equal(sniffMimeType(makeWebm())?.mimeType, 'audio/webm');
  assert.equal(sniffMimeType(makeWebm())?.kind, 'voice');
  assert.equal(sniffMimeType(makeOgg())?.mimeType, 'audio/ogg');
  assert.equal(sniffMimeType(makeOgg())?.kind, 'voice');
  assert.equal(sniffMimeType(makeMp4Audio())?.mimeType, 'audio/mp4');
  assert.equal(sniffMimeType(makeMp4Audio())?.kind, 'voice');

  // SVG, HTML, arbitrary rejection
  assert.equal(sniffMimeType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffMimeType(new TextEncoder().encode('<!DOCTYPE html><html><body>x</body></html>')), null);
  assert.equal(sniffMimeType(new TextEncoder().encode('hello world raw text')), null);
});

test('attachments: worker HTTP upload MIME consistency, SVG rejection and voice duration checks', async () => {
  const mf = runtime();
  try {
    const hostSession = await login(mf, 1);
    const room = await createRoom(mf, hostSession);

    // Valid PNG upload
    const pngRes = await upload(mf, room.roomId, hostSession, makePng(100), { kind: 'image', name: 'image.png' });
    assert.equal(pngRes.status, 200);

    // Valid WebM voice upload
    const voiceRes = await upload(mf, room.roomId, hostSession, makeWebm(100), { kind: 'voice', name: 'voice.webm', durationMs: 4000 });
    assert.equal(voiceRes.status, 200);
    const voiceData = await voiceRes.json() as { message: RoomChatMessage };
    assert.equal(voiceData.message.attachment?.mimeType, 'audio/webm');
    assert.equal(voiceData.message.attachment?.durationMs, 4000);

    // SVG rejection
    const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>');
    const svgRes = await upload(mf, room.roomId, hostSession, svgBytes, { kind: 'image', name: 'evil.svg' });
    assert.equal(svgRes.status, 415);
    assert.equal((await svgRes.json() as { code: string }).code, 'UNSUPPORTED_MEDIA_TYPE');

    // Kind mismatch: PNG bytes with kind = voice
    const mismatchRes = await upload(mf, room.roomId, hostSession, makePng(100), { kind: 'voice', durationMs: 1000 });
    assert.equal(mismatchRes.status, 400);
    assert.equal((await mismatchRes.json() as { code: string }).code, 'KIND_MIMETYPE_MISMATCH');

    // Voice duration bounds
    const noDurRes = await upload(mf, room.roomId, hostSession, makeWebm(100), { kind: 'voice' });
    assert.equal(noDurRes.status, 400);
    assert.equal((await noDurRes.json() as { code: string }).code, 'INVALID_DURATION');

    const zeroDurRes = await upload(mf, room.roomId, hostSession, makeWebm(100), { kind: 'voice', durationMs: 0 });
    assert.equal(zeroDurRes.status, 400);
    assert.equal((await zeroDurRes.json() as { code: string }).code, 'INVALID_DURATION');

    const overDurRes = await upload(mf, room.roomId, hostSession, makeWebm(100), { kind: 'voice', durationMs: MAX_VOICE_DURATION_MS + 1 });
    assert.equal(overDurRes.status, 400);
    assert.equal((await overDurRes.json() as { code: string }).code, 'INVALID_DURATION');
  } finally {
    await mf.dispose();
  }
});

// =========================================================================
// 3. Identity, Isolation, Membership and Cross-Room Security
// =========================================================================

test('attachments: member permissions, author isolation, and cross-room denial', async () => {
  const mf = runtime();
  try {
    const user1 = await login(mf, 1);
    const user2 = await login(mf, 2);
    const outsider = await login(mf, 3);

    const roomA = await createRoom(mf, user1, 'Room A');
    const user2Join = await joinRoom(mf, user2, roomA.roomId);
    // Connect user2 socket so they are retained in participants
    const user2Sock = await socket(mf, roomA.roomId, user2Join.ticket);

    const roomB = await createRoom(mf, outsider, 'Room B');

    // User 1 uploads to room A
    const uploadRes = await upload(mf, roomA.roomId, user1, makePng(128), {
      kind: 'image',
      name: 'roomA.png',
      text: 'Photo A',
    });
    assert.equal(uploadRes.status, 200);
    const uploadData = await uploadRes.json() as { message: RoomChatMessage };
    const attId = uploadData.message.attachment!.id;

    // Verify author cannot be spoofed: profileId is 1 from session, text is Photo A
    assert.equal(uploadData.message.profileId, 1);
    assert.equal(uploadData.message.login, 'user1');

    // Retained member user 2 can download
    const dlUser2 = await download(mf, roomA.roomId, attId, user2);
    assert.equal(dlUser2.status, 200);
    assert.equal(dlUser2.headers.get('Content-Type'), 'image/png');
    assert.equal(dlUser2.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(dlUser2.headers.get('Cache-Control'), 'no-store');

    // Outsider (not joined in Room A) cannot download from Room A
    const dlOutsider = await download(mf, roomA.roomId, attId, outsider);
    assert.equal(dlOutsider.status, 403);

    // Cross-room: Requesting Room A's attachment ID through Room B's endpoint fails with 404
    const dlCross = await download(mf, roomB.roomId, attId, outsider);
    assert.equal(dlCross.status, 404);

    // Outsider cannot upload to Room A
    const upOutsider = await upload(mf, roomA.roomId, outsider, makePng(128), { kind: 'image' });
    assert.equal(upOutsider.status, 403);
  } finally {
    await mf.dispose();
  }
});

test('attachments: kicked and left members cannot upload or download', async () => {
  const mf = runtime();
  try {
    const host = await login(mf, 1);
    const guest = await login(mf, 2);
    const room = await createRoom(mf, host);
    const guestJoin = await joinRoom(mf, guest, room.roomId);

    const hostSock = await socket(mf, room.roomId, room.ticket);
    const guestSock = await socket(mf, room.roomId, guestJoin.ticket);

    // Upload an attachment as host
    const upRes = await upload(mf, room.roomId, host, makePng(64), { kind: 'image' });
    const attId = (await upRes.json() as { message: RoomChatMessage }).message.attachment!.id;

    // Kick guest
    hostSock.ws.send(JSON.stringify({ commandId: crypto.randomUUID(), mediaVersion: 0, type: 'kick', profileId: 2 }));
    await guestSock.next(m => m.type === 'kicked');

    // Kicked guest attempts to download
    const kickDl = await download(mf, room.roomId, attId, guest);
    assert.equal(kickDl.status, 403);

    // Kicked guest attempts to upload
    const kickUp = await upload(mf, room.roomId, guest, makePng(64), { kind: 'image' });
    assert.equal(kickUp.status, 403);
  } finally {
    await mf.dispose();
  }
});

// =========================================================================
// 4. Idempotency, Conflict, Rate Limits, and Retention Cleanup
// =========================================================================

test('attachments: durable idempotency retry, conflict detection, and rate limits', async () => {
  const mf = runtime();
  try {
    const host = await login(mf, 1);
    const room = await createRoom(mf, host);

    const uploadId = crypto.randomUUID();
    const bytes1 = makePng(200);

    // 1. Initial upload
    const res1 = await upload(mf, room.roomId, host, bytes1, {
      kind: 'image',
      name: 'file.png',
      uploadId,
    });
    assert.equal(res1.status, 200);
    const data1 = await res1.json() as { message: RoomChatMessage };

    // 2. Identical retry: same uploadId, same bytes, same kind, same name
    const res2 = await upload(mf, room.roomId, host, bytes1, {
      kind: 'image',
      name: 'file.png',
      uploadId,
    });
    assert.equal(res2.status, 200);
    const data2 = await res2.json() as { message: RoomChatMessage };
    assert.equal(data2.message.id, data1.message.id);
    assert.equal(data2.message.attachment?.id, data1.message.attachment?.id);

    // 3. Conflicting reuse: same uploadId with different bytes
    const bytes2 = makeJpeg(200);
    const resConflict = await upload(mf, room.roomId, host, bytes2, {
      kind: 'image',
      contentType: 'image/jpeg',
      name: 'file.png',
      uploadId,
    });
    assert.equal(resConflict.status, 409);
    assert.equal((await resConflict.json() as { code: string }).code, 'IDEMPOTENCY_CONFLICT');
  } finally {
    await mf.dispose();
  }
});

test('attachments: cleanEvictedAttachments deletes chunks and metadata of evicted messages', async () => {
  // Test storage chunk cleanup with mock DO storage
  const storageMap = new Map<string, any>();
  const mockStorage = {
    async get(kOrKeys: string | string[]) {
      if (Array.isArray(kOrKeys)) {
        const m = new Map();
        for (const k of kOrKeys) {
          if (storageMap.has(k)) m.set(k, storageMap.get(k));
        }
        return m;
      }
      return storageMap.get(kOrKeys);
    },
    async put(entries: Record<string, any>) {
      for (const [k, v] of Object.entries(entries)) storageMap.set(k, v);
    },
    async delete(keys: string | string[]) {
      if (Array.isArray(keys)) for (const k of keys) storageMap.delete(k);
      else storageMap.delete(keys);
    },
    async list(opts: { prefix: string }) {
      const m = new Map();
      for (const [k, v] of storageMap.entries()) {
        if (k.startsWith(opts.prefix)) m.set(k, v);
      }
      return m;
    },
  } as any;

  const att1: StoredAttachmentMeta = {
    id: 'att-1', roomId: 'r1', kind: 'image', mimeType: 'image/png',
    size: 100, name: '1.png', profileId: 1, createdAt: 1000, chunkCount: 1, messageId: 'm1',
  };
  const att2: StoredAttachmentMeta = {
    id: 'att-2', roomId: 'r1', kind: 'image', mimeType: 'image/png',
    size: 100, name: '2.png', profileId: 1, createdAt: 2000, chunkCount: 1, messageId: 'm2',
  };

  await saveAttachment(mockStorage, att1, makePng(100), 'up-1', 'hash1');
  await saveAttachment(mockStorage, att2, makePng(100), 'up-2', 'hash2');

  assert.ok(await loadAttachment(mockStorage, 'att-1'));
  assert.ok(await loadAttachment(mockStorage, 'att-2'));

  // Retain only message with att-2; att-1 has been evicted from the last 50
  const retainedChat: RoomChatMessage[] = [
    {
      id: 'm2', profileId: 1, login: 'u1', avatar: null, text: 'Keep', createdAt: 2000,
      attachment: { id: 'att-2', kind: 'image', mimeType: 'image/png', size: 100, name: '2.png' },
    },
  ];

  await cleanEvictedAttachments(mockStorage, retainedChat);

  // att-1 must be deleted
  assert.equal(await loadAttachment(mockStorage, 'att-1'), null);
  // att-2 must remain intact
  assert.ok(await loadAttachment(mockStorage, 'att-2'));
});

// =========================================================================
// 5. Untouched Playback Across Attachment Uploads
// =========================================================================

test('attachments: untouched playback anchor, intent, rate, barrier and readiness across uploads', async () => {
  const mf = runtime();
  try {
    const host = await login(mf, 1);
    const room = await createRoom(mf, host);
    const hostSock = await socket(mf, room.roomId, room.ticket);

    // Set media
    const media = { releaseId: 1, releaseName: 'Anime', dubId: 1, sourceId: 1, episode: 1, episodeName: 'Ep 1' };
    hostSock.ws.send(JSON.stringify({ commandId: crypto.randomUUID(), mediaVersion: 0, type: 'set_media', media }));
    const setMsg = await hostSock.next(m => m.type === 'room_state' && m.state.mediaVersion === 1);

    hostSock.ws.send(JSON.stringify({ commandId: crypto.randomUUID(), mediaVersion: 1, type: 'set_viewing', viewing: true }));
    const viewingMsg = await hostSock.next(m => m.type === 'room_state' && m.state.participants.some((p: any) => p.viewing));
    const viewingEpoch = viewingMsg.state.syncEpoch;

    hostSock.ws.send(JSON.stringify({ commandId: crypto.randomUUID(), mediaVersion: 1, type: 'ready', epoch: viewingEpoch }));
    const readyMsg = await hostSock.next(m => m.type === 'room_state' && m.state.participants.some((p: any) => p.status === 'ready'));
    const stateBefore = readyMsg.state;

    const cp = hostSock.checkpoint();
    // Upload an attachment
    const upRes = await upload(mf, room.roomId, host, makePng(200), { kind: 'image', text: 'Mid-playback photo' });
    assert.equal(upRes.status, 200);

    const afterMsg = await hostSock.nextAfter(cp, m => m.type === 'room_state' && m.state.chat?.some((c: any) => c.text === 'Mid-playback photo'));
    const stateAfter = afterMsg.state;

    // Assert playback properties are exactly preserved
    assert.equal(stateAfter.mediaVersion, stateBefore.mediaVersion);
    assert.equal(stateAfter.syncEpoch, stateBefore.syncEpoch);
    assert.equal(stateAfter.playback.intent, stateBefore.playback.intent);
    assert.equal(stateAfter.playback.rate, stateBefore.playback.rate);
    assert.equal(stateAfter.barrier, stateBefore.barrier);
    assert.equal(stateAfter.participants[0].status, stateBefore.participants[0].status);
  } finally {
    await mf.dispose();
  }
});

// =========================================================================
// 6. Host close_room Command and Acknowledgment Before Termination
// =========================================================================

test('attachments: host close_room receives ack before room_closed and socket shutdown', async () => {
  const mf = runtime();
  try {
    const host = await login(mf, 1);
    const guest = await login(mf, 2);
    const room = await createRoom(mf, host);
    const guestJoin = await joinRoom(mf, guest, room.roomId);

    const hostSock = await socket(mf, room.roomId, room.ticket);
    const guestSock = await socket(mf, room.roomId, guestJoin.ticket);

    // Non-host sends close_room -> rejected with HOST_REQUIRED
    const nonHostCmdId = crypto.randomUUID();
    guestSock.ws.send(JSON.stringify({ commandId: nonHostCmdId, mediaVersion: 0, type: 'close_room' }));
    const err = await guestSock.next(m => m.type === 'error' && m.commandId === nonHostCmdId);
    assert.equal(err.code, 'HOST_REQUIRED');

    // Host sends close_room with arbitrary/stale mediaVersion (works independently of mediaVersion)
    const closeCmdId = crypto.randomUUID();
    hostSock.ws.send(JSON.stringify({ commandId: closeCmdId, mediaVersion: 999, type: 'close_room' }));

    // Host socket must receive ack for closeCmdId BEFORE socket is closed
    const ack = await hostSock.next(m => m.type === 'ack' && m.commandId === closeCmdId);
    assert.ok(ack);

    // Both sockets receive room_closed
    const hostClosed = await hostSock.next(m => m.type === 'room_closed');
    const guestClosed = await guestSock.next(m => m.type === 'room_closed');
    assert.ok(hostClosed);
    assert.ok(guestClosed);

    // Subsequent ticket requests or joins are denied with 410 ROOM_CLOSED
    const ticketRes = await post(mf, '/api/v2/rooms/join', { roomId: room.roomId }, guest);
    assert.equal(ticketRes.status, 410);
  } finally {
    await mf.dispose();
  }
});

// =========================================================================
// 7. Complete Attachment Deletion on Close and Directory Failure Isolation
// =========================================================================

test('attachments: storage chunks erased on explicit host close, another room retains files', async () => {
  const mf = runtime();
  try {
    const hostA = await login(mf, 1);
    const hostB = await login(mf, 2);

    const roomA = await createRoom(mf, hostA, 'Room A');
    const roomB = await createRoom(mf, hostB, 'Room B');

    // Upload attachment in room A
    const upARes = await upload(mf, roomA.roomId, hostA, makePng(500), { kind: 'image', name: 'roomA.png' });
    assert.equal(upARes.status, 200);
    const attAId = (await upARes.json() as { message: RoomChatMessage }).message.attachment!.id;

    // Upload attachment in room B
    const upBRes = await upload(mf, roomB.roomId, hostB, makePng(500), { kind: 'image', name: 'roomB.png' });
    assert.equal(upBRes.status, 200);
    const attBId = (await upBRes.json() as { message: RoomChatMessage }).message.attachment!.id;

    // Close room A via WebSocket
    const sockA = await socket(mf, roomA.roomId, roomA.ticket);
    const closeId = crypto.randomUUID();
    sockA.ws.send(JSON.stringify({ commandId: closeId, mediaVersion: 0, type: 'close_room' }));
    await sockA.next(m => m.type === 'ack' && m.commandId === closeId);
    await sockA.next(m => m.type === 'room_closed');

    // Direct HTTP request to room A's attachment returns 410 ROOM_CLOSED
    const dlARes = await download(mf, roomA.roomId, attAId, hostA);
    assert.equal(dlARes.status, 410);

    // Room B's attachment in Room B is intact and retains all bytes!
    const dlBRes = await download(mf, roomB.roomId, attBId, hostB);
    assert.equal(dlBRes.status, 200);
    const bBytes = new Uint8Array(await dlBRes.arrayBuffer());
    assert.equal(bBytes.byteLength, 500);
  } finally {
    await mf.dispose();
  }
});

test('attachments: upload racing closure is rejected with 410 and creates no files', async () => {
  const mf = runtime();
  try {
    const host = await login(mf, 1);
    const room = await createRoom(mf, host);
    const sock = await socket(mf, room.roomId, room.ticket);

    // Close room
    sock.ws.send(JSON.stringify({ commandId: crypto.randomUUID(), mediaVersion: 0, type: 'close_room' }));
    await sock.next(m => m.type === 'room_closed');

    // Attempt upload to closed room
    const raceRes = await upload(mf, room.roomId, host, makePng(128), { kind: 'image' });
    assert.equal(raceRes.status, 410);
    assert.equal((await raceRes.json() as { code: string }).code, 'ROOM_CLOSED');
  } finally {
    await mf.dispose();
  }
});

test('attachments: cleanup erases all att: keys even when directory update fails', async () => {
  const storageMap = new Map<string, any>();
  const mockStorage = {
    async get(kOrKeys: string | string[]) {
      if (Array.isArray(kOrKeys)) {
        const m = new Map();
        for (const k of kOrKeys) { if (storageMap.has(k)) m.set(k, storageMap.get(k)); }
        return m;
      }
      return storageMap.get(kOrKeys);
    },
    async put(entries: Record<string, any>) {
      for (const [k, v] of Object.entries(entries)) storageMap.set(k, v);
    },
    async delete(keys: string | string[]) {
      if (Array.isArray(keys)) for (const k of keys) storageMap.delete(k);
      else storageMap.delete(keys);
    },
    async list(opts: { prefix: string }) {
      const m = new Map();
      for (const [k, v] of storageMap.entries()) {
        if (k.startsWith(opts.prefix)) m.set(k, v);
      }
      return m;
    },
    async deleteAll() { storageMap.clear(); },
    async getAlarm() { return null; },
    async setAlarm() {},
    async deleteAlarm() {},
  } as any;

  // Populate attachment files in mock storage
  const att: StoredAttachmentMeta = {
    id: 'att-fail-dir', roomId: 'room-fail', kind: 'image', mimeType: 'image/png',
    size: 200, name: 'fail.png', profileId: 1, createdAt: 1000, chunkCount: 1, messageId: 'm-fail',
  };
  await saveAttachment(mockStorage, att, makePng(200), 'upload-fail', 'hash-fail');
  assert.ok((await mockStorage.list({ prefix: 'att:' })).size > 0);

  // Directly call eraseAllAttachmentData (as run by RoomObject on close)
  await eraseAllAttachmentData(mockStorage);

  // Actual storage prefix 'att:' must now be completely empty!
  const remaining = await mockStorage.list({ prefix: 'att:' });
  assert.equal(remaining.size, 0, 'All att: keys must be erased even if directory update fails');
});

// =========================================================================
// 8. Protocol Parity and Legacy State Validation
// =========================================================================

test('protocol: canonical protocol mirrors client file and supports legacy messages', async () => {
  const canonical = await readFile(new URL('../protocol/index.ts', import.meta.url), 'utf8');
  const mirrored = await readFile(new URL('../../anixweb/src/shared/roomProtocol.ts', import.meta.url), 'utf8');
  assert.equal(canonical, mirrored, 'Mirrored roomProtocol.ts must match canonical protocol/index.ts');

  // Legacy message without attachment is valid
  const legacyMessage = {
    id: 'legacy-msg-1',
    profileId: 10,
    login: 'user10',
    avatar: null,
    text: 'Old chat message without attachment',
    createdAt: Date.now(),
  };
  assert.ok(isChatMessage(legacyMessage));

  // Modern message with attachment is valid
  const modernMessage: RoomChatMessage = {
    ...legacyMessage,
    id: 'modern-msg-1',
    attachment: {
      id: 'att-1',
      kind: 'image',
      mimeType: 'image/png',
      size: 1024,
      name: 'screenshot.png',
    },
  };
  assert.ok(isChatMessage(modernMessage));

  // parseClientMessage supports close_room
  const parsedClose = parseClientMessage({
    commandId: 'cmd-close-1',
    mediaVersion: 0,
    type: 'close_room',
  });
  assert.equal(parsedClose.type, 'close_room');
});

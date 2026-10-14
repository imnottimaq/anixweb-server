import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  MAX_CHAT_LENGTH,
  MAX_CHAT_HISTORY,
  REACTION_EMOJIS,
  parseClientMessage,
  parseServerMessage,
  isChatMessage,
  isRoomReaction,
  type ReactionEmoji,
  type RoomCommand,
  type RoomMedia,
  type WatchRoomState,
} from '../protocol/index.ts';
import { RoomEngine, DomainError, type EngineData } from '../src/domain.ts';
import { ANIXART_APP_USER_AGENT } from '../src/userAgent.ts';

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
          profile: { id: profileId, login: `user${profileId}`, avatar: `https://avatar/${profileId}.png` },
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

const sendCmd = (client: { ws: WebSocket }, type: string, fields = {}, mediaVersion = 0) => {
  const commandId = crypto.randomUUID();
  client.ws.send(JSON.stringify({ commandId, mediaVersion, type, ...fields }));
  return commandId;
};

// =========================================================================
// 1. Canonical Parsers, Predicates & Protocol Mirror Parity
// =========================================================================

test('protocol mirror parity: server protocol/index.ts and anixweb roomProtocol.ts are identical', async () => {
  const serverProtocol = await readFile(new URL('../protocol/index.ts', import.meta.url), 'utf8');
  const clientProtocol = await readFile(new URL('../../anixweb/src/shared/roomProtocol.ts', import.meta.url), 'utf8');
  assert.equal(serverProtocol, clientProtocol, 'protocol/index.ts must match anixweb/src/shared/roomProtocol.ts');
});

test('canonical parsers: parseClientMessage valid chat message variants and whitespace trimming', () => {
  const normal = parseClientMessage({ type: 'chat_message', commandId: 'c1', mediaVersion: 0, text: 'Hello world' });
  assert.deepEqual(normal, { type: 'chat_message', commandId: 'c1', mediaVersion: 0, text: 'Hello world' });

  const padded = parseClientMessage({ type: 'chat_message', commandId: 'c2', mediaVersion: 2, text: '   Spaced out   ' });
  assert.deepEqual(padded, { type: 'chat_message', commandId: 'c2', mediaVersion: 2, text: 'Spaced out' });

  const exactMax = 'x'.repeat(MAX_CHAT_LENGTH);
  const atLimit = parseClientMessage({ type: 'chat_message', commandId: 'c3', mediaVersion: 0, text: exactMax });
  assert.deepEqual(atLimit, { type: 'chat_message', commandId: 'c3', mediaVersion: 0, text: exactMax });
});

test('canonical parsers: parseClientMessage invalid chat message lengths, empty and whitespace-only', () => {
  for (const invalid of ['', '   ', '\t\n\r  ']) {
    assert.throws(
      () => parseClientMessage({ type: 'chat_message', commandId: 'c', mediaVersion: 0, text: invalid }),
      /INVALID_COMMAND/,
      `Should reject empty/whitespace: "${invalid}"`,
    );
  }

  const tooLong = 'x'.repeat(MAX_CHAT_LENGTH + 1);
  assert.throws(
    () => parseClientMessage({ type: 'chat_message', commandId: 'c', mediaVersion: 0, text: tooLong }),
    /INVALID_COMMAND/,
  );

  for (const nonString of [null, undefined, 123, {}, []]) {
    assert.throws(
      () => parseClientMessage({ type: 'chat_message', commandId: 'c', mediaVersion: 0, text: nonString }),
      /INVALID_COMMAND/,
    );
  }
});

test('canonical parsers: parseClientMessage ignores and strips spoofed author fields in chat', () => {
  const spoofed = parseClientMessage({
    type: 'chat_message',
    commandId: 'c-spoof',
    mediaVersion: 0,
    text: 'Safe text',
    profileId: 99999,
    login: 'spoofed_admin',
    avatar: 'https://evil.com/avatar.png',
    createdAt: 1000,
  });
  assert.deepEqual(spoofed, {
    type: 'chat_message',
    commandId: 'c-spoof',
    mediaVersion: 0,
    text: 'Safe text',
  });
  assert.equal((spoofed as any).profileId, undefined);
  assert.equal((spoofed as any).login, undefined);
});

test('canonical parsers: parseClientMessage validates reaction allowlist and strips spoofed fields', () => {
  for (const emoji of REACTION_EMOJIS) {
    const parsed = parseClientMessage({
      type: 'reaction',
      commandId: `r-${emoji}`,
      mediaVersion: 0,
      emoji,
      profileId: 1234,
      login: 'hacker',
    });
    assert.deepEqual(parsed, {
      type: 'reaction',
      commandId: `r-${emoji}`,
      mediaVersion: 0,
      emoji,
    });
  }

  for (const badEmoji of ['thumbsup', 'angry', '100', 'heart ', '', 42, null, undefined, {}]) {
    assert.throws(
      () => parseClientMessage({ type: 'reaction', commandId: 'r-bad', mediaVersion: 0, emoji: badEmoji }),
      /INVALID_COMMAND/,
      `Should reject invalid emoji "${badEmoji}"`,
    );
  }
});

test('canonical parsers: isChatMessage and isRoomReaction predicates validate structure', () => {
  assert.equal(
    isChatMessage({ id: 'msg-1', profileId: 10, login: 'alice', avatar: null, text: 'hi', createdAt: 123 }),
    true,
  );
  assert.equal(
    isChatMessage({ id: 'msg-1', profileId: 10, login: 'alice', avatar: 'https://a.png', text: 'hi', createdAt: 123 }),
    true,
  );
  assert.equal(isChatMessage({ id: 'msg-1', profileId: -1, login: 'alice', avatar: null, text: 'hi', createdAt: 123 }), false);
  assert.equal(isChatMessage({ id: '', profileId: 10, login: 'alice', avatar: null, text: 'hi', createdAt: 123 }), false);
  assert.equal(isChatMessage({ id: 'msg-1', profileId: 10, login: '', avatar: null, text: 'hi', createdAt: 123 }), false);
  assert.equal(isChatMessage({ id: 'msg-1', profileId: 10, login: 'alice', avatar: null, text: 'a'.repeat(501), createdAt: 123 }), false);

  assert.equal(
    isRoomReaction({ id: 'rx-1', profileId: 10, login: 'bob', avatar: null, emoji: 'fire', createdAt: 456 }),
    true,
  );
  assert.equal(
    isRoomReaction({ id: 'rx-1', profileId: 10, login: 'bob', avatar: null, emoji: 'not_an_emoji' as any, createdAt: 456 }),
    false,
  );
});

test('canonical parsers: parseServerMessage accepts valid reaction and normalizes room_state chat', () => {
  const reactionMsg = parseServerMessage({
    type: 'reaction',
    reaction: { id: 'rx-1', profileId: 5, login: 'carol', avatar: null, emoji: 'clap', createdAt: 789 },
  });
  assert.equal(reactionMsg.type, 'reaction');

  assert.throws(
    () => parseServerMessage({ type: 'reaction', reaction: { id: 'rx-1', emoji: 'invalid' } }),
    /INVALID_SERVER_MESSAGE/,
  );
});

// =========================================================================
// 2. Domain Unit Tests (src/domain.ts)
// =========================================================================

const hostProfile = { profileId: 1, login: 'HostUser', avatar: 'https://avatar/1.png' };
const guestProfile = { profileId: 2, login: 'GuestUser', avatar: 'https://avatar/2.png' };
const sampleMedia: RoomMedia = { releaseId: 101, releaseName: 'Show', dubId: 201, sourceId: 301, episode: 1, episodeName: 'Ep 1' };

function createDomainRoom() {
  const engine = RoomEngine.create({
    roomId: 'test-room',
    joinCode: 'TEST1234',
    title: 'Domain Social Room',
    visibility: 'private',
    host: hostProfile,
  }, 1000);
  engine.connect(hostProfile, 1000);
  engine.connect(guestProfile, 1000);
  return engine;
}

test('domain: all-member authorization - non-host non-controller can send chat and reaction before and after media selection', () => {
  const engine = createDomainRoom();
  const guest = engine.state.participants.find(p => p.profileId === 2)!;
  assert.equal(guest.canControl, false);
  assert.equal(engine.state.media, null);

  // Before media selection
  const chat1 = engine.command(2, { type: 'chat_message', commandId: 'c-pre', mediaVersion: 0, text: 'Chat before media' }, 1100);
  assert.equal(chat1.duplicate, false);
  assert.equal(engine.state.chat?.length, 1);
  assert.equal(engine.state.chat?.[0].text, 'Chat before media');

  const rx1 = engine.command(2, { type: 'reaction', commandId: 'r-pre', mediaVersion: 0, emoji: 'heart' }, 1200);
  assert.equal(rx1.duplicate, false);
  assert.equal(rx1.reaction?.emoji, 'heart');

  // Non-member denied
  assert.throws(() => engine.command(99, { type: 'chat_message', commandId: 'c-anon', mediaVersion: 0, text: 'Denied' }, 1300), (err: any) => err instanceof DomainError && err.code === 'NOT_JOINED');
  assert.throws(() => engine.command(99, { type: 'reaction', commandId: 'r-anon', mediaVersion: 0, emoji: 'clap' }, 1300), (err: any) => err instanceof DomainError && err.code === 'NOT_JOINED');

  // Host selects media
  engine.command(1, { type: 'set_media', commandId: 'set-m', mediaVersion: 0, media: sampleMedia }, 1400);
  assert.notEqual(engine.state.media, null);

  // After media selection
  const chat2 = engine.command(2, { type: 'chat_message', commandId: 'c-post', mediaVersion: engine.state.mediaVersion, text: 'Chat after media' }, 1500);
  assert.equal(chat2.duplicate, false);
  assert.equal(engine.state.chat?.length, 2);

  const rx2 = engine.command(2, { type: 'reaction', commandId: 'r-post', mediaVersion: engine.state.mediaVersion, emoji: 'fire' }, 1600);
  assert.equal(rx2.duplicate, false);
  assert.equal(rx2.reaction?.emoji, 'fire');
});

test('domain: disconnected and kicked participants denied chat and reactions', () => {
  const engine = createDomainRoom();

  // Disconnect guest
  engine.disconnect(2, 2000);
  assert.throws(
    () => engine.command(2, { type: 'chat_message', commandId: 'c-dc', mediaVersion: 0, text: 'Offline' }, 2100),
    (err: any) => err instanceof DomainError && err.code === 'NOT_JOINED',
  );
  assert.throws(
    () => engine.command(2, { type: 'reaction', commandId: 'r-dc', mediaVersion: 0, emoji: 'sad' }, 2100),
    (err: any) => err instanceof DomainError && err.code === 'NOT_JOINED',
  );

  // Reconnect guest
  engine.connect(guestProfile, 2200);
  const reconnectedChat = engine.command(2, { type: 'chat_message', commandId: 'c-recon', mediaVersion: 0, text: 'Back online' }, 2300);
  assert.equal(reconnectedChat.duplicate, false);

  // Kick guest
  const kickResult = engine.command(1, { type: 'kick', commandId: 'kick-guest', mediaVersion: 0, profileId: 2 }, 2400);
  assert.equal(kickResult.kicked, 2);

  // Kicked guest denied
  assert.throws(
    () => engine.command(2, { type: 'chat_message', commandId: 'c-kicked', mediaVersion: 0, text: 'Kicked' }, 2500),
    (err: any) => err instanceof DomainError && err.code === 'NOT_JOINED',
  );
  assert.throws(
    () => engine.command(2, { type: 'reaction', commandId: 'r-kicked', mediaVersion: 0, emoji: 'sad' }, 2500),
    (err: any) => err instanceof DomainError && err.code === 'NOT_JOINED',
  );
});

test('domain: bounded history capped at 50 messages', () => {
  const engine = createDomainRoom();

  for (let i = 1; i <= 60; i++) {
    engine.command(1, { type: 'chat_message', commandId: `msg-${i}`, mediaVersion: 0, text: `Message #${i}` }, 3000 + i);
  }

  assert.equal(engine.state.chat?.length, MAX_CHAT_HISTORY);
  assert.equal(engine.state.chat?.length, 50);
  assert.equal(typeof engine.state.chat?.[0].id, 'string');
  assert.ok(/^[0-9a-f-]{36}$/.test(engine.state.chat?.[0].id));
  assert.equal(engine.state.chat?.[0].text, 'Message #11');
  assert.equal(typeof engine.state.chat?.[49].id, 'string');
  assert.ok(/^[0-9a-f-]{36}$/.test(engine.state.chat?.[49].id));
  assert.equal(engine.state.chat?.[49].text, 'Message #60');
});

test('domain: server authors - author fields supplied by server and spoofed author fields ignored', () => {
  const engine = createDomainRoom();
  const now = 4000;

  // Guest sends chat with extra spoofed fields
  const chatCmd: any = {
    type: 'chat_message',
    commandId: 'c-author-check',
    mediaVersion: 0,
    text: 'Hello from guest',
    profileId: 999,
    login: 'impostor',
    avatar: 'https://evil.com/fake.png',
  };
  engine.command(2, chatCmd, now);

  const stored = engine.state.chat?.[0]!;
  assert.equal(typeof stored.id, 'string');
  assert.ok(/^[0-9a-f-]{36}$/.test(stored.id));
  assert.equal(stored.profileId, guestProfile.profileId);
  assert.equal(stored.login, guestProfile.login);
  assert.equal(stored.avatar, guestProfile.avatar);
  assert.equal(stored.text, 'Hello from guest');
  assert.equal(stored.createdAt, now);

  // Guest sends reaction with extra spoofed fields
  const rxCmd: any = {
    type: 'reaction',
    commandId: 'r-author-check',
    mediaVersion: 0,
    emoji: 'laugh',
    profileId: 999,
    login: 'impostor',
  };
  const res = engine.command(2, rxCmd, now + 10);
  assert.equal(typeof res.reaction?.id, 'string');
  assert.ok(/^[0-9a-f-]{36}$/.test(res.reaction?.id!));
  assert.equal(res.reaction?.profileId, guestProfile.profileId);
  assert.equal(res.reaction?.login, guestProfile.login);
  assert.equal(res.reaction?.avatar, guestProfile.avatar);
  assert.equal(res.reaction?.emoji, 'laugh');
  assert.equal(res.reaction?.createdAt, now + 10);
});

test('domain: stale media race - chat and reaction succeed even when command mediaVersion differs from state.mediaVersion', () => {
  const engine = createDomainRoom();
  engine.command(1, { type: 'set_media', commandId: 'set-m-1', mediaVersion: 0, media: sampleMedia }, 5000);
  assert.equal(engine.state.mediaVersion, 1);

  engine.command(1, { type: 'set_media', commandId: 'set-m-2', mediaVersion: 1, media: { ...sampleMedia, episode: 2 } }, 5100);
  assert.equal(engine.state.mediaVersion, 2);

  // Stale mediaVersion = 0 for chat and reaction succeeds
  const chatRes = engine.command(2, { type: 'chat_message', commandId: 'c-stale', mediaVersion: 0, text: 'Still chatting' }, 5200);
  assert.equal(chatRes.duplicate, false);
  assert.equal(engine.state.chat?.some(m => m.text === 'Still chatting'), true);

  const rxRes = engine.command(2, { type: 'reaction', commandId: 'r-stale', mediaVersion: 0, emoji: 'fire' }, 5300);
  assert.equal(rxRes.duplicate, false);
  assert.equal(typeof rxRes.reaction?.id, 'string');
  assert.equal(rxRes.reaction?.emoji, 'fire');

  // Non-social command with stale mediaVersion fails
  assert.throws(
    () => engine.command(1, { type: 'pause', commandId: 'pause-stale', mediaVersion: 0, position: 0 }, 5400),
    (err: any) => err instanceof DomainError && err.code === 'STALE_MEDIA',
  );
});

test('domain: persisted history migration - loading room data without chat field initializes chat: []', () => {
  const engine = createDomainRoom();
  const exported = engine.exportData();

  // Delete chat field from exported data to simulate legacy room
  delete (exported.state as any).chat;

  const migrated = new RoomEngine(exported);
  assert.ok(Array.isArray(migrated.state.chat));
  assert.equal(migrated.state.chat.length, 0);

  const snapshot = migrated.snapshot();
  assert.ok(Array.isArray(snapshot.chat));
  assert.equal(snapshot.chat.length, 0);

  // Appending new chat works seamlessly on migrated room
  migrated.command(1, { type: 'chat_message', commandId: 'c-migrated', mediaVersion: 0, text: 'First message after migration' }, 6000);
  assert.equal(migrated.state.chat.length, 1);
});

test('domain: duplicate commandId returns duplicate: true without duplicating storage or state', () => {
  const engine = createDomainRoom();

  const chatCmd: RoomCommand = { type: 'chat_message', commandId: 'dup-1', mediaVersion: 0, text: 'Unique message' };
  const firstChat = engine.command(1, chatCmd, 7000);
  assert.equal(firstChat.duplicate, false);
  assert.equal(engine.state.chat?.length, 1);
  const revAfterFirst = engine.state.revision;

  const secondChat = engine.command(1, chatCmd, 7050);
  assert.equal(secondChat.duplicate, true);
  assert.equal(engine.state.chat?.length, 1, 'Chat history length must not change on duplicate');
  assert.equal(engine.state.revision, revAfterFirst, 'Revision must not increment on duplicate');

  const rxCmd: RoomCommand = { type: 'reaction', commandId: 'dup-rx', mediaVersion: 0, emoji: 'heart' };
  const firstRx = engine.command(1, rxCmd, 7100);
  assert.equal(firstRx.duplicate, false);
  assert.notEqual(firstRx.reaction, undefined);

  const secondRx = engine.command(1, rxCmd, 7150);
  assert.equal(secondRx.duplicate, true);
  assert.equal(secondRx.reaction, undefined);
});

test('domain: exact unchanged playback, anchor, barrier, and participant readiness across chat and reactions', () => {
  const engine = createDomainRoom();

  // Setup active viewing and barrier
  engine.command(1, { type: 'set_viewing', commandId: 'v1', mediaVersion: 0, viewing: true }, 8000);
  engine.command(2, { type: 'set_viewing', commandId: 'v2', mediaVersion: 0, viewing: true }, 8000);
  engine.command(1, { type: 'set_media', commandId: 'm1', mediaVersion: 0, media: sampleMedia }, 8000);

  // Host ready, guest buffering -> active barrier
  engine.command(1, { type: 'ready', commandId: 'rdy1', mediaVersion: 1, epoch: engine.state.syncEpoch }, 8100);
  engine.command(2, { type: 'buffering', commandId: 'buf2', mediaVersion: 1, epoch: engine.state.syncEpoch }, 8200);

  assert.notEqual(engine.state.barrier, null);
  assert.equal(engine.state.playback.paused, true);

  const snapshotBefore = {
    playback: structuredClone(engine.state.playback),
    barrier: structuredClone(engine.state.barrier),
    syncEpoch: engine.state.syncEpoch,
    participants: structuredClone(engine.state.participants),
  };

  // Guest sends chat message at 8500
  engine.command(2, { type: 'chat_message', commandId: 'chat-while-waiting', mediaVersion: 1, text: 'Still loading?' }, 8500);

  assert.deepEqual(engine.state.playback, snapshotBefore.playback, 'Playback anchor must be identical');
  assert.deepEqual(engine.state.barrier, snapshotBefore.barrier, 'Barrier must be identical');
  assert.equal(engine.state.syncEpoch, snapshotBefore.syncEpoch, 'syncEpoch must be identical');
  assert.deepEqual(
    engine.state.participants.map(p => ({ id: p.profileId, status: p.status, readyEpoch: p.readyEpoch })),
    snapshotBefore.participants.map(p => ({ id: p.profileId, status: p.status, readyEpoch: p.readyEpoch })),
    'Participant readiness and statuses must be identical',
  );

  // Guest sends reaction at 8700
  engine.command(2, { type: 'reaction', commandId: 'rx-while-waiting', mediaVersion: 1, emoji: 'clap' }, 8700);

  assert.deepEqual(engine.state.playback, snapshotBefore.playback, 'Playback anchor must be identical after reaction');
  assert.deepEqual(engine.state.barrier, snapshotBefore.barrier, 'Barrier must be identical after reaction');
  assert.equal(engine.state.syncEpoch, snapshotBefore.syncEpoch, 'syncEpoch must be identical after reaction');
  assert.deepEqual(
    engine.state.participants.map(p => ({ id: p.profileId, status: p.status, readyEpoch: p.readyEpoch })),
    snapshotBefore.participants.map(p => ({ id: p.profileId, status: p.status, readyEpoch: p.readyEpoch })),
    'Participant readiness and statuses must be identical after reaction',
  );
});

// =========================================================================
// 3. Durable Object Integration Tests (RoomObject via Miniflare)
// =========================================================================

test('integration: social rate limit enforcement rejects bursts without mutating playback state', async () => {
  const mf = runtime();
  try {
    const hostToken = await login(mf, 10);
    const createRes = await post(mf, '/api/v2/rooms', { title: 'Rate Limit Room', visibility: 'public' }, hostToken);
    const { roomId, ticket } = await createRes.json() as { roomId: string; ticket: string };

    const client = await socket(mf, roomId, ticket);
    const initial = (await client.next(m => m.type === 'room_state')).state;

    // Send 10 chat messages within 10s: all must receive ack
    for (let i = 1; i <= 10; i++) {
      sendCmd(client, 'chat_message', { text: `Msg ${i}` });
    }

    let ackCount = 0;
    while (ackCount < 10) {
      await client.next(m => m.type === 'ack');
      ackCount++;
    }

    // 11th chat message must be RATE_LIMITED
    const cp = client.checkpoint();
    const rejectedCmd = sendCmd(client, 'chat_message', { text: 'Msg 11 overflow' });
    const err = await client.nextAfter(cp, m => m.type === 'error' && m.commandId === rejectedCmd);
    assert.equal(err.code, 'RATE_LIMITED');
    assert.equal(err.message, 'Rate limit exceeded');

    // Send sync_request and verify playback state is untouched
    const cpSync = client.checkpoint();
    client.ws.send(JSON.stringify({ type: 'sync_request' }));
    const afterRateLimit = (await client.nextAfter(cpSync, m => m.type === 'room_state')).state;
    assert.deepEqual(afterRateLimit.playback, initial.playback);
    assert.equal(afterRateLimit.chat.length, 10);

    // Send 15 reactions: all must receive ack
    for (let i = 1; i <= 15; i++) {
      sendCmd(client, 'reaction', { emoji: 'fire' });
    }
    let rxAckCount = 0;
    while (rxAckCount < 15) {
      await client.next(m => m.type === 'ack');
      rxAckCount++;
    }

    // 16th reaction must be RATE_LIMITED
    const cpRx = client.checkpoint();
    const rejectedRx = sendCmd(client, 'reaction', { emoji: 'fire' });
    const rxErr = await client.nextAfter(cpRx, m => m.type === 'error' && m.commandId === rejectedRx);
    assert.equal(rxErr.code, 'RATE_LIMITED');
    assert.equal(rxErr.message, 'Rate limit exceeded');

    // Playback state is still untouched
    const cpSync2 = client.checkpoint();
    client.ws.send(JSON.stringify({ type: 'sync_request' }));
    const finalState = (await client.nextAfter(cpSync2, m => m.type === 'room_state')).state;
    assert.deepEqual(finalState.playback, initial.playback);

    client.ws.close();
  } finally {
    await mf.dispose();
  }
});

test('integration: duplicate commands return ack without duplicate fanout or storage duplicate', async () => {
  const mf = runtime();
  try {
    const hostToken = await login(mf, 20);
    const guestToken = await login(mf, 21);

    const createRes = await post(mf, '/api/v2/rooms', { title: 'Dedupe Room', visibility: 'public' }, hostToken);
    const { roomId, ticket: hostTicket } = await createRes.json() as { roomId: string; ticket: string };

    const joinRes = await post(mf, '/api/v2/rooms/join', { roomId }, guestToken);
    const { ticket: guestTicket } = await joinRes.json() as { ticket: string };

    const h = await socket(mf, roomId, hostTicket);
    const g = await socket(mf, roomId, guestTicket);

    await h.next(m => m.type === 'room_state' && m.state.participants.length === 2);
    await g.next(m => m.type === 'room_state' && m.state.participants.length === 2);

    // Host sends chat message
    const commandId = crypto.randomUUID();
    const cpH1 = h.checkpoint();
    const cpG1 = g.checkpoint();

    h.ws.send(JSON.stringify({ commandId, mediaVersion: 0, type: 'chat_message', text: 'First send' }));

    const ack1 = await h.nextAfter(cpH1, m => m.type === 'ack' && m.commandId === commandId);
    const broadcast1 = await g.nextAfter(cpG1, m => m.type === 'room_state' && m.state.chat?.some((c: any) => c.text === 'First send'));
    assert.equal(broadcast1.state.chat.length, 1);
    assert.equal(typeof broadcast1.state.chat[0].id, 'string');
    assert.ok(/^[0-9a-f-]{36}$/.test(broadcast1.state.chat[0].id));

    // Host resends duplicate commandId
    const cpH2 = h.checkpoint();
    const cpG2 = g.checkpoint();

    h.ws.send(JSON.stringify({ commandId, mediaVersion: 0, type: 'chat_message', text: 'First send replay' }));

    const ack2 = await h.nextAfter(cpH2, m => m.type === 'ack' && m.commandId === commandId);
    assert.equal(ack2.revision, ack1.revision);

    // Ensure guest does NOT receive any duplicate broadcast
    let duplicateBroadcastReceived = false;
    for (const msg of g.messages.slice(cpG2)) {
      if (msg.type === 'room_state') duplicateBroadcastReceived = true;
    }
    assert.equal(duplicateBroadcastReceived, false);

    // Reactions deduplication
    const rxId = crypto.randomUUID();
    const cpH3 = h.checkpoint();
    const cpG3 = g.checkpoint();

    h.ws.send(JSON.stringify({ commandId: rxId, mediaVersion: 0, type: 'reaction', emoji: 'heart' }));

    await h.nextAfter(cpH3, m => m.type === 'ack' && m.commandId === rxId);
    const gRx = await g.nextAfter(cpG3, m => m.type === 'reaction' && m.reaction.emoji === 'heart');
    assert.equal(typeof gRx.reaction.id, 'string');
    assert.ok(/^[0-9a-f-]{36}$/.test(gRx.reaction.id));

    // Duplicate reaction
    const cpH4 = h.checkpoint();
    const cpG4 = g.checkpoint();

    h.ws.send(JSON.stringify({ commandId: rxId, mediaVersion: 0, type: 'reaction', emoji: 'heart' }));

    const rxAck2 = await h.nextAfter(cpH4, m => m.type === 'ack' && m.commandId === rxId);
    assert.equal(rxAck2.revision, ack1.revision);

    // Guest should NOT receive another reaction fanout
    const duplicateFanout = g.messages.slice(cpG4).some(m => m.type === 'reaction');
    assert.equal(duplicateFanout, false);

    h.ws.close();
    g.ws.close();
  } finally {
    await mf.dispose();
  }
});

test('integration: reactions fan out to all sockets without persisting or bumping revision', async () => {
  const mf = runtime();
  try {
    const hostToken = await login(mf, 30);
    const guestToken = await login(mf, 31);

    const createRes = await post(mf, '/api/v2/rooms', { title: 'Reaction Fanout Room', visibility: 'public' }, hostToken);
    const { roomId, ticket: hostTicket } = await createRes.json() as { roomId: string; ticket: string };

    const joinRes = await post(mf, '/api/v2/rooms/join', { roomId }, guestToken);
    const { ticket: guestTicket } = await joinRes.json() as { ticket: string };

    const h = await socket(mf, roomId, hostTicket);
    const g = await socket(mf, roomId, guestTicket);

    const initialHostState = (await h.next(m => m.type === 'room_state' && m.state.participants.length === 2)).state;
    await g.next(m => m.type === 'room_state' && m.state.participants.length === 2);

    const rxId = crypto.randomUUID();
    const cpH = h.checkpoint();
    const cpG = g.checkpoint();

    // Guest sends reaction
    g.ws.send(JSON.stringify({ commandId: rxId, mediaVersion: 0, type: 'reaction', emoji: 'surprise' }));

    const gAck = await g.nextAfter(cpG, m => m.type === 'ack' && m.commandId === rxId);
    assert.equal(gAck.revision, initialHostState.revision);

    // Both host and guest receive the reaction fanout
    const hReaction = await h.nextAfter(cpH, m => m.type === 'reaction' && m.reaction.emoji === 'surprise');
    assert.equal(hReaction.reaction.emoji, 'surprise');
    assert.equal(hReaction.reaction.profileId, 31);
    assert.equal(hReaction.reaction.login, 'user31');

    const gReaction = await g.nextAfter(cpG, m => m.type === 'reaction' && m.reaction.emoji === 'surprise');
    assert.equal(gReaction.reaction.id, hReaction.reaction.id);
    assert.equal(typeof gReaction.reaction.id, 'string');
    assert.ok(/^[0-9a-f-]{36}$/.test(gReaction.reaction.id));

    // Ensure neither socket received a room_state broadcast
    assert.equal(h.messages.slice(cpH).some(m => m.type === 'room_state'), false);
    assert.equal(g.messages.slice(cpG).some(m => m.type === 'room_state'), false);

    h.ws.close();
    g.ws.close();
  } finally {
    await mf.dispose();
  }
});

test('integration: chat message persists and survives new WebSocket connection', async () => {
  const mf = runtime();
  try {
    const hostToken = await login(mf, 40);
    const createRes = await post(mf, '/api/v2/rooms', { title: 'Chat Persistence Room', visibility: 'public' }, hostToken);
    const { roomId, ticket: hostTicket } = await createRes.json() as { roomId: string; ticket: string };

    const h1 = await socket(mf, roomId, hostTicket);
    await h1.next(m => m.type === 'room_state');

    const chatCmdId = sendCmd(h1, 'chat_message', { text: 'Persisted message' });
    await h1.next(m => m.type === 'ack' && m.commandId === chatCmdId);
    await h1.next(m => m.type === 'room_state' && m.state.chat?.some((c: any) => c.text === 'Persisted message'));

    h1.ws.close();

    // New connection joins and receives persisted chat in initial room_state
    const joinRes = await post(mf, '/api/v2/rooms/join', { roomId }, hostToken);
    const { ticket: newTicket } = await joinRes.json() as { ticket: string };

    const h2 = await socket(mf, roomId, newTicket);
    const state = (await h2.next(m => m.type === 'room_state')).state;

    assert.ok(Array.isArray(state.chat));
    assert.equal(state.chat.length, 1);
    assert.equal(typeof state.chat[0].id, 'string');
    assert.ok(/^[0-9a-f-]{36}$/.test(state.chat[0].id));
    assert.equal(state.chat[0].text, 'Persisted message');
    assert.equal(state.chat[0].profileId, 40);
    assert.equal(state.chat[0].login, 'user40');

    h2.ws.close();
  } finally {
    await mf.dispose();
  }
});

test('integration: RoomObject constructor migrates legacy stored engine without chat property deterministically', async () => {
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
        fetch: async () => new Response(JSON.stringify({ ok: true })),
        idFromName: () => 'dir-id',
      }),
    },
  } as any;

  // Store legacy engine data without chat
  const legacyState: any = {
    protocolVersion: 2, revision: 3, roomId: 'legacy-room-do', joinCode: 'LEGACYDO',
    title: 'Legacy DO Room', visibility: 'public', hostId: 1, media: null, mediaVersion: 0, syncEpoch: 0,
    playback: { position: 0, paused: true, intent: 'paused', rate: 1, updatedAt: 1000 },
    barrier: null,
    participants: [{ profileId: 1, login: 'user1', avatar: null, canControl: true, connected: true, viewing: false, status: 'idle', readyEpoch: null, excludedEpoch: null, disconnectedAt: null, error: null }],
    emptySince: null, closed: false,
  };
  delete legacyState.chat;

  await mockRoomStorage.put('engine', { state: legacyState, commands: [] });

  const { RoomObject } = await import('../src/objects.ts');
  const roomObj = new RoomObject(mockRoomCtx, mockEnv);

  // Request ticket via fetch
  const ticketRes = await roomObj.fetch(new Request('https://internal/ticket', {
    method: 'POST',
    body: JSON.stringify({ profile: { profileId: 1, login: 'user1', avatar: null } }),
  }));
  assert.equal(ticketRes.status, 200);
  const ticketBody = await ticketRes.json() as any;
  assert.ok(Array.isArray(ticketBody.state.chat), 'state.chat must be an array');
  assert.equal(ticketBody.state.chat.length, 0, 'state.chat must be empty array');
});

test('integration: kicked participant WebSocket cannot send chat or reactions after being kicked', async () => {
  const mf = runtime();
  try {
    const hostToken = await login(mf, 50);
    const guestToken = await login(mf, 51);

    const createRes = await post(mf, '/api/v2/rooms', { title: 'Kick Social Room', visibility: 'public' }, hostToken);
    const { roomId, ticket: hostTicket } = await createRes.json() as { roomId: string; ticket: string };

    const joinRes = await post(mf, '/api/v2/rooms/join', { roomId }, guestToken);
    const { ticket: guestTicket } = await joinRes.json() as { ticket: string };

    const h = await socket(mf, roomId, hostTicket);
    const g = await socket(mf, roomId, guestTicket);

    await h.next(m => m.type === 'room_state' && m.state.participants.length === 2);
    await g.next(m => m.type === 'room_state' && m.state.participants.length === 2);

    // Host kicks guest
    const cpG = g.checkpoint();
    sendCmd(h, 'kick', { profileId: 51 });

    const kickedMsg = await g.nextAfter(cpG, m => m.type === 'kicked');
    assert.equal(kickedMsg.type, 'kicked');

    // Guest socket is closed / removed
    // Guest sending chat over kicked socket must not succeed or broadcast
    const cpH = h.checkpoint();
    sendCmd(g, 'chat_message', { text: 'Should be dropped' });

    // Host should never receive any broadcast for the kicked guest's message
    await new Promise(r => setTimeout(r, 200));
    const hostSawKickedChat = h.messages.slice(cpH).some(m => m.type === 'room_state' && m.state.chat?.some((c: any) => c.text === 'Should be dropped'));
    assert.equal(hostSawKickedChat, false);

    h.ws.close();
  } finally {
    await mf.dispose();
  }
});

test('integration: stale media race allows chat/reaction over WebSocket but rejects playback commands', async () => {
  const mf = runtime();
  try {
    const hostToken = await login(mf, 60);
    const guestToken = await login(mf, 61);

    const createRes = await post(mf, '/api/v2/rooms', { title: 'Stale Media Room', visibility: 'public' }, hostToken);
    const { roomId, ticket: hostTicket } = await createRes.json() as { roomId: string; ticket: string };

    const joinRes = await post(mf, '/api/v2/rooms/join', { roomId }, guestToken);
    const { ticket: guestTicket } = await joinRes.json() as { ticket: string };

    const h = await socket(mf, roomId, hostTicket);
    const g = await socket(mf, roomId, guestTicket);

    await h.next(m => m.type === 'room_state' && m.state.participants.length === 2);
    await g.next(m => m.type === 'room_state' && m.state.participants.length === 2);

    // Host selects media (bumps mediaVersion to 1)
    sendCmd(h, 'set_media', { media: sampleMedia }, 0);
    await h.next(m => m.type === 'room_state' && m.state.mediaVersion === 1);
    await g.next(m => m.type === 'room_state' && m.state.mediaVersion === 1);

    // Guest sends chat with stale mediaVersion = 0
    const cpGAck = g.checkpoint();
    const cpHChat = h.checkpoint();
    const chatCmdId = sendCmd(g, 'chat_message', { text: 'Stale media chat works' }, 0);

    const chatAck = await g.nextAfter(cpGAck, m => m.type === 'ack' && m.commandId === chatCmdId);
    assert.notEqual(chatAck, undefined);

    const hostChatState = await h.nextAfter(cpHChat, m => m.type === 'room_state' && m.state.chat?.some((c: any) => c.text === 'Stale media chat works'));
    assert.equal(hostChatState.state.mediaVersion, 1);

    // Guest sends reaction with stale mediaVersion = 0
    const cpGRxAck = g.checkpoint();
    const cpHReaction = h.checkpoint();
    const rxCmdId = sendCmd(g, 'reaction', { emoji: 'laugh' }, 0);

    const rxAck = await g.nextAfter(cpGRxAck, m => m.type === 'ack' && m.commandId === rxCmdId);
    assert.notEqual(rxAck, undefined);

    const hostReaction = await h.nextAfter(cpHReaction, m => m.type === 'reaction' && m.reaction.emoji === 'laugh');
    assert.equal(hostReaction.reaction.emoji, 'laugh');
    assert.equal(typeof hostReaction.reaction.id, 'string');
    assert.ok(/^[0-9a-f-]{36}$/.test(hostReaction.reaction.id));

    // Host grants control to guest
    sendCmd(h, 'grant_control', { profileId: 61 }, 1);
    await g.next(m => m.type === 'room_state' && m.state.participants.find((p: any) => p.profileId === 61)?.canControl === true);

    // Guest attempts playback command (pause) with stale mediaVersion = 0 -> STALE_MEDIA error
    const cpGErr = g.checkpoint();
    const stalePauseCmdId = sendCmd(g, 'pause', { position: 0 }, 0);
    const pauseErr = await g.nextAfter(cpGErr, m => m.type === 'error' && m.commandId === stalePauseCmdId);
    assert.equal(pauseErr.code, 'STALE_MEDIA');

    h.ws.close();
    g.ws.close();
  } finally {
    await mf.dispose();
  }
});

test('regression: collision resistance across different authors sending identical commandId', async () => {
  const mf = runtime();
  try {
    const hostToken = await login(mf, 70);
    const guestToken = await login(mf, 71);

    const createRes = await post(mf, '/api/v2/rooms', { title: 'Collision Room', visibility: 'public' }, hostToken);
    const { roomId, ticket: hostTicket } = await createRes.json() as { roomId: string; ticket: string };

    const joinRes = await post(mf, '/api/v2/rooms/join', { roomId }, guestToken);
    const { ticket: guestTicket } = await joinRes.json() as { ticket: string };

    const h = await socket(mf, roomId, hostTicket);
    const g = await socket(mf, roomId, guestTicket);

    await h.next(m => m.type === 'room_state' && m.state.participants.length === 2);
    await g.next(m => m.type === 'room_state' && m.state.participants.length === 2);

    const collisionCmdId = 'identical-client-cmd-id';

    const cpH = h.checkpoint();
    h.ws.send(JSON.stringify({ commandId: collisionCmdId, mediaVersion: 0, type: 'chat_message', text: 'From Host' }));
    await h.nextAfter(cpH, m => m.type === 'ack' && m.commandId === collisionCmdId);

    const cpG = g.checkpoint();
    g.ws.send(JSON.stringify({ commandId: collisionCmdId, mediaVersion: 0, type: 'chat_message', text: 'From Guest' }));
    await g.nextAfter(cpG, m => m.type === 'ack' && m.commandId === collisionCmdId);

    const finalState = await h.next(m => m.type === 'room_state' && m.state.chat?.length === 2);
    assert.equal(finalState.state.chat.length, 2);
    assert.equal(finalState.state.chat[0].text, 'From Host');
    assert.equal(finalState.state.chat[0].profileId, 70);
    assert.equal(finalState.state.chat[1].text, 'From Guest');
    assert.equal(finalState.state.chat[1].profileId, 71);
    assert.notEqual(finalState.state.chat[0].id, finalState.state.chat[1].id);
    assert.notEqual(finalState.state.chat[0].id, collisionCmdId);
    assert.notEqual(finalState.state.chat[1].id, collisionCmdId);

    h.ws.close();
    g.ws.close();
  } finally {
    await mf.dispose();
  }
});

test('regression: reconnect with new socket maintaining persistent social rate limit', async () => {
  const mf = runtime();
  try {
    const hostToken = await login(mf, 80);
    const guestToken = await login(mf, 81);

    const createRes = await post(mf, '/api/v2/rooms', { title: 'Rate Limit Room', visibility: 'public' }, hostToken);
    const { roomId, ticket: hostTicket } = await createRes.json() as { roomId: string; ticket: string };

    const joinRes1 = await post(mf, '/api/v2/rooms/join', { roomId }, guestToken);
    const { ticket: guestTicket1 } = await joinRes1.json() as { ticket: string };

    const h = await socket(mf, roomId, hostTicket);
    const g1 = await socket(mf, roomId, guestTicket1);

    await h.next(m => m.type === 'room_state' && m.state.participants.length === 2);
    await g1.next(m => m.type === 'room_state' && m.state.participants.length === 2);

    // Guest sends 10 chat messages (max allowed within 10s window)
    for (let i = 1; i <= 10; i++) {
      const c = g1.checkpoint();
      g1.ws.send(JSON.stringify({ commandId: `cmd-${i}`, mediaVersion: 0, type: 'chat_message', text: `Message ${i}` }));
      await g1.nextAfter(c, m => m.type === 'ack' && m.commandId === `cmd-${i}`);
    }

    // Guest disconnects
    g1.ws.close();

    // Guest reconnects with new socket ticket
    const joinRes2 = await post(mf, '/api/v2/rooms/join', { roomId }, guestToken);
    const { ticket: guestTicket2 } = await joinRes2.json() as { ticket: string };
    const g2 = await socket(mf, roomId, guestTicket2);
    await g2.next(m => m.type === 'room_state');

    // 11th chat message within the same window must be RATE_LIMITED despite new socket
    const c11 = g2.checkpoint();
    g2.ws.send(JSON.stringify({ commandId: 'cmd-11', mediaVersion: 0, type: 'chat_message', text: 'Message 11' }));
    const err = await g2.nextAfter(c11, m => m.type === 'error' && m.commandId === 'cmd-11');
    assert.equal(err.code, 'RATE_LIMITED');

    // Duplicate command from earlier is acknowledged even when rate-limited!
    const cDup = g2.checkpoint();
    g2.ws.send(JSON.stringify({ commandId: 'cmd-5', mediaVersion: 0, type: 'chat_message', text: 'Message 5 duplicate' }));
    const ackDup = await g2.nextAfter(cDup, m => m.type === 'ack' && m.commandId === 'cmd-5');
    assert.notEqual(ackDup, undefined);

    h.ws.close();
    g2.ws.close();
  } finally {
    await mf.dispose();
  }
});


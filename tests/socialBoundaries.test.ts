import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomEngine, type EngineData } from '../src/domain.ts';
import { RoomObject } from '../src/objects.ts';
import type { ServerMessage } from '../protocol/index.ts';

function engine() {
    const now = Date.now();
    const host = { profileId: 1, login: 'Host', avatar: null };
    const room = RoomEngine.create({ roomId: 'boundary-room', joinCode: '12345678', title: 'Boundaries', visibility: 'public', host }, now);
    room.connect(host, now);
    room.connect({ profileId: 2, login: 'Guest', avatar: null }, now);
    return room;
}
test('social server IDs cannot collide when different authors choose the same command ID', () => {
    const room = engine();
    for (const profileId of [1, 2]) {
        room.command(profileId, { type: 'chat_message', text: `Author ${profileId}`, commandId: 'shared-command-id', mediaVersion: 0 }, Date.now());
    }
    const [first, second] = room.snapshot().chat;
    assert.notEqual(first.id, second.id);
    const a = room.command(1, { type: 'reaction', emoji: 'heart', commandId: 'shared-reaction-id', mediaVersion: 0 }, Date.now());
    const b = room.command(2, { type: 'reaction', emoji: 'heart', commandId: 'shared-reaction-id', mediaVersion: 0 }, Date.now());
    assert.ok(a.reaction && b.reaction);
    assert.notEqual(a.reaction.id, b.reaction.id);
});

function socket(connectionId: string) {
    let attachment = { profileId: 1, connectionId, window: Date.now(), messages: 0, lastSeen: Date.now() };
    const received: ServerMessage[] = [];
    const ws = {
        deserializeAttachment: () => structuredClone(attachment),
        serializeAttachment: (value: typeof attachment) => { attachment = structuredClone(value); },
        send: (raw: string) => { received.push(JSON.parse(raw) as ServerMessage); },
        close: () => {},
    } as unknown as WebSocket;
    return { ws, received };
}
async function adapter() {
    const roomStorage = new Map<string, unknown>([['engine', engine().exportData()]]);
    let active = socket('original');
    let initialized = Promise.resolve();
    const ctx = {
        storage: {
            get: async (key: string) => structuredClone(roomStorage.get(key)),
            put: async (keyOrValues: string | Record<string, unknown>, value?: unknown) => {
                for (const [key, item] of typeof keyOrValues === 'string' ? [[keyOrValues, value]] : Object.entries(keyOrValues)) {
                    roomStorage.set(key as string, structuredClone(item));
                }
            },
            delete: async (key: string) => roomStorage.delete(key),
            list: async (options?: { prefix?: string; limit?: number }) => new Map([...roomStorage]
                .filter(([key]) => !options?.prefix || key.startsWith(options.prefix)).slice(0, options?.limit)),
            setAlarm: async () => {}, deleteAlarm: async () => {},
        },
        blockConcurrencyWhile: (callback: () => Promise<void>) => { initialized = callback(); return initialized; },
        getWebSockets: () => [active.ws],
    } as unknown as ConstructorParameters<typeof RoomObject>[0];
    const env = {
        DIRECTORY: { idFromName: () => 'directory', get: () => ({ fetch: async () => Response.json({ ok: true }) }) },
    } as unknown as ConstructorParameters<typeof RoomObject>[1];
    let object = new RoomObject(ctx, env);
    await initialized;
    return {
        storage: roomStorage,
        received: () => active.received,
        async send(commandId: string, type: 'chat_message' | 'reaction' = 'chat_message') {
            active.received.length = 0;
            const payload = type === 'reaction' ? { emoji: 'heart' } : { text: `Message ${commandId}` };
            await object.webSocketMessage(active.ws, JSON.stringify({ type, commandId, mediaVersion: 0, ...payload }));
        },
        reconnect() { active = socket('replacement'); },
        async recreate() { object = new RoomObject(ctx, env); await initialized; },
    };
}
test('reaction duplicate ledger is durable before acknowledgement and survives object recreation', async () => {
    const fixture = await adapter();
    await fixture.send('durable-reaction', 'reaction');
    assert.ok(fixture.received().some(message => message.type === 'ack'));
    const persisted = fixture.storage.get('engine') as EngineData;
    assert.ok(persisted.commands.some(command => command.key === '1:durable-reaction'));
    await fixture.recreate();
    await fixture.send('durable-reaction', 'reaction');
    assert.ok(fixture.received().some(message => message.type === 'ack'));
    assert.ok(!fixture.received().some(message => message.type === 'reaction'));
});
async function reachChatLimit(fixture: Awaited<ReturnType<typeof adapter>>) {
    for (let index = 0; index < 30; index++) {
        await fixture.send(`limited-${index}`);
        if (fixture.received().some(message => message.type === 'error' && message.code === 'RATE_LIMITED')) return;
    }
    assert.fail('Expected a bounded chat rate limit');
}
test('accepted duplicate commands are acknowledged even after the social rate limit is exhausted', async () => {
    const fixture = await adapter(); await reachChatLimit(fixture);
    await fixture.send('limited-0');
    assert.ok(fixture.received().some(message => message.type === 'ack'));
    assert.ok(!fixture.received().some(message => message.type === 'error'));
});
test('per-profile chat limit survives replacing the socket and recreating the durable object', async () => {
    const fixture = await adapter(); await reachChatLimit(fixture);
    const count = (fixture.storage.get('engine') as EngineData).state.chat.length;
    fixture.reconnect(); await fixture.recreate();
    await fixture.send('reconnected-new-message');
    assert.ok(fixture.received().some(message => message.type === 'error' && message.code === 'RATE_LIMITED'));
    assert.equal((fixture.storage.get('engine') as EngineData).state.chat.length, count);
});
